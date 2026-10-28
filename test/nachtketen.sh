#!/usr/bin/env bash
# Toetst nachtketen.js (wv1868, SB2 fase 3d: de nachtorkestrator) met een nepklok in een wegwerpmap: volgorde en start_na, elke stap één
# keer per datum, herhaling na een fout, onderhoudsstand midden in de keten (pauze, daarna verder, nooit twee keer), uitrol-pauze,
# herstart (bezig van een ander proces: dood = herhalen, levende wees = wachten, tweede keer = fout:onderbroken), in-process time-out,
# voorwaarde + vangnet (onvolledig), einde 07:40, wintertijd (uur dubbel) en zomertijd (uur weg), hartslag en box-rij; n8nKlaar met een
# nep-API; een ECHTE herstart (node-proces met SIGKILL weg terwijl zijn kind doorleeft); de R6-staat op schijf van maakDagRonde/maakVeeg en
# de keten-ingang van sb2-nacht.js; tot slot de koppeling in server.js en uitrol.sh.
# Gebruik: bash test/nachtketen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), { spawn, execFileSync } = require('child_process');
const K = require('./nachtketen.js');
const N = require('./sb2-nacht.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nachtketen-'));
const wacht = (ms) => new Promise(r => setTimeout(r, ms));

// nepklok: ams() en nu() uit één tijd; T0 = 28-10 00:00 (Nederlandse tijd in de toets = gewoon de getallen)
let klok = { datum: '2026-10-29', uur: 0, min: 0 }, ms = Date.parse('2026-10-29T00:00:00Z');
function zet(uur, min, datum) { const oud = klok.uur * 60 + klok.min; klok = { datum: datum || klok.datum, uur: uur, min: min }; ms += Math.max(0, (uur * 60 + min - oud)) * 60000 + 1000; }
function vooruit(min) { ms += min * 60000; }
function maakKeten(map, stappen, extra) {
  const uit = { log: [], hart: [], box: [] };
  const k = K.maak(Object.assign({ staatMap: map, stappen: stappen, nu: () => ms, ams: () => Object.assign({ klok: klok.datum + ' ' + klok.uur + ':' + klok.min }, klok),
    log: (r) => uit.log.push(r), fout: () => {}, hartslag: async (s) => { uit.hart.push(s); }, boxRij: (s) => uit.box.push(s), procLeeft: () => false, procStart: () => '1', boot: 'b' }, extra || {}));
  return Object.assign(uit, { k: k });
}
const teller = {};
function stap(naam, extra) { teller[naam] = 0; return Object.assign({ naam: naam, pogingen: 2, doe: async () => { teller[naam]++; return { ok: true }; } }, extra || {}); }
async function tikTot(k, n) { let r; for (let i = 0; i < (n || 1); i++) { r = await k.tik(); await wacht(5); } return r; }
const stand = (k, n) => { const s = k._lees(klok.datum); return s && s.stappen[n] ? s.stappen[n].stand : null; };

