#!/usr/bin/env python3
"""winkel-score.py — OVIS Shopper fase 3 (wv2935, 11-11-2026): de openbare winkelscore lezen, alleen uit bronnen die lezen toestaan.

WAAROM. Plan "OVIS Shopper naar een 8" § 4a en Fable 5.2 b8: bij een winkel wil David zien of anderen er goed kochten, met bron, cijfer,
aantal en leesdatum; nooit door een taalmodel ingevuld. Trustpilot niet: robots.txt verbiedt elke gewone bezoeker (gemeten 9-11).

BRONNEN (gemeten 11-11-2026, eigen User-Agent, robots.txt gevolgd):
  - Kieskeurig  https://www.kieskeurig.nl/winkels/<slug>   robots "Allow: /"; de zichtbare regel "Gemiddelde beoordeling Gebaseerd op N
    ervaringen met <winkel> X" (de JSON-LD noemt een ander, groter aantal: we nemen wat de bezoeker ziet).
  - Kiyoh       https://www.kiyoh.com/reviews/<nr>/<naam>/  geen robots-regels (404); JSON-LD aggregateRating van het bedrijf.
  - Thuiswinkel https://www.thuiswinkel.org/leden/<slug>/certificaat  alleen ja + "Lid sinds <datum>" (geen cijfer); de "Website URL" op de
    pagina moet bij het domein van de winkel horen, anders telt het niet.

GEBRUIK
  stdin: {"winkels": [{"domein": "vosmedisch.nl", "kieskeurig": "slug"?, "kiyoh": "https://www.kiyoh.com/reviews/…"?, "thuiswinkel": "slug"?}]}
  stdout: één regel JSON {"op": ISO, "winkels": {domein: {"kieskeurig": {...}|null, "kiyoh": {...}|null, "thuiswinkel": {...}|null}}}
    per bron {"cijfer": 8.8|null, "aantal": 107|null, "url": …} of {"sinds": "2009-05-31", "url": …} of {"fout": "…", "url": …}
  python3 -I winkel-score.py --ontleed kieskeurig|kiyoh|thuiswinkel <bestand> [domein]   (toets: alleen ontleden, geen netwerk)

GRENZEN. Alleen GET op deze drie vaste hosts via https, doorsturen alleen binnen dezelfde host, ≤ 4 MB per pagina, 20 s per vraag, 1 s pauze
tussen vragen, hooguit 80 winkels, na 140 s geen nieuwe vraag meer (de rest = "tijd op"; de pod stopt het proces na 180 s). Geen cookies, geen sleutel, geen gegevens van David.
"""
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timezone

UA = "Socev-Shopper/1.0 (persoonlijke prijscheck, alleen lezen)"
MAX_BYTES = 4 * 1024 * 1024
MAX_WINKELS = 80   # review ronde 2 ZOU 3: gelijk aan de module (shopper-winkels.js MAX_WINKELS); de tijdgrens begrenst de duur
DEADLINE_S = 140   # review wv2935 ZOU 1: de pod stopt het proces na 180 s; daarna geen nieuwe vraag meer (rest = "tijd op"), wel een uitkomst
HOSTS = {"kieskeurig": "www.kieskeurig.nl", "kiyoh": "www.kiyoh.com", "thuiswinkel": "www.thuiswinkel.org"}
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
KIYOH_RE = re.compile(r"^https://www\.kiyoh\.com/reviews/\d{1,12}/[a-z0-9_]{1,80}/?$")
DOMEIN_RE = re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$")
MAANDEN = {"januari": 1, "februari": 2, "maart": 3, "april": 4, "mei": 5, "juni": 6, "juli": 7, "augustus": 8, "september": 9,
           "oktober": 10, "november": 11, "december": 12}


def platte_tekst(t):
    s = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S | re.I)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    return re.sub(r"\s+", " ", s)


