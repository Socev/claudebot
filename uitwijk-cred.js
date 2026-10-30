'use strict';
/**
 * uitwijk-cred.js — nachtketen-stap uitwijk-cred (wv2041, 30-10-2026; ontwerp machinekamer mk-scripts/wv2037/ontwerp.md, Opus-review GO
 * met voorwaarden; Ja David 30-10-2026 17:19, app-knop met vingerafdruk).
 *
 * WAAROM. De R230 (koude uitwijk) importeert bij `uitwijk naar-vps` het bestand /etc/uitwijk/credentials-export.json: de n8n-credentials,
 * versleuteld met N8N_ENCRYPTION_KEY (nooit --decrypted). Die export maakte David met de hand in de n8n-terminal; in de week van
 * 23–30 okt vijf keer. Nu zet de pod hem elke nacht zelf over, zodat het gat bij een uitwijk hooguit een dag is.
 *
 * WAT. Eén keer per Nederlandse datum, rond 03:10 (na het versiebriefje van 02:45, vóór uitwijk-sync 03:30), alleen op de Olares-kant:
 *   1. `olares-eigen n8n-cred-export` → de export als bytes in het geheugen (geen bestand op de pod);
 *   2. poort, alles of niets: JSON-array, elk data-veld CryptoJS-versleuteld, id's uniek, updatedAt leesbaar; aantal en id-set gelijk aan
 *      GET /api/v1/credentials (alle pagina's); wijkt de telling af, één nieuwe poging na 1 min (een credential die net wijzigde);
 *   3. `ssh r230 sudo -n …/uitwijk-sync cred-stand`: gelijk sha256 (export én ijking) → klaar ("ongewijzigd");
 *   4. anders `… cred-zet <sha256>` met de export op stdin (de R230 toetst sha en poort opnieuw, zet atomair neer en ijkt op de export),
 *      daarna opnieuw cred-stand: beide sha's moeten gelijk zijn ("vernieuwd").
 * Groen = hartslag uitwijk_cred (48 u). Rood = één box-rij #uitwijk-cred-auto per soort per dag (geen kaart; een verlopen Olares-login
 * meldt olares-login-check al). Uitvoer en log: alleen aantallen, sha256[:12], tijden — nooit data, nooit de JSON, nooit stderr.
 * Alles wat de pod raakt (olares-eigen, ssh, n8n-API, box, hartslag, klok) komt als functie of pad binnen: test/uitwijk-cred.test.js
 * draait het met nep-gereedschap.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9]{8,32}$/;
const MAX_EXPORT = 5 * 1024 * 1024;   // gelijk aan de grens van cred-zet op de R230 (gemeten 30-10: 34 KB)

// Start een programma zonder shell; stdout als Buffer (begrensd), stderr alleen om de laatste regel te lezen (nooit gelogd).
function draai(bin, args, opt) {
  opt = opt || {};
  return new Promise(function (klaar) {
    let p;
    try { p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: opt.env || process.env }); } catch (e) { klaar({ code: 127, stdout: Buffer.alloc(0), stderr: '' }); return; }
    const uit = [], fout = []; let n = 0, te = false, klaarGemeld = false;
    const tijd = setTimeout(function () { te = true; try { p.kill('SIGKILL'); } catch (e) { /* al weg */ } }, opt.timeout || 60000);
    p.stdout.on('data', function (b) { n += b.length; if (n > (opt.max || MAX_EXPORT + 1)) { te = true; try { p.kill('SIGKILL'); } catch (e) { /* al weg */ } } else uit.push(b); });
    p.stderr.on('data', function (b) { if (fout.length < 64) fout.push(b); });
    p.stdin.on('error', function () { /* proces las niet alles: code telt */ });
    p.on('error', function () { if (!klaarGemeld) { klaarGemeld = true; clearTimeout(tijd); klaar({ code: 127, stdout: Buffer.alloc(0), stderr: '' }); } });
    p.on('close', function (code) {
      if (klaarGemeld) return; klaarGemeld = true; clearTimeout(tijd);
      klaar({ code: te ? 124 : (typeof code === 'number' ? code : 1), stdout: Buffer.concat(uit), stderr: Buffer.concat(fout).toString('utf8') });
    });
    p.stdin.end(opt.invoer || undefined);
  });
}

