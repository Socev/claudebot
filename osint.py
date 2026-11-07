#!/usr/bin/env python3
"""osint.py — OVIS OSINT v1, de bronnenlaag (wv2694, 7-11-2026; ontwerp 01_Ontwikkeling/OVIS OSINT … (ontwerp 7-11-2026).md § 4–5).

Eén zoekvraag = ingang (adres | bedrijf | telefoon | persoon | auto) + zoekterm + doel + wie (david | socev | machinekamer) + herkomst.
Per bron één functie; elke aanroep loopt via haal(), en haal() vraagt bij een EXTERNE bron eerst de centrale poort (review-MOET 1):
  vorm     BSN (elfproef), HIS-/patiëntnummer, patiëntwoord, of een kenmerk van de bestaande patiëntpoort (intake/patientpoort.js)
           → helemaal niets: geen externe én geen eigen bron, alleen de offline nummerduiding.
  herkomst wie=david (App) telt als Davids eigen invoer; Socev moet een niet-medische herkomst noemen (david-vraag, facturen,
           kvk, contacten-organisatie). Zonder of met een andere herkomst (mail, intake, mogelijk-medisch, …) → alleen offline en
           eigen bronnen (Facturen, Contacten, mail, vault).
  persoon  alleen met een doel; Socev alleen met herkomst david-vraag (persoonsingang nooit uit zichzelf).
Opslag: osint.sqlite (0600, map 0700): cache 30 dagen, logboek (zoekvraag + aanroep: wie, doel, ingang, zoekterm, bron, wat ging
naar buiten) 1 jaar. Niets wordt gepubliceerd; naar buiten gaat alleen de zoekterm (of een kaartvak/BAG-id) naar de gekozen bron.

Gebruik: echo '<json>' | osint.py zoek      → JSON met kaartjes + logboek van deze vraag
         osint.py logboek [n]                → de laatste n zoekvragen met hun aanroepen
         osint.py info                       → aantallen (voor /health), zonder zoektermen
Omgeving: OSINT_DB, PORT, API_SECRET (Facturen via /smal/facturen), SUPABASE_RPC_CONTACTEN, N8N_WEBHOOK_AGENDA_API (mail_zoeken),
OSINT_NEP_NET=1 (toets: elke netwerkaanroep geeft een nepantwoord en telt alleen mee in het logboek).
"""
import base64, concurrent.futures as cf, datetime, hashlib, html, json, os, re, sqlite3, subprocess, sys, time, unicodedata
import urllib.parse as up, urllib.request, urllib.error

VERSIE = 'osint-1'
HIER = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get('OSINT_DB') or '/opt/data/osint/osint.sqlite'
VAULT = os.environ.get('VAULT_DIR') or '/opt/data/AI_SecondBrain'
WEBHOOKS = os.environ.get('OSINT_WEBHOOKS') or '/opt/data/bin/socev-webhooks.txt'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36 OVIS-OSINT/1'
CACHE_DAGEN, LOG_DAGEN = 30, 365
NEP = os.environ.get('OSINT_NEP_NET') == '1'

INGANGEN = ('adres', 'bedrijf', 'telefoon', 'persoon')
DOELEN = {'leverancier': 'leverancier controleren', 'waarnemer': 'waarnemer of sollicitant verifiëren', 'beller': 'beller duiden',
          'pand': 'pand of adres', 'anders': 'anders'}
DOEL_STANDAARD = {'adres': 'pand', 'bedrijf': 'leverancier', 'telefoon': 'beller'}
HERKOMST_EXTERN_OK = {'david', 'david-vraag', 'facturen', 'kvk', 'contacten-organisatie'}
WIE = ('david', 'socev', 'machinekamer')


class PoortDicht(Exception):
    pass


# ---------------------------------------------------------------- poort
_BSN_RE = re.compile(r'(?<!\d)(?<!\d[ .,/-])\d(?:[ .,/-]?\d){8}(?![ .,/-]?\d)')
_PAT_RE = re.compile(r'(pati[eë]nt|cli[eë]nt|\bpat\.?\s?nr|\bhis[- ]?(nummer|nr)|dossiernummer|zorgdomein|promedico|\bbsn\b|burgerservicenummer)', re.I)


def elfproef(c):
    if not re.fullmatch(r'\d{9}', c) or set(c) == {'0'}:
        return False
    return (sum(int(c[i]) * (9 - i) for i in range(8)) - int(c[8])) % 11 == 0


def norm(t):
    t = ''.join(ch for ch in str(t or '') if unicodedata.category(ch) != 'Cf')
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', t)).strip()


def patientpoort_soorten(term):
    """Bestaande patiëntpoort (intake/patientpoort.js, patientpoort-2.0) op de zoekterm; None = niet te bepalen (fail-closed)."""
    p = os.path.join(HIER, 'intake', 'patientpoort.js')
    js = ("const P=require(process.argv[1]);let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{"
          "const b=P.beoordeel({teksten:[s]},{eigen:P.maakEigen(null,{})});process.stdout.write(JSON.stringify((b&&b.soorten)||null))})")
    try:
        r = subprocess.run(['node', '-e', js, p], input=term, capture_output=True, text=True, timeout=20)
        s = json.loads(r.stdout or 'null')
        return s if isinstance(s, list) else None
    except Exception:
        return None


def poort(term, wie, herkomst, ingang, doel):
    """→ dict(niveau='alles'|'eigen'|'niets', reden). niets = alleen offline; eigen = offline + eigen bronnen; alles = ook extern."""
    t = norm(term)
    if any(elfproef(re.sub(r'\D', '', m.group(0))) for m in _BSN_RE.finditer(t)):
        return {'niveau': 'niets', 'reden': 'vorm: BSN-achtig getal (elfproef)'}
    if _PAT_RE.search(t):
        return {'niveau': 'niets', 'reden': 'vorm: patiënt- of HIS-kenmerk'}
    s = patientpoort_soorten(t)
    if s is None:
        return {'niveau': 'niets', 'reden': 'vorm: patiëntpoort niet te bepalen (dicht)'}
    if s:
        return {'niveau': 'niets', 'reden': 'vorm: patiëntpoort ziet ' + ', '.join(sorted(set(map(str, s))))}
    if ingang == 'persoon':
        if doel not in DOELEN:
            return {'niveau': 'niets', 'reden': 'persoon zonder doel'}
        if wie == 'socev' and herkomst != 'david-vraag':
            return {'niveau': 'niets', 'reden': 'persoon alleen op Davids vraag'}
    if wie == 'david':
        return {'niveau': 'alles', 'reden': 'Davids eigen invoer'}
    if herkomst in HERKOMST_EXTERN_OK:
        return {'niveau': 'alles', 'reden': 'herkomst ' + herkomst}
    return {'niveau': 'eigen', 'reden': 'herkomst ' + (herkomst or 'onbekend') + ': alleen offline en eigen bronnen'}


