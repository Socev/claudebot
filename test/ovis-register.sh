#!/usr/bin/env bash
# Toetst ovis-register.js (wv979, OVIS-entiteitenregister: compiler + Bibliothecaris; ontwerp + Fable vooraf mk-scripts/wv979/ontwerp.md).
# Toetst: frontmatter als tekst (voorloopnul, inline en blok-lijsten zoals Obsidian ze herschrijft, aanhalingstekens, CRLF, contact genest,
# dubbel veld), vingerafdruk ongevoelig voor het blok en updated: (maar niet voor updated: in de tekst), half blok = fout, validatie (vaste
# plek, bestandsnaam, publiek domein, iban op een organisatie, ongeldige regex, IBAN/BSN in contact of alias), rpcInvoer, compileer tegen een
# nep-databank (alleen gewijzigde pagina's; tweede pagina met hetzelfde id telt niet; nacht zonder grendel schrijft geen blok; blok
# idempotent; pagina die tijdens de ronde verandert krijgt geen blok), Bibliothecaris BB1-BB7 met vaste gegevens (en BB5 niet bij
# niet-dezelfde-als), opgelost/BB7-spoor blijft, afroep stempelt niet, droog schrijft niets, boxRij zonder contactwaarden.
# wv981 (blok 8): plek 4 POT-factuuradres — vergelijking stampagina ⇄ POT-app/dossier/open nota, BB1/BB2/BB5, niet gemeten ≠ opgelost, kaart.
# wv1010 (blok 10): plek 6 bank — rekeningpagina ⇄ bank (entiteit, hoofdrekening), Bankregels, blokken, niet gemeten ≠ opgelost, privacy, lezer.
# wv1011 (blok 11): plek 7 personen — persoonspagina met ovis-blok en zegel, privégrens, alleen gekende soorten sturen (fase B hercompileert),
#   geen blok op een persoonspagina, zegel kapot = niets sturen + BB6 (geen BB2), BB1-object, BB5 object/kenmerk, Google-telefoon, kaarten.
# wv1012 (blok 12): plek 8 D1 fin — entiteit (kvk/map, rekeningnummer ⇄ register kritiek + kaart), medewerker (in/uit dienst alleen uit loonstroken,
# per maand, laatste loonrun als nu, functie), kerncijferblok (schrijven, idempotent, handwerk, niet krimpen), niet gemeten ≠ opgelost, privacy.
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
      if (!k) { k = { id: p.id, soort: p.soort, naam: p.naam, vault_pagina: p.vault_pagina, concept: true, laatst_door: 'compiler' }; db.knopen.push(k);
        if (p.soort === 'persoon') { db.personen = db.personen || { entity: [], contacten: [] }; db.personen.entity.push({ k: p.id, o: p.object_id, status: 'voorgesteld', samengevoegd: false }); } }
      if (p.soort === 'persoon') (db.persoonInvoer = db.persoonInvoer || []).push(p);
      k.bron_sha = p.bron_sha; k.compilatienummer = p.compilatie; k.gecompileerd_op = '2026-10-24T23:00:00Z';
      p.handvatten.forEach((h) => { const n = R.normHandvat(h.soort, h.waarde); if (!db.handvatten.find((x) => x.knoop === p.id && x.soort === h.soort && x.waarde_norm === n))
        db.handvatten.push({ id: db.handvatten.length + 100, knoop: p.id, soort: h.soort, waarde: h.waarde, waarde_norm: n, status: 'voorgesteld', herkomst: { bron: 'pagina' } }); });
      return { ok: true, nieuw, voorstellen: k.naam !== p.naam ? [{ veld: 'naam' }] : [], ingetrokken: [], kritiek: [] };
    }
    if (fn === 'ovis_bibliothecaris_zet') { body.p_rijen.forEach((r) => { const b = db.bevindingen.find((x) => x.bevinding_id === r.bevinding_id);
      if (b) Object.assign(b, r); else db.bevindingen.push(Object.assign({}, r)); }); db.bevindingen = db.bevindingen.filter((x) => x.status !== 'opgelost'); return { ok: true }; }
    if (fn === 'mk_hartslag_stempel') return [{ uit_component: body.p_component }];
    if (fn === 'ovis_personen_lees') { if (db.personenFout) throw new Error('weg'); return JSON.parse(JSON.stringify(db.personen || { entity: [], contacten: [] })); }   // wv1011
    if (fn === 'sb_identifier_te_bevestigen') { if (db.feitenFout) throw new Error('weg'); return JSON.parse(JSON.stringify(db.feiten || [])); }   // wv1789
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
    process.env.BANK_DIR = path.join(dir, 'bank');   // wv1010: nooit de echte bankdatabank in de toets (ontbreekt = niet gemeten)
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
      if (f === 'mk_hartslag_stempel') return [{}]; if (f === 'ovis_bibliothecaris_zet') return { ok: true };
      if (f === 'sb_identifier_te_bevestigen') return [];   // wv1789: feitkaart (geen feiten)
      throw new Error('?'); };
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
    // wv1789: feitkaart (voorgestelde feiten uit de vault; verzonnen waarden)
    const sha = (c) => c.repeat(64);
    const feit = (id, o) => Object.assign({ id: id, object_id: '00000000-0000-4000-8000-00000000000' + (id % 10), knoop: 'TG', naam: 'Huisartsenpraktijk Tolgaarde B.V.', code: 'TG', eigen: true, soort: 'entiteit',
      namespace: 'kenteken', value: 'ZZ-0' + id + '-ZZ', value_norm: 'ZZ0' + id + 'ZZ', label: null, valid_to: null, einde: null, pagina: '10_Zakelijk/Tolgaarde/Auto.md', actie: 'activeer', sha: sha('a') }, o || {});
    const fBasis = () => Object.assign(regBasis(), { feiten: [feit(1, { label: 'Proefbus' }), feit(2, { namespace: 'btw', value: 'NL000000000B01', value_norm: 'NL000000000B01' }),
      feit(3, { actie: 'vervallen', sha: sha('b') }), feit(4, { code: 'PRIVE', naam: 'Privé', pagina: '20_Prive/Auto.md', valid_to: '2025-03-01' })] });
    let fk = R.kaartFeiten(fBasis(), { nu: NU });
    toets('7 feitkaart: sleutel per week, binnen de grenzen, geen pad, sleutelvorm', fk.kaart && fk.kaart.sleutel === 'intake-handvat-feit-2026-44' && R.FEIT_SLEUTEL_RE.test(fk.kaart.sleutel) && grenzen(fk.kaart) && fk.kaart.soort === 'bundel', fk);
    toets('7 feitkaart: één feit per stap, regels (activeer|vervallen, identifier) met sha', fk.kaart.stappen.length === 4 && fk.kaart.regels.length === 4 && fk.kaart.regels.every((r, i) => r.nr === i + 1 && r.tabel === 'identifier' && /^[0-9a-f]{64}$/.test(r.sha)), fk.kaart.regels);
    toets('7 feitkaart: tekst met soort, label, einddatum en vervallen', /1\. Huisartsenpraktijk Tolgaarde B\.V\.: kenteken ZZ-01-ZZ \(Proefbus\)/.test(fk.kaart.stappen[0]) && /btw-nummer NL000000000B01/.test(fk.kaart.stappen[1])
      && /staat niet meer op de pagina — laten vervallen/.test(fk.kaart.stappen[2]) && /tot 1-3-2025/.test(fk.kaart.stappen[3]) && fk.kaart.regels[2].actie === 'vervallen', fk.kaart.stappen);
    toets('7 feitkaart: titel en privé, niet gevoelig', fk.kaart.titel === '4 feiten uit je aantekeningen — kloppen ze?' && fk.kaart.prive === true && gevoelig(fk.kaart.titel) === null && /laten vervallen/.test(fk.kaart.waarom), [fk.kaart.titel, fk.kaart.waarom]);
    reg = fBasis(); reg.feiten.push(feit(5, { namespace: 'iban', value: 'NL00TEST0000000000' }), feit(6, { soort: 'persoon' }), feit(7, { sha: 'kort' }));
    toets('7 feitkaart: nooit IBAN, persoon of feit zonder geldige sha', R.kaartFeiten(reg, { nu: NU }).kaart.regels.every((r) => [5, 6, 7].indexOf(r.id) < 0));
    reg = fBasis(); reg.kaarten = [{ sleutel: 'intake-handvat-feit-2026-43', soort: 'bundel', status: 'open', regels: [{ nr: 1, tabel: 'identifier', id: '1', sha: sha('a') }] }];
    toets('7 feitkaart: geen tweede zolang er een open staat', /open/.test(R.kaartFeiten(reg, { nu: NU }).reden));
    toets('7 feitkaart: een open feitkaart blokkeert de kenmerkenbundel niet', !!R.kaartBundel(reg, P, { nu: NU }).kaart);
    reg = fBasis(); reg.kaarten = [{ sleutel: 'intake-handvat-2026-43', soort: 'bundel', status: 'open', regels: [{ nr: 1, tabel: 'handvat', id: '1' }] }];
    toets('7 feitkaart: een open kenmerkenbundel blokkeert de feitkaart niet', !!R.kaartFeiten(reg, { nu: NU }).kaart);
    reg = fBasis(); reg.kaarten = [{ sleutel: 'intake-handvat-feit-2026-44', soort: 'bundel', status: 'ja', regels: [] }];
    toets('7 feitkaart: hooguit één per week', /al een feitkaart/.test(R.kaartFeiten(reg, { nu: NU }).reden));
    reg = fBasis(); reg.kaarten = [{ sleutel: 'intake-handvat-feit-2026-43', soort: 'bundel', status: 'nee', beslist_op: new Date(NU - 5 * 86400000).toISOString(), regels: [{ nr: 1, tabel: 'identifier', id: '1', sha: sha('a') }] }];
    fk = R.kaartFeiten(reg, { nu: NU });
    toets('7 feitkaart: Nee = vier weken rust; ander feit (andere sha) wel', !fk.kaart.regels.some((r) => r.id === 1) && fk.kaart.regels.length === 3, fk.kaart.regels);
    reg.feiten[0].sha = sha('c');
    toets('7 feitkaart: veranderd feit (nieuwe sha) komt terug', R.kaartFeiten(reg, { nu: NU }).kaart.regels.some((r) => r.id === 1));
    reg = fBasis(); reg.feiten = []; for (let i = 10; i < 30; i++) reg.feiten.push(feit(i));
    fk = R.kaartFeiten(reg, { nu: NU });
    toets('7 feitkaart: hooguit 12 stappen, de waarom noemt de rest', fk.kaart.stappen.length === 12 && /Nog 8 feiten volgen/.test(fk.kaart.waarom) && grenzen(fk.kaart), [fk.kaart.stappen.length, fk.kaart.waarom]);
    reg = regBasis();
    toets('7 feitkaart: feiten niet gelezen of leeg = geen kaart', /niet gelezen/.test(R.kaartFeiten(reg, { nu: NU }).reden) && /geen feiten/.test(R.kaartFeiten(Object.assign(regBasis(), { feiten: [] }), { nu: NU }).reden));
    const pl = R.plan(fBasis(), P, { nu: NU });
    toets('7 plan: feitkaart naast de bundel', pl.kaarten.some((k) => k.sleutel === 'intake-handvat-feit-2026-44') && pl.kaarten.some((k) => k.sleutel === 'intake-handvat-2026-44'), pl.kaarten.map((k) => k.sleutel));
    { const nf = nepDb(); nf.db.feitenFout = true; const mf = R.maak({ vault: wegwerpVault({}), sbRpc: nf.sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: () => {}, nu: () => NU });
      const kf = await mf.kaarten({ soorten: ['bundel', 'feit'], droog: true, vraagId: () => 'abcdef12' });
      toets('7 kaarten: feiten niet te lezen = fout geteld, geen feitkaart, de rest gaat door', kf.fouten.some((x) => x.sleutel === 'feit') && kf.redenen.feit === 'feiten niet gelezen' && 'bundel' in kf.redenen, kf); }
    toets('7 uitkomstZin feit: Nee en Anders in eigen woorden', /deze gegevens komen over vier weken/.test(R.uitkomstZin('feit', null, { ok: true, status: 'nee' })) && /de gegevens komen volgende week/.test(R.uitkomstZin('feit', null, { ok: true, status: 'anders', eruit: null })));
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
  // ── 8. plek 4: POT-factuuradres (wv981; Fable vooraf mk-scripts/wv981/ontwerp.md) — verzonnen praktijken en adressen ──
  {
    const org = (slug, adr, pxs) => ['---', 'type: entiteit', 'entiteit_id: org:' + slug, 'soort: praktijk', 'status: concept', 'naam: "Praktijk ' + slug + '"',
      'aliases: []', 'domeinen: []', 'voor: [SLOEL]', adr ? 'contact:\n  factuuradres: ' + adr : 'contact: {}', 'ovis:',
      '  db: ["supabase:secondbrain/knoop#org:' + slug + '"' + pxs.map((p) => ', "cloudflare:d1-fin/praktijk#' + p + '"').join('') + ']', 'updated: 2026-10-27', '---', '# P', ''].join('\n');
    const pad = (slug) => '10_Zakelijk/_Gedeeld/Relaties/Praktijk ' + slug + '.md';
    const pg = (slug, adr, pxs) => { const p = R.leesPagina(pad(slug), org(slug, adr, pxs)); return p; };
    const reg = (ids) => ({ knopen: ids.map((id) => ({ id: 'org:' + id, soort: 'organisatie', naam: 'Praktijk ' + id, vault_pagina: pad(id), concept: true, laatst_door: 'compiler', bron_sha: pg(id, null, []).sha })), handvatten: [], contact: [], vertaling: [], bevindingen: [], log: [] });
    const PR = [{ id: 'P01', naam: 'A1', email: 'factuur@a.test' }, { id: 'P02', naam: 'A2', email: 'factuur@a.test' }, { id: 'P03', naam: 'A3', email: 'factuur@a.test' },
      { id: 'P04', naam: 'B', email: 'Factuur@B.test' }, { id: 'P09', naam: 'C', email: null }, { id: 'P90', naam: 'Proef', email: 'proef@x.test' }];
    const DOS = () => ({ per: { P01: { aan: ['factuur@a.test'], cc: [] }, P02: { aan: ['factuur@a.test'], cc: [] }, P03: { aan: ['factuur@a.test'], cc: [] }, P04: { aan: ['factuur@b.test'], cc: [] } },
      problemen: { P09: 'op de pagina C staat nog geen factuuradres (veld facturen_aan)' } });
    const basis = () => [pg('a', 'factuur@a.test', ['P01', 'P02', 'P03']), pg('b', 'factuur@b.test', ['P04']), pg('c', null, ['P09'])];
    const pot = (o) => Object.assign({ praktijken: JSON.parse(JSON.stringify(PR)), open: [], dossier: DOS() }, o || {});
    const C = (paginas, p) => R.checks(paginas, reg(['a', 'b', 'c', 'd']), [], p);
    const potB = (r) => r.bevindingen.filter((b) => /pot-/.test(b.bevinding_id));
    let r = C(basis(), pot());
    toets('8 alles gelijk (ook hoofdletters, lege P09, P90 zonder pagina): 0 bevindingen, 5 praktijken gemeten', potB(r).length === 0 && r.tel.pot === 5 && r.tel.pot_verschil === 0 && r.pot.gemeten, [potB(r), r.tel]);
    toets('8 de sleutel telt niet meer als niet getoetst', r.tel.niet_getoetst === 0, r.tel);
    const p2 = pot(); p2.praktijken[1].email = 'nieuw@a.test';
    r = C(basis(), p2);
    toets('8 P02 anders in de POT-app: precies één kritieke BB3 (P02)', potB(r).length === 1 && potB(r)[0].bevinding_id === 'BB3-org:a-pot-factuuradres-P02' && potB(r)[0].ernst === 'serious', potB(r));
    toets('8 geen adressen in bevinding (samenvatting en detail)', !/@/.test(JSON.stringify(r.bevindingen)), r.bevindingen);
    toets('8 verschil voor de kaart draagt wél de adressen', r.pot.verschillen.length === 1 && r.pot.verschillen[0].app[0] === 'nieuw@a.test' && r.pot.verschillen[0].stam[0] === 'factuur@a.test', r.pot.verschillen);
    r = C(basis().concat([pg('d', 'factuur@b.test', ['P04'])]), pot());
    toets('8 twee stampagina\'s op P04: BB5, geen BB3', potB(r).length === 1 && potB(r)[0].check_id === 'BB5', potB(r));
    r = C([pg('a', 'factuur@a.test', ['P01', 'P02', 'P03']), pg('c', null, ['P09'])], pot());
    toets('8 POT-praktijk zonder stampagina: BB2 (P04), niet voor P90', potB(r).length === 1 && potB(r)[0].bevinding_id === 'BB2-pot-P04-geen-pagina', potB(r));
    r = C(basis().concat([pg('d', 'x@d.test', ['P07'])]), pot());
    toets('8 sleutel naar een onbekende praktijk: BB1', potB(r).some((b) => b.bevinding_id === 'BB1-org:d-pot-P07'), potB(r));
    const pc = pot(); pc.dossier.per.P04.cc = ['boekhouding@b.test'];
    r = C(basis(), pc);
    toets('8 cc op de dossierpagina: waarschuwing, niet kritiek', potB(r).length === 1 && potB(r)[0].ernst === 'warning' && /pot-cc-P04/.test(potB(r)[0].bevinding_id), potB(r));
    const pn = pot({ open: [{ id: 1, nummer: 'SL-0001', praktijk_id: 'P04', status: 'concept', aan: 'oud@b.test', cc: null }, { id: 2, nummer: 'SL-0002', praktijk_id: 'P90', status: 'concept', aan: 'iets@x.test' }] });
    r = C(basis(), pn);
    toets('8 open concept met een ander adres: kritiek, P90-nota telt niet', potB(r).length === 1 && /pot-factuuradres-P04/.test(potB(r)[0].bevinding_id) && r.pot.verschillen[0].nota.length === 1, [potB(r), r.pot.verschillen]);
    const pd = pot(); delete pd.dossier.per.P04;
    r = C(basis(), pd);
    toets('8 dossierpagina zonder adres voor P04: verschil (de verzender zou niets sturen)', potB(r).length === 1 && /de dossierpagina/.test(potB(r)[0].detail), potB(r));
    r = C(basis(), { fout: 'D1 http 503' });
    toets('8 POT niet te lezen: geen bevindingen van plek 4, gemeten false', potB(r).length === 0 && r.pot.gemeten === false && r.tel.pot === 'niet gemeten', r.pot);
    // potMeting: alleen de twee SELECT's, fouten worden { fout }
    const gezien = [];
    let m = await R.potMeting({ d1: async (b) => { gezien.push(...b.map((q) => q.sql)); return [{ results: PR }, { results: [] }]; }, dossier: DOS });
    toets('8 potMeting: alleen SELECT, resultaat compleet', gezien.length === 2 && gezien.every((q) => /^select /i.test(q)) && m.praktijken.length === 6 && m.dossier.per.P01, gezien);
    m = await R.potMeting({ d1: async () => { throw new Error('D1 http 500 1234567890'); }, dossier: DOS });
    toets('8 potMeting: D1-fout → fout zonder lange cijferreeks', m.fout && !/1234567/.test(m.fout), m);
    m = await R.potMeting({ d1: async () => [{ results: [] }, { results: [] }], dossier: () => { throw new Error('ENOENT'); } });
    toets('8 potMeting: dossier niet te lezen → fout', !!m.fout, m);
    toets('8 potMeting zonder lezer → fout', !!(await R.potMeting(null)).fout);
    // Bibliothecaris: niet gemeten is niet opgelost (Fable #1)
    { const v = wegwerpVault({ [pad('a')]: org('a', 'factuur@a.test', ['P01', 'P02', 'P03']), [pad('b')]: org('b', 'factuur@b.test', ['P04']), [pad('c')]: org('c', null, ['P09']) });
      const n = nepDb({ knopen: [], handvatten: [], contact: [], vertaling: [], bevindingen: [], log: [] });
      let potIo = { d1: async () => [{ results: p2.praktijken }, { results: [] }], dossier: DOS };
      const mm = R.maak({ vault: v, sbRpc: n.sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: () => {}, nu: () => Date.parse('2026-10-27T01:30:00Z'), get pot() { return potIo; } });
      let b = await mm.bibliothecaris();
      const id = 'BB3-org:a-pot-factuuradres-P02';
      toets('8 biblio: verschil wordt een open bevinding', n.db.bevindingen.some((x) => x.bevinding_id === id && x.status === 'open') && /POT-factuuradressen: 5 praktijk/.test(b.zin), [n.db.bevindingen.map((x) => x.bevinding_id), b.zin]);
      potIo = { d1: async () => { throw new Error('D1 http 503'); }, dossier: DOS };
      b = await mm.bibliothecaris();
      toets('8 biblio: D1 weg → bevinding blijft open, zin zegt niet gemeten', n.db.bevindingen.some((x) => x.bevinding_id === id && x.status === 'open') && b.opgelost === 0 && /niet gemeten/.test(b.zin), [b.opgelost, b.zin]);
      potIo = { d1: async () => [{ results: PR }, { results: [] }], dossier: DOS };
      b = await mm.bibliothecaris();
      toets('8 biblio: gemeten en gelijk → opgelost', !n.db.bevindingen.some((x) => x.bevinding_id === id) && b.opgelost >= 1, [n.db.bevindingen.map((x) => x.bevinding_id), b.opgelost]);
      fs.rmSync(v, { recursive: true, force: true });
    }
    // kaartPot
    r = C(basis(), p2);
    let k = R.kaartPot(r.pot, {}, '27-10 02:31');
    const kp = k.zet[0];
    toets('8 kaart: één, soort doen, prive, herkomst bibliothecaris, sleutel ovis-pot-adres-', k.zet.length === 1 && kp.soort === 'doen' && kp.prive === true && kp.herkomst.handmatig === 'bibliothecaris' && /^ovis-pot-adres-a-[0-9a-f]{6}$/.test(kp.sleutel), kp);
    toets('8 kaart binnen de grenzen, geen .md, adressen in meting', kp.titel.length <= 90 && kp.waarom.length <= 400 && kp.meting.length <= 300 && kp.stappen.length <= 12 && kp.stappen.every((s) => s.length <= 400)
      && !/\.md\b/.test(JSON.stringify(kp)) && /nieuw@a\.test/.test(kp.meting) && !/Obsidian/.test(JSON.stringify(kp)), kp);
    toets('8 kaart: verzender houdt P02 al tegen (pagina ≠ POT-app) → dat staat in waarom', /geen nota klaar/.test(kp.waarom), kp.waarom);
    const pAlleenStam = pot(); const bs = basis(); bs[1] = pg('b', 'ander@b.test', ['P04']);
    const kS = R.kaartPot(C(bs, pAlleenStam).pot, {}, '27-10 02:31').zet[0];
    toets('8 kaart: alleen de stamkaart wijkt af → nota\'s gaan nog naar het oude adres (waarom zegt dat)', /gaan nu nog naar factuur@b\.test/.test(kS.waarom), kS.waarom);
    const pon = pot({ open: [{ id: 4, nummer: 'SL-0004', praktijk_id: 'P04', status: 'auto_vrij', aan: 'oud@b.test' }] });
    const kN = R.kaartPot(C(basis(), pon).pot, {}, 'x').zet[0];
    toets('8 kaart: alleen een open nota wijkt af → waarom zegt dat, niet "verzender houdt tegen"', /al klaarstaat heeft nog een ander adres/.test(kN.waarom) && !/geen nota klaar/.test(kN.waarom) && kN.stappen.some((x) => /niet vanzelf/.test(x)), kN);
    const pg0 = pot({ open: [{ id: 5, nummer: 'SL-0005', praktijk_id: 'P02', status: 'wacht_op_adres', aan: null, cc: null }] }); pg0.praktijken[1].email = 'nieuw@a.test';
    toets('8 kaart: wacht_op_adres zonder adres (geen_adres) → geen tweede kaart', R.kaartPot(C(basis(), pg0).pot, {}, 'x').zet.length === 0, C(basis(), pg0).pot);
    const pS1 = pot({ open: [{ id: 6, nummer: 'SL-0006', praktijk_id: 'P02', status: 'concept', aan: 'oud@a.test' }] }); pS1.praktijken[1].email = 'nieuw@a.test';
    const pS2 = pot({ open: [{ id: 6, nummer: 'SL-0006', praktijk_id: 'P02', status: 'auto_vrij', aan: 'oud@a.test' }] }); pS2.praktijken[1].email = 'nieuw@a.test';
    toets('8 kaart: sleutel gelijk als alleen een notastatus wijzigt', R.kaartPot(C(basis(), pS1).pot, {}, 'x').zet[0].sleutel === R.kaartPot(C(basis(), pS2).pot, {}, 'x').zet[0].sleutel);
    const kv = R.kaartPot(C(basis(), pg0).pot, { [kp.sleutel]: 'open' }, 'x');
    toets('8 kaart: dicht omdat de POT-app het overneemt → bewijs zegt dat', kv.dicht.length === 1 && /neemt het over/.test(kv.dicht[0].bewijs), kv);
    const pV = pot(); pV.praktijken[1].email = 'ander@a.test';
    const kV = R.kaartPot(C(basis(), pV).pot, { [kp.sleutel]: 'open' }, 'x');
    toets('8 kaart: andere adressen → oude dicht met "nieuwe kaart", nieuwe gezet', kV.zet.length === 1 && kV.dicht.length === 1 && /nieuwe kaart/.test(kV.dicht[0].bewijs), kV);
    const pO = pot(); pO.dossier.per.P04.aan = ['factuur@b.test', 'tweede@b.test']; pO.praktijken[3].email = 'tweede@b.test, factuur@b.test';
    const bsO = basis(); bsO[1] = R.leesPagina(pad('b'), org('b', null, ['P04']).replace('contact: {}', 'contact:\n  factuuradres:\n    - factuur@b.test\n    - tweede@b.test'));
    toets('8 volgorde telt zoals bij de verzender (a, b ≠ b, a)', potB(C(bsO, pO)).some((b) => /pot-factuuradres-P04/.test(b.bevinding_id)), potB(C(bsO, pO)));
    toets('8 checks zonder pot-argument: niet gemeten, niets kapot', (() => { const x = R.checks(basis(), reg(['a', 'b', 'c']), []); return x.pot.gemeten === false && x.tel.pot === 'niet gemeten' && potB(x).length === 0; })());
    toets('8 potMeting: nul praktijken = niet gemeten', !!(await R.potMeting({ d1: async () => [{ results: [] }, { results: [] }], dossier: DOS })).fout);
    const kbc = R.kaartBiblio({ knopen: [], kaarten: [], bevindingen: [{ bevinding_id: 'BB3-org:b-pot-cc-P04', check_id: 'BB3', ernst: 'warning', status: 'open' }] }, { nu: Date.parse('2026-10-27T02:31:00Z') });
    toets('8 weekkaart: cc-waarschuwing komt er niet op', !kbc.kaart, kbc);
    toets('8 kaart: zelfde situatie, David zette hem dicht → niet opnieuw', R.kaartPot(r.pot, { [kp.sleutel]: 'gedaan' }, 'x').zet.length === 0);
    toets('8 kaart: staat al open → niet opnieuw, niet dicht', (() => { const x = R.kaartPot(r.pot, { [kp.sleutel]: 'open' }, 'x'); return x.zet.length === 0 && x.dicht.length === 0; })());
    const pw = pot({ open: [{ id: 3, nummer: 'SL-0003', praktijk_id: 'P02', status: 'wacht_op_adres', aan: 'nieuw@a.test' }] }); pw.praktijken[1].email = 'nieuw@a.test';
    toets('8 kaart: pot-verzend heeft al een adreskaart (wacht_op_adres) → geen tweede', R.kaartPot(C(basis(), pw).pot, {}, 'x').zet.length === 0);
    k = R.kaartPot(C(basis(), pot()).pot, { [kp.sleutel]: 'open', 'ovis-pot-adres-z-abcdef': 'gedaan', 'pot-verzend-adres-1': 'open' }, '28-10 02:31');
    toets('8 kaart: verschil weg → open kaart dicht met bewijs; andere kaarten ongemoeid', k.dicht.length === 1 && k.dicht[0].sleutel === kp.sleutel && /niet meer/.test(k.dicht[0].bewijs), k);
    k = R.kaartPot({ gemeten: false, verschillen: [] }, { [kp.sleutel]: 'open' }, 'x');
    toets('8 kaart: niet gemeten → niets zetten en niets dicht', k.zet.length === 0 && k.dicht.length === 0);
    toets('8 POT_BEVINDING_RE: herkent plek 4, niet een gewone org met pot in de naam', R.POT_BEVINDING_RE.test('BB3-org:a-pot-factuuradres-P02') && R.POT_BEVINDING_RE.test('BB2-pot-P04-geen-pagina')
      && R.POT_BEVINDING_RE.test('BB5-pot-P04-twee') && R.POT_BEVINDING_RE.test('BB1-org:d-pot-P07') && !R.POT_BEVINDING_RE.test('BB3-org:de-pot-bakker-naam'));
    // de Bibliothecariskaart van de week zegt bij plek 4 iets dat klopt
    const kb = R.kaartBiblio({ knopen: [], kaarten: [], bevindingen: [{ bevinding_id: 'BB2-pot-P04-geen-pagina', check_id: 'BB2', ernst: 'warning', status: 'open' }] }, { nu: Date.parse('2026-10-27T02:31:00Z') });
    toets('8 weekkaart: BB2 van plek 4 in gewone taal', kb.kaart && /POT-praktijk P04 is nog aan geen pagina/.test(kb.kaart.stappen[0]), kb);
  }
  // ── 9. wv1009: plek 5 — Voor jou ⇄ Open vragen aan David ──
  {
    const KOP = ['# Open vragen aan David', '', '## Register', '| Gesteld | Kanaal | Vraag (zelfstandig leesbaar) | Mijn aanname | Status | Bewijs / laatste toets |', '|---|---|---|---|---|---|'];
    const rij = (g, kanaal, status, vraag) => '| ' + g + ' | ' + kanaal + ' | ' + (vraag || 'Mag dit? Zie [[00_Systeem/X\\|x]].') + ' | Ja | ' + status + ' | gemeten |';
    const NU = Date.parse('2026-10-28T06:15:00Z'), oud = '2026-10-27T10:00:00Z', vers = '2026-10-28T04:00:00Z';
    const P = (sleutel, x) => Object.assign({ sleutel, soort: 'doen', status: 'open', titel: 'Kaart ' + sleutel, waarom: 'Omdat.', herkomst: { wv: [Number(String(sleutel).replace(/^wv(\d+).*$/, '$1')) || 1], auto: 'wv' }, aangemaakt: oud, bijgewerkt: oud, gesloten_op: null, gesloten_door: null, bewijs: null }, x || {});
    const WV = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, status: i + 1 === 2 ? 'open' : i + 1 === 3 ? 'vervallen' : 'klaar' }));
    const meet = async (regels, punten, wv) => R.vjMeting({ punten: async () => ({ punten, op: new Date(NU).toISOString() }), register: () => KOP.concat(regels).join('\n') + '\n', wv: async () => ({ items: wv || WV }) });
    const K = async (regels, punten, ok, wv) => R.vjKoppel(await meet(regels, punten, wv), ok || [], NU);
    const ids = (k) => k.bevindingen.map((b) => b.bevinding_id);
    // parser en kaartverwijzing
    const rr = R.vjRegister(KOP.concat([rij('2026-10-27 10:00', 'machinekamer (wv5, Voor jou-kaart wv5)', 'open'), '| 2026-10-27 11:00 | te | weinig |']).join('\n'));
    toets('9 register: \\| in een wikilink is geen kolomgrens, rij met te weinig cellen telt niet', rr.length === 1 && rr[0].cellen === 6 && /X\|x/.test(rr[0].vraag), rr);
    const g = (k) => R.vjGenoemd({ kanaal: k });
    toets('9 kaartverwijzing: alleen de sleutel direct na "Voor jou-kaart [soort]"', JSON.stringify(g('machinekamer (Voor jou-kaart doen wv1738, eindrapport wv1716, #x)')) === '["wv1738"]'
      && g('app (Voor jou-kaart in Overzicht)').length === 0 && g('machinekamer (wv471, Voor jou-kaart, #olares-herstart)').length === 0 && g('machinekamer (box, Voor jou vervallen)').length === 0
      && JSON.stringify(g('machinekamer (Voor jou-kaart, #wv663 #briefwijzer)')) === '["wv663"]' && JSON.stringify(g('machinekamer (Voor jou-kaart doen, wv88)')) === '["wv88"]' && JSON.stringify(g('machinekamer (wv1414, Voor jou, wv1415)')) === '["wv1415"]'
      && JSON.stringify(g('machinekamer (wv447 → Voor jou wv513, #x)')) === '["wv513"]'
      && JSON.stringify(g('hoofd (Voor jou-kaart in Overzicht, gezet door de pod; sleutel intake-handvat-2026-43; wv1253)')) === '["intake-handvat-2026-43"]');
    // gelijk
    let k = await K([rij('2026-10-27 10:00', 'machinekamer (wv5, Voor jou-kaart wv5)', 'open')], [P('wv5')]);
    toets('9 open rij + open kaart: geen bevinding, gekoppeld', k.gemeten && k.bevindingen.length === 0 && k.tel.gekoppeld === 1, k);
    // rij open, kaart dicht door David
    const r5 = rij('2026-10-27 10:00', 'machinekamer (wv5, Voor jou-kaart wv5, #x5)', 'open — kaart wv5');
    k = await K([r5], [P('wv5', { status: 'gedaan', gesloten_door: 'david', gesloten_op: oud, bijgewerkt: oud, bewijs: 'app 27-10 11:00: David tikte Gedaan' })]);
    toets('9 rij open, kaart Gedaan door David (> 6 u) → BB3 + Status afgehandeld', k.bevindingen.length === 1 && k.bevindingen[0].check_id === 'BB3' && k.acties.length === 1
      && k.acties[0].nieuw === 'afgehandeld 28-10 (Voor jou: David tikte Gedaan 27-10 11:00)', k);
    k = await K([r5], [P('wv5', { status: 'gedaan', gesloten_door: 'david', gesloten_op: vers, bijgewerkt: vers, bewijs: 'app 28-10 05:00: David tikte Gedaan' })]);
    toets('9 kaart pas dicht (< 6 u): nog geen bevinding (rust)', k.bevindingen.length === 0 && k.acties.length === 0, k);
    const knop = P('wv5', { soort: 'besluit', status: 'gedaan', gesloten_door: 'david', gesloten_op: oud, bewijs: 'app 27-10 11:00: David drukte Anders op de kaart (vraag-id ab12cd34)' });
    k = await K([r5], [knop]);
    toets('9 knop Anders → "beantwoord: ANDERS … (app-kaart, vraag-id …)"', k.acties[0] && k.acties[0].nieuw === 'beantwoord: ANDERS 27-10 11:00 (app-kaart, vraag-id ab12cd34)', k.acties);
    const ik = P('intake-handvat-2026-44', { soort: 'besluit', herkomst: { module: 'intake', handmatig: 'intake', ovis: { kaart: 'intake-handvat-2026-44' } }, status: 'gedaan', gesloten_door: 'david', gesloten_op: oud, bewijs: 'app 27-10 10:37: David drukte Ja op de kaart (vraag-id ab12cd99)' });
    k = await K([rij('2026-10-27 02:31', 'hoofd (Voor jou-kaart besluit intake-handvat-2026-44, gezet door de pod)', 'open')], [ik], [{ sleutel: 'intake-handvat-2026-44', status: 'ja', beslist_op: '2026-10-27T09:36:20Z' }]);
    toets('9 Intake-kaart: uitkomst van de OVIS-kaart als extra bewijs', k.acties[0] && /^beantwoord: JA 27-10 10:37 \(app-kaart, vraag-id ab12cd99; OVIS-kaart: ja 27-10 10:36\)$/.test(k.acties[0].nieuw), k.acties);
    k = await K([r5], [P('wv5', { status: 'vervallen', gesloten_door: 'agent', gesloten_op: oud, bewijs: 'Socev wacht hier niet meer op jou; of het gedaan is, is niet gemeten.' })]);
    toets('9 kaart vervallen door de trigger → BB3 melden, niet schrijven (alleen wees)', k.bevindingen.length === 1 && k.acties.length === 0 && /wees/.test(k.bevindingen[0].detail), k);
    k = await K([r5], [P('wv5', { status: 'gedaan', gesloten_door: 'david', gesloten_op: oud, bewijs: 'app 27-10 11:00: David tikte Al beantwoord' })]);
    toets('9 Al beantwoord getikt, rij nog open → alleen melden', k.bevindingen.length === 1 && k.acties.length === 0, k);
    k = await K([r5], [P('wv5', { status: 'vervallen', gesloten_door: 'david', gesloten_op: oud, bewijs: 'app 27-10 11:00: David tikte Niet meer nodig' })]);
    toets('9 Niet meer nodig → zelfde vorm als doorzet', k.acties[0] && k.acties[0].nieuw === 'vervallen — David 27-10 11:00 (app, Voor jou)', k.acties);
    k = await K([r5], [P('wv5', { status: 'gedaan', gesloten_door: 'beheer', gesloten_op: oud, bewijs: '27-10 12:00: De proefserver is verbonden | met de schijf.' })]);
    toets('9 gedaan door de ronde met meting → afgehandeld met dat bewijs (pipe weg)', k.acties[0] && k.acties[0].nieuw === 'afgehandeld 28-10 (Voor jou: 27-10 12:00: De proefserver is verbonden / met de schijf.)', k.acties);
    // opvolging
    k = await K([r5], [P('wv5', { status: 'gedaan', gesloten_door: 'david', gesloten_op: oud, bewijs: 'app 27-10 11:00: David drukte Ja op de kaart' }), P('wv5-2')]);
    toets('9 rij noemt wv5, kaart wv5 dicht maar wv5-2 open → gelijk', k.bevindingen.length === 0, k);
    k = await K([r5], [P('wv5', { status: 'samengevoegd', samengevoegd_in: 'wv9', gesloten_op: oud }), P('wv9')]);
    toets('9 samengevoegde kaart volgt samengevoegd_in (open) → gelijk', k.bevindingen.length === 0, k);
    k = await K([rij('2026-10-27 10:00', 'machinekamer (Voor jou-kaart wv77)', 'open')], [P('wv5')]);
    toets('9 rij noemt een kaart die niet bestaat → BB1', ids(k).filter((x) => /^BB1-/.test(x)).length === 1 && /^BB1-vj-r202610271000-/.test(ids(k).filter((x) => /^BB1-/.test(x))[0]), ids(k));
    // kaart zonder rij (een register zonder één rij telt als niet gemeten; daarom een losse beantwoorde rij erbij)
    const LOS = rij('2026-10-01 09:00', 'hoofd (app)', 'beantwoord 1-10: ja');
    k = await K([LOS], [P('wv6')]);
    toets('9 open auto-kaart zonder rij (> 6 u) → BB2 + nieuwe rij', ids(k).join() === 'BB2-vj-wv6' && k.acties[0].soort === 'nieuw' && /^machinekamer \(Voor jou-kaart doen wv6;/.test(k.acties[0].kanaal) && k.acties[0].gesteld === '2026-10-27 11:00', k);
    k = await K([LOS], [P('wv6', { aangemaakt: vers })]);
    toets('9 kaart net gezet (< 6 u) → nog niets', k.bevindingen.length === 0 && k.acties.length === 0, k);
    k = await K([LOS], [P('scansnap-ab12cd34ef', { soort: 'besluit', herkomst: { stuk: 'x', handmatig: 'scansnap' } }), P('facturen-2026-10-27', { herkomst: { module: 'facturen' } })]);
    toets('9 module- en verzamelkaarten zonder rij → geen plicht', k.bevindingen.length === 0, k);
    k = await K([LOS], [P('intake-handvat-2026-45', { soort: 'besluit', herkomst: { module: 'intake', handmatig: 'intake', ovis: { kaart: 'intake-handvat-2026-45' } } })]);
    toets('9 Intake-bundelkaart zonder rij → nieuwe rij met Kanaal hoofd en de sleutel', k.acties[0] && /^hoofd \(Voor jou-kaart besluit intake-handvat-2026-45, gezet door de pod;/.test(k.acties[0].kanaal), k.acties);
    k = await K([LOS], [P('wv7', { soort: 'besluit', herkomst: {} })]);
    toets('9 besluit zonder wv/register-bron (handmatig, titel met ?) → geen plicht', k.bevindingen.length === 0, k);
    // herkomst.register
    const reg2 = [rij('2026-10-27 10:00', 'machinekamer (#a1)', 'open'), rij('2026-10-27 10:00', 'machinekamer (#a2)', 'open')];
    k = await K(reg2, [P('wv8', { soort: 'besluit', herkomst: { register: ['2026-10-27 10:00'] } })]);
    toets('9 herkomst.register past op twee rijen → BB5', ids(k).some((x) => /^BB5-vj-wv8-reg-/.test(x)), ids(k));
    k = await K(reg2, [P('wv8', { soort: 'besluit', herkomst: { register: ['2026-10-27 10:00#a1'] } }), P('wv9', { soort: 'besluit', herkomst: { register: ['2026-10-27 10:00#a2'] } })]);
    toets('9 herkomst.register met #kenmerk koppelt elk aan zijn eigen rij', k.bevindingen.length === 0 && k.tel.gekoppeld === 2, k);
    k = await K(reg2, [P('wv8', { soort: 'besluit', herkomst: { register: ['2026-10-26 09:00#weg'] } })]);
    toets('9 herkomst.register wijst naar een rij die er niet is → BB1 (en BB2: geen rij)', ids(k).some((x) => /^BB1-vj-wv8-reg-/.test(x)) && ids(k).indexOf('BB2-vj-wv8') >= 0, ids(k));
    // rij dicht, kaart open
    k = await K([rij('2026-10-27 10:00', 'machinekamer (Voor jou-kaart wv5)', 'beantwoord 27-10 11:00: JA')], [P('wv5', { soort: 'besluit' })]);
    toets('9 besluitkaart open, rij al beantwoord → BB3 (machinekamer), geen schrijfactie', ids(k).join() === 'BB3-vj-wv5-dicht' && k.acties.length === 0, k);
    k = await K([rij('2026-10-27 10:00', 'machinekamer (Voor jou-kaart wv5)', 'beantwoord 27-10 11:00: JA, ik doe het')], [P('wv5')]);
    toets('9 doen-kaart open bij een beantwoorde vraag ("ik doe het") → gewoon, geen bevinding (review #6)', k.bevindingen.length === 0, k);
    // review #1/#2/#3: vervangingskaart, de tik al in de rij, de klus erachter nog niet klaar, sluiten zonder meting
    const tik = P('wv5', { status: 'gedaan', gesloten_door: 'david', gesloten_op: oud, bewijs: 'app 27-10 11:00: David tikte Gedaan' });
    k = await K([rij('2026-10-22 10:00', 'machinekamer (wv74 → Voor jou wv5, #x)', 'open')], [tik, P('wv17', { titel: 'Kaart wv5', herkomst: { wv: [17], auto: 'wv' } })]);
    toets('9 open vervangingskaart (zelfde titel, ander nummer) → niets schrijven, geen verschil (wv854)', k.bevindingen.length === 0 && k.acties.length === 0 && k.tel.vervangen === 1, k);
    k = await K([rij('2026-10-22 10:00', 'machinekamer (Voor jou-kaart wv5)', 'open — kaart wv17 vervangt hem')], [tik, P('wv17', { titel: 'Anders', herkomst: { wv: [17], auto: 'wv' } })]);
    toets('9 Status noemt de open vervangingskaart → niets schrijven', k.acties.length === 0 && k.tel.vervangen === 1, k);
    k = await K([rij('2026-10-22 10:00', 'machinekamer (Voor jou-kaart wv5)', 'open')], [tik, P('wv17', { titel: 'Iets anders', herkomst: { wv: [17], auto: 'wv' } })], [], WV.map((w) => w.id === 17 ? Object.assign({}, w, { status: 'geblokkeerd', ouder_id: 5 }) : w));
    toets('9 open kaart van een kindrij (ouder_id) van de klus achter de dichte kaart = vervanger → niets schrijven, geen tweede rij', k.acties.length === 0 && k.bevindingen.length === 0 && k.tel.vervangen === 1, k);
    k = await K([rij('2026-10-22 10:00', 'machinekamer (Voor jou-kaart wv5)', 'open — de Gedaan-tik van 27-10 11:00 gaf geen herstart')], [tik]);
    toets('9 rij noemt de tik al → alleen melden (wv714)', k.acties.length === 0 && k.bevindingen.length === 1 && /noemt deze tik al/.test(k.bevindingen[0].detail), k);
    const tik2 = P('wv5', { herkomst: { wv: [2], auto: 'wv' }, status: 'gedaan', gesloten_door: 'david', gesloten_op: oud, bewijs: 'app 27-10 11:00: David tikte Gedaan' });
    k = await K([r5], [tik2]);
    toets('9 Gedaan, werkvoorraadrij nog open → onderweg: geen bevinding, niets schrijven', k.bevindingen.length === 0 && k.acties.length === 0 && k.tel.onderweg === 1, k);
    k = await K([r5], [Object.assign({}, tik2, { gesloten_op: '2026-10-23T10:00:00Z' })]);
    toets('9 … na drie dagen nog steeds niet klaar → BB3 melden', k.bevindingen.length === 1 && k.acties.length === 0 && /al meer dan drie dagen/.test(k.bevindingen[0].detail), k);
    k = await K([r5], [Object.assign({}, tik2, { herkomst: { wv: [3], auto: 'wv' } })]);
    toets('9 Gedaan, werkvoorraadrij vervallen → alleen melden', k.acties.length === 0 && /verviel/.test(k.bevindingen[0].detail), k);
    k = await K([r5], [tik2], [], null);
    toets('9 Gedaan, werkvoorraad niet te lezen → niet schrijven', k.acties.length === 0, k);
    k = await K([r5], [P('wv5', { soort: 'besluit', status: 'gedaan', gesloten_door: 'agent', gesloten_op: oud, bewijs: 'Er wacht niets meer op jou: de vraag is beantwoord, de taak afgevinkt of de klus erachter is klaar.' })]);
    toets('9 dicht door sync zonder meting → alleen melden (review #3)', k.acties.length === 0 && k.bevindingen.length === 1, k);
    k = await K([r5], [P('wv5', { status: 'gedaan', gesloten_door: 'agent', gesloten_op: oud, bewijs: 'Gemeten 26-10 12:12: de proefserver is verbonden.' })]);
    toets('9 dicht door een agent mét meting ("Gemeten d-m uu:mm: …") → afgehandeld', k.acties.length === 1 && /^afgehandeld 28-10 \(Voor jou: Gemeten 26-10 12:12/.test(k.acties[0].nieuw), k.acties);
    // review #4: losse vermelding = twijfel
    k = await K([LOS, rij('2026-10-27 10:00', 'machinekamer (Voor jou-kaart zonder nummer, zie wv6)', 'open')], [P('wv6')]);
    toets('9 kaart alleen los genoemd (niet in de vaste vorm) → geen nieuwe rij en geen "zonder kaart"', k.acties.length === 0 && k.bevindingen.length === 0 && k.tel.twijfel === 2, k);
    // review #10: twee open rijen bij één besluitkaart
    const kn2 = P('wv5', { soort: 'besluit', herkomst: { wv: [1], auto: 'wv', register: ['2026-10-27 10:00#x5'] }, status: 'gedaan', gesloten_door: 'david', gesloten_op: oud, bewijs: 'app 27-10 11:00: David drukte Ja op de kaart (vraag-id ab12cd34)' });
    k = await K([r5, rij('2026-10-26 10:00', 'machinekamer (Voor jou-kaart wv5, #tweede)', 'open')], [kn2]);
    toets('9 twee open rijen bij één besluit: alleen de rij van herkomst.register[0] krijgt het antwoord, de ander BB5', k.acties.length === 1 && k.acties[0].gesteld === '2026-10-27 10:00' && ids(k).indexOf('BB5-vj-wv5-twee') >= 0, [k.acties, ids(k)]);
    // geparkeerd en zonder kaart
    k = await K([rij('2026-10-08 19:41', 'debug (agentrapport wv20)', 'wacht — pas voorleggen bij …'), rij('2026-10-07 13:30', 'machinekamer (Voor jou-kaart wv5)', 'uitgesteld door David')], [P('wv5', { status: 'gedaan', gesloten_door: 'david', gesloten_op: oud, bewijs: 'app 27-10 11:00: David tikte Gedaan' })]);
    toets('9 wacht/uitgesteld (geparkeerd) → geen bevinding', k.bevindingen.length === 0, k);
    k = await K([rij('2026-10-25 10:00', 'hoofd (app)', 'open'), rij('2026-10-28 06:00', 'hoofd (app)', 'open')], [P('wv1', { status: 'gedaan', gesloten_op: oud })]);
    toets('9 open rij zonder kaart: na 48 u BB2, daarvoor niet', ids(k).length === 1 && /^BB2-vj-r202610251000-/.test(ids(k)[0]), ids(k));
    // niet gemeten
    toets('9 vjMeting: nul punten / register onleesbaar = niet gemeten', !!(await R.vjMeting({ punten: async () => ({ punten: [] }), register: () => KOP.join('\n') })).fout
      && !!(await R.vjMeting({ punten: async () => ({ punten: [P('wv1')] }), register: () => { throw new Error('ENOENT'); } })).fout
      && R.vjKoppel({ fout: 'x' }, [], NU).gemeten === false);
    // vjSchrijf
    const tekst = KOP.concat([r5, rij('2026-10-27 09:00', 'machinekamer (Voor jou-kaart wv6)', 'open')]).join('\n') + '\n';
    k = await K([r5, rij('2026-10-27 09:00', 'machinekamer (Voor jou-kaart wv6)', 'open')], [P('wv5', { status: 'gedaan', gesloten_door: 'david', gesloten_op: oud, bewijs: 'app 27-10 11:00: David tikte Gedaan' }), P('wv6'), P('wv12')]);
    let s = R.vjSchrijf(tekst, k.acties);
    toets('9 vjSchrijf: Status vooraan met "— eerder:", nieuwe rij direct onder de kop', s.gedaan.length === 2 && s.tekst.indexOf('| afgehandeld 28-10 (Voor jou: David tikte Gedaan 27-10 11:00) — eerder: open — kaart wv5 |') > 0
      && s.tekst.split('\n')[5].indexOf('| 2026-10-27 11:00 | machinekamer (Voor jou-kaart doen wv12;') === 0, s);
    const k2 = R.vjKoppel(await R.vjMeting({ punten: async () => ({ punten: [P('wv5', { status: 'gedaan', gesloten_door: 'david', gesloten_op: oud, bewijs: 'app 27-10 11:00: David tikte Gedaan' }), P('wv6'), P('wv12')] }), register: () => s.tekst }), [], NU);
    toets('9 vjSchrijf: tweede ronde vindt niets meer (idempotent)', k2.bevindingen.length === 0 && k2.acties.length === 0, k2);
    toets('9 vjSchrijf: nieuwe rij niet dubbel als hij er al staat', R.vjSchrijf(s.tekst, k.acties.filter((a) => a.soort === 'nieuw')).tekst === null);
    s = R.vjSchrijf(tekst.replace('| open — kaart wv5 |', '| beantwoord 28-10 06:00: ja |'), k.acties.filter((a) => a.soort === 'status'));
    toets('9 vjSchrijf: Status intussen veranderd → niet aanraken', s.tekst === null && /veranderde/.test(s.overgeslagen[0].reden), s);
    s = R.vjSchrijf(tekst + r5 + '\n', k.acties.filter((a) => a.soort === 'status'));
    toets('9 vjSchrijf: twee rijen met dezelfde Gesteld en Kanaal → niet aanraken', s.tekst === null && /2 passende/.test(s.overgeslagen[0].reden), s);
    s = R.vjSchrijf(tekst.replace(/\n/g, '\r\n'), k.acties);
    toets('9 vjSchrijf: CRLF blijft CRLF', s.tekst && s.tekst.indexOf('\r\n') > 0 && s.tekst.split('\r\n').length === tekst.split('\n').length + 1, s.gedaan);
    // Bibliothecaris: plek 5 meet mee, niet gemeten = niet opgelost, geen weekkaart voor David
    { const v = wegwerpVault({ [TGP]: TG });
      const n = nepDb({ knopen: [], handvatten: [], contact: [], vertaling: [], bevindingen: [], log: [] });
      let vjIo = { punten: async () => ({ punten: [P('wv5', { status: 'gedaan', gesloten_door: 'david', gesloten_op: oud, bewijs: 'app 27-10 11:00: David tikte Gedaan' }), P('wv1', { status: 'gedaan', gesloten_op: oud })] }), register: () => KOP.concat([r5]).join('\n'), wv: async () => ({ items: WV }) };
      const mm = R.maak({ vault: v, sbRpc: n.sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: () => {}, nu: () => NU, get vj() { return vjIo; } });
      let b = await mm.bibliothecaris();
      const b0 = b;
      const id = n.db.bevindingen.map((x) => x.bevinding_id).find((x) => /^BB3-vj-/.test(x));
      toets('9 biblio: plek-5-verschil wordt een open bevinding, zin noemt Voor jou', !!id && /Voor jou ⇄ register: 0 open kaart\(en\), 1 open vraag/.test(b.zin) && b.vj.gemeten, [n.db.bevindingen.map((x) => x.bevinding_id), b.zin]);
      vjIo = { punten: async () => { throw new Error('rpc mk_voor_jou_lijst http 503'); }, register: () => '' };
      b = await mm.bibliothecaris();
      toets('9 biblio: Voor jou niet te lezen → bevinding blijft open, zin zegt niet gemeten', n.db.bevindingen.some((x) => x.bevinding_id === id && x.status === 'open') && b.opgelost === 0 && /Voor jou ⇄ register niet gemeten/.test(b.zin), [b.opgelost, b.zin]);
      const kb9 = R.kaartBiblio({ knopen: [], kaarten: [], bevindingen: n.db.bevindingen }, { nu: NU });
      toets('9 weekkaart: plek 5 komt er niet op (machinestaat)', !kb9.kaart || !kb9.kaart.regels.some((x) => /^BB\d-vj-/.test(x.id)), kb9);
      const kb9b = R.kaartBiblio({ knopen: [], kaarten: [], bevindingen: [{ bevinding_id: 'BB2-vj-wv6', check_id: 'BB2', ernst: 'warning', status: 'open' }, { bevinding_id: 'BB1-vj-r202610271000-abcdef', check_id: 'BB1', ernst: 'warning', status: 'open' }, { bevinding_id: 'BB5-vj-wv8-reg-abcdef', check_id: 'BB5', ernst: 'warning', status: 'open' }] }, { nu: NU });
      toets('9 weekkaart: alleen plek-5-bevindingen → geen kaart', !kb9b.kaart && kb9b.reden === 'geen open verschillen', kb9b);
      toets('9 biblio: wat de ronde zelf rechtzet telt niet voor de box (nieuw_box), wel voor nieuw', b0.nieuw >= 1 && b0.nieuw_box === b0.nieuw - 1 && !b0.nieuwe.some((x) => x.bevinding_id === id), [b0.nieuw, b0.nieuw_box]);
      toets('9 boxRij: regel voor plek 5 als er een nieuwe vj-bevinding is', /plek 5 \(Voor jou/.test(R.boxRij({ nieuw: 1, zin: 'x', nieuwe: [{ bevinding_id: id, check_id: 'BB3', samenvatting: 's' }] }, 't')));
      vjIo = { punten: async () => ({ punten: [P('wv5', { status: 'gedaan', gesloten_door: 'david', gesloten_op: oud, bewijs: 'app 27-10 11:00: David tikte Gedaan' })] }), register: () => KOP.concat([r5.replace('| open — kaart wv5 |', '| afgehandeld 28-10 — eerder: open |')]).join('\n'), wv: async () => ({ items: WV }) };
      b = await mm.bibliothecaris();
      toets('9 biblio: gemeten en gelijk → opgelost', !n.db.bevindingen.some((x) => x.bevinding_id === id) && b.opgelost >= 1, [n.db.bevindingen.map((x) => x.bevinding_id), b.opgelost]);
      fs.rmSync(v, { recursive: true, force: true });
    }
  }
  // ── 10. plek 6: bank (wv1010; Fable vooraf mk-scripts/wv1010/ontwerp.md) — verzonnen rekeningen, nummers en namen ──
  {
    const IA = 'NL00TEST0000000011', IB = 'NL00TEST0000000022', IC = 'NL00TEST0000000033', IP = 'NL00TEST0000000044', IX = 'NL00TEST0000000055';
    const REKP = (naam, e) => '20_Prive/Financien/Rekeningen/Rekening - ' + naam + ' (' + e + ').md';
    const POTP = '10_Zakelijk/POT_POH_GGZ/Rekening - POT (0044).md';
    const rekTekst = (iban, ent, extra) => ['---', 'type: rekening', 'iban: "' + iban + '"', 'entiteit_id: ' + ent, 'doel: ""', 'status: actueel', 'updated: 2026-10-27', 'ovis:',
      '  db: ["pod:bank-transacties/rekening#' + iban + '"]', '---', '# Rekening', '', 'Stampagina.', extra || ''].join('\n');
    const REGELS_T = ['---', 'type: gegenereerd', 'ovis:', '  db: ["pod:bank-transacties/regels"]', '---', '# Bankregels', '', 'Uitleg.', ''].join('\n');
    const M = () => ({
      rekeningen: [{ rek: 'ra', bron: 'bunq', iban: IA, status: 'ACTIVE', gezamenlijk: 0, eigenaar: 'David', eigenaar_herkomst: 'systeem' },
        { rek: 'rb', bron: 'bunq', iban: IB, status: 'ACTIVE', gezamenlijk: 0, eigenaar: 'kind', eigenaar_herkomst: 'machinekamer' },
        { rek: 'rc', bron: 'bunq', iban: IC, status: 'CANCELLED', gezamenlijk: 0, eigenaar: 'David', eigenaar_herkomst: 'systeem' },
        { rek: 'rp', bron: 'abn', iban: IP, status: 'ACTIVE', gezamenlijk: 0, eigenaar: 'POT', eigenaar_herkomst: 'systeem' }],
      posten: [{ rek: 'ra', n: 10, van: '2019-03-02', tot: '2026-10-20' }, { rek: 'rp', n: 4, van: '2016-09-01', tot: '2026-10-01' }],
      regels: [{ id: 1, soort: 'extern', patroon: 'rb', rek: null, richting: 'af', type: null, categorie: 'cadeaus', subcategorie: null, eigenaar: null, herkomst: 'machinekamer', actief: 1, aangemaakt: '2026-10-21T14:00:00Z', bron_nr: null },
        { id: 2, soort: 'tegenpartij', patroon: 'jan de proef', rek: null, richting: 'af', type: null, categorie: 'vrienden', subcategorie: null, eigenaar: null, herkomst: 'david', actief: 1, aangemaakt: '2026-10-22T10:00:00Z', bron_nr: 5 },
        { id: 3, soort: 'tegenpartij', patroon: 'proefstroom bv', rek: null, richting: 'af', type: null, categorie: 'wonen', subcategorie: null, eigenaar: null, herkomst: 'david', actief: 1, aangemaakt: '2026-10-22T10:00:00Z', bron_nr: 6 },
        { id: 4, soort: 'tegenpartij', patroon: 'medewerker proef', rek: 'rp', richting: 'af', type: null, categorie: 'salaris', subcategorie: null, eigenaar: null, herkomst: 'david', actief: 1, aangemaakt: '2026-10-22T10:00:00Z', bron_nr: 7 },
        { id: 5, soort: 'tegenpartij', patroon: 'oud', rek: null, richting: 'af', type: null, categorie: 'x', subcategorie: null, eigenaar: null, herkomst: 'david', actief: 0, aangemaakt: '2026-10-01T10:00:00Z', bron_nr: null }],
      raakt: [{ id: 1, n: 3, laatst: '2026-10-20' }],
      bron: [{ id: 2, rek: 'ra' }, { id: 3, rek: 'ra' }, { id: 4, rek: 'rp' }],
      abonnementen: [{ id: 1, rek: 'ra', naam: 'ProefStroom B.V.', actief: 1, categorie: 'wonen' }, { id: 2, rek: 'ra', naam: 'Proefoptiek', actief: 1, categorie: 'gezondheid' },
        { id: 3, rek: 'ra', naam: 'Onbekend Abonnement', actief: 1, categorie: 'vrije tijd' }, { id: 4, rek: 'rb', naam: 'ProefStroom B.V.', actief: 1, categorie: 'wonen' }],
      nrs: new Set([77]) });
    const REG = () => ({ knopen: [{ id: 'org:proefstroom', soort: 'organisatie', rol: 'leverancier', naam: 'ProefStroom', vault_pagina: '20_Prive/Relaties/ProefStroom.md', aliassen: ['ProefStroom B.V.'] },
      { id: 'org:proefoptiek', soort: 'organisatie', rol: 'leverancier', naam: 'Proefoptiek', vault_pagina: '20_Prive/Relaties/Proefoptiek.md', aliassen: [] },
      { id: 'PRIVE', soort: 'entiteit', rol: 'eigen', naam: 'Privé', iban: IA }, { id: 'POT', soort: 'entiteit', rol: 'eigen', naam: 'POT', iban: IP }],
      handvatten: [{ knoop: 'org:proefstroom', soort: 'alias', waarde: 'proefstroom bv', status: 'voorgesteld' }], contact: [], vertaling: [], bevindingen: [], log: [] });
    const PAG = () => [R.leesRekening(REKP('Hoofd', '0011'), rekTekst(IA, 'PRIVE')), R.leesRekening(REKP('Kind A Sparen', '0022'), rekTekst(IB, 'PRIVE')), R.leesRekening(POTP, rekTekst(IP, 'POT'))];
    const BANK = (o) => Object.assign({ meting: M(), rek: PAG(), regels: R.leesBankregels(REGELS_T), overig: [], nu: Date.parse('2026-10-28T02:30:00Z') }, o || {});
    const C = (b, reg) => R.checks([], reg || REG(), [], null, b);
    const bankB = (r) => r.bevindingen.filter((b) => R.BANK_BEVINDING_RE.test(b.bevinding_id));
    const ids = (r) => bankB(r).map((b) => b.bevinding_id).join(' ');
    // parser
    toets('10 rekeningpagina geldig', PAG().every((p) => p.fouten.length === 0), PAG().map((p) => p.fouten));
    toets('10 sleutel ≠ iban = fout', R.leesRekening(REKP('Hoofd', '0011'), rekTekst(IA, 'PRIVE').replace('rekening#' + IA, 'rekening#' + IB)).fouten.length > 0);
    toets('10 privérekening bij de POT-map = fout', R.leesRekening(POTP, rekTekst(IP, 'PRIVE')).fouten.length > 0);
    toets('10 buiten de vaste plek = fout', R.leesRekening('20_Prive/Financien/Rekening - Hoofd (0011).md', rekTekst(IA, 'PRIVE')).fouten.length > 0);
    toets('10 entiteit_id anders dan PRIVE/POT = fout', R.leesRekening(REKP('Hoofd', '0011'), rekTekst(IA, 'TG')).fouten.length > 0);
    toets('10 Bankregels: voorstel "- ?" buiten het blok gevonden', R.leesBankregels(REGELS_T + '- ? alles van X naar wonen\n').voorstellen.length === 1);
    // vergelijking
    let r = C(BANK());
    toets('10 alles gelijk: 0 bankbevindingen, 3 rekeningen gemeten', bankB(r).length === 0 && r.tel.bank === 3 && r.bank.gemeten, [ids(r), r.tel]);
    toets('10 opgeheven rekening zonder pagina is geen bevinding', !/0033/.test(ids(r)));
    const mO = M(); mO.rekeningen[2].status = 'ontkoppeld';
    toets('10 ontkoppelde rekening zonder pagina is geen bevinding (diffreview ZOU 1)', !/0033/.test(ids(C(BANK({ meting: mO })))), ids(C(BANK({ meting: mO }))));
    const mK = M(); mK.rekeningen = mK.rekeningen.concat([null]);
    r = C(BANK({ meting: mK }));
    toets('10 vergelijking die faalt: niet gemeten, geen halve bankbevindingen (diffreview ZOU 2)', r.bank.gemeten === false && /vergelijking faalde/.test(r.bank.reden) && bankB(r).length === 0, r.bank);
    toets('10 id van een bekende rekening hangt aan het bank-id, niet aan het nummer (diffreview ZOU 3)', (() => { const x = C(BANK({ rek: PAG().slice(0, 2) })); const m2 = M(); m2.rekeningen[3].rek = 'rp2'; const y = C(BANK({ rek: PAG().slice(0, 2), meting: m2 })); const a = bankB(x).find((b) => /geen-pagina/.test(b.bevinding_id)), c = bankB(y).find((b) => /geen-pagina/.test(b.bevinding_id)); return a && c && a.bevinding_id !== c.bevinding_id; })());
    toets('10 POT-rekeningpagina buiten de POT-map = fout (KAN 7)', R.leesRekening('10_Zakelijk/Tolgaarde/Rekening - POT (0044).md', rekTekst(IP, 'POT')).fouten.length > 0);
    r = C(BANK({ rek: PAG().slice(0, 2) }));
    toets('10 POT-rekening zonder pagina: BB2 + hoofdrekening POT', /BB2-bank-rek-0044-[0-9a-f]{6}-geen-pagina/.test(ids(r)) && /BB3-bank-ent-POT-hoofdrekening/.test(ids(r)) && bankB(r).length === 2, ids(r));
    r = C(BANK({ rek: [R.leesRekening(REKP('Hoofd', '0011'), rekTekst(IA, 'PRIVE')), R.leesRekening(REKP('Kind A Sparen', '0022'), rekTekst(IB, 'PRIVE')), R.leesRekening(POTP, rekTekst(IP, 'POT')), R.leesRekening(REKP('Weg', '0055'), rekTekst(IX, 'PRIVE'))] }));
    toets('10 pagina voor een rekening die de bank niet kent: BB1', /BB1-bank-rek-0055-[0-9a-f]{6}-onbekend/.test(ids(r)) && bankB(r).length === 1, ids(r));
    r = C(BANK({ rek: PAG().concat([R.leesRekening(REKP('Hoofd kopie', '0011'), rekTekst(IA, 'PRIVE'))]) }));
    toets('10 twee pagina\'s met hetzelfde nummer: BB5 (+ hoofdrekening PRIVE)', /BB5-bank-rek-0011-[0-9a-f]{6}-twee/.test(ids(r)), ids(r));
    const mE = M(); mE.rekeningen[1].eigenaar = 'POT';
    r = C(BANK({ meting: mE }));
    toets('10 eigenaar in de bank POT, pagina PRIVE: BB3 entiteit', /BB3-bank-rek-0022-[0-9a-f]{6}-entiteit/.test(ids(r)), ids(r));
    const regE = REG(); regE.knopen[2].iban = IP;
    toets('10 entiteitpagina PRIVE noemt het nummer van de POT-rekening: BB3 hoofdrekening', /BB3-bank-ent-PRIVE-hoofdrekening/.test(ids(C(BANK(), regE))), ids(C(BANK(), regE)));
    const mH = M(); mH.regels[0].herkomst = 'onbekend';
    r = C(BANK({ meting: mH }));
    toets('10 regel met onbekende herkomst: BB7 serious', bankB(r).some((b) => b.bevinding_id === 'BB7-bank-regel-1-herkomst' && b.ernst === 'serious'), ids(r));
    const mD = M(); mD.regels[0].aangemaakt = '2024-01-01T00:00:00Z'; mD.raakt[0].laatst = '2024-02-01';
    toets('10 regel die > 400 dagen niets raakte: BB6 dood', /BB6-bank-regel-1-dood/.test(ids(C(BANK({ meting: mD })))), ids(C(BANK({ meting: mD }))));
    const mJ = M(); mJ.regels[0].aangemaakt = '2025-06-01T00:00:00Z'; mJ.raakt[0].laatst = '2025-11-01';
    toets('10 jaarregel (laatst 361 dagen geleden): niet dood', !/dood/.test(ids(C(BANK({ meting: mJ })))));
    r = C(BANK({ regels: null }));
    toets('10 Bankregels-pagina weg: BB2', /BB2-bank-regels-geen-pagina/.test(ids(r)), ids(r));
    r = C(BANK({ regels: R.leesBankregels(REGELS_T + '- ? alles van Jan de Proef NL00TEST0000000099 naar vrienden\n') }));
    toets('10 voorstel op de pagina: BB6, zonder de tekst van het voorstel', /BB6-bank-regel-voorstel-/.test(ids(r)) && !bankB(r).some((b) => /Jan|NL00/.test(b.samenvatting + b.detail)), bankB(r));
    r = C(BANK({ overig: [{ pad: '20_Prive/Financien/Notitie.md', tekst: 'zie pod:bank-transacties/transactie#77 en pod:bank-transacties/transactie#78 en pod:bank-transacties/regel#9' }] }));
    toets('10 verwijzing naar een post of regel die niet bestaat: BB8 (2×), bestaande niet', bankB(r).filter((b) => /BB8-bank-verwijzing-/.test(b.bevinding_id)).length === 2, ids(r));
    r = C(BANK({ overig: [{ pad: '20_Prive/Financien/Oud/Rekening - Hoofd (0011).md', tekst: rekTekst(IA, 'PRIVE') }] }));
    toets('10 rekeningpagina buiten de vaste plek: BB6', /BB6-bank-buiten-plek-/.test(ids(r)), ids(r));
    // privacy: geen nummer, pad of rekeningnaam in wat naar de databank gaat (Fable #2)
    const alle = [C(BANK({ rek: PAG().slice(0, 2) })), C(BANK({ meting: mE })), C(BANK({ meting: mH })), C(BANK({ rek: PAG().concat([R.leesRekening(REKP('Hoofd kopie', '0011'), rekTekst(IA, 'PRIVE'))]) })),
      C(BANK({ rek: [R.leesRekening(REKP('Kind A Sparen', '0022'), '---\ntype: rekening\n---\n')] }))].map(bankB).flat();
    toets('10 bevindingen zonder IBAN, pad of rekeningnaam', alle.length >= 5 && !alle.some((b) => /NL00TEST|Rekeningen\/|Kind A|Hoofd kopie|jan de proef|medewerker/i.test(b.bevinding_id + b.samenvatting + b.detail)), alle);
    toets('10 paden alleen in r.bank.paden (stdout machinekamer)', (() => { const x = C(BANK({ rek: [R.leesRekening(REKP('Kind A Sparen', '0022'), '---\ntype: rekening\n---\n')] })); return Object.values(x.bank.paden).some((p) => /Kind A/.test(p)); })());
    // niet gemeten
    r = C(null);
    toets('10 geen banklezer: niet gemeten, geen bankbevindingen', r.bank.gemeten === false && r.tel.bank === 'niet gemeten' && bankB(r).length === 0, r.tel);
    r = C(BANK({ meting: { fout: 'bank gaf geen rekeningen' } }));
    toets('10 meting met fout: niet gemeten', r.bank.gemeten === false && bankB(r).length === 0);
    toets('10 bankMeting: nul rekeningen = fout', !!R.bankMeting({ meet: (b) => b.map(() => []) }, []).fout);
    toets('10 bankMeting: zonder lezer = fout', !!R.bankMeting(null, []).fout);
    // blokken
    const orgVan = R.orgOpNaam(REG());
    const bA = R.bankBlokTekst(PAG()[0], M(), orgVan);
    toets('10 blok: bank, eigenaar, posten op maand, abonnement gekoppeld aan de organisatie, gezondheid niet genoemd', /bunq · actief · niet gezamenlijk/.test(bA) && /ingedeeld door het systeem/.test(bA) && /van 3-2019 t\/m 10-2026/.test(bA)
      && /\[\[20_Prive\/Relaties\/ProefStroom\|ProefStroom\]\]/.test(bA) && !/Proefoptiek|Onbekend Abonnement/.test(bA) && /en 2 zonder pagina/.test(bA) && /content_hash="[0-9a-f]{16}"/.test(bA), bA);
    toets('10 blok zonder datum of bedrag (geen churn)', !/\d{1,2}-\d{1,2}-\d{4}|€|saldo [0-9]/.test(bA.replace(/van 3-2019 t\/m 10-2026/, '')), bA);
    const bB = R.bankBlokTekst(PAG()[1], M(), orgVan);
    toets('10 blok kind-rekening: abonnement alleen geteld', !/ProefStroom\]\]/.test(bB) && /1 \(geen met een pagina/.test(bB) && /gezet door de machinekamer/.test(bB), bB);
    const bP = R.bankBlokTekst(PAG()[2], M(), orgVan);
    toets('10 blok POT: regels alleen geteld, geen link naar Bankregels', /Bankregels voor deze rekening: 1 \(alleen geteld/.test(bP) && !/\[\[20_Prive/.test(bP), bP);
    const bR = R.bankRegelsBlokTekst(M(), PAG(), orgVan);
    toets('10 Bankregels: extern als rekening …0022 met link, organisatie als link, persoon niet bij naam, POT alleen geteld, ingetrokken geteld',
      /R1 · overboekingen naar \[\[20_Prive\/Financien\/Rekeningen\/Rekening - Kind A Sparen \(0022\)\|rekening …0022\]\]/.test(bR) && /R3 · betalingen met \[\[20_Prive\/Relaties\/ProefStroom\|ProefStroom\]\]/.test(bR)
      && /R2 · betalingen met een tegenpartij \(naam blijft in de bank\)/.test(bR) && !/jan de proef|medewerker|R4 /i.test(bR) && /Op de POT-rekening: 1 regel/.test(bR) && /Ingetrokken.*: 1/.test(bR)
      && /gezet door de machinekamer/.test(bR) && /gezet via het gesprek met Socev/.test(bR) && /raakte laatst een post in 10-2026/.test(bR) && !/raakte 3/.test(bR) && !/rb|ra\b/.test(bR.replace(/[a-z]+rb|ra[a-z]/g, '')), bR);
    toets('10 blokken idempotent (zelfde invoer = zelfde tekst)', R.bankBlokTekst(PAG()[0], M(), orgVan) === bA && R.bankRegelsBlokTekst(M(), PAG(), orgVan) === bR);
    // naam → organisatie (alleen weergave): kern zonder rechtsvorm, voorvoegsel in één richting, alleen bij precies één kandidaat
    { const kn = (id, naam) => ({ id: 'org:' + id, soort: 'organisatie', rol: 'leverancier', naam: naam, vault_pagina: '20_Prive/Relaties/' + naam + '.md', aliassen: [] });
      const ov = R.orgOpNaam({ knopen: [kn('ps', 'ProefStroom'), kn('pw', 'Proefwaterschap Amstel en Vecht'), kn('pz', 'Proefzorg'), kn('bn', 'Proefbank Noord'), kn('bz', 'Proefbank Zuid'), kn('kp', 'Kop'), kn('e', 'Eigen BV')].concat([{ id: 'TG', soort: 'entiteit', rol: 'eigen', naam: 'Proefpraktijk', vault_pagina: 'x.md' }]), handvatten: [] });
      const id = (n) => (ov(n) || {}).id || null;
      toets('10 naamkern: achtervoegsel, afgekapt, NV vooraan', id('ProefStroom Netherlands B.V.') === 'org:ps' && id('Proefwaterschap Amstel') === 'org:pw' && id('NV Proefzorg') === 'org:pz' && id('PROEFSTROOM') === 'org:ps',
        [id('ProefStroom Netherlands B.V.'), id('Proefwaterschap Amstel'), id('NV Proefzorg')]);
      toets('10 naamkern: twijfel blijft los (twee kandidaten, te kort, eigen entiteit)', id('Proefbank') === null && id('Proefbank Noord Holding') === 'org:bn' && id('Kop Mobiel') === null && id('Proefpraktijk') === null && id('Eigen') === 'org:e',
        [id('Proefbank'), id('Proefbank Noord Holding'), id('Kop Mobiel'), id('Proefpraktijk'), id('Eigen')]); }
    // de echte lezer op een wegwerp-SQLite: alleen SELECT, alleen lezen
    const dbPad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovis-bank-')), 'transacties.sqlite');
    { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(dbPad);
      d.exec("CREATE TABLE rekeningen (rek TEXT PRIMARY KEY, bron TEXT, iban TEXT, status TEXT, gezamenlijk INTEGER, eigenaar TEXT, eigenaar_herkomst TEXT);" +
        "CREATE TABLE transacties (nr INTEGER PRIMARY KEY, rek TEXT, datum TEXT, vervangen_door INTEGER);" +
        "CREATE TABLE regels (id INTEGER PRIMARY KEY, soort TEXT, patroon TEXT, rek TEXT, richting TEXT, type TEXT, categorie TEXT, subcategorie TEXT, eigenaar TEXT, herkomst TEXT, actief INTEGER, aangemaakt TEXT, bron_nr INTEGER);" +
        "CREATE TABLE verrijking (nr INTEGER PRIMARY KEY, regel_id INTEGER);" +
        "CREATE TABLE abonnementen (id INTEGER PRIMARY KEY, rek TEXT, naam TEXT, actief INTEGER, categorie TEXT);" +
        "INSERT INTO rekeningen VALUES ('ra','bunq','" + IA + "','ACTIVE',0,'David','systeem');" +
        "INSERT INTO transacties VALUES (77,'ra','2026-10-01',NULL),(78,'ra','2026-10-02',NULL);" +
        "INSERT INTO regels VALUES (1,'extern','ra',NULL,'af',NULL,'x',NULL,NULL,'machinekamer',1,'2026-10-21T00:00:00Z',77);" +
        "INSERT INTO verrijking VALUES (77,1);"); d.close(); }
    const L = R.bankLezer(dbPad);
    const lm = R.bankMeting(L, [77, 99]);
    toets('10 lezer: echte SQLite gelezen, verwijzing 77 bestaat, 99 niet', !lm.fout && lm.rekeningen.length === 1 && lm.raakt[0].n === 1 && lm.bron[0].rek === 'ra' && lm.nrs.has(77) && !lm.nrs.has(99), lm);
    let geweigerd = false; try { L.meet([{ sql: 'DELETE FROM regels' }]); } catch (e) { geweigerd = /alleen lezen/.test(e.message); }
    toets('10 lezer weigert alles wat geen SELECT is', geweigerd);
    let ro = false; try { L.meet([{ sql: 'SELECT 1; DELETE FROM regels' }]); } catch (e) { ro = true; }
    toets('10 lezer: tweede statement achter een SELECT komt er niet door', ro || (() => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(dbPad, { readOnly: true }); const n = d.prepare('SELECT count(*) AS n FROM regels').get().n; d.close(); return n === 1; })());
    toets('10 lezer: databank weg = fout (niet gemeten)', !!R.bankMeting(R.bankLezer(dbPad + '.weg'), []).fout);
    // compiler (nacht, grendel) en Bibliothecaris via de module
    const PROEF = { [REKP('Hoofd', '0011')]: rekTekst(IA, 'PRIVE'), [REKP('Kind A Sparen', '0022')]: rekTekst(IB, 'PRIVE'), [POTP]: rekTekst(IP, 'POT'), '20_Prive/Financien/Bankregels.md': REGELS_T,
      '20_Prive/Financien/Notitie.md': '# Notitie\n\nGeen verwijzing.\n' };
    const v9 = wegwerpVault(PROEF);
    const n9 = nepDb({ knopen: REG().knopen, handvatten: REG().handvatten, contact: [], vertaling: [], bevindingen: [], log: [] });
    let bankIo = { meet: (b) => { const m = M(); return Object.keys(R.BANK_SQL).map((k) => m[k]).concat(b.length > Object.keys(R.BANK_SQL).length ? [[]] : []); } };
    const m9 = R.maak({ vault: v9, sbRpc: n9.sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: (p, t) => fs.writeFileSync(p, t), nu: () => Date.parse('2026-10-28T01:15:00Z'), bank: { meet: (b) => bankIo.meet(b) } });
    let c9 = await m9.compileer('nacht', { grendel: true });
    const naA = fs.readFileSync(path.join(v9, REKP('Hoofd', '0011')), 'utf8'), naR = fs.readFileSync(path.join(v9, '20_Prive/Financien/Bankregels.md'), 'utf8');
    toets('10 nacht: 4 bankblokken geschreven (3 rekeningen + Bankregels)', c9.bankblokken === 4 && naA.indexOf('<!-- ovis:blok begin id="rek:' + IA + '"') > 0 && /R1 · overboekingen/.test(naR), c9);
    toets('10 nacht: vingerafdruk van de pagina blijft gelijk', R.vingerafdruk(naA).sha === R.leesRekening(REKP('Hoofd', '0011'), rekTekst(IA, 'PRIVE')).sha);
    c9 = await m9.compileer('nacht', { grendel: true });
    toets('10 nacht tweede keer: niets geschreven', c9.bankblokken === 0 && fs.readFileSync(path.join(v9, REKP('Hoofd', '0011')), 'utf8') === naA, c9);
    let b9 = await m9.bibliothecaris({ afroep: true });
    toets('10 Bibliothecaris na de nacht: 0 bankbevindingen, niets verouderd, zin noemt de bank', b9.bevindingen.filter((b) => R.BANK_BEVINDING_RE.test(b.bevinding_id)).length === 0 && b9.tel.bank === 3 && b9.tel.bank_verouderd === 0 && /bankrekeningen: 3 gemeten, 0 verschil/.test(b9.zin), [b9.zin, b9.tel, b9.bevindingen.map((b) => b.bevinding_id)]);
    fs.writeFileSync(path.join(v9, REKP('Hoofd', '0011')), naA.replace('- Bij de bank: bunq', '- Bij de bank: bunq (met de hand)'));
    c9 = await m9.compileer('nacht', { grendel: true });
    toets('10 handwerk in het blok: niet overschreven', fs.readFileSync(path.join(v9, REKP('Hoofd', '0011')), 'utf8').indexOf('(met de hand)') > 0 && c9.handwerk >= 1, c9);
    b9 = await m9.bibliothecaris({ afroep: true });
    toets('10 handwerk: BB8 bank', b9.bevindingen.some((b) => /^BB8-bank-rek-0011-[0-9a-f]{6}-blok$/.test(b.bevinding_id)), b9.bevindingen.map((b) => b.bevinding_id));
    // niet gemeten ≠ opgelost
    bankIo = { meet: () => { throw new Error('databank weg'); } };
    const voor = n9.db.bevindingen.filter((b) => /bank/.test(b.bevinding_id)).length;
    b9 = await m9.bibliothecaris({ afroep: true });
    toets('10 bank weg: niet gemeten, open bankbevinding blijft open', voor === 1 && n9.db.bevindingen.filter((b) => /bank/.test(b.bevinding_id)).length === 1 && /bankrekeningen niet gemeten/.test(b9.zin), [voor, b9.zin]);
    c9 = await m9.compileer('nacht', { grendel: true });
    toets('10 bank weg: nacht raakt geen pagina aan, meldt de fout', c9.bankblokken === 0 && c9.fouten.some((f) => f.pad === '(bank)'), c9);
    // weekkaart
    const kb9 = R.kaartBiblio({ knopen: [], kaarten: [], bevindingen: [{ bevinding_id: 'BB2-bank-rek-0044-abcdef-geen-pagina', check_id: 'BB2', ernst: 'warning', status: 'open' },
      { bevinding_id: 'BB3-bank-rek-0022-abcdef-entiteit', check_id: 'BB3', ernst: 'warning', status: 'open' }] }, { nu: Date.parse('2026-10-28T02:31:00Z') });
    toets('10 weekkaart: bank in gewone taal, BB3 bank komt erop', kb9.kaart && kb9.kaart.stappen.length === 2 && /Bankrekening …0044 heeft nog geen pagina/.test(kb9.kaart.stappen[0]) && /Rekening …0022/.test(kb9.kaart.stappen[1]), kb9);
  }

  // ── 11. wv1011: plek 7 personen ──
  {
    const KEY = 'ab'.repeat(32), KEY2 = 'cd'.repeat(32);
    const OID = '0b0e1d2c-3a4b-4c5d-8e6f-7a8b9c0d1e2f', OID2 = '1c1f2e3d-4b5c-4d6e-9f70-8b9cad0e1f30';
    const PP = '10_Zakelijk/Voorbeeldpraktijk/Medewerkers/Pim Proef - assistent.md';
    function persoon(o) {
      o = Object.assign({ type: 'medewerker', id: 'per:pim-proef', oid: OID, status: 'concept', mail: ['pim.proef@voorbeeldpraktijk.nl'], tel: [], nda: [], google: null, extra: '', naam: null, ent: 'TG' }, o || {});
      const fm = ['---', 'type: ' + o.type, 'entiteit_id: ' + o.ent, 'object_id: ' + o.oid].concat(o.naam ? ['naam: "' + o.naam + '"'] : []).concat([
        'aliases: ["Pim Proef", "Pim"]', 'geboortedatum: 1990-01-01', 'ovis:',
        '  db: ["supabase:secondbrain/knoop#' + o.id + '"' + (o.google ? ', "supabase:secondbrain/contacten#' + o.google + '"' : '') + ']',
        '  status: ' + o.status, '  mailadressen: [' + o.mail.join(', ') + ']', '  telefoons: [' + o.tel.map((x) => '"' + x + '"').join(', ') + ']',
        '  niet_dezelfde_als: [' + o.nda.join(', ') + ']', '  zaad: ["mail pim.proef@voorbeeldpraktijk.nl: mailkaart, 12 mails"]']).concat(o.extra ? [o.extra] : []).concat(['updated: 2026-10-27', '---', '# Pim Proef', '', 'Dossiertekst.', '']);
      const t = fm.join('\n'), z = R.persoonMetZegel(PP, t, KEY);
      return z.tekst || t;
    }
    // parser, zegel, vingerafdruk
    const t1 = persoon(), p1 = R.leesPersoon(PP, t1, KEY);
    toets('11 persoonspagina geldig, naam uit de bestandsnaam', p1 && p1.fouten.length === 0 && p1.naam === 'Pim Proef' && p1.id === 'per:pim-proef' && p1.object_id === OID, p1);
    toets('11 pagina zonder ovis-blok is geen OVIS-persoon', R.leesPersoon(PP, '---\ntype: medewerker\nnaam: X\n---\n', KEY) === null);
    toets('11 dossiertekst wijzigen verandert de vingerafdruk niet', R.leesPersoon(PP, t1.replace('Dossiertekst.', 'Nieuwe kennis van vannacht.'), KEY).sha === p1.sha);
    toets('11 aliases en geboortedatum worden geen kenmerk', JSON.stringify(R.handvattenVan(p1).map((h) => h.soort)) === '["mail"]', R.handvattenVan(p1));
    const kapot = t1.replace('mailadressen: [pim.proef@voorbeeldpraktijk.nl]', 'mailadressen: [pim.proef@voorbeeldpraktijk.nl, valse@aanvaller.example]');
    const pk = R.leesPersoon(PP, kapot, KEY);
    toets('11 ovis-blok buiten Socev om gewijzigd = zegelfout', pk.zegelFout === true && pk.fouten.length === 1, pk.fouten);
    const hz = R.persoonMetZegel(PP, kapot, KEY);
    toets('11 persoonMetZegel herstelt het zegel (één regel)', hz.tekst && R.leesPersoon(PP, hz.tekst, KEY).fouten.length === 0 && hz.tekst.split('\n').length === kapot.split('\n').length, hz);
    toets('11 privépagina wordt nooit een knoop', R.leesPersoon('20_Prive/Familie/Pim Proef.md', t1, KEY).fouten.some((f) => /zakelijke persoonspagina/.test(f)));
    toets('11 persoonspagina in Bronnen telt niet', R.leesPersoon('10_Zakelijk/Voorbeeldpraktijk/Bronnen/Pim.md', t1, KEY).fouten.some((f) => /zakelijke persoonspagina/.test(f)));
    toets('11 contact op een persoonspagina = fout (Google is de bron)', R.leesPersoon(PP, persoon({ extra: 'contact:\n  telefoon: "0612345678"' }), KEY).fouten.some((f) => /Google/.test(f)));
    toets('11 zonder object_id = fout', R.leesPersoon(PP, persoon({ oid: 'geen' }), KEY).fouten.some((f) => /object_id/.test(f)));
    toets('11 onbekend veld in het ovis-blok = fout', R.leesPersoon(PP, t1.replace('  status: concept', '  status: concept\n  iban: NL00TEST0000000000'), KEY).fouten.some((f) => /onbekend veld/.test(f)));
    toets('11 normTel', R.normTel('+31 (0)6-1234 5678') === '0612345678' && R.normTel('0031 6 1234 5678') === '0612345678' && R.normTel('+220 712 3456') === '002207123456');
    toets('11 BSN-lang nummer is geen telefoon', R.leesPersoon(PP, persoon({ tel: ['123456789'] }), KEY).fouten.some((f) => /telefoonnummer ongeldig/.test(f)));
    // rpcInvoer
    const ri = R.rpcInvoer(R.leesPersoon(PP, persoon({ tel: ['06 1234 5678'] }), KEY), 7, { soorten: ['kvk', 'domein', 'mail', 'kenmerkpatroon', 'alias', 'niet-dezelfde-als'], eigen: new Set(['GH']) });
    toets('11 rpcInvoer persoon: telefoon wacht (fase B), voor alleen bestaande eigen entiteit, personeel', ri.soort === 'persoon' && ri.object_id === OID && ri.handvatten.length === 1
      && ri.handvatten[0].soort === 'mail' && ri.voor.length === 0 && ri.access_context === 'zakelijk_personeel' && ri.contact.length === 0, ri);
    // compileer tegen de nep-databank
    const PP2 = '10_Zakelijk/Voorbeeldpraktijk/Roos Voorbeeld.md';
    const t2 = persoon({ type: 'persoon', id: 'per:roos-voorbeeld', oid: OID2, mail: ['roos@voorbeeldpraktijk.nl'], naam: 'Roos Voorbeeld' }).replace(/Pim Proef/g, 'Roos Voorbeeld');
    const t2z = R.persoonMetZegel(PP2, t2, KEY).tekst;
    const v11 = wegwerpVault({ [TGP]: TG, [PP]: persoon({ tel: ['0612345678'] }), [PP2]: t2z, '10_Zakelijk/Voorbeeldpraktijk/Medewerkers/Zonder Ovis.md': '---\ntype: medewerker\n---\nx\n' });
    const n11 = nepDb({ knopen: [TGRIJ], handvatten: TGH.slice(), contact: [], vertaling: [], bevindingen: [], log: [] });
    let sleutel11 = KEY;
    const m11 = R.maak({ vault: v11, sbRpc: n11.sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: (p, t) => fs.writeFileSync(p, t), nu: () => Date.parse('2026-10-28T01:15:00Z'), zegelSleutel: () => sleutel11 });
    const c11 = await m11.compileer('dag');
    toets('11 compileer: twee personen gestuurd, telefoon wacht op de databank', n11.db.knopen.filter((k) => k.soort === 'persoon').length === 2 && c11.wacht_soort === 1 && c11.fouten.length === 0, c11);
    toets('11 de pagina zonder ovis-blok is niet gestuurd', !n11.db.knopen.some((k) => /zonder/.test(k.id)));
    const voorTekst = fs.readFileSync(path.join(v11, PP), 'utf8');
    const cn = await m11.compileer('nacht', { grendel: true });
    toets('11 nacht: geen gegenereerd blok op een persoonspagina', fs.readFileSync(path.join(v11, PP), 'utf8') === voorTekst && fs.readFileSync(path.join(v11, PP2), 'utf8') === t2z, cn);
    const c11b = await m11.compileer('dag');
    toets('11 ongewijzigd = niet opnieuw gestuurd', c11b.gestuurd === 0, c11b);
    // fase B: de databank kent telefoon → de ongewijzigde pagina gaat opnieuw
    n11.db.handvat_soorten = ['kvk', 'domein', 'mail', 'kenmerkpatroon', 'alias', 'niet-dezelfde-als', 'telefoon', 'whatsapp', 'signal', 'google'];
    const c11c = await m11.compileer('dag');
    toets('11 fase B: ongewijzigde pagina met telefoon opnieuw gestuurd', c11c.gestuurd === 1 && n11.db.handvatten.some((h) => h.knoop === 'per:pim-proef' && h.soort === 'telefoon' && h.waarde_norm === '0612345678'), c11c);
    const c11d = await m11.compileer('dag');
    toets('11 fase B: daarna rust', c11d.gestuurd === 0, c11d);
    // Bibliothecaris
    let b11 = await m11.bibliothecaris({ afroep: true });
    toets('11 Bibliothecaris: personen groen', b11.tel.per_verschil === 0 && b11.tel.personen === 2 && b11.tel.personen_gemeten === true, [b11.tel, b11.bevindingen.map((x) => x.bevinding_id)]);
    // zegel kapot: niets sturen, BB6-zegel, geen BB2
    fs.writeFileSync(path.join(v11, PP2), t2z.replace('roos@voorbeeldpraktijk.nl]', 'roos@voorbeeldpraktijk.nl, x@aanvaller.example]'));
    const voorH = n11.db.handvatten.length;
    b11 = await m11.bibliothecaris({ afroep: true });
    const ids11 = b11.bevindingen.map((x) => x.bevinding_id);
    toets('11 zegel kapot: BB6-zegel, geen BB2, niets gestuurd of vervallen', ids11.indexOf('BB6-per:roos-voorbeeld-zegel') >= 0 && !ids11.some((i) => /^BB2-per:roos/.test(i))
      && n11.db.handvatten.length === voorH && !n11.db.handvatten.some((h) => h.knoop === 'per:roos-voorbeeld' && h.status === 'vervallen'), ids11);
    fs.writeFileSync(path.join(v11, PP2), t2z);
    // identiteit: entity met ander object_id → BB1-object; personen niet te lezen → niet opgelost
    n11.db.personen.entity.find((e) => e.k === 'per:pim-proef').o = OID2;
    b11 = await m11.bibliothecaris({ afroep: true });
    toets('11 BB1-object bij een ander object_id', b11.bevindingen.some((x) => x.bevinding_id === 'BB1-per:pim-proef-object'), b11.bevindingen.map((x) => x.bevinding_id));
    n11.db.personenFout = true;
    b11 = await m11.bibliothecaris({ afroep: true });
    toets('11 personen niet gemeten: BB1-object blijft open', n11.db.bevindingen.some((x) => x.bevinding_id === 'BB1-per:pim-proef-object') && b11.tel.personen_gemeten === false, b11.tel);
    n11.db.personenFout = false; n11.db.personen.entity.find((e) => e.k === 'per:pim-proef').o = OID;
    b11 = await m11.bibliothecaris({ afroep: true });
    toets('11 hersteld: opgelost', !n11.db.bevindingen.some((x) => /per:/.test(x.bevinding_id)), n11.db.bevindingen);
    // BB5: zelfde mailadres bij een persoon en een organisatie; twee pagina's met hetzelfde object_id
    n11.db.handvatten.push({ id: 900, knoop: 'TG', soort: 'mail', waarde: 'roos@voorbeeldpraktijk.nl', waarde_norm: 'roos@voorbeeldpraktijk.nl', status: 'voorgesteld', herkomst: { bron: 'pagina' } });
    const pr = R.checks([R.leesPersoon(PP, persoon(), KEY), Object.assign(R.leesPersoon(PP2, t2z, KEY))], n11.db, [], null, null, n11.db.personen);
    toets('11 BB5 mail persoon ⇄ organisatie', pr.bevindingen.some((x) => x.check_id === 'BB5' && /per:roos-voorbeeld/.test(x.bevinding_id) && /TG/.test(x.bevinding_id)), pr.bevindingen.map((x) => x.bevinding_id));
    n11.db.handvatten.pop();
    const t3 = R.persoonMetZegel(PP2, t2.replace(OID2, OID), KEY).tekst;
    const pr2 = R.checks([R.leesPersoon(PP, persoon(), KEY), R.leesPersoon(PP2, t3, KEY)], n11.db, [], null, null, n11.db.personen);
    toets('11 BB5 twee pagina\'s met hetzelfde object_id', pr2.bevindingen.some((x) => x.bevinding_id === 'BB5-per:pim-proef-per:roos-voorbeeld-object'), pr2.bevindingen.map((x) => x.bevinding_id));
    // BB2: persoonsknoop zonder pagina
    const pr3 = R.checks([R.leesPersoon(PP, persoon(), KEY)], n11.db, [], null, null, n11.db.personen);
    toets('11 BB2 persoonsknoop zonder pagina', pr3.bevindingen.some((x) => x.bevinding_id === 'BB2-per:roos-voorbeeld-geen-pagina'), pr3.bevindingen.map((x) => x.bevinding_id));
    // Google: actieve koppeling, nummer op de pagina staat niet in Google
    const tg = persoon({ tel: ['0612345678'], google: 'people/c123' });
    const pg = R.leesPersoon(PP, tg, KEY);
    const regG = JSON.parse(JSON.stringify(n11.db)); regG.handvat_soorten = n11.db.handvat_soorten;
    regG.knopen.find((k) => k.id === 'per:pim-proef').bron_sha = pg.sha;
    regG.handvatten = regG.handvatten.filter((h) => h.knoop !== 'per:pim-proef').concat([
      { id: 801, knoop: 'per:pim-proef', soort: 'mail', waarde: 'pim.proef@voorbeeldpraktijk.nl', waarde_norm: 'pim.proef@voorbeeldpraktijk.nl', status: 'voorgesteld', herkomst: { bron: 'pagina' } },
      { id: 802, knoop: 'per:pim-proef', soort: 'telefoon', waarde: '0612345678', waarde_norm: '0612345678', status: 'voorgesteld', herkomst: { bron: 'pagina' } },
      { id: 803, knoop: 'per:pim-proef', soort: 'google', waarde: 'people/c123', waarde_norm: 'people/c123', status: 'actief', herkomst: { bron: 'pagina', vraag_id: 'abcd1234', kaart: 'k' } }]);
    regG.kaarten = [{ sleutel: 'k', beslist_vraag_id: 'abcd1234', status: 'ja', regels: [] }];
    const prG = R.checks([pg], regG, [], null, null, { entity: [{ k: 'per:pim-proef', o: OID }], contacten: [{ r: 'people/c123', mail: [], tel: ['+31687654321'] }] });
    toets('11 Google: nummer op de pagina niet in Google → BB3-google-tel', prG.bevindingen.some((x) => x.bevinding_id === 'BB3-per:pim-proef-google-tel'), prG.bevindingen.map((x) => x.bevinding_id));
    const prG2 = R.checks([pg], regG, [], null, null, { entity: [{ k: 'per:pim-proef', o: OID }], contacten: [{ r: 'people/c123', mail: [], tel: ['+31612345678'] }] });
    toets('11 Google: nummer staat erin → geen bevinding', !prG2.bevindingen.some((x) => /google/.test(x.bevinding_id)), prG2.bevindingen.map((x) => x.bevinding_id));
    const prG3 = R.checks([pg], regG, [], null, null, { entity: [{ k: 'per:pim-proef', o: OID }], contacten: [] });
    toets('11 Google: contact weg → BB1', prG3.bevindingen.some((x) => x.bevinding_id === 'BB1-per:pim-proef-google') && prG3.bevindingen.some((x) => x.bevinding_id === 'BB1-per:pim-proef-google-weg'), prG3.bevindingen.map((x) => x.bevinding_id));

    // zegel = HMAC: met een andere sleutel klopt het niet; zonder sleutel geen zegel
    toets('11 zegel met een andere sleutel klopt niet', R.leesPersoon(PP, t1, KEY2).zegelFout === true && R.leesPersoon(PP, t1).zegelFout === true);
    toets('11 persoonMetZegel zonder sleutel weigert', !!R.persoonMetZegel(PP, t1).fout);
    // zonder zegelsleutel: personen niet gelezen, niets gestuurd, geen BB2, open persoonsbevinding blijft
    n11.db.bevindingen.push({ bevinding_id: 'BB3-per:pim-proef-handvatten', check_id: 'BB3', status: 'open', ernst: 'warning' });
    sleutel11 = null;
    const cz = await m11.compileer('dag');
    const bz = await m11.bibliothecaris({ afroep: true });
    toets('11 zonder zegelsleutel: niets gestuurd, fout gemeld, geen BB2, bevinding blijft open', cz.gestuurd === 0 && cz.fouten.some((f) => f.pad === '(personen)')
      && !bz.bevindingen.some((x) => /^BB2-per:/.test(x.bevinding_id)) && n11.db.bevindingen.some((x) => x.bevinding_id === 'BB3-per:pim-proef-handvatten') && /personen niet gemeten/.test(bz.zin), [cz.fouten, bz.zin]);
    sleutel11 = KEY;
    n11.db.bevindingen = n11.db.bevindingen.filter((x) => x.bevinding_id !== 'BB3-per:pim-proef-handvatten');
    // BB2: pagina bestaat nog maar het blok is weg → blok-weg (nooit "conceptpagina maken")
    fs.writeFileSync(path.join(v11, PP2), '---\ntype: persoon\nnaam: "Roos Voorbeeld"\n---\nTekst.\n');
    const bw = await m11.bibliothecaris({ afroep: true });
    toets('11 blok weg op een bestaande pagina: BB2-blok-weg', bw.bevindingen.some((x) => x.bevinding_id === 'BB2-per:roos-voorbeeld-blok-weg') && !bw.bevindingen.some((x) => x.bevinding_id === 'BB2-per:roos-voorbeeld-geen-pagina'), bw.bevindingen.map((x) => x.bevinding_id));
    const kbw = R.kaartBiblio({ knopen: [{ id: 'per:roos-voorbeeld', naam: 'Roos Voorbeeld' }], kaarten: [], bevindingen: [{ bevinding_id: 'BB2-per:roos-voorbeeld-blok-weg', check_id: 'BB2', ernst: 'warning', status: 'open' }] }, { nu: Date.parse('2026-10-28T02:31:00Z') });
    toets('11 kaart bij blok-weg maakt geen nieuwe pagina', kbw.kaart && /Ik zet het terug/.test(kbw.kaart.stappen[0]) && !/conceptpagina/.test(kbw.kaart.stappen[0]), kbw.kaart && kbw.kaart.stappen);
    fs.writeFileSync(path.join(v11, PP2), t2z);
    // databank weigert een persoon → BB6-per:…-compileer (telt mee in per_verschil)
    const prc = R.checks([R.leesPersoon(PP, persoon(), KEY)], n11.db, [{ pad: PP, fout: 'databank: object_id hoort niet', persoon: 'per:pim-proef' }], null, null, n11.db.personen);
    toets('11 compileerfout persoon telt mee', prc.bevindingen.some((x) => x.bevinding_id === 'BB6-per:pim-proef-compileer') && prc.tel.per_verschil >= 1, prc.bevindingen.map((x) => x.bevinding_id));
    // kaarten: personen hooguit 6 van 12 zolang organisaties wachten; privé-vlag; titel
    const kn = [], hv = [], pgs = [];
    for (let i = 0; i < 9; i++) { const id = 'org:org-' + i; kn.push({ id, soort: 'organisatie', naam: 'Org ' + i, vault_pagina: '10_Zakelijk/_Gedeeld/Relaties/Org ' + i + '.md', bron_sha: 's' + i }); pgs.push({ id, pad: '10_Zakelijk/_Gedeeld/Relaties/Org ' + i + '.md', sha: 's' + i, fouten: [], zaad: [] }); hv.push({ id: 1000 + i, knoop: id, soort: 'domein', waarde: 'org' + i + '.example', waarde_norm: 'org' + i + '.example', status: 'voorgesteld', herkomst: { sha: 'x' } }); }
    for (let i = 0; i < 9; i++) { const id = 'per:p-' + i; kn.push({ id, soort: 'persoon', naam: 'Persoon ' + i, vault_pagina: '10_Zakelijk/X/P' + i + '.md', bron_sha: 'q' + i }); pgs.push({ id, pad: '10_Zakelijk/X/P' + i + '.md', sha: 'q' + i, fouten: [], zaad: ['mail p' + i + '@x.example: mailkaart, 900 mails'], persoon: true }); hv.push({ id: 2000 + i, knoop: id, soort: 'mail', waarde: 'p' + i + '@x.example', waarde_norm: 'p' + i + '@x.example', status: 'voorgesteld', herkomst: { sha: 'y' } }); }
    const kb = R.kaartBundel({ knopen: kn, handvatten: hv, kaarten: [] }, pgs, { nu: Date.parse('2026-10-28T02:31:00Z') });
    const nP = kb.kaart ? kb.kaart.stappen.filter((x) => /Persoon/.test(x)).length : -1;
    toets('11 bundel: 6 personen + 6 organisaties, privé, titel noemt beide', kb.kaart && kb.kaart.stappen.length === 12 && nP === 6 && kb.kaart.prive === true && /organisaties en personen/.test(kb.kaart.titel), kb.kaart && [kb.kaart.titel, nP, kb.kaart.prive]);
    const kb2 = R.kaartBundel({ knopen: kn.filter((k) => k.soort === 'persoon'), handvatten: hv.filter((h) => /^per:/.test(h.knoop)), kaarten: [] }, pgs.filter((p) => p.persoon), { nu: Date.parse('2026-10-28T02:31:00Z') });
    toets('11 bundel alleen personen: vult aan tot 9, titel personen', kb2.kaart && kb2.kaart.stappen.length === 9 && /bij 9 personen/.test(kb2.kaart.titel), kb2.kaart && kb2.kaart.titel);
    const kbb = R.kaartBiblio({ knopen: [{ id: 'per:pim-proef', naam: 'Pim Proef' }], kaarten: [], bevindingen: [{ bevinding_id: 'BB6-per:pim-proef-zegel', check_id: 'BB6', ernst: 'warning', status: 'open' }] }, { nu: Date.parse('2026-10-28T02:31:00Z') });
    toets('11 Bibliothecariskaart: zegel in gewone taal, privé', kbb.kaart && kbb.kaart.prive === true && /Pim Proef: op de pagina is buiten mij om/.test(kbb.kaart.stappen[0]), kbb.kaart);
    toets('11 bevinding-id personen herkend', R.PER_BEVINDING_RE.test('BB5-org:a-b-per:c-1') && R.PER_BEVINDING_RE.test('BB6-per:x-zegel') && !R.PER_BEVINDING_RE.test('BB3-org:per-x-handvatten'));
  }
  // ── 12. plek 8: D1 fin (wv1012; Fable vooraf mk-scripts/wv1012/ontwerp.md) — verzonnen entiteiten, medewerkers en cijfers ──
  {
    const STAM = (code, map, kvk, iban, extraDb) => ['---', 'type: entiteit', 'entiteit_id: ' + code, 'soort: eigen', 'status: vast', 'naam: "Proef ' + code + '"',
      'kvk: "' + kvk + '"', 'iban: "' + iban + '"', 'contact: {}', 'ovis:', '  db: ["supabase:secondbrain/knoop#' + code + '", "cloudflare:d1-fin/entiteit#' + code + '"' + (extraDb || '') + ']', '---', '# ' + code, ''].join('\n');
    const SP = { TG: '10_Zakelijk/Tolgaarde/Entiteit - TG.md', POT: '10_Zakelijk/POT_POH_GGZ/Entiteit - POT.md' };
    const IREG = 'NL00TEST0000000101', IOUD = 'NL00TEST0000000202';
    const anker = (o) => ({ TG: R.leesPagina(SP.TG, STAM('TG', '10_Zakelijk/Tolgaarde', '11112222', 'NL00TEST0000000303')), POT: R.leesPagina(SP.POT, STAM('POT', '10_Zakelijk/POT_POH_GGZ', '33334444', IREG)), ...(o || {}) });
    const MW = '10_Zakelijk/POT_POH_GGZ/Medewerkers/';
    const mdw = (id, velden, db) => ['---', 'type: medewerker'].concat(velden).concat(db === null ? [] : ['ovis:', '  db: [' + (db || '"cloudflare:d1-fin/medewerker#' + id + '"') + ']']).concat(['---', '# Proef', '']).join('\n');
    const MDW = () => [
      R.leesMedewerker(MW + 'Proef Een.md', mdw(1, ['status: actief', 'medewerker_nr: 41', 'functie: "PO GGZ"', 'in_dienst: 01-03-2025', 'uit_dienst: 30-06-2026'])),   // uit vóór de laatste loonrun, loonstroken lopen door
      R.leesMedewerker(MW + 'Proef Twee.md', mdw(2, ['status: uit_dienst', 'medewerker_nr: "42, 43"', 'functie: "POH-GGZ"', 'in_dienst: 01-01-2025', 'uit_dienst: 31-05-2026'])),
      R.leesMedewerker(MW + 'Proef Drie.md', mdw(3, ['status: uit_dienst', 'functie: "Medewerker"', 'in_dienst: 01-01-2016', 'uit_dienst: 31-08-2024'], '"supabase:secondbrain/knoop#per:proef-drie", "cloudflare:d1-fin/medewerker#3"')),
      R.leesMedewerker(MW + 'Proef Vier.md', mdw(4, ['status: actief', 'medewerker_nr: 44', 'functie: "PO GGZ"', 'in_dienst: 15-08-2026', 'uit_dienst: 14-02-2027'])),   // einde in de toekomst
      R.leesMedewerker(MW + 'Proef Vijf.md', mdw(5, ['status: uit_dienst', 'medewerker_nr: 45', 'functie: "PO GGZ"', 'in_dienst: 01-02-2026', 'uit_dienst: 30-09-2026'])),   // vertrekt in de maand van de laatste loonrun
      R.leesMedewerker(MW + 'Proef Zes.md', mdw(6, ['status: actief', 'medewerker_nr: 46', 'functie: "PO GGZ"', 'in_dienst: 01-11-2026'])),   // begint na de laatste loonrun
    ];
    const M = () => ({
      entiteiten: [{ code: 'TG', kvk: '11112222', agb: null, iban: null, vault_pad: '10_Zakelijk/Tolgaarde' }, { code: 'POT', kvk: null, agb: null, iban: IREG, vault_pad: '10_Zakelijk/POT_POH_GGZ' },
        { code: 'PROEF', kvk: null, agb: null, iban: null, vault_pad: null }],
      medewerkers: [1, 2, 3, 4, 5, 6].map((id) => ({ id })),
      dienst: [{ id: 11, medewerker_id: 1, entiteit: 'POT', functie: 'PO GGZ', begin: '2025-03-01', einde: null, personeelsnummer: '41', herkomst: 'loonstrook' },
        { id: 21, medewerker_id: 2, entiteit: 'POT', functie: 'POH-GGZ', begin: '2025-01-01', einde: '2025-12-31', personeelsnummer: '42', herkomst: 'loonstrook' },
        { id: 22, medewerker_id: 2, entiteit: 'POT', functie: 'PO GGZ', begin: '2026-01-01', einde: '2026-05-31', personeelsnummer: '43', herkomst: 'loonstrook' },
        { id: 31, medewerker_id: 3, entiteit: 'POT', functie: 'POH-GGZ', begin: '2024-01-01', einde: '2025-09-30', personeelsnummer: null, herkomst: 'journaalposten' },
        { id: 41, medewerker_id: 4, entiteit: 'POT', functie: 'PO GGZ', begin: '2026-08-15', einde: null, personeelsnummer: '44', herkomst: 'loonstrook' },
        { id: 51, medewerker_id: 5, entiteit: 'POT', functie: 'PO GGZ', begin: '2026-02-01', einde: null, personeelsnummer: '45', herkomst: 'loonstrook' }],
      loonrun: 202609,
      reeks: [{ entiteit: 'TG', rubriek: 'omzet_totaal', jaar: 2024, bedrag: 1000000.4, bron_id: 1 }, { entiteit: 'TG', rubriek: 'omzet_totaal', jaar: 2025, bedrag: 1100000, bron_id: 2 },
        { entiteit: 'TG', rubriek: 'k_lonen', jaar: 2025, bedrag: 300000, bron_id: 2 }, { entiteit: 'TG', rubriek: 'k_soc', jaar: 2025, bedrag: 50000, bron_id: 2 },
        { entiteit: 'TG', rubriek: 'resultaat', jaar: 2025, bedrag: -1234.6, bron_id: 2 }] });
    const KERNT = (code) => ['---', 'type: gegenereerd', 'status: actueel', 'ovis:', '  db: ["cloudflare:d1-fin/reeks#' + code + '"]', '---', '# Kerncijfers', '', 'Uitleg.', ''].join('\n');
    const KP = '10_Zakelijk/Tolgaarde/Financieel/Kerncijfers - TG.md';
    const REG = () => ({ knopen: [{ id: 'TG', soort: 'entiteit', rol: 'eigen', naam: 'Proef TG', iban: 'NL00TEST0000000303' }, { id: 'POT', soort: 'entiteit', rol: 'eigen', naam: 'Proef POT', iban: IREG }], handvatten: [], contact: [], vertaling: [], bevindingen: [], log: [] });
    const FIN = (o) => Object.assign({ meting: M(), mdw: MDW(), kern: [R.leesKern(KP, KERNT('TG'))] }, o || {});
    const finB = (r) => r.bevindingen.filter((b) => R.FIN_BEVINDING_RE.test(b.bevinding_id));
    const ids = (r) => finB(r).map((b) => b.bevinding_id).join(' ');
    const C = (fin, ank, reg) => { const tel = {}, b = []; const bev = (c, s, sa, d, e) => b.push({ bevinding_id: c + '-' + s, check_id: c, samenvatting: sa, detail: d, ernst: e || 'warning' });
      const f = R.finChecks(ank || anker(), fin, reg || REG(), bev, tel); return { bevindingen: b, tel, fin: f }; };
    // parser
    const PT = (db) => ['---', 'type: medewerker', 'object_id: 0b0e1d2c-3a4b-4c5d-8e6f-7a8b9c0d1e2f', 'ovis:', '  db: [' + db + ']', '  status: concept', '---', '# Proef', ''].join('\n');
    const lp = R.leesPersoon(MW + 'Proef Een.md', PT('"supabase:secondbrain/knoop#per:proef-een", "cloudflare:d1-fin/medewerker#1"'), 'ab'.repeat(32));
    toets('12 personenlezer (wv1011) accepteert één datahub-medewerker in ovis.db; zegel dekt hem', lp && !lp.fouten.some((x) => /onbekende sleutel|datahub/.test(x)) && lp.fouten.some((x) => /zegel/.test(x)), lp && lp.fouten);
    toets('12 personenlezer: twee datahub-medewerkers = fout', R.leesPersoon(MW + 'Proef Een.md', PT('"supabase:secondbrain/knoop#per:proef-een", "cloudflare:d1-fin/medewerker#1", "cloudflare:d1-fin/medewerker#2"'), 'ab'.repeat(32)).fouten.some((x) => /meer dan één datahub/.test(x)));
    toets('12 medewerkerpagina geldig (ook met een knoop#per:-sleutel ernaast)', MDW().every((p) => p.fouten.length === 0) && MDW()[2].id === 3, MDW().map((p) => p.fouten));
    toets('12 twee nummers op één pagina gelezen', JSON.stringify(MDW()[1].nrs) === '["42","43"]', MDW()[1].nrs);
    toets('12 datum onleesbaar = fout', R.leesMedewerker(MW + 'X.md', mdw(9, ['status: actief', 'in_dienst: ergens in 2025'])).fouten.length > 0);
    toets('12 twee medewerker-sleutels = fout', R.leesMedewerker(MW + 'X.md', mdw(9, ['status: actief'], '"cloudflare:d1-fin/medewerker#9", "cloudflare:d1-fin/medewerker#8"')).fouten.length > 0);
    toets('12 kerncijferpagina buiten Financieel = fout', R.leesKern('10_Zakelijk/Tolgaarde/Kerncijfers - TG.md', KERNT('TG')).fouten.length > 0 && R.leesKern(KP, KERNT('GH')).fouten.length > 0);
    toets('12 finMaand leest DD-MM-JJJJ en JJJJ-MM-DD', R.finMaand('30-06-2026') === 202606 && R.finMaand('2026-06-30') === 202606 && R.finMaand('') === null && Number.isNaN(R.finMaand('juni')));
    // vergelijking
    let r = C(FIN());
    toets('12 medewerkers: alleen #1 (einde op de pagina vóór de laatste loonrun, loonstroken lopen door) en geen kerncijferblok (BB4-telling)',
      ids(r) === 'BB3-fin-mdw-1-uit' && r.tel.fin_mdw === 6 && r.tel.fin_verouderd === 1 && r.tel.fin === 2, [ids(r), r.tel]);
    toets('12 journaalposten tellen niet voor in/uit dienst; "Medewerker" niet als functie vergeleken; vertrek in de maand van de loonrun en begin erna niet te toetsen', r.tel.fin_niet_toetsbaar >= 3, r.tel);
    toets('12 bevindingen zonder naam of datum', finB(r).every((b) => !/Proef|2026|2025|30-06/.test(b.samenvatting + b.detail)), finB(r));
    const mU = M(); mU.dienst[0].einde = '2026-06-30';
    toets('12 loonstroken met hetzelfde einde: geen uit-verschil (wel status: pagina zegt nog actief)', !/mdw-1-uit/.test(ids(C(FIN({ meting: mU })))) && /mdw-1-status/.test(ids(C(FIN({ meting: mU })))), ids(C(FIN({ meting: mU }))));
    const mS = M(); mS.dienst[0].einde = '2026-04-30';
    toets('12 ander einde in de loonstroken: BB3 uit, status actief maar loonstroken uit: BB3 status', /BB3-fin-mdw-1-uit/.test(ids(C(FIN({ meting: mS })))) && /BB3-fin-mdw-1-status/.test(ids(C(FIN({ meting: mS })))), ids(C(FIN({ meting: mS }))));
    const mN = M(); mN.dienst[1].personeelsnummer = '49';
    toets('12 personeelsnummer niet op de pagina: BB3 nummer', /BB3-fin-mdw-2-nummer/.test(ids(C(FIN({ meting: mN })))));
    const mF = M(); mF.dienst[4].functie = 'POH-GGZ jeugd';
    toets('12 andere functie: BB3 functie (PO GGZ = POH-GGZ telt als gelijk)', /BB3-fin-mdw-4-functie/.test(ids(C(FIN({ meting: mF })))) && !/mdw-2-functie/.test(ids(r)));
    const mI = M(); mI.dienst[0].begin = '2025-04-01';
    toets('12 andere indiensttreding (loonstrook): BB3 in', /BB3-fin-mdw-1-in/.test(ids(C(FIN({ meting: mI })))));
    const mB = M(); mB.medewerkers.push({ id: 7 });
    toets('12 medewerker zonder pagina: BB2; pagina naar onbekende medewerker: BB1; twee pagina\'s: BB5',
      /BB2-fin-mdw-7-geen-pagina/.test(ids(C(FIN({ meting: mB })))) && /BB1-fin-mdw-9-onbekend/.test(ids(C(FIN({ mdw: MDW().concat([R.leesMedewerker(MW + 'Negen.md', mdw(9, ['status: actief']))]) }))))
      && /BB5-fin-mdw-4-twee/.test(ids(C(FIN({ mdw: MDW().concat([R.leesMedewerker(MW + 'Vier bis.md', mdw(4, ['status: actief']))]) })))));
    toets('12 medewerkerpagina bij een andere werkgever: BB6 plek', /BB6-fin-mdw-1-plek/.test(ids(C(FIN({ mdw: [R.leesMedewerker('10_Zakelijk/Tolgaarde/Medewerkers/Proef Een.md', mdw(1, ['status: actief', 'medewerker_nr: 41', 'in_dienst: 01-03-2025']))].concat(MDW().slice(1)) })))));
    // entiteit
    const aK = anker({ TG: R.leesPagina(SP.TG, STAM('TG', '', '99998888', 'NL00TEST0000000303')) });
    toets('12 entiteit: KvK anders in de hub = BB3; KvK leeg in de hub = geen verschil', /BB3-fin-ent-TG-kvk/.test(ids(C(FIN(), aK))) && !/POT-kvk/.test(ids(C(FIN(), aK))), ids(C(FIN(), aK)));
    const regO = REG(); regO.knopen[1].iban = IOUD;
    r = C(FIN(), null, regO);
    toets('12 rekeningnummer in de hub ≠ register: BB3 serious, alleen laatste 4 in melding en verschil', /BB3-fin-ent-POT-iban/.test(ids(r)) && finB(r).find((b) => /iban/.test(b.bevinding_id)).ernst === 'serious'
      && r.fin.verschillen.length === 1 && r.fin.verschillen[0].d1 === '0101' && r.fin.verschillen[0].reg === '0202' && !/NL00TEST/.test(JSON.stringify(finB(r))), [ids(r), r.fin.verschillen]);
    toets('12 vergelijkt met het register, niet met de pagina (voorstel op de pagina telt niet)', !/iban/.test(ids(C(FIN(), anker({ POT: R.leesPagina(SP.POT, STAM('POT', '', '33334444', IOUD)) })))));
    const mE = M(); mE.entiteiten.push({ code: 'GH', kvk: null, agb: null, iban: null, vault_pad: '10_Zakelijk/Groenhouten' });
    toets('12 hub-entiteit zonder stampagina: BB2; PROEF telt niet', /BB2-fin-ent-GH-geen-pagina/.test(ids(C(FIN({ meting: mE })))) && !/PROEF/.test(ids(C(FIN({ meting: mE })))));
    toets('12 map in de hub ≠ map van de stampagina: BB3 map', (() => { const m = M(); m.entiteiten[0].vault_pad = '10_Zakelijk/Elders'; return /BB3-fin-ent-TG-map/.test(ids(C(FIN({ meting: m })))); })());
    // kerncijfers
    const blok = R.finKernBlokTekst('TG', M());
    toets('12 kerncijferblok: jaren als kolommen, hele euro\'s, personeel opgeteld, – waar niets is, geen datum', /\| bedragen in hele euro's \| 2024 \| 2025 \|/.test(blok) && /\| Omzet \| 1\.000\.000 \| 1\.100\.000 \|/.test(blok)
      && /\| Personeelskosten \| – \| 350\.000 \|/.test(blok) && /\| Resultaat \| – \| −1\.235 \|/.test(blok) && /Bron: 2 jaarrekeningen/.test(blok) && blok.indexOf('id="fin:TG"') > 0, blok);
    const mR = M(); mR.reeks.push({ entiteit: 'POT', rubriek: 'k_som_bruto', jaar: 2025, bedrag: 5, bron_id: 3 });
    toets('12 entiteit met cijfers zonder kerncijferpagina: BB2 kern', /BB2-fin-kern-POT-geen-pagina/.test(ids(C(FIN({ meting: mR })))));
    toets('12 kerncijferpagina voor een entiteit zonder cijfers: BB1', /BB1-fin-kern-POT-onbekend/.test(ids(C(FIN({ kern: [R.leesKern(KP, KERNT('TG')), R.leesKern('10_Zakelijk/POT_POH_GGZ/Financieel/Kerncijfers - POT.md', KERNT('POT'))] })))));
    // niet gemeten, vergelijking die faalt
    r = C(FIN({ meting: { fout: 'D1 weg' } }));
    toets('12 D1 weg: niet gemeten, geen bevindingen', r.fin.gemeten === false && finB(r).length === 0 && r.tel.fin === 'niet gemeten');
    toets('12 finMeting: leeg = niet gemeten; alleen SELECT', (await R.finMeting({ d1: async (b) => b.map(() => ({ results: [] })) })).fout !== undefined && R.FIN_SQL.every((q) => /^\s*select\b/i.test(q.sql)));
    const kapot = M(); kapot.dienst.push(null);
    const rc = R.checks([], REG(), [], null, null, null, FIN({ meting: kapot }));
    toets('12 vergelijking die faalt: niet gemeten, geen halve fin-bevindingen', rc.fin.gemeten === false && /vergelijking faalde/.test(rc.fin.reden) && rc.bevindingen.filter((b) => R.FIN_BEVINDING_RE.test(b.bevinding_id)).length === 0, rc.fin);
    // weekkaart en kritieke kaart
    const kb = R.kaartBiblio({ knopen: [], kaarten: [], bevindingen: [{ bevinding_id: 'BB3-fin-mdw-1-uit', check_id: 'BB3', ernst: 'warning', status: 'open' },
      { bevinding_id: 'BB3-fin-ent-POT-iban', check_id: 'BB3', ernst: 'serious', status: 'open' }, { bevinding_id: 'BB2-fin-kern-GH-geen-pagina', check_id: 'BB2', ernst: 'warning', status: 'open' }] }, { nu: Date.parse('2026-10-28T02:31:00Z') });
    toets('12 weekkaart: medewerkerverschil zonder nummer, rekeningnummer (kritiek) niet op de weekkaart', kb.kaart && kb.kaart.stappen.length === 2 && /POT-medewerker/.test(kb.kaart.stappen[0]) && !/#1|mdw/.test(kb.kaart.stappen.join(' ')) && /kerncijferpagina/.test(kb.kaart.stappen[1]), kb);
    const vk = C(FIN(), null, regO).fin;
    let kf = R.kaartFin(vk, {}, '28-10 02:31');
    toets('12 kritieke kaart: één doen-kaart, alleen laatste 4 cijfers, stappen in gewone taal', kf.zet.length === 1 && /^ovis-fin-iban-pot-[0-9a-f]{6}$/.test(kf.zet[0].sleutel) && !/NL00TEST/.test(JSON.stringify(kf.zet[0])) && kf.zet[0].titel.length <= 90 && kf.zet[0].waarom.length <= 400, kf.zet[0]);
    const sl = kf.zet[0].sleutel;
    toets('12 kritieke kaart staat er al: niet opnieuw; verschil weg: dicht met bewijs', R.kaartFin(vk, { [sl]: 'open' }, 'x').zet.length === 0 && R.kaartFin(C(FIN()).fin, { [sl]: 'open' }, '29-10 02:31').dicht.length === 1
      && R.kaartFin({ gemeten: false, verschillen: [] }, { [sl]: 'open' }, 'x').dicht.length === 0);
    // diffreview (Opus, 28-10): herindiensttreding na de loonrun, parallelle contracten, geen loonstroken, hervatting, datum met tijddeel
    const een = (velden, dienst, extraM) => { const m = Object.assign(M(), extraM || {}); m.dienst = dienst; m.medewerkers = [{ id: 1 }]; return ids(C(FIN({ meting: m, mdw: [R.leesMedewerker(MW + 'Proef Een.md', mdw(1, velden))] }))); };
    let x = een(['status: actief', 'medewerker_nr: 41', 'in_dienst: 01-11-2026'], [{ id: 1, medewerker_id: 1, entiteit: 'POT', functie: 'PO GGZ', begin: '2024-01-01', einde: '2025-06-30', personeelsnummer: '41', herkomst: 'loonstrook' }]);
    toets('12 herindiensttreding na de laatste loonrun: niet te toetsen (geen in/uit/status)', !/mdw-1-(in|uit|status)/.test(x), x);
    x = een(['status: actief', 'medewerker_nr: 41', 'in_dienst: 01-01-2025'], [{ id: 1, medewerker_id: 1, entiteit: 'POT', functie: 'PO GGZ', begin: '2025-01-01', einde: null, personeelsnummer: '41', herkomst: 'loonstrook' },
      { id: 2, medewerker_id: 1, entiteit: 'POT', functie: 'PO GGZ', begin: '2025-06-01', einde: '2025-12-31', personeelsnummer: '41', herkomst: 'loonstrook' }]);
    toets('12 parallel contract met einde naast een open contract: in dienst, geen verschil', !/mdw-1-/.test(x), x);
    x = een(['status: actief', 'functie: "POH-GGZ"'], [{ id: 1, medewerker_id: 1, entiteit: 'POT', functie: 'POH-GGZ', begin: '2021-01-01', einde: null, personeelsnummer: null, herkomst: 'urenregistratie' }]);
    toets('12 alleen urenregistratie en pagina actief: niet te toetsen', !/mdw-1-/.test(x), x);
    x = een(['status: actief', 'medewerker_nr: "41, 42"', 'in_dienst: 01-07-2026'], [{ id: 1, medewerker_id: 1, entiteit: 'POT', functie: 'PO GGZ', begin: '2025-01-01', einde: '2026-01-31', personeelsnummer: '41', herkomst: 'loonstrook' },
      { id: 2, medewerker_id: 1, entiteit: 'POT', functie: 'PO GGZ', begin: '2026-07-06', einde: null, personeelsnummer: '42', herkomst: 'loonstrook' }]);
    toets('12 hervatting na een gat: pagina met de datum van de herindiensttreding is gelijk', !/mdw-1-/.test(x), x);
    const mT = M(); mT.dienst[0].einde = '2026-06-30T00:00:00';
    r = R.checks([], REG(), [], null, null, null, FIN({ meting: mT }));
    toets('12 datum met tijddeel uit de hub: niet gemeten, geen vals verschil', r.fin.gemeten === false && !r.bevindingen.some((b) => /-fin-/.test(b.bevinding_id)), r.fin);
    const kv = R.leesKern(KP, KERNT('TG').replace(/\n$/, '') + '\n\n' + R.finKernBlokTekst('TG', M()) + '\n');
    const mK2 = M(); mK2.reeks = mK2.reeks.filter((y) => y.jaar === 2025);
    toets('12 hub geeft minder cijfers dan het blok: BB4 krimp (zichtbaar), geen telling', /BB4-fin-kern-TG-krimp/.test(ids(C(FIN({ meting: mK2, kern: [kv] })))) && !/krimp/.test(ids(C(FIN({ kern: [kv] })))), ids(C(FIN({ meting: mK2, kern: [kv] }))));
    // nacht: blok schrijven, idempotent, handwerk, niet krimpen; Bibliothecaris: opgelost-filter bij niet gemeten
    const v11 = wegwerpVault({ [KP]: KERNT('TG'), [SP.TG]: STAM('TG', '', '11112222', 'NL00TEST0000000303') });
    const n11 = nepDb({ knopen: [], handvatten: [], contact: [], vertaling: [], bevindingen: [], log: [] });
    let finIo = { d1: async () => { const m = M(); return [m.entiteiten, m.medewerkers, m.dienst, [{ m: m.loonrun }], m.reeks].map((x) => ({ results: x })); } };
    const m11 = R.maak({ vault: v11, sbRpc: n11.sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: (p, t) => fs.writeFileSync(p, t), nu: () => Date.parse('2026-10-28T01:15:00Z'), fin: { d1: (b) => finIo.d1(b) } });
    let c11 = await m11.compileer('nacht', { grendel: true });
    const na = fs.readFileSync(path.join(v11, KP), 'utf8');
    toets('12 nacht: kerncijferblok geschreven, vingerafdruk gelijk', c11.finblokken === 1 && na.indexOf('id="fin:TG"') > 0 && R.vingerafdruk(na).sha === R.leesKern(KP, KERNT('TG')).sha, c11);
    c11 = await m11.compileer('nacht', { grendel: true });
    toets('12 nacht tweede keer: niets geschreven', c11.finblokken === 0 && fs.readFileSync(path.join(v11, KP), 'utf8') === na, c11);
    const krimp = finIo.d1;
    finIo = { d1: async (b) => { const r0 = await krimp(b); r0[4].results = r0[4].results.filter((x) => x.jaar === 2025); return r0; } };
    c11 = await m11.compileer('nacht', { grendel: true });
    toets('12 nacht: minder cijfers dan nu = niet geschreven, fout gemeld', c11.finblokken === 0 && c11.fouten.some((f) => /minder cijfers/.test(f.fout)) && fs.readFileSync(path.join(v11, KP), 'utf8') === na, c11.fouten);
    finIo = { d1: krimp };
    fs.writeFileSync(path.join(v11, KP), na.replace('| Omzet |', '| Omzet (met de hand) |'));
    c11 = await m11.compileer('nacht', { grendel: true });
    let b11 = await m11.bibliothecaris({ afroep: true });
    toets('12 handwerk: niet overschreven, BB8 kern', fs.readFileSync(path.join(v11, KP), 'utf8').indexOf('met de hand') > 0 && b11.bevindingen.some((b) => b.bevinding_id === 'BB8-fin-kern-TG-blok'), b11.bevindingen.map((b) => b.bevinding_id));
    finIo = { d1: async () => { throw new Error('weg'); } };
    const voor11 = n11.db.bevindingen.filter((b) => /-fin-/.test(b.bevinding_id)).length;
    b11 = await m11.bibliothecaris({ afroep: true });
    toets('12 D1 weg: fin-bevindingen blijven open, zin zegt niet gemeten', voor11 > 0 && n11.db.bevindingen.filter((b) => /-fin-/.test(b.bevinding_id)).length === voor11 && /D1 fin niet gemeten/.test(b11.zin), [voor11, b11.zin]);
    c11 = await m11.compileer('nacht', { grendel: true });
    toets('12 D1 weg: nacht raakt geen kerncijferpagina aan, meldt de fout', c11.finblokken === 0 && c11.fouten.some((f) => f.pad === '(D1 fin)'), c11.fouten);
  }
  console.log(goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering ' + (e && e.stack || e)); process.exit(1); });
JS
