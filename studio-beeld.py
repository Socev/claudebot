#!/usr/bin/env python3
# studio-beeld.py — beeldcontrole voor Studio, veldsoort 'beeld' (wv2482, fotoherstel fase 1, 7-11-2026).
# Ontwerp: vault 01_Ontwikkeling/Studio - fotoherstel op Olares (ontwerp 5-11-2026).md § 7 (grenzen invoer en uitvoer).
#
# studio.js roept dit aan met `python3 -I studio-beeld.py <stand> ...` (Pillow uit het image, python3-pil via ocrmypdf), één
# bestand per aanroep, met een tijdgrens. Uitvoer: precies één JSON-regel op stdout; exit 0 = gelukt, 2 = geweigerd (met reden).
# Er gaat nooit beeldinhoud of een bestandsnaam naar stdout of een log, alleen formaat en afmetingen.
#
#   neem <in> <uit-zonder-ext> <max_mp>   invoer: echte type uit de bytes (JPEG/PNG/WEBP), volledig decoderen, grens 50 MP;
#                                         groter dan max_mp: rechtop zetten (EXIF) en verkleinen tot max_mp (PNG, of JPEG 95 bij
#                                         een JPEG-bron) naar <uit>.<ext>; anders niets schrijven (het origineel blijft zoals het kwam)
#   uit <in> <uit.jpg> <max_mp> <max_bytes>  uitvoer van ComfyUI: decoderen, hooguit max_mp; groter dan max_bytes: JPEG 92 naar <uit.jpg>
#   pijp-neem <max_mp> | pijp-uit <max_mp> <max_bytes> | pijp-voor <soort> | pijp-toon <px>   (wv2984, OVIS Imagine)
#                                         zelfde standen zonder bestand: de bytes komen op stdin, het (nieuwe) beeld gaat naar fd 3,
#                                         JSON op stdout. Niets op schijf (incognito). pijp-toon = weergaveversie: rechtop, ≤ px, JPEG 85.
#                                         Schrijft pijp-neem/-uit niets naar fd 3, dan blijft het beeld zoals het kwam.
#   voor <in> <uit.png> <soort>           voorbewerking vóór ComfyUI (wv2679), soort uit een vaste lijst:
#                                         grijs-niveaus = rechtop (EXIF), grijs, niveaus 1 %–99 % gemeten in het binnenste zonder egale
#                                         scanrand en toegepast op het hele beeld (de rand wordt wit; de maten blijven gelijk)
import json
import os
import resource
import sys
import warnings

DECODE_MAX_MP = 50.0


def klaar(code, **kw):
    sys.stdout.write(json.dumps(kw) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def grenzen():
    # geheugen en rekentijd begrensd: een kwaadaardig of kapot bestand kan de pod niet volzetten
    try:
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024 ** 3, 2 * 1024 ** 3))
        resource.setrlimit(resource.RLIMIT_CPU, (90, 90))
    except Exception:
        pass


def open_beeld(pad):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = int(DECODE_MAX_MP * 1_000_000)
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    try:
        im = Image.open(pad, formats=["JPEG", "PNG", "WEBP"])
        formaat = im.format
        im.load()   # volledig decoderen: een afgekapt of kapot bestand faalt hier
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        klaar(2, ok=False, reden="foto groter dan %d megapixel" % DECODE_MAX_MP)
    except Exception:
        klaar(2, ok=False, reden="geen leesbare jpg, png of webp")
    if getattr(im, "n_frames", 1) > 1:
        klaar(2, ok=False, reden="bewegend beeld (meer dan één frame) kan niet")
    return im, formaat


