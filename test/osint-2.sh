#!/usr/bin/env bash
# wv2698: OVIS OSINT 2 — nieuwe bronnen en ingangen (bedrijf breder, adres extra, kenteken, mail, bestand, voetafdruk, lijkende domeinen,
# netwerkplaat) zonder netwerk: OSINT_NEP_NET=1 + OSINT_NEP_ANTWOORD (verzonnen antwoorden per host/pad). Per bron: velden komen goed
# uit het antwoord. Per ingang: de poort houdt een BSN-vorm, een patiëntkenmerk of een medische herkomst tegen (nul externe aanroepen).
# OSINT_PY=<ander osint.py> voor de kruisproef (poort uit → deze toets moet rood worden).
set -euo pipefail
cd "$(dirname "$0")/.."
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
printf 'contacten-zoek http://127.0.0.1:9/contacten\nagenda-wachter-api http://127.0.0.1:9/agenda\n' > "$T/webhooks.txt"
export OSINT_DB="$T/db/osint.sqlite" OSINT_NEP_NET=1 OSINT_WEBHOOKS="$T/webhooks.txt" VAULT_DIR="$T/vault" OSINT_TOOLS="$T/tools"
export API_SECRET=toets SUPABASE_RPC_CONTACTEN=toets N8N_WEBHOOK_AGENDA_API=toets PORT=9 OSINT_NEP_ANTWOORD="$T/nep.json" OSINT_NEP_DNSTWIST="$T/dnstwist.json"
mkdir -p "$T/vault/10_Zakelijk" "$T/tools"
ET="${OSINT_EXIFTOOL:-/opt/data/venvs/osint/tools/exiftool/exiftool}"
[ -f "$ET" ] && ln -s "$(dirname "$ET")" "$T/tools/exiftool" || true
PY="${OSINT_PY:-$PWD/osint.py}"
python3 -I - "$PY" "$T" <<'EOF'
import base64, json, os, sqlite3, subprocess, sys
py, T = sys.argv[1], sys.argv[2]
fout = []
def eis(ok, wat):
    print(('ok   ' if ok else 'FOUT ') + wat)
    if not ok: fout.append(wat)
