// financien-vermogen.js — App Financiën, vermogensverloop per maand sinds 2016 (wv2716; idee 1 uit Sure, David 8-11-2026 "1 t/m 6"; alleen het
// idee, geen code of tekst uit Sure). Ontwerp: vault "01_Ontwikkeling/Financiën - ideeën uit Sure (ontwerp 8-11-2026)" § 1d.
//
// WAAROM. Financiën toonde het privévermogen alleen als punt (Overzicht › Vermogen privé). David wil zien hoe het in de loop van de jaren
// groeide: per maand een lijn, met de Holding als aparte lijn (nooit opgeteld, zoals het punt).
//
// REGELS (alleen lezen; geen netwerk, geen taalmodel, geen opslag). Per maand van jan 2016 t/m de lopende maand, stand op de laatste dag:
//   bank        per rekening de dageind-stand van de laatste dag met boekingen ≤ einde maand. saldo_na volgt binnen een dag niet de volgorde
//               van nr; de dageind-stand is de stand e waarvoor e − som(dag) de beginstand van een boeking die dag is (bij meer kandidaten
//               wint de stand die aansluit op de vorige dag). Zonder saldo_na: terugrekenen vanaf de bewaarde stand (stand nu − som van de
//               boekingen na die maand). Vóór de eerste boeking: bunq levert de hele historie vanaf de opening (zie volledigVanaf in
//               financien-app.js), dus € 0; andere rekeningen zijn daar onbekend → de maand is onvolledig (review MOET 1: geen aangenomen
//               beginstand, geen drempel). Groepen zoals Saldi en het punt (eigenaar + van wie): vrij telt mee; kinderen, Gambia en overig
//               apart. Vóór de eerste privéboeking in het archief ontbreekt de bank helemaal.
//   woning      trap van de taxaties vanaf de peildatum (zelfde regel als het punt: na verbouwing als die er is); daarvóór ontbreekt hij.
//   hypotheek   Davids Excel-model per maand (stand na de termijn); vanaf de maand van de bankstand de bankstand (zoals het punt).
//   woninglening Holding: € 0 vóór de ingangsdatum, dan de hoofdsom tot de eerste jaarrekening, dan de jaarrekeningstand (trap).
//   rekening-courant: € 0 vóór het eerste boekjaar (alleen als eind − mutatie van dat jaar 0 geeft), dan de jaarrekeningstand RC Holding
//               (trap; maand onvolledig: het deel bij Tolgaarde staat er niet per jaar in, review MOET 2); vanaf de bijgewerkt-datum van de
//               besluitpagina het totaal van die pagina (incl. Tolgaarde), zoals het punt.
//   totaal      bank (vrij) + woning − hypotheek − woninglening − rc. Ontbreekt de bank, de woning of de hypotheek (of een Holding-schuld):
//               geen totaal, wel de delen. Ontbreekt alleen een rekening of het Tolgaarde-deel: totaal van wat bekend is, onvolledig met lijst.
//   lopend      de lopende maand = precies het punt van Overzicht (vermogenPunt in financien-overzicht.js): de laatste stip = de tegel.
//   Holding     eigen vermogen per jaarrekening (trap, boekwaarde), aparte lijn, nooit opgeteld.
// Het antwoord gaat alleen naar Davids eigen App (POST /app/financien/vermogen); rekeningnamen wel (zoals Saldi), IBAN's niet.
'use strict';

const BEGIN = '2016-01';
const MND = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function r2(n) { return Math.round(n * 100) / 100; }
function cent(n) { return Math.round(n * 100); }
function veilig(s, n) { return String(s == null ? '' : s).normalize('NFC').replace(/[^\p{L}\p{N} .,&'()\-/+—]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 40).trim(); }
function maandPlus(m, n) { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); }
function maandEind(m) { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)); return d.toISOString().slice(0, 10); }
function mndJaar(m) { return MND[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4); }
// laatste stand uit een oplopend gesorteerde lijst [{ datum, ... }] met datum ≤ d
function trap(lijst, d) { let x = null; for (let i = 0; i < lijst.length; i++) { if (lijst[i].datum <= d) x = lijst[i]; else break; } return x; }

