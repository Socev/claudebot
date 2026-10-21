#!/usr/bin/env bash
# Toetst de vaste bank-ronde (wv685, 21-10-2026): bank-lezer.js ronde tegen nagebootste Enable Banking- en bunq-API's, en
# bankRonde/bankKaarten uit server.js (vm-context, nagebootste Supabase-RPC's voor hartslag en Voor jou).
# Toetst: rondegrens (2 per dag, David houdt 2 eigen opvragen), vers overslaan, geen bedragen/namen/IBAN's/sessie-id's in de
# uitvoer, fouten (toestemming, sleutel, 429, bunq IP) → niet geslaagd + box-melding 1×/dag, hartslag alleen bij geslaagd,
# toestemmingskaarten 14 en 3 dagen (één keer, ook na dichtzetten), verlopen → kaart + hoofdregel één keer, sluiten na herkoppelen.
# Raakt de echte banken, de kluis, Supabase en /opt/data/bank niet. Gebruik: bash test/bank-ronde.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), http = require('http'), vm = require('vm');
const { spawn } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'bankronde-'));
const BD = path.join(W, 'bank');
const vandaag = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const dagTerug = (n) => { const d = new Date(vandaag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

// ── nagebootste Enable Banking ──
const eb = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = eb.privateKey.export({ type: 'pkcs8', format: 'pem' }), APP = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const G = { sleutel: PEM, app_id: APP };
const E = { sessies: {}, n: 0, opvragen: [], forceer: {}, appFout: 0, sessieFout: 0 };
const ebApi = http.createServer(function (req, res) {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', function () {
    const u = new URL(req.url, 'http://x'), p = u.pathname, stuur = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    const m0 = /^Bearer (.+)\.(.+)\.(.+)$/.exec(req.headers.authorization || '');
    if (!m0 || !crypto.createVerify('RSA-SHA256').update(m0[1] + '.' + m0[2]).verify(eb.publicKey, Buffer.from(m0[3], 'base64url'))) return stuur(401, {});
    if (p === '/application') return E.appFout ? stuur(E.appFout, {}) : stuur(200, { name: 'Socev', active: true });
    if (p === '/aspsps') return stuur(200, { aspsps: [{ name: 'ABN AMRO', country: 'NL', psu_types: ['personal'], maximum_consent_validity: 15552000 }] });
    if (p === '/auth') return stuur(200, { url: 'https://bank.example/x', authorization_id: 'a' });
    if (p === '/sessions' && req.method === 'POST') {
      const id = 'sess-' + String(++E.n).padStart(4, '0');
      E.sessies[id] = { status: 'AUTHORIZED', tot: new Date(Date.now() + 179 * 86400000).toISOString(), uid: 'uid-' + E.n };
      return stuur(200, { session_id: id, aspsp: { name: 'ABN AMRO', country: 'NL' }, psu_type: 'personal', access: { valid_until: E.sessies[id].tot },
        accounts: [{ uid: 'uid-' + E.n, name: 'Gezamenlijk Naam', currency: 'EUR', identification_hash: 'hash-1', account_id: { iban: 'NL00ABNA0123456789' } }] });
    }
    let m = /^\/sessions\/(.+)$/.exec(p);
    if (m) { if (E.sessieFout) return stuur(E.sessieFout, {}); if (E.eenmaal404) { E.eenmaal404 = false; return stuur(404, {}); } const s = E.sessies[m[1]]; if (!s) return stuur(404, {}); return stuur(200, { status: s.status, access: { valid_until: s.tot } }); }
    m = /^\/accounts\/([^/]+)\/(balances|transactions)$/.exec(p);
    if (m) {
      E.opvragen.push(m[2]);
      if (E.forceer[m[2]]) return stuur(E.forceer[m[2]], {});
      const s = Object.values(E.sessies).find((x) => x.uid === m[1]);
      if (!s || s.status !== 'AUTHORIZED') return stuur(401, {});
      if (m[2] === 'balances') return stuur(200, { balances: [{ balance_type: 'CLBD', balance_amount: { currency: 'EUR', amount: '1234.56' } }] });
      return stuur(200, { transactions: [{ entry_reference: 'r1', transaction_amount: { currency: 'EUR', amount: '95.50' }, credit_debit_indicator: 'DBIT', status: 'BOOK',
        booking_date: dagTerug(2), creditor: { name: 'Energie Bakker BV' }, remittance_information: ['termijn'] }] });
    }
    stuur(404, {});
  });
});

