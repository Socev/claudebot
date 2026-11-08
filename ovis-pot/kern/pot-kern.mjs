// OVIS POT — rekenkern (ontwerp § 4: R1–R4, R10, R11, plus de betaalmonitor 2026).
// PUUR: geen netwerk, geen klok, geen opslag. Alles wat de kern nodig heeft komt als gewone gegevens binnen; de app (browser), de
// Functions (Cloudflare) en de pod (Node) gebruiken precies deze module, zodat er één rekenwijze is.
//
// Woorden (David 8-11-2026): POT en Kostenmaatschap vragen een BIJDRAGE (bijdragenota), de SLOEL rekent DOORBELASTE HUUR door
// (nota doorbelaste huur). Nooit "factuur", geen btw: de constructie is een kostendeling, geen verkoop van een dienst.
// Bedragen in woorden, nooit met een min-teken: "bijbetalen € x" of "u krijgt € x terug".

export const ENTITEITEN = /** @type {const} */ (["POT", "KM", "SLOEL"]);

/** Naam van het stuk per entiteit (zichtbaar op schermen, pdf's en mails). */
export function stukNaam(entiteit) {
  return entiteit === "SLOEL" ? "nota doorbelaste huur" : "bijdragenota";
}
/** Wat een praktijk aan een entiteit betaalt, als zelfstandig naamwoord. */
export function betalingNaam(entiteit) {
  return entiteit === "SLOEL" ? "doorbelaste huur" : "bijdrage";
}
export function entiteitNaam(entiteit) {
  return { POT: "POT POH-GGZ", KM: "Kostenmaatschap POH-GGZ", SLOEL: "Stichting Leusden op één Lijn" }[entiteit] || entiteit;
}

// ---------- hulp ----------
export const rond2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const isDatum = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const jan1 = (jaar) => `${jaar}-01-01`;

/** Euro in Nederlandse notatie zonder teken: 1234.5 → "€ 1.234,50". */
export function euro(x, { heel = false } = {}) {
  const v = Math.abs(Number(x) || 0);
  const s = v.toLocaleString("nl-NL", { minimumFractionDigits: heel ? 0 : 2, maximumFractionDigits: heel ? 0 : 2 });
  return `€ ${s}`;
}

/**
 * R3 in woorden. uitkomst > 0: de praktijk moet bijbetalen; < 0: de praktijk krijgt terug. Nooit een min-teken.
 * @param {number} uitkomst
 */
export function uitkomstInWoorden(uitkomst) {
  const u = rond2(uitkomst);
  if (Math.abs(u) < 0.005) return "precies goed, niets bij te betalen of terug";
  return u > 0 ? `bijbetalen ${euro(u)}` : `u krijgt ${euro(u)} terug`;
}

// ---------- deelname ----------
/**
 * Hoeveel maanden van jaar J valt binnen een of meer deelnameperiodes (van/tot inclusief, tot null = open)?
 * Een maand telt als de deelname op de 1e van die maand loopt (de afspraak: in- en uittreden per de 1e).
 * @param {{geldig_van?: string|null, geldig_tot?: string|null}[]} perioden
 * @param {number} jaar
 */
export function maandenDeelname(perioden, jaar) {
  let n = 0;
  for (let m = 1; m <= 12; m++) {
    const d = `${jaar}-${String(m).padStart(2, "0")}-01`;
    if (perioden.some((p) => (!p.geldig_van || p.geldig_van <= d) && (!p.geldig_tot || p.geldig_tot >= d))) n++;
  }
  return n;
}

/**
 * Deelnemers van een entiteit in jaar J, met het aantal maanden.
 * @param {{entiteit:string, praktijk_id:string, geldig_van?:string|null, geldig_tot?:string|null}[]} deelnames
 */
export function deelnemers(deelnames, entiteit, jaar, soort = null) {
  const per = new Map();
  for (const d of deelnames) {
    if (d.entiteit !== entiteit) continue;
    // deelname-regel per soort (wv2761): 'beide' (standaard), alleen 'bijdrage' of alleen 'afrekening' (bijv. een praktijk die bij
    // de KM geen maandbijdragen betaalt maar wel het volle aandeel in de afrekening). Zonder soort telt elke deelname.
    if (soort && d.geldt_voor && d.geldt_voor !== "beide" && d.geldt_voor !== soort) continue;
    if (!per.has(d.praktijk_id)) per.set(d.praktijk_id, []);
    per.get(d.praktijk_id).push(d);
  }
  const uit = [];
  for (const [praktijk_id, perioden] of per) {
    const maanden = maandenDeelname(perioden, jaar);
    const masker = Array.from({ length: 12 }, (_, i) => perioden.some((p) => {
      const d = `${jaar}-${String(i + 1).padStart(2, "0")}-01`;
      return (!p.geldig_van || p.geldig_van <= d) && (!p.geldig_tot || p.geldig_tot >= d);
    }));
    if (maanden > 0) uit.push({ praktijk_id, maanden, masker });
  }
  return uit.sort((a, b) => (a.praktijk_id < b.praktijk_id ? -1 : 1));
}

/** Patiëntenstand van een praktijk op een peildatum (exact; geen stille benadering). */
export function stand(standen, praktijk_id, peildatum) {
  const r = standen.find((s) => s.praktijk_id === praktijk_id && s.peildatum === peildatum);
  return r && Number.isFinite(Number(r.aantal)) ? Number(r.aantal) : null;
}

// ---------- R1 en R4: aandelen ----------
/**
 * R1 — aandeel in de afrekening van jaar J: gem = (stand 1-1-J + stand 1-1-(J+1)) / 2, × maanden/12 bij een deel van het jaar.
 * Ontbreekt een stand, dan staat de praktijk in `ontbreekt` en is de uitkomst niet bruikbaar (ok=false): nooit stil 0.
 */
export function aandelenAfrekening({ entiteit, jaar, standen, deelnames }) {
  const lijst = deelnemers(deelnames, entiteit, jaar, "afrekening");
  const ontbreekt = [];
  const rijen = lijst.map(({ praktijk_id, maanden }) => {
    const begin = stand(standen, praktijk_id, jan1(jaar));
    const eind = stand(standen, praktijk_id, jan1(jaar + 1));
    if (begin == null) ontbreekt.push({ praktijk_id, peildatum: jan1(jaar) });
    if (eind == null) ontbreekt.push({ praktijk_id, peildatum: jan1(jaar + 1) });
    const gem = begin != null && eind != null ? (begin + eind) / 2 : null;
    const factor = maanden / 12;
    return { praktijk_id, maanden, stand_begin: begin, stand_eind: eind, gemiddeld: gem, factor, grondslag: gem == null ? null : gem * factor };
  });
  return verdeel(rijen, ontbreekt, {
    regel: "R1",
    uitleg: `aandeel = (patiënten 1-1-${jaar} + patiënten 1-1-${jaar + 1}) ÷ 2, gedeeld door de som van alle deelnemers` +
      (rijen.some((r) => r.maanden < 12) ? "; wie een deel van het jaar meedeed telt voor maanden ÷ 12" : ""),
  });
}

/** R4 — aandeel in de bijdragen van jaar J: stand 1-1-J ÷ de som (bij een deel van het jaar × maanden/12). */
export function aandelenBijdrage({ entiteit, jaar, standen, deelnames }) {
  const lijst = deelnemers(deelnames, entiteit, jaar, "bijdrage");
  const ontbreekt = [];
  const rijen = lijst.map(({ praktijk_id, maanden, masker }) => {
    const s = stand(standen, praktijk_id, jan1(jaar));
    if (s == null) ontbreekt.push({ praktijk_id, peildatum: jan1(jaar) });
    const factor = maanden / 12;
    return { praktijk_id, maanden, masker, stand_begin: s, stand_eind: null, gemiddeld: s, factor, grondslag: s == null ? null : s * factor };
  });
  return verdeel(rijen, ontbreekt, { regel: "R4", uitleg: `aandeel = patiënten 1-1-${jaar} ÷ de som van alle deelnemers op 1-1-${jaar}` });
}

function verdeel(rijen, ontbreekt, meta) {
  const som = rijen.reduce((s, r) => s + (r.grondslag || 0), 0);
  const ok = ontbreekt.length === 0 && som > 0;
  return {
    ok, ontbreekt, noemer: som, ...meta,
    rijen: rijen.map((r) => ({ ...r, aandeel: ok ? r.grondslag / som : null })),
  };
}

// ---------- R2 kosten ----------
/**
 * R2 — kosten van een entiteit over jaar J. Definitief = jaarrekening; voorlopig = de kostenstand van de boekhouding (Acta), met de
 * bank alleen als controle. De kern kiest: definitief boven voorlopig; geeft ook terug welke het is.
 * @param {{entiteit:string, jaar:number, bedrag:number, bron?:string, status?:string}[]} jaarlasten
 */
export function kostenJaar(jaarlasten, entiteit, jaar) {
  const kand = jaarlasten.filter((j) => j.entiteit === entiteit && Number(j.jaar) === Number(jaar));
  if (!kand.length) return null;
  const rang = (j) => (j.status === "definitief" || j.bron === "jaarrekening" ? 2 : j.bron === "excel-bron" ? 1 : 0);
  const k = kand.slice().sort((a, b) => rang(b) - rang(a))[0];
  return { bedrag: Number(k.bedrag), bron: k.bron || null, status: rang(k) === 2 ? "definitief" : rang(k) === 1 ? "vastgesteld (Excel)" : "voorlopig" };
}

// ---------- R3 afrekening ----------
/**
 * R3 — afrekening jaar J per praktijk: uitkomst = aandeel × kosten − Σ gevraagd (vastgestelde nota's van J, zonder buffer).
 * Overgangsjaren (t/m 2026, POT en KM hadden geen nota's): modus "betaald" — rekenen tegen wat er via de bank binnenkwam.
 * @param {{ aandelen: ReturnType<typeof aandelenAfrekening>, kosten: number, tegen: Record<string, number>, modus: "gevraagd"|"betaald" }} a
 */
