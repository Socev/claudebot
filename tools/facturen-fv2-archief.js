#!/usr/bin/env node
/*
 * facturen-fv2-archief.js — het FV2-archief (Supabase facturen.bank_transactions + facturen.invoices, juli–augustus 2026; bankregels vanaf
 * januari 2025) als historie in de Facturen-database (wv944, 23-10-2026). Bouwplan: vault "01_Ontwikkeling/Facturen-app - bouwplan (App,
 * 22-10-2026).md" § 11. Zo is er al bankhistorie voor de validatie vóórdat Davids eigen exports binnen zijn; die vullen later aan
 * (zelfde entry_ref, aanvullen van incassant/machtiging, droogloop tegen dubbel).
 *
 * Draait op de pod (Olares, primaire kant) als 'claude' vanuit de machinekamer. Leest Supabase alleen (Management-API, één SELECT per tabel,
 * sleutel uit de omgeving); schrijft via facturen.js archiefInvoeren. Privé, regels zonder entiteit en de POT-bankregels (SWW: die
 * komen uit de bankluis) gaan niet mee; POT-facturen wel.
 *
 *   node tools/facturen-fv2-archief.js [--droog] [--entiteit <sleutel>]
 *
 * Uitvoer: alleen aantallen per entiteit. Weigert bij een ouder schema (eerst uitrollen) en zonder startdatum.
 */
'use strict';
const path = require('path');
const D = require(path.join(__dirname, '..', 'facturen-db.js'));
const F = require(path.join(__dirname, '..', 'facturen.js'));

// wv3180: beheer-SQL — zonder SB_SQL_LOKAAL=1 de Supabase-Management-API (oude gedrag), met SB_SQL_LOKAAL=1 /app/sb-sql (eigen Postgres
// over de socket, zelfde uitvoervorm). Geeft een Response; null = geen toegang. Kindproces met minimale omgeving, query via stdin.
function sbBeheerKan() {
  if (process.env.SB_SQL_LOKAAL === '1') return true;
  return !!(((/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(String(process.env.SUPABASE_URL || '')) || [])[1] || '') && process.env.SUPABASE_MCP_TOKEN);
}
function sbBeheerQuery(sql, opties) {
  const o = opties || {};
  const ms = o.ms || 20000;
  if (process.env.SB_SQL_LOKAAL === '1') {
    return new Promise(function (resolve) {
      let uit = '', fout = '', klaar = false;
      const einde = function (st, t) { if (klaar) return; klaar = true; clearTimeout(klok); resolve(new Response(t, { status: st, headers: { 'content-type': 'application/json' } })); };
      const k = require('child_process').spawn(process.env.SB_SQL_BIN || '/app/sb-sql', [], { stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '/opt/data', SB_SQL_TIMEOUT_MS: String(ms) } });
      const klok = setTimeout(function () { try { k.kill('SIGKILL'); } catch (e) {} }, ms + 2000);
      k.stdout.on('data', function (d) { uit += d; });
      k.stderr.on('data', function (d) { if (fout.length < 8192) fout += d; });
      k.on('error', function () { einde(503, JSON.stringify({ message: 'Failed to run sql query: sb-sql niet te starten' })); });
      k.on('close', function (code) {
        if (code === 0) return einde(201, uit || '[]');
        let msg = 'sb-sql faalde'; try { msg = JSON.parse(fout.trim().split('\n').pop()).message || msg; } catch (e) {}
        einde(code === null ? 504 : 400, JSON.stringify({ message: 'Failed to run sql query: ' + msg }));
      });
      k.stdin.on('error', function () {});
      k.stdin.end(sql);
    });
  }
  const ref = ((/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(String(process.env.SUPABASE_URL || '')) || [])[1] || '');
  if (!ref || !process.env.SUPABASE_MCP_TOKEN) return Promise.resolve(null);
  return fetch('https://api.supabase.com/v1/projects/' + ref + '/database/query', { method: 'POST', redirect: 'error',
    headers: { Authorization: 'Bearer ' + process.env.SUPABASE_MCP_TOKEN, 'Content-Type': 'application/json', 'User-Agent': o.ua || 'socev-pod/1' },
    body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(ms) });
}

const DIR = process.env.FACTUREN_DIR || '/opt/data/facturen';
// FV2-sleutel → Facturen-sleutel (secondbrain.knoop_vertaling, wv870)
const KAART = { TOLGAARDE: 'tolgaarde', GROENHOUTEN: 'groenhouten', PNN: 'holding', PHBV: 'praktijkhouders_bv', POHGGZ: 'kostenmaatschap', SLOEL: 'sloel', SWW: 'pot', SEL: 'sel' };

// Supabase Management-API (SQL, alleen SELECT): het schema facturen staat niet in PostgREST (alleen public). Sleutel uit de omgeving
// (SUPABASE_MCP_TOKEN), nooit als argument. Vaste query's zonder invoer van buiten.
async function haal(tabel, select, filter) {
  if (!sbBeheerKan()) throw new Error('SUPABASE_URL of SUPABASE_MCP_TOKEN ontbreekt in de omgeving');
  if (!/^[a-z_]+$/.test(tabel) || !/^[a-z_,]+$/.test(select)) throw new Error('vaste query');
  const q = 'select ' + select + ' from facturen.' + tabel + ' where ' + filter + ' order by id';
  const r = await sbBeheerQuery(q, { ms: 120000 });   // voorheen zonder tijdgrens; grote tabellen
  if (!r.ok) throw new Error(tabel + ': HTTP ' + r.status);
  const rij = await r.json();
  if (!Array.isArray(rij)) throw new Error(tabel + ': geen lijst');
  return rij;
}

