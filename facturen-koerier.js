'use strict';
/*
 * facturen-koerier.js — de koerier van de Facturen-app (wv855, fase F4, 23-10-2026). Bouwplan: vault "01_Ontwikkeling/Facturen-app -
 * bouwplan (App, 22-10-2026).md" § 4.1, § 4.4, § 4.5 en § 7 F4; contracten in mk-scripts/facturen/overdracht-2210/contracten/
 * (koerier-api.md, bronnen.md, verzender.md); ontwerp + Fable-review vooraf: mk-scripts/facturen/fasen/F4-ontwerp.md.
 *
 * WAAROM. Facturen moeten vanzelf binnenkomen (één verzamelpostvak) en na Davids klik (Bevestigen in de App) vanzelf naar de boekhouder.
 * De koerier doet het werk tussen de App-kant en de buitenwereld: postvak lezen via het bestaande lees-luik, pdftotext (vluchtig), en de
 * bevestigde opdrachten via de n8n-verzender als Gmail-concept (modus concept, tot Davids Ja na de schaduwweek in F5).
 *
 * VORM. Eén ronde per n8n-tik (POST /facturen-ronde). Geen netwerk- of bestandsmodule: lees-luik en verzender komen als functies uit
 * server.js (io.luik, io.luikBytes, io.verzender); de stukken leest facturen-db.js. De enige procesaanroep is pdftotext met een vast pad,
 * PDF op stdin en tekst op stdout: de tekst blijft in het geheugen, gaat naar het besliskader en valt weg (nooit naar schijf, db of log).
 * CI-poort (.github/workflows/build.yml): alleen crypto, child_process (execFile van /usr/bin/pdftotext) en de Facturen-buren.
 * SCHADUW PDF-lezer (wv1431): na de transactie van een bericht of upload geeft de koerier de stukken (bytes, vluchtige tekst) en de uitkomst
 * van de kern door aan io.pdfSchaduw (server.js → pdf-lezer.js, K1: via io, zoals pdftotext). Die bepaalt zelf of het bericht naar Claude
 * mag (patiëntregel fail-closed) en logt alleen velden en verschilvlaggen. Niets in de app verandert; een fout daar raakt de ronde niet.
 *
 * NIET ONDERHANDELBAAR. Niets gaat naar buiten zonder dat een mens Bevestigen klikte (alleen opdrachten uit de wachtrij, na verstuur_na).
 * Vóór elke verzending de consistentiecontrole (bytes opnieuw → sha256, bijlagen en vingerafdruk opnieuw uit de verse rijen, niet prive,
 * doeladres uit de entiteitentabel); wijkt iets af → geweigerd + signaal, geen nieuwe poging. Privé kan niet: de database weigert al een
 * opdracht voor prive, de koerier weigert hem nog eens. De tweede grens ligt buiten de pod (witte lijst + plafond in de verzender).
 *
 * IDEMPOTENTIE (Gmail kent geen sleutel; Fable F4 MOET 1+2). Het token (FV + factuur-id, FA + afschrift-id) staat in het onderwerp. Vóór
 * de aanroep een reservering (gecommit). Heeft deze factuur of dit afschrift ooit een reservering gehad, dan eerst zoeken (Concepten +
 * Verzonden) op het token; een treffer aan hetzelfde doeladres wordt overgenomen, er komt geen tweede. Een zoekfout is nooit "niet
 * gevonden": dan wordt er deze ronde niets verstuurd. Een time-out van de verzender is "geen resultaat": de opdracht blijft opgehaald en
 * komt na 30 min terug (dan eerst zoeken). Vóór het claimen loopt de voorronde de opgehaalde opdrachten met een reservering na, zodat
 * ook de derde poging niet stil als mislukt eindigt terwijl het concept er staat.
 */
const crypto = require('crypto');
const { execFile } = require('child_process');
const K = require('./facturen-kern.js');
const D = require('./facturen-db.js');
const F = require('./facturen.js');

const PDFTOTEXT = '/usr/bin/pdftotext';
const GRENS = {
  verzendingen: 8,          // claims per ronde (60–85 facturen per maand; de tik loopt elk uur)
  rondeMs: 150000,          // na 2,5 min geen nieuwe verzending meer (de n8n-knoop wacht 6 min)
  perUur: 30,               // pod-plafond (naast het plafond in de verzender): reserveringen in het laatste uur
  detectie: 40,             // tokens per ronde in de verzend-detectie (10 per zoekopdracht)
  tokensPerZoek: 10,
  teLezen: 20,              // handmatige uploads per ronde
  berichten: 60,            // nieuwe mails per ronde (de rest de volgende ronde)
  bronDagen: 14,            // het postvak kijkt zo ver terug (eerste ronde) en altijd 2 dagen vóór de laatste geslaagde ronde
  bijlageBytes: 20 * 1024 * 1024,
  tekst: 200000,
};
const OPGEHAALD_MS = K.OPGEHAALD_TIMEOUT_MS;
const TOKEN_RE = /\[ref (F[VA][0-9a-f]{16})\]/;

