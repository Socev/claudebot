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
export OSINT_NEP_DNS="$T/dns.json"   # wv2712: verzonnen DNS voor de miniaturen (intern.proef.example → 10.0.0.5)
mkdir -p "$T/vault/10_Zakelijk" "$T/tools"
ET="${OSINT_EXIFTOOL:-/opt/data/venvs/osint/tools/exiftool/exiftool}"
[ -f "$ET" ] && ln -s "$(dirname "$ET")" "$T/tools/exiftool" || true
PY="${OSINT_PY:-$PWD/osint.py}"
PYBIN="${OSINT_PYTHON:-python3}"   # wv2712: de venv (Pillow + numpy) toetst ook de fotoforensiek
"$PYBIN" -I - "$PY" "$T" <<'EOF'
import base64, json, os, sqlite3, subprocess, sys
import urllib.parse as up
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
     'woonplaatsnaam': 'Nergensdorp', 'centroide_ll': 'POINT(5.1 52.1)', 'centroide_rd': 'POINT(150000 450000)', 'buurtnaam': 'Proefbuurt', 'gemeentenaam': 'Nergensdorp',
     'buurtcode': 'BU99990101', 'gemeentecode': '9999', 'adresseerbaarobject_id': '9999010000000001'}]}},
 # wv2712: buurt (CBS, Leefbaarometer), hoogte (AHN), bodem, straatbeeld — verzonnen
 'opendata.cbs.nl/ODataApi/odata/86358NED/TypedDataSet': {'value': [{'WijkenEnBuurten': 'BU99990101', 'Gemeentenaam_1': 'Nergensdorp   ', 'AantalInwoners_5': 1300}]},
 'opendata.cbs.nl/ODataApi/odata/86165NED/TypedDataSet': {'value': [
     {'WijkenEnBuurten': 'BU99990101', 'AantalInwoners_5': 1290, 'k_0Tot15Jaar_8': 129, 'k_15Tot25Jaar_9': 129, 'k_25Tot45Jaar_10': 258, 'k_45Tot65Jaar_11': 387, 'k_65JaarOfOuder_12': 387,
      'GemiddeldeWOZWaardeVanWoningen_39': 413, 'AfstandTotHuisartsenpraktijk_110': 0.7, 'MateVanStedelijkheid_120': 4},
     {'WijkenEnBuurten': 'GM9999    ', 'GemiddeldeWOZWaardeVanWoningen_39': 399, 'AfstandTotHuisartsenpraktijk_110': 1.1},
     {'WijkenEnBuurten': 'NL00      ', 'GemiddeldeWOZWaardeVanWoningen_39': 350}]},
 'opendata.cbs.nl/ODataApi/odata/85984NED/TypedDataSet': {'value': [{'WijkenEnBuurten': 'BU99990101', 'GemiddeldeWOZWaardeVanWoningen_39': 1, 'PersonenInArmoede_81': 1.3}]},
 'geo.leefbaarometer.nl/lbm3/ows?typeNames=lbm3:buurtscore24': {'features': [{'properties': {'id': 'BU99990101', 'name': 'Proefbuurt', 'gemeente': 'Nergensdorp', 'year': 2024,
     'kscore': 7, 'won': 0.02, 'fys': -0.03, 'vrz': 0.0, 'soc': 0.01, 'onv': -0.05}}]},
 'geo.leefbaarometer.nl/lbm3/ows?typeNames=lbm3:buurtscore22': {'features': [{'properties': {'kscore': 6}}]},
 'geo.leefbaarometer.nl/lbm3/ows?typeNames=lbm3:buurtscore20': {'features': [{'properties': {'kscore': 5}}]},
 'service.pdok.nl/rws/ahn/wms/v1_0?request=GetFeatureInfo&layers=dsm_05m': {'features': [{'properties': {'value_list': '12.5'}}]},
 'service.pdok.nl/rws/ahn/wms/v1_0?request=GetFeatureInfo&layers=dtm_05m': {'features': [{'properties': {'value_list': '2.5'}}]},
 'gis.gdngeoservices.nl/standalone/services/blk_gdn/lks_blk_rd_v1/MapServer/WMSServer': {'features': [{'properties': {'AUTHORITY_NM': 'Proefomgevingsdienst',
     'WEBSITE_BLN': 'J', 'DOSSIER_BLN': 'N', 'WEBSITE_URL': 'https://bodem.proef.example/'}}]},
 'api.panoramax.xyz/api/search': {'features': [
     {'id': 'proef-ver', 'geometry': {'type': 'Point', 'coordinates': [5.2, 52.2]}, 'properties': {'datetime': '2025-01-01T10:00:00Z', 'geovisio:thumbnail': 'https://foto.proef.example/ver.jpg'}},
     {'id': 'proef-1', 'geometry': {'type': 'Point', 'coordinates': [5.1003, 52.1001]}, 'properties': {'datetime': '2025-05-05T10:00:00Z', 'geovisio:producer': 'proefmaker',
      'geovisio:thumbnail': 'https://foto.proef.example/p1.jpg'}},
     # review-MOET 1: miniaturen naar http, een interne host of een IP-vorm worden niet opgehaald
     {'id': 'proef-http', 'geometry': {'type': 'Point', 'coordinates': [5.1008, 52.1002]}, 'properties': {'geovisio:thumbnail': 'http://foto.proef.example/h.jpg'}},
     {'id': 'proef-intern', 'geometry': {'type': 'Point', 'coordinates': [5.1009, 52.1002]}, 'properties': {'geovisio:thumbnail': 'https://intern.proef.example/i.jpg'}},
     {'id': 'proef-ip', 'geometry': {'type': 'Point', 'coordinates': [5.1010, 52.1002]}, 'properties': {'geovisio:thumbnail': 'https://0x7f.0.0.1/x.jpg'}}]},
 # wv2718: EP-online v5 (verzonnen; twee labels, het nieuwste telt)
 'public.ep-online.nl/api/v5/PandEnergielabel/AdresseerbaarObject': [
     {'Registratiedatum': '2019-02-02T10:00:00', 'Energieklasse': 'C', 'Gebouwklasse': 'Woningbouw'},
     {'Registratiedatum': '2024-03-04T07:30:49.227', 'Opnamedatum': '2024-02-01T00:00:00', 'Geldig_tot': '2034-02-01T00:00:00', 'Certificaathouder': 'Proefadvies B.V.',
      'Soort_opname': 'Basisopname', 'Status': 'Bestaand', 'Berekeningstype': 'NTA 8800:2024 (basisopname woningbouw)', 'IsVereenvoudigdLabel': False,
      'Op_basis_van_referentiegebouw': True, 'Gebouwklasse': 'Woningbouw', 'Gebouwtype': 'Tussenwoning', 'Postcode': '9999ZZ', 'Huisnummer': 1,
      'BAGVerblijfsobjectID': '9999010000000001', 'BAGPandIDs': ['9999100000000001'], 'Bouwjaar': 1931, 'Gebruiksoppervlakte_thermische_zone': 113.4, 'Compactheid': 1.62,
      'Energieklasse': 'A+', 'Energiebehoefte': 98.26, 'Eis_energiebehoefte': None, 'PrimaireFossieleEnergie': 101.5, 'Eis_primaire_fossiele_energie': 120,
      'Aandeel_hernieuwbare_energie': 31.04, 'Eis_aandeel_hernieuwbare_energie': 40, 'Temperatuuroverschrijding': 1.2, 'BerekendeCO2Emissie': 17.3,
      'Primaire_fossiele_energie_EMG_forfaitair': 101.5}],
 'graph.mapillary.com/images': {'data': [{'id': '777', 'captured_at': 1730000000000, 'computed_geometry': {'coordinates': [5.1001, 52.1]}, 'thumb_256_url': 'https://foto.proef.example/m1.jpg'}]},
 'foto.proef.example/p1.jpg': 'base64:' + base64.b64encode(b'\xff\xd8\xff\xe0PROEFFOTO').decode(),
 'foto.proef.example/m1.jpg': 'base64:' + base64.b64encode(b'\xff\xd8\xff\xe0PROEFFOTO2').decode(),
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
json.dump({'intern.proef.example': '10.0.0.5', 'foto.proef.example': '93.184.216.34'}, open(os.path.join(T, 'dns.json'), 'w'))
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
# --- wv2712: adres deel 3 (buurt, hoogte, bodem, straatbeeld)
k = kaart(r, 'Buurtcijfers (CBS)')
eis(veld(k, 'Inwoners (2026)') == '1.300' and veld(k, 'Gemiddelde WOZ-waarde (2025)') == '€ 413.000  (gemeente € 399.000; Nederland € 350.000)', 'CBS: nieuwste jaar per veld, met gemeente en NL')
eis(veld(k, 'Leeftijd (2025)') == '0–15: 10 % · 15–25: 10 % · 25–45: 20 % · 45–65: 30 % · 65+: 30 %' and veld(k, 'In armoede (2024)') == '1,3 %', 'CBS: leeftijd in één jaar, ouder jaar als het nieuwe leeg is')
eis(veld(k, 'Stedelijkheid (2025)') == 'weinig stedelijk' and veld(k, 'Afstand tot een huisartsenpraktijk (2025)').startswith('0,7 km'), 'CBS: stedelijkheid en afstand tot huisarts')
eis(any(l['host'] == 'opendata.cbs.nl' and l['naar_buiten'].startswith('buurtcode BU99990101') for l in r['logboek']), 'CBS: alleen de buurtcode naar buiten')
k = kaart(r, 'Leefbaarheid'); eis(veld(k, 'Oordeel 2024') == 'goed (7 van 9)' and veld(k, 'Door de jaren') == '2020: voldoende → 2022: ruim voldoende → 2024: goed', 'Leefbaarometer: oordeel en trend')
eis(veld(k, 'Overlast en onveiligheid') == '−0,050 (slechter dan gemiddeld)' and veld(k, 'Voorzieningen') == '+0,000 (gemiddeld)', 'Leefbaarometer: dimensies in woorden')
k = kaart(r, 'Hoogte (AHN)'); eis(veld(k, 'Maaiveld rond het adres') == 'ca. 2,5 m NAP' and veld(k, 'Hoogte boven maaiveld') == 'ca. 10,0 m', 'AHN: maaiveld (DTM) en hoogte (DSM − DTM)')
k = kaart(r, 'Bodem'); eis(veld(k, 'Bevoegd gezag bodem') == 'Proefomgevingsdienst' and any(l.get('url') == 'https://bodem.proef.example/' for l in k.get('links', [])), 'Bodemloket: bevoegd gezag + eigen viewer')
k = kaart(r, 'Straatbeeld'); eis(len(k.get('beelden') or []) == 1 and k['beelden'][0]['src'].startswith('data:image/jpeg') and 'proefmaker' in k['beelden'][0]['titel'] and 'Mapillary komt erbij' in (k.get('klein') or ''), 'Panoramax: nabije foto, verre niet; Mapillary zonder sleutel = uitleg')
eis(any('google.com/maps' in (l.get('url') or '') for l in k.get('links', [])) and not any(l['host'] and 'google' in l['host'] for l in r['logboek']), 'Street View: alleen een link, geen aanroep naar Google')
eis(all(k.get('juridisch') for k in r['kaarten'] if k['titel'] in ('Buurtcijfers (CBS)', 'Leefbaarheid (Leefbaarometer)', 'Hoogte (AHN)', 'Bodem (Bodemloket)', 'Straatbeeld')), 'deel 3: elke kaart heeft de juridische regel')
TOK = 'PROEFTOKEN-verzonnen-8813'
r = zoek(ingang='adres', term='Proefstraat 1, 9999 ZZ Nergensdorp', wie='david', vers=True, sleutels={'mapillary': TOK, 'ep_online': TOK + 'e'})
k = kaart(r, 'Straatbeeld'); eis(len(k.get('beelden') or []) == 2 and any('Mapillary' in b['titel'] for b in k['beelden']) and any('pKey=777' in (l.get('url') or '') for l in k.get('links', [])), 'Mapillary met sleutel: foto + link')
eis(any(l['host'] == 'public.ep-online.nl' for l in r['logboek']), 'EP-online: met de sleutel uit de invoer')
k = kaart(r, 'Energielabel'); eis(veld(k, 'Energieklasse') == 'A+' and veld(k, 'Registratiedatum') == '04-03-2024' and veld(k, 'Geldig tot') == '01-02-2034' and veld(k, 'Gebouwtype') == 'Tussenwoning', 'EP-online: nieuwste label met Nederlandse veldnamen en datums')
eis(veld(k, 'Primair fossiel energiegebruik') == '101,5 kWh/m² per jaar (eis ≤ 120)' and veld(k, 'Aandeel hernieuwbare energie') == '31,0 % (eis ≥ 40)' and veld(k, 'Energiebehoefte') == '98,3 kWh/m² per jaar', 'EP-online: eenheden en eisen achter de waarde')
eis(veld(k, 'Gebruiksoppervlakte') == '113 m²' and veld(k, 'Vereenvoudigd label') == 'nee' and veld(k, 'Op basis van een referentiegebouw') == 'ja' and veld(k, 'Compactheid (verliesoppervlak / gebruiksoppervlak)') == '1,62', 'EP-online: oppervlak, ja/nee, compactheid')
eis(all(a[0].isupper() and '_' not in a for a, _ in k['velden']) and not any(a in ('Postcode', 'Huisnummer', 'BAGVerblijfsobjectID', 'BAGPandIDs') for a, _ in k['velden']) and '2 labels' in (k.get('klein') or ''), 'EP-online: geen ruwe API-velden, wel melding meer labels')
eis(not {l['host'] for l in r['logboek']} & {'intern.proef.example', '0x7f.0.0.1'} and sum(1 for l in r['logboek'] if l['host'] == 'foto.proef.example') == 2, 'miniaturen: geen http, interne host of IP-vorm (review-MOET 1)')
# wv2724: vier dichtere Panoramax-foto's verdringen Mapillary niet meer (2 per dienst eerst, dan aanvullen tot 4)
nep3 = dict(nep); nep3['api.panoramax.xyz/api/search'] = {'features': [{'id': 'pd-%d' % i, 'geometry': {'type': 'Point', 'coordinates': [5.1 + 0.00002 * i, 52.1]},
    'properties': {'datetime': '2025-05-05T10:00:00Z', 'geovisio:thumbnail': 'https://foto.proef.example/d%d.jpg' % i}} for i in range(1, 6)]}
