#!/usr/bin/env bash
# Toetst de Tibber Data API-koppeling (wv2625, 7-11-2026): tibber-data.js (witte lijst, tokens, slot, noodkopie, historie) en het
# Tibber-blok van server.js (GET /tibber/terug, POST /smal/tibber, kluis via de Management-API). Alles tegen een nagebootste
# tokenserver en Data API op 127.0.0.1 en een nagebootste kluis; verzonnen gegevens. Raakt de pod, de kluis en /opt/data/tibber niet.
# Faaltoetsen uit het bouwplan (review ZOU 2): state hergebruik → 404, verkeerde/ontbrekende/extra scope → geweigerd, rotatie schrijft
# vóór gebruik, invalid_grant → één melding zonder herhaling, POST naar de Data API → geweigerd, locatieveld → niet opgeslagen,
# kluisschrijven faalt na refresh → noodkopie en de volgende ronde herstelt, proces stopt vóór opslag, twee rondes tegelijk → één stopt,
# redirect → geweigerd, api.log zonder code of state. Gebruik: bash test/tibber-data.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), http = require('http'), vm = require('vm');
const { spawn } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'tibber-'));
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const SCRIPT = path.resolve('tibber-data.js');
const T = require(SCRIPT);
const SCOPES = T.SCOPES.join(' ');
const VIN = 'WVWZZZ1KZAW000017', NAAM = 'Auto van Testpersoon', LAT = 52.1234567;

// ── nagebootste tokenserver + Data API ──────────────────────────────────────────────────────────────────────────────
const M = { log: [], refreshGeldig: new Set(['rt-start-0000000001']), scope: SCOPES, teller: 0, homesRedirect: false, fout429: 0, homes400: false };
function tok(n) { return 'rt-' + 'x'.repeat(10) + String(n).padStart(8, '0'); }
const srv = http.createServer(function (req, res) {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', function () {
    const u = new URL(req.url, 'http://x'), stuur = (st, j, h) => { res.writeHead(st, Object.assign({ 'Content-Type': 'application/json' }, h || {})); res.end(JSON.stringify(j)); };
    M.log.push({ t: Date.now(), m: req.method, p: u.pathname, q: u.search, ua: req.headers['user-agent'] });
    if (u.pathname === '/connect/token') {
      if (req.method !== 'POST') return stuur(405, {});
      const f = new URLSearchParams(body);
      if (f.get('client_id') !== 'cid-proef-0001' || f.get('client_secret') !== 'geheim-proef-0001') return stuur(401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code') {
        if (f.get('code') !== 'code-goed' || f.get('redirect_uri') !== T.REDIRECT || !/^[A-Za-z0-9_-]{43,128}$/.test(f.get('code_verifier') || '')) return stuur(400, { error: 'invalid_grant' });
        M.verifier = f.get('code_verifier');
        const n = ++M.teller; M.refreshGeldig.add(tok(n));
        return stuur(200, { access_token: 'at-' + 'a'.repeat(30) + n, refresh_token: tok(n), expires_in: 3600, token_type: 'Bearer', scope: M.scope, id_token: 'id.' + Buffer.from(JSON.stringify({ email: 'proef@voorbeeld.nl' })).toString('base64url') + '.x' });
      }
      if (f.get('grant_type') === 'refresh_token') {
        M.gebruikt = f.get('refresh_token');
        if (!M.refreshGeldig.has(M.gebruikt)) return stuur(400, { error: 'invalid_grant' });
        M.refreshGeldig.delete(M.gebruikt);   // eenmalig
        const n = ++M.teller; M.refreshGeldig.add(tok(n));
        return stuur(200, { access_token: 'at-' + 'a'.repeat(30) + n, refresh_token: tok(n), expires_in: 3600, scope: M.scope });
      }
      return stuur(400, { error: 'unsupported_grant_type' });
    }
    if (!/^Bearer at-/.test(req.headers.authorization || '')) return stuur(401, {});
    if (u.pathname === '/v1/homes') {
      if (M.homesRedirect) { res.writeHead(302, { Location: 'http://127.0.0.1:' + srv.address().port + '/elders' }); return res.end(); }
      if (M.fout429 > 0) { M.fout429--; return stuur(429, {}, { 'Retry-After': '1' }); }
      if (M.homes400) return stuur(400, { title: 'fout' });
      return stuur(200, { homes: [{ id: 'home-1', name: 'Teststraat 1' }] });
    }
    if (u.pathname === '/v1/homes/home-1/devices') return stuur(200, { devices: [{ id: 'dev-auto-1', externalId: VIN, info: { name: NAAM, brand: 'Volkswagen', model: 'ID.3' }, supportedHistory: { resolutions: ['hour', 'day'], maxRetentionDays: 3 } }] });
    if (u.pathname === '/v1/homes/home-1/devices/dev-auto-1') return stuur(200, { id: 'dev-auto-1', externalId: VIN, info: { name: NAAM, brand: 'Volkswagen', model: 'ID.3' },
      supportedHistory: { resolutions: ['hour', 'day'], maxRetentionDays: 3 }, status: { lastSeen: '2026-11-07T10:00:00+01:00' },
      attributes: [{ $type: 'string', id: 'vin', value: VIN }, { $type: 'string', id: 'location', value: '52.1,5.3' }],
      capabilities: [{ $type: 'float', id: 'storage.stateOfCharge', value: 61, unit: '%' }, { $type: 'float', id: 'charging.power', value: 0, unit: 'kW' }] });
    if (u.pathname === '/v1/homes/home-1/devices/dev-auto-1/history') {
      const cur = u.searchParams.get('cursor');
      const pagina = cur ? Number(cur.replace('p', '')) : 1;
      const items = pagina <= 2 ? [0, 1, 2].map((i) => ({ time: new Date(Date.UTC(2026, 10, 5, (pagina - 1) * 3 + i)).toISOString(),
        data: { energyConsumed: 1.5 + i, chargingState: 'charging', stateOfCharge: 40 + i, location: { latitude: LAT, longitude: 5.1 }, vin: VIN, name: NAAM, lat: LAT, odometer: 12345, tags: ['x'] } })) : [];
      const basis = 'https://data-api.tibber.com/v1/homes/home-1/devices/dev-auto-1/history';
      const next = pagina === 1 ? basis.replace('https://data-api.tibber.com', 'http://127.0.0.1:' + srv.address().port) + '?cursor=p2' : pagina === 2 ? '/v1/homes/home-1/devices/dev-auto-1/history?cursor=p3' : (M.vreemdeNext ? 'https://elders.example/x?cursor=p9' : '');
      return stuur(200, { query: { resolution: 'hour', effectiveStart: 'x', effectiveEnd: 'y', pageSize: 3 }, items: items, next: next });
    }
    stuur(404, {});
  });
});

