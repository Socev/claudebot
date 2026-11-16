#!/usr/bin/env bash
# Toetst in het IMAGE (wv3167, CISO 16-11-2026) dat het gereedschap na de wissel van apt-ocrmypdf naar PyPI werkt:
# python3-pil (apt) is weg, Pillow komt uit /usr/local, ocrmypdf zet een tekstlaag op een verzonnen proef-PDF (nld),
# studio-beeld.py verkleint een beeld met Pillow, en bcftools/samtools/tabix (PGS-tool) starten.
# Gebruik (CI): docker run --rm -v "$PWD":/src:ro --user claude --entrypoint bash <image> /src/test/image-gereedschap.sh
set -u
SRC="$(cd "$(dirname "$0")/.." && pwd)"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
fout=0; goed=0
ok() { echo "GROEN $1"; goed=$((goed+1)); }
nee() { echo "ROOD  $1${2:+  [$2]}"; fout=$((fout+1)); }

if dpkg -s python3-pil >/dev/null 2>&1; then nee "python3-pil (apt) is weg" "nog geïnstalleerd"; else ok "python3-pil (apt) is weg"; fi
if dpkg -s ocrmypdf >/dev/null 2>&1; then nee "ocrmypdf (apt) is weg"; else ok "ocrmypdf (apt) is weg"; fi
PILPAD=$(python3 -I -c 'import PIL; print(PIL.__file__)' 2>&1)
case "$PILPAD" in /usr/local/lib/python3*/dist-packages/*) ok "Pillow uit /usr/local ($(python3 -I -c 'import PIL; print(PIL.__version__)'))";; *) nee "Pillow uit /usr/local" "$PILPAD";; esac

# Verzonnen proefbrief → PDF zonder tekstlaag → ocrmypdf -l nld → pdftotext moet de tekst terugvinden.
python3 -I - "$W/proef.pdf" <<'PY'
import sys
from PIL import Image, ImageDraw, ImageFont
im = Image.new('RGB', (1700, 600), 'white'); d = ImageDraw.Draw(im)
f = ImageFont.truetype('/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', 64)
d.text((80, 150), 'Proefbrief voor de herkenning', fill='black', font=f)
d.text((80, 300), 'Factuurnummer 2026-1167', fill='black', font=f)
im.save(sys.argv[1], resolution=200)
PY
[ -z "$(pdftotext "$W/proef.pdf" - 2>/dev/null | tr -d '[:space:]')" ] && ok "proef-PDF heeft nog geen tekstlaag" || nee "proef-PDF heeft nog geen tekstlaag"
if OCR=$(timeout 300 ocrmypdf -q -l nld "$W/proef.pdf" "$W/uit.pdf" 2>&1); then ok "ocrmypdf -l nld rc 0"; else nee "ocrmypdf -l nld rc 0" "$(tail -3 <<<"$OCR")"; fi
TEKST=$(pdftotext "$W/uit.pdf" - 2>/dev/null)
grep -q 'Factuurnummer' <<<"$TEKST" && grep -q '2026-1167' <<<"$TEKST" && ok "ocrmypdf: tekstlaag gelezen" || nee "ocrmypdf: tekstlaag gelezen" "$TEKST"

# studio-beeld.py (Pillow) zoals studio.js hem aanroept: `neem` verkleint een te groot beeld tot hooguit max_mp (1 MP).
python3 -I -c "from PIL import Image; Image.new('RGB', (3000, 2000), (9, 99, 199)).save('$W/groot.png')"
if UIT=$(python3 -I "$SRC/studio-beeld.py" neem "$W/groot.png" "$W/klein" 1 2>&1); then
  AFM=$(python3 -I -c "from PIL import Image; im = Image.open('$W/klein.png'); print(im.size[0] * im.size[1] <= 1000000)" 2>&1)
  [ "$AFM" = "True" ] && ok "studio-beeld.py neem (verkleind tot <= 1 MP)" || nee "studio-beeld.py neem" "$AFM $UIT"
else nee "studio-beeld.py neem" "$UIT"; fi

for c in bcftools samtools tabix; do
  if V=$("$c" --version 2>&1); then ok "$c: $(head -1 <<<"$V")"; else nee "$c --version" "$(head -3 <<<"$V")"; fi
done

echo "image-gereedschap: $goed groen, $fout rood"
[ "$fout" -eq 0 ]
