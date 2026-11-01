#!/usr/bin/env bash
# Toetst vault_retentie uit run.sh (wv2175, David Ja 1-11-2026): handkopieën vault-onderhoud-<JJJJMMDD>-<uumm>.tgz gaan na 14 dagen weg;
# een andere vorm (vault-voor-…, verkeerde cijfers, ongeldige datum, staart erachter) blijft staan; de dagtar-regels blijven zoals ze waren.
# De functie wordt uit run.sh geknipt (van "vault_retentie(){" tot de eerste "}" in kolom 1) en draait op een wegwerpmap.
# Gebruik: bash test/vault-retentie.sh
set -u
cd "$(dirname "$0")/.." || exit 1
fouten=0; goed=0
toets(){ if [ "$2" = 1 ]; then goed=$((goed + 1)); echo "GROEN $1"; else fouten=$((fouten + 1)); echo "ROOD  $1"; fi; }

FUNC="$(awk '/^vault_retentie\(\)\{/{p=1} p{print} p&&/^\}/{exit}' run.sh)"
[ -n "$FUNC" ] && printf '%s\n' "$FUNC" | tail -1 | grep -qx '}' ; toets "functie uit run.sh geknipt" $([ $? -eq 0 ] && echo 1 || echo 0)
printf '%s\n' "$FUNC" | grep -q 'onderhoud-' ; toets "geknipte functie kent de onderhoudsvorm" $([ $? -eq 0 ] && echo 1 || echo 0)

d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
dag(){ date -d "$1 days ago" +%Y%m%d; }
dagstreep(){ date -d "$1 days ago" +%Y-%m-%d; }
# een dagtar van 20–40 dagen oud die geen zondag en geen 1e is (die moet weg)
for n in $(seq 20 40); do
  [ "$(date -d "$n days ago" +%u)" != 7 ] && [ "$(date -d "$n days ago" +%d)" != 01 ] && { oud=$n; break; }
done

blijft=(
  "vault-onderhoud-$(dag 0)-0100.tgz"
  "vault-onderhoud-$(dag 14)-2330.tgz"
  "vault-voor-syncthing-$(dag 60)-1516.tgz"
  "vault-onderhoud-2026102-0826.tgz"
  "vault-onderhoud-20261399-0000.tgz"
  "vault-onderhoud-$(dag 60)-0826-extra.tgz"
  "vault-onderhoud-$(dag 60)-826.tgz"
  "vault-onderhoud-$(dag 60)-2460.tgz"
  "vault-onderhoud-$(dag 60)-9999.tgz"
  "vault-$(dagstreep 0).tgz"
)
weg=(
  "vault-onderhoud-$(dag 16)-0826.tgz"   # 16, niet 15: rond een zomertijdwissel kort na middernacht telt 15 dagen als 14
  "vault-onderhoud-$(dag 60)-2329.tgz"
  "vault-$(dagstreep "$oud").tgz"
)
for f in "${blijft[@]}" "${weg[@]}"; do : > "$d/$f"; done
: > "$d/los-bestand.txt"

log="$d/blog.txt"
BACKUP_DIR="$d" bash -c "blog(){ printf '%s\n' \"\$*\" >> '$log'; }; $FUNC
vault_retentie"
toets "vault_retentie eindigt met 0" $([ $? -eq 0 ] && echo 1 || echo 0)

for f in "${blijft[@]}"; do toets "blijft: $f" $([ -e "$d/$f" ] && echo 1 || echo 0); done
for f in "${weg[@]}"; do toets "weg: $f" $([ -e "$d/$f" ] && echo 0 || echo 1); done
toets "ander bestand ongemoeid" $([ -e "$d/los-bestand.txt" ] && echo 1 || echo 0)
toets "logregel telt 3 verwijderd" $(grep -qx 'retentie: 3 oude snapshot(s) verwijderd' "$log" 2>/dev/null && echo 1 || echo 0)

echo "vault-retentie: $goed groen, $fouten rood"
[ "$fouten" -eq 0 ]
