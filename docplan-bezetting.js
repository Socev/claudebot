'use strict';
/*
 * DocPlan — bezettingswacht (wv2475, 5-11-2026; idee 25; vault "01_Ontwikkeling/OVIS DocPlan - bezettingswacht (ontwerp 5-11-2026).md" § 3 en
 * § Herzien 5-11). David 5-11 11:24: "Dus dat er actief geattendeerd wordt als ergens de weekbezetting laag is, maar er nog geen waarneemverzoek
 * in de GEZOCHT agenda staat." En 13:03: "De norm moet meer regels kennen... Maandag altijd 3, over de hele week minstens 3 van de 5 dagen 3
 * artsen, liefst 4 van de 5 dagen (Tolgaarde). De agenda moet ook bewerkbaar zijn vanuit OVIS, door mij (geen gedoe met vingerafdrukken,
 * hoogstens vinkjes!) ... in 1 maand-overview dit zo door kan klikken."
 *
 * Bron: public.sb_dienst_bezetting(van, tot) (sb2 0026): per praktijk per werkdag artsen (halve dag 0,5; alias-status geen telt niet) en
 * gezocht (actieve GEZOCHT-items), plus de versheid van de vier roosterfeeds. Norm: /opt/data/docplan/bezetting-norm.json (server.js leest het
 * bestand en geeft de tekst mee; ontbreekt het, dan NORM_STANDAARD). Normregels per praktijk:
 *   dag_min   harde dagregel per weekdag (Tolgaarde: ma altijd 3, andere dagen minstens 2)
 *   week[]    weekregel { artsen N, dagen K, soort hard|wens }: minstens K werkdagen met N artsen; in een week met feestdagen K = min(K, werkdagen)
 * Kleur per dag: grijs = feestdag; rood = harde regel geschonden zonder verzoek; oranje = geschonden maar GEZOCHT dekt het; geel = alleen de wens;
 * groen = op norm. Voorstel = de dag(en) die Socev voorstelt om uit te zetten (eerst de dagregel, dan de weekregel: kleinste tekort, ma–do vóór vr).
 *
 * Melden (alleen de ochtendronde, één keer per dag, server.js na docplanControleRonde): punten 'dag:<datum>' (dagregel) en 'week:<maandag>'
 * (weekregel), alleen harde regels, alleen ongedekt, van morgen t/m 10 weken. Stand per punt in docplan.sqlite (bezetting_punt): gemeld (op kaart k),
 * opgelost, voorbij, goed_zo (Davids knop). Nieuw of terug na opgelost = melden op een eigen kaart (sleutel docplan-bezetting:<pr>:<maandag>:<volgnr>,
 * nooit uitbreiden); goed_zo nooit meer. Een kaart sluit pas zelf als al zijn punten af zijn. Feed ouder dan 36 uur, feedfout of geen antwoord:
 * niets melden en niets sluiten.
 *
 * Vinkje (DocPlan › Bezetting, maandoverzicht): David vinkt een dag aan om uit te zetten naar waarneming. Sinds wv2486 (grondwet 1, aanvulling
 * David 5-11-2026, Ja met verse vingerafdruk 15:08) zet de pod dan zelf één hele-dag-item GEZOCHT in de GEZOCHT-agenda van die praktijk (staat
 * daarmee op waarneming.tolgaarde.nl) en haalt het weer weg als David het vinkje weghaalt — alleen een item dat de pod zelf zette (event-id in
 * bezetting_keuze; n8n toetst bovendien de markering socev_docplan). Dat gaat via o.gezocht (server.js → n8n *AI - GEZOCHT-agenda*, vaste
 * regels: titel GEZOCHT, hele dag, werkdag vanaf morgen, sendUpdates none); deze module kent geen agenda-id, geen URL en geen sleutel.
 * Lukt het niet (geen schrijfrecht, zoals nu bij Groenhouten; n8n onbereikbaar), dan blijft de vooringevulde Google-link (David tikt Opslaan).
 * Nooit een bericht aan een waarnemer.
 *
 * Puur: deze module laadt niets en raakt geen bestanden of netwerk; server.js geeft rpc, de docplan-databank (node:sqlite) en de Voor jou-io mee.
 * Namen gaan alleen in het antwoord aan Davids app (tik = wie), nooit in een kaart of log.
 */
const PRAKTIJK = { TG: 'Tolgaarde', GH: 'Groenhouten' };
const WD = ['ma', 'di', 'wo', 'do', 'vr'];
const WD_LANG = { ma: 'maandag', di: 'dinsdag', wo: 'woensdag', do: 'donderdag', vr: 'vrijdag' };
const MND = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const NORM_STANDAARD = {
  versie: 2, vooruit_weken: 10, tegel_weken: 12, feed_max_uur: 36,
  praktijken: {
    TG: { dag_min: { ma: 3, di: 2, wo: 2, do: 2, vr: 2 }, week: [{ artsen: 3, dagen: 3, soort: 'hard' }, { artsen: 3, dagen: 4, soort: 'wens' }], voorstel: false },
    // Groenhouten: bewust zonder weekregel (David gaf de regels voor Tolgaarde; GH draait gemeten 1–3 dagen per week met 3 artsen). voorstel: true =
    // de app zegt dat het een voorstel is; een weekregel erbij = één regel in bezetting-norm.json (review MOET 2: afwijking expliciet)
    GH: { dag_min: { ma: 3, di: 2, wo: 2, do: 2, vr: 2 }, week: [], voorstel: true },
  },
};
const PAD_RE = /^\/app\/facturen\/bezetting(?:\/(\d{4}-\d{2}))?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const PUNT_RE = /^(dag|week):(\d{4}-\d{2}-\d{2})$/;
const KAART_RE = /^docplan-bezetting:(TG|GH):(\d{4}-\d{2}-\d{2}):(\d{1,3})$/;
const MAX_KAARTEN = 6;   // hooguit zoveel nieuwe kaarten per ronde (vangnet tegen een kapotte bron)

