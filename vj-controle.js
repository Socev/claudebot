'use strict';
// wv4197 (besluitenpagina nr 405 = 3C105, David Ja 25-11-2026 22:30): een doe-kaart die zichzelf afvinkt zodra Socev ziet dat het
// gelukt is, en anders zegt wat er nog ontbreekt. Bovenop de voorwaarde van wv1229 (kolom voorwaarde {bron, veld, waarde, sinds}):
//   sleutel   = kluisnaam: na 'sinds' in Sleutelbos geplakt (portaalpoort) of nieuw in de kluis. Er al staan telt niet.
//   koppeling = n8n-google | rclone-drive | codex: de echte inlogmeting van de pod (wv2786) slaagde na 'sinds' en er staat geen weigering.
//   bestand   = pad onder de vault; eindigt op / = map: er staat een niet-leeg bestand dat na 'sinds' op de pod verscheen (ctime of mtime;
//               Syncthing bewaart de mtime van de pc, de ctime niet).
// Puur: de pod geeft io mee (sleutel, koppeling, stat, lijst, echtPad). meet() geeft { waar: true|false|null, spoor, gezien, mist }.
// null = niet vast te stellen: dan sluit de controle niets (een tik van David blijft zijn woord, zoals bij wv1229).
const path = require('path');

const SOORTEN = ['sleutel', 'koppeling', 'bestand'];
const KOPPELINGEN = { 'n8n-google': 'de Google-koppeling in n8n', 'rclone-drive': 'de Drive-koppeling van de pod', 'codex': 'de Codex-inlog (je ChatGPT-abonnement)' };
const WORTEL = '/opt/data/AI_SecondBrain/';
const MAP_MAX = 5000;
const NAAM_RE = /^[a-z0-9_]{3,64}$/;
const TIJDELIJK_RE = /^\.|\.(tmp|part|crdownload|partial|download)$|^~\$/i;

function isControle(v) { return !!(v && typeof v === 'object' && SOORTEN.indexOf(v.veld) >= 0); }

// Zelfde regels als machinekamer.voor_jou_voorwaarde_fout (de databank blijft de poort).
function vormFout(v) {
  if (!v || typeof v !== 'object') return 'controle moet een object zijn';
  const w = typeof v.waarde === 'string' ? v.waarde : null;
  if (w == null) return 'waarde moet tekst zijn';
  if (v.veld === 'sleutel') return NAAM_RE.test(w) && w.indexOf('__') < 0 ? null : 'sleutel: waarde moet een kluisnaam zijn (a-z, 0-9, _; 3-64)';
  if (v.veld === 'koppeling') return Object.hasOwn(KOPPELINGEN, w) ? null : 'koppeling: waarde moet ' + Object.keys(KOPPELINGEN).join(', ') + ' zijn';
  if (v.veld === 'bestand') {
    if (w.length > 300 || w.indexOf(WORTEL) !== 0 || w.length === WORTEL.length || /[\x00-\x1f]/.test(w) || /(^|\/)\.\.?(\/|$)/.test(w)) return 'bestand: waarde moet een pad onder ' + WORTEL + ' zijn (zonder . of ..; ≤ 300)';
    return null;
  }
  return 'geen controle';
}

function dagKlok(ms) {
  const d = new Date(ms);
  const f = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = {}; f.forEach(function (x) { g[x.type] = x.value; });
  return g.day + '-' + g.month + ' ' + g.hour + ':' + g.minute;
}
function naamVan(w) { const s = w.replace(/\/+$/, '').split('/'); return s[s.length - 1] || 'de map'; }

async function meetSleutel(w, sinds, io) {
  const r = await io.sleutel(w, new Date(sinds).toISOString());
  if (!r || r.ok !== true || typeof r.bestaat !== 'boolean' || typeof r.geschreven !== 'boolean') return { waar: null, spoor: 'sleutel ' + w + ': kluis niet te lezen' };
  if (r.bestaat && r.geschreven) {
    const op = Date.parse(r.op || '');
    return { waar: true, spoor: 'sleutel ' + w + ' geplakt ' + (op > 0 ? new Date(op).toISOString() : '?'), gezien: 'de sleutel ' + w + ' staat in Sleutelbos' + (op > 0 ? ' (geplakt ' + dagKlok(op) + ')' : '') };
  }
  return { waar: false, spoor: 'sleutel ' + w + (r.bestaat ? ' bestaat, niet opnieuw geplakt' : ' niet in de kluis'),
    mist: r.bestaat ? 'de sleutel ' + w + ' staat wel in Sleutelbos, maar is sinds deze kaart (' + dagKlok(sinds) + ') niet opnieuw geplakt'
      : 'de sleutel ' + w + ' staat nog niet in Sleutelbos' };
}

