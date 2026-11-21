'use strict';
/*
 * agenda-narekenen.js — Socev rekent een voorgesteld agendamoment na vóór het voorstel (wv3704, 21-11-2026; besluitenpagina nr 361 = 3C61,
 * David Ja 21-11 13:11: "Wil je in elk agendavoorstel één regel of het moment past (vrij, werkdag, spreekuur, reis, reistijd)?").
 *
 * WAAROM. Socev keek pas de nacht erna (Agenda-Wachter) of een afspraak past; het schrijfpad toetst alleen "zelfde titel en begintijd". Nu
 * zet de skill agenda-schrijven vóór elk voorstel één regel in het voorstel, berekend door deze module (geen taalmodel).
 *
 * ROUTE. POST /agenda/narekenen { secret, start, eind?, agenda?, locatie?, event_id? }   (secret = API_SECRET of SOCEV_AGENT_SLEUTEL)
 *   start/eind: naakte lokale tijd (Europe/Amsterdam) "JJJJ-MM-DDTUU:MM", of alleen "JJJJ-MM-DD" (hele dag). Geen eind = 1 uur.
 *   event_id: bij verplaatsen de afspraak zelf (telt niet als botsing met zichzelf).
 *   → { ok, regel, kern, delen: {...} }  — regel = "Past het? <kern> · <rooster> · <Promedico> · <reistijd>".
 * CLI (voor Socev): node agenda-narekenen.js <start> [eind] [--agenda hagro] [--locatie "..."] [--event-id X] → print de regel.
 *
 * BRONNEN (alleen lezen):
 *   agenda's   live via het lees-luik (AI - Agenda-Wachter API, actie agenda, met_hagro): David, Gezin, Werk, HAGRO, Schapies.
 *   rooster    tijdlijn (sb_kalender_tijdlijn) feed rooster-tg-artsen: "DS" = werkdag Tolgaarde; geen enkele roosterregel die dag = onbekend.
 *   reizen     tijdlijn soort reis (reispagina's 20_Prive/Reizen).
 *   Promedico  staat.json van de ontvanger + betekenDag() uit promedico-betekenis.js (dezelfde rekenkern als de nachtstap; geen tweede
 *              reconstructie). Niet geopend/oud = "Promedico niet gezien", nooit "vrij". Geen HIS-tekst in de uitkomst: alleen labels en tijden.
 *   reistijd   vorige afspraak met tijd dezelfde dag (David/Werk); schatting alleen als beide plekken een bekende plaats noemen
 *              (hemelsbreed × 1,3 bij 55 km/u + 5 min), anders alleen de tijd ertussen. Geen geocoder, niets naar buiten.
 * Kern: botsing met X > spreekuur/patiënt > op reis > krap (reistijd) > "geen botsing in je agenda's, Promedico niet gezien" (werkdagtijd)
 *   > vrij. Een bron die niet te lezen is staat als "<bron> niet te lezen" in de regel; dan nooit "vrij" maar "niet zeker".
 * Puur op de meegegeven functies (agenda, rpc, leesPromedico), zodat test/agenda-narekenen.sh het met nepbronnen draait.
 */
