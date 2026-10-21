#!/usr/bin/env python3
"""argv-wacht — PreToolUse-hook (Bash) voor de machinekamer: geen pod-sleutel in een opdrachtregel (wv698, 21-10-2026).

WAAROM. /proc/<pid>/cmdline is voor elk proces in de pod leesbaar, ook na de uid-scheiding (bouwplan "Socev-gesprekken
onder eigen gebruiker - sleutelscheiding" § 3.6 en § 5 #6). `curl -H "X-N8N-API-KEY: $N8N_API_KEY"` zet de waarde in
argv van curl. Deze hook weigert zo'n Bash-opdracht vóór hij draait en wijst naar mk-curl (/opt/data/mk-scripts/mk-curl).
Hij is één van drie lagen: de hook (vooraf, poreus: `K=$T; curl … $K` met een niet-verdachte kop glipt erdoor), mk-curl
(de goede weg) en de argv-detector in server.js (meet achteraf wat er toch lekt).

WAAR HIJ GELDT. Sinds wv699 in het image als managed settings (/etc/claude-code/managed-settings.json, root, met
allowManagedHooksOnly; dit bestand /app/argv-wacht.py, root): geen sessie kan hem uitzetten, en hij geldt ook voor sessies
met een andere HOME (socev-thuis, fase 2). Vóór wv699 via /opt/data/.claude/settings.json (HOME). Bron: claudebot-src.
Actief alleen in een sessie met pod-sleutels in de eigen omgeving:
  - machinekamer (heeft N8N_API_KEY of API_SECRET): bewaakt elke sleutelnaam (KEY|TOKEN|SECRET|ROLE|SLEUTEL|WACHTWOORD|
    PASSWORD|SESSIE, waarde >= 16 tekens) uit de eigen omgeving;
  - smalle sessie met een beheersleutel (personeels-wachter, vault-concierge: SUPABASE_MCP_TOKEN = kluis): alleen die;
  - verder (hoofdkanaal, app, nachtsessies zonder beheersleutel): doet niets.

WAT HIJ WEIGERT (exit 2, uitleg op stderr = terug naar het model):
  B. een bewaakte $NAAM / ${NAAM…} / $(printenv NAAM) als argument van een extern programma (alles behalve shell-ingebouwden
     als echo, printf, export, test, read; ook binnen bash -c '…', eval en $(…));
  A. curl/wget/http(ie)/xh met een kop of optie die naar een sleutel ruikt (Authorization, Bearer, apikey, X-…-Key/Token,
     -u/--user, --oauth2-bearer) en een $-uitklapping, ook als die variabele geen bewaakte naam heeft.
Niet: NAAM=$X prog (omgeving, geen argv), heredoc/here-string naar stdin (`curl -K - <<EOF`), printf … | curl -K -.
Een interne fout laat de opdracht door (fail-open; de detector vangt het) en telt in /opt/data/bin/argv-wacht.log.
Toets: test/argv-hook-toets.py in claudebot-src (ook in CI; was mk-scripts/wv698/hook-toets.py).
"""
import json
import os
import re
import sys
import time

PATROON = re.compile(r"KEY|TOKEN|SECRET|ROLE|SLEUTEL|WACHTWOORD|PASSWORD|SESSIE")
NIET = {"SECRETS_GELADEN"}
VAST = {"API_SECRET", "N8N_API_KEY", "N8N_MCP_TOKEN", "SUPABASE_MCP_TOKEN", "SUPABASE_SERVICE_ROLE", "CLOUDFLARE_API_TOKEN",
        "TELEGRAM_SESSIE", "TELEGRAM_API_HASH", "CLAUDE_CODE_OAUTH_TOKEN", "AGENT_WEBHOOK_SECRET", "WERKKAMER_SLEUTEL_POD"}