# ---------------------------------------------------------------- opslag
def db():
    os.umask(0o077)
    os.makedirs(os.path.dirname(DB), mode=0o700, exist_ok=True)
    c = sqlite3.connect(DB, timeout=10)
    try:
        os.chmod(DB, 0o600)
    except OSError:
        pass
    c.executescript('''
      create table if not exists zoekvraag(id integer primary key, tijd text not null, wie text not null, doel text, doel_tekst text,
        ingang text not null, term text not null, herkomst text, poort text, poort_reden text, uitkomst text, cache integer default 0);
      create table if not exists aanroep(id integer primary key, zoek_id integer not null, tijd text not null, bron text not null,
        soort text not null, host text, naar_buiten text, status text, ms integer);
      create table if not exists cache(sleutel text primary key, tijd text not null, json text not null);
      create index if not exists aanroep_zoek on aanroep(zoek_id);''')
    nu = datetime.datetime.now(datetime.timezone.utc)
    c.execute('delete from cache where tijd < ?', ((nu - datetime.timedelta(days=CACHE_DAGEN)).isoformat(),))
    oud = (nu - datetime.timedelta(days=LOG_DAGEN)).isoformat()
    c.execute('delete from aanroep where zoek_id in (select id from zoekvraag where tijd < ?)', (oud,))
    c.execute('delete from zoekvraag where tijd < ?', (oud,))
    c.commit()
    return c


def nu_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


def nu_nl():
    try:
        from zoneinfo import ZoneInfo
        return datetime.datetime.now(ZoneInfo('Europe/Amsterdam')).strftime('%d-%m-%Y %H:%M')
    except Exception:
        return datetime.datetime.now().strftime('%d-%m-%Y %H:%M')


# ---------------------------------------------------------------- netwerk (alles via haal)
class Ctx:
    def __init__(self, niveau, beelden=True):
        self.niveau = niveau
        self.beelden = beelden   # False (Socev): geen kaartbeelden ophalen, dus ook geen kaartvak naar buiten
        self.log = []   # dicts: bron, soort, host, naar_buiten, status, ms


def haal(ctx, bron, url, naar_buiten, soort='extern', data=None, hdr=None, timeout=25, binair=False, maxb=4_000_000):
    """De enige weg naar het netwerk. soort extern = buiten ons systeem; eigen = eigen pod/n8n. De poort zit hier."""
    if soort == 'extern' and ctx.niveau != 'alles' or soort == 'eigen' and ctx.niveau == 'niets':
        ctx.log.append({'bron': bron, 'soort': soort, 'host': up.urlsplit(url).hostname, 'naar_buiten': 'niets (poort dicht)',
                        'status': 'poort dicht', 'ms': 0})
        raise PoortDicht(bron)
    t = time.time()
    status = 'fout'
    try:
        if NEP:
            status = 'nep'
            return b'' if binair else '{}'
        h = {'User-Agent': UA, 'Accept': '*/*'}
        h.update(hdr or {})
        body = None
        if data is not None:
            body = data if isinstance(data, bytes) else json.dumps(data).encode()
            h.setdefault('Content-Type', 'application/json')
        rq = urllib.request.Request(url, body, h)
        try:
            with urllib.request.urlopen(rq, timeout=timeout) as r:
                b = r.read(maxb)
                status = str(r.status)
        except urllib.error.HTTPError as e:
            status = str(e.code)
            b = e.read(maxb)
        except Exception as e:
            status = 'time-out' if 'timed out' in str(e) else 'fout'
            raise
        return b if binair else b.decode('utf-8', 'replace')
    finally:
        ctx.log.append({'bron': bron, 'soort': soort, 'host': up.urlsplit(url).hostname, 'naar_buiten': naar_buiten, 'status': status,
                        'ms': int((time.time() - t) * 1000)})


def jhaal(ctx, *a, **k):
    try:
        return json.loads(haal(ctx, *a, **k) or 'null')
    except PoortDicht:
        raise
    except Exception:
        return None


def webhook(naam):
    try:
        for l in open(WEBHOOKS):
            p = l.split()
            if len(p) > 1 and p[0] == naam:
                return p[1]
    except OSError:
        pass
    return None


def kaartje(titel, bron, velden=None, **x):
    k = {'titel': titel, 'bron': bron, 'opgehaald': nu_nl(), 'velden': [[a, b] for a, b in (velden or []) if b not in (None, '', [])]}
    k.update({a: b for a, b in x.items() if b not in (None, '', [])})
    return k


def melding(titel, tekst, bron='OVIS OSINT'):
    return kaartje(titel, bron, klein=tekst)


def tekst_van(h):
    h = re.sub(r'(?s)<(script|style)[^>]*>.*?</\1>', ' ', h)
    t = html.unescape(re.sub('<[^>]+>', ' | ', h))
    return re.sub(r'\s+', ' ', re.sub(r'(\s*\|\s*)+', ' | ', t))


def veld(t, naam, n=1):
    m = re.search(re.escape(naam) + r' \| ((?:[^|]+\| ){%d})' % n, t)
    return ' '.join(x.strip() for x in m.group(1).split('|') if x.strip()) if m else None


def datum_nl(s):
    m = re.match(r'(\d{4})-?(\d{2})-?(\d{2})', str(s or ''))
    return '%s-%s-%s' % (m.group(3), m.group(2), m.group(1)) if m else None


