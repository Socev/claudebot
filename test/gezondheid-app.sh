#!/usr/bin/env bash
# Toetst gezondheid-app.js en de koppeling appGezondheid in server.js (wv937, App Gezondheid; ontwerp + Fable-review mk-scripts/wv937).
# Tegen een nagebootste health-pod en knie-app op 127.0.0.1 met eigen proefsleutels; raakt de echte health-pod, de knie-app en de
# sleutelbestanden niet. Toetst: veld voor veld (geen onbekende velden door), vaste GET-paden, leessleutel + doorgeefgeheim alleen naar
# de toegestane host, geen redirect volgen, foutbody nooit door, pod weg = 503, één blok weg = 200 + fouten, tijdgrens, bodylimiet,
# rapportencache, en in server.js: vaste plek, cache 60 s, terugval hooguit 30 min, half antwoord niet bewaren.
# Gebruik: bash test/gezondheid-app.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), vm = require('vm');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'gezapp-'));
const SL = path.join(W, 'sleutels.env'), KS = path.join(W, 'knie.env');
fs.writeFileSync(SL, 'HEALTH_LEZENSLEUTEL=lees-proef-123\nHEALTH_DOORGEEFGEHEIM=door-proef-456\nHEALTH_SCHRIJFSLEUTEL=schrijf-NOOIT\n');
fs.writeFileSync(KS, 'KNIE_APP_ACCESS_CLIENT_ID=knie-id-proef\nKNIE_APP_ACCESS_CLIENT_SECRET=knie-geheim-proef\n');
const G = require('./gezondheid-app.js');
const T = G._t;

// ── nep-gegevens: met extra velden die nooit door mogen ──
const meting = (w, t, bron, ctx) => ({ id: 1, waarde: w, tijdstip: t, precisie: 'dag', context: ctx || 'x', bron: bron, persoon_id: 1, geheim_veld: 'LEK-M' });
const OVERZ = { aantal: 3, soorten: [
  { soort: 'stappen', eenheid: 'stappen', aantal: 9, eerste: '2026-01-01', laatste: meting(4000, '2026-10-22', 'Google'), bronnen: ['Google'], reeks: { per: 'week', punten: Array.from({ length: 200 }, (_, i) => ({ t: '2026-' + String(i).padStart(3, '0'), w: i, extra: 'LEK-R' })) }, recent: [], intern: 'LEK-S' },
  { soort: 'gewicht', eenheid: 'kg', aantal: 3, eerste: '2025-01-01', laatste: meting(86, '2026-08-28', 'Rechterknie', 'vragenlijst'), recent: [meting(86, '2026-08-28', 'Rechterknie'), meting(87.1, '2026-07-05T06:33:37Z', 'Google', 'Google · Withings')] },
  { soort: 'zittijd', eenheid: 'uur', aantal: 2, laatste: meting(8, '2026-10-22', 'Google') },
  { soort: '../kwaad', eenheid: 'x', laatste: meting(1, '2026-10-22', 'Google') },
] };
const rij = (o) => Object.assign({ id: 3, persoon_id: 1, bron_id: 2, bron_citaat: 'citaat uit de vault', run_id: 'import-vault-2026-10-03', vastgelegd_door: 'socev-schrijven', vastgelegd_op: '2026-10-11T17:00:00Z', import_sleutel: 'vault:abc' }, o);
const GEB = { aantal: 2, rijen: [rij({ soort: 'operatie', datum: '2026-10-20', omschrijving: 'knieoperatie', status: 'uitgevoerd' }), rij({ soort: 'fysiotherapie', datum: '2026-11-05', omschrijving: 'eerste fysio', status: 'gepland' })] };
const DIAG = { aantal: 1, rijen: [rij({ omschrijving: 'meniscusscheur', status: 'behandeld', zijde: 'rechts' })] };
const MED = { aantal: 1, rijen: [rij({ middel: 'geen', status: 'geen medicatie' })] };
const bew = (id, extra) => Object.assign({ id: id, tekst: 'tekst ' + id, uitleg: 'uitleg', ingetrokken: false, bronnen: ['F1'], details: ['PGS000333 percentiel 85,0'], rijen: ['pgs_uitkomst:1015'], intern: 'LEK-B' }, extra);
const ond = (n, controle) => ({ soort: 'onderdeel', onderdeel: n, naam: 'Naam ' + n, tekst: { id: 7, titel: 'Titel ' + n, controle: controle || 'geslaagd', schrijver: 'claude:opus', controleur: 'claude:fable', vastgelegd_op: '2026-10-23T05:00:00Z', actueel: true, beweringen: [bew('B1'), bew('B2', { ingetrokken: true })], prompt: 'LEK-P' }, poging: { log: 'LEK-L' } });
const RAP = { onderdelen: ['algemeen', 'farmacogenetica', 'kanker', 'hartvaten', 'stofwisseling', 'genetica_overig', 'genoom'].map((n) => ond(n, n === 'hartvaten' ? 'afgekeurd' : 'geslaagd')),
  totaal: ond('totaal'), advies: { soort: 'advies', onderdeel: 'advies', naam: 'Adviesrapport', tekst: { id: 86, titel: 'Advies', controle: 'geslaagd', actueel: true, adviezen: [{ id: 'A1', advies: 'bespreek X', soort: 'bespreken', redenering: 'r', onderbouwing: ['hartvaten.B1'], details: ['d'], intern: 'LEK-A' }] } } };
