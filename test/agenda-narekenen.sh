#!/usr/bin/env bash
# Toets wv3704 (21-11-2026, besluit nr 361 = 3C61): agenda-narekenen.js, puur met verzonnen bronnen (geen echte agenda, geen Promedico).
#   Vijf proefmomenten: vrij, botsing, spreekuur open, op reis, Promedico niet gezien; plus reistijd krap, bron kapot = nooit "vrij",
#   eigen afspraak telt niet (event_id), hele dag, invoerfouten, zomertijd.
# Kruisproef: AN_MOD=<kopie die altijd kern 'vrij' geeft> bash test/agenda-narekenen.sh moet rood zijn.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
node - "$HIER" <<'EINDE'
'use strict';
const path = require('path');
const M = require(process.env.AN_MOD || path.join(process.argv[2], 'agenda-narekenen.js'));
const B = require(path.join(process.argv[2], 'promedico-betekenis.js'));
let ok = 0, fout = 0;
function toets(naam, waar, x) { if (waar) { ok++; console.log('ok   ' + naam); } else { fout++; console.log('FOUT ' + naam + ' ' + JSON.stringify(x)); } }
const NU = Date.UTC(2026, 10, 23, 7, 0);   // ma 23-11-2026 08:00 lokaal
const DAG = '2026-11-24';                  // di
const iso = (u) => DAG + 'T' + u + ':00+01:00';
const ev = (kal, titel, van, tot, loc, id) => ({ kalender: kal, event_id: id || titel, titel, start: iso(van), einde: iso(tot), hele_dag: false, status: 'confirmed', locatie: loc || '' });
const rooster = (ini) => ({ soort: 'dienst', feed: 'rooster-tg-artsen', titel: ini, begin_datum: DAG, eind_datum: DAG, hele_dag: true });
// Promedico-dag (verzonnen): gezien gisteren in de werkweek, consult-sjabloon 08:00–12:00, patiënt 09:00–09:15, blok "vergadering" 13:00–14:00
const gezien = NU - 3600000;
const pm = { gezien_ms: gezien, weergave: 'werkweek', dag: { blokken: [{ van: '09:00', tot: '09:15', soort: 'consult', patient: true, kleur: null }],
  sjabloon: [{ van: '08:00', tot: '12:00', soort: 'consult', kleur: null }] } };