MACHINEKAMER = {"N8N_API_KEY", "API_SECRET"}
BEHEER_SMAL = {"SUPABASE_MCP_TOKEN", "SUPABASE_SERVICE_ROLE", "N8N_MCP_TOKEN", "CLOUDFLARE_API_TOKEN"}
LOG = "/opt/data/bin/argv-wacht.log"
SCRIPTPAD = re.compile(r"\.(sh|bash|zsh|ksh)$")
SHEBANG = re.compile(r"#!\S*/(ba|z|k|da)?sh\b|#!/usr/bin/env (ba|z|k|da)?sh\b")

INGEBOUWD = {"echo", "printf", "export", "declare", "typeset", "local", "readonly", "read", "test", "[", "[[", ":", "true",
             "false", "set", "unset", "shift", "return", "exit", "cd", "pushd", "popd", "let", "wait", "trap", "type",
             "hash", "ulimit", "umask", "alias", "unalias", "break", "continue", "getopts", "mapfile", "readarray"}
SHELLS = {"bash", "sh", "dash", "zsh", "ksh"}
# Voorzetten die een ander programma starten; hun eigen opties (en de duur van timeout, het getal van nice -n) vallen weg
# vóór we kijken wie het echte programma is (Fable wv698 #1b). Hun argumenten blijven argv: een sleutel daarin is al B.
WRAPPERS = {"timeout", "nohup", "env", "nice", "stdbuf", "command", "exec", "time", "sudo", "setsid", "ionice", "chronic",
            "unbuffer", "flock", "caffeinate", "systemd-run", "runuser", "setpriv", "gosu", "xargs", "watch", "strace"}
MET_WAARDE = {("timeout", 0), ("nice", "-n"), ("ionice", "-c"), ("ionice", "-n"), ("flock", 0), ("watch", "-n"),
              ("timeout", "-s"), ("timeout", "-k"), ("sudo", "-u"), ("runuser", "-u"), ("xargs", "-I"), ("xargs", "-n")}
CURLACHTIG = {"curl", "wget", "http", "https", "httpie", "xh", "xhs", "curlie"}
SLEUTELACHTIG = re.compile(r"authoriz|bearer|api[-_]?key|apikey|x-[a-z0-9-]*(key|token|secret|auth)|private-token|cookie",
                           re.I)
SLEUTELOPTIES = {"-u", "--user", "--oauth2-bearer", "--proxy-user", "-U"}
SLEUTELWOORDEN = {"if", "then", "else", "elif", "fi", "do", "done", "while", "until", "case", "esac", "function", "!",
                  "time", "{", "}", "in", "select", "coproc"}


class Woord:
    __slots__ = ("tekst", "refs", "uitklap", "toewijzing")

    def __init__(self):
        self.tekst = ""          # tekst zonder quotes, uitklappingen als $NAAM
        self.refs = set()        # bewaakte namen die in dit woord uitklappen
        self.uitklap = False     # bevat een $-uitklapping of $(…) buiten enkele quotes
        self.toewijzing = False


