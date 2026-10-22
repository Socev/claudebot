'use strict';
// spreektekst.js — de tekst die naar de stem gaat (wv803, 22-10-2026; bouwplan Bandjes § Log 22-10 "spreektekst", opdracht David 17:04:
// "de stem neemt te weinig pauze tussen zinnen, en spreekt sommige dingen (nummers, website) niet goed uit"). Puur JS, geen netwerk.
//
// WAAROM. De geschreven tekst van een bandje blijft zoals David hem leest ("085 773 11 00", "www.hpgroenhouten.nl", "kies 1"); een
// stem spreekt dat slecht uit. Daarom een tweede laag: de SPREEKTEKST, automatisch afgeleid uit de geschreven tekst en de uitspraaklijst
// van de praktijk, door David per bandje te overschrijven. Pauzes staan erin als neutrale markering "[pauze]" (of "[pauze 1,5]" in
// seconden), zodat de spreektekst niet van het model afhangt; pas bij het maken wordt hij per model vertaald (naarModel).
//
// GEMETEN 22-10 (mk-scripts/elevenlabs/voortgang-2.md): stilte tussen zinnen bij v4 met alleen een punt ± 0,37 s, met "..." of een witregel
// nauwelijks meer; v4 "[pause]" 0,8–1,1 s, "[long pause]" 1,5–2,5 s (niet uitgesproken, Whisper); v2 <break time="0.7s"/> 0,82–0,85 s.
// ElevenLabs: v3/v4 kennen geen SSML-break; v2/flash geen audiotags (die zouden voorgelezen worden). Komma's tussen nummergroepen
// geven 0,2–0,5 s.

const NUL_TOT_19 = ['nul', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen', 'tien', 'elf', 'twaalf', 'dertien', 'veertien',
  'vijftien', 'zestien', 'zeventien', 'achttien', 'negentien'];