export function afrekening({ aandelen, kosten, tegen, modus = "gevraagd" }) {
  if (!aandelen.ok) return { ok: false, reden: "patiëntenstand ontbreekt", ontbreekt: aandelen.ontbreekt, rijen: [] };
  const rijen = aandelen.rijen.map((r) => {
    const toegerekend = rond2(kosten * r.aandeel);
    const al = rond2(tegen[r.praktijk_id] || 0);
    const uitkomst = rond2(toegerekend - al);
    return {
      praktijk_id: r.praktijk_id, aandeel: r.aandeel, gemiddeld: r.gemiddeld, stand_begin: r.stand_begin, stand_eind: r.stand_eind,
      kosten: toegerekend, al_voldaan: al, uitkomst, in_woorden: uitkomstInWoorden(uitkomst),
      hoe: `${euro(kosten)} × ${(r.aandeel * 100).toFixed(3).replace(".", ",")} % = ${euro(toegerekend)}; ` +
        `${modus === "betaald" ? "betaald via de bank" : "gevraagd met vastgestelde nota's"} ${euro(al)}; ` +
        `${uitkomstInWoorden(uitkomst)}`,
    };
  });
  const som = (k) => rond2(rijen.reduce((s, r) => s + r[k], 0));
  return {
    ok: true, modus, kosten: rond2(kosten), rijen,
    totaal: { kosten: som("kosten"), al_voldaan: som("al_voldaan"), uitkomst: som("uitkomst") },
    afronding: rond2(som("kosten") - kosten),   // centen door afronden per praktijk; zichtbaar, niet weggepoetst
  };
}

/**
 * Modus per entiteit/jaar (ontwerp R3 + § 0): tegen wat met vastgestelde nota's gevraagd is zodra die er voor dat jaar zijn
 * (de SLOEL al sinds 2025); alleen een jaar t/m 2026 zonder nota's (POT en KM, SLOEL vóór 2025) rekent tegen wat er betaald is.
 */
export function afrekenModus(jaar, { heeftNotas = false } = {}) {
  if (heeftNotas) return "gevraagd";
  return Number(jaar) <= 2026 ? "betaald" : "gevraagd";
}

// ---------- R10 debiteur ----------
/**
 * R10 — de debiteur zoals die op `datum` gold, uit de versies van de praktijk (nieuwste geldig_van ≤ datum).
 * Een nota legt deze momentopname vast en verandert daarna niet.
 * @param {{id?:number, praktijk_id:string, geldig_van:string, houder?:string, naam:string, tav?:string, adres?:string, postcode_plaats?:string, email?:string, kvk?:string}[]} versies
 */
export function debiteurOp(versies, praktijk_id, datum) {
  if (!isDatum(datum)) throw new Error("datum moet JJJJ-MM-DD zijn");
  const v = versies.filter((x) => x.praktijk_id === praktijk_id && x.geldig_van <= datum)
    .sort((a, b) => (a.geldig_van < b.geldig_van ? 1 : -1))[0];
  if (!v) return null;
  return {
    praktijk_id, versie_id: v.id ?? null, geldig_van: v.geldig_van, houder: v.houder || null, naam: v.naam,
    tav: v.tav || null, adres: v.adres || null, postcode_plaats: v.postcode_plaats || null, email: v.email || null, kvk: v.kvk || null,
  };
}

// ---------- R11 nummering ----------
/** R11 — volgend nummer JJJJnnn per entiteit; het nummer is ook het betalingskenmerk. */
export function volgendNummer(bestaande, jaar) {
  const pre = String(jaar);
  let max = 0;
  for (const n of bestaande) {
    const s = String(n);
    if (s.length === 7 && s.startsWith(pre)) max = Math.max(max, Number(s.slice(4)));
  }
  if (max >= 999) throw new Error(`nummerreeks ${jaar} is vol`);
  return pre + String(max + 1).padStart(3, "0");
}