class Lexer:
    """Kleine bash-lezer: genoeg voor woorden, quotes, $NAAM/${…}/$(…)/`…`, heredocs en scheidingstekens."""

    def __init__(self, s, bewaakt, diepte=0):
        # bewaakt: set van namen; tussenvariabelen (K=$TOKEN) zijn er al aan toegevoegd door besmet()
        self.s, self.i, self.bewaakt, self.diepte = s, 0, bewaakt, diepte
        self.heredocs = []       # (delim, strip_tabs, quoted, commando_index)
        self.binnen = []         # opdrachtteksten die apart geanalyseerd moeten worden ($(…), `…`, heredoc naar shell)

    def ref(self, w, naam):
        w.uitklap = True
        if naam in self.bewaakt:
            w.refs.add(naam)
        w.tekst += "$" + naam

    def lees_dollar(self, w, in_dq):
        s = self.s
        self.i += 1
        if self.i >= len(s):
            w.tekst += "$"
            return
        c = s[self.i]
        if c == "(":
            if s.startswith("((", self.i):            # $(( rekenen ))
                eind = s.find("))", self.i)
                eind = len(s) if eind < 0 else eind + 2
                w.tekst += s[self.i - 1:eind]
                self.i = eind
                return
            inhoud = self.lees_haakjes()
            w.uitklap = True
            self.subst(w, inhoud)
            return
        if c == "{":
            eind = s.find("}", self.i)
            eind = len(s) if eind < 0 else eind
            binnen = s[self.i + 1:eind]
            self.i = eind + 1
            if binnen.startswith("#"):                  # ${#NAAM} = lengte, geen waarde
                w.tekst += "${" + binnen + "}"
                return
            m = re.match(r"!?([A-Za-z_][A-Za-z0-9_]*)", binnen)
            if m:
                self.ref(w, m.group(1))
                rest = binnen[m.end():]
                for n in re.findall(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)", rest):   # ${X:-$Y}
                    self.ref(w, n)
            else:
                w.uitklap = True
            return
        if c == "'" and not in_dq:                       # $'…'
            eind = self.i + 1
            while eind < len(s) and s[eind] != "'":
                eind += 2 if s[eind] == "\\" else 1
            w.tekst += s[self.i + 1:eind]
            self.i = eind + 1
            return
        m = re.match(r"[A-Za-z_][A-Za-z0-9_]*", s[self.i:])
        if m:
            self.ref(w, m.group(0))
            self.i += m.end()
            return
        if c in "@*#?$!-0123456789":
            w.uitklap = True
            w.tekst += "$" + c
            self.i += 1
            return
        w.tekst += "$"

    def lees_haakjes(self):
        """Na '$(' of '(' : lees tot de bijbehorende ')' (quotes en nesting meegeteld)."""
        s = self.s
        self.i += 1
        start, diep = self.i, 1
        while self.i < len(s):
            c = s[self.i]
            if c == "\\":
                self.i += 2
                continue
            if c == "'":
                eind = s.find("'", self.i + 1)
                self.i = len(s) if eind < 0 else eind + 1
                continue
            if c == '"':
                self.i += 1
                while self.i < len(s) and s[self.i] != '"':
                    self.i += 2 if s[self.i] == "\\" else 1
                self.i += 1
                continue
            if c == "(":
                diep += 1
            elif c == ")":
                diep -= 1
                if diep == 0:
                    inhoud = s[start:self.i]
                    self.i += 1
                    return inhoud
            self.i += 1
        return s[start:]

    def subst(self, w, inhoud):
        """$(…) of `…`: binnenkant apart analyseren; onthult hij een bewaakte waarde, dan zit die in dit woord."""
        self.binnen.append(inhoud)
        for naam in onthult(inhoud, self.bewaakt, self.diepte + 1):
            w.refs.add(naam)
        w.tekst += "$(…)"

    def woorden(self):
        """Geeft een lijst tokens: Woord of een scheidingsteken (str)."""
        s, uit = self.s, []
        w = None
        n_cmd = 0

        def sluit():
            nonlocal w
            if w is not None:
                uit.append(w)
                w = None

        while self.i < len(s):
            c = s[self.i]
            if c in " \t":
                sluit()
                self.i += 1
                continue
            if c == "\\" and self.i + 1 < len(s) and s[self.i + 1] == "\n":
                self.i += 2
                continue
            if c == "\n":
                sluit()
                uit.append("\n")
                self.i += 1
                if self.heredocs:
                    self.sla_heredocs_over(uit)
                continue
            if c == "#" and w is None:
                eind = s.find("\n", self.i)
                self.i = len(s) if eind < 0 else eind
                continue
            if c in ";&|()":
                sluit()
                twee = s[self.i:self.i + 2]
                if twee in ("&&", "||", ";;", "|&"):
                    uit.append(twee)
                    self.i += 2
                elif c == "&" and s[self.i:self.i + 2] == "&>":
                    uit.append(Woord())                  # &>bestand: omleiding
                    uit[-1].tekst = "<redir>&>"
                    self.i += 2
                else:
                    uit.append(c)
                    self.i += 1
                continue
            if c in "<>":
                sluit()
                m = re.match(r"\d*(<<<|<<-|<<|>>|<&|>&|<>|>\||<|>)", s[self.i:])
                op = m.group(1)
                self.i += m.end()
                if op in ("<<", "<<-"):
                    m2 = re.match(r"[ \t]*(['\"]?)([A-Za-z0-9_.-]+)\1", s[self.i:])
                    if m2:
                        self.heredocs.append((m2.group(2), op == "<<-", bool(m2.group(1)), len(uit)))
                        self.i += m2.end()
                tok = Woord()
                tok.tekst = "<redir>" + op
                uit.append(tok)
                continue
            if w is None:
                w = Woord()
            if c == "'":
                eind = s.find("'", self.i + 1)
                eind = len(s) if eind < 0 else eind
                w.tekst += s[self.i + 1:eind]
                self.i = eind + 1
                continue
            if c == '"':
                self.i += 1
                while self.i < len(s) and s[self.i] != '"':
                    d = s[self.i]
                    if d == "\\" and self.i + 1 < len(s):
                        w.tekst += s[self.i + 1]
                        self.i += 2
                    elif d == "$":
                        self.lees_dollar(w, True)
                    elif d == "`":
                        eind = s.find("`", self.i + 1)
                        eind = len(s) if eind < 0 else eind
                        w.uitklap = True
                        self.subst(w, s[self.i + 1:eind])
                        self.i = eind + 1
                    else:
                        w.tekst += d
                        self.i += 1
                self.i += 1
                continue
            if c == "\\":
                w.tekst += s[self.i + 1:self.i + 2]
                self.i += 2
                continue
            if c == "$":
                self.lees_dollar(w, False)
                continue
            if c == "`":
                eind = s.find("`", self.i + 1)
                eind = len(s) if eind < 0 else eind
                w.uitklap = True
                self.subst(w, s[self.i + 1:eind])
                self.i = eind + 1
                continue
            w.tekst += c
            self.i += 1
        sluit()
        return uit

    def sla_heredocs_over(self, uit):
        s = self.s
        for delim, tabs, quoted, idx in self.heredocs:
            regels = []
            while self.i < len(s):
                eind = s.find("\n", self.i)
                eind = len(s) if eind < 0 else eind
                regel = s[self.i:eind]
                self.i = eind + 1
                if (regel.lstrip("\t") if tabs else regel) == delim:
                    break
                regels.append(regel)
            # Een heredoc naar een shell is een script: dat analyseren we wel (inhoud wordt in die shell uitgevoerd).
            body = "\n".join(regels)
            refs = set() if quoted else {n for n in re.findall(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)", body) if n in self.bewaakt}
            uit.append(("heredoc", idx, body, quoted, refs))
        self.heredocs = []


def simpele_opdrachten(tokens):
    """Splits tokens in simpele opdrachten (lijsten van Woord); heredocs worden aan hun opdracht gehangen."""
    cmds, huidig, heredocs = [], [], []
    for t in tokens:
        if isinstance(t, tuple):
            heredocs.append(t)
            continue
        if isinstance(t, str):
            if huidig:
                cmds.append(huidig)
            huidig = []
            continue
        huidig.append(t)
    if huidig:
        cmds.append(huidig)
    return cmds, heredocs


def pel_wrappers(naam, args):
    """timeout 20 curl …, nohup curl …, env X=1 curl … → (curl, args). Geeft (naam, args) van het echte programma."""
    for _ in range(6):
        prog = os.path.basename(naam.tekst)
        if prog not in WRAPPERS:
            break
        rest, i, posn = list(args), 0, 0
        while i < len(rest):
            t = rest[i].tekst
            if t == "--":
                i += 1
                break
            if t.startswith("-") and len(t) > 1:
                i += 2 if (prog, t) in MET_WAARDE else 1
                continue
            if prog == "env" and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t):
                i += 1
                continue
            if (prog, posn) in MET_WAARDE:
                posn += 1
                i += 1
                continue
            break
        if i >= len(rest):
            return None
        naam, args = rest[i], rest[i + 1:]
    return naam, args


