'use strict';
/*
 * meld.js — één meldmodule voor bewaker.js en schijfdruk.js (wv3424, actieplan Fable-reviews 19-11, B81; rapport bewaker-schijf H4/M5, advies 4).
 *
 * Waarom: een schrijfhandeling in het eigen proces onder een time-out (Promise.race) stopt niet als de time-out afloopt. Hangt de schijf,
 * dan meldt de aanroeper "mislukt", maar writeFile + rename lopen door en landen minuten later, met de boxinhoud van het leesmoment: rijen
 * die anderen intussen schreven verdwijnen (18-11: 3× "box schrijven mislukte", alle 3 de rijen landden later). Hetzelfde voor een symlink
 * (vorige) die "mislukt" maar later alsnog omgaat.
 *
 * Daarom gaat elke handeling hier in een KINDPROCES met een eigen time-out; na de time-out krijgt het kind SIGKILL. Een SIGKILL wordt
 * afgeleverd zodra de hangende systeemaanroep terugkomt, dus de volgende stap (de rename) gebeurt dan niet meer. Alleen een rename die al
 * onderweg was kan nog landen; daarom draagt elke box-rij een vast kenmerk ("- kenmerk: <id>") en schrijft een herkansing een rij met
 * een kenmerk dat er al staat nooit nog eens.
 *
 *   boxRij(rij, kenmerk, {herkansing})  rij bovenaan de box (vóór de eerste "## [soort] JJJJ-MM-DD"), via vault-veilig.wijzig (mapgrendel,
 *                                       opnieuw lezen als het bestand intussen veranderde). Mislukt de eerste poging en staat herkansing aan,
 *                                       dan neemt een losgekoppeld herkansproces het over (overleeft het einde van de bewaker): elke minuut,
 *                                       na 10 pogingen elk halfuur, tot 24 u; steeds één poging tegelijk (een kind dat nog op de schijf
 *                                       wacht, wordt eerst afgewacht: niet meer processen dan nodig tijdens een incident).
 *   bericht(tekst, sleutel)             altijd via mk-scripts/bericht.py; die en de pod houden een niet-dringend bericht in de stille uren
 *                                       zelf tot 07:00 vast (bericht.py _tot7, server.js berichtStilleUren). De sleutel maakt het één bericht.
 *   zetLink(pad, doel)                  symlink atomair vervangen (tmp + rename) in een kindproces; geen late landing na een time-out.
 *
 * Kind-aanroepen (intern): node meld.js poging <box> <kenmerk> <rij-json>   -> exit 0 geschreven, 4 kenmerk stond er al, 3 niet gelukt
 *                          node meld.js herkans <box> <kenmerk> <rij-json> <kind-ms> [<log>]
 *                          node meld.js link <pad> <doel>
 * Omgeving (toetsen): MELD_HERKANS_MS (60000), MELD_HERKANS_TRAAG_MS (1800000), MELD_HERKANS_SNEL_N (10), MELD_HERKANS_MAX_MS (86400000),
 *                     MELD_VAULT_VEILIG (pad naar vault-veilig.js; standaard naast dit bestand).
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ANKER = /\n## \[[a-z]{2,10}\] \d{4}-\d{2}-\d{2}/;
const VELD = '- kenmerk: ';
function getal(naam, standaard) { const v = parseInt(process.env[naam] || '', 10); return Number.isFinite(v) && v >= 0 ? v : standaard; }
function schoonKenmerk(k) { return String(k == null ? '' : k).replace(/[^A-Za-z0-9._:+-]/g, '-').slice(0, 120); }
// De rij krijgt als laatste regel "- kenmerk: <id>"; de herkansing zoekt precies die regel.
function metKenmerk(rij, kenmerk) {
  const k = schoonKenmerk(kenmerk);
  let r = String(rij);
  if (!k) return r;
  if (!r.endsWith('\n')) r += '\n';
  return r.indexOf('\n' + VELD + k + '\n') >= 0 ? r : r + VELD + k + '\n';
}
function heeftKenmerk(tekst, kenmerk) { const k = schoonKenmerk(kenmerk); return !!k && String(tekst).indexOf('\n' + VELD + k + '\n') >= 0; }

// ── wat het kind doet ─────────────────────────────────────────────────────────────────────────────────────────────────
function poging(box, kenmerk, rij) {
  const vv = require(process.env.MELD_VAULT_VEILIG || path.join(__dirname, 'vault-veilig.js'));
  let al = false;
  const ok = vv.wijzig(box, function (t) {
    if (heeftKenmerk(t, kenmerk)) { al = true; return null; }
    const m = ANKER.exec(t);
    if (!m) return null;
    return t.slice(0, m.index) + rij + t.slice(m.index);
  }, { grendel: 5 });
  return ok ? 0 : al ? 4 : 3;
}
function link(p, doel) {
  const tmp = p + '.meld-' + process.pid;
  try { fs.unlinkSync(tmp); } catch (e) { /* bestond niet */ }
  fs.symlinkSync(doel, tmp);
  fs.renameSync(tmp, p);
  return 0;
}

