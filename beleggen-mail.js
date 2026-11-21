'use strict';
// wv3758 (besluitenpagina nr 912 = L12, David Ja 21-11-2026 13:19, met vingerafdruk): Beleggen zonder huiswerk.
// Ontwerp + review: mk-scripts/wv3758/ontwerp.md. Alleen lezen: Davids mail via het lees-luik (deps.luik), nooit inloggen bij DEGIRO, nooit handelen,
// niets naar buiten. Drie stukken:
//  1. mailronde: transactiebevestigingen van DEGIRO → één CSV-regel met exact de kopregel van de transacties-export → de BESTAANDE invoer
//     (POST /app/beleggen/bestand, leesBestand met al zijn rekencontroles). Zelfde transactiesleutel als de latere export, dus nooit dubbel.
//     Wat niet te lezen is: uitkomst 'fout' in tabel mailtx + signaal in het scherm; nooit raden.
//  2. ochtendvraag: de ochtend na een aankoop één bericht in het gesprek ("Je kocht gisteren X. Waarom?"), via deps.bericht.
//  3. info voor /health: alleen aantallen.
// Log: alleen aantallen en uitkomsten (geen productnamen, bedragen of mailinhoud).

const KOP = 'Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,,Lokale waarde,,Waarde EUR,Wisselkoers,AutoFX Kosten,Transactiekosten en/of kosten van derden EUR,Totaal EUR,Order ID';
const ONDERWERP_RE = /^DEGIRO - Transactiebevestiging:/;
const AFZENDER_RE = /@degiro\.nl>?\s*$/i;
const MAANDEN = { jan: 1, feb: 2, mrt: 3, maa: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };
const QUERY = 'from:degiro.nl subject:Transactiebevestiging';
const TABEL = `CREATE TABLE IF NOT EXISTS mailtx (gmail_id TEXT PRIMARY KEY, mail_datum TEXT, uitkomst TEXT NOT NULL CHECK (uitkomst IN ('nieuw','bekend','fout')),
  reden TEXT, transactie_datum TEXT, op TEXT NOT NULL, gezien_op TEXT)`;

class MailFout extends Error { constructor(reden) { super(reden); this.reden = reden; } }

