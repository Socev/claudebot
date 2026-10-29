'use strict';
/**
 * patientpoort.js — deterministische patiëntpoort (wv1008, 24-10-2026; sinds wv1282 in de pod als marker van OVIS Intake, telstand).
 * Kopie van /opt/data/mk-scripts/wv1008/patientpoort.js (versie patientpoort-2.0); alleen het pad naar facturen-kern.js is relatief.
 * Doel: vóór elke modelstap van de Mail Processor (en later OVIS Intake § 3.2 stap 3) vaststellen of een mail of stuk
 * kenmerken van patiëntgegevens draagt. Geen model, geen netwerk. Uitvoer noemt alleen SOORTEN kenmerken, nooit tekst.
 * Bouwplan: vault 01_Ontwikkeling/Patiëntpoort Mail Processor (bouwplan 24-10-2026).md; Fable-review daar in § 6.
 *
 * Bouwt op facturen-kern.stapPatientkenmerk (BSN met elfproef, IBAN eerst weggepoetst, patiëntwoord + geboortedatum),
 * met de woorden van het Outlook-filter (verwijzing, specialistenbrief, uitslag, recept, casusoverleg, bijlagenaam),
 * HIS-/verwijskenmerken (Promedico, ZorgDomein, Edifact, ICPC, journaal/SOEP) en brief-, lab- en GGZ/jeugdtaal.
 *
 * Beslisregel (tegenhouden = niet naar het model, geen raw_input):
 *   1. bsn met label, patient_geboortedatum of patient_datum (facturen-kern)                         → tegen
 *   2. brieftaal over één patiënt ("bovengenoemde patiënt", "wij zagen bovengenoemde", "patiënt is bekend met") → tegen
 *   3. "betreft: mw./dhr." samen met een medisch kenmerk of het woord patiënt                         → tegen
 *   4. persoonskenmerk (geboortedatum, los elfproefgetal, naam + datum ouder dan een jaar) + medisch kenmerk → tegen
 *   5. medische bijlagenaam samen met een medisch kenmerk of persoonskenmerk                          → tegen
 *   6. bijlage zonder leesbare tekst, ook niet na OCR (leesbaar: false)                               → tegen (fail-closed)
 *   7. leeg geboortedatumveld + "patiënt" (enkelvoud) + medisch kenmerk                               → tegen
 *   8. "patiënt" (enkelvoud) + medische termen: ≥ 3 bij een scan, ≥ 4 bij digitale tekst tot briefomvang → tegen
 * Uitzondering (Davids eigen medische post), alleen als ALLES klopt: Davids eigen BSN staat erin (of zijn eigen
 * geboortedatum en de afzender staat op de lijst eigen zorgverleners), en er staat geen enkel ander BSN, geen andere
 * geboortedatum en geen andere naam + oude datum in. Waarden staan als HMAC-SHA256 met een sleutel op de pod (sha256 van een
 * BSN is in seconden terug te rekenen, Fable #10). Zijn naam alleen telt nooit: die staat als huisarts op elke patiëntbrief.
 * Nooit bij een onleesbaar deel, OCR/scan of arts-aan-arts-taal (wv1920). De intake-router geeft de afzender alleen mee als DKIM uitgelijnd is. De lijst maakt de machinekamer (mk-scripts/wv1920/maak-poort-eigen.py).
 */
const crypto = require('crypto');
const fs = require('fs');
const K = require(process.env.FACTUREN_KERN || require('path').join(__dirname, '..', 'facturen-kern.js'));

const VERSIE = 'patientpoort-2.0';
const MIN_TEKST = 40;
const STUK = 150000;       // facturen-kern.schoon kapt op 200.000 tekens: per 150.000 opknippen (Fable #11)
const OVERLAP = 400;
const BRIEF_MAX = 8000;     // tekens zonder witruimte: een brief van 1–3 pagina's
const DATUM_BRON = '(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}|\\d{1,2}\\s+[a-z]{3,9}\\.?\\s+\\d{4})';
const GEB_LABEL = '(geboortedatum|geboortedat\\.?|geb\\.?\\s?dat(?:um|\\.)?|geboren(?:\\s+op)?|geb\\.?)';
const GEBOORTE = new RegExp('\\b' + GEB_LABEL + '\\s?[:.]?\\s?' + DATUM_BRON, 'gi');
const GEB_VELD = /\b(geboortedatum|geboortedat\.?|geb\.?\s?dat(?:um|\.)?)(?![a-z])/i;
const BSN_KAND = /(?<![\dA-Za-z.,])(\d{9}|\d{4}[ .]\d{2}[ .]\d{3}|\d{3}[ .]\d{3}[ .]\d{3})(?![\dA-Za-z]|[.,]\d)/g;
// Aanspreking + (naam) + kale datum op dezelfde regel: "Dhr. J. Jansen (12-03-1958)". Telt als persoonskenmerk als de datum
// meer dan een jaar terug ligt (een briefdatum is recent; kinderen na 2010 tellen wel, Fable #8).
const PERSOON_DATUM = /\b(mevrouw|mevr\.|mw\.|de heer|dhr\.|pati[eë]nt(?:e)?|cli[eë]nt(?:e)?|jeugdige|betrokkene)\s[^\n]{0,60}?\b(\d{1,2}[-/.]\d{1,2}[-/.](?:19|20)\d{2})\b/gi;

