#!/usr/bin/env bash
# OVIS Shopper S4 (wv2273): shopper-proactief.py tegen een nep-Todoist en nep-pod (verzonnen taken). Toetst: koopwoord als heel woord,
# taken van anderen niet, al gezocht (todoist_id op een Shopper-pagina) niet, zoekterm zonder naam/entiteit (review MOET 1), poging in de
# staat vóór de zoekronde (MOET 2), plafond 2 per dag, 429 = wacht_plek + exit 3 en daarna alleen de agent (geen tweede zoekronde),
# schakelaar uit; plus het server.js-blok (dagronde, /health) en de uitrol-lijst (incl. Python-syntaxcontrole).
set -u
cd "$(dirname "$0")/.."
T="$(mktemp -d)"; trap 'kill $NEP 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/vault/10_Zakelijk/Groenhouten/Shopper" "$T/vault/00_Systeem"
printf -- '---\ntype: shopper-zoektocht\ntodoist_id: "AAAAAA1"\nstatus: open\n---\n' > "$T/vault/10_Zakelijk/Groenhouten/Shopper/Shopper - 2026-11-02 - x.md"
printf -- '---\ntype: shopper-favorieten\nwinkels:\n  - {domein: bol.com, naam: "bol", aan: true}\n  - {domein: tweakers.net, naam: "T", aan: true}\n  - {domein: amazon.de, naam: "A", aan: false}\n---\n' > "$T/vault/00_Systeem/Shopper - favoriete winkels.md"
cat > "$T/nep.py" <<'PY'
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
T = sys.argv[1]
TAKEN = [
  {'id': 'AAAAAA1', 'content': 'Twee stellingkasten voor Testpraktijk kopen', 'added_by_uid': '1', 'added_at': '2026-10-01'},
  {'id': 'BBBBBB2', 'content': 'Nieuwe rolgordijnen keuken Marloes bestellen', 'added_by_uid': '1', 'added_at': '2026-10-02'},
  {'id': 'CCCCCC3', 'content': 'Printerpapier kopen', 'added_by_uid': '2', 'added_at': '2026-10-03'},
  {'id': 'DDDDDD4', 'content': 'Koffiebekers kopen', 'added_by_uid': '1', 'responsible_uid': '2', 'added_at': '2026-10-04'},
  {'id': 'EEEEEE5', 'content': 'Verkoopfactuur maken', 'added_by_uid': '1', 'added_at': '2026-10-05'},
  {'id': 'FFFFFF6', 'content': 'Kaartjes kopen theater', 'added_by_uid': '1', 'added_at': '2026-10-06'},
  {'id': 'GGGGGG7', 'content': 'Verlengsnoer 5 meter voor Groenhouten bestellen', 'added_by_uid': '1', 'added_at': '2026-10-07'},
  {'id': 'HHHHHH8', 'content': 'Bureaulamp aanschaffen', 'added_by_uid': '1', 'added_at': '2026-10-08'},
]
def log(x):
    with open(os.path.join(T, 'log.jsonl'), 'a') as f: f.write(json.dumps(x) + '\n')
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def stuur(self, st, j):
        b = json.dumps(j).encode(); self.send_response(st); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.headers.get('Authorization') != 'Bearer nep-todoist': return self.stuur(401, {})
        if self.path.startswith('/todoist/tasks'): return self.stuur(200, {'results': TAKEN, 'next_cursor': None})
        if self.path == '/todoist/user': return self.stuur(200, {'id': '1'})
        self.stuur(404, {})
    def do_POST(self):
        d = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        if d.get('secret') != 'nep-geheim': return self.stuur(401, {'ok': False})
        if self.path == '/openai/zoek':
            try: st = json.load(open(os.path.join(T, 'staat.json')))
            except Exception: st = {}
            log({'zoek': d.get('vraag'), 'domeinen': d.get('domeinen'), 'staat_voor': [v.get('status') for v in st.get('pogingen', {}).values()]})
            return self.stuur(200, {'ok': True, 'usd': 0.02, 'kandidaten': [{'winkel': 'bol', 'product': 'p', 'url': 'https://www.bol.com/nl/nl/p/x/1/', 'gezien': True}]})
        if self.path == '/agent':
            modus = open(os.path.join(T, 'agentmodus')).read().strip() if os.path.exists(os.path.join(T, 'agentmodus')) else 'ok'
            log({'agent': d.get('label'), 'prompt_heeft_taak': 'BBBBBB2' in d.get('prompt', '') or 'GGGGGG7' in d.get('prompt', '') or 'HHHHHH8' in d.get('prompt', ''), 'modus': modus})
            if modus == 'vol': return self.stuur(429, {'ok': False})
            return self.stuur(200, {'ok': True, 'job_id': 'job1'})
        self.stuur(404, {})
HTTPServer(('127.0.0.1', int(sys.argv[2])), H).serve_forever()
PY
POORT=$((20000 + RANDOM % 20000))
python3 -I "$T/nep.py" "$T" "$POORT" & NEP=$!
for i in $(seq 1 50); do python3 -c "import socket;socket.create_connection(('127.0.0.1',$POORT),1)" 2>/dev/null && break; sleep 0.1; done
draai() { env -i PATH="$PATH" TODOIST_MCP_TOKEN=nep-todoist API_SECRET=nep-geheim SHOPPER_TODOIST_API="http://127.0.0.1:$POORT/todoist/" SHOPPER_POD="http://127.0.0.1:$POORT" \
  SHOPPER_VAULT="$T/vault" SHOPPER_STAAT="$T/staat.json" SHOPPER_GRONDWET=/dev/null SHOPPER_NU="$1" python3 -I shopper-proactief.py; }
