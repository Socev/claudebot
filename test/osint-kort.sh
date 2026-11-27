#!/usr/bin/env bash
# wv4156 (besluitenpagina nr 194 = 2C94): OSINT "In het kort" (feiten + alle let-op bij elkaar, geen cijfer), het bewaarde antwoord bij een
# tik in het logboek (geen nieuwe zoekvraag, geen aanroep naar buiten) en een bestand uit Bestanden zonder upload (server.js osintBestandUitBron).
# Zonder netwerk (OSINT_NEP_NET=1); alles verzonnen. OSINT_PY=<ander osint.py> / SERVER_JS=<ander server.js> voor de kruisproef.
set -euo pipefail
cd "$(dirname "$0")/.."
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
printf 'contacten-zoek http://127.0.0.1:9/contacten\nagenda-wachter-api http://127.0.0.1:9/agenda\n' > "$T/webhooks.txt"
echo '{}' > "$T/nep.json"
export OSINT_DB="$T/db/osint.sqlite" OSINT_NEP_NET=1 OSINT_WEBHOOKS="$T/webhooks.txt" VAULT_DIR="$T/vault" OSINT_TOOLS="$T/tools" OSINT_NEP_ANTWOORD="$T/nep.json"
export API_SECRET=toets SUPABASE_RPC_CONTACTEN=toets N8N_WEBHOOK_AGENDA_API=toets PORT=9
mkdir -p "$T/vault" "$T/tools"
PY="${OSINT_PY:-$PWD/osint.py}"
F=0
python3 - "$PY" <<'PYEOF' || F=1
import datetime, importlib.util, json, sqlite3, sys, os
spec = importlib.util.spec_from_file_location('osint', sys.argv[1]); o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
fout = []
def eis(ok, wat):
    print(('ok   ' if ok else 'FOUT ') + wat)
    if not ok: fout.append(wat)
nu = datetime.date(2026, 11, 27)
kort = getattr(o, 'in_het_kort', None)
eis(callable(kort), 'in_het_kort bestaat')
if callable(kort):
    kaarten = [
        {'titel': 'Handelsregister', 'velden': [('KvK-nummer', '99999999'), ('Status', 'Active'), ('Opgericht (volgens Liza)', '01-01-2001')], 'let': 'Dit bedrijf heeft een non-mailing-indicator: geen ongevraagde post of verkoopbezoek.'},
        {'titel': 'Wat wij er zelf van weten (Facturen)', 'velden': [('Betaalt', '23 × incasso'), ('Eerste / laatste', '2019-03-01 / 2026-11-01'), ('Nieuw IBAN', 'ja, let op')]},
        {'titel': 'Website', 'velden': [('Domein', 'voorbeeld-leverancier.example')]},
        {'titel': 'Faillissementen', 'velden': [], 'let': 'Verzonnen: een bekendmaking noemt deze naam.'},
        {'titel': 'Dubbel', 'velden': [], 'let': 'Verzonnen: een bekendmaking noemt deze naam.'}]
    kern = {'naam': 'Voorbeeld Leverancier B.V.', 'rechtsvorm': 'Besloten vennootschap', 'kvk': '99999999', 'geregistreerd': '2012-06-01', 'facturen_aantal': 23}
    k = kort('bedrijf', kern, kaarten, nu)
    f = k['feiten']
    eis(f[0] == 'Voorbeeld Leverancier B.V., Besloten vennootschap', 'bedrijf: naam en rechtsvorm eerst  %r' % f[:1])
    eis('KvK 99999999' in f and 'status: Active' in f, 'bedrijf: KvK en status')
    eis('domein 14 jaar oud' in f, 'bedrijf: domein 14 jaar oud  %r' % f)
    eis(len(f) <= 5, 'bedrijf: hooguit vijf feiten')
    eis('23 betalingen in Facturen sinds 2019' in f and 'opgericht 01-01-2001' not in f, 'bedrijf: betalingen sinds 2019 gaan vóór de oprichting (max 5)  %r' % f)
    eis(k['let'][0].startswith('Dit bedrijf heeft een non-mailing') and k['let'].count('Verzonnen: een bekendmaking noemt deze naam.') == 1, 'let-op: alle kaartjes, ontdubbeld, in volgorde')
    eis(any('nieuw IBAN' in x for x in k['let']), 'let-op: nieuw IBAN uit Facturen')
    alles = json.dumps(k, ensure_ascii=False).lower()
    eis(not any(w in alles for w in ('score', 'stoplicht', 'betrouwbaar', 'geen faillissement', 'veilig')), 'geen cijfer, stoplicht of oordeel')
    k = kort('bedrijf', {'geregistreerd': '2026-11-06'}, [{'titel': 'Wat wij er zelf van weten (Facturen)', 'klein': 'Geen betalingen gevonden in Facturen.', 'velden': []}], nu)
    eis('domein 21 dagen oud' in k['feiten'] and 'nog nooit aan betaald (Facturen)' in k['feiten'], 'jong domein in dagen; nooit betaald  %r' % k['feiten'])
    k = kort('adres', {'adres': 'Proefstraat 1, 9999ZZ Nergensdorp', 'bouwjaar': 1931, 'adressen_in_pand': 4}, [], nu)
    eis(k['feiten'] == ['Proefstraat 1, 9999ZZ Nergensdorp', 'bouwjaar 1931', '4 adressen in het pand'], 'adres  %r' % k['feiten'])
    k = kort('telefoon', {'geldig': False, 'soort': 'mobiel', 'gebied': None}, [], nu)
    eis(k['feiten'] == ['mobiel', 'geen geldig nummer'], 'telefoon  %r' % k['feiten'])
    k = kort('kenteken', {}, [{'titel': 'Kenteken', 'velden': [('Kenteken', 'XX999X'), ('Merk', 'PROEFMERK'), ('Model', 'TOETS'), ('Kleur', 'GRIJS'), ('APK geldig tot', '01-01-2027')]}], nu)
    eis(k['feiten'] == ['PROEFMERK TOETS', 'kleur GRIJS', 'apk geldig tot 01-01-2027'], 'kenteken  %r' % k['feiten'])
    k = kort('mail', {'afzenderdomein': 'nergensdorp-betalen.example', 'spf': 'fail', 'dkim': 'none', 'dmarc': 'fail', 'signalen': 3}, [], nu)
    eis(k['feiten'] == ['afzenderdomein nergensdorp-betalen.example', 'SPF fail · DKIM none · DMARC fail', '3 signalen'], 'mail  %r' % k['feiten'])
    eis(kort('persoon', {}, [], nu) == {'feiten': [], 'let': []}, 'persoon zonder let-op: leeg blok')
