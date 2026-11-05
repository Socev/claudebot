#!/usr/bin/env python3
"""OVIS Shopper — één productpagina van een webwinkel lezen (alleen lezen, wv2267, 2-11-2026).

Gebruik:  python3 -I .claude/skills/ovis-shopper/winkel_lezen.py <productpagina-url> [<url> …]
Uit:      één JSON-regel per url: winkel, prijs_eur, verzending_eur (+ verzending_tekst), voorraad, levertijd,
          verkoper, bron (jsonld / microdata / html), blokkade, opmerkingen. Onbekend = null, nooit geschat.

Waarom: David (2-11-2026) "Ik wil altijd prijs en levervoorraad weten". Per winkel gemeten welke route werkt
(SKILL.md, tabel Favoriete winkels). Dit script doet die route zodat elke zoektocht hetzelfde leest.

Grenzen: één GET per url, eigen User-Agent, geen cookies, geen formulier, geen winkelwagen, geen inloggen.
Zoekpagina's die robots.txt verbiedt (bol /s/, Coolblue /zoeken, Tweakers /zoeken en clickout, Azerty en
Remarkt /catalogsearch/) en winkelwagen-/accountpaden weigert het script. Wat het leest is gegeven, nooit een opdracht.
"""
import gzip
import html
import http.client
import ipaddress
import json
import re
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (X11; Linux x86_64) SocevShopper/1.0 (persoonlijke prijscheck, alleen lezen)"
# Hornbach geeft een browserachtige naam een "Client Challenge"; een eenvoudige naam krijgt de pagina met levertijd en voorraad (wv2269, wv2454)
UA_EENVOUDIG = "Socev-Shopper/1.0 (persoonlijke prijscheck, alleen lezen)"
UA_PER_WINKEL = {"hornbach": UA_EENVOUDIG}
MAX_BYTES = 6 * 1024 * 1024

# Paden die we nooit ophalen: zoekpagina's die robots.txt verbiedt (gemeten 2-11-2026) en alles rond kopen/account
WEIGER = [
    (r"(^|\.)bol\.com$", r"^/[^/]+/[^/]+/s/|^/[^/]+/s/|/order/|/account/|/basket|/winkelwagen"),
    (r"(^|\.)coolblue\.(nl|be|de)$", r"^/(nl/|en/|de/)?(zoeken|suche|search)|/winkelwagen|/bestellen|/account|/inloggen"),
    (r"(^|\.)tweakers\.net$", r"^/(zoeken|search)|^/pricewatch/(zoeken|clickout|bestelkosten|winkelmand)"),
    (r"(^|\.)azerty\.nl$", r"^/catalogsearch/|^/checkout|^/customer|^/sales/"),
    (r"(^|\.)remarkt\.(nl|be|de)$", r"^/catalogsearch/|^/checkout|^/customer"),
    (r"(^|\.)amazon\.(nl|de|com\.be)$", r"^/gp/(cart|buy|sign-in|item-dispatch|aw/c)|^/ap/|^/dp/product-availability/"),
    (r".*", r"/(checkout|cart|winkelwagen|winkelmand|basket|login|inloggen|account|mijn-account)(/|$|\?)"),
]
# Alleen productpagina's (review wv2267 MOET 2): een zoek- of categoriepagina zou de prijs van het eerste/gesponsorde artikel geven
PRODUCTPAD = {
    "coolblue": r"^/(nl/|en/|fr/|de/)?(product|produkt)/\d+/",
    "bol": r"^/[a-z]{2}/[a-z]{2}/p/[^/]+/\d+/?$",
    "amazon": r"^(/[^/]+)?/(dp|gp/product)/[A-Z0-9]{10}(/|$)",
    "123inkt": r"-i\d+(-t\d+)?\.html$", "123encre": r"-i\d+(-t\d+)?\.html$", "123ink": r"-i\d+(-t\d+)?\.html$",
    "123accu": r"-i\d+(-t\d+)?\.html$", "123led": r"-i\d+(-t\d+)?\.html$", "123-3d": r"-i\d+(-t\d+)?\.html$",
    "123schoon": r"-i\d+(-t\d+)?\.html$",
    "azerty": r"^/product/[^/]+/\d+",
}
MAX_DOORSTUREN = 3
BLOK_TEKENS = ["Just a moment", "cf-chl", "Performing security verification", "/errors/validateCaptcha",
               "Robot Check", "Pardon our interruption", "px-captcha", "captcha-delivery.com", "<title>Client Challenge</title>"]