const DNA = (cat) => ({ aantal: 1, rijen: [rij({ categorie: cat, gen: cat === 'bloedgroep' ? 'ABO' : 'AMPD1', genotype: 'A', fenotype: 'type A', classificatie: null, klinisch_bevestigd: 0, kanttekening: 'onbevestigd', per_genoom: { x: 'LEK-G' } })], kanttekening: 'Onderzoeksgegevens, geen klinische test.' });
const KNIE = { nu: { datum: '2026-10-23' }, tekst: 'Dag 3 na de operatie.', vandaag: { datum: '2026-10-23', dag_na_ok: 3, fase_id: 'bedrust-w1-2', gepland: 15, gedaan: 7, overgeslagen: 0, compex_gepland: 2, compex_gedaan: 2, compex: [{ id: 'LEK-C' }], notities: ['LEK-N'] },
  pijn_gemiddeld_7d: 5, heelslides: [{ datum: '2026-10-22', tijd: '10:00', graden: 25 }, { datum: '2026-10-23', tijd: '14:00', graden: 30 }],
  medicatie: { vandaag: [{ middel: 'ibuprofen' }], per_middel: [{ middel: 'pcm', naam: 'Paracetamol', dosis_mg: 1000, vandaag_aantal: 1, vandaag_mg: 1000, laatste_24u_aantal: 1, laatste: { datum: '2026-10-23', tijd: '08:00' } }] },
  komende_mijlpalen: [{ datum: '2026-10-27', titel: 'Wondjes', ongeveer: 1 }, { datum: 'a' }, { datum: 'b' }, { datum: 'c' }], herinneringen: { apparaten: 1, vandaag: [{ slot: 'LEK-H' }] } };

// ── nep-server ──
const log = [];
let gedrag = {};   // pad -> 'weg' | 'fout' | 'redirect' | 'html' | 'traag' | 'groot'
const ANTW = { '/metingen/overzicht': OVERZ, '/gebeurtenissen': GEB, '/diagnoses': DIAG, '/medicatie': MED, '/rapporten': RAP,
  '/dna-basis?categorie=bloedgroep': DNA('bloedgroep'), '/dna-basis?categorie=dragerschap': DNA('dragerschap'), '/api/samenvatting': KNIE };
