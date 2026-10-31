'use strict';
/*
 * intake-verwijder.js — de verwijderroute van OVIS Intake met tombstones (wv1964, Second Brain 2.0 fase 6d, proef 11). Ontwerp + Fable-review
 * vooraf: vault "01_Ontwikkeling/Second Brain 2.0 - fase 6 herstelproef, proefloper en redeneerteam (ontwerp 29-10-2026).md" § 5 en § 5.1;
 * databankkant socev-scripts packages/sb2/sql/fase2/0014_verwijderroute.up.sql.
 *
 * WAAROM. Grondwet 3: een stuk dat per ongeluk patiëntgegevens of een geheim bevat, moet overal weg kunnen (bestanden, databank,
 * zoekindex) en mag bij het terugzetten van een oude kopie niet stilletjes terugkomen. Verwijderen gaat altijd via Davids knop.
 *
 * EENHEID. Eén Intake-stuk = een set sha256's: alle onderdelen + de kern (bij mail is dát de sha in Supabase). Zit een sha ook in een
 * ander stuk, dan gaat dat stuk mee (de tombstone geldt voor de inhoud) — tenzij die sha met --zonder bewust buiten de set blijft
 * (een gedeelde logo- of handtekeningbijlage; Fable MOET 5). Hooguit MAX_STUKKEN stukken.
 *
 * VERLOOP (opdrachtregel, geen HTTP-route):
 *   plan <stuk_id> [--zonder <sha>]…   alleen lezen: set, set-vingerafdruk, vindplaatsen per opslag, tellingen van de databank, kaarttekst.
 *   voer-uit <stuk_id> --vraag <8 hex> [--reden PII_grondwet_3|geheim_grondwet_2] [--zonder …] | --proef
 *     1. journaal (hervatten na een crash), 2. RPC sb_bron_verwijder (de poort: kaart met Davids Ja + verse vingerafdruk; weigert hij,
 *     dan raakt de pod niets), 3. tombstones in de cache en de vaultlijst (vóór het wissen: de ingang weigert vanaf nu), 4. blobs,
 *     schaduw- en versiekopieën, 5. vaultbestanden, 6. intake.sqlite (één transactie, secure_delete), 7. tekstindex opnieuw bouwen,
 *     8. tellingen na, 9. Verwijderregister (zonder paden), 10. RPC sb_bron_verwijder_klaar.
 *   lijst                             de tombstonelijst (aantallen) uit cache, vault en databank.
 *
 * HERINNERINGEN (wv2069). Een ramble@1-stuk (MemoryLane, herinneringen.js) heeft naast Intake eigen opslag: de rijen in ramble en
 * ramble_stuk (+ ramble_spoor) van dezelfde intake.sqlite en de map <herinneringen>/audio/<ramble_id>/ (de stem: <n>.wav, de tekst per
 * stuk: <n>.txt, manifest.txt) en eventueel staging/<ramble_id>/. Plan telt ze; voer-uit zet de rij eerst op 'verwijderd' (de tik raakt hem
 * dan niet meer: geen nieuwe aanlevering en geen dagelijkse spoorregel), wist de mappen bestand voor bestand (geen symlink volgen) en in
 * de databanktransactie ramble_stuk en ramble_spoor; de ramblerij blijft met alleen ids (ramble_id, dag, tijden, stuk_id, kaartsleutel,
 * offsite_op, proef), zodat een late upload van dezelfde opname 409 krijgt en een knop op een oude markerkaart niets doet. Wat blijft:
 * de versleutelde audiokopie op vaultcrypt:herinneringen-audio/ (alleen toevoegen; offsite_op zegt of die er is) en ramble_dag (alleen
 * seconden per dag). Een open markerkaart (kaartsleutel in het plan) sluit de machinekamer met de hand.
 *
 * Privacy: naar Supabase alleen hashes, stuk-id's en tellingen; in de vault alleen hashes (tombstones.md) en tellingen (index.md).
 * Paden staan alleen in het journaal/plan op de pod (0600) en in het antwoord aan de machinekamer.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const I = require('./intake-ingang.js');

const STUK_RE = /^stk_[0-9]{8}_[0-9a-f]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const VRAAG_RE = /^[0-9a-f]{8}$/;
const REDENEN = ['PII_grondwet_3', 'geheim_grondwet_2'];
const MAX_STUKKEN = 10;
const KOP_LEES = 4096;
const AFGELEID_MAX = 512 * 1024;           // .md groter dan dit wordt niet op stuk-id doorzocht (afgeleide pagina's)
const SLA_OVER = new Set(['.git', '.obsidian', '.stfolder', '.claude', '.trash', 'node_modules']);
const REGISTER = '00_Systeem/Verwijderregister/index.md';
const RAMBLE_RE = /^r[0-9]{8}-[0-9a-f]{16}$/;   // = herinneringen.js ID_RE
const BRON_TEKST = { 'gmail:david': 'mail (privé-Gmail)', 'gmail:groenhouten': 'mail (Groenhouten-Gmail)', 'outlook:tolgaarde': 'mail (Tolgaarde-Outlook)',
  'whatsapp:nl': 'WhatsApp', 'whatsapp:gambia': 'WhatsApp (Gambia)', signal: 'Signal', teams: 'Teams', 'scanner:scansnap': 'de scanner', 'contacten:google': 'Contacten' };

function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function setVinger(set) { return sha256(Buffer.from(set.join(','), 'utf8')); }
function shaBestand(p) {
  const h = crypto.createHash('sha256'), fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function leesKop(p, n) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try { if (!fs.fstatSync(fd).isFile()) return ''; const b = Buffer.alloc(n); const k = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, k).toString('utf8'); }
  finally { fs.closeSync(fd); }
}
// Lopen door een boom zonder symlinks te volgen; f(abs, rel, lstat) per gewoon bestand.
function loop(wortel, f) {
  const stapel = [''];
  while (stapel.length) {
    const rel = stapel.pop();
    let namen;
    try { namen = fs.readdirSync(path.join(wortel, rel), { withFileTypes: true }); } catch (e) { continue; }
    for (const d of namen) {
      if (d.isSymbolicLink()) continue;
      const r = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) { if (!SLA_OVER.has(d.name)) stapel.push(r); continue; }
      if (!d.isFile()) continue;
      let st;
      try { st = fs.lstatSync(path.join(wortel, r)); } catch (e) { continue; }
      if (st.isFile()) f(path.join(wortel, r), r, st);
    }
  }
}
function nlDag(iso) { const t = Date.parse(iso); return isNaN(t) ? '?' : new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'numeric', year: 'numeric' }).format(new Date(t)); }
function nlKlok(iso) { const t = Date.parse(iso); return isNaN(t) ? '' : new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' }).format(new Date(t)); }

/*
 * maak(o) → { plan, voerUit, lijst }.
 * o = { dir (intake-map), vault, db (node:sqlite DatabaseSync op intake.sqlite), vv (vault-veilig), rpc(fn, body) → Promise<json>,
 *       staat (map voor plan en journaal, 0700), extraMappen? ([mappen met kopieën: intake/schaduw, Syncthing-versies]),
 *       zoekindex? () → Promise<{ok}> (herbouw), zoekTel? (naalden) → aantal treffers in de tekstindex, nu? () → ms, buitenVenster? () → reden|null,
 *       herinneringen? (map van herinneringen.js, wv2069) }
 */
