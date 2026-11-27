#!/usr/bin/env bash
# Toetst wv4195 (besluitenpagina nr 368 = 3C68): een Voor jou-kaart met meerdere vragen (herkomst.regels) krijgt per regel een eigen antwoord
# en onderaan één Verstuur (POST /app/voor-jou/regels). Het echte appVoorJouRegels + appKnop in een vm, met verzonnen kaart en register:
# (A) puur: appVjRegels (Ja/Nee of opties, gevoelig, ids uniek), tekst_id;
# (B) proefkaart met tien regels: zes beantwoorden -> één beurt met zes antwoorden, vier blijven open, kaart blijft open; nog eens dezelfde
#     regel = 409; gevoelige regel Ja zonder vingerafdruk = 403, met = 200 en "(gevoelig)"; Anders zonder tekst = 400; tekst gewijzigd = 409;
#     noodstop (verval) = regels weer open; laatste regels -> kaart op gedaan; gewone kaartknop en /app/knop weigeren een regelskaart;
# (C) bron: route, detail zonder Ja/Nee-knop, glijdroute.
# Raakt niets echts (geen netwerk, geen bestanden). Gebruik: bash test/vj-regels.sh   (SRC=<pad> voor een kruisproef op oude bron)
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 900) + ']' : '')); }
const src = fs.readFileSync(process.env.SRC || 'server.js', 'utf8');
const pak = function (re, naam) { const m = re.exec(src); if (!m) { toets('gevonden: ' + naam, false); return ''; } return m[0]; };
const fn = function (n) { return pak(new RegExp('\\n(?:async )?function ' + n + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n'), n); };
(async function () {
  const b1 = src.indexOf('// ── wv4195 (besluitenpagina nr 368'), b2 = src.indexOf('// POST /app/voor-jou/knop {id, keuze');
  toets('0 blok wv4195 gevonden', b1 > 0 && b2 > b1);
  if (!(b1 > 0 && b2 > b1)) { console.log('\n' + goed + ' groen, ' + fouten + ' rood'); process.exit(1); }
  const k1 = src.indexOf('// wv4179 (besluitenpagina nr 364'), k2 = src.indexOf('// Getypte tekst mag geen knopdruk');   // appGevoelig e.a.
  const hulp = ['appOntmasker', 'appKnopBevestiging', 'appVjFnv', 'appVjKaartSleutel', 'appVjKanaal', 'appVjOpmaakWeg', 'appVjInhoudHash', 'appKort', 'appSha'].map(fn).join('\n') +
    '\n' + src.match(/^const APP_VAST_JA_DICHT = (?:true|false);$/m)[0] + '\n' + pak(/\nfunction appVastJaDicht\(a\) \{[^\n]*\}\n/, 'appVastJaDicht') + '\n' + fn('appKnop').replace(/^\n/, '');
  let vragen = {}, prompts = [], chat = [], rpc = [], vers = false, verval = false, punten = [];
  const jobs = {};
  const c = vm.createContext({ console, Date, JSON, crypto, Promise, setTimeout, jobs, appStaat: {}, APP_VRAAG_GELDIG_MS: 72 * 3600000, APP_KNOP_RIJ_MAX: 3, APP_KNOP_WACHT_MELD_MS: 30000, APP_CHATLOG_NIET: '',
    APP_VJ_PER_UUR: 60, APP_KANALEN: { hoofd: 'c-hoofd', machinekamer: 'c-mk' }, DEFAULT_WS: 'ws', DOORBOUW_KNOP: 'Ja, en bouw door', logError: function (k, e) { console.log('logError ' + k + ': ' + (e && e.message)); },
    codeIdVanKanaal: function () { return null; }, CODE_APPS: {}, APP_KNOP_KANALEN: { hoofd: true, machinekamer: true },
    appVragen: function () { return JSON.parse(JSON.stringify(vragen)); }, appVragenSchrijf: function (v) { vragen = JSON.parse(JSON.stringify(v)); },
    appAntwoord: function (r) { return r && r.antwoord ? r.antwoord : null; }, appVersOk: function () { return vers; }, appRolOk: async function () { return true; }, appTeller: function () { return true; },
    appWeiger: function (res, status, fout) { res.status = status; res.j = { ok: false, fout: fout }; }, appStuur: function (res, status, j) { res.status = status; res.j = j; },
    appMagBeurt: async function () { return true; }, appKnopInRij: function () { return 0; }, appKlok: function (iso) { return new Date(iso || Date.now()).toISOString().slice(11, 16); },
    appKnopRijZet: function (sl, job, f) { const r = vragen[sl]; if (r && r.antwoord && r.antwoord.job === job) f(r); }, appVjSluitGekoppeld: function () {}, appStartFout: function (res) { res.status = 503; },
    appChatLogVoor: async function (k, rijen) { chat.push(rijen); return true; }, appSleutelMasker: function (t) { return t; },
    appVjPunten: async function () { return JSON.parse(JSON.stringify(punten)); }, appVjRegisterVraag: async function () { return { vraag: null, herkomst: [], leesbaar: true }; },
    appVjDag: function () { return '27-11'; }, appYmd: function () { return '2026-11-27'; },
    appSbRpc: async function (naam, body) { rpc.push({ naam, body }); return { ok: true }; },
    appStartBeurt: function (a, kanaal, tekst, meta) { const id = meta.job_id; jobs[id] = { status: 'pending' };
      setTimeout(function () { if (verval) { meta.bijVerval(); prompts.push({ verval: true }); return; } Promise.resolve().then(meta.bijStart).then(function (st) { prompts.push({ kanaal: kanaal, prompt: tekst + (st || ''), tekst: meta.tekst }); }); }, 3); return { job_id: id }; } });
  vm.runInContext(src.slice(k1, k2) + '\n' + hulp + '\n' + src.slice(b1, b2) + ';globalThis.__r = { appVjRegels, appVjRegelsTekstId, appVjRegelsVorm, appVoorJouRegels };', c);
  const R = c.__r;
  // (A) puur
  const VR = ['Mag de weekpagina korter?', 'Mag de ochtendregel om 07:00?', 'Welke kleur voor de kop?', 'Zal ik de mail aan Jan versturen?', 'Mag Socev de muziek zachter zetten?',
    'Mag de lijst op datum?', 'Mag het blok Lezen naar onderen?', 'Mag de app donker na 22:00?', 'Mag de zoekbalk bovenaan?', 'Mag het lettertype groter?'];
  const kaart = { id: 77, sleutel: 'wv9901', soort: 'besluit', status: 'open', titel: 'Instellingen app — 10 vragen?', waarom: 'proef', stappen: [], waar: 'overal', deadline: null, prive: false,
    herkomst: { wv: [9901], regels: VR.map(function (v, i) { return i === 2 ? { vraag: v, opties: ['Blauw', 'Groen', 'Grijs'] } : { vraag: v }; }) } };
  punten = [kaart];
  const rg = R.appVjRegels(kaart);
  toets('A1 tien regels; Ja/Nee standaard, regel 3 met de drie opties', rg && rg.length === 10 && rg[0].keuzes.map(k => k.id).join() === 'ja,nee' && rg[2].keuzes.map(k => k.id + '=' + k.tekst).join() === 'o0=Blauw,o1=Groen,o2=Grijs', rg && rg[2]);
  toets('A2 ids uniek, ook bij twee gelijke vragen (Codex MOET 1)', new Set(rg.map(r => r.id)).size === 10 && (function () { const x = R.appVjRegels({ soort: 'besluit', herkomst: { regels: [{ vraag: 'Zelfde?' }, { vraag: 'Zelfde?' }] } }); return x[0].id !== x[1].id; })());
  toets('A3 verstuurvraag is gevoelig, de rest niet', rg[3].gevoelig === true && rg.filter(r => r.gevoelig).length === 1, rg.map(r => r.gevoelig));
  toets('A4 geen besluit / één regel / kapotte regel = geen regels', R.appVjRegels(Object.assign({}, kaart, { soort: 'doen' })) === null && R.appVjRegels({ soort: 'besluit', herkomst: { regels: [{ vraag: 'Een?' }] } }) === null && R.appVjRegels({ soort: 'besluit', herkomst: { regels: [{ vraag: 'Een?' }, { v: 1 }] } }) === null);
  toets('A5 grondwet-kaart: elke regel gevoelig', R.appVjRegels({ soort: 'besluit', herkomst: { grondwet: true, regels: [{ vraag: 'Een?' }, { vraag: 'Twee?' }] } }).every(r => r.gevoelig));
  const tid = R.appVjRegelsTekstId(rg, 'machinekamer');
  // (B) proefkaart
  const stuur = async function (antw, extra) { const res = { _app: {} }; await R.appVoorJouRegels({}, res, {}, { id: 'pixel', soort: 'mee' }, {}, Object.assign({ id: 77, tekst_id: tid, antwoorden: antw }, extra || {})); return res; };
  const wacht = async function (n) { for (let i = 0; i < 200 && prompts.length < n; i++) await new Promise(function (r) { setTimeout(r, 5); }); };
  const A = function (i, keuze, toel) { return { regel: rg[i].id, keuze: keuze, toelichting: toel }; };
  let res = await stuur([A(0, 'ja'), A(1, 'nee'), A(2, 'o1'), A(4, 'ja'), A(5, 'anders', 'Liever op prioriteit'), A(9, 'ja')]);
  await wacht(1);
  const p1 = (prompts[0] || {}).prompt || '';
  toets('B1 zes antwoorden: 200, één beurt in de machinekamer', res.status === 200 && prompts.length === 1 && prompts[0].kanaal === 'machinekamer', res);
  toets('B2 bericht: "6 van de 10", zes genummerde antwoorden, nog open 4, 7, 8, 9', /^\[KNOP\] David beantwoordde 6 van de 10 vragen op de Voor jou-kaart "Instellingen app — 10 vragen\?"/.test(p1) &&
    /\n1\. "Mag de weekpagina korter\?" → JA\n2\. "Mag de ochtendregel om 07:00\?" → NEE\n3\. "Welke kleur voor de kop\?" → "Groen"\n5\. "Mag Socev de muziek zachter zetten\?" → JA\n6\. "Mag de lijst op datum\?" → ANDERS: Liever op prioriteit\n10\. "Mag het lettertype groter\?" → JA\n/.test(p1) &&
    /Nog open \(niet beantwoord, blijven op de kaart staan\): 4, 7, 8, 9\./.test(p1) && /Elk antwoord geldt alleen voor die ene vraag/.test(p1) && /werkvoorraad wv9901/.test(p1) && !/vingerafdruk bevestigd/.test(p1), p1);
  toets('B3 kaart blijft open (geen statuswissel), vier regels open in de vorm', rpc.length === 0 && R.appVjRegelsVorm(kaart, rg, 'machinekamer').open === 4, rpc);
  const dv = (chat[0] || [])[1] || {};
  toets('B4 chat_log: knop-ja-kaart (geen verse Ja: agenda blijft oranje), zes regels in Davids rij', dv.bevestiging === 'knop-ja-kaart' && (dv.tekst.match(/\n\d+\. /g) || []).length === 6, dv);
  toets('B5 weergave in het gesprek: "✓ 6 antwoorden — op de kaart: …"', prompts[0].tekst === '✓ 6 antwoorden — op de kaart: Instellingen app — 10 vragen?', prompts[0].tekst);
  res = await stuur([A(0, 'nee')]);
  toets('B6 al beantwoorde regel nog eens = 409 met de verse stand', res.status === 409 && /vraag 1 is al beantwoord/.test(res.j.fout) && res.j.regels.open === 4, res.j);
  res = await stuur([A(6, 'anders', '')]);
  toets('B7 Anders zonder tekst = 400', res.status === 400 && /typ bij vraag 7/.test(res.j.fout), res.j);
  res = await stuur([A(6, 'o1')]);
  toets('B8 optie die bij deze regel niet bestaat = 400', res.status === 400, res.j);
  res = await stuur([A(6, 'ja')], { tekst_id: '00000000' });
  toets('B9 vragen intussen veranderd (tekst_id) = 409 tekst_gewijzigd', res.status === 409 && res.j.tekst_gewijzigd === true, res.j);
  vers = false; res = await stuur([A(3, 'ja'), A(6, 'ja')]);
  toets('B10 gevoelige regel Ja zonder vingerafdruk = 403 vers_nodig, niets beantwoord', res.status === 403 && res.j.vers_nodig === true && R.appVjRegelsVorm(kaart, rg, 'machinekamer').open === 4, res.j);
  verval = true; res = await stuur([A(6, 'nee')]);
  await wacht(2);
  toets('B11 noodstop (beurt vervalt in de rij): regel 7 staat weer open', res.status === 200 && prompts[1] && prompts[1].verval === true && R.appVjRegelsVorm(kaart, rg, 'machinekamer').lijst[6].antwoord === undefined, R.appVjRegelsVorm(kaart, rg, 'machinekamer').lijst[6]);
  verval = false; vers = true; res = await stuur([A(3, 'ja'), A(6, 'ja')]);
  await wacht(3);
  const p3 = (prompts[2] || {}).prompt || '';
  toets('B12 gevoelige Ja met vingerafdruk: 200, "(gevoelig)" bij regel 4, vingerafdruk in het bericht, regel 7 opnieuw gekozen', res.status === 200 && /\n4\. "Zal ik de mail aan Jan versturen\?" → JA \(gevoelig\)\n7\. "Mag het blok Lezen naar onderen\?" → JA\n/.test(p3) &&
    /met verse vingerafdruk bevestigd voor de regels met \(gevoelig\)/.test(p3) && /Nog open \(niet beantwoord, blijven op de kaart staan\): 8, 9\./.test(p3) && /Eerder al beantwoord \(kreeg je in een vorige verzending\): 1, 2, 3, 5, 6, 10\./.test(p3), p3);
  toets('B13 chat_log: knop-ja-vers-kaart; vorm: regel 4 met vingerafdruk, regel 7 zonder', ((chat[chat.length - 1] || [])[1] || {}).bevestiging === 'knop-ja-vers-kaart' &&
    R.appVjRegelsVorm(kaart, rg, 'machinekamer').lijst[3].antwoord.vingerafdruk === true && !R.appVjRegelsVorm(kaart, rg, 'machinekamer').lijst[6].antwoord.vingerafdruk, R.appVjRegelsVorm(kaart, rg, 'machinekamer').lijst.slice(3, 7));
  vers = false; res = await stuur([A(7, 'nee'), A(8, 'ja')]);
  await wacht(4);
  await new Promise(function (r) { setTimeout(r, 20); });
  const st = rpc.find(x => x.naam === 'mk_voor_jou_status');
  toets('B14 laatste twee: "Daarmee zijn alle vragen beantwoord", kaart op gedaan door david met bewijs', res.status === 200 && /Daarmee zijn alle vragen op deze kaart beantwoord/.test((prompts[3] || {}).prompt || '') &&
    st && st.body.p_naar === 'gedaan' && st.body.p_door === 'david' && /David beantwoordde alle 10 vragen op de kaart/.test(st.body.p_bewijs), { st, p: prompts[3] });
  // twee apparaten tegelijk: dezelfde regel in twee verschillende verzendingen; de tweede wint niet (nogVrij na de awaits)
  const kaart2 = JSON.parse(JSON.stringify(kaart)); kaart2.id = 78; kaart2.sleutel = 'wv9902'; punten = [kaart2];
  const rg2 = R.appVjRegels(kaart2), tid2 = R.appVjRegelsTekstId(rg2, 'machinekamer');
  const s2 = async function (antw) { const res = { _app: {} }; await R.appVoorJouRegels({}, res, {}, { id: 'pc' }, {}, { id: 78, tekst_id: tid2, antwoorden: antw }); return res; };
  const [x1, x2] = await Promise.all([s2([{ regel: rg2[0].id, keuze: 'ja' }]), s2([{ regel: rg2[0].id, keuze: 'nee' }, { regel: rg2[1].id, keuze: 'ja' }])]);
  toets('B15 tegelijk dezelfde regel vanaf twee apparaten: één 200, één 409', [x1.status, x2.status].sort().join() === '200,409', [x1.status, x2.status, x1.j, x2.j]);
  // (C) bron
  toets('C1 route en glijdroute geregistreerd', /route === 'POST \/app\/voor-jou\/regels'\) return appVoorJouRegels\(req, res, reg, a, s, d\)/.test(src) && /APP_GLIJD_ROUTES\.add\('POST \/app\/voor-jou\/regels'\)/.test(src));
  toets('C2 detail geeft regels en dan geen Ja/Nee-knop of Ja/Nee-uitleg', /regels: rg \? appVjRegelsVorm\(p, rg, appVjKanaal\(p, rv, null\)\) : undefined/.test(src) && /knop: p\.soort === 'besluit' && !sw && !rg \?/.test(src) && /ja_nee: p\.soort === 'besluit' && !sw && !rg \?/.test(src));
  toets('C3 gewone kaartknop en /app/knop weigeren een regelskaart', /if \(appVjRegels\(p\)\) return appWeiger\(res, 400, 'deze kaart beantwoord je per vraag/.test(src) && /rij\.soort === 'voorjou-regels' && !\(kaart && kaart\.regels\)/.test(src));
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  onverwacht: ' + (e && e.stack || e)); process.exit(1); });
JS
