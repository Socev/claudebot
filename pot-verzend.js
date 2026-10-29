'use strict';
/*
 * pot-verzend.js — nota's uit Davids POT-app als Gmail-concept klaarzetten (wv911, 23-10-2026).
 * Bouwplan: vault "01_Ontwikkeling/POT-app - nota's klaarzetten voor verzending (bouwplan 23-10-2026).md".
 *
 * WAAROM. David 23-10-2026: "na aanmaken van de factuur, moet de factuur voor de desbetreffende entiteit als concept klaar gezet. Om te
 * weten waar dat dan naar toe moet, zou voor de entiteit in de Second Brain kaart vastgelegd moeten zijn naar wie een factuur moet gaan.
 * Dat wordt dan ter plekke opgezocht (...) kunnen we ook een verzenddatum in de toekomst doen trouwens?"
 *
 * HOE. Zijn POT-app (werk.socev.dev/pot, Pages Function) zet per nota een rij in D1 `fin.nota_verzending` (status wacht, PDF uit de
 * browser, onderwerp en tekst door de server bepaald, niet_voor = nu of de gekozen dag 07:00). Deze ronde (elke minuut, alleen de
 * primaire pod, schakelaar aan) pakt wachtende rijen op, zoekt de ontvanger op in de Second Brain (frontmatter `fin_praktijk` +
 * `facturen_aan` op de praktijkpagina; sinds wv1763 per schakelaar het vastgezette factuuradres uit het OVIS-register), controleert de PDF (sha256 + pdftotext: nummer, bedrag en praktijknaam moeten erin staan) en
 * zet per nota één concept klaar via het bestaande mailluik. Versturen doet David zelf in Gmail; deze module kan dat niet.
 * Toestanden: wacht → bezig → concept → verzonden, of wacht_op_adres / onzeker / fout / concept_weg. Fable-review vooraf (23-10):
 * per nota (niet per ontvanger), klok in D1, bezig > 10 min = onzeker en zelfherstel via Gmail `filename:<nummer>`, voorcontrole vóór
 * elke aanroep, afwijkend of nieuw adres = eerst bevestigen in de app (geen concept), PDF-inhoud nagerekend.
 *
 * PUUR. Alleen crypto. D1, het lees-luik, het mailluik, pdftotext, de vault, Voor jou en het conceptregister komen van server.js (io).
 * Geen eigen klok: wat aan de beurt is én alle tijdstempels komen van D1 (strftime('now')), want de podklok liep eerder dagen mis.
 */
const crypto = require('crypto');

const GRENS = { perTik: 20, perDag: 40, pdfMax: 250 * 1024, onzekerPerTik: 10, meetPerUur: 15, meetDagen: 90, conceptWegUur: 2, pogingenMax: 3 };
const D1_NU = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const KOL = 'id, nota_id, entiteit, nummer, praktijk_id, status, niet_voor, plan_datum, onderwerp, bericht, van, pdf_naam, pdf_b64, pdf_sha256, pdf_bytes, aangevraagd_op, reden, aan, cc, bron_pagina, concept_id, thread_id, concept_op, pogingen, geclaimd_op, opmerking, auto, vrijgave_id, verzend_reservering_op, message_id, fout';
const ADRES_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const ID_RE = /^P\d{2}$/;
const ENT_NAAM = { SLOEL: 'SLOEL', POT: 'POT', KM: 'KM POH-GGZ', PROEF: 'PROEF' };
// wv1933: waar David zijn nota's beheert. Tot de overstap de oude POT-app (werk.socev.dev/pot), daarna OVIS POT in de Socev-app; server.js
// zet dit vóór elke ronde uit de schakelaar <POT_VZ_DIR>/ovis-pot-schrijft (zetOvis). Kaarten krijgen altijd module 'pot' + doel (de App
// leest ook vóór de overstap, en annuleren kan daar altijd).
let OVIS = false;
function zetOvis(aan) { OVIS = aan === true; }
const app = () => (OVIS ? 'OVIS POT' : 'de POT-app');
const appNotas = () => (OVIS ? "OVIS POT › Nota's" : "de POT-app (tab Nota's)");
const appKop = () => (OVIS ? 'OVIS POT' : 'POT-app');
const potDoel = (ent) => ({ module: 'pot', doel: { scherm: 'pot', focus: 'notas:' + String(ent || 'alle').toLowerCase().replace(/[^a-z]/g, '') } });