// ---------- betaalmonitor (§ 0: 2026 eerst monitoren) ----------
/** Dagnummer van een JJJJ-MM-DD-datum (proleptisch Gregoriaans), zonder Date: alleen voor verschillen in dagen. */
export function dagnr(d) {
  let y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  const dd = Number(d.slice(8, 10));
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + dd - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
}
/** Datum + n dagen (JJJJ-MM-DD), zonder Date. */
export function plusDagen(d, n) {
  const z = dagnr(d) + n;   // terug van dagnummer naar datum (algoritme van H. Hinnant)
  const era = Math.floor(z / 146097), doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const dd = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * Wat er per praktijk per termijn verwacht werd tegen wat de bank laat zien.
 * Toewijzen in twee stappen: (1) een betaling binnen het venster van een termijn (vanaf `venster` dagen vóór tot `coulance` dagen na
 * de vervaldag) gaat naar die termijn, het best passende bedrag eerst; (2) wat overblijft vult de oudste open termijn (inhalen), en
 * daarna pas latere termijnen (vooruit). Per termijn: betaald (uiterlijk vervaldag + coulance) / betaald (later) / deels / te laat /
 * nog niet aan de beurt; plus 'afwijkend bedrag' als een betaling niet gelijk is aan het termijnbedrag (> marge).
 * peildatum komt van buiten (geen klok): neem de laatste dag waarvoor de bank compleet is, anders heet iets te snel te laat.
 * @param {{ termijnen: {sleutel:string, vervaldag:string, bedrag:number, bron?:string}[], betalingen: {datum:string, bedrag:number, id?:any}[], peildatum: string, marge?: number, venster?: number, coulance?: number }} a
 */
export function betaalstatus({ termijnen, betalingen, peildatum, marge = 1, venster = 14, coulance = 16 }) {
  const t = termijnen.slice().sort((a, b) => (a.vervaldag < b.vervaldag ? -1 : a.vervaldag > b.vervaldag ? 1 : 0))
    .map((x) => ({ ...x, bedrag: rond2(x.bedrag), voldaan: 0, betalingen: [] }));
  // Terugboekingen (negatief) halen eerst geld weg bij de laatste betaling(en) daarvóór (anders de eerstvolgende); zo rekent
  // de toewijzing met dezelfde nettobedragen als de totalen. Een terugboeking zonder betaling om tegen weg te strepen blijft zichtbaar.
  const ord = (a, c) => (a.datum < c.datum ? -1 : a.datum > c.datum ? 1 : 0);
  const b = betalingen.filter((x) => Number(x.bedrag) > 0).slice().sort(ord).map((x) => ({ ...x, bedrag: rond2(x.bedrag), rest: rond2(x.bedrag) }));
  let onverrekend = 0;
  for (const n of betalingen.filter((x) => Number(x.bedrag) < 0).slice().sort(ord)) {
    let weg = rond2(-n.bedrag);
    const volgorde = [...b.filter((p) => p.datum <= n.datum).reverse(), ...b.filter((p) => p.datum > n.datum)];
    for (const p of volgorde) {
      if (weg <= 0.004) break;
      const d = Math.min(p.rest, weg);
      p.rest = rond2(p.rest - d); p.bedrag = rond2(p.bedrag - d); weg = rond2(weg - d);
    }
    onverrekend = rond2(onverrekend + weg);
  }
  // een termijn waar nog hooguit `marge` op openstaat is voldaan (centen-afronding): die krijgt niets meer, anders stapelen de centen
  // van inhaalbetalingen op tot een onterechte 'deels' verderop
  const wijs = (x, p) => {
    if (rond2(x.bedrag - x.voldaan) <= marge) return;
    const deel = rond2(Math.min(rond2(x.bedrag - x.voldaan), p.rest));
    if (deel <= 0.004) return;
    x.voldaan = rond2(x.voldaan + deel);
    p.rest = rond2(p.rest - deel);
    x.betalingen.push({ datum: p.datum, bedrag: p.bedrag, deel, id: p.id ?? null });
  };
  // 0 (fase 3, wv2762) eerst wat vaststaat: een koppeling die David met de hand legde (betaling-id ↔ nummer, bedrag), daarna het
  // betalingskenmerk: een betaling die precies één nummer van deze termijnen noemt, gaat eerst naar die termijn. Was die termijn al
  // voldaan vóór deze betaling, dan is het een dubbele betaling: die blijft als 'dubbel betaald' zichtbaar (nooit stil verrekend;
  // Davids besluit 13-10-2026: dubbel betaald = apart terugstorten).
  const opNummer = new Map(t.filter((x) => x.nummer).map((x) => [String(x.nummer), x]));
  for (const p of b) {
    for (const k of Array.isArray(p.koppel) ? p.koppel : []) {
      const x = opNummer.get(String(k.nummer));
      if (!x || p.rest <= 0.004) continue;
      const gevraagd = rond2(Math.min(Number(k.bedrag) || p.rest, p.rest));
      const deel = rond2(Math.min(gevraagd, Math.max(0, rond2(x.bedrag - x.voldaan))));
      // meer gekoppeld dan er op de nota open staat: het verschil blijft bij deze betaling als 'te veel' (niet stil naar een andere nota; Codex r1 M2)
      if (gevraagd - deel > marge) p.te_veel = String(k.nummer);
      if (deel <= 0.004) continue;
      x.voldaan = rond2(x.voldaan + deel); p.rest = rond2(p.rest - deel);
      x.betalingen.push({ datum: p.datum, bedrag: p.bedrag, deel, id: p.id ?? null, hoe: "met de hand gekoppeld" });
    }
  }
  for (const p of b) {
    if (p.rest <= 0.004 || p.te_veel) continue;
    const ken = [...new Set((Array.isArray(p.kenmerken) ? p.kenmerken : []).map(String))].filter((k) => opNummer.has(k));
    if (ken.length !== 1) continue;
    const x = opNummer.get(ken[0]);
    if (rond2(x.bedrag - x.voldaan) <= marge) { p.dubbel = ken[0]; continue; }
    const voor = x.betalingen.length;
    wijs(x, p);
    if (x.betalingen.length > voor) x.betalingen[x.betalingen.length - 1].hoe = "op kenmerk";
    if (p.rest > marge && rond2(x.bedrag - x.voldaan) <= marge) p.te_veel = ken[0];
  }
  // 1 binnen het venster van de termijn
  for (const x of t) {
    const van = dagnr(x.vervaldag) - venster, tot = dagnr(x.vervaldag) + coulance;
    for (;;) {
      const open = rond2(x.bedrag - x.voldaan);
      if (open <= marge) break;
      const kand = b.filter((p) => p.rest > 0.004 && !p.dubbel && !p.te_veel && dagnr(p.datum) >= van && dagnr(p.datum) <= tot)
        .sort((p, q) => Math.abs(p.rest - open) - Math.abs(q.rest - open) || (p.datum < q.datum ? -1 : 1));
      if (!kand.length) break;
      wijs(x, kand[0]);
    }
  }
  // 2 inhalen: de rest naar de oudste open termijn
  // (een rest tot `marge` is afronding: die schuift niet door naar een volgende termijn)
  // (een dubbele of te hoge betaling op kenmerk blijft staan: zichtbaar, niet stil verrekend met een andere nota)
  for (const p of b) for (const x of t) { if (p.rest <= marge || p.dubbel || p.te_veel) break; wijs(x, p); }
  const over = rond2(b.reduce((s, p) => s + (p.rest > marge ? p.rest : 0), 0));
  const uit = t.map((x) => {
    const open = rond2(x.bedrag - x.voldaan);
    const laatste = x.betalingen.reduce((m, p) => (p.datum > m ? p.datum : m), "");
    const grens = plusDagen(x.vervaldag, coulance);
    const verlopen = grens < peildatum;
    let status;
    if (open <= marge) status = laatste > grens ? "betaald (later)" : "betaald";   // een euro afronding is geen 'deels'
    else if (x.voldaan > 0) status = verlopen ? "deels" : "deels (nog niet aan de beurt)";
    else status = verlopen ? "te laat" : "nog niet aan de beurt";
    // afwijkend: een betaling die deze termijn (mede) dekt is niet gelijk aan het termijnbedrag (verzamelbetaling, ander bedrag)
    const afwijkend = x.betalingen.some((p) => Math.abs(p.bedrag - x.bedrag) > marge);
    return { sleutel: x.sleutel, vervaldag: x.vervaldag, bedrag: x.bedrag, voldaan: x.voldaan, open, status, afwijkend_bedrag: afwijkend, bron: x.bron || null, betalingen: x.betalingen };
  });
  // verwacht tot nu = alles met een vervaldag tot en met de peildatum (zelfde grens als de betalingen die meetellen)
  const verwachtTotNu = rond2(uit.filter((x) => x.vervaldag <= peildatum).reduce((s, x) => s + x.bedrag, 0));
  const betaaldTotaal = rond2(betalingen.reduce((s, x) => s + Number(x.bedrag), 0));
  return {
    termijnen: uit, vooruit_of_te_veel: over, terugboeking_onverrekend: onverrekend,
    // wat over blijft na toewijzing; met een reden als het kenmerk het zegt (dubbel betaald, of meer dan de nota)
    overschot: b.filter((p) => p.rest > marge).map((p) => ({ datum: p.datum, bedrag: p.rest, id: p.id ?? null,
      reden: p.dubbel ? `dubbel betaald (nota ${p.dubbel} was al voldaan)` : p.te_veel ? `meer betaald dan nota ${p.te_veel}` : null })),
    samen: {
      verwacht_tot_nu: verwachtTotNu, betaald: betaaldTotaal,
      achter: rond2(Math.max(0, verwachtTotNu - betaaldTotaal)),
      te_laat: uit.filter((x) => x.status === "te laat" || x.status === "deels").length,
      // achter = wat er op verlopen termijnen (na de coulance) nog openstaat, na toewijzing; een rest tot `marge` is afronding (Codex r2 M1)
      achter_verlopen: rond2(uit.filter((x) => plusDagen(x.vervaldag, coulance) < peildatum && x.open > marge).reduce((s, x) => s + x.open, 0)),
    },
  };
}

/**
 * Reconstructie van de verwachte termijnen voor een jaar zonder nota's (POT/KM 2026, tot Davids stukken er zijn): het meest
 * voorkomende maandbedrag per praktijk uit de bank, twaalf termijnen met vervaldag de 15e. Duidelijk een reconstructie.
 * @param {{datum:string, bedrag:number}[]} betalingen
 */
export function reconstrueerMaandtermijnen(betalingen, jaar, { betaaldag = 15 } = {}) {
  const tel = new Map();
  for (const p of betalingen) {
    const v = rond2(p.bedrag);
    if (v > 0) tel.set(v, (tel.get(v) || 0) + 1);
  }
  if (!tel.size) return [];
  const [modus] = [...tel.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  return Array.from({ length: 12 }, (_, i) => ({
    sleutel: `${jaar}-${String(i + 1).padStart(2, "0")}`,
    vervaldag: `${jaar}-${String(i + 1).padStart(2, "0")}-${String(betaaldag).padStart(2, "0")}`,
    bedrag: modus, bron: "reconstructie",
  }));
}

// =====================================================================================================================
// FASE 2 (wv2761): begroting en jaarronde — R5 personeel, R4 jaarbegroting, R6 maandpatroon, R7 buffer, R8 kasstroom, R9 wijziging,
// nota's (bijdragenota / nota doorbelaste huur) en de overzichten (§ 7). Nog steeds puur: geen netwerk, geen klok.
// =====================================================================================================================
const p2 = (n) => String(n).padStart(2, "0");
const eerste = (jaar, m) => `${jaar}-${p2(m)}-01`;
/** Laatste dag van maand m (1–12) van jaar, als JJJJ-MM-DD. */
export function laatsteDag(jaar, m) {
  return plusDagen(m === 12 ? `${jaar + 1}-01-01` : eerste(jaar, m + 1), -1);
}
export const MAANDEN = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

// ---------- R5 personeel ----------
/**
 * Bruto voltijdsalaris uit de cao-tabellen op een datum: de nieuwste tabel (ingang ≤ datum) voor cao+schaal; een trede boven het
 * maximum van de tabel wordt het maximum (gemeld). Ligt de datum na de laatst bekende tabel, dan telt de aanname (bv. +3 % per 1-7)
 * voor elk jaar waarin die ingangsdag na de laatste tabel en uiterlijk op de datum valt.
 * @param {{cao:string, ingang:string, schaal:string, trede:number, bruto:number, uren_voltijd:number}[]} tabellen
 */
export function caoBruto(tabellen, { cao, schaal, trede, datum, aanname = null }) {
  const eigen = tabellen.filter((t) => t.cao === cao && String(t.schaal) === String(schaal));
  const ingangen = [...new Set(eigen.map((t) => t.ingang))].sort();
  const ing = ingangen.filter((i) => i <= datum).at(-1);
  if (!ing) return null;
  const rij = eigen.filter((t) => t.ingang === ing);
  const max = Math.max(...rij.map((t) => Number(t.trede)));
  const tr = Math.min(Number(trede), max);
  const t = rij.find((x) => Number(x.trede) === tr);
  if (!t) return null;
  let factor = 1;
  const laatste = ingangen.at(-1);
  if (aanname && aanname.pct && aanname.maanddag) {
    for (let y = Number(laatste.slice(0, 4)); y <= Number(datum.slice(0, 4)); y++) {
      const d = `${y}-${aanname.maanddag}`;
      if (d > laatste && d <= datum) factor *= 1 + Number(aanname.pct);
    }
  }
  return { bruto: Number(t.bruto) * factor, uren_voltijd: Number(t.uren_voltijd), ingang: ing, trede: tr, max_trede: max, op_max: Number(trede) > max, aanname_factor: factor };
}

/**
 * Schaal en trede afleiden uit een loonstrook: voltijd = bruto × uren voltijd ÷ uren; de dichtstbijzijnde tabelwaarde (op die datum)
 * wint. Exact = binnen € 1. David bevestigt de uitkomst in de app (een afgeleide trede is een voorstel).
 */
export function tredeUitLoonstrook(tabellen, { cao, schaal = null, bruto, uren, datum }) {
  let best = null;
  const kand = tabellen.filter((t) => t.cao === cao && (schaal == null || String(t.schaal) === String(schaal)));
  for (const sch of [...new Set(kand.map((t) => String(t.schaal)))]) {
    const ing = [...new Set(kand.filter((t) => String(t.schaal) === sch).map((t) => t.ingang))].filter((i) => i <= datum).sort().at(-1);
    if (!ing) continue;
    for (const t of kand.filter((x) => String(x.schaal) === sch && x.ingang === ing)) {
      const voltijd = (Number(bruto) * Number(t.uren_voltijd)) / Number(uren);
      const v = Math.abs(voltijd - Number(t.bruto));
      if (!best || v < best.verschil) best = { schaal: sch, trede: Number(t.trede), ingang: ing, verschil: rond2(v), voltijd: rond2(voltijd) };
    }
  }
  if (best) best.exact = best.verschil < 1;
  return best;
}

/**
 * Werkgeverslasten gemeten op een (maand)loonsom: loonkosten zonder de reserveringen vakantiegeld en eindejaarsuitkering, gedeeld
 * door het bruto, min 1 (sociale lasten, pensioen werkgeversdeel, sociaal fonds, vergoedingen); en de reserveringen als deel van het bruto.
 * @param {{bruto:number, loonkosten:number, res_vakantiegeld:number, res_eindejaar:number}} l
 */
export function werkgeverslastenMeten(l) {
  const b = Number(l.bruto);
  if (!(b > 0)) return null;
  return {
    werkgeverslasten: (Number(l.loonkosten) - Number(l.res_vakantiegeld) - Number(l.res_eindejaar)) / b - 1,
    vakantiegeld_res: Number(l.res_vakantiegeld) / b,
    eindejaar_res: Number(l.res_eindejaar) / b,
  };
}

/** Stand van een contract op de 1e van een maand: actief, uren, schaal, trede (met mutaties en periodieken). */
export function contractOp(c, mutaties, datum, tabellen) {
  const actief = (!c.van || c.van <= datum) && (!c.tot || c.tot >= datum);
  const st = { actief, uren: Number(c.uren), schaal: c.schaal, trede: c.trede == null ? null : Number(c.trede), basis: c.trede_peildatum || c.van };
  for (const m of mutaties.filter((x) => x.contract_id === c.id && x.geldig_van <= datum).sort((a, b) => (a.geldig_van < b.geldig_van ? -1 : 1))) {
    if (m.uren != null) st.uren = Number(m.uren);
    if (m.schaal != null) st.schaal = m.schaal;
    if (m.trede != null) { st.trede = Number(m.trede); st.basis = m.geldig_van; }
  }
  // periodiek: +1 trede op de 1e van de periodiekmaand, na de datum waarop de trede bekend was, tot het maximum van de tabel
  if (st.trede != null && c.periodiekmaand) {
    const pm = p2(c.periodiekmaand);
    let n = 0;
    for (let y = Number(String(st.basis).slice(0, 4)); y <= Number(datum.slice(0, 4)); y++) {
      const d = `${y}-${pm}-01`;
      if (d > st.basis && d <= datum) n++;
    }
    const maxT = Math.max(0, ...tabellen.filter((t) => t.cao === c.cao && String(t.schaal) === String(st.schaal)).map((t) => Number(t.trede)));
    st.trede = Math.min(st.trede + n, maxT || st.trede + n);
  }
  return st;
}

/**
 * R5 — personeelskosten POT per maand van jaar J.
 *   bruto = cao-tabel(schaal, trede, datum) × uren ÷ uren voltijd (× loondoorbetaling bij afwezigheid);
 *   regulier = bruto × (1 + werkgeverslasten);
 *   vakantiegeldpakket (in mei) = Σ bruto juni (J−1) t/m mei J × reservering vakantiegeld (incl. lasten, gemeten);
 *   eindejaarspakket (in december) = Σ bruto januari t/m december J × reservering eindejaar (incl. lasten, gemeten);
 *   verzuimopslag = (regulier + pakketten) × verzuim %; inhuur = uren per week × 52 ÷ 12 × tarief;
 *   uitkering verzuimverzekering = loonkosten tijdens afwezigheid × uitkering %, met vertraging (als min op de kosten).
 * Een contract zonder schaal/trede rekent met zijn vaste bruto (bruto_maand) en staat in de waarschuwingen.
 * @param {{ jaar:number, contracten:any[], mutaties?:any[], afwezigheid?:any[], inhuur?:any[], tabellen:any[], param:any }} a
 */
export function personeelJaar({ jaar, contracten, mutaties = [], afwezigheid = [], inhuur = [], tabellen, param }) {
  const P = { werkgeverslasten: 0, vakantiegeld_res: 0, eindejaar_res: 0, verzuim_pct: 0, cao_aanname_pct: 0, cao_aanname_maanddag: "07-01", ...param };
  const aanname = { pct: Number(P.cao_aanname_pct) || 0, maanddag: P.cao_aanname_maanddag || "07-01" };
  const waarschuwingen = new Set();
  const brutoOp = (c, d) => {
    const st = contractOp(c, mutaties, d, tabellen);
    if (!st.actief) return { bruto: 0, st };
    let b;
    if (st.schaal != null && st.trede != null) {
      const t = caoBruto(tabellen, { cao: c.cao, schaal: st.schaal, trede: st.trede, datum: d, aanname });
      if (!t) { waarschuwingen.add(`${c.naam || c.id}: geen cao-tabel voor schaal ${st.schaal} op ${d}`); return { bruto: 0, st }; }
      if (t.op_max) waarschuwingen.add(`${c.naam || c.id}: trede boven het maximum, gerekend met trede ${t.max_trede}`);
      b = (t.bruto * st.uren) / t.uren_voltijd;
    } else {
      waarschuwingen.add(`${c.naam || c.id}: geen schaal/trede, gerekend met het vaste bruto`);
      b = Number(c.bruto_maand || 0);
    }
    // afwezigheid: loondoorbetaling (standaard 100 %)
    const af = afwezigheid.find((x) => x.contract_id === c.id && x.van <= d && (!x.tot || x.tot >= d));
    if (af && af.loondoorbetaling_pct != null) b *= Number(af.loondoorbetaling_pct);
    return { bruto: b, st, af };
  };
  // bruto per maand: juni J−1 t/m december J (vakantiegeld loopt juni–mei)
  const brutoMaand = (y, m) => contracten.reduce((s, c) => s + brutoOp(c, eerste(y, m)).bruto, 0);
  const vgBasis = [6, 7, 8, 9, 10, 11, 12].reduce((s, m) => s + brutoMaand(jaar - 1, m), 0) + [1, 2, 3, 4, 5].reduce((s, m) => s + brutoMaand(jaar, m), 0);
  const maanden = [];
  for (let m = 1; m <= 12; m++) {
    const d = eerste(jaar, m);
    let bruto = 0;
    const per = [];
    for (const c of contracten) {
      const r = brutoOp(c, d);
      bruto += r.bruto;
      if (r.st.actief) per.push({ id: c.id, schaal: r.st.schaal, trede: r.st.trede, uren: r.st.uren, bruto: rond2(r.bruto) });
    }
    const regulier = bruto * (1 + Number(P.werkgeverslasten));
    const inh = inhuur.filter((x) => x.van <= d && (!x.tot || x.tot >= d)).reduce((s, x) => s + (Number(x.uren_week) * 52 / 12) * Number(x.tarief), 0);
    maanden.push({ maand: m, bruto, regulier, vakantiegeld: 0, eindejaar: 0, verzuim: 0, inhuur: inh, uitkering: 0, contracten: per });
  }
  const brutoJaar = maanden.reduce((s, x) => s + x.bruto, 0);
  const vg = vgBasis * Number(P.vakantiegeld_res);
  const eju = brutoJaar * Number(P.eindejaar_res);
  maanden[4].vakantiegeld = vg;
  maanden[11].eindejaar = eju;
  for (const x of maanden) x.verzuim = (x.regulier + x.vakantiegeld + x.eindejaar) * Number(P.verzuim_pct);
  // uitkering verzuimverzekering, met vertraging (maanden); valt hij na december, dan telt hij niet in dit jaar
  for (const af of afwezigheid) {
    if (!af.uitkering_pct) continue;
    const c = contracten.find((x) => x.id === af.contract_id);
    if (!c) continue;
    for (let m = -11; m <= 12; m++) {   // ook afwezigheid in het jaar ervoor met een uitkering die in dit jaar valt (Codex M9)
      const d = m >= 1 ? eerste(jaar, m) : eerste(jaar - 1, m + 12);
      if (!(af.van <= d && (!af.tot || af.tot >= d))) continue;
      const doel = m + Number(af.vertraging_maanden || 0);
      if (doel > 12 || doel < 1) continue;
      const b = brutoOp(c, d).bruto;
      maanden[doel - 1].uitkering -= b * (1 + Number(P.werkgeverslasten)) * Number(af.uitkering_pct);
    }
  }
  for (const x of maanden) x.totaal = x.regulier + x.vakantiegeld + x.eindejaar + x.verzuim + x.inhuur + x.uitkering;
  const som = (k) => maanden.reduce((s, x) => s + x[k], 0);
  const pct = (x) => `${(Number(x) * 100).toFixed(1).replace(".", ",")} %`;
  return {
    jaar, maanden, waarschuwingen: [...waarschuwingen],
    totaal: som("totaal"), bruto: brutoJaar, regulier: som("regulier"), vakantiegeld_pakket: vg, eindejaar_pakket: eju,
    verzuim: som("verzuim"), inhuur: som("inhuur"), uitkering: som("uitkering"),
    hoe: [
      `bruto per maand = cao-tabel (schaal, trede op de 1e van de maand) × uren ÷ uren voltijd; trede +1 in de periodiekmaand tot het maximum` +
        (aanname.pct ? `; na de laatst bekende tabel cao-aanname +${pct(aanname.pct)} per ${aanname.maanddag.split("-").reverse().join("-")}` : ""),
      `loonkosten = bruto × (1 + ${pct(P.werkgeverslasten)} werkgeverslasten, gemeten op de loonstroken)`,
      `vakantiegeld (in mei) = bruto juni ${jaar - 1} t/m mei ${jaar} (${euro(vgBasis, { heel: true })}) × ${pct(P.vakantiegeld_res)} = ${euro(vg, { heel: true })}`,
      `eindejaarsuitkering (in december) = bruto ${jaar} (${euro(brutoJaar, { heel: true })}) × ${pct(P.eindejaar_res)} = ${euro(eju, { heel: true })}`,
      ...(Number(P.verzuim_pct) ? [`verzuim/vervanging: ${pct(P.verzuim_pct)} van de loonkosten`] : []),
    ],
  };
}

// ---------- R4 jaarbegroting ----------
/** Bedrag van een kostencomponent op een datum (de nieuwste mutatie ≤ datum; null = (nog) niet of gestopt). */
export function componentOp(mutaties, id, datum) {
  const m = mutaties.filter((x) => x.kostencomponent_id === id && x.geldig_van <= datum).sort((a, b) => (a.geldig_van < b.geldig_van ? -1 : 1)).at(-1);
  return m && m.bedrag != null ? Number(m.bedrag) : null;
}

/**
 * R4 — jaarbegroting van een entiteit, maand voor maand: Σ componenten (met hun mutaties per datum) + personeel (R5).
 * Per maand: het maandbedrag op de 1e; per kwartaal: in de eerste maand van het kwartaal; per jaar: een twaalfde per maand.
 * Bestaat er een personeelsberekening, dan vervangt die de componenten van soort 'personeel' (die staan dan als 'vervangen').
 */
export function jaarbegroting({ entiteit, jaar, componenten, mutaties, personeel = null }) {
  const comps = componenten.filter((c) => c.entiteit === entiteit);
  const vervangen = personeel ? comps.filter((c) => c.soort === "personeel") : [];
  const actief = comps.filter((c) => !vervangen.includes(c));
  const regels = actief.map((c) => ({ id: c.id, naam: c.naam, per: c.per, maanden: Array(12).fill(0) }));
  for (let m = 1; m <= 12; m++) {
    const d = eerste(jaar, m);
    actief.forEach((c, i) => {
      if (c.per === "maand") regels[i].maanden[m - 1] = componentOp(mutaties, c.id, d) || 0;
      else if (c.per === "kwartaal") regels[i].maanden[m - 1] = (m - 1) % 3 === 0 ? componentOp(mutaties, c.id, d) || 0 : 0;
      else regels[i].maanden[m - 1] = (componentOp(mutaties, c.id, d) || 0) / 12;
    });
  }
  for (const r of regels) r.jaar = r.maanden.reduce((s, x) => s + x, 0);
  const maanden = Array.from({ length: 12 }, (_, i) => regels.reduce((s, r) => s + r.maanden[i], 0) + (personeel ? personeel.maanden[i].totaal : 0));
  const totaal = maanden.reduce((s, x) => s + x, 0);
  return {
    entiteit, jaar, maanden, totaal, regels,
    personeel: personeel ? { totaal: personeel.totaal, vakantiegeld_pakket: personeel.vakantiegeld_pakket, eindejaar_pakket: personeel.eindejaar_pakket } : null,
    vervangen: vervangen.map((c) => ({ id: c.id, naam: c.naam })),
    vakantiegeld_pakket: personeel ? personeel.vakantiegeld_pakket : 0,
    eindejaar_pakket: personeel ? personeel.eindejaar_pakket : 0,
  };
}

// ---------- R6 maandpatroon ----------
/**
 * Januari zwaarder, februari evenveel lichter (POT; David 8-11-2026, wv2787): januari heeft hoge uitgaven (jaarpremies, loonheffing over
 * de eindejaarsuitkering) die de gewone maandbijdrage niet dekt. Januari + f × jaarbegroting, februari − f × jaarbegroting; het jaar
 * blijft gelijk. f staat in instelling `pot_jan_feb` (fractie, 0,03 = 3 %); zonder instelling de standaard. Geldt vanaf `vanaf`
 * (jaarplannen daarvóór blijven zoals ze waren); het naspelen past dezelfde f op alle jaren toe (de systematiek zoals besloten).
 */
export const JAN_FEB = { standaard: 0.03, vanaf: 2027, max: 0.06 };
/** De f uit de instellingen (lijst {sleutel, waarde} of object), zonder rekening te houden met het jaar; ongeldig of leeg = standaard. */
export function janFebWaarde(instelling) {
  const l = Array.isArray(instelling) ? instelling : Object.entries(instelling || {}).map(([sleutel, waarde]) => ({ sleutel, waarde }));
  const r = l.find((x) => x && x.sleutel === "pot_jan_feb");
  if (!r || r.waarde == null || String(r.waarde).trim() === "") return JAN_FEB.standaard;
  const v = Number(String(r.waarde).replace(",", "."));
  return Number.isFinite(v) && v >= 0 && v <= JAN_FEB.max ? v : JAN_FEB.standaard;
}
/** De f voor de jaarbegroting van jaar J: vóór JAN_FEB.vanaf 0. */
export function janFebFractie(instelling, jaar) {
  return Number(jaar) < JAN_FEB.vanaf ? 0 : janFebWaarde(instelling);
}

/**
 * R6 — maandbedragen per praktijk. POT: gewone maand = (jaar − vakantiegeldpakket − eindejaarspakket) ÷ 12, mei + vakantiegeld,
 * november + eindejaarsuitkering (de bijdrage komt een maand vóór het geld de deur uitgaat); januari + janFeb × jaar en februari
 * evenveel minder (zie JAN_FEB). KM en SLOEL: twaalf gelijke maanden.
 * Per praktijk = aandeel × maandbedrag, afgerond op hele euro's; het afrondingsverschil verdwijnt in de afrekening (zichtbaar).
 * vanafMaand: een praktijk die later instapt betaalt pas vanaf die maand (R1-maanden).
 */
export function maandpatroon({ entiteit, begroting, aandelen, janFeb = 0 }) {
  if (!aandelen.ok) return { ok: false, reden: "patiëntenstand ontbreekt", ontbreekt: aandelen.ontbreekt };
  const pot = entiteit === "POT";
  const vg = pot ? begroting.vakantiegeld_pakket : 0, eju = pot ? begroting.eindejaar_pakket : 0;
  const gewoon = (begroting.totaal - vg - eju) / 12;
  const gevraagdF = pot && Number.isFinite(Number(janFeb)) ? Math.min(JAN_FEB.max, Math.max(0, Number(janFeb))) : 0;
  // februari nooit onder nul (Codex r1 M1): f hooguit gewone maand ÷ jaar; dan zichtbaar begrensd (rekenJaarplan waarschuwt)
  const fMax = begroting.totaal > 0 ? Math.max(0, gewoon / begroting.totaal) : 0;
  const f = Math.min(gevraagdF, fMax), begrensd = gevraagdF > f + 1e-12;
  const jf = f * begroting.totaal;
  const perMaand = Array.from({ length: 12 }, (_, i) => gewoon + (i === 4 ? vg : 0) + (i === 10 ? eju : 0) + (i === 0 ? jf : i === 1 ? -jf : 0));
  const praktijken = aandelen.rijen.map((r) => {
    // alleen in de maanden dat de praktijk meedoet (R1-maanden); dan × 12 ÷ aantal maanden, zodat het jaar ≈ aandeel × begroting blijft (Codex M3)
    const actief = r.masker || Array(12).fill(true);
    // de actieve maanden samen = aandeel × jaar, met de vorm van het patroon (mei/november) (Codex r2 M1)
    const T = perMaand.reduce((a, x) => a + x, 0), A = perMaand.reduce((a, x, i) => a + (actief[i] ? x : 0), 0) || 1;
    const maanden = perMaand.map((x, i) => (actief[i] ? Math.round((x * r.aandeel * T) / A) : 0));
    return { praktijk_id: r.praktijk_id, aandeel: r.aandeel, stand: r.stand_begin, maanden, jaar: maanden.reduce((s, x) => s + x, 0) };
  });
  const somP = praktijken.reduce((s, p) => s + p.jaar, 0);
  const pct = `${String(rond2(f * 100)).replace(".", ",")} %`;
  return {
    ok: true, entiteit, gewoon, januari: perMaand[0], februari: perMaand[1], mei: perMaand[4], november: perMaand[10], jan_feb: f, jan_feb_begrensd: begrensd ? gevraagdF : null, jan_feb_bedrag: jf, per_maand: perMaand, praktijken,
    totaal: begroting.totaal, afronding: rond2(somP - begroting.totaal),
    hoe: pot
      ? `gewone maand = (${euro(begroting.totaal, { heel: true })} − vakantiegeld ${euro(vg, { heel: true })} − eindejaarsuitkering ${euro(eju, { heel: true })}) ÷ 12 = ${euro(gewoon, { heel: true })}; mei + vakantiegeld, november + eindejaarsuitkering` +
        (f > 0 ? `; januari + ${pct} van de begroting (${euro(jf, { heel: true })}) voor de hoge januari-uitgaven, februari evenveel minder` : "") + "; per praktijk × aandeel, op hele euro's"
      : `maand = ${euro(begroting.totaal, { heel: true })} ÷ 12 = ${euro(gewoon, { heel: true })}; per praktijk × aandeel, op hele euro's`,
  };
}

// ---------- R7 buffer ----------
/** Maanden voor de bufferopbouw uit "1,7", [1, 7] of null: oplopend, uniek, 1–12; leeg of ongeldig = null (dan gelijke maanddelen). */
export function bufferMaanden(x) {
  if (x == null || x === "") return null;
  const l = (Array.isArray(x) ? x : String(x).split(/[ ,;]+/)).map(Number);
  if (!l.length || l.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) return null;
  return [...new Set(l)].sort((a, b) => a - b);
}
/**
 * R7 — buffer als vast tegoed per praktijk: doel per praktijk = aandeel × doel van de entiteit; wat nog moet = doel − al gevraagd
 * (herverdeling naar de nieuwe aandelen); in `opbouwMaanden` gelijke delen vanaf `startMaand` (hele euro's, rest in de laatste).
 * Of in gekozen maanden: `opbouwIn` = lijst maandnummers (bv. [1, 7] = helft met januari, helft met juli; wv2770); die gaat voor.
 * Is er al meer gevraagd dan het nieuwe doel, dan komt het verschil eenmalig als 'u krijgt terug' op de eerste nota.
 * Leningen bestaan niet (David 8-11-2026, wv2773): wat een praktijk extra stort is een extra bijdrage in dat jaar en wordt in de
 * afrekening verrekend (zie extraBijdrageTelt); de buffer lost dus niets af.
 */
export function bufferPlan({ doel, aandelen, alGevraagd = {}, opbouwMaanden = 12, startMaand = 1, opbouwIn = null }) {
  if (!aandelen.ok) return { ok: false, reden: "patiëntenstand ontbreekt" };
  const gekozen = bufferMaanden(opbouwIn);
  const n = gekozen ? gekozen.length : Math.max(1, Math.min(opbouwMaanden, 13 - startMaand));
  const delen = gekozen || Array.from({ length: n }, (_, i) => startMaand + i);
  const praktijken = aandelen.rijen.map((r) => {
    const d = Math.round(Number(doel) * r.aandeel);
    const al = rond2(alGevraagd[r.praktijk_id] || 0);
    const nog = rond2(d - al);
    const maanden = Array(12).fill(0);
    if (nog < 0) maanden[delen[0] - 1] = nog;
    else if (nog > 0) {
      const deel = Math.floor(nog / n);
      for (const m of delen) maanden[m - 1] = deel;
      maanden[delen[n - 1] - 1] += rond2(nog - deel * n);
    }
    return { praktijk_id: r.praktijk_id, aandeel: r.aandeel, doel: d, al_gevraagd: al, nog, maanden };
  });
  const perMaand = Array.from({ length: 12 }, (_, i) => praktijken.reduce((s, p) => s + p.maanden[i], 0));
  return {
    ok: true, doel: Number(doel), opbouw_in: delen, praktijken, per_maand: perMaand,
  };
}

// ---------- R8 kasstroomtoets ----------
/** Spreiding van betalingen over de dagen van de maand, gewogen naar bedrag (gemeten uit de bank). */
export function spreidingUitBetalingen(rijen) {
  const tot = rijen.reduce((s, r) => s + Math.max(0, Number(r.bedrag)), 0);
  if (!(tot > 0)) return [{ dag: 15, fractie: 1 }];
  return rijen.filter((r) => Number(r.bedrag) > 0).map((r) => ({ dag: Number(r.dag), fractie: Number(r.bedrag) / tot })).sort((a, b) => a.dag - b.dag);
}
/** Inkomende bijdragen als kasstroom: per maand het totaal, verdeeld over de dagen volgens de spreiding (dag > einde maand = laatste dag). */
export function inkomstenStromen({ jaar, perMaand, spreiding = [{ dag: 15, fractie: 1 }] }) {
  const uit = [];
  perMaand.forEach((bedrag, i) => {
    const ld = Number(laatsteDag(jaar, i + 1).slice(8));
    for (const s of spreiding) uit.push({ datum: `${jaar}-${p2(i + 1)}-${p2(Math.min(s.dag, ld))}`, bedrag: bedrag * s.fractie, soort: "bijdrage" });
  });
  return uit;
}
/**
 * Uitgaande kasstroom uit de begroting (vooruitkijken): salaris rond de 25e, loonheffing eind van de volgende maand, pensioen eind
 * van de maand (verdeling gemeten uit de bank), vakantiegeld met het salaris van mei, eindejaarsuitkering met het salaris van december
 * (loonheffing in januari/juni), overige componenten per maand op de 1e, per kwartaal op de 1e van het kwartaal, per jaar per maand.
 * De loonheffing van december van het jaar ervoor valt in januari: benaderd met de december van dit jaar.
 */
export function uitgavenUitBegroting({ jaar, begroting, personeel = null, verdeling = { salaris: 0.6, loonheffing: 0.25, pensioen: 0.15 } }) {
  const uit = [];
  const zet = (datum, kosten, soort) => { if (kosten) uit.push({ datum, bedrag: -kosten, soort }); };   // kosten > 0 = uitgave, < 0 = ontvangst (Codex M10)
  for (const r of begroting.regels) r.maanden.forEach((x, i) => zet(r.per === "jaar" ? `${jaar}-${p2(i + 1)}-15` : eerste(jaar, i + 1), x, r.naam));
  if (personeel) {
    const V = verdeling;
    personeel.maanden.forEach((x, i) => {
      const m = i + 1;
      const loon = x.regulier + x.vakantiegeld + x.eindejaar;
      zet(`${jaar}-${p2(m)}-${m === 12 ? "20" : "25"}`, loon * V.salaris + x.inhuur + x.verzuim, "salaris");
      zet(`${jaar}-${p2(m)}-15`, x.uitkering, "uitkering verzuimverzekering");
      zet(laatsteDag(jaar, m), x.regulier * V.pensioen, "pensioen");
      const lh = (x.regulier * V.loonheffing) + (x.vakantiegeld + x.eindejaar) * (1 - V.salaris);
      if (m < 12) zet(laatsteDag(jaar, m + 1), lh, "loonheffing");
      else zet(laatsteDag(jaar, 1), lh, "loonheffing (december vorig jaar, benaderd)");
    });
  }
  return uit;
}
/**
 * R8 — kasstroomtoets: saldo per dag vanaf `startsaldo`; per maand de laagste stand. Zakt het saldo onder de ondergrens, dan noemt
 * de toets de eerste maand waarin dat gebeurt en stelt voor: het tekort extra op de nota van de maand ervoor, of de gewone maand
 * hoger met tekort ÷ het aantal maanden tot dan. Is de buffer besloten (`bufferStatus` 'besloten'; David 8-11-2026: kleine buffer,
 * Tolgaarde als vangnet), dan luidt het voorstel dat Tolgaarde bijspringt met een extra bijdrage die de afrekening verrekent.
 * Een saldo onder nul staat met een min-teken in de tekst (wv2781).
 * @param {{ jaar:number, startsaldo:number, stromen:{datum:string, bedrag:number}[], ondergrens?:number, bufferStatus?:string|null }} a
 */
export function kasstroom({ jaar, startsaldo, stromen, ondergrens = 0, bufferStatus = null }) {
  const s = stromen.filter((x) => x.datum.startsWith(String(jaar))).slice().sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : b.bedrag - a.bedrag));
  let saldo = Number(startsaldo);
  const maanden = Array.from({ length: 12 }, (_, i) => ({ maand: i + 1, laagste: null, laagste_op: null, eind: null, in: 0, uit: 0 }));
  // per dag eerst alles in, dan alles uit zou te gunstig zijn: binnen een dag gaan uitgaven vóór inkomsten (voorzichtig)
  const perDag = new Map();
  for (const x of s) { if (!perDag.has(x.datum)) perDag.set(x.datum, []); perDag.get(x.datum).push(x); }
  // elke maand begint met het overgedragen saldo als laagste stand (Codex M8)
  for (let m = 1; m <= 12; m++) {
    const M = maanden[m - 1];
    M.laagste = saldo; M.laagste_op = eerste(jaar, m);
    const dagen = [...perDag.keys()].filter((d) => Number(d.slice(5, 7)) === m).sort();
    for (const datum of dagen) {
      for (const x of perDag.get(datum).slice().sort((a, b) => a.bedrag - b.bedrag)) {
        saldo += Number(x.bedrag);
        if (x.bedrag > 0) M.in += x.bedrag; else M.uit -= x.bedrag;
        if (saldo < M.laagste) { M.laagste = saldo; M.laagste_op = datum; }
      }
    }
    M.eind = saldo;
  }
  for (const x of maanden) { x.laagste = rond2(x.laagste); x.eind = rond2(x.eind); x.in = rond2(x.in); x.uit = rond2(x.uit); }
  const laagste = maanden.reduce((a, b) => (b.laagste < a.laagste ? b : a));
  const onder = maanden.filter((x) => x.laagste < ondergrens - 0.005);
  let voorstel = null;
  if (onder.length) {
    const eerst = onder[0];
    const tekort = rond2(ondergrens - Math.min(...onder.map((x) => x.laagste)));
    const ervoor = eerst.maand - 1;
    // euro() laat het teken weg (bedoeld voor "u krijgt terug"); een saldo onder nul moet als tekort leesbaar blijven (wv2781)
    const saldoTekst = (x) => (x < -0.004 ? `− ${euro(x)}` : euro(x));
    const grens = Math.abs(ondergrens) < 0.005 ? "" : `, onder de ondergrens van ${saldoTekst(ondergrens)}`;
    const diepst = onder.reduce((a, b) => (b.laagste < a.laagste - 0.005 ? b : a));
    const soort = bufferStatus === "besloten" ? "tolgaarde" : ervoor >= 1 ? "nota" : "buffer";
    voorstel = {
      maand: eerst.maand, tekort, soort,
      tekst: `In ${MAANDEN[eerst.maand - 1]} zakt het saldo tot ${saldoTekst(eerst.laagste)}${grens}: ${euro(ondergrens - eerst.laagste, { heel: true })} tekort` +
        (diepst.maand !== eerst.maand ? `; het diepste punt is ${euro(tekort, { heel: true })} tekort in ${MAANDEN[diepst.maand - 1]}. ` : ". ") +
        (soort === "tolgaarde" ? `Tolgaarde springt dan ± ${euro(tekort, { heel: true })} bij (extra bijdrage, verrekend in de afrekening).`
          : soort === "nota" ? `Voorstel: ${euro(tekort, { heel: true })} extra op de nota van ${MAANDEN[ervoor - 1]}, of de gewone maand ${euro(Math.ceil(tekort / ervoor), { heel: true })} hoger.`
            : `Voorstel: de buffer verhogen met ${euro(tekort, { heel: true })} (het tekort valt al in januari).`),
    };
  }
  return { jaar, startsaldo: Number(startsaldo), ondergrens, maanden, laagste: laagste.laagste, laagste_op: laagste.laagste_op, onder: onder.map((x) => x.maand), voorstel, eind: maanden[11].eind };
}

