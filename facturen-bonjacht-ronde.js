'use strict';
/*
 * facturen-bonjacht-ronde.js — bonjacht stap B (wv3973, besluitenpagina nr 157 = 2C57, David 22-11-2026: "Alleen voor de lijsten die mijn
 * vader stuurt"). Ontwerp + review vooraf: mk-scripts/wv3916/ontwerp.md (punten 1 en 4); de pure lezer en beoordelaar is facturen-bonjacht.js
 * (stap A, wv3916).
 *
 * WAAROM. De boekhouder stuurt een paar keer per maand een Exact-lijst "betaald, bon ontbreekt". Deze stap in de bestaande koerier-ronde
 * (POST /facturen-ronde) herkent zo'n lijst in Davids mail, koppelt elke post aan de bankregel, zoekt de bon in de mail en zet een gevonden
 * bon in Facturen › Beoordelen klaar met "al betaald" en het bewijs (de bankregel). Bij Davids Bevestigen koppelt facturen.js de factuur aan
 * die bankregel (pas dan: grondwet, geen koppeling zonder mens). Wat niet te vinden was, staat met de reden in het blok in de app.
 *
 * WAT HIJ NIET DOET. Niets versturen, geen labels, geen mail wijzigen: alleen het lees-luik (mail_zoeken, mail_lezen, mail_bijlage). Mailtekst
 * blijft in het geheugen; alleen van een gevonden bon wordt een document (de pdf van de mail of de pdf-bijlage), zoals bij elke factuur die
 * de koerier inleest. In bonjacht_regel staan alleen Gmail-id, account, datum, afzender, onderwerp en bijlagenamen.
 *
 * VORM. Geen netwerk-, bestands- of procesmodule: lees-luik (io.luik, io.luikBytes) en pdftotext (o.pdf) komen van de koerier; de stukken
 * schrijft facturen-db.js. Budget per ronde: hooguit GRENS.regels posten en GRENS.ms; de rest volgt de volgende ronde. Een zoekfout is nooit
 * "niet gevonden" (status fout, later opnieuw, hooguit GRENS.pogingen keer).
 */
const K = require('./facturen-kern.js');
const D = require('./facturen-db.js');
const F = require('./facturen.js');
const B = require('./facturen-bonjacht.js');
const SP = require('./facturen-specificatie.js');

