#!/usr/bin/env bash
# Toetst ideeen.js (wv761, App Ideeën van buitenaf; bouwplan "01_Ontwikkeling/Ideeënbeurs met Albert van der Veer (ontwerp 22-10-2026).md")
# en de koppeling in server.js, tegen een nagebootst forum. Toetst: alleen forum ideeen (een draad die intussen in agents staat telt niet
# mee, een reactie naar een agents-draad wordt geweigerd vóór het posten), kaartvorm en draad zonder kaart, groepen ons/buiten, teller
# nieuw sinds gezien, gezien alleen vooruit, reactie (leeg, > 800, gesloten, als david), plaatje alleen uit een ideeen-draad, Naar de
# Ideeënbus op een kopie van de echte bus (rest byte-gelijk, genre geparkeerd, dubbel = 409, idee van ons = 409, conflictkopie = 409,
# tekst van buiten zonder tabel-/linktekens), forum onbereikbaar = 502, en server.js (dispatch, glijdroutes, health, reservekant,
# BSN-masker op een vaste plek, de forumaanroep met de sleutel in de kop). Raakt de echte vault en het echte forum niet.
# Gebruik: bash test/ideeen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const I = require('./ideeen.js'), H = require('./harvester.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'ideeen-toets-'));
const VAULT = path.join(W, 'vault'), DIR = path.join(W, 'staat');
fs.mkdirSync(path.join(VAULT, '01_Ontwikkeling'), { recursive: true });
const ECHTE_BUS = '/opt/data/AI_SecondBrain/' + I.BUS_PAD;
const busTekst = fs.existsSync(ECHTE_BUS) ? fs.readFileSync(ECHTE_BUS, 'utf8') : '# Bus\n\n| # | Idee | Genre | % | Kort | Stand |\n|---|---|---|---|---|---|\n| 1 | Eerste | x | 10 | k | s |\n';
const BUS = path.join(VAULT, I.BUS_PAD);
fs.writeFileSync(BUS, busTekst);

