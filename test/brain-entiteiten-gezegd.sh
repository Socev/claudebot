#!/usr/bin/env bash
# Toetst wv3945 (besluitenpagina nr 397/398 = 3C97/3C98) in brain-entiteiten.js: "Wat er gezegd is" (gesprekspagina's met datum en eerste
# lopende onderwerp, nieuwste eerst; laatste drie notulen zonder agenda/voorbereiding/ongedateerd; bij een persoon zijn eigen gesprekspagina's
# op volledige naam), "Mensen" (medewerkerspagina's in/uit dienst uit status, bestandsnaam en einddatum; contracteinde; eerstvolgende datum uit
# deadline of geplande leidraad; sleutel als er een knoop is) en bereik uit het ovis-blok van de pagina. Alle namen en nummers zijn verzonnen.
# Gebruik: bash test/brain-entiteiten-gezegd.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 900) + ']' : '')); }
const B = require('./brain-entiteiten.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wv3945-'));
const vault = path.join(tmp, 'vault');
const zet = (rel, t) => { fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); fs.writeFileSync(path.join(vault, rel), t); };
const W = '10_Zakelijk/Proef/';
zet(W + 'Entiteit - PR.md', '---\ntype: entiteit\n---\n# Proefpraktijk\n');
zet(W + 'Conversaties/WhatsApp - Proefgroep (actueel).md', '---\ntype: conversatie-actueel\nbron: whatsapp\nupdated: 2026-11-20\n---\n# x\n\n## Lopende onderwerpen\n\n- **Nieuwe koffieautomaat (19-11)** — Verzonnen meldt iets. (19-11)\n- **Ouder punt** — x\n\n## Actiepunten\n- iets\n');
zet(W + 'Conversaties/Teams - Kees Verzonnen (actueel).md', '---\nbron: teams\nupdated: 2026-11-22\n---\n# x\n\n## Lopende onderwerpen\n\n- Rooster [[10_Zakelijk/Proef/Rooster|rooster]] van december — rest\n');
zet(W + 'Conversaties/WhatsApp - Kees (1-op-1) (actueel).md', '---\nbron: whatsapp\nupdated: 2026-10-01\n---\n# x\n\nGeen kop.\n');
zet('10_Zakelijk/Ander/Conversaties/WhatsApp - Kees Verzonnen (1-op-1) (actueel).md', '---\nbron: whatsapp\nupdated: 2026-11-01\n---\n# x\n');
zet(W + 'Notulen/Index.md', '# index\n');
zet(W + 'Notulen/2026-10-01 - Werkoverleg.md', '# a\n');
zet(W + 'Notulen/2026-11-01 - Agenda werkoverleg.md', '# b\n');
zet(W + 'Notulen/2026-11-02 - Voorbereiding maatschap.md', '# b\n');
zet(W + 'Notulen/2026-09-01 - Maatschap.md', '# c\n');
zet(W + 'Notulen/2024-12 - Heidag.md', '# d\n');
zet(W + 'Notulen/2026-08-01 - Ouder.md', '# e\n');
zet(W + 'Notulen/Besluitenlijst.md', '# f\n');
zet(W + 'Medewerkers/Index.md', '---\ntype: index\n---\n');
zet(W + 'Medewerkers/Kees Verzonnen - assistent.md', '---\ntype: medewerker\nnaam: Kees Verzonnen\nfunctie: Assistent\nstatus: in dienst (bepaalde tijd 2026-01-01 t/m 2027-06-30)\nstartdatum: 2026-01-01\nalias: x\novis:\n  zegel: "x"\n  mailadressen: ["Kees@Verzonnen.example", "fout"]\n  telefoons: ["+31 6 1111 2222"]\n  whatsapp: []\n---\n# Kees\n');
zet(W + 'Medewerkers/Ans Proef - POH.md', '---\ntype: medewerker\nnaam: Ans Proef\nfunctie: POH\nstatus: actief\n---\n');
zet(W + 'Medewerkers/Piet Oud - assistent (uit dienst).md', '---\ntype: medewerker\nnaam: Piet Oud\nfunctie: Assistent\nstatus: in dienst\n---\n');
zet(W + 'Medewerkers/Mia Weg.md', '---\ntype: medewerker\nnaam: Mia Weg\nstatus: uit_dienst\n---\n');
zet(W + 'Medewerkers/Olga Verlof.md', '---\ntype: medewerker\nnaam: Olga Verlof\nstatus: Ouderschapsverlof tot maart\n---\n');
zet(W + 'Medewerkers/Otto Oud.md', '---\ntype: medewerker\nnaam: Otto Oud\nstatus: oud-waarnemer (2016)\n---\n');
zet(W + 'Medewerkers/Tom Tijdelijk.md', '---\ntype: medewerker\nnaam: Tom Tijdelijk\nstatus: gestart, tijdelijk\neinddatum: 2026-11-01\n---\n');
zet(W + 'Medewerkers/Overzicht.md', '---\ntype: themapagina\n---\n');
zet(W + 'Medewerkers/Gesprekken/Ans Proef/2026-12-03 - Leidraad jaargesprek - Ans Proef.md', '# l\n');
zet(W + 'Medewerkers/Gesprekken/Ans Proef/2026-07-01 - Verslag - Ans Proef.md', '# v\n');
zet(W + 'Medewerkers/Gesprekken/Kees Verzonnen/2026-12-20 - Leidraad - Kees Verzonnen.md', '# l\n');
zet('10_Zakelijk/Leeg/Entiteit - LG.md', '# leeg\n');

