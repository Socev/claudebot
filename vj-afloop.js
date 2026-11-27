'use strict';
// wv4232 (besluitenpagina nr 948 = L48, David Ja 25-11-2026 22:18): de afloop terug op de kaart. Na een Ja/Nee/Anders op een Voor jou-kaart
// staat onder "Afgehandeld" één regel met wat er daarna gebeurde ("Gedaan: …", "Loopt nog", "Mislukt: …"), met een tik naar het
// resultaat in het gesprek. Puur (geen io): server.js geeft de kaart, de werkvoorraadrijen uit mk_werkvoorraad_stand, de job van de
// knopbeurt (vragen.json), een opzoeker in het app-log en de stand van lopende jobs mee. Getoetst in test/vj-afloop.test.js.
//
// Koppeling (bestond al): kaart.herkomst.wv = de klus die op David wachtte; de knopdruk staat in vragen.json met antwoord.job = de beurt
// die Davids antwoord verwerkte. Uitkomst:
//   - de knopbeurt loopt nog                      → Socev is ermee bezig
//   - rij gestart                                 → Loopt nog
//   - rij open                                    → Staat in de rij
//   - rij geblokkeerd op David                    → Wacht weer op jou
//   - rij klaar: rapport van de klus (job_id) → Gedaan: <uitkomstzin>; rij zonder klus (de knopbeurt deed het zelf) → Gedaan: <zin uit
//     het knopantwoord>; klus zonder vindbaar rapport → alleen "Gedaan" (het knopantwoord zegt dan alleen dat het Ja binnen is)
//   - rij mislukt/afgebroken, of het rapport/antwoord met ok false → Mislukt: <uitkomstzin>
//   - rij vervallen                               → Niet doorgegaan
//   - geen rij: het antwoord van de knopbeurt als "Reactie: …" (geen bewijs dat iets gedaan is), Mislukt bij ok false, of niets
// Meer klussen aan één kaart: de stand die het meest zegt (bezig > loopt > rij > wacht > mislukt > gedaan > niet). Een kaart die David op
// "Niet meer nodig" zette, krijgt geen afloop. Te lezen laat alleen het bericht weg waar een getoonde regel naartoe tikt (server.js).

const ZIN_MAX = 110;
const JOB_RE = /^[0-9a-f]{16}$/;

function kort(t, n) {
  const a = Array.from(String(t || '').replace(/\s+/g, ' ').trim());
  return a.length > n ? a.slice(0, n - 1).join('').trimEnd() + '…' : a.join('');
}
// "Gedaan: Gedaan, het staat erin" → geen dubbel woord; alleen de eerste zin (als die niet te kort is), hooguit ZIN_MAX tekens
function metKop(kop, zin) {
  let z = String(zin || '').replace(/\s+/g, ' ').trim().replace(/^(gedaan|klaar|mislukt|uitkomst)\s*[:.,—–-]\s*/i, '');
  const eerste = /^(.+?[.!?])(\s|$)/.exec(z);
  if (eerste && eerste[1].length >= 20) z = eerste[1];
  z = kort(z, ZIN_MAX);
  return z ? kop + ': ' + z : kop;
}
function rijenVan(p, rijen) {
  const h = p && p.herkomst && typeof p.herkomst === 'object' ? p.herkomst : {};
  const ids = (Array.isArray(h.wv) ? h.wv : h.wv != null ? [h.wv] : []).map(Number).filter(Number.isInteger);
  const per = {};
  (rijen || []).forEach(function (r) { if (r && Number.isInteger(Number(r.id))) per[Number(r.id)] = r; });
  return ids.map(function (i) { return per[i]; }).filter(Boolean);
}
// Het bericht bij een job: {kanaal, job_id, ok, zin} of null. o.log(job) geeft het app-log-item; o.zin(tekst) de uitkomstzin.
// klus = true: job is de agentrun van een werkvoorraadrij (het rapport staat in het log onder agent_job, met een eigen job_id).
function bericht(job, o, klus) {
  if (!JOB_RE.test(String(job || '')) || typeof o.log !== 'function') return null;
  const x = o.log(job, !!klus);
  if (!x || !JOB_RE.test(String(x.job_id || ''))) return null;
  let zin = null;
  try { zin = typeof o.zin === 'function' ? o.zin(String(x.antwoord || '')) : null; } catch (e) { zin = null; }
  return { kanaal: x.kanaal, job_id: x.job_id, ok: x.ok !== false, zin: zin || null, t: x.t || null };
}
function lopend(job, o) {
  const s = JOB_RE.test(String(job || '')) && typeof o.jobStatus === 'function' ? o.jobStatus(job) : null;
  return s === 'pending' || s === 'running';
}
function klaarUit(b, t) {
  if (!b) return { stand: 'gedaan', tekst: 'Gedaan', kanaal: null, job_id: null, t: t || null };
  return { stand: b.ok ? 'gedaan' : 'mislukt', tekst: metKop(b.ok ? 'Gedaan' : 'Mislukt', b.zin), kanaal: b.kanaal, job_id: b.job_id, t: b.t || t || null };
}

