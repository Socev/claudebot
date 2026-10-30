'use strict';
/*
 * Werkstroom (wv2002; ontwerp vault "01_Ontwikkeling/Werkstroom - één lichte werkplek voor MailMan, Intake en Facturen (ontwerp 29-10-2026).md"
 * § 4 en § 6). Eén lichte werkplek in een eigen venster van de Socev-app: links de stappen met een teller "klaar voor jou", per stap één
 * regel per stuk. Hier alleen LEZEN, uit wat er al is:
 *   MailMan  — mailman.js werkstroomTel/werkstroomLijst (twijfel open, besluiten 48 u, verwerkt 7 d; velden van het logboek)
 *   Intake   — intake-router.js werkstroomTel/appWerkstroom (wacht op David, binnen 48 u buiten Gmail, verwerkt 7 d; de privacygrens van
 *              het Router-overzicht: van een niet-beoordeeld stuk alleen status, tijd, bron en soorten kenmerken)
 *   Facturen — de bestaande GET-routes van facturen.js (/app/facturen en /app/facturen/lijst/beoordelen) met Davids rol
 *   Verkoop  — (wv2008, W4) mailman.js GET /app/mailman/verkoop (verkoopTab, wv1998: het journaal van de verkoopnota's in Doktersmaten
 *              met per nota fase en open). Alleen fase, open, status, tijden, ankers, nummer, bedrag en de foutreden gaan door; nooit
 *              onderwerp, afzender, naam of bestandsnaam (bestandsnaam = vaak een patiëntnaam). Teller "klaar voor jou" = wat open is én
 *              bij David ligt (zelf doorsturen, onzeker, geweigerd, mislukt, archief mislukt); wat MailMan nog doet telt apart (bezig).
 * Geen nieuwe opslag, geen schrijfroutes: de knoppen in het venster gebruiken de bestaande POST-routes. Elke bron los afgevangen met een
 * tijdgrens: één bron stuk = die stap "niet te lezen", de rest blijft.
 * Paden (doorgeefluik: kleine letters, geen querystring): GET /app/werkstroom en GET /app/werkstroom/lijst/<stap>[/<postvak>], postvak als
 * bronsleutel (gmail-david, gmail-groenhouten, outlook-tolgaarde, scanner-scansnap).
 */

const STAPPEN = ['binnen', 'besluit', 'twijfel', 'intake', 'facturen', 'verkoop', 'verwerkt'];
// Verkoop: open fasen die bij David liggen (de rest van open wacht op MailMan zelf: pdf-toets, doorsturen, archiveren)
const VK_DAVID = ['zelf', 'blijft', 'onzeker', 'geweigerd', 'mislukt', 'archief_mislukt'];
const MAX = 200;
const PRIVE = 'gmail:david';   // afgeschermd op een vaste plek die afschermt (appAfscherm; sinds wv1901 uit)

// Eén journaalrij van verkoopTab → alleen wat de werkstroom mag tonen (allowlist; nieuwe velden in mailman.js gaan nooit vanzelf mee)
function verkoopRij(r) {
  const tijd = function (x) { return typeof x === 'string' ? x : null; };
  const pdfs = (Array.isArray(r.pdfs) ? r.pdfs : []).map(function (x) {
    return { vacshing: !!(x && x.vacshing), shingrix: !!(x && x.shingrix), overgeslagen: !!(x && x.overgeslagen),
      nummer: x && typeof x.nummer === 'string' ? x.nummer.slice(0, 40) : null, bedrag_cent: x && Number.isSafeInteger(x.bedrag_cent) ? x.bedrag_cent : null };
  });
  return { id: r.id, fase: String(r.fase || ''), open: !!r.open, bij_david: !!r.open && VK_DAVID.indexOf(r.fase) >= 0, status: String(r.status || ''),
    ontvangen: tijd(r.ontvangen), kandidaat: tijd(r.kandidaat), getoetst: tijd(r.getoetst), aangeboden: tijd(r.aangeboden), verstuurd: tijd(r.verstuurd),
    gearchiveerd: tijd(r.gearchiveerd), bijgewerkt: tijd(r.bijgewerkt), archief_pogingen: Number.isSafeInteger(r.archief_pogingen) ? r.archief_pogingen : 0,
    fout: typeof r.fout === 'string' ? r.fout.slice(0, 120) : null,
    ankers: pdfs.some(function (x) { return x.vacshing && x.shingrix; }), pdfs };
}

