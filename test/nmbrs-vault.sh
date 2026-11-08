#!/usr/bin/env bash
# Toetst wv2799 (8-11-2026): de blokken "Stand in Nmbrs" in personeelsdossiers en de urenverloop-tabellen per entiteit
# (nmbrs-data.js: vaultBereken, blokZet, vaultPadGoed, kind 'vault'; server.js: nmbrsVaultNa en smal-opdracht 'vault').
# ALLEEN VERZONNEN gegevens in een wegwerpmap; raakt de pod, de vault en /opt/data/nmbrs niet.
# Kern: geen bedrag in de vault (salariswaarde 1234.56/2345.67 mag nergens staan), alleen gekoppelde bestaande pagina's onder
# 10_Zakelijk, blok vervangen of invoegen vóór de gegenereerde blokken, ongewijzigd = niet schrijven, urenverloop klopt (fte = uren/36).
# Kruisproef: een kopie die de salariswaarde wél in het blok zet → de bedragtoets wordt rood.
# Gebruik: bash test/nmbrs-vault.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), vm = require('vm');
const { spawn, spawnSync } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'nmbrs-vault-'));
const SCRIPT = path.resolve('nmbrs-data.js');
const T = require(SCRIPT);
const DIR = path.join(W, 'nmbrs'), VAULT = path.join(W, 'vault');
fs.mkdirSync(DIR, { mode: 0o700 });
const C1 = 'c0000000-0000-4000-8000-000000000001';
const E = (n) => 'e0000000-0000-4000-8000-00000000000' + n;
const TB = 't0000000-0000-4000-8000-000000000001';
// ── verzonnen databank (zelfde schema als nmbrs-data.js db()) ─────────────────────────────────────────────────────────
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync(path.join(DIR, 'nmbrs.sqlite'));
d.exec('create table bedrijf (id text primary key, debiteur text, data text not null, periode_soort text, periode_jaar integer, periode integer, gezien text not null);' +
  'create table medewerker (id text primary key, bedrijf text not null, data text not null, gezien text not null);' +
  'create table historie (soort text not null, medewerker text not null, bedrijf text not null, sub text not null, data text not null, primary key (soort, medewerker, sub)) without rowid;');
