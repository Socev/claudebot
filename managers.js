'use strict';
// Managers op afroep (wv895, 23-10-2026; ontwerp + Fable-review: mk-scripts/wv895/ontwerp.md). David: "Alle Managers moeten zowel
// door mij als door jou, Socev, ook op afroep aangesproken/aangezwengeld kunnen worden."
// Een manager = een vaste weekronde (n8n: /reset + /run op zijn eigen sessie, skill doet het werk). Op afroep doet de pod hetzelfde
// op dezelfde sessie (dus dezelfde omgeving en skill), met een vaste prompt; de aanroeper kiest alleen de naam (en een reden uit een
// vaste lijst, die nooit in de prompt komt: de ronde draait in een machinekamer-sessie). Het rapport gaat naar de machinekamer.
// Grenzen (Fable wv895): loopt al (ook een n8n-weekronde) → 409; 90 min vóór de weekronde → 409; elke job op die sessie in het
// laatste uur → 429; 3 afroepen per manager en 6 totaal per 24 u; uitrol wacht → 503; onder Davids reserve op account 1 → 429.
// Socev (SOCEV_AGENT_SLEUTEL) start alleen met een verse Ja-knopdruk van David (≤ 15 min, app, hoofdkanaal) op precies de vraag
// "Zal ik de <naam> nu een ronde laten draaien?"; één Ja = één ronde. De ronde draait in een sessie met (bijna) volle omgeving en leest
// een skill uit de vault. EERLIJK (Fable diffreview wv895 #1): zolang het hoofdkanaal als dezelfde uid als de pod draait (loper nog niet
// voor 40687), kan een gemanipuleerde Socev-sessie het vragenregister zelf schrijven; dan is deze eis een tussenstap, geen grens. Hij
// wordt een grens zodra de loper het hoofdkanaal als socev draait. De echte sluiting (skill en scripts van de manager uit de release
// in plaats van de vault) staat als vervolgrij in de werkvoorraad. De machinekamer (API_SECRET) start direct.
// Geen kaart, bundel, registerrij of werkvoorraadrij op afroep (staat in de prompt en de skills).
// wv4128 (besluitenpagina nr 74 = C64, David Ja 25-11-2026 met vingerafdruk): op afroep alleen nog door de machinekamer (API_SECRET,
// "draai de CISO-ronde"). De knop Nu draaien in de app (POST /app/managers/ronde) en Socevs route met Davids Ja-knop zijn weg; start()
// weigert david en socev met 403. Oude afroepen in staat.json blijven leesbaar (DOOR).
// wv4128 (nr 329 = 3C29): een gemiste ronde in gewone taal (gemistZin; n8n schrijft dezelfde zin, de pod onthoudt hem uit het bericht
// voor de kaart bij "te laat"). wv4128 (nr 436 = 3C136): het rapport van een ronde = zijn box-rij ("- van: wachter:<x> (ronde …)");
// rapporten() leest de vijf nieuwste uit de box en het boxarchief (alleen lezen).
// Logica hier, de koppeling (routes, jobs, bericht, RPC) in server.js. Geen netwerk, geen sleutels in dit bestand.
const fs = require('fs');
const path = require('path');

const UUR = 3600000, DAG = 24 * UUR;
const VOOR_WEEKRONDE_MS = 90 * 60000;
const PER_MANAGER_24U = 3, TOTAAL_24U = 6;
const REDENEN = { 'david-vroeg': 'David vroeg erom', 'na-bouwstap': 'na een bouwstap', controle: 'controle' };
const DOOR = { david: 'door jou', socev: 'door Socev', machinekamer: 'door de machinekamer' };

