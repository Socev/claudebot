#!/usr/bin/env bash
# Toetst wv4179 (besluitenpagina nr 364 = 3C64): Socev biedt bij een vraag 2–3 eigen antwoordknoppen (regel "KNOPPEN: a | b | c" onder de
# vraagregel), naast Anders; niet bij versturen, agenda, verwijderen, geld (of grondwet) en niet onder een doorgeefvraag (#mk-werklijst).
# (A) puur: appVraagKnoppen, appKnopDatumOk (Codex MOET 1), appVraagRij met de echte appGevoelig, appVraagKnoppenVeld;
# (B) het echte appKnop in een vm: eigen knop -> beurt "[KNOP] David koos …", knop-eigen, geen vingerafdruk; Ja/Nee op zo'n vraag 400;
#     eigen knop op een vraag zonder knoppen / gevoelige rij / kaart 400; Anders blijft; gewone vraag houdt Ja/Nee/Anders;
# (C) bron: beide registratieplekken gebruiken appVraagRij, de app-velden (uitslag, geschiedenis, Moet iets) geven knoppen.
# Raakt niets echts (geen netwerk, geen bestanden). Gebruik: bash test/eigen-knoppen.sh   (KRUIS=1: oude bron = rood verwacht)
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const src = fs.readFileSync('server.js', 'utf8');
const pak = function (re, naam) { const m = re.exec(src); if (!m) { toets('gevonden: ' + naam, false); return ''; } return m[0]; };
(async function () {
  const k1 = src.indexOf('// wv4179 (besluitenpagina nr 364'), k2 = src.indexOf('// Getypte tekst mag geen knopdruk');
  toets('0 blok wv4179 + appGevoelig gevonden', k1 > 0 && k2 > k1);
  const ctx = vm.createContext({ console, Date, JSON });
  vm.runInContext(src.slice(k1, k2) + ';globalThis.__k = { appVraagKnoppen, appKnopDatumOk, appVraagRij, appVraagKnoppenVeld, appGevoelig };', ctx);
  const K = ctx.__k;
  const NU = Date.UTC(2026, 10, 27, 12);   // vrijdag 27-11-2026
  const V = (zin, kn) => 'Even kijken.\n\nVRAAG AAN DAVID: ' + zin + (kn ? '\n' + kn : '');
  // (A) puur
  toets('A1 drie knoppen', JSON.stringify(K.appVraagKnoppen(V('Welke opzet wil je?', 'KNOPPEN: Kort | Uitgebreid | Allebei'), NU)) === '["Kort","Uitgebreid","Allebei"]');
  toets('A2 twee knoppen, opmaak eraf', JSON.stringify(K.appVraagKnoppen(V('Welke?', '**KNOPPEN:** *Eerst A* | `Eerst B`'), NU)) === '["Eerst A","Eerst B"]');
  toets('A3 één of vier = geen', K.appVraagKnoppen(V('Welke?', 'KNOPPEN: Alleen A'), NU) === null && K.appVraagKnoppen(V('Welke?', 'KNOPPEN: A | B | C | D'), NU) === null);
  toets('A4 niet direct onder de vraag = geen', K.appVraagKnoppen(V('Welke?', '\nKNOPPEN: A | B'), NU) === null && K.appVraagKnoppen('KNOPPEN: A | B\nVRAAG AAN DAVID: Welke?', NU) === null);
  toets('A5 ja/nee/anders zelf, dubbel, leeg, te lang, link = geen', ['KNOPPEN: Ja | Liever later', 'KNOPPEN: Nee. | Ja', 'KNOPPEN: Anders | B', 'KNOPPEN: A | a', 'KNOPPEN: A | ', 'KNOPPEN: A | ' + 'x'.repeat(41), 'KNOPPEN: A | zie https://x.nl', 'KNOPPEN: A | map /opt/data']
    .every(function (k) { return K.appVraagKnoppen(V('Welke?', k), NU) === null; }));
  toets('A6 datum: bestaande dag + passende weekdag mag', JSON.stringify(K.appVraagKnoppen(V('Wanneer?', 'KNOPPEN: Dinsdag 1-12 | wo 2-12 | Volgende week'), NU)) === '["Dinsdag 1-12","wo 2-12","Volgende week"]');
  toets('A7 datum: 31-11 / 30-2 / weekdag past niet = geen (MOET 1)', K.appVraagKnoppen(V('Wanneer?', 'KNOPPEN: 31-11 | 1-12'), NU) === null && K.appVraagKnoppen(V('Wanneer?', 'KNOPPEN: 30-2 | 1-3'), NU) === null &&
    K.appVraagKnoppen(V('Wanneer?', 'KNOPPEN: dinsdag 2-12 | woensdag 3-12'), NU) === null && K.appVraagKnoppen(V('Wanneer?', 'KNOPPEN: vr 4-12-2026 | za 5-12-2026'), NU) !== null);
  toets('A8 "maart 3-4" is geen weekdag', K.appKnopDatumOk('maart 3-4', NU) === true);
  const rij = (zin, kn, raw) => K.appVraagRij({ tekst: zin }, raw || V(zin, kn), 'hoofd', 'T');
  const r1 = rij('Welke opzet wil je voor de weekpagina?', 'KNOPPEN: Kort | Uitgebreid | Allebei');
  toets('A9 gewone vraag met knoppen: niet gevoelig, knoppen in de rij en in het veld {id,tekst}', r1.gevoelig === false && r1.knoppen.length === 3 &&
    JSON.stringify(K.appVraagKnoppenVeld(r1)) === '[{"id":"k1","tekst":"Kort"},{"id":"k2","tekst":"Uitgebreid"},{"id":"k3","tekst":"Allebei"}]', r1);
  const r2 = rij('Zal ik de mail aan Jan versturen?', 'KNOPPEN: Nu | Morgen');
  toets('A10 verstuurvraag: gevoelig, geen knoppen (Ja met vingerafdruk)', r2.gevoelig === true && r2.gevoelig_reden === 'versturen' && !r2.knoppen && K.appVraagKnoppenVeld(r2) === undefined, r2);
  const r3 = rij('Welke tijd past je het best?', 'KNOPPEN: Afspraak om 9 uur | Afspraak om 14 uur');
  toets('A11 gevoelig antwoord (agenda) maakt de hele vraag gevoelig, geen knoppen', r3.gevoelig === true && r3.gevoelig_reden === 'agenda' && !r3.knoppen, r3);
  const r4 = rij('Welke route kies je?', 'KNOPPEN: Betaal nu | Wacht');
  const r5 = rij('Welke map ruim ik op?', 'KNOPPEN: Oude scans | Alles van 2019');
  toets('A12 geld en verwijderen ook: gevoelig, geen knoppen', r4.gevoelig === true && !r4.knoppen && r5.gevoelig === true && !r5.knoppen, [r4, r5]);
  const r6 = rij('Zal ik dit op de werklijst van de machinekamer zetten: een fotolijst?', null, V('Zal ik dit op de werklijst van de machinekamer zetten: een fotolijst?', 'KNOPPEN: Ja graag | Later') + '\n#mk-werklijst');
  toets('A13 doorgeefvraag (#mk-werklijst): geen eigen knoppen', !r6.knoppen, r6);
  const r7 = rij('Welke opzet wil je?', null);
  toets('A14 vraag zonder KNOPPEN-regel: rij als vroeger (geen knoppen-veld)', r7.gevoelig === false && !('knoppen' in r7) && K.appVraagKnoppenVeld(r7) === undefined, r7);
  toets('A15 oude rij zonder gevoelig-veld (= gevoelig): geen knoppen', K.appVraagKnoppenVeld({ knoppen: ['A', 'B'] }) === undefined);
  toets('A16 extra velden blijven (soort socev)', K.appVraagRij({ tekst: 'Welke?' }, V('Welke?', 'KNOPPEN: A | B'), 'machinekamer', 'T', { soort: 'socev' }).soort === 'socev');

  // (B) het echte appKnop
  const knopSrc = pak(/\nasync function appKnop\(req, res, reg, a, s, d, kaart\) \{[\s\S]*?\n\}\n/, 'appKnop');
  const hulp = ['appOntmasker', 'appVraagUit', 'appVraagLeeg', 'appKnopBevestiging'].map(function (n) { return pak(new RegExp('\\nfunction ' + n + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n'), n); }).join('\n') +
    '\n' + src.match(/^const APP_VAST_JA_DICHT = (?:true|false);$/m)[0] + '\n' + pak(/\nfunction appVastJaDicht\(a\) \{[^\n]*\}\n/, 'appVastJaDicht');
  let vragen = {}, log = [], prompts = [], chat = [], vers = false;
  const jobs = {};
  const c2 = vm.createContext({ console, Date, JSON, crypto, Promise, setTimeout, jobs, appStaat: {}, APP_VRAAG_GELDIG_MS: 72 * 3600000, APP_KNOP_RIJ_MAX: 3, APP_KNOP_WACHT_MELD_MS: 30000, APP_CHATLOG_NIET: '',
    APP_KANALEN: { hoofd: 'c-hoofd', machinekamer: 'c-mk' }, DEFAULT_WS: 'ws', DOORBOUW_KNOP: 'Ja, en bouw door tot ik het kan proberen', logError: function () {},
    codeIdVanKanaal: function () { return null; }, CODE_APPS: {},
    appVragen: function () { return JSON.parse(JSON.stringify(vragen)); }, appVragenSchrijf: function (v) { vragen = JSON.parse(JSON.stringify(v)); },
    appAntwoord: function (r) { return r && r.antwoord ? r.antwoord : null; }, appVersOk: function () { return vers; },
    appWeiger: function (res, status, fout) { res.status = status; res.j = { ok: false, fout: fout }; }, appStuur: function (res, status, j) { res.status = status; res.j = j; },
    appMagBeurt: async function () { return true; }, appKnopInRij: function () { return 0; }, appKlok: function (iso) { return new Date(iso || Date.now()).toISOString().slice(11, 16); },
    appKnopRijZet: function () {}, appVjSluitGekoppeld: function () {}, appStartFout: function (res) { res.status = 503; },
    appChatLogVoor: async function (k, rijen) { chat.push(rijen); return true; },
    appKnopVraagTekst: async function (jobId, kanaal, hash) { const l = log.filter(function (x) { return x.job_id === jobId; }).pop(); const v = l ? c2.appVraagUit(l.antwoord) : null; return v && v.hash === hash ? { tekst: v.tekst, bericht: l.antwoord } : null; },
    appStartBeurt: function (a, kanaal, tekst, meta) { const id = meta.job_id; jobs[id] = { status: 'pending' }; setTimeout(function () { Promise.resolve().then(meta.bijStart).then(function (st) { prompts.push({ kanaal: kanaal, prompt: tekst + (st || ''), tekst: meta.tekst }); }); }, 3); return { job_id: id }; } });
  vm.runInContext(src.slice(k1, k2) + '\n' + hulp + '\n' + knopSrc + ';globalThis.__d = { appKnop, appVraagUit, appVraagRij };', c2);
  const D = c2.__d; c2.appVraagUit = D.appVraagUit;
  let jn = 0;
  const vraag = function (k, raw) {
    jn++; const job = (jn.toString(16) + 'b'.repeat(16)).slice(0, 16), v = D.appVraagUit(raw), t = new Date().toISOString();
    log.push({ t: t, job_id: job, antwoord: raw, vraag_hash: v.hash });
    vragen[job + ':' + v.hash] = D.appVraagRij(v, raw, k, t);
    return { job: job, hash: v.hash };
  };
  const druk = async function (q, d, kaart) { const res = { _app: {} }; await D.appKnop({}, res, {}, { id: 'pixel', soort: 'mee' }, {}, Object.assign({ job_id: q.job, vraag_hash: q.hash }, d), kaart); return res; };
  const wacht = async function (n) { for (let i = 0; i < 200 && prompts.length < n; i++) await new Promise(function (r) { setTimeout(r, 5); }); };
  const q1 = vraag('hoofd', V('Welke opzet wil je voor de weekpagina?', 'KNOPPEN: Kort | Uitgebreid | Allebei'));
  let res = await druk(q1, { keuze: 'ja' });
  toets('B1 Ja op een vraag met eigen knoppen = 400, niets gestart', res.status === 400 && /eigen knoppen: Kort \/ Uitgebreid \/ Allebei/.test(res.j.fout) && !vragen[q1.job + ':' + q1.hash].antwoord, res);
  res = await druk(q1, { keuze: 'eigen', knop: 'k4' });
  toets('B2 onbekende knop k4 = 400', res.status === 400, res);
  res = await druk(q1, { keuze: 'eigen', knop: 'k2', toelichting: 'x' });
  toets('B3 eigen knop met toelichting = 400', res.status === 400, res);
  res = await druk(q1, { keuze: 'eigen', knop: 'k2' }, { tekst: 'x', bericht: 'x' });
  toets('B4 eigen knop op een Voor jou-kaart (besluit) = 400', res.status === 400, res);
  res = await druk(q1, { keuze: 'eigen', knop: 'k2' });
  await wacht(1);
  const an = vragen[q1.job + ':' + q1.hash].antwoord || {};
  toets('B5 eigen knop k2: 200, antwoord {keuze eigen, knop k2, tekst Uitgebreid}, geen vingerafdruk', res.status === 200 && an.keuze === 'eigen' && an.knop === 'k2' && an.tekst === 'Uitgebreid' && !an.vingerafdruk, { res, an });
  toets('B6 beurt: [KNOP] David koos "Uitgebreid" … geen Ja op versturen/agenda/verwijderen/geld', prompts.length === 1 && /^\[KNOP\] David koos "Uitgebreid" \(een van jouw eigen knoppen\) op de vraag: "Welke opzet wil je voor de weekpagina\?"/.test(prompts[0].prompt) &&
    /geen Ja op versturen, agenda, verwijderen of geld/.test(prompts[0].prompt) && /vraag-id [a-f0-9]{8}/.test(prompts[0].prompt) && prompts[0].tekst === '✓ Uitgebreid — op de vraag: Welke opzet wil je voor de weekpagina?', prompts[0]);
  const dv = (chat[0] || [])[1] || {};
  toets('B7 chat_log: bevestiging knop-eigen (Poortwachter: geen Ja), tekst noemt het gekozen antwoord', dv.bevestiging === 'knop-eigen' && /^"Uitgebreid" \(knop in de app\) op de vraag/.test(dv.tekst), dv);
  res = await druk(q1, { keuze: 'eigen', knop: 'k1' });
  toets('B8 tweede tik = 409 al beantwoord met de gekozen tekst', res.status === 409 && /al beantwoord: "Uitgebreid"/.test(res.j.fout), res);
  const q2 = vraag('hoofd', V('Welke opzet wil je?', 'KNOPPEN: Kort | Lang'));
  res = await druk(q2, { keuze: 'anders', toelichting: 'geen van beide' });
  await wacht(2);
  toets('B9 Anders blijft werken op een vraag met eigen knoppen', res.status === 200 && /^\[KNOP\] David koos ANDERS/.test((prompts[1] || {}).prompt || ''), res);
  const q3 = vraag('hoofd', V('Zal ik de mail aan Jan versturen?', 'KNOPPEN: Nu | Morgen'));
  res = await druk(q3, { keuze: 'eigen', knop: 'k1' });
  toets('B10 verstuurvraag: eigen knop bestaat niet (400)', res.status === 400, res);
  vers = false; res = await druk(q3, { keuze: 'ja' });
  toets('B11 verstuurvraag: Ja vraagt een verse vingerafdruk (403)', res.status === 403 && res.j.vers_nodig === true, res);
  vers = true; res = await druk(q3, { keuze: 'ja' });
  await wacht(3);
  toets('B12 verstuurvraag: Ja met vingerafdruk gaat door als vroeger', res.status === 200 && /^\[KNOP\] David drukte JA op de vraag/.test((prompts[2] || {}).prompt || '') && /met verse vingerafdruk bevestigd/.test(prompts[2].prompt), res);
  vers = false;
  const q4 = vraag('hoofd', V('Zal ik de weekpagina korter maken?'));
  res = await druk(q4, { keuze: 'eigen', knop: 'k1' });
  toets('B13 vraag zonder eigen knoppen: eigen = 400', res.status === 400, res);
  res = await druk(q4, { keuze: 'nee' });
  await wacht(4);
  toets('B14 vraag zonder eigen knoppen: Nee werkt als vroeger', res.status === 200 && /^\[KNOP\] David drukte NEE/.test((prompts[3] || {}).prompt || ''), res);

  // (C) bron
  toets('C1 appNaBeurt en /bericht registreren via appVraagRij', (src.match(/appVraagRij\(vraag, (?:out|tekst), /g) || []).length === 2 && !/gevoelig: !!gev, gevoelig_reden: gev \|\| undefined, soort: 'socev' \}/.test(src));
  toets('C2 uitslag, geschiedenis en Moet iets geven knoppen', /knoppen: appVraagKnoppenVan\(id, vraag\.hash\)/.test(src) && /knoppen: verlopen \? undefined : appVraagKnoppenVeld\(b\)/.test(src) && /soort: 'vraag', hash: x\.vraag_hash, tekst: v\.tekst, gevoelig: r\.gevoelig !== false, knoppen: appVraagKnoppenVeld\(r\)/.test(src));
  toets('C3 appAntwoord geeft de tekst van een eigen knop door', /tekst: x\.keuze === 'eigen' \? x\.tekst : undefined/.test(src));
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  onverwacht: ' + (e && e.stack || e)); process.exit(1); });
JS
