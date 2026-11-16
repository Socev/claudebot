'use strict';
/*
 * nmbrs-betaal.js — betaallijst van een POT-loonrun uit Nmbrs (wv3208, 16-11-2026). PUUR: geen netwerk, geen bestanden, geen klok.
 *
 * WAAROM. David (16-11-2026, knop-Ja 8c6dd086): "Socev ziet een nieuwe POT-loonrun zelf in Nmbrs en zet hem als betaallijst klaar voor de
 * klikrobot, met Davids betaaldatum." De POT-rekening is bij ABN een privérekening: geen batchupload, dus zet de Chrome-extensie POT-invoer
 * elke betaling los in de ABN-takenlijst. Tot nu toe kwam de betaallijst als CSV van Aurore en tikte David de rest. Nmbrs maakt per loonrun
 * zelf een SEPA-betaalbestand (GET runs/{id}/sepa → taak → documents/{taak}); nmbrs-data.js haalt het op, dit bestand leest en controleert
 * het, en maakt op Davids verzoek een nieuw pain.001.001.09 (facturen-sepa.js, hetzelfde formaat als de POT-batch van de Facturen-app) met
 * de betaaldatum die David kiest en de POT-rekening uit de Facturen-app als van-rekening.
 *
 * GRENS. Hier wordt niets betaald of verstuurd. Het bestand gaat alleen als download naar Davids app; hij zet het met de extensie in de
 * ABN-takenlijst en ondertekent daar zelf (grondwet 1 en 6).
 *
 * CONTROLES (hard = geen bestand): elk IBAN haalt mod-97, geen bedrag ≤ 0, de som en het aantal kloppen met de kop van het Nmbrs-bestand,
 * hooguit 500 regels, geen dubbel IBAN+bedrag. Zacht (David ziet het en vinkt het bewust aan): aantal betalingen ≠ aantal medewerkers in de
 * loonrun, van-rekening in het Nmbrs-bestand ≠ POT-rekening in Facturen, of geen POT-rekening bekend.
 */
const S = require('./facturen-sepa.js');

const MAX_REGELS = 500;
const MAAND = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

