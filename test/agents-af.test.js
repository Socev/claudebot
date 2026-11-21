'use strict';
// wv3732 (3C74 + 3C102): agents-af.js — uitkomstzin uit een rapport en "Wat ik vroeg" (groeperen van Davids opdrachten). Verzonnen data.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const A = require(path.join(__dirname, '..', 'agents-af.js'));

test('uitkomst: regel "Uitkomst:" in allerlei vormen', () => {
  assert.deepStrictEqual(A.uitkomstUitRapport('Uitkomst: De knop staat live.\n\nRest'), { zin: 'De knop staat live.', regel: true });
  assert.strictEqual(A.uitkomstUitRapport('**Uitkomst:** Het **scherm** is af.').zin, 'Het scherm is af.');
  assert.strictEqual(A.uitkomstUitRapport('LET OP: tussenstand — x\n- Uitkomst: Half af, rest morgen.').zin, 'Half af, rest morgen.');
  assert.strictEqual(A.uitkomstUitRapport('## Uitkomst: Mislukt: de pod gaf 500.').zin, 'Mislukt: de pod gaf 500.');
  assert.strictEqual(A.uitkomstUitRapport('Uitkomst: ' + 'a'.repeat(400)).zin.length, 240);
  // Codex ZOU 1: voorbeeld in een codeblok telt niet
  assert.deepStrictEqual(A.uitkomstUitRapport('Het proefscherm is af.\n\n```\nUitkomst: voorbeeldregel\n```\n'), { zin: 'Het proefscherm is af.', regel: false });
  assert.strictEqual(A.uitkomstUitRapport('```md\nUitkomst: voorbeeld\n```\nUitkomst: De echte zin.').zin, 'De echte zin.');
});

test('uitkomst: terugval = eerste gewone zin, geen kop/tabel/code/LET OP', () => {
  const t = '## Kop\n| a | b |\n```\ncode\n```\nLET OP: tussenstand — de agent stopte\n\nDe proefknop werkt nu op de telefoon. Daarna meer.\n';
  assert.deepStrictEqual(A.uitkomstUitRapport(t), { zin: 'De proefknop werkt nu op de telefoon.', regel: false });
  assert.strictEqual(A.uitkomstUitRapport('wv9999: klaar. Alles staat live en is getoetst.').zin, 'Alles staat live en is getoetst.');
  assert.strictEqual(A.uitkomstUitRapport('Commit `a1b2c3d4e5` staat live voor de proef-app.').zin, 'Commit staat live voor de proef-app.');
  assert.strictEqual(A.uitkomstUitRapport(''), null);
  assert.strictEqual(A.uitkomstUitRapport('## alleen een kop'), null);
});

test('bron: sleutel, moment en woorden', () => {
  assert.strictEqual(A.bronSleutel('David 21-11 13:21: besluitenpagina nr 136'), 'b:136');
  assert.strictEqual(A.bronSleutel('besluitenpagina nr 136 (21-11-2026)'), 'b:136');
  assert.strictEqual(A.bronSleutel('David 21-11 13:18: besluitenpagina nr 191, 122'), 'b:122,191');
  assert.strictEqual(A.bronSleutel('David app 20-11 09:00 (proefscherm) + besluitenpagina 1/2'), A.bronSleutel('David app 20-11 09:00 (proefscherm) + besluitenpagina 3/4'));
  assert.strictEqual(A.bronSleutel('eigen initiatief (machinekamer, x)'), null);
  assert.strictEqual(A.bronSleutel('David (bron niet opgegeven; gezet 21-11)'), null);
  assert.strictEqual(A.bronMoment('David app 21-11 13:44 + 14:00'), '21-11 13:44');
  assert.strictEqual(A.bronMoment('David 21-11 13:18/13:19: besluitenpagina nr 905'), '21-11 13:18/13:19');
  assert.strictEqual(A.bronWoorden('David app 20-11 10:05 kun je de proeflijst sneller maken'), 'kun je de proeflijst sneller maken');
  assert.strictEqual(A.bronWoorden('David app 21-11 13:24 (Proefscherm native)'), 'Proefscherm native');
  assert.strictEqual(A.bronWoorden('David app-knop 21-11 13:42 (28648686)'), null);
  assert.strictEqual(A.bronWoorden('David 21-11 13:21: besluitenpagina nr 136'), null);
});

const T = (h) => '2026-11-20T' + String(h).padStart(2, '0') + ':00:00Z';
function rij(id, o) { return Object.assign({ id, label: 'machinekamer:proef-' + id, status: 'open', soort: null, herkomst: 'david', ouder_id: null, job_id: null, aangemaakt: T(8), klaar_op: null }, o); }