function nuIso(nu) { return new Date(nu).toISOString(); }
function dagAmsterdam(nu) { return new Date(nu).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function kort(s, n) { return s == null ? null : String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function json(v, standaard) { if (typeof v !== 'string') return v == null ? standaard : v; try { return JSON.parse(v); } catch (e) { return standaard; } }
// Een fout van buiten noemt nooit inhoud: alleen een soort (code, http-status).
function foutSoort(e) { return kort((e && (e.code || e.name)) || 'fout', 40); }

// ───────────────────────────── pdftotext (vluchtig) ─────────────────────────────

/*
 * PDF-bytes → tekst in het geheugen. Vast pad, geen shell, PDF op stdin, tekst op stdout, lege omgeving, time-out 20 s, uitvoer ≤ 4 MB.
 * stderr wordt niet gelezen (daar kan een stukje van het document in staan). → { ok, tekst, tekstlaag } | { ok:false, fout }
 */
function pdfNaarTekst(bytes, o) {
  o = o || {};
  return new Promise(function (klaar) {
    let kind;
    try {
      kind = execFile(o.pad || PDFTOTEXT, ['-q', '-layout', '-enc', 'UTF-8', '-', '-'],
        { timeout: o.timeoutMs || 20000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: {}, windowsHide: true },
        function (err, stdout) {
          if (err) return klaar({ ok: false, fout: err.killed ? 'tijd' : err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'te_lang' : 'pdftotext' });
          const tekst = String(stdout || '').slice(0, GRENS.tekst);
          klaar({ ok: true, tekst, tekstlaag: /\S/.test(tekst) });
        });
    } catch (e) { return klaar({ ok: false, fout: 'pdftotext' }); }
    kind.stdin.on('error', function () {});
    kind.stdin.end(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  });
}

// ───────────────────────────── kleine pure hulpjes (getoetst) ─────────────────────────────

function tokenVan(op) { return op.factuur ? 'FV' + op.factuur : 'FA' + op.afschrift; }
// Oorspronkelijke afzender van een doorgestuurde mail: het eerste "Van:"/"From:" na een doorstuurkop (bronnen.md). Lukt dat niet: null.
const DOORSTUUR_KOP = /-{2,}\s*(?:forwarded message|doorgestuurd bericht|oorspronkelijk bericht|original message)\s*-{2,}|begin (?:forwarded message|doorgestuurd bericht)\s*:/i;
function oorspronkelijkeAfzender(tekst) {
  const t = String(tekst || '');
  const i = t.search(DOORSTUUR_KOP);
  if (i < 0) return null;
  const m = /^[ \t>*]*(?:Van|From)[ \t]*:[ \t*]*([^\n]{1,300})$/im.exec(t.slice(i, i + 4000));
  if (!m) return null;
  const a = /([A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24})/.exec(m[1]);
  return a ? a[1].toLowerCase() : null;
}
function isDoorgestuurd(m, eigen) {
  const van = String(m.van || '').toLowerCase();
  return /^\s*(?:fwd?|fw|doorst(?:uurd)?)\s*:/i.test(String(m.onderwerp || '')) || (eigen || []).some((x) => van.indexOf(x) >= 0);
}
function adresIn(veld, adres) { return String(veld || '').toLowerCase().indexOf(String(adres || '').toLowerCase()) >= 0; }
function gmailDag(ymd) { return String(ymd).replace(/-/g, '/'); }
function plusDagen(ymd, n) { return K.plusDagen(ymd, n); }

// De verzender neemt alleen PDF, UBL-XML en (bij een afschrift) MT940 aan. De extensie volgt uit de inhoud, niet uit de naam; iets anders
// (een foto, een kantoorbestand) is niet verzendbaar → null, dan weigert de controle (diffreview wv855 #2 en natoets).
function naamMetExtensie(naam, mime, bytes, soort) {
  const stam = String(naam || 'stuk').replace(/[\\/]/g, '_').replace(/\.(pdf|xml|940|sta|mt940)$/i, '').slice(0, 110) || 'stuk';
  const b = bytes || Buffer.alloc(0);
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return stam + '.pdf';
  if (/^\s*(?:\ufeff)?<(?:\?xml|(?:\w+:)?(?:Invoice|CreditNote)\b)/.test(b.subarray(0, 300).toString('utf8'))) return stam + '.xml';
  if (soort === 'boekhouder_afschrift' && /^\s*:20:/.test(b.subarray(0, 50).toString('latin1'))) return stam + '.940';
  return null;
}
// Onderwerp en tekst van de mail aan de boekhouder: kort, zonder factuurtekst, met het token.
function mailVoor(fdb, op) {
  const e = fdb.db.prepare('SELECT naam, naam_kort FROM entiteit WHERE sleutel = ?').get(op.entiteit) || {};
  const ent = kort(e.naam_kort || e.naam || op.entiteit, 60);
  const tok = tokenVan(op);
  if (op.factuur) {
    const f = fdb.db.prepare('SELECT f.nummer, f.leverancier_naam, l.naam AS lev FROM factuur f LEFT JOIN leverancier l ON l.id = f.leverancier WHERE f.id = ?').get(op.factuur) || {};
    const wat = [kort(f.lev || f.leverancier_naam, 80), kort(f.nummer, 40)].filter(Boolean).join(' ');
    return { onderwerp: kort('Inkoopfactuur ' + ent + (wat ? ' — ' + wat : ''), 180) + ' [ref ' + tok + ']',
      tekst: 'Kenmerk ' + tok + ', opdracht ' + op.id + '.\n\nInkoopfactuur voor ' + kort(e.naam || ent, 120) + '.\nKlaargezet door Socev (assistent van David Schaap) na zijn akkoord.\n' };
  }
  const a = fdb.db.prepare('SELECT periode FROM pot_afschrift WHERE id = ?').get(op.afschrift) || {};
  return { onderwerp: 'Bankafschrift ' + ent + ' ' + kort(a.periode, 10) + ' [ref ' + tok + ']',
    tekst: 'Kenmerk ' + tok + ', opdracht ' + op.id + '.\n\nBankafschrift ' + kort(e.naam || ent, 120) + ' over ' + kort(a.periode, 10) + ' (MT940 en PDF).\nKlaargezet door Socev (assistent van David Schaap) na zijn akkoord.\n' };
}

// ───────────────────────────── consistentiecontrole ─────────────────────────────

/*
 * Vóór elke verzending, met eigen code (niet de claimcontrole van facturen-db.js): doeladres opnieuw uit de entiteitentabel, entiteit
 * niet prive, bijlagen opnieuw opgebouwd uit de verse factuur (of het verse afschrift), elk stuk opnieuw van schijf en opnieuw gehasht,
 * vingerafdruk opnieuw uitgerekend uit de verse rijen = de vingerafdruk van het akkoord. Het is geen vertrouwensgrens (zelfde proces,
 * zelfde database); het vangt een wijziging ná het akkoord en een beschadigd bestand. → { ok, bijlagen: [{naam, mime, bytes}], vingerafdruk }
 * of { ok:false, reden } (zonder inhoud).
 */
function controleer(fdb, op) {
  if (op.entiteit === 'prive') return { ok: false, reden: 'opdracht voor privé' };
  const e = fdb.db.prepare('SELECT sleutel, boekhoud_doel, afschrift_doel FROM entiteit WHERE sleutel = ?').get(op.entiteit);
  if (!e || e.sleutel === 'prive') return { ok: false, reden: 'entiteit onbekend of privé' };
  const doel = op.soort === 'boekhouder_factuur' ? e.boekhoud_doel : e.afschrift_doel;
  if (!doel || doel !== op.doeladres) return { ok: false, reden: 'doeladres wijkt af van de entiteitentabel' };
  let regel, verse;
  if (op.soort === 'boekhouder_factuur') {
    const f = D.factuurVoorKern(fdb, op.factuur);
    if (!f) return { ok: false, reden: 'factuur ontbreekt' };
    if (f.entiteit === 'prive' || f.entiteit !== op.entiteit) return { ok: false, reden: 'entiteit van de factuur wijkt af' };
    if (f.status !== 'wordt_verstuurd') return { ok: false, reden: 'factuur staat niet onderweg (' + f.status + ')' };
    verse = F.bijlagenVan(fdb, f);
    regel = { factuur_id: f.id, entiteit: f.entiteit, bedrag_centen: f.incl, doeladres: doel };
  } else {
    const a = fdb.db.prepare('SELECT a.*, r.entiteit FROM pot_afschrift a JOIN rekening r ON r.id = a.rekening WHERE a.id = ?').get(op.afschrift);
    if (!a) return { ok: false, reden: 'afschrift ontbreekt' };
    if (a.entiteit === 'prive' || a.entiteit !== op.entiteit) return { ok: false, reden: 'entiteit van het afschrift wijkt af' };
    if (a.status !== 'in_wachtrij') return { ok: false, reden: 'afschrift staat niet in de wachtrij (' + a.status + ')' };
    verse = [a.mt940_document, a.pdf_document].map((id) => fdb.db.prepare('SELECT naam, mime, sha256 FROM document WHERE id = ?').get(id)).filter(Boolean)
      .map((x) => ({ naam: x.naam, mime: x.mime, sha256: x.sha256 }));
    regel = { afschrift_id: a.id, entiteit: a.entiteit, periode: a.periode, doeladres: doel };
  }
  const opgeslagen = (json(op.bijlagen, []) || []).map((b) => (typeof b === 'string' ? b : b && b.sha256));
  if (verse.length !== opgeslagen.length || verse.some((b, i) => b.sha256 !== opgeslagen[i])) return { ok: false, reden: 'bijlagen wijken af van de verse rijen' };
  let vingerafdruk;
  try { vingerafdruk = K.vingerafdruk({ id: op.id, soort: op.soort, doeladres: doel, regel, bijlagen: verse }); }
  catch (e2) { return { ok: false, reden: 'vingerafdruk niet op te bouwen (' + foutSoort(e2) + ')' }; }
  if (vingerafdruk !== op.vingerafdruk) return { ok: false, reden: 'vingerafdruk wijkt af van het akkoord' };
  const bijlagen = [];
  for (const b of verse) {
    let bytes;
    try { bytes = D.stukLees(fdb, b.sha256); } catch (e3) { return { ok: false, reden: 'stuk ontbreekt of is beschadigd' }; }
    if (sha256(bytes) !== b.sha256) return { ok: false, reden: 'stuk komt niet overeen met zijn sha256' };
    const naam = naamMetExtensie(b.naam, b.mime, bytes, op.soort);
    if (!naam) return { ok: false, reden: 'bijlagetype niet verzendbaar (alleen PDF, UBL of MT940)' };
    bijlagen.push({ naam, mime: b.mime || 'application/octet-stream', bytes });
  }
  return { ok: true, bijlagen, vingerafdruk };
}

// ───────────────────────────── lees-luik: zoeken op het token ─────────────────────────────

class LuikFout extends Error { constructor(soort) { super('lees-luik: ' + soort); this.code = 'luik_' + soort; } }
// mail_zoeken; geen lijst terug = fout (nooit "niets gevonden").
async function zoek(io, query) {
  let j;
  try { j = await io.luik({ actie: 'mail_zoeken', query, max: 25 }); } catch (e) { throw new LuikFout(foutSoort(e)); }
  if (!j || !Array.isArray(j.mails)) throw new LuikFout('geen_lijst');
  // het echte lees-luik meldt een Gmail-fout als 200 met { mails: [], melding: 'fout bij zoeken: …' } of 'deels mislukt: …' (diffreview
  // wv855 #1, gemeten in AI - Agenda-Wachter API › Formatteer mails): dat is nooit "niets gevonden"
  if (j.melding) throw new LuikFout(/^deels/.test(String(j.melding)) ? 'deels_mislukt' : 'zoekfout');
  if (Number.isInteger(j.aantal) && j.aantal !== j.mails.length) throw new LuikFout('onvolledig');
  return j.mails.filter((m) => m && typeof m.id === 'string');
}
/*
 * Staat er al een mail met dit token (concept of verzonden)? → null (geen), of { id, verzonden, passend, opdracht }. passend = de mail gaat
 * naar dit doeladres én noemt (in de eerste regel, dus in de snippet) een opdracht van deze factuur of dit afschrift met dezelfde bijlagen
 * en hetzelfde adres; alleen dan neemt de koerier hem over. Een treffer die niet past (oud concept met andere stukken of een ander adres):
 * niet overnemen en ook niet opnieuw maken (diffreview wv855 #4). Een zoekfout gooit LuikFout.
 */
const OPDRACHT_RE = /opdracht ([0-9a-f]{16})/;
async function zoekToken(fdb, io, op) {
  const tok = tokenVan(op);
  const mails = await zoek(io, 'subject:' + tok + ' {in:draft in:sent}');
  const raak = mails.filter((m) => { const t = TOKEN_RE.exec(String(m.onderwerp || '')); return t && t[1] === tok; });
  if (!raak.length) return null;
  const past = (m) => {
    if (!adresIn(m.aan, op.doeladres)) return false;
    const x = OPDRACHT_RE.exec(String(m.snippet || ''));
    if (!x) return false;
    const ander = fdb.db.prepare('SELECT * FROM opdracht WHERE id = ?').get(x[1]);
    return !!ander && ander.soort === op.soort && (ander.factuur || null) === (op.factuur || null) && (ander.afschrift || null) === (op.afschrift || null) &&
      ander.doeladres === op.doeladres && JSON.stringify((json(ander.bijlagen, []) || []).map((b) => b.sha256)) === JSON.stringify((json(op.bijlagen, []) || []).map((b) => b.sha256));
  };
  const sent = (m) => (m.labels || []).includes('SENT') && !(m.labels || []).includes('DRAFT');
  const goed = raak.filter(past);
  if (!goed.length) return { id: raak[0].id, verzonden: raak.some(sent), passend: false };
  const m = goed.find(sent) || goed[0];
  return { id: m.id, verzonden: sent(m), passend: true };
}

// ───────────────────────────── de ronde ─────────────────────────────

/*
 * Eén ronde. io = { luik(body) → json, luikBytes(body) → { bytes } | { json }, verzender(v) → { status, j }, pdftotext?(bytes) },
 * o = { nu (ms, start), klok?() → ms, wie? }. Alleen aanroepen op de primaire kant (server.js: rolPoort + facturenOpen).
 * → { ok, fouten: [{wat, soort}], backup?, voorronde, detectie, verzending, upload, postvak }
 */
async function ronde(fdb, io, o) {
  o = o || {};
  const start = Number.isFinite(o.nu) ? o.nu : Date.now();
  const klok = typeof o.klok === 'function' ? o.klok : () => Date.now();
  const wie = o.wie || 'koerier';
  const pdf = typeof io.pdftotext === 'function' ? io.pdftotext : pdfNaarTekst;
  const uit = { ok: true, fouten: [], voorronde: { gezocht: 0, overgenomen: 0 }, detectie: { gezocht: 0, verstuurd: 0 },
    verzending: { geclaimd: 0, gelukt: 0, overgenomen: 0, mislukt: 0, geweigerd: 0, geen_resultaat: 0, definitief: 0 } };
  let luikOk = true;
  const fout = (wat, e) => { uit.ok = false; uit.fouten.push({ wat, soort: foutSoort(e) }); };

  // 0. back-up (eerste ronde na 02:00 op een dag zonder back-up)
  if (F.backupNodig(fdb, start)) {
    const b = F.ronde(fdb, { nu: start }); uit.backup = b.backup;
    if (!b.backup || !b.backup.ok) fout('backup', { code: 'backup' });
    if (b.herbeoordeling) { uit.herbeoordeling = b.herbeoordeling; if (!b.herbeoordeling.ok) fout('herbeoordeling', { code: 'herbeoordeling' }); }   // wv1317
  }

  // 1. voorronde: opgehaald > 30 min mét reservering → eerst zoeken (anders maakt de claim hem bij poging 3 stil "mislukt" terwijl het
  //    concept er staat, of verstuurt hij opnieuw; Fable F4 MOET 2)
  for (const op of fdb.db.prepare("SELECT * FROM opdracht WHERE status = 'opgehaald' AND verzend_reservering IS NOT NULL AND opgehaald_op <= ? ORDER BY opgehaald_op LIMIT 20")
    .all(nuIso(start - OPGEHAALD_MS))) {
    if (klok() - start > GRENS.rondeMs) break;
    try {
      uit.voorronde.gezocht++;
      const t = await zoekToken(fdb, io, op);
      if (t && t.passend) {
        D.opdrachtResultaat(fdb, op.id, { status: 'gelukt', extern_id: t.id, modus: op.modus || 'concept', overgenomen: true }, { nu: klok(), wie });
        uit.voorronde.overgenomen++;
      }
    } catch (e) { if (e instanceof LuikFout) { luikOk = false; fout('lees-luik', e); break; } fout('voorronde', e); }
  }

  // 2. verzend-detectie (modus concept): oudste eerst (bijgewerkt_op draait mee), 10 tokens per zoekopdracht
  if (luikOk) {
    const wacht = fdb.db.prepare("SELECT o.* FROM opdracht o LEFT JOIN factuur f ON f.id = o.factuur LEFT JOIN pot_afschrift a ON a.id = o.afschrift " +
      "WHERE o.status = 'gelukt' AND o.modus = 'concept' AND (f.status = 'concept_klaar' OR a.status = 'in_wachtrij') ORDER BY o.bijgewerkt_op, o.id LIMIT ?").all(GRENS.detectie);
    for (let i = 0; i < wacht.length; i += GRENS.tokensPerZoek) {
      const deel = wacht.slice(i, i + GRENS.tokensPerZoek);
      const perTok = new Map(deel.map((op) => [tokenVan(op), op]));
      let mails;
      try { mails = await zoek(io, 'in:sent subject:(' + [...perTok.keys()].join(' OR ') + ')'); uit.detectie.gezocht += deel.length; }
      catch (e) { luikOk = false; fout('lees-luik', e); break; }
      for (const m of mails) {
        const t = TOKEN_RE.exec(String(m.onderwerp || ''));
        const op = t && perTok.get(t[1]);
        if (!op || !(m.labels || []).includes('SENT') || (m.labels || []).includes('DRAFT') || !adresIn(m.aan, op.doeladres)) continue;
        try { if (D.verzondenGezien(fdb, op.id, { nu: klok(), wie, message_id: m.id }).gewijzigd) uit.detectie.verstuurd++; } catch (e) { fout('detectie', e); }
        perTok.delete(t[1]);
      }
      const tijd = nuIso(klok());
      for (const op of perTok.values()) fdb.db.prepare('UPDATE opdracht SET bijgewerkt_op = ? WHERE id = ? AND status = \'gelukt\'').run(tijd, op.id);   // rotatie
    }
  }

  // 3. claimen en verzenden — niet als het lees-luik stuk is (dan kan de koerier niet eerst zoeken) of het pod-plafond bereikt is
  const laatsteUur = Number(fdb.db.prepare('SELECT count(*) AS n FROM opdracht WHERE verzend_reservering_op >= ?').get(nuIso(start - 3600000)).n);
  if (!luikOk) uit.verzending.niet_gestart = 'lees-luik';
  else if (laatsteUur >= GRENS.perUur) { uit.verzending.plafond = true; }
  else {
    // één voor één claimen zolang het rondebudget het toelaat: wat geclaimd is, wordt ook geprobeerd (diffreview wv855 #7)
    const modus = D.metaLees(fdb, 'verzendmodus') === 'versturen' ? 'versturen' : 'concept';
    const max = Math.min(GRENS.verzendingen, GRENS.perUur - laatsteUur);
    while (uit.verzending.geclaimd < max && luikOk && klok() - start <= GRENS.rondeMs) {
      let claim;
      try { claim = D.claimOpdrachten(fdb, start, { wie, max: 1 }); }
      catch (e) { fout('claim', e); break; }
      uit.verzending.definitief += claim.definitief.length;
      uit.verzending.geweigerd += claim.geweigerd.length;
      if (claim.fouten.length) fout('claim', { code: 'rij' });
      if (!claim.opdrachten.length) break;
      uit.verzending.geclaimd++;
      const op = fdb.db.prepare('SELECT * FROM opdracht WHERE id = ?').get(claim.opdrachten[0].id);
      try { await verstuurEen(fdb, io, op, modus, { klok, wie }, uit); }
      catch (e) {
        if (e instanceof LuikFout) { luikOk = false; fout('lees-luik', e); }
        else { fout('verzending', e); if (e && e.stopVerzenden) break; }
      }
    }
    if (klok() - start > GRENS.rondeMs) uit.verzending.budget_op = true;
  }

  // 4. handmatige PDF-uploads (te_lezen): Davids eigen handeling, dus ook als het postvak uit staat
  try { uit.upload = await leesUploads(fdb, pdf, { klok, wie, start, io }); } catch (e) { fout('upload', e); }

  // 5. verzamelpostvak (alleen als de bron aan staat; tot F5 uit)
  const bron = fdb.db.prepare("SELECT * FROM bron WHERE soort = 'verzamelpostvak' AND actief = 1 ORDER BY naam LIMIT 1").get();
  if (bron && luikOk && klok() - start <= GRENS.rondeMs * 2) { try { uit.postvak = await leesPostvak(fdb, bron, io, pdf, { klok, wie, start }); if (!uit.postvak.ok) uit.ok = false; } catch (e) { fout('postvak', e); } }
  else uit.postvak = bron ? { overgeslagen: luikOk ? 'tijd' : 'lees-luik' } : { aan: false };

  // 6. hartslag (alleen soorten en aantallen)
  D.metaZet(fdb, 'koerier_ronde', JSON.stringify({ op: nuIso(start), eind: nuIso(klok()), ok: uit.ok, fout: uit.fouten.length ? uit.fouten.map((f) => f.wat + ':' + f.soort).join(', ').slice(0, 200) : null,
    verzending: uit.verzending, detectie: uit.detectie }));
  return uit;
}

// Eén opdracht: controleren, zo nodig eerst zoeken, reserveren, verzenden, uitkomst vastleggen.
async function verstuurEen(fdb, io, op, modus, o, uit) {
  const wie = o.wie, klok = o.klok;
  const c = controleer(fdb, op);
  if (!c.ok) { D.opdrachtResultaat(fdb, op.id, { status: 'geweigerd', fout: c.reden }, { nu: klok(), wie }); uit.verzending.geweigerd++; return; }
  const tok = tokenVan(op);
  // ooit gereserveerd voor deze factuur of dit afschrift (ook een eerdere opdracht, bv. vóór Opnieuw proberen)? Dan eerst zoeken.
  const eerder = fdb.db.prepare('SELECT 1 FROM opdracht WHERE verzend_reservering IS NOT NULL AND ' + (op.factuur ? 'factuur = ?' : 'afschrift = ?')).get(op.factuur || op.afschrift);
  if (eerder) {
    const t = await zoekToken(fdb, io, op);   // een zoekfout gooit LuikFout: niets versturen
    if (t && !t.passend) {
      D.opdrachtResultaat(fdb, op.id, { status: 'geweigerd', fout: t.verzonden ? 'er is al een mail met dit kenmerk verzonden (andere stukken of een ander adres); nakijken'
        : 'er staat al een concept met dit kenmerk (andere stukken of een ander adres): verwijder het oude concept in Gmail en kies Opnieuw proberen' }, { nu: klok(), wie });
      uit.verzending.geweigerd++;
      return;
    }
    if (t) {
      D.opdrachtResultaat(fdb, op.id, { status: 'gelukt', extern_id: t.id, modus: t.verzonden ? modus : 'concept', vingerafdruk_koerier: c.vingerafdruk, overgenomen: true }, { nu: klok(), wie });
      uit.verzending.overgenomen++;
      return;
    }
  }
  D.reserveer(fdb, op.id, { sleutel: tok, modus, nu: klok(), wie });
  const mail = mailVoor(fdb, op);
  let antw;
  try { antw = await io.verzender({ modus, aan: op.doeladres, onderwerp: mail.onderwerp, tekst: mail.tekst, token: tok, bijlagen: c.bijlagen }); }
  catch (e) {
    if (e && e.zekerNietVerstuurd) { D.opdrachtResultaat(fdb, op.id, { status: 'mislukt', fout: 'verzender: ' + foutSoort(e) }, { nu: klok(), wie }); uit.verzending.mislukt++; return; }
    uit.verzending.geen_resultaat++;   // time-out of verbinding weg: misschien wél gemaakt → opgehaald laten, na 30 min eerst zoeken
    return;
  }
  const st = antw && antw.status, j = (antw && antw.j) || {};
  // extern_id = de message-id van het concept (dezelfde id die het lees-luik bij het zoeken geeft); anders de draft-id
  const ext = (typeof j.message_id === 'string' && j.message_id) || (typeof j.extern_id === 'string' && j.extern_id) || null;
  if (st === 200 && j.ok === true && ext) {
    const r = D.opdrachtResultaat(fdb, op.id, { status: 'gelukt', extern_id: ext, modus: j.modus === 'versturen' ? 'versturen' : 'concept', vingerafdruk_koerier: c.vingerafdruk }, { nu: klok(), wie });
    if (r.ok) uit.verzending.gelukt++;
    return;
  }
  if (st === 403 && ['witte_lijst', 'versturen_uit'].includes(j.code)) {
    D.opdrachtResultaat(fdb, op.id, { status: 'geweigerd', fout: 'verzender weigert (' + j.code + ')' }, { nu: klok(), wie });
    uit.verzending.geweigerd++;
    return;
  }
  if (st === 200) { uit.verzending.geen_resultaat++; return; }   // 200 zonder extern_id: onduidelijk → niet als mislukt tellen, eerst zoeken
  // verkeerd geheim of plafond: zeker niets gemaakt, en elke volgende opdracht zou hetzelfde krijgen → geen resultaat en de ronde stopt met
  // verzenden (diffreview wv855 #3); de opdracht komt na 30 min terug
  if (st === 401 || st === 429) { uit.verzending.geen_resultaat++; const e = new Error('verzender ' + st); e.code = st === 401 ? 'verzender_geheim' : 'verzender_plafond'; e.stopVerzenden = true; throw e; }
  const r = D.opdrachtResultaat(fdb, op.id, { status: 'mislukt', fout: 'verzender http ' + (Number(st) || 0) + (j.code ? ' ' + kort(j.code, 30) : '') }, { nu: klok(), wie });
  uit.verzending.mislukt++;
  if (r.definitief) uit.verzending.definitief++;
}

// ───────────────────────────── schaduw PDF-lezer (wv1431) ─────────────────────────────

// Na de transactie, nooit ervoor. De kern-uitkomst per factuur uit de database (alleen de velden die de schaduw vergelijkt).
function schaduwPdf(fdb, io, berichtId, bericht, documenten, ruw, facturen) {
  if (typeof io.pdfSchaduw !== 'function' || !documenten.length) return;
  try {
    const q = fdb.db.prepare('SELECT f.status, f.nummer, f.factuurdatum, f.incl, f.iban, f.entiteit, d.sha256 AS document, u.sha256 AS ubl_document, d.tekstlaag ' +
      'FROM factuur f LEFT JOIN document d ON d.id = f.document LEFT JOIN document u ON u.id = f.ubl_document WHERE f.id = ?');
    const kern = (facturen || []).map((f) => q.get(f.id)).filter(Boolean).map((x) => Object.assign({}, x, { scan: x.tekstlaag === 0 }));
    io.pdfSchaduw({ soort: 'facturen', bericht_id: berichtId || null, bericht: bericht || null, kern,
      documenten: documenten.map((d) => ({ sha256: d.sha256, naam: d.naam, mime: d.mime, tekst: d.tekst, tekstlaag: d.tekstlaag, ubl_xml: d.ubl_xml,
        bytes: ruw.get(d.sha256) || null, patientkenmerk_koerier: !!d.patientkenmerk_koerier })) });
  } catch (e) { /* schaduw: nooit de ronde raken */ }
}

// ───────────────────────────── te_lezen-uploads ─────────────────────────────

async function leesUploads(fdb, pdf, o) {
  const tel = { gelezen: 0, facturen: 0, fout: 0 };
  // een upload die drie keer faalt, wordt overgeslagen en telt niet mee in de 20 (anders houden kapotte PDF's elke nieuwere tegen; diffreview wv855 #6)
  const pogingen = json(D.metaLees(fdb, 'koerier_upload_fout'), {}) || {};
  const opgegeven = Object.keys(pogingen).filter((k) => pogingen[k] >= 3 && /^[0-9a-f]{16}$/.test(k));
  tel.overgeslagen = opgegeven.length;
  const docs = fdb.db.prepare("SELECT d.* FROM document d WHERE d.te_lezen = 1 AND d.soort = 'pdf' AND NOT EXISTS (SELECT 1 FROM factuur f WHERE f.document = d.id OR f.ubl_document = d.id) " +
    'AND d.id NOT IN (SELECT value FROM json_each(?)) ORDER BY d.aangemaakt_op LIMIT ?').all(JSON.stringify(opgegeven), GRENS.teLezen);
  for (const d of docs) {
    if (o.klok() - o.start > GRENS.rondeMs * 2) break;
    try {
      const bytes = D.stukLees(fdb, d.sha256);
      const t = await pdf(bytes);
      if (!t.ok) throw Object.assign(new Error('pdftotext'), { code: t.fout });
      const docs = [{ sha256: d.sha256, naam: d.naam, mime: d.mime || 'application/pdf', bytes: d.bytes, tekst: t.tekst, tekstlaag: t.tekstlaag }];
      const v = F.verwerkBericht(fdb, { bericht: null, documenten: docs }, { wie: o.wie, nu: o.klok(), geupload_door: d.geupload_door });
      schaduwPdf(fdb, o.io || {}, null, null, docs, new Map([[d.sha256, bytes]]), v.facturen);
      tel.gelezen++; tel.facturen += v.facturen.length;
      delete pogingen[d.id];
    } catch (e) { tel.fout++; pogingen[d.id] = (pogingen[d.id] || 0) + 1; }
  }
  for (const k of Object.keys(pogingen)) {
    if (pogingen[k] < 3 && !docs.some((d) => d.id === k)) delete pogingen[k];
    else if (pogingen[k] >= 3 && !fdb.db.prepare('SELECT 1 FROM document WHERE id = ? AND te_lezen = 1').get(k)) delete pogingen[k];
  }
  D.metaZet(fdb, 'koerier_upload_fout', JSON.stringify(pogingen));
  hartslag(fdb, 'upload', 'upload', o, { ok: tel.fout === 0, aantallen: tel, fouten: [] });
  return tel;
}

function hartslag(fdb, soort, naam, o, r) {
  D.transactie(fdb, function () {
    let b = fdb.db.prepare('SELECT id FROM bron WHERE soort = ? ORDER BY naam LIMIT 1').get(soort);
    if (!b) { b = { id: D.nieuwId() }; D.voegToe(fdb, 'bron', { id: b.id, soort, naam, actief: soort === 'upload' ? 1 : 0 }); }
    D.voegToe(fdb, 'bron_ronde', { bron: b.id, start: nuIso(o.start || o.klok()), eind: nuIso(o.klok()), ok: r.ok ? 1 : 0, aantallen: r.aantallen, fouten: r.fouten || [], niet_gelezen: r.niet_gelezen || null });
  });
}

// ───────────────────────────── verzamelpostvak ─────────────────────────────

/*
 * Het verzamelpostvak via het lees-luik (bronnen.md): zoeken in een venster (bij 25 treffers het venster halveren), per nieuw bericht de
 * bijlagenlijst, per PDF/XML de bytes (≤ 8 MB per mail: daarboven "te groot", niet gelezen), pdftotext vluchtig, bij doorgestuurde mail
 * de oorspronkelijke afzender uit de mailtekst (die tekst wordt nergens bewaard). Dan bericht + stukken + besliskader in één transactie.
 */
async function leesPostvak(fdb, bron, io, pdf, o) {
  const tel = { berichten_gezien: 0, nieuw: 0, bijlagen: 0, te_groot: 0, fout: 0, facturen: 0 };
  const fouten = [], nietGelezen = [];
  const query = D.metaLees(fdb, 'koerier_query') || 'to:d.schaap+facturen@gmail.com has:attachment';
  const eigen = (json(D.metaLees(fdb, 'koerier_eigen_adressen'), null) || ['d.schaap@gmail.com', 'dokterschaap@gmail.com']).map((x) => String(x).toLowerCase());
  const vandaag = dagAmsterdam(o.start);
  const laatst = fdb.db.prepare('SELECT max(start) AS s FROM bron_ronde WHERE bron = ? AND ok = 1').get(bron.id).s;
  let van = plusDagen(vandaag, -GRENS.bronDagen);
  if (laatst) { const l = plusDagen(dagAmsterdam(Date.parse(laatst)), -2); if (l > van) van = l; }
  const mails = new Map();
  let afgekapt = false;
  async function venster(a, b, diepte) {
    const lijst = await zoek(io, query + ' after:' + gmailDag(a) + ' before:' + gmailDag(b));
    const dagen = K.dagenTussen(a, b);
    if (lijst.length >= 25 && dagen > 1 && diepte < 8) { const m = plusDagen(a, Math.floor(dagen / 2)); await venster(a, m, diepte + 1); await venster(m, b, diepte + 1); return; }
    if (lijst.length >= 25) afgekapt = true;
    for (const m of lijst) if (!mails.has(m.id)) mails.set(m.id, m);
  }
  try { await venster(plusDagen(van, -1), plusDagen(vandaag, 1), 0); }
  catch (e) { hartslag(fdb, 'verzamelpostvak', bron.naam, o, { ok: false, aantallen: tel, fouten: [{ wat: 'mail_zoeken', melding: foutSoort(e) }] }); return { ok: false, fout: 'zoeken', aantallen: tel }; }
  if (afgekapt) nietGelezen.push('meer dan 25 mails op één dag');
  const bekend = fdb.db.prepare('SELECT 1 FROM bericht WHERE bron = ? AND message_id = ?');
  const nieuw = [...mails.values()].filter((m) => !bekend.get(bron.id, m.id)).sort((a, b) => String(a.datum).localeCompare(String(b.datum)));
  tel.berichten_gezien = mails.size;
  for (const m of nieuw.slice(0, GRENS.berichten)) {
    try { tel.facturen += await leesBericht(fdb, bron, io, pdf, m, eigen, o, tel, nietGelezen); tel.nieuw++; }
    catch (e) { tel.fout++; fouten.push({ wat: 'bericht', id: kort(m.id, 40), melding: foutSoort(e) }); if (e instanceof LuikFout) break; }
  }
  if (nieuw.length > GRENS.berichten) nietGelezen.push('nog ' + (nieuw.length - GRENS.berichten) + ' mails voor de volgende ronde');
  const ok = tel.fout === 0;
  hartslag(fdb, 'verzamelpostvak', bron.naam, o, { ok, aantallen: tel, fouten, niet_gelezen: nietGelezen.length ? nietGelezen : null });
  return { ok, aantallen: tel };
}
async function leesBericht(fdb, bron, io, pdf, m, eigen, o, tel, nietGelezen) {
  let lijst;
  try { lijst = await io.luik({ actie: 'mail_bijlage', id: m.id }); } catch (e) { throw new LuikFout(foutSoort(e)); }
  if (!lijst || typeof lijst !== 'object') throw new LuikFout('geen_lijst');
  const documenten = [];
  if (lijst.fout) {
    if (/te groot/i.test(String(lijst.fout))) { tel.te_groot++; nietGelezen.push('bijlagen > 8 MB'); }
    else throw new LuikFout('bijlagenlijst');
  } else {
    const kand = (Array.isArray(lijst.bijlagen) ? lijst.bijlagen : []).filter((b) => b && typeof b.naam === 'string' &&
      (/pdf/i.test(String(b.mime)) || /\.(pdf|xml)$/i.test(b.naam) || /xml/i.test(String(b.mime))));
    const namen = new Set();
    for (const b of kand.slice(0, 10)) {
      if (namen.has(b.naam)) continue;   // dubbele naam: het lees-luik geeft er maar één
      namen.add(b.naam);
      let r;
      try { r = await io.luikBytes({ actie: 'mail_bijlage', id: m.id, naam: b.naam }); } catch (e) { throw new LuikFout(foutSoort(e)); }
      if (!r || !r.bytes) { if (r && r.json && /te groot/i.test(String(r.json.fout))) { tel.te_groot++; continue; } throw new LuikFout('bijlage'); }
      const bytes = Buffer.isBuffer(r.bytes) ? r.bytes : Buffer.from(r.bytes);
      if (!bytes.length || bytes.length > GRENS.bijlageBytes) { tel.te_groot++; continue; }
      tel.bijlagen++;
      const isPdf = bytes.subarray(0, 5).toString('latin1') === '%PDF-';
      const isXml = !isPdf && /^\s*(?:﻿)?</.test(bytes.subarray(0, 200).toString('utf8'));
      if (!isPdf && !isXml) continue;
      const doc = { naam: kort(b.naam, 255), mime: isPdf ? 'application/pdf' : 'application/xml', bytes: bytes.length, _bytes: bytes };
      if (isPdf) { const t = await pdf(bytes); doc.tekst = t.ok ? t.tekst : ''; doc.tekstlaag = !!(t.ok && t.tekstlaag); }
      else doc.ubl_xml = bytes.toString('utf8');
      doc.patientkenmerk_koerier = !!(doc.tekst && K.stapPatientkenmerk([doc.tekst]).kenmerk);
      documenten.push(doc);
    }
  }
  let afzender = kort(m.van, 320);
  if (documenten.length && isDoorgestuurd(m, eigen)) {
    try { const vol = await io.luik({ actie: 'mail_lezen', id: m.id }); const a = oorspronkelijkeAfzender(vol && vol.tekst); if (a) afzender = a; }
    catch (e) { /* dan blijft de doorstuurder de afzender (bronnen.md) */ }
  }
  // stukken eerst naar schijf (atomair, idempotent), dan in één transactie bericht + besliskader
  const ruw = new Map();
  for (const d of documenten) { const st = D.stukSchrijf(fdb, d._bytes); d.sha256 = st.sha256; ruw.set(d.sha256, d._bytes); delete d._bytes; }
  let n = 0, nieuwId = null, vf = null;
  D.transactie(fdb, function () {
    if (fdb.db.prepare('SELECT 1 FROM bericht WHERE bron = ? AND message_id = ?').get(bron.id, m.id)) return;
    const id = D.nieuwId();
    nieuwId = id;
    D.voegToe(fdb, 'bericht', { id, bron: bron.id, message_id: kort(m.id, 200), draad_id: kort(m.thread_id, 200), afzender, onderwerp: kort(m.onderwerp, 300),
      datum_lokaal: kort(m.datum_lokaal, 40), bron_link: 'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(String(m.id).slice(0, 100)), ontvangen_op: nuIso(o.klok()) });
    if (!documenten.length) return;
    const v = F.verwerkBericht(fdb, { bericht: { id, message_id: m.id, afzender, onderwerp: m.onderwerp }, documenten }, { wie: o.wie, nu: o.klok() });
    n = v.facturen.length; vf = v.facturen;
  });
  if (vf) schaduwPdf(fdb, io, nieuwId, { afzender, onderwerp: m.onderwerp }, documenten, ruw, vf);
  for (const d of documenten) { d.tekst = null; d.ubl_xml = null; }   // vluchtig: weg (de schaduw houdt zijn eigen verwijzing tot hij klaar is)
  ruw.clear();
  return n;
}

module.exports = { ronde, controleer, pdfNaarTekst, oorspronkelijkeAfzender, isDoorgestuurd, tokenVan, mailVoor, zoekToken, naamMetExtensie, LuikFout, GRENS, PDFTOTEXT, TOKEN_RE };
