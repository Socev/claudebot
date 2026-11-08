// OVIS POT — naspelen (wv2782): de systematiek zoals gebouwd jaar voor jaar loslaten op de echte geschiedenis.
// PUUR, zoals de rekenkern: alle gegevens komen binnen (historie, bank, standen, deelname, kosten, Davids afrekeningen).
//
// Per entiteit en jaar zet het naast elkaar:
//  - begroot (Davids begroting vooraf + tussentijdse aanvullingen) tegenover de werkelijke kosten (jaarrekening/eindafrekening);
//  - wat het model had gevraagd: begroting vooraf op de 1-1-aantallen (R4), maandpatroon (R6, POT mei/november hoger), buffer (R7,
//    zoals nu besloten: vast tegoed, opbouw in de gekozen maanden van het eerste jaar), de afrekening van het jaar ervoor (R1–R3,
//    gemiddelde van 1-1 oud en 1-1 nieuw, tegen wat met nota's gevraagd is; SLOEL als correctie op de eerstvolgende huur);
//  - de afrekening per praktijk: model tegenover Davids eindafrekening;
//  - de saldoloop per maand: echt (bank) en model (alle echte uitgaven en overige posten blijven; alleen de bijdragen van de
//    praktijken worden vervangen door wat het model zou vragen), met en zonder Davids aanvullingen.
// Tolgaarde is het vangnet (David 8-11-2026): zakt het modelsaldo onder nul, dan is dat het bedrag waarmee Tolgaarde had moeten
// bijspringen (extra bijdrage, verrekend in de afrekening).
import {
  aandelenAfrekening, aandelenBijdrage, afrekening, bufferPlan, kostenJaar, maandpatroon, rond2, MAANDEN, euro,
} from "./pot-kern.mjs";

/** Bijdragen van praktijken in de bank: die vervangt het model; al het andere (uitgaven, subsidie, onderling) blijft echt. */
export const BIJDRAGE_SOORTEN = { POT: ["voorschot", "afrekening", "liquiditeit"], KM: ["voorschot", "afrekening", "liquiditeit"], SLOEL: ["huur", "liquiditeit"] };
/** Aanname zolang de historie geen personeelsbestand heeft: vakantiegeld- en eindejaarspakket als deel van de POT-begroting (gemeten op de proefbegroting 2027). */
export const POT_PAKKET = { vakantiegeld: 0.0569, eindejaar: 0.0534 };

const p2 = (n) => String(n).padStart(2, "0");
const som = (l, f = (x) => x) => l.reduce((s, x) => s + Number(f(x) || 0), 0);

/** Middelste datum (naar bedrag gewogen) van een reeks bankposten; null als er geen zijn. */
export function middenDatum(posten) {
  const l = posten.filter((x) => Math.abs(x.bedrag) > 0.004).slice().sort((a, b) => (a.datum < b.datum ? -1 : 1));
  const tot = som(l, (x) => Math.abs(x.bedrag));
  if (!(tot > 0)) return null;
  let s = 0;
  for (const x of l) { s += Math.abs(x.bedrag); if (s >= tot / 2) return x.datum; }
  return l.at(-1).datum;
}

/**
 * Speel één entiteit na over de jaren `van`..`tot`.
 * @param {{ entiteit: string, van: number, tot: number, standen: any[], deelnames: any[], jaarlasten: any[],
 *   historie: {entiteit:string, jaar:number, maand:number|null, praktijk_id:string|null, bedrag:number, categorie:string, titel:string}[],
 *   bank: {datum:string, bedrag:number, soort:string|null, praktijk_id:string|null, boekjaar:number|null}[],
 *   afrekeningDavid: {jaar:number, praktijk_id:string, kosten:number, betaald:number, saldo:number}[],
 *   buffer: {doel:number, opbouw_in?:string|number[]|null} | null, startsaldo: number, startdatum?: string, betaaldag?: number }} a
 */
