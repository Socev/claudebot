#!/usr/bin/env python3
"""Maakt omzet-huisstijl.js: de huisstijlen voor "Download als…" (omzet.js, wv1854) als JS-module.

Waarom (David 28-10-2026): in de Markdown-viewer van de app een knop "Download als…" met PDF, PDF met huisstijl, Word en Excel.
Per entiteit een briefhoofd (logo of naam in de eigen kleuren) en een voettekst (naam, website, paginanummer); voor Word een
reference-doc (A4, Calibri, kopkleur, logo in de kop). Vaste bestanden in de release, niet live uit de vault: uitrol.sh neemt
alleen .js/.json mee, dus alles (logo's als PNG-data-URL, reference-docx als base64) gaat in één module.

Bronnen (alleen gelezen): factuurgenerator/entiteiten/*.json (naam, briefhoofd, kleuren, website; nooit IBAN, KvK, btw of adres:
dit is geen factuur en de repo is openbaar), de logo's uit de brand-skills van Groenhouten en Tolgaarde, het OVIS-logo uit
socev-app huisstijl/merk, Montserrat (OFL) voor Groenhouten, en de standaard reference.docx van pandoc uit het image.

Gebruik (na een wijziging in een van de bronnen):  python3 tools/omzet-huisstijl.py > omzet-huisstijl.js
Schrijft alleen naar stdout.
"""
import base64, io, json, os, re, subprocess, sys, zipfile
from PIL import Image

SKILLS = os.environ.get('SKILLS', '/opt/data/AI_SecondBrain/.claude/skills')
APP = os.environ.get('SOCEV_APP', '/opt/data/socev-app')
FONT = os.environ.get('MONTSERRAT', '/opt/data/mk-scripts/groenhouten-waarneming/bestanden/montserrat-latin.woff2')
ENT = os.path.join(SKILLS, 'factuurgenerator', 'entiteiten')

# sleutel → (label in het menu, entiteit-json of None, logo of None, kleur-overschrijving, lettertype in de PDF)
STIJLEN = [
    ('tolgaarde', 'Tolgaarde', 'tolgaarde.json', os.path.join(SKILLS, 'tolgaarde-brand-communication/assets/logo-transparant.png'),
     {'accent': 'E2232A'}, None),
    ('groenhouten', 'Groenhouten', 'groenhouten.json',
     os.path.join(SKILLS, 'groenhouten-brand-communication/assets/Logo_met_text_rechts_-_transparant_-_Open.png'), {}, 'montserrat'),
    ('pot', 'POT POH-GGZ', 'pot.json', None, {}, None),
    ('holding', 'Holding', 'holding.json', None, {}, None),
    ('praktijkhouders', 'Praktijkhouders', 'praktijkhouders_bv.json', None, {}, None),
    ('kostenmaatschap', 'Kostenmaatschap', 'kostenmaatschap.json', None, {}, None),
    ('sloel', 'SLOEL', 'sloel.json', None, {}, None),
    ('ovis', 'OVIS', None, os.path.join(APP, 'huisstijl/merk/ovis-logo.webp'), {}, None),
]
OVIS = {'naam': 'OVIS', 'briefhoofd': {'caps': '', 'naam': 'OVIS', 'ondertitel': 'Orchestrated Vault & Intelligence System'},
        'kleuren': {'titel': '0B5F86', 'caps': '00618C', 'lijn': '3080F0'}, 'website': 'socev.dev'}
# Voetnaam: de entiteitnaam, behalve waar die persoonsnamen bevat (POT: de werkgevers bij naam) — de repo is openbaar.
VOETNAAM = {'pot': 'POT POH-GGZ Leusden'}
GEEN_ONDERTITEL = {'pot'}
HEX = re.compile(r'^[0-9A-Fa-f]{6}$')
LOGO_HOOGTE = 200          # px; in de kop ± 14 mm hoog
CM = 360000                # EMU per cm


def logo_png(pad):
    im = Image.open(pad).convert('RGBA')
    b = max(1, round(im.width * LOGO_HOOGTE / im.height))
    im = im.resize((b, LOGO_HOOGTE), Image.LANCZOS).quantize(256, method=Image.Quantize.FASTOCTREE)   # palet: ± een derde van de bytes
    uit = io.BytesIO()
    im.save(uit, 'PNG', optimize=True)
    return uit.getvalue(), b, LOGO_HOOGTE


def xml_esc(s):
    return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


def run(tekst, kleur=None, vet=False, grootte=None, caps=False):
    rpr = ''
    if vet: rpr += '<w:b/>'
    if caps: rpr += '<w:spacing w:val="20"/>'
    if kleur: rpr += '<w:color w:val="%s"/>' % kleur
    if grootte: rpr += '<w:sz w:val="%d"/><w:szCs w:val="%d"/>' % (grootte, grootte)
    return '<w:r>%s<w:t xml:space="preserve">%s</w:t></w:r>' % ('<w:rPr>%s</w:rPr>' % rpr if rpr else '', xml_esc(tekst))


NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"')


def kop_xml(st, logo_maat):
    k = st['kleuren']
    rand = '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="%s"/></w:pBdr>' % k['lijn']
    if logo_maat:
        b, h = logo_maat
        cy = int(1.4 * CM)
        cx = int(cy * b / h)
        beeld = ('<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="%d" cy="%d"/>'
                 '<wp:docPr id="1" name="Logo"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
                 '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr>'
                 '<pic:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
                 '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
                 '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>') % (cx, cy, cx, cy)
        alineas = '<w:p><w:pPr><w:pStyle w:val="Header"/>%s<w:spacing w:after="0"/></w:pPr>%s</w:p>' % (rand, beeld)
    else:
        bh = st['briefhoofd']
        alineas = ''
        if bh.get('caps'):
            alineas += '<w:p><w:pPr><w:pStyle w:val="Header"/><w:spacing w:after="0"/></w:pPr>%s</w:p>' % run(bh['caps'], k['caps'], True, 16, True)
        onder = bh.get('ondertitel') or ''
        alineas += '<w:p><w:pPr><w:pStyle w:val="Header"/>%s<w:spacing w:after="0"/></w:pPr>%s%s</w:p>' % (
            '' if onder else rand, run(bh.get('naam') or st['naam'], k['titel'], True, 28), '')
        if onder:
            alineas += '<w:p><w:pPr><w:pStyle w:val="Header"/>%s<w:spacing w:after="0"/></w:pPr>%s</w:p>' % (rand, run(onder, k['caps'], False, 16))
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr %s>%s</w:hdr>' % (NS, alineas)


def voet_xml(st):
    k = st['kleuren'] if st else {'caps': '5F6368', 'lijn': 'E3E3DF'}
    delen = [p for p in ((st or {}).get('naam'), (st or {}).get('website')) if p]
    tekst = ' · '.join(delen) + ('  ·  ' if delen else '')
    veld = ('<w:r><w:rPr><w:color w:val="%s"/><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>'
            '<w:r><w:rPr><w:color w:val="%s"/><w:sz w:val="16"/></w:rPr><w:instrText xml:space="preserve"> %s </w:instrText></w:r>'
            '<w:r><w:rPr><w:color w:val="%s"/><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>'
            '<w:r><w:rPr><w:color w:val="%s"/><w:sz w:val="16"/></w:rPr><w:t>1</w:t></w:r>'
            '<w:r><w:rPr><w:color w:val="%s"/><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>')
    pagina = lambda veldnaam: veld % ((k['caps'],) * 2 + (veldnaam,) + (k['caps'],) * 3)
    p = ('<w:p><w:pPr><w:pStyle w:val="Footer"/><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="%s"/></w:pBdr></w:pPr>%s%s%s%s</w:p>'
         % (k['lijn'], run(tekst + 'pagina ', k['caps'], False, 16), pagina('PAGE'), run(' van ', k['caps'], False, 16), pagina('NUMPAGES')))
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr %s>%s</w:ftr>' % (NS, p)


