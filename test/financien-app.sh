#!/usr/bin/env bash
# Toetst financien-app.js (wv771, App Financiën; bouwplan idee 16 § 11) op een nagebootste transactiedatabase (zelfde soort posten als
# test/bank-archief.sh, maar met maanden tot en met vandaag): het antwoord is veld voor veld opgebouwd (geen IBAN, machtiging,
# omschrijving, naam van een persoon of van de externe rekening, geen tabel_md of let_op), steun heet "Steun (vast)", een externe
# rekening "extern"; signalen alleen gemeten (hypotheek dalend nooit "weg"/"lager", naamwissel gemeente geen "nieuw"/"weg", prijsstap
# meerdere reeksen, PayPal twee keer hetzelfde bedrag = dubbel, weggevallen reeks = navragen, energie dezelfde maanden vorig jaar);
# volledigheid vanaf de koppeling (bunq telt niet); opzeglinks alleen met host uit de allowlist in de code, https, zonder userinfo of
# poort, precies één herkenwoord op woordgrens; Bewust-tabel dempt; een kapot blok maakt alleen dat blok leeg; via bank-lezer.js.
# Raakt de pod, de kluis, de bank, de vault en /opt/data/bank niet. Gebruik: bash test/financien-app.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
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
  EL.push(p('el:' + ym, dg(ym, 20), 350, 'D SCHAAP CJ', 'Geld', { tegen_iban: IV.vl }));
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
const tekst = JSON.stringify(uit);
toets('bereken: geen kapot blok', Array.isArray(uit.fouten) && uit.fouten.length === 0, uit.fouten);
toets('privacy: geen IBAN, machtiging of incassant-ID in het antwoord', !/NL\d{2}[A-Z]{4}\d{6,}/.test(tekst) && !/Machtiging|Incassant|ZZZ999|43562|ST 1110/.test(tekst), tekst.match(/NL\d{2}[A-Z]{4}\d+|Machtiging|43562/));
toets('privacy: geen omschrijving, geen persoon, geen naam van de externe rekening', !/Jan Jansen|huur|vaste storting|Periodieke|SCHAAP CJ|Petronella|Albert Heijn|sparen/.test(tekst), tekst.match(/Jan Jansen|Petronella|SCHAAP CJ|Albert Heijn/));
toets('privacy: geen tabel_md, let_op of losse saldo-velden buiten de dekking', !/tabel_md|let_op|saldo_na/.test(tekst), null);
const sleutels = (o, pad, acc) => { if (o && typeof o === 'object') Object.keys(o).forEach((k) => { acc.add(k); sleutels(o[k], k, acc); }); return acc; };
const ks = sleutels(uit, '', new Set());
toets('privacy: geen veld nr, sleutel(s), iban, omschrijving of tegenpartij', !['nr', 'sleutel', 'sleutels', 'iban', 'omschrijving', 'tegenpartij', 'rek', 'machtiging'].some((k) => ks.has(k)), Array.from(ks));
const vl = uit.vaste_lasten;
toets('vaste lasten: rekening, totaal en rijen; steun als "Steun (vast)"', vl && vl.posten > 4 && vl.totaal_per_maand > 3000 && vl.steun.length === 1 && vl.steun[0].naam === 'Steun (vast)' && vl.steun[0].per_maand === 350, vl && { posten: vl.posten, steun: vl.steun });
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
toets('signalen: dubbel zonder linkregel toont de categorie, niet de naam van de aanbieder', s('dubbel', /streaming/i).length === 1 && !/Netflix/.test(s('dubbel', /streaming/i)[0].zin), s('dubbel', /streaming/i));
toets('signalen: Tibber wisselend zonder heel vergelijkingsjaar geen "duurder"', !sig.some((x) => /Tibber/.test(x.titel) && x.soort === 'duurder'), sig);
toets('signalen: elk met één zin en een toon', sig.length > 0 && sig.every((x) => x.zin.length > 10 && x.zin.length <= 240 && ['info', 'wacht', 'fout'].indexOf(x.toon) >= 0), sig);
const v = uit.verloop;
toets('verloop: 24 maanden, lopende maand gemarkeerd, onvolledig vóór de koppeling van de ABN-rekening (bunq telt niet)', v.maanden.length === 24 && v.maanden[23].lopend === true && v.maanden[23].volledig === false &&
  v.volledig_vanaf === mnd[0] && v.maanden.filter((m) => m.volledig).every((m) => m.maand >= v.volledig_vanaf) && v.maanden[22].volledig === true, v.maanden.map((m) => [m.maand, m.volledig]));