# zoek() geeft kort mee; de zoekvraag onthoudt haar sleutel
r = o.zoek({'ingang': 'bedrijf', 'term': '99999999', 'wie': 'david', 'beelden': True})
eis(r.get('ok') and isinstance(r.get('kort'), dict) and 'feiten' in r['kort'] and 'let' in r['kort'], 'zoek() geeft kort mee')
c = sqlite3.connect(os.environ['OSINT_DB'])
cols = [x[1] for x in c.execute('pragma table_info(zoekvraag)')]
sl = c.execute('select sleutel from zoekvraag where id = ?', (r['id'],)).fetchone()[0] if 'sleutel' in cols else None
eis(bool(sl), 'zoekvraag bewaart de cachesleutel')
bew = getattr(o, 'bewaard', None)
eis(callable(bew), 'bewaard bestaat')
if callable(bew) and sl:
    # zoals een echte zoekvraag (NEP schrijft geen cache): het antwoord met een Google-kaartje erin
    u = {'kaarten': [{'titel': 'Handelsregister', 'bron': 'proef', 'opgehaald': 'x', 'velden': [['KvK-nummer', '99999999']], 'let': 'Verzonnen let-op.'},
                     {'titel': 'Google Street View', '_gsv': [5.1, 52.1]}], 'kern': {'naam': 'Voorbeeld Leverancier B.V.', 'kvk': '99999999'}, 'graaf': {'knopen': [], 'randen': []}}
    c.execute('insert into aanroep(zoek_id, tijd, bron, soort, host, naar_buiten, status, ms) values (?,?,?,?,?,?,?,?)', (r['id'], 'x', 'Proefbron', 'extern', 'proef.example', '99999999', '200', 5))
    c.execute('insert or replace into cache(sleutel, tijd, json) values (?,?,?)', (sl, o.nu_iso(), json.dumps(u))); c.commit()
    nz, na = c.execute('select count(*) from zoekvraag').fetchone()[0], c.execute('select count(*) from aanroep').fetchone()[0]
    b = bew(str(r['id']))
    eis(b.get('ok') and b.get('cache') and b.get('bewaard') and b['id'] == r['id'] and b['term'] == '99999999', 'bewaard: het antwoord van die zoekvraag')
    eis(c.execute('select count(*) from zoekvraag').fetchone()[0] == nz and c.execute('select count(*) from aanroep').fetchone()[0] == na, 'bewaard: geen nieuwe zoekvraag, geen aanroep')
    eis(not any(k.get('titel') == 'Google Street View' or '_gsv' in k for k in b['kaarten']), 'bewaard: Google-foto niet uit de cache en niet opnieuw opgehaald')
    nx = c.execute("select count(*) from aanroep where zoek_id = ? and soort = 'extern' and status != 'poort dicht'", (r['id'],)).fetchone()[0]
    eis(b['kort']['let'] == ['Verzonnen let-op.'] and b['extern'] == nx and 'Proefbron' in [x['bron'] for x in b['logboek']], 'bewaard: kort, extern en wat-ging-waarheen van die zoekvraag')
    c.execute('update zoekvraag set sleutel = null where id = ?', (r['id'],)); c.commit()
    eis(bew(str(r['id'])).get('ok'), 'bewaard: oudere zoekvraag zonder sleutel vindt het antwoord ook')
    c.execute('delete from cache'); c.commit()
    b = bew(str(r['id']))
    eis(not b.get('ok') and b.get('fout') == 'niet bewaard' and b.get('term') == '99999999' and b.get('ingang') == 'bedrijf', 'bewaard: verlopen = niet bewaard, met term en ingang')
    m = o.zoek({'ingang': 'mail', 'kop': 'From: a@proef.example\nSubject: proef\n', 'wie': 'david'})
    b = bew(str(m['id']))
    eis(not b.get('ok') and 'mailkop' in (b.get('reden') or ''), 'bewaard: mailkop = niet bewaard')
    eis(bew('987654').get('fout') == 'onbekende zoekvraag', 'bewaard: onbekende id')
