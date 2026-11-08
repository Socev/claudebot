'use strict';
/*
 * ah-bonnen.js — kassabonnen van Albert Heijn, alleen lezen (wv2703, 8-11-2026).
 * WAAROM. David 8-11-2026: "boodschappen (uitsplitsing? Kunnen we lijstjes van AH verzamelen met wat we kopen?)". De bank geeft alleen het
 * bedrag per bezoek; per product kan alleen met de bonnen uit de AH-app. David gaf Ja (8-11 08:00) op koppelen met zijn eigen inlog.
 * Ontwerp: vault 01_Ontwikkeling/OVIS Financiën 8+ (ontwerp 7-11-2026).md § 10 (review Codex GO-MET-WIJZIGINGEN, MOET 1-3 verwerkt).
 *
 * BRON (onofficieel, de backend van de AH-app). OAuth-client "appie": David logt zelf in op login.ah.nl; de terugsprong
 * appie://login-exit?code=… plakt hij in de app; de pod ruilt de code meteen (POST /mobile-auth/v1/auth/token). Daarna ververst de pod
 * zelf (…/token/refresh). Bonnen: GraphQL posReceiptsPage (lijst) en posReceiptDetails (regels). Geen winkel op de bon.
 *
 * NETWERK. Eén fetch, in roep(): alleen POST op api.ah.nl, alleen de drie paden hieronder, GraphQL alleen met de twee vaste queries.
 * redirect: 'error'. Toetsbasis alleen http://127.0.0.1:<poort> (AH_BASIS).
 * GEHEIM. Het refresh token staat in de kluis (deps.kluisLees/kluisZet/kluisLeeg, server.js; naam ah_refresh). Lukt de kluis niet na een
 * rotatie, dan noodkopie <dir>/refresh.nood (600); de volgende ronde zet hem eerst in de kluis. Access token alleen in het geheugen.
 * Geen token, code of bonnummer in een log of antwoord.
 * OPSLAG. <dir> (700): ah.sqlite (600) met bon, regel, korting, betaling; staat.json (generatie, dood, achterstand, laatste ronde).
 * Niet opgeslagen: bonuskaartnummer (memberId), btw, ruwe JSON.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

function basis(v) { if (!v) return 'https://api.ah.nl'; if (/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(v)) return v; throw new Error('toetsbasis alleen op 127.0.0.1'); }
const BASIS = basis(process.env.AH_BASIS);
const PADEN = ['/mobile-auth/v1/auth/token', '/mobile-auth/v1/auth/token/refresh', '/graphql'];
const INLOGLINK = 'https://login.ah.nl/secure/oauth/authorize?client_id=appie&redirect_uri=appie://login-exit&response_type=code';
const KOPPEN = { 'User-Agent': 'Appie/9.28 (Socev; alleen lezen)', 'x-client-name': 'appie-ios', 'x-client-version': '9.28', 'x-application': 'AHWEBSHOP',
  'Content-Type': 'application/json', Accept: 'application/json' };
const Q_LIJST = 'query Lijst($offset: Int!, $limit: Int!) { posReceiptsPage(pagination: {offset: $offset, limit: $limit}) { posReceipts { id dateTime totalAmount { amount } } } }';
const Q_BON = 'query Bon($id: String!) { posReceiptDetails(id: $id) { id products { id name quantity price { amount } amount { amount } } discounts { name type amount { amount } } total { amount } payments { method amount { amount } } } }';
const PAGINA = 50;
const MAX_DETAILS = Number(process.env.AH_MAX_DETAILS) || 400;
const PAUZE_MS = process.env.AH_PAUZE_MS != null ? Number(process.env.AH_PAUZE_MS) : 300;
const MAX_PAGINAS = 200;
const TOKEN_VORM = /^[A-Za-z0-9._~+\/=-]{16,4096}$/;
const ID_VORM = /^[A-Za-z0-9_:.\-]{1,120}$/;

class AhFout extends Error { constructor(reden, uitleg, status) { super(uitleg || reden); this.reden = reden; this.status = status || null; } }
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function slaap(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function r2(n) { return Math.round(n * 100) / 100; }

// ── netwerk ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function roep(pad, body, access) {
  if (PADEN.indexOf(pad) < 0) throw new AhFout('pad', 'AH-pad niet toegestaan');
  if (pad === '/graphql' && body.query !== Q_LIJST && body.query !== Q_BON) throw new AhFout('pad', 'alleen de vaste AH-queries');
  const h = Object.assign({}, KOPPEN);
  if (access) h.Authorization = 'Bearer ' + access;
  let r;
  try { r = await fetch(BASIS + pad, { method: 'POST', headers: h, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new AhFout('net', 'AH niet bereikbaar'); }
  let buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch (e) { /* laat staan */ } }   // gemeten: soms gzip zonder kop
  let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch (e) { j = null; }
  return { status: r.status, j: j };
}
async function tokenRuil(code) {
  const r = await roep(PADEN[0], { clientId: 'appie', code: code });
  return tokenUit(r, 'code');
}
async function tokenVervers(refresh) {
  const r = await roep(PADEN[1], { clientId: 'appie', refreshToken: refresh });
  return tokenUit(r, 'grant');
}
function tokenUit(r, weiger) {
  if (r.status === 400 || r.status === 401 || r.status === 403) throw new AhFout(weiger, weiger === 'code' ? 'code verlopen of al gebruikt' : 'koppeling geweigerd', r.status);
  if (r.status !== 200 || !r.j || typeof r.j.access_token !== 'string' || !TOKEN_VORM.test(r.j.access_token)) throw new AhFout('token', 'AH gaf geen token (HTTP ' + r.status + ')', r.status);
  const refresh = typeof r.j.refresh_token === 'string' && TOKEN_VORM.test(r.j.refresh_token) ? r.j.refresh_token : null;
  return { access: r.j.access_token, refresh: refresh };
}
async function gql(access, query, vars) {
  const r = await roep('/graphql', { query: query, variables: vars }, access);
  if (r.status === 401 || r.status === 403) throw new AhFout('grant', 'AH weigert de sessie', r.status);
  if (r.status !== 200 || !r.j) throw new AhFout('api', 'AH-API gaf HTTP ' + r.status, r.status);
  if (Array.isArray(r.j.errors) && r.j.errors.length && !r.j.data) throw new AhFout('api', 'AH-API gaf een fout (' + String(r.j.errors[0] && r.j.errors[0].message || '').replace(/[^\w .,:"-]/g, '').slice(0, 80) + ')');
  return r.j.data || {};
}
// De code uit wat David plakt: de hele appie://-link, een consoleregel, of alleen de code.
function codeUit(tekst) {
  const t = String(tekst || '').trim();
  if (!t || t.length > 6000) return null;
  const m = /[?&]code=([A-Za-z0-9._~%-]{8,2000})/.exec(t);
  let c = m ? m[1] : (/^[A-Za-z0-9._~-]{8,2000}$/.test(t) ? t : null);
  if (c && c.indexOf('%') >= 0) { try { c = decodeURIComponent(c); } catch (e) { return null; } }
  return c && /^[A-Za-z0-9._~-]{8,2000}$/.test(c) ? c : null;
}

// ── opslag ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function mapKlaar(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch (e) {} }
function dbOpen(dir, alleenLezen) {
  const { DatabaseSync } = require('node:sqlite');
  const pad = path.join(dir, 'ah.sqlite');
  if (alleenLezen) { if (!fs.existsSync(pad)) return null; return new DatabaseSync(pad, { readOnly: true }); }
  mapKlaar(dir);
  const nieuw = !fs.existsSync(pad);
  if (nieuw) fs.closeSync(fs.openSync(pad, 'a', 0o600));
  const db = new DatabaseSync(pad);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;' +
    'CREATE TABLE IF NOT EXISTS bon (id TEXT PRIMARY KEY, tijd TEXT NOT NULL, totaal REAL, korting REAL, regels INTEGER, opgehaald TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS regel (bon_id TEXT NOT NULL, nr INTEGER NOT NULL, product_id TEXT, naam TEXT NOT NULL, aantal REAL, prijs REAL, bedrag REAL NOT NULL, soort TEXT NOT NULL, PRIMARY KEY (bon_id, nr));' +
    'CREATE TABLE IF NOT EXISTS korting (bon_id TEXT NOT NULL, nr INTEGER NOT NULL, naam TEXT, soort TEXT, bedrag REAL NOT NULL, PRIMARY KEY (bon_id, nr));' +
    'CREATE TABLE IF NOT EXISTS betaling (bon_id TEXT NOT NULL, nr INTEGER NOT NULL, wijze TEXT, bedrag REAL NOT NULL, PRIMARY KEY (bon_id, nr));' +
    'CREATE TABLE IF NOT EXISTS lijst (id TEXT PRIMARY KEY, tijd TEXT NOT NULL, totaal REAL, gezien TEXT NOT NULL);');
  return db;
}
function staatPad(dir) { return path.join(dir, 'staat.json'); }
function staatLees(dir) { try { const j = JSON.parse(fs.readFileSync(staatPad(dir), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
function staatZet(dir, s) { mapKlaar(dir); const p = staatPad(dir), t = p + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(t, p); }
function noodPad(dir) { return path.join(dir, 'refresh.nood'); }
function noodZet(dir, refresh, gen) { mapKlaar(dir); const t = noodPad(dir) + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify({ refresh: refresh, gen: gen, sinds: new Date().toISOString() }), { mode: 0o600 }); fs.renameSync(t, noodPad(dir)); }
function noodLees(dir) { try { const j = JSON.parse(fs.readFileSync(noodPad(dir), 'utf8')); return j && TOKEN_VORM.test(j.refresh || '') ? j : null; } catch (e) { return null; } }
function noodWis(dir) { try { fs.unlinkSync(noodPad(dir)); } catch (e) {} }

// ── productsoort: vaste regels op de bonnaam (afgekort, hoofdletters) ──────────────────────────────────────────────────────
// wv2714 (8-11-2026): gemeten op de echte bonnen (309, aug 2024 – okt 2026): de bonnaam is afgekort tot 12 tekens en vaak een merk
// (OLD AMSTERDM, PAGE TOILET, LAVAZZA), dus de eerste regels lieten 51 % van het bedrag op 'overig'. Merken en afkortingen erbij.
// Alcoholvrij (0.0, NON) eerst naar drinken, vóór de alcoholregel.
const SOORTEN = [
  ['statiegeld en tasjes', /statiegeld|emballage|\bstatieg|\btas(je|sen)?\b|draagtas|\bbag\b|shopper rug/i],
  ['drinken', /\b0[.,]0\b|alcoholvrij|\bnon\b|jever fun/i],
  ['baby', /luier|pampers|babyvoeding|nutrilon|olvarit|\bbaby|knijpzak/i],
  ['verzorging', /tandpasta|tandenbor|tandp\b|shampoo|\bshamp\b|douche|deo|zeep|scheer|maandverband|tampon|bodylotion|creme|crème|zonnebr|wattenst|toiletpap|wc-?pap|tissue|zakdoek|libresse|elvive|\belv\b|oral ?b\b|rexona|\bdove\b|\baxe\b|guhl|nivea|labello|got2b|syoss|\btaft\b|hansaplast|nurofen|paracetamol|neusspray|perla pads|care cream/i],
  ['huishouden', /afwas|vaatwas|wasmiddel|wasverz|schoonmaak|allesreiniger|bleek|vuilniszak|afvalzak|keukenrol|aluminiumf|vershoudf|bakpapier|batterij|lampje|kaars|sponzen|\bdreft\b|\bomo\b|\bpersil\b|\bai[ae]x\b|\bdixan\b|page toilet|\bah papier\b|dettol|mr muscle|glorix|hg reiniger|pedaalzak|vezeldoek/i],
  ['alcohol', /\bbier\b|pils|heineken|hertog|grolsch|amstel\b|brand\b|wijn|\brose\b|rosé|prosecco|cava|champagne|whisk|wodka|vodka|\brum\b|gin\b|likeur|jenever|radler|\bipa\b|weizen|tripel|dubbel\b|bok\b|desperados|flugel|absolut|bull?eit|bullit|settesoli|warsteiner|landerbrau|jever|jopen|peroni|corona|texels|advocaat|grigio|merlot|chardon|sauvign|fantini|piersanti/i],
  ['diepvries', /diepvr|\bdv\b|ijsje|\bijs\b|magnum|ola\b|friet|frites\b|patat|pizza|loempia|kroket|bitterbal|aviko|ben ?& ?jerry|calippo|viennetta|cornett|vrieslollie|\bmora\b|ijsblokjes/i],
  ['vlees, vis en vega', /kip|vlees|gehakt|rund|varken|\bham\b|spek|bacon|worst|salami|\bsalam\b|filet|schnitzel|schnitz|burger|\bburg\b|biefstuk|shoarma|kalkoen|zalm|tonijn|vis\b|garnal|kabeljauw|haring|makreel|vega|tofu|tempeh|falafel|kipstuk|chorizo|rookvlees|frikandel|knaks|\bunox\b|flinterd|sparerib|gourmet|\bgour\b|vivera|\bviv\b|gyros|beyond|valess|drumstick|merguez|steak|prosciut|cervelaat|pancetta|guanciale|jamon|coppa|spian|bifi|biltong|hot dogs|tender fried|nugg|hamburg/i],
  ['zuivel en eieren', /melk|yoghurt|yogh|kwark|vla\b|boter|kaas|room|\bei(e?ren)?\b|eieren|skyr|karnemelk|chocomel|fristi|mozzarella|feta|brie|creme fraiche|zuivel|campina|arla|optimel|danone|alpro|oatly|havermelk|sojamelk|old amst|\boud\b|\bjong bel|belegen|\bbeleg\b|maaslander|milner|parmig|grana padano|paturain|beemster|scharrelei|halvamel|blue band|becel|huttenk|zaanse hoeve|koene ridder|goudse|gouda|apetina|enkhuizer/i],
  ['brood en ontbijt', /brood|bolletj|\bbol\b|bollen\b|stokbrood|croissant|beschuit|cracker|knackebrod|ontbijt|\bontbi\b|muesli|\bmue\b|cruesli|granola|havermout|cornflakes|pindakaas|hagelsl|\bhagel\b|jam\b|stroop|honing|nutella|chocopasta|krentenb|tortilla|wrap|pistolet|afbak|rogge|\bbb\b|naan|pita\b|focaccia|\bl&p\b|tijgerbol|speltbol|kaiser|brioche|\bbun\b|petit stok|desem|wasa\b|oliebol|poffert|venz|vlokken|\bvlok\b|kellogg|flatbr/i],
  ['groente en fruit', /appel|peer|banaan|banan|sinaas|mandarijn|druif|druiven|aardbei|framb|blauwe bes|bessen|kiwi|mango|ananas|meloen|citroen|limoen|avocado|tomaat|tomaten|komkommer|paprika|sla\b|salade|spinazie|broccoli|bloemkool|wortel|ui\b|uien|knoflook|prei|courgette|aubergine|champignon|paddestoel|aardappel|aardap|krieler|krieltjes|boontjes|sperzie|erwt|mais\b|groente|fruit|kruiden|basilicum|basilicu|peterselie|bieslook|gember|radijs|biet|kool\b|andijvie|witlof|rucola|rucol\b|veldsla|bosbes|pruim|nectarine|perzik|abrikoos|granaatap|lychee|cherry|snoepgroente|chiquita|granny|elstar|pompoen|sjalot|haricot|roerbak|rozemarijn|rauwkost|trostom/i],
  ['drinken', /\bcola\b|coca|pepsi|fanta|sprite|7up|ice tea|icetea|lipton|sap\b|jus\b|appelsap|sinaasappelsap|smoothie|limonade|ranja|siroop|\bsir\b|water\b|spa\b|bronwater|sourcy|chaudfontaine|koffie|nespresso|douwe|senseo|thee\b|\btea\b|pickwick|frisdrank|energy|red bull|monster|tonic|ginger|kombucha|redbull|lavazza|karvan|cevit|teisseire|capri ?sun|coolbest|royal club|clipper|rivella|vitamin well|dubbelfris|elektrolyt|amandeldrink/i],
  ['snoep, koek en chips', /chips|lays|lay's|pringles|doritos|nootjes|noten\b|notenmix|notenreep|pinda|borrel|snoep|drop\b|winegum|haribo|chocola|choc\b|tony|milka|verkade|koek|biscuit|\bbisc\b|stroopwafel|speculaas|\bspec\b|gebak|taart|cake\b|cakes\b|muffin|donut|wafel|mentos|kauwgom|popcorn|zoutje|tuc\b|ritz\b|liga\b|sultana|bonbon|paaseitj|pepernot|kruidnot|mikado|sportlife|choco|red velvet|skuumkop|cheetos|nibb|\btrek\b|scrocchi|after eight|cassave|maoam|kinder|chupa|m&m|snickers|lindt|merci\b|knoppers|look o look|delichews|brookie|shortbr|\blu\b|penotti|b-ready|snack a jack|partymix|amandelen|pijnboompit|cashew|eat natur|flikken|tompouce|tiramisu|moelleux|krokantje|kerstkrans|tulband|oliebolt/i],
  ['pasta, rijst en voorraad', /pasta|spaghetti|\bspagh\b|macaroni|penne|fusilli|farfalle|tagliatel|linguine|de cecco|lasagne|noodle|samyang|mie\b|rijst|\brice\b|couscous|quinoa|bulgur|meel\b|bloem\b|suiker|zout\b|peper\b|olie\b|olijfolie|bertolli|azijn|saus|sauce|ketchup|mayo|mosterd|pesto|bouillon|soep|blik|tomatenpuree|passata|mutti|kruidenmix|conserven|bonen\b|kikkererwt|linzen|tacos?\b|curry|wok|knorr|kaneel|santa maria|wyko|verstegen|sempio|calve|hellmann|bonduelle|ketjap|honig|remia|tapenade|muhammara|hummus|guac|tzatziki|\bdip\b|aioli|patak|masala|secchi|zeef tom|cakemix|venkelzaad|\brasp\b|chilli/i],
  ['kant-en-klaar', /maaltijd|kant ?en ?klaar|verspakket|maaltijdsalade|sushi|quiche|ovenschotel|stamppot|lasagne kant|wrap kant|soep vers|buddha|poke|stoommaal|\bbowl\b|burrito|garden gourm/i],
  ['bloemen en planten', /bloem(en)?\b|boeket|tulp|roos\b|rozen|plant\b|potgrond|orchidee|chrysant|pokon/i],
  ['dier', /kattenvoer|hondenvoer|\bkat\b|\bhond\b|whiskas|felix|sheba|pedigree|kattenbak|dierenvoer|hondenst|\bhnd\b|goodboy/i]
];
function soortVan(naam) {
  const n = String(naam || '');
  for (let i = 0; i < SOORTEN.length; i++) if (SOORTEN[i][1].test(n)) return SOORTEN[i][0];
  return 'overig';
}
function schoonNaam(s) { return String(s == null ? '' : s).normalize('NFC').replace(/[^\p{L}\p{N} .,&'()%\-/+*]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60); }
function getal(x) { const n = x && typeof x === 'object' ? Number(x.amount) : Number(x); return Number.isFinite(n) ? r2(n) : null; }

function bonOpslaan(db, lijstItem, det) {
  const id = String(lijstItem.id);
  const prod = Array.isArray(det.products) ? det.products : [], kort = Array.isArray(det.discounts) ? det.discounts : [], bet = Array.isArray(det.payments) ? det.payments : [];
  const tijd = String(lijstItem.dateTime || '').slice(0, 25);
  const totaal = getal(det.total) != null ? getal(det.total) : getal(lijstItem.totalAmount);
  const korting = r2(kort.reduce(function (t, k) { return t + Math.abs(getal(k.amount) || 0); }, 0));
  let nr = 0;
  db.exec('BEGIN');
  try {
    ['regel', 'korting', 'betaling'].forEach(function (t) { db.prepare('DELETE FROM ' + t + ' WHERE bon_id = ?').run(id); });
    const ir = db.prepare('INSERT INTO regel (bon_id, nr, product_id, naam, aantal, prijs, bedrag, soort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    prod.forEach(function (p) {
      const naam = schoonNaam(p && p.name), bedrag = getal(p && p.amount);
      if (!naam || bedrag == null) return;
      const aantal = Number(p.quantity);
      ir.run(id, ++nr, p.id == null ? null : String(p.id).slice(0, 40), naam, Number.isFinite(aantal) ? aantal : null, getal(p.price), bedrag, soortVan(naam));
    });
    const ik = db.prepare('INSERT INTO korting (bon_id, nr, naam, soort, bedrag) VALUES (?, ?, ?, ?, ?)');
    kort.forEach(function (k, i) { const b = getal(k && k.amount); if (b != null) ik.run(id, i + 1, schoonNaam(k.name) || null, schoonNaam(k.type).slice(0, 30) || null, b); });
    const ib = db.prepare('INSERT INTO betaling (bon_id, nr, wijze, bedrag) VALUES (?, ?, ?, ?)');
    bet.forEach(function (b, i) { const x = getal(b && b.amount); if (x != null) ib.run(id, i + 1, schoonNaam(b.method).slice(0, 30) || null, x); });
    db.prepare('INSERT OR REPLACE INTO bon (id, tijd, totaal, korting, regels, opgehaald) VALUES (?, ?, ?, ?, ?, ?)').run(id, tijd, totaal, korting, nr, new Date().toISOString());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return nr;
}

// ── koppelen, ronde, ontkoppelen ──────────────────────────────────────────────────────────────────────────────────────────
// Een generatie per koppeling: ontkoppelen hoogt hem op; een lopende ronde of koppeling van een oudere generatie slaat geen token meer op
// en stopt (review MOET 1).
let geheugen = { access: null, gen: null };
let bezig = false;
function genVan(dir) { const s = staatLees(dir); return Number(s.gen) || 0; }
async function tokenBewaar(deps, refresh, gen) {
  if (genVan(deps.dir) !== gen) throw new AhFout('ontkoppeld', 'intussen ontkoppeld');
  noodZet(deps.dir, refresh, gen);   // eerst lokaal duurzaam (600), dan de kluis
  try {
    const h = await deps.kluisZet(refresh);
    if (h !== sha(refresh)) throw new Error('kluis gaf een andere waarde terug');
  } catch (e) { return false; }
  if (genVan(deps.dir) !== gen) { await deps.kluisLeeg().catch(function () {}); noodWis(deps.dir); throw new AhFout('ontkoppeld', 'intussen ontkoppeld'); }
  noodWis(deps.dir);
  return true;
}
async function koppel(deps, tekst) {
  const code = codeUit(tekst);
  if (!code) return { ok: false, reden: 'vorm', fout: 'Geen code gevonden. Plak de hele regel die met appie://login-exit begint.' };
  if (bezig) return { ok: false, reden: 'bezig', fout: 'Socev is net met AH bezig; probeer het over een minuut opnieuw (log dan wel opnieuw in).' };
  bezig = true;
  try {
    const s = staatLees(deps.dir), gen = (Number(s.gen) || 0) + 1;
    let t;
    try { t = await tokenRuil(code); }
    catch (e) { return { ok: false, reden: e.reden || 'fout', fout: e.reden === 'code' ? 'Deze code is verlopen of al gebruikt. Log nog een keer in en plak de nieuwe regel meteen.' : 'AH gaf geen sleutel terug; probeer het later nog eens.' }; }
    if (!t.refresh) return { ok: false, reden: 'token', fout: 'AH gaf geen blijvende sleutel terug; er is niets bewaard.' };
    staatZet(deps.dir, Object.assign({}, s, { gen: gen, dood: null, gekoppeld_op: new Date().toISOString(), ontkoppeld_op: null, achterstand: true }));
    let inKluis;
    try { inKluis = await tokenBewaar(deps, t.refresh, gen); } catch (e) { return { ok: false, reden: e.reden || 'fout', fout: 'Koppelen afgebroken.' }; }
    geheugen = { access: t.access, gen: gen };
    return { ok: true, nood: !inKluis };
  } finally { bezig = false; }
}
async function ontkoppel(deps) {
  const s = staatLees(deps.dir), gen = (Number(s.gen) || 0) + 1;
  staatZet(deps.dir, Object.assign({}, s, { gen: gen, ontkoppeld_op: new Date().toISOString(), dood: null }));   // eerst de generatie op: lopend werk stopt
  geheugen = { access: null, gen: null };
  noodWis(deps.dir);
  let kluis = true;
  try { await deps.kluisLeeg(); } catch (e) { kluis = false; }
  return { ok: kluis, fout: kluis ? undefined : 'kluis nu niet bereikbaar; de koppeling is wel lokaal uit (de volgende ronde maakt de kluis leeg)' };
}
function gekoppeldLokaal(dir) { const s = staatLees(dir); return !!(s.gekoppeld_op && !s.ontkoppeld_op); }

// De ronde. o.max_details en o.pauze_ms alleen voor de toets.
async function ronde(deps, o) {
  o = o || {};
  const uit = { ok: false, bonnen_nieuw: 0, paginas: 0, achterstand: false };
  if (bezig) return Object.assign(uit, { reden: 'bezig' });
  bezig = true;
  const dir = deps.dir;
  try {
    let s = staatLees(dir);
    const gen = Number(s.gen) || 0;
    if (!s.gekoppeld_op || s.ontkoppeld_op) {
      if (s.ontkoppeld_op && !s.kluis_leeg_ok) { try { await deps.kluisLeeg(); staatZet(dir, Object.assign(staatLees(dir), { kluis_leeg_ok: true })); } catch (e) {} }
      return Object.assign(uit, { reden: 'niet-gekoppeld' });
    }
    // 1. refresh token: eerst een noodkopie van deze generatie in de kluis, anders uit de kluis
    let refresh = null;
    const nood = noodLees(dir);
    if (nood && Number(nood.gen) === gen) {
      try { await tokenBewaar(deps, nood.refresh, gen); uit.nood_hersteld = true; } catch (e) { if (e.reden === 'ontkoppeld') return Object.assign(uit, { reden: 'ontkoppeld' }); }
      refresh = nood.refresh;
    } else {
      if (nood) noodWis(dir);
      let k; try { k = await deps.kluisLees(); } catch (e) { return Object.assign(uit, { reden: 'kluis', fout: 'kluis niet bereikbaar' }); }
      refresh = k && TOKEN_VORM.test(k.refresh || '') ? k.refresh : null;
    }
    if (!refresh) return Object.assign(uit, { reden: 'kluis', fout: 'geen AH-sleutel in de kluis' });
    if (s.dood && s.dood === sha(refresh)) return Object.assign(uit, { reden: 'dood', fout: 'koppeling geweigerd; wacht op opnieuw inloggen' });
    // 2. verversen (access uit het geheugen alleen als hij van deze generatie is én net gemaakt; eenvoud: altijd verversen)
    let access;
    try {
      const t = await tokenVervers(refresh);
      access = t.access;
      if (t.refresh && t.refresh !== refresh) {
        const ok = await tokenBewaar(deps, t.refresh, gen);
        uit.geroteerd = true; if (!ok) uit.nood = true;
      }
    } catch (e) {
      if (e.reden === 'grant') { staatZet(dir, Object.assign(staatLees(dir), { dood: sha(refresh), dood_sinds: new Date().toISOString() })); }
      return Object.assign(uit, { reden: e.reden || 'fout', fout: e.message });
    }
    // 3. lijst + details
    const db = dbOpen(dir, false);
    try {
      const bekend = new Set(db.prepare('SELECT id FROM bon').all().map(function (r) { return r.id; }));
      const zetLijst = db.prepare('INSERT INTO lijst (id, tijd, totaal, gezien) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET tijd = excluded.tijd, totaal = excluded.totaal');
      const achterstandVooraf = s.achterstand !== false || !s.volledig_op;   // MOET 2: zolang er achterstand is niet stoppen op een bekende pagina
      const nieuw = [];
      let offset = 0, klaar = false;
      for (let p = 0; p < MAX_PAGINAS; p++) {
        if (genVan(dir) !== gen) return Object.assign(uit, { reden: 'ontkoppeld' });
        const d = await gql(access, Q_LIJST, { offset: offset, limit: PAGINA });
        uit.paginas++;
        const l = d && d.posReceiptsPage && Array.isArray(d.posReceiptsPage.posReceipts) ? d.posReceiptsPage.posReceipts : null;
        if (!l) throw new AhFout('vorm', 'AH-lijst had een onverwachte vorm');
        const nu = new Date().toISOString();
        let onbekend = 0;
        l.forEach(function (b) {
          if (!b || !ID_VORM.test(String(b.id || ''))) return;
          zetLijst.run(String(b.id), String(b.dateTime || '').slice(0, 25), getal(b.totalAmount), nu);
          if (!bekend.has(String(b.id))) { onbekend++; nieuw.push(b); bekend.add(String(b.id)); }
        });
        if (l.length < PAGINA) { klaar = true; break; }
        if (!achterstandVooraf && onbekend === 0) { klaar = true; break; }
        offset += PAGINA;
        if (PAUZE_MS) await slaap(o.pauze_ms != null ? o.pauze_ms : PAUZE_MS / 2);
      }
      // ook eerder geziene maar nog niet opgehaalde bonnen (een vorige ronde hield op bij de grens)
      const open = db.prepare('SELECT l.id, l.tijd AS dateTime, l.totaal FROM lijst l LEFT JOIN bon b ON b.id = l.id WHERE b.id IS NULL ORDER BY l.tijd DESC').all();
      const max = o.max_details || MAX_DETAILS;
      let gedaan = 0;
      for (const b of open) {
        if (gedaan >= max) break;
        if (genVan(dir) !== gen) return Object.assign(uit, { reden: 'ontkoppeld' });
        const d = await gql(access, Q_BON, { id: b.id });
        if (genVan(dir) !== gen) return Object.assign(uit, { reden: 'ontkoppeld' });   // ontkoppeld tijdens de aanroep: niets meer opslaan
        const det = d && d.posReceiptDetails;
        if (!det || typeof det !== 'object') throw new AhFout('vorm', 'AH-bon had een onverwachte vorm');
        bonOpslaan(db, { id: b.id, dateTime: b.dateTime, totalAmount: b.totaal }, det);
        gedaan++; uit.bonnen_nieuw++;
        if (PAUZE_MS) await slaap(o.pauze_ms != null ? o.pauze_ms : PAUZE_MS);
      }
      const rest = db.prepare('SELECT count(*) AS n FROM lijst l LEFT JOIN bon b ON b.id = l.id WHERE b.id IS NULL').get().n;
      uit.achterstand = !klaar || rest > 0;
      uit.bonnen = db.prepare('SELECT count(*) AS n FROM bon').get().n;
      const oudste = db.prepare('SELECT min(tijd) AS t FROM bon').get().t;
      uit.oudste = oudste ? String(oudste).slice(0, 10) : null;
      s = staatLees(dir);
      if (Number(s.gen) === gen) staatZet(dir, Object.assign(s, { achterstand: uit.achterstand, volledig_op: !uit.achterstand ? new Date().toISOString() : (s.volledig_op || null) }));
      uit.ok = true;
      return uit;
    } finally { try { db.close(); } catch (e) {} }
  } catch (e) {
    try { const s2 = staatLees(dir); if (s2.gekoppeld_op && !s2.ontkoppeld_op) staatZet(dir, Object.assign(s2, { achterstand: true })); } catch (e2) {}   // half werk: volgende keer niet vroeg stoppen
    return Object.assign(uit, { reden: e.reden || 'fout', fout: String(e.message || e).slice(0, 160) });
  } finally { bezig = false; }
}

// ── overzicht voor de app ─────────────────────────────────────────────────────────────────────────────────────────────────
// bank: [{ nr, datum: 'JJJJ-MM-DD', bedrag (negatief = af) }] van AH-afschrijvingen. Koppeling uniek (review MOET 3): elke bankpost en elke bon
// hooguit één keer; een bankpost met meer dan één kandidaat-bon (of een bon met meer kandidaat-posten) blijft onbeslist.
function koppelBank(bonnen, bank) {
  const kand = new Map(), perPost = new Map();
  bonnen.forEach(function (b) {
    const dag = String(b.tijd).slice(0, 10), bedragen = (b.betalingen.length ? b.betalingen : [b.totaal]).filter(function (x) { return x != null && x > 0; });
    if (b.totaal != null && bedragen.indexOf(b.totaal) < 0) bedragen.push(b.totaal);
    const t0 = Date.parse(dag + 'T00:00:00Z');
    bank.forEach(function (p) {
      const dt = (Date.parse(p.datum + 'T00:00:00Z') - t0) / 86400000;
      if (!(dt >= 0 && dt <= 3)) return;
      if (!bedragen.some(function (x) { return Math.abs(x + p.bedrag) < 0.005; })) return;
      if (!kand.has(b.id)) kand.set(b.id, []); kand.get(b.id).push(p.nr);
      if (!perPost.has(p.nr)) perPost.set(p.nr, []); perPost.get(p.nr).push(b.id);
    });
  });
  const paar = new Map();
  let onbeslist = 0;
  kand.forEach(function (posten, id) {
    if (posten.length === 1 && perPost.get(posten[0]).length === 1) paar.set(id, posten[0]); else onbeslist++;
  });
  return { paar: paar, onbeslist: onbeslist };
}
function overzicht(dir, bank, o) {
  o = o || {};
  const s = staatLees(dir);
  const st = { gekoppeld: !!(s.gekoppeld_op && !s.ontkoppeld_op), dood: !!s.dood, achterstand: s.achterstand === true, laatste: s.laatste || null, inloglink: INLOGLINK };
  const db = dbOpen(dir, true);
  if (!db) return Object.assign(st, { bonnen: 0 });
  try {
    const twaalf = o.twaalf || [];
    const in12 = new Set(twaalf);
    const bonnenAlle = db.prepare('SELECT id, tijd, totaal, korting FROM bon ORDER BY tijd').all();
    const bet = new Map();
    db.prepare('SELECT bon_id, bedrag FROM betaling').all().forEach(function (r) { if (!bet.has(r.bon_id)) bet.set(r.bon_id, []); bet.get(r.bon_id).push(r2(r.bedrag)); });
    const bonnen = bonnenAlle.map(function (b) { return { id: b.id, tijd: b.tijd, maand: String(b.tijd).slice(0, 7), totaal: b.totaal == null ? null : r2(b.totaal), korting: b.korting || 0, betalingen: bet.get(b.id) || [] }; });
    const b12 = bonnen.filter(function (b) { return in12.has(b.maand); });
    const ids12 = new Set(b12.map(function (b) { return b.id; }));
    const regels = db.prepare('SELECT bon_id, naam, aantal, bedrag FROM regel').all().filter(function (r) { return ids12.has(r.bon_id); })
      .map(function (r) { r.soort = soortVan(r.naam); return r; });   // wv2714: soort bij het lezen, zodat bijgewerkte woordregels ook voor oude bonnen gelden
    const maandVan = new Map(b12.map(function (b) { return [b.id, b.maand]; }));
    // per soort per maand
    const soort = new Map();
    regels.forEach(function (r) {
      if (!soort.has(r.soort)) soort.set(r.soort, new Map());
      const m = soort.get(r.soort), mm = maandVan.get(r.bon_id);
      m.set(mm, (m.get(mm) || 0) + r.bedrag);
    });
    const nM = twaalf.filter(function (m) { return b12.some(function (b) { return b.maand === m; }); }).length || 1;
    const soorten = Array.from(soort.entries()).map(function (e) {
      const reeks = twaalf.map(function (m) { return { maand: m, waarde: r2(e[1].get(m) || 0) }; });
      const som = reeks.reduce(function (t, r) { return t + r.waarde; }, 0);
      return { naam: e[0], per_maand: r2(som / nM), som: r2(som), reeks: reeks };
    }).sort(function (p, q) { return q.som - p.som; });
    // producten
    const prod = new Map();
    regels.forEach(function (r) {
      if (r.soort === 'statiegeld en tasjes') return;
      const k = r.naam.toLowerCase();
      if (!prod.has(k)) prod.set(k, { naam: r.naam, soort: r.soort, som: 0, bonnen: new Set(), stuks: 0 });
      const p = prod.get(k); p.som += r.bedrag; p.bonnen.add(r.bon_id); p.stuks += Number.isFinite(r.aantal) && r.aantal > 0 && r.aantal < 100 ? r.aantal : 1;
    });
    const pl = Array.from(prod.values()).map(function (p) { return { naam: p.naam, soort: p.soort, som: r2(p.som), keer: p.bonnen.size, per_maand: r2(p.som / nM), gem_prijs: p.stuks ? r2(p.som / p.stuks) : null }; });
    const duurst = pl.slice().sort(function (p, q) { return q.som - p.som; }).slice(0, 15);
    const vaakst = pl.slice().sort(function (p, q) { return q.keer - p.keer || q.som - p.som; }).slice(0, 15);
    // bank
    const bank12 = (bank || []).filter(function (p) { return in12.has(String(p.datum).slice(0, 7)) && p.bedrag < 0; });
    const k = koppelBank(b12, bank12);
    const bankSom = r2(bank12.reduce(function (t, p) { return t - p.bedrag; }, 0));
    const gekoppeldePosten = new Set(Array.from(k.paar.values()));
    const metBon = r2(bank12.filter(function (p) { return gekoppeldePosten.has(p.nr); }).reduce(function (t, p) { return t - p.bedrag; }, 0));
    const somBon = r2(b12.reduce(function (t, b) { return t + (b.totaal || 0); }, 0));
    const korting = r2(b12.reduce(function (t, b) { return t + (b.korting || 0); }, 0));
    return Object.assign(st, {
      bonnen: bonnen.length, oudste: bonnen.length ? bonnen[0].tijd.slice(0, 10) : null, nieuwste: bonnen.length ? bonnen[bonnen.length - 1].tijd.slice(0, 10) : null,
      periode: { bonnen: b12.length, maanden: nM, som: somBon, per_maand: r2(somBon / nM), per_bon: b12.length ? r2(somBon / b12.length) : null, korting: korting },
      soorten: soorten, duurst: duurst, vaakst: vaakst,
      bank: { posten: bank12.length, som: bankSom, met_bon: metBon, posten_met_bon: gekoppeldePosten.size, bonnen_zonder_post: b12.length - k.paar.size, onbeslist: k.onbeslist,
        dekking: bankSom > 0 ? Math.round(100 * metBon / bankSom) : null }
    });
  } finally { try { db.close(); } catch (e) {} }
}
function laatsteZet(dir, u) {
  const s = staatLees(dir);
  s.laatste = { tijd: new Date().toISOString(), ok: u.ok === true, reden: u.reden || null, bonnen: u.bonnen != null ? u.bonnen : (s.laatste && s.laatste.bonnen) || null, nieuw: u.bonnen_nieuw || 0, achterstand: !!u.achterstand, oudste: u.oudste || null };
  if (u.ok === true) s.laatste_ok = s.laatste.tijd;
  staatZet(dir, s);
}

module.exports = { INLOGLINK: INLOGLINK, codeUit: codeUit, soortVan: soortVan, koppel: koppel, ontkoppel: ontkoppel, ronde: ronde, overzicht: overzicht,
  koppelBank: koppelBank, laatsteZet: laatsteZet, staatLees: staatLees, gekoppeldLokaal: gekoppeldLokaal, sha: sha, TOKEN_VORM: TOKEN_VORM, _Q: { LIJST: Q_LIJST, BON: Q_BON },
  _dbOpen: dbOpen, _bonOpslaan: bonOpslaan, _staatZet: staatZet };   // _…: alleen voor toetsen (verzonnen bonnen zaaien)