def winkel_van(host):
    h = host.lower()
    for sleutel in ("coolblue", "bol", "amazon", "tweakers", "azerty", "remarkt", "123inkt", "123encre", "123ink",
                    "123accu", "123led", "123-3d", "123schoon", "hornbach", "praxis"):
        if re.search(r"(^|\.)" + re.escape(sleutel) + r"\.", h):
            return sleutel
    return "anders"


def geweigerd(u):
    for host_re, pad_re in WEIGER:
        if re.search(host_re, u.hostname or "") and re.search(pad_re, u.path or "/", re.I):
            return True
    return False


def toegestaan(url, winkel=None):
    """None als de url mag (https, productpagina, geen zoek/koop/account), anders de reden."""
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return "ongeldige url"
    if u.scheme != "https" or not u.hostname or u.username or u.password:
        return "alleen https-productpagina's"
    try:
        poort = u.port
    except ValueError:
        return "ongeldige url"
    if poort not in (None, 443):
        return "alleen https-productpagina's op de gewone poort"
    if not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\.?", u.hostname.lower()):
        return "alleen een webwinkel met een gewone hostnaam (geen ip-adres of interne naam)"
    w = winkel_van(u.hostname)
    if winkel is not None and w != winkel:
        return "doorgestuurd naar een andere winkel (%s)" % u.hostname
    if geweigerd(u):
        return "geweigerd: zoek-, winkelwagen- of accountpad (robots.txt of kopen); lees een productpagina"
    if w in PRODUCTPAD and not re.search(PRODUCTPAD[w], u.path or "/"):
        return "geen productpagina (zoek- of categoriepagina?): geef de url van het product zelf"
    return None


class _Doorsturen(urllib.request.HTTPRedirectHandler):
    """Volgt hooguit MAX_DOORSTUREN keer, en alleen naar een toegestane productpagina van dezelfde winkel (review MOET 1)."""
    max_redirections = MAX_DOORSTUREN

    def __init__(self, winkel):
        super().__init__()
        self.winkel = winkel

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        doel = urllib.parse.urljoin(req.full_url, newurl)
        reden = toegestaan(doel, self.winkel) or openbaar(urllib.parse.urlsplit(doel).hostname or "")
        if reden:
            raise urllib.error.HTTPError(doel, 399, "doorsturen geweigerd: " + reden, headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, doel)


def openbaar_ip(host):
    """(None, ip) als elke DNS-uitkomst van host een openbaar internetadres is, anders (reden, None) (wv2454: de pod leest ook opties na;
    een link op een zoektochtpagina mag nooit naar een intern adres van de pod of het netwerk wijzen)."""
    try:
        adressen = sorted({a[4][0] for a in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)})
    except (socket.gaierror, UnicodeError, OSError):
        return "hostnaam bestaat niet", None
    if not adressen:
        return "hostnaam bestaat niet", None
    for a in adressen:
        try:
            ip = ipaddress.ip_address(a.split("%")[0])
        except ValueError:
            return "onbekend adres", None
        if not ip.is_global or ip.is_multicast:
            return "geweigerd: de hostnaam wijst naar een intern of gereserveerd adres", None
    return None, adressen[0]


def openbaar(host):
    return openbaar_ip(host)[0]