// ── nagebootste kluis (deps voor de module; fetch voor server.js) ────────────────────────────────────────────────────
const K = { rij: { tibber_data_client_id: 'cid-proef-0001', tibber_data_client_secret: 'geheim-proef-0001' }, zetFout: 0, zetten: [], leesFout: false, queries: [] };
function kluisDeps(dir, extra) {
  return Object.assign({ dir: dir, wacht: async () => {},
    kluisLees: async () => { if (K.leesFout) throw new Error('weg'); return { client_id: K.rij.tibber_data_client_id || '', client_secret: K.rij.tibber_data_client_secret || '', refresh: K.rij.tibber_data_refresh || '' }; },
    kluisZet: async (w) => { K.zetten.push({ t: Date.now(), w: w }); if (K.zetFout > 0) { K.zetFout--; throw new Error('kluis weg'); } K.rij.tibber_data_refresh = w; return sha(w); },
    kind: kindEcht }, extra || {});
}
let ENV;
function kindEcht(opdracht, invoer, dir) {
  return new Promise(function (klaar) {
    const k = spawn(process.execPath, ['--no-warnings', SCRIPT, opdracht], { env: Object.assign({}, ENV, dir ? { TIBBER_DIR: dir } : {}), stdio: ['pipe', 'pipe', 'pipe'] });
    let uit = '', fout = '';
    k.stdout.on('data', (c) => uit += c); k.stderr.on('data', (c) => fout += c);
    k.on('close', function (code) { let j = null; try { j = JSON.parse(uit.trim().split('\n').pop()); } catch (e) {} klaar({ code: code, j: j, stderr: fout }); });
    k.stdin.end(JSON.stringify(invoer));
  });
}

