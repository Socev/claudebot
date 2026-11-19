#!/usr/bin/env python3
"""vaultzoek-index.py (wv3295, 19-11-2026) — nachtronde van zoeken op betekenis: vault → brokken → embeddings in de eigen Postgres.

WAAROM. Cloudflare AI Search las elke nacht elk gewijzigd bestand helemaal opnieuw in (± 300 M tokens/mnd, $225,83/mnd vanaf 1-12-2026,
0 zoekvragen in 2 weken). David JA 18-11 09:55 (548baeb0): naar onze eigen databank. Hier wordt alleen een brok ingebed dat nog nooit
eerder is ingebed (vector = inhoud-adresseerbaar op sha256(model + tekst)); een logboek dat er onderaan een alinea bij krijgt kost dus
één brok, geen heel bestand. Ontwerp: vault 01_Ontwikkeling/Zoeken op betekenis in eigen databank (ontwerp 19-11-2026).md.

WAT.
  1. gewijzigde bestanden (handtekening brokversie:mtime:grootte:ctime) byte voor byte naar een eigen momentopname (0700); de
     secretpoort scant die kopie (fail-closed zoals sync-naar-r2.sh) en alleen uit die kopie wordt geknipt. Sterk patroon of
     onleesbaar → hele bestand eruit; zwak patroon (jwt in een maillink, naam=waarde) → de brokken rond die regel (± 2 regels) en
     elk brok onder een kopregel met een treffer. Wat eruit gaat wordt nooit opgeslagen of verstuurd.
  2. .md/.txt ≤ 4 MB, met de uitsluitingen van vault-rag (filters.txt, o.a. de Promedico-weekpagina's) plus de grote logboeken (box, box-archief, n8n-wijzigingslog,
     00_Systeem/Tokens) en zolang de index in de databank postgres staat het mailarchief (--zonder-mail; zie db/vaultzoek.sql).
  3. Brokken van ± 1.000 tekens binnen een kopsectie (pad + kop erbij in de ingebedde tekst); alleen gewijzigde bestanden.
  4. Embeddings via Workers AI @cf/baai/bge-m3 (zelfde model en sleutel als de lessen), binnen een dagbudget in neurons per
     UTC-dag (standaard 8.000 van de 10.000 gratis; de rest blijft voor de lessen). Budget op = netjes stoppen; morgen verder.
     Volgorde: CLAUDE.md/AGENTS.md, 00_Systeem, skills, 01_Ontwikkeling, 10_Zakelijk, 20_Prive, rest, 30_Conversaties.
  5. Vectoren die door geen enkel brok meer gebruikt worden gaan weg; stand in /opt/data/scripts-staat/vaultzoek/stand.json.

GEBRUIK
  python3 -I vaultzoek-index.py ronde [--max-neurons 8000] [--max-min 40] [--met-mail] [--droog]
  python3 -I vaultzoek-index.py brokken <bestand>          # toon de brokken van één bestand (toets, schrijft niets)
Uitgang: 0 = ronde klaar (ook als het budget op was), 1 = fout (secretpoort kapot, databank weg, …), 2 = gebruik.
Nooit: sleutelwaarden in uitvoer of log; vault-inhoud in de uitvoer (alleen aantallen en paden).
"""
import fcntl
import shutil
import tempfile
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

VAULT = os.environ.get('VAULT_DIR', '/opt/data/AI_SecondBrain')
POORT = os.environ.get('VAULTZOEK_POORT', '/opt/data/socev-site/secretpoort.js')
STAAT = os.environ.get('VAULTZOEK_STAAT', '/opt/data/scripts-staat/vaultzoek')
PSQL = ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-h', os.environ.get('SB_SQL_SOCKET', '/run/pg'), '-U', 'postgres', '-d', 'postgres']
ACCOUNT = os.environ.get('CF_ACCOUNT_ID', '23df9b0607bb70f6d7f15a63ec843d6d')
MODEL = '@cf/baai/bge-m3'
BROKVERSIE = 'b3'           # ophogen als de knipregels veranderen: dan wordt alles opnieuw geknipt (vectoren blijven als de tekst gelijk is)
DOEL, MAX = 1000, 1600      # tekens per brok: streef / hard
MAX_BESTAND = 4 * 1024 * 1024
NEURONS_PER_TOKEN = 1075 / 1e6   # bge-m3, gemeten 19-11-2026 (meta.neurons / input_tokens)
TOKENS_PER_TEKEN = 0.6           # gemeten 0,47-0,50 voor Nederlands met opmaak; ruim genomen voor de schatting vooraf
STERK = {'sk-sleutel', 'github_pat', 'private-key', 'huisformaat-secret', 'bearer-token', 'aws-sleutel'}
MARGE = 2                   # regels rond een zwakke poorttreffer die ook weg moeten

