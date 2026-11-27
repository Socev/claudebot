'use strict';
// wv4012 — Strateeg › zesde boek Ideeën (fictief). Toetsen uit ontwerp § 8 met nep-bronnen, nep-model en nep-klok; databank in het geheugen.
// Draaien: node --test test/strateeg-ideeen.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const DIR = process.env.ST_DIR || path.join(__dirname, '..');
const I = require(path.join(DIR, 'strateeg-ideeen-reken.js'));
const G = require(path.join(DIR, 'strateeg-ideeen.js'));
const S = require(path.join(DIR, 'strateeg.js'));
const H = require(path.join(DIR, 'harvester.js'));
const CFG = G.CFG;

const NVDA = 'US67066G1040';
const nlMs = (dag, hhmm) => Date.parse(dag + 'T' + hhmm + ':00+01:00');   // november = CET

function rss(items) {
  return '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>' + items.map((x, i) =>
    '<item><title>' + x.t + ' - ' + x.u + '</title><link>https://news.example.com/' + (x.l || i) + '</link><guid>g' + (x.l || i) + '</guid><pubDate>' + new Date(x.ms).toUTCString() + '</pubDate></item>').join('') + '</channel></rss>';
}
function wereld(o) {
  o = o || {};
  const ms = () => o.klok.t;
  const items = o.items || [];
  const log = { urls: [], prompts: [] };
  const haal = async (url) => {
    log.urls.push(url);
    if (url.startsWith('https://news.google.com/')) return rss(items);
    if (url.startsWith('https://efts.sec.gov/')) return JSON.stringify({ hits: { hits: [] } });
    if (url.includes('/public-search')) return JSON.stringify({ events: o.poly || [] });
    if (url.includes('gamma-api.polymarket.com/markets/')) return JSON.stringify(o.polyStand || {});
    if (url.includes('/.lstc/instrument/search/main')) {
      if (url.includes(NVDA) || /q=nvidia/i.test(url)) return JSON.stringify([{ instrumentId: 43763, isin: NVDA, displayname: 'NVIDIA CORP.      DL-,001', categorySymbol: 'STK' }]);
      return '[]';
    }
    if (url.includes('series=history')) {
      const data = []; for (let d = 30; d >= 1; d--) data.push([ms() - d * 86400000, o.slot || 100]);
      return JSON.stringify({ series: { history: { data } } });
    }
    if (url.includes('series=intraday')) {
      const k = o.koers || 100, t = ms();
      const data = [[t - 20 * 60000, k * 0.999], [t - 10 * 60000, k * 1.001], [t - 60000, k]].map(([a, b]) => [a + 3600000, b]);   // L&S: Berlijnse kloktijd als UTC
      return JSON.stringify({ info: { isin: NVDA, plotlines: [] }, series: { intraday: { data } } });
    }
    if (url.includes('nasdaq.com')) return JSON.stringify({ data: { rows: [] } });
    if (o.fout) throw new Error(o.fout);
    return rss([]);
  };
  const claude = o.claude || (async (sys, prompt, schema, opt) => {
    log.prompts.push({ sys, prompt, schema, opt });
    if (o.hang) await new Promise((r) => setTimeout(r, o.hang));
    const k = o.antwoord && o.antwoord(schema, prompt);
    return k ? { ok: true, data: k, verbruik: { in: 1000, uit: 200, kosten: o.usd != null ? o.usd : 0.05 } } : { ok: false, fout: 'nep' };
  });
  const d = new DatabaseSync(':memory:');
  d.exec("CREATE TABLE IF NOT EXISTS laatst (isin TEXT PRIMARY KEY, ms INTEGER, k REAL, vorige REAL); CREATE TABLE IF NOT EXISTS dagkoers (isin TEXT, dag TEXT, slot REAL, PRIMARY KEY (isin, dag));");
  d.prepare('INSERT INTO laatst (isin, ms, k, vorige) VALUES (?, ?, ?, ?)').run(S.UNIVERSUM.index.isin, 0, 50, 50);
  const logs = [];
  const m = G.maak({ db: () => d, haal, claude, leesFeed: H.leesFeed, nu: ms, log: (x) => logs.push(x), pauzeMs: 0, strateegStand: () => o.stand || 'aan',
    wereldIsin: S.UNIVERSUM.index.isin, tarieven: S.REGELS.tarieven, beurzen: S.REGELS.beurzen });
  return { m, d, log, logs };
}
const STELLING = (x) => Object.assign({ tekst: 'Jensen Huang wordt vóór 31-12 weer CEO van NVIDIA', toets: 'uitgekomen als NVIDIA de benoeming bekendmaakt', soort: 'bestuur',
  bedrijf: { naam: 'NVIDIA', ticker: 'NVDA', isin: NVDA }, thema: 'tech', beslisdatum: '2026-12-31', katalysator: 'besluit van het bestuur', kans: 0.6, ingeprijsd_schatting: 0.3,
  ingeprijsd_reden: 'de markt twijfelt', effect_ja_pct: 20, effect_nee_pct: -5, waarom: 'meerdere bronnen melden gesprekken', bron_ids: ['k1'], zoek_en: ['Jensen Huang CEO'], poly_zoek: ['nvidia ceo'] }, x || {});
