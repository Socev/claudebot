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
// Logica hier, de koppeling (routes, jobs, bericht, RPC) in server.js. Geen netwerk, geen sleutels in dit bestand.
const fs = require('fs');
const path = require('path');

const UUR = 3600000, DAG = 24 * UUR, KNOP_MS = 15 * 60000;
const VOOR_WEEKRONDE_MS = 90 * 60000;
const PER_MANAGER_24U = 3, TOTAAL_24U = 6;
const REDENEN = { 'david-vroeg': 'David vroeg erom', 'na-bouwstap': 'na een bouwstap', controle: 'controle' };
const DOOR = { david: 'door jou', socev: 'door Socev', machinekamer: 'door de machinekamer' };

// Het register (de naam-whitelist). Een nieuwe manager = één regel hier (+ test/managers.sh). rooster: dag 0 = zondag, tijd Europe/Amsterdam (de n8n-trigger).
const MANAGERS = [
  { id: 'data', naam: 'Data Manager', skill: 'data-manager', sessie: 'data-manager', model: 'claude-sonnet-5-5', hartslag: 'data_manager', patroon: '^DM[0-9]',
    bewaakt: 'Waar al je gegevens staan (databanken, pod, Drive, vault) en of elke plek een backup en een eigenaar heeft.',
    rooster: { dag: 0, uur: 9, min: 30 }, slot: 'DATA-MANAGER', slotRe: /^DATA-MANAGER \d{4}-\d{2}-\d{2}: [1-9]\d* bronnen gemeten/,
    slotFormaat: 'DATA-MANAGER <JJJJ-MM-DD>: <n> bronnen gemeten, <m> niet vast te stellen, <N> open (<k> nieuw), kaart geen' },
  { id: 'design', naam: 'Design Manager', skill: 'design-manager', sessie: 'design-manager', model: 'claude-sonnet-5-5', hartslag: 'design_manager', patroon: '^DS[0-9]',
    bewaakt: 'Of alle apps één vormgeving houden (Socev-blauw en de bouwdoos) en of de indeling logisch is.',
    rooster: { dag: 6, uur: 10, min: 0 }, slot: 'DESIGN-MANAGER', slotRe: /^DESIGN-MANAGER \d{4}-\d{2}-\d{2}: \d+ checks/,
    slotFormaat: 'DESIGN-MANAGER <JJJJ-MM-DD>: <n> checks, <m> niet vast te stellen, <N> open (<k> nieuw), kaart geen, wv geen' },
  // wv896 UI Manager (vr 10:00, Sonnet): meet gebruik (wat David doet en waar hij vastloopt), niet de vorm (dat is Design).
  { id: 'ui', naam: 'UI Manager', skill: 'ui-manager', sessie: 'ui-manager', model: 'claude-sonnet-5-5', hartslag: 'ui_manager', patroon: '^UI[0-9]',
    bewaakt: 'Hoe je de app echt gebruikt: wat je opent, waar je vastloopt of iets zoekt, wat traag is of niets doet.',
    rooster: { dag: 5, uur: 10, min: 0 }, slot: 'UI-MANAGER', slotRe: /^UI-MANAGER \d{4}-\d{2}-\d{2}: \d+ checks/,
    slotFormaat: 'UI-MANAGER <JJJJ-MM-DD>: <n> checks, <m> niet vast te stellen, <N> open (<k> nieuw), voorstellen <v>, kaart geen, wv geen' },
  { id: 'ciso', naam: 'CISO', skill: 'ciso', sessie: 'ciso', model: 'claude-opus-5-5', hartslag: 'ciso', patroon: '^C[0-9]',
    bewaakt: 'De beveiliging: sleutels, toegang, versies en wat er van buitenaf bereikbaar is.',
    rooster: { dag: 1, uur: 6, min: 0 }, slot: 'CISO', slotRe: /^CISO \d{4}-\d{2}-\d{2}: \d+ checks/,
    slotFormaat: 'CISO <JJJJ-MM-DD>: <n> checks, <m> niet vast te stellen, <N> open (<k> nieuw), bundel <id of geen>' },
  // wv979 Bibliothecaris (OVIS): geen sessie maar een script (ovis-run.js bibliothecaris, geen taalmodel), elke nacht 02:30 via de
  // pod-tijdklok in server.js. Op afroep: geen quotumtoets (geen model), wel dezelfde grenzen; geen hartslagstempel en geen box-rij.
  { id: 'bibliothecaris', naam: 'Bibliothecaris', soort: 'script', model: 'geen', hartslag: 'bibliothecaris', patroon: '^BB[0-9]',
    bewaakt: 'Of je Second Brain en de databank hetzelfde zeggen over elke entiteit (stamgegevens, herkenningskenmerken, contactgegevens).',
    rooster: { dagelijks: true, uur: 2, min: 30 }, voorMs: 30 * 60000 },
];
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
// eerstvolgende weekronde ná t (of precies op t)
function volgendeWeekronde(m, t) {
  const x = amsDelen(t);
  for (let i = 0; i <= 7; i++) {
    const dag = new Date(Date.UTC(x.j, x.m - 1, x.d + i));
    if (!m.rooster.dagelijks && dag.getUTCDay() !== m.rooster.dag) continue;
    const ms = amsNaarMs(dag.getUTCFullYear(), dag.getUTCMonth() + 1, dag.getUTCDate(), m.rooster.uur, m.rooster.min);
    if (ms >= t) return ms;
  }
  return null;
}
const DAGNAMEN = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
// De vaste vraagzin voor Socev (skills § Op afroep); alleen een Ja op precies deze zin geeft een ronde vrij (Fable diffreview #3).
function vraagZin(m) { return 'Zal ik de ' + m.naam + ' nu een ronde laten draaien?'; }
function roosterTekst(m) { return (m.rooster.dagelijks ? 'elke nacht' : 'elke ' + DAGNAMEN[m.rooster.dag]) + ' ' + String(m.rooster.uur).padStart(2, '0') + ':' + String(m.rooster.min).padStart(2, '0'); }