# ---------------------------------------------------------------- eigen bronnen
def facturen_hoe(ctx, tekst):
    """Facturen-app (eigen, blijft op de pod) via /smal/facturen opdracht hoe."""
    geheim = os.environ.get('API_SECRET') or os.environ.get('SOCEV_AGENT_SLEUTEL')
    if not geheim:
        return None
    r = jhaal(ctx, 'Facturen-app (eigen)', 'http://127.0.0.1:%s/smal/facturen' % os.environ.get('PORT', '8080'), 'niets (binnen de pod)',
              soort='eigen', data={'opdracht': 'hoe', 'tekst': tekst, 'secret': geheim}, timeout=60)
    if not isinstance(r, dict):
        return None
    d = r.get('data') if isinstance(r.get('data'), dict) else r
    return d.get('profielen') if isinstance(d, dict) else None


def contacten(ctx, q, limiet=5):
    url, geheim = webhook('contacten-zoek'), os.environ.get('SUPABASE_RPC_CONTACTEN')
    if not url or not geheim:
        return None
    a = jhaal(ctx, 'Google Contacts (eigen)', url, 'zoekterm, binnen eigen systeem', soort='eigen',
              data={'secret': geheim, 'q': q, 'limiet': limiet}, timeout=20)
    return a.get('treffers', []) if isinstance(a, dict) else None


def contacten_kaartje(tr, q):
    if tr is None:
        return melding('In je contacten', 'Contacten niet bereikbaar (webhook of sleutel ontbreekt).', 'Davids Google Contacts')
    if not tr:
        return kaartje('In je contacten', 'Davids Google Contacts', klein='Niet in je contacten.')
    return kaartje('In je contacten', 'Davids Google Contacts', lijst=[' · '.join(x for x in (
        t.get('weergavenaam'), t.get('organisatie'), t.get('functie'), t.get('telefoon_primair'), t.get('email_primair')) if x) for t in tr[:5]])


def mail_zoeken(ctx, query, maxn=10):
    url, geheim = webhook('agenda-wachter-api'), os.environ.get('N8N_WEBHOOK_AGENDA_API')
    if not url or not geheim:
        return None
    a = jhaal(ctx, 'Davids mail (eigen, lees-luik)', url, 'zoekterm, binnen eigen systeem', soort='eigen',
              data={'secret': geheim, 'actie': 'mail_zoeken', 'query': query, 'max': maxn, 'timeoutMs': 14000}, timeout=20)
    if isinstance(a, dict):
        a = a.get('mails') or a.get('resultaten') or a.get('data') or []
    return a if isinstance(a, list) else None


def mail_kaartje(m):
    if m is None:
        return melding('In je mail', 'Mail niet bereikbaar.', 'Davids mail')
    if not m:
        return kaartje('In je mail', 'Davids mail (privé-Gmail)', klein='Geen mail gevonden.')
    return kaartje('In je mail', 'Davids mail (privé-Gmail)', lijst=['%s · %s · %s' % (x.get('dag_lokaal') or str(x.get('datum', ''))[:10],
                   x.get('van', ''), x.get('onderwerp', '')) for x in m[:8] if isinstance(x, dict)])


def persoonspaginas(naam):
    """OVIS-persoonspagina's (vault, lokaal): bestandsnaam bevat alle woorden van de zoekterm en de pagina heeft type: persoon."""
    woorden = [w for w in re.findall(r'[\w-]+', norm(naam).lower()) if len(w) > 1 and w not in ('van', 'de', 'der', 'den', 'het', 'ten', 'ter')]
    if not woorden:
        return []
    uit = []
    for top in ('10_Zakelijk', '20_Prive', '40_Kennisbronnen', '50_Onderzoek'):
        for d, sub, fs in os.walk(os.path.join(VAULT, top)):
            sub[:] = [s for s in sub if not s.startswith('.')]
            for f in fs:
                if not f.endswith('.md') or not all(w in f.lower() for w in woorden):
                    continue
                p = os.path.join(d, f)
                try:
                    with open(p, encoding='utf-8', errors='replace') as fh:
                        kop = fh.read(1500)
                except OSError:
                    continue
                if re.search(r'^type:\s*persoon\b', kop, re.M):
                    uit.append(os.path.relpath(p, VAULT)[:-3])
                if len(uit) >= 8:
                    return uit
    return uit


# ---------------------------------------------------------------- adres
WMS = {'top10nl': ('https://service.pdok.nl/brt/top10nl/wms/v1_0', 'top10nl', 'image/png', 'PDOK TOP10NL-kaart'),
       'pand': ('https://service.pdok.nl/lv/bag/wms/v2_0', 'pand', 'image/png', 'BAG-kaartlaag'),
       'foto': ('https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0', 'Actueel_orthoHR', 'image/jpeg', 'PDOK luchtfoto')}
JAREN = [('2016', '2016_ortho25'), ('2019', '2019_ortho25'), ('2022', '2022_orthoHR'), ('2026', '2026_orthoHR')]
BAG_WFS = 'https://service.pdok.nl/lv/bag/wfs/v2_0?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&'


def bag(ctx, typ, prop, val):
    f = '<Filter><PropertyIsEqualTo><PropertyName>%s</PropertyName><Literal>%s</Literal></PropertyIsEqualTo></Filter>' % (prop, html.escape(val))
    r = jhaal(ctx, 'BAG (PDOK WFS)', BAG_WFS + up.urlencode({'typeName': typ, 'filter': f, 'count': 200}), '%s = %s' % (prop, val))
    return [x.get('properties', {}) for x in (r or {}).get('features', [])] if isinstance(r, dict) else []


def wms(ctx, sleutel, bbox, laag=None, bron=None):
    url, l, fmt, b = WMS[sleutel]
    q = {'service': 'WMS', 'version': '1.3.0', 'request': 'GetMap', 'layers': laag or l, 'styles': '', 'crs': 'EPSG:28992', 'bbox': bbox,
         'width': 480, 'height': 320, 'format': fmt}
    if fmt == 'image/png':
        q['transparent'] = 'true'
    try:
        x = haal(ctx, bron or b, url + '?' + up.urlencode(q), 'kaartvak rond het adres (180 x 120 m)', binair=True, timeout=30)
    except PoortDicht:
        raise
    except Exception:
        return None
    if not x or not (x[:3] == b'\xff\xd8\xff' or x[:8] == b'\x89PNG\r\n\x1a\n'):
        return None
    return 'data:%s;base64,%s' % (fmt, base64.b64encode(x).decode())


