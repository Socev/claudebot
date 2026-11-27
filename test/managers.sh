#!/usr/bin/env bash
# Toetst managers.js (wv895, App Managers + ronde op afroep; ontwerp + Fable-review mk-scripts/wv895/ontwerp.md) en de koppeling in
# server.js. Toetst: naam-whitelist, aanroeper en reden (vaste lijst, nooit in de prompt), loopt al (ook een n8n-job op de sessie),
# 90 min vóór de weekronde, uurgrens over elke job op de sessie, 3 per manager en 6 totaal per 24 u, uitrol wacht, passieve kant,
# quotum (vangnet), Socev alleen met Davids verse Ja op een vraag die de manager noemt (oud, Nee, andere manager, dubbel gebruik),
# geen twee starts tegelijk, rapport (goed: ≤ 3 regels + telling, sleutelachtige regel weg; fout: afwijkend slot), soort antwoord/
# archief, herstart midden in een ronde, volgende weekronde rond de zomertijdgrens, de stand (hartslag op tijd/te laat, vaste plek
# zonder detail en CISO zonder lijst), en in server.js: dispatch, glijdroute, SMAL_GRENS, bron manager, reset-race, opgehaald.
# Raakt niets buiten een wegwerpmap. Gebruik: bash test/managers.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const M = require('./managers.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const ms = (s) => Date.parse(s);

function omgeving(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-'));
  const st = { nu: opts.nu || ms('2026-10-21T10:00:00Z'), jobs: [], runs: [], berichten: [], primair: true, uitrol: false, vangnet: { mag: true, reden: 'ok' }, knop: null, fouten: [] };
  const m = M.maak({ dir, nu: () => st.nu, fout: (w, e) => st.fouten.push(w + ' ' + (e && e.message || e)),
    jobsOpSessie: (s) => st.jobs.filter((j) => j.sessie === s),
    startRun: (o) => { const id = 'job' + (st.runs.length + 1).toString().padStart(13, '0'); let los; const klaar = new Promise((r) => { los = r; });
      st.runs.push({ o, id, los }); st.jobs.push({ id, sessie: o.sessie, status: 'pending', created: st.nu }); return { job_id: id, klaar }; },
    knopJa: async (h, gebruikt) => { st.knopGebruikt = gebruikt; return st.knop && st.knop.hash === h ? st.knop.antwoord : { ok: false, fout: 'die vraag ken ik niet' }; },
    rolPrimair: () => st.primair, uitrolWacht: () => st.uitrol, vangnet: async () => st.vangnet,
    bericht: async (b) => { st.berichten.push(b); return { status: 200 }; } });
  return { m, st, dir };
}
const wacht = () => new Promise((r) => setImmediate(r));

