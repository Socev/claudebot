'use strict';
/*
 * pot-datahub.js — nieuwe POT-bankposten naar Davids datahub (wv815, 22-10-2026). Bouwplan: vault 01_Ontwikkeling/Bankkoppeling open
 * banking - verkenning en bouwplan (20-10-2026).md § 9f.
 *
 * WAAROM. David 22-10-2026: "Ik wil dat je die ook synct. Zo komt die straks mooi binnen bij de Mini-App voor de POT-constructie, dat
 * scheelt alvast 1 upload". Zijn POT-app (werk.socev.dev/pot, zijn eigen bouw) leest D1 `fin` `bankmutatie` + `bank_toewijzing`; zijn
 * eigen lading (56 pdf-afschriften, 20-9) liep t/m 31-8-2026. Na elke bank-ronde zet de pod wat er sindsdien bij kwam, in zijn vorm.
 *
 * PUUR. Geen bestand, netwerk, proces of klok (vandaag komt van de beller); alleen crypto en de ABN-ontleding van mt940-lezer.js.
 * De invoer verzamelt bank-archief.js (potDatahubInvoer) en server.js (D1 lezen); schrijven doet server.js met de statements van
 * hieronder, altijd met parameters (de banktekst schrijft de tegenpartij zelf; Fable wv815 #2).
 *
 * Wat Davids lading doet en wat wij dus nadoen (gemeten 22-10 op 486 paren): werknemers staan onder een pseudoniem (zijn `naam`),
 * `tegenrekening` alleen bij praktijkposten, `omschrijving` = het veld "Omschrijving:" van de bankregel, lege tekst als '' (geen NULL).
 * Een onbekende tegenpartij krijgt geen naam en geen tegenrekening (nooit een echte persoonsnaam die David er zelf niet in had; #3).
 * De toewijzing bouwt zijn eenmalige run "regels v1" na uit zijn eigen toewijzingen van dezelfde tegenpartij; alleen als die
 * eensgezind zijn, anders geen (dan staat de post in zijn app als niet toegewezen).
 *
 * POT-regels zijn personeelsgegevens: de telling bevat alleen aantallen en een datum, nooit een naam, bedrag of IBAN.
 */
const crypto = require('crypto');
const { parseAbnDesc } = require('./mt940-lezer.js');

const BRON_BESTAND = 'enablebanking';
const HERKOMST = 'enablebanking v1';           // + ' ' + vandaag; Davids eigen run heet 'regels v1 <datum>'
const BRON = { soort: 'bankkoppeling', titel: 'ABN AMRO POT via de bankkoppeling (Enable Banking, Socev-pod)',
  opmerking: 'Posten na de laatste eigen lading, na elke bank-ronde gezet door de pod (wv815); toewijzing nagebouwd uit regels v1' };
const VENSTER = 3;        // dagen: ABN-pdf en API verschillen tot 2 dagen in datum (gemeten 53 van 486; 0/1/2 dagen = 433/21/32)
const HISTORIE = 8;       // laatste toewijzingen van dezelfde tegenpartij die eensgezind moeten zijn
const BATCH = 20;         // posten per D1-batch
const TREFWOORDEN = [['eindafr', 'afrekening'], ['afrekening', 'afrekening'], ['liquid', 'liquiditeit'], ['declar', 'declaratie'], ['salaris', 'salaris']];