def reference_docx(st, logo):
    """Pandoc-standaard → A4, Calibri, kopkleur, kop (logo of naam) en voet (naam · website · pagina x van y)."""
    basis = subprocess.check_output(['pandoc', '--print-default-data-file', 'reference.docx'])
    zin = zipfile.ZipFile(io.BytesIO(basis))
    delen = {n: zin.read(n) for n in zin.namelist()}
    thema = delen['word/theme/theme1.xml'].decode('utf-8')
    thema = re.sub(r'(<a:(?:major|minor)Font>\s*<a:latin typeface=")[^"]*(")', r'\1Calibri\2', thema)
    delen['word/theme/theme1.xml'] = thema.encode('utf-8')
    stijl = delen['word/styles.xml'].decode('utf-8')
    titel = st['kleuren']['titel'] if st else '1F2937'
    stijl = re.sub(r'<w:color w:val="[0-9A-Fa-f]{6}" w:themeColor="accent1"[^/]*/>', '<w:color w:val="%s" />' % titel, stijl)
    delen['word/styles.xml'] = stijl.encode('utf-8')
    rels = delen['word/_rels/document.xml.rels'].decode('utf-8')
    typen = delen['[Content_Types].xml'].decode('utf-8')
    kop = ''
    if st:
        rels = rels.replace('</Relationships>', '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" '
                            'Id="rIdKop" Target="header1.xml" /></Relationships>')
        typen = typen.replace('</Types>', '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.'
                              'wordprocessingml.header+xml" /></Types>')
        delen['word/header1.xml'] = kop_xml(st, logo[1:] if logo else None).encode('utf-8')
        if logo:
            delen['word/media/logo.png'] = logo[0]
            delen['word/_rels/header1.xml.rels'] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.'
                'openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/'
                '2006/relationships/image" Target="media/logo.png"/></Relationships>').encode('utf-8')
            if 'Extension="png"' not in typen:
                typen = typen.replace('</Types>', '<Default Extension="png" ContentType="image/png" /></Types>')
        kop = '<w:headerReference w:type="default" r:id="rIdKop" />'
    rels = rels.replace('</Relationships>', '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" '
                        'Id="rIdVoet" Target="footer1.xml" /></Relationships>')
    typen = typen.replace('</Types>', '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.'
                          'wordprocessingml.footer+xml" /></Types>')
    delen['word/footer1.xml'] = voet_xml(st).encode('utf-8')
    delen['word/_rels/document.xml.rels'] = rels.encode('utf-8')
    delen['[Content_Types].xml'] = typen.encode('utf-8')
    doc = delen['word/document.xml'].decode('utf-8')
    sect = ('<w:sectPr>%s<w:footerReference w:type="default" r:id="rIdVoet" /><w:pgSz w:w="11906" w:h="16838" />'
            '<w:pgMar w:top="%d" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="454" w:gutter="0" /></w:sectPr>'
            % (kop, 1985 if st else 1134))
    if '<w:sectPr />' not in doc:
        sys.exit('omzet-huisstijl.py: <w:sectPr /> niet gevonden in de pandoc-reference.docx')
    doc = doc.replace('<w:sectPr />', sect)
    if 'xmlns:r=' not in doc[:2000]:
        doc = doc.replace('<w:document ', '<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ', 1)
    delen['word/document.xml'] = doc.encode('utf-8')
    uit = io.BytesIO()
    with zipfile.ZipFile(uit, 'w', zipfile.ZIP_DEFLATED) as z:
        for n in zin.namelist() + [n for n in delen if n not in zin.namelist()]:
            info = zipfile.ZipInfo(n, date_time=(2026, 10, 28, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, delen[n])
    return uit.getvalue()


def main():
    stijlen = {}
    for sleutel, label, ent, logo_pad, kleur_extra, font in STIJLEN:
        if ent:
            with open(os.path.join(ENT, ent), encoding='utf-8') as f:
                e = json.load(f)
        else:
            e = OVIS
        k = dict(e.get('kleuren') or {})
        k.update(kleur_extra)
        k.setdefault('accent', k.get('titel'))
        if not all(HEX.match(str(k.get(x) or '')) for x in ('titel', 'caps', 'lijn', 'accent')):
            sys.exit('omzet-huisstijl.py: kleuren van %s onvolledig' % sleutel)
        web = str(e.get('website') or '')
        web = web if re.match(r'^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$', web) else ''   # Groenhouten: het veld bevat een mailadres → weg
        st = {'label': label, 'naam': VOETNAAM.get(sleutel, e['naam']), 'website': web, 'kleuren': {x: k[x].upper() for x in ('titel', 'caps', 'lijn', 'accent')},
              'briefhoofd': {x: str((e.get('briefhoofd') or {}).get(x) or '') for x in ('caps', 'naam', 'ondertitel')}, 'font': font}
        if sleutel in GEEN_ONDERTITEL:
            st['briefhoofd']['ondertitel'] = ''
        logo = logo_png(logo_pad) if logo_pad else None
        if logo:
            st['logo'] = 'data:image/png;base64,' + base64.b64encode(logo[0]).decode()
            st['logo_maat'] = [logo[1], logo[2]]
        st['docx'] = base64.b64encode(reference_docx(st, logo)).decode()
        stijlen[sleutel] = st
    neutraal = base64.b64encode(reference_docx(None, None)).decode()
    with open(FONT, 'rb') as f:
        fonts = {'montserrat': 'data:font/woff2;base64,' + base64.b64encode(f.read()).decode()}
    print('// gemaakt met tools/omzet-huisstijl.py (wv1854) — niet hier wijzigen: pas de bron aan en maak opnieuw')
    print("'use strict';")
    print('// Huisstijlen voor Download als… (omzet.js): briefhoofd en voet voor de PDF, reference-docx voor Word. Geen IBAN, KvK of adres.')
    print('const STIJLEN = %s;' % json.dumps(stijlen, ensure_ascii=False))
    print('const NEUTRAAL_DOCX = %s;' % json.dumps(neutraal))
    print('const FONTS = %s;' % json.dumps(fonts))
    print('module.exports = { STIJLEN, NEUTRAAL_DOCX, FONTS };')


main()
