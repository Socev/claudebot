#!/usr/bin/env bash
# Toetst de OVIS POT maandronde (wv2762): pot-maand.js met de bundel ovis-pot/ (API, rekenkern, stukken van de app) tegen een nagebootste
# D1 (node:sqlite met ovis-pot/schema.sql), een nep-Gmail (lees-luik + mailluik) en de echte pdftotext. VERZONNEN praktijken en adressen.
# Toetst: nota's van de maand maken (één keer), één concept per praktijk met alle pdf's, adres moet gelijk zijn aan het register,
# Exact zonder adres = geen_adres en later alsnog, herinnering, onzeker → teruggevonden (geen tweede concept), nameten verzonden,
# kaarten, woordtoets (geen 'factuur'/btw), niets vóór de overnamedatum, en dat de module nooit iets verstuurt.
# Raakt de pod, D1, Gmail en de vault niet. Gebruik: bash test/pot-maand.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), url = require('url'), { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const M = require(path.resolve('pot-maand.js'));
(async () => {
  const map = path.resolve('ovis-pot');
  const B = { api: await import(url.pathToFileURL(path.join(map, 'api.mjs')).href), K: await import(url.pathToFileURL(path.join(map, 'kern', 'pot-kern.mjs')).href), S: await import(url.pathToFileURL(path.join(map, 'kern', 'stukken.mjs')).href) };
  // ── bundel: bron.json klopt met de bestanden ──
  const bron = JSON.parse(fs.readFileSync(path.join(map, 'bron.json'), 'utf8'));
  const crypto = require('crypto');
  toets('bundel: sha256 van elk bestand = bron.json', Object.entries(bron.bestanden).every(([f, h]) => crypto.createHash('sha256').update(fs.readFileSync(path.join(map, f), 'utf8')).digest('hex') === h), bron.commit);
  const repo = '/opt/data/ovis-pot';
  if (fs.existsSync(path.join(repo, '.git'))) {
    let gelijk = true;
    for (const f of ['kern/pot-kern.mjs', 'kern/stukken.mjs', 'kern/naspelen.mjs']) { try { gelijk = gelijk && execFileSync('git', ['-C', repo, 'show', bron.commit + ':' + f], { encoding: 'utf8' }) === fs.readFileSync(path.join(map, f), 'utf8'); } catch (e) { gelijk = false; } }
    toets('bundel: kern = Socev/ovis-pot op de commit uit bron.json', gelijk, bron.commit);
  }
  // ── nep-D1 ──
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(map, 'schema.sql'), 'utf8'));
  const d1 = async (batch) => { db.exec('BEGIN'); try { const r = batch.map((s) => { const st = db.prepare(s.sql); if (/^\s*select\b/i.test(s.sql) || /\breturning\b/i.test(s.sql)) { return { results: st.all(...(s.params || [])), changes: undefined }; } const x = st.run(...(s.params || [])); return { results: [], changes: Number(x.changes) }; }); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const nu = new Date(db.prepare("select strftime('%Y-%m-%dT%H:%M:%SZ','now') as d").get().d);
  const ams = M.amsterdam(nu.toISOString());
  const J = ams.jaar, maand = ams.maand;
  db.exec(`insert into entiteit (code, naam, naam_document, iban, adres, postcode_plaats) values ('POT','Proef POT','Proef POT','NL00PROE0000000001','Proefweg 1','1111 AA Proefstad'),('KM','Proef KM','Proef KM','NL00PROE0000000002','Proefweg 1','1111 AA Proefstad'),('SLOEL','Proef SLOEL','Proef SLOEL','NL00PROE0000000003','Proefweg 1','1111 AA Proefstad');
    insert into praktijk (id, naam) values ('P91','Praktijk Proef Een'),('P92','Praktijk Proef Twee');
    insert into praktijk_versie (praktijk_id, geldig_van, naam, adres, postcode_plaats, email) values ('P91','2020-01-01','Praktijk Proef Een','Proefweg 1','1111 AA Proefstad','een@proef.example'),('P92','2020-01-01','Praktijk Proef Twee','Proefweg 2','1111 AA Proefstad','twee@proef.example');
    insert into praktijk_patienten (praktijk_id, peildatum, aantal) values ('P91','${J}-01-01',1000),('P92','${J}-01-01',3000);
    insert into deelname (entiteit, praktijk_id, geldig_van) values ('POT','P91','2020-01-01'),('POT','P92','2020-01-01'),('KM','P91','2020-01-01'),('KM','P92','2020-01-01'),('SLOEL','P91','2020-01-01'),('SLOEL','P92','2020-01-01');
    insert into kostencomponent (id, entiteit, naam, soort, per) values (1,'KM','Proefkosten','variabel','jaar'),(2,'SLOEL','Proefhuur','vast','kwartaal'),(3,'POT','Proef overig','variabel','jaar');
    insert into kostenmutatie (kostencomponent_id, geldig_van, bedrag, reden) values (1,'2020-01-01',12000,'x'),(2,'2020-01-01',3000,'x'),(3,'2020-01-01',24000,'x');
    update instelling set waarde='${J}-01-01' where sleutel='overname_vragen';
    update instelling set waarde='00:00' where sleutel='maandronde_uur';
    update instelling set waarde='2020-01-01T00:00:00Z' where sleutel='overstap_fin';`);
  const A = M.d1Achtig(d1), Z = new URLSearchParams();
  for (const e of ['POT', 'KM', 'SLOEL']) { const r = await B.api.behandel(A, 'POST', 'jaarplan', Z, { entiteit: e, jaar: J, reden: 'proef' }, 'proef'); if (r.status !== 200) console.log('jaarplan', e, r.body); }
  for (const p of db.prepare('select id from jaarplan').all()) await B.api.behandel(A, 'POST', 'jaarplan-vaststellen', Z, { id: p.id }, 'proef');
  if (maand === 1) { const r = await B.api.behandel(A, 'POST', 'notas-maken', Z, { jaar: J, maand: 1 }, 'proef'); toets('(januari) nota\'s met de hand gemaakt', r.status === 200, r.body); }
  // ── nep-Gmail, register, kaarten ──
  const gmail = []; let conceptStatus = 200, conceptAanroepen = 0;
  const kaartenL = []; const reg = { per: { P91: { aan: ['een@proef.example'], cc: [], naam: 'Praktijk Proef Een' }, P92: { aan: ['anders@proef.example'], cc: [], naam: 'Praktijk Proef Twee' } }, problemen: {}, onleesbaar: 0 };
  const io = {
    d1, bundel: async () => B,
    luik: async (b) => { if (b.actie !== 'mail_zoeken') throw new Error('alleen zoeken'); const nr = /filename:(\d{7})/.exec(b.query)[1]; return { mails: gmail.filter((m) => m.bijlagen.some((x) => x.includes(nr))).map((m) => ({ id: m.id, thread_id: m.thread_id, onderwerp: m.onderwerp, aan: m.aan, labels: m.labels, datum: m.datum })) }; },
    concept: async (body) => { conceptAanroepen++; const m = { id: 'd' + (gmail.length + 1), thread_id: 't' + (gmail.length + 1), onderwerp: body.onderwerp, aan: body.aan, bericht: body.bericht, van: body.van, labels: ['DRAFT'], bijlagen: body.bijlagen.map((x) => x.naam), pdfs: body.bijlagen.map((x) => Buffer.from(x.inhoud_base64, 'base64')), datum: nu.toISOString() }; gmail.push(m); return conceptStatus === 200 ? { status: 200, j: { ok: true, concept_id: m.id, thread_id: m.thread_id, bijlagen: m.bijlagen.length } } : { status: conceptStatus, j: null }; },
    pdftotext: async (bytes) => { try { return { ok: true, tekst: execFileSync('/usr/bin/pdftotext', ['-q', '-enc', 'UTF-8', '-', '-'], { input: bytes, encoding: 'utf8' }) }; } catch (e) { return { ok: false }; } },
    registerAdressen: async () => reg,
    kaartZet: async (p) => { kaartenL.push({ sleutel: p.sleutel, status: 'open', p }); },
    kaartLijst: async () => kaartenL.map((k) => ({ sleutel: k.sleutel, status: k.status })),
    kaartDicht: async (s) => { const k = kaartenL.find((x) => x.sleutel === s); if (k) k.status = 'gedaan'; },
    register: () => {},
  };
  // ── ronde 1 ──
  let u = await M.ronde(io, { kaarten: true });
  const notas = db.prepare("select entiteit, nummer, praktijk_id, datum from nota order by entiteit, nummer").all();
  toets('ronde 1: nota\'s van de maand gemaakt (POT 2, KM 2, SLOEL 2)', notas.length === 6 && (maand === 1 || u.notas_gemaakt === 6), [notas.length, u.notas]);
  const mc = () => db.prepare('select soort, entiteit, praktijk_id, status, reden, nota_ids, aan from mail_concept order by id').all();
  toets('ronde 1: 2 praktijkregels + 3 Exact-regels', mc().filter((x) => x.soort === 'praktijk').length === 2 && mc().filter((x) => x.soort === 'exact').length === 3, mc());
  toets('Exact zonder verkoopadres: geen_adres, geen concept', mc().filter((x) => x.soort === 'exact').every((x) => x.status === 'geen_adres' && /verkoopadres Exact ontbreekt/.test(x.reden)));
  const p91 = mc().find((x) => x.praktijk_id === 'P91'), p92 = mc().find((x) => x.praktijk_id === 'P92');
  toets('P91: één concept met 3 pdf\'s (POT, KM, SLOEL) aan het registeradres', p91.status === 'concept' && gmail.length === 1 && gmail[0].bijlagen.length === 3 && gmail[0].aan === 'een@proef.example', [p91, gmail.map((g) => g.bijlagen)]);
  toets('P92: register ≠ adres op de nota → wacht_op_adres, geen concept', p92.status === 'wacht_op_adres' && /verschilt/.test(p92.reden), p92);
  const tekst = gmail.map((g) => g.onderwerp + '\n' + g.bericht).join('\n');
  toets('woordtoets: geen factuur, btw of min-teken in de mail', B.K.controleerStukTekst(tekst).length === 0 && /bijdragen/.test(tekst) && /doorbelaste huur/.test(tekst));
  toets('pdf\'s: nummer en "BIJDRAGENOTA"/"NOTA DOORBELASTE HUUR" erin', gmail[0].pdfs.every((b, i) => { const t = execFileSync('/usr/bin/pdftotext', ['-q', '-', '-'], { input: b, encoding: 'utf8' }); return t.includes(gmail[0].bijlagen[i].split(' - ')[1]) && /BIJDRAGENOTA|NOTA DOORBELASTE HUUR/.test(t) && !/factu/i.test(t); }));
  toets('afzender = Davids adres (zoals de SLOEL-nota\'s)', gmail[0].van === M.VAN);
  toets('kaart: probleemkaart voor P92, nog geen maandkaart', kaartenL.some((k) => /^ovis-pot-maand-probleem-/.test(k.sleutel)) && !kaartenL.some((k) => /^ovis-pot-maand-\d/.test(k.sleutel)), kaartenL.map((k) => k.sleutel));
  // ── ronde 2: niets dubbel ──
  const voor = conceptAanroepen;
  u = await M.ronde(io, {});
  toets('ronde 2: geen nieuwe nota\'s, geen tweede concept', db.prepare('select count(*) n from nota').get().n === 6 && conceptAanroepen === voor && mc().length === 5, [u, conceptAanroepen]);
  // ── adres goed → concept + maandkaart ──
  reg.per.P92.aan = ['twee@proef.example'];
  db.exec("update mail_concept set bijgewerkt_op='2000-01-01T00:00:00Z' where status='wacht_op_adres'");
  u = await M.ronde(io, {});
  toets('adres in het register gelijk → P92 concept', mc().find((x) => x.praktijk_id === 'P92').status === 'concept' && gmail.length === 2, mc());
  const mk = kaartenL.find((k) => /^ovis-pot-maand-\d/.test(k.sleutel));
  toets('maandkaart: alle praktijken klaar → één kaart, probleemkaart dicht', !!mk && /2 concepten/.test(mk.p.titel) && kaartenL.filter((k) => /probleem/.test(k.sleutel)).every((k) => k.status === 'gedaan'), kaartenL.map((k) => [k.sleutel, k.status, k.p.titel]));
  toets('kaarttekst zonder factuur/btw en binnen de grenzen', B.K.controleerStukTekst(JSON.stringify(mk && mk.p)).length === 0 && mk.p.titel.length <= 90 && mk.p.waarom.length <= 400);
  // ── verkoopadres Exact komt later → achterstand alsnog ──
  await B.api.behandel(A, 'POST', 'verkoopadres', Z, { entiteit: 'POT', email: 'verkoop-pot@proef.example' }, 'proef');
  u = await M.ronde(io, {});
  const ex = mc().find((x) => x.soort === 'exact' && x.entiteit === 'POT');
  toets('verkoopadres POT ingevuld → Exact-concept met de 2 POT-stukken', ex.status === 'concept' && gmail.at(-1).aan === 'verkoop-pot@proef.example' && gmail.at(-1).bijlagen.length === 2 && gmail.at(-1).bijlagen.every((b) => b.startsWith('POT')), [ex, gmail.at(-1) && gmail.at(-1).bijlagen]);
  toets('KM/SLOEL zonder adres blijven geen_adres', mc().filter((x) => x.soort === 'exact' && x.entiteit !== 'POT').every((x) => x.status === 'geen_adres'));
  // ── herinnering ──
  const nP91 = db.prepare("select id, bedrag from nota where entiteit='KM' and praktijk_id='P91'").get();
  const h = await B.api.behandel(A, 'POST', 'herinnering', Z, { nota_id: nP91.id, open: nP91.bedrag }, 'proef');
  u = await M.ronde(io, {});
  const hr = mc().find((x) => x.soort === 'herinnering');
  toets('herinnering: verzoek → concept met 1 pdf aan de praktijk, verzoek klaar', h.status === 200 && hr && hr.status === 'concept' && /^Herinnering/.test(gmail.at(-1).onderwerp) && gmail.at(-1).bijlagen.length === 1 && db.prepare('select status from pod_verzoek').get().status === 'klaar', [h, hr]);
  // ── onzeker: mailluik geeft 500 maar het concept staat er wel → teruggevonden, geen tweede ──
  await B.api.behandel(A, 'POST', 'verkoopadres', Z, { entiteit: 'KM', email: 'verkoop-km@proef.example' }, 'proef');
  conceptStatus = 500;
  u = await M.ronde(io, {});
  const km = () => mc().find((x) => x.soort === 'exact' && x.entiteit === 'KM');
  toets('mailluik 500 → onzeker', km().status === 'onzeker', km());
  conceptStatus = 200; const n0 = conceptAanroepen;
  u = await M.ronde(io, {});
  toets('onzeker → concept teruggevonden in Gmail, geen tweede aanroep', km().status === 'concept' && conceptAanroepen === n0, [km(), conceptAanroepen - n0]);
  // ── nameten: verzonden ──
  gmail.filter((g) => g.aan === 'een@proef.example' && /POH-GGZ/.test(g.onderwerp)).forEach((g) => { g.labels = ['SENT']; });
  gmail.filter((g) => g.aan === 'twee@proef.example' && /POH-GGZ/.test(g.onderwerp)).forEach((g) => { g.labels = ['SENT']; });
  u = await M.ronde(io, { meten: true, kaarten: true });
  toets('nameten: beide praktijkmails verzonden', mc().filter((x) => x.soort === 'praktijk').every((x) => x.status === 'verzonden'), mc());
  toets('maandkaart dicht als alles verzonden is', kaartenL.find((k) => /^ovis-pot-maand-\d/.test(k.sleutel)).status === 'gedaan');
  // ── weggegooid concept: maandkaart-bewijs eerlijk, op de probleemkaart (Codex r1 Z1) ──
  {
    const dat = mc().find((x) => x.soort === 'praktijk').nota_ids;
    const k0 = kaartenL.length;
    db.exec("update mail_concept set status='concept_weg', bijgewerkt_op=strftime('%Y-%m-%dT%H:%M:%SZ','now') where soort='praktijk' and praktijk_id='P92'");
    kaartenL.forEach((k) => { if (/^ovis-pot-maand-\d/.test(k.sleutel)) k.status = 'open'; });
    let bewijs = null; const echtDicht = io.kaartDicht; io.kaartDicht = async (s, v, b) => { if (/^ovis-pot-maand-\d/.test(s)) bewijs = b; return echtDicht(s, v, b); };
    await M.ronde(io, { kaarten: true });
    io.kaartDicht = echtDicht;
    toets('concept weggegooid: maandkaart dicht met "1 van de 2 verzonden; 1 concept weggegooid"', /1 van de 2 mails .* verzonden; 1 concept weggegooid/.test(String(bewijs)), bewijs);
    toets('concept weggegooid: op de probleemkaart', kaartenL.slice(k0).some((k) => /probleem/.test(k.sleutel) && /weggegooid/.test(k.p.waarom)), kaartenL.slice(k0).map((k) => k.sleutel));
  }
  // ── overname (R10): stuk voor de vorige houder = eigen mail aan het adres op de nota; nieuwe houder apart (Codex r1 M1) ──
  {
    const oud = db.prepare("select id from praktijk_versie where praktijk_id='P91'").get().id;
    db.exec(`insert into praktijk_versie (praktijk_id, geldig_van, naam, adres, postcode_plaats, email) values ('P91', '${J}-01-02', 'Praktijk Proef Nieuw', 'Nieuweweg 1', '1111 AA Proefstad', 'nieuw@proef.example')`);
    const nieuw = db.prepare("select id from praktijk_versie where praktijk_id='P91' and geldig_van=?").get(`${J}-01-02`).id;
    const deb = (id, naam, email) => JSON.stringify({ praktijk_id: 'P91', versie_id: id, geldig_van: '2020-01-01', houder: naam, naam, tav: null, adres: 'Proefweg 1', postcode_plaats: '1111 AA Proefstad', email, kvk: null });
    const regel = JSON.stringify([{ soort: 'afrekening', omschrijving: 'Afrekening proef', bedrag: 50 }]);
    const ins = db.prepare("insert into nota (entiteit, jaar, nummer, praktijk_id, datum, vervaldag, soort, periode, titel, regels, bedrag, status, bron, debiteur) values ('POT', ?, ?, 'P91', ?, ?, 'afrekening', ?, 'BIJDRAGENOTA', ?, 50, 'definitief', 'ovis-pot', ?)");
    ins.run(J, `${J}901`, ams.ymd, ams.ymd, String(J), regel, deb(oud, 'Praktijk Proef Een', 'een@proef.example'));
    ins.run(J, `${J}902`, ams.ymd, ams.ymd, String(J), regel, deb(nieuw, 'Praktijk Proef Nieuw', 'nieuw@proef.example'));
    const g0 = gmail.length;
    await M.ronde(io, {});
    const rr = db.prepare("select status, aan, reden, nummers from mail_concept where soort='praktijk' and nummers like ?").all(`%${J}90%`);
    toets('overname: twee aparte mails (oude en nieuwe houder)', rr.length === 2, rr);
    const o = rr.find((x) => x.nummers.includes(`${J}901`)), n = rr.find((x) => x.nummers.includes(`${J}902`));
    toets('oude houder: concept aan het adres op de nota', o && o.status === 'concept' && o.aan === 'een@proef.example' && gmail.slice(g0).some((g) => g.aan === 'een@proef.example' && g.bijlagen.length === 1), o);
    toets('nieuwe houder: register (een@) ≠ nota (nieuw@) → wacht_op_adres', n && n.status === 'wacht_op_adres' && /verschilt/.test(n.reden), n);
  }
  // ── debiteur zonder versie: niet automatisch (Codex r2 M1) ──
  {
    const regel = JSON.stringify([{ soort: 'afrekening', omschrijving: 'Afrekening proef', bedrag: 60 }]);
    db.prepare("insert into nota (entiteit, jaar, nummer, praktijk_id, datum, vervaldag, soort, periode, titel, regels, bedrag, status, bron, debiteur) values ('KM', ?, ?, 'P92', ?, ?, 'afrekening', ?, 'BIJDRAGENOTA', ?, 60, 'definitief', 'ovis-pot', ?)")
      .run(J, `${J}903`, ams.ymd, ams.ymd, String(J), regel, JSON.stringify({ praktijk_id: 'P92', naam: 'Praktijk Proef Twee', houder: 'x', adres: 'Proefweg 2', postcode_plaats: '1111 AA Proefstad', email: null }));
    const g0 = gmail.length;
    await M.ronde(io, {});
    const r = db.prepare("select status, reden from mail_concept where soort='praktijk' and nummers like ?").get(`%${J}903%`);
    toets('debiteur zonder versie: fout, geen concept naar het register', r && r.status === 'fout' && /niet vast te stellen/.test(r.reden) && gmail.slice(g0).every((g) => g.bijlagen.every((b) => !b.includes(`${J}903`) || g.aan !== 'twee@proef.example')), r);
  }
  // ── vóór de overnamedatum niets ──
  db.exec(`update instelling set waarde='${J + 1}-01-01' where sleutel='overname_vragen'; delete from instelling where sleutel like 'maandronde_20%'; update nota set status='vervallen' where soort='maand'`);
  const nN = db.prepare('select count(*) n from nota').get().n;
  u = await M.ronde(io, {});
  toets('vóór overname_vragen: geen nota\'s gemaakt', db.prepare('select count(*) n from nota').get().n === nN && !u.notas_gemaakt);
  // ── de module verstuurt nooit: alleen concept- en zoekaanroepen ──
  const bron2 = fs.readFileSync('pot-maand.js', 'utf8');
  const code = bron2.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '').replace(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "''");
  toets('pot-maand.js roept alleen zoeken en concept aan (geen verzender, geen versturen)', !/io\.(verstuur|verzenderOk|bericht)\b/.test(code) && (code.match(/io\.[a-zA-Z0-9]+/g) || []).every((x) => ['io.d1', 'io.bundel', 'io.luik', 'io.concept', 'io.pdftotext', 'io.registerAdressen', 'io.kaartZet', 'io.kaartLijst', 'io.kaartDicht', 'io.register'].includes(x)), [...new Set(code.match(/io\.[a-zA-Z0-9]+/g))]);
  toets('lees-luik alleen mail_zoeken', !/actie:\s*'(?!mail_zoeken)/.test(bron2));
  console.log(`\n${goed} groen, ${fouten} rood`);
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error('ROOD  toets brak af:', e && e.stack || e); process.exit(1); });
JS
