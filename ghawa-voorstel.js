'use strict';
// ── OVIS GHAWA: voorstellen uit WhatsApp (wv3920, besluitenpagina nr 137 = 2C37, David Ja 22-11-2026 18:24) ──
// WAAROM. Het nieuws over de bouw in Sukuta komt via WhatsApp binnen (Momodou 1-op-1 en de groep GHAWA + ECG, op de volglijst sinds 21-11),
// maar de app bewoog niet mee: David moest alles zelf overtikken. Nu leest de nachtskill whatsapp-conversatie-consolidatie (05:45, Socev)
// die twee chats als "GHAWA-lens" en zet per bericht hooguit één voorstel klaar: een bon bij een betaling (Te boeken), een antwoord op een
// open vraag, een gehaalde mijlpaal of een nieuwsbericht voor de proefsite. Niets gaat zonder Davids Ja de administratie of de site in;
// elk Ja is terug te draaien. Ontwerp + Codex-review: mk-scripts/wv3920/ontwerp.md.
// Alles hier is synchroon op een open databank (ghawa.js schrijf()); het nieuwsbericht zelf (git, async) doet server.js.
// Nooit citaten, namen of bedragen in een fout of log: alleen id's.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SOORTEN = ['bon', 'antwoord', 'mijlpaal', 'nieuws'];
const CHATS = { momodou: 'Momodou (1-op-1)', 'ghawa-ecg': 'groep GHAWA + ECG' };
const MAX_OPEN = 30, VERVAL_DAGEN = 30, BIJLAGE_MAX = 10 * 1024 * 1024, MAX_FOTOS = 4;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS voorstel (id TEXT PRIMARY KEY, sleutel TEXT NOT NULL UNIQUE, soort TEXT NOT NULL, staat TEXT NOT NULL DEFAULT 'open',
  gegevens TEXT NOT NULL, bron TEXT NOT NULL, citaat TEXT, bijlagen TEXT, gemaakt_op TEXT NOT NULL, besluit_op TEXT, door TEXT, effect TEXT);