// Het register (de naam-whitelist). Een nieuwe manager = één regel hier (+ test/managers.sh). rooster: dag 0 = zondag, tijd Europe/Amsterdam (de n8n-trigger).
const MANAGERS = [
  { id: 'data', naam: 'Data Manager', skill: 'data-manager', sessie: 'data-manager', model: 'claude-sonnet-5-5', hartslag: 'data_manager', patroon: '^DM[0-9]', onderhoud: ['DM9', 'DM10'], boxVan: ['data-manager'],
    bewaakt: 'Waar al je gegevens staan (databanken, pod, Drive, vault) en of elke plek een backup en een eigenaar heeft.',
    rooster: { dag: 0, uur: 9, min: 30 }, slot: 'DATA-MANAGER', slotRe: /^DATA-MANAGER \d{4}-\d{2}-\d{2}: [1-9]\d* bronnen gemeten/,
    slotFormaat: 'DATA-MANAGER <JJJJ-MM-DD>: <n> bronnen gemeten, <m> niet vast te stellen, <N> open (<k> nieuw), kaart geen' },
  // wv4116 (besluit nr 71 / C61, David 25-11-2026): Design en UI Manager zijn één ronde met twee delen (vorm DS, gebruik UI), om de week
  // op zaterdag 10:00 vanaf 28-11-2026 (de n8n-IF in AI - Design Manager kiest dezelfde weken); AI - UI Manager staat uit. Afroep = beide delen.
  { id: 'design', naam: 'Design Manager', skill: 'design-manager', sessie: 'design-manager', model: 'claude-sonnet-5-5', hartslag: 'design_manager', patroon: '^DS[0-9]', delen: ['ui'], boxVan: ['design-manager', 'ui-manager'],
    bewaakt: 'Om de week, in één ronde: of alle apps één vormgeving houden (Socev-blauw, de bouwdoos, een logische indeling) en hoe je de app echt gebruikt (waar je vastloopt, wat traag is of niets doet).',
    rooster: { dag: 6, uur: 10, min: 0, omDeWeekVanaf: '2026-11-28' }, slot: 'DESIGN-MANAGER', slotRe: /^DESIGN-MANAGER \d{4}-\d{2}-\d{2}: \d+ checks/,
    slotFormaat: 'DESIGN-MANAGER <JJJJ-MM-DD>: <n> checks, <m> niet vast te stellen, <N> open (<k> nieuw), kaart geen, wv geen' },
  { id: 'ciso', naam: 'CISO', skill: 'ciso', sessie: 'ciso', model: 'claude-opus-5-5', hartslag: 'ciso', patroon: '^C[0-9]', boxVan: ['ciso'],
    bewaakt: 'De beveiliging: sleutels, toegang, versies en wat er van buitenaf bereikbaar is.',
    rooster: { dag: 1, uur: 6, min: 0 }, slot: 'CISO', slotRe: /^CISO \d{4}-\d{2}-\d{2}: \d+ checks/,
    slotFormaat: 'CISO <JJJJ-MM-DD>: <n> checks, <m> niet vast te stellen, <N> open (<k> nieuw), bundel <id of geen>' },
  // wv2430 MrLean (wo 10:00, Sonnet; David 4-11-2026): meet wat controles, vragen, vingerafdrukken en regels kosten en opleveren en
  // legt voorstellen voor (Voor jou-kaarten); schrapt nooit zelf. Ontwerp: 01_Ontwikkeling/MrLean - de lean-manager (ontwerp 4-11-2026).md
  { id: 'mrlean', naam: 'MrLean', skill: 'mrlean', sessie: 'mrlean', model: 'claude-sonnet-5-5', hartslag: 'mrlean', patroon: '^ML[0-9]', boxVan: ['mrlean'],
    bewaakt: 'Of alles lean blijft: controles, nacontroles, vragen aan jou, vingerafdrukken en regels die niets opleveren.',
    rooster: { dag: 3, uur: 10, min: 0 }, slot: 'MRLEAN', slotRe: /^MRLEAN \d{4}-\d{2}-\d{2}: \d+ checks/,
    slotFormaat: 'MRLEAN <JJJJ-MM-DD>: <n> checks, <m> niet vast te stellen, <k> kandidaten, voorstellen <v>, kaarten geen' },
  // wv979 Bibliothecaris (OVIS): geen sessie maar een script (ovis-run.js bibliothecaris, geen taalmodel), elke nacht 02:30 via de
  // pod-tijdklok in server.js. Op afroep: geen quotumtoets (geen model), wel dezelfde grenzen; geen hartslagstempel en geen box-rij.
  { id: 'bibliothecaris', naam: 'Bibliothecaris', soort: 'script', model: 'geen', hartslag: 'bibliothecaris', patroon: '^BB[0-9]',
    bewaakt: 'Of je Second Brain en de databank hetzelfde zeggen over elke entiteit (stamgegevens, herkenningskenmerken, contactgegevens).',
    rooster: { dagelijks: true, uur: 2, min: 30 }, voorMs: 30 * 60000 },
];
// wv4116: een deel van een manager zonder eigen kaart (de RPC mk_managers_stand neemt per regel één patroon ^XX[0-9]); stand() telt het
// bij zijn manager op. Geen afroep, geen eigen rooster.
const DELEN = [{ id: 'ui', naam: 'UI Manager', hartslag: 'ui_manager', patroon: '^UI[0-9]', deelVan: 'design' }];
const ERNST_RANG = { kritiek: 0, critical: 0, serious: 1, hoog: 1, warning: 2, middel: 2 };
// wv4123 (besluitenpagina 3C13/3C35/3C43, David Ja 25-11-2026): de RPC geeft elk punt een groep: 'jou' (de kaart ligt bij David),
// 'mk' (bij de machinekamer), 'onderhoud' (vaste lijst per manager hierboven: controles die per ontwerp doorlopen) en 'besloten'
// (David besliste al; telt niet meer als open, staat onder "Besloten door jou"). Volgorde op de kaart: jou, mk, onderhoud.
const GROEP_RANG = { jou: 0, mk: 1, onderhoud: 2 };
// Eén gewone zin voor een onderhoudspunt zonder eigen uitleg (de afwerkklus schrijft de uitleg van de andere punten in de state).
const ONDERHOUD_ZIN = {
  DM9: 'Een stukje pod-code haalt zelf gegevens op én maakt de tekst die je ziet; dat wordt bij het eerstvolgende werk eraan gesplitst. Doorlopend onderhoud, jij hoeft niets.',
  DM10: 'Een scherm in de app haalt zelf gegevens op of beslist zelf wat je ziet; dat wordt bij het eerstvolgende werk eraan rechtgezet. Doorlopend onderhoud, jij hoeft niets.',
};
function rangPunt(b) {
  const g = GROEP_RANG[b.groep]; const r = ERNST_RANG[String(b.ernst || '').toLowerCase()];
  return [g == null ? 1 : g, r == null ? 3 : r];
}
function sorteer(l) {
  return l.sort(function (a, b) { const x = rangPunt(a), y = rangPunt(b); return x[0] - y[0] || x[1] - y[1] || String(b.laatst_gezien || '').localeCompare(String(a.laatst_gezien || '')); });
}
const GROEPEN_LEEG = { jou: 0, mk: 0, onderhoud: 0, besloten: 0 };
// hooguit n punten per groep (de RPC doet dat per manager; na samenvoegen met een deel opnieuw), volgorde blijft (review Codex MOET 1)
function perGroep(l, n) {
  const tel = {};
  return l.filter(function (b) { const g = b.groep || '?'; tel[g] = (tel[g] || 0) + 1; return tel[g] <= n; });
}
function samenvoegen(d, x) {
  if (!x) return d;
  if (!d) return x;
  const pe = Object.assign({}, d.per_ernst || {});
  Object.keys(x.per_ernst || {}).forEach(function (k) { pe[k] = (Number(pe[k]) || 0) + (Number(x.per_ernst[k]) || 0); });
  const top = sorteer((Array.isArray(d.top) ? d.top : []).concat(Array.isArray(x.top) ? x.top : []));
  const uit = Object.assign({}, d, { aantal: (Number(d.aantal) || 0) + (Number(x.aantal) || 0), per_ernst: pe, top: d.groepen || x.groepen ? top : top.slice(0, 5) });
  if (d.groepen || x.groepen) {   // wv4123
    const g = Object.assign({}, GROEPEN_LEEG);
    [d.groepen || {}, x.groepen || {}].forEach(function (y) { Object.keys(g).forEach(function (k) { g[k] += Number(y[k]) || 0; }); });
    uit.groepen = g;
    uit.totaal = (Number(d.totaal) || 0) + (Number(x.totaal) || 0);
    uit.besloten = (Array.isArray(d.besloten) ? d.besloten : []).concat(Array.isArray(x.besloten) ? x.besloten : [])
      .sort(function (a, b) { return String((b.besluit || {}).op || '').localeCompare(String((a.besluit || {}).op || '')); }).slice(0, 10);
  }
  return uit;
}
const PER_ID = {};
MANAGERS.forEach(function (m) { PER_ID[m.id] = m; });

