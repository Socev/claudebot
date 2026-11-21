'use strict';
// Zoek snel leert van wat David kopieert (wv3743, besluitenpagina nr 472 = 3C172, David Ja 21-11-2026 13:20).
// WAAROM. Een feitvraag die de feitenlijst niet kent, kost in Zoek snel 5–10 s (tekstindex + Sonnet), en de volgende keer weer: de
// nachtelijke leerronde (zoekleer.py, wv1789) deelt gemiste vragen alleen in en leert bewust niets bij (Opus-review wv1789 MOET 1: vanzelf
// leren zette verkeerde nummers bij de verkeerde organisatie). Davids tik op een waarde-chip is wél een menselijk signaal: "dit was het".
// Ontwerp + Codex-review: mk-scripts/wv3743/ontwerp.md.
// WAT.
// - gekozen(x): de pod (niet de app) geeft vraag, waarde, label en bronpagina van een antwoord dat hij zelf gaf; alleen een antwoord uit de
//   tekstindex of de zoektocht (feitenlijst, Contacten en agenda zijn al snel). Eén paar per vraagsleutel (gesorteerde inhoudswoorden),
//   status voorgesteld.
// - kaart(): hooguit één Voor jou-kaart per ISO-week (de OVIS-kaartenronde van 02:31, naast de feitkaart): "N antwoorden uit Zoek snel —
//   voortaan meteen?", één stap per paar (≤ 12). De lijst wordt bevroren (sha per stap).
// - knop(): Ja = bevestigd; Anders "zonder 2" = die eruit (28 d rust), de rest bevestigd; Nee = 28 d rust; Anders zonder nummers = niets.
//   Telt bij de start van de knopbeurt, gaat terug als de druk vervalt. Socev krijgt geen waarden, alleen een vaste zin.
// - geleerd(vraag): een bevestigd paar met dezelfde vraagsleutel (zoek-snel.js laag 0 toetst daarna de bronpagina opnieuw); weg(id) = de
//   waarde staat niet meer op de pagina → status verdwenen (een nieuwe tik maakt er weer een voorstel van).
// OPSLAG. Eén json-bestand op de pod (0600, atomair). Nooit waarden of vragen in logs, box of /health: alleen aantallen.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PAREN = 200, MAX_WAARDEN = 5, MAX_STAPPEN = 12, RUST_MS = 28 * 86400000, KAART_DAGEN = 7;
const VULWOORD = new Set(['wat', 'wie', 'is', 'was', 'zijn', 'het', 'de', 'een', 'mijn', 'onze', 'ons', 'van', 'me', 'mij', 'ik', 'je', 'jij', 'u',
  'welk', 'welke', 'hoe', 'luidt', 'alweer', 'weer', 'eigenlijk', 'even', 'nou', 'nu', 'toch', 'ook', 'dan', 'daar', 'er', 'staat', 'heb', 'hebben', 'heeft']);
const LEER_LAGEN = new Set(['tekstindex', 'volledig', 'zoektocht']);
const SLEUTEL_RE = /^zoek-snel-leer-\d{4}-\d{2}$/;
const sha = function (t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); };
const norm = function (s) { return String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase(); };
const kort = function (s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };

function isoWeekLokaal(ms) {
  const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dag = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dag);
  const j = t.getUTCFullYear(), w = Math.ceil(((t - Date.UTC(j, 0, 1)) / 86400000 + 1) / 7);
  return { jaar: j, week: w, tekst: j + '-' + String(w).padStart(2, '0') };
}
const datumKort = function (ms) {
  try { return new Date(ms).toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'numeric' }); } catch (e) { return ''; }
};

