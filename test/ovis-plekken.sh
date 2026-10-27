#!/usr/bin/env bash
# Toetst ovis-plekken.js (wv1013, OVIS-koppelregels plek 9–12; ontwerp mk-scripts/wv1013/ontwerp.md) en de haak in ovis-register.js.
# Toetst: plek 9 R2 ⇄ D1 ⇄ bronnenregister (BB1/BB2/BB5/BB6/BB8, verouderd als telling, blok deterministisch, | ontsnapt, nachtblok: alleen
# bij verschil, niet over handwerk, niet als de pagina tijdens de ronde verandert, droog schrijft niets, D1 weg = niets aanraken), plek 10
# Woordenlijst ⇄ register (dode [knoop:], achterstand alleen telling tot 8 dagen, - ?-regels tellen niet), plek 11 Deadlines (ongeldige
# datum, dode link zonder pad in de bevinding, verlopen > 14 dagen zonder afhandelwoord als één bevinding, tabel aan het eind van de sectie),
# plek 12 Cijfer-Meester (patroon <jaar>, pad in de hoofdmap via bestaat, bestand zonder rij, Bibliotheek achter), elke plek los gemeten,
# niet gemeten ≠ opgelost via de Bibliothecaris van ovis-register.js, geen kaart aan David voor plek 9–12, boxRij.
# Raakt niets buiten een wegwerpmap. Gebruik: bash test/ovis-plekken.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const R = require('./ovis-register.js'), P = require('./ovis-plekken.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
function verzamel() { const b = []; return { b, bev: function (c, s, z, d, e) { b.push({ id: c + '-' + s, check: c, z, d, e: e || 'warning' }); } }; }
const ids = (b) => b.map((x) => x.id).sort();