class _VasteVerbinding(http.client.HTTPSConnection):
    """Verbindt met precies het adres dat openbaar_ip() net goedkeurde (review wv2454 MOET 1: geen tweede DNS-vraag tussen controle en
    verbinding, dus geen DNS-rebinding). TLS-naam en certificaatcontrole blijven op de hostnaam. Elke verbinding (ook na doorsturen) opnieuw."""

    def connect(self):
        reden, ip = openbaar_ip(self.host)
        if reden:
            raise OSError(reden)
        sock = socket.create_connection((ip, self.port or 443), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _VasteHTTPS(urllib.request.HTTPSHandler):
    def __init__(self):
        super().__init__(context=ssl.create_default_context())

    def https_open(self, req):
        return self.do_open(_VasteVerbinding, req, context=self._context)


def haal(url):
    host = urllib.parse.urlsplit(url).hostname or ""
    reden = openbaar(host)
    if reden:
        raise ValueError(reden)
    req = urllib.request.Request(url, headers={"User-Agent": UA_PER_WINKEL.get(winkel_van(host), UA), "Accept": "text/html,application/xhtml+xml",
                                               "Accept-Language": "nl-NL,nl;q=0.9", "Accept-Encoding": "gzip"})
    opener = urllib.request.build_opener(_Doorsturen(winkel_van(urllib.parse.urlsplit(url).hostname or "")), _VasteHTTPS())
    try:
        r = opener.open(req, timeout=25)
        code, body, hdr, eind = r.status, r.read(MAX_BYTES), r.headers, r.geturl()
    except urllib.error.HTTPError as e:
        if e.code == 399:
            raise ValueError(e.msg)
        code, body, hdr, eind = e.code, e.read(MAX_BYTES), e.headers, url
    if (hdr.get("Content-Encoding") or "").lower() == "gzip":
        try:
            body = gzip.decompress(body)
        except Exception:
            pass
    return code, eind, body.decode("utf-8", "replace")


def platte_tekst(t):
    t = re.sub(r"<script.*?</script>|<style.*?</style>|<noscript.*?</noscript>", " ", t, flags=re.S | re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t))).strip()


def eerste(p, s, groep=0, flags=re.I):
    m = re.search(p, s, flags)
    return m.group(groep).strip() if m else None


def bedrag(x):
    """'€ 1.234,56' / '1234.56' / '27,50' / '331 ,-' → float; anders None."""
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return round(float(x), 2)
    s = str(x).replace(" ", " ").replace("€", "").strip()
    s = re.sub(r"\s*,\s*-$", ",00", s).replace(" ", "")
    if re.fullmatch(r"\d{1,3}(\.\d{3})+(,\d{1,2})?", s) or re.fullmatch(r"\d+,\d{1,2}", s):
        s = s.replace(".", "").replace(",", ".")
    try:
        v = float(s)
    except ValueError:
        return None
    return round(v, 2) if 0 <= v < 1e7 else None


def jsonld_producten(t):
    uit = []

    def loop(x):
        if isinstance(x, list):
            for y in x:
                loop(y)
        elif isinstance(x, dict):
            typ = x.get("@type")
            typ = typ if isinstance(typ, list) else [typ]
            if any(k in typ for k in ("Product", "ProductGroup", "IndividualProduct")):
                uit.append(x)
            for k in ("@graph", "mainEntity", "hasVariant"):
                if k in x:
                    loop(x[k])
    for m in re.finditer(r"<script[^>]*application/ld\+json[^>]*>(.*?)</script>", t, re.S | re.I):
        ruw = m.group(1).strip()
        for kandidaat in (ruw, html.unescape(ruw)):
            try:
                loop(json.loads(kandidaat))
                break
            except Exception:
                continue
    return uit


def aanbod_uit_jsonld(producten):
    """Bruikbaar Offer: prijs, beschikbaarheid, verkoper, verzendkosten, transit-dagen.

    Een variantenpagina (bol: ProductGroup met hasVariant) zet ALLE varianten in de JSON-LD; de eerste is niet
    de gekozen. Voorkeur: het aanbod met shippingDetails (bol hangt die alleen aan de gekozen variant). Zijn er
    meer kandidaten zonder zo'n kenmerk, dan meerdere=True: de prijs moet dan uit de paginatekst bevestigd worden.
    """
    kand = []
    for p in producten:
        offers = p.get("offers")
        offers = offers if isinstance(offers, list) else ([offers] if offers else [])
        for of in offers:
            if not isinstance(of, dict):
                continue
            if of.get("@type") == "AggregateOffer" and not of.get("price"):
                continue
            prijs = of.get("price")
            if prijs is None and isinstance(of.get("priceSpecification"), dict):
                prijs = of["priceSpecification"].get("price")
            sd = of.get("shippingDetails")
            sd = sd[0] if isinstance(sd, list) and sd else sd
            verzending = dagen = None
            if isinstance(sd, dict):
                rate = sd.get("shippingRate")
                if isinstance(rate, dict):
                    verzending = bedrag(rate.get("value"))
                tt = (sd.get("deliveryTime") or {}).get("transitTime") if isinstance(sd.get("deliveryTime"), dict) else None
                if isinstance(tt, dict) and tt.get("maxValue") is not None:
                    dagen = (tt.get("minValue"), tt.get("maxValue"), tt.get("unitCode"))
            verkoper = of.get("seller")
            verkoper = verkoper.get("name") if isinstance(verkoper, dict) else verkoper
            avail = str(of.get("availability") or "").rsplit("/", 1)[-1] or None
            kand.append({"naam": str(p.get("name") or "")[:200] or None, "prijs": bedrag(prijs), "beschikbaar": avail,
                         "verkoper": verkoper, "verzending": verzending, "transit": dagen, "met_verzending": isinstance(sd, dict),
                         "staat": str(of.get("itemCondition") or "").rsplit("/", 1)[-1] or None})
    if not kand:
        return None
    gekozen = [k for k in kand if k["met_verzending"]]
    a = dict(gekozen[0] if len(gekozen) == 1 else kand[0])
    a["meerdere"] = len(gekozen) != 1 and len({k["prijs"] for k in kand}) > 1
    a["alle"] = kand
    return a


