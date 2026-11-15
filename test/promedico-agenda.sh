#!/usr/bin/env bash
# wv3132: toets van de ontvanger Promedico-agenda + kruisproeven (een uitgeschakelde controle moet de toets rood maken).
set -u
HIER="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HIER")"
node "$HIER/promedico-agenda.test.js" > /tmp/pa-toets.$$ 2>&1; rc=$?
tail -1 /tmp/pa-toets.$$; grep '^FOUT' /tmp/pa-toets.$$; rm -f /tmp/pa-toets.$$
[ $rc -eq 0 ] || { echo "promedico-agenda: toets rood"; exit 1; }
KR="$(mktemp -d "$ROOT/.pa-kruis.XXXXXX")"; trap 'rm -rf "$KR"' EXIT
kruis() {   # naam, python-vervanging (oud -> nieuw)
  python3 - "$ROOT/promedico-agenda.js" "$KR/m.js" "$2" "$3" <<'PY'
import sys
s=open(sys.argv[1],encoding='utf-8').read(); a,b=sys.argv[3],sys.argv[4]
assert s.count(a)==1, 'kruisproef-anker niet gevonden: '+a
open(sys.argv[2],'w',encoding='utf-8').write(s.replace(a,b))
PY
  [ $? -eq 0 ] || { echo "kruisproef $1: anker weg"; exit 1; }
  if MODULE="$KR/m.js" node "$HIER/promedico-agenda.test.js" > /dev/null 2>&1; then echo "kruisproef $1: bleef GROEN (fout)"; exit 1; else echo "kruisproef $1: rood (goed)"; fi
}
kruis geheim "if (!goed) return weiger(401, 'geheim');" ""
kruis zeef "for (const [naam, re] of AGENDA_HARD) if (re.test(t)) soorten.push(naam);" ""
kruis volgorde "if (oud && !(gezienMs > oud.gezien_ms)) continue;
    if (oud) eerste = false;" "if (oud) eerste = false;"
kruis patientblok "if (!b.patient) {" "if (true) {"
kruis vorm "for (const k of Object.keys(o)) if (verplicht.indexOf(k) < 0 && optioneel.indexOf(k) < 0) {" "for (const k of Object.keys(o)) if (false) {"
kruis pagina-eerst "try { for (const w of r.weken) schrijfPagina(staat, w); } catch (e) { return weiger(500, 'pagina niet geschreven'); }
    try { schrijfStaat(staat); }" "try { schrijfStaat(staat); } catch (e) {}
    try { for (const w of r.weken) schrijfPagina(staat, w); } catch (e) { return weiger(500, 'pagina niet geschreven'); }
    try { }"
kruis herkend-toegestaan "const TOP_OPTIONEEL = ['sinds_vorige_blik', 'herkend'];" "const TOP_OPTIONEEL = ['sinds_vorige_blik'];"
kruis herkend-negeren "const r = herkend ? verwerkStand(staat, s, gezienMs, t, o.poort, null) : verwerkNietHerkend(staat, s, gezienMs, t);" "const r = verwerkStand(staat, s, gezienMs, t, o.poort, null);"
kruis veldnaam "const naam = RE_VELDNAAM.test(k) ? k : 'onleesbare naam';" "const naam = '';"
kruis naam-niet-anoniem "const naam = RE_VELDNAAM.test(k) ? k : 'onleesbare naam';" "const naam = k;"
kruis snoei-mislukt "for (const w of Object.keys(staat.mislukt)) levend.add(w);" ""
echo "promedico-agenda: toets + 11 kruisproeven goed"
