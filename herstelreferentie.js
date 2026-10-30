'use strict';
/**
 * herstelreferentie.js — nachtketen-stap sb2-herstelreferentie (SB2 fase 6a, wv1962, 29-10-2026; ontwerp vault "01_Ontwikkeling/Second
 * Brain 2.0 - fase 6 herstelproef, proefloper en redeneerteam (ontwerp 29-10-2026).md" § 3.2, review MOET 4).
 *
 * WAAROM. De herstelproef (fase 6b, R230) moet bewijzen dat één echte berekening na het terugzetten precies hetzelfde uitkomt. Daarvoor
 * legt deze stap elke nacht de referentie vast: de droge, deterministische finance.reconcile (fin-reconcile.js droog) op de
 * facturendump UIT de versleutelde podstaat-bundel van vannacht (teruggelezen van Drive, sha256 gelijk aan wat podstaat schreef) en de
 * bewaarde bankexports. Niet in het podstaat-venster zelf (dat zit op ± 110 van 180 s).
 *
 * WAT. Eén keer per Nederlandse datum, na podstaat (die schrijft <refMap>/podstaat-<kant>-<dag>.json):
 *   1. bundel via de crypt-remote naar een eigen tmpfs-map (0700), sha256 = referentie, anders fout;
 *   2. podstaat/facturen/facturen.sqlite.gz eruit en uitpakken (ontbreekt = fout: ontbrekend onderdeel is rood);
 *   3. node fin-reconcile.js droog (de CLI in de release; tools/ gaat niet mee) --nu <rondestart van podstaat> (schrijft niets, leest de klok niet);
 *   4. <refMap>/reconcile-<kant>-<dag>.json (0600): alleen hashes, codes en tellingen; de tmpfs-map gaat altijd weg.
 * Geen podstaat-referentie vóór 05:00: wachten; daarna fout (één box-rij via de keten).
 * Alles wat de pod raakt (rclone, node, klok) komt als functie of pad binnen, zodat test/herstelreferentie.test.js het met nep-gereedschap
 * kan draaien.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_UIT = 4 * 1024 * 1024;

function uitvoer(bin, args, opties) {
  return new Promise(function (klaar) {
    execFile(bin, args, Object.assign({ maxBuffer: MAX_UIT, encoding: 'buffer' }, opties || {}), function (fout, stdout) {
      klaar({ code: fout ? (typeof fout.code === 'number' ? fout.code : 1) : 0, stdout: stdout || Buffer.alloc(0) });
    });
  });
}

function schrijfAtomair(p, inhoud) {
  const tmp = p + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, inhoud, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/*
 * o = { refMap, remote ('vaultcrypt'), rclone (pad), node (pad), finCli (fin-reconcile.js in de release), bankbron (map of functie die de map geeft), tmpRoot ('/dev/shm'),
 *       wachtTot ([uur, min], standaard [5, 0]), regelsVersie() }
 */
