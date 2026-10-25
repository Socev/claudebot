#!/usr/bin/env python3
# syncthing-filter-toets.py — laat Syncthing hetzelfde weg als bisync? (wv1277, 25-10-2026; in het image)
#
# GEBRUIK  python3 -I syncthing-filter-toets.py --stignore F --bisync F [--rechten socev-rechten.sh] [--vault DIR]
#          [--syncthing BIN] [--json UIT]      exit 0 = groen; 1 = rood (per afwijking een regel op stderr); 2 = kon niet toetsen
#
# WAAROM. De vault gaat via bisync naar Drive en via Syncthing naar de Synology en Davids pc's. bisync-filter.txt (wv813) houdt
# scripts, Windows-code en config-mappen van Drive; syncthing-stignore.txt moet hetzelfde doen in een andere taal (globs, geen
# regex). Twee lijsten lopen uit elkaar zodra iemand er één aanpast. run.sh draait deze toets vóór Syncthing start en start
# Syncthing niet als hij rood is (fail-closed, zoals bisync-filter-toets.sh).
#
# HOE. Eén proefboom (namen uit bisync-filter-toets.sh, elke extensie en config-map uit bisync-filter.txt in drie schrijfwijzen,
# elke Windows-codesoort uit socev-rechten.sh, de ı/ſ-varianten, randgevallen) en met --vault ook een spiegel van de echte
# vaultnamen (lege bestanden). rclone lsf met bisync-filter.txt geeft wat bisync meeneemt; een wegwerp-Syncthing (eigen home,
# alleen 127.0.0.1, geen ontdekking, relais of statistiek) met de stignore geeft per bestand wat Syncthing indexeert.
# Elk verschil moet in een van twee benoemde soorten vallen, anders rood:
#   STRENGER  Syncthing laat het weg, bisync niet: plan § 4.3 (tijdelijk, workspace.json, NAS/OS-rommel), .sync-id, naam op
#             punt/spatie, een BESTAND dat zo heet als een config-map (.git als worktree-verwijzing), en de inhoud van een MAP
#             met niet-ASCII na een punt (Dossier.Ünal/; Syncthing kan een regel niet tot bestanden beperken).
#   ONSCHULDIG Syncthing neemt het mee, bisync niet: conflictkopieën van Syncthing zelf (*.sync-conflict-*, bisync houdt ze van
#             Drive), en een naam met niet-ASCII vóór een eerdere punt én in de laatste extensie, als die extensie met ı→i en
#             ſ→s geen code-extensie is (globs kunnen "na de laatste punt" niet uitdrukken; Windows vouwt alleen ı en ſ naar ASCII).
# Daarnaast een harde lijst die Syncthing nooit mag meenemen (los van rclone): elke code-extensie, elke ı/ſ-variant, ook achter
# een niet-ASCII-deel, elke config-map, quarantaine.
import argparse, json, os, re, shutil, socket, subprocess, sys, tempfile, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

ap = argparse.ArgumentParser()
ap.add_argument('--stignore', required=True)
ap.add_argument('--bisync', required=True)
ap.add_argument('--rechten')
ap.add_argument('--vault')
ap.add_argument('--syncthing', default=os.environ.get('SYNCTHING_BIN', '/opt/data/syncthing/bin/syncthing'))
ap.add_argument('--json')
a = ap.parse_args()


def stop(msg, code=2):
    print('syncthing-filter-toets: ' + msg, file=sys.stderr)
    sys.exit(code)


for f in (a.stignore, a.bisync):
    if not os.access(f, os.R_OK):
        stop('onleesbaar: ' + f)
if not os.access(a.syncthing, os.X_OK):
    stop('syncthing ontbreekt: ' + a.syncthing)
if not shutil.which('rclone'):
    stop('rclone ontbreekt')

bf = open(a.bisync, encoding='utf-8').read()
m = re.search(r'\(\?i\)\.\*\\\.\(([^)]*)\)\[\. \]\*\}\}', bf)
d = re.search(r'\{\{\(\?i\)\\\.\(([^)]*)\)\[\. \]\*\}\}/\*\*', bf)
if not m or not d:
    stop('kan de extensie- of mappenlijst in ' + a.bisync + ' niet vinden', 1)
