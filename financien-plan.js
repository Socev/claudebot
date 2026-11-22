// financien-plan.js — OVIS Financiën, drie ideeën die David koos uit Sure (wv2706; ontwerp vault "01_Ontwikkeling/Financiën - ideeën uit
// Sure (ontwerp 8-11-2026)"). Alleen het idee is geleend; geen code of tekst uit Sure (AGPL) — dit is eigen werk op de eigen delen.
//
// WAAROM. David 8-11-2026 koos "1 t/m 6" uit de keuzelijst. Dit bestand doet de drie kleine (2, 4 en 5):
//   potjes      (2) een bedrag per maand per uitgavencategorie dat David zelf kiest, met balk (uitgegeven / beschikbaar) en "doorschuiven":
//               wat overblijft (of te veel is) schuift door naar de volgende maand, vanaf de maand waarin het potje begon (hooguit 12
//               volle maanden terug). Bedragen staan op de vaultpagina 20_Prive/Financien/Potjes.md (tabel Post | Per maand |
//               Doorschuiven | Vanaf), zodat David ze ook zonder App leest en bewerkt; potjesZet bewerkt alleen die tabel (puur), server.js
//               schrijft via vault-veilig (POST /app/financien/potje). Zonder potje: een voorstel = het 12-maandsgemiddelde, naar boven
//               afgerond op € 10.
//   afvinken    (4) de vaste lasten van deze maand (de actieve reeksen van de vaste-lastenrekening, bank-archief.js) als lijstje:
//               betaald / ander bedrag / nog niet / te laat. Verwacht deze maand = betaald deze maand, of de volgende verwachte post
//               (verwacht_volgende) valt in of vóór deze maand. Te laat = niet betaald en de peildatum ligt meer dan 5 dagen na de
//               verwachte dag. Ander bedrag = buiten de bandbreedte (wisselend: tussen 90 % van het laagste en 110 % van het hoogste
//               bedrag; anders meer dan € 1 én 3 % ernaast).
//   geldstroom  (5) waar het geld van één maand (laatste volle maand, of gemiddeld over 12) vandaan kwam en heen ging, voor een
//               Sankey-plaatje: bronnen (inkomen per categorie, terugbetalingen, geld uit sparen/de BV's, "uit het saldo") → bestemmingen
//               (leven per categorie, de 7 grootste + "overige uitgaven", aflossing, sparen/BV's, "bleef over"). Intern telt niet. Som
//               bronnen = som bestemmingen (toets); de balans is precies inkomen + leven + verschuiven van die maand.
// Geen netwerk, geen taalmodel; schrijft zelf niets. Het antwoord gaat alleen naar Davids eigen App (GET /app/financien).
'use strict';
const fs = require('fs'), path = require('path');

const P_POTJES = path.join('20_Prive', 'Financien', 'Potjes.md');
const POTJE_KOP = ['Post', 'Per maand', 'Doorschuiven', 'Vanaf'];
// de categorieën waar een potje op kan (de uitgavencategorieën van financien-overzicht.js, zonder intern/terugbetaling)
const POTJE_CATS = ['wonen', 'verzekeringen', 'boodschappen', 'huishouden', 'vervoer', 'abonnementen en communicatie', 'kinderen', 'gezondheid', 'vrije tijd en sport',
  'horeca en uit eten', 'vakantie en reizen', 'kleding en persoonlijk', 'cadeaus en goede doelen', 'belastingen', 'bankkosten', 'contant geld', 'Gambia-hulp',
  'creditcard (niet uitgesplitst)', 'overig'];
const MAX_TERUG = 12, BIJNA = 0.85;
const TE_LAAT_DAGEN = 5, AFWIJK_EUR = 1, AFWIJK_PCT = 0.03;
const TOP_LEVEN = 8;