nep3['graph.mapillary.com/images'] = {'data': [{'id': '888', 'captured_at': 1730000000000, 'computed_geometry': {'coordinates': [5.1012, 52.1]}, 'thumb_256_url': 'https://foto.proef.example/m8.jpg'}]}
json.dump(nep3, open(os.path.join(T, 'nep.json'), 'w'))
r = zoek(ingang='adres', term='Proefstraat 1, 9999 ZZ Nergensdorp', wie='david', vers=True, sleutels={'mapillary': TOK})
k = kaart(r, 'Straatbeeld'); ls = [l.get('url') or '' for l in k.get('links', [])]
eis(sum(1 for u in ls if 'pKey=888' in u) == 1 and sum(1 for u in ls if 'panoramax' in u) == 3 and any(u.endswith('pd-3') for u in ls) and not any(u.endswith('pd-4') for u in ls), 'straatbeeld: Mapillary verder weg blijft erin naast dichtere Panoramax (2 per dienst, aanvullen tot 4)')
nep2 = dict(nep); nep2['graph.mapillary.com/images'] = {'error': {'message': 'Invalid OAuth 2.0 Access Token', 'code': 190}}
json.dump(nep2, open(os.path.join(T, 'nep.json'), 'w'))
r = zoek(ingang='adres', term='Proefstraat 1, 9999 ZZ Nergensdorp', wie='david', vers=True, sleutels={'mapillary': TOK})
eis('weigerde de sleutel (fout 190)' in (kaart(r, 'Straatbeeld').get('klein') or ''), 'Mapillary: geweigerde sleutel = uitleg met vervangen')
nep2['public.ep-online.nl/api/v5/PandEnergielabel/AdresseerbaarObject'] = {'type': 'https://tools.ietf.org/html/rfc9110#section-15.5.5', 'title': 'Not Found', 'status': 404, 'traceId': '00-proef-01'}
json.dump(nep2, open(os.path.join(T, 'nep.json'), 'w'))
r = zoek(ingang='adres', term='Proefstraat 1, 9999 ZZ Nergensdorp', wie='david', vers=True, sleutels={'ep_online': TOK})
k = kaart(r, 'Energielabel'); eis(not k.get('velden') and 'Geen energielabel' in (k.get('klein') or ''), 'EP-online: 404-antwoord = geen label, geen ruwe velden (gemeten 8-11)')
# wv2723: Google Street View met Davids sleutel — eerst Metadata (gratis), alleen bij OK één foto; weigering = nette melding, geen tweede poging
GK = 'AIzaPROEF-verzonnen-GSV-0000000000000'
def gsv(meta, foto=True):
    n = dict(nep); n['maps.googleapis.com/maps/api/streetview/metadata'] = meta
    if foto: n['maps.googleapis.com/maps/api/streetview'] = 'base64:' + base64.b64encode(b'\xff\xd8\xff\xe0GOOGLEPROEF').decode()
    json.dump(n, open(os.path.join(T, 'nep.json'), 'w'))
    u = zoek(ingang='adres', term='Proefstraat 1, 9999 ZZ Nergensdorp', wie='david', vers=True, sleutels={'google_streetview': GK})
    GSV_UIT.append(json.dumps(u)); return u