// ── de prompt (vast; alleen naam en wie) ──
function prompt(m, door, nu) {
  const wie = door === 'david' ? 'gestart door David in de app' : door === 'socev' ? 'gestart door Socev' : 'gestart door de machinekamer';
  return '[MACHINEKAMER - ' + m.naam.toUpperCase() + ' - OP AFROEP] Dit is een ronde op afroep (' + wie + '), buiten de vaste weekronde (' + roosterTekst(m) +
    '); geen vraag van David om te beantwoorden. Je bent hier de machinekamer, niet Socev: niets naar het hoofdkanaal. DATUM = ' + amsDatum(nu) +
    ' (gebruik deze, niet de podklok). Voer de skill `' + m.skill + '` volledig uit (.claude/skills/' + m.skill + '/SKILL.md), met de regels van de sectie "Op afroep" ' +
    'in die skill: zet bij deze ronde GEEN Voor jou-kaart, GEEN bundel, GEEN rij in Open vragen aan David en GEEN werkvoorraadrij (uitzondering: een kritiek ' +
    'beveiligingslek zoals de skill beschrijft), en GEEN hartslagstempel. Wat David moet beslissen of weten, zet je in je slotregels. ' +
    'Je laatste antwoord is: hooguit drie korte regels in gewone taal voor David (wat je vond, wat nieuw is sinds de vorige ronde, wat er bij hem of de ' +
    'machinekamer ligt; geen paden, geen ids, geen sleutels, geen markdown), en daarna als allerlaatste regel exact in dit formaat, zonder iets erna: ' + m.slotFormaat;
}

