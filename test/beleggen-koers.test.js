'use strict';
// wv3728 (besluit nr 138 / 2C38): dagkoersen en vanzelf nieuws — beleggen.js (waardeVandaag, koersData, zetKoersen, zetAutoBedrijven, kaartje uit)
// en beleggen-nieuws.js (koersronde, koersAlleen, tik) op VERZONNEN antwoorden in de vorm die op 21-11 gemeten is (efts.sec.gov, api.nasdaq.com,
// data-api.ecb.europa.eu). Geen netwerk. Bedrijven "Voorbeeld …", ISIN's, koersen en aantallen zijn verzonnen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const N = require(process.env.BN_JS || '../beleggen-nieuws.js');
const B = require(process.env.BL_JS || '../beleggen.js');
const H = require('../harvester.js');

const ISIN = 'US0000000017';
const AANTAL = '13.37', KOERS = '271.83';   // herkenbaar: mag in geen enkel uitgaand adres staan
const efts = (hits) => JSON.stringify({ hits: { hits: hits.map(([id, entity, tickers]) => ({ _id: String(id), _source: { entity, tickers } })) } });
const EFTS_CHIPS = efts([[1111, 'VOORBEELD CHIPS HOLDINGS (VBCX)', 'VBCX'], [2222, 'VOORBEELD CHIPS SPV', null]]);
const EFTS_AI = efts([[3333, 'Voorbeeld AI, PBC (VBAI)', 'VBAI'], [4444, 'VOORBEELD AI SPV LP', null], [5555, 'Voorbeeld AI Fonds LLC', null]]);
function nasdaq(code, rijen) {
  return JSON.stringify({ data: { symbol: code, totalRecords: rijen.length, tradesTable: { asOf: null, headers: { date: 'Date', close: 'Close/Last' },
    rows: rijen.map(([d, c]) => ({ date: d.slice(5, 7) + '/' + d.slice(8, 10) + '/' + d.slice(0, 4), close: c, volume: '1,000', open: c, high: c, low: c })) } } });
}
const ecb = (rijen) => 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS\n' + rijen.map(([d, v]) => 'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,' + d + ',' + v + ',A').join('\n') + '\n';

// wv3777: Euronext-CSV en "Trading information"-blok in de vorm die 21-11 gemeten is (dd/mm/jjjj; ETF-rijen hebben een tiende kolom vwap)
const euCsv = (isin, rijen) => '\uFEFF"Historical Data"\n"From 2026-09-22 to 2026-11-21"\n' + isin + '\nDate;Open;High;Low;Last;Close;"Number of Shares";"Number of Trades";Turnover\n' +
  rijen.map(([d, c]) => d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) + ';' + c + ';' + c + ';' + c + ';' + c + ';' + c + ';1000;10;1000;' + c).join('\n') + (rijen.length ? '\n' : '');
const euBlok = (v) => '<div class="card"><h3>Trading Information</h3><table><tr><td>Trading currency</td><td><strong>' + v + '</strong></td></tr><tr><td>Ticker ETF</td><td>VBWE</td></tr></table></div>';
const EU_ISIN = 'IE0000000013', EU_AANTAL = '7.13', EU_KOERS = '113.31';