GSV_UIT = []
def gl(r, soort): return [l for l in r.get('logboek', []) if l['host'] == 'maps.googleapis.com' and soort in l['bron']]
r = gsv({'status': 'OK', 'date': '2023-06', 'copyright': '© Google', 'pano_id': 'PROEFpano_01', 'location': {'lat': 52.1001, 'lng': 5.1001}})
k = kaart(r, 'Google Street View')
eis(len(gl(r, 'metadata')) == 1 and len(gl(r, 'foto')) == 1, 'Google: status OK = 1 metadata + 1 foto')
eis(len(k.get('beelden') or []) == 1 and k['beelden'][0]['src'].startswith('data:image/jpeg') and veld(k, 'Opgenomen') == '06-2023' and veld(k, 'Foto') == '© Google' and (veld(k, 'Afstand tot het adres') or '').endswith(' m'), 'Google: foto met opnamedatum, afstand en copyright')
eis(any('pano=PROEFpano_01' in (l.get('url') or '') and 'key' not in (l.get('url') or '') for l in k.get('links', [])) and bool(k.get('juridisch')) and '_gsv' not in json.dumps(r), 'Google: link zonder sleutel, juridische regel, geen interne velden')
for st, woord in (('ZERO_RESULTS', 'Geen Google-straatfoto binnen 50 m'), ('REQUEST_DENIED', 'weigerde de sleutel'), ('OVER_QUERY_LIMIT', 'dagplafond')):
    r = gsv({'status': st, 'error_message': 'proef met key=' + GK})
    k = kaart(r, 'Google Street View')
    eis(len(gl(r, 'metadata')) == 1 and not gl(r, 'foto') and woord in (k.get('klein') or '') and not k.get('beelden'), 'Google: %s = melding, geen fotoaanvraag, één metadata-aanroep' % st)
