'use strict';
// Zoek snel als voordeur naar al Davids bronnen (wv3742, besluitenpagina nr 459 = 3C159, David Ja 21-11-2026 13:20: "Wil je dat Zoek snel met
// één vraag in al je bronnen tegelijk zoekt (Brein, contacten, agenda, mail, gesprekken, Facturen, bank, Pakjes)?").
// WAAROM. David denkt in een persoon of zaak, niet in "staat dit in de vault of in de mail". Zoek snel keek alleen in Brain (en sinds wv3733 bij
// een nummer- of agendavraag in Contacten en de agenda). Nu gaat één vraag tegelijk naar alle bronnen; per bron één kaartje met het beste
// resultaat en een tik naar het item in de juiste App. Een bron die niet antwoordt, uit staat of op een tik wacht, staat er bij naam bij:
// nooit stil weggelaten. Ontwerp + Codex-review: mk-scripts/wv3742/ontwerp.md (r1/r2 NO-GO op één punt, overgenomen: Mail gaat niet
// vanzelf naar Google; het kaartje Mail zoekt pas als David erop tikt, in App Mail, zoals daar met een zoekvraag).
//
// VORM. Geen HTTP en geen opslag: server.js geeft per bron een functie (alleen lezen) en krijgt een lijst uitkomsten terug. Brain is hier geen
// bron: dat zijn de treffers van POST /app/zoek-snel/treffers (de app toont ze al). Geen model. Niets in een log behalve tellingen (server.js).
//
// ZOEKEN. Kernwoorden = termenUit(vraag) van Zoek snel, zonder woorden die alleen de bron aanduiden ("factuur", "pakje", "nummer", "afspraak"
// …). Geen kernwoord over = "te algemeen": geen bron bevraagd. Een item telt als het ALLE kernwoorden bevat (begin van een woord, zonder
// hoofdletters en accenten; zoals alleWoorden van Zoek snel). Per bron het beste item: contacten exacte naam eerst, agenda eerstvolgende
// (anders de laatste voorbije), de rest het nieuwste. Elke bron heeft een eigen tijdgrens; alles loopt tegelijk.

const ZS = require('./zoek-snel.js');
const KAL = (function () { try { return require('./kalender-app.js'); } catch (e) { return null; } })();

const BRONNEN = ['contacten', 'agenda', 'mail', 'gesprekken', 'facturen', 'bank', 'pakjes'];
const NAAM = { contacten: 'Contacten', agenda: 'Agenda', mail: 'Mail', gesprekken: 'Gesprekken', facturen: 'Facturen', bank: 'Bank', pakjes: 'Pakjes' };
const MS = { contacten: 1500, agenda: 1500, gesprekken: 2000, facturen: 1500, bank: 2500, pakjes: 1500 };
const MAX_KERN = 6;
// woorden die zeggen WAAR of WAT voor soort gegeven, niet waarover: die horen niet in de zoektocht per bron
const BRONWOORD = new Set(['factuur', 'facturen', 'nota', 'creditnota', 'pakje', 'pakjes', 'pakket', 'pakketje', 'zending', 'bestelling', 'besteld', 'bestelde',
  'geleverd', 'bezorgd', 'mail', 'mails', 'mailtje', 'email', 'e-mail', 'gemaild', 'mailde', 'afspraak', 'afspraken', 'agenda', 'gepland', 'planning',
  'betaald', 'betaalde', 'betaling', 'betalingen', 'afschrijving', 'afschrijvingen', 'bank', 'bankrekening', 'overboeking', 'transactie', 'transacties',
  'telefoon', 'telefoonnummer', 'tel', 'telnr', 'nummer', 'mobiel', 'mobielnummer', '06', 'gsm', 'adres', 'mailadres', 'emailadres', 'woonadres',
  'contact', 'contacten', 'gesprek', 'gesprekken', 'gezegd', 'zei', 'zegt', 'socev', 'bron', 'bronnen', 'laatste', 'vorige', 'volgende', 'eerstvolgende',
  'btw', 'kvk', 'agb', 'iban', 'bsn', 'uzi', 'big', 'code', 'kenteken', 'polisnummer', 'klantnummer', 'lidnummer',   // soort feit, niet waarover
  'kosten', 'kost', 'bedrag', 'prijs', 'datum', 'dag', 'wanneer', 'hoeveel', 'staat', 'stond', 'gevonden', 'zoek', 'zoeken', 'alles', 'over', 'iets']);
