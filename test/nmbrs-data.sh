#!/usr/bin/env bash
# Toetst de Nmbrs-koppeling (wv2797, 8-11-2026): nmbrs-data.js (witte lijst verzoeken en velden, tokens, state, slot, noodkopie, journaal,
# signalen S1–S6) en het Nmbrs-blok van server.js (GET /nmbrs/terug, POST /smal/nmbrs, kluis via de Management-API, signalenbericht).
# Alles tegen een nagebootste identityserver en API op 127.0.0.1 en een nagebootste kluis; ALLEEN VERZONNEN gegevens (geen echte
# personen, BSN 999999990 is een proefnummer). Raakt de pod, de kluis en /opt/data/nmbrs niet.
# Lijst uit het ontwerp (punt 9): state eenmalig/48 u, PKCE, scopes exact (+ intrekken), rotatie vóór de eerste GET, invalid_grant → één
# melding en stil, kluis faalt → noodkopie en herstel, twee rondes → één bezig, verboden endpoint → geweigerd, verboden veld → niet
# opgeslagen, log zonder code/state/token, server-route 404 bij onbekende state; S4 met maand- én uurloon. Kruisproef: veldfilter uit → rood.
# Gebruik: bash test/nmbrs-data.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), http = require('http'), vm = require('vm');
const { spawn } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'nmbrs-'));
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const SCRIPT = path.resolve('nmbrs-data.js');
const T = require(SCRIPT);
const SCOPES = T.SCOPES.join(' ');
// verzonnen gegevens
const BSN = '999999990', IBAN = 'NL00PROE0123456789', GEB = '1981-02-03', MAIL = 'proef@voorbeeld.invalid';
const C1 = 'c0000000-0000-4000-8000-000000000001', D1 = 'd0000000-0000-4000-8000-000000000001', TB = 't0000000-0000-4000-8000-000000000001', VS = 'v0000000-0000-4000-8000-000000000001';
const E1 = 'e0000000-0000-4000-8000-000000000001', E2 = 'e0000000-0000-4000-8000-000000000002', E3 = 'e0000000-0000-4000-8000-000000000003';
const R10 = 'r0000000-0000-4000-8000-000000000010', TAAK = 'a0000000-0000-4000-8000-0000000000aa';
const NU = new Date(), JAAR = NU.getFullYear();
const dag = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';
const SUB = 'sub-proef-0000000000000001';

// ── nagebootste identityserver + API ────────────────────────────────────────────────────────────────────────────────
const M = { log: [], refreshGeldig: new Set(['rt-start-0000000001']), scope: SCOPES, teller: 0, intrek: [], redirect: false, doc202: 1, uren: 80 };
function tok(n) { return 'rt-' + 'x'.repeat(10) + String(n).padStart(8, '0'); }
function pagina(data, req, per) {
  const u = new URL(req.url, 'http://x'), p = Number(u.searchParams.get('pageNumber') || 1), n = per || 100, tp = Math.max(1, Math.ceil(data.length / n));
  return { pagination: { pageNumber: p, pageSize: n, totalPages: tp, totalRecords: data.length, nextPage: p < tp ? 'https://elders.invalid/x' : null }, data: data.slice((p - 1) * n, p * n) };
}
const mw = (id, nr, voor, achter) => ({ employeeId: id, employeeBasicInfo: { employeeNumber: nr, firstName: voor, prefix: null, lastName: achter, employeeType: 'employee',
  socialSecurityNumber: BSN, birthDate: GEB, iban: IBAN, email: MAIL } });
const API = {
  '/api/companies': (q) => pagina([{ companyId: C1, number: '1', name: 'Proefpraktijk BV', debtorId: D1, address: 'Proefstraat 1' }], q),
  '/api/user/info': (q) => pagina([{ name: 'Proef Gebruiker', email: MAIL, debtorId: D1, userId: D1 }], q),
  '/api/debtors': (q) => pagina([{ debtorId: D1, number: '9', name: 'Proefdebiteur' }], q),
  ['/api/companies/' + C1 + '/period']: () => ({ period: { year: JAAR, period: 10 }, periodType: 'month', displayPeriod: 'x' }),
  ['/api/companies/' + C1 + '/employees']: (q) => pagina([mw(E1, 101, 'Anna', 'Proef'), mw(E2, 102, 'Bert', 'Voorbeeld'), mw(E3, 103, 'Cor', 'Toets')], q, 2),
  ['/api/companies/' + C1 + '/employees/employments']: (q) => pagina([E1, E2, E3].map((e) => ({ employeeId: e, employments: [{ employmentId: e.replace('e', 'f'), startDate: '2020-01-01T00:00:00Z', endDate: null }] })), q),
  ['/api/companies/' + C1 + '/employees/contracts']: (q) => pagina([
    { employeeId: E1, contracts: [{ contractId: 'k1', startDate: '2020-01-01T00:00:00Z', endDate: null, indefinite: true, hoursPerWeek: 30.4 }] },
    { employeeId: E2, contracts: [{ contractId: 'k2', startDate: '2020-01-01T00:00:00Z', endDate: null, indefinite: true, hoursPerWeek: 20 }] },
    { employeeId: E3, contracts: [{ contractId: 'k3', startDate: '2025-01-01T00:00:00Z', endDate: dag(30), indefinite: false, hoursPerWeek: 24 }] }], q),
  ['/api/companies/' + C1 + '/employees/schedules']: (q) => pagina([
    { employeeId: E1, schedules: [{ scheduleId: 's1', startDate: '2020-01-01T00:00:00Z', parttimePercentage: 80, week1: { hoursMonday: 8, hoursTuesday: 8, hoursWednesday: 8, hoursThursday: 6.4 }, week2: { hoursMonday: 8, hoursTuesday: 8, hoursWednesday: 8, hoursThursday: 6.4 } }] },
    { employeeId: E2, schedules: [{ scheduleId: 's2', startDate: '2020-01-01T00:00:00Z', parttimePercentage: 50, week1: { hoursMonday: 10, hoursTuesday: 10 }, week2: { hoursMonday: 10, hoursTuesday: 10 } }] },
    { employeeId: E3, schedules: [{ scheduleId: 's3', startDate: '2025-01-01T00:00:00Z', parttimePercentage: 50, week1: { hoursMonday: 10, hoursTuesday: 10 }, week2: { hoursMonday: 10, hoursTuesday: 10 } }] }], q),
  ['/api/companies/' + C1 + '/employees/functions']: (q) => pagina([{ employeeId: E1, functions: [{ functionId: 'fn1', code: 1, description: 'Doktersassistent' }] }], q),
  ['/api/companies/' + C1 + '/employees/departments']: (q) => pagina([{ employeeId: E1, departments: [{ departmentId: 'dp1', code: 2, description: 'Balie' }] }], q),
  ['/api/companies/' + C1 + '/employees/salaries']: (q) => pagina([
    { employeeId: E1, salaries: [{ salaryId: 'sa1', startDate: '2025-01-01T00:00:00Z', type: 'grossFulltimeSalary', value: 4000, salaryTable: { tableId: TB, tableCode: 9, tableName: 'Proeftabel', scale: { scaleId: 'x', scaleCode: 'A', scaleDescription: 'Schaal A' }, step: { stepId: 'y', stepCode: '3', stepDescription: 'Trede 3' } } }] },
    { employeeId: E2, salaries: [{ salaryId: 'sa2', startDate: '2025-01-01T00:00:00Z', type: 'grossHourlyWage', value: 25 }] },
    { employeeId: E3, salaries: [{ salaryId: 'sa3', startDate: '2025-01-01T00:00:00Z', type: 'grossParttimeSalary', value: 1500 }] }], q),
  ['/api/companies/' + C1 + '/employees/leaveBalances']: (q) => pagina([{ employeeId: E1, leaveBalances: [{ leaveGroupId: 'lg1', leaveBalance: 120 }] }], q),
  ['/api/companies/' + C1 + '/salarytables']: (q) => pagina([{ salaryTableId: TB, tableCode: 9, tableName: 'Proeftabel', period: { year: JAAR, period: 1 } }], q),
  ['/api/salarytable/' + TB]: (q) => pagina([{ versionId: VS, version: 1, year: JAAR, month: 1 }, { versionId: 'v-toekomst', version: 2, year: JAAR + 1, month: 1 }], q),
  ['/api/companies/' + C1 + '/salarytable/' + VS + '/content']: (q) => pagina([{ scaleId: 'x', scaleCode: 'A', scaleDescription: 'Schaal A', steps: [{ stepId: 'y', stepCode: '3', stepDescription: 'Trede 3', amountMonth: 4100, amountFourWeeks: 3785, amountWeek: 0, amountHour: 25 }] }], q),
  ['/api/companies/' + C1 + '/runs']: (q) => pagina(new URL(q.url, 'http://x').searchParams.get('year') === String(JAAR) ? [{ payrollRunId: R10, number: 1, description: 'Oktober', year: JAAR, periodStart: 10, periodEnd: 10, createdAt: 'x', type: 'normal', locked: true }] : [], q),
  ['/api/companies/' + C1 + '/runs/' + R10 + '/journalsemployee']: () => ({ taskId: TAAK }),
  ['/api/employees/' + E2 + '/variablehours']: (q) => pagina([{ hourComponentId: 'h1', hourCode: 2100, hourCodeDescription: 'Gewerkte uren', hours: M.uren, comment: 'vrije tekst' }, { hourComponentId: 'h2', hourCode: 3100, hourCodeDescription: 'Onbetaald verlof', hours: 8 }], q),
  ['/api/employees/' + E2 + '/fixedhours']: (q) => pagina([], q),
  ['/api/companies/' + C1 + '/employees/privateInfos']: (q) => pagina([{ employeeId: E1, bsn: BSN }], q),
};
const JOURNAAL = '<?xml version="1.0"?><Journals><Employee><EmployeeNumber>101</EmployeeNumber><BSN>' + BSN + '</BSN><Line><EmployeeNumber>101</EmployeeNumber><Description>Salaris</Description><Amount>3600.00</Amount></Line><Line><EmployeeNumber>101</EmployeeNumber><Description>Salaris</Description><Amount>-100.00</Amount></Line>' +
  '<Line><EmployeeNumber>101</EmployeeNumber><Description>Pensioenpremie werknemer</Description><Amount>-120.00</Amount></Line></Employee>' +
  '<Employee><EmployeeNumber>102</EmployeeNumber><Line><EmployeeNumber>102</EmployeeNumber><Description>Uurloon</Description><Amount>2000.00</Amount></Line><Line><EmployeeNumber>102</EmployeeNumber><Description>IBAN ' + IBAN + '</Description><Amount>1</Amount></Line></Employee></Journals>';
