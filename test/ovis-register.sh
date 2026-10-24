#!/usr/bin/env bash
# Toetst ovis-register.js (wv979, OVIS-entiteitenregister: compiler + Bibliothecaris; ontwerp + Fable vooraf mk-scripts/wv979/ontwerp.md).
# Toetst: frontmatter als tekst (voorloopnul, inline en blok-lijsten zoals Obsidian ze herschrijft, aanhalingstekens, CRLF, contact genest,
# dubbel veld), vingerafdruk ongevoelig voor het blok en updated: (maar niet voor updated: in de tekst), half blok = fout, validatie (vaste
# plek, bestandsnaam, publiek domein, iban op een organisatie, ongeldige regex, IBAN/BSN in contact of alias), rpcInvoer, compileer tegen een
# nep-databank (alleen gewijzigde pagina's; tweede pagina met hetzelfde id telt niet; nacht zonder grendel schrijft geen blok; blok
# idempotent; pagina die tijdens de ronde verandert krijgt geen blok), Bibliothecaris BB1-BB7 met vaste gegevens (en BB5 niet bij
# niet-dezelfde-als), opgelost/BB7-spoor blijft, afroep stempelt niet, droog schrijft niets, boxRij zonder contactwaarden.
# Raakt niets buiten een wegwerpmap. Gebruik: bash test/ovis-register.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const R = require('./ovis-register.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }

const TG = ['---', 'type: entiteit', 'entiteit_id: TG', 'soort: eigen', 'status: vast', 'naam: "Huisartsenpraktijk Tolgaarde B.V."',
  'aliassen: ["Tolgaarde", "Huisartsenpraktijk Tolgaarde"]', 'kvk: "84185171"', 'agb: 01009870', 'iban: "NL98ABNA0106465317"', 'domeinen: []',
  'contact: {}', 'ovis:', '  db: ["supabase:secondbrain/knoop#TG", "supabase:secondbrain/knoop_vertaling#facturen:entities.key=TOLGAARDE"]',
  'updated: 2026-10-24', '---', '# TG', '', 'Tekst.', ''].join('\n');
const TGP = '10_Zakelijk/Tolgaarde/Entiteit - TG.md';

