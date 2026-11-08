'use strict';
/*
 * stroom-tabel.js — houdt de maandtabel op de vaultpagina "Energieverbruik thuis (Tibber)" vanzelf bij (wv2704, 8-11-2026).
 *
 * WAAROM. Financiën › Uitgaven › "Zelf bij te sturen" (wv2700) toont de stroom per maand uit die tabel. Hij was op 6-11 eenmalig uit de
 * facturen gevuld (t/m okt 2026); zonder bijwerken loopt de post vanaf december achter.
 *
 * BRON. De Tibber-maandfactuur die de Facturen-app al binnenhaalt (MailMan → Facturen, privé): bedrag incl. btw uit facturen.sqlite, kWh en
 * kale prijs uit de tekst van de PDF in stukken/ (pdftotext). Geen netwerk, geen sleutel. De Tibber-API geeft wel de kWh exact, maar niet het
 * factuurbedrag (vaste kosten, teruglevering) en niet de kale prijs; gemeten 8-11: okt 2026 API € 507,79 tegen factuur € 498,84.
 *
 * GRENZEN. Alleen een maand die nog niet in de tabel staat komt erbij (op zijn plek). Staat de maand er al: gelijk = niets, anders = twijfel.
 * Twijfel (onleesbare factuur, twee verschillende facturen voor één maand, rij wijkt af, geen tabel): niets schrijven, één box-rij per geval.
 * Schrijven alleen via vault-veilig wijzig (server.js geeft hem mee). Geen bedrag of naam in een log.
 *
 * Puur deel (getoetst in test/stroom-tabel.sh): factuurUit, tabelZet. ronde(deps) regisseert met ingespoten deps.
 */
const KVK_TIBBER = '80004245';
const P_ENERGIE = '20_Prive/Financien/Energieverbruik thuis (Tibber).md';
const MAAND_VOL = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MAAND_KORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const VENSTER_DAGEN = 120;   // alleen facturen van de laatste 120 dagen; oudere zijn al verwerkt of horen bij de eenmalige vulling

function getalNl(s) {
  const t = String(s == null ? '' : s).replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}