// ── bank: dageind-standen per rekening ──
// tx: boekingen van één rekening, gesorteerd op datum en nr, alle met saldo_na. Geeft [{ datum, stand }] per dag (oplopend) en de beginstand.
function dagketen(tx) {
  const dagen = [];
  tx.forEach(function (x) { const l = dagen.length ? dagen[dagen.length - 1] : null; if (l && l.datum === x.datum) l.tx.push(x); else dagen.push({ datum: x.datum, tx: [x] }); });
  const uit = [];
  let vorig = null, begin = null, meerduidig = 0, breuk = 0;
  dagen.forEach(function (d) {
    const som = d.tx.reduce(function (s, x) { return s + cent(x.bedrag); }, 0);
    const starts = new Set(d.tx.map(function (x) { return cent(x.saldo_na) - cent(x.bedrag); }));
    const kand = Array.from(new Set(d.tx.map(function (x) { return cent(x.saldo_na); }).filter(function (e) { return starts.has(e - som); })));
    let eind;
    if (vorig != null && kand.indexOf(vorig + som) >= 0) eind = vorig + som;
    else if (kand.length === 1) eind = kand[0];
    else if (kand.length > 1) { meerduidig++; eind = vorig != null ? kand.reduce(function (p, q) { return Math.abs(q - vorig - som) < Math.abs(p - vorig - som) ? q : p; }) : kand[kand.length - 1]; }
    else { breuk++; eind = cent(d.tx[d.tx.length - 1].saldo_na); }   // geen sluitende keten: de laatste in nr-volgorde
    if (begin == null) begin = eind - som;
    else if (vorig != null && eind - som !== vorig) breuk++;
    uit.push({ datum: d.datum, stand: eind / 100 });
    vorig = eind;
  });
  return { dagen: uit, begin: begin == null ? null : begin / 100, meerduidig: meerduidig, breuk: breuk };
}
// zonder saldo_na: terug vanaf de bewaarde stand (stand na de laatste boeking = de bewaarde stand)
function terugketen(tx, nu) {
  const dagen = [];
  let stand = cent(nu);
  for (let i = tx.length - 1; i >= 0; i--) {
    const d = tx[i].datum;
    if (!dagen.length || dagen[0].datum !== d) dagen.unshift({ datum: d, stand: stand / 100 });
    stand -= cent(tx[i].bedrag);
  }
  return { dagen: dagen, begin: stand / 100 };
}
// per rekening: { naam, groep (vrij|kinderen|geoormerkt|anders), bunq, eerste (datum), dagen, begin }
function rekeningen(a, o) {
  const F = o.F || require('./financien-app.js'), O = o.O || require('./financien-overzicht.js');
  const stand = new Map();
  (o.saldiRijen || []).forEach(function (r) { let j = null; try { j = JSON.parse(r.json); } catch (e) { j = null; } if (j && typeof j.geboekt === 'number' && (!j.valuta || j.valuta === 'EUR')) stand.set(r.rek, j.geboekt); });
  const reks = a.db.prepare('SELECT rek, bron, naam, label, weergavenaam, eigenaar, van_wie FROM rekeningen').all();
  const q = a.db.prepare("SELECT nr, datum, bedrag, saldo_na FROM transacties WHERE rek = ? AND status = 'booked' AND vervangen_door IS NULL AND (valuta IS NULL OR valuta = 'EUR') AND datum IS NOT NULL ORDER BY datum, nr");
  const uit = [];
  reks.forEach(function (r) {
    const g = F.saldoGroep(r);
    if (g === 'pot') return;   // zakelijk, telt nergens mee
    const tx = q.all(r.rek);
    const naam = veilig(r.weergavenaam, 40) || veilig(r.label || r.naam, 40) || 'Rekening';
    const x = { naam: naam, groep: O.groepVan(g), bunq: r.bron === 'bunq', eerste: tx.length ? tx[0].datum : null, dagen: [], begin: null, onbekend: false };
    if (!tx.length) { if (!x.bunq && stand.has(r.rek)) { x.onbekend = true; x.stand_nu = stand.get(r.rek); } uit.push(x); return; }
    if (tx.every(function (t) { return typeof t.saldo_na === 'number'; })) Object.assign(x, dagketen(tx));
    else if (stand.has(r.rek)) Object.assign(x, terugketen(tx, stand.get(r.rek)));
    else x.onbekend = true;   // geen saldo_na en geen bewaarde stand: niet te volgen
    uit.push(x);
  });
  return uit;
}

