#!/usr/bin/env python3
"""prijshistorie.py — OVIS Shopper fase 4 (wv2946, 11-11-2026): de openbare prijshistorie van Kieskeurig bij het advies van een zoektocht.

WAAROM. David (9-11) en Fable 5.2 b12: bij een advies één zin of het nu een goed moment is ("laagste prijs in 90 dagen" of "op d-m was het
€ x"). Ontwerp vault "01_Ontwikkeling/OVIS Shopper fase 4 - aanwijzen, prijshistorie en bewaken (ontwerp wv2935, 11-11-2026).md", vooraf
gereviewd (Codex GO-MET-WIJZIGINGEN; MOET 1 = zelfde product, MOET 2 = vaste rekenregels). Nooit een koopadvies, alleen het feit.

BRON (gemeten 11-11-2026, eigen User-Agent, robots.txt "Allow: /" met een paar Disallow-regels, hieronder nagevolgd):
  - zoeken  https://www.kieskeurig.nl/search?q=<product>  → 200 met een JSON-LD ItemList (naam, merk, link), of 301 naar een categorie-
    pagina op dezelfde host met dezelfde ItemList (bv. ?q=philips airfryer → /airfryer/merk/philips).
  - product https://www.kieskeurig.nl/<categorie>/product/<nr>-<slug>  → astro-island props met "priceHistory" (per dag {ean, amount,
    date}; amount = laagste prijs die dag) en "hidePriceHistory"; gemeten: 227 punten over 268 dagen (Philips NA552/00), soms leeg.

ZELFDE PRODUCT (review MOET 1). Alleen als (a) het merk van Kieskeurig als woord in de productnaam van het advies staat, (b) er een exact
modelnummer in beide namen staat (woord met letters én cijfers, ≥ 4 tekens zonder streepjes/schuine strepen, geen maat of eenheid zoals
2750W of 180kg), en (c) de uitvoeringskenmerken (aantal/set, maat in mm/cm/m, inhoud in GB/TB/l/ml/kg/g, kleur) in beide namen gelijk zijn;
staat een kenmerk maar aan één kant, dan geen zin. Woordoverlap alleen is nooit genoeg.

REKENREGELS (review MOET 2). Punten = (dag, laagste bedrag) met een geldige datum en een bedrag > 0; per dag de laagste. Venster = de 90 dagen
tot en met vandaag (Europe/Amsterdam). Dekking: oudste punt ≥ 85 dagen terug, nieuwste ≤ 3 dagen terug, geen gat > 14 dagen tussen twee
punten. Nu = het bedrag van het nieuwste punt. Zinnen:
  nu ≤ minimum             → "Kieskeurig: laagste prijs in 90 dagen (€ nu, gelezen d-m)"            (d-m = dag van het nieuwste punt)
  minimum ≤ nu − max(5, 5%) → "Kieskeurig: op d-m was het € min (nu € nu); laagste in 90 dagen"     (d-m = de laatste dag met dat minimum)
  anders geen zin.

GEBRUIK
  stdin: {"product": "<productnaam van het advies>", "vandaag"?: "JJJJ-MM-DD" (alleen toets)}
  stdout: één regel JSON {"op": ISO, "zin": "…"|null, "reden": "…", "url": productpagina|null, "naam": naam op Kieskeurig|null}
  python3 -I prijshistorie.py --toets <bestanden-map>   (toets: leest zoek.html / <nr>.html uit die map in plaats van het net)

GRENZEN. Alleen GET via https op www.kieskeurig.nl, doorsturen alleen binnen die host en niet naar een pad dat robots.txt verbiedt, ≤ 4 MB per
pagina, 20 s per vraag, 1 s pauze, hooguit 2 zoekvragen en 1 productpagina. Geen cookies, geen sleutel; de productnaam gaat alleen als
zoekterm naar Kieskeurig en komt in geen log (dit script schrijft niets weg).
"""
import gzip
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

