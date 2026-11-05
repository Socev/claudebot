#!/usr/bin/env bash
# Toetst winkel-lezen.py (OVIS Shopper, wv2454, 5-11-2026): het leesscript dat de skill ovis-shopper én de pod (Apps › Shopper, "Prijzen nu
# nalezen") gebruiken. Zonder netwerk: haal() en de DNS-vraag worden vervangen. Alleen verzonnen pagina's en winkels.
#  1. adresgrens: alleen https op poort 443 met een gewone hostnaam; ip-adressen, interne namen en adressen die naar een intern netwerk
#     wijzen (ook na doorsturen) worden geweigerd, nog vóór er iets wordt opgehaald
#  2. Hornbach: eenvoudige User-Agent, "Client Challenge" = bot-controle, online levertijd en vestigingsvoorraad uit de pagina
#  3. Praxis: verzendkosten, verwachte levering, verkoper en voorraad uit het ene aanbod op de pagina; twee aanbiedingen = niets gokken
#  4. de kopie in de vault-skill is byte-gelijk aan deze (alleen als de vault er is; in CI overgeslagen)
# Gebruik: bash test/winkel-lezen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
python3 -I - "$PWD/winkel-lezen.py" <<'PY'
import importlib.util, json, os, socket, ssl, sys, urllib.error, urllib.request
spec = importlib.util.spec_from_file_location("wl", sys.argv[1]); wl = importlib.util.module_from_spec(spec); spec.loader.exec_module(wl)
goed = fout = 0
def toets(naam, ok, extra=None):
    global goed, fout
    if ok: goed += 1
    else: fout += 1
    print(("GROEN " if ok else "ROOD  ") + naam + ("" if ok or extra is None else "  [" + json.dumps(extra, ensure_ascii=False, default=str)[:400] + "]"))

# ── 1. adresgrens ──
for url, naam in [("https://127.0.0.1/p/1", "ip-adres"), ("https://[::1]/p/1", "ipv6"), ("https://localhost/p/1", "naam zonder punt"),
                  ("https://www.proefwinkel.nl:8443/p/1", "andere poort"), ("http://www.proefwinkel.nl/p/1", "http"),
                  ("https://user:pw@www.proefwinkel.nl/p/1", "inloggegevens"), ("https://www.proefwinkel.nl:abc/p", "kapotte poort"),
                  ("https://10.0.0.5.nip.io:443/p", None)]:
    if naam:
        toets("1a geweigerd zonder ophalen: " + naam, wl.toegestaan(url) is not None, wl.toegestaan(url))
toets("1b gewone productpagina mag", wl.toegestaan("https://www.proefwinkel.nl/p/kast/1/") is None)
echt = socket.getaddrinfo
def nep_dns(uitkomst):
    def f(host, *a, **k):
        if isinstance(uitkomst, Exception): raise uitkomst
        return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in uitkomst]
    return f
for ips, verwacht, naam in [(["93.184.216.34"], None, "openbaar adres"), (["10.1.2.3"], "intern", "10/8"), (["192.168.1.9"], "intern", "192.168/16"),
                            (["169.254.169.254"], "intern", "link-local (metadata)"), (["127.0.0.1"], "intern", "loopback"), (["100.64.0.1"], "intern", "CGNAT"),
                            (["93.184.216.34", "10.0.0.1"], "intern", "één van twee intern"), (["::1"], "intern", "ipv6 loopback"), (["fd00::1"], "intern", "ipv6 ULA")]:
    socket.getaddrinfo = nep_dns(ips)
    r = wl.openbaar("www.proefwinkel.nl")
    toets("1c DNS " + naam + " → " + ("toegestaan" if verwacht is None else "geweigerd"), (r is None) if verwacht is None else (r is not None and verwacht in r), r)
