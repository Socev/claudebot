#!/usr/bin/env python3
"""Proefdossier voor het NZa-scherm (wv3099): een nza.db met hetzelfde schema als /opt/data/ovis-nza/nza.db (bouw-index.py, deel II),
gevuld met VERZONNEN stukken in de echte vorm (kenmerken TB/REG-9xxxx, ECLI:NL:CBB:2099:..., partij "Proefpartij"; geen echte namen,
geen echte bedragen). Gebruik: python3 -I test/nza-proef.py <pad/naar/nza.db>   (met NZA_VANDAAG=2026-11-15 in de toets)."""
import json, os, sqlite3, sys

DDL = """
CREATE TABLE meta (sleutel text primary key, waarde text);
CREATE TABLE stuk (id text primary key, titel text not null, datum text, soort text, wie text, laag text not null,
  zaak text, pad text not null, ook_op text, sha256 text not null, versie text, geldig_van text, geldig_tot text,
  ecli text, zaaknummers text, plekken integer, woorden integer,
  documentcode text, gepubliceerd_op text, laatste_wijziging text, bekend_sinds text, puc_ref text, geldig_bron text,
  tekst_van text, tekst_tot text);
CREATE TABLE relatie (id integer primary key, van_stuk text not null references stuk(id), soort text not null, naar_code text,
  naar_stuk text, plek text not null, tekst text not null);
CREATE TABLE gebeurtenis (id integer primary key, datum text not null, soort text not null, stuk_id text not null references stuk(id),
  omschrijving text not null, plek text, bron text not null);
CREATE TABLE passage (id integer primary key, stuk_id text not null references stuk(id), plek_soort text not null,
  plek text not null, volgorde integer not null, rn text, tekst text not null);
CREATE INDEX relatie_van on relatie(van_stuk);
CREATE INDEX relatie_naar on relatie(naar_stuk);
CREATE INDEX gebeurtenis_datum on gebeurtenis(datum);
CREATE INDEX passage_stuk on passage(stuk_id, volgorde);
CREATE VIRTUAL TABLE passage_fts using fts5(tekst, content='passage', content_rowid='id', tokenize="unicode61 remove_diacritics 2");
"""

# id, titel, datum, soort, wie, laag, zaak, versie, geldig_van, geldig_tot, documentcode, bekend_sinds, ecli
STUKKEN = [
    ('tb-reg-90101-01', 'Prestatie- en tariefbeschikking proefzorg 2025 (TBREG-90101-01)', '2024-07-01', 'tariefbeschikking', 'NZa', 'openbaar', '',
     '1', '2025-01-01', '2025-12-31', 'TB/REG-90101-01', '2024-07-01', ''),
    ('tb-reg-90101-02', 'Gewijzigde prestatie- en tariefbeschikking proefzorg 2025 (TBREG-90101-02)', '2025-06-30', 'tariefbeschikking', 'NZa', 'openbaar', '',
     '2', '2025-01-01', '2025-12-31', 'TB/REG-90101-02', '2025-06-30', ''),
    ('tb-reg-90202-01', 'Prestatie- en tariefbeschikking proefzorg 2026 (TBREG-90202-01)', '2025-07-01', 'tariefbeschikking', 'NZa', 'openbaar', '',
     '1', '2026-01-01', '2026-12-31', 'TB/REG-90202-01', '2025-07-01', ''),
    ('tb-reg-90303-01', 'Prestatie- en tariefbeschikking proefzorg 2027 (TBREG-90303-01)', '2026-07-01', 'tariefbeschikking', 'NZa', 'openbaar', '',
     '1', '2027-01-01', '2027-12-31', 'TB/REG-90303-01', '2026-07-01', ''),
    ('br-reg-90404', 'Beleidsregel proefzorg 2026 (BR/REG-90404)', '2025-07-01', 'beleidsregel', 'NZa', 'openbaar', '',
     '1', '2026-01-01', '', 'BR/REG-90404', '2025-07-01', ''),
    ('bob-proef-2025', 'Beslissing op bezwaar proeftarieven 2025', '2025-03-10', 'beslissing op bezwaar', 'NZa', 'openbaar', 'proefzaak-2025',
     '', '', '', '', '2025-03-10', ''),
    ('proef-beroep-2025', 'Beroepschrift Proefpartij tegen de beslissing op bezwaar 2025', '2025-04-15', 'beroepschrift', 'Proefpartij', 'eigen', 'proefzaak-2025',
     '', '', '', '', '2025-04-15', ''),
    ('cbb-2099-901', 'Uitspraak CBb proeftarieven 2025 (ECLI:NL:CBB:2099:901)', '2026-02-20', 'uitspraak', 'CBb', 'openbaar', 'proefzaak-2025',
     '', '', '', '', '2026-02-20', 'ECLI:NL:CBB:2099:901'),
    ('kpo-proef-2024', 'Kostprijsonderzoek proefzorg 2024', '2024-05-01', 'kostprijsonderzoek', 'Proefbureau (in opdracht van de NZa)', 'openbaar', '',
     '', '', '', '', '2024-05-01', ''),
]


