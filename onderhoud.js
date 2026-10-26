'use strict';
// onderhoud.js — onderhoudsstand van de vault (Second Brain 2.0 fase 1a, wv1271, 26-10-2026).
//
// WAAROM. Bouwplan Second Brain 2.0 § 7.1 punt 1 en § 8: bij een verhuizing of migratie in de vault mag niets anders schrijven of
// synchroniseren, anders ziet bisync (Drive) of Syncthing een halve boom en zet hij die door naar Davids apparaten. Fable-review vooraf
// (MOET 4): na 2 uur een alarm, nooit vanzelf hervatten — midden in een verhuisstap hervatten is erger dan stilstaan.
//
// HOE. Eén schakelbestand ONDERHOUD_BESTAND (/opt/data/onderhoudsstand.json, alleen claude schrijft het; een bestand van een andere
// eigenaar telt niet). Het gereedschap (socev-scripts packages/sb2 onderhoud.py) zet het aan/uit en pauzeert Syncthing (pod + R230).
// Deze module doet het pod-deel:
//   - stand(): aan/uit, sinds, reden, grendel; /health.onderhoud;
//   - houdtTegen(run): ja voor automatische /run-beurten (geen Telegram van David, niet alleen-lezen) zolang de stand aan is. server.js
//     weigert die met 503 'onderhoud' (Fable-review wv1271 ZOU 4: laten wachten liet n8n na 30 min een time-out in Davids hoofdkanaal
//     melden en de wachtende beurt verdween bij een herstart; een geweigerde start komt via de Foutmelder in de machinekamer en de
//     volgende geplande run haalt het in);
//   - tik() (elke 30 s): houdt zolang de stand aan is de vault-grendel (/opt/data/bin/.vault.lock) vast met een eigen flock-proces,
//     zodat bisync, de vault-tar en de OVIS-nachtronde wachten; start dat proces opnieuw na een herstart van server.js; geeft na
//     2 uur één alarm per aan-periode (ook na een herstart niet dubbel: ALARM_BESTAND, pas geschreven als het bericht is aangenomen).
// Uit = het schakelbestand weg of {"aan": false}: het grendelproces stopt zelf (kijkt elke 10 s).
const fs = require('fs');

const ALARM_NA_MS = 2 * 3600 * 1000;

