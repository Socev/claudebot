'use strict';
// wv3686 (21-11-2026, besluitenpagina nr 355 = 3C55 stap 1, David Ja 21-11 12:41): herinneringen op Davids moment.
// De heartbeat (n8n "Heartbeat - proactief overdag") zet een bericht met een eerste regel "MOMENT: thuis" of "MOMENT: werk"
// niet meteen door, maar vraagt elke 5 minuten aan de pod (POST /heartbeat/moment) of het moment er is. Deze module beslist,
// puur (geen io): op de locatiemeldingen van Davids telefoon (secondbrain.locatie, thuis/werk/overig, ± elke 10 min).
//
// thuis (thuisdingen: afval, wat morgen mee moet, bezorgd):
//   - nu op of na het uiterste uur (21:30, of een andere dag dan het klaarzetten)  → sturen ("uiterlijk").
//   - geen verse plaatsmelding (> 30 min oud of onleesbaar)                          → vangnet: sturen vanaf het vaste uur 18:00.
//   - thuis en kort ervoor (sinds klaarzetten − 30 min) ergens anders                → sturen ("thuiskomst").
//   - thuis zonder overgang                                                          → vaste uur 18:00.
//   - op de praktijk                                                                 → wachten (op vertrek).
//   - overig en ≤ 45 min geleden nog op de praktijk                                  → sturen ("vertrek van de praktijk").
//   - overig, vandaag wel op de praktijk geweest (eerder vertrokken)                 → wachten op thuiskomst (tot 21:30).
//   - overig, vandaag niet op de praktijk                                            → vaste uur 18:00 (geen overgang te verwachten).
// werk (werkdingen van vandaag):
//   - op de praktijk → sturen; geen verse melding → sturen (het vaste uur is het tik-uur zelf, dat is al voorbij);
//   - anders wachten tot aankomst, uiterlijk 3 uur na klaarzetten (en nooit na 21:30).
// Er valt nooit iets weg: elke twijfel (onbekend doel, onleesbare tijd, geen data) = sturen. Stille uren (23-07) bestaan hier niet:
// het uiterste uur ligt ervoor, en de bezorgroute (Bericht aan David) bewaakt ze zelf.

const TZ = 'Europe/Amsterdam';
const MIN = 60 * 1000;
const VERS_MIN = 30;            // plaatsmelding ouder dan dit = geen verse melding (skill waar-is-david)
const VERTREK_MIN = 45;         // laatste praktijkmelding zo recent + nu elders = vertrek
const THUISKOMST_VOOR_MIN = 30; // ook een thuiskomst kort vóór het klaarzetten telt als moment
const THUIS_VAST = 18 * 60;     // vaste uur van nu voor thuisdingen (minuten na middernacht)
const UITERST = 21 * 60 + 30;   // nooit later dan dit (ruim vóór de stille uren)
const WERK_MAX_MIN = 180;       // werkdingen wachten hooguit 3 uur op aankomst

const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function lokaal(ms) {
  const d = {}; fmt.formatToParts(new Date(ms)).forEach(function (p) { d[p.type] = p.value; });
  return { dag: d.year + '-' + d.month + '-' + d.day, min: Number(d.hour) * 60 + Number(d.minute) };
}
function getal(x) { const n = Number(x); return isFinite(n) && n > 0 ? n : null; }