socket.getaddrinfo = nep_dns(socket.gaierror("geen"))
toets("1d hostnaam bestaat niet = geweigerd", wl.openbaar("bestaat-niet.nl") == "hostnaam bestaat niet")
# lees(): een interne hostnaam wordt niet opgehaald (haal() faalt vóór de GET)
socket.getaddrinfo = nep_dns(["10.0.0.7"])
gevraagd = []
echt_open = urllib.request.OpenerDirector.open
urllib.request.OpenerDirector.open = lambda self, *a, **k: gevraagd.append(a) or (_ for _ in ()).throw(AssertionError("opgehaald"))
r = wl.lees("https://intern-proef.nl/p/1")
toets("1e lees() op een naam die naar een intern adres wijst: blokkade, niets opgehaald", gevraagd == [] and r["blokkade"] and "intern" in r["blokkade"], r)
urllib.request.OpenerDirector.open = echt_open
# doorsturen naar een intern adres
socket.getaddrinfo = nep_dns(["10.0.0.7"])
h = wl._Doorsturen("anders")
try:
    h.redirect_request(urllib.request.Request("https://www.proefwinkel.nl/p/1"), None, 302, "Found", {}, "https://www.proefwinkel.nl/p/2"); doorgestuurd = True
except urllib.error.HTTPError as e:
    doorgestuurd = e.code != 399
toets("1f doorsturen naar een hostnaam met een intern adres = geweigerd", doorgestuurd is False)
socket.getaddrinfo = echt
# review MOET 1: de verbinding gaat naar het net goedgekeurde adres (geen tweede DNS-vraag); intern bij het verbinden = geweigerd
verbonden = []
echt_cc = socket.create_connection
socket.create_connection = lambda adres, *a, **k: verbonden.append(adres) or (_ for _ in ()).throw(OSError("proef: geen netwerk"))
socket.getaddrinfo = nep_dns(["93.184.216.34"])
try:
    wl._VasteVerbinding("www.proefwinkel.nl", 443, timeout=5, context=ssl.create_default_context()).connect()
except OSError:
    pass
toets("1g verbinding naar precies het goedgekeurde openbare adres", verbonden == [("93.184.216.34", 443)], verbonden)
verbonden.clear()
socket.getaddrinfo = nep_dns(["10.9.9.9"])
try:
    wl._VasteVerbinding("www.proefwinkel.nl", 443, timeout=5, context=ssl.create_default_context()).connect(); fout_gegooid = False
except OSError as e:
    fout_gegooid = "intern" in str(e)
toets("1h DNS wijst bij het verbinden intern (rebinding) = geweigerd, geen verbinding", fout_gegooid and verbonden == [], verbonden)
handlers = [type(h).__name__ for h in urllib.request.build_opener(wl._Doorsturen("anders"), wl._VasteHTTPS()).handlers]
toets("1i de opener gebruikt de vastgepinde HTTPS (niet de gewone)", "_VasteHTTPS" in handlers and "HTTPSHandler" not in handlers, handlers)
socket.create_connection = echt_cc
socket.getaddrinfo = echt

# ── 2/3. winkelpagina's (haal vervangen) ──
def met_pagina(html, status=200):
    gezien = {}
    def nep(url):
        gezien["url"] = url
        return status, url, html
    wl.haal = nep
    return gezien
HB_UA = []
def hb_haal_ua():
    # welke User-Agent kiest haal() voor Hornbach? Vang het Request op zonder netwerk
    socket.getaddrinfo = nep_dns(["93.184.216.34"])
    uit = {}
    def nep_open(self, req, timeout=None):
        uit["ua"] = req.get_header("User-agent"); raise urllib.error.URLError("proef")
    oud = urllib.request.OpenerDirector.open
    urllib.request.OpenerDirector.open = nep_open
    try: wl_echt_haal("https://www.hornbach.nl/p/proefrek/123/")
    except Exception: pass
    urllib.request.OpenerDirector.open = oud
    socket.getaddrinfo = echt
    return uit.get("ua")
wl_echt_haal = wl.haal
ua = hb_haal_ua()
toets("2a Hornbach krijgt de eenvoudige User-Agent (geen 'Mozilla')", ua == wl.UA_EENVOUDIG and "Mozilla" not in ua, ua)
met_pagina("<html><head><title>Client Challenge</title></head><body>JavaScript is disabled</body></html>")
r = wl.lees("https://www.hornbach.nl/p/proefrek/123/")
toets("2b Hornbach 'Client Challenge' = bot-controle, geen lege uitslag", r["blokkade"] and "bot-controle" in r["blokkade"], r)
HB = ('<html><script type="application/ld+json">{"@type":"Product","name":"Proefrek 180x90","offers":{"@type":"Offer","price":"29.90","priceCurrency":"EUR",'
      '"availability":"https://schema.org/InStock"}}</script><body>prijs 29,90 € * Alle prijzen zijn incl. BTW en excl. verzendkosten.'
      '<script>{"canBeAddedToCart":true,"canBeAddedToCartText":"Online bestellen","deliveryTimeText":"Op werkdagen voor 16.00 uur besteld, morgen in huis"}'
      '{"availabilityText":"7 Stuks op voorraad in jouw vestiging","deliveryTimeText":"Plan zelf je afhaalmoment"}</script></body></html>')