def besmet(tekst, bewaakt):
    """Tussenvariabelen: K=$TOKEN, K="Bearer $TOKEN", K=$(printenv TOKEN), export K=… → K is ook bewaakt.
    Geeft (bewaakt, bron) met bron[K] = oorspronkelijke sleutelnaam (Fable wv698 #1a)."""
    b, bron = set(bewaakt), {}
    for _ in range(4):
        try:
            tokens = Lexer(tekst, b).woorden()
        except Exception:
            break
        cmds, _ = simpele_opdrachten(tokens)
        nieuw = False
        for cmd in cmds:
            woorden = [w for w in cmd if not w.tekst.startswith("<redir>")]
            kandidaten = []
            j = 0
            while j < len(woorden) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\+?=", woorden[j].tekst):
                kandidaten.append(woorden[j])
                j += 1
            if j < len(woorden) and woorden[j].tekst in ("export", "local", "declare", "typeset", "readonly"):
                kandidaten += [w for w in woorden[j + 1:] if "=" in w.tekst]
            for w in kandidaten:
                m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)", w.tekst)
                if m and w.refs and m.group(1) not in b:
                    b.add(m.group(1))
                    bron[m.group(1)] = sorted(bron.get(r, r) for r in w.refs)[0]
                    nieuw = True
        if not nieuw:
            break
    return b, bron


