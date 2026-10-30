'use strict';
/*
 * facturen-maandspec.js — maandspecificatie PayPal en creditcard voor de boekhouder (wv2060, David 30-10-2026 ± 23:15: "Mijn vader waardeert
 * het ook zeer als je de zakelijke paypalbetalingen gespecificeerd op 1 PDF kan verzenden elke maand, en hij wilt ook de creditcard
 * afschrijvingen"). André ziet in Exact per PayPal-betaling alleen "PayPal Europe" en per maand één ICS-incasso; deze PDF zegt per post wat
 * erachter zit. Zelfde opzet als de SEPA-specificatie (facturen-specificatie.js, wv2025): server.js zet er een Gmail-concept van klaar, David
 * verstuurt. Bouwplan vault 01_Ontwikkeling/Facturen-app - bouwplan (App, 22-10-2026).md § Log.
 *
 * Maand M = (a) de PayPal-posten met boekdatum in M op de zakelijke rekeningen, per post de betaling erachter; subtotaal per rekening = de
 * som van die posten op de bank; (b) per creditcard het ICS-rekeningoverzicht M (de incasso "Incasso <M>" staat in M op de bank; de
 * transacties lopen van ± de 5e van M-1 tot ± de 1e van M); subtotaal = de som van de transacties, naast de incasso op de bank.
 * Puur: alleen crypto en de PDF-bouwstenen van facturen-specificatie.js; geen klok (de beller geeft de tijd mee). facturen.js leest de
 * gegevens uit de eigen database (alleen lezen). Geen btw-uitsplitsing (btw-vrijgesteld), nooit een IBAN van een tegenpartij, van de kaart
 * alleen de laatste vier cijfers, van de eigen rekening alleen de laatste vier.
 */
const crypto = require('crypto');
const SP = require('./facturen-specificatie.js');
const { breedte, pas, hex, getal, kleur, schoon, isoDag, pdfBestand } = SP.pdf;
const { eur, datumNl } = SP;