r = gsv({'status': 'OK'}, foto=False)   # foto-antwoord geen JPEG
eis(len(gl(r, 'foto')) == 1 and not kaart(r, 'Google Street View').get('beelden') and 'geen nieuwe poging' in (kaart(r, 'Google Street View').get('klein') or ''), 'Google: geen JPEG terug = melding, geen tweede poging')
_z = subprocess.run([sys.executable, '-I', '-B', '-c', 'import importlib.util as u,sys; s=u.spec_from_file_location("o", sys.argv[1]); o=u.module_from_spec(s); s.loader.exec_module(o); print(o.zonder_sleutel("https://maps.googleapis.com/x?location=1,2&key=" + sys.argv[2] + "&size=1"))', py, GK], capture_output=True, text=True).stdout
eis(GK not in _z and 'key=…&size=1' in _z, 'zonder_sleutel maskeert key= in een URL')
r = zoek(ingang='adres', term='Proefstraat 1, 9999 ZZ Nergensdorp', wie='david', vers=True)
eis(not kaart(r, 'Google Street View') and not any(l['host'] == 'maps.googleapis.com' for l in r['logboek']), 'Google: zonder sleutel geen aanroep en geen kaartje')
r = zoek(ingang='adres', term='Proefstraat 1, 9999 ZZ Nergensdorp', wie='socev', herkomst='david-vraag', beelden=False, sleutels={'google_streetview': GK})
eis(not any(l['host'] == 'maps.googleapis.com' for l in r['logboek']), 'Google: Socev (geen beelden) = geen aanroep, ook met sleutel')
r = zoek(ingang='adres', term='Proefstraat 1, 9999 ZZ Nergensdorp', wie='socev', herkomst='mogelijk-medisch', sleutels={'google_streetview': GK})
eis(not any(l['host'] == 'maps.googleapis.com' and l['status'] != 'poort dicht' for l in r['logboek']), 'Google: poort dicht (herkomst mogelijk medisch) = niets naar Google')
# cache: de Google-foto mag niet in osint.sqlite; een cachetreffer haalt hem opnieuw (in-proces, want NEP zet de cache uit)
sys.dont_write_bytecode = True; import importlib.util as _iu
_s = _iu.spec_from_file_location('osint_toets', py); O = _iu.module_from_spec(_s); _s.loader.exec_module(O)
gk = O.kaartje('Google Street View', 'x', [('Opgenomen', '06-2023')], beelden=[{'src': 'data:image/jpeg;base64,GGG'}], _gsv=[5.1, 52.1])
cv = O.cachevorm([gk, O.kaartje('Straatbeeld', 'y')])
eis('GGG' not in json.dumps(cv) and cv[0].get('_gsv') == [5.1, 52.1] and cv[1]['titel'] == 'Straatbeeld', 'cache: Google-kaartje zonder foto en velden, andere kaartjes ongemoeid')
O.SLEUTELS.clear(); hc = O.herstel_google(O.Ctx('alles', False), cv)
eis([k['titel'] for k in hc] == ['Straatbeeld'], 'cache: zonder beelden valt het Google-kaartje bij een treffer weg')
# review-ZOU 2: het echte cachepad (NEP uit, netwerk vervangen door de verzonnen antwoorden): foto niet in osint.sqlite, treffer haalt opnieuw
FOTO = b'\xff\xd8\xff\xe0GOOGLEPROEF'
gsv({'status': 'OK', 'date': '2023-06', 'pano_id': 'PROEFpano_01', 'location': {'lat': 52.1001, 'lng': 5.1001}})
def nephaal(ctx, bron, url, naar_buiten, soort='extern', binair=False, metcode=False, **_):
    h = O.up.urlsplit(url).hostname
    O.poort_open(ctx, bron, soort, h, naar_buiten)
    x = O.nep_antwoord(url); x = x if x is not None else '{}'
    if binair: x = base64.b64decode(x[7:]) if x.startswith('base64:') else x.encode()
    ctx.log.append({'bron': bron, 'soort': soort, 'host': h, 'naar_buiten': naar_buiten, 'status': '200', 'ms': 0})
    return ('200', x) if metcode else x