def opdracht_kern(cmd):
    """Haal omleidingen, sleutelwoorden en voorafgaande toewijzingen weg; geef (naam, args) of None."""
    woorden = []
    skip = False
    for w in cmd:
        if skip:
            skip = False
            continue
        if w.tekst.startswith("<redir>"):
            # het doelwoord van een omleiding (bestand of here-string) is geen argument; <<< gaat naar stdin
            skip = not w.tekst.startswith("<redir><<") or w.tekst == "<redir><<<"
            continue
        woorden.append(w)
    i = 0
    while i < len(woorden) and woorden[i].tekst in SLEUTELWOORDEN:
        i += 1
    if i < len(woorden) and woorden[i].tekst == "for":
        return None
    while i < len(woorden) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\+?=", woorden[i].tekst):
        i += 1
    if i >= len(woorden):
        return None
    return woorden[i], woorden[i + 1:]


def onthult(tekst, bewaakt, diepte):
    """Welke bewaakte waarden komen als UITVOER uit een $(…)-binnenkant (printenv NAAM, echo $NAAM, printf … $NAAM)."""
    if diepte > 4:
        return set()
    try:
        tokens = Lexer(tekst, bewaakt, diepte).woorden()
    except Exception:
        return set()
    cmds, _ = simpele_opdrachten(tokens)
    namen = set()
    for cmd in cmds:
        k = opdracht_kern(cmd)
        if not k:
            continue
        naam, args = k
        prog = os.path.basename(naam.tekst)
        if prog in ("printenv", "env"):
            for a in args:
                if a.tekst in bewaakt:
                    namen.add(a.tekst)
        if prog in ("echo", "printf", "printenv", "cat", "jq", "sed", "awk", "tr", "head", "cut", "base64", "xargs"):
            for a in args:
                namen |= a.refs
    return namen