// Laatste JSON-regel van stderr (olares-eigen: {"uitkomst": …}); alleen de vaste velden, nooit vrije tekst doorgeven.
function stderrUitkomst(t) {
  const r = String(t || '').trim().split('\n').pop();
  try { const j = JSON.parse(r); return /^[a-z_]{2,20}$/.test(String(j.uitkomst || '')) ? j.uitkomst : null; } catch (e) { return null; }
}

// Poort (dubbel met olares-eigen en de R230): { ok, regel, ids, n }. De regel noemt nooit inhoud.
function poort(buf) {
  if (!buf.length) return { ok: false, regel: 'lege uitvoer' };
  if (buf.length > MAX_EXPORT) return { ok: false, regel: 'groter dan 5 MB' };
  let d; try { d = JSON.parse(buf.toString('utf8')); } catch (e) { return { ok: false, regel: 'geen json' }; }
  if (!Array.isArray(d) || !d.length) return { ok: false, regel: 'geen niet-lege array' };
  const ids = new Set();
  for (let i = 0; i < d.length; i++) {
    const r = d[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, regel: 'rij ' + i + ': geen object' };
    if (!['id', 'name', 'type'].every(function (k) { return typeof r[k] === 'string' && r[k]; })) return { ok: false, regel: 'rij ' + i + ': id/name/type geen tekst' };
    if (!ID_RE.test(r.id) || ids.has(r.id)) return { ok: false, regel: 'rij ' + i + ': id ongeldig of dubbel' };
    ids.add(r.id);
    if (typeof r.data !== 'string' || !r.data.startsWith('U2FsdGVkX1') || r.data.length < 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.data)) return { ok: false, regel: 'rij ' + i + ': data niet versleuteld' };
    if (!Number.isFinite(Date.parse(r.updatedAt))) return { ok: false, regel: 'rij ' + i + ': updatedAt onleesbaar' };
  }
  return { ok: true, ids: ids, n: d.length };
}

