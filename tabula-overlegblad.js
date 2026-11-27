'use strict';
/*
 * tabula-overlegblad.js — wv4240 (besluitenpagina nr 957 = L57, David Ja 25-11-2026 22:25; ontwerp mk-scripts/wv4240/ontwerp.md)
 *
 * WAT. Begint er binnen 24 uur een overleg in Davids agenda (maatschap, HAGRO, werkoverleg, artsenoverleg, driehoek, POT-overleg), dan
 * zet de pod in Tabula een nieuw blad klaar: de titel van de afspraak, de agenda (uit de voorbereiding in de Notulen-map, anders de vaste
 * rubrieken van dat overleg) en de open actiepunten uit de vorige notulen (n8n-tabel actie_state, alleen lezen). Daarna typt David.
 *
 * GRENZEN. Alleen NIEUWE bladen: de Worker (POST /blad, rol pod) neemt alleen een blad-id in de pod-reeks overleg-<dag>-<hash> aan en
 * alleen als dat blad nog geen enkele bundel heeft. Het id is deterministisch (entiteit | overleg | begintijd), dus een tweede ronde,
 * een herstart of een tweede agenda met hetzelfde overleg geeft 409 "bestaat" en geen tweede blad. De agenda wordt alleen gelezen.
 * Geen modelaanroep. Log en /health: alleen tellingen, geen titels of inhoud.
 *
 * HET BLAD WEET WAAR HET BIJ HOORT. In de tekst ("Klaargezet door Socev · <entiteit> · <overleg>") en in het register
 * <dir>/overlegbladen.json {blad-id: {entiteit, plek, overleg, begin, notulen_map, gezet}} (alleen metadata) — voor de dagoogst en de
 * plekkeuze. In de tijdlijn van Tabula is de bron van de bundel 's' (Socev) en het apparaat de pod.
 *
 * SCHAKELAAR. <dir>/tabula.json: "aan": false zet alles uit, "overlegblad": false alleen dit. Regels (welke titels, welke entiteit,
 * rubrieken) staan hieronder als STANDAARD en zijn te vervangen door <dir>/overlegblad.json {"regels": [...]}.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASIS = 'https://tabula.socev.dev';
const VENSTER_MS = 24 * 3600 * 1000;
const REGISTER_DAGEN = 60;
const TEKST_MAX = 20000;
const UIT = 'borrel|lunch|salaris|coaching|training|afscheid|meets|nieuwjaar|startbijeenkomst|werksessie';

// entiteit = naam zoals in actie_state (begint ermee) en in de Notulen-map; plek = Tabula-plekcode (PLEK_RE in de Worker)
const STANDAARD = [
  { overleg: 'HAGRO-vergadering', re: '\\bhagro\\b', entiteit: 'HAGRO', plek: 'HAGRO', map: '10_Zakelijk/HAGRO/Notulen', notulen: 'hagro-vergadering',
    rubrieken: ['Opening, vaststellen agenda en notulen', 'Actielijst vorige vergadering', 'Werkgroepen en projecten', 'Partners (SSE, Lariks, MetMaya)', 'POT / POH-GGZ', 'Praktijkoverstijgend', 'Rondje praktijken', 'Rondvraag'] },
  { overleg: 'Driehoeksoverleg ONTIE', re: 'driehoek', entiteit: 'Tolgaarde', plek: 'TG', map: '10_Zakelijk/Tolgaarde/Notulen', notulen: 'driehoek',
    rubrieken: ['Opening', 'Actiepunten vorige keer', 'Evaluatie gestructureerde visite', 'Deelnemende praktijken', 'Werkafspraken Wlz', 'Financiering en declaratie (SSE)', 'Acties per rol (HA/SO/VPK)', 'Volgende overleg'] },
  { overleg: 'Artsenoverleg', re: 'artsenoverleg', entiteit: 'Tolgaarde', plek: 'TG', map: '10_Zakelijk/Tolgaarde/Notulen', notulen: 'artsenoverleg',
    rubrieken: ['Opening', 'Actiepunten vorige keer', 'Inhoudelijke punten', 'Rondvraag'] },
  { overleg: 'Maatschapsvergadering', re: 'maatschap', entiteit: 'Groenhouten', plek: 'GH', map: '10_Zakelijk/Groenhouten/Notulen', notulen: 'maatschap',
    rubrieken: ['Opening', 'Notulen en actiepunten vorige keer', 'Personeel en team', 'Zorgontwikkeling en capaciteit', 'Financiën', 'Nieuw pand', 'Kwaliteit en veiligheid', 'Systemen en administratie', 'Communicatie en nieuwsbrief', 'Rondvraag'] },
  { overleg: 'Werkoverleg', re: 'werk(vloer)?overleg|teamoverleg', entiteit: 'Groenhouten', plek: 'GH', map: '10_Zakelijk/Groenhouten/Notulen', notulen: 'werk(vloer)?overleg|teamoverleg',
    rubrieken: ['Opening', 'Actiepunten vorige keer', 'Werkafspraken', 'Rondvraag'] },
  { overleg: 'POT-overleg', re: '(overleg|vergadering).*\\b(poh|pot)\\b|\\b(poh|pot)\\b.*(overleg|vergadering)', entiteit: 'POT', plek: 'POT', map: '10_Zakelijk/POT_POH_GGZ/Notulen', notulen: 'overleg',
    rubrieken: ['Opening', 'Actiepunten vorige keer', 'Inzet en uren POH-GGZ', 'Financiën en verdeelsleutel', 'Personeel', 'Contracten zorgverzekeraars', 'Rondvraag'] },
];
// Staat de praktijk in de titel, dan wint die (bv. "Werkoverleg Tolgaarde", "Maatschap Tolgaarde").
const PRAKTIJK = [
  { re: /tolgaarde|\bTG\b/i, entiteit: 'Tolgaarde', plek: 'TG', map: '10_Zakelijk/Tolgaarde/Notulen' },
  { re: /groenhouten|\bGH\b/i, entiteit: 'Groenhouten', plek: 'GH', map: '10_Zakelijk/Groenhouten/Notulen' },
];

const isObj = function (x) { return !!x && typeof x === 'object' && !Array.isArray(x); };
const DAGEN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const MAANDEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
function nl(ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(new Date(ms))) p[x.type] = x.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { ymd: p.year + '-' + p.month + '-' + p.day, kort: DAGEN[wd] + ' ' + Number(p.day) + ' ' + MAANDEN[Number(p.month) - 1], hm: p.hour + ':' + p.minute };
}

function regelsGeldig(rs) {
  if (!Array.isArray(rs) || rs.length === 0 || rs.length > 30) return false;
  return rs.every(function (r) {
    if (!isObj(r) || typeof r.overleg !== 'string' || typeof r.re !== 'string' || typeof r.entiteit !== 'string' || typeof r.map !== 'string' || typeof r.notulen !== 'string') return false;
    if (!/^10_Zakelijk\/[^.][^\0]*\/Notulen$/.test(r.map) || r.map.includes('..')) return false;
    try { new RegExp(r.re, 'i'); new RegExp(r.notulen, 'i'); } catch (e) { return false; }
    return !r.rubrieken || (Array.isArray(r.rubrieken) && r.rubrieken.every(function (x) { return typeof x === 'string'; }));
  });
}

// Welk overleg is dit? null = geen overleg (of uitgesloten). Volgorde van de regels telt (HAGRO vóór POT: "HAGRO / POH" is HAGRO).
function herken(titel, regels) {
  const t = String(titel || '');
  if (!t.trim() || new RegExp(UIT, 'i').test(t)) return null;
  for (const r of regels) {
    if (!new RegExp(r.re, 'i').test(t)) continue;
    const uit = { overleg: r.overleg, entiteit: r.entiteit, plek: r.plek || '', map: r.map, notulen: r.notulen, rubrieken: r.rubrieken || ['Opening', 'Actiepunten vorige keer', 'Inhoudelijke punten', 'Rondvraag'] };
    if (r.entiteit === 'Groenhouten' || r.entiteit === 'Tolgaarde') {
      const p = PRAKTIJK.find(function (x) { return x.re.test(t); });
      if (p && p.entiteit !== r.entiteit) { uit.entiteit = p.entiteit; uit.plek = p.plek; uit.map = p.map; }
    }
    return uit;
  }
  return null;
}

function sleutel(h, beginIso) { return h.entiteit + '|' + h.overleg + '|' + new Date(beginIso).toISOString(); }
function bladId(h, beginIso) {
  return 'overleg-' + nl(Date.parse(beginIso)).ymd.replace(/-/g, '') + '-' + crypto.createHash('sha256').update(sleutel(h, beginIso)).digest('hex').slice(0, 8);
}

// Kandidaten uit de tijdlijn: alleen gespiegelde Google-afspraken met een begintijd in (nu, nu + 24 u]. Twee agenda's met hetzelfde
// overleg op dezelfde tijd = één kandidaat (titel met de overlegnaam wint, daarna de langste: "HAGRO-vergadering" boven "HAGRO").
function kandidaten(rijen, regels, nuMs) {
  const per = new Map();
  for (const x0 of Array.isArray(rijen) ? rijen : []) {
    const x = x0 && x0.sb_kalender_tijdlijn && !x0.soort ? x0.sb_kalender_tijdlijn : x0;
    if (!isObj(x) || x.bron_soort !== 'google_spiegel' || x.hele_dag || (x.status && x.status !== 'actief') || typeof x.begin_tijd !== 'string') continue;
    const b = Date.parse(x.begin_tijd);
    if (!Number.isFinite(b) || b <= nuMs || b > nuMs + VENSTER_MS) continue;
    const h = herken(x.titel, regels);
    if (!h) continue;
    const id = bladId(h, x.begin_tijd), titel = String(x.titel).replace(/\s+/g, ' ').trim().slice(0, 120);
    const oud = per.get(id);
    const past = function (t) { return t.toLowerCase().includes(h.overleg.toLowerCase().split(' ')[0]) ? 1 : 0; };   // "HAGRO-vergadering" boven "Hagro Leusderveld"
    if (!oud || past(titel) > past(oud.titel) || (past(titel) === past(oud.titel) && titel.length > oud.titel.length)) per.set(id, { id, h, titel, begin: new Date(b).toISOString(), eind: typeof x.eind_tijd === 'string' ? x.eind_tijd : null });
  }
  return [...per.values()].sort(function (a, b) { return a.begin < b.begin ? -1 : 1; });
}

function schoon(s) {
  return String(s).replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, function (m, a, b) { return b.split('/').pop(); })
    .replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}
// Agendapunten uit een voorbereidingsbestand: onder elke ## kop met "agenda" de punten "### N. …" (als die er zijn) of anders "N. …".
function agendaUitTekst(tekst) {
  const secties = [];
  let cur = null;
  for (const regel of String(tekst).split(/\r?\n/)) {
    const k2 = /^##\s+(.*)$/.exec(regel);
    if (k2) { cur = /agenda/i.test(k2[1]) ? { kop: schoon(k2[1]), koppen: [], lijst: [] } : null; if (cur) secties.push(cur); continue; }
    if (!cur) continue;
    const k3 = /^###\s+\d+[.)]\s+(.+)$/.exec(regel);
    if (k3) { cur.koppen.push(schoon(k3[1])); continue; }
    const n = /^\d+[.)]\s+(.+)$/.exec(regel);
    if (n) cur.lijst.push(schoon(n[1]));
  }
  return secties.map(function (s) { return { kop: s.kop, punten: (s.koppen.length ? s.koppen : s.lijst).filter(Boolean).slice(0, 25) }; }).filter(function (s) { return s.punten.length > 0; });
}
// Het voorbereidingsbestand van die dag in de Notulen-map: naam begint met de datum en bevat "agenda" of "voorbereiding".
function zoekAgenda(vault, map, ymd) {
  const dir = path.join(vault, map);
  let namen = [];
  try { namen = fs.readdirSync(dir); } catch (e) { return null; }
  const kies = namen.filter(function (n) { return n.startsWith(ymd) && /\.md$/i.test(n) && /agenda|voorbereiding/i.test(n); }).sort();
  for (const n of kies) {
    const p = path.join(dir, n);
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.size > 2000000) continue;
      const s = agendaUitTekst(fs.readFileSync(p, 'utf8'));
      if (s.length) return { bestand: n, secties: s };
    } catch (e) { /* volgende */ }
  }
  return null;
}

