'use strict';
/*
 * OVIS GHAWA fase 5 — Momodou kijkt mee op ghawa.socev.dev (wv2889, 10-11-2026). Ontwerp in de vault: 01_Ontwikkeling "OVIS GHAWA fase 5 -
 * Momodou kijkt mee op ghawa.socev.dev (ontwerp wv2888, 10-11-2026)" (Codex GO na 9 rondes). Davids Ja: kaart wv2889, 10-11 15:41 (verse
 * vingerafdruk): Engels, alleen lezen, achter een inlog, met de grondwet-aanvulling bij regel 1; eerst alleen David als proef.
 *
 * WAAROM. Momodou (ECG) moet makkelijk overzicht hebben over de bouw en het geld van ECG, zonder dat donateurs, de bankregels van GHAWA,
 * rekeningnummers, notities of tekst uit persoonspagina's ooit de pod verlaten.
 *
 * WAT. Per onderdeel dat David aanzet bouwt de pod uit een VASTE lijst kolommen (DEEL_KOLOMMEN; een nieuwe kolom in de databank gaat nooit
 * vanzelf mee) één Engels JSON-document, haalt het door de POORT en zet het in D1 `ghawa`. De worker (socev-app ghawa/worker.ts) toont het
 * alleen-lezen aan wie langs Cloudflare Access komt én in D1 `bezoeker` staat.
 *  - Labels: ECG-rekeningen → "ECG GMD account" / "ECG EUR account", GHAWA → "GHAWA (NL)", Wilde Ganzen; begunstigden op cheques → "Payee XYZ"
 *    (vast per persoon via een HMAC met een pod-sleutel); andere bekende personen → "ECG staff", "GHAWA board", "a donor", "a person".
 *    Alleen David en Momodou blijven bij naam. In tekst- en referentievelden wordt elke cijferreeks van ≥ 8 cijfers "…" + laatste 4.
 *  - Goedgekeurde teksten: elke vrije-tekstwaarde gaat alleen mee als precies die waarde (sha256 na labels en maskering) in deel_tekst op
 *    'share' staat; anders "[text pending review]" (en in de app onder Nieuwe teksten) of bij 'hold' "[text not shared]".
 *  - GHAWA-totalen: één blok (per jaar giften samen, rente en kosten, naar Wilde Ganzen, naar ECG; saldo) met de stand van eind vorige maand.
 *    Een nieuw blok gaat alleen mee als voor ELK getal het aantal gewijzigde giften t.o.v. het vorige gepubliceerde blok 0 of ≥ 3 is (nieuw,
 *    ander bedrag of jaar, verdwenen) én het lopende jaar ≥ 10 giftregels heeft; anders blijft het vorige blok staan. Een jaar met < 10
 *    giftregels gaat samen met een buurjaar ("2023–2024"). Ook "nog te werven" in Overview rekent met het saldo uit het blok.
 *  - POORT (vóór elke verzending én dagelijks op wat buiten staat): alleen op tekstwaarden; privé-donateursnamen en hun onderscheidende
 *    naamdelen, persoonsnamen (behalve David en Momodou), rekeningnummers van GHAWA (eigen en tegenrekeningen) en ECG, IBAN-vorm,
 *    cijferreeksen ≥ 9. Getallen apart: eindig, geheel (behalve rate/pct), |x| ≤ 1e13. Eén treffer = dat onderdeel meteen dicht (blok-rij +
 *    inhoud weg), schakelaar uit, één signaal in Vraagt aandacht (onderdeel + plek, nooit de treffer).
 *  - Eén wachtrij voor ALLE D1-schrijfacties; intrekken (onderdeel uit, iemand eraf, noodstop) gaat vooraan maar wacht op de lopende batch,
 *    schrijft eerst een blijvende blok-rij en wist dan de inhoud. Elke publicatie-INSERT is voorwaardelijk (WHERE NOT EXISTS blok): een late
 *    batch kan een gesloten onderdeel niet heropenen. Alleen David haalt een blok weg (onderdeel weer aan / iemand weer erbij = vingerafdruk).
 *  - Houdbaarheid per onderdeel: publicatie.geldig_tot = nu + 72 u na elke geslaagde push of terugleescontrole; ververs elke 6 u.
 *  - Logboek: de worker schrijft adres-hash, onderdeel en tijd; de pod haalt het elk uur op (deel_log) en wist het buiten.
 * PRIVACY. Nooit namen, adressen, teksten of bedragen in logs, fouten of /health: alleen aantallen, onderdeel-id's en tijden.
 * VORM. Alleen fs, path, crypto en node:sqlite; D1 komt via maak({ d1 }); ghawa.js en ghawa-stichting.js voor de cijfers en de vault.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ONDERDELEN = [
  ['overview', 'Overview', 'Overzicht'], ['construction', 'Construction', 'Bouw'], ['pharmacy', 'Pharmacy', 'Apotheek'],
  ['accounts', 'ECG accounts', 'ECG-rekeningen'], ['funds', 'Funds', 'Fondsen'], ['totals', 'GHAWA totals', 'GHAWA-totalen'],
  ['questions', 'Open questions', 'Open vragen'], ['milestones', 'Milestones', 'Mijlpalen'], ['meetings', 'Meetings and decisions', 'Overleg en besluiten'],
];
const IDS = ONDERDELEN.map((x) => x[0]);
// De witte lijst: per onderdeel per soort rij precies deze sleutels (in deze volgorde). test/ghawa-deel.test.js toetst het pakket hiertegen.
const DEEL_KOLOMMEN = {
  overview: { top: ['as_of', 'construction', 'pharmacy', 'phases', 'ecg_balance', 'to_raise_eur_cent', 'to_raise_as_of', 'reconciliation'],
    construction: ['budget', 'realised', 'not_needed', 'open', 'pct'], pharmacy: ['budget', 'open'], phases: ['id', 'name', 'budget', 'realised', 'not_needed', 'open', 'pct'],
    ecg_balance: ['gmd', 'gmd_date', 'eur', 'eur_date'], reconciliation: ['id', 'label', 'ok', 'difference'] },
  construction: { top: ['as_of', 'phases', 'activities', 'lines', 'expenditures'],
    phases: ['id', 'name', 'description', 'budget', 'realised', 'not_needed', 'open', 'overrun'],
    activities: ['nr', 'phase', 'name', 'status', 'note', 'budget', 'realised', 'not_needed', 'open', 'overrun'],
    lines: ['id', 'activity', 'item', 'qty', 'price', 'budget', 'realised', 'open', 'status'],
    expenditures: ['id', 'date', 'line', 'description', 'reference', 'gmd', 'paid_from', 'method', 'cheque', 'evidence'] },
  accounts: { top: ['as_of', 'balances', 'bank', 'flows'], balances: ['account', 'currency', 'balance', 'date'],
    bank: ['account', 'date', 'reference', 'amount', 'currency', 'balance', 'kind', 'cheque', 'payee'],
    flows: ['id', 'date', 'kind', 'from', 'to', 'eur', 'gmd', 'rate', 'reference', 'purpose'] },
  funds: { top: ['as_of', 'funds'], funds: ['id', 'giver', 'kind', 'project', 'purpose', 'eur', 'date', 'status', 'deadline'] },
  totals: { top: ['as_of', 'years', 'balance'], years: ['year', 'gifts', 'interest_and_costs', 'to_wilde_ganzen', 'to_ecg'], balance: ['eur_cent', 'date'] },
  questions: { top: ['as_of', 'questions'], questions: ['id', 'topic', 'question', 'gmd', 'who', 'status', 'answer'] },
  milestones: { top: ['as_of', 'milestones'], milestones: ['order', 'when', 'text', 'status'] },
  meetings: { top: ['as_of', 'decisions', 'meetings'], decisions: ['date', 'text', 'why', 'source'],
    meetings: ['date', 'title', 'decisions', 'actions'], 'meetings.decisions': ['text', 'why'], 'meetings.actions': ['text', 'owner', 'deadline'] },
};
DEEL_KOLOMMEN.pharmacy = DEEL_KOLOMMEN.construction;
const FASE_EN = {   // vaste Engelse beschrijving per fase (de databank heeft Nederlandse omschrijvingen)
  'Phase 1A': 'foundation, borehole and pump, septic tank, fence, solar power', 'Phase 1B': 'ground-floor walls and first slab',
  'Phase 2': 'first floor and second slab', 'Phase 3': 'second floor, third slab and roof', 'Phase 4': 'finishing, interior and installations',
  'Phase 5': 'ground clearing and extra backfilling', 'All phases': 'project management fee, all phases', Unbudgeted: 'outside toilets, bank charges, to be specified',
  Pharmacy: 'separate project, sponsored by AFAS',
};
const AANSLUITING = { A: 'ECG bank statements per quarter', B: 'Cheques against handwritten lists', C: 'Conversions EUR to GMD', D: 'Paid out against itemised',
  E: 'GHAWA bank', F: 'Wilde Ganzen received against reported' };
const GIFT = ['Donation (bank transfer)', 'Donation online (Mollie)', 'Sponsor AFAS (pharmacy)', 'Unknown'];
const RENTE_KOSTEN = ['Interest', 'Bank costs', 'Bank fee foreign payment', 'Other costs'];
const HOUDBAAR_MS = 72 * 3600000, VERS_MS = 6 * 3600000, RONDE_MS = 15 * 60000, TERUG_MS = 24 * 3600000, LOG_MS = 3600000;
const STUK = 60000, MAX_AANROEPEN = 20, GRENS = 1e13;
const PENDING = '[text pending review]', HOLD = '[text not shared]';
const FLOAT = new Set(['rate', 'pct']);
// algemene woorden die in donateursnamen voorkomen maar niemand aanwijzen (geen namen; alleen soort- en verbindingswoorden)
const STOP = new Set(['stichting', 'foundation', 'familie', 'family', 'fam', 'donation', 'donations', 'online', 'apotheek', 'pharmacy', 'incl', 'inclusief',
  'onbekend', 'unknown', 'anoniem', 'anonymous', 'gift', 'giften', 'donateur', 'donor', 'maatschap', 'praktijk', 'huisarts', 'huisartsen', 'huisartsenpraktijk',
  'kerk', 'church', 'school', 'club', 'rotary', 'leusden', 'amersfoort', 'nederland', 'holding', 'beheer', 'groep', 'group', 'mollie', 'payments', 'recurring',
  'ghawa', 'wilde', 'ganzen', 'afas', 'triodos', 'bank', 'zorg', 'care', 'health', 'medical', 'vereniging', 'association', 'and', 'van', 'der', 'den', 'het',
  'heer', 'mevrouw', 'mevr', 'dhr', 'drs', 'ing', 'mr', 'dr']);
const D1_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS deel (onderdeel TEXT NOT NULL, stuk INTEGER NOT NULL, json TEXT NOT NULL, hash TEXT NOT NULL, op INTEGER NOT NULL, PRIMARY KEY (onderdeel, stuk))',
  'CREATE TABLE IF NOT EXISTS publicatie (onderdeel TEXT PRIMARY KEY, versie INTEGER NOT NULL, stukken INTEGER NOT NULL, hash TEXT NOT NULL, geldig_tot INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS blok (soort TEXT NOT NULL, sleutel TEXT NOT NULL, op INTEGER NOT NULL, PRIMARY KEY (soort, sleutel))',
  'CREATE TABLE IF NOT EXISTS stand (sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS bezoeker (hash TEXT PRIMARY KEY, rol TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, onderdeel TEXT NOT NULL, op INTEGER NOT NULL)',
];
const LOKAAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS deel_stand (sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deel_tekst (hash TEXT PRIMARY KEY, besluit TEXT NOT NULL, op TEXT NOT NULL, door TEXT);
CREATE TABLE IF NOT EXISTS deel_kijker (hash TEXT PRIMARY KEY, naam TEXT NOT NULL, adres TEXT NOT NULL, rol TEXT NOT NULL, op TEXT NOT NULL, door TEXT, weg_op TEXT);
CREATE TABLE IF NOT EXISTS deel_gift (id TEXT PRIMARY KEY, jaar INTEGER NOT NULL, bedrag_cent INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deel_obj (onderdeel TEXT PRIMARY KEY, hash TEXT, stukken INTEGER, versie INTEGER NOT NULL DEFAULT 0, op TEXT, vers_op TEXT, dicht TEXT, dicht_bevestigd TEXT);
CREATE TABLE IF NOT EXISTS deel_overleg (sleutel TEXT PRIMARY KEY, op TEXT NOT NULL, door TEXT);
CREATE TABLE IF NOT EXISTS deel_log (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, onderdeel TEXT NOT NULL, op TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deel_naam (naam TEXT PRIMARY KEY, soort TEXT NOT NULL DEFAULT 'persoon', op TEXT);
`;

// ── kleine hulpen ──
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const adresHash = (m) => sha256(String(m).normalize('NFC').trim().toLowerCase());   // zelfde als de worker
const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function maskeer(s) {   // elke cijferreeks van ≥ 8 cijfers → … + laatste 4
  return String(s).replace(/\d{8,}/g, (m) => '…' + m.slice(-4));
}
function cijfersAaneen(s) { return String(s).replace(/(\d)[ .\-\/](?=\d)/g, '$1'); }
function naamRe(naam) {   // "Lamin M. Manneh" → /(?<!\p{L})Lamin\s+M\.?\s+Manneh(?!\p{L})/giu (hoofdletterongevoelig, punten en spaties los)
  const delen = String(naam).normalize('NFC').trim().split(/[\s.]+/).filter(Boolean).map(esc);
  return new RegExp('(?<![\\p{L}\\p{N}])' + delen.join('[\\s.]*\\s*') + '\\.?(?![\\p{L}\\p{N}])', 'giu');
}
const amsDag = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
function eindVorigeMaand(ms) { const d = amsDag(ms); const e = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, 0)); return e.toISOString().slice(0, 10); }

// ── namen en rekeningen (alleen op de pod) ──
function chequeNamen(oms) {   // "… PAID TO X Y", "PAID IFO X", "IFO X, …", "B/O X, …", "Cash Wdl By X / Y" → de namen
  const uit = [];
  const re = /(?:PAID\s+(?:TO|IFO)|\bIFO|\bB\/O|\bWDL\s+BY)\s+([^,(]{3,90})/gi;
  let m;
  while ((m = re.exec(String(oms || '')))) {
    const stuk = m[1].split(/\s+(?:F\.|For\b|IFO\b|B\/O\b)|\s+\d|\s*@/i)[0];
    for (const d of stuk.split('/')) { const n = d.trim().replace(/\s+/g, ' '); if (/^[A-Za-z][A-Za-z.' -]+$/.test(n) && n.split(' ').length >= 2) uit.push(n); }
  }
  return uit;
}
function varianten(naam) {   // "Lamin M. Manneh" → ook "Lamin Manneh" (middelste initialen weg)
  const d = String(naam).trim().split(/\s+/);
  if (d.length < 3) return [];
  const kern = [d[0]].concat(d.slice(1, -1).filter((x) => x.replace(/\./g, '').length > 2), [d[d.length - 1]]);
  return kern.length < d.length && kern.length >= 2 ? [kern.join(' ')] : [];
}
function isTweeVrij(n) { const x = norm(n); return /\bdavid\b/.test(x) || /\bmomodou\b/.test(x); }
function lijstenVan(db, vault, S) {
  const a = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return []; } };
  const prive = new Set(), personen = new Map(), rekeningen = new Set();   // personen: naam → label-soort
  for (const r of a("SELECT naam FROM donateur WHERE soort IS NULL OR soort NOT IN ('Organisation', 'Sponsor', 'Online')")) if (r.naam) prive.add(String(r.naam).trim());
  const orgDon = new Set(a("SELECT naam FROM donateur WHERE soort IN ('Organisation', 'Sponsor', 'Online')").map((r) => norm(r.naam)));
  for (const r of a("SELECT DISTINCT donateur AS n FROM bankregel_ghawa WHERE donateur IS NOT NULL")) if (r.n && !orgDon.has(norm(r.n))) prive.add(String(r.n).trim());
  for (const r of a("SELECT DISTINCT tegenpartij AS n FROM bankregel_ghawa WHERE soort = 'Donation (bank transfer)' AND tegenpartij IS NOT NULL")) if (r.n && !orgDon.has(norm(r.n))) prive.add(String(r.n).trim());
  for (const r of a("SELECT DISTINCT begunstigde AS n FROM bankregel_ecg WHERE begunstigde IS NOT NULL")) if (r.n) personen.set(String(r.n).trim(), 'payee');
  for (const r of a("SELECT DISTINCT omschrijving AS o FROM bankregel_ecg WHERE omschrijving IS NOT NULL")) for (const n of chequeNamen(r.o)) if (!personen.has(n)) personen.set(n, 'payee');
  // fase 4 (Mensen) en Davids privédossier Gambia: alleen de namen, nooit tekst van de pagina's
  try {
    const v = S.leesVault(vault);
    for (const p of v.ghawaBestuur || []) if (p && p.naam) personen.set(String(p.naam).trim(), 'ghawa');
    for (const p of v.ecgBestuur || []) if (p && p.naam) personen.set(String(p.naam).trim(), 'ecg');
  } catch (e) { /* vault even niet te lezen: alleen de databanknamen */ }
  try {
    for (const f of fs.readdirSync(path.join(vault, '20_Prive', 'Gambia', 'Personen'))) {
      if (!/\.md$/.test(f)) continue;
      const n = f.replace(/\.md$/, '').replace(/\s*\(.*\)\s*$/, '').trim();
      if (n.split(/\s+/).length >= 2 && !personen.has(n)) personen.set(n, 'persoon');
    }
  } catch (e) { /* map ontbreekt */ }
  // eigen namenlijst van de machinekamer (namen in ECG-teksten die nergens anders staan: leveranciers, arbeiders); alleen op de pod
  for (const r of a('SELECT naam, soort FROM deel_naam')) if (r.naam && !personen.has(String(r.naam).trim())) personen.set(String(r.naam).trim(), r.soort || 'persoon');
  for (const n of [...personen.keys()]) if (isTweeVrij(n) || prive.has(n)) personen.delete(n);
  const variant = new Map();   // variant → oorspronkelijke naam (zelfde label)
  for (const n of personen.keys()) for (const v of varianten(n)) if (!personen.has(v) && !isTweeVrij(v)) variant.set(v, n);
  for (const n of [...prive]) if (isTweeVrij(n)) prive.delete(n);
  // naamdelen van privé-donateurs: elk woord ≥ 4 letters dat geen algemeen woord is
  const delen = new Set();
  for (const n of prive) for (const w of norm(n).split(/[^a-z]+/)) if (w.length >= 4 && !STOP.has(w)) delen.add(w);
  // rekeningnummers: GHAWA (eigen en tegenrekeningen) en ECG; alleen cijferreeksen van ≥ 6
  const cijf = (s) => { for (const m of cijfersAaneen(String(s || '')).match(/\d{6,}/g) || []) rekeningen.add(m); };
  for (const r of a('SELECT DISTINCT rekening AS x FROM bankregel_ghawa UNION SELECT DISTINCT tegenrekening FROM bankregel_ghawa')) cijf(r.x);
  for (const r of a('SELECT DISTINCT rekening AS x FROM bankregel_ecg UNION SELECT DISTINCT van FROM geldstroom UNION SELECT DISTINCT naar FROM geldstroom')) cijf(r.x);
  for (const r of a('SELECT DISTINCT rekening AS x FROM afschrift')) cijf(r.x);
  for (const r of a('SELECT toelichting AS x FROM instelling')) for (const m of String(r.x || '').match(/\d{8,}/g) || []) rekeningen.add(m);
  for (const r of a("SELECT DISTINCT tegenrekening AS x FROM bankregel_ghawa")) { const iban = String(r.x || '').replace(/\s+/g, '').toUpperCase(); if (/^[A-Z]{2}\d{2}[A-Z0-9]{8,}$/.test(iban)) cijf(iban.slice(4)); }
  return { prive: [...prive], personen, variant, delen: [...delen], rekeningen: [...rekeningen] };
}