function c(x) { return Math.round(Number(x) * 100); }
function dagNr(d) { return Math.round(Date.parse(String(d).slice(0, 10) + 'T12:00:00Z') / 86400000); }
function plusDagen(d, n) { const x = new Date(String(d).slice(0, 10) + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function ibanNorm(s) { return String(s || '').replace(/\s+/g, '').toUpperCase(); }
function naamNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function jaar(d) { return Number(String(d).slice(0, 4)); }
function isDatum(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')); }

// Tegenpartij + richting. Zonder IBAN de genormaliseerde naam; zonder beide één expliciete lege groep (bankkosten e.d.), nooit
// samengevoegd met een echte naam (Fable wv815 #6).
function tegenSleutel(p) {
  const ib = ibanNorm(p.tegen_iban), n = naamNorm(p.tegenpartij);
  return (ib ? 'i:' + ib : n ? 'n:' + n : 'leeg') + (c(p.bedrag) < 0 ? '|uit' : '|in');
}
// 16 hex zoals Davids eigen sleutels; uit de rekening en de vaste sleutel van de bankluis (e:entry_reference of v:vingerafdruk).
function d1Sleutel(iban, bankSleutel) {
  return crypto.createHash('sha256').update('enablebanking|' + ibanNorm(iban) + '|' + String(bankSleutel)).digest('hex').slice(0, 16);
}
function trefwoord(t) {
  const s = String(t || '').toLowerCase();
  for (let i = 0; i < TREFWOORDEN.length; i++) if (s.indexOf(TREFWOORDEN[i][0]) >= 0) return TREFWOORDEN[i][1];
  return null;
}
// Banksoort en omschrijving uit de bankregels, met dezelfde ontleding als het ABN-afschrift. Zonder "Naam:" en "Omschrijving:" geeft
// parseAbnDesc de eerste 200 tekens van de ruwe regel; David bewaart dan '' (16 van 486 paren), wij ook (Fable wv815 #8). Kenmerk laten
// we leeg: zijn lading vulde het maar bij een deel (110 van 486, ook waar de bank er een gaf) en zijn POT-app leest het niet.
// Gemeten op de 486 paren (22-10): banksoort 485 gelijk (1 × iDEAL/Wero), omschrijving 486 gelijk.
function bankTekst(p) {
  const ruw = (Array.isArray(p.regels) ? p.regels : []).map(function (x) { return String(x == null ? '' : x); }).join(' ');
  const d = ruw.replace(/\s+/g, ' ').trim();
  if (!d) return { banksoort: '', omschrijving: '', kenmerk: null };
  const r = parseAbnDesc(d), ttype = r[0], naam = r[2], oms = r[3];
  const terugval = naam === null && oms === d.slice(0, 200) && d.indexOf('Omschrijving: ') < 0;
  return { banksoort: String(ttype || '').slice(0, 100), omschrijving: terugval ? '' : String(oms || '').slice(0, 500), kenmerk: null };
}

// Eén-op-één: eerst op onze eigen sleutel, dan bedrag in centen gelijk en boekdatum binnen VENSTER dagen van de boek- óf valutadatum,
// kleinste afstand eerst over alle paren tegelijk (niet per post gulzig).
function koppel(iban, posten, rijen) {
  const paar = new Map(), bezet = new Set();
  const opSleutel = new Map();
  rijen.forEach(function (r) { if (r.sleutel) opSleutel.set(String(r.sleutel), r); });
  posten.forEach(function (p) {
    const r = opSleutel.get(d1Sleutel(iban, p.sleutel));
    if (r && !bezet.has(r.id)) { paar.set(p.nr, r); bezet.add(r.id); }
  });
  const perBedrag = new Map();
  rijen.forEach(function (r) { if (bezet.has(r.id)) return; const k = c(r.bedrag); if (!perBedrag.has(k)) perBedrag.set(k, []); perBedrag.get(k).push(r); });
  const kand = [];
  posten.forEach(function (p) {
    if (paar.has(p.nr) || !isDatum(p.datum)) return;
    (perBedrag.get(c(p.bedrag)) || []).forEach(function (r) {
      const a = Math.min(Math.abs(dagNr(r.boekdatum) - dagNr(p.datum)), isDatum(p.valutadatum) ? Math.abs(dagNr(r.boekdatum) - dagNr(p.valutadatum)) : 99);
      if (a <= VENSTER) kand.push({ a: a, p: p, r: r });
    });
  });
  kand.sort(function (x, y) { return x.a - y.a || (x.p.datum < y.p.datum ? -1 : x.p.datum > y.p.datum ? 1 : 0) || x.p.nr - y.p.nr || x.r.id - y.r.id; });
  kand.forEach(function (k) { if (paar.has(k.p.nr) || bezet.has(k.r.id)) return; paar.set(k.p.nr, k.r); bezet.add(k.r.id); });
  return { paar: paar, vrij: rijen.filter(function (r) { return !bezet.has(r.id); }) };
}

function isEigen(r) { return r.bron_bestand === BRON_BESTAND; }
function vanDavid(t) { return !!t && !String(t.herkomst || '').startsWith('enablebanking'); }
// Toewijzing uit de historie van dezelfde tegenpartij (alleen Davids rijen en Davids toewijzingen: geen zelfversterking). Met een
// trefwoord alleen zijn toewijzingen van die soort, zonder trefwoord alleen die van rijen zonder trefwoord; de laatste HISTORIE moeten
// eensgezind zijn in soort, praktijk, persoon, tegen-entiteit en boekjaarverschuiving, anders geen toewijzing.
function wijsToe(post, oms, hist, herkomst) {
  if (!hist || !hist.length) return null;
  const k = trefwoord(oms);
  const kand = hist.filter(function (x) { return vanDavid(x.r.t) && (k ? x.r.t.soort === k : trefwoord(x.r.omschrijving) === null); }).slice(-HISTORIE);
  if (!kand.length) return null;
  if (kand.some(function (x) { return Number(x.r.t.n || 1) > 1; })) return null;   // David splitste een post over meer toewijzingen: niet nadoen
  const doel = function (x) { const t = x.r.t; return JSON.stringify([t.soort, t.praktijk_id == null ? null : t.praktijk_id, t.persoon == null ? null : t.persoon,
    t.tegen_entiteit == null ? null : t.tegen_entiteit, t.boekjaar == null ? null : Number(t.boekjaar) - jaar(x.r.boekdatum)]); };
  const doelen = new Set(kand.map(doel));
  if (doelen.size !== 1) return null;
  const d = JSON.parse(doel(kand[0]));
  if (d[0] === 'voorschot' && c(post.bedrag) < 0) return null;   // een uitgaande post is nooit een voorschot
  let boekjaar = d[4] == null ? null : jaar(post.datum) + d[4];
  if (d[0] === 'afrekening') {   // precies één jaartal in de omschrijving: dat jaar (10/10 in Davids data; niet bij andere soorten)
    const js = Array.from(new Set((String(oms || '').match(/(?<!\d)20[1-3]\d(?!\d)/g) || []).map(Number)));
    if (js.length === 1) boekjaar = js[0];
  }
  return { soort: d[0], praktijk_id: d[1], persoon: d[2], tegen_entiteit: d[3], boekjaar: boekjaar, bedrag: Math.round(Number(post.bedrag) * 100) / 100, herkomst: herkomst };
}

// inv: { iban, posten: [{nr, sleutel, datum, valutadatum, bedrag, tegen_iban, tegenpartij, regels?}], rijen: [{id, boekdatum, bedrag,
//   tegenrekening, naam, omschrijving, sleutel, bron_bestand, t: {soort, praktijk_id, persoon, tegen_entiteit, boekjaar, herkomst, n}|null}],
//   grootboek: {d1sleutel: datum} (rijen van ons die al een toewijzingspoging kregen), vandaag }
function voorstel(inv) {
  if (!inv || !isDatum(inv.vandaag)) throw new Error('vandaag ontbreekt');
  const iban = ibanNorm(inv.iban);
  if (!/^NL\d{2}[A-Z]{4}\d{10}$/.test(iban)) throw new Error('rekening ontbreekt of is geen NL-IBAN');
  const posten = (inv.posten || []).filter(function (p) { return p && isDatum(p.datum) && p.sleutel && Number.isFinite(Number(p.bedrag)); });
  const rijen = inv.rijen || [], grootboek = inv.grootboek || {};
  const davids = rijen.filter(function (r) { return !isEigen(r); });
  if (!davids.length) throw new Error('geen eigen lading van David in de datahub');
  const grens = davids.reduce(function (m, r) { return r.boekdatum > m ? r.boekdatum : m; }, '');
  const herkomst = HERKOMST + ' ' + inv.vandaag;
  const k = koppel(iban, posten, rijen);
  const hist = new Map();
  posten.forEach(function (p) {
    const r = k.paar.get(p.nr);
    if (!r || isEigen(r)) return;
    const s = tegenSleutel(p);
    if (!hist.has(s)) hist.set(s, []);
    hist.get(s).push({ datum: r.boekdatum, r: r });
  });
  hist.forEach(function (l) { l.sort(function (a, b) { return a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : a.r.id - b.r.id; }); });
  const t = { posten: posten.length, gekoppeld: k.paar.size, nieuw: 0, toegewezen: 0, zonder_toewijzing: 0, onbekend: 0, onverklaard: 0, herstel: 0,
    herstel_toegewezen: 0, dubbel_vermoed: 0, eigen_zonder_post: 0, door_david_verwijderd: 0, grens: grens };
  const nieuw = [], herstel = [];
  const davidsOpBedrag = new Map();
  davids.forEach(function (r) { const b = c(r.bedrag); if (!davidsOpBedrag.has(b)) davidsOpBedrag.set(b, []); davidsOpBedrag.get(b).push(r); });
  const vlakBij = function (p, lijst) { return (lijst.get(c(p.bedrag)) || []).some(function (r) { return Math.abs(dagNr(r.boekdatum) - dagNr(p.datum)) <= VENSTER; }); };
  posten.forEach(function (p) {
    if (k.paar.has(p.nr)) return;
    // Binnen Davids lading moet elke post er al in staan (per maand complete afschriften met sluitende saldoketen): niet zetten, alleen
    // tellen. In de laatste VENSTER dagen alleen zetten als er bij David helemaal geen rij met dat bedrag in de buurt is (Fable wv815 #5).
    if (p.datum <= plusDagen(grens, -VENSTER) || (p.datum <= grens && vlakBij(p, davidsOpBedrag))) { t.onverklaard++; return; }
    // Al eens door ons gezet (grootboek) en nu niet meer in D1: David haalde hem weg. Niet terugzetten (Fable wv815 diff M1).
    if (Object.prototype.hasOwnProperty.call(grootboek, d1Sleutel(iban, p.sleutel))) { t.door_david_verwijderd++; return; }
    const h = hist.get(tegenSleutel(p)) || [];
    const tekst = bankTekst(p);
    const laatste = h.length ? h[h.length - 1].r : null;
    // De groep zonder IBAN en naam (bankkosten e.d.) heeft bij David verschillende namen: alleen overnemen als ze allemaal gelijk zijn (diff K2)
    const naam = !laatste ? '' : tegenSleutel(p).indexOf('leeg') === 0 && !h.every(function (x) { return x.r.naam === laatste.naam; }) ? '' : laatste.naam == null ? '' : String(laatste.naam);
    // tegenrekening alleen als David er bij deze tegenpartij altijd een had (en minstens één rij: Fable wv815 #3)
    const metRek = h.length > 0 && h.every(function (x) { return !!x.r.tegenrekening; }) && !!ibanNorm(p.tegen_iban);
    const rij = { rekening: iban, boekdatum: p.datum, bedrag: Math.round(Number(p.bedrag) * 100) / 100, tegenrekening: metRek ? ibanNorm(p.tegen_iban) : null,
      naam: naam, omschrijving: tekst.omschrijving, kenmerk: tekst.kenmerk, banksoort: tekst.banksoort,
      sleutel: d1Sleutel(iban, p.sleutel), geladen_op: inv.vandaag };
    const tw = wijsToe(p, tekst.omschrijving, h, herkomst);
    t.nieuw++; if (!h.length) t.onbekend++;
    if (tw) t.toegewezen++; else t.zonder_toewijzing++;
    nieuw.push({ rij: rij, toewijzing: tw });
  });
  // Onze eigen rijen zonder toewijzing die nog geen poging kregen (half geschreven batch, uitrol midden in de ronde): één keer alsnog.
  // Staat een rij in het grootboek, dan nooit opnieuw: een toewijzing die David weghaalde komt niet terug (Fable wv815 #1).
  const postVan = new Map();
  posten.forEach(function (p) { const r = k.paar.get(p.nr); if (r) postVan.set(r.id, p); });
  rijen.forEach(function (r) {
    if (!isEigen(r)) return;
    const p = postVan.get(r.id);
    if (!p) { t.eigen_zonder_post++; return; }
    if (r.t || Object.prototype.hasOwnProperty.call(grootboek, String(r.sleutel))) return;
    const tw = wijsToe(p, r.omschrijving, hist.get(tegenSleutel(p)) || [], herkomst);
    t.herstel++; if (tw) t.herstel_toegewezen++;
    herstel.push({ sleutel: String(r.sleutel), toewijzing: tw });
  });
  // Laadt David later toch een afschrift over dezelfde periode, dan staat er een rij van hem naast een van ons: alleen tellen (box-rij).
  const eigenOpBedrag = new Map();
  rijen.forEach(function (r) { if (!isEigen(r)) return; const b = c(r.bedrag); if (!eigenOpBedrag.has(b)) eigenOpBedrag.set(b, []); eigenOpBedrag.get(b).push(r); });
  k.vrij.forEach(function (r) { if (!isEigen(r) && vlakBij({ bedrag: r.bedrag, datum: r.boekdatum }, eigenOpBedrag)) t.dubbel_vermoed++; });
  return { nieuw: nieuw, herstel: herstel, telling: t };
}

// Lezen (server.js en de proef gebruiken dezelfde): Davids en onze POT-rijen vanaf `van`, met de eerste toewijzing en het aantal.
const SQL_LEES_RIJEN = 'SELECT m.id, m.boekdatum, m.bedrag, m.tegenrekening, m.naam, m.omschrijving, m.sleutel, m.bron_bestand, t.soort, t.praktijk_id, ' +
  't.persoon, t.tegen_entiteit, t.boekjaar, t.herkomst, (SELECT count(*) FROM bank_toewijzing x WHERE x.bankmutatie_id = m.id) AS n_t FROM bankmutatie m ' +
  'LEFT JOIN bank_toewijzing t ON t.id = (SELECT min(x.id) FROM bank_toewijzing x WHERE x.bankmutatie_id = m.id) WHERE m.entiteit = ? AND m.boekdatum >= ? ORDER BY m.boekdatum, m.id';
const SQL_LEES_REKENING = 'SELECT iban FROM bankrekening WHERE entiteit = ?';
function rijUitD1(x) {
  return { id: x.id, boekdatum: x.boekdatum, bedrag: x.bedrag, tegenrekening: x.tegenrekening, naam: x.naam, omschrijving: x.omschrijving, sleutel: x.sleutel,
    bron_bestand: x.bron_bestand, t: x.soort == null ? null : { soort: x.soort, praktijk_id: x.praktijk_id, persoon: x.persoon, tegen_entiteit: x.tegen_entiteit,
      boekjaar: x.boekjaar, herkomst: x.herkomst, n: x.n_t } };
}
// Vanaf welke datum D1 gelezen wordt: de oudste bankpost min een maand (ruim boven VENSTER).
function leesVanaf(posten) { const d = (posten || []).reduce(function (m, p) { return p && isDatum(p.datum) && (!m || p.datum < m) ? p.datum : m; }, null); return d ? plusDagen(d, -31) : null; }

const SQL_BRON = 'INSERT INTO bron (entiteit, soort, titel, geladen_op, gecontroleerd, opmerking) SELECT ?, ?, ?, ?, 0, ? ' +
  'WHERE NOT EXISTS (SELECT 1 FROM bron WHERE entiteit = ? AND soort = ? AND titel = ?)';
const SQL_MUTATIE = 'INSERT OR IGNORE INTO bankmutatie (rekening, entiteit, boekdatum, bedrag, tegenrekening, naam, omschrijving, kenmerk, banksoort, ' +
  'saldo_na, bron_bestand, sleutel, bron_id, geladen_op) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ' +
  '(SELECT id FROM bron WHERE entiteit = ? AND soort = ? AND titel = ? ORDER BY id LIMIT 1), ?)';
const SQL_TOEWIJZING = 'INSERT INTO bank_toewijzing (bankmutatie_id, soort, praktijk_id, tegen_entiteit, persoon, boekjaar, bedrag, herkomst, opmerking) ' +
  'SELECT m.id, ?, ?, ?, ?, ?, ?, ?, NULL FROM bankmutatie m WHERE m.sleutel = ? AND m.bron_bestand = ? ' +
  'AND NOT EXISTS (SELECT 1 FROM bank_toewijzing t WHERE t.bankmutatie_id = m.id)';
function stToewijzing(sleutel, tw) {
  return { sql: SQL_TOEWIJZING, params: [tw.soort, tw.praktijk_id, tw.tegen_entiteit, tw.persoon, tw.boekjaar, tw.bedrag, tw.herkomst, sleutel, BRON_BESTAND] };
}
// Statements met parameters, in batches van hooguit BATCH posten; elke batch noemt de sleutels die daarna in het grootboek horen.
function statements(v, o) {
  if (!o || !isDatum(o.vandaag)) throw new Error('vandaag ontbreekt');
  const bronSt = { sql: SQL_BRON, params: ['POT', BRON.soort, BRON.titel, o.vandaag, BRON.opmerking, 'POT', BRON.soort, BRON.titel] };
  const werk = v.nieuw.map(function (n) {
    const r = n.rij;
    const st = [{ sql: SQL_MUTATIE, params: [r.rekening, 'POT', r.boekdatum, r.bedrag, r.tegenrekening, r.naam, r.omschrijving, r.kenmerk, r.banksoort,
      BRON_BESTAND, r.sleutel, 'POT', BRON.soort, BRON.titel, r.geladen_op] }];
    if (n.toewijzing) st.push(stToewijzing(r.sleutel, n.toewijzing));
    return { sleutel: r.sleutel, st: st };
  }).concat(v.herstel.map(function (h) { return { sleutel: h.sleutel, st: h.toewijzing ? [stToewijzing(h.sleutel, h.toewijzing)] : [] }; }));
  const batches = [];
  for (let i = 0; i < werk.length; i += BATCH) {
    const deel = werk.slice(i, i + BATCH), st = [];
    if (i === 0 && v.nieuw.length) st.push(bronSt);
    deel.forEach(function (w) { w.st.forEach(function (s) { st.push(s); }); });
    batches.push({ statements: st, sleutels: deel.map(function (w) { return w.sleutel; }) });
  }
  return batches;
}

module.exports = { voorstel, statements, rijUitD1, leesVanaf, SQL_LEES_RIJEN, SQL_LEES_REKENING, koppel, bankTekst, tegenSleutel, d1Sleutel, trefwoord, wijsToe, BRON, BRON_BESTAND, HERKOMST, VENSTER, HISTORIE, BATCH };