function ibanNorm(i) { return S.tekst(String(i == null ? '' : i).replace(/\s+/g, '').toUpperCase(), 34).replace(/\s+/g, ''); }
function mod97(iban) {
  const s = ibanNorm(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const r = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of r) { const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch; for (const c of v) rest = (rest * 10 + Number(c)) % 97; }
  return rest === 1;
}
// "1234.5" of "1234.56" → centen (geheel getal); anders null. Komma's (Nmbrs NL) ook.
function centen(s) {
  const t = String(s == null ? '' : s).trim().replace(',', '.');
  if (!/^-?\d{1,11}(\.\d{1,2})?$/.test(t)) return null;
  const neg = t[0] === '-', [h, d] = t.replace('-', '').split('.');
  const c = Number(h) * 100 + Number((d || '').padEnd(2, '0'));
  return neg ? -c : c;
}
function ont(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}
// Eerste element met deze lokale naam (zonder namespace-voorvoegsel), of null. pad = ['Cdtr','Nm'] zoekt Nm binnen Cdtr.
function el(xml, pad) {
  let t = xml;
  for (const n of pad) {
    const re = new RegExp('<(?:[A-Za-z0-9_]+:)?' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?' + n + '>');
    const m = re.exec(t);
    if (!m) return null;
    t = m[1];
  }
  return t;
}
function alle(xml, n) {
  const re = new RegExp('<(?:[A-Za-z0-9_]+:)?' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?' + n + '>', 'g');
  const uit = []; let m;
  while ((m = re.exec(xml)) && uit.length <= MAX_REGELS + 1) uit.push(m[1]);
  return uit;
}

/*
 * Het SEPA-bestand van Nmbrs lezen (pain.001, versie .03 of .09; namespace maakt niet uit).
 * → { ok, fout?, formaat, nb, ctrl_centen, dbtr: {naam, iban}, datum, regels: [{ e2e, naam, iban, centen, oms }] }
 */
function leesPain(tekst) {
  if (typeof tekst !== 'string' || tekst.length < 50 || tekst.length > 8 * 1024 * 1024) return { ok: false, fout: 'leeg of te groot' };
  if (/<!DOCTYPE|<!ENTITY/i.test(tekst)) return { ok: false, fout: 'DOCTYPE/ENTITY in het bestand' };
  const ns = /xmlns(?::\w+)?="urn:iso:std:iso:20022:tech:xsd:(pain\.001\.001\.\d\d)"/.exec(tekst);
  const kern = el(tekst, ['CstmrCdtTrfInitn']);
  if (!ns || kern == null) return { ok: false, fout: 'geen pain.001 (CstmrCdtTrfInitn)' };
  const kop = el(kern, ['GrpHdr']) || '';
  const nbT = el(kop, ['NbOfTxs']), nb = nbT == null || !/^\s*\d{1,6}\s*$/.test(ont(nbT)) ? null : Number(ont(nbT));   // ontbreekt = null, nooit 0
  const ctrl = el(kop, ['CtrlSum']);
  const pmt = alle(kern, 'PmtInf');
  const regels = [];
  let dbtr = null, datum = null;
  const dbtrs = [];   // review wv3208 MOET 2: de van-rekening van élk blok
  for (const p of pmt) {
    const di = el(p, ['DbtrAcct', 'IBAN']), dn = el(p, ['Dbtr', 'Nm']);
    const dib = di == null ? null : ibanNorm(ont(di));
    if (dib && dbtrs.indexOf(dib) < 0) dbtrs.push(dib);
    if (!dbtr) dbtr = { naam: dn == null ? null : ont(dn), iban: dib };
    const dt = el(p, ['ReqdExctnDt', 'Dt']) || el(p, ['ReqdExctnDt']);
    if (!datum && dt) datum = ont(dt).slice(0, 10);
    for (const t of alle(p, 'CdtTrfTxInf')) {
      const a = el(t, ['InstdAmt']);
      regels.push({
        e2e: el(t, ['EndToEndId']) == null ? null : ont(el(t, ['EndToEndId'])),
        naam: el(t, ['Cdtr', 'Nm']) == null ? null : ont(el(t, ['Cdtr', 'Nm'])),
        iban: el(t, ['CdtrAcct', 'IBAN']) == null ? null : ibanNorm(ont(el(t, ['CdtrAcct', 'IBAN']))),
        centen: a == null ? null : centen(ont(a)),
        // review wv3208 MOET 1: attribuut met enkele of dubbele aanhalingstekens; geen valuta = geen euro (hard)
        munt: (/<(?:\w+:)?InstdAmt\b[^>]*\bCcy\s*=\s*(["'])([A-Za-z]{3})\1/.exec(t) || [])[2] || null,
        oms: el(t, ['Ustrd']) == null ? null : ont(el(t, ['Ustrd'])),
      });
    }
  }
  return { ok: true, formaat: ns[1], nb: Number.isInteger(nb) ? nb : null, ctrl_centen: ctrl == null ? null : centen(ont(ctrl)), dbtr, dbtrs, datum, regels };
}

/*
 * Controles. o = { medewerkers_run (getal of null), pot_iban (IBAN van de POT-rekening in Facturen, of null) }.
 * → { hard: [code…], zacht: [code…], aantal, totaal_centen }. Codes, geen namen of bedragen (ze gaan naar logs en meldingen).
 */
function controle(p, o) {
  o = o || {};
  const hard = [], zacht = [];
  const r = (p && p.regels) || [];
  if (!p || !p.ok) hard.push('onleesbaar');
  if (!r.length) hard.push('leeg');
  if (r.length > MAX_REGELS) hard.push('te_veel_regels');
  if (r.some((x) => !mod97(x.iban))) hard.push('iban_mod97');
  if (r.some((x) => !Number.isSafeInteger(x.centen))) hard.push('bedrag_onleesbaar');
  else if (r.some((x) => x.centen <= 0)) hard.push('bedrag_niet_positief');
  if (r.some((x) => String(x.munt || '').toUpperCase() !== 'EUR')) hard.push('geen_euro');
  if (r.some((x) => !x.naam || !S.tekst(x.naam, 70))) hard.push('naam_leeg');
  const totaal = r.reduce((s, x) => s + (Number.isSafeInteger(x.centen) ? x.centen : 0), 0);
  if (p && p.nb != null && p.nb !== r.length) hard.push('aantal_kop');
  if (p && p.ctrl_centen != null && p.ctrl_centen !== totaal) hard.push('som_kop');
  if (p && p.ok && (p.nb == null || p.ctrl_centen == null)) zacht.push('kop_zonder_controletotaal');
  const gezien = new Set();
  for (const x of r) { const k = x.iban + '|' + x.centen; if (gezien.has(k)) { hard.push('dubbel'); break; } gezien.add(k); }
  if (!Number.isInteger(o.medewerkers_run)) zacht.push('medewerkers_run_onbekend');
  else if (o.medewerkers_run !== r.length) zacht.push('aantal_medewerkers');
  if (!o.pot_iban || !mod97(o.pot_iban)) hard.push('pot_rekening_onbekend');
  else {
    const v = p && Array.isArray(p.dbtrs) ? p.dbtrs : p && p.dbtr && p.dbtr.iban ? [p.dbtr.iban] : [];
    if (v.some((i) => ibanNorm(i) !== ibanNorm(o.pot_iban))) zacht.push('andere_van_rekening');
  }
  return { hard: [...new Set(hard)], zacht: [...new Set(zacht)], aantal: r.length, totaal_centen: totaal };
}
const UITLEG = {
  onleesbaar: 'het bestand van Nmbrs is geen leesbaar SEPA-bestand', leeg: 'er staan geen betalingen in', te_veel_regels: 'meer dan 500 betalingen',
  iban_mod97: 'een rekeningnummer haalt de controle (mod-97) niet', bedrag_onleesbaar: 'een bedrag is niet te lezen',
  bedrag_niet_positief: 'een bedrag is nul of negatief', geen_euro: 'een bedrag is niet (aantoonbaar) in euro', naam_leeg: 'een betaling heeft geen naam',
  aantal_kop: 'het aantal betalingen klopt niet met de kop van het bestand', som_kop: 'het totaal klopt niet met de kop van het bestand',
  dubbel: 'twee betalingen met hetzelfde rekeningnummer en bedrag', pot_rekening_onbekend: 'de POT-rekening staat niet (geldig) in de Facturen-app',
  kop_zonder_controletotaal: 'het bestand van Nmbrs heeft geen controletotaal in de kop',
  medewerkers_run_onbekend: 'het aantal medewerkers in de loonrun is niet bekend', aantal_medewerkers: 'het aantal betalingen is anders dan het aantal medewerkers in de loonrun',
  andere_van_rekening: 'Nmbrs noemt een andere van-rekening dan de POT-rekening; het bestand gebruikt de POT-rekening',
  regels_gewist: 'de regels zijn na 60 dagen gewist',
};

function maandTekst(run, periodeSoort) {
  const p = Number(run && run.periodEnd), j = Number(run && run.year);
  if (periodeSoort === 'month' && p >= 1 && p <= 12) return MAAND[p - 1] + ' ' + j;
  return 'periode ' + (Number.isInteger(p) ? p : '?') + ' ' + j;
}
// Bestandsnaam zonder namen: POT-salarissen-2026-R12-betaal-2026-11-25.xml
function bestandNaam(run, datum) {
  return 'POT-salarissen-' + Number(run.year) + '-R' + Number(run.number) + '-betaal-' + datum + '.xml';
}

/*
 * Het bestand voor de extensie. a = { run: {year, number, periodEnd}, periode_soort, regels (uit leesPain), controle, pot: {iban, naam},
 * datum, vandaag, msg_hex (8 hex, van de beller), cre_dt_tm, bewust (zachte punten gezien) }.
 * → { ok:true, naam, tekst, aantal, totaal_centen, sha256 } of { ok:false, fout, code }
 */
function bestand(a) {
  const c = a.controle || {};
  if ((c.hard || []).length) return { ok: false, code: 'controle', fout: 'niet te maken: ' + c.hard.map((h) => UITLEG[h] || h).join('; ') };
  if ((c.zacht || []).length && a.bewust !== true) return { ok: false, code: 'bewust', fout: 'bevestig eerst dat je dit gezien hebt: ' + c.zacht.map((h) => UITLEG[h] || h).join('; ') };
  const df = S.datumFout(a.datum, a.vandaag);
  if (df) return { ok: false, code: 'datum', fout: df };
  const oms = 'Salaris ' + maandTekst(a.run, a.periode_soort);
  const regels = a.regels.map((x, i) => ({
    factuur: S.id(x.e2e && x.e2e !== 'NOTPROVIDED' ? x.e2e : 'POT-' + a.run.year + '-R' + a.run.number + '-' + (i + 1), 35) || ('POT-R' + a.run.number + '-' + (i + 1)),
    datum: a.datum, centen: x.centen, iban: x.iban, naam: x.naam, rmt: { ustrd: S.tekst(x.oms || oms, 140) || oms },
  }));
  const kop = { msg_id: S.nieuwMsgId(a.vandaag, a.msg_hex), cre_dt_tm: a.cre_dt_tm, initg_naam: a.pot.naam, dbtr_naam: a.pot.naam,
    dbtr_iban: ibanNorm(a.pot.iban), dbtr_bic: S.bicVoor(a.pot.iban) };
  const x = S.xml(kop, regels);
  return { ok: true, naam: bestandNaam(a.run, a.datum), tekst: x.tekst, aantal: regels.length, totaal_centen: regels.reduce((s, r) => s + r.centen, 0), sha256: S.sha256(x.tekst) };
}

module.exports = { leesPain, controle, bestand, mod97, centen, ibanNorm, maandTekst, bestandNaam, UITLEG, MAX_REGELS };