srv.listen(0, '127.0.0.1', async function () {
  const BASIS = 'http://127.0.0.1:' + srv.address().port;
  const DIR = path.join(W, 'tibber');
  ENV = { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', TIBBER_DIR: DIR, TIBBER_AUTH_BASIS: BASIS, TIBBER_API_BASIS: BASIS, TIBBER_PAUZE_MS: '0' };
  process.env.TIBBER_AUTH_BASIS = BASIS; process.env.TIBBER_API_BASIS = BASIS;   // voor de module in dit proces (verzoekToets)
  delete require.cache[SCRIPT];
  const TM = require(SCRIPT);
  try {
    // 1. witte lijst van verzoeken
    const weigert = (m, u) => { try { TM.verzoekToets(m, u); return false; } catch (e) { return e.reden === 'pad'; } };
    toets('POST naar de Data API geweigerd', weigert('POST', BASIS + '/v1/homes'));
    toets('GET op het tokenendpoint geweigerd', weigert('GET', BASIS + '/connect/token'));
    toets('DELETE/PUT geweigerd', weigert('DELETE', BASIS + '/v1/homes') && weigert('PUT', BASIS + '/v1/homes'));
    toets('prijzen/live-events niet op de lijst', weigert('GET', BASIS + '/v1/homes/h/prices') && weigert('GET', BASIS + '/v1/homes/h/live-events'));
    toets('andere host geweigerd', weigert('GET', 'https://elders.example/v1/homes') && weigert('POST', 'https://elders.example/connect/token'));
    toets('query op /v1/homes geweigerd', weigert('GET', BASIS + '/v1/homes?x=1'));
    toets('onbekende historieparameter geweigerd', weigert('GET', BASIS + '/v1/homes/h/devices/d/history?pageSize=9'));
    toets('historie met since/resolution mag', !weigert('GET', BASIS + '/v1/homes/h/devices/d/history?since=2026-11-01T00:00:00Z&resolution=hour'));
    toets('pad met .. geweigerd', weigert('GET', BASIS + '/v1/homes/../connect/token'));
    const src = fs.readFileSync(SCRIPT, 'utf8').split('\n').filter((r) => !/^\s*(\*|\/\/)/.test(r)).join('\n');
    toets('één fetch in tibber-data.js, met redirect error', (src.match(/\bfetch\(/g) || []).length === 1 && /redirect: 'error'/.test(src));
    toets('geen eigen netwerk- of procesmodule', !/require\('(node:)?(http|https|net|tls|child_process|dgram)'\)/.test(src));
    toets('toetsbasis alleen 127.0.0.1', (() => { const r = spawn; try { require('child_process').execFileSync(process.execPath, [SCRIPT, 'stand'], { env: { PATH: process.env.PATH, TIBBER_API_BASIS: 'http://10.0.0.1:80', TIBBER_DIR: path.join(W, 'x') }, input: '{}', stdio: 'pipe' }); return false; } catch (e) { return true; } })());

    // 2. veldfilter
    const p = TM.plat({ energyConsumed: 2, chargingState: 'charging', location: { latitude: 1 }, lat: 1, vin: 'X', name: 'Y', odometer: 9, power: { avg: 3 }, positionLat: 2, accumulatedEnergy: 4 });
    const namen = p.velden.map((v) => v[0]);
    toets('energie, laadstand en genest vermogen bewaard', namen.includes('energyConsumed') && namen.includes('chargingState') && namen.includes('power.avg') && namen.includes('accumulatedEnergy'), namen);
    toets('locatie, lat, vin, naam, kilometerstand niet bewaard', !namen.some((n) => /location|^lat$|vin|name|odometer|position/i.test(n)), namen);
    toets('onbekende velden alleen als naam', [...p.onbekend].includes('location{}') && [...p.onbekend].includes('vin'), [...p.onbekend]);
    toets('scopes exact: gelijk ja, ontbrekend nee, extra nee', TM.scopesExact(T.SCOPES.slice()) && !TM.scopesExact(T.SCOPES.slice(1)) && !TM.scopesExact(T.SCOPES.concat(['data-api-prices-read'])));

    // 3. link en state
    const l = TM.linkMaak(DIR, 'cid-proef-0001');
    const lu = new URL(l.url), st = lu.searchParams.get('state');
    toets('link: authorize-endpoint, S256, exacte scopes, redirect', lu.origin + lu.pathname === 'https://thewall.tibber.com/connect/authorize' && lu.searchParams.get('code_challenge_method') === 'S256' &&
      lu.searchParams.get('scope') === SCOPES && lu.searchParams.get('redirect_uri') === 'https://bank.socev.dev/tibber/terug' && /^[0-9a-f]{64}$/.test(st));
    toets('states.json 600 en zonder de state zelf', (fs.statSync(path.join(DIR, 'states.json')).mode & 0o777) === 0o600 && fs.readFileSync(path.join(DIR, 'states.json'), 'utf8').indexOf(st) < 0);
    fs.chmodSync(DIR, 0o755); TM.slotNeem(DIR); TM.slotLos(DIR);
    toets('dir 700, ook als hij ruimer bestond', (fs.statSync(DIR).mode & 0o777) === 0o700);
    toets('state open', TM.stateOpen(DIR, st));
    toets('onbekende state dicht', !TM.stateOpen(DIR, 'a'.repeat(64)));
    // verlopen state (49 uur)
    const l2 = TM.linkMaak(DIR, 'cid-proef-0001'), st2 = new URL(l2.url).searchParams.get('state');
    const s = JSON.parse(fs.readFileSync(path.join(DIR, 'states.json'), 'utf8')); s[sha(st2)].sinds = new Date(Date.now() - 49 * 3600000).toISOString(); fs.writeFileSync(path.join(DIR, 'states.json'), JSON.stringify(s));
    toets('state na 48 uur dicht', !TM.stateOpen(DIR, st2));

    // 4. terugkeer: verkeerde scope → niets bewaard
    M.scope = T.SCOPES.slice(0, -1).join(' ');   // chargers ontbreekt
    let u = await TM.terug(kluisDeps(DIR), st, 'code-goed', '');
    toets('ontbrekende scope → geweigerd, niets in de kluis', u.soort === 'scope' && !K.rij.tibber_data_refresh && !TM.noodLees(DIR), u);
    toets('state na weigering verbruikt', !TM.stateOpen(DIR, st));
    M.scope = SCOPES + ' data-api-prices-read';
    const st3 = new URL(TM.linkMaak(DIR, 'cid-proef-0001').url).searchParams.get('state');
    u = await TM.terug(kluisDeps(DIR), st3, 'code-goed', '');
    toets('extra scope → geweigerd', u.soort === 'scope' && !K.rij.tibber_data_refresh, u);
    M.scope = SCOPES;
    // goede terugkeer
    const lu4 = new URL(TM.linkMaak(DIR, 'cid-proef-0001').url), st4 = lu4.searchParams.get('state'); M.challenge4 = lu4.searchParams.get('code_challenge');
    u = await TM.terug(kluisDeps(DIR), st4, 'code-goed', '');
    toets('toestemming → gekoppeld, refresh in de kluis, noodkopie weg', u.soort === 'gekoppeld' && K.rij.tibber_data_refresh === tok(M.teller) && !TM.noodLees(DIR), u);
    toets('PKCE: verifier hoort bij de challenge uit de link (S256)', crypto.createHash('sha256').update(M.verifier).digest('base64url') === M.challenge4, [M.verifier, M.challenge4]);
    const nog = await TM.terug(kluisDeps(DIR), st4, 'code-goed', '');
    toets('state hergebruik → 404', nog.status === 404 && nog.soort === 'dicht', nog);
    toets('geen GET op de Data API tijdens de terugkeer', !M.log.some((x) => x.p.indexOf('/v1/') === 0));
    toets('User-Agent Socev/1.0', M.log.every((x) => x.ua === 'Socev/1.0'));

    // 5. ronde: rotatie schrijft vóór gebruik
    K.zetten = []; M.log = [];
    const oud = K.rij.tibber_data_refresh;
    let r = await TM.ronde(kluisDeps(DIR), 'ronde');
    const eersteGet = M.log.find((x) => x.m === 'GET');
    toets('ronde ok', r.ok === true && r.apparaten === 1 && r.punten === 6, r);
    toets('rotatie: nieuw token in de kluis vóór de eerste GET', r.geroteerd === true && K.zetten.length === 1 && eersteGet && K.zetten[0].t <= eersteGet.t && K.rij.tibber_data_refresh !== oud, K.zetten.length);
    toets('access token niet op schijf', !fs.readdirSync(DIR).some((f) => fs.readFileSync(path.join(DIR, f)).indexOf('at-aaaa') >= 0));
    toets('next-link met andere host als volgende pagina gevolgd: nee (alleen data-api)', !M.log.some((x) => x.q === '?cursor=p9'));
    const { DatabaseSync } = require('node:sqlite');
    const dbp = path.join(DIR, 'tibber.' + 'sqlite');
    toets('tibber.sqlite 600', (fs.statSync(dbp).mode & 0o777) === 0o600);
    let d = new DatabaseSync(dbp);
    const velden = d.prepare('select distinct veld from apparaat_historie order by veld').all().map((x) => x.veld);
    toets('historie: alleen witte-lijstvelden', JSON.stringify(velden) === JSON.stringify(['chargingState', 'energyConsumed', 'stateOfCharge']), velden);
    const app = d.prepare('select * from apparaat').get();
    toets('apparaat: merk/model, eigen label, geen naam of VIN', app.merk === 'Volkswagen' && app.model === 'ID.3' && app.label === 'apparaat 1' && JSON.stringify(app).indexOf(VIN) < 0 && JSON.stringify(app).indexOf(NAAM) < 0, app);
    d.close();
    const ruw = fs.readFileSync(dbp);
    toets('locatie, VIN en naam nergens in de databank', ruw.indexOf(VIN) < 0 && ruw.indexOf(NAAM) < 0 && ruw.indexOf(String(LAT)) < 0);
    toets('backfill: 3 pagina\'s (p1, p2, p3 leeg)', r.paginas === 3, r.paginas);
    // tweede ronde volgt de bewaarde cursor
    M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    const hist = M.log.filter((x) => /history$/.test(x.p));
    toets('tweede ronde volgt de bewaarde cursor (p3), geen nieuwe backfill', r.ok === true && hist.length === 1 && hist[0].q === '?cursor=p3', hist);
    // apparaten: alleen namen
    r = await TM.ronde(kluisDeps(DIR), 'apparaten');
    const aj = JSON.stringify(r);
    toets('apparaten: capability- en attribuutnamen, geen waarden', r.ok === true && aj.indexOf('storage.stateOfCharge [%]') >= 0 && aj.indexOf('vin') >= 0 && aj.indexOf(VIN) < 0 && aj.indexOf('52.1,5.3') < 0, r);

    // 6. invalid_grant → één melding, geen herhaling
    M.log = [];
    const goedTok = K.rij.tibber_data_refresh;
    M.refreshGeldig.delete(goedTok);
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('invalid_grant → reden grant', r.ok === false && r.reden === 'grant', r);
    toets('invalid_grant: één tokenverzoek, geen GET', M.log.filter((x) => x.p === '/connect/token').length === 1 && !M.log.some((x) => x.m === 'GET'));
    M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('dode koppeling onthouden: volgende ronde vraagt Tibber niets (reden dood)', r.ok === false && r.reden === 'dood' && !M.log.length && TM.doodLees(DIR), r);
    M.refreshGeldig.add(goedTok);
    const lu5 = new URL(TM.linkMaak(DIR, 'cid-proef-0001').url);
    u = await TM.terug(kluisDeps(DIR), lu5.searchParams.get('state'), 'code-goed', '');
    toets('nieuwe toestemming wist de dode koppeling', u.soort === 'gekoppeld' && !TM.doodLees(DIR), u);
    M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('na nieuwe toestemming weer een gewone ronde', r.ok === true, r);

    // 7. kluis faalt na refresh → noodkopie, geen lezen; volgende ronde herstelt
    M.log = []; K.zetFout = 3;
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    const nood = TM.noodLees(DIR);
    toets('kluis faalt 3× → noodkopie (600), reden kluis, geen GET', r.ok === false && r.reden === 'kluis' && r.nood === true && nood && (fs.statSync(path.join(DIR, 'refresh.nood')).mode & 0o777) === 0o600 && !M.log.some((x) => x.m === 'GET'), r);
    toets('drie schrijfpogingen', K.zetten.slice(-3).every((z) => z.w === nood.refresh));
    M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('volgende ronde: noodkopie eerst in de kluis, daarmee ververst, daarna weg', r.ok === true && r.nood_hersteld === true && M.gebruikt === nood.refresh && !TM.noodLees(DIR) && K.rij.tibber_data_refresh === tok(M.teller), r);

    // 8. proces stopt vóór opslag (kind ververst en schrijft de noodkopie; de regie komt nooit aan de kluis toe)
    const voor = K.rij.tibber_data_refresh;
    const kk = await kindEcht('ververs', { client_id: 'cid-proef-0001', client_secret: 'geheim-proef-0001', refresh: voor });
    toets('kind schrijft de noodkopie vóór zijn antwoord', kk.j && kk.j.ok === true && TM.noodLees(DIR) && TM.noodLees(DIR).refresh === kk.j._refresh, kk.j && kk.j.ok);
    M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('na een afgebroken ronde: herstel uit de noodkopie (oude token in de kluis is al verbruikt)', r.ok === true && r.nood_hersteld === true && M.gebruikt === kk.j._refresh, r);

    // 9. twee rondes tegelijk
    const [a1, a2] = await Promise.all([TM.ronde(kluisDeps(DIR), 'ronde'), TM.ronde(kluisDeps(DIR), 'ronde')]);
    toets('twee rondes tegelijk → één stopt (bezig)', [a1, a2].filter((x) => x.reden === 'bezig').length === 1 && [a1, a2].filter((x) => x.ok === true).length === 1, [a1.reden, a2.reden]);
    // oud slot (dode pid, > 15 min) wordt opgeruimd
    fs.writeFileSync(path.join(DIR, 'ronde.lock'), JSON.stringify({ pid: 999999, sinds: new Date(Date.now() - 20 * 60000).toISOString() }));
    toets('oud slot van een dood proces wordt opgeruimd', TM.slotNeem(DIR) === true); TM.slotLos(DIR);
    fs.writeFileSync(path.join(DIR, 'ronde.lock'), JSON.stringify({ pid: process.pid, sinds: new Date(Date.now() - 20 * 60000).toISOString() }));
    toets('oud slot van een levend proces blijft', TM.slotNeem(DIR) === false); TM.slotLos(DIR);

    // 10. redirect → geweigerd; 429 → herhaald; 400 → niet herhaald; kluis onbereikbaar → niets ververst
    M.homesRedirect = true; M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('redirect → ronde faalt, doel niet opgevraagd', r.ok === false && !M.log.some((x) => x.p === '/elders'), r);
    M.homesRedirect = false; M.fout429 = 2; M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('429 met Retry-After → herhaald en gelukt', r.ok === true && M.log.filter((x) => x.p === '/v1/homes').length === 3, M.log.filter((x) => x.p === '/v1/homes').length);
    M.homes400 = true; M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('400 → niet herhaald', r.ok === false && M.log.filter((x) => x.p === '/v1/homes').length === 1, M.log.filter((x) => x.p === '/v1/homes').length);
    M.homes400 = false;
    K.leesFout = true; M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('kluis vooraf onbereikbaar → geen refresh', r.ok === false && r.reden === 'kluis' && !M.log.length, r);
    K.leesFout = false;

    // 11. server.js: route, smalle opdracht, kluis via de Management-API, logs zonder code of state
    const ssrc = fs.readFileSync('server.js', 'utf8');
    const b1 = ssrc.indexOf('// ── wv2625: Tibber Data API'), b2 = ssrc.indexOf('// ── einde Tibber ──');
    const k1 = ssrc.indexOf('function smalKind('), k2 = ssrc.indexOf('async function smalSbRpc(');
    toets('server.js: Tibber-blok en route aanwezig', b1 > 0 && b2 > b1 && /if \(tibberIsPad\(req\)\) return tibberTerug\(req, res\);/.test(ssrc) && /actie === 'tibber'\) return tibberSmal\(d, wie\)/.test(ssrc) && /\btibber: 20\b/.test(ssrc));
    const DIR2 = path.join(W, 'tibber2');
    const logs = [], kluis = { tibber_data_client_id: 'cid-proef-0001', tibber_data_client_secret: 'geheim-proef-0001' };
    let mgmt = 0;
    fs.mkdirSync(path.join(W, '00_Systeem', 'Meldingen'), { recursive: true });
    fs.writeFileSync(path.join(W, '00_Systeem', 'Meldingen', 'machinekamer.md'), '# box\n\n## [direct] 2026-11-01 10:00 — oude rij\n- status: open\n');
    const g = { require, fs, path, crypto, Buffer, console, URL, URLSearchParams, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, spawn, VAULT: W, __dirname: process.cwd(),
      process: { env: { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', TIBBER_DIR: DIR2, TIBBER_SCRIPT: SCRIPT, TIBBER_AUTH_BASIS: BASIS, TIBBER_API_BASIS: BASIS, TIBBER_PAUZE_MS: '0',
        SUPABASE_URL: 'https://abcdef.supabase.co', SUPABASE_MCP_TOKEN: 'pat-geheim', ANDERE_SLEUTEL: 'mag-niet-mee' }, execPath: process.execPath, pid: process.pid },
      reqPath: (req) => { const i = req.url.indexOf('?'); return i < 0 ? req.url : req.url.slice(0, i); },
      schrijfLog: (r) => logs.push(r), nu: () => '2026-11-07 12:00:00', velden: (o) => Object.keys(o).filter((k) => o[k] != null && o[k] !== '').map((k) => k + '=' + o[k]).join(' '),
      logError: (w, e) => logs.push('fout ' + w + ' ' + (e && e.name)), rolPrimair: () => true,
      VV: () => ({ lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: (p, t) => fs.writeFileSync(p, t) }),
      bankPagina: (res, st, kop, tekst) => { res.writeHead(st, {}); res.end(kop + ': ' + tekst); },
      fetch: async function (url, o) {
        mgmt++;
        if (url !== 'https://api.supabase.com/v1/projects/abcdef/database/query') throw new Error('onverwacht adres ' + url);
        const q = JSON.parse(o.body).query; K.queries.push(q);
        const ant = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => '' });
        if (/^select name, decrypted_secret as w from vault\.decrypted_secrets where name in/.test(q)) return ant(Object.keys(kluis).map((n) => ({ name: n, w: kluis[n] })));
        if (/^select count\(\*\)::int as n from vault\.secrets where name = 'tibber_data_refresh'$/.test(q)) return ant([{ n: kluis.tibber_data_refresh ? 1 : 0 }]);
        let m = /vault\.update_secret\(id, \$tb\$([^$]+)\$tb\$\)/.exec(q) || /vault\.create_secret\(\$tb\$([^$]+)\$tb\$, 'tibber_data_refresh'/.exec(q);
        if (m) { g.__soort = /create_secret/.test(q) ? 'create' : 'update'; kluis.tibber_data_refresh = m[1]; return ant([{ n: 1 }]); }
        if (/sha256\(convert_to\(decrypted_secret/.test(q)) return ant([{ h: sha(kluis.tibber_data_refresh) }]);
        return { ok: false, status: 400, json: async () => ({}), text: async () => 'fout met ' + q };
      } };
    vm.createContext(g);
    vm.runInContext(ssrc.slice(k1, k2) + '\n' + ssrc.slice(b1, b2) + '\n;globalThis.__t = { tibberTerug, tibberSmal, tibberInfo, tibberRondeDraai, tibberNaBankRonde };', g);
    const S = g.__t;
    function nepReq(url, methode) { return { url: url, method: methode || 'GET', resume() {} }; }
    function nepRes() { return new Promise((klaar) => { const r = { statusCode: 0, headersSent: false, _log: {}, writeHead(st) { this.statusCode = st; this.headersSent = true; }, end(t) { klaar({ status: this.statusCode, tekst: String(t || '') }); } }; r.p = null; klaar.r = r; S.__res = r; }); }
    async function vraag(url, methode) { let res; const p = new Promise((k) => { res = { statusCode: 0, headersSent: false, _log: {}, writeHead(st) { this.statusCode = st; this.headersSent = true; }, end(t) { k({ status: this.statusCode, tekst: String(t || '') }); } }; }); S.tibberTerug(nepReq(url, methode), res); return p; }
    mgmt = 0;
    let a = await vraag('/tibber/terug?code=code-goed&state=' + 'b'.repeat(64));
    toets('server: onbekende state → 404, geen kluis', a.status === 404 && mgmt === 0, a);
    a = await vraag('/tibber/terug?code=code-goed&state=xyz');
    toets('server: state van verkeerde vorm → 404', a.status === 404);
    let sm = await S.tibberSmal({ opdracht: 'link' }, { mk: false });
    toets('server: /smal/tibber zonder API_SECRET → 403', sm.status === 403);
    sm = await S.tibberSmal({ opdracht: 'wis' }, { mk: true });
    toets('server: onbekende opdracht → 400', sm.status === 400);
    sm = await S.tibberSmal({ opdracht: 'link' }, { mk: true });
    const sst = sm.j && sm.j.url ? new URL(sm.j.url).searchParams.get('state') : '';
    toets('server: link gemaakt', sm.status === 200 && /^[0-9a-f]{64}$/.test(sst), sm);
    toets('server: tibber_data_refresh nog niet gezet vóór de toestemming', !kluis.tibber_data_refresh);
    a = await vraag('/tibber/terug?code=code-goed&state=' + sst, 'POST');
    toets('server: POST op de terugkeer → 404', a.status === 404);
    a = await vraag('/tibber/terug?code=code-goed&state=' + sst);
    toets('server: terugkeer → Gekoppeld, kluisregel aangemaakt', a.status === 200 && /^Gekoppeld/.test(a.tekst) && g.__soort === 'create' && kluis.tibber_data_refresh === tok(M.teller), a);
    for (let i = 0; i < 100 && !fs.existsSync(path.join(DIR2, 'ronde.json')); i++) await new Promise((k) => setTimeout(k, 100));
    const rj = JSON.parse(fs.readFileSync(path.join(DIR2, 'ronde.json'), 'utf8'));
    toets('server: eerste ronde na de toestemming (backfill) gedraaid en geroteerd', rj.ok === true && rj.punten === 6 && rj.geroteerd === true && g.__soort === 'update', rj);
    a = await vraag('/tibber/terug?code=code-goed&state=' + sst);
    toets('server: dezelfde state nog eens → 404', a.status === 404);
    const alles = logs.join('\n');
    toets('server: log zonder code, state of token', alles.indexOf('code-goed') < 0 && alles.indexOf(sst) < 0 && alles.indexOf('rt-') < 0 && alles.indexOf('at-') < 0 && /tibber opdracht=terug soort=gekoppeld/.test(alles), logs);
    toets('server: kind krijgt geen andere sleutels in de omgeving', fs.readFileSync('server.js', 'utf8').slice(b1, b2).indexOf("['PATH', 'HOME', 'TZ', 'LANG']") > 0);
    const info = S.tibberInfo();
    toets('server: /health-info zonder tokens', info.module === true && info.laatste && info.laatste.ok === true && JSON.stringify(info).indexOf('rt-') < 0, info);
    sm = await S.tibberSmal({ opdracht: 'stand' }, { mk: true });
    toets('server: stand lokaal', sm.status === 200 && sm.j.apparaten && sm.j.apparaten.length === 1 && sm.j.apparaten[0].punten === 6, sm.j);
    // invalid_grant via de server → één box-rij per dag
    M.refreshGeldig.delete(kluis.tibber_data_refresh);
    await S.tibberRondeDraai('ronde', 'proef'); await S.tibberRondeDraai('ronde', 'proef');
    const box = fs.readFileSync(path.join(W, '00_Systeem', 'Meldingen', 'machinekamer.md'), 'utf8');
    toets('server: invalid_grant → precies één box-rij', (box.match(/tibber-grant-/g) || []).length === 1 && box.indexOf('rt-') < 0, box.slice(0, 600));
    toets('server: kluisfout-antwoord (met query) komt niet in het log', logs.join('\n').indexOf('$tb$') < 0);
  } catch (e) { toets('geen uitzondering', false, String(e && e.stack || e)); }
  srv.close();
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
});
JS