const KOPPEN = (ms) => [
  { t: 'Nvidia board in talks to bring back Jensen Huang as CEO', u: 'Reuters', ms }, { t: 'Nvidia board in talks to bring back Jensen Huang as chief', u: 'Bloomberg', ms },
  { t: 'Acme Robotics names new chief financial officer', u: 'CNBC', ms, l: 'a' }, { t: 'Big pharma files appeal in patent ruling case', u: 'AP', ms, l: 'b' },
  { t: 'Chipmaker unveils new AI data center chip line', u: 'FT', ms, l: 'c' }, { t: 'Regulator opens probe into cloud deal', u: 'WSJ', ms, l: 'd' },
  { t: 'Anthropic raises new funding round from Amazon', u: 'Reuters', ms, l: 'e' }, { t: '3 AI stocks to buy now', u: 'Motley Fool', ms, l: 'f' },
];
function antwoordA(extra) {
  return (schema, prompt) => {
    if (schema === G.SCHEMA_A) { const id = (/(k\d+) \| [^\n]*Jensen Huang as CEO/.exec(prompt) || [])[1]; return { stellingen: [STELLING(Object.assign({ bron_ids: [id] }, extra || {}))] }; }
    if (schema === G.SCHEMA_B) return { stellingen: [] };
    if (schema === G.SCHEMA_C) return { koppelingen: [] };
    return null;
  };
}

// ── puur ──
test('hash: canoniek, sleutelvolgorde maakt niet uit, één veld anders = andere hash', () => {
  const a = { b: 1, a: [1, { y: 2, x: null }] }, b = { a: [1, { x: null, y: 2 }], b: 1 };
  assert.strictEqual(I.hashVan(a), I.hashVan(b));
  assert.notStrictEqual(I.hashVan(a), I.hashVan(Object.assign({}, a, { b: 2 })));
  assert.strictEqual(I.hashVan(Object.assign({ hash: 'x' }, a)), I.hashVan(a), 'het veld hash telt niet mee');
});

test('ISIN-controlecijfer, tarief per land, L&S-keuze op ISIN en op naam', () => {
  assert.ok(I.isinOk(NVDA)); assert.ok(!I.isinOk('US67066G1041')); assert.ok(!I.isinOk('nvidia'));
  assert.deepStrictEqual(I.tariefVan('NL0010273215'), { tarief: 'NL', beurs: 'EA' }); assert.strictEqual(I.tariefVan('JP3633400001'), null);
  const t = I.lsTreffers([{ instrumentId: 1, isin: NVDA, displayname: 'NVIDIA CORP. DL-,001', categorySymbol: 'STK' }, { instrumentId: 2, isin: 'DE000A0D6554', displayname: 'NORDEX', categorySymbol: 'STK' }, { instrumentId: 3, isin: 'DE000HB0Z5Q9', displayname: 'NVIDIA Turbo', categorySymbol: 'OS' }]);
  assert.strictEqual(t.length, 2, 'alleen aandelen');
  assert.strictEqual(I.lsKiesIsin(t, NVDA, 'NVIDIA').id, 1);
  assert.strictEqual(I.lsKiesIsin(t, NVDA, 'Nordex'), null, 'naam past niet bij de ISIN');
  assert.strictEqual(I.lsKiesNaam(t, 'Nvidia Corporation').id, 1);
  // wv4015: L&S schrijft "AKZO NOBEL" en "INTL PAPER"; de stellingen noemden "AkzoNobel" en "International Paper" (25-11 en 24-11 onterecht niet te koop)
  const l2 = I.lsTreffers([{ instrumentId: 7, isin: 'NL0013267909', displayname: 'AKZO NOBEL      EO 0,5', categorySymbol: 'STK' }, { instrumentId: 8, isin: 'US4601461035', displayname: 'INTL PAPER DL 1', categorySymbol: 'STK' }]);
  assert.strictEqual(I.lsKiesIsin(l2, 'NL0013267909', 'AkzoNobel').id, 7);
  assert.strictEqual(I.lsKiesIsin(l2, 'US4601461035', 'International Paper').id, 8);
  assert.strictEqual(I.lsKiesIsin(l2, 'US4601461035', 'Graphic Packaging'), null, 'naam past niet bij de ISIN');
  const twee = I.lsTreffers([{ instrumentId: 4, isin: 'DK0062498333', displayname: 'NOVO NORDISK B', categorySymbol: 'STK' }, { instrumentId: 5, isin: 'US6701002056', displayname: 'NOVO NORDISK ADR', categorySymbol: 'STK' }]);
  assert.strictEqual(I.lsKiesNaam(twee, 'Novo Nordisk'), null, 'twee ISINs = niet te kiezen');
  assert.strictEqual(I.lsKiesNaam(twee, 'Novo Nordisk', ['DK0062498333']).id, 4, 'bij meerdere noteringen wint de ene die de Strateeg al kent');
});

test('verifiëren: verzonnen bron, belang, datum, kans', () => {
  const ctx = { vandaag: '2026-11-24', koppen: { k1: { titel: 'x' } }, belangRe: I.woordRe(CFG.belang_vast), concurrentRe: I.woordRe(CFG.belang_concurrent), cfg: CFG };
  assert.ok(I.verifieer(STELLING(), ctx).ok);
  assert.strictEqual(I.verifieer(STELLING({ bron_ids: ['k9'] }), ctx).code, 'bron_weg');
  assert.strictEqual(I.verifieer(STELLING({ bron_ids: ['k1', 'k9'] }), ctx).code, 'bron_weg', 'één verzonnen id is genoeg om te weigeren');
  assert.strictEqual(I.verifieer(STELLING({ waarom: 'omdat Anthropic investeert' }), ctx).code, 'belang');
  assert.strictEqual(I.verifieer(STELLING({ bedrijf: { naam: 'Anthropic', ticker: '', isin: 'US03703U1079' } }), ctx).code, 'belang');
  assert.strictEqual(I.verifieer(STELLING({ beslisdatum: '2026-11-20' }), ctx).code, 'datum');
  assert.strictEqual(I.verifieer(STELLING({ beslisdatum: '2027-06-01' }), ctx).code, 'datum', 'verder dan 120 dagen');
  assert.strictEqual(I.verifieer(STELLING({ kans: 0.99 }), ctx).code, 'kans');
  const v = I.verifieer(STELLING({ effect_ja_pct: 90, tekst: 'OpenAI-deal voor NVIDIA' }), ctx).s;
  assert.strictEqual(v.effect_ja, 0.4, 'effect afgekapt op 40 %'); assert.strictEqual(v.belang_label, 'concurrent');
});

