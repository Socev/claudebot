'use strict';
// wv3156: OVIS NZa tab "Vragen" (nza-vragen.js) — vraagdraden uit het app-log, doorvragen in dezelfde draad, context voor de prompt,
// markdown voor de download, aanhangsel (plek voor rij B), rechten 0700/0600. Alles verzonnen: geen stuk, geen patiënt, geen echte vraag.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { maak, bronnenUit, eersteRegel } = require('../nza-vragen.js');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nza-vragen-'));
let n = 0;
const nieuwMap = () => path.join(T, 'v' + (++n));
const J = (i) => i.toString(16).padStart(16, 'a');   // verzonnen job-id
const ANTW = [
  '## Kern',
  'De **proefbeschikking** noemt het tarief op [Proef 01-01-2026, p. 3](/nza#stuk=proef-tb-2026&plek=3) en',
  'de rechter oordeelt anders in [Proef CBb, r.o. 4.2](https://app.voorbeeld.test/nza#stuk=proef-cbb-1&plek=4.2).',
  'Nogmaals [p. 3](/nza#stuk=proef-tb-2026&plek=3). Een kapotte [link](/nza#stuk=../../etc&plek=1).',
].join('\n');

test('bronnenUit: relatieve en absolute /nza-links, ontdubbeld, onveilige id eruit', () => {
  const b = bronnenUit(ANTW);
  assert.deepStrictEqual(b.map((x) => x.stuk + '|' + x.plek), ['proef-tb-2026|3', 'proef-cbb-1|4.2']);
  assert.strictEqual(b[1].link, '/nza#stuk=proef-cbb-1&plek=4.2');
});

test('eersteRegel: zonder kopteken, vet en linkdoel', () => {
  assert.strictEqual(eersteRegel('## Kern\nrest'), 'rest');
  assert.strictEqual(eersteRegel('## Alleen een kop'), 'Alleen een kop');
  assert.strictEqual(eersteRegel('\n\n**Kort:** zie [p. 3](/nza#stuk=x&plek=3)'), 'Kort: zie p. 3');
});

test('nieuw antwoord = nieuwe draad (0700/0600), bronnen, niet_in_dossier; mislukte eerste vraag = geen draad', async () => {
  const map = nieuwMap();
  const m = maak({ map, leesAppLog: async () => [] });
  const id = await m.naAntwoord({ job_id: J(1), soort: 'bericht', tekst: 'Proefvraag één?', getypt: '2026-11-15T10:00:00Z', t: '2026-11-15T10:02:00Z', antwoord: ANTW, ok: true });
  assert.strictEqual(id, 'd-' + J(1));
  assert.strictEqual(fs.statSync(map).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(map, id + '.json')).mode & 0o777, 0o600);
  const d = (await m.draad(id)).draad;
  assert.strictEqual(d.wisselingen.length, 1);
  assert.strictEqual(d.wisselingen[0].bronnen.length, 2);
  assert.strictEqual(d.wisselingen[0].niet_in_dossier, false);
  assert.deepStrictEqual(d.wisselingen[0].aanhangsels, []);
  const id2 = await m.naAntwoord({ job_id: J(2), soort: 'bericht', tekst: 'x', antwoord: 'Niet in het dossier. Wel: …', ok: true, t: '2026-11-15T11:00:00Z' });
  assert.strictEqual((await m.draad(id2)).draad.wisselingen[0].niet_in_dossier, true);
  assert.strictEqual(await m.naAntwoord({ job_id: J(3), soort: 'bericht', tekst: 'x', antwoord: '', ok: false, fout: 'kapot' }), null);
  assert.strictEqual(await m.naAntwoord({ job_id: J(4), soort: 'knop', tekst: 'x', antwoord: 'y', ok: true }), null);
  assert.strictEqual(await m.naAntwoord({ job_id: 'GEEN-ID', tekst: 'x', antwoord: 'y' }), null);
  assert.strictEqual(m.info().draden, 2);
});