EXTS = m.group(1).split('|')
DIRS = d.group(1).split('|')
FOLD = str.maketrans({'ı': 'i', 'ſ': 's'})


def varianten(e):
    pos = [i for i, c in enumerate(e) if c in 'is']
    uit = []
    for n in range(1, 2 ** len(pos)):
        l = list(e)
        for k, p in enumerate(pos):
            if n >> k & 1:
                l[p] = {'i': 'ı', 's': 'ſ'}[l[p]]
        uit.append(''.join(l))
    return uit


# ── proefboom ────────────────────────────────────────────────────────────────────────────────────────────────────────────
beide_mee = ["a.md", "map/b.docx", "map/c.pdf", "map/d.json", "map/e.zip", "map/f.html", "map/g.txt", "map/h.ts", "map/py.md",
             "map/ps1", ".claude/skills/x/SKILL.md", ".claude/skills/x/s.py", ".claude/settings.json", ".obsidian/app.json",
             ".obsidian/plugins/p/main.js", "map/Café ü.md", "Dossier.Ünal/Lustig (1801–1864).md", "map/notitie über.md",
             "20_Prive/Stamboom/Marritje Huijbertsdr. Lustig (1801–1864).md", "map/y.é.md", "map/12.10 – overleg.md",
             "map/.claude.json", "map/claude/x.md", "map/x.conflict1.md", "map/naam.met.punten.md"]
nooit = ["map/x.ps1", "map/X.PS1", "map/y.ps1.", "map/y2.ps1 ", "map/y3.Ps1. .", "map/z.py", "map/z.mjs", "map/z.js", "map/z.cjs",
         "map/z.sh", "map/z.bat", "map/Z.CMD", "map/z.vbs", "map/z.lnk", "map/z.url", "map/z.exe", "map/z.hta", "map/z.pyc",
         "map/z.pyw", "map/z.docm", "map/z.xlsm", "map/z.skill", "map/z.scf", "map/z.library-ms", "map/z.searchConnector-ms",
         "map/desktop.ini", "map/Desktop.INI", "map/__pycache__/m.cpython-311.pyc", "map/__pycache__/notitie.md",
         "map/.claude/settings.json", "map/.CLAUDE/settings.json", "map/.vscode/tasks.json", "map/.codex/config.toml",
         "map/.obsidian/plugins/p/main.js", "map/.mcp.json", "map/.MCP.json", "verzamel-claude.mjs",
         "00_Systeem/Tokens/tokens_pc.ps1", "map/evil.msı", "map/evil.pıf. ", "map/x.ınf", "map/.git/config",
         "map/.git/hooks/pre-commit", "map/.Cursor/mcp.json", "map/node_modules/p/index.md",
         "map/z.ps1.socev-geblokkeerd-20261022-1", "map/z.pyd", "map/z.wsb", "map/z.accdb", "map/z.iqy", "map/z.rdp",
         "map/z.xlsb", "map/.claude.socev-geblokkeerd-20261022-1/settings.json", "map/autorun.inf", "map/x.mdé", "map/x.ünf",
         "map/.claude. /s.json", "map/.git./config", "/.CLAUDE/settings.json", "map/a.ü.b.msı", "map/Café ü.py",
         "map/12.10 – overleg.PS1", "map/x.mdı"]
streng_voorbeelden = [".sync-id", ".obsidian/workspace.json", ".obsidian/workspace-mobile.json", ".obsidian/cache/x",
                      "map/x.tmp", "map/X.TEMP", "map/.~lock.brief.docx#", "map/~$brief.docx", "map/@eaDir/x.md",
                      "map/#recycle/x.md", "map/#snapshot/x.md", "map/.DS_Store", "map/Thumbs.db", "map/.venv/x.md",
                      ".claude/skills/x/__pycache__/m.pyc", ".claude/node_modules/p/i.md", "map/naam.", "map/naam ",
                      "map2/.git", ".claude/x.tmp", "Dossier.Ünal/brief.docx", "map/.box-12-0123456789ab.genoom.tmp",
                      "map/.a.md.0123456789abcdef.vv.tmp"]
