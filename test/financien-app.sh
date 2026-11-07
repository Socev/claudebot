#!/usr/bin/env bash
# Toetst financien-app.js (wv771, App Financiën; bouwplan idee 16 § 11) op een nagebootste transactiedatabase (zelfde soort posten als
# test/bank-archief.sh, maar met maanden tot en met vandaag): het antwoord is veld voor veld opgebouwd (geen IBAN, machtiging,
# omschrijving, geen losse posten, geen tabel_md of let_op); sinds wv1957 (David 28-10: niets voor hem afschermen) steun en een externe
# rekening met hun naam, dubbel met de naam van de aanbieder; signalen alleen gemeten (hypotheek dalend nooit "weg"/"lager", naamwissel gemeente geen "nieuw"/"weg", prijsstap
# meerdere reeksen, PayPal twee keer hetzelfde bedrag = dubbel, weggevallen reeks = navragen, energie dezelfde maanden vorig jaar);
# volledigheid vanaf de koppeling (bunq telt niet); opzeglinks alleen met host uit de allowlist in de code, https, zonder userinfo of
# poort, precies één herkenwoord op woordgrens; Bewust-tabel dempt; een kapot blok maakt alleen dat blok leeg; via bank-lezer.js.
# Raakt de pod, de kluis, de bank, de vault en /opt/data/bank niet. Gebruik: bash test/financien-app.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings --require ./test/vaste-klok.cjs - <<'JS'   # wv1044: TOETS_NU=<ISO> draait de toets (en bank-lezer.js) op een vast moment
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'financien-app-'));
const BD = path.join(W, 'bank'), VAULT = path.join(W, 'vault');
const A = require(path.resolve('bank-archief.js')), F = require(path.resolve('financien-app.js'));
const vandaag = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const mNu = vandaag.slice(0, 7);
const IV = { vl: 'NL00ABNA0123456789', pr: 'NL11BUNQ0000000001', el: 'NL44BUNQ0000000004', sp: 'NL55BUNQ0000000005' };
const REK = {
  vl: { uid: 'u1', bank: 'ABN AMRO', naam: 'Vaste lasten', iban: IV.vl, sessie: 's1' },
  pr: { bron: 'bunq', uid: 'bunq-1', bunq_id: 1, naam: 'Privé', soort: 'lopend', iban: IV.pr, status: 'ACTIVE' },
  el: { bron: 'bunq', uid: 'bunq-4', bunq_id: 4, naam: 'Rekening Petronella Ontvanger', soort: 'lopend', iban: IV.el, status: 'ACTIVE' },
  sp: { bron: 'bunq', uid: 'bunq-5', bunq_id: 5, naam: 'Spaar', soort: 'spaar', iban: IV.sp, status: 'ACTIVE' },
};
const p = (id, datum, bedrag, tegen, omschr, extra) => Object.assign({ id: id, datum: datum, valutadatum: datum, bedrag: bedrag, valuta: 'EUR', tegenpartij: tegen, omschrijving: omschr || null,
  status: 'geboekt', saldo_na: null, mcc: null, tegen_iban: null, _ruw: { id: id, bron: 'nagebootst' } }, extra || {});
