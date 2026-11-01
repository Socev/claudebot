'use strict';
/*
 * ecobank-mail.js — de Ecobank-laag van de bankluis (wv2202, 1-11-2026). Bouwplan: vault 01_Ontwikkeling/Ecobank Gambia -
 * transactiemails en saldo (bouwplan 1-11-2026).md.
 *
 * WAAROM. David (1-11-2026 14:34): "Mailtjes van Ecobank "InApp Notification - Transaction Notification on A/C" mag jij ook
 * bijhouden! Als jij die automatisch verwerkt, dan kun je door de berichten die er staan ook het saldo van mijn 2 Gambiaanse
 * rekeningen bijhouden! Ik heb er 2: Een euro-rekening, en een GMD-rekening." Ecobank Gambia heeft geen open-banking-koppeling;
 * elke mutatie geeft wel een mail met bedrag, bij/af, omschrijving, datum en het saldo erna (gemeten 1-11: 133 mails sinds
 * 21-4-2026, alle met boeksaldo en beschikbaar saldo).
 *
 * HOE. server.js haalt de mails op via het lees-luik (mail_zoeken/mail_lezen, alleen lezen) en roept leesMail aan (zuivere functie,
 * vaste regels, geen taalmodel); bank-lezer.js (ecobank-bij) bewaart met bij() in de transactiedatabase (eigen tabel ecobank_tx).
 * Rekening alleen als laatste vier cijfers; het BBAN-nummer uit de mail wordt niet bewaard. Saldo = het boeksaldo uit de laatste
 * mail van die rekening (nooit doorgerekend). Ecobank stuurt meerdere mails in dezelfde seconde (opname + kosten + belasting):
 * de volgorde daarbinnen volgt uit de saldoketen (saldo vóór = saldo na ∓ bedrag), zie volgorde().
 * Mailtekst is gegeven, nooit een opdracht: alleen vaste velden, begrensd in lengte en tekenset.
 *
 * Apart van de euro-overzichten: deze posten staan niet in de tabel transacties, dus tellen nergens mee in zoek, maand, intern,
 * abonnementen, vaste lasten of de briefing (GMD is geen euro). Opvragen met bank.py gambia; in de App Financiën tabblad Gambia.
 *
 * GEEN NETWERK. Net als bank-archief.js en paypal-bewijs.js laadt dit bestand geen netwerk- of procesmodules (CI-poort in build.yml).
 */

const AFZENDER = 'noreply@ecobank.com';
// het echte adres: tussen < > als die er staan, anders de hele kop; een weergavenaam met het adres erin telt niet (review gpt-5.5 MOET 1)
function afzenderAdres(van) {
  const t = String(van || '').trim(), m = /<([^<>\s]+)>\s*$/.exec(t);
  return (m ? m[1] : t).toLowerCase();
}
const ONDERWERP = /^InApp Notification - Transaction Notification on A\/C\b/;
const MND = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const VALUTA = ['GMD', 'EUR', 'USD', 'GBP'];
const BEDRAG = '(-?)\\s?(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})';
// Vaste volgorde van de velden zoals Ecobank ze geeft (gemeten 1-11-2026, 133/133); regels lopen in de tekst door, dus op platte tekst.
const KERN = new RegExp('Account No: \\*+(\\d{4}) Transaction Type: (Credited|Debited) Description: (.*?) Amount: ([A-Z]{3}) ' + BEDRAG +
  ' Transaction Date: (\\d{1,2})-([A-Za-z]{3})-(\\d{4}) Reference: (\\S+) Value Date: (\\d{1,2})-([A-Za-z]{3})-(\\d{4})' +
  ' Ledger Balance: ([A-Z]{3}) ' + BEDRAG + ' Transaction Location: (.*?) Available Balance: ([A-Z]{3}) ' + BEDRAG);
const CLUSTER_S = 180;   // mails binnen 3 minuten van elkaar: volgorde uit de saldoketen