class MaandFout extends Error {}
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MAAND_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function maandNaam(m) { const x = MAAND_RE.exec(String(m || '')); return x ? MAANDEN[Number(x[2]) - 1] + ' ' + x[1] : String(m || ''); }
function vorigeMaand(m) { const j = Number(m.slice(0, 4)), n = Number(m.slice(5, 7)); return n === 1 ? (j - 1) + '-12' : j + '-' + String(n - 1).padStart(2, '0'); }
function volgendeMaand(m) { const j = Number(m.slice(0, 4)), n = Number(m.slice(5, 7)); return n === 12 ? (j + 1) + '-01' : j + '-' + String(n + 1).padStart(2, '0'); }
function dagKort(s) { if (!isoDag(s)) return String(s || ''); const [, m, d] = s.split('-').map(Number); return d + '-' + m; }
function geheel(n) { return Number.isSafeInteger(n); }
// vreemde valuta: "USD 20,00" (centen in die valuta); euro of onbekend: leeg
function origineel(valuta, c) {
  if (!valuta || valuta === 'EUR' || !geheel(c)) return '';
  const n = Math.abs(c), heel = String(Math.floor(n / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return valuta + ' ' + (c < 0 ? '-' : '') + heel + ',' + String(n % 100).padStart(2, '0');
}

const PP_STATUS = { sluit: null, saldo: 'deels via PayPal-saldo', open: 'nog niet gekoppeld', niet_in_paypal: 'niet te specificeren' };
const ICS_STATUS = ['sluit', 'verschil', 'nog_niet_geincasseerd', 'niet_aangeleverd', 'geen'];

/*
 * opbouw(x) → de specificatie. x = {
 *   maand: 'JJJJ-MM',
 *   paypal: null (koppeling nog niet in deze release) | { bijgewerkt: 'JJJJ-MM-DD' | null, rekeningen: [{ entiteit, entiteit_naam, rekening_eind,
 *     posten: [{ datum, bank_centen (bankteken: - = afschrijving), status (sluit|saldo|open|niet_in_paypal), tegenpartij, onderwerp, valuta,
 *     bedrag_centen (in die valuta, - = uitgave), factuur }] }] },
 *   kaarten: [{ laatste4, entiteit, entiteit_naam, rekening_eind, status (ICS_STATUS), ingelezen_tot: 'JJJJ-MM-DD' | null,
 *     regels: [{ datum, omschrijving, valuta, bedrag_orig_centen, bedrag_centen (+ = uitgave), factuur }], bank: [{ datum, bedrag_centen }] }] }
 * Telt zelf (subtotalen uit de regels); een regel die niet te lezen is = MaandFout (liever geen specificatie dan een verkeerde).
 */
function opbouw(x) {
  if (!x || !MAAND_RE.test(String(x.maand || ''))) throw new MaandFout('maand ongeldig');
  const paypal = x.paypal == null ? null : { bijgewerkt: isoDag(x.paypal.bijgewerkt) ? x.paypal.bijgewerkt : null, rekeningen: [] };
  if (paypal) {
    for (const r of x.paypal.rekeningen || []) {
      const posten = (r.posten || []).map((p) => {
        if (!isoDag(p.datum) || !geheel(p.bank_centen) || !(p.status in PP_STATUS)) throw new MaandFout('PayPal-post ongeldig');
        if (p.datum.slice(0, 7) !== x.maand) throw new MaandFout('PayPal-post buiten de maand');
        const wat = [schoon(p.tegenpartij, 100), schoon(p.onderwerp, 160)].filter(Boolean).join(' — ');
        return { datum: p.datum, bedrag_centen: -p.bank_centen, status: p.status, opmerking: PP_STATUS[p.status],
          omschrijving: wat || (p.status === 'niet_in_paypal' || p.status === 'open' ? 'PayPal Europe' : 'PayPal-betaling'),
          origineel: geheel(p.bedrag_centen) ? origineel(p.valuta, -p.bedrag_centen) : '', factuur: schoon(p.factuur, 60) || '' };
      }).sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0));
      if (!posten.length) continue;
      paypal.rekeningen.push({ entiteit: r.entiteit, entiteit_naam: schoon(r.entiteit_naam, 120) || r.entiteit, rekening_eind: String(r.rekening_eind || '').slice(-4),
        posten, aantal: posten.length, totaal_centen: posten.reduce((s, p) => s + p.bedrag_centen, 0),
        zonder_spec: posten.filter((p) => p.status === 'niet_in_paypal' || p.status === 'open').length });
    }
    paypal.aantal = paypal.rekeningen.reduce((s, r) => s + r.aantal, 0);
    paypal.totaal_centen = paypal.rekeningen.reduce((s, r) => s + r.totaal_centen, 0);
  }
  const kaarten = (x.kaarten || []).map((k) => {
    if (!/^\d{4}$/.test(String(k.laatste4 || '')) || !ICS_STATUS.includes(k.status)) throw new MaandFout('kaart ongeldig');
    const regels = (k.regels || []).map((r) => {
      if (!isoDag(r.datum) || !geheel(r.bedrag_centen)) throw new MaandFout('kaartregel ongeldig');
      return { datum: r.datum, omschrijving: schoon(r.omschrijving, 160) || 'onbekend', origineel: origineel(r.valuta, r.bedrag_orig_centen), bedrag_centen: r.bedrag_centen,
        factuur: schoon(r.factuur, 60) || '' };
    }).sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0));
    const bank = (k.bank || []).filter((b) => isoDag(b.datum) && geheel(b.bedrag_centen));
    const transacties = regels.reduce((s, r) => s + r.bedrag_centen, 0), bankNetto = -bank.reduce((s, b) => s + b.bedrag_centen, 0);
    let status = k.status;
    // de beller zegt of het overzicht binnen is; sluiten en verschil telt dit bestand zelf na
    if (regels.length && (status === 'sluit' || status === 'verschil')) status = bank.length && bankNetto === transacties ? 'sluit' : bank.length ? 'verschil' : 'nog_niet_geincasseerd';
    return { laatste4: String(k.laatste4), entiteit: k.entiteit, entiteit_naam: schoon(k.entiteit_naam, 120) || k.entiteit, rekening_eind: String(k.rekening_eind || '').slice(-4),
      status, regels, aantal: regels.length, transacties_centen: transacties, bank_centen: bank.length ? bankNetto : null,
      bank_datums: [...new Set(bank.map((b) => b.datum))].sort(), verschil_centen: bank.length && regels.length ? bankNetto - transacties : null,
      ingelezen_tot: isoDag(k.ingelezen_tot) ? k.ingelezen_tot : null };
  });
  const entiteiten = new Set([...(paypal ? paypal.rekeningen.map((r) => r.entiteit) : []), ...kaarten.map((k) => k.entiteit)]);
  return { maand: x.maand, maand_naam: maandNaam(x.maand), paypal, kaarten, entiteiten: [...entiteiten],
    ics_ontbreekt: kaarten.some((k) => k.status === 'niet_aangeleverd'), leeg: !(paypal && paypal.aantal) && !kaarten.some((k) => k.aantal) };
}