O.NEP, O.haal = False, nephaal
c1 = O.zoek({'ingang': 'adres', 'term': 'Proefstraat 7, 9999 ZZ Nergensdorp', 'wie': 'david', 'sleutels': {'google_streetview': GK}})
c2 = O.zoek({'ingang': 'adres', 'term': 'Proefstraat 7, 9999 ZZ Nergensdorp', 'wie': 'david', 'sleutels': {'google_streetview': GK}})
GSV_UIT += [json.dumps(c1), json.dumps(c2)]
k2 = kaart(c2, 'Google Street View'); b64 = base64.b64encode(FOTO).decode()
cdump = '\n'.join(sqlite3.connect(os.environ['OSINT_DB']).iterdump())
eis(not c1['cache'] and c2['cache'] and len(gl(c2, 'metadata')) == 1 and len(gl(c2, 'foto')) == 1 and b64 in json.dumps((k2.get('beelden') or [{}])[0].get('src', '')), 'cache: treffer haalt de Google-foto opnieuw (1 metadata + 1 foto), rest uit de cache')
eis(b64[:16] not in cdump and 'PROEFpano_01' not in cdump and GK not in cdump and 'Proefstraat 7' in cdump, 'cache: de echte cacherij in osint.sqlite heeft geen Google-foto, -velden of sleutel')
eis(all(GK not in u and 'AIzaPROEF' not in u for u in GSV_UIT), 'review-ZOU 1: de Google-sleutel staat in geen enkele uitkomst of logboek (OK, weigeringen, cache)')
json.dump(nep, open(os.path.join(T, 'nep.json'), 'w'))
c = sqlite3.connect(os.environ['OSINT_DB']); dump = '\n'.join(c.iterdump())
eis(TOK not in json.dumps(r) and TOK not in dump and GK not in dump and 'AIzaPROEF' not in dump and 'GOOGLEPROEF' not in dump, 'sleutels (ook Google) en Google-foto niet in de uitkomst of osint.sqlite')
r = zoek(ingang='adres', term='Proefstraat 1, 9999 ZZ Nergensdorp', wie='socev', herkomst='david-vraag', beelden=False)
eis(not any(l['host'] in ('api.panoramax.xyz', 'graph.mapillary.com') for l in r['logboek']) and kaart(r, 'Buurtcijfers (CBS)'), 'Socev (geen beelden): geen straatbeeld, wel buurtcijfers')
DEEL3 = {'opendata.cbs.nl', 'geo.leefbaarometer.nl', 'gis.gdngeoservices.nl', 'api.panoramax.xyz', 'graph.mapillary.com', 'foto.proef.example'}
r = zoek(ingang='adres', term='Proefstraat 1, 9999 ZZ Nergensdorp', wie='socev', herkomst='mogelijk-medisch')
eis(r['poort']['niveau'] == 'eigen' and ext(r) == 0 and not {l['host'] for l in r['logboek'] if l['status'] != 'poort dicht'} & DEEL3, 'poort: adres met herkomst mogelijk medisch → niets naar CBS/LBM/AHN/bodem/straatbeeld')
r = zoek(ingang='adres', term='Proefstraat 1 Nergensdorp 111222333', wie='david', sleutels={'mapillary': TOK})
eis(r['poort']['niveau'] == 'niets' and ext(r) == 0, 'poort: adres met BSN-vorm → nul externe aanroepen (ook deel 3)')
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
# --- wv2712: fotoforensiek (ELA + kloondetectie, lokaal); alleen als Pillow + numpy er zijn (venv osint, of pip in CI)
try:
    import io, numpy as np
    from PIL import Image, ImageFilter
    PIL_OK = True
except ImportError:
    PIL_OK = False
if PIL_OK:
    rng = np.random.default_rng(13)
    im = Image.fromarray((rng.random((60, 80, 3)) * 255).astype(np.uint8)).resize((640, 480), Image.BICUBIC).filter(ImageFilter.GaussianBlur(1))   # verzonnen textuur
    def jpg(x):
        b = io.BytesIO(); x.save(b, 'JPEG', quality=95); return base64.b64encode(b.getvalue()).decode()
    kl = im.copy(); kl.paste(im.crop((60, 60, 220, 180)), (380, 260))
    r = zoek(ingang='bestand', bestand=jpg(kl), naam='betaalbewijs.jpg', wie='david')
    k = kaart(r, 'Fotoforensiek'); eis('twee keer' in (k.get('let') or '') and len(k.get('beelden') or []) == 3 and ext(r) == 0 and r['kern'].get('foto') is True, 'fotoforensiek: kopie gevonden, drie beelden, niets naar buiten')
    eis(veld(k, 'JPEG-kwaliteit (schatting)') == 95, 'fotoforensiek: JPEG-kwaliteit uit de kwantisatietabel')
    r = zoek(ingang='bestand', bestand=jpg(im), naam='foto.jpg', wie='david')
    k = kaart(r, 'Fotoforensiek'); eis(not k.get('let') and r['kern'].get('klonen') == 0 and len(k.get('beelden') or []) == 2, 'fotoforensiek: onbewerkte foto = geen kopie')
    r = zoek(ingang='bestand', bestand=jpg(kl), naam='scan 111222333.jpg', wie='david')
    eis(r['poort']['niveau'] == 'niets' and not kaart(r, 'Fotoforensiek') and not kaart(r, 'Het bestand') and ext(r) == 0, 'fotoforensiek: BSN-vorm in de naam → niets getoond')
    r = zoek(ingang='bestand', bestand=jpg(kl), naam='foto.jpg', wie='socev', herkomst='david-vraag')
    eis(r['poort']['niveau'] == 'niets' and not kaart(r, 'Fotoforensiek'), 'fotoforensiek: alleen voor David (Socev: niets)')
    r = zoek(ingang='bestand', bestand=base64.b64encode(b'%PDF-1.4 proef').decode(), naam='brief.pdf', wie='david')
    eis(not kaart(r, 'Fotoforensiek'), 'fotoforensiek: geen foto (pdf) = geen ELA-kaart')
    b = io.BytesIO(); Image.new('L', (9000, 5000)).save(b, 'PNG')
    r = zoek(ingang='bestand', bestand=base64.b64encode(b.getvalue()).decode(), naam='groot.png', wie='david')
    eis('groter dan 40 megapixel' in json.dumps(kaart(r, 'Fotoforensiek'), ensure_ascii=False) and r['kern'].get('foto') is False, 'fotoforensiek: foto > 40 MP = duidelijke melding, geen knop')
