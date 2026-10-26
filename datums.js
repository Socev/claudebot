'use strict';
/**
 * datums.js — POST /datums (wv1275, Second Brain 2.0 fase 2; ontwerp vault 01_Ontwikkeling/Second Brain 2.0 - datumdetector en
 * scripts-repo (ontwerp).md § 2.5). Tekst + anker -> alle datums, tijden en periodes (socev-datum), synchroon, geen model, geen netwerk.
 *
 * - De detector staat in de scripts-repo (socev-scripts packages/datum). Per aanroep wordt de echte map van
 *   /opt/data/scripts/huidig vastgezet (realpath), zodat een scripts-uitrol halverwege nooit twee releases mengt; de release-tag en de
 *   detectorversie staan in elke uitkomst.
 * - python3 -I in een kind met een kaal milieu (geen sleutels mee), invoer via stdin, tijdslimiet 10 s, hooguit 4 tegelijk.
 * - Schaduw (§ 2.5, 2 weken naast de AI-datumstap van de Mail Processor): met `schaduw` in de body één regel per mail in
 *   /opt/data/scripts-staat/datum-schaduw/<dag>.jsonl (map 0700, bestand 0600, nooit een symlink volgen): sha256-hash van de
 *   message-id, offsets, waarden, soort, rol, zekerheid en regel-id per treffer, en de AI-datum ernaast. Geen tekst, geen
 *   (mogelijke) geboortedatum. Het antwoord op een schaduwaanroep is alleen een telling (de uitkomst hoort niet in n8n).
 *   Bestanden ouder dan 30 dagen gaan weg bij het laden en daarna elke 6 uur (ook als er niets meer geschreven wordt).
 *   Een AI-datum die gelijk is aan een (mogelijke) geboortedatum gaat als null mee, met ai_geheim (review wv1275 #5).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAX_TEKST = 50000;   // de Mail Processor stuurt hooguit 12.000 tekens; 50k = ± 0,15 s (review wv1275 #7)
const MAX_TEGELIJK = 4;
const BEWAAR_DAGEN = 30;
const GEHEIM = new Set(['geboortedatum', 'mogelijk_geboortedatum']);
const CODE = 'import sys; sys.path.insert(0, sys.argv[1]); from socev_datum.cli import main; sys.exit(main(["--json"]))';

function dagNl(ms) {
  return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });   // JJJJ-MM-DD
}

function maak(opts) {
  const o = opts || {};
  const huidig = o.huidig || '/opt/data/scripts/huidig';
  const schaduwDir = o.schaduwDir || '/opt/data/scripts-staat/datum-schaduw';
  const python = o.python || '/usr/bin/python3';
  const nu = o.nu || Date.now;
  const fout = o.fout || function () {};
  const timeoutMs = o.timeoutMs || 10000;
  let lopend = 0;
  let laatsteVeeg = '';

  function detecteer(invoer) {
    return new Promise(function (klaar) {
      let rel;
      try { rel = fs.realpathSync(huidig); } catch (e) { return klaar({ status: 503, j: { ok: false, fout: 'scripts-release ontbreekt' } }); }
      const src = path.join(rel, 'packages', 'datum', 'src');
      if (!fs.existsSync(path.join(src, 'socev_datum', 'cli.py'))) return klaar({ status: 503, j: { ok: false, fout: 'detector ontbreekt in de release' } });
      const t0 = Date.now();
      const kind = spawn(python, ['-I', '-c', CODE, src], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let uit = '', err = '', af = false;
      kind.stdout.setEncoding('utf8');
      kind.stderr.setEncoding('utf8');
      const klok = setTimeout(function () { if (!af) { af = true; kind.kill('SIGKILL'); klaar({ status: 504, j: { ok: false, fout: 'detector te traag' } }); } }, timeoutMs);
      kind.stdout.on('data', function (c) { uit += c; if (uit.length > 20e6) kind.kill('SIGKILL'); });
      kind.stderr.on('data', function (c) { if (err.length < 4000) err += c; });
      kind.on('error', function (e) { if (af) return; af = true; clearTimeout(klok); fout('datums-start', e); klaar({ status: 500, j: { ok: false, fout: 'detector niet te starten' } }); });
      kind.on('close', function (code) {
        if (af) return;
        af = true; clearTimeout(klok);
        let j = null;
        try { j = JSON.parse(uit); } catch (e) { j = null; }
        if (code !== 0 || !j || j.ok === false) {
          if (code !== 2) fout('datums-detector', new Error('exit ' + code + ': ' + err.slice(-300)));
          return klaar({ status: code === 2 ? 400 : 500, j: { ok: false, fout: (j && j.fout) || 'detector faalde (exit ' + code + ')' } });
        }
        j.ok = true;
        j.release = path.basename(rel);
        j.duur_ms = Date.now() - t0;
        klaar({ status: 200, j: j });
      });
      kind.stdin.on('error', function () {});
      kind.stdin.end(JSON.stringify(invoer));
    });
  }

  function veeg(altijd) {
    const vandaag = dagNl(nu());
    if (!altijd && laatsteVeeg === vandaag) return;
    laatsteVeeg = vandaag;
    const grens = dagNl(nu() - BEWAAR_DAGEN * 86400000);
    let namen = [];
    try { namen = fs.readdirSync(schaduwDir); } catch (e) { return; }
    for (const n of namen) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(n);
      if (m && m[1] < grens) { try { fs.unlinkSync(path.join(schaduwDir, n)); } catch (e) { fout('datums-veeg', e); } }
    }
  }

  function schaduwRegel(s, j) {
    const id = String(s.mail_id || '');
    const ai = s.ai && typeof s.ai === 'object' ? s.ai : {};
    const geheimeDagen = new Set((j.treffers || []).filter(function (t) { return GEHEIM.has(t.rol) && t.start; })
      .map(function (t) { return String(t.start).slice(0, 10); }));
    let aiGeheim = false;
    const kort = function (v) {
      if (v == null || v === '') return null;
      const w = String(v).slice(0, 40);
      if (geheimeDagen.has(w.slice(0, 10))) { aiGeheim = true; return null; }
      return w;
    };
    const aiDatum = kort(ai.datum), parseDatum = kort(ai.parse_datum);
    return {
      ts: new Date(nu()).toISOString(),
      mail: id ? crypto.createHash('sha256').update(id).digest('hex').slice(0, 24) : null,
      versie: j.versie, release: j.release, anker: j.anker && j.anker.verzonden, duur_ms: j.duur_ms,
      ai: { datum: aiDatum, starttijd: ai.starttijd == null ? null : String(ai.starttijd).slice(0, 8), jaar_expliciet: ai.jaar_expliciet === true,
        parse_datum: parseDatum, geheim: aiGeheim },
      kandidaat: j.samenvatting ? j.samenvatting.inhoud_datum_kandidaat || null : null,
      treffers: (j.treffers || []).filter(function (t) { return !GEHEIM.has(t.rol); }).map(function (t) {
        return { b: t.begin, e: t.eind, soort: t.soort, start: t.start, eind: t.eind_waarde, precisie: t.precisie, jaar: t.jaar, rol: t.rol,
          zekerheid: t.zekerheid, regel: t.regel, let_op: t.let_op };
      }),
      geheim_weg: (j.treffers || []).filter(function (t) { return GEHEIM.has(t.rol); }).length,
    };
  }

  function schrijfSchaduw(regel) {
    fs.mkdirSync(schaduwDir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(schaduwDir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('schaduwmap is geen map');
    if ((st.mode & 0o777) !== 0o700) fs.chmodSync(schaduwDir, 0o700);
    const pad = path.join(schaduwDir, dagNl(nu()) + '.jsonl');
    const fd = fs.openSync(pad, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, JSON.stringify(regel) + '\n'); } finally { fs.closeSync(fd); }
    veeg();
  }

  // d = body: { tekst, anker?, taal?, soort?, schaduw?: { mail_id, ai: { datum, starttijd, jaar_expliciet, parse_datum } } }
  function verwerk(d) {
    if (!d || typeof d !== 'object') return Promise.resolve({ status: 400, j: { ok: false, fout: 'bad json' } });
    const tekst = d.tekst == null ? '' : String(d.tekst);
    if (tekst.length > MAX_TEKST) return Promise.resolve({ status: 413, j: { ok: false, fout: 'tekst langer dan ' + MAX_TEKST + ' tekens' } });
    const taal = d.taal == null || d.taal === '' ? 'auto' : String(d.taal);
    if (!/^(nl|en|auto)$/.test(taal)) return Promise.resolve({ status: 400, j: { ok: false, fout: 'taal moet nl, en of auto zijn' } });
    if (lopend >= MAX_TEGELIJK) return Promise.resolve({ status: 503, j: { ok: false, fout: 'bezet, probeer het zo opnieuw' } });
    lopend++;
    const anker = d.anker == null || d.anker === '' ? null : String(d.anker).slice(0, 64);
    return detecteer({ tekst: tekst, anker: anker, taal: taal, soort: d.soort == null ? null : String(d.soort).slice(0, 32) })
      .finally(function () { lopend--; })
      .then(function (r) {
        if (!d.schaduw || typeof d.schaduw !== 'object') return r;
        if (r.status !== 200) return r;
        try { schrijfSchaduw(schaduwRegel(d.schaduw, r.j)); } catch (e) { fout('datums-schaduw', e); return { status: 500, j: { ok: false, fout: 'schaduwlog niet te schrijven' } }; }
        return { status: 200, j: { ok: true, schaduw: true, aantal: (r.j.treffers || []).length, versie: r.j.versie, release: r.j.release } };
      });
  }

  try { veeg(true); } catch (e) { fout('datums-veeg', e); }
  if (o.veegElkeMs !== 0) {
    const t = setInterval(function () { try { veeg(true); } catch (e) { fout('datums-veeg', e); } }, o.veegElkeMs || 6 * 3600 * 1000);
    if (t.unref) t.unref();
  }
  return { verwerk: verwerk, veeg: veeg, info: function () { return { lopend: lopend, huidig: huidig }; } };
}

module.exports = { maak: maak, MAX_TEKST: MAX_TEKST };