met_pagina(HB)
r = wl.lees("https://www.hornbach.nl/p/proefrek/123/")
toets("2c Hornbach: prijs, online levertijd (niet de afhaaltekst), vestigingsvoorraad als opmerking, verzending blijft null",
      r["prijs_eur"] == 29.9 and r["levertijd"] == "Op werkdagen voor 16.00 uur besteld, morgen in huis" and r["verzending_eur"] is None
      and any("7 Stuks op voorraad" in x for x in r["opmerkingen"]) and "excl. verzendkosten" in (r["verzending_tekst"] or ""), r)
def praxis(aanbod):
    return ('<html><script type="application/ld+json">{"@type":"Product","name":"Proefrek Praxis","offers":{"@type":"Offer","price":"34.95","priceCurrency":"EUR",'
            '"availability":"https://schema.org/InStock"}}</script><script>window.__S={"product":{"offers":' + json.dumps(aanbod) + '}}</script></html>')
P1 = [{"deliveryCost": {"currencyIso": "EUR", "value": 4.95}, "deliveryModes": [{"code": "STD_x", "description": "Verwachte levering in 3 werkdagen", "method": "STD"}],
       "price": {"value": 34.95}, "seller": {"id": "1", "name": "Proefpartner BV"}, "stock": {"stockLevel": 12, "stockLevelStatus": "inStock"}}]
met_pagina(praxis(P1))
r = wl.lees("https://www.praxis.nl/proef/stellingkasten/proefrek/123")
toets("3a Praxis: verzending 4,95, verwachte levering, partnerverkoper en voorraad uit het ene aanbod",
      r["winkel"] == "praxis" and r["prijs_eur"] == 34.95 and r["verzending_eur"] == 4.95 and r["levertijd"] == "Verwachte levering in 3 werkdagen"
      and r["verkoper"] == "Proefpartner BV" and r["voorraad"] == "op voorraad (12 stuks)" and any("partner van Praxis" in x for x in r["opmerkingen"]), r)
met_pagina(praxis(P1).replace('</html>', '<script>{"offers":[{"deliveryCost":{"value":0}}]}</script></html>'))
r = wl.lees("https://www.praxis.nl/proef/stellingkasten/proefrek/123")
toets("3b Praxis met twee aanbiedingen op de pagina: geen verzending of levertijd gegokt", r["verzending_eur"] is None and r["levertijd"] is None, r)
met_pagina(praxis([dict(P1[0], deliveryCost={"value": "gratis"}, stock={"stockLevelStatus": "outOfStock"}, seller={"name": "Praxis"})]))
r = wl.lees("https://www.praxis.nl/proef/stellingkasten/proefrek/123")
toets("3c Praxis: verzendbedrag geen getal = null; uitverkocht; eigen verkoper zonder partneropmerking", r["verzending_eur"] is None and r["voorraad"] == "niet op voorraad"
      and r["verkoper"] == "Praxis" and not any("partner" in x for x in r["opmerkingen"]), r)
met_pagina(praxis([dict(P1[0], deliveryCost={"value": True})]))
r = wl.lees("https://www.praxis.nl/proef/stellingkasten/proefrek/123")
toets("3d Praxis: true als verzendbedrag telt niet", r["verzending_eur"] is None, r)

# ── 4. kopie in de vault-skill ──
skill = "/opt/data/AI_SecondBrain/.claude/skills/ovis-shopper/winkel_lezen.py"
if os.path.isfile(skill):
    toets("4a de skill-kopie is byte-gelijk aan winkel-lezen.py", open(skill, "rb").read() == open(sys.argv[1], "rb").read())
else:
    print("OVERGESLAGEN 4a (geen vault op deze machine)")
print("\n%d groen, %d rood" % (goed, fout))
sys.exit(1 if fout else 0)
PY