async function hoofd(argv) {
  const droog = argv.includes('--droog');
  const ei = argv.indexOf('--entiteit'), alleen = ei >= 0 ? argv[ei + 1] : null;
  if (String(process.env.SOCEV_KANT || 'olares') !== 'olares') throw new Error('alleen op de Olares-kant');
  const ro = D.open(DIR, { alleenLezen: true });
  const schema = ro.schema; D.sluit(ro);
  if (schema < D.SCHEMA_VERSIE && !process.env.FACTUREN_MIGREER) throw new Error('de database heeft schema ' + schema + ', deze code ' + D.SCHEMA_VERSIE + ': eerst uitrollen');
  const tx = await haal('bank_transactions', 'id,entity_key,boekdatum,tegenpartij_iban,tegenpartij_naam,bedrag,omschrijving,betalingskenmerk,transactietype,is_incasso,entry_ref,created_at',
    "entity_key not in ('PRIVE','DSCHAAP')");
  const inv = await haal('invoices', 'id,entity_key,leverancier_naam,factuurnummer,factuurdatum,vervaldatum,bedrag_incl,valuta,iban_begunstigde,betalingskenmerk,betaalwijze,status',
    'entity_key is not null');
  const per = {};
  const zet = (fv2) => { const s = KAART[fv2]; if (!s) return null; return (per[s] = per[s] || { entiteit: s, regels: [], facturen: [], bestand_op: null }); };
  let zonder = 0;
  for (const t of tx) {
    const p = zet(t.entity_key);
    if (!p) { zonder++; continue; }
    if (p.entiteit === 'pot') continue;   // POT-bankregels komen uit de bankluis
    p.regels.push({ entry_ref: t.entry_ref, boekdatum: t.boekdatum, bedrag: t.bedrag, tegenpartij_iban: t.tegenpartij_iban, tegenpartij_naam: t.tegenpartij_naam,
      omschrijving: t.omschrijving, betalingskenmerk: t.betalingskenmerk, transactietype: t.transactietype, is_incasso: t.is_incasso });
    if (t.created_at && (!p.bestand_op || t.created_at > p.bestand_op)) p.bestand_op = t.created_at;
  }
  for (const f of inv) {
    const p = zet(f.entity_key);
    if (!p || f.entity_key === 'PRIVE') continue;
    p.facturen.push({ extern_id: f.id, leverancier_naam: f.leverancier_naam, factuurnummer: f.factuurnummer, factuurdatum: f.factuurdatum, vervaldatum: f.vervaldatum,
      bedrag_incl: f.bedrag_incl, valuta: f.valuta, iban_begunstigde: f.iban_begunstigde, betalingskenmerk: f.betalingskenmerk, betaalwijze: f.betaalwijze, status: f.status });
  }
  const uit = { gelezen: { bankregels: tx.length, facturen: inv.length, zonder_entiteit: zonder }, entiteiten: [] };
  if (droog) {
    for (const p of Object.values(per)) uit.entiteiten.push({ entiteit: p.entiteit, regels: p.regels.length, facturen: p.facturen.length });
    return uit;
  }
  const fdb = D.open(DIR);
  try {
    const rol = F.rolVoor(fdb, { ingang: 'app', wie: 'machinekamer' });
    for (const p of Object.values(per)) {
      if (alleen && p.entiteit !== alleen) continue;
      if (p.entiteit !== 'pot' && !fdb.db.prepare("SELECT 1 FROM rekening WHERE entiteit = ? AND controle = 1 AND bank_formaat <> 'bankluis'").get(p.entiteit)) {
        uit.entiteiten.push({ entiteit: p.entiteit, overgeslagen: 'geen rekening met bankexport', regels: p.regels.length, facturen: p.facturen.length });
        continue;
      }
      try {
        const r = F.archiefInvoeren(fdb, rol, { entiteit: p.entiteit, regels: p.regels, facturen: p.facturen, bestand_op: p.bestand_op,
          herkomst: 'FV2 Supabase facturen.bank_transactions/invoices (' + p.regels.length + ' regels, ' + p.facturen.length + ' facturen)' }, Date.now());
        uit.entiteiten.push({ entiteit: p.entiteit, regels: p.regels.length, nieuw: r.nieuw, al_bekend: !!r.al_bekend, overgeslagen: r.overgeslagen, na_start: r.na_start,
          facturen: r.facturen, mogelijk_dubbel: r.check ? r.check.mogelijk_dubbel : 0, signalen: r.controle ? r.controle.signalen : 0 });
      } catch (e) {
        if (e instanceof F.RouteFout) { uit.entiteiten.push({ entiteit: p.entiteit, fout: e.fout, status: e.status }); continue; }
        throw e;
      }
    }
  } finally { D.sluit(fdb); }
  return uit;
}

if (require.main === module) {
  hoofd(process.argv.slice(2)).then((u) => console.log(JSON.stringify(u, null, 1)), (e) => { console.error('fout: ' + (e && e.message || e)); process.exit(1); });
}
module.exports = { hoofd, KAART };