const inc = (mach, naam) => 'SEPA Incasso algemeen doorlopend Incassant: NL00ZZZ999999990000 Naam: ' + naam + ' Machtiging: ' + mach + ' Omschrijving: termijn';
const dg = (ym, d) => ym + '-' + String(d).padStart(2, '0');
const mnd = []; for (let i = 19; i >= 0; i--) mnd.push(F.maandPlus(mNu, -i));
const vorig = mnd.slice(0, -1);   // de lopende maand alleen tot vandaag
const dagNu = Number(vandaag.slice(8, 10));
const VL = [], PR = [], EL = [], SP = [];
let n = 0; const q = (l, datum, bedrag, tegen, oms, extra) => { if (datum <= vandaag) l.push(p('x:' + (++n), datum, bedrag, tegen, oms, extra)); };
mnd.forEach((ym, k) => {
  q(VL, dg(ym, 1), -(2900 - 2.5 * k), 'ABN AMRO BANK NV', inc('ST 1110 7002', 'ABN AMRO BANK NV'));                 // hypotheek, lineair dalend
  q(VL, dg(ym, 15), k >= mnd.length - 3 ? -33 : -30, 'KPN - Mobiel', inc('M1', 'KPN - Mobiel'));                     // prijsstap twee maanden geleden
  q(VL, dg(ym, 16), -15, 'KPN - Mobiel', inc('M 2', 'KPN - Mobiel'));                                                // tweede nummer
  q(VL, dg(ym, 25), -[400, 380, 300, 250, 200, 180, 170, 190, 260, 330, 390, 420, 410, 390, 310, 240, 210, 190, 270, 350][k], 'Tibber Netherlands B.V.', inc('TB1', 'Tibber'));
  q(VL, dg(ym, 27), -270, 'NV UNIVE ZORG', inc('UV1', 'NV UNIVE ZORG'));
  q(VL, dg(ym, 10), -9.99, 'PayPal Europe S.a.r.l. e', inc('PP1', 'PayPal'));
  q(VL, dg(ym, 11), -4.99, 'PayPal Europe S.a.r.l. e', inc('PP1', 'PayPal'));
  q(VL, dg(ym, 19), -4.99, 'PayPal (Europe) S.a r.l.', inc('PP1', 'PayPal'));
  if (k < 8) q(VL, dg(ym, 6), -12.5, 'Krant BV', inc('KR1', 'Krant BV'));                                             // gestopt: weg
  q(VL, dg(ym, 5), -50, 'Jan Jansen', 'SEPA Overboeking IBAN: NL22RABO0123456789 BIC: RABONL2U Naam: Jan Jansen Omschrijving: huur');
  if (k < 10) q(VL, dg(ym, 28), -200, 'Gemeente Huizen', inc('000000043562', 'Gemeente Huizen'));
  else q(VL, dg(ym, 28), -205, 'GEM HUIZEN BELASTINGEN', inc('43562', 'GEM HUIZEN BELASTINGEN'));                   // naamwissel, zelfde machtiging
  q(VL, dg(ym, 20), -350, 'D. Schaap', 'Periodieke overb Geld', { tegen_iban: IV.el });                               // steun (externe rekening)
  // alleen tot vandaag, net als q(): een post in de toekomst schuift de peildag van het archief op (wv1044: rood op dag 1–9 van elke maand)
  if (dg(ym, 20) <= vandaag) EL.push(p('el:' + ym, dg(ym, 20), 350, 'D SCHAAP CJ', 'Geld', { tegen_iban: IV.vl }));
  q(VL, dg(ym, 19), 5000, 'D. Schaap', 'vaste storting', { tegen_iban: IV.pr });
  if (dg(ym, 19) <= vandaag) PR.push(p('pr:' + ym, dg(ym, 19), -5000, 'D. Schaap', 'vaste storting', { tegen_iban: IV.vl }));
  if (dg(ym, 3) <= vandaag) { PR.push(p('prs:' + ym, dg(ym, 3), -500, 'Spaar', 'sparen', { tegen_iban: IV.sp })); SP.push(p('sp:' + ym, dg(ym, 3), 500, 'D. Schaap', 'sparen', { tegen_iban: IV.pr })); }
  if (dg(ym, 2) <= vandaag) PR.push(p('prb:' + ym, dg(ym, 2), -61.2, 'Albert Heijn 1234', 'boodschappen'));
});
// Streamingdienst op twee eigen rekeningen (dubbel), en een betaaldienst op twee rekeningen (geen dubbel)
mnd.slice(-6).forEach((ym, k) => {
  q(PR, dg(ym, 7), -13.99, 'Netflix International B.V.', 'netflix abonnement');
  q(VL, dg(ym, 8), -13.99, 'Netflix International B.V.', inc('NF1', 'Netflix'));
  q(PR, dg(ym, 9), -20, 'Stichting Buckaroo', 'buckaroo betaling');
  q(VL, dg(ym, 9), -20, 'Stichting Buckaroo', inc('BK1', 'Buckaroo'));
});
const a = A.open(BD);
A.rekeningenSync(a, REK);
A.bij(a, 'vl', VL, { volledigVanaf: mnd[0] + '-01' }); A.bij(a, 'pr', PR, {}); A.bij(a, 'el', EL, {}); A.bij(a, 'sp', SP, {});
A.corrigeer(a, { rek: 'el', eigenaar: 'extern' });
const nr = (re) => a.db.prepare('SELECT nr FROM transacties WHERE tegenpartij LIKE ? LIMIT 1').get(re).nr;
A.corrigeer(a, { nr: nr('Tibber%'), categorie: 'wonen', subcategorie: 'energie' });
A.corrigeer(a, { nr: nr('Netflix%'), categorie: 'abonnementen en communicatie', subcategorie: 'streaming' });
A.corrigeer(a, { nr: nr('%Buckaroo%'), categorie: 'abonnementen en communicatie', subcategorie: 'streaming' });
A.verrijk(a);

// ── vault met de linkslijst: geldige, kwaadwillende en kapotte rijen ──
const LP = path.join(VAULT, F.LINK_PAGINA);
fs.mkdirSync(path.dirname(LP), { recursive: true });
const linkPagina = (extraLinks, bewust) => `---
type: register
---
# Opzeglinks

## Links

| Aanbieder | Herkenwoord | Link | Soort | Bron | Gecontroleerd |
|---|---|---|---|---|---|
| KPN Mobiel | kpn - mobiel | https://www.kpn.com/service/administratie/opzeggen/mobiel-abonnement/opzegging-doorgeven | opzeggen | geopend | 22-10-2026 |
| Univé | unive zorg | https://www.unive.nl/zorgverzekering/opzeggen | opzeggen | geopend | 22-10-2026 |
| Tibber nep | tibber | https://tibber.com.evil.example/login | opzeggen | geopend | 22-10-2026 |
| Netflix nep | netflix | https://help.netflix.com@evil.example/ | opzeggen | geopend | 22-10-2026 |
| Netflix http | netflix | http://help.netflix.com/nl/node/407 | opzeggen | geopend | 22-10-2026 |
| Netflix poort | netflix | https://help.netflix.com:8443/nl/node/407 | opzeggen | geopend | 22-10-2026 |
| Onbekend | krant | https://www.krant.example/opzeggen | opzeggen | geopend | 22-10-2026 |
| Zonder bron | npo | https://npo.nl/service/npo-start | opzeggen |  | 22-10-2026 |
| Zonder datum | npo | https://npo.nl/service/npo-start | opzeggen | geopend | gisteren |
| Verkeerde soort | npo | https://npo.nl/service/npo-start | betalen | geopend | 22-10-2026 |
${extraLinks || ''}
## Bewust

| Herkenwoord | Signaal | Sinds | Op woord van David |
|---|---|---|---|
${bewust || ''}
`;
fs.writeFileSync(LP, linkPagina());

