'use strict';
// wv2993: OVIS Beleggen fase 2 (weekbericht) — beleggen-nieuws.js op opgenomen en VERZONNEN antwoorden, zonder netwerk en zonder taalmodel.
// Fixtures: test/fixtures/beleggen-nieuws/ (ingekorte openbare opnames van 13-11-2026: SEC-indieningen, Google Nieuws-koppen met naamgenoten
// van "Vertex", EMA-feed); de rest staat hieronder verzonnen. Bedrijven "Voorbeeld …" zijn verzonnen; geen stand of reden van David.
// Elk punt uit ontwerp § 6 heeft een toets; test/beleggen-nieuws.sh breekt elke regel één voor één (kruisproef: regel weg → rood).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const N = require(process.env.BN_JS || '../beleggen-nieuws.js');
const B = require(process.env.BL_JS || '../beleggen.js');
const H = require('../harvester.js');
const FX = path.join(__dirname, 'fixtures', 'beleggen-nieuws');
const fx = (n) => fs.readFileSync(path.join(FX, n), 'utf8');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function rss(items) {
  return '<?xml version="1.0"?><rss version="2.0"><channel><title>proef</title>' + items.map((i, n) => '<item><title>' + esc(i.t) + '</title><link>https://voorbeeld.invalid/' + (i.l || n) +
    '</link><pubDate>' + new Date(i.d + 'T10:00:00Z').toUTCString() + '</pubDate><description>' + esc(i.x || '') + '</description></item>').join('') + '</channel></rss>';
}
const LEEG = rss([]);
function secJson(naam, rijen) {
  const r = { accessionNumber: [], filingDate: [], reportDate: [], form: [], items: [], primaryDocument: [], primaryDocDescription: [] };
  rijen.forEach((x, i) => { r.accessionNumber.push('0000000000-26-00000' + i); r.filingDate.push(x[1]); r.reportDate.push(''); r.form.push(x[0]); r.items.push(x[2] || ''); r.primaryDocument.push('doc' + i + '.htm'); r.primaryDocDescription.push(''); });
  return JSON.stringify({ name: naam, filings: { recent: r } });
}
// verzonnen koppen over Voorbeeld Chips: drie keer hetzelfde feit (R2), aanprijzing (R1), Claude-kop (belang, ZOU 1), zeven losse koppen (R4)
const CHIPS_KOPPEN = [
  { t: 'Voorbeeld Chips opent nieuwe fabriek in Arizona - Nieuwsblad Een', d: '2026-11-12' },
  { t: 'Voorbeeld Chips opent nieuwe fabriek in Arizona voor chips - Nieuwsblad Twee', d: '2026-11-12' },
  { t: 'Nieuwe fabriek in Arizona: Voorbeeld Chips opent - Nieuwsblad Drie', d: '2026-11-12' },
  { t: '3 AI stocks to buy now, including Voorbeeld Chips - The Motley Fool', d: '2026-11-12' },
  { t: 'Voorbeeld Chips levert rekenkracht voor Claude-modellen - Techblad', d: '2026-11-12' },
  { t: 'Voorbeeld Chips wint rechtszaak over patent - Krant A', d: '2026-11-11' },
  { t: 'Topman Voorbeeld Chips spreekt op conferentie - Krant B', d: '2026-11-11' },
  { t: 'Voorbeeld Chips sluit samenwerking met autobouwer - Krant C', d: '2026-11-11' },
  { t: 'Vakbond kritisch over werkdruk bij Voorbeeld Chips - Krant D', d: '2026-11-12' },
  { t: 'Voorbeeld Chips breidt kantoor in Eindhoven uit - Krant E', d: '2026-11-12' },
  { t: 'Analisten letten op voorraad bij Voorbeeld Chips - Krant F', d: '2026-11-13' },
  { t: 'Voorbeeld Chips test koeling met zeewater - Krant G', d: '2026-11-13' },
];
const CT = JSON.stringify({ studies: [
  { protocolSection: { identificationModule: { nctId: 'NCT90000001', briefTitle: 'Voorbeeldmab bij ziekte A' }, statusModule: { overallStatus: 'RECRUITING', studyFirstPostDateStruct: { date: '2026-11-10' } },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Voorbeeld Pharma' } }, designModule: { phases: ['PHASE3'] } } },
  { protocolSection: { identificationModule: { nctId: 'NCT90000002', briefTitle: 'Voorbeeldmab bij ziekte B' }, statusModule: { overallStatus: 'RECRUITING', studyFirstPostDateStruct: { date: '2026-11-10' } },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Voorbeeld Pharma' } }, designModule: { phases: ['PHASE2'] } } },
  { protocolSection: { identificationModule: { nctId: 'NCT90000003', briefTitle: 'Studie van een ander' }, statusModule: { overallStatus: 'RECRUITING', studyFirstPostDateStruct: { date: '2026-11-10' } },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Andere Universiteit' } } } },
] });
const FDA = rss([{ t: 'FDA approves Voorbeeldmab for ziekte A', d: '2026-11-12', x: 'The agency approved the drug.' }, { t: 'FDA roundup', d: '2026-11-12' }]);
const AFM = rss([{ t: 'AFM legt boete op aan Voorbeeld Chips', d: '2026-11-11' }]);
const NOS = rss([{ t: 'Beurs: Voorbeeld Pharma en anderen in de lift', d: '2026-11-12' }]);

const REDEN = 'Ik kocht voor € 1.250 (12,5 % van mijn geld) via NL91ABNA0417164300; vragen: jan@voorbeeld.invalid of 06-12345678. Net als Anthropic een laag onder AI.';

function wereld(o) {
  o = o || {};
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-nieuws-'));
  const w = { log: [], box: [], berichten: [], prompts: [], gehaald: [], klok: { datum: '2026-11-13', uur: 6, min: 40 }, kapot: new Set(o.kapot || []), vandaag: '2026-11-13' };
  w.m = B.maak({ dbPad: path.join(map, 'beleggen.sqlite'), vaultSchrijf: () => {}, vandaag: () => w.vandaag });
  const P = (pad, body) => { const u = w.m.app({ methode: 'POST', pad: '/app/beleggen/' + pad, body }); assert.strictEqual(u.status, 200, pad + ': ' + JSON.stringify(u.body)); return u.body; };
  w.P = P;
  w.haalExtra = o.haal || {};
  w.antwoord = o.antwoord || standaardAntwoord;
  w.n = N.maak({ beleggen: w.m, leesFeed: H.leesFeed, pauze: async () => {}, nuIso: () => w.vandaag + 'T09:00:00.000Z',
    haal: async (url) => {
      w.gehaald.push(url);
      const h = new URL(url).hostname;
      for (const k of w.kapot) if (h.includes(k)) throw new Error('http 503');
      for (const [k, v] of Object.entries(w.haalExtra)) if (url.includes(k)) return typeof v === 'function' ? v(url) : v;
      if (h === 'data.sec.gov') return /CIK0001045810/.test(url) ? fx('sec-chips.json') : /CIK0002130357/.test(url) ? secJson('Voorbeeld AI', [['S-1/A', '2026-11-10']]) : secJson('x', []);
      if (h === 'clinicaltrials.gov') return CT;
      if (h === 'eutils.ncbi.nlm.nih.gov') return JSON.stringify({ esearchresult: { count: '7' } });
      if (h === 'news.google.com') {
        const q = decodeURIComponent(new URL(url).searchParams.get('q'));
        if (q.includes('Voorbeeld Chips')) return /hl=nl/.test(url) ? rss(CHIPS_KOPPEN) : LEEG;
        if (q.includes('Vertex')) return /hl=en/.test(url) ? fx('gnews-vertex.xml') : LEEG;
        if (q.includes('Anthropic')) return rss([1, 2, 3, 4, 5].map((i) => ({ t: 'Anthropic prijst beursgang - Krant ' + i, d: '2026-11-12' })).concat([{ t: 'Anthropic huurt kantoor - Krant Z', d: '2026-11-12' }]));
        return LEEG;
      }
      if (url.includes('press-releases')) return FDA;
      if (url.includes('fda.gov')) return LEEG;
      if (h === 'www.ema.europa.eu') return fx('ema.xml');
      if (h === 'www.afm.nl') return AFM;
      if (h === 'feeds.nos.nl') return NOS;
      return LEEG;
    },
    claude: async (sys, prompt, schema) => { w.prompts.push(sys + '\n' + prompt); const d = w.antwoord(prompt); return d ? { ok: true, data: d, verbruik: { account: 2, in: 100, uit: 50 } } : { ok: false, fout: 'geen ruimte' }; },
    bericht: async (tekst, sleutel) => { if (w.berichten.some((b) => b.sleutel === sleutel)) return { ok: true, id: 'dubbel', dubbel: true }; w.berichten.push({ tekst, sleutel }); return { ok: true, id: 'b' + w.berichten.length }; },
    klok: () => w.klok, log: (x) => w.log.push(x), boxRij: (t) => { w.box.push(t); return true; }, hartslag: async (a, b) => { w.hart = [a, b]; } });
  return w;
}
// standaardantwoord: alles gaat over het bedrijf, raakt ja, met een cijferpunt, een fase-punt, een handelspunt en een punt zonder bron
function standaardAntwoord(prompt) {
  const bs = [...prompt.matchAll(/^## (b\d+) — /gm)].map((m) => m[1]);
  return { bedrijven: bs.map((b) => {
    const ids = [...prompt.matchAll(new RegExp('^(' + b + '-\\d+) \\|', 'gm'))].map((m) => m[1]);
    return { bedrijf: b, over_dit_bedrijf: ids, raakt_reden: 'ja', waarom: 'Het raakt de laag waarom je het kocht.',
      voor: [{ tekst: 'De omzet steeg 12 % volgens de bron.', ids: [ids[0]] }, { tekst: 'De fase 3-studie loopt door.', ids: [ids[0]] }, { tekst: 'Dit is een kansrijk aandeel om bij te kopen.', ids: [ids[0]] }],
      tegen: [{ tekst: 'Een punt zonder geldige bron.', ids: ['zz-9'] }, { tekst: 'Er is ook concurrentie.', ids: [ids[ids.length - 1]] }] };
  }) };
}
// standaardbedrijven: twee posities (tech, health), een indexfonds, twee volglijstregels (Vertex, Voorbeeld AI met belang)
function vul(w) {
  w.P('positie', { actie: 'zet', naam: 'VOORBEELD CHIPS INC', isin: 'XX0000000011', aantal: '3', waarde_eur: '300', soort: 'tech' });
  w.P('positie', { actie: 'zet', naam: 'VOORBEELD PHARMA NV', isin: 'XX0000000033', aantal: '2', waarde_eur: '100', soort: 'health' });
  w.P('positie', { actie: 'zet', naam: 'VOORBEELD WERELD ETF', isin: 'XX0000000022', aantal: '10', waarde_eur: '800', soort: 'kern' });
  const tx = w.P('transactie', { actie: 'zet', richting: 'erbij', datum: '2026-11-02', naam: 'VOORBEELD CHIPS INC', isin: 'XX0000000011', aantal: '3', koers: '100', valuta: 'EUR' }).sleutel;
  w.P('dagboek', { transactie: tx, waarom: REDEN });
  const v1 = w.P('volglijst', { actie: 'zet', naam: 'Vertex Pharmaceuticals', code: 'VRTX', waarom: 'Volg: pijnstiller zonder opioïd.' }).id;
  const v2 = w.P('volglijst', { actie: 'zet', naam: 'Voorbeeld AI', waarom: 'Voor de leuk.' }).id;
  w.P('bedrijf', { sleutel: 'isin:XX0000000011', actie: 'zet', namen: 'Voorbeeld Chips', code: 'VBCH', cik: '1045810' });
  w.P('bedrijf', { sleutel: 'isin:XX0000000033', actie: 'zet', namen: ['Voorbeeld Pharma'], producten: 'Voorbeeldmab', sponsor: 'Voorbeeld Pharma' });
  w.P('bedrijf', { sleutel: 'isin:XX0000000022', actie: 'zet', namen: ['Voorbeeld Wereld'] });   // kern: krijgt geen nieuws
  w.P('bedrijf', { sleutel: 'volg:' + v1, actie: 'zet', namen: 'Vertex Pharmaceuticals\nVertex', code: 'VRTX' });
  w.P('bedrijf', { sleutel: 'volg:' + v2, actie: 'zet', namen: 'Voorbeeld AI\nAnthropic', cik: '2130357' });
  w.P('plan', { vraag: 8, tekst: 'x', waarden: { max_aandeel: '20' } });
  return { v1, v2 };
}
const titels = (w) => w.m.metDb((db) => db.prepare('SELECT bedrijf, bron, titel, koppeling, hard FROM nieuws').all().map((r) => Object.assign({}, r)), false);
const week = (w) => w.m.app({ methode: 'GET', pad: '/app/beleggen/week' }).body;

test('ophalen: bronnen per bedrijf, kern overgeslagen, koppeling vast op SEC/sponsor/product, alleen kop + link', async () => {
  const w = wereld(); vul(w);
  const t = await w.n.ophaal('2026-11-13');
  assert.strictEqual(t.bedrijven, 4, 'kern telt niet mee');
  const r = titels(w);
  assert.ok(!r.some((x) => x.bedrijf === 'isin:XX0000000022'), 'indexfonds krijgt geen nieuws');
  assert.ok(!w.gehaald.some((u) => /Voorbeeld%20Wereld|Voorbeeld\+Wereld/.test(u)), 'geen zoekvraag voor het indexfonds');
  const sec = r.filter((x) => x.bron === 'sec' && x.bedrijf === 'isin:XX0000000011');
  assert.ok(sec.some((x) => /^8-K — bestuur gewijzigd/.test(x.titel) && x.koppeling === 'cik' && x.hard === 1), JSON.stringify(sec));   // opgenomen 8-K 12-11 (5.02)
  assert.ok(sec.some((x) => /Form 4/.test(x.titel)), 'Form 4 gebundeld');
  assert.ok(r.some((x) => x.bron === 'clinicaltrials' && x.koppeling === 'sponsor' && /Voorbeeldmab/.test(x.titel)));
  assert.ok(!r.some((x) => /Studie van een ander/.test(x.titel)), 'alleen als hoofdsponsor');
  assert.ok(r.some((x) => x.bron === 'fda' && x.koppeling === 'product' && x.bedrijf === 'isin:XX0000000033'));
  assert.ok(r.some((x) => x.bron === 'afm' && x.koppeling === 'naam' && x.hard === 1));
  assert.ok(!r.some((x) => x.bron === 'pubmed' && x.bedrijf === 'isin:XX0000000011') && r.some((x) => x.bron === 'pubmed' && x.bedrijf === 'isin:XX0000000033'), 'PubMed alleen bij productnamen');
  assert.deepStrictEqual(w.hart, [t.nieuw, 0]);
  const kolommen = w.m.metDb((db) => db.prepare('PRAGMA table_info(nieuws)').all().map((c) => c.name), false);
  assert.ok(!kolommen.some((c) => /tekst|inhoud|body/.test(c)), 'geen artikeltekst bewaard');
});

test('R1: aanprijzing en aanprijzende uitgevers vallen weg', async () => {
  const w = wereld(); vul(w); await w.n.ophaal('2026-11-13');
  const r = titels(w).map((x) => x.titel);
  assert.ok(!r.some((t) => /stocks to buy|Motley Fool|Simply Wall St|Price Target/i.test(t)), r.filter((t) => /buy|Fool|Wall|Target/i.test(t)).join(' | '));
  assert.ok(r.some((t) => /wint rechtszaak/.test(t)));
});

test('K1: naam van één woord alleen hoofdlettergevoelig mét tweede kenmerk (opgenomen koppen met naamgenoten)', async () => {
  const w = wereld(); vul(w); await w.n.ophaal('2026-11-13');
  const r = titels(w).filter((x) => x.bron === 'gnews' && x.bedrijf.startsWith('volg:')).map((x) => x.titel);
  assert.ok(r.some((t) => /Vertex Pharmaceuticals\(VRTX\.US\) Officer Sells/.test(t)), r.join(' | '));
  for (const fout of [/Vertex Minerals/, /Vertex Resource Group/, /With Vertex's FDA Clock/, /Vertex Inc \(VERX\)/]) assert.ok(!r.some((t) => fout.test(t)), 'naamgenoot: ' + fout);
  const k = N.maakKoppel({ namen: ['Novo'], code: 'NVO', producten: ['Wegovy'] });
  assert.strictEqual(k('Novo cuts Wegovy price'), true);
  assert.strictEqual(k('De novo authorisation granted'), false);
  assert.strictEqual(k('Novo opens office'), false);
  assert.strictEqual(N.maakKoppel({ namen: ['Novo Nordisk'], producten: [] })('NOVO NORDISK results'), true);
});

test('reden geschoond vóór de prompt (bedrag, %, IBAN, mail, telefoon, belang), letterlijk op de kaart; ≤ 300 tekens', async () => {
  const s = N.schoonReden(REDEN, N.woordRe(['Anthropic', 'Claude']));
  for (const weg of ['1.250', '12,5', 'NL91', 'ABNA', '@', '12345678', 'Anthropic']) assert.ok(!s.includes(weg), weg + ' in ' + s);
  assert.ok(/\[weg\]/.test(s));
  assert.strictEqual(N.schoonReden('x'.repeat(500)).length, 300);
  assert.strictEqual(N.schoonReden('Ik kocht er 5000 euro en $ 200 van, 3 mln, sinds 2020 blij'), 'Ik kocht er [weg] en [weg] van, [weg], sinds 2020 blij');
  const w = wereld(); vul(w); await w.n.ophaal('2026-11-13'); await w.n.weekronde('2026-11-15');
  const p = w.prompts.join('\n');
  assert.ok(p.includes('Reden van de belegger: Ik kocht voor [weg]'), p.slice(0, 600));
  assert.ok(!p.includes('NL91ABNA0417164300') && !p.includes('jan@voorbeeld') && !p.includes('1.250'));
  const kaart = week(w).weken[0].kaarten.find((k) => k.bedrijf === 'isin:XX0000000011');
  assert.strictEqual(kaart.reden_zelf, REDEN, 'op de kaart letterlijk (alleen in de app)');
});

test('ZOU 1: belang (Anthropic, Claude) nergens in de prompt, ook niet in koppen van een ander bedrijf; eigen blok met de vaste zin', async () => {
  const w = wereld(); vul(w); await w.n.ophaal('2026-11-13'); await w.n.weekronde('2026-11-15');
  assert.strictEqual(w.prompts.length, 1);
  assert.ok(!/anthropic|claude|Voorbeeld AI/i.test(w.prompts[0].replace(/^[\s\S]*?\nWeek /, 'Week ')), 'belang in de prompt');
  const wk = week(w).weken[0];
  assert.strictEqual(wk.belang.zin, N.BELANG_ZIN);
  const f = wk.belang.feiten.map((x) => x.titel).join(' | ');
  assert.ok(/S-1\/A/.test(f), 'harde regel (SEC) in het blok: ' + f);
  assert.ok(/Anthropic prijst beursgang/.test(f), 'kop met ≥ 4 melders in het blok');
  assert.ok(!/huurt kantoor/.test(f), 'losse kop zonder melders niet in het blok');
  assert.ok(!wk.kaarten.some((k) => k.bedrijf.startsWith('volg:') && k.naam === 'Voorbeeld AI'), 'belang krijgt nooit een kaart');
  assert.ok(!JSON.stringify(wk.kaarten).includes('Claude-modellen'), 'Claude-kop van een ander bedrijf niet op diens kaart');
  // laatste vangnet: als er toch een schrijfwijze in de prompt komt, geen aanroep
  const w2 = wereld({ haal: { 'CHP%20Proef': rss([{ t: 'CHP Proef wint een prijs - Krant A', d: '2026-11-12' }]) } }); vul(w2);
  const v3 = w2.P('volglijst', { actie: 'zet', naam: 'Claude Holding Proef' }).id;
  w2.P('bedrijf', { sleutel: 'volg:' + v3, actie: 'zet', namen: 'CHP Proef' });
  w2.m.metDb((db) => db.prepare("UPDATE bedrijf SET belang = 0 WHERE sleutel = ?").run('volg:' + v3), true);   // stel: het belang is (fout) uitgezet
  await w2.n.ophaal('2026-11-13');
  await w2.n.weekronde('2026-11-15');
  assert.strictEqual(w2.prompts.length, 0, 'prompt met belang = geen aanroep');
});

test('R2/R3/R4: zelfde feit één regel met melders, studies van één dag samen, ≤ 6 koppen + ≤ 6 harde per bedrijf', async () => {
  const w = wereld(); vul(w); await w.n.ophaal('2026-11-13'); await w.n.weekronde('2026-11-15');
  const p = w.prompts[0];
  assert.strictEqual((p.match(/fabriek in Arizona/g) || []).length, 1, 'drie koppen over hetzelfde feit = één regel');
  assert.ok(/\| 3 melders \| Voorbeeld Chips opent nieuwe fabriek/.test(p));
  assert.ok(/2× nieuwe studie \(o\.a\. Voorbeeldmab/.test(p), 'R3');
  const blok = p.split('## ').find((x) => x.includes('VOORBEELD CHIPS'));
  const koppen = (blok.match(/^b\d+-\d+ \| [^|]+ \| Google Nieuws/gm) || []).length;
  assert.strictEqual(koppen, 6, 'R4: hooguit zes koppen (' + koppen + ')');
});

test('MOET 1 + woordpoort: punt met cijfer of handelstaal valt weg; "fase 3" mag; punt zonder geldige bron weg', async () => {
  assert.strictEqual(N.heeftCijfer('De fase 3-studie loopt door.'), false);
  assert.strictEqual(N.heeftCijfer('De fase 1–2 studie'), false);
  assert.strictEqual(N.heeftCijfer('Fase 5 begint'), true);
  assert.strictEqual(N.heeftCijfer('8-K over het bestuur'), true);
  assert.strictEqual(N.modelZinOk('De koers zal waarschijnlijk stijgen.'), false);
  assert.strictEqual(N.modelZinOk('Er is ook concurrentie.'), true);
  assert.strictEqual(N.modelZinOk('De verkoop van het middel groeit; je kocht het om die reden.'), true);
  assert.strictEqual(N.modelZinOk('Overweeg nu bij te kopen.'), false);
  const w = wereld(); vul(w); await w.n.ophaal('2026-11-13'); await w.n.weekronde('2026-11-15');
  const k = week(w).weken[0].kaarten.find((x) => x.bedrijf === 'isin:XX0000000011');
  const voor = k.voor.map((x) => x.tekst), tegen = k.tegen.map((x) => x.tekst);
  assert.deepStrictEqual(voor, ['De fase 3-studie loopt door.'], JSON.stringify(voor));
  assert.deepStrictEqual(tegen, ['Er is ook concurrentie.'], JSON.stringify(tegen));
  assert.ok(k.voor[0].bronnen[0].link && k.voor[0].bronnen[0].datum, 'elk punt draagt bron + datum');
  assert.strictEqual(k.waarom, 'Het raakt de laag waarom je het kocht.');
});

test('MOET 2: harde gebeurtenis bij een positie blijft op een kaart, ook bij "nee" of zonder antwoord', async () => {
  for (const soort of ['nee', 'weg', 'naamgenoot']) {
    const w = wereld({ antwoord: (p) => { const a = standaardAntwoord(p); for (const b of a.bedrijven) {
      if (soort === 'nee') { b.raakt_reden = 'nee'; }
      if (soort === 'naamgenoot') { b.over_dit_bedrijf = []; b.raakt_reden = 'nee'; }
    } if (soort === 'weg') a.bedrijven = []; return a; } });
    vul(w); await w.n.ophaal('2026-11-13'); await w.n.weekronde('2026-11-15');
    const ks = week(w).weken[0].kaarten;
    const chips = ks.find((x) => x.bedrijf === 'isin:XX0000000011');
    assert.ok(chips, soort + ': geen kaart voor de positie met een 8-K');
    assert.ok(chips.gebeurd.some((g) => /^8-K/.test(g.titel)), soort + ': 8-K niet bij "gebeurd"');
    assert.ok(ks.find((x) => x.bedrijf === 'isin:XX0000000033'), soort + ': positie met FDA-besluit/studie zonder kaart');
  }
});

test('model faalt: dezelfde kaarten zonder voor/tegen/waarom; volglijst zonder harde gebeurtenis onder Verder gezien', async () => {
  const w = wereld({ antwoord: () => null }); vul(w); await w.n.ophaal('2026-11-13');
  const t = await w.n.weekronde('2026-11-15');
  assert.strictEqual(t.model, false);
  const wk = week(w).weken[0];
  assert.strictEqual(wk.gewogen, false);
  assert.ok(wk.kaarten.length >= 2);
  for (const k of wk.kaarten) { assert.deepStrictEqual([k.voor, k.tegen, k.waarom], [[], [], null]); assert.ok(k.gebeurd.length); }
  assert.ok(wk.verder.some((v) => /Vertex/.test(v.naam)), 'volglijst zonder harde gebeurtenis → Verder gezien');
});

test('plafond: hooguit vijf kaarten, harde gebeurtenis bij bezit eerst; de rest onder Verder gezien', async () => {
  const w = wereld();
  for (let i = 1; i <= 7; i++) {
    const isin = 'XX00000001' + i + '0';
    w.P('positie', { actie: 'zet', naam: 'Voorbeeld Bedrijf ' + i, isin, aantal: '1', waarde_eur: '100', soort: 'tech' });
    w.P('bedrijf', { sleutel: 'isin:' + isin, actie: 'zet', namen: 'Voorbeeld Bedrijf ' + i, cik: String(1045810) });
  }
  await w.n.ophaal('2026-11-13'); await w.n.weekronde('2026-11-15');
  const wk = week(w).weken[0];
  assert.strictEqual(wk.kaarten.length, 5);
  assert.strictEqual(wk.verder.filter((v) => /plafond/.test(v.waarom)).length >= 2, true, JSON.stringify(wk.verder.map((v) => v.waarom)));
});

test('R6 + dubbel: zelfde week twee keer = één weekrij en één bericht; cluster van vorige week komt niet terug', async () => {
  const w = wereld(); vul(w); await w.n.ophaal('2026-11-13');
  const a = await w.n.weekronde('2026-11-15');
  const b = await w.n.weekronde('2026-11-15');
  assert.strictEqual(a.nieuw_rij, true); assert.strictEqual(b.nieuw_rij, false);
  await w.n.meld({ datum: '2026-11-15', uur: 9, min: 5 });
  await w.n.meld({ datum: '2026-11-15', uur: 9, min: 10 });
  assert.strictEqual(w.berichten.length, 1);
  assert.strictEqual(week(w).weken.length, 1);
  // volgende week: dezelfde koppen opnieuw opgehaald → niets terug
  w.vandaag = '2026-11-20'; await w.n.ophaal('2026-11-20');
  w.prompts.length = 0;
  await w.n.weekronde('2026-11-22');
  assert.ok(!w.prompts.join('').includes('fabriek in Arizona'), 'cluster van vorige week kwam terug');
  assert.ok(!w.prompts.join('').includes('8-K'), '8-K van vorige week kwam terug');
});

test('seintje: alleen aantallen, geen namen of bedragen; stille uren 22:00–07:00; zondagavond-ronde meldt maandag 07:00', async () => {
  const w = wereld(); vul(w); await w.n.ophaal('2026-11-13'); await w.n.weekronde('2026-11-15');
  assert.deepStrictEqual(await w.n.meld({ datum: '2026-11-15', uur: 22, min: 30 }), { stil: true });
  assert.deepStrictEqual(await w.n.meld({ datum: '2026-11-16', uur: 6, min: 55 }), { stil: true });
  assert.strictEqual(w.berichten.length, 0);
  const r = await w.n.meld({ datum: '2026-11-16', uur: 7, min: 0 });
  assert.strictEqual(r.ok, true);
  const t = w.berichten[0].tekst;
  assert.match(t, /^Beleggen: deze week \d+ kaarten?, \d+ dingen? onder Verder gezien/);
  assert.ok(!/Voorbeeld|Vertex|Anthropic|€|%|\d{3,}/.test(t.replace(/https:\/\/\S+/, '')), t);
  assert.strictEqual(w.berichten[0].sleutel, 'beleggen-week-2026-W46');
});

test('kapotte bron stopt de rest niet; drie dagen op rij fout = één box-rij per week, zonder bedrijfsnamen; herstel stil', async () => {
  const w = wereld({ kapot: ['fd.nl', 'www.afm.nl'] }); vul(w);
  for (const d of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) { w.vandaag = d; await w.n.ophaal(d); }
  assert.ok(titels(w).some((x) => x.bron === 'sec'), 'andere bronnen liepen door');
  assert.strictEqual(w.box.length, 2, 'één rij per kapotte bron: ' + w.box.length);
  assert.ok(w.box.every((t) => /#ovis-beleggen/.test(t) && !/Voorbeeld|Vertex/.test(t)), w.box.join('\n'));
  w.kapot.clear(); w.vandaag = '2026-11-14'; await w.n.ophaal('2026-11-14');
  assert.strictEqual(w.box.length, 2, 'herstel geeft geen rij');
  assert.strictEqual(w.m.metDb((db) => db.prepare("SELECT fouten_op_rij FROM nieuws_bron WHERE bron = 'fd'").get().fouten_op_rij, false), 0);
});

test('klok: ophalen 06:40 eenmaal per dag (ook ingehaald), weekronde zondag 09:00, niet ervoor', async () => {
  const w = wereld(); vul(w);
  w.klok = { datum: '2026-11-13', uur: 6, min: 35 }; await w.n.tik();
  assert.strictEqual(w.gehaald.length, 0);
  w.klok = { datum: '2026-11-13', uur: 6, min: 40 }; await w.n.tik();
  const n1 = w.gehaald.length; assert.ok(n1 > 0);
  w.klok = { datum: '2026-11-13', uur: 6, min: 45 }; await w.n.tik();
  assert.strictEqual(w.gehaald.length, n1, 'nooit twee keer per dag');
  w.klok = { datum: '2026-11-15', uur: 8, min: 55 }; w.vandaag = '2026-11-15'; await w.n.tik();
  assert.strictEqual(w.prompts.length, 0, 'geen weekronde vóór 09:00');
  w.klok = { datum: '2026-11-15', uur: 9, min: 0 }; await w.n.tik();
  assert.strictEqual(w.prompts.length, 1); assert.strictEqual(w.berichten.length, 1);
  w.klok = { datum: '2026-11-15', uur: 9, min: 5 }; await w.n.tik();
  assert.strictEqual(w.prompts.length, 1); assert.strictEqual(w.berichten.length, 1);
});

test('nachtveeg: nieuws ouder dan 120 dagen weg', async () => {
  const w = wereld(); vul(w);
  w.m.metDb((db) => db.prepare("INSERT INTO nieuws (sleutel, bedrijf, bron, bronsleutel, hard, koppeling, datum, titel, eerst_gezien) VALUES ('oud', 'x', 'nos', 'nos', 0, 'naam', '2026-07-01', 'oud', '2026-07-01')").run(), true);
  w.m.metDb((db) => db.prepare("INSERT INTO nieuws (sleutel, bedrijf, bron, bronsleutel, hard, koppeling, datum, titel, eerst_gezien) VALUES ('jong', 'x', 'nos', 'nos', 0, 'naam', '2026-07-20', 'jong', '2026-07-20')").run(), true);
  await w.n.ophaal('2026-11-13');
  const s = w.m.metDb((db) => db.prepare("SELECT sleutel FROM nieuws WHERE sleutel IN ('oud', 'jong')").all().map((r) => r.sleutel), false);
  assert.deepStrictEqual(s, ['jong']);
});

test('routes: kaartje bewerken (controle, belang vanzelf), week lezen, keuzes, Ruis ×3 laat een bron zakken (R5) en terugzetten', async () => {
  const w = wereld();
  const fout = (body, re) => { const u = w.m.app({ methode: 'POST', pad: '/app/beleggen/bedrijf', body }); assert.ok(u.status >= 400 && re.test(u.body.fout), JSON.stringify(u.body)); };
  w.P('positie', { actie: 'zet', naam: 'VOORBEELD CHIPS INC', isin: 'XX0000000011', aantal: '3', waarde_eur: '300', soort: 'tech' });
  fout({ sleutel: 'isin:XX0000000099', actie: 'zet', namen: 'x y' }, /niet gevonden/);
  fout({ sleutel: 'isin:XX0000000011', actie: 'zet', namen: '' }, /schrijfwijze/);
  fout({ sleutel: 'isin:XX0000000011', actie: 'zet', namen: 'Voorbeeld', cik: '12a' }, /CIK/);
  fout({ sleutel: 'isin:XX0000000011', actie: 'zet', namen: 'Voorbeeld', code: 'te lange code!!' }, /beurscode/);
  const v = w.P('volglijst', { actie: 'zet', naam: 'Anthropic' }).id;
  w.P('bedrijf', { sleutel: 'volg:' + v, actie: 'zet', namen: 'Anthropic' });
  const o = w.m.app({ methode: 'GET', pad: '/app/beleggen' }).body;
  assert.strictEqual(o.bedrijven.find((b) => b.sleutel === 'volg:' + v).kaartje.belang, true, 'Anthropic = belang vanzelf');
  assert.ok(o.bedrijven.find((b) => b.sleutel === 'isin:XX0000000011').kaartje === null);
  assert.deepStrictEqual(o.bedrijven.find((b) => b.sleutel === 'isin:XX0000000011').voorstel, { namen: ['VOORBEELD CHIPS'], code: null });
  // vijf kaarten met de SEC-bron; Ruis op drie → SEC zakt
  for (let i = 1; i <= 5; i++) { const isin = 'XX00000002' + i + '0';
    w.P('positie', { actie: 'zet', naam: 'Voorbeeld Bedrijf ' + i, isin, aantal: '1', waarde_eur: '100', soort: 'tech' });
    w.P('bedrijf', { sleutel: 'isin:' + isin, actie: 'zet', namen: 'Voorbeeld Bedrijf ' + i, cik: '1045810' }); }
  await w.n.ophaal('2026-11-13'); await w.n.weekronde('2026-11-15');
  const wk = week(w);
  assert.strictEqual(wk.weken[0].iso_week, '2026-W46');
  const ks = wk.weken[0].kaarten;
  const k = (x, keuze) => w.P('week/keuze', { week: '2026-W46', bedrijf: ks[x].bedrijf, keuze });
  k(0, 'ruis'); k(0, 'ruis'); k(1, 'ruis');
  assert.deepStrictEqual(week(w).gezakt, [], 'twee kaarten = nog niet gezakt (zelfde kaart telt één keer)');
  k(2, 'ruis');
  assert.deepStrictEqual(week(w).gezakt, ['sec']);
  k(3, 'herinner'); k(4, 'nuttig');
  const kz = week(w).keuzes['2026-W46'];
  assert.strictEqual(kz[ks[3].bedrijf].keuze, 'herinner'); assert.strictEqual(kz[ks[3].bedrijf].tot, '2026-11-20');
  const u = w.m.app({ methode: 'POST', pad: '/app/beleggen/week/keuze', body: { week: '2026-W46', bedrijf: ks[0].bedrijf, keuze: 'kopen' } });
  assert.strictEqual(u.status, 400);
  // gezakte bron: volgende week alleen onder Verder gezien, niet naar het model
  w.vandaag = '2026-11-20';
  w.haalExtra['data.sec.gov'] = secJson('x', [['8-K', '2026-11-19', '8.01']]);
  await w.n.ophaal('2026-11-20'); w.prompts.length = 0; await w.n.weekronde('2026-11-22');
  assert.ok(!w.prompts.join('').includes('8-K'), 'gezakte bron ging naar het model');
  assert.ok(week(w).weken[0].verder.some((x) => x.bron === 'sec' && /Ruis/.test(x.waarom)));
  w.P('week/keuze', { actie: 'terug', bron: 'sec' });
  assert.deepStrictEqual(week(w).gezakt, []);
  // herinnering na de afkoeltijd staat bovenaan
  w.vandaag = '2026-11-21';
  assert.strictEqual(week(w).herinneringen.length, 1);
});

test('grenzen: geen handelstaal of koersdoel in de module, model zonder gereedschap via de ingespoten aanroep', () => {
  const src = fs.readFileSync(process.env.BN_JS || path.join(__dirname, '..', 'beleggen-nieuws.js'), 'utf8');
  assert.doesNotMatch(src, /require\('(https?|net|child_process|dns)'\)/);
  assert.doesNotMatch(src, /\bfetch\s*\(|console\./);
  assert.ok(/zonder gereedschap/.test(src));
  assert.match(N.SYSTEEM, /nooit advies om te kopen of te verkopen/);
  assert.match(N.SYSTEEM, /Noem GEEN getallen/);
});
