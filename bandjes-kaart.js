'use strict';
/*
 * Bandjes-kaarten in Voor jou (wv3723; besluitenpagina nr 122 = 2C22 en nr 191 = 2C91c, David Ja 21-11-2026 13:18; Fable-review
 * "Een 9 - bandjes" idee 1 en 7). Puur: geen netwerk of bestanden; server.js leest de registers (bandjes.js) en de kaartenlijst
 * (mk_voor_jou_lijst, ook gesloten) en voert het plan uit (mk_voor_jou_zet / mk_voor_jou_status, door agent).
 *
 * 1. Afmaakkaart (2C22): elk bandje dat gemaakt is maar nog niet in de centrale staat (kan_centrale) krijgt één kaart, sleutel
 *    bandjes-af-<praktijk>-<id>-v<versie>. Opnieuw maken houdt dezelfde versie, dus dezelfde sleutel: nooit een tweede kaart. Tik = de app
 *    op dat bandje bij het geluid (focus geluid:<praktijk>/<id>). Staat de versie in de centrale (of hoort het geluid niet meer bij de
 *    tekst), dan gaat een open of geparkeerde kaart dicht (door agent, met bewijs). Sloot de ronde hem en is het bandje weer klaar (tekst
 *    terug of opnieuw gemaakt op dezelfde versie), dan gaat dezelfde kaart weer open. Davids eigen gedaan/later blijft staan.
 * 2. Belkaart "Hoor je de nieuwe?" (2C91c): na "Staat in de centrale" (in centrale sinds BEGIN of later, hooguit BEL_DAGEN geleden) één
 *    kaart op het eerste moment dat het bandje volgens zijn tijdvensters speelt, tussen 07:00 en 23:00; zonder tijdvensters meteen
 *    (overdag). Sleutel bandjes-bel-<praktijk>-<id>-v<versie>: één per versie. Zet David hem op gedaan, dan schrijft server.js
 *    "gehoord" in het register (plan.gehoord).
 * 3. De oude verzamelkaart (OUD) gaat op in de nieuwe zodra elk van zijn bandjes een afmaakkaart heeft of in de centrale staat.
 * Een register dat dicht of onleesbaar is: niets aan de kaarten van die praktijk veranderen.
 */

const PREFIX_AF = 'bandjes-af-';
const PREFIX_BEL = 'bandjes-bel-';
const AF_RE = /^bandjes-af-(tolgaarde|groenhouten)-((?:tg|gh)-[a-z0-9-]{2,30})-v(\d{1,4})$/;
const BEL_RE = /^bandjes-bel-(tolgaarde|groenhouten)-((?:tg|gh)-[a-z0-9-]{2,30})-v(\d{1,4})$/;
const BEGIN = '2026-11-21';   // belkaarten alleen voor wat vanaf de bouw in de centrale gezet wordt (niet voor de acht van oktober)
const BEL_DAGEN = 7;
const MAX_NIEUW = 10;
const NUMMER = { tolgaarde: '033-494 12 10', groenhouten: '033 494 46 00' };   // praktijknummers (register Tolgaarde, huisstijl Groenhouten)
const MIJNKPN_PAD = 'MijnKPN Zakelijk › Telefooncentrale › Beheer en instellingen › Belplan › Callcenter › Welkomstbericht';
// wv3073 (14-11): één kaart voor twee bandjes; vervangen door een afmaakkaart per bandje
const OUD = [{ sleutel: 'wv3073', bandjes: ['tolgaarde/tg-buiten', 'groenhouten/gh-koffiepauze'] }];