def zoek_adres(ctx, term):
    r = jhaal(ctx, 'PDOK Locatieserver', 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?' + up.urlencode(
        {'q': term, 'fq': 'type:adres', 'rows': 5, 'fl': '*'}), term, timeout=15)
    docs = ((r or {}).get('response') or {}).get('docs') or [] if isinstance(r, dict) else []
    if not docs:
        return [melding('Adres', 'Geen adres gevonden in de BAG voor deze zoekterm.', 'PDOK Locatieserver')], {}
    ls = docs[0]
    kaarten = []
    andere = [d.get('weergavenaam') for d in docs[1:] if d.get('weergavenaam')]
    vbo_id = ls.get('adresseerbaarobject_id')
    vbo = (bag(ctx, 'bag:verblijfsobject', 'identificatie', vbo_id) or [{}])[0] if vbo_id else {}
    pand = bag(ctx, 'bag:verblijfsobject', 'pandidentificatie', vbo['pandidentificatie']) if vbo.get('pandidentificatie') else []
    xy = [float(v) for v in re.findall(r'[\d.]+', ls.get('centroide_rd') or '')]
    beelden, tijd = [], []
    if len(xy) == 2 and ctx.beelden:
        x, y = xy
        bbox = '%d,%d,%d,%d' % (x - 90, y - 60, x + 90, y + 60)
        taken = {'kaart': ('top10nl', None, None), 'pand': ('pand', None, None), 'foto': ('foto', None, None)}
        taken.update({'j' + j: ('foto', l, 'PDOK luchtfoto ' + j) for j, l in JAREN})
        with cf.ThreadPoolExecutor(6) as ex:
            fut = {k: ex.submit(wms, ctx, *v[:1], bbox, v[1], v[2]) for k, v in taken.items()}
            img = {k: f.result() for k, f in fut.items()}
        if img['kaart']:
            beelden.append({'titel': 'Kaart + BAG-panden', 'src': img['kaart'], 'over': img['pand']})
        if img['foto']:
            beelden.append({'titel': 'Luchtfoto (actueel) + BAG-panden', 'src': img['foto'], 'over': img['pand']})
        tijd = [{'titel': j, 'src': img['j' + j]} for j, _ in JAREN if img.get('j' + j)]
    kaarten.append(kaartje('Adres', 'PDOK Locatieserver, BAG', [
        ('Adres', ls.get('weergavenaam')), ('Buurt / wijk', ' / '.join(x for x in (ls.get('buurtnaam'), ls.get('wijknaam')) if x)),
        ('Gemeente / provincie', ' / '.join(x for x in (ls.get('gemeentenaam'), ls.get('provincienaam')) if x)),
        ('Gebruiksdoel', vbo.get('gebruiksdoel')), ('Oppervlakte (dit adres)', ('%s m²' % vbo['oppervlakte']) if vbo.get('oppervlakte') else None),
        ('Status', vbo.get('status'))], beelden=beelden, klein=('Ook gevonden: ' + '; '.join(andere)) if andere else None))
    if tijd:
        kaarten.append(kaartje('Tijdmachine: hetzelfde stukje door de jaren', 'PDOK luchtfoto per jaar', tijd=tijd))
    if pand:
        doelen = {}
        for v in pand:
            for d in (v.get('gebruiksdoel') or '').split(','):
                if d.strip():
                    doelen[d.strip()] = doelen.get(d.strip(), 0) + 1
        kaarten.append(kaartje('Het pand', 'BAG via PDOK (gratis, geen sleutel)', [
            ('Bouwjaar', vbo.get('bouwjaar')), ('Status pand', vbo.get('pandstatus')), ('Adressen in het pand', len(pand)),
            ('Gebruiksdoelen in het pand', ', '.join('%s × %d' % kv for kv in sorted(doelen.items()))),
            ('Totale oppervlakte adressen', '%d m²' % sum(v.get('oppervlakte') or 0 for v in pand))]))
    kaarten.append(melding('Bedrijven op dit adres', 'Welke bedrijven hier gevestigd zijn, kan pas met een KvK-sleutel (keuze 2, niet gemaakt).'))
    return kaarten, {'adres': ls.get('weergavenaam'), 'bouwjaar': vbo.get('bouwjaar'), 'adressen_in_pand': len(pand)}


# ---------------------------------------------------------------- bedrijf
def kvk_uit_incassant(i):
    m = re.fullmatch(r'NL\d\d[A-Z0-9]{3}(\d{8})\d{4}', re.sub(r'\s', '', str(i or '')).upper())
    return m.group(1) if m else None


def handelsregister(ctx, kvk):
    with cf.ThreadPoolExecutor(2) as ex:
        a = ex.submit(haal, ctx, 'Liza (KvK-gegevens)', 'https://www.liza.nl/en/' + kvk, 'KvK-nummer ' + kvk)
        b = ex.submit(haal, ctx, 'OpenCorporates', 'https://opencorporates.com/companies/nl/' + kvk, 'KvK-nummer ' + kvk)
        lz, oc = '', ''
        try:
            lz = tekst_van(a.result())
        except PoortDicht:
            raise
        except Exception:
            pass
        try:
            oc = tekst_van(b.result())
        except PoortDicht:
            raise
        except Exception:
            pass
    naam = (re.search(r'\| ([^|]+) \| Company Number', oc) or [None, None])[1]
    velden = [('KvK-nummer', kvk), ('Naam (OpenCorporates)', naam and naam.strip()), ('Rechtsvorm', veld(lz, 'Legal form', 2)),
              ('Status', veld(oc, 'Status')), ('Opgericht (volgens Liza)', veld(lz, 'Established')),
              ('Vestigingsadres', veld(oc, 'Head Office Address')), ('Hoofdactiviteit', veld(lz, 'Principal activity')),
              ('Btw-nummer', veld(lz, 'VAT Number')), ('Laatst gedeponeerde balans (Liza)', veld(lz, 'Last balance sheet year'))]
    hn = re.findall(r'\| ([^|]+?) \(trading name\)', oc)
    nmi = 'Non Mailing Indicator' in oc
    if not any(v for k, v in velden[1:]):
        return kaartje('Handelsregister', 'OpenCorporates, Liza', [('KvK-nummer', kvk)], klein='Geen gegevens gevonden bij deze KvK-pagina’s.'), {}
    k = kaartje('Handelsregister', 'OpenCorporates, Liza (openbare pagina’s, zonder sleutel)', velden,
                klein=('Handelsnamen (%d): %s' % (len(hn), ', '.join(hn[:14]) + (' …' if len(hn) > 14 else ''))) if hn else None,
                let='Dit bedrijf heeft een non-mailing-indicator: geen ongevraagde post of verkoopbezoek.' if nmi else None)
    return k, {'naam': naam and naam.strip(), 'rechtsvorm': veld(lz, 'Legal form', 2), 'handelsnamen': len(hn), 'non_mailing': nmi}