// ---------- R9 wijziging tussendoor ----------
/**
 * R9 — een wijziging met een datum herberekent het jaarplan. 'verdelen': de maanden met een nota blijven zoals ze zijn; de nog niet
 * gemaakte maanden krijgen het nieuwe patroon plus het verschil van de al gemaakte maanden, gelijk verdeeld. 'laten': het plan blijft;
 * het verschil komt in de afrekening. Verstuurde of vastgestelde nota's veranderen nooit.
 * @param {{ oud: {praktijk_id:string, maanden:number[]}[], nieuw: {praktijk_id:string, aandeel:number, maanden:number[]}[], gemaakt: number[], keuze: "verdelen"|"laten" }} a
 */
export function herzien({ oud, nieuw, gemaakt, keuze }) {
  const vast = new Set(gemaakt);
  const open = Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => !vast.has(m));
  const ids = [...new Set([...oud.map((x) => x.praktijk_id), ...nieuw.map((x) => x.praktijk_id)])].sort();
  const praktijken = ids.map((id) => {
    const o = oud.find((x) => x.praktijk_id === id)?.maanden || Array(12).fill(0);
    const n = nieuw.find((x) => x.praktijk_id === id)?.maanden || Array(12).fill(0);
    let maanden;
    if (keuze === "laten" || !open.length) maanden = o.slice();
    else {
      const achter = [...vast].reduce((s, m) => s + (n[m - 1] - o[m - 1]), 0);
      const deel = Math.trunc(achter / open.length);
      maanden = o.map((x, i) => (vast.has(i + 1) ? x : n[i] + deel));
      maanden[open.at(-1) - 1] += achter - deel * open.length;
    }
    const nieuwJaar = n.reduce((s, x) => s + x, 0), plan = maanden.reduce((s, x) => s + x, 0);
    return { praktijk_id: id, maanden, oud_jaar: o.reduce((s, x) => s + x, 0), nieuw_jaar: nieuwJaar, jaar: plan, naar_afrekening: plan - nieuwJaar };
  });
  return { keuze, open_maanden: open, praktijken };
}

