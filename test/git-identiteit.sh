#!/usr/bin/env bash
# test/git-identiteit.sh [run.sh] — git-identiteit van de pod (wv3039, 14-11-2026).
# Knipt setup_git_pod en setup_git uit run.sh en draait ze met een eigen HOME (proef-.gitconfig).
# Eist: globaal "Socev machinekamer" ook als de chart GIT_USER_NAME (GHAWA) zet; de GHAWA-naam alleen
# lokaal in de GHAWA-clone; safe.directory één regel, ook na drie starts en met oude dubbelingen;
# en dat de opstartvolgorde setup_git_pod buiten het GIT_REPO_URL-blok aanroept.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
RUNSH="${1:-$HIER/run.sh}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ROOD=0; ok(){ echo "  ok   $1"; }; fout(){ echo "  ROOD $1"; ROOD=1; }

awk '/^# Globale git-identiteit van de pod/{p=1} /^# Klonen \(1e keer\)/{p=0} p' "$RUNSH" > "$T/blok.sh"
grep -q '^setup_git_pod()' "$T/blok.sh" && grep -q '^setup_git()' "$T/blok.sh" || { echo "kon setup_git(_pod) niet uit run.sh knippen"; exit 1; }

draai(){ # $1 = aantal starts
  ( export HOME="$T/home" GIT_CONFIG_NOSYSTEM=1; unset GIT_CONFIG_GLOBAL GITHUB_PAT POD_GIT_NAAM POD_GIT_MAIL
    export GIT_USER_NAME="GHAWA Website Bot" GIT_USER_EMAIL="bot@ghawa.org"
    REPO_DIR="$T/repo"; GHAWA_CRED="$T/cred"; log(){ :; }
    . "$T/blok.sh"
    for _ in $(seq 1 "$1"); do setup_git_pod; setup_git; done ) >/dev/null 2>&1
}
G(){ HOME="$T/home" GIT_CONFIG_NOSYSTEM=1 git "$@" 2>/dev/null; }

echo "== met GHAWA-clone en oude globale config =="
mkdir -p "$T/home" "$T/repo"; git init -q "$T/repo"
printf '[user]\n\tname = GHAWA Website Bot\n\temail = bot@ghawa.org\n[safe]\n\tdirectory = %s\n\tdirectory = %s\n\tdirectory = /elders\n\tdirectory = %s\n' "$T/repo" "$T/repo" "$T/repo" > "$T/home/.gitconfig"
draai 3
[ "$(G config --global user.name)" = "Socev machinekamer" ] && ok "globale naam Socev machinekamer" || fout "globale naam = '$(G config --global user.name)'"
[ "$(G config --global user.email)" = "machinekamer@socev.dev" ] && ok "globale mail" || fout "globale mail = '$(G config --global user.email)'"
[ "$(G -C "$T/repo" config --local user.name)" = "GHAWA Website Bot" ] && ok "GHAWA-naam lokaal in de clone" || fout "lokale naam clone = '$(G -C "$T/repo" config --local user.name)'"
n=$(G config --global --get-all safe.directory | grep -cFx "$T/repo")
[ "$n" = 1 ] && ok "safe.directory één regel na 3 starts" || fout "safe.directory $n regels"
G config --global --get-all safe.directory | grep -qFx /elders && ok "andere safe.directory blijft" || fout "andere safe.directory weg"
mkdir -p "$T/ander"; git init -q "$T/ander"
[ "$(G -C "$T/ander" config user.name)" = "Socev machinekamer" ] && ok "andere repo erft Socev machinekamer" || fout "andere repo = '$(G -C "$T/ander" config user.name)'"

echo "== zonder clone, verse HOME =="
rm -rf "$T/home" "$T/repo"; mkdir -p "$T/home"
draai 1
[ "$(G config --global user.name)" = "Socev machinekamer" ] && ok "globale naam zonder clone" || fout "globale naam zonder clone = '$(G config --global user.name)'"
[ "$(G config --global --get-all safe.directory | grep -cFx "$T/repo")" = 1 ] && ok "safe.directory toegevoegd op vers volume" || fout "safe.directory ontbreekt op vers volume"

echo "== opstartvolgorde =="
start=$(grep -n '^setup_git_pod$' "$RUNSH" | head -1 | cut -d: -f1)
blok=$(grep -n '^if \[ -n "\$REPO_URL" \]; then' "$RUNSH" | head -1 | cut -d: -f1)
[ -n "$start" ] && [ -n "$blok" ] && [ "$start" -lt "$blok" ] && ok "setup_git_pod vóór en buiten het GHAWA-blok" || fout "setup_git_pod niet buiten het GHAWA-blok aangeroepen (r. ${start:-?} / ${blok:-?})"

[ "$ROOD" = 0 ] && echo "GROEN" || { echo "ROOD"; exit 1; }