const srv = http.createServer(function (req, res) {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', function () {
    const u = new URL(req.url, 'http://x'), stuur = (st, j, h) => { res.writeHead(st, Object.assign({ 'Content-Type': 'application/json' }, h || {})); res.end(JSON.stringify(j)); };
    M.log.push({ t: Date.now(), m: req.method, p: u.pathname, q: u.search, ua: req.headers['user-agent'], sub: req.headers['x-subscription-key'] || null, auth: String(req.headers.authorization || '').split(' ')[0] });
    if (u.pathname === '/connect/token' || u.pathname === '/connect/revocation') {
      if (req.method !== 'POST') return stuur(405, {});
      const basic = Buffer.from(String(req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
      if (basic !== 'cid-proef-0001:geheim-proef-0001') return stuur(401, { error: 'invalid_client' });
      const f = new URLSearchParams(body);
      if (u.pathname === '/connect/revocation') { M.intrek.push(f.get('token_type_hint')); M.refreshGeldig.delete(f.get('token')); return stuur(200, {}); }
      if (f.get('client_secret')) return stuur(400, { error: 'invalid_request' });   // geheim alleen in de Basic-kop
      if (f.get('grant_type') === 'authorization_code') {
        if (f.get('code') !== 'code-goed' || f.get('redirect_uri') !== T.REDIRECT || !/^[A-Za-z0-9_-]{43,128}$/.test(f.get('code_verifier') || '')) return stuur(400, { error: 'invalid_grant' });
        M.verifier = f.get('code_verifier');
        const n = ++M.teller; M.refreshGeldig.add(tok(n));
        return stuur(200, { access_token: 'at-' + 'a'.repeat(30) + n, refresh_token: tok(n), expires_in: 3600, token_type: 'Bearer', scope: M.scope });
      }
      if (f.get('grant_type') === 'refresh_token') {
        M.gebruikt = f.get('refresh_token');
        if (!M.refreshGeldig.has(M.gebruikt)) return stuur(400, { error: 'invalid_grant' });
        M.refreshGeldig.delete(M.gebruikt);
        const n = ++M.teller; M.refreshGeldig.add(tok(n));
        return stuur(200, { access_token: 'at-' + 'a'.repeat(30) + n, refresh_token: tok(n), expires_in: 3600, scope: M.scope });
      }
      return stuur(400, { error: 'unsupported_grant_type' });
    }
    if (!/^Bearer at-/.test(req.headers.authorization || '') || req.headers['x-subscription-key'] !== SUB) return stuur(401, {});
    if (M.redirect && u.pathname === '/api/companies') { res.writeHead(302, { Location: 'http://127.0.0.1:' + srv.address().port + '/elders' }); return res.end(); }
    if (u.pathname === '/api/documents/' + TAAK) {
      if (M.doc202-- > 0) return stuur(202, 'Document is being processed');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(JOURNAAL);
    }
    if (M.vast403 && /fixedhours$/.test(u.pathname)) return stuur(403, { title: 'Forbidden' });
    if (M.taak503 > 0 && /journalsemployee$/.test(u.pathname)) { M.taak503--; return stuur(503, { title: 'Unavailable' }); }
    const f = API[u.pathname];
    if (f) return stuur(200, f(req));
    if (/^\/api\/employees\/[^/]+\/(fixedhours|variablehours)$/.test(u.pathname)) return stuur(200, pagina([], req));
    stuur(404, { title: 'Not found' });
  });
});

// ── nagebootste kluis ────────────────────────────────────────────────────────────────────────────────────────────────
const K = { rij: { client_id: 'cid-proef-0001', client_secret: 'geheim-proef-0001', sub: SUB }, zetFout: 0, zetten: [], leesFout: false };
let ENV, KSCRIPT = SCRIPT;
function kluisDeps(dir, extra) {
  return Object.assign({ dir: dir, wacht: async () => {},
    kluisLees: async () => { if (K.leesFout) throw new Error('weg'); return Object.assign({ refresh: '' }, K.rij); },
    kluisZet: async (w) => { K.zetten.push({ t: Date.now(), w: w }); if (K.zetFout > 0) { K.zetFout--; throw new Error('kluis weg'); } K.rij.refresh = w; return sha(w); },
    kind: (o, i) => kindEcht(o, i, dir) }, extra || {});
}
function kindEcht(opdracht, invoer, dir) {
  return new Promise(function (klaar) {
    const k = spawn(process.execPath, ['--no-warnings', KSCRIPT, opdracht], { env: Object.assign({}, ENV, dir ? { NMBRS_DIR: dir } : {}), stdio: ['pipe', 'pipe', 'pipe'] });
    let uit = '', fout = '';
    k.stdout.on('data', (c) => uit += c); k.stderr.on('data', (c) => fout += c);
    k.on('close', function (code) { let j = null; try { j = JSON.parse(uit.trim().split('\n').pop()); } catch (e) {} klaar({ code: code, j: j, stderr: fout }); });
    k.stdin.end(JSON.stringify(invoer));
  });
}
const sqlite = (dir) => { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(path.join(dir, 'nmbrs.' + 'sqlite')); };
function ruweBytes(dir) { return fs.readdirSync(dir).map((f) => { try { return fs.readFileSync(path.join(dir, f)).toString('latin1'); } catch (e) { return ''; } }).join('\n'); }