# verzonnen antwoorden (geen echte personen; organisaties en adressen zijn verzonnen)
nep = {
 'ec.europa.eu/taxation_customs/vies': {'isValid': True, 'name': 'VOORBEELD LEVERANCIER B.V.', 'address': '\nPROEFSTRAAT 00001\n9999ZZ NERGENSDORP\n', 'requestDate': '2026-11-08T07:00:00Z'},
 'api.gleif.org/api/v1/lei-records/PROEF00000000000LEI0/direct-parent': {'data': {'attributes': {'lei': 'PROEF00000000000MOE0', 'entity': {'legalName': {'name': 'Voorbeeld Moeder B.V.'}}}}},
 'api.gleif.org/api/v1/lei-records/PROEF00000000000LEI0/direct-children': {'data': [], 'meta': {'pagination': {'total': 0}}},
 'api.gleif.org/api/v1/lei-records': {'data': [{'attributes': {'lei': 'PROEF00000000000LEI0', 'entity': {'legalName': {'name': 'Voorbeeld Leverancier B.V.'}, 'status': 'ACTIVE',
     'registeredAs': '99999999', 'legalAddress': {'addressLines': ['Proefstraat 1'], 'postalCode': '9999ZZ', 'city': 'Nergensdorp', 'country': 'NL'}, 'creationDate': '2001-01-01T00:00:00Z'},
     'registration': {'status': 'ISSUED', 'nextRenewalDate': '2027-01-01T00:00:00Z'}}}]},
 'offshoreleaks.icij.org/api/v1/reconcile': {'q0': {'result': [{'id': '1', 'name': 'VOORBEELD LEVERANCIER LTD', 'description': 'Entity node (proef)', 'score': 91.0}, {'id': '2', 'name': 'ANDERS', 'score': 20}]}},
 'repository.overheid.nl/sru': {'searchRetrieveResponse': {'numberOfRecords': 2, 'records': {'record': [
     {'recordData': {'gzd': {'originalData': {'meta': {'owmskern': {'title': 'Proefvergunning Proefstraat 1', 'type': {'$': 'Vergunning'}, 'creator': {'$': 'Gemeente Nergensdorp'}},
      'owmsmantel': {'available': '2026-10-01'}, 'tpmeta': {'publicatienaam': 'Gemeenteblad'}}}, 'enrichedData': {'preferredUrl': 'https://zoek.officielebekendmakingen.nl/proef-1.html'}}}},
     {'recordData': {'gzd': {'originalData': {'meta': {'owmskern': {'title': 'Oudere proef'}, 'owmsmantel': {'available': '2020-01-01'}, 'tpmeta': {}}}, 'enrichedData': {}}}}]}}},
 'uitspraken.rechtspraak.nl/api/zoek': {'ResultCount': 1, 'Results': [{'Titel': 'Rechtbank Proef, 01-01-2026', 'TitelEmphasis': 'ECLI:NL:PROEF:2026:1', 'Uitspraakdatum': '01-01-2026',
     'Rechtsgebieden': ['Civiel recht'], 'Tekstfragment': 'Verzonnen fragment over Voorbeeld Leverancier.', 'DeeplinkUrl': 'https://deeplink.rechtspraak.nl/uitspraak?id=ECLI:NL:PROEF:2026:1'}]},
 'api.pdok.nl/bzk/locatieserver/search/v3_1/free': {'response': {'docs': [{'weergavenaam': 'Proefstraat 1, 9999ZZ Nergensdorp', 'straatnaam': 'Proefstraat', 'huis_nlt': '1',
     'woonplaatsnaam': 'Nergensdorp', 'centroide_ll': 'POINT(5.1 52.1)', 'centroide_rd': 'POINT(150000 450000)', 'buurtnaam': 'Proefbuurt', 'gemeentenaam': 'Nergensdorp'}]}},
 'api.pdok.nl/kadaster/brk-kadastrale-kaart': {'features': [{'properties': {'kadastrale_gemeente_waarde': 'Nergensdorp', 'akr_kadastrale_gemeente_code_waarde': 'NGD00',
     'sectie': 'Z', 'perceelnummer': 13, 'kadastrale_grootte_waarde': 513, 'soort_grootte_waarde': 'Vastgesteld', 'begin_geldigheid': '2010-01-01T00:00:00Z'}}]},
 'opendata.rdw.nl/resource/m9d7-ebf2.json': [{'kenteken': 'ZZ999Q', 'merk': 'PROEFMERK', 'handelsbenaming': 'MODEL X', 'eerste_kleur': 'GROEN', 'vervaldatum_apk': '20270101',
     'datum_tenaamstelling': '20250505', 'openstaande_terugroepactie_indicator': 'Ja', 'wam_verzekerd': 'Ja'}],
 'opendata.rdw.nl/resource/8ys7-d773.json': [{'brandstof_omschrijving': 'Elektriciteit'}],
 'opendata.rdw.nl/resource/t49b-isb7.json': [{'referentiecode_rdw': 'PROEF13', 'status': 'Niet uitgevoerd'}],
 'opendata.rdw.nl/resource/sgfe-77wx.json': [],
 'internetdb.shodan.io': {'ip': '203.0.113.7', 'ports': [25, 443], 'hostnames': ['mail.proef.example'], 'vulns': ['CVE-0000-0001'], 'tags': []},
 'stat.ripe.net/data/prefix-overview': {'data': {'asns': [{'asn': 64496, 'holder': 'PROEFNET'}], 'resource': '203.0.113.0/24'}},
 'stat.ripe.net/data/maxmind-geo-lite': {'data': {'located_resources': [{'locations': [{'city': 'Proefstad', 'country': 'NL'}]}]}},
 'rdap.org/ip': {'name': 'PROEF-NET', 'country': 'NL'},
 'api.xposedornot.com/v1/breach-analytics': {'ExposedBreaches': {'breaches_details': [{'breach': 'ProefLek', 'xposed_date': '2020', 'xposed_data': 'Email addresses;Passwords',
     'xposed_records': 1000, 'password_risk': 'plaintext', 'domain': 'proeflek.example'}]}, 'BreachMetrics': {'risk': [{'risk_label': 'Hoog', 'risk_score': 80}]}},
 'proef-a.example/qzvproef8813': '<html>Profiel van qzvproef8813</html>',
 'proef-b.example/qzvproef8813': '<html>Not found</html>',
}
json.dump(nep, open(os.path.join(T, 'nep.json'), 'w'))
json.dump({'sites': [
    {'name': 'ProefA', 'uri_check': 'https://proef-a.example/{account}', 'e_code': 200, 'e_string': 'Profiel van', 'm_string': 'Not found', 'm_code': 404, 'cat': 'social'},
    {'name': 'ProefB', 'uri_check': 'https://proef-b.example/{account}', 'e_code': 200, 'e_string': 'Profiel van', 'm_string': 'Not found', 'm_code': 404, 'cat': 'coding'},
    {'name': 'ProefC', 'uri_check': 'https://proef-c.example/{account}', 'e_code': 200, 'e_string': 'x', 'post_body': '{}', 'cat': 'misc'}]},
    open(os.path.join(T, 'tools', 'wmn-data.json'), 'w'))