test('doorvraag komt in dezelfde draad (ook een mislukte, met fout); context bevat beide; onbekende draad = eigen draad', async () => {
  const m = maak({ map: nieuwMap(), leesAppLog: async () => [] });
  const id = await m.naAntwoord({ job_id: J(10), tekst: 'Eerste proefvraag', getypt: '2026-11-15T10:00:00Z', t: '2026-11-15T10:01:00Z', antwoord: 'Antwoord EEN', ok: true });
  assert.strictEqual(await m.naAntwoord({ job_id: J(11), tekst: 'Vervolg', getypt: '2026-11-15T10:05:00Z', t: '2026-11-15T10:06:00Z', antwoord: 'Antwoord TWEE', ok: true, draad: id }), id);
  assert.strictEqual(await m.naAntwoord({ job_id: J(12), tekst: 'Vervolg 2', getypt: '2026-11-15T10:07:00Z', t: '2026-11-15T10:08:00Z', antwoord: '', ok: false, fout: 'limiet', draad: id }), id);
  const d = (await m.draad(id)).draad;
  assert.deepStrictEqual(d.wisselingen.map((w) => w.job_id), [J(10), J(11), J(12)]);
  assert.strictEqual(d.wisselingen[2].ok, false);
  assert.strictEqual(d.wisselingen[2].fout, 'limiet');
  const c = m.context(id);
  assert.ok(c.tekst.includes('Eerste proefvraag') && c.tekst.includes('Antwoord EEN') && c.tekst.includes('Antwoord TWEE'));
  assert.ok(!c.tekst.includes('Vervolg 2'), 'een mislukte wisseling gaat niet mee als context');
  // zelfde job nog eens = niets dubbel
  await m.naAntwoord({ job_id: J(11), tekst: 'Vervolg', antwoord: 'Antwoord TWEE', ok: true, draad: id });
  assert.strictEqual((await m.draad(id)).draad.wisselingen.length, 3);
  const eigen = await m.naAntwoord({ job_id: J(13), tekst: 'Wees', antwoord: 'A', ok: true, draad: 'd-' + J(99) });
  assert.strictEqual(eigen, 'd-' + J(13));
  assert.strictEqual(m.context('d-' + J(98)), null);
  assert.strictEqual(m.context('../../x'), null);
});

test('inhalen uit het app-log: eerst vragen, dan doorvragen; tweede keer niets; lijst nieuwste boven', async () => {
  const log = [
    { t: '2026-11-15T12:01:00Z', getypt: '2026-11-15T12:00:00Z', job_id: J(21), soort: 'bericht', tekst: 'Doorvraag', antwoord: 'B2', ok: true, draad: 'd-' + J(20) },
    { t: '2026-11-15T11:01:00Z', getypt: '2026-11-15T11:00:00Z', job_id: J(20), soort: 'bericht', tekst: 'Oude vraag', antwoord: '**Kern:** B1', ok: true },
    { t: '2026-11-15T13:01:00Z', getypt: '2026-11-15T13:00:00Z', job_id: J(22), soort: 'bericht', tekst: 'Nieuwste vraag', antwoord: 'C1', ok: true },
    { t: '2026-11-15T09:01:00Z', job_id: J(23), soort: 'bericht', tekst: 'Mislukt', antwoord: 'x', ok: false },
    { t: '2026-11-15T09:02:00Z', job_id: J(24), soort: 'knop', tekst: 'Ja', antwoord: 'x', ok: true },
  ];
  const m = maak({ map: nieuwMap(), leesAppLog: async () => log });
  const l = await m.lijst();
  assert.deepStrictEqual(l.map((x) => x.vraag), ['Nieuwste vraag', 'Oude vraag']);
  assert.strictEqual(l[1].wisselingen, 2);
  assert.strictEqual(l[1].eerste_regel, 'B2');
  assert.strictEqual(await m.inhalen(), 0, 'tweede keer niets nieuws');
  const kapot = maak({ map: nieuwMap(), leesAppLog: async () => { throw new Error('weg'); } });
  assert.deepStrictEqual(await kapot.lijst(), []);
});

test('twee antwoorden tegelijk in één draad: allebei bewaard', async () => {
  const m = maak({ map: nieuwMap(), leesAppLog: async () => [] });
  const id = await m.naAntwoord({ job_id: J(30), tekst: 'v', antwoord: 'a', ok: true, t: '2026-11-15T10:00:00Z' });
  await Promise.all([31, 32, 33, 34].map((i) => m.naAntwoord({ job_id: J(i), tekst: 'v' + i, antwoord: 'a' + i, ok: true, draad: id, t: '2026-11-15T10:0' + (i - 30) + ':00Z' })));
  assert.strictEqual((await m.draad(id)).draad.wisselingen.length, 5);
});

