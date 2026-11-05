"""vault_veilig.py — lezen, schrijven en aanvullen in de vault zonder een symlink te volgen (wv900, 24-10-2026).

Waarom: deze code draait als claude (uid 1001, alle sleutels), maar de vaultmappen zijn ook schrijfbaar voor elk
Socev-gesprek (uid socev, 1002): wissen, hernoemen en tot de na-ronde (<= 5 min) een symlink zetten. Volgt claude zo'n link,
dan schrijft hij inhoud die socev vaak zelf kiest (de box, een register) in een bestand naar keuze - ook code in mk-scripts of
een hook-config, dus code-uitvoering als claude - of leest hij een geheim en zet het terug in de vault. Een vaste tijdelijke
naam (`BOX + ".tmp"`) of `open(pagina, "w")` volgt zo'n link; een map die socev door een link vervangt, wordt ook gevolgd
(O_NOFOLLOW dekt alleen de laatste component; Fable wv887 MOET 1).

Het patroon (zelfde als vault-veilig.js en health-pod import_vault.py `_box_rij`): de map openen als descriptor en via
/proc/self/fd toetsen dat hij echt op zijn plek staat (geen enkele padcomponent een symlink); alles daarna relatief aan die
descriptor (openat/renameat, dus ook een map die ná de toets wordt omgeleid volgen we niet); lezen O_NOFOLLOW|O_NONBLOCK en
alleen een gewoon bestand; schrijven via een eigen tijdelijk bestand met willekeurige naam, O_CREAT|O_EXCL|O_NOFOLLOW, en
rename binnen die map; modus die van het bestaande bestand (de groepsbits zijn het ACL-masker: socev houdt rw op de box),
anders 0660; aanvullen O_APPEND|O_NOFOLLOW. `wijzig` doet lezen-wijzigen-schrijven onder flock op de map.

Krimpgrens (wv2439, 5-11-2026): de box verloor 4-11 en 5-11 alles onder een bewerkte rij, omdat de bewerkfunctie van een agent
`s[:i] + nieuw` teruggaf zonder `s[j:]`. `wijzig` weigert daarom (KrimpFout, niets geschreven) als de nieuwe tekst meer dan de
helft én meer dan 20 kB kleiner is, of als er regels die met '## ' beginnen verdwijnen (minder dan ervoor). Standaard aan voor
bestanden onder een map 00_Systeem (box, Open vragen, Systeemoverzicht, registers); elders met krimp_grens=True. Haalt de
aanroeper bewust rijen weg (archiefstap van de droomronde), dan krimp_ok=True. Een bewerkfunctie geeft altijd
s[:i] + nieuw + s[j:] terug.

Canonieke bron: claudebot-src (getoetst in CI, test/vault-veilig.sh). Kopie: /opt/data/mk-scripts/veilig/vault_veilig.py
(byte-gelijk; CISO C7-kopie-drift bewaakt dat).
"""
import errno
import fcntl
import os
import re
import stat
import time

TMP_ACHTER = ".vv.tmp"
TMP_PATROON = re.compile(r"^\..*\.[0-9a-f]{16}\.vv\.tmp$")


class SymlinkFout(OSError):
    """Een padcomponent is een symlink (of staat niet op zijn plek); er is niets gelezen of geschreven."""


class KrimpFout(ValueError):
    """wijzig weigert: de nieuwe tekst krimpt te veel of verliest '## '-koppen (wv2439); er is niets geschreven."""


KRIMP_BYTES = 20000      # meer dan zoveel bytes kwijt ...
KRIMP_DEEL = 0.5         # ... én meer dan dit deel van het bestand
KRIMP_MAP = "00_Systeem"  # grens standaard aan voor alles onder een map met deze naam


def _koppen(t):
    return sum(1 for r in t.split("\n") if r.startswith("## "))


