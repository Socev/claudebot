// wv4243 (C17 deel 4, review verzenden § 7): de pod keurt AI - Facturen-verzender alleen goed als het concept gelijk is aan de
// gepubliceerde versie en de hele gepubliceerde versie (knopen + verbindingen) de verwachte hash heeft. Verzonnen workflow, geen n8n.
// Gebruik: node --test test/verzender-gepubliceerd.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const a = src.indexOf('function potVzToetsenMag('), b = src.indexOf('// { bron, modus, ref, aan, cc, onderwerp, bericht, van, bijlage');
assert.ok(a > 0 && b > a, 'knipsel potVzToetsenMag..potVzVerzenderOk gevonden');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const GEHEIM_SHA = /const POT_VZ_GEHEIM_SHA = '([0-9a-f]{64})'/.exec(src)[1];

const TOETS = '// verzonnen toetsen-code\nreturn [];', MERK = '// verzonnen merk\nreturn $input.all();';
function wf() {
  const nodes = [
    { id: 'a1', name: 'Webhook facturen-verzender', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [0, 0], webhookId: 'wh-1', parameters: { path: 'proef-verzender', httpMethod: 'POST' } },
    { id: 'a2', name: 'Verzendgeheim?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [200, 0], parameters: { conditions: { combinator: 'and', conditions: [{ leftValue: '={{ $json.x }}', rightValue: GEHEIM_SHA, operator: { type: 'string', operation: 'equals' } }] } } },
    { id: 'a3', name: 'Merk verzendgeheim', type: 'n8n-nodes-base.code', typeVersion: 2, position: [400, 0], parameters: { jsCode: MERK } },
    { id: 'a4', name: 'Toetsen', type: 'n8n-nodes-base.code', typeVersion: 2, position: [600, 0], parameters: { jsCode: TOETS } },
    { id: 'a5', name: 'Gmail concept (pot)', type: 'n8n-nodes-base.gmail', typeVersion: 2.2, position: [800, 0], webhookId: 'wh-2', onError: 'continueErrorOutput', credentials: { gmailOAuth2: { id: 'cred1', name: 'Gmail proef' } }, parameters: { sendTo: '={{ $json.aan }}', resource: 'draft' } },
    { id: 'a6', name: 'Notitie', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, -200], parameters: { content: 'uitleg' } },
  ];
  const connections = { 'Webhook facturen-verzender': { main: [[{ node: 'Verzendgeheim?', type: 'main', index: 0 }]] }, 'Verzendgeheim?': { main: [[{ node: 'Merk verzendgeheim', type: 'main', index: 0 }], []] },
    'Merk verzendgeheim': { main: [[{ node: 'Toetsen', type: 'main', index: 0 }]] }, Toetsen: { main: [[{ node: 'Gmail concept (pot)', type: 'main', index: 0 }]] } };
  return { id: 'Proef1234567890a', active: true, versionId: 'v-9', activeVersionId: 'v-9', nodes: JSON.parse(JSON.stringify(nodes)), connections: JSON.parse(JSON.stringify(connections)),
    activeVersion: { versionId: 'v-9', nodes, connections } };
}
// de hash van de verzonnen workflow, met dezelfde functie als de pod
const hashFn = new Function('crypto', src.slice(src.indexOf('function potVzWfHash('), src.indexOf('\n}\n', src.indexOf('function potVzWfHash(')) + 3) + 'return potVzWfHash;')(crypto);
const WF_SHA = hashFn(wf().activeVersion.nodes, wf().activeVersion.connections);

function laad(antwoord) {
  const env = { POT_VZ_MERK_SHA_TOETS: sha(MERK), POT_VZ_WF_SHA_TOETS: WF_SHA };
  return new Function('POT_VZ_TOETSEN_SHA', 'appN8n', 'FACTUREN_VERZENDER_WF', 'crypto', 'process', src.slice(a, b) + 'return potVzVerzenderOk;')(
    sha(TOETS), async () => { if (antwoord instanceof Error) throw antwoord; return antwoord; }, 'Proef1234567890a', crypto, { env });
}
const BRONNEN = ['pot', true, 'boekstuk', 'sepa', 'facturen', 'nogbetalen', 'nogbetalen_herinnering'];
async function oordeel(w) { const f = laad(w); return Promise.all(BRONNEN.map((x) => f(x))); }
const alle = (v) => BRONNEN.map(() => v);

