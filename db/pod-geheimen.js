#!/usr/bin/env node
/*
 * pod-geheimen (wv3207) — de lokale route van fetch-secrets.sh na de databankoverstap: roept
 * public.sb_pod_secrets_lezen(p_bootstrap) aan op de EIGEN databank (unix-socket, rol postgres, peer: alleen OS-gebruiker
 * claude; fetch-secrets start dit als `gosu claude`). Het bootstrapgeheim komt uit de omgeving (POD_BOOTSTRAP_SECRET, zoals bij
 * de RPC-route) en gaat als PARAMETER mee, nooit in de querytekst (log_statement staat uit, maar een parameter komt ook in een
 * foutregel niet terecht). Uitvoer op stdout: precies het JSON-antwoord van de functie ({"ok":…,"secrets":[…]}), dezelfde vorm
 * als PostgREST teruggeeft, zodat fetch-secrets het met dezelfde klasseer/uitpak verwerkt.
 * Exit 0 = antwoord geschreven (ook ok:false); exit 1 = geen verbinding of fout (fetch-secrets probeert dan opnieuw);
 * nooit een foutmelding met inhoud (alleen de Postgres-foutcode op stderr).
 * Omgeving (alleen voor toetsen): POD_GEHEIMEN_SOCKET (standaard /run/pg), POD_GEHEIMEN_PORT (5432), POD_GEHEIMEN_DB (postgres).
 */
'use strict';
const pg = require('pg');

(async function () {
  const c = new pg.Client({
    host: process.env.POD_GEHEIMEN_SOCKET || '/run/pg',
    port: parseInt(process.env.POD_GEHEIMEN_PORT || '5432', 10),
    database: process.env.POD_GEHEIMEN_DB || 'postgres',
    user: 'postgres',
    application_name: 'pod-geheimen',
    options: '-c statement_timeout=15000',
    connectionTimeoutMillis: 10000,
    query_timeout: 20000,   // Codex MOET 1 (naast timeout 30 in fetch-secrets.sh)
  });
  try {
    await c.connect();
    const r = await c.query('select public.sb_pod_secrets_lezen($1::text) as r', [process.env.POD_BOOTSTRAP_SECRET || '']);
    await c.end();
    const v = r.rows && r.rows[0] ? r.rows[0].r : null;
    if (!v || typeof v !== 'object') { process.stderr.write('pod-geheimen: leeg antwoord\n'); process.exit(1); }
    process.stdout.write(JSON.stringify(v));
  } catch (e) {
    try { await c.end(); } catch (x) { /* al dicht */ }
    process.stderr.write('pod-geheimen: mislukt (' + String((e && (e.code || e.errno)) || 'onbekend').slice(0, 20) + ')\n');
    process.exit(1);
  }
})();