export function naspeelEntiteit(a) {
  const E = a.entiteit, dag = Math.min(28, Number(a.betaaldag) || 15);
  const vervang = new Set(BIJDRAGE_SOORTEN[E] || []);
  const isBijdrage = (b) => vervang.has(b.soort) && !(b.soort === "afrekening" && b.boekjaar != null && b.boekjaar < a.van);
  const hist = a.historie.filter((h) => h.entiteit === E);
  const bankEind = a.bank.length ? a.bank.map((b) => b.datum).sort().at(-1) : null;   // de bank is bekend t/m deze dag
  const jaren = [];
  let saldoEcht = Number(a.startsaldo), saldoModel = Number(a.startsaldo), saldoZonder = Number(a.startsaldo);
  const bufferAl = {};             // buffer per praktijk die het model al gevraagd heeft (vast tegoed)
  let vorig = null, vorigZonder = null;   // model: per praktijk gevraagd in het vorige jaar (zonder buffer), met en zonder aanvullingen
  for (let J = a.van; J <= a.tot; J++) {
    const hJ = hist.filter((h) => Number(h.jaar) === J);
    const vooraf = hJ.filter((h) => h.categorie === "begroting_vooraf");
    const aanv = hJ.filter((h) => h.categorie === "aanvulling");
    const corr = hJ.filter((h) => h.categorie === "correctie_vorig_jaar");
    const B = rond2(som(vooraf, (h) => h.bedrag));
    const aanvullingen = [...new Set(aanv.map((h) => h.titel))].map((t) => {
      const r = aanv.filter((h) => h.titel === t);
      const mnd = Array(12).fill(0); for (const h of r) if (h.maand) mnd[h.maand - 1] += Number(h.bedrag);
      return { titel: t, bedrag: rond2(som(r, (h) => h.bedrag)), maanden: mnd.map(rond2), eerste_maand: mnd.findIndex((x) => Math.abs(x) > 0.004) + 1 };
    });
    const aanvPerP = {}; for (const h of aanv) if (h.praktijk_id) aanvPerP[h.praktijk_id] = (aanvPerP[h.praktijk_id] || 0) + Number(h.bedrag);
    const voorafMnd = Array(12).fill(0); for (const h of vooraf) if (h.maand) voorafMnd[h.maand - 1] += Number(h.bedrag);
    const mediaan = voorafMnd.slice(1).sort((x, y) => x - y)[5];
    const kosten = kostenJaar(a.jaarlasten, E, J);
    const gevraagdDavid = rond2(B + som(aanvullingen, (x) => x.bedrag));

    // ---- model: bijdragen J (R4 + R6) en buffer (R7)
    const aandelen = aandelenBijdrage({ entiteit: E, jaar: J, standen: a.standen, deelnames: a.deelnames });
    const pakket = E === "POT" ? { vakantiegeld_pakket: B * POT_PAKKET.vakantiegeld, eindejaar_pakket: B * POT_PAKKET.eindejaar } : { vakantiegeld_pakket: 0, eindejaar_pakket: 0 };
    const patroon = B > 0 ? maandpatroon({ entiteit: E, begroting: { totaal: B, ...pakket }, aandelen }) : { ok: false, reden: `geen begroting vooraf ${J} in de historie` };
    const eerstejaar = !Object.keys(bufferAl).length;
    const buffer = a.buffer && aandelen.ok ? bufferPlan({ doel: a.buffer.doel, aandelen, alGevraagd: bufferAl, opbouwMaanden: eerstejaar ? 12 : 1, opbouwIn: eerstejaar ? a.buffer.opbouw_in : null }) : null;
    // alleen bijhouden wat het model echt vraagt: zonder modelbegroting dit jaar ook geen buffer (Codex r2 M2)
    if (buffer && buffer.ok && patroon.ok) for (const p of buffer.praktijken) bufferAl[p.praktijk_id] = rond2((bufferAl[p.praktijk_id] || 0) + p.nog);
    const modelMnd = Array.from({ length: 12 }, (_, i) => (patroon.ok ? som(patroon.praktijken, (p) => p.maanden[i]) : 0));
    const bufferMnd = buffer && buffer.ok && patroon.ok ? buffer.per_maand : Array(12).fill(0);
    const gevraagdZonder = {}, gevraagd = {};
    if (patroon.ok) for (const p of patroon.praktijken) { gevraagdZonder[p.praktijk_id] = p.jaar; gevraagd[p.praktijk_id] = rond2(p.jaar + (aanvPerP[p.praktijk_id] || 0)); }

    // ---- model: afrekening van het vorige jaar (R1–R3), rond de datum waarop Davids eindafrekening echt binnenkwam;
    //      SLOEL: als correctie op de eerstvolgende huur (de maand waarin David het deed, anders juni)
    const echtePosten = a.bank.filter((b) => b.soort === "afrekening" && Number(b.boekjaar) === J - 1);
    const corrMaand = corr.find((h) => h.maand)?.maand;
    let afrDatum = (E === "SLOEL" && corrMaand ? `${J}-${p2(corrMaand)}-${p2(dag)}` : null) || middenDatum(echtePosten) || `${J}-06-${p2(dag)}`;
    if (!afrDatum.startsWith(String(J))) afrDatum = `${J}-06-${p2(dag)}`;
    const afrVorig = vorig ? rekenAfr(a, E, J - 1, vorig, afrDatum) : null;
    const afrVorigZonder = vorigZonder ? rekenAfr(a, E, J - 1, vorigZonder, afrDatum) : null;

    // ---- bank J: echt, en model = echt zonder bijdragen + modelbijdragen (+ aanvullingen als herziening R9 op Davids momenten)
    const bankJ = a.bank.filter((b) => b.datum.startsWith(String(J)));
    const laatstePost = bankJ.length ? bankJ.map((b) => b.datum).sort().at(-1) : null;
    const volledig = !!bankEind && bankEind >= `${J}-12-31`;
    const tot = (x) => volledig || (!!bankEind && x.datum <= bankEind);   // een lopend jaar: niet verder rekenen dan de bank
    const echt = bankJ.map((b) => ({ datum: b.datum, bedrag: Number(b.bedrag) }));
    // Kan het model iets niet rekenen (geen begroting, kosten of standen), dan blijven de echte posten van dat deel staan: geen
    // verzonnen tekort (Codex r1 M2). Zonder modelbegroting blijven alle echte bijdragen; zonder afrekening vorig jaar de echte afrekening.
    const houdEcht = (b, afr) => !isBijdrage(b) || !patroon.ok || (b.soort === "afrekening" && Number(b.boekjaar) === J - 1 && !(afr && afr.ok));
    const rest = bankJ.filter((b) => houdEcht(b, afrVorig)).map((b) => ({ datum: b.datum, bedrag: Number(b.bedrag) }));
    const restZonder = bankJ.filter((b) => houdEcht(b, afrVorigZonder)).map((b) => ({ datum: b.datum, bedrag: Number(b.bedrag) }));
    const bijdragenEcht = bankJ.filter(isBijdrage);
    const inModel = [];
    for (let m = 1; m <= 12; m++) {
      const x = modelMnd[m - 1] + bufferMnd[m - 1];
      if (Math.abs(x) > 0.004) inModel.push({ datum: `${J}-${p2(m)}-${p2(dag)}`, bedrag: x });
    }
    const inAanv = [];
    for (const x of aanvullingen) x.maanden.forEach((b, i) => { if (Math.abs(b) > 0.004) inAanv.push({ datum: `${J}-${p2(i + 1)}-${p2(dag)}`, bedrag: b }); });
    const afrIn = (r) => (r && r.ok && Math.abs(r.uitkomst) > 0.004 ? [{ datum: r.datum, bedrag: r.uitkomst }] : []);
    const ksEcht = kasDag({ jaar: J, startsaldo: saldoEcht, stromen: echt });
    const ksModel = kasDag({ jaar: J, startsaldo: saldoModel, stromen: [...rest, ...(patroon.ok ? [...inModel, ...inAanv, ...afrIn(afrVorig)] : []).filter(tot)], vangnet: patroon.ok });
    const ksZonder = kasDag({ jaar: J, startsaldo: saldoZonder, stromen: [...restZonder, ...(patroon.ok ? [...inModel, ...afrIn(afrVorigZonder)] : []).filter(tot)], vangnet: patroon.ok });
    // wat het vangnet stortte is een extra bijdrage van die praktijk in jaar J (geen lening; David 8-11-2026): telt mee in de afrekening
    const vn = a.vangnet || "P07";
    if (ksModel.bijspring > 0.004) gevraagd[vn] = rond2((gevraagd[vn] || 0) + ksModel.bijspring);
    if (ksZonder.bijspring > 0.004) gevraagdZonder[vn] = rond2((gevraagdZonder[vn] || 0) + ksZonder.bijspring);

    // ---- afrekening J: model (met de aanvullingen als gevraagd) tegenover David
    let afr = null;
    if (kosten && patroon.ok) {
      const r = afrekening({ aandelen: aandelenAfrekening({ entiteit: E, jaar: J, standen: a.standen, deelnames: a.deelnames }), kosten: kosten.bedrag, tegen: gevraagd, modus: "gevraagd" });
      const dav = a.afrekeningDavid.filter((x) => Number(x.jaar) === J);
      const kd = som(dav, (x) => x.kosten);
      const davPerP = {}; for (const h of [...vooraf, ...aanv]) if (h.praktijk_id) davPerP[h.praktijk_id] = (davPerP[h.praktijk_id] || 0) + Number(h.bedrag);
      afr = r.ok ? {
        ok: true, kosten: kosten.bedrag, kosten_status: kosten.status,
        rijen: r.rijen.map((x) => {
          const d = dav.find((y) => y.praktijk_id === x.praktijk_id);
          return {
            praktijk_id: x.praktijk_id, aandeel_model: x.aandeel, aandeel_david: d && kd > 0 ? Number(d.kosten) / kd : null,
            kosten_model: x.kosten, kosten_david: d ? rond2(d.kosten) : null, gevraagd_model: x.al_voldaan, gevraagd_david: davPerP[x.praktijk_id] != null ? rond2(davPerP[x.praktijk_id]) : null,
            betaald_david: d ? rond2(d.betaald) : null, uitkomst_model: x.uitkomst, uitkomst_david: d ? rond2(d.saldo) : null,
          };
        }),
        totaal: { uitkomst_model: r.totaal.uitkomst, uitkomst_david: dav.length ? rond2(som(dav, (x) => x.saldo)) : null, betaald_david: dav.length ? rond2(som(dav, (x) => x.betaald)) : null },
      } : { ok: false, reden: r.reden, ontbreekt: r.ontbreekt };
    }

    const j = {
      jaar: J, entiteit: E,
      begroting: { vooraf: B, vooraf_maanden: voorafMnd.map(rond2), aanvullingen, gevraagd: gevraagdDavid, kosten: kosten ? kosten.bedrag : null, kosten_status: kosten ? kosten.status : null,
        verschil: kosten ? rond2(kosten.bedrag - B) : null, verschil_na_aanvulling: kosten ? rond2(kosten.bedrag - gevraagdDavid) : null,
        januari_extra: mediaan > 0 && voorafMnd[0] - mediaan > 0.02 * B ? rond2(voorafMnd[0] - mediaan) : 0 },
      model: { ok: patroon.ok, reden: patroon.ok ? null : patroon.reden, maanden: modelMnd.map(rond2), buffer_maanden: bufferMnd.map(rond2), buffer_totaal: rond2(som(bufferMnd)),
        jaar: rond2(som(modelMnd)), aanvullingen: rond2(som(aanvullingen, (x) => x.bedrag)),
        afrekening_vorig: afrVorig ? { jaar: J - 1, datum: afrVorig.datum, uitkomst: afrVorig.ok ? rond2(afrVorig.uitkomst) : null, reden: afrVorig.reden || null } : null,
        afrekening_vorig_zonder: afrVorigZonder && afrVorigZonder.ok ? rond2(afrVorigZonder.uitkomst) : null },
      bijdragen_echt: { totaal: rond2(som(bijdragenEcht, (b) => b.bedrag)), maanden: Array.from({ length: 12 }, (_, i) => rond2(som(bijdragenEcht.filter((b) => Number(b.datum.slice(5, 7)) === i + 1), (b) => b.bedrag))) },
      saldo: { echt: ksEcht, model: ksModel, zonder_aanvulling: ksZonder, laatste_post: laatstePost, volledig, vangnet: a.vangnet || "P07" },
      afrekening: afr,
    };
    j.spaak = spaakpunten(j, a);
    jaren.push(j);
    saldoEcht = ksEcht.eind; saldoModel = ksModel.eind; saldoZonder = ksZonder.eind;
    vorig = patroon.ok ? gevraagd : null; vorigZonder = patroon.ok ? gevraagdZonder : null;
  }
  return { entiteit: E, van: a.van, tot: a.tot, startsaldo: Number(a.startsaldo), startbron: a.startbron || null, buffer: a.buffer, jaren };
}