const TUSSEN = new Set(['van', 'de', 'der', 'den', 'ter', 'ten', 'het', 't', 'la', 'le', 'aan', 'bij', 'voor', 'met', 'naar', 'uit']);

const nNorm = function (s) { return String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase(); };
const een = function (t, max) { return String(t == null ? '' : t).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); };

function kernwoorden(vraag) {
  const uit = [];
  (ZS.termenUit(String(vraag || '')) || []).forEach(function (t) {
    nNorm(t).split(/[^\p{L}\p{N}]+/u).forEach(function (w) {
      if (!w || BRONWOORD.has(w) || TUSSEN.has(w) || uit.indexOf(w) >= 0) return;
      if (w.length < 2 && !/^\d$/.test(w)) return;
      uit.push(w);
    });
  });
  return uit.slice(0, MAX_KERN);
}
// het langste (meest onderscheidende) kernwoord: voor bronnen die zelf op één woord voorzoeken
const langste = function (kern) { return kern.slice().sort(function (a, b) { return b.length - a.length; })[0]; };
const past = function (kern, velden) { return ZS.alleWoorden(kern, velden.filter(function (v) { return v != null && v !== ''; }).join(' ')); };
const datumKort = function (iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? Number(m[3]) + '-' + Number(m[2]) + '-' + m[1] : '';
};
const euro = function (centen, inEuro) {
  const n = inEuro ? Number(centen) : Number(centen) / 100;
  if (!isFinite(n)) return '';
  return (n < 0 ? '− ' : '') + '€ ' + Math.abs(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const nieuwsteEerst = function (veld) { return function (a, b) { const x = String(a[veld] || ''), y = String(b[veld] || ''); return x < y ? 1 : x > y ? -1 : 0; }; };

function maak(opt) {
  const fout = opt.fout || function () {};
  const nu = opt.nu || Date.now;
  const masker = typeof opt.masker === 'function' ? opt.masker : function (t) { return t; };
  const b = opt.bronnen || {};
  const metTijd = function (p, ms) {
    let tm;
    return Promise.race([Promise.resolve().then(p), new Promise(function (_, weiger) { tm = setTimeout(function () { weiger(new Error('time-out')); }, ms); })])
      .finally(function () { clearTimeout(tm); });
  };
  const vandaagNl = function () { try { return new Date(nu()).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); } catch (e) { return new Date(nu()).toISOString().slice(0, 10); } };
  const kaart = function (titel, regel, doel) { return { titel: masker(een(titel, 120)), regel: masker(een(regel, 160)), doel: doel }; };

  // ── per bron: (kern) → { aantal, kaart } | null (= niets); gooit bij een storing ──
  const zoekers = {
    async contacten(kern) {
      const j = await b.contacten(langste(kern), 50);
      if (!j || j.ok !== true || !Array.isArray(j.treffers)) throw new Error('contacten: geen antwoord');
      const naamVan = function (c) { return een(c.weergavenaam || c.organisatie || '', 80); };
      const raak = j.treffers.filter(function (c) { return c && typeof c === 'object' && past(kern, [naamVan(c), c.organisatie]); });
      if (!raak.length) return null;
      const exact = function (c) { const w = nNorm(naamVan(c)).split(/[^\p{L}\p{N}]+/u); return kern.every(function (t) { return w.indexOf(t) >= 0; }) ? 0 : 1; };
      raak.sort(function (x, y) { return exact(x) - exact(y) || (naamVan(x) < naamVan(y) ? -1 : 1); });
      const c = raak[0];
      const w = ZS.contactWaarden(c, 'tel').concat(ZS.contactWaarden(c, 'mail')).slice(0, 2);
      const org = een(c.organisatie, 60);
      const m = /^people\/(c[0-9]{1,30})$/.exec(String(c.resource_name || ''));
      return { aantal: raak.length, kaart: kaart(naamVan(c) + (org && nNorm(org) !== nNorm(naamVan(c)) ? ' (' + org + ')' : ''), w.join(' · ') || 'geen nummer of mailadres',
        { soort: 'link', url: m ? 'https://contacts.google.com/person/' + m[1] : 'https://contacts.google.com/search/' + encodeURIComponent(kern.join(' ')) }) };
    },
    async agenda(kern) {
      if (!KAL) throw new Error('kalender-app.js ontbreekt');
      const vandaag = vandaagNl();
      const dag = function (n) { const d = new Date(vandaag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
      const rijen = await b.agenda(dag(-365), dag(400), ['david', 'gezin', 'socev', 'info']);
      if (!Array.isArray(rijen)) throw new Error('agenda: geen antwoord');
      const lijst = rijen.map(function (x) { return x && x.sb_kalender_tijdlijn && !x.event_id ? x.sb_kalender_tijdlijn : x; })
        .filter(function (x) { return x && typeof x === 'object' && typeof x.titel === 'string'; }).map(KAL.regel)
        .filter(function (x) { return x.van && past(kern, [x.titel].concat(x.entiteiten.map(function (e) { return e.naam; }))); });
      if (!lijst.length) return null;
      const komend = lijst.filter(function (x) { return (x.tot || x.van) >= vandaag; }).sort(function (x, y) { return x.van < y.van ? -1 : x.van > y.van ? 1 : String(x.begin || '') < String(y.begin || '') ? -1 : 1; });
      const x = komend[0] || lijst.sort(function (p, q) { return p.van > q.van ? -1 : 1; })[0];
      return { aantal: lijst.length, kaart: kaart(x.titel, (komend[0] ? '' : 'was ') + datumKort(x.van) + (x.begin ? ' ' + x.begin : ''), { soort: 'app', app: 'kalender' }) };
    },
    async gesprekken(kern) {
      // eerst de woorden samen als zin, anders het langste woord (de zoekfunctie van de gesprekken zoekt een letterlijke tekst)
      let r = await b.gesprekken(kern.join(' '));
      let op = null;
      if (r && Array.isArray(r.treffers) && !r.treffers.length && kern.length > 1) { op = langste(kern); r = await b.gesprekken(op); }
      if (!r || !Array.isArray(r.treffers)) throw new Error('gesprekken: geen antwoord');
      const t = r.treffers.filter(function (x) { return x && typeof x.job_id === 'string' && typeof x.kanaal === 'string'; })
        .sort(function (x, y) { return (Date.parse(y.t) || 0) - (Date.parse(x.t) || 0); })[0];
      if (!t) return null;
      const f = t.fragment || {};
      const wie = t.bel === 'david' ? 'jij' : 'Socev';
      return { aantal: Number(r.totaal) || r.treffers.length, kaart: kaart((f.voor || '') + (f.treffer || '') + (f.na || ''),
        datumKort(t.t) + ' · ' + wie + ' in ' + (r.kanaalNaam && r.kanaalNaam[t.kanaal] || t.kanaal) + (op ? ' · op "' + op + '"' : ''),
        { soort: 'gesprek', kanaal: t.kanaal, job_id: t.job_id, bel: t.bel === 'david' ? 'david' : 'socev', t: t.t }) };
    },
    async facturen(kern) {
      const rijen = await b.facturen(langste(kern));
      if (!Array.isArray(rijen)) throw new Error('facturen: geen antwoord');
      const raak = rijen.filter(function (f) { return f && typeof f.id === 'string' && past(kern, [f.leverancier_naam, f.lev_naam, f.nummer]); })
        .sort(nieuwsteEerst('factuurdatum'));
      if (!raak.length) return null;
      const f = raak[0];
      return { aantal: raak.length, kaart: kaart((f.leverancier_naam || f.lev_naam || 'Factuur') + (f.nummer ? ' · ' + f.nummer : ''),
        [datumKort(f.factuurdatum), f.incl_eur != null ? euro(f.incl_eur) : '', f.soort === 'creditnota' ? 'creditnota' : ''].filter(Boolean).join(' · '),
        { soort: 'factuur', id: f.id }) };
    },
    async bank(kern) {
      const j = await b.bank(langste(kern));
      if (!j || j.ok !== true || !Array.isArray(j.posten)) throw new Error('bank: geen antwoord');
      const raak = j.posten.filter(function (p) { return p && past(kern, [p.tegenpartij, p.omschrijving, p.ai_omschrijving, p.categorie, p.subcategorie]); })
        .sort(nieuwsteEerst('datum'));
      if (!raak.length) return null;
      const p = raak[0];
      // bank-lezer geeft de nieuwste 200 en het echte totaal: met één kernwoord is dat totaal het aantal
      return { aantal: kern.length === 1 && Number(j.aantal) >= raak.length ? Number(j.aantal) : raak.length, kaart: kaart(p.tegenpartij || p.ai_omschrijving || p.omschrijving || 'Post',
        [datumKort(p.datum), euro(p.bedrag, true), p.rekening].filter(Boolean).join(' · '), { soort: 'app', app: 'financien' }) };
    },
    async pakjes(kern) {
      const j = await b.pakjes();
      const body = j && j.body ? j.body : j;
      if (!body || !Array.isArray(body.lopend)) throw new Error('pakjes: geen antwoord');
      const alle = body.lopend.concat(Array.isArray(body.eerder) ? body.eerder : []);
      const raak = alle.filter(function (z) { return z && past(kern, [z.winkel, z.omschrijving, z.onderwerp, z.vervoerder, z.code, z.bestelnr]); })
        .sort(nieuwsteEerst('laatst'));
      if (!raak.length) return null;
      const z = raak[0];
      return { aantal: raak.length, kaart: kaart([z.winkel, z.omschrijving || z.onderwerp].filter(Boolean).join(' · ') || z.vervoerder || 'Pakje',
        [z.stand_tekst || z.stand, z.vervoerder, datumKort(z.bezorgd_op || z.verwacht_dag || z.laatst)].filter(Boolean).join(' · '), { soort: 'app', app: 'pakjes' }) };
    },
  };

  // vraag → { kern, bronnen: [{ bron, naam, stand, aantal?, kaart?, ms }], ms }
  // stand: gevonden | niets | niet_bereikt (fout of time-out) | uit (uitgezet of niet ingericht) | op_tik (Mail: pas op Davids tik) | te_algemeen
  async function zoek(vraag, o) {
    const t0 = nu();
    const uitgezet = new Set(Array.isArray(o && o.uit) ? o.uit : []);
    const kern = kernwoorden(vraag);
    const res = await Promise.all(BRONNEN.map(async function (bron) {
      const basis = { bron: bron, naam: NAAM[bron] };
      if (uitgezet.has(bron)) return Object.assign(basis, { stand: 'uit', ms: 0 });
      if (!kern.length) return Object.assign(basis, { stand: 'te_algemeen', ms: 0 });
      if (bron === 'mail') {   // Codex-review MOET 1: geen automatische zoekvraag naar Gmail; het kaartje zoekt pas op Davids tik (App Mail)
        return Object.assign(basis, { stand: 'op_tik', ms: 0, kaart: { titel: 'Zoek in Mail op "' + een(kern.join(' '), 80) + '"', regel: 'Gmail, alle mail', doel: { soort: 'mail', q: kern.join(' ') } } });
      }
      if (typeof b[bron] !== 'function') return Object.assign(basis, { stand: 'uit', ms: 0 });
      const t1 = nu();
      try {
        const r = await metTijd(function () { return zoekers[bron](kern); }, (o && o.ms && o.ms[bron]) || MS[bron]);
        return Object.assign(basis, r ? { stand: 'gevonden', aantal: r.aantal, kaart: r.kaart } : { stand: 'niets' }, { ms: nu() - t1 });
      } catch (e) {
        fout('zoek-overal-' + bron, e);
        return Object.assign(basis, { stand: 'niet_bereikt', ms: nu() - t1 });
      }
    }));
    return { kern: kern, bronnen: res, ms: nu() - t0 };
  }
  return { zoek: zoek };
}

module.exports = { maak: maak, kernwoorden: kernwoorden, BRONNEN: BRONNEN, NAAM: NAAM };
