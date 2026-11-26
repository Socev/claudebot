'use strict';
/**
 * mail-ontvangers.js — ontvangers en feitenstrook voor een mailconcept (wv4098, 26-11-2026; besluitenpagina nr 348 = 3C48 en nr 339 = 3C39,
 * David Ja 25-11 21:46). Puur: alleen ./voorwerk-poort.js, geen netwerk, geen omgeving.
 *
 * WAAROM. Socev zei bij elk draadconcept "loop de ontvangers even na, cc zie ik niet", terwijl het lees-luik (mail_gesprek, sinds 14-11) per
 * bericht een cc-veld geeft (gemeten 26-11: gevuld). Het voorwerk achter de knop in Mail antwoordde alleen aan de afzender, zonder cc en vanaf
 * het standaardadres. En in de chatroute keek niets of een bedrag of datum ergens vandaan kwam (Davids klacht van 9-11); die controle zat
 * alleen in het voorwerk.
 * WAT.
 * - ontvangers(berichten, o): aan, cc en afzendadres voor een antwoord in de draad ("allen beantwoorden"), plus wat de meldregel moet noemen.
 *   Laatste echte bericht (geen concept) van een ander: aan = de afzender + de andere aan-ontvangers, cc = de cc, zonder Davids eigen adressen.
 *   Laatste bericht van David zelf (herinnering): zijn aan en cc. Wie eerder in de draad stond maar nu niet meer: alleen genoemd (weggelaten).
 *   Afzendadres: de From van Davids laatste eigen bericht in de draad; anders het eigen Gmail-adres waaraan de mail gericht was; leeg =
 *   d.schaap@gmail.com (standaard van de n8n-knoop). Alleen adressen die in privé-Gmail kunnen versturen (VERZEND_ALIAS of eerder verzonden
 *   in deze draad), nooit doktersmaten@ of een praktijkadres.
 * - feitenStrook(concept, o): elke waarde (bedrag, datum, uren, dagen, telefoon, IBAN, e-mail, postcode) uit het concept langs de draad, de
 *   gelezen stukken en Davids schrijfgids (voorwerk-poort.scan, dezelfde normalisatie als het voorwerk). Meldt alleen; beslist niets.
 * GRENZEN. Vindt letterlijke waarden, geen verkeerde redenering. Reply-To kent het luik niet: een afwijkend antwoordadres ziet dit niet.
 */
const P = require('./voorwerk-poort.js');

// Davids eigen adressen (intake router.json eigen_adressen + stemvoorbeeld.py EIGEN + bekende varianten); nooit als ontvanger
const EIGEN = ['d.schaap@gmail.com', 'dokterschaap@gmail.com', 'david@hapleusden.nl', 'dokterschaap@huisartsentolgaarde.nl',
  'd.schaap@huisartsentolgaarde.nl', 'doktersmaten@hapleusden.nl', 'doktersmaten@hpgroenhouten.nl'];
// Adressen waarmee privé-Gmail kan versturen (n8n fromAlias); met de naam die David er het vaakst bij gebruikt (gemeten 26-11, Verzonden)
const VERZEND_ALIAS = { 'd.schaap@gmail.com': '', 'dokterschaap@gmail.com': 'David Schaap <dokterschaap@gmail.com>' };
const MAX_GENOEMD = 20;   // hooguit zoveel weggelaten adressen in de meldregel (de rest als aantal); aan en cc worden nooit afgekapt

