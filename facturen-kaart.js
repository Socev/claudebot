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

/*
 * Vangnet niet betaald (wv1917, David 28-10-2026: "Jij zou wel gevangen hebben na twee weken dat hij nergens betaald is als het goed is").
 * Een bevestigde zakelijke factuur (niet Privé, geen creditnota) die 7 dagen na de vervaldatum (zonder vervaldatum: factuurdatum + 14)
 * nog niet aan een bankregel gekoppeld is, terwijl de ingelezen bank van die entiteit al tot na die grens loopt: één Voor jou-kaart per
 * factuur (sleutel facturen-onbetaald-<factuur-id>). Ook "al betaald" (betaald_vooraf) telt: dat is een bewering, geen bewijs. Bestaat de
 * sleutel al (in welke status ook), dan geen nieuwe kaart: hooguit één per factuur, Davids "gedaan" blijft. Is de factuur intussen
 * gekoppeld of niet meer open, dan gaat een open of geparkeerde kaart dicht (door agent, met bewijs). Loopt de bank nog niet tot de grens,
 * dan zeggen we niets (niet vast te stellen). Hooguit MAX_ONBETAALD nieuwe kaarten per ronde.
 */
const ONBETAALD = /^facturen-onbetaald-([0-9a-f]{16})$/;
const ONBETAALD_DAGEN = 7;
const MAX_ONBETAALD = 5;
const OPEN_SPOREN = ['te_betalen', 'ingevoerd', 'incasso_verwacht', 'betaald_vooraf'];
function isoPlus(iso, dagen) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + dagen)).toISOString().slice(0, 10);
}
function nlDatum(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? Number(m[3]) + '-' + Number(m[2]) + '-' + m[1] : '?'; }
function euroTekst(c) {
  const n = Math.abs(Number(c) || 0), e = Math.floor(n / 100), ct = String(n % 100).padStart(2, '0');
  return '€ ' + String(e).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + ct;
}
// Kandidaten uit de eigen Facturen-database: bevestigd, zakelijk, open betaalspoor, niet gekoppeld; met de laatste boekdatum van de entiteit.
function onbetaald(fdb) {
  // diffreview wv1917: netto gekoppeld (een terugboeking heft een betaling op, zoals NETTO_GEKOPPELD in facturen.js), geen open koppelvoorstel,
  // en de bankstand = de oudste van de laatste boekdatums per rekening van de entiteit (niet verwijderde regels), zodat één bijgewerkte
  // rekening niet doet alsof de andere ook bij is.
  return fdb.db.prepare("SELECT f.id, coalesce(l.naam, f.leverancier_naam) AS naam, f.nummer, f.incl, f.entiteit, coalesce(e.naam_kort, e.naam) AS ent_naam, " +
    "f.vervaldatum, f.factuurdatum, f.betaalspoor, f.uitvoer_op, " +
    "(SELECT min(m) FROM (SELECT max(t.boekdatum) AS m FROM bank_transactie t JOIN rekening r ON r.id = t.rekening WHERE r.entiteit = f.entiteit AND r.controle = 1 " +
    "AND t.verwijderd_op IS NULL GROUP BY t.rekening)) AS bank_tot " +
    "FROM factuur f LEFT JOIN leverancier l ON l.id = f.leverancier LEFT JOIN entiteit e ON e.sleutel = f.entiteit " +
    "WHERE f.status IN ('in_wachtrij','wordt_verstuurd','concept_klaar','verstuurd','verzending_mislukt') AND f.entiteit IS NOT NULL AND f.entiteit <> 'prive' " +
    "AND f.soort = 'factuur' AND f.incl > 0 AND f.betaalspoor IN ('te_betalen','ingevoerd','incasso_verwacht','betaald_vooraf') " +
    "AND (SELECT count(*) FROM koppeling k WHERE k.factuur = f.id AND coalesce(k.methode, '') <> 'sepa_terug') <= " +
    "(SELECT count(*) FROM koppeling k WHERE k.factuur = f.id AND k.methode = 'sepa_terug') " +
    "AND NOT EXISTS (SELECT 1 FROM voorstel v WHERE v.status = 'open' AND EXISTS (SELECT 1 FROM json_each(v.facturen) j WHERE j.value = f.id))").all();
}
function onbetaaldKaart(r, grens, nuKort) {
  const naam = String(r.naam || 'onbekende leverancier').slice(0, 50);
  const wat = r.betaalspoor === 'betaald_vooraf' ? 'staat als al betaald, maar ' : r.betaalspoor === 'incasso_verwacht' ? 'zou geïncasseerd worden, maar ' :
    r.betaalspoor === 'ingevoerd' ? 'staat als ingevoerd in de bank, maar ' : '';
  return { sleutel: 'facturen-onbetaald-' + r.id, soort: 'doen', waar: 'overal', prive: false, duur_min: 5, volgorde: 30,
    titel: ('Factuur ' + naam + ' — betaling nakijken').slice(0, 90),
    waarom: ('De factuur van ' + naam + (r.nummer ? ' (nr. ' + String(r.nummer).slice(0, 30) + ')' : '') + ' voor ' + (r.ent_naam || r.entiteit) + ', ' + euroTekst(r.incl) +
      ', verviel op ' + nlDatum(r.vervaldatum || isoPlus(r.factuurdatum, 14)) + '. Hij ' + wat + 'ik zie tot en met ' + nlDatum(r.bank_tot) +
      ' geen betaling in de bank. Zo blijft er geen rekening onbetaald liggen.').slice(0, 400),
    stappen: ['Kijk of je hem betaald hebt (bank, creditcard of iDEAL).',
      'Niet betaald: betaal hem alsnog; staat hij op de betaallijst, dan via Apps › Facturen › Betalen.',
      'Wel betaald: koppel de betaling in Apps › Facturen › Bankcontrole, of zet deze kaart op gedaan.'],
    meting: (nuKort + ': niet gekoppeld aan een bankregel; bank ingelezen t/m ' + nlDatum(r.bank_tot) + ', grens ' + nlDatum(grens) + '.').slice(0, 300),
    herkomst: { module: MODULE, handmatig: 'facturen', doel: { scherm: 'facturen', focus: 'factuur:' + r.id } } };
}
/*
 * onbetaaldPlan({ rijen, punten, vandaag, nuKort }) → { zet: [kaart], dicht: [{ sleutel, van, bewijs }], wacht_op_bank: n }
 *   rijen: onbetaald(fdb); punten: mk_voor_jou_lijst (alle, ook gesloten): [{ sleutel, status }].
 */
