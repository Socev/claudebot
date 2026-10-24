#!/usr/bin/env bash
# Toetst de afschriftmaker van de POT-rekening (wv787, 22-10-2026; bouwplan vault 01_Ontwikkeling/POT-afschriften - bouwplan (App,
# 22-10-2026).md § 4): pot-afschrift.js (puur) + mt940-lezer.js (contract bankexports) + bank-archief.js potAfschriftInvoer + bank-lezer.js
# pot-afschrift / pot-afschrift-maanden / pot-ontvanger. Synthetisch (NL00TEST-achtige IBAN's, "Leverancier A B.V.", nagebootste
# medewerkers): saldoketen los van nr-volgorde en met heen-en-terug op één dag, kapotte keten / lopende maand / eerste maand / niet
# gelezen geweigerd zonder bedragen of namen in de reden, aansluiting met de vorige maand, lege maand, negatief saldo, jaarwissel,
# lange omschrijving (6 × 65, geen regel met spatie/':'/'-' aan het begin), tekenset, vaste-breedteregels zonder spatie aaneen, incasso,
# bankkosten, verrijking + stukken, round-trip door de contractlezer en (als aanwezig) de Python-lezer mt-940, PDF (xref klopt, pagina's,
# pdftotext), deterministisch, late boeking = veranderd, bestanden 700/600, commando niet via /smal/bank.
# Raakt de pod, de kluis, de bank, de vault en /opt/data/bank niet. Gebruik: bash test/pot-afschrift.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const P = require(path.resolve('pot-afschrift.js')), L = require(path.resolve('mt940-lezer.js'));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'pot-afschrift-'));
const IBAN = L.ibanFromAbnAccount('0123456789'), EIGEN = 'NL11BUNQ0000000001', LEV = 'NL22TEST0000000002', PRAKTIJK = 'NL33TEST0000000003';
const MW = ['Jansen Medewerker', 'Pietersen Medewerker'];
const vandaag = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const mPlus = (m, n) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);
const M = mPlus(vandaag.slice(0, 7), -2), M1 = mPlus(M, 1), MV = mPlus(M, -1), EERSTE = mPlus(M, -3);
const laatste = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const plusD = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const geenGeheim = (s) => !/\d[\d.]*,\d{2}/.test(s) && !MW.some((n) => s.indexOf(n) >= 0) && s.indexOf('Leverancier') < 0;

// omschrijvingsregels zoals ABN ze via Enable Banking geeft: type, dan "Sleutel: waarde", vaste breedte 32 (afgebroken midden in een woord)
function regels(type, velden) {
  const r = [type];
  Object.keys(velden).forEach((k) => { let t = k + ': ' + velden[k]; while (t.length > 32) { r.push(t.slice(0, 32)); t = t.slice(32); } if (t) r.push(t); });
  return r;
}
let nr = 1000;
// posten in volgorde; saldo loopt vanaf start mee
function reeks(start, lijst) {
  let s = start;
  return lijst.map((x) => { s = Math.round((s + x.bedrag) * 100) / 100; return Object.assign({ nr: nr++, saldo_na: s, code: '658', categorie: null, tegen_iban: null, tegenpartij: null, regels: [] }, x, { saldo_na: x.saldo_na != null ? x.saldo_na : s }); });
}
const sal = (d, b, naam) => ({ datum: d, bedrag: b, tegenpartij: naam, tegen_iban: 'NL44TEST000000000' + (MW.indexOf(naam) + 4), categorie: 'salarissen', code: '411',
  regels: regels('SEPA Periodieke overb.', { IBAN: 'NL44TEST000000000' + (MW.indexOf(naam) + 4), BIC: 'TESTNL2A', Naam: naam, Omschrijving: 'salaris ' + M }) });
function basis(extra) {
  const voor = reeks(5000, [{ datum: laatste(MV), bedrag: -10, tegenpartij: 'Leverancier A B.V.', tegen_iban: LEV, categorie: 'overig', regels: regels('SEPA Overboeking', { IBAN: LEV, BIC: 'TESTNL2A', Naam: 'Leverancier A B.V.', Omschrijving: 'factuur 1' }) }]);
  const start = voor[voor.length - 1].saldo_na;
  const posten = reeks(start, [
    { datum: M + '-02', bedrag: 2500, tegenpartij: 'Huisartsenpraktijk Testdorp', tegen_iban: PRAKTIJK, categorie: 'ontvangsten', code: '654', regels: regels('SEPA Overboeking', { IBAN: PRAKTIJK, BIC: 'TESTNL2A', Naam: 'Huisartsenpraktijk Testdorp', Omschrijving: 'voorschot POT ' + M }) },
    { datum: M + '-05', bedrag: -123.45, tegenpartij: 'Leverancier A B.V.', tegen_iban: LEV, categorie: 'overig', regels: regels('SEPA Overboeking', { IBAN: LEV, BIC: 'TESTNL2A', Naam: 'Leverancier A B.V.', Omschrijving: 'factuur 2026-118 kantoorbenodigdheden en printerpapier', Kenmerk: 'REF778' }) },
    { datum: M + '-10', bedrag: -400, tegenpartij: 'Belastingdienst', tegen_iban: 'NL86INGB0002445588', categorie: 'loonheffing', code: '247', regels: regels('SEPA Incasso algemeen doorlopend', { Incassant: 'NL00ZZZ000000000000', Naam: 'Belastingdienst', Machtiging: 'MACHT1', Omschrijving: 'loonheffing', IBAN: 'NL86INGB0002445588', Kenmerk: 'BETKM1' }) },
    { datum: M + '-15', bedrag: 1000, tegenpartij: 'D Schaap', tegen_iban: EIGEN, categorie: 'ontvangsten', code: '654', regels: regels('SEPA Overboeking', { IBAN: EIGEN, BIC: 'BUNQNL2A', Naam: 'D Schaap', Omschrijving: 'aanvulling' }) },
    { datum: M + '-24', bedrag: -1800, ...sal(M + '-24', -1800, MW[0]) },
    { datum: M + '-24', bedrag: -1650.5, ...sal(M + '-24', -1650.5, MW[1]) },
    { datum: M + '-25', bedrag: -300, tegenpartij: 'PFZW', tegen_iban: 'NL55TEST0000000005', categorie: 'pensioen', code: '247', regels: regels('SEPA Incasso algemeen doorlopend', { Incassant: 'NL11ZZZ111111111111', Naam: 'PFZW', Machtiging: 'M2', Omschrijving: 'premie', IBAN: 'NL55TEST0000000005' }) },
    { datum: laatste(M), bedrag: -12.5, tegenpartij: null, tegen_iban: null, categorie: 'overig', code: '526', regels: ['ABN AMRO Bank N.V.', 'BETAALPAKKET           ' + M] },
  ]);
  return Object.assign({ rekening: { iban: IBAN }, maand: M, posten: posten, voorDag: voor, eersteMaand: EERSTE, laatstGezien: new Date().toISOString(), nieuwstePost: M1 + '-02',
    vandaag: vandaag, eigenIbans: [EIGEN], stukken: {}, vorigEind: null, gemaakt: '2026-10-22T19:00:00.000Z' }, extra || {});
}
const schud = (l) => l.slice().reverse();