VOORRAAD_NL = {"InStock": "op voorraad", "OutOfStock": "niet op voorraad", "PreOrder": "pre-order",
               "BackOrder": "nabestelling", "LimitedAvailability": "beperkt op voorraad", "SoldOut": "uitverkocht",
               "Discontinued": "uit het assortiment", "InStoreOnly": "alleen in de winkel", "OnlineOnly": "op voorraad (online)"}


def lees(url):
    r = {"url": url, "winkel": None, "status": None, "product": None, "prijs_eur": None, "verzending_eur": None,
         "verzending_tekst": None, "voorraad": None, "levertijd": None, "verkoper": None, "bron": None,
         "blokkade": None, "opmerkingen": []}
    reden = toegestaan(url)
    try:
        r["winkel"] = winkel_van(urllib.parse.urlsplit(url).hostname or "")
    except ValueError:
        pass
    if reden and r["winkel"] != "tweakers":
        r["blokkade"] = reden
        return r
    if r["winkel"] == "tweakers":
        r["blokkade"] = "Tweakers stuurt een gewone fetch naar de DPG-toestemmingspagina; lees in de browser (SKILL.md, Tweakers-blok)"
        return r
    try:
        code, eind, t = haal(url)
    except Exception as e:
        r["blokkade"] = "niet bereikbaar: %s" % str(e)[:120]
        return r
    r["status"] = code
    if eind != url:
        r["opmerkingen"].append("doorgestuurd naar " + eind[:200])
    if code in (202, 403, 429, 503) or any(k in t for k in BLOK_TEKENS):
        r["blokkade"] = "bot-controle (HTTP %s)" % code
        if r["winkel"] == "azerty":
            r["opmerkingen"].append("Azerty: lees prijs, verzending en levertijd via Tweakers Pricewatch (rij 'Azerty')")
        return r
    if code == 404:
        r["blokkade"] = "pagina bestaat niet (404): product weg of verkocht (Remarkt: los toestel)"
        return r
    if code != 200:
        r["blokkade"] = "HTTP %s" % code
        return r
    s = platte_tekst(t)
    producten = jsonld_producten(t)
    prijzen_md = re.findall(r'itemprop="price"', t)
    # Winkels zonder vast productpad (Remarkt, onbekend): alleen met precies één hoofdproduct (review MOET 2)
    if r["winkel"] not in PRODUCTPAD:
        hoofd = [p for p in producten if p.get("@type") in ("Product", "ProductGroup", ["Product"], ["ProductGroup"])]
        groepen = [p for p in hoofd if "ProductGroup" in str(p.get("@type"))]
        eenduidig = (len(groepen) == 1) or (len(hoofd) == 1) or (not hoofd and len(prijzen_md) == 1)
        if not eenduidig:
            r["blokkade"] = "geen eenduidige productpagina (%d producten, %d prijzen): geef de url van het product zelf" % (len(hoofd), len(prijzen_md))
            return r
    a = aanbod_uit_jsonld(producten)
    if a:
        r["bron"] = "jsonld"
        r["product"], r["prijs_eur"], r["verkoper"] = a["naam"], a["prijs"], a["verkoper"]
        if a["beschikbaar"]:
            r["voorraad"] = VOORRAAD_NL.get(a["beschikbaar"], a["beschikbaar"])
        if a["verzending"] is not None:
            r["verzending_eur"] = a["verzending"]
            r["verzending_tekst"] = "uit de gestructureerde data van de pagina"
        if a["meerdere"]:
            r["opmerkingen"].append("variantenpagina: %d varianten met verschillende prijzen in de gestructureerde data" % len(a["alle"]))
        if a["transit"]:
            mn, mx, eenheid = a["transit"]
            if eenheid in ("DAY", "d", None):
                r["levertijd"] = ("%s werkdag(en) onderweg" % mx) if mn in (None, mx) else ("%s-%s werkdagen onderweg" % (mn, mx))
    else:
        mp = re.search(r'itemprop="price"[^>]*content="([^"]+)"|content="([^"]+)"[^>]*itemprop="price"', t)
        ma = re.search(r'itemprop="availability"[^>]*(?:content|href)="([^"]+)"|(?:content|href)="([^"]+)"[^>]*itemprop="availability"', t)
        if mp:
            r["bron"] = "microdata"
            r["prijs_eur"] = bedrag(mp.group(1) or mp.group(2))
        if ma:
            av = (ma.group(1) or ma.group(2)).rsplit("/", 1)[-1]
            r["voorraad"] = VOORRAAD_NL.get(av, av)
        r["product"] = eerste(r"<h1[^>]*>(.*?)</h1>", t, 1, re.S | re.I)
        r["product"] = platte_tekst(r["product"])[:200] if r["product"] else None

    w = r["winkel"]
    if w == "coolblue":
        v = eerste(r"(Tijdelijk uitverkocht|Op voorraad|Niet meer leverbaar|Binnenkort leverbaar|Nog \d+ op voorraad|Direct beschikbaar)", s)
        if v:
            r["voorraad"] = v.lower() if not v.startswith("Nog") else v
        winkels = eerste(r"Nog wel op te halen in \d+ winkels?", s)
        if winkels:
            r["opmerkingen"].append(winkels)
        if re.search(r"Gratis bezorgd", s):
            r["verzending_eur"], r["verzending_tekst"] = 0.0, "Coolblue-belofte op de pagina: 'Gratis bezorgd'"
        r["opmerkingen"].append("Coolblue: bezorgdag niet productgebonden te lezen (alleen het algemene 'voor 23.59 besteld, morgen in huis')")
    elif w == "bol":
        # Alleen het eigen koopblok telt: "De prijs van dit product is …" staat ook bij gesponsorde artikelen
        # verderop, en "Niet leverbaar" ook in de keuzelijst van varianten/condities (gemeten 2-11-2026).
        kb = s.find("Prijsinformatie en bestellen")
        koop = s[kb:kb + 900] if kb >= 0 else ""
        m = re.search(r"De prijs van dit product is (\d+) euro(?: en (\d+) cent)?", koop)
        if m:
            tp = round(int(m.group(1)) + int(m.group(2) or 0) / 100, 2)
            if a and a["meerdere"]:
                passend = [k for k in a["alle"] if k["prijs"] == tp]
                if passend:
                    k = passend[0]
                    r["product"], r["verkoper"] = k["naam"], k["verkoper"]
                    r["voorraad"] = VOORRAAD_NL.get(k["beschikbaar"], k["beschikbaar"]) if k["beschikbaar"] else None
            if r["prijs_eur"] != tp:
                r["opmerkingen"].append("prijs uit het koopblok (%.2f) in plaats van de gestructureerde data (%s)" % (tp, r["prijs_eur"]))
            r["prijs_eur"], r["bron"] = tp, (r["bron"] or "html")
            if r["verzending_eur"] is None and re.search(r"Inclusief verzendkosten", koop):
                r["verzending_eur"], r["verzending_tekst"] = 0.0, "bol: 'Inclusief verzendkosten' in het koopblok"
            tl = eerste(r"(Voor \d{1,2}:\d{2} (?:uur )?besteld, [a-z ]{0,25}in huis|Uiterlijk [^.]{3,40}? in huis|Morgen in huis|Vandaag in huis|Overmorgen in huis|Niet leverbaar|Tijdelijk niet leverbaar)", koop)
            if tl:
                r["levertijd"] = tl
            vk = eerste(r"Verkoop door ([^ ][^.]{0,40}?) (?:In winkelwagen|Inclusief|Bekijk)", koop, 1)
            if vk:
                r["verkoper"] = vk
        else:
            r["opmerkingen"].append("bol: geen eigen koopblok op de pagina (product zelf niet leverbaar of alleen partners); "
                                    "prijs/voorraad uit de gestructureerde data zijn een partneraanbod: controleer in de browser")
            r["levertijd"] = None
            part = eerste(r"(Vanaf [\d.,-]+ Niet leverbaar|Verkrijgbaar vanaf [\d.,-]+ Bij \d+ partners)", s)
            if part:
                r["opmerkingen"].append("pagina: " + part)
        if r["verkoper"] and r["verkoper"].lower() != "bol":
            r["opmerkingen"].append("verkoop door een partner van bol: " + r["verkoper"])
    elif w == "amazon":
        prijs = eerste(r'id="corePrice(?:Display_desktop)?_feature_div".{0,3000}?a-offscreen">\s*([^<]+)<', t, 1, re.S)
        if prijs:
            r["prijs_eur"], r["bron"] = bedrag(prijs), "html"
        blok = re.search(r'<div id="availability"[^>]*>(.{0,1500})', t, re.S)
        if blok:
            v = platte_tekst(re.split(r"<script|<style", blok.group(1))[0])[:200]
            v = re.split(r"/\*|\{", v)[0].strip(' ">')
            r["voorraad"] = v[:120] if v and not re.search(r"function|P\.when|\(\"", v) else None
        if r["prijs_eur"] is None and re.search(r"Geen aanbevolen aanbiedingen beschikbaar", s):
            r["voorraad"] = None
            r["opmerkingen"].append("Amazon: geen koopblok ('Geen aanbevolen aanbiedingen'); alleen andere verkopers, die laden pas in de browser")
        lever = re.search(r'id="deliveryBlockMessage"(.{0,2500})', t, re.S)
        if lever:
            lt = platte_tekst("<x " + lever.group(1)).strip(' ">')
            lt = re.split(r"Bezorgen aan|Locatie bijwerken|Details|\. Gegevens|<", lt)[0].strip(" .")
            r["levertijd"] = lt[:160] or None
            if re.match(r"GRATIS bezorging", lt, re.I):
                r["verzending_eur"], r["verzending_tekst"] = 0.0, "Amazon: 'GRATIS bezorging' in het koopblok"
            else:
                k = eerste(r"€\s?[\d.,]+(?=\s*bezorging)", lt)
                if k:
                    r["verzending_eur"], r["verzending_tekst"] = bedrag(k), "Amazon-koopblok: " + lt[:80]
            r["opmerkingen"].append("Amazon kiest zelf een bezorgadres (bij meting een willekeurige plaats); bezorgdatum is een indicatie")
        verk = eerste(r"Verzender\s*/\s*Verkoper\s+(\S[^ ]{0,60})", s, 1) or eerste(r"Verkocht door\s+(\S[^ ]{0,60})", s, 1)
        if verk:
            r["verkoper"] = verk
    elif w == "remarkt":
        n = eerste(r"Nog \d+ stuks? voorradig", s)
        if n:
            r["voorraad"] = n
        r["levertijd"] = eerste(r"(Morgen bezorgd|Voor 12 uur besteld, morgen in huis)", s) or r["levertijd"]
        r["verzending_tekst"] = "Remarkt: gratis verzending in Nederland vanaf € 20 (FAQ Levering & Verzending)"
        if r["prijs_eur"] is not None and r["prijs_eur"] >= 20:
            r["verzending_eur"] = 0.0
        if re.search(r"Margeproduct|Geen BTW", s):
            r["opmerkingen"].append("margeproduct: geen btw te verrekenen")
        st = eerste(r"Conditie\s+(Nette Staat|Zichtbaar gebruikt|Zichtbare schade|Zo goed als nieuw|Als nieuw)", s, 1)
        if st:
            r["opmerkingen"].append("conditie: " + st + " (de JSON-LD zegt ten onrechte NewCondition)")
    elif w in ("123inkt", "123encre", "123ink", "123accu", "123led", "123-3d", "123schoon"):
        lev = eerste(r"(Direct leverbaar|Niet op voorraad|Tijdelijk niet leverbaar|Levertijd [^.]{2,40})", s)
        if lev:
            r["voorraad"] = lev
        r["levertijd"] = eerste(r"(Morgen in huis|Vandaag in huis|Overmorgen in huis|Binnen \d+ werkdagen[^.]{0,20})", s) or r["levertijd"]
        if w in ("123inkt", "123accu", "123led", "123-3d", "123schoon"):
            # NL-zusters: zelfde tabel op /page/info_levering.html (gemeten 2-11-2026, wv2271); BE/FR-sites niet gemeten
            r["verzending_tekst"] = ("%s-tabel (%s kiest de vervoerder): € 5,95 t/m € 50, € 4,95 daarboven; nooit gratis"
                                     % (w, w))
            if r["prijs_eur"] is not None:
                r["verzending_eur"] = 5.95 if r["prijs_eur"] <= 50 else 4.95
                r["opmerkingen"].append("verzending geldt per bestelling: bij meer stuks opnieuw rekenen met het totaalbedrag")
        else:
            r["opmerkingen"].append("verzendkosten van deze zusterwinkel niet gemeten: lees de verzendpagina van de winkel")
    elif w == "hornbach":
        # wv2454: de pagina (eenvoudige User-Agent) heeft de online levertijd naast "Online bestellen" en de voorraad van de standaardvestiging;
        # verzendkosten staan er niet als bedrag ("excl. verzendkosten"), dus verzending_eur blijft null
        lt = eerste(r'"canBeAddedToCartText":"Online bestellen","deliveryTimeText":"([^"\\]{3,120})"', t, 1)
        if lt:
            r["levertijd"] = lt
        vs = eerste(r'"availabilityText":"([^"\\]{3,80})"', t, 1)
        if vs:
            r["opmerkingen"].append("vestiging (standaard, niet Leusden): " + vs)
        if re.search(r"excl\. verzendkosten", s):
            r["verzending_tekst"] = "Hornbach: prijs excl. verzendkosten; het bedrag staat niet op de pagina"
    elif w == "praxis":
        # wv2454: Praxis zet het aanbod als JSON in de pagina: verzendkosten, verwachte levering, verkoper en voorraad (gemeten 5-11-2026).
        # Alleen bij precies één aanbod (anders kan het een ander product op de pagina zijn).
        pos = [m.end() - 1 for m in re.finditer(r'"offers":\[(?=\{"deliveryCost")', t)]
        if len(pos) == 1:
            try:
                aanbod, _ = json.JSONDecoder().raw_decode(t, pos[0])
            except ValueError:
                aanbod = None
            if isinstance(aanbod, list) and len(aanbod) == 1 and isinstance(aanbod[0], dict):
                o = aanbod[0]
                kost = (o.get("deliveryCost") or {}).get("value")
                if isinstance(kost, (int, float)) and not isinstance(kost, bool) and 0 <= kost < 1000:
                    r["verzending_eur"], r["verzending_tekst"] = round(float(kost), 2), "Praxis: verzendkosten uit het aanbod op de pagina"
                modi = [m for m in (o.get("deliveryModes") or []) if isinstance(m, dict) and m.get("method") == "STD"]
                if len(modi) == 1 and isinstance(modi[0].get("description"), str):
                    r["levertijd"] = modi[0]["description"][:120]
                verk = (o.get("seller") or {}).get("name")
                if isinstance(verk, str) and verk.strip():
                    r["verkoper"] = verk.strip()[:80]
                    if verk.strip().lower() != "praxis":
                        r["opmerkingen"].append("verkoop door een partner van Praxis: " + verk.strip()[:80])
                st = o.get("stock") or {}
                if st.get("stockLevelStatus") == "inStock":
                    r["voorraad"] = "op voorraad" + (" (%d stuks)" % st["stockLevel"] if isinstance(st.get("stockLevel"), int) and not isinstance(st.get("stockLevel"), bool) else "")
                elif st.get("stockLevelStatus") == "outOfStock":
                    r["voorraad"] = "niet op voorraad"
    if r["prijs_eur"] is None:
        r["opmerkingen"].append("prijs niet te lezen")
    if r["voorraad"] is None:
        r["opmerkingen"].append("voorraad niet te lezen")
    return r


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__.strip())
        sys.exit(2)
    for a in sys.argv[1:13]:
        print(json.dumps(lees(a), ensure_ascii=False))