const path = require('path');
const TZ = 'Europe/Amsterdam';
const DAG_MS = 86400000;
const KAL_NAAM = { David: 'je agenda', Werk: 'Werk', Gezin: 'Gezin', HAGRO: 'HAGRO', Schapies: 'Schapies' };
const EIGEN = ['David', 'Werk'];
// Bekende plaatsen (hemelsbreed rekenen; een praktijknaam telt als zijn plaats). Onbekend = geen schatting.
const PLAATS = {
  blaricum: [52.272, 5.244], leusden: [52.133, 5.430], amersfoort: [52.156, 5.387], utrecht: [52.090, 5.121], hilversum: [52.223, 5.176],
  amsterdam: [52.370, 4.895], soest: [52.173, 5.291], baarn: [52.211, 5.287], huizen: [52.299, 5.241], laren: [52.256, 5.227],
  bussum: [52.273, 5.161], naarden: [52.296, 5.162], zeist: [52.089, 5.233], 'den haag': [52.078, 4.288], rotterdam: [51.924, 4.478],
  woudenberg: [52.081, 5.416], scherpenzeel: [52.080, 5.488], barneveld: [52.140, 5.585], nijkerk: [52.220, 5.486], hoevelaken: [52.175, 5.457],
  ede: [52.040, 5.665], achterveld: [52.135, 5.497], 'de bilt': [52.110, 5.180], bunnik: [52.067, 5.198], nieuwegein: [52.029, 5.081],
  almere: [52.350, 5.264], eemnes: [52.254, 5.257], maarssen: [52.135, 5.040], driebergen: [52.052, 5.281], doorn: [52.033, 5.344],
  veenendaal: [52.028, 5.556], apeldoorn: [52.211, 5.969], arnhem: [51.985, 5.899], zwolle: [52.516, 6.083], schiphol: [52.310, 4.768]
};
const ALIAS = { tolgaarde: 'leusden', groenhouten: 'leusden', 'hap leusden': 'leusden', 'umc utrecht': 'utrecht', 'jaarbeurs': 'utrecht' };