// ── ontvangers uit de Second Brain ────────────────────────────────────────────
// Alleen het eerste frontmatterblok; alleen de drie sleutels; vormen: `k: waarde`, `k: [a, b]`, `k:` + regels `  - a`.
function frontmatter(tekst) {
  const t = String(tekst || '').replace(/\r\n?/g, '\n');
  if (!t.startsWith('---\n')) return {};
  const eind = t.indexOf('\n---', 4);
  if (eind < 0) return {};
  const regels = t.slice(4, eind).split('\n');
  const uit = {};
  const SLEUTELS = ['fin_praktijk', 'facturen_aan', 'facturen_cc'];
  for (let i = 0; i < regels.length; i++) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(regels[i]);
    if (!m || !SLEUTELS.includes(m[1])) continue;
    let w = m[2].replace(/(^|\s+)#.*$/, '').trim();
    let lijst;
    if (w === '') {
      lijst = [];
      while (i + 1 < regels.length && /^\s+-\s*/.test(regels[i + 1])) lijst.push(regels[++i].replace(/^\s+-\s*/, ''));
    } else if (/^\[.*\]$/.test(w)) lijst = w.slice(1, -1).split(',');
    else lijst = [w];
    uit[m[1]] = lijst.map((x) => String(x).trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
  }
  return uit;
}
const adresTekst = (lijst) => (lijst || []).map((a) => String(a).trim().toLowerCase()).filter(Boolean).join(', ');
const adresNorm = (s) => adresTekst(String(s || '').split(/[,;\s]+/));
// paginas: [{ pad, tekst }] → { per: { P01: { aan: [..], cc: [..], pagina } }, problemen: { P01: 'reden' } }
function ontvangers(paginas) {
  const per = {}, problemen = {};
  for (const p of paginas || []) {
    const f = frontmatter(p.tekst);
    if (!f.fin_praktijk) continue;
    const ids = f.fin_praktijk.filter((x) => ID_RE.test(x));
    const aan = (f.facturen_aan || []).map((a) => a.toLowerCase()), cc = (f.facturen_cc || []).map((a) => a.toLowerCase());
    const slecht = [...aan, ...cc].filter((a) => !ADRES_RE.test(a));
    const naam = paginaNaam(p.pad);
    for (const id of ids) {
      if (slecht.length) { problemen[id] = `het factuuradres op de pagina ${naam} is onleesbaar (${slecht.join(', ').slice(0, 80)})`; continue; }
      if (!aan.length) { if (!per[id] && !problemen[id]) problemen[id] = `op de pagina ${naam} staat nog geen factuuradres (veld facturen_aan)`; continue; }
      if (per[id] && (adresTekst(per[id].aan) !== adresTekst(aan) || adresTekst(per[id].cc) !== adresTekst(cc))) {
        problemen[id] = `twee pagina's geven een ander factuuradres (${per[id].naam} en ${naam})`; continue;
      }
      if (!per[id]) { per[id] = { aan, cc, pagina: p.pad, naam }; if (/geen factuuradres/.test(problemen[id] || '')) delete problemen[id]; }
    }
  }
  for (const id of Object.keys(problemen)) if (/twee pagina's|onleesbaar/.test(problemen[id])) delete per[id];
  return { per, problemen };
}
// wv1763 (OVIS plek 4 fase 2, ontwerp mk-scripts/wv1763/ontwerp.md): het factuuradres komt uit het register van de Second Brain
// (stampagina + vastgezet adres, ovis-register.js potFactuur) in plaats van facturen_aan op de dossierpagina. Overgang per schakelaar
// (server.js leest /opt/data/pot-verzend/adresbron): dossier = zoals tot nu; proef en kaarten = proefpraktijken P9x uit het register, de
// rest nog van de dossierpagina; register = alles uit het register. Een praktijk op het register valt nooit terug op de dossierpagina.
const ADRESBRONNEN = ['dossier', 'proef', 'kaarten', 'register'];
const bronVan = (bron, px) => (bron === 'register' || ((bron === 'proef' || bron === 'kaarten') && /^P9\d$/.test(String(px))) ? 'register' : 'dossier');
// → { bron, per, problemen, onleesbaar(px), bronVan(px) }; gooit nooit (wat niet te lezen is staat in uit.fouten en in onleesbaar)
async function adressen(io, bron, uit) {
  bron = ADRESBRONNEN.includes(bron) ? bron : 'dossier';
  let dos = null, reg = null;
  if (bron !== 'register') { try { dos = ontvangers(await io.vault()); } catch (e) { uit.fouten.push('vault'); } }
  if (bron !== 'dossier') {
    try { reg = typeof io.registerAdressen === 'function' ? await io.registerAdressen() : null; } catch (e) { reg = null; }
    if (!reg || typeof reg.per !== 'object' || !reg.per || typeof reg.problemen !== 'object' || !reg.problemen) { reg = null; uit.fouten.push('adresregister'); }
    else if (Number(reg.onleesbaar) > 0) uit.fouten.push('adresregister');   // Fable wv1763 ZOU 5: een onleesbare stampagina telt mee voor de box
  }
  const per = {}, problemen = {};
  for (const [bronObj, soort] of [[dos, 'dossier'], [reg, 'register']]) {
    if (!bronObj) continue;
    for (const px of Object.keys(bronObj.per)) {
      if (bronVan(bron, px) !== soort) continue;
      const o1 = bronObj.per[px], aan = Array.isArray(o1 && o1.aan) ? o1.aan : [];
      // register: zelfde mailregel als de dossierpagina (een factuuradres kan elders een postadres zijn)
      if (soort === 'register' && (!aan.length || aan.some((a) => !ADRES_RE.test(String(a))) || (o1.cc || []).length)) { problemen[px] = `het vastgezette factuuradres van ${o1 && o1.naam || px} is geen (enkel) mailadres`; continue; }
      per[px] = o1;
    }
    for (const px of Object.keys(bronObj.problemen)) if (bronVan(bron, px) === soort) problemen[px] = bronObj.problemen[px];
  }
  // register: een praktijk zonder uitslag terwijl er een stampagina niet te lezen was = niet gemeten (opnieuw), geen "geen adres"
  const regWeg = (px) => !reg || (!reg.per[px] && !reg.problemen[px] && Number(reg.onleesbaar) > 0);
  return { bron, per, problemen, bronVan: (px) => bronVan(bron, px), onleesbaar: (px) => (bronVan(bron, px) === 'register' ? regWeg(px) : !dos) };
}
const geenAdresTekst = (ontv, px, praktijk) => ontv.problemen[px] || (ontv.bronVan(px) === 'register'
  ? `voor ${praktijk} staat geen stamkaart in de Second Brain die naar deze praktijk verwijst`
  : `voor ${praktijk} staat geen factuuradres in de Second Brain (veld facturen_aan op de praktijkpagina)`);
function paginaNaam(pad) { return String(pad || '').split('/').pop().replace(/\.md$/, '').replace(/^index$/, String(pad || '').split('/').slice(-2, -1)[0] || 'index'); }

// ── PDF ──────────────────────────────────────────────────────────────────────
const nf0 = (x) => new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 0 }).format(Math.abs(Math.round(Number(x) || 0)));
const plat = (s) => String(s || '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
function pdfBytes(rij) {
  if (typeof rij.pdf_b64 !== 'string' || !rij.pdf_b64) return { ok: false, fout: 'de PDF ontbreekt in de wachtrij' };
  const b = Buffer.from(rij.pdf_b64, 'base64');
  if (!b.length || b.length > GRENS.pdfMax || b.length !== Number(rij.pdf_bytes)) return { ok: false, fout: 'de PDF heeft niet de verwachte grootte' };
  if (b.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, fout: 'het bestand is geen PDF' };
  if (crypto.createHash('sha256').update(b).digest('hex') !== String(rij.pdf_sha256 || '')) return { ok: false, fout: 'de PDF is onderweg veranderd (sha256)' };
  return { ok: true, bytes: b };
}
// De PDF moet bij déze nota horen: nummer, bedrag (hele euro's, zoals op de nota) en de naam van de praktijk staan erin.
function pdfHoortBij(tekst, nota) {
  const t = plat(tekst);
  const mist = [];
  if (!t.includes(String(nota.nummer))) mist.push('nummer ' + nota.nummer);
  if (!t.includes('€ ' + nf0(nota.bedrag))) mist.push('bedrag € ' + nf0(nota.bedrag));
  const naam = plat(nota.naam_brief || nota.naam || '');
  if (!naam || !t.includes(naam)) mist.push('praktijknaam');
  return { ok: !mist.length, mist };
}

// ── Gmail (lees-luik) ────────────────────────────────────────────────────────
const gmailDatum = (iso, dagenTerug) => { const d = new Date(Date.parse(iso) - (dagenTerug || 0) * 864e5); return isNaN(d) ? '2026/01/01' : d.toISOString().slice(0, 10).replace(/-/g, '/'); };
const labels = (m) => (Array.isArray(m.labels) ? m.labels : String(m.labels || '').replace(/[[\]'"\s]/g, '').split(',')).map((x) => String(x).toUpperCase());
// Concepten/verzonden mails van deze nota: zelfde bestand (filename:<nummer>), zelfde onderwerp, eerste ontvanger in `aan`.
async function zoekInGmail(io, rij, vanaf) {
  const j = await io.luik({ actie: 'mail_zoeken', query: `filename:${rij.nummer} {in:draft in:sent} after:${gmailDatum(vanaf, 1)}`, max: 20 });
  const mails = Array.isArray(j) ? j : (j && Array.isArray(j.mails) ? j.mails : null);
  if (!mails) throw new Error('lees-luik zonder lijst');
  const eerste = String(rij.aan || '').split(',')[0].trim().toLowerCase();
  const past = mails.filter((m) => String(m.onderwerp || '').trim() === String(rij.onderwerp).trim() && (!eerste || String(m.aan || '').toLowerCase().includes(eerste)));
  // verzonden ook als David onderwerp of ontvanger in het concept aanpaste: dan herkennen we hem aan de draad (Fable diffreview #6)
  const verzonden = past.find((m) => labels(m).includes('SENT')) || (rij.thread_id ? mails.find((m) => labels(m).includes('SENT') && m.thread_id === rij.thread_id) : null);
  const concept = past.find((m) => labels(m).includes('DRAFT'));
  return { verzonden: verzonden || null, concept: concept || null };
}

// ── mail ─────────────────────────────────────────────────────────────────────
function mailBody(rij, ontv) {
  const b = { aan: ontv.aan.join(', '), onderwerp: String(rij.onderwerp).slice(0, 150), bericht: String(rij.bericht).slice(0, 3000),
    bijlagen: [{ naam: rij.pdf_naam, mime: 'application/pdf', inhoud_base64: rij.pdf_b64 }] };
  if (ontv.cc && ontv.cc.length) b.cc = ontv.cc.join(', ');
  if (rij.van) b.van = rij.van;
  return b;
}

// ── Voor jou ─────────────────────────────────────────────────────────────────
const dm = (iso) => { const [j, m, d] = String(iso).slice(0, 10).split('-'); return `${Number(d)}-${Number(m)}`; };
// Grenzen van machinekamer.voor_jou (CHECK): titel 3–90, waarom ≤ 400, meting ≤ 300, ≤ 12 stappen; anders weigert de databank de kaart
const kap = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function kaartGrens(p) { return Object.assign(p, { titel: kap(p.titel, 90), waarom: kap(p.waarom, 400), meting: kap(p.meting, 300), stappen: (p.stappen || []).slice(0, 12) }); }
const korteHash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
function kaartGepland(ent, plan, rijen, nuKort) {
  const nrs = rijen.map((r) => r.nummer).sort();
  return kaartGrens({ sleutel: `pot-verzend-${ent.toLowerCase()}-${plan}`, soort: 'doen', volgorde: 25, deadline: plan, waar: 'overal', prive: true, duur_min: 2 + rijen.length,
    titel: `${ENT_NAAM[ent] || ent}-nota's van ${dm(plan)} — versturen`,
    herkomst: { handmatig: 'pot-verzend', entiteit: ent, plan_datum: plan, ...potDoel(ent) },
    waarom: `Je liet in ${app()} ${rijen.length} nota${rijen.length > 1 ? "'s" : ''} klaarzetten voor ${dm(plan)}. Socev heeft vanochtend per nota een concept in Gmail gezet, met de PDF eraan, aan het factuuradres uit de Second Brain. Versturen doe je zelf.`,
    stappen: ['Open Gmail op je telefoon of laptop en ga naar Concepten.',
      `Zoek de concepten van ${nrs.length > 1 ? `de nota's ${nrs.join(', ')}` : `nota ${nrs[0]}`} (onderwerp ${rijen[0].onderwerp}).`,
      'Kijk per concept de ontvanger, de tekst en de PDF na en verstuur het.',
      `In ${appNotas()} staat binnen een uur 'verzonden'; deze kaart gaat dan vanzelf dicht.`],
    meting: `${nuKort}: ${rijen.length} concept${rijen.length > 1 ? 'en staan' : ' staat'} klaar in Gmail.` });
}
function kaartAdres(rijen, nuKort, bron) {
  const regels = [...new Set(rijen.map((r) => `${r.praktijk}: ${r.reden}`))];
  const bevestig = rijen.some((r) => /^adres_(gewijzigd|nieuw)/.test(r.opmerking || ''));
  const viaRegister = rijen.some((r) => bronVan(bron, r.praktijk_id) === 'register');
  const voorbeeld = rijen[0] && rijen[0].praktijk ? String(rijen[0].praktijk).slice(0, 60) : 'de praktijk';
  // sleutel ook op de bron (Fable wv1763 KAN 6): na een wissel naar het register komt de kaart met de vastzetstap, niet de oude tekst
  return kaartGrens({ sleutel: 'pot-verzend-adres-' + korteHash(rijen.map((r) => r.id).sort().join(',') + (viaRegister ? '|register' : '')), soort: 'doen', volgorde: 22, waar: 'overal', prive: true, duur_min: 5,
    deadline: rijen.map((r) => r.deadline).sort()[0],
    titel: `${appKop()} — factuuradres ${bevestig ? 'bevestigen of ' : ''}aanvullen (${rijen.length} nota${rijen.length > 1 ? "'s" : ''})`,
    herkomst: { handmatig: 'pot-verzend', soort: 'adres', ids: rijen.map((r) => r.id), ...potDoel(rijen[0] && rijen[0].entiteit) },
    waarom: 'Socev zet een nota pas als concept klaar als het factuuradres in de Second Brain staat' + (viaRegister ? ' (vastgezet met je vingerafdruk)' : '') + ' en het hetzelfde is als het adres dat ' + app() + ' kent. Bij deze nota\'s klopt dat nog niet: ' + regels.join('; ') + '.',
    stappen: [...(viaRegister ? ["Staat er in Voor jou een kaart 'factuuradres voor POT-nota's — zo vastzetten?': kijk het adres na en druk Ja met je vingerafdruk."] : []),
      ...(bevestig ? [OVIS ? "Klopt het nieuwe adres? Open OVIS POT › Nota's, tik op de nota en dan op 'Adres klopt'." : "Klopt het nieuwe adres? Open de POT-app, tab Nota's, en tik bij de nota op 'adres klopt'."] : []),
      `Ontbreekt het adres of klopt het niet: zeg tegen Socev "factuuradres ${voorbeeld} is …". Socev zet het in de Second Brain` + (viaRegister ? '; daarna komt er een kaart om het vast te zetten.' : '.'),
      'Socev kijkt elke tien minuten opnieuw en zet het concept dan vanzelf klaar; deze kaart gaat daarna dicht.'],
    meting: `${nuKort}: ${rijen.length} nota${rijen.length > 1 ? "'s wachten" : ' wacht'} op een factuuradres.` });
}
function kaartFout(rijen, nuKort) {
  return kaartGrens({ sleutel: 'pot-verzend-fout-' + korteHash(rijen.map((r) => r.id).sort().join(',')), soort: 'doen', volgorde: 21, waar: 'overal', prive: true, duur_min: 5,
    deadline: rijen.map((r) => r.deadline).sort()[0],
    titel: `${appKop()} — ${rijen.length} nota${rijen.length > 1 ? "'s" : ''} niet klaargezet`,
    herkomst: { handmatig: 'pot-verzend', soort: 'fout', ids: rijen.map((r) => r.id), ...potDoel(rijen[0] && rijen[0].entiteit) },
    waarom: 'Socev kon deze nota\'s niet als concept klaarzetten: ' + rijen.map((r) => `${r.nummer} (${r.fout})`).join('; ').slice(0, 600) + '. Er staat voor deze nota\'s dus niets in Gmail, tenzij hieronder anders staat.',
    stappen: [OVIS ? "Open OVIS POT › Nota's: bij deze nota's staat 'niet gelukt' (tik op de nota voor de reden)." : "Open de POT-app, tab Nota's: bij deze nota's staat 'niet gelukt' (houd je vinger op het label voor de reden).",
      "Selecteer ze en tik nog eens op 'Zet klaar voor verzending'. Lukt het weer niet, zeg het dan in de machinekamer.",
      'Deze kaart gaat vanzelf dicht zodra ze opnieuw klaarstaan.'],
    meting: `${nuKort}: ${rijen.length} nota${rijen.length > 1 ? "'s" : ''} niet klaargezet.` });
}

// ════════════════════════════════════════════════════════════════════════════
// Automatisch versturen op de gekozen datum (wv921, 23-10-2026; David Ja op het ontwerp 23-10 12:39, vraag-id b20f2f6c).
// Ontwerp: vault "01_Ontwikkeling/POT-app - nota's automatisch versturen op datum (ontwerp 23-10-2026).md" (Fable vooraf GO-met-wijzigingen).
// Grondwet 1, uitzondering (David, 23-10-2026): "SLOEL-nota's uit de POT-app die David zelf met een verzenddatum klaarzette en per batch
// met een verse vingerafdruk vrijgaf, verstuurt de pod op die dag als één mail per nota, alleen naar het bevestigde factuuradres van de
// praktijk, met de PDF die David maakte. Al het andere blijft concept."
// Toestanden (eigen statussen, buiten elke where-clausule van de conceptroute hierboven, Fable #4):
//   auto_gevraagd → (pod: vrijgave + besluitkaart; David Ja met verse vingerafdruk; knoproute in server.js) auto_vrij
//   auto_vrij → (op de dag, 09:00–12:00 Amsterdam, werkdag, schakelaar auto) verzenden → auto_verstuurd | onzeker_verzonden
//   voorcontrole vond hem al in Verzonden → verstuurd_door_david
//   alles wat niet automatisch kan (geen Ja, controle faalt, na 12:00, schakelaar uit) → 'wacht': de conceptroute van wv911 (07:00)
//   onzeker_verzonden komt NOOIT terug in de wachtrij: alleen-lezend terugzoeken in Verzonden, na 24 uur een kaart (Fable #4, #8).
// Gmail kent geen idempotentiesleutel en de verzender bewaart geen runs: de reservering 'auto_vrij' → 'verzenden' (gecommit vóór de
// aanroep) is de enige grens tegen dubbel versturen.
const AUTO = { vanUur: 9, totUur: 12, perDag: 12, perBatch: 9, vooraf: 45, onzekerUur: 24, verzendenMin: 10 };
const AUTO_BEVESTIGING = 'knop-ja-vers-kaart';   // server.js appKnopBevestiging: Ja met verse vingerafdruk, telefoon of meereizend, op een kaart
const dagNamen = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];

// Tijd in Amsterdam van een UTC-tijd uit D1 (geen podklok).
function amsterdam(isoUtc) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(isoUtc)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, uur: Number(p.hour), min: Number(p.minute) };
}
const ymdPlus = (ymd, d) => new Date(Date.parse(ymd + 'T12:00:00Z') + d * 864e5).toISOString().slice(0, 10);
// Pasen (anonieme gregoriaanse berekening) → ymd
function pasen(j) {
  const a = j % 19, b = Math.floor(j / 100), c = j % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const maand = Math.floor((h + l - 7 * m + 114) / 31), dag = ((h + l - 7 * m + 114) % 31) + 1;
  return `${j}-${String(maand).padStart(2, '0')}-${String(dag).padStart(2, '0')}`;
}
// Nederlandse feestdagen (ook Goede Vrijdag en 5 mei: dan gaat er niets automatisch de deur uit). Zelfde regel als de POT-app (Function).
function feestdag(ymd) {
  const j = Number(ymd.slice(0, 4)), md = ymd.slice(5), p = pasen(j);
  const kd = new Date(Date.UTC(j, 3, 27)).getUTCDay() === 0 ? '04-26' : '04-27';
  return ['01-01', kd, '05-05', '12-25', '12-26'].includes(md) || [-2, 0, 1, 39, 49, 50].some((x) => ymdPlus(p, x) === ymd);
}
const werkdag = (ymd) => { const w = new Date(ymd + 'T12:00:00Z').getUTCDay(); return w !== 0 && w !== 6 && !feestdag(ymd); };

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// Hash van één nota zoals David hem op de kaart vrijgaf (Fable #7: tekst en afzender horen erbij)
function notaHash(r, n) {
  return sha(JSON.stringify([Number(r.id), String(r.nummer), Number(r.nota_id), String(r.praktijk_id), Math.round(Number(n.bedrag) * 100), String(r.aan || ''), String(r.cc || ''),
    String(r.pdf_sha256), String(r.onderwerp), String(r.bericht), String(r.van || ''), String(r.plan_datum)]));
}
const batchHash = (hashes) => sha(Object.keys(hashes).map(Number).sort((a, b) => a - b).map((k) => k + ':' + hashes[k]).join('\n'));
// De tekst van de kaart zoals de databank hem opsloeg (mk_voor_jou_zet geeft de rij terug; de knoproute leest hem vers)
const kaartHash = (p) => sha(JSON.stringify([String(p && p.titel || ''), String(p && p.waarom || ''), (p && Array.isArray(p.stappen) ? p.stappen : []).map(String)]));
const euro = (x) => (Number(x) < 0 ? '-' : '') + '€ ' + new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(Number(x) || 0));
const dagTekst = (ymd) => dagNamen[new Date(ymd + 'T12:00:00Z').getUTCDay()] + ' ' + dm(ymd);
const bereik = (nrs) => { const s = [...nrs].sort(); return s.length === 1 ? s[0] : `${s[0]}–${s[s.length - 1]}`; };

