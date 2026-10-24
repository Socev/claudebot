#!/usr/bin/env bash
# Toetst de maandronde vaste lasten (wv776, 22-10-2026): vasteLastenBlok en vasteLastenRonde uit server.js (vm-context), met een
# nagebootste leesopdracht vaste-lasten. Toetst: vanaf de 3e, vorige kalendermaand (ook januari → december), één keer per maand,
# alleen het binnenblok en de updated-regel veranderen, controles gelijk aan vault_schrijf in bank.py (markering, IBAN, machtiging,
# saldo; markeringen elk één keer en in volgorde), alleen de vaste-lastenrekening, rechten blijven, geen tmp-bestand achter,
# poort "geboekte post van de lopende maand" (stil wachten tot de 10e, dan één box-rij per maand per reden), geen bovengrens,
# voorlopende podklok, staat niet schrijfbaar, geen bedragen in log of box.
# Raakt de banken, /opt/data/bank en de echte vault niet. Gebruik: bash test/vaste-lasten-ronde.sh
#
# Droge ronde op echte gegevens (machinekamer, op een VACUUM INTO-kopie van de database en een kopie van de pagina):
#   VL_DROOG_BANK_DIR=<map met transacties.sqlite> VL_DROOG_PAGINA=<kopie van de pagina> VL_DROOG_DATUM=2026-11-03 bash test/vaste-lasten-ronde.sh
# Dan draait de echte leesopdracht (bank-lezer.js) en schrijft de ronde alleen in de kopie.
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), vm = require('vm');
const { spawn } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-ronde-'));
const droog = process.env.VL_DROOG_BANK_DIR ? { bank: process.env.VL_DROOG_BANK_DIR, pagina: process.env.VL_DROOG_PAGINA, datum: process.env.VL_DROOG_DATUM || '2026-11-03' } : null;
const BD = droog ? droog.bank : path.join(W, 'bank'); if (!droog) fs.mkdirSync(BD, { mode: 0o700 });
const VAULT = path.join(W, 'vault'), PAG = path.join(VAULT, '20_Prive', 'Financien', 'Huishoudbudget en vaste lasten.md');
fs.mkdirSync(path.dirname(PAG), { recursive: true }); fs.mkdirSync(path.join(VAULT, '00_Systeem', 'Meldingen'), { recursive: true });
const BOX = path.join(VAULT, '00_Systeem', 'Meldingen', 'machinekamer.md');
fs.writeFileSync(BOX, '# box\n\n## [direct] 2026-10-20 10:00 — oude rij\n- status: open\n');

