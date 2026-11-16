#!/usr/bin/env python3
"""pgdg-vinger.py (wv3180) — toetst bij de imagebouw de OpenPGP-vingerafdruk (v4, SHA-1 over het publieke-sleutelpakket) van de
PGDG-aptsleutel. Gebruik: pgdg-vinger.py <sleutel.asc> <verwachte vingerafdruk>. Exit 0 alleen bij een treffer op de hoofdsleutel.
(Geen gnupg in het image; apt controleert de handtekeningen daarna zelf met deze sleutel via signed-by.)"""
import base64, hashlib, sys
regels = open(sys.argv[1]).read().splitlines()
b64, binnen = [], False
for r in regels:
    if r.startswith('-----BEGIN PGP PUBLIC KEY BLOCK'): binnen = True; continue
    if not binnen: continue
    if r.startswith('=') or r.startswith('-----END'): break
    if ':' in r or not r.strip(): continue
    b64.append(r.strip())
d = base64.b64decode(''.join(b64)); i = 0; hoofd = None
while i < len(d):
    t = d[i]
    if t & 0x40:
        soort = t & 0x3f; o = d[i + 1]
        if o < 192: ln, h = o, 2
        elif o < 224: ln, h = ((o - 192) << 8) + d[i + 2] + 192, 3
        else: ln, h = int.from_bytes(d[i + 2:i + 6], 'big'), 6
    else:
        soort = (t >> 2) & 0xf; h = {0: 2, 1: 3, 2: 5}[t & 3]; ln = int.from_bytes(d[i + 1:i + h], 'big')
    lijf = d[i + h:i + h + ln]
    if soort == 6 and hoofd is None:
        hoofd = hashlib.sha1(b'\x99' + len(lijf).to_bytes(2, 'big') + lijf).hexdigest().upper()
    i += h + ln
verwacht = sys.argv[2].replace(' ', '').upper()
print('PGDG-sleutel vingerafdruk:', hoofd)
sys.exit(0 if hoofd == verwacht else 1)
