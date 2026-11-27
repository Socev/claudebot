"""wv3085: de gedeelde bronnenlaag voor OVIS Vastgoed (osint.py vastgoed) zonder netwerk. Elke aanroep wordt opgenomen (url + body);
verzonnen antwoorden in de echte vorm (gemeten 14-11-2026 op het openbare voorbeeldadres). Eisen: velden goed uit het antwoord, en naar
buiten gaan alleen nummers en een kaartvak (geen straat, plaats, huisnummer of toevoeging; BRO-middelpunt afgerond), niets in osint.sqlite.
Gebruik: python3 -I test/vastgoed-laag.py <osint.py> <tijdelijke map>"""
import base64, importlib.util, json, os, sys

py, T = sys.argv[1], sys.argv[2]
os.environ.update({'OSINT_NEP_NET': '1', 'OSINT_DB': os.path.join(T, 'db', 'osint.sqlite'), 'VAULT_DIR': os.path.join(T, 'vault')})
spec = importlib.util.spec_from_file_location('osint_vg', py)
O = importlib.util.module_from_spec(spec)
spec.loader.exec_module(O)
fout = []


def eis(ok, wat):
    print(('ok   ' if ok else 'FOUT ') + wat)
    if not ok:
        fout.append(wat)


PNG = 'base64:' + base64.b64encode(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')).decode()


def cpt(lat, lon, bid, diepte, dag):
    return ('<dispatchDocument><CPT_C><brocom:broId>%s</brocom:broId><brocom:standardizedLocation srsName="x"><gml:pos>%s %s</gml:pos></brocom:standardizedLocation>'
            '<finalDepth uom="m">%s</finalDepth><researchReportDate><brocom:date>%s</brocom:date></researchReportDate></CPT_C></dispatchDocument>') % (bid, lat, lon, diepte, dag)


def gmw(lat, lon, bid):
    return ('<dispatchDocument><GMW_C><brocom:broId>%s</brocom:broId><brocom:standardizedLocation srsName="x"><gml:pos>%s %s</gml:pos></brocom:standardizedLocation>'
            '<groundLevelPosition uom="m">10.250</groundLevelPosition><wellConstructionDate><brocom:date>2012-02-20</brocom:date></wellConstructionDate>'
            '<shallowestScreenTopPosition uom="m">8.000</shallowestScreenTopPosition><deepestScreenBottomPosition uom="m">7.000</deepestScreenBottomPosition></GMW_C></dispatchDocument>') % (bid, lat, lon)


NEP = {
    'api.pdok.nl/bzk/locatieserver/search/v3_1/free': {'response': {'docs': [{'weergavenaam': 'Proefstraat 1, 9999ZZ Nergensdorp', 'postcode': '9999ZZ',
        'centroide_rd': 'POINT(194315.783 469449.074)', 'centroide_ll': 'POINT(5.96244217 52.21173368)', 'buurtcode': 'BU02000101', 'buurtnaam': 'Proefbuurt',
        'wijknaam': 'Proefwijk', 'gemeentecode': '0200', 'gemeentenaam': 'Proefgemeente', 'waterschapsnaam': 'Proefwaterschap'}]}},
    'service.pdok.nl/lv/bag/wfs/v2_0': {'features': [{'properties': {'identificatie': '0200010000090244', 'oppervlakte': 123, 'gebruiksdoel': 'woonfunctie',
        'status': 'Verblijfsobject in gebruik', 'bouwjaar': 1985, 'pandidentificatie': '0200100000001088', 'pandstatus': 'Pand in gebruik', 'openbare_ruimte': 'Proefstraat'}}]},
    'api.3dbag.nl/collections/pand/items/NL.IMBAG.Pand.0200100000001088': {'feature': {'CityObjects': {'NL.IMBAG.Pand.0200100000001088': {'attributes': {
        'b3_h_maaiveld': 10.0, 'b3_h_dak_max': 30.0, 'b3_h_dak_min': 12.5, 'b3_h_dak_70p': 25.0, 'b3_h_nok': None, 'b3_dak_type': 'slanted', 'b3_opp_dak_plat': 10.4,
        'b3_opp_dak_schuin': 90.6, 'b3_opp_grond': 80.0, 'b3_volume_lod22': 512.4, 'b3_bouwlagen': 2, 'b3_pw_datum': 2020, 'oorspronkelijkbouwjaar': 1985}}}}},
    'service.pdok.nl/kadaster/ruimtelijke-plannen/wms/v1_0?layers=bestemmingsplangebied': {'features': [
        {'properties': {'naam': 'Proefplan oud', 'identificatie': 'NL.IMRO.9999.oud-vas1', 'datum': '2010-01-01', 'typeplan': 'bestemmingsplan', 'planstatus': 'vastgesteld',
                        'historisch': '0', 'naamoverheid': 'gemeente Proef', 'verwijzingnaartekst': 'https://ruimtelijkeplannen.nl/documents/x/b_x.html,https://ruimtelijkeplannen.nl/documents/x/r_x.html'}},
        {'properties': {'naam': 'Proefplan nieuw', 'identificatie': 'NL.IMRO.9999.nieuw-vas1', 'datum': '2025-09-25', 'typeplan': 'bestemmingsplan', 'planstatus': 'vastgesteld', 'historisch': '0'}},
        {'properties': {'naam': 'Vervallen plan', 'identificatie': 'NL.IMRO.9999.weg-vas1', 'datum': '2000-01-01', 'historisch': '1'}}]},
    'service.pdok.nl/rvo/indicatieve-aandachtsgebieden-funderingsproblematiek/wms/v1_0': {'features': [{'properties': {'legenda': 'Niet kwetsbaar gebied - 0-20 %',
        'fgr': 'Hogere Zandgronden', 'percvoor1970': '0', 'pc6': '9999ZZ'}}]},
    'publiek.broservices.nl/sr/cpt/v1/characteristics/searches': '<x>' + cpt('52.214000000', '5.962000000', 'CPT000000000002', '20.000', '2020-01-01')
        + cpt('52.211800000', '5.962500000', 'CPT000000000001', '15.000', '2022-11-01') + '</x>',
    'publiek.broservices.nl/gm/gmw/v1/characteristics/searches': '<x>' + gmw('52.2125', '5.9625', 'GMW000000000001') + '</x>',
    'opendata.cbs.nl/ODataApi/odata/85773NED/TypedDataSet': {'value': [{'Perioden': '2020JJ00', 'PrijsindexVerkoopprijzen_1': 100.0},
        {'Perioden': '2025JJ00', 'PrijsindexVerkoopprijzen_1': 140.0}, {'Perioden': '2026MM08', 'PrijsindexVerkoopprijzen_1': 149.0},
        {'Perioden': '2026MM09', 'PrijsindexVerkoopprijzen_1': 150.0}, {'Perioden': '2026KW03', 'PrijsindexVerkoopprijzen_1': 1.0}]},
    'api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1/collections/perceel/items': {'features': [{'properties': {'kadastrale_grootte_waarde': 905,
        'soort_grootte_waarde': 'Vastgesteld', 'begin_geldigheid': '2022-09-30T00:00:00Z'}, 'geometry': {'type': 'MultiPolygon',
        'coordinates': [[[[5.962073, 52.211620], [5.962668, 52.211620], [5.962668, 52.212050], [5.962073, 52.211620]]]]}}]},
    'api.pdok.nl/kadaster/bag/ogc/v2/collections/verblijfsobject/items': {'features': [
        {'properties': {'identificatie': '0200010000099991', 'huisnummer': 1, 'toevoeging': '6'}}, {'properties': {'identificatie': '0200010000099992', 'huisnummer': 1, 'toevoeging': '7'}},
        {'properties': {'identificatie': '0200010000099993', 'huisnummer': 2, 'toevoeging': '7'}}], 'links': [{'rel': 'next', 'href': 'https://kwaad.example/volgende'}]},
    'service.pdok.nl/hwh/luchtfotorgb/wms/v1_0': PNG,
    'service.pdok.nl/kadaster/kadastralekaart/wms/v5_0': PNG,
}
json.dump(NEP, open(os.path.join(T, 'nep.json'), 'w'))
os.environ['OSINT_NEP_ANTWOORD'] = os.path.join(T, 'nep.json')
GEZIEN = []
_haal = O.haal


FAAL = set()   # stukjes url waarvoor de bron "uitvalt" (time-out)


def opname(ctx, bron, url, naar_buiten, *a, **k):
    GEZIEN.append({'url': url, 'data': k.get('data'), 'naar': naar_buiten, 'bron': bron})
    if any(x in url for x in FAAL):
        ctx.log.append({'bron': bron, 'soort': 'extern', 'host': 'x', 'naar_buiten': naar_buiten, 'status': 'time-out', 'ms': 0})
        raise TimeoutError('timed out')
    return _haal(ctx, bron, url, naar_buiten, *a, **k)


O.haal = opname

# 1. de woning: alleen BAG-nummer en percelen
u = O.vastgoed({'objecten': [{'id': 1, 'vbo': ['0200010000090244'], 'percelen': [{'gemeente': 'Apeldoorn', 'sectie': 'U', 'nummer': '9833'}]}], 'beelden': True})
o = u['objecten'][0]
f = {(x['rubriek'], x['veld']): x for x in o['feiten']}
w = lambda r, v: (f.get((r, v)) or {}).get('waarde')
eis(u['ok'] is True and o['id'] == 1, 'vastgoed geeft ok en het object terug')
eis(w('bouw', 'Bouwjaar') == '1985' and w('bouw', 'BAG-nummer pand') == '0200100000001088', 'BAG: bouwjaar en pandnummer')
eis(w('bouw', 'Hoogste punt dak boven maaiveld') == '20,0 m' and f[('bouw', 'Hoogste punt dak boven maaiveld')]['peildatum'] == '2020', '3D-BAG: dakhoogte boven maaiveld, jaar van de hoogtemeting')
eis(w('bouw', 'Inhoud (model)') == '512 m³' and w('bouw', 'Daktype') == 'schuin' and ('bouw', 'Nokhoogte boven maaiveld') not in f, '3D-BAG: inhoud, daktype; lege nok weg')
eis('CC BY 4.0' in f[('bouw', 'Inhoud (model)')]['licentie'], '3D-BAG: licentie CC BY 4.0 bij het feit')
plannen = [x for x in o['feiten'] if x.get('soort') == 'plan']
eis([x['veld'] for x in plannen] == ['Proefplan nieuw', 'Proefplan oud'], 'plangebied: nieuwste eerst, historisch plan weg')
eis(plannen[1]['url'] == 'https://ruimtelijkeplannen.nl/documents/x/r_x.html', 'plangebied: link naar de regels')
eis(w('grond', 'Funderingskaart') == 'Niet kwetsbaar gebied - 0-20 %' and w('grond', 'Bodem in het postcodegebied') == 'Hogere Zandgronden', 'funderingskaart: legenda en bodem')
eis(w('grond', 'Sonderingen binnen 500 m') == '2' and w('grond', 'Grondwaterputten binnen 1 km') == '1', 'BRO: aantallen')
son = [x['veld'] for x in o['feiten'] if x['veld'].startswith('Sondering ')]
eis(son == ['Sondering CPT000000000001', 'Sondering CPT000000000002'], 'BRO: dichtstbijzijnde sondering eerst')
eis('diepte 15,0 m' in w('grond', 'Sondering CPT000000000001') and 'onderzoek 01-11-2022' in w('grond', 'Sondering CPT000000000001'), 'BRO: diepte en datum')
eis('filter 8,0 tot 7,0 m NAP' in w('grond', 'Grondwaterput GMW000000000001'), 'BRO: filterdiepte put')
eis(w('grond', 'Perceel Apeldoorn U 9833: grootte') == '905 m²', 'kadastrale kaart op nummer: grootte')
eis(w('regels', 'Buurt') == 'Proefbuurt', 'Locatieserver op nummer: buurt')
eis(u['prijsindex']['jaren'] == {'2020': 100.0, '2025': 140.0} and u['prijsindex']['laatste'] == ['2026-09', 150.0], 'CBS-prijsindex: jaren en laatste maand (kwartaal genegeerd)')
eis([b['soort'] for b in o['beelden']][:1] == ['luchtfoto'] and len(o['beelden'][0]['over']) >= 1 and any(b['soort'] == 'tijd' for b in o['beelden']), 'kaartbeelden: luchtfoto met perceel, tijdmachine')
eis(o['punt'] and abs(o['punt']['rd'][0] - 194315.8) < 0.5, 'punt in RD uit de Locatieserver')
x, y = O.wgs84_naar_rd(5.96244217, 52.21173368)
eis(abs(x - 194315.783) < 2 and abs(y - 469449.074) < 2, 'WGS84 → RD binnen 2 m (gemeten punt)')
# lek: niets van het adres naar buiten; BRO-middelpunt afgerond; alle aanroepen gelogd
alles = json.dumps([(g['url'], g['data']) for g in GEZIEN])
eis(not any(t in alles for t in ('Proefstraat', 'Nergensdorp', '9999ZZ Ner', 'huisnummer', 'toevoeging')), 'lek: geen straat, plaats, huisnummer of toevoeging in een url of body')
bro = [g['data'] for g in GEZIEN if 'broservices' in g['url']]
eis(bro and all(d['area']['enclosingCircle']['center'] == {'lat': 52.212, 'lon': 5.962} for d in bro), 'BRO: middelpunt afgerond op 3 decimalen (± 100 m)')
sru = [g for g in GEZIEN if 'repository.overheid.nl' in g['url']]
eis(sru and all('9999ZZ' in g['url'] and 'Proefstraat' not in g['url'] for g in sru), 'bekendmakingen: postcodegebied, geen straat')
eis(len(u['aanroepen']) == len(GEZIEN) and all(a['naar_buiten'] for a in u['aanroepen']), 'elke aanroep staat in het logboek met wat er naar buiten ging')
eis(not os.path.exists(os.environ['OSINT_DB']), 'niets in osint.sqlite')
eis(o['groepen'] and all(o['groepen'].values()) and {'ls', 'bag', '3dbag', 'perceel', 'ahn', 'bodem', 'fundering', 'plannen', 'bro', 'cbs', 'lbm', 'sru'} <= set(o['groepen']), 'elke bron als groep, allemaal gelukt: ' + json.dumps(o['groepen']))
eis(all(x.get('groep') in o['groepen'] for x in o['feiten']), 'elk feit hoort bij een groep')
# een bron die uitvalt: alleen die groep mislukt, zijn feiten ontbreken, de rest gaat door (review MOET 3)
FAAL.add('api.3dbag.nl'); FAAL.add('broservices.nl/gm/')
u1b = O.vastgoed({'objecten': [{'id': 1, 'vbo': ['0200010000090244'], 'percelen': [{'gemeente': 'Apeldoorn', 'sectie': 'U', 'nummer': '9833'}]}], 'beelden': False, 'index': False})
g = u1b['objecten'][0]['groepen']
eis(g.get('3dbag') is False and g.get('bro') is False and g.get('bag') is True and g.get('plannen') is True, '3D-BAG en BRO vallen uit: alleen die groepen mislukt ' + json.dumps(g))
eis(not any(x['groep'] in ('3dbag',) for x in u1b['objecten'][0]['feiten']), 'geen feiten van een uitgevallen 3D-BAG')
FAAL.clear()

# 2. een box zonder BAG-nummer: het nummer zoeken in het vak van het complexperceel; huisnummer en toevoeging blijven hier
GEZIEN.clear()
u2 = O.vastgoed({'objecten': [{'id': 2, 'vbo': [], 'percelen': [{'gemeente': 'Apeldoorn', 'sectie': 'U', 'nummer': '9833'}], 'zoek': {'huisnummer': '1', 'toevoeging': '7'}}],
                 'beelden': False, 'index': False})
o2 = u2['objecten'][0]
eis(o2['gevonden'] == {'fout': True} and not o2['gevonden'].get('vbo'), 'BAG-vak: volgende pagina naar een andere host = niet te zeggen (geen "geen nummer")')
eis(not any('kwaad.example' in g['url'] for g in GEZIEN), 'BAG-vak: een volgende-link naar een andere host wordt niet gevolgd')
nep2 = dict(NEP); nep2['api.pdok.nl/kadaster/bag/ogc/v2/collections/verblijfsobject/items'] = dict(NEP['api.pdok.nl/kadaster/bag/ogc/v2/collections/verblijfsobject/items'], links=[])
json.dump(nep2, open(os.path.join(T, 'nep.json'), 'w'))
u2 = O.vastgoed({'objecten': [{'id': 2, 'vbo': [], 'percelen': [{'gemeente': 'Apeldoorn', 'sectie': 'U', 'nummer': '9833'}], 'zoek': {'huisnummer': '1', 'toevoeging': '7'}}],
                 'beelden': False, 'index': False})
o2 = u2['objecten'][0]
eis(o2['gevonden'].get('raak') == 1 and o2['gevonden'].get('vbo') == '0200010000099992' and o2['gevonden'].get('in_vak') == 3, 'box: precies één verblijfsobject met dit huisnummer en deze toevoeging')
FAAL.add('kadaster/bag/ogc')
u2c = O.vastgoed({'objecten': [{'id': 2, 'vbo': [], 'percelen': [{'gemeente': 'Apeldoorn', 'sectie': 'U', 'nummer': '9833'}], 'zoek': {'huisnummer': '1', 'toevoeging': '7'}}], 'beelden': False, 'index': False})
eis(u2c['objecten'][0]['gevonden'] == {'fout': True}, 'BAG-vak valt uit: niet te zeggen, niet "geen eigen nummer" (review MOET 2)')
FAAL.clear()
eis(not any(t in json.dumps([(g['url'], g['data']) for g in GEZIEN]) for t in ('huisnummer', 'toevoeging')), 'box: zoeksleutel niet naar buiten')
eis(u2['prijsindex'] is None and o2['beelden'] == [], 'index en beelden alleen op verzoek')
# 3. rommel in de invoer valt weg vóór er iets naar buiten gaat
GEZIEN.clear()
u3 = O.vastgoed({'objecten': [{'id': 3, 'vbo': ['Proefstraat 1'], 'pand': ['x'], 'percelen': [{'gemeente': 'Proef<script>', 'sectie': 'U', 'nummer': '1'}]}], 'beelden': False, 'index': False})
eis(GEZIEN == [] and u3['objecten'][0]['feiten'] == [], 'een adres of rommel in plaats van een nummer: geen aanroep')
# 4. wv4226 buurtwachter: straal rond een afgerond punt en de plannen van de gemeente; verzonnen records in de vorm van het SRU-antwoord (27-11-2026)
def rec(ident, titel, rubriek, dag):
    return {'recordData': {'gzd': {'originalData': {'meta': {'owmskern': {'identifier': ident, 'title': titel, 'type': [{'scheme': 'OVERHEIDgvop.Informatietype', '$': 'Beschikkingen'},
        {'scheme': 'OVERHEIDop.Rubriek', '$': rubriek}]}, 'owmsmantel': {'available': dag}, 'tpmeta': {'publicatienaam': 'Gemeenteblad'}}},
        'enrichedData': {'preferredUrl': 'https://zoek.officielebekendmakingen.nl/%s.html' % ident}}}}
SRU = {'searchRetrieveResponse': {'numberOfRecords': 4, 'records': {'record': [rec('gmb-2026-100001', 'Aanvraag omgevingsvergunning Proeflaan 3, dakkapel', 'omgevingsvergunning', '2026-11-20'),
    rec('gmb-2026-100002', 'Verkeersbesluit Proeflaan', 'verkeersbesluit of -mededeling', '2026-11-19'), rec('gmb-2026-100003', 'Omgevingsplan Proefdorp, wijziging', 'ruimtelijk plan of omgevingsdocument', '2026-11-18'),
    rec('kwaad; drop', 'rommel', 'omgevingsvergunning', '2026-11-17')]}}}
nep4 = dict(NEP); nep4['repository.overheid.nl/sru'] = SRU
json.dump(nep4, open(os.path.join(T, 'nep.json'), 'w'))
GEZIEN.clear()
u4 = O.vastgoed({'buurt': {'rd': [194315.8, 469449.1], 'km': 0.25, 'gemeente': 'Proefgemeente', 'sinds': '2026-11-01'}})
b4 = u4.get('buurt') or {}
eis(u4['ok'] is True and b4.get('straal', {}).get('ok') is True and b4.get('gemeente', {}).get('ok') is True, 'buurt: beide vragen gelukt')
eis([i['id'] for i in b4['straal']['items']] == ['gmb-2026-100001', 'gmb-2026-100003'], 'buurt straal: vergunning en plan, geen verkeersbesluit, geen rommel-id')
eis([i['id'] for i in b4['gemeente']['items']] == ['gmb-2026-100003'], 'buurt gemeente: alleen de plan-rubriek')
eis(b4['straal']['items'][0]['url'] == 'https://zoek.officielebekendmakingen.nl/gmb-2026-100001.html' and b4['straal']['items'][0]['datum'] == '2026-11-20', 'buurt: link en datum')
qs = [up_q for up_q in (__import__('urllib.parse').parse.parse_qs(__import__('urllib.parse').parse.urlsplit(g['url']).query).get('query', [''])[0] for g in GEZIEN)]
eis(len(qs) == 2 and 'within/rijksdriehoek "194300 469400 0.250"' in qs[0] and 'dt.available>=2026-11-01' in qs[0] and 'sortBy dt.available/sort.descending' in qs[0],
    'buurt: punt afgerond op 100 m, straal 250 m, sinds, nieuwste eerst')
eis('dt.creator=="Proefgemeente"' in qs[1] and 'ruimtelijk plan of omgevingsdocument' in qs[1], 'buurt: gemeente + plan-rubriek')
eis(not any(t in json.dumps(qs) for t in ('194315', '469449', 'Proefstraat')), 'buurt: geen exact punt of straat naar buiten')
eis(len(u4['aanroepen']) == 2 and all(a['naar_buiten'] for a in u4['aanroepen']), 'buurt: beide aanroepen gelogd')
nep4['repository.overheid.nl/sru'] = {'searchRetrieveResponse': {'diagnostics': {'diagnostic': {'message': 'fout'}}}}
json.dump(nep4, open(os.path.join(T, 'nep.json'), 'w'))
b5 = O.vastgoed({'buurt': {'rd': [194315.8, 469449.1], 'gemeente': 'Proefgemeente'}})['buurt']
eis(b5['straal']['ok'] is False and b5['gemeente']['ok'] is False and not b5['straal']['items'], 'buurt: een diagnose van de SRU = mislukt, geen lege meting')
FAAL.add('repository.overheid.nl')
b6 = O.vastgoed({'buurt': {'rd': [194315.8, 469449.1]}})['buurt']
eis(b6['straal']['ok'] is False and 'gemeente' not in b6, 'buurt: time-out = mislukt; zonder gemeente geen gemeentevraag')
FAAL.clear()
GEZIEN.clear()
b7 = O.vastgoed({'buurt': {'rd': ['Proefstraat', 1], 'gemeente': 'x<script>'}})['buurt']
eis(GEZIEN == [] and b7 == {}, 'buurt: rommel als punt of gemeente = geen aanroep')
json.dump(NEP, open(os.path.join(T, 'nep.json'), 'w'))
print('vastgoed-laag: %d fout' % len(fout))
sys.exit(1 if fout else 0)
