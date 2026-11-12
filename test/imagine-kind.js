'use strict';
// Kindproces voor de herstartproef van test/imagine.test.js (wv2984): start studio.js + imagine.js op dezelfde mappen, laadt een incognito-
// beeld en start een bewerking; de toets doodt dit proces (SIGKILL) terwijl de taak in de nep-ComfyUI loopt.
const fs = require('fs'), path = require('path');
const S = require(path.join(process.env.IK_MOD, 'studio.js')).maak({ dir: path.join(process.env.IK_POD, 'studio'), bewaar: () => null, primair: () => true, sleutel: async () => null,
  routerUrl: 'http://127.0.0.1:1', comfyUrl: process.env.IK_COMFY, flowstudioUrl: 'http://127.0.0.1:1', taalmodelUrl: null,
  log: (r) => fs.appendFileSync(path.join(process.env.IK_POD, 'api.log'), r + '\n'), fout: () => {}, merk: path.join(process.env.IK_POD, 'imagine', 'incognito-merk.json'),
  tempo: { poll: 30, wachtStap: 40, wachtMax: 1500, naloopStart: 0 } });
const I = require(path.join(process.env.IK_MOD, 'imagine.js')).maak({ dir: path.join(process.env.IK_POD, 'imagine'), studio: S, primair: () => true });
(async function () {
  const ctx = { versOk: () => true, versVerbruik: () => {} };
  const r = await I.app({ pad: '/app/imagine/incognito/laad', methode: 'POST', body: { data: fs.readFileSync(process.env.IK_BEELD).toString('base64') }, apparaat: 'apparaat-a', ctx });
  const b = await I.app({ pad: '/app/imagine/incognito/bewerk', methode: 'POST', body: { beeld: r.body.beeld, stand: 'opdracht-qwen', velden: { opdracht: process.env.IK_WOORD }, beurt_id: 'beurt-kind-1' }, apparaat: 'apparaat-a', ctx });
  process.stdout.write('kind: ' + r.status + ' ' + b.status + '\n');
  setInterval(() => {}, 1000);
})();