// ---------- nota's ----------
/** Titel van het stuk (vaste opmaak per entiteit): POT/KM = BIJDRAGENOTA, SLOEL = NOTA DOORBELASTE HUUR. Nooit "factuur", geen btw. */
export function notaTitel(entiteit) {
  return entiteit === "SLOEL" ? "NOTA DOORBELASTE HUUR" : "BIJDRAGENOTA";
}
/** Woorden-toets voor elk stuk dat de deur uitgaat: geen 'factuur', geen 'btw', geen bedrag met een min-teken. */
export function controleerStukTekst(tekst) {
  const fouten = [];
  const t = String(tekst).replace(/\S+@\S+/g, "");
  if (/factu/i.test(t)) fouten.push("het woord factuur");
  if (/\bbtw\b|\bvat\b|omzetbelasting/i.test(t)) fouten.push("btw");
  if (/[-−]\s?€|€\s?[-−]\s?\d/.test(t)) fouten.push("bedrag met een min-teken");
  return fouten;
}
/**
 * Maandnota: één stuk per praktijk per entiteit per maand. Regels: de bijdrage (of doorbelaste huur) van de maand, de bufferopbouw
 * (apart, telt niet mee in de afrekening), een correctie (SLOEL-afrekening op de eerstvolgende huurnota) en een verrekening van een
 * tegoed. Bedrag = som van de regels; een negatief totaal staat in woorden ("u krijgt € x terug").
 */