toets('verloop: categorieën per maand, gesorteerd op totaal', v.categorieen.length > 0 && v.maanden.some((m) => Object.keys(m.categorieen).length > 0), v.categorieen);
const st = uit.stroom.vorige_maand;
toets('stroom: externe rekening heet "extern", eigen rekeningen met hun naam', st && st.paren.some((x) => x.naar === 'extern' && x.extern === true) && st.paren.some((x) => x.naar === 'Spaar'), st);
toets('buffer: drie volledige maanden, lopende maand apart', uit.buffer && uit.buffer.per_maand.length === 3 && uit.buffer.per_maand[2].maand === F.maandPlus(mNu, -1) && uit.buffer.lopend.maand === mNu, uit.buffer);
toets('deze maand: in en uit als positieve getallen', uit.deze_maand.uit >= 0 && uit.deze_maand.in >= 0 && uit.deze_maand.maand === mNu, uit.deze_maand);

// ── Bewust dempt een signaal ──
fs.writeFileSync(LP, linkPagina('', '| paypal | dubbel | 22-10-2026 | "die twee zijn bewust" — David 22-10-2026 |\n| krant | * | 22-10-2026 | |\n'));
const uit2 = F.bereken(A, a, { vault: VAULT });
toets('bewust: PayPal-dubbel gedempt; rij zonder woord van David dempt niets (Krant blijft)', !uit2.signalen.some((x) => x.soort === 'dubbel' && /PayPal/.test(x.titel)) && uit2.signalen.some((x) => x.soort === 'weg' && /Krant/.test(x.titel)), uit2.signalen);

// ── een kapot blok maakt alleen dat blok leeg ──
{
  const B = Object.assign({}, A, { stroom: () => { throw new Error('tegenpartij Jan Jansen kapot'); } });
  const u3 = F.bereken(B, a, { vault: VAULT });
  toets('kapot blok: alleen stroom en buffer leeg, rest gevuld, foutnaam zonder inhoud', u3.fouten.indexOf('stroom') >= 0 && u3.buffer === null && u3.vaste_lasten && u3.verloop && !/Jan Jansen/.test(JSON.stringify(u3)), u3.fouten);
}

// ── via bank-lezer.js (zoals de pod het aanroept): lokaal, zonder kluis ──
{
  a.db.close();
  const r = spawnSync(process.execPath, ['--no-warnings', 'bank-lezer.js', 'app-financien'], { input: '{}', env: { PATH: process.env.PATH, BANK_DIR: BD, VAULT_DIR: VAULT, TZ: 'Europe/Amsterdam' }, encoding: 'utf8', timeout: 60000 });
  let j = null; try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch (e) {}
  toets('bank-lezer app-financien: ok, zonder kluissleutels, zelfde vorm', r.status === 0 && j && j.ok === true && j.vaste_lasten && Array.isArray(j.signalen) && j.paypal && j.paypal.actief === 0, [r.status, String(r.stderr).slice(0, 300), j && Object.keys(j)]);
  const srv = fs.readFileSync('server.js', 'utf8');
  toets('server.js: app-financien in BANK_LOKAAL (geen kluis), niet in BANK_OPDRACHTEN (/smal/bank)', /const BANK_LOKAAL = \[[^\]]*'app-financien'/.test(srv) && !/const BANK_OPDRACHTEN = \[[^\]]*'app-financien'/.test(srv), null);
  const src = fs.readFileSync('financien-app.js', 'utf8').replace(/^\s*(\*|\/\/).*$/gm, '');
  toets('financien-app.js laadt geen netwerk- of procesmodule en schrijft niets', !/require\(['"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads)['"]\)/.test(src) && !/\bfetch\s*\(/.test(src) && !/writeFile|appendFile|unlink|INSERT|UPDATE|DELETE/.test(src), null);
}
if (!process.env.HOUD) fs.rmSync(W, { recursive: true, force: true }); else console.log(W);
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
