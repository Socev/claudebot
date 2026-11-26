'use strict';
// wv4192 (besluitenpagina nr 391 = 3C91, David Ja 25-11-2026 22:30): knopstap op een Voor jou-kaart. Een inloglink in de kaarttekst breekt,
// omdat de databank een sleutelachtig stuk (?token=…) vervangt door "[sleutel weggelaten]". Nu geeft de kaartmaker (werkvoorraad.py
// --voor-jou met kaartveld knoplink) de volledige link apart aan de pod; de kaart toont alleen een knop.
//
// Twee bestanden, bewust gescheiden (Codex-ontwerpreview ZOU 1):
//   merk  (socev-app-data/vj-knoplink.json): kaart-id → { sleutel, tekst, tot, op, weg_sinds } — GEEN link; blijft tot de kaart dicht is,
//         zodat de kaart na het verlopen of na een pod-herstart nog kan zeggen "de knop is verlopen".
//   links (/tmp/socev-vj-knoplink/links.json, map 0700, bestand 0600): kaart-id → link. Buiten socev-app-data (die gaat mee in de warme
//         kopie naar de uitwijk) en buiten elke back-up; een herstart van de pod wist hem. Hooguit 7 dagen, hooguit 50.
// De link komt nooit in een log, een antwoord van de ingang of de databank; alleen in het detailantwoord van een open kaart aan de app.
const fs = require('fs'), path = require('path');

const MAX_MS = 7 * 24 * 3600 * 1000;
const MAX_N = 50;
const WEG_MS = 2 * 60 * 1000;   // kaart niet meer open: pas na 2 min weg (↩️ in de app kan tot een minuut na een keuze)
const MERK_MAX_MS = 30 * 24 * 3600 * 1000;   // vangnet: een markering zonder kaartlezing blijft hooguit 30 dagen
const SLEUTEL_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const URL_RE = /^https:\/\/[^\s"'<>`\\]{3,1990}$/;

function maak(o) {
  o = o || {};
  const merkPad = o.merkPad, linkDir = o.linkDir || '/tmp/socev-vj-knoplink';
  const linkPad = path.join(linkDir, 'links.json');
  const klok = o.klok || Date.now;

  function lees(p) { try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (e) { return {}; } }
  function schrijf(p, data) {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, p);
  }
  // verlopen links weg (de markering blijft: "verlopen"); oude markeringen weg
  function laad() {
    const nu = klok(), merk = lees(merkPad), links = lees(linkPad);
    let mw = false, lw = false;
    Object.keys(links).forEach(function (id) {
      const m = merk[id];
      if (!m || !(m.tot > nu) || typeof links[id] !== 'string') { delete links[id]; lw = true; }
    });
    Object.keys(merk).forEach(function (id) {
      const m = merk[id];
      if (!m || typeof m !== 'object' || !(nu - (m.op || 0) < MERK_MAX_MS)) { delete merk[id]; mw = true; }
    });
    return { merk: merk, links: links, mw: mw, lw: lw };
  }
  function bewaar(s) {
    if (s.lw) schrijf(linkPad, s.links);
    if (s.mw) schrijf(merkPad, s.merk);
  }

  // Zet: p = de open kaart (id, sleutel, status) die de pod zelf vers las. Geeft { ok, id, tot } of { ok: false, fout }; nooit de link.
  function zet(p, tekst, url) {
    if (!p || !Number.isInteger(p.id) || p.id < 1 || !SLEUTEL_RE.test(String(p.sleutel || ''))) return { ok: false, fout: 'geen open kaart' };
    if (['open', 'later'].indexOf(p.status) < 0) return { ok: false, fout: 'kaart niet open' };
    if (typeof url !== 'string' || !URL_RE.test(url)) return { ok: false, fout: 'link: alleen https, zonder spaties of aanhalingstekens, hooguit 2000 tekens' };
    const t = String(tekst == null ? '' : tekst).replace(/\s+/g, ' ').trim();
    if (t.length < 2 || t.length > 60) return { ok: false, fout: 'knoptekst: 2 tot 60 tekens' };
    const s = laad(), nu = klok(), id = String(p.id);
    // één knoplink per kaart en per sleutel: een nieuwe vervangt de oude
    Object.keys(s.merk).forEach(function (k) { if (k === id || s.merk[k].sleutel === p.sleutel) { delete s.merk[k]; delete s.links[k]; } });
    s.merk[id] = { sleutel: p.sleutel, tekst: t, tot: nu + MAX_MS, op: nu };
    s.links[id] = url;
    const ids = Object.keys(s.merk).sort(function (a, b) { return (s.merk[a].op || 0) - (s.merk[b].op || 0); });
    while (ids.length > MAX_N) { const k = ids.shift(); delete s.merk[k]; delete s.links[k]; }
    s.mw = s.lw = true;
    bewaar(s);
    return { ok: true, id: p.id, tot: new Date(nu + MAX_MS).toISOString() };
  }

  // Voor het detailantwoord: { tekst, url } zolang hij geldt, { tekst, verlopen: true } daarna, undefined zonder knopstap of als de kaart
  // niet (meer) open is of een andere sleutel heeft.
  function voor(p) {
    if (!p || !Number.isInteger(p.id)) return undefined;
    const s = laad(), m = s.merk[String(p.id)];
    bewaar(s);
    if (!m || m.sleutel !== p.sleutel || ['open', 'later'].indexOf(p.status) < 0) return undefined;
    const url = s.links[String(p.id)];
    return typeof url === 'string' && m.tot > klok() ? { tekst: m.tekst, url: url } : { tekst: m.tekst, verlopen: true };
  }

  // Na een geslaagde lijstlezing: open = ids van kaarten met status open/later. Een kaart die er > 2 min niet meer in staat: weg.
  function opruim(openIds) {
    const s = laad(), nu = klok(), open = new Set((openIds || []).map(String));
    Object.keys(s.merk).forEach(function (id) {
      const m = s.merk[id];
      if (open.has(id)) { if (m.weg_sinds) { delete m.weg_sinds; s.mw = true; } return; }
      if (nu - (m.op || 0) < WEG_MS) return;   // net gezet: de lijst kan achterlopen (cache van 60 s)
      if (!m.weg_sinds) { m.weg_sinds = nu; s.mw = true; return; }
      if (nu - m.weg_sinds >= WEG_MS) { delete s.merk[id]; delete s.links[id]; s.mw = s.lw = true; }
    });
    bewaar(s);
  }

  // Elk uur (timer in server.js): verlopen links van schijf, ook zonder verkeer
  function tik() { bewaar(laad()); }

  function info() {
    const s = laad(), nu = klok();
    return { module: true, kaarten: Object.keys(s.merk).length, geldig: Object.keys(s.links).filter(function (id) { return s.merk[id] && s.merk[id].tot > nu; }).length };
  }

  return { zet: zet, voor: voor, opruim: opruim, tik: tik, info: info, linkPad: linkPad };
}

module.exports = { maak: maak, MAX_MS: MAX_MS, MAX_N: MAX_N, WEG_MS: WEG_MS, URL_RE: URL_RE };