function sleutelVan(id) { return String(id || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function maak(o) {
  const ms = o.tijdMs || 8000;
  const nu = o.nu || Date.now;
  // Eén bron: resultaat of { fout: true }; een fout gaat naar het log, nooit naar het scherm (geen interne tekst naar buiten)
  async function bron(naam, f) {
    let t;
    try {
      return await Promise.race([Promise.resolve().then(f), new Promise(function (_, nee) { t = setTimeout(function () { nee(new Error('te traag')); }, ms); })]);
    } catch (e) {
      if (o.fout) { try { o.fout('werkstroom-' + naam, e); } catch (e2) { /* niets */ } }
      return { fout: true };
    } finally { clearTimeout(t); }
  }
  const mm = function () { const m = o.mailman && o.mailman(); if (!m || typeof m.werkstroomTel !== 'function') throw new Error('MailMan niet geladen'); return m; };
  const ir = function () { const r = o.intake && o.intake(); if (!r || typeof r.werkstroomTel !== 'function') throw new Error('Intake-router niet geladen'); return r; };
  const vk = function () {   // wv2008: het journaal van wv1998 (alleen lezen); geen postvak Doktersmaten = lege stap
    const r = mm().app('GET /app/mailman/verkoop', {});
    if (!r || r.status !== 200 || !r.j) throw new Error('verkoop ' + (r && r.status));
    const v = r.j.verkoop;
    if (!v) return { postvak: null, stand: r.j.stand || 'uit', door: false, archief: false, rijen: [] };
    return { postvak: v.postvak, stand: r.j.stand || 'uit', door: !!v.door, archief: !!v.archief, rijen: (v.journaal || []).filter(function (x) { return x.fase !== 'niet_herkend'; }).map(verkoopRij) };
  };
  const fac = function (pad, opt) { if (!o.facturen) throw new Error('Facturen niet geladen'); const r = o.facturen(pad, opt || {}); if (!r || r.status !== 200) throw new Error('facturen ' + (r && r.status)); return r.j; };

  async function tellers(opt) {
    const af = !!(opt && opt.afscherm);
    const [m, i, f, v] = await Promise.all([
      bron('mailman', function () { return { pv: mm().werkstroomTel().filter(function (p) { return !(af && p.id === PRIVE); }) }; }),
      bron('intake', function () { return ir().werkstroomTel(); }),
      bron('facturen', function () { return fac('/app/facturen', opt).tellers || {}; }),
      bron('verkoop', vk),
    ]);
    const som = function (veld) { return m.fout ? 0 : m.pv.reduce(function (a, p) { return a + (p[veld] || 0); }, 0); };
    const t = {
      binnen: m.fout && i.fout ? { fout: true } : { wacht: null, totaal: som('binnen') + (i.fout ? 0 : i.binnen || 0), deels: m.fout || i.fout || undefined },
      besluit: m.fout ? { fout: true } : { wacht: null, totaal: som('binnen') },
      twijfel: m.fout ? { fout: true } : { wacht: som('twijfel_open'), per: m.pv.reduce(function (a, p) { a[sleutelVan(p.id)] = p.twijfel_open || 0; return a; }, {}) },
      intake: i.fout ? { fout: true } : { wacht: (i.twijfel || 0) + (i.vastgehouden || 0), twijfel: i.twijfel || 0, vastgehouden: i.vastgehouden || 0 },
      facturen: f.fout ? { fout: true } : { wacht: f.beoordelen || 0, betalen: f.betalen || 0, bankcontrole: f.bankcontrole || 0 },
      verkoop: v.fout ? { fout: true } : { wacht: v.rijen.filter(function (r) { return r.bij_david; }).length,
        bezig: v.rijen.filter(function (r) { return r.open && !r.bij_david; }).length, totaal: v.rijen.length },
      verwerkt: m.fout && i.fout ? { fout: true } : { wacht: null, totaal: som('verwerkt') + (i.fout ? 0 : i.verwerkt || 0), deels: m.fout || i.fout || undefined },
    };
    return { ok: true, tellers: t, stappen: STAPPEN, postvakken: m.fout ? [] : m.pv.map(function (p) { return { sleutel: sleutelVan(p.id), id: p.id, naam: p.naam, stand: p.stand }; }),
      bijgewerkt: new Date(nu()).toISOString() };
  }

  // Lijst van één stap: { regels: [{ sleutel, bron, tijd, postvak, mm | stuk | factuur }], mailman?, intake?, fouten }
  async function lijst(stap, pvSleutel, opt) {
    if (STAPPEN.indexOf(stap) < 0) return null;
    const af = !!(opt && opt.afscherm);
    const wilMm = stap === 'binnen' || stap === 'besluit' || stap === 'twijfel' || stap === 'verwerkt';
    const wilIk = stap === 'binnen' || stap === 'intake' || stap === 'verwerkt';
    const pvVan = function (bronId) { return !pvSleutel || sleutelVan(bronId) === pvSleutel; };
    const [m, i, f, v] = await Promise.all([
      wilMm ? bron('mailman', function () {
        const pvs = mm().werkstroomTel().map(function (p) { return p.id; }).filter(function (id) { return pvVan(id) && !(af && id === PRIVE); });
        if (!pvs.length) return { rijen: [], postvakken: [] };
        const uit = { rijen: [], postvakken: [], afgekapt: false };
        for (const id of pvs) {   // per postvak (werkstroomLijst kent één of alle); hooguit twee postvakken
          const x = mm().werkstroomLijst(stap === 'besluit' ? 'binnen' : stap, id);
          if (!x) continue;
          uit.rijen = uit.rijen.concat(x.rijen);
          uit.afgekapt = uit.afgekapt || !!x.afgekapt;
          uit.postvakken = uit.postvakken.concat(x.postvakken);
        }
        return uit;
      }) : null,
      wilIk ? bron('intake', function () { return ir().appWerkstroom(stap === 'intake' ? 'wacht' : stap, MAX + 1); }) : null,
      stap === 'facturen' && !pvSleutel ? bron('facturen', function () { return fac('/app/facturen/lijst/beoordelen', opt); }) : null,
      stap === 'verkoop' ? bron('verkoop', vk) : null,
    ]);
    let regels = [];
    const fouten = [];
    if (m && m.fout) fouten.push('mailman');
    else if (m) regels = regels.concat(m.rijen.map(function (r) { return { sleutel: 'mm-' + r.id, bron: 'mailman', postvak: r.postvak, tijd: r.ontvangen || r.tijd, mm: r }; }));
    if (i && i.fout) fouten.push('intake');
    else if (i) regels = regels.concat(i.stukken.slice(0, MAX).filter(function (s) { return pvVan(s.bron) && !(af && s.bron === PRIVE); })
      .map(function (s) { return { sleutel: 'ik-' + s.stuk_id, bron: 'intake', postvak: s.bron, tijd: s.op, stuk: s }; }));
    if (f && f.fout) fouten.push('facturen');
    else if (f) regels = regels.concat((f.facturen || []).map(function (x) { return { sleutel: 'fac-' + x.id, bron: 'facturen', postvak: null, tijd: x.aangemaakt_op || null, factuur: x }; }));
    if (v && v.fout) fouten.push('verkoop');
    else if (v && (!pvSleutel || (v.postvak && sleutelVan(v.postvak) === pvSleutel)))
      regels = regels.concat(v.rijen.map(function (r) { return { sleutel: 'vk-' + r.id, bron: 'verkoop', postvak: v.postvak, tijd: r.ontvangen || r.kandidaat, verkoop: r }; }));
    // wachtende stappen: oudste eerst (ontwerp § 4.2); overzichtsstappen: nieuwste eerst. Verkoop: wat bij David ligt bovenaan (oudste eerst),
    // dan wat MailMan nog doet, dan de rest (nieuwste eerst)
    const oudsteEerst = stap === 'twijfel' || stap === 'intake' || stap === 'facturen';
    const rang = function (r) { return !r.verkoop ? 0 : r.verkoop.bij_david ? 0 : r.verkoop.open ? 1 : 2; };
    regels.sort(function (a, b) {
      const ra = rang(a), rb = rang(b);
      if (ra !== rb) return ra - rb;
      const x = String(a.tijd || ''), y = String(b.tijd || ''), oud = oudsteEerst || (a.verkoop && ra < 2);
      return oud ? (x < y ? -1 : x > y ? 1 : 0) : (x < y ? 1 : x > y ? -1 : 0);
    });
    // afgekapt: een bron gaf meer dan 200 (per bron gevraagd met LIMIT 201), of samen meer dan 200 (review wv2002 KAN 7)
    const afgekapt = regels.length > MAX || !!(m && !m.fout && m.afgekapt) || !!(i && !i.fout && i.stukken.length > MAX);
    return { ok: true, stap, postvak: pvSleutel || null, regels: regels.slice(0, MAX), afgekapt,
      mailman: m && !m.fout ? { postvakken: m.postvakken } : undefined,
      intake: i && !i.fout ? { live: i.live, entiteiten: i.entiteiten } : undefined,
      verkoop: v && !v.fout ? { stand: v.stand, door: v.door, archief: v.archief } : undefined,
      fouten, bijgewerkt: new Date(nu()).toISOString() };
  }

  // Route: { status, j } of null (niet van ons)
  async function app(route, opt) {
    if (route === 'GET /app/werkstroom') return { status: 200, j: await tellers(opt) };
    const m = /^GET \/app\/werkstroom\/lijst\/([a-z]{3,12})(?:\/([a-z0-9-]{2,40}))?$/.exec(route);
    if (!m) return { status: 404, j: { ok: false, fout: 'onbekend' } };
    const uit = await lijst(m[1], m[2] || null, opt);
    return uit ? { status: 200, j: uit } : { status: 404, j: { ok: false, fout: 'onbekende stap' } };
  }

  return { app, tellers, lijst };
}

module.exports = { maak, STAPPEN, sleutelVan };