onschuldig_voorbeelden = ["map/c.sync-conflict-20261025-142233-FYQS3IF.md", "map/a.ü.b.mdé"]
for e in EXTS:
    nooit += ["ext/w." + e, "ext/W." + e.upper(), "ext/w." + e + ".", "ext/w." + e + " .", "ext/ü.x." + e]
    for v in varianten(e):
        nooit += ["fold/w." + v, "fold/a.ü.b." + v, "fold/w." + v + "."]
for dd in DIRS:
    nooit += ["dir/." + dd + "/x.md", "dir/." + dd.upper() + "/x.md", "dir/." + dd + "./x.md", "dir/sub/." + dd + "/y.md"]
if a.rechten:
    r = open(a.rechten, encoding='utf-8').read()
    for ext in sorted(set(re.findall(r"-i?name '\*\.([A-Za-z0-9_-]+)'", r))):
        if ext not in ('ts', 'zip'):
            nooit += ["wincode/w." + ext]

STRENG_COMP = {'@eadir', '#recycle', '#snapshot', '.ds_store', 'thumbs.db', '.venv', '__pycache__', 'node_modules'}
DIRS_L = {'.' + x.lower() for x in DIRS} | {'.mcp.json'}
EXTS_L = {x.lower() for x in EXTS}


def strenger(p):
    if p in ('.sync-id', '.obsidian/workspace.json', '.obsidian/workspace-mobile.json') or p == '.obsidian/cache' \
            or p.startswith('.obsidian/cache/'):
        return True
    delen = p.split('/')
    for c in delen:
        cl = c.lower()
        if cl.endswith('.tmp') or cl.endswith('.temp') or c.startswith('.~lock.') or c.startswith('~$') or cl in STRENG_COMP:
            return True
        if c.endswith('.') or c.endswith(' '):
            return True
    if delen[-1].lower() in DIRS_L:   # een bestand (geen map) met de naam van een config-map
        return True
    # een MAP met niet-ASCII na een punt (Dossier.Ünal/): Syncthing kan een regel niet tot bestanden beperken, dus de map valt
    # weg (behalve wat regel C redt); bisyncs regel geldt alleen voor bestanden. In de vault van 25-10: geen zo'n map.
    for c in delen[:-1]:
        if re.search(r'\.[^/]*[^\x20-\x7e]', c):
            return True
    return False


def onschuldig(p):
    n = p.split('/')[-1]
    if '.sync-conflict-' in n:
        return True
    if '.' not in n:
        return False
    ext = n.rsplit('.', 1)[1]
    if not re.search(r'[^\x00-\x7f]', ext):
        return False
    if not re.search(r'[^\x20-\x7e][^/]*\.', n.rsplit('.', 1)[0] + '.'):
        return False
    return ext.translate(FOLD).lower().rstrip('. ') not in EXTS_L


