// financien-reis.js — OVIS Financiën, idee 3 uit Sure: KOSTEN PER REIS (wv2715; ontwerp vault "01_Ontwikkeling/Financiën - ideeën uit
// Sure (ontwerp 8-11-2026)" § 2). Alleen het idee is geleend; geen code of tekst uit Sure (AGPL) — eigen werk op de eigen delen.
//
// WAAROM. David koos 8-11-2026 "1 t/m 6" uit de ideeën uit Sure. Per reis wil hij zien wat hij kostte: totaal, per categorie, per dag,
// vooraf geboekt vs ter plekke. Een reis loopt dwars door de categorieën (vlucht, eten, tanken), dus het is een label, geen categorie.
//
// VOORSTEL (bij elke vraag opnieuw berekend, niets opgeslagen). De reizen komen van server.js (reizen.js, de reispagina's van Tripper:
// id, titel, van, tot). De boekingen zijn de delen van financien-overzicht.js boekingen() met stroom leven (intern, sparen en aflossen
// tellen niet), zonder vaste last (abonnement_id) en alleen in euro.
//   ter plekke  datum in [van − 2, tot + 2] en (land van de kaartbetaling hoort bij de reislanden, of categorie vakantie en reizen, of een
//               reis-mcc). Reisland = elk land ≠ NL met ≥ 2 kaartbetalingen strikt in [van, tot]: gemeten 8-11 (een korte reis zonder het gezin) gingen de
//               gezinsuitgaven thuis gewoon door, dus "alles in de periode" klopt niet; één losse buitenlandse webwinkel maakt geen reisland.
//               Land alleen bij een kaartbetaling (bunq MASTERCARD: counterparty_alias.country of ", LL" in de omschrijving), niet bij
//               een online betaling (mcc digitale goederen/software/geld overmaken, of een webadres als plaats).
//   vooraf      alleen af, datum in [van − 183, van − 2), categorie vakantie en reizen of een reis-mcc; of een kenmerkend woord uit de
//               reistitel in tegenpartij/omschrijving (dan tot 365 dagen vooraf). Naar de eerstvolgende reis. Geen kaartbetaling in het
//               buitenland (behalve vervoer/reisbureau): dat is ter plekke van een reis, soms een reis zonder reispagina.
//   totaal      = Davids erbij + de voorstellen ter plekke (open = waarvan nog niet bevestigd); een vooraf-voorstel telt pas na zijn ja
//               (vraag_vooraf), want de eerstvolgende reis hoeft niet de goede te zijn.
//   één winnaar (review Codex MOET 1): een boeking hoort bij hooguit één reis. Davids "erbij" wint altijd; dan ter plekke boven vooraf;
//               bij twee reizen ter plekke: strikt in de periode boven de marge, dan de kortste reis, dan de vroegste.
// DAVIDS KEUZE staat in BANK_DIR/transacties.sqlite, tabel reis_label (nr, reis, titel, keuze erbij|eraf, door, aangemaakt); alleen via
// bank-lezer.js app-reislabel. Erbij bij reis X haalt een erbij van dezelfde boeking bij een andere reis weg; null = terug naar het
// voorstel (die rij weg). Een label met een onbekende reis-id (hernoemde pagina) telt bij de reis met precies dezelfde titel.
// MEER (review Codex MOET 2): om zelf toe te voegen — alle leven-boekingen in [van − 2, tot + 30] en uit de 365 dagen vooraf alles met
// vakantie en reizen, een reis-mcc of een woord uit de titel, af én bij (een terugbetaling vóór de reis is zo ook te koppelen).
// Een label zetten mag alleen voor een boeking in dat venster (voorstel of meer) of met een bestaand label bij die reis.
// Geen netwerk, geen taalmodel; transacties en verrijking blijven ongemoeid. Het antwoord gaat alleen naar Davids eigen App.
'use strict';