// rijen: [{ nummer, praktijk, aan, bedrag }]
function kaartVrijgave(v, rijen, vandaag) {
  const n = rijen.length, ent = ENT_NAAM[v.entiteit] || v.entiteit, dag = dagTekst(v.plan_datum);
  const totaal = rijen.reduce((s, r) => s + Number(r.bedrag || 0), 0);
  const titel = `Zal ik ${n} ${ent}-nota${n > 1 ? "'s" : ''} (${bereik(rijen.map((r) => r.nummer))}) op ${dag} om 09:00 versturen?`;
  const voor = ymdPlus(v.plan_datum, -1);
  return { sleutel: `pot-vrijgave-${v.id}`, soort: 'besluit', volgorde: 20, waar: 'overal', prive: true, duur_min: 2, deadline: voor >= vandaag ? voor : v.plan_datum,
    titel: titel.length <= 90 ? titel : `Zal ik ${n} ${ent}-nota${n > 1 ? "'s" : ''} op ${dag} om 09:00 versturen?`,
    herkomst: { handmatig: 'pot-verzend', soort: 'vrijgave', vrijgave_id: v.id, entiteit: v.entiteit, plan_datum: v.plan_datum, ...potDoel(v.entiteit) },
    waarom: kap(`Je zette deze nota's in ${app()} klaar met "op die dag zelf versturen". Met Ja (vingerafdruk op je telefoon) geef je precies deze vrij: op ${dag} tussen 09:00 en 12:00 gaat per nota één mail van dokterschaap@gmail.com, met jouw tekst en de PDF die je maakte. Totaal ${euro(totaal)}. Nee of niets: die ochtend om 07:00 staan ze als concept klaar.`, 400),
    stappen: [...rijen.map((r) => `${r.nummer} · ${r.praktijk} · ${r.aan}${r.cc ? ` (cc ${r.cc})` : ''} · ${euro(r.bedrag)}`),
      'Een Ja vanaf een vaste plek (praktijk-pc) telt niet: dan worden het concepten.',
      'Verandert er nog iets aan een nota (adres, PDF, tekst, datum), dan gaat die nota als concept en niet vanzelf.',
      `Stoppen kan tot het verzendmoment: Annuleer bij de nota in ${appNotas()}.`].slice(0, 12) };
}
function kaartVandaag(v, rijen) {
  const n = rijen.length, ent = ENT_NAAM[v.entiteit] || v.entiteit;
  return kaartGrens({ sleutel: `pot-auto-vandaag-${v.id}`, soort: 'doen', volgorde: 19, waar: 'overal', prive: true, duur_min: 1, deadline: v.plan_datum,
    titel: `Vandaag om 09:00 gaan ${n} ${ent}-nota${n > 1 ? "'s" : ''} vanzelf de deur uit`,
    herkomst: { handmatig: 'pot-verzend', soort: 'vandaag', vrijgave_id: v.id, ...potDoel(v.entiteit) },
    waarom: `Je gaf ${n > 1 ? `de nota's ${bereik(rijen.map((r) => r.nummer))}` : `nota ${rijen[0].nummer}`} vrij met je vingerafdruk. Socev verstuurt ze tussen 09:00 en 12:00, één mail per nota. Stuur ze niet zelf, anders gaan ze twee keer.`,
    stappen: ['Niets doen: na het versturen staat er één bericht in de app en gaat deze kaart dicht.',
      OVIS ? "Toch stoppen: open OVIS POT › Nota's, tik op de nota en dan op Annuleer (kan tot hij verstuurd wordt)." : "Toch stoppen: open de POT-app, tab Nota's, en tik bij de nota op Annuleer (kan tot hij verstuurd wordt)."] });
}
// rijen: [{ nummer, reden, deadline }]
function kaartNietAuto(rijen, nuKort) {
  return kaartGrens({ sleutel: 'pot-verzend-nietauto-' + korteHash(rijen.map((r) => r.id).sort().join(',')), soort: 'doen', volgorde: 21, waar: 'overal', prive: true, duur_min: 3,
    deadline: rijen.map((r) => r.deadline).sort()[0],
    titel: `${appKop()} — ${rijen.length} nota${rijen.length > 1 ? "'s gaan" : ' gaat'} niet vanzelf de deur uit`,
    herkomst: { handmatig: 'pot-verzend', soort: 'nietauto', ids: rijen.map((r) => r.id), ...potDoel(rijen[0] && rijen[0].entiteit) },
    waarom: kap("Je koos bij deze nota's \"op die dag zelf versturen\", maar Socev verstuurt ze niet vanzelf: " + rijen.map((r) => `${r.nummer} (${r.reden})`).join('; ') + '. Ze komen op de verzenddag om 07:00 als concept in Gmail; versturen doe je dan zelf.', 400),
    stappen: ["Niets doen: op de verzenddag staat er per nota een concept in Gmail en een kaart om ze te versturen.",
      `Wil je het toch automatisch: los de reden op (bijvoorbeeld het factuuradres) en zet de nota in ${app()} opnieuw klaar met een reden.`,
      'Deze kaart gaat vanzelf dicht als de nota verstuurd of opnieuw klaargezet is.'],
    meting: `${nuKort}: ${rijen.length} nota${rijen.length > 1 ? "'s" : ''} niet automatisch.` });
}
function kaartOnzeker(rijen, nuKort) {
  return kaartGrens({ sleutel: 'pot-verzend-onzeker-' + korteHash(rijen.map((r) => r.id).sort().join(',')), soort: 'doen', volgorde: 18, waar: 'overal', prive: true, duur_min: 3,
    deadline: rijen.map((r) => r.deadline).sort()[0],
    titel: `${appKop()} — niet zeker of ${rijen.length > 1 ? `${rijen.length} nota's verstuurd zijn` : `nota ${rijen[0].nummer} verstuurd is`}`,
    herkomst: { handmatig: 'pot-verzend', soort: 'onzeker', ids: rijen.map((r) => r.id), ...potDoel(rijen[0] && rijen[0].entiteit) },
    waarom: kap(`Socev gaf ${rijen.map((r) => r.nummer).join(', ')} aan de verzendroute, maar kreeg geen bevestiging terug en vindt ${rijen.length > 1 ? 'ze' : 'hem'} na 24 uur niet in Gmail › Verzonden. Socev verstuurt ${rijen.length > 1 ? 'ze' : 'hem'} niet opnieuw.`, 400),
    stappen: ['Open Gmail en kijk in Verzonden (en Concepten) of de mail met dit nummer als bijlage er staat.',
      `Staat hij er niet: zet de nota in ${app()} opnieuw klaar met een reden (dan wordt het een concept) en verstuur hem zelf.`,
      'Staat hij er wel: niets doen; deze kaart kun je op gedaan zetten.'],
    meting: `${nuKort}: ${rijen.length} nota${rijen.length > 1 ? "'s" : ''} zonder bevestiging.` });
}

