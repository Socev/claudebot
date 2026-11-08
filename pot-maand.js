'use strict';
/*
 * pot-maand.js — OVIS POT maandronde (wv2762, 8-11-2026). Ontwerp: vault "01_Ontwikkeling/OVIS POT op pot.socev.dev (ontwerp 8-11-2026).md"
 * § 5 (elke 1e), § 6 (bank, betaalstatus, nota's), § 9 (één rekenkern voor app en pod).
 *
 * WAAROM. David 8-11-2026: de POT-afhandeling moet "gemakkelijk, alles gericht op orde en overzicht"; vanaf 1-1-2027 neemt de app het vragen
 * over (besluit 8-11 15:48). Elke 1e maakt de pod de nota's van de maand uit het vastgestelde jaarplan en zet per praktijk één Gmail-concept
 * met alle stukken van die dag klaar (9 in plaats van 26); elk stuk gaat óók als concept naar het verkoopadres van de entiteit in Exact
 * (David 8-11 16:19). Een herinnering voor een open nota zet hij klaar als David erom vraagt in de app. ALLES CONCEPT: grondwet regel 1;
 * de SLOEL-verzenduitzondering (pot-verzend.js) wordt hier niet gebruikt.
 *
 * HOE. Eén tik (server.js potMaandTik, elke 10 minuten, alleen de primaire pod, schakelaar <POT_MAAND_DIR>/aan):
 *   1 nota's van de maand maken (vanaf instelling.overname_vragen, op/na de 1e vanaf maandronde_uur, niet in januari: die maakt David in de
 *     januari-ronde) met precies de API van de app (bundel ovis-pot/api.mjs, gegenereerd uit Socev/ovis-pot): notas-maken;
 *   2 nieuwe stukken bundelen tot mailregels (D1 mail_concept): per praktijk per notadatum, per entiteit per notadatum voor Exact
 *     (zonder verkoopadres: 'geen_adres', geen gok), herinneringen uit pod_verzoek;
 *   3 bezig > 10 min → onzeker; onzeker zelf terugzoeken in Gmail (lees-luik); wachtende regels klaarzetten via het mailluik met de pdf's
 *     uit dezelfde stukken-code als de app (notaPdf), na een pdftotext-controle (nummer, bedrag, naam) en een voorcontrole in Gmail;
 *   4 elk uur nameten: concept → verzonden of weg;
 *   5 Voor jou: één kaart per notadatum ("9 concepten van 1 feb klaar"), met wat er van eerdere nota's nog open staat (en, eenmalig per
 *     entiteit per jaar, één regel als de kosten voorlopen op de begroting: bewaking wv2793); één kaart voor
 *     regels die niet lukten of op een adres wachten.
 * Ontvanger praktijk = het vastgezette factuuradres uit het OVIS-register (zelfde bron als pot-verzend); verschilt het van het e-mailadres op
 * de nota (debiteur van die datum), dan wacht de regel (wacht_op_adres) tot het gelijk is. Klok en tijdstempels uit D1, niet van de pod.
 *
 * PUUR. Geen netwerk, bestand of proces: D1, het lees-luik, het mailluik, pdftotext, het register, Voor jou en de bundel komen via io.
 */
const crypto = require('crypto');

const GRENS = { perTik: 12, perDag: 40, onzekerPerTik: 10, meetPerUur: 15, meetDagen: 90, conceptWegUur: 2, pogingenMax: 3, bijlagenMax: 10, pdfMax: 250 * 1024 };
const D1_NU = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const ADRES_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const VAN = '"David Schaap" <dokterschaap@gmail.com>';   // gemeten: zo verstuurde David de SLOEL-nota's (pot-app.js VZ_VAN)
const ENT_KORT = { POT: 'POT', KM: 'Kostenmaatschap', SLOEL: 'SLOEL' };
const KOL = 'id, sleutel, soort, entiteit, praktijk_id, datum, nota_ids, nummers, aan, onderwerp, status, reden, concept_id, thread_id, concept_op, verzonden_op, gemeten_op, pogingen, geclaimd_op, aangemaakt_op';

