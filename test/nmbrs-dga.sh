#!/usr/bin/env bash
# wv3662 (21-11-2026): Davids eigen looncomponenten als DGA (nmbrs-data.js dgaRonde, nmbrs-betaal.js leesRunRegels) en de laadvergoeding naast
# de laadschatting (nmbrs-laad.js, kind 'laad'/'laadgemeld'). Tegen een nagebootste API op 127.0.0.1, ALLEEN VERZONNEN ids en bedragen.
# Raakt de pod, de kluis, /opt/data/nmbrs en /opt/data/tibber niet. Kruisproef: zonder het filter op de eigen medewerker → rood.
# Gebruik: bash test/nmbrs-dga.sh [bestand-onder-toets]   (zonder argument: nmbrs-data.js uit deze map)
set -u
cd "$(dirname "$0")/.." || exit 1
DOEL="${1:-$PWD/nmbrs-data.js}"
NMBRS_PAUZE_MS=0 DOEL="$DOEL" node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const H = 'c0000000-0000-4000-8000-0000000000h1'.replace('h1', 'a1'), P = 'c0000000-0000-4000-8000-0000000000b2';
const DGA = 'e0000000-0000-4000-8000-0000000000d1', ANDER = 'e0000000-0000-4000-8000-0000000000f9';
const R1 = 'r0000000-0000-4000-8000-000000000001', R2 = 'r0000000-0000-4000-8000-000000000002', R3 = 'r0000000-0000-4000-8000-000000000003';
const M = { log: [], xml: {}, status: {} };
const rep = (id, per, lines) => '<report><employeeid>' + id + '</employeeid><period>' + per + '</period><year>2026</year><runnumber>1</runnumber><lines>' +
  lines.map((l) => '<line><code>' + l[0] + '</code><description>' + l[1] + '</description><value>' + l[2] + '</value></line>').join('') + '</lines></report>';
