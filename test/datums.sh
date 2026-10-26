#!/usr/bin/env bash
# Toetst datums.js (wv1275, POST /datums; SB2 fase 2 datumdetector) met een nep-detector in wegwerpreleases: realpath van huidig per
# aanroep (een omzetting halverwege mengt niets), kaal milieu voor het kind (geen sleutels), grenzen (413/400/503/504), exit 2 = 400,
# schaduwlog (map 0700, bestand 0600, geen tekst, geen (mogelijke) geboortedatum, gehashte message-id, nooit een symlink volgen,
# 30 dagen), en de koppeling in server.js + uitrol.sh. De echte detector toetst socev-scripts zelf (CI + scripts-uitrol).
# Gebruik: bash test/datums.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const D = require('./datums.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'datums-'));
function release(naam, cli) {
  const p = path.join(d, 'releases', naam, 'packages', 'datum', 'src', 'socev_datum');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, '__init__.py'), '');
  fs.writeFileSync(path.join(p, 'cli.py'), cli);
}
const NEP = (versie) => `import json, os, sys, time
def main(argv):
    d = json.loads(sys.stdin.read())
    if d["tekst"] == "SLAAP":
        time.sleep(3)
    if d["tekst"] == "FOUT2":
        print(json.dumps({"ok": False, "fout": "anker onleesbaar"})); return 2
    if d["tekst"] == "CRASH":
        raise SystemExit(1)
    t = [{"tekst": "4 juni 2014", "begin": 0, "eind": 11, "soort": "datum", "start": "2014-06-04", "eind_waarde": None, "precisie": "dag",
          "jaar": "expliciet", "relatief": False, "rol": "geboortedatum", "zekerheid": "hoog", "regel": "dag_maand@1+rol.geboren", "let_op": []},
         {"tekst": "27-10", "begin": 20, "eind": 25, "soort": "datum", "start": "2026-10-27", "eind_waarde": None, "precisie": "dag",
          "jaar": "dichtstbij", "relatief": False, "rol": "onbekend", "zekerheid": "redelijk", "regel": "num.d_m@1", "let_op": []}]
    print(json.dumps({"detector": "socev-datum", "versie": "${versie}", "anker": {"verzonden": d["anker"], "tz": "Europe/Amsterdam"},
                      "treffers": t, "samenvatting": {"aantal": 2}, "milieu": sorted(os.environ), "taal": d["taal"]}))
    return 0
`;
release('vA', NEP('1.0.0-a'));
release('vB', NEP('1.0.0-b'));
const huidig = path.join(d, 'huidig');
fs.symlinkSync('releases/vA', huidig);
const S = path.join(d, 'staat', 'datum-schaduw');
let klok = Date.parse('2026-10-26T12:00:00Z');
const fout = [];
const m = D.maak({ huidig: huidig, schaduwDir: S, nu: () => klok, fout: (w, e) => fout.push(w), timeoutMs: 1500, veegElkeMs: 0 });
process.env.API_SECRET = 'geheim-mag-niet-mee';
(async function () {
  let r = await m.verwerk({ tekst: 'Geboren 4 juni 2014; op 27-10 overleg.', anker: '2026-10-23T16:17:00+02:00' });
  toets('1 uitkomst met release en versie', r.status === 200 && r.j.ok === true && r.j.release === 'vA' && r.j.versie === '1.0.0-a' && r.j.treffers.length === 2, r);
  toets('1 kind krijgt een kaal milieu (geen API_SECRET, geen HOME)', r.j.milieu && !r.j.milieu.includes('API_SECRET') && !r.j.milieu.includes('HOME'), r.j.milieu);
  toets('1 taal standaard auto', r.j.taal === 'auto');
  fs.unlinkSync(huidig); fs.symlinkSync('releases/vB', huidig);
  r = await m.verwerk({ tekst: 'x' });
  toets('2 realpath per aanroep: na omzetten de nieuwe release', r.status === 200 && r.j.release === 'vB' && r.j.versie === '1.0.0-b', r.j);
  toets('3 te lange tekst = 413', (await m.verwerk({ tekst: 'a'.repeat(D.MAX_TEKST + 1) })).status === 413);
  toets('3 onbekende taal = 400', (await m.verwerk({ tekst: 'x', taal: 'de' })).status === 400);
  toets('3 geen object = 400', (await m.verwerk(null)).status === 400);
  r = await m.verwerk({ tekst: 'FOUT2' });
  toets('4 exit 2 van de detector = 400 met zijn melding', r.status === 400 && /anker/.test(r.j.fout), r);
  r = await m.verwerk({ tekst: 'CRASH' });
  toets('4 crash = 500, gelogd', r.status === 500 && fout.includes('datums-detector'), r);
  r = await m.verwerk({ tekst: 'SLAAP' });
  toets('5 te traag = 504', r.status === 504, r);
  const vijf = await Promise.all([1, 2, 3, 4, 5].map(() => m.verwerk({ tekst: 'SLAAP' })));
  toets('5 hooguit 4 tegelijk (de vijfde 503)', vijf.filter((x) => x.status === 503).length === 1 && vijf.filter((x) => x.status === 504).length === 4, vijf.map((x) => x.status));
  // 6. schaduw
  fs.mkdirSync(path.join(S, '..'), { recursive: true });
  fs.writeFileSync(path.join(d, 'oud.txt'), 'x');
  r = await m.verwerk({ tekst: 'Geboren 4 juni 2014; op 27-10 overleg.', anker: '2026-10-23T16:17:00+02:00',
    schaduw: { mail_id: '18a2b3c4d5e6f708', ai: { datum: '2026-10-27', starttijd: null, jaar_expliciet: false, parse_datum: '2025-10-27' } } });
  toets('6 schaduw: antwoord is alleen een telling', r.status === 200 && r.j.schaduw === true && r.j.aantal === 2 && !r.j.treffers, r.j);
  const log = path.join(S, '2026-10-26.jsonl');
  const regel = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  toets('6 map 0700, bestand 0600', (fs.statSync(S).mode & 0o777) === 0o700 && (fs.statSync(log).mode & 0o777) === 0o600);
  const ruw = fs.readFileSync(log, 'utf8');
  toets('6 geen tekst en geen ruwe message-id in het log', !/Geboren|overleg|18a2b3c4d5e6f708/.test(ruw) && /^[0-9a-f]{24}$/.test(regel.mail), regel);
  toets('6 geen (mogelijke) geboortedatum in het log', !/2014-06-04|geboortedatum/.test(ruw) && regel.geheim_weg === 1 && regel.treffers.length === 1, regel);
  toets('6 AI-datum en parse-datum ernaast', regel.ai.datum === '2026-10-27' && regel.ai.parse_datum === '2025-10-27' && regel.ai.geheim === false && regel.treffers[0].regel === 'num.d_m@1', regel);
  r = await m.verwerk({ tekst: 'Geboren 4 juni 2014.', anker: '2026-10-23T16:17:00+02:00', schaduw: { mail_id: 'g1', ai: { datum: '2014-06-04', parse_datum: '2014-06-04' } } });
  const r2 = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
  toets('6 AI-datum gelijk aan een geboortedatum: null + vlag, nergens in het log', r.status === 200 && r2.ai.datum === null && r2.ai.parse_datum === null && r2.ai.geheim === true && !/2014-06-04/.test(fs.readFileSync(log, 'utf8')), r2);
  // 7. symlink op de plek van het logbestand wordt niet gevolgd
  klok = Date.parse('2026-10-27T12:00:00Z');
  const doelBestand = path.join(d, 'doel.txt'); fs.writeFileSync(doelBestand, 'blijft');
  fs.symlinkSync(doelBestand, path.join(S, '2026-10-27.jsonl'));
  r = await m.verwerk({ tekst: 'x', schaduw: { mail_id: 'a' } });
  toets('7 symlink niet gevolgd: 500, doel ongemoeid', r.status === 500 && fs.readFileSync(doelBestand, 'utf8') === 'blijft', r);
  fs.unlinkSync(path.join(S, '2026-10-27.jsonl'));
  // 8. bewaartermijn 30 dagen (eens per dag)
  fs.writeFileSync(path.join(S, '2026-09-20.jsonl'), '{}\n');
  fs.writeFileSync(path.join(S, '2026-10-01.jsonl'), '{}\n');
  fs.writeFileSync(path.join(S, 'notitie.txt'), 'x');
  klok = Date.parse('2026-10-28T12:00:00Z');
  r = await m.verwerk({ tekst: 'x', schaduw: { mail_id: 'b' } });
  const namen = fs.readdirSync(S).sort();
  toets('8 ouder dan 30 dagen weg, de rest blijft', !namen.includes('2026-09-20.jsonl') && namen.includes('2026-10-01.jsonl') && namen.includes('notitie.txt') && namen.includes('2026-10-28.jsonl'), namen);
  // 8b. opruimen ook bij het laden (als er niets meer geschreven wordt)
  fs.writeFileSync(path.join(S, '2026-09-01.jsonl'), '{}\n');
  D.maak({ huidig: huidig, schaduwDir: S, nu: () => klok, veegElkeMs: 0 });
  toets('8 opruimen bij het laden', !fs.readdirSync(S).includes('2026-09-01.jsonl'));
  // 9. geen release
  const m2 = D.maak({ huidig: path.join(d, 'bestaat-niet'), schaduwDir: S, veegElkeMs: 0 });
  toets('9 geen release = 503', (await m2.verwerk({ tekst: 'x' })).status === 503);
  // 10. koppeling in server.js en uitrol.sh
  const srv = fs.readFileSync('server.js', 'utf8');
  const blok = srv.slice(srv.indexOf("reqPath(req) === '/datums'"), srv.indexOf("reqPath(req) === '/datums'") + 1200);
  toets('10 server.js: route met secret (timingSafeEqual), zonder rolPoort', blok.includes('timingSafeEqual') && !blok.includes('rolPoort') && srv.includes("require('./datums.js')"));
  toets('10 uitrol.sh: datums.js in RELEASE_OPTIONEEL', /RELEASE_OPTIONEEL="[^"]*\bdatums\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')));
  fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${goed} groen, ${fouten} rood`);
  process.exit(fouten ? 1 : 0);
})();
JS
