// financien-app.js — App Financiën (wv771; bouwplan idee 16 § 11). Eén alleen-lees overzicht voor de Socev-app: tegels deze maand,
// verloop per maand en categorie (24 maanden), vaste lasten met opzeglink, signalen (alleen gemeten, met één zin reden), geldstroom per
// rekeningpaar en de PayPal-diensten. Geen netwerk, geen taalmodel; rekent met de functies van bank-archief.js en paypal-bewijs.js op
// dezelfde database. bank-lezer.js (opdracht app-financien) roept dit aan; de pod geeft het door aan GET /app/financien.
//
// Het antwoord wordt veld voor veld opgebouwd (nooit een bankobject doorgeven; Fable wv771 #9): geen IBAN of rekeningnummer, geen
// machtiging, geen omschrijving, geen losse posten, geen saldo behalve de dekking van de vaste-lastenrekening. Steun heet "Steun (vast)",
// een externe rekening "extern", een PayPal-ontvanger of een naam onder "dubbel" alleen als hij in de linkslijst staat (kan een persoon
// zijn). Een fout in één blok maakt alleen dat blok leeg; de foutmelding is generiek (geen tegenpartij in api.log; Fable #17).
// Dit bestand schrijft niets; bank-lezer.js (archiefKlaar) werkt vóór het lezen wel de cache en de indeling bij, zoals bij elke leesopdracht.
//
// Opzeglinks (Fable #8): de vault-pagina levert link, soort, bron en datum; de host moet in LINK_HOSTS staan voor dat herkenwoord
// (allowlist in de code, gaat mee in de review van elke uitrol). Alleen https, geen gebruikersnaam of poort, host exact in de lijst.
'use strict';
const fs = require('fs'), path = require('path');