def domein(ctx, dom):
    with cf.ThreadPoolExecutor(3) as ex:
        a = ex.submit(jhaal, ctx, 'RDAP (domeinregister)', 'https://rdap.org/domain/' + dom, dom)
        b = ex.submit(jhaal, ctx, 'Wayback Machine', 'https://web.archive.org/cdx/search/cdx?' + up.urlencode(
            {'url': dom, 'limit': 1, 'output': 'json', 'fl': 'timestamp'}), dom)
        c = ex.submit(jhaal, ctx, 'crt.sh (certificaten)', 'https://crt.sh/?' + up.urlencode(
            {'q': dom, 'output': 'json', 'exclude': 'expired', 'deduplicate': 'Y'}), dom, timeout=12)
        rd, wb = a.result() or {}, b.result() or []
        try:
            crt = c.result()
        except PoortDicht:
            raise
        except Exception:
            crt = None
    rd = rd if isinstance(rd, dict) else {}
    ev = {x.get('eventAction'): str(x.get('eventDate', ''))[:10] for x in rd.get('events', []) if isinstance(x, dict)}
    reg = None
    for x in rd.get('entities', []) or []:
        if 'registrar' in (x.get('roles') or []):
            try:
                reg = [v[3] for v in x['vcardArray'][1] if v[0] == 'fn'][0]
            except Exception:
                pass
    wb_eerst = wb[1][0] if isinstance(wb, list) and len(wb) > 1 else None
    subs = sorted({n for c in crt for n in str(c.get('name_value', '')).split('\n') if '*' not in n}) if isinstance(crt, list) else []
    velden = [('Domein', dom), ('Geregistreerd', datum_nl(ev.get('registration'))), ('Laatst gewijzigd', datum_nl(ev.get('last changed'))),
              ('Verloopt', datum_nl(ev.get('expiration'))), ('Registrar', reg), ('Eerste opname in het webarchief', datum_nl(wb_eerst)),
              ('Geldige certificaten', ('%d, %d subdomeinen' % (len(crt), len(subs))) if isinstance(crt, list) else 'crt.sh gaf nu geen antwoord (gratis dienst, vaak overbelast)'),
              ('Voorbeelden subdomeinen', ', '.join(subs[:8]) + (' …' if len(subs) > 8 else ''))]
    return kaartje('Website', 'RDAP, Wayback Machine, crt.sh (alle gratis)', velden), {
        'geregistreerd': ev.get('registration'), 'eerste_archief': wb_eerst}


def euro(c):
    return '€ ' + format((c or 0) / 100, ',.2f').replace(',', 'X').replace('.', ',').replace('X', '.')


def facturen_kaartje(prof, n):
    return kaartje('Wat wij er zelf van weten (Facturen)', 'Facturen-app (eigen, blijft op de pod; grootste van %d profielen)' % n, [
        ('Naam op het afschrift', ', '.join(prof.get('namen', []))), ('IBAN(s)', ', '.join(prof.get('ibans', []))),
        ('Incassant-ID', ', '.join(prof.get('incassant_ids', []))), ('Betaalt', '%s × %s' % (prof.get('aantal'), prof.get('betaalwijze'))),
        ('Totaal', euro(prof.get('totaal_centen'))), ('Eerste / laatste', '%s / %s' % (prof.get('eerste'), prof.get('laatste'))),
        ('Voor', ', '.join(prof.get('entiteiten', []))), ('Nieuw IBAN', 'ja, let op' if prof.get('nieuw_iban') else None)])


DOMEIN_RE = re.compile(r'^(?:https?://)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:/.*)?$', re.I)
IBAN_RE = re.compile(r'^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$')


def zoek_bedrijf(ctx, term):
    t = norm(term)
    kaarten, kern = [], {}
    kvk = re.sub(r'\D', '', t) if re.fullmatch(r'\d{8}', re.sub(r'[\s.]', '', t)) else None
    dm = DOMEIN_RE.match(t.lower()) if not kvk and ' ' not in t else None
    dom = dm.group(1) if dm else None
    iban = re.sub(r'\s', '', t).upper() if IBAN_RE.match(re.sub(r'\s', '', t).upper()) else None
    fac_term = None if kvk else (iban or (dom.split('.')[-2] if dom else t))
    prof = None
    if fac_term:
        try:
            pr = facturen_hoe(ctx, fac_term)
        except PoortDicht:
            pr = None
        if pr:
            pr = sorted(pr, key=lambda p: -(p.get('aantal') or 0))
            prof = pr[0]
            kaarten.append(facturen_kaartje(prof, len(pr)))
            kern['facturen_aantal'] = prof.get('aantal')
            if not kvk:
                kvk = next((k for k in map(kvk_uit_incassant, prof.get('incassant_ids', [])) if k), None)
                if kvk:
                    kern['kvk_uit'] = 'incassant-ID'
        elif pr is not None:
            kaarten.append(kaartje('Wat wij er zelf van weten (Facturen)', 'Facturen-app (eigen)', klein='Geen betalingen gevonden in Facturen.'))
    if kvk:
        try:
            k, x = handelsregister(ctx, kvk)
            kaarten.insert(0, k)
            kern.update(x)
            kern['kvk'] = kvk
        except PoortDicht:
            kaarten.insert(0, melding('Handelsregister', 'Niet opgehaald: de poort laat deze zoekterm niet naar buiten.'))
        kort = re.sub(r'\s*\b(b\.?v\.?|n\.?v\.?|v\.?o\.?f\.?|holding)\s*$', '', kern.get('naam') or '', flags=re.I).strip()
        if not fac_term and kort:
            try:
                pr = facturen_hoe(ctx, kort)
            except PoortDicht:
                pr = None
            pr = [p for p in pr or [] if kvk in map(kvk_uit_incassant, p.get('incassant_ids', []))] or None
            if pr:
                prof = sorted(pr, key=lambda p: -(p.get('aantal') or 0))[0]
                kaarten.append(facturen_kaartje(prof, len(pr)))
                kern['facturen_aantal'] = prof.get('aantal')
    elif not dom:
        kaarten.insert(0, melding('Handelsregister', 'Geen KvK-nummer gevonden (niet in Facturen). Typ het KvK-nummer of het domein; '
                                  'zoeken op naam kan pas met een KvK-sleutel (keuze 2, niet gemaakt).'))
    if dom:
        try:
            k, x = domein(ctx, dom)
            kaarten.append(k)
            kern.update(x)
        except PoortDicht:
            kaarten.append(melding('Website', 'Niet opgehaald: de poort laat deze zoekterm niet naar buiten.'))
    if not kvk and not iban:
        try:
            kaarten.append(contacten_kaartje(contacten(ctx, t), t))
        except PoortDicht:
            pass
    return kaarten, kern