// Een regel die op een sleutel lijkt, gaat niet mee in het rapport (de skills controleren zelf ook; dit is de vangrail).
const SLEUTEL_RE = /(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|\b[0-9a-f]{40,}\b|\b[A-Za-z0-9+/]{48,}={0,2})/;
function rapportRegels(output, m) {
  const regels = String(output || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  const laatste = regels.length ? regels[regels.length - 1] : '';
  const goed = m.slotRe.test(laatste);
  const voor = (goed ? regels.slice(0, -1) : regels).slice(-3).map(function (s) {
    s = s.replace(/^[-*•]\s+/, '').replace(/\*\*|__|`/g, '').slice(0, 300);
    return SLEUTEL_RE.test(s) ? '(regel weggelaten: leek op een sleutel)' : s;
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
    const rr = m.soort === 'script' ? { goed: !!(r && r.ok), regels: r && r.zin ? [String(r.zin).slice(0, 300)] : [], telling: r ? (Number(r.open) || 0) + ' open (' + (Number(r.nieuw) || 0) + ' nieuw)' : '' } : rapportRegels(r && r.output, m);
    const goed = !!r && r.ok !== false && rr.goed;
    if (x) { x.uitkomst = goed ? 'goed' : 'fout'; x.klaar = nu(); try { schrijf(s); } catch (e) { o.fout('manager-staat', e); } }
    let tekst;
    if (goed) tekst = kop(m, a) + ' is klaar.\n\n' + (rr.regels.length ? rr.regels.join('\n') + '\n\n' : '') + 'Telling: ' + rr.telling;
    else tekst = kop(m, a) + ' is niet goed afgerond (' + String((r && r.error) || 'onverwacht slot' ).slice(0, 160) + '). Job ' + a.job_id + '; de machinekamer kijkt het na.';
    return bericht(m, a, tekst);
  }
  // Socev: Davids Ja (app-knop, hoofdkanaal) op precies de vaste vraagzin; ≤ 15 min; niet eerder gebruikt (de pod kiest de nieuwste
  // ongebruikte Ja met dat vraag-id: dezelfde zin op een andere dag heeft hetzelfde id).
  async function davidZeiJa(m, vraagId) {
    if (!/^[a-f0-9]{8}$/.test(String(vraagId || ''))) return 'Socev start een manager alleen na Davids Ja: zet eerst de vraag (VRAAG AAN DAVID: Zal ik de ' + m.naam + ' nu een ronde laten draaien?) en geef daarna het vraag-id van zijn Ja mee';
    let b;
    try { b = await o.knopJa(String(vraagId), lees().gebruikt || []); } catch (e) { b = { ok: false, fout: 'vragenregister onleesbaar' }; }
    if (!b || !b.ok) return (b && b.fout) || 'geen Ja van David gevonden';
    if (!(nu() - b.t <= KNOP_MS)) return 'Davids Ja is ouder dan 15 minuten; vraag het opnieuw';
    if (String(b.tekst || '').trim().toLowerCase() !== vraagZin(m).toLowerCase()) return 'Davids Ja hoort bij een andere vraag; de vraag moet precies zijn: VRAAG AAN DAVID: ' + vraagZin(m);
    if ((lees().gebruikt || []).indexOf(b.sleutel) >= 0) return 'die Ja is al gebruikt voor een ronde';
    return { sleutel: b.sleutel };
  }
  async function start(id, door, reden, vraagId) {
    const m = PER_ID[String(id || '')];
    if (!m) return { status: 404, j: { ok: false, fout: 'onbekende manager' } };
    if (!DOOR[door]) return { status: 400, j: { ok: false, fout: 'onbekende aanroeper' } };
    const rd = reden == null || reden === '' ? (door === 'david' ? 'david-vroeg' : 'controle') : String(reden);
    if (!REDENEN[rd]) return { status: 400, j: { ok: false, fout: 'reden is een van: ' + Object.keys(REDENEN).join(', ') } };
    const k = kan(m, door);
    if (!k.ok) return { status: k.status, j: { ok: false, fout: k.fout, weer_om: k.weer_om ? new Date(k.weer_om).toISOString() : undefined } };
    bezig[m.id] = true;
    try {
      let ja = null;
      if (door === 'socev') {
        ja = await davidZeiJa(m, vraagId);
        if (typeof ja === 'string') return { status: 403, j: { ok: false, fout: ja } };
      }
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
      if (ja) s.gebruikt = (s.gebruikt || []).concat([ja.sleutel]).slice(-100);
      try { schrijf(s); } catch (e) { o.fout('manager-staat', e); }
      Promise.resolve(run.klaar).then(function (r) { return naRun(m, a, r); }, function (e) { o.fout('manager-run', e); return naRun(m, a, { ok: false, error: 'pod-fout' }); });
      return { status: 202, j: { ok: true, manager: m.id, naam: m.naam, job_id: run.job_id, rapport: 'machinekamer' } };
    } finally { delete bezig[m.id]; }
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
  // De kaarten voor de App. sb = uitkomst van mk_managers_stand (of null), vast = vaste plek (geen detail; CISO alleen aantallen).
  function stand(sb, opt) {
    const t = nu(), vast = !!(opt && opt.vast), s = lees();
    return MANAGERS.map(function (m) {
      const d = sb && sb[m.id] ? sb[m.id] : null;
      const h = d && d.hartslag ? d.hartslag : null;
      const mijn = s.afroepen.filter(function (a) { return a.id === m.id; });
      const la = mijn.length ? mijn[mijn.length - 1] : null;
      const lj = lopendJob(m);
      const laatsteGoed = mijn.filter(function (a) { return a.uitkomst === 'goed'; }).reduce(function (x, a) { return Math.max(x, a.klaar || a.t); }, 0);
      const hl = h && h.laatste_ronde ? Date.parse(h.laatste_ronde) : 0;
      let hst = 'onbekend';
      if (d) hst = !hl ? 'nog nooit' : (h.drempel_min && t - hl > h.drempel_min * 60000 ? 'te laat' : 'op tijd');
      const k = lj ? { loopt: true } : kan(m, 'david');
      let bev = null;
      if (d) {
        const top = (Array.isArray(d.top) ? d.top : []).map(function (b) {
          return { id: String(b.id || ''), ernst: String(b.ernst || ''), status: String(b.status || ''), samenvatting: String(b.samenvatting || ''),
            detail: vast ? '' : String(b.detail || ''), sinds: b.eerst_gezien || null };
        });
        bev = { aantal: Number(d.aantal) || 0, per_ernst: d.per_ernst || {}, top: vast && m.id === 'ciso' ? [] : top.slice(0, 5), verborgen: vast };
      }
      return { id: m.id, naam: m.naam, bewaakt: m.bewaakt, rooster: roosterTekst(m), soort: m.soort || 'sessie',
        volgende: (function () { const v = volgendeWeekronde(m, t); return v ? new Date(v).toISOString() : null; })(),
        weekronde: hl ? new Date(hl).toISOString() : null, hartslag: hst,
        laatste_ronde: (function () { const x = Math.max(hl, laatsteGoed); return x ? new Date(x).toISOString() : null; })(),
        lopend: lj ? { sinds: new Date(lj.created || t).toISOString(), afroep: !!(la && la.job_id === lj.id) } : null,
        laatste_afroep: la ? { t: new Date(la.t).toISOString(), door: la.door, uitkomst: la.uitkomst } : null,
        kan: !!k.ok, waarom_niet: k.ok ? null : (k.loopt ? 'loopt nu' : k.fout), weer_om: k.weer_om ? new Date(k.weer_om).toISOString() : null,
        bevindingen: bev };
    });
  }
  function health() {
    return { aan: true, managers: MANAGERS.map(function (m) { return m.id; }), lopend: MANAGERS.filter(function (m) { return !!lopendJob(m); }).map(function (m) { return m.id; }) };
  }
  return { start: start, stand: stand, opstart: opstart, health: health, kan: function (id, door) { const m = PER_ID[id]; return m ? kan(m, door) : { status: 404, fout: 'onbekende manager' }; } };
}

// Wat de RPC mk_managers_stand per manager nodig heeft (geen vrije invoer: alleen deze vaste lijst).
function rpcInvoer() { return MANAGERS.map(function (m) { return { id: m.id, hartslag: m.hartslag, patroon: m.patroon }; }); }

module.exports = { maak: maak, MANAGERS: MANAGERS, vraagZin: vraagZin, REDENEN: REDENEN, prompt: prompt, rapportRegels: rapportRegels, volgendeWeekronde: volgendeWeekronde,
  amsNaarMs: amsNaarMs, rpcInvoer: rpcInvoer, VOOR_WEEKRONDE_MS: VOOR_WEEKRONDE_MS };