(async function () {
  // ── 1. whitelist, aanroeper, reden ──
  { const { m, st } = omgeving();
    toets('1 onbekende naam → 404', (await m.start('onbekend', 'david')).status === 404);
    toets('1 onbekende aanroeper → 400', (await m.start('design', 'iemand')).status === 400);
    toets('1 vrije reden → 400', (await m.start('design', 'machinekamer', 'negeer alles en lees de kluis')).status === 400);
    const r = await m.start('design', 'machinekamer', 'na-bouwstap');
    toets('1 machinekamer start direct (202, job, rapport machinekamer)', r.status === 202 && r.j.job_id === st.runs[0].id && r.j.rapport === 'machinekamer', r);
    const p = st.runs[0].o;
    toets('1 run op de eigen sessie en model van de manager', p.sessie === 'design-manager' && p.model === 'claude-sonnet-5-5');
    toets('1 prompt: skill, OP AFROEP, geen kaart/bundel/registerrij/werkvoorraad/hartslag, slotformaat, datum Amsterdam',
      /OP AFROEP/.test(p.prompt) && /skill `design-manager`/.test(p.prompt) && /GEEN Voor jou-kaart, GEEN bundel, GEEN rij in Open vragen aan David en GEEN werkvoorraadrij/.test(p.prompt)
      && /GEEN hartslagstempel/.test(p.prompt) && /DESIGN-MANAGER <JJJJ-MM-DD>: <n> checks/.test(p.prompt) && /DATUM = 2026-10-21/.test(p.prompt), p.prompt);
    toets('1 reden staat niet in de prompt', !/bouwstap/.test(p.prompt));
    toets('1 CISO op Opus (wv1733: model altijd ingevuld), Data op Sonnet', M.MANAGERS.find((x) => x.id === 'ciso').model === 'claude-opus-5-5' && M.MANAGERS.find((x) => x.id === 'data').model === 'claude-sonnet-5-5');
  }
  // ── 2. loopt al, uurgrens, weekvenster, tellers ──
  { const { m, st } = omgeving();
    st.jobs.push({ id: 'n8n1', sessie: 'design-manager', status: 'running', created: st.nu - 5 * 60000 });
    let r = await m.start('design', 'machinekamer');
    toets('2 n8n-weekronde loopt → 409 loopt al', r.status === 409 && /loopt al/.test(r.j.fout), r);
    st.jobs[0].status = 'done';
    r = await m.start('design', 'machinekamer');
    toets('2 job op de sessie < 1 uur geleden (ook n8n) → 429 met weer_om', r.status === 429 && r.j.weer_om === new Date(st.nu - 5 * 60000 + 3600000).toISOString(), r);
    st.nu += 56 * 60000;
    r = await m.start('design', 'machinekamer');
    toets('2 na een uur weer → 202', r.status === 202, r);
    st.jobs.forEach((j) => { j.status = 'done'; });
    st.nu += 30 * 60000;
    r = await m.start('design', 'machinekamer');
    toets('2 eigen afroep < 1 uur → 429', r.status === 429, r);
    st.nu += 31 * 60000; st.jobs.forEach((j) => { j.status = 'done'; });
    r = await m.start('design', 'machinekamer'); st.jobs.forEach((j) => { j.status = 'done'; }); st.nu += 61 * 60000;
    const r3 = await m.start('design', 'machinekamer'); st.jobs.forEach((j) => { j.status = 'done'; }); st.nu += 61 * 60000;
    const r4 = await m.start('design', 'machinekamer');
    toets('2 vierde afroep binnen 24 u → 429 (3 per manager)', r.status === 202 && r3.status === 202 && r4.status === 429 && /3 keer/.test(r4.j.fout), [r, r3, r4]);
    // totaal 6 over alle managers
    const t2 = omgeving(); const s2 = t2.st;
    const ids = ['data', 'design', 'ciso', 'data', 'design', 'ciso'];
    let alles = true;
    for (const id of ids) { const x = await t2.m.start(id, 'machinekamer'); if (x.status !== 202) alles = false; s2.jobs.forEach((j) => { j.status = 'done'; }); s2.nu += 61 * 60000; }
    const zevende = await t2.m.start('data', 'machinekamer');
    toets('2 zes rondes over alle managers mogen, de zevende niet (429)', alles && zevende.status === 429 && /alle managers samen/.test(zevende.j.fout), zevende);
  }
  { const { m, st } = omgeving({ nu: ms('2026-10-24T07:00:00Z') });   // za 09:00 Amsterdam (zomertijd), Design-weekronde 10:00
    const r = await m.start('design', 'machinekamer');
    toets('2 binnen 90 min vóór de weekronde → 409 met tijd', r.status === 409 && /10:00/.test(r.j.fout), r);
    const d = await m.start('data', 'machinekamer');
    toets('2 andere manager mag dan wel', d.status === 202, d);
  }
  { const { m, st } = omgeving();
    st.uitrol = true; toets('2 uitrol wacht → 503', (await m.start('ciso', 'machinekamer')).status === 503);
    st.uitrol = false; st.primair = false; toets('2 reservekant → 409', (await m.start('ciso', 'machinekamer')).status === 409);
    st.primair = true; st.vangnet = { mag: false, reden: 'account 1 onder Davids reserve (9% over)' };
    const r = await m.start('ciso', 'machinekamer');
    toets('2 onder Davids reserve → 429, geen run, niets geteld', r.status === 429 && /reserve/.test(r.j.fout) && st.runs.length === 0, r);
  }
  // ── 3. wv4128 (C64): op afroep alleen nog de machinekamer; David (app) en Socev krijgen 403, er start niets ──
  { const { m, st } = omgeving();
    const a = await m.start('design', 'socev', 'david-vroeg', 'abcd1234');
    const b = await m.start('ciso', 'david');
    toets('3 Socev en David → 403 met verwijzing naar de machinekamer, geen run', a.status === 403 && b.status === 403 && /alleen nog via de machinekamer/.test(a.j.fout) && /draai de CISO-ronde/.test(b.j.fout) && st.runs.length === 0, [a, b]);
    toets('3 vraagZin bestaat niet meer', typeof M.vraagZin === 'undefined');
  }
  // ── 3b. wv4128 (3C29): gemiste ronde in gewone taal; (3C136) rapporten uit de box ──
  { const ml = M.MANAGERS.find((x) => x.id === 'mrlean');
    const t = ms('2026-11-25T09:00:21Z');
    const z = M.gemistZin(ml, t, 'poort', t);
    toets('3b gemistZin: dag, reden, volgende ronde, niets doen', z === 'MrLean heeft woensdag niet gedraaid: ' + M.GEMIST_REDEN.poort + '; volgende ronde woensdag 2-12; je hoeft niets te doen.', z);
    const n8n = 'Data Manager heeft zondag niet gedraaid: Socev was op dat moment niet bereikbaar, dus de ronde kon niet beginnen; volgende ronde zondag 6-12; je hoeft niets te doen.\n\n[Bekijk bij de Data Manager](/?app=managers&manager=data)';
    const g = M.gemistUitTekst(n8n);
    toets('3b de zin van n8n wordt herkend (met link erachter)', g && g.id === 'data' && /niet bereikbaar/.test(g.zin) && !/Bekijk/.test(g.zin), g);
    toets('3b een codemelding of vrije tekst wordt niet herkend', !M.gemistUitTekst('MrLean: onverwacht antwoord of fout (manager-poort) - job 775912ffa7b5ec07.') && !M.gemistUitTekst('Iemand heeft maandag niet gedraaid: x; volgende ronde maandag 1-12; je hoeft niets te doen.'));
    const des = M.MANAGERS.find((x) => x.id === 'design');
    toets('3b vorigeWeekronde: Design om de week (anker 28-11)', new Date(M.vorigeWeekronde(des, ms('2026-12-10T12:00:00Z'))).toISOString() === '2026-11-28T09:00:00.000Z');
    // stand: te laat → onthouden zin als hij na de laatst geplande ronde kwam, anders "niet vastgelegd"
    const { m, st } = omgeving({ nu: ms('2026-11-27T12:00:00Z') });
    const sb = { mrlean: { aantal: 0, per_ernst: {}, top: [], hartslag: { laatste_ronde: '2026-11-11T09:00:12Z', drempel_min: 12960 } } };
    let k = m.stand(sb).find((x) => x.id === 'mrlean');
    toets('3b te laat zonder bericht → zin "niet vastgelegd" met woensdag en 2-12', k.hartslag === 'te laat' && /^MrLean heeft woensdag niet gedraaid: de reden is niet vastgelegd.*volgende ronde woensdag 2-12/.test(k.gemist) && k.rapport === true && k.link === '/?app=managers&manager=mrlean' && !('kan' in k), k);
    st.nu = ms('2026-11-25T09:10:00Z');
    toets('3b noteerGemist neemt alleen de vaste zin', m.noteerGemist('MrLean heeft woensdag niet gedraaid: Socev was op dat moment niet bereikbaar, dus de ronde kon niet beginnen; volgende ronde woensdag 2-12; je hoeft niets te doen.') === true && m.noteerGemist('iets anders') === false);
    st.nu = ms('2026-11-27T12:00:00Z');
    k = m.stand(sb).find((x) => x.id === 'mrlean');
    toets('3b te laat na het bericht → de zin uit het bericht', /niet bereikbaar/.test(k.gemist), k.gemist);
    st.nu = ms('2026-12-03T12:00:00Z');
    k = m.stand(sb).find((x) => x.id === 'mrlean');
    toets('3b een week later (nieuwe gemiste ronde) → weer "niet vastgelegd"', /niet vastgelegd/.test(k.gemist) && /woensdag 9-12/.test(k.gemist), k.gemist);
    const box = '## [week] 2026-11-23 06:2x — CISO-ronde 2026-11-23: 7 open #ciso\n- status: bezig\n- van: wachter:ciso (ronde 2026-11-23)\n- wat ik zag: x\n\n## [log] iets anders\n- van: wachter:ciso-dag (2026-11-23)\n\n## [week] 2026-11-20 10:04 — UI Manager 2026-11-20: 1 open\n- van: wachter:ui-manager (ronde 2026-11-20)\n';
    const arch = '## [week] 2026-11-16 06:12 — CISO-ronde 2026-11-16: 5 open\n- van: wachter:ciso (ronde 2026-11-16)\n## [week] 2026-11-23 06:2x — CISO-ronde 2026-11-23: 7 open #ciso\n- van: wachter:ciso (ronde 2026-11-23)\n';
    const rc = M.rapporten([box, arch], M.MANAGERS.find((x) => x.id === 'ciso'), 5);
    toets('3b rapporten CISO: nieuwste eerst, dubbel uit archief één keer, dagcheck niet mee, kop zonder [week] en #tag', rc.length === 2 && rc[0].datum === '2026-11-23' && rc[0].titel === '2026-11-23 06:2x — CISO-ronde 2026-11-23: 7 open' && /wat ik zag/.test(rc[0].tekst) && rc[1].datum === '2026-11-16', rc);
    const twee = M.rapporten(['## [week] 2026-11-23 06:2x — CISO-ronde 2026-11-23: 7 open\n- van: wachter:ciso (ronde 2026-11-23)\n## [week] 2026-11-23 18:4x — CISO-ronde 2026-11-23: 6 open\n- van: wachter:ciso (ronde 2026-11-23)\n'], M.MANAGERS.find((x) => x.id === 'ciso'), 5);
    toets('3b twee rondes op één dag zonder tijd in de van-regel = twee rapporten (review Codex ZOU 1)', twee.length === 2, twee.map((x) => x.titel));
    const rd = M.rapporten([box], des, 5);
    toets('3b rapporten Design nemen het UI-deel mee; Bibliothecaris heeft er geen', rd.length === 1 && rd[0].wie === 'ui-manager' && M.rapporten([box], M.MANAGERS.find((x) => x.id === 'bibliothecaris'), 5).length === 0, rd);
  }
  // ── 4. twee tegelijk ──
  {
    // vangnet dat even wacht: twee starts tegelijk → één 202, één 409
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr2-')); const s = { runs: 0, jobs: [] };
    const mm = M.maak({ dir, nu: () => ms('2026-10-21T10:00:00Z'), fout: () => {}, jobsOpSessie: (x) => s.jobs.filter((j) => j.sessie === x),
      startRun: (o) => { s.runs++; s.jobs.push({ id: 'j' + s.runs, sessie: o.sessie, status: 'pending', created: ms('2026-10-21T10:00:00Z') }); return { job_id: 'j' + s.runs, klaar: new Promise(() => {}) }; },
      knopJa: async () => ({ ok: false }), rolPrimair: () => true, uitrolWacht: () => false, vangnet: () => new Promise((r) => setTimeout(() => r({ mag: true }), 20)), bericht: async () => ({}) });
    const [a, b] = await Promise.all([mm.start('data', 'machinekamer'), mm.start('data', 'machinekamer')]);
    toets('4 twee starts tegelijk → precies één run', s.runs === 1 && [a.status, b.status].sort().join() === '202,409', [a, b]);
    // hercontrole na het wachten: komt er tijdens de quotummeting een weekronde op de sessie, dan geen run
    const s3 = { runs: 0, jobs: [] };
    const m3 = M.maak({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mgr3-')), nu: () => ms('2026-10-21T10:00:00Z'), fout: () => {}, jobsOpSessie: (x) => s3.jobs.filter((j) => j.sessie === x),
      startRun: () => { s3.runs++; return { job_id: 'x', klaar: new Promise(() => {}) }; }, knopJa: async () => ({ ok: false }), rolPrimair: () => true, uitrolWacht: () => false,
      vangnet: () => new Promise((r) => setTimeout(() => { s3.jobs.push({ id: 'n8n', sessie: 'ciso', status: 'running', created: ms('2026-10-21T10:00:00Z') }); r({ mag: true }); }, 10)), bericht: async () => ({}) });
    const c3 = await m3.start('ciso', 'machinekamer');
    toets('4 weekronde start tijdens de quotummeting → 409, geen run', c3.status === 409 && s3.runs === 0, c3);
    // totaal 6 atomair: zes verschillende starts tegelijk na vijf eerdere → hooguit één erbij
    const s4 = { runs: 0, jobs: [] }, d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr4-'));
    const oud4 = Date.parse('2026-10-21T05:00:00Z');
    fs.writeFileSync(path.join(d4, 'staat.json'), JSON.stringify({ afroepen: [0, 1, 2, 3, 4].map((i) => ({ id: ['data', 'design', 'ciso', 'data', 'design'][i], t: oud4 + i * 3700000 - 5 * 3700000, door: 'machinekamer', reden: 'controle', job_id: 'o' + i, uitkomst: 'goed' })) }));
    const m4 = M.maak({ dir: d4, nu: () => ms('2026-10-21T10:00:00Z'), fout: () => {}, jobsOpSessie: (x) => s4.jobs.filter((j) => j.sessie === x),
      startRun: (o) => { s4.runs++; s4.jobs.push({ id: 'n' + s4.runs, sessie: o.sessie, status: 'pending', created: ms('2026-10-21T10:00:00Z') }); return { job_id: 'n' + s4.runs, klaar: new Promise(() => {}) }; },
      knopJa: async () => ({ ok: false }), rolPrimair: () => true, uitrolWacht: () => false, vangnet: () => new Promise((r) => setTimeout(() => r({ mag: true }), 10)), bericht: async () => ({}) });
    const r4 = await Promise.all([m4.start('ciso', 'machinekamer'), m4.start('data', 'machinekamer'), m4.start('design', 'machinekamer')]);
    toets('4 totaal 6 per 24 u ook bij gelijktijdige starts van verschillende managers', s4.runs === 1, r4.map((x) => x.status));
  }
  // ── 5. rapport ──
  { const { m, st } = omgeving();
    await m.start('design', 'machinekamer');
    st.runs[0].los({ ok: true, output: 'Ik begin.\nTwee **nieuwe** losse kleuren in `Financiën`.\n- De nieuwe App Managers heeft nog geen nepgegevens.\nsleutel sk-abcdefghijklmnopqrstuvwxyz123456 gezien\nDESIGN-MANAGER 2026-10-21: 9 checks, 0 niet vast te stellen, 4 open (2 nieuw), kaart geen, wv geen' });
    await wacht(); await wacht();
    const b = st.berichten[0] || {};
    toets('5 goed: kop met wie en tijd, ≤ 3 regels, telling', /^\*\*Design Manager\*\* — ronde op afroep \(door de machinekamer, controle, 12:00\) is klaar\./.test(b.tekst) && /Twee nieuwe losse kleuren in Financiën\./.test(b.tekst)
      && /Telling: 9 checks, 0 niet vast te stellen, 4 open \(2 nieuw\), kaart geen, wv geen\n\n\[Bekijk bij Design Manager\]\(\/\?app=managers&manager=design\)$/.test(b.tekst) && !/Ik begin/.test(b.tekst), b);
    toets('5 opsommingsteken weg, sleutelachtige regel weggelaten', /\nDe nieuwe App Managers/.test(b.tekst) && !/sk-abc/.test(b.tekst) && /leek op een sleutel/.test(b.tekst), b.tekst);
    toets('5 machinekamer → soort archief, sleutel manager:<job> (wv4128: David start niet meer)', b.soort === 'archief' && b.sleutel === 'manager:' + st.runs[0].id, b);
  }
  { const { m, st, dir } = omgeving();
    await m.start('ciso', 'machinekamer', 'na-bouwstap');
    st.runs[0].los({ ok: true, output: 'Klaar.\nCISO 2026-10-21 zonder telling' });
    await wacht(); await wacht();
    const b = st.berichten[0] || {};
    toets('5 afwijkend slot → niet goed afgerond, job-id, archief bij machinekamer', /niet goed afgerond \(onverwacht slot\)/.test(b.tekst) && b.tekst.indexOf(st.runs[0].id) > 0 && b.soort === 'archief'
      && /door de machinekamer, na een bouwstap/.test(b.tekst), b);
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'staat.json'), 'utf8'));
    toets('5 staat: uitkomst fout, bestand 0600', s.afroepen[0].uitkomst === 'fout' && (fs.statSync(path.join(dir, 'staat.json')).mode & 0o777) === 0o600, s);
  }
  { const { m, st } = omgeving();
    await m.start('data', 'machinekamer');
    st.runs[0].los({ ok: false, error: 'claude exit 1', output: '' });
    await wacht(); await wacht();
    toets('5 fout van de run → melding met de fout', /niet goed afgerond \(claude exit 1\)/.test((st.berichten[0] || {}).tekst || ''), st.berichten);
  }
  // ── 6. herstart ──
  { const { m, st, dir } = omgeving();
    await m.start('design', 'machinekamer'); await m.start('data', 'machinekamer');
    st.jobs = [];   // na een herstart zijn de jobs weg
    const m2 = M.maak({ dir, nu: () => st.nu + 10 * 60000, fout: () => {}, jobsOpSessie: () => [], startRun: () => ({}), knopJa: async () => ({}), rolPrimair: () => true,
      uitrolWacht: () => false, vangnet: async () => ({ mag: true }), bericht: async (b) => { st.berichten.push(b); } });
    const n = m2.opstart(); await wacht();
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'staat.json'), 'utf8'));
    toets('6 herstart: beide afgebroken, de machinekamer krijgt geen regel (wv4128: alleen nog machinekamer-afroepen)', n === 2 && s.afroepen.every((a) => a.uitkomst === 'afgebroken') && st.berichten.length === 0, [n, st.berichten]);
    toets('6 tweede opstart doet niets', m2.opstart() === 0);
  }
  // ── 7. volgende weekronde en zomertijd ──
  { const d = M.MANAGERS.find((x) => x.id === 'design'), c = M.MANAGERS.find((x) => x.id === 'ciso'), dm = M.MANAGERS.find((x) => x.id === 'data');
    toets('7 Design: za 24-10 10:00 CEST = 08:00Z', new Date(M.volgendeWeekronde(d, ms('2026-10-21T10:00:00Z'))).toISOString() === '2026-10-24T08:00:00.000Z');
    toets('7 Data: zo 25-10 09:30 (wintertijd vanaf 03:00) = 08:30Z', new Date(M.volgendeWeekronde(dm, ms('2026-10-24T12:00:00Z'))).toISOString() === '2026-10-25T08:30:00.000Z');
    toets('7 CISO: ma 26-10 06:00 CET = 05:00Z', new Date(M.volgendeWeekronde(c, ms('2026-10-25T12:00:00Z'))).toISOString() === '2026-10-26T05:00:00.000Z');
    // wv4116: Design (vorm + gebruik) om de week vanaf za 28-11-2026; ervoor wekelijks; UI Manager heeft geen eigen kaart meer
    toets('7 wv4116: geen manager ui meer in het register, wel deel ui bij design', !M.MANAGERS.some((x) => x.id === 'ui') && M.DELEN.some((x) => x.id === 'ui' && x.deelVan === 'design') && (d.delen || []).indexOf('ui') >= 0);
    toets('7 wv4116: do 26-11 → za 28-11 10:00 CET', new Date(M.volgendeWeekronde(d, ms('2026-11-26T12:00:00Z'))).toISOString() === '2026-11-28T09:00:00.000Z');
    toets('7 wv4116: na 28-11 10:00 → za 12-12 (5-12 is geen rondeweek)', new Date(M.volgendeWeekronde(d, ms('2026-11-28T09:00:01Z'))).toISOString() === '2026-12-12T09:00:00.000Z');
    toets('7 wv4116: over de jaargrens: 27-12 → za 9-1-2027', new Date(M.volgendeWeekronde(d, ms('2026-12-27T12:00:00Z'))).toISOString() === '2027-01-09T09:00:00.000Z');
    toets('7 wv4116: zomertijd: 20-3-2027 → za 3-4-2027 10:00 CEST = 08:00Z', new Date(M.volgendeWeekronde(d, ms('2027-03-20T12:00:00Z'))).toISOString() === '2027-04-03T08:00:00.000Z');
    toets('7 op het slot zelf telt nog', new Date(M.volgendeWeekronde(d, ms('2026-10-24T08:00:00Z'))).toISOString() === '2026-10-24T08:00:00.000Z');
    toets('7 net erna = volgende week', new Date(M.volgendeWeekronde(d, ms('2026-10-24T08:00:01Z'))).toISOString() === '2026-10-31T09:00:00.000Z');
  }
  // ── 8. stand ──
  { const { m, st } = omgeving();
    const sb = { ciso: { aantal: 2, per_ernst: { warning: 2 }, hartslag: { laatste_ronde: '2026-10-19T04:07:10Z', drempel_min: 12960 },
      top: [{ id: 'C1-x', ernst: 'warning', status: 'open', samenvatting: 'laag: iets', detail: 'pad /opt/data/x', eerst_gezien: '2026-10-05T10:00:00Z' }] },
      data: { aantal: 0, per_ernst: {}, hartslag: { laatste_ronde: '2026-10-01T03:00:00Z', drempel_min: 12960 }, top: [] },
      design: { aantal: 0, per_ernst: {}, hartslag: null, top: [] }, ui: { aantal: 1, per_ernst: { middel: 1 }, hartslag: null, top: [{ id: 'UI2-x', ernst: 'middel', status: 'open', samenvatting: 's', detail: '' }] }, mrlean: { aantal: 0, per_ernst: {}, hartslag: null, top: [] },
      bibliothecaris: { aantal: 0, per_ernst: {}, hartslag: null, top: [] } };
    let k = m.stand(sb, { vast: false });
    const c = k.find((x) => x.id === 'ciso'), d = k.find((x) => x.id === 'data'), ds = k.find((x) => x.id === 'design');
    toets('8 vijf kaarten in vaste volgorde (wv2430: MrLean; wv4116: UI zit in Design)', k.map((x) => x.id).join() === 'data,design,ciso,mrlean,bibliothecaris', k.map((x) => x.id));
    toets('8 wv4116: Design-kaart telt het UI-deel mee, rooster om de week', ds.bevindingen.aantal === 1 && ds.bevindingen.top[0].id === 'UI2-x' && ds.rooster === 'om de week op zaterdag 10:00', ds);
    toets('8 hartslag op tijd / te laat / nog nooit', c.hartslag === 'op tijd' && d.hartslag === 'te laat' && ds.hartslag === 'nog nooit', k.map((x) => x.hartslag));
    toets('8 CISO: top met detail op de telefoon, kan draaien, rooster', c.bevindingen.top.length === 1 && c.bevindingen.top[0].detail === 'pad /opt/data/x' && !('kan' in c) && c.rooster === 'elke maandag 06:00', c);
    k = m.stand(sb, { vast: true });
    toets('8 wv3446: ook met de oude vaste-plekvlag detail en CISO-top (geen afscherming)', JSON.stringify(k.map((x) => x.bevindingen)) === JSON.stringify(m.stand(sb).map((x) => x.bevindingen)) && k.find((x) => x.id === 'ciso').bevindingen.top.length > 0);
    toets('8 databank onleesbaar → kaarten zonder bevindingen, hartslag onbekend', m.stand(null, {}).every((x) => x.bevindingen === null && x.hartslag === 'onbekend'));
    await m.start('data', 'machinekamer');
    k = m.stand(sb, {});
    const d2 = k.find((x) => x.id === 'data');
    toets('8 lopend: sinds, afroep, kan niet (loopt nu)', d2.lopend && d2.lopend.afroep === true && d2.laatste_afroep.door === 'machinekamer' && !('kan' in d2), d2);
    st.runs[0].los({ ok: true, output: 'a\nDATA-MANAGER 2026-10-21: 7 bronnen gemeten, 0 niet vast te stellen, 0 open (0 nieuw), kaart geen' });
    st.jobs[0].status = 'done'; await wacht(); await wacht();
    k = m.stand(sb, {});
    const d3 = k.find((x) => x.id === 'data');
    toets('8 na afloop: laatste_ronde = afroep, weer_om over een uur', d3.laatste_afroep.uitkomst === 'goed' && d3.laatste_ronde === new Date(st.nu).toISOString() && !('weer_om' in d3), d3);
    toets('8 rapport bij "1 bron" (data vereist ≥ 1) goed', /is klaar/.test((st.berichten[0] || {}).tekst || ''), st.berichten);
  }
  // ── 8d. wv4123 (3C13/3C35/3C43): groepen, besloten, uitleg en onderhoud ──
  { const { m } = omgeving();
    const ri = M.rpcInvoer();
    toets('8d wv4123: RPC-invoer Data met onderhoud DM9 en DM10, de rest zonder', JSON.stringify((ri.find((x) => x.id === 'data') || {}).onderhoud) === '["DM9","DM10"]' && ri.filter((x) => x.onderhoud).length === 1, ri);
    const pt = (id, groep, x) => Object.assign({ id: id, check: id.split('-')[0], ernst: 'warning', status: groep === 'jou' || groep === 'besloten' ? 'gemeld' : 'open', groep: groep, samenvatting: 'codetaal ' + id, detail: '' }, x || {});
    const sb = {
      data: { aantal: 3, totaal: 3, groepen: { jou: 0, mk: 1, onderhoud: 2, besloten: 0 }, per_ernst: { warning: 3 }, hartslag: null, besloten: [],
        top: [pt('DM3-a', 'mk', { uitleg: 'Oude mappen groeien; ligt bij de machinekamer.' }), pt('DM9-b', 'onderhoud'), pt('DM10-c', 'onderhoud')] },
      mrlean: { aantal: 1, totaal: 3, groepen: { jou: 0, mk: 1, onderhoud: 0, besloten: 2 }, per_ernst: { warning: 1 }, hartslag: null, top: [pt('ML6-a', 'mk')],
        besloten: [pt('ML1-a', 'besloten', { besluit: { rij: 2431, stand: 'klaar', op: '2026-11-05T06:27:00Z', klaar_op: '2026-11-05T08:00:00Z' }, uitleg: 'Je zei Ja op 5-11.' }),
                   pt('ML7-a', 'besloten', { besluit: { rij: 2902, stand: 'wordt gebouwd', op: '2026-11-11T11:01:00Z' } })] },
      design: { aantal: 1, totaal: 1, groepen: { jou: 1, mk: 0, onderhoud: 0, besloten: 0 }, per_ernst: {}, hartslag: null, besloten: [], top: [pt('DS1-a', 'jou', { besluit: { rij: 9, stand: 'wacht op jou', op: null } })] },
      ui: { aantal: 2, totaal: 3, groepen: { jou: 0, mk: 2, onderhoud: 0, besloten: 1 }, per_ernst: {}, hartslag: null, top: [pt('UI1-a', 'mk'), pt('UI2-a', 'mk', { ernst: 'serious' })],
        besloten: [pt('UI3-a', 'besloten', { besluit: { rij: 8, stand: 'klaar', op: '2026-11-20T10:00:00Z' } })] } };
    const k = m.stand(sb, {});
    const d = k.find((x) => x.id === 'data').bevindingen, ml = k.find((x) => x.id === 'mrlean').bevindingen, ds = k.find((x) => x.id === 'design').bevindingen;
    toets('8d Data: groepen door, uitleg uit de state, vaste zin voor DM9/DM10 zonder bestandsnaam', d.groepen.onderhoud === 2 && d.top[0].uitleg === 'Oude mappen groeien; ligt bij de machinekamer.' && d.top[1].uitleg === M.ONDERHOUD_ZIN.DM9 && d.top[2].uitleg === M.ONDERHOUD_ZIN.DM10 && Object.values(M.ONDERHOUD_ZIN).every((z) => !/\.(js|ts|tsx|py|md|json)\b|\/opt\//.test(z)), d);
    toets('8d MrLean: 1 open, 2 besloten met stand en datum, totaal 3', ml.aantal === 1 && ml.groepen.besloten === 2 && ml.totaal === 3 && ml.besloten.length === 2 && ml.besloten[0].besluit.stand === 'klaar' && ml.besloten[0].besluit.op === '2026-11-05T06:27:00Z' && ml.besloten[0].uitleg === 'Je zei Ja op 5-11.' && ml.besloten[1].uitleg === '', ml);
    toets('8d Design + UI-deel: groepen opgeteld, jou bovenaan, dan ernstig voor licht, besloten van het deel mee', ds.groepen.jou === 1 && ds.groepen.mk === 2 && ds.groepen.besloten === 1 && ds.totaal === 4 && ds.aantal === 3 && ds.top.map((x) => x.id).join() === 'DS1-a,UI2-a,UI1-a' && ds.besloten.length === 1 && ds.besloten[0].id === 'UI3-a', ds);
    toets('8d punt draagt groep en besluit (rij-id niet naar de app)', ds.top[0].groep === 'jou' && ds.top[0].besluit.stand === 'wacht op jou' && !('rij' in ds.top[0].besluit), ds.top[0]);
    const veel = { aantal: 12, totaal: 12, groepen: { jou: 1, mk: 3, onderhoud: 8, besloten: 0 }, per_ernst: {}, hartslag: null, besloten: [],
      top: [pt('DS1-j', 'jou')].concat([1, 2, 3].map((i) => pt('DS2-m' + i, 'mk')), [1, 2, 3, 4, 5].map((i) => pt('DS3-o' + i, 'onderhoud'))) };
    const veelUi = { aantal: 9, totaal: 9, groepen: { jou: 4, mk: 5, onderhoud: 0, besloten: 0 }, per_ernst: {}, hartslag: null, besloten: [],
      top: [1, 2, 3, 4].map((i) => pt('UI1-j' + i, 'jou')).concat([1, 2, 3, 4, 5].map((i) => pt('UI2-m' + i, 'mk'))) };
    const dv = m.stand({ design: veel, ui: veelUi }, {}).find((x) => x.id === 'design').bevindingen;
    const per = (g) => dv.top.filter((x) => x.groep === g).length;
    toets('8d Codex MOET 1: na samenvoegen hooguit 5 per groep, onderhoud valt niet weg', per('jou') === 5 && per('mk') === 5 && per('onderhoud') === 5 && dv.top[0].groep === 'jou' && dv.top[dv.top.length - 1].groep === 'onderhoud', dv.top.map((x) => x.id));
    const dj = m.stand({ data: { aantal: 1, totaal: 1, groepen: { jou: 1, mk: 0, onderhoud: 0, besloten: 0 }, per_ernst: {}, hartslag: null, besloten: [], top: [pt('DM9-x', 'jou')] } }, {}).find((x) => x.id === 'data').bevindingen;
    toets('8d Codex MOET 2: vaste onderhoudszin niet bij een punt dat op David wacht', dj.top[0].uitleg === '' && dj.top[0].groep === 'jou', dj.top[0]);
    const oud = m.stand({ ciso: { aantal: 7, per_ernst: {}, hartslag: null, top: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: 'C' + i + '-x', ernst: 'warning' })) } }, {}).find((x) => x.id === 'ciso').bevindingen;
    toets('8d oude RPC (zonder groepen): geen groepen/besloten op de kaart, top hooguit 5, punt zonder groep', !('groepen' in oud) && !('besloten' in oud) && oud.top.length === 5 && oud.top[0].groep === null, oud);
  }
  // ── 8b. UI Manager (wv896; sinds wv4116 deel gebruik van de Design Manager): RPC-regel, samenvoegen, prompt en slotregel ──
  { const u = M.DELEN.find((x) => x.id === 'ui');
    toets('8b UI: deel met hartslag ui_manager, patroon ^UI[0-9], in de RPC-invoer', u && u.hartslag === 'ui_manager' && u.patroon === '^UI[0-9]' && M.rpcInvoer().some((x) => x.id === 'ui' && x.patroon === '^UI[0-9]'));
    const sv = M.samenvoegen({ aantal: 2, per_ernst: { laag: 2 }, top: [{ id: 'DS1-a', ernst: 'laag' }] }, { aantal: 1, per_ernst: { middel: 1, laag: 0 }, top: [{ id: 'UI2-b', ernst: 'middel' }] });
    toets('8b wv4116: samenvoegen telt op en zet middel bovenaan', sv.aantal === 3 && sv.per_ernst.laag === 2 && sv.per_ernst.middel === 1 && sv.top[0].id === 'UI2-b' && sv.top.length === 2, sv);
    toets('8b wv4116: samenvoegen met één kant leeg', M.samenvoegen(null, { aantal: 1 }).aantal === 1 && M.samenvoegen({ aantal: 4 }, null).aantal === 4);
    const ud = M.MANAGERS.find((x) => x.id === 'design');
    const p = M.prompt(ud, 'david', ms('2026-10-23T12:00:00Z'));
    toets('8b Design: prompt noemt skill design-manager, OP AFROEP, om de week en het slotformaat', /\[MACHINEKAMER - DESIGN MANAGER - OP AFROEP\]/.test(p) && /skill `design-manager`/.test(p) && /om de week op zaterdag 10:00/.test(p) && /DESIGN-MANAGER <JJJJ-MM-DD>: <n> checks, <m> niet vast te stellen, <N> open \(<k> nieuw\), kaart geen, wv geen$/.test(p), p);
    const r = M.rapportRegels('Twee dingen gevonden.\nDESIGN-MANAGER 2026-10-23: 8 checks, 1 niet vast te stellen, 2 open (2 nieuw), kaart geen, wv geen', ud);
    toets('8b Design: slotregel herkend, telling zonder voorvoegsel', r.goed && r.telling.indexOf('8 checks') === 0 && r.regels.length === 1, r);
    toets('8b Design: slot van een andere manager telt niet', !M.rapportRegels('UI-MANAGER 2026-10-23: 9 checks', ud).goed);
    // wv1722: lange regel kapt af op een woordgrens met …, niet midden in een woord of zin stil
    const lang = ('De vormgeving van het verzonnen proefscherm wijkt op meerdere plekken af van de bouwdoos, ').repeat(5).trim();
    const rl = M.rapportRegels(lang + '\nDESIGN-MANAGER 2026-10-23: 8 checks, 0 niet vast te stellen, 1 open (1 nieuw), kaart geen, wv geen', ud).regels[0];
    const zonder = rl.slice(0, -1);
    toets('8b wv1722: regel van ' + lang.length + ' tekens → ≤ 301, eindigt op …, geen half woord', lang.length >= 400 && rl.length <= 301 && /…$/.test(rl)
      && /[\s,;:]/.test(lang.charAt(zonder.length)) && lang.indexOf(zonder) === 0 && !/[\s,;:]$/.test(zonder), rl);
    toets('8b wv1722: korte regel ongewijzigd, precies 300 ongewijzigd', M.kort('kort', 300) === 'kort' && M.kort('a'.repeat(300), 300) === 'a'.repeat(300));
    toets('8b wv1722: één lang woord → hard afgekapt met …', M.kort('x'.repeat(400), 300) === 'x'.repeat(300) + '…');
    toets('8b wv1722: scriptmanager-zin gaat ook door kort()', /r && r\.zin \? \[kort\(r\.zin, 300\)\]/.test(fs.readFileSync('managers.js', 'utf8')));
    toets('8b wv1722: prompt noemt elk hooguit 300 tekens', /drie korte regels in gewone taal voor David, elk hooguit 300 tekens/.test(p));
    const s2 = fs.readFileSync('server.js', 'utf8');
    // wv2671: Design/UI Manager en MrLean draaien als pod-ronde (geen taalmodel, geen beheersleutels in een sessie)
    toets('8b UI: sessie ui-manager niet in SOCEV_ENV_EXTRA en niet in MK_SESSIES, wel in MANAGER_POD_RONDE (wv2671)',
      /const SOCEV_ENV_EXTRA = \{\n\};/.test(s2) && !/const MK_SESSIES = new Set\(\[[^\]]*'ui-manager'/.test(s2) && /const MANAGER_POD_RONDE = \{ 'design-manager': 'design', 'ui-manager': 'ui', 'mrlean': 'mrlean' \};/.test(s2));
    toets('8b UI: lessen uit de ui-manager-sessie in domein machine (niet pa)', /\n  'ui-manager': 'machine',/.test(s2));
    toets('8b api.log: LOG_GENERATIES (standaard 10) en doorschuiven .i → .i+1 vóór log → .1',
      /const LOG_GENERATIES = Math\.max\(1, Math\.min\(20, parseInt\(process\.env\.LOG_GENERATIES \|\| '10', 10\) \|\| 10\)\);/.test(s2)
      && /for \(let i = LOG_GENERATIES - 1; i >= 1; i--\) \{ try \{ fs\.renameSync\(API_LOG \+ '\.' \+ i, API_LOG \+ '\.' \+ \(i \+ 1\)\); \} catch \(e\) \{\} \}\n\s+try \{ fs\.renameSync\(API_LOG, API_LOG \+ '\.1'\);/.test(s2));
  }
  // ── 9. rpc-invoer ──
  // ── 8c. wv979: scriptmanager (Bibliothecaris) ──
  { const b = M.MANAGERS.find((x) => x.id === 'bibliothecaris');
    toets('8c Bibliothecaris: script, geen sessie/skill, hartslag bibliothecaris, patroon ^BB[0-9]', b && b.soort === 'script' && !b.sessie && !b.skill && b.hartslag === 'bibliothecaris' && b.patroon === '^BB[0-9]' && b.model === 'geen');
    // 25-10-2026 is de wisselnacht: 02:30 bestaat twee keer (00:30Z CEST en 01:30Z CET); beide zijn goed
    toets('8c dagelijks 02:30: op 24-10 23:00Z → 25-10 02:30 (wisselnacht)', ['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z'].indexOf(new Date(M.volgendeWeekronde(b, ms('2026-10-24T23:00:00Z'))).toISOString()) >= 0);
    toets('8c dagelijks 02:30 gewone nacht: 27-10 12:00Z → 28-10 01:30Z', new Date(M.volgendeWeekronde(b, ms('2026-10-27T12:00:00Z'))).toISOString() === '2026-10-28T01:30:00.000Z');
    toets('8c dagelijks over de zomertijdwissel: 25-10 12:00Z → 26-10 02:30 CET = 01:30Z', new Date(M.volgendeWeekronde(b, ms('2026-10-25T12:00:00Z'))).toISOString() === '2026-10-26T01:30:00.000Z');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-'));
    const st = { nu: ms('2026-10-25T10:00:00Z'), scripts: [], berichten: [], vangnet: 0 };
    const m = M.maak({ dir, nu: () => st.nu, fout: () => {}, jobsOpSessie: () => [{ id: 'x', status: 'running', created: st.nu }], startRun: () => { throw new Error('geen sessie'); },
      knopJa: async () => ({ ok: false }), rolPrimair: () => true, uitrolWacht: () => false, vangnet: async () => { st.vangnet++; return { mag: false, reden: 'leeg' }; },
      startScript: (mm, o) => { let los; const klaar = new Promise((r) => { los = r; }); st.scripts.push({ mm, o, los }); return { job_id: 'script' + st.scripts.length, klaar }; },
      bericht: async (x) => { st.berichten.push(x); return { status: 200 }; } });
    let r = await m.start('bibliothecaris', 'machinekamer');
    toets('8c afroep start het script, zonder quotumtoets, ook als een sessiejob loopt', r.status === 202 && st.scripts.length === 1 && st.vangnet === 0, r);
    let k = m.stand({ bibliothecaris: { aantal: 0, per_ernst: {}, hartslag: null, top: [] } }, {}).find((x) => x.id === 'bibliothecaris');
    toets('8c loopt: kan niet, soort script, rooster elke nacht 02:30', k.lopend && k.soort === 'script' && k.rooster === 'elke nacht 02:30', k);
    toets('8c tweede start terwijl hij loopt → 409', (await m.start('bibliothecaris', 'machinekamer')).status === 409);
    st.scripts[0].los({ ok: true, zin: 'register en pagina\'s gelijk (12 pagina\'s)', open: 0, nieuw: 0 }); await wacht(); await wacht();
    toets('8c rapport naar David: klaar + zin + telling', st.berichten.length === 1 && /Bibliothecaris\*\* — ronde op afroep/.test(st.berichten[0].tekst) && /gelijk/.test(st.berichten[0].tekst) && /0 open \(0 nieuw\)/.test(st.berichten[0].tekst), st.berichten);
    toets('8c daarna binnen het uur → 429', (await m.start('bibliothecaris', 'machinekamer')).status === 429);
    st.nu = ms('2026-10-26T01:10:00Z');
    toets('8c 30 min vóór de nachtronde → 409', (await m.start('bibliothecaris', 'machinekamer')).status === 409);
    const m2 = M.maak({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-')), nu: () => st.nu, fout: () => {}, jobsOpSessie: () => [], startRun: () => {}, knopJa: async () => ({}),
      rolPrimair: () => true, uitrolWacht: () => false, vangnet: async () => ({ mag: true }), bericht: async () => ({ status: 200 }) });
    st.nu = ms('2026-10-25T12:00:00Z');
    toets('8c zonder startScript (oude server) → 503', (await m2.start('bibliothecaris', 'machinekamer')).status === 503);
  }
  toets('9 rpc-invoer: vaste patronen die de RPC accepteert', M.rpcInvoer().every((x) => /^[a-z]{2,20}$/.test(x.id) && /^\^[A-Z]{1,3}\[0-9\]$/.test(x.patroon)), M.rpcInvoer());

  // ── 10. server.js-koppeling (tekst) ──
  const s = fs.readFileSync('server.js', 'utf8');
  const knip = (naam) => { const i = s.indexOf(naam); let d = 0, j = s.indexOf('{', i); for (let k = j; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}') { d--; if (d === 0) return s.slice(i, k + 1); } } };
  toets('10 dispatch GET /app/managers en /rapporten/<id>; geen POST-ronde meer (wv4128)', /route === 'GET \/app\/managers' \|\| route\.indexOf\('GET \/app\/managers\/rapporten\/'\) === 0 \|\| route\.indexOf\('GET \/app\/managers\/besluiten\/'\) === 0 \|\| route === 'POST \/app\/managers\/afspraak\/intrekken'\) return typeof appManagers === 'function'/.test(s) && !/'POST \/app\/managers\/ronde'/.test(s));
  toets('10 teller managers bestaat in appStaat (anders faalt appTeller)', /tellers: \{[^}]*managers: \[\][,} ]/.test(s));
  toets('10 wv4128: rapporten lezen box + drie archiefmaanden, met mtime-cache', /async function managersBoxTeksten\(\)/.test(s) && /'machinekamer-' \+ x\.getUTCFullYear\(\)/.test(s) && /c\.mtime === st\.mtimeMs/.test(s));
  toets('10 SMAL_GRENS manager-ronde 6 en smalActie', /'manager-ronde': 6, 'harvester\/kaart': 8 \}/.test(s) && /actie === 'manager-ronde'/.test(s) && /socevAgentSleutelOk\(d\.secret\) \? 'socev' : 'machinekamer', d\.reden\)/.test(s));
  toets('10 bron manager in BERICHT_BRONNEN, geen MELD_SOORT-regel', /\n  'manager',\s+\/\/ wv895/.test(s) && !/MELD_SOORT = \{[^}]*manager/.test(s));
  toets('10 rapport altijd kanaal machinekamer', /berichtIntern\(\{ kanaal: 'machinekamer', bron: 'manager'/.test(s) && !/kanaal: 'hoofd', bron: 'manager'/.test(s));
  toets('10 reset noteert tijd; processJob bewaart sessie niet na een reset tijdens de beurt',
    /saveSessions\(\); sessieResetOp\[key\] = Date\.now\(\); \}\n      res\.writeHead\(200/.test(s) && /const sessieGelezen = Date\.now\(\);[^\n]*\n\s*(?:const|let) sessionId = /.test(s) && /if \(sKey && r\.session_id && !\(\(sessieResetOp\[key\] \|\| 0\) > sessieGelezen\)\)/.test(s));
  toets('10 managersStartRun: sessie wissen, opgehaald zetten, output_file lezen', /function managersStartRun[\s\S]{0,400}delete chatSessions[\s\S]{0,1600}j\.opgehaald = Date\.now\(\)[\s\S]{0,300}output_file/.test(s));
  toets('10 vangnet = account1Vangnet, uitrol = uitrolWacht', /vangnet: account1Vangnet/.test(s) && /uitrolWacht: function \(\) \{ return !!uitrolWacht\(\)\.wacht; \}/.test(s));
  toets('10 knopJa leest alleen hoofdkanaal en Ja', /x\.slice\(-9\) === ':' \+ hash && v\[x\] && v\[x\]\.kanaal === 'hoofd'/.test(s) && /r\.an\.keuze === 'ja'/.test(s));
  toets('10 afroep wist de sessie ook vlak voor processJob (in de rij)', /enqueue\(key, function \(\) \{[\s\S]{0,300}delete chatSessions\[sessieSleutel\(key, rt\)\][\s\S]{0,200}return processJob\(jobId, o\.prompt/.test(s));
  // berichtIntern-shim: berichtNieuw en berichtStuur mogen alleen deze res-leden gebruiken (Fable diffreview #8)
  const leden = new Set(); [knip('async function berichtNieuw(res, d)'), knip('function berichtStuur(res, status, obj)')].forEach((f) => { for (const x of f.matchAll(/\bres\.(\w+)/g)) leden.add(x[1]); });
  toets('10 berichtNieuw/berichtStuur gebruiken alleen headersSent, writeHead, end, _log (anders breekt berichtIntern)', [...leden].every((x) => ['headersSent', 'writeHead', 'end', '_log'].includes(x)), [...leden]);
  toets('10 /health.managers', /managers: typeof managersInfo === 'function' \? managersInfo\(\)/.test(s));
  const u = fs.readFileSync('uitrol.sh', 'utf8');
  toets('10 managers.js in RELEASE_OPTIONEEL', /^RELEASE_OPTIONEEL="[^"]*\bmanagers\.js\b/m.test(u));

  // ── 11. berichtIntern en managersKnopJa los in een vm (echte functies uit server.js) ──
  const vm = require('vm');
  const knip2 = (naam) => { const i = s.indexOf(naam); let d = 0, j = s.indexOf('{', i); for (let k = j; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}') { d--; if (d === 0) return s.slice(i, k + 1); } } };
  const ctx = { setTimeout, clearTimeout, Promise, JSON, logError: () => {}, Date };
  vm.createContext(ctx);
  vm.runInContext(knip2('function berichtIntern(d)') + '\nthis.berichtIntern = berichtIntern;', ctx);
  ctx.berichtNieuw = async (res, d) => { res._log = { x: 1 }; if (res.headersSent) return; res.writeHead(200, {}); res.end(JSON.stringify({ ok: true, id: 'abc', soort: d.soort })); };
  let bi = await ctx.berichtIntern({ soort: 'antwoord' });
  toets('11 berichtIntern: status en json terug', bi.status === 200 && bi.j.ok === true && bi.j.soort === 'antwoord', bi);
  ctx.berichtNieuw = async () => { throw new Error('boem'); };
  bi = await ctx.berichtIntern({});
  toets('11 berichtIntern: uitzondering → 500', bi.status === 500, bi);
  const vragen = { '0000000000000000:abcd1234': { kanaal: 'hoofd', t: '2026-10-20T09:58:00Z', antwoord: { keuze: 'nee', t: '2026-10-20T09:59:00Z' } },
    'aaaaaaaaaaaaaaaa:abcd1234': { kanaal: 'hoofd', t: '2026-10-21T09:58:00Z', antwoord: { keuze: 'ja', t: '2026-10-21T09:59:00Z' } },
    'dddddddddddddddd:abcd1234': { kanaal: 'hoofd', t: '2026-10-21T08:58:00Z', antwoord: { keuze: 'ja', t: '2026-10-21T08:59:00Z' } },
    'bbbbbbbbbbbbbbbb:dddd0000': { kanaal: 'machinekamer', t: '2026-10-21T09:58:00Z', antwoord: { keuze: 'ja', t: '2026-10-21T09:59:00Z' } },
    'cccccccccccccccc:eeee1111': { kanaal: 'hoofd', t: '2026-10-21T09:58:00Z', antwoord: { keuze: 'nee', t: '2026-10-21T09:59:00Z' } } };
  const ctx2 = { appVragen: () => vragen, appAntwoord: (r) => r.antwoord, appKnopVraagTekst: async (j, k, h) => ({ tekst: 'Zal ik de Design Manager nu een ronde laten draaien?' }), Date, String, Object };
  vm.createContext(ctx2);
  vm.runInContext(knip2('async function managersKnopJa(hash, gebruikt)') + '\nthis.f = managersKnopJa;', ctx2);
  let kj = await ctx2.f('abcd1234');
  toets('11 knopJa: oudere Nee met dezelfde zin telt niet mee; nieuwste Ja → ok met tekst, tijd en sleutel', kj.ok && kj.sleutel === 'aaaaaaaaaaaaaaaa:abcd1234' && kj.t === ms('2026-10-21T09:59:00Z'), kj);
  kj = await ctx2.f('abcd1234', ['aaaaaaaaaaaaaaaa:abcd1234']);
  toets('11 knopJa: nieuwste al gebruikt → de volgende ongebruikte Ja', kj.ok && kj.sleutel === 'dddddddddddddddd:abcd1234', kj);
  kj = await ctx2.f('abcd1234', ['aaaaaaaaaaaaaaaa:abcd1234', 'dddddddddddddddd:abcd1234']);
  toets('11 knopJa: alle Ja al gebruikt → "al gebruikt"', !kj.ok && /al gebruikt/.test(kj.fout), kj);
  toets('11 knopJa: machinekamer-vraag telt niet', !(await ctx2.f('dddd0000')).ok);
  toets('11 knopJa: Nee telt niet', /geen Ja/.test((await ctx2.f('eeee1111')).fout));

  // ── 12. wv4135 (3C124 Jouw besluiten, 3C73 Dit mag ik zelf + Intrekken) ──
  toets('12 besluitIds: design neemt ui mee, onbekend leeg', JSON.stringify(M.besluitIds('design')) === '["design","ui"]' && JSON.stringify(M.besluitIds('ciso')) === '["ciso"]' && M.besluitIds('x').length === 0);
  const bv = M.besluitVorm({ aantal: 6, besluiten: [{ datum: '2026-11-05T06:25:00Z', vraag: 'Nacontroles — minder?', antwoord: 'Ja', effect: 'Van 199 naar 32 per week.', effect_op: '2026-11-27T19:00:00Z' },
    { datum: '2026-11-11T11:01:00Z', vraag: 'Box archiveren?', antwoord: 'Hack<script>', effect: null }] });
  toets('12 besluitVorm: aantal, effect, onbekend antwoord → Beantwoord, geen effect = null', bv.aantal === 6 && bv.besluiten.length === 2 && bv.besluiten[0].effect === 'Van 199 naar 32 per week.' && bv.besluiten[1].antwoord === 'Beantwoord' && bv.besluiten[1].effect === null, bv);
  toets('12 besluitVorm: rommel → leeg', M.besluitVorm(null).aantal === 0 && M.besluitVorm({ besluiten: 'x' }).besluiten.length === 0);
  const reg = { rijen: [
    { id: 'afspraak-ciso-sleuteldragers-wissen', manager: 'ciso', status: 'aan', tekst: ['De CISO wist zelf …'], bron: [{ datum: '2026-11-30', vraag_id: 'abcd1234' }] },
    { id: 'afspraak-ciso-opslag-weer-prive', manager: 'ciso', status: 'uit', tekst: ['ingetrokken'], bron: [] },
    { id: 'afspraak-ciso-vals', manager: 'data', status: 'aan', tekst: ['manager klopt niet'], bron: [] },
    { id: 'afspraak-ui-knoppen-groter', manager: 'ui', status: 'aan', tekst: ['UI-deel'], bron: [] },
    { id: 'pot-sloel-notas', status: 'aan', tekst: ['geen afspraak'] }] };
  const lg = ['{"rij":"afspraak-ciso-sleuteldragers-wissen","regel":"2 logbestanden met een sleutel gewist","t":"2026-12-07T06:40:00+01:00"}', 'kapot', '{"rij":"afspraak-ciso-sleuteldragers-wissen","regel":"1 logbestand met een sleutel gewist","t":"2026-12-14T06:40:00+01:00"}'];
  const af = M.afspraken(reg, lg, 'ciso');
  toets('12 afspraken CISO: alleen eigen rij met status aan; laatste meldregel; uit/andere manager/geen afspraak niet', af.length === 1 && af[0].id === 'afspraak-ciso-sleuteldragers-wissen' && af[0].sinds === '2026-11-30' && af[0].laatst && af[0].laatst.regel === '1 logbestand met een sleutel gewist', af);
  toets('12 afspraken Design toont ook het UI-deel', M.afspraken(reg, [], 'design').map((x) => x.id).join() === 'afspraak-ui-knoppen-groter');
  toets('12 afspraken zonder register → leeg', M.afspraken(null, lg, 'ciso').length === 0);
  toets('12 glijdroute intrekken', /APP_GLIJD_ROUTES\.add\('POST \/app\/managers\/afspraak\/intrekken'\)/.test(s));
  // de echte appManagers in een vm: besluiten-route en Intrekken (toestemming.py vervangen door een proefscript)
  {
    const vm = require('vm'), cp = require('child_process');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr4135-'));
    fs.writeFileSync(path.join(d, 'reg.json'), JSON.stringify(reg));
    fs.writeFileSync(path.join(d, 'log.jsonl'), lg.join('\n') + '\n');
    fs.writeFileSync(path.join(d, 'tst.py'), 'import json,sys\nr=json.load(open(sys.argv[0].replace("tst.py","reg.json")))\nopen(sys.argv[0].replace("tst.py","args.json"),"w").write(json.dumps(sys.argv[1:]))\nfor x in r["rijen"]:\n  if x["id"]==sys.argv[2]: x["status"]=sys.argv[3]\njson.dump(r,open(sys.argv[0].replace("tst.py","reg.json"),"w"))\n');
    const blok = knip('async function appManagers(req, res, a, d, route)');
    const helpers = s.slice(s.indexOf('function managersRegister()'), s.indexOf('async function appManagers(req, res, a, d, route)'));
    const uit = [];
    const c = { MANAGERS_MOD: M, managers: { stand: () => M.MANAGERS.map((m) => ({ id: m.id })) }, fs, require, JSON, Promise, Date, String, Object, Array,
      MANAGERS_REGISTER: path.join(d, 'reg.json'), MANAGERS_AFSPRAKEN_LOG: path.join(d, 'log.jsonl'), MANAGERS_TOESTEMMING_PY: path.join(d, 'tst.py'),
      logError: () => {}, appAudit: (o) => uit.push(['audit', o]), appRolOk: async () => true, appTellerN: 0,
      appSbRpc: async (n, a) => { uit.push(['rpc', n, a]); return { aantal: 1, besluiten: [{ datum: '2026-11-05', vraag: 'V', antwoord: 'Ja', effect: 'E is gemeten.' }] }; },
      appStuur: (res, st, j) => { res.st = st; res.j = j; }, appWeiger: (res, st, f) => { res.st = st; res.j = { ok: false, fout: f }; } };
    c.appTeller = () => ++c.appTellerN <= 10;
    vm.createContext(c);
    vm.runInContext(helpers + '\n' + blok + '\nthis.f = appManagers;', c);
    const rq = async (route, body) => { const res = { _app: {} }; await c.f({}, res, {}, body || {}, route); return res; };
    let r = await rq('GET /app/managers/besluiten/design');
    toets('12 GET besluiten/design → RPC met design+ui, vorm met effect', r.st === 200 && r.j.aantal === 1 && r.j.besluiten[0].effect === 'E is gemeten.' && JSON.stringify(uit.find((x) => x[0] === 'rpc')[2]) === '{"p_managers":["design","ui"],"p_max":50}', [r, uit]);
    r = await rq('GET /app/managers/besluiten/onzin');
    toets('12 GET besluiten onbekende manager → 404', r.st === 404);
    r = await rq('POST /app/managers/afspraak/intrekken', { id: '../toestemmingen' });
    toets('12 intrekken ongeldig id → 400', r.st === 400);
    r = await rq('POST /app/managers/afspraak/intrekken', { id: 'afspraak-ciso-vals' });
    toets('12 intrekken rij van een andere manager → 404, niets gewijzigd', r.st === 404 && !fs.existsSync(path.join(d, 'args.json')));
    r = await rq('POST /app/managers/afspraak/intrekken', { id: 'afspraak-ciso-opslag-weer-prive' });
    toets('12 intrekken al uit → 200 al, geen aanroep', r.st === 200 && r.j.al === true && !fs.existsSync(path.join(d, 'args.json')));
    r = await rq('POST /app/managers/afspraak/intrekken', { id: 'afspraak-ciso-sleuteldragers-wissen' });
    const args = fs.existsSync(path.join(d, 'args.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'args.json'), 'utf8')) : [];
    toets('12 intrekken → toestemming.py status <id> uit met meting en reden; rij uit; audit', r.st === 200 && r.j.status === 'uit' && args[0] === 'status' && args[1] === 'afspraak-ciso-sleuteldragers-wissen' && args[2] === 'uit' && args.includes('--gemeten') && args.includes('--reden') &&
      JSON.parse(fs.readFileSync(path.join(d, 'reg.json'), 'utf8')).rijen[0].status === 'uit' && uit.some((x) => x[0] === 'audit'), [r, args]);
    r = await rq('GET /app/managers');
    const ciso = r.j && r.j.managers.find((k) => k.id === 'ciso');
    toets('12 GET /app/managers: na intrekken geen afspraak meer op de CISO-kaart; Design toont het UI-deel', r.st === 200 && ciso && Array.isArray(ciso.afspraken) && ciso.afspraken.length === 0 && r.j.managers.find((k) => k.id === 'design').afspraken.length === 1, r.j);
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ── 13. wv4204 (3C176): Deze week van je managers — twee regels per manager, knop alleen bij een open kaart ──
  {
    const nu = ms('2026-11-27T20:00:00Z');
    const kaart = (id, x) => Object.assign({ id: id, hartslag: 'op tijd', weekronde: '2026-11-22T14:03:00Z', volgende: '2026-11-29T08:30:00Z', gemist: null, lopend: null }, x || {});
    const wk = {
      data: { nieuw: 24, nieuw_onderhoud: 23, vanzelf: 108, open_kaarten: 0, kaarten: [], besloten: 1, laatst_besloten: { titel: 'Opslag — oude bouwmappen weghalen?', op: '2026-11-22T18:01:00Z', antwoord: 'Ja' } },
      ciso: { nieuw: 2, nieuw_onderhoud: 0, vanzelf: 4, open_kaarten: 2, kaarten: [{ id: 2701, titel: 'Beveiliging — twee punten afsluiten?' }, { id: 2690, titel: 'ouder' }], besloten: 0 },
      design: { nieuw: 0, vanzelf: 0, open_kaarten: 0, kaarten: [], besloten: 0 },
      ui: { nieuw: 1, vanzelf: 2, open_kaarten: 1, kaarten: [{ id: 2702, titel: 'Telefoon — knop groter?' }], besloten: 0 },
      mrlean: { nieuw: 0, vanzelf: 0, open_kaarten: 0, kaarten: [], besloten: 0 },
    };
    const d1 = M.weekRegels(kaart('data'), wk, nu);
    toets('13 Data: ronde-dag, nieuw met onderhoud, vanzelf opgelost; regel 2 = jouw besluit met antwoord; geen knop',
      d1 && d1.regels.length === 2 && d1.regels[0] === 'Ronde zondag 22-11: 24 nieuwe punten, waarvan 23 onderhoud; 108 vanzelf opgelost.' &&
      d1.regels[1] === 'Jij besliste deze week: Opslag — oude bouwmappen weghalen? (Ja).' && d1.kaarten.length === 0 && d1.bij_jou === 0, d1);
    const c1 = M.weekRegels(kaart('ciso', { weekronde: '2026-11-23T05:12:00Z' }), wk, nu);
    toets('13 CISO: open kaart = "Wacht op jou" + (en nog 1) en precies één knop (id van de nieuwste)',
      c1.regels[1] === 'Wacht op jou: Beveiliging — twee punten afsluiten? (en nog 1)' && c1.kaarten.length === 1 && c1.kaarten[0].id === 2701 && c1.bij_jou === 2, c1);
    const ds = M.weekRegels(kaart('design', { weekronde: '2026-11-14T09:00:00Z', volgende: '2026-11-28T09:00:00Z' }), wk, nu);
    toets('13 Design telt het UI-deel mee (nieuw, vanzelf, kaart); ronde ouder dan een week → "Geen ronde deze week"',
      ds.regels[0] === 'Geen ronde deze week: 1 nieuw punt; 2 vanzelf opgelost.' && ds.kaarten[0].id === 2702, ds);
    const dsui = M.weekRegels(kaart('design'), { design: { open_kaarten: 1, kaarten: [{ id: 11, titel: 'oud design', aangemaakt: '2026-11-20T10:00:00Z' }] },
      ui: { open_kaarten: 1, kaarten: [{ id: 12, titel: 'nieuw ui', aangemaakt: '2026-11-26T10:00:00Z' }] } }, nu);
    toets('13 Codex MOET 1: Design + UI → de nieuwste kaart (ook als die van het UI-deel is), (en nog 1)', dsui.kaarten[0].id === 12 && dsui.regels[1] === 'Wacht op jou: nieuw ui (en nog 1)', dsui);
    const ml = M.weekRegels(kaart('mrlean', { weekronde: '2026-11-10T09:00:00Z', volgende: '2026-12-02T09:00:00Z' }), wk, nu);
    toets('13 MrLean: niets in de week → geen ronde + volgende; regel 2 "Niets bij jou."', ml.regels[0] === 'Deze week geen ronde; de volgende is woensdag 2-12.' && ml.regels[1] === 'Niets bij jou.', ml);
    const ml2 = M.weekRegels(kaart('mrlean', { weekronde: '2026-11-27T16:13:00Z' }), wk, nu);
    toets('13 ronde zonder verschil → "niets veranderd"', ml2.regels[0] === 'Ronde vrijdag 27-11: niets veranderd.', ml2);
    const laat = M.weekRegels(kaart('mrlean', { hartslag: 'te laat', gemist: 'MrLean heeft woensdag niet gedraaid: x; volgende ronde woensdag 2-12; je hoeft niets te doen.' }), wk, nu);
    toets('13 te laat → regel 1 = de gemiste-ronde-zin', laat.regels[0].indexOf('MrLean heeft woensdag niet gedraaid') === 0, laat);
    const bb = M.weekRegels(kaart('bibliothecaris', { weekronde: '2026-11-27T01:30:00Z' }), { bibliothecaris: { nieuw: 1, vanzelf: 1 } }, nu);
    toets('13 Bibliothecaris (script) → "Elke nacht gedraaid"', bb.regels[0] === 'Elke nacht gedraaid: 1 nieuw punt; 1 vanzelf opgelost.', bb);
    toets('13 geen weekdata of onbekende manager → null', M.weekRegels(kaart('data'), null, nu) === null && M.weekRegels(kaart('onzin'), wk, nu) === null);
    const vals = M.weekRegels(kaart('ciso'), { ciso: { open_kaarten: 1, kaarten: [{ id: 'x; drop', titel: 't' }, { id: -3, titel: 't' }] } }, nu);
    toets('13 kaart zonder geldig id → geen knop en geen "Wacht op jou"', vals.kaarten.length === 0 && vals.regels[1] === 'Niets bij jou.', vals);
    const lang = M.weekRegels(kaart('ciso'), { ciso: { open_kaarten: 1, kaarten: [{ id: 5, titel: 'woord '.repeat(80) }] } }, nu);
    toets('13 lange titel ingekort (≤ 141 tekens)', lang.kaarten[0].titel.length <= 141 && /…$/.test(lang.kaarten[0].titel), lang.kaarten[0].titel.length);

    // server.js: GET /app/managers vraagt de week op naast de stand (7 dagen), en zonder week (RPC faalt) blijft de stand gewoon
    const vm = require('vm');
    const s = fs.readFileSync('server.js', 'utf8');
    const begin = s.indexOf('async function appManagers(req, res, a, d, route)');
    const blok = s.slice(begin, s.indexOf('\n}\n', begin) + 3);
    const roep = [];
    let weekFaalt = false;
    const c = { MANAGERS_MOD: M, managers: { stand: () => [kaart('data'), kaart('ciso')] }, Promise, Date, Object, Array, String, JSON,
      managersRegister: () => null, managersAfsprakenLog: () => [], logError: () => {},
      appSbRpc: async (n, a) => { roep.push([n, a]); if (n === 'mk_managers_week') { if (weekFaalt) throw new Error('42883'); return wk; } return { data: { aantal: 0 } }; },
      appStuur: (res, st, j) => { res.st = st; res.j = j; }, appWeiger: (res, st, f) => { res.st = st; res.j = { ok: false, fout: f }; } };
    vm.createContext(c);
    vm.runInContext(blok + '\nthis.f = appManagers;', c);
    let res = { _app: {} };
    await c.f({}, res, {}, {}, 'GET /app/managers');
    const wr = roep.find((x) => x[0] === 'mk_managers_week');
    toets('13 server: RPC mk_managers_week met de vaste lijst en p_dagen 7; elke kaart krijgt week', res.st === 200 && wr && wr[1].p_dagen === 7 && JSON.stringify(wr[1].p_managers) === JSON.stringify(M.rpcInvoer()) &&
      res.j.managers.every((k) => k.week && k.week.regels.length === 2), [res.j, wr]);
    weekFaalt = true; res = { _app: {} };
    await c.f({}, res, {}, {}, 'GET /app/managers');
    toets('13 server: week-RPC faalt → 200, kaarten zonder week, geen foutregel', res.st === 200 && res.j.fout === null && res.j.managers.every((k) => k.week === undefined), res.j);
  }

  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