function onbetaaldPlan(x) {
  const punten = (x.punten || []).filter(function (p) { return p && ONBETAALD.test(String(p.sleutel)); });
  const bekend = new Map(punten.map(function (p) { return [p.sleutel, p.status]; }));
  const uit = { zet: [], dicht: [], wacht_op_bank: 0 };
  const nog = new Set();
  for (const r of x.rijen || []) {
    if (!OPEN_SPOREN.includes(r.betaalspoor)) continue;
    const verval = /^\d{4}-\d{2}-\d{2}$/.test(String(r.vervaldatum || '')) ? r.vervaldatum : isoPlus(r.factuurdatum, 14);
    let grens = verval ? isoPlus(verval, ONBETAALD_DAGEN) : null;
    // in een SEPA-batch met een latere uitvoerdatum: tellen vanaf die datum (diffreview ZOU 5)
    if (grens && r.betaalspoor === 'ingevoerd' && /^\d{4}-\d{2}-\d{2}$/.test(String(r.uitvoer_op || '')) && isoPlus(r.uitvoer_op, ONBETAALD_DAGEN) > grens) grens = isoPlus(r.uitvoer_op, ONBETAALD_DAGEN);
    if (!grens || !(x.vandaag > grens)) continue;
    const sleutel = 'facturen-onbetaald-' + r.id;
    nog.add(sleutel);
    if (!r.bank_tot || r.bank_tot < grens) { uit.wacht_op_bank++; continue; }   // bank nog niet ingelezen tot de grens: niet vast te stellen
    if (bekend.has(sleutel) || uit.zet.length >= MAX_ONBETAALD) continue;
    uit.zet.push(onbetaaldKaart(r, grens, x.nuKort || ''));
  }
  for (const p of punten) {
    if ((p.status === 'open' || p.status === 'later') && !nog.has(p.sleutel)) {
      uit.dicht.push({ sleutel: p.sleutel, van: p.status, bewijs: ((x.nuKort ? x.nuKort + ': ' : '') + 'de factuur is nu aan een betaling gekoppeld of staat niet meer open.') });
    }
  }
  return uit;
}

module.exports = { MODULE, SLEUTEL, herkomst, kaart, bijwerken, teBeoordelen, ONBETAALD, onbetaald, onbetaaldPlan, onbetaaldKaart };
