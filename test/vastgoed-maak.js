'use strict';
// wv3085: verzonnen huisdossier in de vorm van de echte vaultpagina's (20_Prive/Huis + 20_Prive/Bronnen/Huis), voor test/vastgoed.test.js
// en de schermtoets in socev-app (test/vastgoed-ui.cjs). Adres = het openbare voorbeeld (kantoor Kadaster, Hofstraat 110 Apeldoorn, BAG-nummers
// gemeten 14-11-2026); boxen, bedragen, namen en datums zijn verzonnen. Nooit Davids gegevens in toetsdata.
const fs = require('fs');
const path = require('path');

const WONING = `---
type: dossier
---

# Woning Hofstraat 110, Apeldoorn

## Kerngegevens

- **Adres:** Hofstraat 110, 7311 KZ Apeldoorn. Tijdens de bouw: bouwnummer 9.
- **Kadaster** (eigendomsinformatie 1-2-2020, grens en grootte vastgesteld):
  - **Apeldoorn U 9833**: 905 m², "wonen", ontstaan uit U 9000 (objectidentificatie 999999999999999).
  - **Apeldoorn U 9834**: 21 m², strook naast de woning, ontstaan uit U 9001 (objectidentificatie 999999999999998).
  - **Samen 926 m².** Eerder stonden er voorlopige maten in de registers.
- **Eigenaren:** Proefpersoon A en Proefpersoon B, elk **1/2**.
- **Type:** vrijstaand proefgebouw, plat dak, fundering op betonpalen. Gasloos: warmtepomp met bodemlus,
  overal vloerverwarming. **Bouwjaar 1985.**
- **Oppervlakten (uniforme meetstaat, 1-2-2020):** gebruiksoppervlakte wonen **123 m²**.
- **Inhoud:** WOZ (peildatum 2019) noteert woning 456 m³, aanbouw 12 m².
- **Registratienummers:** WOZ-objectnummer 99990000123. In de BAG staat de woning onder
  0200010000090244 (Kadaster en energielabel) en 0200200000007079 (WOZ).

## Aankoop en levering

### Koop-/aannemingsovereenkomst (KOA) "Proef", bouwnummer 9

- **Datum:** overeengekomen per **3-4-2013**, door kopers getekend op **5-4-2013**.
- **Bedragen (incl. 21% btw):**
  - grondkosten **€ 100.000**
  - aanneemsom **€ 200.000**
  - **totaal € 300.000**

### Akte van levering grond, 18-12-2014

- Geleverd.

### Extra strook grond (Apeldoorn U 9834), 16-2-2016

- Geleverd.

## Taxatiegeschiedenis

| Rapport | Peildatum | Taxateur / kantoor | Doel | Marktwaarde | Na verbouwing | Validatie |
|---|---|---|---|---|---|---|
| 1-3-2016 | 1-3-2016 | A. Proef, Proeftaxaties (Ergens) | financiering | € 310.000 | **€ 320.000** (tuin) | NWWI 1 |
| 2-10-2018 | 1-10-2018 | B. Proef, Voorbeeldmakelaars (Elders) | financiering | **€ 350.000** | n.v.t. | iVALIDATIE 2 |
| 5-6-2023 | 1-6-2023 | C. Proef, Proefmakelaardij (Hier) | financiering | € 400.000 | **€ 450.000** (verbouwing € 50.000) | NWWI 3 |

## WOZ 2017

**Taxatieverslag WOZ, tijdvak 2017:**

- waardepeildatum **1-1-2016**
- vastgestelde WOZ-waarde **€ 280.000**; de vorige was € 270.000 (+3,70%)

## WOZ 2023 en bezwaar

- waardepeildatum en toestandspeildatum **1-1-2022**
- vastgestelde WOZ-waarde **€ 390.000**; de vorige was € 330.000 (+18,18%)

**Uitkomst niet in de bronnen.** De WOZ-waarde voor 2025 is € 410.000 (zie de aangifte).

## Energielabel

- **Label A**, registratienummer **123456789**, geregistreerd op **1-12-2014**, **geldig tot 1-12-2024**.

## Bestemmingsplan

**Bestemmingsplan "Proefplan 2010"**, kadasterafdruk van 1-2-2020.

## Bouw-, kavel-, verbouw- en zonnepanelenstukken

### Zonnepanelen 2020 (8 × Proefpaneel 370, 2.960 Wp)
`;

