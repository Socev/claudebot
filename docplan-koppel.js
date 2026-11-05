'use strict';
/*
 * DocPlan — koppelscherm roosternaam → persoon in de app (wv2159, 1-11-2026; idee 25; vault "01_Ontwikkeling/OVIS DocPlan - ontwerp
 * (31-10-2026).md" § 3 koppelscherm en § 4.1 uitwerking koppelscherm). Sinds wv2154 hangt elke roosterdienst via secondbrain.dienst_alias
 * (migratie 0019) aan een persoon zodra zijn roosternaam een alias heeft; alle aliassen zijn voorstellen. Hier bevestigt David ze met één tik
 * (Apps › Facturen › Waarnemers › Roosternamen), kiest hij een andere persoon, vraagt hij een nieuwe persoon of zegt hij "geen waarnemer".
 *
 *   GET  /app/facturen/roosternamen[/<jaar>]  → public.sb_dienst_alias_lijst(jaar): per praktijk de namen met dagen in dat jaar
 *   POST /app/facturen/roosternamen           {praktijk TG|GH, naam, status bevestigd|geen|nieuw|weg, object_id bij bevestigd}
 *                                             → public.sb_dienst_alias_zet([item], 'david')
 * Alleen de eigenaar (Davids app-sessie; server.js appFacturen, vóór facturen.js: de praktijkmanager-ingang /fac kent de route niet) en
 * alleen op de primaire kant. p_door is altijd 'david' en komt nooit uit het verzoek; van het verzoek gaan alleen deze vier velden mee.
 * De koppeling dienst → persoon (event_entity betreft, met de status) houdt de databank zelf bij (triggers van 0019).
 *
 * Puur: deze module laadt niets en raakt geen bestanden; server.js geeft rpc(fn, body) mee (appSbRpc, service_role). Niets opgeslagen op de
 * pod; namen gaan alleen in het antwoord aan Davids app, nooit in een log (de reden noemt alleen jaar of status).
 *
 * wv2531 (David 5-11-2026 21:43: "wat gebeurt hier als ik klik Nieuwe persoon?" — tot dan niets, de vraag bleef liggen): "Nieuwe persoon" gaat zelf
 * naar de machinekamer. Na een geslaagde POST met status nieuw roept de module o.nieuw(items, nu) aan (server.js: één werklijstrij per uur, herkomst
 * david); bij GET ook voor een naam met status nieuw die nog niet op de werklijst staat (eerdere keuze of mislukte poging). o.gevraagd() geeft een
 * opzoeker (praktijk, naam) → { t, wv } | null; het scherm toont dan "wordt aangemaakt" met het tijdstip. Beide optioneel: zonder werkt alles zoals
 * vóór wv2531. Een fout daarin breekt de keuze of de lijst nooit.
 */
const PRAKTIJK = { TG: 'Tolgaarde', GH: 'Groenhouten' };
const STATUS = ['bevestigd', 'geen', 'nieuw', 'weg'];
const PAD_RE = /^\/app\/facturen\/roosternamen(?:\/(\d{4}))?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JAAR_MIN = 2025;   // de tijdlijn bewaart de roosters vanaf 1-1-2025 (ontwerp § 4.1)