def krimp_fout(oud, nieuw, pad=""):
    """Foutmelding als nieuw te veel krimpt ten opzichte van oud (bytes of '## '-koppen), anders None. Puur; ook voor eigen toetsen."""
    ob = _data(oud)
    nb = _data(nieuw)
    ot = ob.decode("utf-8", "replace")
    nt = nb.decode("utf-8", "replace")
    ko, kn = _koppen(ot), _koppen(nt)
    redenen = []
    if len(ob) - len(nb) > KRIMP_BYTES and len(nb) < len(ob) * (1 - KRIMP_DEEL):
        redenen.append("meer dan de helft kleiner")
    if kn < ko:
        redenen.append(f"{ko - kn} regel(s) met '## ' verdwenen")
    if not redenen:
        return None
    return (f"krimpgrens: {pad or 'bestand'} niet geschreven ({', '.join(redenen)}; oud {len(ob)} bytes en {ko} koppen, nieuw "
            f"{len(nb)} bytes en {kn} koppen). Vergat de bewerkfunctie de rest van de tekst (s[:i] + nieuw + s[j:])? Haal je bewust "
            f"rijen weg (archiefstap), geef dan krimp_ok=True mee (wv2439).")


def _grens_aan(pad, krimp_grens):
    if krimp_grens is not None:
        return bool(krimp_grens)
    return KRIMP_MAP in os.path.abspath(pad).split(os.sep)[:-1]


def _op_plek(fd, pad):
    try:
        return os.readlink(f"/proc/self/fd/{fd}") == os.path.abspath(pad)
    except OSError:
        return False


