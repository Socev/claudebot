'use strict';
/*
 * wv4134 (besluitenpagina nr 442 = 3C142, David Ja 25-11-2026 21:54): "Wil je dat Intake bij een brief met een afspraak of termijn meteen een
 * knop geeft om die in je agenda of bij je deadlines te zetten?"
 *
 * Eerste snede: per Intake-stuk hooguit één voorstel, op de kaart en in de Geschiedenis.
 *  - Bron: de kandidaten van de datumdetector (rpc sb_kalender_gevonden, wv3679), die bron.stuk = het Intake-stuk dragen. Geen eigen lezing.
 *  - Telt als voorstel: stuk-id, dag vandaag of later, precisie dag of minuut, geen losse weekdag (rel.weekdag); termijn niet als hij al in
 *    Deadlines staat (staat_er 'deadlines'), afspraak niet als hij al in de agenda staat (staat_er 'tijdlijn'); niet als de potloodlaag er al
 *    iets mee deed (één van zijn kandidaat-id's in het potloodregister). Per stuk de vroegste; zelfde dag: termijn eerst.
 *  - "Zet bij Deadlines?" schrijft één regel in ## Actueel van 00_Systeem/Deadlines.md (zelfde tabel en dubbelregel als de factuurregels van
 *    intake-router.js: staat "stuk <id>" er al, dan geen tweede).
 *  - "Zet in agenda?" vraagt alleen een Poortwachter-kaart (luik david_plaatsen, kaart: true). De agenda verandert pas na Davids ✅ met
 *    vingerafdruk (toestemmingsrij agenda-socev). Nooit deelnemers of herhaling (het luik kent ze niet).
 *  - "Nee": nooit meer een voorstel voor dit stuk, en de kandidaat gaat op klopt_niet (weg uit "Gevonden" en nooit een potlood).
 *  - Eén keuze per stuk (eigen staat), zodat dubbel tikken nooit twee kaarten of regels geeft.
 * Puur: alles ingespoten (rpc, potloodIds, luik, oordeel, vv, vault, staatPad, nu). Geen titels of zinnen in log of reden.
 */
const fs = require('fs');
const path = require('path');

const TZ = 'Europe/Amsterdam';
const STUK_RE = /^stk_[0-9]{8}_[0-9a-f]{8}$/;
const DL_PAD = '00_Systeem/Deadlines.md';
const CACHE_MS = 10 * 60000;
const DAGEN = 120;

