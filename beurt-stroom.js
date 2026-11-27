'use strict';
// wv3824 (besluitenpagina nr 452 = 3C152 stap 2, David Ja 21-11-2026 12:42): het antwoord van Socev stroomt binnen in de wachtbel.
// runClaude draait app-beurten met `--output-format stream-json --verbose --include-partial-messages`; deze lezer verwerkt die stdout
// regel voor regel zonder alles te bewaren (tool-uitslagen kunnen MB's mailinhoud zijn):
//  - de laatste {"type":"result"}-regel (zelfde velden als het ene object van --output-format json, gemeten 2.1.328) → slot() geeft die
//    regel als tekst, zodat finalize in server.js ongewijzigd JSON.parse(out) doet;
//  - niet-JSON-tekst (begrensd) voor de foutroute zonder result-regel (zoals de json-route dan out.trim() teruggeeft);
//  - deel: de tekst van het LAATSTE tekstblok van de hoofdagent (parent_tool_use_id leeg), uit content_block_start/text_delta.
// deelVoorApp knipt wat niet half in beeld mag (VRAAG AAN DAVID, [OPEN …]-achtige regels) en houdt een staart van hooguit 8 kB.

const MAX_REST = 64 * 1024 * 1024;     // onvolledige regel; daarboven weg tot de volgende newline (een result-regel is nooit zo groot)
const MAX_TEKST = 64 * 1024;           // niet-JSON-tekst voor de foutroute
const MAX_DEEL = 256 * 1024;           // ruwe kop van het lopende tekstblok (Codex ZOU 1)
const APP_DEEL_MAX = 8 * 1024;         // wat /app/uitslag hooguit meegeeft