function wereld(o) {
  o = o || {};
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-koers-'));
  const w = { log: [], box: [], uit: [], vandaag: '2026-11-21', klok: { datum: '2026-11-21', uur: 6, min: 40 }, kapot: new Set(), nasdaq: null, ecb: null };
  w.m = B.maak({ dbPad: path.join(map, 'beleggen.sqlite'), vaultSchrijf: () => {}, vandaag: () => w.vandaag });
  w.P = (pad, body) => { const u = w.m.app({ methode: 'POST', pad: '/app/beleggen/' + pad, body }); assert.strictEqual(u.status, 200, pad + ': ' + JSON.stringify(u.body)); return u.body; };
  w.nasdaq = nasdaq('VBCX', [['2026-11-21', '$999.99'], ['2026-11-20', '$271.83'], ['2026-11-19', '$1,250.00'.replace('1,250.00', '250.00')], ['2026-11-18', '$260.10']]);
  w.ecb = ecb([['2026-11-20', '1.0968'], ['2026-11-19', '1.1000'], ['2026-11-18', '1.0900']]);
  // wv3777: Euronext per ISIN-MIC; standaard nergens genoteerd (lege CSV met kop)
  w.eu = {}; w.euValuta = {};
  w.euronext = (url) => {
    const u = new URL(url);
    const m = /\/getFullDownloadAjax\/([A-Z0-9]{12})-([A-Z]{4})$/.exec(u.pathname), v = /\/STOCK\/([A-Z0-9]{12})-([A-Z]{4})\/fs_tradinginfo_block$/.exec(u.pathname);
    if (m) return typeof w.eu[m[1] + '-' + m[2]] === 'string' ? w.eu[m[1] + '-' + m[2]] : euCsv(m[1], w.eu[m[1] + '-' + m[2]] || []);
    if (v) { const c = w.euValuta[v[1] + '-' + v[2]] || 'EUR'; return c === '-' ? '<div></div>' : euBlok(c); }
    return 'onbekend';
  };
  const haal = async (url) => {
    w.uit.push(url);
    const h = new URL(url).hostname;
    for (const k of w.kapot) if (h.includes(k)) throw new Error('http 503');
    if (h === 'efts.sec.gov') { const q = new URL(url).searchParams.get('keysTyped'); return /chips/.test(q) ? EFTS_CHIPS : /ai/.test(q) ? EFTS_AI : efts([]); }
    if (h === 'api.nasdaq.com') return w.nasdaq;
    if (h === 'data-api.ecb.europa.eu') return w.ecb;
    if (h === 'live.euronext.com') return w.euronext(url);   // wv3777
    if (h === 'data.sec.gov') return JSON.stringify({ filings: { recent: { form: [], filingDate: [] } } });
    return '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>';
  };
  w.n = N.maak({ beleggen: w.m, leesFeed: H.leesFeed, pauze: async () => {}, nuIso: () => w.vandaag + 'T06:40:00.000Z',
    haal, haalKoers: async (url, a) => { w.koersUA = true; return haal(url, a); },
    claude: async () => ({ ok: false, fout: 'niet in deze toets' }), bericht: async () => ({ ok: true, id: 'x' }),
    klok: () => w.klok, log: (x) => w.log.push(x), boxRij: (t) => { w.box.push(t); return true; }, hartslag: async () => {} });
  // Davids situatie (verzonnen): één aankoop in USD via de hand, één bedrijf op de volglijst, nog geen kaartjes
  w.P('transactie', { actie: 'zet', richting: 'erbij', datum: '2026-11-13', naam: 'VOORBEELD CHIPS HOLDINGS', isin: ISIN, aantal: AANTAL, koers: KOERS, valuta: 'USD', waarde_eur: '3313.70', kosten_eur: '3' });
  w.P('volglijst', { actie: 'zet', naam: 'Voorbeeld AI', code: 'VBAI', waarom: 'laag onder AI' });
  w.get = () => w.m.app({ methode: 'GET', pad: '/app/beleggen' }).body;
  return w;
}

test('vóór: geen kaartjes, stand op aankoopwaarde zonder waarde van vandaag', () => {
  const w = wereld();
  const o = w.get();
  assert.strictEqual(o.stand.bron, 'aankoop');
  assert.ok(o.stand.vandaag && o.stand.vandaag.volledig === false && o.stand.vandaag.zonder_koers === 1, 'zonder koers: geen waarde van vandaag');
  assert.strictEqual(o.stand.vandaag.waarde_cent, null);
  assert.ok(o.bedrijven.every((b) => !b.kaartje));
});

