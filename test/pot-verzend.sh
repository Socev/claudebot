#!/usr/bin/env bash
# Toetst pot-verzend.js (wv911): nota's uit de POT-app als Gmail-concept. D1 nagebootst met node:sqlite (schema test/pot-verzend-schema.sql),
# lees-luik, mailluik, pdftotext, vault en Voor jou als nep. Raakt geen pod, D1, Gmail of vault. Gebruik: bash test/pot-verzend.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const V = require(path.resolve('pot-verzend.js'));
let goed = 0, fout = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }

// ── frontmatter en ontvangers ──────────────────────────────────────────────
{
  const f = V.frontmatter('---\ntype: praktijk\nfin_praktijk: [P01, P02, "P03"]\nfacturen_aan: Praktijkmanager@KG.example  # opmerking\nfacturen_cc:\n  - a@b.example\n  - "c@d.example"\n---\nfacturen_aan: niet@hier.example\n');
  toets('frontmatter: inline lijst, scalar met opmerking, blok-lijst, aanhalingstekens', JSON.stringify(f) === JSON.stringify({ fin_praktijk: ['P01', 'P02', 'P03'], facturen_aan: ['Praktijkmanager@KG.example'], facturen_cc: ['a@b.example', 'c@d.example'] }), f);
  toets('frontmatter: waarde die met # begint = leeg', JSON.stringify(V.frontmatter('---\nfin_praktijk: [P09]\nfacturen_aan:   # nog onbekend\n---\n').facturen_aan) === '[]');
  toets('frontmatter: alleen het eerste blok', !V.frontmatter('tekst\n---\nfin_praktijk: [P01]\n---').fin_praktijk);
  const o = V.ontvangers([
    { pad: '10_Zakelijk/HAGRO/Praktijken/Korte Geer.md', tekst: '---\nfin_praktijk: [P01, P02]\nfacturen_aan: pm@kg.example\n---\n' },
    { pad: '10_Zakelijk/HAGRO/Praktijken/Ander.md', tekst: '---\nfin_praktijk: [P02]\nfacturen_aan: anders@kg.example\n---\n' },
    { pad: '10_Zakelijk/HAGRO/Praktijken/Dubbel.md', tekst: '---\nfin_praktijk: [P01]\nfacturen_aan: PM@kg.example\n---\n' },
    { pad: '10_Zakelijk/HAGRO/Praktijken/Leeg.md', tekst: '---\nfin_praktijk: [P04]\n---\n' },
    { pad: '10_Zakelijk/HAGRO/Praktijken/Kapot.md', tekst: '---\nfin_praktijk: [P05]\nfacturen_aan: geen-adres\n---\n' },
    { pad: '10_Zakelijk/Tolgaarde/index.md', tekst: '---\nfin_praktijk: P07\nfacturen_aan: [f@tg.example, g@tg.example]\n---\n' },
    { pad: 'x.md', tekst: '---\nfin_praktijk: [X1]\nfacturen_aan: x@x.example\n---\n' },
  ]);
  toets('ontvangers: zelfde adres op twee pagina\'s mag (hoofdletters gelijk)', o.per.P01 && o.per.P01.aan[0] === 'pm@kg.example' && !o.problemen.P01, o);
  toets('ontvangers: twee pagina\'s met een ander adres = probleem, geen adres', !o.per.P02 && /twee pagina's/.test(o.problemen.P02 || ''), o.problemen);
  toets('ontvangers: pagina zonder facturen_aan = probleem met paginanaam', !o.per.P04 && /Leeg.*facturen_aan/.test(o.problemen.P04 || ''), o.problemen.P04);
  toets('ontvangers: onleesbaar adres = probleem', !o.per.P05 && /onleesbaar/.test(o.problemen.P05 || ''), o.problemen.P05);
  toets('ontvangers: lijst van adressen, index-pagina krijgt mapnaam', o.per.P07 && V.adresTekst(o.per.P07.aan) === 'f@tg.example, g@tg.example' && o.per.P07.naam === 'Tolgaarde', o.per.P07);
  toets('ontvangers: geen P-id = genegeerd', !o.per.X1);
}

// ── PDF-controle ───────────────────────────────────────────────────────────
{
  const nota = { nummer: '2026033', bedrag: 1425, naam_brief: 'Huisartsenpraktijk Korte Geer' };
  toets('PDF hoort bij nota (spaties en nbsp genormaliseerd)', V.pdfHoortBij('Factuurnummer:   2026033\nAan: Huisartsenpraktijk  Korte Geer\nTe betalen bedrag:  €\u00a01.425', nota).ok);
  const m = V.pdfHoortBij('Factuurnummer: 2026034 Huisartsenpraktijk Korte Geer € 1.425', nota);
  toets('PDF van een andere nota → mist nummer', !m.ok && m.mist.includes('nummer 2026033'), m);
  toets('negatief bedrag: absolute waarde zoals op de nota', V.pdfHoortBij('2026040 Huisartsen Lepelaar Door ons aan u terug te betalen: € 158', { nummer: '2026040', bedrag: -158.4, naam_brief: 'Huisartsen Lepelaar' }).ok);
}

// ── de ronde tegen een nagebootste D1 ──────────────────────────────────────
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync('test/pot-verzend-schema.sql', 'utf8'));
db.exec(`insert into entiteit (code, naam) values ('SLOEL','Stichting Leusden op één Lijn');
insert into praktijk (id, naam, naam_brief, tav, email) values ('P01','KG - Leest','Huisartsenpraktijk Korte Geer','t.a.v. M. van der Leest','pm@kg.example'),
 ('P04','Berkenlaan','Huisartsenpraktijk Berkenlaan','t.a.v. praktijkmanager','pm@bk.example'),('P08','Lepelaar','Huisartsen Lepelaar','t.a.v. M. Schoonman','ms@lep.example'),
 ('P09','De Heelkom','Huisartsenpraktijk De Heelkom',null,null);`);