const doc = (...r) => '<?xml version="1.0"?><reports>' + r.join('') + '</reports>';
M.xml[R1] = doc(rep(DGA, 10, [[1000, 'Salaris', '1234.00'], [5122, 'Netto Vergoeding', '140.34'], [5122, 'Netto Vergoeding', '1.00']]), rep(ANDER, 10, [[1000, 'Salaris', '999.99'], [5122, 'Netto Vergoeding', '77.77']]));
M.xml[R2] = doc(rep(DGA, 9, [[5122, 'Netto Vergoeding', '140.34']]));
M.xml[R3] = doc(rep(DGA, 8, [[5122, 'Netto Vergoeding', '140.34']]));
const srv = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://x');
  M.log.push(u.pathname + u.search);
  const m = /\/runs\/([^/]+)\/wagecodes\/xml$/.exec(u.pathname);
  if (m) { const st = M.status[m[1]] || 200; res.writeHead(st, { 'Content-Type': 'application/json' }); return res.end(st === 200 ? JSON.stringify({ taskId: 'a0000000-0000-4000-8000-0000000000' + m[1].slice(-2) }) : '{}'); }
  const t = /^\/api\/documents\/a0000000-0000-4000-8000-0000000000(\d\d)$/.exec(u.pathname);
  if (t) { const x = M.xml['r0000000-0000-4000-8000-0000000000' + t[1]]; res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(x); }
  res.writeHead(404); res.end('{}');
});
srv.listen(0, '127.0.0.1', async function () {
  process.env.NMBRS_API_BASIS = 'http://127.0.0.1:' + srv.address().port;
  const T = require(process.env.DOEL);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmbrs-dga-'));
  const d = T.db(dir), nu = new Date().toISOString();
  d.prepare('insert into bedrijf (id, data, periode_soort, gezien) values (?, ?, ?, ?)').run(H, '{}', 'month', nu);
  d.prepare('insert into bedrijf (id, data, periode_soort, gezien) values (?, ?, ?, ?)').run(P, '{}', 'month', nu);
  d.prepare("insert into bedrijf_entiteit values (?, 'HOLD', 'toets', ?)").run(H, nu);
  d.prepare("insert into bedrijf_entiteit values (?, 'POT', 'toets', ?)").run(P, nu);
  d.prepare('insert into medewerker values (?, ?, ?, ?)').run(DGA, H, '{}', nu);
  const run = (id, nr, per, locked) => d.prepare('insert into loonrun (id, bedrijf, data) values (?, ?, ?)').run(id, H, JSON.stringify({ payrollRunId: id, number: nr, year: 2026, periodStart: per, periodEnd: per, locked: locked }));
  run(R1, 10, 10, false); run(R2, 9, 9, true); run(R3, 8, 8, true);
  const L = T.nieuweLezer('tok', 'sub-proef-000001', false);
  const regels = () => d.prepare('select run, jaar, periode, code, centen from dga_regel order by run, code').all().map((x) => Object.assign({}, x));
  const runSt = (r) => Object.assign({}, d.prepare('select * from dga_run where run = ?').get(r) || {});
  try {
    // poort buiten dgaRonde: zonder looncodes geweigerd, ook voor de Holding
    let weg = false; try { T.verzoekToets('GET', process.env.NMBRS_API_BASIS + '/api/companies/' + H + '/runs/' + R1 + '/wagecodes/xml?year=2026'); } catch (e) { weg = e.reden === 'pad'; }
    toets('poort: run output zonder codes buiten dgaRonde geweigerd', weg);

    // geen HOLD → niets gevraagd
    let uit = {}; await T.dgaRonde(L, d, P, 2026, { doc: true }, uit, [{ employeeId: DGA }]);
    toets('ander bedrijf (POT): geen verzoek, geen dga-telling', M.log.length === 0 && !uit.dga, { log: M.log, uit });
    // twee medewerkers in de lijst → niets
    uit = {}; await T.dgaRonde(L, d, H, 2026, { doc: true }, uit, [{ employeeId: DGA }, { employeeId: ANDER }]);
    toets('twee medewerkers in /employees: niets gevraagd', M.log.length === 0 && uit.dga && uit.dga.fout === 'niet precies één medewerker', uit);
    // andere id dan de eigen kopie → niets
    uit = {}; await T.dgaRonde(L, d, H, 2026, { doc: true }, uit, [{ employeeId: ANDER }]);
    toets('medewerker wijkt af van de eigen kopie: niets gevraagd', M.log.length === 0 && uit.dga.fout === 'niet precies één medewerker', uit);
    // geen documentrecht → niets
    uit = {}; await T.dgaRonde(L, d, H, 2026, { doc: false }, uit, [{ employeeId: DGA }]);
    toets('zonder documentrecht: niets gevraagd', M.log.length === 0 && uit.dga.recht === false, uit);

    // goed pad
    uit = {}; await T.dgaRonde(L, d, H, 2026, { doc: true }, uit, [{ employeeId: DGA }]);
    const xmlVragen = M.log.filter((x) => /wagecodes\/xml/.test(x));
    toets('drie runs gelezen, zonder looncodefilter, met year', uit.dga.gelezen === 3 && xmlVragen.length === 3 && xmlVragen.every((x) => /\?year=2026$/.test(x)), { uit, xmlVragen });
    toets('nieuwste run eerst (R1 nr 10)', /r0000000-0000-4000-8000-000000000001/.test(xmlVragen[0]), xmlVragen);
    const rg = regels();
    toets('alleen de eigen medewerker bewaard (salaris R1 = 1234,00, geen 77,77 / 999,99)', rg.some((x) => x.run === R1 && x.code === 1000 && x.centen === 123400) && !rg.some((x) => x.centen === 7777 || x.centen === 99999), rg);
    toets('zelfde code in één report opgeteld (140,34 + 1,00)', rg.some((x) => x.run === R1 && x.code === 5122 && x.centen === 14134), rg);
    toets('andere persoon alleen geteld als run (met_ander 1)', uit.dga.met_ander === 1, uit);
    toets('poort na dgaRonde weer dicht', (function () { try { T.verzoekToets('GET', process.env.NMBRS_API_BASIS + '/api/companies/' + H + '/runs/' + R1 + '/wagecodes/xml?year=2026'); return false; } catch (e) { return true; } })());
    toets('open run niet definitief, vergrendelde wel', runSt(R1).definitief === 0 && runSt(R2).definitief === 1, [runSt(R1), runSt(R2)]);

    // tweede ronde: alleen de open run opnieuw; nu kapot (regel zonder code) → afgekeurd en zijn regels weg
    M.log.length = 0;
    M.xml[R1] = doc(rep(DGA, 10, [[5122, 'Netto Vergoeding', '140.34']])).replace('<code>5122</code>', '<code></code>');
    uit = {}; await T.dgaRonde(L, d, H, 2026, { doc: true }, uit, [{ employeeId: DGA }]);
    toets('tweede ronde: alleen de open run opnieuw', M.log.filter((x) => /wagecodes/.test(x)).length === 1 && M.log.some((x) => x.includes(R1)), M.log);
    toets('onleesbare regel → afgekeurd, regels van die run weg', runSt(R1).status === 'afgekeurd' && !regels().some((x) => x.run === R1), [runSt(R1), regels()]);

    // geen eigen report → afgekeurd
    d.prepare('delete from dga_run').run(); d.prepare('delete from dga_regel').run(); M.log.length = 0;
    M.xml[R1] = doc(rep(ANDER, 10, [[5122, 'Netto Vergoeding', '140.34']]));
    M.status[R3] = 403;
    uit = {}; await T.dgaRonde(L, d, H, 2026, { doc: true }, uit, [{ employeeId: DGA }]);
    toets('alleen een ander report → afgekeurd, niets bewaard', runSt(R1).status === 'afgekeurd' && runSt(R1).fout === 'geen eigen report' && !regels().some((x) => x.run === R1), runSt(R1));
    toets('403 op de taak → blijvend', runSt(R3).status === 'blijvend', runSt(R3));
    // MOET 1: een afgekeurde OPEN run komt de volgende ronde terug en wordt goed als Nmbrs hem herstelt
    M.log.length = 0; M.xml[R1] = doc(rep(DGA, 10, [[5122, 'Netto Vergoeding', '140.34']]));
    uit = {}; await T.dgaRonde(L, d, H, 2026, { doc: true }, uit, [{ employeeId: DGA }]);
    toets('afgekeurde open run opnieuw gelezen en nu goed', M.log.some((x) => x.includes(R1)) && runSt(R1).status === 'ok' && regels().some((x) => x.run === R1 && x.centen === 14034), [runSt(R1), M.log]);
    toets('dubbel report (zelfde periode/run) → afgekeurd', (function () { const B = require(path.join(path.dirname(process.env.DOEL), 'nmbrs-betaal.js')); const r = B.leesRunRegels(doc(rep(DGA, 9, [[1, 'a', '1.00']]), rep(DGA, 9, [[1, 'a', '1.00']]))); return r.ok && r.dubbel; })());

    // laadvergoeding naast de schatting
    const LA = require(path.join(path.dirname(process.env.DOEL), 'nmbrs-laad.js'));
    const uren = [];
    for (const m of ['08', '09', '10']) for (let dg = 1; dg <= 28; dg++) for (let h = 0; h < 24; h++) {
      const van = '2026-' + m + '-' + String(dg).padStart(2, '0') + 'T' + String(h).padStart(2, '0') + ':00:00.000+02:00';
      const laad = dg % 2 === 0 && h >= 18 && h <= 20 ? 7 : 0;   // om de dag 21 kWh (elke dag op hetzelfde uur = 'gewoon verbruik' voor de regel)
      uren.push({ van, kwh: 1 + laad, kosten: (1 + laad) * 0.30 });
    }
    const S = LA.schatting(uren);
    toets('schatting: 3 uur × 7 kWh × 14 dagen = 294 kWh, × 0,30', S['2026-08'].kwh === 294 && Math.abs(S['2026-08'].kosten - 88.2) < 0.01 && S['2026-08'].dagen === 28, S['2026-08']);
    const vg = { '2026-08': 14034, '2026-09': 14034, '2026-10': 14034 };
    const v1 = LA.vergelijk(S, vg, '2026-11');
    toets('vergelijk: 264,60 tegen 421,02 = −37,2 % → signaal', v1.compleet && v1.signaal && v1.afwijking_pct === -37.2, v1);
    const v2 = LA.vergelijk(S, { '2026-08': 9000, '2026-09': 9000, '2026-10': 9000 }, '2026-11');
    toets('vergelijk: binnen 20 % → geen signaal', v2.compleet && !v2.signaal, v2);
    toets('vergelijk: laaduur zonder prijs → niet compleet, geen signaal', (function () { const u2 = uren.map((x) => x.van.startsWith('2026-09-10T19') ? Object.assign({}, x, { kosten: null }) : x); const S2 = LA.schatting(u2); const v = LA.vergelijk(S2, vg, '2026-11'); return S2['2026-09'].zonder_prijs === 1 && !v.compleet && !v.signaal; })());
    toets('blok: maand met laaduur zonder prijs toont geen kosten of verschil', (function () { const u2 = uren.map((x) => x.van.startsWith('2026-09-10T19') ? Object.assign({}, x, { kosten: null }) : x); const S2 = LA.schatting(u2); const bl = LA.blok({ maanden: S2, vergoed: vg, vergelijk: LA.vergelijk(S2, vg, '2026-11'), nuMaand: '2026-11', tijd: 'x' }); const rg = bl.split('\n').find((l) => l.startsWith('| sep 2026')); return /onvolledig \(1 uur zonder prijs\) \| – \|$/.test(rg); })());
    toets('schatting: buuruur alleen bij precies één uur afstand', (function () { const u3 = [{ van: '2026-09-01T10:00:00.000+02:00', kwh: 9, kosten: 1 }, { van: '2026-09-01T14:00:00.000+02:00', kwh: 2.5, kosten: 1 }]; for (let k = 0; k < 20; k++) u3.push({ van: '2026-09-' + String(k + 2).padStart(2, '0') + 'T10:00:00.000+02:00', kwh: 0.5, kosten: 0.1 }, { van: '2026-09-' + String(k + 2).padStart(2, '0') + 'T14:00:00.000+02:00', kwh: 0.5, kosten: 0.1 }); u3.sort((a, b) => a.van < b.van ? -1 : 1); const S3 = LA.schatting(u3); return Math.round(S3['2026-09'].kwh * 10) / 10 === 8.5; })());
    toets('vergelijk: maand zonder vergoeding → niet compleet, geen signaal', (function () { const v = LA.vergelijk(S, { '2026-09': 1, '2026-10': 1 }, '2026-11'); return !v.compleet && !v.signaal; })());
    const b = LA.blok({ maanden: S, vergoed: vg, vergelijk: v1, nuMaand: '2026-11', tijd: '2026-11-21 13:00' });
    toets('blok: begint en eindigt met de markeringen, noemt het signaal', b.startsWith(LA.BLOK_BEGIN) && b.endsWith(LA.BLOK_EINDE) && /Signaal/.test(b) && /€ 140,34/.test(b), b);
    toets('blokZet: zonder markeringen niets', LA.blokZet('# pagina\n', b) === null);
    const pag = '# p\n' + LA.BLOK_BEGIN + '\noud\n' + LA.BLOK_EINDE + '\nrest\n', n1 = LA.blokZet(pag, b);
    toets('blokZet: tussen de markeringen, rest blijft', n1 && n1.includes('rest') && !n1.includes('oud'), n1);
    toets('blokZet: alleen een andere tijd → niets', LA.blokZet(n1, b.replace('2026-11-21 13:00', '2026-11-22 07:03')) === null);

    // kind 'laad' + 'laadgemeld': signaal per venster één keer
    const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmbrs-dga-t-')), tp = path.join(tdir, 'tibber.sqlite');
    const { DatabaseSync } = require('node:sqlite'); const tb = new DatabaseSync(tp);
    tb.exec('create table verbruik (home_id text, van text, tot text, kwh real, kosten real, eenheidsprijs real, eenheidsprijs_btw real, valuta text, primary key (home_id, van))');
    const z = tb.prepare("insert into verbruik (home_id, van, kwh, kosten) values ('h', ?, ?, ?)"); uren.forEach((x) => z.run(x.van, x.kwh, x.kosten));
    // MOET 2: een tweede, oudere woning met veel verbruik mag niet meetellen
    const z2 = tb.prepare("insert into verbruik (home_id, van, kwh, kosten) values ('oud', ?, ?, ?)"); uren.forEach((x) => z2.run(x.van.replace('2026-', '2025-'), 50, 50)); tb.close();
    d.prepare('delete from dga_run').run(); d.prepare('delete from dga_regel').run();
    [['x8', 8], ['x9', 9], ['x10', 10]].forEach(function (q) { d.prepare("insert into dga_run (run, bedrijf, status) values (?, ?, 'ok')").run(q[0], H); d.prepare("insert into dga_regel values (?, 2026, ?, 5122, 'Netto Vergoeding', 14034)").run(q[0], q[1]); d.prepare("insert into dga_regel values (?, 2026, ?, 1000, 'Salaris', 500000)").run(q[0], q[1]); });
    d.prepare("insert into dga_run (run, bedrijf, status) values ('xa', ?, 'afgekeurd')").run(H); d.prepare("insert into dga_regel values ('xa', 2026, 10, 5122, 'x', 99999)").run();
    const k1 = T.kindLaad({ tibber: tp, nu_maand: '2026-11' }, dir);
    toets('kind laad: vergoed per maand alleen uit code 5122 van goede runs', k1.ok && k1.vergoed['2026-10'] === 14034 && k1.vergoed['2026-08'] === 14034, k1.vergoed);
    toets('kind laad: alleen de jongste woning', !Object.keys(k1.maanden).some((m) => m.startsWith('2025')), Object.keys(k1.maanden));
    toets('kind laad: geen salaris in de uitvoer', !JSON.stringify(k1).includes('500000') && !JSON.stringify(k1).includes('5000,00'), Object.keys(k1));
    toets('kind laad: nieuw signaal voor 2026-08..2026-10', k1.signaal_nieuw === true && k1.venster === '2026-08..2026-10', k1);
    const k2 = T.kindLaad({ tibber: tp, nu_maand: '2026-11' }, dir);
    toets('kind laad: nog niet gemeld → blijft nieuw', k2.signaal_nieuw === true);
    T.kindLaadGemeld({ venster: k1.venster }, dir);
    const k3 = T.kindLaad({ tibber: tp, nu_maand: '2026-11' }, dir);
    toets('kind laad: na laadgemeld niet nog eens', k3.signaal_nieuw === false && k3.vergelijk.signaal === true, k3);
    toets('kind laad: verkeerd tibberpad geweigerd', T.kindLaad({ tibber: '/etc/passwd' }, dir).ok === false);
  } catch (e) { toets('geen uitzondering', false, String(e && e.stack || e)); }
  d.close(); srv.close();
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
});
JS