T = tempfile.mkdtemp(prefix='stft-')
fout = []
uitkomst = {'ok': False}
proc = None
try:
    mappen = {}   # naam -> (boom, paden)
    proef = sorted({p.lstrip('/') for p in beide_mee + nooit + streng_voorbeelden + onschuldig_voorbeelden})
    mappen['proef'] = (os.path.join(T, 'proef'), proef)
    if a.vault:
        # Spiegel van de echte vaultnamen als eigen map (eigen wortel: /.claude, /.sync-id gelden zoals in de vault).
        spiegel, links = [], 0
        for root, dirs, files in os.walk(a.vault):
            rel = os.path.relpath(root, a.vault)
            for n in files + dirs:
                if os.path.islink(os.path.join(root, n)):
                    links += 1
                elif n in files:
                    spiegel.append(os.path.normpath(os.path.join(rel, n)))
            dirs[:] = [x for x in dirs if not os.path.islink(os.path.join(root, x))]
        uitkomst['vault_bestanden'] = len(spiegel)
        uitkomst['vault_symlinks'] = links
        mappen['vault'] = (os.path.join(T, 'vault'), sorted(spiegel))
    for naam, (boom, paden) in list(mappen.items()):
        for p in paden:
            full = os.path.join(boom, p)
            try:
                os.makedirs(os.path.dirname(full), exist_ok=True)
                if not os.path.exists(full):
                    open(full, 'w').close()
            except OSError:
                pass
        # een pad dat zowel bestand als map zou zijn, kan maar één keer bestaan: alleen echte bestanden vergelijken
        mappen[naam] = (boom, [p for p in paden if os.path.isfile(os.path.join(boom, p))])
        shutil.copyfile(a.stignore, os.path.join(boom, '.stignore'))
    # rclone: wat bisync meeneemt (.stignore van de proef zelf telt niet)
    env = dict(os.environ, RCLONE_CONFIG='/dev/null')
    R = {}
    for naam, (boom, _) in mappen.items():
        r = subprocess.run(['rclone', 'lsf', '-R', '--files-only', '--filter-from', a.bisync, '--exclude', '/.stignore', boom],
                           capture_output=True, text=True, env=env, timeout=300)
        if r.returncode != 0:
            stop('rclone lsf faalde: ' + r.stderr[-500:])
        R[naam] = set(r.stdout.splitlines())
    # syncthing: wegwerp-instantie
    home = os.path.join(T, 'home')
    g = subprocess.run([a.syncthing, 'generate', '--home=' + home, '--no-port-probing'], capture_output=True, text=True, timeout=60)
    if g.returncode != 0:
        stop('syncthing generate faalde: ' + (g.stderr or g.stdout)[-300:])
    s = socket.socket(); s.bind(('127.0.0.1', 0)); poort = s.getsockname()[1]; s.close()
    cfg = ET.parse(os.path.join(home, 'config.xml')); root = cfg.getroot()
    for f in root.findall('folder'):
        root.remove(f)
    o = root.find('options')
    for k, v in (('listenAddress', 'tcp://127.0.0.1:0'), ('globalAnnounceEnabled', 'false'), ('localAnnounceEnabled', 'false'),
                 ('relaysEnabled', 'false'), ('natEnabled', 'false'), ('urAccepted', '-1'), ('autoUpgradeIntervalH', '0'),
                 ('startBrowser', 'false'), ('crashReportingEnabled', 'false')):
        for e in o.findall(k):
            o.remove(e)
        ET.SubElement(o, k).text = v
    gui = root.find('gui'); gui.find('address').text = '127.0.0.1:%d' % poort
    key = gui.find('apikey').text
    for naam, (boom, _) in mappen.items():
        ET.SubElement(root, 'folder', {'id': naam, 'label': naam, 'path': boom, 'type': 'sendonly', 'rescanIntervalS': '3600',
                                       'fsWatcherEnabled': 'false', 'ignorePerms': 'true'})
    cfg.write(os.path.join(home, 'config.xml'))
    senv = dict(os.environ, STNOUPGRADE='1', STNORESTART='1', STNOBROWSER='1')
    proc = subprocess.Popen([a.syncthing, 'serve', '--home=' + home, '--no-browser', '--no-restart', '--no-upgrade'],
                            stdout=open(os.path.join(T, 'st.log'), 'w'), stderr=subprocess.STDOUT, env=senv)

    def get(pad):
        rq = urllib.request.Request('http://127.0.0.1:%d%s' % (poort, pad), headers={'X-API-Key': key})
        try:
            return json.load(urllib.request.urlopen(rq, timeout=10))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    for naam in mappen:
        klaar = False
        for _ in range(1200):
            try:
                st = get('/rest/db/status?folder=' + naam)
                if st and st.get('state') == 'idle' and st.get('localFiles', 0) + st.get('localDirectories', 0) > 0:
                    klaar = True
                    break
            except Exception:
                pass
            if proc.poll() is not None:
                stop('syncthing stopte: ' + open(os.path.join(T, 'st.log')).read()[-500:])
            time.sleep(0.25)
        if not klaar:
            stop('syncthing werd niet klaar met de scan van ' + naam)
        ig = get('/rest/db/ignores?folder=' + naam) or {}
        if ig.get('error'):
            stop('syncthing weigert de stignore: ' + str(ig.get('error'))[:300], 1)

    def mee(arg):
        naam, p = arg
        j = get('/rest/db/file?folder=' + naam + '&file=' + urllib.parse.quote(p))
        if not j or not j.get('local'):
            return p, False
        l = j['local']
        return p, not (l.get('ignored') or l.get('invalid') or l.get('deleted'))

    S = {}
    with ThreadPoolExecutor(8) as ex:
        for naam, (boom, paden) in mappen.items():
            S[naam] = {p for p, ok in ex.map(mee, [(naam, p) for p in paden]) if ok}
    # vergelijken (alleen bestanden; Syncthing kan ook bestanden in een genegeerde map indexeren, dat telt als mee)
    for naam in mappen:
        Rn, Sn = R[naam], S[naam]
        for p in sorted(Rn - Sn):
            if not strenger(p):
                fout.append(naam + ': bisync neemt het mee, Syncthing niet (geen benoemde soort): ' + repr(p))
        for p in sorted(Sn - Rn):
            if not onschuldig(p):
                fout.append(naam + ': Syncthing neemt het mee, bisync niet: ' + repr(p))
    Rp, Sp, boom = R['proef'], S['proef'], mappen['proef'][0]
    for p in sorted(Sp & {p.lstrip('/') for p in nooit}):
        fout.append('nooit mee, Syncthing neemt het mee: ' + repr(p))
    for p in beide_mee:
        if p not in Sp or p not in Rp:
            fout.append('hoort bij allebei mee te gaan: ' + repr(p) + (' (Syncthing mist)' if p not in Sp else '') +
                        (' (bisync mist)' if p not in Rp else ''))
    for p in streng_voorbeelden + onschuldig_voorbeelden:
        if os.path.isfile(os.path.join(boom, p)) and (p in Sp) != (p in onschuldig_voorbeelden):
            fout.append('voorbeeld van een benoemde soort gedraagt zich anders: ' + repr(p))
    uitkomst.update({'ok': not fout, 'proef': len(mappen['proef'][1]), 'bisync_mee': len(Rp), 'syncthing_mee': len(Sp),
                     'fouten': fout[:50]})
    if a.vault:
        vs, vo = sorted(R['vault'] - S['vault']), sorted(S['vault'] - R['vault'])
        uitkomst.update({'vault_bisync_mee': len(R['vault']), 'vault_syncthing_mee': len(S['vault']),
                         'vault_alleen_syncthing_weg': len(vs), 'vault_alleen_bisync_weg': len(vo),
                         'vault_voorbeelden_syncthing_weg': vs[:10], 'vault_voorbeelden_bisync_weg': vo[:10]})
finally:
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(10)
        except Exception:
            proc.kill()
    shutil.rmtree(T, ignore_errors=True)

if a.json:
    with open(a.json + '.nieuw', 'w') as f:
        json.dump(uitkomst, f, ensure_ascii=False)
    os.replace(a.json + '.nieuw', a.json)
for f in fout[:80]:
    print('syncthing-filter-toets: ' + f, file=sys.stderr)
if fout:
    print('syncthing-filter-toets: ROOD (%d afwijkingen)' % len(fout), file=sys.stderr)
    sys.exit(1)
print('syncthing-filter-toets: ok (%d in de proef, bisync %d mee, Syncthing %d mee%s)' % (
    uitkomst['proef'], uitkomst['bisync_mee'], uitkomst['syncthing_mee'],
    '; vault: %d bestanden, bisync %d mee, Syncthing %d mee, %d alleen door Syncthing weggelaten, %d alleen door bisync' % (
        uitkomst.get('vault_bestanden', 0), uitkomst.get('vault_bisync_mee', 0), uitkomst.get('vault_syncthing_mee', 0),
        uitkomst.get('vault_alleen_syncthing_weg', 0), uitkomst.get('vault_alleen_bisync_weg', 0))
    if a.vault else ''))