// ── 1. basis + round-trip ──
const inv = basis();
const r = P.maakAfschrift(inv);
toets('basis: afschrift gemaakt', r.ok === true, r.reden);
const a1 = L.leesMt940(r.mt940).afschriften;
toets('contractlezer: één afschrift, rekening, sluitende som', a1.length === 1 && a1[0].rekening === IBAN && a1[0].sluit === true, a1[0] && { rek: a1[0].rekening, sluit: a1[0].sluit });
const beginC = Math.round(inv.voorDag[0].saldo_na * 100), eindC = Math.round(inv.posten[inv.posten.length - 1].saldo_na * 100);
toets('begin = saldo na de laatste post vóór de maand; eind = saldo na de laatste post', a1[0].begin.centen === beginC && a1[0].eind.centen === eindC && r.telling.begin === beginC && r.telling.eind === eindC);
toets('aantal en bedragen gelijk aan de bankluis', a1[0].posten.length === 8 && a1[0].posten.every((q, i) => q.centen === Math.round(inv.posten[i].bedrag * 100) && q.boekdatum === inv.posten[i].datum && q.valutadatum === inv.posten[i].datum));
toets('kop in ABN-vorm (ABNANL2A / 940 / :20:ABN AMRO BANK NV / :28:…/1, geen :64:)', /^ABNANL2A\r\n940\r\nABNANL2A\r\n:20:ABN AMRO BANK NV\r\n:25:NL\d{2}ABNA\d{10}\r\n:28:\d{5}\/1\r\n:60F:C/.test(r.mt940) && r.mt940.indexOf(':64:') < 0 && /\r\n-\r\n$/.test(r.mt940));
toets(':60F: op de laatste dag van de maand ervoor, :62F: op de laatste dag van de maand', r.mt940.indexOf(':60F:C' + laatste(MV).slice(2).replace(/-/g, '') + 'EUR') >= 0 && r.mt940.indexOf(':62F:C' + laatste(M).slice(2).replace(/-/g, '') + 'EUR') >= 0);
toets(':61: met boekdatum en transactiecode van ABN (N658, N247, N526)', /:61:\d{10}D123,45N658NONREF/.test(r.mt940) && /N247NONREF/.test(r.mt940) && /N526NONREF/.test(r.mt940));
const o = a1[0].posten.map((q) => q.ontleed);
toets('SEPA-vorm: tegenrekening en naam terug via parseAbnDesc', o[1].tegen_iban === LEV && o[1].naam === 'Leverancier A B.V.' && o[1].kenmerk === 'REF778', o[1]);
toets('vaste-breedteregels zonder spatie aaneen (REMI heel, niet "kantoorbenod igdheden")', o[1].omschrijving === 'factuur 2026-118 kantoorbenodigdheden en printerpapier', o[1].omschrijving);
toets('incasso: /CSID/ en /MARF/, is_incasso', /\/TRTP\/SEPA Incasso algemeen doorlopend\/CSID\/NL00ZZZ000000000000\/NAME\/Belastingdienst\/MARF\/MACHT1\//.test(a1[0].posten[2].omschrijving86) && o[2].is_incasso === true, a1[0].posten[2].omschrijving86);
toets('bankkosten in de vrije vorm', /^ABN AMRO Bank N\.V\. BETAALPAKKET/.test(a1[0].posten[7].omschrijving86.replace(/\s+/g, ' ')) && o[7].transactietype === 'ABN AMRO Bank N.V.', a1[0].posten[7].omschrijving86);
toets('alleen SWIFT-tekens en CRLF', !/[^\x20-\x7e\r\n]/.test(r.mt940) && !/[^\r]\n/.test(r.mt940));
toets('telling: 8 posten, bij en af, 1 regel met ?', r.telling.aantal === 8 && r.telling.bij === 350000 && r.telling.af === 428645 && r.telling.stuk_open === 1, r.telling);
toets('per soort: salarissen 2, loonheffing 1, pensioen 1, bankkosten 1, eigen 1, ontvangsten 1, overig 1',
  JSON.stringify(Object.fromEntries(Object.entries(r.telling.per_soort).map(([k, v]) => [k, v.aantal])).valueOf()) === JSON.stringify({ ontvangsten: 1, overig: 1, loonheffing: 1, eigen: 1, salarissen: 2, pensioen: 1, bankkosten: 1 }), r.telling.per_soort);
toets('bestandsnamen', r.bestandsnamen.mt940 === 'POT-' + M + '.sta' && r.bestandsnamen.pdf === 'POT-afschrift ' + M + '.pdf');

// ── 2. volgorde en determinisme ──
const r2 = P.maakAfschrift(basis({ posten: schud(basis().posten) }));
toets('volgorde uit de saldoketen, niet uit de invoer (zelfde sha)', r2.ok && r2.sha256.mt940 === r.sha256.mt940 && r2.sha256.pdf === r.sha256.pdf);
toets('deterministisch: zelfde invoer = zelfde bytes', P.maakAfschrift(basis()).sha256.pdf === r.sha256.pdf);
const r3 = P.maakAfschrift(basis({ gemaakt: '2026-11-03T07:00:00.000Z' }));
toets('ander tijdstip: MT940 gelijk, PDF anders', r3.sha256.mt940 === r.sha256.mt940 && r3.sha256.pdf !== r.sha256.pdf);
// heen-en-terug op één dag: A +100 (s=S+100), C -100 (s=S), B +50 (s=S+50); gulzig vanaf S kan B of A kiezen
(function () {
  const b = basis(), S = b.voorDag[0].saldo_na, d = M + '-01';
  const extra = [{ nr: 1, datum: d, bedrag: 100, saldo_na: S + 100 }, { nr: 2, datum: d, bedrag: -100, saldo_na: S }, { nr: 3, datum: d, bedrag: 50, saldo_na: S + 50 }]
    .map((x) => Object.assign({ tegenpartij: 'Leverancier A B.V.', tegen_iban: LEV, code: '658', categorie: 'overig', regels: regels('SEPA Overboeking', { IBAN: LEV, Naam: 'Leverancier A B.V.', Omschrijving: 'x' }) }, x));
  const rest = reeks(S + 50, basis().posten.map((p) => ({ datum: p.datum, bedrag: p.bedrag, tegenpartij: p.tegenpartij, tegen_iban: p.tegen_iban, categorie: p.categorie, code: p.code, regels: p.regels })));
  const rr = P.maakAfschrift(basis({ posten: [extra[2], extra[0], extra[1]].concat(rest) }));
  toets('heen-en-terug op één dag: keten met terugzetten gevonden', rr.ok === true && rr.telling.aantal === 11, rr.reden);
})();

// ── 3. weigeren, zonder bedragen of namen in de reden ──
const weiger = (naam, x, re) => { const w = P.maakAfschrift(x); toets(naam, w.ok === false && re.test(w.reden) && geenGeheim(w.reden), w); };
const kapot = basis(); kapot.posten.splice(3, 1);
weiger('ontbrekende post → saldi sluiten niet (met datum, zonder bedrag/naam)', kapot, /saldi sluiten niet op \d+-\d+-\d{4}/);
weiger('lopende maand geweigerd', basis({ maand: vandaag.slice(0, 7), posten: [] }), /loopt nog/);
weiger('eerste archiefmaand geweigerd', basis({ eersteMaand: M }), /begin van de bankhistorie/);
weiger('rekening na de maand nog niet gelezen → geweigerd', basis({ laatstGezien: plusD(laatste(M), 1) + 'T10:00:00Z' }), /nog niet \(genoeg\) gelezen/);
weiger('geen post na de maand en vóór de 10e → geweigerd', basis({ nieuwstePost: laatste(M), vandaag: plusD(laatste(M), 5) }), /nog niet \(genoeg\) gelezen/);
toets('geen post na de maand maar na de 10e → wel', P.maakAfschrift(basis({ nieuwstePost: laatste(M), vandaag: plusD(laatste(M), 10) })).ok === true);
weiger('vorige maand veranderd (eindsaldo ≠ begin) → geweigerd met correctie-uitleg', basis({ vorigEind: 123 }), /veranderd sinds dat afschrift gemaakt is/);
toets('vorige maand gelijk → wel', P.maakAfschrift(basis({ vorigEind: beginC })).ok === true);
weiger('post buiten de maand in de invoer → geweigerd', basis({ posten: basis().posten.concat([Object.assign({}, basis().posten[0], { datum: M1 + '-01' })]) }), /buiten de maand/);
weiger('geen dag ervoor → geweigerd', basis({ voorDag: [] }), /beginsaldo niet te bepalen/);
weiger('IBAN ongeldig → geweigerd', basis({ rekening: { iban: 'x' } }), /geldige IBAN/);

// ── 4. randgevallen ──
(function () {
  const leeg = P.maakAfschrift(basis({ posten: [] }));
  const l = leeg.ok && L.leesMt940(leeg.mt940).afschriften[0];
  toets('lege maand: geldig afschrift, begin = eind, geen :61:', leeg.ok && l.posten.length === 0 && l.begin.centen === l.eind.centen && leeg.mt940.indexOf(':61:') < 0, leeg.reden);
  const neg = basis(); neg.voorDag = reeks(-50, [{ datum: laatste(MV), bedrag: -10, tegenpartij: 'Leverancier A B.V.', tegen_iban: LEV, categorie: 'overig', regels: [] }]);
  neg.posten = reeks(-60, [{ datum: M + '-03', bedrag: -5, tegenpartij: 'Leverancier A B.V.', tegen_iban: LEV, categorie: 'overig', regels: regels('SEPA Overboeking', { IBAN: LEV, Naam: 'Leverancier A B.V.' }) }]);
  const rn = P.maakAfschrift(neg);
  toets('negatief saldo: :60F:D en :62F:D', rn.ok && /:60F:D\d{6}EUR60,00/.test(rn.mt940) && /:62F:D\d{6}EUR65,00/.test(rn.mt940), rn.reden || rn.mt940);
  // jaarwissel: januari (begin op 31-12) en december
  const jan = basis({ maand: '2025-01', eersteMaand: '2024-06', vandaag: '2025-03-01', laatstGezien: '2025-03-01T08:00:00Z', nieuwstePost: '2025-02-03' });
  jan.voorDag = reeks(100, [{ datum: '2024-12-31', bedrag: 1, tegenpartij: 'x', categorie: 'ontvangsten', regels: [] }]);
  jan.posten = reeks(101, [{ datum: '2025-01-02', bedrag: -1, tegenpartij: 'Leverancier A B.V.', tegen_iban: LEV, categorie: 'overig', regels: regels('SEPA Overboeking', { IBAN: LEV, Naam: 'Leverancier A B.V.' }) }]);
  const rj = P.maakAfschrift(jan), lj = rj.ok && L.leesMt940(rj.mt940).afschriften[0];
  toets('jaarwissel: :60F: 31-12 vorig jaar, boekdatum 2025-01-02, :28: 25031/1', rj.ok && /:60F:C241231EUR/.test(rj.mt940) && lj.posten[0].boekdatum === '2025-01-02' && /:28:25031\/1/.test(rj.mt940), rj.reden);
  const dec = basis({ maand: '2024-12', eersteMaand: '2024-06', vandaag: '2025-02-01', laatstGezien: '2025-02-01T08:00:00Z', nieuwstePost: '2025-01-03' });
  dec.voorDag = reeks(100, [{ datum: '2024-11-30', bedrag: 1, tegenpartij: 'x', categorie: 'ontvangsten', regels: [] }]);
  dec.posten = reeks(101, [{ datum: '2024-12-31', bedrag: -1, tegenpartij: 'Leverancier A B.V.', tegen_iban: LEV, categorie: 'overig', regels: regels('SEPA Overboeking', { IBAN: LEV, Naam: 'Leverancier A B.V.' }) }]);
  const rd = P.maakAfschrift(dec);
  toets('december: :62F: 31-12, :28: 24366/1 (schrikkeljaar)', rd.ok && /:62F:C241231EUR/.test(rd.mt940) && /:28:24366\/1/.test(rd.mt940), rd.reden);
  // jaarwissel in de lezer: valutadatum 31-12, boekdatum 0102
  const lz = L.leesMt940('ABNANL2A\r\n940\r\nABNANL2A\r\n:20:X\r\n:25:0123456789\r\n:28:1/1\r\n:60F:C241230EUR10,00\r\n:61:2412310102C1,00N654NONREF\r\n:86:x\r\n:61:2501021231RD2,00N654NONREF\r\n:86:storno\r\n:62F:C250102EUR13,00\r\n-\r\n').afschriften[0];
  toets('lezer: 10 cijfers → IBAN, jaarwissel boekdatum, RD = bij, sluit', lz.rekening === IBAN && lz.posten[0].boekdatum === '2025-01-02' && lz.posten[1].boekdatum === '2024-12-31' && lz.posten[1].centen === 200 && lz.sluit === true, lz);
  // lange omschrijving + tekenset
  const lang = basis();
  lang.posten = reeks(lang.voorDag[0].saldo_na, [{ datum: M + '-04', bedrag: -1, tegenpartij: 'Ëlla & Zoë Ørsted/Test', tegen_iban: LEV, categorie: 'overig',
    regels: regels('SEPA Overboeking', { IBAN: LEV, BIC: 'TESTNL2A', Naam: 'Ëlla & Zoë Ørsted/Test', Omschrijving: ('lange omschrijving: met - streepjes en : dubbelepunten /IBAN/ nep ').repeat(12), Kenmerk: 'K1' }) }]);
  const rl = P.maakAfschrift(lang);
  const r86 = rl.ok ? rl.mt940.split('\r\n').slice(rl.mt940.split('\r\n').findIndex((x) => x.startsWith(':86:'))).slice(0, 7) : [];
  const vervolg = r86.slice(1).filter((x) => !/^:\d\d[A-Z]?:/.test(x) && x !== '-');
  const ll = rl.ok && L.leesMt940(rl.mt940).afschriften[0].posten[0];
  toets('lange omschrijving: ≤ 6 regels van ≤ 65, ingekort', rl.ok && rl.telling.ingekort86 === 1 && r86[0].length <= 69 && vervolg.length <= 5 && vervolg.every((x) => x.length <= 65), rl.reden || r86);
  toets('geen vervolgregel met spatie, ":" of "-" vooraan; geen regel eindigt op spatie', vervolg.every((x) => !/^[ :\-]/.test(x)) && r86.slice(0, vervolg.length + 1).every((x) => !/ $/.test(x)), r86);
  const lijn = basis();
  lijn.posten = reeks(lijn.voorDag[0].saldo_na, [{ datum: M + '-04', bedrag: -1, tegenpartij: 'Leverancier A B.V.', tegen_iban: LEV, categorie: 'overig',
    regels: regels('SEPA Overboeking', { IBAN: LEV, Naam: 'Leverancier A B.V.', Omschrijving: 'kop ' + '-'.repeat(200) + ' ' + ':'.repeat(80) + ' eind' }) }]);
  const rlijn = P.maakAfschrift(lijn);
  toets('omschrijving met een lange streepjes- en dubbelepuntenlijn: ingekort tot één teken, afschrift gemaakt', rlijn.ok === true && /kop [-:]( [-:])? eind/.test(L.leesMt940(rlijn.mt940).afschriften[0].posten[0].ontleed.omschrijving), rlijn.reden || L.leesMt940(rlijn.mt940).afschriften[0].posten[0].ontleed);
  toets('tekenset: naam "Ella + Zoe Orsted-Test", /IBAN/ in de tekst breekt de ontleding niet', ll && ll.ontleed.naam === 'Ella + Zoe Orsted-Test' && ll.ontleed.tegen_iban === LEV && ll.ontleed.kenmerk === 'K1', ll && ll.ontleed);
})();

// ── 5. verrijking en stukken ──
(function () {
  const pdfTekst = (pdf) => { const t = path.join(W, 'x.pdf'); fs.writeFileSync(t, pdf); const u = spawnSync('pdftotext', ['-layout', t, '-']); return u.status === 0 ? String(u.stdout) : null; };
  const t = pdfTekst(r.pdf);
  if (t === null) console.log('OVERGESLAGEN pdftotext niet aanwezig');
  else {
    toets('PDF: titel, saldi en kolommen leesbaar', /POT POH-GGZ — rekeningafschrift/.test(t) && /Beginsaldo/.test(t) && /Wat is het/.test(t) && /€ /.test(t), t.slice(0, 300));
    toets('PDF: per regel wat het is', ['Salaris', 'Loonheffing', 'Pensioenpremie', 'Bankkosten ABN AMRO', 'Van eigen rekening David', 'Bijdrage praktijk (voorschot POT)', 'Overige betaling'].every((w) => t.indexOf(w) >= 0), t);
    toets('PDF: stuk-kolom (loonadministratie, niet nodig, ?)', /loonadministratie/.test(t) && /niet nodig/.test(t) && / \? /.test(t));
    const rij = (pdf) => (pdfTekst(pdf).split('\n').find((x) => /Leverancier A/.test(x) && /Overige betaling/.test(x)) || '');
    const ib = basis(); ib.stukken = { [ib.posten[1].nr]: { soort: 'ontbreekt' } };
    const rs = P.maakAfschrift(ib);
    toets('stukken: "ontbreekt" vervangt het vraagteken (in de rij zelf)', rs.ok && rs.telling.stuk_open === 1 && /ontbreekt/.test(rij(rs.pdf)) && !/ \? /.test(rij(rs.pdf)), rij(rs.pdf));
    const ifa = basis(); ifa.stukken = { [ifa.posten[1].nr]: { soort: 'factuur', tekst: 'factuur 2026-118' } };
    const rf = P.maakAfschrift(ifa);
    toets('stukken: factuurnummer, geen open stuk meer', rf.ok && rf.telling.stuk_open === 0 && /factuur 2026-1/.test(rij(rf.pdf).replace(/^.*Overige betaling/, '')), rij(rf.pdf));
  }
  // PDF-structuur: xref-offsets wijzen naar "n 0 obj", startxref klopt, 1 pagina; met 90 posten meer pagina's
  const pdfOk = (pdf) => {
    const s = pdf.toString('latin1'), sx = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)[1]);
    if (s.slice(sx, sx + 4) !== 'xref') return false;
    const rows = s.slice(sx).split('\n').slice(3).filter((x) => / 00000 n $/.test(x));
    return rows.every((x, i) => s.slice(Number(x.slice(0, 10)), Number(x.slice(0, 10)) + String(i + 1).length + 6) === (i + 1) + ' 0 obj');
  };
  toets('PDF: geldige xref en startxref, %PDF-1.4, A4 liggend', r.pdf.slice(0, 8).toString('latin1') === '%PDF-1.4' && pdfOk(r.pdf) && /\/MediaBox \[0 0 841.89 595.28\]/.test(r.pdf.toString('latin1')) && /\/Count 1 /.test(r.pdf.toString('latin1')));
  const veel = basis(), lijst = [];
  for (let i = 0; i < 90; i++) lijst.push({ datum: M + '-' + String(2 + (i % 26)).padStart(2, '0'), bedrag: -1, tegenpartij: 'Leverancier A B.V.', tegen_iban: LEV, categorie: 'overig', regels: regels('SEPA Overboeking', { IBAN: LEV, Naam: 'Leverancier A B.V.', Omschrijving: 'post ' + i }) });
  lijst.sort((x, y) => (x.datum < y.datum ? -1 : 1));
  veel.posten = reeks(veel.voorDag[0].saldo_na, lijst);
  const rv = P.maakAfschrift(veel), pv = rv.ok && rv.pdf.toString('latin1');
  toets('90 posten: meerdere pagina\'s, "pagina 1 van N", xref klopt', rv.ok && /\/Count [3-9] /.test(pv) && pdfOk(rv.pdf) && (pdfTekst(rv.pdf) === null || /pagina 1 van [3-9]/.test(pdfTekst(rv.pdf))), rv.reden);
  // onafhankelijke lezer (Python mt-940), alleen als hij er is (CI installeert hem; op de pod in een wegwerpmap)
  const py = spawnSync('python3', ['-c', 'import sys; sys.path[:0]=[p for p in sys.argv[1:] if p]; import mt940; print(mt940.__version__)', process.env.MT940_PY || ''], { encoding: 'utf8' });
  if (py.status !== 0) console.log('OVERGESLAGEN mt-940 (Python) niet aanwezig');
  else {
    const f = path.join(W, 'x.sta'); fs.writeFileSync(f, r.mt940);
    const u = spawnSync('python3', ['-c', [
      'import sys, json', 'sys.path[:0]=[p for p in sys.argv[2:] if p]', 'import mt940',
      't = mt940.models.Transactions(); t.parse(open(sys.argv[1], encoding="ascii").read())',
      'print(json.dumps({"n": len(t.transactions), "b": int(round(float(t.data["final_opening_balance"].amount.amount)*100)), "e": int(round(float(t.data["final_closing_balance"].amount.amount)*100)), "s": sum(int(round(float(x.data["amount"].amount)*100)) for x in t), "rek": t.data.get("account_identification")}))'].join('\n'), f, process.env.MT940_PY || ''], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(u.stdout); } catch (e) {}
    toets('onafhankelijke lezer mt-940 ' + String(py.stdout).trim() + ': aantal, begin, eind, som, rekening', j && j.n === 8 && j.b === beginC && j.e === eindC && j.b + j.s === j.e && j.rek === IBAN, j || u.stderr.slice(0, 300));
  }
  const mc = P.mailConcept(M, r.telling);
  toets('mailconcept: onderwerp met maand, één vraagteken-zin, geen bedrag of naam', /^POT POH-GGZ: afschrift [a-z]+ \d{4}$/.test(mc.onderwerp) && /^Hoi André,/.test(mc.bericht) && /één betaling staat een vraagteken/.test(mc.bericht) && geenGeheim(mc.bericht), mc);
})();

