'use strict';
// ── wv3664 (besluitenpagina nr 3, C06; David Ja 21-11-2026): een sms gaat pas weg na Davids tik ──────────────────────────────
// WAAROM. Het geheim waarmee Socev sms leest (N8N_WEBHOOK_SMS) opende ook de verzendtak van n8n AI - SMS Gateway: een mail of
// webpagina met een verborgen opdracht kon zo uit Davids naam een sms sturen, ook met een net gelezen inlogcode (Fable-review
// beveiliging § 1, 19-11). Nu doet Socev alleen een voorstel (POST /smal/sms/voorstel); de pod zet dat als bericht met de bekende
// knoppen "✅ Uitvoeren · vingerafdruk / ❌ Niet doen" in het hoofdgesprek van de app. Pas na ✅ (verse vingerafdruk) maakt de pod
// een eenmalige pas (32 hex, 60 s, alleen in het geheugen) voor precies dit nummer en deze tekst en roept de verzendtak aan. n8n
// toetst die pas terug via POST /bericht/sms-pas met het pod-geheim (credential "Claudebot pod API (body-secret)"); het leesgeheim
// opent de verzendtak niet meer. Puur (geen netwerk, geen schijf): getoetst in test/sms-tik.sh.

const TEKST_MAX = 918;            // ruwe bovengrens in tekens; de echte grens is DELEN_MAX sms-delen (review wv3664 MOET 1)
const DELEN_MAX = 6;
// GSM 03.38: basisset (1 septet) en uitbreiding (2 septets). Eén teken daarbuiten = hele bericht in UCS-2 (70/67 per deel).
const GSM_BASIS = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_UIT = '^{}\\[~]|€\f';
const NAAM_MAX = 60;
const PAS_MS = 60000;
const PAS_MAX = 50;
const NUMMER_RE = /^\+[1-9]\d{7,14}$/;

// Nummer naar internationale vorm. 06… en andere Nederlandse 0-nummers krijgen +31; 00… wordt +. Geen gok bij twijfel: null.
function nummer(x) {
  if (typeof x !== 'string') return null;
  let s = x.trim().replace(/[\s\-().\/]/g, '');
  if (/^00[1-9]/.test(s)) s = '+' + s.slice(2);
  else if (/^0[1-9]\d{8}$/.test(s)) s = '+31' + s.slice(1);
  return NUMMER_RE.test(s) ? s : null;
}

// Aantal sms-delen zoals de telefoon het verstuurt (GSM-7 160/153, anders UCS-2 70/67 in UTF-16-eenheden).
function delen(t) {
  let septets = 0, gsm = true;
  for (const c of t) {
    if (GSM_BASIS.indexOf(c) >= 0) septets += 1;
    else if (GSM_UIT.indexOf(c) >= 0) septets += 2;
    else { gsm = false; break; }
  }
  if (gsm) return septets <= 160 ? 1 : Math.ceil(septets / 153);
  return t.length <= 70 ? 1 : Math.ceil(t.length / 67);
}

// Leesbare weergave voor David (+31 6 12345678); andere landen ongewijzigd.
function nummerLeesbaar(n) {
  const m = /^\+316(\d{8})$/.exec(n);
  return m ? '+31 6 ' + m[1] : n;
}

