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
 * `facturen_aan` op de praktijkpagina), controleert de PDF (sha256 + pdftotext: nummer, bedrag en praktijknaam moeten erin staan) en
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
const KOL = 'id, nota_id, entiteit, nummer, praktijk_id, status, niet_voor, plan_datum, onderwerp, bericht, van, pdf_naam, pdf_b64, pdf_sha256, pdf_bytes, aangevraagd_op, reden, aan, cc, bron_pagina, concept_id, thread_id, concept_op, pogingen, geclaimd_op, opmerking';
const ADRES_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const ID_RE = /^P\d{2}$/;
const ENT_NAAM = { SLOEL: 'SLOEL', POT: 'POT', KM: 'KM POH-GGZ' };

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
const korteHash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
function kaartGepland(ent, plan, rijen, nuKort) {
  const nrs = rijen.map((r) => r.nummer).sort();
  return { sleutel: `pot-verzend-${ent.toLowerCase()}-${plan}`, soort: 'doen', volgorde: 25, deadline: plan, waar: 'overal', prive: true, duur_min: 2 + rijen.length,
    titel: `${ENT_NAAM[ent] || ent}-nota's van ${dm(plan)} — versturen`,
    herkomst: { handmatig: 'pot-verzend', entiteit: ent, plan_datum: plan },
    waarom: `Je liet in de POT-app ${rijen.length} nota${rijen.length > 1 ? "'s" : ''} klaarzetten voor ${dm(plan)}. Socev heeft vanochtend per nota een concept in Gmail gezet, met de PDF eraan, aan het factuuradres uit de Second Brain. Versturen doe je zelf.`,
    stappen: ['Open Gmail op je telefoon of laptop en ga naar Concepten.',
      `Zoek de concepten van ${nrs.length > 1 ? `de nota's ${nrs.join(', ')}` : `nota ${nrs[0]}`} (onderwerp ${rijen[0].onderwerp}).`,
      'Kijk per concept de ontvanger, de tekst en de PDF na en verstuur het.',
      "In de POT-app (tab Nota's) staat binnen een uur 'verzonden'; deze kaart gaat dan vanzelf dicht."],
    meting: `${nuKort}: ${rijen.length} concept${rijen.length > 1 ? 'en staan' : ' staat'} klaar in Gmail.` };
}
function kaartAdres(rijen, nuKort) {
  const regels = [...new Set(rijen.map((r) => `${r.praktijk}: ${r.reden}`))];
  const bevestig = rijen.some((r) => /^adres_(gewijzigd|nieuw)/.test(r.opmerking || ''));
  return { sleutel: 'pot-verzend-adres-' + korteHash(rijen.map((r) => r.id).sort().join(',')), soort: 'doen', volgorde: 22, waar: 'overal', prive: true, duur_min: 5,
    deadline: rijen.map((r) => r.deadline).sort()[0],
    titel: `POT-app — factuuradres ${bevestig ? 'bevestigen of ' : ''}aanvullen (${rijen.length} nota${rijen.length > 1 ? "'s" : ''})`,
    herkomst: { handmatig: 'pot-verzend', soort: 'adres', ids: rijen.map((r) => r.id) },
    waarom: 'Socev zet een nota pas als concept klaar als het factuuradres in de Second Brain staat en het hetzelfde is als het adres dat de POT-app kent. Bij deze nota\'s klopt dat nog niet: ' + regels.join('; ') + '.',
    stappen: [...(bevestig ? ["Klopt het nieuwe adres? Open de POT-app, tab Nota's, en tik bij de nota op 'adres klopt'."] : []),
      "Ontbreekt of klopt het adres niet: open in Obsidian de pagina van de praktijk (map Zakelijk › HAGRO › Praktijken, of de hoofdpagina van Groenhouten of Tolgaarde) en zet bij de eigenschappen facturen_aan op het juiste mailadres (fin_praktijk noemt de praktijk in de POT-app).",
      'Socev kijkt elke tien minuten opnieuw en zet het concept dan vanzelf klaar; deze kaart gaat daarna dicht.'],
    meting: `${nuKort}: ${rijen.length} nota${rijen.length > 1 ? "'s wachten" : ' wacht'} op een factuuradres.` };
}
function kaartFout(rijen, nuKort) {
  return { sleutel: 'pot-verzend-fout-' + korteHash(rijen.map((r) => r.id).sort().join(',')), soort: 'doen', volgorde: 21, waar: 'overal', prive: true, duur_min: 5,
    deadline: rijen.map((r) => r.deadline).sort()[0],
    titel: `POT-app — ${rijen.length} nota${rijen.length > 1 ? "'s" : ''} niet klaargezet`,
    herkomst: { handmatig: 'pot-verzend', soort: 'fout', ids: rijen.map((r) => r.id) },
    waarom: 'Socev kon deze nota\'s niet als concept klaarzetten: ' + rijen.map((r) => `${r.nummer} (${r.fout})`).join('; ').slice(0, 600) + '. Er staat voor deze nota\'s dus niets in Gmail, tenzij hieronder anders staat.',
    stappen: ["Open de POT-app, tab Nota's: bij deze nota's staat 'niet gelukt' (houd je vinger op het label voor de reden).",
      "Selecteer ze en tik nog eens op 'Zet klaar voor verzending'. Lukt het weer niet, zeg het dan in de machinekamer.",
      'Deze kaart gaat vanzelf dicht zodra ze opnieuw klaarstaan.'],
    meting: `${nuKort}: ${rijen.length} nota${rijen.length > 1 ? "'s" : ''} niet klaargezet.` };
}