let nr = 2026100;
function nota(praktijk, bedrag, status = 'definitief') { const n = String(nr++); db.prepare("insert into nota (entiteit, jaar, nummer, praktijk_id, datum, soort, periode, titel, regels, bedrag, status) values ('SLOEL',2026,?,?,'2026-11-01','correctie','2026-Q1/Q4','DOORBELASTE KOSTEN','[]',?,?)").run(n, praktijk, bedrag, status); return db.prepare('select * from nota where nummer=?').get(n); }
const naamVan = { P01: 'Huisartsenpraktijk Korte Geer', P04: 'Huisartsenpraktijk Berkenlaan', P08: 'Huisartsen Lepelaar', P09: 'Huisartsenpraktijk De Heelkom' };
function pdfVoor(n, extra) { return Buffer.from(`%PDF-1.3\nFactuurnummer: ${extra && extra.nummer || n.nummer} Aan: ${naamVan[n.praktijk_id]} Te betalen bedrag: € ${new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 0 }).format(Math.abs(Math.round(extra && extra.bedrag != null ? extra.bedrag : n.bedrag)))}\n%%EOF`); }
function rij(n, o = {}) {
  const b = o.pdf || pdfVoor(n);
  const nv = o.niet_voor || new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  db.prepare(`insert into nota_verzending (nota_id, entiteit, nummer, praktijk_id, status, niet_voor, plan_datum, onderwerp, bericht, van, pdf_naam, pdf_b64, pdf_sha256, pdf_bytes, aangevraagd_op, bijgewerkt_op)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(n.id, 'SLOEL', n.nummer, n.praktijk_id, o.status || 'wacht', nv, o.plan || null, 'Factuur SLOEL - Correctie doorbelaste huur 2026', 'Hallo allen,\n\nBij deze ...',
    '"David Schaap" <dokterschaap@gmail.com>', `SLOEL - ${n.nummer} - ${naamVan[n.praktijk_id]}.pdf`, b.toString('base64'), o.sha || crypto.createHash('sha256').update(b).digest('hex'), b.length, nv, nv);
  return db.prepare('select * from nota_verzending where nummer=? order by id desc').get(n.nummer);
}
const status = (id) => db.prepare('select * from nota_verzending where id=?').get(id);
// nep-buitenwereld
const gmail = [];       // { id, thread_id, onderwerp, aan, labels, datum, bestand }
const concepten = [];   // aanroepen van het mailluik
let conceptAntwoord = null;   // functie(body) → { status, j } of throw
let luikStuk = false;
const kaartStand = {}, kaartZet = [], kaartDicht = [], register = [];
let paginas = [
  { pad: '10_Zakelijk/HAGRO/Praktijken/Huisartsenpraktijk Korte Geer.md', tekst: '---\nfin_praktijk: [P01, P02, P03]\nfacturen_aan: pm@kg.example\n---\n' },
  { pad: '10_Zakelijk/HAGRO/Praktijken/Huisartsenpraktijk Lepelaar.md', tekst: '---\nfin_praktijk: [P08]\nfacturen_aan: nieuw@lep.example\n---\n' },
];
const io = {
  d1: async (batch) => {
    db.exec('BEGIN');
    try {
      const uit = batch.map((s) => { const st = db.prepare(s.sql); if (/^\s*select|returning/i.test(s.sql)) return { results: st.all(...(s.params || [])), changes: 0 }; const r = st.run(...(s.params || [])); return { results: [], changes: Number(r.changes) }; });
      db.exec('COMMIT'); return uit;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  luik: async (b) => {
    if (luikStuk) throw new Error('luik stuk');
    const m = /filename:(\S+)/.exec(b.query); const f = m ? m[1] : '';
    return { query: b.query, mails: gmail.filter((x) => x.bestand.includes(f)) };
  },
  concept: async (body) => {
    concepten.push(body);
    if (conceptAntwoord) return conceptAntwoord(body);
    const id = 'r' + crypto.randomBytes(4).toString('hex');
    gmail.push({ id: 'm' + id, thread_id: 't' + id, onderwerp: body.onderwerp, aan: body.aan, labels: ['DRAFT'], datum: new Date().toISOString(), bestand: body.bijlagen[0].naam });
    return { status: 200, j: { ok: true, concept_id: id, thread_id: 't' + id, bijlagen: body.bijlagen.length } };
  },
  pdftotext: async (b) => ({ ok: true, tekst: b.toString('utf8') }),
  vault: () => paginas,
  kaartZet: async (p) => { kaartZet.push(p); kaartStand[p.sleutel] = 'open'; return { ok: true }; },
  kaartLijst: async () => Object.entries(kaartStand).map(([sleutel, status]) => ({ sleutel, status })),
  kaartDicht: async (s, van, bewijs) => { kaartDicht.push({ s, van, bewijs }); kaartStand[s] = 'gedaan'; return { ok: true }; },
  register: (r) => register.push(r),
};
const ronde = (o) => V.ronde(io, o);

(async () => {
  // 1. meteen, adres klopt → concept
  const n1 = nota('P01', 1425); const r1 = rij(n1);
  let u = await ronde();
  let s1 = status(r1.id);
  toets('wacht → concept (één aanroep van het mailluik)', u.concept === 1 && s1.status === 'concept' && concepten.length === 1, { u, s: s1.status });
  const c = concepten[0];
  toets('concept: aan uit de vault, afzender, onderwerp en de PDF-bytes ongewijzigd', c.aan === 'pm@kg.example' && c.van === '"David Schaap" <dokterschaap@gmail.com>' && c.onderwerp === r1.onderwerp && c.bijlagen.length === 1 && c.bijlagen[0].inhoud_base64 === r1.pdf_b64 && c.bijlagen[0].naam === r1.pdf_naam && c.bijlagen[0].mime === 'application/pdf', c && { aan: c.aan, van: c.van });
  toets('na concept: PDF gewist, concept_id/thread_id/aan/bron_pagina gezet', s1.pdf_b64 === null && /^r/.test(s1.concept_id) && /^t/.test(s1.thread_id) && s1.aan === 'pm@kg.example' && /Korte Geer/.test(s1.bron_pagina) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s1.concept_op), s1);
  toets('conceptregister: één regel met hash, geen tekst', register.length === 1 && register[0].concept_id === s1.concept_id && /^[0-9a-f]{64}$/.test(register[0].hash) && !('bericht' in register[0]) && register[0].bijlagen[0] === r1.pdf_naam, register[0]);
  u = await ronde();
  toets('tweede ronde: geen tweede concept', concepten.length === 1 && u.geclaimd === 0, u);

  // 2. gepland in de toekomst → niet aangeraakt
  const n2 = nota('P01', 1397); const r2 = rij(n2, { niet_voor: '2099-11-02T06:00:00Z', plan: '2099-11-02' });
  await ronde();
  toets('niet_voor in de toekomst: blijft wacht', status(r2.id).status === 'wacht' && concepten.length === 1);

  // 3. voorcontrole: concept staat al in Gmail (verloren antwoord) → geen tweede
  const n3 = nota('P01', 1405); const r3 = rij(n3);
  gmail.push({ id: 'mOud', thread_id: 'tOud', onderwerp: r3.onderwerp, aan: 'pm@kg.example', labels: ['DRAFT'], datum: new Date().toISOString(), bestand: r3.pdf_naam });
  await ronde();
  const s3 = status(r3.id);
  toets('voorcontrole: concept stond al in Gmail → status concept, geen aanroep', s3.status === 'concept' && s3.bericht_id === 'mOud' && concepten.length === 1, s3);

  // 4. adres gewijzigd in de vault → wacht_op_adres, geen concept, kaart
  const n4 = nota('P08', -158); const r4 = rij(n4);
  u = await ronde();
  let s4 = status(r4.id);
  toets('vault-adres wijkt af van de app → wacht_op_adres (adres_gewijzigd), geen concept', s4.status === 'wacht_op_adres' && s4.opmerking === 'adres_gewijzigd' && s4.aan === 'nieuw@lep.example' && concepten.length === 1 && s4.pdf_b64, s4);
  toets('adreskaart gezet (titel, geen pad of wv)', kaartZet.some((p) => /^pot-verzend-adres-/.test(p.sleutel) && /factuuradres/.test(p.titel) && !/\.md|10_Zakelijk|wv\d/.test(JSON.stringify(p))), kaartZet.map((p) => p.sleutel));
  u = await ronde();
  toets('binnen 10 minuten niet opnieuw geprobeerd', status(r4.id).status === 'wacht_op_adres' && u.geclaimd === 0, u);
  // David bevestigt in de app (Function zet praktijk.email en status wacht)
  db.prepare("update praktijk set email='nieuw@lep.example' where id='P08'").run();
  db.prepare("update nota_verzending set status='wacht' where id=?").run(r4.id);
  await ronde();
  s4 = status(r4.id);
  toets('na bevestigen: concept aan het nieuwe adres', s4.status === 'concept' && concepten[concepten.length - 1].aan === 'nieuw@lep.example', s4.status);
  toets('adreskaart vanzelf dicht', kaartDicht.some((k) => /^pot-verzend-adres-/.test(k.s)), kaartDicht);

  // 5. geen adres (P04 heeft geen pagina) → wacht_op_adres; na toevoegen + 10 min → concept
  const n5 = nota('P04', 1666); const r5 = rij(n5);
  await ronde();
  let s5 = status(r5.id);
  toets('geen pagina met adres → wacht_op_adres (geen_adres)', s5.status === 'wacht_op_adres' && s5.opmerking === 'geen_adres' && /facturen_aan/.test(s5.fout), s5);
  paginas = paginas.concat([{ pad: '10_Zakelijk/HAGRO/Praktijken/Huisartsenpraktijk Biezenkamp.md', tekst: '---\nfin_praktijk: [P04]\nfacturen_aan: pm@bk.example\n---\n' }]);
  db.prepare("update nota_verzending set bijgewerkt_op=strftime('%Y-%m-%dT%H:%M:%SZ','now','-11 minutes') where id=?").run(r5.id);
  await ronde();
  toets('adres toegevoegd + 10 min → vanzelf concept', status(r5.id).status === 'concept', status(r5.id).status);

  // 6. PDF-controles
  const n6 = nota('P01', 1500); const r6 = rij(n6, { pdf: pdfVoor(n6, { bedrag: 9999 }) });
  const n7 = nota('P01', 1501); const r7 = rij(n7, { sha: '0'.repeat(64) });
  const n8 = nota('P01', 1502); const r8 = rij(n8); db.prepare("update nota set status='vervallen' where id=?").run(n8.id);
  const voor = concepten.length;
  u = await ronde();
  toets('PDF met ander bedrag → fout (hoort niet bij de nota)', status(r6.id).status === 'fout' && /hoort niet bij/.test(status(r6.id).fout) && status(r6.id).pdf_b64 === null, status(r6.id));
  toets('sha256 klopt niet → fout', status(r7.id).status === 'fout' && /sha256/.test(status(r7.id).fout), status(r7.id).fout);
  toets('nota intussen vervallen → fout', status(r8.id).status === 'fout' && /vervallen/.test(status(r8.id).fout), status(r8.id).fout);
  toets('bij fouten geen concept', concepten.length === voor);
  toets('foutkaart gezet', kaartZet.some((p) => /^pot-verzend-fout-/.test(p.sleutel) && /niet klaargezet/.test(p.titel)), kaartZet.map((p) => p.sleutel));

  // 7. mailluik weigert (400) → fout; 502 {ok:false} → fout; geen antwoord → onzeker
  const n9 = nota('P01', 1600); const r9 = rij(n9);
  conceptAntwoord = () => ({ status: 400, j: { ok: false, fout: 'bijlage te groot' } });
  await ronde();
  toets('luik 400 → fout met reden', status(r9.id).status === 'fout' && /bijlage te groot/.test(status(r9.id).fout), status(r9.id));
  const n10 = nota('P01', 1601); const r10 = rij(n10);
  conceptAntwoord = () => ({ status: 502, j: { ok: false, fout: 'Gmail weigerde' } });
  await ronde();
  toets('luik 502 {ok:false} → fout', status(r10.id).status === 'fout', status(r10.id).status);
  const n11 = nota('P01', 1602); const r11 = rij(n11);
  conceptAntwoord = () => { throw new Error('time-out'); };
  await ronde();
  toets('geen antwoord → onzeker (PDF blijft)', status(r11.id).status === 'onzeker' && status(r11.id).pdf_b64, status(r11.id).status);
  const n12 = nota('P01', 1603); const r12 = rij(n12);
  conceptAntwoord = (b) => ({ status: 200, j: { ok: true, concept_id: 'rZonder', thread_id: 'tZ', bijlagen: 0 } });
  await ronde();
  toets('concept zonder PDF → fout met uitleg (gooi weg)', status(r12.id).status === 'fout' && /zonder PDF/.test(status(r12.id).fout), status(r12.id).fout);
  conceptAntwoord = null;

  // 8. onzeker oplossen: gevonden → concept; niet gevonden en > 1 uur → opnieuw wacht
  gmail.push({ id: 'mLaat', thread_id: 'tLaat', onderwerp: r11.onderwerp, aan: 'pm@kg.example', labels: ['DRAFT'], datum: new Date().toISOString(), bestand: r11.pdf_naam });
  await ronde();
  toets('onzeker + concept in Gmail → concept (geen nieuw)', status(r11.id).status === 'concept' && status(r11.id).bericht_id === 'mLaat', status(r11.id));
  const n13 = nota('P01', 1604); const r13 = rij(n13, { status: 'onzeker' });
  db.prepare("update nota_verzending set geclaimd_op=strftime('%Y-%m-%dT%H:%M:%SZ','now','-61 minutes') where id=?").run(r13.id);
  const v13 = concepten.length;
  await ronde();
  toets('onzeker, niet in Gmail, > 1 uur → opnieuw in de wachtrij en meteen klaargezet', status(r13.id).status === 'concept' && concepten.length === v13 + 1 && status(r13.id).pogingen === 1, status(r13.id));

  // 9. bezig > 10 min → onzeker
  const n14 = nota('P01', 1605); const r14 = rij(n14, { status: 'bezig' });
  db.prepare("update nota_verzending set geclaimd_op=strftime('%Y-%m-%dT%H:%M:%SZ','now','-11 minutes') where id=?").run(r14.id);
  luikStuk = true;
  await ronde();
  toets('bezig > 10 min → onzeker (luik stuk: blijft onzeker)', status(r14.id).status === 'onzeker', status(r14.id).status);

  // 10. luik stuk bij de voorcontrole → terug naar wacht, geen aanroep
  const n15 = nota('P01', 1606); const r15 = rij(n15);
  const v15 = concepten.length;
  u = await ronde();
  toets('voorcontrole faalt → terug in de wachtrij, geen concept', status(r15.id).status === 'wacht' && concepten.length === v15 && u.fouten.includes('luik'), { s: status(r15.id).status, u });
  luikStuk = false;
  await ronde();
  toets('luik weer goed → concept', status(r15.id).status === 'concept', status(r15.id).status);

  // 11. gepland: kaart per dag; meten: verzonden → kaart dicht; weg → concept_weg
  const n16 = nota('P01', 1607), n17 = nota('P01', 1608);
  const r16 = rij(n16, { plan: '2026-11-02' }), r17 = rij(n17, { plan: '2026-11-02' });
  await ronde();
  const kg = kaartZet.find((p) => p.sleutel === 'pot-verzend-sloel-2026-11-02');
  toets('geplande dag: één versturen-kaart met beide nummers', kg && /versturen/.test(kg.titel) && kg.deadline === '2026-11-02' && kg.stappen.join(' ').includes(n16.nummer) && kg.stappen.join(' ').includes(n17.nummer), kg);
  for (const r of [r16, r17]) { const g = gmail.find((m) => m.bestand === status(r.id).pdf_naam || m.bestand === r.pdf_naam); g.labels = ['SENT']; }
  u = await ronde({ meten: true });
  toets('meten: verzonden in Gmail → status verzonden', status(r16.id).status === 'verzonden' && status(r17.id).status === 'verzonden' && status(r16.id).verzonden_op, u);
  toets('versturen-kaart vanzelf dicht als alles verzonden is', kaartDicht.some((k) => k.s === 'pot-verzend-sloel-2026-11-02'), kaartDicht.map((k) => k.s));
  const s1oud = status(r1.id);
  gmail.splice(gmail.findIndex((m) => m.bestand === r1.pdf_naam), 1);
  db.prepare("update nota_verzending set concept_op=strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 hours'), gemeten_op=null where id=?").run(r1.id);
  await ronde({ meten: true });
  toets('meten: concept niet meer in Gmail en niet verzonden (> 2 uur) → concept_weg', status(r1.id).status === 'concept_weg', status(r1.id).status);

  // 12. dagplafond
  for (let i = 0; i < 45; i++) { const n = nota('P01', 2000 + i); const r = rij(n); db.prepare("update nota_verzending set status='concept', concept_op=strftime('%Y-%m-%dT%H:%M:%SZ','now'), pdf_b64=null where id=?").run(r.id); }
  const n18 = nota('P01', 1700); const r18 = rij(n18);
  u = await ronde();
  toets('dagplafond bereikt → niets geclaimd, fouten dagplafond', u.geclaimd === 0 && u.fouten.includes('dagplafond') && status(r18.id).status === 'wacht', u);

  // 14. opnieuw klaarzetten (Fable diffreview #2) en verzonden op de draad (#6)
  db.prepare("update nota_verzending set status='geannuleerd' where status in ('wacht','wacht_op_adres','onzeker')").run();
  db.prepare("update nota_verzending set concept_op='2026-01-01T00:00:00Z', gemeten_op=strftime('%Y-%m-%dT%H:%M:%SZ','now') where status='concept'").run();
  const n19 = nota('P01', 1801); const r19 = rij(n19);
  gmail.push({ id: 'mOud19', thread_id: 'tOud19', onderwerp: r19.onderwerp, aan: 'pm@kg.example', labels: ['DRAFT'], datum: new Date().toISOString(), bestand: r19.pdf_naam });
  db.prepare("update nota_verzending set reden='opnieuw: bedrag aangepast' where id=?").run(r19.id);
  const v19 = concepten.length;
  await V.ronde(io, {});
  toets('opnieuw met een oud concept in Gmail → fout "gooi eerst weg", geen aanroep', status(r19.id).status === 'fout' && /ouder concept/.test(status(r19.id).fout) && concepten.length === v19, status(r19.id));
  const n20 = nota('P01', 1802); const r20 = rij(n20);
  gmail.push({ id: 'mVerz20', thread_id: 'tVerz20', onderwerp: r20.onderwerp, aan: 'pm@kg.example', labels: ['SENT'], datum: new Date().toISOString(), bestand: r20.pdf_naam });
  db.prepare("update nota_verzending set reden='opnieuw: nog eens sturen' where id=?").run(r20.id);
  await V.ronde(io, {});
  toets('opnieuw na verzenden → toch een nieuw concept', status(r20.id).status === 'concept' && concepten.length === v19 + 1, status(r20.id).status);
  const n21 = nota('P01', 1803); const r21 = rij(n21);
  await V.ronde(io, {});
  const s21 = status(r21.id);
  const g21 = gmail.find((m) => m.thread_id === s21.thread_id); g21.labels = ['SENT']; g21.onderwerp = 'Aangepast door David'; g21.aan = 'iemand@anders.example';
  db.prepare("update nota_verzending set gemeten_op=null where id=?").run(r21.id);
  await V.ronde(io, { meten: true });
  toets('verzonden herkend op de draad, ook met ander onderwerp/ontvanger', status(r21.id).status === 'verzonden', status(r21.id).status);
  // geplande kaart van een dag zonder concepten meer → dicht (#3)
  kaartStand['pot-verzend-sloel-2026-12-01'] = 'open';
  await V.kaarten(io, '1-1 07:00');
  toets('versturen-kaart van een lege dag gaat dicht', kaartStand['pot-verzend-sloel-2026-12-01'] === 'gedaan', kaartStand['pot-verzend-sloel-2026-12-01']);
  // server.js: in potVzTik mag `nu` niet overschaduwd worden (Fable diffreview #1)
  const sj = fs.readFileSync('server.js', 'utf8'); const i = sj.indexOf('async function potVzTik()'); const tik = sj.slice(i, sj.indexOf('\nsetInterval(', i));
  toets('potVzTik overschaduwt nu() niet', i > 0 && !/\b(const|let|var)\s+nu\b/.test(tik) && /schrijfLog\(nu\(\)/.test(tik));

  // 15. wv1763: adresbron (OVIS plek 4 fase 2) — register per schakelaar, nooit terug naar de dossierpagina
  {
    db.exec("insert or ignore into praktijk (id, naam, naam_brief, email) values ('P90','PROEF','PROEF Socev','reg@david.example')");
    naamVan.P90 = 'PROEF Socev';
    // de dossierpagina noemt een ánder adres voor P90: als dat ooit in een concept belandt, is er teruggevallen
    paginas = paginas.concat([{ pad: '10_Zakelijk/HAGRO/Praktijken/PROEF.md', tekst: '---\nfin_praktijk: [P90]\nfacturen_aan: oud@dossier.example\n---\n' }]);
    let regAntw = () => ({ per: {}, problemen: { P90: 'het factuuradres van PROEF Socev is nog niet vastgezet (kaart in Voor jou, met je vingerafdruk)' }, onleesbaar: 0 });
    io.registerAdressen = async () => regAntw();
    const terugTien = (id) => db.prepare("update nota_verzending set bijgewerkt_op=strftime('%Y-%m-%dT%H:%M:%SZ','now','-11 minutes') where id=?").run(id);
    const zonderAdresKaarten = () => kaartZet.filter((p) => /^pot-verzend-adres-/.test(p.sleutel));
    // a. proef, geen vastgezet adres → wacht_op_adres met de reden van het register; kaart wijst naar de vastzetkaart, niet naar Obsidian
    const p1 = rij(nota('P90', 10)); const vc = concepten.length, vk = zonderAdresKaarten().length;
    let u = await V.ronde(io, { adresbron: 'proef' });
    toets('15 proef: geen vastgezet adres → wacht_op_adres met reden uit het register, geen concept (geen terugval op de dossierpagina)', status(p1.id).status === 'wacht_op_adres' && status(p1.id).opmerking === 'geen_adres' && /nog niet vastgezet/.test(status(p1.id).fout) && concepten.length === vc, { s: status(p1.id), u });
    const ka = zonderAdresKaarten().slice(vk).pop();
    toets('15 adreskaart: stap "druk Ja met je vingerafdruk", zeg-tegen-Socev, geen Obsidian/pad', ka && /vingerafdruk/.test(ka.stappen.join(' ')) && /zeg tegen Socev/.test(ka.stappen.join(' ')) && !/Obsidian|facturen_aan|\.md|10_Zakelijk|wv\d/.test(JSON.stringify(ka)) && ka.titel.length <= 90 && ka.waarom.length <= 400, ka);
    // b. register onbereikbaar → rij terug op wacht, fout adresregister, geen concept en geen kaart
    regAntw = () => { throw new Error('supabase weg'); };
    terugTien(p1.id); const vk2 = kaartZet.length;
    u = await V.ronde(io, { adresbron: 'proef' });
    toets('15 register onbereikbaar → wacht (opnieuw), fout adresregister, geen concept, geen terugval', status(p1.id).status === 'wacht' && u.fouten.includes('adresregister') && concepten.length === vc, { s: status(p1.id).status, u });
    u = await V.ronde(io, { adresbron: 'proef', kaarten: true });
    toets('15 register onbereikbaar → elke minuut opnieuw, zonder adreskaart (ook als de kaarten worden bijgewerkt)', status(p1.id).status === 'wacht' && kaartZet.slice(vk2).every((p) => !/^pot-verzend-adres-/.test(p.sleutel)), kaartZet.slice(vk2).map((p) => p.sleutel));
    // c. echte praktijk in proef: gewoon van de dossierpagina, ook als het register weg is
    const e1 = rij(nota('P01', 11));
    await V.ronde(io, { adresbron: 'proef' });
    toets('15 proef: echte praktijk P01 nog via de dossierpagina, ook met register weg', status(e1.id).status === 'concept' && concepten[concepten.length - 1].aan === 'pm@kg.example', status(e1.id).status);
    // d. adres vastgezet → concept aan het registeradres (niet het dossieradres), bron_pagina = stampagina, geen cc
    regAntw = () => ({ per: { P90: { aan: ['reg@david.example'], cc: [], pagina: '10_Zakelijk/_Gedeeld/Relaties/Proefpraktijk Socev.md', naam: 'Proefpraktijk Socev', knoop: 'org:proef' } }, problemen: {}, onleesbaar: 0 });
    await V.ronde(io, { adresbron: 'proef' });
    const c90 = concepten[concepten.length - 1];
    toets('15 vastgezet adres = POT-app → concept aan het registeradres, bron = stampagina, geen cc', status(p1.id).status === 'concept' && c90.aan === 'reg@david.example' && !('cc' in c90) && /Proefpraktijk Socev/.test(status(p1.id).bron_pagina), { s: status(p1.id).status, c90 });
    // e. registeradres ≠ POT-app → adres_gewijzigd (Davids "adres klopt" blijft tweede slot)
    const p2 = rij(nota('P90', 12));
    regAntw = () => ({ per: { P90: { aan: ['nieuw@david.example'], cc: [], pagina: 'x', naam: 'Proefpraktijk Socev', knoop: 'org:proef' } }, problemen: {}, onleesbaar: 0 });
    await V.ronde(io, { adresbron: 'proef' });
    toets('15 registeradres ≠ POT-app → wacht_op_adres adres_gewijzigd', status(p2.id).status === 'wacht_op_adres' && status(p2.id).opmerking === 'adres_gewijzigd' && status(p2.id).aan === 'nieuw@david.example', status(p2.id));
    // f. register: een postadres of cc in het register = geen adres
    regAntw = () => ({ per: { P90: { aan: ['postbus', '1'], cc: [], pagina: 'x', naam: 'Proefpraktijk Socev', knoop: 'org:proef' } }, problemen: {}, onleesbaar: 0 });
    terugTien(p2.id);
    await V.ronde(io, { adresbron: 'proef' });
    toets('15 register met een postadres → geen adres (geen mailadres)', status(p2.id).status === 'wacht_op_adres' && status(p2.id).opmerking === 'geen_adres' && /geen \(enkel\) mailadres/.test(status(p2.id).fout), status(p2.id));
    // g. register: een stampagina niet te lezen en P90 zonder uitslag → niet gemeten (wacht), geen "geen stamkaart"
    regAntw = () => ({ per: {}, problemen: {}, onleesbaar: 1 });
    terugTien(p2.id);
    await V.ronde(io, { adresbron: 'proef' });
    u = await V.ronde(io, { adresbron: 'proef' });
    toets('15 stampagina onleesbaar → niet gemeten: wacht, geen wacht_op_adres, fout adresregister (box na 5 tikken)', status(p2.id).status === 'wacht' && u.fouten.includes('adresregister'), { s: status(p2.id), u });
    // h. register: geen claim en niets onleesbaar → "geen stamkaart"
    regAntw = () => ({ per: {}, problemen: {}, onleesbaar: 0 });
    await V.ronde(io, { adresbron: 'proef' });
    toets('15 geen stampagina die P90 noemt → wacht_op_adres "geen stamkaart"', status(p2.id).status === 'wacht_op_adres' && /geen stamkaart/.test(status(p2.id).fout), status(p2.id));
    // i. register voor alles: P01 heeft een dossieradres maar geen vastgezet adres → wacht, nooit het dossieradres
    const e2 = rij(nota('P01', 13)); const vc3 = concepten.length;
    regAntw = () => ({ per: {}, problemen: { P01: 'het factuuradres van Huisartsenpraktijk Korte Geer is nog niet vastgezet (kaart in Voor jou, met je vingerafdruk)' }, onleesbaar: 0 });
    let vaultGelezen = 0; const vaultOud = io.vault; io.vault = () => { vaultGelezen++; return vaultOud(); };
    await V.ronde(io, { adresbron: 'register' });
    toets('15 register: P01 zonder vastgezet adres → wacht_op_adres, dossierpagina niet gelezen', status(e2.id).status === 'wacht_op_adres' && concepten.length === vc3 && vaultGelezen === 0, { s: status(e2.id).status, vaultGelezen });
    // i2. register voor alles mét vastgezet adres → concept aan het registeradres; de dossierpagina wordt niet gelezen (Fable KAN 9)
    regAntw = () => ({ per: { P01: { aan: ['pm@kg.example'], cc: [], pagina: '10_Zakelijk/_Gedeeld/Relaties/Huisartsenpraktijk Korte Geer.md', naam: 'Huisartsenpraktijk Korte Geer', knoop: 'org:kg' } }, problemen: {}, onleesbaar: 0 });
    terugTien(e2.id);
    await V.ronde(io, { adresbron: 'register' });
    toets('15 register: vastgezet adres → concept aan het registeradres, bron = stampagina, dossierpagina niet gelezen', status(e2.id).status === 'concept' && concepten.length === vc3 + 1 && concepten[concepten.length - 1].aan === 'pm@kg.example' && /_Gedeeld\/Relaties/.test(status(e2.id).bron_pagina) && vaultGelezen === 0, { s: status(e2.id), vaultGelezen });
    io.vault = vaultOud;
    // KAN 6: adreskaart krijgt een andere sleutel als de rijen via het register lopen
    const kr1 = V.kaartAdres([{ id: 1, praktijk_id: 'P01', praktijk: 'KG', reden: 'x', opmerking: 'geen_adres', deadline: '2026-11-02' }], 'x', 'dossier'), kr2 = V.kaartAdres([{ id: 1, praktijk_id: 'P01', praktijk: 'KG', reden: 'x', opmerking: 'geen_adres', deadline: '2026-11-02' }], 'x', 'register');
    toets('15 adreskaart: andere sleutel na een wissel naar het register, vastzetstap alleen dan', kr1.sleutel !== kr2.sleutel && !/vingerafdruk/.test(kr1.stappen.join(' ')) && /vingerafdruk/.test(kr2.stappen.join(' ')), [kr1.sleutel, kr2.sleutel]);
    // j. onbekende schakelaarwaarde = dossier
    const ev = await V.adressen(io, 'onzin', { fouten: [] });
    toets('15 onbekende adresbron = dossier', ev.bron === 'dossier' && ev.bronVan('P90') === 'dossier' && ev.per.P01 && ev.per.P01.aan[0] === 'pm@kg.example', ev.bron);
    toets('15 bronVan: kaarten = proef (alleen P9x uit het register)', V.bronVan('kaarten', 'P90') === 'register' && V.bronVan('kaarten', 'P01') === 'dossier' && V.bronVan('register', 'P01') === 'register' && V.bronVan('dossier', 'P90') === 'dossier');
    db.prepare("update nota_verzending set status='geannuleerd' where status in ('wacht','wacht_op_adres')").run();
    delete io.registerAdressen;
  }

  // kaartgrenzen van de databank (titel ≤ 90, waarom ≤ 400, meting ≤ 300)
  const lang = Array.from({ length: 30 }, (_, i) => ({ id: i, nummer: '2026' + (500 + i), fout: 'de PDF hoort niet bij deze nota (mist nummer, bedrag, praktijknaam)', deadline: '2026-11-02', praktijk: 'Huisartsenpraktijk Korte Geer', reden: 'op de pagina Huisartsenpraktijk Korte Geer staat nog geen factuuradres (veld facturen_aan)', opmerking: 'geen_adres' }));
  const ka = [V.kaartFout(lang, '1-1 07:00'), V.kaartAdres(lang, '1-1 07:00'), V.kaartGepland('SLOEL', '2026-11-02', lang.map((x) => ({ ...x, onderwerp: 'Factuur SLOEL - Correctie doorbelaste huur 2026' })), '1-1 07:00')];
  toets('kaarten blijven binnen de databankgrenzen', ka.every((p) => p.titel.length >= 3 && p.titel.length <= 90 && p.waarom.length <= 400 && p.meting.length <= 300 && p.stappen.length <= 12 && /^[a-z0-9][a-z0-9-]{1,60}$/.test(p.sleutel)), ka.map((p) => [p.titel.length, p.waarom.length, p.meting.length]));

  // 13. mailbody
  const mb = V.mailBody({ onderwerp: 'O', bericht: 'B', van: null, pdf_naam: 'x.pdf', pdf_b64: 'QQ==' }, { aan: ['a@b.example', 'c@d.example'], cc: [] });
  toets('mailbody: meerdere adressen komma-gescheiden, geen lege cc of van', mb.aan === 'a@b.example, c@d.example' && !('cc' in mb) && !('van' in mb) && !('secret' in mb), mb);

  console.log(`\n${goed} groen, ${fout} rood`);
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
