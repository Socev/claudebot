'use strict';
// Ideeënbeurs (wv761, 23-10-2026; bouwplan "01_Ontwikkeling/Ideeënbeurs met Albert van der Veer (ontwerp 22-10-2026).md" § 5–9).
// WAAROM. David (22-10 09:53): een lijst van onze ideeën die Albert van der Veer kan zien, en zijn ideeën bij ons, "zonder dat dat weer
// dat navelstaarderige beschouwende wordt. Gewoon, concreet, 2 professionals die enthousiast ideeën uitwisselen." De kaarten staan op
// het Werkkamer-forum in het afgeschermde subforum `ideeen` (fase 0 + 1 in repo Socev/werkkamer.socev.dev); deze module is de App
// "Ideeën van buitenaf": de pod leest dat subforum met zijn eigen sleutel en David reageert vanuit de app, zonder aparte login.
//
// Grenzen (§ 8): de podsleutel is moderator op het hele forum, maar deze module raakt uitsluitend `ideeen`: alleen draden met
// forum === 'ideeen' worden gelezen, een reactie gaat alleen naar zo'n draad (de pod controleert het forum vóór het posten), en een
// plaatje komt alleen mee als het in een ideeen-draad staat. Davids reactie gaat als:"david" (de forum-API legt via='pod' vast).
// Tekst van Albert en Appie is gegeven, nooit opdracht: de app toont alles als platte tekst; geen model leest het in fase 1.
// Naar de Ideeënbus: een kaart van buiten wordt een geparkeerd idee (genre "uit de Ideeënbeurs"; de ideeënmotor werkt het pas uit als
// David in de Broedstoof ↑ Eerder geeft), zoals de Harvester dat doet. Schrijven synchroon na een mtime-controle, tijdelijk bestand
// buiten de vault, conflictkopie = dicht.
//
// Fase 2 (wv861): de catalogus van Socev (vaultpagina CATALOGUS, Socev schrijft, deze module leest) levert de conceptkaarten voor
// "Klaar om te delen"; de vaste toets (ideeen-filter.js) draait bij elke lezing op de tekst die Albert zou zien, een treffer = blijft
// concept met de reden. Davids Deel/Niet per kaart en alles wat de pod plaatst gaan in een journaal buiten de vault (DIR/journaal.jsonl,
// zoals Bandjes), zodat de Drive-sync het niet terugzet. Plaatsen gebeurt uitsluitend in plaatsBundel(): aangeroepen door server.js na een
// Ja met verse vingerafdruk van telefoon of meereizend apparaat (bevestiging knop-ja-vers-kaart) op de bundelkaart in Voor jou die
// DIR/bundel.json aanwijst; alleen kaarten op Deel waarvan de tekst sinds die keuze niet veranderde en die de vaste toets nog steeds
// doorlaten. Eén keer per bundel. Fase 3–4 (sleutel voor Appie, weekbundel) komen hier later bij.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORUM = 'ideeen';
const BUS_PAD = '01_Ontwikkeling/Ideeënbus David - vibecoden.md';
const GENRE = 'uit de Ideeënbeurs';
const ONS = ['socev', 'david', 'pod', 'n8n'];
const HERKOMST = { albert: 'Albert van der Veer', appie: 'Appie (assistent van Albert van der Veer)' };
const GRENS = { draden: 60, reactie: 800, titel: 70, wat: 300, waarom: 160, parallel: 6, cache_ms: 20000, catalogus_bytes: 300000, bundel_max: 25, toets: 2000 };
const CATALOGUS = '01_Ontwikkeling/Ideeënbeurs - catalogus.md';
const BEVESTIGING_PLAATSEN = 'knop-ja-vers-kaart';   // server.js appKnopBevestiging: Ja op een Voor jou-kaart, verse vingerafdruk, niet van een vaste plek
let Filter = null;
try { Filter = require('./ideeen-filter.js'); } catch (e) { Filter = null; }   // ontbreekt hij (terugrol), dan geen catalogus en geen plaatsen