// ── tijd in Amsterdam ──
const AMS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short' });
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function amsDelen(t) {
  const p = {};
  AMS.formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
  return { j: +p.year, m: +p.month, d: +p.day, u: +p.hour, mi: +p.minute, wd: WD[p.weekday] };
}
// lokale Amsterdamse tijd → epoch-ms (twee rondes voor de zomertijdgrens)
function amsNaarMs(j, m, d, u, mi) {
  let g = Date.UTC(j, m - 1, d, u, mi);
  for (let i = 0; i < 2; i++) {
    const x = amsDelen(g);
    const verschil = Date.UTC(x.j, x.m - 1, x.d, x.u, x.mi) - Date.UTC(j, m - 1, d, u, mi);
    g -= verschil;
  }
  return g;
}
function amsDatum(t) { const x = amsDelen(t); return x.j + '-' + String(x.m).padStart(2, '0') + '-' + String(x.d).padStart(2, '0'); }
function amsKlok(t) { const x = amsDelen(t); return String(x.u).padStart(2, '0') + ':' + String(x.mi).padStart(2, '0'); }
// wv4116: om de week vanaf een ankerdatum (JJJJ-MM-DD, zelf een rondedag); vóór het anker gold het weekritme. Hele kalenderdagen, geen klok.
function rondeWeek(m, dag) {
  const v = m.rooster.omDeWeekVanaf;
  if (!v) return true;
  const a = v.split('-').map(Number), dagen = Math.round((dag.getTime() - Date.UTC(a[0], a[1] - 1, a[2])) / DAG);
  return dagen < 0 || Math.floor(dagen / 7) % 2 === 0;
}
// eerstvolgende weekronde ná t (of precies op t)
function volgendeWeekronde(m, t) {
  const x = amsDelen(t);
  for (let i = 0; i <= 14; i++) {
    const dag = new Date(Date.UTC(x.j, x.m - 1, x.d + i));
    if (!m.rooster.dagelijks && dag.getUTCDay() !== m.rooster.dag) continue;
    if (!m.rooster.dagelijks && !rondeWeek(m, dag)) continue;
    const ms = amsNaarMs(dag.getUTCFullYear(), dag.getUTCMonth() + 1, dag.getUTCDate(), m.rooster.uur, m.rooster.min);
    if (ms >= t) return ms;
  }
  return null;
}
// laatste geplande ronde vóór (of op) t
function vorigeWeekronde(m, t) {
  const x = amsDelen(t);
  for (let i = 0; i <= 14; i++) {
    const dag = new Date(Date.UTC(x.j, x.m - 1, x.d - i));
    if (!m.rooster.dagelijks && dag.getUTCDay() !== m.rooster.dag) continue;
    if (!m.rooster.dagelijks && !rondeWeek(m, dag)) continue;
    const ms = amsNaarMs(dag.getUTCFullYear(), dag.getUTCMonth() + 1, dag.getUTCDate(), m.rooster.uur, m.rooster.min);
    if (ms <= t) return ms;
  }
  return null;
}
const DAGNAMEN = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
function dagDatum(t) { const x = amsDelen(t); return DAGNAMEN[x.wd] + ' ' + x.d + '-' + x.m; }

// ── wv4128 (3C29): een gemiste ronde in gewone taal ──
// Vaste redenen; n8n (Toets antwoord, Voortgang, Startfout in de vier managerworkflows) schrijft dezelfde zinnen.
const GEMIST_REDEN = {
  poort: 'de controle vooraf zag een wijziging in zijn instructies, dus hij startte niet; Socev haalt hem in zodra dat weer klopt',
  onbekend: 'de reden is niet vastgelegd; de machinekamer zoekt het uit',
};
function gemistZin(m, tGepland, reden, nu) {
  const v = volgendeWeekronde(m, Math.max(nu, tGepland) + 60000);
  return m.naam + ' heeft ' + DAGNAMEN[amsDelen(tGepland).wd] + ' niet gedraaid: ' + (GEMIST_REDEN[reden] || String(reden || GEMIST_REDEN.onbekend)) +
    '; volgende ronde ' + (v ? dagDatum(v) : 'onbekend') + '; je hoeft niets te doen.';
}
// De zin terugvinden in een bericht (n8n Meld fout → /bericht, kanaal machinekamer): {id, zin} of null
const GEMIST_RE = /^(Data Manager|Design Manager|CISO|MrLean|Bibliothecaris) heeft (zondag|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|vannacht) niet gedraaid: [^\n]{3,400}?; volgende ronde [^;\n]{3,40}; je hoeft niets te doen\./;
function gemistUitTekst(tekst) {
  const x = GEMIST_RE.exec(String(tekst || '').trim());
  if (!x) return null;
  const m = MANAGERS.find(function (y) { return y.naam === x[1]; });
  return m ? { id: m.id, zin: x[0] } : null;
}
function managerLink(m) { return '/?app=managers&manager=' + m.id; }