srv.listen(0, '127.0.0.1', async function () {
  const BASIS = 'http://127.0.0.1:' + srv.address().port;
  const DIR = path.join(W, 'nmbrs');
  ENV = { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', NMBRS_DIR: DIR, NMBRS_AUTH_BASIS: BASIS, NMBRS_API_BASIS: BASIS, NMBRS_PAUZE_MS: '0' };
  process.env.NMBRS_AUTH_BASIS = BASIS; process.env.NMBRS_API_BASIS = BASIS;
  delete require.cache[SCRIPT];
  const TM = require(SCRIPT);
  try {
    // 1. witte lijst van verzoeken
    const weigert = (m, u) => { try { TM.verzoekToets(m, u); return false; } catch (e) { return e.reden === 'pad'; } };
    toets('POST naar de API geweigerd', weigert('POST', BASIS + '/api/companies'));
    toets('GET op het tokenendpoint geweigerd', weigert('GET', BASIS + '/connect/token'));
    toets('PUT/DELETE/PATCH geweigerd', weigert('PUT', BASIS + '/api/companies') && weigert('DELETE', BASIS + '/api/companies') && weigert('PATCH', BASIS + '/api/companies'));
    const c = BASIS + '/api/companies/' + C1;
    toets('verboden endpoints geweigerd (privateInfos, personalinfo, addresses, bankaccounts, children, partner, absences)',
      ['privateInfos', 'personalinfo', 'addresses', 'bankaccounts', 'children', 'partner', 'absences', 'wagetaxsettings', 'svwsettings'].every((x) => weigert('GET', c + '/employees/' + x)));
    toets('loonstroken, SEPA en documentmappen geweigerd', weigert('GET', c + '/runs/' + R10 + '/payslips?year=2026') && weigert('GET', c + '/runs/' + R10 + '/sepa?year=2026') &&
      weigert('GET', BASIS + '/api/employees/' + E1 + '/payslipperperiod') && weigert('GET', BASIS + '/api/employees/' + E1 + '/documents/folders') && weigert('GET', c + '/bankaccounts'));
    toets('document zonder eigen journaaltaak geweigerd', weigert('GET', BASIS + '/api/documents/' + TAAK));
    toets('andere host geweigerd', weigert('GET', 'https://elders.invalid/api/companies') && weigert('POST', 'https://elders.invalid/connect/token'));
    toets('onbekende queryparameter geweigerd', weigert('GET', c + '/employees?employeeType=x') && weigert('GET', c + '/employees?pageSize=500') && weigert('GET', c + '/runs?year=1999'));
    toets('toegestane lijstvraag mag', !weigert('GET', c + '/employees/salaries?pageNumber=2&pageSize=100') && !weigert('GET', BASIS + '/api/employees/' + E2 + '/variablehours?year=2026&period=10'));
    toets('pad met .. geweigerd', weigert('GET', BASIS + '/api/companies/../connect/token'));
    const src = fs.readFileSync(SCRIPT, 'utf8').split('\n').filter((r) => !/^\s*(\*|\/\/)/.test(r)).join('\n');
    toets('één fetch in nmbrs-data.js, met redirect error', (src.match(/\bfetch\(/g) || []).length === 1 && /redirect: 'error'/.test(src));
    toets('geen eigen netwerk- of procesmodule', !/require\('(node:)?(http|https|net|tls|child_process|dgram)'\)/.test(src));
    toets('toetsbasis alleen 127.0.0.1', (() => { try { require('child_process').execFileSync(process.execPath, [SCRIPT, 'stand'], { env: { PATH: process.env.PATH, NMBRS_API_BASIS: 'http://10.0.0.1:80', NMBRS_DIR: path.join(W, 'x') }, input: '{}', stdio: 'pipe' }); return false; } catch (e) { return true; } })());
    toets('uitrol.sh en Dockerfile: nmbrs-data.js gaat mee in de release', /^RELEASE_OPTIONEEL="[^"]*\bnmbrs-data\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')) && /COPY nmbrs-data\.js \/app\/release-bootstrap\/nmbrs-data\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
    toets('scopes exact: gelijk ja, ontbrekend nee, extra nee', TM.scopesExact(T.SCOPES.slice()) && !TM.scopesExact(T.SCOPES.slice(1)) && !TM.scopesExact(T.SCOPES.concat(['employee.bankaccount.read'])));
    toets('geen schrijf-, bank- of documentscope gevraagd', !T.SCOPES.some((s) => !/\.read$/.test(s) && s !== 'offline_access') && !T.SCOPES.some((s) => /bankaccount|document|payrollsettings\.read$/.test(s) && s !== 'company.payrollsettings.read'));

    // 2. link en state
    const l = TM.linkMaak(DIR, 'cid-proef-0001');
    const lu = new URL(l.url), st = lu.searchParams.get('state');
    toets('link: authorize-endpoint, S256, exacte scopes, redirect', lu.origin + lu.pathname === 'https://identityservice.nmbrs.com/connect/authorize' && lu.searchParams.get('code_challenge_method') === 'S256' &&
      lu.searchParams.get('scope') === SCOPES && lu.searchParams.get('redirect_uri') === 'https://bank.socev.dev/nmbrs/terug' && /^[0-9a-f]{64}$/.test(st));
    toets('states.json 600 en zonder de state zelf', (fs.statSync(path.join(DIR, 'states.json')).mode & 0o777) === 0o600 && fs.readFileSync(path.join(DIR, 'states.json'), 'utf8').indexOf(st) < 0);
    fs.chmodSync(DIR, 0o755); TM.slotNeem(DIR); TM.slotLos(DIR);
    toets('map 700, ook als hij ruimer bestond', (fs.statSync(DIR).mode & 0o777) === 0o700);
    toets('state open; onbekende dicht', TM.stateOpen(DIR, st) && !TM.stateOpen(DIR, 'a'.repeat(64)));
    const st2 = new URL(TM.linkMaak(DIR, 'cid-proef-0001').url).searchParams.get('state');
    const s = JSON.parse(fs.readFileSync(path.join(DIR, 'states.json'), 'utf8')); s[sha(st2)].sinds = new Date(Date.now() - 49 * 3600000).toISOString(); fs.writeFileSync(path.join(DIR, 'states.json'), JSON.stringify(s));
    toets('state na 48 uur dicht', !TM.stateOpen(DIR, st2));

    // 3. terugkeer: verkeerde scope → ingetrokken, niets bewaard
    M.scope = T.SCOPES.slice(0, -1).join(' ');
    let u = await TM.terug(kluisDeps(DIR), st, 'code-goed', '');
    toets('ontbrekende scope → geweigerd, ingetrokken (refresh + access), niets in de kluis', u.soort === 'scope' && !K.rij.refresh && !TM.noodLees(DIR) && M.intrek.join(',') === 'refresh_token,access_token', [u, M.intrek]);
    toets('state na weigering verbruikt', !TM.stateOpen(DIR, st));
    M.scope = SCOPES + ' employee.bankaccount.read'; M.intrek = [];
    u = await TM.terug(kluisDeps(DIR), new URL(TM.linkMaak(DIR, 'cid-proef-0001').url).searchParams.get('state'), 'code-goed', '');
    toets('extra scope → geweigerd en ingetrokken', u.soort === 'scope' && !K.rij.refresh && M.intrek.length === 2, u);
    M.scope = SCOPES;
    const lu4 = new URL(TM.linkMaak(DIR, 'cid-proef-0001').url), st4 = lu4.searchParams.get('state');
    u = await TM.terug(kluisDeps(DIR), st4, 'code-goed', '');
    toets('toestemming → gekoppeld, refresh in de kluis, noodkopie weg', u.soort === 'gekoppeld' && K.rij.refresh === tok(M.teller) && !TM.noodLees(DIR), u);
    toets('PKCE: verifier hoort bij de challenge uit de link (S256)', crypto.createHash('sha256').update(M.verifier).digest('base64url') === lu4.searchParams.get('code_challenge'));
    toets('client-secret alleen in de Basic-kop', M.log.filter((x) => x.p === '/connect/token').every((x) => x.auth === 'Basic'));
    const nog = await TM.terug(kluisDeps(DIR), st4, 'code-goed', '');
    toets('state hergebruik → 404', nog.status === 404 && nog.soort === 'dicht', nog);
    toets('geen GET op de API tijdens de terugkeer', !M.log.some((x) => x.p.indexOf('/api/') === 0));

    // 4. ronde: rotatie vóór gebruik, opslag alleen witte lijst
    K.zetten = []; M.log = [];
    const oud = K.rij.refresh;
    let r = await TM.ronde(kluisDeps(DIR), 'ronde');
    const eersteGet = M.log.find((x) => x.m === 'GET');
    toets('ronde ok (1 bedrijf, 3 medewerkers via 2 pagina\'s, 1 loonrun, 1 journaal)', r.ok === true && r.bedrijven === 1 && r.medewerkers === 3 && r.loonruns === 1 && r.journalen === 1, r);
    toets('tabellen (wv2798): 1 gelijst, 0 alleen verwezen, 1 opgeslagen', r.tabellen && r.tabellen.gelijst === 1 && r.tabellen.verwezen === 0 && r.tabellen.opgeslagen === 1, r.tabellen);
    toets('rotatie: nieuw token in de kluis vóór de eerste GET', r.geroteerd === true && K.zetten.length === 1 && eersteGet && K.zetten[0].t <= eersteGet.t && K.rij.refresh !== oud, K.zetten.length);
    toets('elke API-vraag met X-Subscription-Key, het tokenendpoint zonder', M.log.filter((x) => x.p.indexOf('/api/') === 0).every((x) => x.sub === SUB) && M.log.filter((x) => x.p.indexOf('/connect/') === 0).every((x) => !x.sub));
    toets('verboden endpoints nooit aangeroepen', !M.log.some((x) => /privateInfos|personalinfo|addresses|bankaccounts|absences|payslip|children|partner/i.test(x.p)), M.log.map((x) => x.p));
    toets('document na 202 opnieuw gevraagd (taak uit journalsemployee)', M.log.filter((x) => x.p === '/api/documents/' + TAAK).length === 2);
    toets('volgt geen nextPage-adres van de server (alleen eigen pageNumber)', M.log.filter((x) => x.p === '/api/companies/' + C1 + '/employees').map((x) => new URL('http://x' + x.q).searchParams.get('pageNumber')).join(',') === '1,2');
    toets('nmbrs.sqlite 600, access token niet op schijf', (fs.statSync(path.join(DIR, 'nmbrs.sqlite')).mode & 0o777) === 0o600 && ruweBytes(DIR).indexOf('at-aaaa') < 0);
    const ruw = ruweBytes(DIR);
    toets('BSN, IBAN, geboortedatum, e-mail en adres nergens opgeslagen', [BSN, IBAN, GEB, MAIL, 'Proefstraat', 'vrije tekst', 'Proef Gebruiker'].every((x) => ruw.indexOf(x) < 0), [BSN, IBAN, GEB, MAIL, 'Proefstraat', 'vrije tekst'].filter((x) => ruw.indexOf(x) >= 0));
    let d = sqlite(DIR);
    const m1 = JSON.parse(d.prepare('select data from medewerker where id = ?').get(E1).data);
    toets('medewerker: alleen personeelsnummer en naam', JSON.stringify(Object.keys(m1).sort()) === JSON.stringify(['employeeNumber', 'firstName', 'lastName', 'prefix']), m1);
    const soorten = d.prepare('select soort, count(*) as n from historie group by soort order by soort').all().map((x) => x.soort + ':' + x.n).join(',');
    toets('historie per soort opgeslagen', soorten === 'afdeling:1,contract:3,dienstverband:3,functie:1,rooster:3,salaris:3,verlofsaldo:1', soorten);
    const regels = d.prepare('select medewerker, soort, bedrag from loonrun_regel order by medewerker, soort').all().map((x) => x.medewerker.slice(-1) + ':' + x.soort + ':' + x.bedrag).join(',');
    toets('journaal: alleen bruto/pensioen per medewerker, correctie verlaagt (3600 − 100), geen IBAN-regel', regels === '1:bruto:3500,1:pensioen:120,2:bruto:2000', regels);
    const dc = TM.journaalRegels(TM.xmlBoom('<J><L><EmployeeNumber>5</EmployeeNumber><Description>Salaris</Description><Debit>100</Debit><Credit>30</Credit></L></J>'));
    toets('journaal: debet − credit met teken (review MOET 2)', dc.length === 1 && dc[0].bedrag === 70 && dc[0].soort === 'bruto', dc);
    const uren = d.prepare('select uren from uren where medewerker = ?').get(E2);
    toets('uurloner: betaalde uren van de periode (onbetaald telt niet)', uren && uren.uren === 80, uren);
    toets('salaristabel: alleen de geldige versie, trede A/3', d.prepare('select count(*) as n from salaristabel').get().n === 1 && !!d.prepare("select 1 from salaristrede where schaal = 'A' and trede = '3'").get());
    d.close();
    // tweede ronde: journaal niet opnieuw. wv2798: de bedrijfslijst geeft de tabel nu niet (zoals de CAO-tabel bij Nmbrs op 9-11-2026);
    // de tabel waar het salaris naar verwijst moet toch binnenkomen, anders rekent S1 nooit
    const lijstOud = API['/api/companies/' + C1 + '/salarytables'];
    API['/api/companies/' + C1 + '/salarytables'] = (q) => pagina([], q);
    d = sqlite(DIR); d.exec('delete from salaristabel; delete from salaristrede'); d.close();
    M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    API['/api/companies/' + C1 + '/salarytables'] = lijstOud;
    toets('tweede ronde: journaal van dezelfde loonrun niet opnieuw', r.ok === true && !M.log.some((x) => /journalsemployee|documents/.test(x.p)), r);
    d = sqlite(DIR);
    toets('tabel niet in de bedrijfslijst maar wel verwezen vanuit het salaris → toch opgehaald (wv2798)', r.tabellen && r.tabellen.gelijst === 0 && r.tabellen.verwezen === 1 && r.tabellen.opgeslagen === 1 &&
      !!d.prepare("select 1 from salaristrede where schaal = 'A' and trede = '3'").get() && JSON.parse(d.prepare('select data from salaristabel').get().data).tableName === 'Proeftabel', r.tabellen);
    d.close();

    // 5. signalen
    let sg = await kindEcht('signalen', {}, DIR);
    toets('signalen standaard uit: niets nieuw, wel berekend', sg.j && sg.j.ok && sg.j.nieuw.length === 0 && sg.j.totaal >= 4, sg.j);
    await kindEcht('instel', { signalen_aan: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S9'] }, DIR);
    sg = await kindEcht('signalen', { vault: [{ entiteit: 'TG', naam: 'Anna Proef', namen: ['Anna Proef'], actief: true }, { entiteit: 'TG', naam: 'Dirk Weg', namen: ['Dirk Weg'], actief: true }] }, DIR);
    const per = (x) => (sg.j.signalen || []).filter((s) => s.soort === x).map((s) => s.naam).sort().join(',');
    toets('S1: salaris onder schaal A trede 3', per('S1') === 'Anna Proef', sg.j.signalen);
    d = sqlite(DIR); d.prepare("update historie set data = json_set(data, '$.value', 0) where medewerker = ? and soort = 'salaris'").run(E1); d.close();
    const sg0 = await kindEcht('signalen', {}, DIR);
    toets('S1: salarisbedrag 0 (geen eigen bedrag in Nmbrs) is geen signaal (wv2798)', !(sg0.j.signalen || []).some((s) => s.soort === 'S1'), sg0.j.signalen);
    d = sqlite(DIR); d.prepare("update historie set data = json_set(data, '$.value', 4000) where medewerker = ? and soort = 'salaris'").run(E1); d.close();
    toets('S2: contract loopt binnen 6 weken af zonder opvolger', per('S2') === 'Cor Toets');
    toets('S3: roosteruren wijken af van contracturen', per('S3') === 'Cor Toets');
    toets('S4 maandloon: 3500 tegen 4000 × 80 % = 3200 → signaal; uurloon 25 × 80 u = 2000 → geen', per('S4') === 'Anna Proef', sg.j.signalen.filter((s) => s.soort === 'S4'));
    toets('S6 zonder koppeltabel: niets', per('S6') === '');
    toets('signaaltekst zonder bedragen', !sg.j.signalen.concat(sg.j.nieuw).map((s) => s.tekst).join('|').match(/3500|3200|4000|4100|€/), sg.j.signalen.map((s) => s.tekst));
    toets('aan-lijst: alleen S1–S6', JSON.stringify(sg.j.aan) === JSON.stringify(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']));
    // S4 uurloon met minder uren
    d = sqlite(DIR); d.prepare('update uren set uren = 70 where medewerker = ?').run(E2); d.close();
    sg = await kindEcht('signalen', {}, DIR);
    toets('S4 uurloon: 2000 tegen 25 × 70 u = 1750 → signaal', per('S4') === 'Anna Proef,Bert Voorbeeld', sg.j.signalen.filter((s) => s.soort === 'S4'));
    // S4 met een mutatie in de periode: geen signaal
    d = sqlite(DIR); d.prepare("update historie set data = json_set(data, '$.startDate', ?) where medewerker = ? and soort = 'rooster'").run(JAAR + '-10-01T00:00:00Z', E1); d.close();
    sg = await kindEcht('signalen', {}, DIR);
    toets('S4: mutatie in de periode → geen signaal', per('S4') === 'Bert Voorbeeld');
    // S5: vakantiegeld in juni bij de één, niet bij de ander
    d = sqlite(DIR);
    d.prepare("insert into loonrun (id, bedrijf, data, journaal) values ('r6', ?, ?, 'ok:2')").run(C1, JSON.stringify({ payrollRunId: 'r6', year: JAAR, periodStart: 6, periodEnd: 6 }));
    d.prepare("insert into loonrun_regel values ('r6', ?, 'bruto', 3200), ('r6', ?, 'vakantiegeld', 2900), ('r6', ?, 'bruto', 2000)").run(E1, E1, E2);
    d.close();
    sg = await kindEcht('signalen', {}, DIR);
    toets('S5: geen vakantiegeld bij Bert (wel bij Anna)', per('S5') === 'Bert Voorbeeld', sg.j.signalen.filter((s) => s.soort === 'S5'));
    // koppeltabel + S6
    const kp = await kindEcht('koppel', { bedrijf: C1, entiteit: 'TG' }, DIR);
    const kpFout = await kindEcht('koppel', { bedrijf: C1, entiteit: 'tg; drop' }, DIR);
    toets('koppel: bedrijf → entiteit; vreemde entiteit geweigerd', kp.j && kp.j.ok && kpFout.j && kpFout.j.ok === false);
    // wv2800: stand voor OVIS POT — alleen het aan POT gekoppelde bedrijf, nooit een bedrag (value), BSN, IBAN, geboortedatum of mail
    const potGeen = await kindEcht('pot', {}, DIR);
    toets('pot: zonder POT-koppeling geen stand', potGeen.j && potGeen.j.ok === false && potGeen.j.reden === 'koppeling', potGeen.j);
    await kindEcht('koppel', { bedrijf: C1, entiteit: 'POT' }, DIR);
    const pot = await kindEcht('pot', {}, DIR);
    const potT = JSON.stringify(pot.j || {});
    const potM = pot.j && pot.j.ok && pot.j.stand.medewerkers.find((x) => x.id === E1);
    toets('pot: stand met dienst, rooster en schaal/trede per datum', !!potM && potM.salaris.length === 1 && potM.salaris[0].schaal === 'A' && potM.salaris[0].trede === 3 && potM.salaris[0].begin === '2025-01-01' && /^\d{4}-\d{2}-\d{2}$/.test(pot.j.stand.peil), pot.j);
    toets('pot: geen bedrag, BSN, IBAN, geboortedatum of mail', !/:(4000|1500|25)[,}]/.test(potT) && potT.indexOf(BSN) < 0 && potT.indexOf(IBAN) < 0 && potT.indexOf(GEB) < 0 && potT.indexOf(MAIL) < 0 && !/"value"/.test(potT), potT.slice(0, 300));
    await kindEcht('koppel', { bedrijf: C1, entiteit: 'TG' }, DIR);
    sg = await kindEcht('signalen', { vault: [{ entiteit: 'TG', naam: 'Anna Proef', namen: ['Anna Proef'], actief: true }, { entiteit: 'TG', naam: 'Dirk Weg', namen: ['Dirk Weg'], actief: true }, { entiteit: 'GH', naam: 'Elders', namen: ['Elders'], actief: true }] }, DIR);
    toets('S6: Bert en Cor zonder pagina, pagina Dirk zonder Nmbrs; niet-gekoppelde entiteit telt niet', per('S6') === 'Bert Voorbeeld,Cor Toets,Dirk Weg', sg.j.signalen.filter((s) => s.soort === 'S6'));
    const g1 = await kindEcht('gemeld', { sleutels: sg.j.nieuw.map((x) => x.sleutel) }, DIR);
    const sg2 = await kindEcht('signalen', { vault: [{ entiteit: 'TG', naam: 'Anna Proef', namen: ['Anna Proef'], actief: true }, { entiteit: 'TG', naam: 'Dirk Weg', namen: ['Dirk Weg'], actief: true }] }, DIR);
    toets('na gemeld: dezelfde signalen niet opnieuw nieuw', g1.j.gemeld === sg.j.nieuw.length && sg2.j.nieuw.length === 0 && sg2.j.signalen.length === sg.j.signalen.length, [g1.j, sg2.j.nieuw]);
    // wv2798: S6 kijkt eerst naar koppeling.json (getrouwde naam in de vault, meisjesnaam in Nmbrs) en naar bewust_niet (DGA/familie)
    fs.writeFileSync(path.join(DIR, 'koppeling.json'), JSON.stringify({ medewerkers: { [E2]: '10_Zakelijk/Tolgaarde/Medewerkers/Bert Getrouwd-Voorbeeld - assistent.md' }, bewust_niet: [E3, 'geen-id'] }));
    const sg6 = await kindEcht('signalen', { vault: [{ entiteit: 'TG', naam: 'Anna Proef', namen: ['Anna Proef'], actief: true }, { entiteit: 'TG', naam: 'Bert Getrouwd-Voorbeeld - assistent', namen: ['Bert Getrouwd-Voorbeeld - assistent'], actief: true }, { entiteit: 'TG', naam: 'Dirk Weg', namen: ['Dirk Weg'], actief: true }] }, DIR);
    const s6 = (sg6.j.signalen || []).filter((s) => s.soort === 'S6').map((s) => s.naam).sort().join(',');
    toets('S6 met koppeling: Bert gekoppeld (andere naam), Cor bewust niet → alleen pagina Dirk', s6 === 'Dirk Weg', sg6.j.signalen.filter((s) => s.soort === 'S6'));
    // review wv2798 MOET 1/2: koppeling naar een dossier dat niet (of alleen bij een andere entiteit) in de vault staat telt niet
    const sg6b = await kindEcht('signalen', { vault: [{ entiteit: 'TG', naam: 'Anna Proef', namen: ['Anna Proef'], actief: true }, { entiteit: 'GH', naam: 'Bert Getrouwd-Voorbeeld - assistent', namen: ['Bert Getrouwd-Voorbeeld - assistent'], actief: true }] }, DIR);
    const s6b = (sg6b.j.signalen || []).filter((s) => s.soort === 'S6').map((s) => s.naam).sort().join(',');
    toets('S6: gekoppeld dossier ontbreekt in de vault (of staat bij een andere entiteit) → Bert toch gemeld', s6b === 'Bert Voorbeeld', sg6b.j.signalen.filter((s) => s.soort === 'S6'));
    fs.unlinkSync(path.join(DIR, 'koppeling.json'));
    // persoon
    const ps = await kindEcht('persoon', { naam: 'anna proef' }, DIR);
    const p0 = ps.j && ps.j.treffers && ps.j.treffers[0] || {};
    toets('persoon: functie, uren, schaal, trede, ingangsdatum; geen BSN of bedrag', p0.functie === 'Doktersassistent' && p0.schaal === 'A' && p0.trede === '3' && p0.contract.uren_per_week === 30.4 && p0.ingangsdatum_salaris === '2025-01-01' &&
      JSON.stringify(ps.j).indexOf(BSN) < 0 && JSON.stringify(ps.j).indexOf('4000') < 0, ps.j);
    const pk = await kindEcht('persoon', { naam: 'pr' }, DIR);
    toets('persoon: te korte naam geweigerd', pk.j && pk.j.ok === false);

    // 6. invalid_grant → één melding, daarna stil
    M.log = [];
    M.refreshGeldig.delete(K.rij.refresh);
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('invalid_grant → reden grant, één tokenverzoek, geen GET', r.ok === false && r.reden === 'grant' && M.log.filter((x) => x.p === '/connect/token').length === 1 && !M.log.some((x) => x.m === 'GET'), r);
    M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('dode koppeling onthouden: volgende ronde vraagt Nmbrs niets', r.ok === false && r.reden === 'dood' && !M.log.length && TM.doodLees(DIR), r);
    const lu5 = new URL(TM.linkMaak(DIR, 'cid-proef-0001').url);
    u = await TM.terug(kluisDeps(DIR), lu5.searchParams.get('state'), 'code-goed', '');
    toets('nieuwe toestemming wist de dode koppeling', u.soort === 'gekoppeld' && !TM.doodLees(DIR), u);

    // 7. kluis faalt na refresh → noodkopie, geen lezen; volgende ronde herstelt
    M.log = []; K.zetFout = 3;
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    const nood = TM.noodLees(DIR);
    toets('kluis faalt 3× → noodkopie (600), reden kluis, geen GET', r.ok === false && r.reden === 'kluis' && r.nood === true && nood && (fs.statSync(path.join(DIR, 'refresh.nood')).mode & 0o777) === 0o600 && !M.log.some((x) => x.m === 'GET'), r);
    M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('volgende ronde: noodkopie eerst in de kluis, daarmee ververst, daarna weg', r.ok === true && r.nood_hersteld === true && M.gebruikt === nood.refresh && !TM.noodLees(DIR) && K.rij.refresh === tok(M.teller), r);
    // proces stopt vóór de kluis: het kind schreef de noodkopie al
    const kk = await kindEcht('ververs', { client_id: 'cid-proef-0001', client_secret: 'geheim-proef-0001', refresh: K.rij.refresh }, DIR);
    toets('kind schrijft de noodkopie vóór zijn antwoord', kk.j && kk.j.ok === true && TM.noodLees(DIR) && TM.noodLees(DIR).refresh === kk.j._refresh);
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('na een afgebroken ronde: herstel uit de noodkopie', r.ok === true && r.nood_hersteld === true && M.gebruikt === kk.j._refresh, r);

    // 8. twee rondes tegelijk; oud slot; redirect; kluis vooraf weg; subscription key ontbreekt
    const [a1, a2] = await Promise.all([TM.ronde(kluisDeps(DIR), 'ronde'), TM.ronde(kluisDeps(DIR), 'ronde')]);
    toets('twee rondes tegelijk → één stopt (bezig)', [a1, a2].filter((x) => x.reden === 'bezig').length === 1 && [a1, a2].filter((x) => x.ok === true).length === 1, [a1.reden, a2.reden]);
    fs.writeFileSync(path.join(DIR, 'ronde.lock'), JSON.stringify({ pid: 999999, sinds: new Date(Date.now() - 40 * 60000).toISOString() }));
    toets('oud slot van een dood proces wordt opgeruimd', TM.slotNeem(DIR) === true); TM.slotLos(DIR);
    M.redirect = true; M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('redirect → ronde faalt, doel niet opgevraagd', r.ok === false && !M.log.some((x) => x.p === '/elders'), r);
    M.redirect = false;
    K.leesFout = true; M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('kluis vooraf onbereikbaar → geen refresh', r.ok === false && r.reden === 'kluis' && !M.log.length, r);
    K.leesFout = false;
    const subBewaard = K.rij.sub; delete K.rij.sub; M.log = [];
    r = await TM.ronde(kluisDeps(DIR), 'ronde');
    toets('subscription key ontbreekt → reden sleutel, niets ververst', r.ok === false && r.reden === 'sleutel' && !M.log.length, r);
    K.rij.sub = subBewaard;

    // 9. peil: bedrijven, eindpunten, veldnamen (namen, geen waarden), journaalelementen
    r = await TM.ronde(kluisDeps(DIR), 'peil');
    const pj = JSON.stringify(r);
    toets('peil: bedrijven, statussen per endpoint, veldnamen zonder waarden', r.ok === true && r.bedrijven && r.bedrijven[0].naam === 'Proefpraktijk BV' && r.eindpunten['/api/companies/{id}/employees'] === 200 &&
      r.veldnamen['/api/companies/{id}/employees'].indexOf('data[].employeeBasicInfo.socialSecurityNumber') >= 0 && pj.indexOf(BSN) < 0 && pj.indexOf(MAIL) < 0 && pj.indexOf(IBAN) < 0 && r.gebruiker.profielen === 1, r.eindpunten);

    // 9b. review-punten
    fs.writeFileSync(path.join(DIR, 'ronde.lock'), '');
    toets('leeg (vers) slot blijft staan: geen tweede ronde (review MOET 1)', TM.slotNeem(DIR) === false);
    const oudT = (Date.now() - 40 * 60000) / 1000; fs.utimesSync(path.join(DIR, 'ronde.lock'), oudT, oudT);
    toets('leeg slot ouder dan 30 min wordt opgeruimd', TM.slotNeem(DIR) === true); TM.slotLos(DIR);
    d = sqlite(DIR);
    d.prepare("insert into salaristabel values (?, ?, 'v-oud', ?)").run(C1, TB, JSON.stringify({ versie: { versionId: 'v-oud', version: 0, year: JAAR - 1, month: 1 } }));
    d.prepare("insert into salaristrede values ('v-oud', 'A', '3', ?)").run(JSON.stringify({ stepCode: '3', amountMonth: 3900 }));
    d.prepare("insert into salaristabel values (?, ?, 'v-later', ?)").run(C1, TB, JSON.stringify({ versie: { versionId: 'v-later', version: 9, year: JAAR + 1, month: 1 } }));
    d.prepare("insert into salaristrede values ('v-later', 'A', '3', ?)").run(JSON.stringify({ stepCode: '3', amountMonth: 3000 }));
    d.close();
    sg = await kindEcht('signalen', {}, DIR);
    toets('S1 kiest de versie die nu geldt, niet een oude of toekomstige (review MOET 3)', per('S1') === 'Anna Proef', sg.j.signalen.filter((x) => x.soort === 'S1'));
    const D4 = path.join(W, 'nmbrs-uren'); M.vast403 = true; M.doc202 = 0;
    let k4 = await kindEcht('ronde', { access: 'at-' + 'a'.repeat(30) + '1', sub: SUB }, D4);
    M.vast403 = false;
    d = sqlite(D4); const u4 = d.prepare('select count(*) as n from uren').get().n; d.close();
    toets('uren: vaste uren 403 → geen (half) urentotaal opgeslagen (review MOET 4)', k4.j && k4.j.ok === true && u4 === 0, [k4.j && k4.j.reden, u4]);
    const D5 = path.join(W, 'nmbrs-503'); M.taak503 = 5; M.doc202 = 0;
    let k5 = await kindEcht('ronde', { access: 'at-' + 'a'.repeat(30) + '1', sub: SUB }, D5);
    d = sqlite(D5); const j5 = d.prepare('select journaal from loonrun').get().journaal; d.close();
    toets('journaal 503 → opnieuw (niet blijvend dicht)', k5.j && k5.j.ok === true && /^opnieuw:taak:503:1$/.test(j5), [k5.j && k5.j.reden, j5]);
    k5 = await kindEcht('ronde', { access: 'at-' + 'a'.repeat(30) + '1', sub: SUB }, D5);
    d = sqlite(D5); const j5b = d.prepare('select journaal from loonrun').get().journaal; d.close();
    toets('volgende ronde haalt het journaal alsnog (review MOET 5)', /^ok:/.test(j5b) && k5.j.journalen === 1, j5b);

    // 10. kruisproef: veldfilter uit → de BSN-toets moet rood worden
    const KRUIS = path.join(W, 'kruis'); fs.mkdirSync(KRUIS);
    const kopie = path.join(KRUIS, 'nmbrs-data.js');
    const ksrc = fs.readFileSync(SCRIPT, 'utf8').replace('function kies(o, velden) {', 'function kies(o, velden) { if (o && typeof o === "object") return JSON.parse(JSON.stringify(o));');
    fs.writeFileSync(kopie, ksrc);
    KSCRIPT = kopie;
    const KDIR = path.join(W, 'nmbrs-kruis');
    const kz = await kindEcht('ronde', { access: 'at-' + 'a'.repeat(30) + '1', sub: SUB }, KDIR);
    KSCRIPT = SCRIPT;
    toets('kruisproef: zonder veldfilter staat de BSN wel in de databank (toets kan rood)', kz.j && kz.j.ok === true && ruweBytes(KDIR).indexOf(BSN) >= 0, kz.j);

    // 11. server.js: route, smal, kluis via de Management-API, logs zonder code/state/token, signalenbericht
    const ssrc = fs.readFileSync('server.js', 'utf8');
    const b1 = ssrc.indexOf('// ── wv2797: Nmbrs'), b2 = ssrc.indexOf('// ── einde Nmbrs ──');
    const k1 = ssrc.indexOf('function smalKind('), k2 = ssrc.indexOf('async function smalSbRpc(');
    toets('server.js: Nmbrs-blok, route, smal, ronde en health aangehaakt', b1 > 0 && b2 > b1 && /if \(nmbrsIsPad\(req\)\) return nmbrsTerug\(req, res\);/.test(ssrc) && /actie === 'nmbrs'\) return nmbrsSmal\(d, wie\)/.test(ssrc) &&
      /\bnmbrs: 20\b/.test(ssrc) && /nmbrsNaBankRonde\(\);/.test(ssrc) && /nmbrs: nmbrsInfo\(\)/.test(ssrc) && /\n  'nmbrs',\s+\/\/ wv2797/.test(ssrc));
    const DIR2 = path.join(W, 'nmbrs2');
    const logs = [], berichten = [], kluis = { nmbrs_client_id: 'cid-proef-0001', nmbrs_client_secret: 'geheim-proef-0001', nmbrs_subscription_key: SUB };
    let mgmt = 0;
    fs.mkdirSync(path.join(W, '00_Systeem', 'Meldingen'), { recursive: true });
    fs.writeFileSync(path.join(W, '00_Systeem', 'Meldingen', 'machinekamer.md'), '# box\n\n## [direct] 2026-11-01 10:00 — oude rij\n- status: open\n');
    fs.mkdirSync(path.join(W, '10_Zakelijk', 'Tolgaarde', 'Medewerkers'), { recursive: true });
    fs.writeFileSync(path.join(W, '10_Zakelijk', 'Tolgaarde', 'Medewerkers', 'Anna Proef.md'), '---\ntype: medewerker\nentiteit_id: TG\nstatus: actief\naliases: ["Anna Proef", "A. Proef"]\n---\n# Anna\n');
    fs.writeFileSync(path.join(W, '10_Zakelijk', 'Tolgaarde', 'Medewerkers', 'Overzicht.md'), '---\ntype: index\n---\n');
    const g = { require, fs, path, crypto, Buffer, console, URL, URLSearchParams, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, spawn, VAULT: W, __dirname: process.cwd(),
      process: { env: { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', NMBRS_DIR: DIR2, NMBRS_SCRIPT: SCRIPT, NMBRS_AUTH_BASIS: BASIS, NMBRS_API_BASIS: BASIS, NMBRS_PAUZE_MS: '0',
        SUPABASE_URL: 'https://abcdef.supabase.co', SUPABASE_MCP_TOKEN: 'pat-geheim', ANDERE_SLEUTEL: 'mag-niet-mee' }, execPath: process.execPath, pid: process.pid },
      reqPath: (req) => { const i = req.url.indexOf('?'); return i < 0 ? req.url : req.url.slice(0, i); },
      schrijfLog: (x) => logs.push(x), nu: () => '2026-11-08 12:00:00', velden: (o) => Object.keys(o).filter((k) => o[k] != null && o[k] !== '').map((k) => k + '=' + o[k]).join(' '),
      logError: (w, e) => logs.push('fout ' + w + ' ' + (e && e.message)), rolPrimair: () => true,
      VV: () => ({ lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: (p, t) => fs.writeFileSync(p, t) }),
      bankPagina: (res, st, kop, tekst) => { res.writeHead(st, {}); res.end(kop + ': ' + tekst); },
      berichtIntern: async (b) => { berichten.push(b); return { status: 200, j: { ok: true } }; },
      fetch: async function (url, o) {
        mgmt++;
        if (url !== 'https://api.supabase.com/v1/projects/abcdef/database/query') throw new Error('onverwacht adres ' + url);
        const q = JSON.parse(o.body).query;
        const ant = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => '' });
        if (/^select name, decrypted_secret as w from vault\.decrypted_secrets where name in \('nmbrs_client_id', 'nmbrs_client_secret', 'nmbrs_subscription_key', 'nmbrs_refresh'\)$/.test(q)) return ant(Object.keys(kluis).map((n) => ({ name: n, w: kluis[n] })));
        if (/^select count\(\*\)::int as n from vault\.secrets where name = 'nmbrs_refresh'$/.test(q)) return ant([{ n: kluis.nmbrs_refresh ? 1 : 0 }]);
        const m = /vault\.update_secret\(id, \$nm\$([^$]+)\$nm\$\)/.exec(q) || /vault\.create_secret\(\$nm\$([^$]+)\$nm\$, 'nmbrs_refresh'/.exec(q);
        if (m) { g.__soort = /create_secret/.test(q) ? 'create' : 'update'; kluis.nmbrs_refresh = m[1]; return ant([{ n: 1 }]); }
        if (/sha256\(convert_to\(decrypted_secret/.test(q)) return ant([{ h: sha(kluis.nmbrs_refresh) }]);
        return { ok: false, status: 400, json: async () => ({}), text: async () => 'fout met ' + q };
      } };
    vm.createContext(g);
    vm.runInContext(ssrc.slice(k1, k2) + '\n' + ssrc.slice(b1, b2) + '\n;globalThis.__t = { nmbrsTerug, nmbrsSmal, nmbrsInfo, nmbrsRondeDraai, nmbrsVaultMedewerkers };', g);
    const S = g.__t;
    async function vraag(url, methode) { let res; const p = new Promise((k) => { res = { statusCode: 0, headersSent: false, _log: {}, writeHead(st) { this.statusCode = st; this.headersSent = true; }, end(t) { k({ status: this.statusCode, tekst: String(t || '') }); } }; }); S.nmbrsTerug({ url: url, method: methode || 'GET', resume() {} }, res); return p; }
    mgmt = 0;
    let a = await vraag('/nmbrs/terug?code=code-goed&state=' + 'b'.repeat(64));
    toets('server: onbekende state → 404, geen kluis', a.status === 404 && mgmt === 0, a);
    a = await vraag('/nmbrs/terug?code=code-goed&state=xyz');
    toets('server: state van verkeerde vorm → 404', a.status === 404);
    let sm = await S.nmbrsSmal({ opdracht: 'link' }, { mk: false });
    toets('server: link zonder API_SECRET (Socev-sleutel) → 403', sm.status === 403);
    sm = await S.nmbrsSmal({ opdracht: 'ronde' }, { mk: false });
    toets('server: ronde met de Socev-sleutel → 403', sm.status === 403);
    sm = await S.nmbrsSmal({ opdracht: 'wis' }, { mk: true });
    toets('server: onbekende opdracht → 400', sm.status === 400);
    sm = await S.nmbrsSmal({ opdracht: 'link' }, { mk: true });
    const sst = sm.j && sm.j.url ? new URL(sm.j.url).searchParams.get('state') : '';
    toets('server: link gemaakt, nmbrs_refresh nog niet gezet', sm.status === 200 && /^[0-9a-f]{64}$/.test(sst) && !kluis.nmbrs_refresh, sm);
    a = await vraag('/nmbrs/terug?code=code-goed&state=' + sst, 'POST');
    toets('server: POST op de terugkeer → 404', a.status === 404);
    // de eerste ronde na de toestemming is een peiling; zet de signalen vooraf aan in de wegwerpmap
    await kindEcht('instel', { signalen_aan: ['S2'] }, DIR2);
    a = await vraag('/nmbrs/terug?code=code-goed&state=' + sst);
    toets('server: terugkeer → Gekoppeld, kluisregel aangemaakt', a.status === 200 && /^Gekoppeld/.test(a.tekst) && g.__soort === 'create' && kluis.nmbrs_refresh === tok(M.teller), a);
    for (let i = 0; i < 150 && !fs.existsSync(path.join(DIR2, 'ronde.json')); i++) await new Promise((k) => setTimeout(k, 100));
    for (let i = 0; i < 50 && !berichten.length; i++) await new Promise((k) => setTimeout(k, 100));
    // wv2799: na de signalen volgt de vault-stap binnen dezelfde ronde; wacht tot die klaar is (anders 'bezig' op een trage CI)
    const vaultN = () => logs.filter((x) => / opdracht=vault /.test(x + ' ')).length;
    for (let i = 0; i < 300 && vaultN() < 1; i++) await new Promise((k) => setTimeout(k, 100));
    const rj = JSON.parse(fs.readFileSync(path.join(DIR2, 'ronde.json'), 'utf8'));
    toets('server: eerste ronde (peil) na de toestemming, geroteerd, ronde.json 600', rj.ok === true && rj.bedrijven && rj.geroteerd === true && g.__soort === 'update' && (fs.statSync(path.join(DIR2, 'ronde.json')).mode & 0o777) === 0o600, rj.reden || rj.fout);
    toets('server: één bericht met het nieuwe signaal (S2), machinekamer, zonder bedrag', berichten.length === 1 && berichten[0].kanaal === 'machinekamer' && berichten[0].bron === 'nmbrs' && /S2 Cor Toets: contract loopt af/.test(berichten[0].tekst) && !/€|\d{4}\.\d\d/.test(berichten[0].tekst), berichten);
    a = await vraag('/nmbrs/terug?code=code-goed&state=' + sst);
    toets('server: dezelfde state nog eens → 404', a.status === 404);
    await S.nmbrsRondeDraai('ronde', 'proef');
    toets('server: volgende ronde zonder nieuw signaal → geen tweede bericht', berichten.length === 1, berichten.length);
    // review MOET 7: meer dan 25 nieuwe signalen → 25 in het bericht en als gemeld, de rest de ronde erna
    for (let i = 1; i <= 30; i++) fs.writeFileSync(path.join(W, '10_Zakelijk', 'Tolgaarde', 'Medewerkers', 'Proefpagina ' + i + '.md'), '---\ntype: medewerker\nentiteit_id: TG\nstatus: actief\n---\n');
    await kindEcht('koppel', { bedrijf: C1, entiteit: 'TG' }, DIR2);
    await kindEcht('instel', { signalen_aan: ['S2', 'S6'] }, DIR2);
    await S.nmbrsRondeDraai('ronde', 'proef');
    const bt2 = berichten[1] || { tekst: '' };
    toets('server: 32 nieuwe S6 → één bericht met 25 regels en "7 meer"', berichten.length === 2 && (bt2.tekst.match(/\n- S6 /g) || []).length === 25 && /en 7 meer/.test(bt2.tekst), bt2.tekst.slice(0, 300));
    const rx = await S.nmbrsRondeDraai('ronde', 'proef');
    toets('server: de 7 die niet in het bericht stonden komen de ronde erna (review MOET 7)', berichten.length === 3 && (berichten[2].tekst.match(/\n- S6 /g) || []).length === 7 && berichten[2].sleutel !== berichten[1].sleutel, [rx.ok, rx.reden, rx.fout, rx.signalen_nieuw, berichten.length, logs.slice(-3)]);
    await S.nmbrsRondeDraai('ronde', 'proef');
    toets('server: daarna niets meer', berichten.length === 3);
    sm = await S.nmbrsSmal({ opdracht: 'signalen' }, { mk: false });
    toets('server: signalen met de Socev-sleutel (wachter): naam, soort, datum, tekst; geen sleutel of bedrag', sm.status === 200 && sm.j.signalen.length >= 1 && sm.j.signalen.every((x) => JSON.stringify(Object.keys(x)) === JSON.stringify(['soort', 'entiteit', 'naam', 'datum', 'tekst'])), sm.j);
    sm = await S.nmbrsSmal({ opdracht: 'persoon', naam: 'Cor Toets' }, { mk: false });
    toets('server: persoon met de Socev-sleutel', sm.status === 200 && sm.j.treffers && sm.j.treffers[0].contract.uren_per_week === 24, sm.j);
    sm = await S.nmbrsSmal({ opdracht: 'stand' }, { mk: true });
    toets('server: stand lokaal (bedrijf, aantallen)', sm.status === 200 && sm.j.bedrijven && sm.j.bedrijven[0].medewerkers === 3 && sm.j.info.module === true, sm.j);
    const vm0 = S.nmbrsVaultMedewerkers();
    const va = vm0.find((x) => x.naam === 'Anna Proef') || {};
    toets('server: medewerkerpagina\'s gelezen (type medewerker, aliassen, actief), index overgeslagen', vm0.length === 31 && va.entiteit === 'TG' && va.actief === true && va.namen.indexOf('A. Proef') >= 0 && !vm0.some((x) => x.naam === 'Overzicht'), vm0.length);
    const alles = logs.join('\n');
    toets('server: log zonder code, state of token', alles.indexOf('code-goed') < 0 && alles.indexOf(sst) < 0 && alles.indexOf('rt-') < 0 && alles.indexOf('at-') < 0 && /nmbrs opdracht=terug soort=gekoppeld/.test(alles), logs);
    toets('server: kind krijgt alleen PATH/HOME/TZ/LANG + NMBRS_*', ssrc.slice(b1, b2).indexOf("['PATH', 'HOME', 'TZ', 'LANG']") > 0 && !/ANDERE_SLEUTEL|SUPABASE/.test(ssrc.slice(ssrc.indexOf('function nmbrsEnv'), ssrc.indexOf('async function nmbrsKind'))));
    const info = S.nmbrsInfo();
    toets('server: /health-info zonder tokens of namen', info.module === true && info.laatste && info.laatste.ok === true && JSON.stringify(info).indexOf('rt-') < 0 && JSON.stringify(info).indexOf('Proef') < 0, info);
    // review MOET 6: intrekken onder het slot, ook het noodtoken, daarna stil
    const noodTok = tok(9999); M.refreshGeldig.add(noodTok); require(SCRIPT).noodSchrijf(DIR2, noodTok); M.intrek = [];
    sm = await S.nmbrsSmal({ opdracht: 'intrek' }, { mk: false });
    toets('server: intrek met de Socev-sleutel → 403', sm.status === 403);
    fs.writeFileSync(path.join(DIR2, 'ronde.lock'), JSON.stringify({ pid: process.pid, sinds: new Date().toISOString() }));
    sm = await S.nmbrsSmal({ opdracht: 'intrek' }, { mk: true });
    toets('server: intrek tijdens een ronde (slot) → 409', sm.status === 409, sm);
    fs.unlinkSync(path.join(DIR2, 'ronde.lock'));
    sm = await S.nmbrsSmal({ opdracht: 'intrek' }, { mk: true });
    toets('server: intrek trekt kluistoken én noodtoken in, noodkopie weg', sm.status === 200 && sm.j.ok === true && sm.j.tokens === 2 && M.intrek.length === 2 && !M.refreshGeldig.has(noodTok) && !require(SCRIPT).noodLees(DIR2), [sm, M.intrek]);
    M.log = []; const nb = berichten.length;
    let ri = await S.nmbrsRondeDraai('ronde', 'proef');
    toets('server: na intrek blijven de rondes stil (dood, geen vraag aan Nmbrs, geen box-rij)', ri.reden === 'dood' && !M.log.length && fs.readFileSync(path.join(W, '00_Systeem', 'Meldingen', 'machinekamer.md'), 'utf8').indexOf('nmbrs-') < 0 && berichten.length === nb, ri);
    // nieuwe toestemming, daarna invalid_grant → één box-rij
    sm = await S.nmbrsSmal({ opdracht: 'link' }, { mk: true });
    a = await vraag('/nmbrs/terug?code=code-goed&state=' + new URL(sm.j.url).searchParams.get('state'));
    for (let i = 0; i < 100 && S.nmbrsInfo().laatste && S.nmbrsInfo().laatste.reden === 'dood'; i++) await new Promise((k) => setTimeout(k, 100));
    const vn0 = vaultN();
    for (let i = 0; i < 100 && fs.existsSync(path.join(DIR2, 'ronde.lock')); i++) await new Promise((k) => setTimeout(k, 100));
    for (let i = 0; i < 300 && vaultN() <= vn0; i++) await new Promise((k) => setTimeout(k, 100));   // wv2799: ook de vault-stap van deze ronde
    toets('server: nieuwe toestemming na intrek → weer gekoppeld', a.status === 200 && /^Gekoppeld/.test(a.tekst), a);
    M.refreshGeldig.delete(kluis.nmbrs_refresh);
    await S.nmbrsRondeDraai('ronde', 'proef'); await S.nmbrsRondeDraai('ronde', 'proef');
    const box = fs.readFileSync(path.join(W, '00_Systeem', 'Meldingen', 'machinekamer.md'), 'utf8');
    toets('server: invalid_grant → precies één box-rij (#nmbrs), zonder token', (box.match(/nmbrs-grant-/g) || []).length === 1 && /#nmbrs/.test(box) && box.indexOf('rt-') < 0, box.slice(0, 600));
    toets('server: kluisfout-antwoord (met query) komt niet in het log', logs.join('\n').indexOf('$nm$') < 0);
  } catch (e) { toets('geen uitzondering', false, String(e && e.stack || e)); }
  srv.close();
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
});
JS
