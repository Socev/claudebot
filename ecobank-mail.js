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
// wv2259: alleen de mails die echt gelezen en in ecobank_tx opgenomen zijn (niet de onleesbare uit ecobank_niet_gelezen): die mag MailMan
// uit de inbox halen
function verwerkt(a) {
  schema(a);
  return a.db.prepare('SELECT mail_id FROM ecobank_tx ORDER BY ts DESC, mail_id LIMIT 20000').all().map(function (r) { return r.mail_id; });
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
  return a.db.prepare('SELECT rek_eind, valuta, count(*) n FROM ecobank_tx GROUP BY rek_eind, valuta UNION ' +
    'SELECT rek_eind, valuta, count(*) n FROM ecobank_csv GROUP BY rek_eind, valuta').all()
    .reduce(function (l, r) { if (!l.some(function (q) { return q.rek_eind === r.rek_eind && q.valuta === r.valuta; })) l.push({ rek_eind: r.rek_eind, valuta: r.valuta }); return l; }, [])
    .sort(function (p, q) { return p.valuta < q.valuta ? -1 : p.valuta > q.valuta ? 1 : (p.rek_eind < q.rek_eind ? -1 : 1); });
}
function postenVan(a, rek_eind, valuta) {
  return a.db.prepare('SELECT * FROM ecobank_tx WHERE rek_eind = ? AND valuta = ?').all(rek_eind, valuta).map(function (r) { return Object.assign({}, r); });
}

/*
 * ── CSV-export van de Ecobank-website (wv2206, 1-11-2026) ──
 * WAAROM. David (1-11-2026): "Ik heb voor de 2 Gambiaanse rekeningen maar even alle transacties als CSV gedownload ... er zal een stukje
 * overlap in kunnen zitten tussen bestanden (1e/laatste dag); Wil jij deze rekeningen toevoegen aan je overzichten?" De mails missen de
 * mutaties waarvoor Ecobank geen mail stuurt (maandkosten, btw daarover, rente): gemeten 1-11 12 van de 144 boekingen.
 * VORM (gemeten 1-11, 8 bestanden): 6 kopregels (Account No, Account Name, Currency leeg, Period, Opening Balance "<VAL> <bedrag>",
 * Closing Balance), dan "Transaction Date,Description,Reference Number,DEBIT,CREDIT,Balance"; datum "02 Nov 2026"; nieuwste boeking
 * bovenaan; een omschrijving kan regeleinden bevatten (csv-quoting). Opening/Closing in de kop klopt niet altijd met de Balance-kolom:
 * die kop wordt alleen voor de valuta gelezen, de Balance-kolom is leidend.
 * GEMETEN. De datum in de export is de valutadatum uit de mail (132/132); de referentie is niet uniek (maandkosten dragen elke maand
 * dezelfde); de Balance-kolom volgt de volgorde van het afschrift, die binnen één dag kan afwijken van het boeksaldo in de mail (8 van
 * 132: opname vóór de bijschrijving van dezelfde dag). Daarom: ontdubbelen tussen bestanden op (datum, referentie, af/bij, bedrag, saldo);
 * koppelen aan een mail op (rekening, referentie, af/bij, bedrag, datum = valutadatum), één op één; het saldo komt dan uit de export.
 * Een mail die niet in de export staat en nieuwer is dan de jongste gekoppelde mail, komt achter de export (de export was eerder).
 */