// ── poort: alleen tekstwaarden; getallen apart ──
function poortLijsten(l) {
  const namen = [...l.prive, ...l.personen.keys(), ...(l.variant ? l.variant.keys() : [])].filter((n) => norm(n).length >= 4).map((n) => ({ re: naamRe(n) }));
  const delen = l.delen.map((w) => new RegExp('(?<![a-z0-9])' + esc(w) + '(?![a-z0-9])'));
  return { namen, delen, rekeningen: l.rekeningen };
}
function poortTekst(s, p) {   // → reden (zonder de treffer) of null
  const t = String(s);
  for (const n of p.namen) { n.re.lastIndex = 0; if (n.re.test(t)) return 'naam'; }
  const nt = norm(t);
  for (const d of p.delen) if (d.test(nt)) return 'naamdeel';
  if (/(?<![A-Z0-9])[A-Z]{2}\d{2}(?:[ .-]?[A-Z0-9]){11,30}(?![A-Z0-9])/.test(t.toUpperCase())) return 'iban';
  if (/\d{9,}/.test(t)) return 'cijfers';
  const a = cijfersAaneen(t);
  for (const r of p.rekeningen) if (a.indexOf(r) >= 0) return 'rekening';
  return null;
}
function poort(doc, p) {   // → [{plek, reden}] (plek = pad in het document; nooit de waarde)
  const uit = [];
  const loop = (x, plek, sleutel) => {
    if (typeof x === 'string') { const r = poortTekst(x, p); if (r) uit.push({ plek, reden: r }); return; }
    if (typeof x === 'number') {
      if (!Number.isFinite(x) || Math.abs(x) > GRENS || (!FLOAT.has(sleutel) && !Number.isInteger(x))) uit.push({ plek, reden: 'getal' });
      return;
    }
    if (x === null || typeof x === 'boolean') return;
    if (Array.isArray(x)) { x.forEach((y, i) => loop(y, plek + '[' + i + ']', sleutel)); return; }
    if (typeof x === 'object') { for (const k of Object.keys(x)) loop(x[k], plek ? plek + '.' + k : k, k); return; }
    uit.push({ plek, reden: 'vorm' });
  };
  loop(doc, '', '');
  return uit;
}
function technischOk(r) {   // technische velden naast de inhoud, apart op vorm (review ronde 5 MOET 3)
  return /^[0-9a-f]{64}$/.test(r.hash) && Number.isInteger(r.versie) && r.versie >= 0 && Number.isInteger(r.op) && r.op > 0 && Number.isInteger(r.stuk) && r.stuk >= 0;
}

