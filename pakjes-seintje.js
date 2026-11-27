'use strict';
/*
 * wv4154 (besluitenpagina nr 158 = 2C58, David Ja 25-11-2026 22:13): Pakjes komt naar David toe. Per pakje hooguit twee seintjes:
 * "tijdvak" (komt vandaag tussen ... en ...) en "aankomst" (bezorgd, of ligt klaar bij het afhaalpunt). Alleen 07:00–21:59 (Amsterdam);
 * daarbuiten wacht het tot de eerste ronde na 07:00. Nooit dubbel: vastgelegd per pakje-id én samen_id (een samengevoegde rij kan een
 * ander id tonen). Puur: plan() krijgt pakjes.lijst().body, de staat en de tijd, en geeft de regels plus de nieuwe staat. De pod zet de
 * regels als één bericht in het hoofdgesprek (soort dag = met seintje). Codex MOET 1+3: de pod schrijft de nieuwe staat ALTIJD eerst weg
 * (lukt dat niet: niets versturen) en verstuurt daarna; mislukt het bericht, dan zet hij de oude staat terug (volgende ronde opnieuw).
 * Zo kan een pakje nooit twee keer hetzelfde seintje krijgen; in het ergste geval (terugzetten faalt ook) valt er één weg.
 * Staat: { versie: 1, begonnen: iso, pakjes: { id: { tijdvak?: iso, aankomst?: iso } } } — alleen id's en tijden, 30 dagen.
 */
const UUR = 3600000, DAG = 24 * UUR;
const BEZORGD_VERS = 12 * UUR;   // een bezorging van 22:30 komt om 07:00 nog mee
const BEWAAR = 30 * DAG;
const VAN_UUR = 7, TOT_UUR = 22;
const ID_RE = /^[0-9a-f]{12}$/;

function nlDag(ms) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
function nlUur(ms) { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms))); }
function nlHm(ms) { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)); }
function hm(x) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(x || '')); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? m[1].padStart(2, '0') + ':' + m[2] : null; }
function naam(p) {
  const t = String(p.winkel || p.omschrijving || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return t ? 'Pakje van ' + t : 'Pakje' + (p.vervoerder ? ' (' + String(p.vervoerder).slice(0, 30) + ')' : '');
}
const DETAIL = { buren: ' Bij de buren.', brievenbus: ' In de brievenbus.' };
function detailZin(d) {
  const s = String(d || '').toLowerCase();
  if (/buren/.test(s)) return DETAIL.buren;
  if (/brievenbus/.test(s)) return DETAIL.brievenbus;
  return '';
}
function leeg() { return { versie: 1, begonnen: null, pakjes: {} }; }
function normaal(staat) {
  const s = staat && typeof staat === 'object' && staat.pakjes && typeof staat.pakjes === 'object' ? staat : leeg();
  return { versie: 1, begonnen: typeof s.begonnen === 'string' ? s.begonnen : null, pakjes: Object.assign({}, s.pakjes) };
}
function idsVan(p) { return [p.id, p.samen_id].filter((x, i, a) => ID_RE.test(String(x || '')) && a.indexOf(x) === i); }
function al(s, ids, soort) { return ids.some((id) => s.pakjes[id] && s.pakjes[id][soort]); }

// Welke (pakje, soort) nu in aanmerking komen, los van de staat en het uur.
function kandidaten(body, nu) {
  const vandaag = nlDag(nu), nuHm = nlHm(nu), uit = [];
  const lopend = (body && Array.isArray(body.lopend) ? body.lopend : []).filter((p) => p && typeof p === 'object' && !p.verborgen);
  for (const p of lopend) {
    const ids = idsVan(p);
    if (!ids.length) continue;
    const van = hm(p.verwacht_van), tot = hm(p.verwacht_tot);
    if (p.stand === 'vandaag' && p.verwacht_dag === vandaag && van && tot && van < tot && tot > nuHm)   // Codex ZOU 1: van < tot
      uit.push({ id: ids[0], ids, soort: 'tijdvak', tekst: '📦 ' + naam(p) + ' komt vandaag tussen ' + van + ' en ' + tot + '.' });
    if (p.stand === 'bezorgd' && !p.handmatig) {
      const t = Date.parse(p.bezorgd_op || '');
      if (isFinite(t) && t <= nu + 5 * 60000 && nu - t <= BEZORGD_VERS)
        uit.push({ id: ids[0], ids, soort: 'aankomst', tekst: '📦 ' + naam(p) + ' is bezorgd.' + detailZin(p.stand_detail) });
    }
    if (p.stand === 'afhaalpunt')
      uit.push({ id: ids[0], ids, soort: 'aankomst', tekst: '📦 ' + naam(p) + ' ligt klaar bij het afhaalpunt.' });
  }
  return uit;
}

// plan({ body, staat, nu }) → { regels, staat, nulpunt, buiten_uren }
function plan(x) {
  const nu = Number(x && x.nu);
  if (!isFinite(nu)) throw new Error('geen tijd');
  const s = normaal(x && x.staat);
  // opruimen: ouder dan 30 dagen weg
  for (const id of Object.keys(s.pakjes)) {
    const r = s.pakjes[id] || {};
    const jongste = Math.max(Date.parse(r.tijdvak || '') || 0, Date.parse(r.aankomst || '') || 0);
    if (!ID_RE.test(id) || !(jongste > nu - BEWAAR)) delete s.pakjes[id];
  }
  const iso = new Date(nu).toISOString();
  const markeer = (c) => c.ids.forEach((id) => { s.pakjes[id] = Object.assign({}, s.pakjes[id], { [c.soort]: s.pakjes[id] && s.pakjes[id][c.soort] || iso }); });
  // Codex MOET 2: is een pakje onder één van zijn id's al gemeld, dan gaat die melding naar al zijn id's (nieuwe alias onthouden)
  const alle = kandidaten(x && x.body, nu);
  const k = [];
  for (const c of alle) { if (al(s, c.ids, c.soort)) markeer(c); else k.push(c); }
  // nulpunt: de eerste ronde ooit markeert wat er nu ligt zonder seintje (geen stoot bij de uitrol)
  if (!s.begonnen) { s.begonnen = iso; k.forEach(markeer); return { regels: [], staat: s, nulpunt: k.length }; }
  const uur = nlUur(nu);
  if (uur < VAN_UUR || uur >= TOT_UUR) return { regels: [], staat: s, buiten_uren: k.length };
  // binnen één ronde: één regel per (pakje, soort) over alle id's; tijdvak en aankomst samen = alleen aankomst (het ligt er al)
  const regels = [], gezien = new Set();
  const aan = new Set(k.filter((c) => c.soort === 'aankomst').flatMap((c) => c.ids));
  for (const c of k) {
    if (c.ids.some((id) => gezien.has(id + ':' + c.soort))) { markeer(c); continue; }
    c.ids.forEach((id) => gezien.add(id + ':' + c.soort));
    if (c.soort === 'tijdvak' && c.ids.some((id) => aan.has(id))) { markeer(c); continue; }
    regels.push(c); markeer(c);
  }
  return { regels, staat: s };
}
function tekst(regels) { return regels.map((r) => r.tekst).join('\n'); }
// sleutel voor berichtIntern: dezelfde (id, soort)-paren = dezelfde sleutel (24 u dubbel-vangnet van de berichtweg)
function sleutel(regels, hash) { return 'pakjes-seintje:' + hash(regels.map((r) => r.id + ':' + r.soort).sort().join(',')).slice(0, 24); }

module.exports = { plan, tekst, sleutel, kandidaten, leeg, BEZORGD_VERS };