else:
    print('overslaan: Pillow/numpy ontbreken hier (fotoforensiek-toetsen; OSINT_PYTHON=/opt/data/venvs/osint/bin/python)')
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
# --- wv2848: deel 2 registers en archief (verzonnen antwoorden; geen echte personen of bedrijven)
WDE = {'entities': {
    'Q999001': {'labels': {'nl': {'value': 'Proefzorg B.V.'}}, 'descriptions': {'nl': {'value': 'verzonnen zorgorganisatie'}}, 'claims': {
        'P31': [{'mainsnak': {'datavalue': {'value': {'id': 'Q4830453'}}}}], 'P749': [{'mainsnak': {'datavalue': {'value': {'id': 'Q999012'}}}}],
        'P856': [{'mainsnak': {'datavalue': {'value': 'https://proefzorg.example'}}}]}},
    'Q999002': {'labels': {'nl': {'value': 'Piet Proefpersoon'}}, 'descriptions': {'nl': {'value': 'verzonnen politicus'}}, 'claims': {
        'P31': [{'mainsnak': {'datavalue': {'value': {'id': 'Q5'}}}}], 'P39': [{'mainsnak': {'datavalue': {'value': {'id': 'Q999010'}}}}],
        'P102': [{'mainsnak': {'datavalue': {'value': {'id': 'Q999011'}}}}]}},
    'Q999003': {'labels': {'nl': {'value': 'Proefpersoon (band)'}}, 'claims': {'P31': [{'mainsnak': {'datavalue': {'value': {'id': 'Q215380'}}}}]}}}}
DELPHER = ('<?xml version="1.0"?><srw:searchRetrieveResponse xmlns:srw="x"><srw:numberOfRecords>37</srw:numberOfRecords><srw:records><srw:record><srw:recordData>'
           '<dc:date>1931/05/06 00:00:00</dc:date><dc:title>Proefpand verbouwd</dc:title><dc:type>artikel</dc:type><ddd:metadataKey>ddd:000000001:mpeg21:a0001</ddd:metadataKey>'
           '<ddd:papertitle>Proefkrant</ddd:papertitle><ddd:spatial>Regionaal/lokaal</ddd:spatial></srw:recordData></srw:record><srw:record><srw:recordData>'
           '<dc:date>1950/01/02 00:00:00</dc:date><dc:title>Zonder sleutel</dc:title><ddd:metadataKey>javascript:alert(1)</ddd:metadataKey></srw:recordData></srw:record></srw:records></srw:searchRetrieveResponse>')
SRU_TUCHT = 'repository.overheid.nl/sru?' + up.urlencode({'query': 'c.product-area==tuchtrecht AND cql.textAndIndexes="Proefpersoon" sortBy dt.modified/sort.descending'})
nep4 = dict(nep)
nep4.update({
 'zoeken.zorgaanbiedersportaal.nl/api/v1/Organisatie/99999999': {'kvknummer': '99999999', 'naam': 'Proefzorg B.V.', 'agbregistraties': [{'code': '01999999', 'omschrijving': 'Huisartsen'}],
     'rechtsvorm': 'Besloten Vennootschap', 'adres': {'isafgeschermd': False, 'adresRegels': ['Proefstraat 1', '9999 ZZ Nergensdorp']}, 'datumInschrijving': {'jaar': 2020, 'maand': 2, 'dag': 3},
     'datumUitschrijving': None, 'sbicodes': ['Huisartsenzorg (86.21.0)'], 'melding': {'isZorgaanbieder': True, 'isJeugdhulpaanbieder': False},
     'vestigingen': [{'handelsnamen': ['Proefzorg'], 'isHoofdvestiging': True, 'adres': {'isafgeschermd': True}, 'agbregistraties': [{'code': '71999999', 'omschrijving': 'Huisartsen'}]}],
     'verantwoordingen': [{'url': 'https://toezicht.proef.example/', 'tekst': 'Inspectierapportages'}, {'url': 'javascript:alert(1)', 'tekst': 'boos'}]},
 'zoeken.zorgaanbiedersportaal.nl/api/v1/Zoeken': {'aantal': 2, 'zorgaanbieders': [{'kvknummer': '99999999', 'naam': 'Proefzorg B.V.'}, {'kvknummer': '99999998', 'naam': 'Proefzorg Twee'}]},
 'opendata.kvk.nl/api/v1/hvds/basisbedrijfsgegevens/kvknummer/99999999': {'datumAanvang': '20200203', 'actief': 'J', 'insolventieCode': 'FAIL', 'rechtsvormCode': 'BV', 'postcodeRegio': 99,
     'activiteiten': [{'sbiCode': '4791', 'soortActiviteit': 'Nevenactiviteit'}, {'sbiCode': '86210', 'soortActiviteit': 'Hoofdactiviteit'}], 'lidstaat': 'NL'},
 'opendata.kvk.nl/api/v1/hvds/basisbedrijfsgegevens/kvknummer/99999997': {'fout': [{'code': 'IPD0005', 'omschrijving': 'Op basis van het KVK-nummer kan het product niet worden geleverd.'}]},
 'www.wikidata.org/w/api.php?action=query': {'query': {'search': [{'title': 'Q999001'}]}},
 'www.wikidata.org/w/api.php?action=wbsearchentities': {'search': [{'id': 'Q999002'}, {'id': 'Q999003'}]},
 'www.wikidata.org/w/api.php?action=wbgetentities&props=labels|descriptions|claims': WDE,
 'www.wikidata.org/w/api.php?action=wbgetentities&props=labels': {'entities': {'Q999010': {'labels': {'nl': {'value': 'lid van de proefraad'}}},
     'Q999011': {'labels': {'nl': {'value': 'Proefpartij'}}}, 'Q999012': {'labels': {'nl': {'value': 'Proef Moeder N.V.'}}}}},
 SRU_TUCHT: {'searchRetrieveResponse': {'numberOfRecords': 2, 'records': {'record': [
     {'recordData': {'gzd': {'originalData': {'meta': {'owmskern': {'identifier': 'ECLI:NL:TGZPROEF:2024:1', 'creator': 'Regionaal Tuchtcollege voor de Gezondheidszorg Proefstad'},
      'owmsmantel': {'description': 'Verzonnen klacht.'}, 'tpmeta': {'instantieDomein': 'Gezondheidszorg', 'beslissing': 'Ongegrond', 'uitspraakdatum': '2024-01-02'}}},
      'enrichedData': {'preferredUrl': 'https://tuchtrecht.overheid.nl/ECLI:NL:TGZPROEF:2024:1'}}}},
     {'recordData': {'gzd': {'originalData': {'meta': {'owmskern': {'identifier': 'ECLI:NL:TGZPROEF:2026:9', 'creator': 'Centraal Tuchtcollege voor de Gezondheidszorg'},
      'owmsmantel': {}, 'tpmeta': {'instantieDomein': 'Gezondheidszorg', 'beslissing': 'Gegrond, waarschuwing', 'uitspraakdatum': '2026-03-04'}}}, 'enrichedData': {}}}}]}}},
 'jsru.kb.nl/sru/sru': DELPHER,
 'api.openarch.nl/1.0/records/search.json': {'response': {'number_found': 3, 'docs': [{'personname': 'Pieter Proefpersoon', 'relationtype': 'Bruidegom', 'eventtype': 'Huwelijk',
     'eventdate': {'day': 1, 'month': 5, 'year': 1890}, 'eventplace': ['Nergensdorp'], 'sourcetype': 'BS Huwelijk', 'archive': 'Proefarchief', 'url': 'https://www.openarchieven.nl/proef:1'},
     {'personname': 'Anna Proefpersoon', 'eventtype': 'Doop', 'eventdate': {'year': 1801}, 'url': 'https://elders.example/x'}]}},
 'api.hackertarget.com/hostsearch': 'mail.proefzorg.example,192.0.2.10\nwww.proefzorg.example,192.0.2.11\nboos.ander.example,192.0.2.12\n',
 'www.proefzorg.example/contact': '<p>balie@proefzorg.example</p>',
 'www.proefzorg.example/': '<a href="mailto:info@proefzorg.example">info&#64;proefzorg.example</a> ander@elders.example logo@2x.proefzorg.example.png',
 'intern.proefzorg.example/': '<p>geheim@intern.proefzorg.example</p>',
})
json.dump(nep4, open(os.path.join(T, 'nep.json'), 'w'))
json.dump({'intern.proef.example': '10.0.0.5', 'foto.proef.example': '93.184.216.34', 'www.intern.proefzorg.example': '10.0.0.6', 'intern.proefzorg.example': '127.0.0.1'},
          open(os.path.join(T, 'dns.json'), 'w'))