const TIENTALLEN = ['', '', 'twintig', 'dertig', 'veertig', 'vijftig', 'zestig', 'zeventig', 'tachtig', 'negentig'];
const CIJFER = ['nul', 'één', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen'];   // los cijfer: "één" (anders leest de stem "un")

// 0–99 voluit: 85 → vijfentachtig, 22 → tweeëntwintig
function getal(n) {
  n = Number(n);
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(n);
  if (n < 20) return NUL_TOT_19[n];
  const e = n % 10, t = Math.floor(n / 10);
  if (!e) return TIENTALLEN[t];
  const een = NUL_TOT_19[e];
  return een + (/e$/.test(een) ? 'ën' : 'en') + TIENTALLEN[t];
}
function cijfers(g) { return g.split('').map(function (c) { return CIJFER[Number(c)]; }).join(' '); }
// Eén groep van een telefoonnummer zoals je hem zegt (David 22-10: "nul vijfentachtig, zeven zeven drie, elf, nul nul").
function groep(g) {
  if (g.length === 1) return CIJFER[Number(g)];
  if (g.length === 2) return g[0] === '0' ? cijfers(g) : getal(Number(g));
  if (g.length === 3) return g[0] === '0' ? (g[1] === '0' ? cijfers(g) : 'nul ' + getal(Number(g.slice(1)))) : cijfers(g);
  if (g === '0800' || g === '0900') return 'nul ' + (g[1] === '8' ? 'achthonderd' : 'negenhonderd');
  const delen = [];
  let i = 0;
  while (g.length - i > 3 || (g.length - i === 4)) { delen.push(g.slice(i, i + 2)); i += 2; }
  if (i < g.length) delen.push(g.slice(i));
  return delen.map(groep).join(', ');
}
// Indeling van een nummer zonder spaties: 06 in paren, 0800/0900 los, anders netnummer van drie (033, 085) en 3-2-2.
function indeling(c) {
  if (/^06\d{8}$/.test(c)) return [c.slice(0, 2), c.slice(2, 4), c.slice(4, 6), c.slice(6, 8), c.slice(8)];
  if (/^0[89]00\d+$/.test(c)) return [c.slice(0, 4)].concat(c.slice(4).match(/.{1,3}/g));
  if (/^0\d{9}$/.test(c)) return [c.slice(0, 3), c.slice(3, 6), c.slice(6, 8), c.slice(8)];
  return c.match(/.{1,2}/g);
}
function nummer(ruw) {
  const c = ruw.replace(/\D/g, '');
  const metScheiding = /[ \-]/.test(ruw.trim());
  const delen = metScheiding ? ruw.trim().split(/[ \-]+/).filter(Boolean) : indeling(c);
  return delen.map(groep).join(', ');
}

// Website of mailadres zoals je het zegt: "www.hpgroenhouten.nl" → "w w w punt hpgroenhouten punt n l" (de uitspraaklijst maakt er
// daarna "h p groenhouten" van als dat erin staat).
const TLD_GESPELD = { nl: 'n l', be: 'b e', de: 'd e', eu: 'e u', uk: 'u k' };
function host(h) {
  const delen = h.toLowerCase().split('.');
  return delen.map(function (d, i) {
    if (i === 0 && d === 'www') return 'w w w';
    if (i === delen.length - 1) return TLD_GESPELD[d] || d;
    return d.replace(/-/g, ' streepje ');
  }).join(' punt ');
}
const TLD = '(?:nl|com|org|net|eu|info|be|de|online|app|dev|nu|uk)';
const MAIL_RE = new RegExp('\\b([a-z0-9._%+-]{1,40})@((?:[a-z0-9-]{1,40}\\.){1,4}' + TLD + ')\\b', 'gi');
const URL_RE = new RegExp('\\b(?:https?:\\/\\/)?((?:www\\.)?(?:[a-z0-9-]{1,40}\\.){1,4}' + TLD + ')\\b((?:\\/[a-z0-9_-]{1,40}){0,4})\\/?', 'gi');

// Tijden: 8:00 → acht uur, 10:30 → half elf, 13:00 → dertien uur; "13:00–17:00" → "dertien uur tot zeventien uur".
function tijd(u, m) {
  u = Number(u); m = Number(m);
  if (m === 0) return getal(u) + ' uur';
  if (m === 30) return 'half ' + getal((u % 24) + 1 > 23 ? 0 : u + 1);
  if (m === 15) return 'kwart over ' + getal(u);
  if (m === 45) return 'kwart voor ' + getal(u + 1);
  return getal(u) + ' uur ' + getal(m);
}
const TIJD = '\\b([01]?\\d|2[0-3]):([0-5]\\d)(?:\\s*uur)?\\b';
const AFKORTINGEN = [[/\bt\/m\b/gi, 'tot en met'], [/\bo\.a\./gi, 'onder andere'], [/\bi\.v\.m\./gi, 'in verband met'], [/\bbijv\./gi, 'bijvoorbeeld'],
  [/\bz\.s\.m\./gi, 'zo snel mogelijk'], [/\bca\.\s/gi, 'circa '], [/\be\.d\./gi, 'en dergelijke'], [/\bm\.b\.t\./gi, 'met betrekking tot'], [/\s&\s/g, ' en ']];

// Uitspraaklijst van een praktijk (register, Praktijkinstellingen › uitspraak): "hpgroenhouten = h p groenhouten; Uw Zorg Online = …".
// Strikt bij schrijven (lijstFout), tolerant bij lezen (een onleesbaar item wordt overgeslagen).
const ITEM_RE = /^([^=;\n]{1,60}?)\s*=\s*([^=;\n]{1,120})$/;
function uitspraakLijst(w) {
  return String(w || '').split(/[;\n]/).map(function (x) { return x.trim(); }).filter(function (x) { return x && !/^[—–-]+$/.test(x); }).map(function (x) {
    const m = ITEM_RE.exec(x);
    return m && m[1].trim() && m[2].trim() ? { van: m[1].trim(), naar: m[2].trim() } : null;
  });
}
function lijstFout(w) {
  const l = uitspraakLijst(w);
  if (l.indexOf(null) >= 0) return "elk item 'woord = zo spreek je het uit', gescheiden door ; of een nieuwe regel";
  if (l.length > 40) return 'hooguit 40 items';
  return null;
}
function lijstNaarRegel(w) { return uitspraakLijst(w).filter(Boolean).map(function (x) { return x.van + ' = ' + x.naar; }).join('; '); }
function escape(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }
function pasLijstToe(t, lijst) {
  // in één doorgang (een vervanging wordt nooit opnieuw vervangen), langste eerst zodat "Uw Zorg Online" vóór "Zorg" gaat; alleen hele
  // woorden, hoofdletterongevoelig
  const l = (lijst || []).filter(Boolean).slice().sort(function (a, b) { return b.van.length - a.van.length; });
  if (!l.length) return t;
  const naar = {};
  l.forEach(function (x) { const k = x.van.toLowerCase(); if (!(k in naar)) naar[k] = x.naar; });
  const re = new RegExp('(^|[^\\p{L}\\p{N}])(' + l.map(function (x) { return escape(x.van); }).join('|') + ')(?=$|[^\\p{L}\\p{N}])', 'giu');
  return t.replace(re, function (_, voor, w) { return voor + (naar[w.toLowerCase()] !== undefined ? naar[w.toLowerCase()] : w); });
}

const PAUZE = '[pauze]';
// Afleiden: geschreven tekst → spreektekst (neutraal, met [pauze] tussen zinnen).
function afleiden(tekst, uitspraak) {
  let t = String(tekst || '').replace(/\r\n?/g, '\n');
  t = t.replace(/[ \t]*\[[^\]\n]{0,30}\][ \t]*/g, ' ');                       // twijfelmarkeringen als [?] uit het uitschrift
  t = t.replace(/\n\s*\n+/g, ' ' + PAUZE + ' ').replace(/\s*\n\s*/g, ' ');   // witregel = pauze, losse regel = spatie
  AFKORTINGEN.forEach(function (a) { t = t.replace(a[0], a[1]); });
  t = t.replace(MAIL_RE, function (_, wie, h) { return wie.replace(/\./g, ' punt ') + ' apenstaartje ' + host(h); });
  t = t.replace(URL_RE, function (_, h, pad) { return host(h) + (pad ? pad.split('/').filter(Boolean).map(function (p) { return ' slash ' + p.replace(/-/g, ' streepje '); }).join('') : ''); });
  t = t.replace(new RegExp(TIJD + '\\s*[–—-]\\s*' + TIJD, 'g'), function (_, u1, m1, u2, m2) { return tijd(u1, m1) + ' tot ' + tijd(u2, m2); });
  t = t.replace(new RegExp(TIJD, 'g'), function (_, u, m) { return tijd(u, m); });
  // telefoonnummers: 10 cijfers vanaf 0 (spaties/streepjes toegestaan), 0800/0900-nummers, en 112
  t = t.replace(/(?<![\d,.])(0[89]00[ -]?\d{4,7}|0\d(?:[ -]?\d){8})(?![\d])/g, function (m) { return nummer(m); });
  t = t.replace(/(?<![\p{L}\p{N},.])112(?![\p{L}\p{N}]|[,.]\d)/gu, 'één, één, twee');
  // keuzes: "kies 1", "toets 2", "optie 3", "druk op 4" → "kies één"
  t = t.replace(/\b(kies|kiest|toets|toetst|druk op|drukt u op|optie|keuze)\s+(\d)(?!\d)/gi, function (_, w, c) { return w + ' ' + CIJFER[Number(c)]; });
  t = t.replace(/\b(\d{1,4})([a-z])\b/g, '$1 $2');                              // huisnummer 72a → 72 a
  t = t.replace(/€\s?(\d+)(?:,(\d{2}))?/g, function (_, e, c) { return e + ' euro' + (c && c !== '00' ? ' ' + c : ''); });
  t = t.replace(/(\d)\s?%/g, '$1 procent');
  t = pasLijstToe(t, uitspraakLijst(uitspraak));
  // pauze na elke zin (niet aan het eind, niet dubbel)
  t = t.replace(/([.!?…])["')]?\s+(?=\S)/g, function (m, p) { return m.trimEnd() + ' ' + PAUZE + ' '; });
  t = t.replace(/(\[pauze[^\]]*\]\s*){2,}/gi, PAUZE + ' ');
  return t.replace(/[ \t]{2,}/g, ' ').replace(/\s*\[pauze[^\]]*\]\s*$/i, '').trim();
}