const CSV_KOP = ['Transaction Date', 'Description', 'Reference Number', 'DEBIT', 'CREDIT', 'Balance'];
function csvRegels(t) {   // RFC 4180: velden tussen "", "" = ", regeleinden binnen quotes horen bij het veld
  const rijen = []; let rij = [], veld = '', q = false, i = 0;
  t = String(t).replace(/^﻿/, '');
  while (i < t.length) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { veld += '"'; i++; } else q = false; } else veld += c; }
    else if (c === '"') q = true;
    else if (c === ',') { rij.push(veld); veld = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; rij.push(veld); rijen.push(rij); rij = []; veld = ''; }
    else veld += c;
    i++;
  }
  if (veld !== '' || rij.length) { rij.push(veld); rijen.push(rij); }
  return q ? null : rijen;
}
function csvBedrag(s) {
  const t = String(s == null ? '' : s).trim().replace(/,/g, '');
  if (t === '') return null;
  return /^-?\d+(\.\d{1,2})?$/.test(t) ? r2(Number(t)) : NaN;
}
// tekst van één export → {rek_eind, valuta, rijen: [{datum, omschrijving, referentie, soort, bedrag, saldo, pos}]} of {fout}; pos 0 = bovenste (nieuwste)
function leesCsv(tekst) {
  if (typeof tekst !== 'string' || tekst.length > 2e6) return { fout: 'geen tekst' };
  const r = csvRegels(tekst);
  if (!r) return { fout: 'quotes niet gesloten' };
  const kop = {}; let k = -1;
  for (let i = 0; i < Math.min(r.length, 20); i++) {
    if (r[i].length >= 6 && CSV_KOP.every(function (n, j) { return String(r[i][j]).trim() === n; })) { k = i; break; }
    if (r[i][0]) kop[String(r[i][0]).trim()] = String(r[i][1] == null ? '' : r[i][1]).trim();
  }
  if (k < 0) return { fout: 'kopregel met de kolommen niet gevonden' };
  const nr = /^(\d{6,20})$/.exec(String(kop['Account No'] || '').replace(/\s/g, ''));
  if (!nr) return { fout: 'rekeningnummer niet gevonden' };
  const val = /^([A-Z]{3})\b/.exec(kop['Opening Balance'] || '') || /^([A-Z]{3})\b/.exec(kop['Closing Balance'] || '') || /^([A-Z]{3})$/.exec(kop.Currency || '');
  if (!val || VALUTA.indexOf(val[1]) < 0) return { fout: 'valuta niet gevonden' };
  const rijen = [];
  for (let i = k + 1; i < r.length; i++) {
    const x = r[i];
    if (!x.some(function (v) { return String(v).trim(); })) continue;
    if (x.length !== 6) return { fout: 'regel ' + (i + 1) + ': ' + x.length + ' kolommen' };
    const d = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(String(x[0]).trim());
    const dt = d && datum(d[1], d[2], d[3]);
    const deb = csvBedrag(x[3]), cre = csvBedrag(x[4]), sal = csvBedrag(x[5]);
    if (!dt) return { fout: 'regel ' + (i + 1) + ': datum' };
    if (Number.isNaN(deb) || Number.isNaN(cre) || Number.isNaN(sal) || sal === null || (deb === null) === (cre === null) || (deb !== null ? deb : cre) <= 0) return { fout: 'regel ' + (i + 1) + ': bedragen' };
    const ref = String(x[2]).trim();
    if (!/^[A-Za-z0-9\-/]{4,40}$/.test(ref)) return { fout: 'regel ' + (i + 1) + ': referentie' };
    rijen.push({ datum: dt, omschrijving: schoon(x[1], 140), referentie: ref, soort: deb !== null ? 'af' : 'bij', bedrag: deb !== null ? deb : cre, saldo: sal, pos: rijen.length });
  }
  if (!rijen.length) return { fout: 'geen boekingen' };   // review gpt-5.5 ZOU 1
  return { rek_eind: nr[1].slice(-4), valuta: val[1], rijen: rijen };
}
function csvSchema(a) {
  a.db.exec('CREATE TABLE IF NOT EXISTS ecobank_csv (rek_eind TEXT NOT NULL, valuta TEXT NOT NULL, datum TEXT NOT NULL, referentie TEXT NOT NULL,' +
    ' soort TEXT NOT NULL, bedrag REAL NOT NULL, saldo REAL NOT NULL, omschrijving TEXT, volg INTEGER NOT NULL, bron TEXT, eerste_gezien TEXT NOT NULL,' +
    ' UNIQUE (rek_eind, valuta, datum, referentie, soort, bedrag, saldo));');
}
function csvVoor(p) { return r2(p.saldo - (p.soort === 'bij' ? p.bedrag : -p.bedrag)); }
/*
 * Volgorde van de exportregels van één rekening, oud → nieuw. De export volgt het afschrift en dat is niet altijd op datum (gemeten 1-11:
 * maandkosten met datum 4-5 staan vóór de boekingen van 2-5 en 3-5, en alleen zo sluit de saldoketen). Dus: elke export (en wat al bewaard
 * was, in zijn volg) is een reeks oud → nieuw; reeksen op hun eerste datum (bij gelijke datum de bewaarde eerst, dan de langste); een
 * reeks wordt achter de vorige gezet zonder de regels die er al staan (overlap op de eerste/laatste dag). Breuken worden geteld, niet hersteld.
 */