// Eén regel platte tekst (zoals harvester.js schoon(), maar links mogen blijven: ze staan als tekst, de app maakt er niets klikbaars van)
function plat(t, max) {
  return String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
// Reactietekst: regels blijven, BBCode-plaatjes eruit (apart als nummer), stuurtekens weg
function reactieTekst(t) {
  const plaatjes = [];
  const s = String(t == null ? '' : t).replace(/\[img\]\s*\/api\/afbeelding\/(\d+)\s*\[\/img\]/gi, function (m, n) { plaatjes.push(Number(n)); return ''; })
    .replace(/\[img\][^[]{0,500}\[\/img\]/gi, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
  return { tekst: s, plaatjes: plaatjes };
}
function datumNl(ms) { return new Date(ms).toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'numeric', year: 'numeric' }).replace(/\//g, '-'); }
const groepVan = function (van) { return ONS.indexOf(String(van || '').toLowerCase()) >= 0 ? 'ons' : 'buiten'; };

// deps: { vault, dir, forum(methode, pad, body) -> {status, j} | {status, bin, type}, klok?, fout?(soort, e), harvester? (module voor leesBus) }
function maak(deps) {
  const VAULT = deps.vault, DIR = deps.dir;
  const klok = deps.klok || Date.now;
  const fout = deps.fout || function () {};
  const H = deps.harvester || null;
  const P = { staat: path.join(DIR, 'staat.json'), bus: path.join(VAULT, BUS_PAD), catalogus: path.join(VAULT, CATALOGUS), journaal: path.join(DIR, 'journaal.jsonl'), bundel: path.join(DIR, 'bundel.json') };
  const cache = { draden: {}, lijst: null, op: 0, fout: null, gelezen: null, cat: null, catStempel: null, catFout: null };
  const toetser = deps.filter || (Filter ? Filter.maak({ vault: VAULT }) : null);
  let plaatsBezig = false;

  function mkdir() { fs.mkdirSync(path.join(DIR, 'tmp'), { recursive: true, mode: 0o700 }); try { fs.chmodSync(DIR, 0o700); fs.chmodSync(path.join(DIR, 'tmp'), 0o700); } catch (e) {} }
  function leesJson(p, leeg) { try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return j && typeof j === 'object' ? j : leeg; } catch (e) { return leeg; } }
  function schrijfJson(p, j) { mkdir(); const tmp = p + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex'); fs.writeFileSync(tmp, JSON.stringify(j, null, 1), { mode: 0o600 }); fs.renameSync(tmp, p); }
  function staatLees() { const s = leesJson(P.staat, {}); s.bus = s.bus && typeof s.bus === 'object' ? s.bus : {}; s.gezien_tot = Number(s.gezien_tot) || 0; return s; }

  // ── lezen uit het forum (alleen ideeen) ──
  async function draadVers(d) {
    const c = cache.draden[d.id];
    if (c && c.laatste === d.laatste_bericht_id && c.n === d.n) return c.draad;
    const r = await deps.forum('GET', 'draad/' + d.id + '?stil=1');
    if (r.status !== 200 || !r.j || !r.j.draad) throw new Error('draad ' + d.id + ': forum gaf ' + r.status);
    if (String(r.j.draad.forum).toLowerCase() !== FORUM) return null;   // intussen verplaatst: niet meer van ons
    cache.draden[d.id] = { laatste: d.laatste_bericht_id, n: d.n, draad: r.j };
    return r.j;
  }
  function maakKaart(dj, gezienTot) {
    const d = dj.draad, berichten = dj.berichten || [];
    const eerste = berichten[0] || {};
    const van = String(eerste.van || d.gemaakt_door || '').toLowerCase().slice(0, 30);
    const k = d.kaart && typeof d.kaart === 'object' ? d.kaart : null;
    const kaart = k ? { titel: plat(k.titel, GRENS.titel), wat: plat(k.wat, GRENS.wat), waarom: plat(k.waarom, GRENS.waarom), status: plat(k.status, 20),
      plaatje: Number.isInteger(k.plaatje) ? k.plaatje : null, link: typeof k.link === 'string' && /^https:\/\//.test(k.link) ? k.link.slice(0, 300) : null }
      : { titel: plat(d.titel, GRENS.titel), wat: plat(reactieTekst(eerste.tekst).tekst, GRENS.wat), waarom: '', status: '', plaatje: null, link: null };
    const reacties = berichten.slice(1).map(function (b) {
      const rt = b.gewist ? { tekst: '', plaatjes: [] } : reactieTekst(b.tekst);
      return { id: b.id, van: String(b.van || '').toLowerCase().slice(0, 30), tekst: rt.tekst, plaatjes: rt.plaatjes, op: b.gemaakt_op, gewist: !!b.gewist,
        bewerkt: !!b.bewerkt_op, nieuw: !b.gewist && b.id > gezienTot && groepVan(b.van) === 'buiten' };
    });
    const plaatjes = (kaart.plaatje ? [kaart.plaatje] : []).concat(...reacties.map(function (x) { return x.plaatjes; }));
    return { id: d.id, groep: groepVan(van), van: van, titel: kaart.titel, wat: kaart.wat, waarom: kaart.waarom, status: kaart.status, plaatje: kaart.plaatje,
      link: kaart.link, kaartvorm: !!k, gemaakt: d.gemaakt_op, laatste: d.laatste_op, gesloten: !!d.gesloten, reacties: reacties,
      nieuw: (eerste.id > gezienTot && groepVan(van) === 'buiten' ? 1 : 0) + reacties.filter(function (x) { return x.nieuw; }).length,
      max_id: berichten.reduce(function (m, b) { return Math.max(m, b.id || 0); }, 0), plaatjes_alle: plaatjes };
  }
  async function lees(vers) {
    if (!vers && cache.lijst && klok() - cache.op < GRENS.cache_ms) return cache.lijst;
    const r = await deps.forum('GET', 'draden?forum=' + FORUM);
    if (r.status !== 200 || !r.j || !Array.isArray(r.j.draden)) throw new Error('forum gaf ' + r.status + (r.j && r.j.fout ? ': ' + String(r.j.fout).slice(0, 80) : ''));
    const draden = r.j.draden.filter(function (d) { return String(d.forum).toLowerCase() === FORUM; }).slice(0, GRENS.draden);
    const uit = [];
    for (let i = 0; i < draden.length; i += GRENS.parallel) {
      const deel = await Promise.all(draden.slice(i, i + GRENS.parallel).map(draadVers));
      deel.forEach(function (x) { if (x) uit.push(x); });
    }
    const ids = new Set(draden.map(function (d) { return d.id; }));
    Object.keys(cache.draden).forEach(function (k) { if (!ids.has(Number(k))) delete cache.draden[k]; });
    cache.lijst = uit; cache.op = klok(); cache.gelezen = new Date(klok()).toISOString();
    return uit;
  }
  function busNummers() {
    if (!H || !H.leesBus) return null;
    try { const b = H.leesBus(fs.readFileSync(P.bus, 'utf8')); return b.ok ? b.ideeen : null; } catch (e) { return null; }
  }
  async function lijst(vers) {
    const s = staatLees();
    let ruw;
    try { ruw = await lees(vers); cache.fout = null; }
    catch (e) { cache.fout = String(e && e.message || e).slice(0, 160); fout('ideeen-lees', e); return { ok: false, status: 502, fout: 'het forum is nu niet te lezen; probeer het zo nog eens' }; }
    const bus = busNummers();
    const kaarten = ruw.map(function (dj) {
      const k = maakKaart(dj, s.gezien_tot);
      const b = s.bus[k.id];
      if (b) { k.idee_nr = b.nr; k.op_bus = bus ? bus.some(function (i) { return i.nr === b.nr && (!b.titel || i.titel === b.titel); }) : null; }
      delete k.plaatjes_alle;
      return k;
    }).sort(function (a, b) { return String(b.laatste).localeCompare(String(a.laatste)); });
    const max = ruw.reduce(function (m, dj) { return Math.max(m, ...(dj.berichten || []).map(function (b) { return b.id || 0; })); }, 0);
    const c = concepten();
    return { ok: true, kaarten: kaarten, nieuw: kaarten.reduce(function (n, k) { return n + k.nieuw; }, 0), gezien_tot: s.gezien_tot, max_id: max,
      concepten: c.concepten, catalogus: c.ok, catalogus_fout: c.fout || null, bundel: c.bundel, plaatsing: s.plaatsing || null,
      gelezen: cache.gelezen, forum: 'https://forum.socev.dev' };
  }
  function vindDraad(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    return (cache.lijst || []).find(function (dj) { return dj.draad.id === n; }) || null;
  }

  // ── Naar de Ideeënbus (geparkeerd, zoals de Harvester) ──
  function conflicten(f) {
    try { return fs.readdirSync(path.dirname(f)).filter(function (n) { return n.indexOf(path.basename(f, '.md')) === 0 && /\.conflict/.test(n); }); }
    catch (e) { return []; }
  }
  function vaultSchrijf(f, inhoud, modus) {
    mkdir();
    const tmp = path.join(DIR, 'tmp', path.basename(f) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex'));
    fs.writeFileSync(tmp, inhoud, { mode: modus || 0o644 });
    try { fs.chmodSync(tmp, modus || 0o644); } catch (e) {}
    try { fs.renameSync(tmp, f); }
    catch (e) {
      try { fs.unlinkSync(tmp); } catch (x) {}
      if (!e || e.code !== 'EXDEV') throw e;
      const naast = path.join(path.dirname(f), '.' + path.basename(f) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
      fs.writeFileSync(naast, inhoud, { mode: modus || 0o644 }); fs.renameSync(naast, f);
    }
  }
  // tabelcel en kopregel: geen | [ ] * _ # ` < > %% == ~~ $$ (zoals harvester.js schoon(); tekst van buiten mag de bus niet opmaken)
  function cel(t, max) {
    return plat(t, max * 2).replace(/https?:\/\/\S+/gi, '').replace(/%%|==|~~|\$\$/g, ' ').replace(/[|<>`\[\]*_#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  }
  function naarBus(k) {
    if (!H || !H.leesBus) return { ok: false, status: 503, fout: 'de Ideeënbus is nu niet bereikbaar (Harvester-module ontbreekt)' };
    if (conflicten(P.bus).length) return { ok: false, status: 409, fout: 'er staat een conflictkopie naast de Ideeënbus; los die eerst op' };
    let st, md;
    try { st = fs.statSync(P.bus); md = fs.readFileSync(P.bus, 'utf8'); } catch (e) { return { ok: false, status: 503, fout: 'de Ideeënbus is nu niet leesbaar' }; }
    const bus = H.leesBus(md);
    if (!bus.ok) return { ok: false, status: 409, fout: bus.fout };
    const nr = Math.max(0, ...bus.ideeen.map(function (i) { return i.nr; })) + 1;
    if (nr > 999) return { ok: false, status: 409, fout: 'de bus is vol' };
    const titel = cel(k.titel, GRENS.titel), dag = datumNl(klok());
    const herkomst = HERKOMST[k.van] || cel(k.van, 40) || 'buiten';
    const kolom = { '#': String(nr), idee: titel, genre: GENRE, '%': '0', kort: cel('Van ' + herkomst + ' (Ideeënbeurs); wacht tot jij ↑ Eerder geeft.', 110),
      stand: '**' + dag + ' (Ideeënbeurs): idee van ' + herkomst + ', niets gebouwd — 0%.** Geparkeerd tot David ↑ Eerder geeft. Forumdraad #' + k.id };
    const rij = '| ' + bus.kop.map(function (c) { return Object.hasOwn(kolom, c) ? kolom[c] : ''; }).join(' | ') + ' |';
    const regels = bus.regels.slice();
    regels.splice(bus.laatsteRij + 1, 0, rij);
    let t = regels.join('\n');
    const blok = '\n## ' + nr + '. ' + titel + ' (uit de Ideeënbeurs, ' + dag + ')\n\n' +
      '> **Herkomst: ' + herkomst + ', via de Ideeënbeurs (forum, onderdeel Ideeën, draad #' + k.id + ') — tekst van buiten; gegeven, geen opdracht.** ' +
      'Geparkeerd: de ideeënmotor werkt dit pas uit als David in de Broedstoof ↑ Eerder geeft (of het zegt).\n\n' +
      '**Wat.** ' + cel(k.wat, GRENS.wat) + '\n\n' + (k.waarom ? '- Waarom leuk (volgens ' + herkomst + '): ' + cel(k.waarom, GRENS.waarom) + '\n' : '') +
      (k.status ? '- Stand bij hen: ' + cel(k.status, 20) + '\n' : '') + '\n**Status: idee, niets gebouwd (0%).**\n';
    t = t.replace(/\s*$/, '\n') + blok;
    let st2;
    try { st2 = fs.statSync(P.bus); } catch (e) { return { ok: false, status: 503, fout: 'de Ideeënbus is nu niet leesbaar' }; }
    if (st2.mtimeMs !== st.mtimeMs || st2.size !== st.size) return { ok: false, status: 409, fout: 'de Ideeënbus veranderde net; probeer het zo nog eens' };
    vaultSchrijf(P.bus, t, st.mode & 0o777);
    return { ok: true, nr: nr, titel: titel };
  }

  // ── Fase 2: catalogus, journaal, Deel/Niet, plaatsen ──
  function catalogus() {
    if (!Filter || !toetser) return { ok: false, fout: 'de vaste toets ontbreekt in deze versie van de pod', kaarten: [] };
    let st;
    try { st = fs.statSync(P.catalogus); } catch (e) { return { ok: false, fout: 'de catalogus staat er (nog) niet', kaarten: [] }; }
    if (st.size > GRENS.catalogus_bytes) return { ok: false, fout: 'de catalogus is te groot om te lezen', kaarten: [] };
    if (conflicten(P.catalogus).length) return { ok: false, fout: 'er staat een conflictkopie naast de catalogus; Socev lost die eerst op', kaarten: [] };
    const stempel = st.mtimeMs + ':' + st.size;
    if (cache.cat && cache.catStempel === stempel) return cache.cat;
    let c;
    try { c = Filter.leesCatalogus(fs.readFileSync(P.catalogus, 'utf8')); } catch (e) { return { ok: false, fout: 'de catalogus is nu niet leesbaar', kaarten: [] }; }
    c.kaarten.forEach(function (k) { k.hash = kaartHash(k); });
    cache.cat = { ok: true, kaarten: c.kaarten, fouten: c.fouten }; cache.catStempel = stempel;
    return cache.cat;
  }
  // Wat Albert zou zien (titel, wat, waarom, status, link): verandert dat, dan geldt een eerdere Deel niet meer
  function kaartHash(k) { return crypto.createHash('sha256').update(JSON.stringify([k.titel, k.wat, k.waarom, k.status, k.link || ''])).digest('hex').slice(0, 16); }
  function journaal() {
    const per = {};
    let tekst = '';
    try { tekst = fs.readFileSync(P.journaal, 'utf8'); } catch (e) { return per; }
    tekst.split('\n').forEach(function (r) {
      if (!r.trim()) return;
      let j; try { j = JSON.parse(r); } catch (e) { return; }
      if (!j || typeof j.id !== 'string') return;
      const x = per[j.id] || (per[j.id] = { keuze: null, keuze_hash: null, gedeeld: null, bezig: null, fout: null });
      if (j.soort === 'keuze') { x.keuze = j.keuze; x.keuze_hash = j.hash; x.keuze_op = j.t; }
      else if (j.soort === 'plaats-begin') { x.bezig = { t: j.t, bundel: j.bundel }; x.fout = null; }
      else if (j.soort === 'gedeeld') { x.gedeeld = { draad: j.draad, op: j.t, hash: j.hash }; x.bezig = null; }
      else if (j.soort === 'plaats-fout') { x.fout = { t: j.t, reden: j.reden }; x.bezig = null; }
    });
    return per;
  }
  function journaalSchrijf(regel) {
    mkdir();
    fs.appendFileSync(P.journaal, JSON.stringify(Object.assign({ t: new Date(klok()).toISOString() }, regel)) + '\n', { mode: 0o600 });
    try { fs.chmodSync(P.journaal, 0o600); } catch (e) {}
  }
  function bundelLees() { const b = leesJson(P.bundel, null); return b && typeof b.kaart === 'string' && /^[a-z0-9][a-z0-9_-]{1,60}$/.test(b.kaart) ? b : null; }
  // Conceptkaarten voor de tab: deelbaar concept, nog niet gedeeld. Treffers van de vaste toets live, nooit uit de vault overgenomen.
  function concepten() {
    const c = catalogus();
    const j = journaal();
    const b = bundelLees();
    const lijst = !c.ok ? [] : c.kaarten.filter(function (k) { return k.deelbaar === 'concept' && !(j[k.id] && j[k.id].gedeeld); }).map(function (k) {
      const x = j[k.id] || {};
      const treffers = toetser.toets(Filter.kaartTekst(k));
      const geldig = x.keuze && x.keuze_hash === k.hash;
      return { id: k.id, titel: plat(k.titel, 120), wat: plat(k.wat, 400), waarom: plat(k.waarom, 200), status: plat(k.status, 20), link: k.link && /^https:\/\//.test(k.link) ? k.link.slice(0, 300) : null,
        keuze: geldig ? x.keuze : null, gewijzigd: !!(x.keuze && !geldig), treffers: treffers, vormfout: k.vormfout || [],
        kan_delen: !treffers.length && !(k.vormfout || []).length && !x.bezig, bezig: !!x.bezig, fout: x.fout ? plat(x.fout.reden, 160) : null };
    });
    const aangevinkt = lijst.filter(function (k) { return k.keuze === 'deel' && k.kan_delen; }).length;
    return { ok: c.ok, fout: c.fout, concepten: lijst,
      bundel: b ? { open: !b.afgehandeld, aangevinkt: aangevinkt, afgehandeld: b.afgehandeld || null } : { open: false, aangevinkt: aangevinkt, afgehandeld: null } };
  }
  function keuze(id, wat, apparaat) {
    const c = catalogus();
    if (!c.ok) return { status: 503, j: { ok: false, fout: c.fout } };
    const k = c.kaarten.find(function (x) { return x.id === id; });
    if (!k || k.deelbaar !== 'concept') return { status: 404, j: { ok: false, fout: 'deze kaart staat niet (meer) klaar om te delen' } };
    const x = journaal()[id] || {};
    if (x.gedeeld) return { status: 409, j: { ok: false, fout: 'deze kaart is al gedeeld' } };
    if (x.bezig || plaatsBezig) return { status: 409, j: { ok: false, fout: 'Socev plaatst nu; probeer het zo nog eens' } };
    if (wat === 'deel') {
      const t = toetser.toets(Filter.kaartTekst(k));
      if (t.length || (k.vormfout || []).length) return { status: 409, j: { ok: false, fout: 'deze kaart blijft concept: ' + (t.length ? t.map(function (y) { return y.soort; }).join(', ') : (k.vormfout || []).join(', ')), treffers: t } };
    }
    journaalSchrijf({ soort: 'keuze', id: id, keuze: wat, hash: k.hash, apparaat: String(apparaat || '').slice(0, 40) });
    return { status: 200, j: { ok: true, id: id, keuze: wat } };
  }
  // Is dit de bundelkaart (sleutel uit DIR/bundel.json)? Dan het aantal dat nu op Deel staat, of wanneer hij al afgehandeld is
  // (Fable wv861 #5: ook dan weet Socev dat hij niets mag plaatsen).
  function bundelVoor(sleutel) {
    const b = bundelLees();
    if (!b || b.kaart !== String(sleutel || '')) return null;
    if (b.afgehandeld) return { kaart: b.kaart, afgehandeld: b.afgehandeld, aangevinkt: 0 };
    return { kaart: b.kaart, afgehandeld: null, aangevinkt: concepten().bundel.aangevinkt };
  }
  // Goedkoop (alleen bundel.json): voor de Voor jou-lijst, die de bundelkaart altijd als gevoelig toont (Fable wv861 #4)
  function isBundel(sleutel) { const b = bundelLees(); return !!(b && b.kaart === String(sleutel || '')); }
  // Plaatsen na Davids Ja. Alleen hier gaat er iets van ons naar het forum. Eén keer per bundel (bundel.json krijgt eerst afgehandeld),
  // per kaart eerst plaats-begin in het journaal: een kaart die halverwege bleef hangen wordt nooit vanzelf opnieuw geplaatst.
  async function plaatsBundel(o) {
    o = o || {};
    const b = bundelLees();
    if (!b || b.kaart !== String(o.kaart || '')) return { ok: false, reden: 'geen open bundel voor deze kaart' };
    if (b.afgehandeld) return { ok: false, reden: 'deze bundel is al afgehandeld' };
    if (o.bevestiging !== BEVESTIGING_PLAATSEN) return { ok: false, reden: 'geen Ja met verse vingerafdruk van telefoon of meereizend apparaat' };
    if (plaatsBezig) return { ok: false, reden: 'er loopt al een plaatsing' };
    plaatsBezig = true;
    const uit = { op: new Date(klok()).toISOString(), bundel: b.kaart, vraag_id: String(o.vraagId || '').slice(0, 8), geplaatst: [], overgeslagen: [], fouten: [] };
    try {
      b.afgehandeld = uit.op; b.vraag_id = uit.vraag_id;
      schrijfJson(P.bundel, b);
      const c = catalogus();
      if (!c.ok) {
        // Fable #10: er is nog niets geplaatst; de bundel blijft dan bruikbaar (nieuwe Ja op dezelfde kaart, als hij weer openstaat)
        delete b.afgehandeld; delete b.vraag_id; schrijfJson(P.bundel, b);
        uit.fouten.push({ id: '-', reden: c.fout }); return uit;
      }
      const j = journaal();
      const alle = c.kaarten.filter(function (k) { const x = j[k.id] || {}; return k.deelbaar === 'concept' && x.keuze === 'deel' && !x.gedeeld; });
      const kandidaten = alle.slice(0, GRENS.bundel_max);
      alle.slice(GRENS.bundel_max).forEach(function (k) { uit.overgeslagen.push({ id: k.id, reden: 'meer dan ' + GRENS.bundel_max + ' in één bundel' }); });   // Fable #12
      for (const k of kandidaten) {
        const x = j[k.id] || {};
        if (x.bezig) { uit.overgeslagen.push({ id: k.id, reden: 'eerdere plaatsing onzeker' }); continue; }
        if (x.keuze_hash !== k.hash) { uit.overgeslagen.push({ id: k.id, reden: 'tekst veranderd sinds je Deel koos' }); continue; }
        const t = toetser.toets(Filter.kaartTekst(k));
        if (t.length || (k.vormfout || []).length) { uit.overgeslagen.push({ id: k.id, reden: 'vaste toets: ' + (t.map(function (y) { return y.soort; }).join(', ') || 'vorm') }); continue; }
        journaalSchrijf({ soort: 'plaats-begin', id: k.id, hash: k.hash, bundel: b.kaart });
        const kaart = { titel: k.titel, wat: k.wat, waarom: k.waarom, status: k.status };
        if (k.link) kaart.link = k.link;
        let r;
        try { r = await deps.forum('POST', 'draad', { forum: FORUM, kaart: kaart, als: 'socev' }); }
        catch (e) { r = { status: 0, j: null, fout: String(e && e.message || e) }; }
        if (r.status === 200 && r.j && r.j.ok && Number.isInteger(r.j.id) && String(r.j.forum).toLowerCase() === FORUM) {
          journaalSchrijf({ soort: 'gedeeld', id: k.id, draad: r.j.id, hash: k.hash, bundel: b.kaart });
          uit.geplaatst.push({ id: k.id, draad: r.j.id });
        } else if (r.status >= 400 && r.status < 500) {
          // het forum weigerde (422 vorm, 403): zeker niet geplaatst
          journaalSchrijf({ soort: 'plaats-fout', id: k.id, reden: 'forum ' + r.status + (r.j && r.j.fout ? ': ' + String(r.j.fout).slice(0, 100) : ''), bundel: b.kaart });
          uit.fouten.push({ id: k.id, reden: 'forum ' + r.status });
        } else {
          // geen of een vreemd antwoord: misschien toch geplaatst; plaats-begin blijft staan (onzeker), nooit vanzelf opnieuw
          uit.fouten.push({ id: k.id, reden: 'onzeker (' + (r.status || r.fout || 'geen antwoord') + '); kijk op het forum' });
        }
      }
      cache.op = 0;
      return uit;
    } finally {
      plaatsBezig = false;
      try { const s = staatLees(); s.plaatsing = { op: uit.op, bundel: uit.bundel, geplaatst: uit.geplaatst.length, overgeslagen: uit.overgeslagen.length, fouten: uit.fouten.length, details: uit }; schrijfJson(P.staat, s); } catch (e) { fout('ideeen-plaats', e); }
    }
  }

  // Fable wv861 #6: een kaart die halverwege een plaatsing bleef hangen (plaats-begin zonder vervolg, bv. herstart) nakijken op het forum:
  // staat er een draad van socev met precies die titel in ideeen, dan gedeeld; anders plaats-fout. Machinekamer: node ideeen.js nakijk.
  async function nakijk() {
    const j = journaal(), c = catalogus();
    const open = Object.keys(j).filter(function (id) { return j[id].bezig; });
    if (!open.length) return { ok: true, nagekeken: 0, uit: [] };
    const r = await deps.forum('GET', 'draden?forum=' + FORUM);
    if (r.status !== 200 || !r.j || !Array.isArray(r.j.draden)) return { ok: false, fout: 'forum gaf ' + r.status };
    const uit = [];
    open.forEach(function (id) {
      const k = (c.kaarten || []).find(function (x) { return x.id === id; });
      const d = k && r.j.draden.find(function (x) { return String(x.forum).toLowerCase() === FORUM && x.titel === k.titel && ONS.indexOf(String(x.gemaakt_door || '').toLowerCase()) >= 0; });
      if (d) { journaalSchrijf({ soort: 'gedeeld', id: id, draad: d.id, hash: k.hash, bundel: j[id].bezig.bundel, nagekeken: true }); uit.push({ id: id, draad: d.id }); }
      else { journaalSchrijf({ soort: 'plaats-fout', id: id, reden: 'niet op het forum gevonden (nagekeken)', bundel: j[id].bezig.bundel }); uit.push({ id: id, draad: null }); }
    });
    cache.op = 0;
    return { ok: true, nagekeken: uit.length, uit: uit };
  }

  // ── App-routes ──
  async function app(route, d) {
    d = d || {};
    if (route === 'GET /app/ideeen') { const l = await lijst(false); return l.ok ? { status: 200, j: l } : { status: l.status, j: { ok: false, fout: l.fout } }; }
    if (route.indexOf('GET /app/ideeen/plaatje/') === 0) {
      const n = Number(route.slice('GET /app/ideeen/plaatje/'.length));
      if (!Number.isInteger(n) || n <= 0) return { status: 404, j: { ok: false, fout: 'onbekend plaatje' } };
      try { await lees(false); } catch (e) { return { status: 502, j: { ok: false, fout: 'het forum is nu niet te lezen' } }; }
      // alleen een plaatje dat in een ideeen-draad staat (de podsleutel ziet alles; dit luik niet)
      const s = staatLees();
      const bekend = (cache.lijst || []).some(function (dj) { return maakKaart(dj, s.gezien_tot).plaatjes_alle.indexOf(n) >= 0; });
      if (!bekend) return { status: 404, j: { ok: false, fout: 'onbekend plaatje' } };
      const r = await deps.forum('GET', 'afbeelding/' + n + '?forum=' + FORUM);   // de forum-API geeft 404 als het plaatje niet bij ideeen hoort (review fase 1 #7)
      if (r.status !== 200 || !r.bin || !/^image\/(png|jpeg|gif|webp)$/.test(String(r.type || ''))) return { status: 404, j: { ok: false, fout: 'plaatje niet te laden' } };
      return { status: 200, j: { ok: true, type: r.type, inhoud: r.bin.toString('base64') } };
    }
    if (route === 'POST /app/ideeen/gezien') {
      const tot = Number(d.tot);
      if (!Number.isInteger(tot) || tot < 0) return { status: 400, j: { ok: false, fout: 'tot ontbreekt' } };
      const s = staatLees();
      if (tot > s.gezien_tot) { s.gezien_tot = tot; s.gezien_op = new Date(klok()).toISOString(); schrijfJson(P.staat, s); }
      return { status: 200, j: { ok: true, gezien_tot: s.gezien_tot } };
    }
    if (route === 'POST /app/ideeen/reactie') {
      const tekst = String(d.tekst == null ? '' : d.tekst).replace(/\r\n?/g, '\n').trim();
      if (!tekst) return { status: 400, j: { ok: false, fout: 'schrijf eerst je reactie' } };
      if (tekst.length > GRENS.reactie) return { status: 422, j: { ok: false, fout: 'hooguit ' + GRENS.reactie + ' tekens (nu ' + tekst.length + ')' } };
      // het forum zelf nog eens vragen (vers): alleen een open draad in ideeen
      const n = Number(d.draad);
      if (!Number.isInteger(n) || n <= 0) return { status: 404, j: { ok: false, fout: 'dit idee bestaat niet (meer)' } };
      const g = await deps.forum('GET', 'draad/' + n + '?stil=1');
      if (g.status !== 200 || !g.j || !g.j.draad || String(g.j.draad.forum).toLowerCase() !== FORUM || g.j.draad.gewist_op) return { status: 404, j: { ok: false, fout: 'dit idee bestaat niet (meer)' } };
      if (g.j.draad.gesloten) return { status: 409, j: { ok: false, fout: 'dit idee is gesloten voor reacties' } };
      const r = await deps.forum('POST', 'draad/' + n + '/bericht', { tekst: tekst, als: 'david' });
      if (r.status !== 200 || !r.j || !r.j.ok) return { status: r.status === 422 || r.status === 429 ? r.status : 502, j: { ok: false, fout: (r.j && r.j.fout) ? String(r.j.fout).slice(0, 160) : 'het forum nam de reactie niet aan (' + r.status + ')' } };
      cache.op = 0;   // volgende lezing vers
      return { status: 200, j: { ok: true, id: r.j.id, draad: n } };
    }
    let mk;
    if ((mk = /^POST \/app\/ideeen\/kaart\/(k\d{2,3})\/(deel|niet)$/.exec(route))) return keuze(mk[1], mk[2], d.__apparaat);
    if (route === 'POST /app/ideeen/toets') {
      // waarschuwing boven Davids reactieveld: nooit blokkeren, alleen zeggen wat de vaste toets zou tegenhouden
      if (!toetser) return { status: 200, j: { ok: true, treffers: [], toets: false } };
      return { status: 200, j: { ok: true, treffers: toetser.toets(String(d.tekst == null ? '' : d.tekst).slice(0, GRENS.toets)), toets: true } };
    }
    if (route === 'POST /app/ideeen/naar-ideeenbus') {
      try { await lees(true); } catch (e) { return { status: 502, j: { ok: false, fout: 'het forum is nu niet te lezen' } }; }
      const dj = vindDraad(d.draad);
      if (!dj) return { status: 404, j: { ok: false, fout: 'dit idee bestaat niet (meer)' } };
      const s = staatLees();
      const k = maakKaart(dj, s.gezien_tot);
      if (k.groep !== 'buiten') return { status: 409, j: { ok: false, fout: 'dit is een idee van ons; dat staat al op de bus of in de catalogus' } };
      const oud = s.bus[k.id];
      if (oud) {
        const bus = busNummers();
        if (!bus || bus.some(function (i) { return i.nr === oud.nr && (!oud.titel || i.titel === oud.titel); })) return { status: 409, j: { ok: false, fout: 'dit idee staat al op de Ideeënbus (idee ' + oud.nr + ')' } };
      }
      const r = naarBus(k);
      if (!r.ok) return { status: r.status, j: { ok: false, fout: r.fout } };
      s.bus[k.id] = { nr: r.nr, titel: r.titel, op: new Date(klok()).toISOString() };
      schrijfJson(P.staat, s);
      return { status: 200, j: { ok: true, draad: k.id, idee_nr: r.nr } };
    }
    return { status: 404, j: { ok: false, fout: 'onbekend' } };
  }

  function health() {
    const s = staatLees();
    let cat = null;
    try { const c = concepten(); cat = { ok: c.ok, fout: c.fout || null, concepten: c.concepten.length, aangevinkt: c.bundel.aangevinkt, bundel_open: c.bundel.open }; } catch (e) { cat = { ok: false, fout: 'uitzondering' }; }
    const p = s.plaatsing ? { op: s.plaatsing.op, geplaatst: s.plaatsing.geplaatst, overgeslagen: s.plaatsing.overgeslagen, fouten: s.plaatsing.fouten } : null;
    return { aan: true, gelezen: cache.gelezen, fout: cache.fout, kaarten: cache.lijst ? cache.lijst.length : null, gezien_tot: s.gezien_tot, naar_bus: Object.keys(s.bus).length,
      filter: !!toetser, catalogus: cat, plaatsing: p, plaatst: plaatsBezig };
  }

  return { app: app, lijst: lijst, health: health, mkdir: mkdir, naarBus: naarBus, concepten: concepten, bundelVoor: bundelVoor, isBundel: isBundel, plaatsBundel: plaatsBundel, nakijk: nakijk };
}

module.exports = { maak: maak, plat: plat, reactieTekst: reactieTekst, GRENS: GRENS, GENRE: GENRE, FORUM: FORUM, BUS_PAD: BUS_PAD, CATALOGUS: CATALOGUS, BEVESTIGING_PLAATSEN: BEVESTIGING_PLAATSEN };

// Machinekamer: node ideeen.js nakijk  (podsleutel uit de omgeving, VAULT_DIR en IDEEEN_DIR zoals de pod; schrijft alleen het journaal)
if (require.main === module && process.argv[2] === 'nakijk') {
  const sleutel = process.env.WERKKAMER_SLEUTEL_POD || '';
  const basis = process.env.IDEEEN_FORUM_BASIS || 'https://forum.socev.dev/api/';
  const forum = async function (m, pad) {
    const r = await fetch(basis + pad, { method: m, headers: { 'X-Werkkamer-Sleutel': sleutel }, signal: AbortSignal.timeout(20000) });
    let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j: j };
  };
  const M = maak({ vault: process.env.VAULT_DIR || '/opt/data/AI_SecondBrain', dir: process.env.IDEEEN_DIR || '/opt/data/ideeenbeurs', forum: forum });
  M.nakijk().then(function (u) { console.log(JSON.stringify(u)); process.exit(u.ok ? 0 : 1); }).catch(function (e) { console.error(String(e && e.message || e)); process.exit(2); });
}