const BRIEF_STERK = new RegExp([
  '\\b(bovengenoemde|bovenvermelde|bovengenoemd|genoemde|voornoemde)\\s+pati[eë]nt(e)?\\b(?![(e])',
  '\\b(wij|ik)\\s+zag(en)?\\s+(bovengenoemde|bovenvermelde|voornoemde|uw\\s+pati[eë]nt)',
  '\\b(bovengenoemde|bovenvermelde|voornoemde)\\s+(op|in)\\s+(onze|de)\\s+(polikliniek|afdeling|spreekuur|praktijk)',
  '\\bpati[eë]nt(e)?\\s+is\\s+(mij\\s+)?bekend\\s+met\\b',
  '\\bbetreft\\s*:?\\s*pati[eë]nt(e)?\\b(?![(e])',
].join('|'), 'i');
const BETREFT_PERSOON = /\bbetreft\s*:?\s*(mevrouw|mevr\.|mw\.|de heer|dhr\.)/i;
const BRIEF_ZWAK = /\b(uw|onze|gezamenlijke)\s+(gezamenlijke\s+)?pati[eë]nt(e)?\b(?![(e])/i;
// ZorgDomein, Edifact-berichtcodes en MedMij staan ook in beleid en ICT-stukken (HAGRO, meting 24-10): kenmerk, geen eigen regel.
const BERICHT = /\bzorgdomein\b[\s\S]{0,200}\b(verwijzing|verwijsbrief|zd-?nummer|aanvraag)\b|\b(verwijzing|verwijsbrief)\b[\s\S]{0,200}\bzorgdomein\b|\bMED(VRI|LAB|RPY|EUR)\b|\bedifact\b|\bmedmij\b/i;
const MEDISCH = new RegExp('\\b(' + [
  'promedico', 'zorgdomein', 'icpc', 'journaalregel', 'soep-?regel', 'his-?nummer', 'pati[eë]ntnummer',
  'verwijsbrief', 'verwijzing\\s+naar', 'specialistenbrief', 'ontslagbrief', 'poliklinie\\w*', 'labuitslag', 'uitslag(en)?\\s+(van|lab|bloed)',
  'bloeduitslag', 'recept(en)?', 'medicatie(overzicht)?', 'anamnese', 'diagnose', 'differentiaal\\w*', 'behandelplan', 'casusoverleg',
  'consult(atie)?', 'spreekuur', 'huisartsenpost', 'triage', 'behandelend\\s+(arts|specialist)', 'voorgeschiedenis', 'contra-?indicatie',
  // brieftaal tussen artsen
  'geachte\\s+collega', 'collegiale\\s+(groet|groeten|hoogachting)', 'lichamelijk\\s+onderzoek', 'aanvullend\\s+onderzoek',
  'klinische\\s+opname', 'opgenomen\\s+op\\s+de\\s+afdeling',
  // dosering en lab
  '\\d\\s*dd\\s*\\d', '\\d+\\s?mg\\b', 'hb', 'kreatinine', 'egfr', 'mmol(/l)?', 'hba1c', 'crp',
  // GGZ en jeugd
  'behandelaar', 'psychiater', 'psycholoog', 'dsm(-?5)?', 'zorgmelding', 'veilig\\s+thuis', 'jeugdige', 'betrokkene',
].join('|') + ')(?![a-z])', 'gi');
const BIJLAGE_MEDISCH = /(verwijs|uitslag|recept|ontslag|specialist|pati[eë]nt|labuitsl|medicatie|zorgdomein|^zd[-_ ]?\d)/i;
const PATIENT_ENK = /\b(pati[eë]nt(e)?|cli[eë]nt(e)?)\b(?![(e])/i;
const ANDER_LABEL = /\b(rsin|fiscaal\w*|loonheffing\w*|omzetbelasting\w*|uzi\w*|agb\w*|big\w*|vestiging\w*|kvk\w*|handelsregister\w*|registratie\w*|abonnee\w*)\W{0,15}$/i;

const zonderAccenten = (s) => String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '');

// Eigen lijst (pod, 0600, buiten vault en sync): { bsn: [hmac], geboortedatum: [hmac van JJJJ-MM-DD], zorgverleners: [domein] }
// met een sleutel in een apart bestand. Ontbreekt iets: lege lijst, dus geen uitzondering (fail-closed).
function laadEigen(pad, sleutelPad) {
  try {
    const j = JSON.parse(fs.readFileSync(pad || process.env.POORT_EIGEN || '/opt/data/secondbrain/poort-eigen.json', 'utf8'));
    const sleutel = fs.readFileSync(sleutelPad || process.env.POORT_EIGEN_SLEUTEL || '/opt/data/secondbrain/poort-eigen.sleutel', 'utf8').trim();
    if (sleutel.length < 32) throw new Error('sleutel');
    return maakEigen(sleutel, j);
  } catch (e) { return maakEigen(null, {}); }
}
function maakEigen(sleutel, j) {
  const h = (x) => (sleutel ? crypto.createHmac('sha256', sleutel).update(String(x)).digest('hex') : null);
  return { h, bsn: new Set(j.bsn || []), geb: new Set(j.geboortedatum || []), zorgverleners: new Set((j.zorgverleners || []).map((d) => String(d).toLowerCase())) };
}

// Knipt elke tekst in stukken van STUK tekens (met overlap) en maakt ze één keer schoon, zodat alle regels dezelfde tekst
// zien en niets voorbij de 200.000 van schoon() buiten beeld valt.
function stukken(teksten) {
  const uit = [];
  for (const ruw of teksten) {
    const t = String(ruw || '');
    if (t.length <= STUK) { uit.push(K.schoon(t)); continue; }
    for (let i = 0; i < t.length; i += STUK - OVERLAP) uit.push(K.schoon(t.slice(i, i + STUK)));
  }
  return uit;
}
function zonderIban(t) {
  for (const i of K.ibansIn(t, { alle: true })) t = t.slice(0, i.positie) + ' '.repeat(i.lengte) + t.slice(i.positie + i.lengte);
  return t;
}
function jaarGeleden(nu) { const d = new Date(nu || Date.now()); d.setUTCFullYear(d.getUTCFullYear() - 1); return d.toISOString().slice(0, 10); }

// Alle persoonskenmerken, eigen en vreemd gescheiden. Tekst gaat niet terug.
function personen(delen, eigen, nu) {
  const uit = { eigen_bsn: 0, eigen_geb: 0, vreemd_bsn: 0, vreemd_geb: 0, vreemd_persoon_datum: 0, los_zonder_label: 0, persoon_datum: 0 };
  const grens = jaarGeleden(nu);
  for (const d0 of delen) {
    const t = zonderIban(d0);
    let m; BSN_KAND.lastIndex = 0;
    while ((m = BSN_KAND.exec(t))) {
      const c = m[1].replace(/\D/g, ''); if (!K.bsnElfproef(c)) continue;
      const voor = t.slice(t.lastIndexOf('\n', m.index) + 1, m.index);
      if (eigen.h && eigen.bsn.has(eigen.h(c))) { uit.eigen_bsn++; continue; }
      if (ANDER_LABEL.test(voor)) continue;
      uit.vreemd_bsn++; uit.los_zonder_label++;
    }
    const z = zonderAccenten(t);
    GEBOORTE.lastIndex = 0;
    while ((m = GEBOORTE.exec(z))) { const d = K.leesDatum(m[2]); if (d && eigen.h && eigen.geb.has(eigen.h(d))) uit.eigen_geb++; else uit.vreemd_geb++; }
    PERSOON_DATUM.lastIndex = 0;
    while ((m = PERSOON_DATUM.exec(z))) {
      const d = K.leesDatum(m[2]); if (!d || d >= grens) continue;
      uit.persoon_datum++;
      if (!(eigen.h && eigen.geb.has(eigen.h(d)))) uit.vreemd_persoon_datum++;
    }
  }
  return uit;
}

/**
 * beoordeel({ teksten: [..], bijlagenamen: [..], onderwerp, afzender, leesbaar: bool, scan: bool, ocr: bool }, { eigen, nu }) →
 *   { tegenhouden, soorten: [..], regel, eigen_uitzondering, versie }
 * `leesbaar: false` = een bijlage zonder tekstlaag waarvan ook OCR niets gaf. `scan: true` = (deels) uit OCR. `ocr: true` = een deel
 * kwam uit OCR (alleen: geen eigen-post-uitzondering; de drempels van regel 8 blijven die van digitale tekst).
 */
function beoordeel(stuk, opties) {
  const eigen = (opties && opties.eigen) || laadEigen();
  const teksten = (stuk.teksten || []).map((x) => String(x || '')).concat(stuk.onderwerp ? [String(stuk.onderwerp)] : []);
  const delen = stukken(teksten);
  const pk = K.stapPatientkenmerk(delen);
  const s = new Set(pk.soorten.filter((x) => x !== 'bsn_los'));
  const p = personen(delen, eigen, opties && opties.nu);
  if (p.los_zonder_label) s.add('bsn_los');
  if (p.persoon_datum) s.add('persoon_datum');
  const med = new Set();
  for (const d of delen) {
    const z = zonderAccenten(d);
    GEBOORTE.lastIndex = 0; if (GEBOORTE.test(z)) s.add('geboortedatum');
    if (GEB_VELD.test(z)) s.add('geboortedatum_veld');
    if (BRIEF_STERK.test(d)) s.add('brieftaal');
    if (BETREFT_PERSOON.test(d)) s.add('betreft_persoon');
    if (BRIEF_ZWAK.test(d)) s.add('uw_patient');
    if (BERICHT.test(d)) s.add('verwijsbericht');
    if (PATIENT_ENK.test(d)) s.add('patient_woord');
    for (const x of (z.match(MEDISCH) || [])) med.add(x.toLowerCase().replace(/\s+/g, ' ').replace(/\d+/g, '9'));
  }
  if (s.has('geboortedatum')) s.delete('geboortedatum_veld');
  if (med.size) s.add('medisch');
  if (med.size >= 3) s.add('medisch_3');
  if (med.size >= 4) s.add('medisch_4');
  if ((stuk.bijlagenamen || []).some((n) => BIJLAGE_MEDISCH.test(zonderAccenten(String(n || ''))))) s.add('bijlagenaam');
  // Alleen een bijlage waarvan pdftotext én OCR niets gaven; een korte mailtekst ("zie bijlage") is geen reden.
  if (stuk.leesbaar === false) s.add('onleesbaar');

  const lengte = delen.reduce((n, d) => n + d.replace(/\s/g, '').length, 0);
  const medisch = s.has('medisch') || s.has('uw_patient') || s.has('verwijsbericht');
  const persoon = s.has('geboortedatum') || s.has('bsn_los') || s.has('persoon_datum');
  const enkel = s.has('patient_woord');
  let regel = null;
  if (s.has('bsn') || s.has('patient_geboortedatum') || s.has('patient_datum')) regel = 1;
  else if (s.has('brieftaal')) regel = 2;
  else if (s.has('betreft_persoon') && (medisch || enkel)) regel = 3;
  else if (persoon && medisch) regel = 4;
  else if (s.has('bijlagenaam') && (medisch || persoon)) regel = 5;
  else if (s.has('onleesbaar')) regel = 6;
  else if (s.has('geboortedatum_veld') && enkel && medisch) regel = 7;
  // Digitaal alleen bij een brief-lengte: beleidsstukken van HAGRO en Tolgaarde (12–37k tekens) haalden ≥ 4 termen (meting 24-10).
  else if (enkel && (stuk.scan ? s.has('medisch_3') : (s.has('medisch_4') && lengte <= BRIEF_MAX))) regel = 8;

  let eigenUitz = false;
  // wv1920 (Fable-review): nooit bij een deel zonder leesbare tekst of uit OCR/scan (een tweede persoon kan onleesbaar of verhaspeld zijn),
  // en nooit bij arts-aan-arts-taal ("bovengenoemde patiënt", "uw patiënt", "geachte collega", "collegiale groet"): die staat niet in
  // Davids eigen post, wel in een specialistenbrief over een patiënt die toevallig dezelfde geboortedatum heeft.
  const collega = [...med].some((x) => x === 'geachte collega' || /^collegiale /.test(x));
  if (regel && !s.has('onleesbaar') && !stuk.scan && !stuk.ocr && !s.has('brieftaal') && !s.has('uw_patient') && !collega) {
    // afzender als kaal adres of "Naam <adres>"; alles anders (twee adressen, geen @) = geen domein
    const af = String(stuk.afzender || '').trim().toLowerCase(), hoek = /^[^<>@]*<([^<>\s]+)>$/.exec(af), adres = hoek ? hoek[1] : af;
    const domein = /^[^@\s<>,;]+@([^@\s<>,;]+)$/.test(adres) ? adres.split('@')[1] : '';
    const eigenAnker = p.eigen_bsn > 0 || (p.eigen_geb > 0 && domein && eigen.zorgverleners.has(domein));
    if (eigenAnker && p.vreemd_bsn === 0 && p.vreemd_geb === 0 && p.vreemd_persoon_datum === 0) { eigenUitz = true; regel = null; }
  }
  return { tegenhouden: regel !== null, soorten: [...s].sort(), regel, eigen_uitzondering: eigenUitz, versie: VERSIE };
}

module.exports = { beoordeel, laadEigen, maakEigen, VERSIE, MIN_TEKST, _intern: { BRIEF_STERK, BRIEF_ZWAK, BERICHT, MEDISCH, BIJLAGE_MEDISCH, personen, stukken } };
