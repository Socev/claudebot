'use strict';
/**
 * personeelsscherm.js — OVIS Personeelsscherm fase 0 (wv2991, 13-11-2026).
 *
 * WAAROM. David (13-11 in de app): een Raspberry Pi aan de tv in de personeelskamer toont personeel.socev.dev; alleen dat kastje en hij
 * (Google-inlog) komen erin; de machinekamer onderhoudt het scherm. Plan: vault 01_Ontwikkeling "OVIS Personeelsscherm - plan (Fable 5.2,
 * 13-11-2026)"; ontwerp fase 0 met Codex-review: mk-scripts/personeelsscherm/ontwerp-fase0.md (machinekamer).
 *
 * WAT. Fase 0 toont ALLEEN dag, klok en een vaste proeftekst (geen persoonsgegevens, agenda of vrije tekst: dat is fase 1/2 met een
 * toestemmingsrij). Deze module:
 *  - bouwt het scherm (één HTML-bestand, alles inline) en zet het als ondertekende envelop (Ed25519 over de exacte bytes) in D1 `personeel`;
 *    de Worker (socev-app personeel/worker.ts) geeft hem door, het kastje controleert de handtekening en het volgnr (geen terugrol);
 *    elke 6 uur opnieuw getekend, houdbaar 36 uur; de noodknop tekent meteen een zwarte envelop met een hoger volgnr;
 *  - koppelen: David opent het venster in de app (stand.koppel_open_tot, 15 min), het kastje vraagt een code, David tikt hem in met zijn
 *    vingerafdruk (server.js eist die) → hier: koppelrij claimen (voorwaardelijk), service token `personeelsscherm-pi` maken (1 jaar),
 *    Access-beleid "alleen dit token EN alleen vanaf het adres waarmee het kastje de code vroeg" (review MOET 1), token versleutelen
 *    (RSA-OAEP-SHA256) voor de sleutel van het kastje, kastje_id/kastje_ip in D1. Het token komt niet in de kluis, een log of een bericht:
 *    de enige kopie staat op het kastje. Mislukt een stap na het aanmaken, dan gaat het token meteen weer weg;
 *  - intrekken: eerst kastje_id/kastje_ip uit D1 (de Worker weigert meteen), dan Access-beleid terug naar alleen David, dan het token weg;
 *    lukt een Cloudflare-stap niet, dan blijft `intrek_open` staan en probeert de tik het opnieuw;
 *  - tik (elke 5 min, alleen primair): schema, zo nodig opnieuw tekenen, hartslag en meldingen lezen; stilte tijdens werktijd > 30 min
 *    of een verzoek met het juiste token van een ander adres → één bericht aan de machinekamer (per dag / per voorval).
 *
 * VORM. Alleen fs, path en crypto. D1 via o.d1(batch) → [{results, meta}], Cloudflare-API via o.cf(methode, pad, body) → {status, j}
 * (server.js), berichten via o.melding(sleutel, tekst). Staat in <dir>/stand.json (0600), tekensleutel <dir>/geheim/teken-ed25519.pem
 * (0600, door de machinekamer gemaakt; ontbreekt hij, dan publiceert de module niets). Nooit een token, geheim, code of IP in een log of fout.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// zelfde lijst als D1_SCHEMA in socev-app personeel/worker.ts (toets vergelijkt ze)
const D1_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS stand (sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS envelop (id INTEGER PRIMARY KEY CHECK (id = 1), volgnr INTEGER NOT NULL, bytes TEXT NOT NULL, sig TEXT NOT NULL, op INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS hartslag (id INTEGER PRIMARY KEY CHECK (id = 1), op INTEGER NOT NULL, json TEXT NOT NULL, ip TEXT, land TEXT, kastje_id TEXT)",
  "CREATE TABLE IF NOT EXISTS hartslag_dag (dag TEXT PRIMARY KEY, aantal INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS koppel (code_hash TEXT PRIMARY KEY, poll_hash TEXT NOT NULL, pub TEXT NOT NULL, pub_fp TEXT NOT NULL, gemaakt INTEGER NOT NULL, verloopt INTEGER NOT NULL, pogingen INTEGER NOT NULL DEFAULT 0, gebruikt INTEGER NOT NULL DEFAULT 0, cipher TEXT, land TEXT, ip TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS grens (sleutel TEXT PRIMARY KEY, aantal INTEGER NOT NULL, tot INTEGER NOT NULL)",
];
const UUR = 3600000;
const HOUDBAAR_MS = 36 * UUR;
const OPNIEUW_MS = 6 * UUR;
const VENSTER_MS = 15 * 60000;
const NA_INTIKKEN_MS = 10 * 60000;
const FOUT_MAX = 5, FOUT_VENSTER = 30 * 60000;
const STIL_MS = 30 * 60000;
const TOKEN_NAAM = 'personeelsscherm-pi';
const TOKEN_DUUR = '8760h';
const HOST = 'personeel.socev.dev';

function iso(ms) { return new Date(ms).toISOString(); }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Amsterdamse tijd zonder Intl-afhankelijkheid van de pod-locale
function amsDelen(ms) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' });
  const d = {}; for (const p of f.formatToParts(new Date(ms))) d[p.type] = p.value;
  return { dag: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(d.weekday), uur: Number(d.hour), min: Number(d.minute), datum: `${d.year}-${d.month}-${d.day}` };
}
// werktijd: ma–vr 07:30–18:00 (Amsterdam)
function inWerktijd(ms) { const a = amsDelen(ms); const m = a.uur * 60 + a.min; return a.dag >= 0 && a.dag <= 4 && m >= 450 && m < 1080; }

// ── het scherm (fase 0) ──
// Vast doek van 1920×1080 in px (zo klopt ook het voorbeeld in de app, die het doek zelf schaalt en geen script draait); op het kastje
// schaalt een regel script het doek naar het venster. Klok en dag lopen op het kastje zelf (inline script, CSP laat niets anders toe).
// houdbaar_tot staat erin: de pagina zelf valt terug op "wordt bijgewerkt" als de wandklok voorbij is (extra slot; het kastje beslist
// op zijn monotone klok, ontwerp review MOET 2). Leeg = zwart met een kleine klok.
function bouwHtml({ gemaakt, houdbaar_tot, leeg, logoSvg }) {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; connect-src 'none'";
  const klokScript = `(function(){var T=${Number(houdbaar_tot)};var D=['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'],M=['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
function z(n){return(n<10?'0':'')+n}function s(){var e=document.getElementById('doek');if(e){var f=Math.min(innerWidth/1920,innerHeight/1080);e.style.transform='scale('+f+')';}}s();addEventListener('resize',s);
function t(){var n=new Date();var k=document.getElementById('klok'),d=document.getElementById('dag');if(k)k.textContent=z(n.getHours())+':'+z(n.getMinutes());if(d)d.textContent=D[n.getDay()]+' '+n.getDate()+' '+M[n.getMonth()];
if(n.getTime()>T){document.body.className='oud';}}t();setInterval(t,1000);})();`;
  if (leeg) {
    return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta http-equiv="refresh" content="60"><title>Personeelsscherm</title>
<style>html,body{margin:0;height:100%;background:#000;color:#444;font-family:'Liberation Sans',Arial,Helvetica,sans-serif;overflow:hidden}#doek{position:relative;width:1920px;height:1080px;transform-origin:0 0;background:#000}#klok{position:absolute;right:38px;bottom:38px;font-size:46px}#dag{display:none}</style></head>
<body data-soort="leeg" data-gemaakt="${Number(gemaakt)}"><div id="doek"><div id="klok"></div><div id="dag"></div></div><script>${klokScript}</script></body></html>`;
  }
  const logo = logoSvg ? `<img class="logo" alt="Huisartsenpraktijk Tolgaarde" src="data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}">` : '<div class="naam">Huisartsenpraktijk Tolgaarde</div>';
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta http-equiv="refresh" content="60"><title>Personeelsscherm</title>
<style>
html,body{margin:0;height:100%;background:#fff;color:#5B5C60;font-family:'Liberation Sans',Arial,Helvetica,sans-serif;overflow:hidden}
#doek{position:relative;width:1920px;height:1080px;transform-origin:0 0;background:#fff;overflow:hidden}
.rand{position:absolute;left:0;top:0;bottom:0;width:653px;border-right:8px solid #ED1C24;display:flex;flex-direction:column;justify-content:space-between;padding:58px;box-sizing:border-box}
.logo{width:460px;height:auto}.naam{font-size:42px;font-weight:bold}
#dag{font-size:61px;font-weight:bold;line-height:1.2}#klok{font-size:173px;font-weight:bold;letter-spacing:-4px;color:#3a3b3e;line-height:1}
.podium{position:absolute;left:653px;right:0;top:0;bottom:0;padding:96px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center}
h1{font-size:77px;margin:0 0 38px;color:#3a3b3e}p{font-size:44px;line-height:1.45;margin:0 0 27px;max-width:1000px}.zacht{color:#88898C;font-size:29px}
.oud-tekst{display:none}body.oud .podium>*{display:none}body.oud .podium .oud-tekst{display:block}
</style></head>
<body data-soort="scherm" data-gemaakt="${Number(gemaakt)}" data-houdbaar="${Number(houdbaar_tot)}">
<div id="doek"><div class="rand">${logo}<div><div id="dag"></div><div id="klok"></div></div></div>
<div class="podium"><h1>Personeelsscherm</h1><p>Dit scherm wordt ingericht. Binnenkort staan hier de komende afspraken, het weer, wie er vandaag werkt en wie er jarig is.</p>
<p class="zacht">Proefscherm, bijgewerkt ${esc(amsTekst(gemaakt))}</p><p class="oud-tekst">Dit scherm wordt bijgewerkt.</p></div></div>
<script>${klokScript}</script></body></html>`;
}
function amsTekst(ms) {
  const a = amsDelen(ms); const [j, m, d] = a.datum.split('-');
  return `${Number(d)}-${Number(m)}-${j} ${String(a.uur).padStart(2, '0')}:${String(a.min).padStart(2, '0')}`;
}

function maak(o) {
  const dir = o.dir;
  const nu = o.nu || Date.now;
  const fout = o.fout || function () {};
  const melding = o.melding || async function () {};
  const standPad = path.join(dir, 'stand.json');
  const sleutelPad = path.join(dir, 'geheim', 'teken-ed25519.pem');
  const configPad = path.join(dir, 'config.json');   // {account, access_app_id, access_app (zonder beleid), eigenaar} — door de machinekamer
  let schemaKlaar = false;

  function leesStand() { try { return JSON.parse(fs.readFileSync(standPad, 'utf8')); } catch (e) { return {}; } }
  function schrijfStand(s) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = standPad + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, standPad);
  }
  function wijzig(f) { const s = leesStand(); f(s); schrijfStand(s); return s; }
  function config() { try { return JSON.parse(fs.readFileSync(configPad, 'utf8')); } catch (e) { return null; } }
  function sleutel() { try { return crypto.createPrivateKey(fs.readFileSync(sleutelPad)); } catch (e) { return null; } }
  function logoSvg() {
    if (!o.vault) return null;
    try { const s = fs.readFileSync(path.join(o.vault, '.claude/skills/tolgaarde-brand-communication/assets/huisstijl-v1/Tolgaarde_horizontaal.svg'), 'utf8'); return /^<svg[\s>]/.test(s.trim()) && !/<script|on\w+=|href=/i.test(s) ? s : null; } catch (e) { return null; }
  }

  async function d1(batch) {
    const r = await o.d1(batch);
    if (!Array.isArray(r) || r.length !== batch.length) throw new Error('D1 gaf een onverwacht antwoord');
    return r;
  }
  async function zorgSchema() { if (!schemaKlaar) { await d1(D1_SCHEMA.map((sql) => ({ sql, params: [] }))); schemaKlaar = true; } }
  async function cf(methode, pad, body) {
    const r = await o.cf(methode, pad, body);
    if (!r || r.status < 200 || r.status >= 300 || !r.j || r.j.success !== true) {
      const code = r && r.j && Array.isArray(r.j.errors) && r.j.errors[0] ? r.j.errors[0].code : '';
      const e = new Error('Cloudflare gaf HTTP ' + (r ? r.status : '?') + (code ? ' (' + code + ')' : ''));
      e.status = r ? r.status : 0; e.cfCode = code; throw e;
    }
    return r.j.result;
  }

  // ── envelop ──
  function envelop(s, t, leeg) {
    const volgnr = Math.max(Number(s.volgnr || 0) + 1, t);
    const doc = { v: 1, soort: 'scherm', volgnr, gemaakt: t, houdbaar_tot: t + HOUDBAAR_MS, leeg: !!leeg,
      html: bouwHtml({ gemaakt: t, houdbaar_tot: t + HOUDBAAR_MS, leeg: !!leeg, logoSvg: leeg ? null : logoSvg() }),
      instellingen: { ophaal_s: 120 }, code: null };
    const bytes = Buffer.from(JSON.stringify(doc), 'utf8');
    return { doc, bytes };
  }
  async function publiceer(leeg) {
    const k = sleutel();
    if (!k) throw new Error('geen tekensleutel');
    await zorgSchema();
    const s = leesStand(), t = nu();
    const aan = leeg === undefined ? !!s.leeg : !!leeg;
    const { doc, bytes } = envelop(s, t, aan);
    if (bytes.length > 900 * 1024) throw new Error('scherm te groot');
    const sig = crypto.sign(null, bytes, k);
    await d1([{ sql: 'INSERT INTO envelop (id, volgnr, bytes, sig, op) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET volgnr = excluded.volgnr, bytes = excluded.bytes, sig = excluded.sig, op = excluded.op WHERE excluded.volgnr > envelop.volgnr',
      params: [doc.volgnr, bytes.toString('base64'), sig.toString('base64'), t] }]);
    wijzig((x) => { x.volgnr = doc.volgnr; x.gemaakt = t; x.houdbaar_tot = doc.houdbaar_tot; x.leeg = aan; x.html = doc.html; x.fout = null; });
    return doc;
  }

  // ── Access ──
  function appBody(c, token) {
    const pol = [{ name: 'Eigenaar (Google of code per mail)', decision: 'allow', precedence: 1, include: [{ email: { email: c.eigenaar } }] }];
    if (token) pol.push({ name: 'Alleen het kastje ' + TOKEN_NAAM + ' vanaf het praktijkadres', decision: 'non_identity', precedence: 2,
      include: [{ service_token: { token_id: token.id } }], require: [{ ip: { ip: token.ip + '/32' } }] });
    return Object.assign({}, c.access_app, { policies: pol });
  }
  async function zetBeleid(c, token) { await cf('PUT', '/accounts/' + c.account + '/access/apps/' + c.access_app_id, appBody(c, token)); }
  async function tokenWeg(c, id) {
    try { await cf('DELETE', '/accounts/' + c.account + '/access/service_tokens/' + id); }
    catch (e) { if (e.status !== 404 && e.cfCode !== 12135) throw e; }   // al weg = goed
  }

  // ── app-handelingen (server.js doet sessie, vingerafdruk en grenzen) ──
  async function open() {
    await zorgSchema();
    const tot = nu() + VENSTER_MS;
    await d1([{ sql: "INSERT INTO stand (sleutel, waarde) VALUES ('koppel_open_tot', ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde", params: [String(tot)] }]);
    wijzig((x) => { x.koppel_open_tot = tot; });
    return { status: 200, body: { ok: true, koppel_open_tot: tot } };
  }

  let bezig = false;   // één koppeling of intrekking tegelijk
  async function koppel(codeRuw) {
    const code = String(codeRuw == null ? '' : codeRuw).replace(/[\s-]/g, '');
    if (!/^\d{8}$/.test(code)) return { status: 400, body: { ok: false, fout: 'De code bestaat uit 8 cijfers.' } };
    const c = config();
    if (!c || !c.account || !c.access_app_id || !c.access_app || !c.eigenaar) return { status: 503, body: { ok: false, fout: 'Het personeelsscherm is nog niet ingericht; meld het de machinekamer.' } };
    const t0 = nu();
    const s0 = leesStand();
    const fouten = (s0.foutcodes || []).filter((x) => x > t0 - FOUT_VENSTER);
    if (fouten.length >= FOUT_MAX) return { status: 429, body: { ok: false, fout: 'Te vaak een verkeerde code. Probeer het over een half uur opnieuw.' } };
    if (bezig) return { status: 409, body: { ok: false, fout: 'Er loopt al een koppeling; wacht even.' } };
    bezig = true;
    try {
      await zorgSchema();
      const ch = crypto.createHash('sha256').update('code:' + code).digest('hex');
      const r = await d1([{ sql: 'UPDATE koppel SET gebruikt = 1, verloopt = ? WHERE code_hash = ? AND gebruikt = 0 AND verloopt > ? RETURNING pub, ip, gemaakt', params: [t0 + NA_INTIKKEN_MS, ch, t0] }]);
      const rij = r[0] && r[0].results && r[0].results[0];
      if (!rij) {
        wijzig((x) => { x.foutcodes = (x.foutcodes || []).filter((y) => y > t0 - FOUT_VENSTER).concat([t0]); });
        return { status: 404, body: { ok: false, fout: 'Deze code ken ik niet of hij is verlopen. Kijk op de tv of er een nieuwe code staat.' } };
      }
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(rij.ip || ''))) return { status: 409, body: { ok: false, fout: 'Het kastje vroeg de code niet via een gewoon internetadres aan; meld het de machinekamer.' } };
      let pub;
      try { pub = crypto.createPublicKey(String(rij.pub)); if (pub.asymmetricKeyType !== 'rsa' || pub.asymmetricKeyDetails.modulusLength !== 3072) throw new Error('x'); }
      catch (e) { return { status: 409, body: { ok: false, fout: 'De sleutel van het kastje klopt niet; zet het kastje uit en aan voor een nieuwe code.' } }; }
      // een vorig kastje gaat eerst helemaal dicht
      if (s0.token || s0.intrek_open) await intrekIntern(c);
      const tk = await cf('POST', '/accounts/' + c.account + '/access/service_tokens', { name: TOKEN_NAAM, duration: TOKEN_DUUR });
      const token = { id: tk.id, client_id: tk.client_id, ip: String(rij.ip), aangemaakt: t0, verloopt: tk.expires_at ? Date.parse(tk.expires_at) : t0 + 365 * 24 * UUR };
      let geheim = tk.client_secret; tk.client_secret = undefined;
      try {
        if (!token.id || !/^[a-z0-9]{20,64}\.access$/.test(String(token.client_id || '')) || !/^[a-f0-9]{32,128}$/.test(String(geheim || ''))) throw new Error('onverwacht token');
        await zetBeleid(c, token);
        const cipher = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          Buffer.from(JSON.stringify({ client_id: token.client_id, client_secret: geheim }), 'utf8')).toString('base64');
        geheim = null;
        await d1([
          { sql: 'UPDATE koppel SET cipher = ? WHERE code_hash = ? AND gebruikt = 1', params: [cipher, ch] },
          { sql: "INSERT INTO stand (sleutel, waarde) VALUES ('kastje_id', ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde", params: [token.client_id] },
          { sql: "INSERT INTO stand (sleutel, waarde) VALUES ('kastje_ip', ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde", params: [token.ip] },
          { sql: "DELETE FROM stand WHERE sleutel IN ('koppel_open_tot', 'vreemd')", params: [] },
        ]);
      } catch (e) {
        geheim = null;
        try { await zetBeleid(c, null); } catch (e2) { fout('personeelsscherm-koppel', new Error('beleid terugzetten faalde')); }
        try { await tokenWeg(c, token.id); } catch (e2) { wijzig((x) => { x.intrek_open = { id: token.id }; }); }
        fout('personeelsscherm-koppel', new Error('koppelen faalde: ' + String(e && e.message).slice(0, 80)));
        return { status: 503, body: { ok: false, fout: 'Koppelen lukte niet; er is niets blijven staan. Probeer het zo opnieuw.' } };
      }
      wijzig((x) => { x.token = { id: token.id, client_id: token.client_id, ip_eis: true, aangemaakt: token.aangemaakt, verloopt: token.verloopt };   // het adres zelf staat alleen in D1 en het Access-beleid
        x.koppel_open_tot = null; x.vreemd = null; x.foutcodes = []; x.gekoppeld_op = t0; x.stil_gemeld = null; });
      try { await melding('personeelsscherm-koppel:' + token.id, 'Personeelsscherm: kastje gekoppeld (' + iso(t0).slice(0, 16) + ' UTC). Sleutel ' + TOKEN_NAAM + ' (id ' + token.id + ') verloopt ' + iso(token.verloopt).slice(0, 10) + ', werkt alleen vanaf het adres waarmee de code werd aangevraagd. Zet de rij in het sleutelregister.'); } catch (e) { fout('personeelsscherm-melding', e); }
      try { if (!leesStand().gemaakt) await publiceer(); } catch (e) { fout('personeelsscherm-publiceer', e); }
      return { status: 200, body: { ok: true, gekoppeld: true } };
    } finally { bezig = false; }
  }

  async function intrekIntern(c) {
    const s = leesStand();
    // 1. de Worker weigert meteen
    await d1([{ sql: "DELETE FROM stand WHERE sleutel IN ('kastje_id', 'kastje_ip')", params: [] }]);
    wijzig((x) => { x.intrek_open = x.intrek_open || (x.token ? { id: x.token.id } : null); x.token = null; });
    // 2. Access terug naar alleen de eigenaar, 3. token weg
    await zetBeleid(c, null);
    const id = (s.token && s.token.id) || (s.intrek_open && s.intrek_open.id);
    if (id) await tokenWeg(c, id);
    wijzig((x) => { x.intrek_open = null; x.ingetrokken_op = nu(); });
  }
  async function intrek() {
    const c = config();
    if (!c) return { status: 503, body: { ok: false, fout: 'Het personeelsscherm is nog niet ingericht.' } };
    if (bezig) return { status: 409, body: { ok: false, fout: 'Er loopt al een koppeling; wacht even.' } };
    bezig = true;
    try {
      await zorgSchema();
      const id = (leesStand().token || {}).id;
      await intrekIntern(c);
      try { await melding('personeelsscherm-intrek:' + (id || nu()), 'Personeelsscherm: sleutel ' + TOKEN_NAAM + (id ? ' (id ' + id + ')' : '') + ' ingetrokken via de app. Zet de rij in het sleutelregister op ingetrokken.'); } catch (e) { fout('personeelsscherm-melding', e); }
      return { status: 200, body: { ok: true } };
    } catch (e) {
      fout('personeelsscherm-intrek', new Error('intrekken: ' + String(e && e.message).slice(0, 80)));
      // stap 1 (D1) gaat vóór alles: is die gelukt, dan is het kastje al dicht; de tik maakt de rest af
      return { status: 503, body: { ok: false, fout: 'Het kastje kan niets meer ophalen als dat deel lukte; de rest probeer ik elke 5 minuten opnieuw.', open: true } };
    } finally { bezig = false; }
  }
  async function leeg(aan) {
    wijzig((x) => { x.leeg = !!aan; });
    const doc = await publiceer(!!aan);
    return { status: 200, body: { ok: true, leeg: doc.leeg } };
  }

  // ── lezen ──
  async function leesD1() {
    await zorgSchema();
    const r = await d1([
      { sql: 'SELECT op, json, land FROM hartslag WHERE id = 1', params: [] },
      { sql: "SELECT sleutel, waarde FROM stand WHERE sleutel IN ('vreemd', 'koppel_open_tot', 'kastje_id')", params: [] },
      { sql: 'SELECT gemaakt, land, gebruikt FROM koppel WHERE verloopt > ? ORDER BY gemaakt', params: [nu()] },
    ]);
    const h = r[0].results[0] || null, st = {};
    for (const x of r[1].results) st[x.sleutel] = x.waarde;
    let hs = null; try { hs = h ? JSON.parse(h.json) : null; } catch (e) { hs = null; }
    let vreemd = null; try { vreemd = st.vreemd ? JSON.parse(st.vreemd) : null; } catch (e) { vreemd = null; }
    return { hartslag: h ? { op: Number(h.op), land: String(h.land || ''), velden: hs } : null, vreemd, koppel_open_tot: st.koppel_open_tot ? Number(st.koppel_open_tot) : null,
      kastje_in_d1: !!st.kastje_id, codes: r[2].results.map((x) => ({ gemaakt: Number(x.gemaakt), land: String(x.land || ''), ingetikt: Number(x.gebruikt) === 1 })) };
  }
  async function appStand() {
    let live = null, ffout = null;
    try { live = await leesD1(); } catch (e) { ffout = 'De stand van het kastje is nu niet te lezen.'; }
    const s = leesStand();
    if (live) wijzig((x) => { x.hartslag = live.hartslag; x.vreemd = live.vreemd; });
    const h = live ? live.hartslag : s.hartslag;
    const vel = (h && h.velden) || null;
    return {
      ok: true,
      stand: {
        gekoppeld: !!s.token,
        laatst_gezien: h ? h.op : null,
        kastje: vel ? Object.assign({}, vel, { land: h.land }) : null,
        vreemd: live ? live.vreemd : (s.vreemd || null),
        koppel_open_tot: live ? live.koppel_open_tot : (s.koppel_open_tot || null),
        codes: live ? live.codes : [],
        leeg: !!s.leeg,
        scherm: s.volgnr ? { volgnr: s.volgnr, gemaakt: s.gemaakt, houdbaar_tot: s.houdbaar_tot } : null,
        token: s.token ? { aangemaakt: s.token.aangemaakt, verloopt: s.token.verloopt, ip_eis: !!s.token.ip_eis } : null,
        fout: ffout || s.fout || (s.intrek_open ? 'Intrekken is nog niet helemaal klaar; ik probeer het opnieuw.' : null),
      },
      voorbeeld_html: s.html || '',
    };
  }

  async function app({ pad, methode, body }) {
    if (methode === 'GET' && pad === '/app/personeelsscherm') return { status: 200, body: await appStand() };
    if (methode === 'POST' && pad === '/app/personeelsscherm/open') return open();
    if (methode === 'POST' && pad === '/app/personeelsscherm/koppel') return koppel(body && body.code);
    if (methode === 'POST' && pad === '/app/personeelsscherm/intrek') return intrek();
    if (methode === 'POST' && pad === '/app/personeelsscherm/leeg') return leeg(!!(body && body.aan === true));
    return { status: 404, body: { ok: false, fout: 'onbekend' } };
  }

  // ── tik (elke 5 min) ──
  async function tik() {
    if (!sleutel() || !config()) return { overgeslagen: true };
    let s = leesStand();
    const t = nu();
    if (s.intrek_open) { try { await intrekIntern(config()); } catch (e) { fout('personeelsscherm-intrek', new Error('opnieuw intrekken faalde')); } }
    if (!s.gemaakt || t - s.gemaakt > OPNIEUW_MS || !s.houdbaar_tot) {
      try { await publiceer(); } catch (e) { wijzig((x) => { x.fout = 'Het scherm kon niet worden bijgewerkt.'; }); fout('personeelsscherm-publiceer', new Error(String(e && e.message).slice(0, 80))); }
    }
    let live;
    try { live = await leesD1(); } catch (e) { fout('personeelsscherm-lees', new Error('D1 lezen faalde')); return { ok: false }; }
    s = wijzig((x) => { x.hartslag = live.hartslag; x.vreemd = live.vreemd; x.laatste_tik = t; });
    // meldingen: nooit vaker dan één keer per voorval of per dag
    if (live.vreemd && live.vreemd.op && s.vreemd_gemeld !== live.vreemd.op) {
      wijzig((x) => { x.vreemd_gemeld = live.vreemd.op; });
      try { await melding('personeelsscherm-vreemd:' + live.vreemd.op, 'Personeelsscherm: de sleutel van het kastje werd ' + iso(live.vreemd.op).slice(0, 16) + ' UTC gebruikt vanaf een ander internetadres (land ' + (live.vreemd.land || '?') + ') en geweigerd. Mogelijk een gestolen kaart of een nieuw adres van de praktijk: David kan in Apps › Personeelsscherm de sleutel intrekken.', true); } catch (e) { fout('personeelsscherm-melding', e); }
    }
    if (s.token && s.gekoppeld_op && t - s.gekoppeld_op > STIL_MS && inWerktijd(t)) {
      const laatst = live.hartslag ? live.hartslag.op : 0;
      const dag = amsDelen(t).datum;
      if (t - laatst > STIL_MS && s.stil_gemeld !== dag) {
        wijzig((x) => { x.stil_gemeld = dag; });
        try { await melding('personeelsscherm-stil:' + dag, 'Personeelsscherm: het kastje meldde zich ' + (laatst ? 'sinds ' + iso(laatst).slice(0, 16) + ' UTC' : 'nog nooit') + ' niet meer (werktijd). Stroom, kabel of internet van de praktijk?'); } catch (e) { fout('personeelsscherm-melding', e); }
      }
    }
    return { ok: true };
  }

  function info() {
    const s = leesStand(), c = config();
    return { aan: true, ingericht: !!c && !!sleutel(), gekoppeld: !!s.token, laatst_gezien: s.hartslag ? iso(s.hartslag.op) : null,
      stil_min: s.hartslag ? Math.round((nu() - s.hartslag.op) / 60000) : null, temp_c: s.hartslag && s.hartslag.velden ? s.hartslag.velden.temp_c : null,
      getoond: s.hartslag && s.hartslag.velden ? s.hartslag.velden.getoond || null : null, leeg: !!s.leeg, volgnr: s.volgnr || null,
      houdbaar_tot: s.houdbaar_tot ? iso(s.houdbaar_tot) : null, token_verloopt: s.token ? iso(s.token.verloopt).slice(0, 10) : null,
      vreemd: s.vreemd ? iso(s.vreemd.op) : null, intrek_open: !!s.intrek_open, laatste_tik: s.laatste_tik ? iso(s.laatste_tik) : null, fout: s.fout || null };
  }

  return { app, tik, info, publiceer, open, koppel, intrek, leeg, leesD1, appStand };
}

module.exports = { maak, bouwHtml, D1_SCHEMA, inWerktijd, HOUDBAAR_MS, OPNIEUW_MS, TOKEN_NAAM, HOST };