// Open actiepunten uit de vorige notulen van dit overleg: status open|gemeld, entiteit begint met de entiteit, bron in de Notulen-map
// van die entiteit en met het notulen-patroon van het overleg (regex, hoofdletterongevoelig).
function actiepunten(rijen, h) {
  const ent = h.entiteit.toLowerCase(), map = h.map.replace(/^10_Zakelijk\//, '').toLowerCase(), woord = new RegExp(h.notulen, 'i');
  return (Array.isArray(rijen) ? rijen : []).filter(function (r) {
    if (!isObj(r) || (r.status !== 'open' && r.status !== 'gemeld')) return false;
    const bron = String(r.bron || '').toLowerCase();
    return String(r.entiteit || '').toLowerCase().startsWith(ent) && bron.includes(map + '/') && woord.test(bron) && typeof r.actie === 'string' && r.actie.trim();
  }).sort(function (a, b) { return String(a.deadline || '9999') < String(b.deadline || '9999') ? -1 : 1; }).slice(0, 15).map(function (r) {
    const dl = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(r.deadline || ''));
    const wie = schoon(r.eigenaar || '').slice(0, 60);
    return '- [ ] ' + schoon(r.actie) + (wie ? ' — ' + wie : '') + (dl ? ' (uiterlijk ' + Number(dl[3]) + '-' + Number(dl[2]) + ')' : '');
  });
}

