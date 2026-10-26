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
  // wv1271 (K2): oud blok zonder hash en nieuw blok met hash; handwerk binnen het blok
  const oudBlok = TG + '\n' + R.BLOK_BEGIN + '\n## Wat OVIS van deze partij weet\n\n- oud\n' + R.BLOK_EIND + '\n';
  toets('2 oud blok (zonder hash) telt niet mee en is geen handwerk', R.vingerafdruk(oudBlok).sha === a && !R.blokHandwerk(oudBlok));
  toets('2 oud blok wordt vervangen door de nieuwe vorm', /content_hash="/.test(R.zetBlok(oudBlok, R.blokTekst({ id: 'TG' }, [], []))) && R.zetBlok(oudBlok, R.blokTekst({ id: 'TG' }, [], [])).indexOf('- oud') < 0);
  const nieuwBlok = R.zetBlok(TG, R.blokTekst({ id: 'TG', compilatienummer: 3 }, [], []));
  const hand = nieuwBlok.replace('- Herkenningskenmerken: geen', '- Herkenningskenmerken: geen (David: ook "TG Leusden")');
  toets('2 nieuw blok onaangeraakt = geen handwerk', !R.blokHandwerk(nieuwBlok) && R.blokPlek(nieuwBlok).id === 'TG');
  toets('2 getypt binnen het blok = handwerk, vingerafdruk gelijk', R.blokHandwerk(hand) && R.vingerafdruk(hand).sha === a);
  toets('2 CRLF verandert niets aan de hash', !R.blokHandwerk(nieuwBlok.replace(/\n/g, '\r\n')));
  toets('2 twee keer een begin (oud + nieuw) = fout', !!R.vingerafdruk(nieuwBlok + '\n' + R.BLOK_BEGIN + '\n' + R.BLOK_EIND + '\n').fout);
  toets('2 org-id in het blok', R.blokPlek(R.blokTekst({ id: 'org:proef-energie' }, [], [])).id === 'org:proef-energie');
}
// ── 2b. aliases (wv1271): beide namen gelezen, allebei = fout ──
{ const nieuw = R.leesPagina(TGP, TG.replace('aliassen:', 'aliases:'));
  toets('2b aliases gelezen', nieuw.fouten.length === 0 && JSON.stringify(nieuw.aliassen) === '["Tolgaarde","Huisartsenpraktijk Tolgaarde"]', nieuw);
  toets('2b aliases geeft dezelfde handvatten als aliassen', JSON.stringify(R.handvattenVan(nieuw)) === JSON.stringify(R.handvattenVan(R.leesPagina(TGP, TG))));
  const beide = R.leesPagina(TGP, TG.replace('aliassen:', 'aliases: [X]\naliassen:'));
  toets('2b aliases én aliassen = fout', beide.fouten.some((f) => /allebei/.test(f)), beide.fouten);
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
    toets('4 nacht schrijft het blok (met id + content_hash, wv1271)', r.blokken === 1 && /<!-- ovis:blok begin id="TG" content_hash="[0-9a-f]{16}" -->/.test(na) && /KvK 84185171 \(vast\)/.test(na) && !R.blokHandwerk(na), r);
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
    // wv1271 K2: handwerk binnen het blok wordt 's nachts niet overschreven; Bibliothecaris BB8
    const met = fs.readFileSync(path.join(v, TGP), 'utf8');
    const hand = met.replace('KvK 84185171 (vast)', 'KvK 84185171 (vast, nagekeken door David)');
    fs.writeFileSync(path.join(v, TGP), hand);
    n.db.knopen[0].compilatienummer = 99;   // het blok zou anders opnieuw geschreven worden
    r = await m.compileer('nacht', { grendel: true });
    toets('4 handwerk in het blok: niet overschreven', r.blokken === 0 && r.handwerk === 1 && fs.readFileSync(path.join(v, TGP), 'utf8') === hand, r);
    const bb = R.checks(m.leesAlles(), { knopen: n.db.knopen, handvatten: TGH, contact: [], vertaling: VERT, log: [] }).bevindingen;
    toets('4 Bibliothecaris meldt BB8', bb.some((x) => x.check_id === 'BB8' && x.bevinding_id === 'BB8-TG-blok'), bb.map((x) => x.bevinding_id));
    const kb = R.kaartBiblio({ knopen: n.db.knopen, bevindingen: [{ check_id: 'BB8', bevinding_id: 'BB8-TG-blok', ernst: 'warning' }], kaarten: [], log: [] }, { nu: Date.parse('2026-10-26T10:00:00Z') });
    toets('4 BB8 komt op de Bibliothecariskaart', kb.kaart && kb.kaart.stappen.length === 1 && /met de hand/.test(kb.kaart.stappen[0]), kb);
    fs.writeFileSync(path.join(v, TGP), met);
    r = await m.compileer('nacht', { grendel: true });
    toets('4 blok weer onaangeraakt: nacht vernieuwt het', r.handwerk === 0 && r.blokken === 1 && /compilatie 99/.test(fs.readFileSync(path.join(v, TGP), 'utf8')), r);
  }
  // ── 4c. rekeningnummers uit Facturen (wv1360) ──
  { const ORGP = '10_Zakelijk/_Gedeeld/Relaties/Proef Energie.md';
    const ORGT = ['---', 'type: entiteit', 'entiteit_id: org:proef-energie', 'soort: leverancier', 'status: concept', 'naam: Proef Energie', 'aliases: ["Proef Energie Levering"]',
      'domeinen: [proef-energie.nl]', '---', '# Proef Energie', ''].join('\n');
    const MDWP = '10_Zakelijk/Tolgaarde/Medewerkers/Proef Medewerker.md';
    const MDWT = ['---', 'type: medewerker', 'entiteit_id: TG', 'status: actief', '---', '# Proef Medewerker', '', 'Tekst.', ''].join('\n');
    const NIETP = '10_Zakelijk/Tolgaarde/Medewerkers/Index.md';
    const NIETT = ['---', 'type: index', '---', '# Index', ''].join('\n');
    const sha = R.vingerafdruk(ORGT).sha;
    const knoop = { id: 'org:proef-energie', soort: 'organisatie', rol: 'leverancier', naam: 'Proef Energie', aliassen: [], vault_pagina: ORGP, bron_sha: sha, concept: true, compilatienummer: 4, laatst_door: 'compiler' };
    const leeg = R.blokTekst(knoop, [], []);
    toets('4c zonder rekeningen: blok gelijk aan vroeger (ook met lege lijst)', R.blokTekst(knoop, [], [], []) === leeg && leeg.indexOf('Rekeningnummers') < 0);
    const rek = [{ iban: 'NL91ABNA0417164300', doel: 'org:proef-energie', aantal: 24, eerste: '2022-02-03' }, { iban: 'NL20INGB0001234567', doel: null, naam: 'Proef Energie Levering', aantal: 0, eerste: null },
      { iban: 'NL02ABNA0123456789', doel: MDWP, aantal: 7, eerste: '2023-05-01' }, { iban: 'NL44RABO0123456789', doel: NIETP, aantal: 1, eerste: '2024-01-01' },
      { iban: 'NL55RABO0123456789', doel: '10_Zakelijk/../Medewerkers/x.md', aantal: 1, eerste: '2024-01-01' }, { iban: 'NL66RABO0123456789', naam: 'Onbekend BV', aantal: 2, eerste: '2024-01-01' }];
    const HV = [{ id: 9, knoop: 'org:proef-energie', soort: 'alias', waarde: 'Proef Energie Levering', waarde_norm: 'proef energie levering', status: 'voorgesteld' }];
    const met = R.blokTekst(knoop, [], [], R.rekeningenPerDoel(rek, [knoop], HV)['org:proef-energie']);
    toets('4c regel met nummer in groepjes, sinds en aantal; doel via alias', /NL91 ABNA 0417 1643 00 \(betaald sinds 3-2-2022, 24 keer\) · NL20 INGB 0001 2345 67 \(nagebeld, nog niet betaald\)/.test(met), met);
    const pd = R.rekeningenPerDoel(rek, [knoop, Object.assign({}, knoop, { id: 'org:twee', naam: 'Onbekend BV' }), { id: 'TG', soort: 'entiteit', rol: 'eigen', naam: 'Proef Energie Levering' }], HV);
    toets('4c rekening zonder doel: alleen bij precies één knoop, nooit een eigen entiteit', pd['org:proef-energie'].length === 2 && pd['org:twee'].length === 1 && !pd.TG, Object.keys(pd));
    const v = wegwerpVault({ [ORGP]: ORGT, [MDWP]: MDWT, [NIETP]: NIETT });
    const n = nepDb({ knopen: [knoop], handvatten: [], contact: [], vertaling: [], bevindingen: [], log: [] });
    let bron = rek;
    const m = R.maak({ vault: v, sbRpc: n.sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: (p, t) => fs.writeFileSync(p, t), rekeningen: () => { if (bron instanceof Error) throw bron; return bron; } });
    let r = await m.compileer('nacht', { grendel: true });
    const o1 = fs.readFileSync(path.join(v, ORGP), 'utf8'), m1 = fs.readFileSync(path.join(v, MDWP), 'utf8');
    toets('4c nacht: organisatie krijgt de rekeningregel', r.blokken === 1 && /NL91 ABNA 0417 1643 00 \(betaald sinds 3-2-2022, 24 keer\)/.test(o1) && !R.blokHandwerk(o1), r);
    toets('4c nacht: medewerkerpagina krijgt een eigen blok, frontmatter onaangeroerd', r.medewerkerblokken === 1 && /<!-- ovis:blok begin id="mdw:proef-medewerker" content_hash="[0-9a-f]{16}" -->/.test(m1)
      && /- NL02 ABNA 0123 4567 89 \(betaald sinds 1-5-2023, 7 keer\)/.test(m1) && m1.startsWith(MDWT.replace(/\n$/, '')) && R.vingerafdruk(m1).sha === R.vingerafdruk(MDWT).sha, m1);
    toets('4c geen medewerkertype → geen blok, wel gemeld; pad met .. genegeerd', fs.readFileSync(path.join(v, NIETP), 'utf8') === NIETT && r.fouten.some((f) => f.pad === NIETP) && !r.fouten.some((f) => /\.\./.test(f.pad)), r.fouten);
    r = await m.compileer('nacht', { grendel: true });
    toets('4c tweede nacht: niets herschreven', r.blokken === 0 && r.medewerkerblokken === 0 && fs.readFileSync(path.join(v, ORGP), 'utf8') === o1 && fs.readFileSync(path.join(v, MDWP), 'utf8') === m1, r);
    bron = new Error('kapot');
    n.db.knopen[0].compilatienummer = 5;   // het blok zou anders opnieuw geschreven worden
    r = await m.compileer('nacht', { grendel: true });
    const regel = (x) => x.split('\n').find((l) => l.indexOf(R.REK_KOP) === 0);
    let o3 = fs.readFileSync(path.join(v, ORGP), 'utf8');
    toets('4c Facturen niet te lezen: rest van het blok vernieuwd, rekeningregel overgenomen, fout gemeld', r.blokken === 1 && regel(o3) === regel(o1) && /compilatie 5/.test(o3) && !R.blokHandwerk(o3)
      && r.fouten.some((f) => /rekeningnummers niet te lezen/.test(f.fout)) && fs.readFileSync(path.join(v, MDWP), 'utf8') === m1, r);
    bron = null;
    r = await m.compileer('nacht', { grendel: true });
    toets('4c geen Facturen-database (null): niets veranderd (idempotent met overgenomen regel)', r.blokken === 0 && fs.readFileSync(path.join(v, ORGP), 'utf8') === o3, r);
    bron = rek.map((x) => x.iban === 'NL02ABNA0123456789' ? Object.assign({}, x, { aantal: 8 }) : x);
    fs.writeFileSync(path.join(v, MDWP), m1.replace('7 keer)', '7 keer, klopt)'));
    r = await m.compileer('nacht', { grendel: true });
    toets('4c handwerk in het medewerkerblok: niet overschreven', r.medewerkerblokken === 0 && r.handwerk === 1 && /klopt\)/.test(fs.readFileSync(path.join(v, MDWP), 'utf8')), r);
    fs.writeFileSync(path.join(v, MDWP), m1);
    r = await m.compileer('nacht', { grendel: true });
    toets('4c nieuw aantal: medewerkerblok vernieuwd', r.medewerkerblokken === 1 && /8 keer\)/.test(fs.readFileSync(path.join(v, MDWP), 'utf8')), r);
    const o2 = fs.readFileSync(path.join(v, ORGP), 'utf8');
    const m0 = R.maak({ vault: v, sbRpc: n.sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: (p, t) => fs.writeFileSync(p, t) });
    n.db.knopen[0].compilatienummer = 6;
    r = await m0.compileer('nacht', { grendel: true });
    toets('4c zonder bron (oude aanroeper): rekeningregel blijft staan', r.blokken === 1 && regel(fs.readFileSync(path.join(v, ORGP), 'utf8')) === regel(o2) && /24 keer/.test(o2), r);
    // nummer weg uit Facturen: medewerkerblok verdwijnt (alleen ons blok), vingerafdruk gelijk; verhuisde pagina op bestandsnaam gevonden
    const MDW2 = '10_Zakelijk/Groenhouten/Medewerkers/Proef Medewerker.md';
    fs.mkdirSync(path.dirname(path.join(v, MDW2)), { recursive: true });
    fs.renameSync(path.join(v, MDWP), path.join(v, MDW2));
    bron = rek.filter((x) => x.doel !== NIETP);
    r = await m.compileer('nacht', { grendel: true });
    toets('4c verhuisde medewerkerpagina: op bestandsnaam gevonden, blok bijgewerkt (7 keer)', /7 keer\)/.test(fs.readFileSync(path.join(v, MDW2), 'utf8')) && /mdw:proef-medewerker/.test(fs.readFileSync(path.join(v, MDW2), 'utf8')) && !r.fouten.some((f) => /niet gevonden/.test(f.fout)), r);
    bron = rek.filter((x) => x.doel !== MDWP && x.doel !== NIETP);
    r = await m.compileer('nacht', { grendel: true });
    const m3 = fs.readFileSync(path.join(v, MDW2), 'utf8');
    toets('4c nummer weg: medewerkerblok weggehaald, rest van de pagina gelijk', r.medewerkerblokken === 1 && m3.indexOf('ovis:blok') < 0 && R.vingerafdruk(m3).sha === R.vingerafdruk(MDWT).sha, [r, m3]);
    bron = rek.filter((x) => x.doel !== NIETP).map((x) => x.doel === MDWP ? Object.assign({}, x, { doel: '10_Zakelijk/Tolgaarde/Medewerkers/Weg.md' }) : x);
    r = await m.compileer('nacht', { grendel: true });
    toets('4c doel niet te vinden: één gebundelde melding', r.fouten.filter((f) => /niet gevonden/.test(f.fout)).length === 1, r.fouten);
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
    const fn = new Function('require', 'path', 'fs', 'crypto', 'spawn', 'logError', 'schrijfLog', 'nu', 'serverPad', 'serverProefDeel', 'appSbRpc', 'VV', 'VAULT', 'SERVER_ECHT', 'rolPrimair', '__dirname', 'st', 'onderhoud',
      src.slice(b, e).replace('if (ovis && SERVER_ECHT) { setTimeout', 'if (false) { setTimeout') +
      '\novisAms = function () { return st.klok; };\nreturn { ovisTik, ovisInfo, ovisStartScript, ovisStaatLees, ovis };');
    const fouten_ = [];
    const nepRpc = async function (f, body) { st.rpc.push(f);
      if (f === 'ovis_register_lees') return { knopen: [], handvatten: [], contact: [], vertaling: [], bevindingen: [], log: [] };
      if (f === 'mk_hartslag_stempel') return [{}]; if (f === 'ovis_bibliothecaris_zet') return { ok: true }; throw new Error('?'); };
    const k = fn(require, path, fs, require('crypto'), nepSpawn, (w, x) => fouten_.push(w + ' ' + (x && x.message)), () => {}, () => 'nu',
      (n, env, echt, proef) => path.join(dir, n), (d) => path.join(dir, d), nepRpc, () => require('./vault-veilig.js'), path.join(dir, 'vault'), true, () => st.primair, process.cwd(), st, { stand: () => ({ aan: !!st.onderhoud }) });
    st.onderhoud = true; await k.ovisTik();
    toets('6 onderhoudsstand (wv1271): geen nachtronde, geen tik', st.spawns.length === 0 && st.rpc.length === 0);
    st.onderhoud = false;
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

  // ── 7. kaarten (wv1253): bundel, kritiek, Bibliothecaris, Anders, uitkomst, haak ──
  { const src = fs.readFileSync('server.js', 'utf8');
    const gm = /const APP_GEVOELIG = \[([\s\S]*?)\n\];/.exec(src);
    const GEV = eval('[' + gm[1] + ']');
    const gevoelig = (t) => { t = String(t).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase(); for (const [r, re] of GEV) if (re.test(t)) return r; return null; };
    // kopie van machinekamer.voor_jou_verwijzing (gemeten 24-10-2026)
    const verwijzing = (t) => /(^|[^a-z0-9_])wv[0-9]+/i.test(t) || /(mk-scripts\/|\/opt\/data\/)/i.test(t) || /(^|[\s("'‘“/])[0-9]{2}_[A-Z][A-Za-z]+/.test(t) || /[\]a-z0-9)]\.md([^a-z0-9]|$)/i.test(t);
    const grenzen = (k) => k.titel.length >= 3 && k.titel.length <= 90 && k.waarom.length <= 400 && k.stappen.length <= 12 && k.sleutel.length <= 61 && R.KAART_SLEUTEL_RE.test(k.sleutel)
      && ![k.titel, k.waarom].concat(k.stappen).some(verwijzing);
    // eruitUit (Fable #4): alleen met een uitsluitwoord
    const E = (t, n) => JSON.stringify(R.eruitUit(t, n || 12));
    toets('7 Anders "zonder 3 en 7"', E('zonder 3 en 7') === '[3,7]');
    toets('7 Anders "3, 7 eruit" / "niet 2-4." / "regel 5 weg" / "ja, alles behalve 3"', E('3, 7 eruit') === '[3,7]' && E('niet 2-4.') === '[2,3,4]' && E('regel 5 weg') === '[5]' && E('ja, alles behalve 3') === '[3]');
    toets('7 Anders zonder uitsluitwoord of met ander woord = niets', ['3 en 7', 'alleen 3', '3 wel 5 niet', 'zonder 3 maar 7 wel', 'wacht nog even', '', 'zonder 13', 'zonder 0', 'niet 4-2'].every((t) => R.eruitUit(t, 12) === null));
    const pag = (pad, regels) => { const t = ['---', 'type: entiteit'].concat(regels, ['---', 'tekst', '']).join('\n'); const p = R.leesPagina(pad, t); return p; };
    const pTG = pag('10_Zakelijk/Tolgaarde/Entiteit - TG.md', ['entiteit_id: TG', 'soort: eigen', 'status: vast', 'naam: "Huisartsenpraktijk Tolgaarde B.V."', 'domeinen: [huisartsentolgaarde.nl]', 'ovis:', '  db: ["supabase:secondbrain/knoop#TG"]']);
    const pA = pag('10_Zakelijk/_Gedeeld/Relaties/Gemeente Leusden.md', ['entiteit_id: org:gemeente-leusden', 'soort: instantie', 'status: concept', 'naam: Gemeente Leusden', 'domeinen: [leusden.nl]', 'zaad: ["domein leusden.nl: praktijkmail, 5 mails (sep–okt 2026)"]', 'ovis:', '  db: ["supabase:secondbrain/knoop#org:gemeente-leusden"]']);
    const pB = pag('20_Prive/Relaties/Aon.md', ['entiteit_id: org:aon', 'soort: verzekeraar', 'status: concept', 'naam: Aon', 'domeinen: [aon.nl]', 'aliassen: ["Aon Nederland"]', 'zaad: ["domein aon.nl: praktijkmail, 1 mail"]', 'ovis:', '  db: ["supabase:secondbrain/knoop#org:aon"]']);
    const pC = pag('10_Zakelijk/_Gedeeld/Relaties/Dubbel.md', ['entiteit_id: org:dubbel', 'soort: leverancier', 'status: concept', 'naam: Dubbel', 'domeinen: [leusden.nl]', 'ovis:', '  db: ["supabase:secondbrain/knoop#org:dubbel"]']);
    toets('7 fixtures lezen zonder fouten, zaad gelezen', [pTG, pA, pB, pC].every((p) => !p.fouten.length) && pA.zaad.length === 1, [pTG.fouten, pA.fouten, pB.fouten, pC.fouten]);
    const NU = Date.parse('2026-10-26T02:30:00+01:00');
    const regBasis = () => ({
      knopen: [{ id: 'TG', soort: 'entiteit', naam: 'Huisartsenpraktijk Tolgaarde B.V.', vault_pagina: pTG.pad, bron_sha: pTG.sha, agb: null, iban: null },
        { id: 'org:gemeente-leusden', soort: 'organisatie', naam: 'Gemeente Leusden', vault_pagina: pA.pad, bron_sha: pA.sha },
        { id: 'org:aon', soort: 'organisatie', naam: 'Aon', vault_pagina: pB.pad, bron_sha: pB.sha },
        { id: 'org:dubbel', soort: 'organisatie', naam: 'Dubbel', vault_pagina: pC.pad, bron_sha: pC.sha }],
      handvatten: [{ id: 1, knoop: 'TG', soort: 'domein', waarde: 'huisartsentolgaarde.nl', waarde_norm: 'huisartsentolgaarde.nl', status: 'voorgesteld', herkomst: { bron: 'pagina', sha: 'x1' } },
        { id: 2, knoop: 'org:gemeente-leusden', soort: 'domein', waarde: 'leusden.nl', waarde_norm: 'leusden.nl', status: 'voorgesteld', herkomst: { bron: 'pagina', sha: 'x2' } },
        { id: 3, knoop: 'org:aon', soort: 'domein', waarde: 'aon.nl', waarde_norm: 'aon.nl', status: 'voorgesteld', herkomst: { bron: 'pagina', sha: 'x3' } },
        { id: 4, knoop: 'org:aon', soort: 'alias', waarde: 'Aon Nederland', waarde_norm: 'aon nederland', status: 'voorgesteld', herkomst: { bron: 'pagina', sha: 'x3' } },
        { id: 5, knoop: 'org:dubbel', soort: 'domein', waarde: 'leusden.nl', waarde_norm: 'leusden.nl', status: 'voorgesteld', herkomst: { bron: 'pagina', sha: 'x5' } },
        { id: 6, knoop: 'TG', soort: 'kvk', waarde: '84185171', waarde_norm: '84185171', status: 'actief', herkomst: { bron: 'migratie-0002' } }],
      contact: [], bevindingen: [], kaarten: [] });
    const P = [pTG, pA, pB, pC];
    let b = R.kaartBundel(regBasis(), P, { nu: NU });
    toets('7 bundel: sleutel per week, binnen de grenzen, geen pad', b.kaart && b.kaart.sleutel === 'intake-handvat-2026-44' && grenzen(b.kaart), b);
    toets('7 bundel: eigen entiteit eerst, BB5-dubbel (leusden.nl bij twee) niet op de kaart', b.kaart.stappen[0].indexOf('Tolgaarde') > 0 && !b.kaart.regels.some((r) => r.id === 2 || r.id === 5) && b.kaart.regels.length === 3, b.kaart);
    toets('7 bundel: titel zegt "organisaties" en is niet gevoelig (Fable #12)', /bij 2 organisaties/.test(b.kaart.titel) && gevoelig(b.kaart.titel) === null, b.kaart.titel);
    toets('7 bundel: herkomst in gewone taal, privé-organisatie = prive', /mail van @aon\.nl \(praktijkmail, 1 mail\)/.test(b.kaart.stappen.join(' ')) && /op de pagina gezet/.test(b.kaart.stappen[0]) && b.kaart.prive === true, b.kaart.stappen);
    toets('7 bundel: één nummer per organisatie (Aon: twee kenmerken op regel 2)', b.kaart.regels.filter((r) => r.nr === 2).length === 2 && b.kaart.regels.every((r) => r.actie === 'activeer' && r.tabel === 'handvat'));
    let reg = regBasis(); reg.kaarten = [{ sleutel: 'intake-handvat-2026-44', soort: 'bundel', status: 'ja', regels: [] }];
    toets('7 bundel: hooguit één per week', !R.kaartBundel(reg, P, { nu: NU }).kaart);
    reg = regBasis(); reg.kaarten = [{ sleutel: 'intake-handvat-2026-43', soort: 'bundel', status: 'open', regels: [{ nr: 1, tabel: 'handvat', id: '1' }] }];
    toets('7 bundel: geen nieuwe zolang er een open bundel is', /open/.test(R.kaartBundel(reg, P, { nu: NU }).reden));
    reg = regBasis(); reg.kaarten = [{ sleutel: 'intake-handvat-2026-43', soort: 'bundel', status: 'nee', beslist_op: new Date(NU - 5 * 86400000).toISOString(), regels: [{ nr: 1, tabel: 'handvat', id: '3', sha: 'x3' }] }];
    b = R.kaartBundel(reg, P, { nu: NU });
    toets('7 bundel: Nee = vier weken rust voor die regels', b.kaart && !b.kaart.regels.some((r) => r.id === 3) && b.kaart.regels.some((r) => r.id === 4), b.kaart && b.kaart.regels);
    reg.kaarten[0].beslist_op = new Date(NU - 30 * 86400000).toISOString();
    toets('7 bundel: na 28 dagen komt hij terug', R.kaartBundel(reg, P, { nu: NU }).kaart.regels.some((r) => r.id === 3));
    reg = regBasis(); reg.kaarten = [{ sleutel: 'intake-handvat-2026-43', soort: 'bundel', status: 'anders', eruit: [1], beslist_op: new Date(NU - 60 * 86400000).toISOString(), regels: [{ nr: 1, tabel: 'handvat', id: '1', sha: 'x1' }] }];
    toets('7 bundel: eruit-regel blijft weg zolang het kenmerk hetzelfde is', !R.kaartBundel(reg, P, { nu: NU }).kaart.regels.some((r) => r.id === 1));
    reg.handvatten[0].herkomst.sha = 'nieuw';
    toets('7 bundel: eruit-regel terug als de pagina het kenmerk opnieuw voorstelt', R.kaartBundel(reg, P, { nu: NU }).kaart.regels.some((r) => r.id === 1));
    reg = regBasis(); reg.knopen[2].bron_sha = 'oud';
    toets('7 bundel: niet-bijgewerkte pagina wacht', !R.kaartBundel(reg, P, { nu: NU }).kaart.regels.some((r) => r.knoop === 'org:aon'));
    // veel organisaties: hooguit 12 stappen, rest volgende week
    reg = regBasis(); const veel = [];
    for (let i = 0; i < 20; i++) { const id = 'org:o' + i; const pp = pag('10_Zakelijk/_Gedeeld/Relaties/O' + i + '.md', ['entiteit_id: ' + id, 'soort: leverancier', 'status: concept', 'naam: Organisatie ' + i, 'domeinen: [o' + i + '.nl]']);
      veel.push(pp); reg.knopen.push({ id: id, soort: 'organisatie', naam: 'Organisatie ' + i, vault_pagina: pp.pad, bron_sha: pp.sha }); reg.handvatten.push({ id: 100 + i, knoop: id, soort: 'domein', waarde: 'o' + i + '.nl', waarde_norm: 'o' + i + '.nl', status: 'voorgesteld', herkomst: { sha: 's' } }); }
    b = R.kaartBundel(reg, P.concat(veel), { nu: NU });
    toets('7 bundel: hooguit 12 organisaties, de waarom noemt de rest', b.kaart.stappen.length === 12 && /Nog 10 organisaties volgen/.test(b.kaart.waarom) && grenzen(b.kaart), [b.kaart.stappen.length, b.kaart.waarom]);
    // kritiek
    reg = regBasis(); reg.contact = [{ id: 11, knoop: 'org:gemeente-leusden', veld: 'factuuradres', waarde: 'Postbus 1, 3830 AA Leusden', status: 'actief', intrekking: true, herkomst: { vraag_id: 'aaaaaaaa' } },
      { id: 12, knoop: 'org:gemeente-leusden', veld: 'factuuradres', waarde: 'Postbus 2, 3830 AA Leusden', status: 'voorgesteld', herkomst: { sha: 'z' } },
      { id: 13, knoop: 'org:aon', veld: 'telefoon', waarde: '020-0000000', status: 'voorgesteld', herkomst: { sha: 'z' } }];
    reg.handvatten.push({ id: 7, knoop: 'org:aon', soort: 'domein', waarde: 'aon.com', waarde_norm: 'aon.com', status: 'actief', intrekking: true, herkomst: { vraag_id: 'bbbbbbbb' } });
    const pTG2 = Object.assign({}, pTG, { naam: 'Huisartsenpraktijk Tolgaarde BV' });
    let kr = R.kaartenKritiek(reg, [pTG2, pA, pB, pC], { nu: NU });
    const kf = kr.find((k) => /factuuradres/.test(k.sleutel)), kn = kr.find((k) => /-naam-/.test(k.sleutel)), kk = kr.find((k) => /-kenmerk-/.test(k.sleutel));
    toets('7 kritiek: factuuradres oud → nieuw op één kaart, oud vervalt, nieuw actief', kf && kf.regels.length === 2 && kf.regels[0].actie === 'vervallen' && kf.regels[1].actie === 'activeer' && /Oud, vervalt: Postbus 1/.test(kf.stappen.join(' ')) && /Nieuw: Postbus 2/.test(kf.stappen.join(' ')) && /vingerafdruk/.test(kf.waarom), kr);
    toets('7 kritiek: eerste telefoonnummer zonder vaste waarde = geen kaart', !kr.some((k) => /telefoon/.test(k.sleutel)));
    toets('7 kritiek: naamwijziging eigen entiteit en ingetrokken kenmerk elk een kaart', kn && kn.regels[0].actie === 'zet' && kn.regels[0].oud === 'Huisartsenpraktijk Tolgaarde B.V.' && kk && kk.regels[0].actie === 'vervallen', kr.map((k) => k.sleutel));
    toets('7 kritiek: alle kaarten binnen de grenzen', kr.every(grenzen), kr.map((k) => [k.sleutel, k.titel]));
    reg.kaarten = [{ sleutel: kf.sleutel, soort: 'kritiek', status: 'nee', beslist_op: new Date(NU - 40 * 86400000).toISOString(), regels: [] }];
    toets('7 kritiek: Nee = niet opnieuw zolang het voorstel gelijk is', !R.kaartenKritiek(reg, [pTG2, pA, pB, pC], { nu: NU }).some((k) => /factuuradres/.test(k.sleutel)));
    reg.kaarten = [{ sleutel: kf.sleutel, soort: 'kritiek', status: 'weg', beslist_op: new Date(NU - 1 * 86400000).toISOString(), regels: [] }];
    toets('7 kritiek: na weg opnieuw met volgnummer', R.kaartenKritiek(reg, [pTG2, pA, pB, pC], { nu: NU }).some((k) => k.sleutel === kf.sleutel + '-2'));
    // diffreview #3: een kritiek-kaart met meer dan 12 stappen wordt niet gezet (nooit een regel die David niet ziet)
    reg = regBasis(); reg.contact = [];
    for (let i = 0; i < 4; i++) reg.contact.push({ id: 200 + i, knoop: 'org:aon', veld: 'telefoon', waarde: '020-000000' + i, status: 'actief', intrekking: false, herkomst: { vraag_id: 'cccccccc' } });
    for (let i = 0; i < 6; i++) reg.contact.push({ id: 300 + i, knoop: 'org:aon', veld: 'telefoon', waarde: '030-000000' + i, status: 'actief', intrekking: true, herkomst: { vraag_id: 'cccccccc' } });
    for (let i = 0; i < 3; i++) reg.contact.push({ id: 400 + i, knoop: 'org:aon', veld: 'telefoon', waarde: '040-000000' + i, status: 'voorgesteld', herkomst: { sha: 'q' } });
    toets('7 kritiek: te veel regels = geen kaart (niets afgeknipt)', !R.kaartenKritiek(reg, [pTG, pA, pB, pC], { nu: NU }).some((k) => /telefoon/.test(k.sleutel)));
    // Bibliothecaris
    reg = regBasis(); reg.bevindingen = [{ bevinding_id: 'BB2-org:aon-geen-pagina', check_id: 'BB2', status: 'open', samenvatting: 'x' }, { bevinding_id: 'BB3-TG-naam', check_id: 'BB3', status: 'open', ernst: 'warning' },
      { bevinding_id: 'BB3-org:aon-contact-telefoon', check_id: 'BB3', status: 'open', ernst: 'serious' }, { bevinding_id: 'BB5-org:aon-org:dubbel-1234abcd', check_id: 'BB5', status: 'open', samenvatting: 'domein staat bij twee entiteiten (org:aon/org:dubbel)' }];
    b = R.kaartBiblio(reg, { nu: NU });
    toets('7 Bibliothecaris: één kaart per week met voorstel in gewone taal, kritiek en naam niet erop', b.kaart && b.kaart.regels.length === 2 && /Aon: staat in het register maar heeft geen pagina/.test(b.kaart.stappen[0]) && /\(Aon en Dubbel\)/.test(b.kaart.stappen[1]) && grenzen(b.kaart) && gevoelig(b.kaart.titel) === null, b);
    // index.md in Relaties telt niet als entiteitpagina; het zaad (proefmap) leest zonder fouten
    { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ovis-rel-')); fs.mkdirSync(path.join(d, '10_Zakelijk/_Gedeeld/Relaties'), { recursive: true }); fs.mkdirSync(path.join(d, '20_Prive/Relaties'), { recursive: true });
      fs.writeFileSync(path.join(d, '10_Zakelijk/_Gedeeld/Relaties/index.md'), '---\ntype: index\n---\n'); fs.writeFileSync(path.join(d, '10_Zakelijk/_Gedeeld/Relaties/Aon.md'), 'x');
      const m = R.maak({ vault: d, sbRpc: async () => ({}), lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: () => {} });
      toets('7 index.md in Relaties wordt overgeslagen', JSON.stringify(m.vind()) === '["10_Zakelijk/_Gedeeld/Relaties/Aon.md"]', m.vind()); }
    reg = regBasis(); reg.bevindingen = [{ bevinding_id: 'BB2-org:aon-geen-pagina', check_id: 'BB2', status: 'open', samenvatting: 'x' }];
    reg.kaarten = [{ sleutel: 'intake-biblio-2026-43', soort: 'biblio', status: 'ja', beslist_op: new Date(NU - 3 * 86400000).toISOString(), regels: [{ nr: 1, tabel: 'structuur_state', id: 'BB2-org:aon-geen-pagina' }] }];
    toets('7 Bibliothecaris: na een Ja 28 dagen niet opnieuw op de kaart (diffreview #9)', !R.kaartBiblio(reg, { nu: NU }).kaart);
    // uitkomst voor Socev
    const U = R.uitkomstZin;
    toets('7 uitkomst: Ja met aantallen, Nee, al beslist, fout, vaste plek', /de pod heeft 3 gegevens vastgezet/.test(U('bundel', 'ja', { ok: true, status: 'ja', actief: 3, overgeslagen: [] }))
      && /niets vastgezet; deze kenmerken komen over vier weken/.test(U('bundel', 'nee', { ok: true, status: 'nee' })) && /al beslist \(ja\)/.test(U('bundel', 'ja', { ok: false, al: 'ja' }))
      && /NIET vastgelegd/.test(U('bundel', 'ja', { fout_pod: true })) && /vaste plek/.test(U('kritiek', 'ja', { ok: true, status: 'ja', actief: 0, overgeslagen: [{ nr: 1, reden: 'geen verse vingerafdruk' }] }, true))
      && /nog geen antwoord/.test(U('bundel', 'ja', null)) && /vastgelegd \(ja\): 3 vastgezet/.test(U('bundel', 'ja', { ok: false, al: 'ja', uitkomst: { actief: 3 } })) && /Anders zonder nummers/.test(U('bundel', 'anders', { ok: true, status: 'anders', eruit: null })));
    // de haak in server.js (Fable #1): naStart start de RPC, de staart wacht op de echte uitkomst; herkansing bij een netwerkfout
    const b2 = src.indexOf('// ── wv1253: kaarten in Overzicht'), e2 = src.indexOf('// ── einde OVIS-register ──');
    const hk = { rpc: [], fout: 0, berichten: [] };
    const fn2 = new Function('OVIS_MOD', 'appSbRpc', 'berichtIntern', 'schrijfLog', 'nu', 'velden', 'logError', 'ovisStaatZet', 'ovisStaatLees', 'ovis', 'appStaat', 'appVjFnv',
      src.slice(b2, e2) + '\nreturn { ovisKnopHaak, ovisKaartHerkomst, ovisActiveerPoging };');
    const H = fn2(R, async (f, body) => { hk.rpc.push([f, body]); if (hk.fout-- > 0) throw new Error('fetch failed'); return { ok: true, status: body.p.keuze, actief: 2, vervallen: 0, gezet: 0, overgeslagen: [], eruit: body.p.eruit }; },
      async (d) => { hk.berichten.push(d); return { status: 200 }; }, () => {}, () => 'nu', (o) => JSON.stringify(o), () => {}, () => {}, () => ({}), {}, {}, () => 'abcd1234');
    const kaartP = { sleutel: 'intake-handvat-2026-44', titel: 't', herkomst: { module: 'intake', ovis: { kaart: 'intake-handvat-2026-44', soort: 'bundel', regels: [{ nr: 1 }, { nr: 2 }, { nr: 3 }] } } };
    toets('7 haak herkent alleen een echte intake-kaart', H.ovisKaartHerkomst(kaartP) && !H.ovisKaartHerkomst(Object.assign({}, kaartP, { sleutel: 'intake-handvat-2026-45' })) && !H.ovisKaartHerkomst({ sleutel: 'pot-vrijgave-1', herkomst: { module: 'intake', ovis: { kaart: 'pot-vrijgave-1' } } }));
    let h = H.ovisKnopHaak(kaartP, 'zonder 2');
    const staartP = h.staart({ soort: 'telefoon' }); h.naStart('anders', false, { id: 'tel' }, 'knop-anders', 'abcd1234');
    const st1 = await staartP;
    toets('7 haak: Anders "zonder 2" → eruit [2] naar de databank, staart met de echte uitkomst', hk.rpc.length === 1 && JSON.stringify(hk.rpc[0][1].p.eruit) === '[2]' && hk.rpc[0][1].p.vraag_id === 'abcd1234' && /de pod heeft 2 gegevens vastgezet \(zonder nummer\(s\) 2\)/.test(st1), [hk.rpc, st1]);
    h = H.ovisKnopHaak(kaartP, 'alleen 2'); h.naStart('anders', false, {}, 'knop-anders', 'abcd1234');
    toets('7 haak: Anders "alleen 2" → eruit null (niets vast)', hk.rpc[1][1].p.eruit === null);
    console.log('       (herkansing: 30 s wachten wordt niet getoetst; alleen de eerste poging)');
  }
  console.log(goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering ' + (e && e.stack || e)); process.exit(1); });
JS
