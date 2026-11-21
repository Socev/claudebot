'use strict';
// ── wv3668 (besluitenpagina nr 3, C06 deel 2; David Ja 21-11-2026): sms-ingang alleen met geldige handtekening ───────────────────
// WAAROM. De webhook "SMS Ontvangst" van n8n AI - SMS Gateway had geen controle: wie het pad kent, zette een nep-sms in sms_inbox die
// Socev als echt las (bv. een valse inlogcode of "bel mij even op dit nummer"; Fable-review beveiliging § 1, 19-11). De SMS Gateway-app
// op Davids telefoon tekent elke webhook: X-Signature = hex(HMAC-SHA256(sleutel, rauwe body + X-Timestamp)), X-Timestamp = Unix-seconden
// (docs.sms-gate.app/features/webhooks; gemeten 21-11 op runs 164008/164007/159970). De sleutel (app › Instellingen › Webhooks › Signing
// Key) staat alleen in de kluis (sms_gateway_signing_key); n8n geeft kop + ruwe bytes door, de pod toetst (POST /bericht/sms-ingang).
// Uitkomst: echt (bewaren), onbevestigd (toets kon niet: kluis leeg/onbereikbaar; WEL bewaren, Socev behandelt het niet als echt) of
// onjuist (handtekening/tijd fout of herhaald). Fase "meten" bewaart ook onjuist (met markering), fase "dicht" niet. Nooit inhoud,
// nummer of handtekening in log of staat: alleen tellingen en redenen. Puur op de geïnjecteerde hulpen na; getoetst in test/sms-ingang.sh.

const crypto = require('crypto');

const TIJD_MS = 5 * 60 * 1000;          // aanbevolen venster sms-gate (±5 min)
const LIJF_MAX = 64 * 1024;             // een sms-webhook is ± 0,5–3 kB
const SLEUTEL_CACHE_MS = 5 * 60 * 1000;
const SLEUTEL_VERS_MS = 5 * 1000;       // fout + sleutel ouder dan dit: één keer verversen (nieuwe sleutel werkt meteen; Codex wv3668 MOET 1:
                                        // niet 60 s, anders valt in fase dicht een echte sms na een sleutelwissel weg). Onder spam ≤ 1 kluisvraag per 5 s.
const HERHAAL_MS = 2 * TIJD_MS;         // een handtekening die binnen dit venster terugkomt = herhaling
const LAATSTE_MAX = 20;

function hmac(sleutel, lijf, ts) {
  return crypto.createHmac('sha256', sleutel).update(Buffer.concat([lijf, Buffer.from(ts, 'utf8')])).digest();
}
function gelijk(a, b) { return a.length === b.length && crypto.timingSafeEqual(a, b); }

// Klopt de handtekening? Eerst over de rauwe bytes (zoals de app tekent); daarna over JSON.stringify(JSON.parse(lijf)): de app stuurt
// compacte JSON en n8n zou de bytes onderweg kunnen normaliseren. Dat tweede is net zo sterk (zonder sleutel geen geldige HMAC).
function klopt(sleutel, lijf, ts, sigHex) {
  const sig = Buffer.from(sigHex.toLowerCase(), 'hex');
  if (gelijk(hmac(sleutel, lijf, ts), sig)) return 'rauw';
  let her = null;
  try { her = Buffer.from(JSON.stringify(JSON.parse(lijf.toString('utf8'))), 'utf8'); } catch (e) { her = null; }
  if (her && !her.equals(lijf) && gelijk(hmac(sleutel, her, ts), sig)) return 'json';
  return null;
}