const GRENS = {
  regels: 4,                 // posten per ronde (elke post: 2 zoekvragen + ≤ 16 × mail_lezen/mail_bijlage)
  ms: 120000,                // na 2 min in deze stap geen nieuwe post meer
  pogingen: 4,               // een zoekfout zo vaak opnieuw; daarna blijft hij op fout staan (zichtbaar in het blok)
  berichten: 6,              // nieuwe lijstmails per ronde
  dagen: 21,                 // zo ver kijkt de zoekvraag terug
  bijlageBytes: 5 * 1024 * 1024,
  luikMs: 60000,             // eigen time-out per luikvraag (memory leesluik-zoeken-traag-bij-25: standaard 15 s is te krap bij 25 treffers)
  pdfPaginas: 6,
};
const AFZENDERS = ['a.schaap@actasynergia.nl'];
const ACCOUNTS = ['', 'dm'];   // '' = Davids eigen Gmail (prive), dm = het praktijkpostvak
const EMAIL_RE = /^[a-z0-9._%+'-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/;

function nuIso(ms) { return new Date(ms).toISOString(); }
function kort(s, n) { return s == null ? null : String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
function json(v, standaard) { if (typeof v !== 'string') return v == null ? standaard : v; try { return JSON.parse(v); } catch (e) { return standaard; } }
function foutSoort(e) { return kort((e && (e.code || e.name)) || 'fout', 40); }
function accountNaam(a) { return a === 'dm' ? 'dm' : 'prive'; }
function luikAccount(naam) { return naam === 'dm' ? 'dm' : ''; }

function afzenders(fdb) {
  const m = json(D.metaLees(fdb, 'bonjacht_afzenders'), null);
  const l = (Array.isArray(m) ? m : AFZENDERS).map((x) => String(x || '').trim().toLowerCase()).filter((x) => EMAIL_RE.test(x));
  return l.length ? l.slice(0, 10) : AFZENDERS;
}
function lijstQuery(afz) { return 'from:(' + afz.join(' OR ') + ') (filename:xlsx OR filename:dat) newer_than:' + GRENS.dagen + 'd'; }

// De q-functies van B.koppelBank op de Facturen-database (alleen lezen); gelijk aan de droogproef van wv3916 (mk-scripts/wv3916/echt.js).
function qVoor(fdb) {
  const db = fdb.db;
  return {
    rekening: (iban) => db.prepare("SELECT entiteit FROM rekening WHERE replace(upper(iban), ' ', '') = ?").get(iban) || null,
    transacties: (e, iban, c, van, tot) => db.prepare('SELECT id, boekdatum, tegenpartij_naam, omschrijving FROM bank_transactie WHERE entiteit = ? AND bedrag_centen = ? ' +
      'AND boekdatum BETWEEN ? AND ? AND verwijderd_op IS NULL').all(e, c, van, tot),
    achter: (id) => db.prepare('SELECT pr2.tegenpartij AS partij, pr2.datum AS datum, coalesce(pr2.factuur, pr.factuur) AS factuur FROM paypal_regel pr ' +
      "JOIN paypal_regel pr2 ON pr2.datum = pr.datum AND pr2.bedrag_centen = -pr.bedrag_centen AND pr2.tegenpartij IS NOT NULL AND pr2.tegenpartij <> '' " +
      'WHERE pr.bank_transactie = ? LIMIT 1').get(id) || null,
    factuur: (id) => (db.prepare('SELECT factuur FROM koppeling WHERE transactie = ? LIMIT 1').get(id) || {}).factuur || null,
  };
}
function bonjachtBron(fdb) {
  let b = fdb.db.prepare("SELECT * FROM bron WHERE soort = 'bonjacht' ORDER BY naam LIMIT 1").get();
  if (!b) { b = { id: D.nieuwId(), soort: 'bonjacht', naam: 'bonjacht', actief: 1 }; D.voegToe(fdb, 'bron', b); }
  return b;
}

// ───────────────────────────── pdf van een mail (de mail is de bon) ─────────────────────────────

/*
 * mailPdf({ van, datum, onderwerp, tekst }, o) → Buffer. A4, Helvetica, kop (afzender, datum, onderwerp) en de tekst, afgebroken op de
 * paginabreedte, hooguit GRENS.pdfPaginas pagina's. Dezelfde bouwstenen als de maandspecificatie (facturen-specificatie.js).
 */
function mailPdf(m, o) {
  const { breedte, hex, getal, pdfBestand } = SP.pdf;
  const W = 595.28, H = 841.89, M = 50, PT = 9.5, RIJ = 13, MAX = W - 2 * M;
  const paginas = []; let p = null, y = 0;
  const txt = (f, pt, x, yy, s) => p.push('BT /' + f + ' ' + getal(pt) + ' Tf ' + getal(x) + ' ' + getal(yy) + ' Td ' + hex(s) + ' Tj ET');
  const nieuw = () => { p = []; paginas.push(p); y = H - M; };
  const breek = (f, pt, s) => {
    const uit = []; let r = '';
    for (const w of String(s).split(/(\s+)/)) {
      if (!w) continue;
      const proef = r + w;
      if (breedte(f, pt, proef) <= MAX) { r = proef; continue; }
      if (r.trim()) uit.push(r.replace(/\s+$/, ''));
      r = /^\s+$/.test(w) ? '' : w;
      while (breedte(f, pt, r) > MAX) { let n = r.length; while (n > 1 && breedte(f, pt, r.slice(0, n)) > MAX) n--; uit.push(r.slice(0, n)); r = r.slice(n); }
    }
    if (r.trim() || !uit.length) uit.push(r.replace(/\s+$/, ''));
    return uit;
  };
  nieuw();
  txt('F2', 13, M, y - 13, 'Bon uit de mail'); y -= 30;
  for (const [k, v] of [['Van', m.van], ['Datum', m.datum], ['Onderwerp', m.onderwerp]]) {
    for (const [i, regel] of breek('F1', PT, String(v || '-').replace(/[\u0000-\u001f\u007f]+/g, ' ')).entries()) {
      if (i === 0) txt('F2', PT, M, y - PT, k + ':');
      txt('F1', PT, M + 70, y - PT, regel); y -= RIJ;
      if (i >= 2) break;
    }
  }
  p.push('0.6 0.65 0.68 RG 0.5 w ' + getal(M) + ' ' + getal(y - 4) + ' m ' + getal(W - M) + ' ' + getal(y - 4) + ' l S 0 G'); y -= 18;
  const tekst = String(m.tekst || '').replace(/\r\n?/g, '\n').replace(/[  ]/g, ' ').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  let vol = false;
  for (const alinea of tekst.split('\n')) {
    for (const regel of breek('F1', PT, alinea)) {
      if (y - RIJ < M) {
        if (paginas.length >= GRENS.pdfPaginas) { vol = true; break; }
        nieuw();
      }
      if (regel) txt('F1', PT, M, y - PT, regel);
      y -= RIJ;
    }
    if (vol) break;
  }
  if (vol) txt('F1', 8, M, M - 20, '(ingekort: de volledige mail staat in Gmail)');
  return pdfBestand(paginas, { W, H, titel: 'Bon uit de mail', gemaakt: o && o.gemaakt });
}

// ───────────────────────────── lijsten herkennen ─────────────────────────────

async function lijstenLezen(fdb, io, o, tel) {
  const afz = afzenders(fdb), q = qVoor(fdb);
  const bekend = fdb.db.prepare('SELECT 1 FROM bonjacht_lijst WHERE message_id = ? LIMIT 1');
  const shaBekend = fdb.db.prepare("SELECT id FROM bonjacht_lijst WHERE sha256 = ? AND sha256 <> '' LIMIT 1");
  for (const account of ACCOUNTS) {
    // review MOET 3: het luik geeft hooguit 25; een vol antwoord = per week opnieuw (newer_than/older_than), zodat oudere lijsten niet wegvallen
    const mails = new Map(); let mis = false;
    for (const q of [lijstQuery(afz)]) {
      let z;
      try { z = await io.luik({ actie: 'mail_zoeken', query: q, account, max: 25 }); } catch (e) { tel.fouten.push('zoeken:' + foutSoort(e)); mis = true; break; }
      if (!z || !Array.isArray(z.mails) || z.melding) { tel.fouten.push('zoeken:' + (z && z.melding ? 'melding' : 'geen_lijst')); mis = true; break; }
      for (const m of z.mails) if (m && typeof m.id === 'string') mails.set(m.id, m);
      if (z.mails.length >= 25) {
        for (const [a, b] of [[0, 7], [7, 14], [14, GRENS.dagen]]) {
          const q2 = lijstQuery(afz).replace(/ newer_than:\d+d$/, ' newer_than:' + b + 'd' + (a ? ' older_than:' + a + 'd' : ''));
          let z2;
          try { z2 = await io.luik({ actie: 'mail_zoeken', query: q2, account, max: 25 }); } catch (e) { tel.fouten.push('zoeken:' + foutSoort(e)); mis = true; break; }
          if (!z2 || !Array.isArray(z2.mails) || z2.melding) { tel.fouten.push('zoeken:melding'); mis = true; break; }
          if (z2.mails.length >= 25) tel.afgekapt = true;
          for (const m of z2.mails) if (m && typeof m.id === 'string') mails.set(m.id, m);
        }
      }
    }
    if (mis && !mails.size) continue;
    for (const m of [...mails.values()].sort((x, y) => String(x.datum_lokaal || '').localeCompare(String(y.datum_lokaal || '')))) {
      if (!m || typeof m.id !== 'string' || bekend.get(m.id)) continue;
      if (tel.berichten >= GRENS.berichten) { tel.later = (tel.later || 0) + 1; continue; }
      // alleen van de boekhouder zelf (de zoekvraag kan via een alias of een doorgestuurde kopie iets anders geven)
      if (!afz.some((a) => String(m.van || '').toLowerCase().includes(a))) continue;
      tel.berichten++;
      let lijst;
      try { lijst = await io.luik({ actie: 'mail_bijlage', id: m.id, account }); } catch (e) { tel.fouten.push('bijlagen:' + foutSoort(e)); continue; }
      if (!lijst || lijst.fout || !Array.isArray(lijst.bijlagen)) { tel.fouten.push('bijlagen:lijst'); continue; }
      const bijl = []; let stuk = false;
      for (const b of lijst.bijlagen.filter((x) => x && typeof x.naam === 'string' && /\.(xlsx|dat)$/i.test(x.naam)).slice(0, 6)) {
        let r;
        try { r = await io.luikBytes({ actie: 'mail_bijlage', id: m.id, naam: b.naam, account }); } catch (e) { stuk = true; break; }
        if (!r || !r.bytes) { stuk = true; break; }
        const bytes = Buffer.isBuffer(r.bytes) ? r.bytes : Buffer.from(r.bytes);
        if (bytes.length && bytes.length <= GRENS.bijlageBytes) bijl.push({ naam: b.naam, bytes });
      }
      if (stuk) { tel.fouten.push('bijlage'); continue; }   // volgende ronde opnieuw (er is nog niets vastgelegd)
      const lijsten = B.lijstenUitBijlagen(bijl);
      const wanneer = nuIso(o.klok());
      const basis = { message_id: kort(m.id, 200), draad_id: kort(m.thread_id, 200), account: accountNaam(account), ontvangen: kort(m.datum_lokaal || m.dag_lokaal, 40),
        aangemaakt_op: wanneer, bijgewerkt_op: wanneer };
      D.transactie(fdb, function () {
        if (bekend.get(m.id)) return;
        let nieuw = 0;
        for (const l of lijsten) {
          if (shaBekend.get(l.sha256)) { tel.dubbel++; continue; }   // dezelfde lijst nog eens gestuurd (of doorgestuurd): één keer verwerkt
          const id = D.nieuwId();
          if (!l.ok) {
            D.voegToe(fdb, 'bonjacht_lijst', Object.assign({ id, naam: kort(l.naam, 255), sha256: l.sha256, status: 'onleesbaar', reden: kort(l.reden, 200) }, basis));
            tel.onleesbaar++; nieuw++; continue;
          }
          const regels = B.koppelBank(l, q);
          const ents = regels.map((r) => r.entiteit).filter(Boolean);
          const entiteit = ents.length ? ents.sort((a, b) => ents.filter((x) => x === b).length - ents.filter((x) => x === a).length)[0] : null;
          D.voegToe(fdb, 'bonjacht_lijst', Object.assign({ id, naam: kort(l.naam, 255), sha256: l.sha256, entiteit, datum_lijst: kort(l.datum_lijst, 80), status: 'bezig' }, basis));
          for (const r of regels) {
            const invoer = { nr: r.nr, iban: r.iban, datum: r.datum, bedrag_centen: r.bedrag_centen, omschrijving: r.omschrijving, relatie: r.relatie, entiteit: r.entiteit,
              bank: r.bank, bank_status: r.bank_status, partij: r.partij, tokens: r.tokens, achter: r.achter || null, anker: r.anker || null };
            fdb.db.prepare('INSERT INTO bonjacht_regel (lijst, nr, datum, bedrag_centen, entiteit, transactie, partij, invoer, status, factuur, reden, bijgewerkt_op) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
              .run(id, r.nr, r.datum, r.bedrag_centen, r.entiteit || null, r.bank ? r.bank.id : null, kort(r.partij, 200), JSON.stringify(invoer),
                r.al_factuur ? 'al_in_facturen' : 'open', r.al_factuur || null, r.al_factuur ? 'de factuur staat al in Facturen' : null, wanneer);
          }
          D.audit(fdb, { wie: o.wie || 'koerier', wat: 'bonjacht_lijst', object_soort: 'bonjacht_lijst', object_id: id, entiteit, na: { regels: regels.length }, wanneer });
          tel.lijsten++; nieuw++;
        }
        // geen (nieuwe) lijst in dit bericht: één rij, zodat de volgende ronde hem niet opnieuw ophaalt
        if (!nieuw) D.voegToe(fdb, 'bonjacht_lijst', Object.assign({ id: D.nieuwId(), sha256: '', status: 'geen_lijst', reden: lijsten.length ? 'lijst al gelezen' : 'geen Exact-lijst in de bijlagen' }, basis));
      });
    }
  }
}

// ───────────────────────────── een gevonden bon klaarzetten ─────────────────────────────

/*
 * De gevonden mail wordt een bericht van de bron bonjacht met één of meer stukken (de pdf/UBL-bijlagen, of anders een pdf van de mail zelf),
 * door hetzelfde besliskader als elke factuur (F.verwerkBericht). Een factuur op te_beoordelen krijgt betaalwijze "al betaald" als voorstel, de
 * entiteit van de bankregel als die ontbreekt, het bedrag van de bank als het ontbreekt, en een besluitrij met de bron. → { factuur, al } of null.
 */
// Eén factuur uit een mail voor één post: precies één met het bedrag op de cent, of (zonder bedrag op de cent) de enige factuur. Een factuur die al
// bij een andere post hoort telt niet. Anders null (dan kiest David). review MOET 2.
function kiesFactuur(fdb, lijst, regel, rij) {
  const bezet = (id) => !!fdb.db.prepare("SELECT 1 FROM bonjacht_regel WHERE factuur = ? AND id <> ? AND status = 'gevonden'").get(id, rij.id);
  const vrij = lijst.filter((x) => !bezet(x.id));
  const raak = vrij.filter((x) => Number.isSafeInteger(x.incl) && x.incl === -regel.bedrag_centen);
  if (raak.length === 1) return raak[0];
  if (raak.length > 1) return null;
  return vrij.length === 1 && lijst.length === 1 ? vrij[0] : null;
}
async function zetKlaar(fdb, io, pdf, rij, regel, u, o) {
  const t = u.treffers[0];
  // review MOET 2: staat deze mail al in Facturen, kies dan de ene factuur die bij de post past (bedrag op de cent, of zonder bedrag bij één factuur)
  const al = fdb.db.prepare('SELECT f.id, f.incl, f.status FROM bericht b JOIN factuur f ON f.bericht = b.id WHERE b.message_id = ? ORDER BY f.aangemaakt_op').all(t.id);
  if (al.length) { const k = kiesFactuur(fdb, al, regel, rij); return k ? { factuur: k.id, al: true, status: k.status } : { factuur: null, al: true, meer: true }; }
  const account = luikAccount(t.account);
  const mail = await io.luik({ actie: 'mail_lezen', id: t.id, account });
  if (!mail || mail.fout) throw Object.assign(new Error('mail_lezen'), { code: 'mail_lezen' });
  const documenten = [];
  if (t.pdf) {
    for (const naam of (t.bijlagen || []).filter((n) => /\.(pdf|xml)$/i.test(n)).slice(0, 4)) {
      const r = await io.luikBytes({ actie: 'mail_bijlage', id: t.id, naam, account });
      if (!r || !r.bytes) continue;
      const bytes = Buffer.isBuffer(r.bytes) ? r.bytes : Buffer.from(r.bytes);
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) continue;
      const isPdf = bytes.subarray(0, 5).toString('latin1') === '%PDF-';
      const isXml = !isPdf && /^\s*(?:﻿)?</.test(bytes.subarray(0, 200).toString('utf8'));
      if (!isPdf && !isXml) continue;
      const doc = { naam: kort(naam, 255), mime: isPdf ? 'application/pdf' : 'application/xml', bytes: bytes.length, _bytes: bytes };
      if (isPdf) { const x = await pdf(bytes); doc.tekst = x.ok ? x.tekst : ''; doc.tekstlaag = !!(x.ok && x.tekstlaag); } else doc.ubl_xml = bytes.toString('utf8');
      doc.patientkenmerk_koerier = !!(doc.tekst && K.stapPatientkenmerk([doc.tekst]).kenmerk);
      documenten.push(doc);
    }
  }
  if (!documenten.length) {
    const van = kort(mail.van || t.van, 200), datum = kort(mail.datum_lokaal || t.dag, 40), onderwerp = kort(mail.onderwerp || t.onderwerp, 300);
    const tekst = String(mail.tekst || '').slice(0, 60000);
    const bytes = mailPdf({ van, datum, onderwerp, tekst }, { gemaakt: nuIso(o.klok()) });
    const vlak = 'Van: ' + (van || '') + '\nDatum: ' + (datum || '') + '\nOnderwerp: ' + (onderwerp || '') + '\n\n' + tekst;
    documenten.push({ naam: kort('Bon ' + (t.dag || regel.datum) + ' ' + (onderwerp || 'mail'), 120).replace(/[\\/:*?"<>|]+/g, ' ') + '.pdf', mime: 'application/pdf', bytes: bytes.length,
      _bytes: bytes, tekst: vlak, tekstlaag: true, patientkenmerk_koerier: !!K.stapPatientkenmerk([vlak]).kenmerk });
  }
  for (const d of documenten) { const st = D.stukSchrijf(fdb, d._bytes); d.sha256 = st.sha256; delete d._bytes; }
  const afzender = kort(mail.van || t.van, 320), onderwerp = kort(mail.onderwerp || t.onderwerp, 300);
  let uit = null;
  try {
    D.transactie(fdb, function () {
      const bron = bonjachtBron(fdb);
      if (fdb.db.prepare('SELECT 1 FROM bericht WHERE bron = ? AND message_id = ?').get(bron.id, t.id)) return;
      const id = D.nieuwId(), wanneer = nuIso(o.klok());
      D.voegToe(fdb, 'bericht', { id, bron: bron.id, message_id: kort(t.id, 200), draad_id: kort(mail.thread_id, 200), afzender, onderwerp,
        datum_lokaal: kort(mail.datum_lokaal || t.dag, 40), bron_link: account ? null : 'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(String(t.id).slice(0, 100)), ontvangen_op: wanneer });
      const v = F.verwerkBericht(fdb, { bericht: { id, message_id: t.id, afzender, onderwerp }, documenten }, { wie: o.wie || 'koerier', nu: o.klok() });
      const rijen = v.facturen.map((x) => Object.assign({}, x, { incl: (fdb.db.prepare('SELECT incl FROM factuur WHERE id = ?').get(x.id) || {}).incl }));
      const f = kiesFactuur(fdb, rijen.filter((x) => x.status === 'te_beoordelen' || x.status === 'geen_factuur'), regel, rij);
      if (!f) { uit = rijen.length ? { factuur: null, al: false, meer: rijen.length > 1 } : null; return; }
      uit = { factuur: f.id, al: false, status: f.status };
      // droogproef 24-11 (Compex, orderbevestiging): het besliskader zag "geen factuur" (nieuwsbrief zonder factuurwoord). Hier vroeg de
      // boekhouder er zelf om: zelfde overgang als Davids knop "Toch een factuur" (kern: geen_factuur → toch_factuur → te_beoordelen), met de reden erbij.
      if (f.status === 'geen_factuur' && K.statusOvergang('geen_factuur', 'toch_factuur', {}).ok) {
        const oud = fdb.db.prepare('SELECT redenen FROM factuur WHERE id = ?').get(f.id);
        const red = ['Bon voor de lijst van de boekhouder (het besliskader zag geen factuur)'].concat(json(oud && oud.redenen, []) || []).slice(0, 20);
        fdb.db.prepare("UPDATE factuur SET status = 'te_beoordelen', redenen = ?, bijgewerkt_op = ? WHERE id = ? AND status = 'geen_factuur'").run(JSON.stringify(red), wanneer, f.id);
        D.voegToe(fdb, 'besluit', { factuur: f.id, stap: 'geen_factuur', veld: 'is_factuur', waarde: '1', bron: 'bank', toelichting: 'bonjacht: post op de lijst van de boekhouder, dus wel een bon', wanneer });
        D.audit(fdb, { wie: o.wie || 'koerier', wat: 'bonjacht_toch_factuur', object_soort: 'factuur', object_id: f.id, voor: { status: 'geen_factuur' }, na: { status: 'te_beoordelen' }, wanneer });
        uit.status = 'te_beoordelen';
      }
      if (uit.status !== 'te_beoordelen') return;
      const bank = regel.bank ? fdb.db.prepare('SELECT t.boekdatum, t.entiteit, t.bedrag_centen FROM bank_transactie t WHERE t.id = ?').get(regel.bank.id) : null;
      fdb.db.prepare("UPDATE factuur SET betaalwijze = 'betaald', entiteit = coalesce(entiteit, ?), incl = coalesce(incl, ?), incl_eur = coalesce(incl_eur, CASE WHEN valuta = 'EUR' THEN coalesce(incl, ?) END), " +
        "bijgewerkt_op = ? WHERE id = ? AND status = 'te_beoordelen'").run(regel.entiteit || null, -regel.bedrag_centen, -regel.bedrag_centen, wanneer, f.id);
      D.voegToe(fdb, 'besluit', { factuur: f.id, stap: 'betaalwijze', veld: 'betaalwijze', waarde: 'betaald', bron: 'bank',
        toelichting: kort('bonjacht: post van de lijst van de boekhouder (' + regel.datum + ', € ' + (Math.abs(regel.bedrag_centen) / 100).toFixed(2).replace('.', ',') + ')' +
          (bank ? ', bankregel ' + bank.boekdatum : '') + (regel.achter ? ', via ' + (regel.achter.partij ? 'PayPal' : 'betaaldienst') : '') + '; zekerheid ' + (u.zekerheid || 'middel'), 500), wanneer });
    });
  } finally { for (const d of documenten) { d.tekst = null; d.ubl_xml = null; } }
  return uit;
}

// ───────────────────────────── de posten afwerken ─────────────────────────────

async function regelsAfwerken(fdb, io, pdf, o, tel, t0) {
  const afz = afzenders(fdb);
  const rijen = fdb.db.prepare("SELECT r.* FROM bonjacht_regel r JOIN bonjacht_lijst l ON l.id = r.lijst WHERE r.status IN ('open','fout') AND r.pogingen < ? " +
    "ORDER BY r.status = 'fout', l.aangemaakt_op, r.nr LIMIT ?").all(GRENS.pogingen, GRENS.regels);
  for (const rij of rijen) {
    if (o.klok() - t0 > GRENS.ms) { tel.budget_op = true; break; }
    const regel = json(rij.invoer, null);
    if (!regel) continue;
    let u;
    try { u = await B.zoekRegel(regel, io, { afzenders: afz.concat(['actasynergia.nl']) }); } catch (e) { u = { status: 'fout', fout: foutSoort(e), treffers: [] }; }
    const wanneer = nuIso(o.klok());
    if (u.status === 'fout') {
      fdb.db.prepare("UPDATE bonjacht_regel SET status = 'fout', pogingen = pogingen + 1, reden = ?, bijgewerkt_op = ? WHERE id = ?").run('zoeken in de mail lukte niet; volgt opnieuw', wanneer, rij.id);
      tel.fout++; continue;
    }
    let factuur = null, reden = null, status = u.status;
    if (u.status === 'gevonden') {
      try {
        const k = await zetKlaar(fdb, io, pdf, rij, regel, u, o);
        if (k && k.meer) { status = 'kandidaten'; reden = 'die mail heeft meer facturen: kies zelf'; }
        else if (k && k.factuur) { factuur = k.factuur; if (k.al) reden = 'de bon stond al in Facturen'; else if (k.status === 'te_beoordelen') tel.klaargezet++; else reden = 'gevonden; staat in Facturen als ' + String(k.status).replace(/_/g, ' '); }
        else if (!k || !k.factuur) reden = 'gevonden, maar niet als factuur te lezen';
      }
      catch (e) {
        fdb.db.prepare("UPDATE bonjacht_regel SET status = 'fout', pogingen = pogingen + 1, reden = ?, bijgewerkt_op = ? WHERE id = ?").run('bon gevonden, klaarzetten lukte niet; volgt opnieuw', wanneer, rij.id);
        tel.fout++; continue;
      }
      tel.gevonden++;
    } else if (u.status === 'kandidaten') { tel.kandidaten++; reden = 'meer mails met dit bedrag: kies zelf'; }
    else { tel.niet_gevonden++; reden = B.redenNiet(regel); }
    const treffers = (u.treffers || []).map((x) => ({ id: x.id, account: x.account, dag: x.dag, van: x.van, onderwerp: x.onderwerp, bijlagen: x.bijlagen, pdf: !!x.pdf }));
    fdb.db.prepare('UPDATE bonjacht_regel SET status = ?, zekerheid = ?, treffers = ?, factuur = ?, reden = ?, pogingen = pogingen + 1, bijgewerkt_op = ? WHERE id = ?')
      .run(status, u.zekerheid || null, JSON.stringify(treffers), factuur, kort(reden, 300), wanneer, rij.id);
  }
  // een lijst zonder open posten is klaar; aantallen per status
  for (const l of fdb.db.prepare("SELECT id FROM bonjacht_lijst WHERE status = 'bezig'").all()) {
    const n = {}; for (const x of fdb.db.prepare('SELECT status, count(*) AS n FROM bonjacht_regel WHERE lijst = ? GROUP BY status').all(l.id)) n[x.status] = Number(x.n);
    const open = Number(fdb.db.prepare("SELECT count(*) AS n FROM bonjacht_regel WHERE lijst = ? AND (status = 'open' OR (status = 'fout' AND pogingen < ?))").get(l.id, GRENS.pogingen).n);
    fdb.db.prepare('UPDATE bonjacht_lijst SET aantallen = ?, status = ?, bijgewerkt_op = ? WHERE id = ?').run(JSON.stringify(n), open ? 'bezig' : 'klaar', nuIso(o.klok()), l.id);
  }
}

/*
 * ronde(fdb, io, o) — één keer per koerier-ronde. io = { luik, luikBytes } (zoals de koerier), o = { klok, wie, pdf }. Uit (meta bonjacht_uit
 * = '1'): niets. → { ok, aantallen } (alleen aantallen en foutsoorten; nooit inhoud).
 */
async function ronde(fdb, io, o) {
  o = o || {};
  if (D.metaLees(fdb, 'bonjacht_uit') === '1') return { ok: true, aan: false };
  const klok = typeof o.klok === 'function' ? o.klok : () => Date.now();
  const oo = Object.assign({}, o, { klok });
  const lio = { luik: (b) => io.luik(b, { timeoutMs: GRENS.luikMs }), luikBytes: (b) => io.luikBytes(b) };
  const tel = { berichten: 0, lijsten: 0, dubbel: 0, onleesbaar: 0, gevonden: 0, klaargezet: 0, kandidaten: 0, niet_gevonden: 0, fout: 0, fouten: [] };
  const t0 = klok();
  await lijstenLezen(fdb, lio, oo, tel);
  await regelsAfwerken(fdb, lio, o.pdf, oo, tel, t0);
  const ok = !tel.fouten.length;
  const fouten = tel.fouten.slice(0, 5); delete tel.fouten;
  D.metaZet(fdb, 'bonjacht_ronde', JSON.stringify({ op: nuIso(t0), eind: nuIso(klok()), ok, fouten, aantallen: tel }));
  return { ok, aantallen: tel, fouten };
}

module.exports = { ronde, mailPdf, qVoor, lijstQuery, afzenders, GRENS, AFZENDERS, _intern: { lijstenLezen, regelsAfwerken, zetKlaar } };