// ── kindproces met grens ──────────────────────────────────────────────────────────────────────────────────────────────
// -> Promise<{ code, tijd: bool, weg: Promise }>; weg lost op zodra het kind echt weg is (ook als het na SIGKILL nog op de schijf wacht).
function kind(args, ms, opties) {
  return new Promise(function (resolve) {
    let k, klaar = false, wegR;
    const weg = new Promise((r) => { wegR = r; });
    const einde = (v) => { if (!klaar) { klaar = true; clearTimeout(t); resolve(Object.assign(v, { weg: weg })); } };
    const t = setTimeout(function () { try { k.kill('SIGKILL'); } catch (e) { /* al weg */ } einde({ code: null, tijd: true }); }, ms);
    try { k = cp.spawn(process.execPath, [__filename].concat(args), Object.assign({ stdio: 'ignore', cwd: '/' }, opties || {})); }
    catch (e) { wegR(); einde({ code: null, fout: e.message }); return; }
    k.on('error', function (e) { wegR(); einde({ code: null, fout: e.message }); });
    k.on('exit', function (code) { wegR(); einde({ code: code }); });
  });
}

function herkansWacht(pog) { return pog < getal('MELD_HERKANS_SNEL_N', 10) ? getal('MELD_HERKANS_MS', 60000) : getal('MELD_HERKANS_TRAAG_MS', 30 * 60000); }
async function herkans(box, kenmerk, rij, kindMs, logPad) {
  const begin = Date.now(), max = getal('MELD_HERKANS_MAX_MS', 24 * 3600000);
  const log = function (s) {
    if (!logPad) return;
    fs.appendFile(logPad, new Date().toISOString().replace('T', ' ').slice(0, 19) + ' [meld ' + process.pid + '] ' + s + '\n', function () {});
  };
  for (let pog = 0; ; pog++) {
    await new Promise((r) => setTimeout(r, herkansWacht(pog)));
    if (Date.now() - begin > max) { log('box-rij ' + kenmerk + ' opgegeven na ' + pog + ' herkansingen (24 u)'); return 3; }
    const u = await kind(['poging', box, kenmerk, JSON.stringify(rij)], kindMs);
    if (u.code === 0 || u.code === 4) { log('box-rij ' + kenmerk + (u.code === 0 ? ' alsnog geschreven' : ' stond er al') + ' (herkansing ' + (pog + 1) + ')'); return 0; }
    await u.weg;   // een kind dat nog op de schijf wacht eerst laten uitsterven: nooit twee pogingen tegelijk
  }
}

