#!/usr/bin/env bash
# Toetst tokenteller.js (wv1742, App TokenCounter; vervolg wv1247) en de koppeling in server.js. Toetst: per soort (gesorteerd, aandeel,
# "Agents van Socev" als niet gemeten, nooit als 0), per dag in vaste groepen (overig vangt de rest, oplopend op datum), top 10, signalen
# in vaste volgorde met uitleg, geen titel of sessie-id in het antwoord, vaste plek zonder kluslabels en gespreksonderdelen, dag met
# klussen (duurste eerst, optelling per soort, kapotte regel geteld, ongeldige datum = null, ontbrekende dag = leeg), symlink en te
# groot bestand niet gelezen, tankUit; in server.js: dispatch, 404 zonder module, teller, stil bij 200, /health, RELEASE_OPTIONEEL, CI.
# Alle toetsdata is verzonnen. Raakt niets buiten een wegwerpmap. Gebruik: bash test/tokenteller.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const T = require('./tokenteller.js');
const VV = require('./vault-veilig.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }

const V = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-')));
const M = path.join(V, '00_Systeem', 'Tokens');
fs.mkdirSync(path.join(M, 'klussen'), { recursive: true });
const sam = {
  gegenereerd_op: '2030-01-03T05:20:00.000Z', periode: { van: '2030-01-01', tot: '2030-01-02', dagen: 2 }, dollars_per_euro: 1.25,
  totaal: { calls: 100, totaal_invoer: 1000000, uitvoer: 5000, usd: 125, eur: 100 },
  per_soort: [
    { soort: 'routine', naam: 'Routines (n8n)', calls: 10, tokens: 100, usd: 25, eur: 20 },
    { soort: 'werkvoorraad-agent', naam: 'Agents (machinekamer)', calls: 50, tokens: 800, usd: 75, eur: 60 },
    { soort: 'proef', naam: 'Proefsessies', calls: 1, tokens: 1, usd: 1.25, eur: 1 },
    { soort: 'oud (vóór wv1247)', naam: 'oud (vóór wv1247)', calls: 1, tokens: 1, usd: 1.25, eur: 1 },
  ],
  per_dag_soort: [
    { datum: '2030-01-02', soorten: { 'werkvoorraad-agent': 30, routine: 10, proef: 1, 'cijfer-meester': 0.5 } },
    { datum: '2030-01-01', soorten: { 'werkvoorraad-agent': 30, routine: 10, 'gesprek-hoofd': 2 } },
    { datum: 'kapot', soorten: { routine: 1 } },
  ],
  duurste_klussen: Array.from({ length: 12 }, function (_, i) {
    return { datum: '2030-01-02', soort: i === 0 ? 'gesprek-hoofd' : 'werkvoorraad-agent', onderdeel: i === 0 ? 'interactief (Voorbeeld)' : 'werkvoorraad-agent',
      wv: i === 0 ? null : 'wv' + (900 + i), klus_label: i === 0 ? 'geheim gesprek' : 'machinekamer:wv' + (900 + i) + ' proefklus-' + i, titel: 'OPDRACHTTEKST',
      sessie: 'aaaaaaaa-0000-0000-0000-000000000000', model: 'claude-opus-5-5', account: 1, calls: 10, duur_min: 30 + i,
      startcontext: 50000, eindcontext: 350000, usd: 30 - i, eur: (30 - i) / 1.25, signalen: ['eindcontext > 300k', 'verzonnen signaal'] };
  }),
  signalen: { 'nacontrole los op Opus': { klussen: 2, eur: 3 }, 'eindcontext > 300k': { klussen: 5, eur: 50 } },
};
fs.writeFileSync(path.join(M, 'samenvatting.json'), JSON.stringify(sam));
const k = function (o) { return JSON.stringify(Object.assign({ datum: '2030-01-02', sessie: 'bbbbbbbb-1111', titel: 'OPDRACHTTEKST', model: 'claude-opus-5-5', account: 2,
  begin: '2030-01-02T08:00:00.000Z', duur_min: 10, calls: 5, startcontext: 1000, eindcontext: 2000, totaal_invoer: 900, uitvoer: 100, afgebroken: false, signalen: [] }, o)); };
fs.writeFileSync(path.join(M, 'klussen', '2030-01-02-pod.jsonl'), [
  k({ soort: 'routine', onderdeel: 'voorbeeldwachter', usd: 2.5 }),
  k({ soort: 'werkvoorraad-agent', onderdeel: 'werkvoorraad-agent', wv: 'wv901', klus_label: 'machinekamer:wv901 iets-bouwen', usd: 12.5, afgebroken: true, signalen: ['afgebroken op de bovengrens'] }),
  '{kapot',
  k({ soort: 'gesprek-hoofd', onderdeel: 'interactief (Voorbeeld)', klus_label: 'nooit tonen', usd: 1.25 }),
  '',
].join('\n'));
fs.writeFileSync(path.join(M, 'klussen', '2030-01-01-pod.jsonl'), '');
fs.writeFileSync(path.join(M, 'klussen', 'LEESMIJ.md'), 'x');

const tt = T.maak({ vault: V, vv: VV });
const s = tt.stand({ vast: false, tank: { account1: { vijf_uur: 0.5 }, account2: null } });
const json = JSON.stringify(s);
// 1 per soort
toets('1a ok en bron', s.ok === true && s.bron === 'tokenboekhouding' && s.gemeten_op === '2030-01-03T05:20:00.000Z', s);
toets('1b soorten duurste eerst', s.soorten[0].soort === 'werkvoorraad-agent' && s.soorten[1].soort === 'routine', s.soorten);
toets('1c aandeel', s.soorten[0].aandeel === 0.6, s.soorten[0]);
toets('1d oud blijft zijn eigen soort (geen onbekend)', s.soorten.some(function (r) { return r.soort === 'oud (vóór wv1247)' && r.groep === 'overig'; }), s.soorten);
const sa = s.soorten.find(function (r) { return r.soort === 'socev-agent'; });
toets('1e Agents van Socev: niet gemeten, geen 0', sa && sa.niet_gemeten === true && sa.eur === null, sa);
toets('1f totaal eur en tokens', s.totaal.eur === 100 && s.totaal.tokens === 1005000, s.totaal);
// 2 per dag
toets('2a per dag oplopend, kapotte datum weg', s.per_dag.length === 2 && s.per_dag[0].datum === '2030-01-01', s.per_dag);
toets('2b vaste groepen, rest in overig', s.per_dag[1].delen.agents === 30 && s.per_dag[1].delen.routines === 10 && s.per_dag[1].delen.overig === 1.5 && s.per_dag[1].eur === 41.5, s.per_dag[1]);
toets('2c elke groep in elke dag (0 waar niets)', s.per_dag[0].delen.managers === 0 && Object.keys(s.per_dag[0].delen).length === T.GROEPEN.length, s.per_dag[0]);
toets('2d groepen in vaste volgorde', s.groepen.map(function (g) { return g.id; }).join() === 'agents,routines,gesprek-mk,gesprek-hoofd,managers,overig', s.groepen);
// 3 duurste klussen
toets('3a top 10', s.duurste.length === 10, s.duurste.length);
toets('3b label zonder machinekamer:', s.duurste[1].label === 'wv901 proefklus-1', s.duurste[1]);
toets('3c gesprek zonder label', s.duurste[0].label === null && s.duurste[0].soort === 'gesprek-hoofd', s.duurste[0]);
toets('3d onbekend signaal weg', s.duurste[1].signalen.join() === 'eindcontext > 300k', s.duurste[1].signalen);
toets('3e geen titel en geen sessie in het antwoord', json.indexOf('OPDRACHTTEKST') < 0 && json.indexOf('aaaaaaaa') < 0 && json.indexOf('geheim gesprek') < 0);
// 4 signalen
toets('4a vaste volgorde en alle vier', s.signalen.map(function (x) { return x.naam; }).join('|') === 'eindcontext > 300k|duur > 120 min|afgebroken op de bovengrens|nacontrole los op Opus', s.signalen);
toets('4b ontbrekend signaal = 0, met uitleg', s.signalen[1].klussen === 0 && s.signalen[1].eur === 0 && /twee uur/.test(s.signalen[1].uitleg), s.signalen[1]);
toets('4c aandeel signaal', s.signalen[0].aandeel === 0.5, s.signalen[0]);
// 5 dagen en tank
toets('5a dagen met klussen, nieuwste eerst, alleen *-pod.jsonl', s.dagen.join() === '2030-01-02,2030-01-01', s.dagen);
toets('5b tank doorgegeven', s.tank && s.tank.account1.vijf_uur === 0.5, s.tank);
// 6 vaste plek
const sv = tt.stand({ vast: true });
toets('6a vaste plek: geen kluslabels', sv.vaste_plek === true && sv.duurste.every(function (x) { return x.label === null; }), sv.duurste[1]);
toets('6b vaste plek: geen onderdeel bij gesprekken', sv.duurste[0].onderdeel === null && sv.duurste[1].onderdeel === 'werkvoorraad-agent', sv.duurste.slice(0, 2));
toets('6c vaste plek: wv en bedragen wel', sv.duurste[1].wv === 'wv901' && sv.duurste[1].eur === 23.2, sv.duurste[1]);
// 7 dag
const d = tt.dag('2030-01-02', {});
const dj = JSON.stringify(d);
toets('7a dag: drie klussen, kapotte regel geteld', d.aantal === 3 && d.kapot === 1, d);
toets('7b duurste eerst', d.klussen[0].wv === 'wv901' && d.klussen[0].afgebroken === true && d.klussen[0].signalen[0] === 'afgebroken op de bovengrens', d.klussen[0]);
toets('7c eur uit de koers als het veld ontbreekt', d.klussen[0].eur === 10 && d.eur === 13, d.klussen[0]);
toets('7d optelling per soort', d.soorten[0].soort === 'werkvoorraad-agent' && d.soorten[0].klussen === 1 && d.soorten.length === 3, d.soorten);
toets('7e geen titel, sessie of gesprekslabel', dj.indexOf('OPDRACHTTEKST') < 0 && dj.indexOf('bbbbbbbb') < 0 && dj.indexOf('nooit tonen') < 0);
toets('7f tokens uit invoer + uitvoer', d.klussen[0].tokens === 1000, d.klussen[0]);
toets('7g account 2 en begin', d.klussen[0].account === 2 && d.klussen[0].begin === '2030-01-02T08:00:00.000Z', d.klussen[0]);
toets('7h ongeldige datum = null', tt.dag('../../x', {}) === null && tt.dag('2030-1-2', {}) === null);
toets('7i dag zonder bestand = leeg', tt.dag('2030-02-01', {}).leeg === true);
toets('7j lege dag = 0 klussen', tt.dag('2030-01-01', {}).aantal === 0);
toets('7k vaste plek dag: geen label', tt.dag('2030-01-02', { vast: true }).klussen[0].label === null);
// 8 symlink en grootte
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-l-')));
fs.mkdirSync(path.join(W, '00_Systeem', 'Tokens', 'klussen'), { recursive: true });
fs.symlinkSync(path.join(M, 'samenvatting.json'), path.join(W, '00_Systeem', 'Tokens', 'samenvatting.json'));
fs.symlinkSync(path.join(M, 'klussen', '2030-01-02-pod.jsonl'), path.join(W, '00_Systeem', 'Tokens', 'klussen', '2030-01-02-pod.jsonl'));
const tl = T.maak({ vault: W, vv: VV });
const sl = tl.stand({});
toets('8a samenvatting als symlink: niet gelezen', sl.leeg === true && !!sl.fout && !sl.soorten, sl);
const dl = tl.dag('2030-01-02', {});
toets('8b klussendag als symlink: niet gelezen', !!dl.fout && dl.aantal === 0, dl);
const X = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-m-')));
fs.mkdirSync(path.join(X, '00_Systeem'), { recursive: true });
fs.symlinkSync(M, path.join(X, '00_Systeem', 'Tokens'));
toets('8c Tokens-map als symlink: niet gelezen', T.maak({ vault: X, vv: VV }).stand({}).leeg === true);
const G = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-g-')));
fs.mkdirSync(path.join(G, '00_Systeem', 'Tokens'), { recursive: true });
fs.writeFileSync(path.join(G, '00_Systeem', 'Tokens', 'samenvatting.json'), Buffer.alloc(5 * 1024 * 1024, 32));
toets('8d te groot bestand: niet ingelezen', T.maak({ vault: G, vv: VV }).stand({}).fout === 'De tokenboekhouding is nu niet te lezen.');
toets('8e geen boekhouding = leeg met uitleg', T.maak({ vault: os.tmpdir() + '/bestaat-niet-' + Date.now(), vv: VV }).stand({}).fout === 'Er is nog geen tokenboekhouding.');
// 9 tankUit
const tk = T.tankUit({ laatste: { gemeten_op: '2030-01-02T10:00:00Z', vijf_uur: '0.25', zeven_dagen: 0.5, status: 'ok', geheim: 'x' }, account2: null });
toets('9a tankUit: getallen, tijd, geen vreemde velden', tk.account1.vijf_uur === 0.25 && tk.account1.gemeten_op === '2030-01-02T10:00:00.000Z' && tk.account2 === null && JSON.stringify(tk).indexOf('geheim') < 0, tk);
toets('9b tankUit(null) = null', T.tankUit(null) === null);

// 11 grenzen en vreemde invoer (Opus-review wv1742)
const R = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-r-')));
const RM = path.join(R, '00_Systeem', 'Tokens'); fs.mkdirSync(path.join(RM, 'klussen'), { recursive: true });
fs.writeFileSync(path.join(RM, 'klussen', '2030-03-01-pod.jsonl'), [
  JSON.stringify({ soort: 'constructor', usd: 1 }), JSON.stringify({ soort: 'routine', usd: 2, signalen: [['duur > 120 min'], 'toString', 'duur > 120 min'], onderdeel: 'Bel nu 0612345678!! klik hier', model: '<b>x</b>' }),
  '[1,2]', 'null'].join('\n'));
const tr = T.maak({ vault: R, vv: VV });
const dr = tr.dag('2030-03-01', {});
toets('11a soort "constructor" raakt het prototype niet en telt mee', dr.soorten.some(function (x) { return x.soort === 'constructor' && x.klussen === 1; }) && typeof Object.klussen === 'undefined', dr.soorten);
toets('11b geneste of prototype-signalen weg', JSON.stringify(dr.klussen.find(function (k) { return k.soort === 'routine'; }).signalen) === '["duur > 120 min"]', dr.klussen);
toets('11c vrije tekst in onderdeel en model weg', dr.klussen.every(function (k) { return k.onderdeel === null && k.model === null; }), dr.klussen);
toets('11d array en null tellen als kapot', dr.kapot === 2, dr);
toets('11e zonder koers geen euro verzonnen (null, wel dollars)', dr.eur === null && dr.klussen[0].eur === null && dr.klussen[0].usd === 2 && dr.soorten[0].eur === null, dr);
fs.writeFileSync(path.join(RM, 'klussen', '2030-03-02-pod.jsonl'), Array.from({ length: 2100 }, function (_, i) { return JSON.stringify({ soort: 'routine', usd: 0.01 }); }).join('\n'));
const dv = tr.dag('2030-03-02', {});
toets('11f hooguit 2000 regels gelezen, rest geteld', dv.te_veel_regels === 100 && dv.klussen.length === 300 && dv.aantal === 2100, { a: dv.aantal, t: dv.te_veel_regels, k: dv.klussen.length });
fs.writeFileSync(path.join(RM, 'klussen', '2030-03-03-pod.jsonl'), Buffer.alloc(1024 * 1024 + 1, 32));
toets('11g klussendag boven 1 MB niet ingelezen', !!tr.dag('2030-03-03', {}).fout);
let vvFout = null; try { VV.lees(path.join(RM, 'klussen', '2030-03-03-pod.jsonl'), 'utf8', { max: 10 }); } catch (e) { vvFout = e.code; }
toets('11h vault-veilig: max op de descriptor geeft ETOOBIG', vvFout === 'ETOOBIG', vvFout);
toets('11i vault-veilig: zonder max leest hij gewoon', VV.lees(path.join(RM, 'klussen', '2030-03-01-pod.jsonl')).length > 10);
fs.writeFileSync(path.join(RM, 'samenvatting.json'), JSON.stringify({ per_soort: [{ soort: 'toString', naam: 'Vrije tekst die niet mag', eur: 1 }], per_dag_soort: [{ datum: '2030-03-01', soorten: { constructor: 2, routine: 1 } }], signalen: { toString: 1 } }));
const sr = T.maak({ vault: R, vv: VV }).stand({});
toets('11j onbekende soort: geen vrije naam uit het bestand', sr.soorten[0].naam === 'toString' && JSON.stringify(sr).indexOf('Vrije tekst') < 0, sr.soorten[0]);
toets('11k dag met soort "constructor" telt in overig', sr.per_dag[0].delen.overig === 2 && sr.per_dag[0].eur === 3, sr.per_dag[0]);
toets('11l signalen zonder eigen sleutel = 0', sr.signalen.every(function (x) { return x.klussen === 0; }), sr.signalen);
fs.rmSync(R, { recursive: true, force: true });

// 10 koppeling in server.js
const src = fs.readFileSync('server.js', 'utf8');
toets('10a dispatch GET /app/tokens en /dag/', /route === 'GET \/app\/tokens' \|\| \/\^GET \\\/app\\\/tokens\\\/dag\\\/\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(route\)\) return typeof appTokens === 'function'/.test(src));
const b = src.slice(src.indexOf('// ── TokenCounter (wv1742'), src.indexOf('// ── einde tokenteller ──'));
toets('10b zonder module 404', /if \(!tokenteller\) return appWeiger\(res, 404/.test(b));
toets('10c teller tokens', /appTeller\('tokens', 600, 3600000\)/.test(b));
toets('10d stil bij 200', /res\._app\.stil = true;\s*return appStuur\(res, 200, uit\)/.test(b));
toets('10e vaste plek doorgegeven', /a\.soort === 'vast'/.test(b) && /stand\(\{ vast: vast/.test(b) && /dag\(m\[1\], \{ vast: vast \}\)/.test(b));
toets('10f vault-veilig doorgegeven', /vv: VV\(\)/.test(b));
toets('10l tank: één lopende lezing gedeeld', /if \(tokentellerTankBezig\) return tokentellerTankBezig;/.test(b));
toets('10g /health.tokenteller', /tokenteller: typeof tokenteller !== 'undefined' && !!tokenteller/.test(src));
toets('10h tokenteller.js in RELEASE_OPTIONEEL', /^RELEASE_OPTIONEEL="[^"]*\btokenteller\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')));
toets('10i GET /app/tokens is geen invoerroute', !/app\/tokens/.test(src.slice(src.indexOf('function appInvoerRoute'), src.indexOf('function appInvoerRoute') + 1500)));
toets('10j CI-stap', /bash test\/tokenteller\.sh/.test(fs.readFileSync('.github/workflows/build.yml', 'utf8')));
toets('10k module: geen netwerk', !/require\('(https?|net|child_process)'\)/.test(fs.readFileSync('tokenteller.js', 'utf8')));

[V, W, X, G].forEach(function (p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} });
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