const LINK_PAGINA = path.join('20_Prive', 'Financien', 'Opzeglinks vaste lasten.md');
// herkenwoord (kleine letters, deel van de naam op de bank of in PayPal) → toegestane hosts. Gecontroleerd 22-10-2026 (wv771).
const LINK_HOSTS = {
  'kpn - mobiel': ['www.kpn.com'], 'kpn b.v.': ['www.kpn.com'], tibber: ['tibber.com'], 'unive zorg': ['www.unive.nl'],
  'vvaa schadeverzekeringen': ['www.vvaa.nl'], 'vvaa financ': ['www.vvaa.nl'], eteck: ['www.eteck.nl'], pwn: ['www.pwn.nl', 'mijn.pwn.nl'],
  'taf bv': ['taf.nl', 'mijn.taf.nl'], natuurmonumenten: ['www.natuurmonumenten.nl'], npo: ['npo.nl'], 'van den tol': ['vandentolopticiens.nl'],
  'mkb lease': ['www.mkblease.nl'], netflix: ['help.netflix.com'], disney: ['help.disneyplus.com'], spotify: ['support.spotify.com'],
  apple: ['support.apple.com'], 'google play': ['support.google.com'], youtube: ['support.google.com'], videoland: ['hulp.videoland.com'],
  microsoft: ['support.microsoft.com'], dropbox: ['help.dropbox.com'], audible: ['help.audible.com'],
};
const LINK_SOORTEN = ['opzeggen', 'account', 'contact'];
// betaaldienstverleners en banken: dezelfde naam op twee rekeningen zegt niets over een dubbel abonnement (Fable #7)
const PSP = /(buckaroo|mollie|adyen|tikkie|multisafepay|paypal|stripe|\bccv\b|worldline|sumup|klarna|pay\.nl|google|apple|ing bank|abn amro|bunq|rabobank|ideal)/i;
const SIGNAAL_SOORTEN = ['duurder', 'prijsstap', 'lager', 'weg', 'nieuw', 'dubbel', 'energie', 'buffer', 'dekking'];
const MAANDEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function r2(n) { return Math.round(n * 100) / 100; }
function getal(n) { return typeof n === 'number' && Number.isFinite(n) ? r2(n) : null; }
function veilig(s, n) { return String(s == null ? '' : s).normalize('NFC').replace(/[^\p{L}\p{N} .,&'()\-/+]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 40).trim(); }
function norm(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function vandaag() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function plusDagen(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function plusMaanden(d, n) {
  const j = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1 + n, dg = Number(d.slice(8, 10) || 1);
  const jj = j + Math.floor(m / 12), mm = ((m % 12) + 12) % 12, max = new Date(Date.UTC(jj, mm + 1, 0)).getUTCDate();
  return jj + '-' + String(mm + 1).padStart(2, '0') + '-' + String(Math.min(dg, max)).padStart(2, '0');
}
function maandPlus(m, n) { return plusMaanden(m + '-01', n).slice(0, 7); }
function mndJaar(d) { return d ? MAANDEN[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4) : ''; }
function eur(n) { const v = Math.abs(r2(n)).toFixed(2).split('.'); return (n < -0.004 ? '− ' : '') + '€ ' + v[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + v[1]; }
function woordRe(w) { return new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])'); }
function peildag(a) {
  const m = (a.db.prepare("SELECT max(datum) d FROM transacties WHERE status IN ('booked', 'pending')").get() || {}).d;
  return m && m > vandaag() ? m : vandaag();
}

// ── opzeglinks en bewuste uitzonderingen uit de vault ──
// Tabel 1 (onder "## Links"): | Aanbieder | Herkenwoord | Link | Soort | Bron | Gecontroleerd |
// Tabel 2 (onder "## Bewust"): | Herkenwoord | Signaal | Sinds | Op woord van David |  — dempt een signaal dat David al kent
function leesLinks(vaultDir) {
  const uit = { links: [], bewust: [], genegeerd: 0, gelezen: false };
  let t;
  try { t = fs.readFileSync(path.join(vaultDir, LINK_PAGINA), 'utf8'); } catch (e) { return uit; }
  if (t.length > 200000) return uit;
  uit.gelezen = true;
  let sectie = '';
  t.split('\n').forEach(function (regel) {
    const kop = /^##\s+(.+)$/.exec(regel);
    if (kop) { sectie = /^links/i.test(kop[1].trim()) ? 'links' : /^bewust/i.test(kop[1].trim()) ? 'bewust' : ''; return; }
    if (!/^\s*\|/.test(regel) || /^\s*\|\s*:?-{2,}/.test(regel)) return;
    const c = regel.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (x) { return x.trim(); });
    if (sectie === 'links') {
      if (c.length < 6 || /^aanbieder$/i.test(c[0])) return;
      const l = linkGeldig(c);
      if (l) uit.links.push(l); else uit.genegeerd++;
    } else if (sectie === 'bewust') {
      if (c.length < 4 || /^herkenwoord$/i.test(c[0])) return;
      const h = norm(c[0]), s = norm(c[1]);
      if (h.length >= 3 && (s === '*' || SIGNAAL_SOORTEN.indexOf(s) >= 0) && c[3]) uit.bewust.push({ herken: h, signaal: s });
    }
  });
  return uit;
}
function linkGeldig(c) {
  const herken = norm(c[1]), soort = norm(c[3]), bron = c[4], datum = c[5];
  if (herken.length < 3 || !Object.hasOwn(LINK_HOSTS, herken)) return null;
  if (LINK_SOORTEN.indexOf(soort) < 0 || !bron || !/^\d{1,2}-\d{1,2}-\d{4}$/.test(datum)) return null;
  const ruw = c[2].replace(/^<|>$/g, '').trim();
  let u;
  try { u = new URL(ruw); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !/^[a-z0-9.-]+$/.test(u.hostname)) return null;
  if (LINK_HOSTS[herken].indexOf(u.hostname) < 0) return null;
  return { herken: herken, url: u.href, host: u.hostname, soort: soort, gecontroleerd: datum, aanbieder: veilig(c[0], 40) };
}
// Precies één herkenwoord op woordgrens in de naam, anders geen link (Fable #8)
function linkVoor(naam, links) {
  const n = norm(naam);
  if (!n) return null;
  const hits = links.filter(function (l) { return woordRe(l.herken).test(n); });
  const woorden = new Set(hits.map(function (l) { return l.herken; }));
  if (woorden.size !== 1) return null;
  const l = hits[0];
  return { url: l.url, host: l.host, soort: l.soort, gecontroleerd: l.gecontroleerd };
}
function bekend(naam, links) { return !!linkVoor(naam, links); }
function gedempt(s, bewust) {
  const n = norm(s.naam || '');
  return bewust.some(function (b) { return (b.signaal === '*' || b.signaal === s.soort) && n && woordRe(b.herken).test(n); });
}

// ── welke maanden volledig zijn ──
// Een maand telt als volledig als elke eigen rekening die nu nog posten heeft (laatste 60 dagen) toen al gekoppeld was. Bij de gezamenlijke
// rekening (koppeling vanaf 30-4-2025) is dat mei 2025. bunq levert de hele historie: daar is de eerste post de opening van de rekening,
// geen begin van de koppeling (een in juli 2026 geopende rekening maakt eerdere maanden niet onvolledig).
function volledigVanaf(A, a, nu) {
  const start = A.archiefStart(a);
  const reks = a.db.prepare("SELECT r.rek, r.bron, r.eigenaar, (SELECT max(datum) FROM transacties t WHERE t.rek = r.rek AND t.status IN ('booked', 'pending')) AS laatst FROM rekeningen r").all();
  let v = null;
  reks.forEach(function (r) {
    if (r.bron === 'bunq' || /^(extern|pot)$/i.test(String(r.eigenaar || '')) || !r.laatst || r.laatst < plusDagen(nu, -60)) return;
    const s = start.get(r.rek);
    if (!s) return;
    const m = s.slice(8, 10) === '01' ? s.slice(0, 7) : maandPlus(s.slice(0, 7), 1);
    if (!v || m > v) v = m;
  });
  return v;
}
function vasteRekening(a) {
  const l = a.db.prepare('SELECT rek, bron, eigenaar FROM rekeningen').all().filter(function (r) { return r.bron !== 'bunq' && !/^(extern|pot)$/i.test(String(r.eigenaar || '')); });
  return l.length === 1 ? l[0].rek : null;
}
function rekNaam(n, extern) { return extern ? 'extern' : (veilig(n, 30) || 'eigen rekening'); }

// ── de blokken ──
function blokMaand(A, a, m) {
  const r = A.maand(a, { maand: m });
  return { maand: m, in: getal(r.totaal_in), uit: getal(-r.totaal_uit), posten: r.posten | 0, nog_niet_ingedeeld: r.nog_niet_ingedeeld | 0 };
}
function blokVerloop(A, a, mNu, vanaf) {
  const maanden = [], totCat = new Map();
  for (let i = 23; i >= 0; i--) {
    const m = maandPlus(mNu, -i), r = A.maand(a, { maand: m }), cats = {};
    (r.per_categorie || []).forEach(function (c) {
      if (!(c.uit < 0)) return;
      const k = veilig(c.categorie, 40) || 'overig';
      cats[k] = r2((cats[k] || 0) - c.uit);
      totCat.set(k, (totCat.get(k) || 0) - c.uit);
    });
    maanden.push({ maand: m, in: getal(r.totaal_in), uit: getal(-r.totaal_uit), lopend: m === mNu || undefined,
      volledig: !!(vanaf && m >= vanaf && m < mNu), categorieen: cats });
  }
  const categorieen = Array.from(totCat.entries()).sort(function (x, y) { return y[1] - x[1]; }).map(function (x) { return x[0]; });
  return { maanden: maanden, categorieen: categorieen, volledig_vanaf: vanaf };
}
function rijMatch(x, lijst) { return lijst.find(function (y) { return y.sleutels.some(function (k) { return x.sleutels.indexOf(k) >= 0; }); }) || null; }
function aantalIn(rij, reeksen) { return reeksen.filter(function (r) { return rij.sleutels.indexOf(r.sleutel) >= 0; }).reduce(function (s, r) { return s + (r.aantal || 0); }, 0); }
function isPaypal(x) { return /paypal/i.test(String(x.naam || '')); }
function wissel(x) { return x.wijze === 'wisselend' || x.wijze === 'schommelt'; }
function toonNaam(x) {
  if (isPaypal(x)) return 'PayPal';
  return veilig(x.naam, 30) || veilig(x.soort_post, 30) || 'Zonder naam';
}
// Vergelijkbaar bedrag: termijnreeksen op het termijnbedrag (aantal termijnen kan van aangenomen naar gemeten gaan; Fable #4)
function vergelijkBedrag(x) { return x.ritme === 'termijnen' ? x.bedrag : x.per_maand; }
function naarPerMaand(x, d) { return x.ritme === 'termijnen' ? d * (x.termijnen || 10) / 12 : d; }

function blokVasteLasten(A, a, nu, links, signalen) {
  const rek = vasteRekening(a);
  if (!rek) return { geen: 'nog geen gezamenlijke vaste-lastenrekening gekoppeld' };
  const vl = A.vasteLasten(a, { rek: rek });
  const start = A.archiefStart(a).get(rek) || null, st = {};
  st[rek] = start;
  const p = A.vastePosten(a, rek);
  const refJaar = plusMaanden(nu, -12), refDrie = plusDagen(nu, -91);
  const reeksNu = A.reeksenBereken(p.lasten, { ref: nu, start: st }).filter(function (x) { return x.actief; });
  const reeksJaar = A.reeksenBereken(p.lasten, { ref: refJaar, start: st }).filter(function (x) { return x.actief; });
  const reeksDrie = A.reeksenBereken(p.lasten, { ref: refDrie, start: st }).filter(function (x) { return x.actief; });
  const rijen = A.rijenVan(reeksNu), jaar = A.rijenVan(reeksJaar), drie = A.rijenVan(reeksDrie);
  // wisselende posten alleen vergelijken als het gemiddelde van een jaar geleden zelf al een heel jaar besloeg (Fable #3)
  const jaarVol = !!(start && start <= plusMaanden(refJaar, -12));
  const gebruikt = new Set();
  const uit = rijen.map(function (x) {
    const j = rijMatch(x, jaar), d = rijMatch(x, drie);
    if (j) gebruikt.add(j);
    const naam = toonNaam(x), link = isPaypal(x) ? null : linkVoor(x.naam, links);
    let jaarGeleden = null;
    if (j && aantalIn(j, reeksJaar) >= 3 && x.wijze !== 'dalend' && j.wijze !== 'dalend' && !((wissel(x) || wissel(j)) && !jaarVol) && !isPaypal(x)) {
      const oud = vergelijkBedrag(j), nieuw = vergelijkBedrag(x);
      if (oud > 0 && x.ritme === j.ritme) {
        jaarGeleden = { per_maand: getal(j.per_maand), bedrag: getal(j.bedrag) };
        const dPm = naarPerMaand(x, nieuw - oud), pct = (nieuw - oud) / oud;
        if (dPm > 5 && pct > 0.05) signalen.push({ soort: 'duurder', naam: naam, toon: 'wacht', post: naam,
          zin: naam + (x.soort_post ? ' (' + veilig(x.soort_post, 30).toLowerCase() + ')' : '') + ' kost nu ' + eur(x.per_maand) + ' per maand; een jaar geleden ' + eur(j.per_maand) + ' (+' + Math.round(pct * 100) + '%).', link: link });
        else if (dPm < -5 && pct < -0.05) signalen.push({ soort: 'lager', naam: naam, toon: 'info', post: naam,
          zin: naam + ' kost nu ' + eur(x.per_maand) + ' per maand; een jaar geleden ' + eur(j.per_maand) + '.' });
      }
    }
    // recente prijsstap (laatste 90 dagen): één reeks met bedrag_vorig, of meerdere reeksen (KPN) tegen de stand van drie maanden terug
    if (!isPaypal(x) && x.wijze !== 'dalend' && !wissel(x) && !signalen.some(function (s) { return s.soort === 'duurder' && s.post === naam; })) {
      if (x.reeksen === 1 && x.bedrag_vorig != null && x.gewijzigd_op && x.gewijzigd_op >= plusDagen(nu, -90) && x.bedrag > x.bedrag_vorig + 0.005)
        signalen.push({ soort: 'prijsstap', naam: naam, toon: 'wacht', post: naam, link: link,
          zin: naam + ': sinds ' + mndJaar(x.gewijzigd_op) + ' ' + eur(x.bedrag) + ' in plaats van ' + eur(x.bedrag_vorig) + (x.ritme !== 'maand' ? ' per ' + x.ritme : '') + '.' });
      else if (x.reeksen > 1 && d && x.per_maand - d.per_maand >= 0.5 && d.per_maand > 0 && (x.per_maand - d.per_maand) / d.per_maand > 0.03)
        signalen.push({ soort: 'prijsstap', naam: naam, toon: 'wacht', post: naam, link: link,
          zin: naam + ' samen nu ' + eur(x.per_maand) + ' per maand; drie maanden geleden ' + eur(d.per_maand) + '.' });
    }
    if (!j && !x.start_afgekapt && x.eerste > refJaar && x.soort === 'abonnement' && !isPaypal(x))
      signalen.push({ soort: 'nieuw', naam: naam, toon: 'info', post: naam, link: link, zin: naam + ' is nieuw sinds ' + mndJaar(x.eerste) + ': ' + eur(x.per_maand) + ' per maand.' });
    const n = x.onderdelen ? x.onderdelen.reduce(function (s, o) { return s + (o.aantal || 1); }, 0) : 1;
    if (isPaypal(x) && x.onderdelen) x.onderdelen.forEach(function (o) {
      if (o.aantal >= 2) signalen.push({ soort: 'dubbel', naam: 'PayPal', toon: 'wacht', post: 'PayPal ' + o.bedrag,
        zin: o.aantal + ' keer ' + eur(o.bedrag) + ' per maand via PayPal: ' + o.aantal + ' abonnementen of één dubbel?' });
    });
    return { naam: naam, soort_post: veilig(x.soort_post, 30) || null, categorie: veilig(x.categorie, 40) || null, soort: x.soort === 'vast' ? 'vast' : 'abonnement',
      ritme: ['maand', 'kwartaal', 'jaar', 'termijnen'].indexOf(x.ritme) >= 0 ? x.ritme : 'gemengd', termijnen: x.ritme === 'termijnen' ? (x.termijnen | 0) || null : undefined,
      termijnen_aangenomen: x.ritme === 'termijnen' && x.termijnen_bron === 'aangenomen' ? true : undefined,
      per_maand: getal(x.per_maand), bedrag: getal(x.bedrag), wijze: ['vast', 'dalend', 'wisselend', 'schommelt'].indexOf(x.wijze) >= 0 ? x.wijze : undefined,
      bedrag_min: wissel(x) ? getal(x.bedrag_min) : undefined, bedrag_max: wissel(x) ? getal(x.bedrag_max) : undefined,
      sinds: x.start_afgekapt ? null : x.eerste, gewijzigd_op: x.gewijzigd_op || null, bedrag_vorig: x.reeksen === 1 && x.bedrag_vorig != null ? getal(x.bedrag_vorig) : undefined,
      jaar_geleden: jaarGeleden, onderdelen: x.reeksen > 1 ? n : undefined, link: link };
  });
  // weg: liep een jaar geleden (≥ 3 posten), nu geen actieve reeks meer (Fable #2: niet "lager", niet dalend)
  jaar.forEach(function (j) {
    if (gebruikt.has(j) || rijMatch(j, rijen) || j.per_maand < 5 || aantalIn(j, reeksJaar) < 3 || isPaypal(j)) return;
    const naam = toonNaam(j);
    signalen.push({ soort: 'weg', naam: naam, toon: 'info', post: naam, zin: 'Navragen: ' + naam + ' liep een jaar geleden nog (' + eur(j.per_maand) + ' per maand) en nu niet meer. Klopt dat?' });
  });
  return { rekening: veilig(vl.rekening, 30) || 'Vaste lasten', vanaf: vl.vanaf || null, peildatum: vl.peildatum, totaal_per_maand: getal(vl.totaal_per_maand),
    posten: uit.length, rijen: uit,
    steun: (vl.steun || []).map(function (s) { return { naam: 'Steun (vast)', per_maand: getal(s.per_maand), dag: s.dag | 0 }; }),
    vaste_storting: (vl.vaste_storting || []).map(function (s) { return { van: veilig(s.van, 30) || 'eigen rekening', bedrag: getal(s.bedrag), dag: s.dag | 0 }; }) };
}
function blokStroom(A, a, m) {
  const s = A.stroom(a, { maand: m });
  return { maand: m, peildatum: s.peildatum, paren: (s.overboekingen || []).slice(0, 40).map(function (o) {
    return { van: rekNaam(o.van, false), naar: rekNaam(o.naar, !!o.extern), extern: o.extern ? true : undefined, aantal: o.aantal | 0, som: getal(o.som),
      vast: (o.vast || []).slice(0, 6).map(function (v) { return { bedrag: getal(v.bedrag), dag: v.dag | 0 }; }),
      los: o.los ? { aantal: o.los.aantal | 0, som: getal(o.los.som) } : undefined };
  }), buffer: s.buffer || null };
}
// Buffer: rollend over de laatste drie VOLLEDIGE maanden; de lopende maand apart "tot nu" (Fable #6)
function blokBuffer(volledig, lopend, signalen) {
  const b = volledig && volledig.buffer, l = lopend && lopend.buffer;
  if (!b) return null;
  const per = (b.per_maand || []).map(function (x) { return { maand: x.maand, stortingen: getal(x.stortingen), uitgaven: getal(x.uitgaven), verschil: getal(x.verschil) }; });
  const rollend = getal(b.rollend_3_maanden);
  const nu = l && l.per_maand && l.per_maand.length ? l.per_maand[l.per_maand.length - 1] : null;
  const dk = l && l.dekking;
  const uit = { rekening: veilig(b.rekening, 30) || 'Vaste lasten', per_maand: per, rollend_3_maanden: rollend,
    lopend: nu ? { maand: nu.maand, verschil: getal(nu.verschil) } : null,
    dekking: dk ? { saldo_op: dk.saldo_op, saldo: getal(dk.saldo), nog_af_tot: dk.nog_af_tot, nog_af: getal(dk.vaste_lasten_nog_af), genoeg: !!dk.genoeg } : null };
  if (rollend != null && rollend < 0 && per.length)
    signalen.push({ soort: 'buffer', naam: uit.rekening, toon: 'wacht', zin: 'De vaste-lastenrekening liep ' + mndJaar(per[0].maand + '-01') + ' t/m ' + mndJaar(per[per.length - 1].maand + '-01') + ' ' + eur(-rollend) + ' in (stortingen min alle uitgaven).' });
  if (uit.dekking && !uit.dekking.genoeg)
    signalen.push({ soort: 'dekking', naam: uit.rekening, toon: 'fout', zin: 'Het saldo dekt de vaste lasten tot en met ' + uit.dekking.nog_af_tot.split('-').reverse().map(Number).join('-') + ' niet: nog ' + eur(uit.dekking.nog_af) + ' af.' });
  return uit;
}
// Energie en warmte: dezelfde kalendermaanden dit jaar en vorig jaar, alleen maanden die in beide jaren volledig zijn (Fable #3).
// Water (kwartaal) niet: één betaaldatum bepaalt of hij in het venster valt.
function signaalEnergie(a, mNu, vanaf, signalen) {
  if (!vanaf) return;
  const rijen = a.db.prepare("SELECT substr(t.datum, 1, 7) m, sum(t.bedrag) s FROM transacties t JOIN verrijking v ON v.nr = t.nr JOIN rekeningen r ON r.rek = t.rek" +
    " WHERE t.status IN ('booked', 'pending') AND t.bedrag < 0 AND lower(coalesce(v.subcategorie, '')) IN ('energie', 'warmte')" +
    " AND lower(coalesce(r.eigenaar, '')) NOT IN ('extern', 'pot') AND t.datum >= ? GROUP BY 1").all(maandPlus(mNu, -24) + '-01');
  const per = new Map(rijen.map(function (r) { return [r.m, -r.s]; }));
  const ms = [];
  for (let i = 12; i >= 1; i--) { const m = maandPlus(mNu, -i), v = maandPlus(m, -12); if (v >= vanaf) ms.push(m); }
  if (ms.length < 3) return;
  const nu = ms.reduce(function (s, m) { return s + (per.get(m) || 0); }, 0), oud = ms.reduce(function (s, m) { return s + (per.get(maandPlus(m, -12)) || 0); }, 0);
  if (!(oud > 0) || !(nu > 0)) return;
  const pct = (nu - oud) / oud, dPm = (nu - oud) / ms.length;
  if (Math.abs(pct) <= 0.05 || Math.abs(dPm) <= 5) return;
  const venster = MAANDEN[Number(ms[0].slice(5, 7)) - 1] + (ms.length > 1 ? '–' + MAANDEN[Number(ms[ms.length - 1].slice(5, 7)) - 1] : '');
  signalen.push({ soort: 'energie', naam: 'Energie en warmte', toon: pct > 0 ? 'wacht' : 'info',
    zin: 'Energie en warmte ' + venster + ' ' + ms[ms.length - 1].slice(0, 4) + ': ' + eur(nu) + '; dezelfde maanden een jaar eerder ' + eur(oud) + ' (' + (pct > 0 ? '+' : '−') + Math.round(Math.abs(pct) * 100) + '%).' });
}
// Dezelfde aanbieder op twee eigen rekeningen (geen betaaldienstverlener, zelfde subcategorie); naam alleen als hij in de linkslijst staat
function signaalDubbel(A, a, links, signalen) {
  const ab = A.abonnementen(a, {}).abonnementen || [];
  const per = new Map();
  ab.forEach(function (b) {
    if (!b.actief || !b.naam || PSP.test(b.naam) || !b.subcategorie) return;
    const k = A.naamNorm(b.naam) + '|' + norm(b.subcategorie);
    if (!per.has(k)) per.set(k, []);
    per.get(k).push(b);
  });
  per.forEach(function (l) {
    const reks = new Set(l.map(function (b) { return b.rekening; }));
    if (reks.size < 2) return;
    const naam = bekend(l[0].naam, links) ? veilig(l[0].naam, 30) : (veilig(l[0].subcategorie, 30) || 'Een abonnement');
    signalen.push({ soort: 'dubbel', naam: naam, toon: 'wacht', post: naam, link: linkVoor(l[0].naam, links),
      zin: naam + ' loopt op ' + reks.size + ' eigen rekeningen (samen ' + eur(l.reduce(function (s, b) { return s + (b.per_maand || 0); }, 0)) + ' per maand): twee abonnementen of één dubbel?' });
  });
}
function blokPaypal(P, a, links, signalen) {
  const d = P.diensten(a);
  const act = (d.diensten || []).filter(function (r) { return r.actief; });
  const naamVan = function (r) { return bekend(r.naam, links) || bekend(r.dienst, links) ? veilig(r.naam, 30) : 'PayPal-dienst'; };
  (d.diensten || []).forEach(function (r) {
    (r.signalen || []).forEach(function (s) {
      const naam = naamVan(r), link = linkVoor(r.naam, links) || linkVoor(r.dienst, links);
      if (s === 'duurder') signalen.push({ soort: 'prijsstap', naam: naam, toon: 'wacht', post: naam, link: link, zin: naam + ' (via PayPal): sinds ' + mndJaar(r.gewijzigd_op) + ' ' + eur(r.bedrag_eur || r.bedrag) + (r.bedrag_vorig != null ? ' in plaats van ' + eur(r.bedrag_vorig) : '') + '.' });
      else if (s === 'nieuw') signalen.push({ soort: 'nieuw', naam: naam, toon: 'info', post: naam, link: link, zin: naam + ' (via PayPal) is nieuw sinds ' + mndJaar(r.sinds) + ': ' + eur(r.per_maand) + ' per maand.' });
      else if (s === 'weg') signalen.push({ soort: 'weg', naam: naam, toon: 'info', post: naam, zin: 'Navragen: ' + naam + ' (via PayPal) is sinds ' + mndJaar(r.laatst) + ' niet meer betaald.' });
    });
  });
  return { actief: act.length, per_maand_totaal: getal(d.per_maand_totaal), diensten: act.slice(0, 40).map(function (r) {
    return { naam: naamVan(r), ritme: ['maand', 'kwartaal', 'jaar'].indexOf(r.ritme) >= 0 ? r.ritme : 'anders', per_maand: getal(r.per_maand), bedrag: getal(r.bedrag_eur || r.bedrag),
      sinds: r.sinds || null, betaald_via: ['bankrekening', 'creditcard', 'PayPal-saldo', 'onbekend', 'wisselend'].indexOf(r.betaald_via) >= 0 ? r.betaald_via : 'onbekend',
      link: linkVoor(r.naam, links) || linkVoor(r.dienst, links) };
  }) };
}

// Hoofdfunctie. o.vault = vaultmap (toets), o.paypal = paypal-bewijs.js (mag ontbreken).
function bereken(A, a, o) {
  o = o || {};
  const nu = peildag(a), mNu = nu.slice(0, 7), fouten = [];
  const L = leesLinks(o.vault || process.env.VAULT_DIR || '/opt/data/AI_SecondBrain');
  const signalen = [];
  const blok = function (naam, f) { try { return f(); } catch (e) { fouten.push(naam); return null; } };
  const vanaf = blok('verloop', function () { return volledigVanaf(A, a, nu); });
  const uit = { peildatum: nu, maand: mNu };
  uit.deze_maand = blok('maand', function () { return blokMaand(A, a, mNu); });
  uit.vorige_maand = blok('maand', function () { return blokMaand(A, a, maandPlus(mNu, -1)); });
  uit.verloop = blok('verloop', function () { return blokVerloop(A, a, mNu, vanaf); });
  uit.vaste_lasten = blok('vaste_lasten', function () { return blokVasteLasten(A, a, nu, L.links, signalen); });
  const stroomNu = blok('stroom', function () { return blokStroom(A, a, mNu); });
  const stroomVorig = blok('stroom', function () { return blokStroom(A, a, maandPlus(mNu, -1)); });
  uit.buffer = blok('buffer', function () { return blokBuffer(stroomVorig, stroomNu, signalen); });
  uit.stroom = { deze_maand: stroomNu ? { maand: stroomNu.maand, paren: stroomNu.paren } : null, vorige_maand: stroomVorig ? { maand: stroomVorig.maand, paren: stroomVorig.paren } : null };
  blok('energie', function () { signaalEnergie(a, mNu, vanaf, signalen); });
  blok('dubbel', function () { signaalDubbel(A, a, L.links, signalen); });
  uit.paypal = o.paypal ? blok('paypal', function () { return blokPaypal(o.paypal, a, L.links, signalen); }) : null;
  // één signaal per soort en post; gedempt wat David al kent (Bewust-tabel)
  const gezien = new Set();
  const ernst = { fout: 0, wacht: 1, info: 2 };   // eerst wat het meest telt (Fable diffreview #3)
  uit.signalen = signalen.slice().sort(function (x, y) { return (ernst[x.toon] ?? 2) - (ernst[y.toon] ?? 2); }).filter(function (s) {
    const k = s.soort + '|' + (s.post || s.naam || s.zin);
    if (gezien.has(k) || gedempt(s, L.bewust)) return false;
    gezien.add(k); return true;
  }).slice(0, 30).map(function (s) {
    return { soort: s.soort, toon: s.toon === 'fout' ? 'fout' : s.toon === 'wacht' ? 'wacht' : 'info', titel: veilig(s.naam, 40) || null, zin: String(s.zin).slice(0, 240), link: s.link || null };
  });
  uit.links = { gelezen: L.gelezen, geldig: L.links.length, genegeerd: L.genegeerd };
  uit.fouten = Array.from(new Set(fouten));
  return uit;
}

module.exports = { bereken, leesLinks, linkGeldig, linkVoor, LINK_HOSTS, LINK_PAGINA, plusMaanden, maandPlus };
