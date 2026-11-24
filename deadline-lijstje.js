'use strict';
// ── Deadlines in het actielijstje (wv3707, besluitenpagina nr 371 = 3C71, David Ja 21-11-2026 13:09) ──
// WAAROM. Van de komende deadlines in 00_Systeem/Deadlines.md is het grootste deel van David ([jij]); ze kwamen alleen als tekst in de
// heartbeat, zonder knop (44 keer geseind, nergens af te tikken). Nu wordt een [jij]-deadline op zijn seinmoment (datum − Signaleer) de
// vierde bron van het actielijstje (AI - Voorwerk, Kies portie 06:30), met Gedaan / Later (verzet) / Hoeft niet. De tik werkt precies die
// ene registerregel bij, zodat de heartbeat er daarna over zwijgt.
// HOE.
//  1. POST /voorwerk/deadlines (n8n AI - Voorwerk, knoop Lees deadlines; pod-geheim in de body): de rijpe [jij]-regels uit ## Actueel.
//     Ontleden gebeurt door kalender_deadlines.py --droog (dezelfde sleutel dl:… als OVIS Calendar; geen tweede parser).
//  2. Bijwerken (verwerk): uit voorwerk_portie de deadline-rijen. Per rij hooguit één schrijfactie in het register, onder de vault-grendel:
//     - getoond (07:05 verstuurd, nog geen tik): "**GESEIND d-m 07:05 (in je actielijstje).**" vooraan in Wat. Gemeten 24-11: dit merkteken
//       laat titel en sleutel van alle 139 regels gelijk. De heartbeat seint een GESEIND-regel pas weer de avond vóór de datum.
//     - later (ook wacht_op/geef_door: keuze later in de portielog): "**GESEIND d-m (in je actielijstje; verzet naar d-m-jjjj).**".
//     - gedaan / laten_vallen: "**AFGEHANDELD|VERVALLEN d-m-jjjj (… in je actielijstje).**" vooraan en de hele regel naar
//       ## Afgehandeld › ### Afgehandeld via je actielijstje (niets gewist; de heartbeat leest alleen ## Actueel).
//     Pas als de ↩️-tijd voorbij is (n8n neemt ↩️ tot 2 min): wacht TIK_RUST_MS na getikt_op. Een eerder merkteken van het lijstje wordt
//     vervangen, nooit gestapeld. De regel wordt gezocht op sleutel (verse --droog) en moet dan nog dezelfde datum hebben en de titel
//     bevatten; anders op datum + titel, en alleen bij precies één treffer. Geen zekere treffer = niets schrijven (logregel, volgende ronde).
const crypto = require('crypto');

const TIK_RUST_MS = 150 * 1000;              // > 2 min ↩️-venster van AI - Voorwerk-knoppen
const TERUG_DAGEN = 14;                       // verlopen [jij]-deadlines hooguit 14 dagen terug (ouder: register-opschoning, 3C86)
// wv3905 (3C56): ook het merkteken van een herinneringskaart in Voor jou (herinnering-kaart.js) telt; t.plek = 'Voor jou'
const MERK_RE = /^\*\*GESEIND \d{1,2}-\d{1,2}(?: \d{2}:\d{2})? \((?:in je actielijstje|in Voor jou)[^)]*\)\.\*\*\s*/;
const AF_KOP = '### Afgehandeld via je actielijstje (sinds 24-11-2026, wv3707)';
const AF_KOP_VJ = '### Afgehandeld via Voor jou (sinds 24-11-2026, wv3905)';
const VJ_MERK_RE = /^\*\*GESEIND \d{1,2}-\d{1,2}(?: \d{2}:\d{2})? \(in Voor jou[^)]*\)\.\*\*/;
const TABEL_KOP = '| Datum | Entiteit | Wat | Actie | Signaleer | Bron |';

