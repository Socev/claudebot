#!/usr/bin/env node
/*
 * sb-sql (wv3180) — beheer-SQL op de eigen databank, vervanger van de Supabase-Management-API (POST …/database/query).
 * Leest SQL van stdin, voert die uit als rol postgres over de unix-socket (peer: alleen OS-gebruiker claude), en schrijft de rijen
 * van het LAATSTE statement als JSON-lijst naar stdout — dezelfde vorm als database/query (gemeten 16-11: int8 als getal tenzij
 * te groot, numeric als tekst, datum/tijd als ruwe tekst in UTC, json geparst, bytea als Buffer-JSON).
 * Fout: exit 1 en op stderr één JSON-regel {"message": …} (de foutmelding van Postgres; nooit de query zelf).
 * Omgeving: SB_SQL_SOCKET (standaard /run/pg), SB_SQL_DB (postgres), SB_SQL_ROL (postgres), SB_SQL_TIMEOUT_MS (120000).
 * Geen netwerk-ingang: alleen lokaal aan te roepen.
 */
'use strict';
const pg = require('pg');
const arr = require('postgres-array');
const T = pg.types;
const rauw = function (x) { return x; };
const int8 = function (x) { const n = Number(x); return Number.isSafeInteger(n) ? n : x; };
T.setTypeParser(20, int8);                                                   // int8
// int8[] blijft tekst (pg-standaard), net als bij de beheer-API (gemeten 16-11)
[1082, 1114, 1184, 1083, 1266, 1186].forEach(function (o) { T.setTypeParser(o, rauw); });   // date, timestamp(tz), time(tz), interval
[1182, 1115, 1185, 1183, 1270, 1187].forEach(function (o) { T.setTypeParser(o, function (x) { return arr.parse(x, rauw); }); });

function lees() {
  return new Promise(function (resolve, reject) {
    const d = [];
    process.stdin.on('data', function (b) { d.push(b); });
    process.stdin.on('end', function () { resolve(Buffer.concat(d).toString('utf8')); });
    process.stdin.on('error', reject);
  });
}
function fout(msg, code) {
  process.stderr.write(JSON.stringify({ message: String(msg || 'onbekende fout').slice(0, 2000) }) + '\n');
  process.exit(code || 1);
}
(async function () {
  const sql = await lees();
  if (!sql.trim()) fout('lege query', 2);
  const c = new pg.Client({
    host: process.env.SB_SQL_SOCKET || '/run/pg',
    database: process.env.SB_SQL_DB || 'postgres',
    user: process.env.SB_SQL_ROL || 'postgres',
    application_name: process.env.SB_SQL_NAAM || 'sb-sql',
    options: '-c TimeZone=UTC -c statement_timeout=' + parseInt(process.env.SB_SQL_TIMEOUT_MS || '120000', 10),
  });
  try {
    await c.connect();
    const r = await c.query(sql);   // eenvoudig queryprotocol: meerdere statements mogen
    const laatste = Array.isArray(r) ? r[r.length - 1] : r;
    process.stdout.write(JSON.stringify(laatste && Array.isArray(laatste.rows) ? laatste.rows : []));
    await c.end();
  } catch (e) {
    try { await c.end(); } catch (x) { /* al dicht */ }
    fout(e && e.message);
  }
})();
