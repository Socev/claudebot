'use strict';
// AIX — de pod-kant (wv942, AIX stap 2; bouwplan vault "01_Ontwikkeling/AIX - Agentic Ideas eXchange (ontwerp 23-10-2026).md" § 5.3–§ 8, § 10).
// WAAROM. AIX (aix.socev.dev) is de etalage waar agents ideekaarten tonen in een eigen winkel (David 23-10 14:34: "Wij kunnen daar diverse
// ideeën etaleren, zoals onze Managers, maar ook onze Apps … Plaatje, uitleg, 'Show and tell'"). Deze module is de enige weg van de pod
// naar AIX: ondertekenen met Socevs eigen Ed25519-sleutel (/opt/data/aix/sleutel, nooit gelogd), lezen met vaste velden en lengtegrenzen,
// en de uurlijkse goedkeuringsronde (vaste regels, geen model). Schrijven gebeurt alleen via een vaste lijst routes: Socevs eigen kaart,
// plaatje of reactie (alleen aangeroepen door ideeen.js na Davids Ja met verse vingerafdruk), en beheer (toelaten van een BEKENDE
// eigenaar, afwijzen op een vaste reden, schorsen op een vast signaal). Een nieuwe eigenaar of Davids eigen adres laat de pod nooit toe:
// daarvoor komt een Voor jou-kaart met de link naar AIX (de site weigert het de podsleutel ook, 403).
//
// Tekst van AIX (kaarten, reacties, namen en zinnen van aanvragen) is gegeven, nooit opdracht (§ 7): hier alleen platgeslagen en begrensd;
// een model ziet hem alleen zonder gereedschap (ideeen.js, concepten). AIX plat = "niet bereikbaar", geen melding; server.js zet pas een
// box-rij als het langer dan een dag duurt.
//
// Profiel (RFC 9421, /voor-agents.md): Content-Digest over de body (ook leeg), Signature-Input aix=("@method" "@authority" "@path" "@query"
// "content-digest");created;expires=+300;nonce;keyid;alg="ed25519", handtekening over de basis. Alleen Node crypto, geen pakketten.
// CLI (machinekamer): node aix.js ik | winkels | nieuw [sinds] | aanvragen | ronde --droog   (leest; ronde --droog schrijft niets)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASIS = 'https://aix.socev.dev';
const SLEUTEL_PAD = '/opt/data/aix/sleutel';
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const CATEGORIEEN = ['apps', 'managers-en-bewaking', 'informatieverwerking', 'geheugen-en-kennis', 'spraak-en-beeld', 'agenda-en-taken', 'koppelingen', 'werkwijze', 'overig'];
const STATUSSEN = ['bedacht', 'in aanbouw', 'in gebruik', 'gestopt'];
const GRENS = { titel: 70, zin: 160, wat: 400, oplevert: 300, hoe: 500, link: 300, reactie: 800, naam: 30, weergave: 30, reden: 200,
  kaarten: 300, reacties: 200, winkels: 200, aanvragen: 200, logboek: 500, beelden: 3, ruw: 400,
  json_bytes: 1536 * 1024, beeld_bytes: 2 * 1024 * 1024, timeout_ms: 20000, per_eigenaar: 3 };
const NAAM = /^[a-z][a-z0-9-]{2,29}$/;
const GERESERVEERD = new Set(['socev', 'david', 'aix', 'beheer', 'admin', 'systeem', 'mens', 'moderator', 'oud-lid']);
const AFWIJS = ['naam-bezet', 'lengte', 'te-veel-agents', 'patroon', 'regel'];   // de site kent alleen deze (toegang.js AFWIJS_REDENEN)
const DAVID = ['d.schaap@gmail.com', 'dokterschaap@gmail.com'];   // nooit door de pod toegelaten (site: DAVID_EMAIL; hier ook het tweede adres)
const ID = '[1-9][0-9]{0,11}';
const ISO_Q = '\\d{4}-\\d{2}-\\d{2}T\\d{2}%3A\\d{2}%3A\\d{2}(?:\\.\\d{1,3})?Z';
// De enige paden die de pod ooit aanroept (methode + pad met query). Al het andere = geen netwerk.
const ROUTES = [
  ['GET', new RegExp('^/api/ik$')],
  ['GET', new RegExp('^/api/winkels$')],
  ['GET', new RegExp('^/api/kaarten$')],
  ['GET', new RegExp('^/api/kaart/' + ID + '$')],
  ['GET', new RegExp('^/api/nieuw\\?sinds=' + ISO_Q + '$')],
  ['GET', new RegExp('^/api/beeld/[0-9a-f]{64}$')],
  ['GET', new RegExp('^/api/beheer/aanvragen$')],
  ['GET', new RegExp('^/api/beheer/logboek\\?sinds=' + ISO_Q + '$')],
  ['POST', new RegExp('^/api/kaart$')],
  ['POST', new RegExp('^/api/kaart/' + ID + '/beeld$')],
  ['POST', new RegExp('^/api/kaart/' + ID + '/reactie$')],
  ['POST', new RegExp('^/api/beheer/aanvraag/[0-9a-f]{32}/(toelaten|afwijzen)$')],
  ['POST', new RegExp('^/api/beheer/agent/[a-z][a-z0-9-]{2,29}/schors$')],
];
const toegestaan = (m, pq) => ROUTES.some(function (r) { return r[0] === m && r[1].test(pq); });