function dagAms(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: TZ }); }
function plusDagen(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function kort(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
function cel(t, n) { return kort(String(t == null ? '' : t).replace(/[\r\n|]+/g, ' '), n || 200); }
function tijd(t) { const m = /^(\d{2}):(\d{2})/.exec(String(t || '')); return m ? m[1] + ':' + m[2] : null; }
function nlDag(iso) { const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return x ? (+x[3]) + '-' + (+x[2]) + '-' + x[1] : ''; }

// titel van een kandidaat zonder het voorvoegsel van de detector ("Deadline uit: …")
function titelVan(r) { return kort(String(r.titel || '').replace(/^(Afspraak|Deadline) uit: /, '').replace(/^(re|fw|fwd|antw|doorst)\s*:\s*/i, ''), 120) || '(zonder titel)'; }

// entiteit voor de kolom Entiteit van het deadline-register, uit het vaultpad van het stuk
function entiteitVan(pad) {
  const d = String(pad || '').split('/');
  if (d[0] === '10_Zakelijk' && d[1]) return cel(d[1].replace(/_/g, ' '), 40);
  if (d[0] === '20_Prive') return 'Privé';
  return 'Onbekend';
}

// app-link naar een vaultstuk (zelfde vorm en grens als agenda-potlood.js stukLink)
function stukLink(pad) {
  if (typeof pad !== 'string' || !/\.md$/.test(pad) || pad.startsWith('/') || pad.split('/').some((x) => !x || x === '..' || x.startsWith('.'))) return null;
  return 'https://app.socev.dev/' + pad.split('/').map(encodeURIComponent).join('/');
}
function isHagro(pad) { return typeof pad === 'string' && pad.indexOf('10_Zakelijk/HAGRO/') === 0; }

/*
 * kandidaten → Map stuk_id → { ev, ids, soort, dag, tijd, eind, hele_dag, titel, pad }. Puur (getoetst).
 * rijen = sb_kalender_gevonden-rijen; potlood = Set van kandidaat-id's die de potloodlaag al kent.
 */
function kies(rijen, vandaag, potlood) {
  const per = new Map();
  for (const r of Array.isArray(rijen) ? rijen : []) {
    if (!r || typeof r !== 'object') continue;
    const b = r.bron && typeof r.bron === 'object' ? r.bron : {};
    const stuk = String(b.stuk || '');
    const ev = Number(r.event_id);
    if (!STUK_RE.test(stuk) || !Number.isSafeInteger(ev) || ev <= 0) continue;
    const dag = String(r.begin_datum || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dag) || dag < vandaag) continue;
    const soort = r.soort === 'deadline' ? 'deadline' : (r.soort === 'afspraak' ? 'afspraak' : null);
    if (!soort) continue;
    if (r.datum_precisie && r.datum_precisie !== 'dag' && r.datum_precisie !== 'minuut') continue;
    if (b.regel === 'rel.weekdag') continue;
    const st = Array.isArray(b.staat_er) ? b.staat_er : [];
    const lijst = per.get(stuk) || { rijen: [], potlood: false };
    if (potlood && potlood.has(ev)) lijst.potlood = true;
    if (soort === 'deadline' && st.includes('deadlines')) { per.set(stuk, lijst); continue; }
    if (soort === 'afspraak' && st.includes('tijdlijn')) { per.set(stuk, lijst); continue; }
    const heleDag = r.hele_dag !== false;
    lijst.rijen.push({ ev, soort, dag, tijd: heleDag ? null : tijd(r.begin_tijd), eind: heleDag ? null : tijd(r.eind_tijd), hele_dag: heleDag || !tijd(r.begin_tijd),
      titel: titelVan(r), pad: typeof b.bronpad === 'string' ? b.bronpad : null });
    per.set(stuk, lijst);
  }
  const uit = new Map();
  for (const [stuk, l] of per) {
    if (l.potlood || !l.rijen.length) continue;   // de potloodlaag deed er al iets mee: geen tweede voorstel
    l.rijen.sort((a, b) => (a.dag < b.dag ? -1 : a.dag > b.dag ? 1 : (a.soort === b.soort ? (a.tijd || '') < (b.tijd || '') ? -1 : 1 : a.soort === 'deadline' ? -1 : 1)));
    const v = l.rijen[0];
    v.ids = l.rijen.filter((x) => x.soort === v.soort && x.dag === v.dag).map((x) => x.ev);
    uit.set(stuk, v);
  }
  return uit;
}

// Eén regel voor ## Actueel van het deadline-register (vorm: Datum | Entiteit | Wat | Actie | Signaleer | Bron). Geen wikilink (paden verhuizen).
function deadlineRegel(v, stukId, nu) {
  return '| ' + v.dag + ' | ' + entiteitVan(v.pad) + ' | **Termijn: ' + cel(v.titel, 100) + '** — op jouw tik uit OVIS Intake (' + nlDag(dagAms(nu)) + '), stuk ' + stukId +
    ' | Nakijken wat er moet gebeuren; klopt de datum niet, deze regel weghalen | 3 | Socev-app › Intake, stuk ' + stukId + ' |';
}
// regel onder de laatste tabelregel van ## Actueel → nieuwe tekst; null als het stuk er al staat; gooit als de tabel ontbreekt
function deadlineInvoegen(tekst, regel, stukId) {
  const t = String(tekst);
  if (t.indexOf('stuk ' + stukId) >= 0) return null;
  const r = t.split('\n');
  const kop = r.findIndex((x) => /^## Actueel\s*$/.test(x));
  if (kop < 0) { const e = new Error('deadline-register: ## Actueel ontbreekt'); e.code = 'EDLTABEL'; throw e; }
  let eerste = -1, laatste = -1;
  for (let i = kop + 1; i < r.length && !/^## /.test(r[i]); i++) if (/^\|/.test(r[i])) { if (eerste < 0) eerste = i; laatste = i; }
  if (eerste < 0 || laatste - eerste < 1) { const e = new Error('deadline-register: tabel onder ## Actueel ontbreekt'); e.code = 'EDLTABEL'; throw e; }
  r.splice(laatste + 1, 0, regel);
  return r.join('\n');
}

// Poortwachter-kaart (alleen een kaart; de agenda pas na Davids ✅). Zonder eindtijd: 1 uur; hele dag: tot de volgende dag.
function kaartVerzoek(v, proef) {
  let start, eind;
  if (v.hele_dag || !v.tijd) { start = v.dag; eind = plusDagen(v.dag, 1); }
  else {
    start = v.dag + 'T' + v.tijd;
    if (v.eind && v.eind > v.tijd) eind = v.dag + 'T' + v.eind;
    else { const [h, m] = v.tijd.split(':').map(Number); const min = Math.min(h * 60 + m + 60, 23 * 60 + 59); eind = v.dag + 'T' + String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
  }
  const link = stukLink(v.pad);
  const k = { actie: 'david_plaatsen', kaart: true, agenda: proef ? 'proef' : (isHagro(v.pad) ? 'hagro' : 'hoofd'), titel: kort((proef ? 'SOCEV PROEF ' : '') + v.titel, 200),
    start, eind, aanleiding: 'intake wv4134 (jouw tik op Zet in agenda?; jouw ✅ zet het erin)' };
  if (link) k.omschrijving = 'Stuk: ' + link;
  if (proef) k.test = true;
  return k;
}

function leesStaat(p) {
  try { const s = JSON.parse(fs.readFileSync(p, 'utf8')); if (s && typeof s === 'object' && s.stukken && typeof s.stukken === 'object') return s; } catch (e) { /* leeg of nieuw */ }
  return { v: 1, stukken: {} };
}
function schrijfStaat(p, s) {
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

function maak(o) {
  o = o || {};
  const nu = o.nu || Date.now;
  let cache = null;   // { op, vandaag, map }
  let bezig = null;

  async function lees(vers) {
    const t = nu();
    const vandaag = dagAms(t);
    if (!vers && cache && cache.vandaag === vandaag && t - cache.op < CACHE_MS) return cache.map;
    const rij = await o.rpc('sb_kalender_gevonden', { p_van: vandaag, p_tot: plusDagen(vandaag, DAGEN) });
    if (!Array.isArray(rij)) throw new Error('intake-datum: onverwacht antwoord');
    const rijen = rij.map((x) => (x && typeof x === 'object' && x.sb_kalender_gevonden && !x.event_id ? x.sb_kalender_gevonden : x));
    let pl = new Set();
    try { pl = new Set((o.potloodIds ? o.potloodIds() : []).map(Number)); } catch (e) { pl = null; }
    if (pl === null) throw new Error('intake-datum: potloodregister onleesbaar');   // fail-closed: zonder register geen voorstel (anders dubbel)
    const map = kies(rijen, vandaag, pl);
    cache = { op: t, vandaag, map };
    oordelenOpnieuw().catch(function (e) { if (o.fout) o.fout('intake-datum-oordeel', e); });
    return map;
  }

  // Nee → klopt_niet op de kandidaten; mislukt = in de staat (oordeel_open) en later opnieuw (Codex-ontwerpreview ZOU 1)
  async function oordelen(id) {
    const s = leesStaat(o.staatPad), k = s.stukken[id];
    if (!k || k.k !== 'nee' || typeof o.oordeel !== 'function') return;
    const open = [];
    for (const x of (k.oordeel_open || k.ids || [k.ev])) {
      let r = null;
      try { r = await o.oordeel(x, 'klopt_niet'); } catch (e) { r = null; if (o.fout) o.fout('intake-datum-oordeel', e); }
      if (!r || r.status !== 200) open.push(x);
    }
    const s2 = leesStaat(o.staatPad);
    if (!s2.stukken[id]) return;
    if (open.length) s2.stukken[id].oordeel_open = open; else delete s2.stukken[id].oordeel_open;
    schrijfStaat(o.staatPad, s2);
  }
  async function oordelenOpnieuw() {
    const s = leesStaat(o.staatPad);
    for (const [id, k] of Object.entries(s.stukken)) if (k && k.k === 'nee' && Array.isArray(k.oordeel_open) && k.oordeel_open.length) await oordelen(id);
  }

  // Voor de app: datum-veld per stuk-id (ook een gemaakte keuze, zolang de dag niet voorbij is)
  async function voorStukken(ids) {
    const uit = {};
    const s = leesStaat(o.staatPad);
    const vandaag = dagAms(nu());
    let map = null;
    try { map = await lees(false); } catch (e) { map = null; if (o.fout) o.fout('intake-datum-lees', e); }
    for (const id of ids) {
      const k = s.stukken[id];
      if (k) {
        if (k.k !== 'nee' && k.dag >= vandaag) uit[id] = { ev: k.ev, soort: k.soort, dag: k.dag, tijd: k.tijd || null, titel: k.titel || '', staat: k.k };
        continue;
      }
      const v = map && map.get(id);
      if (v) uit[id] = { ev: v.ev, soort: v.soort, dag: v.dag, tijd: v.tijd, titel: v.titel, staat: 'open' };
    }
    return uit;
  }

  // Loopt door een app-antwoord en zet `datum` bij elk beoordeeld stuk (overzicht, werkstroom, geschiedenis). Leesfout = niets erbij.
  async function erbij(body) {
    const stukken = [];
    (function loop(x, diep) {
      if (!x || typeof x !== 'object' || diep > 5) return;
      if (Array.isArray(x)) { for (const y of x) loop(y, diep + 1); return; }
      if (typeof x.stuk_id === 'string' && STUK_RE.test(x.stuk_id) && x.status === 'beoordeeld') stukken.push(x);
      for (const k of Object.keys(x)) if (k !== 'datum' && x[k] && typeof x[k] === 'object') loop(x[k], diep + 1);
    })(body, 0);
    if (!stukken.length) return body;
    const d = await voorStukken(Array.from(new Set(stukken.map((x) => x.stuk_id))));
    for (const x of stukken) if (d[x.stuk_id]) x.datum = d[x.stuk_id];
    return body;
  }

  // POST /app/intake/datum { stuk_id, ev, keuze: deadlines | agenda | nee } → { status, j, reden }
  async function keuze(d) {
    d = d && typeof d === 'object' ? d : {};
    const id = String(d.stuk_id || ''), ev = Number(d.ev), kz = String(d.keuze || '');
    if (!STUK_RE.test(id) || !Number.isSafeInteger(ev) || ev <= 0 || !['deadlines', 'agenda', 'nee'].includes(kz)) return { status: 400, j: { ok: false, fout: 'ongeldig verzoek' }, reden: 'intake-datum ongeldig' };
    if (bezig) return { status: 409, j: { ok: false, fout: 'Even geduld: er loopt al een keuze' }, reden: 'intake-datum bezig' };
    bezig = id;
    try {
      const s = leesStaat(o.staatPad);
      if (s.stukken[id]) return { status: 409, j: { ok: false, fout: 'Voor dit stuk is al gekozen', staat: s.stukken[id].k }, reden: 'intake-datum al gekozen' };
      const map = await lees(true);   // verse lezing: hoort de kandidaat (nog) bij dit stuk, en staat er intussen geen potlood?
      const v = map.get(id);
      if (!v || !v.ids.includes(ev)) return { status: 409, j: { ok: false, fout: 'Dit voorstel geldt niet meer (al geregeld, voorbij of al als potlood in je agenda)' }, reden: 'intake-datum vervallen' };
      if ((kz === 'deadlines' && v.soort !== 'deadline') || (kz === 'agenda' && v.soort !== 'afspraak')) return { status: 400, j: { ok: false, fout: 'Deze keuze past niet bij dit voorstel' }, reden: 'intake-datum soort' };
      const rij = { k: kz, ev, ids: v.ids, soort: v.soort, dag: v.dag, tijd: v.tijd, titel: v.titel, op: new Date(nu()).toISOString() };
      if (kz === 'nee') {
        s.stukken[id] = rij; schrijfStaat(o.staatPad, s); cache = null;
        await oordelen(id);
        return { status: 200, j: { ok: true, staat: 'nee' }, reden: 'intake-datum nee' };
      }
      if (kz === 'deadlines') {
        if (!o.vv || typeof o.vv.wijzig !== 'function') throw new Error('vault-veilig ontbreekt');
        const regel = deadlineRegel(v, id, nu());
        let al = false;
        const ok = o.vv.wijzig(path.join(o.vault, DL_PAD), function (t) {
          const n = deadlineInvoegen(Buffer.isBuffer(t) ? t.toString('utf8') : String(t), regel, id);
          if (n === null) { al = true; return null; }
          return Buffer.from(n, 'utf8');
        }, { grendel: 5 });
        if (!al && !ok) return { status: 503, j: { ok: false, fout: 'Deadlines was net bezet; probeer het zo nog eens' }, reden: 'intake-datum deadlines bezet' };
        rij.al = al;
        s.stukken[id] = rij; schrijfStaat(o.staatPad, s); cache = null;
        return { status: 200, j: { ok: true, staat: 'deadlines', al }, reden: 'intake-datum deadlines' + (al ? ' al' : '') };
      }
      // agenda: alleen een Poortwachter-kaart. Codex-ontwerpreview MOET 1: de keuze staat vast vóór de luikaanroep (een crash of tweede tik
      // daarna geeft nooit een tweede kaart); alleen een zeker mislukte aanroep (antwoord zonder knop_verstuurd) geeft de keuze weer vrij.
      // Een time-out of verbroken verbinding is onzeker: de keuze blijft staan (hooguit geen kaart, nooit twee).
      rij.wacht = true;
      s.stukken[id] = rij; schrijfStaat(o.staatPad, s); cache = null;
      let a = null, onzeker = false;
      try { a = await o.luik(kaartVerzoek(v, !!o.proef)); } catch (e) { a = null; onzeker = true; if (o.fout) o.fout('intake-datum-luik', e); }
      const s2 = leesStaat(o.staatPad);
      if (!a || a.knop_verstuurd !== true) {
        if (onzeker) { s2.stukken[id] = Object.assign({}, rij, { wacht: false, onzeker: true }); schrijfStaat(o.staatPad, s2); return { status: 502, j: { ok: false, fout: 'Onzeker of de agendakaart doorkwam; kijk in Voor jou', staat: 'agenda' }, reden: 'intake-datum kaart onzeker' }; }
        delete s2.stukken[id]; schrijfStaat(o.staatPad, s2);
        return { status: 502, j: { ok: false, fout: 'De agendakaart kwam niet door; probeer het later nog eens' }, reden: 'intake-datum kaart mislukt' };
      }
      rij.wacht = false;
      if (/^ag-\d{1,15}$/.test(String(a.correlatie_id || ''))) rij.kc = String(a.correlatie_id);
      s2.stukken[id] = rij; schrijfStaat(o.staatPad, s2);
      return { status: 200, j: { ok: true, staat: 'agenda' }, reden: 'intake-datum agenda' };
    } finally { bezig = null; }
  }

  // Voor de potloodlaag: kandidaat-id's waar David via Intake al voor koos (agenda, deadlines of nee) → geen potlood
  function gekozenIds() {
    const s = leesStaat(o.staatPad);
    const uit = new Set();
    for (const k of Object.values(s.stukken)) if (k && (k.k === 'agenda' || k.k === 'deadlines' || k.k === 'nee')) for (const x of (k.ids || [k.ev])) uit.add(Number(x));
    return uit;
  }

  function info() {
    const s = leesStaat(o.staatPad);
    const n = { deadlines: 0, agenda: 0, nee: 0 };
    for (const k of Object.values(s.stukken)) if (k && n[k.k] != null) n[k.k]++;
    return { aan: true, gekozen: n, voorstellen: cache ? cache.map.size : null };
  }

  return { erbij, voorStukken, keuze, gekozenIds, info };
}

module.exports = { maak, kies, deadlineRegel, deadlineInvoegen, kaartVerzoek, entiteitVan, DL_PAD };
