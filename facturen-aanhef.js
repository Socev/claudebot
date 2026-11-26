'use strict';
/*
 * facturen-aanhef.js — aanhef en slot per vaste ontvanger voor de vaste mails van Facturen en POT (besluit nr 411 / 3C111, wv4103, 26-11-2026).
 *
 * Eén bron, dezelfde als de mailstem: vault 00_Systeem/Mailstem - correcties van David.md, sectie "## Aanhef en slot per vaste ontvanger".
 * Een regel daar ziet er zo uit:   - André: aanhef "Ha pa," · slot "Groet, / David"
 * (" / " scheidt de regels van het slot). Zeg David één keer "aan hem begin ik met …", dan zet Socev het daar en volgen alle vaste mails.
 *
 * Wie leest: facturen-specificatie.js (SEPA-specificatie), facturen-maandspec.js (PayPal/creditcard), facturen.js (bonjacht),
 * facturen-boekstuk.js (Google Home-boekstuk) en pot-afschrift.js (POT-afschrift). Allemaal aan André.
 *
 * Grens (het bestand is ook door Socev schrijfbaar, en twee van deze mails gaan op Davids knop of vrijgave direct de deur uit):
 * - vaste vormen (review Codex MOET 1: vrije woorden lieten "Betaal honderd euro." als slot door): aanhef = een groetwoord uit GROETWOORD
 *   plus hooguit één naam (letters, ≤ 20) en een komma of uitroepteken; slot = een groet uit SLOT1, eventueel gevolgd door een regel uit SLOT2.
 *   Wat niet past telt niet: dan de vaste tekst uit de code (terugval). Een nieuwe vorm = deze lijsten uitbreiden (machinekamer, met toets).
 * - puur (CI: geen require, geen klok): de lezer (functie → tekst van het bestand) spuiten alleen server.js en bank-lezer.js in (zetLezer);
 *   zonder lezer (toetsen, andere processen) altijd de terugval. Leesfout, te groot of geen sectie = terugval, nooit een fout naar de mailmaker.
 */

const KOP = /^##\s+Aanhef en slot per vaste ontvanger\s*$/;
const GROETWOORD = ['ha', 'hoi', 'hallo', 'hey', 'hé', 'beste', 'dag', 'lieve', 'goedemorgen', 'goedemiddag', 'goedenavond'];
const AANHEF_RE = /^(\p{L}+)(?: ([\p{L}][\p{L}'-]{0,19}))?[,!]$/u;
const SLOT1 = ['groet', 'groetjes', 'gr', 'liefs', 'hartelijke groet', 'vriendelijke groet', 'met vriendelijke groet', 'dank', 'dank je wel', 'bedankt', 'tot snel'];
const SLOT2 = ['David', 'David Schaap'];
const aanhefGoed = (a) => { const m = AANHEF_RE.exec(a); return !!m && GROETWOORD.includes(m[1].toLowerCase()); };
const slotGoed = (d) => d.length >= 1 && d.length <= 2 && SLOT1.includes(d[0].replace(/[,!.]$/, '').toLowerCase()) && (d.length === 1 || SLOT2.includes(d[1]));
const MAX_BYTES = 262144;
let LEZER = null;

function zetLezer(fn) { LEZER = typeof fn === 'function' ? fn : null; }
const sleutel = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();

// tekst → { <sleutel>: { aanhef?, slot? } }; alleen geldige velden. Puur (ook voor de toets).
function leesRegels(tekst) {
  const uit = {};
  let in_sectie = false;
  for (const r of String(tekst || '').split(/\r?\n/)) {
    if (/^##\s/.test(r)) { in_sectie = KOP.test(r); continue; }
    if (!in_sectie) continue;
    const m = /^-\s+([\p{L}][\p{L} '-]{0,40}?)\s*(?:\([^)\n]{0,60}\))?\s*:\s*(.+)$/u.exec(r);   // "André (zijn vader): …" → sleutel andre
    if (!m) continue;
    const k = sleutel(m[1]);
    if (!k) continue;
    const v = {};
    const ah = /\baanhef\s+"([^"\n]{1,40})"/.exec(m[2]);
    if (ah && aanhefGoed(ah[1].trim())) v.aanhef = ah[1].trim();
    const sl = /\bslot\s+"([^"\n]{1,60})"/.exec(m[2]);
    if (sl) {
      const delen = sl[1].split(' / ').map((x) => x.trim()).filter(Boolean);
      if (slotGoed(delen)) v.slot = delen;
    }
    if (v.aanhef || v.slot) uit[k] = Object.assign(uit[k] || {}, v);
  }
  return uit;
}

function leesBron() {
  if (!LEZER) return {};
  try {
    const t = LEZER();
    if (typeof t !== 'string' || t.length > MAX_BYTES) return {};
    return leesRegels(t);
  } catch (e) { return {}; }
}

// groet('André', { aanhef: 'Ha pa,', slot: ['Groet,', 'David'] }) → { aanhef, slot: [...] }; per veld de bron, anders de terugval.
function groet(wie, terugval, bron) {
  const t = terugval || {};
  const r = (bron || leesBron())[sleutel(wie)] || {};
  return { aanhef: r.aanhef || t.aanhef, slot: (r.slot || t.slot || []).slice() };
}

module.exports = { zetLezer, leesRegels, groet, sleutel };