function sleutelAf(pr, id, v) { return PREFIX_AF + pr + '-' + id + '-v' + v; }
function sleutelBel(pr, id, v) { return PREFIX_BEL + pr + '-' + id + '-v' + v; }
function kort(t, n) { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; }
// "22-10-2026 · v2 · …" of "v2 sinds 23-10-2026, [[…]]" → "22-10-2026"
function datumUit(w) { const m = /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/.exec(String(w || '')); return m ? { nl: m[0], iso: m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') } : null; }
function herkomst(pr, id) { return { module: 'bandjes', handmatig: 'bandjes', doel: { scherm: 'bandjes', focus: 'geluid:' + pr + '/' + id } }; }

// ── tijdvensters: "ma-vr 00:00-08:00; ma-vr 17:00-24:00; za-zo 00:00-24:00" → [{ dagen: Set(1..7), van: min, tot: min }] (ma = 1) ──
const DAG = { ma: 1, di: 2, wo: 3, do: 4, vr: 5, za: 6, zo: 7 };
function vensters(w) {
  const uit = [];
  String(w || '').split(/[;,]/).forEach(function (deel) {
    const m = /^\s*(ma|di|wo|do|vr|za|zo)(?:\s*-\s*(ma|di|wo|do|vr|za|zo))?\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/i.exec(deel);
    if (!m) return;
    const a = DAG[m[1].toLowerCase()], b = m[2] ? DAG[m[2].toLowerCase()] : a;
    const dagen = new Set();
    for (let d = a; ; d = d % 7 + 1) { dagen.add(d); if (d === b || dagen.size >= 7) break; }
    const van = Number(m[3]) * 60 + Number(m[4]), tot = Number(m[5]) * 60 + Number(m[6]);
    if (van < tot && tot <= 24 * 60) uit.push({ dagen: dagen, van: van, tot: tot });
  });
  return uit;
}
// Nederlandse dag (1..7) en minuut van nu
function nlTijd(ms) {
  const d = new Date(ms);
  const delen = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', weekday: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach(function (p) { delen[p.type] = p.value; });
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[delen.weekday];
  return { dag: wd, min: Number(delen.hour) * 60 + Number(delen.minute), iso: delen.year + '-' + delen.month + '-' + delen.day, uur: Number(delen.hour) };
}
function speeltNu(w, t) { return vensters(w).some(function (v) { return v.dagen.has(t.dag) && t.min >= v.van && t.min < v.tot; }); }
function dagenTussen(isoA, isoB) { return Math.round((Date.parse(isoB + 'T12:00:00Z') - Date.parse(isoA + 'T12:00:00Z')) / 86400000); }

// ── kaarten ──
function afKaart(pr, prNaam, b, nuKort) {
  const gemaakt = datumUit(b.laatste_bestand);
  const menu = kort(String(b.menu || '').split(';')[0], 70);
  return { sleutel: sleutelAf(pr, b.id, b.versie), soort: 'doen', waar: 'overal', prive: false, duur_min: 5, volgorde: 40,
    titel: kort('Bandje ' + b.naam + ' (' + prNaam + ') — in de telefooncentrale zetten', 90),
    waarom: kort('Versie ' + b.versie + ' van dit bandje is gemaakt' + (gemaakt ? ' (' + gemaakt.nl + ')' : '') + ', maar staat nog niet in de telefooncentrale. ' +
      'Tot je hem uploadt horen bellers de vorige tekst. Luisteren, downloaden en uploaden kost ± 2 minuten.', 400),
    stappen: [
      'Tik op deze kaart: je komt in Bandjes bij dit bandje, met Afspelen, Download voor KPN en Open MijnKPN.'].concat(b.gelijk_kan ? [
      'Bovenaan staat een voorstel van Socev dat precies zegt wat al is ingesproken: tik Tekst gelijktrekken (kost niets), dan klopt het archief met het geluid.'] : [], [
      'Luister hem af en tik Download voor KPN.',
      'Tik Open MijnKPN en ga naar ' + MIJNKPN_PAD + (menu ? ' (' + menu + ')' : '') + '; upload daar het bestand en bewaar.',
      'Tik daarna in de app op Staat in de centrale; deze kaart gaat dan vanzelf dicht.']),
    meting: kort((nuKort ? nuKort + ': ' : '') + 'versie ' + b.versie + ' is gemaakt maar nog niet als in de centrale gemarkeerd.', 300),
    herkomst: herkomst(pr, b.id) };
}
function belKaart(pr, prNaam, b, nuKort) {
  const nummer = NUMMER[pr] || null;
  const wanneer = kort(b.wanneer || '', 120);
  return { sleutel: sleutelBel(pr, b.id, b.centrale_versie), soort: 'doen', waar: 'overal', prive: false, duur_min: 2, volgorde: 45,
    titel: kort('Bandje ' + b.naam + ' (' + prNaam + ') — even bellen: hoor je de nieuwe?', 90),
    waarom: kort('Je zette versie ' + b.centrale_versie + ' in de centrale. Socev kan de centrale niet zien; jouw oor is de enige controle. ' +
      'Een upload in het verkeerde menu valt zo dezelfde dag op.', 400),
    stappen: [
      (nummer ? 'Bel ' + nummer : 'Bel het praktijknummer') + (vensters(b.tijdvensters).length ? ' nu het bandje speelt' : wanneer ? ' als het bandje speelt (' + wanneer + ')' : ' als het bandje speelt') + ' en luister.',
      'Hoor je de nieuwe tekst: zet deze kaart op gedaan.',
      'Hoor je nog de oude: tik Anders en schrijf wat je hoort.'],
    meting: kort((nuKort ? nuKort + ': ' : '') + 'versie ' + b.centrale_versie + ' staat als in de centrale gemarkeerd; nog niet nagebeld.', 300),
    herkomst: herkomst(pr, b.id) };
}

/*
 * plan({ praktijken: [{ id, naam, dicht, ok, bandjes: [bandjeUit] }], punten: [{ sleutel, status, gesloten_door }], nu: ms, nuKort })
 *   → { zet: [kaart], open: [{ sleutel, van }], dicht: [{ sleutel, van, bewijs, samengevoegd_in? }], gehoord: [{ praktijk, bandje, versie }] }
 */
function plan(x) {
  const uit = { zet: [], open: [], dicht: [], gehoord: [] };
  const punten = new Map();
  (x.punten || []).forEach(function (p) { if (p && typeof p.sleutel === 'string') punten.set(p.sleutel, p); });
  const t = nlTijd(x.nu || Date.now());
  const overdag = t.uur >= 7 && t.uur < 23;
  const nuKort = x.nuKort || '';
  const leesbaar = new Set();   // praktijken waarvan het register gelezen en open is
  const klaarAf = new Set();    // sleutels van afmaakkaarten die nu horen te bestaan
  const bandjeStand = {};       // 'pr/id' → { af: sleutel|null, centrale: n }
  (x.praktijken || []).forEach(function (pr) {
    if (!pr || !pr.ok || pr.dicht) return;
    leesbaar.add(pr.id);
    (pr.bandjes || []).forEach(function (b) {
      bandjeStand[pr.id + '/' + b.id] = { af: b.kan_centrale ? sleutelAf(pr.id, b.id, b.versie) : null, centrale: Number(b.centrale_versie) || 0, versie: b.versie };
      if (b.kan_centrale) {
        const s = sleutelAf(pr.id, b.id, b.versie);
        klaarAf.add(s);
        const p = punten.get(s);
        if (!p) { if (uit.zet.length < MAX_NIEUW) uit.zet.push(afKaart(pr.id, pr.naam, b, nuKort)); }
        else if ((p.status === 'gedaan' || p.status === 'vervallen') && p.gesloten_door === 'agent') uit.open.push({ sleutel: s, van: p.status });
      }
      // belkaart: in de centrale sinds BEGIN, hooguit BEL_DAGEN geleden, één per versie, op een speelmoment overdag
      const c = Number(b.centrale_versie) || 0;
      const sinds = datumUit(b.in_centrale);
      if (c >= 1 && sinds && sinds.iso >= BEGIN && dagenTussen(sinds.iso, t.iso) <= BEL_DAGEN && dagenTussen(sinds.iso, t.iso) >= 0) {
        const s = sleutelBel(pr.id, b.id, c);
        const p = punten.get(s);
        const heeftVensters = vensters(b.tijdvensters).length > 0;
        if (!p && overdag && (!heeftVensters || speeltNu(b.tijdvensters, t)) && uit.zet.length < MAX_NIEUW) uit.zet.push(belKaart(pr.id, pr.naam, b, nuKort));
        if (p && p.status === 'gedaan' && p.gesloten_door === 'david' && !/^\s*v?\d/.test(String(b.gehoord || '')))
          uit.gehoord.push({ praktijk: pr.id, bandje: b.id, versie: c });
      }
    });
  });
  // open afmaakkaarten die niet meer kloppen: dicht (alleen van leesbare praktijken)
  punten.forEach(function (p, s) {
    const m = AF_RE.exec(s);
    if (!m || (p.status !== 'open' && p.status !== 'later') || !leesbaar.has(m[1]) || klaarAf.has(s)) return;
    const st = bandjeStand[m[1] + '/' + m[2]];
    const v = Number(m[3]);
    const bewijs = (nuKort ? nuKort + ': ' : '') + (!st ? 'dit bandje staat niet meer in de lijst.'
      : st.centrale >= v ? 'versie ' + v + ' staat als in de centrale gemarkeerd.'
      : st.versie > v ? 'er is intussen een nieuwere versie; die krijgt een eigen kaart.'
      : 'de tekst is gewijzigd na het maken; na een nieuwe Maak komt deze kaart terug.');
    uit.dicht.push({ sleutel: s, van: p.status, bewijs: bewijs });
  });
  // de oude verzamelkaart: op in de nieuwe zodra elk van zijn bandjes een afmaakkaart heeft of in de centrale staat
  OUD.forEach(function (o) {
    const p = punten.get(o.sleutel);
    if (!p || (p.status !== 'open' && p.status !== 'later')) return;
    let doel = null, af = true;
    o.bandjes.forEach(function (k) {
      const st = bandjeStand[k];
      if (!st) { af = false; return; }
      if (st.af) { const bestaat = punten.has(st.af) || uit.zet.some(function (z) { return z.sleutel === st.af; }); if (!bestaat) af = false; else doel = doel || st.af; }
      else if (!(st.centrale >= 1 && st.versie <= st.centrale)) af = false;
    });
    if (!af) return;
    uit.dicht.push({ sleutel: o.sleutel, van: p.status, samengevoegd_in: doel, bewijs: (nuKort ? nuKort + ': ' : '') + 'vervangen door één kaart per bandje, met luisteren, downloaden en het klikpad in MijnKPN.' });
  });
  return uit;
}

module.exports = { plan, vensters, speeltNu, nlTijd, afKaart, belKaart, sleutelAf, sleutelBel, AF_RE, BEL_RE, OUD, BEGIN, NUMMER, MIJNKPN_PAD };
