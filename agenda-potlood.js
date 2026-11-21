'use strict';
/*
 * wv3741 (besluitenpagina nr 486 = 3C186, David Ja 21-11-2026 13:12): potloodlaag.
 * "Mag Socev in zijn eigen kalender in potlood zetten wat hij aan data, vertrektijden en voorbereiding vindt, zodat jij het in je
 * agenda ziet en met één ✅ overneemt?"
 *
 * Eén ronde (dagtik in server.js, 07:05–11:00, hooguit eens per uur tot het dagplafond bereikt is):
 *  1. lezen (fail-closed: lukt één lezing niet, dan doet de ronde niets): vondsten van de datumdetector (kalender-app.js gevonden(),
 *     wv3679) en de eigen potloden in de Socev-kalender (luik socev_lijst);
 *  2. opruimen per potlood uit het register: dag voorbij → verlopen; niet meer in de Socev-kalender → David haalde hem weg = klopt niet
 *     (vondsten op afgewezen, komt nooit terug); vondst lijkt nu in Davids agenda (spiegel, nu_in) → potlood weg (overgenomen);
 *  3. nieuw: vondsten met precisie dag of minuut, morgen t/m +45 dagen, niet "lijkt al in je agenda", met vindbaar stuk (bron verplicht), samengevoegd op dag|tijd|onderwerp,
 *     sleutel nog nooit in het register → potlood (socev_plaatsen) + één kaart "Bevestig in je agenda" (david_plaatsen, kaart: true):
 *     alleen Davids ✅ met vingerafdruk zet het in zijn agenda (bestaande route agenda-schrijven).
 * Grenzen: alleen de Socev-kalender (het luik kent alleen die calendarId voor socev_*); verwijderen alleen eigen event_ids uit het register
 * met de potloodmarkering in de titel; plafond per dag en per ronde (de luikrem is 10 mutaties per rollend uur, ook voor Socev zelf);
 * geen titels of zinnen in register, log of info.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TZ = 'Europe/Amsterdam';
const MARK = '✏️ ';
const PROEF = 'SOCEV PROEF ';
// mutatiesRonde 4: de luikrem (10 per rollend uur) geldt ook voor Davids eigen agendakaarten; zo houdt hij er altijd 6 over (gemeten 21-11:
// een proefreeks vulde de rem in 20 minuten)
const STANDAARD = { plafondDag: 5, mutatiesRonde: 4, maxActief: 30, dagen: 45, kaartPogingen: 2 };
// Grondwet, alinea TOESTEMMINGEN: alleen het register telt. Zonder rij agenda-socev-potlood op status aan doet de ronde niets
// (ook niet opruimen); onleesbaar = uit. Proefmodus (alleen SOCEV PROEF in de Socev-kalender, proefkaart) heeft de rij niet nodig.
const REGISTER_RIJ = 'agenda-socev-potlood';
function registerAan(pad) {
  try { const r = JSON.parse(fs.readFileSync(pad, 'utf8')); return !!(r && Array.isArray(r.rijen) && r.rijen.find((x) => x && x.id === REGISTER_RIJ && x.status === 'aan')); }
  catch (e) { return false; }
}

function dagAms(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: TZ }); }
function plusDagen(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function sha(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 24); }
function kort(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
function plusUur(dag, hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return null;
  const min = Number(m[1]) * 60 + Number(m[2]) + 60;
  if (min >= 24 * 60) return dag + 'T23:59';
  return dag + 'T' + String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}
// app-link naar een vaultstuk zoals de app hem opent (skill agenda-schrijven § Omschrijving)
function stukLink(pad) {
  if (typeof pad !== 'string' || !/\.md$/.test(pad) || pad.startsWith('/') || pad.split('/').some((x) => !x || x === '..' || x.startsWith('.'))) return null;
  return 'https://app.socev.dev/' + pad.split('/').map(encodeURIComponent).join('/');
}
function isHagro(pad) { return typeof pad === 'string' && pad.indexOf('10_Zakelijk/HAGRO/') === 0; }

/* kandidaten(regels, vandaag, o) → [{ sleutel, ids, dag, begin, eind, hele_dag, onderwerp, soort, stuk_pad }] — puur. */
function kandidaten(regels, vandaag, o) {
  o = Object.assign({}, STANDAARD, o || {});
  const van = plusDagen(vandaag, 1), tot = plusDagen(vandaag, o.dagen);
  const per = new Map();
  for (const r of Array.isArray(regels) ? regels : []) {
    if (!r || !Number.isSafeInteger(Number(r.id)) || typeof r.van !== 'string') continue;
    if (r.precisie !== 'dag' && r.precisie !== 'minuut') continue;
    if (r.van < van || r.van > tot) continue;
    if (r.nu_in) continue;                         // lijkt al in je agenda of Deadlines: geen potlood
    if (!stukLink(r.stuk_pad)) continue;           // review MOET 1: bron verplicht; zonder vindbaar stuk geen potlood
    const onderwerp = kort(r.onderwerp || r.titel, 120);
    if (!onderwerp) continue;
    const heleDag = r.hele_dag !== false || !/^\d{2}:\d{2}$/.test(r.begin || '');
    const begin = heleDag ? null : r.begin;
    const sleutel = sha(r.van + '|' + (begin || '') + '|' + onderwerp.toLowerCase());
    const x = per.get(sleutel);
    if (x) { x.ids.push(Number(r.id)); if (!x.stuk_pad && r.stuk_pad) x.stuk_pad = r.stuk_pad; continue; }
    per.set(sleutel, { sleutel, ids: [Number(r.id)], dag: r.van, begin, eind: heleDag ? null : (/^\d{2}:\d{2}$/.test(r.eind || '') && r.eind > begin ? r.eind : null),
      hele_dag: heleDag, onderwerp, soort: r.soort === 'deadline' ? 'deadline' : 'afspraak', stuk_pad: r.stuk_pad || null });
  }
  return Array.from(per.values()).sort((a, b) => (a.dag < b.dag ? -1 : a.dag > b.dag ? 1 : 0) || String(a.begin || '').localeCompare(String(b.begin || '')));
}

