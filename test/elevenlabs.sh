#!/usr/bin/env bash
# Toetst de ElevenLabs-motor van studio.js en de ElevenLabs-stemmen van bandjes.js (wv782, Studio fase 2 deel stem, 22-10-2026) tegen een
# nagebootste Olares Router op 127.0.0.1. Vorm van de echte Router gemeten 22-10 (mk-scripts/elevenlabs/voortgang.md):
# POST /v1/text-to-speech/<voice_id>/stream?output_format=pcm_24000, body { text, model_id, model }, kop character-cost terug.
# Toetst: zonder sleutel "wacht" en geen aanroep; betaald = verse vingerafdruk per taak (403 vers_nodig zonder, geen reservering en geen
# aanroep); stem en model alleen uit de witte lijst; prijs vooraf = tekens × tarief (Flash goedkoper); reservering vóór de aanroep en
# verrekend na levering (credits erbij); maandplafond weigert vóór de vingerafdruk; HTTP-fout = vrijgegeven, netwerkfout = geschat;
# stoppen in de rij = vrijgegeven; herstart met open reservering (aangeroepen = geschat, niet = vrijgegeven); WAV 24 kHz + twee
# telefoonversies; nooit automatisch opnieuw; geen tekst in audit/log/verbruik; sleutel alleen naar de Router. Bandjes: ElevenLabs-stemmen
# uit beide registers op de flow bandje-elevenlabs, model uit invoer of praktijkinstelling of standaard, voice-id en model naar Studio.
# Raakt de echte Router, kluis en /opt/data niet. Gebruik: bash test/elevenlabs.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const studioMod = require('./studio.js');
const B = require('./bandjes.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-'));
const SLEUTEL = 'sk-studio-' + 'e'.repeat(26);
const ROOS = '7qdUFMklKPaaAVMsBTBt';
const GEHEIM = 'Welkom bij de praktijk, dit is een geheime toetszin';
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 8000); while (Date.now() < t) { if (await f()) return true; await slaap(20); } return false; }

// ── nagebootste Router ──
const R = { posts: [], auth: [], modus: 'goed', credits: '42', hang: null };
const PCM = Buffer.alloc(24000 * 2);   // 1 s toon van 440 Hz, 24 kHz s16le
for (let i = 0; i < 24000; i++) PCM.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 24000)), i * 2);
const router = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    R.auth.push(req.headers.authorization || '');
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'elevenlabs/eleven_v3', owned_by: 'elevenlabs', mode: 'tts' }] })); }
    const m = /^\/v1\/text-to-speech\/([A-Za-z0-9]+)\/stream\?output_format=([a-z0-9_]+)$/.exec(req.url);
    if (req.method === 'POST' && m) {
      R.posts.push({ voice: m[1], formaat: m[2], body: JSON.parse(body || '{}'), kop: req.headers });
      if (R.modus === '401') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ detail: { status: 'missing_permissions', message: 'The API key ' + SLEUTEL + ' is missing the permission text_to_speech' } })); }
      if (R.modus === '502') { res.writeHead(502, { 'Content-Type': 'text/plain' }); return res.end('bad gateway'); }
      if (R.modus === '422') { res.writeHead(422, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'model does not declare POST', code: 'audio_operation_not_supported' } })); }
      if (R.modus === 'breek') { res.writeHead(200, { 'Content-Type': 'audio/pcm', 'character-cost': R.credits }); res.write(PCM.subarray(0, 1000)); return setTimeout(() => req.socket.destroy(), 30); }
      if (R.modus === 'hang') { R.hang = res; res.writeHead(200, { 'Content-Type': 'audio/pcm', 'character-cost': R.credits }); res.write(PCM.subarray(0, 1000)); return; }
      res.writeHead(200, { 'Content-Type': 'audio/pcm', 'character-cost': R.credits, 'request-id': 'ReqAbc123' });
      return res.end(PCM);
    }
    res.writeHead(404); res.end('404 page not found');
  });
});