function leesJson(p, standaard) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return standaard; } }
function schrijfAtomair(p, inhoud) {
  const tmp = p + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, inhoud, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/*
 * o = { olaresEigen (pad), ssh (pad, 'ssh'), sshArgs (['-o','BatchMode=yes','-o','ConnectTimeout=30','r230']), sync ('/srv/uitwijk/vps/bin/uitwijk-sync'),
 *       kant() → 'olares'|'vps'|…, apiIds() → Promise<string[]> (alle pagina's), staatBestand, boxRij(tekst) → bool, hartslag({n, bevindingen}) → Promise,
 *       klok() → 'HH:MM', wacht(ms) → Promise, herkansMs (60000) }
 */
function maak(o) {
  const sshArgs = o.sshArgs || ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', 'r230'];
  const sync = o.sync || '/srv/uitwijk/vps/bin/uitwijk-sync';
  const wacht = o.wacht || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const herkansMs = o.herkansMs === undefined ? 60000 : o.herkansMs;

  function r230(werkwoord, invoer, timeout) {
    return draai(o.ssh || 'ssh', sshArgs.concat(['sudo -n ' + sync + ' ' + werkwoord]), { invoer: invoer, timeout: timeout || 60000, max: 64 * 1024 });
  }
  async function stand() {
    const r = await r230('cred-stand', null, 60000);
    if (r.code !== 0) return { fout: 'r230-stand', reden: 'cred-stand op de R230 faalde (exit ' + r.code + ')' };
    let j; try { j = JSON.parse(r.stdout.toString('utf8').trim().split('\n').pop()); } catch (e) { j = null; }
    if (!j || j.protocol !== 'uitwijk-cred-v1') return { fout: 'r230-stand', reden: 'cred-stand onleesbaar of oud protocol (R230-kloon bijwerken?)' };
    if (!/^[0-9a-f]{40}$/.test(String(j.repo_sha || ''))) return { fout: 'r230-stand', reden: 'cred-stand zonder repo-sha' };
    if (j.uitwijk_actief === true) return { fout: 'r230-actief', reden: 'merkteken uitwijk-actief staat op de R230: niets overgezet' };
    return { j: j };
  }
  async function export_() {
    const r = await draai(o.olaresEigen, ['n8n-cred-export'], { timeout: 300000, max: MAX_EXPORT + 1 });
    if (r.code !== 0) return { fout: 'export', reden: 'olares-eigen n8n-cred-export: ' + (stderrUitkomst(r.stderr) || 'exit ' + r.code) };
    const p = poort(r.stdout);
    if (!p.ok) return { fout: 'poort', reden: 'export weigert de poort (' + p.regel + ')' };
    let api;
    try { api = await o.apiIds(); } catch (e) { return { fout: 'api', reden: 'n8n-API-telling mislukt (' + String(e && e.message || e).slice(0, 40) + ')' }; }
    const a = new Set(api);
    const gelijk = a.size === p.ids.size && api.length === a.size && [...a].every(function (id) { return p.ids.has(id); });
    if (!gelijk) return { fout: 'telling', reden: 'export ' + p.n + ' ≠ n8n-API ' + api.length + ' (id-set wijkt af)', herkans: true };
    return { buf: r.stdout, n: p.n, sha: crypto.createHash('sha256').update(r.stdout).digest('hex') };
  }
  async function poging() {
    let e = await export_();
    if (e.herkans) { await wacht(herkansMs); e = await export_(); }
    if (e.fout) return e;
    const s1 = await stand();
    if (s1.fout) return s1;
    const det = { n: e.n, sha12: e.sha.slice(0, 12), repo12: s1.j.repo_sha.slice(0, 12) };
    if (s1.j.export_sha256 === e.sha && s1.j.ijk_sha256 === e.sha) return { ok: true, detail: Object.assign(det, { uitkomst: 'ongewijzigd' }) };
    const z = await r230('cred-zet ' + e.sha, e.buf, 120000);
    e.buf.fill(0);
    if (z.code !== 0) return { fout: 'r230-zet', reden: 'cred-zet op de R230 faalde (exit ' + z.code + (z.code === 75 ? ': sync.lock bezet' : z.code === 3 ? ': uitwijk actief' : '') + ')' };
    const s2 = await stand();
    if (s2.fout) return s2;
    if (s2.j.export_sha256 !== e.sha || s2.j.ijk_sha256 !== e.sha) return { fout: 'r230-nameting', reden: 'na cred-zet is de stand op de R230 niet gelijk (export ' + String(s2.j.export_sha256).slice(0, 12) + ', ijking ' + String(s2.j.ijk_sha256).slice(0, 12) + ')' };
    return { ok: true, detail: Object.assign(det, { uitkomst: 'vernieuwd', vorige12: String(s1.j.export_sha256 || '').slice(0, 12) || null }) };
  }

  function meld(soort, reden, datum) {
    const st = leesJson(o.staatBestand, {});
    st.gemeld = st.gemeld || {};
    if (st.gemeld[soort] === datum) return false;   // één rij per soort per dag (grondwet 10)
    const klok = typeof o.klok === 'function' ? o.klok() : '';
    const ok = o.boxRij('\n## [uitwijk-cred] ' + datum + ' ' + klok + ' — n8n-credentials niet naar de R230: ' + soort + ' (automatisch, wv2041) #uitwijk-cred-auto\n' +
      '- status: open\n- van: pod (nachtketen, stap uitwijk-cred)\n' +
      '- gemeten: ' + String(reden).slice(0, 300) + '.\n' +
      '- gevolg als er niets gebeurt: de R230 houdt de export van de vorige keer; uitwijk-sync 03:30 meldt dan "credentials-export vernieuwen" als er sindsdien iets wijzigde. Morgennacht opnieuw.\n' +
      '- voorstel: olares-eigen.log (regel n8n-cred-export), sync.log op de R230 (cred-zet) en /health.nachtketen nalopen; handmatig opnieuw: node uitwijk-cred.js ronde (machinekamer).\n');
    if (ok) { st.gemeld[soort] = datum; schrijfAtomair(o.staatBestand, JSON.stringify(st)); }
    return ok;
  }

  async function ronde(ctx) {
    const datum = ctx && ctx.datum;
    if (!DATUM_RE.test(String(datum || ''))) return { ok: false, reden: 'datum ongeldig' };
    const kant = typeof o.kant === 'function' ? o.kant() : 'olares';
    if (kant !== 'olares') return { ok: true, al_gedaan: true, detail: { kant: String(kant).slice(0, 12) } };   // rolpoort: alleen de Olares-kant
    const st = leesJson(o.staatBestand, {});
    if (st.ok_datum === datum && !(ctx && ctx.forceer)) return { ok: true, al_gedaan: true };
    const r = await poging();
    if (r.fout) { meld(r.fout, r.reden, datum); return { ok: false, reden: r.fout + ': ' + String(r.reden).slice(0, 120) }; }
    const st2 = leesJson(o.staatBestand, {});
    st2.ok_datum = datum; st2.laatste = Object.assign({ t: new Date().toISOString() }, r.detail);
    schrijfAtomair(o.staatBestand, JSON.stringify(st2));
    try { await o.hartslag({ n: r.detail.n, bevindingen: 0 }); } catch (e) { /* hartslag mislukt: de 48 u-drempel meldt het */ }
    return { ok: true, detail: r.detail };
  }
  return { ronde: ronde, poort: poort };
}

module.exports = { maak: maak, poort: poort };

// Handmatig (machinekamer): node uitwijk-cred.js ronde [--forceer] — dezelfde ronde als de nachtketen, met de echte paden; uitvoer alleen de
// uitkomst (aantallen, sha12). Box en hartslag: zoals 's nachts.
if (require.main === module) {
  const arg = process.argv.slice(2);
  if (arg[0] !== 'ronde' || arg.slice(1).some(function (x) { return x !== '--forceer'; })) { console.error('gebruik: node uitwijk-cred.js ronde [--forceer]'); process.exit(64); }
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const basis = String(process.env.N8N_API_URL || process.env.N8N_MCP_URL || '').replace(/\/mcp.*$/, '').replace(/\/$/, '');
  const m = maak({ olaresEigen: '/opt/data/bin/olares-eigen', kant: function () { return process.env.SOCEV_KANT || 'olares'; },
    staatBestand: process.env.UITWIJK_CRED_STAAT || '/opt/data/scripts-staat/klokken/uitwijk-cred.json',   // zelfde als server.js (KLOKKEN_DIR)
    apiIds: async function () {
      const ids = []; let cursor = null;
      for (let i = 0; i < 20; i++) {
        const r = await fetch(basis + '/api/v1/credentials?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY || '' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('n8n http ' + r.status);
        const j = await r.json(); for (const c of j.data || []) ids.push(c.id); cursor = j.nextCursor; if (!cursor) return ids;
      }
      throw new Error('meer dan 20 pagina\'s');
    },
    boxRij: function (t) { process.stderr.write('(box-rij niet geschreven bij een handmatige ronde)\n' + t.split('\n').slice(1, 2).join('') + '\n'); return false; },
    hartslag: async function () { /* handmatig: geen hartslag */ }, klok: function () { return new Date().toISOString().slice(11, 16) + 'Z'; } });
  m.ronde({ datum: d, forceer: arg.includes('--forceer') }).then(function (r) { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); });
}