test('gepubliceerd = concept en de hash klopt → in orde voor elke bron', async () => {
  assert.deepEqual(await oordeel(wf()), alle(true));
});
test('concept ≠ gepubliceerd → niet in orde (ook als het concept zelf goed is)', async () => {
  const w = wf(); w.versionId = 'v-10';
  assert.deepEqual(await oordeel(w), alle(false));
});
test('gepubliceerde versie gewijzigd, concept teruggezet op de oude code → niet in orde (de pod kijkt naar activeVersion)', async () => {
  const w = wf(); w.activeVersion.nodes.find((n) => n.name === 'Toetsen').parameters.jsCode = '// gewijzigd\nreturn [];';
  assert.deepEqual(await oordeel(w), alle(false));
});
test('geen gepubliceerde versie te zien → niet in orde', async () => {
  for (const zet of [(w) => { delete w.activeVersion; }, (w) => { w.activeVersionId = null; w.versionId = null; }, (w) => { w.activeVersion.versionId = 'v-8'; }, (w) => { w.activeVersion.connections = null; }]) {
    const w = wf(); zet(w);
    assert.deepEqual(await oordeel(w), alle(false));
  }
});
test('een gewijzigde verbinding in de gepubliceerde versie → hash wijkt af', async () => {
  const w = wf(); w.activeVersion.connections.Toetsen.main[0].push({ node: 'Webhook facturen-verzender', type: 'main', index: 0 });
  assert.deepEqual(await oordeel(w), alle(false));
});
test('een gewijzigde sendTo, onError, credential-id of uitgezette knoop → hash wijkt af', async () => {
  for (const zet of [(g) => { g.parameters.sendTo = 'iemand@voorbeeld.nl'; }, (g) => { g.onError = 'continueRegularOutput'; }, (g) => { g.credentials.gmailOAuth2.id = 'cred2'; }, (g) => { g.disabled = true; }]) {
    const w = wf(); zet(w.activeVersion.nodes.find((n) => n.name === 'Gmail concept (pot)'));
    assert.deepEqual(await oordeel(w), alle(false));
  }
});
test('positie, knoop-id, webhookId, credentialnaam, notitie en volgorde wisselen → nog in orde', async () => {
  const w = wf();
  w.activeVersion.nodes.forEach((n) => { n.position = [n.position[0] + 13, 7]; n.id = 'x-' + n.id; if (n.webhookId) n.webhookId = 'nieuw-' + n.webhookId; });
  w.activeVersion.nodes.find((n) => n.name === 'Gmail concept (pot)').credentials.gmailOAuth2.name = 'Gmail hernoemd';
  w.activeVersion.nodes.find((n) => n.name === 'Notitie').parameters.content = 'andere uitleg';
  w.activeVersion.nodes.reverse();
  assert.deepEqual(await oordeel(w), alle(true));
});
test('workflow uit → niet in orde; niet te lezen → fout (volgende tik opnieuw)', async () => {
  const w = wf(); w.active = false;
  assert.deepEqual(await oordeel(w), alle(false));
  await assert.rejects(laad(new Error('n8n weg'))('pot'));
  await assert.rejects(laad({ id: 'x' })('pot'), /niet te lezen/);
});
test('Toetsen, Merk of geheim-IF anders dan verwacht → niet in orde, ook met kloppende hash', async () => {
  const w = wf(); w.activeVersion.nodes.find((n) => n.name === 'Verzendgeheim?').parameters.conditions.conditions[0].rightValue = '0'.repeat(64);
  const env = { POT_VZ_MERK_SHA_TOETS: sha(MERK), POT_VZ_WF_SHA_TOETS: hashFn(w.activeVersion.nodes, w.activeVersion.connections) };
  const f = new Function('POT_VZ_TOETSEN_SHA', 'appN8n', 'FACTUREN_VERZENDER_WF', 'crypto', 'process', src.slice(a, b) + 'return potVzVerzenderOk;')(sha(TOETS), async () => w, 'P', crypto, { env });
  assert.equal(await f('pot'), false);
});
test('server.js: de verwachte hash is ingevuld (64 hex) en /health toont hem', () => {
  assert.match(src, /const POT_VZ_WF_SHA = process\.env\.POT_VZ_WF_SHA_TOETS \|\| '[0-9a-f]{64}';/);
  assert.match(src, /wf_sha: POT_VZ_WF_SHA\.slice\(0, 12\)/);
});
