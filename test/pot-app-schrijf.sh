#!/usr/bin/env bash
# Toetst de schrijvende routes van OVIS POT (wv1933, fase P3 + P4; bouwplan vault "01_Ontwikkeling/OVIS POT - POT POH-GGZ-app in de
# Socev-app (bouwplan 28-10-2026).md"): planning, vaststellen, correctie, patiënten, nota-status, klaarzetten, annuleren en adres in
# pot-app.js, de SQL op nota_verzending in pot-verzend.js, de schakelaar van de overstap, de kaartteksten en de server.js-kant
# (invoerslot, verse vingerafdruk bij adres, auditregel). D1 `fin` nagebootst met node:sqlite (schema test/pot-app-schema.sql), elke
# schrijfbatch één transactie (zoals gemeten op D1 op 29-10-2026). VERZONNEN gegevens: claudebot is openbaar. De verzendtoetsen zijn
# overgezet uit test/pot-verzend.test.mjs van de oude Function (werk.socev.dev/pot, 55 toetsen); de gelijkheid met de oude Function
# is buiten CI gemeten (bouwplan § Log). Raakt geen netwerk, geen pod, geen D1. Gebruik: bash test/pot-app-schrijf.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const P = require(path.resolve('pot-app.js'));
const V = require(path.resolve('pot-verzend.js'));
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }

const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
db.exec(fs.readFileSync('test/pot-app-schema.sql', 'utf8'));
const ins = (t, o) => db.prepare(`insert into ${t} (${Object.keys(o).join(',')}) values (${Object.keys(o).map(() => '?').join(',')})`).run(...Object.values(o)).lastInsertRowid;
for (const code of ['POT', 'KM', 'SLOEL', 'PROEF']) ins('entiteit', { code, naam: 'Toets ' + code, naam_document: 'TOETS ' + code, iban: 'NL00TEST0000000' + String(code.length).padStart(3, '0') });
for (const [id, naam, brief, tav] of [['P01', 'Praktijk Aap', 'Huisartsenpraktijk Aap', 't.a.v. A. Proef'], ['P02', 'Praktijk Noot', 'Huisartsen Noot', 't.a.v. B. Proef'],
  ['P03', 'Praktijk Mies', 'Huisartsen Mies', null], ['P08', 'Praktijk Lepel', 'Huisartsen Lepel', 't.a.v. C. Proef'], ['P91', 'Proefpraktijk', 'Proefpraktijk', null]])
  ins('praktijk', { id, naam, naam_brief: brief, tav, email: id.toLowerCase() + '@voorbeeld.test' });
for (const p of ['P01', 'P02', 'P03']) ins('deelname', { entiteit: 'SLOEL', praktijk_id: p, geldig_van: '2020-01-01' });
for (const [p, a, b] of [['P01', 3000, 3100], ['P02', 2000, 2100], ['P03', 1000, 1000]]) { ins('praktijk_patienten', { praktijk_id: p, peildatum: '2025-01-01', aantal: a, status: 'toets' }); ins('praktijk_patienten', { praktijk_id: p, peildatum: '2026-01-01', aantal: b, status: 'toets' }); }
const nota = (o) => ins('nota', { entiteit: 'SLOEL', jaar: 2026, datum: '2026-11-01', soort: 'correctie', periode: '2026-Q1/Q4', titel: 'DOORBELASTE KOSTEN', regels: '[]', status: 'definitief', ...o });
nota({ nummer: '2026033', praktijk_id: 'P01', bedrag: 1425 });
nota({ nummer: '2026040', praktijk_id: 'P08', bedrag: -158 });
nota({ nummer: '2026001', praktijk_id: 'P01', datum: '2026-01-20', soort: 'voorschot', periode: '2026-Q1', bedrag: 1500, status: 'vervallen' });
nota({ nummer: '2026099', praktijk_id: 'P01', datum: '2026-01-20', soort: 'voorschot', periode: '2026-Q1', bedrag: 1500, status: 'concept' });
nota({ nummer: '2026002', praktijk_id: 'P08', datum: '2026-01-20', soort: 'voorschot', periode: '2026-Q1', bedrag: 900 });
nota({ entiteit: 'PROEF', nummer: '9990001', praktijk_id: 'P91', bedrag: 1 });

// io: lezen = SELECT-batch; schrijven = één transactie (BEGIN/COMMIT, ROLLBACK bij een fout: zoals D1 gemeten op 29-10)
let open = true, schrijfLog = [], leesRondgangen = 0;
const io = {
  d1: async (batch) => {
    leesRondgangen++;
    for (const x of batch) if (!/^\s*select\b/i.test(x.sql)) throw new Error('toets: niet-SELECT via io.d1: ' + x.sql.slice(0, 40));
    return batch.map((x) => ({ results: db.prepare(x.sql).all(...x.params) }));
  },
  schrijf: async (batch) => {
    schrijfLog.push(batch.length);
    db.exec('BEGIN');
    try {
      const uit = batch.map((x) => { const st = db.prepare(x.sql); if (/^\s*select/i.test(x.sql)) return { results: st.all(...x.params), changes: 0 }; const r = st.run(...x.params); return { results: [], changes: Number(r.changes) }; });
      db.exec('COMMIT'); return uit;
    } catch (e) { db.exec('ROLLBACK'); throw new Error('D1 http 400: ' + e.message); }
  },
  schrijvenOpen: () => open,
};
const app = P.maak(io);
const vraag = async (pad, body) => { const r = await app.schrijf(pad, body === undefined ? {} : body); return { s: r.status, j: r.j, r }; };
const lees = (pad) => app.lees(pad).then((r) => ({ s: r.status, j: r.j }));
const id = (nr) => db.prepare('select id from nota where nummer=?').get(nr).id;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pdf = (tekst = 'nota') => { const b = Buffer.from('%PDF-1.3\n' + tekst + '\n%%EOF'); return { pdf_b64: b.toString('base64'), pdf_sha256: sha(b) }; };
const rijen = (nr) => db.prepare('select * from nota_verzending where nummer=? order by id').all(nr);
const lokaal = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date());
const plus = (d) => new Date(Date.parse(lokaal + 'T12:00:00Z') + d * 864e5).toISOString().slice(0, 10);
const dag = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();