def dnstwist_nep(met_variant):
    json.dump({'proefpraktijk.example': [{'fuzzer': '*original', 'domain': 'proefpraktijk.example', 'dns_a': ['192.0.2.1']}] + ([
        {'fuzzer': 'homoglyph', 'domain': 'proefpraktijk.examp1e', 'dns_a': ['192.0.2.9'], 'dns_mx': ['mx.boos.example']}] if met_variant else [])},
        open(os.path.join(T, 'dnstwist.json'), 'w'))
dnstwist_nep(False)

def run(args, invoer=None):
    r = subprocess.run([sys.executable, '-I', py] + args, input=json.dumps(invoer or {}), capture_output=True, text=True, timeout=90)
    if r.returncode: fout.append('exit %d: %s' % (r.returncode, r.stderr[-400:])); return {}
    return json.loads(r.stdout)
def zoek(**v): return run(['zoek'], v)
def ext(r): return sum(1 for l in r.get('logboek', []) if l['soort'] == 'extern' and l['status'] != 'poort dicht')
def kaart(r, titel): return next((k for k in r.get('kaarten', []) if k['titel'].startswith(titel)), {})
def veld(k, naam): return dict(k.get('velden') or []).get(naam)

# --- bedrijf breder
r = zoek(ingang='auto', term='NL123456782B01', wie='david')
eis(r.get('ingang') == 'bedrijf' and r['poort']['niveau'] == 'alles', 'btw-nummer: ingang bedrijf, poort open (btw-vorm is geen BSN)')
k = kaart(r, 'Btw-nummer (VIES)'); eis(veld(k, 'Geldig') == 'ja' and veld(k, 'Naam volgens de belastingdienst') == 'VOORBEELD LEVERANCIER B.V.' and 'NERGENSDORP' in (veld(k, 'Adres volgens de belastingdienst') or ''), 'VIES: geldig, naam, adres')
k = kaart(r, 'LEI-register'); eis(veld(k, 'LEI') == 'PROEF00000000000LEI0' and 'Voorbeeld Moeder' in (veld(k, 'Directe moeder') or '') and veld(k, 'Registratienummer (KvK)') == '99999999', 'GLEIF: LEI, KvK, moeder')
k = kaart(r, 'Offshore Leaks'); eis(len(k.get('items') or []) == 1 and 'nodes/1' in k['items'][0].get('url', ''), 'ICIJ: alleen sterke treffer, met link')
k = kaart(r, 'Officiële bekendmakingen'); eis((k.get('items') or [{}])[0].get('tekst') == 'Proefvergunning Proefstraat 1', 'bekendmakingen: nieuwste eerst')
k = kaart(r, 'Rechtspraak'); eis('ECLI:NL:PROEF:2026:1' in (k.get('items') or [{}])[0].get('sub', ''), 'Rechtspraak: ECLI en fragment')
eis(bool(kaart(r, 'Faillissement').get('links')), 'insolventie: link (geen open route)')
eis(all(k.get('juridisch') for k in r['kaarten'] if k['titel'] != 'Poort' and k['bron'] != 'OVIS OSINT'), 'elke bronkaart heeft de juridische regel')
eis(any(x['soort'] == 'lei' for x in (r.get('graaf') or {}).get('knopen', [])) and any(x['label'] == 'moeder' for x in r['graaf']['randen']), 'netwerkplaat: LEI en moeder')
# --- adres extra
r = zoek(ingang='adres', term='Proefstraat 1, 9999 ZZ Nergensdorp', wie='david')
k = kaart(r, 'Perceel'); eis(veld(k, 'Kadastrale aanduiding') == 'Nergensdorp Z 13' and veld(k, 'Grootte') == '513 m²', 'BRK: perceel en grootte')
eis(any('WOZ' in i['tekst'] for i in kaart(r, 'Meer over dit adres').get('links', [])), 'adres: WOZ/Omgevingsloket-links')
eis(bool(kaart(r, 'Bekendmakingen over dit adres').get('items')), 'adres: bekendmakingen op straat + plaats')
eis(any(x['soort'] == 'perceel' for x in (r.get('graaf') or {}).get('knopen', [])), 'netwerkplaat: adres → perceel')
# --- kenteken
r = zoek(ingang='auto', term='ZZ-999-Q', wie='david')
k = kaart(r, 'Kenteken'); eis(r.get('ingang') == 'kenteken' and veld(k, 'Merk') == 'PROEFMERK' and veld(k, 'APK geldig tot') == '01-01-2027' and veld(k, 'Brandstof') == 'Elektriciteit', 'RDW: merk, APK, brandstof')
eis(bool(k.get('let')) and any('PROEF13' in i['tekst'] for i in k.get('items') or []) and not any('eigenaar' == a.lower() for a, _ in k.get('velden', [])), 'RDW: terugroepactie, geen eigenaar')
# --- mail
kop = ('Received: from mail.proef.example (mail.proef.example [203.0.113.7]) by mx.proef.example; Sat, 7 Nov 2026 22:10:00 +0100\n'
       'Received-SPF: softfail client-ip=203.0.113.7;\nAuthentication-Results: mx.proef.example; dkim=pass header.d=ander.example; spf=softfail; dmarc=fail\n'
       'From: Proef <factuur@proef.example>\nReply-To: betalen@ander-proef.example\nSubject: Factuur 2026-0042\n\nINHOUD-NIET-LEZEN')