const BOX1 = `# Garagebox Proefpark (box 7) — Hofstraat 110-7

## Kerngegevens

| Item | Waarde |
|---|---|
| Adres | Hofstraat 110-7, 7311 KZ Apeldoorn (begane grond) |
| Bouwnummer / type | 7 / type 1.A, inhoud 50 m³ |
| Kadastraal | Apeldoorn, sectie U, complexaanduiding **9900 A, appartementsindex 7** |
| Aandeel | 5/1.000 onverdeeld aandeel in het terrein (perceel Apeldoorn U 9833, ca. 9 a 05 ca; complex van 20 units) |
| Eigenaren | Proefpersoon A en Proefpersoon B, ieder 1/2 |

## Koop en levering

- **Koop-/aannemingsovereenkomst**: overeengekomen per 1-2-2018, digitaal getekend **2-2-2018**.
- **Koop-/aanneemsom: € 30.000,00 incl. btw** (€ 24.793,39 + 21% btw).
- **Levering**: akte van levering **1-6-2018** (10:00 uur).
- **Lopende lasten (huishoudbudget):** VvE-bijdrage ca. € 10–15 per maand.
- **Vloerbelasting type 1.A (deze box): max. 500 kg/m²** (andere types 250 kg/m²).
`;

const BOX2 = `# Aankoop garagebox — Hofstraat 110-12, Apeldoorn

## Kerngegevens

| Item | Waarde |
|---|---|
| Object | Garagebox Hofstraat 110-12, Apeldoorn |
| Hypotheek | Niet nodig |

## Afgerond

| | |
|---|---|
| Ingeschreven | **3 augustus 2026**, register onroerende zaken **HYP 4, deel 1, nummer 2** |
| Kadastrale aanduiding | **Apeldoorn U 9900 A 12** — Hofstraat 110 12 Apeldoorn |
| Rechthebbende | Proef Holding B.V. |
`;

const ANDERE = {
  'Index.md': '# Huis\n',
  'Eigen woning.md': '# Eigen woning\n',
  'Terras in het talud 2016.md': '# Terras in het talud 2016\n',
  'Verbouwing 2018-2019 (uitbouw).md': '# Verbouwing 2018-2019 (uitbouw)\n',
  'Kelder - verbouwplan (Proefbureau).md': '# Kelder — verbouwplan met Proefbureau\n',
};
const STUKKEN = [
  'Prive - 2013-04-05 - Koop-aannemingsovereenkomst Proef bouwnummer 9.pdf',
  'Prive - 2014-12-18 - Akte van levering grond Hofstraat 110.pdf',
  'Prive - 2014 - Plattegrond begane grond Hofstraat 110.pdf',
  'Prive - 2014 - Palenplan en constructietekeningen.pdf',
  'Prive - 2023-06-05 - Taxatierapport Hofstraat 110 (marktwaarde 400k).pdf',
  'Prive - 2022 - WOZ-taxatieverslag Hofstraat 110.pdf',
  'Prive - 2023-03-01 - Funderingsrisicorapport Hofstraat 110.pdf',
  'Prive - 2018-02-02 - Koopovereenkomst garagebox 7 Proefpark.pdf',
  'Prive - 2018-06-01 - Akte van levering garagebox 7 Proefpark.pdf',
  'Prive - 2017-01-01 - Splitsingsakte GaragePark Proef.pdf',
  'Prive - 2018 - Huishoudelijk reglement VvE GaragePark Proef.pdf',
];

function maakVault(dir) {
  const huis = path.join(dir, '20_Prive', 'Huis'), bron = path.join(dir, '20_Prive', 'Bronnen', 'Huis');
  fs.mkdirSync(huis, { recursive: true }); fs.mkdirSync(bron, { recursive: true });
  fs.writeFileSync(path.join(huis, 'Woning Hofstraat 110.md'), WONING);
  fs.writeFileSync(path.join(huis, 'Garagebox Proefpark (box 7).md'), BOX1);
  fs.writeFileSync(path.join(huis, 'Garagebox-Hofstraat-110-12.md'), BOX2);
  for (const [n, t] of Object.entries(ANDERE)) fs.writeFileSync(path.join(huis, n), t);
  for (const n of STUKKEN) fs.writeFileSync(path.join(bron, n), 'proef');
  return dir;
}