f=0; ok=0
toets() { if [ "$2" = 1 ]; then echo "groen $1"; ok=$((ok+1)); else echo "ROOD  $1"; f=1; fi; }
j() { python3 -c "import json,sys; d=[json.loads(l) for l in open('$T/log.jsonl')] if __import__('os').path.exists('$T/log.jsonl') else []; print(1 if ($1) else 0)"; }

echo vol > "$T/agentmodus"
draai 2026-11-03T10:10:00+01:00 > "$T/uit1"; rc=$?
toets "1 exit 3 bij een volle agentplek" $([ $rc = 3 ] && echo 1 || echo 0)
toets "2 precies 2 zoektermen (plafond per dag), 2 rondes elk" "$(j "len([x for x in d if 'zoek' in x])==4")"
toets "3 zoektermen zonder naam of entiteit (MOET 1)" "$(j "all(x['zoek'] in ('Nieuwe rolgordijnen keuken','Verlengsnoer 5 meter') for x in d if 'zoek' in x) and not any(n in json.dumps(d) for n in ('Marloes','Groenhouten','Testpraktijk'))")"
toets "4 poging stond al in de staat vóór de zoekronde (MOET 2)" "$(j "all('gereserveerd' in x['staat_voor'] for x in d if 'zoek' in x)")"
toets "5 favorieten: alleen aan, zonder tweakers" "$(j "[x['domeinen'] for x in d if 'zoek' in x][0]==['bol.com'] and [x['domeinen'] for x in d if 'zoek' in x][1] is None")"
toets "6 al gezocht / ander / toegewezen / verkoop / kaartjes niet gezocht" "$(j "not any(w in json.dumps(d) for w in ('stellingkast','Printerpapier','Koffiebekers','factuur','Kaartjes'))")"
toets "7 staat: wacht_plek met kandidaten, kaartjes overgeslagen" "$(python3 -c "import json;s=json.load(open('$T/staat.json'))['pogingen'];v=list(s.values());print(1 if sum(bool(x['status']=='wacht_plek' and x.get('kandidaten')) for x in v)==2 and any(x['status']=='overgeslagen' for x in v) else 0)")"
rm -f "$T/agentmodus"; : > "$T/log.jsonl"
draai 2026-11-03T10:15:00+01:00 > "$T/uit2"; rc=$?
toets "8 tweede tik: exit 0, agents gestart zonder nieuwe zoekronde" "$(j "len([x for x in d if 'zoek' in x])==0 and len([x for x in d if 'agent' in x])==2 and all(x['prompt_heeft_taak'] for x in d if 'agent' in x)")"
toets "8b exit 0 na de tweede tik" $([ $rc = 0 ] && echo 1 || echo 0)
: > "$T/log.jsonl"
draai 2026-11-03T10:20:00+01:00 > /dev/null
toets "9 zelfde dag: niets nieuws (plafond)" "$(j "len(d)==0")"
draai 2026-11-04T10:10:00+01:00 > /dev/null
toets "10 volgende dag: de derde koopwens, de eerste twee niet opnieuw" "$(j "[x['zoek'] for x in d if 'zoek' in x]==['Bureaulamp','Bureaulamp']")"
python3 -c "import json;p='$T/staat.json';s=json.load(open(p));s['aan']=False;json.dump(s,open(p,'w'))"; : > "$T/log.jsonl"
draai 2026-11-05T10:10:00+01:00 > "$T/uit5"
toets "11 schakelaar uit: niets" "$(j "len(d)==0")"
toets "12 uitvoer zonder taaktekst" "$(grep -qE 'rolgordijnen|Marloes|Bureaulamp' "$T/uit1" "$T/uit2" "$T/uit5" && echo 0 || echo 1)"
env -i PATH="$PATH" python3 -I shopper-proactief.py > /dev/null; rc=$?
toets "13 zonder sleutels: exit 1" $([ $rc = 1 ] && echo 1 || echo 0)
toets "14 server.js: dagronde 10:05-11:05, eigen staat, niet in de nachtketen, /health.shopper_proactief" \
  $(node -e "const s=require('fs').readFileSync('server.js','utf8');const b=s.slice(s.indexOf('const shopperProactief ='),s.indexOf('function shopperProactiefTik'));process.stdout.write(/venster: \{ van: \[10, 5\], tot: \[11, 5\] \}/.test(b)&&/shopper-proactief\.py/.test(b)&&/shopper_proactief: typeof shopperProactiefInfo/.test(s)&&!/nachtketenActief\(\)\) return;\s*\/\/[^\n]*\n\s*try \{\s*const u = await shopperProactief/.test(s)?'1':'0')")
toets "15 uitrol-lijst: shopper-proactief.py optioneel, .py krijgt de Python-syntaxcontrole" \
  $(grep -qE '^RELEASE_OPTIONEEL="[^"]*\bshopper-proactief\.py\b' uitrol.sh && grep -q '(\*.py) python3 -I -c' uitrol.sh && echo 1 || echo 0)
echo "shopper-proactief: $ok groen"
exit $f