# ---------------------------------------------------------------- telefoon
def zoek_telefoon(ctx, term):
    kaarten, kern = [], {}
    try:
        import phonenumbers as pn
        from phonenumbers import carrier, geocoder, PhoneNumberType as T
    except Exception:
        pn = None
    e164 = None
    if pn:
        SOORT = {T.FIXED_LINE: 'vast', T.MOBILE: 'mobiel', T.VOIP: 'internetbellen (085/091)', T.PREMIUM_RATE: 'betaalnummer (0900)',
                 T.TOLL_FREE: 'gratis (0800)', T.UAN: 'servicenummer (088)', T.FIXED_LINE_OR_MOBILE: 'vast of mobiel',
                 T.SHARED_COST: 'gedeelde kosten (0900/0906)', T.PAGER: 'semafoon', T.PERSONAL_NUMBER: 'persoonlijk nummer'}
        try:
            p = pn.parse(term, 'NL')
            e164 = pn.format_number(p, pn.PhoneNumberFormat.E164)
            land = geocoder.country_name_for_number(p, 'nl')
            kern = {'geldig': pn.is_valid_number(p), 'soort': SOORT.get(pn.number_type(p), 'onbekend'),
                    'gebied': geocoder.description_for_number(p, 'nl') or None, 'reeks': carrier.name_for_number(p, 'nl') or None,
                    'e164': e164}
            kaarten.append(kaartje('Het nummer (offline)', 'libphonenumber %s (offline, er gaat niets naar buiten)' % pn.__version__, [
                ('Nummer', pn.format_number(p, pn.PhoneNumberFormat.INTERNATIONAL)), ('Geldig', 'ja' if kern['geldig'] else 'nee'),
                ('Soort', kern['soort']), ('Gebied', kern['gebied']), ('Land', land), ('Oorspronkelijke reeks', kern['reeks'])],
                klein='"Oorspronkelijke reeks" is de provider aan wie het nummerblok ooit is uitgegeven; door nummerbehoud zegt het weinig '
                      'over de provider van nu. Een openbare omgekeerde nummerzoeker voor Nederland bestaat niet meer.'))
        except Exception:
            kaarten.append(melding('Het nummer (offline)', 'Dit lijkt geen telefoonnummer.', 'libphonenumber'))
    else:
        kaarten.append(melding('Het nummer (offline)', 'Offline nummerduiding niet beschikbaar (phonenumbers ontbreekt op de pod).'))
    if e164:
        cijfers = re.sub(r'\D', '', term)
        nat = '0' + e164[3:] if e164.startswith('+31') else cijfers
        varianten = sorted({nat, e164, norm(term)})
        with cf.ThreadPoolExecutor(2) as ex:
            a = ex.submit(contacten, ctx, e164)
            b = ex.submit(mail_zoeken, ctx, ' OR '.join('"%s"' % v for v in varianten), 8)
            for f, mk in ((a, lambda r: contacten_kaartje(r, e164)), (b, mail_kaartje)):
                try:
                    kaarten.append(mk(f.result()))
                except PoortDicht:
                    pass
                except Exception:
                    kaarten.append(melding('Eigen bron', 'Een eigen bron gaf geen antwoord.'))
    return kaarten, kern


# ---------------------------------------------------------------- persoon (v1: BIG + eigen bronnen; geen gebruikersnaam- of socialemediajacht)
VOEGSELS = ('van der', 'van den', 'van de', 'in het', 'in ’t', "in 't", 'van', 'de', 'der', 'den', 'het', 'ten', 'ter', 'te', 'op de')


def splits_naam(t):
    t = norm(t)
    m = re.match(r'^((?:[A-Za-z]\.\s?)+)\s*(.*)$', t)
    vl, rest = (re.sub(r'\s', '', m.group(1)).upper(), m.group(2)) if m else ('', t)
    if not m and ' ' in rest:
        eerste, rest2 = rest.split(' ', 1)
        if not any(rest.lower().startswith(v + ' ') for v in VOEGSELS):
            vl, rest = eerste[0].upper() + '.', rest2
    vv = ''
    for v in VOEGSELS:
        if rest.lower().startswith(v + ' '):
            vv, rest = rest[:len(v)], rest[len(v) + 1:]
            break
    return vl, vv, rest.strip()


BIG_URL = 'https://api.bigregister.nl/zksrv/soap/4'
BIG_NS = 'http://services.cibg.nl/ExternalUser'


def letters(x):
    return re.sub(r'[^a-z]', '', unicodedata.normalize('NFKD', str(x or '')).encode('ascii', 'ignore').decode().lower())


