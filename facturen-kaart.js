'use strict';
/*
 * Verzamelkaart Facturen in Overzicht (wv1705, OVIS M3a; bouwplan vault "01_Ontwikkeling/OVIS - ontwerplijnen (bouwplan 24-10-2026).md"
 * § 4.1 Verzamelkaarten en § 5.1). Eén kaart per dag in machinekamer.voor_jou met het aantal facturen in Beoordelen:
 * sleutel facturen-JJJJ-MM-DD, herkomst { module: 'facturen', handmatig: 'facturen', doel: { scherm: 'facturen', focus: 'stap:beoordelen' } }.
 * Waarom een dagsleutel: mk_voor_jou_zet zet bij een bestaande sleutel de status niet terug (Fable 24-10 #11).
 *
 * Regels (bijwerken):
 *  - n = 0: elke open of geparkeerde facturen-kaart gaat dicht (gedaan, door agent, met bewijs).
 *  - n > 0: de kaart van vandaag krijgt het aantal; een oudere open kaart wordt samengevoegd in die van vandaag. Parkeerde David een
 *    kaart (later), dan werkt de module die kaart bij en maakt geen nieuwe (zijn "later" blijft staan). Sloot de module de kaart van
 *    vandaag eerder bij 0, dan gaat hij weer open; sloot David hem zelf, dan blijft hij dicht tot morgen.
 *  - geen schrijfactie als het aantal op de open kaart gelijk bleef (vorige).
 * Puur: geen netwerk, alleen de meegegeven io. teBeoordelen(fdb) leest de eigen Facturen-database (status te_beoordelen; de eigenaar
 * ziet alles, dus gelijk aan de teller tellers.beoordelen van Davids app).
 */

const MODULE = 'facturen';
const SLEUTEL = /^facturen-(\d{4}-\d{2}-\d{2})$/;
const BEWIJS_LEEG = 'Er staan geen facturen meer te beoordelen.';

function herkomst() { return { module: MODULE, handmatig: 'facturen', doel: { scherm: 'facturen', focus: 'stap:beoordelen' } }; }

function teBeoordelen(fdb) {
  return Number(fdb.db.prepare("SELECT count(*) AS n FROM factuur WHERE status = 'te_beoordelen'").get().n) || 0;
}

// De kaart. Geen paden, wv-nummers of verwijzingen (mk_voor_jou_zet weigert die); de stappen staan in de kaart zelf.
function kaart(sleutel, n, nuKort) {
  const wat = n === 1 ? '1 factuur' : n + ' facturen';
  return { sleutel: sleutel, soort: 'doen', waar: 'overal', prive: false, duur_min: Math.min(30, 2 + 2 * n), volgorde: 30,
    titel: 'Facturen — ' + wat + ' beoordelen',
    waarom: (n === 1 ? 'Er staat 1 inkoopfactuur' : 'Er staan ' + n + ' inkoopfacturen') + ' in Beoordelen. Zolang je ' + (n === 1 ? 'hem' : 'ze') +
      ' niet bevestigt, gaat er niets naar de boekhouder of de betaallijst.',
    stappen: ['Open in de Socev-app Apps › Facturen; je komt in Beoordelen.', 'Bekijk per factuur het stuk en druk Bevestigen, of kies wat er anders moet.',
      'Klaar als er niets meer te beoordelen is; deze kaart gaat dan vanzelf dicht.'],
    meting: nuKort + ': ' + (n === 1 ? '1 factuur wacht' : n + ' facturen wachten') + ' op je beoordeling.',
    herkomst: herkomst() };
}

/*
 * bijwerken({ datum, n, nuKort, punten, vorige }, io) → { n, gezet, heropend, samengevoegd, gesloten, overgeslagen, fouten }
 *   punten: [{ sleutel, status, gesloten_door }] uit mk_voor_jou_lijst (alle, ook gesloten); andere sleutels worden genegeerd.
 *   vorige: { sleutel, n } van de laatste geslaagde zet in dit podleven (of null).
 *   io.zet(p) → mk_voor_jou_zet; io.status(sleutel, van, naar, { bewijs, samengevoegd_in, reden }) → { ok } (mk_voor_jou_status, door agent).
 * Een conflict (David drukte net) is geen fout: de volgende ronde ziet de nieuwe stand.
 */
async function bijwerken(x, io) {
  const n = Math.max(0, Number(x.n) || 0);
  const uit = { n: n, gezet: null, heropend: null, samengevoegd: [], gesloten: [], overgeslagen: null, fouten: [] };
  const eigen = (x.punten || []).filter(function (p) { return p && SLEUTEL.test(String(p.sleutel)); });
  const levend = eigen.filter(function (p) { return p.status === 'open' || p.status === 'later'; });
  const status = async function (p, naar, extra, lijst) {
    const r = await io.status(p.sleutel, p.status, naar, extra);
    if (r && r.ok === true) lijst.push(p.sleutel); else uit.fouten.push(p.sleutel + ': ' + ((r && (r.fout || r.nu)) || 'geen antwoord'));
    return !!(r && r.ok === true);
  };
  if (n === 0) {
    for (const p of levend) await status(p, 'gedaan', { bewijs: (x.nuKort ? x.nuKort + ': ' : '') + BEWIJS_LEEG, reden: 'facturen-kaart: 0 te beoordelen' }, uit.gesloten);
    return uit;
  }
  const later = levend.filter(function (p) { return p.status === 'later'; }).sort(function (a, b) { return a.sleutel < b.sleutel ? 1 : -1; })[0];
  const doel = later ? later.sleutel : 'facturen-' + x.datum;
  const huidig = eigen.find(function (p) { return p.sleutel === doel; });
  if (!later && huidig && huidig.status !== 'open') {
    if (huidig.status === 'gedaan' && huidig.gesloten_door === 'agent') {
      const ok = await status(huidig, 'open', { reden: 'facturen-kaart: weer ' + n + ' te beoordelen' }, []);
      if (!ok) return uit;
      uit.heropend = doel;
    } else {
      uit.overgeslagen = 'kaart van vandaag ' + huidig.status + ' door ' + (huidig.gesloten_door || '?');
      return uit;
    }
  }
  const zelfde = !uit.heropend && huidig && x.vorige && x.vorige.sleutel === doel && x.vorige.n === n;
  if (!zelfde) { await io.zet(kaart(doel, n, x.nuKort || '')); uit.gezet = doel; }
  for (const p of levend) {
    if (p.sleutel === doel || p.status !== 'open') continue;
    await status(p, 'samengevoegd', { samengevoegd_in: doel, reden: 'facturen-kaart: nieuwe dagkaart' }, uit.samengevoegd);
  }
  return uit;
}

module.exports = { MODULE, SLEUTEL, herkomst, kaart, bijwerken, teBeoordelen };