/* verzoeken(k, proef) → { potlood, kaart }: de twee luikaanroepen voor één kandidaat (zonder secret) — puur. */
function verzoeken(k, proef) {
  const start = k.hele_dag ? k.dag : k.dag + 'T' + k.begin;
  const eind = k.hele_dag ? plusDagen(k.dag, 1) : (k.eind ? k.dag + 'T' + k.eind : plusUur(k.dag, k.begin));
  const naam = (k.soort === 'deadline' ? 'Deadline: ' : '') + k.onderwerp;
  const link = stukLink(k.stuk_pad);
  const hagro = isHagro(k.stuk_pad);
  const regels = ['Potlood van Socev: dit staat nog niet in je agenda.',
    'Overnemen: druk op ✅ op de kaart "Bevestig in je agenda" in de Socev-app.',
    'Klopt niet: haal deze afspraak hier weg; dan komt hij niet terug.'];
  if (!k.hele_dag && !k.eind) regels.push('Eindtijd stond er niet bij: 1 uur aangenomen.');
  if (link) regels.push('Stuk: ' + link);
  const potlood = { actie: 'socev_plaatsen', titel: kort((proef ? PROEF : '') + MARK + naam, 200), start, eind,
    omschrijving: regels.join('\n').slice(0, 800), aanleiding: 'potlood wv3741', sta_overlap_toe: true };
  const kaart = { actie: 'david_plaatsen', kaart: true, agenda: proef ? 'proef' : (hagro ? 'hagro' : 'hoofd'),
    titel: kort((proef ? PROEF : '') + naam, 200), start, eind, aanleiding: 'potlood wv3741 (Socev vond dit; jouw ✅ zet het in je agenda)' };
  if (proef) kaart.test = true;
  // HAGRO is gedeeld: alleen een link naar een HAGRO-stuk (n8n weigert al het andere); proef: omschrijving alleen in de proefagenda
  if (link && (!hagro || isHagro(k.stuk_pad))) kaart.omschrijving = 'Stuk: ' + link;
  return { potlood, kaart };
}

