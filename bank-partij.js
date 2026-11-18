'use strict';
// Bankposten per relatiepagina (wv3298, idee 35 meetpunt 3; meting wv2826/wv3280). Alleen lezen. Voor het blok "Bank" in Brain › Entiteiten.
// Bronnen: zakelijk = Facturen-app (facturen.sqlite, bank_transactie, zonder POT, zonder overboekingen tussen eigen rekeningen en zonder
// verwijderde rijen); privé = bank-archief (bank/transacties.sqlite) met de uitsluitingen van wv1254 (rekeningen van POT, extern, Gambia-hulp en
// kind; intern; eigen IBAN; contant geld en Gambia-hulp). Groepen zoals in de meting: sleutel IBAN, anders de genormaliseerde naam.
// Koppelregel: genormaliseerde naam = naam of alias van precies één knoop (de regel van facturenVan en rekeningenPerDoel); lukt dat niet,
// dan eerst de filiaalregel (voorvoegsel van de betaalterminal, filiaalnummer en plaats eraf, bekende ketens op één naam) en dan dezelfde
// naam/alias-match. Een groep gaat in zijn geheel naar een knoop als alle herkende namen in die groep dezelfde knoop noemen en de groep geen
// betaaldienst is; anders telt elke post alleen op zijn eigen naam (een IBAN van CCV, Mollie of PayPal draagt veel winkels).
// Uitvoer per knoop: aantal posten, eerste en laatste datum, de meest voorkomende schrijfwijzen. Geen bedragen, geen IBAN.
const fs = require('fs');