// invoer: { doel, sinds (ISO of ms: klaargezet), nu (ms, databankklok), huidig: { klasse, g, o } (locatie_nu), reeks: [{ klasse, g }] }
// uit:    { nu: true|false, reden, plek, leeftijd_min }
function beslis(inv) {
  const i = inv || {};
  const doel = i.doel;
  const nu = getal(i.nu);
  const sinds = typeof i.sinds === 'number' ? getal(i.sinds) : getal(Date.parse(i.sinds));
  const uit = function (n, reden, extra) { return Object.assign({ nu: n, reden: reden }, extra || {}); };
  if (doel !== 'thuis' && doel !== 'werk') return uit(true, 'onbekend doel');
  if (!nu || !sinds) return uit(true, 'tijd onleesbaar');
  const L = lokaal(nu), Ls = lokaal(sinds);
  if (L.dag !== Ls.dag || L.min >= UITERST) return uit(true, 'uiterlijk');
  if (doel === 'werk' && nu - sinds >= WERK_MAX_MIN * MIN) return uit(true, 'uiterlijk');

  const h = i.huidig || null;
  const o = h && getal(h.o), g = h && getal(h.g);
  const vers = !!(h && o && g && (h.klasse === 'thuis' || h.klasse === 'werk' || h.klasse === 'overig') &&
    nu - o <= VERS_MIN * MIN && nu - g <= (VERS_MIN + 2) * MIN && o <= nu + MIN && g <= nu + 2 * MIN);
  const extra = { plek: vers ? h.klasse : null, leeftijd_min: o ? Math.round((nu - o) / MIN) : null };
  const vastUur = function (reden) { return doel === 'werk' || L.min >= THUIS_VAST ? uit(true, reden, extra) : uit(false, reden, extra); };
  if (!vers) return vastUur('geen verse plaatsmelding');

  const reeks = (Array.isArray(i.reeks) ? i.reeks : []).filter(function (r) { return r && getal(r.g) && r.g <= nu + 2 * MIN; });
  const plek = h.klasse;
  if (doel === 'werk') return plek === 'werk' ? uit(true, 'op de praktijk', extra) : uit(false, 'nog niet op de praktijk', extra);

  if (plek === 'thuis') {
    // aankomst = eerste thuismelding na de laatste melding van elders (alleen als die er in de reeks is)
    let k = -1; reeks.forEach(function (r, n) { if (r.klasse !== 'thuis') k = n; });
    const aankomst = k < 0 ? null : (reeks[k + 1] ? reeks[k + 1].g : g);
    return aankomst && aankomst >= sinds - THUISKOMST_VOOR_MIN * MIN ? uit(true, 'thuiskomst', extra) : vastUur('thuis, geen overgang');
  }
  if (plek === 'werk') return uit(false, 'op de praktijk', extra);
  // overig
  const werk = reeks.filter(function (r) { return r.klasse === 'werk'; }).map(function (r) { return r.g; });
  const laatsteWerk = werk.length ? Math.max.apply(null, werk) : null;
  if (laatsteWerk && nu - laatsteWerk <= VERTREK_MIN * MIN) return uit(true, 'vertrek van de praktijk', extra);
  if (laatsteWerk && lokaal(laatsteWerk).dag === L.dag) return uit(false, 'onderweg na de praktijk', extra);
  return vastUur('elders, geen overgang');
}

// De vraag aan de databank: huidige plek (view locatie_nu, houdt onzekere metingen vast) en de meldingen van de laatste 14 uur.
const SQL = "select json_build_object(" +
  "'nu', (extract(epoch from now())*1000)::bigint, " +
  "'huidig', (select json_build_object('klasse', v.klasse, 'g', (extract(epoch from v.gemeten)*1000)::bigint, 'o', (extract(epoch from v.ontvangen)*1000)::bigint) from secondbrain.locatie_nu v limit 1), " +
  "'reeks', coalesce((select json_agg(json_build_object('klasse', l.klasse, 'g', (extract(epoch from l.gemeten)*1000)::bigint) order by l.gemeten) " +
  "from secondbrain.locatie l where l.bron <> all (array['proef', 'kastje']) and l.gemeten > now() - interval '14 hours' and l.gemeten <= now() + interval '2 minutes'), '[]'::json)) as m";

module.exports = { beslis: beslis, lokaal: lokaal, SQL: SQL, VERS_MIN: VERS_MIN, VERTREK_MIN: VERTREK_MIN, THUIS_VAST: THUIS_VAST, UITERST: UITERST };
