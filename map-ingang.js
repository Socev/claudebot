'use strict';
/*
 * MAP-INGANG (wv3962, besluit nr 133 = 2C33 deel 2, David 22-11-2026: "zolang documenten die in de map geplaatst worden wel nog naar
 * Intake gestuurd worden"). Een los bestand in raw_input van een entiteit met een ingang (nu alleen Tolgaarde) gaat naar OVIS Intake
 * (profiel map@1, leverIntern 'map'); de router zet het als kennisbestand terug in dezelfde raw_input, met het origineel als bijlage.
 * Het origineel verhuist daarna naar Bronnen/Intake/ van die entiteit (vault-veilig.verplaats met de sha: gewijzigd = blijft staan).
 * Nooit wissen.
 *
 * Wie doet wat (Codex-review ontwerp, 3 rondes): de nacht (second-brain-verwerk-raw-input) en deze tik werken op gescheiden bestanden.
 * De gedeelde stand (o.staatPad, leesbaar voor de nachtskill; alleen paden, sha's en redenen) zegt welke sha's in behandeling of
 * ontvangen zijn en welke de ingang weigerde. raw-input-stand.py geeft zolang de ingang werkt elk LOS-bestand dat aan TOELATING voldoet
 * de stand INGANG (de nacht leest het niet), behalve een geweigerde sha (dan LOS = vangnet; de ingang biedt die sha nooit meer aan).
 * Een sha in in_behandeling of ontvangen is altijd INGANG. Dezelfde toelatingsregels staan in raw-input-stand.py (TOELATING_*).
 *
 * o = { vault, vv (vault-veilig), mappen: { TG: '10_Zakelijk/Tolgaarde/raw_input' }, live(entiteit) → bool, lever(env, bytes) → antwoord
 *   van leverIntern, los(mapRel) → Promise [{ pad (vault-relatief) }] (raw-input-stand.py --zonder-ingang, alleen LOS), pauze() → bool,
 *   staatPad, nu(), log(tekst), fout(waar, e), melding(tekst) }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STABIEL_MS = 15 * 60000;          // ouder dan een kwartier: het schrijven of de sync is klaar
const PER_TIK = 5;                      // een bulk loopt zo over uren, niet in één keer langs Jev en de router
const MAX_BYTES = 25 * 1024 * 1024;     // gelijk aan max_mb van map@1
const GEWEIGERD_BEWAAR_MS = 30 * 86400000;
const BEHANDEL_MAX_MS = 24 * 3600000;   // Intake een etmaal niet bereikbaar: opgeven, de nacht neemt het als vangnet
const MELD_NA = 3, MELD_VENSTER_MS = 86400000;
// extensie → mime (gelijk aan onderdelen.origineel.mime van map@1 en TOELATING_SOORTEN in raw-input-stand.py)
const SOORT = {
  pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html', eml: 'message/rfc822',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const NAAM_NIET = /\.sync-conflict-|^~syncthing~|\.vv\.tmp$|\.ovis-claim$|\.socev-geblokkeerd-/i;
const ENT_BRON = { TG: 'vault:tolgaarde' };

function extVan(n) { const m = /\.([A-Za-z0-9]{1,10})$/.exec(n); return m ? m[1].toLowerCase() : ''; }
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
// Toelating (zelfde regels als raw-input-stand.py): naam, soort; grootte en ouderdom op de stat
function toegelaten(naam) {
  if (!naam || naam[0] === '.' || naam[0] === '_' || NAAM_NIET.test(naam)) return false;
  return Object.prototype.hasOwnProperty.call(SOORT, extVan(naam));
}
function slug(t, max) {
  return String(t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}
function stempel(ms) {   // Nederlandse tijd, zoals de andere ingangen hun namen stempelen
  const d = new Date(ms);
  const f = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = {}; for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return p.year + '-' + p.month + '-' + p.day + '_' + (p.hour === '24' ? '00' : p.hour) + p.minute;
}

function maak(o) {
  const nu = o.nu || Date.now;
  const tel = { tikken: 0, aangeboden: 0, ontvangen: 0, verplaatst: 0, geweigerd: 0, fout: 0, laatste: null, laatste_fout: null };
  const fouten = [];   // tijden van weigeringen/verplaatsfouten, voor één box-rij per 24 u
  let gemeld = 0, bezig = false;

  function leesStaat() {
    try {
      const j = JSON.parse(fs.readFileSync(o.staatPad, 'utf8'));
      if (j && typeof j === 'object') return { in_behandeling: j.in_behandeling || {}, ontvangen: j.ontvangen || {}, geweigerd: j.geweigerd || {} };
    } catch (e) { /* nieuw */ }
    return { in_behandeling: {}, ontvangen: {}, geweigerd: {} };
  }
  // atomair + fsync (review ronde 2 MOET 3: in_behandeling moet een crash overleven); 0644 in een 0755-map: de nachtskill leest mee
  function schrijfStaat(st, aanLijst) {
    const map = path.dirname(o.staatPad);
    fs.mkdirSync(map, { recursive: true, mode: 0o755 });
    const tijd = nu();
    for (const [k, v] of Object.entries(st.geweigerd)) if (!v || !(tijd - Date.parse(v.op) < GEWEIGERD_BEWAAR_MS)) delete st.geweigerd[k];
    const inhoud = JSON.stringify({ versie: 1, aan: aanLijst.length > 0, bijgewerkt: new Date(tijd).toISOString(), mappen: aanLijst,
      in_behandeling: st.in_behandeling, ontvangen: st.ontvangen, geweigerd: st.geweigerd }, null, 1) + '\n';
    const tmp = path.join(map, '.stand.' + crypto.randomBytes(6).toString('hex') + '.tmp');
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
    try { fs.writeFileSync(fd, inhoud); fs.fchmodSync(fd, 0o644); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, o.staatPad);
    try { const d = fs.openSync(map, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (e) { /* bijzaak */ }
  }
  function foutTel(reden) {
    const t = nu();
    fouten.push(t);
    while (fouten.length && t - fouten[0] > MELD_VENSTER_MS) fouten.shift();
    if (fouten.length >= MELD_NA && t - gemeld > MELD_VENSTER_MS && o.melding) {
      gemeld = t;
      try { o.melding(fouten.length + ' bestanden in 24 uur niet via de map-ingang naar Intake (laatste reden: ' + String(reden).slice(0, 80) + '); de nachtverwerking neemt ze als vangnet.'); } catch (e) { /* bijzaak */ }
    }
  }
  function bronnenMap(mapRel) { return mapRel.replace(/\/raw_input$/, '/Bronnen/Intake'); }

  // Verplaats het origineel (alleen als de inhoud nog precies sha is) naar Bronnen/Intake/; bezette naam → (2) … (9). → pad of null
  function verplaats(ent, rel, sha) {
    const mapRel = o.mappen[ent];
    const van = path.join(o.vault, rel);
    const doelMap = path.join(o.vault, bronnenMap(mapRel));
    const naam = path.basename(rel), i = naam.lastIndexOf('.');
    const stam = i > 0 ? naam.slice(0, i) : naam, ext = i > 0 ? naam.slice(i) : '';
    for (let n = 1; n <= 9; n++) {
      const k = n === 1 ? naam : stam + ' (' + n + ')' + ext;
      try {
        if (o.vv.verplaats(van, path.join(doelMap, k), { sha256: sha })) return path.join(bronnenMap(mapRel), k);
        return null;   // inhoud veranderd of weg: blijft staan
      } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
    }
    const e = new Error('naam bezet tot (9)'); e.code = 'EBEZET'; throw e;
  }
  function bestaat(rel) { try { return fs.lstatSync(path.join(o.vault, rel)).isFile(); } catch (e) { return false; } }

  async function biedAan(ent, rel, st, aanLijst, eerder) {
    const naam = path.basename(rel);
    let buf;
    try { buf = o.vv.lees(path.join(o.vault, rel), null, { max: MAX_BYTES }); }   // map-descriptor + O_NOFOLLOW + fstat (review ronde 3 MOET 2)
    catch (e) {
      if (e && (e.code === 'ENOENT')) return 'weg';
      st.geweigerd['pad:' + sha256(rel)] = { pad: rel, sha256: null, reden: 'lezen:' + String(e && e.code || 'fout'), op: new Date(nu()).toISOString() };
      tel.geweigerd++; foutTel('lezen'); return 'geweigerd';
    }
    const sha = sha256(buf);
    if (st.geweigerd[sha] || st.ontvangen[sha]) return 'bekend';
    // eerst duurzaam: precies deze sha is in behandeling (review ronde 3 MOET 1)
    st.in_behandeling[sha] = { pad: rel, op: new Date(nu()).toISOString(), eerste: (eerder && eerder.sha === sha && eerder.eerste) || new Date(nu()).toISOString() };
    schrijfStaat(st, aanLijst);
    const ms = nu();
    let gewijzigd = ms;
    try { gewijzigd = fs.lstatSync(path.join(o.vault, rel)).mtimeMs; } catch (e) { /* weg: hieronder */ }
    const ext = extVan(naam);
    const onderwerp = naam.slice(0, naam.length - ext.length - 1).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300) || 'bestand';
    const env = { protocol: 'ovis-intake/1', profiel: 'map@1', bron: ENT_BRON[ent], bron_id: sha256('map|' + ent + '|' + sha).slice(0, 24),
      ontvangen: new Date(ms).toISOString(),
      meta: { onderwerp, map_entiteit: ent, bestand: path.relative(o.mappen[ent], path.relative('', rel)).slice(0, 300) || naam, gewijzigd_op: new Date(gewijzigd).toISOString() },
      onderdelen: [{ deel: 'b1', rol: 'origineel', naam, mime: SOORT[ext], grootte: buf.length, sha256: sha }],
      overgang: { stand: 'om', bestandsnaam: stempel(gewijzigd) + '_map_' + (slug(onderwerp, 80) || 'bestand') + '.' + ext },
      aanlevering: { workflow: 'pod:map-ingang', knoop: 'map-ingang.js' } };
    tel.aangeboden++;
    let r = null;
    try { r = await o.lever(env, { b1: buf }); } catch (e) { if (o.fout) o.fout('map-ingang-lever', e); r = null; }
    const ok = !!(r && r.ok === true && (r.compleet === true || r.uitkomst === 'dubbel'));
    if (!ok) {
      if (!r || r.http >= 500 || r.http === 0) { tel.fout++; tel.laatste_fout = 'intake_' + String(r ? r.reden || r.http : 'geen_antwoord').slice(0, 40); return 'later'; }   // tijdelijk: in_behandeling blijft, volgende tik opnieuw
      delete st.in_behandeling[sha];
      st.geweigerd[sha] = { pad: rel, sha256: sha, reden: String(r.reden || r.uitkomst || 'geweigerd').slice(0, 80), op: new Date(nu()).toISOString() };
      tel.geweigerd++; foutTel(r.reden || 'geweigerd'); return 'geweigerd';
    }
    delete st.in_behandeling[sha];
    st.ontvangen[sha] = { pad: rel, stuk: r.stuk_id || null, op: new Date(nu()).toISOString() };
    tel.ontvangen++;
    schrijfStaat(st, aanLijst);
    return verplaatsOntvangen(ent, sha, st);
  }
  function verplaatsOntvangen(ent, sha, st) {
    const e0 = st.ontvangen[sha];
    if (!bestaat(e0.pad)) { delete st.ontvangen[sha]; return 'weg'; }
    let naar = null;
    try { naar = verplaats(ent, e0.pad, sha); } catch (e) { tel.fout++; tel.laatste_fout = 'verplaats_' + String(e && e.code || 'fout'); foutTel('verplaatsen'); return 'later'; }
    if (!naar) { delete st.ontvangen[sha]; return 'gewijzigd'; }   // inhoud anders dan aangeboden: de nieuwe versie komt als nieuw stuk
    delete st.ontvangen[sha];
    tel.verplaatst++;
    if (o.log) o.log('map-ingang: ' + e0.pad + ' → ' + naar + ' (stuk ' + (e0.stuk || '?') + ')');
    return 'verplaatst';
  }

  async function tik() {
    if (bezig) return { bezig: true };
    bezig = true;
    const uit = { aangeboden: 0, verplaatst: 0, geweigerd: 0, later: 0, pauze: false };
    try {
      tel.tikken++; tel.laatste = new Date(nu()).toISOString();
      const aanLijst = Object.keys(o.mappen).filter(function (e) { try { return o.live(e) === true; } catch (x) { return false; } }).map(function (e) { return o.mappen[e]; });
      const st = leesStaat();
      if (!aanLijst.length) { schrijfStaat(st, []); return Object.assign(uit, { uit: true }); }
      if (o.pauze && o.pauze()) { schrijfStaat(st, aanLijst); uit.pauze = true; return uit; }
      const entVan = function (rel) { return Object.keys(o.mappen).find(function (e) { return aanLijst.indexOf(o.mappen[e]) >= 0 && (rel === o.mappen[e] || rel.indexOf(o.mappen[e] + '/') === 0); }); };
      // 1. eerst afmaken wat een vorige tik (of een crash) liet liggen
      for (const sha of Object.keys(st.ontvangen)) { const ent = entVan(st.ontvangen[sha].pad); if (ent) { const u = verplaatsOntvangen(ent, sha, st); if (u === 'verplaatst') uit.verplaatst++; else if (u === 'later') uit.later++; } }
      let n = 0;
      for (const sha of Object.keys(st.in_behandeling)) {
        if (n >= PER_TIK) break;
        const e0 = st.in_behandeling[sha], ent = entVan(e0.pad);
        if (!ent) continue;
        if (!bestaat(e0.pad)) { delete st.in_behandeling[sha]; continue; }
        if (!(nu() - Date.parse(e0.eerste || e0.op) < BEHANDEL_MAX_MS)) {
          delete st.in_behandeling[sha];
          st.geweigerd[sha] = { pad: e0.pad, sha256: sha, reden: 'intake_niet_bereikbaar', op: new Date(nu()).toISOString() };
          tel.geweigerd++; foutTel('Intake een etmaal niet bereikbaar'); continue;
        }
        delete st.in_behandeling[sha];   // opnieuw aanbieden: dezelfde bytes geven dezelfde bron_id → dubbel → verplaatsen
        n++;
        const u = await biedAan(ent, e0.pad, st, aanLijst, { sha, eerste: e0.eerste || e0.op });
        if (u === 'verplaatst') uit.verplaatst++; else if (u === 'geweigerd') uit.geweigerd++; else if (u === 'later') uit.later++;
        if (u !== 'later' && u !== 'weg' && u !== 'bekend') uit.aangeboden++;
      }
      // 2. nieuwe LOS-bestanden
      const bekend = new Set(Object.values(st.in_behandeling).map(function (x) { return x.pad; }));
      for (const mapRel of aanLijst) {
        if (n >= PER_TIK) break;
        let rijen = [];
        try { rijen = await o.los(mapRel); } catch (e) { if (o.fout) o.fout('map-ingang-stand', e); tel.fout++; tel.laatste_fout = 'stand'; continue; }
        const ent = Object.keys(o.mappen).find(function (e) { return o.mappen[e] === mapRel; });
        for (const rij of rijen) {
          if (n >= PER_TIK) break;
          const rel = String(rij.pad || '');
          if (!rel || bekend.has(rel) || (rel !== mapRel && rel.indexOf(mapRel + '/') !== 0) || rel.split('/').some(function (d) { return d === '..'; })) continue;
          const naam = path.basename(rel);
          if (!toegelaten(naam)) continue;   // blijft LOS voor de nacht (zelfde regel in raw-input-stand.py)
          let s;
          try { s = fs.lstatSync(path.join(o.vault, rel)); } catch (e) { continue; }
          if (!s.isFile() || s.size > MAX_BYTES || s.size === 0) continue;
          if (nu() - s.mtimeMs < STABIEL_MS) continue;
          n++;
          const u = await biedAan(ent, rel, st, aanLijst);
          if (u === 'verplaatst') uit.verplaatst++; else if (u === 'geweigerd') uit.geweigerd++; else if (u === 'later') uit.later++;
          if (u !== 'bekend' && u !== 'weg') uit.aangeboden++;
          else n--;
        }
      }
      schrijfStaat(st, aanLijst);
      return uit;
    } catch (e) { tel.fout++; tel.laatste_fout = String(e && e.code || 'fout'); if (o.fout) o.fout('map-ingang', e); return Object.assign(uit, { fout: true }); }
    finally { bezig = false; }
  }
  function info() {
    const st = leesStaat();
    return Object.assign({}, tel, { in_behandeling: Object.keys(st.in_behandeling).length, wacht_op_verplaatsen: Object.keys(st.ontvangen).length, geweigerd_30d: Object.keys(st.geweigerd).length });
  }
  return { tik, info };
}

module.exports = { maak, K: { SOORT, STABIEL_MS, PER_TIK, MAX_BYTES, toegelaten, stempel, slug } };