// ── 6. bank-archief + bank-lezer (CLI) op een wegwerp-BANK_DIR ──
(function () {
  const A = require(path.resolve('bank-archief.js'));
  const BD = path.join(W, 'bank');
  const a = A.open(BD);
  const REK = { pot: { uid: 'u2', bank: 'ABN AMRO', naam: 'D Schaap', iban: IBAN, sessie: 's2' }, prive: { bron: 'bunq', uid: 'bunq-1', bunq_id: 1, naam: 'Privé', soort: 'lopend', iban: EIGEN, status: 'ACTIVE' } };
  A.zakelijkZet(a, { [IBAN]: 'POT' });
  A.rekeningenSync(a, REK);
  const naarBank = (q, i) => ({ id: 'e:T' + q.nr, datum: q.datum, valutadatum: null, bedrag: q.bedrag, valuta: 'EUR', tegenpartij: q.tegenpartij, tegen_iban: q.tegen_iban,
    omschrijving: q.regels.join(' ') || null, status: 'geboekt', saldo_na: q.saldo_na, mcc: null,
    _ruw: { entry_reference: 'T' + q.nr, remittance_information: q.regels, bank_transaction_code: { code: q.code }, status: 'BOOK' } });
  const b = basis();
  const na = reeks(b.posten[b.posten.length - 1].saldo_na, [{ datum: M1 + '-02', bedrag: -5, tegenpartij: 'Leverancier A B.V.', tegen_iban: LEV, categorie: 'overig', regels: regels('SEPA Overboeking', { IBAN: LEV, Naam: 'Leverancier A B.V.' }) }]);
  // de eerste archiefmaand ver terug (anders weigert hij als "begin van de historie")
  const oud = reeks(b.voorDag[0].saldo_na - b.voorDag[0].bedrag - 1, [{ datum: EERSTE + '-15', bedrag: 1, tegenpartij: 'x', categorie: 'ontvangsten', regels: [] }]);
  A.bij(a, 'pot', oud.concat(b.voorDag, b.posten, na).map(naarBank), null);
  A.verrijk(a);
  // het archief kent alleen BANK_DIR/stand.json van bank-lezer voor rekeningen; schrijf een minimale stand (zoals de toets van bank-pot)
  // opgehaald: de echte ophaaltijd van de transacties (bank-lezer haalt de poort daaruit, niet uit laatst_gezien; Fable wv787 diff #1)
  const stand = (opg) => fs.writeFileSync(path.join(BD, 'stand.json'), JSON.stringify({ sessies: {}, rekeningen: REK, opgehaald: { pot: { transacties: opg } } }), { mode: 0o600 });
  stand(plusD(laatste(M), 1) + 'T10:00:00Z');
  const inv2 = A.potAfschriftInvoer(a, M);
  {
    const kaal = A.open(path.join(W, 'kaal'));
    A.zakelijkZet(kaal, { [IBAN]: 'POT' }); A.rekeningenSync(kaal, REK);
    const bk = naarBank(b.posten[1]); delete bk._ruw;
    A.bij(kaal, 'pot', [bk], null);
    const ik = A.potAfschriftInvoer(kaal, M);
    toets('post zonder ruwe bankregels: de opgeslagen omschrijving als regel (geen lege :86:)', ik.posten.length === 1 && ik.posten[0].regels.length === 1 && /factuur 2026-118/.test(ik.posten[0].regels[0]), ik.posten);
  }
  toets('potAfschriftInvoer: 8 posten, dag ervoor, eerste maand, eigen IBAN, regels en code uit de ruwe post',
    inv2.posten.length === 8 && inv2.voorDag.length === 1 && inv2.eersteMaand === EERSTE && inv2.eigenIbans.indexOf(EIGEN) >= 0 && inv2.eigenIbans.indexOf(IBAN) < 0 &&
    inv2.posten[2].code === '247' && inv2.posten[2].regels[0] === 'SEPA Incasso algemeen doorlopend' && inv2.nieuwstePost === M1 + '-02', { n: inv2.posten.length, e: inv2.eersteMaand });
  toets('potAfschriftInvoer: categorie uit de vaste POT-regels (salarissen, loonheffing, pensioen)', inv2.posten.filter((q) => q.categorie === 'salarissen').length === 2 && inv2.posten[2].categorie === 'loonheffing' && inv2.posten[6].categorie === 'pensioen',
    inv2.posten.map((q) => q.categorie));
  const lez = (args, stdin) => { const u = spawnSync(process.execPath, ['--no-warnings', 'bank-lezer.js'].concat(args), { input: stdin || '{}', encoding: 'utf8', env: { PATH: process.env.PATH, BANK_DIR: BD, TZ: 'Europe/Amsterdam' } }); try { return JSON.parse(u.stdout.trim().split('\n').pop()); } catch (e) { return { stdout: u.stdout, stderr: u.stderr }; } };
  const k0 = lez(['pot-afschrift', '--maand', M]);
  toets('bank-lezer: transacties opgehaald vóór eind+2 → geweigerd, ook al zette de opdracht laatst_gezien op nu', k0.ok === false && /nog niet \(genoeg\) gelezen/.test(k0.reden || ''), k0);
  const mnd0 = lez(['pot-afschrift-maanden']);
  toets('pot-afschrift-maanden: dezelfde poort (niet compleet)', mnd0.ok && mnd0.maanden.find((x) => x.maand === M).compleet === false, mnd0.maanden && mnd0.maanden.find((x) => x.maand === M));
  stand(new Date().toISOString());
  const k1 = lez(['pot-afschrift', '--maand', M]);
  toets('bank-lezer pot-afschrift: nieuw, bestanden, telling, mailconcept, geen posten in de uitvoer', k1.ok === true && k1.nieuw === true && k1.veranderd === false && k1.aantal === 8 && k1.bestanden.length === 2 && k1.mail && !JSON.stringify(k1).includes(MW[0]), k1);
  const dir = path.join(BD, 'pot-afschriften', M);
  const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  toets('bestanden 600, mappen 700, sha in meta.json klopt', mode(path.join(BD, 'pot-afschriften')) === '700' && mode(dir) === '700' && mode(path.join(dir, 'POT-' + M + '.sta')) === '600' && mode(path.join(dir, 'meta.json')) === '600' &&
    crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'POT-afschrift ' + M + '.pdf'))).digest('hex') === JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'))).sha_pdf);
  const k2 = lez(['pot-afschrift', '--maand', M]);
  toets('tweede keer: niet nieuw, niet veranderd, zelfde sha (gemaakt hergebruikt)', k2.ok && !k2.nieuw && !k2.veranderd && k2.sha256.pdf === k1.sha256.pdf, k2);
  const k3 = lez(['pot-afschrift', '--maand', M1]);
  toets('volgende maand: begin sluit aan op het gemaakte eind', k3.ok === false && /loopt nog|nog niet/.test(k3.reden) || k3.ok === true, k3);
  // late boeking in M (zelfde dag als de laatste post, saldo erachter) → M veranderd; M+1 eerst geweigerd zolang M oud is
  const laatstePost = b.posten[b.posten.length - 1];
  A.bij(a, 'pot', [naarBank(Object.assign({ nr: 99999, datum: laatstePost.datum, bedrag: -1, saldo_na: Math.round((laatstePost.saldo_na - 1) * 100) / 100, tegenpartij: 'Leverancier A B.V.', tegen_iban: LEV, code: '658', regels: regels('SEPA Overboeking', { IBAN: LEV, Naam: 'Leverancier A B.V.' }) }))], null);
  const k4 = lez(['pot-afschrift', '--maand', M]);
  toets('late boeking: veranderd, nieuw tijdstip, vervangen_op in meta', k4.ok && k4.veranderd === true && k4.aantal === 9 && k4.gemaakt !== k1.gemaakt && JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'))).vervangen_op === k4.gemaakt, k4);
  toets('late boeking: correctietekst klaar voor het concept', /\(correctie\)$/.test(k4.mail_correctie.onderwerp) && /vervangt het afschrift/.test(k4.mail_correctie.bericht) && !/correctie/.test(k4.mail.onderwerp), [k4.mail, k4.mail_correctie]);
  // alleen de PDF anders (David verbetert een categorie): pdf_veranderd, MT940 gelijk, nieuw tijdstip
  const nrLev = a.db.prepare("SELECT nr FROM transacties WHERE rek = 'pot' AND tegenpartij = 'Leverancier A B.V.' AND datum = ?").get(M + '-05').nr;
  A.corrigeer(a, { nr: nrLev, categorie: 'pensioen' });
  const k5 = lez(['pot-afschrift', '--maand', M]);
  toets('alleen de PDF anders (categorie verbeterd): pdf_veranderd, niet veranderd, MT940 gelijk, nieuw tijdstip', k5.ok && k5.pdf_veranderd === true && k5.veranderd === false && k5.sha256.mt940 === k4.sha256.mt940 && k5.sha256.pdf !== k4.sha256.pdf && k5.gemaakt !== k4.gemaakt && k5.stuk_open === 0, k5);
  const mnd = lez(['pot-afschrift-maanden']);
  const mm = mnd.ok && mnd.maanden.find((x) => x.maand === M);
  toets('pot-afschrift-maanden: nieuwste eerst, compleet, gemaakt, geen namen', mnd.ok && mnd.maanden[0].maand === vandaag.slice(0, 7) && mnd.maanden[0].loopt_nog === true && mm.compleet === true && mm.gemaakt && mm.gemaakt.aantal === 9 && !JSON.stringify(mnd).includes(MW[0]) && mnd.ontvanger_gezet === false, mnd);
  toets('pot-ontvanger: weigert onzin, zet een adres (uitvoer alleen het domein)', lez(['pot-ontvanger'], '{"adres":"geen adres"}').ok === false && JSON.stringify(lez(['pot-ontvanger'], '{"adres":"boekhouder@voorbeeld.nl"}')) === '{"ok":true,"gezet":true,"domein":"voorbeeld.nl"}');
  toets('na pot-ontvanger: mailconcept-uitvoer met ontvanger', lez(['pot-afschrift', '--maand', M]).ontvanger === 'boekhouder@voorbeeld.nl');
  const fout = lez(['pot-afschrift', '--maand', '2026-13']);
  toets('ongeldige maand geweigerd', fout.ok === false && /JJJJ-MM/.test(fout.fout || ''), fout);
})();

