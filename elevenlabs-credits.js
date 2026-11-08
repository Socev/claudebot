'use strict';
/*
 * ElevenLabs-credits (wv2751, 8-11-2026). David 8-11 14:15 (app, machinekamer): "Je rekent elke keer met geldbedragen voor TTS, maar volgens
 * mij gebruik je ElevenLabs, en gaat dat gewoon van mijn credits af".
 *
 * WAAROM. David heeft een vooruitbetaald ElevenLabs-abonnement (Creator, jaarlijks, 121.000 credits per maand, onverbruikte credits schuiven
 * door; verlengt op de 18e). Elke aanroep van Socev (MemoryLane-verteller, Studio, Bandjes; allemaal via de Olares Router) gaat van die
 * bundel af; er wordt pas geld betaald als de bundel op is en pay-as-you-go aanspringt. De oude euro-plafonds (verteller € 5, Studio € 10 per
 * maand op een verzonnen prijs) weigerden dus terwijl er niets betaald werd. Deze module telt in credits en remt alleen vóór de bundel op is.
 *
 * GEMETEN 8-11 (mk-scripts/wv2751): GET /v1/usage/character-stats (n8n-credential Elevenlabs-API) gaf deze periode 21.861 credits, gelijk aan
 * Davids scherm ("Credits used 21,861 / 288,822"). GET /v1/user/subscription kan geen van onze sleutels (user_read ontbreekt), en de Router
 * stuurt alleen text-to-speech door (GET /v1/user/... 404). De pod kent dus de stand bij de meting plus wat hij sindsdien zelf verbruikte
 * (kop character-cost per aanroep, anders een ruime schatting). Gebruik buiten Socev (David zelf op elevenlabs.io) ziet hij pas bij een nieuwe
 * meting: daarom remt hij op 5 % van de bundel, en na een reset zonder nieuwe meting rekent hij alleen met de maandbundel (121.000), nooit
 * met doorgeschoven credits die hij niet gemeten heeft.
 *
 * Instelling (optioneel) in <bestand> (JSON, 0600): { maand_bundel, reset_dag, rem_procent, meting: { op, gebruikt, limiet } } — een nieuwe
 * meting zet de machinekamer daar neer (mk-scripts/wv2751/el.py). Geen sleutels, geen tekst.
 */
const fs = require('fs');

const STANDAARD = {
  maand_bundel: 121000, reset_dag: 18, rem_procent: 5,
  meting: { op: '2026-11-08T13:11:00Z', gebruikt: 21861, limiet: 288822 },   // Davids scherm 8-11 14:11 = usage-API (zelfde getal)
};
// Credits per teken, ruim (gemeten 8-11: eleven_v4 via de verteller 0,44 per teken over 22 aanroepen; Studio 22-10: 12 tekens = 5 credits).
// ElevenLabs rekent v3/multilingual 1 per teken, flash 0,5.
const PER_TEKEN = { eleven_v4: 0.5, eleven_v3: 1, eleven_multilingual_v2: 1, eleven_flash_v2_5: 0.5 };
function schat(tekens, model) {
  const n = Math.max(0, Math.round(Number(tekens) || 0));
  return n ? Math.ceil(n * (PER_TEKEN[model] || 1)) : 0;
}
function getal(n) { return Math.round(Number(n) || 0).toLocaleString('nl-NL'); }

// Begin van de lopende periode (00:00 UTC op de resetdag; dag ≤ 28) en het begin van de volgende.
function periode(ms, dag) {
  const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth();
  let b = Date.UTC(y, m, dag);
  if (ms < b) b = Date.UTC(y, m - 1, dag);
  const bd = new Date(b);
  return { begin: b, eind: Date.UTC(bd.getUTCFullYear(), bd.getUTCMonth() + 1, dag) };
}

/*
 * maak({ bestand, nu, fout }) → { bron(naam, fn), stand(), past(nodig[, st]), tekst([st]), weigering(nodig, wat[, st]), schat, periode, getal }
 * bron(naam, fn): fn(iso) → credits die dat onderdeel van Socev sinds iso verbruikte (getal).
 */