export function maakMaandNota({ entiteit, jaar, maand, praktijk_id, nummer, datum, vervaldag, debiteur, bijdrage, buffer = 0, correcties = [], verrekeningen = [], hoe = "" }) {
  const naam = MAANDEN[maand - 1];
  const regels = [{ soort: "bijdrage", omschrijving: entiteit === "SLOEL" ? `Doorbelaste huur ${naam} ${jaar}` : `Bijdrage ${naam} ${jaar}`, bedrag: rond2(bijdrage), toelichting: hoe }];
  if (buffer) regels.push({ soort: "buffer", omschrijving: buffer > 0 ? `Opbouw buffer ${jaar} (vast tegoed, krijgt u terug bij uittreden)` : `Herverdeling buffer ${jaar}: u krijgt terug`, bedrag: rond2(buffer) });
  for (const c of correcties) regels.push({ soort: "correctie", omschrijving: c.omschrijving, bedrag: rond2(c.bedrag), toelichting: c.toelichting || "", correctie_id: c.id ?? null });
  for (const v of verrekeningen) regels.push({ soort: "verrekening", omschrijving: v.omschrijving, bedrag: rond2(v.bedrag), nota_id: v.nota_id ?? null });
  const bedrag = rond2(regels.reduce((s, r) => s + r.bedrag, 0));
  return {
    entiteit, jaar, nummer, praktijk_id, datum, vervaldag, soort: "maand", periode: `${jaar}-${p2(maand)}`, titel: notaTitel(entiteit),
    regels, bedrag, buffer: rond2(buffer), debiteur, status: "definitief", bron: "ovis-pot",
  };
}
/** Afrekeningsnota (POT/KM) of de correctieregel voor de SLOEL, uit een rij van afrekening(). */
export function maakAfrekenNota({ entiteit, jaar, rij, nummer, datum, vervaldag, debiteur, kosten, modus }) {
  return {
    entiteit, jaar, nummer, praktijk_id: rij.praktijk_id, datum, vervaldag, soort: "afrekening", periode: String(jaar), titel: notaTitel(entiteit),
    regels: [
      { soort: "afrekening", omschrijving: `Afrekening ${jaar}: aandeel in de kosten`, bedrag: rij.kosten, toelichting: rij.hoe },
      { soort: "afrekening", omschrijving: modus === "betaald" ? `Al betaald in ${jaar}` : `Al gevraagd in ${jaar}`, bedrag: -rij.al_voldaan },
    ],
    bedrag: rij.uitkomst, buffer: 0, debiteur, status: "definitief", bron: "ovis-pot",
    toelichting: `${uitkomstInWoorden(rij.uitkomst)}. Totale kosten ${jaar}: ${euro(kosten)}.`,
  };
}
/** Verrekening van tegoeden (afrekeningsnota's met 'u krijgt terug') op een nieuwe nota, oudste eerst, hooguit tot het notabedrag. */
export function verrekenTegoeden(tegoeden, notaBedrag) {
  let ruimte = Math.max(0, rond2(notaBedrag));
  const uit = [];
  for (const t of tegoeden.slice().sort((a, b) => (a.datum < b.datum ? -1 : 1))) {
    const open = rond2(-Number(t.bedrag) - Number(t.verrekend || 0));
    if (open <= 0 || ruimte <= 0) continue;
    const deel = Math.min(open, ruimte);
    ruimte = rond2(ruimte - deel);
    uit.push({ nota_id: t.id, bedrag: -deel, omschrijving: `Verrekening tegoed afrekening (nota ${t.nummer})` });
  }
  return uit;
}