def getal(x):
    try:
        v = float(str(x).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return v if 0 <= v <= 10 else None


def ontleed_kieskeurig(t):
    s = platte_tekst(t)
    m = re.search(r"Gemiddelde beoordeling Gebaseerd op (\d{1,7}) ervaring(?:en)? met .{1,80}? (\d{1,2}(?:[.,]\d)?)(?: |$)", s)
    if not m:
        return {"fout": "geen beoordeling op de pagina"}
    n = int(m.group(1))
    if n == 0:
        return {"cijfer": None, "aantal": 0}
    c = getal(m.group(2))
    return {"cijfer": c, "aantal": n} if c is not None else {"fout": "cijfer niet te lezen"}


def _jsonld(t):
    for m in re.finditer(r"<script[^>]*application/ld\+json[^>]*>(.*?)</script>", t, re.S | re.I):
        try:
            yield json.loads(m.group(1))
        except ValueError:
            continue


def ontleed_kiyoh(t):
    def loop(x):
        if isinstance(x, list):
            for y in x:
                r = loop(y)
                if r:
                    return r
        elif isinstance(x, dict):
            soort = x.get("@type")
            soort = soort if isinstance(soort, str) else ""
            ar = x.get("aggregateRating")
            if isinstance(ar, dict) and soort not in ("Product", "Review"):
                return ar
            for k in ("@graph", "itemReviewed", "mainEntity", "about"):
                if k in x:
                    r = loop(x[k])
                    if r:
                        return r
        return None
    for d in _jsonld(t):
        ar = loop(d)
        if ar:
            c, n = getal(ar.get("ratingValue")), ar.get("reviewCount")
            best = getal(ar.get("bestRating")) if ar.get("bestRating") is not None else 10
            if c is None or best != 10 or not isinstance(n, int) or n < 0:
                return {"fout": "cijfer niet te lezen"}
            return {"cijfer": c, "aantal": n}
    return {"fout": "geen beoordeling op de pagina"}


def _kale_host(u):
    u = re.sub(r"^https?://", "", (u or "").strip().lower()).split("/")[0]
    return re.sub(r"^www\.", "", u)


def ontleed_thuiswinkel(t, domein):
    s = platte_tekst(t)
    w = re.search(r"Website URL (\S+)", s)
    if not w:
        return {"fout": "geen certificaat op de pagina"}
    h = _kale_host(w.group(1))
    if not domein or not (h == domein or h.endswith("." + domein) or domein.endswith("." + h)):
        return {"fout": "certificaat hoort bij een andere website (%s)" % h[:60]}
    m = re.search(r"Lid sinds (\d{1,2}) ([a-z]+) (\d{4})", s, re.I)
    if not m or m.group(2).lower() not in MAANDEN:
        return {"fout": "geen datum 'Lid sinds' op de pagina"}
    try:
        d = datetime(int(m.group(3)), MAANDEN[m.group(2).lower()], int(m.group(1)))
    except ValueError:
        return {"fout": "geen geldige datum"}
    return {"sinds": d.strftime("%Y-%m-%d")}


class _ZelfdeHost(urllib.request.HTTPRedirectHandler):
    max_redirections = 3

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        doel = urllib.parse.urljoin(req.full_url, newurl)
        u = urllib.parse.urlsplit(doel)
        if u.scheme != "https" or u.hostname != urllib.parse.urlsplit(req.full_url).hostname:
            raise urllib.error.HTTPError(doel, 399, "doorsturen naar een andere host geweigerd", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, doel)


def uitpakken(body):
    """gzip uitpakken met dezelfde 4 MB-grens als het lezen (diff-review wv2946 MOET 3, zelfde fout als in prijshistorie.py)."""
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        uit = d.decompress(body, MAX_BYTES + 1)
    except zlib.error:
        raise ValueError("pagina niet uit te pakken")
    if len(uit) > MAX_BYTES or d.unconsumed_tail:
        raise ValueError("pagina te groot")
    return uit


def haal(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" or u.hostname not in HOSTS.values() or u.port not in (None, 443):
        raise ValueError("alleen de vaste reviewbronnen")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html", "Accept-Language": "nl-NL,nl;q=0.9",
                                               "Accept-Encoding": "gzip"})
    opener = urllib.request.build_opener(_ZelfdeHost())
    try:
        r = opener.open(req, timeout=20)
        code, body, hdr = r.status, r.read(MAX_BYTES + 1), r.headers
    except urllib.error.HTTPError as e:
        if e.code == 399:
            raise ValueError(e.msg)
        return e.code, ""
    if len(body) > MAX_BYTES:
        raise ValueError("pagina te groot")
    if (hdr.get("Content-Encoding") or "").lower() == "gzip":
        body = uitpakken(body)
    return code, body.decode("utf-8", "replace")


def url_van(bron, w):
    v = w.get(bron)
    if not isinstance(v, str) or not v:
        return None
    if bron == "kieskeurig":
        return "https://www.kieskeurig.nl/winkels/" + v if SLUG_RE.match(v) else None
    if bron == "kiyoh":
        return v if KIYOH_RE.match(v) else None
    if bron == "thuiswinkel":
        return "https://www.thuiswinkel.org/leden/" + v + "/certificaat" if SLUG_RE.match(v) else None
    return None


def lees_bron(bron, url, domein):
    try:
        code, t = haal(url)
    except Exception as e:  # netwerk, time-out, doorsturen
        return {"fout": "niet te lezen (%s)" % str(e)[:80], "url": url}
    if code != 200:
        return {"fout": "niet te lezen (HTTP %s)" % code, "url": url}
    r = ontleed_kieskeurig(t) if bron == "kieskeurig" else ontleed_kiyoh(t) if bron == "kiyoh" else ontleed_thuiswinkel(t, domein)
    r["url"] = url
    return r


def main(argv):
    if len(argv) >= 3 and argv[0] == "--ontleed":
        t = open(argv[2], encoding="utf-8", errors="replace").read()
        r = (ontleed_kieskeurig(t) if argv[1] == "kieskeurig" else ontleed_kiyoh(t) if argv[1] == "kiyoh"
             else ontleed_thuiswinkel(t, argv[3] if len(argv) > 3 else ""))
        print(json.dumps(r, ensure_ascii=False))
        return 0
    try:
        d = json.loads(sys.stdin.read(256 * 1024) or "{}")
    except ValueError:
        print(json.dumps({"fout": "invoer is geen json"}))
        return 2
    winkels = d.get("winkels") if isinstance(d, dict) else None
    if not isinstance(winkels, list):
        print(json.dumps({"fout": "winkels ontbreekt"}))
        return 2
    pauze = d.get("pauze", 1.0)
    pauze = pauze if isinstance(pauze, (int, float)) and 0 <= pauze <= 5 else 1.0
    uit, eerste, t0 = {}, True, time.monotonic()
    for w in winkels[:MAX_WINKELS]:
        if not isinstance(w, dict) or not isinstance(w.get("domein"), str) or not DOMEIN_RE.match(w["domein"]):
            continue
        r = {}
        for bron in ("kieskeurig", "kiyoh", "thuiswinkel"):
            url = url_van(bron, w)
            if not url:
                r[bron] = None
                continue
            if time.monotonic() - t0 > DEADLINE_S:
                r[bron] = {"fout": "niet gelezen (tijd op)", "url": url}
                continue
            if not eerste:
                time.sleep(pauze)
            eerste = False
            r[bron] = lees_bron(bron, url, w["domein"])
        uit[w["domein"]] = r
    print(json.dumps({"op": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "winkels": uit}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