// o: { opDeel(tekst), opLeven() }. opLeven = elke regel behalve een ping (watchdog: een hangende API mag de inactiviteitsgrens niet ontlopen).
// wv4180 (besluitenpagina nr 444 = 3C144): fasen() = wanneer (Date.now()) elke fase van de beurt voor het eerst gebeurde, alleen tijden en
// aantallen, nooit inhoud: init (CLI opgestart, system/init), model (eerste message_start van de hoofdagent), denk (eerste thinking-blok),
// werk (eerste tool_use), tekst (eerste tekstblok), antwoord (begin van het LAATSTE tekstblok), result; stappen = message_starts en tools =
// tool_use-blokken van de hoofdagent; sub = er liep een subagent.
function maakLezer(o) {
  o = o || {};
  let rest = '', weg = false, result = null, tekst = '', deel = '', blokTekst = false;
  const f = { stappen: 0, tools: 0 };
  function eerst(naam) { if (f[naam] == null) f[naam] = Date.now(); }
  // Codex ZOU 1: de KOP bewaren (boven MAX_DEEL groeit deel niet meer), zodat een eerdere VRAAG AAN DAVID- of [-regel nooit wegvalt
  // en de tekst erna in deelVoorApp dus verborgen blijft; herlees (vervang-uit) bouwt dezelfde kop opnieuw op.
  function zetDeel(d) { deel = d.length > MAX_DEEL ? d.slice(0, MAX_DEEL) : d; if (o.opDeel) o.opDeel(deel); }
  function regel(l) {
    if (!l.trim()) return;
    // wv4180: de init-regel zonder JSON.parse herkennen (assistant-/user-regels kunnen MB's zijn en worden hier niet geparst)
    if (f.init == null && l.indexOf('"subtype":"init"') >= 0 && l.indexOf('"type":"system"') >= 0) eerst('init');
    const kans = l.indexOf('"stream_event"') >= 0 || l.indexOf('"result"') >= 0;
    let j = null;
    if (kans || l.charAt(0) !== '{') { try { j = JSON.parse(l); } catch (e) { j = undefined; } }
    if (j === undefined && l.charAt(0) !== '{') {   // geen JSON: tekst voor de foutroute
      if (tekst.length < MAX_TEKST) tekst += (tekst ? '\n' : '') + l.slice(0, MAX_TEKST - tekst.length);
      if (o.opLeven) o.opLeven();
      return;
    }
    if (!j || typeof j !== 'object') { if (o.opLeven) o.opLeven(); return; }
    if (j.type === 'result') { result = l; eerst('result'); if (o.opLeven) o.opLeven(); return; }
    if (j.type !== 'stream_event') { if (o.opLeven) o.opLeven(); return; }
    const ev = j.event || {};
    if (ev.type === 'ping') return;
    if (o.opLeven) o.opLeven();
    if (j.parent_tool_use_id) { f.sub = true; return; }   // subagent
    if (ev.type === 'message_start') { eerst('model'); f.stappen++; return; }
    if (ev.type === 'content_block_start') {
      const t = ev.content_block && ev.content_block.type;
      if (t === 'thinking' || t === 'redacted_thinking') eerst('denk');
      else if (t === 'tool_use' || t === 'server_tool_use') { eerst('werk'); f.tools++; }
      else if (t === 'text') { eerst('tekst'); f.antwoord = Date.now(); }
      if (t === 'text') { blokTekst = true; zetDeel(typeof ev.content_block.text === 'string' ? ev.content_block.text : ''); }
      else blokTekst = false;   // tool_use / thinking: het vorige tekstblok blijft staan tot er een nieuw begint
      return;
    }
    if (ev.type === 'content_block_delta' && blokTekst && ev.delta && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
      zetDeel(deel + ev.delta.text);
    }
  }
  function voeg(chunk) {
    let s = rest + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    let i;
    while ((i = s.indexOf('\n')) >= 0) {
      const l = s.slice(0, i); s = s.slice(i + 1);
      if (weg) { weg = false; continue; }   // staart van een te lange regel
      regel(l);
    }
    if (s.length > MAX_REST) { weg = true; s = ''; }
    rest = s;
  }
  return {
    voeg: voeg,
    // Einde van de stroom: een laatste regel zonder newline telt ook.
    sluit: function () { if (rest && !weg) regel(rest); rest = ''; weg = false; },
    // Wat finalize als `out` krijgt: de result-regel (JSON) of anders de niet-JSON-tekst.
    slot: function () { return result != null ? result : tekst; },
    heeftResult: function () { return result != null; },
    deel: function () { return deel; },
    fasen: function () { return Object.assign({}, f); },
    // herlees: tijden van de vorige lezer winnen (deze lezer las alles opnieuw in één keer), aantallen komen van de volledige buffer
    neemFasen: function (oud) { if (!oud) return; Object.keys(oud).forEach(function (k) { if (k !== 'stappen' && k !== 'tools' && oud[k] != null) f[k] = oud[k]; }); f.herlezen = true; },
  };
}
// Hele buffer opnieuw (loper slot-volg): nieuwe lezer, en de oude result-regel blijft als de nieuwe er geen vond (afgekapte buffer).
function herlees(oud, buf, o) {
  const n = maakLezer(o);
  n.voeg(buf); n.sluit();
  if (oud && oud.fasen) n.neemFasen(oud.fasen());   // wv4180
  if (!n.heeftResult() && oud && oud.heeftResult()) {
    const r = oud.slot();
    return Object.assign({}, n, { slot: function () { return r; }, heeftResult: function () { return true; } });
  }
  return n;
}

const VRAAG = 'VRAAG AAN DAVID:';
// Wat de app tijdens het stromen mag tonen (platte tekst). Leeg = niets tonen.
function deelVoorApp(d) {
  if (typeof d !== 'string' || !d) return '';
  const regels = d.split('\n');
  let eind = regels.length;
  for (let i = 0; i < regels.length; i++) {
    const kaal = regels[i].replace(/^[\s*_>#-]+/, '');
    if (/^VRAAG AAN DAVID/i.test(kaal) || /^\[/.test(kaal)) { eind = i; break; }
  }
  // Onvolledige laatste regel die nog een vraagregel of marker kan worden ("VRAAG AA", "[")
  if (eind === regels.length && eind > 0) {
    const kaal = regels[eind - 1].replace(/^[\s*_>#-]+/, '');
    if (kaal && VRAAG.toLowerCase().indexOf(kaal.toLowerCase()) === 0) eind--;
  }
  let t = regels.slice(0, eind).join('\n').replace(/\s+$/, '');
  if (t.length > APP_DEEL_MAX) {
    t = t.slice(-APP_DEEL_MAX);
    const nl = t.indexOf('\n');
    if (nl >= 0 && nl < t.length - 1) t = t.slice(nl + 1);
  }
  return t.trim() ? t : '';
}

module.exports = { maakLezer, herlees, deelVoorApp, APP_DEEL_MAX, MAX_DEEL };