// ── tijd ────────────────────────────────────────────────────────────────────────────────────────────────────
function offsetMs(ms) {   // Amsterdam − UTC op moment ms
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
function lokaalMs(s) {   // "JJJJ-MM-DDTUU:MM" (lokaal) → ms
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return NaN;
  const g = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = g - offsetMs(g); t = g - offsetMs(t);
  const terug = datumVan(t) + 'T' + klokVan(t);
  return terug === s ? t : NaN;   // ongeldige datum of een tijd die in de zomertijdsprong niet bestaat
}
function datumVan(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: TZ }); }
function klokVan(ms) { return new Date(ms).toLocaleTimeString('nl-NL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
function minVan(ms) { const t = klokVan(ms).split(':'); return (+t[0]) * 60 + (+t[1]); }
function geldigeDag(s) { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + 'T12:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; }
function plusDagen(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekdag(s) { return new Date(s + 'T12:00:00Z').getUTCDay(); }   // 0 = zo
function kort(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ── plaats en reistijd ──────────────────────────────────────────────────────────────────────────────────────
function plaatsVan(loc) {
  const t = ' ' + String(loc || '').toLowerCase().replace(/[^a-zà-ÿ0-9 ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  if (t.trim() === '') return null;
  for (const a of Object.keys(ALIAS)) if (t.indexOf(' ' + a + ' ') >= 0) return ALIAS[a];
  let best = null;
  for (const p of Object.keys(PLAATS)) { const i = t.lastIndexOf(' ' + p + ' '); if (i >= 0 && (!best || i > best.i)) best = { p: p, i: i }; }
  return best ? best.p : null;   // de laatste plaatsnaam in het adres (straatnaam kan een plaatsnaam bevatten)
}
function reisMin(a, b) {
  if (a === b) return 5;
  const A = PLAATS[a], B = PLAATS[b], r = Math.PI / 180;
  const km = 6371 * Math.acos(Math.min(1, Math.sin(A[0] * r) * Math.sin(B[0] * r) + Math.cos(A[0] * r) * Math.cos(B[0] * r) * Math.cos((B[1] - A[1]) * r)));
  return Math.round((km * 1.3 / 55) * 60 / 5) * 5 + 5;
}
function hoofdletter(p) { return p.replace(/(^|\s)\S/g, function (c) { return c.toUpperCase(); }); }

// ── invoer ──────────────────────────────────────────────────────────────────────────────────────────────────
function leesVerzoek(d) {
  d = d || {};
  const s = String(d.start || '').trim(), e = String(d.eind || '').trim();
  const v = { agenda: ['hoofd', 'gezin', 'werk', 'hagro'].indexOf(String(d.agenda || 'hoofd')) >= 0 ? String(d.agenda || 'hoofd') : null,
    locatie: kort(d.locatie || '', 200), event_id: /^[A-Za-z0-9_@.-]{3,1024}$/.test(String(d.event_id || '')) ? String(d.event_id) : '' };
  if (!v.agenda) return { fout: 'agenda moet hoofd, gezin, werk of hagro zijn' };
  if (geldigeDag(s)) {
    if (e && !(geldigeDag(e) && e >= s)) return { fout: 'eind moet een datum op of na start zijn' };
    if (e && e !== s) return { fout: 'reken één dag tegelijk na (hele dag: alleen start)' };
    v.heel = true; v.dag = s; v.van = 0; v.tot = 1440;
    v.ms0 = lokaalMs(s + 'T00:00'); v.ms1 = lokaalMs(plusDagen(s, 1) + 'T00:00');
    return v;
  }
  const a = lokaalMs(s);
  if (!Number.isFinite(a)) return { fout: 'start moet JJJJ-MM-DDTUU:MM (lokale tijd) of JJJJ-MM-DD zijn' };
  const b = e ? lokaalMs(e) : a + 3600000;
  if (!Number.isFinite(b) || b <= a) return { fout: 'eind moet een lokale tijd na start zijn' };
  if (datumVan(b - 1) !== datumVan(a)) return { fout: 'reken één dag tegelijk na (start en eind op dezelfde dag)' };
  v.heel = false; v.dag = datumVan(a); v.ms0 = a; v.ms1 = b; v.van = minVan(a); v.tot = datumVan(b) === v.dag ? minVan(b) : 1440;
  return v;
}

// ── rekenen ─────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * reken(v, bron) — bron: { events: [...]|null (lees-luik, null = niet te lezen), tijdlijn: [...]|null, promedico: {x, fout}|null, nuMs, B }
 * → { kern, regel, delen }
 */
function reken(v, bron) {
  const B = bron.B;
  const nu = Number.isFinite(bron.nuMs) ? bron.nuMs : Date.now();
  const delen = {}; const onzeker = [];
  let kern = null;
  // 1. agenda's
  const ev = [];
  if (!Array.isArray(bron.events)) { onzeker.push('agenda\'s'); delen.agendas = 'agenda\'s niet te lezen'; }
  else {
    for (const e of bron.events) {
      if (!e || e.status === 'cancelled' || !KAL_NAAM[e.kalender]) continue;
      if (v.event_id && e.event_id === v.event_id) continue;
      if (e.hele_dag) {
        const eind = geldigeDag(e.einde) ? e.einde : plusDagen(e.start, 1);
        if (e.start <= v.dag && v.dag < eind) ev.push({ kal: e.kalender, titel: kort(e.titel || '(zonder titel)', 60), heel: true, locatie: e.locatie || '' });
        continue;
      }
      const a = Date.parse(e.start), b = Date.parse(e.einde || e.start);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      ev.push({ kal: e.kalender, titel: kort(e.titel || '(zonder titel)', 60), heel: false, a: a, b: b, locatie: e.locatie || '' });
    }
    const raak = ev.filter(function (e) { return !e.heel && e.a < v.ms1 && e.b > v.ms0; });
    const volgorde = ['David', 'Werk', 'Gezin', 'Schapies', 'HAGRO'];
    raak.sort(function (x, y) { return volgorde.indexOf(x.kal) - volgorde.indexOf(y.kal) || x.a - y.a; });
    if (raak.length) {
      const tekst = raak.slice(0, 2).map(function (e) {
        const w = e.kal === 'Gezin' ? ' (kan voor een gezinslid zijn)' : e.kal === 'HAGRO' ? ' (HAGRO-agenda, gaat David erheen?)' : '';
        return '"' + e.titel + '" (' + KAL_NAAM[e.kal] + ' ' + klokVan(e.a) + '–' + klokVan(e.b) + ')' + w;
      }).join(' en ') + (raak.length > 2 ? ' en nog ' + (raak.length - 2) : '');
      kern = 'botsing met ' + tekst;
      delen.agendas = raak.length + ' overlap';
    } else delen.agendas = 'geen overlap';
    const heel = ev.filter(function (e) { return e.heel && EIGEN.indexOf(e.kal) >= 0; });
    if (heel.length) delen.hele_dag = 'hele dag in ' + KAL_NAAM[heel[0].kal] + ': "' + heel[0].titel + '"' + (heel.length > 1 ? ' (+' + (heel.length - 1) + ')' : '');
    if (v.heel) {
      const eigenMetTijd = ev.filter(function (e) { return !e.heel && EIGEN.indexOf(e.kal) >= 0 && e.a < v.ms1 && e.b > v.ms0; });
      if (eigenMetTijd.length && !kern) kern = 'botsing met ' + eigenMetTijd.length + ' afspraak' + (eigenMetTijd.length > 1 ? 'en' : '') + ' die dag';
    }
  }
  // 2. rooster en reizen (tijdlijn)
  let werkdag = null;
  if (!Array.isArray(bron.tijdlijn)) { onzeker.push('rooster'); delen.rooster = 'rooster niet te lezen'; }
  else {
    const rijen = bron.tijdlijn.map(function (r) { return r && r.sb_kalender_tijdlijn ? r.sb_kalender_tijdlijn : r; }).filter(Boolean);
    const opDag = function (r) { const s = r.begin_datum, e = r.eind_datum || r.begin_datum; return s && s <= v.dag && v.dag <= e; };
    const rooster = rijen.filter(function (r) { return r.soort === 'dienst' && r.feed === 'rooster-tg-artsen' && opDag(r); });
    if (rooster.some(function (r) { return /^DS\b/.test(String(r.titel || '')); })) { werkdag = true; delen.rooster = 'werkdag Tolgaarde (rooster)'; }
    else if (rooster.length) { werkdag = false; delen.rooster = 'geen werkdag volgens het rooster'; }
    else delen.rooster = weekdag(v.dag) % 6 === 0 ? 'weekend' : 'rooster voor die dag nog niet bekend';
    const reis = rijen.filter(function (r) { return r.soort === 'reis' && opDag(r); });
    if (reis.length) { delen.reis = 'op reis: ' + kort(reis[0].titel, 70); if (!kern) kern = delen.reis; }
  }
  // 3. Promedico (dezelfde rekenkern als de nachtstap)
  let pmNietGezien = false;
  if (!bron.promedico || bron.promedico.fout) { onzeker.push('Promedico'); delen.promedico = 'Promedico niet te lezen'; }
  else {
    const g = [];
    if (Array.isArray(bron.events)) for (const e of ev) {
      if (e.heel) continue;
      const ag = { David: 'david', Gezin: 'gezin', Werk: 'werk', HAGRO: 'hagro' }[e.kal];
      if (!ag || datumVan(e.a) > v.dag || datumVan(e.b - 1) < v.dag) continue;
      const van = datumVan(e.a) === v.dag ? minVan(e.a) : 0, tot = datumVan(e.b) === v.dag ? minVan(e.b) : 1440;
      if (tot > van) g.push({ id: 'g' + g.length, agenda: ag, van: van, tot: tot });
    }
    g.push({ id: 'voorstel', agenda: 'david', van: v.van, tot: v.tot });
    const d = B.betekenDag(bron.promedico.x || null, g, { datum: v.dag, vandaag: datumVan(nu), nuMs: nu });
    const zelf = (d.botsingen || []).find(function (x) { return x.google_id === 'voorstel'; });
    const blik = d.gezien_tekst ? ' (gezien ' + d.gezien_tekst + ')' : '';
    if (!d.gezien) { pmNietGezien = true; delen.promedico = 'Promedico niet gezien'; }
    else if (!zelf || zelf.uitkomst === 'nb') { pmNietGezien = true; delen.promedico = 'Promedico ' + (d.oud ? 'niet recent gezien' + blik : 'niet te beoordelen' + blik); }
    else if (zelf.uitkomst === 'a') { delen.promedico = 'Promedico: patiënt geboekt' + blik; if (!kern) { kern = 'werkdag-spreekuur: er staat een patiënt geboekt'; delen.promedico = 'Promedico' + blik; } }
    else if (zelf.uitkomst === 'b') { delen.promedico = 'Promedico: ' + zelf.label.replace(/^botst: /, '') + blik; if (!kern) { kern = 'werkdag-spreekuur: ' + zelf.label.replace(/^botst: /, ''); delen.promedico = 'Promedico' + blik; } }
    else if (zelf.uitkomst === 'c') { delen.promedico = 'Promedico: controleer, er staat een blok met onbekende betekenis' + blik; }
    else if (zelf.uitkomst === 'd') { delen.promedico = 'Promedico: staat geblokkeerd' + blik; }
    else delen.promedico = 'Promedico: buiten spreekuur' + blik;
    if (v.heel && d.gezien && !d.oud && d.patienten > 0 && !kern) kern = 'werkdag-spreekuur: ' + d.patienten + ' patiënt' + (d.patienten > 1 ? 'en' : '') + ' geboekt die dag';
  }
  // 4. reistijd vanaf de vorige eigen afspraak dezelfde dag
  if (!v.heel && Array.isArray(bron.events)) {
    const voor = ev.filter(function (e) { return !e.heel && EIGEN.concat(['HAGRO']).indexOf(e.kal) >= 0 && e.b <= v.ms0 && datumVan(e.b) === v.dag; })
      .sort(function (x, y) { return y.b - x.b; })[0];
    if (voor) {
      const tussen = Math.round((v.ms0 - voor.b) / 60000);
      const p1 = plaatsVan(voor.locatie), p2 = plaatsVan(v.locatie);
      if (p1 && p2) {
        const rm = reisMin(p1, p2);
        delen.reistijd = 'reistijd ± ' + rm + ' min vanaf ' + hoofdletter(p1) + ' (vorige afspraak tot ' + klokVan(voor.b) + ', ' + tussen + ' min ertussen)';
        if (rm > tussen && !kern) kern = 'krap: reistijd ± ' + rm + ' min, er zit ' + tussen + ' min tussen';
      } else if (tussen < 90) delen.reistijd = 'vorige afspraak tot ' + klokVan(voor.b) + ' (' + tussen + ' min ertussen' + (voor.locatie || v.locatie ? '; reistijd niet te schatten' : '') + ')';
    }
  }
  // 5. kern
  const werktijd = weekdag(v.dag) % 6 !== 0 && v.van < 18 * 60 && v.tot > 8 * 60;   // ook een hele doordeweekse dag (review wv3704 MOET 1)
  if (!kern) {
    if (onzeker.length) kern = 'niet zeker: ' + onzeker.join(', ') + ' niet te lezen';
    else if (pmNietGezien && (werkdag === true || (werkdag === null && werktijd))) kern = 'geen botsing in je agenda\'s, maar Promedico niet gezien';
    else kern = 'vrij';
  }
  const rest = [delen.rooster, delen.hele_dag, delen.reis && kern !== delen.reis ? delen.reis : null, delen.promedico, delen.reistijd]
    .filter(Boolean).filter(function (x) { return kern.indexOf(x) < 0; });
  const regel = 'Past het? ' + kern + (rest.length ? ' · ' + rest.join(' · ') : '');
  return { kern: kern, regel: regel, delen: delen };
}

/** maak({ agenda(body) → antwoord lees-luik, rpc(fn, body), leesPromedico() → tekst|null, B? }) → { narekenen(d), info() } */
function maak(o) {
  const B = o.B || require(path.join(__dirname, 'promedico-betekenis.js'));
  const st = { laatste: null };
  async function narekenen(d, nuMs) {
    const v = leesVerzoek(d);
    if (v.fout) return { ok: false, fout: v.fout };
    const t0 = Date.now();
    const [events, tijdlijn, promedico] = await Promise.all([
      o.agenda({ actie: 'agenda', start: plusDagen(v.dag, -1), end: v.dag, met_hagro: true }).then(function (r) {
        if (!r || !Array.isArray(r.events) || r.fout || (Array.isArray(r.fouten) && r.fouten.length)) return null;
        return r.events;
      }, function () { return null; }),
      Promise.resolve().then(function () { return o.rpc('sb_kalender_tijdlijn', { p_van: v.dag, p_tot: v.dag }); }).then(function (r) { return Array.isArray(r) ? r : null; }, function () { return null; }),
      Promise.resolve().then(function () {
        const t = o.leesPromedico();
        const s = t == null ? { versie: 2, datums: {} } : JSON.parse(t);
        if (!s || s.versie !== 2 || !s.datums || typeof s.datums !== 'object') return { fout: 'vorm' };
        return { x: Object.prototype.hasOwnProperty.call(s.datums, v.dag) ? s.datums[v.dag] : null };
      }).catch(function () { return { fout: 'staat' }; })
    ]);
    const u = reken(v, { events: events, tijdlijn: tijdlijn, promedico: promedico, nuMs: Number.isFinite(nuMs) ? nuMs : Date.now(), B: B });
    st.laatste = { op: new Date().toISOString(), ms: Date.now() - t0, agendas: !!events, tijdlijn: !!tijdlijn, promedico: !!(promedico && !promedico.fout) };
    return { ok: true, dag: v.dag, hele_dag: v.heel, regel: u.regel, kern: u.kern, delen: u.delen };
  }
  function info() { return Object.assign({ aan: true }, st.laatste ? { laatste: st.laatste } : {}); }
  return { narekenen: narekenen, info: info };
}

module.exports = { maak, reken, leesVerzoek, lokaalMs, plaatsVan, reisMin };

// ── CLI voor Socev: roept de pod-route aan (de Promedico-staat is alleen voor de pod leesbaar) ────────────────
if (require.main === module) {
  const a = process.argv.slice(2); const d = {};
  const pos = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--agenda') d.agenda = a[++i]; else if (a[i] === '--locatie') d.locatie = a[++i]; else if (a[i] === '--event-id') d.event_id = a[++i];
    else if (a[i] === '--json') d._json = true; else pos.push(a[i]);
  }
  d.start = pos[0]; if (pos[1]) d.eind = pos[1];
  const json = d._json; delete d._json;
  d.secret = process.env.API_SECRET || process.env.SOCEV_AGENT_SLEUTEL || '';
  if (!d.start) { console.error('gebruik: node agenda-narekenen.js <JJJJ-MM-DDTUU:MM|JJJJ-MM-DD> [eind] [--agenda hoofd|gezin|werk|hagro] [--locatie "…"] [--event-id X] [--json]'); process.exit(2); }
  fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/agenda/narekenen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d), signal: AbortSignal.timeout(60000) })
    .then(function (r) { return r.text().then(function (t) { return { st: r.status, t: t }; }); })
    .then(function (x) {
      let j = null; try { j = JSON.parse(x.t); } catch (e) { j = null; }
      if (!j) { console.error('pod gaf ' + x.st + ': ' + x.t.slice(0, 200)); process.exit(1); }
      if (json) console.log(JSON.stringify(j, null, 1)); else if (j.ok) console.log(j.regel); else { console.error('niet nagerekend: ' + (j.fout || x.st)); process.exit(1); }
    }, function (e) { console.error('pod niet bereikbaar: ' + e.message); process.exit(1); });
}