// Nepantwoord van osint.py vastgoed voor één object (de echte vorm, verzonnen waarden)
function nepBronnen(opties) {
  const o = opties || {};
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const vragen = [];
  const f = async function (invoer) {
    vragen.push(JSON.parse(JSON.stringify(invoer)));
    if (o.wacht) await new Promise((r) => setTimeout(r, o.wacht));
    if (o.faal) return { ok: false };
    const obj = invoer.objecten[0];
    const box = !!obj.zoek;
    return { ok: true, versie: 'osint-4', prijsindex: { jaren: { 2018: 100, 2023: 125, 2025: 140 }, maanden: { '2023-06': 120, '2026-09': 150 }, laatste: ['2026-09', 150] },
      licentie_index: 'CBS open data, CC BY 4.0',
      objecten: [{ id: obj.id, groepen: Object.assign({ ls: true, bag: true, '3dbag': true, perceel: true, fundering: true, plannen: true, cbs: true }, o.groepen || {}), feiten: [
        { groep: 'bag', rubriek: 'bouw', veld: 'Bouwjaar', waarde: '1985', bron: 'BAG via PDOK', licentie: 'BAG (Kadaster): publiek domein' },
        { groep: '3dbag', rubriek: 'bouw', veld: 'Hoogste punt dak boven maaiveld', waarde: o.dak || '56,0 m', bron: '3D-BAG (rekenmodel op BAG en AHN)', licentie: '3DBAG, CC BY 4.0', peildatum: '2018' },
        { groep: 'fundering', rubriek: 'grond', veld: 'Funderingskaart', waarde: 'Niet kwetsbaar gebied - 0-20 %', bron: 'Funderingskaart (RVO/KCAF via PDOK)', licentie: 'CC0' },
        { groep: 'plannen', rubriek: 'regels', veld: 'Proefplan 2010', waarde: 'bestemmingsplan · vastgesteld · 01-01-2010', bron: 'Ruimtelijke plannen (PDOK)', soort: 'plan', url: 'https://ruimtelijkeplannen.nl/documents/proef/r_proef.html' },
        { groep: 'cbs', rubriek: 'regels', veld: 'Gemiddelde WOZ-waarde (2025)', waarde: '€ 263.000', bron: 'CBS Kerncijfers wijken en buurten (open data)', licentie: 'CBS open data, CC BY 4.0' },
        { groep: 'cbs', rubriek: 'onzin', veld: 'weg', waarde: 'x', bron: 'x' },
        { groep: 'bag', rubriek: 'bouw', veld: 'Gevaarlijke link', waarde: 'x', bron: 'x', url: 'javascript:alert(1)' },
        { groep: 'onbekend', rubriek: 'bouw', veld: 'Zonder bekende groep', waarde: 'x', bron: 'x' },
      ].filter((f) => (Object.assign({ ls: true, bag: true, '3dbag': true, perceel: true, fundering: true, plannen: true, cbs: true }, o.groepen || {}))[f.groep] !== false), beelden: [{ soort: 'luchtfoto', titel: 'Luchtfoto met perceelgrens en pand', src: png, over: [png], bron: 'Luchtfoto Beeldmateriaal Nederland via PDOK' },
        { soort: 'tijd', titel: '2016', jaar: '2016', src: png, over: [] }, { soort: 'kaart', titel: 'kwaad', src: 'javascript:alert(1)', over: [] }],
      gevonden: box ? (o.boxFout ? { fout: true } : o.boxRaak === 0 ? { in_vak: 40, zelfde_huisnummer: 0, raak: 0 } : { in_vak: 40, zelfde_huisnummer: 3, raak: 1, vbo: '0200010000099999' }) : { vbo_bag: obj.vbo },
      punt: { rd: [194315.8, 469449.1], ll: [5.962442, 52.211734] } }],
      aanroepen: [{ bron: 'BAG (PDOK WFS)', soort: 'extern', host: 'service.pdok.nl', naar_buiten: 'identificatie = ' + (obj.vbo[0] || '-'), status: o.status || '200', ms: 12 },
        { bron: '3D-BAG', soort: 'extern', host: 'api.3dbag.nl', naar_buiten: 'pand-id 0200100000001088', status: o.status || '200', ms: 30 }] };
  };
  f.vragen = vragen;
  return f;
}

module.exports = { maakVault, nepBronnen, WONING, BOX1, BOX2, STUKKEN };
