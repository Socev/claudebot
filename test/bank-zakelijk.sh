#!/usr/bin/env bash
# Toetst de zakelijke rekeningen via Enable Banking (wv2392, 4-11-2026; ontwerp vault 01_Ontwikkeling/Zakelijke rekeningen via Enable
# Banking naar Facturen (ontwerp 4-11-2026)): een business-koppeling maakt de rekeningen zakelijk (ook als alleen link óf bank 'business'
# zegt); hun posten gaan alleen naar zakelijk.sqlite (niet naar transacties.sqlite, niet naar cache.sqlite, geen saldo-opvraag); geen
# privé-opdracht toont of kiest ze; Facturen leest ze met een naad tegen de uploads (geen dubbele boekingen, half geüploade laatste dag
# aangevuld), weigert een rekening die in beide databases staat, en het omzet-hulpje meet droog op een kopie en zet pas met --echt om.
# Alle IBAN's, namen en bedragen zijn verzonnen. Raakt de pod, de kluis, de bank en /opt/data niet. Gebruik: bash test/bank-zakelijk.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'bankzak-'));
const BD = path.join(W, 'bank'), FD = path.join(W, 'facturen');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const G = { sleutel: privateKey.export({ type: 'pkcs8', format: 'pem' }), app_id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0' };
const vandaag = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const dag = (n) => { const d = new Date(vandaag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function iban(bank, nr) {   // verzonnen NL-IBAN met kloppend controlegetal
  const bban = bank + nr, num = (bban + 'NL00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let r = 0; for (const c of num) r = (r * 10 + Number(c)) % 97;
  return 'NL' + String(98 - r).padStart(2, '0') + bban;
}
const IB = { zak1: iban('ABNA', '0111222333'), zak2: iban('ABNA', '0444555666'), prive: iban('ABNA', '0777888999') };

// ── nagebootste Enable Banking ──
const M = { psu: 'business', accounts: [], opvragen: [], posten: {} };
function tx(ref, datum, bedrag, naam, tegen) {
  const af = bedrag < 0;
  return { entry_reference: ref, transaction_amount: { currency: 'EUR', amount: String(Math.abs(bedrag)) }, credit_debit_indicator: af ? 'DBIT' : 'CRDT', status: 'BOOK',
    booking_date: datum, value_date: datum, [af ? 'creditor' : 'debtor']: { name: naam }, [af ? 'creditor_account' : 'debtor_account']: tegen ? { iban: tegen } : undefined,
    remittance_information: ['omschrijving ' + naam] };
}
const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://x'); let body = '';
  req.on('data', (c) => body += c);
  req.on('end', function () {
    const stuur = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    const p = u.pathname;
    if (p === '/aspsps') return stuur(200, { aspsps: [{ name: 'ABN AMRO', country: 'NL', psu_types: ['personal', 'business'], maximum_consent_validity: 15552000 }] });
    if (p === '/auth') { M.laatsteAuth = JSON.parse(body); return stuur(200, { url: 'https://bank.example/login', authorization_id: 'a1' }); }
    if (p === '/sessions' && req.method === 'POST') {
      const id = 'sess-' + Math.random().toString(16).slice(2, 8);
      return stuur(200, { session_id: id, accounts: M.accounts.map((a) => ({ uid: a.uid, account_id: { iban: a.iban }, name: a.naam, currency: 'EUR', identification_hash: 'h-' + a.uid })),
        aspsp: { name: 'ABN AMRO', country: 'NL' }, psu_type: M.psu, access: { valid_until: new Date(Date.now() + 179 * 86400000).toISOString() } });
    }
    if (/^\/sessions\//.test(p)) return stuur(200, { status: 'AUTHORIZED', access: { valid_until: new Date(Date.now() + 179 * 86400000).toISOString() } });
    const m = /^\/accounts\/([^/]+)\/(balances|transactions)$/.exec(p);
    if (m) { M.opvragen.push(m[1] + ':' + m[2]); if (m[2] === 'balances') return stuur(200, { balances: [{ balance_type: 'CLBD', balance_amount: { currency: 'EUR', amount: '1.00' } }] });
      return stuur(200, { transactions: M.posten[m[1]] || [] }); }
    if (p === '/application') return stuur(200, { name: 'x', environment: 'PRODUCTION', active: true });
    stuur(404, {});
  });
});
function draai(args, stdin) {
  return new Promise(function (klaar) {
    const k = spawn(process.execPath, ['--no-warnings', 'bank-lezer.js'].concat(args), { env: { PATH: process.env.PATH, TZ: 'Europe/Amsterdam', BANK_DIR: BD,
      BANK_API_BASIS: 'http://127.0.0.1:' + server.address().port, BANK_RONDE_VERS_MS: '0' } });
    let o = ''; k.stdout.on('data', (c) => o += c); k.stderr.on('data', () => {});
    k.on('close', (code) => { let j = null; try { j = JSON.parse(o); } catch (x) {} klaar({ code, j, o }); });
    k.stdin.end(JSON.stringify(stdin || {}));
  });
}
async function koppel(soort, psu, accounts) {
  M.psu = psu; M.accounts = accounts;
  const r1 = await draai(['koppel-start', '--bank', 'ABN AMRO', '--soort', soort], G);
  const r2 = await draai(['koppel-af'], Object.assign({ state: M.laatsteAuth.state, code: 'c' }, G));
  return { start: r1.j, af: r2.j };
}
const telIn = (pad, sql, ...a) => { if (!fs.existsSync(pad)) return 0; const d = new DatabaseSync(pad, { readOnly: true }); try { return d.prepare(sql).get(...a).n; } catch (e) { return 0; } finally { d.close(); } };

server.listen(0, '127.0.0.1', async function () {
  try {
    // ── 1. privé-koppeling (personal) en een business-koppeling ──
    M.posten.up = [tx('p1', dag(-5), -20, 'Bakker')];
    let k = await koppel('personal', 'personal', [{ uid: 'up', iban: IB.prive, naam: 'Privé' }]);
    toets('privé-koppeling: geen zakelijk-vlag', k.af && k.af.ok && !k.af.zakelijk, k);
    await draai(['historie', k.af.sessie], G);
    const L = dag(-3);   // laatste uploaddatum in Facturen (hieronder)
    M.posten.uz1 = [
      tx('z1', dag(-60), -500, 'Leverancier Oud', IB.prive),        // vóór de naad: uploads zijn de bron
      tx('z2', dag(-9), -111.11, 'Leverancier A', 'NL02ABNA0123456789'),   // in de naad, upload heeft hem (rentedatum 1 dag eerder)
      tx('z3', L, -222.22, 'Leverancier B'),                          // laatste uploaddag, upload heeft hem (zelfde dag)
      tx('z4', L, -333.33, 'Leverancier C'),                          // laatste uploaddag, NIET in de upload (half geüpload): inlezen
      tx('z5', dag(-1), -444.44, 'Leverancier D'),                    // na L, upload heeft hem op L (2 dagen eerder): afgedekt
      tx('z6', dag(0), -555.55, 'Leverancier E'),                     // na L, nieuw
    ];
    M.posten.uz2 = [tx('y1', dag(-2), 1000, 'Klant')];
    k = await koppel('business', 'business', [{ uid: 'uz1', iban: IB.zak1, naam: 'Praktijk BV' }, { uid: 'uz2', iban: IB.zak2, naam: 'Holding BV' }]);
    toets('business-koppeling: ok, zakelijk, twee rekeningen', k.af && k.af.ok && k.af.zakelijk === true && k.af.rekeningen === 2, k.af);
    toets('koppel-start vroeg psu_type business', M.laatsteAuth.psu_type === 'business', M.laatsteAuth);
    const stand = JSON.parse(fs.readFileSync(path.join(BD, 'stand.json'), 'utf8'));
    const zakH = Object.keys(stand.rekeningen).filter((h) => stand.rekeningen[h].zakelijk);
    toets('stand.json: twee rekeningen zakelijk, privé niet', zakH.length === 2 && !Object.values(stand.rekeningen).find((r) => r.iban === IB.prive).zakelijk, Object.values(stand.rekeningen).map((r) => r.zakelijk));
    M.opvragen = [];
    let r = await draai(['historie', k.af.sessie], G);
    toets('historie business: zonder saldo-opvraag', r.j && r.j.ok && !M.opvragen.some((x) => /balances/.test(x)) && r.j.rekeningen.every((x) => x.zakelijk), { j: r.j, opv: M.opvragen });
    const ZAK = path.join(BD, 'zakelijk.sqlite'), PRIV = path.join(BD, 'transacties.sqlite'), CACHE = path.join(BD, 'cache.sqlite');
    toets('zakelijke posten in zakelijk.sqlite', telIn(ZAK, 'SELECT count(*) AS n FROM transacties') === 7, telIn(ZAK, 'SELECT count(*) AS n FROM transacties'));
    const zakRek = zakH.map((h) => h);
    toets('niet in de privé-database (posten)', telIn(PRIV, 'SELECT count(*) AS n FROM transacties WHERE rek IN (?, ?)', ...zakRek) === 0, null);
    toets('niet in de privé-database (rekeningen)', telIn(PRIV, 'SELECT count(*) AS n FROM rekeningen WHERE rek IN (?, ?)', ...zakRek) === 0, null);
    toets('niet in de cache (posten, saldo)', telIn(CACHE, 'SELECT count(*) AS n FROM tx WHERE rek IN (?, ?)', ...zakRek) === 0 && telIn(CACHE, 'SELECT count(*) AS n FROM saldo WHERE rek IN (?, ?)', ...zakRek) === 0, null);
    toets('zakelijk.sqlite 600', (fs.statSync(ZAK).mode & 0o777) === 0o600, (fs.statSync(ZAK).mode & 0o777).toString(8));
    toets('privé-post wel in de privé-database', telIn(PRIV, "SELECT count(*) AS n FROM transacties WHERE sleutel = 'e:p1'") === 1, null);

    // ── 2. privé-opdrachten zien ze niet ──
    r = await draai(['rekeningen'], G);
    toets('rekeningen: alleen privé + aantal zakelijk, geen IBAN', r.j.ok && r.j.rekeningen.length === 1 && r.j.zakelijk.aantal === 2 && r.o.indexOf(IB.zak1) < 0 && r.o.indexOf('Praktijk BV') < 0, r.j);
    r = await draai(['rekeningen', '--alle'], G);
    toets('rekeningen --alle: ook dan niet', r.j.rekeningen.length === 1 && r.o.indexOf(IB.zak2) < 0, r.j);
    r = await draai(['transacties', IB.zak1.slice(-4)], G);
    toets('transacties op een zakelijke rekening: geweigerd', r.j && r.j.ok === false, r.j);
    r = await draai(['saldo'], G);
    toets('saldo: alleen de privérekening', r.j && r.j.ok && r.j.saldi.length === 1 && r.o.indexOf('Praktijk') < 0, r.j);
    r = await draai(['zoek', '--rekening', 'Praktijk BV'], G);
    toets('zoek met een zakelijke rekening: geweigerd', r.j && r.j.ok === false, r.j);
    r = await draai(['zoek', '--tekst', 'Leverancier'], G);
    toets('zoek op tekst: geen zakelijke post', r.j && r.j.ok && r.o.indexOf('Leverancier') < 0, r.j);

    // ── 3. ronde: zakelijk alleen transacties ──
    M.opvragen = [];
    r = await draai(['ronde'], G);
    toets('ronde: geen saldo-opvraag voor zakelijk, wel transacties', r.j && r.j.ok !== false && !M.opvragen.some((x) => /^uz\d:balances/.test(x)) && M.opvragen.some((x) => /^uz1:transactions/.test(x)), { opv: M.opvragen, j: r.j });
    toets('na de ronde: nog steeds niets zakelijks in privé-database en cache', telIn(PRIV, 'SELECT count(*) AS n FROM transacties WHERE rek IN (?, ?)', ...zakRek) === 0 && telIn(CACHE, 'SELECT count(*) AS n FROM tx WHERE rek IN (?, ?)', ...zakRek) === 0, null);

    // ── 4. dicht bij twijfel: link personal, bank zegt business → zakelijk ──
    M.posten.uz3 = [];
    k = await koppel('personal', 'business', [{ uid: 'uz3', iban: iban('ABNA', '0999000111'), naam: 'Stichting' }]);
    const st2 = JSON.parse(fs.readFileSync(path.join(BD, 'stand.json'), 'utf8'));
    toets('link personal + bank business: zakelijk, afwijking gemeld', k.af.zakelijk === true && k.af.soort_afwijkend === 'personal/business' && st2.rekeningen['h-uz3'].zakelijk === true, k.af);

    // ── 5. Facturen: naad ──
    const D = require(path.resolve('facturen-db.js')), F = require(path.resolve('facturen.js'));
    const fdb = D.open(FD);
    fdb.db.prepare("INSERT INTO entiteit (sleutel, naam) VALUES ('tolgaarde', 'Praktijk Toets')").run();
    fdb.db.prepare("INSERT INTO entiteit (sleutel, naam) VALUES ('holding', 'Holding Toets')").run();
    const rid = 'a1b2c3d4e5f60718', rid2 = 'b1b2c3d4e5f60718';
    fdb.db.prepare("INSERT INTO rekening (id, entiteit, iban, bank, bank_formaat, controle) VALUES (?, 'tolgaarde', ?, 'ABN', 'abn_tab', 1)").run(rid, IB.zak1);
    fdb.db.prepare("INSERT INTO rekening (id, entiteit, iban, bank, bank_formaat, controle) VALUES (?, 'holding', ?, 'ABN', 'abn_tab', 1)").run(rid2, IB.zak2);
    fdb.db.prepare("INSERT INTO bank_bestand (id, sha256, formaat, geupload_door, geupload_op) VALUES ('c1b2c3d4e5f60718', ?, 'abn_tab', 'toets', '2026-11-01T10:00:00Z')").run('ab'.repeat(32));
    let i = 0;
    const up = (rek, datum, centen, tegen) => fdb.db.prepare("INSERT INTO bank_transactie (id, bestand, rekening, entiteit, eigen_iban, boekdatum, bedrag_centen, tegenpartij_iban, entry_ref, formaat, aangemaakt_op) VALUES (?, 'c1b2c3d4e5f60718', ?, ?, ?, ?, ?, ?, ?, 'abn_tab', '2026-11-01T10:00:00Z')")
      .run((++i).toString(16).padStart(16, '0'), rek, rek === rid ? 'tolgaarde' : 'holding', rek === rid ? IB.zak1 : IB.zak2, datum, centen, tegen || null, 'tab:' + i);
    up(rid, dag(-60), -50000, IB.prive); up(rid, dag(-10), -11111, 'NL02ABNA0123456789'); up(rid, L, -22222); up(rid, L, -44444);
    up(rid2, dag(-30), 777);
    const uploadsVoor = fdb.db.prepare("SELECT count(*) AS n FROM bank_transactie WHERE formaat = 'abn_tab'").get().n;

    // omzet-hulpje droog (op een kopie)
    const hulp = (extra) => { const p = spawnSync(process.execPath, ['--no-warnings', 'tools/facturen-bankluis-omzet.js', '--facturen-dir', FD, '--bank-dir', BD].concat(extra || []), { encoding: 'utf8' }); let j = null; try { j = JSON.parse(p.stdout); } catch (e) {} return { code: p.status, j, o: p.stdout + p.stderr }; };
    r = hulp();
    const r1 = r.j && r.j.rekeningen.find((x) => x.entiteit === 'tolgaarde');
    toets('omzet droog: 0 mogelijke dubbelen, 2 ingelezen (half geüploade dag + nieuw), 3 afgedekt', r.j && r.j.droog && r1 && r1.mogelijke_dubbelen === 0 && r1.bankluis_ingelezen === 2 && r.j.ronde_op_kopie.afgedekt === 3, r.j);
    toets('omzet droog: echte database ongewijzigd', fdb.db.prepare("SELECT count(*) AS n FROM rekening WHERE bank_formaat = 'bankluis'").get().n === 0, null);
    toets('omzet droog: uitvoer zonder IBAN en namen', r.o.indexOf(IB.zak1) < 0 && r.o.indexOf('Leverancier') < 0, null);
    toets('omzet droog: rekening zonder Facturen-rij overgeslagen', r.j.rekeningen.some((x) => x.overgeslagen === 'niet in Facturen'), r.j.rekeningen);
    // echt
    r = hulp(['--echt']);
    toets('omzet echt: twee rekeningen omgezet, auditregel', r.j && r.j.ok && r.j.omgezet.length === 2 && fdb.db.prepare("SELECT count(*) AS n FROM audit WHERE wat = 'rekening_wijzigen' AND wie LIKE 'machinekamer%'").get().n === 2, r.j);
    let ro = F.bankluisRonde(fdb, { nu: Date.now(), pad: PRIV });
    const bl = fdb.db.prepare("SELECT boekdatum, bedrag_centen FROM bank_transactie WHERE rekening = ? AND formaat = 'bankluis' AND verwijderd_op IS NULL ORDER BY boekdatum").all(rid);
    toets('ronde: alleen z4 (laatste dag, niet geüpload) en z6 (nieuw) ingelezen', bl.length === 2 && bl[0].bedrag_centen === -33333 && bl[1].bedrag_centen === -55555, { bl, ro });
    toets('ronde: uploads onaangeroerd', fdb.db.prepare("SELECT count(*) AS n FROM bank_transactie WHERE formaat = 'abn_tab' AND verwijderd_op IS NULL").get().n === uploadsVoor, null);
    toets('ronde: tweede rekening (geen overlap) leest y1', fdb.db.prepare("SELECT count(*) AS n FROM bank_transactie WHERE rekening = ? AND formaat = 'bankluis'").get(rid2).n === 1, null);
    toets('ronde: zonder padZakelijk vindt hij zakelijk.sqlite naast de privé-database', ro.ok && ro.nieuw === 3 && ro.afgedekt === 3 && ro.voor_naad === 1, ro);
    ro = F.bankluisRonde(fdb, { nu: Date.now(), pad: PRIV, padZakelijk: ZAK });
    toets('tweede ronde: niets nieuw, niets weg (idempotent)', ro.ok && ro.nieuw === 0 && ro.vervangen === 0, ro);
    const weigering = (function () { try { return require(path.resolve('facturen-bank.js')).leesBankbestand('111222333\tEUR\t' + dag(0).replace(/-/g, '') + '\t1,00\t0,00\t' + dag(0).replace(/-/g, '') + '\t-1,00\tBEA omschrijving\n',
      { rekeningen: fdb.db.prepare('SELECT * FROM rekening').all() }); } catch (e) { return 'gooide: ' + e.message; } })();
    toets('een TAB-upload voor de omgezette rekening wordt geweigerd (verkeerd_formaat)', !!weigering && weigering.ok === false && /bankkoppeling/.test(weigering.uitleg || ''), weigering);
    // rekening in beide databases → fout, niets ingelezen
    const pd = new DatabaseSync(PRIV); pd.prepare("INSERT INTO transacties (rek, sleutel, bron_id, status, datum, bedrag, herkomst_rij, eerste_gezien, laatst_gezien) VALUES ('h-uz2', 'e:dubbel', 'x', 'booked', ?, -1, 'bank', 'x', 'x')").run(dag(-1)); pd.close();
    ro = F.bankluisRonde(fdb, { nu: Date.now(), pad: PRIV, padZakelijk: ZAK });
    toets('rekening in beide databases: fout, niets ingelezen', !ro.ok && ro.fouten.some((f) => /privé- én de zakelijke/.test(f.melding)), ro);
  } catch (e) { fouten++; console.log('ROOD  onverwacht: ' + (e && e.stack || e)); }
  finally { server.close(); fs.rmSync(W, { recursive: true, force: true }); console.log(goed + ' groen, ' + fouten + ' rood'); process.exit(fouten ? 1 : 0); }
});
JS
