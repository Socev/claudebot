#!/usr/bin/env bash
# wv3707 (nr 371 = 3C71, David Ja 21-11 13:09): deadlines in het actielijstje. Toetst deadline-lijstje.js op een verzonnen register:
#   1. rijp: alleen [jij], seinmoment bereikt (datum − Signaleer), hooguit 14 dagen voorbij; notitie-titel → vetgedrukte titel
#   2. getoond / later: merkteken vooraan in Wat, vervangen en niet gestapeld, idempotent
#   3. gedaan / hoeft niet: hele regel naar ## Afgehandeld › eigen tabel; telling voor = na; lijkende regel blijft staan
#   4. zoeken: op sleutel (met datum + titel als controle), anders alleen bij precies één treffer op datum + titel
#   5. teDoen: ↩️-rust (150 s), getoond alleen op de dag zelf, een verwerkte tik maar één keer
#   6. met de echte lezer (kalender_deadlines.py --droog, als aanwezig): sleutels van de andere regels blijven gelijk
# Gebruik: bash test/deadline-lijstje.sh
set -u
cd "$(dirname "$0")/.." || exit 1
TMPV=$(mktemp -d); trap 'rm -rf "$TMPV"' EXIT
mkdir -p "$TMPV/00_Systeem"
TMPV="$TMPV" node - <<'JS'
const fs = require('fs'), path = require('path'), cp = require('child_process');
const DL = require('./deadline-lijstje.js');
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); if (!ok) fout++; };
const REG = [
  '---', 'type: register', '---', '', '# Deadlines — proef', '', '## Actueel', '',
  '| Datum | Entiteit | Wat | Actie | Signaleer | Bron |', '|---|---|---|---|---|---|',
  '| 2030-03-10 | Proefpraktijk | **Proefdeadline kwartaalopgave indienen** (verzonnen) | [jij] David: opgave invullen in het portaal | 7 | [[10_Zakelijk/Proef\\|proef]] |',
  '| 2030-03-20 | Proefpraktijk | **Proefdeadline kwartaalopgave indienen** (tweede, verzonnen) | [jij] David: idem | 7 | [[10_Zakelijk/Proef]] |',
  '| 2030-03-09 | Systeem | **Proef systeemklus** | [Socev] Machinekamer: iets | 7 | - |',
  '| 2030-03-12 | Privé | **NIET GESEIND 1-3 (heartbeat): notitie.** **Proefzwemles opgeven voor de cursus** | [jij] David: aanmelden | 3 | - |',
  '| 2030-02-01 | Proefpraktijk | **Heel oude proefdeadline** | [jij] David: iets | 7 | - |',
  '| 2030-04-30 | Proefpraktijk | **Verre proefdeadline** | [jij] David: later | 7 | - |',
  '', '## Kandidaten (datum nog te achterhalen)', '', '- niets', '', '## Afgehandeld', '',
  '| Datum | Wat | Status |', '|---|---|---|', '| 2029-01-01 | oud | AFGEHANDELD |', '',
  '## Meetlog', '', '- M01: proef', '',
].join('\n');
const PY = process.env.DL_KALENDER_PY || '/opt/data/scripts/huidig/packages/sb2/src/socev_sb2/kalender_deadlines.py';
const metPy = fs.existsSync(PY);
const pad = path.join(process.env.TMPV, '00_Systeem', 'Deadlines.md');
const droog = (tekst) => {
  if (metPy) { fs.writeFileSync(pad, tekst); return JSON.parse(cp.execFileSync('python3', ['-I', PY, '--droog', '--vault', process.env.TMPV]).toString()).items; }
  // Zonder de echte lezer: eenvoudige nep (sleutel op titel), alleen voor de structuurtoetsen
  return tekst.split('\n').map((r, i) => ({ r, i })).filter((x) => /^\| \d{4}-/.test(x.r) && tekst.split('\n').slice(0, x.i).some((y) => y === '## Actueel') && !tekst.split('\n').slice(0, x.i).some((y) => y === '## Kandidaten (datum nog te achterhalen)'))
    .map((x) => { const c = DL.cellen(x.r); const t = (/\*\*(.+?)\*\*/.exec(c[2]) || [])[1] || c[2];
      return { titel: t, datum: c[0], omschrijving: 'Actie: ' + c[3].replace(/^\[(jij|Socev|ter info)\]\s*/, ''), bron: { regel: x.i + 1, etiket: /^\[Socev\]/.test(c[3]) ? 'socev' : 'jij', entiteit: c[1], signaleer: +c[4] },
        sleutel: 'dl:' + require('crypto').createHash('sha256').update(c[1] + '|' + t + '|' + c[0]).digest('hex').slice(0, 40) }; });
};
console.log(metPy ? 'met de echte lezer ' + PY : 'ZONDER echte lezer (nep-droog)');
let items = droog(REG);
const sl = (deel) => (items.find((i) => i.titel.indexOf(deel) >= 0 || (i.titel + '').length === 0) || {}).sleutel;