def rand_doos(g):
    # egale lichte rand (scanrand, passe-partout): rijen/kolommen vanaf de buitenkant zolang ze licht (> 200) en vlak (< 60) zijn,
    # hooguit een kwart per kant
    w, h = g.size
    px = g.load()
    stap = max(1, min(w, h) // 400)

    def egaal(waarden):
        return sum(waarden) / len(waarden) > 200 and max(waarden) - min(waarden) < 60
    t, b, l, r = 0, h - 1, 0, w - 1
    while t < h // 4 and egaal([px[x, t] for x in range(0, w, stap)]):
        t += 1
    while b > 3 * h // 4 and egaal([px[x, b] for x in range(0, w, stap)]):
        b -= 1
    while l < w // 4 and egaal([px[l, y] for y in range(0, h, stap)]):
        l += 1
    while r > 3 * w // 4 and egaal([px[r, y] for y in range(0, h, stap)]):
        r -= 1
    return (l, t, r + 1, b + 1)


def grijs_niveaus(im):
    from PIL import ImageOps
    g = ImageOps.exif_transpose(im).convert("L")
    hist = g.crop(rand_doos(g)).histogram()
    n, acc, lo, hi = sum(hist), 0, None, None
    for v in range(256):
        acc += hist[v]
        if lo is None and acc > n * 0.01:
            lo = v
        if hi is None and acc >= n * 0.99:
            hi = v
    lo = 0 if lo is None else lo
    hi = 255 if hi is None else hi
    if hi <= lo:   # egaal (bv. een lege scan): niets uitrekken, anders wordt alles zwart (review wv2679 ZOU 1)
        return g.convert("RGB"), lo, hi
    lut = [max(0, min(255, round((v - lo) * 255 / (hi - lo)))) for v in range(256)]
    return g.point(lut).convert("RGB"), lo, hi


VOORBEWERKING = {"grijs-niveaus": grijs_niveaus}


PIJP_MAX = 30 * 1024 * 1024


def pijp(a):
    # wv2984: alles in het geheugen. Invoer = stdin (hooguit PIJP_MAX), uitvoer = fd 3; nooit een pad of bestand.
    import io
    from PIL import Image, ImageOps
    data = sys.stdin.buffer.read(PIJP_MAX + 1)
    if len(data) > PIJP_MAX:
        klaar(2, ok=False, reden="beeld te groot")
    uit = io.BytesIO()

    def lever(**kw):
        if uit.tell():
            with os.fdopen(3, "wb", closefd=True) as f:
                f.write(uit.getvalue())
        klaar(0, ok=True, **kw)
    im, formaat = open_beeld(io.BytesIO(data))
    b, h = im.size
    if a[0] == "pijp-neem" and len(a) == 2:
        max_mp = float(a[1])
        if b * h / 1e6 <= max_mp:
            lever(formaat=formaat, breed=b, hoog=h, verkleind=False)
        im = ImageOps.exif_transpose(im)
        f = (max_mp * 1e6 / (im.size[0] * im.size[1])) ** 0.5
        nb, nh = max(1, int(im.size[0] * f)), max(1, int(im.size[1] * f))
        while nb * nh > max_mp * 1e6:
            nb, nh = max(1, nb - 1), max(1, nh - 1)
        im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") and formaat != "JPEG" else "RGB").resize((nb, nh), Image.LANCZOS)
        if formaat == "JPEG":
            im.save(uit, "JPEG", quality=95)
            lever(formaat=formaat, breed=b, hoog=h, verkleind=True, nieuw_breed=nb, nieuw_hoog=nh, ext="jpg")
        im.save(uit, "PNG")
        lever(formaat=formaat, breed=b, hoog=h, verkleind=True, nieuw_breed=nb, nieuw_hoog=nh, ext="png")
    if a[0] == "pijp-uit" and len(a) == 3:
        if b * h > float(a[1]) * 1e6:
            klaar(2, ok=False, reden="resultaat groter dan %s megapixel" % a[1], breed=b, hoog=h)
        if len(data) <= int(a[2]):
            lever(formaat=formaat, breed=b, hoog=h, omgezet=False)
        im.convert("RGB").save(uit, "JPEG", quality=92)
        lever(formaat=formaat, breed=b, hoog=h, omgezet=True)
    if a[0] == "pijp-voor" and len(a) == 2:
        if a[1] not in VOORBEWERKING:
            klaar(2, ok=False, reden="onbekende voorbewerking")
        r, lo, hi = VOORBEWERKING[a[1]](im)
        r.save(uit, "PNG")
        lever(breed=r.size[0], hoog=r.size[1], niveau_laag=lo, niveau_hoog=hi)
    if a[0] == "pijp-toon" and len(a) == 2:
        px = max(64, min(4096, int(a[1])))
        im = ImageOps.exif_transpose(im)
        im.thumbnail((px, px), Image.LANCZOS)
        if im.mode in ("RGBA", "LA", "P"):
            achter = Image.new("RGB", im.size, (255, 255, 255))
            achter.paste(im.convert("RGBA"), mask=im.convert("RGBA").split()[3])
            im = achter
        im.convert("RGB").save(uit, "JPEG", quality=85)
        lever(formaat=formaat, breed=b, hoog=h, toon_breed=im.size[0], toon_hoog=im.size[1])
    klaar(2, ok=False, reden="onbekende aanroep")


def main(a):
    grenzen()
    if a and a[0].startswith("pijp-"):
        pijp(a)
    if len(a) == 4 and a[0] == "neem":
        from PIL import Image, ImageOps
        im, formaat = open_beeld(a[1])
        b, h = im.size
        mp = b * h / 1e6
        max_mp = float(a[3])
        if mp <= max_mp:
            klaar(0, ok=True, formaat=formaat, breed=b, hoog=h, verkleind=False)
        im = ImageOps.exif_transpose(im)
        f = (max_mp * 1e6 / (im.size[0] * im.size[1])) ** 0.5
        nb, nh = max(1, int(im.size[0] * f)), max(1, int(im.size[1] * f))
        while nb * nh > max_mp * 1e6:   # afronden mag de grens nooit overschrijden
            nb, nh = max(1, nb - 1), max(1, nh - 1)
        im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") and formaat != "JPEG" else "RGB").resize((nb, nh), Image.LANCZOS)
        if formaat == "JPEG":
            uit, ext = a[2] + ".jpg", "jpg"
            im.save(uit, "JPEG", quality=95)
        else:
            uit, ext = a[2] + ".png", "png"
            im.save(uit, "PNG")
        os.chmod(uit, 0o600)
        klaar(0, ok=True, formaat=formaat, breed=b, hoog=h, verkleind=True, nieuw_breed=nb, nieuw_hoog=nh, ext=ext)
    if len(a) == 5 and a[0] == "uit":
        im, formaat = open_beeld(a[1])
        b, h = im.size
        if b * h > float(a[3]) * 1e6:
            klaar(2, ok=False, reden="resultaat groter dan %s megapixel" % a[3], breed=b, hoog=h)
        if os.path.getsize(a[1]) <= int(a[4]):
            klaar(0, ok=True, formaat=formaat, breed=b, hoog=h, omgezet=False)
        im.convert("RGB").save(a[2], "JPEG", quality=92)
        os.chmod(a[2], 0o600)
        klaar(0, ok=True, formaat=formaat, breed=b, hoog=h, omgezet=True)
    if len(a) == 4 and a[0] == "voor":
        if a[3] not in VOORBEWERKING:
            klaar(2, ok=False, reden="onbekende voorbewerking")
        im, formaat = open_beeld(a[1])
        uit, lo, hi = VOORBEWERKING[a[3]](im)
        uit.save(a[2], "PNG")
        os.chmod(a[2], 0o600)
        klaar(0, ok=True, breed=uit.size[0], hoog=uit.size[1], niveau_laag=lo, niveau_hoog=hi)
    klaar(2, ok=False, reden="onbekende aanroep")


if __name__ == "__main__":
    main(sys.argv[1:])