test('context: lange antwoorden ingekort tot de grens, jongste het volledigst; vol na 30 wisselingen', async () => {
  const m = maak({ map: nieuwMap(), leesAppLog: async () => [] });
  const id = await m.naAntwoord({ job_id: J(40), tekst: 'v0', antwoord: 'O'.repeat(30000), ok: true, t: '2026-11-15T10:00:00Z' });
  await m.naAntwoord({ job_id: J(41), tekst: 'v1', antwoord: 'J'.repeat(30000), ok: true, draad: id, t: '2026-11-15T10:01:00Z' });
  const c = m.context(id);
  assert.ok(c.tekst.length <= 41000, 'lengte ' + c.tekst.length);
  assert.ok(c.tekst.includes('J'.repeat(30000)), 'jongste antwoord heel');
  assert.ok(c.tekst.includes('[… rest van dit antwoord weggelaten]') && c.tekst.includes('O'.repeat(5000)), 'ouder antwoord ingekort, begin blijft');
  for (let i = 2; i < 30; i++) await m.naAntwoord({ job_id: J(40 + i), tekst: 'v' + i, antwoord: 'a', ok: true, draad: id, t: new Date(Date.parse('2026-11-15T10:01:00Z') + i * 60000).toISOString() });
  assert.deepStrictEqual(m.context(id), { vol: true });
  // Codex MOET 1: een al geaccepteerde doorvraag boven de 30 gaat niet verloren
  assert.strictEqual(await m.naAntwoord({ job_id: J(80), tekst: 'nog één', antwoord: 'a', ok: true, draad: id }), id);
  assert.strictEqual((await m.draad(id)).draad.wisselingen.length, 31);
  for (let i = 31; i < 60; i++) await m.naAntwoord({ job_id: J(100 + i), tekst: 'v' + i, antwoord: 'a', ok: true, draad: id });
  assert.strictEqual((await m.draad(id)).draad.wisselingen.length, 60);
  assert.strictEqual(await m.naAntwoord({ job_id: J(200), tekst: 'boven het vangnet', antwoord: 'a', ok: true, draad: id }), 'd-' + J(200), 'eigen draad, niet weg');
});

test('context: lange vragen tellen mee in de grens (Codex ZOU 1); jongste wisseling altijd mee', async () => {
  const m = maak({ map: nieuwMap(), leesAppLog: async () => [] });
  const id = await m.naAntwoord({ job_id: J(300), tekst: 'Q'.repeat(8000), antwoord: 'EERSTE', ok: true, t: '2026-11-15T10:00:00Z' });
  for (let i = 1; i < 12; i++) await m.naAntwoord({ job_id: J(300 + i), tekst: 'Q'.repeat(8000), antwoord: 'A' + i + 'x'.repeat(3000), ok: true, draad: id, t: new Date(Date.parse('2026-11-15T10:00:00Z') + i * 60000).toISOString() });
  const c = m.context(id);
  assert.ok(c.tekst.length <= 40500, 'lengte ' + c.tekst.length);
  assert.ok(c.tekst.includes('A11' + 'x'.repeat(3000)), 'jongste antwoord heel');
  assert.ok(!c.tekst.includes('Q'.repeat(2001)), 'vraag ingekort');
  assert.ok(/eerdere vraag\/vragen weggelaten/.test(c.tekst), 'oudste weggelaten met een regel');
  // één reusachtig antwoord: toch begrensd, begin blijft
  const m2 = maak({ map: nieuwMap(), leesAppLog: async () => [] });
  const id2 = await m2.naAntwoord({ job_id: J(400), tekst: 'v', antwoord: 'B'.repeat(59000), ok: true });
  const c2 = m2.context(id2);
  assert.ok(c2.tekst.length <= 40500 && c2.tekst.includes('B'.repeat(1000)), 'lengte ' + c2.tekst.length);
});

test('log van de agent: precies één regel in het tijdvak = bronnen en niet_in_dossier erbij (UTC of Nederlandse tijd)', async () => {
  const nzaLog = [
    { t: '2026-11-15 11:01', vraag: 'proef', bronnen: ['proef-tb-2026 p. 3'], niet_in_dossier: true },   // 11:01 NL = 10:01 UTC
    { t: '2026-11-15 18:00', vraag: 'ander', bronnen: [], niet_in_dossier: false },
  ];
  const m = maak({ map: nieuwMap(), leesAppLog: async () => [], leesNzaLog: () => nzaLog });
  const id = await m.naAntwoord({ job_id: J(50), tekst: 'v', getypt: '2026-11-15T10:00:00Z', t: '2026-11-15T10:03:00Z', antwoord: 'antwoord', ok: true });
  const w = (await m.draad(id)).draad.wisselingen[0];
  assert.deepStrictEqual(w.log, { bronnen: ['proef-tb-2026 p. 3'], niet_in_dossier: true });
  assert.strictEqual(w.niet_in_dossier, true);
  const id2 = await m.naAntwoord({ job_id: J(51), tekst: 'v', getypt: '2026-11-15T15:00:00Z', t: '2026-11-15T15:03:00Z', antwoord: 'a', ok: true });
  assert.strictEqual((await m.draad(id2)).draad.wisselingen[0].log, undefined, 'geen regel in het tijdvak');
});