// o: { kluisLees() -> Promise<string> ('' = leeg; werpt bij storing), nu() -> ms, fase() -> 'meten'|'dicht', laad() -> staat|null,
//      bewaar(staat) }
function maak(o) {
  const st = Object.assign({ tellers: {}, laatste: [] }, (o.laad && o.laad()) || {});
  if (!st.tellers || typeof st.tellers !== 'object') st.tellers = {};
  if (!Array.isArray(st.laatste)) st.laatste = [];
  let sleutel = '', sleutelOp = 0, bezig = null;
  const gezien = new Map();   // handtekening -> ms (alleen geheugen; een herstart vergeet hooguit 10 min aan herhalingen)

  async function haalSleutel(vers) {
    if (!vers && sleutel && o.nu() - sleutelOp < SLEUTEL_CACHE_MS) return sleutel;
    if (!bezig) {   // gelijktijdige verzoeken delen één kluisvraag
      bezig = Promise.resolve().then(o.kluisLees).then(function (w) { sleutel = String(w || '').trim(); sleutelOp = o.nu(); return sleutel; })
        .finally(function () { bezig = null; });
    }
    return bezig;
  }
  function noteer(uitslag, reden, via) {
    const k = uitslag + (reden ? ':' + reden : '');
    st.tellers[k] = (st.tellers[k] || 0) + 1;
    st.laatste.unshift({ t: new Date(o.nu()).toISOString(), uitslag: uitslag, reden: reden || '', via: via || '' });
    st.laatste.length = Math.min(st.laatste.length, LAATSTE_MAX);
    try { if (o.bewaar) o.bewaar(st); } catch (e) { /* telling is bijzaak; de uitslag telt */ }
  }
  function antwoord(uitslag, reden, via) {
    const fase = o.fase() === 'dicht' ? 'dicht' : 'meten';
    noteer(uitslag, reden, via);
    return { status: 200, j: { ok: true, echt: uitslag === 'echt', echtheid: uitslag, reden: reden || '', fase: fase,
      bewaar: uitslag !== 'onjuist' || fase !== 'dicht' } };
  }

  async function toets(d) {
    d = d && typeof d === 'object' ? d : {};
    if (typeof d.lijf_b64 !== 'string' || !d.lijf_b64 || d.lijf_b64.length > LIJF_MAX * 4 / 3 + 8) return antwoord('onjuist', 'geen of te groot lijf');
    const lijf = Buffer.from(d.lijf_b64, 'base64');
    if (!lijf.length || lijf.length > LIJF_MAX) return antwoord('onjuist', 'geen of te groot lijf');
    const sig = typeof d.x_signature === 'string' ? d.x_signature.trim() : '';
    const ts = typeof d.x_timestamp === 'string' ? d.x_timestamp.trim() : '';
    if (!sig) return antwoord('onjuist', 'geen handtekening');
    if (!/^[0-9a-fA-F]{64}$/.test(sig)) return antwoord('onjuist', 'handtekening vorm');
    if (!/^\d{9,11}$/.test(ts)) return antwoord('onjuist', 'tijd vorm');
    if (Math.abs(o.nu() - Number(ts) * 1000) > TIJD_MS) return antwoord('onjuist', 'tijd buiten 5 min');
    let k;
    try { k = await haalSleutel(false); } catch (e) { return antwoord('onbevestigd', 'kluis onbereikbaar'); }
    if (!k) return antwoord('onbevestigd', 'kluis leeg');
    let via = klopt(k, lijf, ts, sig);
    if (!via && o.nu() - sleutelOp > SLEUTEL_VERS_MS) {
      try { k = await haalSleutel(true); } catch (e) { k = ''; }
      if (!k) return antwoord('onbevestigd', 'kluis onbereikbaar');
      via = klopt(k, lijf, ts, sig);
    }
    if (!via) return antwoord('onjuist', 'handtekening onjuist');
    const nu = o.nu(), sl = sig.toLowerCase();
    gezien.forEach(function (t, s) { if (nu - t > HERHAAL_MS) gezien.delete(s); });
    if (gezien.has(sl)) return antwoord('onjuist', 'herhaald');
    gezien.set(sl, nu);
    return antwoord('echt', '', via);
  }

  function health() {
    return { fase: o.fase() === 'dicht' ? 'dicht' : 'meten', tellers: Object.assign({}, st.tellers), laatste: st.laatste.slice(0, 5) };
  }
  return { toets: toets, health: health };
}

module.exports = { maak: maak, klopt: klopt, TIJD_MS: TIJD_MS };