r = zoek(ingang='auto', kop=kop, wie='david')
k = kaart(r, 'De mail'); eis(r.get('ingang') == 'mail' and veld(k, 'SPF') == 'softfail' and veld(k, 'Oorspronkelijke server (IP)') == '203.0.113.7' and 'ander-proef.example' in (k.get('let') or ''), 'mailkop: SPF, oorsprong, ander antwoorddomein')
k = kaart(r, 'Server 203.0.113.7'); eis(veld(k, 'Netwerk (ASN)') == 'AS64496 PROEFNET' and veld(k, 'Open poorten') == '25, 443' and 'CVE-0000-0001' in (veld(k, 'Bekende kwetsbaarheden') or ''), 'IP: RIPEstat + Shodan')
eis('INHOUD-NIET-LEZEN' not in json.dumps(r) and 'Factuur 2026-0042' not in json.dumps(r), 'mail: inhoud en onderwerp komen niet in de uitkomst')
# --- bestand (ExifTool lokaal; alleen als ExifTool er is)
def pdf(auteur):
    objs = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 99 99] >>',
            b"<< /Author (" + auteur + b") /Producer (iLovePDF) /CreationDate (D:20261101100000) /ModDate (D:20261107210000) >>"]
    o, offs = b'%PDF-1.4\n', []
    for i, x in enumerate(objs, 1):
        offs.append(len(o)); o += b'%d 0 obj\n' % i + x + b'\nendobj\n'
    x = len(o); o += b'xref\n0 5\n0000000000 65535 f \n' + b''.join(b'%010d 00000 n \n' % f for f in offs)
    return o + b'trailer\n<< /Size 5 /Root 1 0 R /Info 4 0 R >>\nstartxref\n%d\n%%%%EOF\n' % x