function maak(o) {
  const db = o.db, nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const BLOB = path.join(o.dir, 'blob');
  const nuIso = () => new Date(nu()).toISOString();
  fs.mkdirSync(o.staat, { recursive: true, mode: 0o700 });
  const q = {
    stuk: db.prepare('SELECT * FROM stuk WHERE stuk_id = ?'),
    delen: db.prepare('SELECT deel, rol, mime, grootte, sha256 FROM onderdeel WHERE stuk_id = ? ORDER BY deel'),
    metSha: db.prepare('SELECT DISTINCT stuk_id FROM onderdeel WHERE sha256 = ?'),
    spiegel: db.prepare('SELECT kern, bronnen FROM spiegel WHERE stuk_id = ?'),
    metKern: db.prepare('SELECT stuk_id FROM spiegel WHERE kern = ?'),
  };
  // tabellen van de router (uitvoering, bestemming, besluit, …) bestaan alleen als de router ooit draaide
  const tabellen = () => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  const STUK_TABELLEN = ['vrij_veld', 'bestemming', 'router_stuk', 'live_stuk', 'uitvoering', 'overgang', 'correctie', 'aanlevering', 'scansnap', 'spiegel', 'besluit', 'systeem_post', 'onderdeel'];   // systeem_post: wv2004
  const blobPad = (s) => path.join(BLOB, s.slice(0, 2), s);
  // herinneringen (wv2069): opnames van deze stukken en hun mappen
  const rambleMappen = (rid) => o.herinneringen ? [path.join(o.herinneringen, 'audio', rid), path.join(o.herinneringen, 'staging', rid)] : [];
  function rambles(stukIds) {
    const ids = [...stukIds];
    if (!ids.length || !tabellen().has('ramble')) return [];
    return db.prepare('SELECT ramble_id, status, offsite_op, kaart, keuze FROM ramble WHERE stuk_id IN (' + ids.map(() => '?').join(',') + ') ORDER BY ramble_id').all(...ids)
      .filter((r) => RAMBLE_RE.test(r.ramble_id));
  }
  function rambleTel(rid) {
    let mappen = 0, bestanden = 0;
    for (const m of rambleMappen(rid)) {
      let st;
      try { st = fs.lstatSync(m); } catch (e) { continue; }
      mappen++;
      if (st.isDirectory()) loop(m, function () { bestanden++; });
    }
    return { mappen, bestanden };
  }
  const journaalPad = (id) => path.join(o.staat, id + '.journaal.json');
  function schrijfJson(p, j) {
    const tmp = p + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 1), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, p);
  }
  function leesJournaal(id) { try { return JSON.parse(fs.readFileSync(journaalPad(id), 'utf8')); } catch (e) { return null; } }

  // De set: onderdelen + kern van het stuk, en elk stuk dat een van die sha's deelt (transitief), behalve de sha's in zonder.
  function verzamel(stukId, zonder) {
    const stukken = new Map(), shas = new Map(), wacht = [stukId];
    while (wacht.length) {
      const id = wacht.pop();
      if (stukken.has(id)) continue;
      const s = q.stuk.get(id);
      if (!s) return { fout: 'stuk onbekend: ' + id };
      if (s.status === 'verwijderd') return { fout: 'stuk ' + id + ' is al verwijderd' };
      stukken.set(id, s);
      if (stukken.size > MAX_STUKKEN) return { fout: 'meer dan ' + MAX_STUKKEN + ' stukken delen deze inhoud; met de hand beoordelen of met --zonder een gedeelde bijlage uitzonderen' };
      const delen = q.delen.all(id);
      const sp = q.spiegel.get(id);
      if (sp && sp.kern && HEX64.test(sp.kern)) delen.push({ deel: 'kern', rol: 'kern', mime: 'text/plain', grootte: null, sha256: sp.kern });
      for (const d of delen) {
        if (zonder.has(d.sha256)) continue;
        const x = shas.get(d.sha256) || { rollen: new Set(), grootte: d.grootte, mime: d.mime, stukken: new Set() };
        x.rollen.add(d.rol); x.stukken.add(id); if (x.grootte == null) x.grootte = d.grootte;
        shas.set(d.sha256, x);
        for (const r of q.metSha.all(d.sha256)) if (!stukken.has(r.stuk_id)) wacht.push(r.stuk_id);
        if (d.rol === 'kern') for (const r of q.metKern.all(d.sha256)) if (!stukken.has(r.stuk_id)) wacht.push(r.stuk_id);
      }
    }
    if (!shas.size) return { fout: 'geen onderdelen gevonden' };
    // grootte van een kern staat niet in onderdeel: uit de blobrij of het bestand
    for (const [s, x] of shas) if (x.grootte == null) { try { x.grootte = fs.statSync(blobPad(s)).size; } catch (e) { x.grootte = null; } }
    return { stukken, shas, set: [...shas.keys()].sort() };
  }

  // Vindplaatsen in de vault en de kopiemappen: sha-treffer (eerst op grootte), ovis_stuk in de frontmatter, bronnotitie op naam;
  // daarnaast afgeleide pagina's (noemen een stuk-id of linken naar de bronnotitie) — die alleen melden.
  function zoek(stukIds, shas) {
    const groottes = new Set([...shas.values()].map((x) => x.grootte).filter((g) => g != null));
    const ids = [...stukIds];
    const idRe = new RegExp('(' + ids.join('|') + ')');
    const fmRe = new RegExp('^ovis_stuk:\\s*"?(' + ids.join('|') + ')"?\\s*$', 'm');
    const naamRe = new RegExp('_(' + ids.join('|') + ')\\.md$');
    const treffers = [], afgeleid = [];
    const wortels = [{ w: o.vault, soort: 'vault' }].concat((o.extraMappen || []).map((w) => ({ w, soort: 'kopie' })));
    for (const { w, soort } of wortels) {
      loop(w, function (abs, rel, st) {
        let waarom = null;
        if (groottes.has(st.size)) { try { const h = shaBestand(abs); if (h && shas.has(h)) waarom = 'sha'; } catch (e) { /* onleesbaar */ } }
        const md = /\.md$/i.test(rel);
        if (!waarom && md && naamRe.test(rel)) waarom = 'bronnotitie';
        if (!waarom && md) {
          let kop = '';
          try { kop = leesKop(abs, KOP_LEES); } catch (e) { kop = ''; }
          const eind = kop.indexOf('\n---', 3);
          if (kop.startsWith('---') && fmRe.test(eind > 0 ? kop.slice(0, eind) : kop)) waarom = 'ovis_stuk';
        }
        if (waarom) { treffers.push({ soort, pad: abs, rel, waarom }); return; }
        if (soort === 'vault' && md && st.size <= AFGELEID_MAX && !/(^|\/)_register\.md$/.test(rel)) {
          let t = '';
          try { t = fs.readFileSync(abs, 'utf8'); } catch (e) { t = ''; }
          if (idRe.test(t)) afgeleid.push(rel);
        }
      });
    }
    return { treffers, afgeleid };
  }

  function kaartVoor(hoofd, verz, vinger, databank, ram) {
    const s = verz.stukken.get(hoofd);
    const bron = BRON_TEKST[s.bron] || s.bron.split(':')[0];
    const rollen = {};
    for (const [, x] of verz.shas) for (const r of x.rollen) if (r !== 'kern') rollen[r] = (rollen[r] || 0) + 1;
    const delen = Object.keys(rollen).map((r) => rollen[r] + ' ' + (r === 'bijlage' ? (rollen[r] > 1 ? 'bijlagen' : 'bijlage') : r === 'origineel' ? 'origineel' : r === 'representatie' ? 'leesversie' : r)).join(', ');
    const anderen = verz.stukken.size - 1;
    const stappen = [
      'Controleer dat het om dit stuk gaat: binnengekomen op ' + nlDag(s.ontvangen || s.aangemaakt) + ' ' + nlKlok(s.ontvangen || s.aangemaakt) + ' via ' + bron + ' (' + (delen || 'onderdelen') + ').',
      anderen ? 'Dezelfde inhoud kwam nog ' + anderen + ' keer binnen; die ontvangst' + (anderen > 1 ? 'en gaan' : ' gaat') + ' mee.' : 'Dit stuk kwam één keer binnen.',
      'Na je Ja (met vingerafdruk) haal ik het weg uit je kennisbank, de databank en de zoekindex, en kan dezelfde inhoud niet meer binnenkomen.',
    ];
    if (ram && ram.length) stappen.push('Het is een ingesproken herinnering' + (ram.length > 1 ? ' (' + ram.length + ' opnames)' : '') + ': ook de opname (je stem) en de uitgeschreven tekst op de server gaan weg.');
    stappen.push(
      'Wat blijft: de versleutelde nachtkopieën (Drive, lokaal, NAS)' + (ram && ram.some((r) => r.offsite_op) ? ', de versleutelde kopie van de opname op Drive' : '') +
        ' en de prullenbak van Syncthing op je eigen apparaten. Daaruit komt het niet vanzelf terug.',
      'Code van het stuk: ' + vinger.slice(0, 12));
    return { titel: ('Stuk van ' + nlDag(s.ontvangen || s.aangemaakt) + ' uit ' + bron + ' — verwijderen?').slice(0, 90), soort: 'besluit', waar: 'overal',
      waarom: 'Je wilt dit stuk kwijt omdat er patiëntgegevens of een geheim in staan. Verwijderen kan niet ongedaan worden; daarom vraag ik je Ja met vingerafdruk.',
      stappen, deadline: new Date(nu() + 7 * 86400000).toISOString().slice(0, 10), databank_rijen: databank };
  }

  async function plan(stukId, opt) {
    opt = opt || {};
    if (!STUK_RE.test(String(stukId))) return { ok: false, reden: 'stuk-id ongeldig' };
    const zonder = new Set(opt.zonder || []);
    for (const z of zonder) if (!HEX64.test(z)) return { ok: false, reden: '--zonder: geen sha256' };
    const verz = verzamel(stukId, zonder);
    if (verz.fout) return { ok: false, reden: verz.fout };
    const vinger = setVinger(verz.set);
    const vind = zoek(verz.stukken.keys(), verz.shas);
    const blobs = verz.set.filter((s) => fs.existsSync(blobPad(s))).length;
    const ram = rambles(verz.stukken.keys());
    let databank = null;
    try {
      const r = await o.rpc('sb_bron_verwijder_plan', { p: { sha256: verz.set } });
      if (!r || r.ok !== true) databank = { fout: (r && r.reden) || 'geen antwoord' };
      else if (r.set_vinger !== vinger) databank = { fout: 'set-vingerafdruk wijkt af tussen pod en databank' };
      else databank = { telling: r.telling, al_tombstone: r.al_tombstone, al_verwijderd: r.al_verwijderd };
    } catch (e) { databank = { fout: String(e && e.message || e).slice(0, 200) }; }
    const p = {
      ok: true, stuk: stukId, gemaakt: nuIso(), set: verz.set, set_vinger: vinger, code: vinger.slice(0, 12),
      stukken: [...verz.stukken.values()].map((s) => ({ stuk_id: s.stuk_id, bron: s.bron, status: s.status, proef: I.isProefstuk(s) })),
      shas: verz.set.map((s) => { const x = verz.shas.get(s); return { sha256: s, rollen: [...x.rollen], grootte: x.grootte, stukken: x.stukken.size }; }),
      zonder: [...zonder],
      pod: { blob_bestanden: blobs, vault: vind.treffers.filter((t) => t.soort === 'vault').length, kopie: vind.treffers.filter((t) => t.soort === 'kopie').length,
        afgeleid: vind.afgeleid.length },
      paden: vind.treffers.map((t) => ({ soort: t.soort, rel: t.rel, waarom: t.waarom })), afgeleid: vind.afgeleid,
      databank,
    };
    if (ram.length) {
      if (!o.herinneringen) return { ok: false, reden: 'stuk is een herinnering, maar de herinneringen-map is niet opgegeven' };
      const st = ram.map((r) => rambleTel(r.ramble_id));
      p.herinneringen = { opnames: ram.map((r) => r.ramble_id), mappen: st.reduce((a, x) => a + x.mappen, 0), bestanden: st.reduce((a, x) => a + x.bestanden, 0),
        rijen_stuk: db.prepare('SELECT count(*) n FROM ramble_stuk WHERE ramble_id IN (' + ram.map(() => '?').join(',') + ')').get(...ram.map((r) => r.ramble_id)).n,
        offsite: ram.filter((r) => r.offsite_op).length, open_kaarten: ram.filter((r) => r.kaart && !r.keuze).map((r) => r.kaart) };
    }
    p.kaart = kaartVoor(stukId, verz, vinger, databank && databank.telling ? Object.values(databank.telling).reduce((a, b) => a + (Number(b) || 0), 0) : null, ram);
    schrijfJson(path.join(o.staat, stukId + '.plan.json'), p);
    return p;
  }

  // Tombstones in de pod-cache (vereniging, krimpt nooit) en in de vaultlijst. Vóór het wissen: de ingang weigert vanaf nu.
  function tombstonesErbij(set, reden, wanneer) {
    const pc = path.join(o.dir, I.TOMB_CACHE);
    let oud = [];
    try { const j = JSON.parse(fs.readFileSync(pc, 'utf8')); if (j && Array.isArray(j.sha256)) oud = j.sha256.filter((x) => HEX64.test(x)); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('tombstones.json onleesbaar: eerst herstellen (' + e.message + ')'); }
    const alle = [...new Set(oud.concat(set))].sort();
    schrijfJson(pc, { versie: 1, bijgewerkt: wanneer, sha256: alle });
    const pv = path.join(o.vault, I.TOMB_VAULT);
    const regels = set.map((s) => s + ' ' + wanneer.slice(0, 10) + ' ' + reden).join('\n');
    const KOP = '---\ntype: register\nstatus: actueel\ndomein: Systeem\n---\n\n# Tombstones\n\nSha256 van inhoud die via de verwijderroute weg is en niet meer binnen mag komen ' +
      '(OVIS Intake, de databank en de herstelproef lezen deze lijst). Alleen hashes, nooit inhoud. Niet met de hand inkorten.\n' +
      'Uitleg: [[00_Systeem/Verwijderregister/index]].\n\n<!-- tombstones begin -->\n';
    let bestaat = true;
    try { fs.lstatSync(pv); } catch (e) { bestaat = false; }
    if (!bestaat) { o.vv.schrijf(pv, KOP + regels + '\n<!-- tombstones eind -->\n'); return; }
    o.vv.wijzig(pv, function (t) {
      const al = I.tombstonesUitTekst(t);
      const nieuw = set.filter((s) => !al.has(s));
      if (!nieuw.length) return null;
      const r = nieuw.map((s) => s + ' ' + wanneer.slice(0, 10) + ' ' + reden).join('\n') + '\n';
      const i = t.indexOf('<!-- tombstones eind -->');
      return i >= 0 ? t.slice(0, i) + r + t.slice(i) : t.replace(/\n?$/, '\n') + r;
    });
  }

  // Een bestand wissen zonder een symlink te volgen: map als descriptor openen en toetsen (vault-veilig opPlek), dan via die descriptor.
  function wis(abs) {
    const map = path.dirname(abs), naam = path.basename(abs);
    const dfd = fs.openSync(map, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      if (!o.vv.opPlek(dfd, map)) throw new Error('map loopt via een symlink: ' + map);
      const p = '/proc/self/fd/' + dfd + '/' + naam;
      let st;
      try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
      if (!st.isFile()) throw new Error('geen gewoon bestand: ' + naam);
      fs.unlinkSync(p);
      return true;
    } finally { fs.closeSync(dfd); }
  }
  // Een opnamemap leeg maken en weghalen (wv2069): elk gewoon bestand via wis, daarna de mappen van diep naar ondiep (rmdir: alleen leeg).
  // Een symlink in de map wordt niet gevolgd en niet gewist; dan blijft de map staan en telt hij als overgeslagen.
  function wisMap(abs) {
    const tel = { bestanden: 0, mappen: 0, overgeslagen: 0 };
    let st;
    try { st = fs.lstatSync(abs); } catch (e) { if (e.code === 'ENOENT') return tel; throw e; }
    if (!st.isDirectory()) { tel.overgeslagen++; return tel; }
    const mappen = [''];
    loop(abs, function (a, rel) { try { if (wis(a)) tel.bestanden++; } catch (e) { tel.overgeslagen++; } });
    (function verzamel(rel) {
      let namen = [];
      try { namen = fs.readdirSync(path.join(abs, rel), { withFileTypes: true }); } catch (e) { return; }
      for (const d of namen) if (d.isDirectory() && !d.isSymbolicLink()) { const r = rel ? rel + '/' + d.name : d.name; mappen.push(r); verzamel(r); }
    })('');
    for (const rel of mappen.sort((a, b) => b.length - a.length)) {
      const m = rel ? path.join(abs, rel) : abs;
      const dfd = fs.openSync(path.dirname(m), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        if (!o.vv.opPlek(dfd, path.dirname(m))) { tel.overgeslagen++; continue; }
        const p = '/proc/self/fd/' + dfd + '/' + path.basename(m);
        let x;
        try { x = fs.lstatSync(p); } catch (e) { continue; }
        if (!x.isDirectory()) { tel.overgeslagen++; continue; }
        try { fs.rmdirSync(p); tel.mappen++; } catch (e) { tel.overgeslagen++; }
      } finally { fs.closeSync(dfd); }
    }
    return tel;
  }

  // herinneringen (wv2069): stukken en spoor van de opname weg; de opnamerij blijft met alleen ids (zie de kop). Binnen een transactie.
  // de categorie van een herinnering (31-10-2026, herinneringen.js voegt de kolommen toe; een oudere databank heeft ze niet)
  const catKolom = () => db.prepare('PRAGMA table_info(ramble)').all().some((k) => k.name === 'categorie');
  function rambleSchoon(rambleIds, tel, aanwezig) {
    if (!aanwezig.has('ramble')) return;
    for (const rid of rambleIds || []) {
      for (const t of ['ramble_stuk', 'ramble_spoor']) if (aanwezig.has(t)) tel[t] = (tel[t] || 0) + db.prepare('DELETE FROM ' + t + ' WHERE ramble_id = ?').run(rid).changes;
      tel.ramble = (tel.ramble || 0) + db.prepare("UPDATE ramble SET status = 'verwijderd', apparaat = NULL, aantal = NULL, manifest = NULL, opgenomen_op = NULL, verteller = NULL, " +
        'duur_s = NULL, vingerafdruk = NULL, onvolledig = 0, archief_op = NULL, wacht_plafond = NULL, marker = NULL, kaart_op = NULL, keuze = NULL, keuze_op = NULL, ' +
        'notitie = NULL, notitie_op = NULL, offsite_ok = 0, gemeld = NULL' + (catKolom() ? ', categorie = NULL, herinnering_gevoelig = NULL, categorie_gekozen = NULL' : '') +
        ' WHERE ramble_id = ?').run(rid).changes;
    }
  }

  // intake.sqlite: alles van deze stukken weg behalve één stukrij met alleen ids (status verwijderd); blobrijen weg; spoorregel per sha.
  function schoonDb(stukIds, set, wanneer, rambleIds) {
    db.exec('PRAGMA secure_delete = ON');
    const trig = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'besluit'").all();
    const tel = {}, aanwezig = tabellen();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const t of trig) db.exec('DROP TRIGGER IF EXISTS "' + t.name.replace(/"/g, '') + '"');
      for (const id of stukIds) {
        for (const tabel of STUK_TABELLEN.filter((t) => aanwezig.has(t))) {
          const n = db.prepare('DELETE FROM ' + tabel + ' WHERE stuk_id = ?').run(id).changes;
          tel[tabel] = (tel[tabel] || 0) + n;
        }
        const s = q.stuk.get(id);
        db.prepare("UPDATE stuk SET status = 'verwijderd', bron_id = ?, meta = '{}', afgeleid = NULL, stand = NULL, bestandsnaam = NULL, marker_soorten = NULL, gemeld = NULL WHERE stuk_id = ?")
          .run(String(s.bron_id).startsWith('verwijderd:') ? s.bron_id : I.verwijderdId(s.bron_id), id);
      }
      rambleSchoon(rambleIds, tel, aanwezig);
      for (const s of set) {
        tel.blob = (tel.blob || 0) + db.prepare('DELETE FROM blob WHERE sha256 = ?').run(s).changes;
        if (aanwezig.has('scansnap')) tel.scansnap_sha = (tel.scansnap_sha || 0) + db.prepare('DELETE FROM scansnap WHERE sha256 = ?').run(s).changes;
        db.prepare('INSERT INTO spoor (tijd, soort, sha256, stuk_id, bron) VALUES (?, ?, ?, ?, ?)').run(wanneer, 'verwijderd', s, null, null);
      }
      for (const t of trig) db.exec(t.sql);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* al terug */ } throw e; }
    let wal = null;
    try { wal = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); } catch (e) { wal = { fout: e.message }; }
    return { tel, wal };
  }

  function telNa(stukIds, set, paden, rambleIds) {
    const inSet = set.map(() => '?').join(',');
    const ids = [...stukIds], inIds = ids.map(() => '?').join(',');
    const r = {
      blob_bestanden: set.filter((s) => fs.existsSync(blobPad(s))).length,
      db_blob: db.prepare('SELECT count(*) n FROM blob WHERE sha256 IN (' + inSet + ')').get(...set).n,
      db_onderdeel: db.prepare('SELECT count(*) n FROM onderdeel WHERE sha256 IN (' + inSet + ') OR stuk_id IN (' + inIds + ')').get(...set, ...ids).n,
      db_inhoud: db.prepare("SELECT count(*) n FROM stuk WHERE stuk_id IN (" + inIds + ") AND (status <> 'verwijderd' OR meta <> '{}' OR bestandsnaam IS NOT NULL OR bron_id NOT LIKE 'verwijderd:%')").get(...ids).n,
      bestanden: paden.filter((p) => { try { fs.lstatSync(p); return true; } catch (e) { return false; } }).length,
    };
    const aanwezig = tabellen();
    for (const t of STUK_TABELLEN.filter((x) => x !== 'onderdeel' && aanwezig.has(x)))
      r['db_' + t] = db.prepare('SELECT count(*) n FROM ' + t + ' WHERE stuk_id IN (' + inIds + ')').get(...ids).n;
    // herinneringen (wv2069): geen opnamerij met inhoud, geen stuk- of spoorrijen, geen map
    if (aanwezig.has('ramble')) {
      r.db_ramble_inhoud = db.prepare("SELECT count(*) n FROM ramble WHERE stuk_id IN (" + inIds + ") AND (status <> 'verwijderd' OR manifest IS NOT NULL OR notitie IS NOT NULL " +
        'OR verteller IS NOT NULL OR vingerafdruk IS NOT NULL OR marker IS NOT NULL OR apparaat IS NOT NULL' + (catKolom() ? ' OR categorie IS NOT NULL' : '') + ')').get(...ids).n;
      const rids = rambleIds || [];
      if (rids.length) {
        const inR = rids.map(() => '?').join(',');
        for (const t of ['ramble_stuk', 'ramble_spoor']) if (aanwezig.has(t)) r['db_' + t] = db.prepare('SELECT count(*) n FROM ' + t + ' WHERE ramble_id IN (' + inR + ')').get(...rids).n;
        r.herinneringen_mappen = o.herinneringen ? rids.reduce((a, rid) => a + rambleTel(rid).mappen, 0) : 'map onbekend';   // review wv2069 MOET 1
      }
    }
    // tweede scan op naam en frontmatter (de sha-treffers telt de bestandstoets hierboven); vindt hij iets, dan is het niet 0
    const vind = zoek(stukIds, new Map());
    r.vault_tweede_scan = vind.treffers.length;
    return r;
  }

  async function voerUit(stukId, opt) {
    opt = opt || {};
    if (!STUK_RE.test(String(stukId))) return { ok: false, reden: 'stuk-id ongeldig' };
    const proef = opt.proef === true;
    if (!proef && !VRAAG_RE.test(String(opt.vraag || ''))) return { ok: false, reden: 'vraag-id (8 hex) van de kaart ontbreekt; zonder Davids Ja geen verwijdering' };
    const reden = proef ? 'proef' : (opt.reden || 'PII_grondwet_3');
    if (!proef && !REDENEN.includes(reden)) return { ok: false, reden: 'reden-code onbekend' };
    const venster = o.buitenVenster ? o.buitenVenster() : null;
    if (venster) return { ok: false, reden: venster };
    let j = leesJournaal(stukId);
    if (j && j.stap === 'klaar') return { ok: true, al_klaar: true, journaal: j };
    if (!j || j.stap === 'geweigerd' || j.stap === 'start') {
      const p = await plan(stukId, { zonder: opt.zonder });
      if (!p.ok) return p;
      if (proef && p.stukken.some((s) => !s.proef)) return { ok: false, reden: '--proef alleen voor verzonnen proefstukken' };
      if (opt.code && opt.code !== p.code) return { ok: false, reden: 'de set veranderde sinds de kaart (code ' + p.code + ' ≠ ' + opt.code + '); nieuwe kaart nodig' };
      j = { stuk: stukId, stap: 'start', reden, vraag: proef ? null : opt.vraag, set: p.set, set_vinger: p.set_vinger, stukken: p.stukken.map((s) => s.stuk_id),
        paden: p.paden.map((t) => ({ soort: t.soort, rel: t.rel, waarom: t.waarom })), afgeleid: p.afgeleid, databank_plan: p.databank, gestart: nuIso(),
        rambles: p.herinneringen ? p.herinneringen.opnames : [], open_kaarten: p.herinneringen ? p.herinneringen.open_kaarten : [],
        herinneringen: p.herinneringen ? path.resolve(o.herinneringen) : null };
      schrijfJson(journaalPad(stukId), j);
    }
    const wortel = (soort, rel) => {
      if (soort === 'vault') return path.join(o.vault, rel);
      for (const w of (o.extraMappen || [])) { const a = path.join(w, rel); try { fs.lstatSync(a); return a; } catch (e) { /* volgende */ } }
      return null;
    };
    // 2. databank (de poort)
    if (!j.databank) {
      const leeg = j.databank_plan && j.databank_plan.telling && Object.entries(j.databank_plan.telling)
        .every(([k, v]) => k === 'bron_niet_proef' || k === 'claim_blijft' || Number(v) === 0);
      if (proef && leeg) j.databank = { niet_gespiegeld: true };
      else {
        let r;
        try { r = await o.rpc('sb_bron_verwijder', { p: { sha256: j.set, stuk: stukId, reden, vraag: j.vraag || undefined } }); }
        catch (e) { return { ok: false, reden: 'databank niet bereikbaar: ' + String(e && e.message || e).slice(0, 200), journaal: journaalPad(stukId) }; }
        if (!r || r.ok !== true) { j.stap = 'geweigerd'; j.weigering = (r && r.reden) || 'geen antwoord'; schrijfJson(journaalPad(stukId), j); return { ok: false, reden: 'databank weigerde: ' + j.weigering }; }
        j.databank = { verwijdering_id: r.verwijdering_id, telling_voor: r.telling_voor, telling_na: r.telling_na, al_verwijderd: !!r.al_verwijderd };
      }
      j.stap = 'databank'; schrijfJson(journaalPad(stukId), j);
    }
    const wanneer = nuIso();
    // 3. tombstones (vóór het wissen)
    if (!j.tombstones) { tombstonesErbij(j.set, reden, wanneer); j.tombstones = wanneer; schrijfJson(journaalPad(stukId), j); }
    const rids = (j.rambles || []).filter((x) => RAMBLE_RE.test(x));
    // hervatten met een andere of geen herinneringen-map zou de opnamemappen overslaan (review wv2069 MOET 1)
    if (rids.length && (!o.herinneringen || (j.herinneringen && path.resolve(o.herinneringen) !== j.herinneringen)))
      return { ok: false, reden: 'stuk is een herinnering, maar de herinneringen-map ontbreekt of wijkt af van het journaal', journaal: journaalPad(stukId) };
    // 3b. herinneringen (wv2069): de opname eerst dicht, zodat de tik van herinneringen.js hem tijdens het wissen niet meer oppakt
    if (rids.length && !j.rambleDicht) {
      for (const rid of rids) db.prepare("UPDATE ramble SET status = 'verwijderd' WHERE ramble_id = ?").run(rid);
      j.rambleDicht = wanneer; schrijfJson(journaalPad(stukId), j);
    }
    // 4–5. blobs en bestanden
    if (!j.bestanden) {
      const tel = { blob: 0, vault: 0, kopie: 0, overgeslagen: 0 };
      for (const s of j.set) { try { if (wis(blobPad(s))) tel.blob++; } catch (e) { tel.overgeslagen++; } }
      const setS = new Set(j.set);
      for (const t of j.paden) {
        const a = wortel(t.soort, t.rel);
        if (!a) continue;
        if (t.waarom === 'sha') { let h = null; try { h = shaBestand(a); } catch (e) { h = null; } if (h && !setS.has(h)) { tel.overgeslagen++; continue; } }
        try { if (wis(a)) tel[t.soort]++; } catch (e) { tel.overgeslagen++; }
      }
      for (const rid of rids) for (const m of rambleMappen(rid)) {
        let w;
        try { w = wisMap(m); } catch (e) { w = { bestanden: 0, mappen: 0, overgeslagen: 1 }; }
        tel.herinneringen = (tel.herinneringen || 0) + w.bestanden; tel.overgeslagen += w.overgeslagen;
      }
      j.bestanden = tel; schrijfJson(journaalPad(stukId), j);
    }
    // 6. intake.sqlite
    if (!j.dbSchoon) { j.dbSchoon = schoonDb(j.stukken, j.set, wanneer, rids); j.stap = 'pod'; schrijfJson(journaalPad(stukId), j); }
    // 7. tekstindex opnieuw bouwen (bouwt uit de vault)
    if (!j.zoekindex && o.zoekindex) {
      let z;
      try { z = await o.zoekindex(); } catch (e) { z = { ok: false, fout: String(e && e.message || e).slice(0, 200) }; }
      j.zoekindex = z; schrijfJson(journaalPad(stukId), j);
    }
    // 8. tellingen na
    const paden = j.paden.map((t) => wortel(t.soort, t.rel) || path.join(o.vault, t.rel));
    const na = telNa(j.stukken, j.set, paden, rids);
    if (o.zoekTel) { try { na.zoekindex = o.zoekTel(j.stukken.concat(j.paden.filter((t) => t.soort === 'vault').map((t) => t.rel))); } catch (e) { na.zoekindex = 'fout'; } }
    // 8b. herinneringen (review wv2069 ZOU 1): een tik die al liep toen de opname dicht ging, kan nog een notitie of rij hebben
    // teruggeschreven. Is de telling niet 0, dan nog één keer: opnamemappen, opnamerijen en de vaulttreffers van de tweede scan (zelfde
    // criteria als het plan: naam of ovis_stuk), en opnieuw tellen. Ook bij een herhaalde aanroep na 'na_niet_nul'.
    let na2 = na;
    if (rids.length && !Object.values(na).every((v) => v === 0)) {
      const tel = { herinneringen: 0, vault: 0, overgeslagen: 0, db: {} };
      for (const rid of rids) for (const m of rambleMappen(rid)) {
        let w;
        try { w = wisMap(m); } catch (e) { w = { bestanden: 0, overgeslagen: 1 }; }
        tel.herinneringen += w.bestanden; tel.overgeslagen += w.overgeslagen;
      }
      db.exec('BEGIN IMMEDIATE');
      try { rambleSchoon(rids, tel.db, tabellen()); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* al terug */ } tel.db_fout = String(e && e.message || e).slice(0, 120); }
      for (const t of zoek(j.stukken, new Map()).treffers) if (t.soort === 'vault') { try { if (wis(t.pad)) tel.vault++; } catch (e) { tel.overgeslagen++; } }
      if (tel.vault && o.zoekindex) { try { tel.zoekindex = await o.zoekindex(); } catch (e) { tel.zoekindex = { ok: false }; } }
      j.naloop = Object.assign({ op: nuIso() }, tel);
      na2 = telNa(j.stukken, j.set, paden, rids);
      if (o.zoekTel) { try { na2.zoekindex = o.zoekTel(j.stukken.concat(j.paden.filter((t) => t.soort === 'vault').map((t) => t.rel))); } catch (e) { na2.zoekindex = 'fout'; } }
    }
    j.na = na2;
    const nul = Object.values(na2).every((v) => v === 0);
    // 9. Verwijderregister (zonder paden: een bestandsnaam kan zelf een naam zijn)
    if (!j.register) {
      const akkoord = proef ? 'proef (verzonnen stuk, geen kaart)' : 'David, Ja met vingerafdruk op de kaart (vraag-id ' + j.vraag + ')';
      const d = j.databank && j.databank.telling_voor ? Object.values(j.databank.telling_voor).reduce((a, b) => a + (Number(b) || 0), 0) : 0;
      const regel = '| ' + wanneer.slice(0, 10) + ' | stuk ' + stukId + (j.stukken.length > 1 ? ' (+' + (j.stukken.length - 1) + ' met dezelfde inhoud)' : '') + ': ' + j.set.length +
        ' sha256 (code ' + j.set_vinger.slice(0, 12) + '), ' + (j.bestanden.blob || 0) + ' blobs, ' + (j.bestanden.vault || 0) + ' vaultbestanden, ' + (j.bestanden.kopie || 0) +
        ' kopieën, ' + (rids.length ? rids.length + ' opname(s) met ' + (j.bestanden.herinneringen || 0) + ' bestanden, ' : '') + d + ' databankrijen | ' + reden + ' | ' + akkoord + ' | geen (bewust); tombstones in [[00_Systeem/Verwijderregister/tombstones]] |\n';
      const pr = path.join(o.vault, REGISTER);
      o.vv.wijzig(pr, function (t) { return t.indexOf('stuk ' + stukId) >= 0 ? null : t.replace(/\n*$/, '\n') + regel; });
      j.register = wanneer; schrijfJson(journaalPad(stukId), j);
    }
    // 10. databank: klaar
    if (j.databank && j.databank.verwijdering_id && !j.databank.klaar) {
      try { const r = await o.rpc('sb_bron_verwijder_klaar', { p_id: j.databank.verwijdering_id, p_pod_telling: Object.assign({ bestanden: j.bestanden }, na2) }); j.databank.klaar = !!(r && r.ok); }
      catch (e) { j.databank.klaar = false; }
    }
    j.stap = nul ? 'klaar' : 'na_niet_nul';
    j.klaar = wanneer;
    schrijfJson(journaalPad(stukId), j);
    return { ok: nul, stuk: stukId, stukken: j.stukken, set_vinger: j.set_vinger, databank: j.databank, bestanden: j.bestanden, sqlite: j.dbSchoon.tel,
      wal: j.dbSchoon.wal, zoekindex: j.zoekindex || null, na: na2, naloop: j.naloop, afgeleid: j.afgeleid, open_kaarten: j.open_kaarten && j.open_kaarten.length ? j.open_kaarten : undefined,
      journaal: journaalPad(stukId) };
  }

  async function lijst() {
    const uit = { cache: 0, vault: 0, databank: null };
    try { const j = JSON.parse(fs.readFileSync(path.join(o.dir, I.TOMB_CACHE), 'utf8')); uit.cache = (j.sha256 || []).length; } catch (e) { uit.cache = e.code === 'ENOENT' ? 0 : 'onleesbaar'; }
    try { uit.vault = I.tombstonesUitTekst(o.vv.lees(path.join(o.vault, I.TOMB_VAULT), null)).size; } catch (e) { uit.vault = 0; }
    try { const r = await o.rpc('sb_tombstone_lijst', {}); uit.databank = r && r.aantal; } catch (e) { uit.databank = 'fout'; }
    return uit;
  }

  return { plan, voerUit, lijst, _zoek: zoek, _setVinger: setVinger };
}