// ── voor de aanroeper ─────────────────────────────────────────────────────────────────────────────────────────────────
// o: { box, bericht (pad bericht.py), log: function(regel) -> Promise, kindMs (box-poging), linkMs, berichtMs, logBestand (voor de herkanser) }
function maak(o) {
  o = o || {};
  const log = typeof o.log === 'function' ? o.log : function () { return Promise.resolve(); };
  const kindMs = o.kindMs || 30000;
  const lopend = {};   // kenmerk -> herkanser al gestart (geen tweede voor dezelfde rij)

  async function boxRij(rij, kenmerk, opties) {
    opties = opties || {};
    const k = schoonKenmerk(kenmerk);
    const tekst = metKenmerk(rij, k);
    if (!o.box) { await log('LET OP: geen box opgegeven - geen rij'); return false; }
    const u = await kind(['poging', o.box, k, JSON.stringify(tekst)], kindMs);
    if (u.code === 0 || u.code === 4) return true;
    const waarom = u.tijd ? 'niet binnen ' + Math.round(kindMs / 1000) + ' s (kind gestopt, landt niet later)' : u.fout ? 'kind: ' + u.fout : 'exit ' + u.code + ' (box niet leesbaar of geen anker)';
    if (opties.herkansing === false || !k || lopend[k]) { await log('LET OP: box-rij ' + (k || '(zonder kenmerk)') + ' niet geschreven: ' + waarom); return false; }
    lopend[k] = true;
    try {
      const h = cp.spawn(process.execPath, [__filename, 'herkans', o.box, k, JSON.stringify(tekst), String(kindMs), o.logBestand || ''],
        { detached: true, stdio: 'ignore', cwd: '/' });
      h.on('error', function () {});
      h.unref();
      await log('LET OP: box-rij ' + k + ' niet geschreven: ' + waarom + ' - herkansing loopt (pid ' + h.pid + ', elke minuut, later elk halfuur, tot 24 u)');
    } catch (e) { await log('LET OP: box-rij ' + k + ' niet geschreven: ' + waarom + '; herkansing niet te starten: ' + e.message); }
    return false;
  }

  function bericht(tekst, sleutel, klasse) {
    if (!o.bericht || !fs.existsSync(o.bericht)) return log('seintje niet verstuurd: ' + (o.bericht || 'bericht.py') + ' ontbreekt').then(() => false);
    return new Promise(function (resolve) {
      let p, klaar = false;
      const einde = (v, regel) => { if (!klaar) { klaar = true; clearTimeout(t); log(regel).then(() => resolve(v), () => resolve(v)); } };
      const t = setTimeout(function () { try { p.kill('SIGKILL'); } catch (e) { /* weg */ } einde(false, 'seintje via bericht.py: niet binnen ' + Math.round((o.berichtMs || 120000) / 1000) + ' s'); }, o.berichtMs || 120000);
      try { p = cp.spawn('python3', [o.bericht, '--klasse', klasse || 'normaal', '--sleutel', String(sleutel || ''), tekst], { stdio: 'ignore', cwd: '/', env: process.env }); }
      catch (e) { einde(false, 'seintje niet te starten: ' + e.message); return; }
      p.on('error', (e) => einde(false, 'seintje faalde: ' + e.message));
      p.on('exit', (code) => einde(code === 0, 'seintje via bericht.py: exit ' + code));
    });
  }

  async function zetLink(p, doel) {
    const u = await kind(['link', p, doel], o.linkMs || 8000);
    return u.code === 0;
  }

  return { boxRij: boxRij, bericht: bericht, zetLink: zetLink };
}

module.exports = { maak, metKenmerk, heeftKenmerk, schoonKenmerk, ANKER };

if (require.main === module) {
  const a = process.argv.slice(2);
  try {
    if (a[0] === 'poging') process.exit(poging(a[1], a[2], JSON.parse(a[3])));
    else if (a[0] === 'link') process.exit(link(a[1], a[2]));
    else if (a[0] === 'herkans') herkans(a[1], a[2], JSON.parse(a[3]), parseInt(a[4], 10) || 30000, a[5] || '').then((c) => process.exit(c), () => process.exit(3));
    else { process.stderr.write('gebruik: meld.js poging|link|herkans ...\n'); process.exit(2); }
  } catch (e) { process.exit(3); }
}
