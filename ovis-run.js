#!/usr/bin/env node
'use strict';
// ovis-run.js — één ingang op de opdrachtregel voor ovis-register.js (wv979, 24-10-2026; ontwerp mk-scripts/wv979/ontwerp.md).
// Voor de nachtronde onder de bisync-grendel (server.js start: flock -w 300 <vault.lock> node ovis-run.js nacht) en voor de
// machinekamer (proef in een vaultkopie met VAULT_DIR=<proefmap>, export van register.json).
//
//   node ovis-run.js dag|afroep            compileren: alleen pagina's waarvan de vingerafdruk afwijkt; alleen de databank
//   node ovis-run.js nacht [--buiten-venster]   alles compileren + gegenereerd blok in de pagina's; alleen 01:00-02:00 (Amsterdam) en
//                                          alleen als de grendel al vastgehouden wordt (anders weigert hij)
//   node ovis-run.js bibliothecaris [--afroep]  BB1-BB7; --afroep: geen hartslagstempel (en de aanroeper geen box-rij)
//   node ovis-run.js export <register.json>     knopen uit de databank in register.json (sleutels/vertaling blijven); alleen bij verschil
//   --droog: niets schrijven (databank noch vault)
// Omgeving: VAULT_DIR (standaard de vault), SUPABASE_URL + SUPABASE_SERVICE_ROLE (nooit als argument), OVIS_LOCK (standaard
// /opt/data/bin/.vault.lock). Uitvoer: één JSON-regel; uitgang 0 = gelukt, 1 = fout, 2 = gebruik.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('./ovis-register.js');
const VV = require('./vault-veilig.js');

const VAULT = process.env.VAULT_DIR || '/opt/data/AI_SecondBrain';
const ECHTE_VAULT = '/opt/data/AI_SecondBrain';
const LOCK = process.env.OVIS_LOCK || '/opt/data/bin/.vault.lock';
const arg = process.argv.slice(2), modus = arg[0], droog = arg.indexOf('--droog') >= 0;

function stop(code, j) { process.stdout.write(JSON.stringify(j) + '\n'); process.exit(code); }
async function sbRpc(fn, body) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, ''), key = process.env.SUPABASE_SERVICE_ROLE || '';
  if (!url || !key) throw new Error('supabase-omgeving ontbreekt');
  const r = await fetch(url + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  if (!r.ok) { let m = ''; try { m = JSON.parse(t).message || ''; } catch (e) {} throw new Error('rpc ' + fn + ' http ' + r.status + (m ? ': ' + String(m).slice(0, 200) : '')); }
  return t ? JSON.parse(t) : null;
}
// wv1360: geaccepteerde rekeningnummers uit de Facturen-database (alleen lezen) voor het gegenereerde blok. Per rekening: de herkomst die bij
// het vastleggen in feit.bewijs kwam (ook POT-historie uit de bankluis en Triodos) plus wat de bank daarna nog aan betalingen liet zien.
// Geen database (uitwijkkant, terugrol) → null: de compiler laat bestaande nummers dan staan.
function rekeningen() {
  const pad = path.join(process.env.FACTUREN_DIR || '/opt/data/facturen', 'facturen.sqlite');
  if (!fs.existsSync(pad)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(pad, { readOnly: true });
  try {
    const eigen = new Set(db.prepare('SELECT iban FROM rekening').all().map(function (r) { return r.iban; }));
    const alle = db.prepare('SELECT count(*) AS n, min(boekdatum) AS eerste, max(boekdatum) AS laatste FROM bank_transactie WHERE tegenpartij_iban = ? AND bedrag_centen < 0 AND verwijderd_op IS NULL');
    const na = db.prepare('SELECT count(*) AS n, max(boekdatum) AS laatste FROM bank_transactie WHERE tegenpartij_iban = ? AND bedrag_centen < 0 AND verwijderd_op IS NULL AND boekdatum > ?');
    const uit = [];
    for (const r of db.prepare('SELECT li.iban, l.naam, f.bewijs FROM leverancier_iban li JOIN leverancier l ON l.id = li.leverancier LEFT JOIN feit f ON f.id = li.feit ORDER BY li.iban').all()) {
      if (eigen.has(r.iban)) continue;
      let b = null; try { b = r.bewijs ? JSON.parse(r.bewijs) : null; } catch (e) { b = null; }
      const a = alle.get(r.iban);
      let aantal = a.n, eerste = a.eerste, laatste = a.laatste;
      if (b && Number.isInteger(b.aantal) && /^\d{4}-\d{2}-\d{2}$/.test(String(b.eerste)) && /^\d{4}-\d{2}-\d{2}$/.test(String(b.laatste))) {
        const n = na.get(r.iban, b.laatste);
        aantal = Math.max(a.n, b.aantal + n.n); eerste = a.eerste && a.eerste < b.eerste ? a.eerste : b.eerste; laatste = n.laatste || b.laatste;
      }
      uit.push({ iban: r.iban, naam: r.naam, doel: b && typeof b.doel === 'string' ? b.doel : null, aantal: aantal, eerste: eerste, laatste: laatste });
    }
    return uit;
  } finally { db.close(); }
}
function uurAmsterdam() { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hourCycle: 'h23' }).format(new Date())); }
// Houdt de ouder de grendel vast? Een eigen `flock -n` op hetzelfde bestand moet dan falen (andere open file description).
function grendelVast() {
  if (fs.realpathSync(VAULT) !== fs.realpathSync(ECHTE_VAULT)) return true;   // proefmap: geen bisync (diffreview #7: beide via realpath)
  const r = spawnSync('flock', ['-n', LOCK, 'true'], { timeout: 5000 });
  return r.status === 1;
}