// Voorstel van Socev toetsen. Geeft { naar, tekst, naam } of een foutzin.
function valideer(d) {
  d = d && typeof d === 'object' ? d : {};
  const naar = nummer(d.naar);
  if (!naar) return 'naar is geen telefoonnummer (bijvoorbeeld +31612345678 of 0612345678)';
  if (typeof d.tekst !== 'string') return 'tekst ontbreekt';
  const tekst = d.tekst.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (!tekst.trim()) return 'tekst is leeg';
  if (tekst.length > TEKST_MAX) return 'tekst langer dan ' + TEKST_MAX + ' tekens';
  if (delen(tekst) > DELEN_MAX) return 'tekst wordt ' + delen(tekst) + ' sms-delen (max ' + DELEN_MAX + '); korter maken (emoji en tekens buiten het sms-alfabet tellen zwaar)';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(tekst)) return 'tekst bevat stuurtekens';
  if (tekst.indexOf('```') >= 0) return 'tekst bevat ``` (dat kan de app niet eerlijk tonen)';
  if (/\[\s*OPEN\b/i.test(tekst)) return 'tekst bevat [OPEN (de app haalt zo\'n regel weg; David zou iets anders zien dan er weggaat)';
  let naam = '';
  if (d.naam !== undefined && d.naam !== null && d.naam !== '') {
    if (typeof d.naam !== 'string') return 'naam is tekst';
    naam = d.naam.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069*_`#\[\]<>|\\~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAAM_MAX);
  }
  return { naar: naar, tekst: tekst, naam: naam };
}

// Het bericht in de app. De sms-tekst staat in een codeblok: David ziet precies wat er weggaat, zonder opmaak.
function berichtTekst(v) {
  return '📱 **Sms-voorstel** — gaat pas weg na jouw ✅\n\n' +
    'Aan: **' + nummerLeesbaar(v.naar) + '**' + (v.naam ? ' (volgens Socev: ' + v.naam + ')' : '') + '\n\n' +
    '```\n' + v.tekst + '\n```\n\n' +
    'Gaat vanaf je eigen 06. ❌ = niets versturen.';
}

// Eenmalige passen: maak(v) → pas; toets(d) → { ok } alleen als de pas bestaat, niet verlopen is en naar + tekst precies gelijk
// zijn. Een getoetste pas is op, ook bij nee.
function passen(o) {
  const nu = o.nu, toeval = o.toeval, m = new Map();
  const sleutel = function (x) { return JSON.stringify([String((x && x.naar) || ''), String((x && x.tekst) || '')]); };
  function maak(v) {
    const n = nu();
    for (const [k, w] of m) if (n - w.t > PAS_MS) m.delete(k);
    if (m.size >= PAS_MAX) throw new Error('te veel open passen');
    const pas = String(toeval());
    if (!/^[0-9a-f]{32}$/.test(pas)) throw new Error('pas niet goed');
    m.set(pas, { s: sleutel(v), t: n });
    return pas;
  }
  function toets(d) {
    d = d && typeof d === 'object' ? d : {};
    const pas = typeof d.pas === 'string' && /^[0-9a-f]{32}$/.test(d.pas) ? d.pas : '';
    const w = pas ? m.get(pas) : null;
    if (pas) m.delete(pas);
    const ok = !!w && nu() - w.t <= PAS_MS && w.s === sleutel(d);
    return { status: 200, j: ok ? { ok: true } : { ok: false } };
  }
  return { maak: maak, toets: toets, open: function () { return m.size; } };
}

function kort(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }

// Antwoord van de verzendtak → { pagina, tekst } voor de knop. Bij twijfel nooit "niet verstuurd": een time-out kan al weg zijn.
function uitkomst(fout, status, j, naar) {
  if (fout) return { pagina: 'mislukt', tekst: '⚠️ Geen antwoord van de sms-dienst; onbekend of de sms weg is. Kijk in je berichten-app. Ik verstuur hem niet opnieuw.' };
  j = j && typeof j === 'object' ? j : {};
  if (status === 200 && j.status === 'ok') return { pagina: 'uitgevoerd', tekst: '✅ Sms aangeboden aan je telefoon, naar ' + nummerLeesbaar(naar) + '.' };
  if (status === 403) return { pagina: 'mislukt', tekst: '⚠️ Niet verstuurd: de sms-dienst nam de pas niet aan.' };
  // review wv3664 MOET 2: een fout ná de toets van de pas bewijst niet dat er niets weg is; alleen 403 (pas geweigerd) is vóór het versturen
  if (status === 502 || j.status === 'fout') return { pagina: 'mislukt', tekst: '⚠️ De sms-dienst gaf een fout' + (j.fout ? ' (' + kort(j.fout, 120) + ')' : '') + '; onbekend of de sms weg is. Kijk in je berichten-app. Ik verstuur hem niet opnieuw.' };
  return { pagina: 'mislukt', tekst: '⚠️ Onbekende uitkomst (HTTP ' + Number(status) + '); kijk in je berichten-app. Ik verstuur hem niet opnieuw.' };
}

module.exports = { nummer, nummerLeesbaar, delen, valideer, berichtTekst, passen, uitkomst, TEKST_MAX, PAS_MS };