def bladzijden(sid, n, extra=None):
    uit = []
    for p in range(1, n + 1):
        t = (f'Proefstuk {sid}, bladzijde {p}.\n'
             f'Artikel {p} Proefbepaling\n'
             f'Dit is verzonnen tekst voor de toets van het NZa-scherm. Regel {p} over de proefprestatie.\n'
             f'De proefprestatie omvat het verzonnen consult nummer {p}.')
        if extra and p in extra:
            t += '\n' + extra[p]
        uit.append(('p', str(p), t, ''))
    return uit


def main():
    if len(sys.argv) != 2:
        sys.exit('gebruik: nza-proef.py <pad/nza.db>')
    pad = sys.argv[1]
    if os.path.exists(pad):
        os.remove(pad)
    db = sqlite3.connect(pad)
    db.executescript(DDL)
    for (sid, titel, datum, soort, wie, laag, zaak, versie, gv, gt, code, bekend, ecli) in STUKKEN:
        db.execute('insert into stuk (id, titel, datum, soort, wie, laag, zaak, pad, sha256, versie, geldig_van, geldig_tot, ecli, documentcode, '
                   'bekend_sinds, tekst_van, tekst_tot, plekken, woorden) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)',
                   (sid, titel, datum, soort, wie, laag, zaak, f'proef/{sid}.pdf', '0' * 64, versie, gv, gt, ecli, code, bekend, gv, gt))
    pas = {
        'tb-reg-90101-01': bladzijden('tb-reg-90101-01', 6, {3: 'Het proeftarief voor de proefprestatie is vastgesteld op de oude proefwaarde.'}),
        'tb-reg-90101-02': bladzijden('tb-reg-90101-02', 6, {3: 'Het proeftarief voor de proefprestatie is vastgesteld op de nieuwe proefwaarde.',
                                                             5: 'Gelijktijdig met de inwerkingtreding van deze proefbeschikking wordt de proefbeschikking met kenmerk TB/REG-90101-01 ingetrokken.'}),
        'tb-reg-90202-01': bladzijden('tb-reg-90202-01', 5),
        'tb-reg-90303-01': bladzijden('tb-reg-90303-01', 5),
        'br-reg-90404': bladzijden('br-reg-90404', 4),
        'bob-proef-2025': bladzijden('bob-proef-2025', 24, {17: '85. De NZa handhaaft het proefbesluit en verklaart het bezwaar ongegrond.'}),
        'proef-beroep-2025': bladzijden('proef-beroep-2025', 3),
        'kpo-proef-2024': bladzijden('kpo-proef-2024', 4),
        'cbb-2099-901': [
            ('§', 'kop en inhoudsindicatie', '# ECLI:NL:CBB:2099:901 — CBb 2026-02-20\n\nVerzonnen uitspraak voor de toets.', ''),
            ('r.o.', '1.1', 'Dit geschil gaat over de verzonnen proeftarieven voor het jaar 2025.', ''),
            ('r.o.', '1.2', 'Het College is van oordeel dat de NZa de proeftarieven niet deugdelijk heeft gemotiveerd. De proefpartij krijgt op dit punt gelijk.', ''),
            ('r.o.', '1.3', 'De NZa zal opnieuw moeten beslissen op het bezwaar tegen de proeftarieven.', ''),
            ('§', 'Beslissing', '## Beslissing\n\nHet College verklaart het beroep gegrond en vernietigt de beslissing op bezwaar van 10 maart 2025.', ''),
        ],
    }
    i = 0
    for sid, rijen in pas.items():
        for v, (ps, pl, t, rn) in enumerate(rijen):
            i += 1
            if sid == 'bob-proef-2025' and pl == '17':
                rn = '85'
            db.execute('insert into passage (id, stuk_id, plek_soort, plek, volgorde, rn, tekst) values (?,?,?,?,?,?,?)', (i, sid, ps, pl, v, rn, t))
        db.execute('update stuk set plekken = ?, woorden = ? where id = ?', (len(rijen), sum(len(r[2].split()) for r in rijen), sid))
    rel = [
        ('tb-reg-90101-02', 'trekt in', 'TB/REG-90101-01', 'tb-reg-90101-01', 'p. 5',
         'Gelijktijdig met de inwerkingtreding van deze proefbeschikking wordt de proefbeschikking met kenmerk TB/REG-90101-01 ingetrokken.'),
        ('cbb-2099-901', 'verklaart gegrond', '', None, '§ Beslissing', 'Het College verklaart het beroep gegrond'),
        ('cbb-2099-901', 'vernietigt', '', 'bob-proef-2025', '§ Beslissing', 'vernietigt de beslissing op bezwaar van 10 maart 2025'),
    ]
    for n, r in enumerate(rel, 1):
        db.execute('insert into relatie (id, van_stuk, soort, naar_code, naar_stuk, plek, tekst) values (?,?,?,?,?,?,?)', (n, *r))
    geb = []
    for (sid, titel, datum, soort, wie, laag, zaak, versie, gv, gt, code, bekend, ecli) in STUKKEN:
        geb.append((bekend or datum, 'gepubliceerd', sid, f'{code or titel} gepubliceerd', '', 'puc'))
        if gv:
            geb.append((gv, 'geldig vanaf', sid, f'{code} geldt vanaf {gv}' + (f' t/m {gt}' if gt else ''), '', 'puc'))
    geb += [('2025-06-30', 'trekt in', 'tb-reg-90101-02', 'tb-reg-90101-02 trekt in TB/REG-90101-01', 'p. 5', 'tekst'),
            ('2026-02-20', 'vernietigt', 'cbb-2099-901', 'cbb-2099-901 vernietigt de beslissing op bezwaar van 10 maart 2025', '§ Beslissing', 'tekst'),
            ('2025-04-15', 'stuk', 'proef-beroep-2025', 'Beroepschrift Proefpartij', '', 'catalogus')]
    for n, g in enumerate(sorted(geb), 1):
        db.execute('insert into gebeurtenis (id, datum, soort, stuk_id, omschrijving, plek, bron) values (?,?,?,?,?,?,?)', (n, *g))
    db.execute("insert into passage_fts(passage_fts) values('rebuild')")
    tel = {'stukken': len(STUKKEN), 'passages': i, 'woorden': db.execute('select sum(woorden) from stuk').fetchone()[0],
           'relaties': len(rel), 'gebeurtenissen': len(geb)}
    db.executemany('insert into meta values (?,?)', [('gebouwd', '2026-11-15T01:00:00+0100'), ('telling', json.dumps(tel)), ('fouten', '[]'), ('ontbreekt', '[]')])
    db.commit()
    db.close()
    os.chmod(pad, 0o644)
    print(json.dumps(tel))


if __name__ == '__main__':
    main()