def analyseer(tekst, bewaakt, diepte=0, bron=None):
    """Geeft een lijst bevindingen (naam, prog, soort)."""
    if diepte > 4:
        return []
    if bron is None:
        bewaakt, bron = besmet(tekst, bewaakt)
    lx = Lexer(tekst, bewaakt, diepte)
    tokens = lx.woorden()
    cmds, heredocs = simpele_opdrachten(tokens)
    bev = []
    for binnen in lx.binnen:                             # $(…) en `…` zijn ook opdrachten
        bev += analyseer(binnen, bewaakt, diepte + 1, bron)
    for cmd in cmds:
        k = opdracht_kern(cmd)
        if not k:
            continue
        naam, args = k
        prog = os.path.basename(naam.tekst)
        if naam.refs:
            bev.append((sorted(naam.refs)[0], "(opdrachtnaam)", "B"))
        if prog in WRAPPERS and prog not in INGEBOUWD:
            # argumenten van de voorzet zelf (env X=$T curl) staan in argv: eerst die, dan het echte programma
            for a in args:
                for r in sorted(a.refs):
                    bev.append((r, prog, "B"))
            gepeld = pel_wrappers(naam, args)
            if not gepeld:
                continue
            naam, args = gepeld
            prog = os.path.basename(naam.tekst)
            if naam.refs:
                bev.append((sorted(naam.refs)[0], "(opdrachtnaam)", "B"))
        if prog in SHELLS or prog == "eval":
            # bash -c '…' / eval '…': de tekst is zelf een opdracht
            if prog == "eval":
                bev += analyseer(" ".join(a.tekst for a in args), bewaakt, diepte + 1, bron)
            else:
                for j, a in enumerate(args):
                    if a.tekst == "-c" or (a.tekst.startswith("-") and "c" in a.tekst[1:] and not a.tekst.startswith("--")):
                        if j + 1 < len(args):
                            bev += analyseer(args[j + 1].tekst, bewaakt, diepte + 1, bron)
                        break
        if prog in INGEBOUWD and naam.tekst == prog:
            continue
        for a in args:
            for r in sorted(a.refs):
                bev.append((r, prog, "B"))
        if prog in CURLACHTIG:
            vorige = ""
            for a in args:
                if a.uitklap and (SLEUTELACHTIG.search(a.tekst) or vorige in SLEUTELOPTIES or
                                  re.match(r"^(--user|--oauth2-bearer|-u)=?", a.tekst) and "$" in a.tekst):
                    bev.append(("(kop met $)", prog, "A"))
                vorige = a.tekst
    for _, idx, inhoud, quoted, refs in heredocs:
        # heredoc naar een shell (bash <<EOF) is een script; naar een bestand (cat > x.sh, tee x) wordt hij er een
        # (Fable wv698 #1c). Anders gaat hij naar stdin (curl -K - <<EOF, python3 - <<EOF) en is hij geen argv.
        doel, doelen = heredoc_doel(tokens, idx)
        # een script is: naar een shell, of naar een .sh-bestand, of een tekst die met #!…sh begint. Een prompt of notitie
        # (.md, .txt) met een curl-voorbeeld is geen script en wordt niet geweigerd.
        script = doel in SHELLS or (doelen and (any(SCRIPTPAD.search(x) for x in doelen) or SHEBANG.match(inhoud)))
        if script:
            bev += [(n, "%s (in heredoc-script)" % p, s_) for n, p, s_ in analyseer(inhoud, bewaakt, diepte + 1, bron)]
        if doelen and refs:
            # ongequote heredoc: de WAARDE komt in het bestand (umask 022 = leesbaar voor elke gebruiker)
            bev.append((sorted(refs)[0], doel or "cat", "F"))
    return [(bron.get(n, n), p, s_) for n, p, s_ in bev]


def heredoc_doel(tokens, idx):
    """(programmanaam, schrijft-naar-bestand) van de opdracht waar de heredoc op token-index idx bij hoort."""
    j = idx - 1
    while j >= 0 and not isinstance(tokens[j], str):
        j -= 1
    k_ = idx
    while k_ < len(tokens) and not isinstance(tokens[k_], str):
        k_ += 1
    cmd = [t for t in tokens[j + 1:k_] if isinstance(t, Woord)]
    k = opdracht_kern(cmd) if cmd else None
    prog = os.path.basename(k[0].tekst) if k else None
    doelen = [cmd[i + 1].tekst for i, t in enumerate(cmd[:-1]) if t.tekst in ("<redir>>", "<redir>>>", "<redir>>|", "<redir>&>")]
    if prog == "tee" and k is not None:
        doelen += [a.tekst for a in k[1] if not a.tekst.startswith("-")]
    return prog, doelen


