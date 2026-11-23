#!/usr/bin/env bash
# Toetst wv3925 (besluitenpagina nr 178 = 2C78 b + d) op verzonnen signalen en adviezen: de teller op de tegel (nieuw sinds het bezoek, komt op
# nul, een bedragschuif telt niet opnieuw, tekort één keer per maand), de "Ik wil dit"-kaart (zelfde sleutel bij een tweede tik, geen verwijzing,
# adviseur-stap) en de stand op de lijst; plus de koppelingen in server.js (routes, gezien schrijft de sleutels, geldkaarten met focus).
# Raakt de pod, de bank, de databank en de vault niet. Gebruik: bash test/financien-teller.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const T = require(path.resolve('financien-teller.js'));
const sig = (soort, titel, zin) => ({ soort, toon: 'wacht', titel, zin });
const stand = (signalen, komende) => ({ signalen, overzicht: { nu: { komende: komende || null } } });
const a = stand([sig('prijsstap', 'Streamingdienst', 'Streamingdienst is € 2 duurder: € 14 per maand.'), sig('dubbel', 'Verzekeraar X', 'Op twee rekeningen.')]);
const k1 = T.sleutels(a);
toets('twee signalen = twee sleutels, vaste vorm', k1.length === 2 && k1.every((k) => /^s[0-9a-f]{12}$/.test(k)), k1);
toets('nog niet bezocht: alles telt', T.tel(k1, []).totaal === 2);
toets('na het bezoek (gezien = wat er stond): nul', T.tel(k1, k1).totaal === 0);
const b = stand([sig('prijsstap', 'Streamingdienst', 'Streamingdienst is € 3 duurder: € 15 per maand.'), sig('dubbel', 'Verzekeraar X', 'Op twee rekeningen.')]);
toets('zelfde signaal met ander bedrag telt niet opnieuw', T.tel(T.sleutels(b), k1).totaal === 0, T.sleutels(b));
const c = stand([sig('prijsstap', 'Streamingdienst', 'x'), sig('nieuw', 'Sportschool', 'Sportschool is nieuw sinds okt 2026: € 30 per maand.')]);
const tc = T.tel(T.sleutels(c), k1);
toets('nieuw signaal erbij: 1; een verdwenen signaal telt niet', tc.totaal === 1 && tc.signalen === 1 && tc.tekort === 0, tc);
const z = stand([sig('weg', null, 'Navragen: post liep een jaar geleden (€ 12 per maand).')]), z2 = stand([sig('weg', null, 'Navragen: post liep een jaar geleden (€ 13 per maand).')]);
toets('signaal zonder titel: herkenning zonder cijfers', T.sleutels(z)[0] === T.sleutels(z2)[0]);
const tk = stand([], { toon: 'fout', tot: '2026-12-04' }), tk2 = stand([], { toon: 'fout', tot: '2026-12-05' }), tk3 = stand([], { toon: 'fout', tot: '2027-01-02' });
toets('tekort telt (t-sleutel) en schuift niet elke dag', T.tel(T.sleutels(tk), []).tekort === 1 && T.tel(T.sleutels(tk2), T.sleutels(tk)).totaal === 0, T.sleutels(tk));
toets('tekort in een nieuwe maand telt weer', T.tel(T.sleutels(tk3), T.sleutels(tk)).totaal === 1);
toets('geen tekort (toon ok) telt niet', T.sleutels(stand([], { toon: 'ok', tot: '2026-12-04' })).length === 0);
toets('rommel in gezien wordt genegeerd', T.tel(k1, ['x', 42, null, 'sZZZ']).totaal === 2);
toets('lege of kapotte stand: nul, geen fout', T.sleutels(null).length === 0 && T.sleutels({}).length === 0 && T.tel(null, null).totaal === 0);
// ── Ik wil dit ──
const adv = { id: 'A2:0123456789ab', regel: 'A2', titel: 'Geld dat niets oplevert', zekerheid: 'schatting', actie: 'zelf', zin: 'Er staat ruim € 20.000 op een rekening zonder rente.', deadline: null };
const p = T.oppakKaart(adv), p2 = T.oppakKaart(Object.assign({}, adv, { zin: 'Er staat ruim € 21.000 op een rekening zonder rente.' }));
toets('kaart: sleutel hangt aan het advies-id (tweede tik, ander bedrag = zelfde punt)', p.sleutel === p2.sleutel && /^fin-advies-[0-9a-f]{12}$/.test(p.sleutel), [p.sleutel, p2.sleutel]);
toets('kaart: titel ≤ 90, privé, doen, focus Advies', p.titel.length <= 90 && p.prive === true && p.soort === 'doen' && p.herkomst.doel.scherm === 'financien' && p.herkomst.doel.focus === 'tab:advies', p);
toets('kaart: geen pad, wv-nummer of sleutel in titel/waarom/stappen', ![p.titel, p.waarom].concat(p.stappen).some((x) => /\/opt\/|wv\d|00_Systeem|\.md\b/.test(x)), p);
toets('kaart: zelf regelen bij actie zelf; waarom ≤ 400', /Regel het zelf/.test(p.stappen[1]) && p.waarom.length <= 400);
const pa = T.oppakKaart({ id: 'A1:aaaaaaaaaaaa', titel: 'Duurste leningdeel aflossen of geld laten staan?', zekerheid: 'laat toetsen', actie: 'adviseur', zin: 'x', deadline: '2026-12-31' });
toets('adviseur-advies: stap via de adviseur, geen vraagteken in de titel, deadline mee', /adviseur/.test(pa.stappen[1]) && !/\?/.test(pa.titel) && pa.deadline === '2026-12-31', pa);
let gooit = false; try { T.oppakKaart({ id: '../x', titel: 't', zin: 'z' }); } catch (e) { gooit = true; }
toets('onbekend advies-id gooit', gooit);
const lijst = T.opLijst({ 'A2:0123456789ab': { op: 'x' }, 'A1:aaaaaaaaaaaa': { op: 'y' }, 'A5:bbbbbbbbbbbb': { op: 'z' }, 'kapot': {} },
  [{ sleutel: p.sleutel, status: 'open', toon_vanaf: '2026-11-23T11:30:00Z' }, { sleutel: pa.sleutel, status: 'gedaan' }]);