// [pauze] / [pauze 1,5] / [pauze 1.5s] → seconden
const PAUZE_RE = /\[\s*pauze(?:\s+(\d(?:[.,]\d{1,2})?)\s*s?)?\s*\]/gi;
const V2_MODELLEN = /^eleven_(multilingual_v2|flash_v2(_5)?|turbo_v2(_5)?)$/;
// Spreektekst → tekst voor ElevenLabs (of Piper: model null). o.pauze = seconden voor een kale [pauze] (standaard 0,8).
function naarModel(spreek, model, o) {
  const std = o && isFinite(Number(o.pauze)) ? Math.max(0, Math.min(3, Number(o.pauze))) : 0.8;
  const v2 = V2_MODELLEN.test(String(model || ''));
  const tags = !!model && !v2;     // v3/v4: audiotags; v2/flash: SSML-break; Piper (model null): niets
  let breaks = 0;
  let t = String(spreek || '');
  if (!tags) t = t.replace(/\[(?!\s*pauze\b)[^\]\n]{0,40}\]/gi, ' ');      // audiotags zouden voorgelezen worden
  if (tags || !model) t = t.replace(/<break\b[^>]{0,40}\/?>/gi, ' ');
  t = t.replace(PAUZE_RE, function (_, s) {
    const d = s ? Math.min(3, Number(s.replace(',', '.'))) : std;
    if (!model || d < 0.15) return ' ';
    if (v2) {
      if (++breaks > 40) return ' … ';   // ElevenLabs: te veel break-tags maakt de stem onrustig
      return ' <break time="' + d.toFixed(1) + 's" /> ';
    }
    if (d < 0.5) return ' ';
    return d < 1.4 ? ' [pause] ' : ' [long pause] ';
  });
  return t.replace(/\s+/g, ' ').trim();
}

// Zinnen voor "Proef één zin": de spreektekst in stukken tussen pauzes en zinseinden (zonder de markering), hooguit 300 tekens.
function zinnen(spreek) {
  return String(spreek || '').split(/\[\s*pauze[^\]]*\]|(?<=[.!?])\s+/i).map(function (z) { return z.replace(/\s+/g, ' ').trim(); })
    .filter(function (z) { return /[\p{L}\p{N}]/u.test(z); }).map(function (z) { return z.slice(0, 300); });
}

const MAX = 3000;   // ElevenLabs v3: 3.000 tekens per aanroep; de mini-app houdt de spreektekst daaronder

module.exports = { afleiden, naarModel, zinnen, uitspraakLijst, lijstFout, lijstNaarRegel, getal, nummer, host, tijd, PAUZE, MAX };