function nrm(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

// ── filiaalregel (kandidaatregel wv3280, mk-scripts/wv3280/meet.py) ──
const VOORV = /^(ccv\*|bck\*|nya\*|nyx\*|neu\*|sumup \*|sumup\*|zettle_\*|pay\.nl\*|goc\*|iz \*|sq \*|ccv \*)\s*/i;
const PLAATS = new Set(['huizen', 'blaricum', 'leusden', 'eemnes', 'amersfoort', 'laren', 'bussum', 'hilversum', 'naarden', 'almere', 'utrecht', 'amsterdam',
  'soest', 'baarn', 'nijkerk', 'hoevelaken', 'barneveld', 'woudenberg', 'scherpenzeel', 'zeist', 'weesp', 'muiderberg', 'muiden', 'den', 'haag', 'rotterdam',
  'schiphol', 'nl', 'nld', 'nederland', 'centrum', 'kost']);
const KETEN = [[/^(albert ?heijn|ah)\b/i, 'Albert Heijn'], [/^hema\b/i, 'HEMA'], [/^action\b/i, 'Action'], [/^karwei\b/i, 'Karwei'], [/^jumbo\b/i, 'Jumbo'],
  [/^plus ?supermarkt|^plus\b/i, 'PLUS Supermarkt'], [/^lidl\b/i, 'Lidl'], [/^kruidvat\b/i, 'Kruidvat'], [/^etos\b/i, 'Etos'], [/^gamma\b/i, 'Gamma'],
  [/^praxis\b/i, 'Praxis'], [/^ikea\b/i, 'IKEA'], [/^q-?park\b/i, 'Q-Park'], [/^aldi\b/i, 'Aldi']];
// betaaldiensten en platforms: een IBAN-groep daarvan gaat nooit in zijn geheel naar één winkel (zelfde lijst als GEMENGD in financien-overzicht.js)
const BETAALDIENST = /paypal|tikkie|bol\.?com|amazon|amzn|mollie|stripe|klarna|riverty|billink|alipay|buckaroo|adyen|pay\.nl|\bccv\b|sumup|online payment|ingenico|worldline|zettle|square|\bnya\b|\bnyx\b|\bbck\b|\bgoc\b|\bvia\b|smart ?pay|payvision|trusted third party/i;
// "→ { naam, soort }" of null. soort 'keten' = bekende keten; 'kaal' = alleen voorvoegsel, nummer en plaats eraf.
function schoon(naam) {
  const ruw = String(naam == null ? '' : naam).trim();
  let s = ruw.replace(VOORV, '');
  s = s.replace(/^\d+\s+/, '');                       // "5118 Boni Huizen"
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2');          // "PlusSupermarktHuizen"
  for (let i = 0; i < KETEN.length; i++) if (KETEN[i][0].test(s)) return { naam: KETEN[i][1], soort: 'keten' };
  const w = s.split(/\s+/).filter(Boolean);
  while (w.length && (/^\d+$|^[A-Z]{0,3}\d+\w*$/.test(w[w.length - 1]) || PLAATS.has(w[w.length - 1].toLowerCase().replace(/[.,]+$/, '')))) w.pop();
  const k = w.join(' ');
  return nrm(k).length >= 4 && k !== ruw ? { naam: k, soort: 'kaal' } : null;
}

// naam → knoop-id volgens naam of alias van precies één knoop (eigen entiteiten tellen niet mee)
function naamIndex(knopen, handvatten, isEigen) {
  const op = new Map();
  const zet = function (n, id) { const s = nrm(n); if (s.length < 3) return; if (!op.has(s)) op.set(s, new Set()); op.get(s).add(id); };
  (knopen || []).forEach(function (k) {
    if (!k || k.actief === false || isEigen(k)) return;
    [k.naam].concat(k.aliassen || []).forEach(function (n) { zet(n, k.id); });
    ((handvatten && handvatten[k.id]) || []).forEach(function (h) { if (h && h.soort === 'alias' && h.status !== 'vervallen') zet(h.waarde, k.id); });
  });
  return function live(naam) { const s = op.get(nrm(naam)); return s && s.size === 1 ? s.values().next().value : null; };
}

function leesAlles(pad, sql) {
  if (!pad || !fs.existsSync(pad)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(pad, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout = 2000;'); return db.prepare(sql).all(); }
  finally { try { db.close(); } catch (e) { /* al dicht */ } }
}

const PIN = /^BEA,\s*(?:Betaalpas|Google Pay|Apple Pay|Garmin Pay|Fitbit Pay)\s+(.+?)(?:,PAS\d+|\s+NR:|,|$)/i;

// posten → groepen: [{ sleutel, posten: [{ naam, datum }] }]
function groepeer(rijen) {
  const g = new Map();
  rijen.forEach(function (r) {
    const key = r.iban ? 'I:' + r.iban : 'N:' + nrm(r.naam);
    if (!g.has(key)) g.set(key, { sleutel: key, iban: !!r.iban, posten: [] });
    g.get(key).posten.push({ naam: r.naam || '', datum: String(r.datum || '').slice(0, 10) });
  });
  return Array.from(g.values());
}

function zakelijkeRijen(pad) {
  const eigen = leesAlles(pad, 'select iban from rekening');
  if (eigen === null) return null;
  const eig = new Set(eigen.map(function (r) { return r.iban; }));
  const r = leesAlles(pad, "select tegenpartij_iban as iban, tegenpartij_naam as naam, omschrijving as oms, boekdatum as datum from bank_transactie where entiteit <> 'pot' and verwijderd_op is null") || [];
  return r.filter(function (x) { return !(x.iban && eig.has(x.iban)); }).map(function (x) {
    let naam = x.naam;
    if (!x.iban && !String(naam || '').trim()) { const m = PIN.exec(String(x.oms || '')); if (m) naam = m[1]; }   // pinbetaling: winkel uit de omschrijving
    return { iban: x.iban || null, naam: naam || '', datum: x.datum };
  });
}

function priveRijen(pad) {
  const reks = leesAlles(pad, 'select rek, eigenaar, iban from rekeningen');
  if (reks === null) return null;
  const eigenaar = new Map(), eigenIban = new Set();
  reks.forEach(function (r) { eigenaar.set(r.rek, String(r.eigenaar || '').toLowerCase()); if (r.iban) eigenIban.add(r.iban); });
  const r = leesAlles(pad, "select t.rek, t.tegenpartij as naam, t.tegen_iban as iban, t.datum, v.type as typ, v.categorie as cat from transacties t left join verrijking v on v.nr = t.nr" +
    " where t.vervangen_door is null and t.status <> 'pending'") || [];
  return r.filter(function (x) {
    const e = eigenaar.get(x.rek) || '';
    return !(['pot', 'extern', 'gambia-hulp', 'kind'].indexOf(e) >= 0 || x.typ === 'intern' || (x.iban && eigenIban.has(x.iban)) || x.cat === 'contant geld' || x.cat === 'Gambia-hulp');
  }).map(function (x) { return { iban: x.iban || null, naam: x.naam || '', datum: x.datum }; });
}

// Koppel de groepen van één bron aan knopen. → { per: Map(id → { posten, eerste, laatste, namen: Map(naam → n), filiaal }), telling }
function koppel(groepen, live, opt) {
  const metFiliaal = !(opt && opt.zonderFiliaal);   // zonderFiliaal: alleen de naam/alias-regel (voor de voor/na-meting)
  const per = new Map();
  const telling = { groepen: groepen.length, posten: 0, groepen_ingang: 0, posten_ingang: 0, groepen_naam: 0, groepen_filiaal: 0, nieuw: [] };
  const naar = function (naam) {
    const l = live(naam); if (l) return { id: l, soort: 'naam' };
    const s = metFiliaal ? schoon(naam) : null; if (s) { const m = live(s.naam); if (m) return { id: m, soort: 'filiaal' }; }
    return null;
  };
  groepen.forEach(function (g) {
    telling.posten += g.posten.length;
    const opNaam = new Map();
    g.posten.forEach(function (p) { if (!opNaam.has(p.naam)) opNaam.set(p.naam, naar(p.naam)); });
    const ids = new Set(); let filiaal = false, naamTreffer = false;
    opNaam.forEach(function (m) { if (m) { ids.add(m.id); if (m.soort === 'filiaal') filiaal = true; else naamTreffer = true; } });
    if (!ids.size) return;
    const dienst = g.iban && Array.from(opNaam.keys()).some(function (n) { return BETAALDIENST.test(n) || VOORV.test(String(n).trim()); });   // review MOET 1: ook elk terminalvoorvoegsel (SQ *, IZ * …)
    const heel = ids.size === 1 && !dienst ? ids.values().next().value : null;
    let geteld = 0;
    g.posten.forEach(function (p) {
      const m = opNaam.get(p.naam), id = heel || (m && m.id);
      if (!id) return;
      geteld++;
      if (!per.has(id)) per.set(id, { posten: 0, eerste: null, laatste: null, namen: new Map(), filiaal: false });
      const x = per.get(id);
      x.posten++;
      if (p.datum && (!x.eerste || p.datum < x.eerste)) x.eerste = p.datum;
      if (p.datum && (!x.laatste || p.datum > x.laatste)) x.laatste = p.datum;
      if (p.naam) x.namen.set(p.naam, (x.namen.get(p.naam) || 0) + 1);
      if (m && m.soort === 'filiaal') x.filiaal = true;
    });
    if (geteld) {
      telling.groepen_ingang++; telling.posten_ingang += geteld;
      if (naamTreffer) telling.groepen_naam++;
      else if (filiaal) {
        telling.groepen_filiaal++;
        telling.nieuw.push({ namen: Array.from(opNaam.keys()).filter(function (n) { return opNaam.get(n); }).slice(0, 3), id: heel || Array.from(ids)[0], posten: geteld });
      }
    }
  });
  return { per: per, telling: telling };
}

// Index over beide bronnen. o: { facturenPad, bankPad, knopen, handvatten, isEigen }
function index(o) {
  const live = naamIndex(o.knopen, o.handvatten, o.isEigen || function () { return false; });
  const uit = { zakelijk: null, prive: null };
  try { const z = zakelijkeRijen(o.facturenPad); if (z) uit.zakelijk = koppel(groepeer(z), live); } catch (e) { uit.zakelijk_fout = String(e && e.message || e).slice(0, 120); }
  try { const p = priveRijen(o.bankPad); if (p) uit.prive = koppel(groepeer(p), live); } catch (e) { uit.prive_fout = String(e && e.message || e).slice(0, 120); }
  return uit;
}

// Blok voor één knoop: null als geen van beide bronnen te lezen is; per kant null (bron ontbreekt) of { posten, eerste, laatste, schrijfwijzen, meer, filiaal }.
function blokVoor(idx, id) {
  if (!idx || (!idx.zakelijk && !idx.prive)) return null;
  const kant = function (b) {
    if (!b) return null;
    const x = b.per.get(id);
    if (!x) return { posten: 0 };
    const namen = Array.from(x.namen.entries()).sort(function (p, q) { return q[1] - p[1]; });
    return { posten: x.posten, eerste: x.eerste, laatste: x.laatste, schrijfwijzen: namen.slice(0, 3).map(function (n) { return String(n[0]).slice(0, 60); }),
      meer: Math.max(0, namen.length - 3), filiaal: x.filiaal };
  };
  return { zakelijk: kant(idx.zakelijk), prive: kant(idx.prive) };
}

module.exports = { zakelijkeRijen: zakelijkeRijen, priveRijen: priveRijen, nrm: nrm, schoon: schoon, naamIndex: naamIndex, groepeer: groepeer, koppel: koppel, index: index, blokVoor: blokVoor, BETAALDIENST: BETAALDIENST };