// ── de ronde ─────────────────────────────────────────────────────────────────
/*
 * io = { d1(batch:[{sql,params}]) → [{results, changes}], luik(body) → json, concept(body) → { status, j }, pdftotext(bytes) → { ok, tekst },
 *        vault() → [{ pad, tekst }], kaartZet(p), kaartLijst() → [{ sleutel, status }], kaartDicht(sleutel, van, bewijs), register(regel) }
 * o = { meten: bool (verzonden meten), kaarten: bool (kaarten bijwerken, ook zonder wijziging) }
 * → { geclaimd, concept, wacht_op_adres, fout, onzeker, verzonden, opnieuw, fouten: [..] }
 */
async function ronde(io, o) {
  o = o || {};
  const uit = { geclaimd: 0, concept: 0, wacht_op_adres: 0, fout: 0, onzeker: 0, verzonden: 0, opnieuw: 0, fouten: [] };
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
    let ontv = null;
    try { ontv = ontvangers(await io.vault()); } catch (e) { ontv = null; uit.fouten.push('vault'); }
    for (const r of rijen) {
      const n = notaM[r.nota_id];
      // terug in de wachtrij (alleen na de adrescontrole gebruikt, dus het adres klopte op dat moment)
      const terug = async () => { await zet(r.id, { status: 'wacht', geclaimd_op: null }, 'bezig'); };
      if (!n || n.entiteit !== r.entiteit || n.nummer !== r.nummer || n.praktijk_id !== r.praktijk_id) { await zet(r.id, { status: 'fout', fout: 'de nota is in de POT-app niet (meer) dezelfde', pdf_b64: null }, 'bezig'); uit.fout++; gewijzigd = true; continue; }
      if (n.status !== 'definitief') { await zet(r.id, { status: 'fout', fout: `de nota is nu ${n.status}`, pdf_b64: null }, 'bezig'); uit.fout++; gewijzigd = true; continue; }
      const pb = pdfBytes(r);
      if (!pb.ok) { await zet(r.id, { status: 'fout', fout: pb.fout, pdf_b64: null }, 'bezig'); uit.fout++; gewijzigd = true; continue; }
      let tk;
      try { tk = await io.pdftotext(pb.bytes); } catch (e) { tk = { ok: false }; }
      if (!tk || !tk.ok) { await zet(r.id, { status: 'wacht', geclaimd_op: null, opmerking: 'PDF nog niet te lezen; volgende minuut opnieuw' }, 'bezig'); uit.fouten.push('pdftotext'); continue; }
      const hb = pdfHoortBij(tk.tekst, n);
      if (!hb.ok) { await zet(r.id, { status: 'fout', fout: 'de PDF hoort niet bij deze nota (mist ' + hb.mist.join(', ') + ')', pdf_b64: null }, 'bezig'); uit.fout++; gewijzigd = true; continue; }
      if (!ontv) { await zet(r.id, { status: 'wacht', geclaimd_op: null }, 'bezig'); continue; }
      const o1 = ontv.per[r.praktijk_id];
      const praktijk = n.naam_brief || n.naam || r.praktijk_id;
      const wachtAdres = async (opm, reden, aan) => {
        const al = r.opmerking === opm && (r.aan || null) === (aan || null);
        await zet(r.id, { status: 'wacht_op_adres', opmerking: opm, fout: reden, aan: aan || null, geclaimd_op: null }, 'bezig');
        uit.wacht_op_adres++; if (!al) gewijzigd = true;
      };
      if (!o1) { await wachtAdres('geen_adres', ontv.problemen[r.praktijk_id] || `voor ${praktijk} staat geen factuuradres in de Second Brain (veld facturen_aan op de praktijkpagina)`, null); continue; }
      const aanT = adresTekst(o1.aan);
      if (!n.email) { await wachtAdres('adres_nieuw', `nieuw factuuradres voor ${praktijk}: ${aanT}`, aanT); continue; }
      if (adresNorm(n.email) !== aanT) { await wachtAdres('adres_gewijzigd', `het factuuradres van ${praktijk} in de Second Brain (${aanT}) verschilt van wat de POT-app kent (${adresNorm(n.email)})`, aanT); continue; }
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
    try { await kaarten(io, nuKortVan(nuD1)); } catch (e) { uit.fouten.push('kaarten'); }
  }
  return uit;
}

const nuKortVan = (isoUtc) => { const p = new Date(isoUtc).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }); return dm(p) + ' ' + p.slice(11, 16); };
async function kaarten(io, nuKort) {
  const [gepland, adres, fout] = (await io.d1([
    { sql: "select v.id, v.entiteit, v.nummer, v.plan_datum, v.status, v.onderwerp from nota_verzending v where v.plan_datum is not null and v.status in ('concept','verzonden') and v.concept_op >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days') order by v.nummer", params: [] },
    { sql: "select v.id, v.nummer, v.opmerking, v.fout as reden, coalesce(p.naam_brief, p.naam, v.praktijk_id) as praktijk, coalesce(v.plan_datum, substr(v.niet_voor,1,10)) as deadline from nota_verzending v left join praktijk p on p.id=v.praktijk_id where v.status='wacht_op_adres' order by v.id", params: [] },
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
  await bundel('pot-verzend-adres-', adres, kaartAdres, `${nuKort}: de factuuradressen zijn bijgewerkt; zie de nieuwe kaart als er nog iets openstaat.`);
  await bundel('pot-verzend-fout-', fout, kaartFout, `${nuKort}: de nota's zijn opnieuw klaargezet of afgehandeld; zie de nieuwe kaart als er nog iets openstaat.`);
}

module.exports = { ronde, kaarten, nuKortVan, frontmatter, ontvangers, adresTekst, adresNorm, pdfBytes, pdfHoortBij, zoekInGmail, mailBody, kaartGepland, kaartAdres, kaartFout, GRENS };