function r(start, eind, bron, extra) {
  const v = M.leesVerzoek(Object.assign({ start, eind }, extra || {}));
  if (v.fout) return { fout: v.fout };
  return M.reken(v, Object.assign({ events: [], tijdlijn: [rooster('DS'), rooster('AL')], promedico: { x: pm }, nuMs: NU, B }, bron || {}));
}
let x;
// 1 vrij: middag, geen overlap, Promedico gezien en buiten spreekuur
x = r(DAG + 'T15:00', DAG + 'T16:00'); toets('vrij: 15:00 werkdag, buiten spreekuur', x.kern === 'vrij' && /werkdag Tolgaarde/.test(x.regel) && /buiten spreekuur/.test(x.regel), x);
// 2 botsing
x = r(DAG + 'T15:00', DAG + 'T16:00', { events: [ev('David', 'Tandarts', '15:30', '16:00')] }); toets('botsing met eigen afspraak', /^botsing met "Tandarts" \(je agenda 15:30–16:00\)/.test(x.kern), x);
x = r(DAG + 'T19:00', DAG + 'T20:00', { events: [ev('HAGRO', 'ALV', '19:30', '21:00')] }); toets('botsing HAGRO met kanttekening', /HAGRO-agenda, gaat David erheen/.test(x.kern), x);
x = r(DAG + 'T15:00', DAG + 'T16:00', { events: [ev('David', 'Tandarts', '15:00', '16:00', '', 'abc123')] }, { event_id: 'abc123' }); toets('verplaatsen: eigen afspraak telt niet', x.kern === 'vrij', x);
// 3 spreekuur open / patiënt
x = r(DAG + 'T10:00', DAG + 'T10:30'); toets('spreekuur open 10:00', /^werkdag-spreekuur: spreekuur open 10:00–10:30/.test(x.kern), x);
x = r(DAG + 'T09:00', DAG + 'T09:30'); toets('patiënt geboekt 09:00', /patiënt geboekt/.test(x.kern), x);
// 4 op reis
x = r(DAG + 'T15:00', DAG + 'T16:00', { tijdlijn: [{ soort: 'reis', titel: 'Proefreis Noorwegen', begin_datum: '2026-11-22', eind_datum: '2026-11-26' }] }); toets('op reis', /^op reis: Proefreis Noorwegen/.test(x.kern), x);
// 5 Promedico niet gezien op een werkdag
x = r(DAG + 'T10:00', DAG + 'T10:30', { promedico: { x: null } }); toets('Promedico niet gezien → nooit vrij', /Promedico niet gezien/.test(x.kern) && !/^vrij/.test(x.kern), x);
x = r(DAG + 'T10:00', DAG + 'T10:30', { promedico: { x: Object.assign({}, pm, { gezien_ms: NU - 5 * 86400000 }) } }); toets('Promedico oud → niet recent gezien, niet vrij', /niet recent gezien/.test(x.regel) && x.kern !== 'vrij', x);
x = r('2026-11-28T10:00', '2026-11-28T11:00', { promedico: { x: null }, tijdlijn: [] }); toets('zaterdag zonder Promedico → vrij met "niet gezien" erbij', x.kern === 'vrij' && /Promedico niet gezien/.test(x.regel) && /weekend/.test(x.regel), x);
// reistijd
x = r(DAG + 'T15:00', DAG + 'T16:00', { events: [ev('David', 'Overleg', '14:00', '14:50', 'Stationsplein 1, Utrecht')] }, { locatie: 'Huisartsenpraktijk Tolgaarde' });
toets('reistijd krap Utrecht → Leusden', /^krap: reistijd ± \d+ min, er zit 10 min tussen/.test(x.kern) && /vanaf Utrecht/.test(x.regel), x);
x = r(DAG + 'T15:00', DAG + 'T16:00', { events: [ev('David', 'Overleg', '13:00', '14:00', 'Leusden')] }, { locatie: 'Amersfoort' }); toets('reistijd ruim → vrij met reistijdregel', x.kern === 'vrij' && /reistijd ± \d+ min vanaf Leusden/.test(x.regel), x);
// bron kapot
x = r(DAG + 'T15:00', DAG + 'T16:00', { events: null }); toets('agenda niet te lezen → niet zeker', /^niet zeker: agenda's/.test(x.kern), x);
x = r(DAG + 'T15:00', DAG + 'T16:00', { promedico: { fout: 'staat' } }); toets('Promedico kapot → niet zeker', /^niet zeker: Promedico/.test(x.kern), x);
// rooster
x = r(DAG + 'T15:00', DAG + 'T16:00', { tijdlijn: [rooster('AL')] }); toets('geen DS → geen werkdag', /geen werkdag volgens het rooster/.test(x.regel), x);
x = r(DAG + 'T15:00', DAG + 'T16:00', { tijdlijn: [] }); toets('geen rooster → nog niet bekend', /rooster voor die dag nog niet bekend/.test(x.regel), x);
// hele dag
x = r(DAG, '', { events: [ev('Werk', 'Congres', '10:00', '12:00')] }); toets('hele dag met afspraak', /^botsing met "Congres" \(Werk 10:00–12:00\)/.test(x.kern) && /patiënt geboekt/.test(x.regel), x);
x = r(DAG, '', { promedico: { x: null }, tijdlijn: [] }); toets('hele doordeweekse dag, rooster onbekend, Promedico niet gezien → niet vrij', x.kern !== 'vrij' && /Promedico niet gezien/.test(x.kern), x);
// invoer
toets('fout: onzin', !!r('morgen', '').fout); toets('fout: eind voor start', !!r(DAG + 'T15:00', DAG + 'T14:00').fout);
toets('fout: over middernacht', !!r(DAG + 'T23:00', '2026-11-25T01:00').fout); toets('fout: agenda', !!M.leesVerzoek({ start: DAG + 'T10:00', agenda: 'schapies' }).fout);
toets('zomertijd: 2026-07-01T10:00 = 08:00Z', M.lokaalMs('2026-07-01T10:00') === Date.UTC(2026, 6, 1, 8, 0));
toets('wintertijd: 2026-12-01T10:00 = 09:00Z', M.lokaalMs('2026-12-01T10:00') === Date.UTC(2026, 11, 1, 9, 0));
toets('niet-bestaande tijd 2027-03-28T02:30', !Number.isFinite(M.lokaalMs('2027-03-28T02:30')));
toets('plaats: laatste plaatsnaam telt', M.plaatsVan('Amersfoortseweg 10, Leusden') === 'leusden');
console.log(ok + ' goed, ' + fout + ' fout');
process.exit(fout ? 1 : 0);
EINDE