// ── 7. statisch: niet via /smal/bank, wel lokaal; modules puur ──
(function () {
  const s = fs.readFileSync('server.js', 'utf8');
  const op = /const BANK_OPDRACHTEN = \[([^\]]*)\]/.exec(s)[1], lok = /const BANK_LOKAAL = \[([^\]]*)\]/.exec(s)[1];
  toets('server.js: pot-afschrift niet in BANK_OPDRACHTEN (niet via /smal/bank), wel in BANK_LOKAAL', op.indexOf('pot-afschrift') < 0 && lok.indexOf("'pot-afschrift'") >= 0 && lok.indexOf("'pot-afschrift-maanden'") >= 0);
  ['pot-afschrift.js', 'mt940-lezer.js'].forEach((f) => {
    const c = fs.readFileSync(f, 'utf8').split('\n').filter((x) => !/^\s*(\*|\/\/)/.test(x)).join('\n');
    toets(f + ': geen bestand-, netwerk- of procesmodule, geen klok', !/require\(['"](node:)?(fs|http|https|net|tls|dgram|dns|child_process|worker_threads|undici)['"]\)|\bfetch\s*\(|process\.|Date\.now|new Date\(\)/.test(c));
  });
})();

// ── 8. maandronde (server.js potAfschriftRonde + het POT-deel van het app-blok, vm-context, nagebootst kind en RPC) ──
(async function () {
  const vm = require('vm');
  const src = fs.readFileSync('server.js', 'utf8');
  const a = src.indexOf('// ── wv680: bankluis'), b = src.indexOf('// ── einde bankluis ──');
  const p1 = src.indexOf('// ── wv787: POT-afschriften (App'), p2 = src.indexOf('// ── Projecten (wv373');
  const BD = path.join(W, 'ronde-bank'); fs.mkdirSync(BD, { mode: 0o700 });
  const logs = [], rpc = [], box = [], kind = [];
  const g = { VV: () => require(require('path').resolve('vault-veilig.js')), require, fs, path, crypto, Buffer, console, URL, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, VAULT: W, SECRET: 'x'.repeat(40),
    __dirname: process.cwd(), process: { env: { BANK_DIR: BD, POT_AF_CODE_DIR: process.cwd(), TZ: 'Europe/Amsterdam' }, execPath: process.execPath, pid: process.pid },
    spawn: () => { throw new Error('geen kind'); }, fetch: async () => { throw new Error('geen netwerk'); },
    logError: (w, e) => logs.push(w + ': ' + (e && e.message || e)), schrijfLog: (x) => logs.push(x), nu: () => 'NU', velden: (o) => JSON.stringify(o),
    reqPath: (req) => (req.url || '').split('?')[0], rolPoort: (res, verder) => verder(), rol: { eerste: true }, rolPrimair: () => true, rolEerste: Promise.resolve(), ROL_START_WACHT_MS: 50 };
  const ctx = vm.createContext(g);
  vm.runInContext(src.slice(p1, p2) + '\n' + src.slice(a, b) + '\n;globalThis.__r = { potAfschriftRonde, potAfStaat };', ctx, { filename: 'server.js#pot' });
  let antw = null, rpcFout = null;
  ctx.bankKind = async (args) => { kind.push(args.join(' ')); return { code: 0, j: antw }; };
  ctx.appSbRpc = async (fn, body) => { if (rpcFout) throw new Error(rpcFout); rpc.push({ fn, p: body.p }); return { ok: true }; };
  ctx.bankBoxRij = (m) => box.push(m);
  const R = ctx.__r;
  const ok = (maand, n) => ({ ok: true, maand, nieuw: true, veranderd: false, aantal: n == null ? 26 : n, bestanden: [], sha256: { mt940: 'a', pdf: 'b' } });
  let u = await R.potAfschriftRonde({ datum: '2026-11-02', uur: 18 });
  const u2 = await R.potAfschriftRonde({ datum: '2026-11-03', uur: 7 });
  toets('ronde: vóór de 3e en op de 3e vóór 12:00 te vroeg (geen kind)', u.reden === 'te vroeg' && u2.reden === 'te vroeg' && kind.length === 0, [u, u2]);
  antw = ok('2026-10');
  u = await R.potAfschriftRonde({ datum: '2026-11-03', uur: 18 });
  const kaart = rpc[0] && rpc[0].p;
  toets('ronde: de 3e om 18:00 → afschrift van oktober + één kaart', u.gedaan === true && u.maand === '2026-10' && kind[0] === 'pot-afschrift --maand 2026-10' && rpc.length === 1 && rpc[0].fn === 'mk_voor_jou_zet' && kaart.sleutel === 'pot-afschrift-2026-10', [u, kind, rpc]);
  toets('ronde: kaart in gewone taal: titel, privé, deadline de 10e, stappen in de kaart, geen bedrag/naam/pad/wv',
    /^POT — afschrift oktober 2026 naar André \(Acta Synergia\) sturen$/.test(kaart.titel) && kaart.prive === true && kaart.deadline === '2026-11-10' && kaart.stappen.length >= 5 &&
    geenGeheim(JSON.stringify(kaart)) && !/\/opt\/|wv\d|\.md\b/.test(JSON.stringify(kaart)) && kaart.soort === 'doen', kaart);
  u = await R.potAfschriftRonde({ datum: '2026-11-04', uur: 7 });
  toets('ronde: daarna "al gedaan" (geen tweede kaart, geen kind)', u.reden === 'al gedaan' && rpc.length === 1 && kind.length === 1, u);
  // december: maand niet compleet, wachten tot de 10e, dan één kaart "zelf downloaden" + één box-rij
  antw = { ok: false, geweigerd: true, maand: '2026-11', reden: 'de bank is na 30-11-2026 nog niet (genoeg) gelezen; late boekingen kunnen nog ontbreken' };
  u = await R.potAfschriftRonde({ datum: '2026-12-04', uur: 18 });
  toets('ronde: geweigerd vóór de 10e → stil wachten (geen kaart, geen box)', u.uitkomst === 'wacht' && rpc.length === 1 && box.length === 0, u);
  u = await R.potAfschriftRonde({ datum: '2026-12-10', uur: 7 });
  const niet = rpc[1] && rpc[1].p;
  toets('ronde: vanaf de 10e één kaart "zelf bij ABN downloaden" + één box-rij', u.uitkomst === 'kaart zelf downloaden' && niet && niet.sleutel === 'pot-afschrift-2026-11-niet' && /zelf bij ABN downloaden/.test(niet.titel) && /MT940/.test(niet.stappen.join(' ')) && box.length === 1 && geenGeheim(JSON.stringify(niet)), [u, niet, box]);
  u = await R.potAfschriftRonde({ datum: '2026-12-11', uur: 7 });
  toets('ronde: niet-kaart ook maar één keer', u.reden === 'al gedaan' && rpc.length === 2 && box.length === 1, u);
  {
    const ctx2 = vm.createContext(Object.assign({}, g, { process: { env: { BANK_DIR: path.join(W, 'ronde-bank-2'), POT_AF_CODE_DIR: process.cwd(), TZ: 'Europe/Amsterdam' }, execPath: process.execPath, pid: process.pid } }));
    vm.runInContext(src.slice(p1, p2) + '\n' + src.slice(a, b) + '\n;globalThis.__r = { potAfschriftRonde };', ctx2, { filename: 'server.js#pot2' });
    const rpc2 = [];
    ctx2.bankKind = async () => ({ code: 0, j: { ok: false, geweigerd: true, reden: 'het eindsaldo van september 2026 is veranderd sinds dat afschrift gemaakt is (late boeking); maak dat afschrift opnieuw en stuur het André als correctie, daarna kan oktober 2026' } });
    ctx2.appSbRpc = async (fn, body) => { rpc2.push(body.p); return { ok: true }; };
    ctx2.bankBoxRij = () => {};
    await ctx2.__r.potAfschriftRonde({ datum: '2026-11-10', uur: 7 });
    const k = rpc2[0];
    toets('ronde: reden "vorige maand veranderd" → kaart "september opnieuw maken", niet "bij ABN downloaden"', k && /september 2026 opnieuw maken, daarna oktober 2026/.test(k.titel) && /Maak opnieuw/.test(k.stappen.join(' ')) && !/ABN/.test(k.stappen.join(' ')) && geenGeheim(JSON.stringify(k)), k);
  }
  // januari → december vorig jaar; concept al gemaakt → overslaan
  const st = R.potAfStaat(); st.maanden['2026-12'] = { concept_id: 'r-9', concept_op: '2027-01-02T10:00:00Z' }; fs.writeFileSync(path.join(BD, 'pot-afschriften', 'pod.json'), JSON.stringify(st));
  u = await R.potAfschriftRonde({ datum: '2027-01-05', uur: 18 });
  toets('ronde: januari → december vorig jaar; concept al gemaakt → geen kaart', u.maand === '2026-12' && u.reden === 'concept al gemaakt' && rpc.length === 2, u);
  // RPC faalt → één box-rij, volgende ronde opnieuw; dezelfde reden niet nog eens in de box
  antw = ok('2027-01'); rpcFout = 'rpc mk_voor_jou_zet http 500';
  u = await R.potAfschriftRonde({ datum: '2027-02-03', uur: 18 });
  const u3 = await R.potAfschriftRonde({ datum: '2027-02-04', uur: 7 });
  toets('ronde: RPC faalt → fout, één box-rij, volgende ronde probeert opnieuw (zelfde reden niet nog eens)', u.fout && u3.fout && box.length === 2 && kind.filter((k) => /2027-01/.test(k)).length === 2, [u, u3, box.length]);
  rpcFout = null;
  u = await R.potAfschriftRonde({ datum: '2027-02-04', uur: 18 });
  toets('ronde: daarna lukt het → kaart', u.uitkomst === 'kaart gezet' && rpc.length === 3, u);
  antw = ok('2027-02', 0);
  u = await R.potAfschriftRonde({ datum: '2027-03-03', uur: 18 });
  toets('ronde: maand zonder posten → geen kaart', u.uitkomst === 'geen posten' && rpc.length === 3, u);
  toets('ronde: pod.json 600, geen bedrag of naam', (fs.statSync(path.join(BD, 'pot-afschriften', 'pod.json')).mode & 0o777) === 0o600 && geenGeheim(fs.readFileSync(path.join(BD, 'pot-afschriften', 'pod.json'), 'utf8')));
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + e.stack); process.exit(1); });
JS