// ── 1. parser ──
{ const p = R.leesPagina(TGP, TG);
  toets('1 geldige pagina zonder fouten', p.fouten.length === 0, p.fouten);
  toets('1 agb met voorloopnul blijft tekst', p.agb === '01009870');
  toets('1 inline lijst', JSON.stringify(p.aliassen) === '["Tolgaarde","Huisartsenpraktijk Tolgaarde"]');
  toets('1 ovis.db genest', p.db.length === 2 && p.db[0] === 'supabase:secondbrain/knoop#TG', p.db);
  const blok = TG.replace('aliassen: ["Tolgaarde", "Huisartsenpraktijk Tolgaarde"]', 'aliassen:\n  - Tolgaarde\n  - "Huisartsenpraktijk Tolgaarde"')
    .replace('ovis:\n  db: ["supabase:secondbrain/knoop#TG", "supabase:secondbrain/knoop_vertaling#facturen:entities.key=TOLGAARDE"]',
      'ovis:\n  db:\n    - supabase:secondbrain/knoop#TG\n    - supabase:secondbrain/knoop_vertaling#facturen:entities.key=TOLGAARDE');
  const pb = R.leesPagina(TGP, blok);
  toets('1 blok-lijsten (Obsidian) geven dezelfde waarden', JSON.stringify(pb.aliassen) === JSON.stringify(p.aliassen) && JSON.stringify(pb.db) === JSON.stringify(p.db), [pb.aliassen, pb.db, pb.fouten]);
  toets('1 CRLF leest gelijk', JSON.stringify(R.leesPagina(TGP, TG.replace(/\n/g, '\r\n')).aliassen) === JSON.stringify(p.aliassen));
  const c = R.leesPagina(TGP, TG.replace('contact: {}', 'contact:\n  telefoon: "033-4567890"\n  website: https://tolgaarde.nl\n  adres:\n    - Straat 1\n    - Postbus 2'));
  toets('1 contact genest (scalair en lijst)', c.fouten.length === 0 && c.contact.length === 4 && c.contact[0].veld === 'telefoon', c);
  toets('1 dubbel veld = fout', R.leesPagina(TGP, TG.replace('soort: eigen', 'soort: eigen\nsoort: eigen')).fouten.length > 0);
  toets('1 commentaar achter waarde weg, binnen quotes niet', R.leesPagina(TGP, TG.replace('naam: "Huisartsenpraktijk Tolgaarde B.V."', 'naam: "A # B"')).naam === 'A # B'
    && R.leesPagina(TGP, TG.replace('status: vast', 'status: vast # klaar')).status === 'vast');
}
// ── 2. vingerafdruk ──
{ const a = R.vingerafdruk(TG).sha;
  toets('2 updated: telt niet', R.vingerafdruk(TG.replace('updated: 2026-10-24', 'updated: 2026-11-01')).sha === a);
  toets('2 updated: in de tekst telt wel', R.vingerafdruk(TG + '\nupdated: x\n').sha !== a);
  const metBlok = R.zetBlok(TG, R.blokTekst({ compilatienummer: 3, gecompileerd_op: '2026-10-24T22:00:00Z' }, [], []));
  toets('2 blok telt niet', R.vingerafdruk(metBlok).sha === a);
  toets('2 half blok = fout', !!R.vingerafdruk(TG + '\n' + R.BLOK_BEGIN + '\n').fout);
  toets('2 echte wijziging telt', R.vingerafdruk(TG.replace('Tekst.', 'Tekst!')).sha !== a);
  toets('2 zetBlok idempotent', R.zetBlok(metBlok, R.huidigBlok(metBlok)) === metBlok);
}
// ── 3. validatie ──
{ const f = function (t, pad) { return R.leesPagina(pad || TGP, t).fouten.join(' | '); };
  toets('3 verkeerde plek', /vaste plek/.test(f(TG, 'raw_input/Entiteit - TG.md')));
  toets('3 bestandsnaam ≠ id', /bestandsnaam/.test(f(TG, '10_Zakelijk/Tolgaarde/Entiteit - GH.md')));
  const ORG = ['---', 'type: entiteit', 'entiteit_id: org:proef-energie', 'soort: leverancier', 'status: concept', 'naam: Proef Energie',
    'domeinen: [proef-energie.nl]', '---', ''].join('\n');
  const OP = '10_Zakelijk/_Gedeeld/Relaties/Proef Energie.md';
  toets('3 organisatie geldig', f(ORG, OP) === '', f(ORG, OP));
  toets('3 publiek domein geweigerd', /publiek/.test(f(ORG.replace('proef-energie.nl', 'gmail.com'), OP)));
  toets('3 iban op organisatie geweigerd', /iban hoort niet/.test(f(ORG.replace('naam: Proef Energie', 'naam: Proef Energie\niban: NL91ABNA0417164300'), OP)));
  toets('3 organisatie met code-id geweigerd', /org:/.test(f(ORG.replace('org:proef-energie', 'PROEF'), OP)));
  toets('3 ongeldige regex', /regex/.test(f(ORG.replace('naam: Proef Energie', 'naam: Proef Energie\nkenmerkpatronen: ["(["]'), OP)));
  toets('3 IBAN in contact geweigerd', /rekening/.test(f(ORG.replace('naam: Proef Energie', 'naam: Proef Energie\ncontact:\n  adres: "Straat 1, IBAN NL91 ABNA 0417 1643 00"'), OP)));
  toets('3 BSN-achtig in alias geweigerd', /BSN/.test(f(ORG.replace('naam: Proef Energie', 'naam: Proef Energie\naliassen: ["Klant 123456782"]'), OP)));
  toets('3 telefoon van 10 cijfers mag', f(ORG.replace('naam: Proef Energie', 'naam: Proef Energie\ncontact:\n  telefoon: "033-4567890"'), OP) === '');
  toets('3 kvk 7 cijfers geweigerd', /kvk/.test(f(TG.replace('"84185171"', '"8418517"'))));
  toets('3 status ontbreekt', /status/.test(f(TG.replace('status: vast\n', ''))));
  const r = R.rpcInvoer(R.leesPagina(OP, ORG), 7);
  toets('3 rpcInvoer organisatie: soort organisatie, concept, geen iban, domein-handvat', r.soort === 'organisatie' && r.concept === true && r.iban === null
    && r.handvatten.length === 1 && r.handvatten[0].soort === 'domein' && r.compilatie === 7, r);
}

