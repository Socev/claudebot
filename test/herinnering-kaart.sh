#!/usr/bin/env bash
# wv3905 (nr 356 = 3C56, David Ja 22-11 18:14): herinnering als Voor jou-kaart. Toetst herinnering-kaart.js op een verzonnen register en een
# nep-Voor jou-lijst (geen databank), met de echte registerlezer (kalender_deadlines.py --droog) als die er is:
#   1. kaart voor een [jij]-regel (op sleutel en op datum + titel): drie knoppen-stappen, uiterste datum, module kalender, spoed; geen
#      vaultpad of wvN in de kaarttekst; merkteken "GESEIND … (in Voor jou)" in de regel, andere sleutels gelijk
#   2. dezelfde regel nog eens: geen tweede kaart (al open); Later met datum morgen → weer open; dicht → al dicht; [Socev]-regel geweigerd
#   3. Gedaan (David, na 150 s) → regel naar Afgehandeld › Afgehandeld via Voor jou; telling voor = na; vóór 150 s niets
#   4. Later → verzet-merkteken; Niet meer nodig → VERVALLEN in Afgehandeld; elke tik maar één keer
#   5. regel elders afgehandeld (actielijstje) → open kaart door agent dicht; lijkende regel zonder zekere treffer → kaart blijft open
#   6. vrije herinnering (geen regel): kaart zonder register; titel+datum vereist
# Gebruik: bash test/herinnering-kaart.sh
set -u
cd "$(dirname "$0")/.." || exit 1
TMPV=$(mktemp -d); trap 'rm -rf "$TMPV"' EXIT
mkdir -p "$TMPV/00_Systeem"
TMPV="$TMPV" node - <<'JS'
const fs = require('fs'), path = require('path'), cp = require('child_process');
const HK = require('./herinnering-kaart.js'), DL = require('./deadline-lijstje.js');
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); if (!ok) fout++; };
const REG = [
  '---', 'type: register', '---', '', '# Deadlines — proef', '', '## Actueel', '',
  '| Datum | Entiteit | Wat | Actie | Signaleer | Bron |', '|---|---|---|---|---|---|',
  '| 2030-03-10 | Proefpraktijk | **Proefcertificaat verlengen** (verzonnen) zie [[01_Ontwikkeling/Proef plan\\|plan]] en wv1234 | [jij] David: verlengen in het proefportaal | 7 | [[10_Zakelijk/Proef\\|proef]] |',
  '| 2030-03-11 | Privé | **Proefzwemspullen inpakken** | [jij] David: tas klaarzetten | 2 | - |',
  '| 2030-03-12 | Systeem | **Proef systeemklus** | [Socev] Machinekamer: iets | 7 | - |',
  '| 2030-03-14 | Proefpraktijk | **Proefofferte tekenen voor de verbouwing** | [jij] David: tekenen | 7 | - |',
  '| 2030-03-14 | Proefpraktijk | **Proefofferte tekenen voor de verbouwing** (tweede) | [jij] David: idem | 7 | - |',
  '', '## Kandidaten (datum nog te achterhalen)', '', '- niets', '', '## Afgehandeld', '',
  '| Datum | Wat | Status |', '|---|---|---|', '| 2029-01-01 | oud | AFGEHANDELD |', '',
  '## Meetlog', '', '- M01: proef', '',
].join('\n');
const PY = process.env.DL_KALENDER_PY || '/opt/data/scripts/huidig/packages/sb2/src/socev_sb2/kalender_deadlines.py';
if (!fs.existsSync(PY)) { console.log('ROOD  echte lezer ontbreekt: ' + PY); process.exit(1); }
const pad = path.join(process.env.TMPV, '00_Systeem', 'Deadlines.md');
fs.writeFileSync(pad, REG);
const droog = () => JSON.parse(cp.execFileSync('python3', ['-I', PY, '--droog', '--vault', process.env.TMPV]).toString());
const tabelRegels = (t) => t.split('\n').filter((r) => /^\| \d{4}-/.test(r)).length;
// Nep-Voor jou (zoals mk_voor_jou_zet/status: upsert zonder status te raken; status met compare-and-set)
let NU = Date.parse('2030-03-08T17:00:00Z');
const vj = new Map(), logs = [];
const o = {
  mag: () => true, droog: async () => droog(), lees: () => fs.readFileSync(pad, 'utf8'),
  wijzig: (f) => { const n = f(fs.readFileSync(pad, 'utf8')); if (n === null) return false; fs.writeFileSync(pad, n); return true; },
  lijst: async () => [...vj.values()].map((p) => JSON.parse(JSON.stringify(p))),
  zet: async (p) => { const o0 = vj.get(p.sleutel); vj.set(p.sleutel, Object.assign({ status: 'open', bijgewerkt: new Date(NU).toISOString() }, o0 || {}, p, o0 ? { status: o0.status } : {})); },
  status: async (b) => { const p = vj.get(b.p_sleutel); if (!p || p.status !== b.p_van) return { ok: false };
    Object.assign(p, { status: b.p_naar, gesloten_door: b.p_door, bewijs: b.p_bewijs || p.bewijs, later_tot: b.p_later_tot || null, bijgewerkt: new Date(NU).toISOString(),
      gesloten_op: ['gedaan', 'vervallen'].includes(b.p_naar) ? new Date(NU).toISOString() : null }); return { ok: true }; },
  log: (s) => logs.push(s), vandaag: () => new Date(NU).toISOString().slice(0, 10), nu: () => NU,
};
const tik = (sleutel, naar, extra) => { const p = vj.get(sleutel); return o.status(Object.assign({ p_sleutel: sleutel, p_van: p.status, p_naar: naar, p_door: 'david', p_bewijs: 'app 8-3 18:00: David tikte ' + ({ gedaan: 'Gedaan', vervallen: 'Niet meer nodig', later: 'Later tot vr 13-3' })[naar] }, extra || {})); };
const R = HK.maak(o);
(async () => {
  const d0 = droog(), sl = (deel) => d0.items.find((i) => i.titel.indexOf(deel) >= 0).sleutel;
  const sCert = sl('Proefcertificaat'), sZwem = sl('Proefzwemspullen'), sSys = sl('Proef systeemklus');
  const anderen0 = d0.items.filter((i) => i.sleutel !== sCert).map((i) => i.sleutel).sort().join(',');
  // 1. kaart op sleutel
  let u = await R.kaartVoor({ sleutel: sCert });
  const k = vj.get(u.kaart);
  toets('1a nieuwe kaart op sleutel', u.ok && u.nieuw && k && k.sleutel === HK.kaartSleutel(sCert), u);
  toets('1b titel met uiterste datum, ≤ 90 tekens', k && /^Proefcertificaat verlengen.* — uiterlijk 10-3$/.test(k.titel) && k.titel.length <= 90, k && k.titel);
  toets('1c deadline, module kalender, spoed, herkomst met sleutel/datum/titel', k && k.deadline === '2030-03-10' && k.herkomst.module === 'kalender' && k.spoed && k.herkomst.herinnering.deadline === sCert && k.herkomst.herinnering.datum === '2030-03-10');
  const alles = k ? [k.titel, k.waarom].concat(k.stappen).join(' ') : '';
  toets('1d geen vaultpad, .md of wvN in de kaart (databank weigert die)', !/wv[0-9]|[0-9]{2}_[A-Z]|\.md\b|\/opt\/data/.test(alles), alles);
  toets('1e stappen noemen Gedaan, Later en Niet meer nodig', k && /Gedaan/.test(k.stappen.join(' ')) && /Later/.test(k.stappen.join(' ')) && /Niet meer nodig/.test(k.stappen.join(' ')), k && k.stappen);
  let t = o.lees();
  toets('1f merkteken GESEIND … (in Voor jou) in de regel', /\| 2030-03-10 \| Proefpraktijk \| \*\*GESEIND 8-3 \d{2}:\d{2} \(in Voor jou\)\.\*\* \*\*Proefcertificaat/.test(t), t.split('\n')[10]);
  const d1 = droog();
  toets('1g sleutels van alle regels gelijk na het merkteken', d1.items.map((i) => i.sleutel).sort().join(',') === d0.items.map((i) => i.sleutel).sort().join(','));
  const lijstje = DL.maak({ mag: () => true, droog: async () => droog(), lees: o.lees, wijzig: o.wijzig, rijen: async () => [], vandaag: () => '2030-03-08', log: () => {} });
  const dls = await lijstje.deadlines();
  toets('1h0 regel met kaart niet ook in het actielijstje; andere [jij]-regel wel', !dls.some((i) => i.sleutel === sCert) && dls.some((i) => /Proefofferte/.test(i.titel)), dls.map((i) => i.titel));
  toets('1h merkteken telt als het lijstje-merkteken (MERK_RE)', DL.MERK_RE.test('**GESEIND 8-3 18:00 (in Voor jou).** x') && DL.MERK_RE.test('**GESEIND 8-3 (in Voor jou; verzet naar 13-3-2030).** x'));
  // 1i op datum + titel
  u = await R.kaartVoor({ datum: '2030-03-11', titel: 'Proefzwemspullen inpakken' });
  toets('1i kaart op datum + titel; privé', u.ok && u.nieuw && vj.get(HK.kaartSleutel(sZwem)) && vj.get(HK.kaartSleutel(sZwem)).prive === true, u);
  u = await R.kaartVoor({ datum: '2030-03-14', titel: 'Proefofferte tekenen voor de verbouwing' });
  toets('1j twee lijkende regels op dezelfde datum: geen kaart (geen zekere treffer)', !u.ok, u);
  // 2. dubbel / Socev
  { // 2-0 merkteken mislukt bij aanmaak (gelijktijdige wijziging) → hersteld bij de volgende aanvraag
    const t0 = o.lees(), zonder = t0.replace(/\*\*GESEIND 8-3 \d{2}:\d{2} \(in Voor jou\)\.\*\* (\*\*Proefcertificaat)/, '$1');
    fs.writeFileSync(pad, zonder);
    const u0 = await R.kaartVoor({ sleutel: sCert });
    toets('2-0 bestaande kaart zonder merkteken: merkteken hersteld', u0.ok && u0.al === 'open' && u0.merkteken === 'gezet' && /GESEIND 8-3 \d{2}:\d{2} \(in Voor jou\)\.\*\* \*\*Proefcertificaat/.test(o.lees()), u0);
  }
  u = await R.kaartVoor({ sleutel: sCert });
  toets('2a zelfde regel: geen tweede kaart (al open)', u.ok && u.al === 'open' && vj.size === 2, u);
  u = await R.kaartVoor({ sleutel: sSys });
  toets('2b [Socev]-regel: geweigerd', !u.ok, u);
  // 3. Gedaan
  const voorN = tabelRegels(o.lees());
  await tik(HK.kaartSleutel(sCert), 'gedaan');
  NU += 60 * 1000;
  let w = await R.verwerk();
  toets('3a vóór 150 s: niets in het register', w.register === 0 && /\| 2030-03-10 \| Proefpraktijk \| \*\*GESEIND/.test(o.lees()), w);
  NU += 120 * 1000;
  w = await R.verwerk();
  t = o.lees();
  const act = t.split('## Kandidaten')[0], af = t.slice(t.indexOf('\n## Afgehandeld'));
  toets('3b na 150 s: regel uit Actueel, onder Afgehandeld via Voor jou met AFGEHANDELD', w.register === 1 && !/Proefcertificaat/.test(act) && /### Afgehandeld via Voor jou[\s\S]*\| 2030-03-10 \| Proefpraktijk \| \*\*AFGEHANDELD 8-3-2030 \(Gedaan in Voor jou\)\.\*\* \*\*Proefcertificaat/.test(af), w);
  toets('3c telling voor = na (niets gewist)', tabelRegels(t) === voorN, [voorN, tabelRegels(t)]);
  w = await R.verwerk();
  toets('3d tweede ronde: niets nieuws', w.register === 0, w);
  toets('3e andere sleutels gelijk', droog().items.map((i) => i.sleutel).sort().join(',') === anderen0, null);
  u = await R.kaartVoor({ sleutel: sCert });
  toets('3f regel weg uit Actueel: geen nieuwe kaart', !u.ok, u);
  // 4. Later en Niet meer nodig
  await tik(HK.kaartSleutel(sZwem), 'later', { p_later_tot: '2030-03-10' });
  NU += 200 * 1000;
  w = await R.verwerk();
  t = o.lees();
  toets('4a Later → verzet-merkteken in de regel (vervangt GESEIND)', w.register === 1 && /\| 2030-03-11 \| Privé \| \*\*GESEIND 8-3 \(in Voor jou; verzet naar 10-3-2030\)\.\*\* \*\*Proefzwemspullen/.test(t) && !/GESEIND 8-3 \d{2}:\d{2} \(in Voor jou\)\.\*\* \*\*GESEIND/.test(t), t.split('\n').find((r) => /2030-03-11/.test(r)));
  NU = Date.parse('2030-03-10T17:00:00Z');
  u = await R.kaartVoor({ sleutel: sZwem });
  toets('4b Later, uiterste datum morgen: kaart weer open (geen tweede)', u.ok && u.al === 'weer open' && vj.get(HK.kaartSleutel(sZwem)).status === 'open' && vj.size === 2, u);
  await tik(HK.kaartSleutel(sZwem), 'vervallen');
  NU += 200 * 1000;
  w = await R.verwerk();
  t = o.lees();
  toets('4c Niet meer nodig → VERVALLEN onder Afgehandeld via Voor jou', w.register === 1 && /\*\*VERVALLEN 10-3-2030 \(Niet meer nodig, in Voor jou\)\.\*\* \*\*GESEIND 8-3 \(in Voor jou; verzet/.test(t) === false && /\*\*VERVALLEN 10-3-2030 \(Niet meer nodig, in Voor jou\)\.\*\* \*\*Proefzwemspullen/.test(t.slice(t.indexOf('\n## Afgehandeld'))), t.slice(t.indexOf('\n## Afgehandeld')));
  u = await R.kaartVoor({ sleutel: sZwem });
  toets('4d dichte kaart / afgehandelde regel: niets nieuws', !u.ok || u.al === 'dicht', u);
  // 5. elders afgehandeld → kaart dicht; lijkend zonder zekere treffer blijft
  fs.writeFileSync(pad, REG);   // vers register
  vj.clear(); NU = Date.parse('2030-03-08T17:00:00Z');
  const R2 = HK.maak(o);
  u = await R2.kaartVoor({ sleutel: sCert });
  // het actielijstje handelt dezelfde regel af (deadline-lijstje.js, Gedaan)
  const it = DL.rijp(droog().items, o.lees(), '2030-03-08').find((i) => i.sleutel === sCert);
  await DL.schrijf(o, { sleutel: sCert, datum: it.datum, titel: it.titel, keuze: 'gedaan', vandaag: '2030-03-08' });
  // tweede kaart op een regel die blijft
  await R2.kaartVoor({ sleutel: sZwem });
  NU += 60 * 1000;
  w = await R2.verwerk();
  toets('5a regel via het actielijstje afgehandeld → kaart door agent dicht', w.dicht === 1 && vj.get(HK.kaartSleutel(sCert)).status === 'gedaan' && vj.get(HK.kaartSleutel(sCert)).gesloten_door === 'agent', w);
  toets('5b kaart van een regel die nog in Actueel staat blijft open', vj.get(HK.kaartSleutel(sZwem)).status === 'open');
  w = await R2.verwerk();
  toets('5c agent-sluiting schrijft niets in het register (alleen Davids tik)', w.register === 0 && w.dicht === 0, w);
  // 6. vrij
  u = await R2.kaartVoor({ vrij: true, titel: 'Proefpakket ophalen bij het afhaalpunt', datum: '2030-03-09', wat: 'David: pakket ophalen' });
  const kv = u.ok && vj.get(u.kaart);
  toets('6a vrije herinnering: kaart zonder registerkoppeling', u.ok && u.nieuw && /^herinnering-v-/.test(u.kaart) && kv.herkomst.herinnering.vrij === true && kv.titel === 'Proefpakket ophalen bij het afhaalpunt — uiterlijk 9-3', kv && kv.titel);
  u = await R2.kaartVoor({ vrij: true, titel: 'x', datum: '' });
  toets('6b vrije herinnering zonder titel/datum: geweigerd', !u.ok, u);
  u = await R2.kaartVoor({ vrij: true, titel: 'Proefzwemspullen inpakken', datum: '2030-03-11' });
  toets('6c vrij, maar de regel staat in het register: de registerkaart (geen tweede)', u.ok && u.kaart === HK.kaartSleutel(sZwem) && u.al === 'open', u);
  await tik(u.kaart.startsWith('herinnering-v') ? u.kaart : (await R2.kaartVoor({ vrij: true, titel: 'Proefpakket ophalen bij het afhaalpunt', datum: '2030-03-09' })).kaart, 'gedaan');
  NU += 200 * 1000;
  const voor6 = o.lees(); w = await R2.verwerk();
  toets('6d Gedaan op een vrije kaart: register ongemoeid', w.register === 0 && o.lees() === voor6, w);
  u = await R2.kaartVoor({ vrij: true, titel: 'Proefpakket ophalen', datum: '2030-02-31' });
  toets('6e vrij met een niet-bestaande datum (31-2): geweigerd', !u.ok, u);
  u = await R2.kaartVoor({ vrij: true, titel: 'Proefpakket ophalen', datum: '2032-03-09' });
  toets('6f vrij met een datum ver weg: geweigerd', !u.ok, u);
  // 6g lijstje-merkteken (met verzet) gaat over naar Voor jou
  fs.writeFileSync(pad, REG.replace('**Proefofferte tekenen voor de verbouwing** (tweede)', '**GESEIND 7-3 (in je actielijstje; verzet naar 12-3-2030).** **Proefofferte tekenen nummer twee**')
    .replace('| 2030-03-14 | Proefpraktijk | **Proefofferte tekenen voor de verbouwing** |', '| 2030-03-14 | Proefpraktijk | **GESEIND 7-3 07:05 (in je actielijstje).** **Proefofferte tekenen voor de verbouwing** |'));
  vj.clear(); NU = Date.parse('2030-03-08T17:00:00Z');
  const R3 = HK.maak(o);
  u = await R3.kaartVoor({ datum: '2030-03-14', titel: 'Proefofferte tekenen nummer twee' });
  t = o.lees();
  toets('6g lijstje-merkteken met verzet → Voor jou-merkteken, verzetdatum blijft', u.ok && u.merkteken === 'gezet' && /\*\*GESEIND 8-3 \(in Voor jou; verzet naar 12-3-2030\)\.\*\* \*\*Proefofferte tekenen nummer twee/.test(t), t.split('\n').filter((r) => /2030-03-14/.test(r)));
  u = await R3.kaartVoor({ datum: '2030-03-14', titel: 'Proefofferte tekenen voor de verbouwing' });
  t = o.lees();
  toets('6h lijstje-merkteken zonder verzet → GESEIND … (in Voor jou)', u.ok && /\| \*\*GESEIND 8-3 \d{2}:\d{2} \(in Voor jou\)\.\*\* \*\*Proefofferte tekenen voor de verbouwing/.test(t), t.split('\n').filter((r) => /2030-03-14/.test(r)));
  const dls2 = await DL.maak({ mag: () => true, droog: async () => droog(), lees: o.lees, wijzig: o.wijzig, rijen: async () => [], vandaag: () => '2030-03-08', log: () => {} }).deadlines();
  toets('6i beide niet meer in het actielijstje', !dls2.some((i) => /Proefofferte/.test(i.titel)), dls2.map((i) => i.titel));
  // 7. schoon
  toets('7a schoon haalt wvN, vaultpaden en .md weg', HK.schoon('zie wv3707 en 00_Systeem/Deadlines.md en [[01_Ontwikkeling/Plan|plan]] klaar', 200) === 'zie en en plan klaar', HK.schoon('zie wv3707 en 00_Systeem/Deadlines.md en [[01_Ontwikkeling/Plan|plan]] klaar', 200));
  console.log(fout ? fout + ' ROOD' : 'alles groen');
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering ' + (e && e.stack || e)); process.exit(1); });
JS