UIT_MAP = {'.git', '.obsidian', 'node_modules', '.playwright-mcp', '__pycache__', '_INBOX', 'raw_input', '.trash', '.stversions'}
UIT_PAD = ('00_Systeem/Vault-RAG/', '00_Systeem/Beveiliging/', '00_Systeem/Tokens/', '00_Systeem/Meldingen/Archief/', '90_Cijfermeester/')
UIT_BESTAND = {'00_Systeem/Meldingen/machinekamer.md', '00_Systeem/n8n-wijzigingslog.md'}
# A03 (actieplan Fable-reviews 19-11-2026): Promedico-weekpagina's niet inbedden (Workers AI = Cloudflare); vrije HIS-tekst kan een kale
# achternaam bevatten. De botsingenpagina's ("… - botsingen.md") wel. Zelfde patroon staat in mk-scripts/vault-rag/filters.txt.
UIT_RE = re.compile(r'^10_Zakelijk/Tolgaarde/Promedico-agenda/Promedico-agenda \d{4}-W\d{2}\.md$')
# Rijen die al in de index staan blijven tot David over wissen besluit (actieplan C05): een uitgesloten pad zou anders als 'weg' gelden
# en de ronde zou het wissen. Na zijn Ja: BEWAAR_RE = None (dan ruimt de volgende ronde ze op).
BEWAAR_RE = UIT_RE
MAIL = '30_Conversaties/Mail/'


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, file=sys.stderr, flush=True)


# ── brokken ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
KOP = re.compile(r'^(#{1,6})\s+(.+?)\s*#*\s*$')
HEK = re.compile(r'^\s*(```|~~~)')


def brokken(tekst):
    """→ lijst van dicts {kop, tekst, van, tot} (regelnummers 1-based, inclusief). Knipt binnen een kopsectie op alinea's."""
    regels = tekst.split('\n')
    start = 0
    if regels and regels[0].strip() == '---':                       # frontmatter overslaan
        for i in range(1, min(len(regels), 200)):
            if regels[i].strip() in ('---', '...'):
                start = i + 1
                break
    uit, stapel = [], []
    alineas = []                       # [(van, tot, tekst)] van de huidige sectie
    blok, blok_van, in_hek = [], None, False

    def sluit_alinea(tot):
        nonlocal blok, blok_van
        if blok:
            t = '\n'.join(blok).strip()
            if t:
                alineas.append((blok_van, tot, t))
        blok, blok_van = [], None

    def sluit_sectie():
        kop = ' › '.join(k for _, k, _r in stapel[-2:])[:200]
        kopregels = [r for _, _k, r in stapel[-2:]]     # review wv3295 MOET 1: een poorttreffer in een kopregel telt voor elk brok onder die kop
        huidig, h_van, h_tot = [], None, None
        for van, tot, t in alineas:
            stukken = [t] if len(t) <= MAX else _knip_lang(t)
            for s in stukken:
                if huidig and sum(len(x) + 2 for x in huidig) + len(s) > DOEL:
                    uit.append({'kop': kop, 'kopregels': kopregels, 'tekst': '\n\n'.join(huidig), 'van': h_van, 'tot': h_tot})
                    huidig, h_van = [], None
                if h_van is None:
                    h_van = van
                huidig.append(s)
                h_tot = tot
        if huidig:
            uit.append({'kop': kop, 'kopregels': kopregels, 'tekst': '\n\n'.join(huidig), 'van': h_van, 'tot': h_tot})
        alineas.clear()

    for i in range(start, len(regels)):
        r = regels[i]
        nr = i + 1
        if HEK.match(r):
            in_hek = not in_hek
        m = None if in_hek else KOP.match(r)
        if m:
            sluit_alinea(nr - 1)
            sluit_sectie()
            niveau = len(m.group(1))
            while stapel and stapel[-1][0] >= niveau:
                stapel.pop()
            stapel.append((niveau, m.group(2).strip()[:120], nr))
            continue
        if not r.strip() and not in_hek:
            sluit_alinea(nr - 1)
            continue
        if blok_van is None:
            blok_van = nr
        blok.append(r)
    sluit_alinea(len(regels))
    sluit_sectie()
    return uit