UA = "Socev-Shopper/1.0 (persoonlijke prijscheck, alleen lezen)"
HOST = "www.kieskeurig.nl"
MAX_BYTES = 4 * 1024 * 1024
VENSTER, DEKKING, VERS, GAT = 90, 85, 3, 14
MAX_ZOEK = 2
# robots.txt van Kieskeurig (gemeten 11-11-2026): deze paden en query's niet
ROBOTS_PAD = re.compile(r"^/(product/redirect/|product-clickout/|[^/]+/productwidget/|mobile|widget|collect|fb-event|login|api/|prr/|[^/]+/ajax/|[^/]+/page[-_]action/)")
ROBOTS_QUERY = re.compile(r"[sn]=")   # Disallow /*?*s=, /*?*n=, /*?*merken=, /*?*prijs= (alle vier eindigen op s= of n=)
PRODUCT_PAD = re.compile(r"^/[a-z0-9-]{1,80}/product/\d{1,12}-[a-z0-9-]{1,200}$")

KLEUREN = {"zwart", "wit", "grijs", "antraciet", "zilver", "zilverkleurig", "rood", "blauw", "donkerblauw", "lichtblauw", "groen", "geel",
           "roze", "paars", "oranje", "bruin", "beige", "goud", "goudkleurig", "creme", "crème", "taupe", "black", "white", "grey", "gray",
           "silver", "red", "blue", "green", "yellow", "pink", "purple", "orange", "brown", "gold", "navy", "mint", "turquoise", "turquoise",
           "middernachtblauw"}
EENHEID_MODEL = re.compile(r"^\d+([.,]\d+)?(w|kw|kg|g|gr|l|ml|cl|cm|mm|m|gb|tb|mb|mah|v|hz|inch|x|st|stuks|p|mp)$")


def norm(s):
    return re.sub(r"\s+", " ", str(s or "").replace(" ", " ")).strip().lower()


def modelnummers(naam):
    """Woorden met letters én cijfers, ≥ 4 tekens zonder - / . , geen maat of eenheid (2750W, 180kg, 9L)."""
    uit = set()
    for w in re.split(r"[\s,;:()\[\]+|]+", norm(naam)):
        w = w.strip("-/.'\"")
        if not w or EENHEID_MODEL.match(w):
            continue
        k = re.sub(r"[-/.]", "", w)
        if len(k) >= 4 and re.search(r"\d", k) and re.search(r"[a-z]", k) and re.match(r"^[a-z0-9]+$", k):
            uit.add(k)
    return uit


def _getal(s):
    return re.sub(r"[.,]0+$", "", s.replace(",", "."))


def kenmerken(naam):
    """Per soort de uitvoeringskenmerken uit een naam: aantal, maat, inhoud, kleur (elk een verzameling)."""
    t = norm(naam)
    k = {"aantal": set(), "maat": set(), "inhoud": set(), "kleur": set()}
    for m in re.finditer(r"(?<![\w.,])(\d{1,4})\s?(?:stuks|stuk|st\.|-?pack|pak|delig|-delig)(?!\w)", t):
        k["aantal"].add(m.group(1))
    for m in re.finditer(r"(?:set van|per|verpakking van|doos van)\s(\d{1,4})(?!\w)", t):
        k["aantal"].add(m.group(1))
    for m in re.finditer(r"(?<![\w.,])(\d{1,4})\s?x(?=\s|$)(?!\s*\d)|(?<![\w.,\d]\s)(?<![\w.,])x\s?(\d{1,4})(?![\w.,])", t):
        k["aantal"].add(m.group(1) or m.group(2))
    for m in re.finditer(r"(?<![\w.,])(\d{1,5}(?:[.,]\d{1,2})?(?:\s?x\s?\d{1,5}(?:[.,]\d{1,2})?){0,2})\s?(mm|cm|m|meter)(?!\w)", t):
        e = "m" if m.group(2) == "meter" else m.group(2)
        k["maat"].add("x".join(_getal(x) for x in re.split(r"\s?x\s?", m.group(1))) + e)
    for m in re.finditer(r"(?<![\w.,])(\d{1,5}(?:[.,]\d{1,2})?)\s?(gb|tb|l|liter|ltr|ml|kg|g|gram)(?!\w)", t):
        e = {"liter": "l", "ltr": "l", "gram": "g"}.get(m.group(2), m.group(2))
        k["inhoud"].add(_getal(m.group(1)) + e)
    for w in re.split(r"[^\wÀ-ÿ]+", t):
        if w in KLEUREN:
            k["kleur"].add({"gray": "grey", "zilverkleurig": "zilver", "goudkleurig": "goud", "crème": "creme"}.get(w, w))
    return k


