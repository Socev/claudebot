#!/usr/bin/env bash
# Toetst onderhoud.js (wv1271, onderhoudsstand van de vault; Second Brain 2.0 fase 1a): stand uit/aan/onleesbaar/andere eigenaar, wie wacht
# (automatisch ja; Telegram van David en alleen-lezen nee), wacht lost pas op na uit, grendelproces houdt een echte flock vast en stopt bij uit,
# na een herstart opnieuw gestart, alarm na 2 uur precies één keer per aan-periode (ook na herstart), geen alarm bij uit.
# Raakt niets buiten een wegwerpmap. Gebruik: bash test/onderhoud.sh
set -u
cd "$(dirname "$0")/.." || exit 1
command -v flock >/dev/null || { echo "ROOD  flock ontbreekt"; exit 1; }
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), { spawn, spawnSync } = require('child_process');
const O = require('./onderhoud.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onderhoud-'));
const B = path.join(d, 'onderhoudsstand.json'), L = path.join(d, 'vault.lock');
fs.writeFileSync(L, '');
let klok = Date.parse('2026-10-26T20:00:00Z');
const berichten = [];
function mod(extra) {
  return O.maak(Object.assign({ bestand: B, lock: L, houderBestand: B + '.houder', alarmBestand: B + '.alarm', spawn: spawn, nu: () => klok,
    wachtStapMs: 50, houderSlaapS: 0.2, tijdNl: (x) => x, bericht: async (t) => { berichten.push(t); return { status: 200 }; } }, extra || {}));
}
function vrij() { return spawnSync('flock', ['-n', L, 'true']).status === 0; }
function zet(obj) { fs.writeFileSync(B, typeof obj === 'string' ? obj : JSON.stringify(obj)); }
(async function () {
  const wakker = setInterval(() => {}, 1000);   // de wachttimers zijn unref (in de pod houdt de server het proces in leven)
  let m = mod();
  toets('1 geen bestand = uit', m.stand().aan === false && m.moetWachten({}) === false);
  zet({ aan: true, sinds: '2026-10-26T20:00:00Z', reden: 'proef', door: 'toets' });
  toets('1 aan', m.stand().aan === true && m.stand().reden === 'proef' && m.stand().grendel === 'wacht', m.stand());
  toets('1 automatische beurt wacht', m.moetWachten({ bron: '' }) === true);
  toets('1 Telegram van David wacht niet', m.moetWachten({ bron: 'telegram' }) === false);
  toets('1 alleen-lezen wacht niet', m.moetWachten({ gereedschap: 'lezen' }) === false);
  toets('1 bestand van een andere eigenaar telt niet', mod({ uid: 4242 }).stand().aan === false && !!mod({ uid: 4242 }).stand().genegeerd);
  zet('{kapot'); toets('1 onleesbaar = aan (veilige kant)', m.stand().aan === true && m.stand().onleesbaar === true);
  zet({ aan: false }); toets('1 aan:false = uit', m.stand().aan === false);
  // 2. wachten
  zet({ aan: true, sinds: '2026-10-26T20:00:00Z' });
  let klaar = false;
  const w = m.wacht('job1').then(() => { klaar = true; });
  await slaap(200);
  toets('2 wacht zolang aan', klaar === false && m.stand().wachtend === 1);
  fs.unlinkSync(B);
  await w;
  toets('2 door na uit', klaar === true && m.stand().wachtend === 0);
  // 3. grendel
  zet({ aan: true, sinds: '2026-10-26T20:00:00Z' });
  let r = await m.tik();
  toets('3 tik start het grendelproces', r.houder_gestart === true, r);
  for (let i = 0; i < 40 && m.stand().grendel !== 'vast'; i++) await slaap(50);
  toets('3 grendel vast (flock bezet)', m.stand().grendel === 'vast' && !vrij(), m.stand());
  r = await m.tik();
  toets('3 tweede tik start geen tweede proces', !r.houder_gestart, r);
  const m2 = mod();   // "herstart van server.js": nieuw object, het proces leeft nog
  r = await m2.tik();
  toets('3 na herstart: bestaand proces herkend', !r.houder_gestart && m2.stand().grendel === 'vast', r);
  zet({ aan: false });
  for (let i = 0; i < 40 && !vrij(); i++) await slaap(50);
  toets('3 uit: grendel los en houderbestand weg', vrij() && !fs.existsSync(B + '.houder'));
  // 4. alarm
  zet({ aan: true, sinds: '2026-10-26T20:00:00Z', reden: 'verhuizen' });
  klok = Date.parse('2026-10-26T21:59:00Z'); r = await m.tik();
  toets('4 geen alarm vóór 2 uur', !r.alarm && berichten.length === 0);
  klok = Date.parse('2026-10-26T22:00:30Z'); r = await m.tik();
  toets('4 alarm na 2 uur', r.alarm === true && berichten.length === 1 && /2 uur/.test(berichten[0]) && /niets hervat vanzelf/.test(berichten[0]), berichten);
  r = await m.tik(); r = await mod().tik();
  toets('4 geen tweede alarm (ook niet na herstart)', berichten.length === 1);
  zet({ aan: true, sinds: '2026-10-27T08:00:00Z' }); klok = Date.parse('2026-10-27T10:05:00Z'); r = await m.tik();
  toets('4 nieuwe aan-periode: nieuw alarm', berichten.length === 2);
  toets('4 stand blijft aan na het alarm (geen vanzelf hervatten)', m.stand().aan === true);
  fs.unlinkSync(B);
  for (let i = 0; i < 40 && !vrij(); i++) await slaap(50);
  toets('5 opgeruimd: grendel los', vrij());
  clearInterval(wakker);
  console.log(goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering ' + (e && e.stack || e)); process.exit(1); });
JS