function bladTekst(k, agenda, acties, ok) {
  const t = nl(Date.parse(k.begin)), eind = k.eind && Number.isFinite(Date.parse(k.eind)) ? '–' + nl(Date.parse(k.eind)).hm : '';
  const r = ['# ' + k.titel + ' — ' + t.kort + ' ' + t.hm + eind, '_Klaargezet door Socev · ' + k.h.entiteit + ' · ' + k.h.overleg + '_', '', '## Agenda'];
  if (agenda) {
    for (const s of agenda.secties) {
      if (agenda.secties.length > 1) r.push('### ' + s.kop);
      s.punten.forEach(function (p, i) { r.push((i + 1) + '. ' + p); });
    }
    r.push('', '_Uit de voorbereiding: ' + agenda.bestand.replace(/\.md$/i, '') + '_');
  } else {
    k.h.rubrieken.forEach(function (p, i) { r.push((i + 1) + '. ' + p); });
    r.push('', '_Vaste rubrieken: er lag nog geen voorbereide agenda._');
  }
  r.push('', '## Open actiepunten van vorige keer');
  if (!ok) r.push('_De actiepunten waren nu niet te lezen._');
  else if (acties.length) acties.forEach(function (a) { r.push(a); });
  else r.push('_Geen open actiepunten uit de vorige notulen gevonden._');
  r.push('', '## Aantekeningen', '- ', '');
  return r.join('\n').slice(0, TEKST_MAX);
}