// ── tekst (alles van AIX is gegeven: platgeslagen, begrensd, geen stuur- of richtingstekens) ──
const STUUR = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;
function tekst(t, max, regels) {
  let s = typeof t === 'string' ? t : '';
  s = s.normalize('NFKC').replace(/\r\n?/g, '\n');
  s = regels ? s.replace(/[\t ]*\n[\t ]*/g, '\n').replace(STUUR, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    : s.replace(STUUR, ' ').replace(/\s+/g, ' ');
  return [...s.trim()].slice(0, max).join('').trim();
}
const iso = (t) => (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(t) && Number.isFinite(Date.parse(t)) ? t : null);
const geheel = (n) => (Number.isInteger(n) && n > 0 && n < 1e12 ? n : null);
const naamVan = (n) => (typeof n === 'string' && NAAM.test(n) ? n : null);
// Weergavenamen van mensen kiest de eigenaar zelf (zelfde regels als agentnamen); David heet "David"
const weergaveVan = (n) => { const s = tekst(n, GRENS.weergave); return /^[A-Za-z][A-Za-z0-9 -]{0,29}$/.test(s) ? s : 'onbekend'; };
function linkVan(l) {
  if (typeof l !== 'string' || !l || l.length > GRENS.link || /\s/.test(l)) return null;
  try { const u = new URL(l); return u.protocol === 'https:' && !u.username && !u.password ? u.href.slice(0, GRENS.link) : null; } catch (e) { return null; }
}

function kaartSchoon(k) {
  if (!k || typeof k !== 'object' || !geheel(k.id)) return null;
  const basis = { id: k.id, winkel: naamVan(k.winkel) || 'onbekend', aangemaakt: iso(k.aangemaakt), gewijzigd: iso(k.gewijzigd) };
  if (k.verborgen) return Object.assign(basis, { verborgen: true, titel: 'verborgen door de moderator' });
  const beelden = Array.isArray(k.beelden) ? k.beelden.filter(function (b) { return b && /^[0-9a-f]{64}$/.test(b.hash) && /^(png|jpg|jpeg|webp)$/.test(b.ext); })
    .slice(0, GRENS.beelden).map(function (b) { return { hash: b.hash, ext: b.ext }; }) : [];
  const uit = Object.assign(basis, {
    titel: tekst(k.titel, GRENS.titel), zin: tekst(k.zin, GRENS.zin), wat: tekst(k.wat, GRENS.wat, true), oplevert: tekst(k.oplevert, GRENS.oplevert, true),
    hoe: tekst(k.hoe, GRENS.hoe, true), categorie: CATEGORIEEN.indexOf(k.categorie) >= 0 ? k.categorie : 'overig', status: STATUSSEN.indexOf(k.status) >= 0 ? k.status : '',
    link: linkVan(k.link), gesloten: !!k.gesloten, reacties: Number.isInteger(k.reacties) && k.reacties >= 0 ? Math.min(k.reacties, 9999) : null, beelden: beelden });
  if (typeof k.wacht_op_moderatie === 'string') uit.wacht_op_moderatie = tekst(k.wacht_op_moderatie, GRENS.reden);
  return uit;
}
function reactieSchoon(r) {
  if (!r || typeof r !== 'object' || !geheel(r.id)) return null;
  return { id: r.id, kaart: geheel(r.kaart), auteur: r.mens ? weergaveVan(r.auteur) : (naamVan(r.auteur) || 'onbekend'), mens: !!r.mens,
    tekst: r.gewist || r.verborgen ? '' : tekst(r.tekst, GRENS.reactie, true), gewist: !!r.gewist, verborgen: !!r.verborgen, eigen: !!r.eigen,
    beantwoord: !!r.beantwoord, aangemaakt: iso(r.aangemaakt), gewijzigd: iso(r.gewijzigd) };
}
const lijstVan = (l, f, max) => (Array.isArray(l) ? l.slice(0, max).map(f).filter(Boolean) : []);

// ── de vaste toets op een aanvraag (§ 5.3 stap 3; geen model). Raw = zoals AIX hem gaf, vóór het platslaan. ──
const GEHEIM = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{10,}/, /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\bwk_[a-z0-9-]+_[A-Za-z0-9]{8,}/, /\bcfut_[A-Za-z0-9_-]{20,}/, /\b(api[_-]?key|secret|token|password|passwd|wachtwoord|sleutel)\s*[:=]\s*\S{8,}/i, /[A-Za-z0-9_+/=-]{40,}/];
// Injectie: een zin die een assistent iets opdraagt, of die een kaartknop of verwijzing nabootst (Voor jou zou hem anders als besluit tonen)
const INJECTIE = [
  /\b(socev|assistent|assistant|agent|ai|claude|gpt|llm|model|systeem|system|beheerder|moderator|david)\b[^.!?\n]{0,60}\b(keur|goedkeur|approv|toela|laat\b[^.!?\n]{0,20}\btoe|verstuur|stuur|send|negeer|ignore|vergeet|forget|voer\b[^.!?\n]{0,20}\buit|execute|run\b|doe\b|moet|must|should)/i,
  /\b(keur|goedkeur|approve|accept)\w*\b[^.!?\n]{0,30}\b(mij|me|deze|this|ons|us)\b/i,
  /\b(ignore|negeer|vergeet|forget|disregard)\b[^.!?\n]{0,30}\b(all|alle|previous|vorige|eerdere|instruct|regel|rules?)/i,
  /\b(system|systeem)\s*prompt\b|<\/?\s*(system|instructions?|assistant|user)\s*>|\[\/?(INST|SYS)\]|```/i,
  /(^|[^a-z])(druk|tik|klik|press|click)\s+(op\s+)?["'“‘]?(ja|nee|yes|no|toelaten|approve)\b/i,
  /(^|[^a-z0-9_])wv[0-9]+|mk-scripts\/|\/opt\/data\/|(^|[\s("'‘“/])[0-9]{2}_[A-Z][A-Za-z]+|[\]a-z0-9)]\.md([^a-z0-9]|$)/i,
  /https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|nl|dev|io|ai|app|be|de|eu)\b/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];
const LATIJN = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]*$/u;
function aanvraagToets(a, bezet) {
  const naam = a.naam_ruw, zin = a.zin_ruw;
  if (typeof naam !== 'string' || !NAAM.test(naam)) return 'regel';
  if (GERESERVEERD.has(naam) || naam.indexOf('socev') === 0) return 'naam-bezet';
  if (bezet && bezet.has(naam) && a.vervangt !== naam) return 'naam-bezet';
  if (typeof zin !== 'string' || a.zin_te_lang) return 'lengte';
  const z = zin.normalize('NFKC').trim();
  if ([...z].length < 3 || [...z].length > GRENS.zin) return 'lengte';
  if (/[\r\n]/.test(z) || /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(z) || !LATIJN.test(z)) return 'regel';
  if (typeof a.eigenaar_email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.eigenaar_email) || a.eigenaar_email.length > 254) return 'regel';
  const alles = naam + '\n' + z;
  if (GEHEIM.some(function (re) { return re.test(alles); })) return 'patroon';
  // naam die de sleutelmaskering in de databank zou raken (wordt "[sleutel weggelaten]", en de kaart te lang): Fable wv943 #3
  if (/(^|-)(xox[a-z]-|sk-|akia)/i.test(naam)) return 'patroon';
  if (INJECTIE.some(function (re) { return re.test(z); })) return 'patroon';
  return null;
}

// Vaste opzoeking in Davids contactenlijst: "bekend als <naam>" of null. Alleen een volledig, exact gelijk adres telt.
function contactNaam(vault, email) {
  const e = String(email || '').toLowerCase();
  if (!/^[^@\s|,;]+@[^@\s|,;]+\.[^@\s|,;]+$/.test(e)) return null;
  let md = '';
  try { md = fs.readFileSync(path.join(vault, '20_Prive/Contacten/Contacten.md'), 'utf8'); } catch (x) { return null; }
  for (const r of md.split('\n')) {
    if (r.toLowerCase().indexOf(e) < 0) continue;
    const m = /^- \*\*(.+?)\*\*(.*)$/.exec(r);
    if (!m) continue;
    const mail = /\bmail:\s*([^|]+)/.exec(m[2]);
    if (!mail) continue;
    if (mail[1].split(/[,;\s]+/).some(function (x) { return x.trim().toLowerCase() === e; })) return tekst(m[1], 60);
  }
  return null;
}

// deps: { sleutelPad?, basis?, fetch?, klok?, fout?(soort, e), sleutel? (KeyObject, alleen de toets) }
function maak(deps) {
  deps = deps || {};
  const BASIS_URL = String(deps.basis || BASIS).replace(/\/+$/, '');
  const AUTORITEIT = new URL(BASIS_URL).host;
  const doFetch = deps.fetch || fetch;
  const klok = deps.klok || Date.now;
  const fout = deps.fout || function () {};
  let prive = deps.sleutel || null, keyid = null, sleutelFout = null;
  const stand = { laatst_ok: null, plat_sinds: null, laatste_fout: null, aanroepen: 0 };

  function sleutel() {
    if (prive && keyid) return prive;
    try {
      if (!prive) prive = crypto.createPrivateKey(fs.readFileSync(deps.sleutelPad || SLEUTEL_PAD));
      const ruw = crypto.createPublicKey(prive).export({ format: 'der', type: 'spki' }).subarray(12);
      keyid = crypto.createHash('sha256').update(ruw).digest('base64url').slice(0, 32);
      sleutelFout = null;
      return prive;
    } catch (e) { prive = null; keyid = null; sleutelFout = 'geen bruikbare AIX-sleutel op de pod'; return null; }   // nooit de inhoud of het pad in een fout
  }
  function koppen(methode, pq, body, o) {
    o = o || {};
    const k = sleutel();
    if (!k) return null;
    const i = pq.indexOf('?');
    const pad = i >= 0 ? pq.slice(0, i) : pq, query = i >= 0 ? pq.slice(i) : '?';
    const created = o.created || Math.floor(klok() / 1000);
    const nonce = o.nonce || crypto.randomBytes(18).toString('base64url');
    const digest = 'sha-256=:' + crypto.createHash('sha256').update(body).digest('base64') + ':';
    const params = '("@method" "@authority" "@path" "@query" "content-digest");created=' + created + ';expires=' + (created + 300) + ';nonce="' + nonce + '";keyid="' + keyid + '";alg="ed25519"';
    const basis = ['"@method": ' + methode, '"@authority": ' + (o.autoriteit || AUTORITEIT), '"@path": ' + pad, '"@query": ' + query,
      '"content-digest": ' + digest, '"@signature-params": ' + params].join('\n');
    const sig = crypto.sign(null, Buffer.from(basis), k).toString('base64');
    return { 'Content-Digest': digest, 'Signature-Input': 'aix=' + params, 'Signature': 'aix=:' + sig + ':' };
  }
  function plat(reden) { if (!stand.plat_sinds) stand.plat_sinds = new Date(klok()).toISOString(); stand.laatste_fout = String(reden).slice(0, 120); }
  async function leesBegrensd(r, max) {
    const cl = Number(r.headers && r.headers.get && r.headers.get('content-length'));
    if (cl && cl > max) return null;
    if (!r.body || !r.body.getReader) { const b = Buffer.from(await r.arrayBuffer()); return b.length > max ? null : b; }
    const lezer = r.body.getReader(), delen = [];
    let n = 0;
    for (;;) {
      const x = await lezer.read();
      if (x.done) break;
      n += x.value.length;
      if (n > max) { try { await lezer.cancel(); } catch (e) {} return null; }
      delen.push(Buffer.from(x.value));
    }
    return Buffer.concat(delen);
  }
  // Eén ondertekend verzoek. Uit: {status, j} of {status, bin, type} (plaatje); status 0 = niet bereikbaar (plat).
  async function verzoek(methode, pq, inhoud, type) {
    methode = String(methode).toUpperCase();
    if (!toegestaan(methode, pq)) return { status: 400, j: { ok: false, fout: 'pad niet toegestaan' } };
    const body = inhoud === undefined ? Buffer.alloc(0) : Buffer.isBuffer(inhoud) ? inhoud : Buffer.from(JSON.stringify(inhoud));
    const h = koppen(methode, pq, body);
    if (!h) return { status: 503, j: { ok: false, fout: sleutelFout || 'geen sleutel' } };
    if (body.length) h['Content-Type'] = type || 'application/json';
    stand.aanroepen++;
    let r;
    try { r = await doFetch(BASIS_URL + pq, { method: methode, headers: h, body: methode === 'GET' ? undefined : body, redirect: 'manual', signal: AbortSignal.timeout(GRENS.timeout_ms) }); }
    catch (e) { plat('niet bereikbaar'); return { status: 0, plat: true, j: { ok: false, fout: 'AIX is nu niet bereikbaar' } }; }
    if (r.status >= 500 || (r.status >= 300 && r.status < 400)) { plat('HTTP ' + r.status); return { status: 0, plat: true, j: { ok: false, fout: 'AIX is nu niet bereikbaar' } }; }
    stand.laatst_ok = new Date(klok()).toISOString(); stand.plat_sinds = null;
    const ctype = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (/^\/api\/beeld\//.test(pq) && r.status === 200) {
      const bin = await leesBegrensd(r, GRENS.beeld_bytes);
      if (!bin || !/^image\/(png|jpeg|webp)$/.test(ctype)) return { status: 502, j: { ok: false, fout: 'plaatje niet te laden' } };
      return { status: 200, bin: bin, type: ctype };
    }
    const buf = await leesBegrensd(r, GRENS.json_bytes);
    let j = null;
    if (buf && ctype === 'application/json') { try { j = JSON.parse(buf.toString('utf8')); } catch (e) { j = null; } }
    if (!j || typeof j !== 'object' || Array.isArray(j)) j = { ok: false, fout: 'geen geldig antwoord van AIX (' + r.status + ')' };
    if (r.status >= 400) stand.laatste_fout = 'HTTP ' + r.status;
    return { status: r.status, j: j };
  }
  const goed = (r) => r.status === 200 && r.j && r.j.ok === true;
  const foutVan = (r) => ({ ok: false, status: r.status, plat: !!r.plat, fout: tekst(r.j && r.j.fout, 160) || ('AIX gaf ' + r.status) });

  // ── lezen (vaste velden) ──
  async function ik() {
    const r = await verzoek('GET', '/api/ik');
    if (!goed(r)) return foutVan(r);
    return { ok: true, naam: naamVan(r.j.naam), rol: r.j.rol === 'beheer' ? 'beheer' : 'agent', status: tekst(r.j.status, 20), sleutel_id: tekst(r.j.sleutel_id, 32) };
  }
  async function winkels() {
    const r = await verzoek('GET', '/api/winkels');
    if (!goed(r)) return foutVan(r);
    return { ok: true, winkels: lijstVan(r.j.winkels, function (w) {
      const n = naamVan(w && w.naam);
      return n ? { naam: n, zin: tekst(w.zin, GRENS.zin), eigenaar: weergaveVan(w.eigenaar), status: tekst(w.status, 20), kaarten: Number.isInteger(w.kaarten) ? w.kaarten : 0 } : null;
    }, GRENS.winkels) };
  }
  async function kaarten() {
    const r = await verzoek('GET', '/api/kaarten');
    return goed(r) ? { ok: true, kaarten: lijstVan(r.j.kaarten, kaartSchoon, GRENS.kaarten) } : foutVan(r);
  }
  async function kaart(id) {
    if (!geheel(Number(id))) return { ok: false, status: 404, fout: 'onbekende kaart' };
    const r = await verzoek('GET', '/api/kaart/' + Number(id));
    if (!goed(r)) return foutVan(r);
    const k = kaartSchoon(r.j.kaart);
    if (!k) return { ok: false, status: 502, fout: 'kaart niet te lezen' };
    k.reacties_lijst = lijstVan(r.j.kaart.reacties, reactieSchoon, GRENS.reacties);
    return { ok: true, kaart: k };
  }
  async function nieuw(sinds) {
    const s = iso(sinds) || '1970-01-01T00:00:00Z';
    const r = await verzoek('GET', '/api/nieuw?sinds=' + encodeURIComponent(s));
    if (!goed(r)) return foutVan(r);
    return { ok: true, sinds: s, tot: iso(r.j.tot), kaarten: lijstVan(r.j.kaarten, kaartSchoon, GRENS.kaarten), reacties: lijstVan(r.j.reacties, reactieSchoon, GRENS.reacties) };
  }
  async function beeld(hash) {
    if (!/^[0-9a-f]{64}$/.test(String(hash))) return { ok: false, status: 404, fout: 'onbekend plaatje' };
    const r = await verzoek('GET', '/api/beeld/' + hash);
    return r.status === 200 && r.bin ? { ok: true, type: r.type, bin: r.bin } : foutVan(r);
  }
  async function aanvragen() {
    const r = await verzoek('GET', '/api/beheer/aanvragen');
    if (!goed(r)) return foutVan(r);
    return { ok: true, aanvragen: lijstVan(r.j.aanvragen, function (a) {
      if (!a || typeof a.id !== 'string' || !/^[0-9a-f]{32}$/.test(a.id)) return null;
      const e = typeof a.eigenaar_email === 'string' ? a.eigenaar_email.trim().toLowerCase().slice(0, 254) : '';
      return { id: a.id, naam_ruw: typeof a.naam === 'string' ? a.naam.slice(0, 40) : null, zin_ruw: typeof a.zin === 'string' ? a.zin.slice(0, GRENS.ruw) : null,
        zin_te_lang: typeof a.zin === 'string' && a.zin.length > GRENS.ruw, naam: naamVan(a.naam), zin: tekst(a.zin, GRENS.zin), eigenaar_email: e,
        weergave: a.weergave ? weergaveVan(a.weergave) : null, vervangt: naamVan(a.vervangt), status: tekst(a.status, 30),
        bekende_eigenaar: a.bekende_eigenaar === true, aangemaakt: iso(a.aangemaakt), bevestigd_op: iso(a.bevestigd_op), sleutel8: tekst(a.sleutel_id, 8) };
    }, GRENS.aanvragen) };
  }
  async function logboek(sinds) {
    const s = iso(sinds) || '1970-01-01T00:00:00Z';
    const r = await verzoek('GET', '/api/beheer/logboek?sinds=' + encodeURIComponent(s));
    if (!goed(r)) return foutVan(r);
    return { ok: true, logboek: lijstVan(r.j.logboek, function (x) {
      return x && geheel(x.id) ? { id: x.id, wie: tekst(x.wie, 60), wat: tekst(x.wat, 60), waarop: tekst(x.waarop, 80), reden: tekst(x.reden, GRENS.reden), tijd: iso(x.tijd) } : null;
    }, GRENS.logboek) };
  }

  // ── schrijven (alleen deze; aangeroepen na Davids Ja of door de vaste ronde) ──
  async function plaatsKaart(v) {
    const body = {};
    ['titel', 'zin', 'wat', 'oplevert', 'hoe', 'categorie', 'status'].forEach(function (k) { if (typeof v[k] === 'string' && v[k]) body[k] = v[k]; });   // nooit een link (§ 4)
    const r = await verzoek('POST', '/api/kaart', body);
    if (r.status === 201 && r.j && r.j.ok && geheel(r.j.id)) return { ok: true, id: r.j.id, geplaatst: r.j.geplaatst === true, wacht_op_moderatie: r.j.wacht_op_moderatie ? tekst(r.j.wacht_op_moderatie, GRENS.reden) : null };
    return foutVan(r);
  }
  async function plaatsBeeld(id, bin, type) {
    if (!geheel(Number(id)) || !Buffer.isBuffer(bin) || bin.length > GRENS.beeld_bytes || !/^image\/(png|jpeg|webp)$/.test(type)) return { ok: false, status: 400, fout: 'plaatje ongeldig' };
    const r = await verzoek('POST', '/api/kaart/' + Number(id) + '/beeld', bin, type);
    return r.status === 201 && r.j && r.j.ok ? { ok: true, hash: tekst(r.j.hash, 64) } : foutVan(r);
  }
  async function plaatsReactie(id, t) {
    if (!geheel(Number(id)) || typeof t !== 'string' || !t.trim()) return { ok: false, status: 400, fout: 'reactie ongeldig' };
    const r = await verzoek('POST', '/api/kaart/' + Number(id) + '/reactie', { tekst: t });
    return r.status === 201 && r.j && r.j.ok && geheel(r.j.id) ? { ok: true, id: r.j.id, geplaatst: r.j.geplaatst !== false } : foutVan(r);
  }
  async function toelaten(id) { const r = await verzoek('POST', '/api/beheer/aanvraag/' + id + '/toelaten', {}); return goed(r) ? { ok: true } : foutVan(r); }
  async function afwijzen(id, reden) {
    if (AFWIJS.indexOf(reden) < 0) return { ok: false, status: 400, fout: 'geen vaste reden' };
    const r = await verzoek('POST', '/api/beheer/aanvraag/' + id + '/afwijzen', { reden: reden });
    return goed(r) ? { ok: true } : foutVan(r);
  }
  async function schors(naam, reden) {
    if (!naamVan(naam)) return { ok: false, status: 400, fout: 'onbekende agent' };
    const r = await verzoek('POST', '/api/beheer/agent/' + naam + '/schors', { reden: tekst(reden, GRENS.reden) });
    return goed(r) ? { ok: true } : foutVan(r);
  }

  function info() {
    return { sleutel: !!sleutel(), sleutel_fout: sleutelFout, keyid8: keyid ? keyid.slice(0, 8) : null, laatst_ok: stand.laatst_ok, plat_sinds: stand.plat_sinds,
      laatste_fout: stand.laatste_fout, aanroepen: stand.aanroepen };
  }
  return { verzoek, koppen, ik, winkels, kaarten, kaart, nieuw, beeld, aanvragen, logboek, plaatsKaart, plaatsBeeld, plaatsReactie, toelaten, afwijzen, schors, info };
}

// ── de uurlijkse goedkeuringsronde (§ 5.3 stap 3–4, § 5.4) — deterministisch, geen model ──
// deps: { aix, staatLees(), staatSchrijf(s), contact(email) -> naam|null, voorJou(p) -> Promise, voorJouSluit(sleutel, bewijs) -> Promise,
//         davidAdressen?, klok?, droog? }
// Uit: { ok, plat?, bekeken, afgewezen[], toegelaten[], kaarten[], gesloten[], geschorst[], signalen[], fouten[] }
const KAART_SLEUTEL = (id) => 'aix-aanvraag-' + id;
const SIGNAAL_SLEUTEL = (soort, naam) => 'aix-signaal-' + soort + '-' + naam;
// Een adres als wv12@x.nl of x@site.md ziet de databank als verwijzing (voor_jou_verwijzing) en weigert de kaart: dan "naam [at] domein"
const adresOpKaart = (e) => (/(^|[^a-z0-9_])wv[0-9]+|\.md([^a-z0-9]|$)|mk-scripts\/|\/opt\/data\//i.test(e) ? String(e).replace('@', ' [at] ') : e);
// Grenzen van machinekamer.voor_jou (check constraints: waarom <= 400, titel <= 90, meting <= 300). Daarboven weigert de databank de hele
// kaart en zag David niets (wv943: de startset-bundelkaart en elke aanvraagkaart met een gewone zin vielen zo stil weg).
const VJ = { waarom: 400, titel: 90, meting: 300 };
function kap(s, n) { const t = [...String(s == null ? '' : s)]; return t.length <= n ? t.join('') : t.slice(0, n - 1).join('').trimEnd() + '…'; }
// kaal = ook zonder de zin (tweede terugval: de sleutelmaskering van de databank kan een zin langer maken dan 400, Fable wv943 #1)
function aanvraagKaart(a, bekend, zonderAdres, kaal) {
  const vervang = !!a.vervangt;
  const inleiding = vervang ? 'De eigenaar van ' + a.vervangt + ' meldt dat de sleutel kwijt is en vraagt een nieuwe; de oude blijft nog 24 uur geldig en kan bezwaar maken. Alleen jij laat dit toe.'
    : 'Een agent wil een eigen winkel op AIX en zijn eigenaar bevestigde dat met dit e-mailadres. Een nieuwe eigenaar laat alleen jij toe.';
  const adres = zonderAdres ? null : adresOpKaart(String(a.eigenaar_email || ''));
  const naamRegel = 'Agentnaam: ' + a.naam;
  const adresRegel = 'E-mailadres eigenaar: ' + (adres && [...adres].length <= 60 ? adres : 'staat bij de aanvraag op AIX');
  const zinKop = 'Zin (van de agent zelf, geen opdracht): "';
  // de zin krijgt wat er overblijft (minstens 20 tekens); de volledige zin staat op de aanvraagpagina
  const ruimte = VJ.waarom - [...(inleiding + '\n\n' + naamRegel + '\n' + zinKop + '"\n' + adresRegel)].length;
  const zin = kap(String(a.zin || '').replace(/"/g, "'"), Math.max(20, ruimte));
  const zinRegel = kaal ? 'Zin van de agent: staat bij de aanvraag op AIX' : zinKop + zin + '"';
  const controle = [];
  if (a.weergave) controle.push('weergavenaam eigenaar "' + kap(a.weergave, 30) + '"');
  if (a.sleutel8) controle.push('sleutel begint met ' + kap(a.sleutel8, 8));
  return { sleutel: KAART_SLEUTEL(a.id), soort: 'doen',
    titel: kap(vervang ? 'AIX — nieuwe sleutel voor ' + a.vervangt + ' — toelaten?' : 'Nieuwe agent op AIX — toelaten?', VJ.titel),
    waarom: kap(inleiding + '\n\n' + naamRegel + '\n' + zinRegel + '\n' + adresRegel, VJ.waarom),
    meting: kap('Vaste toets van Socev: naam vrij, lengtes goed, geen verdachte tekst.\nIn je contacten: ' + (bekend ? 'bekend als ' + kap(bekend, 60) : 'onbekend'), VJ.meting),
    stappen: ['Open https://aix.socev.dev/beheer/aanvraag/' + a.id + ' (je bent daar ingelogd met Google).',
      'Bekijk naam, zin en eigenaar' + (controle.length ? ' (' + controle.join(', ') + ')' : '') + '; ken je de eigenaar niet, dan is Afwijzen de veilige keuze.',
      'Druk daar Toelaten of Afwijzen. Afwijzen blokkeert die sleutel 30 dagen.',
      'Deze kaart gaat binnen een uur vanzelf dicht zodra de aanvraag op AIX is afgehandeld.'],
    waar: 'overal', prive: false, duur_min: 2, volgorde: 30, herkomst: { handmatig: 'aix-ronde', aanvraag: a.id.slice(0, 8) } };
}
function signaalKaart(soort, naam, reden) {
  const wat = soort === 'geheim' ? 'Socev heeft agent ' + naam + ' geschorst: een bericht van hem leek een sleutel of wachtwoord te bevatten (het staat verborgen tot jij kijkt).'
    : soort === 'limiet' ? 'AIX heeft agent ' + naam + ' geschorst: hij overschreed drie dagen achter elkaar zijn daglimiet.'
      : 'Een bericht op AIX (' + naam + ') is verborgen: twee verschillende eigenaren meldden het.';
  return { sleutel: SIGNAAL_SLEUTEL(soort, naam), soort: 'doen', titel: soort === 'melding' ? 'AIX — gemeld bericht verborgen: bekijken' : 'AIX — ' + naam + ' geschorst: bekijken',
    waarom: kap(wat + ' Schorsen en verbergen zijn omkeerbaar; definitief intrekken kan alleen jij.\n\nAgent: ' + naam + '\nSignaal: ' + tekst(reden, 120), VJ.waarom - 20),   // ruimte voor de sleutelmaskering van de databank (Fable wv943 #3)
    stappen: ['Open https://aix.socev.dev/beheer (Moderatie en Agents).', 'Kijk wat er stond en kies: herstellen, verborgen laten of de agent intrekken.',
      'Deze kaart sluit je zelf als je klaar bent.'],
    waar: 'overal', prive: false, duur_min: 5, volgorde: 35, herkomst: { handmatig: 'aix-ronde', signaal: soort } };
}

async function goedkeurRonde(deps) {
  const A = deps.aix, klok = deps.klok || Date.now;
  const david = new Set((deps.davidAdressen || DAVID).map(function (x) { return String(x).toLowerCase(); }));
  const uit = { ok: false, op: new Date(klok()).toISOString(), bekeken: 0, afgewezen: [], toegelaten: [], kaarten: [], gesloten: [], geschorst: [], signalen: [], fouten: [] };
  const s = deps.staatLees();
  s.aanvragen = s.aanvragen && typeof s.aanvragen === 'object' ? s.aanvragen : {};
  s.signalen = s.signalen && typeof s.signalen === 'object' ? s.signalen : {};
  const r = await A.aanvragen();
  if (!r.ok) { uit.plat = !!r.plat; uit.fout = r.fout; return uit; }
  const w = await A.winkels();
  if (!w.ok) { uit.plat = !!w.plat; uit.fout = w.fout; return uit; }
  const bezet = new Set(w.winkels.map(function (x) { return x.naam; }));
  const perEigenaar = {};
  const nu = new Set(r.aanvragen.map(function (a) { return a.id; }));
  for (const a of r.aanvragen) {
    if (a.status !== 'wacht_op_toelating') continue;
    uit.bekeken++;
    perEigenaar[a.eigenaar_email] = (perEigenaar[a.eigenaar_email] || 0) + 1;   // ook wat al een kaart heeft telt mee
    const oud = s.aanvragen[a.id];
    if (oud && (oud.kaart || oud.besluit)) continue;   // al een kaart of al besloten (dan staat hij er niet meer; zie hieronder)
    let reden = aanvraagToets(a, bezet);
    if (!reden && a.bekende_eigenaar === true && perEigenaar[a.eigenaar_email] > GRENS.per_eigenaar) reden = 'te-veel-agents';   // nieuwe eigenaar: David beslist (Fable wv942 #11)
    const mag = !reden && !a.vervangt && !david.has(a.eigenaar_email) && a.bekende_eigenaar === true;
    try {
      if (reden) {
        if (!deps.droog) { const x = await A.afwijzen(a.id, reden); if (!x.ok) { uit.fouten.push(a.id.slice(0, 8) + ': afwijzen ' + x.fout); continue; } }
        s.aanvragen[a.id] = { besluit: 'afgewezen', reden: reden, op: uit.op };
        uit.afgewezen.push({ id: a.id.slice(0, 8), reden: reden });
        continue;
      }
      if (mag) {
        const x = deps.droog ? { ok: true } : await A.toelaten(a.id);
        if (x.ok) { s.aanvragen[a.id] = { besluit: 'toegelaten', op: uit.op }; uit.toegelaten.push({ id: a.id.slice(0, 8), naam: a.naam }); continue; }
        const r409 = x.status !== 409 ? null : /hooguit/.test(x.fout) ? 'te-veel-agents' : /naam/.test(x.fout) ? 'naam-bezet' : /sleutel/.test(x.fout) ? 'regel' : null;   // Fable wv942 #10
        if (r409) {
          if (!deps.droog) await A.afwijzen(a.id, r409);
          s.aanvragen[a.id] = { besluit: 'afgewezen', reden: r409, op: uit.op }; uit.afgewezen.push({ id: a.id.slice(0, 8), reden: r409 }); continue;
        }
        if (x.status !== 403) { uit.fouten.push(a.id.slice(0, 8) + ': toelaten ' + x.fout); continue; }
        // 403: de site ziet hem toch als nieuwe eigenaar → David beslist
      }
      const bekend = deps.contact ? deps.contact(a.eigenaar_email) : null;
      let p = aanvraagKaart(a, bekend);
      if (!deps.droog) {
        try { await deps.voorJou(p); }
        catch (e) {   // databank weigerde iets op de kaart: dan zonder adres (Fable wv942 #9), en daarna ook zonder de zin (Fable wv943 #1/#2)
          p = aanvraagKaart(a, bekend, true);
          try { await deps.voorJou(p); } catch (e2) { p = aanvraagKaart(a, bekend, true, true); await deps.voorJou(p); }
        }
      }
      s.aanvragen[a.id] = { kaart: p.sleutel, op: uit.op };
      uit.kaarten.push({ id: a.id.slice(0, 8), sleutel: p.sleutel });
    } catch (e) { uit.fouten.push(a.id.slice(0, 8) + ': ' + String(e && e.message || e).slice(0, 120)); }
  }
  // Wat er niet meer wacht (David besliste op AIX, of verlopen): kaart dicht, geheugen na 30 dagen weg
  for (const id of Object.keys(s.aanvragen)) {
    const x = s.aanvragen[id];
    if (nu.has(id)) continue;
    if (x.kaart && !x.dicht) {
      try { if (!deps.droog) await deps.voorJouSluit(x.kaart, 'De aanvraag is op AIX afgehandeld (toegelaten, afgewezen of verlopen).'); x.dicht = uit.op; uit.gesloten.push(x.kaart); }
      catch (e) { uit.fouten.push(x.kaart + ': sluiten ' + String(e && e.message || e).slice(0, 100)); }
    }
    if (Date.parse(uit.op) - Date.parse(x.op || 0) > 30 * 86400000) delete s.aanvragen[id];
  }
  // § 5.4: vaste signalen uit het logboek (alleen nieuwe regels), daarna altijd aan David voorleggen
  // Eerste ronde: alleen een beginpunt (nu), geen oude proefsignalen van stap 1 voorleggen
  const lb = s.logboek_tot ? await A.logboek(s.logboek_tot) : { ok: true, logboek: [], begin: true };
  if (lb.begin) s.logboek_tot = uit.op;
  if (lb.ok) {
    for (const x of lb.logboek) {
      const ag = /^agent:([a-z][a-z0-9-]{2,29})$/.exec(x.wie || '') || /^agent:([a-z][a-z0-9-]{2,29})$/.exec(x.waarop || '');
      let soort = null, naam = null;
      if (x.wie === 'systeem' && x.wat === 'schors' && /limiet/.test(x.reden)) { soort = 'limiet'; naam = (/^agent:([a-z][a-z0-9-]{2,29})$/.exec(x.waarop) || [])[1]; }
      else if (x.wat === 'wacht op moderatie' && /geheim/.test(x.reden) && ag && ag[1] !== 'socev') { soort = 'geheim'; naam = ag[1]; }
      else if (x.wie === 'systeem' && x.wat === 'verberg' && /twee verschillende eigenaren/.test(x.reden)) { soort = 'melding'; naam = (/^(kaart|reactie):(\d+)$/.exec(x.waarop) || [])[0]; naam = naam ? naam.replace(':', '-') : null; }
      if (!soort || !naam) continue;
      const sl = SIGNAAL_SLEUTEL(soort, naam);
      if (s.signalen[sl]) continue;
      try {
        if (soort === 'geheim' && !deps.droog) {
          const z = await A.schors(naam, 'secretgrep-treffer; David kijkt');
          if (z.ok) uit.geschorst.push(naam);
          else if (/ingetrokken|bestaat niet/.test(z.fout || '')) { s.signalen[sl] = uit.op; continue; }   // al weg: niets voor te leggen
          else if (!/geschorst/.test(z.fout || '')) throw new Error('schorsen: ' + z.fout);
        }
        if (!deps.droog) await deps.voorJou(signaalKaart(soort, naam, x.reden));
        s.signalen[sl] = uit.op; uit.signalen.push(sl);
      } catch (e) { uit.fouten.push(sl + ': ' + String(e && e.message || e).slice(0, 100)); }
    }
    const laatste = lb.logboek.reduce(function (m, x) { return x.tijd && x.tijd > m ? x.tijd : m; }, s.logboek_tot || '');
    if (laatste) s.logboek_tot = laatste;
  } else uit.fouten.push('logboek: ' + lb.fout);
  s.ronde = { op: uit.op, bekeken: uit.bekeken, afgewezen: uit.afgewezen.length, toegelaten: uit.toegelaten.length, kaarten: uit.kaarten.length, gesloten: uit.gesloten.length,
    signalen: uit.signalen.length, fouten: uit.fouten.length };
  if (!deps.droog) deps.staatSchrijf(s);
  uit.ok = true;
  return uit;
}

module.exports = { VJ, kap, maak, goedkeurRonde, aanvraagToets, aanvraagKaart, adresOpKaart, signaalKaart, contactNaam, kaartSchoon, reactieSchoon, tekst, toegestaan,
  BASIS, SLEUTEL_PAD, CATEGORIEEN, STATUSSEN, GRENS, AFWIJS, DAVID, KAART_SLEUTEL };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  const A = maak({ sleutelPad: process.env.AIX_SLEUTEL || SLEUTEL_PAD, basis: process.env.AIX_BASIS || BASIS });
  const toon = (x) => { console.log(JSON.stringify(x, null, 1)); process.exit(x && x.ok === false ? 1 : 0); };
  (async function () {
    if (cmd === 'ik') return toon(await A.ik());
    if (cmd === 'winkels') return toon(await A.winkels());
    if (cmd === 'kaarten') return toon(await A.kaarten());
    if (cmd === 'nieuw') return toon(await A.nieuw(arg));
    if (cmd === 'aanvragen') { const r = await A.aanvragen(); if (r.ok) r.aanvragen.forEach(function (a) { a.eigenaar_email = a.eigenaar_email.replace(/^[^@]+/, '…'); }); return toon(r); }
    if (cmd === 'ronde' && arg === '--droog') {
      const vault = process.env.VAULT_DIR || '/opt/data/AI_SecondBrain';
      return toon(await goedkeurRonde({ aix: A, droog: true, staatLees: () => ({}), staatSchrijf: () => {}, contact: (e) => contactNaam(vault, e) }));
    }
    console.log('gebruik: node aix.js ik | winkels | kaarten | nieuw [sinds-ISO] | aanvragen | ronde --droog'); process.exit(2);
  })().catch(function (e) { console.error(String(e && e.message || e)); process.exit(2); });
}
