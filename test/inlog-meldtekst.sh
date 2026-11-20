#!/usr/bin/env bash
# Actieplan 2B07 (wv3551): de noodmelding "Claude weigert de inlog" voor het eigen abonnement wijst naar het sleutelportaal (met link),
# niet naar Sleutelbos (daar is claude_code_oauth_token niet te vervangen: APP_SLEUTEL_PORTAAL_KLUIS). Tweede abonnement: Sleutelbos blijft.
# Knipt tokenDavidTekst + SLEUTELPORTAAL_URL uit de echte server.js; geen server, geen sleutels.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), vm = require('vm');
const s = fs.readFileSync('server.js', 'utf8');
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const u = /const SLEUTELPORTAAL_URL = [^\n]+\n/.exec(s), f = /function tokenDavidTekst\(account, hm\) \{[\s\S]*?\n\}\n/.exec(s);
const pk = /const APP_SLEUTEL_PORTAAL_KLUIS = new Set\(\[[^\]]*\]\)/.exec(s);
toets('tekstfunctie en portaallijst te vinden', !!(u && f && pk));
if (!(u && f && pk)) process.exit(1);
const c = {}; vm.createContext(c); vm.runInContext(u[0] + f[0] + pk[0] + ';\nthis.t = tokenDavidTekst; this.url = SLEUTELPORTAAL_URL; this.pk = APP_SLEUTEL_PORTAAL_KLUIS;', c);
const t1 = c.t(1, '20-11 09:00'), t2 = c.t(2, '20-11 09:00');
toets('eigen token staat op de portaallijst (uitgangspunt)', c.pk.has('claude_code_oauth_token'));
toets('tweede token staat niet op de portaallijst (uitgangspunt)', !c.pk.has('claude_oauth_token_2'));
toets('link is het sleutelportaal', c.url === 'https://claudebot.primumnonnocere.olares.com/sleutels', c.url);
toets('eigen abonnement: link in de melding, als laatste (geen leesteken erachter)', t1.endsWith(c.url));
toets('eigen abonnement: zegt niet "zet het in Sleutelbos"', !/zet het in Sleutelbos/.test(t1));
toets('eigen abonnement: noemt sleutelportaal, token en herstart', /sleutelportaal bij claude_code_oauth_token/.test(t1) && /herstart/.test(t1));
toets('tweede abonnement: Sleutelbos bij claude_oauth_token_2, geen portaal', /zet het in Sleutelbos bij claude_oauth_token_2/.test(t2) && !/sleutelportaal/i.test(t2));
toets('tijd staat erin', t1.includes('20-11 09:00') && t2.includes('20-11 09:00'));
console.log(fout ? 'ROOD: ' + fout : 'ALLES GROEN');
process.exit(fout ? 1 : 0);
JS