d.prepare('insert into bedrijf values (?,?,?,?,?,?,?)').run(C1, null, JSON.stringify({ companyId: C1, number: '9', name: 'Proefpraktijk B.V.' }), 'month', 2026, 11, 'x');
const mw = (id, nr, voor, achter) => d.prepare('insert into medewerker values (?,?,?,?)').run(id, C1, JSON.stringify({ employeeNumber: nr, firstName: voor, prefix: null, lastName: achter }), 'x');
let sub = 0;
const h = (soort, id, data) => d.prepare('insert into historie values (?,?,?,?,?)').run(soort, id, C1, String(++sub), JSON.stringify(data));
const tabel = { tableId: TB, tableCode: 1, tableName: 'Proeftabel' };
const sal = (id, start, schaal, trede, waarde) => h('salaris', id, { startDate: start + 'T00:00:00Z', type: 'grossFulltimeSalary', value: waarde, createdAt: start + 'T08:00:00Z', tabel: tabel, schaal: { scaleCode: schaal, scaleDescription: 'schaal ' + schaal }, trede: { stepCode: trede, stepDescription: 'nr ' + trede } });
const rst = (id, start, uren, dagen, pt) => h('rooster', id, { startDate: start + 'T00:00:00Z', hoursPerWeek: uren, weekuren: uren, daysPerWeek: dagen, parttimePercentage: pt, createdAt: start + 'T08:00:00Z' });
const dv = (id, start, eind) => h('dienstverband', id, { startDate: start + 'T00:00:00Z', endDate: eind ? eind + 'T00:00:00Z' : null, creationDate: '2022-01-20T00:00:00Z' });
const con = (id, start, eind, onb) => h('contract', id, { startDate: start + 'T00:00:00Z', endDate: eind ? eind + 'T00:00:00Z' : null, indefinite: onb, writtenContract: true, hoursPerWeek: null, createdAt: start + 'T08:00:00Z' });
// 1 Anna: in dienst sinds de overstap, bepaald → onbepaald, 24 → 28 u, trede 10 → 11
mw(E(1), 1, 'Anna', 'Proef'); dv(E(1), '2022-01-01'); con(E(1), '2022-01-01', '2022-08-31', false); con(E(1), '2022-09-01', null, true);
rst(E(1), '2022-01-01', 24, 3, 63.16); rst(E(1), '2024-01-01', 28, 4, 73.68); sal(E(1), '2022-01-01', '5', '10', 1234.56); sal(E(1), '2024-01-01', '5', '11', 2345.67);
h('functie', E(1), { description: 'Proefassistente', createdAt: '2022-01-20T00:00:00Z' });
h('verlofsaldo', E(1), { leaveGroupId: 'g1', leaveBalance: 12.5 }); h('verlofsaldo', E(1), { leaveGroupId: 'g2', leaveBalance: -3 });
// 2 Bert: uit dienst 30-6-2023, 16 u; pagina bestaat niet
mw(E(2), 2, 'Bert', 'Toets'); dv(E(2), '2022-01-01', '2023-06-30'); rst(E(2), '2022-01-01', 16, 2, 42.11); sal(E(2), '2022-01-01', '4', '7', 1234.56);
// 3 Cor: oproep (geen vaste uren); koppeling wijst buiten 10_Zakelijk → genegeerd
mw(E(3), 3, 'Cor', 'Nep'); dv(E(3), '2022-01-01'); rst(E(3), '2022-01-01', null, 0, 100);
// 4 Dirk: begint pas in 2099
mw(E(4), 4, 'Dirk', 'Later'); dv(E(4), '2099-01-01'); con(E(4), '2099-01-01', '2099-12-31', false); rst(E(4), '2099-01-01', 40, 5, 100);
// 5 Eva: niet gekoppeld
mw(E(5), 5, 'Eva', 'Los'); dv(E(5), '2025-03-01'); rst(E(5), '2025-03-01', 10, 2, 26.32);
// 6 + 7: twee records op één pagina (naam met ".."-achtige punt in de bestandsnaam)
mw(E(6), 6, 'Fee', 'Dubbel'); dv(E(6), '2023-01-01', '2023-12-31'); rst(E(6), '2023-01-01', 8, 1, 21.05);
mw(E(7), 7, 'Fee', 'Dubbel'); dv(E(7), '2025-01-01'); rst(E(7), '2025-01-01', 20, 3, 52.63); sal(E(7), '2025-01-01', '6', '12', 2345.67);
// 8: functie met een verdacht woord → de server weigert het blok (tweede grendel)
mw(E(8), 8, 'Gijs', 'Grendel'); dv(E(8), '2025-01-01'); rst(E(8), '2025-01-01', 12, 2, 31.58); h('functie', E(8), { description: 'Uurloon proef', createdAt: '2025-01-01T00:00:00Z' });
// 9 Hans: in dienst sinds juni 2024, eerste rooster pas 2025 (niet gekoppeld) → vóór 2025 geen uren
mw(E(9), 9, 'Hans', 'Laat'); dv(E(9), '2024-06-01'); rst(E(9), '2025-01-01', 20, 3, 52.63);
d.close();
const MAP = '10_Zakelijk/Proef/Medewerkers/';
fs.writeFileSync(path.join(DIR, 'koppeling.json'), JSON.stringify({
  bedrijven: { [C1]: { entiteit: 'TG', verloop: MAP + 'Personeel - urenverloop.md' }, 'x/../y': { entiteit: 'TG', verloop: MAP + 'X.md' } },
  medewerkers: { [E(1)]: MAP + 'Anna Proef.md', [E(2)]: MAP + 'Bert Toets.md', [E(3)]: '10_Zakelijk/../buiten.md', [E(4)]: MAP + 'Dirk Later.md',
    [E(6)]: MAP + 'Fee Dubbel i.o..md', [E(7)]: MAP + 'Fee Dubbel i.o..md', [E(8)]: MAP + 'Gijs Grendel.md' } }));