// ── wv4128 (3C136): rapporten = box-rijen van een ronde ──
// teksten: inhoud van de box en de archiefmaanden (nieuwste eerst maakt niet uit; er wordt op datum gesorteerd). Een rij hoort bij m als
// hij een regel "- van: wachter:<boxVan> (ronde <JJJJ-MM-DD>…)" heeft. Max n, nieuwste eerst; tekst hooguit 20000 tekens.
const RAPPORT_MAX = 20000;
function rapporten(teksten, m, n) {
  if (!m || !m.boxVan) return [];
  const uit = [], gezien = {};
  (teksten || []).forEach(function (s) {
    String(s || '').split(/^(?=## )/m).forEach(function (rij) {
      if (rij.slice(0, 3) !== '## ') return;
      const v = /^- van: wachter:([a-z-]+) \(ronde (\d{4}-\d{2}-\d{2})([^)\n]*)\)/m.exec(rij);
      if (!v || m.boxVan.indexOf(v[1]) < 0) return;
      const kop = rij.split('\n')[0].replace(/^## (\[[a-z]+\] )?/, '').replace(/(\s+#[\w-]+)+\s*$/, '').trim();
      const sl = v[1] + ' ' + v[2] + v[3] + ' ' + kop;   // review Codex ZOU 1: twee rondes op één dag blijven twee rapporten
      if (gezien[sl]) return;   // dezelfde rij in box én archief (archiefstap halverwege)
      gezien[sl] = true;
      const body = rij.split('\n').slice(1).join('\n').replace(/\s+$/, '');
      uit.push({ datum: v[2], wie: v[1], titel: kop.slice(0, 200), tekst: body.length > RAPPORT_MAX ? body.slice(0, RAPPORT_MAX) + '\n…' : body });
    });
  });
  return uit.sort(function (a, b) { return b.datum.localeCompare(a.datum) || b.titel.localeCompare(a.titel); }).slice(0, n || 5);
}
function roosterTekst(m) { return (m.rooster.dagelijks ? 'elke nacht' : (m.rooster.omDeWeekVanaf ? 'om de week op ' : 'elke ') + DAGNAMEN[m.rooster.dag]) + ' ' + String(m.rooster.uur).padStart(2, '0') + ':' + String(m.rooster.min).padStart(2, '0'); }

// ── de prompt (vast; alleen naam en wie) ──
function prompt(m, door, nu) {
  const wie = door === 'david' ? 'gestart door David in de app' : door === 'socev' ? 'gestart door Socev' : 'gestart door de machinekamer';
  return '[MACHINEKAMER - ' + m.naam.toUpperCase() + ' - OP AFROEP] Dit is een ronde op afroep (' + wie + '), buiten de vaste weekronde (' + roosterTekst(m) +
    '); geen vraag van David om te beantwoorden. Je bent hier de machinekamer, niet Socev: niets naar het hoofdkanaal. DATUM = ' + amsDatum(nu) +
    ' (gebruik deze, niet de podklok). Voer de skill `' + m.skill + '` volledig uit (.claude/skills/' + m.skill + '/SKILL.md), met de regels van de sectie "Op afroep" ' +
    'in die skill: zet bij deze ronde GEEN Voor jou-kaart, GEEN bundel, GEEN rij in Open vragen aan David en GEEN werkvoorraadrij (uitzondering: een kritiek ' +
    'beveiligingslek zoals de skill beschrijft), en GEEN hartslagstempel. Wat David moet beslissen of weten, zet je in je slotregels. ' +
    'Je laatste antwoord is: hooguit drie korte regels in gewone taal voor David, elk hooguit 300 tekens (wat je vond, wat nieuw is sinds de vorige ronde, wat er bij hem of de ' +
    'machinekamer ligt; geen paden, geen ids, geen sleutels, geen markdown), en daarna als allerlaatste regel exact in dit formaat, zonder iets erna: ' + m.slotFormaat;
}