function rekenAfr(a, E, jaar, tegen, datum) {
  const k = kostenJaar(a.jaarlasten, E, jaar);
  if (!k) return { ok: false, datum: null, uitkomst: 0, reden: `kosten ${jaar} nog niet bekend` };
  const r = afrekening({ aandelen: aandelenAfrekening({ entiteit: E, jaar, standen: a.standen, deelnames: a.deelnames }), kosten: k.bedrag, tegen, modus: "gevraagd" });
  return r.ok ? { ok: true, datum, uitkomst: r.totaal.uitkomst } : { ok: false, datum: null, uitkomst: 0, reden: r.reden };
}
/** Saldo zoals de bank het telt: per dag het netto-bedrag (wat er op één dag in- en uitgaat, telt samen). */
export function perDag(stromen) {
  const m = new Map();
  for (const x of stromen) m.set(x.datum, (m.get(x.datum) || 0) + Number(x.bedrag));
  return [...m].map(([datum, bedrag]) => ({ datum, bedrag }));
}

/**
 * Saldo per dag zoals de bank het telt (alles van één dag samen), met per maand de laagste stand en het eindsaldo.
 * vangnet: zakt het saldo onder nul, dan stort het vangnet (Tolgaarde) op die dag precies het tekort (extra bijdrage), zodat het
 * saldo nul is; `bijspring` = het totaal van dat jaar, per maand ook. Zonder vangnet: de laagste stand mag negatief zijn.
 */