function icsZin(k, kort) {
  if (k.status === 'niet_aangeleverd') return 'nog niet aangeleverd';
  if (k.status === 'geen') return 'geen transacties op dit overzicht';
  const basis = k.aantal + (k.aantal === 1 ? ' transactie' : ' transacties') + ', samen ' + eur(k.transacties_centen);
  if (k.status === 'nog_niet_geincasseerd') return basis + '; nog niet geïncasseerd';
  const wanneer = k.bank_datums.map((d) => (kort ? dagKort(d) : datumNl(d))).join(' en ');
  if (k.status === 'sluit') return basis + ' = de incasso van ' + wanneer;
  return basis + '; incasso op de bank ' + eur(k.bank_centen) + ' (' + wanneer + '), verschil ' + eur(k.verschil_centen);
}

// ── mail (Davids stem aan zijn vader, zoals de SEPA-specificatie: "Ha pa", kort; skill mijn-mailstem categorie 4) ──
function mail(g, o) {
  o = o || {};
  const ent = g.entiteiten.length === 1 ? ' ' + ((g.paypal && g.paypal.rekeningen[0] && g.paypal.rekeningen[0].entiteit_naam) || (g.kaarten[0] && g.kaarten[0].entiteit_naam) || '') : '';
  const onderwerp = (o.nagekomen ? 'Aanvulling: specificatie' : 'Specificatie') + ' PayPal en creditcard ' + g.maand_naam;
  const r = ['Ha pa,', ''];
  if (o.nagekomen) r.push('Hierbij de specificatie van ' + g.maand_naam + ' opnieuw, nu met de creditcard erbij (PDF in de bijlage).', '');
  else r.push('Hierbij de specificatie van ' + g.maand_naam + (ent.trim() ? ' voor' + ent : '') + ' (PDF in de bijlage). Per post zie je wat erachter zit.', '');
  if (!g.paypal) r.push('- PayPal: nog niet beschikbaar.');
  else if (!g.paypal.rekeningen.length) r.push('- PayPal: geen PayPal-posten op de bank in ' + g.maand_naam + '.');
  else for (const rk of g.paypal.rekeningen) {
    r.push('- PayPal op …' + rk.rekening_eind + (g.entiteiten.length > 1 ? ' (' + rk.entiteit_naam + ')' : '') + ': ' + rk.aantal + (rk.aantal === 1 ? ' post' : ' posten') + ', samen ' + eur(rk.totaal_centen) +
      (rk.zonder_spec ? ' (' + rk.zonder_spec + ' zonder specificatie: komt van een andere PayPal-rekening)' : '') + '.');
  }
  for (const k of g.kaarten) {
    if (k.status === 'niet_aangeleverd') r.push('- Creditcard ICS …' + k.laatste4 + ', overzicht ' + g.maand_naam + ': heb ik nog niet aangeleverd; die stuur ik na.');
    else r.push('- Creditcard ICS …' + k.laatste4 + ', overzicht ' + g.maand_naam + ': ' + icsZin(k, true) + '.');
  }
  r.push('', 'Groet,', 'David');
  return { onderwerp: onderwerp.slice(0, 150), bericht: r.join('\n') };
}
function bestandsnaam(g, o) {
  return ('Specificatie PayPal en creditcard ' + g.maand + ((o && o.nagekomen) ? ' aanvulling' : '')).replace(/\s+/g, ' ').trim() + '.pdf';
}