// Alle controles uit verse rijen (Fable #3/#7): nota nog definitief en dezelfde, PDF ongewijzigd en van deze nota, adres in de Second Brain
// == praktijk.email == het adres in de rij. Geeft { ok, reden, tijdelijk, aan, cc, bron, pdf } (tijdelijk: volgende tik opnieuw proberen).
async function autoControle(io, r, n, ontv) {
  if (!n || n.entiteit !== r.entiteit || n.nummer !== r.nummer || n.praktijk_id !== r.praktijk_id) return { ok: false, reden: `de nota is in ${app()} niet meer dezelfde` };
  if (n.status !== 'definitief') return { ok: false, reden: `de nota is nu ${n.status}` };
  // SLOEL, of de proefnota (entiteit PROEF bij een proefpraktijk P9x, alleen door de machinekamer in D1 gezet; adres = Davids testalias)
  if (r.entiteit !== 'SLOEL' && !(r.entiteit === 'PROEF' && /^P9\d$/.test(String(r.praktijk_id)))) return { ok: false, reden: 'alleen SLOEL-nota\'s gaan automatisch' };
  const pb = pdfBytes(r);
  if (!pb.ok) return { ok: false, reden: pb.fout };
  let tk;
  try { tk = await io.pdftotext(pb.bytes); } catch (e) { tk = null; }
  if (!tk || !tk.ok) return { ok: false, tijdelijk: true, reden: 'PDF nog niet te lezen' };
  const hb = pdfHoortBij(tk.tekst, n);
  if (!hb.ok) return { ok: false, reden: 'de PDF hoort niet bij deze nota (mist ' + hb.mist.join(', ') + ')' };
  if (!ontv || ontv.onleesbaar(r.praktijk_id)) return { ok: false, tijdelijk: true, reden: 'Second Brain niet te lezen' };
  const o1 = ontv.per[r.praktijk_id];
  if (!o1) return { ok: false, reden: 'geen factuuradres: ' + String(geenAdresTekst(ontv, r.praktijk_id, r.praktijk_id)).slice(0, 160) };
  const aanT = adresTekst(o1.aan), ccT = adresTekst(o1.cc);
  if (!n.email || adresNorm(n.email) !== aanT) return { ok: false, reden: `het factuuradres is nieuw of anders dan wat ${app()} kent (eerst bevestigen)` };
  return { ok: true, aan: aanT, cc: ccT || null, bron: o1.pagina, pdf: pb.bytes };
}

async function notasVan(io, rijen) {
  const ids = [...new Set(rijen.map((r) => r.nota_id))];
  if (!ids.length) return {};
  const notas = (await io.d1([{ sql: `select n.id, n.entiteit, n.nummer, n.praktijk_id, n.status, n.bedrag, n.datum, p.naam, p.naam_brief, p.email from nota n join praktijk p on p.id=n.praktijk_id where n.id in (${ids.map(() => '?').join(',')})`, params: ids }]))[0].results;
  return Object.fromEntries(notas.map((n) => [n.id, n]));
}
// Alleen verzonden-mails met dit bestand, zónder onderwerpfilter (Fable #8): heeft David hem zelf verstuurd, dan niet nog eens. 60 dagen terug
// (diffreview #6): ook een eerdere poging voor dezelfde nota die opnieuw werd klaargezet.
async function zoekVerzonden(io, r) {
  const j = await io.luik({ actie: 'mail_zoeken', query: `filename:${r.nummer} in:sent after:${gmailDatum(r.aangevraagd_op, 60)}`, max: 20 });
  const mails = Array.isArray(j) ? j : (j && Array.isArray(j.mails) ? j.mails : null);
  if (!mails) throw new Error('lees-luik zonder lijst');
  return mails.find((m) => labels(m).includes('SENT')) || null;
}

/*
 * Het automatische deel van de ronde. o.auto = schakelaar auto-aan (én verzendgeheim aanwezig). Zonder auto: geen kaarten maken en niets
 * versturen, wél terugvallen naar concept. io extra: verstuur(body) → { status, j }, verzenderOk() → true | false (hash Toetsen-code),
 * bericht(tekst) → promise. Alle tijd uit D1.
 */