// ── plek 9 ──
const BRON = [
  { id: 1, entiteit: 'GH', soort: 'jaarrekening', titel: 'Jaarrekening 2024 GH', datum: null, periode_van: '2024-01-01', periode_tot: '2024-12-31', r2_sleutel: 'fin-bronnen/GH/2024/jr.pdf', gecontroleerd: 0, opmerking: 'balans sluit' },
  { id: 2, entiteit: null, soort: 'cao', titel: 'Cao | tabel', datum: '2026-07-03', periode_van: null, periode_tot: null, r2_sleutel: null, gecontroleerd: 1, opmerking: null },
  { id: 3, entiteit: 'TG', soort: 'vip_export', titel: 'VIP TG', datum: null, periode_van: null, periode_tot: null, r2_sleutel: 'fin-bronnen/TG/vip.xlsx', gecontroleerd: 0, opmerking: '' },
];
const R2 = [{ key: 'GH/2024/jr.pdf', size: 10 }, { key: 'TG/vip.xlsx', size: 20 }];
const PAG = (blok) => ['---', 'type: register', 'vertrouwelijk: true', 'ovis:', '  db: ["cloudflare:d1-fin/bron", "cloudflare:r2-fin-bronnen"]', 'updated: 2026-10-28', '---', '', '# Register', '', 'Uitleg.', '', blok || '', '', '## Controleregels', '', '- iets', ''].join('\n');
{
  const blok = P.r2bBlokTekst(BRON);
  toets('9 blok deterministisch en onafhankelijk van volgorde', blok === P.r2bBlokTekst(BRON.slice().reverse()));
  toets('9 blok: | in een titel ontsnapt, leeg = —, gecontroleerd = ja', /Cao \\\| tabel/.test(blok) && /\| 2 \| — \| cao \|/.test(blok) && /\| ja \|/.test(blok), blok);
  toets('9 blok: geen datum van vandaag erin', !/2026-10-28/.test(blok));
  let v = verzamel(), tel = {};
  P.r2bChecks({ bron: BRON, r2: R2 }, P.leesR2bPagina(PAG(blok)), v.bev, tel);
  toets('9 gelijk → 0 bevindingen, niet verouderd', v.b.length === 0 && tel.r2_verouderd === 0 && tel.r2_objecten === 2 && tel.r2_bronnen === 3, [v.b, tel]);
  v = verzamel(); tel = {};
  P.r2bChecks({ bron: BRON, r2: R2 }, P.leesR2bPagina(PAG('')), v.bev, tel);
  toets('9 geen blok → alleen telling verouderd (de nacht schrijft het), geen bevinding', v.b.length === 0 && tel.r2_verouderd === 1, [v.b, tel]);
  const bron2 = BRON.concat([{ id: 4, entiteit: 'TG', soort: 'x', titel: 'dubbel', r2_sleutel: 'fin-bronnen/TG/vip.xlsx' }, { id: 5, titel: 'weg', r2_sleutel: 'fin-bronnen/TG/weg.pdf' }, { id: 6, titel: 'raar', r2_sleutel: 'TG/raar.pdf' }]);
  v = verzamel(); tel = {};
  P.r2bChecks({ bron: bron2, r2: R2.concat([{ key: 'POT/los.pdf', size: 1 }]) }, P.leesR2bPagina(PAG(blok)), v.bev, tel);
  const c = v.b.map((x) => x.check).sort().join(',');
  toets('9 BB1 (sleutel zonder object, serious), BB2 (object zonder rij), BB5 (dubbel), BB6 (sleutel zonder prefix)', c === 'BB1,BB2,BB5,BB6' && v.b.find((x) => x.check === 'BB1').e === 'serious', v.b);
  toets('9 bevinding-id\'s vallen onder REST_BEVINDING_RE', v.b.every((x) => P.REST_BEVINDING_RE.test(x.id) && R.REST_BEVINDING_RE.test(x.id)), ids(v.b));
  v = verzamel(); tel = {};
  P.r2bChecks({ bron: BRON, r2: R2 }, P.leesR2bPagina(PAG(blok).replace('  db: ["cloudflare:d1-fin/bron", "cloudflare:r2-fin-bronnen"]', '  db: ["cloudflare:r2-fin-bronnen"]')), v.bev, tel);
  toets('9 ovis.db mist de D1-sleutel → BB6-r2-pagina', ids(v.b).join() === 'BB6-r2-pagina', v.b);
  v = verzamel(); tel = {};
  P.r2bChecks({ bron: BRON, r2: R2 }, P.leesR2bPagina(PAG(blok.replace('Jaarrekening 2024 GH', 'Jaarrekening 2024 GH (met de hand)'))), v.bev, tel);
  toets('9 handwerk in het blok → BB6-r2-blok (BB8 neemt de databank nog niet aan)', ids(v.b).join() === 'BB6-r2-blok', v.b);
  v = verzamel(); tel = {};
  P.r2bChecks({ bron: BRON, r2: R2 }, P.leesR2bPagina(null), v.bev, tel);
  toets('9 pagina weg → BB6-r2-pagina', ids(v.b).join() === 'BB6-r2-pagina', v.b);
}
(async function () {
  // meting
  let m = await P.r2bMeting({ d1: async (b) => { if (!/^select/.test(b[0].sql)) throw new Error('x'); return [{ results: BRON }]; }, r2: async () => R2 });
  toets('9 meting: bron en r2', m.bron.length === 3 && m.r2.length === 2, m);
  m = await P.r2bMeting({ d1: async () => [{ results: [] }], r2: async () => R2 });
  toets('9 meting: D1 leeg → fout (niet gemeten)', !!m.fout, m);
  m = await P.r2bMeting({ d1: async () => [{ results: BRON }], r2: async () => { throw new Error('R2 http 403'); } });
  toets('9 meting: R2 weg → fout', /403/.test(m.fout || ''), m);
  toets('9 meting zonder lezer → fout', !!(await P.r2bMeting(null)).fout);
  // r2Lijst: kop, paginering
  { const urls = []; let n = 0;
    const f = async (u, o) => { urls.push([u, o.headers['cf-r2-jurisdiction']]); n++; return { ok: true, status: 200, json: async () => n === 1 ? { success: true, result: [{ key: 'a', size: 1 }], result_info: { is_truncated: true, cursor: 'c 1' } } : { success: true, result: [{ key: 'b', size: 2 }], result_info: { is_truncated: false } } }; };
    const l = await P.r2Lijst(f, 'tok', 'acc', 'fin-bronnen');
    toets('9 r2Lijst: twee pagina\'s, cursor ontsnapt, EU-kop', l.length === 2 && urls[1][0].indexOf('cursor=c%201') > 0 && urls.every((x) => x[1] === 'eu'), urls);
    let fout = null; try { await P.r2Lijst(async () => ({ ok: false, status: 404, json: async () => ({}) }), 'tok', 'acc', 'b'); } catch (e) { fout = e.message; }
    toets('9 r2Lijst: http-fout gooit', /404/.test(fout || ''), fout);
  }
  // nacht
  { const v = fs.mkdtempSync(path.join(os.tmpdir(), 'ovisp-')); const vol = path.join(v, P.R2B_PAD);
    fs.mkdirSync(path.dirname(vol), { recursive: true }); fs.writeFileSync(vol, PAG(''));
    const io = { d1: async () => [{ results: BRON }] };
    const O = (extra) => Object.assign({ vault: v, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: (p, t) => fs.writeFileSync(p, t), io }, extra || {});
    let u = await P.nacht(O({ droog: true }));
    toets('9 nacht droog: telt, schrijft niet', u.blokken === 1 && fs.readFileSync(vol, 'utf8') === PAG(''), u);
    u = await P.nacht(O());
    const na = fs.readFileSync(vol, 'utf8');
    toets('9 nacht: blok geschreven, rest van de pagina blijft', u.blokken === 1 && R.huidigBlok(na) === P.r2bBlokTekst(BRON) && /## Controleregels/.test(na) && /^updated: 2026-10-28$/m.test(na), u);
    u = await P.nacht(O());
    toets('9 nacht: tweede keer niets (idempotent)', u.blokken === 0 && fs.readFileSync(vol, 'utf8') === na, u);
    fs.writeFileSync(vol, na.replace('VIP TG', 'VIP TG met de hand'));
    u = await P.nacht(O({ io: { d1: async () => [{ results: BRON.concat([{ id: 9, titel: 'nieuw' }]) }] } }));
    toets('9 nacht: handwerk in het blok → niet overschreven', u.handwerk === 1 && u.blokken === 0 && /met de hand/.test(fs.readFileSync(vol, 'utf8')), u);
    fs.writeFileSync(vol, na); let teller = 0;
    u = await P.nacht(O({ io: { d1: async () => [{ results: BRON.slice(0, 2) }] }, lees: (p) => { teller++; return teller > 1 ? na.replace('Uitleg.', 'Anders.') : fs.readFileSync(p, 'utf8'); } }));
    toets('9 nacht: pagina veranderd tijdens de ronde → geen blok, fout gemeld', u.blokken === 0 && u.fouten.length === 1 && fs.readFileSync(vol, 'utf8') === na, u);
    u = await P.nacht(O({ io: { d1: async () => { throw new Error('D1 http 503'); } } }));
    toets('9 nacht: D1 weg → niets aangeraakt, fout in de uitvoer', u.blokken === 0 && u.fouten.length === 1 && fs.readFileSync(vol, 'utf8') === na, u);
    u = await P.nacht(O({ io: { d1: async () => [{ results: [] }] } }));
    toets('9 nacht: D1 leeg → niets aangeraakt', u.blokken === 0 && u.fouten.length === 0 && fs.readFileSync(vol, 'utf8') === na, u);
    fs.writeFileSync(vol, PAG('').replace(/ovis:\n.*\n/, ''));
    u = await P.nacht(O());
    toets('9 nacht: pagina zonder ovis.db → geen blok (Bibliothecaris meldt)', u.blokken === 0 && !/ovis:blok/.test(fs.readFileSync(vol, 'utf8')), u);
    fs.rmSync(v, { recursive: true, force: true });
  }

  // ── plek 10 ──
  const WL = (regels, datum, extra) => ['# Woordenlijst', '', '## Handmatig', '- Zilveren Kruis · ZK — verzekeraar', '- KPN · kpn.nl [knoop:org:kpn] — telefonie', '- ? Iets · Onbekend [knoop:XX] — te bevestigen',
    extra || '', '', '## Entiteiten', '<!-- GEGENEREERD:entiteiten BEGIN -->', '*Gegenereerd ' + datum + ' uit het entiteitenregister, n regels.*', ''].concat(regels).concat(['<!-- GEGENEREERD:entiteiten EIND -->', '']).join('\n');
  const KN = [{ id: 'TG', naam: 'Huisartsenpraktijk Tolgaarde B.V.', aliassen: ['Tolgaarde'] }, { id: 'org:kpn', naam: 'KPN', aliassen: [] }];
  const REG = ['- **TG** · Huisartsenpraktijk Tolgaarde B.V. · Tolgaarde [knoop:TG] — [[10_Zakelijk/Tolgaarde/Entiteit - TG]]', '- KPN [knoop:org:kpn] — [[10_Zakelijk/_Gedeeld/Relaties/KPN]]'];
  { let v = verzamel(), tel = {};
    P.wlChecks(P.leesWoordenlijst(WL(REG, '2026-10-25')), KN, '2026-10-28', v.bev, tel);
    toets('10 gelijk → 0 bevindingen, 0 achter, - ?-regel telt niet', v.b.length === 0 && tel.wl_verouderd === 0 && tel.wl_regels === 2, [v.b, tel]);
    v = verzamel(); tel = {};
    P.wlChecks(P.leesWoordenlijst(WL(REG.slice(0, 1), '2026-10-25')), KN.concat([{ id: 'org:x', naam: 'X BV', aliassen: ['Iks'] }]), '2026-10-28', v.bev, tel);
    toets('10 register verder dan het blok, blok 3 dagen oud → alleen telling', v.b.length === 0 && tel.wl_verouderd === 2, [v.b, tel]);
    v = verzamel(); tel = {};
    P.wlChecks(P.leesWoordenlijst(WL(REG.slice(0, 1), '2026-10-18')), KN, '2026-10-28', v.bev, tel);
    toets('10 achter én blok > 8 dagen → BB4-wl-oud', ids(v.b).join() === 'BB4-wl-oud', v.b);
    v = verzamel(); tel = {};
    P.wlChecks(P.leesWoordenlijst(WL(REG, '2026-10-18')), [KN[0], { id: 'org:kpn', naam: 'KPN', aliassen: ['Koninklijke KPN'] }], '2026-10-28', v.bev, tel);
    toets('10 nieuwe actieve alias niet in het blok → telt als achter', tel.wl_verouderd === 1 && ids(v.b).join() === 'BB4-wl-oud', [v.b, tel]);
    v = verzamel(); tel = {};
    P.wlChecks(P.leesWoordenlijst(WL(REG, '2026-10-25', '- Oud · Weg [knoop:GONE] — vervallen')), KN, '2026-10-28', v.bev, tel);
    toets('10 handmatige regel naar een onbekende knoop → BB1-wl-knoop-<hash> (geen naam in het id)', v.b.length === 1 && v.b[0].check === 'BB1' && /^BB1-wl-knoop-[0-9a-f]{6}$/.test(v.b[0].id), v.b);
    v = verzamel(); tel = {};
    P.wlChecks(P.leesWoordenlijst('# zonder blok'), KN, '2026-10-28', v.bev, tel);
    toets('10 blok weg → BB6-wl-blok', ids(v.b).join() === 'BB6-wl-blok', v.b);
  }

  // ── plek 11 ──
  const DL = (rijen) => ['---', 'type: register', '---', '# Deadlines', '', '## Actueel', '', '| Datum | Entiteit | Wat | Actie | Signaleer | Bron |', '|---|---|---|---|---|---|']
    .concat(rijen).concat(['', '## Kandidaten', '', '| Wat | Bron |', '|---|---|', '| iets zonder datum | — |', '', '## Afgehandeld', '', '| Datum | Wat |', '|---|---|', '| 2026-01-01 | oud |']).join('\n');
  const BEST = new Set(['10_Zakelijk/TG/notulen.md', '20_Prive/x.md']);
  const bestaat = (r) => BEST.has(r);
  { const rijen = ['| 2026-11-30 | Tolgaarde | **ZK** accepteren | David | 7 | [[10_Zakelijk/TG/notulen\\|Notulen]] |',
      '| 2026-09-01 | Privé | iets met Persoon Jansen | David | 1 | [[20_Prive/Medewerkers/Persoon Jansen]] |',
      '| 2026-09-02 | Privé | **AFGEHANDELD 3-9** klaar | — | 0 | [[20_Prive/x]] |',
      '| 2026-09-03 | Privé | is gedaan (kleine letters) | — | 0 | [[../buiten]] |',
      '| 2026-10-20 | GH | net verlopen | — | 0 | [[Losse naam]] |',
      '| 2026-09 | Groenhouten | maand | — | 0 | — |'];
    const d = P.leesDeadlines(DL(rijen));
    toets('11 tabel Actueel gelezen tot de volgende sectie (Kandidaten/Afgehandeld tellen niet)', d.fouten.length === 0 && d.rijen.length === 6, d);
    const v = verzamel(), tel = {}, paden = {};
    P.dlChecks(d, '2026-10-28', bestaat, v.bev, tel, paden);
    const c = ids(v.b);
    toets('11 ongeldige datum → BB6-dl-datum', c.some((x) => /^BB6-dl-datum-/.test(x)), c);
    const dood = v.b.find((x) => /^BB6-dl-link-/.test(x.id));
    toets('11 dode link → BB6-dl-link, zonder bestandsnaam (persoon) in de bevinding; pad alleen in paden', !!dood && !/Jansen/.test(dood.z + dood.d) && /20_Prive\/Medewerkers\/…/.test(dood.d) && Object.values(paden).some((p) => /Jansen/.test(p)), [dood, paden]);
    const ver = v.b.find((x) => x.id === 'BB6-dl-verlopen');
    toets('11 verlopen > 14 dagen zonder afhandelwoord: 1 (niet de AFGEHANDELD- of gedaan-regel, niet die van 8 dagen terug)', !!ver && tel.dl_verlopen === 1 && ver.e === 'warning' && /oudste 2026-09-01/.test(ver.d), [ver, tel]);
    toets('11 losse wikilink, .. en absoluut pad worden niet getoetst; links met pad wel', tel.dl_links === 3, tel);
    toets('11 geen Wat-tekst in bevindingen (alleen datum en entiteit)', !v.b.some((x) => /ZK|maand|iets met/.test(x.z + x.d)), v.b);
    const v2 = verzamel(), t2 = {};
    P.dlChecks(P.leesDeadlines('# leeg'), '2026-10-28', bestaat, v2.bev, t2, {});
    toets('11 tabel Actueel weg → BB6-dl-pagina', ids(v2.b).join() === 'BB6-dl-pagina', v2.b);
  }

  // ── plek 12 ──
  { const best = ['10_Verwerkt/A - 2024 - x.pdf', '10_Verwerkt/V 2013 - g.csv', '10_Verwerkt/V 2014 - g.csv', '10_Verwerkt/los.pdf', '20_Producten/p.html'];
    const m = { bronnen: [{ id: 1, bestandspad: '10_Verwerkt/A - 2024 - x.pdf', in_bibliotheek: true }, { id: 2, bestandspad: '10_Verwerkt/V <jaar> - g.csv (14 jaargangen)', in_bibliotheek: true },
      { id: 3, bestandspad: null, in_bibliotheek: false }, { id: 4, bestandspad: '10_Verwerkt/weg.pdf', in_bibliotheek: true }],
      producten: [{ id: 1, bestandspad: '20_Producten/p.html' }, { id: 2, bestandspad: 'Overzicht.md' }] };
    const v = verzamel(), tel = {};
    P.cmChecks(m, best, { bronnen: 3, producten: 2 }, v.bev, tel, (r) => r === '90_Cijfermeester/Overzicht.md');
    toets('12 patroon <jaar> dekt beide jaargangen; pad in de hoofdmap telt via bestaat; BB1 bron 4; BB2 los.pdf; Bibliotheek gelijk', ids(v.b).join() === ['BB1-cm-b4-geen-bestand', 'BB2-cm-' + require('crypto').createHash('sha256').update('10_Verwerkt/los.pdf').digest('hex').slice(0, 6) + '-geen-rij'].sort().join(), v.b);
    const v2 = verzamel(), t2 = {};
    P.cmChecks(m, best, { bronnen: 95, producten: 2 }, v2.bev, t2, () => true);
    toets('12 Bibliotheek zegt iets anders dan de databank → BB4-cm-bibliotheek', v2.b.some((x) => x.id === 'BB4-cm-bibliotheek' && x.e === 'warning') && t2.cm_verouderd === 1, v2.b);
    toets('12 patroon: ".." in een pad telt nooit als bestaand', (function () { const v3 = verzamel(); P.cmChecks({ bronnen: [{ id: 9, bestandspad: '../geheim.txt' }], producten: [] }, [], null, v3.bev, {}, () => true); return v3.b.length === 1; })());
    let mm = await P.cmMeting({ sbRpc: async (f) => f === 'ovis_zorgdata_paden' ? { bronnen: m.bronnen, producten: m.producten } : null });
    toets('12 cmMeting via de smalle RPC', mm.bronnen.length === 4 && mm.producten.length === 2, mm);
    mm = await P.cmMeting({ sbRpc: async () => { throw new Error('rpc http 404'); } });
    toets('12 cmMeting: RPC weg → fout', /404/.test(mm.fout || ''), mm);
    toets('12 Bibliotheek-frontmatter gelezen', JSON.stringify(P.leesBibliotheek('---\nbronnen: 95\nproducten: 15\n---\n')) === '{"bronnen":95,"producten":15}');
  }

  // ── de ronde + de haak in ovis-register.js ──
  { const v = fs.mkdtempSync(path.join(os.tmpdir(), 'ovisp-'));
    const zet = (rel, t) => { fs.mkdirSync(path.join(v, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(v, rel), t); };
    zet(P.R2B_PAD, PAG(P.r2bBlokTekst(BRON)));
    zet(P.WL_PAD, WL(['- KPN [knoop:org:kpn] — [[x]]'], '2026-10-25', '- Oud [knoop:GONE] — weg'));
    zet(P.DL_PAD, DL(['| 2026-11-30 | TG | x | — | 1 | — |']));
    zet('90_Cijfermeester/10_Verwerkt/a.pdf', 'x'); zet('90_Cijfermeester/20_Producten/p.html', 'x'); zet('90_Cijfermeester/Bibliotheek.md', '---\nbronnen: 1\nproducten: 1\n---\n');
    const db = { knopen: [{ id: 'org:kpn', soort: 'organisatie', naam: 'KPN', aliassen: [], vault_pagina: 'x.md', concept: true }], handvatten: [], contact: [], vertaling: [], bevindingen: [], log: [], kaarten: [] };
    let cm = { bronnen: [{ id: 1, bestandspad: '10_Verwerkt/a.pdf', in_bibliotheek: true }], producten: [{ id: 1, bestandspad: '20_Producten/p.html' }] };
    const sbRpc = async (fn, body) => {
      if (fn === 'ovis_register_lees') return JSON.parse(JSON.stringify(db));
      if (fn === 'ovis_zorgdata_paden') { if (cm instanceof Error) throw cm; return cm; }
      if (fn === 'ovis_bibliothecaris_zet') { body.p_rijen.forEach((r) => { if (!/^BB[1-7]-/.test(r.bevinding_id) || (r.check_id && !/^BB[1-7]$/.test(r.check_id)) || (r.ernst && ['good', 'warning', 'serious', 'critical'].indexOf(r.ernst) < 0)) throw new Error('ovis_bibliothecaris_zet: alleen BB-bevindingen (' + r.bevinding_id + ', ' + r.ernst + ')'); });
        body.p_rijen.forEach((r) => { const b = db.bevindingen.find((x) => x.bevinding_id === r.bevinding_id); if (b) Object.assign(b, r); else db.bevindingen.push(Object.assign({}, r)); }); db.bevindingen = db.bevindingen.filter((x) => x.status !== 'opgelost'); return { ok: true }; }
      if (fn === 'mk_hartslag_stempel') return [{}];
      throw new Error('onbekende rpc ' + fn);
    };
    let rest = { d1: async () => [{ results: BRON }], r2: async () => R2 };
    const m = R.maak({ vault: v, sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: () => {}, nu: () => Date.parse('2026-10-28T01:30:00Z'), get rest() { return rest; } });
    let b = await m.bibliothecaris({ afroep: true });
    const open = () => db.bevindingen.filter((x) => P.REST_BEVINDING_RE.test(x.bevinding_id)).map((x) => x.bevinding_id).sort();
    toets('haak: plek 9–12 gemeten, alleen de dode [knoop:] als bevinding, zin noemt alle vier', open().length === 1 && /^BB1-wl-knoop-/.test(open()[0]) && /R2-bronnen: 2 bestanden/.test(b.zin) && /Woordenlijst: 1 entiteitregels/.test(b.zin) && /Deadlines: 1 rijen/.test(b.zin) && /Cijfer-Meester: 2 bestanden/.test(b.zin), [open(), b.zin]);
    toets('haak: plekstand in de uitkomst', b.rest && b.rest.plekken.r2.gemeten && b.rest.plekken.cm.gemeten, b.rest);
    rest = { d1: async () => [{ results: BRON }], r2: async () => R2.concat([{ key: 'los.pdf', size: 1 }]) };
    b = await m.bibliothecaris({ afroep: true });
    const bb2 = open().find((x) => /^BB2-r2-/.test(x));
    toets('haak: R2-object zonder rij → open bevinding', !!bb2, open());
    rest = { d1: async () => { throw new Error('D1 http 503'); }, r2: async () => R2 };
    b = await m.bibliothecaris({ afroep: true });
    toets('haak: D1 weg → plek 9 niet gemeten, BB2-r2 blijft open, andere plekken lopen door', open().indexOf(bb2) >= 0 && /R2-bronnen niet gemeten/.test(b.zin) && /Deadlines: 1 rijen/.test(b.zin) && b.opgelost === 0, [open(), b.zin]);
    cm = new Error('rpc http 500'); rest = { d1: async () => [{ results: BRON }], r2: async () => R2 };
    b = await m.bibliothecaris({ afroep: true });
    toets('haak: R2 weer gelijk → BB2-r2 opgelost; zorgdata weg → Cijfer-Meester niet gemeten', open().indexOf(bb2) < 0 && /Cijfer-Meester niet gemeten/.test(b.zin), [open(), b.zin]);
    { const was = fs.readFileSync(path.join(v, P.DL_PAD), 'utf8');
      fs.writeFileSync(path.join(v, P.DL_PAD), DL(['| 2026-08-01 | TG | oud | — | 1 | — |']));
      await m.bibliothecaris({ afroep: true });
      const voor = open().filter((x) => x === 'BB6-dl-verlopen');
      fs.writeFileSync(path.join(v, P.DL_PAD), '# Deadlines\n\n## Anders\n');
      b = await m.bibliothecaris({ afroep: true });
      toets('haak: tabel Actueel weg → BB6-dl-pagina erbij, BB6-dl-verlopen blijft open (half ≠ opgelost), zin zegt niet gemeten', voor.length === 1 && open().indexOf('BB6-dl-verlopen') >= 0 && open().indexOf('BB6-dl-pagina') >= 0 && /Deadlines niet gemeten/.test(b.zin), [open(), b.zin]);
      fs.writeFileSync(path.join(v, P.DL_PAD), was);
      b = await m.bibliothecaris({ afroep: true });
      toets('haak: tabel weer heel → beide opgelost', open().indexOf('BB6-dl-verlopen') < 0 && open().indexOf('BB6-dl-pagina') < 0, open());
      cm = { bronnen: [{ id: 1, bestandspad: '10_Verwerkt/a.pdf', in_bibliotheek: true }], producten: [{ id: 1, bestandspad: '20_Producten/p.html' }] };
      fs.writeFileSync(path.join(v, '90_Cijfermeester/Bibliotheek.md'), '---\nbronnen: 7\nproducten: 1\n---\n');
      await m.bibliothecaris({ afroep: true });
      const bib = open().indexOf('BB4-cm-bibliotheek') >= 0;
      fs.unlinkSync(path.join(v, '90_Cijfermeester/Bibliotheek.md'));
      await m.bibliothecaris({ afroep: true });
      toets('haak: Bibliotheek.md weg → BB4-cm-bibliotheek blijft open (niet gemeten)', bib && open().indexOf('BB4-cm-bibliotheek') >= 0, open());
      fs.writeFileSync(path.join(v, '90_Cijfermeester/Bibliotheek.md'), '---\nbronnen: 1\nproducten: 1\n---\n');
      await m.bibliothecaris({ afroep: true });
      toets('haak: Bibliotheek weer gelijk → opgelost', open().indexOf('BB4-cm-bibliotheek') < 0, open());
    }
    toets('haak: geen kaart aan David voor plek 9–12 (wel open rest-bevindingen)', db.bevindingen.some((x) => P.REST_BEVINDING_RE.test(x.bevinding_id)) && !R.kaartBiblio({ knopen: db.knopen, bevindingen: db.bevindingen.filter((x) => P.REST_BEVINDING_RE.test(x.bevinding_id)).map((x) => Object.assign({ status: 'open' }, x)), kaarten: [], log: [] }, { nu: Date.parse('2026-10-28T01:30:00Z') }).kaart);
    const box = R.boxRij({ zin: 'z', nieuw: 1, nieuw_box: 1, nieuwe: [{ bevinding_id: 'BB2-r2-abc-geen-rij', check_id: 'BB2', samenvatting: 's' }] }, '2026-10-28 02:31');
    toets('haak: boxRij noemt plek 9–12 als machinekamerwerk', /plek 9–12/.test(box), box);
    const m2 = R.maak({ vault: v, sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: () => {}, nu: () => Date.parse('2026-10-28T01:30:00Z') });
    b = await m2.bibliothecaris({ afroep: true });
    toets('haak: zonder R2/D1-lezer → plek 9 niet gemeten, rest gemeten', /R2-bronnen niet gemeten/.test(b.zin) && /Woordenlijst: 1/.test(b.zin), b.zin);
    fs.rmSync(v, { recursive: true, force: true });
  }
  toets('uitrol-lijst en Dockerfile kennen ovis-plekken.js (anders stil "niet gemeten" na de uitrol)', /^RELEASE_OPTIONEEL="[^"]*\bovis-plekken\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')) && /COPY ovis-plekken\.js \/app\/release-bootstrap\/ovis-plekken\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