def _knip_lang(t):
    """Eén alinea > MAX: eerst op regels, dan hard op DOEL tekens."""
    uit, huidig = [], ''
    for r in t.split('\n'):
        while len(r) > MAX:
            if huidig:
                uit.append(huidig)
                huidig = ''
            uit.append(r[:DOEL])
            r = r[DOEL:]
        if huidig and len(huidig) + len(r) + 1 > DOEL:
            uit.append(huidig)
            huidig = r
        else:
            huidig = (huidig + '\n' + r) if huidig else r
    if huidig.strip():
        uit.append(huidig)
    return [x for x in uit if x.strip()]


def embedtekst(pad, kop, tekst):
    naam = pad[:-3] if pad.endswith('.md') else pad
    return (naam + (' › ' + kop if kop else '') + '\n' + tekst)[:4000]


def brokhash(et):
    return hashlib.sha256((MODEL + '\n' + et).encode('utf-8')).hexdigest()


# ── secretpoort ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
def poort(map_):
    """Scant de momentopname map_ → {rel: {'sterk': bool, 'regels': set}}; SystemExit(1) bij een kapotte poort (fail-closed, zoals
    sync-naar-r2.sh). Regel 0 (ONLEESBAAR, DETECTIE-FOUT) telt als sterk: dan het hele bestand eruit."""
    try:
        p = subprocess.run(['node', POORT, '--negeer=.git', map_], capture_output=True, text=True, timeout=900)
    except Exception as e:
        log('FOUT: secretpoort start niet:', type(e).__name__)
        raise SystemExit(1)
    if p.returncode not in (0, 1) or (p.returncode == 0 and 'POORT-SCHOON' not in p.stdout):
        log('FOUT: secretpoort exit', p.returncode, '- geen ronde')
        raise SystemExit(1)
    rx = re.compile(r'^\s*(?P<pad>.+?):(?P<regel>\d+)\s+\[(?P<patroon>[^\]]+)\]\s*$')
    uit = {}
    for r in (p.stdout + '\n' + p.stderr).split('\n'):
        m = rx.match(r)
        if not m:
            continue
        pad = m.group('pad')
        if not pad.startswith(map_ + '/'):
            log('FOUT: secretpoort noemt een pad buiten de momentopname - geen ronde')
            raise SystemExit(1)
        rel = pad[len(map_) + 1:]
        d = uit.setdefault(rel, {'sterk': False, 'regels': set()})
        d['sterk'] = d['sterk'] or m.group('patroon') in STERK or m.group('regel') == '0'
        d['regels'].add(int(m.group('regel')))
    if p.returncode == 1 and not uit:
        log('FOUT: secretpoort meldt treffers maar ik kan er geen lezen - geen ronde')
        raise SystemExit(1)
    if len(uit) > 2000:
        log('FOUT: secretpoort wil', len(uit), 'bestanden uitsluiten - storing, geen bevinding; geen ronde')
        raise SystemExit(1)
    return uit


def weg_door_poort(b, regels):
    """Brok valt weg als een poorttreffer in zijn regels (± MARGE) of in een van zijn kopregels staat."""
    kr = set(b.get('kopregels') or [])
    return any(b['van'] - MARGE <= r <= b['tot'] + MARGE or r in kr for r in regels)