function dagNr(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null; }
function dm(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? (+m[3]) + '-' + (+m[2]) : '?'; }
function dmj(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? (+m[3]) + '-' + (+m[2]) + '-' + m[1] : '?'; }
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function kaal(s) {
  return String(s || '').replace(/\[\[([^\]]*?)\\?\|([^\]]*)\]\]/g, '$2').replace(/\[\[([^\]]*)\]\]/g, function (m, x) { return x.split('/').pop(); })
    .replace(/\*\*|__|~~|`/g, '').replace(/<br\/?>/g, ' ').replace(/\s+/g, ' ').trim();
}
// Celgrenzen van een tabelregel: '|' buiten [[…]] en niet na een backslash. Geeft de posities van de scheidingstekens.
function grenzen(r) {
  const uit = [];
  let diep = 0;
  for (let i = 0; i < r.length; i++) {
    if (r[i] === '[' && r[i + 1] === '[') { diep++; i++; continue; }
    if (r[i] === ']' && r[i + 1] === ']' && diep > 0) { diep--; i++; continue; }
    if (r[i] === '\\') { i++; continue; }
    if (r[i] === '|' && diep === 0) uit.push(i);
  }
  return uit;
}
function cellen(r) { const g = grenzen(r), c = []; for (let i = 0; i + 1 < g.length; i++) c.push(r.slice(g[i] + 1, g[i + 1]).trim()); return c; }
// Sectie per regelindex (0-based)
function secties(regels) { let s = null; return regels.map(function (r) { if (r.startsWith('## ')) s = r.slice(3).trim(); return s; }); }

// Weergavetitel: de droog-titel, behalve als die een notitie is ("NIET GESEIND …", "IN DAGPLAN …": kalender_deadlines kent die
// woorden niet als status). Dan: de vetgedrukte notities vooraan eraf (eerste woord een statuswoord); begint de rest met een vetgedrukt
// stuk, dan dat; anders de eerste zin van de rest (hooguit 120 tekens).
const STATUSWOORD = /^(?:NIET|IN|APART|GESEIND|GEMETEN|UPDATE|BESLOTEN|VERSCHOVEN|INGEDIEND|AFGEHANDELD|AFGEROND|AFGEZIEN|VERVALLEN|LOSGELATEN|VERLOPEN|GEPARKEERD|GEANNULEERD|GECORRIGEERD|LET|NB|STAND)\b(?![a-zäëïöüé])/;
function weergave(item, wat) {
  const t = String(item.titel || '');
  if (!STATUSWOORD.test(t)) return t;
  let w = String(wat || '').trim(), m;
  while ((m = /^(?:~~)?\*\*(.+?)\*\*(?:~~)?[\s.:—-]*/.exec(w)) && (STATUSWOORD.test(kaal(m[1])) || /^\d{1,2}-\d{1,2}\b/.test(kaal(m[1])))) w = w.slice(m[0].length);
  m = /^\*\*(.+?)\*\*/.exec(w);
  let k = m ? kaal(m[1]) : kaal(w).split(/(?<=\w{3}[.!?])\s+(?=[A-ZÀ-Þ])/)[0];
  k = String(k || '').replace(/\*/g, '').replace(/^[\s.:—-]+|[\s.:—-]+$/g, '');
  if (k.length < 6) return t;
  return k.length > 120 ? k.slice(0, 119).replace(/\s+\S*$/, '') + '…' : k;
}

// De rijpe [jij]-deadlines op dag `vandaag` (JJJJ-MM-DD): seinmoment (datum − Signaleer, standaard 7) bereikt, datum hooguit 14 dagen
// voorbij. items = --droog-uitvoer; tekst = de pagina (voor de weergavetitel).
// vol (wv3711, besluit nr 423): ook de ruwe cellen Actie en Bron (voor het werkblok-voorstel: werklast "⏱ ± 1 u" staat achteraan in Actie,
// voorbij de 300 tekens van `actie`). Alleen voor POST /deadlines/rijp; de Voorwerk-uitvoer blijft gelijk.
function rijp(items, tekst, vandaag, vol) {
  const v = dagNr(vandaag), regels = String(tekst || '').split('\n'), uit = [];
  if (v === null) return uit;
  for (const i of items || []) {
    if (!i || !i.bron || i.bron.etiket !== 'jij' || !/^dl:[0-9a-f]{40}$/.test(String(i.sleutel))) continue;
    const d = dagNr(i.datum);
    if (d === null) continue;
    const sig = Number.isInteger(i.bron.signaleer) && i.bron.signaleer >= 0 && i.bron.signaleer <= 400 ? i.bron.signaleer : 7;
    if (d - sig > v || d < v - TERUG_DAGEN) continue;
    const r = regels[(Number(i.bron.regel) || 0) - 1] || '';
    const c = r.startsWith('| ' + i.datum + ' |') ? cellen(r) : [];
    const actie = /^Actie: (.*)$/m.exec(String(i.omschrijving || ''));
    const it = { sleutel: i.sleutel, datum: i.datum, titel: weergave(i, c[2] || ''), entiteit: String(i.bron.entiteit || '').slice(0, 120),
      signaleer: sig, actie: actie ? actie[1].slice(0, 300) : '' };
    if (VJ_MERK_RE.test(String(c[2] || ''))) it.voor_jou = true;   // wv3905: staat als herinneringskaart in Voor jou
    if (vol) { it.actie_cel = String(c[3] || '').slice(0, 2000); it.bron_cel = String(c[5] || '').slice(0, 500); }   // wv3711
    uit.push(it);
  }
  uit.sort(function (a, b) { return a.datum.localeCompare(b.datum) || a.sleutel.localeCompare(b.sleutel); });
  return uit;
}

// Zoek de ene regel (index) in ## Actueel. t = { sleutel, datum, titel }. items = verse --droog-uitvoer van dezelfde tekst.
function zoekRegel(regels, items, t) {
  const sec = secties(regels), nt = norm(t.titel).slice(0, 60);
  const past = function (idx) {
    if (idx < 0 || idx >= regels.length || sec[idx] !== 'Actueel' || !regels[idx].startsWith('| ' + t.datum + ' |')) return false;
    // Codex MOET 1: alleen de cel Wat (niet Actie of Bron, waar een andere deadline de titel kan noemen)
    const c = cellen(regels[idx]);
    return c.length === 6 && (!nt || norm(kaal(c[2])).indexOf(nt) >= 0);
  };
  const it = (items || []).find(function (i) { return i && i.sleutel === t.sleutel; });
  if (it) { const idx = (Number(it.bron && it.bron.regel) || 0) - 1; if (past(idx)) return idx; }
  if (!nt || nt.length < 8) return -1;
  const kand = [];
  regels.forEach(function (r, idx) { if (past(idx)) kand.push(idx); });
  return kand.length === 1 ? kand[0] : -1;
}

// Pas één tik toe op de pagina. t = { sleutel, datum, titel, keuze: getoond|later|gedaan|laten_vallen, later_tot, vandaag, tijd }.
// Geeft { tekst } (nieuwe pagina), { niets: reden } (al zo / niet te vinden), nooit een half bewerkte pagina.
function pasToe(tekst, items, t) {
  const regels = String(tekst).split('\n');
  const idx = zoekRegel(regels, items, t);
  if (idx < 0) {
    if (t.keuze === 'gedaan' || t.keuze === 'laten_vallen') {
      const nt = norm(t.titel).slice(0, 60), sec = secties(regels);
      if (nt && regels.some(function (r, i) { const c = cellen(r); return sec[i] === 'Afgehandeld' && r.startsWith('| ' + t.datum + ' |') && c.length === 6 && norm(kaal(c[2])).indexOf(nt) >= 0; })) return { niets: 'al afgehandeld' };
    }
    return { niets: 'regel niet gevonden' };
  }
  const r = regels[idx], g = grenzen(r);
  if (g.length !== 7) return { niets: 'regel heeft geen zes kolommen' };
  const wat = r.slice(g[2] + 1, g[3]).trim(), rest = wat.replace(MERK_RE, '');
  let merk;
  const vj = t.plek === 'Voor jou', plek = vj ? 'in Voor jou' : 'in je actielijstje', afKop = vj ? AF_KOP_VJ : AF_KOP;
  if (t.keuze === 'getoond') merk = '**GESEIND ' + dm(t.vandaag) + (t.tijd ? ' ' + t.tijd : '') + ' (' + plek + ').** ';
  else if (t.keuze === 'later') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t.later_tot))) return { niets: 'later zonder datum' };
    merk = '**GESEIND ' + dm(t.vandaag) + ' (' + plek + '; verzet naar ' + dmj(t.later_tot) + ').** ';
  } else if (t.keuze === 'gedaan' || t.keuze === 'laten_vallen') {
    merk = t.keuze === 'gedaan' ? '**AFGEHANDELD ' + dmj(t.vandaag) + ' (Gedaan ' + plek + ').** '
      : '**VERVALLEN ' + dmj(t.vandaag) + ' (' + (vj ? 'Niet meer nodig, ' : 'Hoeft niet, ') + plek + ').** ';
  } else return { niets: 'onbekende keuze' };
  if (t.keuze === 'getoond' && MERK_RE.test(wat)) {   // getoond overschrijft nooit een verzet-merkteken
    if (!vj || VJ_MERK_RE.test(wat)) return { niets: 'al gemerkt' };
    // wv3905 Codex MOET 2: een nieuwe Voor jou-kaart neemt het lijstje-merkteken over (met een eventuele verzetdatum), zodat de regel
    // niet ook in het actielijstje blijft komen
    const v = /; verzet naar (\d{1,2}-\d{1,2}-\d{4})\)/.exec(wat.match(MERK_RE)[0]);
    if (v) merk = '**GESEIND ' + dm(t.vandaag) + ' (in Voor jou; verzet naar ' + v[1] + ').** ';
  }
  if (t.keuze === 'later' && wat.startsWith(merk.trim())) return { niets: 'al zo' };
  const nieuw = r.slice(0, g[2] + 1) + ' ' + merk + rest + ' ' + r.slice(g[3]);
  if (t.keuze === 'getoond' || t.keuze === 'later') { regels[idx] = nieuw; return { tekst: regels.join('\n'), regel: idx + 1 }; }
  // Gedaan / Hoeft niet: de regel uit Actueel en onderaan de eigen tabel in ## Afgehandeld (aanmaken vóór de volgende ## -kop)
  regels.splice(idx, 1);
  const sec = secties(regels);
  const af = sec.indexOf('Afgehandeld');
  if (af < 0) return { niets: 'geen sectie Afgehandeld' };
  let eind = af + 1;
  while (eind < regels.length && sec[eind] === 'Afgehandeld') eind++;   // eerste regel na de sectie (## Meetlog of einde)
  let kop = -1;
  for (let i = af; i < eind; i++) if (regels[i] === afKop) kop = i;
  if (kop < 0) {
    let k = eind; while (k > af + 1 && regels[k - 1].trim() === '') k--;
    regels.splice(k, 0, '', afKop, '', TABEL_KOP, '|---|---|---|---|---|---|', nieuw);
    return { tekst: regels.join('\n'), regel: idx + 1 };
  }
  // Laatste tabelregel onder de kop: lege regels tot de tabel, dan aaneengesloten '|'-regels
  let i = kop + 1, laatste = -1;
  while (i < regels.length && regels[i].trim() === '' && laatste < 0) i++;
  while (i < regels.length && regels[i].startsWith('|')) { laatste = i; i++; }
  if (laatste < 0) return { niets: 'tabel onder ' + afKop + ' ontbreekt' };
  regels.splice(laatste + 1, 0, nieuw);
  return { tekst: regels.join('\n'), regel: idx + 1 };
}

// Welke portierijen nu een schrijfactie vragen. rijen = voorwerk_portie (n8n), nu = ms, gedaan = Set van al verwerkte merken.
function teDoen(rijen, nu, gedaan, vandaag) {
  const uit = [];
  for (const p of rijen || []) {
    if (!p || p.bron !== 'deadline' || !/^dl:[0-9a-f]{40}$/.test(String(p.sleutel)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.datum))) continue;
    if (dagNr(p.datum) < dagNr(vandaag) - 4) continue;   // alleen recente rijen (na een storing: 4 dagen inhalen)
    let keuze = null, tijd = '';
    if (p.status === 'afgehandeld' && ['gedaan', 'laten_vallen', 'later'].indexOf(p.keuze) >= 0) {
      if (!(nu - Date.parse(p.getikt_op || '') >= TIK_RUST_MS)) continue;   // ↩️ kan nog
      keuze = p.keuze;
    } else if (p.status === 'open' && !p.keuze && p.verzonden_op && p.datum === vandaag) {
      // wv3708 (3C87): het tijdstip waarop het lijstje echt verstuurd werd (zaterdag 08:30); onleesbaar = 07:05 zoals vroeger
      keuze = 'getoond';
      const vt = Date.parse(p.verzonden_op);
      tijd = isFinite(vt) ? new Date(vt).toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' }) : '07:05';
    }
    else continue;
    const merk = crypto.createHash('sha256').update([p.nonce, keuze, p.later_tot || '', p.getikt_op || ''].join('|')).digest('hex').slice(0, 24);
    if (gedaan && gedaan.has(merk)) continue;
    uit.push({ merk: merk, sleutel: p.sleutel, datum: String(p.hard || ''), titel: String(p.titel || ''), keuze: keuze, later_tot: p.later_tot || '',
      vandaag: keuze === 'getoond' ? p.datum : new Date(Date.parse(p.getikt_op)).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' }), tijd: tijd, portiedatum: p.datum });
  }
  // Oudste eerst, zodat een latere tik (bv. Later na getoond) het laatste woord heeft
  uit.sort(function (a, b) { return (a.keuze === 'getoond' ? 0 : 1) - (b.keuze === 'getoond' ? 0 : 1) || a.portiedatum.localeCompare(b.portiedatum); });
  return uit;
}

// Eén tik veilig in het register (ook voor herinnering-kaart.js, wv3905). Codex wv3707 ronde 2 MOET 1: de regelnummers van --droog gelden
// alleen voor de tekst die het las; lees vóór en na de droog en schrijf alleen als beide en de tekst onder de grendel gelijk zijn.
// MOET 2: de rol ook binnen de schrijfactie, vlak vóór het schrijven. Geeft { u: uitkomst van pasToe, ok: geschreven }.
async function schrijf(o, t) {
  const voor = o.lees(), items = (await o.droog()).items, na = o.lees();
  let u = null;
  const ok = voor === na && o.wijzig(function (tekst) {
    if (tekst !== voor) { u = { niets: 'pagina veranderde' }; return null; }
    if (o.mag && !o.mag()) { u = { niets: 'pagina veranderde' }; return null; }
    u = pasToe(tekst, items, t); return u.tekst || null;
  });
  if (voor !== na) u = { niets: 'pagina veranderde' };
  return { u: u, ok: !!ok };
}

// Runner. o = { mag(): bool (primaire pod), droog(): Promise<{items}> of {items}, lees(): tekst, wijzig(f): bool, rijen(): Promise<portierijen>, log(s), fout(e), vandaag() }
function maak(o) {
  const gedaan = new Set(), pogingen = new Map();
  let bezig = null;
  async function deadlines(vol) {
    const d = await o.droog();
    // wv3905: een regel met een herinneringskaart in Voor jou komt niet ook in het actielijstje (één plek per herinnering).
    // wv3711: vol (werkblok-voorstel) neemt ze wel mee: een werkblok is iets anders dan de herinnering.
    const lijst = rijp(d.items, o.lees(), o.vandaag(), !!vol);
    return vol ? lijst : lijst.filter(function (i) { return !i.voor_jou; });
  }
  async function verwerk() {
    if (bezig) return bezig;
    bezig = (async function () {
      const lijst = teDoen(await o.rijen(), Date.now(), gedaan, o.vandaag());
      const uit = { gedaan: 0, niets: 0 };
      for (const t of lijst) {
        if (!t.datum || !t.titel) { gedaan.add(t.merk); uit.niets++; continue; }
        if (o.mag && !o.mag()) { uit.niets++; break; }   // Codex MOET 2: alleen de primaire pod schrijft (rol vóór elke schrijfactie)
        const { u, ok } = await schrijf(o, t);   // Codex ronde 2 MOET 1 + 2: zie schrijf()
        if (u && u.tekst && ok) { gedaan.add(t.merk); uit.gedaan++; o.log('deadline-lijstje ' + t.keuze + ' ' + t.sleutel.slice(0, 11) + ' regel ' + u.regel); }
        else if (u && u.niets && u.niets !== 'regel niet gevonden' && u.niets !== 'pagina veranderde') { gedaan.add(t.merk); uit.niets++; }
        else {
          // Niet zeker te vinden: niets schrijven; na 3 rondes opgeven (logregel), zodat het niet elke ronde terugkomt
          const n = (pogingen.get(t.merk) || 0) + 1; pogingen.set(t.merk, n);
          if (n >= 3) gedaan.add(t.merk);
          uit.niets++; o.log('deadline-lijstje ' + t.keuze + ' ' + t.sleutel.slice(0, 11) + ' niet geschreven (' + n + '/3): ' + (u ? u.niets || 'pagina veranderde' : 'geen uitkomst'));
        }
      }
      return uit;
    })();
    try { return await bezig; } finally { bezig = null; }
  }
  return { deadlines: deadlines, verwerk: verwerk };
}

module.exports = { rijp, pasToe, teDoen, zoekRegel, weergave, cellen, maak, schrijf, kaal, norm, TIK_RUST_MS, AF_KOP, AF_KOP_VJ, MERK_RE };
