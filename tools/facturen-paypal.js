#!/usr/bin/env node
/*
 * facturen-paypal.js — PayPal zakelijk als bron in de Facturen-database (wv2056, 30-10-2026; modules facturen-paypal.js en
 * paypal-zakelijk-lezer.js, migratie 14). Draait op de pod (Olares, primaire kant) als 'claude', tegen /opt/data/facturen (of FACTUREN_DIR),
 * vanuit de machinekamer. De vaste ronde loopt vanzelf na de bank-ronde (server.js facturenPaypalRonde); dit is voor historie en nazien.
 *
 *   node tools/facturen-paypal.js rechten                  scopes van de sleutel: app_id, leesrecht, uitbetalen (één POST op het token)
 *   node tools/facturen-paypal.js inlezen [--van JJJJ-MM-DD] [--droog]   ophalen (zonder --van: zoals de ronde) + opslaan + koppelen
 *   node tools/facturen-paypal.js koppel [--droog]          bankposten, leveranciers en facturen (opnieuw) koppelen
 *   node tools/facturen-paypal.js stand                     aantallen, periode, laatste ronde, aansluiting per entiteit
 *   node tools/facturen-paypal.js aansluiting [--maand JJJJ-MM] [--entiteit …]   per "PayPal Europe"-post op de bank
 *   node tools/facturen-paypal.js betalingen [--tekst …] [--sinds JJJJ-MM-DD]
 *
 * De sleutel komt op het moment van gebruik uit de kluis (Management-API, SUPABASE_URL + SUPABASE_MCP_TOKEN) en gaat alleen naar
 * paypal-zakelijk-lezer.js; nooit in een uitvoer of log. Weigert te schrijven als de database een ander schema heeft dan deze code.
 */
'use strict';
const path = require('path');
const D = require(path.join(__dirname, '..', 'facturen-db.js'));
const P = require(path.join(__dirname, '..', 'facturen-paypal.js'));
const L = require(path.join(__dirname, '..', 'paypal-zakelijk-lezer.js'));

const DIR = process.env.FACTUREN_DIR || '/opt/data/facturen';
const WIE = 'machinekamer';

function openGoed(schrijven) {
  if (String(process.env.SOCEV_KANT || 'olares') !== 'olares') throw new Error('alleen op de Olares-kant (daar staat de facturendatabase)');
  const ro = D.open(DIR, { alleenLezen: true });
  const schema = ro.schema;
  if (!schrijven) return ro;
  D.sluit(ro);
  if (schema < D.SCHEMA_VERSIE && !process.env.FACTUREN_MIGREER) {
    throw new Error('de database heeft schema ' + schema + ', deze code ' + D.SCHEMA_VERSIE + ': de pod draait nog een oudere release. Eerst uitrollen (of FACTUREN_MIGREER=1 op een kopie).');
  }
  return D.open(DIR);
}
async function sleutels() {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(String(process.env.SUPABASE_URL || ''));
  if (!m || !process.env.SUPABASE_MCP_TOKEN) throw new Error('kluistoegang ontbreekt (SUPABASE_URL of SUPABASE_MCP_TOKEN)');
  const r = await fetch('https://api.supabase.com/v1/projects/' + m[1] + '/database/query', { method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.SUPABASE_MCP_TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'socev-facturen-paypal/1' },
    body: JSON.stringify({ query: "select name, decrypted_secret as w from vault.decrypted_secrets where name in ('paypal_zakelijk_client_id', 'paypal_zakelijk_secret')" }),
    signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('kluis gaf HTTP ' + r.status);
  const w = { id: '', geheim: '' };
  for (const x of await r.json()) {
    if (x && x.name === 'paypal_zakelijk_client_id') w.id = String(x.w || '').trim();
    if (x && x.name === 'paypal_zakelijk_secret') w.geheim = String(x.w || '').trim();
  }
  if (!w.id || !w.geheim) throw new Error('geen PayPal-sleutel in de kluis');
  return w;
}

async function hoofd(argv) {
  const vlag = (v) => { const i = argv.indexOf(v); if (i < 0) return false; argv.splice(i, 1); return true; };
  const waarde = (v) => { const i = argv.indexOf(v); if (i < 0) return null; const w = argv[i + 1]; argv.splice(i, 2); return w; };
  const cmd = argv.shift();
  if (cmd === 'rechten') return L.rechten(await sleutels());
  if (cmd === 'inlezen') {
    const droog = vlag('--droog'), van = waarde('--van');
    if (van && !/^\d{4}-\d{2}-\d{2}$/.test(van)) throw new Error('--van JJJJ-MM-DD');
    const fdb = openGoed(!droog);
    try {
      const nu = Date.now();
      const lezing = await L.transacties(await sleutels(), van ? Date.parse(van + 'T00:00:00Z') : P.rondeVan(fdb, nu), nu, { nu });
      const v = P.verwerk(fdb, lezing, { droog, wie: WIE, nu });
      return { app_id: lezing.app_id, vensters: lezing.vensters, paginas: lezing.paginas, ververst: lezing.ververst, opslaan: v.opslaan, koppeling: v.koppeling };
    } finally { D.sluit(fdb); }
  }
  if (cmd === 'koppel') {
    const droog = vlag('--droog');
    const fdb = openGoed(!droog);
    try { return P.koppel(fdb, { droog, wie: WIE, nu: Date.now() }); } finally { D.sluit(fdb); }
  }
  const fdb = openGoed(false);
  try {
    if (cmd === 'stand') return P.stand(fdb);
    if (cmd === 'aansluiting') return P.lees(fdb, { weergave: 'aansluiting', maand: waarde('--maand'), entiteit: waarde('--entiteit'), max: 500 });
    if (cmd === 'betalingen') return P.lees(fdb, { weergave: 'betalingen', tekst: waarde('--tekst'), sinds: waarde('--sinds'), max: 500 });
  } finally { D.sluit(fdb); }
  throw new Error('gebruik: rechten | inlezen | koppel | stand | aansluiting | betalingen (zie de kop van dit bestand)');
}

if (require.main === module) {
  hoofd(process.argv.slice(2)).then((u) => console.log(JSON.stringify(u, null, 1)), (e) => {
    console.error('FOUT ' + (e.code ? e.code + ': ' : '') + (e.uitleg || e.message));
    process.exit(1);
  });
}
module.exports = { hoofd };