function kindEcht(script, opdracht, invoer) {
  const r = spawnSync(process.execPath, ['--no-warnings', script, opdracht], { input: JSON.stringify(invoer || {}), env: { PATH: process.env.PATH, NMBRS_DIR: DIR }, encoding: 'utf8' });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { return { ok: false, rauw: r.stdout + r.stderr }; }
}
const BEDRAG = /1234|2345|1\.234|2\.345|1234,56|€/;

(async function () {
  try {
    // 1. vaultPadGoed
    toets('pad: 10_Zakelijk/…/x.md goed, ook "i.o..md"', T.vaultPadGoed(MAP + 'Anna Proef.md') && T.vaultPadGoed(MAP + 'Fee Dubbel i.o..md'));
    toets('pad: .., absoluut, buiten 10_Zakelijk, geen .md, backslash, commentaarteken → fout',
      ['10_Zakelijk/../x.md', '/10_Zakelijk/x.md', '20_Prive/x.md', '10_Zakelijk/x.txt', '10_Zakelijk\\x.md', '10_Zakelijk//x.md', '10_Zakelijk/a-->.md', '10_Zakelijk/./x.md', null].every((p) => !T.vaultPadGoed(p)));

    // 2. kind 'vault'
    const k = kindEcht(SCRIPT, 'vault', {});
    toets('kind vault: ok, 6 gekoppeld, 3 ongekoppeld (Eva, Hans + buiten-pad), 5 pagina\'s, 1 urenverloop', k.ok === true && k.gekoppeld === 6 && k.ongekoppeld === 3 && k.dossiers.length === 5 && k.verloop.length === 1, [k.gekoppeld, k.ongekoppeld, (k.dossiers || []).length, k.rauw]);
    const v0 = () => ((k.verloop || [])[0] || {}).blok || '';
    const blok = (naam) => ((k.dossiers || []).find((x) => x.pad.indexOf(naam) >= 0) || {}).blok || '';
    const a = blok('Anna Proef');
    toets('Anna: schaal/trede, uren, contract onbepaald, begin administratie, verlof', /schaal 5, trede 11, sinds 1-1-2024/.test(a) && /28 u, 4 dagen, parttime 73,68 %, sinds 1-1-2024/.test(a) &&
      /1-9-2022 onbepaalde tijd/.test(a) && /begin van de Nmbrs-administratie/.test(a) && /12,5 · −3/.test(a) && /Proefassistente/.test(a), a);
    toets('Anna: historietabel met twee ingangen', /\| 1-1-2022 \| 24 \| 3 \| 63,16 % \| 5\/10 \|/.test(a) && /\| 1-1-2024 \| 28 \| 4 \| 73,68 % \| 5\/11 \|/.test(a), a);
    toets('geen bedrag in een enkel blok (salariswaarden 1234.56/2345.67)', !(k.dossiers || []).concat(k.verloop || []).some((x) => BEDRAG.test(x.blok)));
    toets('Bert: uit dienst per 30-6-2023', /uit dienst per 30-6-2023/.test(blok('Bert Toets')));
    toets('Dirk: nog niet begonnen', /in dienst per 1-1-2099 \(nog niet begonnen\)/.test(blok('Dirk Later')));
    // review MOET 2: op de einddatum zelf nog in dienst; de dag erna uit dienst
    const kb = kindEcht(SCRIPT, 'vault', { nu: '2023-06-30T14:00:00+02:00' }), kc = kindEcht(SCRIPT, 'vault', { nu: '2023-07-01T09:00:00+02:00' });   // ZOU 1: middag van de einddatum
    const bb = (kk2) => ((kk2.dossiers || []).find((x) => x.pad.indexOf('Bert Toets') >= 0) || {}).blok || '';
    toets('MOET 2: op de laatste dag nog in dienst, de dag erna uit dienst', /\| Status \| in dienst, laatste werkdag 30-6-2023 \|/.test(bb(kb)) && /uit dienst per 30-6-2023/.test(bb(kc)), [bb(kb).slice(0, 400)]);
    // review MOET 1: Dirk heeft vanaf 2099 een rooster; vóór 2099 telt dat nergens mee, in het dossier "per … (nog niet ingegaan)"
    const dk = blok('Dirk Later');
    toets('MOET 1: later ingaand rooster: "nog niet ingegaan" in het dossier, niet in het verloop', /40 u, 5 dagen, parttime 100 %, per 1-1-2099 \(nog niet ingegaan\)/.test(dk) && !/\| 2026-0\d \| [0-9]+ \| [0-9]+ \| [0-9,]*4\d \|/.test(v0()), dk);
    const f = blok('Fee Dubbel');
    toets('twee records op één pagina: twee kopjes, nieuwste eerst', (f.match(/### Personeelsnummer/g) || []).length === 2 && f.indexOf('nummer 7') < f.indexOf('nummer 6'), f);
    toets('elk blok tussen de markeringen', (k.dossiers || []).every((x) => x.blok.startsWith(T.BLOK_BEGIN) && x.blok.endsWith(T.BLOK_EIND)));
    const v = (k.verloop[0] || {}).blok || '';
    const nu = new Date(), maanden = (nu.getFullYear() - 2022) * 12 + nu.getMonth() + 1;
    toets('verloop: één rij per maand vanaf het eerste rooster (2022-01) t/m deze maand', k.verloop[0] && k.verloop[0].maanden === maanden, [k.verloop[0] && k.verloop[0].maanden, maanden]);
    toets('verloop 2022-01: 3 in dienst, 1 zonder uren, 40 u, fte 1,11 (40/36), instroom = begin', /\| 2022-01 \| 3 \| 1 \| 40 \| 1,11 \| — \(begin\) \| 0 \|/.test(v), v.slice(0, 1500));
    toets('verloop 2023-06: uitstroom 1; 2023-07: Anna + Cor + Fee, 32 u', /\| 2023-06 \| 4 \| 1 \| 48 \| 1,33 \| 0 \| 1 \|/.test(v) && /\| 2023-07 \| 3 \| 1 \| 32 \| 0,89 \| 0 \| 0 \|/.test(v), v.slice(0, 3000));
    toets('verloop 2024-01: Anna 28 u (nieuw rooster), Fee weg (uitstroom dec)', /\| 2023-12 \| 3 \| 1 \| 32 \| 0,89 \| 0 \| 1 \|/.test(v) && /\| 2024-01 \| 2 \| 1 \| 28 \| 0,78 \| 0 \| 0 \|/.test(v), v.slice(0, 3000));
    toets('MOET 1: 2024-07 telt Hans zonder uren (eerste rooster pas 2025), 2025-01 met 20 u (+ Anna 28, Fee 20, Gijs 12)', /\| 2024-07 \| 3 \| 2 \| 28 \| 0,78 \| 0 \| 0 \|/.test(v) && /\| 2025-01 \| 5 \| 1 \| 80 \|/.test(v), v.split('\n').filter((x) => /2024-07|2025-01/.test(x)));
    toets('verloop: jaartabel met 2022 en gemiddelden', /\| 2022 \| 3 \| 40 \| 1,11 \| 0 \| 0 \|/.test(v), v.slice(0, 900));

    // 3. blokZet
    const B1 = T.BLOK_BEGIN + '\nA (stand Nmbrs 1-1-2026)\n' + T.BLOK_EIND, B2 = T.BLOK_BEGIN + '\nA (stand Nmbrs 2-1-2026)\n' + T.BLOK_EIND, B3 = T.BLOK_BEGIN + '\nB (stand Nmbrs 2-1-2026)\n' + T.BLOK_EIND;
    const pag = '---\ntype: medewerker\n---\n# X\n\ntekst\n\n<!-- ovis:blok begin id="x" -->\nrek\n<!-- ovis:blok eind -->\n';
    const n1 = T.blokZet(pag, B1, true);
    toets('blokZet: invoegen vóór het ovis-blok, rest ongewijzigd', n1 && n1.indexOf(B1) > 0 && n1.indexOf(B1) < n1.indexOf('<!-- ovis:blok begin') && n1.replace(B1 + '\n\n', '') === pag, n1);
    toets('blokZet: alleen de standdatum anders → null (niet schrijven)', T.blokZet(n1, B2, true) === null);
    const n2 = T.blokZet(n1, B3, true);
    toets('blokZet: inhoud anders → vervangen, één blok', n2 && n2.indexOf('\nB (stand') > 0 && n2.split(T.BLOK_BEGIN).length === 2 && n2.replace(B3, B1) === n1, n2);
    toets('blokZet: zonder gegenereerde blokken → achteraan', T.blokZet('# X\ntekst', B1, true) === '# X\ntekst\n\n' + B1 + '\n');
    toets('blokZet: twee blokken of half blok → null', T.blokZet(n1 + '\n' + B1, B3, true) === null && T.blokZet('x ' + T.BLOK_BEGIN + ' y', B1, true) === null && T.blokZet('x ' + T.BLOK_EIND, B1, true) === null);
    toets('blokZet: urenverloop zonder markeringen → null (pod maakt geen pagina-inhoud)', T.blokZet('# Urenverloop\n', B1, false) === null);

    // 4. server: nmbrsVaultNa en smal 'vault'
    fs.mkdirSync(path.join(VAULT, MAP), { recursive: true });
    const pAnna = path.join(VAULT, MAP, 'Anna Proef.md'), pFee = path.join(VAULT, MAP, 'Fee Dubbel i.o..md'), pDirk = path.join(VAULT, MAP, 'Dirk Later.md'), pV = path.join(VAULT, MAP, 'Personeel - urenverloop.md'), pG = path.join(VAULT, MAP, 'Gijs Grendel.md');
    fs.writeFileSync(pAnna, pag); fs.writeFileSync(pFee, '# Fee\n'); fs.writeFileSync(pDirk, '# Dirk\n'); fs.writeFileSync(pG, '# Gijs\n');
    fs.writeFileSync(pV, '# Urenverloop\n\nWaarom.\n\n' + T.BLOK_BEGIN + '\noud\n' + T.BLOK_EIND + '\n\nslot\n');
    fs.writeFileSync(path.join(VAULT, '10_Zakelijk', 'buiten.md'), '# buiten\n');
    const ssrc = fs.readFileSync('server.js', 'utf8');
    const b1 = ssrc.indexOf('// ── wv2797: Nmbrs'), b2 = ssrc.indexOf('// ── einde Nmbrs ──');
    const k1 = ssrc.indexOf('function smalKind('), k2 = ssrc.indexOf('async function smalSbRpc(');
    toets('server.js: vault-stap na de signalen in de ronde en smal-opdracht vault', /const v = await nmbrsVaultNa\(false\);/.test(ssrc) && /if \(opdracht === 'vault'\)/.test(ssrc));
    const logs = [], schrijf = [];
    const g = { require, fs, path, crypto, Buffer, console, URL, setTimeout, clearTimeout, Promise, JSON, Date, spawn, VAULT: VAULT, __dirname: process.cwd(),
      process: { env: { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', NMBRS_DIR: DIR, NMBRS_SCRIPT: SCRIPT }, execPath: process.execPath, pid: process.pid },
      schrijfLog: (x) => logs.push(x), nu: () => '2026-11-08 12:00:00', velden: (o) => Object.keys(o).filter((k2) => o[k2] != null && o[k2] !== '').map((k2) => k2 + '=' + o[k2]).join(' '),
      logError: (w, e) => logs.push('fout ' + w + ' ' + (e && e.message)), rolPrimair: () => true,
      VV: () => ({ lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: (p, t) => { schrijf.push(p); fs.writeFileSync(p, t); },
        wijzig: (p, fn) => { const o = fs.readFileSync(p, 'utf8'), n = fn(o); if (n == null) return false; schrijf.push(p); fs.writeFileSync(p, n); return true; } }),
      berichtIntern: async () => ({ status: 200 }), fetch: async () => { throw new Error('geen netwerk in deze toets'); } };
    vm.createContext(g);
    vm.runInContext(ssrc.slice(k1, k2) + '\n' + ssrc.slice(b1, b2) + '\n;globalThis.__t = { nmbrsSmal, nmbrsVaultNa };', g);
    const S = g.__t;
    let sm = await S.nmbrsSmal({ opdracht: 'vault' }, { mk: false });
    toets('server: vault met de Socev-sleutel → 403', sm.status === 403);
    sm = await S.nmbrsSmal({ opdracht: 'vault', droog: true }, { mk: true });
    toets('server: droog → tellen, niets geschreven', sm.status === 200 && sm.j.droog === true && sm.j.dossiers === 3 && sm.j.verloop === 1 && sm.j.ontbreekt === 1 && sm.j.geweigerd === 1 && schrijf.length === 0, [sm.j, schrijf]);
    sm = await S.nmbrsSmal({ opdracht: 'vault' }, { mk: true });
    toets('server: echt → 3 dossiers + 1 urenverloop, Bert ontbreekt, Gijs geweigerd', sm.status === 200 && sm.j.dossiers === 3 && sm.j.verloop === 1 && sm.j.ontbreekt === 1 && sm.j.geweigerd === 1 && sm.j.fout === 0 && schrijf.length === 4, [sm.j, schrijf]);
    const ta = fs.readFileSync(pAnna, 'utf8');
    toets('server: Anna-pagina: blok vóór het ovis-blok, frontmatter en tekst ongemoeid', ta.startsWith('---\ntype: medewerker\n---\n# X\n\ntekst\n\n' + T.BLOK_BEGIN) && ta.indexOf('<!-- ovis:blok begin') > ta.indexOf(T.BLOK_EIND), ta.slice(0, 300));
    const tv = fs.readFileSync(pV, 'utf8');
    toets('server: urenverloop alleen tussen de markeringen vervangen', tv.startsWith('# Urenverloop\n\nWaarom.\n\n' + T.BLOK_BEGIN) && tv.endsWith(T.BLOK_EIND + '\n\nslot\n') && tv.indexOf('\noud\n') < 0 && /\| 2022-01 \|/.test(tv));
    toets('server: Gijs-pagina (verdacht woord) en buiten-pagina ongemoeid', fs.readFileSync(pG, 'utf8') === '# Gijs\n' && fs.readFileSync(path.join(VAULT, '10_Zakelijk', 'buiten.md'), 'utf8') === '# buiten\n');
    const allesVault = [pAnna, pFee, pDirk, pV].map((p) => fs.readFileSync(p, 'utf8')).join('\n');
    toets('server: geen bedrag in de vault', !BEDRAG.test(allesVault));
    schrijf.length = 0;
    sm = await S.nmbrsSmal({ opdracht: 'vault' }, { mk: true });
    toets('server: tweede keer zonder wijziging → niets geschreven', sm.j.gelijk === 4 && sm.j.dossiers === 0 && schrijf.length === 0, [sm.j, schrijf]);
    toets('server: log zonder namen of paden', logs.some((x) => /nmbrs opdracht=vault/.test(x)) && !logs.some((x) => /Anna|Proef|10_Zakelijk/.test(x)), logs);

    // 5. kruisproef: een kopie die de salariswaarde in het blok zet → de bedragtoets ziet het
    const kopie = path.join(W, 'nmbrs-data-kruis.js');
    fs.writeFileSync(kopie, fs.readFileSync(SCRIPT, 'utf8').replace("return (s.tabel && s.tabel.tableName ?", "return String(s.value) + ' ' + (s.tabel && s.tabel.tableName ?"));
    const kk = kindEcht(kopie, 'vault', {});
    toets('kruisproef: met lek staat het bedrag wél in een blok (toets kan rood)', kk.ok === true && (kk.dossiers || []).some((x) => BEDRAG.test(x.blok)), kk.rauw);
  } catch (e) { toets('geen uitzondering', false, String(e && e.stack || e)); }
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})();
JS
