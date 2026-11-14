'use strict';
/**
 * mail-app.js — OVIS Mail fase 1 (wv3077, 14-11-2026): Davids eigen privé-Gmail in de Mail-App, met de laag van Socev erover.
 * Plan: vault "01_Ontwikkeling/OVIS Mail - opnieuw bekeken (Fable 5.2, 14-11-2026).md" § 2, § 3.1, § 3.4, § 4, § 5 fase 1; Davids Ja
 * 14-11 19:40 (vraag-id 245dc43c) met drie aanvullingen: labels standaard verborgen (gekozen labels toch tonen), labels als communicatie
 * tussen Gmail en OVIS Mail (vertaaltabel hieronder), en ook op mail.socev.dev.
 *
 * WAT. De lijst ís de Gmail-inbox (of een andere map, of een zoekvraag in de zoektaal van Gmail): het leesluik (n8n AI - Agenda-Wachter
 * API, acties mail_lijst en mail_gesprek, alleen lezen) levert de koppen; deze module legt er per gesprek hooguit één vlakje over uit wat
 * MailMan, Intake, Facturen en het voorwerk al weten, vertaalt de Gmail-labels naar eigen tekens, en zet de regel bovenaan klaar.
 * Een heel gesprek gaat door de patiëntpoort voordat er één letter naar het scherm gaat; een gesprek met slotje (patiëntmarker of
 * zorgmail bij MailMan, of de poort slaat nu aan) blijft "Open in Gmail".
 * GRENZEN. Alleen privé-Gmail (gmail:david). Mailtekst alleen door het geheugen: deze module schrijft niets naar schijf en logt geen
 * inhoud (server.js logt alleen route en aantallen). Naar Facturen / Naar Brain gaan via MailMans keuze-tak (label uit de vaste lijst,
 * bij de volgende ronde). Fase 1b (wv3090): archiveren, terugzetten, gelezen/ongelezen, ster en een label uit MailMans vaste lijst op Davids
 * eigen tik (wijzig, zie onder), alleen als de registerrij mail-app-prive-op-tik aan staat. Maak todo = één
 * Todoist-taak op Davids tik (titel aan te passen, datum uit de datumdetector, link naar het gesprek), nooit bij een slotje, en de titel
 * gaat eerst door de patiëntpoort.
 * PUUR waar het kan: vertaalLabels, vlakVan, schoonLijst, kiesDatum zijn los te toetsen. Alles naar buiten komt van server.js (io).
 */

const MAPPEN = ['inbox', 'ster', 'concepten', 'verzonden', 'alle'];
const DRAAD_RE = /^[0-9a-f]{10,24}$/;
const PAGINA_RE = /^[0-9A-Za-z_-]{1,200}$/;
const Q_MAX = 500, TITEL_MAX = 300;
const RONDE_OUD_MS = 45 * 60000;   // § 3.4: drie rondes van een kwartier gemist = oranje

// ── Vertaaltabel Gmail-label → weergave in OVIS Mail (David 14-11 19:40: "labels als communicatie tussen de Gmail-laag en de OVIS
// Mail-laag … misschien alle AI/-labels als communicatielabels"). verborgen = nooit als label (de vlakjes en tekens dragen de betekenis);
// teken = klein eigen teken op de regel; alles wat hier niet staat is een eigen label van David: standaard verborgen, op zijn keuze getoond.
const VERBORGEN = new Set(['INBOX', 'UNREAD', 'IMPORTANT', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'CHAT', 'STARRED',
  'INTAKE', 'FACTUUR', 'FACTUUR/verwerkt', 'NIEUWSBRIEF', 'SOCIAAL', 'OVERIG', 'INFO', 'TWIJFEL', 'AI/MailMan', 'V', 'BEZORGING', 'ZORGMAIL',
  'AI', 'AI/Checked', 'AI/Validatie', 'AI/SecondBrain', 'AI/SecondBrain/Manual', 'AI/SecondBrain/Processed', '_AI_/Verwerkt']);