test('koopregels: elke regel net wel / net niet', () => {
  const st = { ls_id: 1, tarief: 'VS', isin: NVDA, thema: 'tech', kans_eigen: 0.5, ingeprijsd: 0.3, ingeprijsd_hoe: 'model', effect_ja: 0.2, effect_nee: -0.05, koersreactie: 0, koers_vast: 100 };
  const leeg = { contant: 1000, posities: [] };
  assert.deepStrictEqual(I.koopToets(st, leeg, 1000, CFG).reden, 'koop'); assert.ok(Math.abs(I.koopToets(st, leeg, 1000, CFG).bedrag - 150) < 1e-9);
  assert.strictEqual(I.koopToets(Object.assign({}, st, { ingeprijsd: 0.31 }), leeg, 1000, CFG).reden, 'voordeel_klein', 'model: lat 0,20');
  assert.strictEqual(I.koopToets(Object.assign({}, st, { ingeprijsd: 0.34, ingeprijsd_hoe: 'polymarket', effect_ja: 0.3 }), leeg, 1000, CFG).reden, 'koop', 'polymarket: lat 0,15');
  assert.strictEqual(I.koopToets(Object.assign({}, st, { kans_eigen: 0.29, ingeprijsd: 0.05 }), leeg, 1000, CFG).reden, 'kans_laag');
  assert.strictEqual(I.koopToets(Object.assign({}, st, { effect_ja: 0.04 }), leeg, 1000, CFG).reden, 'niet_lang');
  assert.strictEqual(I.koopToets(Object.assign({}, st, { effect_ja: 0.1, effect_nee: -0.1 }), leeg, 1000, CFG).reden, 'verwacht_klein', '0,2 × 0,2 = 4 % < 5 %');
  assert.strictEqual(I.koopToets(Object.assign({}, st, { koersreactie: 0.1 }), leeg, 1000, CFG).reden, 'al_gelopen', 'halve effect al gelopen');
  assert.strictEqual(I.koopToets(Object.assign({}, st, { koersreactie: 0.05 }), leeg, 1000, CFG, 105).reden, 'al_gelopen', 'samen met de beweging na het vastleggen');
  assert.strictEqual(I.koopToets(Object.assign({}, st, { ls_id: null }), leeg, 1000, CFG).reden, 'niet_te_koop');
  const zes = { contant: 400, posities: [1, 2, 3, 4, 5, 6].map((i) => ({ isin: 'X' + i, thema: i < 3 ? 'tech' : 'health' })) };
  assert.strictEqual(I.koopToets(st, zes, 1000, CFG).reden, 'boek_vol');
  const drie = { contant: 600, posities: [1, 2, 3].map((i) => ({ isin: 'X' + i, thema: 'tech' })) };
  assert.strictEqual(I.koopToets(st, drie, 1000, CFG).reden, 'thema_vol');
  assert.strictEqual(I.koopToets(st, { contant: 110, posities: [] }, 1000, CFG).reden, 'geen_geld');
});

test('verkoopregels: beslist, voordeel weg, markt ingehaald, noodrem; een daling van 20 % zonder nieuws verkoopt niet', () => {
  const st = { kans_eigen: 0.6, ingeprijsd: 0.3, ingeprijsd_hoe: 'model' }, sp = { kans_eigen: 0.6, ingeprijsd: 0.3, ingeprijsd_hoe: 'polymarket' };
  const s = (x) => Object.assign({ status: 'open', kans_nu: 0.6, ingeprijsd_nu: null, koop_midden: 100 }, x);
  assert.strictEqual(I.verkoopReden(st, s({ status: 'uitgekomen' }), 100, 0, CFG), 'uitgekomen');
  assert.strictEqual(I.verkoopReden(st, s({ status: 'weerlegd' }), 100, 0, CFG), 'weerlegd');
  assert.strictEqual(I.verkoopReden(st, s({ status: 'vervallen' }), 100, 0, CFG), 'vervallen');
  assert.strictEqual(I.verkoopReden(st, s({}), 80, 5, CFG), null, '−20 % zonder nieuws: blijven');
  assert.strictEqual(I.verkoopReden(st, s({}), 75, 5, CFG), 'noodrem');
  assert.strictEqual(I.verkoopReden(st, s({ kans_nu: 0.3 }), 100, 1, CFG), 'voordeel_weg');
  assert.strictEqual(I.verkoopReden(st, s({ kans_nu: 0.3 }), 100, 0, CFG), null, 'pas na één beursdag');
  assert.strictEqual(I.verkoopReden(sp, s({ ingeprijsd_nu: 0.56 }), 100, 1, CFG), 'markt_ingehaald');
  assert.strictEqual(I.verkoopReden(sp, s({ ingeprijsd_nu: 0.5 }), 100, 1, CFG), null);
});

