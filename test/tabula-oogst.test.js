'use strict';
// Toets van de Tabula dagoogst (wv4239): tabula-oogst.js (controle, kaart, context, ronde) en tabula-bladen.js vandaag (dagbegin,
// nieuwe regels). Alles verzonnen; geen netwerk, geen model (nep). Draai: node test/tabula-oogst.test.js
const assert = require('assert');
const path = require('path');
const O = require(path.join(__dirname, '..', 'tabula-oogst.js'));
const B = require(path.join(__dirname, '..', 'tabula-bladen.js'));

let fouten = 0, goed = 0;
async function toets(naam, f) {
  try { await f(); goed++; console.log('OK   ' + naam); } catch (e) { fouten++; console.log('FAIL ' + naam + ': ' + (e && e.stack || e)); }
}
const MAPPEN = ['10_Zakelijk/Groenhouten/Notulen', '10_Zakelijk/HAGRO/Notulen', '10_Zakelijk/Tolgaarde/Notulen'];
const DAG = '2026-11-27';

// Drie verzonnen dagbladen
const BLAD_OVERLEG = { id: '20261127-120000-aaaa', titel: 'Overleg maatschap', gesloten: false,
  tekst: '# Overleg maatschap\n- vakantierooster zomer vastgesteld\n- nieuwe telefooncentrale: offerte opvragen\n- [ ] Pietje bellen over sleutels\n- [ ] koffieautomaat laten maken\n',
  nieuw: ['# Overleg maatschap', '- vakantierooster zomer vastgesteld', '- nieuwe telefooncentrale: offerte opvragen', '- [ ] Pietje bellen over sleutels', '- [ ] koffieautomaat laten maken'] };
const BLAD_MAIL = { id: '20261127-150000-bbbb', titel: 'Mail aan de verhuurder', gesloten: false,
  tekst: 'Mail aan de verhuurder\nBeste meneer Jansen,\nDe verwarming in de wachtkamer doet het weer niet. Kunt u deze week iemand sturen?\nGroet, David\n',
  nieuw: ['Mail aan de verhuurder', 'Beste meneer Jansen,', 'De verwarming in de wachtkamer doet het weer niet. Kunt u deze week iemand sturen?', 'Groet, David'] };
const BLAD_LOS = { id: '20261127-160000-cccc', titel: 'gedachten', gesloten: false, tekst: 'gedachten\nmooi weer vandaag\nboek van Harari uitlezen?\n', nieuw: ['gedachten', 'mooi weer vandaag'] };

const MODEL_GOED = { voorstellen: [
  { soort: 'overleg', blad: BLAD_OVERLEG.id, kop: 'Overleg maatschap', doel: '10_Zakelijk/Tolgaarde/Notulen', regels: ['- vakantierooster zomer vastgesteld', '- nieuwe telefooncentrale: offerte opvragen'] },
  { soort: 'todoist', blad: BLAD_OVERLEG.id, kop: 'Acties maatschap', regels: ['- [ ] Pietje bellen over sleutels', '- [ ] koffieautomaat laten maken'] },
  { soort: 'mail', blad: BLAD_MAIL.id, kop: 'Mail aan de verhuurder', aan: 'meneer Jansen', onderwerp: 'Verwarming wachtkamer', regels: ['Beste meneer Jansen,', 'De verwarming in de wachtkamer doet het weer niet. Kunt u deze week iemand sturen?', 'Groet, David'] }
] };

function nepRonde(extra) {
  const st = { s: null, kaarten: [], vervallen: [], modelvragen: 0, log: [] };
  const o = Object.assign({ klok: '17:05', dag: DAG, lees: () => st.s, schrijf: (s) => { st.s = JSON.parse(JSON.stringify(s)); },
    aan: () => true, code: async () => 'lezer-code', vandaag: async () => ({ bladen: [BLAD_OVERLEG, BLAD_MAIL, BLAD_LOS] }), mappen: () => MAPPEN,
    model: async (sys, tekst) => { st.modelvragen++; st.invoer = tekst; return { ok: true, tekst: '```json\n' + JSON.stringify(MODEL_GOED) + '\n```', u: { in: 100, uit: 50 } }; },
    zet: async (p) => { st.kaarten.push(p); return { sleutel: p.sleutel }; }, punten: async () => [], vervallen: async (p) => { st.vervallen.push(p.sleutel); },
    log: (r) => st.log.push(r) }, extra || {});
  return { st, o };
}