// tekst uit het lees-luik → platte regels; de velden staan in één doorlopende reeks "Sleutel waarde Sleutel waarde …"
function plat(t) { return String(t || '').replace(/\[[^\]]*\]/g, ' ').replace(/\(https?:[^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(); }
const GETAL = '-?\\d{1,3}(?:\\.\\d{3})*(?:,\\d+)?|-?\\d+(?:,\\d+)?';
function pak(t, re, reden) { const m = t.match(re); if (!m) throw new MailFout(reden); return m; }
function csvVeld(s) { s = String(s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
const zonderDuizend = (g) => String(g).replace(/\.(?=\d{3}(\D|$))/g, '');

// Eén transactiebevestiging → { csv, order, datum }. Gooit MailFout(reden) met alleen een veldnaam als reden.
function mailNaarCsv(m) {
  if (!ONDERWERP_RE.test(String(m.onderwerp || ''))) throw new MailFout('onderwerp');
  if (!AFZENDER_RE.test(String(m.van || ''))) throw new MailFout('afzender');
  const t = plat(m.tekst);
  if (!/De volgende order is uitgevoerd/i.test(t)) throw new MailFout('geen uitgevoerde order');
  if ((t.match(/OrderID /g) || []).length !== 1) throw new MailFout('niet precies één order');
  const product = pak(t, /order is uitgevoerd:\s*(.+?)\s+OrderID /i, 'product')[1].trim();
  const order = pak(t, /OrderID ([0-9a-f-]{36}) /i, 'order id')[1].toLowerCase();
  const dm = pak(t, /Transactiedatum (\d{1,2}) ([a-z]{3})[a-z]*\.? (\d{4}),? (\d{2}):(\d{2})(?::(\d{2}))? /i, 'transactiedatum');
  const maand = MAANDEN[dm[2].toLowerCase()];
  if (!maand) throw new MailFout('transactiedatum');
  const datum = String(dm[1]).padStart(2, '0') + '-' + String(maand).padStart(2, '0') + '-' + dm[3];
  const tijd = dm[4] + ':' + dm[5];   // de export heeft hh:mm (gemeten 21-11 op Davids echte export)
  const isin = pak(t, / ISIN ([A-Z]{2}[A-Z0-9]{9}\d) /, 'isin')[1];
  const opdracht = pak(t, / Opdracht (Koop|Verkoop) /, 'opdracht')[1];
  const beurs = pak(t, / Beurs ([A-Z0-9]{2,8}) /, 'beurs')[1];
  const plaats = (t.match(/ Handelsplaats ([A-Z0-9]{2,8}) /) || [])[1] || '';
  const aantal = pak(t, new RegExp(' Aantal (' + GETAL + ') '), 'aantal')[1];
  const koers = pak(t, new RegExp(' Koers ([A-Z]{3}) (' + GETAL + ') '), 'koers');
  const lokaal = pak(t, new RegExp(' Lokale waarde ([A-Z]{3}) (' + GETAL + ') '), 'lokale waarde');
  const waarde = pak(t, new RegExp(' Waarde EUR (' + GETAL + ') '), 'waarde')[1];
  const wk = (t.match(new RegExp(' Wisselkoers (' + GETAL + ') ')) || [])[1] || '';
  const autofx = (t.match(new RegExp(' AutoFX kosten EUR (' + GETAL + ') ')) || [])[1] || '';
  const kosten = (t.match(new RegExp(' Transactiekosten en/of kosten van derden EUR (' + GETAL + ') ')) || [])[1] || '';
  const totaal = pak(t, new RegExp(' Totaal EUR (' + GETAL + ')(?: |$)'), 'totaal')[1];
  if (/^-/.test(aantal)) throw new MailFout('aantal');
  // export: koop = positief aantal en negatieve bedragen, verkoop = negatief aantal; de bedragen staan in de mail al met hun teken
  const n = zonderDuizend(aantal);
  const rij = [datum, tijd, product, isin, beurs, plaats, opdracht === 'Verkoop' ? '-' + n : n, zonderDuizend(koers[2]), koers[1],
    zonderDuizend(lokaal[2]), lokaal[1], zonderDuizend(waarde), wk ? zonderDuizend(wk) : '', autofx ? zonderDuizend(autofx) : '', kosten ? zonderDuizend(kosten) : '',
    zonderDuizend(totaal), order];
  return { csv: KOP + '\n' + rij.map(csvVeld).join(',') + '\n', order, datum: dm[3] + '-' + String(maand).padStart(2, '0') + '-' + String(dm[1]).padStart(2, '0') };
}

function maak(deps) {
  const B = deps.beleggen;
  const klok = deps.klok || ((d) => { const s = (d || new Date()).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }); return { datum: s.slice(0, 10), uur: Number(s.slice(11, 13)), min: Number(s.slice(14, 16)) }; });
  const log = deps.log || (() => {});
  const nu = deps.nu || (() => new Date());
  let tabelKlaar = false;
  function db(f, schrijf) {
    return B.metDb((d) => {
      if (!d) return f(null);
      if (!tabelKlaar && schrijf) { d.exec(TABEL); tabelKlaar = true; }
      if (!schrijf && !d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mailtx'").get()) return f(null);
      return f(d);
    }, schrijf);
  }
  function meta(sleutel, waarde) {
    if (waarde === undefined) return B.metDb((d) => (d ? (d.prepare('SELECT waarde FROM meta WHERE sleutel = ?').get(sleutel) || {}).waarde || null : null), false);
    return B.metDb((d) => { d.prepare('INSERT INTO meta (sleutel, waarde) VALUES (?, ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde').run(sleutel, waarde); }, true);
  }
  const gmailDag = (iso) => iso.replace(/-/g, '/');
  function plus(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

  // ── 1. mailronde ──
  async function mailRonde() {
    const k = klok(nu());
    const laatste = meta('mail_ronde_op');   // NL-datum van de laatste geslaagde ronde
    const van = laatste ? plus(laatste, -2) : plus(k.datum, -30);
    // review MOET 1: het lees-luik geeft hooguit 25 treffers. Vol venster = opnieuw per dag; een vol dagvenster = ronde niet af (geen stempel)
    const zoek = async (q) => {
      let j;
      try { j = await deps.luik({ actie: 'mail_zoeken', query: q, max: 25 }); } catch (e) { return { fout: 'zoekfout' }; }
      if (!j || !Array.isArray(j.mails) || j.fout || j.melding) return { fout: 'luikmelding' };
      return { mails: j.mails };
    };
    let z = await zoek(QUERY + ' after:' + gmailDag(van));
    if (z.fout) { log({ ronde: 'mail', uitkomst: z.fout }); return { ok: false, reden: z.fout }; }   // geen stempel: volgende ronde opnieuw
    let vol = false;
    if (z.mails.length >= 25) {
      const alle = new Map();
      for (let d = plus(van, 1); d <= plus(k.datum, 1); d = plus(d, 1)) {   // Gmail after: is exclusief van de dag zelf niet; ruim per dag
        const w = await zoek(QUERY + ' after:' + gmailDag(plus(d, -1)) + ' before:' + gmailDag(plus(d, 1)));
        if (w.fout) { log({ ronde: 'mail', uitkomst: w.fout }); return { ok: false, reden: w.fout }; }
        if (w.mails.length >= 25) vol = true;
        for (const m of w.mails) if (m && m.id) alle.set(String(m.id), m);
      }
      z = { mails: Array.from(alle.values()) };
    }
    const j = z;
    const gezien = new Set(db((d) => (d ? d.prepare('SELECT gmail_id FROM mailtx').all().map((r) => r.gmail_id) : []), false));
    const tel = { treffers: j.mails.length, nieuw: 0, bekend: 0, fout: 0, overgeslagen: 0, leesfout: 0, vol: vol ? 1 : 0 };
    for (const m of j.mails) {
      if (!m || !m.id || gezien.has(String(m.id))) continue;
      if (!ONDERWERP_RE.test(String(m.onderwerp || '')) || !AFZENDER_RE.test(String(m.van || ''))) { tel.overgeslagen++; continue; }
      let g;
      try { g = await deps.luik({ actie: 'mail_lezen', id: String(m.id) }); } catch (e) { tel.leesfout++; continue; }
      if (!g || g.fout || typeof g.tekst !== 'string') { tel.leesfout++; continue; }   // volgende ronde opnieuw
      const u = verwerk({ id: String(m.id), datum: g.datum || m.datum, onderwerp: g.onderwerp || m.onderwerp, van: g.van || m.van, tekst: g.tekst });
      tel[u.uitkomst]++;
    }
    // een treffer die niet gelezen kon worden = ronde niet af (geen stempel), anders schuift het venster eroverheen
    if (!tel.leesfout && !vol) meta('mail_ronde_op', k.datum);
    meta('mail_ronde_poging', nu().toISOString());
    log(Object.assign({ ronde: 'mail' }, tel));
    return Object.assign({ ok: true }, tel);
  }
  // één gelezen mail → transactie (via de bestaande invoer) of 'fout'; schrijft altijd één rij in mailtx
  function verwerk(m) {
    const op = nu().toISOString();
    let uitkomst, reden = null, tdatum = null;
    try {
      const c = mailNaarCsv(m);
      tdatum = c.datum;
      const u = B.app({ pad: '/app/beleggen/bestand', methode: 'POST', body: { naam: 'mail:' + m.id, tekst: c.csv, bewaar: true } });
      if (u.status !== 200 || !u.body || !u.body.ok) { uitkomst = 'fout'; reden = 'controle: ' + String((u.body && u.body.kolom) || (u.body && u.body.fout) || u.status).slice(0, 60); }
      else uitkomst = u.body.nieuw > 0 ? 'nieuw' : 'bekend';
    } catch (e) {
      if (!(e instanceof MailFout)) throw e;
      uitkomst = 'fout'; reden = 'veld: ' + e.reden;
    }
    const md = m.datum ? String(m.datum).slice(0, 10) : null;
    db((d) => { d.prepare('INSERT OR REPLACE INTO mailtx (gmail_id, mail_datum, uitkomst, reden, transactie_datum, op) VALUES (?, ?, ?, ?, ?, ?)').run(m.id, md, uitkomst, reden, tdatum, op); }, true);
    return { uitkomst, reden };
  }

  // ── 2. ochtendvraag: de ochtend na een aankoop (of verkoop) één vraag in het gesprek, alleen 08:00–21:00, één keer per dag ──
  async function ochtendvraag() {
    const k = klok(nu());
    if (k.uur < 8 || k.uur >= 21) return { ok: true, reden: 'buiten de uren' };
    if (meta('ochtendvraag_dag') === k.datum) return { ok: true, reden: 'al gevraagd' };
    const gisteren = plus(k.datum, -1), vorige = meta('ochtendvraag_tot') || plus(k.datum, -3);
    const g = B.gesprek({ opdracht: 'dagboek-open' });
    if (!g || g.status !== 200 || !g.body || !Array.isArray(g.body.open)) return { ok: false, reden: 'dagboek' };
    const open = g.body.open.filter((x) => x.datum > vorige && x.datum <= gisteren && x.datum >= plus(k.datum, -3));
    if (!open.length) return { ok: true, reden: 'niets' };
    const tekst = vraagTekst(open, k.datum);
    const r = await deps.bericht(tekst, 'beleggen-waarom:' + k.datum);
    if (!r || !r.ok) { log({ ronde: 'ochtendvraag', uitkomst: 'bericht faalde' }); return { ok: false, reden: 'bericht' }; }
    meta('ochtendvraag_dag', k.datum); meta('ochtendvraag_tot', gisteren);
    log({ ronde: 'ochtendvraag', groepen: open.length });
    return { ok: true, groepen: open.length };
  }
  function vraagTekst(open, vandaag) {
    const dag = (iso) => (iso === plus(vandaag, -1) ? 'gisteren' : 'op ' + Number(iso.slice(8, 10)) + '-' + Number(iso.slice(5, 7)));
    const werk = (x) => (x.richting === 'verkoop' ? 'verkocht' : 'kocht');
    if (open.length === 1) { const x = open[0]; return 'Je ' + werk(x) + ' ' + dag(x.datum) + ' ' + x.naam + '. Waarom? Zeg het in één zin, dan zet ik het in je beleggingsdagboek.'; }
    const delen = open.slice(0, 4).map((x) => x.naam + ' (' + werk(x) + ' ' + dag(x.datum) + ')');
    return 'Je handelde ' + (open.length > 4 ? 'onder meer ' : '') + delen.join(', ') + '. Waarom? Zeg per aandeel één zin, dan zet ik het in je beleggingsdagboek.';
  }

  // ── tik (elke 5 min vanuit server.js): mailronde hooguit eens per 60 min tussen 07 en 23, daarna de ochtendvraag ──
  let bezig = false;
  async function tik() {
    if (bezig) return null;
    bezig = true;
    try {
      const k = klok(nu());
      const uit = {};
      const poging = meta('mail_ronde_poging');
      if (k.uur >= 7 && k.uur < 23 && (!poging || nu() - new Date(poging) >= 55 * 60000)) uit.mail = await mailRonde();
      uit.vraag = await ochtendvraag();
      return uit;
    } finally { bezig = false; }
  }
  function info() {
    return db((d) => {
      if (!d) return { aan: true, mails: 0, nieuw: 0, bekend: 0, fout: 0, ronde_op: meta('mail_ronde_op'), vraag_dag: meta('ochtendvraag_dag') };
      const per = Object.fromEntries(d.prepare('SELECT uitkomst, COUNT(*) AS n FROM mailtx GROUP BY uitkomst').all().map((r) => [r.uitkomst, r.n]));
      return { aan: true, mails: (per.nieuw || 0) + (per.bekend || 0) + (per.fout || 0), nieuw: per.nieuw || 0, bekend: per.bekend || 0, fout: per.fout || 0,
        ronde_op: meta('mail_ronde_op'), vraag_dag: meta('ochtendvraag_dag') };
    }, false);
  }
  return { tik, mailRonde, verwerk, ochtendvraag, info, _vraagTekst: vraagTekst };
}

module.exports = { maak, mailNaarCsv, MailFout, KOP, QUERY };