async function autoRonde(io, nuD1, o, uit, zet) {
  const A = amsterdam(nuD1), vandaag = A.ymd;
  // o.proef = praktijk-id's (P9x) waarvoor automatisch geldt terwijl de schakelaar voor echte praktijken nog uit staat (proef wv921)
  const proef = (Array.isArray(o.proef) ? o.proef : []).filter((x) => /^P9\d$/.test(String(x)));
  const magAuto = (r) => !!o.auto || proef.includes(String(r.praktijk_id));
  const ietsAuto = !!o.auto || proef.length > 0;
  const nuKort = nuKortVan(nuD1);
  let gewijzigd = false;
  const terug = async (r, van, reden) => {   // naar de conceptroute (niet_voor blijft: 07:00 op de dag, of al voorbij → meteen)
    if (await zet(r.id, { status: 'wacht', geclaimd_op: null, opmerking: 'niet automatisch verstuurd: ' + String(reden).slice(0, 200) }, van)) { uit.auto_terug++; gewijzigd = true; return true; }
    return false;
  };

  // 0. verzenden > 10 min: de pod viel weg tussen reservering en antwoord → onzeker_verzonden (nooit terug, Fable #4)
  const h = await io.d1([{ sql: `update nota_verzending set status='onzeker_verzonden', opmerking='verzenden langer dan ${AUTO.verzendenMin} minuten (pod herstart of time-out)', bijgewerkt_op=${D1_NU} where status='verzenden' and verzend_reservering_op < strftime('%Y-%m-%dT%H:%M:%SZ','now','-${AUTO.verzendenMin} minutes')`, params: [] }]);
  if (h[0] && h[0].changes) { uit.onzeker_verzonden += h[0].changes; gewijzigd = true; }

  // 1. terugvallen: verzenddag voorbij of na 12:00; niet vrijgegeven om 07:00 op de dag; schakelaar uit op de dag vanaf 09:00
  const oud = (await io.d1([{ sql: `select ${KOL} from nota_verzending where status in ('auto_gevraagd','auto_vrij') and plan_datum <= ?`, params: [vandaag] }]))[0].results
    .filter((r) => r.plan_datum < vandaag || A.uur >= AUTO.totUur || (r.status === 'auto_gevraagd' && String(r.niet_voor) <= nuD1) || (!magAuto(r) && A.uur >= AUTO.vanUur));
  for (const r of oud) {
    const reden = r.status === 'auto_gevraagd' ? (r.vrijgave_id ? 'je gaf hem niet vrij in Voor jou' : 'hij kon niet worden klaargezet voor automatisch versturen')
      : (r.plan_datum < vandaag || A.uur >= AUTO.totUur) ? 'de verzendtijd (09:00–12:00) is voorbij zonder dat hij verstuurd werd' : 'automatisch versturen staat uit';
    await terug(r, r.status, reden);
  }

  // 2. vrijgave + besluitkaart maken (alleen met auto): rijen auto_gevraagd zonder vrijgave, verzenddag morgen..+45 dagen (vrijgeven kan tot
  //    de dag ervoor; diffreview #7)
  if (ietsAuto) {
    const nieuw = (await io.d1([{ sql: `select ${KOL} from nota_verzending where status='auto_gevraagd' and vrijgave_id is null and plan_datum > ? and plan_datum <= ? order by entiteit, plan_datum, nummer limit 40`, params: [vandaag, ymdPlus(vandaag, AUTO.vooraf)] }]))[0].results.filter(magAuto);
    if (nieuw.length) {
      const notaM = await notasVan(io, nieuw);
      const ontv = await adressen(io, o.adresbron, uit);   // wv1763
      const goed = [];
      for (const r of nieuw) {
        const n = notaM[r.nota_id];
        const c = await autoControle(io, r, n, ontv);
        if (c.ok) { goed.push(Object.assign({}, r, { aan: c.aan, cc: c.cc, bron_pagina: c.bron, _n: n })); continue; }
        if (c.tijdelijk) { if (/PDF/.test(c.reden)) uit.fouten.push('pdftotext'); continue; }   // Second Brain: al geteld in adressen()
        await terug(r, 'auto_gevraagd', c.reden);
      }
      // per entiteit en dag, in stukken van hooguit 9 (12 stappen op een kaart)
      const groep = {};
      for (const r of goed) (groep[r.entiteit + '|' + r.plan_datum] ||= []).push(r);
      for (const rr of Object.values(groep)) {
        for (let i = 0; i < rr.length; i += AUTO.perBatch) {
          const deel = rr.slice(i, i + AUTO.perBatch);
          const hashes = Object.fromEntries(deel.map((r) => [r.id, notaHash(r, r._n)]));
          const ins = await io.d1([{ sql: `insert into nota_vrijgave (entiteit, plan_datum, nota_ids, nota_hashes, batch_hash, vervalt_op, gemaakt_op) values (?,?,?,?,?,?,${D1_NU}) returning id`,
            params: [deel[0].entiteit, deel[0].plan_datum, JSON.stringify(deel.map((r) => r.id)), JSON.stringify(hashes), batchHash(hashes), deel[0].plan_datum] }]);
          const vid = ins[0].results[0].id;
          const stmts = [{ sql: 'update nota_vrijgave set kaart_sleutel=? where id=?', params: [`pot-vrijgave-${vid}`, vid] }];
          for (const r of deel) stmts.push({ sql: `update nota_verzending set vrijgave_id=?, aan=?, cc=?, bron_pagina=?, bijgewerkt_op=${D1_NU} where id=? and status='auto_gevraagd' and vrijgave_id is null and pdf_sha256=?`, params: [vid, r.aan, r.cc, r.bron_pagina, r.id, r.pdf_sha256] });
          const res = await io.d1(stmts);
          // een rij die intussen veranderde (geannuleerd, opnieuw): de vrijgave geldt dan niet voor alles wat erin staat → intrekken; volgende tik opnieuw
          if (res.slice(1).some((x) => x.changes !== 1)) {
            await io.d1([{ sql: `update nota_vrijgave set ingetrokken_op=${D1_NU} where id=?`, params: [vid] },
              { sql: `update nota_verzending set vrijgave_id=null where vrijgave_id=? and status='auto_gevraagd'`, params: [vid] }]);
            continue;
          }
          uit.vrijgave_kaart++; gewijzigd = true;
        }
      }
    }
  }

  // 2b. een open vrijgave (nog geen Ja) die een nota verloor (geannuleerd, opnieuw klaargezet): intrekken; de rest krijgt volgende tik een
  //     nieuwe kaart, zodat David nooit Ja zegt op een kaart met nota's die niet meer meegaan (diffreview #3)
  const kwijt = (await io.d1([{ sql: `select v.id from nota_vrijgave v where v.vraag_id is null and v.ingetrokken_op is null and (select count(*) from nota_verzending r where r.vrijgave_id=v.id and r.status='auto_gevraagd') <> json_array_length(v.nota_ids)`, params: [] }]))[0].results;
  for (const v of kwijt) { await io.d1(intrekSql(v.id)); gewijzigd = true; }

  // 3. kaart bij elke vrijgave zonder kaart_tekst_hash (net gemaakt, of de vorige tik faalde de kaart)
  const zonder = (await io.d1([{ sql: `select id, entiteit, plan_datum, nota_ids from nota_vrijgave where kaart_tekst_hash is null and ingetrokken_op is null and vraag_id is null and plan_datum > ? order by id limit 10`, params: [vandaag] }]))[0].results;
  for (const v of zonder) {
    const rijen = (await io.d1([{ sql: `select v.id, v.nummer, v.aan, v.cc, n.bedrag, coalesce(p.naam_brief, p.naam, v.praktijk_id) as praktijk from nota_verzending v join nota n on n.id=v.nota_id left join praktijk p on p.id=v.praktijk_id where v.vrijgave_id=? and v.status='auto_gevraagd' order by v.nummer`, params: [v.id] }]))[0].results;
    if (!rijen.length || rijen.length !== JSON.parse(v.nota_ids).length) { await io.d1([{ sql: `update nota_vrijgave set ingetrokken_op=${D1_NU} where id=? and vraag_id is null`, params: [v.id] }, { sql: `update nota_verzending set vrijgave_id=null where vrijgave_id=? and status='auto_gevraagd'`, params: [v.id] }]); continue; }
    try {
      const p = await io.kaartZet(kaartVrijgave(v, rijen, vandaag));
      if (!p || p.sleutel !== `pot-vrijgave-${v.id}`) throw new Error('kaart niet teruggegeven');
      await io.d1([{ sql: 'update nota_vrijgave set kaart_tekst_hash=? where id=? and kaart_tekst_hash is null', params: [kaartHash(p), v.id] }]);
    } catch (e) { uit.fouten.push('kaarten'); }
  }

  // 4. herinnering op de dag (07:00–12:00): "stuur ze niet zelf; stoppen kan tot 09:00" (Fable #8)
  if (ietsAuto && A.uur >= 7 && A.uur < AUTO.totUur) {
    const vv = (await io.d1([{ sql: `select id, entiteit, plan_datum from nota_vrijgave where plan_datum=? and vraag_id is not null and ingetrokken_op is null and herinnerd_op is null`, params: [vandaag] }]))[0].results;
    for (const v of vv) {
      const rijen = (await io.d1([{ sql: "select id, nummer, praktijk_id from nota_verzending where vrijgave_id=? and status='auto_vrij' order by nummer", params: [v.id] }]))[0].results.filter(magAuto);
      if (!rijen.length) continue;
      try { await io.kaartZet(kaartVandaag(v, rijen)); await io.d1([{ sql: `update nota_vrijgave set herinnerd_op=${D1_NU} where id=?`, params: [v.id] }]); } catch (e) { uit.fouten.push('kaarten'); }
    }
  }

  // 5. versturen: alleen met auto, op een werkdag, 09:00–12:00 Amsterdam, rijen auto_vrij van vandaag
  // geen nieuwe verzending na 11:55: de verzender weigert vanaf 12:00 (natoets Fable #3); wat overblijft wordt om 12:00 concept
  if (ietsAuto && werkdag(vandaag) && A.uur >= AUTO.vanUur && A.uur < AUTO.totUur && !(A.uur === AUTO.totUur - 1 && A.min >= 55)) {
    const kand = (await io.d1([{ sql: `select ${KOL} from nota_verzending where status='auto_vrij' and plan_datum=? order by id limit ${AUTO.perDag}`, params: [vandaag] }]))[0].results.filter(magAuto);
    if (kand.length) {
      let verzOk = null;
      try { verzOk = await io.verzenderOk(); } catch (e) { verzOk = null; }
      if (verzOk === null) uit.fouten.push('verzender');   // n8n-API niet te lezen: volgende tik opnieuw (tot 12:00)
      else if (verzOk === false) {
        // de witte-lijstcode van de verzender is niet die van het image (Fable #10): niets versturen, alles naar concept
        uit.fouten.push('toetsen');
        for (const r of kand) await terug(r, 'auto_vrij', 'de verzendroute is gewijzigd sinds de laatste controle');
      } else {
        const notaM = await notasVan(io, kand);
        const vids = [...new Set(kand.map((r) => r.vrijgave_id).filter(Boolean))];
        const vrij = vids.length ? Object.fromEntries((await io.d1([{ sql: `select * from nota_vrijgave where id in (${vids.map(() => '?').join(',')})`, params: vids }]))[0].results.map((v) => [v.id, v])) : {};
        const ontv = await adressen(io, o.adresbron, uit);   // wv1763
        for (const r of kand) {
          const dag = (await io.d1([{ sql: "select count(*) as n from nota_verzending where plan_datum=? and status in ('verzenden','auto_verstuurd','onzeker_verzonden')", params: [vandaag] }]))[0].results[0];
          if (Number(dag.n) >= AUTO.perDag) { uit.fouten.push('autoplafond'); break; }
          const n = notaM[r.nota_id], v = vrij[r.vrijgave_id];
          // vrijgave: door de knoproute vastgelegd, juiste bevestiging, niet ingetrokken, voor deze dag, hashes kloppen met de verse rij
          let hashes = null;
          try { hashes = v ? JSON.parse(v.nota_hashes) : null; } catch (e) { hashes = null; }
          let ids = [];
          try { ids = v ? JSON.parse(v.nota_ids) : []; } catch (e) { ids = []; }
          const vReden = !v ? 'de vrijgave ontbreekt' : !v.vraag_id || v.bevestiging !== AUTO_BEVESTIGING ? 'de vrijgave is niet met een verse vingerafdruk op je telefoon bevestigd'
            : v.ingetrokken_op ? 'de vrijgave is ingetrokken' : v.plan_datum !== r.plan_datum || v.vervalt_op !== vandaag ? 'de vrijgave geldt niet voor vandaag'
            : !v.kaart_tekst_hash || !hashes || batchHash(hashes) !== v.batch_hash || !ids.includes(Number(r.id)) ? 'de vrijgave klopt niet meer'
            : !n || hashes[r.id] !== notaHash(r, n) ? 'de nota is veranderd sinds je hem vrijgaf' : null;
          if (vReden) { await terug(r, 'auto_vrij', vReden); continue; }
          const c = await autoControle(io, r, n, ontv);
          if (!c.ok && c.tijdelijk) { if (/PDF/.test(c.reden)) uit.fouten.push('pdftotext'); continue; }
          if (!c.ok) { await terug(r, 'auto_vrij', c.reden); continue; }
          if (c.aan !== r.aan || (c.cc || '') !== (r.cc || '')) { await terug(r, 'auto_vrij', 'het factuuradres is veranderd sinds je hem vrijgaf'); continue; }
          // reservering, gecommit vóór de aanroep: twee pods (rolwissel) krijgen er hooguit één
          const res = await io.d1([{ sql: `update nota_verzending set status='verzenden', verzend_reservering_op=${D1_NU}, bijgewerkt_op=${D1_NU} where id=? and status='auto_vrij'`, params: [r.id] }]);
          if (!res[0] || res[0].changes !== 1) continue;
          gewijzigd = true;
          // voorcontrole: staat hij al in Verzonden (David verstuurde zelf)? Lees-luik stuk → terug naar auto_vrij (er is nog niets verstuurd)
          let al;
          try { al = await zoekVerzonden(io, r); } catch (e) { await zet(r.id, { status: 'auto_vrij', verzend_reservering_op: null }, 'verzenden'); uit.fouten.push('luik'); break; }
          if (al) { await zet(r.id, { status: 'verstuurd_door_david', verzonden_op: al.datum || nuD1, thread_id: al.thread_id || null, pdf_b64: null, opmerking: 'stond al in Verzonden; niet nog eens verstuurd' }, 'verzenden'); uit.verstuurd_door_david++; continue; }
          let a;
          try { a = await io.verstuur({ bron: 'pot', modus: 'versturen', ref: 'POT' + r.id, aan: r.aan, cc: r.cc || '', onderwerp: String(r.onderwerp).slice(0, 150), bericht: String(r.bericht).slice(0, 3000), van: r.van || '', bijlage: { naam: r.pdf_naam, bytes: c.pdf } }); }
          catch (e) { a = e && e.zekerNietVerstuurd ? { status: -1, j: { ok: false, code: e.code || 'vooraf' } } : { status: 0, j: null }; }
          const j = a && a.j;
          if (a && a.status === 200 && j && j.ok === true && typeof j.message_id === 'string' && j.message_id) {
            await zet(r.id, { status: 'auto_verstuurd', message_id: j.message_id.slice(0, 80), thread_id: typeof j.thread_id === 'string' ? j.thread_id.slice(0, 40) : null, verzonden_op: nuD1, pdf_b64: null, fout: null, opmerking: null }, 'verzenden');
            uit.auto_verstuurd++; continue;
          }
          // zeker niet verstuurd: vóór de aanroep (-1), de verzender weigerde (4xx met ok:false) of Gmail weigerde het concept (er is niets gemaakt)
          const zeker = a && j && j.ok === false && (a.status === -1 || (a.status >= 400 && a.status < 500) || (a.status === 502 && j.code === 'gmail_concept'));
          if (zeker) {
            if (await zet(r.id, { status: 'wacht', verzend_reservering_op: null, opmerking: 'niet automatisch verstuurd: de verzendroute weigerde (' + String(j.code || a.status).slice(0, 40) + ')' }, 'verzenden')) uit.auto_terug++;
            continue;
          }
          await zet(r.id, { status: 'onzeker_verzonden', opmerking: 'geen bevestiging van de verzendroute (' + (a && a.status ? 'http ' + a.status + (j && j.code ? ' ' + String(j.code).slice(0, 30) : '') : 'geen antwoord') + ')' }, 'verzenden');
          uit.onzeker_verzonden++;
        }
      }
    }
  }

  // 6. onzeker_verzonden: elk uur alleen-lezend terugzoeken in Verzonden; na 24 uur niet gevonden → fout gezet (kaart); nooit opnieuw versturen
  if (o.meten) {
    const onz = (await io.d1([{ sql: `select ${KOL} from nota_verzending where status='onzeker_verzonden' and fout is null order by id limit 10`, params: [] }]))[0].results;
    for (const r of onz) {
      let g;
      try { g = await zoekVerzonden(io, r); } catch (e) { uit.fouten.push('luik'); break; }
      if (g) { if (await zet(r.id, { status: 'auto_verstuurd', message_id: g.id || null, thread_id: g.thread_id || null, verzonden_op: g.datum || nuD1, pdf_b64: null, opmerking: 'teruggevonden in Verzonden' }, 'onzeker_verzonden')) { uit.auto_verstuurd++; gewijzigd = true; } continue; }
      if (Date.parse(r.verzend_reservering_op || r.aangevraagd_op) < Date.parse(nuD1) - AUTO.onzekerUur * 3600e3) {
        if (await zet(r.id, { fout: 'niet teruggevonden in Verzonden', pdf_b64: null }, 'onzeker_verzonden')) gewijzigd = true;
      }
    }
  }

  // 7. na afloop van een batch: één bericht van de pod in het hoofdkanaal (geen taalmodel, Fable #11); eerst gemeld_op (hooguit één keer)
  const af = (await io.d1([{ sql: `select v.id, v.entiteit from nota_vrijgave v where v.vraag_id is not null and v.gemeld_op is null and v.plan_datum <= ? and not exists (select 1 from nota_verzending r where r.vrijgave_id=v.id and r.status in ('auto_vrij','verzenden'))`, params: [vandaag] }]))[0].results;
  let stand = null;
  for (const v of af) {
    const rr = (await io.d1([{ sql: 'select nummer, status from nota_verzending where vrijgave_id=? order by nummer', params: [v.id] }]))[0].results;
    const weg = rr.filter((r) => r.status === 'auto_verstuurd').map((r) => r.nummer), zelf = rr.filter((r) => r.status === 'verstuurd_door_david').map((r) => r.nummer), onz = rr.filter((r) => r.status === 'onzeker_verzonden').map((r) => r.nummer);
    const g = await io.d1([{ sql: `update nota_vrijgave set gemeld_op=${D1_NU} where id=? and gemeld_op is null`, params: [v.id] }]);
    if (!g[0] || g[0].changes !== 1) continue;
    const terugN = rr.filter((r) => ['wacht', 'bezig', 'concept', 'verzonden', 'wacht_op_adres', 'onzeker', 'fout', 'concept_weg'].includes(r.status)).map((r) => r.nummer);
    try {
      if (!stand) stand = Object.fromEntries(((await io.kaartLijst()) || []).map((p) => [p.sleutel, p.status]));
      const s = `pot-auto-vandaag-${v.id}`;
      if (stand[s] === 'open' || stand[s] === 'later') await io.kaartDicht(s, stand[s], `${nuKort}: ${weg.length} verstuurd${onz.length ? `, ${onz.length} onzeker` : ''}${terugN.length ? `, ${terugN.length} als concept` : ''}.`);
    } catch (e) { uit.fouten.push('kaarten'); }
    if (!weg.length && !onz.length && !zelf.length) continue;
    const ent = ENT_NAAM[v.entiteit] || v.entiteit;
    const tekst = (weg.length ? `${weg.length} ${ent}-nota${weg.length > 1 ? "'s" : ''} verstuurd: ${weg.length > 2 ? bereik(weg) : weg.join(' en ')} (één mail per nota, van dokterschaap@gmail.com).` : `Geen ${ent}-nota's automatisch verstuurd.`) +
      (zelf.length ? ` Stond al in Gmail › Verzonden, dus niet nog eens verstuurd: ${zelf.join(', ')} (kijk daar even aan wie).` : '') +
      (onz.length ? ` Niet zeker of ${onz.join(', ')} verstuurd ${onz.length > 1 ? 'zijn' : 'is'}; ik zoek in Verzonden en verstuur niets opnieuw.` : '') +
      (terugN.length ? ` Niet automatisch, komt als concept in Gmail: ${terugN.join(', ')}.` : '');
    try { await io.bericht(tekst); uit.gemeld++; } catch (e) { uit.fouten.push('bericht'); }
  }
  return gewijzigd;
}