def zelfde_product(advies, kk_naam, kk_merk):
    """(True, "") als het hetzelfde product is volgens MOET 1, anders (False, reden)."""
    merk = norm(kk_merk)
    if not merk or len(merk) < 2:
        return False, "geen merk bij Kieskeurig"
    if not re.search(r"(?<![\w])" + re.escape(merk) + r"(?![\w])", norm(advies)):
        return False, "ander merk"
    a, b = modelnummers(advies), modelnummers(kk_naam)
    if not a:
        return False, "geen modelnummer in het advies"
    if not b or not (a & b):
        return False, "ander of geen modelnummer"
    ka, kb = kenmerken(advies), kenmerken(kk_naam)
    for soort in ("aantal", "maat", "inhoud", "kleur"):
        if ka[soort] != kb[soort]:
            return False, "uitvoering verschilt of staat maar aan één kant (%s)" % soort
    return True, ""


def eur(x):
    c = int(round(x * 100))
    return "€ %d" % (c // 100) if c % 100 == 0 else "€ %d,%02d" % (c // 100, c % 100)


def dm(d):
    return "%d-%d" % (d.day, d.month)


def punten_van(reeks):
    """priceHistory → {date: laagste bedrag}; alleen geldige datums en bedragen > 0."""
    per = {}
    for p in reeks if isinstance(reeks, list) else []:
        if not isinstance(p, dict):
            continue
        a, d = p.get("amount"), p.get("date")
        if isinstance(a, bool) or not isinstance(a, (int, float)) or not (0 < a < 1000000) or not isinstance(d, str):
            continue
        try:
            dag = date.fromisoformat(d[:10])
        except ValueError:
            continue
        if dag not in per or a < per[dag]:
            per[dag] = float(a)
    return per


def zin_van(per, vandaag):
    """De vaste rekenregels (MOET 2) → (zin | None, reden)."""
    begin = vandaag - timedelta(days=VENSTER - 1)
    dagen = sorted(d for d in per if begin <= d <= vandaag)
    if not dagen:
        return None, "geen punten in 90 dagen"
    if (vandaag - dagen[0]).days < DEKKING:
        return None, "te korte reeks (oudste punt %d dagen terug)" % (vandaag - dagen[0]).days
    if (vandaag - dagen[-1]).days > VERS:
        return None, "nieuwste punt te oud (%d dagen)" % (vandaag - dagen[-1]).days
    for x, y in zip(dagen, dagen[1:]):
        if (y - x).days > GAT:
            return None, "gat van %d dagen in de reeks" % (y - x).days
    nu_dag = dagen[-1]
    nu = per[nu_dag]
    laagst = min(per[d] for d in dagen)
    if round(nu * 100) <= round(laagst * 100):
        return "Kieskeurig: laagste prijs in 90 dagen (%s, gelezen %s)" % (eur(nu), dm(nu_dag)), "laagste"
    drempel = nu - max(5.0, nu * 0.05)
    if round(laagst * 100) <= round(drempel * 100):
        min_dag = max(d for d in dagen if round(per[d] * 100) == round(laagst * 100))
        return "Kieskeurig: op %s was het %s (nu %s); laagste in 90 dagen" % (dm(min_dag), eur(laagst), eur(nu)), "was_lager"
    return None, "geen duidelijk verschil"


# ── lezen ──
def mag(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" or u.hostname != HOST or u.port not in (None, 443):
        return False
    if ROBOTS_PAD.match(u.path or "/"):
        return False
    return not (u.query and ROBOTS_QUERY.search(u.query))


class _ZelfdeHost(urllib.request.HTTPRedirectHandler):
    max_redirections = 3

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        doel = urllib.parse.urljoin(req.full_url, newurl)
        if not mag(doel):
            raise urllib.error.HTTPError(doel, 399, "doorsturen buiten Kieskeurig of naar een verboden pad geweigerd", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, doel)


def haal_net(url):
    if not mag(url):
        raise ValueError("alleen Kieskeurig")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html", "Accept-Language": "nl-NL,nl;q=0.9",
                                               "Accept-Encoding": "gzip"})
    try:
        r = urllib.request.build_opener(_ZelfdeHost()).open(req, timeout=20)
        code, body, hdr = r.status, r.read(MAX_BYTES), r.headers
    except urllib.error.HTTPError as e:
        if e.code == 399:
            raise ValueError(e.msg)
        return e.code, ""
    if (hdr.get("Content-Encoding") or "").lower() == "gzip":
        try:
            body = gzip.decompress(body)
        except OSError:
            pass
    return code, body.decode("utf-8", "replace")