(async function () {
  if (['dag', 'afroep', 'nacht', 'bibliothecaris', 'export'].indexOf(modus) < 0) stop(2, { ok: false, fout: 'gebruik: dag|afroep|nacht|bibliothecaris|export <pad>' });
  const reg = R.maak({ vault: VAULT, sbRpc: sbRpc, lees: function (p) { return VV.lees(p, 'utf8'); },
    schrijf: function (p, t) { VV.schrijf(p, t); }, log: function () {}, rekeningen: rekeningen });
  try {
    if (modus === 'nacht') {
      if (arg.indexOf('--buiten-venster') < 0 && uurAmsterdam() !== 1) stop(1, { ok: false, fout: 'nachtronde alleen 01:00-02:00 (Amsterdam); --buiten-venster om af te wijken' });
      if (!grendelVast()) stop(1, { ok: false, fout: 'grendel ' + LOCK + ' niet vastgehouden: start met flock -w 300 ' + LOCK + ' node ovis-run.js nacht' });
      stop(0, Object.assign({ ok: true }, await reg.compileer('nacht', { droog: droog, grendel: true })));
    }
    if (modus === 'dag' || modus === 'afroep') stop(0, Object.assign({ ok: true }, await reg.compileer(modus, { droog: droog })));
    if (modus === 'bibliothecaris') {
      const b = await reg.bibliothecaris({ droog: droog, afroep: arg.indexOf('--afroep') >= 0 });
      stop(0, Object.assign({ ok: true }, b, { bevindingen: b.bevindingen.map(function (x) { return { id: x.bevinding_id, check: x.check_id, ernst: x.ernst, samenvatting: x.samenvatting }; }) }));
    }
    if (modus === 'export') {
      const doel = arg[1];
      if (!doel || !/register\.json$/.test(doel)) stop(2, { ok: false, fout: 'export <pad naar register.json>' });
      const huidig = JSON.parse(fs.readFileSync(doel, 'utf8'));
      const r = await reg.register();
      const velden = ['id', 'soort', 'naam', 'vault_pad', 'vault_pagina', 'aliassen', 'kvk', 'agb', 'iban', 'opmerking', 'rol', 'concept'];
      const knopen = r.knopen.map(function (k) { const x = {}; velden.forEach(function (v) { x[v] = k[v] === undefined ? null : k[v]; }); return x; });
      const nieuw = Object.assign({}, huidig, { knopen: knopen });
      const tekst = JSON.stringify(nieuw, null, 1) + '\n';
      if (fs.readFileSync(doel, 'utf8') === tekst) stop(0, { ok: true, gewijzigd: false, knopen: knopen.length });
      if (!droog) { const tmp = doel + '.' + process.pid + '.nieuw'; fs.writeFileSync(tmp, tekst, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, doel); }
      stop(0, { ok: true, gewijzigd: true, knopen: knopen.length, droog: droog });
    }
  } catch (e) { stop(1, { ok: false, fout: String(e && e.message || e).slice(0, 300) }); }
})();
