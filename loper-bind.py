#!/usr/bin/env python3
"""loper-bind.py — root-herstartlus voor de socev-loper (wv699, 21-10-2026; keten-categorie: zit in het image).

WAAROM ROOT. Fable-review wv689 #2: draait de loper zelf als socev (1002) en bindt hij zelf de socket, dan kan elk
Socev-gesprek (ook 1002) hem stoppen en zelf op de socket gaan luisteren, en dan praat server.js met een kaper. Daarom bindt
root de socket in een map van root: /run/socev-loper (0755) met loper.sock root:claude 0660. Alleen uid 1001 (groep claude)
kan verbinden; 1002 heeft geen groep (setpriv --clear-groups) en kan de socket niet vervangen.

WAT DIT PROCES DOET, EN NIETS ANDERS. Socket binden, dan in een lus de loper starten met de socket als fd 3:
  setpriv --reuid=1002 --regid=1002 --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs node /app/socev-loper.js
met een lege omgeving (env -i plus PATH, HOME, TZ, LANG, TMPDIR, PLAYWRIGHT_BROWSERS_PATH): de loper heeft nooit een
pod-sleutel gezien, want dit proces start vóór fetch-secrets. Stopt de loper (ook als een Socev-gesprek hem stopt), dan na
1 s opnieuw; in een snelle crashlus oplopend tot 4 s, zodat "loper kill -> binnen 5 s terug" blijft gelden. Dit proces
accepteert zelf nooit een verbinding, leest geen bestanden van 1001 of 1002 en schrijft alleen naar zijn eigen stdout
(het containerlog). Gestart door /app/socev-voorbereiding.sh met `env -i … python3 -I`.
"""
import grp
import os
import socket
import stat
import subprocess
import sys
import time

MAP = "/run/socev-loper"
SOCK = MAP + "/loper.sock"
THUIS = "/opt/data/socev-thuis"
LOPER = "/app/socev-loper.js"
NODE = "/usr/local/bin/node"
SETPRIV = "/usr/bin/setpriv"
UID = 1002
OMGEVING = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": THUIS,
    "TMPDIR": THUIS + "/tmp",
    "TZ": "Europe/Amsterdam",
    "LANG": "C.UTF-8",
    "PLAYWRIGHT_BROWSERS_PATH": "/opt/pw-browsers",
}


def log(t):
    sys.stdout.write(time.strftime("%Y-%m-%d %H:%M:%S") + " loper-bind: " + t + "\n")
    sys.stdout.flush()


def van_root(p):
    """Het programma dat we als 1002 starten moet van root zijn en niet door anderen te wijzigen."""
    st = os.stat(p)
    return st.st_uid == 0 and not (st.st_mode & 0o022)


def bind():
    os.umask(0o077)
    if os.path.islink(MAP) or (os.path.exists(MAP) and not os.path.isdir(MAP)):
        os.unlink(MAP)
    os.makedirs(MAP, exist_ok=True)
    st = os.lstat(MAP)
    if st.st_uid != 0:
        os.chown(MAP, 0, 0)
    os.chmod(MAP, 0o755)
    if os.path.lexists(SOCK):
        os.unlink(SOCK)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(SOCK)
    s.listen(64)
    os.chown(SOCK, 0, grp.getgrnam("claude").gr_gid)
    os.chmod(SOCK, 0o660)
    if s.fileno() != 3:
        os.dup2(s.fileno(), 3)
    os.set_inheritable(3, True)
    return s


def main():
    for p in (LOPER, NODE, SETPRIV):
        if not van_root(p):
            log("STOP: %s is niet van root of is door anderen te wijzigen; loper niet gestart" % p)
            while True:
                time.sleep(3600)
    try:
        houd = bind()  # noqa: F841 (de verwijzing houdt de socket open)
    except Exception as e:  # pod niet blokkeren: zonder loper draait alles als vandaag
        log("STOP: socket binden mislukt: %s" % e.__class__.__name__)
        while True:
            time.sleep(3600)
    log("socket %s gebonden (root:claude 0660)" % SOCK)
    cmd = [SETPRIV, "--reuid=%d" % UID, "--regid=%d" % UID, "--clear-groups", "--inh-caps=-all", "--bounding-set=-all",
           "--no-new-privs", "--", NODE, LOPER]
    wacht = 1.0
    while True:
        begin = time.time()
        try:
            cwd = THUIS if os.path.isdir(THUIS) else "/"
            p = subprocess.Popen(cmd, env=OMGEVING, cwd=cwd, pass_fds=(3,), stdin=subprocess.DEVNULL, close_fds=True)
            log("loper gestart (pid %d)" % p.pid)
            code = p.wait()
            log("loper gestopt (code %s, na %d s)" % (code, int(time.time() - begin)))
        except Exception as e:
            log("loper starten mislukt: %s" % e.__class__.__name__)
        wacht = 1.0 if time.time() - begin > 30 else min(4.0, wacht * 2)
        time.sleep(wacht)


if __name__ == "__main__":
    main()
