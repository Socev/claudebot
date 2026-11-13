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
#   pijp-pakket <max_mp> <ref_mp> | pijp-naad <x> <y> <b> <h> | pijp-snij <x> <y> <b> <h> <draai>   (wv3021, OVIS Imagine fase 2)
#                                         pakket: stdin = rijtje [4 bytes lengte][bytes]: beeld, masker (lengte 0 = geen), 0-2 voorbeelden.
#                                         Eén RGBA-PNG (alles naast elkaar, samen <= max_mp; voorbeelden <= ref_mp): het beeld links met in
#                                         alfa 255 - masker (masker = het getekende stuk, gegroeid en zacht gemaakt; 255 = alles blijft, zonder
#                                         masker 0 = alles mag veranderen), de voorbeelden rechts ervan. Eén upload onder de vaste naam: geen
#                                         nieuw schrijfpunt in ComfyUI (ook incognito). JSON: maten per deel.
#                                         naad: stdin = [pakket][resultaat]; buiten het masker (alfa 255) zet hij het beeld uit het pakket pixel
#                                         voor pixel terug en telt hoeveel pixels het resultaat daar anders had (PNG naar fd 3).
#                                         snij: bijsnijden (breuken 0-1 van het rechtop gezette beeld) en draaien (0/90/180/270 met de klok mee),
#                                         exact: PNG (boven 20 MB: JPEG 95, 'omgezet').
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


PIJP_MAX = 64 * 1024 * 1024   # wv3021: pakket en naad dragen twee beelden


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
    if a[0] in ("pijp-pakket", "pijp-naad"):
        im = formaat = None
        b = h = 0
    else:
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
    if a[0] == "pijp-pakket" and len(a) == 3:
        pakket(data, float(a[1]), float(a[2]), uit, lever)
    if a[0] == "pijp-naad" and len(a) == 5:
        naad(data, [int(x) for x in a[1:5]], uit, lever)
    if a[0] == "pijp-snij" and len(a) == 6:
        snij(im, formaat, [float(x) for x in a[1:5]], int(a[5]), uit, lever)
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


def frames(data, n_min, n_max):
    # [4 bytes lengte, big-endian][bytes] achter elkaar; precies tot het eind
    uit, i = [], 0
    while i < len(data):
        if i + 4 > len(data) or len(uit) >= n_max:
            klaar(2, ok=False, reden="pakket onleesbaar")
        n = int.from_bytes(data[i:i + 4], "big")
        if i + 4 + n > len(data):
            klaar(2, ok=False, reden="pakket onleesbaar")
        uit.append(data[i + 4:i + 4 + n])
        i += 4 + n
    if len(uit) < n_min:
        klaar(2, ok=False, reden="pakket onvolledig")
    return uit


def rechtop_rgb(buf):
    import io
    from PIL import ImageOps
    im, formaat = open_beeld(io.BytesIO(buf))
    return ImageOps.exif_transpose(im).convert("RGB"), formaat


def binnen(im, max_px):
    # verkleinen (LANCZOS) tot hooguit max_px pixels; kleiner blijft zoals het is
    from PIL import Image
    b, h = im.size
    if b * h <= max_px:
        return im
    f = (max_px / (b * h)) ** 0.5
    nb, nh = max(1, int(b * f)), max(1, int(h * f))
    while nb * nh > max_px:
        nb, nh = max(1, nb - 1), max(1, nh - 1)
    return im.resize((nb, nh), Image.LANCZOS)


def masker_zacht(m_bin, groei):
    # gegroeid (vervagen + drempel: ± groei px naar buiten) en zacht aan de binnenkant van de groeirand; buiten de groei precies 0
    from PIL import ImageChops, ImageFilter
    g = m_bin.filter(ImageFilter.GaussianBlur(groei / 2.0)).point(lambda v: 255 if v >= 8 else 0)
    z = ImageChops.multiply(g.filter(ImageFilter.GaussianBlur(groei / 2.0)), g)
    return ImageChops.lighter(z, m_bin), g


