'use strict';
// wv3484 (21-11-2026): alarm op een verlopen hartslag. De NZa-wachter startte van 15-11 tot 20-11 niet; de hartslag ovis-nza-wachter
// stond op te_laat, maar dat oordeel stond alleen op de Ringkaart. n8n "AI - Stiltewachter" meldt alleen componenten op zijn watchlist
// (Data Table stilte_state, kolom hartslag_component); de pod-dagrondes (ovis-*, sb2-*, ...) vielen erbuiten.
//
// Deze module is puur (geen schijf, geen netwerk): server.js meet elk kwartier mk_hartslag_stand en geeft de rijen hier door.
// Regels:
//   - alleen rijen met drempel_min > 0 (de RPC geeft alleen actieve rijen; drempel 0 = 'onbeoordeelbaar' en telt niet);
//   - componenten die de Stiltewachter al bewaakt (bewaken = ja en hartslag_component gezet) slaan we over: die melden al;
//   - van niet-gemeld naar te_laat: één melding (soort te_laat). Zolang hij te_laat blijft niets. Ook bij de eerste ronde zonder staat
//     (een rij die al te laat staat als de wacht begint, meldt één keer: precies wat in november vijf dagen ongezien bleef);
//   - gemeld en weer vers: één regel (soort hersteld); gemeld en de rij is weg, drempel 0 of nooit gestempeld: één regel (soort dicht);
//   - gemeld en nu door de Stiltewachter bewaakt: stil uit de staat (die meldt het verder);
//   - te_laat blijft te_laat, ook als laatste_ronde intussen verschoof (gestempeld en weer verlopen terwijl de pod uit stond): stil;
//   - meetfout (rijen geen lijst of leeg): niets, staat ongewijzigd. Een lege lijst is bij ± 60 actieve rijen een meetfout, geen
//     'alles dicht' (anders zou elke storing van de databank een regen van dicht-regels geven).
// Staat: { gemeld: { component: { op: ms, laatste_ronde: iso|null, drempel_min } } }. server.js bewaart hem in klokken/hartslag-alarm.json,
// zodat een herstart niet opnieuw meldt.

function geldig(r) { return r && typeof r.component === 'string' && r.component.length > 0; }

// rijen: uitkomst van mk_hartslag_stand; overslaan: Set of array met componenten van de Stiltewachter (of null = niets overslaan)
// → { staat, melden: [{ soort: 'te_laat'|'hersteld'|'dicht', component, regel, drempel_min, laatste_ronde }], gemeten: bool }
function stap(staat, rijen, overslaan, nu) {
  const oud = staat && typeof staat === 'object' && staat.gemeld && typeof staat.gemeld === 'object' ? staat.gemeld : {};
  const gemeld = {};
  Object.keys(oud).forEach(function (c) { gemeld[c] = Object.assign({}, oud[c]); });
  if (!Array.isArray(rijen) || !rijen.filter(geldig).length) return { staat: { gemeld: gemeld }, melden: [], gemeten: false };
  const sla = new Set(Array.isArray(overslaan) ? overslaan : (overslaan instanceof Set ? Array.from(overslaan) : []));
  const per = {};
  rijen.filter(geldig).forEach(function (r) { per[r.component] = r; });
  const melden = [], net = new Set();
  Object.keys(per).sort().forEach(function (c) {
    const r = per[c], d = Number(r.drempel_min) || 0;
    if (sla.has(c) || d <= 0 || r.oordeel !== 'te_laat' || gemeld[c]) return;
    gemeld[c] = { op: nu, laatste_ronde: r.laatste_ronde || null, drempel_min: d };
    net.add(c);
    melden.push({ soort: 'te_laat', component: c, regel: String(r.regel || c), drempel_min: d, laatste_ronde: r.laatste_ronde || null });
  });
  Object.keys(gemeld).sort().forEach(function (c) {
    if (net.has(c)) return;   // net gemeld in deze ronde
    const r = per[c];
    if (sla.has(c)) { delete gemeld[c]; return; }
    if (!r || !(Number(r.drempel_min) > 0) || r.oordeel === 'nooit' || r.oordeel === 'onbeoordeelbaar') {
      melden.push({ soort: 'dicht', component: c, regel: r ? String(r.regel || c) : c + ': rij niet meer actief', drempel_min: r ? Number(r.drempel_min) || 0 : null,
        laatste_ronde: r ? r.laatste_ronde || null : null });
      delete gemeld[c];
      return;
    }
    if (r.oordeel === 'vers') {
      melden.push({ soort: 'hersteld', component: c, regel: String(r.regel || c), drempel_min: Number(r.drempel_min), laatste_ronde: r.laatste_ronde || null });
      delete gemeld[c];
    }
  });
  return { staat: { gemeld: gemeld }, melden: melden, gemeten: true };
}

// Stiltewachter-watchlist (rijen van Data Table stilte_state) → componenten die hij bewaakt
function stilteComponenten(rijen) {
  if (!Array.isArray(rijen)) return null;
  const u = [];
  rijen.forEach(function (r) {
    if (!r || String(r.bewaken || '').toLowerCase() !== 'ja') return;
    const c = String(r.hartslag_component || '').trim();
    if (c && u.indexOf(c) < 0) u.push(c);
  });
  return u.sort();
}

function klok(ms) { return new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 16); }
function kort(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n); }

// melden → box-tekst (met witregel ervoor, zoals ovisBoxRij verwacht). te_laat = rij [direct] status open; herstel/dicht = rij [log]
// status afgehandeld met één regel per component. Beide kunnen in één ronde voorkomen: dan twee rijen achter elkaar.
function boxTekst(melden, nu) {
  const laat = melden.filter(function (m) { return m.soort === 'te_laat'; });
  const rest = melden.filter(function (m) { return m.soort !== 'te_laat'; });
  let t = '';
  if (laat.length) {
    t += '\n## [direct] ' + klok(nu) + ' — Hartslag te laat: ' + kort(laat.map(function (m) { return m.component; }).join(', '), 160) + ' (automatisch, wv3484) #hartslag-alarm\n' +
      '- status: open\n- van: pod server.js (hartslag-alarm.js; één rij per overgang naar te laat, geen herhaling zolang hij te laat blijft)\n' +
      '- gemeten: ' + laat.map(function (m) { return kort(m.regel, 220); }).join('; ') + '\n' +
      '- gevolg als er niets gebeurt: deze ronde draait niet (of stempelt niet) en niemand ziet het; de Stiltewachter bewaakt deze component niet.\n' +
      '- voorstel: kijk waarom de ronde niet startte (api.log, klokken/<naam>.json, n8n-runs) en repareer; een bewust gestopte ronde: actief = false in machinekamer.hartslag.\n';
  }
  if (rest.length) {
    t += '\n## [log] ' + klok(nu) + ' — Hartslag weer op tijd of dicht: ' + kort(rest.map(function (m) { return m.component; }).join(', '), 160) + ' (automatisch, wv3484) #hartslag-alarm\n' +
      '- status: afgehandeld\n- van: pod server.js (hartslag-alarm.js)\n' +
      rest.map(function (m) { return '- ' + (m.soort === 'hersteld' ? 'weer op tijd: ' : 'niet meer beoordeeld (rij dicht, drempel 0 of nooit gestempeld): ') + kort(m.regel, 220) + '\n'; }).join('');
  }
  return t;
}

module.exports = { stap: stap, stilteComponenten: stilteComponenten, boxTekst: boxTekst };