export function kasDag({ jaar, startsaldo, stromen, vangnet = false }) {
  const dagen = perDag(stromen.filter((x) => x.datum.startsWith(String(jaar)))).sort((x, y) => (x.datum < y.datum ? -1 : 1));
  let saldo = Number(startsaldo), bij = 0;
  const maanden = Array.from({ length: 12 }, (_, i) => ({ maand: i + 1, laagste: null, laagste_op: null, eind: null, bijspring: 0 }));
  const stortingen = [];
  let d = 0;
  for (const M of maanden) {
    M.laagste = saldo; M.laagste_op = `${jaar}-${p2(M.maand)}-01`;
    for (; d < dagen.length && Number(dagen[d].datum.slice(5, 7)) === M.maand; d++) {
      saldo += dagen[d].bedrag;
      if (saldo < M.laagste) { M.laagste = saldo; M.laagste_op = dagen[d].datum; }
      if (vangnet && saldo < -0.004) { M.bijspring += -saldo; bij += -saldo; stortingen.push({ datum: dagen[d].datum, bedrag: rond2(-saldo) }); saldo = 0; }
    }
    M.eind = saldo;
  }
  for (const M of maanden) { M.laagste = rond2(M.laagste); M.eind = rond2(M.eind); M.bijspring = rond2(M.bijspring); }
  const l = maanden.reduce((x, y) => (y.laagste < x.laagste ? y : x));
  return { start: rond2(startsaldo), eind: rond2(saldo), laagste: l.laagste, laagste_op: l.laagste_op, maanden, bijspring: rond2(bij), stortingen };
}

