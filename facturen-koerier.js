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
 * LIVE PDF-lezer (wv1921): staat Facturen live in pdf-lezer.json, dan leest Claude elke PDF VÓÓR de transactie (io.pdfLive, zelfde
 * patiëntregel); per document gaan model_kandidaat en de lokale tekst (ook OCR) als controle mee de kern in, en vallen daarna weg. Geen
 * antwoord, dicht of het rondebudget op: de kern leest zoals voorheen alleen de tekstregels.
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
  intake: 10,               // OVIS Intake-stukken per ronde (wv1919)
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
// wv2464: eigen verzonden mail aan anderen (label SENT of DRAFT, geen eigen adres onder de ontvangers, ook niet als +alias) is nooit een
// binnengekomen factuur (het interne boekstuk aan de boekhouder kwam zo als factuur binnen). Zonder labels geen oordeel (false).
function eigenVerzondenAanAnderen(m, eigen) {
  const lab = m && Array.isArray(m.labels) ? m.labels : [];
  if (!lab.includes('SENT') && !lab.includes('DRAFT')) return false;
  const ontv = [].concat(m.aan || [], m.cc || [], m.bcc || []).join(',').toLowerCase().match(/[a-z0-9._%+'-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}/g) || [];
  return !ontv.some((x) => { const at = x.lastIndexOf('@'), p = x.indexOf('+'); const k = p > 0 && p < at ? x.slice(0, p) + x.slice(at) : x; return (eigen || []).includes(x) || (eigen || []).includes(k); });
}
function adresIn(veld, adres) { return String(veld || '').toLowerCase().indexOf(String(adres || '').toLowerCase()) >= 0; }
function gmailDag(ymd) { return String(ymd).replace(/-/g, '/'); }
function plusDagen(ymd, n) { return K.plusDagen(ymd, n); }

// De verzender neemt alleen PDF, UBL-XML en (bij een afschrift) MT940 aan. De extensie volgt uit de inhoud, niet uit de naam; iets anders
// (een foto, een kantoorbestand) is niet verzendbaar → null, dan weigert de controle (diffreview wv855 #2 en natoets).
// MT940 begint met ':20:', of (ABN-export, ook wat pot-afschrift.js maakt) met de kop BIC / 940 / BIC en dan ':20:' (wv2852: zonder
// die kop werd elk ABN-afschrift geweigerd). Streng: alleen die drie regels mogen vóór ':20:' staan.
const MT940_KOP = /^\s*(?:[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\r?\n940\r?\n[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\r?\n)?:20:/;
function naamMetExtensie(naam, mime, bytes, soort) {
  const stam = String(naam || 'stuk').replace(/[\\/]/g, '_').replace(/\.(pdf|xml|940|sta|mt940)$/i, '').slice(0, 110) || 'stuk';
  const b = bytes || Buffer.alloc(0);
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return stam + '.pdf';
  if (/^\s*(?:\ufeff)?<(?:\?xml|(?:\w+:)?(?:Invoice|CreditNote)\b)/.test(b.subarray(0, 300).toString('utf8'))) return stam + '.xml';
  if (soort === 'boekhouder_afschrift' && MT940_KOP.test(b.subarray(0, 80).toString('latin1'))) return stam + '.940';
  return null;
}
// Onderwerp en tekst van de mail aan de boekhouder: kort, zonder factuurtekst, met het token.
function mailVoor(fdb, op, modus) {
  const e = fdb.db.prepare('SELECT naam, naam_kort FROM entiteit WHERE sleutel = ?').get(op.entiteit) || {};
  const ent = kort(e.naam_kort || e.naam || op.entiteit, 60);
  const tok = tokenVan(op);
  if (op.factuur) {
    const f = fdb.db.prepare('SELECT f.nummer, f.leverancier_naam, l.naam AS lev FROM factuur f LEFT JOIN leverancier l ON l.id = f.leverancier WHERE f.id = ?').get(op.factuur) || {};
    const wat = [kort(f.lev || f.leverancier_naam, 80), kort(f.nummer, 40)].filter(Boolean).join(' ');
    return { onderwerp: kort('Inkoopfactuur ' + ent + (wat ? ' — ' + wat : ''), 180) + ' [ref ' + tok + ']',
      tekst: 'Kenmerk ' + tok + ', opdracht ' + op.id + '.\n\nInkoopfactuur voor ' + kort(e.naam || ent, 120) + '.\n' + (modus === 'versturen' ? 'Verstuurd' : 'Klaargezet') + ' door Socev (assistent van David Schaap) na zijn akkoord.\n' };
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

  // 0b. wv2356: facturen die op "eerst nabellen" wachten opnieuw langs de IBAN-poort (eerdere eigen betalingen, archief, nagebeld, feit)
  try { const ih = F.ibanHerbereken(fdb, start); if (ih.bekend) uit.iban_bekend = ih.bekend; } catch (e) { fout('iban', e); }

  // 1. voorronde: opgehaald > 30 min mét reservering → eerst zoeken (anders maakt de claim hem bij poging 3 stil "mislukt" terwijl het
  //    concept er staat, of verstuurt hij opnieuw; Fable F4 MOET 2)
  for (const op of fdb.db.prepare("SELECT * FROM opdracht WHERE status = 'opgehaald' AND verzend_reservering IS NOT NULL AND opgehaald_op <= ? ORDER BY opgehaald_op LIMIT 20")
    .all(nuIso(start - OPGEHAALD_MS))) {
    if (klok() - start > GRENS.rondeMs) break;
    try {
      uit.voorronde.gezocht++;
      const t = await zoekToken(fdb, io, op);
      if (t && t.passend) {
        // wv2480: alleen 'versturen' als hij echt in Verzonden staat én direct gereserveerd was; een concept dat bleef staan = concept
        D.opdrachtResultaat(fdb, op.id, { status: 'gelukt', extern_id: t.id, modus: t.verzonden && op.modus === 'versturen' ? 'versturen' : 'concept', overgenomen: true }, { nu: klok(), wie });
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
    // wv2480: concept of direct wordt per opdracht gekozen (D.reserveerKies); de oude verzendmodus telt niet meer. Of de verzender direct
    // kent (Toetsen-hash), vraagt de koerier één keer per ronde en alleen als direct verzenden vrijgegeven is.
    let directKlaar = false;
    if (D.metaLees(fdb, 'versturen_vrijgegeven') === '1' && typeof io.directKlaar === 'function') { try { directKlaar = (await io.directKlaar()) === true; } catch (e) { directKlaar = false; } }
    uit.verzending.direct = 0; uit.verzending.direct_terug = 0; uit.verzending.direct_onzeker = 0;
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
      try { await verstuurEen(fdb, io, op, { klok, wie, pdf, directKlaar }, uit); }
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

  // 5b. OVIS Intake (wv1919): stukken die de router naar de facturenlens stuurde; los van het lees-luik (bytes komen uit de Intake-blob)
  if (io.intake && typeof io.intake.lijst === 'function' && typeof io.intake.uitkomst === 'function') {
    if (klok() - start <= GRENS.rondeMs * 2) { try { uit.intake = await leesIntake(fdb, io, pdf, { klok, wie, start }); if (!uit.intake.ok) uit.ok = false; } catch (e) { fout('intake', e); } }
    else uit.intake = { overgeslagen: 'tijd' };
  }

  // 6. hartslag (alleen soorten en aantallen)
  D.metaZet(fdb, 'koerier_ronde', JSON.stringify({ op: nuIso(start), eind: nuIso(klok()), ok: uit.ok, fout: uit.fouten.length ? uit.fouten.map((f) => f.wat + ':' + f.soort).join(', ').slice(0, 200) : null,
    verzending: uit.verzending, detectie: uit.detectie }));
  return uit;
}

// Eén opdracht: controleren, zo nodig eerst zoeken, reserveren, verzenden, uitkomst vastleggen.
/*
 * wv2480: de bijlagen vers lezen vlak vóór een directe verzending (review MOET 4: positief bewijs). Elke PDF met tekstlaag (≥ 40 tekens), een
 * UBL zonder ingebedde PDF, en de patiëntregel over alle tekst samen zonder kenmerk. De tekst blijft in deze functie (vluchtig).
 * → { ok } | { ok:false, reden }
 */
async function leesBewijs(bijlagen, pdf) {
  const teksten = [];
  for (const b of bijlagen || []) {
    if (/\.pdf$/i.test(b.naam)) {
      let t;
      try { t = await pdf(b.bytes); } catch (e) { t = { ok: false }; }
      if (!t || !t.ok || !t.tekstlaag || String(t.tekst || '').replace(/\s/g, '').length < 40) return { ok: false, reden: 'bijlage niet volledig leesbaar (geen tekstlaag)' };
      teksten.push(t.tekst);
    } else if (/\.xml$/i.test(b.naam)) {
      let s;
      try { s = K.stapSoort({ sha256: sha256(b.bytes), naam: b.naam, mime: 'application/xml', ubl_xml: b.bytes.toString('utf8') }); } catch (e) { s = null; }
      if (!s || s.soort !== 'ubl' || !s.ubl) return { ok: false, reden: 'UBL niet te lezen' };
      if (s.ubl.heeft_pdf) return { ok: false, reden: 'UBL met ingebedde PDF (niet lokaal gelezen)' };
      teksten.push(s.ubl._tekst);
    } else return { ok: false, reden: 'bijlagetype niet direct te versturen' };
  }
  if (!teksten.length) return { ok: false, reden: 'geen bijlage gelezen' };
  const pk = K.stapPatientkenmerk(teksten);
  teksten.length = 0;
  return pk.kenmerk ? { ok: false, reden: 'kenmerk van patiëntgegevens in een bijlage' } : { ok: true };
}
async function verstuurEen(fdb, io, op, o, uit) {
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
      // verzonden en eerder als direct gereserveerd → versturen; anders concept (een verzonden concept ziet de verzend-detectie)
      const vm = t.verzonden && fdb.db.prepare("SELECT 1 FROM opdracht WHERE modus = 'versturen' AND verzend_reservering IS NOT NULL AND " + (op.factuur ? 'factuur = ?' : 'afschrift = ?')).get(op.factuur || op.afschrift) ? 'versturen' : 'concept';
      D.opdrachtResultaat(fdb, op.id, { status: 'gelukt', extern_id: t.id, modus: vm, vingerafdruk_koerier: c.vingerafdruk, overgenomen: true }, { nu: klok(), wie });
      uit.verzending.overgenomen++;
      return;
    }
  }
  // wv2480: concept of direct. Eerst (alleen als de opdracht direct kan) de bijlagen vers lezen; dan in één transactie kiezen, het dagplafond
  // tellen en reserveren (D.reserveerKies = ook de hercontrole op de verse rijen). Tussen die transactie en de aanroep zit geen await.
  let bewijs = null;
  if (!eerder && o.directKlaar && D.directBesluit(fdb, op, {}).direct) bewijs = await leesBewijs(c.bijlagen, o.pdf || pdfNaarTekst);
  const keuze = D.reserveerKies(fdb, op.id, { sleutel: tok, nu: klok(), wie, bewijs, verzender: !!o.directKlaar });
  let modus = keuze.modus;
  let mail = mailVoor(fdb, op, modus);
  let antw;
  try { antw = await io.verzender({ modus, aan: op.doeladres, onderwerp: mail.onderwerp, tekst: mail.tekst, token: tok, bijlagen: c.bijlagen }); }
  catch (e) {
    if (e && e.zekerNietVerstuurd && modus === 'versturen') antw = { status: 0, j: { code: 'vooraf' }, vooraf: true };   // direct kon niet: zo meteen concept
    else if (e && e.zekerNietVerstuurd) { D.opdrachtResultaat(fdb, op.id, { status: 'mislukt', fout: 'verzender: ' + foutSoort(e) }, { nu: klok(), wie }); uit.verzending.mislukt++; return; }
    else {
      uit.verzending.geen_resultaat++;   // time-out of verbinding weg: misschien wél gemaakt → opgehaald laten, na 30 min eerst zoeken
      if (modus === 'versturen') { uit.verzending.direct_onzeker++; D.verzendNotitie(fdb, op, 'direct onzeker (geen antwoord van de verzender): nooit opnieuw direct; eerst zoeken, anders concept', { nu: klok(), wie }); }
      return;
    }
  }
  // wv2480: weigerde de verzender DIRECT vóór Gmail (Toetsen 4xx, verkeerd geheim, plafond, vooraf), dan is er zeker niets gemaakt: dezelfde
  // ronde als concept, met de reden in het besluitspoor. Een fout ná de toets (502 Gmail) is onzeker: geen tweede poging (na 30 min zoeken).
  if (modus === 'versturen' && antw && (antw.vooraf || (antw.status >= 400 && antw.status < 500))) {
    const code = kort((antw.j && antw.j.code) || antw.status, 30);
    D.terugNaarConcept(fdb, op.id, { sleutel: tok, nu: klok(), wie, reden: 'verzender weigerde direct (' + code + '): concept' });
    uit.verzending.direct_terug++;
    modus = 'concept'; mail = mailVoor(fdb, op, modus);
    try { antw = await io.verzender({ modus, aan: op.doeladres, onderwerp: mail.onderwerp, tekst: mail.tekst, token: tok, bijlagen: c.bijlagen }); }
    catch (e) {
      if (e && e.zekerNietVerstuurd) { D.opdrachtResultaat(fdb, op.id, { status: 'mislukt', fout: 'verzender: ' + foutSoort(e) }, { nu: klok(), wie }); uit.verzending.mislukt++; return; }
      uit.verzending.geen_resultaat++; return;
    }
  }
  const st = antw && antw.status, j = (antw && antw.j) || {};
  // extern_id = de message-id van het concept (dezelfde id die het lees-luik bij het zoeken geeft); anders de draft-id
  const ext = (typeof j.message_id === 'string' && j.message_id) || (typeof j.extern_id === 'string' && j.extern_id) || null;
  if (st === 200 && j.ok === true && ext) {
    const r = D.opdrachtResultaat(fdb, op.id, { status: 'gelukt', extern_id: ext, modus: j.modus === 'versturen' && modus === 'versturen' ? 'versturen' : 'concept', vingerafdruk_koerier: c.vingerafdruk }, { nu: klok(), wie });
    if (r.ok) { uit.verzending.gelukt++; if (modus === 'versturen' && j.modus === 'versturen') uit.verzending.direct++; }
    return;
  }
  if (modus === 'versturen') {   // wv2480: direct, en de uitkomst is onduidelijk (Gmail-fout na de toets, 200 zonder id, 5xx): nooit opnieuw direct
    uit.verzending.direct_onzeker++; uit.verzending.geen_resultaat++;
    D.verzendNotitie(fdb, op, 'direct onzeker (verzender http ' + (Number(st) || 0) + (j.code ? ' ' + kort(j.code, 30) : '') + '): nooit opnieuw direct; eerst zoeken, anders concept', { nu: klok(), wie });
    return;   // opgehaald laten: na 30 min zoekt de voorronde/verstuurEen eerst op het token; niets gevonden → concept
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
// overgeslagen: bijlagen van het bericht die niet als document meegingen (de PDF-lezer sluit dan het hele bericht, review wv1431 ZOU 4).
function schaduwPdf(fdb, io, berichtId, bericht, documenten, ruw, facturen, overgeslagen) {
  if (typeof io.pdfSchaduw !== 'function' || !documenten.length) return;
  try {
    const q = fdb.db.prepare('SELECT f.status, f.nummer, f.factuurdatum, f.incl, f.iban, f.entiteit, d.sha256 AS document, u.sha256 AS ubl_document, d.tekstlaag ' +
      'FROM factuur f LEFT JOIN document d ON d.id = f.document LEFT JOIN document u ON u.id = f.ubl_document WHERE f.id = ?');
    const kern = (facturen || []).map((f) => q.get(f.id)).filter(Boolean).map((x) => Object.assign({}, x, { scan: x.tekstlaag === 0 }));
    io.pdfSchaduw({ soort: 'facturen', bericht_id: berichtId || null, bericht: bericht || null, kern, overgeslagen: Number.isInteger(overgeslagen) ? overgeslagen : null,
      documenten: documenten.map((d) => ({ sha256: d.sha256, naam: d.naam, mime: d.mime, tekst: d.tekst, tekstlaag: d.tekstlaag, ubl_xml: d.ubl_xml,
        bytes: ruw.get(d.sha256) || null, patientkenmerk_koerier: !!d.patientkenmerk_koerier })) });
  } catch (e) { /* schaduw: nooit de ronde raken */ }
}

// Vóór de transactie (wv1921). docs: [{ sha256, naam, mime, tekst?, ubl_xml?, patientkenmerk_koerier }], ruw: Map sha256 → bytes. Zet per
// document model_kandidaat en ocr_tekst (vluchtig; de koerier wist ze na de transactie). → aantal gelezen documenten.
async function pdfLive(io, bericht, docs, ruw, overgeslagen, o) {
  if (typeof io.pdfLive !== 'function' || !docs.some((d) => d.tekst != null || d.mime === 'application/pdf')) return 0;
  if (o && typeof o.klok === 'function' && o.klok() - o.start > GRENS.rondeMs) return 0;   // rondebudget op: deze keer de tekstregels
  let r = null;
  try {
    r = await io.pdfLive({ soort: 'facturen', bericht: bericht || null, overgeslagen: Number.isInteger(overgeslagen) ? overgeslagen : null,
      documenten: docs.map((d) => ({ sha256: d.sha256, naam: d.naam, mime: d.mime, ubl_xml: d.ubl_xml, bytes: ruw.get(d.sha256) || null, patientkenmerk_koerier: !!d.patientkenmerk_koerier })) });
  } catch (e) { r = null; }
  if (!r || !r.open || !r.perDoc) return 0;
  let n = 0;
  for (const d of docs) { const x = r.perDoc[d.sha256]; if (x && x.kandidaat) { d.model_kandidaat = x.kandidaat; d.ocr_tekst = typeof x.ocr_tekst === 'string' ? x.ocr_tekst : null; n++; } }
  return n;
}

// ───────────────────────────── te_lezen-uploads ─────────────────────────────

async function leesUploads(fdb, pdf, o) {
  const tel = { gelezen: 0, facturen: 0, fout: 0, claude: 0 };
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
      const ruw = new Map([[d.sha256, bytes]]);
      tel.claude = (tel.claude || 0) + await pdfLive(o.io || {}, null, docs, ruw, 0, o);
      const v = F.verwerkBericht(fdb, { bericht: null, documenten: docs }, { wie: o.wie, nu: o.klok(), geupload_door: d.geupload_door });
      schaduwPdf(fdb, o.io || {}, null, null, docs, ruw, v.facturen, 0);
      for (const x of docs) { x.tekst = null; x.ocr_tekst = null; x.model_kandidaat = null; }
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
    rondeVoor(fdb, b.id, o, r);
  });
}
function rondeVoor(fdb, bronId, o, r) {
  D.voegToe(fdb, 'bron_ronde', { bron: bronId, start: nuIso(o.start || o.klok()), eind: nuIso(o.klok()), ok: r.ok ? 1 : 0, aantallen: r.aantallen, fouten: r.fouten || [], niet_gelezen: r.niet_gelezen || null });
}

// ───────────────────────────── verzamelpostvak ─────────────────────────────

/*
 * Het verzamelpostvak via het lees-luik (bronnen.md): zoeken in een venster (bij 25 treffers het venster halveren), per nieuw bericht de
 * bijlagenlijst, per PDF/XML de bytes (≤ 8 MB per mail: daarboven "te groot", niet gelezen), pdftotext vluchtig, bij doorgestuurde mail
 * de oorspronkelijke afzender uit de mailtekst (die tekst wordt nergens bewaard). Dan bericht + stukken + besliskader in één transactie.
 */
async function leesPostvak(fdb, bron, io, pdf, o) {
  const tel = { berichten_gezien: 0, nieuw: 0, bijlagen: 0, te_groot: 0, fout: 0, facturen: 0, claude: 0 };
  const fouten = [], nietGelezen = [];
  const query = D.metaLees(fdb, 'koerier_query') || 'to:d.schaap+facturen@gmail.com has:attachment';
  const eigen = (json(D.metaLees(fdb, 'koerier_eigen_adressen'), null) || ['d.schaap@gmail.com', 'dokterschaap@gmail.com']).map((x) => String(x).toLowerCase());
  const vandaag = dagAmsterdam(o.start);
  const laatst = fdb.db.prepare('SELECT max(start) AS s FROM bron_ronde WHERE bron = ? AND ok = 1').get(bron.id).s;
  let van = plusDagen(vandaag, -GRENS.bronDagen);
  if (laatst) { const l = plusDagen(dagAmsterdam(Date.parse(laatst)), -2); if (l > van) van = l; }
  const mails = new Map();
  let afgekapt = false;
  async function venster(q, a, b, diepte) {
    const lijst = await zoek(io, q + ' after:' + gmailDag(a) + ' before:' + gmailDag(b));
    const dagen = K.dagenTussen(a, b);
    if (lijst.length >= 25 && dagen > 1 && diepte < 8) { const m = plusDagen(a, Math.floor(dagen / 2)); await venster(q, a, m, diepte + 1); await venster(q, m, b, diepte + 1); return; }
    if (lijst.length >= 25) afgekapt = true;
    for (const m of lijst) if (!mails.has(m.id)) mails.set(m.id, m);
  }
  // wv1973 (OVIS MailMan B5, bouwplan O.6): MailMan zet het label FACTUUR soms later dan de ontvangst (Jev-wacht, inhaalslag, live zetten),
  // dus buiten het venster hierboven (laatste ronde min 2 dagen). Een tweede zoekvraag (meta koerier_query_label, bv. 'label:FACTUUR
  // has:attachment') kijkt altijd GRENS.bronDagen terug; wat al gelezen is valt er hieronder af (bericht.message_id), dezelfde pdf via
  // +facturen én het label geeft in de app "dubbel" op sha256. Geen meta = als vóór wv1973.
  const labelQuery = D.metaLees(fdb, 'koerier_query_label');
  try {
    await venster(query, plusDagen(van, -1), plusDagen(vandaag, 1), 0);
    if (labelQuery) await venster(labelQuery, plusDagen(vandaag, -GRENS.bronDagen - 1), plusDagen(vandaag, 1), 0);
  }
  catch (e) { hartslag(fdb, 'verzamelpostvak', bron.naam, o, { ok: false, aantallen: tel, fouten: [{ wat: 'mail_zoeken', melding: foutSoort(e) }] }); return { ok: false, fout: 'zoeken', aantallen: tel }; }
  if (afgekapt) nietGelezen.push('meer dan 25 mails op één dag');
  const bekend = fdb.db.prepare('SELECT 1 FROM bericht WHERE bron = ? AND message_id = ?');
  const eigenUit = [...mails.values()].filter((m) => eigenVerzondenAanAnderen(m, eigen)).length;   // wv2464
  if (eigenUit) tel.eigen_verzonden = eigenUit;
  const nieuw = [...mails.values()].filter((m) => !bekend.get(bron.id, m.id) && !eigenVerzondenAanAnderen(m, eigen)).sort((a, b) => String(a.datum).localeCompare(String(b.datum)));
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
  const totaalBijlagen = Array.isArray(lijst.bijlagen) ? lijst.bijlagen.length : 0;
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
  if (documenten.length) tel.claude = (tel.claude || 0) + await pdfLive(io, { afzender, onderwerp: m.onderwerp }, documenten, ruw, totaalBijlagen - documenten.length, o);
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
  if (vf) schaduwPdf(fdb, io, nieuwId, { afzender, onderwerp: m.onderwerp }, documenten, ruw, vf, totaalBijlagen - documenten.length);
  for (const d of documenten) { d.tekst = null; d.ubl_xml = null; d.ocr_tekst = null; d.model_kandidaat = null; }   // vluchtig: weg (de schaduw houdt zijn eigen verwijzing tot hij klaar is)
  ruw.clear();
  return n;
}


// ───────────────────────────── OVIS Intake als tweede bron (wv1919) ─────────────────────────────

/*
 * OVIS Intake stap 3d (bouwplan vault "01_Ontwikkeling/OVIS Intake - één ingang en router (bouwplan 24-10-2026).md" § 12.4.4). Een stuk dat
 * de router naar de facturenlens stuurde (bestemming 'aangeboden') leest de koerier hier als bericht in: bytes uit de Intake-blob (via
 * io.intake.lijst, in het geheugen), pdftotext vluchtig, hetzelfde besliskader (F.verwerkBericht, dubbel op sha256: een pdf die al via het
 * verzamelpostvak binnenkwam wordt stil overgeslagen), daarna terugmelden (io.intake.uitkomst → bestemming 'bevestigd' + uitvoering in
 * intake.sqlite). Bevestigen in de Facturen-app blijft Davids knop: hier wordt alleen ingelezen. De router geeft alleen stukken die de
 * patiëntmarker doorliet (nooit een vastgehouden stuk); Claude (PDF-lezer live) en de schaduw alleen met een Jev-uitslag onder de drempel
 * en niet na Davids "gewoon verwerken", gelijk aan de kennislens. Eén bronrij per Intake-bron (naam 'intake:<bron>'), message_id = de id in
 * die bron (Gmail-id), zodat MailMan (factuur verwerkt, factuurstap) dit bericht vindt zoals een bericht uit het verzamelpostvak.
 */
function intakeNaam(bron) { return 'intake:' + String(bron || 'onbekend').replace(/[^a-z0-9:-]/gi, '').slice(0, 60); }
function intakeBron(fdb, bron) {
  const naam = intakeNaam(bron);
  let b = fdb.db.prepare("SELECT * FROM bron WHERE soort = 'intake' AND naam = ?").get(naam);
  if (!b) { b = { id: D.nieuwId(), soort: 'intake', naam, actief: 1 }; D.voegToe(fdb, 'bron', b); }
  return b;
}
const intakeTel = () => ({ stukken: 0, ingelezen: 0, al_ingelezen: 0, facturen: 0, documenten: 0, fout: 0, claude: 0, knoop_id: 0 });
async function leesIntake(fdb, io, pdf, o) {
  const tel = intakeTel();
  const fouten = [];
  const per = new Map();   // wv2617: intakeNaam → { bron, tel, fouten } (de hartslag per Intake-bron)
  let stukken;
  try { stukken = await io.intake.lijst(GRENS.intake); } catch (e) { intakeHartslag(fdb, o, false, per); return { ok: false, fout: 'lijst', aantallen: tel }; }
  if (!Array.isArray(stukken)) { intakeHartslag(fdb, o, false, per); return { ok: false, fout: 'lijst', aantallen: tel }; }
  const eigen = (json(D.metaLees(fdb, 'koerier_eigen_adressen'), null) || ['d.schaap@gmail.com', 'dokterschaap@gmail.com']).map((x) => String(x).toLowerCase());
  for (const s of stukken) {
    if (o.klok() - o.start > GRENS.rondeMs * 2) break;
    const naam = intakeNaam(s && s.bron);
    if (!per.has(naam)) per.set(naam, { bron: s && s.bron, tel: intakeTel(), fouten: [] });
    const p = per.get(naam);
    p.tel.stukken++;
    try {
      const r = await leesIntakeStuk(fdb, io, pdf, s, eigen, o, p.tel);
      await io.intake.uitkomst(s.stuk_id, s.versie, { ok: true, uitkomst: r });
    } catch (e) {
      p.tel.fout++; p.fouten.push({ wat: 'stuk', id: kort(s && s.stuk_id, 40), melding: foutSoort(e) });
      try { await io.intake.uitkomst(s.stuk_id, s.versie, { ok: false, code: foutSoort(e) }); } catch (e2) { /* volgende ronde opnieuw (blijft aangeboden) */ }
    }
  }
  for (const p of per.values()) { for (const k of Object.keys(tel)) tel[k] += p.tel[k]; fouten.push(...p.fouten); }
  intakeHartslag(fdb, o, true, per);
  return { ok: tel.fout === 0, aantallen: tel };
}
/*
 * wv2617 (David 7-11-2026, Engineer-knop: rode melding 'intake:gmail:david' terwijl alles liep). Vroeger alleen een ronde als er stukken waren
 * (en op de eerste Intake-bron op naam): een dag zonder Intake-factuur kleurde de bron na 26 u rood. Nu na elke lijst-aanroep een ronde voor
 * elke Intake-bron die de koerier kent (minstens intake:gmail:david): gelukte lijst → ok tenzij een stuk van die bron faalde; mislukte lijst
 * → ok 0 (dan terecht rood).
 */
function intakeHartslag(fdb, o, lijstOk, per) {
  D.transactie(fdb, function () {
    intakeBron(fdb, 'gmail:david');
    for (const p of per.values()) intakeBron(fdb, p.bron);
    for (const b of fdb.db.prepare("SELECT id, naam FROM bron WHERE soort = 'intake' ORDER BY naam").all()) {
      const p = per.get(b.naam);
      const t = p ? p.tel : intakeTel();
      rondeVoor(fdb, b.id, o, lijstOk ? { ok: t.fout === 0, aantallen: t, fouten: p ? p.fouten : [] } : { ok: false, aantallen: t, fouten: [{ wat: 'lijst' }] });
    }
  });
}
async function leesIntakeStuk(fdb, io, pdf, s, eigen, o, tel) {
  if (!s || typeof s.stuk_id !== 'string' || !Array.isArray(s.documenten)) throw Object.assign(new Error('stuk onvolledig'), { code: 'stuk' });
  if (s.ontbreekt > 0) throw Object.assign(new Error('bijlage niet meer in Intake'), { code: 'ontbreekt' });
  const bron = D.transactie(fdb, function () { return intakeBron(fdb, s.bron); });
  const mid = kort(s.bron_id || s.stuk_id, 200);
  if (fdb.db.prepare('SELECT 1 FROM bericht WHERE bron = ? AND message_id = ?').get(bron.id, mid)) { tel.al_ingelezen++; return 'al_ingelezen'; }
  const documenten = [];
  for (const b of s.documenten) {
    const bytes = Buffer.isBuffer(b.bytes) ? b.bytes : Buffer.from(b.bytes || '');
    if (!bytes.length || bytes.length > GRENS.bijlageBytes) continue;
    const isPdf = bytes.subarray(0, 5).toString('latin1') === '%PDF-';
    const isXml = !isPdf && /^\s*(?:﻿)?</.test(bytes.subarray(0, 200).toString('utf8'));
    if (!isPdf && !isXml) continue;
    const doc = { naam: kort(b.naam, 255), mime: isPdf ? 'application/pdf' : 'application/xml', bytes: bytes.length, _bytes: bytes };
    if (isPdf) { const t = await pdf(bytes); doc.tekst = t.ok ? t.tekst : ''; doc.tekstlaag = !!(t.ok && t.tekstlaag); }
    else doc.ubl_xml = bytes.toString('utf8');
    doc.patientkenmerk_koerier = !!(doc.tekst && K.stapPatientkenmerk([doc.tekst]).kenmerk);
    documenten.push(doc);
  }
  // review wv1919 MOET 1: een te grote of onleesbare bijlage is geen geslaagde levering (anders verdween de factuur stil uit Intake): fout
  // richting de router, die het na vijf pogingen aan David teruggeeft
  if (s.te_groot > 0 || documenten.length < s.documenten.length || !documenten.length) throw Object.assign(new Error('bijlage te groot of geen pdf/UBL'), { code: s.te_groot > 0 ? 'te_groot' : 'geen_document' });
  tel.documenten += documenten.length;
  let afzender = kort(s.van, 320);
  if (documenten.length && s.mailtekst && isDoorgestuurd({ van: s.van, onderwerp: s.onderwerp }, eigen)) { const a = oorspronkelijkeAfzender(s.mailtekst); if (a) afzender = a; }
  const ruw = new Map();
  for (const d of documenten) { const st = D.stukSchrijf(fdb, d._bytes); d.sha256 = st.sha256; ruw.set(d.sha256, d._bytes); delete d._bytes; }
  const model = s.jev === 'onder' && !s.na_keuze;   // gelijk aan de kennislens: geen model zonder Jev onder de drempel of na "gewoon verwerken"
  if (documenten.length && model) tel.claude += await pdfLive(io, { afzender, onderwerp: s.onderwerp }, documenten, ruw, 0, o);
  let vf = null, nieuwId = null, al = false;
  D.transactie(fdb, function () {
    if (fdb.db.prepare('SELECT 1 FROM bericht WHERE bron = ? AND message_id = ?').get(bron.id, mid)) { al = true; return; }
    nieuwId = D.nieuwId();
    D.voegToe(fdb, 'bericht', { id: nieuwId, bron: bron.id, message_id: mid, draad_id: kort(s.thread_id, 200), afzender, onderwerp: kort(s.onderwerp, 300),
      datum_lokaal: kort(s.ontvangen, 40), bron_link: s.bron === 'gmail:david' && /^[0-9a-f]{12,24}$/.test(mid) ? 'https://mail.google.com/mail/u/0/#all/' + mid : null, ontvangen_op: nuIso(o.klok()) });
    if (!documenten.length) return;
    // wv2480: het Intake-label mogelijk medisch gaat als besluit mee (alleen als de router het meegeeft; anders geen direct verzenden)
    const v = F.verwerkBericht(fdb, { bericht: { id: nieuwId, message_id: mid, afzender, onderwerp: s.onderwerp }, documenten },
      { wie: o.wie, nu: o.klok(), mogelijk_medisch: typeof s.mogelijk_medisch === 'boolean' ? s.mogelijk_medisch : undefined });
    vf = v.facturen;
  });
  if (al) { tel.al_ingelezen++; return 'al_ingelezen'; }
  if (vf && model) schaduwPdf(fdb, io, nieuwId, { afzender, onderwerp: s.onderwerp }, documenten, ruw, vf, 0);
  for (const d of documenten) { d.tekst = null; d.ubl_xml = null; d.ocr_tekst = null; d.model_kandidaat = null; }
  ruw.clear();
  tel.ingelezen++;
  const n = vf ? vf.length : 0;
  tel.facturen += n;
  // knoop_id (§ 12.4.4): domein alleen als de afzender met DKIM vaststaat en het geen doorgestuurde mail van David is
  if (n && typeof io.knoopVoor === 'function') {
    const echt = s.dkim === 'uitgelijnd' && afzender === kort(s.van, 320) && !eigen.includes(String(s.van || '').toLowerCase());
    tel.knoop_id += await knoopVul(fdb, io, vf.map((f) => f.id), echt ? String(s.van).split('@')[1] : null, o);
  }
  return n ? 'facturen:' + n : 'al_in_facturen';
}
/*
 * leverancier.knoop_id deterministisch vullen (§ 12.4.4): KvK van de factuur (of het vaste afzenderdomein) gelijk aan een ACTIEF kenmerk van
 * precies één organisatie in het OVIS-register (io.knoopVoor, de router kent het register). Twijfel = niets; een gevulde knoop_id wordt nooit
 * overschreven. → aantal gevulde leveranciers.
 */
async function knoopVul(fdb, io, factuurIds, domein, o) {
  let n = 0;
  for (const id of factuurIds || []) {
    const f = fdb.db.prepare('SELECT f.leverancier, f.leverancier_kvk, l.knoop_id FROM factuur f JOIN leverancier l ON l.id = f.leverancier WHERE f.id = ?').get(id);
    if (!f || f.knoop_id || (!f.leverancier_kvk && !domein)) continue;
    let k = null;
    try { k = await io.knoopVoor({ kvk: f.leverancier_kvk || null, domein: domein || null }); } catch (e) { k = null; }
    if (!k) continue;
    const wanneer = nuIso(o.klok());
    D.transactie(fdb, function () {
      if (fdb.db.prepare('UPDATE leverancier SET knoop_id = ?, bijgewerkt_op = ? WHERE id = ? AND knoop_id IS NULL').run(k, wanneer, f.leverancier).changes === 1) {
        D.audit(fdb, { wie: o.wie, wat: 'knoop_id', object_soort: 'leverancier', object_id: f.leverancier, na: { knoop_id: k, via: f.leverancier_kvk ? 'kvk' : 'domein' }, wanneer });
        n++;
      }
    });
  }
  return n;
}

module.exports = { ronde, leesIntake, eigenVerzondenAanAnderen, knoopVul, controleer, pdfNaarTekst, oorspronkelijkeAfzender, isDoorgestuurd, tokenVan, mailVoor, zoekToken, naamMetExtensie, LuikFout, GRENS, PDFTOTEXT, TOKEN_RE };
