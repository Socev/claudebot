#!/usr/bin/env bash
# Toetst sb2-berichten.js (wv2383, SB2 fase 6 § 6.2: berichtverbindingen) met een nep-Supabase (zet-gelijk zoals 0025) en een intake.sqlite in
# het geheugen. Alle adressen, domeinen en namen zijn verzonnen (de repo is openbaar; .invalid/.test-domeinen).
# Toetst: adressen per kop met vaste positie; oplossen (exact, subdomein met puntgrens, schijndomein zonder puntgrens, dubbelzinnig, Davids eigen
# adres, PRIVE, openbaar domein nooit via het domein); scope (harde marker, onbekende marker, vastgehouden/weg, keuze hard, harde weging,
# "mogelijk medisch" en onleesbaar gaan wél mee, quarantaine niet verstuurd, andere route niet, bijlage niet); target uit de bevestigde
# kennisbestemming (niet PRIVE, onbekende code = null); alle versies van de route mee (buiten scope met een lege lijst) + versies die alleen de
# databank nog kent; zet-gelijk + droge tweede ronde = 0; schakelaar/routes; nooit een '@' naar Supabase; koppeling in server.js.
# Gebruik: bash test/sb2-berichten.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 900) + ']' : '')); }
const B = require('./sb2-berichten.js');
const { DatabaseSync } = require('node:sqlite');
const U = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const E = { X: U(1), Y: U(2), ZH: U(3), D1: U(4), D2: U(5), TG: U(10), GH: U(11), PRIVE: U(12), GM: U(13) };

// ── adressen per kop ──
let k = B.kopAdressen(['Proef Aap <aap@voorbeeld.invalid>', 'noot@voorbeeld.invalid, mies@voorbeeld.invalid', 'geen adres', 'X@VOORBEELD.INVALID']);
toets('kop: haken, komma, geen adres (positie blijft), kleine letters', JSON.stringify(k) === JSON.stringify([{ nr: 0, adres: 'aap@voorbeeld.invalid' }, { nr: 1, adres: 'noot@voorbeeld.invalid' },
  { nr: 2, adres: 'mies@voorbeeld.invalid' }, { nr: 3, adres: null }, { nr: 4, adres: 'x@voorbeeld.invalid' }]), k);
k = B.kopAdressen('aap@voorbeeld.invalid');
toets('kop: van als tekst = positie 0', k.length === 1 && k[0].nr === 0 && k[0].adres === 'aap@voorbeeld.invalid', k);
toets('kop: leeg/null', B.kopAdressen(null).length === 0 && B.kopAdressen([]).length === 0);

// ── oplossen ──
const REG = { adres: [
  ['email', 'x@persoon.invalid', E.X], ['email', ' Y@Bedrijf.Invalid ', E.Y], ['zorgmail', 'zh@zorgmail.invalid', E.ZH],
  ['domein', 'ziekenhuis-proef.invalid', E.ZH], ['domein', '@bedrijf.invalid', E.Y],
  ['email', 'dubbel@persoon.invalid', E.D1], ['email', 'dubbel@persoon.invalid', E.D2], ['domein', 'gedeeld.invalid', E.D1], ['domein', 'gedeeld.invalid', E.D2],
  ['email', 'thuis@praktijk-proef.invalid', E.PRIVE], ['domein', 'gmail.com', E.GM], ['email', 'iemand.proef@gmail.com', E.X], ['telefoon', '0612345678', E.X],
  ['email', 'kapot', E.X], ['email', 'z@persoon.invalid', 'geen-uuid']],
  eigen: [['TG', E.TG], ['GH', E.GH], ['PRIVE', E.PRIVE]] };
