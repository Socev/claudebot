'use strict';
// geheimen.js — één gedeelde patroonlijst voor sleutels, tokens en wachtwoorden (wv3405, actieplan Fable-reviews 19-11-2026, A32 deel 1).
//
// WAAROM. Er waren tien eigen geheimenfilters, elk met andere gaten; vier Fable-reviews (register-zoek § 1, imagine § O1, vault-rag
// § P1/P2, vereenvoudigen § M2) vonden los van elkaar hetzelfde soort lek: een kort wachtwoord, een tabelcel, een JSON-sleutel,
// client_secret, hex/AWS, een URL met inlog of UTF-16 ging door het filter en kon mee naar het Zoek snel-model, OpenAI of een gedeelde
// Docs-pagina. Een gat dicht je nu op één plek.
//
// Twee standen:
// - weergave (streng false): precies het masker dat secondbrain.js tot wv3405 had (app-weergave en de schrijfpoorten van de vault). Bewust
//   ongewijzigd: David ziet zijn pagina's zoals eerst en opslaan weigert niet vaker.
// - streng (streng true): voor alles wat het huis verlaat (modelcontext van Zoek snel, Docs › Delen, openai-hulp). Daarbovenop: wachtwoordwoorden
//   met korte waarden (ook "het wachtwoord is …", tabelcel, vet label, JSON-sleutel), pw/ww/pwd/pass/pin, namen met secret/token/key/auth/
//   credential vanaf 8 tekens, URL met inlog, Authorization/Basic, vaste sleutelvoorvoegsels (sb_secret_, sbp_, GOCSPX-, glpat-, AGE-SECRET-KEY,
//   Stripe, Slack xoxe, npm_, hf_, whsec_, SendGrid, Azure AccountKey), PGP-privésleutel, en kale tokens ook direct na een /. Een NUL-teken
//   (UTF-16 dat als UTF-8 gelezen is) gaat eruit vóór het zoeken en telt zelf als treffer.
// Beleid (maskeren of weigeren) blijft per plek: maskeer() geeft { tekst, n }; heeft() = n > 0.
//
// Toets: test/geheimen.sh (verzonnen waarden; de gaten uit de drie rapporten als vaste gevallen, plus valse-treffergevallen).
// Restrisico (bewust): een wachtwoord van alleen kleine letters zonder cijfer of teken na "is" en korter dan 6 tekens na een dubbele punt,
// een wachtwoord met spaties, en een kale geheime waarde zonder label en zonder willekeurig patroon worden niet herkend.

const WEG = '[sleutel weggelaten]';
const MARKERING = /^\[(?:sleutel weggelaten|geheim-gemaskeerd)\]/;
const heeftLetterEnCijfer = (s) => /[A-Za-z]/.test(s) && /[0-9]/.test(s);
function willekeurig(tok) {
  const stukken = tok.match(/[A-Za-z0-9]{20,}/g) || [];
  return stukken.some(function (x) { return heeftLetterEnCijfer(x) && (x.match(/[A-Za-z](?=[0-9])|[0-9](?=[A-Za-z])/g) || []).length >= 4; });
}