CREATE TABLE IF NOT EXISTS voorstel_log (nr INTEGER PRIMARY KEY, voorstel TEXT NOT NULL, actie TEXT NOT NULL, op TEXT NOT NULL, door TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS mijlpaal_bevestigd (sleutel TEXT PRIMARY KEY, gehaald_op TEXT NOT NULL, voorstel TEXT, op TEXT NOT NULL);
`;
const schoon = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, n);
const regel1 = (s, n) => schoon(s, n * 2).replace(/\s+/g, ' ').slice(0, n);
function vandaagNl(nu) { return new Date(nu || Date.now()).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
// Codex r1 MOET 2: alleen een echte kalenderdatum tussen 2024-01-01 en vandaag (Nederlandse tijd)
function datumOk(s, nu) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== s) return false;
  return s >= '2024-01-01' && s <= vandaagNl(nu);
}
const dagVerschil = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86400000);
function heeft(db, t) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t); }
function log(db, id, actie, nu, door, detail) {
  db.prepare('INSERT INTO voorstel_log (voorstel, actie, op, door, detail) VALUES (?,?,?,?,?)').run(id, actie, nu, schoon(door, 40) || null, detail == null ? null : JSON.stringify(detail));
}
function volgendId(db) {
  const r = db.prepare("SELECT id FROM voorstel WHERE id LIKE 'V%'").all().map((x) => Number(String(x.id).slice(1))).filter(Number.isSafeInteger);
  return 'V' + String((r.length ? Math.max.apply(null, r) : 0) + 1).padStart(3, '0');
}

// Een bijlage uit de WhatsApp-media van de vault meteen naar de eigen map kopiëren (de nachtskill wist de originelen na het duiden).
// Alleen paden onder <vault>/30_Conversaties/WhatsApp/Media (na realpath), alleen jpg/png/webp/heic/pdf op de eerste bytes, hooguit 10 MB.
function bijlageType(by) {
  const h = (n) => by.subarray(0, n).toString('hex');
  if (h(3) === 'ffd8ff') return 'jpg';
  if (h(8) === '89504e470d0a1a0a') return 'png';
  if (by.subarray(0, 4).toString('latin1') === 'RIFF' && by.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (by.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (by.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|mif1|msf1|hevc)$/.test(by.subarray(8, 12).toString('latin1'))) return 'heic';
  return null;
}
function bijlageKopie(vault, map, rel, alleenFoto) {
  if (typeof rel !== 'string' || !rel || rel.length > 400 || rel.indexOf('\0') >= 0) return { fout: 'bijlage: ongeldig pad' };
  let echt, basis;
  try { basis = fs.realpathSync(path.join(vault, '30_Conversaties', 'WhatsApp', 'Media')); echt = fs.realpathSync(path.join(vault, rel.replace(/^\/+/, ''))); }
  catch (e) { return { fout: 'bijlage: bestand niet gevonden' }; }
  if (echt.indexOf(basis + path.sep) !== 0) return { fout: 'bijlage: alleen uit de WhatsApp-media' };
  const st = fs.statSync(echt);
  if (!st.isFile() || st.size === 0 || st.size > BIJLAGE_MAX) return { fout: 'bijlage: leeg of groter dan 10 MB' };
  const by = fs.readFileSync(echt);
  const t = bijlageType(by);
  if (!t || (alleenFoto && t === 'pdf')) return { fout: alleenFoto ? 'bijlage: alleen een foto' : 'bijlage: alleen een foto of pdf' };
  const naam = crypto.createHash('sha256').update(by).digest('hex').slice(0, 16) + '.' + t;
  fs.mkdirSync(map, { recursive: true, mode: 0o700 });
  const doel = path.join(map, naam);
  if (!fs.existsSync(doel)) fs.writeFileSync(doel, by, { mode: 0o600, flag: 'wx' });
  return { naam };
}
function bijlageLees(map, naam) {
  if (!/^[0-9a-f]{16}\.(jpg|png|webp|heic|pdf)$/.test(String(naam || ''))) return null;
  try { return fs.readFileSync(path.join(map, naam)); } catch (e) { return null; }
}

// Wat de lens nodig heeft om een bericht te koppelen (Socev-sleutel; geen GHAWA-bank, geen donateurs, geen ECG-rekeningnummers).
// ctx: { tb: teBoekenRoute-uitkomst, vragen: open_vraag-rijen, mijlpalen: [{sleutel, wanneer, tekst, stand}] }
function lens(ctx) {
  const open = /^(open|partly)/i;
  return {
    ok: true,
    chats: Object.keys(CHATS),
    vragen: (ctx.vragen || []).filter((v) => open.test(v.status || 'Open')).map((v) => ({ id: v.id, onderwerp: regel1(v.onderwerp, 80), vraag: regel1(v.vraag, 300), gmd: v.gmd_cent || null, stand: v.status })),
    te_boeken: ((ctx.tb && ctx.tb.open) || []).map((b) => ({ id: b.id, datum: b.datum, soort: b.soort, cheque: b.cheque, doel: b.doel, gmd_cent: b.bedrag, regel: b.voorstel ? b.voorstel.regel : null })),
    geboekt: ((ctx.tb && ctx.tb.geboekt) || []).slice(0, 30).map((b) => ({ id: b.id, datum: b.datum, cheque: b.cheque, gmd_cent: b.bedrag, heeft_bon: !!b.bon })),
    regels: ((ctx.tb && ctx.tb.regels) || []).map((r) => ({ id: r.id, post: regel1(r.post, 80), activiteit: regel1(r.act_naam, 80), project: r.project })),
    mijlpalen: (ctx.mijlpalen || []).map((m) => ({ sleutel: m.sleutel, wanneer: m.wanneer, tekst: regel1(m.tekst, 160), stand: m.stand })),
    regels_lens: 'Hooguit één voorstel per bericht, alleen bij een bon/factuur van de bouw, een antwoord op een vraag uit deze lijst, een mijlpaal uit deze lijst die gehaald is, of bouwnieuws met foto voor ghawa.org. Niets uit berichten over iemands gezondheid of over geld voor een privépersoon. Twijfel = geen voorstel.',
  };
}

// Bon ↔ betaling: precies dezelfde GMD (Codex r1 MOET 1), betaling 0–30 dagen vóór of hooguit 7 dagen ná de bondatum.
function bonKoppel(g, tb) {
  const binnen = (b) => { const v = dagVerschil(g.datum, b.datum); return v >= -7 && v <= 30; };
  const zoek = (lijst, geboekt) => (lijst || []).filter((b) => b.bedrag === g.gmd_cent && binnen(b)).map((b) => ({ b, geboekt }));
  if (g.bankregel) {
    const o = ((tb && tb.open) || []).find((b) => b.id === g.bankregel), k = ((tb && tb.geboekt) || []).find((b) => b.id === g.bankregel);
    const b = o || k;
    if (!b) return { geen: 'die betaling staat niet op Te boeken' };
    if (b.bedrag !== g.gmd_cent) return { geen: 'het bedrag van de bon is niet gelijk aan dat van de betaling' };
    if (!binnen(b)) return { geen: 'de datum van de bon past niet bij die betaling' };
    return { b, geboekt: !o };
  }
  const t = zoek(tb && tb.open, false).concat(zoek(tb && tb.geboekt, true));
  if (t.length === 1) return t[0];
  return { geen: t.length ? 'meer dan één betaling met dit bedrag; kies op Te boeken' : 'geen betaling met precies dit bedrag op Te boeken' };
}

// POST /smal/ghawa/voorstel. inp: { soort, chat, tijd (ISO, NL-tijd mag), afzender, citaat, ...per soort }. ctx: { tb, vragen, mijlpalen,
// vault, map, nu }. → { status, ok, id, nieuw }
function zet(db, inp, ctx) {
  const nu = ctx.nu || new Date().toISOString();
  const f = (fout) => ({ status: 400, ok: false, fout });
  inp = inp && typeof inp === 'object' ? inp : {};
  const soort = String(inp.soort || '');
  if (SOORTEN.indexOf(soort) < 0) return f('soort: bon, antwoord, mijlpaal of nieuws');
  const chat = String(inp.chat || '');
  if (!Object.hasOwn(CHATS, chat)) return f('chat: momodou of ghawa-ecg');
  const tijd = String(inp.tijd || '');
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(tijd) || !datumOk(tijd.slice(0, 10), nu)) return f('tijd: het moment van het bericht (JJJJ-MM-DD UU:MM)');
  const citaat = schoon(inp.citaat, 600);
  if (citaat.length < 2) return f('citaat: het bericht zelf');
  const bron = { chat, tijd: tijd.slice(0, 16).replace(' ', 'T'), afzender: regel1(inp.afzender, 60) || null };
  const g = {}; const bijlagen = []; let doel = '';
  if (soort === 'bon') {
    if (!Number.isSafeInteger(inp.gmd_cent) || inp.gmd_cent <= 0 || inp.gmd_cent > 100000000000) return f('gmd_cent: het bedrag in hele bututs');
    if (!datumOk(inp.datum, nu)) return f('datum: de datum op de bon (JJJJ-MM-DD, niet in de toekomst)');
    g.gmd_cent = inp.gmd_cent; g.datum = inp.datum; g.wat = regel1(inp.wat, 160);
    if (!g.wat) return f('wat: waarvoor de bon is');
    if (inp.bankregel != null) g.bankregel = String(inp.bankregel).slice(0, 12);
    const regels = new Set(((ctx.tb && ctx.tb.regels) || []).map((r) => r.id));
    if (inp.regel != null && !regels.has(String(inp.regel))) return f('regel: onbekende begrotingsregel');
    const k = bonKoppel(g, ctx.tb);
    if (k.b) {
      g.bankregel = k.b.id; g.geboekt = !!k.geboekt; g.betaling = { datum: k.b.datum, cheque: k.b.cheque || null, soort: k.b.soort };
      g.regel = k.b.voorstel ? k.b.voorstel.regel : null;   // Codex r2 MOET 1: de regel komt van Te boeken zelf (vaste rekenregel), niet van het taalmodel
    } else { delete g.bankregel; g.zonder = k.geen; g.regel = null; }
    if (inp.regel != null && String(inp.regel) !== g.regel) g.regel_lens = String(inp.regel);   // alleen een hint in de kaart; afwijken kiest David zelf
    if (!inp.bijlage) return f('bijlage: de foto of pdf van de bon');
    const c = bijlageKopie(ctx.vault, ctx.map, inp.bijlage, false);
    if (c.fout) return f(c.fout);
    bijlagen.push(c.naam);
    doel = String(g.gmd_cent) + '|' + g.datum;
  } else if (soort === 'antwoord') {
    const v = (ctx.vragen || []).find((x) => x.id === String(inp.vraag || ''));
    if (!v) return f('vraag: id uit de lens-lijst');
    g.vraag = v.id; g.antwoord = schoon(inp.antwoord, 2000);
    if (g.antwoord.length < 2) return f('antwoord: de tekst van het antwoord');
    g.stand = inp.stand === 'Closed' ? 'Closed' : 'Partly answered';
    doel = v.id;
  } else if (soort === 'mijlpaal') {
    const m = (ctx.mijlpalen || []).find((x) => x.sleutel === String(inp.mijlpaal || ''));
    if (!m) return f('mijlpaal: sleutel uit de lens-lijst');
    if (!datumOk(inp.gehaald_op, nu)) return f('gehaald_op: de datum (JJJJ-MM-DD, niet in de toekomst)');
    if (heeft(db, 'mijlpaal_bevestigd') && db.prepare('SELECT 1 FROM mijlpaal_bevestigd WHERE sleutel = ?').get(m.sleutel)) return { status: 409, ok: false, fout: 'die mijlpaal is al bevestigd' };
    g.mijlpaal = m.sleutel; g.tekst = regel1(m.tekst, 160); g.wanneer = m.wanneer || null; g.gehaald_op = inp.gehaald_op;
    doel = m.sleutel;
  } else {
    g.titel = regel1(inp.titel, 120); g.tekst = schoon(inp.tekst, 6000);
    if (g.titel.length < 3) return f('titel: 3 tot 120 tekens');
    if (g.tekst.length < 20) return f('tekst: minstens 20 tekens');
    const fotos = Array.isArray(inp.fotos) ? inp.fotos : [];
    if (fotos.length > MAX_FOTOS) return f('hooguit ' + MAX_FOTOS + " foto's");
    for (const p of fotos) { const c = bijlageKopie(ctx.vault, ctx.map, p, true); if (c.fout) return f(c.fout); bijlagen.push(c.naam); }
    doel = crypto.createHash('sha256').update(g.titel).digest('hex').slice(0, 12);
  }
  // Codex r3 MOET 1: de dump heeft geen bericht-id; minuut + tekst van het bericht maakt twee berichten in dezelfde minuut toch uniek
  const sleutel = crypto.createHash('sha256').update(JSON.stringify([chat, bron.tijd, soort, doel, crypto.createHash('sha256').update(citaat).digest('hex')])).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    const al = db.prepare('SELECT id FROM voorstel WHERE sleutel = ?').get(sleutel);
    if (al) { db.exec('COMMIT'); return { status: 200, ok: true, id: al.id, nieuw: false }; }
    const n = db.prepare("SELECT COUNT(*) AS n FROM voorstel WHERE staat = 'open'").get().n;
    if (n >= MAX_OPEN) { db.exec('ROLLBACK'); return { status: 429, ok: false, fout: 'er staan al ' + MAX_OPEN + ' voorstellen open' }; }
    const id = volgendId(db);
    db.prepare('INSERT INTO voorstel (id, sleutel, soort, staat, gegevens, bron, citaat, bijlagen, gemaakt_op) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, sleutel, soort, 'open', JSON.stringify(g), JSON.stringify(bron), citaat, JSON.stringify(bijlagen), nu);
    log(db, id, 'gezet', nu, 'socev-lens', { soort });
    db.exec('COMMIT');
    return { status: 200, ok: true, id, nieuw: true };
  } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* dicht */ } throw e; }
}

function rij(r) {
  return { id: r.id, soort: r.soort, staat: r.staat, gegevens: JSON.parse(r.gegevens || '{}'), bron: JSON.parse(r.bron || '{}'), citaat: r.citaat,
    bijlagen: JSON.parse(r.bijlagen || '[]'), gemaakt_op: r.gemaakt_op, besluit_op: r.besluit_op, door: r.door, effect: r.effect ? JSON.parse(r.effect) : null };
}
function haal(db, id) { const r = db.prepare('SELECT * FROM voorstel WHERE id = ?').get(String(id || '')); return r ? rij(r) : null; }
// Open voorstellen ouder dan 30 dagen vervallen (stil); daarna de lijst: open eerst, dan de laatste 30 afgehandelde.
function vervalOud(db, nu) {
  if (!heeft(db, 'voorstel')) return 0;
  const grens = new Date(Date.parse(nu) - VERVAL_DAGEN * 86400000).toISOString();
  const oud = db.prepare("SELECT id FROM voorstel WHERE staat = 'open' AND gemaakt_op < ?").all(grens);
  for (const r of oud) { db.prepare("UPDATE voorstel SET staat = 'vervallen', besluit_op = ? WHERE id = ?").run(nu, r.id); log(db, r.id, 'vervallen', nu, 'pod', null); }
  return oud.length;
}
function lijst(db) {
  if (!heeft(db, 'voorstel')) return { open: [], afgehandeld: [] };
  return { open: db.prepare("SELECT * FROM voorstel WHERE staat = 'open' ORDER BY gemaakt_op, id").all().map(rij),
    afgehandeld: db.prepare("SELECT * FROM voorstel WHERE staat <> 'open' ORDER BY COALESCE(besluit_op, gemaakt_op) DESC LIMIT 30").all().map(rij) };
}
function aantalOpen(db) { return heeft(db, 'voorstel') ? db.prepare("SELECT COUNT(*) AS n FROM voorstel WHERE staat = 'open'").get().n : 0; }
// Vingerafdruk nodig? Geld (bon boeken of terugdraaien) en de openbare proefsite (nieuws): ja. Antwoord en mijlpaal: nee.
function versNodig(v, actie) { return !!v && (actie === 'ja' || actie === 'terug') && (v.soort === 'bon' || v.soort === 'nieuws'); }

function besloten(db, v, staat, nu, door, effect, detail) {
  db.prepare('UPDATE voorstel SET staat = ?, besluit_op = ?, door = ?, effect = ? WHERE id = ?').run(staat, nu, schoon(door, 40) || null, effect == null ? null : JSON.stringify(effect), v.id);
  log(db, v.id, staat, nu, door, detail || null);
}
// Ja, Nee of Terugdraaien voor bon, antwoord en mijlpaal (nieuws: server.js met nieuwsJa/nieuwsTerug).
// w: { bevestigd: true, regel? (bon: andere begrotingsregel) }. x: { BIJ, bonMap, map, nu, door }
function besluit(db, id, actie, w, x) {
  const nu = x.nu || new Date().toISOString(), door = x.door || 'app', BIJ = x.BIJ;
  w = w || {};
  if (w.bevestigd !== true) return { status: 400, ok: false, fout: 'bevestig je keuze' };
  const v = haal(db, id);
  if (!v) return { status: 404, ok: false, fout: 'dat voorstel bestaat niet' };
  if (actie === 'nee') {
    if (v.staat !== 'open') return { status: 409, ok: false, fout: 'dit voorstel is al afgehandeld' };
    db.exec('BEGIN IMMEDIATE');
    try { besloten(db, v, 'nee', nu, door, null, null); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { status: 200, ok: true, id: v.id, staat: 'nee' };
  }
  if (v.soort === 'nieuws') return { status: 400, ok: false, fout: 'nieuws gaat via de website' };
  const g = v.gegevens;
  if (actie === 'ja') {
    if (v.staat !== 'open') return { status: 409, ok: false, fout: 'dit voorstel is al afgehandeld' };
    if (v.soort === 'bon') {
      if (!g.bankregel) return { status: 409, ok: false, fout: 'deze bon hoort (nog) bij geen betaling: ' + (g.zonder || 'kies op Te boeken') };
      const regel = w.regel != null ? String(w.regel) : g.regel;   // w.regel = Davids eigen keuze in de kaart; nooit g.regel_lens zonder die keuze
      const bon = (function () {   // de kopie uit de voorstelmap als bon bewaren (zelfde naamregel als Te boeken)
        const by = bijlageLees(x.map, v.bijlagen[0]);
        if (!by) return { fout: 'de bon is niet meer te vinden' };
        return BIJ.bonBewaar(x.bonMap, g.bankregel, by);
      })();
      if (bon.fout) return { status: 409, ok: false, fout: bon.fout };
      let r, effect;
      const al = db.prepare("SELECT id, bon FROM uitgave WHERE bankregel = ? AND herkomst = 'te-boeken' ORDER BY id").all(g.bankregel);
      if (al.length) {
        const oud = al[0].bon || null;
        r = BIJ.bonBij(db, g.bankregel, bon.naam, nu, door);
        effect = { actie: 'bon', bankregel: g.bankregel, oud_bon: oud, nieuw_bon: bon.naam };
      } else {
        if (!regel) return { status: 400, ok: false, fout: 'kies een begrotingsregel' };
        const b = db.prepare('SELECT bedrag_cent FROM bankregel_ecg WHERE id = ?').get(g.bankregel);
        if (!b || -b.bedrag_cent !== g.gmd_cent) return { status: 409, ok: false, fout: 'het bedrag van de betaling klopt niet meer met de bon' };
        r = BIJ.boek(db, g.bankregel, { delen: [{ regel, gmd_cent: g.gmd_cent }], omschrijving: (g.wat ? g.wat + ' (bon via WhatsApp, ' + g.datum.split('-').reverse().join('-') + ')' : undefined), bevestigd: true }, nu, door, bon.naam);
        effect = r.ok ? { actie: 'boek', bankregel: g.bankregel, regel, uitgaven: r.uitgaven } : null;
      }
      if (!r.ok) { if (bon.nieuw) { try { fs.unlinkSync(path.join(x.bonMap, bon.naam)); } catch (e) { /* weg */ } } return r; }
      db.exec('BEGIN IMMEDIATE');
      try { besloten(db, v, 'ja', nu, door, effect, { actie: effect.actie, bankregel: g.bankregel }); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return { status: 200, ok: true, id: v.id, staat: 'ja', effect };
    }
    if (v.soort === 'antwoord') {
      const oud = db.prepare('SELECT antwoord, status FROM open_vraag WHERE id = ?').get(g.vraag);
      if (!oud) return { status: 409, ok: false, fout: 'die vraag bestaat niet meer' };
      const r = BIJ.vraagZet(db, g.vraag, { antwoord: w.antwoord != null ? String(w.antwoord) : g.antwoord, status: w.stand === 'Closed' || w.stand === 'Partly answered' ? w.stand : g.stand, bevestigd: true }, nu, door);
      if (!r.ok) return r;
      const na = db.prepare('SELECT antwoord, status FROM open_vraag WHERE id = ?').get(g.vraag);
      const effect = { actie: 'vraag', vraag: g.vraag, oud: { antwoord: oud.antwoord || null, status: oud.status }, nieuw: { antwoord: na.antwoord || null, status: na.status } };
      db.exec('BEGIN IMMEDIATE');
      try { besloten(db, v, 'ja', nu, door, effect, { actie: 'vraag', vraag: g.vraag }); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return { status: 200, ok: true, id: v.id, staat: 'ja', effect };
    }
    if (v.soort === 'mijlpaal') {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (db.prepare('SELECT 1 FROM mijlpaal_bevestigd WHERE sleutel = ?').get(g.mijlpaal)) { db.exec('ROLLBACK'); return { status: 409, ok: false, fout: 'die mijlpaal is al bevestigd' }; }
        db.prepare('INSERT INTO mijlpaal_bevestigd (sleutel, gehaald_op, voorstel, op) VALUES (?,?,?,?)').run(g.mijlpaal, g.gehaald_op, v.id, nu);
        besloten(db, v, 'ja', nu, door, { actie: 'mijlpaal', sleutel: g.mijlpaal }, { actie: 'mijlpaal' });
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* dicht */ } throw e; }
      return { status: 200, ok: true, id: v.id, staat: 'ja' };
    }
  }
  if (actie === 'terug') {
    if (v.staat !== 'ja' || !v.effect) return { status: 409, ok: false, fout: 'alleen een goedgekeurd voorstel draai je terug' };
    const e = v.effect;
    let r;
    if (e.actie === 'boek') {   // Codex r1 MOET 3: alleen als de uitgaven van die betaling nog precies die van dit Ja zijn
      const nuU = db.prepare("SELECT id FROM uitgave WHERE bankregel = ? AND herkomst = 'te-boeken' ORDER BY id").all(e.bankregel).map((u) => u.id);
      if (JSON.stringify(nuU) !== JSON.stringify((e.uitgaven || []).slice().sort())) return { status: 409, ok: false, fout: 'die betaling is intussen anders geboekt; draai het terug op Te boeken' };
      r = BIJ.boekTerug(db, e.bankregel, { bevestigd: true }, nu, door);
    } else if (e.actie === 'bon') {
      const rs = db.prepare("SELECT bon FROM uitgave WHERE bankregel = ? AND herkomst = 'te-boeken'").all(e.bankregel);
      if (!rs.length || rs.some((u) => u.bon !== e.nieuw_bon)) return { status: 409, ok: false, fout: 'de bon is intussen gewijzigd' };
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("UPDATE uitgave SET bon = ?, bewijs = ? WHERE bankregel = ? AND herkomst = 'te-boeken'").run(e.oud_bon, e.oud_bon ? 'Receipt photo' : 'Bank statement only', e.bankregel);
        db.prepare('INSERT INTO boeking_log (bankregel, actie, gmd_cent, delen, op, door) VALUES (?,?,?,?,?,?)').run(e.bankregel, 'bon terug', null, JSON.stringify({ oud: e.nieuw_bon, nieuw: e.oud_bon }), nu, schoon(door, 40) || null);
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      r = { ok: true };
    } else if (e.actie === 'vraag') {
      const nuV = db.prepare('SELECT antwoord, status FROM open_vraag WHERE id = ?').get(e.vraag);
      if (!nuV || (nuV.antwoord || null) !== e.nieuw.antwoord || nuV.status !== e.nieuw.status) return { status: 409, ok: false, fout: 'die vraag is intussen gewijzigd' };
      r = BIJ.vraagZet(db, e.vraag, { antwoord: e.oud.antwoord, status: e.oud.status, bevestigd: true }, nu, door);
    } else if (e.actie === 'mijlpaal') {
      db.prepare('DELETE FROM mijlpaal_bevestigd WHERE sleutel = ? AND voorstel = ?').run(e.sleutel, v.id);
      r = { ok: true };
    } else return { status: 400, ok: false, fout: 'onbekend effect' };
    if (!r.ok) return r;
    db.exec('BEGIN IMMEDIATE');
    try { db.prepare("UPDATE voorstel SET staat = 'teruggedraaid', besluit_op = ? WHERE id = ?").run(nu, v.id); log(db, v.id, 'teruggedraaid', nu, door, { actie: e.actie }); db.exec('COMMIT'); }
    catch (err) { db.exec('ROLLBACK'); throw err; }
    return { status: 200, ok: true, id: v.id, staat: 'teruggedraaid' };
  }
  return { status: 400, ok: false, fout: 'kies ja, nee of terug' };
}
// Nieuws: server.js zet eerst het concept op de proefsite (async) en legt het daarna hier vast.
function nieuwsKlaar(db, id, slug, nu, door) {
  const v = haal(db, id);
  if (!v || v.soort !== 'nieuws' || v.staat !== 'open') return { status: 409, ok: false, fout: 'dit voorstel is al afgehandeld' };
  db.exec('BEGIN IMMEDIATE');
  try { besloten(db, v, 'ja', nu, door, { actie: 'nieuws', slug: String(slug || '') }, { actie: 'nieuws' }); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { status: 200, ok: true, id: v.id, staat: 'ja', slug };
}
function nieuwsTerugKlaar(db, id, nu, door) {
  const v = haal(db, id);
  if (!v || v.staat !== 'ja') return { status: 409, ok: false, fout: 'alleen een goedgekeurd voorstel draai je terug' };
  db.exec('BEGIN IMMEDIATE');
  try { db.prepare("UPDATE voorstel SET staat = 'teruggedraaid', besluit_op = ? WHERE id = ?").run(nu, v.id); log(db, v.id, 'teruggedraaid', nu, door, { actie: 'nieuws' }); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return { status: 200, ok: true, id: v.id, staat: 'teruggedraaid' };
}
// Bevestigde mijlpalen over de vaultstand heen (Stichting/Doelen en de lens)
function mijlpaalBevestigd(db) {
  if (!heeft(db, 'mijlpaal_bevestigd')) return new Map();
  return new Map(db.prepare('SELECT sleutel, gehaald_op FROM mijlpaal_bevestigd').all().map((r) => [r.sleutel, r.gehaald_op]));
}

// ── wv3954 (L03, besluitenpagina nr 903): Socev schrijft een nieuwsbericht voor ghawa.org voor ──
// Aanleiding: een mijlpaal die sinds de vorige ronde op gehaald kwam (vault-tabel of Davids Ja op een mijlpaal-voorstel), of acht weken geen
// nieuw bericht op www.ghawa.org. Het concept komt als gewoon nieuws-voorstel (bron 'socev') in Voorstellen; David leest, past aan en tikt
// "Zet op de proefsite" (verse vingerafdruk, zelfde route als een nieuws-voorstel uit WhatsApp); www blijft Publiceer op Website.
// Hooguit één nieuws-voorstel tegelijk open; de eerste ronde onthoudt alleen welke mijlpalen al gehaald waren (geen concept over het verleden).
const STILTE_DAGEN = 56;
const SOCEV_NIEUWS_FOTO_DAGEN = 60;
function metaLees(db, k) { const r = db.prepare('SELECT waarde FROM meta WHERE sleutel = ?').get(k); return r ? r.waarde : null; }
function metaZet(db, k, v) { db.prepare('INSERT OR REPLACE INTO meta (sleutel, waarde) VALUES (?,?)').run(k, v); }
const socevSleutel = (a) => crypto.createHash('sha256').update('socev|' + a).digest('hex');
// ctx: { mijlpalen: [{sleutel, volgorde, wanneer, tekst, stand}] (stand al met mijlpaal_bevestigd), laatste: 'JJJJ-MM-DD' | null (nieuwste
// bericht op www), op_proef: bool (er staat al een concept op de proefsite), nu }. → null of { sleutel, soort, citaat, mijlpaal?, laatste?, dagen? }
function socevAanleiding(db, ctx) {
  if (!heeft(db, 'voorstel') || !heeft(db, 'meta')) return null;
  if (db.prepare("SELECT 1 FROM voorstel WHERE soort = 'nieuws' AND staat = 'open'").get()) return null;   // één tegelijk
  const gehaald = (ctx.mijlpalen || []).filter((m) => /gehaald|klaar|done|afgerond|complete/i.test(m.stand || ''));
  let gezien = null; try { gezien = JSON.parse(metaLees(db, 'nieuws:mijlpalen-gezien') || 'null'); } catch (e) { gezien = null; }
  if (!Array.isArray(gezien)) { metaZet(db, 'nieuws:mijlpalen-gezien', JSON.stringify(gehaald.map((m) => m.sleutel))); gezien = gehaald.map((m) => m.sleutel); }
  const nieuw = gehaald.filter((m) => gezien.indexOf(m.sleutel) < 0).sort((a, b) => (a.volgorde || 0) - (b.volgorde || 0));
  if (nieuw.length) {
    const m = nieuw[0];
    return { sleutel: socevSleutel('mijlpaal|' + m.sleutel), soort: 'mijlpaal', mijlpaal: { sleutel: m.sleutel, tekst: regel1(m.tekst, 160), wanneer: m.wanneer || null, gehaald_op: m.gehaald_op || null },
      citaat: 'Mijlpaal gehaald: ' + regel1(m.tekst, 160) + (m.gehaald_op ? ' (' + m.gehaald_op + ')' : '') + '.' };
  }
  if (ctx.op_proef || !ctx.laatste || !/^\d{4}-\d{2}-\d{2}$/.test(ctx.laatste)) return null;
  const dagen = dagVerschil(vandaagNl(ctx.nu), ctx.laatste);
  if (dagen < STILTE_DAGEN) return null;
  const sl = socevSleutel('stilte|' + ctx.laatste + '|' + Math.floor(dagen / STILTE_DAGEN));   // hooguit één per acht weken stilte, ook na Nee
  if (db.prepare('SELECT 1 FROM voorstel WHERE sleutel = ?').get(sl)) return null;
  const nl = (iso) => Number(iso.slice(8, 10)) + '-' + Number(iso.slice(5, 7)) + '-' + iso.slice(0, 4);
  return { sleutel: sl, soort: 'stilte', laatste: ctx.laatste, dagen, citaat: 'Sinds ' + nl(ctx.laatste) + ' (' + dagen + ' dagen) geen nieuw bericht op ghawa.org.' };
}
// Foto's voor het concept: uit de nieuws-voorstellen van de laatste 60 dagen (WhatsApp, idee 1) die David niet afwees; anders geen (dan kiest David).
function socevFotos(db, nu) {
  const grens = new Date(Date.parse(nu) - SOCEV_NIEUWS_FOTO_DAGEN * 86400000).toISOString();
  const uit = [];
  for (const r of db.prepare("SELECT bijlagen FROM voorstel WHERE soort = 'nieuws' AND staat <> 'nee' AND gemaakt_op >= ? ORDER BY gemaakt_op DESC").all(grens)) {
    for (const n of JSON.parse(r.bijlagen || '[]')) if (/\.(jpg|png|webp|heic)$/.test(n) && uit.indexOf(n) < 0 && uit.length < MAX_FOTOS) uit.push(n);
  }
  return uit;
}
// Het concept vastleggen als open nieuws-voorstel. a = socevAanleiding(), tekst = { titel, tekst } van het taalmodel.
function socevZet(db, a, tekst, nu) {
  const titel = regel1(tekst && tekst.titel, 120), t = schoon(tekst && tekst.tekst, 6000);
  if (titel.length < 3 || t.length < 20) return { status: 422, ok: false, fout: 'het concept is te kort' };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM voorstel WHERE sleutel = ?').get(a.sleutel)) { db.exec('COMMIT'); return { status: 200, ok: true, nieuw: false }; }
    if (db.prepare("SELECT 1 FROM voorstel WHERE soort = 'nieuws' AND staat = 'open'").get()) { db.exec('COMMIT'); return { status: 409, ok: false, fout: 'er staat al een nieuws-voorstel open' }; }
    const id = volgendId(db);
    const fotos = socevFotos(db, nu);
    const g = { titel, tekst: t, door: 'socev', aanleiding: a.soort };
    if (a.mijlpaal) g.mijlpaal = a.mijlpaal.sleutel;
    db.prepare('INSERT INTO voorstel (id, sleutel, soort, staat, gegevens, bron, citaat, bijlagen, gemaakt_op) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, a.sleutel, 'nieuws', 'open', JSON.stringify(g), JSON.stringify({ chat: 'socev', tijd: new Date(nu).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 16).replace(' ', 'T'), afzender: null }), a.citaat, JSON.stringify(fotos), nu);
    if (a.mijlpaal) {
      let gz = []; try { gz = JSON.parse(metaLees(db, 'nieuws:mijlpalen-gezien') || '[]'); } catch (e) { gz = []; }
      if (gz.indexOf(a.mijlpaal.sleutel) < 0) gz.push(a.mijlpaal.sleutel);
      metaZet(db, 'nieuws:mijlpalen-gezien', JSON.stringify(gz));
    }
    log(db, id, 'gezet', nu, 'socev-schrijft', { soort: 'nieuws', aanleiding: a.soort, fotos: fotos.length });
    db.exec('COMMIT');
    return { status: 200, ok: true, id, nieuw: true };
  } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* dicht */ } throw e; }
}

// Codex wv3954 r1+r2 MOET 1: het taalmodel schrijft GEEN getallen, bedragen, procenten, data of maandnamen; de feitenregel (mijlpaal,
// datum, bedragen) zet de pod er zelf onder uit de administratie (socevFeitenregel). Staat er toch iets in, dan geen voorstel; de volgende
// ronde (≥ 6 uur) probeert het opnieuw. r3: ook verhoudingen (helft, kwart) en termijnen (dagen, weken, maanden, binnenkort). Restrisico
// bewust: een onjuiste bewering in gewone woorden kan blijven; David leest en bewerkt elk concept, en www vraagt een eigen Publiceer.
const GEEN_CIJFER = /\d|€|%|\b(euro'?s?|dalasi|procent|duizend|miljoen|honderd|helft|kwart|dagen|weken|week|maanden|maand|binnenkort|volgende week|januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\b/i;
function socevZonderCijfers(tekst) {
  const t = String((tekst && tekst.titel) || '') + '\n' + String((tekst && tekst.tekst) || '');
  const m = GEEN_CIJFER.exec(t);
  return m ? { ok: false, gevonden: m[0].slice(0, 20) } : { ok: true };
}
const eurNl = (n) => '€ ' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
function datumNlKort(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? Number(m[3]) + '-' + Number(m[2]) + '-' + m[1] : null; }
// f = ghawa.js nieuwsFeiten(): { mijlpaal?: {tekst, wanneer, gehaald_op}, cijfers: {stand_van, bouw_begroot_eur, bouw_uitgegeven_eur, bouw_klaar_procent, nog_nodig_eur} }
function socevFeitenregel(f) {
  const r = [];
  if (f && f.mijlpaal) r.push('Mijlpaal: ' + f.mijlpaal.tekst + (f.mijlpaal.gehaald_op ? ' (gehaald op ' + datumNlKort(f.mijlpaal.gehaald_op) + ')' : f.mijlpaal.wanneer ? ' (' + f.mijlpaal.wanneer + ')' : '') + '.');
  const c = (f && f.cijfers) || {};
  if (c.bouw_begroot_eur > 0 && c.bouw_uitgegeven_eur != null) {
    r.push('Stand van de bouw' + (datumNlKort(c.stand_van) ? ' op ' + datumNlKort(c.stand_van) : '') + ': ' + eurNl(c.bouw_uitgegeven_eur) + ' besteed van de begroting van ' + eurNl(c.bouw_begroot_eur)
      + (c.bouw_klaar_procent != null ? ' (' + c.bouw_klaar_procent + ' %)' : '') + (c.nog_nodig_eur > 0 ? '; nog nodig voor de bouw: ' + eurNl(c.nog_nodig_eur) : '') + '.');
  }
  return r.join('\n\n');
}

module.exports = { SOORTEN, CHATS, SCHEMA, MAX_OPEN, datumOk, bijlageKopie, bijlageLees, lens, bonKoppel, zet, haal, lijst, aantalOpen, vervalOud, versNodig, besluit, nieuwsKlaar, nieuwsTerugKlaar, mijlpaalBevestigd, socevAanleiding, socevZet, socevFotos, socevZonderCijfers, socevFeitenregel, STILTE_DAGEN };