const knopen = [
  { id: 'PR', soort: 'entiteit', rol: 'eigen', naam: 'Proefpraktijk', vault_pagina: W + 'Entiteit - PR.md', actief: true, voor: [] },
  { id: 'LG', soort: 'entiteit', rol: 'eigen', naam: 'Leegpraktijk', vault_pagina: '10_Zakelijk/Leeg/Entiteit - LG.md', actief: true, voor: [] },
  { id: 'per:kees-verzonnen', soort: 'persoon', naam: 'Kees Verzonnen', vault_pagina: W + 'Medewerkers/Kees Verzonnen - assistent.md', actief: true, voor: ['PR'] },
  { id: 'org:lev', soort: 'organisatie', rol: 'leverancier', naam: 'Verzonnen BV', vault_pagina: null, actief: true, voor: ['PR'] },
];
const rpc = async (fn) => { if (fn !== 'ovis_register_lees') throw new Error('onverwacht ' + fn); return { knopen, handvatten: [] }; };
const kaartLijst = [];
(function wandel(d) { for (const n of fs.readdirSync(path.join(vault, d))) { const r = d ? d + '/' + n : n, st = fs.statSync(path.join(vault, r)); if (st.isDirectory()) wandel(r); else kaartLijst.push({ p: r, s: '', m: st.mtimeMs }); } })('');
const deadlines = () => [
  { ents: ['PR'], dagen: 9, datum: '2026-12-01', titel: 'Aanzegtermijn Kees Verzonnen', hr: true },
  { ents: ['PR'], dagen: -2, datum: '2026-11-20', titel: 'Voorbij Ans Proef' },
];
const NU = Date.parse('2026-11-22T10:00:00Z');
const m = B.maak({ rpc, lees: (p) => fs.readFileSync(p, 'utf8'), vault, kaart: () => kaartLijst, deadlines, nu: () => NU });