function maak(o) {
  o = o || {};
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const fout = (l, e) => { if (typeof o.fout === 'function') o.fout(l, e); };
  const bronnen = new Map();
  function inst() {
    let j = null;
    if (o.bestand) { try { j = JSON.parse(fs.readFileSync(o.bestand, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') fout('eleven-credits', e); } }
    const x = Object.assign({}, STANDAARD, j && typeof j === 'object' ? j : {});
    const ok = (v, min, max) => Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max;
    if (!ok(x.maand_bundel, 1, 1e8)) x.maand_bundel = STANDAARD.maand_bundel;
    if (!Number.isInteger(Number(x.reset_dag)) || !ok(x.reset_dag, 1, 28)) x.reset_dag = STANDAARD.reset_dag;
    if (!ok(x.rem_procent, 0, 50)) x.rem_procent = STANDAARD.rem_procent;
    const mt = x.meting && typeof x.meting === 'object' ? x.meting : null;
    x.meting = mt && Number.isFinite(Date.parse(mt.op)) && ok(mt.gebruikt, 0, 1e9) && ok(mt.limiet, 1, 1e9) ? mt : null;
    return { maand_bundel: Number(x.maand_bundel), reset_dag: Number(x.reset_dag), rem_procent: Number(x.rem_procent), meting: x.meting };
  }
  // review wv2751 MOET 5: een bron die niet te lezen is, telt niet als 0 maar maakt de stand onvolledig (ruimte 0: niets nieuws)
  function socevSinds(iso, st) {
    let s = 0;
    for (const [naam, fn] of bronnen) {
      try { const v = Number(fn(iso)); if (!Number.isFinite(v) || v < 0) throw new Error('geen geldige stand'); s += v; }
      catch (e) { fout('eleven-credits-' + naam, e); if (st) st.onleesbaar = true; }
    }
    return Math.round(s);
  }
  // → { gebruikt, limiet, over, rem_vanaf, ruimte, periode_van, periode_tot, rem_procent, socev, bron: 'meting' | 'zonder meting' }
  function stand() {
    const c = inst(), t = nu(), p = periode(t, c.reset_dag);
    const mt = c.meting, mOp = mt ? Date.parse(mt.op) : NaN;
    let gebruikt, limiet, bron;
    const ok = { onleesbaar: false };
    const socev = socevSinds(new Date(p.begin).toISOString(), ok);
    if (mt && mOp >= p.begin && mOp <= t) {
      gebruikt = Math.round(Number(mt.gebruikt)) + socevSinds(new Date(mOp).toISOString(), ok);
      limiet = Math.round(Number(mt.limiet)); bron = 'meting';
    } else {
      gebruikt = socev; limiet = c.maand_bundel; bron = 'zonder meting';
    }
    const remVanaf = Math.floor(limiet * (1 - c.rem_procent / 100));
    return { gebruikt, limiet, over: Math.max(0, limiet - gebruikt), rem_vanaf: remVanaf, ruimte: ok.onleesbaar ? 0 : Math.max(0, remVanaf - gebruikt), onleesbaar: ok.onleesbaar,
      periode_van: new Date(p.begin).toISOString(), periode_tot: new Date(p.eind).toISOString(), rem_procent: c.rem_procent, socev, bron };
  }
  function past(nodig, st) { st = st || stand(); return Math.max(0, Math.round(Number(nodig) || 0)) <= st.ruimte; }
  function tekst(st) {
    st = st || stand();
    return getal(st.gebruikt) + ' van ' + getal(st.limiet) + ' credits deze periode, ' + getal(st.over) + ' over';
  }
  function datumNL(iso) { return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', timeZone: 'Europe/Amsterdam' }); }
  // De weigering in gewone taal (zonder geld): de bundel is bijna op.
  function weigering(nodig, wat, st) {
    st = st || stand();
    if (st.onleesbaar) return 'het verbruik van je ElevenLabs-bundel is nu niet volledig te lezen; Socev maakt daarom even niets nieuws. Probeer het later opnieuw.';
    return 'je ElevenLabs-bundel is bijna op (' + tekst(st) + '); ' + (wat || 'dit') + ' kost ± ' + getal(nodig) + ' credits. Socev stopt bij ' +
      st.rem_procent + ' % over, zodat er niets bijbetaald wordt; op ' + datumNL(st.periode_tot) + ' komen er nieuwe credits.';
  }
  function bron(naam, fn) { if (typeof fn === 'function') bronnen.set(String(naam), fn); }
  return { bron, stand, past, tekst, weigering, schat, periode, getal };
}

module.exports = { maak, schat, periode, getal, PER_TEKEN, STANDAARD };