def open_map(map_):
    """Descriptor van een map waarvan vaststaat dat geen enkele component een symlink is."""
    try:
        dfd = os.open(map_, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except (NotADirectoryError, OSError) as e:
        if os.path.islink(map_):
            raise SymlinkFout(f"map is een symlink: {map_}") from e
        raise
    if not _op_plek(dfd, map_):
        os.close(dfd)
        raise SymlinkFout(f"map loopt via een symlink: {map_}")
    return dfd


def _open_nofollow(naam, vlaggen, modus, dfd, pad):
    try:
        return os.open(naam, vlaggen | os.O_NOFOLLOW, modus, dir_fd=dfd)
    except OSError as e:
        if e.errno == errno.ELOOP:
            raise SymlinkFout(f"pad is een symlink: {pad}") from e
        raise


def _lees_fd(dfd, naam, pad, binair):
    fd = _open_nofollow(naam, os.O_RDONLY | os.O_NONBLOCK, 0o777, dfd, pad)
    with os.fdopen(fd, "rb") as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            raise OSError(f"geen gewoon bestand: {pad}")
        data = f.read()
    return data if binair else data.decode("utf-8")


def _stat_gewoon(dfd, naam):
    try:
        st = os.stat(naam, dir_fd=dfd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    return st if stat.S_ISREG(st.st_mode) else None


def _ruim_op(dfd):
    """Een tijdelijk bestand dat een gedode schrijver (SIGKILL) achterliet en ouder is dan een uur."""
    try:
        for n in os.listdir(dfd):
            if TMP_PATROON.match(n):
                try:
                    st = os.stat(n, dir_fd=dfd, follow_symlinks=False)
                    if stat.S_ISREG(st.st_mode) and time.time() - st.st_mtime > 3600:
                        os.unlink(n, dir_fd=dfd)
                except OSError:
                    pass
    except OSError:
        pass


def _kort_op_bytes(t, n):
    """Naamdeel voor het tijdelijke bestand: hooguit n bytes UTF-8 (een naam met veel € gaf anders ENAMETOOLONG)."""
    return t.encode("utf-8")[:n].decode("utf-8", "ignore")


def _stempel(st):
    return (st.st_ino, st.st_size, st.st_mtime_ns) if st else None


def _schrijf_fd(dfd, naam, data, modus, als_gelijk=False):
    """als_gelijk: stempel (inode, grootte, mtime) die het bestand vlak voor de rename nog moet hebben; False = niet toetsen."""
    oud = _stat_gewoon(dfd, naam)
    if modus is None:
        modus = (oud.st_mode & 0o777) if oud else 0o660
    tmp = f".{_kort_op_bytes(naam, 80)}.{os.urandom(8).hex()}{TMP_ACHTER}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fchmod(f.fileno(), modus)
            os.fsync(f.fileno())
        if als_gelijk is not False and _stempel(_stat_gewoon(dfd, naam)) != als_gelijk:
            os.unlink(tmp, dir_fd=dfd)
            return False
        os.replace(tmp, naam, src_dir_fd=dfd, dst_dir_fd=dfd)
    except BaseException:
        try:
            os.unlink(tmp, dir_fd=dfd)
        except OSError:
            pass
        raise
    _ruim_op(dfd)
    return True


def _data(inhoud):
    return inhoud.encode("utf-8") if isinstance(inhoud, str) else inhoud


def lees(pad, binair=False):
    map_, naam = os.path.split(os.path.abspath(pad))
    dfd = open_map(map_)
    try:
        return _lees_fd(dfd, naam, pad, binair)
    finally:
        os.close(dfd)


def schrijf(pad, inhoud, modus=None):
    """inhoud (str of bytes) naar pad via een eigen tijdelijk bestand + rename in dezelfde (getoetste) map."""
    map_, naam = os.path.split(os.path.abspath(pad))
    dfd = open_map(map_)
    try:
        _schrijf_fd(dfd, naam, _data(inhoud), modus)
    finally:
        os.close(dfd)


def voeg_toe(pad, tekst, maak=False, modus=0o660):
    """Aanvullen met één write (O_APPEND); maak=True maakt het bestand aan als het ontbreekt, nooit via een hangende link."""
    map_, naam = os.path.split(os.path.abspath(pad))
    dfd = open_map(map_)
    try:
        fl = os.O_WRONLY | os.O_APPEND | os.O_NONBLOCK | (os.O_CREAT if maak else 0)
        fd = _open_nofollow(naam, fl, modus, dfd, pad)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise OSError(f"geen gewoon bestand: {pad}")
            os.write(fd, _data(tekst))
        finally:
            os.close(fd)
    finally:
        os.close(dfd)


def wijzig(pad, functie, modus=None, grendel=True, krimp_ok=False, krimp_grens=None):
    """Lees pad, laat functie(tekst) de nieuwe tekst geven (None = niets doen) en schrijf die weg, alles relatief aan één
    getoetste mapdescriptor en (standaard) onder flock op die map, zodat twee Python-schrijvers elkaars rij niet verliezen.
    Geeft True als er geschreven is. Schreef een JS-schrijver (zonder flock) tussen lezen en rename, dan opnieuw (tot 3 keer;
    zelfde toets op inode, grootte en mtime als vault-veilig.js; Fable wv900 natoets #3).
    Krimpgrens (wv2439): onder 00_Systeem (of met krimp_grens=True) KrimpFout als de nieuwe tekst te veel krimpt of '## '-koppen
    verliest; krimp_ok=True voor een bewuste archief- of opruimstap."""
    map_, naam = os.path.split(os.path.abspath(pad))
    dfd = open_map(map_)
    try:
        if grendel:
            fcntl.flock(dfd, fcntl.LOCK_EX)
        for _ in range(3):
            voor = _stempel(_stat_gewoon(dfd, naam))
            oud = _lees_fd(dfd, naam, pad, False)
            nieuw = functie(oud)
            if nieuw is None:
                return False
            if not krimp_ok and _grens_aan(pad, krimp_grens):
                f = krimp_fout(oud, nieuw, pad)
                if f:
                    raise KrimpFout(f)
            if _schrijf_fd(dfd, naam, _data(nieuw), modus, als_gelijk=voor):
                return True
        return False
    finally:
        os.close(dfd)