(async function () {
  // losse helpers
  toets('eersteOnderwerp: vetgedrukt kopje', B.eersteOnderwerp('## Lopende onderwerpen\n\n- **A b (1-1)** — rest\n') === 'A b (1-1)');
  toets('eersteOnderwerp: zonder vet tot " — ", wikilink als tekst', B.eersteOnderwerp('## Lopende onderwerpen\n- Zie [[x/y|de pagina]] nu — rest') === 'Zie de pagina nu');
  toets('eersteOnderwerp: geen kop = null', B.eersteOnderwerp('# x\n- a') === null);
  toets('eersteOnderwerp: lege sectie = null', B.eersteOnderwerp('## Lopende onderwerpen\n\n## Actiepunten\n- a') === null);
  toets('contractEinde: t/m iso', B.contractEinde('status: bepaald 2026-07-01 t/m 2027-06-30\n') === '2027-06-30');
  toets('contractEinde: tot d-m-jjjj', B.contractEinde('status: contract tot 1-3-2027\n') === '2027-03-01');
  toets('contractEinde: einddatum gaat voor', B.contractEinde('einddatum: 2026-12-31\nstatus: t/m 2027-01-01\n') === '2026-12-31');
  toets('fmOvisLijst leest het ingesprongen veld', JSON.stringify(B.fmOvisLijst('ovis:\n  telefoons: ["a", "b"]\n', 'telefoons')) === '["a","b"]');

  const d = (await m.detail('PR')).j;
  const g = d.weet.gezegd;
  toets('PR: drie gesprekspagina\'s in de eigen map (niet die van Ander)', g && g.totaal === 3, g);
  toets('PR: nieuwste eerst (updated)', g.gesprekken.map((x) => x.datum).join(',') === '2026-11-22,2026-11-20,2026-10-01', g.gesprekken);
  toets('PR: naam zonder WhatsApp/Teams en (actueel)/(1-op-1)', g.gesprekken.map((x) => x.titel).join('|') === 'Kees Verzonnen|Proefgroep|Kees', g.gesprekken);
  toets('PR: bron uit de frontmatter', g.gesprekken.map((x) => x.bron).join(',') === 'Teams,WhatsApp,WhatsApp');
  toets('PR: eerste lopende onderwerp', g.gesprekken[1].onderwerp === 'Nieuwe koffieautomaat (19-11)' && g.gesprekken[0].onderwerp === 'Rooster rooster van december' && g.gesprekken[2].onderwerp === null, g.gesprekken);
  toets('PR: pad = de gesprekspagina', g.gesprekken[1].pad === W + 'Conversaties/WhatsApp - Proefgroep (actueel).md');
  toets('PR: drie notulen, nieuwste eerst, zonder Index/Agenda/Voorbereiding/ongedateerd', g.notulen.map((x) => x.datum + ' ' + x.titel).join('|') === '2026-10-01 Werkoverleg|2026-09-01 Maatschap|2026-08-01 Ouder', g.notulen);
  toets('PR: notulen_totaal telt ook "2024-12 - …"', g.notulen_totaal === 4, g.notulen_totaal);

  const me = d.weet.mensen;
  toets('PR: mensen alleen type medewerker (7)', me && me.totaal === 7, me);
  toets('PR: in dienst = Ans, Kees, Olga (ouderschapsverlof = in dienst, review MOET 1)', me.in_dienst.map((x) => x.naam).join(',') === 'Ans Proef,Kees Verzonnen,Olga Verlof', me.in_dienst);
  toets('PR: uit dienst = bestandsnaam, uit_dienst, oud-waarnemer, verlopen einddatum', me.uit_dienst.map((x) => x.naam).join(',') === 'Mia Weg,Otto Oud,Piet Oud,Tom Tijdelijk', me.uit_dienst);
  const kees = me.in_dienst[1], ans = me.in_dienst[0];   // gesorteerd op naam
  toets('Kees: functie, start, contract tot uit de status', kees.functie === 'Assistent' && kees.start === '2026-01-01' && kees.contract_tot === '2027-06-30', kees);
  toets('Kees: sleutel van zijn knoop', kees.sleutel === B.sleutelVan('per:kees-verzonnen'));
  toets('Ans: geen knoop = sleutel null, wel pad', ans.sleutel === null && ans.pad === W + 'Medewerkers/Ans Proef - POH.md');
  toets('Kees: eerstvolgende = deadline (eerder dan de leidraad)', kees.volgende && kees.volgende.soort === 'deadline' && kees.volgende.datum === '2026-12-01', kees.volgende);
  toets('Ans: eerstvolgende = geplande leidraad (voorbije deadline telt niet)', ans.volgende && ans.volgende.soort === 'gesprek' && ans.volgende.datum === '2026-12-03' && /Leidraad jaargesprek/.test(ans.volgende.titel), ans.volgende);
  toets('PR: geen bereik bij een entiteit', d.weet.bereik === undefined);

  const lg = (await m.detail('LG')).j;
  toets('LG: geen medewerkers = geen blok Mensen', lg.weet.mensen === undefined);
  toets('LG: wel een (leeg) blok gezegd', lg.weet.gezegd && lg.weet.gezegd.totaal === 0 && lg.weet.gezegd.notulen_totaal === 0);

  const p = (await m.detail('per:kees-verzonnen')).j;
  const pg = p.weet.gezegd;
  toets('Kees: zijn gesprekspagina\'s op volledige naam, over entiteiten heen (niet "Kees" los)', pg && pg.gesprekken.map((x) => x.pad.split('/')[1] + ':' + x.titel).join('|') === 'Proef:Kees Verzonnen|Ander:Kees Verzonnen', pg);
  toets('Kees: geen notulen bij een persoon', pg.notulen.length === 0);
  toets('Kees: geen blok Mensen bij een persoon', p.weet.mensen === undefined);
  toets('Kees: bereik uit de pagina (telefoon genormaliseerd, mail klein, fout weg)', JSON.stringify(p.weet.bereik) === JSON.stringify({ telefoons: ['0611112222'], mailadressen: ['kees@verzonnen.example'], whatsapp: [] }), p.weet.bereik);

  const lv = (await m.detail('org:lev')).j;
  toets('leverancier: geen gezegd, geen mensen, geen bereik', lv.weet.gezegd === undefined && lv.weet.mensen === undefined && lv.weet.bereik === undefined, lv.weet);

  // kaart niet te lezen → foutregel, geen crash
  const m2 = B.maak({ rpc, lees: (p) => fs.readFileSync(p, 'utf8'), vault, kaart: () => null, deadlines, nu: () => NU });
  const f = (await m2.detail('PR')).j;
  toets('kaart weg: gezegd met fout, mensen weg', f.weet.gezegd && /niet te lezen/.test(f.weet.gezegd.fout) && f.weet.mensen === undefined, f.weet);

  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