(async function () {
  await new Promise((r) => router.listen(0, '127.0.0.1', r));
  const RURL = 'http://127.0.0.1:' + router.address().port;
  const DIR = path.join(W, 'studio'), BEWAAR = path.join(W, 'bewaar');
  const zetFlow = (naam, y) => { fs.mkdirSync(path.join(DIR, 'flows', naam), { recursive: true }); fs.writeFileSync(path.join(DIR, 'flows', naam, 'flow.yaml'), JSON.stringify(y)); };
  // de echte flowbestanden uit de repo
  for (const n of ['bandje-elevenlabs', 'stem-elevenlabs']) zetFlow(n, JSON.parse(fs.readFileSync(path.join('studio-flows', n, 'flow.yaml'), 'utf8')));
  zetFlow('eleven-zonder-stem', { titel: 'kapot', motor: 'elevenlabs', status: 'actief', velden: [{ naam: 'tekst', soort: 'tekstvak', verplicht: true }] });
  const bewaard = {};
  const bewaar = (jobId, outdir, meta) => {
    const dir = path.join(BEWAAR, jobId); fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
    const lijst = [];
    for (const n of fs.readdirSync(outdir).sort()) { const doel = path.join(dir, 'b', String(lijst.length + 1)); const g = fs.statSync(path.join(outdir, n)).size; fs.renameSync(path.join(outdir, n), doel); lijst.push({ n: lijst.length + 1, naam: n, grootte: g }); }
    const m = { job_id: jobId, label: meta.label, bestanden: lijst, studio: meta.studio }; bewaard[jobId] = m; return m;
  };
  let sleutel = null;
  const logs = [], fouts = [];
  const maakStudio = () => studioMod.maak({ dir: DIR, bewaar, primair: () => true, sleutel: async () => sleutel, routerUrl: RURL,
    log: (r) => logs.push(r), fout: (w, e) => fouts.push(w + ': ' + (e && e.message)), tempo: { poll: 20 } });
  let S = maakStudio();
  let vers = false, verbruikt = 0;
  const ctx = { versOk: () => vers, versVerbruik: () => { vers = false; verbruikt++; }, apparaat: 'toets' };
  let beurt = 0;
  const nieuweBeurt = () => 'beurt-eleven-' + (++beurt);
  const wachtKlaar = (id) => totDat(() => { const t = S.taak(id); return t && ['klaar', 'mislukt', 'gestopt', 'onderbroken'].indexOf(t.status) >= 0; });
  const verbruikRegels = () => { try { return fs.readFileSync(path.join(DIR, 'verbruik.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };

  // 1. catalogus
  let c = await S.flows({ verborgen: true });
  const stem = c.flows.find((f) => f.id === 'stem-elevenlabs'), band = c.flows.find((f) => f.id === 'bandje-elevenlabs');
  toets('1 stem-elevenlabs zichtbaar, bandje-elevenlabs alleen met verborgen', !!stem && !!band && !(await S.flows()).flows.some((f) => f.id === 'bandje-elevenlabs'));
  toets('1 zonder sleutel: wacht op de Router-sleutel, niet klaar', stem && stem.klaar === false && /Router-sleutel/.test(stem.reden || ''), stem);
  toets('1 flow kapot zonder veld stem', (c.flows.find((f) => f.id === 'eleven-zonder-stem') || {}).klaar === false);
  toets('1 betaald, prijs, vers_per_keer, motor_naam noemt ElevenLabs VS', stem.betaald === true && stem.vers_per_keer === true && /betaald/.test(stem.prijs) && /VS/.test(stem.motor_naam) && stem.prijs_tabel && stem.prijs_tabel.eleven_flash_v2_5 === 0.05);
  const mv = stem.velden.find((v) => v.naam === 'model');
  toets('1 model-veld uit de pod (3 modellen, standaard multilingual_v2)', mv && mv.soort === 'keuze' && mv.opties.length === 3 && mv.standaard === 'eleven_multilingual_v2', mv);
  let r = await S.maak({ flow: 'stem-elevenlabs', velden: { tekst: GEHEIM, stem: ROOS }, beurt_id: nieuweBeurt() }, ctx);
  toets('1 maak zonder sleutel: 409, niets naar de aanbieder', r.status === 409 && R.posts.length === 0, r);
  sleutel = SLEUTEL;
  c = await S.flows({ verborgen: true });
  toets('1 met sleutel: klaar', c.flows.find((f) => f.id === 'stem-elevenlabs').klaar === true);

  // 2. vingerafdruk per taak
  r = await S.maak({ flow: 'stem-elevenlabs', velden: { tekst: GEHEIM, stem: ROOS }, beurt_id: nieuweBeurt() }, ctx);
  toets('2 zonder verse vingerafdruk: 403 vers_nodig met prijs', r.status === 403 && r.vers_nodig === true && /€ 0,01/.test(r.fout), r);
  toets('2 geen reservering en geen aanroep', verbruikRegels().length === 0 && R.posts.length === 0);
  // 3. witte lijst
  vers = true;
  r = await S.maak({ flow: 'stem-elevenlabs', velden: { tekst: GEHEIM, stem: 'andere-stem' }, beurt_id: nieuweBeurt() }, ctx);
  toets('3 stem buiten de keuzelijst: 400', r.status === 400, r);
  r = await S.maak({ flow: 'bandje-elevenlabs', velden: { tekst: GEHEIM, stem: '../../v1/x' }, beurt_id: nieuweBeurt() }, ctx);
  toets('3 voice-id met tekens buiten [A-Za-z0-9]: 400', r.status === 400 && /stem/.test(r.fout), r);
  r = await S.maak({ flow: 'bandje-elevenlabs', velden: { tekst: GEHEIM, stem: ROOS, model: 'eleven_turbo_v9' }, beurt_id: nieuweBeurt() }, ctx);
  toets('3 onbekend model: 400', r.status === 400, r);
  toets('3 vingerafdruk niet verbruikt bij een weigering', verbruikt === 0 && vers === true);

  // 4. geslaagde taak
  r = await S.maak({ flow: 'stem-elevenlabs', velden: { tekst: GEHEIM, stem: ROOS }, beurt_id: nieuweBeurt() }, ctx);
  toets('4 maak met vingerafdruk: 200, vingerafdruk verbruikt', r.status === 200 && verbruikt === 1 && vers === false, r);
  const v0 = verbruikRegels();
  toets('4 reservering vóór de aanroep (schatting tekens × tarief)', v0.length >= 1 && v0[0].soort === 'gereserveerd' && v0[0].eur === 0.01 && v0[0].tekens === GEHEIM.length, v0);
  await wachtKlaar(r.taak.id);
  let t = S.taak(r.taak.id);
  toets('4 taak klaar', t.status === 'klaar', t);
  const p = R.posts[0] || {};
  toets('4 aanroep: voice in het pad, pcm_24000, model_id + model, tekst', p.voice === ROOS && p.formaat === 'pcm_24000' && p.body.model_id === 'eleven_multilingual_v2' && p.body.model === 'elevenlabs/eleven_multilingual_v2' && p.body.text === GEHEIM, p);
  toets('4 eigen sleutel als Bearer', p.kop && p.kop.authorization === 'Bearer ' + SLEUTEL);
  toets('4 bestanden: stem.wav + twee telefoonversies', t.bestanden.map((b) => b.naam).join(',') === 'stem-telefoon-pcm.wav,stem-telefoon-ulaw.wav,stem.wav', t.bestanden);
  const wav = fs.readFileSync(path.join(BEWAAR, t.id, 'b', '3'));
  toets('4 WAV: RIFF, PCM 16-bit mono 24 kHz, data = PCM', wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 1 && wav.readUInt32LE(24) === 24000 && wav.readUInt16LE(34) === 16 && wav.length === 44 + PCM.length);
  const ul = fs.readFileSync(path.join(BEWAAR, t.id, 'b', '2'));
  toets('4 telefoonversie µ-law 8 kHz (formaat 7)', ul.readUInt16LE(20) === 7 && ul.readUInt32LE(24) === 8000);
  const v1 = verbruikRegels();
  toets('4 verrekend met credits', v1[v1.length - 1].soort === 'verrekend' && v1[v1.length - 1].credits === 42 && v1[v1.length - 1].eur === 0.01, v1);
  toets('4 taak toont kosten en credits', t.betaald === true && t.kosten_eur === 0.01 && t.credits === 42 && t.kosten_staat === 'verrekend', t);
  toets('4 meta in Bestanden draagt kosten', bewaard[t.id] && bewaard[t.id].studio.kosten === 0.01);
  toets('4 stand: besteed en plafond € 10', S.teller().plafond.elevenlabs.plafond_eur === 10 && S.teller().plafond.elevenlabs.besteed_eur === 0.01 && S.teller().kosten_maand === 0.01, S.teller());

  // 5. prijs: Flash goedkoper, lange tekst duurder
  const lang = 'a'.repeat(1500);
  vers = true;
  r = await S.maak({ flow: 'bandje-elevenlabs', velden: { tekst: lang, stem: ROOS, model: 'eleven_flash_v2_5' }, beurt_id: nieuweBeurt() }, ctx);
  await wachtKlaar(r.taak.id);
  const vf = verbruikRegels().filter((x) => x.taak === r.taak.id);
  toets('5 Flash: 1500 tekens = € 0,08 (0,05 per 1.000, naar boven)', vf[0].eur === 0.08 && vf[0].model === 'eleven_flash_v2_5', vf);
  toets('5 bandje-flow: bestandsnaam bandje.wav', S.taak(r.taak.id).bestanden.some((b) => b.naam === 'bandje.wav'));
  vers = true;
  r = await S.maak({ flow: 'bandje-elevenlabs', velden: { tekst: lang, stem: ROOS, model: 'eleven_v3' }, beurt_id: nieuweBeurt() }, ctx);
  await wachtKlaar(r.taak.id);
  toets('5 v3: 1500 tekens = € 0,15', verbruikRegels().filter((x) => x.taak === r.taak.id)[0].eur === 0.15);

  // 6. plafond
  fs.writeFileSync(path.join(DIR, 'studio-limieten.json'), JSON.stringify({ elevenlabs: 0.25 }));
  vers = true; const vb6 = verbruikt, p6 = R.posts.length;
  r = await S.maak({ flow: 'bandje-elevenlabs', velden: { tekst: lang, stem: ROOS }, beurt_id: nieuweBeurt() }, ctx);
  toets('6 boven het plafond: 409 plafond, met bedragen', r.status === 409 && r.plafond === true && /€ 0,25/.test(r.fout) && /€ 0,24/.test(r.fout), r);
  toets('6 geen vingerafdruk verbruikt, geen aanroep', verbruikt === vb6 && vers === true && R.posts.length === p6);
  fs.writeFileSync(path.join(DIR, 'studio-limieten.json'), JSON.stringify({ elevenlabs: 'veel' }));
  toets('6 onleesbaar plafond: standaard € 10', S.teller().plafond.elevenlabs.plafond_eur === 10);
  fs.writeFileSync(path.join(DIR, 'studio-limieten.json'), JSON.stringify({ elevenlabs: 10 }));

  // 7. HTTP-fout: vrijgegeven, sleutelmelding zonder sleutel, nooit opnieuw
  R.modus = '401'; vers = true; const p7 = R.posts.length;
  r = await S.maak({ flow: 'bandje-elevenlabs', velden: { tekst: GEHEIM, stem: ROOS }, beurt_id: nieuweBeurt() }, ctx);
  await wachtKlaar(r.taak.id); t = S.taak(r.taak.id);
  toets('7 401: mislukt met gewone taal over de sleutel', t.status === 'mislukt' && /mag ElevenLabs \(nog\) niet aanroepen/.test(t.reden), t);
  toets('7 sleutel niet in de reden', t.reden.indexOf(SLEUTEL) < 0 && t.reden.indexOf('eeeeeeee') < 0, t.reden);
  toets('7 precies één aanroep (nooit opnieuw)', R.posts.length === p7 + 1);
  toets('7 reservering vrijgegeven (telt niet)', verbruikRegels().filter((x) => x.taak === t.id).pop().soort === 'vrijgegeven' && t.kosten_eur === 0);
  R.modus = '422'; vers = true;
  r = await S.maak({ flow: 'bandje-elevenlabs', velden: { tekst: GEHEIM, stem: ROOS }, beurt_id: nieuweBeurt() }, ctx);
  await wachtKlaar(r.taak.id);
  toets('7 422 van Router: mislukt, vrijgegeven', S.taak(r.taak.id).status === 'mislukt' && verbruikRegels().filter((x) => x.taak === r.taak.id).pop().soort === 'vrijgegeven');

  R.modus = '502'; vers = true;
  r = await S.maak({ flow: 'bandje-elevenlabs', velden: { tekst: GEHEIM, stem: ROOS }, beurt_id: nieuweBeurt() }, ctx);
  await wachtKlaar(r.taak.id);
  toets('7 502 van Router: mislukt, geschat (telt mee; Fable #2)', S.taak(r.taak.id).status === 'mislukt' && verbruikRegels().filter((x) => x.taak === r.taak.id).pop().soort === 'geschat');

  // 8. verbinding breekt midden in het geluid: geschat (telt mee)
  R.modus = 'breek'; vers = true; const voor8 = S.teller().plafond.elevenlabs.besteed_eur;
  r = await S.maak({ flow: 'bandje-elevenlabs', velden: { tekst: GEHEIM, stem: ROOS }, beurt_id: nieuweBeurt() }, ctx);
  await wachtKlaar(r.taak.id); t = S.taak(r.taak.id);
  toets('8 afgebroken: mislukt, geschat, telt mee', t.status === 'mislukt' && verbruikRegels().filter((x) => x.taak === t.id).pop().soort === 'geschat' && S.teller().plafond.elevenlabs.besteed_eur === Math.round((voor8 + 0.01) * 100) / 100, { t, v: verbruikRegels().slice(-2) });

  // 9. stoppen in de rij = vrijgegeven; stoppen tijdens de aanroep = geschat
  R.modus = 'hang'; vers = true;
  const ra = await S.maak({ flow: 'bandje-elevenlabs', velden: { tekst: GEHEIM, stem: ROOS }, beurt_id: nieuweBeurt() }, ctx);
  vers = true;
  const rb = await S.maak({ flow: 'bandje-elevenlabs', velden: { tekst: GEHEIM, stem: ROOS }, beurt_id: nieuweBeurt() }, ctx);
  await totDat(() => R.hang);
  S.stop(rb.taak.id);
  toets('9 uit de rij gehaald: vrijgegeven', verbruikRegels().filter((x) => x.taak === rb.taak.id).pop().soort === 'vrijgegeven');
  S.stop(ra.taak.id);
  await wachtKlaar(ra.taak.id);
  toets('9 gestopt tijdens de aanroep: gestopt, geschat', S.taak(ra.taak.id).status === 'gestopt' && verbruikRegels().filter((x) => x.taak === ra.taak.id).pop().soort === 'geschat');
  try { R.hang.end(); } catch (e) {}
  R.hang = null;

  // 10. herstart met open reserveringen
  R.modus = 'hang'; vers = true;
  const rc = await S.maak({ flow: 'bandje-elevenlabs', velden: { tekst: GEHEIM, stem: ROOS }, beurt_id: nieuweBeurt() }, ctx);
  vers = true;
  const rd = await S.maak({ flow: 'bandje-elevenlabs', velden: { tekst: GEHEIM, stem: ROOS }, beurt_id: nieuweBeurt() }, ctx);
  await totDat(() => R.hang);
  S.stopTimers();
  const oud = S; oud._st.rij.length = 0;   // het oude proces "sterft": zijn rij draait niet meer door
  S = maakStudio();   // "herstart": nieuwe instantie op dezelfde map
  toets('10 aangeroepen vóór de herstart: geschat', verbruikRegels().filter((x) => x.taak === rc.taak.id).pop().soort === 'geschat');
  toets('10 nog in de rij bij de herstart: vrijgegeven', verbruikRegels().filter((x) => x.taak === rd.taak.id).pop().soort === 'vrijgegeven');
  toets('10 taken onderbroken, niet opnieuw gestart', S.taak(rc.taak.id).status === 'onderbroken' && S.taak(rd.taak.id).status === 'onderbroken');
  try { R.hang.socket.destroy(); } catch (e) {}
  await totDat(() => !oud._st.bezig);
  R.hang = null;
  R.modus = 'goed';

  // 11. geen tekst in audit, log of verbruik; sleutel alleen naar de Router
  const audit = fs.readFileSync(path.join(DIR, 'audit.jsonl'), 'utf8');
  toets('11 geen tekst in audit.jsonl', audit.indexOf('geheime toetszin') < 0 && audit.indexOf('aaaaaaaaaa') < 0);
  toets('11 audit draagt kosten en credits', /"kosten":0\.01/.test(audit) && /"credits":42/.test(audit));
  toets('11 geen tekst in de logregels', !logs.some((l) => l.indexOf('geheime') >= 0));
  toets('11 geen tekst in verbruik.jsonl', fs.readFileSync(path.join(DIR, 'verbruik.jsonl'), 'utf8').indexOf('geheime') < 0);
  toets('11 rechten verbruik.jsonl 0600', (fs.statSync(path.join(DIR, 'verbruik.jsonl')).mode & 0o777) === 0o600);
  toets('11 geen onverwachte fouten', fouts.length === 0, fouts);

  // 12. bandjes: ElevenLabs-stemmen uit de registers
  c = await S.flows({ verborgen: true });
  const reg = [{ id: 'elevenlabs:' + ROOS, naam: null }, { naam: 'Roos', id: 'elevenlabs:' + ROOS }, { naam: 'Anna', id: 'elevenlabs:AnnaVoice1234' }, { naam: 'Ronnie', id: 'piper:nl_NL-ronnie-medium' }];
  let lijst = B.stemmenUit(c.flows, reg);
  const roos = lijst.find((x) => x.id === 'elevenlabs:' + ROOS);
  toets('12 Roos één keer, betaald, op bandje-elevenlabs, beschikbaar', lijst.filter((x) => x.id === 'elevenlabs:' + ROOS).length === 1 && roos.flow === 'bandje-elevenlabs' && roos.betaald && roos.beschikbaar && roos.vers_per_keer, roos);
  toets('12 Anna ook; geen grijze plaatshouder meer', lijst.some((x) => x.id === 'elevenlabs:AnnaVoice1234') && !lijst.some((x) => x.id === 'elevenlabs'));
  toets('12 modellen + standaard bij de stem', roos.modellen.length === 3 && roos.model_standaard === 'eleven_multilingual_v2');
  toets('12 zonder ElevenLabs-flow: grijze plaatshouder zoals wv743', B.stemmenUit(c.flows.filter((f) => f.motor !== 'elevenlabs'), reg).some((x) => x.id === 'elevenlabs' && !x.beschikbaar));
  sleutel = null;
  const zonder = B.stemmenUit((await S.flows({ verborgen: true })).flows, reg).find((x) => x.id === 'elevenlabs:' + ROOS);
  toets('12 zonder sleutel: Roos niet beschikbaar, met reden', zonder && zonder.beschikbaar === false && /sleutel/.test(zonder.reden || ''), zonder);
  sleutel = SLEUTEL;

  // 13. bandjes maak via routes (echt register in een wegwerpvault)
  const VAULT = path.join(W, 'vault'), BDIR = path.join(W, 'bandjes');
  for (const pr of Object.keys(B.PRAKTIJKEN)) {
    const vp = B.PRAKTIJKEN[pr].voorvoegsel || (pr === 'tolgaarde' ? 'tg' : 'gh');
    const md = '---\ntype: register\nupdated: 2026-10-22\n---\n\n# Bandjes\n\n## Praktijkinstellingen\n- praktijkstem: elevenlabs:' + ROOS + '\n- stemmen: Roos (elevenlabs:' + ROOS + ')\n' +
      (pr === 'groenhouten' ? '- model: eleven_v3\n' : '- model: onbekend (standaard Studio fase 2)\n') + '\n## ' + vp + '-buiten — Buiten openingstijden\n- menu: 1\n- wanneer: buiten\n- stem: praktijkstem\n- versie: 1\n- laatste bestand: —\n- status: concept (v1)\n- bron: toets\n\n**Tekst**\n> Wij zijn gesloten.\n\n';
    fs.mkdirSync(path.dirname(path.join(VAULT, B.PRAKTIJKEN[pr].pad)), { recursive: true });
    fs.writeFileSync(path.join(VAULT, B.PRAKTIJKEN[pr].pad), md);
  }
  const opslag = B.maak({ vault: VAULT, dir: BDIR, fout: (w, e) => fouts.push(w + ': ' + (e && e.message)) });
  opslag.mkdir();
  const rt = B.routes({ opslag, studio: S, primair: () => true, dir: BDIR, boxPad: path.join(W, 'box.md'), log: () => {}, fout: (w, e) => fouts.push(w + ': ' + (e && e.message)) });
  const g = await rt.app('GET /app/bandjes', {}, ctx);
  const tg = g.j.praktijken.find((x) => x.id === 'tolgaarde');
  const bd = tg && tg.bandjes[0];
  toets('13 GET: register leesbaar, Roos in stemmen, kosten met plafond', g.status === 200 && bd && g.j.stemmen.some((x) => x.id === 'elevenlabs:' + ROOS && x.beschikbaar) && g.j.kosten && g.j.kosten.plafond_eur === 10, { st: g.status, pr: g.j.praktijken && g.j.praktijken.map((x) => [x.id, x.fouten, x.bandjes.length]), stemmen: g.j.stemmen, kosten: g.j.kosten });
  if (bd) {
    vers = false;
    let m = await rt.app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: bd.id, versie: bd.versie, tekst_hash: bd.tekst_hash, beurt_id: nieuweBeurt() }, ctx);
    toets('13 maak praktijkstem Roos zonder vingerafdruk: 403 vers_nodig', m.status === 403 && m.j.vers_nodig === true, m);
    vers = true; const p13 = R.posts.length;
    m = await rt.app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: bd.id, versie: bd.versie, tekst_hash: bd.tekst_hash, beurt_id: nieuweBeurt() }, ctx);
    toets('13 maak met vingerafdruk: taak', m.status === 200 && m.j.taak, m);
    await wachtKlaar(m.j.taak.id);
    const pp = R.posts[p13] || {};
    toets('13 Tolgaarde: Roos, model onbekend → standaard multilingual_v2, tekst uit het register', pp.voice === ROOS && pp.body.model_id === 'eleven_multilingual_v2' && pp.body.text === 'Wij zijn gesloten.', pp);
    const t13 = S.taak(m.j.taak.id);
    toets('13 bron draagt stem en model; bestand bandje.wav', t13.bron && t13.bron.stem === 'elevenlabs:' + ROOS && t13.bron.model === 'eleven_multilingual_v2' && t13.bestanden.some((b) => b.naam === 'bandje.wav'), t13);
    rt.naKlaar(t13);
    const na = await rt.app('GET /app/bandjes', {}, ctx);
    const bna = na.j.praktijken.find((x) => x.id === 'tolgaarde').bandjes[0];
    toets('13 register: laatste bestand met stem en model, status gemaakt (v1)', /elevenlabs:7qdUFMklKPaaAVMsBTBt · eleven_multilingual_v2/.test(bna.laatste_bestand || JSON.stringify(bna)) && /gemaakt \(v1\)/.test(JSON.stringify(bna)), bna);
    const gh = na.j.praktijken.find((x) => x.id === 'groenhouten').bandjes[0];
    vers = true; const p14 = R.posts.length;
    m = await rt.app('POST /app/bandjes/maak', { praktijk: 'groenhouten', bandje: gh.id, versie: gh.versie, tekst_hash: gh.tekst_hash, beurt_id: nieuweBeurt() }, ctx);
    await wachtKlaar(m.j.taak.id);
    toets('13 Groenhouten: praktijkinstelling model eleven_v3', (R.posts[p14] || {}).body && R.posts[p14].body.model_id === 'eleven_v3', R.posts[p14]);
    vers = true; const p15 = R.posts.length;
    m = await rt.app('POST /app/bandjes/maak', { praktijk: 'groenhouten', bandje: gh.id, versie: gh.versie, tekst_hash: gh.tekst_hash, model: 'eleven_flash_v2_5', beurt_id: nieuweBeurt() }, ctx);
    await wachtKlaar(m.j.taak.id);
    toets('13 model uit de invoer gaat voor (flash)', (R.posts[p15] || {}).body && R.posts[p15].body.model_id === 'eleven_flash_v2_5');
    vers = true;
    m = await rt.app('POST /app/bandjes/maak', { praktijk: 'groenhouten', bandje: gh.id, versie: gh.versie, tekst_hash: gh.tekst_hash, model: 'eleven_bestaat_niet', beurt_id: nieuweBeurt() }, ctx);
    toets('13 onbekend model uit de invoer: 400, geen stille terugval (Fable #4)', m.status === 400 && /model/.test(m.j.fout), m);
    fs.writeFileSync(path.join(DIR, 'studio-limieten.json'), JSON.stringify({ elevenlabs: 0 }));
    vers = true;
    m = await rt.app('POST /app/bandjes/maak', { praktijk: 'groenhouten', bandje: gh.id, versie: gh.versie, tekst_hash: gh.tekst_hash, beurt_id: nieuweBeurt() }, ctx);
    toets('13 plafond bereikt: 409 met plafond: true via bandjes', m.status === 409 && m.j.plafond === true, m);
    const ins = await rt.app('POST /app/bandjes/instellingen', { praktijk: 'tolgaarde', praktijkstem: 'elevenlabs:' + ROOS }, ctx);
    toets('13 praktijkstem Roos nu toegestaan via instellingen', ins.status === 200, ins);
    fs.writeFileSync(path.join(DIR, 'studio-limieten.json'), JSON.stringify({ elevenlabs: 10 }));
    // Fable #1: bandje met een eigen (betaalde) stem, David kiest expliciet "praktijkstem" (hier een Piper-stem die de toets niet kent)
    const ghPad = path.join(VAULT, B.PRAKTIJKEN.groenhouten.pad);
    fs.writeFileSync(ghPad, fs.readFileSync(ghPad, 'utf8').replace('- praktijkstem: elevenlabs:' + ROOS, '- praktijkstem: piper:nl_NL-ronnie-medium').replace('- stem: praktijkstem', '- stem: elevenlabs:' + ROOS));
    const gh2 = (await rt.app('GET /app/bandjes', {}, ctx)).j.praktijken.find((x) => x.id === 'groenhouten').bandjes[0];
    toets('13 (voorwaarde) bandje heeft de eigen stem Roos', gh2 && gh2.stem === 'elevenlabs:' + ROOS, gh2 && gh2.stem);
    vers = true; const p16 = R.posts.length;
    m = await rt.app('POST /app/bandjes/maak', { praktijk: 'groenhouten', bandje: gh2.id, versie: gh2.versie, tekst_hash: gh2.tekst_hash, stem: 'praktijkstem', beurt_id: nieuweBeurt() }, ctx);
    toets('13 expliciet "praktijkstem" gaat vóór de bewaarde ElevenLabs-stem: geen ElevenLabs-aanroep (Fable #1)', m.status !== 200 && R.posts.length === p16 && /stem/.test(m.j.fout || ''), m);
    vers = true;
    m = await rt.app('POST /app/bandjes/maak', { praktijk: 'groenhouten', bandje: gh2.id, versie: gh2.versie, tekst_hash: gh2.tekst_hash, beurt_id: nieuweBeurt() }, ctx);
    toets('13 zonder stem in de invoer: de bewaarde stem van het bandje (Roos)', m.status === 200, m);
    if (m.status === 200) await wachtKlaar(m.j.taak.id);
  }
  toets('13 geen onverwachte fouten', fouts.length === 0, fouts);

  S.stopTimers();
  router.close();
  try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  crash ' + (e && e.stack)); process.exit(1); });
JS
