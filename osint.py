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

VERSIE = 'osint-3'
HIER = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get('OSINT_DB') or '/opt/data/osint/osint.sqlite'
VAULT = os.environ.get('VAULT_DIR') or '/opt/data/AI_SecondBrain'
WEBHOOKS = os.environ.get('OSINT_WEBHOOKS') or '/opt/data/bin/socev-webhooks.txt'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36 OVIS-OSINT/1'
CACHE_DAGEN, LOG_DAGEN = 30, 365
NEP = os.environ.get('OSINT_NEP_NET') == '1'

INGANGEN = ('adres', 'bedrijf', 'telefoon', 'persoon', 'kenteken', 'mail', 'bestand', 'voetafdruk', 'lijkend')
DOELEN = {'leverancier': 'leverancier controleren', 'waarnemer': 'waarnemer of sollicitant verifiëren', 'beller': 'beller duiden',
          'pand': 'pand of adres', 'anders': 'anders'}
DOEL_STANDAARD = {'adres': 'pand', 'bedrijf': 'leverancier', 'telefoon': 'beller', 'kenteken': 'anders', 'mail': 'anders', 'bestand': 'anders',
                  'voetafdruk': 'anders', 'lijkend': 'anders'}
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
    # een volledig btw-nummer (NL + 9 cijfers + B + 2) is geen BSN; zo leest de patiëntpoort (intake/patientpoort.js) het ook (wv2698)
    t_bsn = re.sub(r'(?i)(?<![A-Z0-9])NL\d{9}B\d{2}(?![A-Z0-9])', ' ', t)
    if any(elfproef(re.sub(r'\D', '', m.group(0))) for m in _BSN_RE.finditer(t_bsn)):
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
      create index if not exists aanroep_zoek on aanroep(zoek_id);
      create table if not exists instelling(sleutel text primary key, json text not null, tijd text);
      create table if not exists lijkend(variant text primary key, domein text not null, fuzzer text, a text, mx text, ns text, eerst text, laatst text);
      create table if not exists voetafdruk(naam text not null, site text not null, url text, cat text, uitslag text, bekeken text, eerst_raak text,
        primary key(naam, site));''')
    if 'graaf' not in [r[1] for r in c.execute('pragma table_info(zoekvraag)')]:
        c.execute('alter table zoekvraag add column graaf text')
    nu = datetime.datetime.now(datetime.timezone.utc)
    c.execute('delete from cache where tijd < ?', ((nu - datetime.timedelta(days=CACHE_DAGEN)).isoformat(),))
    oud = (nu - datetime.timedelta(days=LOG_DAGEN)).isoformat()
    c.execute('delete from aanroep where zoek_id in (select id from zoekvraag where tijd < ?)', (oud,))
    c.execute('delete from zoekvraag where tijd < ?', (oud,))
    c.execute('delete from voetafdruk where bekeken < ?', (oud,))
    c.execute('delete from lijkend where laatst < ?', (oud,))
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
    def __init__(self, niveau, beelden=True, wie='machinekamer'):
        self.niveau = niveau
        self.wie = wie
        self.beelden = beelden   # False (Socev): geen kaartbeelden ophalen, dus ook geen kaartvak naar buiten
        self.log = []   # dicts: bron, soort, host, naar_buiten, status, ms
        self.knopen, self.randen = {}, []   # netwerkplaat (wv2698): entiteiten en verbanden van deze zoekvraag

    def knoop(self, soort, label, **x):
        """Een entiteit op de netwerkplaat; id = soort:label (genormaliseerd), zodat dezelfde entiteit over zoekvragen samenvalt."""
        label = norm(label)[:120]
        if not label:
            return None
        k = '%s:%s' % (soort, label.lower())
        if k not in self.knopen:
            self.knopen[k] = dict({'id': k, 'soort': soort, 'label': label}, **{a: b for a, b in x.items() if b not in (None, '')})
        return k

    def rand(self, van, naar, label):
        if van and naar and van != naar and not any(r['van'] == van and r['naar'] == naar for r in self.randen):
            self.randen.append({'van': van, 'naar': naar, 'label': label})

    def graaf(self):
        return {'knopen': list(self.knopen.values()), 'randen': self.randen}


def poort_open(ctx, bron, soort, host, naar_buiten, stil=False):
    """De poort voor elke aanroep naar buiten (HTTP én DNS). Dicht → logregel + PoortDicht. stil = de aanroeper logt zelf gebundeld."""
    if soort == 'extern' and ctx.niveau != 'alles' or soort == 'eigen' and ctx.niveau == 'niets':
        ctx.log.append({'bron': bron, 'soort': soort, 'host': host, 'naar_buiten': 'niets (poort dicht)', 'status': 'poort dicht', 'ms': 0})
        raise PoortDicht(bron)


def nep_antwoord(url):
    """Toets: OSINT_NEP_ANTWOORD = json {host of host+pad-begin: antwoord (tekst of json)}; anders '{}'."""
    f = os.environ.get('OSINT_NEP_ANTWOORD')
    if not f:
        return None
    try:
        m = json.load(open(f))
    except Exception:
        return None
    u = up.urlsplit(url)
    q = up.parse_qs(u.query)
    for k in sorted(m, key=len, reverse=True):
        basis, _, eis = k.partition('?')   # wv2712: 'host/pad?a=b&c=d' = ook deze queryparameters moeten erin staan
        if (u.hostname + u.path).startswith(basis) and all(w in q.get(a, []) for a, w in up.parse_qsl(eis)):
            v = m[k]
            return v if isinstance(v, str) else json.dumps(v)
    return None


class GeenDoorsturen(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None   # wv2712 (review-MOET 1): een 3xx blijft een 3xx (HTTPError), er wordt niets gevolgd


def haal(ctx, bron, url, naar_buiten, soort='extern', data=None, hdr=None, timeout=25, binair=False, maxb=4_000_000, stil=False, metcode=False,
         redirects=True, totaal=None):
    """De enige weg naar het netwerk. soort extern = buiten ons systeem; eigen = eigen pod/n8n. De poort zit hier (poort_open).
    stil = niet per aanroep loggen (de aanroeper zet één gebundelde regel, bijv. 700 sites voor één gebruikersnaam).
    metcode = (status, inhoud) teruggeven."""
    host = up.urlsplit(url).hostname
    poort_open(ctx, bron, soort, host, naar_buiten)
    t = time.time()
    status = 'fout'
    try:
        if NEP:
            status = 'nep'
            x = nep_antwoord(url)
            x = (x if x is not None else '{}')
            x = (base64.b64decode(x[7:]) if x.startswith('base64:') else x.encode()) if binair else x   # wv2712: 'base64:…' = echte bytes (foto)
            return ('200', x) if metcode else x
        h = {'User-Agent': UA, 'Accept': '*/*'}
        h.update(hdr or {})
        body = None
        if data is not None:
            body = data if isinstance(data, bytes) else json.dumps(data).encode()
            h.setdefault('Content-Type', 'application/json')
        rq = urllib.request.Request(url, body, h)
        open_ = urllib.request.build_opener(GeenDoorsturen).open if not redirects else urllib.request.urlopen
        try:
            with open_(rq, timeout=timeout) as r:
                if totaal:   # wv2712: harde totaalgrens (een druppelende host houdt de zoekvraag niet op)
                    eind, b = time.time() + totaal, bytearray()
                    while len(b) < maxb:
                        c = r.read(min(65536, maxb - len(b)))
                        if not c:
                            break
                        b += c
                        if time.time() > eind:
                            raise TimeoutError('timed out (totaal)')
                    b = bytes(b)
                else:
                    b = r.read(maxb)
                status = str(r.status)
        except urllib.error.HTTPError as e:
            status = str(e.code)
            b = e.read(maxb)
        except Exception as e:
            status = 'time-out' if 'timed out' in str(e) else 'fout'
            raise
        x = b if binair else b.decode('utf-8', 'replace')
        return (status, x) if metcode else x
    finally:
        if not stil:
            ctx.log.append({'bron': bron, 'soort': soort, 'host': host, 'naar_buiten': naar_buiten, 'status': status,
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
       'foto': ('https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0', 'Actueel_orthoHR', 'image/jpeg', 'PDOK luchtfoto'),
       'perceel': ('https://service.pdok.nl/kadaster/kadastralekaart/wms/v5_0', 'Kadastralekaart', 'image/png', 'Kadastrale kaart (PDOK WMS)'),
       'ahn': ('https://service.pdok.nl/rws/ahn/wms/v1_0', 'dsm_05m', 'image/png', 'AHN hoogtekaart (PDOK WMS)')}   # wv2712
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
    beelden, tijd, img = [], [], {}
    if len(xy) == 2 and ctx.beelden:
        x, y = xy
        bbox = '%d,%d,%d,%d' % (x - 90, y - 60, x + 90, y + 60)
        taken = {'kaart': ('top10nl', None, None), 'pand': ('pand', None, None), 'foto': ('foto', None, None), 'perceel': ('perceel', None, None),
                 'ahn': ('ahn', None, None)}
        taken.update({'j' + j: ('foto', l, 'PDOK luchtfoto ' + j) for j, l in JAREN})
        with cf.ThreadPoolExecutor(6) as ex:
            fut = {k: ex.submit(wms, ctx, *v[:1], bbox, v[1], v[2]) for k, v in taken.items()}
            img = {k: f.result() for k, f in fut.items()}
        if img['kaart']:
            beelden.append({'titel': 'Kaart + BAG-panden', 'src': img['kaart'], 'over': img['pand']})
        if img['foto']:
            beelden.append({'titel': 'Luchtfoto (actueel) + BAG-panden', 'src': img['foto'], 'over': img['pand']})
        if img['foto'] and img.get('perceel'):
            beelden.append({'titel': 'Luchtfoto + perceelgrenzen', 'src': img['foto'], 'over': img['perceel']})
        tijd = [{'titel': j, 'src': img['j' + j]} for j, _ in JAREN if img.get('j' + j)]
    ctx.hoofd = ctx.knoop('adres', ls.get('weergavenaam'), zoek={'ingang': 'adres', 'term': ls.get('weergavenaam')})
    if ls.get('buurtnaam'):
        ctx.rand(ctx.hoofd, ctx.knoop('buurt', '%s (%s)' % (ls.get('buurtnaam'), ls.get('gemeentenaam'))), 'ligt in')
    if vbo.get('pandidentificatie'):
        ctx.rand(ctx.hoofd, ctx.knoop('pand', 'pand ' + vbo['pandidentificatie'], label2=('bouwjaar %s' % vbo.get('bouwjaar')) if vbo.get('bouwjaar') else None), 'in pand')
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
    perceel = None
    try:
        bk = brk_veilig(ctx, ls)
    except PoortDicht:
        bk = None
    if bk:
        kaarten.append(bk[0])
        perceel = bk[1]
    extra = []
    with cf.ThreadPoolExecutor(2) as ex:
        straat = ' '.join(str(x) for x in (ls.get('straatnaam'), ls.get('huis_nlt') or ls.get('huisnummer')) if x)
        f1 = ex.submit(bekendmakingen, ctx, straat, 'Bekendmakingen over dit adres (vergunningen e.d.)', 'straat + huisnummer + plaats',
                       [straat, ls.get('woonplaatsnaam')]) if straat else None
        f2 = ex.submit(ep_online, ctx, vbo_id)
        for f in (f1, f2):
            try:
                x = f.result() if f else None
                if x:
                    extra.append(x)
            except PoortDicht:
                pass
            except Exception:
                pass
    kaarten += extra
    kaarten += adres_deel3(ctx, ls, img)   # wv2712: buurt, hoogte, bodem, straatbeeld
    kaarten.append(adres_links(ls))
    kaarten.append(melding('Bedrijven op dit adres', 'Welke bedrijven hier gevestigd zijn, kan pas met een KvK-sleutel (betaalde keuze, niet aangezet).'))
    return kaarten, {'adres': ls.get('weergavenaam'), 'bouwjaar': vbo.get('bouwjaar'), 'adressen_in_pand': len(pand), 'perceel': perceel}


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


def iban_geldig(t):
    x = re.sub(r'\s', '', str(t or '')).upper()
    if not IBAN_RE.match(x):
        return False
    n = ''.join(str(int(ch, 36)) for ch in x[4:] + x[:4])
    return int(n) % 97 == 1


DOMEIN_RE = re.compile(r'^(?:https?://)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:/.*)?$', re.I)
IBAN_RE = re.compile(r'^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$')


def zoek_bedrijf(ctx, term):
    t = norm(term)
    kaarten, kern = [], {}
    kvk = re.sub(r'\D', '', t) if re.fullmatch(r'\d{8}', re.sub(r'[\s.]', '', t)) else None
    dm = DOMEIN_RE.match(t.lower()) if not kvk and ' ' not in t else None
    dom = dm.group(1) if dm else None
    iban = re.sub(r'\s', '', t).upper() if IBAN_RE.match(re.sub(r'\s', '', t).upper()) and iban_geldig(t) else None
    btw = btw_uit(t) if not (kvk or dom or iban) else None
    fac_term = None if kvk or btw else (iban or (dom.split('.')[-2] if dom else t))
    ctx.hoofd = ctx.knoop('domein' if dom else 'iban' if iban else 'btw' if btw else 'kvk' if kvk else 'bedrijf', ''.join(btw) if btw else (dom or iban or kvk or t),
                          zoek={'ingang': 'bedrijf', 'term': ''.join(btw) if btw else (dom or iban or kvk or t)})
    vies_naam = None
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
            kk = ctx.knoop('kvk', kvk, label2=x.get('naam'), zoek={'ingang': 'bedrijf', 'term': kvk})
            ctx.rand(ctx.hoofd, kk, 'KvK-nummer')
            vd = dict(k.get('velden') or [])
            if vd.get('Vestigingsadres'):
                ctx.rand(kk, ctx.knoop('adres', vd['Vestigingsadres'], zoek={'ingang': 'adres', 'term': vd['Vestigingsadres']}), 'gevestigd op')
            if vd.get('Btw-nummer') and btw_uit(vd['Btw-nummer']):
                btw = btw_uit(vd['Btw-nummer'])
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
    elif not dom and not btw:
        kaarten.insert(0, melding('Handelsregister', 'Geen KvK-nummer gevonden (niet in Facturen). Typ het KvK-nummer of het domein; '
                                  'zoeken op naam kan pas met een KvK-sleutel (keuze 2, niet gemaakt).'))
    if dom:
        try:
            k, x = domein(ctx, dom)
            kaarten.append(k)
            kern.update(x)
        except PoortDicht:
            kaarten.append(melding('Website', 'Niet opgehaald: de poort laat deze zoekterm niet naar buiten.'))
    if btw:
        try:
            k, vies_naam = vies(ctx, ''.join(btw))
            if k:
                kaarten.append(k)
        except PoortDicht:
            kaarten.append(melding('Btw-nummer (VIES)', 'Niet opgehaald: de poort laat deze zoekterm niet naar buiten.'))
    if prof:
        for ib in prof.get('ibans', [])[:3]:
            ctx.rand(ctx.hoofd, ctx.knoop('iban', ib), 'betaalt via')
    if not kvk and not iban and not btw:
        try:
            kaarten.append(contacten_kaartje(contacten(ctx, t), t))
        except PoortDicht:
            pass
    # review-MOET 1 (Fable): een vrije naam of een VIES-naam kan een privépersoon zijn (tegenpartij uit de bank, eenmanszaak). Op een naam
    # zoeken in Rechtspraak/ICIJ/bekendmakingen/GLEIF alleen op Davids eigen vraag (App), of op de naam uit het handelsregister als het
    # geen eenmanszaak is; Socev met een vrije naam krijgt alleen GLEIF op KvK-nummer en de insolventie-link.
    eenmans = bool(re.search(r'eenmans|sole|natuurlijk persoon|v\.?o\.?f|maatschap', str(kern.get('rechtsvorm') or ''), re.I))
    if ctx.wie == 'david':
        naam = kern.get('naam') or vies_naam or (t if not (kvk or dom or iban or btw) else None)
    else:
        naam = kern.get('naam') if kern.get('naam') and not eenmans else None
    if (naam or kvk) and ctx.niveau == 'alles':
        kaarten += bedrijf_breed(ctx, naam, kvk)
    elif ctx.niveau == 'alles':
        kaarten.append(insolventie_link())
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


# ---------------------------------------------------------------- juridische regel per bron (wv2698; uit de optielijst 7-11-2026, informatie, geen weigering)
JUR = {
    'pdok': 'Openbare overheidsdata (CC0): geen bezwaar.',
    'kvk': 'Organisaties: licht. Eenmanszaken bevatten persoonsgegevens (naam eigenaar). Liza en OpenCorporates: één pagina per vraag, gecachet.',
    'domein': 'Domeinregistratie, webarchief en certificaten: geen bezwaar.',
    'big': 'Openbaar register met wettelijk doel: waarnemers en sollicitanten controleren is precies waarvoor het bestaat.',
    'eigen': 'Eigen bron: blijft binnen ons systeem.',
    'telefoon': 'Offline duiding: er gaat niets naar buiten.',
    'vies': 'Btw-nummer controleren (EU): geen bezwaar. Bij een eenmanszaak is de naam die VIES teruggeeft een persoonsnaam.',
    'gleif': 'LEI-register (CC0): geen bezwaar.',
    'icij': 'In de Offshore Leaks staan is niet hetzelfde als iets fout gedaan hebben; een gelijke naam is niet dezelfde partij. Zorgvuldig formuleren.',
    'sru': 'Officieel gepubliceerd; voor een adres of bedrijf licht.',
    'rechtspraak': 'Namen van privépersonen zijn geanonimiseerd, bedrijven vaak niet. Strafrechtelijke gegevens (AVG art. 10) zijn gevoelig; bij bedrijven licht.',
    'insolventie': 'Openbaar met een wettelijk doel; een leverancier of huurder controleren past. Schuldsanering van een privépersoon: alleen bij een concreet zakelijk belang.',
    'rdw': 'Geen eigenaar, dus licht. Een kenteken van een bekende persoon blijft wel aan die persoon te koppelen.',
    'brk': 'Perceel zonder eigenaar: geen bezwaar. De eigenaar opvragen kan alleen per geval bij het Kadaster (€ 3,70 per bericht).',
    'adreslinks': 'WOZ-waarde is openbaar sinds 2016 (per adres handmatig); omgevingsregels en energielabel: geen bezwaar.',
    'exif': 'Lokaal: het bestand gaat niet naar buiten en wordt na het lezen gewist.',
    'mail': 'Eigen mail: geen bezwaar. Alleen IP-adressen en het afzenderdomein gaan naar de vrije diensten; de mailkop zelf niet.',
    'ip': 'IP-adres van een server: geen bezwaar.',
    'wmn': 'Op je eigen gebruikersnamen geen bezwaar. Dat een naam op een site bestaat, betekent niet dat het jouw account is: alles is "misschien".',
    'xon': 'Alleen je eigen adressen: dat is jouw keuze over jouw gegevens.',
    'hibp': 'Eigen domeinen: geen bezwaar.',
    'dnstwist': 'Eigen domeinen: geen bezwaar; alleen DNS-vragen gaan naar buiten.',
    'cbs': 'Geaggregeerde buurtcijfers (CBS, open data): geen bezwaar; ze gaan niet over één huishouden.',
    'lbm': 'Leefbaarometer (BZK, open data): buurtgemiddelde zonder persoonsgegevens; geen bezwaar.',
    'ahn': 'Hoogtekaart (AHN, open data): geen bezwaar.',
    'bodem': 'Bodeminformatie is openbaar (Bodemloket, omgevingsdiensten): geen bezwaar.',
    'straat': 'Straatfoto\'s van anderen (CC BY-SA): kijken is licht; doorplaatsen alleen met naamsvermelding. Mensen of kentekens op een foto niet herleiden.',
    'forensiek': 'Lokaal op de pod: de foto gaat niet naar buiten en wordt na het lezen gewist. De uitkomst is een aanwijzing, geen bewijs.',
}
DOMEINEN_STANDAARD = ['tolgaarde.nl', 'huisartsentolgaarde.nl', 'hpgroenhouten.nl', 'hapleusden.nl', 'socev.dev']
TOOLS = os.environ.get('OSINT_TOOLS') or '/opt/data/venvs/osint/tools'


def item(tekst, sub=None, url=None, nieuw=None):
    return {a: b for a, b in (('tekst', tekst), ('sub', sub), ('url', url), ('nieuw', nieuw)) if b not in (None, '', False)}


# ---------------------------------------------------------------- instellingen (alleen David, via de App)
def instellingen(c=None):
    c = c or db()
    uit = {'gebruikersnamen': [], 'adressen': [], 'domeinen': list(DOMEINEN_STANDAARD)}
    for k, j in c.execute("select sleutel, json from instelling where sleutel in ('gebruikersnamen', 'adressen', 'domeinen')"):
        try:
            uit[k] = json.loads(j)
        except ValueError:
            pass
    return uit


INST_VORM = {'gebruikersnamen': (re.compile(r'^[\w.-]{2,40}$'), 10), 'adressen': (re.compile(r'^[\w.+-]{1,64}@(?:[a-z0-9-]+\.)+[a-z]{2,}$', re.I), 10),
             'domeinen': (re.compile(r'^(?:[a-z0-9-]+\.)+[a-z]{2,}$'), 12)}


def zet_instellingen(v):
    """{gebruikersnamen|adressen|domeinen: [..]} → bewaard; ongeldige of BSN-achtige waarden worden geweigerd (met reden)."""
    c = db()
    geweigerd = []
    for k, (rx, n) in INST_VORM.items():
        if k not in v or not isinstance(v[k], list):
            continue
        goed = []
        for x in v[k][:n * 2]:
            x = norm(x).lower() if k != 'gebruikersnamen' else norm(x)
            if not x:
                continue
            if not rx.match(x) or any(elfproef(re.sub(r'\D', '', m.group(0))) for m in _BSN_RE.finditer(x)) or _PAT_RE.search(x):
                geweigerd.append(x[:60])
            elif x not in goed:
                goed.append(x)
        c.execute('insert or replace into instelling(sleutel, json, tijd) values (?,?,?)', (k, json.dumps(goed[:n]), nu_iso()))
    c.commit()
    return {'ok': True, 'instellingen': instellingen(c), 'geweigerd': geweigerd}


# ---------------------------------------------------------------- bedrijf breder (wv2698)
BTW_RE = re.compile(r'^([A-Z]{2})([0-9A-Z]{8,12})$')


def btw_uit(t):
    m = BTW_RE.match(re.sub(r'[\s.]', '', str(t or '')).upper())
    return (m.group(1), m.group(2)) if m and re.search(r'\d{6}', m.group(2)) else None


def vies(ctx, btw):
    b = btw_uit(btw)
    if not b:
        return None, None
    land, nr = b
    r = jhaal(ctx, 'EU VIES (btw)', 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms/%s/vat/%s' % (land, nr), 'btw-nummer ' + land + nr, timeout=20)
    if not isinstance(r, dict) or 'isValid' not in r:
        return melding('Btw-nummer (VIES)', 'VIES gaf geen antwoord (de EU-dienst ligt per land soms even stil).', 'EU VIES'), None
    adres = ', '.join(x.strip() for x in str(r.get('address') or '').split('\n') if x.strip() and x.strip() != '---')
    naam = r.get('name') if r.get('name') not in (None, '', '---') else None
    k = ctx.knoop('btw', land + nr, zoek={'ingang': 'bedrijf', 'term': land + nr})
    ctx.rand(getattr(ctx, 'hoofd', None), k, 'btw-nummer')
    if adres:
        ctx.rand(k, ctx.knoop('adres', adres, zoek={'ingang': 'adres', 'term': adres}), 'adres volgens VIES')
    return kaartje('Btw-nummer (VIES)', 'EU VIES (gratis, geen sleutel)', [
        ('Btw-nummer', land + nr), ('Geldig', 'ja' if r.get('isValid') else 'NEE'), ('Naam volgens de belastingdienst', naam),
        ('Adres volgens de belastingdienst', adres), ('Gecontroleerd op', datum_nl(r.get('requestDate')))],
        let=None if r.get('isValid') else 'Dit btw-nummer is volgens VIES niet (meer) geldig.', juridisch=JUR['vies']), naam


def gleif(ctx, kvk=None, naam=None):
    if kvk:
        q, nb = {'filter[entity.registeredAs]': kvk, 'filter[entity.jurisdiction]': 'NL', 'page[size]': 3}, 'KvK-nummer ' + kvk
    else:
        q, nb = {'filter[fulltext]': naam, 'page[size]': 5}, 'naam: ' + naam
    r = jhaal(ctx, 'GLEIF (LEI-register)', 'https://api.gleif.org/api/v1/lei-records?' + up.urlencode(q), nb, timeout=20)
    data = r.get('data') if isinstance(r, dict) else None
    if not data:
        return kaartje('LEI-register (GLEIF)', 'GLEIF (gratis, CC0)', klein='Geen LEI gevonden. Alleen grotere bedrijven en wie in effecten handelt heeft er een.',
                       juridisch=JUR['gleif'])
    a = data[0].get('attributes') or {}
    lei, e, reg = a.get('lei'), a.get('entity') or {}, a.get('registration') or {}
    adr = lambda x: ', '.join(y for y in ((' '.join((x or {}).get('addressLines') or [])), (x or {}).get('postalCode'), (x or {}).get('city'), (x or {}).get('country')) if y)
    fam = {}
    with cf.ThreadPoolExecutor(3) as ex:
        fut = {rel: ex.submit(jhaal, ctx, 'GLEIF (LEI-register)', 'https://api.gleif.org/api/v1/lei-records/%s/%s%s' % (lei, rel, '?page[size]=10' if rel == 'direct-children' else ''),
                              'LEI ' + lei, timeout=15) for rel in ('direct-parent', 'ultimate-parent', 'direct-children')}
        for rel, f in fut.items():
            try:
                fam[rel] = f.result()
            except PoortDicht:
                raise
            except Exception:
                fam[rel] = None
    ouder = lambda x: ('%s (%s)' % (x['data']['attributes']['entity']['legalName']['name'], x['data']['attributes']['lei'])) if isinstance(x, dict) and isinstance(x.get('data'), dict) else None
    kids = fam.get('direct-children') if isinstance(fam.get('direct-children'), dict) else {}
    kn = [d['attributes']['entity']['legalName']['name'] for d in kids.get('data') or [] if isinstance(d, dict)]
    ktot = ((kids.get('meta') or {}).get('pagination') or {}).get('total')
    k = ctx.knoop('lei', lei, label2=(e.get('legalName') or {}).get('name'))
    ctx.rand(getattr(ctx, 'hoofd', None), k, 'LEI')
    for rel, lab in (('direct-parent', 'moeder'), ('ultimate-parent', 'uiteindelijke moeder')):
        o = ouder(fam.get(rel))
        if o:
            ctx.rand(ctx.knoop('bedrijf', o.rsplit(' (', 1)[0], zoek={'ingang': 'bedrijf', 'term': o.rsplit(' (', 1)[0]}), k, lab)
    andere = ', '.join(x.get('name') for x in e.get('otherNames') or [] if isinstance(x, dict) and x.get('name'))
    return kaartje('LEI-register (GLEIF)', 'GLEIF (gratis, CC0)', [
        ('LEI', lei), ('Naam', (e.get('legalName') or {}).get('name')), ('Andere namen', andere), ('Status', e.get('status')),
        ('Registratienummer (KvK)', e.get('registeredAs')), ('Juridisch adres', adr(e.get('legalAddress'))), ('Hoofdkantoor', adr(e.get('headquartersAddress'))),
        ('Opgericht', datum_nl(e.get('creationDate'))), ('LEI-status', reg.get('status')), ('LEI uitgegeven', datum_nl(reg.get('initialRegistrationDate'))),
        ('Volgende verlenging', datum_nl(reg.get('nextRenewalDate'))), ('Directe moeder', ouder(fam.get('direct-parent'))),
        ('Uiteindelijke moeder', ouder(fam.get('ultimate-parent'))), ('Dochters (direct)', ('%s: %s' % (ktot, ', '.join(kn[:10]) + (' …' if (ktot or 0) > 10 else ''))) if ktot else None)],
        klein=('Ook %d andere treffers op deze naam.' % (len(data) - 1)) if len(data) > 1 and not kvk else None, juridisch=JUR['gleif'])


def icij(ctx, naam):
    r = jhaal(ctx, 'ICIJ Offshore Leaks', 'https://offshoreleaks.icij.org/api/v1/reconcile', 'naam: ' + naam, data={'queries': {'q0': {'query': naam}}}, timeout=20)
    res = ((r or {}).get('q0') or {}).get('result') or [] if isinstance(r, dict) else []
    res = [x for x in res if isinstance(x, dict)]
    sterk = [x for x in res if (x.get('score') or 0) >= 70]
    if not sterk:
        return kaartje('Offshore Leaks (ICIJ)', 'ICIJ Offshore Leaks (gratis)', klein='Geen sterke treffer op deze naam (%d zwakke).' % len(res) if res else 'Geen treffer op deze naam.',
                       juridisch=JUR['icij'])
    return kaartje('Offshore Leaks (ICIJ)', 'ICIJ Offshore Leaks (Panama, Paradise, Pandora Papers e.a.)', items=[
        item(x.get('name'), '%s · overeenkomst %d%%' % (x.get('description') or ', '.join(t.get('name', '') for t in x.get('types') or []), round(x.get('score') or 0)),
             'https://offshoreleaks.icij.org/nodes/%s' % x.get('id')) for x in sterk[:10]],
        klein='Een gelijke naam is niet dezelfde partij; %d sterke en %d zwakke treffers.' % (len(sterk), len(res) - len(sterk)), juridisch=JUR['icij'])


def sru_tekst(x):
    return x.get('$') if isinstance(x, dict) else x


def bekendmakingen(ctx, zoekterm, titel='Officiële bekendmakingen', naar=None, delen=None):
    """delen = lijst zoekwoorden die allemaal moeten voorkomen (bijv. straat + huisnummer en plaats)."""
    q = ' AND '.join('cql.textAndIndexes="%s"' % d.replace('"', '') for d in (delen or [zoekterm]) if d) + ' AND c.product-area==officielepublicaties'
    r = jhaal(ctx, 'Officiële bekendmakingen (SRU)', 'https://repository.overheid.nl/sru?' + up.urlencode({'query': q, 'maximumRecords': 25, 'httpAccept': 'application/json'}),
              naar or ('zoekterm: ' + zoekterm), timeout=25)
    srr = (r or {}).get('searchRetrieveResponse') or {} if isinstance(r, dict) else {}
    n = int(srr.get('numberOfRecords') or 0)
    rec = (srr.get('records') or {}).get('record') or []
    rec = [rec] if isinstance(rec, dict) else rec
    rij = []
    for x in rec:
        try:
            g = x['recordData']['gzd']
            meta = g['originalData']['meta']
        except (KeyError, TypeError):
            continue
        kern, mantel, tp = meta.get('owmskern') or {}, meta.get('owmsmantel') or {}, meta.get('tpmeta') or {}
        dt = mantel.get('available') or mantel.get('date') or kern.get('modified') or ''
        rij.append((str(dt), item(sru_tekst(kern.get('title')), ' · '.join(y for y in (datum_nl(dt), tp.get('publicatienaam') or sru_tekst(kern.get('type')),
                   sru_tekst(kern.get('creator'))) if y), (g.get('enrichedData') or {}).get('preferredUrl'))))
    rij.sort(key=lambda z: z[0], reverse=True)
    if not n:
        return kaartje(titel, 'Officiële bekendmakingen (overheid.nl, SRU)', klein='Niets gevonden in Staatscourant, gemeente-, provincie- of waterschapsblad.', juridisch=JUR['sru'])
    return kaartje(titel, 'Officiële bekendmakingen (overheid.nl, SRU)', items=[z[1] for z in rij[:12]],
                   klein='%d publicaties; hier de %d nieuwste van de eerste %d.' % (n, min(12, len(rij)), len(rij)), juridisch=JUR['sru'])


def rechtspraak(ctx, zoekterm):
    body = {'StartRow': 0, 'PageSize': 10, 'ShouldReturnHighlights': False, 'ShouldCountFacets': False, 'SortOrder': 'Relevance',
            'SearchTerms': [{'Term': zoekterm, 'Field': 'AlleVelden'}], 'Contentsoorten': [], 'Rechtsgebieden': [], 'Instanties': [],
            'DatumPublicatie': [], 'DatumUitspraak': [], 'Advanced': {'PublicatieStatus': 'AlleenGepubliceerd'}, 'CorrelationId': 'osint', 'Proceduresoorten': []}
    r = jhaal(ctx, 'Rechtspraak (uitspraken)', 'https://uitspraken.rechtspraak.nl/api/zoek', 'zoekterm: ' + zoekterm, data=body, timeout=25)
    if not isinstance(r, dict) or 'Results' not in r:
        return melding('Rechtspraak', 'De zoekdienst van de Rechtspraak gaf geen antwoord.', 'Rechtspraak')
    res = [x for x in r.get('Results') or [] if isinstance(x, dict)]
    if not res:
        return kaartje('Rechtspraak', 'Rechtspraak (uitspraken.rechtspraak.nl)', klein='Geen gepubliceerde uitspraak met deze naam.', juridisch=JUR['rechtspraak'])
    gebied = lambda x: ', '.join(x.get('Rechtsgebieden') or []) if isinstance(x.get('Rechtsgebieden'), list) else None
    return kaartje('Rechtspraak', 'Rechtspraak (uitspraken.rechtspraak.nl, gratis)', items=[
        item('%s · %s' % (x.get('Uitspraakdatum') or '', x.get('Titel') or x.get('TitelEmphasis')),
             ' · '.join(y for y in (x.get('TitelEmphasis'), gebied(x), (re.sub(r'\s+', ' ', x.get('Tekstfragment') or '')[:220] + '…') if x.get('Tekstfragment') else None) if y),
             x.get('DeeplinkUrl') or x.get('InterneUrl')) for x in res[:10]],
        klein='%s uitspraken gevonden; hier de %d meest passende.' % (r.get('ResultCount'), min(10, len(res))), juridisch=JUR['rechtspraak'])


def insolventie_link():
    return kaartje('Faillissement of surseance', 'Centraal Insolventieregister (rechtspraak.nl)', klein='Geen open zoekroute (alleen een webservice voor vaste afnemers); '
                   'zoek zelf op naam of KvK-nummer.', links=[item('Centraal Insolventieregister', None, 'https://insolventies.rechtspraak.nl/')], juridisch=JUR['insolventie'])


def bedrijf_breed(ctx, naam, kvk):
    """VIES zit apart (alleen met een btw-nummer). Hier: GLEIF, ICIJ, bekendmakingen, Rechtspraak, insolventie-link."""
    taken = []
    if kvk or naam:
        taken.append(('gleif', lambda: gleif(ctx, kvk=kvk) if kvk else gleif(ctx, naam=naam)))
    if naam:
        taken += [('icij', lambda: icij(ctx, naam)), ('sru', lambda: bekendmakingen(ctx, naam)), ('rs', lambda: rechtspraak(ctx, naam))]
    uit = []
    with cf.ThreadPoolExecutor(4) as ex:
        fut = [(k, ex.submit(f)) for k, f in taken]
        for k, f in fut:
            try:
                uit.append(f.result())
            except PoortDicht:
                pass
            except Exception:
                uit.append(melding({'gleif': 'LEI-register', 'icij': 'Offshore Leaks', 'sru': 'Officiële bekendmakingen', 'rs': 'Rechtspraak'}[k], 'Deze bron gaf geen antwoord.'))
    uit.append(insolventie_link())
    return uit


# ---------------------------------------------------------------- adres extra (wv2698)
def brk(ctx, lon, lat):
    d = 0.00001
    r = jhaal(ctx, 'Kadastrale kaart (PDOK BRK)', 'https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1/collections/perceel/items?' + up.urlencode(
        {'bbox': '%.6f,%.6f,%.6f,%.6f' % (lon - d, lat - d, lon + d, lat + d), 'limit': 5, 'f': 'json'}), 'punt van het adres (perceel)', timeout=20)
    fs = [f.get('properties') or {} for f in (r or {}).get('features') or [] if isinstance(f, dict)] if isinstance(r, dict) else []
    if not fs:
        return kaartje('Perceel (kadastrale kaart)', 'PDOK BRK (gratis, geen eigenaar)', klein='Geen perceel gevonden op dit punt.', juridisch=JUR['brk']), None
    p = fs[0]
    aand = ' '.join(str(x) for x in (p.get('kadastrale_gemeente_waarde'), p.get('sectie'), p.get('perceelnummer')) if x not in (None, ''))
    k = ctx.knoop('perceel', aand)
    ctx.rand(getattr(ctx, 'hoofd', None), k, 'ligt op perceel')
    return kaartje('Perceel (kadastrale kaart)', 'PDOK BRK kadastrale kaart (gratis, geen eigenaar)', [
        ('Kadastrale aanduiding', aand), ('Kadastrale gemeente (code)', '%s (%s)' % (p.get('kadastrale_gemeente_waarde'), p.get('akr_kadastrale_gemeente_code_waarde'))),
        ('Grootte', ('%s m²' % p.get('kadastrale_grootte_waarde')) if p.get('kadastrale_grootte_waarde') else None), ('Soort grootte', p.get('soort_grootte_waarde')),
        ('Perceel geldig sinds', datum_nl(p.get('begin_geldigheid'))), ('Andere percelen op dit punt', len(fs) - 1 or None)],
        links=[item('Eigenaar, hypotheek of koopsom opvragen (Kadaster, € 3,70 per bericht, alleen zelf per geval)', None,
                    'https://www.kadaster.nl/producten/woning/eigendomsinformatie')], juridisch=JUR['brk']), aand


def brk_veilig(ctx, ls):
    ll = [float(v) for v in re.findall(r'-?[\d.]+', ls.get('centroide_ll') or '')]
    if len(ll) != 2:
        return None
    try:
        return brk(ctx, ll[0], ll[1])
    except PoortDicht:
        raise
    except Exception:
        return melding('Perceel (kadastrale kaart)', 'De kadastrale kaart gaf geen antwoord.'), None


def ep_online(ctx, vbo_id):
    sl = sleutel('ep_online')
    if not sl or not vbo_id:
        return None
    r = jhaal(ctx, 'EP-online (energielabel)', 'https://public.ep-online.nl/api/v5/PandEnergielabel/AdresseerbaarObject/' + vbo_id, 'BAG-id ' + vbo_id,
              hdr={'Authorization': sl}, timeout=20)
    r = r[0] if isinstance(r, list) and r else r
    if not isinstance(r, dict):
        return kaartje('Energielabel', 'EP-online (RVO)', klein='Geen energielabel geregistreerd voor dit adres.', juridisch=JUR['adreslinks'])
    return kaartje('Energielabel', 'EP-online (RVO, gratis sleutel)', [(k, v) for k, v in r.items() if isinstance(v, (str, int, float)) and not isinstance(v, bool)][:24],
                   juridisch=JUR['adreslinks'])


def adres_links(ls):
    a = ls.get('weergavenaam') or ''
    q = up.quote(a)
    links = [item('WOZ-waarde per jaar (WOZ-waardeloket)', 'handmatig: typ het adres', 'https://www.wozwaardeloket.nl/'),
             item('Wat mag hier (Omgevingsloket, regels op de kaart)', None, 'https://omgevingswet.overheid.nl/regels-op-de-kaart'),
             item('Bestemmingsplan (Ruimtelijkeplannen)', None, 'https://www.ruimtelijkeplannen.nl/viewer?adres=' + q)]
    if not sleutel('ep_online'):
        links.append(item('Energielabel (EP-online)', 'automatisch zodra de gratis RVO-sleutel er is', 'https://www.ep-online.nl/Energylabel/Search'))
    return kaartje('Meer over dit adres', 'Links naar overheidsloketten', links=links, juridisch=JUR['adreslinks'])


# ---------------------------------------------------------------- adres deel 3 (wv2712): buurt, hoogte, bodem, straatbeeld
# Gratis sleutels (EP-online, Mapillary) komen van server.js via stdin (uit de kluis, alleen die twee namen); nooit in uitvoer, logboek of cache.
SLEUTELS = {}
SLEUTEL_ENV = {'ep_online': 'EP_ONLINE_SLEUTEL', 'mapillary': 'MAPILLARY_TOKEN'}


def sleutel_er(naam):
    return bool(sleutel(naam))


def sleutel(naam):
    w = SLEUTELS.get(naam) or os.environ.get(SLEUTEL_ENV[naam]) or ''
    return w.strip() or None


# CBS Kerncijfers wijken en buurten (gemeten 8-11-2026: 2026 deels gevuld, 2025 meer, 2024 bijna alles); per veld het nieuwste gevulde jaar.
CBS_TABELLEN = [('2026', '86358NED'), ('2025', '86165NED'), ('2024', '85984NED')]
CBS_LEEFTIJD = [('k_0Tot15Jaar', '0–15'), ('k_15Tot25Jaar', '15–25'), ('k_25Tot45Jaar', '25–45'), ('k_45Tot65Jaar', '45–65'), ('k_65JaarOfOuder', '65+')]
CBS_VELD = [('AantalInwoners', 'Inwoners', 'n'), ('HuishoudensTotaal', 'Huishoudens', 'n'), ('GemiddeldeHuishoudensgrootte', 'Gemiddelde huishoudensgrootte', 'x'),
            ('Bevolkingsdichtheid', 'Inwoners per km²', 'n'), ('Woningvoorraad', 'Woningen', 'n'),
            ('GemiddeldeWOZWaardeVanWoningen', 'Gemiddelde WOZ-waarde', 'k€'), ('Koopwoningen', 'Koopwoningen', '%'),
            ('InBezitWoningcorporatie', 'Huur van een corporatie', '%'), ('GemiddeldInkomenPerInwoner', 'Gemiddeld inkomen per inwoner', 'k€'),
            ('k_40PersonenMetLaagsteInkomen', 'Bij de 40 % laagste inkomens van NL', '%'), ('k_20PersonenMetHoogsteInkomen', 'Bij de 20 % hoogste inkomens van NL', '%'),
            ('MediaanVermogenVanParticuliereHuish', 'Mediaan vermogen huishoudens', 'k€'), ('PersonenInArmoede', 'In armoede', '%'),
            ('Nettoarbeidsparticipatie', 'Netto arbeidsparticipatie', '%'), ('BedrijfsvestigingenTotaal', 'Bedrijfsvestigingen', 'n'),
            ('AfstandTotHuisartsenpraktijk', 'Afstand tot een huisartsenpraktijk', 'km'), ('MateVanStedelijkheid', 'Stedelijkheid', 'stad')]
STEDELIJK = {1: 'zeer sterk stedelijk', 2: 'sterk stedelijk', 3: 'matig stedelijk', 4: 'weinig stedelijk', 5: 'niet stedelijk'}


def getal_nl(v, dec=0):
    s = ('{:,.%df}' % dec).format(v)
    return s.replace(',', '§').replace('.', ',').replace('§', '.')


def cbs_fmt(v, soort):
    if v is None:
        return None
    if soort == 'n':
        return getal_nl(v)
    if soort == 'x':
        return getal_nl(v, 1)
    if soort == 'k€':
        return '€ ' + getal_nl(v * 1000)
    if soort == '%':
        return getal_nl(v, 1 if v % 1 else 0) + ' %'
    if soort == 'km':
        return getal_nl(v, 1) + ' km'
    if soort == 'stad':
        return STEDELIJK.get(int(v), str(v))
    return str(v)


def cbs(ctx, bu, gm):
    """Buurtcijfers (geaggregeerd): één aanroep per jaartabel met buurt, gemeente en Nederland; naar buiten gaat alleen de buurtcode."""
    codes = [c for c in (bu, gm, 'NL00') if c]
    flt = ' or '.join("WijkenEnBuurten eq '%s'" % c.ljust(10) for c in codes)

    def een(jt):
        j, t = jt
        r = jhaal(ctx, 'CBS wijken en buurten ' + j, 'https://opendata.cbs.nl/ODataApi/odata/%s/TypedDataSet?%s' % (t, up.urlencode({'$filter': flt})),
                  'buurtcode %s (+ gemeente en Nederland)' % bu, timeout=20)
        rij = {}
        for x in ((r or {}).get('value') or []) if isinstance(r, dict) else []:
            if isinstance(x, dict):
                rij[str(x.get('WijkenEnBuurten') or '').strip()] = {re.sub(r'_\d+$', '', k): v for k, v in x.items()}
        return j, rij
    with cf.ThreadPoolExecutor(3) as ex:
        jaren = dict(ex.map(een, CBS_TABELLEN))
    if not any(bu in r for r in jaren.values()):
        return kaartje('Buurtcijfers (CBS)', 'CBS Kerncijfers wijken en buurten', klein='Het CBS gaf geen cijfers voor buurt %s.' % bu, juridisch=JUR['cbs'])

    def waarde(code, veld):
        for j, _ in CBS_TABELLEN:
            v = ((jaren.get(j) or {}).get(code) or {}).get(veld)
            if v is not None:
                return j, v
        return None, None
    velden = []
    for veld, label, soort in CBS_VELD:
        j, v = waarde(bu, veld)
        if v is None:
            continue
        rest = []
        for code, naam in ((gm, 'gemeente'), ('NL00', 'Nederland')):
            w = ((jaren.get(j) or {}).get(code) or {}).get(veld) if code else None
            if w is not None and veld not in ('AantalInwoners', 'HuishoudensTotaal', 'Woningvoorraad', 'BedrijfsvestigingenTotaal'):
                rest.append('%s %s' % (naam, cbs_fmt(w, soort)))
        velden.append(('%s (%s)' % (label, j), cbs_fmt(v, soort) + ('  (' + '; '.join(rest) + ')' if rest else '')))
    for j, _ in CBS_TABELLEN:   # leeftijd: het nieuwste jaar waarin alle vijf groepen er zijn
        r = (jaren.get(j) or {}).get(bu) or {}
        if r.get('AantalInwoners') and all(r.get(v) is not None for v, _ in CBS_LEEFTIJD):
            velden.insert(1, ('Leeftijd (%s)' % j, ' · '.join('%s: %d %%' % (lab, round(100.0 * r[v] / r['AantalInwoners'])) for v, lab in CBS_LEEFTIJD)))
            break
    j = next((j for j, _ in CBS_TABELLEN if (jaren.get(j) or {}).get(bu)), None)
    naam = (jaren.get(j) or {}).get(bu, {}).get('Gemeentenaam')
    return kaartje('Buurtcijfers (CBS)', 'CBS Kerncijfers wijken en buurten (open data)', velden,
                   klein='Buurt %s%s; tussen haakjes de gemeente en heel Nederland. Gemiddelden over de buurt, niet over dit adres.' % (bu, (' in ' + str(naam).strip()) if naam else ''),
                   links=[item('CBS-buurtcijfers op de kaart', None, 'https://www.cbsinuwbuurt.nl/')], juridisch=JUR['cbs'])


# Leefbaarometer 3.0 (BZK): WFS geo.leefbaarometer.nl, laag buurtscore<jj> (gemeten 8-11-2026). kscore 1..9; dimensies = bijdrage t.o.v. NL (+ = beter).
LBM_WFS = 'https://geo.leefbaarometer.nl/lbm3/ows'
LBM_KLASSE = {1: 'zeer onvoldoende', 2: 'ruim onvoldoende', 3: 'onvoldoende', 4: 'zwak', 5: 'voldoende', 6: 'ruim voldoende', 7: 'goed', 8: 'zeer goed', 9: 'uitstekend'}
LBM_DIM = [('won', 'Woningen'), ('fys', 'Fysieke omgeving'), ('vrz', 'Voorzieningen'), ('soc', 'Sociale samenhang'), ('onv', 'Overlast en onveiligheid')]


def leefbaarometer(ctx, bu):
    def een(j):
        q = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'typeNames': 'lbm3:buurtscore' + j, 'outputFormat': 'application/json',
             'count': 1, 'propertyName': 'id,name,gemeente,year,lbm,afw,fys,onv,soc,vrz,won,kscore', 'cql_filter': "id='%s'" % bu}
        r = jhaal(ctx, 'Leefbaarometer 20' + j, LBM_WFS + '?' + up.urlencode(q), 'buurtcode ' + bu, timeout=20)
        f = ((r or {}).get('features') or [None])[0] if isinstance(r, dict) else None
        return j, (f.get('properties') if isinstance(f, dict) else None)
    with cf.ThreadPoolExecutor(3) as ex:
        jr = dict(ex.map(een, ('24', '22', '20')))
    nu = jr.get('24') or jr.get('22')
    if not isinstance(nu, dict) or nu.get('kscore') is None:
        return kaartje('Leefbaarheid (Leefbaarometer)', 'Leefbaarometer 3.0 (BZK)', klein='Geen leefbaarheidsscore voor buurt %s.' % bu, juridisch=JUR['lbm'])
    ks = lambda p: ('%s (%s van 9)' % (LBM_KLASSE.get(int(p['kscore']), '?'), int(p['kscore']))) if isinstance(p, dict) and p.get('kscore') is not None else None
    tl = lambda v: (('+' if v >= 0 else '−') + getal_nl(abs(v), 3) + (' (beter dan gemiddeld)' if v > 0.005 else ' (slechter dan gemiddeld)' if v < -0.005 else ' (gemiddeld)'))
    velden = [('Oordeel %s' % nu.get('year'), ks(nu)),
              ('Door de jaren', ' → '.join('20%s: %s' % (j, LBM_KLASSE.get(int(jr[j]['kscore']), '?')) for j in ('20', '22', '24') if isinstance(jr.get(j), dict) and jr[j].get('kscore') is not None))]
    velden += [(n, tl(nu[k])) for k, n in LBM_DIM if isinstance(nu.get(k), (int, float))]
    return kaartje('Leefbaarheid (Leefbaarometer)', 'Leefbaarometer 3.0 (ministerie BZK, open data)', velden,
                   klein='Buurt %s (%s). De vijf regels zeggen hoeveel dat onderdeel de score van de buurt omhoog of omlaag duwt ten opzichte van heel Nederland.' % (nu.get('name') or bu, nu.get('gemeente') or ''),
                   links=[item('Leefbaarometer-kaart', None, 'https://www.leefbaarometer.nl/kaart/')], juridisch=JUR['lbm'])


AHN_WMS = 'https://service.pdok.nl/rws/ahn/wms/v1_0'


def ahn_punt(ctx, laag, x, y):
    q = {'service': 'WMS', 'version': '1.3.0', 'request': 'GetFeatureInfo', 'layers': laag, 'query_layers': laag, 'styles': '', 'crs': 'EPSG:28992',
         'bbox': '%.2f,%.2f,%.2f,%.2f' % (x - 1, y - 1, x + 1, y + 1), 'width': 3, 'height': 3, 'i': 1, 'j': 1, 'info_format': 'application/json'}
    r = jhaal(ctx, 'AHN hoogte (PDOK)', AHN_WMS + '?' + up.urlencode(q), 'punt bij het adres (RD-coördinaat)', timeout=20)
    for f in ((r or {}).get('features') or []) if isinstance(r, dict) else []:
        try:
            v = float(str(((f or {}).get('properties') or {}).get('value_list')).split(',')[0])
            if -50 < v < 400:
                return v
        except (TypeError, ValueError):
            pass
    return None


def ahn(ctx, x, y, beeld=None):
    """Maaiveld = mediaan van het terreinmodel (DTM) op 4 punten 15 m rond het adres (onder een gebouw heeft de DTM een gat);
    hoogste punt = oppervlaktemodel (DSM: dak, boom) op het adrespunt."""
    pt = [('dsm_05m', x, y)] + [('dtm_05m', x + dx, y + dy) for dx, dy in ((15, 0), (-15, 0), (0, 15), (0, -15))]
    with cf.ThreadPoolExecutor(5) as ex:
        w = list(ex.map(lambda a: ahn_punt(ctx, *a), pt))
    dak, grond = w[0], sorted(v for v in w[1:] if v is not None)
    mv = (grond[len(grond) // 2] if len(grond) % 2 else (grond[len(grond) // 2 - 1] + grond[len(grond) // 2]) / 2) if grond else None
    if dak is None and mv is None and not beeld:
        return kaartje('Hoogte (AHN)', 'Actueel Hoogtebestand Nederland (PDOK)', klein='Geen hoogte gevonden op dit punt.', juridisch=JUR['ahn'])
    velden = [('Maaiveld rond het adres', ('ca. %s m NAP' % getal_nl(mv, 1)) if mv is not None else None),
              ('Hoogste punt op het adrespunt (dak, boom)', ('ca. %s m NAP' % getal_nl(dak, 1)) if dak is not None else None),
              ('Hoogte boven maaiveld', ('ca. %s m' % getal_nl(dak - mv, 1)) if dak is not None and mv is not None else None)]
    return kaartje('Hoogte (AHN)', 'Actueel Hoogtebestand Nederland via PDOK (open data)', velden,
                   beelden=[{'titel': 'Hoogtekaart (AHN, oppervlak: hoe warmer, hoe hoger)', 'src': beeld}] if beeld else None,
                   klein='Indicatief: één punt uit een hoogtemodel van 50 cm, gemeten in de AHN-vliegjaren.',
                   links=[item('AHN-viewer (zelf inzoomen, ook bijgebouwen)', None, 'https://www.ahn.nl/ahn-viewer')], juridisch=JUR['ahn'])


BODEM_WMS = 'https://gis.gdngeoservices.nl/standalone/services/blk_gdn/lks_blk_rd_v1/MapServer/WMSServer'


def bodem(ctx, x, y):
    """Bodemloket (gemeten 8-11-2026): de laag Beschikbaarheid_gegevens noemt per plek het bevoegd gezag en waar de bodemgegevens staan;
    de laag WBB_locaties gaf op alle gemeten plekken niets meer (sinds de Omgevingswet bij de omgevingsdiensten) en wordt niet gevraagd."""
    q = {'service': 'WMS', 'version': '1.3.0', 'request': 'GetFeatureInfo', 'layers': 'Beschikbaarheid_gegevens', 'query_layers': 'Beschikbaarheid_gegevens',
         'styles': 'default', 'crs': 'EPSG:28992', 'bbox': '%.2f,%.2f,%.2f,%.2f' % (x - 50, y - 50, x + 50, y + 50), 'width': 101, 'height': 101,
         'i': 50, 'j': 50, 'info_format': 'application/geo+json', 'feature_count': 3}
    r = jhaal(ctx, 'Bodemloket', BODEM_WMS + '?' + up.urlencode(q), 'punt bij het adres (RD-coördinaat)', timeout=20)
    f = ((r or {}).get('features') or [None])[0] if isinstance(r, dict) else None
    p = (f or {}).get('properties') or {} if isinstance(f, dict) else {}
    jn = lambda v: {'J': 'ja', 'N': 'nee'}.get(str(v or '').upper())
    web = str(p.get('WEBSITE_URL') or '')
    links = [item('Bodemloket-kaart (zelf inzoomen op het adres)', None, 'https://www.bodemloket.nl/kaart')]
    if re.match(r'^https://[\w.-]+(/[\w./?=&%-]*)?$', web):
        links.insert(0, item('Bodeminformatie van %s' % (p.get('AUTHORITY_NM') or 'het bevoegd gezag'), 'daar staan de onderzoeken en saneringen', web))
    return kaartje('Bodem (Bodemloket)', 'Bodemloket (Rijkswaterstaat/provincies, open data)', [
        ('Bevoegd gezag bodem', p.get('AUTHORITY_NM')), ('Eigen bodemviewer', jn(p.get('WEBSITE_BLN'))), ('Dossiers in het Bodemloket', jn(p.get('DOSSIER_BLN')))],
        klein=None if p else 'Het Bodemloket gaf voor dit punt geen gegevens.', links=links, juridisch=JUR['bodem'])


def afstand_m(lon1, lat1, lon2, lat2):
    import math
    return int(round(math.hypot((lon2 - lon1) * 111320 * math.cos(math.radians(lat1)), (lat2 - lat1) * 110570)))


def host_publiek(h):
    """wv2712 (review-MOET 1): alle adressen van de host moeten publiek zijn (geen 10/8, 127/8, 169.254/16, 100.64/10, ::ffff:…, enz.).
    Toets: OSINT_NEP_DNS = json {host: ip}; in de nepstand zonder kaart = publiek (er gaat toch niets naar buiten)."""
    import ipaddress, socket
    if NEP:
        try:
            m = json.load(open(os.environ.get('OSINT_NEP_DNS') or '/dev/null'))
        except Exception:
            m = {}
        ips = [m.get(h, '93.184.216.34')]
    else:
        try:
            ips = sorted({a[4][0] for a in socket.getaddrinfo(h, 443, proto=socket.IPPROTO_TCP)})
        except OSError:
            return False
    try:
        adr = [ipaddress.ip_address(str(i).split('%')[0]) for i in ips]
    except ValueError:
        return False
    return bool(adr) and all(a.is_global and not a.is_multicast and (getattr(a, 'ipv4_mapped', None) is None or a.ipv4_mapped.is_global) for a in adr)


def foto_url_ok(u):
    p = up.urlsplit(str(u or ''))
    h = p.hostname or ''
    return p.scheme == 'https' and p.port in (None, 443) and re.fullmatch(r'(?:[a-z0-9-]+\.)+[a-z]{2,}', h) is not None and host_publiek(h)


def mini(ctx, bron, url):
    """Miniatuur van een straatfoto: alleen https naar een publieke host (url uit het antwoord van de dienst), geen doorsturen, ≤ 400 kB en ≤ 15 s."""
    if not foto_url_ok(url):
        return None
    try:
        st, x = haal(ctx, bron, url, 'foto-id van de dienst (geen adres)', binair=True, timeout=8, maxb=400_000, redirects=False, totaal=15, metcode=True)
    except PoortDicht:
        raise
    except Exception:
        return None
    return ('data:image/jpeg;base64,' + base64.b64encode(x).decode()) if st in ('200', 'nep') and x and x[:3] == b'\xff\xd8\xff' else None


def straatbeeld(ctx, lon, lat):
    """Straatfoto's binnen ± 100 m: Panoramax (vrij, CC BY-SA) en Mapillary (alleen met Davids gratis sleutel); alleen in de App (beelden)."""
    dx, dy = 0.0015, 0.001
    bbox = '%.6f,%.6f,%.6f,%.6f' % (lon - dx, lat - dy, lon + dx, lat + dy)
    fotos, klein = [], []
    r = jhaal(ctx, 'Panoramax (straatbeeld)', 'https://api.panoramax.xyz/api/search?' + up.urlencode({'bbox': bbox, 'limit': 50}),
              'kaartvak rond het adres (± 200 x 200 m)', timeout=20)
    for f in ((r or {}).get('features') or []) if isinstance(r, dict) else []:
        try:
            c = f['geometry']['coordinates']
            p = f.get('properties') or {}
            fotos.append({'dienst': 'Panoramax', 'id': str(f.get('id') or ''), 'm': afstand_m(lon, lat, float(c[0]), float(c[1])),
                          'datum': datum_nl(p.get('datetime')), 'door': p.get('geovisio:producer'),
                          'mini': p.get('geovisio:thumbnail') or (((f.get('assets') or {}).get('thumb') or {}).get('href')),
                          'url': 'https://api.panoramax.xyz/#focus=pic&pic=%s' % up.quote(str(f.get('id') or ''))})
        except (KeyError, TypeError, ValueError, IndexError):
            continue
    tok = sleutel('mapillary')
    if tok:
        r = jhaal(ctx, 'Mapillary (straatbeeld)', 'https://graph.mapillary.com/images?' + up.urlencode(
            {'fields': 'id,captured_at,computed_geometry,thumb_256_url', 'bbox': bbox, 'limit': 50}), 'kaartvak rond het adres (± 200 x 200 m)',
            hdr={'Authorization': 'OAuth ' + tok}, timeout=20)
        if isinstance(r, dict) and r.get('error'):
            klein.append('Mapillary weigerde de sleutel (fout %s): vervang hem in Sleutelbos.' % str((r.get('error') or {}).get('code'))[:6])
        for f in ((r or {}).get('data') or []) if isinstance(r, dict) else []:
            try:
                c = (f.get('computed_geometry') or {})['coordinates']
                t = datetime.datetime.fromtimestamp(int(f.get('captured_at') or 0) / 1000, datetime.timezone.utc).date().isoformat() if f.get('captured_at') else None
                fotos.append({'dienst': 'Mapillary', 'id': str(f.get('id') or ''), 'm': afstand_m(lon, lat, float(c[0]), float(c[1])), 'datum': datum_nl(t),
                              'mini': f.get('thumb_256_url'), 'url': 'https://www.mapillary.com/app/?pKey=%s' % up.quote(str(f.get('id') or ''))})
            except (KeyError, TypeError, ValueError, IndexError):
                continue
    else:
        klein.append('Mapillary komt erbij zodra de gratis sleutel er is.')
    fotos = sorted((f for f in fotos if f['m'] <= 150), key=lambda f: f['m'])[:4]
    with cf.ThreadPoolExecutor(4) as ex:
        minis = list(ex.map(lambda f: mini(ctx, f['dienst'] + ' (foto)', f['mini']), fotos))
    beelden = [{'titel': '%s · %d m · %s%s' % (f['dienst'], f['m'], f['datum'] or '?', (' · ' + str(f['door'])[:40]) if f.get('door') else ''), 'src': m, 'foto': True}
               for f, m in zip(fotos, minis) if m]
    links = [item('%s, %d m, %s' % (f['dienst'], f['m'], f['datum'] or '?'), 'grote foto en rondkijken', f['url']) for f in fotos]
    links.append(item('Google Street View (opent Google Maps; gaat pas naar Google als je tikt)', None,
                      'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=%.6f,%.6f' % (lat, lon)))
    if not fotos:
        klein.insert(0, 'Geen vrije straatfoto\'s binnen 150 m (Panoramax is dun buiten de grote steden).')
    return kaartje('Straatbeeld', 'Panoramax (CC BY-SA)' + (', Mapillary (CC BY-SA)' if tok else ''), beelden=beelden, links=links,
                   klein=' '.join(klein) or None, juridisch=JUR['straat'])


def adres_deel3(ctx, ls, beelden):
    """Buurt (CBS + Leefbaarometer), hoogte (AHN), bodem (Bodemloket) en straatbeeld bij een gevonden adres; elk kaartje los, een fout kost alleen dat kaartje."""
    bu = str(ls.get('buurtcode') or '').strip().upper()
    gm = ('GM' + str(ls.get('gemeentecode'))) if re.fullmatch(r'\d{4}', str(ls.get('gemeentecode') or '')) else None
    rd = [float(v) for v in re.findall(r'[\d.]+', ls.get('centroide_rd') or '')]
    ll = [float(v) for v in re.findall(r'-?[\d.]+', ls.get('centroide_ll') or '')]
    taken = []
    if re.fullmatch(r'BU\d{8}', bu):
        taken += [lambda: cbs(ctx, bu, gm), lambda: leefbaarometer(ctx, bu)]
    if len(rd) == 2:
        taken += [lambda: ahn(ctx, rd[0], rd[1], (beelden or {}).get('ahn')), lambda: bodem(ctx, rd[0], rd[1])]
    if len(ll) == 2 and ctx.beelden:
        taken.append(lambda: straatbeeld(ctx, ll[0], ll[1]))
    uit = []
    with cf.ThreadPoolExecutor(5) as ex:
        for f in [ex.submit(t) for t in taken]:
            try:
                k = f.result()
                if k:
                    uit.append(k)
            except PoortDicht:
                pass
            except Exception:
                pass
    return uit


# ---------------------------------------------------------------- kenteken (wv2698; RDW open data, geen eigenaar)
KENTEKEN_RE = re.compile(r'^(?=(?:[A-Z0-9]-?){6}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]{1,3}-?[A-Z0-9]{1,4}-?[A-Z0-9]{1,3}$')
RDW = 'https://opendata.rdw.nl/resource/'
RDW_VELD = [('merk', 'Merk'), ('handelsbenaming', 'Model'), ('voertuigsoort', 'Soort'), ('inrichting', 'Inrichting'), ('eerste_kleur', 'Kleur'),
            ('tweede_kleur', 'Tweede kleur'), ('datum_eerste_toelating', 'Eerste toelating'), ('datum_eerste_tenaamstelling_in_nederland', 'Eerste tenaamstelling in NL'),
            ('datum_tenaamstelling', 'Laatste tenaamstelling'), ('vervaldatum_apk', 'APK geldig tot'), ('wam_verzekerd', 'WAM-verzekerd'),
            ('openstaande_terugroepactie_indicator', 'Openstaande terugroepactie'), ('tellerstandoordeel', 'Tellerstand'), ('export_indicator', 'Geëxporteerd'),
            ('taxi_indicator', 'Taxi'), ('aantal_zitplaatsen', 'Zitplaatsen'), ('cilinderinhoud', 'Cilinderinhoud (cc)'), ('massa_rijklaar', 'Massa rijklaar (kg)'),
            ('catalogusprijs', 'Catalogusprijs (€)'), ('europese_voertuigcategorie', 'EU-categorie'), ('typegoedkeuringsnummer', 'Typegoedkeuring')]


def zoek_kenteken(ctx, term):
    k = re.sub(r'[^A-Z0-9]', '', norm(term).upper())
    if len(k) != 6 or not re.search(r'[A-Z]', k) or not re.search(r'\d', k):
        return [melding('Kenteken', 'Dit lijkt geen Nederlands kenteken (6 letters en cijfers).', 'RDW')], {}
    nb = 'kenteken ' + k
    sets = {'voertuig': 'm9d7-ebf2', 'brandstof': '8ys7-d773', 'terugroep': 't49b-isb7', 'keuring': 'sgfe-77wx'}
    with cf.ThreadPoolExecutor(4) as ex:
        fut = {n: ex.submit(jhaal, ctx, 'RDW open data (%s)' % n, RDW + s + '.json?' + up.urlencode({'kenteken': k}), nb, timeout=15) for n, s in sets.items()}
        r = {}
        for n, f in fut.items():
            try:
                r[n] = f.result()
            except PoortDicht:
                raise
            except Exception:
                r[n] = None
    v = (r['voertuig'] or [None])[0] if isinstance(r['voertuig'], list) else None
    if not v:
        return [kaartje('Kenteken', 'RDW open data (gratis, geen eigenaar)', [('Kenteken', k)], klein='Niet gevonden bij de RDW.', juridisch=JUR['rdw'])], {'gevonden': False}
    dat = lambda x: datum_nl(x) if re.fullmatch(r'\d{8}', str(x or '')) else x
    velden = [('Kenteken', k)] + [(lab, dat(v.get(sl))) for sl, lab in RDW_VELD]
    br = ['%s%s' % (b.get('brandstof_omschrijving'), (' (%s)' % b['emissiecode_omschrijving']) if b.get('emissiecode_omschrijving') else '') for b in r['brandstof'] or [] if isinstance(b, dict)]
    velden.append(('Brandstof', ', '.join(br)))
    tr = [t for t in r['terugroep'] or [] if isinstance(t, dict)]
    kr = sorted([x for x in r['keuring'] or [] if isinstance(x, dict)], key=lambda x: str(x.get('meld_datum_door_keuringsinstantie')), reverse=True)
    items = [item('Terugroepactie %s' % t.get('referentiecode_rdw'), t.get('status'), 'https://www.rdw.nl/terugroepacties') for t in tr[:6]]
    items += [item('Keuring %s' % datum_nl(x.get('meld_datum_door_keuringsinstantie')), ' · '.join(y for y in (x.get('soort_melding_ki_omschrijving'), x.get('soort_erkenning_omschrijving')) if y))
              for x in kr[:6]]
    kn = ctx.knoop('kenteken', k, label2=' '.join(x for x in (v.get('merk'), v.get('handelsbenaming')) if x), zoek={'ingang': 'kenteken', 'term': k})
    ctx.hoofd = kn
    return [kaartje('Kenteken', 'RDW open data (gratis, geen eigenaar)', velden, items=items or None,
                    let='Er staat een terugroepactie open.' if v.get('openstaande_terugroepactie_indicator') == 'Ja' else None, juridisch=JUR['rdw'])], {
        'gevonden': True, 'merk': v.get('merk'), 'model': v.get('handelsbenaming')}


# ---------------------------------------------------------------- mail duiden (wv2698; kop plakken in de App)
PRIV_IP = re.compile(r'^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)')
IP4 = r'(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])'


def dom_van(adres):
    m = re.search(r'@([\w.-]+\.[a-z]{2,})', str(adres or ''), re.I)
    return m.group(1).lower() if m else None


def dns_txt(ctx, naam, bron):
    poort_open(ctx, bron, 'extern', 'DNS', 'domein ' + naam)
    t = time.time()
    status = 'fout'
    try:
        if NEP:
            status = 'nep'
            return []
        import dns.resolver
        try:
            a = dns.resolver.resolve(naam, 'TXT', lifetime=6)
            status = '200'
            return [b''.join(x.strings).decode('utf-8', 'replace') for x in a]
        except Exception as e:
            status = type(e).__name__
            return None if status == 'NXDOMAIN' else []
    finally:
        ctx.log.append({'bron': bron, 'soort': 'extern', 'host': 'DNS', 'naar_buiten': 'domein ' + naam, 'status': status, 'ms': int((time.time() - t) * 1000)})


def ip_info(ctx, ip):
    with cf.ThreadPoolExecutor(4) as ex:
        f = {'shodan': ex.submit(jhaal, ctx, 'Shodan InternetDB', 'https://internetdb.shodan.io/' + ip, 'IP ' + ip, timeout=12),
             'prefix': ex.submit(jhaal, ctx, 'RIPEstat', 'https://stat.ripe.net/data/prefix-overview/data.json?resource=' + ip, 'IP ' + ip, timeout=12),
             'geo': ex.submit(jhaal, ctx, 'RIPEstat', 'https://stat.ripe.net/data/maxmind-geo-lite/data.json?resource=' + ip, 'IP ' + ip, timeout=12),
             'rdap': ex.submit(jhaal, ctx, 'RDAP (IP-register)', 'https://rdap.org/ip/' + ip, 'IP ' + ip, timeout=12)}
        r = {}
        for k, x in f.items():
            try:
                r[k] = x.result()
            except PoortDicht:
                raise
            except Exception:
                r[k] = None
    sh = r['shodan'] if isinstance(r['shodan'], dict) else {}
    pd = ((r['prefix'] or {}).get('data') or {}) if isinstance(r['prefix'], dict) else {}
    asn = ', '.join('AS%s %s' % (a.get('asn'), a.get('holder')) for a in pd.get('asns') or [] if isinstance(a, dict))
    geo = (((r['geo'] or {}).get('data') or {}).get('located_resources') or []) if isinstance(r['geo'], dict) else []
    plek = ', '.join(sorted({' '.join(y for y in (l.get('city'), l.get('country')) if y) for g in geo for l in g.get('locations') or [] if isinstance(l, dict)} - {''}))
    rd = r['rdap'] if isinstance(r['rdap'], dict) else {}
    return {'asn': asn, 'net': rd.get('name'), 'land': rd.get('country'), 'plek': plek, 'poorten': sh.get('ports'), 'namen': sh.get('hostnames'),
            'kwetsbaar': sh.get('vulns'), 'tags': sh.get('tags'), 'prefix': pd.get('resource')}


TECH_KOP = re.compile(r'^(received|received-spf|authentication-results|arc-[\w-]+|dkim-signature|x-google-[\w-]+|x-received|x-gm-[\w-]+|message-id|'
                      r'mime-version|content-type|content-transfer-encoding|delivered-to|x-ms-[\w-]+|x-forefront-[\w-]+|x-microsoft-[\w-]+|feedback-id|list-unsubscribe(-post)?)$', re.I)


def kop_voor_poort(kop):
    """De kopregels die mensen schrijven (From, To, Subject, Reply-To, …) voor de vormcontrole van de poort; machineregels (Received,
    Authentication-Results, DKIM, …) niet: daarin staan woorden als client-ip en lange id's die vals alarm geven. Nooit de inhoud."""
    tekst = kop.replace('\r\n', '\n')
    if '\n\n' in tekst.strip():
        tekst = tekst.strip().split('\n\n', 1)[0]
    uit, mee = [], False
    for r in tekst.split('\n'):
        if r[:1] in (' ', '\t'):
            if mee:
                uit.append(r)
            continue
        naam = r.split(':', 1)[0].strip()
        mee = ':' in r and not TECH_KOP.match(naam)
        if mee:
            uit.append(r)
    return '\n'.join(uit)


def zoek_mail(ctx, kop):
    import email
    tekst = kop.replace('\r\n', '\n')
    if '\n\n' in tekst.strip():
        tekst = tekst.strip().split('\n\n', 1)[0]   # alleen de kop, nooit de inhoud
    m = email.message_from_string(tekst + '\n\n')
    if not m.keys():
        return [melding('Mailkop', 'Geen mailkop herkend. Plak de volledige kop (in Gmail: ⋮ › Origineel weergeven, alles tot de eerste lege regel).')], {}
    alle = lambda h: [str(x) for x in (m.get_all(h) or [])]
    van, rp, rt = m.get('From'), m.get('Return-Path'), m.get('Reply-To')
    dv, drp, drt = dom_van(van), dom_van(rp), dom_van(rt)
    auth = ' '.join(alle('Authentication-Results') + alle('ARC-Authentication-Results'))
    zoekw = lambda w: (re.search(r'\b%s=(\w+)' % w, auth, re.I) or [None, None])[1]
    dkim_d = sorted(set(re.findall(r'header\.[di]=@?([\w.-]+)', auth))) or sorted(set(re.findall(r'\bd=([\w.-]+)', ' '.join(alle('DKIM-Signature')))))
    rec = alle('Received')
    hops, ips = [], []
    for r in rec:
        frm = (re.search(r'from\s+([\w.-]+)', r) or [None, None])[1]
        by = (re.search(r'\bby\s+([\w.:-]+)', r) or [None, None])[1]
        ip = [x for x in re.findall(IP4, r) if not PRIV_IP.match(x) and all(int(p) < 256 for p in x.split('.'))]
        tijd = r.rsplit(';', 1)[-1].strip()[:40] if ';' in r else None
        hops.append(item('%s → %s' % (frm or '?', by or '?'), ' · '.join(y for y in (', '.join(ip), tijd) if y)))
        ips += [x for x in ip if x not in ips]
    spf_ip = re.findall(r'client-ip=' + IP4, ' '.join(alle('Received-SPF')) + ' ' + auth)
    oorsprong = (spf_ip[0] if spf_ip else None) or (ips[-1] if ips else None)
    let = []
    if (zoekw('spf') or '').lower() not in ('', 'pass'):
        let.append('SPF: %s' % zoekw('spf'))
    if (zoekw('dkim') or '').lower() not in ('', 'pass'):
        let.append('DKIM: %s' % zoekw('dkim'))
    if (zoekw('dmarc') or '').lower() not in ('', 'pass', 'bestguesspass'):
        let.append('DMARC: %s' % zoekw('dmarc'))
    if drt and dv and drt != dv:
        let.append('antwoorden gaat naar een ander domein (%s) dan de afzender (%s)' % (drt, dv))
    if drp and dv and not (drp == dv or drp.endswith('.' + dv) or dv.endswith('.' + drp)):
        let.append('het retouradres hoort bij %s, de afzender bij %s (bij nieuwsbrieven en facturatiediensten normaal)' % (drp, dv))
    if dv and dkim_d and not any(d == dv or dv.endswith('.' + d) or d.endswith('.' + dv) for d in dkim_d):
        let.append('de DKIM-handtekening is van %s, niet van het afzenderdomein' % ', '.join(dkim_d))
    kaarten = [kaartje('De mail (uit de kop)', 'Mailkop (lokaal gelezen)', [
        ('Afzenderdomein', dv), ('Retourdomein (Return-Path)', drp), ('Antwoorden naar (domein)', drt), ('Datum', m.get('Date')),
        ('Message-ID-domein', (re.search(r'@([\w.-]+)>?', m.get('Message-ID') or '') or [None, None])[1]), ('Programma', m.get('X-Mailer') or m.get('User-Agent')),
        ('SPF', zoekw('spf')), ('DKIM', ('%s (%s)' % (zoekw('dkim'), ', '.join(dkim_d))) if zoekw('dkim') else (', '.join(dkim_d) or None)), ('DMARC', zoekw('dmarc')),
        ('Servers onderweg', len(rec)), ('Oorspronkelijke server (IP)', oorsprong)],
        let=('Let op: ' + '; '.join(let) + '.') if let else None, juridisch=JUR['mail'])]
    if hops:
        kaarten.append(kaartje('De route (nieuwste bovenaan)', 'Received-regels (lokaal)', items=hops[:15], juridisch=JUR['mail']))
    kern = {'spf': zoekw('spf'), 'dkim': zoekw('dkim'), 'dmarc': zoekw('dmarc'), 'afzenderdomein': dv, 'oorsprong': oorsprong, 'signalen': len(let)}
    km = ctx.knoop('mail', 'mail %s' % (dv or '?'))
    ctx.hoofd = km
    if dv:
        ctx.rand(km, ctx.knoop('domein', dv, zoek={'ingang': 'bedrijf', 'term': dv}), 'afzender')
    if drt and drt != dv:
        ctx.rand(km, ctx.knoop('domein', drt, zoek={'ingang': 'bedrijf', 'term': drt}), 'antwoorden naar')
    if ctx.niveau == 'niets':
        return kaarten, kern
    try:
        if dv:
            txt = dns_txt(ctx, dv, 'DNS (SPF/DMARC)')
            if txt is None:
                kaarten.append(kaartje('Mailbeveiliging van het afzenderdomein', 'DNS (%s)' % dv, let='Het afzenderdomein %s bestaat niet in DNS: zeer verdacht.' % dv,
                                       juridisch=JUR['mail']))
            else:
                spf = [t for t in txt if t.lower().startswith('v=spf1')]
                dm = [t for t in dns_txt(ctx, '_dmarc.' + dv, 'DNS (SPF/DMARC)') or [] if t.lower().startswith('v=dmarc1')]
                kaarten.append(kaartje('Mailbeveiliging van het afzenderdomein', 'DNS (SPF/DMARC van %s)' % dv, [
                    ('SPF-regel', spf[0][:300] if spf else 'geen: iedereen kan mail namens dit domein sturen'), ('DMARC-beleid', dm[0][:300] if dm else 'geen DMARC')],
                    juridisch=JUR['mail']))
        for ip in ([oorsprong] if oorsprong else []) + [x for x in ips if x != oorsprong][:2]:
            x = ip_info(ctx, ip)
            ki = ctx.knoop('ip', ip)
            ctx.rand(km, ki, 'kwam via' if ip != oorsprong else 'verstuurd vanaf')
            if x['asn']:
                ctx.rand(ki, ctx.knoop('netwerk', x['asn']), 'netwerk')
            kaarten.append(kaartje('Server %s%s' % (ip, ' (oorsprong)' if ip == oorsprong else ''), 'Shodan InternetDB, RIPEstat, RDAP (gratis)', [
                ('Netwerk (ASN)', x['asn']), ('Netblok', x['prefix']), ('Netnaam', x['net']), ('Land (register)', x['land']), ('Plek (MaxMind, grof)', x['plek']),
                ('Servernamen', ', '.join((x['namen'] or [])[:6])), ('Open poorten', ', '.join(map(str, x['poorten'] or []))),
                ('Bekende kwetsbaarheden', ', '.join((x['kwetsbaar'] or [])[:8])), ('Kenmerken', ', '.join(x['tags'] or []))], juridisch=JUR['ip']))
    except PoortDicht:
        pass
    except Exception as e:
        kaarten.append(melding('Afzenderdomein en servers', 'De DNS- of IP-opzoeking mislukte (%s); de duiding hierboven komt alleen uit de kop.' % type(e).__name__))
    return kaarten, kern


# ---------------------------------------------------------------- bestand duiden (wv2698; ExifTool lokaal, bestand na het lezen gewist)
EXIF_GROEPEN = [('Maker', ('Author', 'Creator', 'LastModifiedBy', 'Artist', 'Company', 'Manager', 'Owner', 'OwnerName')),
                ('Programma', ('Producer', 'CreatorTool', 'Software', 'Application', 'AppVersion', 'HistorySoftwareAgent', 'Generator')),
                ('Datums', ('CreateDate', 'ModifyDate', 'MetadataDate', 'DateTimeOriginal', 'CreationDate', 'LastPrinted', 'HistoryWhen')),
                ('Plek', ('GPSPosition', 'GPSLatitude', 'GPSLongitude', 'GPSAltitude')), ('Camera', ('Make', 'Model', 'LensModel', 'SerialNumber')),
                ('Document', ('PDFVersion', 'PageCount', 'Pages', 'Linearized', 'Encryption', 'Title', 'Subject', 'Keywords', 'DocumentID', 'InstanceID',
                              'HistoryAction', 'TotalEditTime', 'RevisionNumber', 'Words', 'Template'))]
BEWERKERS = re.compile(r'photoshop|gimp|ilovepdf|smallpdf|sejda|pdf-?xchange|foxit phantom|pdfescape|pdffiller|canva|paint\.net|pixlr|word|libreoffice|nitro', re.I)


def exiftool():
    p = os.environ.get('OSINT_EXIFTOOL') or os.path.join(TOOLS, 'exiftool', 'exiftool')
    return p if os.path.exists(p) else None


def poort_vorm(tekst):
    """Alleen de vormkant van de poort (BSN, patiëntkenmerk, patiëntpoort) → reden of None."""
    p = poort(tekst, 'david', 'david', 'bestand', 'anders')
    return p['reden'] if p['niveau'] == 'niets' else None


def zoek_bestand(ctx, inhoud, naam):
    import tempfile, shutil
    et = exiftool()
    if not et:
        # wv2712: zonder ExifTool alleen de poort op de naam, dan de (lokale) fotoforensiek
        reden = poort_vorm(naam or '')
        if reden:
            return [kaartje('Poort', 'OVIS OSINT-poort', let='Dit bestand bevat een kenmerk dat op een patiënt kan wijzen (%s); er wordt niets getoond.' % reden)], {'poort': 'dicht'}
        fk, fkern = forensiek(inhoud)
        return [melding('Bestand', 'ExifTool ontbreekt op de pod: geen metadata.')] + fk, fkern
    ext = (re.search(r'\.([A-Za-z0-9]{1,5})$', naam or '') or [None, 'bin'])[1].lower()
    d = tempfile.mkdtemp(prefix='osint-')
    try:
        os.chmod(d, 0o700)
        p = os.path.join(d, 'stuk.' + ext)
        with open(p, 'wb') as f:
            f.write(inhoud)
        r = subprocess.run(['perl', et, '-j', '-G1', '-a', '-s', '-api', 'LargeFileSupport=1', p], capture_output=True, text=True, timeout=40)
        js = json.loads(r.stdout or '[]')
    except Exception as e:
        return [melding('Bestand', 'ExifTool kon dit bestand niet lezen (%s).' % type(e).__name__)], {}
    finally:
        shutil.rmtree(d, ignore_errors=True)
    meta = js[0] if js and isinstance(js[0], dict) else {}
    meta = {k: v for k, v in meta.items() if not k.startswith(('System:', 'ExifTool:')) and k != 'SourceFile'}
    tekst = ' '.join('%s %s' % (k, v) for k, v in meta.items())
    reden = poort_vorm((naam or '') + ' ' + tekst[:200000])
    if reden:
        return [kaartje('Poort', 'OVIS OSINT-poort', let='Dit bestand bevat een kenmerk dat op een patiënt kan wijzen (%s); de metadata wordt niet getoond.' % reden)], {'poort': 'dicht'}
    kort = lambda v: (', '.join(map(str, v)) if isinstance(v, list) else str(v))[:240]
    groepen, gezien = [], set()
    for titel, tags in EXIF_GROEPEN:
        rij = [(k, kort(v)) for k, v in meta.items() if k.split(':', 1)[-1] in tags]
        gezien.update(k for k, _ in rij)
        if rij:
            groepen.append((titel, rij))
    sig = []
    cd = [v for k, v in meta.items() if k.endswith(':CreateDate') or k.endswith(':CreationDate')]
    md = [v for k, v in meta.items() if k.endswith(':ModifyDate')]
    if cd and md and str(cd[0])[:16] != str(md[0])[:16]:
        sig.append('gewijzigd na het maken (%s → %s)' % (str(cd[0])[:19], str(md[0])[:19]))
    prog = sorted({kort(v) for k, v in meta.items() if k.split(':', 1)[-1] in ('Producer', 'CreatorTool', 'Software', 'HistorySoftwareAgent')})
    bew = [x for x in prog if BEWERKERS.search(x)]
    if bew:
        sig.append('gemaakt of bewerkt met %s' % ', '.join(bew))
    if len(prog) > 1:
        sig.append('meer dan één programma: %s' % ', '.join(prog[:4]))
    if any(k.split(':', 1)[-1] == 'HistoryAction' for k in meta):
        sig.append('het bestand heeft een bewerkingsgeschiedenis (XMP)')
    versie = (js[0].get('ExifTool:ExifToolVersion') if js and isinstance(js[0], dict) else None) or ''
    kaarten = [kaartje('Het bestand', ('ExifTool %s (lokaal)' % versie).replace('  ', ' '), [
        ('Soort', meta.get('File:FileType')), ('Grootte', meta.get('File:FileSize')), ('MIME', meta.get('File:MIMEType'))],
        let=('Let op: ' + '; '.join(sig) + '. Dit is een aanwijzing, geen bewijs.') if sig else None,
        klein=None if sig else 'Geen opvallende sporen van bewerking in de metadata (ontbreken bewijst niets: metadata is makkelijk te wissen).', juridisch=JUR['exif'])]
    for titel, rij in groepen:
        kaarten.append(kaartje(titel, 'ExifTool (lokaal)', rij))
    rest = [(k, kort(v)) for k, v in meta.items() if k not in gezien and not k.startswith('File:')]
    if rest:
        kaarten.append(kaartje('Alle overige metadata (%d velden)' % len(rest), 'ExifTool (lokaal)', rest[:300], dicht=True))
    fk, fkern = forensiek(inhoud)   # wv2712: ELA + kloondetectie (alleen een foto; lokaal)
    kaarten[1:1] = fk
    return kaarten, dict({'velden': len(meta), 'signalen': len(sig), 'soort': meta.get('File:FileType')}, **fkern)


# ---------------------------------------------------------------- fotoforensiek (wv2712; alleen een bestand dat David zelf uploadt, lokaal)
# ELA (error level analysis): de foto één keer opnieuw als JPEG (kwaliteit 90) opslaan en het verschil versterken; een stuk dat veel feller
# oplicht dan vergelijkbare vlakken kan er later in gezet zijn. Kloondetectie: blokken van 8 x 8 (op max 512 px) met dezelfde vorm en dezelfde
# verschuiving, als samenhangend vlak van minstens 3 x 3 blokposities. Beide zijn aanwijzingen, geen bewijs. FotoForensics (extern) is geen
# aanroep van de pod: de site weert geautomatiseerde uploads (gemeten 8-11-2026); de App heeft een bewuste knop waarmee David zelf uploadt.
FOTO_SOORTEN = ('JPEG', 'MPO', 'PNG', 'WEBP', 'TIFF', 'BMP')
JPEG_STD = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
            18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99]


def data_url(im, kwaliteit=80, max_b=720):
    import io
    im = im.copy()
    im.thumbnail((max_b, max_b))
    b = io.BytesIO()
    im.convert('RGB').save(b, 'JPEG', quality=kwaliteit)
    return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()


def klonen(im, np):
    """→ lijst gebieden {'van': (x0, y0, x1, y1), 'naar': (...), 'blokken': n} in pixels van het originele beeld.
    Blokken van 8 x 8 op elke pixelpositie, op ware grootte (een kopie staat dan precies op hele pixels); groter dan 4 MP wordt eerst met een
    hele factor verkleind (dan minder betrouwbaar). Kenmerk = 16 deelgemiddelden van 2 x 2 (gesorteerd op 4 hoofdcomponenten); alleen blokken
    met tekening. Per verschuiving het grootste samenhangende vlak (≥ 40 posities én ≥ 0,05 % van de foto, ≥ 6 x 6); herhalende patronen vallen af."""
    g = im.convert('L')
    k = 1
    while (g.size[0] // k) * (g.size[1] // k) > 4_000_000:
        k += 1
    if k > 1:
        g = g.reduce(k)
    A = np.asarray(g, dtype=np.float32)
    B = 8
    if A.shape[0] < 4 * B or A.shape[1] < 4 * B:
        return []
    m2 = (A[:-1, :-1] + A[1:, :-1] + A[:-1, 1:] + A[1:, 1:]) / 4.0   # gemiddelde van elk 2 x 2-vak
    gh, gw = A.shape[0] - B + 1, A.shape[1] - B + 1
    kol = [m2[2 * r:2 * r + gh, 2 * c:2 * c + gw].reshape(-1) for r in range(4) for c in range(4)]
    Fv = np.stack(kol, axis=1)
    del kol
    sd = Fv.std(axis=1)
    idx = np.nonzero(sd >= 4)[0]   # alleen blokken met tekening: egale vlakken (lucht, papier) lijken altijd op elkaar
    if len(idx) < 200:
        return []
    F = Fv[idx]
    # sorteren op 4 hoofdcomponenten (ruis van een JPEG-ronde blijft daarin klein), afgerond op twee verschoven rasters; dan de buren
    # in de volgorde op alle 16 kenmerken nagaan (verschil ≤ 3,5 grijswaarde)
    st = F[:: max(1, len(F) // 20000)]
    V = np.linalg.svd(st - st.mean(axis=0), full_matrices=False)[2][:4]
    P = (F - st.mean(axis=0)) @ V.T
    pa, pb = [], []
    for schuif in (0.0, 3.0):
        q = np.floor((P + schuif) / 6).astype(np.int32)
        order = np.lexsort(q.T[::-1])
        qs = q[order]
        for n in (1, 2, 3, 4):
            p = np.nonzero(np.all(qs[n:] == qs[:-n], axis=1))[0]
            a, b = order[p], order[p + n]
            ok = np.abs(F[a] - F[b]).max(axis=1) <= 3.5
            a, b = a[ok], b[ok]
            if len(a) > 400_000:   # review-ZOU 2: een glad beeld geeft miljoenen paren; gelijkmatig uitdunnen houdt geheugen en tijd begrensd
                k_ = np.linspace(0, len(a) - 1, 400_000).astype(np.int64)
                a, b = a[k_], b[k_]
            pa.append(a); pb.append(b)
    a, b = idx[np.concatenate(pa)], idx[np.concatenate(pb)]
    # scherp: één pixel ernaast moet duidelijk slechter passen, anders is het een glad verloop dat overal past (geen kopie)
    ok = (b % gw < gw - 1) & (b + gw < gh * gw) & (a % gw < gw - 1) & (a + gw < gh * gw)
    a, b = a[ok], b[ok]
    d0 = np.abs(Fv[a] - Fv[b]).max(axis=1)
    d1 = np.minimum(np.abs(Fv[a] - Fv[b + 1]).max(axis=1), np.abs(Fv[a] - Fv[b + gw]).max(axis=1))
    d2 = np.minimum(np.abs(Fv[a + 1] - Fv[b]).max(axis=1), np.abs(Fv[a + gw] - Fv[b]).max(axis=1))
    ok = (np.minimum(d1, d2) >= np.maximum(2 * d0, 4))
    a, b = a[ok], b[ok]
    ay, ax = a // gw, a % gw
    by, bx = b // gw, b % gw
    dy, dx = by - ay, bx - ax
    neg = (dy < 0) | ((dy == 0) & (dx < 0))
    ay, ax = np.where(neg, by, ay), np.where(neg, bx, ax)
    dy, dx = np.abs(dy), np.where(neg, -dx, dx)
    ver = np.hypot(dy, dx) >= 24
    ay, ax, dy, dx = ay[ver], ax[ver], dy[ver], dx[ver]
    if not len(ay):
        return []
    sleutels = dy * 100000 + (dx + 50000)
    uniek, aantal = np.unique(sleutels, return_counts=True)
    sterk = [(int(u // 100000), int(u % 100000) - 50000) for u in uniek[aantal >= 20]]

    def veelvoud(vy, vx, uy, ux):
        if abs(uy - vy) <= 1 and abs(ux - vx) <= 1 or (uy, ux) == (0, 0):
            return False
        n = round((vy * uy + vx * ux) / float(uy * uy + ux * ux))
        tol = max(1.5, 0.03 * (vy * vy + vx * vx) ** 0.5)
        return n >= 2 and abs(vy - n * uy) <= tol and abs(vx - n * ux) <= tol
    uit, gehad = [], []
    for sl in uniek[np.argsort(-aantal, kind='stable')][:40]:
        vy, vx = int(sl // 100000), int(sl % 100000) - 50000
        if any(abs(vy - y) <= 1 and abs(vx - x) <= 1 for y, x in gehad):
            continue
        m = (np.abs(dy - vy) <= 1) & (np.abs(dx - vx) <= 1)
        if m.sum() < 40:
            break
        gehad.append((vy, vx))
        # herhalend patroon (regels, tegels, een raster): dezelfde vorm komt ook op een deel of een veelvoud van die afstand terug → geen kopie
        if any(veelvoud(vy, vx, py, px) or veelvoud(py, px, vy, vx) for py, px in sterk):
            continue
        vak = set(zip(ay[m].tolist(), ax[m].tolist()))
        beste = []
        while vak:   # grootste samenhangende stuk (8-buren)
            st = [vak.pop()]
            comp = list(st)
            while st:
                y, x = st.pop()
                for yy in (y - 1, y, y + 1):
                    for xx in (x - 1, x, x + 1):
                        if (yy, xx) in vak:
                            vak.discard((yy, xx))
                            st.append((yy, xx))
                            comp.append((yy, xx))
            if len(comp) > len(beste):
                beste = comp
        ys, xs = [c[0] for c in beste], [c[1] for c in beste]
        if len(beste) < max(40, 0.0005 * gh * gw) or max(ys) - min(ys) < 6 or max(xs) - min(xs) < 6:   # losse letters of tekens tellen niet
            continue
        van = (min(xs), min(ys), max(xs) + B, max(ys) + B)
        naar = (van[0] + vx, van[1] + vy, van[2] + vx, van[3] + vy)
        uit.append({'van': tuple(int(v * k) for v in van), 'naar': tuple(int(v * k) for v in naar), 'blokken': len(beste)})
    uit.sort(key=lambda r: -r['blokken'])
    return uit[:3]


def forensiek(inhoud):
    """→ (kaartjes, kern). Geen foto (pdf, document) → ([], {})."""
    import io, warnings
    try:
        from PIL import Image, ImageOps, ImageDraw
        import numpy as np
    except ImportError:
        return [melding('Fotoforensiek', 'Pillow of numpy ontbreekt op de pod (venv osint): geen ELA of kloondetectie.')], {}
    Image.MAX_IMAGE_PIXELS = 40_000_000
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            try:
                im = Image.open(io.BytesIO(inhoud))
            except (Image.DecompressionBombError, Image.DecompressionBombWarning):
                return [melding('Fotoforensiek', 'Deze foto is groter dan 40 megapixel: verklein hem eerst, dan kan de fotoforensiek hem lezen.')], {'foto': False}
            except Exception:
                return [], {}   # geen foto (pdf, document, onbekend)
            soort = (im.format or '').upper()
            if soort not in FOTO_SOORTEN:
                return [], {}
            kw = None
            if soort in ('JPEG', 'MPO') and getattr(im, 'quantization', None):
                t = im.quantization.get(0) or []
                if t and len(t) == 64:   # schatting: verhouding tot de standaard-luminantietabel (IJG, kwaliteit 50)
                    sc = 100.0 * sum(t) / sum(JPEG_STD)
                    kw = max(1, min(100, round((200 - sc) / 2 if sc <= 100 else 5000 / sc)))
            im.load()
            im = ImageOps.exif_transpose(im).convert('RGB')
    except Exception as e:
        return [melding('Fotoforensiek', 'Deze foto is niet te openen voor de fotoforensiek (%s).' % type(e).__name__)], {'foto': False}
    t0 = time.time()
    b = io.BytesIO()
    im.save(b, 'JPEG', quality=90)
    her = Image.open(io.BytesIO(b.getvalue())).convert('RGB')
    d = np.abs(np.asarray(im, dtype=np.int16) - np.asarray(her, dtype=np.int16)).max(axis=2).astype(np.float32)
    mx = float(d.max()) or 1.0
    ela = Image.fromarray(np.clip(d * (255.0 / mx), 0, 255).astype(np.uint8)).convert('RGB')
    H, W = d.shape
    h16, w16 = H // 16, W // 16
    fel = None
    if h16 and w16:
        bl = d[:h16 * 16, :w16 * 16].reshape(h16, 16, w16, 16).mean(axis=(1, 3))
        fel = float(np.percentile(bl, 99.5)) / max(float(np.median(bl)), 0.5)
    try:
        kl = klonen(im, np)
    except Exception:
        kl = None
    sig = []
    beelden = [{'titel': 'De foto', 'src': data_url(im), 'foto': True}, {'titel': 'ELA (foutniveau)', 'src': data_url(ela), 'foto': True}]
    if kl:
        mk = im.copy()
        tk = ImageDraw.Draw(mk)
        w = max(2, round(max(im.size) / 300))
        for r in kl:
            tk.rectangle(r['van'], outline=(224, 54, 44), width=w)
            tk.rectangle(r['naar'], outline=(255, 170, 0), width=w)
        beelden.append({'titel': 'Kloondetectie: rood = bron, oranje = kopie', 'src': data_url(mk), 'foto': True})
        sig.append('%d %s dat twee keer in de foto voorkomt (gekopieerd en verplaatst?)' % (len(kl), 'stuk' if len(kl) == 1 else 'stukken'))
    velden = [('Soort', soort), ('Afmeting', '%d x %d px' % im.size), ('JPEG-kwaliteit (schatting)', kw),
              ('Felste plekken in de ELA t.o.v. de rest', ('%s x' % getal_nl(fel, 1)) if fel else None),
              ('Kopieën in de foto', ('%d %s' % (len(kl), 'stuk' if len(kl) == 1 else 'stukken')) if kl else 'geen gevonden (egale en gladde vlakken ziet deze toets niet)' if kl is not None else 'niet gelukt'),
              ('Rekentijd', '%.1f s' % (time.time() - t0))]
    uitleg = ('Hoe lezen: in de ELA licht een foto die in één keer is gemaakt overal ongeveer even fel op bij gelijke vlakken (randen en tekst zijn altijd '
              'feller). Een stuk dat duidelijk feller of juist doffer is dan zijn omgeving, kan er later in gezet zijn. '
              + ('Bij een PNG of andere verliesvrije foto zegt ELA weinig. ' if soort not in ('JPEG', 'MPO') else '')
              + 'Herhaalde patronen (tegels, logo, dezelfde tekst) geven ook een kloontreffer.')
    return [kaartje('Fotoforensiek (lokaal)', 'ELA en kloondetectie op de pod (Pillow, numpy)', velden, beelden=beelden,
                    let=('Let op: ' + '; '.join(sig) + '. Dit is een aanwijzing, geen bewijs.') if sig else None, klein=uitleg,
                    juridisch=JUR['forensiek'])], {'foto': True, 'klonen': len(kl or []), 'ela_fel': round(fel, 2) if fel else None}


# ---------------------------------------------------------------- mijn voetafdruk (wv2698; alleen Davids eigen namen en adressen uit de instelling)
def wmn_sites():
    p = os.environ.get('OSINT_WMN') or os.path.join(TOOLS, 'wmn-data.json')
    try:
        d = json.load(open(p))
    except Exception:
        return []
    return [s for s in d.get('sites') or [] if isinstance(s, dict) and s.get('uri_check') and not s.get('post_body') and not s.get('protection')
            and s.get('valid', True) is not False and s.get('e_code') is not None]


def wmn_een(ctx, s, naam):
    url = s['uri_check'].replace('{account}', up.quote(naam, safe=''))
    try:
        code, body = haal(ctx, 'WhatsMyName', url, 'gebruikersnaam', timeout=8, maxb=600_000, stil=True, metcode=True, hdr=s.get('headers') or None)
    except PoortDicht:
        raise
    except Exception:
        return 'fout'
    if str(code) == str(s.get('e_code')) and (s.get('e_string') or '') in body:
        return 'misschien'
    return 'niet'


def zoek_voetafdruk(ctx, inst):
    namen, adressen = inst.get('gebruikersnamen') or [], inst.get('adressen') or []
    kaarten, kern = [], {}
    if not namen and not adressen:
        kaarten.append(melding('Mijn voetafdruk', 'Vul eerst bij Instellingen je eigen gebruikersnamen en mailadressen in (alleen die van jezelf).'))
    def xon_alle():
        xk, xn = [], {}
        for i, a in enumerate(adressen[:5]):
            if i:
                time.sleep(1.1)   # XposedOrNot: ± 1 vraag per seconde
            r = jhaal(ctx, 'XposedOrNot (datalekken)', 'https://api.xposedornot.com/v1/breach-analytics?' + up.urlencode({'email': a}), 'eigen mailadres', timeout=20)
            det = (((r or {}).get('ExposedBreaches') or {}).get('breaches_details') or []) if isinstance(r, dict) else []
            risico = ((((r or {}).get('BreachMetrics') or {}).get('risk') or [{}])[0] or {}) if isinstance(r, dict) else {}
            xk.append(kaartje('Mailadres %s: in %d datalekken' % (a, len(det)), 'XposedOrNot (gratis, geen sleutel)', items=[
                item('%s (%s)' % (b.get('breach'), b.get('xposed_date')), ' · '.join(y for y in (b.get('xposed_data'), ('%s records' % b['xposed_records']) if b.get('xposed_records') else None,
                     ('wachtwoord: %s' % b['password_risk']) if b.get('password_risk') else None) if y), ('https://' + b['domain']) if b.get('domain') else None)
                for b in sorted(det, key=lambda b: str(b.get('xposed_date')), reverse=True)[:25] if isinstance(b, dict)] or None,
                velden=[('Risico volgens XposedOrNot', ('%s (%s)' % (risico.get('risk_label'), risico.get('risk_score'))) if risico.get('risk_label') else None)],
                klein=None if det else 'Niet gevonden in bekende datalekken.', juridisch=JUR['xon']))
            xn['adres_%d' % i] = len(det)
        return xk, xn

    c = db()
    xon_ex = cf.ThreadPoolExecutor(1)
    xon_f = xon_ex.submit(xon_alle) if adressen else None   # parallel aan de WhatsMyName-ronde (samen < 100 s)
    if namen:
        sites = wmn_sites()
        if not sites:
            kaarten.append(melding('Je gebruikersnamen', 'De WhatsMyName-lijst ontbreekt op de pod.'))
        else:
            poort_open(ctx, 'WhatsMyName', 'extern', 'diverse', 'gebruikersnaam naar %d sites' % len(sites))
            # 2 CPU's: een ronde haalt ± 250-600 sites in 70 s. Elke ronde begint bij de sites die het langst niet bekeken zijn; de uitslag
            # per site blijft staan, zodat een volgende ronde de rest doet en de treffers optellen.
            t0 = time.time()
            ex = cf.ThreadPoolExecutor(48)
            fut, vorig = {}, {}
            for n in namen[:3]:
                vorig[n] = {r[0]: (r[1], r[2]) for r in c.execute('select site, bekeken, uitslag from voetafdruk where naam = ?', (n,))}
                gezien = {k: v[0] for k, v in vorig[n].items()}
                for s_ in sorted(sites, key=lambda x: gezien.get(x['name']) or ''):
                    fut[ex.submit(wmn_een, ctx, s_, n)] = (n, s_)
            klaar, _ = cf.wait(fut, timeout=65)
            ex.shutdown(wait=False, cancel_futures=True)
            nu, ronde, nieuw_n = nu_iso(), {n: 0 for n in namen[:3]}, {n: [] for n in namen[:3]}
            for f in klaar:
                n, s_ = fut[f]
                try:
                    u = f.result()
                except Exception:
                    continue
                if u == 'fout':
                    continue
                ronde[n] += 1
                if u == 'misschien' and s_['name'] in vorig[n] and vorig[n][s_['name']][1] != 'misschien':
                    nieuw_n[n].append(s_['name'])
                c.execute('insert into voetafdruk(naam, site, url, cat, uitslag, bekeken, eerst_raak) values (?,?,?,?,?,?,?) on conflict(naam, site) do update set '
                          'uitslag = excluded.uitslag, bekeken = excluded.bekeken, url = excluded.url, eerst_raak = coalesce(voetafdruk.eerst_raak, excluded.eerst_raak)',
                          (n, s_['name'], s_.get('uri_pretty', s_['uri_check']).replace('{account}', up.quote(n, safe='')), s_.get('cat'), u, nu,
                           nu if u == 'misschien' else None))
            c.commit()
            for n in namen[:3]:
                ctx.log.append({'bron': 'WhatsMyName (%s)' % n, 'soort': 'extern', 'host': '%d sites' % ronde[n], 'naar_buiten': 'gebruikersnaam %s naar %d sites' % (n, ronde[n]),
                                'status': '%d bekeken' % ronde[n], 'ms': int((time.time() - t0) * 1000)})
                ok = c.execute("select site, url, cat, eerst_raak from voetafdruk where naam = ? and uitslag = 'misschien' order by eerst_raak desc, site", (n,)).fetchall()
                totaal = c.execute('select count(*) from voetafdruk where naam = ?', (n,)).fetchone()[0]
                nieuw = nieuw_n[n]
                kaarten.append(kaartje('Gebruikersnaam "%s": misschien op %d sites' % (n, len(ok)), 'WhatsMyName (%d sites, gratis)' % len(sites), items=[
                    item(r[0], r[2], r[1], nieuw=r[0] in nieuw) for r in ok],
                    klein='Deze ronde %d sites bekeken; in totaal %d van %d.%s Alles is "misschien": een naam die op een site bestaat, kan van iemand anders zijn.%s' % (
                        ronde[n], totaal, len(sites), ' Tik nog eens voor de rest.' if totaal < len(sites) else '',
                        (' Nieuw deze ronde: %d.' % len(nieuw)) if nieuw else ''), misschien=True, juridisch=JUR['wmn']))
                kern['naam_' + n] = len(ok)
    if xon_f:
        try:
            xk, xn = xon_f.result(timeout=40)
            kaarten += xk
            kern.update(xn)
        except PoortDicht:
            pass
        except Exception:
            kaarten.append(melding('Datalekken', 'XposedOrNot gaf geen antwoord.'))
    xon_ex.shutdown(wait=False)
    kaarten.append(kaartje('Datalekken op je praktijkdomeinen (Have I Been Pwned)', 'Have I Been Pwned, gratis domeinmelding', klein=(
        'Gratis voor eigen domeinen, maar alleen na verificatie door jou (een DNS-regel of een mail aan het domein). Daarna mailt HIBP vanzelf als een adres '
        'op het domein in een nieuw lek staat. Stappen: open de link, kies Domain search, voer het domein in, kies de verificatie en volg de stappen.'),
        links=[item('Have I Been Pwned › Domain search', ', '.join(inst.get('domeinen') or []), 'https://haveibeenpwned.com/DomainSearch')], juridisch=JUR['hibp']))
    return kaarten, kern


# ---------------------------------------------------------------- lijkende domeinen (wv2698; dnstwist op de eigen domeinen)
def dnstwist_run(dom):
    if NEP:
        f = os.environ.get('OSINT_NEP_DNSTWIST')
        try:
            return json.load(open(f)).get(dom, []) if f else []
        except Exception:
            return []
    exe = os.path.join(os.path.dirname(sys.executable), 'dnstwist')
    if not os.path.exists(exe):
        raise RuntimeError('dnstwist ontbreekt')
    r = subprocess.run([sys.executable, '-I', exe, '--registered', '--format', 'json', '--threads', '12', dom], capture_output=True, text=True, timeout=60)
    return json.loads(r.stdout or '[]')


def zoek_lijkend(ctx, inst):
    doms = inst.get('domeinen') or []
    c = db()
    # review-MOET 3 (Fable): per domein de tijd van de vorige geslaagde ronde (instelling lijkend_gemeten). Nieuw = een variant die in die
    # vorige ronde niet geregistreerd was (ook: verdwenen en opnieuw geregistreerd). De eerste ronde per domein is de nulmeting.
    rij_g = c.execute("select json from instelling where sleutel = 'lijkend_gemeten'").fetchone()
    gemeten = json.loads(rij_g[0]) if rij_g else {}
    for dom in doms:
        poort_open(ctx, 'dnstwist (DNS)', 'extern', 'DNS', 'varianten van ' + dom)
    t = time.time()
    with cf.ThreadPoolExecutor(3) as ex:   # review-ZOU 4: parallel, samen ruim onder de 120 s van de pod
        fut = {dom: ex.submit(dnstwist_run, dom) for dom in doms}
        uit = {}
        for dom, f in fut.items():
            try:
                uit[dom] = (f.result(), 'nep' if NEP else '200')
            except Exception as e:
                uit[dom] = (None, type(e).__name__)
    kaarten, nieuw_alle, tot, mislukt = [], [], 0, []
    nu = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='microseconds')   # fijn: twee rondes in één seconde blijven te onderscheiden
    for dom in doms:
        res, status = uit[dom]
        ctx.log.append({'bron': 'dnstwist (DNS)', 'soort': 'extern', 'host': 'DNS', 'naar_buiten': 'varianten van %s%s' % (
            dom, (' (%d geregistreerd)' % max(0, len(res) - 1)) if res is not None else ''), 'status': status, 'ms': int((time.time() - t) * 1000)})
        if res is None:
            mislukt.append(dom)
            kaarten.append(melding('Lijkend op %s' % dom, 'dnstwist liep niet (%s): niet vast te stellen.' % status))
            continue
        vorige = gemeten.get(dom)
        rij = []
        for x in res:
            v = str(x.get('domain') or '').lower()
            if not v or x.get('fuzzer') == '*original' or v == dom:
                continue
            a, mx, ns = [', '.join(y for y in (x.get(k) or []) if y and not str(y).startswith('!')) for k in ('dns_a', 'dns_mx', 'dns_ns')]
            oud = c.execute('select laatst from lijkend where variant = ?', (v,)).fetchone()
            nw = bool(vorige) and (not oud or str(oud[0]) < vorige)
            c.execute('insert into lijkend(variant, domein, fuzzer, a, mx, ns, eerst, laatst) values (?,?,?,?,?,?,?,?) on conflict(variant) do update set '
                      'laatst = excluded.laatst, a = excluded.a, mx = excluded.mx, ns = excluded.ns', (v, dom, x.get('fuzzer'), a, mx, ns, nu, nu))
            if nw:
                nieuw_alle.append({'variant': v, 'domein': dom, 'mx': bool(mx)})
            rij.append((nw, v, item(v, ' · '.join(y for y in (x.get('fuzzer'), ('A ' + a) if a else None, ('mail: ' + mx) if mx else None, ('NS ' + ns) if ns else None) if y), nieuw=nw)))
        gemeten[dom] = nu
        tot += len(rij)
        rij.sort(key=lambda z: (not z[0], z[1]))
        km = ctx.knoop('domein', dom, zoek={'ingang': 'bedrijf', 'term': dom})
        for nw, v, _ in rij[:25]:
            ctx.rand(ctx.knoop('domein', v, zoek={'ingang': 'bedrijf', 'term': v}), km, 'lijkt op')
        kaarten.append(kaartje('Lijkend op %s: %d geregistreerd' % (dom, len(rij)), 'dnstwist (Apache-2.0, alleen DNS)', items=[z[2] for z in rij[:60]] or None,
                               klein=(None if rij else 'Geen geregistreerde lijkende domeinen.') if vorige else 'Eerste ronde voor dit domein (nulmeting): vanaf de volgende ronde zie je wat er nieuw bij komt.',
                               let=('Nieuw sinds de vorige ronde: %s.' % ', '.join(z[1] for z in rij if z[0])) if any(z[0] for z in rij) else None, juridisch=JUR['dnstwist']))
    c.execute('insert or replace into instelling(sleutel, json, tijd) values (?,?,?)', ('lijkend_gemeten', json.dumps(gemeten), nu))
    c.commit()
    return kaarten, {'nieuw': nieuw_alle, 'geregistreerd': tot, 'domeinen': len(doms), 'mislukt': mislukt}


# ---------------------------------------------------------------- herkennen en zoeken
def herken(term):
    t = norm(term)
    kaal = re.sub(r'[\s.()-]', '', t)
    if re.search(r'(?im)^(received|authentication-results|return-path|dkim-signature):', str(term or '')) or \
            len(re.findall(r'(?im)^(from|to|cc|subject|date|reply-to|message-id|onderwerp|van|aan)\s*:', str(term or ''))) >= 2:
        return 'mail'
    if re.fullmatch(r'\d{8}', kaal):
        return 'bedrijf'
    if re.fullmatch(r'\+?\d{9,15}', kaal) and (kaal.startswith(('0', '+')) or len(kaal) >= 11):
        return 'telefoon'
    if re.fullmatch(r'\d{4}[A-Z]{2}', kaal.upper()):
        return 'adres'   # postcode, geen kenteken (review-ZOU 5)
    if KENTEKEN_RE.match(t.upper().replace(' ', '')):
        return 'kenteken'
    if (IBAN_RE.match(kaal.upper()) and iban_geldig(kaal)) or btw_uit(kaal) or (' ' not in t and DOMEIN_RE.match(t.lower())):
        return 'bedrijf'
    if re.search(r'\b\d{4}\s?[A-Za-z]{2}\b', t) or re.search(r'[A-Za-z]{3,}\s+\d{1,5}\s?[A-Za-z]?\b', t):
        return 'adres'
    return 'bedrijf'


ZOEK = {'adres': zoek_adres, 'bedrijf': zoek_bedrijf, 'telefoon': zoek_telefoon, 'persoon': zoek_persoon, 'kenteken': zoek_kenteken}
ZONDER_TERM = ('voetafdruk', 'lijkend')   # werken alleen op de eigen lijsten uit de instelling, nooit op een vrije zoekterm
JUR_BRON = [('PDOK', 'pdok'), ('BAG', 'pdok'), ('OpenCorporates', 'kvk'), ('Liza', 'kvk'), ('RDAP', 'domein'), ('BIG', 'big'), ('Facturen', 'eigen'),
            ('Contacts', 'eigen'), ('mail', 'eigen'), ('Second Brain', 'eigen'), ('libphonenumber', 'telefoon')]


def met_juridisch(kaarten):
    for k in kaarten:
        if isinstance(k, dict) and not k.get('juridisch') and k.get('titel') != 'Poort':
            j = next((JUR[v] for a, v in JUR_BRON if a.lower() in str(k.get('bron', '')).lower()), None)
            if j:
                k['juridisch'] = j
    return kaarten


def zoek(v):
    SLEUTELS.clear()
    sl = v.pop('sleutels', None)   # wv2712: gratis sleutels van server.js (kluis); niet in uitvoer, logboek of cache
    if isinstance(sl, dict):
        SLEUTELS.update({k: sl[k] for k in SLEUTEL_ENV if isinstance(sl.get(k), str)})
    wie = v.get('wie') if v.get('wie') in WIE else 'machinekamer'
    ingang = v.get('ingang') or 'auto'
    ruw = str(v.get('kop') or v.get('term') or '')
    if ingang == 'auto' and str(v.get('kop') or '').strip():
        ingang = 'mail'   # review-MOET 2: een geplakte kop is nooit een adres of bedrijf
    if ingang == 'auto':
        ingang = herken(ruw if '\n' in ruw else norm(ruw)[:200])
    if ingang not in INGANGEN:
        return {'ok': False, 'fout': 'onbekende ingang'}
    inhoud = None
    if ingang == 'mail':
        kop = ruw[:60000]
        if not kop.strip():
            return {'ok': False, 'fout': 'lege zoekterm'}
        poort_tekst, term = kop_voor_poort(kop), 'mailkop (%d regels)' % kop.count('\n')
    elif ingang == 'bestand':
        try:
            inhoud = base64.b64decode(str(v.get('bestand') or ''), validate=False)
        except Exception:
            inhoud = b''
        if not inhoud:
            return {'ok': False, 'fout': 'lege zoekterm'}
        if len(inhoud) > 10 * 1024 * 1024:
            return {'ok': False, 'fout': 'bestand te groot (max 10 MB)'}
        naam = norm(v.get('naam'))[:120]
        ext = (re.search(r'\.([A-Za-z0-9]{1,5})$', naam) or [None, '?'])[1].lower()
        poort_tekst, term = naam, 'bestand .%s, %d kB, sha256 %s' % (ext, len(inhoud) // 1024, hashlib.sha256(inhoud).hexdigest()[:12])
    elif ingang in ZONDER_TERM:
        poort_tekst, term = '', {'voetafdruk': 'eigen gebruikersnamen en mailadressen', 'lijkend': 'eigen domeinen'}[ingang]
    else:
        term = norm(ruw)[:200]
        if not term:
            return {'ok': False, 'fout': 'lege zoekterm'}
        poort_tekst = term
    doel = v.get('doel') or DOEL_STANDAARD.get(ingang)
    if doel not in DOELEN:
        doel = None if ingang == 'persoon' else 'anders'
    doel_tekst = norm(v.get('doel_tekst'))[:120] or None
    herkomst = 'david' if wie == 'david' else (norm(v.get('herkomst')).lower()[:40] or None)
    pt = poort(poort_tekst, wie, herkomst, ingang, doel)
    if ingang == 'voetafdruk' and wie != 'david':
        pt = {'niveau': 'niets', 'reden': 'voetafdruk alleen voor David zelf (App)'}
    elif ingang == 'bestand' and wie != 'david':
        pt = {'niveau': 'niets', 'reden': 'bestand alleen voor David zelf (App)'}   # wv2712: ook de fotoforensiek
    elif ingang == 'lijkend' and pt['niveau'] == 'eigen':
        pt = {'niveau': 'alles', 'reden': 'eigen domeinen uit de instelling'}
    c = db()
    zid = c.execute('insert into zoekvraag(tijd, wie, doel, doel_tekst, ingang, term, herkomst, poort, poort_reden) values (?,?,?,?,?,?,?,?,?)',
                    (nu_iso(), wie, doel, doel_tekst, ingang, term, herkomst, pt['niveau'], pt['reden'])).lastrowid
    c.commit()
    sleutel = hashlib.sha256(('%s|%s|%s|%s|%s|%s' % (VERSIE, ingang, term.lower(), pt['niveau'], v.get('beelden') is not False,
                                                     ''.join(k for k in sorted(SLEUTEL_ENV) if sleutel_er(k)))).encode()).hexdigest()
    cachebaar = ingang in ZOEK
    rij = None if v.get('vers') or NEP or not cachebaar else c.execute('select tijd, json from cache where sleutel = ?', (sleutel,)).fetchone()
    beelden = v.get('beelden') is not False
    ctx = Ctx(pt['niveau'], beelden, wie)
    graaf = None
    if pt['niveau'] == 'niets' and (pt['reden'].startswith('persoon') or ingang in ('voetafdruk', 'bestand')):
        kaarten, kern = [melding('Niet gezocht', 'Niet gezocht: ' + pt['reden'] + '.')], {}
    elif rij:
        u = json.loads(rij[1])
        kaarten, kern, graaf = u['kaarten'], u['kern'], u.get('graaf')
        c.execute('update zoekvraag set cache = 1 where id = ?', (zid,))
    else:
        try:
            if ingang == 'mail':
                kaarten, kern = zoek_mail(ctx, kop)
            elif ingang == 'bestand':
                kaarten, kern = zoek_bestand(ctx, inhoud, naam)
            elif ingang == 'voetafdruk':
                kaarten, kern = zoek_voetafdruk(ctx, instellingen(c))
            elif ingang == 'lijkend':
                kaarten, kern = zoek_lijkend(ctx, instellingen(c))
            else:
                kaarten, kern = ZOEK[ingang](ctx, term)
        except PoortDicht:
            kaarten, kern = [melding('Niet gezocht', 'De poort laat deze zoekterm niet naar buiten.')], {}
        except Exception as e:
            kaarten, kern = [melding('Fout', 'Er ging iets mis: %s' % type(e).__name__)], {}
        met_juridisch(kaarten)
        graaf = ctx.graaf() if pt['niveau'] != 'niets' and ingang not in ('bestand', 'voetafdruk') and not (ingang == 'mail' and pt['niveau'] != 'alles') else None
        if cachebaar and pt['niveau'] == 'alles' and not NEP and any(l['soort'] == 'extern' and l['status'] in ('200', '204') for l in ctx.log):
            c.execute('insert or replace into cache(sleutel, tijd, json) values (?,?,?)',
                      (sleutel, nu_iso(), json.dumps({'kaarten': kaarten, 'kern': kern, 'graaf': graaf}, ensure_ascii=False)))
    if pt['niveau'] != 'alles':
        kaarten.insert(0, kaartje('Poort', 'OVIS OSINT-poort', let='Deze zoekvraag ging niet naar openbare bronnen (%s).' % pt['reden']))
    for l in ctx.log:
        c.execute('insert into aanroep(zoek_id, tijd, bron, soort, host, naar_buiten, status, ms) values (?,?,?,?,?,?,?,?)',
                  (zid, nu_iso(), l['bron'], l['soort'], l['host'], l['naar_buiten'], l['status'], l['ms']))
    ext = sum(1 for l in ctx.log if l['soort'] == 'extern' and l['status'] != 'poort dicht')
    c.execute('update zoekvraag set uitkomst = ?, graaf = ? where id = ?', ('%d kaartjes, %d extern' % (len(kaarten), ext),
              json.dumps(graaf, ensure_ascii=False) if graaf and graaf.get('knopen') else None, zid))
    c.commit()
    return {'ok': True, 'id': zid, 'ingang': ingang, 'term': term, 'doel': doel, 'doel_tekst': doel_tekst, 'wie': wie,
            'poort': pt, 'cache': bool(rij), 'kaarten': kaarten, 'kern': kern, 'extern': ext, 'logboek': ctx.log, 'versie': VERSIE, 'graaf': graaf}


def grafiek(n=40):
    """Netwerkplaat over de laatste n zoekvragen: dezelfde entiteit (soort + genormaliseerd label) valt samen; per knoop de zoekvragen."""
    c = db()
    kn, rd = {}, {}
    for zid, tijd, g in c.execute("select id, tijd, graaf from zoekvraag where graaf is not null and poort != 'niets' order by id desc limit ?",
                                  (max(1, min(int(n), 200)),)):
        try:
            g = json.loads(g)
        except ValueError:
            continue
        for k in g.get('knopen') or []:
            x = kn.setdefault(k['id'], dict(k, zoekvragen=[]))
            if zid not in x['zoekvragen']:
                x['zoekvragen'].append(zid)
        for r in g.get('randen') or []:
            rd.setdefault((r['van'], r['naar']), r)
    randen = [r for r in rd.values() if r['van'] in kn and r['naar'] in kn]
    return {'ok': True, 'knopen': list(kn.values()), 'randen': randen}


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
    if not a or a[0] not in ('zoek', 'logboek', 'info', 'instelling', 'grafiek', 'lijkend'):
        sys.exit('gebruik: osint.py zoek (json op stdin) | logboek [n] | info | instelling (json op stdin: {} = lezen, {zet: {...}}) | grafiek [n] | lijkend')
    if a[0] == 'zoek':
        try:
            v = json.loads(sys.stdin.read() or '{}')
        except ValueError:
            v = None
        r = zoek(v) if isinstance(v, dict) else {'ok': False, 'fout': 'geen json'}
    elif a[0] == 'logboek':
        r = logboek(a[1] if len(a) > 1 and a[1].isdigit() else 50)
    elif a[0] == 'instelling':
        try:
            v = json.loads(sys.stdin.read() or '{}')
        except ValueError:
            v = {}
        r = zet_instellingen(v['zet']) if isinstance(v, dict) and isinstance(v.get('zet'), dict) else {'ok': True, 'instellingen': instellingen()}
    elif a[0] == 'grafiek':
        r = grafiek(a[1] if len(a) > 1 and a[1].isdigit() else 40)
    elif a[0] == 'lijkend':
        # CISO-ronde (machinekamer): alleen de nieuwe geregistreerde varianten; stilte = lege lijst
        z = zoek({'ingang': 'lijkend', 'wie': 'machinekamer', 'herkomst': 'eigen-domeinen'})
        r = {'ok': z.get('ok'), 'nieuw': (z.get('kern') or {}).get('nieuw', []), 'geregistreerd': (z.get('kern') or {}).get('geregistreerd'),
             'domeinen': (z.get('kern') or {}).get('domeinen'), 'mislukt': (z.get('kern') or {}).get('mislukt'), 'id': z.get('id')}
    else:
        r = info()
    sys.stdout.write(json.dumps(r, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1:])