// ── nagebootst forum (zoals de API van fase 1 het de podsleutel geeft: ruwe auteur + van) ──
const F = { draden: {}, aanroepen: [], weg: false };
let bid = 100;
function draad(id, forum, van, kaart, extra = {}) {
  F.draden[id] = { draad: { id, forum, titel: kaart ? kaart.titel : 'losse titel', gemaakt_door: van, gemaakt_op: '2026-10-23T08:00:00Z', laatste_op: '2026-10-23T0' + (id % 10) + ':00:00Z', kaart, gesloten: 0, ...extra },
    berichten: [{ id: ++bid, auteur: van, van, soort: 'bot', tekst: kaart ? kaart.wat + '\n\nWil je meer weten? Vraag het hieronder.' : 'eerste [img]/api/afbeelding/9[/img] tekst', gemaakt_op: '2026-10-23T08:00:00Z' }] };
}
const K = (titel, x = {}) => ({ titel, wat: 'Het doet iets. Zo simpel.', waarom: 'Scheelt tijd.', status: 'in gebruik', ...x });
draad(1, 'ideeen', 'socev', K('Ja / Nee / Anders'));
draad(2, 'ideeen', 'appie', K('Ochtendbriefing | met [[link]] en `code`', { plaatje: 7, wat: 'Leest de agenda https://boos.example voor. Klaar.' }));
draad(3, 'ideeen', 'albert@voorbeeld.nl', null);
F.draden[3].berichten[0].van = 'albert';
draad(4, 'agents', 'socev', K('Stiekem agents'));
F.draden[2].berichten.push({ id: ++bid, auteur: 'albert@voorbeeld.nl', van: 'albert', soort: 'mens', tekst: 'Vraag van Albert [img]/api/afbeelding/8[/img]', gemaakt_op: '2026-10-23T09:00:00Z' });
F.draden[2].berichten.push({ id: ++bid, auteur: 'appie', van: 'appie', soort: 'bot', tekst: 'weg', gemaakt_op: '2026-10-23T09:10:00Z', gewist: 1 });
async function forum(m, pad, body) {
  F.aanroepen.push([m, pad, body]);
  if (F.weg) throw new Error('ECONNREFUSED');
  let x;
  if (m === 'GET' && (x = /^draden\?forum=(\w+)$/.exec(pad))) {
    // de echte API filtert op forum; hier zit er bewust een agents-draad tussen om de eigen controle van ideeen.js te toetsen
    const l = Object.values(F.draden).filter((d) => d.draad.forum === x[1] || d.draad.id === 4).map((d) => ({ ...d.draad, n: d.berichten.length, laatste_bericht_id: d.berichten.at(-1).id }));
    return { status: 200, j: { ok: true, draden: l } };
  }
  if (m === 'GET' && (x = /^draad\/(\d+)\?stil=1$/.exec(pad))) { const d = F.draden[x[1]]; return d ? { status: 200, j: { ok: true, ...JSON.parse(JSON.stringify(d)) } } : { status: 404, j: { ok: false } }; }
  if (m === 'POST' && (x = /^draad\/(\d+)\/bericht$/.exec(pad))) {
    const d = F.draden[x[1]]; if (!d) return { status: 404, j: { ok: false } };
    if (body.tekst.length > 800) return { status: 422, j: { ok: false, fout: 'reactie: hooguit 800 tekens' } };
    const id = ++bid; d.berichten.push({ id, auteur: body.als || 'pod', van: body.als || 'pod', tekst: body.tekst, gemaakt_op: new Date().toISOString(), via: 'pod' });
    return { status: 200, j: { ok: true, id } };
  }
  if (m === 'GET' && (x = /^afbeelding\/(\d+)\?forum=ideeen$/.exec(pad))) return { status: 200, bin: Buffer.from('PNGDATA' + x[1]), type: 'image/png' };
  return { status: 404, j: { ok: false, fout: 'onbekend' } };
}
let nu = Date.parse('2026-10-23T10:00:00Z');
const M = I.maak({ vault: VAULT, dir: DIR, forum, klok: () => nu, harvester: H });
M.mkdir();