const MARGE = 2, VOORAF_DAGEN = 183, NAAM_DAGEN = 365, NA_DAGEN = 30, MAX_MEER = 150, MAX_REIZEN = 200;
const REIS_CAT = 'vakantie en reizen';
// reis-mcc: luchtvaart (3000–3299, 4511), hotels (3501–3999, 7011, 7012), autoverhuur (3351–3441, 7512), veerboot/cruise (4411),
// reisbureau (4722), camping (7033)
function reisMcc(m) { const n = Number(m); if (!Number.isInteger(n)) return false; return (n >= 3000 && n <= 3999) || [4411, 4511, 4722, 7011, 7012, 7033, 7512].indexOf(n) >= 0; }
// vervoer en reisbureau: dat boek je vooraf, ook met de kaart bij een buitenlandse aanbieder (een hotel of camping betaal je ter plekke)
function boekMcc(m) { const n = Number(m); if (!Number.isInteger(n)) return false; return (n >= 3000 && n <= 3299) || [4411, 4511, 4722].indexOf(n) >= 0; }
// online betaald (digitale goederen, software, abonnement, geld overmaken), of een webadres als plaats ("primevideo.nl, GB", "amazon.nl, LU"):
// zegt niets over waar je was. Gemeten 8-11: Google Play (IE), Kobo (IE) en Prime Video (GB) maakten van IE en GB een "reisland".
const ONLINE_MCC = [4816, 4829, 5734, 5815, 5816, 5817, 5818, 5968, 7372];
function isOnline(mcc, oms) {
  if (ONLINE_MCC.indexOf(Number(mcc)) >= 0) return true;
  const plek = String(oms || '').split(/,\s[A-Z]{2}(?=\s|$)/)[0];
  return /www\.|\/|\.(com|nl|de|net|org|io|eu|uk|ie|lu|be|fr|co|app)\b/i.test(plek);
}
// woorden uit een reistitel die niets over de bestemming zeggen
const STOP = new Set(['vakantie', 'zomervakantie', 'zomer', 'winter', 'herfst', 'lente', 'voorjaar', 'najaar', 'april', 'augustus', 'september', 'oktober', 'november',
  'december', 'januari', 'februari', 'maart', 'juni', 'juli', 'editie', 'edition', 'trip', 'roadtrip', 'campertrip', 'citytrip', 'stedentrip', 'weekend', 'reis',
  'route', 'goes', 'shizzle', 'summer', 'noorse', 'samen', 'gezin', 'familie', 'vrienden']);

