#!/usr/bin/env node
/*
 * facturen-creditcard.js — de creditcard (ICS) als bron in de Facturen-database (wv2043, 30-10-2026; module facturen-creditcard.js,
 * migratie 13). Draait op de pod (Olares, primaire kant) als 'claude', tegen /opt/data/facturen (of FACTUREN_DIR), vanuit de machinekamer.
 *
 *   node tools/facturen-creditcard.js kaart-zet --klantnummer <cijfers> --laatste4 <4 cijfers> --rekening <laatste 4 van het IBAN> [--naam …]
 *   node tools/facturen-creditcard.js inlezen [--droog] [--kaart <laatste 4>] [--herkomst "<tekst>"] <ics.csv>
 *   node tools/facturen-creditcard.js koppel [--kaart …]          bankincasso's, leveranciers en facturen (opnieuw) koppelen
 *   node tools/facturen-creditcard.js stand [--kaart …]           aansluiting per rekeningoverzicht (transacties ↔ incasso op de bank)
 *   node tools/facturen-creditcard.js betaalwijze [--zet] [--kaart …]   per leverancier: creditcard (standaard 'betaald') of wisselend
 *   node tools/facturen-creditcard.js regels [--maand JJJJ-MM] [--tekst …] [--kaart …]
 *
 * Een PDF-overzicht van ICS: eerst overzetten naar dezelfde CSV-kolommen (de lezer weigert alles wat afwijkt), dan inlezen; regels die al
 * binnen zijn (zelfde sleutel) worden overgeslagen. Weigert als de database een ander schema heeft dan deze code (eerst uitrollen).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const D = require(path.join(__dirname, '..', 'facturen-db.js'));
const C = require(path.join(__dirname, '..', 'facturen-creditcard.js'));

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
const euro = (c) => c == null ? '—' : (c < 0 ? '-' : '') + '€ ' + (Math.abs(c) / 100).toFixed(2).replace('.', ',');

function hoofd(argv) {
  const vlag = (v) => { const i = argv.indexOf(v); if (i < 0) return false; argv.splice(i, 1); return true; };
  const waarde = (v) => { const i = argv.indexOf(v); if (i < 0) return null; const w = argv[i + 1]; argv.splice(i, 2); return w; };
  const cmd = argv.shift();
  const kaartArg = waarde('--kaart');
  if (cmd === 'kaart-zet') {
    const o = { klantnummer: waarde('--klantnummer'), laatste4: waarde('--laatste4'), rekening: waarde('--rekening'), naam: waarde('--naam'), wie: WIE, nu: Date.now() };
    if (!o.klantnummer || !o.laatste4 || !o.rekening) throw new Error('kaart-zet: --klantnummer, --laatste4 en --rekening');
    const fdb = openGoed(true);
    try { return C.kaartZet(fdb, o); } finally { D.sluit(fdb); }
  }
  if (cmd === 'inlezen') {
    const droog = vlag('--droog'), herkomst = waarde('--herkomst');
    if (argv.length !== 1) throw new Error('inlezen: precies één bestand');
    const p = argv[0];
    const bytes = fs.readFileSync(p);
    const fdb = openGoed(!droog);
    try {
      const u = C.inlezen(fdb, kaartArg, bytes, { droog, wie: WIE, herkomst: herkomst || ('machinekamer: ' + path.basename(p)), naam: path.basename(p), nu: Date.now() });
      return Object.assign({ bestand_naam: path.basename(p) }, u);
    } finally { D.sluit(fdb); }
  }
  if (cmd === 'koppel') {
    const fdb = openGoed(true);
    try { return C.koppel(fdb, C.kaartVan(fdb, kaartArg).id, { wie: WIE, nu: Date.now() }); } finally { D.sluit(fdb); }
  }
  if (cmd === 'stand') {
    const fdb = openGoed(false);
    try {
      const a = C.aansluitingDb(fdb, C.kaartVan(fdb, kaartArg));
      return a.map((x) => x.overzicht + '  ' + x.status.padEnd(22) + ' kaart ' + euro(x.transacties_centen).padStart(12) + ' (' + x.regels + ')  bank ' + euro(x.bank_centen).padStart(12) +
        ' (' + x.bankregels + ')  ics_betaald ' + euro(x.ics_betaald_centen).padStart(12) + (x.verschil_centen ? '  verschil ' + euro(x.verschil_centen) : ''));
    } finally { D.sluit(fdb); }
  }
  if (cmd === 'betaalwijze') {
    const zet = vlag('--zet');
    const fdb = openGoed(zet);
    try { return C.betaalwijze(fdb, C.kaartVan(fdb, kaartArg), { zet, wie: WIE, nu: Date.now() }); } finally { D.sluit(fdb); }
  }
  if (cmd === 'regels') {
    const fdb = openGoed(false);
    try { return C.lees(fdb, { weergave: 'regels', maand: waarde('--maand'), tekst: waarde('--tekst'), kaart: kaartArg, max: 500 }); } finally { D.sluit(fdb); }
  }
  throw new Error('gebruik: kaart-zet | inlezen | koppel | stand | betaalwijze | regels (zie de kop van dit bestand)');
}

if (require.main === module) {
  try {
    const u = hoofd(process.argv.slice(2));
    if (Array.isArray(u) && typeof u[0] === 'string') console.log(u.join('\n'));
    else console.log(JSON.stringify(u, null, 1));
  } catch (e) {
    console.error('FOUT ' + (e.code ? e.code + ': ' : '') + (e.uitleg || e.message));
    process.exit(1);
  }
}
module.exports = { hoofd };