// 1. rijp op 2030-03-05: seinmoment 10-3 (7) = 3-3 bereikt; 20-3 (7) = 13-3 nog niet; Socev nooit; 12-3 (3) = 9-3 nog niet; 1-2 te oud
let r = DL.rijp(items, REG, '2030-03-05');
toets('1a rijp op 5-3: alleen de eerste [jij]-proefdeadline', r.length === 1 && r[0].datum === '2030-03-10', r);
r = DL.rijp(items, REG, '2030-03-10');
toets('1b rijp op 10-3: 10-3 en 12-3 (seinmoment 9-3), niet 20-3, niet Socev, niet 1-2 (te oud)', r.map((x) => x.datum).join(',') === '2030-03-10,2030-03-12', r.map((x) => x.datum));
const zwem = r.find((x) => x.datum === '2030-03-12');
toets('1c notitie-titel ("NIET GESEIND …") → de vetgedrukte titel', zwem && zwem.titel === 'Proefzwemles opgeven voor de cursus', zwem && zwem.titel);
toets('1d actie zonder etiket mee', r[0].actie === 'David: opgave invullen in het portaal', r[0].actie);
r = DL.rijp(items, REG, '2030-02-14');
toets('1e verlopen hooguit 14 dagen: 1-2 op 14-2 nog wel, op 16-2 niet', r.some((x) => x.datum === '2030-02-01') && !DL.rijp(items, REG, '2030-02-16').some((x) => x.datum === '2030-02-01'));