def hosts_van(r, voorvoegsel=''):
    return {l['host'] for l in r.get('logboek', []) if l['soort'] == 'extern' and l['status'] != 'poort dicht' and l['naar_buiten'].startswith(voorvoegsel)}
r = zoek(ingang='bedrijf', term='99999999', wie='david', vers=True)
k = kaart(r, 'Zorgaanbieder (LRZa)')
eis(veld(k, 'AGB-code organisatie') == '01999999 (Huisartsen)' and veld(k, 'Ingeschreven') == '03-02-2020' and veld(k, 'Soort (Wtza-melding)') == 'zorgaanbieder', 'LRZa: AGB-code, inschrijving, Wtza')
eis('afgeschermd · AGB 71999999 (Huisartsen)' == (k.get('items') or [{}])[0].get('sub') and [l['url'] for l in k.get('links', [])] == ['https://toezicht.proef.example/', 'https://zoeken.zorgaanbiedersportaal.nl/'], 'LRZa: vestiging met AGB, afgeschermd adres, alleen https-links')
eis(any(x['id'] == 'agb:71999999' for x in (r.get('graaf') or {}).get('knopen', [])), 'netwerkplaat: KvK → AGB-code')
k = kaart(r, 'KvK open data')
eis(veld(k, 'Faillissement, surseance of schuldsanering') == 'faillissement' and 'faillissement' in (k.get('let') or '') and veld(k, 'Activiteiten (SBI)') == '86210 (hoofd), 4791 (neven)' and veld(k, 'Gestart op') == '03-02-2020', 'KvK open data: faillissement als let, hoofdactiviteit eerst')
k = kaart(r, 'Wikidata'); eis('Proefzorg B.V.' in (k.get('items') or [{}])[0].get('tekst', '') and 'Moederorganisatie: Proef Moeder N.V.' in k['items'][0].get('sub', ''), 'Wikidata op KvK-nummer: organisatie met moeder')
eis(any(l['host'] == 'www.wikidata.org' and l['naar_buiten'] == 'KvK-nummer 99999999' for l in r['logboek']), 'Wikidata: alleen het KvK-nummer naar buiten')
eis(all(kaart(r, t).get('juridisch') for t in ('Zorgaanbieder (LRZa)', 'KvK open data', 'Wikidata')), 'deel 2 bedrijf: juridische regel op elk kaartje')
r = zoek(ingang='bedrijf', term='99999997', wie='david', vers=True)
eis('alleen bv' in (kaart(r, 'KvK open data').get('klein') or ''), 'KvK open data: 404/fout = niet in de dataset (geen bv/nv)')
r = zoek(ingang='bedrijf', term='Proefzorg', wie='david', vers=True)
k = kaart(r, 'Zorgaanbieder (LRZa)'); eis(len(k.get('items') or []) == 2 and 'KvK 99999998' in k['items'][1].get('sub', ''), 'LRZa op naam (David): lijst met KvK-nummers')
eis(not any(l['host'] == 'opendata.kvk.nl' for l in r['logboek']), 'KvK open data: zonder KvK-nummer geen aanroep')
# theHarvester-achtig
r = zoek(ingang='bedrijf', term='proefzorg.example', wie='david', vers=True)
k = kaart(r, 'Subdomeinen en mailadressen'); tk = [i['tekst'] for i in k.get('items', [])]
eis('mail.proefzorg.example' in tk and 'boos.ander.example' not in tk and 'info@proefzorg.example' in tk and 'balie@proefzorg.example' in tk and 'ander@elders.example' not in tk, 'harvester: eigen subdomeinen + mailadressen van het domein, niets van elders')
eis(not any(t.endswith('.png') for t in tk) and k.get('juridisch'), 'harvester: geen afbeeldingsnamen, juridische regel')
r = zoek(ingang='bedrijf', term='intern.proefzorg.example', wie='david', vers=True)
eis(not {l['host'] for l in r['logboek']} & {'intern.proefzorg.example', 'www.intern.proefzorg.example'}, 'harvester: website met een intern adres wordt niet opgehaald')
# persoon (David, met doel)
r = zoek(ingang='persoon', term='P. Proefpersoon', wie='david', doel='waarnemer', vers=True)
k = kaart(r, 'Tuchtrecht'); eis([i['tekst'][:10] for i in k.get('items', [])] == ['04-03-2026', '02-01-2024'] and 'Gegrond, waarschuwing' in k['items'][0].get('sub', '') and 'geanonimiseerd' in (k.get('klein') or ''), 'tuchtrecht: nieuwste eerst, beslissing, anonimisering uitgelegd')
eis(any(l['host'] == 'repository.overheid.nl' and l['naar_buiten'] == 'achternaam: Proefpersoon' for l in r['logboek']), 'tuchtrecht: alleen de achternaam naar buiten')
k = kaart(r, 'Wikidata (publieke functies)'); eis(len(k.get('items') or []) == 1 and 'Functies: lid van de proefraad' in k['items'][0].get('sub', '') and 'Partij: Proefpartij' in k['items'][0]['sub'], 'Wikidata persoon: alleen mensen, met functie en partij')
k = kaart(r, 'Zelf na te kijken'); eis({'https://www.vektis.nl/agb-register/zoeken', 'https://ccbr.rechtspraak.nl/'} <= {l['url'] for l in k.get('links', [])} and not hosts_van(r) & {'www.vektis.nl', 'ccbr.rechtspraak.nl'}, 'AGB en curatele: alleen hulplinks, geen aanroep')
eis(not any(x['soort'] in ('persoon', 'wikidata') for x in (r.get('graaf') or {}).get('knopen', [])), 'persoon: geen personen op de netwerkplaat')
# archief
r = zoek(ingang='archief', term='Proefpersoon Nergensdorp', wie='david', doel='geschiedenis', vers=True)
k = kaart(r, 'Kranten (Delpher)'); it = k.get('items') or []
eis(len(it) == 2 and it[0]['tekst'] == '06-05-1931 · Proefpand verbouwd' and 'identifier=ddd%3A000000001%3Ampeg21%3Aa0001' in it[0].get('url', '') and not it[1].get('url') and '37 artikelen' in (k.get('klein') or ''), 'Delpher: datum, titel, link alleen bij een geldige sleutel')
k = kaart(r, 'Akten (Open Archieven)'); it = k.get('items') or []
eis(it[0]['tekst'] == 'Pieter Proefpersoon · Bruidegom' and '1-5-1890' in it[0].get('sub', '') and it[0].get('url') == 'https://www.openarchieven.nl/proef:1' and not it[1].get('url'), 'Open Archieven: akte met datum; link alleen naar openarchieven.nl')
eis(all(kaart(r, t).get('juridisch') for t in ('Kranten (Delpher)', 'Akten (Open Archieven)')) and r.get('graaf') in (None, {'knopen': [], 'randen': []}), 'archief: juridische regel, geen netwerkplaat-knopen')
# poort (kruisproef): BSN-vorm, medische herkomst, geen doel, Socev zonder Davids vraag → niets naar de nieuwe bronnen
NIEUW = {'zoeken.zorgaanbiedersportaal.nl', 'opendata.kvk.nl', 'www.wikidata.org', 'jsru.kb.nl', 'api.openarch.nl', 'api.hackertarget.com', 'repository.overheid.nl'}
for v, wat in ((dict(ingang='archief', term='Proefpersoon 111222333', wie='david', doel='geschiedenis'), 'archief met BSN-vorm'),
               (dict(ingang='archief', term='Proefpersoon', wie='david'), 'archief zonder doel'),
               (dict(ingang='archief', term='Proefpersoon', wie='socev', herkomst='mogelijk-medisch', doel='geschiedenis'), 'archief door Socev, herkomst mogelijk medisch'),
               (dict(ingang='archief', term='Proefpersoon', wie='machinekamer', herkomst='facturen', doel='geschiedenis'), 'archief door de machinekamer zonder Davids vraag'),
               (dict(ingang='persoon', term='P. Proefpersoon', wie='socev', herkomst='mogelijk-medisch', doel='waarnemer'), 'persoon door Socev, herkomst mogelijk medisch'),
               (dict(ingang='persoon', term='P. Proefpersoon 111222333', wie='david', doel='waarnemer'), 'persoon met BSN-vorm'),
               (dict(ingang='bedrijf', term='99999999 111222333', wie='david'), 'bedrijf met BSN-vorm'),
               (dict(ingang='bedrijf', term='proefzorg.example patiëntnummer 4711', wie='david'), 'domein met patiëntkenmerk')):
    r = zoek(vers=True, **v)
    eis(r['poort']['niveau'] == 'niets' and ext(r) == 0 and not hosts_van(r) & NIEUW, 'poort: %s → niets naar buiten' % wat)
r = zoek(ingang='bedrijf', term='99999999', wie='socev', herkomst='mogelijk-medisch', vers=True)
eis(r['poort']['niveau'] == 'eigen' and ext(r) == 0 and not hosts_van(r) & NIEUW, 'poort: KvK-nummer met herkomst mogelijk medisch → niet naar LRZa/KvK/Wikidata')
r = zoek(ingang='bedrijf', term='P. Proefpersoon', wie='socev', herkomst='facturen', vers=True)
eis(not hosts_van(r, 'naam') & NIEUW, 'Socev + vrije naam: geen naam naar LRZa of Wikidata (review-MOET 1 wv2698)')
r = zoek(ingang='persoon', term='P. Proefpersoon', wie='socev', herkomst='david-vraag', doel='waarnemer', vers=True)
eis(r['poort']['niveau'] == 'alles' and 'repository.overheid.nl' in hosts_van(r) and 'api.hackertarget.com' not in hosts_van(r), 'Socev op Davids vraag: persoon wel naar tuchtrecht, nooit naar HackerTarget')
json.dump(nep, open(os.path.join(T, 'nep.json'), 'w'))
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