function dagAmsterdam(nu) { return new Date(nu).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
// volgorde op het scherm: eerst zonder persoon (ook "nieuwe persoon gevraagd"), dan voorgesteld, dan door David gekozen
const GROEP = { zonder: 0, nieuw: 0, voorgesteld: 1, bevestigd: 2, geen: 2 };

/* vorm(lijst, jaar, nu[, gevraagd]) → wat de app toont: alleen namen met dagen in het jaar; status null wordt 'zonder'. Bij status nieuw ook
 * gevraagd_op (ISO of null) en op_werklijst (wv2531), uit gevraagd(praktijk, naam). */
function vorm(l, jaar, nu, gevraagd) {
  const praktijken = (Array.isArray(l && l.praktijken) ? l.praktijken : []).filter((p) => PRAKTIJK[p.code]).map((p) => {
    const namen = (Array.isArray(p.namen) ? p.namen : []).filter((n) => Number(n.dagen) > 0).map((n) => ({
      naam: String(n.naam), dagen: Number(n.dagen), eerste: n.eerste || null, laatste: n.laatste || null,
      status: GROEP[n.status] !== undefined && n.status !== 'zonder' ? n.status : 'zonder', object_id: n.object_id || null,
      persoon: n.persoon || null, samengevoegd: n.samengevoegd === true,
    })).map((n) => {
      if (n.status !== 'nieuw') return n;
      let g = null;
      try { g = typeof gevraagd === 'function' ? gevraagd(p.code, n.naam) : null; } catch (e) { g = null; }
      return Object.assign(n, { gevraagd_op: g && typeof g.t === 'string' ? g.t : null, op_werklijst: !!(g && g.wv) });
    }).sort((a, b) => GROEP[a.status] - GROEP[b.status] || b.dagen - a.dagen || a.naam.localeCompare(b.naam, 'nl'));
    const tel = (f) => namen.filter(f).length;
    const dagen = (f) => namen.filter(f).reduce((s, n) => s + n.dagen, 0);
    return { code: p.code, naam: PRAKTIJK[p.code], namen, n_namen: namen.length,
      n_zonder: tel((n) => n.status === 'zonder' || n.status === 'nieuw'), n_nieuw: tel((n) => n.status === 'nieuw'),
      n_voorgesteld: tel((n) => n.status === 'voorgesteld'), n_bevestigd: tel((n) => n.status === 'bevestigd'), n_geen: tel((n) => n.status === 'geen'),
      dagen: dagen(() => true), dagen_zonder: dagen((n) => n.status === 'zonder' || n.status === 'nieuw') };
  }).sort((a, b) => (a.code === 'TG' ? 0 : 1) - (b.code === 'TG' ? 0 : 1));
  const personen = (Array.isArray(l && l.personen) ? l.personen : []).map((p) => ({
    object_id: String(p.object_id), naam: String(p.naam), status: p.status || null,
    praktijken: [...new Set((Array.isArray(p.rollen) ? p.rollen : []).map((r) => r.praktijk).filter((c) => PRAKTIJK[c]))],
    rollen: (Array.isArray(p.rollen) ? p.rollen : []).filter((r) => PRAKTIJK[r.praktijk]).map((r) => ({ praktijk: r.praktijk, rol: r.rol || null })),
  }));
  const dit = Number(dagAmsterdam(nu).slice(0, 4));
  const jaren = [];
  for (let j = JAAR_MIN; j <= dit + 1; j++) jaren.push(String(j));   // + 1: het rooster loopt zes maanden vooruit
  return { jaar: String(jaar), afwijking: Number(l && l.afwijking) || 0, praktijken, personen, jaren, opgehaald: new Date(nu).toISOString() };
}

/* item(d) → { item } of { fout }: alleen praktijk, naam, status en (bij bevestigd) object_id; p_door hoort er nooit bij. */
function item(d) {
  d = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  if (!PRAKTIJK[d.praktijk]) return { fout: 'onbekende praktijk' };
  if (typeof d.naam !== 'string' || !d.naam.length || d.naam.length > 200 || d.naam !== d.naam.trim() || /[\u0000-\u001f\u007f]/.test(d.naam)) return { fout: 'ongeldige roosternaam' };
  if (!STATUS.includes(d.status)) return { fout: 'onbekende keuze' };
  const it = { praktijk: d.praktijk, naam: d.naam, status: d.status, bron: 'koppelscherm' };
  if (d.status === 'bevestigd') {
    if (typeof d.object_id !== 'string' || !UUID_RE.test(d.object_id)) return { fout: 'kies een persoon' };
    it.object_id = d.object_id;
  } else if (d.object_id != null && d.object_id !== '') return { fout: 'bij deze keuze hoort geen persoon' };
  return { item: it };
}

/*
 * maak({ rpc(fn, body) → Promise<json>, fout(waar, e) }) → { app(verzoek) }.
 * verzoek = { methode, pad, d, rol, primair, nu } → Promise<{ status, j, reden }>.
 */
function maak(o) {
  o = o || {};
  // wv2531: naar de werklijst van de machinekamer; nooit een fout naar buiten
  async function naarWerklijst(items, nu) {
    if (typeof o.nieuw !== 'function' || !items.length) return null;
    try { return (await o.nieuw(items, nu)) || { ok: false }; } catch (e) {
      if (typeof o.fout === 'function') o.fout('roosternamen', e);
      return { ok: false };
    }
  }
  function opzoeker() {
    if (typeof o.gevraagd !== 'function') return null;
    try { return o.gevraagd(); } catch (e) { if (typeof o.fout === 'function') o.fout('roosternamen', e); return null; }
  }
  async function app(v) {
    const nu = Number.isFinite(v.nu) ? v.nu : Date.now();
    const m = PAD_RE.exec(String(v.pad || ''));
    if (!m || (v.methode !== 'GET' && v.methode !== 'POST') || (v.methode === 'POST' && m[1])) return { status: 404, j: { ok: false, fout: 'onbekend' }, reden: 'roosternamen onbekend' };
    if (!v.rol || v.rol.soort !== 'eigenaar' || v.rol.ingang !== 'app') return { status: 403, j: { ok: false, fout: 'alleen de eigenaar' }, reden: 'roosternamen geweigerd' };
    if (v.primair !== true) return { status: 409, j: { ok: false, fout: 'Facturen draait alleen op de primaire kant' }, reden: 'roosternamen niet primair' };
    if (v.methode === 'GET') {
      const dit = Number(dagAmsterdam(nu).slice(0, 4));
      const jaar = m[1] ? Number(m[1]) : dit;
      if (jaar < JAAR_MIN || jaar > dit + 1) return { status: 400, j: { ok: false, fout: 'jaar buiten bereik' }, reden: 'roosternamen jaar' };
      try {
        const l = await o.rpc('sb_dienst_alias_lijst', { p_jaar: jaar });
        let w = vorm(l, jaar, nu, opzoeker());
        const los = [];
        w.praktijken.forEach((p) => p.namen.forEach((n) => { if (n.status === 'nieuw' && !n.op_werklijst) los.push({ praktijk: p.code, naam: n.naam, t: null }); }));
        if (los.length && (await naarWerklijst(los, nu) || {}).ok) w = vorm(l, jaar, nu, opzoeker());
        return { status: 200, j: Object.assign({ ok: true }, w), reden: 'roosternamen ' + jaar };
      } catch (e) {
        if (typeof o.fout === 'function') o.fout('roosternamen', e);
        return { status: 503, j: { ok: false, fout: 'de roosternamen zijn nu niet te lezen' }, reden: 'roosternamen fout' };
      }
    }
    const x = item(v.d);
    if (x.fout) return { status: 400, j: { ok: false, fout: x.fout }, reden: 'roosternaam ongeldig' };
    let r;
    try { r = await o.rpc('sb_dienst_alias_zet', { p_items: [x.item], p_door: 'david' }); } catch (e) {
      if (typeof o.fout === 'function') o.fout('roosternamen', e);
      return { status: 503, j: { ok: false, fout: 'niet opgeslagen: de databank is nu niet bereikbaar' }, reden: 'roosternaam fout' };
    }
    const fouten = r && Array.isArray(r.fouten) ? r.fouten : null;
    if (!fouten) return { status: 503, j: { ok: false, fout: 'niet opgeslagen: onverwacht antwoord van de databank' }, reden: 'roosternaam fout' };
    if (fouten.length) return { status: 409, j: { ok: false, fout: 'niet opgeslagen: ' + String(fouten[0].reden || 'geweigerd').replace(/^dienst_alias:\s*/, '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'die keuze').slice(0, 200) }, reden: 'roosternaam geweigerd' };
    const j = { ok: true, status: x.item.status, uitkomst: { nieuw: r.nieuw, bijgewerkt: r.bijgewerkt, ongewijzigd: r.ongewijzigd, weg: r.weg } };
    if (x.item.status === 'nieuw' && typeof o.nieuw === 'function') {
      const w = await naarWerklijst([{ praktijk: x.item.praktijk, naam: x.item.naam, t: new Date(nu).toISOString() }], nu);
      j.werklijst = !!(w && w.ok);
    }
    return { status: 200, j, reden: 'roosternaam ' + x.item.status };
  }
  return { app };
}

module.exports = { maak, vorm, item, PAD_RE };