test('ochtendronde: ≥ 2 bedrijven, codes + SEC-nummer zelf gevonden, waarde van vandaag met koersdatum, uitgaand alleen codes', async () => {
  const w = wereld();
  const t = await w.n.ophaal(w.vandaag);
  assert.ok(t.bedrijven >= 2, 'ronde meldt ' + t.bedrijven + ' bedrijven');
  const lg = w.log.find((x) => x.soort === 'ophaal'); assert.ok(lg && lg.bedrijven >= 2);
  const k = w.log.find((x) => x.soort === 'koers'); assert.ok(k && k.gevonden === 2 && k.kaartjes === 2 && k.koersen === 3, JSON.stringify(k));
  const o = w.get();
  const chips = o.bedrijven.find((b) => b.sleutel === 'isin:' + ISIN), ai = o.bedrijven.find((b) => b.sleutel === 'volg:1');
  assert.deepStrictEqual([chips.kaartje.code, chips.kaartje.cik], ['VBCX', '0000001111']);
  assert.deepStrictEqual(chips.kaartje.namen, ['VOORBEELD CHIPS', 'Voorbeeld Chips'], 'titelvorm erbij (woorden ≥ 5 letters)');
  assert.deepStrictEqual([ai.kaartje.code, ai.kaartje.cik], ['VBAI', '0000003333'], 'volglijst: code van David → de treffer met die beurscode, niet de SPV');
  const v = o.stand.vandaag;
  assert.strictEqual(v.volledig, true);
  assert.strictEqual(v.koers_datum, '2026-11-20', 'de rij van vandaag (beurs nog open) telt niet');
  assert.strictEqual(v.wissel_datum, '2026-11-20');
  assert.strictEqual(v.waarde_cent, Math.round(13.37 * 271.83 / 1.0968 * 100));
  assert.strictEqual(v.gisteren_cent, Math.round(13.37 * 250 / 1.1 * 100));
  assert.strictEqual(v.verschil_dag_cent, v.waarde_cent - v.gisteren_cent);
  assert.strictEqual(v.aankoop_cent, 331670, 'aankoopwaarde incl. kosten uit de transactie');
  assert.strictEqual(v.verschil_aankoop_cent, v.waarde_cent - 331670);
  assert.strictEqual(v.oud, false);
  assert.ok(w.koersUA, 'Nasdaq via haalKoers (browser-UA)');
  // uitgaand: alleen de vaste hosts; geen aantal, koers of bedrag in een adres
  const koersAdressen = w.uit.filter((u) => /efts\.sec\.gov|api\.nasdaq\.com|data-api\.ecb/.test(u));
  assert.ok(koersAdressen.length === 5, koersAdressen.join('\n'));   // wv3754: + het vaste wereldindexfonds (URTH)
  assert.ok(koersAdressen.some((u) => u.includes('/quote/URTH/historical?assetclass=etf')), 'wereldindexfonds opgehaald');
  for (const u of w.uit) {
    for (const x of [AANTAL, AANTAL.replace('.', ''), AANTAL.replace('.', ','), KOERS, KOERS.replace('.', ''), '3313', '3316', String(v.waarde_cent), ISIN]) assert.ok(!u.includes(x), 'uitgaand adres bevat ' + x + ': ' + u);
  }
  for (const u of koersAdressen) assert.match(u, /^https:\/\/(efts\.sec\.gov\/LATEST\/search-index\?keysTyped=[a-z0-9%]+|api\.nasdaq\.com\/api\/quote\/[A-Z0-9.-]+\/historical\?assetclass=(stocks|etf)&fromdate=\d{4}-\d\d-\d\d&todate=\d{4}-\d\d-\d\d&limit=(20|60)|data-api\.ecb\.europa\.eu\/service\/data\/EXR\/D\.[A-Z]{3}\.EUR\.SP00\.A\?lastNObservations=(15|45)&format=csvdata)$/);
  // log: alleen aantallen
  assert.ok(!JSON.stringify(w.log).match(/VOORBEELD|Voorbeeld|VBCX|VBAI|271|1337/), JSON.stringify(w.log));
  // nieuws loopt nu voor beide bedrijven: SEC-stukken op het gevonden nummer
  assert.ok(w.uit.some((u) => u.includes('CIK0000001111')) && w.uit.some((u) => u.includes('CIK0000003333')));
});