// Waarden die zelf geen geheim zijn (verwijzing, plaatshouder, variabele): in de strenge stand geen treffer.
const PLAATSHOUDER = /^(?:zie|onbekend|nvt|n\.v\.t\.?|geen|leeg|volgt|kluis|bitwarden|1password|keepass|vault|wachtwoordkluis|sleutelportaal|null|none|nil|undefined|true|false|string|text|tekst|wachtwoord|password|passwd|geheim|secret|token|\*+|x{3,}|\.{2,}|…+|-+|_+|\?+|<[^<>]*>|\[[^\[\]]*\]|\{[^{}]*\}|\{\{[^{}]*\}\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%|process\.env\.[A-Za-z0-9_.]+|os\.environ[\w.\[\]'"]*|env\.[A-Za-z0-9_]+)[.,;:)]*$/i;
// omgevingsnaam (HOOFDLETTERS_ONDER) of één woord in hoofdletters zonder cijfer: een verwijzing, geen waarde
// ook alles wat met <, [, { of ( begint (sjabloon, of ons eigen '[sleutel weggelaten]' bij een tweede regel)
const isPlaatshouder = (w) => /^[<\[{(]/.test(w) || PLAATSHOUDER.test(w) || /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{3,})[.,;:)]*$/.test(w);
// Ziet een waarde eruit als een wachtwoord? cijfer, teken, of kleine→hoofdletter midden in het woord.
const lijktWachtwoord = (w) => /[0-9]/.test(w) || /[!@#$%^&*+=?~_\\\/<>{}()\[\]§€£-]/.test(w.replace(/[.,;:)]+$/, '')) || /[a-z][A-Z]/.test(w);

// Woorden waarna een waarde een wachtwoord is. Lange woorden mogen in een samenstelling staan (hoofdwachtwoord, db_password);
// korte (pw, ww, pwd, pass, pin) alleen als heel woord.
const WW_LANG = 'wachtwoord(?:en)?|password|passwd|passwort|passphrase|pincode|inlogcode|toegangscode|wifi-?code|wifi-?wachtwoord';
const WW_KORT = 'pw|ww|pwd|pass|pin';
const WW_LABEL = '(?:[A-Za-z0-9_.-]*(?:' + WW_LANG + ')|(?<![A-Za-z0-9])(?:' + WW_KORT + '))';
// Het wachtwoordwoord zelf, voor plekken die een hele regel weglaten (Zoek snel laag 3, zoals laag 2).
const WACHTWOORDWOORD = /wachtwoord|password|passwd|passphrase|pincode|inlogcode|toegangscode|inloggegevens|credential|(?<![A-Za-z0-9])(?:pw|pwd|pin)(?![A-Za-z0-9])/i;

// ── weergave: het masker van secondbrain.js (P5) zoals het was, in dezelfde volgorde ────────────────────────────────────────────
function weergave(s, W, tel) {
  const r = function () { tel.n++; return W; };
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, r);
  s = s.replace(/eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*){0,2}/g, r);
  s = s.replace(/github_pat_[A-Za-z0-9_]{20,}/gi, r);
  s = s.replace(/gh[pousr]_[A-Za-z0-9]{20,}/gi, r);
  s = s.replace(/sk-[A-Za-z0-9_-]{20,}/gi, r);
  s = s.replace(/xox[baprs]-[A-Za-z0-9-]{6,}/gi, r);
  s = s.replace(/[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}/g, r);
  s = s.replace(/AIza[0-9A-Za-z_-]{30,}/g, r);
  s = s.replace(/ya29\.[0-9A-Za-z_-]{20,}/g, r);
  s = s.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, r);
  s = s.replace(/hooks\.slack\.com\/services\/[A-Za-z0-9\/_-]+/gi, function () { tel.n++; return 'hooks.slack.com/services/' + W; });
  s = s.replace(/(discord(?:app)?\.com\/api\/webhooks\/)[A-Za-z0-9\/_-]+/gi, function (m, a) { tel.n++; return a + W; });
  s = s.replace(/(bearer\s+)([A-Za-z0-9+\/=._-]{16,})/gi, function (m, a) { tel.n++; return a + W; });
  // een eerder ingezette markering (bv. openai-hulp '[geheim-gemaskeerd]', 19 tekens zonder spatie) is geen waarde: maskeren blijft idempotent
  s = s.replace(/((?:service_role|anon[_-]?key|api[_-]?key|token|password|passwd|wachtwoord)["'`]?\s*[:=]\s*["'`]?)([^\s"'`]{16,})/gi, function (m, a, w) {
    if (MARKERING.test(w)) return m;
    tel.n++; return a + W;
  });
  // naam-route: secret/geheim/sleutel als naamdeel, waarde ≥ 12 tekens met letters én cijfers en geen omgevingsnaam (HOOFDLETTERS_ONDER)
  s = s.replace(/((?<![A-Za-z0-9_.-])["'`]?[A-Za-z0-9_.-]*(?:secret(?!ar)|geheim|sleutel)[A-Za-z0-9_.-]*["'`]?\s*[:=]\s*["'`]?)([^\s"'`]{12,})/gi,
    function (m, a, w) { if (heeftLetterEnCijfer(w) && !/^[A-Z0-9_]+$/.test(w) && w.indexOf(W) < 0) { tel.n++; return a + W; } return m; });
  return s;
}

// kale tokens (Fable M1): een reeks [A-Za-z0-9_-] met daarin een stuk van 20+ letters/cijfers dat vaak wisselt tussen letter en cijfer
// (willekeurig, zoals een sleutel of hash); niet binnen [[ ]]. In de weergave niet direct na een / (pad in een URL); streng wel.
function kaleTokens(s, W, tel, streng) {
  const re = streng ? /(\[\[[^\]\n]*\]\])|(^|[^A-Za-z0-9_\-])([A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g
    : /(\[\[[^\]\n]*\]\])|(^|[^A-Za-z0-9_\-\/])([A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g;
  return s.replace(re, function (m, wiki, voor, tok) {
    if (wiki) return wiki;
    if (willekeurig(tok)) { tel.n++; return voor + W; }
    return m;
  });
}

// ── streng: extra vormen voor alles wat het huis verlaat ────────────────────────────────────────────────────────────────────────
function strengExtra(s, W, tel) {
  const r = function () { tel.n++; return W; };
  const metKop = function (m, a) { tel.n++; return a + W; };
  // privésleutels die het weergavepatroon mist (PGP: "PRIVATE KEY BLOCK")
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY BLOCK-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY BLOCK-----|$)/g, r);
  // vaste voorvoegsels
  s = s.replace(/\bsb_secret_[A-Za-z0-9_-]{16,}/g, r);
  s = s.replace(/\bsbp_[A-Za-z0-9]{30,}/g, r);
  s = s.replace(/\bGOCSPX-[A-Za-z0-9_-]{16,}/g, r);
  s = s.replace(/\bglpat-[A-Za-z0-9_-]{16,}/g, r);
  s = s.replace(/\bAGE-SECRET-KEY-1[0-9A-Z]{40,}/g, r);
  s = s.replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, r);
  s = s.replace(/\bwhsec_[A-Za-z0-9+\/=]{16,}/g, r);
  s = s.replace(/\bxox[a-z]-[A-Za-z0-9-]{10,}/g, r);
  s = s.replace(/\bnpm_[A-Za-z0-9]{30,}/g, r);
  s = s.replace(/\bhf_[A-Za-z0-9]{30,}/g, r);
  s = s.replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, r);
  s = s.replace(/(AccountKey=)([A-Za-z0-9+\/=]{20,})/g, metKop);
  // URL met inlog: schema://gebruiker:wachtwoord@host
  s = s.replace(/(\b[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s:\/@"'<>`]+:)([^\s@\/"'<>`]+)(?=@)/g, function (m, a, w) {
    if (w.indexOf(W) >= 0 || isPlaatshouder(w)) return m;
    tel.n++; return a + W;
  });
  // Authorization-kop en Basic
  s = s.replace(/(authorization["'`]?\s*[:=]\s*["'`]?\s*(?:basic|bearer|token|digest|bot)?\s*)([^\s"'`,;]{8,})/gi, function (m, a, w) {
    if (w.indexOf(W) >= 0 || isPlaatshouder(w)) return m;
    tel.n++; return a + W;
  });
  s = s.replace(/(\bbasic\s+)([A-Za-z0-9+\/]{12,}={0,2})(?![A-Za-z0-9+\/=])/gi, function (m, a, w) {
    if (!(heeftLetterEnCijfer(w) || /=$/.test(w))) return m;
    tel.n++; return a + W;
  });
  // Wachtwoordwoord + waarde: "wachtwoord: …", "**Wachtwoord:** …", "| Wachtwoord | … |", {"password": "…"}, password=…, pw: …
  // Vanaf 6 tekens altijd (behalve plaatshouder), vanaf 4 als het eruitziet als een wachtwoord (cijfer, teken, hoofdletter midden in).
  const scheiding = '\\**["\'`]?\\**\\s*(?:\\([^)\\n]{0,40}\\)\\s*)?(?:[:=]|\\|)\\s*\\**\\s*["\'`]?\\s*';
  s = s.replace(new RegExp('(' + WW_LABEL + scheiding + ')([^\\s"\'`|]{4,})', 'gi'), function (m, a, w) {
    if (w.indexOf(W) >= 0 || isPlaatshouder(w)) return m;
    if (w.length < 6 && !lijktWachtwoord(w)) return m;
    tel.n++; return a + W;
  });
  // "het wachtwoord is …" / "password was …": alleen als de waarde eruitziet als een wachtwoord (proza blijft staan)
  s = s.replace(new RegExp('(' + WW_LABEL + '\\s+(?:is|luidt|was|wordt|blijft|werd|=)\\s*:?\\s*["\'`]?)([^\\s"\'`|]{4,})', 'gi'), function (m, a, w) {
    if (w.indexOf(W) >= 0 || isPlaatshouder(w) || !lijktWachtwoord(w)) return m;
    tel.n++; return a + W;
  });
  // naam-route streng: secret/geheim/sleutel/token/key/auth/credential als naamdeel (ook JSON-sleutel), waarde ≥ 8 met letters én cijfers
  s = s.replace(/((?<![A-Za-z0-9_.-])["'`]?[A-Za-z0-9_.-]*(?:secret(?!ar)|geheim|sleutel|token|api[-_]?key|apikey|[-_.]key|access[-_]?key|private[-_]?key|auth(?![a-z])|credential|client[-_]?id)[A-Za-z0-9_.-]*["'`]?\s*[:=]\s*["'`]?)([^\s"'`,;]{8,})/gi,
    function (m, a, w) { if (heeftLetterEnCijfer(w) && !isPlaatshouder(w) && w.indexOf(W) < 0) { tel.n++; return a + W; } return m; });
  return s;
}

/**
 * maskeer(t, o) → { tekst, n }
 *   o.streng  true = strenge poortstand (naar buiten); anders de weergave
 *   o.vervang vervangtekst (standaard '[sleutel weggelaten]')
 * n = aantal vervangingen (+1 als er NUL-tekens uit moesten in de strenge stand).
 */
function maskeer(t, o) {
  o = o || {};
  const W = typeof o.vervang === 'string' ? o.vervang : WEG;
  const tel = { n: 0 };
  let s = String(t == null ? '' : t);
  if (o.streng && s.indexOf('\u0000') >= 0) { s = s.replace(/\u0000/g, ''); tel.n++; }   // UTF-16 als UTF-8 gelezen: decoderen en melden
  s = weergave(s, W, tel);
  if (o.streng) s = strengExtra(s, W, tel);
  s = kaleTokens(s, W, tel, !!o.streng);
  return { tekst: s, n: tel.n };
}
function heeft(t, o) { return maskeer(t, o).n > 0; }

// Buffer of tekst → string; UTF-16 (BOM of veel NUL-tekens) wordt gedecodeerd zodat de patronen erop werken.
function tekstVan(b) {
  if (typeof b === 'string') return b;
  if (!Buffer.isBuffer(b)) return String(b == null ? '' : b);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.slice(2).toString('utf16le');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) { const c = Buffer.from(b.slice(2, 2 + ((b.length - 2) & ~1))); c.swap16(); return c.toString('utf16le'); }
  let nul = 0; const n = Math.min(b.length, 4096);
  for (let i = 0; i < n; i++) if (b[i] === 0) nul++;
  if (n >= 8 && nul / n > 0.3) return b.toString(b[0] === 0 ? 'latin1' : 'utf16le').replace(/\u0000/g, '');
  return b.toString('utf8');
}

module.exports = { WEG, maskeer, heeft, tekstVan, WACHTWOORDWOORD, _intern: { willekeurig, heeftLetterEnCijfer, isPlaatshouder, lijktWachtwoord } };