/*
 * maakPdf(g, o) → Buffer. o = { stijl (zoals facturen-specificatie.js; null = sober), gemaakt: ISO (UTC), gemaakt_dag: Amsterdamse datum }.
 * Briefhoofd, kop met de maand, deel PayPal (per rekening een tabel en het subtotaal = de PayPal-posten op de bank), deel creditcard (per
 * kaart het overzicht met subtotaal en de incasso op de bank), voet op elke pagina.
 */
function maakPdf(g, o) {
  o = o || {};
  const st = o.stijl || null;
  const W = 595.28, H = 841.89, M = 50, RIJ = 14, PT = 8.5;
  const kTitel = kleur(st && st.kleuren && st.kleuren.titel, [0.17, 0.17, 0.17]);
  const kCaps = kleur(st && st.kleuren && st.kleuren.caps, [0.36, 0.4, 0.44]);
  const kLijn = kleur(st && st.kleuren && st.kleuren.lijn, [0.6, 0.65, 0.68]);
  const kAccent = kleur(st && st.kleuren && st.kleuren.accent, [0.17, 0.17, 0.17]);
  const BREED = W - 2 * M;
  // kolommen: datum, omschrijving, origineel, factuur, bedrag
  const kol = [['Datum', 46, 'l'], ['Omschrijving', 235, 'l'], ['Origineel', 66, 'r'], ['Factuur', 75, 'l'], ['Bedrag', BREED - 422, 'r']];
  const paginas = [];
  let o2 = null, y = 0;
  const txt = (f, pt, x, yy, s, rechts, k) => {
    const w = rechts ? breedte(f, pt, s) : 0;
    o2.push((k ? k + ' rg ' : '') + 'BT /' + f + ' ' + getal(pt) + ' Tf ' + getal(x - w) + ' ' + getal(yy) + ' Td ' + hex(s) + ' Tj ET' + (k ? ' 0 g' : ''));
  };
  const lijn = (yy, k, dik) => o2.push(k + ' RG ' + getal(dik || 0.5) + ' w ' + getal(M) + ' ' + getal(yy) + ' m ' + getal(W - M) + ' ' + getal(yy) + ' l S 0 G');
  const nieuwePagina = () => {
    o2 = []; paginas.push(o2);
    y = H - M;
    if (paginas.length > 1) { txt('F2', 9, M, y - 10, 'Specificatie PayPal en creditcard · ' + g.maand_naam + ' (vervolg)'); y -= 28; }
  };
  const onder = M + 34;
  const ruimte = (n) => { if (y - n < onder) nieuwePagina(); };
  nieuwePagina();
  const namen = [...new Set([...(g.paypal ? g.paypal.rekeningen.map((r) => r.entiteit_naam) : []), ...g.kaarten.map((k) => k.entiteit_naam)])];
  const naam = (st && st.naam) || namen.join(' · ') || 'Specificatie';
  if (st && st.caps) { txt('F1', 7.5, M, y - 8, st.caps, false, kCaps); y -= 12; }
  txt('F2', 15, M, y - 14, pas('F2', 15, (st && st.briefnaam) || naam, BREED), false, kTitel); y -= 20;
  if (st && st.ondertitel) { txt('F1', 8.5, M, y - 9, pas('F1', 8.5, st.ondertitel, BREED), false, kCaps); y -= 13; }
  y -= 6; lijn(y, kAccent, 1.2); y -= 26;
  txt('F2', 13, M, y, 'Specificatie PayPal en creditcard — ' + g.maand_naam); y -= 18;
  txt('F1', 9, M, y, 'Wat er achter de PayPal-posten en de creditcardincasso op de bank zit. Bedragen in euro; + is een uitgave.', false, kCaps); y -= 20;
  const kv = [['Maand', g.maand_naam], ['Gemaakt op', datumNl(isoDag(o.gemaakt_dag) ? o.gemaakt_dag : '')]];
  if (g.paypal) kv.push(['PayPal bijgewerkt tot', g.paypal.bijgewerkt ? datumNl(g.paypal.bijgewerkt) : 'onbekend']);
  for (const [k, v] of kv) { txt('F1', 9, M, y, k); txt('F2', 9, M + 120, y, pas('F2', 9, v, BREED - 120)); y -= 13; }
  y -= 12;
  const kopRegel = () => {
    o2.push('0.93 g ' + getal(M) + ' ' + getal(y - 4) + ' ' + getal(BREED) + ' ' + getal(RIJ) + ' re f 0 g');
    let x = M;
    for (const k of kol) { txt('F2', 7.5, k[2] === 'r' ? x + k[1] - 3 : x + 3, y + 1, k[0], k[2] === 'r'); x += k[1]; }
    y -= RIJ;
  };
  const rij = (cel, i, vet) => {
    if (i % 2 === 1) o2.push('0.97 g ' + getal(M) + ' ' + getal(y - 4) + ' ' + getal(BREED) + ' ' + getal(RIJ) + ' re f 0 g');
    let x = M;
    kol.forEach((k, ki) => { txt(vet ? 'F2' : 'F1', PT, k[2] === 'r' ? x + k[1] - 3 : x + 3, y + 1, pas('F1', PT, cel[ki], k[1] - 6), k[2] === 'r'); x += k[1]; });
    y -= RIJ;
  };
  const sectie = (titel) => { ruimte(60); txt('F2', 11.5, M, y, titel, false, kTitel); y -= 6; lijn(y, kAccent, 0.8); y -= 16; };
  const blok = (kop, rechts, regels, cel, vervolg) => {
    ruimte(22 + RIJ * 3);
    txt('F2', 9.5, M, y, pas('F2', 9.5, kop, BREED - 170), false, kTitel);
    if (rechts) txt('F1', 8.5, W - M, y, rechts, true);
    y -= 15;
    kopRegel();
    regels.forEach((r, i) => {
      if (y - RIJ < onder) { nieuwePagina(); txt('F2', 9.5, M, y, pas('F2', 9.5, vervolg, BREED), false, kTitel); y -= 15; kopRegel(); }
      rij(cel(r), i);
    });
  };
  const subtotaal = (tekst, c) => {
    ruimte(RIJ);
    lijn(y + RIJ - 3.5, kLijn, 0.5);
    txt('F2', PT, M + 3, y + 1, tekst);
    txt('F2', PT, W - M - 3, y + 1, eur(c), true);
    y -= RIJ;
  };
  const noot = (tekst, k) => { ruimte(12); txt('F1', 8, M + 3, y + 1, pas('F1', 8, tekst, BREED - 6), false, k || kCaps); y -= 12; };

  // ── deel 1: PayPal ──
  sectie('PayPal');
  if (!g.paypal) noot('De PayPal-koppeling is nog niet beschikbaar; deze maand zonder PayPal-specificatie.');
  else if (!g.paypal.rekeningen.length) noot('Geen PayPal-posten op de bank in ' + g.maand_naam + '.');
  for (const rk of g.paypal ? g.paypal.rekeningen : []) {
    const kop = 'PayPal-posten op ' + rk.entiteit_naam + ' (rekening …' + rk.rekening_eind + ')';
    blok(kop, rk.aantal + (rk.aantal === 1 ? ' post' : ' posten') + ' · ' + eur(rk.totaal_centen), rk.posten,
      (p) => [dagKort(p.datum), p.omschrijving + (p.opmerking ? ' (' + p.opmerking + ')' : ''), p.origineel, p.factuur, eur(p.bedrag_centen)], kop + ' (vervolg)');
    subtotaal('Subtotaal = de PayPal-posten op …' + rk.rekening_eind + ' in ' + g.maand_naam, rk.totaal_centen);
    if (rk.zonder_spec) noot(rk.zonder_spec + (rk.zonder_spec === 1 ? ' post' : ' posten') + ' zonder specificatie: die nummers kent deze PayPal-rekening niet (een andere PayPal-rekening of een verificatiebedrag).');
    y -= 10;
  }
  y -= 6;
  // ── deel 2: creditcard ──
  sectie('Creditcard');
  if (!g.kaarten.length) noot('Geen creditcard in de Facturen-app.');
  for (const k of g.kaarten) {
    const kop = 'ICS-creditcard …' + k.laatste4 + ' — rekeningoverzicht ' + g.maand_naam;
    if (k.status === 'niet_aangeleverd') {
      ruimte(30); txt('F2', 9.5, M, y, pas('F2', 9.5, kop, BREED), false, kTitel); y -= 15;
      noot('Creditcard nog niet aangeleverd: de transacties van dit rekeningoverzicht volgen.', kTitel);
      if (k.bank_centen != null) noot('ICS-incasso op …' + k.rekening_eind + ': ' + eur(k.bank_centen) + ' (' + k.bank_datums.map((d) => datumNl(d)).join(' en ') + ').');
      y -= 10; continue;
    }
    if (k.status === 'geen') { ruimte(30); txt('F2', 9.5, M, y, pas('F2', 9.5, kop, BREED), false, kTitel); y -= 15; noot('Geen transacties op dit rekeningoverzicht.'); y -= 10; continue; }
    blok(kop, k.aantal + (k.aantal === 1 ? ' transactie' : ' transacties') + ' · ' + eur(k.transacties_centen), k.regels,
      (r) => [dagKort(r.datum), r.omschrijving, r.origineel, r.factuur, eur(r.bedrag_centen)], kop + ' (vervolg)');
    subtotaal('Subtotaal transacties rekeningoverzicht ' + g.maand_naam, k.transacties_centen);
    if (k.status === 'sluit') noot('= de ICS-incasso op …' + k.rekening_eind + ' (' + k.entiteit_naam + ') van ' + k.bank_datums.map((d) => datumNl(d)).join(' en ') + ' (' + eur(k.bank_centen) + '), op de cent.');
    else if (k.status === 'nog_niet_geincasseerd') noot('De ICS-incasso voor dit overzicht staat nog niet op de bank.');
    else noot('ICS-incasso op …' + k.rekening_eind + ': ' + eur(k.bank_centen) + ' (' + k.bank_datums.map((d) => datumNl(d)).join(' en ') + '); verschil ' + eur(k.verschil_centen) + ', nog na te zien.', kTitel);
    if (k.bank_datums.length > 1) noot('Meer dan één bankregel (incasso, correctie of herincasso): alleen de som telt.');
    y -= 10;
  }
  // voet op elke pagina
  const voet = ['Bedragen in euro, zonder btw-uitsplitsing; "Origineel" = bedrag in vreemde valuta. Geen rekeningnummers van tegenpartijen; kaart: laatste 4 cijfers.',
    'Gemaakt door Socev op ' + datumNl(isoDag(o.gemaakt_dag) ? o.gemaakt_dag : '') + ' uit de Facturen-app (PayPal-koppeling en het ICS-overzicht).'];
  paginas.forEach((p, pi) => {
    o2 = p;
    lijn(M + 20, kLijn, 0.4);
    txt('F1', 6.5, M, M + 10, pas('F1', 6.5, voet[0], BREED - 60), false, kCaps);
    txt('F1', 6.5, M, M + 2, pas('F1', 6.5, voet[1], BREED - 60), false, kCaps);
    txt('F1', 7, W - M, M + 10, 'pagina ' + (pi + 1) + ' van ' + paginas.length, true);
  });
  return pdfBestand(paginas, { titel: 'Specificatie PayPal en creditcard ' + g.maand, gemaakt: o.gemaakt, W, H });
}