test('markdown: vraag, antwoord, doorvraag, aanhangsel, absolute links alleen met een https-basis', async () => {
  const m = maak({ map: nieuwMap(), leesAppLog: async () => [] });
  const id = await m.naAntwoord({ job_id: J(60), tekst: 'Wat zegt de proefbeschikking?', getypt: '2026-11-15T10:00:00Z', t: '2026-11-15T10:01:00Z', antwoord: ANTW, ok: true });
  await m.naAntwoord({ job_id: J(61), tekst: 'En de rechter?', antwoord: 'Zie [r.o. 4.2](/nza#stuk=proef-cbb-1&plek=4.2).', ok: true, draad: id, t: '2026-11-15T10:05:00Z' });
  assert.strictEqual(await m.zetAanhangsel(id, J(60), { soort: 'dubbelcheck', model: 'proefmodel', md: '| bewering | oordeel |\n|---|---|\n| x | klopt |' }), true);
  assert.strictEqual(await m.zetAanhangsel(id, J(99), { soort: 'dubbelcheck', md: 'x' }), false);
  assert.strictEqual(await m.zetAanhangsel('../x', J(60), { md: 'x' }), false);
  const d = (await m.draad(id)).draad;
  const md = m.markdown(d, 'https://app.voorbeeld.test');
  assert.ok(md.startsWith('# OVIS NZa — Wat zegt de proefbeschikking?'));
  assert.ok(md.includes('## Doorvraag 1'));
  assert.ok(md.includes('> En de rechter?'));
  assert.ok(md.includes('### Dubbelcheck') && md.includes('proefmodel') && md.includes('| x | klopt |'));
  assert.ok(md.includes('](https://app.voorbeeld.test/nza#stuk=proef-tb-2026&plek=3)'));
  assert.ok(!/\]\(\/nza#/.test(md), 'alle /nza-links absoluut');
  const kaal = m.markdown(d, 'javascript:alert(1)');
  assert.ok(kaal.includes('](/nza#stuk=proef-tb-2026&plek=3)'), 'onveilige basis = relatieve links');
  assert.strictEqual((await m.lijst())[0].aanhangsels, 1);
});

test('wv3157 zetCheck: bezig/fout bij één wisseling, weg met null; aanhangsel ernaast; onbekend = false', async () => {
  const m = maak({ map: nieuwMap(), leesAppLog: async () => [] });
  const id = await m.naAntwoord({ job_id: J(40), tekst: 'Proefvraag check', t: '2026-11-15T12:00:00Z', antwoord: 'Antwoord met [p. 1](/nza#stuk=proef-1&plek=1)', ok: true });
  assert.strictEqual(await m.zetCheck(id, J(40), { status: 'bezig', start: '2026-11-15T12:01:00Z', model: 'Fable 5.2', job: J(41), fout: 'x' }), true);
  let w = m.wisseling(id, J(40));
  assert.deepStrictEqual(w.dubbelcheck, { status: 'bezig', start: '2026-11-15T12:01:00Z', model: 'Fable 5.2', job: J(41), fout: 'x' });
  assert.strictEqual(await m.zetAanhangsel(id, J(40), { soort: 'dubbelcheck', titel: 'Dubbelcheck', model: 'Fable 5.2', md: '**1 bewering nagelopen**' }), true);
  assert.strictEqual(await m.zetCheck(id, J(40), null), true);
  w = m.wisseling(id, J(40));
  assert.strictEqual(w.dubbelcheck, undefined);
  assert.strictEqual(w.aanhangsels.length, 1);
  assert.match(m.markdown((await m.draad(id)).draad), /### Dubbelcheck · .* · Fable 5\.2\n\n\*\*1 bewering nagelopen\*\*/);
  assert.strictEqual(await m.zetCheck(id, J(99), { status: 'bezig' }), false);
  assert.strictEqual(await m.zetCheck('d-kapot', J(40), { status: 'bezig' }), false);
  assert.strictEqual(m.wisseling(id, J(99)), null);
  await m.zetCheck(id, J(40), { status: 'raar', fout: 'mislukt' });
  assert.strictEqual(m.wisseling(id, J(40)).dubbelcheck.status, 'fout');
});