print('osint-kort py: %d fout' % len(fout)); sys.exit(1 if fout else 0)
PYEOF
# server.js: bestand uit Bestanden (functie los geladen met verzonnen buren)
node - "${SERVER_JS:-$PWD/server.js}" "$T" <<'JSEOF' || F=1
const fs = require('fs'), path = require('path');
const [js, T] = process.argv.slice(2);
const bron = fs.readFileSync(js, 'utf8');
let fout = 0; const eis = (ok, w) => { console.log((ok ? 'ok   ' : 'FOUT ') + w); if (!ok) fout++; };
const a = bron.indexOf('const OSINT_BRON_MAX'), b = bron.indexOf('async function smalOsint');
eis(a > 0 && b > a, 'server.js kent osintBestandUitBron');
if (a > 0 && b > a) {
  const dir = path.join(T, 'ab'); fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'b', '1'), 'proefinhoud');
  fs.writeFileSync(path.join(dir, 'b', '2'), Buffer.alloc(10 * 1024 * 1024 + 1));
  fs.symlinkSync('/etc/hostname', path.join(dir, 'b', '3'));
  const META = { job_id: 'aaaaaaaaaaaaaaa1', bestanden: [{ n: 1, naam: 'proef.pdf' }, { n: 2, naam: 'groot.jpg' }, { n: 3, naam: 'link.txt' }] };
  const f = new Function('fs', 'APP_JOB_RE', 'appBewaardVan', 'appBestandPad', bron.slice(a, b) + '\nreturn osintBestandUitBron;')(
    fs, /^[a-f0-9]{16}$/, (j) => (j === META.job_id ? META : null), (m, x) => path.join(dir, 'b', String(x.n)));
  let r = f({ soort: 'bestand', job: META.job_id, n: 1 });
  eis(r.ok && r.inhoud.toString() === 'proefinhoud' && r.naam === 'proef.pdf', 'bestand uit Bestanden: inhoud en naam');
  eis(f({ soort: 'bestand', job: META.job_id, n: 2 }).status === 413, 'groter dan 10 MB: 413');
  eis(f({ soort: 'bestand', job: META.job_id, n: 3 }).status === 404, 'koppeling wordt niet gevolgd');
  eis(f({ soort: 'bestand', job: '../../etc', n: 1 }).status === 400 && f({ soort: 'bestand', job: META.job_id, n: '1' }).status === 400, 'vreemde job of n: 400');
  eis(f({ soort: 'bestand', job: 'bbbbbbbbbbbbbbb2', n: 1 }).status === 404 && f({ soort: 'bestand', job: META.job_id, n: 9 }).status === 404, 'onbekend bestand: 404');
  eis(f({ soort: 'mail', id: 'x' }).status === 400 && f(null).status === 400, 'andere bron: 400');
}
eis(/\^GET \\\/app\\\/osint\\\/bewaard\\\/\\d\{1,9\}\$/.test(bron), 'route GET /app/osint/bewaard/<id> staat in de verdeler');
console.log('osint-kort js: ' + fout + ' fout'); process.exit(fout ? 1 : 0);
JSEOF
[ "$F" = 0 ] && echo "osint-kort: groen" || { echo "osint-kort: ROOD"; exit 1; }