/*
 * o = { dir, vault, fetch, code() → Promise<podcode|null>, tijdlijn(vanYmd, totYmd) → Promise<rijen>, acties() → Promise<rijen>,
 *       primair?() → bool, nu?() → ms, basis? (alleen de toets), log?(regel), fout?(waar, e) }
 */
function maak(o) {
  const dir = o.dir, basis = (o.basis || BASIS).replace(/\/$/, ''), nu = o.nu || Date.now;
  const REG = path.join(dir, 'overlegbladen.json');
  const stand = { laatste_ronde: null, kandidaten: 0, gezet: 0, bestond: 0, fouten: 0, laatste_fout: null, bezig: false };

  function aan() {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, 'tabula.json'), 'utf8')); } catch (e) { j = null; }
    return isObj(j) && j.aan === true && j.overlegblad !== false;
  }
  function regels() {
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'overlegblad.json'), 'utf8')); if (isObj(j) && regelsGeldig(j.regels)) return j.regels; } catch (e) { /* standaard */ }
    return STANDAARD;
  }
  function regLees() { try { const j = JSON.parse(fs.readFileSync(REG, 'utf8')); return isObj(j) ? j : {}; } catch (e) { return {}; } }
  function regSchrijf(r) {
    const grens = nu() - REGISTER_DAGEN * 86400000;
    for (const k of Object.keys(r)) if (!isObj(r[k]) || !(Date.parse(r[k].begin) > grens)) delete r[k];
    const tmp = REG + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(r, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, REG);
  }

  async function plaats(code, id, tekst) {
    const r = await o.fetch(basis + '/blad', { method: 'POST', headers: { authorization: 'Bearer ' + code, 'content-type': 'application/json' },
      body: JSON.stringify({ sheet: id, tekst }), signal: AbortSignal.timeout(20000) });
    await r.text().catch(function () { return ''; });
    if (r.status === 200) return 'gezet';
    if (r.status === 409) return 'bestaat';
    throw new Error('loket /blad gaf HTTP ' + r.status);
  }

  async function ronde() {
    if (stand.bezig || !aan() || (o.primair && !o.primair())) return { gedaan: false };
    stand.bezig = true;
    const uit = { gedaan: true, kandidaten: 0, gezet: 0, bestond: 0, fouten: 0 };
    try {
      const t = nu(), rs = regels();
      const rijen = await o.tijdlijn(nl(t).ymd, nl(t + VENSTER_MS).ymd);
      const ks = kandidaten(rijen, rs, t);
      uit.kandidaten = ks.length;
      const reg = regLees(), nieuw = ks.filter(function (k) { return !reg[k.id]; });
      if (nieuw.length) {
        const code = await o.code();
        if (!code) throw new Error('geen podcode');
        let acties = null, ok = true;
        try { acties = await o.acties(); } catch (e) { ok = false; if (o.fout) o.fout('tabula-overlegblad-acties', e); }
        for (const k of nieuw) {
          try {
            const tekst = bladTekst(k, zoekAgenda(o.vault, k.h.map, nl(Date.parse(k.begin)).ymd), ok ? actiepunten(acties, k.h) : [], ok);
            const u = await plaats(code, k.id, tekst);
            if (u === 'gezet') uit.gezet++; else uit.bestond++;
            reg[k.id] = { entiteit: k.h.entiteit, plek: k.h.plek, overleg: k.h.overleg, begin: k.begin, notulen_map: k.h.map, gezet: new Date(nu()).toISOString(), door: u === 'gezet' ? 'deze ronde' : 'eerder' };
          } catch (e) { uit.fouten++; stand.laatste_fout = String(e && e.message || e).slice(0, 120); if (o.fout) o.fout('tabula-overlegblad', e); }
        }
        regSchrijf(reg);
      }
    } catch (e) { uit.fouten++; stand.laatste_fout = String(e && e.message || e).slice(0, 120); if (o.fout) o.fout('tabula-overlegblad', e); }
    finally { stand.bezig = false; }
    stand.laatste_ronde = new Date(nu()).toISOString();
    stand.kandidaten = uit.kandidaten; stand.gezet += uit.gezet; stand.bestond += uit.bestond; stand.fouten += uit.fouten;
    if (o.log && (uit.gezet || uit.fouten)) o.log('tabula-overlegblad: ' + uit.kandidaten + ' overleg(gen) binnen 24 u, ' + uit.gezet + ' blad gezet, ' + uit.bestond + ' bestond al, ' + uit.fouten + ' fout');
    return uit;
  }
  function health() { return { aan: aan(), laatste_ronde: stand.laatste_ronde, kandidaten: stand.kandidaten, gezet: stand.gezet, bestond: stand.bestond, fouten: stand.fouten, laatste_fout: stand.laatste_fout }; }
  return { ronde, health };
}

module.exports = { maak, K: { STANDAARD, herken, kandidaten, bladId, agendaUitTekst, zoekAgenda, actiepunten, bladTekst, regelsGeldig, nl } };