// ── nep-databank ──
function nepDb(start) {
  const db = JSON.parse(JSON.stringify(start || { knopen: [], handvatten: [], contact: [], vertaling: [], bevindingen: [], log: [] }));
  const calls = [];
  return { db, calls, sbRpc: async function (fn, body) {
    calls.push({ fn, body });
    if (fn === 'ovis_register_lees') return JSON.parse(JSON.stringify(db));
    if (fn === 'ovis_pagina_zet') {
      const p = body.p; let k = db.knopen.find((x) => x.id === p.id); const nieuw = !k;
      if (!k) { k = { id: p.id, soort: p.soort, naam: p.naam, vault_pagina: p.vault_pagina, concept: true, laatst_door: 'compiler' }; db.knopen.push(k); }
      k.bron_sha = p.bron_sha; k.compilatienummer = p.compilatie; k.gecompileerd_op = '2026-10-24T23:00:00Z';
      p.handvatten.forEach((h) => { const n = R.normHandvat(h.soort, h.waarde); if (!db.handvatten.find((x) => x.knoop === p.id && x.soort === h.soort && x.waarde_norm === n))
        db.handvatten.push({ id: db.handvatten.length + 100, knoop: p.id, soort: h.soort, waarde: h.waarde, waarde_norm: n, status: 'voorgesteld', herkomst: { bron: 'pagina' } }); });
      return { ok: true, nieuw, voorstellen: k.naam !== p.naam ? [{ veld: 'naam' }] : [], ingetrokken: [], kritiek: [] };
    }
    if (fn === 'ovis_bibliothecaris_zet') { body.p_rijen.forEach((r) => { const b = db.bevindingen.find((x) => x.bevinding_id === r.bevinding_id);
      if (b) Object.assign(b, r); else db.bevindingen.push(Object.assign({}, r)); }); db.bevindingen = db.bevindingen.filter((x) => x.status !== 'opgelost'); return { ok: true }; }
    if (fn === 'mk_hartslag_stempel') return [{ uit_component: body.p_component }];
    throw new Error('onbekende rpc ' + fn);
  } };
}
function wegwerpVault(paginas) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'ovis-'));
  Object.keys(paginas).forEach((rel) => { fs.mkdirSync(path.join(v, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(v, rel), paginas[rel]); });
  return v;
}
function module_(v, n) {
  return R.maak({ vault: v, sbRpc: n.sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: (p, t) => fs.writeFileSync(p, t), nu: () => Date.parse('2026-10-24T23:15:00Z') });
}
const TGRIJ = { id: 'TG', soort: 'entiteit', naam: 'Huisartsenpraktijk Tolgaarde B.V.', vault_pagina: TGP, kvk: '84185171', agb: '01009870', iban: 'NL98ABNA0106465317',
  aliassen: ['Tolgaarde', 'Huisartsenpraktijk Tolgaarde'], concept: false, laatst_door: 'migratie-0002', bron_sha: null, compilatienummer: null };
const TGH = [{ id: 1, knoop: 'TG', soort: 'kvk', waarde: '84185171', waarde_norm: '84185171', status: 'actief', herkomst: { bron: 'migratie-0002' } },
  { id: 2, knoop: 'TG', soort: 'alias', waarde: 'Tolgaarde', waarde_norm: 'tolgaarde', status: 'actief', herkomst: { bron: 'migratie-0002' } },
  { id: 3, knoop: 'TG', soort: 'alias', waarde: 'Huisartsenpraktijk Tolgaarde', waarde_norm: 'huisartsenpraktijk tolgaarde', status: 'actief', herkomst: { bron: 'migratie-0002' } }];
const VERT = [{ bron: 'facturen:entities.key', waarde: 'TOLGAARDE', knoop_ids: ['TG'] }];

