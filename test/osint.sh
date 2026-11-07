#!/usr/bin/env bash
# wv2694: OVIS OSINT — de centrale poort vóór elke externe aanroep (ontwerp § 5, review-MOET 1) en het logboek.
# Zonder netwerk: OSINT_NEP_NET=1 laat haal() elke aanroep alleen tellen. Een term met BSN-vorm of HIS-kenmerk → nul aanroepen;
# herkomst "mogelijk medisch" of zonder herkomst (Socev) → nul externe aanroepen (eigen bronnen mogen); persoon zonder doel of
# Socev zonder Davids vraag → niets; een schone term van David → wel externe aanroepen (anders bewijst de telling niets).
# OSINT_PY=<ander osint.py> voor de kruisproef (poort uit → deze toets moet rood worden).
set -euo pipefail
cd "$(dirname "$0")/.."
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
printf 'contacten-zoek http://127.0.0.1:9/contacten\nagenda-wachter-api http://127.0.0.1:9/agenda\n' > "$T/webhooks.txt"
export OSINT_DB="$T/db/osint.sqlite" OSINT_NEP_NET=1 OSINT_WEBHOOKS="$T/webhooks.txt" VAULT_DIR="$T/vault"
export API_SECRET=toets SUPABASE_RPC_CONTACTEN=toets N8N_WEBHOOK_AGENDA_API=toets PORT=9
mkdir -p "$T/vault/10_Zakelijk"
PY="${OSINT_PY:-$PWD/osint.py}"
python3 -I - "$PY" <<'EOF'
import json, os, sqlite3, subprocess, sys
py = sys.argv[1]
fout = []
def zoek(**v):
    r = subprocess.run([sys.executable, '-I', py, 'zoek'], input=json.dumps(v), capture_output=True, text=True, timeout=60)
    if r.returncode: fout.append('exit %d: %s' % (r.returncode, r.stderr[-300:])); return {}
    return json.loads(r.stdout)
def tel(r, soort):
    return sum(1 for l in r.get('logboek', []) if l['soort'] == soort and l['status'] != 'poort dicht')
def eis(ok, wat):
    print(('ok   ' if ok else 'FOUT ') + wat)
    if not ok: fout.append(wat)

# 1. vorm: BSN (verzonnen, haalt de elfproef) in elke ingang → niets, ook geen eigen bron
for ing in ('adres', 'bedrijf', 'telefoon', 'persoon'):
    r = zoek(ingang=ing, term='Kerkstraat 1 Leusden 111222333', wie='david', doel='anders')
    eis(r.get('poort', {}).get('niveau') == 'niets' and tel(r, 'extern') == 0 and tel(r, 'eigen') == 0, 'BSN-vorm via %s: nul aanroepen' % ing)
r = zoek(ingang='telefoon', term='111.222.333', wie='socev', herkomst='facturen')
eis(r.get('poort', {}).get('niveau') == 'niets' and tel(r, 'extern') + tel(r, 'eigen') == 0, 'BSN met punten (telefoon, Socev): nul aanroepen')
for t in ('patiëntnummer 4711 Dorpsstraat 2', 'HIS-nummer 4711', 'pat.nr 4711'):
    r = zoek(ingang='adres', term=t, wie='david')
    eis(r.get('poort', {}).get('niveau') == 'niets' and tel(r, 'extern') + tel(r, 'eigen') == 0, 'HIS-/patiëntkenmerk "%s": nul aanroepen' % t)
# 2. herkomst: mogelijk medisch / geen herkomst / mail → alleen eigen bronnen
for h in ('mogelijk-medisch', None, 'mail', 'intake'):
    r = zoek(ingang='bedrijf', term='Voorbeeld Leverancier', wie='socev', herkomst=h)
    eis(r.get('poort', {}).get('niveau') == 'eigen' and tel(r, 'extern') == 0 and tel(r, 'eigen') >= 1,
        'herkomst %s (Socev): nul externe, wel eigen bronnen' % h)
