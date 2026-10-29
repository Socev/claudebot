#!/usr/bin/env node
'use strict';
/*
 * tools/fin-reconcile.js — CLI van de aansluiting bank ↔ inkoopfacturen (wv1864, Second Brain 2.0 fase 4a). Zelfde code als fin-reconcile.js
 * (naast deze map); dit is alleen de ingang voor de machinekamer en de toetsen.
 *   node tools/fin-reconcile.js run [--entiteit tolgaarde] [--rekening <laatste 4 cijfers>] [--snapshot <sha256>] [--van JJJJ-MM-DD] [--tot JJJJ-MM-DD]
 *                                   [--dir /opt/data/fin-reken] [--facturen /opt/data/facturen/facturen.sqlite] [--bankbron <map>]
 *   node tools/fin-reconcile.js stand [--status open] [--max N] [--regels]
 *   node tools/fin-reconcile.js besluit --factuur archief:<id> --entry-refs <ref,ref> --oordeel ja|nee --wie david --bron "<vraag in Open vragen>"
 *   node tools/fin-reconcile.js opruim
 *   node tools/fin-reconcile.js registreer [--droog] [--max N]   (antwoordcontract naar Supabase, wv1899; env SUPABASE_URL/SUPABASE_SERVICE_ROLE)
 *   (run --registreer doet hetzelfde direct na de run)
 * Leest de Facturen-databank alleen via een eigen momentopname; schrijft alleen in --dir. Uitvoer: JSON op stdout.
 */
const path = require('path');
const FR = require(path.join(__dirname, '..', 'fin-reconcile.js'));
FR.main(process.argv.slice(2)).catch(function (e) {
  if (process.env.FIN_DEBUG === '1') process.stderr.write(String(e && e.stack || e) + '\n');
  process.stdout.write(JSON.stringify({ ok: false, fout: e instanceof FR.FinFout ? e.code : 'fout', uitleg: e instanceof FR.FinFout ? e.uitleg : String(e && e.name || 'fout') }) + '\n');
  process.exitCode = 1;
});