function s(x) { return typeof x === 'string' ? x : x == null ? '' : String(x); }
// Mailboxveld → kale adressen. Splitst op komma's buiten aanhalingstekens en <…>; per mailbox telt alleen het adres tussen <…> (of het kale
// adres), nooit een adres in de weergavenaam of in commentaar ("team@x" <d@y> = alleen d@y; review Codex wv4098 MOET 2).
function adressen(veld) {
  const t = s(veld), delen = [];
  let cur = '', q = false, hoek = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && q && i + 1 < t.length) { cur += c + t[++i]; continue; }
    if (c === '"') q = !q;
    else if (!q && c === '<') hoek++;
    else if (!q && c === '>') hoek = Math.max(0, hoek - 1);
    if ((c === ',' || c === ';') && !q && hoek === 0) { delen.push(cur); cur = ''; } else cur += c;
  }
  delen.push(cur);
  const uit = [];
  delen.forEach(function (d) {
    const m = /<([^<>"]*)>\s*$/.exec(d);
    const kaal = (m ? m[1] : d.replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/\([^()]*\)/g, ' ')).trim();
    if (/^[^\s@<>",;()]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(kaal)) uit.push(kaal.toLowerCase());
  });
  return uit;
}
function eersteAdres(veld) { return adressen(veld)[0] || ''; }
function plusLos(a) { return a.replace(/^([^@+]+)\+[^@]*@(gmail\.com)$/, '$1@$2'); }
function uniek(lijst, weg) {
  const gezien = new Set(weg || []), uit = [];
  lijst.forEach(function (a) { if (a && !gezien.has(a)) { gezien.add(a); uit.push(a); } });
  return uit;
}
function tijd(b) { const t = Date.parse(s(b && b.datum)); return Number.isFinite(t) ? t : 0; }
function labels(b) { return Array.isArray(b && b.labels) ? b.labels : []; }

/*
 * berichten = mail_gesprek.berichten [{ id, van, aan, cc, onderwerp, datum, labels }]. o = { eigen?: [extra eigen adressen] }
 * → null (geen bruikbaar bericht) of { aan: [..], cc: [..], van: '' | 'Naam <adres>', van_adres, van_reden, soort: 'antwoord'|'herinnering',
 *   afzender, laatste_id, onderwerp, weggelaten: [..], eigen_weg: [..] }
 */
function ontvangers(berichten, o) {
  o = o || {};
  const lijst = (Array.isArray(berichten) ? berichten : []).filter(function (b) { return b && typeof b === 'object' && labels(b).indexOf('DRAFT') < 0; })
    .map(function (b, i) { return { b: b, i: i }; })
    .sort(function (x, y) { return (tijd(x.b) - tijd(y.b)) || (x.i - y.i); }).map(function (x) { return x.b; });
  if (!lijst.length) return null;
  const verzonden = lijst.filter(function (b) { return labels(b).indexOf('SENT') >= 0; });
  const eigenSet = new Set(EIGEN.concat((o.eigen || []).map(function (a) { return s(a).toLowerCase(); })));
  verzonden.forEach(function (b) { const a = eersteAdres(b.van); if (a) eigenSet.add(a); });
  const isEigen = function (a) { return eigenSet.has(a) || eigenSet.has(plusLos(a)); };
  const zonderEigen = function (l) { return l.filter(function (a) { return !isEigen(a); }); };
  const laatste = lijst[lijst.length - 1];
  const vanDavid = labels(laatste).indexOf('SENT') >= 0 || isEigen(eersteAdres(laatste.van));
  const afzender = eersteAdres(laatste.van);
  let aan, cc;
  if (vanDavid) {
    aan = uniek(zonderEigen(adressen(laatste.aan)));
    cc = uniek(zonderEigen(adressen(laatste.cc)), aan);
  } else {
    aan = uniek(zonderEigen([afzender].concat(adressen(laatste.aan))));
    cc = uniek(zonderEigen(adressen(laatste.cc)), aan);
  }
  const eigenWeg = uniek(adressen(laatste.aan).concat(adressen(laatste.cc)).filter(isEigen)
    .filter(function (a) { return !Object.hasOwn(VERZEND_ALIAS, plusLos(a)); }));
  // Wie eerder in de draad stond (afzender, aan of cc) maar niet in dit antwoord: alleen noemen, David beslist
  const eerder = [];
  lijst.slice(0, -1).forEach(function (b) { eerder.push.apply(eerder, [eersteAdres(b.van)].concat(adressen(b.aan), adressen(b.cc))); });
  const weggelaten = uniek(zonderEigen(eerder), aan.concat(cc));
  // Afzendadres
  let van = '', vanAdres = 'd.schaap@gmail.com', vanReden = 'standaard';
  const mijnLaatste = verzonden[verzonden.length - 1];
  const kanVersturen = function (a) { return Object.hasOwn(VERZEND_ALIAS, a) || verzonden.some(function (b) { return eersteAdres(b.van) === a; }); };
  if (mijnLaatste && eersteAdres(mijnLaatste.van)) {
    vanAdres = eersteAdres(mijnLaatste.van);
    van = vanAdres === 'd.schaap@gmail.com' ? '' : s(mijnLaatste.van).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    vanReden = 'eerder_in_draad';
  } else if (!vanDavid) {
    const gericht = adressen(laatste.aan).concat(adressen(laatste.cc)).map(plusLos).filter(function (a) { return isEigen(a) && kanVersturen(a); })[0];
    if (gericht && gericht !== 'd.schaap@gmail.com') { vanAdres = gericht; van = VERZEND_ALIAS[gericht] || gericht; vanReden = 'gericht_aan'; }
  }
  return { aan: aan, cc: cc, van: van, van_adres: vanAdres, van_reden: vanReden, soort: vanDavid ? 'herinnering' : 'antwoord',
    afzender: afzender, laatste_id: s(laatste.id), onderwerp: s(laatste.onderwerp), weggelaten: weggelaten, eigen_weg: eigenWeg };
}

// "Re: " + het echte onderwerp, zonder dubbel Re:/Antw:/Fwd:-voorvoegsel
function antwoordOnderwerp(o) {
  const t = s(o).replace(/[\r\n]+/g, ' ').trim().replace(/^((re|antw|aw|fw|fwd|doorst)\s*:\s*)+/i, '').trim().slice(0, 300);
  return t ? 'Re: ' + t : '';
}

// Eén regel voor de melding aan David
function ontvangersRegel(r) {
  if (!r) return '';
  const d = ['aan ' + (r.aan.length ? r.aan.join(', ') : '(niemand: vul zelf in)')];
  if (r.cc.length) d.push('cc ' + r.cc.join(', '));
  d.push('vanaf ' + r.van_adres);
  let t = 'Ontvangers uit de draad: ' + d.join(' · ') + '.';
  if (r.weggelaten.length) t += ' Eerder in de draad, nu niet mee: ' + r.weggelaten.slice(0, MAX_GENOEMD).join(', ') +
    (r.weggelaten.length > MAX_GENOEMD ? ' en nog ' + (r.weggelaten.length - MAX_GENOEMD) : '') + '.';
  return t;
}

/*
 * concept = Davids conceptmail (platte tekst). o = { draad: [tekst per bericht], stukken: [{ naam, tekst }], stem: schrijfgids }
 * → { aantal, onderbouwd: [{ soort, ruw, bron }], niet_onderbouwd: [{ soort, ruw }], regel }
 */
function feitenStrook(concept, o) {
  o = o || {};
  const draadK = []; (Array.isArray(o.draad) ? o.draad : []).forEach(function (t) { P.scan(s(t)).forEach(function (x) { draadK.push(x.sleutel); }); });
  const stukK = (Array.isArray(o.stukken) ? o.stukken : []).filter(function (x) { return x && typeof x === 'object'; }).map(function (x) {
    return { naam: s(x.naam).slice(0, 120) || 'stuk', k: P.scan(s(x.tekst)).map(function (y) { return y.sleutel; }) };
  });
  const stemK = P.scan(s(o.stem)).map(function (x) { return x.sleutel; });
  const past = function (k, l) { return l.some(function (b) { return P._intern.sleutelPast(k, b); }); };
  const gezien = new Set(), onderbouwd = [], niet = [];
  P.scan(s(concept)).forEach(function (x) {
    if (gezien.has(x.sleutel)) return;
    gezien.add(x.sleutel);
    let bron = past(x.sleutel, draadK) ? 'draad' : '';
    if (!bron) { const st = stukK.find(function (y) { return past(x.sleutel, y.k); }); if (st) bron = 'stuk: ' + st.naam; }
    if (!bron && past(x.sleutel, stemK)) bron = 'schrijfgids';
    if (bron) onderbouwd.push({ soort: x.soort, ruw: x.ruw, bron: bron });
    else niet.push({ soort: x.soort, ruw: x.ruw });
  });
  const n = onderbouwd.length + niet.length;
  let regel;
  if (!n) regel = 'Geen bedragen, datums of nummers in dit concept.';
  else if (!niet.length) {
    const bronnen = uniek(onderbouwd.map(function (x) { return x.bron === 'draad' ? 'de draad' : x.bron === 'schrijfgids' ? 'je ondertekening' : 'de stukken'; }));
    const opsom = bronnen.length > 1 ? bronnen.slice(0, -1).join(', ') + ' en ' + bronnen[bronnen.length - 1] : bronnen[0];
    regel = n + (n === 1 ? ' feit, uit ' : ' feiten, alle uit ') + opsom + '.';
  } else regel = n + (n === 1 ? ' feit' : ' feiten') + '; niet onderbouwd: ' + niet.map(function (x) { return x.ruw; }).join(', ') + '.';
  return { aantal: n, onderbouwd: onderbouwd.slice(0, 40), niet_onderbouwd: niet.slice(0, 40), regel: regel };
}

module.exports = { ontvangers, antwoordOnderwerp, ontvangersRegel, feitenStrook, adressen, EIGEN, VERZEND_ALIAS };