function maak(o) {
  const refMap = o.refMap;
  const wachtTot = o.wachtTot || [5, 0];

  function podstaatRef(datum) {
    let namen = [];
    try { namen = fs.readdirSync(refMap); } catch (e) { return null; }
    const n = namen.filter((x) => /^podstaat-(olares|vps)-\d{4}-\d{2}-\d{2}\.json$/.test(x) && x.endsWith('-' + datum + '.json')).sort();
    if (!n.length) return null;
    return JSON.parse(fs.readFileSync(path.join(refMap, n[n.length - 1]), 'utf8'));
  }

  async function ronde(ctx) {
    const datum = ctx.datum;
    if (!DATUM_RE.test(String(datum || ''))) return { ok: false, reden: 'datum ongeldig' };
    let ref;
    try { ref = podstaatRef(datum); } catch (e) { return { ok: false, reden: 'podstaat-referentie onleesbaar' }; }
    if (!ref) {
      const a = ctx.ams || { uur: 0, min: 0 };
      return a.uur * 60 + a.min < wachtTot[0] * 60 + wachtTot[1] ? { wacht: 'geen podstaat-referentie (nog)' }
        : { ok: false, reden: 'geen podstaat-referentie van ' + datum + ' (bundel mislukt of referentiestap faalde; zie backup.log)' };
    }
    const kant = ref.kant === 'vps' ? 'vps' : 'olares';
    const doel = path.join(refMap, 'reconcile-' + kant + '-' + datum + '.json');
    if (fs.existsSync(doel)) return { ok: true, al_gedaan: true };
    if (!/^podstaat-(olares|vps)-\d{4}-\d{2}-\d{2}\.tgz$/.test(String(ref.naam || '')) || !/^[0-9a-f]{64}$/.test(String(ref.sha256 || ''))
        || !Number.isInteger(ref.start)) return { ok: false, reden: 'podstaat-referentie onvolledig' };
    const fd = (ref['sqlite'] || {}).facturen;   // (geen punt-toegang: de datakaart-poort leest "<x>.sqlite" als bestandsnaam)
    if (fd && fd.bestand !== 'facturen/facturen.sqlite.gz') return { ok: false, reden: 'podstaat-referentie: onverwachte facturennaam' };
    if (!fd) return { ok: false, reden: 'facturen ontbreken in de bundel van ' + datum + ' (' + String((ref.stand || {}).facturen || '?').slice(0, 40) + ')' };
    const stage = fs.mkdtempSync(path.join(o.tmpRoot || '/dev/shm', 'sb2-herstelref.'));
    try {
      fs.chmodSync(stage, 0o700);
      const bundel = path.join(stage, 'b.tgz');
      const cat = await uitvoer(o.rclone || 'rclone', ['cat', (o.remote || 'vaultcrypt') + ':' + ref.naam], { timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
      if (cat.code !== 0 || !cat.stdout.length) return { ok: false, reden: 'bundel niet terug te lezen (rclone ' + cat.code + ')' };
      fs.writeFileSync(bundel, cat.stdout, { mode: 0o600 });
      const sha = crypto.createHash('sha256').update(cat.stdout).digest('hex');
      if (sha !== ref.sha256) return { ok: false, reden: 'bundel op Drive wijkt af van de referentie (sha ' + sha.slice(0, 12) + ')' };
      const lid = 'podstaat/' + fd.bestand;
      const tar = await uitvoer('tar', ['-xzf', bundel, '-C', stage, lid], { timeout: 60000 });
      fs.unlinkSync(bundel);   // tmpfs is 64 MB: de bundel eerst weg, dan pas uitpakken (review wv1962 ZOU 7)
      const gz = path.join(stage, lid);
      if (tar.code !== 0 || !fs.existsSync(gz)) return { ok: false, reden: 'facturendump niet in de bundel' };
      const db = path.join(stage, 'facturen.sqlite');
      fs.writeFileSync(db, require('zlib').gunzipSync(fs.readFileSync(gz)), { mode: 0o600 });
      fs.unlinkSync(gz);
      const bankbron = typeof o.bankbron === 'function' ? o.bankbron() : o.bankbron;
      const r = await uitvoer(o.node || process.execPath, [o.finCli, 'droog', '--facturen', db, '--bankbron', bankbron, '--nu', String(ref.start * 1000)],
        { timeout: 300000, env: Object.assign({}, process.env, { FIN_DEBUG: '' }) });
      let u = null;
      try { u = JSON.parse(r.stdout.toString('utf8')); } catch (e) { u = null; }
      if (r.code !== 0 || !u || u.ok !== true || !/^[0-9a-f]{64}$/.test(String(u.uitkomst_hash || ''))) {
        return { ok: false, reden: 'droge reconcile mislukt (' + String(u && u.fout || 'exit ' + r.code).slice(0, 40) + ')' };
      }
      const uit = { protocol: 'sb2-referentie-v1', onderdeel: 'reconcile', dag: datum, kant, bundel: ref.naam, bundel_sha256: ref.sha256,
        nu_ms: ref.start * 1000, facturen_sha256: u.snapshot, invoer_hash: u.invoer_hash, uitkomst_hash: u.uitkomst_hash, regels_hash: u.regels_hash,
        regels_versie: typeof o.regelsVersie === 'function' ? o.regelsVersie() : null, rekening_label: u.rekening_label, dekking_tot: u.dekking_tot,
        uitkomst: u.uitkomst, code: u.code, telling: u.telling };
      schrijfAtomair(doel, JSON.stringify(uit, null, 1) + '\n');
      return { ok: true, detail: { uitkomst: u.uitkomst, uitkomst_hash: u.uitkomst_hash.slice(0, 12) } };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  return { ronde };
}

module.exports = { maak };