// ── het verloop ──
// A: bank-archief.js, a: archief; o: { nu (JJJJ-MM-DD), saldiRijen (tabel saldo), saldi (blokSaldi), vault, fv, F?, O? }
function verloop(A, a, o) {
  const nu = o.nu, mNu = nu.slice(0, 7);
  const F = o.F || require('./financien-app.js'), O = o.O || require('./financien-overzicht.js'), FV = o.fv || require('./financien-vault.js');
  const fouten = [];
  const blok = function (n, f) { try { return f(); } catch (e) { fouten.push(n); return null; } };
  const v = blok('vault', function () { return FV.lees(o.vault); }) || {};
  const hyp = v.hypotheek || null, dga = v.dga || null;
  const L = O.liquide(o.saldi || (o.saldiRijen ? F.blokSaldi(a, o.saldiRijen) : null));
  const punt = O.vermogenPunt({ v: v, sal: L.sal, liq: L.liq, vault: o.vault, FV: FV, nu: nu, blok: blok });
  const reks = blok('bank', function () { return rekeningen(a, { saldiRijen: o.saldiRijen, F: F, O: O }); }) || [];
  const woning = blok('woning', function () { return O.leesWoning(o.vault, FV); });
  const hold = blok('holding', function () { return O.leesHolding(o.vault, FV); });
  const taxaties = woning && woning.taxaties ? woning.taxaties : [];
  const hypReeks = new Map((hyp && hyp.reeks_maand || []).map(function (r) { return [r.maand, r.restschuld]; }));
  const bankOp = hyp && hyp.bron && hyp.bron.bank_op && hyp.bank && hyp.bank.restschuld != null ? hyp.bron.bank_op : null;
  const wl = dga && dga.woninglening || null;
  const wlStanden = wl ? [].concat(wl.ingang ? [{ datum: '0000-00-00', stand: 0, bron: 'voor' }, { datum: wl.ingang, stand: wl.hoofdsom, bron: 'contract' }] : [],
    (wl.jaarrekening || []).filter(function (x) { return x.stand != null; }).map(function (x) { return { datum: x.jaar + '-12-31', stand: x.stand, bron: 'jaarrekening ' + x.jaar }; })) : [];
  const rcj = dga && dga.rc_jaarrekening || null, rcNu = dga && dga.rc && dga.rc.totaal != null ? dga.rc.totaal : null;
  const rcOp = dga && dga.bron && dga.bron.pagina_bijgewerkt || null;
  const rcStanden = [].concat(rcj && rcj.begin === 0 ? [{ datum: '0000-00-00', stand: 0, bron: 'voor', heel: true }, { datum: rcj.eerste_jaar + '-01-01', stand: 0, bron: 'begin ' + rcj.eerste_jaar }] : [],
    rcj ? rcj.standen.map(function (x) { return { datum: x.jaar + '-12-31', stand: x.stand, bron: 'jaarrekening ' + x.jaar }; }) : [],
    rcNu != null && rcOp ? [{ datum: rcOp, stand: rcNu, bron: 'besluit', heel: true }] : []);
  const holdStanden = hold && hold.jaren ? hold.jaren.map(function (x) { return { datum: x.jaar + '-12-31', stand: x.eigen_vermogen, jaar: x.jaar }; }) : [];
  // de eerste privéboeking in het archief (vrij): daarvóór geen bankgegevens
  const eersteBank = reks.filter(function (r) { return r.groep === 'vrij' && r.eerste; }).map(function (r) { return r.eerste; }).sort()[0] || null;

  const maanden = [];
  for (let m = BEGIN; m < mNu; m = maandPlus(m, 1)) {
    const eind = maandEind(m), x = { m: m, ontbreekt: [], onvolledig: [] };
    // bank
    if (!eersteBank || eind < eersteBank) { x.ontbreekt.push('bank (geen privérekening in het archief vóór ' + (eersteBank ? mndJaar(eersteBank.slice(0, 7)) : 'nu') + ')'); x.vrij = null; }
    else {
      const som = { vrij: 0, kinderen: 0, geoormerkt: 0, anders: 0 };
      reks.forEach(function (r) {
        if (r.onbekend) { if (r.groep === 'vrij') x.onvolledig.push(r.naam + ' (niet te volgen)'); return; }
        if (!r.eerste) return;
        if (eind < r.eerste) {
          if (r.bunq) return;   // bunq: vóór de eerste boeking bestond de rekening niet
          if (r.groep === 'vrij') x.onvolledig.push(r.naam + ' (geen historie vóór ' + mndJaar(r.eerste.slice(0, 7)) + ')');
          return;
        }
        const d = trap(r.dagen, eind);
        som[r.groep] += d ? d.stand : r.begin || 0;
      });
      x.vrij = r2(som.vrij); x.kinderen = r2(som.kinderen); x.gambia = r2(som.geoormerkt); x.overig = r2(som.anders);
    }
    // woning
    const t = trap(taxaties, eind);
    x.woning = t ? t.waarde : null; x.woning_op = t ? t.datum : null;
    if (!t) x.ontbreekt.push('woning (geen taxatie vóór ' + (taxaties[0] ? taxaties[0].datum : 'nu') + ')');
    // hypotheek
    if (bankOp && m >= bankOp.slice(0, 7)) { x.hypotheek = hyp.bank.restschuld; x.hypotheek_bron = 'bank'; }
    else if (hypReeks.has(m)) { x.hypotheek = hypReeks.get(m); x.hypotheek_bron = 'excel'; }
    else { x.hypotheek = null; x.ontbreekt.push('hypotheek'); }
    // woninglening Holding
    const w = trap(wlStanden, eind);
    x.woninglening = w ? w.stand : null; x.woninglening_bron = w ? w.bron : null;
    if (!w) x.ontbreekt.push('woninglening Holding');
    // rekening-courant
    const c = trap(rcStanden, eind);
    x.rc = c ? c.stand : null; x.rc_bron = c ? c.bron : null;
    if (!c) x.ontbreekt.push('rekening-courant');
    else if (!c.heel) x.onvolledig.push('rekening-courant bij Tolgaarde (niet per jaar bekend)');
    // Holding apart
    const h = trap(holdStanden, eind);
    x.holding = h ? h.stand : null; x.holding_jaar = h ? h.jaar : null;
    x.totaal = x.ontbreekt.length ? null : r2(x.vrij + x.woning - x.hypotheek - x.woninglening - x.rc);
    x.volledig = x.totaal != null && !x.onvolledig.length;
    maanden.push(x);
  }
  // de lopende maand = het punt van Overzicht
  const pv = punt.prive, deel = function (re) { const d = pv.delen.find(function (x) { return re.test(x.tekst); }); return d ? d : null; };
  const dv = deel(/^vrij beschikbaar/i), dw = deel(/^woning/i), dh = deel(/^hypotheek/i), dl = deel(/^woninglening/i), dr = deel(/^rekening-courant/i);
  const nk = function (re) { const d = (pv.niet_meegeteld || []).find(function (x) { return re.test(x.tekst); }); return d ? d.bedrag : null; };
  maanden.push({ m: mNu, lopend: true, totaal: pv.bedrag, volledig: pv.bedrag != null, ontbreekt: pv.ontbreekt.slice(), onvolledig: [],
    vrij: dv ? dv.bedrag : null, stand_van: dv ? dv.op : null, kinderen: nk(/kinder/i), gambia: nk(/gambia/i), overig: L.sal ? r2(L.liq.anders) : null,
    woning: dw ? dw.bedrag : null, woning_op: dw ? dw.op : null, hypotheek: dh ? -dh.bedrag : null, hypotheek_bron: dh ? 'bank' : null,
    woninglening: dl ? -dl.bedrag : null, woninglening_bron: dl ? 'jaarrekening ' + String(dl.op).slice(0, 4) : null,
    rc: dr ? -dr.bedrag : null, rc_bron: dr ? 'besluit' : null,
    holding: punt.holding ? punt.holding.eigen_vermogen : null, holding_jaar: punt.holding ? punt.holding.jaar : null });
  const metTotaal = maanden.filter(function (x) { return x.totaal != null; });
  return {
    ok: true, peildatum: nu, maanden: maanden, fouten: fouten,
    eerste_totaal: metTotaal.length ? metTotaal[0].m : null, eerste_volledig: (maanden.find(function (x) { return x.volledig; }) || {}).m || null,
    bronnen: {
      woning: woning ? woning.bron : null, hypotheek: hyp ? { excel: hyp.bron.excel, bank: hyp.bron.bank, bank_op: bankOp } : null,
      holding: dga ? dga.bron.data || null : null, besluit: dga ? dga.bron.pagina : null, besluit_op: rcOp, kerncijfers: hold ? hold.bron : null,
    },
    bank_kwaliteit: { rekeningen: reks.length, meerduidig: reks.reduce(function (s, r) { return s + (r.meerduidig || 0); }, 0), breuk: reks.reduce(function (s, r) { return s + (r.breuk || 0); }, 0) },
    uitleg: 'Stand op de laatste dag van elke maand, zichtbare rekeningen. Woning op de taxatie van dat moment (trap, een schatting); hypotheek uit je eigen Excel-model en vanaf de bankstand die stand; woninglening en rekening-courant per jaarrekening. De Holding is een aparte lijn (boekwaarde per jaarrekening) en telt nooit mee. Onvolledig = niet alle delen bekend (staat erbij wat ontbreekt); geen totaal waar de bank, de woning of de hypotheek ontbreekt.',
  };
}

module.exports = { verloop: verloop, dagketen: dagketen, terugketen: terugketen, rekeningen: rekeningen, maandEind: maandEind, BEGIN: BEGIN };