// ---------- § 7 overzichten ----------
/** Inschrijfgeld POH-GGZ globaal: gemiddeld aantal patiënten × tarief per kwartaal × 4. */
export function inschrijfgeld(gemiddeld, tarief) {
  return gemiddeld == null || tarief == null ? null : rond2(Number(gemiddeld) * Number(tarief) * 4);
}

// ---------- samengesteld: het jaarplan en de afrekening uit de gegevens van de database ----------
/** De geldende rij (nieuwste geldig_van/jaar ≤ peil) uit een lijst. */
function geldend(lijst, sleutel, peil) {
  return lijst.filter((x) => String(x[sleutel]) <= String(peil)).sort((a, b) => (String(a[sleutel]) < String(b[sleutel]) ? -1 : 1)).at(-1) || null;
}
/**
 * Extra bijdragen (David 8-11-2026, wv2773): er zijn geen leningen. Stort een praktijk buiten de nota's om extra (in de bank als
 * 'liquiditeit' toegewezen aan die praktijk, bv. Tolgaarde € 10.000 aan KM in 2026), dan is dat een extra bijdrage in dat boekjaar:
 * per praktijk telt het totaal dat ze in het jaar bijdroeg tegenover haar aandeel in de kosten, en te veel komt terug in de
 * afrekening. Vanaf boekjaar 2026; de jaren ervoor zijn al afgerekend (toen telde zo'n storting niet mee).
 */
export const EXTRA_BIJDRAGE_VANAF = 2026;
export function extraBijdrageTelt(jaar) { return Number(jaar) >= EXTRA_BIJDRAGE_VANAF; }
/** Wat een praktijk in jaar J al voldaan heeft voor de afrekening: betaald (bank) of gevraagd (nota's), plus extra bijdragen, uit /api/geld. */
export function tegenUitGeld(geld, entiteit, modus) {
  const tegen = {};
  for (const x of geld.extra || []) { if (x.entiteit === entiteit) tegen[x.praktijk_id] = (tegen[x.praktijk_id] || 0) + Number(x.bedrag); }
  if (modus === "betaald") for (const b of geld.betaald) { if (b.entiteit === entiteit && (b.soort === "voorschot" || b.soort === "huur")) tegen[b.praktijk_id] = (tegen[b.praktijk_id] || 0) + Number(b.bedrag); }
  else for (const g of geld.gevraagd) { if (g.entiteit === entiteit) tegen[g.praktijk_id] = (tegen[g.praktijk_id] || 0) + Number(g.bedrag); }
  return tegen;
}
/** Afrekening van een entiteit over jaar J uit de gegevens (zelfde rekenwijze als het scherm Afrekening). */
export function rekenAfrekeningJaar({ entiteit, jaar, standen, deelnames, jaarlasten, geld }) {
  const kosten = kostenJaar(jaarlasten, entiteit, jaar);
  if (!kosten) return { ok: false, reden: `kosten ${jaar} nog niet bekend` };
  const modus = afrekenModus(jaar, { heeftNotas: geld.gevraagd.some((g) => g.entiteit === entiteit) });
  const aandelen = aandelenAfrekening({ entiteit, jaar, standen, deelnames });
  const r = afrekening({ aandelen, kosten: kosten.bedrag, tegen: tegenUitGeld(geld, entiteit, modus), modus });
  return { ...r, kosten_status: kosten.status, kosten_bron: kosten.bron, modus };
}

/**
 * Het jaarplan van een entiteit voor jaar J: personeel (R5, alleen POT), jaarbegroting (R4), aandelen (R4), maandpatroon (R6),
 * buffer (R7) en de kasstroomtoets (R8). Puur; de app rekent het als voorbeeld, de API rekent het opnieuw bij het bewaren.
 * @param {any} d gegevens (zie functions/_lib/api.ts → jaarGegevens)
 * @param {{ startsaldo?: number }} [o]
 */
export function rekenJaarplan(d, entiteit, jaar, o = {}) {
  const lp = geldend(d.loonparameters || [], "jaar", jaar);
  const param = lp ? { ...lp, verdeling: typeof lp.verdeling === "string" ? JSON.parse(lp.verdeling) : lp.verdeling } : null;
  const contracten = (d.contracten || []).map((c) => ({ ...c, naam: c.naam || `contract ${c.id}` }));
  const waarschuwingen = [];
  let personeel = null;
  if (entiteit === "POT" && contracten.length) {
    if (!param) waarschuwingen.push("geen loonparameters (werkgeverslasten, reserveringen) voor dit jaar: personeel niet berekend");
    else {
      const cao = (d.cao || []).map((t) => ({ cao: t.cao, ingang: t.ingang, schaal: String(t.schaal), trede: Number(t.trede), bruto: Number(t.bruto), uren_voltijd: Number(t.uren_voltijd) }));
      personeel = personeelJaar({ jaar, contracten, mutaties: d.contractmutaties || [], afwezigheid: d.afwezigheid || [], inhuur: d.inhuur || [], tabellen: cao, param });
      waarschuwingen.push(...personeel.waarschuwingen);
      const onbevestigd = contracten.filter((c) => c.soort !== "vacature" && !c.bevestigd_op && (!c.tot || c.tot >= `${jaar}-01-01`));
      if (onbevestigd.length) waarschuwingen.push(`${onbevestigd.length} contract(en) met een afgeleide schaal/trede, nog niet bevestigd`);
    }
  }
  const begroting = jaarbegroting({ entiteit, jaar, componenten: d.componenten, mutaties: d.mutaties, personeel });
  if (!(begroting.totaal > 0)) waarschuwingen.push(`geen kosten voor ${jaar}: voeg kostenposten toe (scherm Kosten)`);
  const aandelen = aandelenBijdrage({ entiteit, jaar, standen: d.standen, deelnames: d.deelnames });
  const patroon = maandpatroon({ entiteit, begroting, aandelen, janFeb: janFebFractie(d.instelling, jaar) });
  if (patroon.ok && patroon.jan_feb_begrensd != null) waarschuwingen.push(`januari-extra ${rond2(patroon.jan_feb_begrensd * 100)} % zou februari onder nul brengen: begrensd op ${rond2(patroon.jan_feb * 100)} % (februari € 0)`);
  const bf = geldend((d.buffers || []).filter((b) => b.entiteit === entiteit), "geldig_van", `${jaar}-01-01`);
  const alG = {};
  for (const g of (d.bufferGevraagd || []).filter((x) => x.entiteit === entiteit)) alG[g.praktijk_id] = Number(g.bedrag);
  const alles = Object.values(alG).reduce((s, x) => s + x, 0);
  const buffer = bf && aandelen.ok ? bufferPlan({ doel: bf.doel, aandelen, alGevraagd: alG, opbouwMaanden: alles > 0 ? 1 : Number(bf.opbouw_maanden) || 12, opbouwIn: bf.opbouw_in }) : null;
  // uitgetreden: wie buffer heeft opgebouwd maar niet meer meedoet, krijgt die terug (de app maakt het zichtbaar; terugboeken doet David) (Codex M7)
  const terug = Object.entries(alG).filter(([pid, b]) => b > 0.004 && !aandelen.rijen.some((r) => r.praktijk_id === pid)).map(([praktijk_id, bedrag]) => ({ praktijk_id, bedrag }));
  if (buffer) buffer.terug = terug;
  for (const t of terug) waarschuwingen.push(`${t.praktijk_id} doet in ${jaar} niet meer mee en heeft ${euro(t.bedrag)} buffer opgebouwd: terugstorten (niet verrekenen)`);
  let kas = null;
  if (patroon.ok) {
    const sp = spreidingUitBetalingen((d.spreiding || []).filter((x) => x.entiteit === entiteit));
    const inkomend = patroon.per_maand.map((x, i) => x + (buffer ? buffer.per_maand[i] : 0));
    const stromen = [...inkomstenStromen({ jaar, perMaand: inkomend, spreiding: sp }),
      ...uitgavenUitBegroting({ jaar, begroting, personeel, verdeling: param?.verdeling || undefined })];
    const start = o.startsaldo != null ? Number(o.startsaldo) : alles;
    kas = kasstroom({ jaar, startsaldo: start, stromen, ondergrens: 0, bufferStatus: bf?.status || null });
  }
  return { entiteit, jaar, personeel, begroting, aandelen, patroon, buffer, buffer_instelling: bf, kasstroom: kas, waarschuwingen, ok: patroon.ok && begroting.totaal > 0 };
}