const srv = http.createServer(function (req, res) {
  const p = req.url.replace(/^\/api(?=\/(?!samenvatting))/, '');
  log.push({ pad: p, methode: req.method, auth: req.headers.authorization, door: req.headers['x-health-doorgeef'], cfid: req.headers['cf-access-client-id'], cfgeheim: req.headers['cf-access-client-secret'] });
  const g = gedrag[p];
  if (g === 'weg') { res.writeHead(503); return res.end('GEHEIM-BODY-503'); }
  if (g === 'fout') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"fout":"GEHEIM-DIAGNOSE in de foutbody"}'); }
  if (g === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:' + srv.address().port + '/gestolen' }); return res.end(); }
  if (g === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>Access login</html>'); }
  if (g === 'traag') return setTimeout(function () { try { res.writeHead(200); res.end('{}'); } catch (e) {} }, 4000);
  if (g === 'druppel') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('['); const t = setInterval(function () { try { res.write(' '); } catch (e) { clearInterval(t); } }, 300); setTimeout(function () { clearInterval(t); try { res.end(']'); } catch (e) {} }, 6000); return; }
  if (g === 'groot') { res.writeHead(200); return res.end('"' + 'x'.repeat(2.2 * 1024 * 1024) + '"'); }
  const a = ANTW[p];
  if (!a) { res.writeHead(404); return res.end('{}'); }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(a));
});
(async function () {
  await new Promise((k) => srv.listen(0, '127.0.0.1', k));
  const poort = srv.address().port;
  const env = { HEALTH_POD_URL: 'http://127.0.0.1:' + poort + '/api', HEALTH_POD_SLEUTELS: SL, KNIE_APP_URL: 'http://127.0.0.1:' + poort, KNIE_APP_SLEUTELS: KS, GEZONDHEID_MS: '1500' };
  const flog = [];
  let klok = 1e12;
  const maak = (e) => G.maak({ env: Object.assign({}, env, e || {}), fout: (w, x) => flog.push(w + ': ' + x.message), nu: () => klok });

  // ── adres ──
  const std = '/opt/data/bin/socev-health-lezen.env';
  toets('adres: health-host https met de echte sleutels', T.adresToegestaan('https://health.primumnonnocere.olares.com/api', std, std, ['health.primumnonnocere.olares.com']));
  toets('adres: andere host weigert', !T.adresToegestaan('https://kwaad.example/api', std, std, ['health.primumnonnocere.olares.com']));
  toets('adres: gebruikersnaam/poort weigert', !T.adresToegestaan('https://x@health.primumnonnocere.olares.com/api', std, std, ['health.primumnonnocere.olares.com']) &&
    !T.adresToegestaan('https://health.primumnonnocere.olares.com:8443/api', std, std, ['health.primumnonnocere.olares.com']));
  toets('adres: http 127.0.0.1 met de echte sleutels weigert', !T.adresToegestaan('http://127.0.0.1:1/api', std, std, ['health.primumnonnocere.olares.com']));
  toets('adres: http 127.0.0.1 met eigen proefsleutels mag', T.adresToegestaan('http://127.0.0.1:1/api', SL, std, ['health.primumnonnocere.olares.com']));
  toets('adres: http naar een andere host met eigen sleutels weigert', !T.adresToegestaan('http://10.0.0.1/api', SL, std, ['health.primumnonnocere.olares.com']));
  {
    const m = G.maak({ env: { HEALTH_POD_URL: 'https://kwaad.example/api', KNIE_APP_URL: 'https://kwaad.example' } });
    log.length = 0;
    const r = await m.overzicht();
    toets('kwaad adres via env: niets verstuurd, 503', r.status === 503 && log.length === 0, r);
  }

  // ── overzicht ──
  log.length = 0;
  const m = maak();
  let r = await m.overzicht();
  const s = JSON.stringify(r);
  toets('overzicht 200 zonder fouten', r.status === 200 && r.j.ok === true && r.j.fouten.length === 0, r.j && r.j.fouten);
  toets('alleen vaste GET-paden gevraagd', log.every((x) => x.methode === 'GET') && JSON.stringify(log.map((x) => x.pad).sort()) === JSON.stringify(['/api/samenvatting', '/diagnoses', '/gebeurtenissen', '/medicatie', '/metingen/overzicht', '/rapporten']), log.map((x) => x.pad));
  toets('health-pod: leessleutel + doorgeefgeheim, nooit de schrijfsleutel', log.filter((x) => x.pad !== '/api/samenvatting').every((x) => x.auth === 'Bearer lees-proef-123' && x.door === 'door-proef-456') && s.indexOf('schrijf-NOOIT') < 0 && JSON.stringify(log).indexOf('schrijf-NOOIT') < 0);
  toets('knie-app: alleen het servicetoken, geen health-sleutel', log.filter((x) => x.pad === '/api/samenvatting').every((x) => x.cfid === 'knie-id-proef' && x.cfgeheim === 'knie-geheim-proef' && !x.auth && !x.door));
  toets('health-pod krijgt geen knie-token', log.filter((x) => x.pad !== '/api/samenvatting').every((x) => !x.cfid && !x.cfgeheim));
  toets('geen onbekend veld lekt (LEK-*)', !/LEK-/.test(s), (s.match(/LEK-[A-Z]/g) || []));
  toets('geen sleutelwaarde in het antwoord', !/lees-proef|door-proef|knie-geheim|knie-id/.test(s));
  const ms = r.j.metingen;
  toets('metingen: gewicht, stappen eerst (kern), daarna de rest op naam', ms[0].soort === 'gewicht' && ms[1].soort === 'stappen' && ms[0].kern && !ms[2].kern && ms[2].soort === 'zittijd', ms.map((x) => x.soort));
  toets('metingen: soort met rare tekens valt weg', !ms.some((x) => /kwaad/.test(x.soort)));
  toets('metingen: handopgave → ook de jongste apparaatmeting', ms[0].laatste.waarde === 86 && ms[0].laatste_apparaat && ms[0].laatste_apparaat.waarde === 87.1 && ms[0].laatste_apparaat.bron === 'Google', ms[0]);
  toets('metingen: apparaat als laatste → geen laatste_apparaat', ms[1].laatste_apparaat === null);
  toets('metingen: reeks hooguit 150 punten, alleen t en w (laatste)', ms[1].reeks.punten.length === 150 && ms[1].reeks.punten[149].w === 199 && Object.keys(ms[1].reeks.punten[0]).join() === 't,w');
  toets('metingen: NL-naam', ms[0].naam === 'Gewicht' && ms[2].naam === 'Zittijd');
  const geb = r.j.lopend.gebeurtenissen;
  toets('gebeurtenissen: gepland eerst', geb[0].status === 'gepland' && geb[1].status === 'uitgevoerd');
  toets('herkomst: run_id, bron_id, citaat; geen import_sleutel/persoon_id/vastgelegd_door', geb[0].herkomst.run_id === 'import-vault-2026-10-03' && geb[0].herkomst.bron_id === 2 &&
    s.indexOf('import_sleutel') < 0 && s.indexOf('persoon_id') < 0 && s.indexOf('vastgelegd_door') < 0);
  toets('diagnoses en medicatie gevuld', r.j.lopend.diagnoses[0].omschrijving === 'meniscusscheur' && r.j.lopend.medicatie[0].middel === 'geen');
  const k = r.j.knie;
  toets('knie: dag, fase, rondes, laatste heelslide, medicatie per middel, ≤ 3 mijlpalen, geen samenvattingszin (middelnamen)', k.dag_na_ok === 3 && k.fase === 'bedrust-w1-2' && k.gedaan === 7 && k.heelslide.graden === 30 &&
    k.medicatie[0].naam === 'Paracetamol' && k.medicatie[0].vandaag_mg === 1000 && k.mijlpalen.length === 3 && !('zin' in k), k);
  toets('knie: geen dosis_mg per inname, geen herinneringen of notities', !('dosis_mg' in k.medicatie[0]) && !('herinneringen' in k) && s.indexOf('"notities"') < 0);
  toets('totaal en advies (adviezen alleen bij advies)', r.j.totaal.beweringen.length === 1 && !('adviezen' in r.j.totaal) && r.j.advies.adviezen[0].advies === 'bespreek X');
  toets('links vast', r.j.links.pod === 'https://health.primumnonnocere.olares.com/' && r.j.links.knie === 'https://knie.socev.dev/');

  // ── genoom ──
  log.length = 0;
  r = await m.genoom();
  const g = r.j;
  toets('genoom 200, rapporten uit de cache (geen tweede /rapporten)', r.status === 200 && log.every((x) => x.pad !== '/rapporten') && log.length === 2, log.map((x) => x.pad));
  toets('genoom: zes onderdelen in vaste volgorde, zonder algemeen', g.onderdelen.map((x) => x.onderdeel).join() === 'farmacogenetica,kanker,hartvaten,stofwisseling,genetica_overig,genoom');
  const hv = g.onderdelen.find((x) => x.onderdeel === 'hartvaten'), kk = g.onderdelen.find((x) => x.onderdeel === 'kanker');
  toets('genoom: niet geslaagd → alleen titel en status, geen beweringen', hv.controle === 'afgekeurd' && hv.beweringen.length === 0 && hv.titel === 'Titel hartvaten');
  toets('genoom: ingetrokken bewering weg; details (pgs_id) en rijen (herkomst) blijven', kk.beweringen.length === 1 && kk.beweringen[0].details[0].indexOf('PGS000333') >= 0 && kk.beweringen[0].rijen[0] === 'pgs_uitkomst:1015');
  toets('genoom: bloedgroep en dragerschap met herkomst, zonder per_genoom', g.bloedgroep[0].gen === 'ABO' && g.dragerschap[0].gen === 'AMPD1' && g.dragerschap[0].herkomst.run_id && JSON.stringify(g).indexOf('LEK-') < 0);
  toets('genoom: kanttekeningen', /geen klinische test/.test(g.kanttekening) && /DPWG\/CPIC/.test(g.kanttekening_farmacogenetica));

  // ── fouten ──
  flog.length = 0;
  gedrag = { '/diagnoses': 'fout', '/medicatie': 'redirect', '/api/samenvatting': 'html' };
  log.length = 0;
  r = await maak().overzicht();
  const sf = JSON.stringify(r);
  const fb = (b) => (r.j.fouten.find((f) => f.blok === b) || {}).soort;
  toets('één blok weg → 200 met fouten per blok', r.status === 200 && fb('diagnoses') === 'fout 500' && fb('medicatie') === 'weigert' && fb('knie') === 'geen json' && r.j.lopend.diagnoses === null && r.j.metingen.length === 4 - 1, r.j.fouten);
  toets('foutbody van de pod nooit door', sf.indexOf('GEHEIM') < 0);
  toets('redirect niet gevolgd', !log.some((x) => x.pad === '/gestolen'));
  toets('verwachte fouten niet in de foutlog', flog.length === 0, flog);
  gedrag = { '/metingen/overzicht': 'weg', '/gebeurtenissen': 'weg', '/diagnoses': 'weg', '/medicatie': 'weg', '/rapporten': 'weg' };
  r = await maak().overzicht();
  toets('health-pod helemaal weg → 503 met nette zin (knie doet niet mee)', r.status === 503 && r.j.pod_weg === true && /niet bereikbaar/.test(r.j.fout) && JSON.stringify(r).indexOf('GEHEIM') < 0, r);
  gedrag['/dna-basis?categorie=bloedgroep'] = 'weg'; gedrag['/dna-basis?categorie=dragerschap'] = 'weg';
  r = await maak().genoom();
  toets('genoom: pod weg → 503', r.status === 503 && r.j.pod_weg === true, r);
  gedrag = { '/metingen/overzicht': 'traag' };
  const t0 = Date.now();
  r = await maak().overzicht();
  toets('tijdgrens per aanroep (1,5 s in de toets)', r.status === 200 && fb('metingen') === 'tijdgrens' && Date.now() - t0 < 3500, { ms: Date.now() - t0, f: r.j.fouten });
  gedrag = { '/diagnoses': 'druppel' };
  const t1 = Date.now();
  r = await maak().overzicht();
  toets('totaalgrens: een druppelend antwoord stopt na de grens (Fable diff #2)', fb('diagnoses') === 'tijdgrens' && Date.now() - t1 < 3500, { ms: Date.now() - t1, f: r.j.fouten });
  gedrag = { '/gebeurtenissen': 'groot' };
  r = await maak().overzicht();
  toets('bodylimiet 2 MB', fb('gebeurtenissen') === 'te groot', r.j.fouten);
  gedrag = {};
  r = await maak({ HEALTH_POD_SLEUTELS: path.join(W, 'bestaat-niet.env') }).overzicht();
  toets('sleutelbestand weg → 503 zonder pad of melding van het OS', r.status === 503 && JSON.stringify(r).indexOf('bestaat-niet') < 0, r);
  { const m3 = maak(); log.length = 0; await Promise.all([m3.overzicht(), m3.genoom()]);
    toets('Overzicht en Genoom tegelijk: /rapporten één keer (Fable diff #12)', log.filter((x) => x.pad === '/rapporten').length === 1, log.map((x) => x.pad)); }
  // rapportencache 30 min
  const m2 = maak(); log.length = 0;
  await m2.overzicht(); klok += 29 * 60000; await m2.genoom(); const n1 = log.filter((x) => x.pad === '/rapporten').length;
  klok += 2 * 60000; await m2.genoom(); const n2 = log.filter((x) => x.pad === '/rapporten').length;
  toets('rapporten 30 min in het geheugen, daarna opnieuw', n1 === 1 && n2 === 2, { n1, n2 });
  toets('health(): tellers zonder inhoud', (function () { const h = m2.health(); return h.aan === true && h.gelezen === 3 && JSON.stringify(h).length < 300; })(), m2.health());

  // ── server.js: appGezondheid ──
  const src = fs.readFileSync('server.js', 'utf8');
  toets('route in de routetabel', /route === 'GET \/app\/gezondheid' \|\| route === 'GET \/app\/gezondheid\/genoom'\) return typeof appGezondheid === 'function'/.test(src));
  toets('/health noemt gezondheid', /gezondheid: typeof gezondheidInfo === 'function' \? gezondheidInfo\(\) : \{ aan: false \},/.test(src));
  toets('uitrol.sh: gezondheid-app.js optioneel in de release', /RELEASE_OPTIONEEL="[^"]*\bgezondheid-app\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')));
  toets('Dockerfile: gezondheid-app.js in release-bootstrap', /COPY gezondheid-app\.js \/app\/release-bootstrap\/gezondheid-app\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
  const a0 = src.indexOf('let appGezMod;'), b0 = src.indexOf('// ── wv787: POT-afschriften', a0);
  // wv1051 bracht appPriveDicht + APP_PRIVE_MODULES buiten dit blok; de echte regels meenemen (CI 274/275 rood op ReferenceError)
  const prive = (src.match(/^const APP_PRIVE_MODULES = [^\n]*/m) || [''])[0] + '\n' + (src.match(/^const APP_VAST_AFSCHERMEN = [^\n]*/m) || [''])[0] + '\n' +
    (src.match(/^function appAfscherm\(a\) \{[\s\S]*?\n\}/m) || [''])[0] + '\n' + (src.match(/^function appPriveDicht\([^\n]*/m) || [''])[0] + '\n';   // wv1901
  const blok = prive + src.slice(a0, b0) + '\nthis.appGezondheid = appGezondheid; this.gezondheidInfo = gezondheidInfo;';
  let antw = [];
  let nep = { aanroepen: 0, volgende: null };
  const ctx = { require: function (p) { if (/gezondheid-app\.js$/.test(p)) return { maak: function () { return {
    overzicht: async function () { nep.aanroepen++; return nep.volgende; }, genoom: async function () { nep.aanroepen++; return nep.volgende; }, health: function () { return { aan: true }; } }; } }; return require(p); },
    path: path, fs: { existsSync: function () { return true; } }, __dirname: __dirname, process: { env: {} }, logError: function () {}, Date: Date, Object: Object, Error: Error, JSON: JSON,
    appStuur: function (res, st, o) { antw.push({ st: st, o: o }); }, appWeiger: function (res, st, f, reden) { res._app.reden = reden; antw.push({ st: st, o: { ok: false, fout: f } }); } };
  vm.createContext(ctx); vm.runInContext(blok, ctx);
  const res = () => ({ _app: {} });
  let rs = res();
  // wv1901 (David 28-10: "op ALLE pc's toegang tot ALLES"): ook op een vaste plek de gegevens
  nep.volgende = { status: 200, j: { ok: true, metingen: [7], fouten: [] } };
  await ctx.appGezondheid({}, rs, { soort: 'vast' }, 'GET /app/gezondheid');
  toets('wv1901: vaste plek → 200 met de gegevens (zoals meereizend), vaste_plek false', antw[0].st === 200 && antw[0].o.vaste_plek === false && antw[0].o.metingen[0] === 7 && nep.aanroepen === 1 && rs._app.reden === 'gezondheid', antw[0]);
  vm.runInContext('Object.keys(appGezCache).forEach(function (k) { delete appGezCache[k]; });', ctx); nep.aanroepen = 0;
  antw = []; nep.volgende = { status: 200, j: { ok: true, metingen: [1], fouten: [] } };
  await ctx.appGezondheid({}, res(), { soort: 'mee' }, 'GET /app/gezondheid');
  await ctx.appGezondheid({}, res(), { soort: 'mee' }, 'GET /app/gezondheid');
  toets('60 s in het geheugen: tweede keer zonder aanroep', nep.aanroepen === 1 && antw[1].st === 200 && antw[1].o.metingen[0] === 1 && antw[1].o.vaste_plek === false && antw[1].o.bijgewerkt);
  await ctx.appGezondheid({}, res(), { soort: 'mee' }, 'GET /app/gezondheid/genoom');
  toets('cache per route (genoom apart)', nep.aanroepen === 2);
  // terugval: klok vooruit, pod weg
  const echtNu = Date.now; Date.now = () => echtNu() + 5 * 60000;
  antw = []; nep.volgende = { status: 503, j: { ok: false, fout: 'weg', pod_weg: true } };
  await ctx.appGezondheid({}, res(), { soort: 'mee' }, 'GET /app/gezondheid');
  toets('pod weg na < 30 min: oude cijfers met oud:true', antw[0].st === 200 && antw[0].o.oud === true && antw[0].o.metingen[0] === 1, antw[0]);
  Date.now = () => echtNu() + 31 * 60000;
  antw = []; rs = res();
  await ctx.appGezondheid({}, rs, { soort: 'mee' }, 'GET /app/gezondheid');
  toets('pod weg na > 30 min: 503 doorgeven', antw[0].st === 503 && antw[0].o.pod_weg === true && /weg$/.test(rs._app.reden), antw[0]);
  antw = []; rs = res(); nep.volgende = { status: 200, j: { ok: true, metingen: [2], fouten: [{ blok: 'knie', soort: 'weg' }] } };
  await ctx.appGezondheid({}, rs, { soort: 'mee' }, 'GET /app/gezondheid');
  const n = nep.aanroepen;
  await ctx.appGezondheid({}, res(), { soort: 'mee' }, 'GET /app/gezondheid');
  toets('half antwoord niet bewaren, auditreden noemt het blok', antw[0].st === 200 && nep.aanroepen === n + 1 && /half \(knie\)/.test(rs._app.reden), rs._app.reden);
  // terugval blijft na een half antwoord (Fable diff #3): volle stand, dan half, dan pod weg → de volle stand met oud
  Date.now = () => echtNu() + 40 * 60000;
  nep.volgende = { status: 200, j: { ok: true, metingen: [3], fouten: [] } };
  await ctx.appGezondheid({}, res(), { soort: 'mee' }, 'GET /app/gezondheid');
  Date.now = () => echtNu() + 42 * 60000;
  nep.volgende = { status: 200, j: { ok: true, metingen: [4], fouten: [{ blok: 'knie', soort: 'geen json' }] } };
  await ctx.appGezondheid({}, res(), { soort: 'mee' }, 'GET /app/gezondheid');
  nep.volgende = { status: 503, j: { ok: false, fout: 'weg', pod_weg: true } };
  antw = [];
  await ctx.appGezondheid({}, res(), { soort: 'mee' }, 'GET /app/gezondheid');
  toets('half antwoord wist de terugval niet', antw[0].st === 200 && antw[0].o.oud === true && antw[0].o.metingen[0] === 3, antw[0]);
  // module niet in de release → 404
  vm.runInContext('appGezMod = null;', ctx); antw = [];
  await ctx.appGezondheid({}, res(), { soort: 'mee' }, 'GET /app/gezondheid');
  toets('gezondheid-app.js ontbreekt → 404 met nette zin', antw[0].st === 404 && /niet in deze versie/.test(antw[0].o.fout), antw[0]);
  Date.now = echtNu;
  srv.close();
  console.log((fouten ? 'ROOD' : 'GROEN') + ': ' + goed + ' goed, ' + fouten + ' fout');
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  uitzondering ' + (e && e.stack)); process.exit(1); });
JS