if os.path.exists(os.path.join(T, 'tools', 'exiftool', 'exiftool')):
    r = zoek(ingang='bestand', bestand=base64.b64encode(pdf(b'Verzonnen Maker')).decode(), naam='factuur-jansen.pdf', wie='david')
    k = kaart(r, 'Het bestand'); eis('iLovePDF' in (k.get('let') or '') and 'gewijzigd na het maken' in (k.get('let') or '') and ext(r) == 0, 'ExifTool: programma + wijziging, niets naar buiten')
    eis(veld(kaart(r, 'Maker'), 'PDF:Author') == 'Verzonnen Maker', 'ExifTool: maker')
    for a in (b'pat.nr 47119999', b'111222333 Maker'):
        r = zoek(ingang='bestand', bestand=base64.b64encode(pdf(a)).decode(), naam='scan.pdf', wie='david')
        eis(r['kaarten'][0]['titel'] == 'Poort' and len(r['kaarten']) == 1 and a.decode() not in json.dumps(r), 'bestand met %s in de metadata: niets getoond' % a.decode()[:9])
else:
    print('overslaan: ExifTool ontbreekt hier (bestand-toetsen)')
# --- voetafdruk en lijkende domeinen (alleen eigen lijsten)
i = run(['instelling'], {'zet': {'gebruikersnamen': ['qzvproef8813', '111222333'], 'adressen': ['verzonnen.proef8813@example.com'], 'domeinen': ['proefpraktijk.example']}})
eis(i.get('instellingen', {}).get('gebruikersnamen') == ['qzvproef8813'] and '111222333' in i.get('geweigerd', []), 'instelling: BSN-vorm geweigerd')
r = zoek(ingang='voetafdruk', wie='david')
k = kaart(r, 'Gebruikersnaam "qzvproef8813"'); eis([x['tekst'] for x in k.get('items', [])] == ['ProefA'] and k.get('misschien') is True, 'WhatsMyName: ProefA misschien, ProefB niet, ProefC (post) overgeslagen')
eis(any(l['bron'].startswith('WhatsMyName') and '2 sites' in l['naar_buiten'] for l in r['logboek']), 'WhatsMyName: één gebundelde logregel')
k = kaart(r, 'Mailadres verzonnen'); eis('ProefLek' in json.dumps(k) and 'Hoog' in json.dumps(k), 'XposedOrNot: lek en risico')
eis(bool(kaart(r, 'Datalekken op je praktijkdomeinen').get('links')), 'HIBP: uitleg + link')
r = zoek(ingang='lijkend', wie='machinekamer')
eis(r['kern'].get('nieuw') == [] and 'nulmeting' in (kaart(r, 'Lijkend op proefpraktijk.example').get('klein') or ''), 'dnstwist eerste ronde (leeg): nulmeting, niets nieuw')
dnstwist_nep(True)
r = zoek(ingang='lijkend', wie='machinekamer')
k = kaart(r, 'Lijkend op proefpraktijk.example'); eis(any('proefpraktijk.examp1e' == x['tekst'] and 'mx.boos.example' in x.get('sub', '') and x.get('nieuw') for x in k.get('items', [])), 'dnstwist: nieuwe variant met mailserver na een lege nulmeting (review-MOET 3)')
eis(r['kern'].get('nieuw') == [{'variant': 'proefpraktijk.examp1e', 'domein': 'proefpraktijk.example', 'mx': True}], 'dnstwist: kern.nieuw voor de CISO-ronde')
l = run(['lijkend']); eis(l.get('nieuw') == [] and l.get('geregistreerd') == 1 and l.get('mislukt') == [], 'lijkend (CISO): volgende ronde stilte')
dnstwist_nep(False); run(['lijkend']); dnstwist_nep(True)
l = run(['lijkend']); eis(len(l.get('nieuw') or []) == 1, 'lijkend: verdwenen en opnieuw geregistreerd = weer nieuw')
# --- poort: BSN-vorm, patiëntkenmerk en medische herkomst houden ook de nieuwe ingangen tegen
for ing, term in (('kenteken', 'ZZ-999-Q 111222333'), ('bedrijf', 'NL123456782B01 111222333'), ('adres', 'Proefstraat 1 Nergensdorp patiëntnummer 4711')):
    r = zoek(ingang=ing, term=term, wie='david')
    eis(r['poort']['niveau'] == 'niets' and ext(r) == 0, 'poort: %s met BSN-/patiëntvorm → nul externe aanroepen' % ing)
