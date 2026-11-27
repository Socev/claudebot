'use strict';
// wv4173 (besluitenpagina nr 184 = 2C84; David Ja 25-11-2026 22:24): Studio — seintje na een lange taak (a), hint "geschikt voor 3D?"
// bij een heel album (b), "Nieuwste foto's" in de kiezer (c). De vaste lijst "Mijn 3D-scènes" (d) toetst test/studio-splat.sh (die heeft
// de nep-loper en echte scènes). Alle toetsdata verzonnen. Raakt /opt/data niet. Gebruik: node test/studio-wv4173.test.js
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), crypto = require('crypto');
process.chdir(path.join(__dirname, '..'));
const IM = require('../immich.js');
const studioMod = require('../studio.js');
let fout = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 10000); while (Date.now() < t) { if (await f()) return true; await slaap(20); } return false; }
const uuid = () => crypto.randomUUID();

(async () => {
  // ── c: witte lijst ──
  const a = uuid();
  const W = IM.weiger;
  toets('c1 tijdlijn zonder album: buckets order=desc&visibility=timeline toegestaan', W('GET', '/api/timeline/buckets', { order: 'desc', visibility: 'timeline' }) === null);
  toets('c2 tijdlijn zonder album: bucket met timeBucket toegestaan', W('GET', '/api/timeline/bucket', { timeBucket: '2026-11-01', order: 'desc', visibility: 'timeline' }) === null);
  const nee = [
    ['buckets zonder visibility', '/api/timeline/buckets', { order: 'desc' }],
    ['buckets leeg (oude toets)', '/api/timeline/buckets', {}],
    ['buckets archief', '/api/timeline/buckets', { order: 'desc', visibility: 'archive' }],
    ['buckets vergrendeld', '/api/timeline/buckets', { order: 'desc', visibility: 'locked' }],
    ['buckets asc', '/api/timeline/buckets', { order: 'asc', visibility: 'timeline' }],
    ['buckets + userId', '/api/timeline/buckets', { order: 'desc', visibility: 'timeline', userId: a }],
    ['buckets + withPartners', '/api/timeline/buckets', { order: 'desc', visibility: 'timeline', withPartners: 'true' }],
    ['buckets + personId', '/api/timeline/buckets', { order: 'desc', visibility: 'timeline', personId: a }],
    ['bucket zonder timeBucket', '/api/timeline/bucket', { order: 'desc', visibility: 'timeline' }],
    ['bucket + withCoordinates', '/api/timeline/bucket', { timeBucket: '2026-11-01', order: 'desc', visibility: 'timeline', withCoordinates: 'true' }],
    ['bucket + isFavorite', '/api/timeline/bucket', { timeBucket: '2026-11-01', order: 'desc', visibility: 'timeline', isFavorite: 'true' }],
    ['bucket rare datum', '/api/timeline/bucket', { timeBucket: '2026-11-01 OR 1', order: 'desc', visibility: 'timeline' }],
    ['bucket album + visibility', '/api/timeline/bucket', { albumId: a, timeBucket: '2026-11-01', order: 'desc', visibility: 'timeline' }],
  ];
  const fouten = nee.filter(([, p, q]) => W('GET', p, q) === null).map((x) => x[0]);
  toets('c3 elke andere vorm geweigerd (' + nee.length + ' varianten)', fouten.length === 0, fouten);
  toets('c4 album-vormen van vóór wv4173 ongewijzigd', W('GET', '/api/timeline/buckets', { albumId: a, order: 'asc' }) === null
    && W('GET', '/api/timeline/bucket', { albumId: a, timeBucket: '2020-02-01', order: 'asc', withCoordinates: 'true' }) === null
    && W('GET', '/api/timeline/buckets', { albumId: a, withCoordinates: 'true' }) === 'query');

  // ── c: nieuwsteFotos tegen een nep-Immich ──
  const ids = Array.from({ length: 70 }, uuid);
  const verzoeken = [];
  const bak = (from, n, extra) => {
    const l = ids.slice(from, from + n);
    return Object.assign({ id: l, isImage: l.map(() => true), isTrashed: l.map(() => false), visibility: l.map(() => 'timeline'), ratio: l.map(() => 1.333333),
      fileCreatedAt: l.map((_, i) => '2026-11-' + String(20 - Math.floor(i / 3)).padStart(2, '0') + 'T10:00:00.000'), localOffsetHours: l.map(() => 1) }, extra || {});
  };
  const b1 = bak(0, 10); b1.isImage[1] = false; b1.isTrashed[2] = true; b1.visibility[3] = 'archive'; b1.id[4] = 'geen-uuid';
  const BAKKEN = { '2026-11-01': b1, '2026-10-01': bak(10, 20), '2026-08-01': bak(30, 20), '2026-07-01': bak(50, 20) };
  const nepFetch = async (url, o) => {
    const u = new URL(url); verzoeken.push({ pad: u.pathname, q: Object.fromEntries(u.searchParams), m: (o && o.method) || 'GET' });
    const j = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/api/timeline/buckets' && u.searchParams.get('albumId')) return j([{ timeBucket: '2026-11-01', count: 4 }]);
    if (u.pathname === '/api/timeline/buckets') return j([{ timeBucket: '2026-11-01', count: 10 }, { timeBucket: '2026-10-01', count: 20 }, { timeBucket: '2026-09-01', count: 0 }, { timeBucket: '2026-08-01', count: 20 }, { timeBucket: '2026-07-01', count: 20 }]);
    if (u.pathname === '/api/timeline/bucket') {
      if (u.searchParams.get('albumId')) return j(ALBUM);
      return j(BAKKEN[u.searchParams.get('timeBucket')] || { id: [] });
    }
    return new Response('{}', { status: 404 });
  };
  const c = IM.maak({ basis: 'http://127.0.0.1:9', sleutel: async () => 'nep-sleutel', fetch: nepFetch });
  let n = await c.nieuwsteFotos(24);
  toets('c5 24 nieuwste: video, prullenbak, archief en ongeldig id overgeslagen; volgorde behouden', n.length === 24 && n[0].id === ids[0] && !n.some((x) => [ids[1], ids[2], ids[3]].includes(x.id))
    && n.every((x) => /^[0-9a-f-]{36}$/.test(x.id) && x.ratio === 1.333 && /^2026-11-\d\d$/.test(x.dag)), n.slice(0, 6));
  toets('c6 alleen GET op de twee tijdlijnpaden, met precies order=desc&visibility=timeline', verzoeken.every((v) => v.m === 'GET' && (v.pad === '/api/timeline/buckets' || v.pad === '/api/timeline/bucket')
    && v.q.order === 'desc' && v.q.visibility === 'timeline' && !('albumId' in v.q) && !('withCoordinates' in v.q)), verzoeken);
  verzoeken.length = 0;
  n = await c.nieuwsteFotos(60);
  toets('c7 hooguit drie maanden gelezen (lege maand telt niet), hooguit 60', verzoeken.filter((v) => v.pad === '/api/timeline/bucket').length === 3 && n.length === 46, [verzoeken.length, n.length]);
  toets('c8 geen namen, steden of coördinaten in het antwoord', n.every((x) => Object.keys(x).join(',') === 'id,ratio,dag'));

  // ── b: albumTijdPlek + oordeel ──
  const t0 = Date.parse('2026-11-17T09:00:00Z');
  let ALBUM = { id: [uuid(), uuid(), uuid(), uuid()], isImage: [true, false, true, true], isTrashed: [false, false, true, false],
    fileCreatedAt: ['2026-11-17T09:00:00.000', '2026-11-17T09:01:00.000', '2026-11-17T09:02:00.000', '2026-11-17T09:05:00.000'],
    latitude: [52.1, 52.1, 52.1, null], longitude: [5.2, 5.2, 5.2, null] };
  const tp = await c.albumTijdPlek(uuid(), 100);
  toets('b1 albumTijdPlek: video en prullenbak eruit, tijd als UTC, GPS null zonder', tp.length === 2 && tp[0].ms === t0 && tp[1].ms === t0 + 5 * 60000 && tp[1].lat === null && Object.keys(tp[0]).join(',') === 'ms,lat,lon', tp);
  const S0 = studioMod.maak({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'wv4173-s0-')), bewaar: () => ({ bestanden: [] }), primair: () => true, sleutel: async () => null, routerUrl: 'http://127.0.0.1:1', comfyUrl: 'http://127.0.0.1:1' });
  const O = S0._geschiktOordeel;
  const plek = (i, dm) => ({ lat: 52.1 + (dm || 0) / 111320, lon: 5.2 });
  const reeks = (k, stapMs, dm) => Array.from({ length: k }, (_, i) => Object.assign({ ms: t0 + i * stapMs }, dm === null ? { lat: null, lon: null } : plek(i, (dm || 0) * (i % 2))));
  let o = O(reeks(24, 15000, 5));
  toets('b2 24 foto\'s in 6 min op één plek: geschikt', o.oordeel === 'geschikt' && /24 foto's in 6 minuten op één plek: geschikt voor 3D\./.test(o.regel), o);
  o = O(reeks(20, 9 * 3600000 * 24 / 19, 5));
  toets('b3 over 9 dagen verspreid: waas', o.oordeel === 'waas' && /over 9 dagen verspreid: dit wordt waarschijnlijk een waas/.test(o.regel), o);
  o = O(reeks(20, 10000, 5000));
  toets('b4 kort na elkaar maar 5 km uit elkaar: waas (plek)', o.oordeel === 'waas' && /plekken tot/.test(o.regel), o);
  o = O(reeks(20, 6 * 3600000 / 19, 5));
  toets('b5 over 6 uur op één plek: twijfel', o.oordeel === 'twijfel' && /kan lukken/.test(o.regel), o);
  o = O(reeks(20, 10000, null));
  toets('b6 zonder GPS, kort na elkaar: geschikt (zonder "op één plek")', o.oordeel === 'geschikt' && !/één plek/.test(o.regel), o);
  o = O(reeks(1, 0, 0));
  toets('b7 één foto: te weinig', o.oordeel === 'te-weinig', o);
  o = O([{ ms: null, lat: null, lon: null }, { ms: null, lat: null, lon: null }, { ms: null, lat: null, lon: null }]);
  toets('b8 zonder opnametijd: onbekend', o.oordeel === 'onbekend', o);
  o = O(reeks(40, 10000, 5));
  toets('b9 40 foto\'s: "Socev kiest er 32 uit"', o.oordeel === 'geschikt' && /kiest er 32 uit/.test(o.regel), o);
  const weinigGps = reeks(10, 10000, null); weinigGps[0] = Object.assign({}, weinigGps[0], plek(0, 9000)); weinigGps[1] = Object.assign({}, weinigGps[1], plek(0, 0));
  o = O(weinigGps);
  toets('b10 GPS bij minder dan de helft: plek telt niet mee', o.oordeel === 'geschikt', o);
  o = O(reeks(10, 10000, 5).concat([Object.assign({ ms: t0 + 1000 }, plek(0, 50000))]));
  toets('b11 één uitschieter op 50 km: telt niet (80 %-straal)', o.oordeel === 'geschikt', o);
  toets('b12 antwoord zonder ids of coördinaten', Object.keys(o).sort().join(',') === 'n,oordeel,regel');
  S0.stopTimers();

  // ── a: seintje na een lange taak (nep-Piper; klok die we vooruit zetten) ──
  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'wv4173-a-'));
  const NEP = path.join(D, 'piper');
  // nep-Piper die wacht tot er een sein-bestand is (zo kan de toets de klok verzetten terwijl de taak loopt)
  fs.writeFileSync(NEP, '#!/bin/sh\nuit=""\nwhile [ $# -gt 0 ]; do [ "$1" = "--output_file" ] && uit="$2"; shift; done\ncat > "$uit.txt"\nwhile [ ! -e "' + D + '/door" ]; do sleep 0.05; done\nif [ -e "' + D + '/faal" ]; then exit 3; fi\nhead -c 4000 /dev/zero > "$uit"\n', { mode: 0o755 });
  fs.mkdirSync(path.join(D, 'studio', 'flows', 'pb'), { recursive: true });
  fs.writeFileSync(path.join(D, 'studio', 'flows', 'pb', 'flow.yaml'), JSON.stringify({ titel: 'pb', motor: 'piper', status: 'actief', uitvoer: 'geluid', velden: [{ naam: 'tekst', soort: 'tekstvak', verplicht: true }] }));
  let scheef = 0;
  const seintjes = [], foutjes = [];
  const nl = (h) => { const d = new Date(); const u = Number(d.toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false })) % 24; return ((h - u + 24) % 24) * 3600000; };
  const basisScheef = nl(12);   // de toets draait altijd "om 12 uur" (buiten de stille uren), tenzij hij de stille uren toetst
  const bewaar = (id, out) => ({ bestanden: fs.readdirSync(out).map((x, i) => ({ n: i + 1, naam: x, grootte: 1 })) });
  const S = studioMod.maak({ dir: path.join(D, 'studio'), bewaar, primair: () => true, sleutel: async () => null, routerUrl: 'http://127.0.0.1:1', comfyUrl: 'http://127.0.0.1:1',
    piper: { bin: NEP, model: '-', data: '-' }, nu: () => Date.now() + basisScheef + scheef, seintje: (id) => { seintjes.push(id); return Promise.resolve([]); },
    fout: (w, e) => foutjes.push(w + ': ' + (e && e.message)), log: () => {}, tempo: { poll: 30, wachtStap: 40, wachtMax: 1500 } });
  const ctx = { versOk: () => true, versVerbruik: () => {}, apparaat: 'toets' };
  let bn = 0; const nb = () => 'beurt-' + (++bn) + '-' + crypto.randomBytes(3).toString('hex');
  const draai = async (vooruitMs, faal, bron) => {
    try { fs.rmSync(path.join(D, 'door')); } catch (e) {}
    try { fs.rmSync(path.join(D, 'faal')); } catch (e) {}
    const r = await S.maak({ flow: 'pb', beurt_id: nb(), velden: { tekst: 'verzonnen proefzin' } }, ctx, bron ? { bron } : undefined);
    if (r.status !== 200) return { r };
    await totDat(() => S.taak(r.taak.id).status === 'bezig', 5000);
    scheef += vooruitMs;
    if (faal) fs.writeFileSync(path.join(D, 'faal'), '');
    fs.writeFileSync(path.join(D, 'door'), '');
    await totDat(() => ['klaar', 'mislukt', 'gestopt'].includes(S.taak(r.taak.id).status), 8000);
    await slaap(30);
    return { r, t: S.taak(r.taak.id) };
  };
  let x = await draai(0);
  toets('a1 korte taak (< 1 min): klaar, geen seintje', x.t && x.t.status === 'klaar' && seintjes.length === 0 && x.t.seintje === null, x.t && x.t.status);
  x = await draai(61000);
  toets('a2 taak van > 1 min klaar: precies één seintje met het taak-id', x.t.status === 'klaar' && seintjes.length === 1 && seintjes[0] === x.t.id && typeof x.t.seintje === 'string', [x.t.status, seintjes]);
  const takenJson = fs.readFileSync(path.join(D, 'studio', 'taken.json'), 'utf8');
  toets('a3 seintje bewaard in taken.json (na een herstart niet nog eens)', JSON.parse(takenJson).taken.find((y) => y.id === x.t.id).seintje === x.t.seintje);
  x = await draai(61000, true);
  toets('a4 lange taak mislukt: ook één seintje', x.t.status === 'mislukt' && seintjes.length === 2 && seintjes[1] === x.t.id, [x.t.status, seintjes]);
  // gestopt: stop terwijl hij loopt
  try { fs.rmSync(path.join(D, 'door')); } catch (e) {}
  const rS = await S.maak({ flow: 'pb', beurt_id: nb(), velden: { tekst: 'verzonnen stopzin' } }, ctx);
  await totDat(() => S.taak(rS.taak.id).status === 'bezig', 5000);
  scheef += 61000; S.stop(rS.taak.id);
  await totDat(() => ['klaar', 'mislukt', 'gestopt'].includes(S.taak(rS.taak.id).status), 8000);
  toets('a5 lange taak die David zelf stopte: geen seintje', S.taak(rS.taak.id).status === 'gestopt' && seintjes.length === 2, [S.taak(rS.taak.id).status, seintjes]);
  x = await draai(61000, false, { soort: 'bandje', praktijk: 'proefpraktijk', bandje: 'tg-proef', versie: 1, tekst_hash: 'abcdef12' });
  toets('a6 taak met bron (Bandjes heeft zijn eigen kaart): geen seintje', x.t && x.t.status === 'klaar' && seintjes.length === 2, [x.r && x.r.status, x.r && x.r.fout, x.t && x.t.status, seintjes]);
  scheef += nl(2) - nl(12) + 0;   // naar 02:00 Nederlandse tijd
  x = await draai(61000);
  toets('a7 stille uren (23–07): geen seintje', x.t.status === 'klaar' && seintjes.length === 2 && x.t.seintje === null, [x.t.status, seintjes]);
  toets('a8 geen fouten in de foutlog', foutjes.length === 0, foutjes);
  S.stopTimers();
  fs.rmSync(D, { recursive: true, force: true });

  // ── a: landing van de tik (server.js appSeintjeTab) ──
  const s = fs.readFileSync('server.js', 'utf8');
  const blok = (kop) => {
    const i = s.indexOf(kop); if (i < 0) return '';
    let j = s.indexOf('{', i), d = 0;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (ch === "'" || ch === '"' || ch === '`') { const q = ch; j++; while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; } continue; }
      if (ch === '/' && s[j + 1] === '/') { j = s.indexOf('\n', j); continue; }
      if (ch === '/' && s[j + 1] === '*') { j = s.indexOf('*/', j) + 1; continue; }
      if (ch === '{') d++; else if (ch === '}') { d--; if (d === 0) break; }
    }
    return s.slice(i, j + 1);
  };
  let push = { apparaten: { px: { laatst: { op: new Date().toISOString(), status: 201, reden: 'studio 0123456789abcdef' } } } };
  const vctx = { appPushLees: () => push, APP_SEINTJE_TAB_MS: 600000, codeIdVanKanaal: () => null, Date, Object, String };
  vm.createContext(vctx);
  vm.runInContext([blok('const APP_SEINTJE_DOEL = {'), blok('const APP_SEINTJE_EXTRA_DOEL = {'), blok('function appSeintjeTab(')].join(';\n') + ';\nthis.__f = appSeintjeTab;', vctx);
  const st = vctx.__f('px');
  toets('a9 tik op het Studio-seintje: scherm studio, focus = de taak', !!st && st.tab === 'studio' && st.doel.scherm === 'studio' && st.doel.focus === '0123456789abcdef', st);
  push.apparaten.px.laatst.reden = 'studio 0123';
  toets('a10 vreemde Studio-reden: geen doel', vctx.__f('px') === null);
  push.apparaten.px.laatst.reden = 'antwoord hoofd';
  toets('a11 gewone seintjes ongewijzigd', vctx.__f('px').doel.scherm === 'hoofd');
  toets('a12 server.js: seintje-dep gaat via appPushAlle met reden studio <taak>, alleen appPushMag', /seintje: function \(taakId\) \{ return \/\^\[a-f0-9\]\{16\}\$\/\.test\(String\(taakId\)\) \? appPushAlle\('antwoord', 'studio ' \+ taakId, function \(id\) \{ return appPushMag\(id\); \}/.test(s));

  console.log('\n' + goed + ' groen, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.log('ROOD  toets brak af: ' + (e && e.stack)); process.exit(1); });