function csvSleutel(p) { return [p.datum, p.referentie, p.soort, r2(p.bedrag).toFixed(2), r2(p.saldo).toFixed(2)].join('|'); }
function csvVolgorde(reeksen) {
  const l = reeksen.filter(function (r) { return r.rijen.length; }).sort(function (p, q) {
    const a = p.rijen[0].datum, b = q.rijen[0].datum;
    return a < b ? -1 : a > b ? 1 : (p.bewaard !== q.bewaard ? (p.bewaard ? -1 : 1) : q.rijen.length - p.rijen.length);
  });
  const gezien = new Set(), uit = [];
  l.forEach(function (r) { r.rijen.forEach(function (p) { const k = csvSleutel(p); if (!gezien.has(k)) { gezien.add(k); uit.push(p); } }); });
  return uit;
}
function breukenIn(l, voorFn) { let b = 0; for (let i = 1; i < l.length; i++) { if (l[i].saldo !== null && l[i - 1].saldo !== null && Math.abs(voorFn(l[i]) - l[i - 1].saldo) >= 0.005) b++; } return b; }
// teksten = [tekst van een export, …]; bron = korte naam van de import. Idempotent; geeft alleen aantallen terug.
function csvBij(a, teksten, bron) {
  schema(a); csvSchema(a);
  const gelezen = [], uit = { bestanden: 0, regels: 0, nieuw: 0, al_bekend: 0, fouten: [], rekeningen: [] };
  (Array.isArray(teksten) ? teksten : []).forEach(function (t, i) {
    const c = leesCsv(t);
    if (c.fout) { uit.fouten.push({ bestand: i + 1, fout: c.fout }); return; }
    uit.bestanden++; uit.regels += c.rijen.length; gelezen.push(c);
  });
  if (uit.fouten.length) return uit;   // alles of niets: een export die niet te lezen is, laat de rest ook staan
  const nu = nuIso(), b = schoon(bron || 'csv', 40) || 'csv';
  const zet = a.db.prepare('INSERT OR IGNORE INTO ecobank_csv (rek_eind, valuta, datum, referentie, soort, bedrag, saldo, omschrijving, volg, bron, eerste_gezien) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const herVolg = a.db.prepare('UPDATE ecobank_csv SET volg = ? WHERE rek_eind = ? AND valuta = ? AND datum = ? AND referentie = ? AND soort = ? AND bedrag = ? AND saldo = ?');
  a.db.exec('BEGIN');
  try {
    const reks = new Map();
    gelezen.forEach(function (c) {
      const k = c.rek_eind + '|' + c.valuta;
      if (!reks.has(k)) reks.set(k, { rek_eind: c.rek_eind, valuta: c.valuta, reeksen: [] });
      reks.get(k).reeksen.push({ bewaard: false, rijen: c.rijen.slice().reverse() });   // export: nieuwste bovenaan → oud → nieuw
      c.rijen.forEach(function (p) {
        const r = zet.run(c.rek_eind, c.valuta, p.datum, p.referentie, p.soort, p.bedrag, p.saldo, p.omschrijving, 0, b, nu);
        if (r.changes) uit.nieuw++; else uit.al_bekend++;
      });
    });
    reks.forEach(function (rk) {
      const oud = a.db.prepare('SELECT datum, referentie, soort, bedrag, saldo FROM ecobank_csv WHERE rek_eind = ? AND valuta = ? AND volg > 0 ORDER BY volg').all(rk.rek_eind, rk.valuta)
        .map(function (r) { return Object.assign({}, r); });
      const o = csvVolgorde([{ bewaard: true, rijen: oud }].concat(rk.reeksen));
      o.forEach(function (p, i) { herVolg.run(i + 1, rk.rek_eind, rk.valuta, p.datum, p.referentie, p.soort, p.bedrag, p.saldo); });
      uit.rekeningen.push({ rekening: rk.valuta + ' …' + rk.rek_eind, regels: o.length, van: o.reduce(function (m, p) { return p.datum < m ? p.datum : m; }, o[0].datum),
        tot: o.reduce(function (m, p) { return p.datum > m ? p.datum : m; }, o[0].datum), ketenbreuken: breukenIn(o, csvVoor) });
    });
    metaZet(a, 'ecobank_csv_op', nu);
    a.db.exec('COMMIT');
  } catch (e) { a.db.exec('ROLLBACK'); throw e; }
  return uit;
}
function csvVan(a, rek_eind, valuta) {
  csvSchema(a);
  return a.db.prepare('SELECT * FROM ecobank_csv WHERE rek_eind = ? AND valuta = ? ORDER BY volg').all(rek_eind, valuta).map(function (r) { return Object.assign({}, r); });
}
/*
 * Eén rekening, oud → nieuw: de exportregels in hun volgorde, met de tijd van de gekoppelde mail; mails die niet in de export staan
 * daarvoor (ouder dan de export), ertussen (op datum; geteld als alleen_mail_binnen) of erachter (nieuwer dan de jongste gekoppelde mail,
 * of zonder gekoppelde mail: na de laatste exportdag). Zonder export precies zoals voorheen: alleen de mails in ketenvolgorde.
 */
function samen(a, rek_eind, valuta) {
  const mails = volgorde(postenVan(a, rek_eind, valuta));
  const csv = csvVan(a, rek_eind, valuta);
  if (!csv.length) return { l: mails.map(function (p) { return Object.assign({ bron: 'mail' }, p); }), binnen: 0, gekoppeld: 0 };
  const sleutel = function (ref, soort, bedrag, d) { return ref + '|' + soort + '|' + r2(bedrag).toFixed(2) + '|' + d; };
  const vrij = new Map();
  csv.forEach(function (c) { const k = sleutel(c.referentie, c.soort, c.bedrag, c.datum); if (!vrij.has(k)) vrij.set(k, []); vrij.get(k).push(c); });
  const los = []; let laatsteTs = null, gekoppeld = 0;
  mails.forEach(function (m) {
    const g = vrij.get(sleutel(m.referentie, m.soort, m.bedrag, m.valutadatum || m.datum));
    if (g && g.length) { const c = g.shift(); c.mail = m; gekoppeld++; if (!laatsteTs || m.ts > laatsteTs) laatsteTs = m.ts; }
    else los.push(m);
  });
  const eerste = csv.reduce(function (m, c) { return c.datum < m ? c.datum : m; }, csv[0].datum), laatste = csv.reduce(function (m, c) { return c.datum > m ? c.datum : m; }, csv[0].datum);
  const ervoor = [], erna = [], tussen = [];
  los.forEach(function (m) {
    const d = m.valutadatum || m.datum;
    if (laatsteTs ? m.ts > laatsteTs : d > laatste) erna.push(m);
    else if (d < eerste) ervoor.push(m);
    else tussen.push(m);
  });
  // op datum (stabiel: bij gelijke datum de ketenvolgorde van de mails), review gpt-5.5 MOET 2
  const plek = new Map(); tussen.forEach(function (m, i) { plek.set(m, i); });
  tussen.sort(function (p, q) { const a = p.valutadatum || p.datum, b = q.valutadatum || q.datum; return a < b ? -1 : a > b ? 1 : plek.get(p) - plek.get(q); });
  const uit = ervoor.map(function (p) { return Object.assign({ bron: 'mail' }, p); });
  let ti = 0;
  csv.forEach(function (c, i) {
    while (ti < tussen.length && (tussen[ti].valutadatum || tussen[ti].datum) < c.datum) uit.push(Object.assign({ bron: 'mail', binnen: true }, tussen[ti++]));
    uit.push({ bron: c.mail ? 'export+mail' : 'export', mail_id: c.mail ? c.mail.mail_id : 'csv' + c.volg, ts: c.mail ? c.mail.ts : null, rek_eind: rek_eind, valuta: valuta,
      soort: c.soort, bedrag: c.bedrag, datum: c.datum, referentie: c.referentie, omschrijving: c.omschrijving || (c.mail && c.mail.omschrijving) || '', saldo: c.saldo,
      beschikbaar: null });
    if (i === csv.length - 1) while (ti < tussen.length) uit.push(Object.assign({ bron: 'mail', binnen: true }, tussen[ti++]));
  });
  erna.forEach(function (p) { uit.push(Object.assign({ bron: 'mail' }, p)); });
  return { l: uit, binnen: tussen.length, gekoppeld: gekoppeld };
}
function lokaal(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }) + ' ' + d.toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
}
function postUit(p) {
  return { datum: p.datum, tijd: p.ts ? lokaal(p.ts) : p.datum, rekening: 'Ecobank ' + p.valuta + ' (…' + p.rek_eind + ')', soort: p.soort, valuta: p.valuta,
    bedrag: p.soort === 'af' ? -p.bedrag : p.bedrag, omschrijving: p.omschrijving, saldo_na: p.saldo };
}
const LET_OP = 'Ecobank (Gambia): uit de transactiemails van Ecobank en de CSV-exports die David van de Ecobank-website haalde, geen bankkoppeling. ' +
  'Saldo = saldo na de jongste boeking van die rekening (export of mail, met de datum of tijd daarvan); na de laatste export tellen alleen de mails, ' +
  'en een mutatie waarvoor Ecobank geen mail stuurt (maandkosten, rente) zit dan wel in het volgende saldo maar niet in de lijst. ' +
  'De datum is de datum die de bank geeft (export: valutadatum; mail zonder export: transactiedatum), ook als die in de toekomst ligt. GMD is geen euro: nooit optellen bij de euro-rekeningen.';