// ── labels en goedgekeurde teksten ──
function maakLabels(l, sleutel) {
  const hm = (s) => crypto.createHmac('sha256', sleutel).update('payee|' + norm(s)).digest();
  const code = (s, n) => { const b = hm(s); let x = ''; for (let i = 0; i < n; i++) x += String.fromCharCode(65 + (b[i] % 26)); return x; };
  const payees = [...l.personen.entries()].filter(([, s]) => s === 'payee').map(([n]) => n);
  let n = 3;
  while (n < 8) { const c = new Map(); let botst = false; for (const p of payees) { const k = code(p, n); if (c.has(k) && norm(c.get(k)) !== norm(p)) botst = true; c.set(k, p); } if (!botst) break; n++; }
  const label = (naam, soort) => (soort === 'payee' ? 'Payee ' + code(naam, n) : soort === 'ecg' ? 'ECG staff' : soort === 'ghawa' ? 'GHAWA board' : soort === 'donor' ? 'a donor' : 'a person');
  const vervang = [...l.personen.entries()].map(([naam, soort]) => ({ naam, label: label(naam, soort) }))
    .concat([...(l.variant || new Map()).entries()].map(([v, n]) => ({ naam: v, label: label(n, l.personen.get(n)) })))
    .concat(l.prive.map((naam) => ({ naam, label: 'a donor' })))
    .filter((x) => norm(x.naam).length >= 4)
    .sort((a, b) => b.naam.length - a.naam.length)
    .map((x) => ({ re: naamRe(x.naam), label: x.label }));
  return {
    payee: (naam) => (naam ? 'Payee ' + code(String(naam).trim(), n) : null),
    tekst: (s) => { let t = String(s); for (const v of vervang) t = t.replace(v.re, v.label); return t; },
  };
}
const REK_LABEL = [[/6240042907|\bGMD\b.*ECG|ECG.*\bGMD\b|^GMD\b/i, 'ECG GMD account'], [/6240042909|ECG EUR|^EUR\b/i, 'ECG EUR account'],
  [/GHAWA/i, 'GHAWA (NL)'], [/Wilde Ganzen/i, 'Wilde Ganzen']];
function rekLabel(v, extra) {
  if (v == null || v === '') return null;
  const s = String(v);
  for (const [re, l] of (extra || []).concat(REK_LABEL)) if (re.test(s)) return l;
  return /\d{4,}/.test(s) ? 'account …' + (s.match(/\d+/g) || ['']).pop().slice(-4) : s;
}
function wieOrg(w) {
  const s = String(w || ''), d = /david/i.test(s), m = /momodou/i.test(s);
  return d && m ? 'ECG / GHAWA' : m ? 'ECG' : d ? 'GHAWA' : null;
}

// ── GHAWA-blok (alleen op de pod: elke giftregel met jaar en bedrag van het vorige gepubliceerde blok) ──
function ghawaBlok(rijen, vorigeGiften, stand, vorigeGroepen) {
  const gift = (r) => GIFT.indexOf(r.soort) >= 0;
  const tot = rijen.filter((r) => r.datum <= stand);
  const standJaar = Number(stand.slice(0, 4));
  const jaren = [...new Set(tot.map((r) => r.jaar))].sort((a, b) => a - b);
  const telJaar = (j) => tot.filter((r) => r.jaar === j && gift(r)).length;
  // jaren met < 10 giftregels samen met het volgende (of het vorige) jaar. Een eenmaal gepubliceerde groep blijft bij elkaar (review wv2889
  // ronde 1 MOET 3: splitsen zou het verschil tussen het oude samengevoegde en het nieuwe losse totaal prijsgeven); groepen kunnen alleen groeien.
  const groepen = (vorigeGroepen || []).map((gr) => gr.slice()).filter((gr) => gr.length);
  const inOud = new Set(groepen.flat());
  let g = [];
  for (const j of jaren) {
    if (inOud.has(j)) continue;
    if (groepen.length && j < groepen[groepen.length - 1][0]) { groepen[groepen.length - 1].push(j); continue; }   // een vergeten vroeg jaar: bij de vroegste groep
    g.push(j); if (g.reduce((n, x) => n + telJaar(x), 0) >= 10) { groepen.push(g); g = []; }
  }
  if (g.length) { if (groepen.length) groepen[groepen.length - 1].push(...g); else groepen.push(g); }
  for (const gr of groepen) gr.sort((a, b) => a - b);
  groepen.sort((a, b) => a[0] - b[0]);
  const groepVan = new Map(); for (const gr of groepen) for (const j of gr) groepVan.set(j, gr);
  const naam = (gr) => (gr.length === 1 ? String(gr[0]) : gr[0] + '–' + gr[gr.length - 1]);
  const som = (l) => l.reduce((s, r) => s + r.bedrag_cent, 0);
  const years = groepen.map((gr) => {
    const rs = tot.filter((r) => gr.indexOf(r.jaar) >= 0);
    return { year: naam(gr), gifts: som(rs.filter(gift)), interest_and_costs: som(rs.filter((r) => RENTE_KOSTEN.indexOf(r.soort) >= 0)),
      to_wilde_ganzen: -som(rs.filter((r) => r.soort === 'Transfer to Wilde Ganzen')), to_ecg: -som(rs.filter((r) => r.soort === 'Transfer to ECG')) };
  });
  const blok = { as_of: stand, years, balance: { eur_cent: som(tot), date: stand } };
  // gewijzigde giften per getal: nieuw, ander bedrag of jaar, verdwenen
  const nu = new Map(tot.filter(gift).map((r) => [r.id, { jaar: r.jaar, bedrag_cent: r.bedrag_cent }]));
  const per = new Map(); let totaal = 0;
  const tel = (jaar) => { const gr = groepVan.get(jaar); const k = gr ? naam(gr) : String(jaar); per.set(k, (per.get(k) || 0) + 1); };
  for (const [id, x] of nu) {
    const o = vorigeGiften.get(id);
    if (!o) { tel(x.jaar); totaal++; } else if (o.jaar !== x.jaar || o.bedrag_cent !== x.bedrag_cent) { tel(x.jaar); if (o.jaar !== x.jaar) tel(o.jaar); totaal++; }
  }
  for (const [id, o] of vorigeGiften) if (!nu.has(id)) { tel(o.jaar); totaal++; }
  const telOk = (n) => n === 0 || n >= 3;
  const redenen = [];
  if (telJaar(standJaar) < 10) redenen.push('lopend jaar < 10 giftregels');
  for (const [k, n] of per) if (!telOk(n)) redenen.push('jaar ' + k + ': ' + n + ' gewijzigd');
  if (!telOk(totaal)) redenen.push('saldo: ' + totaal + ' gewijzigd');
  return { blok, giften: nu, groepen, mag: redenen.length === 0, redenen, gewijzigd: totaal };
}