(async function () {
  // 1. volgorde, start_na, één keer per datum, afsluiten met hartslag
  let map = path.join(d, 'k1');
  let x = maakKeten(map, [stap('a', { start_na: [1, 0] }), stap('b', { na: ['a'] }), stap('c', { start_na: [2, 30], na: ['b'] })]);
  zet(0, 30); toets('vóór 01:00: niets en geen staatbestand', (await tikTot(x.k)) === null && !fs.existsSync(path.join(map, klok.datum + '.json')));
  zet(1, 0); let r = await tikTot(x.k);
  toets('01:00: a start', r && r.gestart === 'a' && teller.a === 1, r);
  r = await tikTot(x.k); toets('daarna b (na a)', r && r.gestart === 'b', r);
  r = await tikTot(x.k); toets('c wacht op 02:30', r === null && teller.c === 0, r);
  zet(2, 30); r = await tikTot(x.k); toets('02:30: c start', r && r.gestart === 'c', r);
  r = await tikTot(x.k); toets('alle stappen klaar: afgesloten', r && r.afgesloten === true && x.hart.length === 1 && x.hart[0].klaar === 3 && x.box.length === 0, [r, x.hart]);
  await tikTot(x.k, 3); toets('na afsluiten niets meer (elke stap één keer)', teller.a === 1 && teller.b === 1 && teller.c === 1 && x.hart.length === 1);
  // wintertijd: het uur 02:00–02:59 komt terug
  klok.uur = 2; klok.min = 5; await tikTot(x.k, 2);
  toets('wintertijd: klok terug naar 02:05 draait niets dubbel', teller.a === 1 && teller.c === 1 && x.hart.length === 1);
  const sf = fs.statSync(path.join(map, '2026-10-29.json'));
  toets('staatbestand 0600 in map 0700', (sf.mode & 0o777) === 0o600 && (fs.statSync(map).mode & 0o777) === 0o700);

  // 2. zomertijd: 01:59 → 03:00, stap zonder start_na (na a) draait toch
  klok = { datum: '2026-03-28', uur: 1, min: 59 }; map = path.join(d, 'k2');
  x = maakKeten(map, [stap('a', { start_na: [1, 0] }), stap('b', { na: ['a'] })]);
  await tikTot(x.k); klok.uur = 3; klok.min = 0; vooruit(1); await tikTot(x.k); await tikTot(x.k);
  toets('zomertijd: a en b draaien (geen stap hangt aan 02:xx)', teller.a === 1 && teller.b === 1 && x.hart.length === 1, x.log);

  // 3. mislukt → na 10 min opnieuw → fout; meldtZelf = geen box-rij; uitzondering = wel (meld)
  klok = { datum: '2026-10-30', uur: 1, min: 0 }; map = path.join(d, 'k3');
  let pog = 0;
  x = maakKeten(map, [stap('a', { start_na: [1, 0], meldtZelf: true, doe: async () => { pog++; return { ok: false, reden: 'exit 1' }; } }),
    stap('b', { start_na: [1, 0], doe: async () => { throw new Error('kapot'); } }), stap('c', { start_na: [1, 0] })]);
  await tikTot(x.k); toets('mislukt: opnieuw met opnieuw_na', stand(x.k, 'a') === 'opnieuw' && pog === 1, x.k._lees(klok.datum));
  await tikTot(x.k); await tikTot(x.k);
  toets('de keten gaat door met de volgende stappen', teller.c === 1 && stand(x.k, 'b') === 'opnieuw', x.k._lees(klok.datum));
  await tikTot(x.k); toets('binnen 10 min geen herhaling', pog === 1);
  vooruit(10); await tikTot(x.k, 3);
  toets('na 10 min tweede poging, daarna fout', pog === 2 && stand(x.k, 'a') === 'fout' && stand(x.k, 'b') === 'fout', x.k._lees(klok.datum));
  toets('fout: geen hartslag; box alleen voor de uitzondering', x.hart.length === 0 && x.box.length === 1 && x.box[0].meld.length === 1 && x.box[0].meld[0].naam === 'b', x.box);

  // 4. onderhoudsstand midden in de keten: pauze, daarna verder bij dezelfde stap, nooit twee keer
  klok = { datum: '2026-10-31', uur: 1, min: 0 }; map = path.join(d, 'k4');
  let ohd = false;
  x = maakKeten(map, [stap('a', { start_na: [1, 0] }), stap('b', { na: ['a'] }), stap('c', { na: ['b'] })], { onderhoud: () => ohd });
  await tikTot(x.k); ohd = true;
  r = await tikTot(x.k, 4);
  toets('onderhoud aan na a: pauze, b start niet', r && r.pauze === 'onderhoud' && teller.b === 0 && !!x.k._lees(klok.datum).pauze_sinds, r);
  ohd = false; await tikTot(x.k, 3);
  const s4 = x.k._lees(klok.datum);
  toets('onderhoud uit: verder met b en c, a niet opnieuw', teller.a === 1 && teller.b === 1 && teller.c === 1 && s4.pauzes && s4.pauzes.length === 1 && !s4.pauze_sinds, s4);
  // onderhoud tot het einde
  klok = { datum: '2026-11-01', uur: 1, min: 0 }; map = path.join(d, 'k5');
  x = maakKeten(map, [stap('a', { start_na: [1, 0] }), stap('b', { na: ['a'] })], { onderhoud: () => ohd });
  await tikTot(x.k); ohd = true; zet(7, 40); r = await tikTot(x.k);
  const s5 = x.k._lees(klok.datum);
  toets('onderhoud tot 07:40: rest overgeslagen:onderhoud en afgesloten', r && r.afgesloten && s5.stappen.b.stand === 'overgeslagen' && s5.stappen.b.reden === 'onderhoud' && teller.b === 0, s5);
  ohd = false;
  // einde zonder staat van vandaag
  klok = { datum: '2026-11-02', uur: 8, min: 0 }; map = path.join(d, 'k6');
  x = maakKeten(map, [stap('a', { start_na: [1, 0] })]);
  toets('pod pas na 07:40 op zonder staat: niets, geen bestand, geen melding', (await tikTot(x.k)) === null && !fs.existsSync(map) && !x.hart.length && !x.box.length);
  // uitrol wacht
  klok = { datum: '2026-11-03', uur: 1, min: 0 }; map = path.join(d, 'k7');
  let uitrol = true;
  x = maakKeten(map, [stap('a', { start_na: [1, 0] })], { magStarten: () => !uitrol });
  r = await tikTot(x.k); toets('uitrol wacht: geen nieuwe stap', r && r.pauze === 'uitrol' && teller.a === 0, r);
  uitrol = false; await tikTot(x.k); toets('uitrol klaar: stap start', teller.a === 1);

  // 5. herstart: bezig van een ander proces
  klok = { datum: '2026-11-04', uur: 1, min: 0 }; map = path.join(d, 'k8');
  fs.mkdirSync(map, { recursive: true, mode: 0o700 });
  const nep = (st) => fs.writeFileSync(path.join(map, klok.datum + '.json'), JSON.stringify({ datum: klok.datum, stappen: st }));
  nep({ a: { stand: 'bezig', poging: 1, eigenaar: 'ander', pid: 999999, pid_start: '5', boot: 'b', start: new Date(ms).toISOString(), token: 'x' } });
  let levend = true;
  x = maakKeten(map, [stap('a', { start_na: [1, 0] }), stap('b', { na: ['a'] })], { procLeeft: () => levend });
  r = await tikTot(x.k); toets('levende wees: wachten, niet herhalen', r && /^wees/.test(r.wacht) && teller.a === 0, r);
  levend = false; r = await tikTot(x.k); await tikTot(x.k);
  toets('wees weg: één herhaling (poging 2), daarna verder', teller.a === 1 && x.k._lees(klok.datum).stappen.a.poging === 2 && stand(x.k, 'a') === 'klaar' && teller.b === 1, x.k._lees(klok.datum));
  map = path.join(d, 'k9'); fs.mkdirSync(map, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(map, klok.datum + '.json'), JSON.stringify({ datum: klok.datum, stappen: { a: { stand: 'bezig', poging: 2, eigenaar: 'ander', start: new Date(ms).toISOString() } } }));
  x = maakKeten(map, [stap('a', { start_na: [1, 0] })]);
  await tikTot(x.k, 2);
  toets('tweede herstart in dezelfde stap: fout:onderbroken + box-rij', stand(x.k, 'a') === 'fout' && x.k._lees(klok.datum).stappen.a.reden === 'onderbroken' && x.box.length === 1 && teller.a === 0, [x.k._lees(klok.datum), x.box]);

  // 6. in-process time-out
  klok = { datum: '2026-11-05', uur: 2, min: 30 }; map = path.join(d, 'k10');
  let los; let biblio = 0;
  x = maakKeten(map, [stap('bib', { start_na: [2, 30], inProces: true, limiet_min: 15, pogingen: 2, doe: () => { biblio++; return new Promise(r => { los = r; }); } }), stap('z', { na: ['bib'] })]);
  await tikTot(x.k); vooruit(5); r = await tikTot(x.k);
  toets('in-process stap binnen zijn limiet: keten wacht', r && r.bezig === 'bib' && teller.z === 0, r);
  vooruit(11); await tikTot(x.k); await tikTot(x.k);
  toets('na de limiet: fout:tijd, geen tweede poging, keten gaat door', stand(x.k, 'bib') === 'fout' && x.k._lees(klok.datum).stappen.bib.reden === 'tijd' && biblio === 1 && teller.z === 1, x.k._lees(klok.datum));
  los({ ok: true }); await wacht(10); await tikTot(x.k);
  toets('late uitkomst schrijft niets in de staat; afsluiten met één box-rij (tijd)', stand(x.k, 'bib') === 'fout' && x.box.length === 1 && x.box[0].meld[0].reden === 'tijd', x.box);

  // 7. voorwaarde + vangnet onvolledig
  klok = { datum: '2026-11-06', uur: 5, min: 0 }; map = path.join(d, 'k11');
  let klaarN8n = false;
  const vw = async (c) => klaarN8n ? { ga: true } : (c.ams.uur * 60 + c.ams.min >= 400 ? { ga: true, onvolledig: 'vangnet 6:40' } : { wacht: 'raw_input nog niet' });
  x = maakKeten(map, [stap('f', { start_na: [5, 0], voorwaarde: vw }), stap('i', { na: ['f'] })]);
  await tikTot(x.k); toets('voorwaarde wacht: stap niet gestart', teller.f === 0 && /^wacht/.test(x.k._lees(klok.datum).stappen.f.reden), x.k._lees(klok.datum));
  vooruit(1); await tikTot(x.k); toets('binnen de wachttijd geen nieuwe vraag', teller.f === 0);
  zet(6, 40); await tikTot(x.k); await tikTot(x.k); await tikTot(x.k);
  toets('vangnet 06:40: toch, onvolledig, daarna afgesloten met hartslag (bevinding) en één box-rij', teller.f === 1 && teller.i === 1 && x.k._lees(klok.datum).stappen.f.onvolledig && x.hart.length === 1 && x.box.length === 1 && !!x.box[0].onvolledig, [x.k._lees(klok.datum), x.hart, x.box]);
  klok = { datum: '2026-11-07', uur: 5, min: 0 }; map = path.join(d, 'k12');
  x = maakKeten(map, [stap('f', { start_na: [5, 0], voorwaarde: vw })]);
  await tikTot(x.k); klaarN8n = true; vooruit(4); await tikTot(x.k); await tikTot(x.k);
  toets('n8n klaar vóór het vangnet: stap draait, niet onvolledig, geen box', teller.f === 1 && !x.k._lees(klok.datum).stappen.f.onvolledig && x.box.length === 0 && x.hart.length === 1, x.k._lees(klok.datum));
  // stap die "wacht" teruggeeft (loopt al) telt niet als poging
  klok = { datum: '2026-11-08', uur: 1, min: 0 }; map = path.join(d, 'k13');
  let w = 2;
  x = maakKeten(map, [stap('a', { start_na: [1, 0], pogingen: 1, doe: async () => (w-- > 0 ? { wacht: 'loopt al' } : { ok: true }) })]);
  await tikTot(x.k); vooruit(4); await tikTot(x.k); vooruit(4); await tikTot(x.k);
  toets('wacht-uitkomst telt niet als poging', stand(x.k, 'a') === 'klaar', x.k._lees(klok.datum));
  // opruimen: 14 bewaard
  map = path.join(d, 'k14'); fs.mkdirSync(map, { mode: 0o700 });
  for (let i = 1; i <= 20; i++) fs.writeFileSync(path.join(map, '2026-09-' + String(i).padStart(2, '0') + '.json'), '{"datum":"x","stappen":{}}');
  klok = { datum: '2026-11-09', uur: 1, min: 0 };
  x = maakKeten(map, [stap('a', { start_na: [1, 0] })]); await tikTot(x.k, 2);
  toets('opruimen: de 14 nieuwste staatbestanden blijven', fs.readdirSync(map).filter(n => /\.json$/.test(n)).length === 14 && fs.existsSync(path.join(map, '2026-11-09.json')));
  let fout1 = null; try { K.maak({ staatMap: map, stappen: [stap('a', { na: ['b'] }), stap('b')], ams: () => klok }); } catch (e) { fout1 = e.message; }
  toets('stap die op een latere of onbekende stap wacht: geweigerd', /wacht op onbekende/.test(fout1 || ''), fout1);

  // 8. n8nKlaar met een nep-API
  const a = { datum: '2026-10-29', uur: 5, min: 50 };
  const amsVan = (iso) => { const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(iso); return m ? { datum: m[1], uur: +m[2], min: +m[3] } : null; };   // nep: ISO = NL-tijd
  function api(runs, actief, lopend) {
    return async (p) => {
      if (/^\/workflows\//.test(p)) return { active: actief !== false };
      if (/status=running/.test(p)) return { data: lopend || [] };
      return { data: runs };
    };
  }
  const W = [{ id: 'w1', naam: 'raw_input', vanaf: [5, 0] }];
  const af = (start, extra) => Object.assign({ status: 'success', mode: 'trigger', startedAt: start, stoppedAt: start }, extra || {});
  let k8 = await K.n8nKlaar(W, api([af('2026-10-29T05:00:31')]), a, amsVan, () => false);
  toets('n8nKlaar: run van vandaag na 05:00 afgerond = klaar', k8.klaar === true, k8);
  k8 = await K.n8nKlaar(W, api([af('2026-10-28T05:00:31')]), a, amsVan, () => false);
  toets('n8nKlaar: alleen een run van gisteren = niet klaar', k8.klaar === false, k8);
  k8 = await K.n8nKlaar(W, api([af('2026-10-29T04:59:00')]), a, amsVan, () => false);
  toets('n8nKlaar: run vóór het uur = niet klaar', k8.klaar === false, k8);
  k8 = await K.n8nKlaar(W, api([af('2026-10-29T05:00:31', { mode: 'manual' })]), a, amsVan, () => false);
  toets('n8nKlaar: proefrun (manual) telt niet', k8.klaar === false, k8);
  k8 = await K.n8nKlaar(W, api([af('2026-10-29T05:00:31', { status: 'error' })]), a, amsVan, () => false);
  toets('n8nKlaar: mislukte run is ook afgerond', k8.klaar === true, k8);
  k8 = await K.n8nKlaar(W, api([af('2026-10-29T05:00:31')], true, [{ status: 'running' }]), a, amsVan, () => false);
  toets('n8nKlaar: een lopende run = niet klaar', k8.klaar === false && /loopt/.test(k8.reden), k8);
  k8 = await K.n8nKlaar(W, api([{ status: 'running', startedAt: '2026-10-29T05:00:31' }]), a, amsVan, () => false);
  toets('n8nKlaar: run zonder stoppedAt = niet klaar', k8.klaar === false, k8);
  k8 = await K.n8nKlaar(W, api([], false), a, amsVan, () => false);
  toets('n8nKlaar: inactieve workflow telt als klaar, met notitie', k8.klaar === true && /inactief/.test(k8.notitie), k8);
  k8 = await K.n8nKlaar(W, api([af('2026-10-29T05:00:31')]), a, amsVan, () => true);
  toets('n8nKlaar: lopende pod-beurt in de nachtrij = niet klaar', k8.klaar === false && /pod-beurt/.test(k8.reden), k8);
  k8 = await K.n8nKlaar(W, async () => { throw new Error('n8n http 401'); }, a, amsVan, () => false);
  toets('n8nKlaar: n8n niet te lezen = wachten (geen klaar)', k8.klaar === false && /niet te lezen/.test(k8.reden), k8);

  // 9. ECHTE herstart: een node-proces draait de keten met een echte kindstap (sleep), wordt met SIGKILL gedood terwijl het kind doorleeft
  const echt = path.join(d, 'echt'); fs.mkdirSync(echt, { mode: 0o700 });
  const prog = path.join(d, 'keten-proces.js');
  fs.writeFileSync(prog, `
const K = require(${JSON.stringify(path.resolve('nachtketen.js'))}), { spawn } = require('child_process');
const slaap = process.argv[2];
const k = K.maak({ staatMap: ${JSON.stringify(echt)}, ams: () => ({ datum: '2026-11-10', uur: 2, min: 0 }), herhaalNaMs: 0,
  stappen: [{ naam: 'kind', pogingen: 2, start_na: [1, 0], doe: (ctx) => new Promise((res) => {
    const c = spawn('sleep', [slaap], { stdio: 'ignore' }); ctx.opSpawn(c.pid);
    c.on('exit', (code) => res({ ok: code === 0 })); }) }, { naam: 'na', na: ['kind'], doe: async () => ({ ok: true }) }] });
(async () => { for (let i = 0; i < 40; i++) { await k.tik(); await new Promise(r => setTimeout(r, 100)); } })();
`);
  const p1 = spawn(process.execPath, [prog, '30'], { stdio: 'ignore' });
  let st1 = null;
  for (let i = 0; i < 50 && !(st1 && st1.stappen.kind && st1.stappen.kind.pid); i++) { await wacht(100); try { st1 = JSON.parse(fs.readFileSync(path.join(echt, '2026-11-10.json'), 'utf8')); } catch (e) {} }
  const kindPid = st1 && st1.stappen.kind && st1.stappen.kind.pid;
  toets('echt: stempel bezig met pid + starttijd van het kind', !!kindPid && !!st1.stappen.kind.pid_start && st1.stappen.kind.stand === 'bezig', st1);
  process.kill(p1.pid, 'SIGKILL'); await wacht(300);
  toets('echt: na SIGKILL van de keten leeft het kind door (wees)', K.procLeeft(kindPid, st1.stappen.kind.pid_start, st1.stappen.kind.boot));
  const p2 = spawn(process.execPath, [prog, '0'], { stdio: 'ignore' });
  await wacht(1200);
  let st2 = JSON.parse(fs.readFileSync(path.join(echt, '2026-11-10.json'), 'utf8'));
  toets('echt: nieuwe keten wacht op de levende wees (geen tweede kind)', st2.stappen.kind.stand === 'bezig' && st2.stappen.kind.pid === kindPid && !st2.stappen.na, st2);
  process.kill(kindPid, 'SIGKILL');
  for (let i = 0; i < 40; i++) { await wacht(100); st2 = JSON.parse(fs.readFileSync(path.join(echt, '2026-11-10.json'), 'utf8')); if (st2.afgesloten) break; }
  toets('echt: wees weg → één herhaling (poging 2) en de keten loopt af', st2.stappen.kind.stand === 'klaar' && st2.stappen.kind.poging === 2 && st2.stappen.na.stand === 'klaar' && !!st2.afgesloten, st2);
  try { process.kill(p2.pid, 'SIGKILL'); } catch (e) {}

  // 10. R6: dagronde en veeg onthouden hun datum op schijf; doe() zonder venster
  const nr = path.join(d, 'socev-run'); const nrLog = path.join(d, 'run.log');
  fs.writeFileSync(nr, '#!/usr/bin/env bash\necho "$*" >> ' + nrLog + '\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n', { mode: 0o755 });
  const sb = path.join(d, 'klokken', 'x.json');
  const mk = () => N.maakDagRonde({ naam: 'xx', venster: { van: [3, 30], tot: [4, 0] }, socevRun: nr, argv: ['true'], staatBestand: sb, pogingen: 2 });
  let dr = mk();
  let u = await dr.tik({ ams: { datum: '2026-10-29', uur: 3, min: 30 } });
  toets('dagronde: ronde in het venster', u && u.exit === 0);
  dr = mk();   // "herstart"
  toets('dagronde R6: na een herstart geen tweede ronde (datum op schijf)', (await dr.tik({ ams: { datum: '2026-10-29', uur: 3, min: 35 } })) === null && (fs.statSync(sb).mode & 0o777) === 0o600);
  u = await dr.doe({ ams: { datum: '2026-10-29', uur: 5, min: 0 } });
  toets('dagronde doe: al gedaan vandaag', u && u.al_gedaan === true, u);
  let pids = [];
  u = await dr.doe({ ams: { datum: '2026-10-30', uur: 5, min: 0 }, opSpawn: (p) => pids.push(p) });
  toets('dagronde doe: buiten het venster, met opSpawn', u && u.exit === 0 && pids.length === 1, [u, pids]);
  toets('dagronde: oude tik daarna stil (zelfde stempel, vlag-uit-richting)', (await mk().tik({ ams: { datum: '2026-10-30', uur: 3, min: 40 } })) === null);
  const vb = path.join(d, 'klokken', 'veeg.json');
  fs.writeFileSync(path.join(d, 'veeg-run'), '#!/usr/bin/env bash\nif [ "$1" = "--veeg" ]; then echo \'{"opgeveegd": 0}\'; exit 0; fi\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n', { mode: 0o755 });
  let vg = N.maakVeeg({ socevRun: path.join(d, 'veeg-run'), staatBestand: vb });
  u = await vg.tik({ ams: { datum: '2026-10-29', uur: 3, min: 50 } });
  toets('veeg: ronde in het venster', u && u.exit === 0, u);
  vg = N.maakVeeg({ socevRun: path.join(d, 'veeg-run'), staatBestand: vb });
  toets('veeg R6: na een herstart geen tweede ronde', (await vg.tik({ ams: { datum: '2026-10-29', uur: 4, min: 0 } })) === null);
  toets('veeg doe: al gedaan', ((await vg.doe({ ams: { datum: '2026-10-29', uur: 5, min: 0 } })) || {}).al_gedaan === true);
  // halve ronde (herstart midden in): datum op schijf maar geen uitkomst van vandaag → doe draait opnieuw
  fs.writeFileSync(vb, JSON.stringify({ datum: '2026-10-31', laatste: { datum: '2026-10-30', exit: 0 } }));
  vg = N.maakVeeg({ socevRun: path.join(d, 'veeg-run'), staatBestand: vb });
  u = await vg.doe({ ams: { datum: '2026-10-31', uur: 5, min: 0 } });
  toets('veeg doe na een onderbroken ronde: draait opnieuw', u && u.exit === 0 && !u.al_gedaan, u);

  // 11. sb2-nacht keten-ingang (MOET 4)
  const s2 = path.join(d, 'sb2'); fs.mkdirSync(path.join(s2, 'src'), { recursive: true }); fs.mkdirSync(path.join(s2, 'mf'));
  fs.writeFileSync(path.join(s2, 'src', 'linter.py'), 'import json\nprint(json.dumps({"pagina\'s": 1}))\n');
  fs.writeFileSync(path.join(s2, 'src', 'manifest.py'), 'import json,sys\na=sys.argv[1:]\nif a[0]=="maak":\n    open(a[a.index("--uit")+1],"w").write("x")\n    print(json.dumps({"bestanden": 5}))\nelse:\n    print("verschillen: 0 (verwacht 0, onverwacht 0)")\n');
  const sn = N.maak({ staatMap: path.join(s2, 'staat'), manifestMap: path.join(s2, 'mf'), socevRun: nr, sb2Src: path.join(s2, 'src'), vault: d });
  toets('sb2-nacht: zonder keten buiten het venster niets', (await sn.tik({ ams: { datum: '2026-10-29', uur: 4, min: 0 } })) === null);
  pids = [];
  u = await sn.tik({ ams: { datum: '2026-10-29', uur: 4, min: 0 }, keten: true, ovisNacht: true, opSpawn: (p) => pids.push(p) });
  toets('sb2-nacht keten: buiten het venster, OVIS-toets genegeerd, opSpawn per kind', u && u.ok === true && pids.length >= 2, [u, pids]);
  u = await sn.tik({ ams: { datum: '2026-10-29', uur: 4, min: 5 }, keten: true });
  toets('sb2-nacht keten: geslaagd vandaag = al_gedaan', u && u.al_gedaan === true && u.ok === true, u);
  const sp = path.join(s2, 'staat', 'staat.json');
  const sj = JSON.parse(fs.readFileSync(sp, 'utf8')); sj.datum = '2026-10-30'; sj.bezig = new Date().toISOString(); fs.writeFileSync(sp, JSON.stringify(sj));
  toets('sb2-nacht oud: datum gezet (ook met bezig) = geen ronde', (await sn.tik({ ams: { datum: '2026-10-30', uur: 2, min: 5 } })) === null);
  u = await sn.tik({ ams: { datum: '2026-10-30', uur: 4, min: 0 }, keten: true });
  toets('sb2-nacht keten: bezig van een onderbroken ronde = opnieuw (niet al_gedaan)', u && !u.al_gedaan && u.ok === true, u);
  u = await sn.tik({ ams: { datum: '2026-10-31', uur: 4, min: 0 }, keten: true, onderhoud: true });
  toets('sb2-nacht keten: onderhoud = overgeslagen (de keten wacht)', u && u.overgeslagen === 'onderhoud', u);

  // 12. koppeling in server.js en uitrol.sh
  const sv = fs.readFileSync('server.js', 'utf8'), ur = fs.readFileSync('uitrol.sh', 'utf8');
  toets('server.js: oude klokken zwijgen met de vlag (6 tikken + secondbrain + ovisTik)', (sv.match(/if \(nachtketenActief\(\)\) return;   \/\/ wv1868/g) || []).length === 6 && /!nachtketenActief\(\)\) secondbrain\.nacht\(/.test(sv) && /const keten = nachtketenActief\(\);/.test(sv));
  toets('server.js: vlag NACHTKETEN=uit wint, aan.json standaard uit', /process\.env\.NACHTKETEN === 'uit'\) return false/.test(sv) && /j\.aan === true/.test(sv));
  toets('server.js: keten tikt elke minuut, alleen echt + primair + vlag', /if \(!nachtketen \|\| !SERVER_ECHT \|\| !rolPrimair\(\) \|\| !nachtketenAan\(\)\) return;/.test(sv) && /nachtketenTik\(\); \}, 60000\)/.test(sv));
  toets('server.js: geen nieuwe stap tijdens een wachtende uitrol', /magStarten: function \(\) \{ return !uitrolWacht\(\)\.wacht; \}/.test(sv));
  toets('server.js: /health.nachtketen', /nachtketen: typeof nachtketenInfo === 'function' \? nachtketenInfo\(\)/.test(sv));
  toets('server.js: R6-staatbestand voor veeg en de vijf dagrondes', (sv.match(/staatBestand: path\.join\(KLOKKEN_DIR/g) || []).length === 5);
  toets('server.js: OVIS-nacht in de keten met --buiten-venster', /buitenVenster: true, opSpawn: ctx\.opSpawn/.test(sv) && /opt\.buitenVenster \? \['--buiten-venster'\]/.test(sv));
  toets('server.js: zoeken wacht op raw_input, Teams en WhatsApp-consolidatie, vangnet 06:40 onvolledig', /\[NACHT_N8N\.rawInput, NACHT_N8N\.teams, NACHT_N8N\.whatsapp\], \[6, 40\], true\)/.test(sv));
  toets('uitrol.sh: wachtsom telt nachtketen.lopend', /int\(k\.get\("lopend",0\)\)/.test(ur) && /k=j\.get\("nachtketen"\)/.test(ur));
  toets('uitrol.sh: nachtketen.js in RELEASE_OPTIONEEL', /RELEASE_OPTIONEEL="[^"]*\bnachtketen\.js\b/.test(ur));

  // 13. het echte keten-blok uit server.js in een vm met nep-objecten: één hele nacht, elke stap roept het juiste object met de juiste vorm
  {
    const vm = require('vm');
    const begin = sv.indexOf('const NACHT_N8N = {'), eind = sv.indexOf('if (nachtketen && SERVER_ECHT) {');
    toets('vm: keten-blok gevonden in server.js', begin > 0 && eind > begin);
    const code = sv.slice(begin, eind) + '\n;({ nachtketen, nachtketenInfo, nachtketenTik, nachtrijPodBezig, nachtAmsVan });';
    const roep = [];
    let tijd = { datum: '2026-11-11', uur: 0, min: 50 };
    const dag = (naam) => ({ doe: async (c) => { roep.push(naam + ':' + c.ams.datum + ':' + (typeof c.opSpawn)); return { datum: c.ams.datum, exit: 0, ms: 5 }; } });
    const ns = { ovisNacht: null };
    const ctx = vm.createContext({
      require: require, __dirname: process.cwd(), path: path, fs: fs, console: console, Date: Date, Promise: Promise, Object: Object, String: String, Number: Number, JSON: JSON, Intl: Intl, isNaN: isNaN, setTimeout: setTimeout,
      NACHTKETEN_DIR: path.join(d, 'vm-keten'), SERVER_ECHT: true, rolPrimair: () => true, nachtketenAan: () => true,
      logError: (w, e) => roep.push('FOUT ' + w + ' ' + (e && e.message)), schrijfLog: () => {}, nu: () => 'nu',
      ovisAms: () => Object.assign({ klok: tijd.datum + ' ' + String(tijd.uur).padStart(2, '0') + ':' + String(tijd.min).padStart(2, '0') }, tijd),
      ovisStaatLees: () => ({}), ovisLoopt: { nu: null, sinds: 0 }, OVIS_NACHT_MAX_MS: 1200000, ovis: {},
      ovisNachtRonde: async (t, opt) => { roep.push('ovis-nacht:' + t.datum + ':' + opt.buitenVenster + ':' + typeof opt.opSpawn); return { ok: true, nacht: { paginas: 3, blokken: 2, fouten: 0 } }; },
      ovisBiblioRonde: async (t, s) => { roep.push('biblio:' + t.datum + ':' + typeof s); return { ok: true, open: 1, nieuw: 0 }; },
      sb2Nacht: { tik: async (c) => { roep.push('sb2:' + c.ams.datum + ':' + c.keten + ':' + typeof c.onderhoud + ':' + typeof c.opSpawn); return { datum: c.ams.datum, ok: true, linter: { exit: 0 }, manifest: { exit: 0 }, verschil: { totaal: 1 } }; } },
      onderhoud: { stand: () => ({ aan: false }) }, uitrolWacht: () => ({ wacht: false }),
      ovisAgenda: dag('agenda'), ovisDeadlines: dag('deadlines'), scriptsVeeg: dag('veeg'), sb2Feitenlijst: dag('feitenlijst'), sb2Zoekindex: dag('zoekindex'), sb2Zoekleer: dag('zoekleer'), ovisKalender: dag('kalender'),
      secondbrain: { nacht: (x) => { roep.push('kaart:' + x); return true; } },
      appSbRpc: async (fn, body) => { roep.push('rpc:' + fn + ':' + body.p_component + ':' + body.p_gemeten_rijen + ':' + body.p_bevindingen); return []; },
      ovisBoxRij: (tekst) => { roep.push('box'); return true; },
      appN8n: async (p) => { roep.push('n8n:' + p.split('?')[0]); if (/^\/workflows\//.test(p)) return { active: true }; if (/status=running/.test(p)) return { data: [] };
        return { data: [{ status: 'success', mode: 'trigger', startedAt: '2026-11-11T05:59:00Z', stoppedAt: '2026-11-11T06:00:00Z' }] }; },   // 06:59 NL (wintertijd)
      jobs: {}, appWeesVast: {}
    });
    const K2 = vm.runInContext(code, ctx);
    toets('vm: keten geladen met 11 stappen', !!K2.nachtketen && K2.nachtketenInfo().aan === true);
    const tikk = async () => { await K2.nachtketenTik(); await wacht(15); };
    const zetT = async (u, m, n) => { tijd = { datum: '2026-11-11', uur: u, min: m }; for (let i = 0; i < (n || 4); i++) await tikk(); };
    await zetT(0, 50); toets('vm: vóór 01:00 niets', roep.length === 0, roep);
    await zetT(1, 0, 3); await zetT(2, 30, 3);
    toets('vm: ovis-nacht (buiten-venster, opSpawn) → linter/manifest (keten) → Bibliothecaris', roep.join('|') === 'ovis-nacht:2026-11-11:true:function|sb2:2026-11-11:true:function:function|biblio:2026-11-11:object', roep);
    roep.length = 0; await zetT(3, 30, 2); await zetT(3, 45, 3);
    toets('vm: deadlines wacht op de n8n-run van de nachtconsolidatie (vandaag ≥ 03:00)', roep.indexOf('agenda:2026-11-11:function') === 0 && roep.some(x => x === 'n8n:/workflows/lKcF3Oxt8WVeELPJ') && roep.indexOf('deadlines:2026-11-11:function') > 0, roep);
    roep.length = 0; await zetT(3, 50, 3);
    toets('vm: secondbrain-kaart met de oude datumvorm, daarna veeg', roep.join('|') === 'kaart:2026-11-11|veeg:2026-11-11:function', roep);
    roep.length = 0; await zetT(5, 0, 6);
    toets('vm: zoeken wacht op raw_input/Teams/WhatsApp (via de API) en loopt dan feitenlijst → zoekindex → zoekleer', ['vNsdkyTQIaGhU0Fj', 'vmFrhWxNc7KrpdIL', 'agntIie8d9mqOlm6'].every(id => roep.indexOf('n8n:/workflows/' + id) >= 0) &&
      roep.filter(x => !/^n8n:/.test(x)).join('|') === 'feitenlijst:2026-11-11:function|zoekindex:2026-11-11:function|zoekleer:2026-11-11:function', roep);
    roep.length = 0; await zetT(6, 35, 3);
    toets('vm: kalender 06:35, daarna afgesloten met één hartslag sb2_nachtketen (11 klaar, 0 bevindingen), geen box', roep.join('|') === 'kalender:2026-11-11:function|rpc:mk_hartslag_stempel:sb2_nachtketen:11:0', roep);
    const inf = K2.nachtketenInfo();
    toets('vm: /health-info zonder inhoud: stand per stap, lopend 0, afgesloten', inf.lopend === 0 && !!inf.afgesloten && Object.keys(inf.stappen).length === 11 && Object.values(inf.stappen).every(x => x === 'klaar'), inf);
    toets('vm: nachtAmsVan zet UTC om naar Nederlandse tijd (winter +1)', JSON.stringify(K2.nachtAmsVan('2026-11-11T04:00:31Z')) === '{"datum":"2026-11-11","uur":5,"min":0}');
    ctx.jobs.x = { status: 'running', chat_id: '40687' };
    toets('vm: lopende /run-beurt in 40687 = nachtrij bezig', K2.nachtrijPodBezig() === true);
    ctx.jobs.x = { status: 'running', chat_id: '40687', agent: true };
    toets('vm: een agent telt niet als nachtrij', K2.nachtrijPodBezig() === false);
  }

  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  fs.rmSync(d, { recursive: true, force: true });
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