function koppelGoed(k, uitkomst) {
  if (k === 'n8n-google') return uitkomst && typeof uitkomst === 'object' && Array.isArray(uitkomst.geweigerd) && uitkomst.geweigerd.length === 0 && Number(uitkomst.goed) > 0;
  return uitkomst === 'goed';
}
function koppelWeg(k, uitkomst) {
  if (k === 'n8n-google') return !!(uitkomst && typeof uitkomst === 'object' && Array.isArray(uitkomst.geweigerd) && uitkomst.geweigerd.length > 0);
  return typeof uitkomst === 'string' && /^geweigerd/.test(uitkomst);
}
function meetKoppeling(w, sinds, io) {
  const s = io.koppeling(w) || {};
  const lm = s.laatste_meting, t = lm ? Date.parse(lm.t || '') : NaN, wie = KOPPELINGEN[w];
  if (s.geweigerd || (lm && koppelWeg(w, lm.uitkomst))) {
    return { waar: false, spoor: 'koppeling ' + w + ' geweigerd' + (t > 0 ? ' (meting ' + new Date(t).toISOString() + ')' : ''),
      mist: wie + ' werd bij de laatste meting' + (t > 0 ? ' (' + dagKlok(t) + ')' : '') + ' nog geweigerd; Socev meet elk kwartier opnieuw' };
  }
  if (!(t > 0)) return { waar: null, spoor: 'koppeling ' + w + ': nog geen meting' };
  if (t <= sinds) return { waar: null, spoor: 'koppeling ' + w + ': laatste meting ' + new Date(t).toISOString() + ' van vóór de kaart' };
  if (koppelGoed(w, lm.uitkomst)) return { waar: true, spoor: 'koppeling ' + w + ' goed ' + new Date(t).toISOString(), gezien: wie + ' werkt weer (gemeten ' + dagKlok(t) + ')' };
  return { waar: null, spoor: 'koppeling ' + w + ': ' + String(typeof lm.uitkomst === 'string' ? lm.uitkomst : 'andere uitkomst').slice(0, 60) };
}

function nieuwGenoeg(st, sinds) { return Math.max(Number(st.ctimeMs) || 0, Number(st.mtimeMs) || 0) > sinds; }
function meetBestand(w, sinds, io) {
  const map = /\/$/.test(w), doel = map ? w.replace(/\/+$/, '') : w, naam = naamVan(w);
  // echtPad: een symlink mag niet buiten de vault wijzen
  const echt = io.echtPad(doel);
  if (echt === null) return { waar: false, spoor: 'bestand ' + w + ' bestaat niet', mist: map ? 'de map ' + naam + ' bestaat nog niet' : 'het bestand ' + naam + ' is nog niet binnen' };
  if (typeof echt !== 'string' || (echt + '/').indexOf(WORTEL) !== 0) return { waar: null, spoor: 'bestand ' + w + ': pad buiten de vault' };
  if (!map) {
    const st = io.stat(echt);
    if (!st || !st.isFile()) return { waar: null, spoor: 'bestand ' + w + ': geen gewoon bestand' };
    if (!(st.size > 0)) return { waar: false, spoor: 'bestand ' + w + ' leeg', mist: 'het bestand ' + naam + ' staat er, maar is leeg' };
    if (!nieuwGenoeg(st, sinds)) return { waar: false, spoor: 'bestand ' + w + ' ouder dan de kaart', mist: 'het bestand ' + naam + ' is nog de oude versie (van vóór deze kaart)' };
    return { waar: true, spoor: 'bestand ' + w + ' ' + st.size + ' B', gezien: 'het bestand ' + naam + ' is binnen' };
  }
  const st = io.stat(echt);
  if (!st || !st.isDirectory()) return { waar: null, spoor: 'bestand ' + w + ': geen map' };
  const namen = io.lijst(echt);
  if (!Array.isArray(namen) || namen.length > MAP_MAX) return { waar: null, spoor: 'bestand ' + w + ': map niet te lezen of te groot' };
  let leeg = 0;
  for (const n of namen) {
    if (typeof n !== 'string' || TIJDELIJK_RE.test(n)) continue;
    const s = io.stat(path.join(echt, n));
    if (!s || !s.isFile() || !nieuwGenoeg(s, sinds)) continue;
    if (!(s.size > 0)) { leeg++; continue; }
    return { waar: true, spoor: 'bestand ' + w + ': ' + n + ' ' + s.size + ' B', gezien: 'het bestand ' + n + ' staat in de map ' + naam };
  }
  return { waar: false, spoor: 'bestand ' + w + ': geen nieuw bestand' + (leeg ? ' (' + leeg + ' leeg)' : ''),
    mist: leeg ? 'in de map ' + naam + ' staat alleen een leeg bestand van na deze kaart' : 'er staat nog geen nieuw bestand in de map ' + naam };
}

// v = kaartvoorwaarde, p = de kaart (voor aangemaakt als 'sinds' ontbreekt), io = zie boven.
async function meet(v, p, io) {
  if (!isControle(v)) return { waar: null, spoor: 'geen controle' };
  const f = vormFout(v);
  if (f) return { waar: null, spoor: f };
  const sinds = Date.parse(v.sinds || '') > 0 ? Date.parse(v.sinds) : Date.parse((p && p.aangemaakt) || '');
  if (!(sinds > 0)) return { waar: null, spoor: v.veld + ': geen sinds' };
  try {
    if (v.veld === 'sleutel') return await meetSleutel(v.waarde, sinds, io);
    if (v.veld === 'koppeling') return meetKoppeling(v.waarde, sinds, io);
    return meetBestand(v.waarde, sinds, io);
  } catch (e) { return { waar: null, spoor: v.veld + ' fout: ' + String(e && e.message || e).slice(0, 80) }; }
}

function bewijsTekst(m) { return ('Gezien: ' + m.gezien).slice(0, 380); }
function nogNietTekst(m) { return ('Nog niet gezien: ' + m.mist + '. Zodra het klopt, gaat deze kaart vanzelf dicht. Klopt het volgens jou wel, tik dan Lukt niet.').slice(0, 300); }

module.exports = { SOORTEN, KOPPELINGEN, WORTEL, isControle, vormFout, meet, bewijsTekst, nogNietTekst, dagKlok };
