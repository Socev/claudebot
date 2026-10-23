#!/usr/bin/env node
/*
 * facturen-historie.js — bankexports DEFINITIEF in de Facturen-database (wv944, 23-10-2026). Bouwplan: vault "01_Ontwikkeling/Facturen-app -
 * bouwplan (App, 22-10-2026).md" § 11. David 23-10-2026: "Ik wil juist de bankexports er definitief in hebben … denk aan Validatie van facturen."
 *
 * Draait op de pod (Olares, primaire kant) als 'claude', tegen /opt/data/facturen (of FACTUREN_DIR), vanuit de machinekamer. Zelfde
 * verwerking als een upload in de App (facturen.js verwerkBankbestand), maar in modus 'historisch': startdatum verplicht, regels vóór de
 * start zijn archief (alleen-eigenaar, geen signalen), het ruwe bestand gaat naar bankbron/ (offsite versleuteld via de podstaat-ronde).
 *
 *   node tools/facturen-historie.js [--droog] [--forceer] [--verplaats] [--herkomst "<tekst>"] <bestand> [<bestand> …]
 *     --droog      alleen lezen en tellen (al bekend, nieuw, mogelijk dubbel, suffixverschil, saldo); niets schrijven
 *     --forceer    ook boven de drempel "mogelijk dubbel" inlezen (pas nadat je de entry_refs hebt nagerekend; staat in de audit)
 *     --verplaats  na een geslaagde invoer (of "al bekend") het bestand uit de invoermap halen; alleen als de bron in bankbron/ staat
 *   node tools/facturen-historie.js startdatum [JJJJ-MM-DD]   toon of zet de startdatum (eerste dag dat Facturen echt draait)
 *
 * Uitvoer: alleen aantallen, periode, laatste 4 van de rekening, saldocontrole (sluit/breuken) — geen bedragen, namen of omschrijvingen.
 * Weigert als de database een ouder schema heeft dan deze code (de pod draait dan nog een oudere release; eerst uitrollen).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const D = require(path.join(__dirname, '..', 'facturen-db.js'));
const F = require(path.join(__dirname, '..', 'facturen.js'));
const K = require(path.join(__dirname, '..', 'facturen-kern.js'));

const DIR = process.env.FACTUREN_DIR || '/opt/data/facturen';

function openGoed() {
  if (String(process.env.SOCEV_KANT || 'olares') !== 'olares') throw new Error('alleen op de Olares-kant (daar staat de facturendatabase)');
  const ro = D.open(DIR, { alleenLezen: true });
  const schema = ro.schema;
  D.sluit(ro);
  if (schema < D.SCHEMA_VERSIE && !process.env.FACTUREN_MIGREER) {
    throw new Error('de database heeft schema ' + schema + ', deze code ' + D.SCHEMA_VERSIE + ': de pod draait nog een oudere release. Eerst uitrollen (of FACTUREN_MIGREER=1 op een kopie).');
  }
  return D.open(DIR);
}
function samenvatting(naam, u) {
  const s = Object.entries(u.saldo || {}).map(([r, x]) => r + ' ' + (x.gecontroleerd ? (x.sluit ? 'saldo sluit' : 'saldo ' + x.breuken + ' breuk(en)') : 'saldo niet te controleren')).join('; ');
  return {
    bestand: path.basename(naam), al_bekend: !!u.al_bekend, droog: !!u.droog, formaat: u.formaat, periode: u.periode,
    rekeningen: u.rekeningen, prive_weggegooid: u.prive_weggegooid, nieuw: u.nieuw, al_bekend_regels: u.al_bekend_regels, aangevuld: u.aangevuld,
    archief: u.archief, bron_bewaard: u.bron_bewaard, saldo: s || undefined, check: u.check,
    signalen: u.controle ? u.controle.signalen : undefined, historie_stil: u.controle ? u.controle.historie_stil || 0 : undefined,
  };
}
function hoofd(argv) {
  const vlag = (v) => { const i = argv.indexOf(v); if (i < 0) return false; argv.splice(i, 1); return true; };
  const waarde = (v) => { const i = argv.indexOf(v); if (i < 0) return null; const w = argv[i + 1]; argv.splice(i, 2); return w; };
  if (argv[0] === 'startdatum') {
    const fdb = openGoed();
    try {
      if (argv[1]) {
        if (!K.isIsoDatum(argv[1])) throw new Error('startdatum: JJJJ-MM-DD');
        const oud = D.metaLees(fdb, 'startdatum');
        D.metaZet(fdb, 'startdatum', argv[1]);
        D.audit(fdb, { wie: 'machinekamer', wat: 'startdatum', object_soort: 'meta', object_id: 'startdatum', voor: { startdatum: oud }, na: { startdatum: argv[1] }, wanneer: new Date().toISOString() });
      }
      return { startdatum: D.metaLees(fdb, 'startdatum') };
    } finally { D.sluit(fdb); }
  }
  const droog = vlag('--droog'), forceer = vlag('--forceer'), verplaats = vlag('--verplaats');
  const herkomst = waarde('--herkomst');
  if (!argv.length) throw new Error('gebruik: [--droog] [--forceer] [--verplaats] [--herkomst …] <bestand> … | startdatum [JJJJ-MM-DD]');
  const fdb = openGoed();
  const rol = F.rolVoor(fdb, { ingang: 'app', wie: 'machinekamer' });
  const uit = [];
  try {
    for (const p of argv) {
      const bytes = fs.readFileSync(p);
      let u;
      try {
        u = F.verwerkBankbestand(fdb, rol, bytes, path.basename(p), Date.now(), { modus: 'historisch', droog, forceer, herkomst: herkomst || ('machinekamer: ' + path.basename(p)) });
      } catch (e) {
        if (e instanceof F.RouteFout) { uit.push({ bestand: path.basename(p), ok: false, status: e.status, fout: e.fout, check: e.extra && e.extra.check }); continue; }
        throw e;
      }
      const s = samenvatting(p, u);
      if (verplaats && !droog) {
        const sha = D.sha256(bytes);
        if (D.bronBestaat(fdb, sha)) { fs.unlinkSync(p); s.verplaatst = true; } else s.verplaatst = false;
      }
      uit.push(Object.assign({ ok: true }, s));
    }
  } finally { D.sluit(fdb); }
  return uit;
}

if (require.main === module) {
  try { console.log(JSON.stringify(hoofd(process.argv.slice(2)), null, 1)); }
  catch (e) { console.error('fout: ' + (e && e.message || e)); process.exit(1); }
}
module.exports = { hoofd };