// ── pakketten ──
function bouwPakketten(x) {
  // x: { k (bereken), d (leesData), rijen {…}, stichting, lab, goed (Map hash→besluit), mijlpalen, gedeeldeOverleggen (Set), blok, stand }
  const nieuw = [];
  const tekst = (v, onderdeel, waar) => {
    if (v == null || v === '') return null;
    const t = maskeer(x.lab.tekst(String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()));
    if (!t) return null;
    const h = sha256(t), b = x.goed.get(h);
    if (b === 'share') return t;
    if (b === 'hold') return HOLD;
    nieuw.push({ hash: h, tekst: t, onderdeel, waar });
    return PENDING;
  };
  // referentie, cheque, aantal: alleen een vaste vorm (elk woord heeft een cijfer, is ≤ 3 tekens of een vast woord); anders langs de tekstgoedkeuring
  // (review wv2889 ronde 1 MOET 1: een naam in een referentieveld ging anders zonder Share en zonder vervangen naar buiten)
  const REF_WOORD = /^(invoice|receipt|inv|ref|no|nr|chq|cheque|part|of|and)$/i;
  const ref = (v, onderdeel, waar) => {
    if (v == null || v === '') return null;
    const m = maskeer(String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim());
    const vorm = m.length <= 40 && /^[A-Za-z0-9…][A-Za-z0-9 .,&\/#…-]*$/.test(m) && m.split(/[ .,&\/#-]+/).filter(Boolean).every((w) => /\d/.test(w) || w.length <= 3 || REF_WOORD.test(w));
    return vorm ? m : tekst(v, onderdeel || 'reference', waar || 'reference');
  };
  const datum = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);
  const k = x.k, d = x.d, r = x.rijen;
  const asOf = { expenditure: k.standen.uitgaven, ecg_gmd: k.standen.ecg_gmd, ecg_eur: k.standen.ecg_eur };
  const pakket = {};
  const pm = (p) => (p == null ? null : Math.round(p * 1000) / 10);
  // Overview
  const blok = x.blok;
  let teWerven = null;
  if (blok) {
    const w = k.werven, koers = k.koers;
    const ghawaVrij = (blok.balance.eur_cent - k.ghawa.geoormerkt) / 100;
    const bouwNa = Math.max(0, k.bouw.open_eur_exact - w.oormerk_bouw), apoNa = Math.max(0, k.apotheek.open_eur_exact - w.oormerk_apo);
    teWerven = Math.round(Math.max(0, bouwNa + apoNa - k.ecg.eur.saldo / 100 - k.ecg.gmd.saldo / 100 / koers - ghawaVrij) * 100);
  }
  const A = k.aansluiting;
  pakket.overview = { as_of: asOf,
    construction: { budget: k.bouw.begroot, realised: k.bouw.gerealiseerd, not_needed: k.bouw.niet_nodig, open: k.bouw.open, pct: pm(k.bouw.pct) },
    pharmacy: { budget: k.apotheek.begroot, open: k.apotheek.open },
    phases: k.fasen.map((f) => ({ id: f.id, name: f.id, budget: f.begroot, realised: f.gerealiseerd, not_needed: f.niet_nodig, open: f.open, pct: pm(f.pct) })),
    ecg_balance: { gmd: k.ecg.gmd.saldo, gmd_date: k.ecg.gmd.datum, eur: k.ecg.eur.saldo, eur_date: k.ecg.eur.datum },
    to_raise_eur_cent: teWerven, to_raise_as_of: blok ? blok.as_of : null,
    reconciliation: [
      { id: 'A', label: AANSLUITING.A, ok: A.A.verschil === 0 && A.A.breuken === 0, difference: A.A.verschil },
      { id: 'B', label: AANSLUITING.B, ok: A.B.niet === 0, difference: A.B.niet },
      { id: 'C', label: AANSLUITING.C, ok: true, difference: 0 },
      { id: 'D', label: AANSLUITING.D, ok: A.D.niet_gespecificeerd === 0, difference: A.D.niet_gespecificeerd },
      { id: 'E', label: AANSLUITING.E, ok: A.E.verschil === 0 && A.E.keten_breuken === 0, difference: null },
      { id: 'F', label: AANSLUITING.F, ok: A.F.verschil === 0, difference: A.F.verschil },
    ] };
  // Construction en Pharmacy
  const uitgPerRegel = new Map(); for (const u of r.uitgaven) { if (!uitgPerRegel.has(u.regel)) uitgPerRegel.set(u.regel, []); uitgPerRegel.get(u.regel).push(u); }
  const regelK = new Map(k.regels.map((x2) => [x2.id, x2]));
  for (const [id, project] of [['construction', 'Building'], ['pharmacy', 'Pharmacy']]) {
    const acts = k.activiteiten.filter((a) => a.project === project);
    const actNr = new Set(acts.map((a) => a.nr));
    const fasen = project === 'Building' ? k.fasen : [Object.assign({ id: 'Pharmacy' }, k.apotheek)];
    const regels = r.regels.filter((x2) => actNr.has(x2.activiteit));
    const rIds = new Set(regels.map((x2) => x2.id));
    pakket[id] = { as_of: asOf,
      phases: fasen.map((f) => ({ id: f.id, name: f.id, description: FASE_EN[f.id] || null, budget: f.begroot, realised: f.gerealiseerd, not_needed: f.niet_nodig, open: f.open, overrun: f.overschrijding || 0 })),
      activities: acts.map((a) => ({ nr: a.nr, phase: a.fase, name: tekst(a.naam, id, 'activity ' + a.nr), status: tekst(a.status, id, 'activity ' + a.nr + ' status'),
        note: tekst(r.actToel.get(a.nr), id, 'activity ' + a.nr + ' note'), budget: a.begroot, realised: a.gerealiseerd, not_needed: a.niet_nodig, open: a.open, overrun: a.overschrijding })),
      lines: regels.map((g) => { const kk = regelK.get(g.id) || {}; return { id: g.id, activity: g.activiteit, item: tekst(g.post, id, 'line ' + g.id), qty: g.aantal == null ? null : ref(g.aantal, id, 'line ' + g.id + ' qty'),
        price: g.prijs_cent, budget: g.begroot_cent, realised: kk.gerealiseerd || 0, open: kk.open == null ? null : kk.open, status: tekst(g.status, id, 'line ' + g.id + ' status') }; }),
      expenditures: r.uitgaven.filter((u) => rIds.has(u.regel)).map((u) => ({ id: u.id, date: datum(u.datum), line: u.regel, description: tekst(u.omschrijving, id, 'expenditure ' + u.id),
        reference: ref(u.referentie, id, 'expenditure ' + u.id + ' reference'), gmd: u.gmd_cent, paid_from: rekLabel(u.betaald_van), method: tekst(u.betaalwijze, id, 'expenditure ' + u.id + ' method'),
        cheque: ref(u.cheque, id, 'expenditure ' + u.id + ' cheque'), evidence: tekst(u.bewijs, id, 'expenditure ' + u.id + ' evidence') })) };
  }
  // ECG accounts
  pakket.accounts = { as_of: asOf,
    balances: [{ account: 'ECG GMD account', currency: 'GMD', balance: k.ecg.gmd.saldo, date: k.ecg.gmd.datum }, { account: 'ECG EUR account', currency: 'EUR', balance: k.ecg.eur.saldo, date: k.ecg.eur.datum }],
    bank: r.bank.map((b) => ({ account: b.munt === 'GMD' ? 'ECG GMD account' : b.munt === 'EUR' ? 'ECG EUR account' : rekLabel(b.rekening), date: datum(b.datum), reference: ref(b.referentie, 'accounts', 'bank reference'),
      amount: b.bedrag_cent, currency: b.munt, balance: b.saldo_cent, kind: tekst(b.soort, 'accounts', 'bank kind'), cheque: ref(b.cheque, 'accounts', 'bank cheque'), payee: b.begunstigde ? x.lab.payee(b.begunstigde) : null })),
    flows: r.stromen.map((s) => ({ id: s.id, date: datum(s.datum), kind: tekst(s.soort, 'accounts', 'flow ' + s.id), from: rekLabel(s.van), to: rekLabel(s.naar), eur: s.eur_cent, gmd: s.gmd_cent,
      rate: s.eur_cent && s.gmd_cent ? Math.round((s.gmd_cent / s.eur_cent) * 100) / 100 : null, reference: ref(s.referentie, 'accounts', 'flow ' + s.id + ' reference'), purpose: tekst(s.doel, 'accounts', 'flow ' + s.id + ' purpose') })) };
  // Funds (alleen Grant / Sponsor / Own funds)
  pakket.funds = { as_of: asOf, funds: r.fondsen.filter((f) => /^(grant|sponsor|own funds)$/i.test(String(f.soort || ''))).map((f) => ({ id: f.id, giver: tekst(f.gever, 'funds', 'fund ' + f.id),
    kind: f.soort, project: f.project, purpose: tekst(f.doel, 'funds', 'fund ' + f.id + ' purpose'), eur: f.eur_cent, date: datum(f.datum), status: tekst(f.status, 'funds', 'fund ' + f.id + ' status'), deadline: datum(f.termijn) })) };
  // GHAWA totals
  pakket.totals = blok ? blok : null;
  // Open questions
  pakket.questions = { as_of: asOf, questions: r.vragen.map((v) => ({ id: v.id, topic: tekst(v.onderwerp, 'questions', 'question ' + v.id + ' topic'), question: tekst(v.vraag, 'questions', 'question ' + v.id),
    gmd: v.gmd_cent, who: wieOrg(v.wie), status: tekst(v.status, 'questions', 'question ' + v.id + ' status'), answer: tekst(v.antwoord, 'questions', 'question ' + v.id + ' answer') })) };
  // Milestones (alleen rijen met een Engelse tekst)
  pakket.milestones = { as_of: asOf, milestones: (x.mijlpalen || []).filter((m) => m.engels).map((m) => ({ order: m.volgorde, when: tekst(m.wanneer, 'milestones', 'milestone ' + m.volgorde + ' when'),
    text: tekst(m.engels, 'milestones', 'milestone ' + m.volgorde), status: tekst(m.stand, 'milestones', 'milestone ' + m.volgorde + ' status') })) };
  // Meetings and decisions: besluiten uit de overdracht + overleggen die David per stuk deelde
  const st = x.stichting || { besluiten: [], overleggen: [], actiepunten: [] };
  const eigenaar = (e) => [...new Set(String(e || '').split(/,| en | and |\//).map((p) => { const n = norm(p); if (!n) return null; if (/\bdavid\b/.test(n)) return 'David'; if (/\bmomodou\b/.test(n)) return 'Momodou';
    const s = x.personenSoort.get(n); return s === 'ecg' ? 'ECG' : s === 'ghawa' ? 'GHAWA' : 'other'; }).filter(Boolean))].join(', ') || null;
  pakket.meetings = { as_of: asOf,
    decisions: st.besluiten.filter((b) => /overdracht/i.test(b.orgaan || '') && !b.overleg).map((b) => ({ date: datum(b.datum), text: tekst(b.tekst, 'meetings', 'decision ' + b.sleutel),
      why: tekst(b.waarom, 'meetings', 'decision ' + b.sleutel + ' why'), source: 'Finance handover' })),
    meetings: st.overleggen.filter((o) => x.gedeeldeOverleggen.has(o.sleutel)).map((o) => ({ date: datum(o.datum), title: tekst(o.titel, 'meetings', 'meeting ' + o.sleutel),
      decisions: st.besluiten.filter((b) => b.overleg === o.sleutel).map((b) => ({ text: tekst(b.tekst, 'meetings', 'decision ' + b.sleutel), why: tekst(b.waarom, 'meetings', 'decision ' + b.sleutel + ' why') })),
      actions: st.actiepunten.filter((a) => a.overleg === o.sleutel).map((a) => ({ text: tekst(a.tekst, 'meetings', 'action ' + a.sleutel), owner: eigenaar(a.eigenaar), deadline: tekst(a.termijn, 'meetings', 'action ' + a.sleutel + ' deadline') })) })) };
  return { pakket, nieuw };
}