const opl = B.maakOplosser(REG, ['David.Proef@Voorbeeld.invalid']);
const los = (a) => opl.los(a);
toets('los: exact email', los('x@persoon.invalid').object_id === E.X && los('x@persoon.invalid').via === 'email');
toets('los: register genormaliseerd (trim + kleine letters)', los('y@bedrijf.invalid').object_id === E.Y);
toets('los: zorgmail exact', los('zh@zorgmail.invalid').object_id === E.ZH);
toets('los: domein exact', los('balie@ziekenhuis-proef.invalid').object_id === E.ZH && los('balie@ziekenhuis-proef.invalid').via === 'domein');
toets('los: subdomein met puntgrens', los('a@poli.x.ziekenhuis-proef.invalid').object_id === E.ZH);
toets('los: schijndomein zonder puntgrens → geen (review MOET 4)', los('a@evilziekenhuis-proef.invalid').overslaan === 'geen');
toets('los: domein met @ ervoor in het register', los('info@bedrijf.invalid').object_id === E.Y);
toets('los: dubbelzinnig adres → overslaan', los('dubbel@persoon.invalid').overslaan === 'dubbelzinnig');
toets('los: dubbelzinnig domein → overslaan (geen terugval op korter)', los('a@gedeeld.invalid').overslaan === 'dubbelzinnig');
toets('los: Davids eigen adres → overslaan', los('david.proef@voorbeeld.invalid').overslaan === 'eigen');
toets('los: adres dat op PRIVE uitkomt → overslaan', los('thuis@praktijk-proef.invalid').overslaan === 'prive');
toets('los: openbaar domein nooit via het domein', los('wie.dan.ook@gmail.com').overslaan === 'openbaar');
toets('los: openbaar domein wel exact als het adres zelf in het register staat', los('iemand.proef@gmail.com').object_id === E.X);
toets('los: onbekend', los('a@onbekend.invalid').overslaan === 'geen' && los(null).overslaan === 'geen_adres');
toets('los: telefoon en kapotte rijen tellen niet', opl.aantal.exact === 6 && opl.aantal.domein === 4, opl.aantal);