// ── opdrachtregel ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function buitenNachtvenster(ms) {
  const d = new Date(ms || Date.now());
  const hm = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(':', ''));
  return (hm >= 2345 || hm < 330) ? 'niet tussen 23:45 en 03:30 (vault-kopie en nachtketen); later opnieuw' : null;
}
async function hoofd(argv) {
  const [opdracht, stukId] = argv;
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const zonder = []; argv.forEach((a, i) => { if (a === '--zonder' && argv[i + 1]) zonder.push(argv[i + 1]); });
  const DIR = process.env.INTAKE_DIR || '/opt/data/intake', VAULT = process.env.VAULT_DIR || '/opt/data/AI_SecondBrain';
  const STAAT = process.env.VERWIJDER_STAAT || '/opt/data/scripts-staat/sb2-verwijder';
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(DIR, 'intake.sqlite'));
  db.exec('PRAGMA busy_timeout = 10000;');
  const rpc = async (fn, body) => {
    const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, ''), key = process.env.SUPABASE_SERVICE_ROLE || '';
    if (!url || !key) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE ontbreken in de omgeving');
    const r = await fetch(url + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('rpc ' + fn + ' http ' + r.status);
    return r.json();
  };
  const ZI = process.env.ZOEKINDEX_DB || '/opt/data/scripts-staat/sb2-zoekindex/index.sqlite';
  const zoekindex = async () => {
    const rel = '/opt/data/scripts/huidig';
    const r = require('child_process').spawnSync('/opt/data/scripts/huidig/bin/socev-run', ['--naam', 'sb2-zoekindex', '--hartslag', 'sb2-zoekindex', '--max-min', '10', '--',
      'python3', '-I', rel + '/packages/sb2/src/socev_sb2/zoekindex.py', 'bouw', '--vault', VAULT, '--db', ZI, '--grendel', '/opt/data/bin/.vault.lock'],
    { env: Object.assign({}, process.env, { VAULT_DIR: VAULT }), timeout: 15 * 60000, encoding: 'utf8' });
    return { ok: r.status === 0, code: r.status };
  };
  const zoekTel = (naalden) => {
    const z = new DatabaseSync(ZI, { readOnly: true });
    try {
      let n = 0;
      for (const x of naalden) n += z.prepare('SELECT count(*) n FROM blok WHERE pad = ? OR ruw LIKE ?').get(x, '%' + x + '%').n;
      return n;
    } finally { z.close(); }
  };
  const HDIR = process.env.HERINNERINGEN_DIR || '/opt/data/herinneringen';
  const V = maak({ dir: DIR, vault: VAULT, db, vv: require('./vault-veilig.js'), rpc, staat: STAAT, herinneringen: fs.existsSync(HDIR) ? HDIR : null,
    extraMappen: [path.join(DIR, 'schaduw'), '/opt/data/syncthing/versies'].filter((m) => fs.existsSync(m)),
    zoekindex: fs.existsSync(ZI) ? zoekindex : null, zoekTel: fs.existsSync(ZI) ? zoekTel : null, buitenVenster: () => buitenNachtvenster() });
  let uit;
  if (opdracht === 'plan') uit = await V.plan(stukId, { zonder });
  else if (opdracht === 'voer-uit') uit = await V.voerUit(stukId, { vraag: arg('--vraag'), reden: arg('--reden'), proef: argv.includes('--proef'), zonder, code: arg('--code') });
  else if (opdracht === 'lijst') uit = await V.lijst();
  else { process.stderr.write('gebruik: intake-verwijder.js plan <stuk_id> [--zonder <sha>] | voer-uit <stuk_id> (--vraag <8 hex> --code <12 hex> [--reden …] | --proef) | lijst\n'); return 2; }
  process.stdout.write(JSON.stringify(uit, null, 1) + '\n');
  db.close();
  return uit && uit.ok === false ? 1 : 0;
}

module.exports = { maak, buitenNachtvenster, setVinger, MAX_STUKKEN };
if (require.main === module) hoofd(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exitCode = 1; });