(async () => {
  // ── padvorm ──
  const o = P.ontleedSchrijf;
  toets('ontleedSchrijf: de 8 routes', ['planning', 'planning/vaststellen', 'correctie', 'patienten', 'verzend'].every((p) => o(p) && o(p).route === p)
    && o('nota/12/status').route === 'nota/status' && o('nota/12/status').id === 12 && o('verzending/3/annuleer').route === 'verzending/annuleer' && o('verzending/3/adres').id === 3);
  for (const p of ['', 'nota/0/status', 'nota/x/status', 'verzending/3', 'verzending/3/weg', 'planning/x', 'overzicht', 'verzend/voorbeeld/1', 'nota/1234567890/status'])
    toets('ontleedSchrijf weigert "' + p + '"', o(p) === null);
  toets('SCHRIJF_ROUTES: 8', P.SCHRIJF_ROUTES.length === 8);
  toets('onbekende schrijfroute → 404 zonder D1', (await vraag('overzicht')).s === 404);

  // ── voorbeeld (lezen, zelfde teksten als de Function) ──
  {
    const r = await lees('verzend/voorbeeld/' + id('2026033'));
    toets('voorbeeld: correctie-onderwerp', r.s === 200 && r.j.onderwerp === 'Factuur SLOEL - Correctie doorbelaste huur 2026', r.j);
    toets('voorbeeld: bestandsnaam als notaBestand', r.j.pdf_naam === 'SLOEL - 2026033 - Huisartsenpraktijk Aap - t.a.v. A. Proef.pdf', r.j.pdf_naam);
    toets('voorbeeld: afzender dokterschaap', r.j.van === '"David Schaap" <dokterschaap@gmail.com>', r.j.van);
    const v = await lees('verzend/voorbeeld/' + id('2026002'));
    toets('voorbeeld: voorschot = Davids eigen tekst', v.j.onderwerp === 'Factuur SLOEL - Doorbelaste huur' && /wederom een factuur voor de doorbelaste huur - graag betaling per ommegaande/.test(v.j.bericht), v.j);
    const c = await lees('verzend/voorbeeld/' + id('2026040'));
    toets('voorbeeld: negatief = creditnota, geen betaalverzoek', /^Creditnota SLOEL/.test(c.j.onderwerp) && !/betaling per ommegaande/.test(c.j.bericht) && /maak ik/.test(c.j.bericht), c.j);
  }
  // ── klaarzetten ──
  {
    const p = pdf('2026033');
    const r = await vraag('verzend', { nota_id: id('2026033'), ...p });
    toets('meteen: 200 + rij wacht', r.s === 200 && r.j.verzending && r.j.verzending.status === 'wacht', r.j);
    toets('klaarzetten = 1 schrijfbatch van 1 opdracht', r.r.schrijfacties === 1 && schrijfLog[schrijfLog.length - 1] === 1, schrijfLog);
    const rij = rijen('2026033')[0];
    toets('meteen: niet_voor ≈ nu uit D1 (UTC, zonder ms), plan leeg', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(rij.niet_voor) && Math.abs(Date.parse(rij.niet_voor) - Date.now()) < 5000 && rij.plan_datum === null, rij.niet_voor);
    toets('PDF en sha in de rij, bestandsnaam en tekst van de server', rij.pdf_b64 === p.pdf_b64 && rij.pdf_sha256 === p.pdf_sha256 && /^SLOEL - 2026033 - /.test(rij.pdf_naam) && rij.onderwerp === 'Factuur SLOEL - Correctie doorbelaste huur 2026');
    toets('antwoord zonder PDF en mailtekst', !('pdf_b64' in r.j.verzending) && !('bericht' in r.j.verzending));
    const r2 = await vraag('verzend', { nota_id: id('2026033'), ...pdf('anders') });
    toets('nog eens zonder reden: bestaande rij terug (al), geen tweede', r2.s === 200 && r2.j.al === true && rijen('2026033').length === 1, r2.j);
    const r3 = await vraag('verzend', { nota_id: id('2026033'), ...pdf('x'), reden: 'kort' });
    toets('opnieuw met te korte reden → 400', r3.s === 400 && rijen('2026033').length === 1, r3.j);
    const r4 = await vraag('verzend', { nota_id: id('2026033'), ...pdf('v2'), reden: 'bedrag aangepast' });
    const rr = rijen('2026033');
    toets('opnieuw met reden: oude vervangen (in dezelfde transactie), nieuwe wacht', r4.s === 200 && rr.length === 2 && rr[0].status === 'vervangen' && rr[0].pdf_b64 === null && rr[1].status === 'wacht' && /opnieuw: bedrag aangepast/.test(rr[1].reden) && schrijfLog[schrijfLog.length - 1] === 2, rr.map((x) => x.status));
    db.prepare("update nota_verzending set status='bezig' where id=?").run(rr[1].id);
    const r5 = await vraag('verzend', { nota_id: id('2026033'), ...pdf('v3'), reden: 'nog een keer' });
    toets('opnieuw terwijl de pod bezig is → 409', r5.s === 409 && rijen('2026033').length === 2, r5.j);
    db.prepare("update nota_verzending set status='concept' where id=?").run(rr[1].id);
  }
  {
    const r = await vraag('verzend', { nota_id: id('2026001'), ...pdf() });
    toets('vervallen nota → 409', r.s === 409 && rijen('2026001').length === 0, r.j);
    const r2 = await vraag('verzend', { nota_id: id('2026099'), ...pdf() });
    toets('concept-nota → 409', r2.s === 409, r2.j);
    const r3 = await vraag('verzend', { nota_id: 99999, ...pdf() });
    toets('onbekende nota → 404', r3.s === 404, r3.j);
    const p = pdf(); p.pdf_sha256 = '0'.repeat(64);
    const r4 = await vraag('verzend', { nota_id: id('2026040'), ...p });
    toets('sha klopt niet → 400', r4.s === 400 && rijen('2026040').length === 0, r4.j);
    const nep = Buffer.from('<html>geen pdf</html>');
    const r5 = await vraag('verzend', { nota_id: id('2026040'), pdf_b64: nep.toString('base64'), pdf_sha256: sha(nep) });
    toets('geen PDF → 400', r5.s === 400 && r5.j.fout === 'pdf_b64 is geen PDF', r5.j);
    const groot = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(46 * 1024, 65)]);
    const r6 = await vraag('verzend', { nota_id: id('2026040'), pdf_b64: groot.toString('base64'), pdf_sha256: sha(groot) });
    toets('PDF > 45 kB → 413 (doorgeefluik ≤ 64 kB)', r6.s === 413, r6.j);
    const r7 = await vraag('verzend', { nota_id: id('2026040'), pdf_b64: 'A'.repeat(70000), pdf_sha256: 'x' });
    toets('base64 > 45 kB → 413', r7.s === 413, r7.j);
    const r8 = await vraag('verzend', { nota_id: id('2026040'), pdf_b64: '%%%', pdf_sha256: 'x' });
    toets('kapotte base64 → 400', r8.s === 400 && r8.j.fout === 'pdf_b64 ongeldig', r8.j);
    const r9 = await vraag('verzend', { nota_id: id('2026040'), pdf_b64: 'JVBERi0xLjM=x', pdf_sha256: 'x' });
    toets('base64 met rommel achteraan → 400', r9.s === 400, r9.j);
    toets('na al deze weigeringen geen schrijfactie', [r, r2, r3, r4, r5, r6, r7, r8, r9].every((x) => x.r.schrijfacties === 0));
  }
  // ── verzenddatum ──
  {
    const r0 = await vraag('verzend', { nota_id: id('2026040'), ...pdf(), plan_datum: plus(-1) });
    toets('verzenddatum in het verleden → 400', r0.s === 400, r0.j);
    const r1 = await vraag('verzend', { nota_id: id('2026040'), ...pdf(), plan_datum: plus(400) });
    toets('verzenddatum > 1 jaar → 400', r1.s === 400, r1.j);
    const winter = plus(1) <= '2026-11-02' ? '2026-11-02' : null, zomer = plus(1) <= '2027-06-01' ? '2027-06-01' : null;
    if (winter) {
      const r2 = await vraag('verzend', { nota_id: id('2026040'), ...pdf(), plan_datum: winter });
      const rij = rijen('2026040')[0];
      toets('2-11-2026 (wintertijd) → 07:00 = 06:00Z', r2.s === 200 && rij.niet_voor === '2026-11-02T06:00:00Z' && rij.plan_datum === '2026-11-02', rij && rij.niet_voor);
    } else { await vraag('verzend', { nota_id: id('2026040'), ...pdf(), plan_datum: plus(10) }); toets('(2-11-2026 voorbij: winterdatum niet getoetst)', true); }
    if (zomer) {
      const r3 = await vraag('verzend', { nota_id: id('2026002'), ...pdf(), plan_datum: zomer });
      const rij3 = rijen('2026002')[0];
      toets('1-6-2027 (zomertijd) → 07:00 = 05:00Z', r3.s === 200 && rij3.niet_voor === '2027-06-01T05:00:00Z', rij3 && rij3.niet_voor);
    } else toets('(1-6-2027 voorbij: zomerdatum niet getoetst)', true);
    const r4 = await vraag('verzend', { nota_id: id('2026040'), ...pdf(), plan_datum: '2026-13-01' });
    toets('onzin-datum → 400 (of al: bestaande rij)', r4.s === 400 || r4.j.al === true, r4.j);
  }
  // ── annuleren ──
  {
    const rij = rijen('2026040')[0];
    const r = await vraag(`verzending/${rij.id}/annuleer`);
    toets('annuleer wacht → geannuleerd, PDF weg', r.s === 200 && r.j.verzending.status === 'geannuleerd' && rijen('2026040')[0].pdf_b64 === null, r.j);
    const r2 = await vraag(`verzending/${rij.id}/annuleer`);
    toets('nog eens annuleren → 409', r2.s === 409, r2.j);
    const c = rijen('2026033').find((x) => x.status === 'concept');
    const r3 = await vraag(`verzending/${c.id}/annuleer`);
    toets('concept annuleren → 409 (staat al in Gmail)', r3.s === 409, r3.j);
    toets('annuleren onbekende verzending → 409', (await vraag('verzending/99999/annuleer')).s === 409);
    const r4 = await vraag('verzend', { nota_id: id('2026040'), ...pdf() });
    toets('na annuleren opnieuw klaarzetten mag zonder reden', r4.s === 200 && !r4.j.al, r4.j);
  }
  // ── adres bevestigen ──
  {
    const rij = rijen('2026040').find((x) => x.status === 'wacht');
    db.prepare("update nota_verzending set status='wacht_op_adres', aan='nieuw@lepel.test', opmerking='adres_gewijzigd' where id=?").run(rij.id);
    const r0 = await vraag(`verzending/${rij.id}/adres`, { aan: 'ander@lepel.test' });
    toets('adres dat niet klopt met de rij → 409', r0.s === 409, r0.j);
    const r = await vraag(`verzending/${rij.id}/adres`, { aan: 'Nieuw@lepel.test' });
    const p = db.prepare("select email from praktijk where id='P08'").get();
    toets('adres bevestigd: praktijk.email bijgewerkt, rij weer wacht (één transactie)', r.s === 200 && p.email === 'nieuw@lepel.test' && r.j.verzending.status === 'wacht' && schrijfLog[schrijfLog.length - 1] === 2, { r: r.j, p });
    const r2 = await vraag(`verzending/${rij.id}/adres`, { aan: 'nieuw@lepel.test' });
    toets('nog eens bevestigen → 409', r2.s === 409, r2.j);
    toets('adres van een onbekende verzending → 404', (await vraag('verzending/99999/adres', { aan: 'x@y.test' })).s === 404);
  }
  // ── lijst ──
  {
    const r = await lees('notas/sloel/2026');
    const n = r.j && r.j.notas.find((x) => x.nummer === '2026033');
    toets('notas: laatste verzending per nota, zonder PDF en tekst', r.s === 200 && n.verzending && n.verzending.status === 'concept' && !('pdf_b64' in n.verzending) && !('bericht' in n.verzending), n && n.verzending);
    const z = r.j.notas.find((x) => x.nummer === '2026099');
    toets('notas: nota zonder verzending = null', z && z.verzending === null);
  }
  // ── wv921: op die dag zelf versturen ──
  {
    nota({ nummer: '2026201', praktijk_id: 'P01', bedrag: 1000 });
    nota({ nummer: '2026202', praktijk_id: 'P08', bedrag: 2000 });
    let werk = 2; while (!V.werkdag(plus(werk))) werk++;
    let za = 1; while (dag(plus(za)) !== 6) za++;
    const r0 = await vraag('verzend', { nota_id: id('2026201'), ...pdf(), plan_datum: plus(werk), auto: true });
    toets('auto zonder hartslag van de pod → 409 "staat uit"', r0.s === 409 && /staat nu uit/.test(r0.j.fout), r0.j);
    db.prepare("insert into pot_pod_stand (sleutel, waarde, op) values ('auto','aan',?)").run(new Date(Date.now() - 20 * 60000).toISOString());
    const r1 = await vraag('verzend', { nota_id: id('2026201'), ...pdf(), plan_datum: plus(werk), auto: true });
    toets('auto met een oude hartslag (20 min) → 409', r1.s === 409, r1.j);
    db.prepare("update pot_pod_stand set op=? where sleutel='auto'").run(new Date().toISOString());
    const vb = await lees('verzend/voorbeeld/' + id('2026201'));
    toets('voorbeeld meldt auto.kan bij een verse hartslag', vb.s === 200 && vb.j.auto && vb.j.auto.kan === true, vb.j.auto);
    const r2 = await vraag('verzend', { nota_id: id('2026201'), ...pdf(), plan_datum: plus(za), auto: true });
    toets('auto op een zaterdag → 400 (weekend/feestdag aan de voorkant geweigerd)', r2.s === 400 && /werkdag/.test(r2.j.fout), r2.j);
    const r3 = await vraag('verzend', { nota_id: id('2026201'), ...pdf(), plan_datum: lokaal, auto: true });
    toets('auto voor vandaag → 400 (vanaf morgen)', r3.s === 400 && /vanaf morgen/.test(r3.j.fout), r3.j);
    const r3b = await vraag('verzend', { nota_id: id('2026201'), ...pdf(), auto: true });
    toets('auto zonder datum → 400', r3b.s === 400, r3b.j);
    let ver = 50; while ([0, 6].includes(dag(plus(ver)))) ver++;
    const r3c = await vraag('verzend', { nota_id: id('2026201'), ...pdf(), plan_datum: plus(ver), auto: true });
    toets('auto meer dan 45 dagen vooruit → 400', r3c.s === 400 && /45 dagen/.test(r3c.j.fout), r3c.j);
    const r3d = await vraag('verzend', { nota_id: id('2026201'), ...pdf(), plan_datum: plus(werk), auto: 'ja' });
    toets('auto anders dan true/false → 400', r3d.s === 400, r3d.j);
    const r3e = await vraag('verzend', { nota_id: id('2026033'), ...pdf(), plan_datum: plus(werk), auto: true, reden: 'naar POT' });
    toets('(controle) auto alleen SLOEL: SLOEL-nota mag', r3e.s === 200, r3e.j);
    const r4 = await vraag('verzend', { nota_id: id('2026201'), ...pdf(), plan_datum: plus(werk), auto: true });
    const x = rijen('2026201').pop();
    toets('auto op een werkdag vanaf morgen → auto_gevraagd, auto=1, niet_voor = 07:00 die dag (terugval)', r4.s === 200 && x.status === 'auto_gevraagd' && x.auto === 1 && x.plan_datum === plus(werk) && /T0[56]:00:00Z$/.test(x.niet_voor) && r4.j.verzending.status === 'auto_gevraagd', { r: r4.j, x });
    const r5 = await vraag('verzend', { nota_id: id('2026201'), ...pdf(), plan_datum: plus(werk), auto: true });
    toets('nog eens drukken → al (geen tweede rij)', r5.s === 200 && r5.j.al === true && rijen('2026201').length === 1, r5.j);
    db.prepare("update nota_verzending set status='auto_vrij' where id=?").run(x.id);
    const r6 = await vraag(`verzending/${x.id}/annuleer`);
    toets('annuleren kan ook als hij al vrijgegeven is (auto_vrij)', r6.s === 200 && r6.j.verzending.status === 'geannuleerd' && rijen('2026201').pop().pdf_b64 === null, r6.j);
    const r7 = await vraag('verzend', { nota_id: id('2026202'), ...pdf(), plan_datum: plus(werk), auto: true });
    const y = rijen('2026202').pop();
    db.prepare("update nota_verzending set status='verzenden' where id=?").run(y.id);
    const r8 = await vraag(`verzending/${y.id}/annuleer`);
    toets('annuleren tijdens verzenden → 409', r7.s === 200 && r8.s === 409, r8.j);
    const r9 = await vraag('verzend', { nota_id: id('2026202'), ...pdf(), reden: 'bedrag aangepast' });
    toets('opnieuw klaarzetten tijdens verzenden → 409', r9.s === 409 && /verstuurd/.test(r9.j.fout), r9.j);
    db.prepare("update nota_verzending set status='auto_verstuurd' where id=?").run(y.id);
    const r10 = await vraag('verzend', { nota_id: id('2026202'), ...pdf(), reden: 'bedrag aangepast' });
    toets('na auto_verstuurd opnieuw met reden → nieuwe rij (concept), oude vervangen', r10.s === 200 && rijen('2026202').filter((z) => z.status === 'vervangen').length === 1 && r10.j.verzending.status === 'wacht', r10.j);
    const r11 = await vraag('verzend', { nota_id: id('2026033'), ...pdf(), plan_datum: plus(werk), auto: true, reden: 'nu automatisch' });
    toets('ook voor een nota die al klaarstond: met reden opnieuw als auto', r11.s === 200 && r11.j.verzending.status === 'auto_gevraagd', r11.j);
    nota({ entiteit: 'POT', nummer: '2026301', praktijk_id: 'P01', bedrag: 10 });
    const r12 = await vraag('verzend', { nota_id: id('2026301'), ...pdf(), plan_datum: plus(werk), auto: true });
    toets('auto voor een POT-nota → 409 (alleen SLOEL)', r12.s === 409 && /alleen SLOEL/.test(r12.j.fout), r12.j);
  }

  // ── P3: patiënten ──
  {
    const r = await vraag('patienten', { standen: [{ praktijk_id: 'P01', peildatum: '2027-01-01', aantal: 3200 }, { praktijk_id: 'P02', peildatum: '2027-01-01', aantal: '2.150' }, { praktijk_id: 'P03', peildatum: '2027-01-01', aantal: 990 }] });
    const s = db.prepare("select praktijk_id, aantal, status from praktijk_patienten where peildatum='2027-01-01' order by praktijk_id").all();
    toets('patiënten: 3 standen in één transactie (upsert, status handmatig)', r.s === 200 && r.j.opgeslagen === 3 && s.length === 3 && s[0].aantal === 3200 && s.every((x) => x.status === 'handmatig'), { r: r.j, s });
    const r2 = await vraag('patienten', { standen: [{ praktijk_id: 'P01', peildatum: '2027-01-01', aantal: 3300 }] });
    toets('patiënten: bestaande stand overschreven', r2.s === 200 && db.prepare("select aantal from praktijk_patienten where praktijk_id='P01' and peildatum='2027-01-01'").get().aantal === 3300);
    toets('patiënten: peildatum niet 1-1 → 400', (await vraag('patienten', { standen: [{ praktijk_id: 'P01', peildatum: '2027-02-01', aantal: 1 }] })).s === 400);
    toets('patiënten: onbekende praktijk → 400, niets geschreven', (await vraag('patienten', { standen: [{ praktijk_id: 'P01', peildatum: '2028-01-01', aantal: 1 }, { praktijk_id: 'P77', peildatum: '2028-01-01', aantal: 1 }] })).s === 400
      && !db.prepare("select 1 from praktijk_patienten where peildatum='2028-01-01'").get());
    toets('patiënten: lege lijst → 400', (await vraag('patienten', { standen: [] })).j.fout === 'verwacht een lijst van 1 tot 300 standen');
  }
  // ── P3: planning (concept), vaststellen, correctie ──
  let planId;
  {
    const body = { entiteit: 'SLOEL', jaar: 2027, marge_pct: 2, termijn: 'kwartaal', posten: [{ omschrijving: 'Huur proefpand', bedrag: 12000, per: 'jaar', aantal: 1, indexatie_pct: 3 }, { omschrijving: 'Schoonmaak', bedrag: '1.000,50', per: 'jaar' }],
      deelnemers: [{ praktijk_id: 'P01', actief: true }, { praktijk_id: 'P02', actief: true }, { praktijk_id: 'P03', actief: true }, { praktijk_id: 'P08', actief: false }] };
    toets('planning: 1,000,50 → 400 (bedrag ongeldig)', (await vraag('planning', body)).s === 400);
    body.posten[1].bedrag = '1000,50';
    const r = await vraag('planning', body);
    toets('planning: nieuw concept, versie concept-<datum uit D1>', r.s === 200 && r.j.nieuw === true && /^concept-\d{4}-\d\d-\d\d$/.test(r.j.plan.versie) && r.j.plan.status === 'concept', r.j);
    planId = r.j.plan && r.j.plan.id;
    toets('planning: één schrijfbatch (plan + 2 posten + 4 deelnemers)', r.r.schrijfacties === 1 && schrijfLog[schrijfLog.length - 1] === 7, schrijfLog);
    toets('planning: totaal = (12360 + 1000,50) × 1,02', r.j.plan.uitkomst.totaal === Math.round((12360 + 1000.5) * 1.02 * 100) / 100, r.j.plan.uitkomst);
    toets('planning: sleutel op stand 1-1-2027 (die staat er nu)', r.j.plan.uitkomst.sleutel.toelichting === 'stand 1-1-2027' && r.j.plan.deelnemers.find((d) => d.praktijk_id === 'P08').actief === 0, r.j.plan.uitkomst.sleutel);
    const r2 = await vraag('planning', { ...body, plan_id: planId, marge_pct: 0 });
    toets('planning: bestaand concept bijgewerkt (zelfde versie, oude posten weg)', r2.s === 200 && r2.j.nieuw === false && r2.j.plan.id === planId && db.prepare('select count(*) n from plan_post where plan_id=?').get(planId).n === 2, r2.j);
    toets('planning: geen deelnemer actief → 400', (await vraag('planning', { ...body, deelnemers: [{ praktijk_id: 'P01', actief: false }] })).j.fout === 'kies minstens één deelnemer');
    toets('planning: onbekende praktijk → 400', (await vraag('planning', { ...body, deelnemers: [{ praktijk_id: 'P77', actief: true }] })).s === 400);
    toets('planning: plan van ander jaar → 409', (await vraag('planning', { ...body, jaar: 2028, plan_id: planId })).s === 409);
    toets('planning: 61 posten → 400', (await vraag('planning', { ...body, posten: Array.from({ length: 61 }, () => body.posten[0]) })).j.fout === 'posten: 1 tot 60 regels');
  }
  {
    const vrij = (await lees('planning/sloel/2027')).j.volgend_nummer;
    toets('vaststellen: volgend nummer 2027001', vrij === '2027001', vrij);
    const r0 = await vraag('planning/vaststellen', { plan_id: planId, startnummer: '2027001', kwartalen: [1, 2], datums: { 1: '2027-13-01' } });
    toets('vaststellen: ongeldige factuurdatum → 400, niets geschreven', r0.s === 400 && r0.r.schrijfacties === 0, r0.j);
    const r = await vraag('planning/vaststellen', { plan_id: planId, startnummer: '2027001', kwartalen: [2, 1, 2] });
    const notas = db.prepare("select nummer, praktijk_id, periode, bedrag, regels from nota where entiteit='SLOEL' and jaar=2027 order by nummer").all();
    toets('vaststellen: 6 voorschotnota\'s (2 kwartalen × 3 actieve praktijken), nummers op volgorde', r.s === 200 && notas.length === 6 && notas.map((n) => n.nummer).join() === '2027001,2027002,2027003,2027004,2027005,2027006' && notas[0].periode === '2027-Q1' && notas[3].periode === '2027-Q2', notas.map((n) => n.nummer + n.periode));
    toets('vaststellen: plan vastgesteld met versienaam v1-<datum>, één transactie', r.j.plan.status === 'vastgesteld' && /^v1-\d{4}-\d\d-\d\d$/.test(r.j.plan.versie) && r.r.schrijfacties === 1, r.j.plan);
    const tb = r.j.plan.uitkomst.sleutel.per;
    toets('vaststellen: bedragen = termijnbedrag (hele euro\'s), regels met omschrijving', notas[0].bedrag === tb[notas[0].praktijk_id].termijnbedrag && Number.isInteger(notas[0].bedrag) && /Doorbelaste huur Mulderij 2027 - kwartaal 1/.test(notas[0].regels), notas[0]);
    toets('vaststellen: "LET OP: Inplannen" bij een datum in de toekomst', /LET OP: Inplannen op 01-01-2027/.test(notas[0].regels) || '2027-01-01' <= lokaal, notas[0].regels);
    toets('vaststellen: totaal_notas klopt', r.j.totaal_notas === Math.round(notas.reduce((a, n) => a + n.bedrag, 0) * 100) / 100);
    const r2 = await vraag('planning/vaststellen', { plan_id: planId, startnummer: '2027001', kwartalen: [1, 3] });
    toets('vaststellen opnieuw met bezet startnummer → 409 met volgend vrij', r2.s === 409 && /nummer\(s\) al in gebruik: 2027001.*volgend vrij: 2027007/.test(r2.j.fout), r2.j);
    const r3 = await vraag('planning/vaststellen', { plan_id: planId, startnummer: '2027007', kwartalen: [1, 3] });
    toets('vaststellen: bestaand kwartaal overgeslagen, Q3 erbij', r3.s === 200 && r3.j.overgeslagen.length === 3 && r3.j.notas.length === 3 && r3.j.notas.every((n) => n.periode === '2027-Q3'), r3.j);
    toets('vaststellen: plan 99999 → 404', (await vraag('planning/vaststellen', { plan_id: 99999, startnummer: '2027100', kwartalen: [4] })).s === 404);
    // halve commit kan niet: een UNIQUE-fout midden in de batch laat ook het plan ongemoeid
    const voor = db.prepare('select status, versie from plan where id=?').get(planId);
    const nieuw = await vraag('planning', { entiteit: 'SLOEL', jaar: 2027, posten: [{ omschrijving: 'x', bedrag: 1 }], deelnemers: [{ praktijk_id: 'P01', actief: true }] });
    db.prepare("insert into nota (entiteit, jaar, nummer, praktijk_id, datum, soort, regels, bedrag) values ('SLOEL',2027,'2027200','P01','2027-01-01','x','[]',1)").run();
    const io2 = { ...io, d1: async (batch) => { const r = await io.d1(batch); return batch.map((x, i) => (/nummer in \(/.test(x.sql) && /^select nummer/.test(x.sql) ? { results: [] } : r[i])); } };   // botsingscontrole blind: de databank vangt het
    const r4 = await P.maak(io2).schrijf('planning/vaststellen', { plan_id: nieuw.j.plan.id, startnummer: '2027200', kwartalen: [4] });
    toets('vaststellen: UNIQUE in de databank → 409 en niets half (plan blijft concept, oude plan blijft vastgesteld)', r4.status === 409 && /UNIQUE/.test(r4.j.fout)
      && db.prepare('select status from plan where id=?').get(nieuw.j.plan.id).status === 'concept' && db.prepare('select status from plan where id=?').get(planId).status === voor.status
      && db.prepare("select count(*) n from nota where nummer='2027200'").get().n === 1, r4.j);
  }
  {
    const r = await vraag('correctie', { entiteit: 'SLOEL', jaar: 2027, modus: 'tot_heden', tot_kwartaal: 3, extra: '100', startnummer: '2027020', datum: '2027-10-01', regels: [{ praktijk_id: 'P01', bedrag: 125.4 }, { praktijk_id: 'P02', bedrag: 0.4 }, { praktijk_id: 'P03', bedrag: -80 }] });
    const n = db.prepare("select nummer, praktijk_id, soort, periode, bedrag, regels from nota where nummer in ('2027020','2027021') order by nummer").all();
    toets('correctie: 2 nota\'s (< € 1 overgeslagen), hele euro\'s, soort correctie, periode Q1/Q3', r.s === 200 && n.length === 2 && n[0].bedrag === 125 && n[1].bedrag === -80 && n[1].praktijk_id === 'P03' && n[0].soort === 'correctie' && n[0].periode === '2027-Q1/Q3', { r: r.j.fout, n });
    toets('correctie: toelichting met juist bedrag, extra en eerder in rekening gebracht', /juist bedrag t\/m kwartaal 3: .* van €/.test(n[0].regels) && /waarvan extra/.test(n[0].regels) && /eerder in rekening gebracht \(2027001/.test(n[0].regels), n[0].regels);
    toets('correctie: handmatig afwijkend bedrag staat erbij', /handmatig aangepast \(voorstel/.test(n[0].regels));
    toets('correctie: bezet startnummer → 409', (await vraag('correctie', { entiteit: 'SLOEL', jaar: 2027, startnummer: '2027020', regels: [{ praktijk_id: 'P01', bedrag: 10 }] })).s === 409);
    toets('correctie: praktijk buiten het voorstel → 400', (await vraag('correctie', { entiteit: 'SLOEL', jaar: 2027, startnummer: '2027030', regels: [{ praktijk_id: 'P91', bedrag: 10 }] })).s === 400);
    toets('correctie: alleen bedragen < € 1 → 400', (await vraag('correctie', { entiteit: 'SLOEL', jaar: 2027, startnummer: '2027030', regels: [{ praktijk_id: 'P01', bedrag: 0.2 }] })).j.fout === 'geen bedragen van € 1 of meer');
    const e = await vraag('correctie', { entiteit: 'SLOEL', jaar: 2026, modus: 'eindafrekening', jaarlast: 20000, startnummer: '2026500', regels: [{ praktijk_id: 'P01', bedrag: 50 }] });
    toets('eindafrekening zonder stand 1-1-2027 voor iedereen? (alle drie aanwezig) → nota + jaarlast ingevoerd', e.s === 200 && e.j.notas.length === 1 && e.j.notas[0].soort === 'eindafrekening' && db.prepare("select bedrag from jaarlast where entiteit='SLOEL' and jaar=2026").get().bedrag === 20000, e.j);
    const e2 = await vraag('correctie', { entiteit: 'SLOEL', jaar: 2026, modus: 'eindafrekening', jaarlast: 21000, startnummer: '2026501', regels: [{ praktijk_id: 'P02', bedrag: 50 }] });
    toets('eindafrekening met andere jaarlast → jaarlast bijgewerkt (was … erbij)', e2.s === 200 && /gewijzigd bij eindafrekening \(was 20000/.test(db.prepare("select opmerking from jaarlast where entiteit='SLOEL' and jaar=2026").get().opmerking));
    toets('eindafrekening zonder vastgestelde standen → 409', (await vraag('correctie', { entiteit: 'SLOEL', jaar: 2027, modus: 'eindafrekening', jaarlast: 1, startnummer: '2027900', regels: [{ praktijk_id: 'P01', bedrag: 5 }] })).s === 409);
  }
  // ── P3: nota-status ──
  {
    const c = id('2026099');
    const r = await vraag(`nota/${c}/status`, { status: 'definitief' });
    toets('status concept → definitief, opmerking erbij', r.s === 200 && r.j.nota.status === 'definitief' && /status concept → definitief op \d{4}/.test(r.j.nota.opmerking), r.j);
    toets('status definitief → concept → 409', (await vraag(`nota/${c}/status`, { status: 'concept' })).s === 409);
    toets('status definitief → vervallen', (await vraag(`nota/${c}/status`, { status: 'vervallen' })).j.nota.status === 'vervallen');
    toets('status van onbekende nota → 404', (await vraag('nota/99999/status', { status: 'vervallen' })).s === 404);
  }
  // ── de overstap: dicht = 409, behalve annuleren en PROEF ──
  {
    open = false;
    const n0 = schrijfLog.length, r0 = leesRondgangen;
    for (const p of ['planning', 'planning/vaststellen', 'correctie', 'patienten', 'nota/1/status']) {
      const r = await vraag(p, {});
      toets('dicht: ' + p + ' → 409 met de verwijzing naar de oude pagina', r.s === 409 && r.j.fout === P.DICHT && /werk\.socev\.dev\/pot/.test(r.j.fout), r.j);
    }
    toets('dicht: P3-routes raken D1 niet', schrijfLog.length === n0 && leesRondgangen === r0);
    const r1 = await vraag('verzend', { nota_id: id('2026202'), ...pdf(), reden: 'nog eens graag' });
    toets('dicht: klaarzetten SLOEL → 409', r1.s === 409 && r1.j.fout === P.DICHT, r1.j);
    const r2 = await vraag('verzend', { nota_id: id('9990001'), ...pdf() });
    toets('dicht: klaarzetten PROEF-nota mag (natoets)', r2.s === 200 && r2.j.verzending.status === 'wacht' && r2.j.verzending.entiteit === 'PROEF', r2.j);
    db.prepare("update nota_verzending set status='wacht_op_adres', aan='proef@voorbeeld.test' where id=?").run(r2.j.verzending.id);
    const r3 = await vraag(`verzending/${r2.j.verzending.id}/adres`, { aan: 'proef@voorbeeld.test' });
    toets('dicht: adres van een PROEF-verzending mag', r3.s === 200, r3.j);
    const w = rijen('2026202').find((x) => x.status === 'wacht');
    db.prepare("update nota_verzending set status='wacht_op_adres', aan='x@voorbeeld.test' where id=?").run(w.id);
    toets('dicht: adres van een SLOEL-verzending → 409', (await vraag(`verzending/${w.id}/adres`, { aan: 'x@voorbeeld.test' })).j.fout === P.DICHT);
    const r4 = await vraag(`verzending/${w.id}/annuleer`);
    toets('dicht: annuleren mag altijd (bouwplan § 3.4)', r4.s === 200 && r4.j.verzending.status === 'geannuleerd', r4.j);
    open = true;
  }
  // ── fouten ──
  {
    const kapot = P.maak({ ...io, schrijf: async () => { throw new Error('D1 http 504: time-out'); } });
    const r = await kapot.schrijf('patienten', { standen: [{ praktijk_id: 'P01', peildatum: '2029-01-01', aantal: 1 }] });
    toets('D1-fout bij schrijven → 500 met de fouttekst (geen uitzondering)', r.status === 500 && /504/.test(r.j.fout), r);
    const zonder = P.maak({ d1: io.d1, schrijvenOpen: () => true });
    toets('zonder io.schrijf → 500, geen schrijfactie', (await zonder.schrijf('patienten', { standen: [{ praktijk_id: 'P01', peildatum: '2029-01-01', aantal: 1 }] })).status === 500);
    toets('zonder schrijvenOpen = dicht', (await P.maak({ d1: io.d1, schrijf: io.schrijf }).schrijf('patienten', {})).j.fout === P.DICHT);
    const tijd = await P.maak({ ...io, d1: async (b) => b.map((x) => ({ results: /strftime/.test(x.sql) ? [{ nu: 'onzin' }] : [] })) }).schrijf('patienten', { standen: [] });
    toets('D1 zonder geldige tijd → 500', tijd.status === 500 && /tijd/.test(tijd.j.fout), tijd.j);
    toets('lijst als body (geen object) telt als leeg', (await vraag('nota/1/status', [1, 2])).s === 409);
  }

  // ── kaartteksten en doel (pot-verzend.js) ──
  {
    const rij = [{ id: 1, nummer: '2026033', onderwerp: 'o', praktijk: 'Praktijk Aap', reden: 'r', fout: 'f', deadline: '2026-11-02', entiteit: 'SLOEL', praktijk_id: 'P01', opmerking: 'adres_gewijzigd' }];
    V.zetOvis(false);
    const voor = [V.kaartGepland('SLOEL', '2026-11-02', rij, 'nu'), V.kaartAdres(rij, 'nu', {}), V.kaartFout(rij, 'nu'), V.kaartNietAuto(rij, 'nu'), V.kaartOnzeker(rij, 'nu'),
      V.kaartVrijgave({ id: 1, entiteit: 'SLOEL', plan_datum: '2026-11-02' }, [{ nummer: '2026033', praktijk: 'Praktijk Aap', aan: 'a@voorbeeld.test', bedrag: 1 }], '2026-10-30'), V.kaartVandaag({ id: 1, entiteit: 'SLOEL', plan_datum: '2026-11-02' }, rij)];
    toets('vóór de overstap: kaarten noemen de POT-app, niet OVIS POT', voor.every((k) => /POT-app/.test(JSON.stringify([k.titel, k.waarom, k.stappen])) && !/OVIS POT/.test(JSON.stringify([k.titel, k.waarom, k.stappen]))), voor.map((k) => k.titel));
    toets('alle POT-kaarten: module pot, doel scherm pot met focus notas:<ent>', voor.every((k) => k.herkomst.module === 'pot' && k.herkomst.doel.scherm === 'pot' && /^notas:[a-z]+$/.test(k.herkomst.doel.focus)) && voor[0].herkomst.doel.focus === 'notas:sloel', voor.map((k) => k.herkomst));
    toets('focus past op de doelvorm van de pod (APP_VJ_FOCUS_RE)', voor.every((k) => /^[a-z][a-z-]{0,19}:[A-Za-z0-9._:\/-]{1,80}$/.test(k.herkomst.doel.focus)));
    V.zetOvis(true);
    const na = [V.kaartGepland('SLOEL', '2026-11-02', rij, 'nu'), V.kaartAdres(rij, 'nu', {}), V.kaartFout(rij, 'nu'), V.kaartNietAuto(rij, 'nu'), V.kaartOnzeker(rij, 'nu'),
      V.kaartVrijgave({ id: 1, entiteit: 'SLOEL', plan_datum: '2026-11-02' }, [{ nummer: '2026033', praktijk: 'Praktijk Aap', aan: 'a@voorbeeld.test', bedrag: 1 }], '2026-10-30'), V.kaartVandaag({ id: 1, entiteit: 'SLOEL', plan_datum: '2026-11-02' }, rij)];
    toets('na de overstap: geen kaart noemt nog de POT-app; OVIS POT › Nota\'s waar het over de lijst gaat', na.every((k) => !/POT-app/.test(JSON.stringify([k.titel, k.waarom, k.stappen]))) && /OVIS POT › Nota's/.test(JSON.stringify(na[0].stappen)) && /OVIS POT › Nota's/.test(JSON.stringify(na[5].stappen)), na.map((k) => k.stappen));
    toets('na de overstap: knopnamen in de stappen (Adres klopt, Annuleer)', /'Adres klopt'/.test(JSON.stringify(na[1].stappen)) && /Annuleer/.test(JSON.stringify(na[6].stappen)));
    toets('kaarten binnen de grenzen van de databank', na.every((k) => k.titel.length >= 3 && k.titel.length <= 90 && k.waarom.length <= 400 && (k.stappen || []).length <= 12));
    V.zetOvis(false);
  }

  // ── server.js: router, invoerslot, verse vingerafdruk, auditregel ──
  {
    const src = fs.readFileSync('server.js', 'utf8');
    const knip = (naam) => { const i = src.indexOf('function ' + naam + '('); const st = src.lastIndexOf('\n', i) + 1; let d = 0, j = src.indexOf('{', i); for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) break; } } return src.slice(st, j + 1); };
    toets('router: POST /app/pot/ naar appPotSchrijf (met sessie en apparaat)', /if \(route\.indexOf\('POST \/app\/pot\/'\) === 0\) return typeof appPotSchrijf === 'function' \? appPotSchrijf\(req, res, a, s, d, route\)/.test(src));
    const c = { APP_SLOT_VRIJ: new Set() };
    vm.runInNewContext(knip('appInvoerRoute') + '; uit = [appInvoerRoute("POST /app/pot/verzending/12/annuleer", false, {}, {}), appInvoerRoute("POST /app/pot/verzending/12/adres", false, {}, {}), appInvoerRoute("POST /app/pot/planning", false, {}, {}), appInvoerRoute("POST /app/pot/verzend", false, {}, {}), appInvoerRoute("GET /app/pot/overzicht", false, {}, {})];', c);
    toets('invoerslot: annuleren vrij; adres, planning en klaarzetten onder het slot; lezen niet', c.uit.join() === 'false,true,true,true,false', c.uit);
    const kaal = [];
    const ctx = { POT_APP_MOD: P, process: { env: { CLOUDFLARE_API_TOKEN: 'x' } }, Date, String, logError: () => {},
      potApp: { schrijf: async (pad, d) => { kaal.push(pad); return { status: 200, j: { ok: true, verzending: { id: 5 } }, route: P.ontleedSchrijf(pad).route, rondgangen: 2, schrijfacties: 1 }; } },
      appTeller: () => true, appVersOk: (a, s) => s.vers_tot > Date.now(),
      appWeiger: (res, st, f, r) => { res.uit = { st, f }; res._app.reden = r; return res; }, appStuur: (res, st, j) => { res.uit = { st, j }; return res; } };
    vm.createContext(ctx);
    vm.runInContext(knip('appPotSchrijf') + '; this.f = appPotSchrijf;', ctx);
    const res = () => ({ _app: {} });
    const mob = { soort: 'meereizend' }, vast = { soort: 'vast' };
    let s = { vers_tot: 0 }, r;
    r = await ctx.f({}, res(), mob, s, {}, 'POST /app/pot/verzending/5/adres');
    toets('adres zonder verse vingerafdruk → 403 vers_nodig, pot-app niet aangeroepen', r.uit.st === 403 && r.uit.j.vers_nodig === true && kaal.length === 0, r.uit);
    s = { vers_tot: Date.now() + 60000 };
    r = await ctx.f({}, res(), vast, s, {}, 'POST /app/pot/verzending/5/adres');
    toets('adres vanaf een vaste plek → 403 (ook met verse vingerafdruk)', r.uit.st === 403 && kaal.length === 0 && s.vers_tot > Date.now(), r.uit);
    r = await ctx.f({}, res(), mob, s, { aan: 'geheim@voorbeeld.test' }, 'POST /app/pot/verzending/5/adres');
    toets('adres met verse vingerafdruk → door, vingerafdruk verbruikt', r.uit.st === 200 && kaal.length === 1 && s.vers_tot === 0, { r: r.uit, s });
    toets('auditregel: route, id, rondgangen; geen adres', /^pot: verzending\/adres 5 verzending 5 \(200, 2\+1 rondgangen, \d+ ms\)$/.test(r._app.reden) && !/geheim@/.test(r._app.reden), r._app.reden);
    s = { vers_tot: 0 };
    r = await ctx.f({}, res(), vast, s, {}, 'POST /app/pot/verzending/5/annuleer');
    toets('annuleren zonder vingerafdruk en vanaf een vaste plek → door', r.uit.st === 200 && kaal.length === 2);
    r = await ctx.f({}, res(), mob, s, { nota_id: 9, pdf_b64: 'JVBERi0=' }, 'POST /app/pot/verzend');
    toets('klaarzetten zonder vingerafdruk → door (het anker is de vrijgave in Voor jou); auditregel zonder PDF', r.uit.st === 200 && kaal.length === 3 && /^pot: verzend nota 9 /.test(r._app.reden) && !/JVBER/.test(r._app.reden), r._app.reden);
    r = await ctx.f({}, res(), mob, s, {}, 'POST /app/pot/onzin');
    toets('onbekende schrijfroute → 404', r.uit.st === 404 && kaal.length === 3);
    toets('potDhD1 kent een eigen time-out; schrijven met 15 s', /async function potDhD1\(batch, ms\)/.test(src) && /AbortSignal\.timeout\(ms \|\| 30000\)/.test(src) && /schrijf: function \(batch\) \{ return potDhD1\(batch, 15000\); \}/.test(src));
    toets('schrijven alleen via io.schrijf; io.d1 blijft alleen SELECT', /d1: function \(batch\) \{ if \(batch\.some\(function \(q\) \{ return !\/\^\\s\*select\\b\/i\.test\(q\.sql\); \}\)\) return Promise\.reject/.test(src));
    toets('schakelaar: <POT_VZ_DIR>/ovis-pot-schrijft; kaartteksten volgen hem vóór elke ronde', /path\.join\(POT_VZ_DIR, 'ovis-pot-schrijft'\)/.test(src) && /POT_VZ_MOD\.zetOvis\(typeof potAppSchrijvenOpen === 'function' && potAppSchrijvenOpen\(\)\);[^\n]*\n    const u = await POT_VZ_MOD\.ronde\(/.test(src));
    toets('GET /app/pot/stand zegt of OVIS POT schrijft', /if \(pad === 'stand'\) \{[^\n]*schrijft: potAppSchrijvenOpen\(\)/.test(src));
  }

  console.log(`\npot-app-schrijf: ${goed} groen, ${fouten} rood`);
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error('ROOD  uitzondering', e); process.exit(1); });
JS