// ── intake.sqlite in het geheugen ──
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE stuk (stuk_id TEXT PRIMARY KEY, bron TEXT, profiel TEXT, versie INTEGER, marker_patient TEXT, meta TEXT);
CREATE TABLE spiegel (stuk_id TEXT PRIMARY KEY, stand TEXT, ps TEXT, ids TEXT);
CREATE TABLE live_stuk (stuk_id TEXT PRIMARY KEY, versie INTEGER, staat TEXT, keuze TEXT);
CREATE TABLE router_stuk (stuk_id TEXT, versie INTEGER, samenvatting TEXT, PRIMARY KEY (stuk_id, versie));
CREATE TABLE bestemming (stuk_id TEXT, versie INTEGER, lens TEXT, doel TEXT, status TEXT);`);
let nr = 0;
function stuk(o) {
  nr++;
  const id = o.id || ('stk_20991231_' + String(nr).padStart(8, '0'));
  const rev = o.rev || (1000 + nr);
  db.prepare('INSERT INTO stuk VALUES (?,?,?,?,?,?)').run(id, 'gmail:david', o.profiel || 'mail@1', 1, o.marker === undefined ? 'geen' : o.marker,
    JSON.stringify(o.meta || { van: 'x@persoon.invalid', aan: ['david.proef@voorbeeld.invalid', 'balie@ziekenhuis-proef.invalid'], cc: [] }));
  const ids = o.ids || [{ route: o.route || 'gmail.david', origin: 'mail', bijlage: false, revisie: rev }];
  db.prepare('INSERT INTO spiegel VALUES (?,?,?,?)').run(id, o.stand || 'gespiegeld', o.ps === undefined ? 'registered' : o.ps, JSON.stringify(ids));
  if (o.staat !== null) db.prepare('INSERT INTO live_stuk VALUES (?,?,?,?)').run(id, 1, o.staat || 'klaar', o.keuze || null);
  if (o.sam) db.prepare('INSERT INTO router_stuk VALUES (?,?,?)').run(id, 1, JSON.stringify(o.sam));
  if (o.doel !== undefined) db.prepare('INSERT INTO bestemming VALUES (?,?,?,?,?)').run(id, 1, 'kennis', o.doel, o.doelStatus || 'bevestigd');
  return rev;
}
const R = {};
R.goed = stuk({ doel: 'TG', meta: { van: 'Proef X <x@persoon.invalid>', aan: ['david.proef@voorbeeld.invalid', 'y@bedrijf.invalid', 'info@bedrijf.invalid'], cc: ['balie@ziekenhuis-proef.invalid', 'wie@gmail.com'] } });
R.marker = stuk({ marker: 'gemarkeerd', doel: 'TG' });
R.markerNull = stuk({ marker: null });
R.onleesbaar = stuk({ marker: 'niet_te_lezen', doel: 'GH' });
R.medisch = stuk({ sam: { mogelijk_medisch: true, weging: 'zacht', na_keuze: true } });
R.hard = stuk({ keuze: 'hard' });
R.weging = stuk({ sam: { weging: 'hard', buiten_brain: true } });
R.vast = stuk({ staat: 'vastgehouden' });
R.weg = stuk({ staat: 'weg' });
R.quarantaine = stuk({ ps: 'quarantaine' });
R.prive = stuk({ doel: 'PRIVE' });
R.onbekendDoel = stuk({ doel: 'ZZZ' });
R.afgewezen = stuk({ doel: 'TG', doelStatus: 'afgewezen' });
R.zonderLive = stuk({ staat: null, doel: 'GH' });
R.andereRoute = stuk({ route: 'gmail.groenhouten' });
R.bijlage = stuk({ ids: [{ route: 'gmail.david', origin: 'bestand', bijlage: true, revisie: 1999 }], profiel: 'pdf@1' });
R.nietGespiegeld = stuk({ stand: 'niet_spiegelbaar' });
R.veel = stuk({ meta: { van: 'x@persoon.invalid', aan: Array.from({ length: 60 }, (_, i) => 'p' + i + '@ziekenhuis-proef.invalid'), cc: [] } });
let vv = B.versiesVan(db, 'gmail.david', opl);
const V = vv.versies, t = vv.t;
const g = V.get(R.goed);
toets('scope: goed stuk → afzender X, ontvanger Y (één keer per kop), cc ZH; openbaar en eigen adres overgeslagen',
  !!g && JSON.stringify(g.mentions) === JSON.stringify([{ kop: 'van', nr: 0, rol: 'afzender', object_id: E.X }, { kop: 'aan', nr: 1, rol: 'ontvanger', object_id: E.Y },
    { kop: 'cc', nr: 0, rol: 'cc', object_id: E.ZH }]), g);
toets('target: bevestigde kennisbestemming TG → object-id', g && g.target_org_id === E.TG, g);
for (const n of ['marker', 'markerNull', 'hard', 'weging', 'vast', 'weg']) {
  const x = V.get(R[n]);
  toets('scope: ' + n + ' → mee met een lege lijst en target null', !!x && x.mentions.length === 0 && x.target_org_id === null, x);
}
toets('scope: onleesbaar en "mogelijk medisch" gaan wél mee (grondwet 3, 3-11)', V.get(R.onleesbaar).mentions.length === 2 && V.get(R.onleesbaar).target_org_id === E.GH && V.get(R.medisch).mentions.length === 2);
toets('scope: quarantaine, andere route, bijlage en niet gespiegeld niet verstuurd', !V.has(R.quarantaine) && !V.has(R.andereRoute) && !V.has(1999) && !V.has(R.nietGespiegeld));
toets('target: PRIVE nooit, onbekende code null (geteld), afgewezen null', V.get(R.prive).target_org_id === null && V.get(R.onbekendDoel).target_org_id === null && t.doel_onbekend === 1 && V.get(R.afgewezen).target_org_id === null);
toets('scope: stuk zonder live-rij gaat mee (met bestemming)', V.get(R.zonderLive).target_org_id === E.GH && V.get(R.zonderLive).mentions.length === 2);
toets('positie > 49 niet, één vermelding per (kop, entiteit)', V.get(R.veel).mentions.length === 2 && t.nr_te_hoog === 10, { m: V.get(R.veel).mentions, t });
toets('tellingen: buiten per reden', t.buiten.marker === 2 && t.buiten.buiten_brain === 2 && t.buiten.staat === 2, t);
const andere = B.versiesVan(db, 'gmail.groenhouten', opl).versies;
toets('andere route: alleen het eigen stuk', andere.size === 1 && andere.has(R.andereRoute));

// ── ronde met een nep-Supabase (zet-gelijk zoals 0025) ──
function nepSb(o) {
  const st = { rijen: new Map(), target: new Map(), aanroepen: [], payload: [] };   // sleutel route|rev
  const extra = o && o.extra || [];
  async function rpc(fn, body) {
    st.aanroepen.push(fn); st.payload.push(JSON.stringify(body));
    if (fn === 'sb2_bericht_register') return REG;
    if (fn === 'sb2_bericht_stand') {
      const revs = new Set(extra);
      for (const kk of st.rijen.keys()) if (kk.startsWith(body.p_route + '|') && st.rijen.get(kk).size) revs.add(Number(kk.split('|')[1]));
      return { revisies: Array.from(revs), vermeldingen: 0, targets: 0 };
    }
    if (fn === 'sb2_bericht_koppel') {
      const p = body.p, u = { route: p.route, droog: !!p.droog, versies: 0, ok: 0, nieuw: 0, weg: 0, gelijk: 0, target_gezet: 0, target_weg: 0, artifact_nieuw: 0, artifact_weg: 0,
        opgeruimd_mention: 0, opgeruimd_target: 0, vermeldingen: 0, geweigerd: {} };
      if (p.versies.length > 200) throw new Error('batch te groot');
      for (const v of p.versies) {
        u.versies++;
        if (JSON.stringify(v).indexOf('@') >= 0) { u.geweigerd.apenstaart = (u.geweigerd.apenstaart || 0) + 1; continue; }
        const kk = p.route + '|' + v.revision_id;
        const oud = st.rijen.get(kk) || new Set();
        const nieuw = new Set(v.mentions.map((m) => [m.kop, m.nr, m.rol, m.object_id].join(':')));
        for (const x of oud) if (!nieuw.has(x)) u.weg++;
        for (const x of nieuw) if (oud.has(x)) u.gelijk++; else u.nieuw++;
        const ot = st.target.get(kk) || null;
        if (ot !== (v.target_org_id || null)) { if (v.target_org_id) u.target_gezet++; else u.target_weg++; }
        if (!p.droog) { st.rijen.set(kk, nieuw); st.target.set(kk, v.target_org_id || null); }
        u.ok++;
      }
      return u;
    }
    throw new Error('onbekende rpc ' + fn);
  }
  return { rpc, st };
}
(async () => {
  let schakelaar = null;
  const nep = nepSb({ extra: [777777] });
  const m = B.maak({ db, rpc: nep.rpc, schakelaar: () => schakelaar, eigenAdressen: () => ['david.proef@voorbeeld.invalid'], log: () => {} });
  let r = await m.ronde();
  toets('schakelaar ontbreekt → uit, geen aanroep', r.uit === true && nep.st.aanroepen.length === 0, r);
  schakelaar = { aan: false, routes: ['gmail.david'] };
  r = await m.ronde();
  toets('schakelaar uit → uit', r.uit === true && nep.st.aanroepen.length === 0, r);
  schakelaar = { aan: true, routes: ['gmail.david', 'gmail.onbekend'] };
  r = await m.ronde({ droog: true });
  toets('droog: niets bewaard, wel geteld', r.ok && r.droog && nep.st.rijen.size === 0 && r.routes['gmail.david'].eerste.nieuw > 0 && r.routes['gmail.david'].tweede === undefined, r);
  toets('onbekende route uit de schakelaar genegeerd', Object.keys(r.routes).join() === 'gmail.david', r.routes);
  r = await m.ronde();
  const rd = r.routes['gmail.david'];
  toets('echte ronde: alle versies van de route + de versie die alleen de databank kent, tweede ronde 0', r.ok && rd.verstuurd === V.size + 1 && rd.niet_meer_op_pod === 1 && rd.tweede === 0 && rd.eerste.nieuw === rd.vermeldingen, rd);
  toets('echte ronde: register- en scope-tellingen alleen getallen', typeof r.register.exact === 'number' && JSON.stringify(r).indexOf('@') < 0, r);
  toets('nooit een @ naar Supabase (koppel en stand)', nep.st.payload.every((x, i) => nep.st.aanroepen[i] === 'sb2_bericht_register' || x.indexOf('@') < 0));
  toets('target op de goede versie', nep.st.target.get('gmail.david|' + R.goed) === E.TG && nep.st.target.get('gmail.david|' + R.prive) === null);
  // stuk raakt buiten scope (harde marker): de volgende ronde haalt zijn vermeldingen en target weg
  db.prepare("UPDATE stuk SET marker_patient = 'gemarkeerd' WHERE stuk_id = (SELECT stuk_id FROM spiegel WHERE ids LIKE ?)").run('%"revisie":' + R.goed + '%');
  r = await m.ronde();
  toets('buiten scope geraakt → weg bij de volgende ronde (review MOET 1)', r.ok && r.routes['gmail.david'].eerste.weg === 3 && r.routes['gmail.david'].eerste.target_weg === 1
    && nep.st.rijen.get('gmail.david|' + R.goed).size === 0 && nep.st.target.get('gmail.david|' + R.goed) === null, r.routes['gmail.david']);
  r = await m.ronde();
  toets('derde ronde: 0 nieuw, 0 weg', r.ok && r.routes['gmail.david'].eerste.nieuw === 0 && r.routes['gmail.david'].eerste.weg === 0, r.routes['gmail.david']);
  // tweede ronde met verschil = niet ok
  const wankel = nepSb();
  let n2 = 0;
  const m2 = B.maak({ db, rpc: async (fn, b) => { const x = await wankel.rpc(fn, b); if (fn === 'sb2_bericht_koppel' && b.p.droog && ++n2 === 1) x.nieuw = 1; return x; },
    schakelaar: () => ({ aan: true, routes: ['gmail.david'] }), eigenAdressen: () => [] });
  r = await m2.ronde();
  toets('tweede ronde met verschil → niet ok, met reden', r.ok === false && /tweede ronde gaf 1/.test(r.reden), r);
  // antwoord buiten de vorm → gooit (de keten herkanst)
  const m3 = B.maak({ db, rpc: async (fn) => (fn === 'sb2_bericht_register' ? { adres: 'x' } : {}), schakelaar: () => ({ aan: true, routes: ['gmail.david'] }) });
  let gooide = false; try { await m3.ronde(); } catch (e) { gooide = /register/.test(e.message); }
  toets('register buiten de vorm → fout', gooide);

  // ── koppeling in server.js ──
  const sv = fs.readFileSync('server.js', 'utf8');
  toets('server.js: nachtketen-stap sb2-berichten ná intake-voorstel, alleen met de schakelaar', /naam: 'sb2-berichten', start_na: \[2, 43\], na: \['intake-voorstel'\], limiet_min: 10, pogingen: 2, inProces: true/.test(sv) && /if \(!sb2BerichtenAan\(\)\) return \{ ok: true, al_gedaan: true/.test(sv));
  toets('server.js: sb2-synapsen ná sb2-berichten', /naam: 'sb2-synapsen', start_na: \[2, 43\], na: \['intake-voorstel', 'sb2-berichten'\]/.test(sv));
  toets('server.js: schakelaar scripts-staat/sb2-berichten/aan.json (eigen uid, gewoon bestand), eigen adressen uit router.json', /const SB2_BER_DIR = '\/opt\/data\/scripts-staat\/sb2-berichten'/.test(sv) && /st\.uid !== process\.getuid\(\)\)\) return null/.test(sv) && /eigenAdressen: function \(\) \{ const j = intakeRouterStand\(\); return j && Array\.isArray\(j\.eigen_adressen\)/.test(sv));
  toets('server.js: /health sb2_berichten', /sb2_berichten: typeof sb2BerichtenInfo === 'function'/.test(sv));
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  onverwacht: ' + (e && e.stack)); process.exit(1); });
JS