test('gevraagd: vijf klussen van één opdracht = één regel "3 van 5", stand en uitkomst', () => {
  const bron = 'David app 20-11 08:00 kun je de proeflijst opruimen';
  const items = [
    rij(10, { bron, status: 'klaar', job_id: 'aaaaaaaaaaaaaa10', samenvatting: 'Proeflijst deel 1', klaar_op: T(9) }),
    rij(11, { bron, ouder_id: 10, status: 'klaar', job_id: 'aaaaaaaaaaaaaa11', samenvatting: 'Proeflijst deel 2', klaar_op: T(10), aangemaakt: T(9) }),
    rij(12, { bron, ouder_id: 11, status: 'klaar', job_id: 'aaaaaaaaaaaaaa12', samenvatting: 'Nacontrole proeflijst', soort: 'nacontrole', klaar_op: T(12) }),
    rij(13, { bron, ouder_id: 11, status: 'gestart', samenvatting: 'Proeflijst deel 3' }),
    rij(14, { bron, ouder_id: 11, status: 'open', samenvatting: 'Proeflijst deel 4' }),
    rij(15, { bron, ouder_id: 11, status: 'vervallen', samenvatting: 'Vervallen deel' }),
    rij(20, { bron: 'eigen initiatief (machinekamer)', herkomst: 'eigen', samenvatting: 'Eigen klus' }),
  ];
  const u = { aaaaaaaaaaaaaa10: { zin: 'Deel 1 staat live.' }, aaaaaaaaaaaaaa11: { zin: 'Deel 2 staat live.' }, aaaaaaaaaaaaaa12: { zin: 'Nagemeten: goed.' } };
  const g = A.gevraagd(items, { uitkomstVan: (j) => u[j] || null, rapportVan: (j) => !!u[j] });
  assert.strictEqual(g.length, 1, 'eigen klus telt niet');
  const x = g[0];
  assert.strictEqual(x.woorden, 'kun je de proeflijst opruimen');
  assert.strictEqual(x.moment, '20-11 08:00');
  assert.strictEqual(x.stand, 'loopt');
  assert.strictEqual(x.af, 3); assert.strictEqual(x.totaal, 5);   // vervallen telt niet
  assert.strictEqual(x.uitkomst, 'Deel 2 staat live.', 'nieuwste bouwklus, geen nacontrole');
  assert.strictEqual(x.klussen.length, 6);
  assert.strictEqual(x.klussen.find((k) => k.wv === 10).rapport, true);
});

test('gevraagd: stand-volgorde en losse opdrachten', () => {
  const items = [
    rij(30, { bron: 'David 20-11 09:00: besluitenpagina nr 7', status: 'klaar', job_id: 'bbbbbbbbbbbbbb30', aangemaakt: T(9) }),
    rij(31, { bron: 'David 20-11 09:00: besluitenpagina nr 7', ouder_id: 30, status: 'geblokkeerd', geblokkeerd_door: 'David: proefkaart', aangemaakt: T(10) }),
    rij(32, { bron: 'David 20-11 09:00: besluitenpagina nr 8', status: 'klaar', job_id: 'bbbbbbbbbbbbbb32', aangemaakt: T(11) }),
    rij(33, { bron: 'wv1045 bundelronde', herkomst: 'david', soort: null, status: 'klaar', aangemaakt: T(12) }),
    rij(34, { bron: 'niet opgegeven door de aanmaker', herkomst: 'david', status: 'open', samenvatting: 'Proefklus zonder bron', aangemaakt: T(13) }),
  ];
  const g = A.gevraagd(items, { besluitVraag: (n) => (n === 7 ? 'Wil je een proefknop?' : null) });
  assert.deepStrictEqual(g.map((x) => x.sleutel), ['wv34', 'wv32', 'wv30'], 'nieuwste eerst, bundelronde niet');
  const b7 = g.find((x) => x.sleutel === 'wv30');
  assert.strictEqual(b7.stand, 'wacht_op_jou'); assert.strictEqual(b7.woorden, 'Wil je een proefknop?'); assert.deepStrictEqual(b7.besluit, [7]);
  assert.strictEqual(g.find((x) => x.sleutel === 'wv32').stand, 'af');
  assert.strictEqual(g.find((x) => x.sleutel === 'wv32').woorden, null, 'geen vraag bekend: geen woorden, app toont titel');
  assert.strictEqual(g.find((x) => x.sleutel === 'wv34').titel, 'Proefklus zonder bron');
});

test('server.js: eindregel vraagt de uitkomstregel, /app/agents geeft uitkomst en gevraagd, uitrol neemt de module mee', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = s.indexOf('const AGENT_EINDREGEL'), j = s.indexOf(';', s.indexOf("'Begin je eindrapport", i));
  assert.ok(i > 0 && /Begin je eindrapport met één regel "Uitkomst: …"/.test(s.slice(i, j + 1)), 'eindregel');
  assert.ok(/uitkomst: \(function \(\) \{ const u = appAgentUitkomst\(/.test(s), 'uitkomst per agent');
  assert.ok(/gevraagd: gevraagd, gevraagd_dagen: 3/.test(s), 'gevraagd in /app/agents');
  assert.ok(/\bagents-af\.js\b/.test(fs.readFileSync(path.join(__dirname, '..', 'uitrol.sh'), 'utf8')), 'RELEASE_OPTIONEEL');
});