// p = de kaart (status gedaan na een knopdruk), o = { rijen, knopJob, log(job, klus) → app-log-item met kanaal, zin(tekst), jobStatus(job) }.
// Antwoord: { stand: bezig|loopt|rij|wacht|gedaan|mislukt|niet|reactie, tekst, kanaal, job_id, t, open } of null.
function afloop(p, o) {
  const x = afloopKaal(p, o || {});
  // een doe-kaart die je zelf op Gedaan zette: een kale "Gedaan" zonder bericht zegt niets nieuws
  if (x && p.soort !== 'besluit' && x.stand === 'gedaan' && !x.job_id && x.tekst === 'Gedaan') return null;
  return x;
}
function afloopKaal(p, o) {
  if (!p || p.status !== 'gedaan') return null;
  const knopJob = JOB_RE.test(String(o.knopJob || '')) ? o.knopJob : null;
  if (knopJob && lopend(knopJob, o)) return zonder({ stand: 'bezig', tekst: 'Socev is ermee bezig', open: true });
  const knopB = knopJob ? bericht(knopJob, o) : null;
  const rijen = rijenVan(p, o.rijen);
  if (rijen.length) {
    // Codex-review wv4232 MOET 3: meer klussen aan één kaart = de stand die het meest zegt (loopt nog gaat vóór gedaan, mislukt vóór gedaan)
    const per = rijen.map(function (r) { return afloopRij(r, knopB, o); }).filter(Boolean);
    per.sort(function (x, y) { return RANG[x.stand] - RANG[y.stand]; });
    return per[0] || null;
  }
  if (knopB) return knopB.ok ? { stand: 'reactie', tekst: metKop('Reactie', knopB.zin), kanaal: knopB.kanaal, job_id: knopB.job_id, t: knopB.t || null, open: false }
    : Object.assign(klaarUit(knopB, null), { open: false });
  return null;
}
const RANG = { bezig: 0, loopt: 1, rij: 2, wacht: 3, mislukt: 4, gedaan: 5, reactie: 6, niet: 7 };
function zonder(x) { return Object.assign({ kanaal: null, job_id: null, t: null }, x); }
function afloopRij(r, knopB, o) {
  const st = String(r.status || '');
  if (st === 'gestart') return zonder({ stand: 'loopt', tekst: 'Loopt nog', open: true });
  if (st === 'open') return zonder({ stand: 'rij', tekst: 'Staat in de rij', open: true });
  if (st === 'geblokkeerd') return /^\s*david/i.test(String(r.geblokkeerd_door || ''))
    ? Object.assign(zonder({ stand: 'wacht', tekst: 'Wacht weer op jou', open: true }), knopB ? { kanaal: knopB.kanaal, job_id: knopB.job_id } : {})
    : zonder({ stand: 'rij', tekst: 'Staat in de rij', open: true });
  if (st === 'vervallen') return zonder({ stand: 'niet', tekst: 'Niet doorgegaan', open: false, t: r.klaar_op || null });
  const klusB = r.job_id ? bericht(r.job_id, o, true) : null;
  if (st === 'klaar') return Object.assign(klaarUit(r.job_id ? klusB : knopB, r.klaar_op), { open: false });
  if (st === 'mislukt' || st === 'afgebroken') {
    const b = klusB || knopB;
    return { stand: 'mislukt', tekst: metKop('Mislukt', b && b.zin), kanaal: b ? b.kanaal : null, job_id: b ? b.job_id : null, t: r.klaar_op || (b && b.t) || null, open: false };
  }
  return null;
}

module.exports = { afloop: afloop, ZIN_MAX: ZIN_MAX, metKop: metKop };