def haal_toets(map_):
    """Toets: zoek.html voor /search, <nr>.html voor een productpagina, lijst.html voor de rest (een categoriepagina)."""
    def haal(url):
        if not mag(url):
            raise ValueError("alleen Kieskeurig")
        u = urllib.parse.urlsplit(url)
        m = re.search(r"/product/(\d+)-", u.path)
        naam = "zoek.html" if u.path == "/search" else (m.group(1) + ".html") if m else "lijst.html"
        p = os.path.join(map_, naam)
        if not os.path.exists(p):
            return 404, ""
        return 200, open(p, encoding="utf-8", errors="replace").read()
    return haal


def jsonld(t):
    for m in re.finditer(r"<script[^>]*application/ld\+json[^>]*>(.*?)</script>", t, re.S | re.I):
        try:
            yield json.loads(m.group(1))
        except ValueError:
            continue


def kandidaten(t):
    """De producten op een zoek- of categoriepagina: [(naam, merk, url)] uit de JSON-LD ItemList."""
    uit = []
    for d in jsonld(t):
        graaf = d.get("@graph") if isinstance(d, dict) and isinstance(d.get("@graph"), list) else [d]
        for g in graaf:
            if not isinstance(g, dict) or g.get("@type") != "ItemList" or not isinstance(g.get("itemListElement"), list):
                continue
            for e in g["itemListElement"][:48]:
                it = e.get("item") if isinstance(e, dict) else None
                if not isinstance(it, dict):
                    continue
                merk = it.get("brand")
                merk = merk.get("name") if isinstance(merk, dict) else merk
                url = it.get("url") or e.get("url")
                if isinstance(it.get("name"), str) and isinstance(merk, str) and isinstance(url, str):
                    uit.append((it["name"][:300], merk[:80], url))
    return uit


def _astro(x):
    """Astro-props: [0, waarde] of [1, lijst]; de rest (datum, map, …) telt niet."""
    if isinstance(x, list) and len(x) == 2 and isinstance(x[0], int):
        if x[0] == 0:
            v = x[1]
            return {k: _astro(w) for k, w in v.items()} if isinstance(v, dict) else v
        if x[0] == 1 and isinstance(x[1], list):
            return [_astro(y) for y in x[1]]
        return None
    if isinstance(x, dict):
        return {k: _astro(w) for k, w in x.items()}
    return x