// Mijlpalen met een kolom English uit de projectpagina (fase 4 leest de tabel zonder die kolom)
function mijlpalenEngels(vault, S) {
  let md = '';
  try { md = fs.readFileSync(path.join(vault, S.BRONNEN.project), 'utf8'); } catch (e) { return { rijen: [], zonder: 0 }; }
  const sec = S.sectie(md, /^Mijlpalen/i);
  if (!sec) return { rijen: [], zonder: 0 };
  const t = S.tabellen(sec.tekst)[0];
  if (!t) return { rijen: [], zonder: 0 };
  const kol = (re) => t.kop.findIndex((c) => re.test(String(c).replace(/\*/g, '').trim()));
  const iW = kol(/^wanneer$/i), iE = kol(/^english$/i), iS = kol(/^stand$/i);
  const rijen = t.rijen.map((c, i) => ({ volgorde: i + 1, wanneer: iW >= 0 ? S.ontlink(c[iW]) : null, engels: iE >= 0 ? S.ontlink(c[iE]) : null, stand: iS >= 0 ? S.ontlink(c[iS]) : null }));
  return { rijen, zonder: rijen.filter((m) => !m.engels).length };
}

// ── de module ──
function maak(o) {
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const G = o.ghawa || require('./ghawa.js'), S = o.stichting || require('./ghawa-stichting.js');
  const { DatabaseSync } = require('node:sqlite');
  const fout = (l, e) => { if (o.fout) o.fout(l, e); };
  const open = (lezen) => { const db = new DatabaseSync(o.dbPad, lezen ? { readOnly: true } : {}); db.exec('PRAGMA busy_timeout = 5000'); return db; };
  { const db = open(false); try { db.exec(LOKAAL_SCHEMA); try { db.exec('ALTER TABLE deel_kijker ADD COLUMN weg_bevestigd TEXT'); } catch (e) { /* bestaat al */ } } finally { db.close(); } }
  const metDb = (fn) => { const db = open(false); try { return fn(db); } finally { db.close(); } };
  const stand = (k) => metDb((db) => { const r = db.prepare('SELECT waarde FROM deel_stand WHERE sleutel = ?').get(k); return r ? r.waarde : null; });
  const standZet = (k, v) => metDb((db) => db.prepare('INSERT INTO deel_stand (sleutel, waarde) VALUES (?, ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde').run(k, String(v)));
  // HMAC-sleutel voor de payee-labels (alleen op de pod, 0600)
  const SLEUTEL_PAD = path.join(path.dirname(o.dbPad), 'deel-sleutel');
  let sleutel;
  try { sleutel = fs.readFileSync(SLEUTEL_PAD); } catch (e) { try { fs.writeFileSync(SLEUTEL_PAD, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch (e2) { /* tegelijk aangemaakt */ } sleutel = fs.readFileSync(SLEUTEL_PAD); }
  if (sleutel.length < 32) throw new Error('deel-sleutel te kort');

  // alles wat een ronde nodig heeft, in één keer gelezen
  function lees() {
    const d = G.leesData(o.dbPad); d.vandaag = amsDag(nu());
    const k = G.bereken(d);
    const db = open(true);
    let rijen, l, goed, gedeeld, vorig, ghawaRijen, blokOud, groepen, kandidaat;
    try {
      const a = (sql, ...p) => db.prepare(sql).all(...p);
      rijen = { regels: a('SELECT id, activiteit, post, aantal, prijs_cent, begroot_cent, status FROM begrotingsregel ORDER BY volgorde'),
        uitgaven: a('SELECT id, datum, regel, omschrijving, referentie, gmd_cent, betaald_van, betaalwijze, cheque, bewijs FROM uitgave ORDER BY id'),
        bank: a('SELECT rekening, datum, referentie, bedrag_cent, munt, saldo_cent, soort, cheque, begunstigde FROM bankregel_ecg ORDER BY volg'),
        stromen: a('SELECT id, datum, soort, van, naar, eur_cent, gmd_cent, doel, referentie FROM geldstroom ORDER BY id'),
        fondsen: a('SELECT id, gever, soort, project, doel, eur_cent, datum, status, termijn FROM fonds ORDER BY id'),
        vragen: a('SELECT id, onderwerp, vraag, gmd_cent, wie, status, antwoord FROM open_vraag ORDER BY id'),
        actToel: new Map(a('SELECT nr, toelichting FROM activiteit').map((x) => [x.nr, x.toelichting])) };
      l = lijstenVan(db, o.vault, S);
      goed = new Map(a('SELECT hash, besluit FROM deel_tekst').map((x) => [x.hash, x.besluit]));
      gedeeld = new Set(a('SELECT sleutel FROM deel_overleg').map((x) => x.sleutel));
      vorig = new Map(a('SELECT id, jaar, bedrag_cent FROM deel_gift').map((x) => [x.id, { jaar: x.jaar, bedrag_cent: x.bedrag_cent }]));
      ghawaRijen = a('SELECT id, datum, jaar, bedrag_cent, soort FROM bankregel_ghawa');   // INTERN: alleen voor het blok, nooit in een pakket
      const b = db.prepare("SELECT waarde FROM deel_stand WHERE sleutel = 'ghawa_blok'").get();
      blokOud = b ? JSON.parse(b.waarde) : null;
      const gr = db.prepare("SELECT waarde FROM deel_stand WHERE sleutel = 'ghawa_groepen'").get();
      groepen = gr ? JSON.parse(gr.waarde) : null;
      const kd = db.prepare("SELECT waarde FROM deel_stand WHERE sleutel = 'ghawa_kandidaat'").get();
      kandidaat = kd && kd.waarde ? new Map(JSON.parse(kd.waarde)) : null;
    } finally { db.close(); }
    let stichting = null;
    try { stichting = S.leesVault(o.vault); } catch (e) { fout('ghawa-deel-vault', e); }
    const mp = mijlpalenEngels(o.vault, S);
    const personenSoort = new Map([...l.personen.entries()].map(([n, s]) => [norm(n), s]));
    return { d, k, rijen, l, goed, gedeeld, vorig, ghawaRijen, blokOud, groepen, kandidaat, stichting, mp, personenSoort };
  }
  function bouw(x, opties) {
    const lab = maakLabels(x.l, sleutel);
    const st = eindVorigeMaand(nu());
    const sb = ghawaBlok(x.ghawaRijen, x.vorig, st, x.groepen);
    // review wv2889 ronde 1 MOET 4: een blok dat misschien buiten staat (push zonder bevestiging) telt ook als vergelijking
    const sbK = x.kandidaat ? ghawaBlok(x.ghawaRijen, x.kandidaat, st, x.groepen) : null;
    if (sbK && !sbK.mag) { sb.mag = false; sb.redenen = sb.redenen.concat(sbK.redenen.map((r) => 'kandidaat: ' + r)); }
    const blok = sb.mag ? sb.blok : x.blokOud;
    sb.nieuw = sb.mag && JSON.stringify(sb.blok) !== JSON.stringify(x.blokOud);
    const b = bouwPakketten({ k: x.k, d: x.d, rijen: x.rijen, stichting: x.stichting, lab, goed: x.goed, mijlpalen: x.mp.rijen, gedeeldeOverleggen: x.gedeeld, blok, personenSoort: x.personenSoort });
    const p = poortLijsten(x.l);
    // een nieuwe tekst die zelf de poort niet haalt, kan David niet delen
    for (const t of b.nieuw) t.poort_ok = poortTekst(t.tekst, p) === null;
    return { pakket: b.pakket, nieuw: b.nieuw, poortL: p, sb, blokGebruikt: blok, opties };
  }

  // ── één wachtrij voor alle D1-schrijfacties ──
  const rij = []; let loopt = false, aanroepen = 0;
  async function d1(batch) {
    if (++aanroepen > MAX_AANROEPEN) throw new Error('grens aanroepen per ronde');
    return o.d1(batch);
  }
  function inRij(fn, voor) {
    return new Promise((ok, nee) => {
      const t = { fn, ok, nee };
      if (voor) { let i = 0; while (i < rij.length && rij[i].voor) i++; t.voor = true; rij.splice(i, 0, t); } else rij.push(t);
      draai();
    });
  }
  async function draai() {
    if (loopt) return;
    loopt = true;
    try {
      while (rij.length) {
        const t = rij.shift(); aanroepen = 0;
        try { t.ok(await t.fn()); } catch (e) { t.nee(e); }
      }
    } finally { loopt = false; }
  }
  let schemaKlaar = false;
  async function zorgSchema() { if (!schemaKlaar) { await d1(D1_SCHEMA.map((sql) => ({ sql, params: [] }))); schemaKlaar = true; } }

  // intrekken: eerst de blijvende blok-rij, dan de inhoud weg; bevestigd = D1 gaf succes
  async function sluitOnderdeel(id, reden) {
    await zorgSchema();
    const t = nu();
    metDb((db) => db.prepare('INSERT INTO deel_obj (onderdeel, dicht) VALUES (?, ?) ON CONFLICT (onderdeel) DO UPDATE SET dicht = excluded.dicht, dicht_bevestigd = NULL').run(id, iso(t)));
    await d1([{ sql: 'INSERT INTO blok (soort, sleutel, op) VALUES (?, ?, ?) ON CONFLICT (soort, sleutel) DO UPDATE SET op = excluded.op', params: ['onderdeel', id, t] },
      { sql: 'DELETE FROM deel WHERE onderdeel = ?', params: [id] }, { sql: 'DELETE FROM publicatie WHERE onderdeel = ?', params: [id] }]);
    metDb((db) => db.prepare('UPDATE deel_obj SET hash = NULL, stukken = NULL, dicht_bevestigd = ? WHERE onderdeel = ?').run(iso(nu()), id));
    return { ok: true, onderdeel: id, reden: reden || 'uit' };
  }
  async function heropenOnderdeel(id) {
    await zorgSchema();
    await d1([{ sql: 'DELETE FROM blok WHERE soort = ? AND sleutel = ?', params: ['onderdeel', id] }]);
    metDb((db) => db.prepare('UPDATE deel_obj SET dicht = NULL, dicht_bevestigd = NULL WHERE onderdeel = ?').run(id));
  }
  async function kijkerD1(hash, erbij, rol) {
    await zorgSchema();
    if (erbij) await d1([{ sql: 'DELETE FROM blok WHERE soort = ? AND sleutel = ?', params: ['bezoeker', hash] },
      { sql: 'INSERT INTO bezoeker (hash, rol) VALUES (?, ?) ON CONFLICT (hash) DO UPDATE SET rol = excluded.rol', params: [hash, rol] }]);
    else await d1([{ sql: 'INSERT INTO blok (soort, sleutel, op) VALUES (?, ?, ?) ON CONFLICT (soort, sleutel) DO UPDATE SET op = excluded.op', params: ['bezoeker', hash, nu()] },
      { sql: 'DELETE FROM bezoeker WHERE hash = ?', params: [hash] }]);
  }
  async function noodD1(aan) {
    await zorgSchema();
    await d1([{ sql: 'INSERT INTO stand (sleutel, waarde) VALUES (?, ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde', params: ['noodstop', aan ? '1' : '0'] }]);
    standZet('noodstop_d1', aan ? '1' : '0');
  }
  function signaal(id, tekst) {   // één regel in Vraagt aandacht (ghawa.js toont de tabel signaal); nooit de treffer zelf
    metDb((db) => { try { db.prepare("INSERT INTO signaal (id, soort, tekst, op) VALUES (?, 'delen', ?, ?) ON CONFLICT (id) DO UPDATE SET tekst = excluded.tekst, op = excluded.op, dicht_op = NULL").run('delen:' + id, tekst, iso(nu())); } catch (e) { fout('ghawa-deel-signaal', e); } });
  }
  function signaalDicht(id) { metDb((db) => { try { db.prepare("UPDATE signaal SET dicht_op = ? WHERE id = ? AND dicht_op IS NULL").run(iso(nu()), 'delen:' + id); } catch (e) { /* geen tabel */ } }); }
  const naamNl = (id) => (ONDERDELEN.find((x) => x[0] === id) || [id, id, id])[2];

  // één onderdeel naar D1 (DELETE + voorwaardelijke INSERT in één batch)
  async function zet(id, doc) {
    const json = JSON.stringify(doc), h = sha256(json), t = nu();
    const stukken = []; for (let i = 0; i < json.length; i += STUK) stukken.push(json.slice(i, i + STUK));
    const obj = metDb((db) => db.prepare('SELECT * FROM deel_obj WHERE onderdeel = ?').get(id)) || {};
    const versie = (obj.versie || 0) + 1;
    const nb = "NOT EXISTS (SELECT 1 FROM blok WHERE soort = 'onderdeel' AND sleutel = ?)";
    const batch = [{ sql: 'DELETE FROM deel WHERE onderdeel = ? AND ' + nb, params: [id, id] }];
    stukken.forEach((s, i) => { const r = { hash: h, versie, op: t, stuk: i }; if (!technischOk(r)) throw new Error('technisch veld'); batch.push({ sql: 'INSERT INTO deel (onderdeel, stuk, json, hash, op) SELECT ?, ?, ?, ?, ? WHERE ' + nb, params: [id, i, s, h, t, id] }); });
    batch.push({ sql: 'INSERT INTO publicatie (onderdeel, versie, stukken, hash, geldig_tot) SELECT ?, ?, ?, ?, ? WHERE ' + nb + ' ON CONFLICT (onderdeel) DO UPDATE SET versie = excluded.versie, stukken = excluded.stukken, hash = excluded.hash, geldig_tot = excluded.geldig_tot',
      params: [id, versie, stukken.length, h, t + HOUDBAAR_MS, id] });
    const r = await d1(batch);
    const geplaatst = Array.isArray(r) && r[1] && r[1].meta ? r[1].meta.changes !== 0 : true;
    metDb((db) => db.prepare('INSERT INTO deel_obj (onderdeel, hash, stukken, versie, op, vers_op) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (onderdeel) DO UPDATE SET hash = excluded.hash, stukken = excluded.stukken, versie = excluded.versie, op = excluded.op, vers_op = excluded.vers_op')
      .run(id, geplaatst ? h : null, geplaatst ? stukken.length : null, versie, iso(t), iso(t)));
    return geplaatst;
  }
  async function verleng(ids) {
    if (!ids.length) return;
    const t = nu();
    await d1(ids.map((id) => ({ sql: "UPDATE publicatie SET geldig_tot = ? WHERE onderdeel = ? AND NOT EXISTS (SELECT 1 FROM blok WHERE soort = 'onderdeel' AND sleutel = ?)", params: [t + HOUDBAAR_MS, id, id] })));
    metDb((db) => { const u = db.prepare('UPDATE deel_obj SET vers_op = ? WHERE onderdeel = ?'); for (const id of ids) u.run(iso(t), id); });
  }
  const isAan = (id) => stand('aan:' + id) === '1';

  // de gewone ronde: schakelaars vlak vóór de batch opnieuw gelezen
  async function ronde() {
    await zorgSchema();
    const uit = { gezet: [], dicht: [], vers: [], poort: [], blok: null };
    const nood = stand('noodstop') === '1';
    if (stand('noodstop_d1') !== (nood ? '1' : '0')) await noodD1(nood);
    await bezoekersSync();
    const aan = IDS.filter(isAan);
    // onderdelen die uit staan maar nog (deels) buiten: dicht
    const objs = metDb((db) => db.prepare('SELECT * FROM deel_obj').all());
    for (const ob of objs) if (!aan.includes(ob.onderdeel) && (ob.hash || (ob.dicht && !ob.dicht_bevestigd) || !ob.dicht)) { await sluitOnderdeel(ob.onderdeel, 'uit'); uit.dicht.push(ob.onderdeel); }
    if (!aan.length) return uit;
    const x = lees(), b = bouw(x);
    // het GHAWA-blok: vóór de push als kandidaat (telt mee als vergelijking als de push onbevestigd blijft), na een bevestigde push vastgelegd
    // als de nieuwe vergelijking (review wv2889 ronde 1 MOET 4)
    const metBlok = ['totals', 'overview'];
    let blokVast = false;
    const legVast = () => {
      if (blokVast) return;
      metDb((db) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM deel_gift').run();
          const ins = db.prepare('INSERT INTO deel_gift (id, jaar, bedrag_cent) VALUES (?, ?, ?)');
          for (const [gid, g] of b.sb.giften) ins.run(gid, g.jaar, g.bedrag_cent);
          const zetS = db.prepare('INSERT INTO deel_stand (sleutel, waarde) VALUES (?, ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde');
          zetS.run('ghawa_blok', JSON.stringify(b.sb.blok)); zetS.run('ghawa_groepen', JSON.stringify(b.sb.groepen));
          db.prepare("DELETE FROM deel_stand WHERE sleutel = 'ghawa_kandidaat'").run();
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      });
      blokVast = true;
    };
    if (b.sb.nieuw && metBlok.some(isAan)) standZet('ghawa_kandidaat', JSON.stringify([...b.sb.giften]));
    uit.blok = { nieuw: !!b.sb.nieuw, gewijzigd: b.sb.gewijzigd, redenen: b.sb.redenen.length };
    for (const id of IDS.filter(isAan)) {   // opnieuw gelezen: tussendoor uitgezet = niet meer zetten
      const doc = b.pakket[id];
      if (!doc) continue;
      const tr = poort(doc, b.poortL);
      if (tr.length) {
        standZet('aan:' + id, '0');
        await sluitOnderdeel(id, 'poort');
        signaal(id, 'Delen met ECG: ' + naamNl(id) + ' is dichtgezet; de poort vond iets dat niet naar buiten mag (' + tr.slice(0, 3).map((t) => t.plek + ' ' + t.reden).join('; ') + '). Zet het pas weer aan als dat eruit is.');
        uit.poort.push(id); continue;
      }
      const h = sha256(JSON.stringify(doc));
      const ob = metDb((db) => db.prepare('SELECT * FROM deel_obj WHERE onderdeel = ?').get(id)) || {};
      if (ob.hash !== h) { if (await zet(id, doc)) { uit.gezet.push(id); if (b.sb.nieuw && metBlok.includes(id)) legVast(); } }
      else if (!ob.vers_op || nu() - Date.parse(ob.vers_op) >= VERS_MS) uit.vers.push(id);
    }
    await verleng(uit.vers);
    standZet('laatste_ronde', iso(nu()));
    if (uit.gezet.length || uit.vers.length) standZet('laatste_push', iso(nu()));
    return uit;
  }
  async function bezoekersSync() {
    const w = metDb((db) => db.prepare('SELECT hash, rol FROM deel_kijker WHERE weg_op IS NULL ORDER BY hash').all()).map((r) => ({ hash: r.hash, rol: r.rol }));
    const h = sha256(JSON.stringify(w));
    if (stand('bezoekers_hash') === h) return false;
    const weg = metDb((db) => db.prepare('SELECT hash FROM deel_kijker WHERE weg_op IS NOT NULL').all()).map((r) => r.hash);
    const batch = [];
    for (const x of weg) batch.push({ sql: 'INSERT INTO blok (soort, sleutel, op) VALUES (?, ?, ?) ON CONFLICT (soort, sleutel) DO NOTHING', params: ['bezoeker', x, nu()] }, { sql: 'DELETE FROM bezoeker WHERE hash = ?', params: [x] });
    batch.push({ sql: 'DELETE FROM bezoeker WHERE hash NOT IN (' + (w.map(() => '?').join(', ') || "''") + ')', params: w.map((r) => r.hash) });
    for (const r of w) batch.push({ sql: "INSERT INTO bezoeker (hash, rol) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM blok WHERE soort = 'bezoeker' AND sleutel = ?) ON CONFLICT (hash) DO UPDATE SET rol = excluded.rol", params: [r.hash, r.rol, r.hash] });
    await d1(batch);
    standZet('bezoekers_hash', h); standZet('bezoekers_n', w.length);
    return true;
  }
  // dagelijks: wat buiten staat teruglezen en door de poort met de actuele lijsten
  async function terugLees() {
    await zorgSchema();
    const res = await d1([{ sql: 'SELECT onderdeel, stuk, json FROM deel ORDER BY onderdeel, stuk', params: [] }]);
    const rijen = (res[0] && res[0].results) || [];
    const per = new Map(); for (const r of rijen) per.set(r.onderdeel, (per.get(r.onderdeel) || '') + r.json);
    const db = open(true); let l; try { l = lijstenVan(db, o.vault, S); } finally { db.close(); }
    const p = poortLijsten(l), uit = { gelezen: per.size, dicht: [], ok: [] };
    for (const [id, json] of per) {
      let doc = null; try { doc = JSON.parse(json); } catch (e) { doc = null; }
      const tr = doc ? poort(doc, p) : [{ plek: '', reden: 'kapot' }];
      if (tr.length || IDS.indexOf(id) < 0) {
        standZet('aan:' + id, '0'); await sluitOnderdeel(id, 'teruglezen');
        signaal(id, 'Delen met ECG: ' + naamNl(id) + ' is dichtgezet bij de dagelijkse controle van wat buiten staat (' + tr.slice(0, 3).map((t) => t.plek + ' ' + t.reden).join('; ') + ').');
        uit.dicht.push(id);
      } else uit.ok.push(id);
    }
    await verleng(uit.ok.filter(isAan));
    standZet('laatste_terug', iso(nu())); standZet('laatste_terug_uit', JSON.stringify({ gelezen: uit.gelezen, dicht: uit.dicht.length }));
    return uit;
  }
  async function logOphalen() {
    await zorgSchema();
    const m = metDb((db) => (db.prepare('SELECT max(id) m FROM deel_log').get() || {}).m || 0);
    const res = await d1([{ sql: 'SELECT id, hash, onderdeel, op FROM log WHERE id > ? ORDER BY id LIMIT 2000', params: [m] }]);
    const rijen = (res[0] && res[0].results) || [];
    if (!rijen.length) return 0;
    metDb((db) => { const ins = db.prepare('INSERT OR IGNORE INTO deel_log (id, hash, onderdeel, op) VALUES (?, ?, ?, ?)'); for (const r of rijen) ins.run(r.id, String(r.hash), String(r.onderdeel).slice(0, 20), iso(Number(r.op) || nu())); db.prepare('DELETE FROM deel_log WHERE op < ?').run(iso(nu() - 365 * 24 * 3600000)); });
    await d1([{ sql: 'DELETE FROM log WHERE id <= ?', params: [rijen[rijen.length - 1].id] }]);
    return rijen.length;
  }

  // ── de tik (server.js, elke minuut): open intrekkingen opnieuw, ronde bij een wijziging (≥ 15 min) of elke 6 u, teruglezen 1×/dag, log 1×/uur ──
  let laatst = null, vuil = 1, gedaan = 0, laatsteRonde = 0, laatsteLog = 0;
  async function tik(dwing) {
    const u = { op: iso(nu()) };
    try {
      if (!IDS.some(isAan) && !metDb((db) => db.prepare('SELECT 1 FROM deel_obj LIMIT 1').get()) && !metDb((db) => db.prepare('SELECT 1 FROM deel_kijker LIMIT 1').get()) && stand('noodstop') !== '1' && stand('noodstop_d1') !== '1') { laatst = u; return u; }
      // intrekkingen die nog niet bevestigd zijn: elke minuut opnieuw, vooraan
      const open1 = metDb((db) => db.prepare('SELECT onderdeel FROM deel_obj WHERE dicht IS NOT NULL AND dicht_bevestigd IS NULL').all()).map((r) => r.onderdeel);
      for (const id of open1) await inRij(() => sluitOnderdeel(id, 'opnieuw'), true);
      // review wv2889 ronde 1 MOET 2: ook een noodstop of iemand eraf die D1 nog niet bevestigde, elke minuut opnieuw en vooraan
      const nood = stand('noodstop') === '1';
      if (stand('noodstop_d1') !== (nood ? '1' : '0') && (nood || stand('noodstop_d1') === '1')) await inRij(() => noodD1(nood), true);
      for (const r of metDb((db) => db.prepare('SELECT hash FROM deel_kijker WHERE weg_op IS NOT NULL AND weg_bevestigd IS NULL').all())) {
        await inRij(() => kijkerD1(r.hash, false), true);
        metDb((db) => db.prepare('UPDATE deel_kijker SET weg_bevestigd = ? WHERE hash = ? AND weg_op IS NOT NULL').run(iso(nu()), r.hash));
      }
      if (dwing || (vuil !== gedaan && nu() - laatsteRonde >= RONDE_MS) || nu() - laatsteRonde >= VERS_MS) {
        const start = vuil;
        u.ronde = await inRij(ronde); laatsteRonde = nu(); gedaan = start;
      }
      const lt = stand('laatste_terug');
      if (IDS.some(isAan) && (!lt || nu() - Date.parse(lt) >= TERUG_MS)) u.terug = await inRij(terugLees);
      if (nu() - laatsteLog >= LOG_MS) { u.log = await inRij(logOphalen); laatsteLog = nu(); }
    } catch (e) { fout('ghawa-deel-tik', e); u.fout = String(e && e.message || e).replace(/[^\w .:-]/g, '').slice(0, 80); standZet('laatste_fout', iso(nu())); }
    laatst = u;
    return u;
  }

  // ── voor de app (Apps › GHAWA › Delen met ECG) ──
  async function schakel(id, aan) {
    if (IDS.indexOf(id) < 0) return { status: 404, body: { ok: false, fout: 'onbekend onderdeel' } };
    if (!aan) {   // uit: meteen, vooraan, bevestigd
      standZet('aan:' + id, '0');
      try { await inRij(() => sluitOnderdeel(id, 'uit'), true); return { status: 200, body: { ok: true, dicht: true } }; }
      catch (e) { fout('ghawa-deel-uit', e); return { status: 200, body: { ok: true, dicht: false, fout: 'nog niet dicht; de pod probeert het elke minuut opnieuw' } }; }
    }
    // aan: eerst het pakket door de poort; rood = blijft dicht
    const x = lees(), b = bouw(x);
    const doc = b.pakket[id];
    const tr = doc ? poort(doc, b.poortL) : [];
    if (tr.length) return { status: 409, body: { ok: false, fout: 'Dit onderdeel haalt de poort niet (' + tr.slice(0, 3).map((t) => t.plek + ' ' + t.reden).join('; ') + '); het blijft dicht.' } };
    standZet('aan:' + id, '1'); signaalDicht(id);
    vuil++;
    try { await inRij(() => heropenOnderdeel(id), true); await inRij(ronde); laatsteRonde = nu(); return { status: 200, body: { ok: true, aan: true, leeg: !doc } }; }
    catch (e) { fout('ghawa-deel-aan', e); return { status: 200, body: { ok: true, aan: true, fout: 'staat aan; de eerste push volgt binnen een paar minuten' } }; }
  }
  async function noodstop(aan) {
    standZet('noodstop', aan ? '1' : '0');
    try { await inRij(() => noodD1(aan), true); return { status: 200, body: { ok: true, noodstop: aan, bevestigd: true } }; }
    catch (e) { fout('ghawa-deel-nood', e); return { status: 200, body: { ok: true, noodstop: aan, bevestigd: false, fout: 'nog niet bevestigd; de pod probeert het elke minuut opnieuw' } }; }
  }
  async function kijkerErbij(b, door) {
    const naam = String(b && b.naam || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 60);
    const adres = String(b && b.adres || '').normalize('NFC').trim().toLowerCase();
    if (naam.length < 2 || !/^[^\s@<>"]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/.test(adres)) return { status: 400, body: { ok: false, fout: 'naam en een geldig mailadres nodig' } };
    const rol = b && b.rol === 'eigenaar' ? 'eigenaar' : 'ecg';
    const h = adresHash(adres);
    metDb((db) => db.prepare('INSERT INTO deel_kijker (hash, naam, adres, rol, op, door) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (hash) DO UPDATE SET naam = excluded.naam, rol = excluded.rol, op = excluded.op, door = excluded.door, weg_op = NULL, weg_bevestigd = NULL')
      .run(h, naam, adres, rol, iso(nu()), String(door || '').slice(0, 40)));
    try { await inRij(() => kijkerD1(h, true, rol), true); standZet('bezoekers_hash', ''); } catch (e) { fout('ghawa-deel-kijker', e); }
    return { status: 200, body: { ok: true, hash: h, rol, toegang_nodig: true } };
  }
  async function kijkerEraf(hash) {
    if (!/^[0-9a-f]{64}$/.test(String(hash || ''))) return { status: 400, body: { ok: false, fout: 'onbekend' } };
    metDb((db) => db.prepare('UPDATE deel_kijker SET weg_op = ?, weg_bevestigd = NULL WHERE hash = ?').run(iso(nu()), hash));
    try { await inRij(() => kijkerD1(hash, false), true); metDb((db) => db.prepare('UPDATE deel_kijker SET weg_bevestigd = ? WHERE hash = ?').run(iso(nu()), hash)); standZet('bezoekers_hash', ''); return { status: 200, body: { ok: true, dicht: true } }; }
    catch (e) { fout('ghawa-deel-kijker', e); return { status: 200, body: { ok: true, dicht: false, fout: 'nog niet dicht; de pod probeert het elke minuut opnieuw' } }; }
  }
  function tekstBesluit(hash, besluit, door, opties) {
    opties = opties || {};
    if (!/^[0-9a-f]{64}$/.test(String(hash || '')) || ['share', 'hold'].indexOf(besluit) < 0) return { status: 400, body: { ok: false, fout: 'onbekend' } };
    if (besluit === 'share' && opties.poortBijDelen !== false) {   // een tekst die zelf de poort niet haalt, kan niet gedeeld worden
      const b = bouw(lees()), t = b.nieuw.find((x) => x.hash === hash);
      if (t && !t.poort_ok) return { status: 409, body: { ok: false, fout: 'Deze tekst bevat een naam of nummer dat niet naar buiten mag; houd hem vast.' } };
    }
    metDb((db) => db.prepare('INSERT INTO deel_tekst (hash, besluit, op, door) VALUES (?, ?, ?, ?) ON CONFLICT (hash) DO UPDATE SET besluit = excluded.besluit, op = excluded.op, door = excluded.door').run(hash, besluit, iso(nu()), String(door || '').slice(0, 40)));
    vuil++;
    return { status: 200, body: { ok: true } };
  }
  function overlegDeel(sleutel, aan, door) {
    if (!/^[0-9a-f]{12}$/.test(String(sleutel || ''))) return { status: 400, body: { ok: false, fout: 'onbekend' } };
    metDb((db) => (aan ? db.prepare('INSERT OR REPLACE INTO deel_overleg (sleutel, op, door) VALUES (?, ?, ?)').run(sleutel, iso(nu()), String(door || '').slice(0, 40)) : db.prepare('DELETE FROM deel_overleg WHERE sleutel = ?').run(sleutel)));
    vuil++;
    return { status: 200, body: { ok: true } };
  }
  function staat() {   // het scherm Delen met ECG (alleen Davids eigen app)
    const x = lees(), b = bouw(x);
    const objs = new Map(metDb((db) => db.prepare('SELECT * FROM deel_obj').all()).map((r) => [r.onderdeel, r]));
    const kijkers = metDb((db) => db.prepare('SELECT hash, naam, adres, rol, op FROM deel_kijker WHERE weg_op IS NULL ORDER BY op').all());
    const log = metDb((db) => db.prepare('SELECT hash, onderdeel, op FROM deel_log ORDER BY id DESC LIMIT 30').all());
    const naamVan = new Map(metDb((db) => db.prepare('SELECT hash, naam FROM deel_kijker').all()).map((r) => [r.hash, r.naam]));
    const rijenIn = (doc) => { if (!doc) return 0; let n = 0; for (const v of Object.values(doc)) if (Array.isArray(v)) n += v.length; return n; };
    const onderdelen = ONDERDELEN.map(([id, en, nl]) => {
      const ob = objs.get(id) || {}, aan = isAan(id), doc = b.pakket[id];
      const st = aan ? (ob.hash ? 'gedeeld' : 'wacht') : ob.dicht && !ob.dicht_bevestigd ? 'nog_niet_dicht' : 'uit';
      return { id, naam: nl, engels: en, aan, stand: st, rijen: rijenIn(doc), leeg: !doc, laatste_push: ob.op || null, ververst: ob.vers_op || null,
        geldig_tot: ob.vers_op ? iso(Date.parse(ob.vers_op) + HOUDBAAR_MS) : null, wachtend: b.nieuw.filter((t) => t.onderdeel === id).length };
    });
    const uniek = new Map(); for (const t of b.nieuw) if (!uniek.has(t.hash)) uniek.set(t.hash, t);
    const tellen = metDb((db) => db.prepare('SELECT besluit, count(*) n FROM deel_tekst GROUP BY besluit').all());
    return {
      site: 'https://ghawa.socev.dev', noodstop: stand('noodstop') === '1', onderdelen,
      kijkers: kijkers.map((k) => { const l = log.filter((r) => r.hash === k.hash); return { hash: k.hash, naam: k.naam, adres: k.adres, rol: k.rol, sinds: k.op, laatst: l.length ? l[0].op : null }; }),
      teksten: [...uniek.values()].slice(0, 200).map((t) => ({ hash: t.hash, tekst: t.tekst, onderdeel: t.onderdeel, waar: t.waar, poort_ok: t.poort_ok })),
      teksten_aantal: uniek.size, teksten_besluit: Object.fromEntries(tellen.map((r) => [r.besluit, r.n])),
      overleggen: ((x.stichting && x.stichting.overleggen) || []).map((ov) => ({ sleutel: ov.sleutel, datum: ov.datum, titel: ov.titel, gedeeld: x.gedeeld.has(ov.sleutel) })),
      mijlpalen_zonder_engels: x.mp.zonder, mijlpalen: x.mp.rijen.length,
      ghawa_blok: { stand: b.blokGebruikt ? b.blokGebruikt.as_of : null, nieuw_mag: b.sb.mag, wacht_reden: b.sb.mag ? null : (b.sb.redenen.some((r) => /lopend jaar/.test(r)) ? 'het lopende jaar heeft nog te weinig giften' : 'te weinig gewijzigde giften sinds het vorige blok') },
      log: log.map((r) => ({ naam: naamVan.get(r.hash) || 'onbekend', onderdeel: r.onderdeel, op: r.op })),
      laatste_push: stand('laatste_push'), laatste_ronde: stand('laatste_ronde'), laatste_terug: stand('laatste_terug'),
      fout: laatst && laatst.fout ? 'De laatste ronde naar buiten lukte niet; de pod probeert het opnieuw.' : null,
    };
  }
  function health() {
    let aan = 0; try { aan = IDS.filter(isAan).length; } catch (e) { aan = -1; }
    return { aan: true, onderdelen_aan: aan, noodstop: stand('noodstop') === '1', laatste_push: stand('laatste_push'), laatste_ronde: stand('laatste_ronde'),
      laatste_terug: stand('laatste_terug'), kijkers: Number(stand('bezoekers_n') || 0), fout: !!(laatst && laatst.fout) };
  }
  function markeerVuil() { vuil++; }
  return { tik, ronde: () => inRij(ronde), terugLees: () => inRij(terugLees), logOphalen: () => inRij(logOphalen), schakel, noodstop, kijkerErbij, kijkerEraf, tekstBesluit, overlegDeel,
    staat, health, markeerVuil, _lees: lees, _bouw: bouw, _rij: inRij, _zet: zet };
}

module.exports = { maak, varianten, poort, poortTekst, poortLijsten, lijstenVan, maakLabels, ghawaBlok, bouwPakketten, mijlpalenEngels, maskeer, chequeNamen, adresHash,
  eindVorigeMaand, technischOk, DEEL_KOLOMMEN, D1_SCHEMA, IDS, ONDERDELEN, PENDING, HOLD, GIFT };