function leesStaat(p) {
  try { const s = JSON.parse(fs.readFileSync(p, 'utf8')); if (s && typeof s === 'object' && s.items && typeof s.items === 'object') return s; } catch (e) { /* nieuw */ }
  return { versie: 1, items: {}, dagen: {} };
}
function schrijfStaat(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/*
 * maak({ gevonden(nu) → {ok, regels}, luik(body) → antwoord, oordeel(id, 'klopt_niet') → {status}, staatPad, proef, log, …STANDAARD })
 * → { ronde({nu}) → samenvatting, info() }
 */
function maak(o) {
  o = Object.assign({}, STANDAARD, o || {});
  const log = typeof o.log === 'function' ? o.log : function () {};
  const mark = (o.proef ? PROEF : '') + MARK;
  let laatste = null, bezig = false;

  async function ronde(arg) {
    if (bezig) return { ok: true, overgeslagen: 'bezig' };
    bezig = true;
    try { return await ronde2(arg); } finally { bezig = false; }
  }
  async function ronde2(arg) {
    const nu = arg && Number.isFinite(arg.nu) ? arg.nu : Date.now();
    const vandaag = dagAms(nu);
    if (!o.proef && !registerAan(o.registerPad || '/opt/data/mk-scripts/toestemmingen.json')) {
      laatste = { op: new Date(nu).toISOString(), ok: true, register: 'uit' };
      return laatste;
    }
    const s = leesStaat(o.staatPad);
    s.dagen = s.dagen && typeof s.dagen === 'object' ? s.dagen : {};
    for (const d of Object.keys(s.dagen)) if (d < plusDagen(vandaag, -14)) delete s.dagen[d];
    const tel = { nieuw: 0, weg: 0, overgenomen: 0, verlopen: 0, kaart: 0, kaart_fout: 0, fout: 0, mutaties: 0 };
    const uit = (x) => { laatste = Object.assign({ op: new Date(nu).toISOString() }, x); log(laatste); return laatste; };

    // 1. lezen, fail-closed
    let g, lijst;
    try { g = await o.gevonden(nu); } catch (e) { return uit({ ok: false, fout: 'vondsten niet leesbaar' }); }
    if (!g || g.ok !== true || !Array.isArray(g.regels)) return uit({ ok: false, fout: 'vondsten niet leesbaar' });
    try { lijst = await o.luik({ actie: 'socev_lijst', van: vandaag, dagen: o.dagen + 15 }); } catch (e) { return uit({ ok: false, fout: 'socev-kalender niet leesbaar' }); }
    if (!lijst || lijst.ok !== true || !Array.isArray(lijst.events)) return uit({ ok: false, fout: 'socev-kalender niet leesbaar' });
    const inKal = new Map(lijst.events.map((e) => [String(e.event_id), e]));
    const perId = new Map(g.regels.map((r) => [Number(r.id), r]));
    const magMuteren = () => tel.mutaties < o.mutatiesRonde;

    // 2. opruimen
    for (const [sl, it] of Object.entries(s.items)) {
      if (it.s !== 'potlood') continue;
      if (it.dag < vandaag) { it.s = 'verlopen'; it.op = vandaag; tel.verlopen++; continue; }
      const ev = inKal.get(String(it.ev));
      if (!ev) {
        if (it.dag > plusDagen(vandaag, o.dagen + 15)) continue;   // buiten het leesvenster: niets concluderen
        it.s = 'weg'; it.op = vandaag; tel.weg++;
        for (const id of it.ids || []) {
          try { await o.oordeel(id, 'klopt_niet'); } catch (e) { tel.fout++; }
        }
        continue;
      }
      const rs = (it.ids || []).map((id) => perId.get(Number(id))).filter(Boolean);
      // review MOET 2: alleen weghalen als de afspraak nu echt in Davids agenda lijkt te staan (spiegel van vannacht, nu_in);
      // een vondst die uit de lijst verdween bewijst niets: dan blijft het potlood tot de dag voorbij is of David hem weghaalt
      const inAgenda = rs.length > 0 && rs.every((r) => r.nu_in === 'agenda');
      if (inAgenda && magMuteren() && String(ev.titel || '').indexOf(mark) === 0) {
        tel.mutaties++;
        let a = null;
        try { a = await o.luik({ actie: 'socev_verwijderen', event_id: String(it.ev), aanleiding: 'potlood wv3741: staat nu in je agenda' }); } catch (e) { a = null; }
        if (a && a.ok === true) { it.s = 'overgenomen'; it.op = vandaag; tel.overgenomen++; } else tel.fout++;
        continue;
      }
      // kaart nog niet gelukt: nog een poging met de gegevens van nu
      if (!it.kaart && (it.kp || 0) < o.kaartPogingen && rs.length && magMuteren()) {
        const k = kandidaten(rs.map((r) => Object.assign({}, r, { nu_in: null })), plusDagen(it.dag, -1), { dagen: 1 })[0];
        if (k) {
          tel.mutaties++; it.kp = (it.kp || 0) + 1;
          let a = null;
          try { a = await o.luik(verzoeken(k, o.proef).kaart); } catch (e) { a = null; }
          if (a && a.knop_verstuurd === true) { it.kaart = true; tel.kaart++; } else tel.kaart_fout++;
        }
      }
    }

    // 3. nieuw
    const actief = Object.values(s.items).filter((x) => x.s === 'potlood').length;
    let ruimte = Math.min(o.plafondDag - (s.dagen[vandaag] || 0), o.maxActief - actief);
    for (const k of kandidaten(g.regels, vandaag, o)) {
      if (ruimte <= 0 || tel.mutaties + 2 > o.mutatiesRonde) break;
      if (s.items[k.sleutel]) continue;            // ooit gezet (ook weggehaald of verlopen): nooit opnieuw
      const v = verzoeken(k, o.proef);
      tel.mutaties++;
      let a = null;
      try { a = await o.luik(v.potlood); } catch (e) { a = null; }
      if (!a || a.ok !== true || !a.event_id) { tel.fout++; continue; }   // volgende ronde nog eens (sleutel niet vastgelegd)
      if (a.dubbel === true) { tel.fout++; continue; }                   // een gelijk event zonder registerregel: niet het onze maken
      s.items[k.sleutel] = { s: 'potlood', ev: String(a.event_id), ids: k.ids, dag: k.dag, kaart: false, kp: 1, op: vandaag };
      s.dagen[vandaag] = (s.dagen[vandaag] || 0) + 1;
      ruimte--; tel.nieuw++;
      schrijfStaat(o.staatPad, s);                 // na elke plaatsing: een crash maakt nooit een tweede potlood
      tel.mutaties++;
      let b = null;
      try { b = await o.luik(v.kaart); } catch (e) { b = null; }
      if (b && b.knop_verstuurd === true) { s.items[k.sleutel].kaart = true; tel.kaart++; } else tel.kaart_fout++;
    }
    s.laatste = { op: new Date(nu).toISOString(), tel };
    schrijfStaat(o.staatPad, s);
    const st = { potlood: 0, weg: 0, overgenomen: 0, verlopen: 0 };
    for (const x of Object.values(s.items)) if (st[x.s] !== undefined) st[x.s]++;
    return uit(Object.assign({ ok: tel.fout === 0, vandaag: s.dagen[vandaag] || 0, plafond: o.plafondDag }, tel, { stand: st }));
  }
  function vandaagVol(nu) {
    const s = leesStaat(o.staatPad);
    return ((s.dagen || {})[dagAms(nu)] || 0) >= o.plafondDag;
  }
  function info() { return Object.assign({ aan: true, proef: !!o.proef }, laatste ? { laatste } : {}); }
  return { ronde, info, vandaagVol };
}

module.exports = { maak, kandidaten, verzoeken, stukLink, registerAan, MARK, PROEF, STANDAARD, REGISTER_RIJ };
