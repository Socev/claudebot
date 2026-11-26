'use strict';
/*
 * gmail-zoek.js (wv4162, besluitenpagina nr 30 = C17; review verzenden § 1, pot § M5) — één zoekfunctie op het lees-luik voor alle
 * verzendroutes (facturen-koerier, pot-verzend, pot-maand). Een fout is nooit "niets gevonden": het echte lees-luik meldt een
 * Gmail-fout als 200 met { mails: [], melding: 'fout bij zoeken: …' } of 'deels mislukt: …' (diffreview wv855 #1). De aanroepers
 * vangen LuikFout en versturen dan niets, maken geen tweede concept en schrijven niets af.
 *
 * Daarnaast het merkteken voor "concept weg pas na twee missers" (zoals wv3074 in de koerier) voor de D1-tabellen van POT, zonder
 * schemawijziging: als achtervoegsel '[concept_mist:<ISO>]' in een bestaande vrije tekstkolom (opmerking / reden).
 */

class LuikFout extends Error { constructor(soort) { super('lees-luik: ' + soort); this.code = 'luik_' + soort; } }
const kort = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
const foutSoort = (e) => kort((e && (e.code || e.name)) || 'fout', 40) || 'fout';

// → lijst mails (alleen objecten; o.metId: alleen met string-id), met .vol = ruwe lengte ≥ max. Gooit LuikFout bij: luik gooit, geen lijst, melding, aantal ≠ lengte.
// o.kaal: een kale array als antwoord ook goed (oudere luik-nep in de POT-toetsen); het echte luik geeft altijd { mails }.
async function zoek(io, query, max, o) {
  o = o || {};
  let j;
  try { j = await io.luik({ actie: 'mail_zoeken', query, max }); } catch (e) { throw new LuikFout(foutSoort(e)); }
  let mails;
  if (o.kaal && Array.isArray(j)) mails = j;
  else {
    if (!j || !Array.isArray(j.mails)) throw new LuikFout('geen_lijst');
    if (j.melding) throw new LuikFout(/^deels/.test(String(j.melding)) ? 'deels_mislukt' : 'zoekfout');
    if (Number.isInteger(j.aantal) && j.aantal !== j.mails.length) throw new LuikFout('onvolledig');
    mails = j.mails;
  }
  const uit = mails.filter((m) => m && typeof m === 'object' && (!o.metId || typeof m.id === 'string'));
  // vol = het ruwe antwoord zat vol (vóór het filteren; Codex-ontwerpreview MOET 1): dan kan een treffer ontbreken, dus geen misser
  uit.vol = Number.isInteger(max) && max > 0 && mails.length >= max;
  return uit;
}

// Merkteken eerste misser, als achtervoegsel '[concept_mist:<ISO>]' achter wat er al in de kolom stond (die tekst blijft staan).
const MIST_RE = /\s*\[concept_mist:(\d{4}-\d\d-\d\dT[0-9:.]+Z)\]$/;
function mistVan(tekst) { const m = MIST_RE.exec(String(tekst || '')); return m && Number.isFinite(Date.parse(m[1])) ? m[1] : null; }
function mistWeg(tekst) { if (tekst == null) return null; const t = String(tekst).replace(MIST_RE, ''); return t.length ? t : null; }
function mistZet(tekst, iso) { const t = mistWeg(tekst); const m = '[concept_mist:' + iso + ']'; return t ? t.slice(0, 400) + ' ' + m : m; }
const MIST_TUSSEN_MS = 45 * 60 * 1000;
/*
 * Besluit na een meting van een rij met status concept zonder concept en zonder verzonden mail in het antwoord.
 *   rij: { concept_op }, kolom: huidige waarde van de merktekenkolom, nuMs, wegNaMs (concept minstens zo oud), vol (antwoord zat vol)
 * → 'wacht' (te jong of vol antwoord: niets doen), 'mist1' (merkteken zetten), 'nogniet' (merkteken staat, < 45 min), 'weg' (tweede misser)
 */
function conceptMisser(rij, kolom, nuMs, wegNaMs, vol) {
  if (vol) return 'wacht';
  const op = Date.parse(rij.concept_op);
  if (!Number.isFinite(op) || op >= nuMs - wegNaMs) return 'wacht';
  const eerst = mistVan(kolom);
  if (!eerst) return 'mist1';
  return nuMs - Date.parse(eerst) >= MIST_TUSSEN_MS ? 'weg' : 'nogniet';
}

module.exports = { zoek, LuikFout, foutSoort, mistVan, mistWeg, mistZet, conceptMisser, MIST_TUSSEN_MS };