def big_soap(ctx, actie, binnen, naar_buiten):
    body = ('<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>%s'
            '</soap:Body></soap:Envelope>' % binnen)
    return haal(ctx, 'BIG-register (CIBG)', BIG_URL, naar_buiten, data=body.encode(),
                hdr={'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '%s/%s' % (BIG_NS, actie)}) or ''


def big_ref(ctx):
    """Beroeps- en specialismenamen (referentielijst van het CIBG, zonder zoekterm), 30 dagen in de cache."""
    c = db()
    r = c.execute("select json from cache where sleutel = 'big-ref'").fetchone()
    if r:
        return json.loads(r[0])
    x = big_soap(ctx, 'GetRibizReferenceData', '<GetRibizReferenceData xmlns="%s"><getCibgReferenceDataRequest/></GetRibizReferenceData>' % BIG_NS,
                 'niets (referentielijst beroepen en specialismen)')
    ref = {'groep': {}, 'spec': {}}
    for t in re.findall(r'<ProfessionalGroup>(.*?)</ProfessionalGroup>', x, re.S):
        m = re.search(r'<Code>(.*?)</Code>.*?<Description>(.*?)</Description>', t, re.S)
        if m:
            ref['groep'][m.group(1)] = html.unescape(m.group(2)).lower()
    for t in re.findall(r'<TypeOfSpecialism>(.*?)</TypeOfSpecialism>', x, re.S):
        m = re.search(r'<Code>(.*?)</Code>.*?<Description>(.*?)</Description>', t, re.S)
        if m:
            ref['spec'][m.group(1)] = html.unescape(m.group(2)).lower()
    if ref['groep'] or ref['spec']:
        c.execute('insert or replace into cache(sleutel, tijd, json) values (?,?,?)', ('big-ref', nu_iso(), json.dumps(ref)))
        c.commit()
    return ref


def big(ctx, naam):
    vl, vv, achter = splits_naam(naam)
    if not achter:
        return melding('BIG-register', 'Geen achternaam herkend.', 'BIG-register'), {}
    x = big_soap(ctx, 'ListHcpApprox4', '<listHcpApproxRequest xmlns="%s"><WebSite>Ribiz</WebSite><Name>%s</Name>%s%s</listHcpApproxRequest>' % (
        BIG_NS, html.escape(achter), ('<Initials>%s</Initials>' % html.escape(vl[:1])) if vl else '', ('<Prefix>%s</Prefix>' % html.escape(vv)) if vv else ''),
        'naam: ' + ' '.join(y for y in (vl[:1], vv, achter) if y))
    if 'Fault' in x:
        return kaartje('BIG-register', 'BIG-register (CIBG, openbaar)', klein='Te veel treffers of fout; geef voorletters mee (bijv. "J. Jansen").'), {}
    try:
        ref = big_ref(ctx)
    except Exception:
        ref = {'groep': {}, 'spec': {}}
    raak, lijkt = [], 0
    for t in re.findall(r'<ListHcpApprox4>(.*?)</ListHcpApprox4>', x, re.S):
        g = lambda k: html.unescape((re.search('<%s>(.*?)</%s>' % (k, k), t, re.S) or [None, ''])[1]).strip()
        post = g('MailingName')
        delen = [letters(w) for w in re.split(r'[\s-]+', post)]
        if letters(g('BirthSurname')) != letters(achter) and letters(achter) not in delen:
            lijkt += 1
            continue
        if vl and letters(g('Initial'))[:1] != letters(vl)[:1]:
            lijkt += 1
            continue
        groep = ref['groep'].get(g('ProfessionalGroupCode'), 'beroep ' + g('ProfessionalGroupCode'))
        spec = sorted({ref['spec'].get(s, 'specialisme ' + s) for s in re.findall(r'<TypeOfSpecialismId>(.*?)<', t)})
        raak.append(' · '.join(y for y in (post or (g('Initial') + ' ' + g('BirthSurname')), groep, ', '.join(spec),
                                           ('BIG ' + g('ArticleRegistrationNumber')) if g('ArticleRegistrationNumber') else '') if y))
    klein = ('Ook %d %s (andere achternaam of voorletter).' % (lijkt, 'lijkende naam' if lijkt == 1 else 'lijkende namen')) if lijkt else None
    if not raak:
        return kaartje('BIG-register', 'BIG-register (CIBG, openbaar)', klein='Geen zorgverlener met deze naam in het BIG-register.' + (' ' + klein if klein else '')), {'big': 0}
    return kaartje('BIG-register', 'BIG-register (CIBG, openbaar; geen adres of voornaam)', lijst=raak[:20], klein=klein), {'big': len(raak)}


def zoek_persoon(ctx, term):
    kaarten, kern = [], {}
    with cf.ThreadPoolExecutor(3) as ex:
        a = ex.submit(big, ctx, term)
        b = ex.submit(contacten, ctx, norm(term))
        c = ex.submit(mail_zoeken, ctx, '"%s"' % norm(term).replace('"', ''), 8)
        try:
            k, kern = a.result()
            kaarten.append(k)
        except PoortDicht:
            kaarten.append(melding('BIG-register', 'Niet opgehaald: de poort laat deze zoekterm niet naar buiten.'))
        except Exception:
            kaarten.append(melding('BIG-register', 'Het BIG-register gaf geen antwoord.'))
        for f, mk in ((b, lambda r: contacten_kaartje(r, term)), (c, mail_kaartje)):
            try:
                kaarten.append(mk(f.result()))
            except PoortDicht:
                pass
            except Exception:
                kaarten.append(melding('Eigen bron', 'Een eigen bron gaf geen antwoord.'))
    pp = persoonspaginas(term)
    kaarten.append(kaartje('OVIS-persoonspagina', 'Second Brain (lokaal)', lijst=pp) if pp else
                   kaartje('OVIS-persoonspagina', 'Second Brain (lokaal)', klein='Geen persoonspagina met deze naam.'))
    kern['persoonspaginas'] = len(pp)
    return kaarten, kern


# ---------------------------------------------------------------- herkennen en zoeken
def herken(term):
    t = norm(term)
    kaal = re.sub(r'[\s.()-]', '', t)
    if re.fullmatch(r'\d{8}', kaal):
        return 'bedrijf'
    if re.fullmatch(r'\+?\d{9,15}', kaal) and (kaal.startswith(('0', '+')) or len(kaal) >= 11):
        return 'telefoon'
    if IBAN_RE.match(kaal.upper()) or (' ' not in t and DOMEIN_RE.match(t.lower())):
        return 'bedrijf'
    if re.search(r'\b\d{4}\s?[A-Za-z]{2}\b', t) or re.search(r'[A-Za-z]{3,}\s+\d{1,5}\s?[A-Za-z]?\b', t):
        return 'adres'
    return 'bedrijf'


ZOEK = {'adres': zoek_adres, 'bedrijf': zoek_bedrijf, 'telefoon': zoek_telefoon, 'persoon': zoek_persoon}


def zoek(v):
    term = norm(v.get('term'))[:200]
    if not term:
        return {'ok': False, 'fout': 'lege zoekterm'}
    wie = v.get('wie') if v.get('wie') in WIE else 'machinekamer'
    ingang = v.get('ingang') or 'auto'
    if ingang == 'auto':
        ingang = herken(term)
    if ingang not in INGANGEN:
        return {'ok': False, 'fout': 'onbekende ingang'}
    doel = v.get('doel') or DOEL_STANDAARD.get(ingang)
    if doel not in DOELEN:
        doel = None if ingang == 'persoon' else 'anders'
    doel_tekst = norm(v.get('doel_tekst'))[:120] or None
    herkomst = 'david' if wie == 'david' else (norm(v.get('herkomst')).lower()[:40] or None)
    pt = poort(term, wie, herkomst, ingang, doel)
    c = db()
    zid = c.execute('insert into zoekvraag(tijd, wie, doel, doel_tekst, ingang, term, herkomst, poort, poort_reden) values (?,?,?,?,?,?,?,?,?)',
                    (nu_iso(), wie, doel, doel_tekst, ingang, term, herkomst, pt['niveau'], pt['reden'])).lastrowid
    c.commit()
    sleutel = hashlib.sha256(('%s|%s|%s|%s|%s' % (VERSIE, ingang, term.lower(), pt['niveau'], v.get('beelden') is not False)).encode()).hexdigest()
    rij = None if v.get('vers') or NEP else c.execute('select tijd, json from cache where sleutel = ?', (sleutel,)).fetchone()
    beelden = v.get('beelden') is not False
    ctx = Ctx(pt['niveau'], beelden)
    if ingang == 'persoon' and pt['niveau'] == 'niets' and pt['reden'].startswith('persoon'):
        kaarten, kern = [melding('Persoon', 'Niet gezocht: ' + pt['reden'] + '.')], {}
    elif rij:
        u = json.loads(rij[1])
        kaarten, kern = u['kaarten'], u['kern']
        c.execute('update zoekvraag set cache = 1 where id = ?', (zid,))
    else:
        try:
            kaarten, kern = ZOEK[ingang](ctx, term)
        except PoortDicht:
            kaarten, kern = [melding('Niet gezocht', 'De poort laat deze zoekterm niet naar buiten.')], {}
        except Exception as e:
            kaarten, kern = [melding('Fout', 'Er ging iets mis: %s' % type(e).__name__)], {}
        if pt['niveau'] == 'alles' and not NEP and any(l['soort'] == 'extern' and l['status'] in ('200', '204') for l in ctx.log):
            c.execute('insert or replace into cache(sleutel, tijd, json) values (?,?,?)',
                      (sleutel, nu_iso(), json.dumps({'kaarten': kaarten, 'kern': kern}, ensure_ascii=False)))
    if pt['niveau'] != 'alles':
        kaarten.insert(0, kaartje('Poort', 'OVIS OSINT-poort', let='Deze zoekvraag ging niet naar openbare bronnen (%s).' % pt['reden']))
    for l in ctx.log:
        c.execute('insert into aanroep(zoek_id, tijd, bron, soort, host, naar_buiten, status, ms) values (?,?,?,?,?,?,?,?)',
                  (zid, nu_iso(), l['bron'], l['soort'], l['host'], l['naar_buiten'], l['status'], l['ms']))
    ext = sum(1 for l in ctx.log if l['soort'] == 'extern' and l['status'] != 'poort dicht')
    c.execute('update zoekvraag set uitkomst = ? where id = ?', ('%d kaartjes, %d extern' % (len(kaarten), ext), zid))
    c.commit()
    return {'ok': True, 'id': zid, 'ingang': ingang, 'term': term, 'doel': doel, 'doel_tekst': doel_tekst, 'wie': wie,
            'poort': pt, 'cache': bool(rij), 'kaarten': kaarten, 'kern': kern, 'extern': ext, 'logboek': ctx.log, 'versie': VERSIE}


def logboek(n=50):
    c = db()
    c.row_factory = sqlite3.Row
    uit = []
    for z in c.execute('select * from zoekvraag order by id desc limit ?', (max(1, min(int(n), 500)),)).fetchall():
        a = [dict(r) for r in c.execute('select bron, soort, host, naar_buiten, status, ms from aanroep where zoek_id = ? order by id', (z['id'],))]
        d = dict(z)
        d['aanroepen'] = a
        d['extern'] = sum(1 for r in a if r['soort'] == 'extern' and r['status'] != 'poort dicht')
        uit.append(d)
    return {'ok': True, 'zoekvragen': uit, 'doelen': DOELEN, 'ingangen': INGANGEN}


def info():
    if not os.path.exists(DB):
        return {'ok': True, 'zoekvragen': 0, 'aanroepen': 0, 'cache': 0, 'versie': VERSIE}
    c = db()
    q = lambda s: c.execute(s).fetchone()[0]
    return {'ok': True, 'versie': VERSIE, 'zoekvragen': q('select count(*) from zoekvraag'), 'aanroepen': q('select count(*) from aanroep'),
            'cache': q('select count(*) from cache'), 'laatste': q('select max(tijd) from zoekvraag'),
            'phonenumbers': __import__('importlib.util').util.find_spec('phonenumbers') is not None}


def main(a):
    if not a or a[0] not in ('zoek', 'logboek', 'info'):
        sys.exit('gebruik: osint.py zoek (json op stdin) | logboek [n] | info')
    if a[0] == 'zoek':
        try:
            v = json.loads(sys.stdin.read() or '{}')
        except ValueError:
            v = None
        r = zoek(v) if isinstance(v, dict) else {'ok': False, 'fout': 'geen json'}
    elif a[0] == 'logboek':
        r = logboek(a[1] if len(a) > 1 and a[1].isdigit() else 50)
    else:
        r = info()
    sys.stdout.write(json.dumps(r, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1:])
