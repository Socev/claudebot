#!/usr/bin/env bash
# Toetst "Ja, en bouw door tot ik het kan proberen" (wv3692, besluitenpagina nr 420 = 3C120; ontwerp mk-scripts/wv3692/ontwerp.md).
# Zelfde harnas als test/doorgeefluik.sh: het echte appKnop + de blokken Doorgeefluik en wv3692 uit server.js in een vm, nep-werkvoorraad.
# (1) doorgeefvraag + doorbouw -> rij + doorwerk-citaat + BOUW DOOR in de opdracht + systeemregel; (2) gewone Ja -> geen doorwerk, opdracht als
# vroeger; (3) doorbouw bij Nee / bij een gewone vraag / bij een gevoelige vraag / ongeldig veld -> 400, niets gestart; (4) kaart met en zonder
# doorbouw-vlag; (5) Stop: keten (ouder_id) vervallen, lopende agent gestopt, machtiging weg, klaar-rij blijft; (6) bronregels appVoorJouKnop.
# Raakt niets echts (wegwerpmap, geen netwerk). Gebruik: bash test/doorbouw.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), crypto = require('crypto');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 900) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbouw-toets-'));
const src = fs.readFileSync('server.js', 'utf8');
const pak = function (re, naam) { const m = re.exec(src); if (!m) { toets('gevonden: ' + naam, false); return ''; } return m[0]; };