def pakket(data, max_mp, ref_mp, uit, lever):
    import io
    from PIL import Image, ImageChops
    f = frames(data, 2, 4)
    if not f[0]:
        klaar(2, ok=False, reden="geen beeld")
    hoofd, formaat = rechtop_rgb(f[0])
    refs = []
    for r in f[2:]:
        if not r:
            klaar(2, ok=False, reden="voorbeeld leeg")
        refs.append(binnen(rechtop_rgb(r)[0], ref_mp * 1e6))
    m = None
    if f[1]:
        mi, mf = open_beeld(io.BytesIO(f[1]))
        if mf != "PNG" or mi.size[0] > 4096 or mi.size[1] > 4096:
            klaar(2, ok=False, reden="masker onleesbaar")
        m = mi.convert("L")
    elif not refs:
        klaar(2, ok=False, reden="geen masker en geen voorbeeld")
    # alles naast elkaar en samen hooguit max_mp: eerst het beeld binnen wat de voorbeelden overlaten, dan samen krimpen tot het past
    rest = max(0.5, max_mp - sum(r.size[0] * r.size[1] for r in refs) / 1e6)
    hoofd = binnen(hoofd, rest * 1e6)
    for _ in range(60):
        B = hoofd.size[0] + sum(r.size[0] for r in refs)
        H = max([hoofd.size[1]] + [r.size[1] for r in refs])
        if B * H <= max_mp * 1e6:
            break
        hoofd = binnen(hoofd, int(hoofd.size[0] * hoofd.size[1] * 0.92))
        refs = [binnen(r, int(r.size[0] * r.size[1] * 0.92)) for r in refs]
    else:
        klaar(2, ok=False, reden="pakket past niet")
    b0, h0 = hoofd.size
    groei = max(4, int(round(0.008 * max(b0, h0))))
    if m is not None:
        m_bin = m.resize((b0, h0), Image.BILINEAR).point(lambda v: 255 if v >= 128 else 0)
        if not m_bin.getbbox():
            klaar(2, ok=False, reden="het masker is leeg: teken eerst over het stuk dat moet veranderen")
        zacht, gegroeid = masker_zacht(m_bin, groei)
        alfa = ImageChops.invert(zacht)
        gegroeid_px = sum(gegroeid.histogram()[255:])
    else:
        alfa = Image.new("L", (b0, h0), 0)
        gegroeid_px = b0 * h0
    doek = Image.new("RGBA", (B, H), (0, 0, 0, 255))
    hr = hoofd.convert("RGBA")
    hr.putalpha(alfa)
    doek.paste(hr, (0, 0))
    delen, x = [[0, 0, b0, h0]], b0
    for r in refs:
        doek.paste(r.convert("RGBA"), (x, 0))
        delen.append([x, 0, r.size[0], r.size[1]])
        x += r.size[0]
    doek.save(uit, "PNG")
    lever(breed=B, hoog=H, delen=delen, groei=groei, masker=m is not None, masker_px=gegroeid_px)


def naad(data, deel, uit, lever):
    import io
    from PIL import Image, ImageChops
    f = frames(data, 2, 2)
    pk, pf = open_beeld(io.BytesIO(f[0]))
    if pf != "PNG" or pk.mode != "RGBA":
        klaar(2, ok=False, reden="pakket onleesbaar")
    x, y, b, h = deel
    hoofd = pk.crop((x, y, x + b, y + h))
    res, _ = open_beeld(io.BytesIO(f[1]))
    res = res.convert("RGB")
    if res.size != (b, h):
        klaar(2, ok=False, reden="het resultaat heeft andere maten dan het beeld", breed=res.size[0], hoog=res.size[1])
    vast = hoofd.getchannel("A").point(lambda v: 255 if v == 255 else 0)   # buiten het (gegroeide) masker
    orig = hoofd.convert("RGB")
    r_, g_, b_ = ImageChops.difference(res, orig).split()   # review Codex ZOU 1: per kanaal, niet via grijs (dat rondt kleine verschillen weg)
    verschil = ImageChops.lighter(ImageChops.lighter(r_, g_), b_).point(lambda v: 255 if v else 0)
    verschil_px = sum(ImageChops.multiply(verschil, vast).histogram()[255:])
    buiten_px = sum(vast.histogram()[255:])
    Image.composite(orig, res, vast).save(uit, "PNG")
    lever(breed=b, hoog=h, verschil_px=verschil_px, buiten_px=buiten_px)


def snij(im, formaat, br, draai, uit, lever):
    from PIL import Image, ImageOps
    if draai not in (0, 90, 180, 270) or any(v != v for v in br):
        klaar(2, ok=False, reden="onbekende draaiing")
    x, y, w, h = br
    if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 and 0 < h <= 1 and x + w <= 1.000001 and y + h <= 1.000001):
        klaar(2, ok=False, reden="uitsnede valt buiten het beeld")
    im = ImageOps.exif_transpose(im)
    B, H = im.size
    l, t = int(round(x * B)), int(round(y * H))
    r, o = min(B, int(round((x + w) * B))), min(H, int(round((y + h) * H)))
    if r - l < 16 or o - t < 16:
        klaar(2, ok=False, reden="uitsnede kleiner dan 16 pixels")
    if im.mode not in ("RGB", "RGBA", "L", "LA"):
        im = im.convert("RGBA" if "A" in im.getbands() or im.mode == "P" else "RGB")
    im = im.crop((l, t, r, o))
    if draai:
        im = im.transpose({90: Image.ROTATE_270, 180: Image.ROTATE_180, 270: Image.ROTATE_90}[draai])
    im.save(uit, "PNG")
    if uit.tell() > 20 * 1024 * 1024:
        uit.seek(0)
        uit.truncate()
        im.convert("RGB").save(uit, "JPEG", quality=95)
        lever(breed=im.size[0], hoog=im.size[1], ext="jpg", omgezet=True)
    lever(breed=im.size[0], hoog=im.size[1], ext="png", omgezet=False)


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