/*
 * De Voor jou-kaart "ICS — transacties van <maand> uploaden" (voor server.js; mk_voor_jou_zet). x = { sleutel, laatste4, maand,
 * incasso_eerste, nuKort }. Geen paden, wv-nummers of verwijzingen; de stappen staan in de kaart zelf. Deadline: de laatste dag van de maand
 * (de specificatie gaat de 3e van de volgende maand). Grenzen van de databank: titel ≤ 90, waarom ≤ 400, meting ≤ 300.
 */
function kaartIcs(x) {
  const n = MAANDEN[Number(x.maand.slice(5, 7)) - 1];
  const eind = x.maand + '-' + String(new Date(Date.UTC(Number(x.maand.slice(0, 4)), Number(x.maand.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0');
  return { sleutel: x.sleutel, soort: 'doen', waar: 'overal', prive: false, duur_min: 5, volgorde: 40, deadline: eind,
    titel: 'ICS — transacties van ' + n + ' uploaden',
    waarom: 'Begin ' + MAANDEN[Number(MS_VOLGENDE(x.maand).slice(5, 7)) - 1] + ' krijgt je vader de specificatie van ' + n + ': PayPal én de creditcard. De ICS-incasso van ' + n +
      ' staat op de bank (' + dagKort(x.incasso_eerste) + '); welke betalingen erin zitten, ziet Socev pas als jij het overzicht uploadt. Zonder upload gaat de specificatie zonder creditcard.',
    stappen: ['Log in bij ICS (icscards.nl of de ICS-app) en open de zakelijke Mastercard die eindigt op ' + x.laatste4 + '.',
      'Download de transacties als CSV-bestand, vanaf de 1e van vorige maand tot vandaag (overlap mag: dubbele regels slaat Socev over).',
      'Open in de Socev-app Apps › Facturen › Uploads en sleep het bestand erin (of tik op Kies bestanden).',
      'Klaar: deze kaart gaat vanzelf dicht zodra het overzicht van ' + n + ' binnen is.'],
    meting: (x.nuKort ? x.nuKort + ': ' : '') + 'de ICS-incasso van ' + n + ' staat op de bank, het overzicht met de transacties nog niet in Facturen.',
    herkomst: { module: 'facturen', handmatig: 'facturen', doel: { scherm: 'facturen', focus: 'stap:uploads' } } };
}
const MS_VOLGENDE = volgendeMaand;

// Alles in één: de PDF (bytes + sha256), de bestandsnaam en de mailtekst. o = { stijl, gemaakt, gemaakt_dag, nagekomen }
function maak(x, o) {
  const g = opbouw(x);
  const pdf = maakPdf(g, o);
  return { g, pdf, sha256: crypto.createHash('sha256').update(pdf).digest('hex'), naam: bestandsnaam(g, o), mail: mail(g, o) };
}

module.exports = { maak, opbouw, mail, maakPdf, bestandsnaam, kaartIcs, maandNaam, vorigeMaand, volgendeMaand, MaandFout, MAAND_RE };