// wv3711: vol = ook de ruwe cellen Actie en Bron (werklast achteraan, voorbij 300 tekens); zonder vol blijft de uitvoer gelijk
{
  const lang = REG.replace('[jij] David: opgave invullen in het portaal', '[jij] David: opgave invullen in het portaal ' + 'x'.repeat(320) + ' ⏱ ± 1 u');
  const v = DL.rijp(droog(lang), lang, '2030-03-05', true).find((x) => x.datum === '2030-03-10');
  const z = DL.rijp(droog(lang), lang, '2030-03-05').find((x) => x.datum === '2030-03-10');
  toets('1f vol: actie_cel met de werklast achteraan, bron_cel met de link', v && /⏱ ± 1 u$/.test(v.actie_cel) && /^\[\[10_Zakelijk\/Proef/.test(v.bron_cel) && v.actie.length <= 300, v);
  toets('1g zonder vol: geen extra velden (Voorwerk-uitvoer gelijk)', z && !('actie_cel' in z) && !('bron_cel' in z), z);
}
const eerste = DL.rijp(items, REG, '2030-03-05')[0];
const t0 = { sleutel: eerste.sleutel, datum: eerste.datum, titel: eerste.titel, vandaag: '2030-03-05' };
// 2. getoond
let u = DL.pasToe(REG, items, Object.assign({}, t0, { keuze: 'getoond', tijd: '07:05' }));
toets('2a getoond: merkteken vooraan in Wat', u.tekst && u.tekst.indexOf('| 2030-03-10 | Proefpraktijk | **GESEIND 5-3 07:05 (in je actielijstje).** **Proefdeadline kwartaalopgave indienen** (verzonnen) |') >= 0, u);
const na1 = u.tekst;
toets('2b alleen die ene regel anders', na1.split('\n').filter((x, i) => x !== REG.split('\n')[i]).length === 1 && na1.split('\n').length === REG.split('\n').length);
items = droog(na1);
toets('2c sleutel blijft gelijk na het merkteken', items.some((i) => i.sleutel === eerste.sleutel), items.map((i) => i.titel));
u = DL.pasToe(na1, items, Object.assign({}, t0, { keuze: 'getoond', tijd: '07:05', vandaag: '2030-03-06' }));
toets('2d getoond nog eens = niets (al gemerkt, niet gestapeld)', u.niets === 'al gemerkt', u);
u = DL.pasToe(na1, items, Object.assign({}, t0, { keuze: 'later', later_tot: '2030-03-08', vandaag: '2030-03-05' }));
toets('2e later: vervangt het merkteken', u.tekst && u.tekst.indexOf('| **GESEIND 5-3 (in je actielijstje; verzet naar 8-3-2030).** **Proefdeadline kwartaalopgave') >= 0 && (u.tekst.match(/in je actielijstje/g) || []).length === 1, u);
const na2 = u.tekst; items = droog(na2);
u = DL.pasToe(na2, items, Object.assign({}, t0, { keuze: 'later', later_tot: '2030-03-08', vandaag: '2030-03-05' }));
toets('2f later nog eens = niets (al zo)', u.niets === 'al zo', u);
u = DL.pasToe(na2, items, Object.assign({}, t0, { keuze: 'getoond', vandaag: '2030-03-08', tijd: '07:05' }));
toets('2g getoond overschrijft een verzet-merkteken niet', u.niets === 'al gemerkt', u);

// 3. gedaan
const telRijen = (t) => (t.match(/^\| \d{4}-\d{2}-\d{2} \|/mg) || []).length;
u = DL.pasToe(na2, items, Object.assign({}, t0, { keuze: 'gedaan', vandaag: '2030-03-06' }));
const na3 = u.tekst || '';
const act = na3.slice(na3.indexOf('## Actueel'), na3.indexOf('## Kandidaten'));
const afg = na3.slice(na3.indexOf('## Afgehandeld'), na3.indexOf('## Meetlog'));
toets('3a gedaan: regel weg uit Actueel', act.indexOf('Proefdeadline kwartaalopgave indienen** (verzonnen)') < 0, act);
toets('3b gedaan: regel in Afgehandeld › eigen tabel, AFGEHANDELD vooraan, eigen merkteken eraf', afg.indexOf(DL.AF_KOP + '\n\n| Datum | Entiteit | Wat | Actie | Signaleer | Bron |\n|---|---|---|---|---|---|\n| 2030-03-10 | Proefpraktijk | **AFGEHANDELD 6-3-2030 (Gedaan in je actielijstje).** **Proefdeadline') >= 0, afg);
toets('3c telling voor = na (niets gewist)', telRijen(na3) === telRijen(REG), [telRijen(na3), telRijen(REG)]);
toets('3d lijkende regel (zelfde titel, 20-3) blijft open', act.indexOf('| 2030-03-20 | Proefpraktijk | **Proefdeadline kwartaalopgave indienen** (tweede') >= 0);
toets('3e Meetlog en Kandidaten ongemoeid', na3.indexOf('## Meetlog\n\n- M01: proef') >= 0 && na3.indexOf('## Kandidaten (datum nog te achterhalen)\n\n- niets') >= 0);
items = droog(na3);
toets('3f lezer ziet hem niet meer; andere sleutels gelijk', !items.some((i) => i.sleutel === eerste.sleutel) && items.length === droog(REG).length - 1);
u = DL.pasToe(na3, items, Object.assign({}, t0, { keuze: 'gedaan', vandaag: '2030-03-06' }));
toets('3g gedaan nog eens = al afgehandeld', u.niets === 'al afgehandeld', u);
// tweede gedaan (hoeft niet) komt in dezelfde tabel
const z = DL.rijp(items, na3, '2030-03-10').find((x) => x.datum === '2030-03-12');
u = DL.pasToe(na3, items, { sleutel: z.sleutel, datum: z.datum, titel: z.titel, keuze: 'laten_vallen', vandaag: '2030-03-10' });
const na4 = u.tekst || '';
toets('3h hoeft niet: VERVALLEN, onder dezelfde kop, direct na de eerste', na4.split(DL.AF_KOP).length === 2 && /\| 2030-03-10 \| Proefpraktijk \| \*\*AFGEHANDELD[^\n]*\n\| 2030-03-12 \| Privé \| \*\*VERVALLEN 10-3-2030 \(Hoeft niet, in je actielijstje\)\.\*\* \*\*NIET GESEIND/.test(na4), na4.slice(na4.indexOf(DL.AF_KOP)));
toets('3i telling voor = na', telRijen(na4) === telRijen(REG));

// 4. zoeken
const tw = items.find((i) => i.datum === '2030-03-20');
u = DL.pasToe(na3, items, { sleutel: 'dl:' + '0'.repeat(40), datum: '2030-03-20', titel: 'Proefdeadline kwartaalopgave indienen', keuze: 'getoond', vandaag: '2030-03-13', tijd: '07:05' });
toets('4a onbekende sleutel, één treffer op datum + titel → die regel', u.tekst && u.regel === tw.bron.regel, u);
const dubbel = na3.replace('| 2030-03-20 | Proefpraktijk |', '| 2030-03-20 | Proefpraktijk | **Proefdeadline kwartaalopgave indienen** (derde) | [jij] x | 7 | - |\n| 2030-03-20 | Proefpraktijk |');
toets('4b0 toetsdata: twee nette regels op 20-3', (dubbel.match(/^\| 2030-03-20 \| Proefpraktijk \| \*\*Proefdeadline kwartaalopgave indienen\*\*/mg) || []).length === 2);
// Codex MOET 1: titel alleen in de cel Actie van een andere regel telt niet
const inActie = na3.replace('| 2030-03-20 | Proefpraktijk | **Proefdeadline kwartaalopgave indienen** (tweede, verzonnen) | [jij] David: idem |', '| 2030-03-20 | Proefpraktijk | **Iets heel anders** | [jij] David: zie Proefdeadline kwartaalopgave indienen |');
u = DL.pasToe(inActie, [], { sleutel: 'dl:' + '0'.repeat(40), datum: '2030-03-20', titel: 'Proefdeadline kwartaalopgave indienen', keuze: 'gedaan', vandaag: '2030-03-13' });
toets('4e titel alleen in Actie van een andere regel → niets', u.niets === 'regel niet gevonden', u);
u = DL.pasToe(dubbel, [], { sleutel: 'dl:' + '0'.repeat(40), datum: '2030-03-20', titel: 'Proefdeadline kwartaalopgave indienen', keuze: 'gedaan', vandaag: '2030-03-13' });
toets('4b twee treffers → niets schrijven', u.niets === 'regel niet gevonden', u);
u = DL.pasToe(na3, items, { sleutel: tw.sleutel, datum: '2030-03-21', titel: tw.titel, keuze: 'gedaan', vandaag: '2030-03-13' });
toets('4c sleutel klopt maar datum niet → niets', u.niets === 'regel niet gevonden', u);
u = DL.pasToe(na3, items, { sleutel: tw.sleutel, datum: tw.datum, titel: 'Een heel andere klus met andere tekst', keuze: 'gedaan', vandaag: '2030-03-13' });
toets('4d sleutel klopt maar titel niet → niets', u.niets === 'regel niet gevonden', u);

// 5. teDoen
const nu = Date.parse('2030-03-05T09:00:00Z');
const rij = (o) => Object.assign({ bron: 'deadline', sleutel: eerste.sleutel, datum: '2030-03-05', hard: '2030-03-10', titel: 'Proefdeadline kwartaalopgave', nonce: 'a'.repeat(32) }, o);
let td = DL.teDoen([rij({ status: 'afgehandeld', keuze: 'gedaan', getikt_op: new Date(nu - 60000).toISOString() })], nu, new Set(), '2030-03-05');
toets('5a tik van 1 min geleden: nog niet (↩️ kan nog)', td.length === 0, td);
td = DL.teDoen([rij({ status: 'afgehandeld', keuze: 'gedaan', getikt_op: new Date(nu - 200000).toISOString() })], nu, new Set(), '2030-03-05');
toets('5b tik van 200 s geleden: gedaan, met datum en titel uit de rij', td.length === 1 && td[0].keuze === 'gedaan' && td[0].datum === '2030-03-10', td);
toets('5c verwerkt merk telt niet nog eens', DL.teDoen([rij({ status: 'afgehandeld', keuze: 'gedaan', getikt_op: new Date(nu - 200000).toISOString() })], nu, new Set([td[0].merk]), '2030-03-05').length === 0);
toets('5d getoond: alleen open + verzonden + van vandaag', DL.teDoen([rij({ status: 'open', keuze: '', verzonden_op: 'x' })], nu, new Set(), '2030-03-05').length === 1
  && DL.teDoen([rij({ status: 'open', keuze: '', verzonden_op: 'x', datum: '2030-03-04' })], nu, new Set(), '2030-03-05').length === 0
  && DL.teDoen([rij({ status: 'klaar', keuze: '' })], nu, new Set(), '2030-03-05').length === 0);
// wv3708: tijdstip = verzonden_op (NL-tijd); onleesbaar = 07:05
toets('5f getoond: tijd uit verzonden_op (zaterdag 08:30), onleesbaar = 07:05', DL.teDoen([rij({ status: 'open', keuze: '', verzonden_op: '2030-03-05T07:30:12Z' })], nu, new Set(), '2030-03-05')[0].tijd === '08:30'
  && DL.teDoen([rij({ status: 'open', keuze: '', verzonden_op: 'x' })], nu, new Set(), '2030-03-05')[0].tijd === '07:05');
toets('5e andere bron telt niet', DL.teDoen([rij({ bron: 'todoist', status: 'afgehandeld', keuze: 'gedaan', getikt_op: new Date(nu - 200000).toISOString() })], nu, new Set(), '2030-03-05').length === 0);

// 6. runner: gedaan via maak() op het nep-register (wijzig = in het geheugen)
(async () => {
  let pagina = REG; const logs = [];
  const runner = DL.maak({ droog: async () => ({ items: droog(pagina) }), lees: () => pagina, wijzig: (f) => { const n = f(pagina); if (n == null) return false; pagina = n; return true; },
    rijen: async () => [rij({ status: 'afgehandeld', keuze: 'gedaan', getikt_op: new Date(Date.now() - 200000).toISOString() })], vandaag: () => '2030-03-05', log: (s) => logs.push(s) });
  const a = await runner.verwerk(); const b = await runner.verwerk();
  toets('6a runner: één keer geschreven, tweede ronde niets', a.gedaan === 1 && b.gedaan === 0 && pagina.indexOf('**AFGEHANDELD') > 0, [a, b, logs]);
  const lijst = await runner.deadlines();
  toets('6b deadlines() na Gedaan: niet meer rijp', !lijst.some((x) => x.sleutel === eerste.sleutel), lijst);
  // Codex ronde 2: pagina verandert tussen droog en schrijven → niets; passieve rol → niets
  let p2 = REG, n = 0;
  const r2 = DL.maak({ droog: async () => { const d = { items: droog(p2) }; p2 = p2 + '\n'; return d; }, lees: () => p2, wijzig: (f) => { const x = f(p2); if (x == null) return false; p2 = x; n++; return true; },
    rijen: async () => [rij({ status: 'afgehandeld', keuze: 'gedaan', getikt_op: new Date(Date.now() - 200000).toISOString() })], vandaag: () => '2030-03-05', log: () => {} });
  const c = await r2.verwerk();
  toets('6c pagina veranderde tijdens het lezen → niets geschreven', n === 0 && c.gedaan === 0, c);
  let p3 = REG, rolOk = true; const r3 = DL.maak({ mag: () => rolOk, droog: async () => { rolOk = false; return { items: droog(p3) }; }, lees: () => p3, wijzig: (f) => { const x = f(p3); if (x == null) return false; p3 = x; return true; },
    rijen: async () => [rij({ status: 'afgehandeld', keuze: 'gedaan', getikt_op: new Date(Date.now() - 200000).toISOString() })], vandaag: () => '2030-03-05', log: () => {} });
  const d3 = await r3.verwerk();
  toets('6d rol wordt passief tijdens het lezen → niets geschreven', p3 === REG && d3.gedaan === 0, d3);
  console.log(fout ? fout + ' ROOD' : 'alles groen');
  process.exit(fout ? 1 : 0);
})();
JS