// Een regel die op een sleutel lijkt, gaat niet mee in het rapport (de skills controleren zelf ook; dit is de vangrail).
const SLEUTEL_RE = /(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|\b[0-9a-f]{40,}\b|\b[A-Za-z0-9+/]{48,}={0,2})/;
// wv1722: een te lange regel kapt af op een woordgrens met "…", zodat David ziet dat er iets mist (niet midden in een woord of zin stil).
function kort(s, n) {
  s = String(s);
  if (s.length <= n) return s;
  let knip = s.slice(0, n);
  if (!/\s/.test(s.charAt(n))) { const w = knip.search(/\s\S*$/); if (w > n / 2) knip = knip.slice(0, w); }
  return knip.replace(/[\s,;:]+$/, '') + '…';
}
function rapportRegels(output, m) {
  const regels = String(output || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  const laatste = regels.length ? regels[regels.length - 1] : '';
  const goed = m.slotRe.test(laatste);
  const voor = (goed ? regels.slice(0, -1) : regels).slice(-3).map(function (s) {
    s = s.replace(/^[-*•]\s+/, '').replace(/\*\*|__|`/g, '');
    return SLEUTEL_RE.test(s) ? '(regel weggelaten: leek op een sleutel)' : kort(s, 300);
  });
  return { goed: goed, regels: voor, telling: goed ? laatste.replace(/^[A-Z-]+ \d{4}-\d{2}-\d{2}:\s*/, '').slice(0, 200) : '' };
}

function maak(o) {
  const nu = o.nu || Date.now;
  const pad = path.join(o.dir, 'staat.json');
  const bezig = {};   // id → true tijdens de async start (geen twee starts tegelijk)
  const scriptLoopt = {};   // wv979: id → { job_id, created } zolang een scriptmanager draait (geen sessie, dus geen job in de rij)
  function lees() {
    try { const s = JSON.parse(fs.readFileSync(pad, 'utf8')); if (s && Array.isArray(s.afroepen)) return s; } catch (e) {}
    return { afroepen: [] };
  }
  function schrijf(s) {
    const grens = nu() - 7 * DAG;
    s.afroepen = s.afroepen.filter(function (a) { return a.t >= grens; }).slice(-200);
    fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    const tmp = pad + '.nieuw';
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, pad);
  }
  function lopendJob(m) {
    if (m.soort === 'script') { const x = scriptLoopt[m.id] || (o.scriptLoopt && o.scriptLoopt(m.id)); return x ? { id: x.job_id, status: 'running', created: x.created } : null; }
    return (o.jobsOpSessie(m.sessie) || []).find(function (j) { return j.status === 'pending' || j.status === 'running'; }) || null;
  }
  function jobsVan(m) { return m.soort === 'script' ? [] : (o.jobsOpSessie(m.sessie) || []); }
  // Mag het nu? Synchroon (zonder de quotumtoets). {ok:true} of {status, fout, weer_om?}
  function kan(m, door, eigenStart) {
    const t = nu();
    if (!o.rolPrimair()) return { status: 409, fout: 'Socev draait nu op de reservekant; probeer het later' };
    if (o.uitrolWacht()) return { status: 503, fout: 'Socev wordt net bijgewerkt; probeer het over een paar minuten' };
    if ((bezig[m.id] && !eigenStart) || lopendJob(m)) return { status: 409, fout: m.naam + ' loopt al', loopt: true };
    const vw = volgendeWeekronde(m, t);
    if (vw && vw - t < (m.voorMs || VOOR_WEEKRONDE_MS)) return { status: 409, fout: 'de weekronde komt om ' + amsKlok(vw) + '; dan draait hij vanzelf', weer_om: vw + UUR };
    const s = lees();
    const recentJob = jobsVan(m).reduce(function (x, j) { return Math.max(x, j.created || 0); }, 0);
    const recentAfroep = s.afroepen.filter(function (a) { return a.id === m.id; }).reduce(function (x, a) { return Math.max(x, a.t); }, 0);
    const laatst = Math.max(recentJob, recentAfroep);
    if (laatst && t - laatst < UUR) return { status: 429, fout: m.naam + ' draaide net; hooguit één keer per uur', weer_om: laatst + UUR };
    const dag = s.afroepen.filter(function (a) { return t - a.t < DAG; });
    const vanHem = dag.filter(function (a) { return a.id === m.id; });
    if (vanHem.length >= PER_MANAGER_24U) return { status: 429, fout: m.naam + ' draaide al ' + PER_MANAGER_24U + ' keer op afroep in 24 uur', weer_om: Math.min.apply(null, vanHem.map(function (a) { return a.t; })) + DAG };
    if (dag.length >= TOTAAL_24U) return { status: 429, fout: 'al ' + TOTAAL_24U + ' rondes op afroep in 24 uur (alle managers samen)', weer_om: Math.min.apply(null, dag.map(function (a) { return a.t; })) + DAG };
    return { ok: true };
  }
  function bericht(m, a, tekst) {
    const soort = a.door === 'machinekamer' ? 'archief' : 'antwoord';
    return Promise.resolve().then(function () { return o.bericht({ tekst: tekst, soort: soort, sleutel: 'manager:' + (a.job_id || a.id + ':' + a.t) }); })
      .catch(function (e) { o.fout('manager-bericht', e); });
  }
  function kop(m, a) {
    return '**' + m.naam + '** — ronde op afroep (' + DOOR[a.door] + (a.reden && a.reden !== 'david-vroeg' ? ', ' + REDENEN[a.reden] : '') + ', ' + amsKlok(a.t) + ')';
  }
  function naRun(m, a, r) {
    const s = lees();
    const x = s.afroepen.find(function (y) { return y.job_id === a.job_id; });
    const rr = m.soort === 'script' ? { goed: !!(r && r.ok), regels: r && r.zin ? [kort(r.zin, 300)] : [], telling: r ? (Number(r.open) || 0) + ' open (' + (Number(r.nieuw) || 0) + ' nieuw)' : '' } : rapportRegels(r && r.output, m);
    const goed = !!r && r.ok !== false && rr.goed;
    if (x) { x.uitkomst = goed ? 'goed' : 'fout'; x.klaar = nu(); try { schrijf(s); } catch (e) { o.fout('manager-staat', e); } }
    let tekst;
    if (goed) tekst = kop(m, a) + ' is klaar.\n\n' + (rr.regels.length ? rr.regels.join('\n') + '\n\n' : '') + 'Telling: ' + rr.telling;
    else tekst = kop(m, a) + ' is niet goed afgerond (' + String((r && r.error) || 'onverwacht slot' ).slice(0, 160) + '). Job ' + a.job_id + '; de machinekamer kijkt het na.';
    return bericht(m, a, tekst + '\n\n[Bekijk bij ' + (m.id === 'ciso' ? 'de CISO' : m.naam) + '](' + managerLink(m) + ')');   // wv4128 (3C136)
  }
  async function start(id, door, reden) {
    const m = PER_ID[String(id || '')];
    if (!m) return { status: 404, j: { ok: false, fout: 'onbekende manager' } };
    if (!DOOR[door]) return { status: 400, j: { ok: false, fout: 'onbekende aanroeper' } };
    // wv4128 (C64): op afroep alleen nog door de machinekamer
    if (door !== 'machinekamer') return { status: 403, j: { ok: false, fout: 'een ronde op afroep loopt alleen nog via de machinekamer; vraag daar "draai de ' + m.naam + '-ronde"' } };
    const rd = reden == null || reden === '' ? 'controle' : String(reden);
    if (!REDENEN[rd]) return { status: 400, j: { ok: false, fout: 'reden is een van: ' + Object.keys(REDENEN).join(', ') } };
    const k = kan(m, door);
    if (!k.ok) return { status: k.status, j: { ok: false, fout: k.fout, weer_om: k.weer_om ? new Date(k.weer_om).toISOString() : undefined } };
    bezig[m.id] = true;
    try {
      let v;
      if (m.soort === 'script') v = { mag: true };   // geen taalmodel, dus geen weekquotum
      else try { v = await o.vangnet(); } catch (e) { v = { mag: false, reden: 'quotum niet te meten' }; }
      if (!v || !v.mag) return { status: 429, j: { ok: false, fout: 'geen ruimte in het weekquotum (' + String(v && v.reden || 'onbekend') + '); de weekronde draait wel' } };
      // Fable diffreview #5/#7: na de wachtmomenten opnieuw toetsen; vanaf hier geen await meer tot de afroep in staat.json staat
      const k2 = kan(m, door, true);
      if (!k2.ok) return { status: k2.status, j: { ok: false, fout: k2.fout, weer_om: k2.weer_om ? new Date(k2.weer_om).toISOString() : undefined } };
      const t = nu();
      if (m.soort === 'script' && typeof o.startScript !== 'function') return { status: 503, j: { ok: false, fout: m.naam + ' kan in deze versie niet op afroep' } };
      const run = m.soort === 'script' ? o.startScript(m, { door: door }) : o.startRun({ sessie: m.sessie, model: m.model, prompt: prompt(m, door, t) });
      if (m.soort === 'script') {
        scriptLoopt[m.id] = { job_id: run.job_id, created: t };
        Promise.resolve(run.klaar).then(function () { delete scriptLoopt[m.id]; }, function () { delete scriptLoopt[m.id]; });
      }
      const a = { id: m.id, t: t, door: door, reden: rd, job_id: run.job_id, uitkomst: null };
      const s = lees(); s.afroepen.push(a);
      try { schrijf(s); } catch (e) { o.fout('manager-staat', e); }
      Promise.resolve(run.klaar).then(function (r) { return naRun(m, a, r); }, function (e) { o.fout('manager-run', e); return naRun(m, a, { ok: false, error: 'pod-fout' }); });
      return { status: 202, j: { ok: true, manager: m.id, naam: m.naam, job_id: run.job_id, rapport: 'machinekamer' } };
    } finally { delete bezig[m.id]; }
  }
  // wv4128 (3C29): de zin van een gemiste ronde onthouden (uit het bericht van n8n) voor de kaart bij "te laat"
  function noteerGemist(tekst) {
    const g = gemistUitTekst(tekst);
    if (!g) return false;
    const s = lees();
    s.gemist = Object.assign({}, s.gemist || {});
    s.gemist[g.id] = { t: nu(), zin: g.zin };
    try { schrijf(s); } catch (e) { o.fout('manager-staat', e); return false; }
    return true;
  }
  // Na een herstart: afroepen zonder uitkomst zijn afgebroken (jobs leven alleen in het geheugen). David/Socev krijgen één regel.
  function opstart() {
    const s = lees();
    const open = s.afroepen.filter(function (a) { return a.uitkomst === null && !(PER_ID[a.id] && PER_ID[a.id].soort === 'script' ? [] : (o.jobsOpSessie((PER_ID[a.id] || {}).sessie || '') || [])).some(function (j) { return j.id === a.job_id; }); });
    if (!open.length) return 0;
    open.forEach(function (a) { a.uitkomst = 'afgebroken'; a.klaar = nu(); });
    try { schrijf(s); } catch (e) { o.fout('manager-staat', e); }
    if (o.rolPrimair()) open.forEach(function (a) {
      const m = PER_ID[a.id];
      if (m && a.door !== 'machinekamer' && nu() - a.t < 6 * UUR) bericht(m, a, kop(m, a) + ' is onderbroken doordat Socev opnieuw opstartte. Mogelijk loopt hij op de achtergrond nog af, maar dan komt er geen rapport; over een uur kun je hem opnieuw starten.');
    });
    return open.length;
  }
  // De kaarten voor de App. sb = uitkomst van mk_managers_stand (of null). Op elk apparaat alles (wv3446: vaste-plektak weg).
  function stand(sb) {
    const t = nu(), s = lees();
    return MANAGERS.map(function (m) {
      let d = sb && sb[m.id] ? sb[m.id] : null;
      (m.delen || []).forEach(function (id) { d = samenvoegen(d, sb && sb[id] ? sb[id] : null); });   // wv4116
      const h = d && d.hartslag ? d.hartslag : null;
      const mijn = s.afroepen.filter(function (a) { return a.id === m.id; });
      const la = mijn.length ? mijn[mijn.length - 1] : null;
      const lj = lopendJob(m);
      const laatsteGoed = mijn.filter(function (a) { return a.uitkomst === 'goed'; }).reduce(function (x, a) { return Math.max(x, a.klaar || a.t); }, 0);
      const hl = h && h.laatste_ronde ? Date.parse(h.laatste_ronde) : 0;
      let hst = 'onbekend';
      if (d) hst = !hl ? 'nog nooit' : (h.drempel_min && t - hl > h.drempel_min * 60000 ? 'te laat' : 'op tijd');
      // wv4128 (3C29): bij "te laat" één gewone zin: de onthouden zin als die na de laatst geplande ronde kwam, anders "niet vastgelegd"
      let gemist = null;
      if (hst === 'te laat') {
        const vr = vorigeWeekronde(m, t);
        const g = s.gemist && s.gemist[m.id];
        gemist = g && vr && g.t >= vr - 5 * 60000 ? g.zin : gemistZin(m, vr || t, 'onbekend', t);
      }
      let bev = null;
      if (d) {
        const punt = function (b) {
          const besluit = b.besluit && typeof b.besluit === 'object' ? { stand: String(b.besluit.stand || ''), op: b.besluit.op || null, klaar_op: b.besluit.klaar_op || null } : null;
          return { id: String(b.id || ''), ernst: String(b.ernst || ''), status: String(b.status || ''), samenvatting: String(b.samenvatting || ''),
            detail: String(b.detail || ''), sinds: b.eerst_gezien || null,
            // wv4123: groep en één gewone zin (uitleg uit de state, anders de vaste zin van een onderhoudscontrole, anders leeg = samenvatting)
            groep: b.groep ? String(b.groep) : null, uitleg: String(b.uitleg || (b.groep === 'onderhoud' && ONDERHOUD_ZIN[String(b.check || '')]) || ''), besluit: besluit };   // vaste zin alleen bij onderhoud (Codex MOET 2)
        };
        const top = (Array.isArray(d.top) ? d.top : []).map(punt);
        bev = { aantal: Number(d.aantal) || 0, per_ernst: d.per_ernst || {}, top: d.groepen ? perGroep(top, 5) : top.slice(0, 5), verborgen: false };
        if (d.groepen) {   // wv4123: alleen met de nieuwe RPC; een oude geeft geen groepen en de app valt terug op één getal
          const g = {};
          Object.keys(GROEPEN_LEEG).forEach(function (x) { g[x] = Number(d.groepen[x]) || 0; });
          bev.groepen = g;
          bev.totaal = Number(d.totaal) || 0;
          bev.besloten = (Array.isArray(d.besloten) ? d.besloten : []).map(punt).slice(0, 10);
        }
      }
      return { id: m.id, naam: m.naam, bewaakt: m.bewaakt, rooster: roosterTekst(m), soort: m.soort || 'sessie',
        volgende: (function () { const v = volgendeWeekronde(m, t); return v ? new Date(v).toISOString() : null; })(),
        weekronde: hl ? new Date(hl).toISOString() : null, hartslag: hst,
        laatste_ronde: (function () { const x = Math.max(hl, laatsteGoed); return x ? new Date(x).toISOString() : null; })(),
        lopend: lj ? { sinds: new Date(lj.created || t).toISOString(), afroep: !!(la && la.job_id === lj.id) } : null,
        laatste_afroep: la ? { t: new Date(la.t).toISOString(), door: la.door, uitkomst: la.uitkomst } : null,
        gemist: gemist, rapport: !!m.boxVan, link: managerLink(m),
        bevindingen: bev };
    });
  }
  function health() {
    return { aan: true, managers: MANAGERS.map(function (m) { return m.id; }), lopend: MANAGERS.filter(function (m) { return !!lopendJob(m); }).map(function (m) { return m.id; }) };
  }
  return { start: start, stand: stand, opstart: opstart, health: health, noteerGemist: noteerGemist, kan: function (id, door) { const m = PER_ID[id]; return m ? kan(m, door) : { status: 404, fout: 'onbekende manager' }; } };
}

// ── wv4135 (besluitenpagina nr 424 = 3C124, nr 373 = 3C73, David Ja 25-11-2026): Jouw besluiten en Dit mag ik zelf ──
// Jouw besluiten = Davids beantwoorde managerkaarten (machinekamer.voor_jou met herkomst.manager, wv3610) met één effectregel zodra
// gemeten (machinekamer.manager_besluit; RPC mk_managers_besluiten). Dit mag ik zelf = rijen afspraak-<manager>-<soort> in het
// toestemmingenregister (status aan), met de laatste regel uit afspraken-log.jsonl (mk-scripts/managers-besluiten/besluiten.py doe).
// Alleen lezen; Intrekken (server.js) zet de registerrij via toestemming.py op uit.
function besluitIds(id) {
  const m = PER_ID[id];
  if (!m) return [];
  return [m.id].concat(m.delen || []);
}
const ANTWOORDEN = ['Ja', 'Nee', 'Anders', 'Gedaan', 'Niet meer nodig', 'Beantwoord'];
function besluitVorm(r) {
  r = r && typeof r === 'object' ? r : {};
  const lijst = (Array.isArray(r.besluiten) ? r.besluiten : []).slice(0, 100).map(function (b) {
    return { datum: b.datum ? String(b.datum) : null, vraag: kort(String(b.vraag || ''), 200),
      antwoord: ANTWOORDEN.indexOf(String(b.antwoord)) >= 0 ? String(b.antwoord) : 'Beantwoord',
      effect: b.effect ? kort(String(b.effect), 300) : null, effect_op: b.effect_op ? String(b.effect_op) : null };
  });
  return { aantal: Number(r.aantal) || 0, besluiten: lijst };
}
const AFSPRAAK_RE = /^afspraak-([a-z]{2,20})-[a-z][a-z0-9-]{2,60}$/;
// reg = inhoud van toestemmingen.json (of null), log = regels uit afspraken-log.jsonl (strings), id = manager-id
function afspraken(reg, log, id) {
  const ids = besluitIds(id);
  if (!ids.length || !reg || !Array.isArray(reg.rijen)) return [];
  const laatst = {};
  (log || []).forEach(function (l) {
    let x; try { x = JSON.parse(l); } catch (e) { return; }
    if (x && typeof x.rij === 'string' && typeof x.regel === 'string') laatst[x.rij] = { t: String(x.t || ''), regel: kort(x.regel, 200) };
  });
  return reg.rijen.filter(function (r) {
    const m = r && AFSPRAAK_RE.exec(String(r.id || ''));
    return m && ids.indexOf(m[1]) >= 0 && r.manager === m[1] && r.status === 'aan';
  }).map(function (r) {
    const bron = Array.isArray(r.bron) && r.bron.length ? r.bron[r.bron.length - 1] : {};
    return { id: String(r.id), tekst: kort(Array.isArray(r.tekst) ? r.tekst.join(' ') : String(r.tekst || ''), 600),
      sinds: bron && bron.datum ? String(bron.datum) : null, laatst: laatst[r.id] || null };
  });
}
// ── wv4204 (besluitenpagina nr 476 = 3C176, David Ja 25-11-2026): "Deze week van je managers" ──
// Per manager hooguit twee regels: (1) wat er de laatste zeven dagen veranderde en wat vanzelf oploste, (2) wat nu bij David ligt
// (de nieuwste open Voor jou-kaart van die manager, met de knop in de app) of wat hij deze week besliste. Er wordt niets gestuurd.
// wk = uitvoer van de RPC mk_managers_week (per id, ook de delen zoals 'ui'), k = de kaart uit stand(). Geen wk = null (oude databank).
const WEEK_DAGEN = 7;
function weekSom(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const n = function (x, y) { return (Number(x) || 0) + (Number(y) || 0); };
  const lb = [a.laatst_besloten, b.laatst_besloten].filter(Boolean).sort(function (x, y) { return String(y.op || '').localeCompare(String(x.op || '')); })[0] || null;
  return { nieuw: n(a.nieuw, b.nieuw), nieuw_onderhoud: n(a.nieuw_onderhoud, b.nieuw_onderhoud), vanzelf: n(a.vanzelf, b.vanzelf),
    vanzelf_onderhoud: n(a.vanzelf_onderhoud, b.vanzelf_onderhoud), open_kaarten: n(a.open_kaarten, b.open_kaarten),
    // Codex MOET 1: nieuwste kaart eerst over beide delen heen (de knop belooft de nieuwste open vraag)
    kaarten: (Array.isArray(a.kaarten) ? a.kaarten : []).concat(Array.isArray(b.kaarten) ? b.kaarten : [])
      .sort(function (x, y) { return String((y && y.aangemaakt) || '').localeCompare(String((x && x.aangemaakt) || '')); }),
    besloten: n(a.besloten, b.besloten), laatst_besloten: lb };
}
function punten(n) { return n === 1 ? '1 nieuw punt' : n + ' nieuwe punten'; }
function weekRegels(k, wk, t) {
  const m = k && PER_ID[k.id];
  if (!m || !wk || typeof wk !== 'object') return null;
  let w = wk[m.id] || null;
  (m.delen || []).forEach(function (id) { w = weekSom(w, wk[id] || null); });
  w = w || {};
  const num = function (x) { return Math.max(0, Number(x) || 0); };
  const nieuw = num(w.nieuw), nOnd = Math.min(nieuw, num(w.nieuw_onderhoud)), vanzelf = num(w.vanzelf);
  // regel 1: wat veranderde (en wat vanzelf oploste)
  let r1;
  const ronde = k.weekronde ? Date.parse(k.weekronde) : 0;
  const binnen = ronde && t - ronde <= WEEK_DAGEN * DAG;
  if (k.hartslag === 'te laat' && k.gemist && !k.lopend) r1 = k.gemist;
  else if (!binnen && !nieuw && !vanzelf) {
    const v = k.volgende ? Date.parse(k.volgende) : 0;
    r1 = k.hartslag === 'nog nooit' ? 'Nog geen ronde gedraaid' + (v ? '; de eerste is ' + dagDatum(v) + '.' : '.') :
      'Deze week geen ronde' + (v ? '; de volgende is ' + dagDatum(v) + '.' : '.');
  } else {
    const stuk = [];
    if (nieuw) stuk.push(punten(nieuw) + (nOnd ? (nOnd === nieuw ? ', alle onderhoud' : ', waarvan ' + nOnd + ' onderhoud') : ''));
    if (vanzelf) stuk.push(vanzelf + ' vanzelf opgelost');
    const wanneer = m.soort === 'script' ? 'Elke nacht gedraaid' : (binnen ? 'Ronde ' + dagDatum(ronde) : 'Geen ronde deze week');
    r1 = wanneer + ': ' + (stuk.length ? stuk.join('; ') : 'niets veranderd') + '.';
  }
  // regel 2: wat bij David ligt (knop in de app) of wat hij deze week besliste
  const kaarten = (Array.isArray(w.kaarten) ? w.kaarten : []).filter(function (x) { return x && Number.isInteger(Number(x.id)) && Number(x.id) > 0; })
    .map(function (x) { return { id: Number(x.id), titel: kort(String(x.titel || ''), 140) }; }).slice(0, 3);
  const open = Math.max(num(w.open_kaarten), kaarten.length);
  let r2;
  if (open && kaarten.length) r2 = 'Wacht op jou: ' + kaarten[0].titel + (open > 1 ? ' (en nog ' + (open - 1) + ')' : '');
  else if (num(w.besloten) && w.laatst_besloten) {
    const lb = w.laatst_besloten;
    r2 = 'Jij besliste ' + (num(w.besloten) === 1 ? 'deze week: ' : 'deze week ' + num(w.besloten) + ' vragen, laatst: ') + kort(String(lb.titel || ''), 140) +
      (lb.antwoord && lb.antwoord !== 'Beantwoord' ? ' (' + lb.antwoord + ')' : '') + '.';
  } else r2 = 'Niets bij jou.';
  return { regels: [r1, r2], kaarten: open && kaarten.length ? kaarten.slice(0, 1) : [], bij_jou: open && kaarten.length ? open : 0 };
}

// Wat de RPC mk_managers_stand per manager nodig heeft (geen vrije invoer: alleen deze vaste lijst).
function rpcInvoer() {
  return MANAGERS.concat(DELEN).filter(function (m) { return m.patroon; }).map(function (m) {
    const r = { id: m.id, hartslag: m.hartslag, patroon: m.patroon };
    if (m.onderhoud) r.onderhoud = m.onderhoud.slice();   // wv4123: checks die per ontwerp doorlopen (groep onderhoud)
    return r;
  });
}

module.exports = { maak: maak, MANAGERS: MANAGERS, DELEN: DELEN, samenvoegen: samenvoegen, ONDERHOUD_ZIN: ONDERHOUD_ZIN, REDENEN: REDENEN, prompt: prompt, rapportRegels: rapportRegels, kort: kort, volgendeWeekronde: volgendeWeekronde,
  vorigeWeekronde: vorigeWeekronde, gemistZin: gemistZin, gemistUitTekst: gemistUitTekst, rapporten: rapporten, managerLink: managerLink, GEMIST_REDEN: GEMIST_REDEN,
  amsNaarMs: amsNaarMs, rpcInvoer: rpcInvoer, VOOR_WEEKRONDE_MS: VOOR_WEEKRONDE_MS, besluitIds: besluitIds, besluitVorm: besluitVorm, afspraken: afspraken, AFSPRAAK_RE: AFSPRAAK_RE, weekRegels: weekRegels, WEEK_DAGEN: WEEK_DAGEN };