def momentopname(paden):
    """Kopieert de te verwerken bestanden byte voor byte naar een eigen map (0700). De poort scant die kopie en er wordt alleen uit
    die kopie geknipt: wat er na de poort in de vault verandert (ook `cp -p` met een oude tijd) komt deze ronde niet mee
    (review wv3295 MOET 2, ronde 1 en 2). → (map, {rel: bytes-lengte}); een onleesbaar bestand ontbreekt gewoon."""
    for oud in os.listdir(STAAT):
        if oud.startswith('kopie-'):
            shutil.rmtree(os.path.join(STAAT, oud), ignore_errors=True)
    map_ = tempfile.mkdtemp(prefix='kopie-', dir=STAAT)
    os.chmod(map_, 0o700)
    gelukt = {}
    for rel in paden:
        try:
            fd = os.open(os.path.join(VAULT, rel), os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as f:
                data = f.read(MAX_BESTAND + 1)
        except OSError:
            continue
        if len(data) > MAX_BESTAND:
            continue
        doel = os.path.join(map_, rel)
        os.makedirs(os.path.dirname(doel), exist_ok=True)
        with open(doel, 'xb') as f:
            f.write(data)
        gelukt[rel] = len(data)
    return map_, gelukt


# ── vault doorlopen ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def uitgesloten(rel, met_mail):
    if rel in UIT_BESTAND or rel.startswith(UIT_PAD) or UIT_RE.match(rel):
        return True
    if rel.startswith('.claude/') and not rel.startswith('.claude/skills/'):
        return True
    if not met_mail and rel.startswith(MAIL):
        return True
    return False


def weg_paden(db, schijf):
    """Paden in de index die niet meer op schijf (in scope) staan: die gaan eruit, behalve wat tot een besluit bewaard blijft."""
    return [p for p in db if p not in schijf and not (BEWAAR_RE and BEWAAR_RE.match(p))]


def rang(rel):
    if rel in ('CLAUDE.md', 'AGENTS.md', 'index.md'):
        return 0
    for i, p in enumerate(('00_Systeem/', '.claude/skills/', '01_Ontwikkeling/', '10_Zakelijk/', '20_Prive/'), 1):
        if rel.startswith(p):
            return i
    return 8 if rel.startswith('30_Conversaties/') else 6


def bestanden(met_mail):
    uit = {}
    for root, dirs, files in os.walk(VAULT):
        dirs[:] = [d for d in dirs if d not in UIT_MAP]
        for f in files:
            if not f.lower().endswith(('.md', '.txt')):
                continue
            p = os.path.join(root, f)
            rel = p[len(VAULT) + 1:]
            if uitgesloten(rel, met_mail) or os.path.islink(p):
                continue
            try:
                st = os.stat(p)
            except OSError:
                continue
            if st.st_size > MAX_BESTAND or st.st_size == 0:
                continue
            uit[rel] = (st.st_mtime_ns, st.st_size, st.st_ctime_ns)   # ctime: door niemand terug te zetten
    return uit


# ── databank ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def sql(tekst, timeout=600):
    p = subprocess.run(PSQL + ['-At', '-F', '\x1f'], input=tekst, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:   # review wv3295 ronde 3: nooit de ruwe foutuitvoer (COPY-fouten citeren de invoerrij), alleen de SQLSTATE
        m = re.search(r'ERROR:\s+([0-9A-Z]{5})', p.stderr)
        raise RuntimeError('psql exit %d, sqlstate %s' % (p.returncode, m.group(1) if m else '?'))
    return [r.split('\x1f') for r in p.stdout.split('\n') if r]


def cp(v):
    """Waarde voor COPY-tekstformaat."""
    if v is None:
        return '\\N'
    return str(v).replace('\x00', '').replace('\\', '\\\\').replace('\t', '\\t').replace('\n', '\\n').replace('\r', '\\r')


def schrijf_bestanden(rijen, brokrijen, weg):
    """rijen: [(pad, mtime_ns, grootte, n, sig)], brokrijen: [(pad, nr, kop, tekst, hash)], weg: [pad]. Eén transactie."""
    d = ['begin;',
         'create temp table tb (pad text, mtime_ns bigint, grootte bigint, brokken int, sig text) on commit drop;',
         'create temp table tw (pad text) on commit drop;',
         'copy tb from stdin;']
    d += ['\t'.join(cp(x) for x in r) for r in rijen] + ['\\.', 'copy tw from stdin;']
    d += [cp(p) for p in weg] + ['\\.',
          'delete from vaultzoek.bestand where pad in (select pad from tw);',
          'delete from vaultzoek.brok where pad in (select pad from tb);',
          'insert into vaultzoek.bestand (pad, mtime_ns, grootte, brokken, sig, gezien) select pad, mtime_ns, grootte, brokken, sig, now() from tb'
          ' on conflict (pad) do update set mtime_ns = excluded.mtime_ns, grootte = excluded.grootte, brokken = excluded.brokken,'
          ' sig = excluded.sig, gezien = now();',
          'copy vaultzoek.brok (pad, nr, kop, tekst, hash) from stdin;']
    d += ['\t'.join(cp(x) for x in r) for r in brokrijen] + ['\\.', 'commit;', '']
    sql('\n'.join(d))


def verbruik_vandaag():
    r = sql("select coalesce((select neurons from vaultzoek.verbruik where dag = (now() at time zone 'utc')::date), 0)")
    return float(r[0][0]) if r else 0.0


def schrijf_vectoren(rijen, neurons, tokens):
    d = ['begin;', 'create temp table tv (hash text, embedding text, tokens int) on commit drop;', 'copy tv from stdin;']
    d += ['\t'.join(cp(x) for x in r) for r in rijen] + ['\\.',
          "insert into vaultzoek.vector (hash, embedding, model, tokens) select hash, embedding::halfvec(1024), '%s', tokens from tv"
          " on conflict (hash) do nothing;" % MODEL,
          "insert into vaultzoek.verbruik (dag, neurons, tokens, brokken) values ((now() at time zone 'utc')::date, %s, %d, %d)"
          " on conflict (dag) do update set neurons = vaultzoek.verbruik.neurons + excluded.neurons,"
          " tokens = vaultzoek.verbruik.tokens + excluded.tokens, brokken = vaultzoek.verbruik.brokken + excluded.brokken;"
          % (repr(float(neurons)), int(tokens), len(rijen)),
          'commit;', '']
    sql('\n'.join(d))


# ── Workers AI ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
class BudgetOp(Exception):
    pass


def embed(teksten):
    tok = os.environ.get('CLOUDFLARE_API_TOKEN')
    if not tok:
        raise RuntimeError('CLOUDFLARE_API_TOKEN ontbreekt')
    req = urllib.request.Request(
        'https://api.cloudflare.com/client/v4/accounts/%s/ai/run/%s' % (ACCOUNT, MODEL),
        data=json.dumps({'text': teksten}).encode(),
        headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json', 'User-Agent': 'socev-vaultzoek/1'})
    for poging in range(3):
        try:
            j = json.load(urllib.request.urlopen(req, timeout=120))
            res = j.get('result') or {}
            data = res.get('data') or []
            if len(data) != len(teksten) or any(len(v) != 1024 for v in data):
                raise RuntimeError('Workers AI gaf %d vectoren voor %d teksten' % (len(data), len(teksten)))
            meta = res.get('meta') or {}
            neurons, tokens = float(meta.get('neurons') or 0), int(meta.get('cost_metric_value_1') or 0)
            if neurons <= 0 and tokens > 0:
                neurons = tokens * NEURONS_PER_TOKEN
            if neurons <= 0:   # review wv3295 ronde 3: zonder verbruiksgegevens geen budgetbewaking → stoppen, niet als 0 boeken
                raise BudgetOp('Workers AI gaf geen verbruiksgegevens; ronde gestopt')
            return data, neurons, tokens
        except urllib.error.HTTPError as e:
            body = e.read()[:400].decode('utf-8', 'replace')
            if '4006' in body or 'daily free allocation' in body.lower():
                raise BudgetOp('Workers AI: dagtegoed op (4006)')
            if e.code in (429, 500, 502, 503, 504) and poging < 2:
                time.sleep(10 * (poging + 1))
                continue
            raise RuntimeError('Workers AI HTTP %d' % e.code)
        except (urllib.error.URLError, TimeoutError) as e:
            if poging < 2:
                time.sleep(10 * (poging + 1))
                continue
            raise RuntimeError('Workers AI onbereikbaar: ' + type(e).__name__)


# ── ronde ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def ronde(max_neurons, max_min, met_mail, droog):
    t0 = time.time()
    eind = t0 + max_min * 60
    os.makedirs(STAAT, exist_ok=True)
    slot = open(os.path.join(STAAT, '.slot'), 'w')
    try:
        fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log('er loopt al een ronde')
        return 0
    stand = {'start': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'model': MODEL, 'met_mail': met_mail, 'droog': droog}

    schijf = bestanden(met_mail)
    db = {r[0]: r[1] for r in sql('select pad, coalesce(sig, \'\') from vaultzoek.bestand')}
    weg = weg_paden(db, schijf)
    nieuw = []
    for rel, (mt, gr, ct) in schijf.items():
        sig = '%s:%d:%d:%d' % (BROKVERSIE, mt, gr, ct)
        if db.get(rel) != sig:
            nieuw.append((rang(rel), rel, mt, sig))
    nieuw.sort()
    log('schijf', len(schijf), 'gewijzigd', len(nieuw), 'weg', len(weg))

    # 1. momentopname van de gewijzigde bestanden → secretpoort over precies die bytes → knippen → wegschrijven (pakketten van 300)
    kopie, gelezen = momentopname([x[1] for x in nieuw])
    try:
        treffers = poort(kopie) if gelezen else {}
        stand.update({'bestanden_schijf': len(schijf), 'bestanden_weg': len(weg), 'bestanden_gewijzigd': len(nieuw),
                      'bestanden_onleesbaar': len(nieuw) - len(gelezen),
                      'poort_sterk': sum(1 for t in treffers.values() if t['sterk']),
                      'poort_zwak': sum(1 for t in treffers.values() if not t['sterk'])})
        weggelaten = 0
        rijen, brokrijen = [], []
        for _, rel, mt, sig in nieuw:
            if rel not in gelezen:          # onleesbaar: geen rij, volgende nacht opnieuw
                continue
            t = treffers.get(rel)
            bb = []
            if not (t and t['sterk']):
                with open(os.path.join(kopie, rel), 'rb') as f:
                    inhoud = f.read().decode('utf-8', errors='replace')
                for b in brokken(inhoud):
                    if t and weg_door_poort(b, t['regels']):
                        weggelaten += 1
                        continue
                    bb.append(b)
            for n, b in enumerate(bb):
                brokrijen.append((rel, n, b['kop'], b['tekst'], brokhash(embedtekst(rel, b['kop'], b['tekst']))))
            rijen.append((rel, mt, gelezen[rel], len(bb), sig))
            if len(rijen) >= 300:
                if not droog:
                    schrijf_bestanden(rijen, brokrijen, weg)
                weg = []
                rijen, brokrijen = [], []
        if (rijen or weg) and not droog:
            schrijf_bestanden(rijen, brokrijen, weg)
        stand['brokken_weggelaten_poort'] = weggelaten
    finally:
        shutil.rmtree(kopie, ignore_errors=True)

    # 2. inbedden wat nog geen vector heeft, binnen het dagbudget
    ingebed, neurons_run, reden = 0, 0.0, 'klaar'
    if not droog:
        gebruikt = verbruik_vandaag()
        volgorde = ("case when b.pad in ('CLAUDE.md','AGENTS.md','index.md') then 0 when b.pad like '00\\_Systeem/%' then 1"
                    " when b.pad like '.claude/skills/%' then 2 when b.pad like '01\\_Ontwikkeling/%' then 3 when b.pad like '10\\_Zakelijk/%' then 4"
                    " when b.pad like '20\\_Prive/%' then 5 when b.pad like '30\\_Conversaties/%' then 8 else 6 end")
        while True:
            if time.time() > eind:
                reden = 'tijd op'
                break
            if gebruikt >= max_neurons:
                reden = 'dagbudget op'
                break
            rijen = sql("select row_to_json(x) from (select distinct on (b.hash) b.hash, b.pad, b.kop, b.tekst, %s as r"
                        " from vaultzoek.brok b where not exists (select 1 from vaultzoek.vector v where v.hash = b.hash)"
                        " order by b.hash, %s) x order by x.r, x.pad limit 1000" % (volgorde, volgorde))
            if not rijen:
                break
            stop = False
            for s in range(0, len(rijen), 50):
                pak = [json.loads(r[0]) for r in rijen[s:s + 50]]
                schat = sum(len(embedtekst(p['pad'], p['kop'], p['tekst'])) for p in pak) * TOKENS_PER_TEKEN * NEURONS_PER_TOKEN
                if gebruikt + schat > max_neurons:   # vooraf: dit pakket mag het dagbudget niet over laten gaan
                    reden, stop = 'dagbudget op', True
                    break
                try:
                    data, neur, tok = embed([embedtekst(p['pad'], p['kop'], p['tekst']) for p in pak])
                except BudgetOp as e:
                    reden, stop = str(e), True
                    break
                per = max(1, tok // max(1, len(pak)))
                vect = [(p['hash'], '[' + ','.join('%.6g' % x for x in v) + ']', per) for p, v in zip(pak, data)]
                schrijf_vectoren(vect, neur, tok)
                ingebed += len(pak)
                neurons_run += neur
                gebruikt += neur
                if gebruikt >= max_neurons or time.time() > eind:
                    break
            if stop:
                break
        # 3. vectoren zonder brok opruimen
        sql('delete from vaultzoek.vector v where not exists (select 1 from vaultzoek.brok b where b.hash = v.hash);')
        stand['neurons_vandaag_utc'] = round(gebruikt, 1)

    tel = sql('select (select count(*) from vaultzoek.bestand), (select count(*) from vaultzoek.brok),'
              ' (select count(*) from vaultzoek.vector),'
              ' (select count(distinct b.hash) from vaultzoek.brok b where not exists (select 1 from vaultzoek.vector v where v.hash = b.hash))')[0]
    stand.update({'ingebed': ingebed, 'neurons_ronde': round(neurons_run, 1), 'stop': reden,
                  'db_bestanden': int(tel[0]), 'db_brokken': int(tel[1]), 'db_vectoren': int(tel[2]), 'zonder_vector': int(tel[3]),
                  'duur_s': round(time.time() - t0), 'eind': time.strftime('%Y-%m-%dT%H:%M:%S%z')})
    if not droog:
        tmp = os.path.join(STAAT, '.stand.json.tmp')
        with open(tmp, 'w') as f:
            json.dump(stand, f, indent=1)
        os.replace(tmp, os.path.join(STAAT, 'stand.json'))
    print(json.dumps(stand))
    return 0


def main(argv):
    if len(argv) >= 2 and argv[0] == 'brokken':
        with open(argv[1], encoding='utf-8', errors='replace') as f:
            for b in brokken(f.read()):
                print('--- r%d-%d [%s] %d tekens' % (b['van'], b['tot'], b['kop'], len(b['tekst'])))
                print(b['tekst'][:300])
        return 0
    if not argv or argv[0] != 'ronde':
        print(__doc__.split('GEBRUIK')[1].split('Uitgang')[0].strip(), file=sys.stderr)
        return 2
    a = argv[1:]

    def opt(naam, std):
        return type(std)(a[a.index(naam) + 1]) if naam in a else std
    try:
        return ronde(opt('--max-neurons', 8000.0), opt('--max-min', 40.0), '--met-mail' in a, '--droog' in a)
    except SystemExit as e:
        return int(e.code or 1)
    except Exception as e:
        log('FOUT:', type(e).__name__, str(e)[:300])
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