(async function () {
  // ── 1. lezen ──
  let r = await M.app('GET /app/ideeen');
  const k = (id) => r.j.kaarten.find((x) => x.id === id);
  toets('1 GET 200 met drie kaarten uit ideeen (agents-draad die het forum toch meestuurt telt niet)', r.status === 200 && r.j.kaarten.length === 3 && !k(4), r.j.kaarten && r.j.kaarten.map((x) => x.id));
  toets('1 groepen: socev = ons, appie en albert = buiten', k(1).groep === 'ons' && k(2).groep === 'buiten' && k(3).groep === 'buiten' && k(3).van === 'albert', r.j.kaarten.map((x) => [x.id, x.groep, x.van]));
  toets('1 kaartvelden en plaatje; draad zonder kaart: wat uit de eerste tekst, kaartvorm false', k(2).kaartvorm && k(2).plaatje === 7 && k(2).status === 'in gebruik' && !k(3).kaartvorm && k(3).wat === 'eerste tekst', [k(2), k(3)]);
  toets('1 reacties: plaatje eruit als nummer, gewist leeg', k(2).reacties[0].tekst === 'Vraag van Albert' && k(2).reacties[0].plaatjes[0] === 8 && k(2).reacties[1].gewist && k(2).reacties[1].tekst === '', k(2).reacties);
  toets('1 teller nieuw: buiten-berichten na gezien (0) = kaart 2 (1 + reactie Albert), kaart 3 (1); gewist telt niet', r.j.nieuw === 3 && k(2).nieuw === 2 && k(3).nieuw === 1 && k(1).nieuw === 0, r.j.kaarten.map((x) => [x.id, x.nieuw]));
  toets('1 concepten leeg in fase 1', Array.isArray(r.j.concepten) && r.j.concepten.length === 0 && r.j.catalogus === false);
  const n0 = F.aanroepen.length;
  await M.app('GET /app/ideeen');
  toets('1 cache: tweede GET binnen 20 s leest het forum niet opnieuw', F.aanroepen.length === n0, F.aanroepen.length - n0);
  nu += 30000;
  await M.app('GET /app/ideeen');
  toets('1 na 20 s: alleen de lijst, ongewijzigde draden uit de cache', F.aanroepen.length === n0 + 1, F.aanroepen.slice(n0));
  // ── 2. gezien ──
  let g = await M.app('POST /app/ideeen/gezien', { tot: r.j.max_id });
  nu += 30000; r = await M.app('GET /app/ideeen');
  toets('2 gezien tot max: teller 0', g.status === 200 && r.j.nieuw === 0, r.j.nieuw);
  g = await M.app('POST /app/ideeen/gezien', { tot: 1 });
  toets('2 gezien gaat niet terug', g.j.gezien_tot === r.j.max_id, g.j);
  toets('2 gezien zonder getal = 400', (await M.app('POST /app/ideeen/gezien', { tot: 'x' })).status === 400);
  toets('2 staat 0600 in een map 0700', (fs.statSync(path.join(DIR, 'staat.json')).mode & 0o777) === 0o600 && (fs.statSync(DIR).mode & 0o777) === 0o700);
  // ── 3. reactie ──
  r = await M.app('POST /app/ideeen/reactie', { draad: 2, tekst: '  Leuk!\r\nHoe lang bouwen?  ' });
  toets('3 reactie 200, als david, regels behouden, getrimd', r.status === 200 && F.aanroepen.some((a) => a[0] === 'POST' && a[1] === 'draad/2/bericht' && a[2].als === 'david' && a[2].tekst === 'Leuk!\nHoe lang bouwen?'), F.aanroepen.at(-1));
  nu += 1000; r = await M.app('GET /app/ideeen');
  toets('3 na reageren meteen vers gelezen; eigen reactie van david telt niet als nieuw', k(2).reacties.some((x) => x.van === 'david' && !x.nieuw) && r.j.nieuw === 0, k(2).reacties);
  let na = F.aanroepen.length;
  r = await M.app('POST /app/ideeen/reactie', { draad: 4, tekst: 'via de app naar agents?' });
  toets('3 reactie naar een agents-draad = 404 en niets gepost', r.status === 404 && !F.aanroepen.slice(na).some((a) => a[0] === 'POST'), F.aanroepen.slice(na));
  toets('3 lege reactie = 400', (await M.app('POST /app/ideeen/reactie', { draad: 2, tekst: '   ' })).status === 400);
  toets('3 801 tekens = 422 zonder forumaanroep', (await M.app('POST /app/ideeen/reactie', { draad: 2, tekst: 'a'.repeat(801) })).status === 422);
  toets('3 onbekende draad = 404', (await M.app('POST /app/ideeen/reactie', { draad: 99, tekst: 'x' })).status === 404 && (await M.app('POST /app/ideeen/reactie', { draad: 'x', tekst: 'x' })).status === 404);
  F.draden[1].draad.gesloten = 1;
  toets('3 gesloten draad = 409', (await M.app('POST /app/ideeen/reactie', { draad: 1, tekst: 'x' })).status === 409);
  F.draden[1].draad.gesloten = 0;
  // ── 4. plaatje ──
  r = await M.app('GET /app/ideeen/plaatje/7');
  toets('4 plaatje van een kaart: 200 base64 png', r.status === 200 && r.j.type === 'image/png' && Buffer.from(r.j.inhoud, 'base64').toString() === 'PNGDATA7', r);
  toets('4 plaatje uit een reactie: 200', (await M.app('GET /app/ideeen/plaatje/8')).status === 200);
  toets('4 plaatje dat nergens in ideeen staat (bv. uit intern) = 404', (await M.app('GET /app/ideeen/plaatje/3')).status === 404 && !F.aanroepen.some((a) => a[1] === 'afbeelding/3'));
  // ── 5. naar de Ideeënbus ──
  const voor = fs.readFileSync(BUS, 'utf8');
  r = await M.app('POST /app/ideeen/naar-ideeenbus', { draad: 2 });
  const na5 = fs.readFileSync(BUS, 'utf8');
  const bus = H.leesBus(na5), oud = H.leesBus(voor);
  const nieuwIdee = bus.ideeen.find((i) => i.nr === r.j.idee_nr);
  toets('5 naar de bus: 200, nieuw nummer, genre geparkeerd', r.status === 200 && nieuwIdee && nieuwIdee.genre === I.GENRE && r.j.idee_nr === Math.max(...oud.ideeen.map((i) => i.nr)) + 1, { r, nieuwIdee });
  toets('5 titel zonder | [ ] ` en zonder link', nieuwIdee && !/[|\[\]`]/.test(nieuwIdee.titel) && !/https?:/.test(na5.slice(voor.length - 10)), nieuwIdee);
  toets('5 herkomst Appie/Albert in het blok', /Herkomst: Appie \(assistent van Albert van der Veer\), via de Ideeënbeurs/.test(na5));
  const zonder = na5.split('\n').filter((l, i, a) => true);
  toets('5 rest van de bus byte-gelijk (alleen één rij erbij en een blok onderaan)', (() => { const v = voor.split('\n'), n = na5.split('\n'); const rij = n.findIndex((l, i) => l !== v[i]); const n2 = n.slice(0, rij).concat(n.slice(rij + 1)); return n2.slice(0, v.length).join('\n').replace(/\s*$/, '') === voor.replace(/\s*$/, ''); })());
  toets('5 tweede keer = 409 (staat er al)', (await M.app('POST /app/ideeen/naar-ideeenbus', { draad: 2 })).status === 409);
  toets('5 idee van ons = 409', (await M.app('POST /app/ideeen/naar-ideeenbus', { draad: 1 })).status === 409);
  toets('5 agents-draad = 404', (await M.app('POST /app/ideeen/naar-ideeenbus', { draad: 4 })).status === 404);
  nu += 30000; r = await M.app('GET /app/ideeen');
  toets('5 GET: kaart 2 op de bus met nummer', k(2).idee_nr > 0 && k(2).op_bus === true, k(2));
  fs.writeFileSync(BUS + '.conflict1', 'x');
  toets('5 conflictkopie naast de bus = 409', (await M.app('POST /app/ideeen/naar-ideeenbus', { draad: 3 })).status === 409);
  fs.unlinkSync(BUS + '.conflict1');
  fs.writeFileSync(BUS, voor);   // bus teruggezet: kaart 2 mag dan opnieuw
  nu += 30000; r = await M.app('GET /app/ideeen');
  toets('5 bus teruggezet: op_bus false, opnieuw kan', k(2).op_bus === false && (await M.app('POST /app/ideeen/naar-ideeenbus', { draad: 2 })).status === 200, k(2));
  // ── 6. forum weg ──
  F.weg = true; nu += 30000;
  r = await M.app('GET /app/ideeen');
  toets('6 forum onbereikbaar: 502 met gewone taal, health fout', r.status === 502 && /niet te lezen/.test(r.j.fout) && M.health().fout, r);
  F.weg = false;

  // ── 7. server.js-koppeling (vm) ──
  const src = fs.readFileSync('server.js', 'utf8');
  const s1 = src.indexOf('// ── Ideeënbeurs (wv761'), s2 = src.indexOf('// ── einde ideeënbeurs ──');
  toets('7 server.js: blok gevonden', s1 > 0 && s2 > s1);
  toets('7 server.js: dispatch, glijdroutes, health', /route === 'GET \/app\/ideeen' \|\| route\.indexOf\('GET \/app\/ideeen\/plaatje\/'\) === 0 \|\| route === 'POST \/app\/ideeen\/reactie' \|\| route === 'POST \/app\/ideeen\/gezien' \|\| route === 'POST \/app\/ideeen\/naar-ideeenbus'\)/.test(src) &&
    /\['POST \/app\/ideeen\/reactie', 'POST \/app\/ideeen\/naar-ideeenbus'\]\.forEach\(function \(r\) \{ APP_GLIJD_ROUTES\.add\(r\); \}\)/.test(src) && /ideeen: typeof ideeenInfo === 'function' \? ideeenInfo\(\)/.test(src));
  toets('7 uitrol.sh en Dockerfile nemen ideeen.js mee', / ideeen\.js"/.test(fs.readFileSync('uitrol.sh', 'utf8')) && /COPY ideeen\.js \/app\/release-bootstrap\/ideeen\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
  const gevraagd = [];
  const nepFetch = async (u, o) => { gevraagd.push([u, o]); return { status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, draden: [] }) }; };
  const appStaat = { tellers: {} };
  const ctx = vm.createContext({ require, process: Object.assign({}, process, { env: Object.assign({}, process.env, { WERKKAMER_SLEUTEL_POD: 'wk_pod_proef', IDEEEN_FORUM_BASIS: 'https://forum.proef/api/' }) }),
    fs, path, Buffer, console, JSON, Date, Promise, AbortSignal, fetch: nepFetch, appStaat,
    __dirname: process.cwd(), VAULT, serverPad: (n) => path.join(W, 'srv-' + n), serverProefDeel: (d) => d, logError: () => {},
    appWeiger: (res, st, f, r) => ({ st, f, r }), appStuur: (res, st, j) => ({ st, j }), appRolOk: async () => ctx.__primair,
    appTeller: (k) => { if (!appStaat.tellers[k]) throw new Error('teller ' + k + ' bestaat niet'); return true; },
    appBsnAchtig: (x) => /\d{9}/.test(x), appBsnMasker: (x) => x.replace(/\d{9}/g, '[BSN-achtig getal weggelaten]') });
  ctx.__primair = true;
  vm.runInContext(src.slice(s1, s2) + '\n;globalThis.__h = { ideeen, appIdeeen, ideeenInfo, ideeenForum };', ctx, { filename: 'server.js#ideeen' });
  const S = ctx.__h;
  toets('7 module geladen, tellers bestaan, health aan', S.ideeen && S.ideeenInfo().aan === true && appStaat.tellers.ideeen && appStaat.tellers['ideeen-reactie'] && appStaat.tellers['ideeen-plaatje'], S.ideeenInfo());
  const rs = { _app: {} };
  const gg = await S.appIdeeen({}, rs, { soort: 'mee' }, {}, 'GET /app/ideeen');
  toets('7 GET via server.js: 200 en stil', gg.st === 200 && rs._app.stil === true, gg);
  toets('7 forumaanroep: sleutel in de kop, adres forum/api/draden?forum=ideeen, nooit in de url', gevraagd[0][0] === 'https://forum.proef/api/draden?forum=ideeen' && gevraagd[0][1].headers['X-Werkkamer-Sleutel'] === 'wk_pod_proef' && !/wk_pod/.test(gevraagd[0][0]), gevraagd[0]);
  ctx.__primair = false;
  toets('7 POST op de reservekant = 409', (await S.appIdeeen({}, { _app: {} }, { soort: 'mee' }, { draad: 2, tekst: 'x' }, 'POST /app/ideeen/reactie')).st === 409);
  ctx.__primair = true;
  const rsb = { _app: {} }, dd = { draad: 2, tekst: 'mijn bsn 123456789' };
  await S.appIdeeen({}, rsb, { soort: 'vast' }, dd, 'POST /app/ideeen/reactie');
  toets('7 vaste plek: BSN-achtig getal gemaskeerd, niet geweigerd', rsb._app.bsnWeg === true && !/123456789/.test(dd.tekst), dd);
  const rs2 = { _app: {} }, dd2 = { draad: 2, tekst: 'mijn bsn 123456789' };
  await S.appIdeeen({}, rs2, { soort: 'mee' }, dd2, 'POST /app/ideeen/reactie');
  toets('7 meereizend: niets gemaskeerd (Davids eigen woorden)', !rs2._app.bsnWeg && /123456789/.test(dd2.tekst));

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error('UITZONDERING', e); process.exit(2); });
JS