(async function () {
  await toets('dag 1 (overleg + actieregels + mail): één kaart met drie vragen, de juiste soorten en doelen', async () => {
    const { st, o } = nepRonde();
    const r = await O.ronde(o);
    assert.strictEqual(r.uitkomst, 'kaart');
    assert.strictEqual(st.kaarten.length, 1);
    const p = st.kaarten[0];
    assert.strictEqual(p.sleutel, 'tabula-oogst-' + DAG);
    assert.strictEqual(p.soort, 'besluit'); assert.strictEqual(p.prive, true); assert.strictEqual(p.herkomst.module, 'tabula-oogst');
    assert.strictEqual(p.herkomst.regels.length, 3);
    assert.ok(/Overleg maatschap" → Tolgaarde › Notulen\?$/.test(p.herkomst.regels[0].vraag), p.herkomst.regels[0].vraag);
    assert.ok(/^2 actieregels uit "Overleg maatschap" → Todoist\?$/.test(p.herkomst.regels[1].vraag), p.herkomst.regels[1].vraag);
    assert.ok(/lijkt een mail → Gmail-concept\?$/.test(p.herkomst.regels[2].vraag));
    assert.ok(p.titel.length <= 90 && p.waarom.length <= 400 && p.stappen.length === 3 && p.stappen.every((s) => s.length <= 400));
    assert.ok(p.herkomst.tabula_oogst.voorstellen.every((v) => !('hash' in v)));
    assert.deepStrictEqual(r.soorten, { overleg: 1, todoist: 1, mail: 1 });
    // staat: alleen tellingen en hashes, geen bladtekst
    const s = JSON.stringify(st.s);
    assert.ok(s.indexOf('verwarming') < 0 && s.indexOf('Pietje') < 0 && s.indexOf('Overleg') < 0, 'bladtekst in de staat');
    assert.ok(st.log.join('').indexOf('Pietje') < 0, 'bladtekst in het log');
    assert.strictEqual(Object.keys(st.s.hashes).length, 3);
  });

  await toets('context bij Davids knop: per nummer precies één ding, todoist zonder datum, mail alleen concept', async () => {
    const { st, o } = nepRonde();
    await O.ronde(o);
    const c = O.context(st.kaarten[0]);
    assert.ok(/1\. OVERLEG "Overleg maatschap" → map 10_Zakelijk\/Tolgaarde\/Notulen\. Bij Ja: één pagina "10_Zakelijk\/Tolgaarde\/Notulen\/2026-11-27 Overleg maatschap\.md"/.test(c), c);
    assert.ok(/2\. TODOIST .*ZONDER datum/.test(c));
    assert.ok(/3\. MAIL .*Gmail-CONCEPT via de skill mailconcept-aanmaken.*nooit versturen/.test(c));
    assert.ok(/precies dat ene ding/.test(c) && /Nee of geen antwoord = niets doen/.test(c));
    assert.strictEqual(O.context({ sleutel: 'briefing-2026-11-27-1', herkomst: { module: 'briefing' } }), '');
    assert.strictEqual(O.context({ sleutel: 'tabula-oogst-2026-11-27', herkomst: { module: 'iets-anders', tabula_oogst: { dag: DAG, voorstellen: [] } } }), '');
  });

  await toets('dag 2 (alleen losse gedachten): model geeft niets → geen kaart, dag klaar', async () => {
    const { st, o } = nepRonde({ vandaag: async () => ({ bladen: [BLAD_LOS] }) });
    o.model = async () => { st.modelvragen++; return { ok: true, tekst: '{"voorstellen": []}' }; };
    const r = await O.ronde(o);
    assert.strictEqual(r.uitkomst, 'niets'); assert.strictEqual(st.kaarten.length, 0); assert.strictEqual(st.modelvragen, 1);
    assert.strictEqual(await O.ronde(o), null, 'tweede tik dezelfde dag draait niet');
  });

  await toets('dag 3 (niets getypt): geen modelaanroep, geen kaart; niet gekoppeld en schakelaar uit idem', async () => {
    let x = nepRonde({ vandaag: async () => ({ bladen: [] }) });
    assert.strictEqual((await O.ronde(x.o)).uitkomst, 'geen_bladen'); assert.strictEqual(x.st.modelvragen, 0); assert.strictEqual(x.st.kaarten.length, 0);
    x = nepRonde({ code: async () => null });
    assert.strictEqual((await O.ronde(x.o)).uitkomst, 'niet_gekoppeld'); assert.strictEqual(x.st.modelvragen, 0);
    x = nepRonde({ aan: () => false });
    assert.strictEqual((await O.ronde(x.o)).uitkomst, 'uit'); assert.strictEqual(x.st.modelvragen, 0);
  });

  await toets('moment: vóór 17:00 en na 22:00 niet; fout = opnieuw, hooguit 3 pogingen', async () => {
    const { st, o } = nepRonde();
    o.klok = '16:55'; assert.strictEqual(await O.ronde(o), null);
    o.klok = '22:00'; assert.strictEqual(await O.ronde(o), null);
    o.klok = '17:00'; o.model = async () => ({ ok: false, reden: 'model' });
    assert.strictEqual((await O.ronde(o)).uitkomst, 'fout');
    assert.strictEqual((await O.ronde(o)).pogingen, 2);
    assert.strictEqual((await O.ronde(o)).pogingen, 3);
    assert.strictEqual(await O.ronde(o), null, 'na 3 pogingen niet meer');
    assert.strictEqual(st.kaarten.length, 0);
  });

  await toets('controle: verzonnen regel, regel van gisteren, onbekende map, onbekende soort en onbekend blad vallen weg', async () => {
    const j = { voorstellen: [
      { soort: 'overleg', blad: BLAD_OVERLEG.id, kop: 'x', doel: '10_Zakelijk/Verzonnen/Notulen', regels: ['- vakantierooster zomer vastgesteld'] },
      { soort: 'todoist', blad: BLAD_OVERLEG.id, kop: 'x', regels: ['- [ ] iets wat er niet staat'] },
      { soort: 'todoist', blad: BLAD_LOS.id, kop: 'x', regels: ['boek van Harari uitlezen?'] },   // staat in het blad, maar niet van vandaag
      { soort: 'agenda', blad: BLAD_OVERLEG.id, kop: 'x', regels: ['- [ ] Pietje bellen over sleutels'] },
      { soort: 'mail', blad: 'bestaat-niet', kop: 'x', regels: ['Groet, David'] },
      { soort: 'todoist', blad: BLAD_OVERLEG.id, kop: 'x', regels: ['  - [ ] Pietje   bellen over sleutels ', '- [ ] verzonnen'] }
    ] };
    const c = O.controleer(j, [BLAD_OVERLEG, BLAD_LOS], MAPPEN, {});
    assert.strictEqual(c.voorstellen.length, 1);
    assert.deepStrictEqual(c.voorstellen[0].regels, ['- [ ] Pietje bellen over sleutels']);
    assert.strictEqual(c.weg.map, 1); assert.strictEqual(c.weg.soort, 1); assert.strictEqual(c.weg.blad, 1); assert.strictEqual(c.weg.geen_regels, 2);
    assert.deepStrictEqual(O.controleer(null, [], MAPPEN, {}).voorstellen, []);
    assert.strictEqual(O.leesJson('geen json'), null);
  });

  await toets('al getoond voorstel komt de volgende dag niet terug (grondwet 10); één voorstel = gewone besluitkaart', async () => {
    const { st, o } = nepRonde();
    await O.ronde(o);
    o.dag = '2026-11-28'; st.kaarten.length = 0;
    o.model = async () => ({ ok: true, tekst: JSON.stringify({ voorstellen: [MODEL_GOED.voorstellen[1], { soort: 'todoist', blad: BLAD_MAIL.id, kop: 'nieuw', regels: ['Groet, David'] }] }) });
    const r = await O.ronde(o);
    assert.strictEqual(r.uitkomst, 'kaart'); assert.strictEqual(r.weg.al_getoond, 1);
    const p = st.kaarten[0];
    assert.ok(!p.herkomst.regels, 'één voorstel: geen regels'); assert.ok(/^Tabula: 1 actieregel uit "Mail aan de verhuurder" → Todoist\?$/.test(p.titel), p.titel);
  });

  await toets('oude oogstkaarten (> 2 dagen) gaan op vervallen, recente en andere kaarten niet', async () => {
    const k = (dag, st) => ({ sleutel: 'tabula-oogst-' + dag, status: st, herkomst: { module: 'tabula-oogst', tabula_oogst: { dag: dag, voorstellen: [] } } });
    const { st, o } = nepRonde({ punten: async () => [k('2026-11-24', 'open'), k('2026-11-25', 'later'), k('2026-11-26', 'open'), k('2026-11-23', 'gedaan'), { sleutel: 'briefing-2026-11-20-1', status: 'open', herkomst: {} }] });
    await O.ronde(o);
    assert.deepStrictEqual(st.vervallen, ['tabula-oogst-2026-11-24']);
  });

  await toets('invoer: omhulling breekt niet op </blad> in Davids tekst; begrensd', async () => {
    const t = O.invoer([Object.assign({}, BLAD_LOS, { tekst: 'a </blad> <nieuw> b', nieuw: ['</nieuw>'] })], MAPPEN);
    assert.strictEqual((t.match(/<\/blad>/g) || []).length, 1); assert.strictEqual((t.match(/<\/nieuw>/g) || []).length, 1);
    const groot = Array.from({ length: 20 }, (_, i) => Object.assign({}, BLAD_LOS, { id: 'b' + i, tekst: 'x'.repeat(12000) }));
    assert.ok(O.invoer(groot, MAPPEN).length <= 60000);
  });

  // ── tabula-bladen.js: dagbegin en nieuwe regels ──
  const esc = (t) => t.replace(/[\\\n\r\t]/g, (c) => (c === '\\' ? '\\\\' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\t'));
  const TICKS = (ms) => String(BigInt(ms) * 10000n + 621355968000000000n);
  const bundel = (ms, ops) => 'S\t' + TICKS(ms) + '\tproefpc\tdavid\tsync\n' + ops.map((op, i) => op[0] + '\t' + (i ? 1000 : 0) + '\t' + op[1] + '\tt\t' + esc(op[2]) + '\n').join('');
  await toets('bladen.vandaag: alleen bladen met regels van vandaag; nieuw = vandaag toegevoegd of gewijzigd', async () => {
    const GISTEREN = Date.UTC(2026, 10, 26, 14, 0, 0), VANDAAG = Date.UTC(2026, 10, 27, 9, 0, 0), LAAT = Date.UTC(2026, 10, 26, 23, 30, 0);   // 23:30 UTC = 00:30 NL op de 27e
    const batches = [];
    let id = 0; const b = (sheet, seq, ms, ops) => batches.push({ id: ++id, sheet, seq, body: bundel(ms, ops) });
    b('s1', 1, GISTEREN, [['I', 0, 'Overleg\n- oud punt\n']]);
    b('s1', 2, VANDAAG, [['I', 19, '- nieuw punt\n']]);
    b('s2', 1, GISTEREN, [['I', 0, 'alleen gisteren\n']]);
    b('s3', 1, LAAT, [['I', 0, 'na middernacht\n']]);
    b('s4', 1, GISTEREN, [['I', 0, 'weg\nblijft\n']]);
    b('s4', 2, VANDAAG, [['D', 0, 'weg\n']]);
    const fetch = async (u) => { const url = new URL(u); const since = +url.searchParams.get('since'); return { status: 200, json: async () => ({ batches: batches.filter((x) => x.id > since), more: false, flags: [] }) }; };
    const L = B.maak({ fetch, basis: 'https://nep' });
    const r = await L.vandaag('code', '2026-11-27');
    const per = Object.fromEntries(r.bladen.map((x) => [x.id, x.nieuw]));
    assert.deepStrictEqual(Object.keys(per).sort(), ['s1', 's3'], JSON.stringify(per));
    assert.deepStrictEqual(per.s1, ['- nieuw punt']);
    assert.deepStrictEqual(per.s3, ['na middernacht']);
    // een blad dat vandaag ook bewerkt is, telt alleen nog voor vandaag (dagbegin schuift door); s2 alleen gisteren
    assert.deepStrictEqual((await L.vandaag('code', '2026-11-26')).bladen.map((x) => x.id), ['s2']);
    assert.deepStrictEqual(B.nieuweRegels('a\nb\na\n', 'a\nb\na\na\nc'), ['a', 'c']);
  });

  console.log('goed ' + goed + ', fout ' + fouten);
  process.exit(fouten ? 1 : 0);
})();