function duizend(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
function eurNl(x) { const c = Math.round(x * 100), e = Math.floor(Math.abs(c) / 100), r = Math.abs(c) % 100; return (c < 0 ? '-' : '') + duizend(e) + ',' + String(r).padStart(2, '0'); }
function decNl(x, n) { return x.toFixed(n).replace('.', ','); }
function maandKort(m) { const p = m.split('-'); return MAAND_KORT[Number(p[1]) - 1] + ' ' + p[0]; }

/*
 * Factuurtekst (pdftotext -layout) + bedrag incl. btw in centen uit de databank → { maand: 'JJJJ-MM', kwh, kaal, incl } | { twijfel }.
 * Eist precies één regel "Stroomverbruik <maand> <jaar>" met daaronder "<kWh> kWh à <ct> ct/kWh", en het databankbedrag als
 * "Totaal incl. btw" in de tekst (twee onafhankelijke lezingen moeten kloppen).
 */
function factuurUit(tekst, inclCent) {
  const regels = String(tekst || '').split('\n');
  const treffers = [];
  for (let i = 0; i < regels.length; i++) {
    const m = /^\s*Stroomverbruik\s+([a-z]+)\s+(\d{4})\b/i.exec(regels[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < regels.length && !/\S/.test(regels[j])) j++;
    const k = /^\s*(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?)\s*kWh\s+à\s+(-?\d+(?:,\d+)?)\s*ct\/kWh\s*$/i.exec(regels[j] || '');
    treffers.push({ mnd: m[1].toLowerCase(), jaar: Number(m[2]), kwh: k ? getalNl(k[1]) : null, kaal: k ? getalNl(k[2]) : null });
  }
  if (treffers.length !== 1) return { twijfel: treffers.length ? 'meer dan één regel Stroomverbruik' : 'geen regel Stroomverbruik' };
  const t = treffers[0], mi = MAAND_VOL.indexOf(t.mnd);
  if (mi < 0) return { twijfel: 'onbekende maand' };
  if (!(t.kwh > 0) || t.kaal == null) return { twijfel: 'kWh of prijs niet te lezen' };
  if (!Number.isInteger(inclCent) || inclCent <= 0) return { twijfel: 'bedrag incl. btw ontbreekt' };
  const incl = inclCent / 100, eur = eurNl(incl);
  const ti = tekst.search(/Totaal\s+incl\.?\s+btw/i);
  if (ti < 0 || tekst.slice(ti, ti + 600).indexOf('€ ' + eur) < 0) return { twijfel: 'totaal incl. btw in de tekst wijkt af van de Facturen-app' };
  return { maand: t.jaar + '-' + String(mi + 1).padStart(2, '0'), kwh: t.kwh, kaal: t.kaal, incl: incl };
}

function rijTekst(r) {
  return '| ' + maandKort(r.maand) + ' | ' + duizend(Math.round(r.kwh)) + ' | ' + decNl(r.kaal, 2) + ' | ' + eurNl(r.incl) + ' | ' + decNl(r.incl / r.kwh * 100, 1) + ' |';
}
function rijLees(regel) {
  const c = regel.split('|').slice(1, -1).map(function (x) { return x.trim(); });
  const m = /^([a-z]{3})\s+(\d{4})$/i.exec(c[0] || '');
  if (!m || MAAND_KORT.indexOf(m[1].toLowerCase()) < 0) return null;
  const r = { maand: m[2] + '-' + String(MAAND_KORT.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0'), kwh: getalNl(c[1]), kaal: getalNl(c[2]), incl: getalNl(c[3]) };
  return r.kwh > 0 && r.kaal != null && r.incl != null ? r : null;   // review MOET 2: elke getalcel moet leesbaar zijn
}
function maandPlus(m, n) { const p = m.split('-').map(Number), t = p[0] * 12 + p[1] - 1 + n; return Math.floor(t / 12) + '-' + String(t % 12 + 1).padStart(2, '0'); }

/*
 * Pagina + nieuwe rijen → { tekst, toegevoegd: [maand], gelijk: [maand], twijfel: [{ maand, reden }] }. tekst is null als er niets verandert.
 * Verwacht de vaste kop | Maand | Verbruik (kWh) | Kale stroomprijs (ct/kWh) | Factuur incl. btw (€) | Alles-in (ct/kWh) |.
 * Werkt ook de regel "Laatste 12 maanden (…)" en updated: in de kop bij (alleen als er een rij bijkomt).
 */
function tabelZet(pagina, nieuw, vandaag) {
  const u = { tekst: null, toegevoegd: [], gelijk: [], twijfel: [] };
  const regels = String(pagina).split('\n');
  const k = regels.findIndex(function (r) { return /^\|\s*Maand\s*\|/i.test(r); });
  const kop = k >= 0 ? regels[k].split('|').slice(1, -1).map(function (c) { return c.trim().toLowerCase(); }) : [];
  if (k < 0 || kop.length !== 5 || !/verbruik/.test(kop[1]) || !/kale/.test(kop[2]) || !/factuur/.test(kop[3]) || !/alles-in/.test(kop[4]) || !/^\|[-:| ]+\|$/.test(regels[k + 1] || '')) {
    nieuw.forEach(function (r) { u.twijfel.push({ maand: r.maand, reden: 'maandtabel niet gevonden of andere kolommen' }); });
    return u;
  }
  let eind = k + 2;
  const rijen = [];
  for (; eind < regels.length && /^\|/.test(regels[eind]); eind++) {
    const r = rijLees(regels[eind]);
    if (!r) { nieuw.forEach(function (n) { u.twijfel.push({ maand: n.maand, reden: 'onleesbare tabelrij' }); }); return u; }
    rijen.push(r);
  }
  const bestaand = {};
  rijen.forEach(function (r) { bestaand[r.maand] = r; });
  const erbij = [];
  nieuw.forEach(function (n) {
    const b = bestaand[n.maand];
    if (!b) { if (!erbij.some(function (x) { return x.maand === n.maand; })) erbij.push(n); return; }
    // gelijk = zelfde bedrag op de cent, kWh binnen afronding, zelfde kale prijs
    if (b.incl === Math.round(n.incl * 100) / 100 && Math.abs(b.kwh - n.kwh) < 1 && b.kaal === Math.round(n.kaal * 100) / 100) u.gelijk.push(n.maand);
    else u.twijfel.push({ maand: n.maand, reden: 'de tabel heeft al een andere rij voor deze maand' });
  });
  if (!erbij.length) return u;
  const alle = rijen.map(function (r, i) { return { maand: r.maand, tekst: regels[k + 2 + i], r: r }; })
    .concat(erbij.map(function (n) { return { maand: n.maand, tekst: rijTekst(n), r: { maand: n.maand, kwh: Math.round(n.kwh), kaal: n.kaal, incl: n.incl } }; }));
  alle.sort(function (p, q) { return p.maand < q.maand ? -1 : p.maand > q.maand ? 1 : 0; });
  const uit = regels.slice(0, k + 2).concat(alle.map(function (x) { return x.tekst; }), regels.slice(eind));
  let tekst = uit.join('\n');
  // samenvattingsregel: laatste 12 maanden uit de tabel (kWh zoals in de tabel afgerond)
  // review ZOU 1: alleen als de laatste 12 rijen 12 aansluitende maanden zijn; anders blijft de oude regel (met zijn eigen periode) staan
  const l = alle.slice(-12).map(function (x) { return x.r; });
  if (l.length === 12 && l.every(function (r, i) { return i === 0 || maandPlus(l[i - 1].maand, 1) === r.maand; })) {
    const kwh = l.reduce(function (t, r) { return t + r.kwh; }, 0), eur = l.reduce(function (t, r) { return t + r.incl; }, 0);
    const zin = '- **Laatste 12 maanden (' + maandKort(l[0].maand) + '–' + maandKort(l[11].maand) + '):** ' +
      duizend(kwh) + ' kWh, € ' + eurNl(eur) + ' incl. btw, gemiddeld ' + decNl(eur / kwh * 100, 1) + ' ct/kWh alles-in.';
    tekst = tekst.replace(/^- \*\*Laatste 12 maanden \([^)\n]*\):\*\*[^\n]*$/m, function () { return zin; });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(vandaag || '') && /^---\n/.test(tekst)) {
    const fm = tekst.indexOf('\n---', 3);
    if (fm > 0) tekst = tekst.slice(0, fm).replace(/^updated: .*$/m, 'updated: ' + vandaag) + tekst.slice(fm);
  }
  u.tekst = tekst;
  u.toegevoegd = erbij.map(function (n) { return n.maand; });
  return u;
}

function boxTekst(klok, maand, reden) {
  return '\n## [log] ' + klok + ' — stroomtabel ' + maandKort(maand) + ': niet bijgewerkt (automatisch, wv2704) #stroomtabel\n- status: open\n- van: pod (stroom-tabel.js, na de bankronde)\n' +
    '- gemeten: ' + reden + '. Bron: de Tibber-factuur in de Facturen-app; pagina [[' + P_ENERGIE.replace(/\.md$/, '') + ']].\n' +
    '- gevolg als er niets gebeurt: Financiën › Uitgaven › Stroom blijft op de laatste maand in de tabel staan.\n' +
    '- voorstel: de factuur en de tabelrij naast elkaar leggen en de rij met de hand zetten of corrigeren; de pod meldt dit geval niet opnieuw.\n';
}

/*
 * deps = { openFacturen() → { db, sluit } | null, stukLees(sha) → Buffer, pdfNaarTekst(buf) → Promise<{ ok, tekst }>, vaultLees() → string,
 *          vaultWijzig(fn) → bool, boxRij(tekst) → bool, staatLees() → obj, staatZet(obj), ams() → { datum: 'JJJJ-MM-DD', klok } }
 * → { ok, toegevoegd, gelijk, twijfel, facturen } (zonder bedragen).
 */
async function ronde(deps) {
  const a = deps.ams(), staat = deps.staatLees() || {};
  const gemeld = Array.isArray(staat.gemeld) ? staat.gemeld.slice(-200) : [];
  const grens = new Date(Date.parse(a.datum + 'T12:00:00Z') - VENSTER_DAGEN * 86400000).toISOString().slice(0, 10);
  const f = deps.openFacturen();
  if (!f) return { ok: false, reden: 'facturen niet te openen' };
  let rijen;
  try {
    rijen = f.db.prepare("select f.id, f.incl_eur, f.factuurdatum, d.sha256 from factuur f join document d on d.id = f.document " +
      "where f.leverancier_kvk = ? and f.soort = 'factuur' and f.entiteit = 'prive' and f.valuta = 'EUR' and coalesce(f.status, '') <> 'geen_factuur' " +
      "and f.factuurdatum >= ? and d.mime = 'application/pdf' order by f.factuurdatum, f.id").all(KVK_TIBBER, grens);
  } finally { f.sluit(); }
  const twijfel = [], perMaand = {}, geblokt = {};
  for (const r of rijen) {
    let tekst = null;
    try { const t = await deps.pdfNaarTekst(deps.stukLees(r.sha256)); tekst = t && t.ok ? t.tekst : null; } catch (e) { tekst = null; }
    const u = tekst ? factuurUit(tekst, Number(r.incl_eur)) : { twijfel: 'pdf niet te lezen' };
    if (u.twijfel) {
      // review MOET 1: een onleesbare factuur (mogelijk een correctie) blokkeert de maanden rond zijn factuurdatum (verbruiksmaand ligt ervoor)
      const fm = String(r.factuurdatum).slice(0, 7);
      [-2, -1, 0].forEach(function (d) { geblokt[maandPlus(fm, d)] = true; });
      twijfel.push({ sleutel: 'f:' + r.id, maand: maandPlus(fm, -1), reden: 'Tibber-factuur ' + r.factuurdatum + ': ' + u.twijfel + ' (de maanden rond deze factuur blijven staan tot dit is opgehelderd)' });
      continue;
    }
    const b = perMaand[u.maand];
    if (b && (b.incl !== u.incl || b.kwh !== u.kwh || b.kaal !== u.kaal)) { b.dubbel = true; continue; }
    if (!b) perMaand[u.maand] = u;
  }
  const nieuw = [];
  Object.keys(perMaand).sort().forEach(function (m) {
    if (perMaand[m].dubbel) twijfel.push({ sleutel: 'd:' + m, maand: m, reden: 'twee Tibber-facturen met verschillende cijfers voor dezelfde maand' });
    else if (!geblokt[m]) nieuw.push(perMaand[m]);
  });
  let toegevoegd = [], gelijk = [];
  if (nieuw.length) {
    let z = null;
    const ok = deps.vaultWijzig(function (pagina) { z = tabelZet(pagina, nieuw, a.datum); return z.tekst; });
    if (z) {
      z.twijfel.forEach(function (t) { twijfel.push({ sleutel: 't:' + t.maand + ':' + t.reden, maand: t.maand, reden: t.reden }); });
      gelijk = z.gelijk;
      if (z.tekst != null && !ok) return { ok: false, reden: 'pagina veranderde tijdens het schrijven', facturen: rijen.length };
      if (z.tekst != null) toegevoegd = z.toegevoegd;
    }
  }
  const nieuwGemeld = [];
  twijfel.forEach(function (t) {
    if (gemeld.indexOf(t.sleutel) >= 0 || nieuwGemeld.indexOf(t.sleutel) >= 0) return;
    if (deps.boxRij(boxTekst(a.klok, t.maand, t.reden))) nieuwGemeld.push(t.sleutel);
  });
  const uit = { ok: true, facturen: rijen.length, toegevoegd: toegevoegd, gelijk: gelijk, twijfel: twijfel.map(function (t) { return t.maand; }) };
  deps.staatZet({ dag: a.datum, gemeld: gemeld.concat(nieuwGemeld), laatste: uit });
  return uit;
}

module.exports = { factuurUit, tabelZet, ronde, rijTekst, P_ENERGIE, KVK_TIBBER };