// ── linkregels los ──
{
  const L = F.leesLinks(VAULT);
  toets('links: alleen de twee geldige rijen; acht kwaadwillende of kapotte rijen genegeerd', L.links.length === 2 && L.genegeerd === 8 && L.links.every((l) => /^https:\/\/www\.(kpn\.com|unive\.nl)\//.test(l.url)), L);
  toets('links: precies één herkenwoord op woordgrens; "kpn - mobiel" niet in "KPN B.V."', !!F.linkVoor('KPN - Mobiel', L.links) && !F.linkVoor('KPN B.V.', L.links) && !F.linkVoor('NV UNIVEZORG', L.links), null);
  const twee = L.links.concat([{ herken: 'zorg', url: 'https://x', host: 'x', soort: 'opzeggen', gecontroleerd: '1-1-2026' }]);
  toets('links: twee verschillende herkenwoorden in één naam = geen link', !F.linkVoor('NV UNIVE ZORG', twee), null);
  toets('links: allowlist in de code, geen wildcard, alleen https-hosts', Object.keys(F.LINK_HOSTS).length >= 20 && Object.values(F.LINK_HOSTS).every((h) => h.every((x) => /^[a-z0-9.-]+$/.test(x))), null);
  toets('links: ontbrekende pagina = geen links, geen fout', F.leesLinks(path.join(W, 'nergens')).links.length === 0, null);
}

// ── het hele overzicht ──
const uit = F.bereken(A, a, { vault: VAULT, paypal: null });
// wv2596: het blok overzicht noemt tegenpartijen bij naam (opruimlijst, steekproef; Davids eigen App, wv1957) en heeft een eigen toets
// (test/financien-overzicht.sh); de veld-voor-veldregels hieronder gelden voor de rest
const tekst = JSON.stringify(Object.assign({}, uit, { overzicht: undefined }));
toets('bereken: geen kapot blok', Array.isArray(uit.fouten) && uit.fouten.length === 0, uit.fouten);
toets('privacy: geen IBAN, machtiging of incassant-ID in het antwoord', !/NL\d{2}[A-Z]{4}\d{6,}/.test(tekst) && !/Machtiging|Incassant|ZZZ999|43562|ST 1110/.test(tekst), tekst.match(/NL\d{2}[A-Z]{4}\d+|Machtiging|43562/));
toets('veld voor veld: geen omschrijving en geen losse posten (Jan Jansen is een losse overboeking, Albert Heijn een losse betaling)', !/Jan Jansen|huur|vaste storting|Periodieke|SCHAAP CJ|Albert Heijn|sparen/.test(tekst), tekst.match(/Jan Jansen|SCHAAP CJ|Albert Heijn/));
toets('privacy: geen tabel_md, let_op of losse saldo-velden buiten de dekking', !/tabel_md|let_op|saldo_na/.test(tekst), null);
const sleutels = (o, pad, acc) => { if (o && typeof o === 'object') Object.keys(o).forEach((k) => { acc.add(k); sleutels(o[k], k, acc); }); return acc; };
const ks = sleutels(uit, '', new Set());
toets('privacy: geen veld nr, sleutel(s), iban, omschrijving of tegenpartij', !['nr', 'sleutel', 'sleutels', 'iban', 'omschrijving', 'tegenpartij', 'rek', 'machtiging'].some((k) => ks.has(k)), Array.from(ks));
const vl = uit.vaste_lasten;
toets('vaste lasten: rekening, totaal en rijen; steun met de naam van de ontvangende rekening (wv1957)', vl && vl.posten > 4 && vl.totaal_per_maand > 3000 && vl.steun.length === 1 && /Petronella/.test(vl.steun[0].naam) && vl.steun[0].per_maand === 350, vl && { posten: vl.posten, steun: vl.steun });
const rij = (re) => vl.rijen.find((r) => re.test(r.naam));
toets('vaste lasten: PayPal als één regel "PayPal" met het aantal onderdelen, zonder link', rij(/^PayPal$/) && rij(/^PayPal$/).onderdelen >= 3 && rij(/^PayPal$/).link === null, rij(/^PayPal$/));
toets('vaste lasten: opzeglink alleen bij een geldige rij (KPN Mobiel, Univé), Tibber (nep-host) zonder', rij(/KPN - Mobiel/).link && rij(/KPN - Mobiel/).link.host === 'www.kpn.com' && rij(/UNIVE/).link && !rij(/Tibber/).link, [rij(/KPN/), rij(/Tibber/)]);
toets('vaste lasten: hypotheek dalend, geen jaarvergelijking', rij(/ABN AMRO/).wijze === 'dalend' && rij(/ABN AMRO/).jaar_geleden === null, rij(/ABN AMRO/));
const sig = uit.signalen, s = (soort, re) => sig.filter((x) => x.soort === soort && re.test(x.titel + ' ' + x.zin));
toets('signalen: hypotheek nooit "weg" of "lager"', !sig.some((x) => /ABN AMRO/.test(x.titel) && /weg|lager/.test(x.soort)), sig);
toets('signalen: gemeente over de naamwissel geen "nieuw" en geen "weg"', !sig.some((x) => /GEM|Gemeente/i.test(x.titel) && /weg|nieuw/.test(x.soort)), sig);
toets('signalen: KPN-prijsstap (twee reeksen, tegen drie maanden terug) of duurder dan een jaar geleden', s('prijsstap', /KPN/).length + s('duurder', /KPN/).length === 1, sig);
toets('signalen: PayPal twee keer 4,99 = dubbel, met vraagteken', s('dubbel', /4,99/).length === 1 && /\?$/.test(s('dubbel', /4,99/)[0].zin), sig);
toets('signalen: weggevallen reeks (Krant) = navragen', s('weg', /Krant/).length === 1 && /^Navragen/.test(s('weg', /Krant/)[0].zin), sig);
toets('signalen: Netflix op twee eigen rekeningen = dubbel; Buckaroo (betaaldienst) niet', s('dubbel', /streaming|Netflix/i).length === 1 && !sig.some((x) => x.soort === 'dubbel' && /Buckaroo/i.test(x.zin)), sig);
toets('signalen: dubbel zonder linkregel noemt de aanbieder bij naam (wv1957), niet alleen de categorie', s('dubbel', /Netflix/).length === 1 && /^Netflix/.test(s('dubbel', /Netflix/)[0].titel), s('dubbel', /Netflix|streaming/i));
toets('signalen: Tibber wisselend zonder heel vergelijkingsjaar geen "duurder"', !sig.some((x) => /Tibber/.test(x.titel) && x.soort === 'duurder'), sig);
toets('signalen: energie dezelfde maanden vorig jaar, met de richting', s('energie', /Energie/).length === 1 && /een jaar eerder .*\(\+7%\)/.test(s('energie', /Energie/)[0].zin), sig.filter((x) => x.soort === 'energie'));
toets('signalen: eerst fout, dan wacht, dan info', sig.every((x, i) => i === 0 || ({ fout: 0, wacht: 1, info: 2 })[sig[i - 1].toon] <= ({ fout: 0, wacht: 1, info: 2 })[x.toon]), sig.map((x) => x.toon));
toets('signalen: elk met één zin en een toon', sig.length > 0 && sig.every((x) => x.zin.length > 10 && x.zin.length <= 240 && ['info', 'wacht', 'fout'].indexOf(x.toon) >= 0), sig);
const v = uit.verloop;
toets('verloop: 24 maanden, lopende maand gemarkeerd, onvolledig vóór de koppeling van de ABN-rekening (bunq telt niet)', v.maanden.length === 24 && v.maanden[23].lopend === true && v.maanden[23].volledig === false &&
  v.volledig_vanaf === mnd[0] && v.maanden.filter((m) => m.volledig).every((m) => m.maand >= v.volledig_vanaf) && v.maanden[22].volledig === true, v.maanden.map((m) => [m.maand, m.volledig]));
toets('verloop: categorieën per maand, gesorteerd op totaal', v.categorieen.length > 0 && v.maanden.some((m) => Object.keys(m.categorieen).length > 0), v.categorieen);
const st = uit.stroom.vorige_maand;
toets('stroom: externe rekening met zijn naam en extern: true (wv1957), eigen rekeningen met hun naam', st && st.paren.some((x) => x.naar === 'Rekening Petronella Ontvanger' && x.extern === true) && !st.paren.some((x) => x.naar === 'extern') && st.paren.some((x) => x.naar === 'Spaar'), st);
// de briefing gaat via de n8n-tabel ochtend_buffer en Voor jou-kaarten (niet alleen naar de App): oude regel blijft (wv1957)
{ const bF = F.briefing(A, a, { vault: VAULT }), dF = bF.signalen.filter((x) => x.soort === 'dubbel' && /streaming/i.test(x.zin));
  toets('briefing: dubbel zonder linkregel blijft de categorie, externe rekening en steun niet bij naam', dF.length === 1 && !/Netflix|Petronella/.test(JSON.stringify(bF)), bF.signalen); }
toets('buffer: drie volledige maanden, lopende maand apart', uit.buffer && uit.buffer.per_maand.length === 3 && uit.buffer.per_maand[2].maand === F.maandPlus(mNu, -1) && uit.buffer.lopend.maand === mNu, uit.buffer);
toets('deze maand: in en uit als positieve getallen', uit.deze_maand.uit >= 0 && uit.deze_maand.in >= 0 && uit.deze_maand.maand === mNu, uit.deze_maand);

// ── koppeling midden in de maand (zoals de echte ABN-koppeling op 30-4): die maand is onvolledig ──
{
  const BD2 = path.join(W, 'bank2'), a2 = A.open(BD2);
  A.rekeningenSync(a2, { vl: REK.vl });
  A.bij(a2, 'vl', VL.filter((x) => x.datum >= dg(mnd[0], 15)).map((x) => Object.assign({}, x, { id: 'b2' + x.id })), {});
  const u = F.bereken(A, a2, { vault: VAULT });
  toets('volledigheid: eerste post op de 15e → die maand onvolledig, de volgende volledig', u.verloop.volledig_vanaf === mnd[1], u.verloop.volledig_vanaf);
  a2.db.close();
}
// ── Bewust dempt een signaal ──
fs.writeFileSync(LP, linkPagina('', '| paypal | dubbel | 22-10-2026 | "die twee zijn bewust" — David 22-10-2026 |\n| krant | * | 22-10-2026 | |\n'));
const uit2 = F.bereken(A, a, { vault: VAULT });
toets('bewust: PayPal-dubbel gedempt; rij zonder woord van David dempt niets (Krant blijft)', !uit2.signalen.some((x) => x.soort === 'dubbel' && /PayPal/.test(x.titel)) && uit2.signalen.some((x) => x.soort === 'weg' && /Krant/.test(x.titel)), uit2.signalen);

// ── een kapot blok maakt alleen dat blok leeg ──
{
  const B = Object.assign({}, A, { stroom: () => { throw new Error('tegenpartij Jan Jansen kapot'); } });
  const u3 = F.bereken(B, a, { vault: VAULT });
  toets('kapot blok: alleen stroom en buffer leeg, rest gevuld, foutnaam zonder inhoud', u3.fouten.indexOf('stroom') >= 0 && u3.buffer === null && u3.vaste_lasten && u3.verloop && !/Jan Jansen/.test(JSON.stringify(Object.assign({}, u3, { overzicht: undefined }))), u3.fouten);
}

// ── wv2258: saldi per rekening (de bewaarde stand, geen bankopvraag) ──
{
  const BD3 = path.join(W, 'bank3'), a3 = A.open(BD3);
  const R3 = {
    vl: { uid: 'u1', bank: 'ABN AMRO', label: 'Vaste lasten', naam: 'D VOORBEELD CJ', iban: 'NL00ABNA0123456789', sessie: 's1' },
    pt: { uid: 'u2', bank: 'ABN AMRO', label: 'POT', naam: 'D VOORBEELD', iban: 'NL66ABNA0987654321', sessie: 's1' },
    hr: { bron: 'bunq', uid: 'bunq-1', bunq_id: 1, naam: 'Hoofdrekening', soort: 'lopend', iban: 'NL11BUNQ0000001111', status: 'ACTIVE' },
    k1: { bron: 'bunq', uid: 'bunq-2', bunq_id: 2, naam: 'Kleedgeld', soort: 'lopend', iban: 'NL11BUNQ0000002222', status: 'ACTIVE' },
    k2: { bron: 'bunq', uid: 'bunq-3', bunq_id: 3, naam: 'Kleedgeld', soort: 'lopend', iban: 'NL11BUNQ0000003333', status: 'ACTIVE' },
    ki: { bron: 'bunq', uid: 'bunq-4', bunq_id: 4, naam: 'Kids sparen', soort: 'spaar', iban: 'NL11BUNQ0000004444', status: 'ACTIVE' },
    ex: { bron: 'bunq', uid: 'bunq-5', bunq_id: 5, naam: 'Rekening Petronella', soort: 'lopend', iban: 'NL11BUNQ0000005555', status: 'ACTIVE' },
    gh: { bron: 'bunq', uid: 'bunq-6', bunq_id: 6, naam: 'Gambia Noodfonds', soort: 'spaar', iban: 'NL11BUNQ0000006666', status: 'ACTIVE' },
    dicht: { bron: 'bunq', uid: 'bunq-7', bunq_id: 7, naam: 'Oude vakantie', soort: 'spaar', iban: 'NL11BUNQ0000007777', status: 'CANCELLED' },
    leeg: { bron: 'bunq', uid: 'bunq-8', bunq_id: 8, naam: 'Nog zonder stand', soort: 'spaar', iban: 'NL11BUNQ0000008888', status: 'ACTIVE' },
  };
  A.zakelijkZet(a3, { 'NL66ABNA0987654321': 'POT' });
  A.rekeningenSync(a3, R3);
  A.corrigeer(a3, { rek: 'ex', eigenaar: 'extern' });
  const op = '2026-11-02T06:00:41.249Z', sj = (geboekt, besch, val) => JSON.stringify({ geboekt: geboekt, beschikbaar: besch, valuta: val || 'EUR', peildatum: op });
  const rijen = [['vl', sj(2500.5, 2400)], ['pt', sj(12000, 12000)], ['hr', sj(1234.56, null)], ['k1', sj(10, 10)], ['k2', sj(20, 20)], ['ki', sj(300, null)],
    ['ex', sj(77, null)], ['gh', sj(450, null)], ['dicht', sj(999, null)]].map((x) => ({ rek: x[0], json: x[1], opgehaald: op }));
  rijen.push({ rek: 'kapot', json: '{niet', opgehaald: op });
  const S = F.blokSaldi(a3, rijen), t3 = JSON.stringify(S), naam = (n) => S.rekeningen.filter((x) => x.naam === n);
  toets('saldi: alle open rekeningen met een stand, gesloten niet, zonder stand geteld; POT apart', S.rekeningen.length === 7 && !/Oude vakantie|999/.test(t3) && S.zonder_stand === 1 &&
    S.pot.length === 1 && S.pot[0].naam === 'POT' && S.pot[0].groep === 'pot' && !S.rekeningen.some((x) => x.groep === 'pot'), S);
  toets('saldi: groepen uit de eigenaar (eigen, kind, samen+gezamenlijk, Gambia-hulp, extern) in die volgorde (wv2292: Davids volgorde)', naam('Vaste lasten')[0].groep === 'samen' && naam('Vaste lasten')[0].gezamenlijk === true &&
    naam('Hoofdrekening')[0].groep === 'eigen' && naam('Kids sparen')[0].groep === 'kind' && naam('Gambia Noodfonds')[0].groep === 'gambia' && naam('Rekening Petronella')[0].groep === 'extern' &&
    JSON.stringify(S.rekeningen.map((x) => x.groep)) === JSON.stringify(['eigen', 'eigen', 'eigen', 'kind', 'samen', 'gambia', 'extern']), S.rekeningen.map((x) => [x.naam, x.groep]));
  toets('saldi: bedrag, valuta, stand van; beschikbaar alleen als het afwijkt', naam('Vaste lasten')[0].saldo === 2500.5 && naam('Vaste lasten')[0].beschikbaar === 2400 && naam('Hoofdrekening')[0].beschikbaar === undefined &&
    naam('Kleedgeld')[0].beschikbaar === undefined && S.rekeningen.every((x) => x.valuta === 'EUR' && x.stand_van === op) && naam('Vaste lasten')[0].bank === 'ABN AMRO' && naam('Hoofdrekening')[0].bank === 'bunq', S.rekeningen);
  toets('saldi: geen IBAN; laatste vier cijfers alleen bij twee rekeningen met dezelfde naam', !/NL\d{2}[A-Z]{4}\d{6,}/.test(t3) && naam('Kleedgeld').map((x) => x.eind).join() === '2222,3333' &&
    S.rekeningen.filter((x) => x.naam !== 'Kleedgeld').every((x) => x.eind === undefined) && !/_eind|iban|"rek"/.test(t3), S.rekeningen);
  const leegS = F.blokSaldi(a3, []);
  toets('saldi: zonder bewaarde standen een lege lijst en het aantal zonder stand', leegS.rekeningen.length === 0 && leegS.pot.length === 0 && leegS.zonder_stand === 9, leegS);
  const u5 = F.bereken(A, a3, { vault: VAULT, saldi: rijen }), u6 = F.bereken(A, a3, { vault: VAULT });
  toets('saldi: in bereken alleen met de standen van bank-lezer (zonder: null, geen fout)', u5.saldi && u5.saldi.rekeningen.length === 7 && u6.saldi === null && u6.fouten.indexOf('saldi') < 0, [u5.saldi, u6.fouten]);
  // ── wv2292: eigen naam, van wie en labels (Bewerk in Saldi) ──
  const id = (n) => S.rekeningen.concat(S.pot).find((x) => x.naam === n).id;
  toets('wv2292: elke rekening een kenmerk van 16 hextekens (niet de rek-sleutel), POT ook', S.rekeningen.concat(S.pot).every((x) => /^[a-f0-9]{16}$/.test(x.id)) &&
    new Set(S.rekeningen.map((x) => x.id)).size === 7 && A.rekVanId(a3, id('Hoofdrekening')) === 'hr' && A.rekVanId(a3, 'hr') === null && A.rekVanId(a3, '0'.repeat(16)) === null, S.rekeningen.map((x) => x.id));
  toets('wv2292: keuzes zonder gezinsleden: David, Cynthia, gedeeld, Gambia-hulp, extern', JSON.stringify(S.van_wie_keuzes.map((k) => k.waarde)) === JSON.stringify(['David', 'Cynthia', 'gedeeld', 'Gambia-hulp', 'extern']) &&
    S.van_wie_keuzes[2].tekst === 'David en/of Cynthia (gedeeld)' && JSON.stringify(S.labels_in_gebruik) === '[]', S.van_wie_keuzes);
  let fg = null; try { A.vanWieKinderenZet(a3, ['David']); } catch (e) { fg = e.message; }
  toets('wv2292: gezinslijst weigert een vaste keuze als naam', /geen vaste keuze/.test(fg || ''), fg);
  A.vanWieKinderenZet(a3, ['Pien', 'Bram', 'pien', 'Kees']);
  toets('wv2292: gezinsleden uit meta (zonder dubbel), tussen Cynthia en gedeeld', JSON.stringify(A.vanWieKeuzes(a3).map((k) => k[0] + '>' + k[1])) ===
    JSON.stringify(['David>David', 'Cynthia>Cynthia', 'Pien>kind', 'Bram>kind', 'Kees>kind', 'gedeeld>samen', 'Gambia-hulp>Gambia-hulp', 'extern>extern']), A.vanWieKeuzes(a3));
  // posten op de kinderrekening, om de indeling na de keuze te toetsen
  A.bij(a3, 'ki', [p('ki:1', '2026-10-10', -12.5, 'Speelgoedwinkel Proef', 'cadeau'), p('ki:2', '2026-10-12', 20, 'Opa Proef', 'zakgeld')], {});
  const maandVoor = A.maand(a3, { maand: '2026-10', eigenaar: 'kind' });
  const w1 = A.rekeningWeergave(a3, { rek: 'ki', naam: 'Spaarpot  Bram', van_wie: 'Bram', labels: ['Weekend 2026', 'weekend 2026', 'Sparen'] });
  const rk = a3.db.prepare("SELECT eigenaar, eigenaar_herkomst, weergavenaam, van_wie, labels FROM rekeningen WHERE rek = 'ki'").get();
  toets('wv2292: kind kiezen = eigenaar blijft kind (herkomst david), naam en labels (zonder dubbel) bewaard', w1.ok && rk.eigenaar === 'kind' && rk.eigenaar_herkomst === 'david' && rk.weergavenaam === 'Spaarpot Bram' &&
    rk.van_wie === 'Bram' && rk.labels === JSON.stringify(['Weekend 2026', 'Sparen']) && w1.posten_bijgewerkt === 0, [w1, rk]);
  const maandNa = A.maand(a3, { maand: '2026-10', eigenaar: 'kind' }), zoekNa = A.zoek(a3, { van: '2026-10-01', tot: '2026-10-31', eigenaar: 'kind' });
  toets('wv2292: maand en zoek met eigenaar=kind ongewijzigd na de keuze voor een gezinslid', maandVoor.posten === 2 && maandNa.posten === 2 && maandNa.totaal_uit === maandVoor.totaal_uit &&
    (zoekNa.posten || zoekNa.transacties || []).length === 2, [maandVoor.posten, maandNa.posten, Object.keys(zoekNa)]);
  const S2 = F.blokSaldi(a3, rijen), t4 = JSON.stringify(S2), r2 = S2.rekeningen.find((x) => x.id === id('Kids sparen'));
  toets('wv2292: Saldi toont de eigen naam, de banknaam klein, de groep persoon:Bram en de labels', r2 && r2.naam === 'Spaarpot Bram' && r2.banknaam === 'Kids sparen' && r2.groep === 'persoon:Bram' &&
    r2.van_wie === 'Bram' && JSON.stringify(r2.labels) === JSON.stringify(['Weekend 2026', 'Sparen']) && !/"rek"|iban/i.test(t4), r2);
  toets('wv2292: groepen in Davids volgorde met titel; labels in gebruik als suggestie', JSON.stringify(S2.groepen.map((g) => g.sleutel)) === JSON.stringify(['eigen', 'persoon:Bram', 'samen', 'gambia', 'extern']) &&
    S2.groepen[0].titel === 'David' && S2.groepen[1].titel === 'Bram' && S2.groepen[2].titel === 'David en/of Cynthia (gedeeld)' && JSON.stringify(S2.labels_in_gebruik) === JSON.stringify(['Sparen', 'Weekend 2026']), S2.groepen);
  // gedeeld, Cynthia en extern zetten de eigenaar; terug naar David werkt; de indeling volgt
  const w2 = A.rekeningWeergave(a3, { rek: 'k2', van_wie: 'gedeeld' }), e2 = a3.db.prepare("SELECT eigenaar FROM rekeningen WHERE rek = 'k2'").get().eigenaar;
  const w3 = A.rekeningWeergave(a3, { rek: 'k1', van_wie: 'Cynthia' }), e3 = a3.db.prepare("SELECT eigenaar FROM rekeningen WHERE rek = 'k1'").get().eigenaar;
  toets('wv2292: gedeeld → samen, Cynthia → Cynthia (herkomst david); Saldi groepeert zo', e2 === 'samen' && e3 === 'Cynthia' &&
    F.blokSaldi(a3, rijen).rekeningen.filter((x) => x.naam === 'Kleedgeld').map((x) => x.groep).sort().join() === 'cynthia,samen', [w2, w3, e2, e3]);
  // een kinderrekening zonder keuze met een gezinslid in de banknaam: voorstel
  a3.db.prepare("UPDATE rekeningen SET naam = 'Kees sparen' WHERE rek = 'gh'").run();
  A.corrigeer(a3, { rek: 'gh', eigenaar: 'kind' });
  const r5 = F.blokSaldi(a3, rijen).rekeningen.find((x) => x.naam === 'Kees sparen');
  toets('wv2292: kind zonder keuze = groep kind met een voorstel uit de banknaam (los woord)', r5 && r5.groep === 'kind' && r5.voorstel === 'Kees' && r5.van_wie === undefined, r5);
  // corrigeer rekening=… eigenaar=… laat een niet-passende van wie vervallen, een passende staan
  A.rekeningWeergave(a3, { rek: 'gh', van_wie: 'Kees' });
  A.corrigeer(a3, { rek: 'gh', eigenaar: 'kind' });
  const vw1 = a3.db.prepare("SELECT van_wie FROM rekeningen WHERE rek = 'gh'").get().van_wie;
  A.corrigeer(a3, { rek: 'gh', eigenaar: 'Gambia-hulp' });
  const vw2 = a3.db.prepare("SELECT van_wie FROM rekeningen WHERE rek = 'gh'").get().van_wie;
  toets('wv2292: corrigeer eigenaar laat een passende van wie staan en wist een niet-passende', vw1 === 'Kees' && vw2 === null, [vw1, vw2]);
  // machinekamer kan Davids keuze niet overschrijven
  let fm = null; try { A.corrigeer(a3, { rek: 'ki', eigenaar: 'David', door: 'machinekamer' }); } catch (e) { fm = e.message; }
  toets('wv2292: een keuze in Saldi is van David; machinekamer kan de eigenaar niet overschrijven', /door David gezet/.test(fm || ''), fm);
  // weigeringen
  const fout = (o) => { try { A.rekeningWeergave(a3, o); return null; } catch (e) { return e.message; } };
  const f1 = fout({ rek: 'pt', van_wie: 'David' }), f2 = fout({ rek: 'hr', van_wie: 'Onbekend' }), f3 = fout({ rek: 'hr', naam: '<script>' }), f4 = fout({ rek: 'hr', labels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }),
    f5 = fout({ rek: 'hr', labels: ['x'.repeat(31)] }), f6 = fout({ rek: 'hr' }), f7 = fout({ rek: 'bestaatniet', naam: 'x' }), f8 = fout({ rek: 'hr', naam: 'x'.repeat(41) });
  toets('wv2292: weigert van wie op de POT-rekening, onbekende keuze, rare tekens, > 8 labels, label > 30, niets, onbekende rekening, naam > 40',
    /POT-rekening/.test(f1 || '') && /van wie:/.test(f2 || '') && /naam:/.test(f3 || '') && /hooguit 8/.test(f4 || '') && /label:/.test(f5 || '') && /niets te wijzigen/.test(f6 || '') && /niet in het archief/.test(f7 || '') && /naam:/.test(f8 || ''), [f1, f2, f3, f4, f5, f6, f7, f8]);
  const wp = A.rekeningWeergave(a3, { rek: 'pt', naam: 'POT salarissen', labels: ['Zakelijk'] }), pp = F.blokSaldi(a3, rijen).pot[0];
  toets('wv2292: POT-rekening: naam en labels wel, eigenaar blijft POT, staat in het POT-paneel', wp.eigenaar === 'POT' && pp.naam === 'POT salarissen' && pp.banknaam === 'POT' && pp.groep === 'pot' && pp.van_wie === undefined, [wp, pp]);
  const w9 = A.rekeningWeergave(a3, { rek: 'ki', naam: '', labels: [] }), r9 = F.blokSaldi(a3, rijen).rekeningen.find((x) => x.id === id('Kids sparen'));
  toets('wv2292: lege naam en lege labels wissen; van wie blijft', w9.naam === null && JSON.stringify(w9.labels) === '[]' && r9.naam === 'Kids sparen' && r9.banknaam === undefined && r9.labels === undefined && r9.groep === 'persoon:Bram', r9);
  // de bank-synchronisatie raakt de nieuwe velden en Davids eigenaar niet
  A.rekeningenSync(a3, R3);
  const na = a3.db.prepare("SELECT eigenaar, van_wie FROM rekeningen WHERE rek = 'k1'").get();
  toets('wv2292: rekeningenSync laat van wie en Davids eigenaar staan', na.eigenaar === 'Cynthia' && na.van_wie === 'Cynthia', na);
  // extern kiezen: de rekening telt niet meer mee (bestaande afscheiding), terug naar David: wel
  const voorExt = A.maand(a3, { maand: '2026-10' }).posten;
  A.rekeningWeergave(a3, { rek: 'ki', van_wie: 'extern' });
  const metExt = A.maand(a3, { maand: '2026-10' }).posten;
  A.rekeningWeergave(a3, { rek: 'ki', van_wie: 'Bram' });
  toets('wv2292: extern kiezen scheidt de rekening af zoals corrigeer; terug naar een gezinslid telt weer mee', voorExt === 2 && metExt === 0 && A.maand(a3, { maand: '2026-10' }).posten === 2 &&
    a3.db.prepare("SELECT eigenaar FROM rekeningen WHERE rek = 'ki'").get().eigenaar === 'kind', [voorExt, metExt]);
  a3.db.close();
}

// ── via bank-lezer.js (zoals de pod het aanroept): lokaal, zonder kluis ──
{
  // wv2258: bewaarde standen in cache.sqlite (tabel saldo, zoals bank-lezer.js die vult)
  { const { DatabaseSync } = require('node:sqlite'), c = new DatabaseSync(path.join(BD, 'cache.sqlite'));
    c.exec('CREATE TABLE IF NOT EXISTS saldo (rek TEXT PRIMARY KEY, json TEXT, opgehaald TEXT)');
    const z = c.prepare('INSERT OR REPLACE INTO saldo (rek, json, opgehaald) VALUES (?, ?, ?)');
    z.run('pr', JSON.stringify({ geboekt: 4321, beschikbaar: null, valuta: 'EUR', peildatum: null }), '2026-11-02T06:00:00.000Z');
    z.run('el', JSON.stringify({ geboekt: 55, beschikbaar: null, valuta: 'EUR', peildatum: null }), '2026-11-02T06:00:00.000Z');
    c.close(); }
  a.db.close();
  const r = spawnSync(process.execPath, ['--no-warnings', '--require', './test/vaste-klok.cjs', 'bank-lezer.js', 'app-financien'], { input: '{}', env: { PATH: process.env.PATH, BANK_DIR: BD, VAULT_DIR: VAULT, TZ: 'Europe/Amsterdam', TOETS_KLOK_DELTA: process.env.TOETS_KLOK_DELTA || '' }, encoding: 'utf8', timeout: 60000 });
  let j = null; try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch (e) {}
  toets('bank-lezer app-financien: ok, zonder kluissleutels, zelfde vorm', r.status === 0 && j && j.ok === true && j.vaste_lasten && Array.isArray(j.signalen) && j.paypal && j.paypal.actief === 0, [r.status, String(r.stderr).slice(0, 300), j && Object.keys(j)]);
  toets('bank-lezer app-financien: blok saldi uit de bewaarde standen (Privé eigen, de externe rekening gemarkeerd)', j && j.saldi && j.saldi.rekeningen.length === 2 &&
    j.saldi.rekeningen.some((x) => x.naam === 'Privé' && x.saldo === 4321 && x.groep === 'eigen') && j.saldi.rekeningen.some((x) => x.groep === 'extern' && x.saldo === 55) && j.saldi.zonder_stand === 2, j && j.saldi);
  toets('server.js: GET /app/financien geeft het blok saldi door', /'gambia', 'saldi'(, 'overzicht')?\]\.forEach\(function \(k\) \{ d\[k\]/.test(fs.readFileSync('server.js', 'utf8')), null);
  // wv2292: app-rekening (Bewerk in Saldi) en gezin via de CLI, zoals de pod het aanroept
  const kind = (op, inv) => { const q = spawnSync(process.execPath, ['--no-warnings', 'bank-lezer.js', op], { input: JSON.stringify(inv), env: { PATH: process.env.PATH, BANK_DIR: BD, TZ: 'Europe/Amsterdam' }, encoding: 'utf8', timeout: 60000 });
    try { return JSON.parse(String(q.stdout).trim().split('\n').pop()); } catch (e) { return { stdout: String(q.stdout).slice(0, 200), stderr: String(q.stderr).slice(0, 200) }; } };
  const pid = j && j.saldi && (j.saldi.rekeningen.find((x) => x.naam === 'Privé') || {}).id;
  const g0 = kind('gezin', { kinderen: ['Pien', 'Bram'] }), g1 = kind('gezin', {});
  const k1 = kind('app-rekening', { rekening: { id: pid, naam: 'Dagelijks', van_wie: 'Pien', labels: ['Proeflabel'] } });
  const k2 = kind('app-rekening', { rekening: { id: 'f'.repeat(16), naam: 'x' } }), k3 = kind('app-rekening', { rekening: { id: pid, van_wie: 'Onbekend' } }), k4 = kind('app-rekening', {});
  const j2 = kind('app-financien', {}), r2b = j2 && j2.saldi && j2.saldi.rekeningen.find((x) => x.id === pid);
  toets('bank-lezer gezin + app-rekening: bewaart naam, van wie en label; app-financien toont ze; weigert onbekend kenmerk, keuze en lege invoer', g0.ok && g0.kinderen === 2 && g1.kinderen === 2 &&
    k1.ok === true && k1.naam === 'Dagelijks' && k1.van_wie === 'Pien' && k1.eigenaar === 'kind' && k2.ok === false && /onbekende rekening/.test(k2.fout) && k3.ok === false && /van wie/.test(k3.fout) && k4.ok === false &&
    r2b && r2b.naam === 'Dagelijks' && r2b.banknaam === 'Privé' && r2b.groep === 'persoon:Pien' && JSON.stringify(j2.saldi.labels_in_gebruik) === '["Proeflabel"]' &&
    j2.saldi.van_wie_keuzes.map((x) => x.waarde).join() === 'David,Cynthia,Pien,Bram,gedeeld,Gambia-hulp,extern', [g0, k1, k2, k3, k4, r2b]);
  const srv = fs.readFileSync('server.js', 'utf8');
  toets('wv2292 server.js: app-rekening in BANK_LOKAAL, niet in BANK_OPDRACHTEN; gezin nergens (alleen CLI); route POST /app/financien/rekening', /const BANK_LOKAAL = \[[^\]]*'app-rekening'/.test(srv) &&
    !/const BANK_OPDRACHTEN = \[[^\]]*'app-rekening'/.test(srv) && !/'gezin'/.test(srv.slice(srv.indexOf('const BANK_OPDRACHTEN'), srv.indexOf('const BANK_TERUG_PER_UUR'))) &&
    /route === 'POST \/app\/financien\/rekening'\) return appFinRekening\(/.test(srv), null);
  toets('server.js: app-financien in BANK_LOKAAL (geen kluis), niet in BANK_OPDRACHTEN (/smal/bank)', /const BANK_LOKAAL = \[[^\]]*'app-financien'/.test(srv) && !/const BANK_OPDRACHTEN = \[[^\]]*'app-financien'/.test(srv), null);
  const src = fs.readFileSync('financien-app.js', 'utf8').replace(/^\s*(\*|\/\/).*$/gm, '');
  toets('financien-app.js laadt geen netwerk- of procesmodule en schrijft niets', !/require\(['"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads)['"]\)/.test(src) && !/\bfetch\s*\(/.test(src) && !/writeFile|appendFile|unlink|INSERT|UPDATE|DELETE/.test(src), null);
}
if (!process.env.HOUD) fs.rmSync(W, { recursive: true, force: true }); else console.log(W);
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