def prijsreeks(t):
    """priceHistory van een productpagina → (lijst | None, verborgen)."""
    for m in re.finditer(r"<astro-island[^>]*?\sprops=\"([^\"]*)\"", t):
        p = html.unescape(m.group(1))
        if "priceHistory" not in p:
            continue
        try:
            d = json.loads(p)
        except ValueError:
            continue
        if not isinstance(d, dict) or "priceHistory" not in d:
            continue
        verborgen = _astro(d.get("hidePriceHistory")) is True
        r = _astro(d["priceHistory"])
        return (r if isinstance(r, list) else None), verborgen
    return None, False


def zoektermen(product):
    p = re.sub(r"\s+", " ", product).strip()[:120]
    termen = [p]
    mods = [w for w in re.split(r"\s+", p) if re.sub(r"[-/.]", "", w.lower()) in modelnummers(p)]
    if mods:
        termen.append(" ".join(mods[:2]))
    return [x for i, x in enumerate(termen) if x and x not in termen[:i]][:MAX_ZOEK]


def lees(product, vandaag, haal, pauze=1.0):
    uit = {"zin": None, "reden": "", "url": None, "naam": None}
    if not isinstance(product, str) or len(product.strip()) < 3:
        uit["reden"] = "geen productnaam"
        return uit
    if not modelnummers(product):
        uit["reden"] = "geen modelnummer in het advies"
        return uit
    gevonden, eerste, reden = None, True, "niet gevonden op Kieskeurig"
    for term in zoektermen(product):
        if not eerste:
            time.sleep(pauze)
        eerste = False
        try:
            code, t = haal("https://%s/search?%s" % (HOST, urllib.parse.urlencode({"q": term})))
        except Exception as e:  # netwerk, time-out, doorsturen
            uit["reden"] = "fout: zoeken niet te lezen (%s)" % str(e)[:80]
            return uit
        if code != 200:
            uit["reden"] = "fout: zoeken gaf HTTP %s" % code
            return uit
        for naam, merk, url in kandidaten(t):
            ok, r = zelfde_product(product, naam, merk)
            u = urllib.parse.urlsplit(url)
            if ok and mag(url) and PRODUCT_PAD.match(u.path) and not u.query:
                gevonden = (naam, merk, url)
                break
            if r and reden == "niet gevonden op Kieskeurig":
                reden = "niet hetzelfde product (%s)" % r
        if gevonden:
            break
    if not gevonden:
        uit["reden"] = reden
        return uit
    naam, merk, url = gevonden
    uit["url"], uit["naam"] = url, naam
    time.sleep(pauze)
    try:
        code, t = haal(url)
    except Exception as e:
        uit["reden"] = "fout: productpagina niet te lezen (%s)" % str(e)[:80]
        return uit
    if code != 200:
        uit["reden"] = "fout: productpagina gaf HTTP %s" % code
        return uit
    reeks, verborgen = prijsreeks(t)
    if verborgen:
        uit["reden"] = "prijshistorie verborgen"
        return uit
    if reeks is None:
        uit["reden"] = "geen prijshistorie op de pagina"
        return uit
    uit["zin"], uit["reden"] = zin_van(punten_van(reeks), vandaag)
    return uit


def vandaag_nl():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Europe/Amsterdam")).date()
    except Exception:  # zonder tijdzonedata: UTC
        return datetime.now(timezone.utc).date()


def main(argv):
    try:
        d = json.loads(sys.stdin.read(64 * 1024) or "{}")
    except ValueError:
        print(json.dumps({"fout": "invoer is geen json"}))
        return 2
    if not isinstance(d, dict):
        print(json.dumps({"fout": "invoer is geen object"}))
        return 2
    vandaag = vandaag_nl()
    if isinstance(d.get("vandaag"), str):
        try:
            vandaag = date.fromisoformat(d["vandaag"])
        except ValueError:
            pass
    toets = len(argv) >= 2 and argv[0] == "--toets"
    r = lees(d.get("product"), vandaag, haal_toets(argv[1]) if toets else haal_net, 0 if toets else 1.0)
    r["op"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(json.dumps(r, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