test('Polymarket: gesloten, dun, te vroeg aflopend of zonder Ja/Nee is geen kandidaat; prijs = midden', () => {
  const m = (x) => Object.assign({ id: '1', question: 'Will X?', outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', bestBid: 0.39, bestAsk: 0.41, liquidityNum: 5000, volumeNum: 1000, endDate: '2026-12-31T12:00:00Z', closed: false, active: true }, x);
  const k = I.polyKandidaten([m(), m({ id: '2', closed: true }), m({ id: '3', liquidityNum: 10, volumeNum: 10 }), m({ id: '4', endDate: '2026-12-01T00:00:00Z' }), m({ id: '5', outcomes: '["A","B"]' }), m({ id: '6', liquidityNum: 0, volumeNum: 50000 })], '2026-12-31', CFG.poly);
  assert.deepStrictEqual(k.map((x) => x.id).sort(), ['1', '6']);
  assert.ok(Math.abs(k.find((x) => x.id === '1').prijs - 0.4) < 1e-9);
  assert.deepStrictEqual(I.polyStand(JSON.stringify(m({ closed: true, outcomePrices: '["1","0"]' }))).slot, 1);
});

test('scores: Brier op een handvoorbeeld, bakjes en de drie zinnen', () => {
  const r = [{ kans_eigen: 0.8, ingeprijsd: 0.5, ingeprijsd_hoe: 'polymarket', uitkomst: 1 }, { kans_eigen: 0.6, ingeprijsd: 0.5, ingeprijsd_hoe: 'model', uitkomst: 0 },
    { kans_eigen: 0.4, ingeprijsd: 0.2, ingeprijsd_hoe: 'model', uitkomst: 0 }, { kans_eigen: 0.9, ingeprijsd: 0.7, ingeprijsd_hoe: 'polymarket', uitkomst: 1 }, { kans_eigen: 0.5, ingeprijsd: 0.4, uitkomst: null }];
  const s = I.scores(r, CFG);
  assert.strictEqual(s.beslist, 4); assert.strictEqual(s.vastgelegd, 5);
  assert.ok(Math.abs(s.alle.brier_eigen - (0.04 + 0.36 + 0.16 + 0.01) / 4) < 1e-12);
  assert.ok(Math.abs(s.polymarket.brier_markt - (0.25 + 0.09) / 2) < 1e-12);
  assert.strictEqual(s.bakjes[4].n, 2); assert.strictEqual(s.bakjes[4].werkelijk, 1);
  assert.match(s.zin, /^Te weinig/);
  const veel = (n, poly) => Array.from({ length: n }, (_, i) => ({ kans_eigen: 0.5, ingeprijsd: 0.5, ingeprijsd_hoe: i < poly ? 'polymarket' : 'model', uitkomst: i % 2 }));
  assert.match(I.scores(veel(40, 5), CFG).zin, /^Een aanwijzing/); assert.match(I.scores(veel(120, 50), CFG).zin, /^Genoeg/);
});

// ── module ──
test('denkronde: koppen zonder belang en reclame naar het model, stelling vastgelegd en onveranderlijk, wacht op koop; tabellen van de Strateeg ongemoeid', async () => {
  const klok = { t: nlMs('2026-11-24', '07:46') };
  const w = wereld({ klok, items: KOPPEN(klok.t - 3600000), antwoord: antwoordA() });
  await w.m._denk.ronde('vast');
  const pA = w.log.prompts.find((p) => p.schema === G.SCHEMA_A);
  assert.ok(pA, 'aanroep A gedaan'); assert.ok(!/Anthropic/i.test(pA.prompt), 'belangkop bereikt het model niet'); assert.ok(!/stocks to buy/i.test(pA.prompt), 'reclame weg');
  assert.match(pA.prompt, /2 melders/, 'twee uitgevers = één feit met twee melders');
  const st = w.d.prepare('SELECT * FROM idee_stelling').all();
  assert.strictEqual(st.length, 1); assert.strictEqual(st[0].ls_id, 43763); assert.strictEqual(st[0].ingeprijsd_hoe, 'model');
  assert.strictEqual(JSON.parse(st[0].bronnen)[0].link.startsWith('https://news.example.com/'), true, 'bron komt uit de opgehaalde koppen');
  assert.throws(() => w.d.prepare('UPDATE idee_stelling SET kans_eigen = 0.9').run(), /vast/);
  assert.throws(() => w.d.prepare('DELETE FROM idee_stelling').run(), /vast/);
  const rij = Object.assign({}, st[0]); delete rij.id; assert.strictEqual(I.hashVan(rij), st[0].hash, 'hash klopt met de velden');
  assert.strictEqual(w.d.prepare('SELECT positie FROM idee_stand').get().positie, 'wacht_koop');
  assert.deepStrictEqual(w.d.prepare('SELECT COUNT(*) AS n FROM dagkoers').get().n, 0); assert.strictEqual(w.d.prepare('SELECT k FROM laatst').get().k, 50, 'laatst van de Strateeg ongewijzigd');
  assert.ok(w.logs.some((x) => x.stap === 'idee-vast' && /^[0-9a-f]{16}$/.test(x.hash)) && !JSON.stringify(w.logs).includes('Huang'), 'log zonder inhoud');
});

test('verzonnen bron en verzonnen bedrijf: geweigerd resp. gevolgd zonder koop', async () => {
  const klok = { t: nlMs('2026-11-24', '07:46') };
  const w = wereld({ klok, items: KOPPEN(klok.t), antwoord: (schema, prompt) => schema === G.SCHEMA_A ? { stellingen: [STELLING({ bron_ids: ['k99'] }), STELLING({ bron_ids: ['k1'], bedrijf: { naam: 'Zyxwv Holdings', ticker: '', isin: '' }, tekst: 'Zyxwv wordt overgenomen' })] } : (schema === G.SCHEMA_B ? { stellingen: [] } : null) });
  await w.m._denk.ronde('vast');
  assert.strictEqual(w.d.prepare("SELECT reden_code FROM idee_afgewezen").get().reden_code, 'bron_weg');
  const s = w.d.prepare('SELECT s.ls_id, t.positie, t.niet_gekocht_reden FROM idee_stelling s JOIN idee_stand t ON t.stelling_id = s.id').all();
  assert.strictEqual(s.length, 1); assert.strictEqual(s[0].ls_id, null); assert.strictEqual(s[0].positie, 'geen'); assert.strictEqual(s[0].niet_gekocht_reden, 'niet_te_koop');
});

test('Davids idee: geschoond naar het model, letterlijk bewaard; over Anthropic = belang zonder aanroep', async () => {
  const klok = { t: nlMs('2026-11-24', '22:30') };
  const w = wereld({ klok, items: KOPPEN(klok.t - 3600000), antwoord: (schema, prompt) => {
    if (schema === G.SCHEMA_D1) return { begrijpelijk: true, gebeurtenis: 'CEO', bedrijven: [{ naam: 'NVIDIA', ticker: 'NVDA', isin: NVDA }], zoek_en: ['Jensen Huang CEO'], poly_zoek: ['nvidia ceo'] };
    if (schema === G.SCHEMA_D2) { const id = (/(k\d+) \| [^\n]*Jensen Huang as CEO/.exec(prompt) || [])[1]; return { stellingen: [STELLING({ bron_ids: [id], markt: 'geen', kant: 'ja' })], geen_stelling_reden: '' }; }
    return null; } });
  const tekst = 'ik denk dat Huang terugkomt, ik zet er € 5.000 op, IBAN NL91ABNA0417164300, bel 06-12345678';
  const r = w.m.idee({ tekst });
  assert.strictEqual(r.status, 200);
  for (let i = 0; i < 50 && w.m._denk.bezig(); i++) await new Promise((x) => setTimeout(x, 10));
  await new Promise((x) => setTimeout(x, 20));
  for (let i = 0; i < 50 && w.m._denk.bezig(); i++) await new Promise((x) => setTimeout(x, 10));
  const inv = w.d.prepare('SELECT * FROM idee_invoer').get();
  assert.strictEqual(inv.tekst, tekst, 'letterlijk bewaard'); assert.strictEqual(inv.status, 'stelling');
  const alle = w.log.prompts.map((p) => p.prompt).join('\n');
  assert.ok(!/5\.000|NL91|12345678/.test(alle), 'bedrag, IBAN en telefoon niet in de prompt');
  assert.strictEqual(w.d.prepare('SELECT bron FROM idee_stelling').get().bron, 'david');
  // belang
  const n0 = w.log.prompts.length;
  w.m.idee({ tekst: 'ik denk dat Anthropic naar de beurs gaat' });
  for (let i = 0; i < 50; i++) { await new Promise((x) => setTimeout(x, 5)); if (!w.m._denk.bezig() && w.d.prepare("SELECT status FROM idee_invoer ORDER BY id DESC").get().status !== 'wacht') break; }
  const laatste = w.d.prepare('SELECT status, antwoord_zin FROM idee_invoer ORDER BY id DESC').get();
  assert.strictEqual(laatste.status, 'belang'); assert.match(laatste.antwoord_zin, /Anthropic/); assert.strictEqual(w.log.prompts.length, n0, 'geen aanroep');
  assert.strictEqual(w.m.idee({ tekst: 'x' }).status, 400);
});

test('harde grens: vaste rondes stoppen bij 18 per dag, David tot 24; dollargrens; mislukte aanroep telt', async () => {
  const klok = { t: nlMs('2026-11-24', '07:46') };
  const w = wereld({ klok, items: KOPPEN(klok.t), antwoord: () => null });
  w.m.info();   // schema aanmaken
  const zet = (n, usd) => { const st = w.d.prepare("INSERT INTO idee_aanroep (ms, dag, maand, soort, ok, usd) VALUES (?, '2026-11-24', '2026-11', 'A', 0, ?)"); for (let i = 0; i < n; i++) st.run(klok.t, usd || 0); };
  zet(18);
  await w.m._denk.ronde('vast');
  assert.strictEqual(w.log.prompts.length, 0, 'ronde zonder aanroep'); assert.strictEqual(w.d.prepare('SELECT status FROM idee_ronde ORDER BY id DESC').get().status, 'grens');
  w.m.idee({ tekst: 'ik denk dat NVIDIA een overname doet' });
  for (let i = 0; i < 100; i++) { await new Promise((x) => setTimeout(x, 5)); if (!w.m._denk.bezig() && w.d.prepare("SELECT status FROM idee_invoer").get().status !== 'wacht') break; }
  assert.strictEqual(w.log.prompts.length, 1, 'David mag nog'); assert.strictEqual(w.d.prepare("SELECT status FROM idee_invoer").get().status, 'fout', 'nep-model faalt = fout, geen herhaallus');
  assert.strictEqual(w.d.prepare('SELECT COUNT(*) AS n FROM idee_aanroep').get().n, 19, 'mislukte aanroep telt mee');
  zet(5);
  w.m.idee({ tekst: 'nog een idee over NVIDIA' });
  for (let i = 0; i < 100; i++) { await new Promise((x) => setTimeout(x, 5)); if (!w.m._denk.bezig() && w.d.prepare("SELECT status FROM idee_invoer ORDER BY id DESC").get().status !== 'wacht') break; }
  assert.strictEqual(w.log.prompts.length, 1, '24 bereikt: ook David niet meer'); assert.match(w.d.prepare('SELECT antwoord_zin FROM idee_invoer ORDER BY id DESC').get().antwoord_zin, /denkgrens/);
  const w2 = wereld({ klok, items: KOPPEN(klok.t), antwoord: () => null });
  w2.m.info();
  w2.d.prepare("INSERT INTO idee_aanroep (ms, dag, maand, soort, ok, usd) VALUES (?, '2026-11-02', '2026-11', 'A', 1, 25)").run(klok.t);
  await w2.m._denk.ronde('vast');
  assert.strictEqual(w2.log.prompts.length, 0, 'maandgrens in dollars');
});

test('tik blokkeert niet op het model en voert uit met verse koers: kosten zoals de Strateeg, wereldkoers erbij, contant nooit negatief', async () => {
  const klok = { t: nlMs('2026-11-24', '07:45') };
  const w = wereld({ klok, items: KOPPEN(klok.t), antwoord: antwoordA(), hang: 300 });
  const t0 = Date.now(); const u = await w.m.tik({ gedaan: 'niets' }, { gedaan: 'niets' });
  assert.ok(Date.now() - t0 < 100, 'tik keert meteen terug'); assert.ok(w.m._denk.bezig(), 'denkronde loopt los');
  assert.strictEqual(w.m._denk.startDenk(klok.t), false, 'geen tweede denkronde tegelijk');
  void u;
  for (let i = 0; i < 200 && w.m._denk.bezig(); i++) await new Promise((x) => setTimeout(x, 10));
  assert.strictEqual(w.d.prepare('SELECT positie FROM idee_stand').get().positie, 'wacht_koop');
  // 15:50: New York 20 minuten open; Strateeg deed iets → wachten
  klok.t = nlMs('2026-11-24', '15:50');
  assert.strictEqual((await w.m.tik({ gedaan: 'kwartier' }, null)).gedaan, 'wacht_strateeg');
  assert.strictEqual((await w.m.tik({ gedaan: 'niets' }, { gedaan: 'herziening' })).gedaan, 'wacht_segment');
  klok.t = nlMs('2026-11-24', '15:35');   // binnen 15 min na de opening: niet
  const n0 = w.d.prepare("SELECT COUNT(*) AS n FROM opdracht WHERE boek = 'ideeen'").get().n;
  await w.m.tik({ gedaan: 'niets' }, { gedaan: 'niets' });
  assert.strictEqual(w.d.prepare("SELECT COUNT(*) AS n FROM opdracht WHERE boek = 'ideeen'").get().n, n0);
  klok.t = nlMs('2026-11-24', '15:50');
  await w.m.tik({ gedaan: 'niets' }, { gedaan: 'niets' });
  const od = w.d.prepare("SELECT * FROM opdracht WHERE boek = 'ideeen'").get();
  assert.ok(od, 'gekocht'); assert.strictEqual(od.kant, 'koop');
  const k = JSON.parse(od.kosten_uit); assert.ok(Math.abs(k.totaal - (2 + 0.0025 * od.aantal * od.prijs)) < 1e-9, 'VS-tarief van de Strateeg');
  const b = w.d.prepare("SELECT contant FROM boek WHERE id = 'ideeen'").get(); assert.ok(b.contant > 0 && b.contant < 1000);
  const st = w.d.prepare('SELECT * FROM idee_stand').get(); assert.strictEqual(st.positie, 'in'); assert.strictEqual(st.wereld_bij_koop, 50);
  assert.match(od.reden_zin, /eigen kans 60 %/);
  // koers −20 % zonder nieuws: blijft; stelling uitgekomen → verkopen
  w.d.prepare("UPDATE idee_koers SET k = 80").run();
  w.m._denk.herbeoordeel(); assert.strictEqual(w.d.prepare('SELECT positie FROM idee_stand').get().positie, 'in');
  w.d.prepare("UPDATE idee_stand SET status = 'uitgekomen', uitkomst = 1").run();
  w.m._denk.herbeoordeel(); assert.strictEqual(w.d.prepare('SELECT positie FROM idee_stand').get().positie, 'wacht_verkoop');
  klok.t = nlMs('2026-11-24', '16:05');
  await w.m.tik({ gedaan: 'niets' }, { gedaan: 'niets' });
  const st2 = w.d.prepare('SELECT * FROM idee_stand').get(); assert.strictEqual(st2.positie, 'uit'); assert.strictEqual(st2.verkoop_reden, 'uitgekomen');
  assert.strictEqual(w.d.prepare("SELECT COUNT(*) AS n FROM positie WHERE boek = 'ideeen'").get().n, 0);
  const o = w.m.overzicht();
  assert.strictEqual(o.stellingen[0].status, 'uitgekomen'); assert.ok(typeof o.stellingen[0].rendement === 'number'); assert.strictEqual(o.scores.beslist, 1);
  assert.match(o.eerlijk_zin, /niet op het verleden/);
});

test('toetsen: gesloten Polymarket-markt beslist zonder model; één zachte bron houdt open; termijn voorbij = vervallen', async () => {
  const klok = { t: nlMs('2026-11-24', '07:46') };
  const poly = [{ slug: 'nv', markets: [{ id: '77', question: 'Will Jensen Huang return as NVIDIA CEO by Dec 31?', outcomes: '["Yes","No"]', outcomePrices: '["0.3","0.7"]', bestBid: 0.29, bestAsk: 0.31, liquidityNum: 50000, volumeNum: 90000, endDate: '2026-12-31T12:00:00Z', closed: false }] }];
  const w = wereld({ klok, items: KOPPEN(klok.t), poly, polyStand: { id: '77', outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', closed: true },
    antwoord: (schema, prompt) => { if (schema === G.SCHEMA_C) return { koppelingen: [{ voorstel: 'v1', markt: '77', kant: 'ja' }] }; return antwoordA()(schema, prompt); } });
  await w.m._denk.ronde('vast');
  const s = w.d.prepare('SELECT * FROM idee_stelling').get();
  assert.strictEqual(s.ingeprijsd_hoe, 'polymarket'); assert.ok(Math.abs(s.ingeprijsd - 0.3) < 1e-9, 'de pod leest de prijs, niet het model');
  assert.strictEqual(w.d.prepare('SELECT status FROM idee_stand').get().status, 'open', 'niet in dezelfde ronde getoetst');
  const nB = w.log.prompts.filter((p) => p.schema === G.SCHEMA_B).length;
  klok.t = nlMs('2026-11-24', '12:46');
  await w.m._denk.ronde('vast');   // volgende ronde: de markt is (in de nep-wereld) gesloten op Ja
  assert.strictEqual(w.log.prompts.filter((p) => p.schema === G.SCHEMA_B).length, nB, 'Polymarket beslist zonder aanroep B');
  assert.strictEqual(w.d.prepare('SELECT status, uitkomst_hoe FROM idee_stand').get().status, 'uitgekomen');
  klok.t = nlMs('2026-11-24', '07:46');
  // zonder geldig bewijs: model zegt uitgekomen, maar de kop-id staat niet in het blok van deze stelling → blijft open, oordeel wel vastgelegd
  const w2 = wereld({ klok, items: KOPPEN(klok.t), antwoord: (schema, prompt) => {
    if (schema === G.SCHEMA_B) return { stellingen: [{ id: 's1', oordeel: 'uitgekomen', kans_nu: 0.9, bron_ids: ['k99'], zin: 'gemeld' }] };
    return antwoordA({ beslisdatum: '2026-11-25' })(schema, prompt); } });
  await w2.m._denk.ronde('vast');
  klok.t = nlMs('2026-11-24', '12:46');
  await w2.m._denk.ronde('vast');
  assert.ok(w2.log.prompts.some((p) => p.schema === G.SCHEMA_B), 'beslisdatum binnen twee dagen: B wordt gevraagd');
  assert.strictEqual(w2.d.prepare('SELECT status FROM idee_stand').get().status, 'open');
  assert.strictEqual(w2.d.prepare('SELECT oordeel, kans FROM idee_herzien').get().oordeel, 'uitgekomen');
  assert.strictEqual(w2.d.prepare('SELECT kans_nu FROM idee_stand').get().kans_nu, 0.9);
  assert.ok(/s1 \|[^\n]*\| vorige kans 0\.\d+\n/.test(w2.log.prompts.filter((p) => p.schema === G.SCHEMA_B).pop().prompt), 'wv4015: B ziet zijn vorige kans');
  // wv4015: een ronde die bij een herstart op 'bezig' bleef staan wordt bij de volgende ronde afgesloten
  w2.d.prepare("INSERT INTO idee_ronde (ms, dag, soort, status) VALUES (?, '2026-11-24', 'extra', 'bezig')").run(klok.t - 3600000);
  await w2.m._denk.ronde('vast');
  assert.strictEqual(w2.d.prepare("SELECT COUNT(*) AS n FROM idee_ronde WHERE status = 'bezig'").get().n, 0);
  assert.strictEqual(w2.d.prepare("SELECT reden FROM idee_ronde WHERE status = 'afgebroken'").get().reden, 'herstart');
  assert.strictEqual(I.bewijsGenoeg([{ hard: 0, uitgever: 'Blog', melders: 1 }]), false);
  assert.strictEqual(I.bewijsGenoeg([{ hard: 0, uitgever: 'A', melders: 1 }, { hard: 0, uitgever: 'B', melders: 1 }]), true);
  assert.strictEqual(I.bewijsGenoeg([{ hard: 1, uitgever: 'SEC', melders: 1 }]), true);
  // termijn
  klok.t = nlMs('2026-11-24', '07:46');
  const w3 = wereld({ klok, items: KOPPEN(klok.t), antwoord: (schema, prompt) => schema === G.SCHEMA_B ? { stellingen: [{ id: 's1', oordeel: 'open', kans_nu: 0.5, bron_ids: [], zin: 'nog niets' }] } : antwoordA({ beslisdatum: '2026-11-26' })(schema, prompt) });
  await w3.m._denk.ronde('vast');
  klok.t = nlMs('2026-11-28', '10:05');
  await w3.m._denk.ronde('vast');   // na de termijn: laatste toetsronde
  klok.t = nlMs('2026-11-29', '10:05');
  await w3.m._denk.ronde('vast');
  assert.strictEqual(w3.d.prepare('SELECT status FROM idee_stand ORDER BY stelling_id LIMIT 1').get().status, 'vervallen');
});

test('Codex-review: bewijs alleen uit het eigen blok, toetsing ziet koppen die al naar A gingen, stand na de koers opnieuw gelezen, verzoek begrensd, aanroep vooraf geteld', async () => {
  const klok = { t: nlMs('2026-11-24', '07:46') };
  let tijdensAanroep = null;
  const w = wereld({ klok, items: KOPPEN(klok.t), antwoord: (schema, prompt) => {
    if (schema === G.SCHEMA_A) {
      tijdensAanroep = w.d.prepare("SELECT COUNT(*) AS n FROM idee_aanroep WHERE fout = 'loopt'").get().n;
      const id = (/(k\d+) \| [^\n]*Jensen Huang as CEO/.exec(prompt) || [])[1], id2 = (/(k\d+) \| [^\n]*Regulator/.exec(prompt) || [])[1];
      return { stellingen: [STELLING({ bron_ids: [id] }), STELLING({ tekst: 'Toezichthouder blokkeert de clouddeal vóór 15 maart', bedrijf: { naam: 'NVIDIA', ticker: 'NVDA', isin: NVDA }, bron_ids: [id2], beslisdatum: '2026-11-25' })] };
    }
    if (schema === G.SCHEMA_B) { const blok2 = /s2 \|[\s\S]*/.exec(prompt)[0]; const vreemd = (/(k\d+) \|/.exec(prompt.slice(0, prompt.indexOf('s2 |'))) || [])[1]; return { stellingen: [{ id: 's2', oordeel: 'uitgekomen', kans_nu: 0.9, bron_ids: vreemd ? [vreemd] : [], zin: 'x' }].concat(blok2 ? [] : []) }; }
    return antwoordA()(schema, prompt); } });
  await w.m._denk.ronde('vast');
  assert.strictEqual(tijdensAanroep, 1, 'aanroep telt al mee terwijl hij loopt');
  assert.ok(w.log.prompts.every((p) => p.opt && p.opt.maxUsd === CFG.grens.usd_aanroep_max), 'kostenplafond per aanroep meegegeven');
  assert.strictEqual(w.d.prepare("SELECT COUNT(*) AS n FROM idee_aanroep WHERE fout = 'loopt'").get().n, 0);
  // Codex-MOET 3: dezelfde koppen gingen al naar A, maar zijn voor de toetsing van stelling 1 en 2 nog nieuw
  klok.t = nlMs('2026-11-24', '12:46');
  await w.m._denk.ronde('vast');
  const pB = w.log.prompts.filter((p) => p.schema === G.SCHEMA_B).pop();
  assert.ok(pB && /s1 \|[\s\S]*k\d+ \|/.test(pB.prompt), 'stelling 1 krijgt de koppen die eerder naar A gingen');
  // Codex-MOET 4: stelling 2 'uitgekomen' met een kop-id uit het blok van stelling 1 → blijft open
  assert.strictEqual(w.d.prepare('SELECT status FROM idee_stand WHERE stelling_id = 2').get().status, 'open');
  // Codex-MOET 2: tijdens het ophalen van de koers wordt de koopopdracht ingetrokken → geen order
  w.d.prepare("UPDATE idee_stand SET positie = 'wacht_koop', actie_ms = ?, status = 'open' WHERE stelling_id = 1").run(klok.t);
  klok.t = nlMs('2026-11-24', '15:50');
  const w2 = w;   // zelfde databank; nep-haal die tijdens het koersverzoek de stand wijzigt
  const oudHaal = w2.log.urls.push.bind(w2.log.urls);
  w2.log.urls.push = (u) => { if (u.includes('series=intraday')) w2.d.prepare("UPDATE idee_stand SET positie = 'geen', niet_gekocht_reden = 'beslist' WHERE stelling_id = 1").run(); return oudHaal(u); };
  await w2.m.tik({ gedaan: 'niets' }, { gedaan: 'niets' });
  assert.strictEqual(w2.d.prepare("SELECT COUNT(*) AS n FROM opdracht WHERE boek = 'ideeen'").get().n, 0, 'ingetrokken opdracht niet uitgevoerd');
});

test('Codex-review: een hangend koersverzoek houdt de tik niet langer op dan de beurtgrens', async () => {
  const klok = { t: nlMs('2026-11-24', '15:50') };
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE laatst (isin TEXT PRIMARY KEY, ms INTEGER, k REAL, vorige REAL)');
  const m = G.maak({ db: () => d, haal: () => new Promise(() => {}), claude: async () => ({ ok: false }), leesFeed: H.leesFeed, nu: () => klok.t, pauzeMs: 0, beurtMaxMs: 300,
    strateegStand: () => 'aan', wereldIsin: S.UNIVERSUM.index.isin, tarieven: S.REGELS.tarieven, beurzen: S.REGELS.beurzen });
  m.info();
  const rij = { vastgelegd_ms: klok.t, dag: '2026-11-24', bron: 'nieuws', tekst: 't', toets: 't', soort: 'bestuur', bedrijf: 'NVIDIA', isin: NVDA, ls_id: 43763, tarief: 'VS', beurs: 'VS', thema: 'tech', beslisdatum: '2026-12-31',
    kans_eigen: 0.6, effect_ja: 0.2, effect_nee: -0.05, ingeprijsd: 0.3, ingeprijsd_hoe: 'model', bronnen: '[]', zoek: '[]', hash: 'x' };
  const kol = Object.keys(rij);
  d.prepare('INSERT INTO idee_stelling (' + kol.join(',') + ') VALUES (' + kol.map(() => '?').join(',') + ')').run(...kol.map((k) => rij[k]));
  d.prepare("INSERT INTO idee_stand (stelling_id, status, positie, actie_ms, kosten) VALUES (1, 'open', 'wacht_koop', ?, 0)").run(klok.t);
  const t0 = Date.now(); await m.tik({ gedaan: 'niets' }, { gedaan: 'niets' });
  assert.ok(Date.now() - t0 < 1500, 'tik klaar binnen de grens: ' + (Date.now() - t0) + ' ms');
});

test('Codex r2: dollargrens rekent het maximum van de volgende aanroep mee; zonder oordeel geen laatste toetskans verbruikt', async () => {
  const klok = { t: nlMs('2026-11-24', '07:46') };
  const w = wereld({ klok, items: KOPPEN(klok.t), antwoord: () => null });
  w.m.info();
  w.d.prepare("INSERT INTO idee_aanroep (ms, dag, maand, soort, ok, usd) VALUES (?, '2026-11-24', '2026-11', 'A', 1, ?)").run(klok.t, CFG.grens.usd_dag - CFG.grens.usd_aanroep_max + 0.01);
  await w.m._denk.ronde('vast');
  assert.strictEqual(w.log.prompts.length, 0, 'net onder de daggrens maar met het maximum erbij erover: geen aanroep');
  // B antwoordt niets voor een stelling na de termijn → na_termijn blijft 0, koppen niet als gezien gemarkeerd
  const w2 = wereld({ klok, items: KOPPEN(klok.t), antwoord: (schema, prompt) => schema === G.SCHEMA_B ? { stellingen: [] } : antwoordA({ beslisdatum: '2026-11-26' })(schema, prompt) });
  await w2.m._denk.ronde('vast');
  klok.t = nlMs('2026-11-28', '10:05');
  await w2.m._denk.ronde('vast');
  assert.strictEqual(w2.d.prepare('SELECT na_termijn FROM idee_stand WHERE stelling_id = 1').get().na_termijn, 0);
  assert.strictEqual(w2.d.prepare('SELECT COUNT(*) AS n FROM idee_kop_gezien').get().n, 0);
  klok.t = nlMs('2026-11-29', '10:05');
  await w2.m._denk.ronde('vast');
  assert.strictEqual(w2.d.prepare('SELECT status FROM idee_stand WHERE stelling_id = 1').get().status, 'open', 'niet vervallen zonder dat er een toetsronde met oordeel was');
  klok.t = nlMs('2026-12-04', '10:05');
  await w2.m._denk.ronde('vast');
  assert.strictEqual(w2.d.prepare('SELECT status FROM idee_stand WHERE stelling_id = 1').get().status, 'vervallen', 'een week na de termijn vervalt hij toch');
});