def bewaakte_namen(env):
    if any(env.get(n) for n in MACHINEKAMER):
        return {n for n, v in env.items() if n not in NIET and (n in VAST or PATROON.search(n)) and len(v) >= 16}
    return {n for n in BEHEER_SMAL if len(env.get(n, "")) >= 16}


def log(regel):
    try:
        if os.path.getsize(LOG) > 1024 * 1024:
            os.replace(LOG, LOG + ".1")
    except OSError:
        pass
    try:
        with open(LOG, "a") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + regel + "\n")
    except OSError:
        pass


def melding(bev):
    naam, prog, soort = bev[0]
    kop = ("argv-wacht (wv698): geweigerd — %s. Een opdrachtregel is via /proc/<pid>/cmdline leesbaar voor elk proces in de "
           "pod, ook voor de afgeschermde Socev-gebruiker. ")
    if soort == "F":
        return (kop % ("een ongequote heredoc schrijft de waarde van %s naar een bestand (`%s`); dat is erger dan argv" % (naam, prog)) +
                "Quote de heredoc (<<'EOF') zodat het script de sleutel zelf uit zijn omgeving leest, en zet hem in het script "
                "niet als curl-argument maar via mk-curl of curl -K -.")
    if soort == "A":
        return (kop % ("`%s` krijgt een kop of optie met een $-uitklapping die op een geheim lijkt" % prog) +
                "Komt het geheim uit de omgeving: /opt/data/mk-scripts/mk-curl --sleutel NAAM [--kop HEADER | --bearer] -- <curl-args>. "
                "Komt het van elders (bestand, git credential): geef de kop via stdin, bv. printf 'header = \"Authorization: Bearer %s\"\\n' "
                "\"$T\" | curl -K - <url>.")
    return (kop % ("%s komt als argument in de opdrachtregel van `%s`" % (naam, prog)) +
            "Gebruik mk-curl: /opt/data/mk-scripts/mk-curl --sleutel NAAM [--kop HEADER | --bearer | --veld JSONVELD "
            "[--json '{…}']] -- <curl-args> (mk-curl --help). Andere programma's: geef de sleutel via de omgeving "
            "(NAAM=\"$NAAM\" prog, of laat het script os.environ lezen), via stdin (printf '%s' \"$NAAM\" | prog, curl -K - <<EOF) "
            "of een pijp — nooit als argument.")




def script_tekst(d):
    """Write/Edit/MultiEdit van een shellscript (.sh e.d. of #!…sh): de nieuwe tekst, anders None (Fable wv698 #1c)."""
    ti = d.get("tool_input") or {}
    pad = str(ti.get("file_path") or "")
    stukken = [ti.get("content"), ti.get("new_string")] + [e.get("new_string") for e in (ti.get("edits") or []) if isinstance(e, dict)]
    stukken = [x for x in stukken if isinstance(x, str) and x]
    if not stukken:
        return None
    if SCRIPTPAD.search(pad) or SHEBANG.match(stukken[0]):
        return "\n".join(stukken)
    return None


def main():
    try:
        d = json.load(sys.stdin)
    except Exception:
        return 0
    tool = d.get("tool_name")
    if tool == "Bash":
        cmd = (d.get("tool_input") or {}).get("command") or ""
    elif tool in ("Write", "Edit", "MultiEdit"):
        cmd = script_tekst(d) or ""
    else:
        return 0
    bewaakt = bewaakte_namen(os.environ)
    if not bewaakt or not cmd:
        return 0
    try:
        bev = analyseer(cmd, bewaakt)
    except Exception as e:                               # fail-open: de detector in server.js vangt wat hier doorglipt
        log("interne fout %s: %s" % (type(e).__name__, str(e)[:120]))
        return 0
    if not bev:
        return 0
    log("geweigerd %s %s in %s (%s) sessie=%s" % (tool, bev[0][0], re.sub(r"[^A-Za-z0-9._-]", "?", bev[0][1])[:30], bev[0][2],
                                              re.sub(r"[^A-Za-z0-9-]", "", str(d.get("session_id", "")))[:40]))
    sys.stderr.write(melding(bev) + "\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