// o: { bestand, eruitUit(toelichting, n), nu() → ms, fout(label, e), isoWeek(ms) }
function maak(o) {
  const nu = o.nu || Date.now;
  const fout = o.fout || function () {};
  const isoWeek = o.isoWeek || isoWeekLokaal;
  const bestand = o.bestand;

  // r1 MOET 1: de woorden in Davids volgorde; alleen vaste vulwoorden vallen weg (ontkenningen en voorzetsels als aan/voor blijven staan)
  function vraagSleutel(vraag) {
    const w = norm(vraag).split(/[^\p{L}\p{N}]+/u).filter(function (x) { return x && !VULWOORD.has(x); });
    return w.length ? w.join(' ').slice(0, 200) : null;
  }
  function lees() {
    let j;
    try { j = JSON.parse(fs.readFileSync(bestand, 'utf8')); }
    catch (e) { if (e && e.code === 'ENOENT') return { paren: [], kaarten: {} }; throw e; }   // kapot bestand = fout, nooit stil leeg overschrijven
    if (!j || !Array.isArray(j.paren)) throw new Error('zoek-snel-geleerd: onverwachte vorm');
    if (!j.kaarten || typeof j.kaarten !== 'object') j.kaarten = {};
    return j;
  }
  function schrijf(j) {
    const tmp = bestand + '.' + process.pid + '.tmp';
    fs.mkdirSync(path.dirname(bestand), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(j), { mode: 0o600 });
    fs.renameSync(tmp, bestand);
  }
  const paarSha = function (p) { return sha(JSON.stringify([p.sleutel, p.waarden.map(function (w) { return [w.waarde, w.label || '', w.anker && w.anker.regel, w.anker && w.anker.kop]; }), p.pad])).slice(0, 16); };

  // x = { vraag, waarde, label, pad, laag, soort, anker: { regel, kop } } — alles uit het antwoord van de pod zelf; anker = de regel op de
  // bronpagina waarop de waarde staat en de kop erboven (zoek-snel.js bronAnker; r1 MOET 2)
  function gekozen(x) {
    if (!x || x.soort !== 'antwoord') return { ok: false, reden: 'geen antwoord' };
    if (!LEER_LAGEN.has(String(x.laag || ''))) return { ok: false, reden: 'al snel' };
    const pad = String(x.pad || '');
    if (!/^(10_Zakelijk|20_Prive)\/[^\0]+\.md$/.test(pad) || pad.split('/').some(function (d) { return d === '..' || d === '.' || d === ''; })) return { ok: false, reden: 'geen vaultbron' };
    const waarde = String(x.waarde || '').replace(/\s+/g, ' ').trim();
    if (!waarde || waarde.length > 120) return { ok: false, reden: 'waarde' };
    if (!x.anker || typeof x.anker.regel !== 'string' || !x.anker.regel) return { ok: false, reden: 'geen bronanker' };
    const sl = vraagSleutel(x.vraag);
    if (!sl) return { ok: false, reden: 'geen vraagsleutel' };
    const j = lees(), t = nu();
    let p = j.paren.find(function (q) { return q.sleutel === sl; });
    if (p && p.pad !== pad && p.status !== 'bevestigd') { j.paren = j.paren.filter(function (q) { return q !== p; }); p = null; }   // andere pagina: het nieuwste voorstel telt
    if (p && p.status === 'bevestigd' && p.pad !== pad) return { ok: false, reden: 'al bevestigd met een andere bron' };
    if (!p) {
      p = { id: sha(sl).slice(0, 10), sleutel: sl, vraag: kort(x.vraag, 120), waarden: [], pad: pad, keer: 0, eerst: t, laatst: t, status: 'voorgesteld' };
      j.paren.push(p);
    }
    const nieuw = !p.waarden.some(function (w) { return norm(w.waarde) === norm(waarde); });
    if (nieuw) {
      if (p.waarden.length >= MAX_WAARDEN) return { ok: false, reden: 'te veel waarden' };
      p.waarden.push({ waarde: waarde, label: kort(x.label || '', 40), anker: { regel: String(x.anker.regel).slice(0, 400), kop: String(x.anker.kop || '').slice(0, 600) } });
      // een nieuwe waarde op een bevestigd of verdwenen paar = opnieuw een voorstel (David ziet de lijst opnieuw)
      if (p.status !== 'voorgesteld') { p.status = 'voorgesteld'; delete p.bevestigd_op; delete p.kaart; delete p.rust_tot; }
    } else if (p.status === 'verdwenen') { p.status = 'voorgesteld'; delete p.kaart; }
    p.keer++; p.laatst = t; p.vraag = kort(x.vraag, 120);
    if (j.paren.length > MAX_PAREN) {   // oudste niet-bevestigde eerst eruit
      const weg = j.paren.filter(function (q) { return q.status !== 'bevestigd'; }).sort(function (a, b) { return a.laatst - b.laatst; })[0] || j.paren[0];
      j.paren = j.paren.filter(function (q) { return q !== weg; });
    }
    schrijf(j);
    return { ok: true, status: p.status, nieuw: nieuw };
  }

  // wv3821 (deel 2, "Zoek het uit"): David zei Ja op de kaart "Gevonden: … — onthouden?" → meteen een bevestigd paar (zijn Ja ís de
  // bevestiging). x = { vraag, pad, waarden: [{ waarde, label, anker: { regel, kop } }] } — al nagekeken door de pod (bronAnker + grens).
  // Een bevestigd paar met een andere pagina blijft staan. Geeft { ok, sleutel, vorige } terug: vorige = het oude paar (of null) voor terug().
  function uitgezocht(x) {
    const sl = vraagSleutel(x && x.vraag);
    if (!sl) return { ok: false, reden: 'geen vraagsleutel' };
    const pad = String(x.pad || '');
    if (!/^(10_Zakelijk|20_Prive)\/[^\0]+\.md$/.test(pad) || pad.split('/').some(function (d) { return d === '..' || d === '.' || d === ''; })) return { ok: false, reden: 'geen vaultbron' };
    const waarden = (Array.isArray(x.waarden) ? x.waarden : []).filter(function (w) { return w && typeof w.waarde === 'string' && w.waarde && w.waarde.length <= 120 && w.anker && typeof w.anker.regel === 'string' && w.anker.regel; })
      .slice(0, MAX_WAARDEN).map(function (w) { return { waarde: w.waarde, label: kort(w.label || '', 40), anker: { regel: String(w.anker.regel).slice(0, 400), kop: String(w.anker.kop || '').slice(0, 600) } }; });
    if (!waarden.length) return { ok: false, reden: 'geen bronanker' };
    const j = lees(), t = nu();
    const oud = j.paren.find(function (q) { return q.sleutel === sl; }) || null;
    if (oud && oud.status === 'bevestigd' && oud.pad !== pad) return { ok: false, reden: 'al bevestigd met een andere bron' };
    const vorige = oud ? JSON.parse(JSON.stringify(oud)) : null;
    const p = { id: sha(sl).slice(0, 10), sleutel: sl, vraag: kort(x.vraag, 120), waarden: waarden, pad: pad, keer: oud ? (oud.keer || 0) + 1 : 1,
      eerst: oud ? oud.eerst : t, laatst: t, status: 'bevestigd', bevestigd_op: t, herkomst: 'uitgezocht' };
    j.paren = j.paren.filter(function (q) { return q !== oud; });
    j.paren.push(p);
    if (j.paren.length > MAX_PAREN) {
      const weg = j.paren.filter(function (q) { return q.status !== 'bevestigd'; }).sort(function (a, b) { return a.laatst - b.laatst; })[0];
      if (weg) j.paren = j.paren.filter(function (q) { return q !== weg; });
    }
    schrijf(j);
    return { ok: true, sleutel: sl, vorige: vorige };
  }
  // Terug naar de stand van vóór uitgezocht() (de knopdruk verviel).
  function terug(sleutel, vorige) {
    try {
      const j = lees();
      j.paren = j.paren.filter(function (q) { return q.sleutel !== sleutel; });
      if (vorige) j.paren.push(vorige);
      schrijf(j);
      return true;
    } catch (e) { fout('zoek-snel-leer', e); return false; }
  }

  function geleerd(vraag) {
    const sl = vraagSleutel(vraag);
    if (!sl) return null;
    let j;
    try { j = lees(); } catch (e) { fout('zoek-snel-leer', e); return null; }
    const p = j.paren.find(function (q) { return q.sleutel === sl && q.status === 'bevestigd'; });
    return p ? { id: p.id, vraag: p.vraag, waarden: p.waarden.slice(), pad: p.pad, bevestigd_op: p.bevestigd_op || null } : null;
  }
  function weg(id) {
    try {
      const j = lees(), p = j.paren.find(function (q) { return q.id === id && q.status === 'bevestigd'; });
      if (!p) return false;
      p.status = 'verdwenen'; p.verdwenen_op = nu();
      schrijf(j);
      return true;
    } catch (e) { fout('zoek-snel-leer', e); return false; }
  }

  // De kaart van deze ISO-week, of { reden }. status: { sleutel: 'open'|'later'|… } uit Voor jou (kaartLijst); een paar op een kaart die
  // niet meer open staat en waar David niets koos, mag weer mee.
  function kaart(status) {
    const j = lees(), t = nu(), wk = isoWeek(t), sleutel = 'zoek-snel-leer-' + wk.tekst;
    if (j.kaarten[sleutel]) return { reden: 'deze week al een kaart' };
    const open = Object.keys(j.kaarten).filter(function (k) { const s = status && status[k]; return !j.kaarten[k].keuze && (s === 'open' || s === 'later'); });
    if (open.length) return { reden: 'er staat nog een Zoek snel-kaart open' };
    const kand = j.paren.filter(function (p) {
      if (p.status === 'rust' && p.rust_tot && p.rust_tot <= t) { p.status = 'voorgesteld'; delete p.rust_tot; delete p.kaart; }
      if (p.status !== 'voorgesteld' || !p.waarden.length) return false;
      return !p.kaart || !(j.kaarten[p.kaart] && !j.kaarten[p.kaart].keuze && status && (status[p.kaart] === 'open' || status[p.kaart] === 'later'));
    }).sort(function (a, b) { return a.eerst - b.eerst; });
    if (!kand.length) return { reden: 'niets te leren' };
    const neem = kand.slice(0, MAX_STAPPEN), rest = kand.length - neem.length;
    const stappen = neem.map(function (p, i) {
      const pagina = path.basename(p.pad, '.md');
      return (i + 1) + '. "' + kort(p.vraag, 80) + '" → ' + p.waarden.map(function (w) { return (w.label ? w.label + ': ' : '') + w.waarde; }).join(' · ') + ' (' + kort(pagina, 50) + ')';
    });
    const n = neem.length;
    const deadline = new Date(t + KAART_DAGEN * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const p = {
      sleutel: sleutel, soort: 'besluit', waar: 'overal', prive: true, duur_min: 1, volgorde: 40, deadline: deadline,
      titel: n === 1 ? '1 antwoord uit Zoek snel — voortaan meteen?' : n + ' antwoorden uit Zoek snel — voortaan meteen?',
      waarom: 'Je tikte deze week in Zoek snel op ' + (n === 1 ? 'dit antwoord' : 'deze antwoorden') + ' (kopiëren of bellen/mailen). Met Ja onthoudt Zoek snel ' +
        (n === 1 ? 'het' : 'ze') + ': dezelfde vraag komt dan in een tel, zonder zoektocht, en de pod kijkt elke keer na of het nog op de pagina staat.' +
        (rest > 0 ? ' Nog ' + rest + ' volgen op een volgende kaart.' : ''),
      stappen: stappen.concat(['Ja: alles onthouden.', 'Nee: niets onthouden (over vier weken komen ze terug).', 'Anders: bijvoorbeeld "zonder 2" — de rest wordt onthouden.']),
      herkomst: { handmatig: 'zoek-snel' } };
    return { kaart: p, bevries: { sleutel: sleutel, stappen: neem.map(function (q, i) { return { nr: i + 1, id: q.id, sha: paarSha(q) }; }) } };
  }
  function kaartGezet(bevries) {
    const j = lees();
    j.kaarten[bevries.sleutel] = { gezet: nu(), stappen: bevries.stappen };
    bevries.stappen.forEach(function (s) { const p = j.paren.find(function (q) { return q.id === s.id; }); if (p) p.kaart = bevries.sleutel; });
    // oude kaarten opruimen (> 120 d)
    Object.keys(j.kaarten).forEach(function (k) { if (nu() - (j.kaarten[k].gezet || 0) > 120 * 86400000) delete j.kaarten[k]; });
    schrijf(j);
  }

  // Knop op de kaart (appVoorJouKnop). Alleen uit de eigen, bevroren lijst; null = niet van ons.
  function knop(sleutel, keuze, toelichting) {
    if (!SLEUTEL_RE.test(String(sleutel || ''))) return null;
    let j;
    try { j = lees(); } catch (e) { fout('zoek-snel-leer', e); return null; }
    const k = j.kaarten[sleutel];
    if (!k) return null;
    const n = k.stappen.length;
    const eruit = keuze === 'anders' && o.eruitUit ? o.eruitUit(toelichting, n) : null;
    const kz = keuze === 'ja' ? 'ja' : keuze === 'nee' ? 'nee' : eruit && eruit.length < n ? 'anders' : eruit ? 'nee' : 'niets';
    const context = kz === 'ja' ? ' (Zoek snel-kaart: David zei Ja. De pod onthoudt deze ' + n + ' antwoord(en) zelf; dezelfde vraag in Zoek snel komt voortaan meteen. Jij doet niets; bevestig in één zin.)'
      : kz === 'anders' ? ' (Zoek snel-kaart: David haalde nummer(s) ' + eruit.join(', ') + ' eruit; de pod onthoudt de andere ' + (n - eruit.length) + ' zelf. Jij doet niets; bevestig in één zin.)'
      : kz === 'nee' ? ' (Zoek snel-kaart: niets onthouden; deze antwoorden komen over vier weken opnieuw op een kaart. Jij doet niets; zeg dat kort.)'
      : ' (Zoek snel-kaart: Anders zonder nummers om eruit te halen — de pod onthoudt niets; de antwoorden komen volgende week op een nieuwe kaart, waar David met Anders "zonder 2" kan antwoorden. Vraag kort wat hij bedoelt; jij kunt niets vastzetten.)';
    let vorige = null;
    return {
      context: context,
      bijStart: function () {
        try {
          const j2 = lees(), k2 = j2.kaarten[sleutel];
          if (!k2 || k2.keuze) return;
          const t = nu();
          vorige = {};
          k2.stappen.forEach(function (s) {
            const p = j2.paren.find(function (q) { return q.id === s.id; });
            if (!p || p.kaart !== sleutel || p.status !== 'voorgesteld') return;
            vorige[p.id] = { status: p.status, rust_tot: p.rust_tot, bevestigd_op: p.bevestigd_op };
            if (paarSha(p) !== s.sha) { delete p.kaart; return; }   // na de kaart veranderd (extra waarde): niet wat David zag → volgende kaart
            const uit = kz === 'nee' || (kz === 'anders' && eruit.indexOf(s.nr) >= 0);
            if (kz === 'niets') { delete p.kaart; return; }
            if (uit) { p.status = 'rust'; p.rust_tot = t + RUST_MS; } else { p.status = 'bevestigd'; p.bevestigd_op = t; }
          });
          k2.keuze = kz; k2.keuze_op = t;
          schrijf(j2);
        } catch (e) { fout('zoek-snel-leer', e); }
      },
      bijVerval: function () {
        try {
          if (!vorige) return;
          const j2 = lees(), k2 = j2.kaarten[sleutel];
          if (!k2) return;
          Object.keys(vorige).forEach(function (id) {
            const p = j2.paren.find(function (q) { return q.id === id; });
            if (!p) return;
            p.status = vorige[id].status; p.kaart = sleutel;
            if (vorige[id].rust_tot) p.rust_tot = vorige[id].rust_tot; else delete p.rust_tot;
            if (vorige[id].bevestigd_op) p.bevestigd_op = vorige[id].bevestigd_op; else delete p.bevestigd_op;
          });
          delete k2.keuze; delete k2.keuze_op;
          schrijf(j2);
          vorige = null;
        } catch (e) { fout('zoek-snel-leer', e); }
      },
    };
  }

  function info() {
    try {
      const j = lees(), per = {};
      j.paren.forEach(function (p) { per[p.status] = (per[p.status] || 0) + 1; });
      return { paren: j.paren.length, per_status: per, kaarten: Object.keys(j.kaarten).length };
    } catch (e) { return { fout: true }; }
  }

  return { vraagSleutel: vraagSleutel, gekozen: gekozen, uitgezocht: uitgezocht, terug: terug, geleerd: geleerd, weg: weg, kaart: kaart, kaartGezet: kaartGezet, knop: knop, info: info, datumKort: datumKort, _lees: lees };
}

module.exports = { maak: maak, SLEUTEL_RE: SLEUTEL_RE, LEER_LAGEN: LEER_LAGEN, isoWeekLokaal: isoWeekLokaal };