toets('stand op de lijst: open met vanaf, gedaan, gezet (niet gelezen), kapot weg', lijst['A2:0123456789ab'].stand === 'open' && lijst['A2:0123456789ab'].vanaf === '2026-11-23T11:30:00Z' &&
  lijst['A1:aaaaaaaaaaaa'].stand === 'gedaan' && lijst['A5:bbbbbbbbbbbb'].stand === 'gezet' && !lijst.kapot, lijst);
// ── koppelingen in server.js ──
const srv = fs.readFileSync('server.js', 'utf8');
toets('server.js: drie routes', /route === 'GET \/app\/financien\/teller'\) return appFinTeller/.test(srv) && /route === 'GET \/app\/financien\/oppak'\) return appFinOppakLijst/.test(srv) && /route === 'POST \/app\/financien\/oppak'\) return appFinOppak/.test(srv));
toets('server.js: gezien schrijft de sleutels en bewaart de tikken', /signalen: signalen, oppak: b\.oppak/.test(srv) && /if \(b\.onleesbaar\) return appWeiger\(res, 503, 'bewaren lukte nu niet', 'fin-gezien onleesbaar'\)/.test(srv));
toets('server.js: teller 0 vóór het eerste bezoek met teller', /if \(!b\.signalen\) return appStuur\(res, 200, \{ ok: true, totaal: 0/.test(srv));
toets('server.js: oppak via mk_voor_jou_zet en alleen een advies uit de stand', /appSbRpc\('mk_voor_jou_zet', \{ p: p \}\)/.test(srv) && /fin-oppak niet in stand/.test(srv));
toets('server.js: geldkaarten met focus (komende, vast, signalen) en bankkaart op saldi', /s\.kaart === 'dekking' \? 'blok:komende' : s\.paypal \? 'blok:vast' : 'blok:signalen'/.test(srv) && /focus: 'blok:saldi'/.test(srv));
toets('server.js: kaarttekst wijst naar Financiën › Geld', /Apps › Financiën › Geld en kijk onder "Om naar te kijken"/.test(srv));
toets('server.js: gezien neemt alleen de getoonde herkenningen (teller_sleutels terug van de App), Codex MOET 1', /teller_sleutels: teller/.test(srv) && /const signalen = d && Array\.isArray\(d\.signalen\) \? F\.geldigeLijst\(d\.signalen\)/.test(srv));
toets('server.js: half antwoord (fouten) telt niet en een mislukte berekening wacht 2 min, Codex MOET 2 / ZOU 1', /j\.fouten\.length\)\) \{ appFinTellerFoutOp = Date\.now\(\)/.test(srv) && /nu - appFinTellerFoutOp < 2 \* 60000/.test(srv));
console.log('KLAAR ' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