const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('// ── wv680: bankluis'), b = src.indexOf('// ── einde bankluis ──');
const k1 = src.indexOf('function smalKind('), k2 = src.indexOf('async function smalSbRpc(');
const logs = [];
const env = { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', BANK_DIR: BD };
const g = { VV: () => require(require('path').resolve('vault-veilig.js')), require, fs, path, crypto, Buffer, console, URL, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, VAULT: VAULT, SECRET: 'x'.repeat(40),
  __dirname: process.cwd(), process: { env: env, execPath: process.execPath, pid: process.pid }, spawn: spawn,
  fetch: async function () { throw new Error('geen kluis in deze toets'); }, appSbRpc: async function () { throw new Error('geen rpc in deze toets'); },
  logError: (w, e) => logs.push(w + ': ' + (e && e.message || e)), schrijfLog: (x) => logs.push(x), nu: () => 'NU', velden: (o) => JSON.stringify(o),
  reqPath: (req) => (req.url || '').split('?')[0], rolPoort: (res, verder) => verder(), rol: { eerste: true }, rolPrimair: () => true, rolEerste: Promise.resolve(), ROL_START_WACHT_MS: 50 };
const ctx = vm.createContext(g);
vm.runInContext(src.slice(k1, k2) + '\n' + src.slice(a, b) + '\n;globalThis.__h = { vasteLastenRonde, vasteLastenBlok, vasteLastenVorigeMaand };', ctx, { filename: 'server.js#bank' });
const h = ctx.__h;

(async function () {
  if (droog) {
    // ── droge ronde: echte leesopdracht op de kopie, schrijft alleen in de kopie van de pagina ──
    const voor = fs.readFileSync(droog.pagina, 'utf8');
    const u = await h.vasteLastenRonde({ datum: droog.datum, pagina: droog.pagina });
    const na = fs.readFileSync(droog.pagina, 'utf8');
    const buiten = (t) => t.replace(/<!-- vaste-lasten:tabel:begin -->[\s\S]*<!-- vaste-lasten:tabel:eind -->/, '').replace(/^updated: .*$/m, '');
    console.log(JSON.stringify(u));
    toets('droog: ronde bijgewerkt', u.gedaan === true && u.uitkomst === 'bijgewerkt', [u, logs]);
    toets('droog: buiten het binnenblok en updated niets veranderd', buiten(voor) === buiten(na));
    toets('droog: updated = ' + droog.datum, new RegExp('^updated: ' + droog.datum + '$', 'm').test(na));
    const st = /\*Stand ([0-9-]+),/.exec(na); console.log('Stand-regel: ' + (st && st[1]));
    toets('droog: staat in de kopie van BANK_DIR', JSON.parse(fs.readFileSync(path.join(BD, 'vaste-lasten-ronde.json'), 'utf8')).klaar === true);
    console.log('\n' + goed + ' groen, ' + fouten + ' rood'); process.exit(fouten ? 1 : 0);
  }

  // ── vasteLastenBlok ──
  const PAGINA = '---\ntype: x\nupdated: 2026-10-22\n---\n\n# Kop\n\nIntro met updated: 2020-01-01 in de tekst.\n\n<!-- vaste-lasten:begin -->\n<!-- vaste-lasten:tabel:begin -->\noude tabel\n<!-- vaste-lasten:tabel:eind -->\n\nhandwerk onder\n<!-- vaste-lasten:eind -->\n\nrest\n';
  const MD = '*Stand 31-10-2026, automatisch.*\n\n| Post | Per maand |\n|---|--:|\n| Energie (Tibber) | € 376,90 |\n';
  let n = h.vasteLastenBlok(PAGINA, MD, '2026-11-03');
  toets('blok: binnenblok vervangen, updated in de frontmatter bijgewerkt', n.gewijzigd && n.tekst.indexOf('oude tabel') < 0 && n.tekst.indexOf(MD.trim()) > 0 && /^updated: 2026-11-03$/m.test(n.tekst), n);
  toets('blok: rest van de pagina gelijk (ook een updated-tekst verderop)', n.tekst.replace(MD.trim(), 'oude tabel').replace('updated: 2026-11-03', 'updated: 2026-10-22') === PAGINA);
  toets('blok: zelfde invoer nog eens → ongewijzigd', h.vasteLastenBlok(n.tekst, MD, '2026-11-03').gewijzigd === false);
  for (const [naam, md] of [['IBAN', MD + 'NL91ABNA0417164300\n'], ['machtiging', MD + 'machtiging 123\n'], ['incassant', MD + 'Incassant-ID\n'], ['saldo', MD + 'Saldo € 3\n'],
    ['markering', MD + '<!-- vaste-lasten:tabel:eind -->\n'], ['commentaar-einde', MD + '-->\n'], ['leeg', '  \n'], ['geen tekst', null]]) {
    const x = h.vasteLastenBlok(PAGINA, md, '2026-11-03');
    toets('blok: weigert ' + naam, x.tekst == null && typeof x.reden === 'string', x);
  }
  for (const [naam, t] of [['binnenmarkering weg', PAGINA.replace('<!-- vaste-lasten:tabel:begin -->\n', '')], ['buitenmarkering dubbel', PAGINA + '<!-- vaste-lasten:begin -->\n'],
    ['volgorde om', PAGINA.replace('<!-- vaste-lasten:begin -->', 'X').replace('rest\n', 'rest\n<!-- vaste-lasten:begin -->\n')]]) {
    const x = h.vasteLastenBlok(t, MD, '2026-11-03');
    toets('blok: weigert pagina met ' + naam, x.tekst == null && /markeringen/.test(x.reden), x);
  }
  toets('vorige maand: 2026-11-03 → 2026-10, 2027-01-05 → 2026-12', h.vasteLastenVorigeMaand('2026-11-03') === '2026-10' && h.vasteLastenVorigeMaand('2027-01-05') === '2026-12');

  // ── vasteLastenRonde (nagebootste leesopdracht) ──
  const VRAGEN = [];
  let NIEUWSTE = '2026-11-02';
  let ANTW = (mnd) => ({ ok: true, maand: mnd, standaard_rekening: true, peildatum: mnd + '-31', nieuwste_post: NIEUWSTE, verschil: [{ wat: 'anders', post: 'Mobiel', van: 112.05, naar: 116.32 }],
    tabel_md: '*Stand eind ' + mnd + ', automatisch.*\n\n| Post | Per maand |\n|---|--:|\n| Mobiel (KPN) | € 116,32 |\n' });
  ctx.bankKind = async function (args) { VRAGEN.push(args.slice()); return { code: 0, j: ANTW(args[2]) }; };
  const STAAT = path.join(BD, 'vaste-lasten-ronde.json');
  fs.writeFileSync(PAG, PAGINA); fs.chmodSync(PAG, 0o640);   // umask van de pod is 077: rechten expliciet
  const boxRijen = () => (fs.readFileSync(BOX, 'utf8').match(/^## \[direct\] .* vaste lasten /mg) || []).length;
  const nieuweRonde = () => { vm.runInContext('vasteLastenGeheugen = { klaar: null, fout: null, staatFoutDag: null }', ctx); };   // als na een herstart

  let u = await h.vasteLastenRonde({ datum: '2026-11-02' });
  toets('ronde: de 2e → te vroeg, geen opvraag', !u.gedaan && VRAGEN.length === 0, u);
  NIEUWSTE = '2026-10-31';
  u = await h.vasteLastenRonde({ datum: '2026-11-03' });
  toets('ronde: de 3e, nog geen geboekte post van november → stil wachten, pagina gelijk, geen box', !u.gedaan && !u.fout && /wacht/.test(u.reden) && VRAGEN.length === 1 &&
    fs.readFileSync(PAG, 'utf8') === PAGINA && boxRijen() === 0, u);
  NIEUWSTE = null;
  u = await h.vasteLastenRonde({ datum: '2026-11-03' });
  toets('ronde: geen enkele post → wachten', !u.gedaan && !u.fout, u);
  NIEUWSTE = '2026-11-02';
  u = await h.vasteLastenRonde({ datum: '2026-11-03' });
  const na = fs.readFileSync(PAG, 'utf8');
  toets('ronde: de 3e met post van 2-11 → maand 2026-10 opgevraagd, bijgewerkt, 1 verschil', u.gedaan && u.uitkomst === 'bijgewerkt' && u.maand === '2026-10' && u.verschillen === 1 &&
    VRAGEN[VRAGEN.length - 1].join(' ') === 'vaste-lasten --maand 2026-10', [u, VRAGEN]);
  toets('ronde: alleen binnenblok + updated veranderd', na.indexOf('Stand eind 2026-10') > 0 && /^updated: 2026-11-03$/m.test(na) && na.indexOf('handwerk onder') > 0 && na.indexOf('Intro met updated: 2020-01-01') > 0 &&
    na.replace(/<!-- vaste-lasten:tabel:begin -->[\s\S]*<!-- vaste-lasten:tabel:eind -->/, '').replace(/^updated: .*$/m, '') === PAGINA.replace(/<!-- vaste-lasten:tabel:begin -->[\s\S]*<!-- vaste-lasten:tabel:eind -->/, '').replace(/^updated: .*$/m, ''));
  toets('ronde: rechten van de pagina blijven (640), geen tmp-bestand achter', (fs.statSync(PAG).mode & 0o777) === 0o640 && fs.readdirSync(path.dirname(PAG)).length === 1, [(fs.statSync(PAG).mode & 0o777).toString(8), fs.readdirSync(path.dirname(PAG))]);
  toets('ronde: staat klaar, 600, zonder bedragen', JSON.parse(fs.readFileSync(STAAT, 'utf8')).klaar === true && (fs.statSync(STAAT).mode & 0o777) === 0o600 && !/116[.,]32|112[.,]05|€|Mobiel/.test(fs.readFileSync(STAAT, 'utf8')));
  let vr = VRAGEN.length;
  u = await h.vasteLastenRonde({ datum: '2026-11-03' });
  toets('ronde: tweede ronde dezelfde maand → al gedaan, geen opvraag', !u.gedaan && u.reden === 'al gedaan' && VRAGEN.length === vr, u);
  nieuweRonde();
  u = await h.vasteLastenRonde({ datum: '2026-11-25' });
  toets('ronde: na een herstart later in de maand → al gedaan (staat op schijf)', !u.gedaan && u.reden === 'al gedaan' && VRAGEN.length === vr, u);
  NIEUWSTE = '2027-01-02';
  u = await h.vasteLastenRonde({ datum: '2027-01-03' });
  toets('ronde: januari → december van het jaar ervoor', u.gedaan && u.maand === '2026-12' && VRAGEN[VRAGEN.length - 1][2] === '2026-12', u);
  NIEUWSTE = '2027-01-20';
  u = await h.vasteLastenRonde({ datum: '2027-01-20' });
  toets('ronde: geen bericht, geen box bij succes', boxRijen() === 0 && !u.gedaan, u);
  // podklok loopt voor: echte 28-10, pod denkt 3-11 → nieuwste post is van oktober → niet schrijven
  fs.writeFileSync(STAAT, '{}'); nieuweRonde(); NIEUWSTE = '2026-10-28';
  const voorKlok = fs.readFileSync(PAG, 'utf8');
  u = await h.vasteLastenRonde({ datum: '2026-11-03' });
  toets('ronde: voorlopende podklok (nieuwste post 28-10) → geen halve maand in de vault', !u.gedaan && fs.readFileSync(PAG, 'utf8') === voorKlok, u);
  // geen bovengrens: de 20e lukt het alsnog (Fable #3)
  NIEUWSTE = '2026-11-19';
  u = await h.vasteLastenRonde({ datum: '2026-11-20' });
  toets('ronde: de 20e (pod lag stil) → alsnog bijgewerkt', u.gedaan && u.maand === '2026-10', u);

  // fouten: de pagina blijft ongemoeid, één box-rij per maand per reden
  NIEUWSTE = '2027-02-02';
  const voorFout = fs.readFileSync(PAG, 'utf8');
  ANTW = (mnd) => ({ ok: true, maand: mnd, standaard_rekening: true, nieuwste_post: NIEUWSTE, verschil: [], tabel_md: '| Post | x |\n| ABN NL91ABNA0417164300 | 1 |\n' });
  u = await h.vasteLastenRonde({ datum: '2027-02-03' });
  toets('ronde: tabel met IBAN → niet geschreven, fout, pagina gelijk', !u.gedaan && /IBAN/.test(u.fout) && fs.readFileSync(PAG, 'utf8') === voorFout, u);
  toets('ronde: box-rij met maand en voorstel, zonder IBAN of bedrag', boxRijen() === 1 && /vaste lasten 2027-01: maandtabel niet bijgewerkt[\s\S]*bank\.py vaste-lasten maand=2027-01/.test(fs.readFileSync(BOX, 'utf8')) &&
    !/NL91|417164300/.test(fs.readFileSync(BOX, 'utf8')), fs.readFileSync(BOX, 'utf8').slice(0, 800));
  u = await h.vasteLastenRonde({ datum: '2027-02-03' });
  toets('ronde: zelfde fout 18:00 → geen tweede box-rij; staat niet klaar', !u.gedaan && boxRijen() === 1 && JSON.parse(fs.readFileSync(STAAT, 'utf8')).klaar === false, u);
  nieuweRonde();
  u = await h.vasteLastenRonde({ datum: '2027-02-05' });
  toets('ronde: zelfde fout dagen later, na herstart → nog steeds één box-rij (per maand per reden)', !u.gedaan && boxRijen() === 1, u);
  ANTW = (mnd) => ({ ok: true, maand: mnd, standaard_rekening: false, nieuwste_post: NIEUWSTE, verschil: [], tabel_md: '| Post | x |\n' });
  u = await h.vasteLastenRonde({ datum: '2027-02-05' });
  toets('ronde: niet de vaste-lastenrekening → fout, pagina gelijk, andere reden = nieuwe box-rij', /vaste-lastenrekening/.test(u.fout || '') && fs.readFileSync(PAG, 'utf8') === voorFout && boxRijen() === 2, u);
  ANTW = (mnd) => ({ ok: true, maand: '2026-05', standaard_rekening: true, nieuwste_post: NIEUWSTE, verschil: [], tabel_md: '| Post | x |\n' });
  u = await h.vasteLastenRonde({ datum: '2027-02-05' });
  toets('ronde: andere maand terug → fout', /niet maand 2027-01/.test(u.fout || ''), u);
  ANTW = () => ({ ok: false, fout: 'archief niet leesbaar' });
  u = await h.vasteLastenRonde({ datum: '2027-02-06' });
  toets('ronde: leesopdracht faalt → fout met reden', /geen uitkomst: archief niet leesbaar/.test(u.fout || ''), u);
  ANTW = (mnd) => ({ ok: true, maand: mnd, standaard_rekening: true, nieuwste_post: NIEUWSTE, verschil: [], tabel_md: '| Post | x |\n' });
  fs.writeFileSync(PAG, voorFout.replace('<!-- vaste-lasten:tabel:eind -->', ''));
  u = await h.vasteLastenRonde({ datum: '2027-02-07' });
  toets('ronde: markering weg → niet geschreven', /markeringen/.test(u.fout || '') && fs.readFileSync(PAG, 'utf8').indexOf('<!-- vaste-lasten:tabel:eind -->') < 0, u);
  fs.writeFileSync(PAG, voorFout);
  u = await h.vasteLastenRonde({ datum: '2027-02-07' });
  toets('ronde: na herstel van de pagina → bijgewerkt', u.gedaan && u.uitkomst === 'bijgewerkt', u);
  // ABN leest de nieuwe maand niet: stil tot de 9e, op de 10e één box-rij, daarna niet nog eens
  ANTW = (mnd) => ({ ok: true, maand: mnd, standaard_rekening: true, nieuwste_post: '2027-02-27', verschil: [], tabel_md: '| Post | x |\n' });
  let bx = boxRijen();
  u = await h.vasteLastenRonde({ datum: '2027-03-09' });
  toets('ronde: de 9e zonder post van maart → stil', !u.fout && boxRijen() === bx, u);
  u = await h.vasteLastenRonde({ datum: '2027-03-10' });
  toets('ronde: de 10e zonder post van maart → fout + één box-rij', /nog geen geboekte post van 2027-03/.test(u.fout || '') && boxRijen() === bx + 1, u);
  u = await h.vasteLastenRonde({ datum: '2027-03-12' });
  toets('ronde: de 12e nog steeds niet → geen tweede box-rij', boxRijen() === bx + 1, u);
  ANTW = (mnd) => ({ ok: true, maand: mnd, standaard_rekening: true, nieuwste_post: '2027-03-12', verschil: [], tabel_md: '| Post | x |\n' });
  u = await h.vasteLastenRonde({ datum: '2027-03-12' });
  toets('ronde: daarna toch gelezen → alsnog bijgewerkt', u.gedaan && u.maand === '2027-02', u);
  // staat niet schrijfbaar: pagina één keer, daarna het geheugen; één box-rij per dag
  ANTW = (mnd) => ({ ok: true, maand: mnd, standaard_rekening: true, nieuwste_post: '2027-04-02', verschil: [], tabel_md: '| Post | april |\n' });
  fs.rmSync(STAAT); fs.mkdirSync(STAAT);   // een map op de plek van het bestand: schrijven (rename) faalt
  bx = boxRijen(); vr = VRAGEN.length;
  u = await h.vasteLastenRonde({ datum: '2027-04-03' });
  toets('ronde: staat niet schrijfbaar → pagina toch bijgewerkt, één box-rij', u.gedaan && boxRijen() === bx + 1 && /geheugen van de ronde niet schrijfbaar/.test(fs.readFileSync(BOX, 'utf8')), u);
  u = await h.vasteLastenRonde({ datum: '2027-04-03' });
  toets('ronde: tweede ronde → al gedaan uit het geheugen, geen opvraag, geen box-rij', !u.gedaan && u.reden === 'al gedaan' && VRAGEN.length === vr + 1 && boxRijen() === bx + 1, u);
  fs.rmdirSync(STAAT);
  // logregels: geen bedragen of tabeltekst
  toets('log: geen bedragen of tabeltekst', logs.every((l) => !/€|116|112|Mobiel|NL91/.test(l)), logs);

  // ── bankRonde roept de maandronde aan, na de PayPal-stap, met de poortvelden; alleen aantallen naar n8n ──
  const br = src.slice(src.indexOf('async function bankRonde()'), src.indexOf('// Asynchroon (Fable wv685 #5)'));
  toets('bankRonde: vasteLastenRonde na de PayPal-stap, in try/catch, zonder invoer van buiten', br.indexOf('paypalNaBankRonde') < br.indexOf('vasteLastenRonde(') &&
    /try \{\s*const v = await vasteLastenRonde\(\);/.test(br) &&
    /uit\.vaste_lasten = \{ maand: v\.maand, uitkomst: v\.uitkomst, verschillen: v\.verschillen, fout: v\.fout \}/.test(br));
  toets('pagina en datum alleen uit code (niet uit /smal/bank)', !/vasteLastenRonde\(\{/.test(src.replace(/^\s*\/\/.*$/mg, '')) && src.split('vasteLastenRonde(').length === 3);

  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  fs.rmSync(W, { recursive: true, force: true });
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  onverwacht: ' + (e && e.stack || e)); process.exit(1); });
JS
