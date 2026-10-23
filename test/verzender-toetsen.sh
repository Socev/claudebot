#!/usr/bin/env bash
# Toetst de Code-knoop Toetsen van n8n "AI - Facturen-verzender" (tools/n8n/facturen-verzender-toetsen.js; wv921 bron pot + eigen
# verzendgeheim). Draait de code zoals n8n hem draait ($input, this.helpers, $getWorkflowStaticData) met nep-bestanden. Toetst ook dat
# POT_VZ_TOETSEN_SHA in server.js de sha256 van precies dit bestand is (de pod vergelijkt die vóór elke batch met de gepubliceerde code).
# Gebruik: bash test/verzender-toetsen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), crypto = require('crypto');
const code = fs.readFileSync('tools/n8n/facturen-verzender-toetsen.js', 'utf8');
let goed = 0, fout = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const OUD = 'oud-geheim-mailconcept', NIEUW = 'nieuw-verzendgeheim';
const PDF = Buffer.from('%PDF-1.3\n...\n%%EOF');
async function draai(body, files, o) {
  o = o || {};
  const src = (o.code || code).replace('const nu = Date.now();', `const nu = ${o.nu || Date.parse('2026-11-02T08:30:00Z')};`).replace("const VERSTUREN_GEHEIM_SHA = '675ccb2c6d979175f015301fb6b6614ccc2952f5f2f7a855a0262fd7b84019c9'", `const VERSTUREN_GEHEIM_SHA = '${crypto.createHash('sha256').update(NIEUW).digest('hex')}'`);
  const binary = {};
  (files || []).forEach((f, i) => { binary['b' + i] = { fileName: f.naam, data: 'x' }; });
  const item = { json: { body }, binary: files && files.length ? binary : undefined };
  const sd = o.sd || {};
  const f = new Function('$input', '$getWorkflowStaticData', 'require', `return (async function () {\n${src}\n}).call(this);`);
  const ctx = { helpers: { getBinaryDataBuffer: async (i, k) => files[Number(k.slice(1))].bytes } };
  const uit = await f.call(ctx, { first: () => item }, () => sd, require);
  return uit[0];
}
const pot = (x) => Object.assign({ secret: NIEUW, bron: 'pot', modus: 'versturen', ref: 'POT12', aan: 'praktijkmanager@huisartskortegeer.nl', onderwerp: 'Factuur SLOEL - Correctie doorbelaste huur 2026', bericht: 'Hallo allen,\n\nBij deze ...', van: '"David Schaap" <dokterschaap@gmail.com>' }, x);
const een = [{ naam: 'SLOEL - 2026033 - Huisartsenpraktijk Korte Geer.pdf', bytes: PDF }];
(async () => {
  let r = await draai(pot(), een);
  toets('pot + eigen geheim + adres op de lijst → in orde, pad pot, één bijlage', r.json.toets.fout === null && r.json.toets.pad === 'pot' && r.json.toets.aantal === 1 && r.binary.bijlage_0.mimeType === 'application/pdf' && r.json.van === '"David Schaap" <dokterschaap@gmail.com>', r.json);
  toets('het geheim gaat niet verder de workflow in', !JSON.stringify(r.json).includes(NIEUW));
  r = await draai(pot({ secret: OUD }), een);
  toets('oud geheim + versturen (pot) → 401', r.json.toets.status === 401 && r.json.toets.code === 'secret' && !r.binary, r.json.toets);
  r = await draai({ secret: OUD, modus: 'versturen', aan: 'd.schaap+facturentest@gmail.com', token: 'FV0123456789abcdef', onderwerp: 'x [ref FV0123456789abcdef]', bericht: 'b' }, een);
  toets('oud geheim + versturen (facturen) → 401', r.json.toets.status === 401, r.json.toets);
  r = await draai({ secret: NIEUW, modus: 'concept', aan: 'd.schaap+facturentest@gmail.com', token: 'FV0123456789abcdef', onderwerp: 'x [ref FV0123456789abcdef]', bericht: 'b' }, een);
  toets('eigen geheim voor iets anders dan pot-versturen → 403', r.json.toets.status === 403 && r.json.toets.code === 'secret', r.json.toets);
  r = await draai(pot({ aan: 'iemand@anders.example' }), een);
  toets('pot: adres buiten de lijst → 403', r.json.toets.status === 403 && r.json.toets.code === 'witte_lijst', r.json.toets);
  r = await draai(pot({ cc: 'iemand@anders.example' }), een);
  toets('pot: cc buiten de lijst → 403 (Fable #9)', r.json.toets.status === 403 && r.json.toets.code === 'witte_lijst', r.json.toets);
  r = await draai(pot({ cc: 'facturen@hapleusden.nl' }), een);
  toets('pot: cc binnen de lijst → in orde', r.json.toets.fout === null && r.json.cc === 'facturen@hapleusden.nl', r.json.toets);
  r = await draai(pot(), [een[0], { naam: 'tweede.pdf', bytes: PDF }]);
  toets('pot: twee bijlagen → 400', r.json.toets.status === 400 && r.json.toets.code === 'bijlagen', r.json.toets);
  r = await draai(pot(), [{ naam: 'x.xml', bytes: Buffer.from('<a/>') }]);
  toets('pot: geen PDF → 400', r.json.toets.status === 400, r.json.toets);
  r = await draai(pot(), [{ naam: 'x.pdf', bytes: Buffer.from('MZ....') }]);
  toets('pot: .pdf zonder %PDF → 400', r.json.toets.status === 400, r.json.toets);
  r = await draai(pot({ van: 'iemand@anders.example' }), een);
  toets('pot: andere afzender → 400', r.json.toets.status === 400 && r.json.toets.code === 'van', r.json.toets);
  r = await draai(pot({ bcc: 'x@y.example' }), een);
  toets('pot: bcc → 400', r.json.toets.status === 400, r.json.toets);
  r = await draai(pot({ ref: 'FV0123' }), een);
  toets('pot: ongeldige ref → 400', r.json.toets.status === 400 && r.json.toets.code === 'ref', r.json.toets);
  r = await draai(pot({ onderwerp: 'a\nBcc: x@y.example' }), een);
  toets('pot: regeleinde in het onderwerp → 400', r.json.toets.status === 400, r.json.toets);
  r = await draai(pot(), een, { code: code.replace('const VERSTUREN_POT = true;', 'const VERSTUREN_POT = false;') });
  toets('pot: VERSTUREN_POT uit → 409', r.json.toets.status === 409 && r.json.toets.code === 'versturen_uit', r.json.toets);
  const T = Date.parse('2026-11-02T08:30:00Z');
  r = await draai(pot(), een, { sd: { pot: Array.from({ length: 24 }, () => T - 1000) } });
  toets('pot: plafond 24 per 24 uur → 429', r.json.toets.status === 429, r.json.toets);
  r = await draai(pot(), een, { sd: { pot: Array.from({ length: 24 }, () => T - 90000000), gemaakt: Array.from({ length: 30 }, () => T) } });
  toets('pot: oude verzendingen tellen niet; plafond per bron (facturen-teller raakt pot niet)', r.json.toets.fout === null, r.json.toets);
  for (const [nu, wat] of [['2026-11-02T07:59:00Z', 'ma 08:59'], ['2026-11-02T11:00:00Z', 'ma 12:00'], ['2026-10-31T09:00:00Z', 'zaterdag'], ['2026-12-25T09:00:00Z', '1e Kerstdag'], ['2026-04-06T08:00:00Z', '2e Paasdag']]) {
    r = await draai(pot(), een, { nu: Date.parse(nu) });
    toets('pot buiten het venster (' + wat + ') → 409 buiten_venster', r.json.toets.status === 409 && r.json.toets.code === 'buiten_venster', r.json.toets);
  }
  r = await draai(pot(), een, { nu: Date.parse('2026-10-23T09:59:00Z') });
  toets('pot binnen het venster in de zomertijd (vr 11:59) → in orde', r.json.toets.fout === null, r.json.toets);
  r = await draai({ secret: OUD, modus: 'concept', aan: 'd.schaap+facturentest@gmail.com', token: 'FV0123456789abcdef', onderwerp: 'x [ref FV0123456789abcdef]', bericht: 'b' }, een, { nu: Date.parse('2026-10-31T22:00:00Z') });
  toets('facturen ongewijzigd: concept met oud geheim aan de testalias → in orde, pad facturen', r.json.toets.fout === null && r.json.toets.pad === 'facturen', r.json.toets);
  r = await draai({ secret: OUD, modus: 'concept', aan: 'praktijkmanager@huisartskortegeer.nl', token: 'FV0123456789abcdef', onderwerp: 'x [ref FV0123456789abcdef]', bericht: 'b' }, een);
  toets('facturen kan niet naar een praktijkadres (lijsten per bron)', r.json.toets.status === 403, r.json.toets);
  r = await draai({ secret: OUD, bron: 'pot', modus: 'concept', aan: 'praktijkmanager@huisartskortegeer.nl', ref: 'POT1', onderwerp: 'x', bericht: 'b', van: '"David Schaap" <dokterschaap@gmail.com>' }, een);
  toets('pot met concept en oud geheim → 400, geen pad pot (pot kent alleen versturen)', r.json.toets.status === 400 && r.json.toets.pad !== 'pot' && !r.binary, r.json.toets);
  r = await draai(Object.assign(pot({ modus: 'concept' })), een);
  toets('pot met concept en eigen geheim → geweigerd', r.json.toets.fout !== null && r.json.toets.pad !== 'pot', r.json.toets);
  const sj = fs.readFileSync('server.js', 'utf8');
  const m = /const POT_VZ_TOETSEN_SHA = process\.env\.POT_VZ_TOETSEN_SHA_TOETS \|\| '([0-9a-f]{64})'/.exec(sj);
  toets('POT_VZ_TOETSEN_SHA in server.js = sha256 van dit bestand', m && m[1] === crypto.createHash('sha256').update(code).digest('hex'), m && m[1]);
  console.log(`\n${goed} groen, ${fout} rood`);
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