// ───────────────────────────── datums ─────────────────────────────
function isoPlus(iso, dagen) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + dagen); return d.toISOString().slice(0, 10); }
function weekdag(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); }   // 0 = zo
function maandagVan(iso) { const w = weekdag(iso); return isoPlus(iso, w === 0 ? -6 : 1 - w); }
function dagAmsterdam(nu) { return new Date(nu).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function uurAmsterdam(nu) { return Number(new Date(nu).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false })) % 24; }
function isoWeek(iso) {
  const d = new Date(iso + 'T00:00:00Z'); const w = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - w + 3);
  const j = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); return 1 + Math.round(((d - j) / 864e5 - 3 + ((j.getUTCDay() + 6) % 7)) / 7);
}
function kort(iso) { return WD[(weekdag(iso) + 6) % 7] + ' ' + Number(iso.slice(8, 10)) + ' ' + MND[Number(iso.slice(5, 7)) - 1]; }
function geldigIso(s) { if (typeof s !== 'string' || !ISO_RE.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; }

/* Pasen (anonieme gregoriaanse rekenwijze) en de feestdagen waarop de praktijken dicht zijn. Bevrijdingsdag alleen in lustrumjaren. */
function pasen(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const maand = Math.floor((h + l - 7 * m + 114) / 31), dag = ((h + l - 7 * m + 114) % 31) + 1;
  return y + '-' + String(maand).padStart(2, '0') + '-' + String(dag).padStart(2, '0');
}
const feestCache = {};
function feestdagen(y) {
  if (feestCache[y]) return feestCache[y];
  const p = pasen(y), m = {};
  m[y + '-01-01'] = 'Nieuwjaarsdag';
  m[isoPlus(p, 1)] = 'Tweede paasdag';
  const kd = y + '-04-27'; m[weekdag(kd) === 0 ? y + '-04-26' : kd] = 'Koningsdag';
  if (y % 5 === 0) m[y + '-05-05'] = 'Bevrijdingsdag';
  m[isoPlus(p, 39)] = 'Hemelvaartsdag';
  m[isoPlus(p, 50)] = 'Tweede pinksterdag';
  m[y + '-12-25'] = 'Eerste kerstdag';
  m[y + '-12-26'] = 'Tweede kerstdag';
  return (feestCache[y] = m);
}
function feestdag(iso) { return feestdagen(Number(iso.slice(0, 4)))[iso] || null; }

// ───────────────────────────── norm ─────────────────────────────
/* normLees(tekst|null) → { norm, fout }: een kapotte of ontbrekende normfile = NORM_STANDAARD met de fout erbij (de app toont hem). */
function normLees(tekst) {
  if (tekst == null || tekst === '') return { norm: NORM_STANDAARD, fout: null, standaard: true };
  let j;
  try { j = JSON.parse(tekst); } catch (e) { return { norm: NORM_STANDAARD, fout: 'normbestand is geen geldige JSON', standaard: true }; }
  const fout = (w) => ({ norm: NORM_STANDAARD, fout: 'normbestand: ' + w, standaard: true });
  if (!j || typeof j !== 'object' || !j.praktijken || typeof j.praktijken !== 'object') return fout('praktijken ontbreken');
  const heel = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;   // review KAN 1: alleen hele getallen
  const norm = { versie: Number(j.versie) || 2, vooruit_weken: heel(j.vooruit_weken, 1, 26) ? j.vooruit_weken : NORM_STANDAARD.vooruit_weken,
    tegel_weken: heel(j.tegel_weken, 1, 26) ? j.tegel_weken : NORM_STANDAARD.tegel_weken, feed_max_uur: heel(j.feed_max_uur, 6, 168) ? j.feed_max_uur : NORM_STANDAARD.feed_max_uur, praktijken: {} };
  for (const code of Object.keys(PRAKTIJK)) {
    const p = j.praktijken[code];
    if (!p) return fout('praktijk ' + code + ' ontbreekt');
    const dm = {};
    for (const w of WD) { const v = p.dag_min && p.dag_min[w]; if (!heel(v, 0, 10)) return fout(code + ' dag_min.' + w); dm[w] = v; }
    const week = [];
    for (const r of Array.isArray(p.week) ? p.week : []) {
      if (!r || !heel(r.artsen, 1, 10) || !heel(r.dagen, 1, 5) || (r.soort !== 'hard' && r.soort !== 'wens')) return fout(code + ' weekregel');
      week.push({ artsen: r.artsen, dagen: r.dagen, soort: r.soort });
    }
    norm.praktijken[code] = { dag_min: dm, week, voorstel: p.voorstel === true };
  }
  return { norm, fout: null, standaard: false };
}
/* De regels in gewone taal (app en ontwerp). */
function normTekst(p) {
  const uit = [];
  const per = {};
  for (const w of WD) (per[p.dag_min[w]] = per[p.dag_min[w]] || []).push(w);
  const waarden = Object.keys(per).map(Number).sort((a, b) => b - a);
  if (waarden.length === 1) uit.push({ soort: 'hard', tekst: 'Elke werkdag minstens ' + waarden[0] + ' artsen' });
  else for (const v of waarden) {
    const ds = per[v];
    uit.push({ soort: 'hard', tekst: (ds.length === 1 ? WD_LANG[ds[0]] : ds.join(', ')).replace(/^./, (c) => c.toUpperCase()) + ' ' + (ds.length === 1 ? 'altijd ' : 'minstens ') + v + ' artsen' });
  }
  for (const r of p.week) uit.push({ soort: r.soort, tekst: (r.soort === 'wens' ? 'Liefst ' : 'Minstens ') + r.dagen + ' van de 5 dagen ' + r.artsen + ' artsen' });
  return uit;
}

// ───────────────────────────── beoordelen ─────────────────────────────
/* feedsOk(feeds, nu, maxUur) → { ok, reden, laatste }: alle vier roosterfeeds actief, zonder fout en jonger dan maxUur. */
function feedsOk(feeds, nu, maxUur) {
  const l = Array.isArray(feeds) ? feeds : [];
  // review ZOU 1: alleen actieve feeds tellen (een oude, uitgezette feed blokkeert niets); per praktijk en leesregel minstens één, en elke actieve vers
  const actief = l.filter((x) => x && x.actief !== false);
  for (const code of Object.keys(PRAKTIJK)) for (const lr of ['rooster', 'rooster_open']) {
    const fs_ = actief.filter((x) => x.pr === code && x.leesregel === lr);
    if (!fs_.length) return { ok: false, reden: 'geen actieve roosterfeed ' + code + ' ' + lr };
    for (const f of fs_) {
      if (f.laatste_fout) return { ok: false, reden: 'roosterfeed ' + f.feed + ' gaf een fout' };
      const t = Date.parse(f.laatste_gelukt || '');
      if (!Number.isFinite(t) || nu - t > maxUur * 3600e3) return { ok: false, reden: 'roosterfeed ' + f.feed + ' ouder dan ' + maxUur + ' uur' };
    }
  }
  const t = actief.map((f) => Date.parse(f.laatste_gelukt || '')).filter(Number.isFinite);
  return { ok: true, reden: null, laatste: t.length ? new Date(Math.min.apply(null, t)).toISOString() : null };
}

/*
 * week(pr, maandag, dagen, normP, x) → de week met kleur per dag, regeluitslag en punten.
 *   dagen: Map datum → { artsen, gezocht, namen, niet_geteld }; x = { vandaag, tot (laatste meldbare dag), goedZo: Set(sleutel), keuze: Set(datum) }
 */
function week(pr, maandag, dagen, normP, x) {
  x = x || {};
  const ds = WD.map((w, i) => {
    const datum = isoPlus(maandag, i), r = dagen.get(datum) || {};
    const fd = feestdag(datum);
    return { datum, wd: w, feestdag: fd, artsen: Number(r.artsen) || 0, gezocht: Number(r.gezocht) || 0,
      namen: Array.isArray(r.namen) ? r.namen.map((n) => ({ naam: String(n.naam || '?'), half: n.half === true })) : [],
      niet_geteld: Number(r.niet_geteld) || 0, verleden: !!(x.vandaag && datum <= x.vandaag), extra: 0,
      kleur: fd ? 'grijs' : 'groen', redenen: [], voorstel: null, punten: [] };
  });
  const werk = ds.filter((d) => !d.feestdag);
  const kan = (d) => !d.verleden;   // voorstellen alleen voor dagen vanaf morgen
  const punten = [];
  const zetVoorstel = (d, aantal, soort) => {
    if (aantal <= 0) return;
    d.extra += aantal;
    if (!d.voorstel) d.voorstel = { aantal, soort };
    else { d.voorstel.aantal += aantal; if (soort === 'hard') d.voorstel.soort = 'hard'; }
  };
  // 1. harde dagregel
  for (const d of werk) {
    const min = normP.dag_min[d.wd];
    if (d.artsen >= min) continue;
    const gedekt = d.artsen + d.gezocht >= min;
    d.redenen.push({ soort: 'dag', tekst: d.artsen + ' van ' + min + ' artsen', gedekt });
    if (gedekt) { if (d.kleur !== 'rood') d.kleur = 'oranje'; continue; }
    d.kleur = 'rood';
    d.punten.push('dag:' + d.datum);
    if (kan(d)) zetVoorstel(d, min - d.artsen - d.gezocht, 'hard');
    punten.push({ sleutel: 'dag:' + d.datum, datum: d.datum, tekst: kort(d.datum) + ': ' + d.artsen + ' van ' + min + ' artsen' });
  }
  // 2. weekregels (hard eerst, dan wens)
  const regels = [];
  const volgorde = normP.week.slice().sort((a, b) => (a.soort === 'hard' ? 0 : 1) - (b.soort === 'hard' ? 0 : 1));
  for (const r of volgorde) {
    const K = Math.min(r.dagen, werk.length), N = r.artsen;
    const telA = werk.filter((d) => d.artsen >= N).length;
    const telG = werk.filter((d) => d.artsen + d.gezocht >= N).length;
    const ok = telA >= K, gedekt = !ok && telG >= K;
    regels.push({ soort: r.soort, tekst: telA + ' van ' + werk.length + ' dagen ' + N + ' artsen (' + (r.soort === 'wens' ? 'liefst ' : 'minstens ') + K + ')', ok, gedekt });
    if (ok) continue;
    if (gedekt) {
      for (const d of werk) if (d.artsen < N && d.artsen + d.gezocht >= N && d.kleur === 'groen') d.kleur = r.soort === 'hard' ? 'oranje' : 'geel';
      continue;
    }
    // ongedekt: kies dagen om aan te vullen (bestaande voorstellen tellen mee)
    const nodig = K - werk.filter((d) => d.artsen + d.gezocht + d.extra >= N).length;
    const kand = werk.filter((d) => d.artsen + d.gezocht + d.extra < N && kan(d))
      .sort((a, b) => (N - a.artsen - a.gezocht - a.extra) - (N - b.artsen - b.gezocht - b.extra) || (a.wd === 'vr') - (b.wd === 'vr') || (a.datum < b.datum ? -1 : 1));
    const gekozen = kand.slice(0, Math.max(0, nodig));
    for (const d of gekozen) {
      zetVoorstel(d, N - d.artsen - d.gezocht - d.extra, r.soort);
      if (r.soort === 'hard') { d.kleur = 'rood'; d.punten.push('week:' + maandag); }
      else if (d.kleur === 'groen') d.kleur = 'geel';
      d.redenen.push({ soort: r.soort === 'hard' ? 'week' : 'wens', tekst: 'voorstel voor de weekregel: ' + N + ' artsen', gedekt: false });
    }
    if (r.soort === 'hard' && gekozen.length) {
      punten.push({ sleutel: 'week:' + maandag, datum: gekozen[0].datum, dagen: gekozen.map((d) => d.datum),
        tekst: 'week: ' + telA + ' van de ' + K + ' dagen met ' + N + ' artsen' });
    }
  }
  // stand van Davids keuzes
  const gz = x.goedZo || new Set(), kz = x.keuze || new Set();
  for (const d of ds) {
    d.gekozen = kz.has(d.datum);
    d.goed_zo = d.punten.length > 0 && d.punten.every((s) => gz.has(s));
  }
  // meldbaar: hard, ongedekt, (een voorstelsdag) binnen morgen..tot, niet goed_zo
  const meldbaar = punten.filter((p) => {
    const dd = p.dagen || [p.datum];
    return !gz.has(p.sleutel) && dd.some((d) => x.vandaag && d > x.vandaag && (!x.tot || d <= x.tot));
  });
  const rang = { rood: 3, oranje: 2, geel: 1, groen: 0, grijs: -1 };
  const kleur = ds.reduce((k, d) => (rang[d.kleur] > rang[k] ? d.kleur : k), 'groen');
  return { pr, maandag, weeknr: isoWeek(maandag), kleur, regels, dagen: ds.map((d) => { const o = Object.assign({}, d); delete o.extra; return o; }), punten, meldbaar };
}

/* beoordeel({ bez, norm, vandaag, van, weken, goedZo: {pr: Set}, keuze: {pr: Set} }) → per praktijk de weken; punten = meldbare punten. */
function beoordeel(o) {
  const per = { TG: new Map(), GH: new Map() };
  for (const r of Array.isArray(o.bez && o.bez.dagen) ? o.bez.dagen : []) if (per[r.pr] && geldigIso(r.datum)) per[r.pr].set(r.datum, r);
  const tot = isoPlus(o.vandaag, 7 * o.norm.vooruit_weken);
  const praktijken = [];
  const punten = [];
  for (const code of Object.keys(PRAKTIJK)) {
    const np = o.norm.praktijken[code];
    const weken = [];
    for (let i = 0; i < o.weken; i++) {
      const w = week(code, isoPlus(o.van, 7 * i), per[code], np, { vandaag: o.vandaag, tot, goedZo: (o.goedZo || {})[code], keuze: (o.keuze || {})[code] });
      weken.push(w);
      for (const p of w.meldbaar) punten.push(Object.assign({ pr: code, maandag: w.maandag, weeknr: w.weeknr }, p));
    }
    const agenda = ((o.bez && o.bez.feeds) || []).find((f) => f && f.pr === code && f.leesregel === 'rooster_open' && f.actief !== false && f.agenda);
    praktijken.push({ code, naam: PRAKTIJK[code], regels: normTekst(np), norm_voorstel: np.voorstel, agenda: agenda && agenda.agenda || null, weken });
  }
  return { praktijken, punten, tot };
}

/* Vooringevulde Google-link voor één hele dag in de GEZOCHT-agenda (David tikt Opslaan; Socev schrijft zelf niets); null zonder bekende agenda. */
function googleLink(agenda, datum) {
  if (!geldigIso(datum)) return null;
  const q = 'action=TEMPLATE&text=GEZOCHT&dates=' + datum.replace(/-/g, '') + '/' + isoPlus(datum, 1).replace(/-/g, '') + '&ctz=Europe%2FAmsterdam';
  // review MOET 1: zonder geldige GEZOCHT-agenda geen link (anders belandt het verzoek in Davids standaardagenda en niet op de waarneemsite)
  if (!agenda || !/^[A-Za-z0-9._%@-]{5,200}$/.test(agenda)) return null;
  let id;
  try { id = decodeURIComponent(agenda); } catch (e) { return null; }
  return 'https://calendar.google.com/calendar/render?' + q + '&src=' + encodeURIComponent(id);
}

/* wv2486: waarom een aangevinkte dag (nog) niet op de waarneemsite staat, in Davids woorden. */
function schrijfFoutTekst(stand, pr) {
  if (stand === 'geen_recht') return 'Socev mag nog niet schrijven in de GEZOCHT-agenda van ' + (PRAKTIJK[pr] || pr) + '; zet hem zelf via de link.';
  if (stand === 'fout') return 'Zelf zetten lukte niet; zet hem via de link of vink opnieuw aan.';
  return null;
}

// ───────────────────────────── administratie (docplan.sqlite) ─────────────────────────────
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bezetting_punt (pr TEXT NOT NULL CHECK (pr IN ('TG','GH')), sleutel TEXT NOT NULL,
      stand TEXT NOT NULL CHECK (stand IN ('gemeld','opgelost','voorbij','goed_zo')), kaart TEXT, sinds TEXT NOT NULL, bijgewerkt TEXT NOT NULL,
      PRIMARY KEY (pr, sleutel));
    CREATE TABLE IF NOT EXISTS bezetting_kaart (sleutel TEXT PRIMARY KEY, pr TEXT NOT NULL, maandag TEXT NOT NULL, volgnr INTEGER NOT NULL,
      punten TEXT NOT NULL, stand TEXT NOT NULL CHECK (stand IN ('open','dicht')), gezet TEXT NOT NULL, gesloten TEXT);
    CREATE TABLE IF NOT EXISTS bezetting_keuze (pr TEXT NOT NULL CHECK (pr IN ('TG','GH')), datum TEXT NOT NULL, op TEXT NOT NULL, door TEXT NOT NULL,
      PRIMARY KEY (pr, datum));
    CREATE TABLE IF NOT EXISTS bezetting_ronde (dag TEXT PRIMARY KEY, op TEXT NOT NULL, uitkomst TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bezetting_fout (dag TEXT PRIMARY KEY, reden TEXT NOT NULL, gemeld INTEGER NOT NULL DEFAULT 0);`);
  // wv2486: per vinkje het item dat de pod zelf in de GEZOCHT-agenda zette (herhaalbaar: kolom alleen toevoegen als hij er nog niet is)
  const kol = new Set(db.prepare("SELECT name FROM pragma_table_info('bezetting_keuze')").all().map((r) => r.name));
  for (const [k, t] of [['event_id', 'TEXT'], ['stand', 'TEXT'], ['fout', 'TEXT'], ['bijgewerkt', 'TEXT']]) if (!kol.has(k)) db.exec('ALTER TABLE bezetting_keuze ADD COLUMN ' + k + ' ' + t);
}
function staat(db) {
  const goedZo = { TG: new Set(), GH: new Set() }, keuze = { TG: new Set(), GH: new Set() }, keuzeRij = { TG: new Map(), GH: new Map() };
  const punten = db.prepare('SELECT pr, sleutel, stand, kaart FROM bezetting_punt').all();
  for (const p of punten) if (p.stand === 'goed_zo' && goedZo[p.pr]) goedZo[p.pr].add(p.sleutel);
  for (const k of db.prepare('SELECT pr, datum, event_id, stand, fout FROM bezetting_keuze').all()) if (keuze[k.pr]) { keuze[k.pr].add(k.datum); keuzeRij[k.pr].set(k.datum, k); }
  return { goedZo, keuze, keuzeRij, punten, kaarten: db.prepare('SELECT sleutel, pr, maandag, volgnr, punten, stand FROM bezetting_kaart').all() };
}

/*
 * plan({ open (meldbare punten nu), punten (rijen), kaarten (rijen), vandaag }) → { melden: [{pr, maandag, weeknr, volgnr, sleutel, punten}],
 *   af: [{pr, sleutel, stand}], sluit: [kaartsleutel] }. Puur.
 */
function plan(o) {
  const rij = new Map((o.punten || []).map((p) => [p.pr + '|' + p.sleutel, p]));
  const openSet = new Set((o.open || []).map((p) => p.pr + '|' + p.sleutel));
  const melden = new Map();
  for (const p of o.open || []) {
    const r = rij.get(p.pr + '|' + p.sleutel);
    if (r && (r.stand === 'gemeld' || r.stand === 'goed_zo')) continue;
    const k = p.pr + '|' + p.maandag;
    if (!melden.has(k)) melden.set(k, { pr: p.pr, maandag: p.maandag, weeknr: p.weeknr, punten: [] });
    melden.get(k).punten.push(p);
  }
  const af = [];
  for (const r of o.punten || []) {
    if (r.stand !== 'gemeld' || openSet.has(r.pr + '|' + r.sleutel)) continue;
    const m = PUNT_RE.exec(r.sleutel);
    const laatste = m ? (m[1] === 'week' ? isoPlus(m[2], 4) : m[2]) : '';
    af.push({ pr: r.pr, sleutel: r.sleutel, stand: laatste && o.vandaag && laatste <= o.vandaag ? 'voorbij' : 'opgelost' });
  }
  // volgnummer per (pr, maandag): één hoger dan het hoogste bestaande
  const hoogste = {};
  for (const k of o.kaarten || []) { const s = k.pr + '|' + k.maandag; hoogste[s] = Math.max(hoogste[s] || 0, Number(k.volgnr) || 0); }
  const uit = [...melden.values()].sort((a, b) => (a.maandag < b.maandag ? -1 : a.maandag > b.maandag ? 1 : a.pr < b.pr ? -1 : 1)).map((m) => {
    const volgnr = (hoogste[m.pr + '|' + m.maandag] || 0) + 1;
    return Object.assign(m, { volgnr, sleutel: 'docplan-bezetting:' + m.pr + ':' + m.maandag + ':' + volgnr });
  });
  // sluiten: een open kaart waarvan elk punt (na af en na nieuwe meldingen) niet meer 'gemeld op deze kaart' is
  const naAf = new Map((o.punten || []).map((p) => [p.pr + '|' + p.sleutel, Object.assign({}, p)]));
  for (const a of af) naAf.get(a.pr + '|' + a.sleutel).stand = a.stand;
  const sluit = [];
  for (const k of o.kaarten || []) {
    if (k.stand !== 'open') continue;
    let ps = [];
    try { ps = JSON.parse(k.punten); } catch (e) { ps = []; }
    const nogOpen = ps.some((s) => { const r = naAf.get(k.pr + '|' + s); return r && r.stand === 'gemeld' && r.kaart === k.sleutel; });
    if (!nogOpen) sluit.push(k.sleutel);
  }
  return { melden: uit, af, sluit };
}

/* De Voor jou-kaart (geen namen, alleen aantallen; geen pad of wv-nummer). */
function kaart(m, nuKort) {
  const naam = PRAKTIJK[m.pr];
  const dagPunten = m.punten.filter((p) => p.sleutel.startsWith('dag:'));
  const weekPunt = m.punten.find((p) => p.sleutel.startsWith('week:'));
  const nDagen = new Set(m.punten.flatMap((p) => p.dagen || [p.datum])).size;
  const titel = (naam + ' week ' + m.weeknr + (m.volgnr > 1 ? ' (nog een gat)' : '') + ' — ' + (nDagen === 1 ? '1 dag' : nDagen + ' dagen') + ' onderbezet, nog geen waarnemer gezocht').slice(0, 90);
  const regels = dagPunten.map((p) => p.tekst);
  if (weekPunt) regels.push(weekPunt.tekst + '; voorstel: ' + weekPunt.dagen.map(kort).join(', ') + ' uitzetten');
  const waarom = ('Volgens de norm is ' + naam + ' in de week van ' + kort(m.maandag) + ' onderbezet en staat er nog geen waarneemverzoek: ' + regels.join('; ') +
    '. Hoe eerder het verzoek op de waarneemsite staat, hoe groter de kans op een waarnemer.').slice(0, 400);
  return { sleutel: m.sleutel, soort: 'doen', waar: 'overal', prive: false, duur_min: 2, volgorde: 40,
    titel, waarom,
    stappen: ['Open in de Socev-app Apps › DocPlan › Bezetting; de week staat al open.',
      'Vink de dag(en) aan die je wilt uitzetten en tik bij elke dag op "Zet in GEZOCHT-agenda": Google Agenda opent met het verzoek ingevuld, jij tikt Opslaan.',
      'Mag het zo blijven? Tik "Is goed zo". Deze kaart gaat vanzelf dicht als alle dagen geregeld zijn.'],
    meting: (nuKort ? nuKort + ': ' : '') + 'rooster en GEZOCHT-agenda van vanochtend naast de norm gelegd.',
    herkomst: { module: 'docplan', handmatig: 'docplan-bezetting', doel: { scherm: 'docplan', focus: 'bezetting:' + m.pr + '-' + m.maandag } } };
}

// ───────────────────────────── ochtendronde ─────────────────────────────
/*
 * ronde({ rpc, db, io: { zet(p), status(sleutel, van, naar, x), lijst() }, nu, normTekst, nuKort, forceer }) →
 *   { ok, gedaan, reden?, nieuw, opgelost, gesloten, open, fouten }
 * db = docplan.sqlite (schrijfbaar). Eén keer per dag; vóór 12:00 NL-tijd (de ochtend-bankronde); forceer alleen in toetsen.
 */
async function ronde(o) {
  const nu = Number.isFinite(o.nu) ? o.nu : Date.now();
  const vandaag = dagAmsterdam(nu);
  if (!o.forceer && uurAmsterdam(nu) >= 12) return { ok: true, gedaan: false, reden: 'alleen in de ochtendronde' };
  schema(o.db);
  if (!o.forceer && o.db.prepare('SELECT 1 FROM bezetting_ronde WHERE dag = ?').get(vandaag)) return { ok: true, gedaan: false, reden: 'vandaag al gedaan' };
  const nl = normLees(o.normTekst);
  const van = maandagVan(vandaag);
  const weken = nl.norm.vooruit_weken + 2;
  // fout of halve invoer = niets melden en niets sluiten; de tweede mislukte ochtend op rij geeft één keer box: true (server.js schrijft de boxrij)
  const mislukt = (reden) => {
    o.db.prepare('INSERT OR IGNORE INTO bezetting_fout (dag, reden, gemeld) VALUES (?, ?, 0)').run(vandaag, reden);
    const rijen = o.db.prepare('SELECT dag, gemeld FROM bezetting_fout WHERE dag >= ? ORDER BY dag').all(isoPlus(vandaag, -4));
    const box = rijen.length >= 2 && !rijen.some((r) => r.gemeld);
    if (box) o.db.prepare('UPDATE bezetting_fout SET gemeld = 1 WHERE dag = ?').run(vandaag);
    return { ok: false, gedaan: false, reden, box };
  };
  let bez;
  try { bez = await o.rpc('sb_dienst_bezetting', { p_van: van, p_tot: isoPlus(van, 7 * weken - 1) }); } catch (e) { return mislukt('databank gaf geen antwoord'); }
  if (!bez || !Array.isArray(bez.dagen) || !Array.isArray(bez.feeds)) return mislukt('onverwacht antwoord van de databank');
  const fo = feedsOk(bez.feeds, nu, nl.norm.feed_max_uur);
  if (!fo.ok) return mislukt(fo.reden);
  o.db.prepare('DELETE FROM bezetting_fout').run();
  const st = staat(o.db);
  const b = beoordeel({ bez, norm: nl.norm, vandaag, van, weken, goedZo: st.goedZo, keuze: st.keuze });
  const p = plan({ open: b.punten, punten: st.punten, kaarten: st.kaarten, vandaag });
  const uit = { ok: true, gedaan: true, nieuw: 0, opgelost: 0, gesloten: 0, open: 0, fouten: [], norm_fout: nl.fout || undefined };
  const t = new Date(nu).toISOString();
  const updAf = o.db.prepare('UPDATE bezetting_punt SET stand = ?, bijgewerkt = ? WHERE pr = ? AND sleutel = ? AND stand = \'gemeld\'');
  for (const a of p.af) { updAf.run(a.stand, t, a.pr, a.sleutel); uit.opgelost++; }
  const zetPunt = o.db.prepare(`INSERT INTO bezetting_punt (pr, sleutel, stand, kaart, sinds, bijgewerkt) VALUES (?, ?, 'gemeld', ?, ?, ?)
    ON CONFLICT (pr, sleutel) DO UPDATE SET stand = 'gemeld', kaart = excluded.kaart, bijgewerkt = excluded.bijgewerkt WHERE bezetting_punt.stand IN ('opgelost','voorbij')`);
  const zetKaart = o.db.prepare(`INSERT INTO bezetting_kaart (sleutel, pr, maandag, volgnr, punten, stand, gezet) VALUES (?, ?, ?, ?, ?, 'open', ?)`);
  for (const m of p.melden.slice(0, MAX_KAARTEN)) {
    try {
      await o.io.zet(kaart(m, o.nuKort || ''));
    } catch (e) { uit.fouten.push(m.sleutel + ': kaart niet gezet'); continue; }
    o.db.exec('BEGIN');
    try {
      zetKaart.run(m.sleutel, m.pr, m.maandag, m.volgnr, JSON.stringify(m.punten.map((x) => x.sleutel)), t);
      for (const x of m.punten) zetPunt.run(m.pr, x.sleutel, m.sleutel, t, t);
      o.db.exec('COMMIT');
    } catch (e) { o.db.exec('ROLLBACK'); uit.fouten.push(m.sleutel + ': administratie niet geschreven'); continue; }
    uit.nieuw++;
  }
  if (p.melden.length > MAX_KAARTEN) uit.fouten.push((p.melden.length - MAX_KAARTEN) + ' kaarten overgeslagen (hooguit ' + MAX_KAARTEN + ' per ronde)');
  // sluiten (ook de kaarten die door Davids "Is goed zo" af zijn)
  uit.gesloten = (await sluitAf(o.db, o.io, o.nuKort, t, p.sluit, uit.fouten)).length;
  uit.open = o.db.prepare("SELECT count(*) n FROM bezetting_kaart WHERE stand = 'open'").get().n;
  o.db.prepare('INSERT OR REPLACE INTO bezetting_ronde (dag, op, uitkomst) VALUES (?, ?, ?)').run(vandaag, t,
    JSON.stringify({ nieuw: uit.nieuw, opgelost: uit.opgelost, gesloten: uit.gesloten, open: uit.open, fouten: uit.fouten.length }));
  return uit;
}
/* Sluit de gegeven kaarten in Voor jou (door agent, met bewijs) en in de administratie; Davids eigen afhandeling blijft staan. */
async function sluitAf(db, io, nuKort, t, sleutels, fouten) {
  if (!sleutels.length) return [];
  let lijst = [];
  try { lijst = (await io.lijst()) || []; } catch (e) { fouten.push('Voor jou-lijst niet te lezen'); return []; }
  const dicht = [];
  const upd = db.prepare("UPDATE bezetting_kaart SET stand = 'dicht', gesloten = ? WHERE sleutel = ? AND stand = 'open'");
  for (const s of sleutels) {
    const v = lijst.find((p) => p && p.sleutel === s);
    if (v && (v.status === 'open' || v.status === 'later')) {
      let r;
      try { r = await io.status(s, v.status, 'gedaan', { bewijs: (nuKort ? nuKort + ': ' : '') + 'Alle dagen van deze kaart zijn geregeld (rooster aangevuld, waarneemverzoek staat, of door jou goed bevonden).', reden: 'docplan-bezetting: alle punten af' }); }
      catch (e) { r = null; }
      if (!r || r.ok !== true) { fouten.push(s + ': niet gesloten'); continue; }
    }
    upd.run(t, s);
    dicht.push(s);
  }
  return dicht;
}

// ───────────────────────────── app ─────────────────────────────
/*
 * maak({ rpc(fn, body), openDb() → DatabaseSync (schrijfbaar) | null, normTekst() → string|null, io, nuKort(), fout(waar, e) }) → { app, ronde }
 *   GET  /app/facturen/bezetting            12 weken vanaf deze maandag (tegel)
 *   GET  /app/facturen/bezetting/JJJJ-MM    de weken van die maand (maandoverzicht)
 *   POST /app/facturen/bezetting            { handeling: vink|ontvink, pr, datum } of { handeling: goed_zo|goed_zo_weg, pr, sleutel }
 * Alleen de eigenaar via de app, alleen op de primaire kant.
 */
function maak(o) {
  o = o || {};
  function metDb(f) {
    const db = o.openDb ? o.openDb() : null;
    if (!db) return null;
    try { schema(db); return f(db); } finally { try { db.close(); } catch (e) { /* al dicht */ } }
  }
  async function app(v) {
    const nu = Number.isFinite(v.nu) ? v.nu : Date.now();
    const m = PAD_RE.exec(String(v.pad || ''));
    if (!m || (v.methode !== 'GET' && v.methode !== 'POST') || (v.methode === 'POST' && m[1])) return { status: 404, j: { ok: false, fout: 'onbekend' }, reden: 'bezetting onbekend' };
    if (!v.rol || v.rol.soort !== 'eigenaar' || v.rol.ingang !== 'app') return { status: 403, j: { ok: false, fout: 'alleen de eigenaar' }, reden: 'bezetting geweigerd' };
    if (v.primair !== true) return { status: 409, j: { ok: false, fout: 'DocPlan draait alleen op de primaire kant' }, reden: 'bezetting niet primair' };
    const vandaag = dagAmsterdam(nu);
    if (v.methode === 'POST') return post(v.d, vandaag, nu);
    const nl = normLees(o.normTekst ? o.normTekst() : null);
    let van, weken, maand = null;
    if (m[1]) {
      const [y, mo] = m[1].split('-').map(Number);
      if (!(mo >= 1 && mo <= 12 && y >= 2025 && y <= Number(vandaag.slice(0, 4)) + 1)) return { status: 400, j: { ok: false, fout: 'maand buiten bereik' }, reden: 'bezetting maand' };
      maand = m[1];
      van = maandagVan(maand + '-01');
      const laatste = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      weken = Math.round((Date.parse(maandagVan(laatste)) - Date.parse(van)) / 6048e5) + 1;
    } else { van = maandagVan(vandaag); weken = nl.norm.tegel_weken; }
    let bez;
    try { bez = await o.rpc('sb_dienst_bezetting', { p_van: van, p_tot: isoPlus(van, 7 * weken - 1) }); } catch (e) {
      if (typeof o.fout === 'function') o.fout('bezetting', e);
      return { status: 503, j: { ok: false, fout: 'het rooster is nu niet te lezen' }, reden: 'bezetting fout' };
    }
    if (!bez || !Array.isArray(bez.dagen)) return { status: 503, j: { ok: false, fout: 'onverwacht antwoord van de databank' }, reden: 'bezetting fout' };
    const st = metDb(staat) || { goedZo: {}, keuze: {}, keuzeRij: {}, punten: [], kaarten: [] };
    const b = beoordeel({ bez, norm: nl.norm, vandaag, van, weken, goedZo: st.goedZo, keuze: st.keuze });
    const fo = feedsOk(bez.feeds, nu, nl.norm.feed_max_uur);
    const gemeld = new Map(st.punten.filter((p) => p.stand === 'gemeld').map((p) => [p.pr + '|' + p.sleutel, p.kaart]));
    for (const p of b.praktijken) {
      p.zonder_verzoek = 0;
      for (const w of p.weken) {
        for (const d of w.dagen) {
          const kr = ((st.keuzeRij || {})[p.code] || new Map()).get(d.datum);
          // wv2486: staat het item door de pod in de GEZOCHT-agenda, dan geen link meer maar "staat op de waarneemsite"
          d.op_site = !!(kr && kr.event_id && kr.stand === 'gezet');
          d.schrijf_fout = kr && !d.op_site && kr.stand && kr.stand !== 'gezet' ? schrijfFoutTekst(kr.stand, p.code) : null;
          d.link = !d.feestdag && !d.verleden && !d.op_site ? googleLink(p.agenda, d.datum) : null;
          d.gemeld = d.punten.some((s) => gemeld.has(p.code + '|' + s));
          if (d.kleur === 'rood' && !d.verleden && d.datum <= b.tot && !d.goed_zo) p.zonder_verzoek++;
        }
        delete w.meldbaar;
      }
      delete p.agenda;
    }
    const ronde = metDb((db) => db.prepare('SELECT dag, op, uitkomst FROM bezetting_ronde ORDER BY dag DESC LIMIT 1').get()) || null;
    return { status: 200, reden: 'bezetting ' + (maand || 'tegel'), j: { ok: true, vandaag, van, weken, maand, vooruit_weken: nl.norm.vooruit_weken, tot: b.tot,
      norm_fout: nl.fout, feeds: { ok: fo.ok, reden: fo.reden, laatste: fo.laatste || null }, praktijken: b.praktijken,
      ronde: ronde ? { dag: ronde.dag, op: ronde.op } : null, schrijven: typeof o.gezocht === 'function' ? 'zelf' : 'link' } };
  }
  // wv2486: één schrijfhandeling tegelijk per (praktijk, dag); een tweede tik in die tijd = 409
  const bezig = new Set();
  async function post(d, vandaag, nu) {
    d = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    if (!PRAKTIJK[d.pr]) return { status: 400, j: { ok: false, fout: 'onbekende praktijk' }, reden: 'bezetting ongeldig' };
    const t = new Date(nu).toISOString();
    if (d.handeling === 'vink' || d.handeling === 'ontvink') {
      if (!geldigIso(d.datum) || d.datum <= vandaag || feestdag(d.datum) || weekdag(d.datum) % 6 === 0) return { status: 400, j: { ok: false, fout: 'kies een werkdag vanaf morgen' }, reden: 'bezetting vink ongeldig' };
      if (d.datum > isoPlus(vandaag, 400)) return { status: 400, j: { ok: false, fout: 'te ver vooruit' }, reden: 'bezetting vink ongeldig' };
      const slot = d.pr + '|' + d.datum;
      if (bezig.has(slot)) return { status: 409, j: { ok: false, fout: 'even geduld: deze dag wordt net bijgewerkt' }, reden: 'bezetting bezig' };
      bezig.add(slot);
      try { return d.handeling === 'vink' ? await vink(d, t) : await ontvink(d, t); } finally { bezig.delete(slot); }
    }
    if (d.handeling === 'goed_zo' || d.handeling === 'goed_zo_weg') {
      const pm = PUNT_RE.exec(String(d.sleutel || ''));
      if (!pm || !geldigIso(pm[2]) || (pm[1] === 'week' && weekdag(pm[2]) !== 1)) return { status: 400, j: { ok: false, fout: 'onbekend punt' }, reden: 'bezetting goed zo ongeldig' };
      const r = metDb((db) => {
        if (d.handeling === 'goed_zo') db.prepare(`INSERT INTO bezetting_punt (pr, sleutel, stand, kaart, sinds, bijgewerkt) VALUES (?, ?, 'goed_zo', NULL, ?, ?)
          ON CONFLICT (pr, sleutel) DO UPDATE SET stand = 'goed_zo', bijgewerkt = excluded.bijgewerkt`).run(d.pr, d.sleutel, t, t);
        else db.prepare("UPDATE bezetting_punt SET stand = 'opgelost', kaart = NULL, bijgewerkt = ? WHERE pr = ? AND sleutel = ? AND stand = 'goed_zo'").run(t, d.pr, d.sleutel);
        return true;
      });
      if (!r) return { status: 503, j: { ok: false, fout: 'niet opgeslagen: de DocPlan-administratie is er niet' }, reden: 'bezetting geen db' };
      return { status: 200, j: { ok: true, handeling: d.handeling, pr: d.pr, sleutel: d.sleutel }, reden: 'bezetting ' + d.handeling };
    }
    return { status: 400, j: { ok: false, fout: 'onbekende handeling' }, reden: 'bezetting ongeldig' };
  }
  function keuzeRij(pr, datum) { return metDb((db) => db.prepare('SELECT pr, datum, event_id, stand FROM bezetting_keuze WHERE pr = ? AND datum = ?').get(pr, datum) || null); }
  async function schrijf(body) {
    if (typeof o.gezocht !== 'function') return { ok: false, fout: 'niet_ingericht' };
    try { const r = await o.gezocht(body); return r && typeof r === 'object' ? r : { ok: false, fout: 'leeg antwoord' }; }
    catch (e) { if (typeof o.fout === 'function') o.fout('bezetting-gezocht', e); return { ok: false, fout: 'n8n niet bereikbaar' }; }
  }
  async function vink(d, t) {
    const ok = metDb((db) => { db.prepare('INSERT OR IGNORE INTO bezetting_keuze (pr, datum, op, door, bijgewerkt) VALUES (?, ?, ?, ?, ?)').run(d.pr, d.datum, t, 'david', t); return true; });
    if (!ok) return { status: 503, j: { ok: false, fout: 'niet opgeslagen: de DocPlan-administratie is er niet' }, reden: 'bezetting geen db' };
    const rij = keuzeRij(d.pr, d.datum);
    if (rij && rij.event_id && rij.stand === 'gezet') return { status: 200, j: { ok: true, handeling: 'vink', pr: d.pr, datum: d.datum, op_site: true }, reden: 'bezetting vink (stond al)' };
    const r = await schrijf({ actie: 'plaatsen', pr: d.pr, datum: d.datum });
    const idOk = r.ok === true && typeof r.event_id === 'string' && /^[a-z0-9_]{5,200}$/.test(r.event_id);
    const stand = idOk ? 'gezet' : r.fout === 'geen_schrijfrecht' ? 'geen_recht' : r.fout === 'niet_ingericht' ? 'link' : 'fout';
    const bewaard = metDb((db) => db.prepare('UPDATE bezetting_keuze SET event_id = ?, stand = ?, fout = ?, bijgewerkt = ? WHERE pr = ? AND datum = ?')
      .run(idOk ? r.event_id : null, stand, idOk ? null : String(r.fout || '?').slice(0, 200), t, d.pr, d.datum).changes === 1);
    // review MOET 2: item gezet maar id niet bewaard → ontvinken zoekt het later op datum (stand blijft leeg = mogelijk gezet)
    if (!bewaard) return { status: 503, j: { ok: false, fout: 'het verzoek staat mogelijk op de waarneemsite, maar is niet goed opgeslagen; vink opnieuw aan' }, reden: 'bezetting vink niet bewaard' };
    return { status: 200, j: { ok: true, handeling: 'vink', pr: d.pr, datum: d.datum, op_site: idOk, schrijf_fout: idOk ? null : schrijfFoutTekst(stand, d.pr) },
      reden: 'bezetting vink ' + stand };
  }
  async function ontvink(d, t) {
    const rij = keuzeRij(d.pr, d.datum);
    // review MOET 2: ook zonder bewaard id weghalen (op datum, alleen items met de markering van de pod) als het item er misschien staat:
    // stand fout (antwoord verloren) of leeg (update mislukt). Nooit bij geen_recht of link: dan schreef de pod niets.
    if (rij && (rij.event_id || (rij.stand !== 'geen_recht' && rij.stand !== 'link' && typeof o.gezocht === 'function'))) {
      const r = await schrijf(rij.event_id ? { actie: 'weghalen', pr: d.pr, datum: d.datum, event_id: rij.event_id } : { actie: 'weghalen', pr: d.pr, datum: d.datum });
      if (!(r.ok === true || r.fout === 'niet_eigen')) {
        metDb((db) => db.prepare("UPDATE bezetting_keuze SET fout = ?, bijgewerkt = ? WHERE pr = ? AND datum = ?").run(String(r.fout || '?').slice(0, 200), t, d.pr, d.datum));
        return { status: 502, j: { ok: false, fout: 'niet weggehaald van de waarneemsite; probeer het zo opnieuw' }, reden: 'bezetting ontvink fout' };
      }
      // niet_eigen: het item draagt de markering van de pod niet (meer); dan raakt de pod het niet en vergeet alleen het vinkje
      if (r.fout === 'niet_eigen') {
        metDb((db) => db.prepare('DELETE FROM bezetting_keuze WHERE pr = ? AND datum = ?').run(d.pr, d.datum));
        return { status: 200, j: { ok: true, handeling: 'ontvink', pr: d.pr, datum: d.datum, let_op: 'Het verzoek in de GEZOCHT-agenda is niet (meer) van Socev; haal het zo nodig zelf weg in Google Agenda.' }, reden: 'bezetting ontvink niet eigen' };
      }
    }
    const ok = metDb((db) => { db.prepare('DELETE FROM bezetting_keuze WHERE pr = ? AND datum = ?').run(d.pr, d.datum); return true; });
    if (!ok) return { status: 503, j: { ok: false, fout: 'niet opgeslagen: de DocPlan-administratie is er niet' }, reden: 'bezetting geen db' };
    return { status: 200, j: { ok: true, handeling: 'ontvink', pr: d.pr, datum: d.datum }, reden: 'bezetting ontvink' };
  }
  /* Kaarten waarvan alle punten nu af zijn (na Davids "Is goed zo") meteen sluiten; server.js roept dit na een geslaagde POST goed_zo. */
  async function naGoedZo() {
    const db = o.openDb ? o.openDb() : null;
    if (!db || !o.io) return [];
    try {
      schema(db);
      const st = staat(db);
      // alleen open kaarten waarop geen punt meer 'gemeld' staat; de rest wacht op de ochtendronde
      const nogGemeld = new Set(st.punten.filter((x) => x.stand === 'gemeld').map((x) => x.kaart));
      const sluit = st.kaarten.filter((k) => k.stand === 'open' && !nogGemeld.has(k.sleutel)).map((k) => k.sleutel);
      return await sluitAf(db, o.io, o.nuKort ? o.nuKort() : '', new Date().toISOString(), sluit, []);
    } finally { try { db.close(); } catch (e) { /* al dicht */ } }
  }
  async function ochtend(x) {
    const db = o.openDb ? o.openDb() : null;
    if (!db) return null;
    try { return await ronde(Object.assign({ rpc: o.rpc, db, io: o.io, normTekst: o.normTekst ? o.normTekst() : null, nuKort: o.nuKort ? o.nuKort() : '' }, x || {})); }
    finally { try { db.close(); } catch (e) { /* al dicht */ } }
  }
  return { app, naGoedZo, ochtend };
}

module.exports = { maak, ronde, plan, beoordeel, week, kaart, feedsOk, normLees, normTekst, feestdagen, feestdag, pasen, googleLink, schema, staat, schrijfFoutTekst,
  maandagVan, isoWeek, NORM_STANDAARD, PAD_RE, KAART_RE };