// stand per rekening + de laatste posten (nieuwste eerst). o: {rekening (GMD|EUR|laatste 4), van, tot, zoek, max}
function overzicht(a, o) {
  o = o || {};
  schema(a); csvSchema(a);
  const filt = String(o.rekening || '').trim().toUpperCase();
  const reks = rekeningen(a).filter(function (r) { return !filt || r.valuta === filt || r.rek_eind === filt; });
  const stand = [], alle = [];
  let breuken = 0, binnen = 0;
  reks.forEach(function (r) {
    const s = samen(a, r.rek_eind, r.valuta), l = s.l;
    breuken += breukenIn(l, voor);
    binnen += s.binnen;
    const laatste = l[l.length - 1];
    stand.push({ rekening: 'Ecobank ' + r.valuta + ' (…' + r.rek_eind + ')', valuta: r.valuta, rek_eind: r.rek_eind, saldo: laatste.saldo,
      beschikbaar: laatste.bron === 'mail' ? laatste.beschikbaar : null, stand_van: laatste.ts ? lokaal(laatste.ts) : laatste.datum,
      laatste_post: laatste.datum, posten: l.length, sinds: l[0].datum });
    l.forEach(function (p) { alle.push(p); });
  });
  let sel = alle.filter(function (p) { return (!o.van || p.datum >= o.van) && (!o.tot || p.datum <= o.tot); });
  if (o.zoek) { const z = String(o.zoek).toLowerCase(); sel = sel.filter(function (p) { return String(p.omschrijving || '').toLowerCase().indexOf(z) >= 0; }); }
  // nieuwste eerst: per rekening de omgekeerde ketenvolgorde; rekeningen onderling op datum (de lijst is voor het oog, het saldo staat hierboven)
  const volg = new Map(); alle.forEach(function (p, i) { volg.set(p, i); });
  sel.sort(function (p, q) {
    if (p.rek_eind === q.rek_eind && p.valuta === q.valuta) return volg.get(q) - volg.get(p);
    const dp = p.ts ? lokaal(p.ts) : p.datum, dq = q.ts ? lokaal(q.ts) : q.datum;
    return dp < dq ? 1 : dp > dq ? -1 : volg.get(q) - volg.get(p);
  });
  const max = Math.max(1, Math.min(Number(o.max) || 20, 500));
  return { rekeningen: stand, transacties: sel.slice(0, max).map(postUit), aantal: sel.length, afgekapt: sel.length > max || undefined,
    ronde_op: metaLees(a, 'ecobank_ronde_op'), csv_op: metaLees(a, 'ecobank_csv_op') || undefined, ketenbreuken: breuken,
    alleen_mail_binnen_export: binnen || undefined, let_op_ecobank: LET_OP };
}
function stand(a) {
  schema(a); csvSchema(a);
  const r = a.db.prepare('SELECT count(*) n, min(datum) van, max(datum) tot FROM ecobank_tx').get();
  const c = a.db.prepare('SELECT count(*) n, min(datum) van, max(datum) tot FROM ecobank_csv').get();
  let ng = []; try { ng = JSON.parse(metaLees(a, 'ecobank_niet_gelezen') || '[]'); } catch (e) { ng = []; }
  return { posten: r.n, vanaf: r.van, tot: r.tot, export_regels: c.n || undefined, export_vanaf: c.van || undefined, export_tot: c.tot || undefined,
    rekeningen: rekeningen(a).length, niet_gelezen: ng.length };
}

module.exports = { afzenderAdres, leesMail, isMelding, controleer, schema, bij, bekend, verwerkt, volgorde, overzicht, stand, metaZet, LET_OP, leesCsv, csvBij, csvVolgorde };