(async function () {
  // ── 4. compileer ──
  { const v = wegwerpVault({ [TGP]: TG, 'raw_input/Entiteit - TG.md': TG });
    const n = nepDb({ knopen: [Object.assign({}, TGRIJ)], handvatten: TGH, contact: [], vertaling: VERT, bevindingen: [], log: [] });
    const m = module_(v, n);
    toets('4 vind alleen vaste plekken', JSON.stringify(m.vind()) === JSON.stringify([TGP]), m.vind());
    let r = await m.compileer('dag');
    toets('4 dag: verouderde pagina gestuurd', r.gestuurd === 1 && n.calls.filter((c) => c.fn === 'ovis_pagina_zet').length === 1, r);
    r = await m.compileer('dag');
    toets('4 dag: ongewijzigd = niets gestuurd', r.gestuurd === 0, r);
    r = await m.compileer('nacht');
    toets('4 nacht zonder grendel schrijft geen blok', r.blokken === 0 && fs.readFileSync(path.join(v, TGP), 'utf8') === TG, r);
    r = await m.compileer('nacht', { grendel: true, droog: true });
    toets('4 nacht droog schrijft niets', r.blokken === 1 && fs.readFileSync(path.join(v, TGP), 'utf8') === TG, r);
    r = await m.compileer('nacht', { grendel: true });
    const na = fs.readFileSync(path.join(v, TGP), 'utf8');
    toets('4 nacht schrijft het blok', r.blokken === 1 && na.indexOf(R.BLOK_BEGIN) > 0 && /KvK 84185171 \(vast\)/.test(na), r);
    r = await m.compileer('nacht', { grendel: true });
    toets('4 nacht tweede keer: blok ongewijzigd (idempotent)', r.blokken === 0 && r.gestuurd === 0 && fs.readFileSync(path.join(v, TGP), 'utf8') === na, r);
    toets('4 blok verandert de vingerafdruk niet', R.vingerafdruk(na).sha === n.db.knopen[0].bron_sha);
    // pagina verandert tijdens de ronde
    const n2 = nepDb({ knopen: [Object.assign({}, TGRIJ, { bron_sha: R.vingerafdruk(TG).sha })], handvatten: TGH, contact: [], vertaling: VERT, bevindingen: [], log: [] });
    const v2 = wegwerpVault({ [TGP]: TG });
    let teller = 0;
    const m2 = R.maak({ vault: v2, sbRpc: n2.sbRpc, lees: (p) => { teller++; return teller > 1 ? TG.replace('Tekst.', 'Nieuw.') : fs.readFileSync(p, 'utf8'); }, schrijf: (p, t) => fs.writeFileSync(p, t) });
    r = await m2.compileer('nacht', { grendel: true });
    toets('4 pagina veranderde tijdens de ronde: geen blok', r.blokken === 0 && r.fouten.some((f) => /veranderde/.test(f.fout)), r);
  }
  // ── 5. Bibliothecaris ──
  { const sha = R.vingerafdruk(TG).sha;
    const basis = { knopen: [Object.assign({}, TGRIJ, { bron_sha: sha, laatst_door: 'compiler' })], handvatten: TGH, contact: [], vertaling: VERT, bevindingen: [], log: [] };
    let v = wegwerpVault({ [TGP]: TG });
    let n = nepDb(basis), m = module_(v, n);
    let b = await m.bibliothecaris();
    toets('5 gelijk = 0 bevindingen en stempel', b.open === 0 && b.gestempeld === true && n.calls.some((c) => c.fn === 'mk_hartslag_stempel'), b.bevindingen);
    b = await m.bibliothecaris({ afroep: true });
    toets('5 afroep stempelt niet', !b.gestempeld && n.calls.filter((c) => c.fn === 'mk_hartslag_stempel').length === 1);
    // BB1 vertaalsleutel bestaat niet, BB2 rij zonder pagina, BB3 naam, BB5 dubbel kvk, BB6 kapotte pagina, BB7 buitenschrijver
    const db2 = JSON.parse(JSON.stringify(basis));
    db2.vertaling = [];
    db2.knopen[0].naam = 'Oude naam';
    db2.knopen.push({ id: 'GH', soort: 'entiteit', naam: 'GH', vault_pagina: '10_Zakelijk/Groenhouten/Entiteit - GH.md', laatst_door: 'buiten' });
    db2.handvatten.push({ id: 9, knoop: 'GH', soort: 'kvk', waarde: '84185171', waarde_norm: '84185171', status: 'voorgesteld', herkomst: { bron: 'pagina' } });
    db2.log = [{ id: 1, tabel: 'knoop', sleutel: 'GH', op: 'update', wie: 'buiten', kolommen: ['naam'], wanneer: '2026-10-24T20:00:00Z' }];
    v = wegwerpVault({ [TGP]: TG, '10_Zakelijk/SEL/Entiteit - SEL.md': '---\ntype: entiteit\n' });
    n = nepDb(db2); m = module_(v, n);
    b = await m.bibliothecaris();
    const ids = b.bevindingen.map((x) => x.bevinding_id).join(' ');
    toets('5 BB1 vertaalsleutel', /BB1-TG-/.test(ids), ids);
    toets('5 BB2 rij zonder pagina', /BB2-GH-geen-pagina/.test(ids), ids);
    toets('5 BB3 naam', /BB3-TG-naam/.test(ids), ids);
    toets('5 BB5 kvk bij twee knopen', /BB5-GH-TG-/.test(ids), ids);
    toets('5 BB6 kapotte pagina', /BB6-/.test(ids), ids);
    toets('5 BB7 laatst_door en spoor', /BB7-GH-laatst-door/.test(ids) && /BB7-GH-spoor-20261024/.test(ids), ids);
    toets('5 nieuwe rijen hebben soort, status open', n.calls.filter((c) => c.fn === 'ovis_bibliothecaris_zet')[0].body.p_rijen.every((r) => r.soort === 'bibliothecaris' && r.status === 'open'));
    // BB5 niet bij niet-dezelfde-als
    db2.handvatten.push({ id: 10, knoop: 'GH', soort: 'niet-dezelfde-als', waarde: 'TG', waarde_norm: 'TG', status: 'voorgesteld', herkomst: { bron: 'pagina' } });
    toets('5 BB5 niet bij niet-dezelfde-als', !/BB5-GH-TG-/.test(R.checks(m.leesAlles(), db2).bevindingen.map((x) => x.bevinding_id).join(' ')));
    // opgelost: alles weer gelijk, behalve BB7-spoor blijft
    n.db.knopen = basis.knopen.slice(); n.db.handvatten = TGH.slice(); n.db.vertaling = VERT; n.db.log = [];
    fs.unlinkSync(path.join(v, '10_Zakelijk/SEL/Entiteit - SEL.md'));
    b = await m.bibliothecaris();
    const over = n.db.bevindingen.map((x) => x.bevinding_id);
    toets('5 opgelost; BB7-spoor blijft open', b.open === 0 && b.opgelost >= 5 && over.length === 1 && over[0] === 'BB7-GH-spoor-20261024', over);
    // droog schrijft niets
    const voor = n.calls.length; b = await m.bibliothecaris({ droog: true });
    toets('5 droog: alleen lezen', n.calls.slice(voor).every((c) => c.fn === 'ovis_register_lees'));
    // box-rij zonder contactwaarden
    const db3 = JSON.parse(JSON.stringify(basis));
    db3.contact = [{ id: 1, knoop: 'TG', veld: 'telefoon', waarde: '033-1111111', status: 'actief', herkomst: { vraag_id: 'abc' } },
      { id: 2, knoop: 'TG', veld: 'telefoon', waarde: '033-2222222', status: 'voorgesteld', herkomst: { bron: 'pagina' } }];
    const tg2 = TG.replace('contact: {}', 'contact:\n  telefoon: ["033-1111111", "033-2222222"]');
    v = wegwerpVault({ [TGP]: tg2 }); db3.knopen[0].bron_sha = R.vingerafdruk(tg2).sha;
    n = nepDb(db3); m = module_(v, n);
    b = await m.bibliothecaris();
    const rij = R.boxRij(b, '2026-10-25 02:30');
    toets('5 kritiek contact = BB3 serious', b.bevindingen.some((x) => x.bevinding_id === 'BB3-TG-contact-telefoon' && x.ernst === 'serious'), b.bevindingen);
    toets('5 box-rij zonder waarden', rij.indexOf('033-') < 0 && /\[bibliothecaris\]/.test(rij), rij);
  }
  // ── 5b. diffreview wv979 ──
  { const f = (t, pad) => R.leesPagina(pad || TGP, t).fouten.join(' | ');
    toets('5b eigen entiteit nooit concept', /nooit concept/.test(f(TG.replace('status: vast', 'status: concept'))));
    toets('5b voor alleen codes', /voor noemt/.test(f(TG.replace('contact: {}', 'contact: {}\nvoor: ["Tolgaarde"]'))) && f(TG.replace('contact: {}', 'contact: {}\nvoor: [GH]')) === '');
    toets('5b named group geweigerd', /named group/.test(f(TG.replace('contact: {}', 'contact: {}\nkenmerkpatronen: ["(?<n>[0-9]+)"]'))));
    toets('5b slotregels tellen niet', R.vingerafdruk(TG).sha === R.vingerafdruk(TG + '\n\n\n').sha && R.vingerafdruk(TG).sha === R.vingerafdruk(TG.replace(/\n+$/, '')).sha);
    const sha = R.vingerafdruk(TG).sha;
    const reg = { knopen: [Object.assign({}, TGRIJ, { bron_sha: 'x'.repeat(64), laatst_door: 'compiler' })], handvatten: TGH, contact: [], vertaling: VERT, bevindingen: [], log: [] };
    const c = R.checks([R.leesPagina(TGP, TG)], reg, [{ pad: TGP, fout: 'databank: rpc ovis_pagina_zet http 400: niet-dezelfde-als onbekend' }]);
    toets('5b databankweigering wordt BB6 (niet stil verouderd)', c.bevindingen.some((x) => /^BB6-compileer-/.test(x.bevinding_id)) && c.tel.verouderd === 1, c.bevindingen);
    const verhuisd = R.checks([R.leesPagina('10_Zakelijk/Tolgaarde_oud/Entiteit - TG.md', TG)], { knopen: [Object.assign({}, TGRIJ, { bron_sha: sha })], handvatten: TGH, contact: [], vertaling: VERT, log: [] });
    const vid = verhuisd.bevindingen.map((x) => x.bevinding_id).join(' ');
    toets('5b verhuisde pagina = één BB2 verhuisd, geen BB5', /BB2-TG-verhuisd/.test(vid) && !/BB5/.test(vid), vid);
  }
  // ── 6. koppeling in server.js (blok in een functie met nepomgeving) ──
  { const src = fs.readFileSync('server.js', 'utf8');
    const b = src.indexOf('// ── OVIS-register (wv979'), e = src.indexOf('// ── einde OVIS-register ──');
    toets('6 blok staat in server.js', b > 0 && e > b);
    toets('6 health.ovis en startScript gekoppeld', /ovis: typeof ovisInfo === 'function' \? ovisInfo\(\)/.test(src) && /startScript: ovisStartScript/.test(src));
    toets('6 in RELEASE_OPTIONEEL', /^RELEASE_OPTIONEEL="[^"]*\bovis-register\.js ovis-run\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovis-srv-'));
    const box = path.join(dir, 'vault/00_Systeem/Meldingen/machinekamer.md');
    fs.mkdirSync(path.dirname(box), { recursive: true }); fs.writeFileSync(box, '# box\n\n## [log] 2026-10-24 10:00 — iets\n- status: open\n');
    const st = { klok: { datum: '2026-10-25', uur: 1, min: 15, klok: '2026-10-25 01:15' }, spawns: [], rpc: [], primair: true, kind: { code: 0, uit: '{"ok":true,"paginas":12,"gestuurd":0,"blokken":12,"fouten":[]}' } };
    const nepSpawn = function (cmd, args) {
      st.spawns.push([cmd].concat(args));
      const ee = new (require('events'))(); ee.stdout = new (require('events'))(); ee.stderr = new (require('events'))(); ee.kill = () => {};
      setImmediate(() => { ee.stdout.emit('data', st.kind.uit); ee.emit('exit', st.kind.code); });
      return ee;
    };
    const fn = new Function('require', 'path', 'fs', 'crypto', 'spawn', 'logError', 'schrijfLog', 'nu', 'serverPad', 'serverProefDeel', 'appSbRpc', 'VV', 'VAULT', 'SERVER_ECHT', 'rolPrimair', '__dirname', 'st',
      src.slice(b, e).replace('if (ovis && SERVER_ECHT) { setTimeout', 'if (false) { setTimeout') +
      '\novisAms = function () { return st.klok; };\nreturn { ovisTik, ovisInfo, ovisStartScript, ovisStaatLees, ovis };');
    const fouten_ = [];
    const nepRpc = async function (f, body) { st.rpc.push(f);
      if (f === 'ovis_register_lees') return { knopen: [], handvatten: [], contact: [], vertaling: [], bevindingen: [], log: [] };
      if (f === 'mk_hartslag_stempel') return [{}]; if (f === 'ovis_bibliothecaris_zet') return { ok: true }; throw new Error('?'); };
    const k = fn(require, path, fs, require('crypto'), nepSpawn, (w, x) => fouten_.push(w + ' ' + (x && x.message)), () => {}, () => 'nu',
      (n, env, echt, proef) => path.join(dir, n), (d) => path.join(dir, d), nepRpc, () => require('./vault-veilig.js'), path.join(dir, 'vault'), true, () => st.primair, process.cwd(), st);
    await k.ovisTik();
    toets('6 01:15: nachtronde als kind onder flock -w 300 met ovis-run.js nacht', st.spawns.length === 1 && st.spawns[0][0] === 'flock' && st.spawns[0][1] === '-F' && st.spawns[0][3] === '300' && /ovis-run\.js$/.test(st.spawns[0][6]) && st.spawns[0][7] === 'nacht', st.spawns);
    await k.ovisTik();
    toets('6 tweede tik dezelfde nacht: niet opnieuw', st.spawns.length === 1 && k.ovisStaatLees().nacht_datum === '2026-10-25');
    st.klok = { datum: '2026-10-26', uur: 1, min: 5, klok: '2026-10-26 01:05' }; st.kind = { code: 1, uit: '' };
    await k.ovisTik();
    toets('6 mislukte nacht: niet als gedaan gemarkeerd (herkansen)', k.ovisStaatLees().nacht_datum === '2026-10-25' && k.ovisStaatLees().nacht.ok === false);
    st.klok = { datum: '2026-10-25', uur: 2, min: 31, klok: '2026-10-25 02:31' };
    await k.ovisTik();
    toets('6 02:31: Bibliothecaris met stempel', st.rpc.indexOf('mk_hartslag_stempel') >= 0 && k.ovisStaatLees().biblio_datum === '2026-10-25', st.rpc);
    const n = st.rpc.filter((x) => x === 'mk_hartslag_stempel').length; await k.ovisTik();
    toets('6 02:36: geen tweede Bibliothecaris, wel de dagcompilatie (diffreview #4)', st.rpc.filter((x) => x === 'mk_hartslag_stempel').length === n && st.rpc[st.rpc.length - 1] === 'ovis_register_lees');
    toets('6 geen box-rij zonder nieuwe bevindingen', fs.readFileSync(box, 'utf8').indexOf('[bibliothecaris]') < 0);
    st.klok = { datum: '2026-10-25', uur: 10, min: 0, klok: '2026-10-25 10:00' }; st.primair = false;
    const n2 = st.rpc.length; await k.ovisTik();
    toets('6 passieve kant: niets', st.rpc.length === n2);
    st.primair = true; await k.ovisTik();
    toets('6 overdag: dag-compilatie (alleen lezen bij geen pagina\'s)', st.rpc.length === n2 + 1 && st.rpc[st.rpc.length - 1] === 'ovis_register_lees');
    const r = k.ovisStartScript({ id: 'bibliothecaris' }); const rr = await r.klaar;
    toets('6 Nu draaien: Bibliothecaris zonder stempel', rr.ok === true && st.rpc.filter((x) => x === 'mk_hartslag_stempel').length === 1 && /^ovis[0-9a-f]{12}$/.test(r.job_id), rr);
    toets('6 health zonder inhoud', JSON.stringify(k.ovisInfo()).indexOf('Tolgaarde') < 0 && k.ovisInfo().aan === true);
    toets('6 alleen de bewust mislukte nacht gelogd', fouten_.length === 1 && /^ovis-nacht /.test(fouten_[0]), fouten_);
  }
  console.log(goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering ' + (e && e.stack || e)); process.exit(1); });
JS