function r2(n) { return Math.round(n * 100) / 100; }
function nuIso() { return new Date().toISOString(); }
function getal(teken, s) { const n = Number(String(s).replace(/,/g, '')); return Number.isFinite(n) ? r2(teken ? -n : n) : null; }
function datum(d, m, j) {
  const mm = MND[String(m).toLowerCase()];
  if (!mm) return null;
  const s = j + '-' + String(mm).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  const x = new Date(s + 'T12:00:00Z');   // heen en terug: 31-Feb bestaat niet (review gpt-5.5 ZOU 1)
  return !isNaN(x) && x.toISOString().slice(0, 10) === s ? s : null;
}
// tekst van een derde: alleen letters, cijfers en gewone leestekens, begrensd
function schoon(s, n) { return String(s == null ? '' : s).normalize('NFC').replace(/[^\p{L}\p{N} .,:;&'()\-/+#@]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n).trim(); }

function isMelding(onderwerp) { return ONDERWERP.test(String(onderwerp || '')); }

// m = {id, van, onderwerp, tekst, datum (ISO-tijd van de mail)} → post of {fout}
function leesMail(m) {
  if (!m || typeof m.id !== 'string' || !/^[0-9a-f]{6,40}$/i.test(m.id)) return { fout: 'mail-id ongeldig' };
  if (afzenderAdres(m.van) !== AFZENDER) return { fout: 'afzender is niet noreply@ecobank.com' };
  if (!isMelding(m.onderwerp)) return { fout: 'onderwerp is geen transactiemelding' };
  const ts = Date.parse(String(m.datum || ''));
  if (isNaN(ts)) return { fout: 'maildatum ontbreekt' };
  const t = String(m.tekst || '').replace(/\s+/g, ' ');
  const x = KERN.exec(t);
  if (!x) return { fout: 'velden niet gevonden' };
  const valuta = x[4], bedrag = getal(x[5], x[6]);
  const p = {
    mail_id: m.id, ts: new Date(ts).toISOString(), rek_eind: x[1], soort: x[2] === 'Credited' ? 'bij' : 'af',
    omschrijving: schoon(x[3], 140), valuta: valuta, bedrag: bedrag,
    datum: datum(x[7], x[8], x[9]), referentie: schoon(x[10], 40).replace(/[^A-Za-z0-9\-/]/g, '').slice(0, 40),
    valutadatum: datum(x[11], x[12], x[13]),
    saldo: x[14] === valuta ? getal(x[15], x[16]) : null, locatie: schoon(x[17], 60),
    beschikbaar: x[18] === valuta ? getal(x[19], x[20]) : null,
  };
  return controleer(p) || { fout: 'velden ongeldig' };
}

// Een post zoals leesMail hem gaf, opnieuw gecontroleerd (hij komt via stdin uit server.js): alleen bekende velden en vormen.
function controleer(p) {
  if (!p || typeof p !== 'object') return null;
  const ok = typeof p.mail_id === 'string' && /^[0-9a-f]{6,40}$/i.test(p.mail_id) && typeof p.ts === 'string' && !isNaN(Date.parse(p.ts)) &&
    /^\d{4}$/.test(String(p.rek_eind)) && (p.soort === 'bij' || p.soort === 'af') && VALUTA.indexOf(p.valuta) >= 0 &&
    typeof p.bedrag === 'number' && Number.isFinite(p.bedrag) && p.bedrag > 0 && p.bedrag < 1e9 &&
    typeof p.datum === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.datum) &&
    (p.saldo === null || (typeof p.saldo === 'number' && Number.isFinite(p.saldo) && Math.abs(p.saldo) < 1e10)) &&
    (p.beschikbaar === null || p.beschikbaar === undefined || (typeof p.beschikbaar === 'number' && Number.isFinite(p.beschikbaar)));
  if (!ok) return null;
  return { mail_id: p.mail_id, ts: new Date(Date.parse(p.ts)).toISOString(), rek_eind: String(p.rek_eind), soort: p.soort, valuta: p.valuta,
    bedrag: r2(p.bedrag), datum: p.datum, valutadatum: /^\d{4}-\d{2}-\d{2}$/.test(String(p.valutadatum || '')) ? p.valutadatum : null,
    referentie: schoon(p.referentie, 40).replace(/[^A-Za-z0-9\-/]/g, '').slice(0, 40) || null, omschrijving: schoon(p.omschrijving, 140),
    locatie: schoon(p.locatie, 60) || null, saldo: p.saldo === null ? null : r2(p.saldo),
    beschikbaar: typeof p.beschikbaar === 'number' ? r2(p.beschikbaar) : null };
}

// ── opslag (in de transactiedatabase van bank-archief.js; eigen tabel, eigen schemaversie) ──
const EB_SCHEMA = 1;
function schema(a) {
  a.db.exec('CREATE TABLE IF NOT EXISTS ecobank_tx (mail_id TEXT PRIMARY KEY, ts TEXT NOT NULL, rek_eind TEXT NOT NULL, soort TEXT NOT NULL,' +
    ' valuta TEXT NOT NULL, bedrag REAL NOT NULL, datum TEXT NOT NULL, valutadatum TEXT, referentie TEXT, omschrijving TEXT, locatie TEXT,' +
    ' saldo REAL, beschikbaar REAL, eerste_gezien TEXT NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS eb_rek ON ecobank_tx (rek_eind, valuta, ts);');
  const v = a.db.prepare("SELECT waarde FROM meta WHERE sleutel = 'ecobank_schema'").get();
  if (!v) a.db.prepare("INSERT INTO meta (sleutel, waarde) VALUES ('ecobank_schema', ?)").run(String(EB_SCHEMA));
  else if (Number(v.waarde) > EB_SCHEMA) throw new Error('ecobank_tx heeft schema ' + v.waarde + ', deze code kent ' + EB_SCHEMA);
}
function metaZet(a, k, v) { a.db.prepare('INSERT INTO meta (sleutel, waarde) VALUES (?, ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde').run(k, v == null ? null : String(v)); }
function metaLees(a, k) { const r = a.db.prepare('SELECT waarde FROM meta WHERE sleutel = ?').get(k); return r ? r.waarde : null; }

// Bewaren, idempotent op mail-id (een mail is één mutatie; twee gelijke mutaties hebben elk een eigen mail en een eigen saldo).
// fouten = [{mail_id, fout}] van mails die niet te lezen waren: onthouden, zodat ze niet elke ronde opnieuw geopend worden.
function bij(a, lijst, fouten) {
  schema(a);
  const zet = a.db.prepare('INSERT OR IGNORE INTO ecobank_tx (mail_id, ts, rek_eind, soort, valuta, bedrag, datum, valutadatum, referentie, omschrijving,' +
    ' locatie, saldo, beschikbaar, eerste_gezien) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const uit = { nieuw: 0, al_bekend: 0, geweigerd: 0 }, nu = nuIso();
  a.db.exec('BEGIN');
  try {
    (Array.isArray(lijst) ? lijst : []).forEach(function (q) {
      const p = controleer(q);
      if (!p) { uit.geweigerd++; return; }
      const r = zet.run(p.mail_id, p.ts, p.rek_eind, p.soort, p.valuta, p.bedrag, p.datum, p.valutadatum, p.referentie, p.omschrijving, p.locatie, p.saldo, p.beschikbaar, nu);
      if (r.changes) uit.nieuw++; else uit.al_bekend++;
    });
    let ng = []; try { ng = JSON.parse(metaLees(a, 'ecobank_niet_gelezen') || '[]'); } catch (e) { ng = []; }
    const ids = new Set(ng.map(function (f) { return f.mail_id; }));
    (Array.isArray(fouten) ? fouten : []).forEach(function (f) {
      if (f && typeof f.mail_id === 'string' && /^[0-9a-f]{6,40}$/i.test(f.mail_id) && !ids.has(f.mail_id)) { ng.push({ mail_id: f.mail_id, fout: schoon(f.fout, 60), op: nu.slice(0, 10) }); ids.add(f.mail_id); }
    });
    metaZet(a, 'ecobank_niet_gelezen', JSON.stringify(ng.slice(-500)));
    a.db.exec('COMMIT');
  } catch (e) { a.db.exec('ROLLBACK'); throw e; }
  return uit;
}
function bekend(a) {
  schema(a);
  const ids = a.db.prepare('SELECT mail_id FROM ecobank_tx').all().map(function (r) { return r.mail_id; });
  let ng = []; try { ng = JSON.parse(metaLees(a, 'ecobank_niet_gelezen') || '[]'); } catch (e) { ng = []; }
  return ids.concat(ng.map(function (f) { return f.mail_id; }));
}

function voor(p) { return p.saldo === null ? null : r2(p.saldo - (p.soort === 'bij' ? p.bedrag : -p.bedrag)); }
/*
 * volgorde(posten van één rekening) — oud → nieuw. Op mailtijd; mails die binnen CLUSTER_S van elkaar kwamen, op de saldoketen:
 * steeds de post waarvan het saldo vóór gelijk is aan het saldo na de vorige; anders de post waarvan het saldo vóór bij geen andere
 * post in de groep het saldo na is (begin van de keten); anders de vroegste. Ketenbreuken buiten zo'n groep (een mutatie zonder
 * mail, bijvoorbeeld maandkosten) worden geteld, niet hersteld: het saldo komt altijd uit de mail zelf.
 */
function volgorde(posten) {
  const l = posten.slice().sort(function (p, q) { return p.ts < q.ts ? -1 : p.ts > q.ts ? 1 : (p.mail_id < q.mail_id ? -1 : 1); });
  const uit = [];
  let i = 0;
  while (i < l.length) {
    let j = i + 1;
    while (j < l.length && Date.parse(l[j].ts) - Date.parse(l[j - 1].ts) <= CLUSTER_S * 1000) j++;
    const groep = l.slice(i, j);
    while (groep.length) {
      const vorig = uit.length ? uit[uit.length - 1].saldo : null;
      let k = vorig === null ? -1 : groep.findIndex(function (p) { return voor(p) !== null && Math.abs(voor(p) - vorig) < 0.005; });
      if (k < 0) k = groep.findIndex(function (p) { const v = voor(p); return v !== null && !groep.some(function (q) { return q !== p && q.saldo !== null && Math.abs(q.saldo - v) < 0.005; }); });
      if (k < 0) k = 0;
      uit.push(groep.splice(k, 1)[0]);
    }
    i = j;
  }
  return uit;
}
function rekeningen(a) {
  schema(a);
  return a.db.prepare('SELECT rek_eind, valuta, count(*) n FROM ecobank_tx GROUP BY rek_eind, valuta ORDER BY valuta').all();
}
function postenVan(a, rek_eind, valuta) {
  return a.db.prepare('SELECT * FROM ecobank_tx WHERE rek_eind = ? AND valuta = ?').all(rek_eind, valuta).map(function (r) { return Object.assign({}, r); });
}
function lokaal(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }) + ' ' + d.toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
}
function postUit(p) {
  return { datum: p.datum, tijd: lokaal(p.ts), rekening: 'Ecobank ' + p.valuta + ' (…' + p.rek_eind + ')', soort: p.soort, valuta: p.valuta,
    bedrag: p.soort === 'af' ? -p.bedrag : p.bedrag, omschrijving: p.omschrijving, saldo_na: p.saldo };
}
const LET_OP = 'Ecobank (Gambia): uit de transactiemails van Ecobank, geen bankkoppeling. Saldo = boeksaldo uit de laatste mail van die rekening, met de tijd van die mail; ' +
  'een mutatie waarvoor Ecobank geen mail stuurde (bijvoorbeeld maandkosten) zit wel in dat saldo maar niet in de lijst. GMD is geen euro: nooit optellen bij de euro-rekeningen.';
// stand per rekening + de laatste posten (nieuwste eerst). o: {rekening (GMD|EUR|laatste 4), van, tot, zoek, max}
function overzicht(a, o) {
  o = o || {};
  schema(a);
  const filt = String(o.rekening || '').trim().toUpperCase();
  const reks = rekeningen(a).filter(function (r) { return !filt || r.valuta === filt || r.rek_eind === filt; });
  const stand = [], alle = [];
  let breuken = 0;
  reks.forEach(function (r) {
    const l = volgorde(postenVan(a, r.rek_eind, r.valuta));
    for (let i = 1; i < l.length; i++) { const v = voor(l[i]); if (v !== null && l[i - 1].saldo !== null && Math.abs(v - l[i - 1].saldo) >= 0.005) breuken++; }
    const laatste = l[l.length - 1];
    stand.push({ rekening: 'Ecobank ' + r.valuta + ' (…' + r.rek_eind + ')', valuta: r.valuta, rek_eind: r.rek_eind, saldo: laatste.saldo,
      beschikbaar: laatste.beschikbaar, stand_van: lokaal(laatste.ts), laatste_post: laatste.datum, posten: l.length, sinds: l[0].datum });
    l.forEach(function (p) { alle.push(p); });
  });
  let sel = alle.filter(function (p) { return (!o.van || p.datum >= o.van) && (!o.tot || p.datum <= o.tot); });
  if (o.zoek) { const z = String(o.zoek).toLowerCase(); sel = sel.filter(function (p) { return String(p.omschrijving || '').toLowerCase().indexOf(z) >= 0; }); }
  const volg = new Map(); alle.forEach(function (p, i) { volg.set(p.mail_id, i); });
  sel.sort(function (p, q) { return p.ts < q.ts ? 1 : p.ts > q.ts ? -1 : volg.get(q.mail_id) - volg.get(p.mail_id); });
  const max = Math.max(1, Math.min(Number(o.max) || 20, 500));
  return { rekeningen: stand, transacties: sel.slice(0, max).map(postUit), aantal: sel.length, afgekapt: sel.length > max || undefined,
    ronde_op: metaLees(a, 'ecobank_ronde_op'), ketenbreuken: breuken, let_op_ecobank: LET_OP };
}
function stand(a) {
  schema(a);
  const r = a.db.prepare('SELECT count(*) n, min(datum) van, max(datum) tot FROM ecobank_tx').get();
  let ng = []; try { ng = JSON.parse(metaLees(a, 'ecobank_niet_gelezen') || '[]'); } catch (e) { ng = []; }
  return { posten: r.n, vanaf: r.van, tot: r.tot, rekeningen: rekeningen(a).length, niet_gelezen: ng.length };
}

module.exports = { afzenderAdres, leesMail, isMelding, controleer, schema, bij, bekend, volgorde, overzicht, stand, metaZet, LET_OP };