function r2(n) { return Math.round(n * 100) / 100; }
function maandPlus(m, n) { const j = Number(m.slice(0, 4)), x = Number(m.slice(5, 7)) - 1 + n; return (j + Math.floor(x / 12)) + '-' + String(((x % 12) + 12) % 12 + 1).padStart(2, '0'); }
function dagenIn(m) { return new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate(); }
function plusDagen(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function cel(s, n) { return String(s == null ? '' : s).replace(/[|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 60).trim(); }
function catVan(s) { const x = cel(s, 40).toLowerCase(); return POTJE_CATS.find(function (c) { return c.toLowerCase() === x; }) || null; }
// een cel uit de tabel zoals potjesLees hem leest (wikilink, vet en andere opmaak weg; review ZOU 3)
function catVanCel(s) { return catVan(require('./financien-vault.js').schoon(s, 60)); }

// ── 2. potjes ──
function potjesLees(vault, FV) {
  const p = path.join(vault, P_POTJES);
  let st;
  try { st = fs.statSync(p); } catch (e) { if (e.code === 'ENOENT') return { pagina: null, potjes: [] }; throw e; }
  if (!st.isFile() || st.size > 200000) throw new Error('potjespagina geen gewoon bestand');
  const rijen = FV.tabel(FV.tabellen(fs.readFileSync(p, 'utf8')), ['post', 'per maand']) || [];
  const gezien = new Set(), uit = [];
  rijen.forEach(function (r) {
    const cat = catVan(FV.schoon(r.post, 40)), bedrag = FV.nlGetal(r['per maand']);
    if (!cat || !(bedrag > 0) || gezien.has(cat)) return;
    gezien.add(cat);
    const v = /^(\d{1,2})-(\d{4})$/.exec(FV.schoon(r.vanaf || '', 10)) || /^(\d{4})-(\d{2})$/.exec(FV.schoon(r.vanaf || '', 10));
    const vanaf = v ? (v[1].length === 4 ? v[1] + '-' + v[2] : v[2] + '-' + v[1].padStart(2, '0')) : null;
    uit.push({ categorie: cat, bedrag: r2(bedrag), doorschuiven: /^(ja|j|x|aan|yes|✓)$/i.test(FV.schoon(r.doorschuiven || '', 10)), vanaf: vanaf && /^\d{4}-(0[1-9]|1[0-2])$/.test(vanaf) ? vanaf : null });
  });
  return { pagina: P_POTJES, potjes: uit };
}
// uitgegeven per categorie per maand (stroom leven, netto, positief = uitgegeven)
function perCatMaand(delen) {
  const m = new Map();
  delen.forEach(function (x) {
    if (x.stroom !== 'leven') return;
    const k = (x.cat || '-') + '|' + x.maand;
    m.set(k, (m.get(k) || 0) - x.deel);
  });
  return m;
}
// o: { mNu, twaalf (volle maanden, oud → nieuw), nu (peildatum), vault, fv }
function potjes(delen, o) {
  const FV = o.fv || require('./financien-vault.js');
  const l = potjesLees(o.vault, FV), pc = perCatMaand(delen), mNu = o.mNu, twaalf = o.twaalf || [], mVol = twaalf[twaalf.length - 1] || null;
  const uitg = function (cat, m) { return r2(pc.get(cat + '|' + m) || 0); };
  const gem = function (cat) { return twaalf.length ? r2(twaalf.reduce(function (s, m) { return s + uitg(cat, m); }, 0) / twaalf.length) : null; };
  const dag = Number(String(o.nu || '').slice(8, 10)) || null, tempo = dag ? Math.min(1, dag / dagenIn(mNu)) : null;
  const posten = l.potjes.map(function (p) {
    let over_vorig = 0, maanden = 0;
    if (p.doorschuiven) {
      const start = p.vanaf && p.vanaf > maandPlus(mNu, -MAX_TERUG) ? p.vanaf : maandPlus(mNu, -MAX_TERUG);
      for (let m = start; m < mNu; m = maandPlus(m, 1)) { if (o.vanafArchief && m < o.vanafArchief) continue; over_vorig += p.bedrag - uitg(p.categorie, m); maanden++; }
    }
    over_vorig = r2(over_vorig);
    const beschikbaar = r2(p.bedrag + over_vorig), uitgegeven = uitg(p.categorie, mNu), rest = r2(beschikbaar - uitgegeven);
    const pct = beschikbaar > 0 ? Math.round(uitgegeven / beschikbaar * 100) : null;
    const status = rest < 0 ? 'over' : pct != null && pct >= BIJNA * 100 ? 'bijna' : tempo != null && beschikbaar > 0 && uitgegeven > beschikbaar * tempo + Math.max(25, 0.15 * beschikbaar) ? 'snel' : 'ok';
    return { categorie: p.categorie, bedrag: p.bedrag, doorschuiven: p.doorschuiven, vanaf: p.vanaf, over_vorig: p.doorschuiven ? over_vorig : null, maanden_geschoven: p.doorschuiven ? maanden : null,
      beschikbaar: beschikbaar, uitgegeven: uitgegeven, rest: rest, pct: pct, status: status, gem12: gem(p.categorie), vorige: mVol ? uitg(p.categorie, mVol) : null,
      filter: { van: mNu, tot: mNu, stroom: 'leven', cat: p.categorie } };
  });
  const met = new Set(posten.map(function (p) { return p.categorie; }));
  const voorstellen = POTJE_CATS.filter(function (c) { return !met.has(c); }).map(function (c) { const g = gem(c); return { categorie: c, gem12: g, voorstel: g > 0 ? Math.ceil(g / 10) * 10 : null, lopend: uitg(c, mNu) }; })
    .filter(function (v) { return v.voorstel; }).sort(function (p, q) { return q.gem12 - p.gem12; });
  const som = function (k) { return r2(posten.reduce(function (s, p) { return s + (p[k] || 0); }, 0)); };
  return { pagina: l.pagina || P_POTJES, bestaat: !!l.pagina, maand: mNu, peildatum: o.nu || null, tempo: tempo != null ? Math.round(tempo * 100) : null, posten: posten, voorstellen: voorstellen,
    totaal: { bedrag: som('bedrag'), beschikbaar: som('beschikbaar'), uitgegeven: som('uitgegeven'), rest: som('rest') }, categorieen: POTJE_CATS,
    uitleg: 'Een potje is het bedrag dat je per maand voor een post wilt uitgeven. Uitgegeven = wat het gezin deze maand in die categorie uitgaf (terugbetalingen eraf). ' +
      'Doorschuiven: wat een maand overbleef komt er de volgende maand bij, en wat je te veel uitgaf gaat er de volgende maand af (vanaf de maand in Vanaf, hooguit 12 maanden terug). ' +
      'Voorstel = het gemiddelde van de laatste 12 maanden, naar boven afgerond op € 10. De bedragen staan op de pagina Potjes in je Second Brain.' };
}
// ── potjes schrijven (puur; server.js leest en schrijft via vault-veilig) ──
const SJABLOON = '---\ntype: overzicht\ndomein: Privé\nonderwerp: Potjes per post (OVIS Financiën › Uitgaven › Potjes)\ntags: [prive, financien, potjes]\nupdated: {datum}\n---\n\n' +
  '# Potjes\n\nDe App Financiën › Uitgaven › Potjes leest en schrijft de tabel hieronder; je kunt hem ook hier zelf bewerken. **Post** is een uitgavencategorie zoals in ' +
  'Financiën (bijvoorbeeld boodschappen, horeca en uit eten). **Per maand** is het bedrag dat je per maand wilt uitgeven. **Doorschuiven** ja: wat overblijft (of te veel ' +
  'is) schuift door naar de volgende maand, vanaf de maand in **Vanaf** (mm-jjjj).\n\n## Potjes\n\n';
function tabelRegel(c) { return '| ' + c.join(' | ') + ' |'; }
function nlBedrag(n) { const v = Math.abs(r2(n)), d = v.toFixed(2).split('.'); return '€ ' + d[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (d[1] !== '00' ? ',' + d[1] : ''); }
function nlMaand(m) { return m.slice(5, 7) + '-' + m.slice(0, 4); }
// op: { actie: 'zet', potje: { categorie, bedrag, doorschuiven, vanaf } } (nieuw of vervangen) of { actie: 'weg', categorie }
function potjesZet(tekst, op, nu) {
  const vandaag = nu || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  let t = tekst == null || tekst === '' ? SJABLOON.replace('{datum}', vandaag) : String(tekst);
  const regels = t.split('\n');
  const k = regels.findIndex(function (r) { const c = r.trim().replace(/^\||\|$/g, '').split('|').map(function (x) { return x.trim().toLowerCase(); }); return c[0] === 'post' && c[1] === 'per maand'; });
  if (k < 0) {
    t = /\n## Potjes\s*\n/.test('\n' + t) ? t.replace(/\s*$/, '\n\n') : t.replace(/\s*$/, '\n\n## Potjes\n\n');
    t += tabelRegel(POTJE_KOP) + '\n' + tabelRegel(POTJE_KOP.map(function () { return '---'; })) + '\n';
    return potjesZet(t, op, vandaag);
  }
  let eind = k + 2;
  while (eind < regels.length && /^\s*\|/.test(regels[eind])) eind++;
  const rijen = regels.slice(k + 2, eind);
  // review ZOU 2: de kolommen op naam (David kan de volgorde zelf veranderen); ontbreekt er een, dan niet schrijven
  const kop = regels[k].trim().replace(/^\||\|$/g, '').split('|').map(function (x) { return x.trim().toLowerCase(); });
  const ix = { post: kop.indexOf('post'), bedrag: kop.indexOf('per maand'), door: kop.indexOf('doorschuiven'), vanaf: kop.indexOf('vanaf') };
  if (ix.door < 0 || ix.vanaf < 0) throw new Error('de tabel mist een kolom (Post, Per maand, Doorschuiven, Vanaf)');
  const cellen = function (r) { return r.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/); };   // \| in een wikilink is geen celgrens
  const catVanRij = function (r) { return catVanCel(cellen(r)[ix.post] || ''); };
  let nieuw;
  if (op.actie === 'weg') {
    const c = catVan(op.categorie);
    nieuw = rijen.filter(function (r) { return catVanRij(r) !== c; });
    if (!c || nieuw.length === rijen.length) throw new Error('potje niet gevonden');
  } else if (op.actie === 'zet') {
    const p = op.potje || {}, c = catVan(p.categorie);
    if (!c) throw new Error('onbekende post');
    const c4 = new Array(kop.length).fill('');
    c4[ix.post] = c; c4[ix.bedrag] = nlBedrag(p.bedrag); c4[ix.door] = p.doorschuiven ? 'ja' : 'nee'; c4[ix.vanaf] = nlMaand(p.vanaf || vandaag.slice(0, 7));
    const regel = tabelRegel(c4);
    // alle rijen van deze post gaan eruit (een dubbele rij zou potjesLees anders laten kiezen), de nieuwe komt op de plek van de eerste
    const i = rijen.findIndex(function (r) { return catVanRij(r) === c; });
    if (i < 0 && rijen.length >= 40) throw new Error('hooguit 40 potjes');
    const rest = rijen.filter(function (r) { return catVanRij(r) !== c; });
    nieuw = i < 0 ? rijen.concat([regel]) : rest.slice(0, i).concat([regel], rest.slice(i));
  } else throw new Error('onbekende actie');
  const uit = regels.slice(0, k + 2).concat(nieuw, regels.slice(eind)).join('\n');
  return /^---\n[\s\S]*?\nupdated:/.test(uit) ? uit.replace(/(^---\n[\s\S]*?\nupdated:)[^\n]*/, '$1 ' + vandaag) : uit;
}
// invoer uit de App op vorm (server.js gebruikt dit vóór het schrijven); vanaf blijft bij vervangen de oude maand als die er is
function potjeInvoer(p, nu, oud) {
  if (!p || typeof p !== 'object') throw new Error('geen potje');
  const c = catVan(p.categorie);
  if (!c) throw new Error('post: kies een categorie uit de lijst');
  const bedrag = Number(p.bedrag);
  if (!(bedrag >= 1 && bedrag <= 100000)) throw new Error('bedrag: € 1 tot € 100.000 per maand');
  const vorige = oud && oud.vanaf && oud.doorschuiven && !!p.doorschuiven ? oud.vanaf : null;
  return { categorie: c, bedrag: r2(bedrag), doorschuiven: !!p.doorschuiven, vanaf: vorige || nu.slice(0, 7) };
}

// ── 4. rekeningen deze maand afvinken ──
// reeksen = actieve reeksen (bank-archief reeksenBereken) op de peildatum; rijen = A.rijenVan(reeksen) (ruw); lasten = vastePosten().lasten;
// naam(rij) = de weergavenaam van financien-app.js; overslaan(rij) = true voor een PayPal-paraplu (gemengd, geen vaste post)
// de volgende verwachte post van een reeks: verwacht_volgende van bank-archief, maar nooit vóór de laatste post + één ritme (gemeten 8-11:
// een zorgverzekering betaald op 27-10 had verwacht_volgende 28-10 omdat de ritmeposten op 28-9 stopten → vals "te laat")
function volgendeVan(r) {
  const stap = r.ritme === 'kwartaal' ? 3 : r.ritme === 'jaar' ? 12 : 1;
  let v = r.verwacht_volgende || null;
  if (!v) return null;   // geen verwachte post = niet actief (bank-archief zet hem alleen bij een actieve reeks)
  if (r.laatste && /^\d{4}-\d{2}-\d{2}$/.test(r.laatste)) {
    const d = new Date(r.laatste + 'T12:00:00Z'), dg = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + stap);
    const m = d.toISOString().slice(0, 7), na = m + '-' + String(Math.min(dg, dagenIn(m))).padStart(2, '0');
    if (!v || na > v) v = na;
  }
  return v;
}
function afvinken(o) {
  const nu = o.nu, mNu = nu.slice(0, 7), van = mNu + '-01', tot = mNu + '-' + String(dagenIn(mNu)).padStart(2, '0');
  const perNr = new Map((o.lasten || []).map(function (t) { return [t.nr, t]; }));
  const posten = [];
  (o.rijen || []).forEach(function (x) {
    if (o.overslaan && o.overslaan(x)) return;
    const rs = (o.reeksen || []).filter(function (r) { return x.sleutels.indexOf(r.sleutel) >= 0; });
    if (!rs.length) return;
    // per reeks: aan de beurt als hij deze maand al betaald is of zijn volgende verwachte post in of vóór deze maand valt (review: niet de
    // vroegste datum over alle reeksen van een rij: een losse extra post met een eigen reeks maakte de hele rij "te laat")
    const betaald = [], beurt = [];
    rs.forEach(function (r) {
      const eigen = [];
      // review ZOU 1: alleen de gewone posten (hoofd, voorlopig); een afrekening of losse extra maakt een kloppende post niet tot 'ander bedrag'
      if (r.nrs) r.nrs.forEach(function (soort, nr) { const t = perNr.get(nr); if (t && (soort === 'hoofd' || soort === 'voorlopig') && t.datum >= van && t.datum <= tot && t.bedrag < 0) eigen.push(t); });
      const vv = volgendeVan(r);
      if (eigen.length || (vv && vv <= tot)) { beurt.push({ r: r, vv: vv, betaald: eigen }); eigen.forEach(function (t) { betaald.push(t); }); }
    });
    if (!beurt.length) return;   // deze maand niet aan de beurt (kwartaal, jaar, termijnen voorbij)
    const dag = Math.min(dagenIn(mNu), Math.max(1, x.dag | 0 || 1));
    const open = beurt.filter(function (b) { return !b.betaald.length; });
    // de verwachte dag: de volgende post als die in of vóór deze maand valt; al betaald (volgende = volgende maand) = de gebruikelijke dag
    const datumVan = function (b) { return b.vv && b.vv <= tot ? b.vv : mNu + '-' + String(Math.min(dagenIn(mNu), Math.max(1, b.r.dag | 0 || dag))).padStart(2, '0'); };
    const verwacht = (open.length ? open : beurt).map(datumVan).sort()[0];
    const bedragV = r2(beurt.reduce(function (s, b) { return s + b.r.bedrag * (b.r.ritme === 'maand' ? (b.r.n_per_maand || 1) : 1); }, 0));
    const nodig = beurt.reduce(function (s, b) { return s + (b.r.ritme === 'maand' ? (b.r.n_per_maand || 1) : 1); }, 0);
    const som = r2(-betaald.reduce(function (s, t) { return s + t.bedrag; }, 0));
    let status;
    if (betaald.length && open.length === 0 && betaald.length >= nodig) {
      const wissel = beurt.length === 1 && (x.wijze === 'wisselend' || x.wijze === 'schommelt');
      const binnen = wissel && x.bedrag_min != null && x.bedrag_max != null ? som >= 0.9 * x.bedrag_min - 0.005 && som <= 1.1 * x.bedrag_max + 0.005
        : !(Math.abs(som - bedragV) > AFWIJK_EUR && Math.abs(som - bedragV) > AFWIJK_PCT * bedragV);
      status = binnen ? 'betaald' : 'ander_bedrag';
    } else if (betaald.length && som > bedragV + Math.max(AFWIJK_EUR, AFWIJK_PCT * bedragV)) status = 'ander_bedrag';
    // review wv2706 MOET: deels betaald (cluster, 1 van 3) blijft deels tot de maand om is; de andere posten horen later in de maand
    else if (betaald.length) status = nu > plusDagen(tot, TE_LAAT_DAGEN) ? 'te_laat' : 'deels';
    else status = nu > plusDagen(verwacht, TE_LAAT_DAGEN) ? 'te_laat' : 'nog_niet';
    const laatst = betaald.slice().sort(function (p, q) { return p.datum < q.datum ? 1 : -1; })[0];
    posten.push({ naam: o.naam ? o.naam(x) : x.naam || 'zonder naam', soort_post: x.soort_post || null, ritme: x.ritme, verwacht_op: verwacht, bedrag: r2(bedragV),
      wisselend: x.wijze === 'wisselend' || x.wijze === 'schommelt' || undefined, status: status, betaald: betaald.length ? som : null, betaald_op: laatst ? laatst.datum : null, keer: betaald.length, verwacht_keer: nodig > 1 ? nodig : undefined });
  });
  const volg = { te_laat: 0, ander_bedrag: 1, deels: 2, nog_niet: 3, betaald: 4 };
  posten.sort(function (p, q) { return volg[p.status] - volg[q.status] || (p.verwacht_op < q.verwacht_op ? -1 : p.verwacht_op > q.verwacht_op ? 1 : q.bedrag - p.bedrag); });
  const tel = function (s) { return posten.filter(function (p) { return p.status === s; }).length; };
  return { maand: mNu, peildatum: nu, posten: posten,
    telling: { betaald: tel('betaald'), ander_bedrag: tel('ander_bedrag'), deels: tel('deels'), nog_niet: tel('nog_niet'), te_laat: tel('te_laat') },
    nog_te_gaan: r2(posten.filter(function (p) { return p.status === 'nog_niet' || p.status === 'te_laat' || p.status === 'deels'; }).reduce(function (s, p) { return s + Math.max(0, p.bedrag - (p.betaald || 0)); }, 0)),
    uitleg: 'De vaste lasten van de gezamenlijke rekening die deze maand aan de beurt zijn. Te laat = nog niet afgeschreven, ' + TE_LAAT_DAGEN + ' dagen na de gebruikelijke dag (de bank loopt soms een dag achter). ' +
      'Ander bedrag = meer dan € ' + AFWIJK_EUR + ' én ' + Math.round(AFWIJK_PCT * 100) + ' % naast het gebruikelijke bedrag (bij een wisselende post: buiten het bereik van het afgelopen jaar).' };
}

// ── 5. geldstroom (Sankey) ──
const NAAM_IN = { inkomen: 'inkomen (loon en vergoedingen)', '-': 'binnengekomen, nog niet ingedeeld' };
const NAAM_LEVEN = { overig: 'overig (niet ingedeeld)' };
function geldstroomVan(delen, maanden) {
  const set = new Set(maanden), n = maanden.length || 1;
  const bron = new Map(), best = new Map();
  const bij = function (m, k, v, soort) { const x = m.get(k) || { naam: k, bedrag: 0, soort: soort }; x.bedrag += v; m.set(k, x); };
  const leven = new Map();
  let ink = 0, lev = 0, ver = 0;
  delen.forEach(function (x) {
    if (!set.has(x.maand) || x.stroom === 'intern') return;
    if (x.stroom === 'inkomen') {
      ink += x.deel;
      const k = x.sub === 'buiten_zicht' ? 'van/naar eigen rekeningen buiten zicht' : (NAAM_IN[x.cat || '-'] || x.cat);
      bij(bron, k, x.deel, 'inkomen');
    } else if (x.stroom === 'leven') {
      lev += x.deel;
      const k = NAAM_LEVEN[x.cat] || x.cat || 'nog niet ingedeeld';
      leven.set(k, (leven.get(k) || 0) + x.deel);
    } else if (x.stroom === 'verschuiven') {
      ver += x.deel;
      bij(bron, x.sub === 'verplicht' ? 'aflossing hypotheek' : 'sparen, beleggen en de eigen BV\'s', x.deel, 'verschuiven');
    }
  });
  // leven: netto per categorie; netto binnen (terugbetaling) = bron
  const uitL = [];
  leven.forEach(function (v, k) { if (v < 0) uitL.push({ naam: k, bedrag: -v }); else if (v > 0) bij(bron, k === 'teruggave en terugbetaling' ? 'terugbetalingen' : k + ' (terug)', v, 'leven'); });
  uitL.sort(function (p, q) { return q.bedrag - p.bedrag; });
  const top = uitL.slice(0, TOP_LEVEN), rest = uitL.slice(TOP_LEVEN).reduce(function (s, x) { return s + x.bedrag; }, 0);
  top.forEach(function (x) { best.set(x.naam, { naam: x.naam, bedrag: x.bedrag, soort: 'leven' }); });
  if (rest > 0) best.set('andere categorieën', { naam: (uitL.length - TOP_LEVEN) + ' andere categorieën', bedrag: rest, soort: 'leven', aantal: uitL.length - TOP_LEVEN });
  // een bron met een negatief saldo (geld de deur uit via inkomen buiten zicht of verschuiven) is een bestemming
  bron.forEach(function (x, k) { if (x.bedrag < 0) { bron.delete(k); best.set(k, { naam: x.soort === 'inkomen' && !/buiten zicht/.test(k) ? k + ' (terugbetaald)' : k, bedrag: -x.bedrag, soort: x.soort }); } });
  const balans = ink + lev + ver;
  if (balans > 0.005) best.set('bleef over', { naam: 'bleef over (saldo omhoog)', bedrag: balans, soort: 'over' });
  else if (balans < -0.005) bron.set('uit het saldo', { naam: 'uit het saldo (saldo omlaag)', bedrag: -balans, soort: 'saldo' });
  const lijst = function (m) {
    return Array.from(m.values()).filter(function (x) { return x.bedrag / n >= 0.005; }).map(function (x) { return Object.assign({}, x, { bedrag: r2(x.bedrag / n) }); })
      .sort(function (p, q) { return (p.soort === 'over' || p.soort === 'saldo') - (q.soort === 'over' || q.soort === 'saldo') || q.bedrag - p.bedrag; });
  };
  const b = lijst(bron), d = lijst(best);
  const sb = r2(b.reduce(function (s, x) { return s + x.bedrag; }, 0)), sd = r2(d.reduce(function (s, x) { return s + x.bedrag; }, 0));
  // afronding per regel: het verschil (hooguit centen) bij de grootste regel aan de kleinste kant, zodat beide kanten even breed zijn
  if (Math.abs(sb - sd) > 0 && Math.abs(sb - sd) < 0.5) { const z = sb < sd ? b : d; if (z.length) z[0].bedrag = r2(z[0].bedrag + Math.abs(sb - sd)); }
  return { bronnen: b, bestemmingen: d, totaal: r2(Math.max(sb, sd)), inkomen: r2(ink / n), leven: r2(-lev / n), verschuiven: r2(ver / n), balans: r2(balans / n) };
}
function geldstroom(delen, o) {
  const twaalf = o.twaalf || [], mVol = twaalf[twaalf.length - 1] || null;
  if (!mVol) return null;
  return { maand: mVol, maanden: twaalf.length, van: twaalf[0], tot: mVol, maand_stroom: geldstroomVan(delen, [mVol]), gemiddeld: geldstroomVan(delen, twaalf),
    uitleg: 'Links waar het geld vandaan kwam, rechts waar het heen ging. Geld tussen je eigen gekoppelde rekeningen telt niet. "Bleef over" of "uit het saldo" is het verschil: ' +
      'zoveel steeg of daalde het saldo van de zichtbare rekeningen door deze stromen. Cynthia\'s eigen rekeningen zijn niet gekoppeld.' };
}

// ── 6. Nu en straks (wv3924, besluitenpagina nr 151 = 2C51; Fable "Een 9 - financien" F2; David Ja 22-11-2026 18:22) ──
// Drie zinnen bovenaan Financiën › Overzicht, elke keer anders dan het vorige bezoek:
//   dezeMaand  de lopende maand tot de peildag: leven (zonder eenmalig groot) en inkomen (zonder jaarposten) tegen het gemiddelde van de 12
//              volledige maanden op dezelfde dag van de maand (een kortere maand telt tot zijn laatste dag). Binnen € 100 of 10 % = "ongeveer".
//   recent     de boekingen die de bank-ronde de laatste 21 dagen voor het eerst zag (transacties.eerste_gezien) met een boekdatum in de
//              laatste 35 dagen (een later gekoppelde rekening met jaren historie telt zo niet als "nieuw"), per boeking één regel met
//              "ongewoon" (uitschieter, eenmalig groot, eenmalig inkomen of een nieuwe tegenpartij ≥ € 250). nieuwSinds (server.js, per verzoek)
//              telt daaruit wat er sinds Davids laatste bezoek bijkwam; het bezoek zelf zet de App met POST /app/financien/gezien.
//   komende    de vaste posten van de vaste-lastenrekening (dezelfde actieve reeksen als afvinken) met hun volgende verwachte post in de
//              komende 14 dagen, plus wat al verwacht was en nog niet gezien (hooguit 20 dagen terug), tegen het laatste saldo en de vaste
//              storting die in die 14 dagen hoort te komen. Laagste stand op volgorde van datum; haalt = laagste ≥ 0. Leunt NIET op de
//              12-maandenprognose van financien-vooruit.js (die volgens de fin-planner-review te rooskleurig is, 2B93 nog open), wel op
//              verwachte bedragen: daarom "naar schatting" in de zin.
const NU_RAND_EUR = 100, NU_RAND_PCT = 0.1, KOMENDE_DAGEN = 14, KOMENDE_TERUG = 20, RECENT_DAGEN = 21, RECENT_BOEK_DAGEN = 35, RECENT_MAX = 400, NIEUW_TP_MIN = 250;
const MND_KORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
function eurRond(n) { return '€ ' + String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
function dagKort(d) { return Number(d.slice(8, 10)) + ' ' + MND_KORT[Number(d.slice(5, 7)) - 1]; }
function naamKort(s) { return cel(s, 30) || 'zonder naam'; }
function dezeMaand(delen, o) {
  const nu = o.nu, mNu = nu.slice(0, 7), dag = Number(nu.slice(8, 10)), twaalf = o.twaalf || [];
  const per = new Map();
  (delen || []).forEach(function (x) { if (!per.has(x.maand)) per.set(x.maand, []); per.get(x.maand).push(x); });
  const tel = function (m, totDag) {
    const s = { uit: 0, eenmalig: 0, in: 0, jaar: 0 };
    (per.get(m) || []).forEach(function (x) {
      if (Number(String(x.datum).slice(8, 10)) > totDag) return;
      if (x.stroom === 'leven') { if (x.eenmalig) s.eenmalig -= x.deel; else s.uit -= x.deel; }
      else if (x.stroom === 'inkomen') { if (x.jaar) s.jaar += x.deel; else s.in += x.deel; }
    });
    return s;
  };
  const n = tel(mNu, dag);
  const uit = { maand: mNu, tot_dag: nu, uitgegeven: r2(n.uit), eenmalig: r2(n.eenmalig), binnen: r2(n.in), jaarpost: r2(n.jaar), maanden: twaalf.length };
  let zin = 'Deze maand tot nu (t/m ' + dagKort(nu) + '): ' + eurRond(n.uit) + ' uitgegeven';
  if (twaalf.length >= 3) {
    const l = twaalf.map(function (m) { return tel(m, Math.min(dag, dagenIn(m))); });
    const gUit = l.reduce(function (z, s) { return z + s.uit; }, 0) / l.length, gIn = l.reduce(function (z, s) { return z + s.in; }, 0) / l.length;
    const d = n.uit - gUit, rand = Math.max(NU_RAND_EUR, NU_RAND_PCT * Math.abs(gUit));
    uit.gewoon_uitgegeven = r2(gUit); uit.gewoon_binnen = r2(gIn);
    uit.oordeel = Math.abs(d) <= rand ? 'gelijk' : d < 0 ? 'minder' : 'meer';
    zin += uit.oordeel === 'gelijk' ? ', ongeveer wat een gewone maand op deze dag kost (' + eurRond(gUit) + ').'
      : ', ' + eurRond(d) + ' ' + uit.oordeel + ' dan een gewone maand op deze dag (' + eurRond(gUit) + ').';
    if (n.eenmalig > 0.5) zin += ' Daarbovenop ' + eurRond(n.eenmalig) + ' eenmalig groot.';
    const dIn = n.in - gIn, randIn = Math.max(NU_RAND_EUR, NU_RAND_PCT * Math.abs(gIn));
    zin += ' Binnengekomen: ' + eurRond(n.in) + (Math.abs(dIn) <= randIn ? ', zoals gewoonlijk' : ' (gewoonlijk ' + eurRond(gIn) + ' op deze dag)');
  } else {
    uit.oordeel = null;
    if (n.eenmalig > 0.5) zin += ', plus ' + eurRond(n.eenmalig) + ' eenmalig groot';
    zin += '; binnengekomen ' + eurRond(n.in) + ' (te weinig volle maanden om met een gewone maand te vergelijken)';
  }
  if (n.jaar > 0.5) zin += ', plus ' + eurRond(n.jaar) + ' dividend of ander eenmalig inkomen';
  uit.zin = zin.replace(/\.?$/, '.');
  uit.toon = uit.oordeel === 'meer' ? 'let' : 'goed';
  return uit;
}
// gezien = [{ nr, eerste_gezien }] (de query in financien-overzicht.js); uitschieters = uitgaven.uitschieters (datum, filter.id, bedrag)
function recentVan(delen, o) {
  const per = new Map(), eerst = new Map();
  (delen || []).forEach(function (x) {
    if (!per.has(x.nr)) per.set(x.nr, []);
    per.get(x.nr).push(x);
    if (x.id && (!eerst.has(x.id) || x.datum < eerst.get(x.id))) eerst.set(x.id, x.datum);
  });
  const uitsch = new Set((o.uitschieters || []).map(function (u) { return (u.filter && u.filter.id) + '|' + u.datum + '|' + r2(u.bedrag); }));
  const keer = new Map((o.uitschieters || []).map(function (u) { return [(u.filter && u.filter.id) + '|' + u.datum + '|' + r2(u.bedrag), u.keer]; }));
  const uit = [];
  (o.gezien || []).forEach(function (g) {
    const l = per.get(g.nr);
    if (!l || !l.length) return;   // andere valuta of buiten het venster
    const x = l[0], bedrag = r2(x.bedrag), groot = l.slice().sort(function (p, q) { return Math.abs(q.deel) - Math.abs(p.deel); })[0];
    const k = x.id + '|' + x.datum + '|' + r2(-x.bedrag);
    let ongewoon = null;
    if (uitsch.has(k)) ongewoon = (keer.get(k) ? String(keer.get(k)).replace('.', ',') + '× ' : 'veel meer dan ') + 'de gebruikelijke post';
    else if (l.some(function (y) { return y.eenmalig; })) ongewoon = 'eenmalig groot';
    else if (l.some(function (y) { return y.jaar; })) ongewoon = 'eenmalig inkomen';
    else if (groot.stroom !== 'intern' && bedrag <= -NIEUW_TP_MIN && x.id && eerst.get(x.id) === x.datum) ongewoon = 'nieuwe tegenpartij';
    uit.push({ nr: g.nr, gezien: String(g.eerste_gezien), datum: x.datum, naam: naamKort(x.naam || x.tegenpartij || x.omschrijving), bedrag: bedrag,
      stroom: groot.stroom, intern: l.every(function (y) { return y.stroom === 'intern'; }) || undefined, ongewoon: ongewoon || undefined });
  });
  uit.sort(function (p, q) { return p.gezien < q.gezien ? 1 : p.gezien > q.gezien ? -1 : q.nr - p.nr; });
  return uit.slice(0, RECENT_MAX).map(function (x) { const y = Object.assign({}, x); delete y.nr; return y; });   // geen boekingsnummer naar buiten (financien-app privacytoets)
}
function wanneerTekst(iso, nuMs) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'onbekend';
  const dag = function (ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); };
  const uur = new Date(t).toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
  const d = dag(t), v = dag(nuMs), g = dag(nuMs - 86400000);
  return d === v ? 'vandaag ' + uur : d === g ? 'gisteren ' + uur : dagKort(d);
}
// nu = overzicht.nu (met recent en recent_tot), sinds = iso van het vorige bezoek of null. Puur; server.js roept dit per verzoek aan.
function nieuwSinds(nu, sinds, nuMs, bezoekOp) {   // bezoekOp = wanneer David keek (alleen voor de tekst); sinds = tot waar hij de boekingen zag
  const recent = (nu && Array.isArray(nu.recent)) ? nu.recent : [], ms = nuMs || Date.now();
  const eerste = !(typeof sinds === 'string' && Number.isFinite(Date.parse(sinds)));
  const grens = eerste ? new Date(ms - 7 * 86400000).toISOString() : new Date(Date.parse(sinds)).toISOString();
  const l = recent.filter(function (x) { return x.gezien > grens; });
  const echt = l.filter(function (x) { return !x.intern; });
  const grootste = echt.slice().sort(function (p, q) { return Math.abs(q.bedrag) - Math.abs(p.bedrag); }).slice(0, 3);
  const ongewoon = echt.filter(function (x) { return x.ongewoon; }).sort(function (p, q) { return Math.abs(q.bedrag) - Math.abs(p.bedrag); }).slice(0, 3);
  const post = function (x) { return x.naam + ' ' + eurRond(x.bedrag) + (x.bedrag > 0 ? ' bij' : ''); };
  const kop = eerste ? 'De laatste 7 dagen' : 'Sinds je laatste bezoek (' + wanneerTekst(typeof bezoekOp === 'string' && Number.isFinite(Date.parse(bezoekOp)) ? bezoekOp : grens, ms) + ')';
  let zin;
  if (!l.length) zin = kop + ' niets nieuws van de bank.';
  else {
    zin = kop + ': ' + l.length + (l.length === 1 ? ' nieuwe boeking' : ' nieuwe boekingen') + (echt.length < l.length ? ' (' + (l.length - echt.length) + ' tussen je eigen rekeningen)' : '') + '.';
    if (grootste.length) zin += (grootste.length === 1 ? ' ' : ' Grootste: ') + grootste.map(post).join(', ') + '.';
    zin += ongewoon.length ? ' Ongewoon: ' + ongewoon.map(function (x) { return post(x) + ' (' + x.ongewoon + ')'; }).join(', ') + '.' : ' Niets ongewoons.';
  }
  return { sinds: eerste ? null : grens, eerste: eerste, tot: (nu && nu.recent_tot) || null, aantal: l.length, grootste: grootste, ongewoon: ongewoon, zin: zin, toon: ongewoon.length ? 'let' : 'goed' };
}
// o: { nu, reeksen, rijen, naam, overslaan, saldo: { saldo, op } | null, stortingen: [{ van, bedrag, dag }], intern_in: [transacties] }
function komende(o) {
  const nu = o.nu, mNu = nu.slice(0, 7), tot = plusDagen(nu, KOMENDE_DAGEN), terug = plusDagen(nu, -KOMENDE_TERUG);
  const posten = [];
  (o.rijen || []).forEach(function (x) {
    if (o.overslaan && o.overslaan(x)) return;
    const rs = (o.reeksen || []).filter(function (r) { return (x.sleutels || []).indexOf(r.sleutel) >= 0; });
    let bedrag = 0, datum = null, oud = false;
    rs.forEach(function (r) {
      const vv = volgendeVan(r);
      if (!vv || vv < terug || vv > tot) return;
      const keer = r.ritme === 'maand' ? Math.max(1, Math.round((r.n_per_maand || 1) * KOMENDE_DAGEN / 30)) : 1;
      bedrag += r.bedrag * keer;
      if (!datum || vv < datum) datum = vv;
      if (vv < nu) oud = true;
    });
    if (!datum || !(bedrag > 0)) return;
    const nm = o.naam ? o.naam(x) : x.naam;   // een bank als tegenpartij zegt weinig: dan de soort post (Hypotheek)
    posten.push({ naam: naamKort(x.soort_post && /\b(bank|abn amro|rabobank|ing)\b/i.test(String(nm)) ? x.soort_post : nm), datum: datum, bedrag: r2(bedrag), nog_niet_gezien: oud || undefined });
  });
  posten.sort(function (p, q) { return p.datum < q.datum ? -1 : p.datum > q.datum ? 1 : q.bedrag - p.bedrag; });
  const stortingen = [];
  (o.stortingen || []).forEach(function (s) {
    if (!(s.bedrag > 0)) return;
    const op = function (m) { return m + '-' + String(Math.min(dagenIn(m), Math.max(1, s.dag | 0 || 1))).padStart(2, '0'); };
    let d = op(mNu);
    const al = (o.intern_in || []).some(function (t) { return String(t.datum).slice(0, 7) === mNu && Math.abs(t.bedrag - s.bedrag) <= 0.005 * s.bedrag + 0.01; });
    if (d <= nu || al) d = op(maandPlus(mNu, 1));
    if (d > tot) return;
    stortingen.push({ van: naamKort(s.van), bedrag: r2(s.bedrag), datum: d });
  });
  const som = r2(posten.reduce(function (z, p) { return z + p.bedrag; }, 0));
  const uit = { van: nu, tot: tot, dagen: KOMENDE_DAGEN, posten: posten, som: som, stortingen: stortingen, saldo: null, saldo_op: null, over: null, laagste: null, haalt: null };
  if (o.saldo && typeof o.saldo.saldo === 'number' && Number.isFinite(o.saldo.saldo)) {
    // op volgorde van datum; op dezelfde dag eerst wat eraf gaat (voorzichtig)
    const ev = posten.map(function (p) { return { d: p.datum < nu ? nu : p.datum, b: -p.bedrag }; }).concat(stortingen.map(function (s) { return { d: s.datum, b: s.bedrag }; }))
      .sort(function (p, q) { return p.d < q.d ? -1 : p.d > q.d ? 1 : p.b - q.b; });
    let stand = o.saldo.saldo, laag = { bedrag: stand, datum: nu };
    ev.forEach(function (e) { stand += e.b; if (stand < laag.bedrag) laag = { bedrag: stand, datum: e.d }; });
    uit.saldo = r2(o.saldo.saldo); uit.saldo_op = o.saldo.op || null; uit.over = r2(stand); uit.laagste = { bedrag: r2(laag.bedrag), datum: laag.datum }; uit.haalt = laag.bedrag >= 0;
  }
  const rek = o.rekening || 'de vaste-lastenrekening';
  let zin;
  if (!posten.length) zin = 'De komende ' + KOMENDE_DAGEN + ' dagen (t/m ' + dagKort(tot) + ') staan er geen vaste posten op ' + rek + '.';
  else {
    const top = posten.slice().sort(function (p, q) { return q.bedrag - p.bedrag; }).slice(0, 3);
    zin = 'De komende ' + KOMENDE_DAGEN + ' dagen (t/m ' + dagKort(tot) + ') gaat er van ' + rek + ' naar verwachting ' + eurRond(som) + ' af (' + posten.length + (posten.length === 1 ? ' post' : ' posten') +
      '; grootste: ' + top.map(function (p) { return p.naam + ' ' + dagKort(p.datum < nu ? nu : p.datum) + ' ' + eurRond(p.bedrag); }).join(', ') + ').';
    const oud = posten.filter(function (p) { return p.nog_niet_gezien; }).length;
    if (oud) zin += ' Daarvan ' + (oud === 1 ? 'is er 1' : 'zijn er ' + oud) + ' al verwacht maar nog niet gezien.';
  }
  if (uit.haalt === null) zin += posten.length ? ' Het saldo van de rekening is niet te lezen, dus of hij het haalt is niet te zeggen.' : '';
  else if (posten.length) {
    const saldoT = 'saldo ' + eurRond(uit.saldo) + (uit.saldo_op && uit.saldo_op < plusDagen(nu, -2) ? ' (stand ' + dagKort(uit.saldo_op) + ')' : '') +
      (stortingen.length ? ' plus ' + stortingen.map(function (s) { return 'de vaste storting van ' + eurRond(s.bedrag) + ' rond ' + dagKort(s.datum); }).join(' en ') : '');
    zin += uit.haalt ? ' Dat haalt de rekening naar schatting: ' + saldoT + ', er blijft ± ' + eurRond(uit.over) + ' over.'
      : ' Dat haalt de rekening naar schatting niet: ' + saldoT + '; op ' + dagKort(uit.laagste.datum) + ' komt hij ± ' + eurRond(uit.laagste.bedrag) + ' tekort. Maak vóór die dag geld over.';
  }
  uit.zin = zin;
  uit.toon = uit.haalt === false ? 'fout' : 'goed';
  return uit;
}

module.exports = { potjes: potjes, potjesLees: potjesLees, potjesZet: potjesZet, potjeInvoer: potjeInvoer, afvinken: afvinken, geldstroom: geldstroom, geldstroomVan: geldstroomVan,
  P_POTJES: P_POTJES, POTJE_CATS: POTJE_CATS, TE_LAAT_DAGEN: TE_LAAT_DAGEN,
  dezeMaand: dezeMaand, recentVan: recentVan, nieuwSinds: nieuwSinds, komende: komende, KOMENDE_DAGEN: KOMENDE_DAGEN, RECENT_DAGEN: RECENT_DAGEN, RECENT_BOEK_DAGEN: RECENT_BOEK_DAGEN };   // wv3924