/** Waar loopt het op spaak? Gewone zinnen, met het bedrag; soort = begroting | kas | sleutel | betaling | deelname | afrekening. */
export function spaakpunten(j, a) {
  const uit = [];
  const b = j.begroting;
  if (b.kosten != null && b.vooraf > 0 && b.kosten > b.vooraf * 1.03) {
    uit.push({ soort: "begroting", ernst: b.kosten > b.vooraf * 1.08 ? "hoog" : "midden",
      tekst: `Begroting vooraf ${euro(b.vooraf, { heel: true })}, kosten ${euro(b.kosten, { heel: true })}: ${Math.round((b.kosten / b.vooraf - 1) * 100)} % te krap (${euro(b.kosten - b.vooraf, { heel: true })}).` +
        (b.aanvullingen.length ? ` David vroeg tussentijds ${euro(b.aanvullingen.reduce((s, x) => s + x.bedrag, 0), { heel: true })} extra.` : "") });
  } else if (b.kosten != null && b.vooraf > 0 && b.kosten < b.vooraf * 0.95) {
    uit.push({ soort: "begroting", ernst: "laag", tekst: `Begroting vooraf ${euro(b.vooraf, { heel: true })} ruim boven de kosten ${euro(b.kosten, { heel: true })} (${euro(b.vooraf - b.kosten, { heel: true })} terug in de afrekening).` });
  }
  const m = j.saldo.model, mz = j.saldo.zonder_aanvulling;
  const mnd = (x) => MAANDEN[x - 1];
  const bijMaanden = (k) => k.maanden.filter((x) => x.bijspring > 0.5).map((x) => mnd(x.maand));
  if (j.model.ok && m.bijspring > 0.5) {
    uit.push({ soort: "kas", ernst: m.bijspring > 10000 ? "hoog" : "midden",
      tekst: `De buffer volstond niet: Tolgaarde had ${euro(m.bijspring, { heel: true })} moeten bijspringen (${bijMaanden(m).join(", ")}); de afrekening van ${j.jaar} verrekent dat weer.` });
  }
  if (j.model.ok && b.aanvullingen.some((x) => x.bedrag > 0)) {
    const extra = rond2(mz.bijspring - m.bijspring);
    uit.push({ soort: "aanvulling", ernst: extra > 10000 ? "midden" : "laag",
      tekst: extra > 0.5
        ? `Zonder Davids aanvulling(en) van ${euro(b.aanvullingen.reduce((s, x) => s + x.bedrag, 0), { heel: true })} had Tolgaarde in het model ${euro(mz.bijspring, { heel: true })} moeten bijspringen (${bijMaanden(mz).join(", ")}). Het model voorkomt de aanvulling dus niet: het vervangt hem door een herziening (R9) of door Tolgaarde.`
        : `Zonder Davids aanvulling(en) was het model rond gekomen met de buffer${mz.bijspring > 0.5 ? " en Tolgaarde" : ""}: het tekort was ook in de afrekening te vangen geweest.` });
  }
  if (j.afrekening && j.afrekening.ok) {
    const afw = j.afrekening.rijen.filter((x) => x.aandeel_david != null && Math.abs(x.aandeel_david - x.aandeel_model) > 0.0005);
    if (afw.length) {
      const grootst = afw.reduce((p, x) => (Math.abs(x.kosten_model - x.kosten_david) > Math.abs(p.kosten_model - p.kosten_david) ? x : p));
      uit.push({ soort: "sleutel", ernst: "hoog", praktijk_id: grootst.praktijk_id,
        tekst: `Davids eindafrekening verdeelt de kosten met een andere sleutel dan (1-1-${j.jaar} + 1-1-${j.jaar + 1}) ÷ 2 bij ${afw.length} praktijk(en); grootste verschil ${euro(grootst.kosten_model - grootst.kosten_david, { heel: true })} (${grootst.praktijk_id}).` });
    }
    const nietBetaald = j.afrekening.rijen.filter((x) => x.gevraagd_david != null && x.betaald_david != null && x.gevraagd_david - x.betaald_david > 500);
    for (const x of nietBetaald) uit.push({ soort: "betaling", ernst: "midden", praktijk_id: x.praktijk_id, tekst: `${x.praktijk_id} betaalde ${euro(x.gevraagd_david - x.betaald_david, { heel: true })} minder dan gevraagd (gevraagd ${euro(x.gevraagd_david, { heel: true })}, betaald ${euro(x.betaald_david, { heel: true })}).` });
    const gr = j.afrekening.totaal.uitkomst_model;
    if (b.kosten && Math.abs(gr) > 0.05 * b.kosten) uit.push({ soort: "afrekening", ernst: "midden", tekst: `Afrekening volgens het model: per saldo ${gr > 0 ? "bijbetalen" : "terug"} ${euro(gr, { heel: true })} (${Math.round(Math.abs(gr) / b.kosten * 100)} % van de kosten).` });
  }
  // deelname: praktijk betaalde dat jaar echt bijdragen, maar doet volgens de deelname alleen mee aan de afrekening
  const bijdrageDeelnemers = new Set(aandelenBijdrage({ entiteit: j.entiteit, jaar: j.jaar, standen: a.standen, deelnames: a.deelnames }).rijen.map((r) => r.praktijk_id));
  const betalers = new Map();
  for (const x of a.bank) if (x.datum.startsWith(String(j.jaar)) && (x.soort === "voorschot" || x.soort === "huur") && x.praktijk_id) betalers.set(x.praktijk_id, (betalers.get(x.praktijk_id) || 0) + Number(x.bedrag));
  for (const [p, bedrag] of betalers) if (bedrag > 100 && !bijdrageDeelnemers.has(p)) uit.push({ soort: "deelname", ernst: "midden", praktijk_id: p, tekst: `${p} betaalde in ${j.jaar} ${euro(bedrag, { heel: true })} aan bijdragen, maar doet volgens de deelname-instelling alleen mee aan de afrekening: het model vraagt die praktijk geen maandbijdragen.` });
  return uit;
}