const TEKENS = {
  TODO: { id: 'actie', tekst: 'Actie', kleur: 'oranje' }, ACTIE_DS: { id: 'actie', tekst: 'Actie', kleur: 'oranje' }, 'TODO-PRIORITEIT': { id: 'actie', tekst: 'Actie', kleur: 'oranje' },
  'FACTUUR/In_SEPA': { id: 'sepa', tekst: 'In SEPA', kleur: 'grijs' }, 'FACTUUR/Is_betaald': { id: 'betaald', tekst: 'Betaald', kleur: 'groen' },
  CONCEPT_KLAAR: { id: 'concept', tekst: 'Concept klaar', kleur: 'blauw' },
  'AI/SecondBrain/Unprocessed': { id: 'naar-brain', tekst: 'Naar Brain', kleur: 'blauw' }, _AI_: { id: 'naar-brain', tekst: 'Naar Brain', kleur: 'blauw' },
  'Socev-volgt': { id: 'volgt', tekst: 'Socev volgt', kleur: 'blauw' },
};
const ENTITEITEN = { 'AI/Tolgaarde': 'Tolgaarde', 'AI/Groenhouten': 'Groenhouten', 'AI/HAGRO': 'HAGRO', 'AI/POT': 'POT', 'AI/Holding': 'Holding',
  'AI/Praktijkhouders_BV': 'Praktijkhouders', 'AI/SEL': 'SEL', 'AI/DBH': 'DBH', 'AI/Prive': 'Privé' };

// ── wv3090 fase 1b: Gmail-handeling op Davids tik. Vaste lijst (toestemmingenregister rij mail-app-prive-op-tik, Davids Ja 14-11 22:29):
// INBOX, UNREAD, STARRED en de acht labels van MailMan (namen; de label-ID's komen uit MailMans config labelset2 gmail:david). Nooit
// TRASH, SPAM, verwijderen of versturen; AI/MailMan (de wachtrij van MailMan) hoort er niet bij. Elke handeling heeft een tegenhanger
// (Ongedaan maken in de App = de tegenhanger op dezelfde gesprekken).
const WIJZIG_LABELS = ['INTAKE', 'FACTUUR', 'NIEUWSBRIEF', 'SOCIAAL', 'OVERIG', 'TWIJFEL', 'TODO', 'ACTIE_DS'];
const WIJZIG = {
  archiveer: { eraf: ['INBOX'], terug: 'terug' }, terug: { erbij: ['INBOX'], terug: 'archiveer' },
  gelezen: { eraf: ['UNREAD'], terug: 'ongelezen' }, ongelezen: { erbij: ['UNREAD'], terug: 'gelezen' },
  ster: { erbij: ['STARRED'], terug: 'geen_ster' }, geen_ster: { eraf: ['STARRED'], terug: 'ster' },
  label_erbij: { label: 'erbij', terug: 'label_eraf' }, label_eraf: { label: 'eraf', terug: 'label_erbij' },
};
const WIJZIG_MAX = 20;
const LABEL_ID_RE = /^Label_\d{1,12}$/;

function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function str(x, n) { return typeof x === 'string' ? x.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, n) : ''; }