r = zoek(ingang='bedrijf', term='Voorbeeld Leverancier', wie='socev', herkomst='mogelijk-medisch')
eis(r['poort']['niveau'] == 'eigen' and ext(r) == 0, 'poort: bedrijf breder met herkomst mogelijk medisch → nul externe')
r = zoek(ingang='mail', kop=kop.replace('Subject: Factuur 2026-0042', 'Subject: uitslag patiënt 4711'), wie='david')
eis(r['poort']['niveau'] == 'niets' and ext(r) == 0, 'poort: mailkop met patiëntkenmerk → nul externe')
r = zoek(ingang='mail', kop=kop, wie='socev', herkomst='mail')
eis(r['poort']['niveau'] == 'eigen' and ext(r) == 0, 'poort: mailkop van Socev met herkomst mail → nul externe')
r = zoek(ingang='voetafdruk', wie='socev', herkomst='david-vraag')
eis(r['poort']['niveau'] == 'niets' and ext(r) == 0, 'voetafdruk alleen voor David (Socev: niets)')
# review-MOET 1: Socev met een vrije naam (tegenpartij uit de bank kan een persoon zijn) → niet naar Rechtspraak/ICIJ/bekendmakingen/GLEIF
r = zoek(ingang='bedrijf', term='P. Proefpersoon', wie='socev', herkomst='facturen')
hosts = {l['host'] for l in r.get('logboek', []) if l['soort'] == 'extern' and l['status'] != 'poort dicht'}
eis(r['poort']['niveau'] == 'alles' and not hosts & {'uitspraken.rechtspraak.nl', 'offshoreleaks.icij.org', 'repository.overheid.nl', 'api.gleif.org'}, 'Socev + vrije naam: geen naamzoekvraag naar Rechtspraak/ICIJ/SRU/GLEIF')
r = zoek(ingang='bedrijf', term='P. Proefpersoon', wie='david')
hosts = {l['host'] for l in r.get('logboek', []) if l['soort'] == 'extern'}
eis({'uitspraken.rechtspraak.nl', 'offshoreleaks.icij.org'} <= hosts, 'David + naam: wel bedrijf breder (zijn eigen vraag)')
# review-MOET 2: een kop zonder Received-regel is toch mail, nooit een adres naar PDOK
r = zoek(ingang='auto', kop='From: Piet Proef <piet.proef@proef.example>\nTo: verzonnen@example.com\nSubject: Factuur Proefstraat 12', wie='david')
eis(r.get('ingang') == 'mail' and r.get('term', '').startswith('mailkop') and not any(l['host'] == 'api.pdok.nl' for l in r.get('logboek', [])), 'kop zonder Received: ingang mail, niets naar PDOK')
eis(zoek(ingang='auto', term='9999 ZZ', wie='david').get('ingang') == 'adres', 'postcode alleen: adres, geen kenteken')
r = zoek(ingang='auto', term='123456782', wie='david')
eis(r['poort']['niveau'] == 'niets', 'losse BSN-vorm blijft dicht (alleen het volledige btw-nummer is vrij)')
# --- logboek en netwerkplaat
c = sqlite3.connect(os.environ['OSINT_DB'])
termen = ' '.join(x[0] for x in c.execute('select term from zoekvraag'))
eis('jansen' not in termen and 'Factuur' not in termen and 'mailkop (' in termen and 'bestand .pdf' in termen or not os.path.exists(os.path.join(T, 'tools', 'exiftool', 'exiftool')), 'logboek: geen bestandsnaam of mailonderwerp')
eis(c.execute("select count(*) from aanroep a join zoekvraag z on z.id = a.zoek_id where z.poort != 'alles' and a.soort = 'extern' and a.status != 'poort dicht'").fetchone()[0] == 0, 'logboek: nul externe aanroepen bij poort niets/eigen')
g = run(['grafiek'])
ids = {x['id'] for x in g.get('knopen', [])}
eis({'btw:nl123456782b01', 'kenteken:zz999q', 'ip:203.0.113.7', 'domein:proefpraktijk.examp1e'} <= ids and all(r['van'] in ids and r['naar'] in ids for r in g['randen']), 'grafiek: knopen uit alle zoekvragen, randen kloppen')
eis(all(x.get('soort') not in ('persoon',) for x in g['knopen']) and not any('Verzonnen Maker' in x['label'] for x in g['knopen']), 'grafiek: geen personen of bestandsmakers')
print('osint-2: %d fout' % len(fout)); sys.exit(1 if fout else 0)
EOF