function maak(o) {
  const BESTAND = o.bestand, LOCK = o.lock, HOUDER = o.houderBestand, ALARM = o.alarmBestand;
  const nu = o.nu || Date.now, uid = o.uid !== undefined ? o.uid : (process.getuid ? process.getuid() : -1);
  const SLAAP = String(o.houderSlaapS || 10);   // proefinstelling
  let houderPid = null;

  function lees() {
    let st;
    try { st = fs.lstatSync(BESTAND); } catch (e) { return { aan: false }; }
    if (!st.isFile() || st.uid !== uid) return { aan: false, genegeerd: 'niet van deze gebruiker of geen gewoon bestand' };
    let m = null;
    try { m = JSON.parse(fs.readFileSync(BESTAND, 'utf8')); } catch (e) { m = null; }
    if (!m || typeof m !== 'object') return { aan: true, sinds: new Date(st.mtimeMs).toISOString(), reden: '(schakelbestand onleesbaar: telt als aan)', onleesbaar: true };
    if (m.aan !== true) return { aan: false };
    const sinds = typeof m.sinds === 'string' && !isNaN(Date.parse(m.sinds)) ? new Date(Date.parse(m.sinds)).toISOString() : new Date(st.mtimeMs).toISOString();
    return { aan: true, sinds: sinds, reden: String(m.reden || '').slice(0, 200), door: String(m.door || '').slice(0, 80) };
  }
  // Houdt ons flock-proces de grendel vast? Het proces schrijft zijn pid pas NA het verkrijgen van de grendel (sh na flock -w).
  function houderLeeft() {
    let pid = null;
    try { pid = Number(String(fs.readFileSync(HOUDER, 'utf8')).trim()); } catch (e) { return null; }
    if (!Number.isInteger(pid) || pid < 2) return null;
    try {
      const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
      if (cmd.indexOf('socev-onderhoudsstand') < 0) return null;
    } catch (e) { return null; }
    return pid;
  }
  function startHouder() {
    // flock wacht tot 15 min op een lopende bisync-ronde; daarna draait sh met de grendel vast tot de stand uit is.
    // Stopt alleen als het bestand weg is, niet meer van deze gebruiker (-O, zoals lees(); Fable KAN 8) of "aan": false zegt;
    // onleesbaar = blijven vasthouden, zoals stand() het als aan telt.
    const sh = 'echo $$ > "$2"; while [ -f "$1" ] && [ -O "$1" ] && ! grep -q \'"aan": *false\' "$1"; do sleep "$3"; done; rm -f "$2"';
    const k = o.spawn('flock', ['-w', '900', LOCK, 'sh', '-c', sh, 'socev-onderhoudsstand', BESTAND, HOUDER, SLAAP], { detached: true, stdio: 'ignore' });
    if (k && k.unref) k.unref();
    houderPid = k && k.pid || null;
    return houderPid;
  }
  function stand() {
    const s = lees();
    const uit = { aan: !!s.aan };
    if (s.aan) {
      Object.assign(uit, { sinds: s.sinds, reden: s.reden || null, door: s.door || null, onleesbaar: !!s.onleesbaar });
      const p = houderLeeft();
      uit.grendel = p ? 'vast' : 'wacht';
      uit.uren = Math.round((nu() - Date.parse(s.sinds)) / 360000) / 10;
    } else if (s.genegeerd) uit.genegeerd = s.genegeerd;
    return uit;
  }
  function houdtTegen(run) {
    if (!lees().aan) return false;
    run = run || {};
    if (run.bron === 'telegram') return false;   // David zelf (Telegram): nooit ophouden
    if (run.gereedschap === 'lezen') return false;   // alleen-lezen beurt schrijft niet
    return true;
  }
  function alarmGegeven(sinds) {
    try { return String(fs.readFileSync(ALARM, 'utf8')).trim() === sinds; } catch (e) { return false; }
  }
  function procBestaat(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
  async function tik() {
    const s = lees();
    if (!s.aan) return { aan: false };
    const r = { aan: true };
    if (!houderLeeft() && !(houderPid && procBestaat(houderPid))) {
      startHouder(); r.houder_gestart = true;
      if (o.log) o.log('onderhoud-grendel ' + JSON.stringify({ gestart: houderPid }));
    }
    if (nu() - Date.parse(s.sinds) >= ALARM_NA_MS && !alarmGegeven(s.sinds)) {
      const uren = Math.floor((nu() - Date.parse(s.sinds)) / 3600000);
      const tekst = 'De onderhoudsstand van de vault staat al ' + uren + ' uur aan (sinds ' + o.tijdNl(s.sinds) + (s.reden ? ', ' + s.reden : '') + '). ' +
        'Automatische runs starten niet en de sync staat stil; niets hervat vanzelf. Klaar? Machinekamer: onderhoud.py uit (na het manifest).';
      // Pas vastleggen als het bericht is aangenomen (Fable MOET 1): mislukt = de volgende tik (30 s) probeert opnieuw.
      // Sleutel per aan-periode: de berichtendedupe (24 u op sleutel) slikte anders een tweede periode op dezelfde dag.
      try {
        await o.bericht(tekst, 'onderhoudsstand-alarm-' + s.sinds);
        r.alarm = true;
        try { fs.writeFileSync(ALARM, s.sinds); } catch (e) { if (o.fout) o.fout('onderhoud-alarm-bestand', e); }
      } catch (e) { if (o.fout) o.fout('onderhoud-alarm', e); }
    }
    return r;
  }
  return { stand: stand, houdtTegen: houdtTegen, tik: tik, lees: lees, houderLeeft: houderLeeft };
}

module.exports = { maak: maak, ALARM_NA_MS: ALARM_NA_MS };
