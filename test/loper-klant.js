#!/usr/bin/env node
// loper-klant.js — toetsklant voor de socev-loper (wv699). Gebruik:
//   node loper-klant.js <socket> '<json-verzoek of array van verzoeken>' [--tot-einde <job-id>] [--wacht-ms N]
// Stuurt de verzoeken één voor één (wacht telkens op het antwoord met hetzelfde nr) en schrijft één JSON-object naar stdout:
//   {antwoorden: [...], uit: "<stdout van de job>", fout: "<stderr>", einde: {code, signaal} | null, verbindfout: code | null}
'use strict';
const net = require('net');
const [sockPad, verzoekJson] = process.argv.slice(2);
const totEinde = (function () { const i = process.argv.indexOf('--tot-einde'); return i > 0 ? process.argv[i + 1] : null; })();
const wachtMs = (function () { const i = process.argv.indexOf('--wacht-ms'); return i > 0 ? Number(process.argv[i + 1]) : 20000; })();
let verzoeken = JSON.parse(verzoekJson);
if (!Array.isArray(verzoeken)) verzoeken = [verzoeken];
const uitkomst = { antwoorden: [], uit: '', fout: '', einde: null, verbindfout: null };
let klaar = false;
function af() {
  if (klaar) return; klaar = true;
  process.stdout.write(JSON.stringify(uitkomst) + '\n');
  process.exit(0);
}
setTimeout(af, wachtMs);
const s = net.connect(sockPad);
s.on('error', function (e) { uitkomst.verbindfout = e.code || String(e); af(); });
let rest = '', nr = 0, wachtOp = null;
function volgende() {
  if (!verzoeken.length) { if (!totEinde || uitkomst.einde) af(); return; }
  const v = verzoeken.shift();
  v.nr = ++nr; wachtOp = v.nr;
  s.write(JSON.stringify(v) + '\n');
}
s.on('connect', volgende);
s.setEncoding('utf8');
s.on('data', function (d) {
  rest += d;
  let i;
  while ((i = rest.indexOf('\n')) >= 0) {
    const r = JSON.parse(rest.slice(0, i)); rest = rest.slice(i + 1);
    if (r.ev) {
      if (totEinde && r.id === totEinde) {
        if (r.ev === 'uit') uitkomst.uit += Buffer.from(r.b64, 'base64').toString();
        if (r.ev === 'fout') uitkomst.fout += Buffer.from(r.b64, 'base64').toString();
        if (r.ev === 'einde') { uitkomst.einde = { code: r.code, signaal: r.signaal }; if (!verzoeken.length && wachtOp === null) af(); }
      }
      continue;
    }
    uitkomst.antwoorden.push(r);
    if (r.nr === wachtOp) { wachtOp = null; volgende(); }
  }
});
s.on('close', af);
