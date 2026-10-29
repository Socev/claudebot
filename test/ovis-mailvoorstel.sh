#!/usr/bin/env bash
# Toetst wv1920 (OVIS Intake stap 3e): (A) de uitzonderingslijst eigen post in intake/patientpoort.js — eigen brief van een eigen
# zorgverlener vrij, al het andere vast (onbekende afzender, brief over een ander, tweede persoon, vreemd BSN, onleesbaar deel), zonder
# lijst altijd vast; (B) mailPlan — ≥ 2 mails, ≥ 2 met DKIM uitgelijnd, één organisatie, eigen domein, nog geen kenmerk; (C) metMailadres —
# alleen mailadressen + zaad veranderen, inline-lijst of nieuw veld, blok-lijst geweigerd, CRLF blijft; (D) van logboek tot weekbundel:
# droog/zonder grendel schrijft niets, met grendel één keer, compileren maakt een voorgesteld mailkenmerk, de bundel toont het adres;
# (E) intakeLezer leest alleen mail@1 en het laatste besluit. Alle gegevens zijn verzonnen. Raakt niets buiten een wegwerpmap.
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const R = require('./ovis-register.js');
const P = require('./intake/patientpoort.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }

// ── A. uitzonderingslijst eigen post (verzonnen sleutel, datum en domeinen) ──
{ const SL = 'a'.repeat(64), h = (x) => crypto.createHmac('sha256', SL).update(String(x)).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-'));
  fs.writeFileSync(path.join(dir, 'e.json'), JSON.stringify({ bsn: [], geboortedatum: [h('1975-03-21')], zorgverleners: ['voorbeeldkliniek.nl'] }));
  fs.writeFileSync(path.join(dir, 'e.sleutel'), SL + '\n');
  const eigen = P.laadEigen(path.join(dir, 'e.json'), path.join(dir, 'e.sleutel')), leeg = P.maakEigen(null, {});
  const brief = (geb, extra) => ['Geachte heer,', '', 'Betreft: dhr. A. Voorbeeld, geboortedatum ' + geb, '', 'Bij het lichamelijk onderzoek zagen wij een rustige knie.',
    'De diagnose is behandeld; het behandelplan: fysiotherapie, geen medicatie.', 'Graag zien wij u terug op het spreekuur van de polikliniek. Vragen? Bel de patiënt-service.', extra || '', 'Met vriendelijke groet'].join('\n');
  const G = [['eigen brief, eigen zorgverlener', { teksten: [brief('21-03-1975')], afzender: 'info@voorbeeldkliniek.nl' }, false],
    ['eigen brief, subdomein telt niet', { teksten: [brief('21-03-1975')], afzender: 'x@post.voorbeeldkliniek.nl' }, true],
    ['eigen brief, onbekende afzender', { teksten: [brief('21-03-1975')], afzender: 'x@ander.nl' }, true],
    ['brief over een ander', { teksten: [brief('14-03-1961')], afzender: 'info@voorbeeldkliniek.nl' }, true],
    ['eigen brief + tweede geboortedatum', { teksten: [brief('21-03-1975', 'Ook mw. B. Test, geboortedatum 02-05-1990.')], afzender: 'info@voorbeeldkliniek.nl' }, true],
    ['eigen brief + vreemd BSN', { teksten: [brief('21-03-1975', 'BSN 111222333.')], afzender: 'info@voorbeeldkliniek.nl' }, true],
    ['eigen brief + onleesbare bijlage (wv1920)', { teksten: [brief('21-03-1975')], afzender: 'info@voorbeeldkliniek.nl', leesbaar: false }, true],
    ['eigen brief uit een scan', { teksten: [brief('21-03-1975')], afzender: 'info@voorbeeldkliniek.nl', scan: true }, true],
    ['eigen brief met een deel uit OCR', { teksten: [brief('21-03-1975')], afzender: 'info@voorbeeldkliniek.nl', ocr: true }, true],
    ['arts-aan-arts: "geachte collega, bovengenoemde patiënt" met de eigen geboortedatum', { teksten: [brief('21-03-1975').replace('Geachte heer,', 'Geachte collega,\nWij zagen bovengenoemde patiënt.')], afzender: 'info@voorbeeldkliniek.nl' }, true],
    ['arts-aan-arts: "uw patiënt" en collegiale groet', { teksten: [brief('21-03-1975').replace('Met vriendelijke groet', 'Wij zagen uw patiënt.\nMet collegiale groet')], afzender: 'info@voorbeeldkliniek.nl' }, true],
    ['afzender "Naam <adres>" telt', { teksten: [brief('21-03-1975')], afzender: 'Kliniek <info@voorbeeldkliniek.nl>' }, false],
    ['afzender met een tweede adres ervoor telt niet', { teksten: [brief('21-03-1975')], afzender: 'x@ander.nl <info@voorbeeldkliniek.nl>' }, true],
    ['geen afzender (router zonder DKIM) = alleen BSN-route', { teksten: [brief('21-03-1975')], afzender: '' }, true]];
  for (const [n, st, vast] of G) {
    const u = P.beoordeel(st, { eigen }), z = P.beoordeel(st, { eigen: leeg });
    toets('A ' + n + (vast ? ' → vast' : ' → vrij') + ', zonder lijst vast', u.tegenhouden === vast && u.eigen_uitzondering === !vast && z.tegenhouden === true, [u, z.tegenhouden]);
  }
  toets('A korte sleutel = geen uitzondering (fail-closed)', (fs.writeFileSync(path.join(dir, 'k.sleutel'), 'kort'), P.beoordeel(G[0][1], { eigen: P.laadEigen(path.join(dir, 'e.json'), path.join(dir, 'k.sleutel')) }).tegenhouden === true));
  toets('A ontbrekende lijst = geen uitzondering', P.beoordeel(G[0][1], { eigen: P.laadEigen(path.join(dir, 'weg.json'), path.join(dir, 'e.sleutel')) }).tegenhouden === true);
}

// ── fixtures B–D ──
const pagTekst = (regels) => ['---', 'type: entiteit'].concat(regels, ['---', '# x', '', 'tekst', '']).join('\n');
const ACME = '10_Zakelijk/_Gedeeld/Relaties/Acme.md', ACMET = pagTekst(['entiteit_id: org:acme', 'soort: leverancier', 'status: concept', 'naam: "Acme"',
  'domeinen: ["acme.nl"]', 'voor: [TG]', 'zaad: ["domein acme.nl: praktijkmail, 9 mails (okt 2026)"]', 'ovis:', '  db: ["supabase:secondbrain/knoop#org:acme"]', 'updated: 2026-10-26']);
const BETA = '20_Prive/Relaties/Beta.md', BETAT = pagTekst(['entiteit_id: org:beta', 'soort: leverancier', 'status: concept', 'naam: "Beta"',
  'domeinen: ["beta.nl"]', 'mailadressen: ["oud@beta.nl"]', 'ovis:', '  db: ["supabase:secondbrain/knoop#org:beta"]']);
const rij = (n, van, dkim, afz, kracht, d) => ({ stuk_id: 's' + n, van, ontvangen: d || '2026-10-2' + (n % 9) + 'T08:00:00Z', dkim, afzender: afz, kracht });

// ── B. mailPlan ──
{ const pA = R.leesPagina(ACME, ACMET), pB = R.leesPagina(BETA, BETAT);
  toets('B fixtures geldig', !pA.fouten.length && !pB.fouten.length, [pA.fouten, pB.fouten]);
  const reg = { knopen: [{ id: 'org:acme', soort: 'organisatie', naam: 'Acme', vault_pagina: ACME, bron_sha: pA.sha }, { id: 'org:beta', soort: 'organisatie', naam: 'Beta', vault_pagina: BETA, bron_sha: pB.sha },
    { id: 'per:jan', soort: 'persoon', naam: 'Jan', vault_pagina: 'x.md', bron_sha: 'x' }],
    handvatten: [{ id: 1, knoop: 'org:acme', soort: 'mail', waarde_norm: 'weg@acme.nl', status: 'vervallen' }] };
  const rijen = [rij(1, 'factuur@acme.nl', 'uitgelijnd', 'org:acme', 'redelijk', '2026-09-30T08:00:00Z'), rij(2, 'Factuur@Acme.nl ', 'uitgelijnd', 'org:acme', 'redelijk', '2026-10-02T08:00:00Z'),
    rij(3, 'factuur@acme.nl', 'geen_uitslag', null, null),   // vastgehouden: telt mee voor het aantal, niet voor de organisatie
    rij(4, 'een@acme.nl', 'uitgelijnd', 'org:acme', 'redelijk'), rij(5, 'een@acme.nl', 'geen_uitslag', 'org:acme', 'redelijk'),
    rij(6, 'twee@acme.nl', 'uitgelijnd', 'org:acme', 'redelijk'), rij(7, 'twee@acme.nl', 'uitgelijnd', 'org:beta', 'redelijk'),
    rij(8, 'drie@acme.nl', 'uitgelijnd', 'org:acme', 'redelijk'), rij(9, 'drie@acme.nl', 'uitgelijnd', 'onbekend', 'geen'),
    rij(10, 'acme@gmail.com', 'uitgelijnd', 'org:acme', 'redelijk'), rij(11, 'acme@gmail.com', 'uitgelijnd', 'org:acme', 'redelijk'),
    rij(12, 'weg@acme.nl', 'uitgelijnd', 'org:acme', 'redelijk'), rij(13, 'weg@acme.nl', 'uitgelijnd', 'org:acme', 'redelijk'),
    rij(14, 'oud@beta.nl', 'uitgelijnd', 'org:beta', 'hoog'), rij(15, 'oud@beta.nl', 'uitgelijnd', 'org:beta', 'hoog'),
    rij(16, 'zelf@acme.nl', 'uitgelijnd', 'org:acme', 'redelijk'), rij(17, 'zelf@acme.nl', 'uitgelijnd', 'org:acme', 'redelijk'),
    rij(18, 'jan@acme.nl', 'uitgelijnd', 'per:jan', 'redelijk'), rij(19, 'jan@acme.nl', 'uitgelijnd', 'per:jan', 'redelijk'),
    rij(20, 'zwak@acme.nl', 'uitgelijnd', 'org:acme', 'zwak'), rij(21, 'zwak@acme.nl', 'uitgelijnd', 'org:acme', 'zwak'),
    rij(22, 'Naam <x@acme.nl>', 'uitgelijnd', 'org:acme', 'redelijk'), rij(23, 'Naam <x@acme.nl>', 'uitgelijnd', 'org:acme', 'redelijk')];
  const pl = R.mailPlan(rijen, reg, [pA, pB], { eigenAdressen: ['zelf@acme.nl'] });
  toets('B twee voorstellen: factuur@acme.nl en x@acme.nl ("Naam <adres>") bij org:acme', pl.voorstellen.length === 2 && pl.voorstellen[1].adres === 'x@acme.nl' && pl.voorstellen[0].adres === 'factuur@acme.nl' && pl.voorstellen[0].knoop === 'org:acme' && pl.voorstellen[0].pad === ACME && pl.voorstellen[0].n === 3 && pl.voorstellen[0].dkim === 2, pl);
  toets('B zaad-regel met aantal en periode', pl.voorstellen[0] && pl.voorstellen[0].zaad === 'mail factuur@acme.nl: 2 mails met kloppende DKIM (sep 2026–okt 2026)', pl.voorstellen[0]);
  toets('B redenen: te weinig DKIM, niet eenduidig (andere org, onbekend), vreemd domein, al kenmerk (vervallen, op de pagina), persoon en zwak = geen organisatie',
    pl.tel.reden.te_weinig === 1 && pl.tel.reden.niet_eenduidig === 2 && pl.tel.reden.niet_eigen_domein === 1 && pl.tel.reden.al_kenmerk === 2 && pl.tel.reden.geen_organisatie === 2, pl.tel);
  toets('B eigen adres telt niet mee', pl.tel.adressen === 10, pl.tel);
  const pl2 = R.mailPlan(rijen, { knopen: reg.knopen.map((k) => Object.assign({}, k, { bron_sha: 'oud' })), handvatten: reg.handvatten }, [pA, pB], {});
  toets('B pagina nog niet gecompileerd = wachten', pl2.voorstellen.length === 0 && pl2.tel.reden.pagina_niet_bij >= 1, pl2.tel);
}

// ── C. metMailadres ──
{ const z = 'mail factuur@acme.nl: 2 mails met kloppende DKIM (okt 2026)';
  const y = R.metMailadres(ACME, ACMET, 'factuur@acme.nl', z), q = y.tekst && R.leesPagina(ACME, y.tekst);
  toets('C nieuw veld mailadressen na domeinen, zaad aangevuld, pagina geldig', q && !q.fouten.length && JSON.stringify(q.mailadressen) === '["factuur@acme.nl"]' && q.zaad.length === 2
    && /domeinen: \["acme\.nl"\]\nmailadressen: \["factuur@acme\.nl"\]\n/.test(y.tekst), y);
  toets('C verder niets veranderd (tekst na de frontmatter gelijk)', y.tekst && y.tekst.split('\n---\n')[1] === ACMET.split('\n---\n')[1]);
  const y2 = R.metMailadres(BETA, BETAT, 'nieuw@beta.nl', 'mail nieuw@beta.nl: 2 mails'), q2 = y2.tekst && R.leesPagina(BETA, y2.tekst);
  toets('C bestaande inline-lijst aangevuld; zaad als nieuw veld', q2 && JSON.stringify(q2.mailadressen) === '["oud@beta.nl","nieuw@beta.nl"]' && q2.zaad.length === 1, y2);
  toets('C staat er al = fout, niets geschreven', !!R.metMailadres(BETA, BETAT, 'oud@beta.nl', 'x').fout);
  toets('C blok-lijst wordt niet aangeraakt', /inline-lijst/.test(R.metMailadres(BETA, BETAT.replace('mailadressen: ["oud@beta.nl"]', 'mailadressen:\n  - oud@beta.nl'), 'nieuw@beta.nl', 'x').fout || ''));
  const crlf = R.metMailadres(ACME, ACMET.replace(/\n/g, '\r\n'), 'factuur@acme.nl', z);
  toets('C CRLF blijft CRLF', crlf.tekst && /\r\n/.test(crlf.tekst) && !/[^\r]\n/.test(crlf.tekst));
  toets('C ongeldige pagina = fout', !!R.metMailadres(ACME, 'geen frontmatter', 'a@acme.nl', 'x').fout);
}

// ── D. van logboek tot weekbundel (nep-databank, wegwerpvault) ──
function nepDb() {
  const db = { knopen: [], handvatten: [], contact: [], vertaling: [], bevindingen: [], log: [], kaarten: [] };
  return { db, sbRpc: async function (fn, body) {
    if (fn === 'ovis_register_lees') return JSON.parse(JSON.stringify(db));
    if (fn === 'ovis_pagina_zet') {
      const p = body.p; let k = db.knopen.find((x) => x.id === p.id);
      if (!k) { k = { id: p.id, soort: p.soort, naam: p.naam, vault_pagina: p.vault_pagina, concept: true }; db.knopen.push(k); }
      k.bron_sha = p.bron_sha; k.compilatienummer = p.compilatie;
      p.handvatten.forEach((h) => { const n = R.normHandvat(h.soort, h.waarde); if (!db.handvatten.find((x) => x.knoop === p.id && x.soort === h.soort && x.waarde_norm === n))
        db.handvatten.push({ id: db.handvatten.length + 100, knoop: p.id, soort: h.soort, waarde: h.waarde, waarde_norm: n, status: 'voorgesteld', herkomst: { bron: 'pagina', sha: p.bron_sha } }); });
      return { ok: true, nieuw: true, voorstellen: [], ingetrokken: [], kritiek: [] };
    }
    throw new Error('onbekende rpc ' + fn);
  } };
}
(async () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-'));
  fs.mkdirSync(path.join(v, path.dirname(ACME)), { recursive: true }); fs.writeFileSync(path.join(v, ACME), ACMET);
  const n = nepDb();
  let rijen = [rij(1, 'factuur@acme.nl', 'uitgelijnd', 'org:acme', 'redelijk'), rij(2, 'factuur@acme.nl', 'uitgelijnd', 'org:acme', 'redelijk')];
  let geschreven = 0;
  const m = R.maak({ vault: v, sbRpc: n.sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: (p, t) => fs.writeFileSync(p, t), nu: () => Date.parse('2026-10-29T01:10:00+01:00'),
    intake: { rijen: () => rijen }, eigenAdressen: () => [],
    wijzig: (p, f) => { const t = fs.readFileSync(p, 'utf8'), u = f(t); if (u == null) return false; fs.writeFileSync(p, u); geschreven++; return true; } });
  await m.compileer('dag', {});
  toets('D knoop gecompileerd, nog geen mailkenmerk', n.db.knopen.length === 1 && !n.db.handvatten.some((h) => h.soort === 'mail'), n.db);
  let r = await m.mailVoorstellen({ droog: true, grendel: true });
  toets('D droog: één voorstel, niets geschreven', r.gemeten && r.tel.voorstellen === 1 && r.droog && geschreven === 0 && fs.readFileSync(path.join(v, ACME), 'utf8') === ACMET, r);
  r = await m.mailVoorstellen({ grendel: false });
  toets('D zonder grendel: niets geschreven', r.droog && geschreven === 0, r);
  r = await m.mailVoorstellen({ grendel: true });
  toets('D met grendel: één pagina geschreven, uitvoer zonder adres', r.geschreven === 1 && geschreven === 1 && JSON.stringify(r).indexOf('@') < 0, r);
  r = await m.mailVoorstellen({ grendel: true });
  toets('D tweede keer: niets (pagina nog niet gecompileerd)', r.geschreven === 0 && geschreven === 1 && r.tel.reden.pagina_niet_bij === 1, r);
  await m.compileer('dag', {});
  const hv = n.db.handvatten.find((h) => h.soort === 'mail');
  toets('D na compileren: mailkenmerk voorgesteld bij org:acme', hv && hv.knoop === 'org:acme' && hv.waarde_norm === 'factuur@acme.nl' && hv.status === 'voorgesteld', n.db.handvatten);
  r = await m.mailVoorstellen({ grendel: true });
  toets('D derde keer: al kenmerk, niets geschreven', r.geschreven === 0 && r.tel.reden.al_kenmerk === 1, r);
  const reg = await n.sbRpc('ovis_register_lees', {});
  const b = R.kaartBundel(reg, m.leesAlles(), { nu: Date.parse('2026-10-29T02:30:00+01:00') });
  toets('D weekbundel toont "mail van factuur@acme.nl" met herkomst', b.kaart && b.kaart.stappen.some((s) => /mail van factuur@acme\.nl \(2 mails met kloppende DKIM/.test(s)) && b.kaart.regels.some((x) => x.soort === 'mail' && x.actie === 'activeer'), b);
  rijen = null;
  const m2 = R.maak({ vault: v, sbRpc: n.sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: () => {}, intake: { rijen: () => { throw new Error('intake-logboek ontbreekt'); } } });
  r = await m2.mailVoorstellen({ grendel: true });
  toets('D logboek weg: niet gemeten, niets geschreven', r.gemeten === false && /ontbreekt/.test(r.reden), r);

  // ── E. intakeLezer ──
  const { DatabaseSync } = require('node:sqlite');
  const dbp = path.join(v, 'intake.sqlite'), d = new DatabaseSync(dbp);
  d.exec("CREATE TABLE stuk (stuk_id TEXT, profiel TEXT, meta TEXT, ontvangen TEXT); CREATE TABLE besluit (id INTEGER PRIMARY KEY, stuk_id TEXT, stap TEXT, uitkomst TEXT, bewijskracht TEXT);");
  d.prepare('INSERT INTO stuk VALUES (?,?,?,?)').run('a', 'mail@1', JSON.stringify({ van: 'x@acme.nl' }), '2026-10-28T08:00:00Z');
  d.prepare('INSERT INTO stuk VALUES (?,?,?,?)').run('b', 'outlook-mail@1', JSON.stringify({ van: 'y@acme.nl' }), '2026-10-28T08:00:00Z');
  d.prepare('INSERT INTO stuk VALUES (?,?,?,?)').run('c', 'mail@1', 'geen json', null);
  const ins = d.prepare('INSERT INTO besluit (stuk_id, stap, uitkomst, bewijskracht) VALUES (?,?,?,?)');
  ins.run('a', 'dkim', 'geen_uitslag', null); ins.run('a', 'afzender', 'onbekend', 'geen'); ins.run('a', 'dkim', 'uitgelijnd', null); ins.run('a', 'afzender', 'org:acme', 'redelijk'); ins.run('b', 'dkim', 'uitgelijnd', null);
  d.close();
  const rr = R.intakeLezer(dbp).rijen().sort((a, b) => a.stuk_id < b.stuk_id ? -1 : 1);
  toets('E alleen mail@1, laatste besluit telt, kapotte meta = leeg adres', rr.length === 2 && rr[0].van === 'x@acme.nl' && rr[0].dkim === 'uitgelijnd' && rr[0].afzender === 'org:acme' && rr[0].kracht === 'redelijk' && rr[1].van === '' && rr[1].afzender === null, rr);
  let gooit = false; try { R.intakeLezer(path.join(v, 'weg.sqlite')).rijen(); } catch (e) { gooit = /ontbreekt/.test(e.message); }
  toets('E ontbrekend logboek gooit', gooit);
  console.log(goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering ' + (e && e.stack || e)); process.exit(1); });
JS