// labelIds van één gesprek + kaart id → naam → { tekens: [..] (hooguit 3, uniek), eigen: [namen], ster }
function vertaalLabels(ids, kaart) {
  const tekens = [], eigen = [], gezien = new Set();
  let ster = false;
  for (const id of Array.isArray(ids) ? ids : []) {
    const naam = kaart && kaart.has(String(id)) ? kaart.get(String(id)) : String(id);
    if (naam === 'STARRED') ster = true;
    if (VERBORGEN.has(naam) || /^CATEGORY_/.test(naam)) continue;
    const t = TEKENS[naam] || (ENTITEITEN[naam] ? { id: 'entiteit', tekst: ENTITEITEN[naam], kleur: 'grijs' } : null);
    if (t) { if (!gezien.has(t.id + t.tekst)) { gezien.add(t.id + t.tekst); tekens.push(t); } continue; }
    if (/^AI\//.test(naam) || /^_AI_/.test(naam)) continue;   // een nieuw AI/-label zonder vertaling: communicatie, nooit als ruwe tekst
    if (naam && !eigen.includes(naam)) eigen.push(naam.slice(0, 80));
  }
  return { tekens: tekens.slice(0, 3), eigen: eigen.slice(0, 20), ster };
}

// Hooguit één vlakje per regel (plan § 2.2). l = mailLaag[draad] of undefined; vw = voorwerk.lijst[draad]; kan = Socev ziet een vraag
// (kandidaat voor voorwerk, zonder het te maken); storing = MailMan las de laatste 45 min niet.
function vlakVan(l, vw, kan, storing) {
  if (l && l.slot) return { id: 'slot', tekst: 'niet door AI gelezen', kleur: 'rood' };
  if (l && l.app_wacht) return { id: 'onderweg', tekst: l.app_wacht === 'facturen' ? 'Naar Facturen…' : 'Naar Brain…', kleur: 'blauw' };
  if (vw && vw.concept && !vw.in_gmail) return { id: 'antwoord-klaar', tekst: 'Antwoord klaar', kleur: 'blauw' };
  if (vw && vw.in_gmail) return { id: 'concept-gmail', tekst: 'Concept in Gmail', kleur: 'grijs' };
  if (l && l.laag === 'socev') {
    if (l.reden === 'facturen') return { id: 'facturen', tekst: l.detail === 'is_betaald' ? '✓ Betaald' : '✓ In Facturen', kleur: 'grijs' };
    if (l.reden === 'second_brain') return { id: 'brain', tekst: '✓ In Brain', kleur: 'grijs' };
    return { id: 'naar-brain', tekst: 'Naar Brain', kleur: 'grijs' };
  }
  if (l && l.laag === 'weg') return l.reden === 'nieuwsbrief' ? { id: 'kan-weg', tekst: 'Nieuwsbrief · kan weg', kleur: 'grijs' } : { id: 'kan-weg', tekst: 'kan weg', kleur: 'grijs' };
  if (kan) return { id: 'antwoord', tekst: 'Antwoord?', kleur: 'blauw' };
  if (!l && storing) return { id: 'ongelezen-socev', tekst: 'nog niet door Socev gelezen', kleur: 'geel' };
  return null;
}

function valideerLijst(d) {
  d = isObj(d) ? d : {};
  const map = d.map == null ? 'inbox' : String(d.map);
  if (!MAPPEN.includes(map)) return { fout: 'onbekende map' };
  const q = d.q == null ? '' : String(d.q);
  if (q.length > Q_MAX || /[\u0000-\u001f\u007f]/.test(q)) return { fout: 'de zoekvraag is te lang of bevat rare tekens' };
  const pagina = d.pagina == null || d.pagina === '' ? '' : String(d.pagina);
  if (pagina && !PAGINA_RE.test(pagina)) return { fout: 'onbekende pagina' };
  return { map, q: q.trim(), pagina };
}

// De kale luik-uitkomst → regels voor het scherm (alleen bekende velden, op lengte geknipt)
function schoonLijst(j) {
  const kaart = new Map((Array.isArray(j.labels) ? j.labels : []).map(function (l) { return [String(l.id || ''), String(l.naam || '')]; }));
  const regels = [];
  for (const g of Array.isArray(j.gesprekken) ? j.gesprekken : []) {
    if (!isObj(g) || !DRAAD_RE.test(String(g.draad || ''))) continue;
    if (g.fout) { regels.push({ draad: g.draad, fout: true }); continue; }
    const lab = Array.isArray(g.labels) ? g.labels.map(String) : [];
    const v = vertaalLabels(lab, kaart);
    regels.push({ draad: g.draad, berichten: Number(g.berichten) || 1, ids: (Array.isArray(g.ids) ? g.ids : []).map(String).filter(function (x) { return DRAAD_RE.test(x); }).slice(-50),
      van: str(g.van, 300), namen: (Array.isArray(g.namen) ? g.namen : []).map(function (x) { return str(x, 80); }).slice(-4), onderwerp: str(g.onderwerp, 300),
      snippet: str(g.snippet, 250), datum: str(g.datum, 40), ongelezen: g.ongelezen === true, bijlage: g.bijlage === true, ster: v.ster,
      inbox: lab.includes('INBOX'), concept: lab.includes('DRAFT'), tekens: v.tekens, eigen: v.eigen,
      vast: WIJZIG_LABELS.filter(function (n) { return lab.some(function (id) { return (kaart.has(id) ? kaart.get(id) : id) === n; }); }) });   // wv3090: stand van het labelmenu
  }
  const eigenLabels = Array.from(kaart.entries()).filter(function (e) { return vertaalLabels([e[0]], kaart).eigen.length; }).map(function (e) { return e[1].slice(0, 80); }).sort();
  return { regels, eigenLabels };
}

// datumdetector-treffers → eerste datum vandaag of later (YYYY-MM-DD) of null; nooit een rol die een geboortedatum kan zijn
function kiesDatum(treffers, vandaag) {
  for (const t of Array.isArray(treffers) ? treffers : []) {
    const s = String((t && t.start) || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s < vandaag) continue;
    if (t.rol && /geboorte|geheim/.test(String(t.rol))) continue;
    return s;
  }
  return null;
}
function amsDag(ms) { try { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); } catch (e) { return new Date(ms).toISOString().slice(0, 10); } }
function gmailLink(draad) { return 'https://mail.google.com/mail/u/0/#all/' + draad; }
function zonderHtml(h) { return String(h || '').replace(/<(style|script)[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').slice(0, 50000); }

function maak(io) {
  const nu = io.nu || Date.now;
  const fout = io.fout || function () {};
  function storingVan(regel) {
    if (!regel || !regel.aan) return { mailman: false, laatste_geslaagd: null };
    const t = Date.parse(regel.laatste_geslaagd || '');
    return { mailman: !Number.isFinite(t) || nu() - t > RONDE_OUD_MS, laatste_geslaagd: regel.laatste_geslaagd || null };
  }
  async function lijst(d) {
    const v = valideerLijst(d);
    if (v.fout) return { status: 400, j: { ok: false, fout: v.fout } };
    let j;
    try { j = await io.luik({ actie: 'mail_lijst', map: v.map, q: v.q, max: 50, pagina: v.pagina || undefined }); } catch (e) { fout('mail-app-lijst', e); j = null; }
    if (!isObj(j) || !Array.isArray(j.gesprekken) || (j.melding && /^fout bij lijst/.test(String(j.melding)))) {
      return { status: 502, j: { ok: false, luik: false, fout: 'Gmail is even niet bereikbaar; de lijst hieronder is niet van nu' } };
    }
    const s = schoonLijst(j);
    let regel = null;
    try { regel = io.mailman.mailRegel(); } catch (e) { fout('mail-app-regel', e); }
    const storing = storingVan(regel);
    const draden = s.regels.filter(function (r) { return !r.fout; }).map(function (r) { return r.draad; });
    let laag = {}, vw = {}, kan = {};
    try { laag = io.mailman.mailLaag(draden) || {}; } catch (e) { fout('mail-app-laag', e); }
    try { vw = io.voorwerkLijst ? io.voorwerkLijst(draden) || {} : {}; } catch (e) { fout('mail-app-voorwerk', e); }
    try { kan = io.voorwerkKan ? io.voorwerkKan(draden) || {} : {}; } catch (e) { fout('mail-app-kan', e); }
    for (const r of s.regels) {
      if (r.fout) continue;
      const l = laag[r.draad];
      r.vlak = vlakVan(l, vw[r.draad], !!kan[r.draad], storing.mailman);
      r.slot = !!(l && l.slot);
      if (r.slot) r.snippet = '';
      r.socev = l ? { laag: l.laag, reden: l.reden, inbox: l.inbox, zou_weg: !!l.zou_weg } : null;
    }
    const eerste = v.map === 'inbox' && !v.q && !v.pagina;
    return { status: 200, j: { ok: true, map: v.map, q: v.q, volgende: PAGINA_RE.test(String(j.volgende || '')) ? String(j.volgende) : null,
      inbox: isObj(j.inbox) && j.inbox.ok ? { totaal: Number(j.inbox.totaal) || 0, ongelezen: Number(j.inbox.ongelezen) || 0 } : null,
      gesprekken: s.regels, eigen_labels: s.eigenLabels, deels: !!j.melding, opgehaald: new Date(nu()).toISOString(),
      regel: eerste && regel && regel.aan ? regel : null, storing } };
  }
  async function gesprek(d) {
    d = isObj(d) ? d : {};
    const draad = String(d.draad || '');
    if (!DRAAD_RE.test(draad)) return { status: 400, j: { ok: false, fout: 'geen gesprek' } };
    let l = null;
    try { l = (io.mailman.mailLaag([draad]) || {})[draad] || null; } catch (e) { fout('mail-app-laag', e); return { status: 500, j: { ok: false, fout: 'fout op de pod' } }; }
    const dicht = { status: 403, j: { ok: false, slot: true, link: gmailLink(draad), fout: 'In dit gesprek zag Socev mogelijk patiëntgegevens. Open het in Gmail.' } };
    if (l && l.slot) return dicht;
    let j;
    try { j = await io.luik({ actie: 'mail_gesprek', draad }); } catch (e) { fout('mail-app-gesprek', e); j = null; }
    if (!isObj(j) || j.fout || !Array.isArray(j.berichten) || String(j.draad || '') !== draad) return { status: 502, j: { ok: false, luik: false, fout: 'Gmail gaf dit gesprek nu niet; probeer het zo opnieuw' } };
    const berichten = j.berichten.filter(isObj).map(function (b) {
      return { id: DRAAD_RE.test(String(b.id || '')) ? String(b.id) : '', van: str(b.van, 400), aan: str(b.aan, 1000), cc: str(b.cc, 1000), onderwerp: str(b.onderwerp, 500),
        datum: str(b.datum, 40), ongelezen: Array.isArray(b.labels) && b.labels.includes('UNREAD'), concept: Array.isArray(b.labels) && b.labels.includes('DRAFT'),
        snippet: str(b.snippet, 250), tekst: typeof b.tekst === 'string' ? b.tekst.slice(0, 20000) : '', tekst_afgekapt: b.tekst_afgekapt === true,
        html: typeof b.html === 'string' ? b.html.slice(0, 200000) : '', html_te_groot: b.html_te_groot === true, tekst_elders: b.tekst_elders === true,
        bijlagen: (Array.isArray(b.bijlagen) ? b.bijlagen : []).filter(isObj).map(function (x) { return { naam: str(x.naam, 1000), mime: str(x.mime, 100), grootte: Number(x.grootte) || 0, inline: x.inline === true }; }).filter(function (x) { return x.naam; }) };
    });
    // Patiëntpoort vóór het scherm: dezelfde poort als MailMan en Intake, op ALLES wat de App toont (review wv3077 MOET 1): per bericht de
    // platte tekst én de html (zonder opmaak), het begin, elk onderwerp, van/aan/cc, en alle bijlagenamen
    let p;
    try {
      const teksten = [];
      for (const b of berichten) {
        for (const t of [b.tekst, zonderHtml(b.html), b.snippet, b.onderwerp, b.van, b.aan, b.cc]) if (t && String(t).trim()) teksten.push(String(t));
      }
      p = io.poort({ teksten, bijlagenamen: [].concat.apply([], berichten.map(function (b) { return b.bijlagen.map(function (x) { return x.naam; }); })),
        onderwerp: berichten.map(function (b) { return b.onderwerp; }).filter(Boolean).join(' | ').slice(0, 2000), leesbaar: true });
    } catch (e) { fout('mail-app-poort', e); return dicht; }
    if (!p || p.tegenhouden !== false) return dicht;
    let vw = null;
    try { vw = io.voorwerkLijst ? (io.voorwerkLijst([draad]) || {})[draad] || null : null; } catch (e) { fout('mail-app-voorwerk', e); }
    let kan = false;
    try { kan = io.voorwerkKan ? !!(io.voorwerkKan([draad]) || {})[draad] : false; } catch (e) { kan = false; }
    let stuk = null;
    try { stuk = io.intakeStuk ? io.intakeStuk(draad) : null; } catch (e) { stuk = null; }
    return { status: 200, j: { ok: true, draad, aantal: Number(j.aantal) || berichten.length, berichten, link: gmailLink(draad),
      socev: l ? { laag: l.laag, reden: l.reden, detail: l.detail, inbox: l.inbox, app_wacht: l.app_wacht, zou_weg: !!l.zou_weg, weggezet: !!l.weggezet, bezig: !!l.bezig } : null,
      vlak: vlakVan(l, vw, kan, false), voorwerk: vw, kent_mailman: !!l, intake_stuk: stuk } };
  }
  async function bijlage(d) {
    d = isObj(d) ? d : {};
    const draad = String(d.draad || ''), bericht = String(d.bericht || ''), naam = typeof d.naam === 'string' ? d.naam : '';
    if (!DRAAD_RE.test(draad) || !DRAAD_RE.test(bericht) || !naam || naam.length > 1000) return { status: 400, j: { ok: false, fout: 'onbekende bijlage' } };
    // review wv3077 MOET 2: een bijlage alleen uit een gesprek dat nu door de poort komt, en alleen als bericht én naam bij die draad horen
    const g = await gesprek({ draad });
    if (g.status === 403) return { status: 403, j: { ok: false, slot: true, fout: 'Open deze bijlage in Gmail' } };
    if (g.status !== 200) return g;
    const ber = g.j.berichten.find(function (x) { return x.id === bericht; });
    if (!ber || !ber.bijlagen.some(function (x) { return x.naam === naam; })) return { status: 404, j: { ok: false, fout: 'Deze bijlage hoort niet bij dit gesprek' } };
    let r;
    try { r = await io.bijlage({ actie: 'mail_bijlage', id: bericht, naam }); } catch (e) { fout('mail-app-bijlage', e); return { status: 502, j: { ok: false, fout: 'Gmail gaf de bijlage nu niet; probeer het zo opnieuw' } }; }
    if (!r || !Buffer.isBuffer(r.bytes) || !r.bytes.length) return { status: 502, j: { ok: false, fout: r && r.json && r.json.fout ? 'Deze bijlage is niet op te halen (' + str(String(r.json.fout), 80) + ')' : 'Gmail gaf de bijlage nu niet' } };
    if (r.bytes.length > 15 * 1024 * 1024) return { status: 413, j: { ok: false, fout: 'Deze bijlage is te groot voor de App; open hem in Gmail' } };
    return { status: 200, j: { ok: true, naam: naam.slice(0, 200), type: str(r.type || 'application/octet-stream', 100), inhoud: r.bytes.toString('base64') } };
  }
  // Voorstel voor Maak todo: titel = onderwerp, datum uit de detector (alleen een datum vandaag of later), link naar het gesprek
  async function todoVoorstel(d) {
    const g = await gesprek(d);
    if (g.status !== 200) return g;
    const b = g.j.berichten.filter(function (x) { return !x.concept; }).slice(-1)[0] || g.j.berichten.slice(-1)[0] || {};
    let datum = null;
    try {
      const t = await io.datums({ tekst: (b.onderwerp || '') + '\n' + (b.tekst || zonderHtml(b.html)).slice(0, 20000), anker: b.datum || undefined });
      datum = kiesDatum(t, amsDag(nu()));
    } catch (e) { datum = null; }
    return { status: 200, j: { ok: true, titel: String((g.j.berichten[0] || {}).onderwerp || b.onderwerp || '').replace(/^\s*((re|fw|fwd|aw|tr)\s*:\s*)+/i, '').trim().slice(0, TITEL_MAX) || 'Mail', datum, link: g.j.link } };
  }
  async function todo(d) {
    d = isObj(d) ? d : {};
    const draad = String(d.draad || '');
    if (!DRAAD_RE.test(draad)) return { status: 400, j: { ok: false, fout: 'geen gesprek' } };
    const titel = str(d.titel, TITEL_MAX + 1).replace(/\s+/g, ' ').trim();
    if (!titel || titel.length > TITEL_MAX) return { status: 400, j: { ok: false, fout: 'de titel is leeg of te lang (hooguit ' + TITEL_MAX + ' tekens)' } };
    const datum = d.datum == null || d.datum === '' ? null : String(d.datum);
    if (datum && !/^\d{4}-\d{2}-\d{2}$/.test(datum)) return { status: 400, j: { ok: false, fout: 'onbekende datum' } };
    // review wv3077 MOET 3: dezelfde actuele gesprekscontrole als bij openen (slot bij MailMan of de poort slaat nu aan = geen taak)
    const g = await gesprek({ draad });
    if (g.status === 403) return { status: 409, j: { ok: false, slot: true, fout: 'Bij deze mail maakt Socev geen todo (mogelijk patiëntgegevens); maak hem zelf' } };
    if (g.status !== 200) return { status: 502, j: { ok: false, fout: 'Gmail gaf dit gesprek nu niet; probeer het zo opnieuw' } };
    let p;
    try { p = io.poort({ teksten: [titel], bijlagenamen: [], onderwerp: '', leesbaar: true }); } catch (e) { p = null; }
    if (!p || p.tegenhouden !== false) return { status: 409, j: { ok: false, slot: true, fout: 'In de titel staat mogelijk een patiëntgegeven; pas hem aan' } };
    const body = { content: titel, description: 'Uit OVIS Mail: ' + gmailLink(draad) };
    if (datum) body.due_date = datum;
    let r;
    try { r = await io.todoist(body); } catch (e) { fout('mail-app-todo', e); return { status: 502, j: { ok: false, fout: 'Todoist is even niet bereikbaar; probeer het zo opnieuw' } }; }
    if (!r || r.status === 401 || r.status === 403) return { status: 502, j: { ok: false, rechten: true, fout: 'Todoist laat Socev geen taak maken (' + (r ? r.status : 'geen antwoord') + ')' } };
    if (r.status < 200 || r.status >= 300 || !isObj(r.j) || !r.j.id) return { status: 502, j: { ok: false, fout: 'De taak kwam niet in Todoist (' + r.status + ')' } };
    return { status: 200, j: { ok: true, id: String(r.j.id).slice(0, 40), titel, datum } };
  }
  // wv3090: POST /app/mail/wijzig { draden: [..] (of draad), wat, label? } — alleen op Davids tik (server.js: app-sessie, niet afgeschermd,
  // primair, uurgrens). Per gesprek één luik-aanroep mail_wijzig met een eenmalige pas die n8n bij de pod terugtoetst (io.pas): het luikgeheim
  // alleen (dat ook Socevs skills kennen) is niet genoeg om iets in Gmail te veranderen. Een label van MailMan nooit bij een slotje of als de
  // patiëntpoort nu aanslaat (archiveren, gelezen en ster mogen wel: dat raakt de inhoud niet en leest niets). Na een gelukt archiveren/terugzetten werkt MailMans zaakregister
  // meteen bij (de regel bovenaan klopt zonder op de volgende ronde te wachten); al het andere volgt de volgende ronde.
  async function wijzig(d) {
    d = isObj(d) ? d : {};
    const wat = String(d.wat || '');
    const w = Object.prototype.hasOwnProperty.call(WIJZIG, wat) ? WIJZIG[wat] : null;
    if (!w) return { status: 400, j: { ok: false, fout: 'onbekende handeling' } };
    const ruw = Array.isArray(d.draden) ? d.draden : (d.draad != null ? [d.draad] : []);
    const draden = [];
    for (const x of ruw) { const t = String(x || ''); if (!DRAAD_RE.test(t)) return { status: 400, j: { ok: false, fout: 'geen gesprek' } }; if (!draden.includes(t)) draden.push(t); }
    if (!draden.length || draden.length > WIJZIG_MAX) return { status: 400, j: { ok: false, fout: 'kies 1 tot ' + WIJZIG_MAX + ' gesprekken' } };
    let erbij = (w.erbij || []).slice(), eraf = (w.eraf || []).slice(), labelNaam = null;
    if (w.label) {
      labelNaam = String(d.label || '');
      if (!WIJZIG_LABELS.includes(labelNaam)) return { status: 400, j: { ok: false, fout: 'dit label staat niet in de vaste lijst' } };
      let ids = null;
      try { ids = io.labelIds(); } catch (e) { fout('mail-app-wijzig-labels', e); ids = null; }
      const id = isObj(ids) ? String(ids[labelNaam] || '') : '';
      if (!LABEL_ID_RE.test(id)) return { status: 409, j: { ok: false, fout: 'MailMan kent dit label in je Gmail nog niet' } };
      if (w.label === 'erbij') erbij = [id]; else eraf = [id];
    }
    // De registerrij is de toestemming (grondwet regel 7, toestemmingenregister): zonder rij met status aan doet de App niets in Gmail.
    let mag = false;
    try { mag = io.toestemming() === true; } catch (e) { fout('mail-app-wijzig-register', e); mag = false; }
    if (!mag) return { status: 409, j: { ok: false, register: false, link: gmailLink(draden[0]), fout: 'Dit kan in de App pas na je Ja in Voor jou; Gmail opent dit gesprek' } };
    if (labelNaam) {
      // review wv3090 MOET 2: een label (het stuurt Intake/Facturen) alleen na dezelfde controle als bij het lezen: slot bij MailMan óf de
      // patiëntpoort slaat nu aan op het hele gesprek (gesprek() hieronder). Slot of onzekere uitkomst (Gmail gaf het gesprek niet) = niets.
      for (const t of draden) {
        let g;
        try { g = await gesprek({ draad: t }); } catch (e) { fout('mail-app-wijzig-poort', e); g = null; }
        if (g && g.status === 403) return { status: 409, j: { ok: false, slot: true, fout: 'Bij een gesprek met mogelijk patiëntgegevens zet Socev geen label; doe het in Gmail' } };
        if (!g || g.status !== 200) return { status: 502, j: { ok: false, fout: 'Gmail gaf een gesprek nu niet; er is niets veranderd. Probeer het zo opnieuw' } };
      }
    }
    const gedaan = [], mislukt = [];
    for (const t of draden) {
      let r = null;
      try {
        const pas = io.pas({ draad: t, erbij, eraf });
        r = await io.luik({ actie: 'mail_wijzig', draad: t, erbij, eraf, pas });
      } catch (e) { fout('mail-app-wijzig', e); r = null; }
      if (isObj(r) && r.ok === true && String(r.draad || '') === t) {
        gedaan.push(t);
        if (wat === 'archiveer' || wat === 'terug') { try { io.mailman.mailTik(t, wat); } catch (e) { fout('mail-app-wijzig-zaak', e); } }
      } else mislukt.push(t);
    }
    // Ongedaan maken: de App bepaalt per gesprek wat er echt veranderde (review wv3090 MOET 1) en stuurt alleen dat terug; tegen = de handeling ervoor
    if (!gedaan.length) return { status: 502, j: { ok: false, gedaan, mislukt, fout: 'Gmail nam het nu niet aan; probeer het zo opnieuw' } };
    return { status: 200, j: { ok: true, wat, label: labelNaam, gedaan, mislukt, tegen: w.terug } };
  }
  return { lijst, gesprek, bijlage, todoVoorstel, todo, wijzig };
}

// wv3090: eenmalige passen voor mail_wijzig. maak(handeling) → pas (32 hex, 60 s geldig, hooguit 200 open); toets(d) → { ok } alleen als
// de pas bestaat, niet verlopen is en draad + erbij + eraf precies gelijk zijn (volgorde telt niet). Een getoetste pas is op, ook bij nee.
function passen(o) {
  const nu = o.nu, toeval = o.toeval, m = new Map(), DUUR = 60000, MAX = 200;
  const sleutel = function (x) { const l = function (a) { return (Array.isArray(a) ? a : []).map(String).slice().sort().join(','); }; return String((x && x.draad) || '') + '|' + l(x && x.erbij) + '|' + l(x && x.eraf); };
  function maak(x) {
    const n = nu();
    for (const [k, v] of m) if (n - v.t > DUUR) m.delete(k);
    if (m.size >= MAX) throw new Error('te veel open passen');
    const pas = String(toeval());
    if (!/^[0-9a-f]{32}$/.test(pas)) throw new Error('pas niet goed');
    m.set(pas, { s: sleutel(x), t: n });
    return pas;
  }
  function toets(d) {
    d = isObj(d) ? d : {};
    const pas = typeof d.pas === 'string' && /^[0-9a-f]{32}$/.test(d.pas) ? d.pas : '';
    const v = pas ? m.get(pas) : null;
    if (pas) m.delete(pas);
    const ok = !!v && nu() - v.t <= DUUR && v.s === sleutel(d);
    return { status: 200, j: ok ? { ok: true, pas } : { ok: false } };
  }
  return { maak, toets, open: function () { return m.size; } };
}

module.exports = { passen, maak, vertaalLabels, vlakVan, schoonLijst, valideerLijst, kiesDatum, gmailLink, MAPPEN, VERBORGEN, TEKENS, ENTITEITEN, WIJZIG, WIJZIG_LABELS };