(async function () {
  const s1 = src.indexOf('// ── Doorgeefluik (wv1267'), s2 = src.indexOf('// ── einde Doorgeefluik ──');
  const b1 = src.indexOf('// ── wv3692 (besluitenpagina nr 420'), b2 = src.indexOf('// ── einde wv3692 ──');
  toets('0 server.js: blok wv3692 gevonden', b1 > s2 && b2 > b1);
  toets('0 server.js: blok Doorgeefluik gevonden', s1 > 0 && s2 > s1);
  const vraagDbSrc = pak(/\nfunction appDoorbouwVraag\(jobId, vraag, bericht\) \{[\s\S]*?\n\}\n/, 'appDoorbouwVraag');   // wv3810
  const knopSrc = pak(/\nasync function appKnop\(req, res, reg, a, s, d, kaart\) \{[\s\S]*?\n\}\n/, 'appKnop');
  const hulp = ['appOntmasker', 'appElfproef', 'appBsnMasker', 'appEenRegel', 'appVraagUit', 'appVraagLeeg', 'appKnopBevestiging', 'appVraagKnoppenVeld']
    .map(function (n) { return pak(new RegExp('\\nfunction ' + n + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n'), n); }).join('\n') + '\n' + src.match(/^const APP_VAST_JA_DICHT = (?:true|false);$/m)[0] + '\n' + pak(/\nfunction appVastJaDicht\(a\) \{[^\n]*\}\n/, 'appVastJaDicht') + '';
  toets('0 bron doorgeefluik in BERICHT_BRONNEN', /'doorgeefluik',\s+\/\/ wv1267/.test(src));
  toets('0 health kent doorgeefluik', /doorgeefluik: typeof doorgeefInfo === 'function' \? doorgeefInfo\(\)/.test(src));
  toets('0 appKnop: alleen Ja, geen kaart; rij pas bij de start van de beurt (in bijStart)', /const luik = keuze === 'ja' && !kaart && vb && typeof doorgeefHerken === 'function'/.test(knopSrc) &&
    (knopSrc.match(/doorgeefKnop\(/g) || []).length === 1 && /const bijStartMet = !luik \? bijStart : function \(\) \{\n    return Promise\.all\(\[[^\n]*doorgeefKnop\(sleutel, jobId, hash, luik\.zin, drukT, luik\.app, doorbouw\)\]\)/.test(knopSrc) &&
    /bijStart: bijStartMet,/.test(knopSrc));

  // ── nagebootste omgeving ──
  const SCH = path.join(W, 'doorgeefluik.json'), STAAT = path.join(W, 'staat.json'), BLOK = path.join(W, 'blok.txt');
  fs.writeFileSync(BLOK, '```\nGRONDWET-KERN v1 — proefblok\n```\n\nWERKVOORRAAD-SLOTREGEL (proef)\n');
  let vragen = {}, log = [], rpc = [], berichten = [], prompts = [], rpcFout = null, rpcTraag = 0, stand = { aan: true, vrij_tot: '2026-11-21T22:00:00Z', max_eigen_vrij: 0, max_eigen_normaal: 2 };
  const wv = []; // nep-werkvoorraad
  const jobs = {};
  const env = Object.assign({}, process.env, { DOORGEEF_SCHAKELAAR: SCH, DOORGEEF_STAAT: STAAT, DOORGEEF_BLOK: BLOK, DOORBOUW_TWEEDE_MS: '50' });
  const ctx = vm.createContext({ require, console, process: Object.assign({}, process, { env }), Buffer, setTimeout, clearTimeout, Promise, Date, JSON, crypto, fs, path,
    jobs, appStaat: {}, APP_VRAAG_GELDIG_MS: 72 * 3600000, APP_KNOP_RIJ_MAX: 3, APP_KNOP_WACHT_MELD_MS: 30000, APP_CHATLOG_NIET: '', APP_BSN_MASKER: '[BSN-achtig getal weggelaten]',
    APP_KANALEN: { hoofd: 'c-hoofd', machinekamer: 'c-mk' }, MK_TEKST: { GRONDWET: 'GRONDWET-KERN v1 — vaste kopie' },
    logError: function () {}, schrijfLog: function () {}, nu: function () { return 'T'; }, velden: function (o) { return JSON.stringify(o); },
    appVragen: function () { return JSON.parse(JSON.stringify(vragen)); }, appVragenSchrijf: function (v) { vragen = JSON.parse(JSON.stringify(v)); },
    appAntwoord: function (r) { return r && r.antwoord ? r.antwoord : null; }, appNaarTelegramNu: function () { return false; }, appVersOk: function () { return true; },
    appWeiger: function (res, status, fout) { res.status = status; res.j = { ok: false, fout: fout }; }, appStuur: function (res, status, j) { res.status = status; res.j = j; },
    appMagBeurt: async function () { return true; }, appKnopInRij: function () { return 0; }, appKlok: function (iso) { return new Date(iso || Date.now()).toISOString().slice(11, 16); },
    appKnopRijZet: function () {}, appVjSluitGekoppeld: function () {}, appChatLogVoor: async function () { return true; }, appStartFout: function (res) { res.status = 503; },
    appLogLees: async function (k) { return k === 'hoofd' ? log : []; },
    appLeesStreng: function (f, l) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return l; throw e; } return JSON.parse(t); },
    appSchrijfJson: function (f, d) { fs.writeFileSync(f, JSON.stringify(d)); },
    appKnopVraagTekst: async function (jobId, kanaal, hash) {
      const l = log.filter(function (x) { return x.job_id === jobId; }).pop();
      const v = l ? ctx.appVraagUit(l.antwoord) : null;
      return v && v.hash === hash ? { tekst: v.tekst, bericht: l.antwoord } : null;
    },
    appSbRpc: async function (fn, body) {
      rpc.push({ fn: fn, body: body });
      if (rpcTraag) await new Promise(function (r) { setTimeout(r, rpcTraag); });
      if (rpcFout) throw new Error(rpcFout);
      if (fn === 'mk_werkvoorraad_zet') {
        if (body.p_prompt.indexOf('GRONDWET-KERN v1') < 0) throw new Error('rpc mk_werkvoorraad_zet http 400');
        const b = wv.find(function (x) { return x.label === body.p_label; });
        if (b) return { ok: true, id: b.id, bestond: true };
        wv.push({ id: 900 + wv.length, label: body.p_label, prompt: body.p_prompt, status: body.p_status, samenvatting: body.p_samenvatting, herkomst: 'eigen' });
        return { ok: true, id: 900 + wv.length - 1, bestond: false };
      }
      if (fn === 'mk_werkvoorraad_herkomst') { const x = wv.find(function (y) { return y.id === body.p_id; }); x.herkomst = body.p_herkomst; return { ok: true, id: x.id, herkomst: x.herkomst }; }
      if (fn === 'mk_werkvoorraad_stand') return { stand: stand, items: wv };
      if (fn === 'mk_werkvoorraad_doorwerk') {
        const x = wv.find(function (y) { return y.id === body.p_id; });
        if (!x) throw new Error('item bestaat niet');
        if (body.p_opdracht && !/\d{1,2}-\d{1,2}-20\d\d/.test(body.p_opdracht)) return { ok: false, id: x.id, fout: 'doorwerk geweigerd: datum' };
        x.doorwerk_opdracht = body.p_opdracht || null; if (body.p_opdracht) x.herkomst = 'david';
        return { ok: true, id: x.id, doorwerk_opdracht: x.doorwerk_opdracht, herkomst: x.herkomst };
      }
      if (fn === 'mk_werkvoorraad_bijwerk') { const x = wv.find(function (y) { return y.id === body.p_id; }); if (!x) throw new Error('item bestaat niet'); if (body.p_status) x.status = body.p_status; return { ok: true, id: x.id, status: x.status }; }
      throw new Error('onbekende rpc ' + fn);
    },
    berichtIntern: async function (d) { berichten.push(d); return { status: 200, j: { ok: true } }; },
    appStartBeurt: function (a, kanaal, tekst, meta) {
      const id = meta.job_id; jobs[id] = { status: 'pending' };
      if (ctx.vervalAlles) { setTimeout(function () { if (meta.bijVerval) meta.bijVerval(); }, 5); return { job_id: id }; }   // noodstop in de rij: bijStart draait nooit
      setTimeout(function () { Promise.resolve().then(meta.bijStart).then(function (staart) { prompts.push({ id: id, kanaal: kanaal, prompt: tekst + (staart || '') }); }); }, 5);
      return { job_id: id };
    } });
  vm.runInContext(hulp + '\n' + src.slice(s1, s2) + '\n' + src.slice(b1, b2) + '\n' + knopSrc + '\n' + vraagDbSrc + '\n;globalThis.__d = { appKnop, appDoorbouwVraag, doorbouwVraagVeld, doorgeefZet, doorgeefHerken, doorgeefInfo, doorbouwCitaat, doorbouwIs, doorbouwLuikKan, doorbouwKaartRij, doorbouwVastleggen, doorbouwStaart, doorbouwStop, doorbouwStopStaart, DOORBOUW_STOP_RE };', ctx, { filename: 'server.js#doorgeefluik' });
  const D = ctx.__d;
  ctx.appVraagUit = vm.runInContext('appVraagUit', ctx);
  const A = { id: 'pixel', soort: 'mee' };
  const wachtPrompt = async function (n) { for (let i = 0; i < 200 && prompts.length < n; i++) await new Promise(function (r) { setTimeout(r, 10); }); };
  const wachtBericht = async function (n) { for (let i = 0; i < 100 && berichten.length < n; i++) await new Promise(function (r) { setTimeout(r, 10); }); };
  let jn = 0;
  const nieuweJob = function () { jn++; return (jn.toString(16) + 'a'.repeat(16)).slice(0, 16); };
  // een vraag van Socev in kanaal k; geeft {job, hash}
  const vraag = function (k, antwoord, extra) {
    const job = nieuweJob(), v = ctx.appVraagUit(antwoord), t = new Date((extra && extra.t) || Date.now()).toISOString();
    log.push({ t: t, getypt: t, job_id: job, soort: (extra && extra.soort) || 'bericht', tekst: (extra && extra.tekst) || 'kun je dat regelen', antwoord: antwoord, vraag_hash: v && v.hash });
    vragen[job + ':' + v.hash] = Object.assign({ kanaal: k, t: t, antwoord: null, gevoelig: false }, (extra && extra.rij) || {});
    return { job: job, hash: v.hash };
  };
  const druk = async function (q, keuze, kaart) { const res = { _app: {} }; await D.appKnop({}, res, {}, A, {}, { job_id: q.job, vraag_hash: q.hash, keuze: keuze || 'ja', toelichting: keuze === 'anders' ? 'liever anders' : undefined, doorbouw: ctx.__db }, kaart); ctx.__db = undefined; return res; };
  const nu = Date.now();
  const lees = (t) => new Date(nu - t * 60000).toISOString();
  const VR = 'Wat David hier zegt is de opdracht.\n\nVRAAG AAN DAVID: Zal ik dit op de werklijst van de machinekamer zetten: een Mediatheek-app in Socev-app › Apps?\n#mk-werklijst';

  const zetDb = function (v) { ctx.__db = v; };
  fs.writeFileSync(SCH, '{"aan": true}');

  // ── (1) doorgeefvraag + "Ja, en bouw door" ──
  const q1 = vraag('hoofd', VR, { tekst: 'Bouw die mediatheek maar' });
  const rv1 = vragen[q1.job + ':' + q1.hash];
  toets('1 doorbouwLuikKan: echte doorgeefvraag, niet gevoelig, luik aan', D.doorbouwLuikKan(rv1, 'Zal ik dit op de werklijst van de machinekamer zetten: een Mediatheek-app in Socev-app › Apps?', VR) === true);
  zetDb(true);
  let res = await druk(q1, 'ja');
  toets('1 knop: 200, antwoord draagt doorbouw', res.status === 200 && res.j.ok === true && res.j.beantwoord && res.j.beantwoord.doorbouw === true, res);
  await wachtPrompt(1); await wachtBericht(1);
  const r1 = wv[0] || {};
  toets('1 één rij, herkomst david, doorwerk = vast citaat met vraag-id en datum', wv.length === 1 && r1.herkomst === 'david' &&
    new RegExp('^"Ja, en bouw door tot ik het kan proberen" \\(knop in de app, vraag-id ' + q1.hash + '\\) — David \\d{1,2}-\\d{1,2}-20\\d\\d \\d\\d:\\d\\d$').test(r1.doorwerk_opdracht || ''), r1);
  toets('1 opdracht heeft de alinea BOUW DOOR met doorbouw.py meld en de vaste uitzonderingen', /\nBOUW DOOR \(wv3692\): David drukte niet op Ja maar op "Ja, en bouw door tot ik het kan proberen"/.test(r1.prompt || '') &&
    /doorbouw\.py meld --rij <deze rij>/.test(r1.prompt) && /verstuurt, betaalt, verwijdert, een afspraak maakt of credentials raakt/.test(r1.prompt), (r1.prompt || '').slice(-1500));
  toets('1 [KNOP]-beurt zegt JA, EN BOUW DOOR + systeemregel noemt bouw door', prompts.length === 1 && /^\[KNOP\] David drukte JA, EN BOUW DOOR \(knop "Ja, en bouw door tot ik het kan proberen"\)/.test(prompts[0].prompt) &&
    /David koos "Ja, en bouw door": er komt geen "zo bouwen\?"-kaart meer, wel een mededeling met Stop\.\]/.test(prompts[0].prompt), prompts);
  toets('1 regel in de machinekamer noemt de machtiging', berichten.length === 1 && /David koos "Ja, en bouw door" \(doorwerk vastgelegd\)\./.test(berichten[0].tekst), berichten);

  // ── (2) gewone Ja: geen doorwerk, opdracht zonder BOUW DOOR ──
  const q2 = vraag('hoofd', VR.replace('Mediatheek-app', 'Fotolijst-app'), { tekst: 'en een fotolijst' });
  res = await druk(q2, 'ja');
  await wachtPrompt(2); await wachtBericht(2);
  const r2 = wv[1] || {};
  toets('2 gewone Ja: rij zonder doorwerk, opdracht zonder BOUW DOOR, antwoord zonder doorbouw', res.status === 200 && !res.j.beantwoord.doorbouw && wv.length === 2 && !r2.doorwerk_opdracht && !/BOUW DOOR/.test(r2.prompt || '') && !/bouw door/i.test(prompts[1].prompt), { r2, p: prompts[1] });
  toets('2 gewone opdracht: geen lege extra regel (zelfde vorm als vóór wv3692)', /met \(b\), stel dan één VRAAG AAN DAVID in je rapport\. Rapport[^\n]*\n\n\(a\) Vraagzin/.test(r2.prompt || ''), (r2.prompt || '').slice(-900));

  // ── (3) weigeringen: niets gestart, vraag blijft open ──
  const nPr = prompts.length, nWv = wv.length;
  const q3 = vraag('hoofd', VR.replace('Mediatheek-app', 'Notitie-app'));
  zetDb(true); res = await druk(q3, 'nee');
  toets('3 doorbouw bij Nee -> 400', res.status === 400, res);
  zetDb('ja'); res = await druk(q3, 'ja');
  toets('3 doorbouw met ongeldige waarde -> 400', res.status === 400, res);
  const q3b = vraag('hoofd', 'Klaar.\n\nVRAAG AAN DAVID: Zal ik de cache legen?');
  zetDb(true); res = await druk(q3b, 'ja');
  toets('3 doorbouw onder een gewone vraag (geen doorgeefvraag) -> 400', res.status === 400 && /alleen onder de vraag om iets op de werklijst/.test(res.j.fout), res);
  const q3c = vraag('hoofd', VR.replace('Mediatheek-app', 'mailversturer'), { rij: { gevoelig: true } });
  zetDb(true); res = await druk(q3c, 'ja');
  toets('3 doorbouw onder een gevoelige doorgeefvraag -> 400', res.status === 400, res);
  fs.writeFileSync(SCH, '{"aan": false}');
  const q3d = vraag('hoofd', VR.replace('Mediatheek-app', 'Weer-app'));
  zetDb(true); res = await druk(q3d, 'ja');
  toets('3 doorbouw met het luik uit -> 400', res.status === 400, res);
  fs.writeFileSync(SCH, '{"aan": true}');
  await new Promise(function (r) { setTimeout(r, 60); });
  toets('3 geen beurt, geen rij, vragen nog open', prompts.length === nPr && wv.length === nWv && [q3, q3b, q3c, q3d].every(function (q) { return !vragen[q.job + ':' + q.hash].antwoord; }), { n: prompts.length, wv: wv.length });

  // ── (4) kaart: doorbouw alleen met de vlag van appVoorJouKnop ──
  const q4 = vraag('machinekamer', 'x\n\nVRAAG AAN DAVID: Proefonderwerp (verzonnen) zo bouwen?');
  zetDb(true); res = await druk(q4, 'ja', { tekst: 'Proefonderwerp (verzonnen) zo bouwen?', bericht: 'b', context: '', gevoelig: false });
  toets('4 kaart zonder doorbouw-vlag + doorbouw -> 400', res.status === 400, res);
  let staart4 = null;
  zetDb(true); res = await druk(q4, 'ja', { tekst: 'Proefonderwerp (verzonnen) zo bouwen?', bericht: 'b', context: '', gevoelig: false, doorbouw: true, bijStart: function () { staart4 = 'X'; return Promise.resolve('\n[STAART]'); } });
  await wachtPrompt(nPr + 1);
  toets('4 kaart met vlag: 200, beurt JA, EN BOUW DOOR, staart van de kaart erachter', res.status === 200 && res.j.beantwoord.doorbouw === true && /^\[KNOP\] David drukte JA, EN BOUW DOOR/.test(prompts[prompts.length - 1].prompt) && /\[STAART\]$/.test(prompts[prompts.length - 1].prompt), { res, p: prompts[prompts.length - 1] });

  // ── (4b) vastleggen op een kaartrij + kaartrij-regel ──
  wv.push({ id: 950, label: 'machinekamer:proef-950', status: 'geblokkeerd', geblokkeerd_door: 'David: zo bouwen?', herkomst: 'eigen' });
  toets('4 doorbouwKaartRij: wv950 geblokkeerd op David = ja; andere sleutel/status = nee', !!D.doorbouwKaartRij({ sleutel: 'wv950' }, wv) && !D.doorbouwKaartRij({ sleutel: 'pot-vrijgave-950' }, wv) &&
    !D.doorbouwKaartRij({ sleutel: 'wv900' }, wv));
  const v4 = await D.doorbouwVastleggen(950, 'abcdef12', Date.now());
  toets('4 doorbouwVastleggen: ok, citaat op de rij, staart noemt wv950', v4.ok === true && D.doorbouwIs(wv.find(function (x) { return x.id === 950; }).doorwerk_opdracht) && /doorwerk-opdracht op werkvoorraadrij wv950/.test(D.doorbouwStaart(v4)), v4);
  const v4b = await D.doorbouwVastleggen(999999, 'abcdef12', Date.now());
  toets('4 vastleggen mislukt -> niet stil: staart met de reden en het herstelcommando', v4b.ok === false && /kon dat NIET vastleggen op wv999999/.test(D.doorbouwStaart(v4b)) && /werkvoorraad\.py doorwerk --id 999999/.test(D.doorbouwStaart(v4b)), v4b);

  // ── (5) Stop: keten ──
  let gestopt = 0;
  jobs['agentjob00000001'] = { status: 'running', progress: { stoppen: function () { gestopt++; } } };
  wv.push({ id: 960, status: 'gestart', job_id: 'agentjob00000001', ouder_id: null, doorwerk_opdracht: D.doorbouwCitaat('11112222', Date.now()) });
  wv.push({ id: 961, status: 'open', ouder_id: 960, doorwerk_opdracht: D.doorbouwCitaat('11112222', Date.now()) });
  wv.push({ id: 962, status: 'geblokkeerd', ouder_id: 961 });
  wv.push({ id: 963, status: 'klaar', ouder_id: 960 });
  wv.push({ id: 970, status: 'open', ouder_id: 940 });   // andere keten
  const st5 = await D.doorbouwStop(960);
  const s = function (id) { return wv.find(function (x) { return x.id === id; }); };
  toets('5 Stop: 960 (gestart) gestopt + vervallen, 961/962 vervallen, 963 klaar blijft, 970 (andere klus) ongemoeid', gestopt === 1 && s(960).status === 'vervallen' && s(961).status === 'vervallen' &&
    s(962).status === 'vervallen' && s(963).status === 'klaar' && s(970).status === 'open', { st5, wv: wv.slice(-5) });
  toets('5 Stop: machtiging weg op de keten', !s(960).doorwerk_opdracht && !s(961).doorwerk_opdracht, wv.slice(-5));
  toets('5 Stop-staart noemt wat de pod deed', /David drukte STOP op de doorbouw-mededeling van wv960\. De pod deed dit al zelf: op vervallen wv960, wv961, wv962; lopende agent gestopt bij wv960; al afgerond wv963\./.test(D.doorbouwStopStaart(st5)), D.doorbouwStopStaart(st5));
  // tweede ronde: een vervolgrij die de gestopte agent nog net zette, gaat na DOORBOUW_TWEEDE_MS ook op vervallen
  wv.push({ id: 964, status: 'open', ouder_id: 961 });
  await new Promise(function (r) { setTimeout(r, 120); });
  toets('5 tweede Stop-ronde vangt een nagekomen vervolgrij', s(964).status === 'vervallen' && s(970).status === 'open', wv.slice(-3));
  const st5b = await D.doorbouwStop(123456);
  toets('5 Stop op onbekende rij: fout genoemd, niets geraakt', st5b.fout.length === 1 && !st5b.vervallen.length && s(970).status === 'open', st5b);
  toets('5 sleutel doorbouw-<rij>', D.DOORBOUW_STOP_RE.test('doorbouw-960') && !D.DOORBOUW_STOP_RE.test('doorbouw-0') && !D.DOORBOUW_STOP_RE.test('wv960'));
  // Stop via appKnop: kaart.stop -> tekst STOP
  const q5 = vraag('machinekamer', 'x\n\nVRAAG AAN DAVID: Proefonderwerp — ik bouw door?');
  res = await druk(q5, 'nee', { tekst: 'Proefonderwerp — ik bouw door', bericht: 'b', context: '', gevoelig: false, stop: true });
  await wachtPrompt(prompts.length + 1);
  toets('5 Stop via de kaart: beurt zegt STOP, antwoord draagt stop', res.status === 200 && res.j.beantwoord.stop === true && /^\[KNOP\] David drukte STOP \(knop Stop = Nee\)/.test(prompts[prompts.length - 1].prompt), { res, p: prompts[prompts.length - 1] });

  // ── (6) bronregels appVoorJouKnop / detail / Moet iets ──
  const vj = (/\nasync function appVoorJouKnop\(req, res, reg, a, s, d\) \{[\s\S]*?\n\}\n/.exec(src) || [''])[0];
  toets('6 appVoorJouKnop: Ja op de mededeling geweigerd, doorbouw alleen via doorbouwKaartKan, Stop vóór de beurt, Anders laat de kaart open', /if \(stopRij && keuze === 'ja'\) return appWeiger\(res, 400/.test(vj) &&
    /dbRij = typeof doorbouwKaartKan === 'function' \? await doorbouwKaartKan\(p, k\) : null;\n    if \(!dbRij\) return appWeiger\(res, 400/.test(vj) && /const stopU = stopRij && keuze === 'nee' \? await doorbouwStop\(stopRij\) : null;/.test(vj) && vj.indexOf('await doorbouwStop(stopRij)') < vj.indexOf('const knopDb = appKnop(') &&
    /if \(stopRij && kz === 'anders'\) \{\n[^\n]*v\[sl\]\.antwoord = null;[^\n]*\n            return undefined;/.test(vj) &&
    vj.indexOf('if (dbRij || stopRij) {') < vj.indexOf('const knopRes = appKnop('));
  toets('6 doorbouwKaartKan: nooit bij gevoelig, alleen besluit en wv<id>', /if \(!p \|\| p\.soort !== 'besluit' \|\| !k \|\| k\.gevoelig \|\| k\.waaromNiet \|\| k\.beantwoord \|\| k\.elders\) return null;/.test(src));
  toets('6 detail en 409 geven de knopvorm met doorbouw/stop', /knop: p\.soort === 'besluit' && !sw \? await appVjKnopVormDb\(/.test(src) && /tekst_gewijzigd: true, knop: await appVjKnopVormDb\(p, k\)/.test(src));
  toets('6 Moet iets: doorbouw op de doorgeefvraag', /doorbouw: \(typeof doorbouwLuikKan === 'function' && doorbouwLuikKan\(r, v\.tekst, x\.antwoord\)\) \|\| undefined/.test(src));
  toets('6 mk-tekst: regel Bouw door', /Bouw door \(wv3692\)/.test(fs.readFileSync('mk-tekst.js', 'utf8')));

  // ── (7) wv3810: veld doorbouw voor de vraagknoppen in het gesprek ──
  fs.writeFileSync(SCH, '{"aan": true}');
  const VZ7 = 'Zal ik dit op de werklijst van de machinekamer zetten: een Puzzel-app (verzonnen) in Socev-app › Apps?';
  const VR7 = 'Leuk idee.\n\nVRAAG AAN DAVID: ' + VZ7 + '\n#mk-werklijst';
  const q7 = vraag('hoofd', VR7);
  const vr7 = { hash: q7.hash, tekst: ctx.appVraagUit(VR7).tekst };
  toets('7 open doorgeefvraag, niet gevoelig, luik aan: doorbouw true (geschiedenis en opgehaald antwoord)', D.doorbouwVraagVeld(vragen[q7.job + ':' + q7.hash], vr7.tekst, VR7) === true && D.appDoorbouwVraag(q7.job, vr7, VR7) === true, vr7);
  const q7b = vraag('hoofd', 'Klaar.\n\nVRAAG AAN DAVID: Zal ik de proefmap (verzonnen) opruimen?');
  toets('7 gewone vraag: geen veld', D.appDoorbouwVraag(q7b.job, { hash: q7b.hash, tekst: 'Zal ik de proefmap (verzonnen) opruimen?' }, 'x') === undefined);
  const q7c = vraag('hoofd', VR7.replace('Puzzel-app', 'Mailmachine'), { rij: { gevoelig: true } });
  toets('7 gevoelige doorgeefvraag: geen veld', D.appDoorbouwVraag(q7c.job, { hash: q7c.hash, tekst: VZ7.replace('Puzzel-app', 'Mailmachine') }, VR7.replace('Puzzel-app', 'Mailmachine')) === undefined);
  const q7d = vraag('machinekamer', VR7.replace('Puzzel-app', 'Kaartspel'));
  toets('7 doorgeefzin in de machinekamer: geen veld', D.appDoorbouwVraag(q7d.job, { hash: q7d.hash, tekst: VZ7.replace('Puzzel-app', 'Kaartspel') }, VR7.replace('Puzzel-app', 'Kaartspel')) === undefined);
  toets('7 zonder #mk-werklijst: geen veld', D.appDoorbouwVraag(q7.job, vr7, VR7.replace('#mk-werklijst', '')) === undefined);
  toets('7 onbekende vraag: geen veld', D.appDoorbouwVraag('ffffffffffffffff', vr7, VR7) === undefined);
  fs.writeFileSync(SCH, '{"aan": false}');
  toets('7 luik uit: geen veld', D.appDoorbouwVraag(q7.job, vr7, VR7) === undefined);
  fs.writeFileSync(SCH, '{"aan": true}');
  vragen[q7.job + ':' + q7.hash].antwoord = { keuze: 'ja', t: new Date().toISOString() };
  toets('7 al beantwoord: geen veld', D.appDoorbouwVraag(q7.job, vr7, VR7) === undefined);
  toets('7 bron: geschiedenis zet doorbouw op de vraag (niet bij verlopen of Telegram)', /verlopen: verlopen \|\| undefined,(?: knoppen: verlopen \? undefined : appVraagKnoppenVeld\(b\),   \/\/ wv4179)?\n        doorbouw: !verlopen && !appNaarTelegramNu\(b\) && typeof doorbouwVraagVeld === 'function' \? doorbouwVraagVeld\(bRij, \(appVraagUit\(x\.antwoord\) \|\| \{\}\)\.tekst, x\.antwoord\) : undefined \}/.test(src));
  toets('7 bron: opgehaald antwoord (appUitslag) zet doorbouw op de vraag', /gevoelig: appVraagGevoelig\(id, vraag\.hash\),(?: knoppen: appVraagKnoppenVan\(id, vraag\.hash\),   \/\/ wv4179)?\n      doorbouw: typeof doorbouwVraagVeld === 'function' \? appDoorbouwVraag\(id, vraag, out\) : undefined \} : null,/.test(src));

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
