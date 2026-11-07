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


def main(a):
    grenzen()
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
    klaar(2, ok=False, reden="onbekende aanroep")


if __name__ == "__main__":
    main(sys.argv[1:])
