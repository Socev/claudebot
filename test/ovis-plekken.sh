#!/usr/bin/env bash
# Toetst ovis-plekken.js (wv1013, OVIS-koppelregels plek 9–12; ontwerp mk-scripts/wv1013/ontwerp.md) en de haak in ovis-register.js.
# Toetst: plek 9 R2 ⇄ D1 ⇄ bronnenregister (BB1/BB2/BB5/BB6/BB8, verouderd als telling, blok deterministisch, | ontsnapt, nachtblok: alleen
# bij verschil, niet over handwerk, niet als de pagina tijdens de ronde verandert, droog schrijft niets, D1 weg = niets aanraken), plek 10
# Woordenlijst ⇄ register (dode [knoop:], achterstand alleen telling tot 8 dagen, - ?-regels tellen niet), plek 11 Deadlines (ongeldige
# datum, dode link zonder pad in de bevinding, verlopen > 14 dagen zonder afhandelwoord als één bevinding, tabel aan het eind van de sectie),
# plek 12 Cijfer-Meester (patroon <jaar>, pad in de hoofdmap via bestaat, bestand zonder rij, Bibliotheek achter), elke plek los gemeten,
# niet gemeten ≠ opgelost via de Bibliothecaris van ovis-register.js, geen kaart aan David voor plek 9–12, boxRij; wv1774 plek 13 (D1 knie)
# en 14 (health-pod): verwijzingen uit 20_Prive/Gezondheid, BB1 rij/tabel/soort weg, BB6 vorm en vervangen rij op een actuele pagina,
# niets medisch in bevinding/zin/databank, alleen vaste health-pod-paden, halve lijst = niet gemeten.
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
  toets('9 handwerk in het blok → BB8-r2-blok (wv1805: de databank neemt BB8 aan sinds 28-10)', ids(v.b).join() === 'BB8-r2-blok' && P.REST_BEVINDING_RE.test('BB8-r2-blok'), v.b);
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
  { const best = ['10_Verwerkt/A - 2024 - x.pdf', '10_Verwerkt/V 2013 - g.csv', '10_Verwerkt/V 2014 - g.csv', '10_Verwerkt/los.pdf', '20_Producten/p.html'].map((x) => '90_Cijfermeester/' + x);
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
    // wv1877 (SB2 fase 5 V0): mengsel van oude (onder 90_Cijfermeester/) en nieuwe (vanaf de vaultwortel) paden
    const best2 = ['90_Cijfermeester/10_Verwerkt/oud.pdf', '90_Cijfermeester/10_Verwerkt/nieuwvorm.pdf', '90_Cijfermeester/10_Verwerkt/W 2020 - t.csv', '90_Cijfermeester/10_Verwerkt/W 2021 - t.csv',
      '40_Kennisbronnen/Uitgever A/Bronnen/Uitgever A - 2027 - lijst.pdf', '40_Kennisbronnen/Statistiek_Extern/Bureau B/Bronnen/B 2025 - t.csv', '40_Kennisbronnen/Statistiek_Extern/Bureau B/Bronnen/B 2026 - t.csv',
      '90_Cijfermeester/Werkboeken/Werkboek - proef.xlsx', '40_Kennisbronnen/Uitgever A/Bronnen/zonder-rij.pdf'];
    const m2 = { bronnen: [{ id: 11, bestandspad: '10_Verwerkt/oud.pdf' }, { id: 12, bestandspad: '90_Cijfermeester/10_Verwerkt/nieuwvorm.pdf' },
      { id: 13, bestandspad: '10_Verwerkt/W <jaar> - t.csv (2 jaargangen)' }, { id: 14, bestandspad: '40_Kennisbronnen/Uitgever A/Bronnen/Uitgever A - 2027 - lijst.pdf' },
      { id: 15, bestandspad: '40_Kennisbronnen/Statistiek_Extern/Bureau B/Bronnen/B <jaar> - t.csv' }, { id: 16, bestandspad: '90_Cijfermeester/Werkboeken/Werkboek - proef.xlsx' },
      { id: 17, bestandspad: '/etc/passwd' }, { id: 18, bestandspad: '40_Kennisbronnen/../20_Prive/x.md' }, { id: 19, bestandspad: '40_Kennisbronnen/<map>/Bronnen/x.pdf' },
      { id: 20, bestandspad: 'C:\\Users\\x.pdf' }, { id: 21, bestandspad: '40_Kennisbronnen/Uitgever A/Bronnen/weg.pdf' }],
      producten: [{ id: 5, bestandspad: '90_Cijfermeester/Overzicht.md' }, { id: 6, bestandspad: 'Overzicht.md' }] };
    const v4 = verzamel(), t4 = {};
    const gezocht = [];
    P.cmChecks(m2, best2, null, v4.bev, t4, (r) => { gezocht.push(r); return r === '90_Cijfermeester/Overzicht.md'; });
    const h = (x) => require('crypto').createHash('sha256').update(x).digest('hex').slice(0, 6);
    toets('12 mengsel: oude en nieuwe vorm, patroon in beide mappen, Werkboeken; BB1 alleen ongeldig (17–19, 20) en weg (21); BB2 alleen zonder-rij',
      ids(v4.b).join() === ['BB1-cm-b17-geen-bestand', 'BB1-cm-b18-geen-bestand', 'BB1-cm-b19-geen-bestand', 'BB1-cm-b20-geen-bestand', 'BB1-cm-b21-geen-bestand',
        'BB2-cm-' + h('40_Kennisbronnen/Uitgever A/Bronnen/zonder-rij.pdf') + '-geen-rij'].sort().join(), v4.b);
    toets('12 mengsel: bestaat() alleen met vaultwortelpaden, nooit voor een ongeldig pad', gezocht.every((r) => /^(90_Cijfermeester|40_Kennisbronnen)\//.test(r) && r.indexOf('..') < 0), gezocht);
    toets('12 BB2-id van een 90_Cijfermeester-bestand = id van vóór V0 (open bevinding blijft dezelfde)', (function () { const v5 = verzamel(); P.cmChecks({ bronnen: [], producten: [] }, ['90_Cijfermeester/10_Verwerkt/los.pdf'], null, v5.bev, {}, null); return ids(v5.b).join() === 'BB2-cm-' + h('10_Verwerkt/los.pdf') + '-geen-rij'; })());
    toets('12 bronnotitie (type: bron) herkend, gewone notitie niet', P.cmBronNotitie('---\ntitel: x\ntype: bron\n---\ntekst') && !P.cmBronNotitie('---\ntype: brondocument\n---\n') && !P.cmBronNotitie('type: bron\n'));
    { const boom = { '90_Cijfermeester/10_Verwerkt': [['a.pdf', 'b'], ['_register.md', 'b'], ['.x', 'b']], '90_Cijfermeester/20_Producten': [['p.html', 'b']],
        '40_Kennisbronnen': [['index.md', 'b'], ['NZa', 'm'], ['Statistiek_Extern', 'm']], '40_Kennisbronnen/NZa': [['index.md', 'b'], ['Bronnen', 'm'], ['Vergelijkingen', 'm']],
        '40_Kennisbronnen/NZa/Bronnen': [['N - 2026 - r.pdf', 'b'], ['N - 2026 - r (bronnotitie).md', 'b'], ['eigen.md', 'b']], '40_Kennisbronnen/NZa/Vergelijkingen': [['v.md', 'b']],
        '40_Kennisbronnen/Statistiek_Extern': [['S', 'm']], '40_Kennisbronnen/Statistiek_Extern/S': [['Bronnen', 'm']], '40_Kennisbronnen/Statistiek_Extern/S/Bronnen': [['s.csv', 'b']] };
      const lijst = (rel) => { if (!boom[rel]) { const e = new Error('ENOENT ' + rel); e.code = 'ENOENT'; throw e; } return boom[rel].map(([n, t]) => ({ naam: n, map: t === 'm', bestand: t === 'b' })); };
      const lees = (rel) => /bronnotitie/.test(rel) ? '---\ntype: bron\n---\n' : '---\ntype: notitie\n---\n';
      const bs = P.cmBestanden(lijst, lees);
      toets('12 cmBestanden: 10_Verwerkt + 20_Producten, Werkboeken mag ontbreken, alleen Bronnen-mappen onder 40_Kennisbronnen (ook dieper), bronnotitie niet',
        JSON.stringify((bs.bestanden || []).slice().sort()) === JSON.stringify(['40_Kennisbronnen/NZa/Bronnen/N - 2026 - r.pdf', '40_Kennisbronnen/NZa/Bronnen/eigen.md', '40_Kennisbronnen/Statistiek_Extern/S/Bronnen/s.csv', '90_Cijfermeester/10_Verwerkt/a.pdf', '90_Cijfermeester/20_Producten/p.html']), bs);
      const zonder = Object.assign({}, boom); Object.keys(zonder).forEach((k) => { if (k.indexOf('40_') === 0) delete zonder[k]; });
      const lijst2 = (rel) => { if (!zonder[rel]) { const e = new Error('x'); e.code = 'ENOENT'; throw e; } return lijst(rel); };
      toets('12 cmBestanden: geen 40_Kennisbronnen = alleen 90_Cijfermeester (proefvault)', ((P.cmBestanden(lijst2, lees).bestanden) || []).length === 2);
      const lijst3 = (rel) => { if (rel === '40_Kennisbronnen/NZa/Bronnen') { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } return lijst(rel); };
      toets('12 cmBestanden: onleesbare map onder 40_Kennisbronnen = niet gemeten', /niet te lezen/.test(P.cmBestanden(lijst3, lees).fout || ''));
      const lijst4 = (rel) => { if (rel === '90_Cijfermeester/20_Producten') { const e = new Error('x'); e.code = 'ENOENT'; throw e; } return lijst(rel); };
      toets('12 cmBestanden: onleesbare .md in Bronnen = niet gemeten (review ZOU 3)', /niet te lezen/.test(P.cmBestanden(lijst, (rel) => /eigen\.md$/.test(rel) ? null : lees(rel)).fout || ''));
      const diep = {}; let r = '40_Kennisbronnen'; diep['90_Cijfermeester/10_Verwerkt'] = []; diep['90_Cijfermeester/20_Producten'] = [];
      for (let i = 0; i < 8; i++) { diep[r] = [['m' + i, 'm']]; r += '/m' + i; } diep[r] = [['x.pdf', 'b']];
      const lijst5 = (rel) => { if (!diep[rel]) { const e = new Error('x'); e.code = 'ENOENT'; throw e; } return diep[rel].map(([n, t]) => ({ naam: n, map: t === 'm', bestand: t === 'b' })); };
      toets('12 cmBestanden: te diepe map = niet gemeten, niet stil overslaan (review ZOU 4)', /te diep/.test(P.cmBestanden(lijst5, lees).fout || ''));
      toets('12 cmBestanden: 20_Producten weg = niet gemeten (zoals vóór V0)', /20_Producten niet te lezen/.test(P.cmBestanden(lijst4, lees).fout || ''));
    }
    toets('12 Bibliotheek-frontmatter gelezen', JSON.stringify(P.leesBibliotheek('---\nbronnen: 95\nproducten: 15\n---\n')) === '{"bronnen":95,"producten":15}');
  }

  // ── de ronde + de haak in ovis-register.js ──
  { const v = fs.mkdtempSync(path.join(os.tmpdir(), 'ovisp-'));
    const zet = (rel, t) => { fs.mkdirSync(path.join(v, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(v, rel), t); };
    zet(P.R2B_PAD, PAG(P.r2bBlokTekst(BRON)));
    zet(P.WL_PAD, WL(['- KPN [knoop:org:kpn] — [[x]]'], '2026-10-25', '- Oud [knoop:GONE] — weg'));
    zet(P.DL_PAD, DL(['| 2026-11-30 | TG | x | — | 1 | — |']));
    zet('90_Cijfermeester/10_Verwerkt/a.pdf', 'x'); zet('90_Cijfermeester/20_Producten/p.html', 'x'); zet('90_Cijfermeester/Bibliotheek.md', '---\nbronnen: 2\nproducten: 1\n---\n');
    zet('40_Kennisbronnen/index.md', 'x'); zet('40_Kennisbronnen/NZa/Bronnen/k.pdf', 'x'); zet('40_Kennisbronnen/NZa/Bronnen/k (bronnotitie).md', '---\ntype: bron\n---\n');   // wv1877
    const db = { knopen: [{ id: 'org:kpn', soort: 'organisatie', naam: 'KPN', aliassen: [], vault_pagina: 'x.md', concept: true }], handvatten: [], contact: [], vertaling: [], bevindingen: [], log: [], kaarten: [] };
    let cm = { bronnen: [{ id: 1, bestandspad: '10_Verwerkt/a.pdf', in_bibliotheek: true }, { id: 2, bestandspad: '40_Kennisbronnen/NZa/Bronnen/k.pdf', in_bibliotheek: true }], producten: [{ id: 1, bestandspad: '90_Cijfermeester/20_Producten/p.html' }] };
    const sbRpc = async (fn, body) => {
      if (fn === 'ovis_register_lees') return JSON.parse(JSON.stringify(db));
      if (fn === 'ovis_zorgdata_paden') { if (cm instanceof Error) throw cm; return cm; }
      if (fn === 'ovis_bibliothecaris_zet') { body.p_rijen.forEach((r) => { if (!/^BB[1-8]-/.test(r.bevinding_id) || (r.check_id && !/^BB[1-8]$/.test(r.check_id)) || (r.ernst && ['good', 'warning', 'serious', 'critical'].indexOf(r.ernst) < 0)) throw new Error('ovis_bibliothecaris_zet: alleen BB-bevindingen (' + r.bevinding_id + ', ' + r.ernst + ')'); });
        body.p_rijen.forEach((r) => { const b = db.bevindingen.find((x) => x.bevinding_id === r.bevinding_id); if (b) Object.assign(b, r); else db.bevindingen.push(Object.assign({}, r)); }); db.bevindingen = db.bevindingen.filter((x) => x.status !== 'opgelost'); return { ok: true }; }
      if (fn === 'mk_hartslag_stempel') return [{}];
      throw new Error('onbekende rpc ' + fn);
    };
    let rest = { d1: async () => [{ results: BRON }], r2: async () => R2 };
    const m = R.maak({ vault: v, sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: () => {}, nu: () => Date.parse('2026-10-28T01:30:00Z'), get rest() { return rest; } });
    let b = await m.bibliothecaris({ afroep: true });
    const open = () => db.bevindingen.filter((x) => P.REST_BEVINDING_RE.test(x.bevinding_id)).map((x) => x.bevinding_id).sort();
    toets('haak: plek 9–12 gemeten, alleen de dode [knoop:] als bevinding, zin noemt alle vier', open().length === 1 && /^BB1-wl-knoop-/.test(open()[0]) && /R2-bronnen: 2 bestanden/.test(b.zin) && /Woordenlijst: 1 entiteitregels/.test(b.zin) && /Deadlines: 1 rijen/.test(b.zin) && /Cijfer-Meester: 3 bestanden/.test(b.zin), [open(), b.zin]);
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
      cm = { bronnen: [{ id: 1, bestandspad: '10_Verwerkt/a.pdf', in_bibliotheek: true }, { id: 2, bestandspad: '40_Kennisbronnen/NZa/Bronnen/k.pdf', in_bibliotheek: true }], producten: [{ id: 1, bestandspad: '90_Cijfermeester/20_Producten/p.html' }] };
      fs.writeFileSync(path.join(v, '90_Cijfermeester/Bibliotheek.md'), '---\nbronnen: 7\nproducten: 1\n---\n');
      await m.bibliothecaris({ afroep: true });
      const bib = open().indexOf('BB4-cm-bibliotheek') >= 0;
      fs.unlinkSync(path.join(v, '90_Cijfermeester/Bibliotheek.md'));
      await m.bibliothecaris({ afroep: true });
      toets('haak: Bibliotheek.md weg → BB4-cm-bibliotheek blijft open (niet gemeten)', bib && open().indexOf('BB4-cm-bibliotheek') >= 0, open());
      fs.writeFileSync(path.join(v, '90_Cijfermeester/Bibliotheek.md'), '---\nbronnen: 2\nproducten: 1\n---\n');
      await m.bibliothecaris({ afroep: true });
      toets('haak: Bibliotheek weer gelijk → opgelost', open().indexOf('BB4-cm-bibliotheek') < 0, open());
      // wv1805: handwerk in het R2-blok gaat als BB8 door de databank (mock = ^BB[1-8], zoals sinds 28-10)
      const r2was = fs.readFileSync(path.join(v, P.R2B_PAD), 'utf8');
      fs.writeFileSync(path.join(v, P.R2B_PAD), r2was.replace('Jaarrekening 2024 GH', 'Jaarrekening 2024 GH (met de hand)'));
      b = await m.bibliothecaris({ afroep: true });
      const r2blok = open().indexOf('BB8-r2-blok') >= 0 && db.bevindingen.find((x) => x.bevinding_id === 'BB8-r2-blok').check_id === 'BB8';
      fs.writeFileSync(path.join(v, P.R2B_PAD), r2was);
      b = await m.bibliothecaris({ afroep: true });
      toets('haak: handwerk in het R2-blok → BB8-r2-blok open via ovis_bibliothecaris_zet; blok weer gelijk → opgelost', r2blok && open().indexOf('BB8-r2-blok') < 0, open());
    }
    toets('haak: geen kaart aan David voor plek 9–12 (wel open rest-bevindingen)', db.bevindingen.some((x) => P.REST_BEVINDING_RE.test(x.bevinding_id)) && !R.kaartBiblio({ knopen: db.knopen, bevindingen: db.bevindingen.filter((x) => P.REST_BEVINDING_RE.test(x.bevinding_id)).map((x) => Object.assign({ status: 'open' }, x)), kaarten: [], log: [] }, { nu: Date.parse('2026-10-28T01:30:00Z') }).kaart);
    const box = R.boxRij({ zin: 'z', nieuw: 1, nieuw_box: 1, nieuwe: [{ bevinding_id: 'BB2-r2-abc-geen-rij', check_id: 'BB2', samenvatting: 's' }] }, '2026-10-28 02:31');
    toets('haak: boxRij noemt plek 9–14 als machinekamerwerk', /plek 9–14/.test(box), box);
    const m2 = R.maak({ vault: v, sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: () => {}, nu: () => Date.parse('2026-10-28T01:30:00Z') });
    b = await m2.bibliothecaris({ afroep: true });
    toets('haak: zonder R2/D1-lezer → plek 9 niet gemeten, rest gemeten', /R2-bronnen niet gemeten/.test(b.zin) && /Woordenlijst: 1/.test(b.zin), b.zin);
    fs.rmSync(v, { recursive: true, force: true });
  }
  // ── plek 13–14: gezondheid (wv1774; verzonnen data) ──
  { const H = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex').slice(0, 6);
    const PG = (status, regels, db) => ['---', 'type: themapagina', 'status: ' + status, db ? 'ovis:\n  db: ' + db : '', 'updated: 2026-10-28', '---', '', '# Proef', ''].concat(regels).join('\n');
    const p1 = P.gzPagina('20_Prive/Gezondheid/Proef - geheimeziekte.md', PG('actueel — proef', ['Zie `cloudflare:d1-knie/mijlpalen#proefmijl`.', 'En cloudflare:d1-knie/mijlpalen#proefmijl nog eens; olares:health-pod/diagnoses#7.', 'Losse olares:health-pod.'], '["cloudflare:d1-knie", "olares:health-pod/metingen#gewicht"]'));
    toets('13/14 gzPagina: verwijzingen uit ovis.db en tekst, ontdubbeld, punt eraf, status actueel', p1.actueel && p1.refs.map((r) => r.ref).join() === 'cloudflare:d1-knie,cloudflare:d1-knie/mijlpalen#proefmijl,olares:health-pod,olares:health-pod/diagnoses#7,olares:health-pod/metingen#gewicht' && p1.refs[1].plek === 'kn' && p1.refs[1].tabel === 'mijlpalen' && p1.refs[1].id === 'proefmijl', p1);
    toets('13/14 gzPagina: status concept is niet actueel; "health-pod" in proza is geen verwijzing', !P.gzPagina('x.md', PG('concept', ['de health-pod en de knie-app'])).actueel && P.gzPagina('x.md', PG('concept', ['de health-pod en knie.socev.dev'])).refs.length === 0);
    // plek 13
    const KP = [P.gzPagina('20_Prive/Gezondheid/Map/Proef - geheimeziekte.md', PG('actueel', ['cloudflare:d1-knie/mijlpalen#proefjuist cloudflare:d1-knie/mijlpalen#proefweg cloudflare:d1-knie/rondes#2026-10-21/u0800 cloudflare:d1-knie/push_log#1 cloudflare:d1-knie/dagen#21-10 cloudflare:d1-knie/compex cloudflare:d1-knie/fases cloudflare:d1-knie#zonder']))];
    const KT = new Set(['mijlpalen', 'rondes', 'dagen', 'compex', 'push_log']);   // fases ontbreekt (verzonnen migratie)
    let v = verzamel(), tel = {}, paden = {};
    P.knChecks({ tabellen: KT, gevonden: { mijlpalen: new Set(['proefjuist']), rondes: new Set(['2026-10-21/u0800']) } }, KP, v.bev, tel, paden);
    const kc = v.b.map((x) => x.id.replace(/-[0-9a-f]{6}-/, '-…-')).sort();
    toets('13 BB1 rij weg, BB1 tabel weg, BB6 machinestaat-tabel, BB6 datum in de verkeerde vorm, BB6 zonder tabel; bestaande rij, ronde (datum/slot) en tabelverwijzing gelijk', kc.join() === ['BB1-kn-…-geen-rij', 'BB1-kn-…-geen-tabel', 'BB6-kn-…-vorm', 'BB6-kn-…-vorm', 'BB6-kn-…-vorm'].sort().join() && tel.kn_verwijzingen === 8 && tel.kn_paginas === 1, [kc, tel]);
    toets('13 geen paginanaam, geen sleutelwaarde, geen map onder Gezondheid in bevindingen; wel in paden', v.b.every((x) => !/geheimeziekte|proefweg|proefjuist|Map\//.test(x.z + x.d)) && Object.values(paden).some((x) => /geheimeziekte.*proefweg/.test(x)), v.b);
    toets('13 bevinding-id\'s vallen onder REST_BEVINDING_RE (beide modules) en zijn stabiel', v.b.every((x) => P.REST_BEVINDING_RE.test(x.id) && R.REST_BEVINDING_RE.test(x.id)) && v.b.some((x) => x.id === 'BB1-kn-' + H(KP[0].pad + '|cloudflare:d1-knie/mijlpalen#proefweg') + '-geen-rij'), ids(v.b));
    { const vragen = [];
      const kn = async (b) => { vragen.push(b[0]); if (/sqlite_master/.test(b[0].sql)) return [{ results: Array.from(KT).map((n) => ({ name: n })) }]; return [{ results: b[0].params.filter((x) => x === 'proefjuist' || x === '2026-10-21/u0800').map((k) => ({ k })) }]; };
      const m = await P.knMeting({ kn }, KP);
      toets('13 knMeting: alleen SELECT, alleen de sleutelkolom, met parameters; geen vraag voor tabelverwijzingen of een foute vorm', vragen.every((q) => /^select /.test(q.sql) && !/;/.test(q.sql)) && vragen.length === 3 && /select id as k from mijlpalen where id in \(\?, \?\)/.test(vragen[1].sql) && /datum \|\| '\/' \|\| slot/.test(vragen[2].sql) && m.gevonden.mijlpalen.has('proefjuist') && !m.gevonden.dagen, [vragen, m]);
      const veel = [P.gzPagina('20_Prive/Gezondheid/a.md', PG('actueel', Array.from({ length: 120 }, (_, i) => 'cloudflare:d1-knie/mijlpalen#m' + i)))];
      vragen.length = 0; await P.knMeting({ kn }, veel);
      toets('13 knMeting: per 50 sleutels één vraag (D1-grens 100 parameters)', vragen.length === 4 && vragen.slice(1).every((q) => q.params.length <= 50), vragen.map((q) => q.params.length));
      toets('13 knMeting: geen lezer / leeg / fout → niet gemeten', !!(await P.knMeting({}, KP)).fout && !!(await P.knMeting({ kn: async () => [{ results: [] }] }, KP)).fout && /503/.test((await P.knMeting({ kn: async () => { throw new Error('D1 knie http 503'); } }, KP)).fout || ''));
    }
    // plek 14
    toets('14 hpUitslag: JSON, ingekort gooit (behalve één rapport), 404 = weigert, alleen "geen rapport met dit id" telt als geen rapport, onbereikbaar gooit', P.hpUitslag({ code: 0, stdout: '{"a":1}' }).j.a === 1 && P.hpUitslag({ code: 3, stdout: 'POD WEIGERT: HTTP 404 {"detail":"x"}\n' }).weigert === 404
      && !P.hpUitslag({ code: 3, stdout: 'POD WEIGERT: HTTP 404 {"detail":"Not Found"}\n' }).geen_rapport && P.hpUitslag({ code: 3, stdout: 'POD WEIGERT: HTTP 404 {"detail":"geen rapport met dit id"}\n' }).geen_rapport
      && P.hpUitslag({ code: 0, stdout: '{"_INGEKORT":{},"id":5}' }, '/rapporten/5').j.id === 5
      && (() => { try { P.hpUitslag({ code: 0, stdout: '{"_INGEKORT":{}}' }); return false; } catch (e) { return /ingekort/.test(e.message); } })() && (() => { try { P.hpUitslag({ code: 2, stdout: 'POD NIET BEREIKBAAR: x' }); return false; } catch (e) { return /niet bereikbaar/.test(e.message); } })());
    const HPG = [P.gzPagina('20_Prive/Gezondheid/Proef - geheimeziekte.md', PG('actueel', ['olares:health-pod/diagnoses#1 olares:health-pod/diagnoses#2 olares:health-pod/diagnoses#99 olares:health-pod/metingen#gewicht olares:health-pod/metingen#nepsoort olares:health-pod/metingen#12345- olares:health-pod/rapporten#5 olares:health-pod/rapporten#6 olares:health-pod/pgs_uitkomst#3 olares:health-pod/diagnoses#abc'])),
      P.gzPagina('20_Prive/Gezondheid/Oud.md', PG('concept', ['olares:health-pod/diagnoses#1']))];
    const gevraagd = [];
    const hp = async (pad) => { gevraagd.push(pad);
      if (pad === '/diagnoses?historie=true&limiet=1000') return { j: { aantal: 3, rijen: [{ id: 1, vervangt_id: null }, { id: 2, vervangt_id: null }, { id: 3, vervangt_id: 1 }], limiet: 1000 } };
      if (pad === '/metingen/soorten') return { j: { aantal: 1, rijen: [{ soort: 'gewicht' }] } };
      if (pad === '/rapporten/5') return { j: { id: 5 } };
      if (pad === '/rapporten/6') return { weigert: 404, geen_rapport: true };
      throw new Error('onverwacht pad ' + pad); };
    const hm = await P.hpMeting({ hp }, HPG);
    toets('14 hpMeting: alleen vaste paden (HP_PAD_RE), elke lijst één keer, rapport per id', !hm.fout && gevraagd.every((x) => P.HP_PAD_RE.test(x)) && gevraagd.length === 4 && !P.HP_PAD_RE.test('/metingen?soort=gewicht') && !P.HP_PAD_RE.test('/wissen') && !P.HP_PAD_RE.test('/rapporten/5?x=1'), [hm.fout, gevraagd]);
    v = verzamel(); tel = {}; paden = {};
    P.hpChecks(hm, HPG, v.bev, tel, paden);
    const hc = v.b.map((x) => x.id.replace(/-[0-9a-f]{6}-/, '-…-')).sort();
    toets('14 BB6 vervangen rij op een actuele pagina (niet op een concept), BB1 rij 99, BB1 nepsoort, BB1 rapport 6, BB6 meting-id, BB6 tabel, BB6 geen getal', hc.join() === ['BB1-hp-…-geen-rij', 'BB1-hp-…-geen-soort', 'BB1-hp-…-geen-rij', 'BB6-hp-…-vervangen', 'BB6-hp-…-vorm', 'BB6-hp-…-vorm', 'BB6-hp-…-vorm'].sort().join() && tel.hp_verwijzingen === 11 && tel.hp_paginas === 2, [hc, tel]);
    toets('14 geen paginanaam of waarde in bevindingen; ernst alleen good/warning/serious/critical', v.b.every((x) => !/geheimeziekte|nepsoort|Oud\.md/.test(x.z + x.d) && ['good', 'warning', 'serious', 'critical'].indexOf(x.e) >= 0), v.b);
    toets('14 hpMeting: halve lijst (aantal ≠ rijen, of op de limiet) = niet gemeten', /niet volledig/.test((await P.hpMeting({ hp: async () => ({ j: { aantal: 4, rijen: [{ id: 1 }], limiet: 1000 } }) }, [HPG[1]])).fout || '') && /niet volledig/.test((await P.hpMeting({ hp: async () => ({ j: { aantal: 1, rijen: [{ id: 1 }] } }) }, [HPG[1]])).fout || '') && /niet volledig/.test((await P.hpMeting({ hp: async () => ({ j: { rijen: Array.from({ length: 1000 }, (_, i) => ({ id: i })), limiet: 1000 } }) }, [HPG[1]])).fout || ''));
    toets('14 hpMeting: geen lezer of pod weg → niet gemeten; geen verwijzingen → geen vraag', !!(await P.hpMeting({}, HPG)).fout && /bereikbaar/.test((await P.hpMeting({ hp: async () => { throw new Error('health-pod niet bereikbaar (exit 2)'); } }, HPG)).fout || '') && await (async () => { let n = 0; const r = await P.hpMeting({ hp: async () => { n++; return {}; } }, [P.gzPagina('a.md', PG('actueel', ['olares:health-pod']))]); return !r.fout && n === 0; })());

    // diffreview wv1774: randgevallen
    { const p = P.gzPagina('a.md', PG('actueel', ['cloudflare:d1-knie/mijlpalen#. en cloudflare:d1-knie#: en **olares:health-pod/diagnoses#3**, olares:health-pod/diagnoses#4! _olares:health-pod/diagnoses#5_ cloudflare:d1-knie/constructor#x cloudflare:d1-knie/kruisband_links#x olares:health-pod/scheur_mediaal#3 olares:health-pod/rapporten#007']));
      toets('review #1/#6: kale # loopt niet vast (leeg id), opmaak en leestekens horen niet bij het id', p.refs.some((r) => r.ref === 'cloudflare:d1-knie/mijlpalen#' && r.id === '') && p.refs.some((r) => r.ref === 'cloudflare:d1-knie#') && ['3', '4', '5'].every((i) => p.refs.some((r) => r.ref === 'olares:health-pod/diagnoses#' + i)), p.refs.map((r) => r.ref));
      const v1 = verzamel(); P.knChecks({ tabellen: new Set(['mijlpalen']), gevonden: {} }, [p], v1.bev, {}, {});
      const v2 = verzamel(); P.hpChecks({ lijst: { diagnoses: { ids: new Set(['3', '4', '5']), vervangen: new Set() } }, rapporten: {} }, [p], v2.bev, {}, {});
      const alle = v1.b.concat(v2.b);
      toets('review #2: een vrije tabelnaam staat nooit in samenvatting of detail (alleen een hash)', alle.length > 0 && alle.every((x) => !/kruisband|scheur_mediaal|constructor/.test(x.z + x.d)), alle);
      toets('review #7: constructor is geen tabel (BB6 vorm, geen BB1)', v1.b.filter((x) => x.check === 'BB1').length === 0 && v1.b.filter((x) => /-vorm$/.test(x.id)).length === 4, v1.b);
      toets('review #5: rapporten#007 = BB6 vorm, geen vraag aan de pod', v2.b.some((x) => /-vorm$/.test(x.id)) && v2.b.filter((x) => x.check === 'BB1').length === 0, v2.b);
      let n = 0; const r = await P.hpMeting({ hp: async () => { n++; return { j: { id: 1 } }; } }, [P.gzPagina('b.md', PG('actueel', Array.from({ length: 26 }, (_, i) => 'olares:health-pod/rapporten#' + (i + 1))))]);
      toets('review #3: meer dan 25 rapportverwijzingen = niet gemeten, zonder aanroep', /te veel/.test(r.fout || '') && n === 0, [r, n]);
      const k = await P.knMeting({ kn: async (b) => /sqlite_master/.test(b[0].sql) ? [{ results: [{ name: 'mijlpalen' }] }] : [{ results: [] }] }, [P.gzPagina('c.md', PG('actueel', Array.from({ length: 501 }, (_, i) => 'cloudflare:d1-knie/mijlpalen#m' + i)))]);
      toets('review #3: meer dan 500 knie-sleutels = niet gemeten', /te veel/.test(k.fout || ''), k);
      const r2 = await P.hpMeting({ hp: async () => ({ weigert: 404, geen_rapport: false }) }, [P.gzPagina('d.md', PG('actueel', ['olares:health-pod/rapporten#9']))]);
      toets('review #9: 404 zonder "geen rapport" = niet gemeten, geen BB1', !!r2.fout, r2);
      const lijstje = []; await P.gzLees({ lijst: (rel) => rel === '20_Prive/Gezondheid' ? [{ naam: '_archief', map: true }, { naam: '.x.md', bestand: true }] : rel === '20_Prive/Gezondheid/_archief' ? [{ naam: 'oud.md', bestand: true }] : [] }, (rel) => { lijstje.push(rel); return '# x'; });
      toets('review #11: _-mappen tellen mee, verborgen .-bestanden niet', lijstje.join() === '20_Prive/Gezondheid/_archief/oud.md', lijstje);
    }
    // haak: Bibliothecaris met plek 13–14; niet gemeten ≠ opgelost; geen kaart; zin alleen aantallen
    const vg = fs.mkdtempSync(path.join(os.tmpdir(), 'ovisgz-'));
    const zet = (rel, t) => { fs.mkdirSync(path.join(vg, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(vg, rel), t); };
    zet('20_Prive/Gezondheid/index.md', PG('actueel', ['olares:health-pod']));
    zet('20_Prive/Gezondheid/Knie/Proef - geheimeziekte.md', PG('actueel', ['cloudflare:d1-knie/mijlpalen#proefweg', 'olares:health-pod/diagnoses#1']));
    zet('20_Prive/Gezondheid/.verborgen.md', PG('actueel', ['cloudflare:d1-knie/mijlpalen#telniet']));
    const db = { knopen: [{ id: 'org:x', soort: 'organisatie', naam: 'X', aliassen: [], vault_pagina: 'x.md', concept: true }], handvatten: [], contact: [], vertaling: [], bevindingen: [], log: [], kaarten: [] };
    const sbRpc = async (fn, body) => {
      if (fn === 'ovis_register_lees') return JSON.parse(JSON.stringify(db));
      if (fn === 'ovis_zorgdata_paden') throw new Error('rpc http 404');
      if (fn === 'ovis_bibliothecaris_zet') { body.p_rijen.forEach((r) => { if (!/^BB[1-8]-/.test(r.bevinding_id) || (r.check_id && !/^BB[1-8]$/.test(r.check_id)) || (r.ernst && ['good', 'warning', 'serious', 'critical'].indexOf(r.ernst) < 0)) throw new Error('ovis_bibliothecaris_zet: alleen BB-bevindingen (' + r.bevinding_id + ', ' + r.ernst + ')'); });
        body.p_rijen.forEach((r) => { const b = db.bevindingen.find((x) => x.bevinding_id === r.bevinding_id); if (b) Object.assign(b, r); else db.bevindingen.push(Object.assign({}, r)); }); db.bevindingen = db.bevindingen.filter((x) => x.status !== 'opgelost'); return { ok: true }; }
      if (fn === 'mk_hartslag_stempel') return [{}];
      throw new Error('onbekende rpc ' + fn);
    };
    let knieRijen = [], hpWeg = false, vervangen = true;
    const rest = { kn: async (b) => /sqlite_master/.test(b[0].sql) ? [{ results: [{ name: 'mijlpalen' }] }] : [{ results: b[0].params.filter((x) => knieRijen.indexOf(x) >= 0).map((k) => ({ k })) }],
      hp: async (pad) => { if (hpWeg) throw new Error('health-pod niet bereikbaar (exit 2)'); return { j: { aantal: 2, rijen: [{ id: 1, vervangt_id: null }, { id: 2, vervangt_id: vervangen ? 1 : null }], limiet: 1000 } }; } };
    const m = R.maak({ vault: vg, sbRpc, lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: () => {}, nu: () => Date.parse('2026-10-28T01:30:00Z'), rest });
    const open = () => db.bevindingen.filter((x) => /^BB\d-(kn|hp)-/.test(x.bevinding_id)).map((x) => x.bevinding_id).sort();
    let b = await m.bibliothecaris({ afroep: true });
    toets('haak 13/14: knie-rij weg (BB1) en vervangen health-pod-rij (BB6) open; verborgen .-pagina telt niet; zin noemt beide met aantallen', open().length === 2 && open().some((x) => /^BB1-kn-.*-geen-rij$/.test(x)) && open().some((x) => /^BB6-hp-.*-vervangen$/.test(x)) && /Knie-app: 1 verwijzing\(en\) op 1 pagina\('s\), 1 verschil/.test(b.zin) && /Health-pod: 2 verwijzing\(en\) op 2 pagina\('s\), 1 verschil/.test(b.zin), [open(), b.zin]);
    toets('haak 13/14: niets medisch in databankrijen, zin of tel', db.bevindingen.every((x) => !/geheimeziekte|proefweg|Knie\//.test(JSON.stringify(x))) && !/geheimeziekte|proefweg/.test(b.zin + JSON.stringify(b.tel)), db.bevindingen);
    toets('haak 13/14: paden alleen in de uitkomst voor de machinekamer', Object.values(b.rest.paden).some((x) => /geheimeziekte/.test(x)));
    hpWeg = true; vervangen = false;
    b = await m.bibliothecaris({ afroep: true });
    toets('haak 14: health-pod weg → niet gemeten, BB6-hp blijft open; knie loopt door', open().some((x) => /^BB6-hp-/.test(x)) && /Health-pod niet gemeten/.test(b.zin) && /Knie-app: 1 verwijzing/.test(b.zin), [open(), b.zin]);
    hpWeg = false; knieRijen = ['proefweg'];
    b = await m.bibliothecaris({ afroep: true });
    toets('haak 13/14: rij er weer en niet meer vervangen → beide opgelost', open().length === 0, open());
    knieRijen = [];
    await m.bibliothecaris({ afroep: true });
    fs.rmSync(path.join(vg, '20_Prive/Gezondheid'), { recursive: true, force: true });
    b = await m.bibliothecaris({ afroep: true });
    toets('haak 13/14: map Gezondheid weg → beide niet gemeten, BB1-kn blijft open', open().length === 1 && /Knie-app niet gemeten/.test(b.zin) && /Health-pod niet gemeten/.test(b.zin), [open(), b.zin]);
    toets('haak 13/14: geen kaart aan David', !R.kaartBiblio({ knopen: db.knopen, bevindingen: db.bevindingen.filter((x) => /^BB\d-(kn|hp)-/.test(x.bevinding_id)).map((x) => Object.assign({ status: 'open' }, x)), kaarten: [], log: [] }, { nu: Date.parse('2026-10-28T01:30:00Z') }).kaart && open().length === 1);
    fs.rmSync(vg, { recursive: true, force: true });
    const srv = fs.readFileSync('server.js', 'utf8'), run = fs.readFileSync('ovis-run.js', 'utf8');
    toets('server.js en ovis-run.js geven kn (alleen SELECT) en hp (HP_PAD_RE, hp.py) mee', /hp: ovisHp/.test(srv) && /kn: ovisKnieD1/.test(srv) && /HP_PAD_RE\.test\(String\(pad\)\)/.test(srv) && /smalSqlLezend\(q && q\.sql\)/.test(srv) && /kn: d1Van\(knie/.test(run) && /HP_PAD_RE\.test\(String\(pad\)\)/.test(run) && /'health-pod', 'hp\.py'/.test(run));
  }
  toets('uitrol-lijst en Dockerfile kennen ovis-plekken.js (anders stil "niet gemeten" na de uitrol)', /^RELEASE_OPTIONEEL="[^"]*\bovis-plekken\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')) && /COPY ovis-plekken\.js \/app\/release-bootstrap\/ovis-plekken\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