r = zoek(ingang='adres', term='Kerkstraat 1, 3831 AA Leusden', wie='socev', herkomst='mogelijk-medisch')
eis(tel(r, 'extern') == 0 and any(l['status'] == 'poort dicht' for l in r.get('logboek', [])), 'adres met herkomst mogelijk medisch: poort dicht gelogd, nul extern')
# 3. persoon
r = zoek(ingang='persoon', term='J. Voorbeeld', wie='david')
eis(r.get('poort', {}).get('niveau') == 'niets' and tel(r, 'extern') + tel(r, 'eigen') == 0, 'persoon zonder doel: niets')
r = zoek(ingang='persoon', term='J. Voorbeeld', wie='socev', herkomst='facturen', doel='waarnemer')
eis(r.get('poort', {}).get('niveau') == 'niets' and tel(r, 'extern') + tel(r, 'eigen') == 0, 'persoon door Socev zonder Davids vraag: niets')
r = zoek(ingang='persoon', term='J. Voorbeeld', wie='socev', herkomst='david-vraag', doel='waarnemer')
eis(r.get('poort', {}).get('niveau') == 'alles' and tel(r, 'extern') >= 1 and all(l['bron'].startswith('BIG') for l in r['logboek'] if l['soort'] == 'extern'),
    'persoon op Davids vraag met doel: alleen het BIG-register naar buiten')
# 4. groene controle: een schone term van David gaat wel naar buiten (anders bewijst nul niets)
r = zoek(ingang='adres', term='Kerkstraat 1, 3831 AA Leusden', wie='david')
eis(r.get('poort', {}).get('niveau') == 'alles' and tel(r, 'extern') >= 1, 'schoon adres van David: externe aanroep geteld')
r = zoek(ingang='bedrijf', term='Voorbeeld Leverancier', wie='socev', herkomst='facturen')
eis(r.get('poort', {}).get('niveau') == 'alles', 'herkomst facturen (Socev): poort open')
# 5. het logboek in osint.sqlite telt hetzelfde: geen externe aanroep bij de geweigerde vragen; rechten 0600/0700
db = os.environ['OSINT_DB']
c = sqlite3.connect(db)
n_ext = c.execute("select count(*) from aanroep a join zoekvraag z on z.id = a.zoek_id where z.poort != 'alles' and a.soort = 'extern' and a.status != 'poort dicht'").fetchone()[0]
eis(n_ext == 0, 'logboek: nul externe aanroepen bij poort niets/eigen (%d)' % n_ext)
eis(c.execute("select count(*) from zoekvraag").fetchone()[0] == 18, 'logboek: elke zoekvraag staat erin (wie, doel, ingang, term)')
eis(c.execute("select count(*) from zoekvraag where wie is null or ingang is null or term is null").fetchone()[0] == 0, 'logboek: velden gevuld')
eis(oct(os.stat(db).st_mode & 0o777) == '0o600' and oct(os.stat(os.path.dirname(db)).st_mode & 0o777) == '0o700', 'osint.sqlite 0600, map 0700')
lb = json.loads(subprocess.run([sys.executable, '-I', py, 'logboek', '5'], capture_output=True, text=True).stdout)
eis(lb.get('ok') and len(lb['zoekvragen']) == 5 and 'aanroepen' in lb['zoekvragen'][0], 'logboek-uitvoer')
inf = json.loads(subprocess.run([sys.executable, '-I', py, 'info'], capture_output=True, text=True).stdout)
eis(inf.get("zoekvragen") == 18 and 'term' not in json.dumps(inf), 'info zonder zoektermen')
# 6. elfproef en herkennen
sys.dont_write_bytecode = True; sys.path.insert(0, os.path.dirname(py)); import importlib; o = importlib.import_module('osint')
eis(o.elfproef('111222333') and not o.elfproef('123456789') and not o.elfproef('000000000'), 'elfproef')
eis([o.herken(x) for x in ('27124701', '033-4941210', '+31 6 12345678', 'kpn.com', 'Tolplaats 3, 3831 JR Leusden', 'KPN')] ==
    ['bedrijf', 'telefoon', 'telefoon', 'bedrijf', 'adres', 'bedrijf'], 'herkennen van de ingang')
eis(o.kvk_uit_incassant('NL39KPN271247010001') == '27124701', 'KvK uit incassant-ID')
eis(o.splits_naam('J.P. van der Berg') == ('J.P.', 'van der', 'Berg'), 'naam splitsen')
print('osint: %d fout' % len(fout)); sys.exit(1 if fout else 0)
EOF