function r2(n) { return Math.round(n * 100) / 100; }
function plusDagen(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function dagenTussen(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
function isDatum(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s + 'T12:00:00Z')); }
function kaal(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function titelWoorden(t) { return Array.from(new Set(kaal(t).split(/[^a-z]+/).filter(function (w) { return w.length >= 5 && !STOP.has(w); }))); }
// een boekingsnummer in de omschrijving: ≥ 6 cijfers, eventueel met -cijfers ("25007161-64556", "Reis 2024060487"); geen lange
// betaalreferentie van 16 cijfers (die is per betaling anders)
function kenmerkVan(oms) {
  const l = String(oms || '').match(/(?<![\dA-Za-z])\d{6,12}(?:-\d{3,8})?(?![\dA-Za-z])/g) || [];
  return l.length ? l[0] : null;
}
function landVan(type, land, oms) {
  if (String(type || '') !== 'MASTERCARD') return null;
  if (/^[A-Z]{2}$/.test(String(land || ''))) return land;
  const m = /,\s([A-Z]{2})(?=\s|$)/.exec(String(oms || ''));
  return m ? m[1] : null;
}

// de reizen van server.js op vorm: id 12 hex, van/tot echte datums (tot ≥ van), niet geannuleerd; titel ≤ 120
function reizenOpVorm(l) {
  const uit = [], gezien = new Set();
  (Array.isArray(l) ? l : []).slice(0, MAX_REIZEN).forEach(function (r) {
    if (!r || typeof r !== 'object' || !/^[0-9a-f]{12}$/.test(String(r.id || '')) || gezien.has(r.id)) return;
    if (!isDatum(r.van) || !isDatum(r.tot) || r.tot < r.van || r.stand === 'geannuleerd') return;
    gezien.add(r.id);
    uit.push({ id: r.id, titel: String(r.titel || '').slice(0, 120) || 'reis', van: r.van, tot: r.tot, dagen: dagenTussen(r.van, r.tot) + 1,
      soort: typeof r.soort === 'string' ? r.soort.slice(0, 20) : null, stand: typeof r.stand === 'string' ? r.stand.slice(0, 20) : null });
  });
  return uit.sort(function (p, q) { return p.van < q.van ? -1 : p.van > q.van ? 1 : p.id < q.id ? -1 : 1; });
}

function labelsLees(a) {
  if (!a.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reis_label'").get()) return [];
  return a.db.prepare('SELECT nr, reis, titel, keuze FROM reis_label').all();
}
function labelTabel(a) {
  a.db.exec("CREATE TABLE IF NOT EXISTS reis_label (nr INTEGER NOT NULL, reis TEXT NOT NULL, titel TEXT, keuze TEXT NOT NULL CHECK (keuze IN ('erbij', 'eraf'))," +
    ' door TEXT NOT NULL, aangemaakt TEXT NOT NULL, PRIMARY KEY (nr, reis))');
}

// de boekingen rond alle reizen: één regel per boeking (som van de leven-delen), met land, mcc en de signalen
function boekingenRond(A, a, reizen, O) {
  if (!reizen.length) return [];
  const van = plusDagen(reizen[0].van, -NAAM_DAGEN), tot = reizen.reduce(function (m, r) { return r.tot > m ? r.tot : m; }, reizen[0].tot);
  const totN = plusDagen(tot, NA_DAGEN);
  const b = O.boekingen(a, van.slice(0, 7), totN.slice(0, 7), null);
  const per = new Map();
  b.delen.forEach(function (x) {
    if (x.stroom !== 'leven' || x.abo || x.datum < van || x.datum > totN) return;
    const k = x.nr;
    if (!per.has(k)) per.set(k, { nr: x.nr, datum: x.datum, kosten: 0, naam: x.tegenpartij || x.omschrijving || 'zonder naam', omschrijving: x.omschrijving || null, categorie: x.cat || null, rekening: x.rekening });
    per.get(k).kosten -= x.deel;
  });
  if (!per.size) return [];
  const extra = new Map();
  a.db.prepare("SELECT nr, mcc, omschrijving, tegenpartij, bedrag, CASE WHEN json_valid(ruwe_json) THEN json_extract(ruwe_json, '$.type') END AS ty," +
    " CASE WHEN json_valid(ruwe_json) THEN json_extract(ruwe_json, '$.counterparty_alias.country') END AS land," +
    " CASE WHEN json_valid(ruwe_json) THEN json_extract(ruwe_json, '$.merchant_category_code') END AS mcc2 FROM transacties WHERE datum >= ? AND datum <= ?").all(van, totN)
    .forEach(function (t) { if (per.has(t.nr)) extra.set(t.nr, { land: landVan(t.ty, t.land, t.omschrijving), mcc: t.mcc || t.mcc2 || null, online: isOnline(t.mcc || t.mcc2, t.omschrijving), tekst: kaal(String(t.tegenpartij || '') + ' ' + String(t.omschrijving || '')),
      kenmerk: t.bedrag < 0 ? kenmerkVan(t.omschrijving) : null, tp: kaal(t.tegenpartij).replace(/[^a-z]+/g, ' ').trim().split(' ').slice(0, 2).join(' ') }); });
  // termijnen van één boeking (aanbetaling + rest): zelfde tegenpartij en hetzelfde boekingsnummer in de omschrijving, ≥ 2 keer
  const tel = new Map();
  extra.forEach(function (e) { if (e.kenmerk && e.tp) { e.groep = e.tp + '|' + e.kenmerk; tel.set(e.groep, (tel.get(e.groep) || 0) + 1); } });
  extra.forEach(function (e) { if (e.groep && tel.get(e.groep) < 2) e.groep = null; });
  return Array.from(per.values()).map(function (x) {
    const e = extra.get(x.nr) || {};
    return Object.assign(x, { kosten: r2(x.kosten), land: e.land || null, online: !!e.online, reismcc: reisMcc(e.mcc), boekmcc: boekMcc(e.mcc), tekst: e.tekst || '', groep: e.groep || null });
  }).filter(function (x) { return x.kosten !== 0; }).sort(function (p, q) { return p.datum < q.datum ? -1 : p.datum > q.datum ? 1 : p.nr - q.nr; });
}

// de toewijzing: per boeking hooguit één reis, met status en waarom. Geeft { per: Map(nr → {reis, status, waarom}), landen: Map(reis → [..]) }
function toewijzen(reizen, rijen, labels) {
  const opId = new Map(reizen.map(function (r) { return [r.id, r]; })), opTitel = new Map();
  reizen.forEach(function (r) { if (!opTitel.has(r.titel)) opTitel.set(r.titel, r); });
  const reisVanLabel = function (l) { return opId.get(l.reis) || (l.titel ? opTitel.get(l.titel) : null) || null; };
  const erbij = new Map(), eraf = new Set();
  labels.forEach(function (l) {
    const r = reisVanLabel(l);
    if (!r) return;
    if (l.keuze === 'erbij') { const o = erbij.get(l.nr); if (!o || opId.has(l.reis)) erbij.set(l.nr, r); }
    else if (l.keuze === 'eraf') eraf.add(l.nr + '|' + r.id);
  });
  // reislanden
  const landen = new Map();
  reizen.forEach(function (r) {
    const tel = new Map();
    rijen.forEach(function (x) { if (x.land && x.land !== 'NL' && !x.online && x.datum >= r.van && x.datum <= r.tot) tel.set(x.land, (tel.get(x.land) || 0) + 1); });
    landen.set(r.id, Array.from(tel.entries()).filter(function (e) { return e[1] >= 2; }).map(function (e) { return e[0]; }).sort());
  });
  const woorden = new Map(reizen.map(function (r) { return [r.id, titelWoorden(r.titel)]; }));
  // termijnen: zette David één termijn erbij, dan volgen de andere van dezelfde boeking als (sterk) voorstel
  const groepReis = new Map();
  rijen.forEach(function (x) { const e = erbij.get(x.nr); if (x.groep && e && !groepReis.has(x.groep)) groepReis.set(x.groep, e); });
  const per = new Map();
  rijen.forEach(function (x) {
    const zet = function (r, status, waarom, vooraf, sterk) { per.set(x.nr, { reis: r.id, status: status, waarom: waarom, vooraf: vooraf, sterk: !!sterk || undefined }); };
    const voor = function (r) { return x.datum < plusDagen(r.van, -MARGE); };
    const e = erbij.get(x.nr);
    if (e) return zet(e, 'erbij', 'jouw keuze', voor(e));
    const g = x.groep ? groepReis.get(x.groep) : null;
    if (g) return zet(g, eraf.has(x.nr + '|' + g.id) ? 'eraf' : 'voorstel', 'andere termijn van een boeking die je erbij zette', voor(g), true);
    // ter plekke
    const tp = reizen.filter(function (r) {
      if (x.datum < plusDagen(r.van, -MARGE) || x.datum > plusDagen(r.tot, MARGE)) return false;
      return (x.land && !x.online && landen.get(r.id).indexOf(x.land) >= 0) || x.categorie === REIS_CAT || x.reismcc;
    }).sort(function (p, q) {
      const ip = x.datum >= p.van && x.datum <= p.tot ? 0 : 1, iq = x.datum >= q.van && x.datum <= q.tot ? 0 : 1;
      return ip - iq || p.dagen - q.dagen || (p.van < q.van ? -1 : p.van > q.van ? 1 : 0);
    });
    if (tp.length) {
      const r = tp[0], waarom = x.land && !x.online && landen.get(r.id).indexOf(x.land) >= 0 ? 'in de reisperiode, in ' + x.land : x.categorie === REIS_CAT ? 'in de reisperiode, vakantie en reizen' : 'in de reisperiode, reisboeking';
      return zet(r, eraf.has(x.nr + '|' + r.id) ? 'eraf' : 'voorstel', waarom, false);
    }
    // vooraf: alleen af, naar de eerstvolgende reis. Een kaartbetaling in het buitenland is geen vooraf-boeking (gemeten 8-11: de
    // uitgaven van een reis zonder reispagina belandden anders bij de volgende reis), behalve vervoer/reisbureau.
    if (!(x.kosten > 0)) return;
    if (x.land && x.land !== 'NL' && !x.boekmcc) return;
    const vk = reizen.filter(function (r) {
      if (!voor(r)) return false;
      const d = dagenTussen(x.datum, r.van);
      const naam = woorden.get(r.id).some(function (w) { return x.tekst.indexOf(w) >= 0; });
      return (naam && d <= NAAM_DAGEN) || ((x.categorie === REIS_CAT || x.reismcc) && d <= VOORAF_DAGEN);
    }).sort(function (p, q) { return p.van < q.van ? -1 : p.van > q.van ? 1 : 0; });
    // Nee bij de eerstvolgende reis = het voorstel schuift door naar de reis daarna; zei David bij alle Nee, dan blijft het bij de eerste (als eraf)
    const vrij = vk.filter(function (r) { return !eraf.has(x.nr + '|' + r.id); });
    if (vk.length) {
      const r = vrij[0] || vk[0], naam = woorden.get(r.id).some(function (w) { return x.tekst.indexOf(w) >= 0; });
      const w = Math.round(dagenTussen(x.datum, r.van) / 7);
      zet(r, eraf.has(x.nr + '|' + r.id) ? 'eraf' : 'voorstel', (naam ? 'naam van de reis' : x.categorie === REIS_CAT ? 'vakantie en reizen' : 'reisboeking') + ', ' + (w <= 1 ? 'vlak' : w + ' weken') + ' vóór vertrek', true);
    }
  });
  return { per: per, landen: landen, woorden: woorden };
}

function post(x, t, elders) {
  const p = { nr: x.nr, datum: x.datum, bedrag: x.kosten, naam: x.naam, omschrijving: x.omschrijving && x.omschrijving !== x.naam ? x.omschrijving : null, categorie: x.categorie, rekening: x.rekening, land: x.land };
  if (t) { p.status = t.status; p.waarom = t.waarom; p.vooraf = t.vooraf; if (t.sterk) p.sterk = true; }
  if (elders) p.elders = elders;
  return p;
}
// Totaal = bevestigd + de voorstellen ter plekke (sterk signaal: in de reisperiode, in het buitenland of een reispost). Een vooraf-voorstel is
// zwakker (de eerstvolgende reis hoeft niet de goede te zijn: gemeten 8-11 viel de vooruitbetaling van een lange zomerreis bij een korte reis ervoor) en telt
// pas mee na Davids ja; tot dan staat het apart als vraag.
function telt(p) { return p.status === 'erbij' || (p.status === 'voorstel' && (!p.vooraf || p.sterk)); }
function samenvatting(r, posten) {
  const tel = posten.filter(telt);
  const som = function (f) { return r2(tel.filter(f).reduce(function (s, p) { return s + p.bedrag; }, 0)); };
  const totaal = som(function () { return true; }), cats = new Map();
  tel.forEach(function (p) { const k = p.categorie || 'nog niet ingedeeld'; cats.set(k, (cats.get(k) || 0) + p.bedrag); });
  return { id: r.id, titel: r.titel, van: r.van, tot: r.tot, dagen: r.dagen, soort: r.soort, stand: r.stand, totaal: totaal,
    bevestigd: som(function (p) { return p.status === 'erbij'; }), open: som(function (p) { return p.status === 'voorstel'; }),
    vraag_vooraf: r2(posten.filter(function (p) { return p.status === 'voorstel' && p.vooraf && !p.sterk; }).reduce(function (s, p) { return s + p.bedrag; }, 0)),
    aantal: { erbij: posten.filter(function (p) { return p.status === 'erbij'; }).length, voorstel: posten.filter(function (p) { return p.status === 'voorstel'; }).length,
      eraf: posten.filter(function (p) { return p.status === 'eraf'; }).length },
    per_dag: r.dagen > 0 ? r2(totaal / r.dagen) : null, vooraf: som(function (p) { return p.vooraf; }), ter_plekke: som(function (p) { return !p.vooraf; }),
    per_categorie: Array.from(cats.entries()).map(function (e) { return { categorie: e[0], bedrag: r2(e[1]) }; }).filter(function (c) { return c.bedrag !== 0; })
      .sort(function (p, q) { return q.bedrag - p.bedrag; }) };
}

// het venster van één reis voor "meer" en voor de schrijfpoort: [van − 2, tot + 30] alles; [van − 365, van − 2) met een reissignaal
function inVenster(r, x, woorden) {
  if (x.datum >= plusDagen(r.van, -MARGE) && x.datum <= plusDagen(r.tot, NA_DAGEN)) return true;
  if (x.datum < plusDagen(r.van, -NAAM_DAGEN) || x.datum >= plusDagen(r.van, -MARGE)) return false;
  return x.categorie === REIS_CAT || x.reismcc || woorden.some(function (w) { return x.tekst.indexOf(w) >= 0; });
}

// o: { reizen (van server.js), reis (id of null), nu }
function reizenOverzicht(A, a, o) {
  const O = o.O || require('./financien-overzicht.js');
  const reizen = reizenOpVorm(o.reizen);
  if (o.reis != null && !reizen.some(function (r) { return r.id === o.reis; })) throw new Error('onbekende reis');
  const rijen = boekingenRond(A, a, reizen, O), tw = toewijzen(reizen, rijen, labelsLees(a));
  const opNr = new Map(rijen.map(function (x) { return [x.nr, x]; })), titel = new Map(reizen.map(function (r) { return [r.id, r.titel]; }));
  const postenVan = function (r) { const l = []; tw.per.forEach(function (t, nr) { if (t.reis === r.id) l.push(post(opNr.get(nr), t)); }); return l.sort(function (p, q) { return p.datum < q.datum ? -1 : p.datum > q.datum ? 1 : p.nr - q.nr; }); };
  // dekking: de eerste boeking op een zichtbare rekening (bunq levert de hele historie, ABN pas vanaf de koppeling)
  const archief = (a.db.prepare("SELECT min(t.datum) AS d FROM transacties t JOIN rekeningen r ON r.rek = t.rek WHERE lower(coalesce(r.eigenaar, '')) NOT IN ('extern', 'pot')").get() || {}).d || null;
  const lijst = reizen.map(function (r) {
    const s = samenvatting(r, postenVan(r));
    s.landen = tw.landen.get(r.id);
    s.dekking = !archief || plusDagen(r.van, -VOORAF_DAGEN) >= archief ? 'heel' : r.tot >= archief ? 'deels' : 'geen';
    return s;
  }).sort(function (p, q) { return p.van < q.van ? 1 : p.van > q.van ? -1 : 0; });
  const uit = { ok: true, peildatum: o.nu || null, reizen: lijst, archief_vanaf: archief,
    regels: { marge_dagen: MARGE, vooraf_dagen: VOORAF_DAGEN, naam_dagen: NAAM_DAGEN },
    uitleg: 'Per reis de uitgaven die erbij horen: in de reisperiode (2 dagen ervoor en erna erbij) alles in het buitenland en alles in vakantie en reizen, ' +
      'en vooraf geboekt (vlucht, verblijf; tot 6 maanden vóór vertrek, of tot een jaar als de naam van de reis erin staat). Thuis gingen de gewone uitgaven door; die tellen niet. ' +
      'Een voorstel uit de reisperiode telt mee tot je Nee tikt; een vooraf-boeking telt pas mee als je Ja tikt (het kan ook een latere reis zijn). ' +
      'Vaste lasten, sparen en geld tussen eigen rekeningen tellen nooit. Cynthia\'s eigen rekeningen zijn niet gekoppeld.' };
  if (o.reis != null) {
    const r = reizen.find(function (x) { return x.id === o.reis; }), posten = postenVan(r);
    const meer = [];
    rijen.forEach(function (x) {
      const t = tw.per.get(x.nr);
      if (t && t.reis === r.id) return;
      if (!inVenster(r, x, tw.woorden.get(r.id))) return;
      meer.push(post(x, null, t ? titel.get(t.reis) : null));
    });
    uit.reis = Object.assign(samenvatting(r, posten), { landen: tw.landen.get(r.id), posten: posten, meer: meer.slice(0, MAX_MEER), meer_aantal: meer.length });
  }
  return uit;
}

// o: { reizen, reis, nr, keuze ('erbij' | 'eraf' | null) }
function labelZet(A, a, o) {
  const O = o.O || require('./financien-overzicht.js');
  if (o.keuze !== null && o.keuze !== 'erbij' && o.keuze !== 'eraf') throw new Error('keuze: erbij, eraf of null');
  const nr = Number(o.nr);
  if (!Number.isSafeInteger(nr) || nr <= 0) throw new Error('onbekende boeking');
  const reizen = reizenOpVorm(o.reizen), r = reizen.find(function (x) { return x.id === o.reis; });
  if (!r) throw new Error('onbekende reis');
  const labels = labelsLees(a);
  const eigen = labels.filter(function (l) { return l.nr === nr && (l.reis === r.id || (l.titel && l.titel === r.titel && !reizen.some(function (x) { return x.id === l.reis; }))); });
  if (!eigen.length) {
    // alleen een boeking uit het venster van deze reis (voorstel of meer); de rest is niet te labelen
    const rijen = boekingenRond(A, a, reizen, O), x = rijen.find(function (y) { return y.nr === nr; });
    if (!x || !inVenster(r, x, titelWoorden(r.titel))) throw new Error('deze boeking valt buiten deze reis');
  }
  labelTabel(a);
  a.db.exec('BEGIN IMMEDIATE');
  try {
    const weg = a.db.prepare('DELETE FROM reis_label WHERE nr = ? AND reis = ?');
    eigen.forEach(function (l) { weg.run(nr, l.reis); });
    // één reis per boeking: een erbij bij een andere reis gaat weg
    if (o.keuze === 'erbij') a.db.prepare("DELETE FROM reis_label WHERE nr = ? AND keuze = 'erbij'").run(nr);
    if (o.keuze !== null) a.db.prepare("INSERT INTO reis_label (nr, reis, titel, keuze, door, aangemaakt) VALUES (?, ?, ?, ?, 'david', ?)").run(nr, r.id, r.titel, o.keuze, new Date().toISOString());
    a.db.exec('COMMIT');
  } catch (e) { try { a.db.exec('ROLLBACK'); } catch (e2) { /* al terug */ } throw e; }
  return { reis: r.id, nr: nr, keuze: o.keuze };
}

module.exports = { reizenOverzicht: reizenOverzicht, labelZet: labelZet, reizenOpVorm: reizenOpVorm, toewijzen: toewijzen, titelWoorden: titelWoorden, landVan: landVan, reisMcc: reisMcc,
  MARGE: MARGE, VOORAF_DAGEN: VOORAF_DAGEN, NAAM_DAGEN: NAAM_DAGEN };