// ── tijd (uit D1) ────────────────────────────────────────────────────────────
function amsterdam(isoUtc) {
  const p = new Date(isoUtc).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' });   // "2027-02-01 06:10:00"
  return { ymd: p.slice(0, 10), hm: p.slice(11, 16), jaar: Number(p.slice(0, 4)), maand: Number(p.slice(5, 7)), dag: Number(p.slice(8, 10)) };
}
const dm = (ymd) => { const [, m, d] = String(ymd).slice(0, 10).split('-'); return `${Number(d)}-${Number(m)}`; };
const MND = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const datumWoord = (ymd) => { const [j, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return `${d} ${MND[m - 1]} ${j}`; };
const kap = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const korteHash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
const plat = (s) => String(s || '').replace(/[\u00a0\u202f\u2009]/g, ' ').replace(/\s+/g, ' ').trim();

// ── D1 als D1Achtig voor de API van de app (bundel api.mjs) ──────────────────
function d1Achtig(d1) {
  const maak = (sql, w) => ({ sql, w,
    bind: (...x) => maak(sql, x),
    all: async () => ({ results: (await d1([{ sql, params: w || [] }]))[0].results }),
    run: async () => (await d1([{ sql, params: w || [] }]))[0] });
  return { prepare: (sql) => maak(sql, []), batch: async (st) => d1(st.map((s) => ({ sql: s.sql, params: s.w || [] }))) };
}

// ── stukken ──────────────────────────────────────────────────────────────────
function afzenderVan(ent) {
  return { naam: ent.naam || ent.code, naam_document: ent.naam_document || ent.naam || ent.code, adres: ent.adres || null, postcode_plaats: ent.postcode_plaats || null, iban: ent.iban || null, kvk: ent.kvk || null };
}
function debiteur(n) { try { return typeof n.debiteur === 'string' ? JSON.parse(n.debiteur) : (n.debiteur || {}); } catch (e) { return {}; } }
function bestandsnaam(n) {
  const d = debiteur(n);
  return `${n.entiteit} - ${n.nummer} - ${d.naam || n.praktijk_id}`.replace(/[\\/:*?"<>|]+/g, '-').trim() + '.pdf';
}
// De pdf moet bij déze nota horen: nummer, bedrag zoals op de nota (€ 1.234,56) en de naam van de debiteur staan erin.
function pdfHoortBij(tekst, n, K) {
  const t = plat(tekst), mist = [];
  if (!t.includes(String(n.nummer))) mist.push('nummer');
  if (!t.includes(plat(K.euro(n.bedrag)))) mist.push('bedrag');
  const naam = plat(debiteur(n).naam || '');
  if (!naam || !t.includes(naam)) mist.push('naam');
  return mist;
}

// ── Gmail (lees-luik) ────────────────────────────────────────────────────────
const gmailDatum = (iso, dagenTerug) => { const d = new Date(Date.parse(iso) - (dagenTerug || 0) * 864e5); return isNaN(d) ? '2027/01/01' : d.toISOString().slice(0, 10).replace(/-/g, '/'); };
const labels = (m) => (Array.isArray(m.labels) ? m.labels : String(m.labels || '').replace(/[[\]'"\s]/g, '').split(',')).map((x) => String(x).toUpperCase());
// Concepten/verzonden van deze regel: een bijlage met het eerste nummer, hetzelfde onderwerp, de ontvanger in `aan`.
async function zoekInGmail(io, rij, vanaf) {
  const nrs = JSON.parse(rij.nummers || '[]');
  const eerste = String(nrs[0] || '').split(' ').pop();
  if (!/^\d{7}$/.test(eerste)) throw new Error('regel zonder nummer');
  const j = await io.luik({ actie: 'mail_zoeken', query: `filename:${eerste} {in:draft in:sent} after:${gmailDatum(vanaf, 1)}`, max: 20 });
  const mails = Array.isArray(j) ? j : (j && Array.isArray(j.mails) ? j.mails : null);
  if (!mails) throw new Error('lees-luik zonder lijst');
  const aan = String(rij.aan || '').toLowerCase();
  const past = mails.filter((m) => String(m.onderwerp || '').trim() === String(rij.onderwerp || '').trim() && (!aan || String(m.aan || '').toLowerCase().includes(aan)));
  const verzonden = past.find((m) => labels(m).includes('SENT')) || (rij.thread_id ? mails.find((m) => labels(m).includes('SENT') && m.thread_id === rij.thread_id) : null);
  const concept = past.find((m) => labels(m).includes('DRAFT'));
  return { verzonden: verzonden || null, concept: concept || null };
}

// ── 1. nota's van de maand ───────────────────────────────────────────────────
async function maandNotas(io, B, nu, inst, uit) {
  const vanaf = inst.overname_vragen || '2027-01-01';
  if (nu.ymd < vanaf || nu.maand === 1) return;   // januari: de januari-ronde (David) maakt ze, iets na de 1e
  if (nu.hm < (inst.maandronde_uur || '06:00')) return;
  const periode = `${nu.jaar}-${String(nu.maand).padStart(2, '0')}`;
  const merk = inst['maandronde_' + periode];
  let vorig = null; try { vorig = merk ? JSON.parse(merk) : null; } catch (e) { vorig = null; }
  if (vorig && vorig.klaar) return;
  // niet vaker dan eens per uur opnieuw proberen (bijv. nog geen vastgesteld jaarplan)
  if (vorig && vorig.op && Date.parse(nu.iso) - Date.parse(vorig.op) < 3600e3) return;
  const db = d1Achtig(io.d1);
  const plannen = (await io.d1([{ sql: "select entiteit from jaarplan where jaar=? and status='vastgesteld'", params: [nu.jaar] }]))[0].results.map((x) => x.entiteit);
  let st;
  if (!plannen.length) st = { klaar: false, reden: `geen vastgesteld jaarplan ${nu.jaar}`, op: nu.iso };
  else {
    const r = await B.api.behandel(db, 'POST', 'notas-maken', new URLSearchParams(), { jaar: nu.jaar, maand: nu.maand }, 'pod maandronde');
    if (r.status === 200) { st = { klaar: true, gemaakt: (r.body.gemaakt || []).length, op: nu.iso }; uit.notas_gemaakt = st.gemaakt; }
    else if (r.status === 409 && /bestaan al/.test(String(r.body && r.body.fout))) {
      // 'niets te maken': bestaan ze echt al voor elke entiteit met een vastgesteld plan?
      const n = (await io.d1([{ sql: "select count(distinct entiteit) as n from nota where soort='maand' and periode=? and bron='ovis-pot' and status<>'vervallen'", params: [periode] }]))[0].results[0];
      st = Number(n && n.n) >= plannen.length ? { klaar: true, gemaakt: 0, op: nu.iso } : { klaar: false, reden: String(r.body.fout).slice(0, 200), op: nu.iso };
    } else st = { klaar: false, reden: String((r.body && r.body.fout) || 'http ' + r.status).slice(0, 200), op: nu.iso };
  }
  if (!st.klaar) uit.fouten.push('notas');
  uit.notas = st;
  await io.d1([{ sql: "insert into instelling (sleutel, waarde, opmerking) values (?, ?, 'maandronde van de pod (wv2762): klaar of de reden') on conflict(sleutel) do update set waarde=excluded.waarde", params: ['maandronde_' + periode, JSON.stringify(st)] }]);
}

// ── 2. bundelen tot mailregels ───────────────────────────────────────────────
async function bundel(io, B, nu, inst, uit) {
  const vanaf = inst.overname_vragen || '2027-01-01';
  const [nieuwP, nieuwE, verz] = (await io.d1([
    { sql: "select n.id, n.entiteit, n.nummer, n.praktijk_id, n.datum, n.debiteur from nota n where n.bron='ovis-pot' and n.status='definitief' and n.datum>=? and n.datum<=? and not exists (select 1 from mail_concept c, json_each(c.nota_ids) j where c.soort='praktijk' and j.value=n.id) order by n.praktijk_id, n.datum, n.entiteit, n.nummer", params: [vanaf, nu.ymd] },
    { sql: "select n.id, n.entiteit, n.nummer, n.praktijk_id, n.datum from nota n where n.bron='ovis-pot' and n.status='definitief' and n.datum>=? and n.datum<=? and not exists (select 1 from mail_concept c, json_each(c.nota_ids) j where c.soort='exact' and j.value=n.id) order by n.entiteit, n.datum, n.nummer", params: [vanaf, nu.ymd] },
    { sql: "select v.id, v.nota_id, n.entiteit, n.nummer, n.praktijk_id from pod_verzoek v join nota n on n.id=v.nota_id where v.status='wacht' and v.soort='herinnering' order by v.id limit 20", params: [] },
  ])).map((x) => x.results);
  const st = [];
  const groep = (lijst, sleutelVan) => { const g = new Map(); for (const n of lijst) { const k = sleutelVan(n); if (!g.has(k)) g.set(k, []); g.get(k).push(n); } return g; };
  // per praktijk, notadatum én debiteur (houder): bij een overname krijgen oude en nieuwe houder elk hun eigen mail (Codex r1 M1)
  const houder = (n) => { const d = debiteur(n); return d.versie_id != null ? 'v' + d.versie_id : 'h' + korteHash([d.houder, d.naam, d.email].join('|')); };
  for (const [k, l] of groep(nieuwP, (n) => n.praktijk_id + '|' + n.datum + '|' + houder(n))) {
    for (let i = 0; i < l.length; i += GRENS.bijlagenMax) {
      const deel = l.slice(i, i + GRENS.bijlagenMax), ids = deel.map((n) => n.id);
      const [pid, dat] = k.split('|');
      st.push({ sql: "insert or ignore into mail_concept (sleutel, soort, praktijk_id, datum, nota_ids, nummers, status) values (?, 'praktijk', ?, ?, ?, ?, 'wacht')",
        params: [`praktijk:${pid}:${dat}:${korteHash(ids.join(','))}`, pid, dat, JSON.stringify(ids), JSON.stringify(deel.map((n) => n.entiteit + ' ' + n.nummer))] });
    }
  }
  for (const [k, l] of groep(nieuwE, (n) => n.entiteit + '|' + n.datum)) {
    const [e, dat] = k.split('|');
    const adres = String(inst['verkoopadres_exact_' + e] || '').trim().toLowerCase();
    for (let i = 0; i < l.length; i += GRENS.bijlagenMax) {
      const deel = l.slice(i, i + GRENS.bijlagenMax), ids = deel.map((n) => n.id);
      st.push({ sql: "insert or ignore into mail_concept (sleutel, soort, entiteit, datum, nota_ids, nummers, status, reden) values (?, 'exact', ?, ?, ?, ?, ?, ?)",
        params: [`exact:${e}:${dat}:${korteHash(ids.join(','))}`, e, dat, JSON.stringify(ids), JSON.stringify(deel.map((n) => n.entiteit + ' ' + n.nummer)),
          adres ? 'wacht' : 'geen_adres', adres ? null : `verkoopadres Exact ontbreekt voor ${ENT_KORT[e] || e}`] });
    }
  }
  for (const v of verz) {
    st.push({ sql: "insert or ignore into mail_concept (sleutel, soort, entiteit, praktijk_id, datum, nota_ids, nummers, status) values (?, 'herinnering', ?, ?, ?, ?, ?, 'wacht')",
      params: [`herinnering:${v.id}`, v.entiteit, v.praktijk_id, nu.ymd, JSON.stringify([v.nota_id]), JSON.stringify([v.entiteit + ' ' + v.nummer])] });
    st.push({ sql: `update pod_verzoek set status='klaar', uitkomst='in de wachtrij voor een concept', bijgewerkt_op=${D1_NU} where id=? and status='wacht'`, params: [v.id] });
  }
  // een verkoopadres dat er intussen is: de regels zonder adres gaan alsnog (de achterstand als concept)
  for (const e of ['POT', 'KM', 'SLOEL']) {
    if (String(inst['verkoopadres_exact_' + e] || '').trim()) st.push({ sql: `update mail_concept set status='wacht', reden=null, bijgewerkt_op=${D1_NU} where soort='exact' and entiteit=? and status='geen_adres'`, params: [e] });
  }
  if (st.length) {
    const r = await io.d1(st);
    uit.gebundeld = r.reduce((s, x, i) => s + (/^insert/.test(st[i].sql) ? Number(x.changes) || 0 : 0), 0);
  }
}

// ── 3. klaarzetten ───────────────────────────────────────────────────────────
async function klaarzetten(io, B, nu, inst, uit, zet) {
  // dagplafond (op concept_op in D1)
  const dag = (await io.d1([{ sql: "select count(*) as n from mail_concept where concept_op >= strftime('%Y-%m-%dT00:00:00Z','now')", params: [] }]))[0].results[0];
  const ruimte = Math.min(GRENS.perTik, GRENS.perDag - Number(dag && dag.n || 0));
  if (ruimte <= 0) { uit.fouten.push('dagplafond'); return; }
  const rijen = (await io.d1([{ sql: `update mail_concept set status='bezig', geclaimd_op=${D1_NU}, bijgewerkt_op=${D1_NU} where id in (select id from mail_concept where status='wacht' or (status='wacht_op_adres' and bijgewerkt_op < strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 minutes')) order by id limit ${ruimte}) and status in ('wacht','wacht_op_adres') returning ${KOL}`, params: [] }]))[0].results;
  uit.geclaimd = rijen.length;
  if (!rijen.length) return;
  const ids = [...new Set(rijen.flatMap((r) => JSON.parse(r.nota_ids || '[]')))];
  // de herinneringsverzoeken van precies deze regels (niet 'de laatste n'; Codex r1 Z2)
  const vIds = rijen.map((r) => /^herinnering:(\d+)$/.exec(r.sleutel)).filter(Boolean).map((m) => Number(m[1]));
  const [notas, ents, verz, versies] = (await io.d1([
    { sql: `select * from nota where id in (${ids.map(() => '?').join(',')})`, params: ids },
    { sql: "select code, naam, naam_document, adres, postcode_plaats, kvk, iban from entiteit where code in ('POT','KM','SLOEL')", params: [] },
    { sql: vIds.length ? `select id, open_bedrag from pod_verzoek where id in (${vIds.map(() => '?').join(',')})` : 'select id, open_bedrag from pod_verzoek where 0', params: vIds },
    // de versie die vandaag geldt per praktijk: alleen die houder staat (vastgezet) in het register
    { sql: 'select v.praktijk_id, v.id from praktijk_versie v where v.geldig_van = (select max(w.geldig_van) from praktijk_versie w where w.praktijk_id=v.praktijk_id and w.geldig_van<=?)', params: [nu.ymd] },
  ])).map((x) => x.results);
  const huidig = new Map(versies.map((v) => [v.praktijk_id, Number(v.id)]));
  const notaM = new Map(notas.map((n) => [n.id, n]));
  const entM = new Map(ents.map((e) => [e.code, e]));
  let reg = null;
  if (rijen.some((r) => r.soort !== 'exact')) { try { reg = await io.registerAdressen(); } catch (e) { reg = null; } }
  for (const r of rijen) {
    const terug = async (reden) => { await zet(r.id, { status: 'wacht', geclaimd_op: null, reden: reden || null }, 'bezig'); };
    const fout = async (reden) => { await zet(r.id, { status: 'fout', reden: kap(reden, 300) }, 'bezig'); uit.fout++; uit.gewijzigd = true; };
    const ns = JSON.parse(r.nota_ids || '[]').map((id) => notaM.get(id));
    if (!ns.length || ns.some((n) => !n || n.status !== 'definitief' || n.bron !== 'ovis-pot')) { await fout('een stuk in deze mail is niet (meer) vastgesteld in OVIS POT'); continue; }
    // ontvanger
    let aan;
    if (r.soort === 'exact') {
      aan = String(inst['verkoopadres_exact_' + r.entiteit] || '').trim().toLowerCase();
      if (!aan) { await zet(r.id, { status: 'geen_adres', reden: `verkoopadres Exact ontbreekt voor ${ENT_KORT[r.entiteit] || r.entiteit}`, geclaimd_op: null }, 'bezig'); continue; }
      if (!ADRES_RE.test(aan)) { await fout('het verkoopadres in Exact is geen geldig mailadres'); continue; }
    } else {
      const naam = debiteur(ns[0]).naam || r.praktijk_id;
      // een stuk voor een vorige houder (overname): het register kent alleen de huidige; dan het adres dat op de nota is vastgelegd (R10).
      // Zonder versie op de debiteur (of zonder geldende versie) is niet vast te stellen bij welke houder het hoort: niet automatisch (Codex r2 M1).
      const deb = debiteur(ns[0]);
      if (deb.versie_id == null || !huidig.has(r.praktijk_id) || ns.some((n) => String(debiteur(n).versie_id) !== String(deb.versie_id))) {
        await fout(`bij de stukken van ${naam} is niet vast te stellen bij welke houder ze horen; download de pdf in OVIS POT › Nota's en stuur hem zelf`); continue;
      }
      if (Number(deb.versie_id) !== huidig.get(r.praktijk_id)) {
        const opNota = String(deb.email || '').trim().toLowerCase();
        if (!ADRES_RE.test(opNota)) { await fout(`stuk voor de vorige houder van ${naam} zonder e-mailadres op de nota; download de pdf in OVIS POT › Nota's en stuur hem zelf`); continue; }
        aan = opNota;
      }
    }
    if (!aan && r.soort !== 'exact') {
      if (!reg || typeof reg.per !== 'object' || !reg.per || typeof reg.problemen !== 'object') { await terug(); uit.fouten.push('adresregister'); continue; }
      const o1 = reg.per[r.praktijk_id];
      const naam = debiteur(ns[0]).naam || r.praktijk_id;
      const wachtAdres = async (reden) => { const al = r.status === 'wacht_op_adres' && r.reden === reden; await zet(r.id, { status: 'wacht_op_adres', reden: kap(reden, 300), geclaimd_op: null }, 'bezig'); uit.wacht_op_adres++; if (!al) uit.gewijzigd = true; };
      if (!o1 || !Array.isArray(o1.aan) || o1.aan.length !== 1 || (o1.cc || []).length || !ADRES_RE.test(String(o1.aan[0]).toLowerCase())) {
        await wachtAdres(reg.problemen[r.praktijk_id] || `voor ${naam} staat geen (enkel) vastgezet factuuradres in de Second Brain`); continue;
      }
      aan = String(o1.aan[0]).toLowerCase();
      const opNota = [...new Set(ns.map((n) => String(debiteur(n).email || '').trim().toLowerCase()).filter(Boolean))];
      if (opNota.some((a) => a !== aan)) { await wachtAdres(`het factuuradres van ${naam} in de Second Brain (${aan}) verschilt van het e-mailadres op de nota (${opNota.join(', ')}); pas de praktijkversie in OVIS POT of de stamkaart aan`); continue; }
    }
    // pdf's uit dezelfde stukken-code als de app, nagelezen met pdftotext
    const bijlagen = []; let pdfFout = null, pdfLeesFout = false;
    for (const n of ns) {
      let bytes;
      try { bytes = Buffer.from(B.S.notaPdf({ nota: n, afzender: afzenderVan(entM.get(n.entiteit) || { code: n.entiteit }) })); } catch (e) { pdfFout = `pdf ${n.nummer}: ${String(e && e.message || e).slice(0, 120)}`; break; }
      if (!bytes.length || bytes.length > GRENS.pdfMax || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') { pdfFout = `pdf ${n.nummer} heeft niet de verwachte vorm`; break; }
      let tk; try { tk = await io.pdftotext(bytes); } catch (e) { tk = { ok: false }; }
      if (!tk || !tk.ok) { pdfLeesFout = true; break; }
      const mist = pdfHoortBij(tk.tekst, n, B.K);
      if (mist.length) { pdfFout = `de pdf van ${n.nummer} mist ${mist.join(', ')}`; break; }
      bijlagen.push({ naam: bestandsnaam(n), mime: 'application/pdf', inhoud_base64: bytes.toString('base64') });
    }
    if (pdfLeesFout) { await terug('pdf nog niet te lezen; volgende tik opnieuw'); uit.fouten.push('pdftotext'); continue; }
    if (pdfFout) { await fout(pdfFout); continue; }
    // tekst (zelfde woordtoets als de stukken: geen 'factuur', geen btw, geen min-teken)
    let tekst;
    try {
      const praktijk = debiteur(ns[0]).naam || r.praktijk_id;
      if (r.soort === 'exact') tekst = B.K.exactMail({ entiteit: r.entiteit, datum: r.datum, notas: ns });
      else if (r.soort === 'herinnering') {
        const v = verz.find((x) => `herinnering:${x.id}` === r.sleutel);
        if (!v) throw new Error('het verzoek bij deze herinnering is niet te vinden');
        const open = Number(v.open_bedrag);
        tekst = B.K.herinneringMail({ praktijk, nota: ns[0], open, ondertekening: inst.ondertekening || 'David Schaap' });
      } else tekst = B.K.praktijkMail({ praktijk, datum: r.datum, notas: ns, ondertekening: inst.ondertekening || 'David Schaap' });
    } catch (e) { await fout(String(e && e.message || e)); continue; }
    // adres en onderwerp vastleggen vóór de aanroep (de herstelstap weet dan waarnaar te zoeken)
    if (!(await zet(r.id, { aan: aan, onderwerp: tekst.onderwerp }, 'bezig'))) continue;
    const rij = Object.assign({}, r, { aan: aan, onderwerp: tekst.onderwerp });
    let g;
    try { g = await zoekInGmail(io, rij, r.aangemaakt_op); } catch (e) { await terug(); uit.fouten.push('luik'); continue; }
    if (g.verzonden || g.concept) {
      const m = g.verzonden || g.concept;
      await zet(r.id, { status: g.verzonden ? 'verzonden' : 'concept', concept_id: m.id ? String(m.id).slice(0, 80) : null, thread_id: m.thread_id ? String(m.thread_id).slice(0, 40) : null, concept_op: nu.iso, verzonden_op: g.verzonden ? (m.datum || nu.iso) : null, reden: 'stond al in Gmail; geen tweede concept' }, 'bezig');
      uit[g.verzonden ? 'verzonden' : 'concept']++; uit.gewijzigd = true; continue;
    }
    let a;
    try { a = await io.concept({ aan: aan, onderwerp: tekst.onderwerp, bericht: tekst.bericht, van: VAN, bijlagen: bijlagen }); } catch (e) { a = { status: 0, j: null }; }
    const j = a && a.j;
    if (a && a.status === 200 && j && j.ok === true && typeof j.concept_id === 'string') {
      if (Number(j.bijlagen) !== bijlagen.length) { await zet(r.id, { status: 'fout', concept_id: j.concept_id.slice(0, 80), reden: `er staat een concept met ${Number(j.bijlagen) || 0} van de ${bijlagen.length} pdf's in Gmail (onderwerp ${tekst.onderwerp}); gooi dat weg, dan zet de pod het opnieuw klaar` }, 'bezig'); uit.fout++; uit.gewijzigd = true; continue; }
      await zet(r.id, { status: 'concept', concept_id: j.concept_id.slice(0, 80), thread_id: typeof j.thread_id === 'string' ? j.thread_id.slice(0, 40) : null, concept_op: nu.iso, reden: null }, 'bezig');
      try { io.register({ aangemaakt: nu.iso, concept_id: j.concept_id, thread_id: j.thread_id || null, aan: aan, onderwerp: tekst.onderwerp, hash: crypto.createHash('sha256').update(tekst.bericht).digest('hex'), tekens: tekst.bericht.length, bijlagen: bijlagen.map((x) => x.naam), bron: 'pot-maand' }); } catch (e) { uit.fouten.push('register'); }
      uit.concept++; uit.gewijzigd = true; continue;
    }
    if (a && (a.status === 400 || (a.status === 502 && j && j.ok === false))) { await fout('het mailluik nam het concept niet aan' + (j && typeof j.fout === 'string' ? ': ' + j.fout.slice(0, 120) : '')); continue; }
    await zet(r.id, { status: 'onzeker', reden: 'geen bevestiging van het mailluik (' + (a && a.status ? 'http ' + a.status : 'geen antwoord') + ')' }, 'bezig');
    uit.onzeker++; uit.gewijzigd = true;
  }
}

// ── 5. Voor jou ──────────────────────────────────────────────────────────────
const POT_DOEL = { module: 'pot', doel: { scherm: 'pot', focus: 'notas:alle' } };
function kaartGrens(p) { return Object.assign(p, { titel: kap(p.titel, 90), waarom: kap(p.waarom, 400), meting: kap(p.meting, 300), stappen: (p.stappen || []).slice(0, 12) }); }
function kaartKlaar(datum, rijen, open, nuKort, bewaking) {
  const n = rijen.length;
  bewaking = bewaking || [];
  return kaartGrens({ sleutel: `ovis-pot-maand-${datum}`, soort: 'doen', volgorde: 25, deadline: datum.slice(0, 8) + '05', waar: 'overal', prive: true, duur_min: 2 + n,
    titel: `OVIS POT — ${n} concept${n > 1 ? 'en' : ''} van ${dm(datum)} versturen`,
    herkomst: { handmatig: 'pot-maand', datum: datum, ...POT_DOEL },
    waarom: `Socev maakte de stukken van ${datumWoord(datum)} (bijdragen POT en Kostenmaatschap, doorbelaste huur SLOEL) en zette per praktijk één mail met de pdf's als concept in Gmail, aan het vastgezette mailadres van de praktijk uit de Second Brain. Iedereen betaalt op de 15e. Versturen doe je zelf.` +
      (open.length ? ` Nog open van eerder: ${open.join('; ')}.` : ''),
    stappen: [...bewaking.map((b) => `Let op, ${ENT_KORT[b.entiteit] || b.entiteit}: ${b.tekst} Kijk in OVIS POT › Wat nu.`), 'Open Gmail en ga naar Concepten.', `Kijk per praktijk de mail na (onderwerp begint met "POH-GGZ"): ontvanger, tekst en de pdf's.`, 'Verstuur ze.',
      ...(open.length ? ['Wil je een praktijk herinneren aan een open nota: OVIS POT › Betalingen, "herinnering als concept".'] : []),
      'Binnen een uur na versturen ziet Socev ze als verzonden; deze kaart gaat dan vanzelf dicht.'],
    meting: `${nuKort}: ${n} concept${n > 1 ? 'en staan' : ' staat'} klaar in Gmail.` });
}
function kaartProbleem(rijen, nuKort) {
  const regels = [...new Set(rijen.map((r) => r.reden || r.status))];
  return kaartGrens({ sleutel: 'ovis-pot-maand-probleem-' + korteHash(rijen.map((r) => r.id + ':' + r.status).sort().join(',')), soort: 'doen', volgorde: 22, waar: 'overal', prive: true, duur_min: 5,
    deadline: rijen.map((r) => r.datum).sort()[0],
    titel: `OVIS POT — ${rijen.length} mail${rijen.length > 1 ? 's' : ''} niet als concept klaargezet`,
    herkomst: { handmatig: 'pot-maand', soort: 'probleem', ids: rijen.map((r) => r.id), ...POT_DOEL },
    waarom: 'Socev kon deze mails met stukken niet als concept klaarzetten: ' + regels.join('; ') + '. Voor deze stukken staat dus nog niets in Gmail.',
    stappen: ['Gaat het om een factuuradres: zeg tegen Socev "factuuradres <praktijk> is …"; Socev zet het in de Second Brain en daarna komt er een kaart om het vast te zetten. Of pas in OVIS POT › Praktijken het e-mailadres van de praktijk aan.',
      'Gaat het om iets anders: zeg het in de machinekamer.', 'Socev probeert het elke tien minuten opnieuw; deze kaart gaat vanzelf dicht als het gelukt is.'],
    meting: `${nuKort}: ${rijen.length} mail${rijen.length > 1 ? 's wachten' : ' wacht'}.` });
}
// ── bewaking (wv2793) ────────────────────────────────────────────────────────
// De kosten van een entiteit lopen voor op de begroting (kostenSignaal, en nu nog steeds boven de drempel) en dat is dit jaar nog niet
// gemeld: hooguit één regel op de maandkaart, eenmalig per entiteit per jaar (instelling bewaking_gemeld_<E>_<J>). Verder niets: geen
// melding buiten de app (de stand staat altijd in OVIS POT › Wat nu).
async function bewakingNieuw(io, B, jaar) {
  const r = await B.api.behandel(d1Achtig(io.d1), 'GET', 'bewaking', new URLSearchParams('jaar=' + jaar), null, 'pod maandronde');
  if (!r || r.status !== 200 || !r.body || !r.body.entiteiten) return [];
  const uit = [];
  for (const e of ['POT', 'KM', 'SLOEL']) {
    const x = r.body.entiteiten[e];
    if (x && x.ok && x.signaal && x.nu && x.nu.boven && !x.gemeld) uit.push({ entiteit: e, jaar: Number(jaar), maand: x.signaal.maand, tot_maand: x.tot_maand, tekst: String(x.signaal.tekst) });
  }
  return uit;
}
async function bewakingGemeld(io, lijst, kaartSleutel, nuIso) {
  for (const b of lijst) await io.d1([{ sql: 'insert into instelling (sleutel, waarde, opmerking) values (?,?,?) on conflict(sleutel) do nothing',
    params: [`bewaking_gemeld_${b.entiteit}_${b.jaar}`, JSON.stringify({ maand: b.maand, tot_maand: b.tot_maand, op: nuIso, kaart: kaartSleutel }), 'pod maandronde: kostensignaal op de maandkaart genoemd (wv2793)'] }]);
}
// open nota's van eerder (te laat of deels), per praktijk één regel, voor op de kaart van de nieuwe ronde
async function openVanEerder(io, B, nu) {
  const db = d1Achtig(io.d1);
  const m = (await B.api.behandel(db, 'GET', 'monitor', new URLSearchParams('jaar=' + nu.jaar), null, 'pod maandronde')).body;
  if (!m || !Array.isArray(m.notas) || !m.notas.length) return [];
  const namen = new Map((await io.d1([{ sql: 'select id, coalesce(naam_brief, naam, id) as naam from praktijk', params: [] }]))[0].results.map((x) => [x.id, x.naam]));
  const peil = nu.ymd, uit = [];
  for (const e of ['POT', 'KM', 'SLOEL']) {
    for (const p of [...new Set(m.notas.filter((n) => n.entiteit === e).map((n) => n.praktijk_id))]) {
      const t = B.K.termijnenUitNotas(m.notas, e, p);
      if (!t.length) continue;
      const bet = m.betalingen.filter((b) => b.entiteit === e && b.praktijk_id === p);
      const u = B.K.betaalstatus({ termijnen: t, betalingen: bet, peildatum: peil });
      if (u.samen.achter_verlopen > 1) uit.push(`${ENT_KORT[e]} ${namen.get(p)}: ${B.K.euro(u.samen.achter_verlopen)}`);
    }
  }
  return uit.slice(0, 9);
}
async function kaarten(io, B, nu, nuKort, uitK) {
  uitK = uitK || { fouten: [], bewaking: [] };
  const rijen = (await io.d1([{ sql: `select id, soort, praktijk_id, datum, status, reden, bijgewerkt_op from mail_concept where aangemaakt_op >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-45 days') order by id`, params: [] }]))[0].results;
  const kortGeleden = new Date(Date.parse(nu.iso) - 14 * 864e5).toISOString().slice(0, 19) + 'Z';
  const lijst = await io.kaartLijst();
  const stand = Object.fromEntries((lijst || []).map((p) => [p.sleutel, p.status]));
  const open = (s) => stand[s] === 'open' || stand[s] === 'later';
  // per notadatum: kaart zodra alle praktijkmails klaar zijn (concept of verzonden); dicht als alles verzonden is
  const perDag = {};
  for (const r of rijen.filter((x) => x.soort === 'praktijk')) (perDag[r.datum] ||= []).push(r);
  for (const [datum, rr] of Object.entries(perDag)) {
    const s = `ovis-pot-maand-${datum}`;
    // dicht als er niets meer als concept klaarstaat; het bewijs zegt eerlijk hoeveel er verzonden en hoeveel weggegooid zijn (Codex r1 Z1)
    if (rr.every((r) => r.status === 'verzonden' || r.status === 'concept_weg')) {
      const weg = rr.filter((r) => r.status === 'concept_weg').length;
      if (open(s)) await io.kaartDicht(s, stand[s], `${nuKort}: ${rr.length - weg} van de ${rr.length} mails van ${dm(datum)} verzonden` + (weg ? `; ${weg} concept${weg > 1 ? 'en' : ''} weggegooid zonder te versturen (zie de kaart over niet verstuurde stukken).` : '.'));
      continue;
    }
    if (stand[s]) continue;   // staat er al (of David zette hem dicht)
    if (!rr.every((r) => ['concept', 'verzonden', 'concept_weg'].includes(r.status))) continue;   // nog niet alles klaar
    let openE = [];
    try { openE = await openVanEerder(io, B, nu); } catch (e) { openE = []; }
    let bew = [];
    try { bew = await bewakingNieuw(io, B, Number(String(datum).slice(0, 4))); } catch (e) { bew = []; uitK.fouten.push('bewaking'); }
    await io.kaartZet(kaartKlaar(datum, rr, openE, nuKort, bew));
    if (bew.length) { await bewakingGemeld(io, bew, s, nu.iso); uitK.bewaking.push(...bew.map((b) => b.entiteit)); }
  }
  // problemen: één bundelkaart; een oudere gaat dicht als hij niet meer klopt
  // een weggegooid concept (niet verzonden) is ook iets om te besluiten: hooguit 14 dagen op de kaart
  const prob = rijen.filter((r) => r.status === 'fout' || r.status === 'wacht_op_adres' || (r.status === 'onzeker' && r.reden && /drie keer/.test(r.reden))
    || (r.status === 'concept_weg' && r.soort !== 'exact' && r.bijgewerkt_op >= kortGeleden)).map((r) => (r.status === 'concept_weg' ? Object.assign({}, r, { reden: 'concept weggegooid zonder te versturen (de pdf staat in OVIS POT › Nota\'s)' }) : r));
  const p = prob.length ? kaartProbleem(prob, nuKort) : null;
  for (const s of Object.keys(stand)) if (s.startsWith('ovis-pot-maand-probleem-') && open(s) && (!p || s !== p.sleutel)) await io.kaartDicht(s, stand[s], `${nuKort}: bijgewerkt; zie de nieuwe kaart als er nog iets openstaat.`);
  if (p && !stand[p.sleutel]) await io.kaartZet(p);
}

// ── de tik ───────────────────────────────────────────────────────────────────
async function ronde(io, o) {
  o = o || {};
  const uit = { geclaimd: 0, concept: 0, verzonden: 0, onzeker: 0, fout: 0, wacht_op_adres: 0, opnieuw: 0, gebundeld: 0, notas_gemaakt: 0, fouten: [], gewijzigd: false, bewaking: [] };
  const B = await io.bundel();
  if (!B || !B.api || !B.K || !B.S) throw new Error('bundel ovis-pot ontbreekt');
  const nuD1 = (await io.d1([{ sql: `select ${D1_NU} as nu`, params: [] }]))[0].results[0].nu;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(String(nuD1))) throw new Error('D1 gaf geen tijd');
  const nu = Object.assign({ iso: nuD1 }, amsterdam(nuD1));
  const nuKort = `${dm(nu.ymd)} ${nu.hm}`;
  const inst = Object.fromEntries((await io.d1([{ sql: "select sleutel, waarde from instelling where sleutel in ('overname_vragen','maandronde_uur','ondertekening','verkoopadres_exact_POT','verkoopadres_exact_KM','verkoopadres_exact_SLOEL') or sleutel like 'maandronde_20%'", params: [] }]))[0].results.map((x) => [x.sleutel, x.waarde]));
  const zet = async (id, velden, vanStatus) => {
    const k = Object.keys(velden);
    const r = await io.d1([{ sql: `update mail_concept set ${k.map((x) => x + '=?').join(', ')}, bijgewerkt_op=${D1_NU} where id=? and status=?`, params: [...k.map((x) => velden[x]), id, vanStatus] }]);
    return r[0] && Number(r[0].changes) === 1;
  };
  // 1
  try { await maandNotas(io, B, nu, inst, uit); } catch (e) { uit.fouten.push('notas'); uit.notas = { klaar: false, reden: String(e && e.message || e).slice(0, 160) }; }
  // 2
  await bundel(io, B, nu, inst, uit);
  // 3a bezig > 10 min: de pod viel weg tussen claim en afronding; er kan een concept zijn → onzeker
  const h = await io.d1([{ sql: `update mail_concept set status='onzeker', reden='bezig langer dan 10 minuten (pod herstart of time-out)', bijgewerkt_op=${D1_NU} where status='bezig' and geclaimd_op < strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 minutes')`, params: [] }]);
  if (h[0] && Number(h[0].changes)) { uit.onzeker += Number(h[0].changes); uit.gewijzigd = true; }
  // 3b onzeker zelf oplossen: staat het concept (of de verzonden mail) in Gmail?
  const onz = (await io.d1([{ sql: `select ${KOL} from mail_concept where status='onzeker' and onderwerp is not null order by id limit ${GRENS.onzekerPerTik}`, params: [] }]))[0].results;
  for (const r of onz) {
    let g;
    try { g = await zoekInGmail(io, r, r.aangemaakt_op); } catch (e) { uit.fouten.push('luik'); break; }
    if (g.verzonden) { if (await zet(r.id, { status: 'verzonden', verzonden_op: g.verzonden.datum || nu.iso, thread_id: g.verzonden.thread_id || r.thread_id, reden: 'teruggevonden als verzonden' }, 'onzeker')) { uit.verzonden++; uit.gewijzigd = true; } continue; }
    if (g.concept) { if (await zet(r.id, { status: 'concept', concept_id: g.concept.id || null, thread_id: g.concept.thread_id || null, concept_op: r.concept_op || nu.iso, reden: 'concept teruggevonden in Gmail' }, 'onzeker')) { uit.concept++; uit.gewijzigd = true; } continue; }
    if (Date.parse(r.geclaimd_op || r.aangemaakt_op) > Date.parse(nu.iso) - 3600e3) continue;   // Gmail-index een uur de tijd geven
    if (Number(r.pogingen) + 1 >= GRENS.pogingenMax) { if (await zet(r.id, { status: 'fout', reden: 'drie keer geen bevestiging van Gmail' }, 'onzeker')) { uit.fout++; uit.gewijzigd = true; } }
    else if (await zet(r.id, { status: 'wacht', geclaimd_op: null, pogingen: Number(r.pogingen) + 1, reden: 'niet in Gmail gevonden; opnieuw in de wachtrij' }, 'onzeker')) { uit.opnieuw++; uit.gewijzigd = true; }
  }
  // een onzekere regel zonder onderwerp (viel weg vóór het vastleggen) heeft zeker geen concept: terug
  await io.d1([{ sql: `update mail_concept set status='wacht', geclaimd_op=null, reden='opnieuw (viel weg vóór de aanroep)', bijgewerkt_op=${D1_NU} where status='onzeker' and onderwerp is null`, params: [] }]);
  // 3c klaarzetten
  await klaarzetten(io, B, nu, inst, uit, zet);
  // 4 nameten (elk uur)
  if (o.meten) {
    const te = (await io.d1([{ sql: `select ${KOL} from mail_concept where status='concept' and concept_op >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-${GRENS.meetDagen} days') order by coalesce(gemeten_op,''), id limit ${GRENS.meetPerUur}`, params: [] }]))[0].results;
    for (const r of te) {
      let g;
      try { g = await zoekInGmail(io, r, r.concept_op); } catch (e) { uit.fouten.push('luik'); break; }
      if (g.verzonden) { if (await zet(r.id, { status: 'verzonden', verzonden_op: g.verzonden.datum || nu.iso, gemeten_op: nu.iso }, 'concept')) { uit.verzonden++; uit.gewijzigd = true; } continue; }
      if (!g.concept && Date.parse(r.concept_op) < Date.parse(nu.iso) - GRENS.conceptWegUur * 3600e3) { if (await zet(r.id, { status: 'concept_weg', gemeten_op: nu.iso }, 'concept')) uit.gewijzigd = true; continue; }
      await zet(r.id, { gemeten_op: nu.iso }, 'concept');
    }
  }
  // 5 kaarten (bij een wijziging of op verzoek)
  if (uit.gewijzigd || o.kaarten) { try { await kaarten(io, B, nu, nuKort, uit); } catch (e) { uit.fouten.push('kaarten'); } }
  return uit;
}

module.exports = { ronde, d1Achtig, amsterdam, pdfHoortBij, bestandsnaam, zoekInGmail, kaartKlaar, kaartProbleem, afzenderVan, bewakingNieuw, GRENS, VAN };