// ── aanvraagkant (wv1933, OVIS POT P4): de SQL op nota_verzending voor klaarzetten, annuleren en adres bevestigen ───────────
// Tot de overstap (bouwplan OVIS POT § 3.4) schreef de Function van werk.socev.dev/pot deze rijen; nu de pod (pot-app.js), met precies
// dezelfde SQL. Deze module blijft eigenaar van de tabel: elke opdracht op nota_verzending staat hier. Tijd `t` komt uit D1 (pot-app.js).
const VZ_ACTIEF = ['wacht', 'bezig', 'concept', 'verzonden', 'wacht_op_adres', 'onzeker', 'auto_gevraagd', 'auto_vrij', 'verzenden', 'auto_verstuurd', 'onzeker_verzonden', 'verstuurd_door_david'];
const VZ_OPNIEUW_VAN = ['wacht', 'concept', 'verzonden', 'wacht_op_adres', 'onzeker', 'auto_gevraagd', 'auto_vrij', 'auto_verstuurd', 'onzeker_verzonden', 'verstuurd_door_david'];
const VZ_ANNULEER_VAN = ['wacht', 'wacht_op_adres', 'auto_gevraagd', 'auto_vrij'];   // wv921: tot de pod hem reserveert (verzenden)
// Kolommen voor de lijst en de antwoorden (zonder PDF en mailtekst)
const VZ_KOLOMMEN = 'id, nota_id, entiteit, nummer, praktijk_id, status, niet_voor, plan_datum, onderwerp, van, pdf_naam, pdf_sha256, pdf_bytes, aangevraagd_op, reden, geclaimd_op, pogingen, aan, cc, bron_pagina, concept_id, thread_id, concept_op, verzonden_op, opmerking, fout, bijgewerkt_op, auto, vrijgave_id, message_id';
const aanvraagRijSql = (id) => ({ sql: `select ${VZ_KOLOMMEN} from nota_verzending where id=?`, params: [id] });
const aanvraagActiefSql = (notaId) => ({ sql: `select ${VZ_KOLOMMEN} from nota_verzending where nota_id=? and status in (${VZ_ACTIEF.map(() => '?').join(',')})`, params: [notaId, ...VZ_ACTIEF] });
const aanvraagNieuwSql = (notaId) => ({ sql: `select ${VZ_KOLOMMEN} from nota_verzending where nota_id=? and status in ('wacht','auto_gevraagd') order by id desc limit 1`, params: [notaId] });
// a = { actief (rij of null), reden, n (nota), k ({ onderwerp, bericht, van, pdf_naam }), nietVoor, plan, auto, pdf_b64, sha, bytes, t } → batch
function aanvraagSql(a) {
  const stmts = [];
  if (a.actief) stmts.push({ sql: "update nota_verzending set status='vervangen', pdf_b64=null, reden=?, bijgewerkt_op=? where id=? and status=?", params: [`vervangen: ${a.reden}`, a.t, a.actief.id, a.actief.status] });
  stmts.push({ sql: 'insert into nota_verzending (nota_id, entiteit, nummer, praktijk_id, status, niet_voor, plan_datum, onderwerp, bericht, van, pdf_naam, pdf_b64, pdf_sha256, pdf_bytes, aangevraagd_op, reden, bijgewerkt_op, auto) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    params: [a.n.id, a.n.entiteit, a.n.nummer, a.n.praktijk_id, a.auto ? 'auto_gevraagd' : 'wacht', a.nietVoor, a.plan, a.k.onderwerp, a.k.bericht, a.k.van, a.k.pdf_naam, a.pdf_b64, a.sha, a.bytes, a.t, a.reden ? `opnieuw: ${a.reden}` : null, a.t, a.auto ? 1 : 0] });
  return stmts;
}
function annuleerSql(id, t) {
  return { sql: `update nota_verzending set status='geannuleerd', pdf_b64=null, bijgewerkt_op=? where id=? and status in (${VZ_ANNULEER_VAN.map(() => '?').join(',')})`, params: [t, id, ...VZ_ANNULEER_VAN] };
}
// Het adres komt uit de Second Brain (de pod zette het in `aan`); David bevestigt het in de App. Dan wordt het ook praktijk.email.
// Het tweede element telt: changes 1 = bevestigd.
function adresSql(r, t) {
  return [{ sql: 'update praktijk set email=? where id=?', params: [r.aan, r.praktijk_id] },
    { sql: "update nota_verzending set status='wacht', niet_voor=case when niet_voor > ? then niet_voor else ? end, opmerking=?, bijgewerkt_op=? where id=? and status='wacht_op_adres' and aan=?",
      params: [t, t, `adres bevestigd in de app op ${t}`, t, r.id, r.aan] }];
}

// ── knoproute (server.js appVoorJouKnop/appKnop): toetsen, vastleggen, intrekken ──────────────────────────────
// p = de verse kaartrij uit Supabase, v = de nota_vrijgave-rij met kaart_sleutel = p.sleutel, vandaag = Amsterdam (uit D1).
// Geeft null (mag vrijgeven) of een reden in gewone taal. Het anker is de D1-rij; de kaart is het bewijs dat David precies dát zag (Fable #2).
function vrijgaveToets(p, v, vandaag, aantal) {
  if (!p || !/^pot-vrijgave-\d{1,9}$/.test(String(p.sleutel || ''))) return 'geen vrijgavekaart';
  if (!v || `pot-vrijgave-${v.id}` !== p.sleutel) return 'de vrijgave hoort niet bij deze kaart';
  if (!v.kaart_tekst_hash || kaartHash(p) !== v.kaart_tekst_hash) return 'de kaart is niet meer de kaart die Socev maakte';
  if (v.ingetrokken_op) return 'de vrijgave is ingetrokken';
  if (v.vraag_id) return 'deze nota\'s zijn al vrijgegeven';
  let ids = [];
  try { ids = JSON.parse(v.nota_ids); } catch (e) { ids = []; }
  if (aantal !== ids.length) return 'er is intussen een nota van deze kaart geannuleerd of opnieuw klaargezet; er komt een nieuwe kaart';
  if (!(v.plan_datum > vandaag)) return 'de verzenddag is vandaag of voorbij (vrijgeven kan tot de dag ervoor)';
  if (v.plan_datum > ymdPlus(vandaag, AUTO.vooraf)) return 'de verzenddag ligt meer dan 45 dagen vooruit';
  return null;
}
// Vastleggen pas ná een geslaagde appStartBeurt, alleen bij een Ja met verse vingerafdruk van telefoon of meereizend apparaat (Fable #3).
// Eén D1-batch (transactie): de vrijgave alleen als hij nog leeg en niet ingetrokken is, de rijen alleen als dát gelukt is.
function vrijgaveSql(vid, kaartTekstHash, vraagId, bevestiging) {
  return [
    { sql: `update nota_vrijgave set vraag_id=?, bevestiging=?, bevestigd_op=${D1_NU} where id=? and kaart_tekst_hash=? and vraag_id is null and ingetrokken_op is null and plan_datum > strftime('%Y-%m-%d','now')`,
      params: [String(vraagId), String(bevestiging), Number(vid), String(kaartTekstHash)] },
    { sql: `update nota_verzending set status='auto_vrij', bijgewerkt_op=${D1_NU} where vrijgave_id=? and status='auto_gevraagd' and exists (select 1 from nota_vrijgave w where w.id=? and w.vraag_id=? and w.bevestiging=? and w.ingetrokken_op is null)`,
      params: [Number(vid), Number(vid), String(vraagId), String(bevestiging)] },
  ];
}
// Intrekken (de knopbeurt verviel vóór hij startte): vrijgave weg, de rijen terug naar auto_gevraagd zonder vrijgave (volgende tik een nieuwe kaart)
function intrekSql(vid) {
  return [
    { sql: `update nota_vrijgave set ingetrokken_op=${D1_NU} where id=? and ingetrokken_op is null`, params: [Number(vid)] },
    { sql: `update nota_verzending set status='auto_gevraagd', vrijgave_id=null, bijgewerkt_op=${D1_NU} where vrijgave_id=? and status in ('auto_gevraagd','auto_vrij')`, params: [Number(vid)] },
  ];
}

// ── de ronde ─────────────────────────────────────────────────────────────────
/*
 * io = { d1(batch:[{sql,params}]) → [{results, changes}], luik(body) → json, concept(body) → { status, j }, pdftotext(bytes) → { ok, tekst },
 *        vault() → [{ pad, tekst }], kaartZet(p), kaartLijst() → [{ sleutel, status }], kaartDicht(sleutel, van, bewijs), register(regel) }
 *        registerAdressen() → { per, problemen } (wv1763: ovis-register.js potFactuur over stampagina's + register; alleen nodig bij een andere adresbron dan dossier)
 * o = { meten: bool (verzonden meten), kaarten: bool (kaarten bijwerken, ook zonder wijziging), adresbron: dossier | proef | kaarten | register (wv1763) }
 * → { geclaimd, concept, wacht_op_adres, fout, onzeker, verzonden, opnieuw, fouten: [..] }
 */
async function ronde(io, o) {
  o = o || {};
  const uit = { geclaimd: 0, concept: 0, wacht_op_adres: 0, fout: 0, onzeker: 0, verzonden: 0, opnieuw: 0, fouten: [],
    auto_terug: 0, vrijgave_kaart: 0, auto_verstuurd: 0, verstuurd_door_david: 0, onzeker_verzonden: 0, gemeld: 0 };
  const nuD1 = (await io.d1([{ sql: `select ${D1_NU} as nu`, params: [] }]))[0].results[0].nu;
  const nuMs = Date.parse(nuD1);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(String(nuD1)) || isNaN(nuMs)) throw new Error('D1 gaf geen tijd');
  const iso = () => nuD1;
  const zet = async (id, velden, vanStatus) => {
    const k = Object.keys(velden);
    const r = await io.d1([{ sql: `update nota_verzending set ${k.map((x) => x + '=?').join(', ')}, bijgewerkt_op=${D1_NU} where id=? and status=?`, params: [...k.map((x) => velden[x]), id, vanStatus] }]);
    return r[0] && r[0].changes === 1;
  };
  let gewijzigd = false;

  // 1. bezig > 10 min: de pod viel weg tussen claim en afronding; er kan een concept zijn → onzeker
  const h = await io.d1([{ sql: `update nota_verzending set status='onzeker', opmerking='bezig langer dan 10 minuten (pod herstart of time-out)', bijgewerkt_op=${D1_NU} where status='bezig' and geclaimd_op < strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 minutes')`, params: [] }]);
  if (h[0] && h[0].changes) { uit.onzeker += h[0].changes; gewijzigd = true; }

  // 1b. automatisch versturen (wv921): terugvallen, vrijgavekaarten, versturen in het venster, onzeker nazoeken, slotbericht.
  // Vóór de claim, zodat een rij die terugvalt in dezelfde tik als concept wordt opgepakt als zijn niet_voor al voorbij is.
  if (await autoRonde(io, nuD1, o, uit, zet)) gewijzigd = true;

  // 2. onzeker zelf oplossen: staat het concept (of de verzonden mail) in Gmail?
  const onz = (await io.d1([{ sql: `select ${KOL} from nota_verzending where status='onzeker' order by id limit ${GRENS.onzekerPerTik}`, params: [] }]))[0].results;
  for (const r of onz) {
    let g;
    try { g = await zoekInGmail(io, r, r.aangevraagd_op); } catch (e) { uit.fouten.push('luik'); break; }
    if (g.verzonden) { if (await zet(r.id, { status: 'verzonden', verzonden_op: g.verzonden.datum || iso(), thread_id: g.verzonden.thread_id || r.thread_id, pdf_b64: null, opmerking: 'teruggevonden als verzonden' }, 'onzeker')) { uit.verzonden++; gewijzigd = true; } continue; }
    if (g.concept) { if (await zet(r.id, { status: 'concept', bericht_id: g.concept.id || null, thread_id: g.concept.thread_id || null, concept_op: r.concept_op || iso(), pdf_b64: null, opmerking: 'concept teruggevonden in Gmail' }, 'onzeker')) { uit.concept++; gewijzigd = true; } continue; }
    // niet gevonden: na een uur (Gmail-index ruim bij) opnieuw in de wachtrij, na drie keer fout
    const oud = Date.parse(r.geclaimd_op || r.aangevraagd_op) < nuMs - 3600e3;
    if (!oud) continue;
    if (Number(r.pogingen) + 1 >= GRENS.pogingenMax) { if (await zet(r.id, { status: 'fout', fout: 'drie keer geen bevestiging van Gmail', pdf_b64: null }, 'onzeker')) { uit.fout++; gewijzigd = true; } }
    else if (await zet(r.id, { status: 'wacht', geclaimd_op: null, pogingen: Number(r.pogingen) + 1, opmerking: 'niet in Gmail gevonden; opnieuw in de wachtrij' }, 'onzeker')) { uit.opnieuw++; gewijzigd = true; }
  }

  // 3. dagplafond (op concept_op in D1)
  const dag = (await io.d1([{ sql: "select count(*) as n from nota_verzending where concept_op >= strftime('%Y-%m-%dT00:00:00Z','now')", params: [] }]))[0].results[0];
  const ruimte = Math.min(GRENS.perTik, GRENS.perDag - Number(dag && dag.n || 0));
  if (ruimte <= 0) uit.fouten.push('dagplafond');

  // 4. claimen: wacht en aan de beurt; wacht_op_adres elke 10 minuten opnieuw
  let rijen = [];
  if (ruimte > 0) {
    rijen = (await io.d1([{ sql: `update nota_verzending set status='bezig', geclaimd_op=${D1_NU}, bijgewerkt_op=${D1_NU} where id in (select id from nota_verzending where niet_voor <= ${D1_NU} and (status='wacht' or (status='wacht_op_adres' and bijgewerkt_op < strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 minutes'))) order by id limit ${ruimte}) and status in ('wacht','wacht_op_adres') returning ${KOL}`, params: [] }]))[0].results;
  }
  uit.geclaimd = rijen.length;
  if (rijen.length) {
    const ids = [...new Set(rijen.map((r) => r.nota_id))];
    const notas = (await io.d1([{ sql: `select n.id, n.entiteit, n.nummer, n.praktijk_id, n.status, n.bedrag, n.datum, p.naam, p.naam_brief, p.email from nota n join praktijk p on p.id=n.praktijk_id where n.id in (${ids.map(() => '?').join(',')})`, params: ids }]))[0].results;
    const notaM = Object.fromEntries(notas.map((n) => [n.id, n]));
    const ontv = await adressen(io, o.adresbron, uit);   // wv1763: dossierpagina of register, per praktijk volgens de schakelaar
    for (const r of rijen) {
      const n = notaM[r.nota_id];
      // terug in de wachtrij (alleen na de adrescontrole gebruikt, dus het adres klopte op dat moment)
      const terug = async () => { await zet(r.id, { status: 'wacht', geclaimd_op: null }, 'bezig'); };
      if (!n || n.entiteit !== r.entiteit || n.nummer !== r.nummer || n.praktijk_id !== r.praktijk_id) { await zet(r.id, { status: 'fout', fout: `de nota is in ${app()} niet (meer) dezelfde`, pdf_b64: null }, 'bezig'); uit.fout++; gewijzigd = true; continue; }
      if (n.status !== 'definitief') { await zet(r.id, { status: 'fout', fout: `de nota is nu ${n.status}`, pdf_b64: null }, 'bezig'); uit.fout++; gewijzigd = true; continue; }
      const pb = pdfBytes(r);
      if (!pb.ok) { await zet(r.id, { status: 'fout', fout: pb.fout, pdf_b64: null }, 'bezig'); uit.fout++; gewijzigd = true; continue; }
      let tk;
      try { tk = await io.pdftotext(pb.bytes); } catch (e) { tk = { ok: false }; }
      if (!tk || !tk.ok) { await zet(r.id, { status: 'wacht', geclaimd_op: null, opmerking: 'PDF nog niet te lezen; volgende minuut opnieuw' }, 'bezig'); uit.fouten.push('pdftotext'); continue; }
      const hb = pdfHoortBij(tk.tekst, n);
      if (!hb.ok) { await zet(r.id, { status: 'fout', fout: 'de PDF hoort niet bij deze nota (mist ' + hb.mist.join(', ') + ')', pdf_b64: null }, 'bezig'); uit.fout++; gewijzigd = true; continue; }
      // bron niet te lezen: volgende minuut opnieuw, nooit terugvallen op een andere bron (wv1763)
      if (ontv.onleesbaar(r.praktijk_id)) { await zet(r.id, { status: 'wacht', geclaimd_op: null }, 'bezig'); continue; }
      const o1 = ontv.per[r.praktijk_id];
      const praktijk = n.naam_brief || n.naam || r.praktijk_id;
      const wachtAdres = async (opm, reden, aan) => {
        const al = r.opmerking === opm && (r.aan || null) === (aan || null);
        await zet(r.id, { status: 'wacht_op_adres', opmerking: opm, fout: reden, aan: aan || null, geclaimd_op: null }, 'bezig');
        uit.wacht_op_adres++; if (!al) gewijzigd = true;
      };
      if (!o1) { await wachtAdres('geen_adres', geenAdresTekst(ontv, r.praktijk_id, praktijk), null); continue; }
      const aanT = adresTekst(o1.aan);
      if (!n.email) { await wachtAdres('adres_nieuw', `nieuw factuuradres voor ${praktijk}: ${aanT}`, aanT); continue; }
      if (adresNorm(n.email) !== aanT) { await wachtAdres('adres_gewijzigd', `het factuuradres van ${praktijk} in de Second Brain (${aanT}) verschilt van wat ${app()} kent (${adresNorm(n.email)})`, aanT); continue; }
      // adres vastleggen vóór de aanroep (bij een crash weet de herstelstap waarnaar te zoeken)
      if (!(await zet(r.id, { aan: aanT, cc: adresTekst(o1.cc) || null, bron_pagina: o1.pagina }, 'bezig'))) continue;
      const rij = Object.assign({}, r, { aan: aanT });
      // voorcontrole: staat er al een concept of een verzonden mail van deze nota?
      let g;
      try { g = await zoekInGmail(io, rij, r.aangevraagd_op); } catch (e) { await terug(); uit.fouten.push('luik'); continue; }
      // opnieuw klaarzetten (met reden): een verzonden mail is geen beletsel; een oud concept wel, want dat zou blijven staan naast het
      // nieuwe (of het nieuwe tegenhouden). David gooit het oude eerst weg (Fable diffreview #2).
      const opnieuw = /^opnieuw:/.test(r.reden || '');
      if (opnieuw && g.concept) { await zet(r.id, { status: 'fout', fout: 'er staat nog een ouder concept van deze nota in Gmail; gooi dat eerst weg en zet de nota daarna opnieuw klaar', pdf_b64: null }, 'bezig'); uit.fout++; gewijzigd = true; continue; }
      if (!opnieuw && (g.verzonden || g.concept)) {
        const m = g.verzonden || g.concept;
        await zet(r.id, { status: g.verzonden ? 'verzonden' : 'concept', bericht_id: m.id || null, thread_id: m.thread_id || null, concept_op: iso(), verzonden_op: g.verzonden ? (m.datum || iso()) : null, pdf_b64: null, opmerking: 'stond al in Gmail; geen tweede concept' }, 'bezig');
        uit[g.verzonden ? 'verzonden' : 'concept']++; gewijzigd = true; continue;
      }
      let a;
      try { a = await io.concept(mailBody(r, o1)); } catch (e) { a = { status: 0, j: null }; }
      const j = a && a.j;
      if (a && a.status === 200 && j && j.ok === true && typeof j.concept_id === 'string') {
        if (Number(j.bijlagen) !== 1) { await zet(r.id, { status: 'fout', concept_id: j.concept_id.slice(0, 80), fout: `er staat een concept zonder PDF in Gmail (onderwerp ${r.onderwerp}); gooi dat weg en zet de nota opnieuw klaar`, pdf_b64: null }, 'bezig'); uit.fout++; gewijzigd = true; continue; }
        const t = iso();
        await zet(r.id, { status: 'concept', concept_id: j.concept_id.slice(0, 80), thread_id: typeof j.thread_id === 'string' ? j.thread_id.slice(0, 40) : null, concept_op: t, pdf_b64: null, fout: null, opmerking: null }, 'bezig');
        try { io.register({ aangemaakt: t, concept_id: j.concept_id, thread_id: j.thread_id || null, aan: aanT, onderwerp: r.onderwerp, hash: crypto.createHash('sha256').update(String(r.bericht)).digest('hex'), tekens: String(r.bericht).length, bijlagen: [r.pdf_naam], bron: 'pot-verzend' }); } catch (e) { uit.fouten.push('register'); }
        uit.concept++; gewijzigd = true; continue;
      }
      // zeker géén concept: het luik weigerde (400) of Gmail weigerde met {ok:false} (502)
      if (a && (a.status === 400 || (a.status === 502 && j && j.ok === false))) {
        await zet(r.id, { status: 'fout', fout: 'het mailluik nam het concept niet aan' + (j && typeof j.fout === 'string' ? ': ' + j.fout.slice(0, 120) : ''), pdf_b64: null }, 'bezig'); uit.fout++; gewijzigd = true; continue;
      }
      await zet(r.id, { status: 'onzeker', opmerking: 'geen bevestiging van het mailluik (' + (a && a.status ? 'http ' + a.status : 'geen antwoord') + ')' }, 'bezig');
      uit.onzeker++; gewijzigd = true;
    }
  }

  // 5. verzonden meten (elk uur): staat het concept als verzonden in de draad, of is het weg?
  if (o.meten) {
    const te = (await io.d1([{ sql: `select ${KOL} from nota_verzending where status='concept' and concept_op >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-${GRENS.meetDagen} days') order by coalesce(gemeten_op,'') , id limit ${GRENS.meetPerUur}`, params: [] }]))[0].results;
    for (const r of te) {
      let g;
      try { g = await zoekInGmail(io, r, r.concept_op); } catch (e) { uit.fouten.push('luik'); break; }
      if (g.verzonden) { if (await zet(r.id, { status: 'verzonden', verzonden_op: g.verzonden.datum || iso(), gemeten_op: iso() }, 'concept')) { uit.verzonden++; gewijzigd = true; } continue; }
      if (!g.concept && Date.parse(r.concept_op) < nuMs - GRENS.conceptWegUur * 3600e3) { if (await zet(r.id, { status: 'concept_weg', gemeten_op: iso() }, 'concept')) gewijzigd = true; continue; }
      await zet(r.id, { gemeten_op: iso() }, 'concept');
    }
  }

  // 6. kaarten (alleen bij een wijziging of op verzoek)
  if (gewijzigd || o.kaarten) {
    try { await kaarten(io, nuKortVan(nuD1), nuD1, o.adresbron); } catch (e) { uit.fouten.push('kaarten'); }
  }
  return uit;
}

const nuKortVan = (isoUtc) => { const p = new Date(isoUtc).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }); return dm(p) + ' ' + p.slice(11, 16); };
async function kaarten(io, nuKort, nuD1, adresbron) {
  const [gepland, adres, fout] = (await io.d1([
    { sql: "select v.id, v.entiteit, v.nummer, v.plan_datum, v.status, v.onderwerp from nota_verzending v where v.plan_datum is not null and v.status in ('concept','verzonden') and v.concept_op >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days') order by v.nummer", params: [] },
    { sql: "select v.id, v.nummer, v.praktijk_id, v.opmerking, v.fout as reden, coalesce(p.naam_brief, p.naam, v.praktijk_id) as praktijk, coalesce(v.plan_datum, substr(v.niet_voor,1,10)) as deadline from nota_verzending v left join praktijk p on p.id=v.praktijk_id where v.status='wacht_op_adres' order by v.id", params: [] },
    // fout zonder nieuwere poging voor dezelfde nota (een nieuwe druk lost hem op), hooguit 30 dagen oud
    { sql: "select v.id, v.nummer, v.fout, substr(v.bijgewerkt_op,1,10) as deadline from nota_verzending v where v.status='fout' and v.bijgewerkt_op >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days') and not exists (select 1 from nota_verzending w where w.nota_id=v.nota_id and w.id>v.id) order by v.id", params: [] },
  ])).map((x) => x.results);
  const lijst = await io.kaartLijst();
  const stand = Object.fromEntries((lijst || []).map((p) => [p.sleutel, p.status]));
  const open = (s) => stand[s] === 'open' || stand[s] === 'later';
  // geplande dagen: kaart zodra er concepten zijn; dicht (gedaan) als alles van die dag verzonden is
  const perDag = {};
  for (const r of gepland) (perDag[r.entiteit + '|' + r.plan_datum] ||= []).push(r);
  // open versturen-kaarten van een dag zonder concepten of verzonden mails meer (weggegooid, vervangen): dicht (Fable diffreview #3)
  for (const s of Object.keys(stand)) {
    const m = /^pot-verzend-([a-z]+)-(\d{4}-\d\d-\d\d)$/.exec(s);
    if (m && open(s) && !perDag[m[1].toUpperCase() + '|' + m[2]]) await io.kaartDicht(s, stand[s], `${nuKort}: voor deze dag staan geen concepten meer klaar.`);
  }
  for (const [k, rr] of Object.entries(perDag)) {
    const [ent, plan] = k.split('|');
    const p = kaartGepland(ent, plan, rr, nuKort);
    const nogConcept = rr.filter((r) => r.status === 'concept');
    if (!nogConcept.length) { if (open(p.sleutel)) await io.kaartDicht(p.sleutel, stand[p.sleutel], `${nuKort}: alle ${rr.length} nota's zijn verzonden.`); continue; }
    if (stand[p.sleutel] && !open(p.sleutel)) continue;   // David zette hem al dicht
    if (!stand[p.sleutel]) await io.kaartZet(p);
  }
  // adres en fout: één bundelkaart per stand; een oudere van dezelfde soort gaat dicht als hij niet meer klopt
  const bundel = async (prefix, rijen, maak, bewijs) => {
    const p = rijen.length ? maak(rijen, nuKort) : null;
    for (const s of Object.keys(stand)) if (s.startsWith(prefix) && open(s) && (!p || s !== p.sleutel)) await io.kaartDicht(s, stand[s], bewijs);
    if (p && !stand[p.sleutel]) await io.kaartZet(p);
  };
  await bundel('pot-verzend-adres-', adres, (rr, nk) => kaartAdres(rr, nk, adresbron), `${nuKort}: de factuuradressen zijn bijgewerkt; zie de nieuwe kaart als er nog iets openstaat.`);
  await bundel('pot-verzend-fout-', fout, kaartFout, `${nuKort}: de nota's zijn opnieuw klaargezet of afgehandeld; zie de nieuwe kaart als er nog iets openstaat.`);
  // wv921: niet automatisch (wacht nog op 07:00 van de verzenddag) en onzeker verzonden (na 24 uur niet in Verzonden)
  const [nietAuto, onzeker] = (await io.d1([
    { sql: "select id, nummer, substr(opmerking, 29) as reden, plan_datum as deadline from nota_verzending where auto=1 and status in ('wacht','wacht_op_adres') and opmerking like 'niet automatisch verstuurd: %' and niet_voor > strftime('%Y-%m-%dT%H:%M:%SZ','now') order by id", params: [] },
    { sql: "select id, nummer, coalesce(plan_datum, substr(aangevraagd_op,1,10)) as deadline from nota_verzending where status='onzeker_verzonden' and fout is not null and bijgewerkt_op >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days') order by id", params: [] },
  ])).map((x) => x.results);
  await bundel('pot-verzend-nietauto-', nietAuto, kaartNietAuto, `${nuKort}: bijgewerkt; zie de nieuwe kaart als er nog iets openstaat.`);
  await bundel('pot-verzend-onzeker-', onzeker, kaartOnzeker, `${nuKort}: bijgewerkt; zie de nieuwe kaart als er nog iets openstaat.`);
  // vrijgavekaarten die niet meer gelden (ingetrokken, al beantwoord elders, dag voorbij, geen wachtende nota meer): dicht
  const vk = Object.keys(stand).map((s) => /^pot-vrijgave-(\d{1,9})$/.exec(s)).filter((m) => m && open(m[0]));
  if (vk.length) {
    const vandaag = amsterdam(nuD1).ymd;
    const ok = new Set((await io.d1([{ sql: `select v.id from nota_vrijgave v where v.id in (${vk.map(() => '?').join(',')}) and v.vraag_id is null and v.ingetrokken_op is null and v.plan_datum > ? and exists (select 1 from nota_verzending r where r.vrijgave_id=v.id and r.status='auto_gevraagd')`, params: [...vk.map((m) => Number(m[1])), vandaag] }]))[0].results.map((x) => Number(x.id)));
    for (const m of vk) if (!ok.has(Number(m[1]))) await io.kaartDicht(m[0], stand[m[0]], `${nuKort}: deze vrijgave geldt niet meer; de nota's gaan als concept of staan op een nieuwe kaart.`);
  }
}

module.exports = { ronde, kaarten, nuKortVan, frontmatter, ontvangers, adressen, ADRESBRONNEN, bronVan, adresTekst, adresNorm, pdfBytes, pdfHoortBij, zoekInGmail, mailBody, kaartGepland, kaartAdres, kaartFout, GRENS,
  AUTO, AUTO_BEVESTIGING, amsterdam, feestdag, werkdag, notaHash, batchHash, kaartHash, kaartVrijgave, kaartVandaag, kaartNietAuto, kaartOnzeker, vrijgaveToets, vrijgaveSql, intrekSql, autoRonde,
  zetOvis, VZ_ACTIEF, VZ_OPNIEUW_VAN, VZ_ANNULEER_VAN, VZ_KOLOMMEN, aanvraagRijSql, aanvraagActiefSql, aanvraagNieuwSql, aanvraagSql, annuleerSql, adresSql };
