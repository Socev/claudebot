#!/usr/bin/env python3
"""wv3676: verzonnen verweerpuntenregister bij het proefdossier van test/nza-proef.py (tab Punten van het NZa-scherm).

Gebruik: python3 -I nza-proef-register.py <map>   (maakt <map>/VP-*.md en <map>/Naloop/*.md; alles verzonnen, geen echte namen).
Zes punten in twee thema's: drie met naloop (zwak, redelijk, sterk), één met een oudere en een nieuwere naloop (de nieuwste telt), één
zonder naloop, één naloop in een vrije vorm (geen sectie Oordeel: dan geen oordeel, wel de tekst), en links in de map Naloop die
nooit gevolgd mogen worden (ook niet als ze nieuwer zijn dan een geldige naloop).
"""
import os, sys

D = sys.argv[1]
os.makedirs(os.path.join(D, 'Naloop'), exist_ok=True)
CIT = 'de NZa de proeftarieven niet deugdelijk heeft gemotiveerd'


def punt(nr, titel, thema, prio, ontbreekt=True):
    t = f"""---
type: verweerpunt
id: VP-{nr:02d}
titel: "{titel}"
thema: {thema}
zaak: "Proefzaak"
status: open
prioriteit: {prio}
zoekwoorden: "proef"
bijgewerkt: 2026-11-21
---

# VP-{nr:02d} — {titel}

## Het punt
Proefpunt {nr}: de NZa zou de proeftarieven niet goed hebben onderbouwd. Tweede zin van het proefpunt.

## Onze argumentatie
- Proefpartij: het proeftarief is te laag [B1].
- Een tweede proefargument zonder bron.

## Standpunt van de NZa
- De NZa handhaaft het proefbesluit [B2].

## Wat de rechter erover zei
- Het College vond dat {CIT} [B1].

## Stand en wat ontbreekt
- Stand: het proefpunt ligt voor bij de proefrechter.
""" + ("- Ontbreekt: het proefverslag van het overleg staat niet in het dossier.\n" if ontbreekt else "") + f"""
## Bronnen
- B1 | CBb | cbb-2099-901 | 1.2 | "{CIT}"
- B2 | NZa | bob-proef-2025 | p. 17 | "De NZa handhaaft het proefbesluit en verklaart het bezwaar ongegrond."
"""
    with open(os.path.join(D, f'VP-{nr:02d} Proefpunt {nr}.md'), 'w', encoding='utf-8') as f:
        f.write(t)


def naloop(nr, datum, oordeel, extra='', vrij=False, naam=None):
    kop = f"---\ntype: verweerpunt-naloop\npunt: VP-{nr:02d}\ndatum: {datum}\ngemaakt_door: proef\nstatus: werkblad\n---\n\n# Naloop VP-{nr:02d}\n\n"
    if vrij:
        body = 'Een naloop in vrije vorm, zonder vaste sectie. Proefbewering is redelijk onderbouwd.\n'
    else:
        body = (f"## Oordeel\n- oordeel: {oordeel}\n- waarom: proefwaarom {nr} {extra}\n"
                f"- tegenargument: de NZa handhaaft het proefbesluit [NZa 10-03-2025, p. 17](/nza#stuk=bob-proef-2025&plek=17)\n"
                f"- ontbreekt: het proefverslag\n- rekenwerk: ja — proefberekening {nr}\n\n## Per bewering\n### 1. Proefbewering\n- bron: ✓ B1\n")
    with open(os.path.join(D, 'Naloop', naam or f'VP-{nr:02d} - naloop - {datum}.md'), 'w', encoding='utf-8') as f:
        f.write(kop + body)


punt(1, 'Proefhuisvesting: generiek gemiddelde', 'huisvesting', 'hoog')
punt(2, 'Proefhuisvesting: restant naar segment 3', 'huisvesting', 'middel', ontbreekt=False)
punt(3, 'Proefprocedure: niet in overleg', 'procedure', 'hoog')
punt(4, 'Proefprocedure: korte termijnen', 'procedure', 'laag')
punt(5, 'Proefprocedure: zonder naloop', 'procedure', 'hoog')
punt(6, 'Proefprocedure: vrije naloop', 'procedure', 'middel')
naloop(1, '2026-11-20', 'sterk', 'oud')
naloop(1, '2026-11-21', 'zwak', 'nieuw')
naloop(2, '2026-11-21', 'redelijk')
naloop(3, '2026-11-21', '**Zwak**')
naloop(4, '2026-11-21', 'sterk')
naloop(6, '2026-11-21', '', vrij=True)
# een link mag nooit gevolgd worden (socev kan in de vault links zetten)
geheim = os.path.join(D, '..', 'geen-naloop.txt')
with open(geheim, 'w', encoding='utf-8') as f:
    f.write('## Oordeel\n- oordeel: sterk\n- waarom: GEHEIM-BUITEN-REGISTER\n')
os.symlink(os.path.abspath(geheim), os.path.join(D, 'Naloop', 'VP-05 - naloop - 2026-11-22.md'))
# een nieuwere link naast een geldige naloop verbergt die niet (Codex wv3676 MOET 2): VP-04 blijft sterk
os.symlink(os.path.abspath(geheim), os.path.join(D, 'Naloop', 'VP-04 - naloop - 2026-11-23.md'))