test('koersbron uit → laatst bekende koers met datum, geen fout; na 4 dagen "oud"; na 3 dagen box-rij', async () => {
  const w = wereld();
  await w.n.ophaal(w.vandaag);
  const eerst = w.get().stand.vandaag;
  w.kapot.add('nasdaq'); w.kapot.add('ecb');
  for (const d of ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25']) { w.vandaag = d; const t = await w.n.ophaal(d); assert.ok(t.koers && !t.koers.fout, 'ronde loopt door'); }
  const v = w.get().stand.vandaag;
  assert.strictEqual(v.koers_datum, '2026-11-20');
  assert.strictEqual(v.waarde_cent, eerst.waarde_cent, 'laatst bekende koers');
  assert.strictEqual(v.oud, true, 'ouder dan 4 dagen');
  assert.ok(w.box.some((b) => /koersbron Nasdaq/.test(b)) && w.box.some((b) => /koersbron ECB/.test(b)), w.box.join('\n'));
  assert.ok(!w.box.join('').match(/VOORBEELD|Voorbeeld|VBCX/), 'geen bedrijfsnamen in de box');
  assert.strictEqual(w.box.filter((b) => /Nasdaq/.test(b)).length, 1, 'één keer per week');
});

test('verkeerde koers (factor > 2 t.o.v. de dag ervoor) of andere valuta wordt geweigerd; positie in EUR blijft zonder koers', async () => {
  const w = wereld();
  await w.n.ophaal(w.vandaag);
  w.vandaag = '2026-11-24';
  w.nasdaq = nasdaq('VBCX', [['2026-11-23', '$27.18'], ['2026-11-20', '$271.83']]);
  await w.n.ophaal(w.vandaag);
  assert.strictEqual(w.get().stand.vandaag.koers_datum, '2026-11-20', 'factor 10 lager = geweigerd');
  assert.ok(w.log.some((x) => x.soort === 'koers' && x.geweigerd >= 1));
  // nasdaq-antwoord voor een ander symbool = onleesbaar, niets opgeslagen
  w.vandaag = '2026-11-25'; w.nasdaq = nasdaq('ANDERS', [['2026-11-24', '$280.00']]);
  await w.n.ophaal(w.vandaag);
  assert.strictEqual(w.get().stand.vandaag.koers_datum, '2026-11-20');
  // pure functie: koers in USD bij een positie in EUR
  const r = B.waardeVandaag([{ sleutel: 'isin:X', regelsoort: 'effect', isin: 'NL0000000001', aantal: '2', valuta: 'EUR', waarde_eur_cent: 100 }],
    { NL0000000001: [{ datum: '2026-11-20', slot: '10', valuta: 'USD' }] }, {}, {}, '2026-11-21');
  assert.strictEqual(r.volledig, false); assert.match(r.posities['isin:X'].reden, /koers in USD, positie in EUR/);
  const e = B.waardeVandaag([{ sleutel: 'isin:Y', regelsoort: 'effect', isin: 'NL0000000002', aantal: '2', valuta: 'EUR', waarde_eur_cent: 100 }],
    { NL0000000002: [{ datum: '2026-11-20', slot: '10.5', valuta: 'EUR' }] }, {}, {}, '2026-11-21');
  assert.strictEqual(e.waarde_cent, 2100, 'EUR zonder wisselkoers'); assert.strictEqual(e.verschil_aankoop_cent, null, 'aankoop onbekend = geen verschil');
  const g = B.waardeVandaag([{ sleutel: 'isin:Z', regelsoort: 'effect', isin: 'US0000000025', aantal: '1', valuta: 'USD', waarde_eur_cent: 1 }],
    { US0000000025: [{ datum: '2026-11-20', slot: '10', valuta: 'USD' }] }, { USD: [{ datum: '2026-11-21', per_eur: '1.1' }] }, {}, '2026-11-21');
  assert.strictEqual(g.volledig, false, 'alleen een wisselkoers van ná de koersdatum = geen wisselkoers'); assert.strictEqual(g.posities['isin:Z'].reden, 'geen wisselkoers');
});

test('Geen nieuws meer = blijft uit (ronde zet het niet terug); opnieuw instellen = weer aan', async () => {
  const w = wereld();
  await w.n.ophaal(w.vandaag);
  w.P('bedrijf', { sleutel: 'volg:1', actie: 'weg' });
  w.vandaag = '2026-11-22';
  await w.n.ophaal(w.vandaag);
  let ai = w.get().bedrijven.find((b) => b.sleutel === 'volg:1');
  assert.strictEqual(ai.kaartje, null); assert.strictEqual(ai.uit, true);
  assert.strictEqual(w.m.zetAutoBedrijven([{ sleutel: 'volg:1', namen: ['Voorbeeld AI'] }]), 0, 'ook rechtstreeks: uit wordt niet vanzelf aan');
  w.P('bedrijf', { sleutel: 'volg:1', actie: 'zet', namen: ['Voorbeeld AI'], code: 'VBAI' });
  ai = w.get().bedrijven.find((b) => b.sleutel === 'volg:1');
  assert.ok(ai.kaartje); assert.strictEqual(ai.uit, false);
  // een kaartje dat David zelf instelde blijft onaangeroerd
  w.P('bedrijf', { sleutel: 'isin:' + ISIN, actie: 'zet', namen: ['Voorbeeld Chips', 'VBCX'], producten: ['Voorbeeldchip'], code: 'VBCX' });
  w.vandaag = '2026-11-23'; await w.n.ophaal(w.vandaag);
  const chips = w.get().bedrijven.find((b) => b.sleutel === 'isin:' + ISIN);
  assert.deepStrictEqual(chips.kaartje.producten, ['Voorbeeldchip']);
});

test('na een uitrol: op een dag waarop de ochtendronde al liep doet de tik alleen de koersronde, één keer', async () => {
  const w = wereld();
  w.m.metDb((db) => db.prepare("INSERT INTO meta (sleutel, waarde) VALUES ('nieuws_ophaal_dag', ?)").run(w.vandaag), true);
  w.klok = { datum: w.vandaag, uur: 14, min: 5 };
  const a = await w.n.tik();
  assert.ok(a.koers && a.koers.koersen === 3 && !a.ophaal, JSON.stringify(a));
  const b = await w.n.tik();
  assert.ok(!b.koers && !b.ophaal, 'tweede tik doet niets');
  // vóór 06:40 nog niets
  const w2 = wereld(); w2.klok = { datum: w2.vandaag, uur: 6, min: 0 };
  const c = await w2.n.tik(); assert.ok(!c.koers && !c.ophaal);
});

test('review MOET 1: meer aandelenklassen onder één SEC-nummer → geen beurscode en geen koers, wel SEC-nummer voor het nieuws', async () => {
  const w = wereld();
  const twee = efts([[1111, 'VOORBEELD CHIPS HOLDINGS (VBCX, VBCXB)', 'VBCX, VBCXB']]);
  const oud = w.n; void oud;
  w.m.metDb(() => null, false);
  const r = N.secZoek(twee, 'VOORBEELD CHIPS', null);
  assert.deepStrictEqual(r, { code: null, cik: '0000001111', naam_bron: 'VOORBEELD CHIPS HOLDINGS', fout: 'meer aandelenklassen' });
  assert.strictEqual(N.secZoek(twee, 'VOORBEELD CHIPS', 'VBCXB').code, 'VBCXB', 'met de code van David wel');
});

test('review MOET 1: een positie met een niet-Amerikaanse ISIN krijgt geen Nasdaq-koers', async () => {
  const w = wereld();
  w.P('transactie', { actie: 'zet', richting: 'erbij', datum: '2026-11-13', naam: 'VOORBEELD CHIPS HOLDINGS', isin: 'NL0000000014', aantal: '1', koers: '10', valuta: 'USD', waarde_eur: '9', kosten_eur: '0' });
  await w.n.ophaal(w.vandaag);
  assert.strictEqual(w.uit.filter((u) => u.includes('api.nasdaq.com') && !u.includes('/URTH/')).length, 1, 'alleen de US-ISIN');   // wv3754: + het vaste wereldindexfonds
  const v = w.get().stand.vandaag;
  assert.strictEqual(v.volledig, false); assert.strictEqual(v.posities['isin:NL0000000014'].reden, 'nog geen koers');
});

test('review MOET 2: een beurscode die David zelf zet gaat voor; oude koersen van die positie vervallen', async () => {
  const w = wereld();
  await w.n.ophaal(w.vandaag);
  assert.strictEqual(w.get().stand.vandaag.volledig, true);
  w.P('bedrijf', { sleutel: 'isin:' + ISIN, actie: 'zet', namen: ['Voorbeeld Chips'], code: 'VBCXB' });
  assert.strictEqual(w.get().stand.vandaag.volledig, false, 'oude koersen weg');
  w.vandaag = '2026-11-22';
  w.nasdaq = nasdaq('VBCXB', [['2026-11-20', '$135.00'], ['2026-11-19', '$130.00']]);
  await w.n.ophaal(w.vandaag);
  assert.ok(w.uit.some((u) => u.includes('/quote/VBCXB/')), 'nieuwe code gebruikt');
  assert.ok(!w.uit.slice(-20).some((u) => u.includes('/quote/VBCX/')), 'oude code niet meer');
  assert.strictEqual(w.get().stand.vandaag.posities['isin:' + ISIN].koers, '135.00');
});

test('review ZOU 1: onleesbaar antwoord telt als bronfout (box na drie dagen), niet als ok', async () => {
  const w = wereld();
  w.nasdaq = '<html>niet wat we verwachten</html>';
  for (const d of ['2026-11-21', '2026-11-22', '2026-11-23']) { w.vandaag = d; await w.n.ophaal(d); }
  assert.ok(w.box.some((b) => /koersbron Nasdaq/.test(b) && /onleesbaar antwoord/.test(b)), w.box.join('\n'));
});

test('review ZOU 2: zoektocht faalt eerst → kaartje zonder SEC-nummer; volgende ochtend aangevuld', async () => {
  const w = wereld();
  w.kapot.add('efts');
  await w.n.ophaal(w.vandaag);
  let ai = w.get().bedrijven.find((b) => b.sleutel === 'volg:1');
  assert.ok(ai.kaartje && ai.kaartje.cik === null && ai.kaartje.code === 'VBAI', 'kaartje wel aan (Google Nieuws), nog zonder SEC-nummer');
  w.kapot.delete('efts'); w.vandaag = '2026-11-22';
  await w.n.ophaal(w.vandaag);
  ai = w.get().bedrijven.find((b) => b.sleutel === 'volg:1');
  assert.strictEqual(ai.kaartje.cik, '0000003333');
  const chips = w.get().bedrijven.find((b) => b.sleutel === 'isin:' + ISIN);
  assert.strictEqual(chips.kaartje.cik, '0000001111');
});

test('lezers: SEC-zoeker, Nasdaq, ECB', () => {
  assert.deepStrictEqual(N.secZoek(EFTS_CHIPS, 'VOORBEELD CHIPS', null), { code: 'VBCX', cik: '0000001111', naam_bron: 'VOORBEELD CHIPS HOLDINGS' });
  assert.strictEqual(N.secZoek(efts([[9, 'VOORBEELD CHIPSFABRIEK CORP (VBCF)', 'VBCF']]), 'VOORBEELD CHIPS', null), null, 'lijkt-op telt niet');
  assert.strictEqual(N.secZoek(EFTS_AI, 'Voorbeeld AI', 'XXXX'), null, 'code van David moet bij de treffer horen');
  assert.deepStrictEqual(N.secZoek('<html>', 'x', null), { fout: 'geen JSON' });
  assert.deepStrictEqual(N.nasdaqRijen(nasdaq('VBCX', [['2026-11-20', '$1,266.22'], ['2026-11-21', '$1.00'], ['2026-11-19', 'N/A']]), 'VBCX', '2026-11-21'), [{ datum: '2026-11-20', slot: '1266.22' }]);
  assert.strictEqual(N.nasdaqRijen('{"data":null}', 'VBCX', '2026-11-21'), null);
  assert.deepStrictEqual(N.ecbRijen(ecb([['2026-11-20', '1.0968']])), [{ datum: '2026-11-20', per_eur: '1.0968' }]);
  assert.strictEqual(N.ecbRijen('iets anders'), null);
  assert.deepStrictEqual(N.metTitelvorm(['NVIDIA', 'ASML', 'Voorbeeld']), ['NVIDIA', 'Nvidia', 'ASML', 'Voorbeeld']);
});

// ── wv3777: posities in euro via Euronext ──
function metEuPositie(beurs) {
  const w = wereld();
  w.P('transactie', { actie: 'zet', richting: 'erbij', datum: '2026-11-14', naam: 'VOORBEELD WERELD ETF', isin: EU_ISIN, aantal: EU_AANTAL, koers: EU_KOERS, valuta: 'EUR', waarde_eur: '807.90', kosten_eur: '1' });
  if (beurs) w.m.metDb((db) => db.prepare('UPDATE transactie SET beurs = ? WHERE isin = ?').run(beurs, EU_ISIN), true);
  return w;
}
const euUit = (w) => w.uit.filter((u) => u.includes('live.euronext.com'));

test('wv3777: positie in euro (beurs EAM) krijgt de slotkoers van Euronext Amsterdam; totaal Waarde vandaag weer compleet; uitgaand alleen ISIN-beurs + datum', async () => {
  const w = metEuPositie('EAM');
  w.eu[EU_ISIN + '-XAMS'] = [['2026-11-21', '999.00'], ['2026-11-20', '113.31'], ['2026-11-19', '115.00'], ['2026-11-18', '114.20']];
  await w.n.ophaal(w.vandaag);
  const v = w.get().stand.vandaag;
  assert.strictEqual(v.volledig, true, JSON.stringify(v.posities));
  const p = v.posities['isin:' + EU_ISIN];
  assert.deepStrictEqual([p.koers, p.valuta, p.datum], ['113.31', 'EUR', '2026-11-20'], 'afgesloten beursdag, geen rij van vandaag');
  assert.strictEqual(p.waarde_cent, Math.round(7.13 * 113.31 * 100), 'euro: geen wisselkoers nodig');
  assert.strictEqual(p.vorige_cent, Math.round(7.13 * 115 * 100));
  const bron = w.m.metDb((db) => db.prepare('SELECT DISTINCT bron FROM koers WHERE isin = ?').all(EU_ISIN).map((r) => r.bron), false);
  assert.deepStrictEqual(bron, ['euronext:XAMS']);
  const uit = euUit(w);
  assert.strictEqual(uit.length, 2, 'één CSV + één valutablok: ' + uit.join(' '));
  for (const u of uit) {
    const x = new URL(u);
    assert.ok(x.pathname.endsWith('/' + EU_ISIN + '-XAMS') || x.pathname.endsWith('/' + EU_ISIN + '-XAMS/fs_tradinginfo_block'), x.pathname);
    for (const [k, val] of x.searchParams) assert.ok(!/\d/.test(val) || /^\d{4}-\d{2}-\d{2}$/.test(val), 'alleen datums als getal: ' + k + '=' + val);
  }
  const alles = uit.join(' ');   // (de bedrijfsnaam gaat al sinds wv3728 naar de SEC-zoeker en de nieuwsbronnen; Euronext krijgt alleen de ISIN)
  for (const geheim of [EU_AANTAL, EU_KOERS, '807', 'WERELD', 'VOORBEELD', AANTAL, KOERS]) assert.ok(!alles.includes(geheim), 'lekt ' + geheim);
  assert.ok(w.koersUA, 'via haalKoers (browser-UA, zelfde poort)');
  assert.ok(new URL(uit[0]).searchParams.get('startdate') <= '2026-09-22', 'eerste keer ± 2 maanden (koerslijntje)');
  const k = w.log.find((x) => x.soort === 'koers'); assert.strictEqual(k.eu, 1);
  // wv3754: de vergelijking met het wereldindexfonds blijft lopen
  assert.ok(w.uit.some((u) => u.includes('/URTH/')));
});

test('wv3777: andere Euronext-beurs uit DEGIRO (EPA → Parijs eerst); onbekende beurs → Amsterdam, dan Parijs; nergens = zonder koers, geen bronfout', async () => {
  const a = metEuPositie('EPA');
  a.eu[EU_ISIN + '-XPAR'] = [['2026-11-20', '113.31']];
  await a.n.ophaal(a.vandaag);
  assert.ok(euUit(a)[0].includes(EU_ISIN + '-XPAR'), 'eerst de eigen beurs');
  assert.strictEqual(a.get().stand.vandaag.posities['isin:' + EU_ISIN].koers, '113.31');
  const b = metEuPositie('XET');
  b.eu[EU_ISIN + '-XPAR'] = [['2026-11-20', '113.40']];
  await b.n.ophaal(b.vandaag);
  assert.deepStrictEqual(euUit(b).map((u) => /-(X[A-Z]{3})/.exec(u)[1]), ['XAMS', 'XPAR', 'XPAR'], 'Amsterdam leeg → Parijs, valuta van Parijs');
  assert.strictEqual(b.get().stand.vandaag.posities['isin:' + EU_ISIN].koers, '113.40');
  const c = metEuPositie(null);
  await c.n.ophaal(c.vandaag);
  assert.strictEqual(euUit(c).length, 2, 'Amsterdam en Parijs geprobeerd, geen valutavraag');
  const v = c.get().stand.vandaag;
  assert.strictEqual(v.volledig, false); assert.strictEqual(v.posities['isin:' + EU_ISIN].reden, 'nog geen koers');
  assert.ok(!c.m.metDb((db) => db.prepare("SELECT 1 FROM nieuws_bron WHERE bron = 'koers_eu' AND fouten_op_rij > 0").get(), false), 'niet genoteerd ≠ bronfout');
  assert.strictEqual(c.log.find((x) => x.soort === 'koers').eu_niet, 1);
});

test('wv3777: valuta uit de bron — Euronext zegt USD bij een positie in euro → geen koers (geweigerd); geen valuta in het blok = bronfout', async () => {
  const w = metEuPositie('EAM');
  w.eu[EU_ISIN + '-XAMS'] = [['2026-11-20', '120.00']]; w.euValuta[EU_ISIN + '-XAMS'] = 'USD';
  await w.n.ophaal(w.vandaag);
  assert.strictEqual(w.get().stand.vandaag.posities['isin:' + EU_ISIN].reden, 'nog geen koers');
  assert.strictEqual(w.log.find((x) => x.soort === 'koers').eu_valuta, 1);
  assert.ok(!euUit(w).some((u) => u.includes('-XPAR')), 'niet verder zoeken op een andere beurs');
  const z = metEuPositie('EAM');
  z.eu[EU_ISIN + '-XAMS'] = [['2026-11-20', '120.00']]; z.euValuta[EU_ISIN + '-XAMS'] = '-';
  await z.n.ophaal(z.vandaag);
  assert.strictEqual(z.get().stand.vandaag.posities['isin:' + EU_ISIN].reden, 'nog geen koers', 'geen valuta = geen koers raden');
  assert.ok(z.m.metDb((db) => db.prepare("SELECT 1 FROM nieuws_bron WHERE bron = 'koers_eu_valuta' AND fouten_op_rij = 1").get(), false), 'telt als bronfout');
});

test('wv3777: Euronext valt uit → laatst bekende koers met datum blijft; onleesbaar = bronfout zonder andere beurs; na drie dagen één box-rij; factor-2-vangnet', async () => {
  const w = metEuPositie('EAM');
  w.eu[EU_ISIN + '-XAMS'] = [['2026-11-20', '113.31'], ['2026-11-19', '115.00']];
  await w.n.ophaal(w.vandaag);
  for (const [dag, fout] of [['2026-11-22', 'kapot'], ['2026-11-23', 'onleesbaar'], ['2026-11-24', 'kapot']]) {
    w.vandaag = dag; w.uit.length = 0;
    if (fout === 'kapot') w.kapot.add('euronext'); else { w.kapot.delete('euronext'); w.eu[EU_ISIN + '-XAMS'] = 'Sorry, we are down'; }
    await w.n.ophaal(w.vandaag);
    assert.strictEqual(euUit(w).length, 1, dag + ': na een fout geen tweede beurs of valutavraag');
    const p = w.get().stand.vandaag.posities['isin:' + EU_ISIN];
    assert.deepStrictEqual([p.koers, p.datum], ['113.31', '2026-11-20'], dag + ': laatst bekende koers');
  }
  const box = w.box.filter((t) => /Euronext/.test(t));
  assert.strictEqual(box.length, 1, 'na drie foutdagen één box-rij'); assert.ok(!box[0].includes('WERELD'), 'geen namen in de box');
  // herstel; dan een koers die meer dan een factor 2 afwijkt → geweigerd
  w.kapot.delete('euronext'); w.vandaag = '2026-11-26';
  w.eu[EU_ISIN + '-XAMS'] = [['2026-11-25', '11.33'], ['2026-11-24', '114.00']];
  await w.n.ophaal(w.vandaag);
  const p = w.get().stand.vandaag.posities['isin:' + EU_ISIN];
  assert.deepStrictEqual([p.koers, p.datum], ['114.00', '2026-11-24'], 'factor 10 lager = geweigerd, de dag ervoor telt');
});

test('wv3777: een positie in euro met een Amerikaanse ISIN, of in een andere valuta, gaat niet naar Euronext', async () => {
  const w = wereld();
  w.P('transactie', { actie: 'zet', richting: 'erbij', datum: '2026-11-14', naam: 'VOORBEELD ZWITSER', isin: 'CH0000000016', aantal: '1', koers: '10', valuta: 'CHF', waarde_eur: '10', kosten_eur: '0' });
  w.P('transactie', { actie: 'zet', richting: 'erbij', datum: '2026-11-14', naam: 'VOORBEELD AMERIKA IN EURO', isin: 'US0000000033', aantal: '1', koers: '10', valuta: 'EUR', waarde_eur: '10', kosten_eur: '0' });
  await w.n.ophaal(w.vandaag);
  assert.strictEqual(euUit(w).length, 0, 'CHF en US-ISIN in euro: geen Euronext');
  assert.strictEqual(w.get().stand.vandaag.posities['isin:US0000000033'].reden, 'nog geen koers');
});

test('wv3777: lezers Euronext', () => {
  assert.deepStrictEqual(N.euronextRijen(euCsv(EU_ISIN, [['2026-11-21', '1.00'], ['2026-11-20', '1,234.50'.replace(',', '')]]), EU_ISIN, '2026-11-21'), [{ datum: '2026-11-20', slot: '1234.50' }]);
  assert.strictEqual(N.euronextRijen(euCsv('IE0000000021', [['2026-11-20', '1']]), EU_ISIN, '2026-11-21'), null, 'andere ISIN in de echo = onleesbaar');
  assert.strictEqual(N.euronextRijen('<html>Access denied</html>', EU_ISIN, '2026-11-21'), null);
  assert.strictEqual(N.euronextRijen(euCsv(EU_ISIN, []).replace(';Close;', ';Slot;'), EU_ISIN, '2026-11-21'), null, 'geen Close-kolom = onleesbaar');
  assert.deepStrictEqual(N.euronextRijen(euCsv(EU_ISIN, []), EU_ISIN, '2026-11-21'), [], 'niet genoteerd = leeg, geen fout');
  assert.deepStrictEqual(N.euronextRijen(euCsv(EU_ISIN, [['2026-11-20', '-3'], ['2026-11-19', 'n/a'], ['2026-11-18', '5']]), EU_ISIN, '2026-11-21'), [{ datum: '2026-11-18', slot: '5' }]);
  assert.strictEqual(N.euronextValuta(euBlok('EUR')), 'EUR'); assert.strictEqual(N.euronextValuta(euBlok('USD')), 'USD');
  assert.strictEqual(N.euronextValuta('<div>\n</div>'), null); assert.strictEqual(N.euronextValuta(euBlok('euro')), null);
  assert.deepStrictEqual(N.euMics('EAM'), ['XAMS', 'XPAR']); assert.deepStrictEqual(N.euMics('epa'), ['XPAR', 'XAMS']); assert.deepStrictEqual(N.euMics('MIL'), ['MTAA', 'XAMS', 'XPAR']);
  assert.deepStrictEqual(N.euMics('XET'), ['XAMS', 'XPAR']); assert.deepStrictEqual(N.euMics(null), ['XAMS', 'XPAR']);
});