// ── nagebootste bunq (ondertekend) ──
fs.mkdirSync(path.join(BD, 'bunq'), { recursive: true, mode: 0o700 }); fs.chmodSync(BD, 0o700);
const client = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }), bsrv = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const UID = 4242, BSLEUTEL = 'sleutel' + 'x'.repeat(57), ITOK = 'i'.repeat(64);
fs.writeFileSync(path.join(BD, 'bunq', 'staat.json'), JSON.stringify({ aangemaakt: '2026-10-20T22:05:00+02:00', omgeving: 'productie', permitted_ips: ['1.2.3.4'],
  private_key_pem: client.privateKey.export({ type: 'pkcs8', format: 'pem' }), installation_token: ITOK,
  server_public_key: bsrv.publicKey.export({ type: 'spki', format: 'pem' }), device_server_id: 1, user_id: UID, user_soort: 'UserPerson' }), { mode: 0o600 });
const B = { sessies: new Set(), n: 0, sessieFout: 0, lijst: 0, betalingen: 0 };
const bt = (dagen) => new Date(Date.now() - dagen * 86400000).toISOString().replace('T', ' ').replace('Z', '000').slice(0, 26);
function brek(soort, id, status, naam, iban, saldo) { return { [soort]: { id: id, status: status, description: naam, currency: 'EUR', balance: { currency: 'EUR', value: saldo }, alias: [{ type: 'IBAN', value: iban, name: 'D' }] } }; }
const bunqApi = http.createServer(function (req, res) {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', function () {
    const u = new URL(req.url, 'http://x');
    const stuur = (st, j) => { const t = JSON.stringify(j); res.writeHead(st, { 'Content-Type': 'application/json',
      'X-Bunq-Server-Signature': crypto.sign('RSA-SHA256', Buffer.from(t), { key: bsrv.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64') }); res.end(t); };
    if (req.method === 'POST' && u.pathname === '/v1/session-server') {
      if (B.sessieFout) return stuur(B.sessieFout, { Error: [{ error_description: 'Incorrect API key or IP address.' }] });
      if (JSON.parse(body).secret !== BSLEUTEL) return stuur(400, {});
      const tok = 's' + (++B.n) + 'T'.repeat(62); B.sessies.add(tok);
      return stuur(200, { Response: [{ Id: { id: 1 } }, { Token: { id: 2, token: tok } }, { UserPerson: { id: UID, session_timeout: 604800 } }] });
    }
    if (!B.sessies.has(req.headers['x-bunq-client-authentication'])) return stuur(401, { Error: [{ error_description: 'Insufficient authorisation.' }] });
    if (u.pathname === '/v1/user/' + UID + '/monetary-account') { B.lijst++;
      return stuur(200, { Response: [brek('MonetaryAccountBank', 1, 'ACTIVE', 'Privé', 'NL11BUNQ0000000001', '777.77'), brek('MonetaryAccountSavings', 2, 'ACTIVE', 'Spaar', 'NL22BUNQ0000000002', '5000.00'),
        brek('MonetaryAccountBank', 4, 'CANCELLED', 'Oud', 'NL44BUNQ0000000004', '0.00')], Pagination: { older_url: null } }); }
    const m = /^\/v1\/user\/4242\/monetary-account\/(\d+)\/payment$/.exec(u.pathname);
    if (m) { B.betalingen++;
      return stuur(200, { Response: m[1] === '1' ? [{ Payment: { id: 501, created: bt(1), monetary_account_id: 1, amount: { currency: 'EUR', value: '-12.34' }, description: 'Supermarkt Jansen',
        counterparty_alias: { display_name: 'Supermarkt Jansen', iban: 'NL99RABO0123456789' }, balance_after_mutation: { currency: 'EUR', value: '777.77' }, type: 'BUNQ' } }] : [], Pagination: { older_url: null } }); }
    stuur(404, {});
  });
});

function draai(args, stdin, extra) {
  return new Promise(function (klaar) {
    const k = spawn(process.execPath, ['--no-warnings', 'bank-lezer.js'].concat(args), { env: Object.assign({ PATH: process.env.PATH, TZ: 'Europe/Amsterdam', BANK_DIR: BD,
      BANK_API_BASIS: 'http://127.0.0.1:' + ebApi.address().port, BUNQ_API_BASIS: 'http://127.0.0.1:' + bunqApi.address().port, BUNQ_PAUZE_MS: '0', BANK_RONDE_VERS_MS: '0' }, extra || {}) });
    let o = '', e = '';
    k.stdout.on('data', (c) => o += c); k.stderr.on('data', (c) => e += c);
    k.on('close', (code) => { let j = null; try { j = JSON.parse(o); } catch (x) {} klaar({ code: code, j: j, o: o, e: e }); });
    k.stdin.end(JSON.stringify(stdin || {}));
  });
}
const STAND = path.join(BD, 'stand.json');
const stand = () => JSON.parse(fs.readFileSync(STAND, 'utf8'));
const zetStand = (f) => { const s = stand(); f(s); fs.writeFileSync(STAND, JSON.stringify(s), { mode: 0o600 }); };
const nulTellers = () => zetStand((s) => { s.tellers = { dag: '', per: {} }; });
const ebHash = () => Object.keys(stand().rekeningen).find((h) => stand().rekeningen[h].bron !== 'bunq');
const AL = Object.assign({ bunq_sleutel: BSLEUTEL }, G);
const geenBankdata = (o) => !/1234\.56|777\.77|5000|95\.5|12\.34|NL\d\d|Bakker|Jansen|Gezamenlijk Naam|sess-|uid-|hash-1/.test(o);

ebApi.listen(0, '127.0.0.1', () => bunqApi.listen(0, '127.0.0.1', async function () {
  try {
    // ── opzet: ABN koppelen (koppel-start + koppel-af), bunq-lijst ──
    let r = await draai(['koppel-start', '--bank', 'ABN AMRO'], G);
    const state = (Object.keys(stand().wachtend).length && null);
    // de state staat alleen gehasht in stand.json; haal hem uit de nagebootste /auth-aanroep is niet bewaard → koppel via een eigen state
    const st = crypto.randomBytes(24).toString('hex');
    zetStand((s) => { s.wachtend[crypto.createHash('sha256').update(st).digest('hex')] = { bank: 'ABN AMRO', land: 'NL', soort: 'personal', sinds: new Date().toISOString(), tot: new Date(Date.now() + 3600000).toISOString(), toestemming_tot: new Date().toISOString() }; });
    r = await draai(['koppel-af'], Object.assign({ state: st, code: 'goede-code' }, G));
    toets('opzet: ABN gekoppeld', r.j && r.j.ok && r.j.rekeningen === 1, r.j);
    r = await draai(['label', '6789', 'Vaste lasten'], null);
    nulTellers();

    // ── ronde 1 en 2: geslaagd, teller laat 2 over ──
    E.opvragen = [];
    r = await draai(['ronde'], AL);
    toets('ronde 1 geslaagd: ABN + 2 actieve bunq-rekeningen, saldo en transacties opgehaald', r.j && r.j.ok && r.j.geslaagd && r.j.rekeningen.enablebanking === 1 && r.j.rekeningen.bunq === 2 &&
      r.j.saldo.bank === 3 && r.j.transacties.bank === 3 && r.j.fouten.length === 0, r.j);
    toets('ronde 1: één /sessions-controle, één saldo- en één transactieopvraag bij ABN', E.opvragen.join(',') === 'balances,transactions', E.opvragen);
    toets('ronde-uitvoer zonder bedragen, namen, IBAN\'s, uid\'s of sessie-id\'s', geenBankdata(r.o), r.o);
    toets('toestemming: sessie_kort 8 hex, ABN, ~178 dagen, rekening-label', r.j.toestemming.length === 1 && /^[0-9a-f]{8}$/.test(r.j.toestemming[0].sessie_kort) &&
      r.j.toestemming[0].bank === 'ABN AMRO' && r.j.toestemming[0].dagen_over >= 177 && r.j.toestemming[0].rekening === 'Vaste lasten', r.j.toestemming);
    r = await draai(['ronde'], AL);
    toets('ronde 2 geslaagd', r.j && r.j.geslaagd && r.j.saldo.bank === 3 && r.j.transacties.bank === 3, r.j);
    toets('na twee rondes: overal 2 van 4 gebruikt, 2 over voor David', r.j.opvragen.saldo.hoogst === 2 && r.j.opvragen.saldo.minst_over === 2 && r.j.opvragen.transacties.minst_over === 2, r.j.opvragen);
    E.opvragen = []; const lijst0 = B.lijst, bet0 = B.betalingen;
    r = await draai(['ronde'], AL);
    toets('derde ronde dezelfde dag: alles grens, geen opvraag, toch geslaagd (geen fout)', r.j.geslaagd && r.j.saldo.grens === 3 && r.j.transacties.grens === 3 && E.opvragen.length === 0 && B.lijst === lijst0 && B.betalingen === bet0, [r.j, E.opvragen]);

    // ── vers overslaan (standaard 2 uur) ──
    nulTellers(); E.opvragen = [];
    r = await draai(['ronde'], AL, { BANK_RONDE_VERS_MS: '' });
    toets('cache jonger dan 2 uur: niets opgevraagd, telt als vers', r.j.geslaagd && r.j.saldo.vers === 3 && r.j.transacties.vers === 3 && E.opvragen.length === 0, r.j);

    // ── David vroeg zelf al: hij houdt er samen 2 ──
    for (const [eigen, verwacht] of [[1, 3], [2, 4], [3, 4]]) {
      nulTellers();
      zetStand((s) => { s.tellers = { dag: vandaag, per: { [ebHash()]: { saldo: eigen, transacties: 0, paginas: 0, k429: 0 } } }; });
      await draai(['ronde'], AL); r = await draai(['ronde'], AL);
      const t = stand().tellers.per[ebHash()];
      toets('David vroeg ' + eigen + '× saldo: na twee rondes teller ' + verwacht + ' (David houdt er samen minstens 2)', t.saldo === verwacht && (t.saldo - t.ronde_saldo) + (4 - t.saldo) >= 2, t);
    }

    // ── fouten ──
    nulTellers();
    E.forceer.balances = 429;
    r = await draai(['ronde'], AL);
    toets('429 van de bank terwijl onze teller ruimte zag: niet geslaagd, reden grens', r.j.ok && !r.j.geslaagd && r.j.fouten.some((f) => f.bron === 'enablebanking' && f.reden === 'grens'), r.j);
    delete E.forceer.balances;
    nulTellers();
    B.sessieFout = 403; zetStand((s) => { delete s.bunq.box_dag; });
    r = await draai(['ronde'], AL);
    toets('bunq weigert (thuis-IP): niet geslaagd, reden toegang, bunq-box-melding, ABN wel opgehaald', !r.j.geslaagd && r.j.fouten.some((f) => f.bron === 'bunq' && f.reden === 'toegang') && r.j._box && r.j.saldo.bank >= 1, r.j);
    B.sessieFout = 0;
    nulTellers();
    r = await draai(['ronde'], Object.assign({}, AL, { sleutel: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
    toets('verkeerde Enable Banking-sleutel: reden sleutel + box-melding, sessie blijft geldig', !r.j.geslaagd && r.j.fouten.some((f) => f.reden === 'sleutel') &&
      Array.isArray(r.j._box_ronde) && r.j._box_ronde[0].reden === 'sleutel' && stand().sessies['sess-0001'].status === 'AUTHORIZED', r.j);
    r = await draai(['ronde'], { bunq_sleutel: BSLEUTEL });
    toets('sleutel ontbreekt in de kluis: reden sleutel, geen tweede box-melding dezelfde dag', !r.j.geslaagd && r.j.fouten.some((f) => f.reden === 'sleutel') && !r.j._box_ronde, r.j);
    nulTellers();
    E.sessies['sess-0001'].status = 'EXPIRED';
    r = await draai(['ronde'], AL);
    toets('sessie verlopen (GET /sessions): toestemming-fout, box-melding, geen ABN-opvraag', !r.j.geslaagd && r.j.fouten.some((f) => f.reden === 'toestemming') &&
      r.j._box_ronde && r.j._box_ronde[0].reden === 'toestemming' && r.j.toestemming[0].status === 'EXPIRED', r.j);
    E.sessies['sess-0001'].status = 'AUTHORIZED';
    zetStand((s) => { s.sessies['sess-0001'].status = 'AUTHORIZED'; });
    nulTellers(); E.opvragen = [];
    E.sessieFout = 503;
    r = await draai(['ronde'], AL);
    toets('GET /sessions 503: geen oordeel, rekeningopvraag beslist (geslaagd)', r.j.geslaagd && E.opvragen.length === 2, [r.j, E.opvragen]);
    E.sessieFout = 0;
    nulTellers(); E.eenmaal404 = true;
    r = await draai(['ronde'], AL);
    toets('één 404 op GET /sessions: geen verlopen (rekeningopvraag slaagt), geslaagd', r.j.geslaagd && stand().sessies['sess-0001'].status === 'AUTHORIZED', r.j);
    // toestemming loopt af: einddatum uit GET /sessions komt in de stand
    E.sessies['sess-0001'].tot = new Date(Date.now() + 10.5 * 86400000).toISOString();
    nulTellers();
    r = await draai(['ronde'], AL);
    toets('einddatum uit GET /sessions overgenomen (10 dagen over)', r.j.toestemming[0].dagen_over === 10, r.j.toestemming);

    // ── server.js: bankRonde en bankKaarten (vm, nagebootste Supabase) ──
    const src = fs.readFileSync('server.js', 'utf8');
    const a = src.indexOf('// ── wv680: bankluis'), b = src.indexOf('// ── einde bankluis ──');
    const k1 = src.indexOf('function smalKind('), k2 = src.indexOf('async function smalSbRpc(');
    const VJ = {}, HS = [], RPC = [], logs = [];
    const VAULT = path.join(W, 'vault'); fs.mkdirSync(path.join(VAULT, '00_Systeem', 'Meldingen'), { recursive: true });
    const BOX = path.join(VAULT, '00_Systeem', 'Meldingen', 'machinekamer.md');
    fs.writeFileSync(BOX, '# box\n\n## [direct] 2026-10-20 10:00 — oude rij\n- status: open\n');
    const env = { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', BANK_DIR: BD, BANK_API_BASIS: 'http://127.0.0.1:' + ebApi.address().port,
      BUNQ_API_BASIS: 'http://127.0.0.1:' + bunqApi.address().port, BUNQ_PAUZE_MS: '0', SUPABASE_URL: 'https://abcdef.supabase.co', SUPABASE_MCP_TOKEN: 'pat' };
    let kluisFout = false;
    const g = { require, fs, path, crypto, Buffer, console, URL, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, VAULT: VAULT, SECRET: 'x'.repeat(40),
      __dirname: process.cwd(), process: { env: env, execPath: process.execPath, pid: process.pid },
      fetch: async function () { if (kluisFout) throw new Error('weg'); return { ok: true, json: async () => [{ name: 'enablebanking_app_key', w: PEM }, { name: 'enablebanking_app_id', w: APP }, { name: 'bunq_api_key', w: BSLEUTEL }] }; },
      appSbRpc: async function (fn, body) {
        RPC.push(fn);
        if (g.__rpcFout) throw new Error('rpc ' + fn + ' http 503');
        if (fn === 'mk_hartslag_stempel') { HS.push(body); return [{ uit_component: body.p_component }]; }
        if (fn === 'mk_voor_jou_lijst') return { punten: Object.values(VJ).map((p) => ({ sleutel: p.sleutel, status: p.status })) };
        if (fn === 'mk_voor_jou_zet') {
          if (!body.p || Object.keys(body).length !== 1) throw new Error('rpc mk_voor_jou_zet http 404');   // zoals PostgREST: één parameter p jsonb
          body = body.p;
          for (const v of [body.titel, body.waarom].concat(body.stappen)) if (/wv\d|\/opt\/|\.md\b|mk-scripts/.test(v)) throw new Error('verwijzing in kaart: ' + v);
          VJ[body.sleutel] = Object.assign({ status: 'open' }, VJ[body.sleutel] || {}, body, { status: (VJ[body.sleutel] || {}).status || 'open' }); return VJ[body.sleutel];
        }
        if (fn === 'mk_voor_jou_status') { const p = VJ[body.p_sleutel]; if (!p || p.status !== body.p_van) return { ok: false, fout: 'conflict' }; p.status = body.p_naar; p.bewijs = body.p_bewijs; return { ok: true }; }
        throw new Error('onbekende rpc ' + fn);
      },
      logError: (w, e) => logs.push(w + ': ' + (e && e.message || e)), schrijfLog: (x) => logs.push(x), nu: () => 'NU', velden: (o) => JSON.stringify(o),
      reqPath: (req) => (req.url || '').split('?')[0], rolPoort: (res, verder) => verder(), rol: { eerste: true }, rolPrimair: () => true, rolEerste: Promise.resolve(), ROL_START_WACHT_MS: 50 };
    g.spawn = spawn;
    const ctx = vm.createContext(g);
    vm.runInContext(src.slice(k1, k2) + '\n' + src.slice(a, b) + '\n;globalThis.__h = { bankRonde, bankKaarten, bankRondeStart, bankRondeUitkomst };', ctx, { filename: 'server.js#bank' });
    const h = ctx.__h;
    const zetTot = (dagen) => { E.sessies['sess-0001'].tot = new Date(Date.now() + (dagen + 0.5) * 86400000).toISOString(); nulTellers(); };

    zetTot(20);
    let u = await h.bankRonde();
    toets('pod: geslaagde ronde stempelt de hartslag bank-ronde (3 rekeningen)', u.ok && u.geslaagd && u.hartslag === true && HS.length === 1 && HS[0].p_component === 'bank-ronde' && HS[0].p_gemeten_rijen === 3, [u, HS]);
    toets('pod: 20 dagen over → geen kaart', Object.keys(VJ).length === 0 && !u.hoofd_regel, VJ);
    toets('pod: antwoord zonder bankdata en zonder _-velden', geenBankdata(JSON.stringify(u)) && !Object.keys(u).some((k) => k[0] === '_'), u);
    zetTot(14);
    u = await h.bankRonde();
    const kort = u.toestemming[0].sessie_kort, v = 'bank-verleng-' + kort;
    toets('pod: 14 dagen → kaart verlengen, privé, met stappen in de kaart', VJ[v] && VJ[v].status === 'open' && VJ[v].prive === true && VJ[v].stappen.length === 4 &&
      /Vaste lasten/.test(VJ[v].stappen[2]) && /^Bank — koppeling ABN AMRO verlengen$/.test(VJ[v].titel) && VJ[v].volgorde === 40 && u.kaarten.gezet[0] === v, [VJ, u.kaarten]);
    zetTot(13);
    u = await h.bankRonde();
    toets('pod: volgende ronde geen tweede kaart', Object.keys(VJ).length === 1 && u.kaarten.gezet.length === 0, u.kaarten);
    zetTot(3); VJ[v].status = 'later';
    u = await h.bankRonde();
    toets('pod: 3 dagen, kaart stond op later → bijgewerkt, weer open, bovenaan, "nog 3 dagen"', VJ[v].status === 'open' && VJ[v].volgorde === 5 && /nog 3 dagen/.test(VJ[v].titel) && u.kaarten.bijgewerkt[0] === v && Object.keys(VJ).length === 1, [VJ[v], u.kaarten]);
    zetTot(2);
    u = await h.bankRonde();
    toets('pod: 2 dagen → niets nieuws (drempel 3 al gehad)', u.kaarten.gezet.length === 0 && u.kaarten.bijgewerkt.length === 0, u.kaarten);
    // verlopen
    E.sessies['sess-0001'].status = 'REVOKED'; nulTellers(); zetStand((s) => { delete s.ronde.box; });   // de CLI-toetsen hierboven gebruikten de dagmelding al
    u = await h.bankRonde();
    const x = 'bank-verlopen-' + kort;
    let uk = h.bankRondeUitkomst().j;
    toets('pod: toestemming ingetrokken → niet geslaagd, wél hartslag (ligt bij David), kaart verlopen + hoofdregel via de uitkomst', !u.geslaagd && u.hartslag === true && VJ[x] && VJ[x].volgorde === 5 &&
      /verlopen/.test(VJ[x].titel) && /verlopen/.test(uk.hoofd_regel || ''), [u, VJ[x], uk]);
    toets('pod: hoofdregel één keer opgehaald', !h.bankRondeUitkomst().j.hoofd_regel, null);
    toets('pod: box-rij Enable Banking toestemming bovenaan de box, met de kaart die gezet is', /## \[direct\] .* Enable Banking: toestemming bij de bank geldt niet meer[\s\S]*Voor jou-kaart bank-verlopen-/.test(fs.readFileSync(BOX, 'utf8').split('## [direct] 2026-10-20')[0]), fs.readFileSync(BOX, 'utf8').slice(0, 900));
    u = await h.bankRonde();
    toets('pod: tweede ronde na verlopen: geen tweede kaart, geen tweede hoofdregel, geen tweede box-rij', !h.bankRondeUitkomst().j.hoofd_regel && u.kaarten.gezet.length === 0 && (fs.readFileSync(BOX, 'utf8').match(/Enable Banking: toestemming/g) || []).length === 1, u);
    // herkoppelen → oude kaarten dicht met meting
    const st2 = crypto.randomBytes(24).toString('hex');
    zetStand((s) => { s.wachtend[crypto.createHash('sha256').update(st2).digest('hex')] = { bank: 'ABN AMRO', land: 'NL', soort: 'personal', sinds: new Date().toISOString(), tot: new Date(Date.now() + 3600000).toISOString(), toestemming_tot: new Date().toISOString() }; });
    r = await draai(['koppel-af'], Object.assign({ state: st2, code: 'goede-code' }, G));
    nulTellers();
    u = await h.bankRonde();
    toets('pod: na herkoppelen geslaagd, beide oude kaarten gedaan met meting "geldt weer"', u.geslaagd && VJ[v].status === 'gedaan' && VJ[x].status === 'gedaan' && /geldt weer, tot/.test(VJ[v].bewijs) &&
      u.kaarten.gesloten.length === 2 && u.toestemming.length === 1 && u.toestemming[0].sessie_kort !== kort, [u.kaarten, u.toestemming]);
    // dichtgezet door David vóór 3 dagen → nieuwe korte kaart
    const kort2 = u.toestemming[0].sessie_kort, v2 = 'bank-verleng-' + kort2;
    E.sessies['sess-0002'].tot = new Date(Date.now() + 14.5 * 86400000).toISOString(); nulTellers();
    u = await h.bankRonde();
    VJ[v2].status = 'gedaan';
    E.sessies['sess-0002'].tot = new Date(Date.now() + 3.5 * 86400000).toISOString(); nulTellers();
    u = await h.bankRonde();
    toets('pod: David zette de 14-dagenkaart dicht zonder verlengen → bij 3 dagen één nieuwe kaart -3', VJ[v2 + '-3'] && VJ[v2 + '-3'].status === 'open' && u.kaarten.gezet[0] === v2 + '-3', u.kaarten);
    nulTellers();
    u = await h.bankRonde();
    toets('pod: daarna niet nog een', u.kaarten.gezet.length === 0, u.kaarten);
    // einddatum voorbij terwijl Enable Banking nog AUTHORIZED zegt → lokaal verlopen, geen bankopvraag, kaart + regel
    E.sessies['sess-0002'].tot = new Date(Date.now() - 3600000).toISOString(); nulTellers(); E.opvragen = [];
    zetStand((s) => { s.sessies['sess-0002'].geldig_tot = E.sessies['sess-0002'].tot; delete s.ronde.box; });
    u = await h.bankRonde();
    toets('pod: einddatum voorbij (status nog AUTHORIZED) → verlopen-kaart, geen ABN-opvraag, "nog 0" nergens negatief', VJ['bank-verlopen-' + kort2] && E.opvragen.length === 0 &&
      /verlopen/.test(h.bankRondeUitkomst().j.hoofd_regel || '') && !Object.values(VJ).some((p) => /-\d+ dag/.test(p.meting || '') || /nog -/.test(p.titel)), [u.fouten, Object.keys(VJ), E.opvragen]);
    E.sessies['sess-0002'].tot = new Date(Date.now() + 179 * 86400000).toISOString(); zetStand((s) => { s.sessies['sess-0002'].geldig_tot = E.sessies['sess-0002'].tot; });
    // Supabase weg: geen kaart, geen geheugen → volgende ronde opnieuw
    E.sessies['sess-0002'].tot = new Date(Date.now() + 179 * 86400000).toISOString(); nulTellers();
    fs.rmSync(path.join(BD, 'kaarten.json')); for (const k of Object.keys(VJ)) delete VJ[k];
    E.sessies['sess-0002'].tot = new Date(Date.now() + 9.5 * 86400000).toISOString();
    g.__rpcFout = true;
    u = await h.bankRonde();
    toets('pod: Supabase weg → geen hartslag, kaartfout gemeld, niets in het geheugen', u.geslaagd && u.hartslag === false && u.kaarten.fouten.length >= 1 && !fs.readFileSync(path.join(BD, 'kaarten.json'), 'utf8').includes('bank-verleng'), u);
    g.__rpcFout = false; nulTellers();
    u = await h.bankRonde();
    toets('pod: Supabase terug → kaart alsnog', u.kaarten.gezet.length === 1, u.kaarten);
    toets('kaarten.json 600', (fs.statSync(path.join(BD, 'kaarten.json')).mode & 0o777) === 0o600, null);
    nulTellers();
    let s1 = h.bankRondeStart(), s2 = h.bankRondeStart();
    toets('pod: start geeft 202 meteen, tweede start tijdens de ronde 409', s1.status === 202 && s1.j.gestart && s2.status === 409, [s1, s2]);
    for (let i = 0; i < 120 && h.bankRondeUitkomst().j.bezig; i++) await new Promise((ok) => setTimeout(ok, 250));
    uk = h.bankRondeUitkomst().j;
    toets('pod: uitkomst na afloop: niet bezig, geslaagd, eind gezet', !uk.bezig && uk.uitkomst && uk.uitkomst.geslaagd && uk.eind, uk);
    // geen enkele rekening: niet geslaagd, geen stempel
    const standBewaar = fs.readFileSync(STAND, 'utf8'), staatBewaar = fs.readFileSync(path.join(BD, 'bunq', 'staat.json'));
    zetStand((s) => { s.rekeningen = {}; s.sessies = {}; }); fs.rmSync(path.join(BD, 'bunq', 'staat.json'));
    const hs0 = HS.length;
    u = await h.bankRonde();
    toets('pod: geen rekeningen → niet geslaagd (leeg), geen hartslag', !u.geslaagd && u.hartslag === false && HS.length === hs0 && u.fouten.some((f) => f.reden === 'leeg'), u);
    fs.writeFileSync(STAND, standBewaar, { mode: 0o600 }); fs.writeFileSync(path.join(BD, 'bunq', 'staat.json'), staatBewaar, { mode: 0o600 });
    kluisFout = true; vm.runInContext('bankSleutelCache = null', ctx);
    u = await h.bankRonde();
    toets('pod: kluis onbereikbaar → ronde niet ok, geen hartslag, geen kaartwerk', !u.ok && !u.geslaagd && u.hartslag === false && !u.kaarten, u);
    kluisFout = false;
    const alles = logs.join('\n') + fs.readFileSync(BOX, 'utf8');
    toets('geen sleutel in logregels of box', alles.indexOf(PEM.split('\n')[1]) < 0 && alles.indexOf(BSLEUTEL) < 0, null);
    const srv = fs.readFileSync('server.js', 'utf8');
    toets('route /bank-ronde(/uitkomst): secret met timingSafeEqual, leeg SECRET weigert, achter rolPoort', /req\.url === '\/bank-ronde\/uitkomst'\)\)[\s\S]{0,120}rolPoort[\s\S]{0,200}!SECRET \|\|[\s\S]{0,200}timingSafeEqual/.test(srv), null);
    toets('ronde niet via /smal/bank (geen Socev-sleutel)', !/BANK_OPDRACHTEN = \[[^\]]*'ronde'/.test(srv), null);
  } catch (e) { fouten++; console.log('ROOD  uitzondering: ' + (e && e.stack || e)); }
  ebApi.close(); bunqApi.close(); fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
}));
JS