// ---------- fase 3 (wv2762): bank ↔ nota, overname, mailteksten ----------
/**
 * Nummers (JJJJnnn, R11) die in een betaalomschrijving staan; alleen die van `bekend` (de nota's van deze entiteit), zodat een
 * toevallig getal (datum, rekeningnummer) niet meetelt.
 */
export function kenmerkenUit(omschrijving, bekend) {
  const set = bekend instanceof Set ? bekend : new Set((bekend || []).map(String));
  const gevonden = String(omschrijving || "").match(/(?<!\d)20\d{5}(?!\d)/g) || [];
  return [...new Set(gevonden)].filter((k) => set.has(k));
}

/**
 * Termijnen voor de betaalmonitor uit de nota's van de app (vanaf de overname): elke vastgestelde nota met een te betalen bedrag is één
 * termijn (sleutel = nummer, ook het kenmerk). Een nota met 'u krijgt terug' is geen termijn (die wordt verrekend).
 */
export function termijnenUitNotas(notas, entiteit, praktijk_id) {
  return (notas || []).filter((n) => n.entiteit === entiteit && n.praktijk_id === praktijk_id && n.status === "definitief" && Number(n.bedrag) > 0.004)
    .map((n) => ({ sleutel: String(n.nummer), nummer: String(n.nummer), vervaldag: n.vervaldag || n.datum, bedrag: rond2(n.bedrag), bron: "nota", soort: n.soort }));
}

/**
 * R10: een overname halverwege het jaar. Welke maanden van jaar J horen bij de oude houder en welke bij de nieuwe? De maand van de
 * overname gaat naar de nieuwe houder als de overname op of vóór de 15e valt, anders naar de oude.
 */
export function overnameMaanden(jaar, datum) {
  if (!isDatum(datum)) throw new Error("overnamedatum ontbreekt");
  const [j, m, d] = datum.split("-").map(Number);
  if (j < jaar) return { oud: 0, nieuw: 12 };
  if (j > jaar) return { oud: 12, nieuw: 0 };
  const oud = d <= 15 ? m - 1 : m;
  return { oud, nieuw: 12 - oud };
}
/**
 * R10: de afrekening van een praktijk over twee houders. Kosten naar maanden; wat al gevraagd (of betaald) is per houder zoals het bij die
 * houder hoort. Zonder overname in J, of bij keuze 'nieuwe_houder': alles naar de houder op de notadatum (één deel).
 * @returns {{ deel: "oud"|"nieuw"|"alles", maanden: number, kosten: number, al_voldaan: number, uitkomst: number }[]}
 */
export function verdeelAfrekening({ jaar, kosten, alVoldaanOud = 0, alVoldaanNieuw = 0, overname = null }) {
  const totaalVoldaan = rond2(Number(alVoldaanOud) + Number(alVoldaanNieuw));
  if (!overname || overname.verdeling !== "maanden") return [{ deel: "alles", maanden: 12, kosten: rond2(kosten), al_voldaan: totaalVoldaan, uitkomst: rond2(kosten - totaalVoldaan) }];
  const m = overnameMaanden(jaar, overname.datum);
  if (!m.oud || !m.nieuw) return [{ deel: "alles", maanden: 12, kosten: rond2(kosten), al_voldaan: totaalVoldaan, uitkomst: rond2(kosten - totaalVoldaan) }];
  const kOud = rond2((kosten * m.oud) / 12), kNieuw = rond2(kosten - kOud);
  return [
    { deel: "oud", maanden: m.oud, kosten: kOud, al_voldaan: rond2(alVoldaanOud), uitkomst: rond2(kOud - alVoldaanOud) },
    { deel: "nieuw", maanden: m.nieuw, kosten: kNieuw, al_voldaan: rond2(alVoldaanNieuw), uitkomst: rond2(kNieuw - alVoldaanNieuw) },
  ];
}

const MND_LANG = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
const datumWoorden = (d) => { const [j, m, dd] = String(d).slice(0, 10).split("-").map(Number); return `${dd} ${MND_LANG[m - 1]} ${j}`; };
const stukRegel = (n) => `- ${entiteitNaam(n.entiteit)}: ${stukNaam(n.entiteit)} ${n.nummer}, ${Number(n.bedrag) < 0 ? `u krijgt ${euro(n.bedrag)} terug` : euro(n.bedrag)}${Number(n.bedrag) > 0 ? ` (graag vóór ${datumWoorden(n.vervaldag || n.datum)})` : ""}`;
/**
 * De mail aan een praktijk met de stukken van één notadatum (één mail per praktijk, de nota's als pdf-bijlagen). Concept: David
 * verstuurt. Zelfde woordtoets als de stukken (geen 'factuur', geen btw, geen min-teken).
 */
export function praktijkMail({ praktijk, datum, notas, ondertekening = "David Schaap" }) {
  const maand = (() => { const [j, m] = String(datum).split("-").map(Number); return `${MND_LANG[m - 1]} ${j}`; })();
  const alleenMaand = notas.every((n) => n.soort === "maand");
  const onderwerp = alleenMaand ? `POH-GGZ ${maand}: bijdragen en doorbelaste huur — ${praktijk}` : `POH-GGZ: stukken van ${datumWoorden(datum)} — ${praktijk}`;
  const bedragen = notas.map(stukRegel).join("\n");
  const bericht = `Beste collega's,\n\nIn de bijlage de stukken van ${alleenMaand ? maand : datumWoorden(datum)} voor de POH-GGZ:\n\n${bedragen}\n\n` +
    `Het nummer van elk stuk is ook het betalingskenmerk; graag per stuk overmaken naar de rekening die erop staat. ` +
    `Het gaat om bijdragen in de gezamenlijke kosten (POT en Kostenmaatschap) en om doorbelaste huur (SLOEL).\n\nMet vriendelijke groet,\n${ondertekening}`;
  const fouten = controleerStukTekst(onderwerp + "\n" + bericht);
  if (fouten.length) throw new Error(`mailtekst geweigerd: ${fouten.join(", ")}`);
  return { onderwerp, bericht };
}
/** De mail aan het verkoopadres van een entiteit in Exact: dezelfde stukken, alleen voor de boekhouding. */
export function exactMail({ entiteit, datum, notas }) {
  const onderwerp = `${entiteitNaam(entiteit)}: ${notas.length === 1 ? stukNaam(entiteit) + " " + notas[0].nummer : notas.length + " stukken"} van ${datumWoorden(datum)}`;
  const bericht = `Voor de boekhouding van ${entiteitNaam(entiteit)}: ${notas.length === 1 ? "het stuk" : "de stukken"} van ${datumWoorden(datum)} in de bijlage.\n\n${notas.map(stukRegel).join("\n")}`;
  const fouten = controleerStukTekst(onderwerp + "\n" + bericht);
  if (fouten.length) throw new Error(`mailtekst geweigerd: ${fouten.join(", ")}`);
  return { onderwerp, bericht };
}
/** Herinnering (concept, op Davids klik) voor één open nota. */
export function herinneringMail({ praktijk, nota, open, ondertekening = "David Schaap" }) {
  const onderwerp = `Herinnering: ${stukNaam(nota.entiteit)} ${nota.nummer} — ${praktijk}`;
  const bericht = `Beste collega's,\n\nVolgens onze administratie staat van de ${stukNaam(nota.entiteit)} ${nota.nummer} van ${datumWoorden(nota.datum)} ` +
    `(${entiteitNaam(nota.entiteit)}) nog ${euro(open)} open; die was te betalen vóór ${datumWoorden(nota.vervaldag || nota.datum)}. ` +
    `De nota staat nog eens in de bijlage. Willen jullie het bedrag overmaken onder vermelding van ${nota.nummer}? Is het intussen betaald, dan kun je dit bericht als niet verzonden beschouwen.\n\n` +
    `Met vriendelijke groet,\n${ondertekening}`;
  const fouten = controleerStukTekst(onderwerp + "\n" + bericht);
  if (fouten.length) throw new Error(`mailtekst geweigerd: ${fouten.join(", ")}`);
  return { onderwerp, bericht };
}
