'use strict';
// ── Eén tik Gedaan sluit dezelfde klus overal (wv4038, besluitenpagina nr 363 = 3C63, David Ja 21-11-2026 13:09) ──
// WAAROM. Dezelfde klus stond vaak op twee of drie plekken: als actiepunt (actie_state), als deadline in 00_Systeem/Deadlines.md en als
// Todoist-taak. Het actielijstje ontdubbelde alleen op gelijkende tekst ("staat ook in"; bij 98 lijstregels nooit gevuld) en een tik sloot één
// plek; de klussen die 8× terugkwamen hadden ook een uiterste datum in het register. Nu koppelen de schrijvers de plekken met een zekere
// sleutel, en Gedaan op één plek sluit ze allemaal. Nooit op gelijkende tekst: een verkeerde koppeling zou een andere klus sluiten.
// HOE.
//  1. Koppeling (alleen gezette sleutels):
//     - in de deadlineregel, cel Actie: "(koppel: actie <actie_id>; todoist <taak-id>)" (één of beide; nachtconsolidatie en actie-bewaker
//       schrijven het). Titel en sleutel dl:… van de regel blijven gelijk (de sleutel komt uit entiteit + Wat).
//     - in de beschrijving van een Todoist-taak: "koppel: actie <actie_id>" en/of "koppel: dl:<sha40>".
//     De pod geeft met POST /voorwerk/deadlines alle koppelingen uit ## Actueel mee (koppels); Kies portie (n8n AI - Voorwerk) maakt er
//     groepen van, zet van elke groep alleen de hoogste in het lijstje en bewaart de rest van de groep in de portierij (koppel_json).
//  2. Sluiten (verwerk): voor een portierij met keuze gedaan en koppel_json, pas als ↩️ niet meer kan (TIK_RUST_MS na getikt_op), sluit
//     de pod elke gekoppelde plek die nog open is: actiepunt → afgerond (zoals Plan state), deadline → ## Afgehandeld (sluitroute van
//     deadline-lijstje.js), Todoist-taak → voltooid. Bestaat een sleutel niet, of is hij al dicht: niets. Een herhaaltaak, een taak van een
//     ander of in een gedeeld project sluit de pod niet (zichtbaar voor anderen). Daarna koppel_klaar in de portierij (één keer).
const crypto = require('crypto');

const TIK_RUST_MS = 150 * 1000;              // zoals deadline-lijstje.js: > 2 min ↩️-venster van AI - Voorwerk-knoppen
const GROEP_MAX = 6;                          // meer gekoppelde plekken dan dit = koppeling niet vertrouwd (Kies portie negeert hem ook)
const ACTIE_RE = /^[a-z0-9][a-z0-9_.-]{2,120}$/i;
const TODOIST_RE = /^[A-Za-z0-9]{6,40}$/;
const DL_RE = /^dl:[0-9a-f]{40}$/;
const BRONNEN = ['actie_state', 'todoist', 'deadline'];

// "(koppel: actie x; todoist y)" in een deadlinecel, of "koppel: …"-regels in een Todoist-beschrijving. Onbekende stukken tellen niet.
function leesKoppel(s) {
  const uit = { actie: [], todoist: [], dl: [] };
  const tekst = String(s || '');
  const re = /\(?koppel:\s*([^()\n]*)\)?/gi;
  let m;
  while ((m = re.exec(tekst))) {
    for (const deel of m[1].split(/[;,]/)) {
      const d = deel.trim().replace(/[`*]/g, '');
      let x;
      if ((x = /^actie\s+(\S+)$/i.exec(d)) && ACTIE_RE.test(x[1])) { if (uit.actie.indexOf(x[1]) < 0) uit.actie.push(x[1]); }
      else if ((x = /^todoist\s+(\S+)$/i.exec(d)) && TODOIST_RE.test(x[1])) { if (uit.todoist.indexOf(x[1]) < 0) uit.todoist.push(x[1]); }
      else if (DL_RE.test(d)) { if (uit.dl.indexOf(d) < 0) uit.dl.push(d); }
    }
  }
  return uit;
}

// Alle koppelingen uit ## Actueel. items = --droog-uitvoer, cellen = deadline-lijstje.cellen. Alleen regels met een geldige dl:-sleutel.
function registerKoppels(items, tekst, cellen) {
  const regels = String(tekst || '').split('\n'), uit = [];
  let sec = null;
  const secVan = regels.map(function (r) { if (r.startsWith('## ')) sec = r.slice(3).trim(); return sec; });
  for (const i of items || []) {
    if (!i || !DL_RE.test(String(i.sleutel)) || !i.bron) continue;
    const idx = (Number(i.bron.regel) || 0) - 1, r = regels[idx] || '';
    if (secVan[idx] !== 'Actueel' || !r.startsWith('| ' + i.datum + ' |')) continue;
    const c = cellen(r);
    if (c.length !== 6) continue;
    const k = leesKoppel(c[3]);
    if (!k.actie.length && !k.todoist.length) continue;
    uit.push({ sleutel: i.sleutel, datum: i.datum, actie: k.actie.slice(0, GROEP_MAX), todoist: k.todoist.slice(0, GROEP_MAX) });
  }
  return uit;
}

// koppel_json uit de portierij: [{bron, sleutel}], alleen geldige, zonder de rij zelf, hooguit GROEP_MAX - 1
function leesKoppelJson(p) {
  let a;
  try { a = JSON.parse(String(p.koppel_json || '[]')); } catch (e) { return []; }
  if (!Array.isArray(a)) return [];
  const uit = [], gezien = new Set([p.bron + ':' + p.sleutel]);
  for (const x of a) {
    if (!x || BRONNEN.indexOf(x.bron) < 0) continue;
    const s = String(x.sleutel || '');
    if (x.bron === 'actie_state' ? !ACTIE_RE.test(s) : x.bron === 'todoist' ? !TODOIST_RE.test(s) : !DL_RE.test(s)) continue;
    if (gezien.has(x.bron + ':' + s)) continue;
    gezien.add(x.bron + ':' + s); uit.push({ bron: x.bron, sleutel: s });
  }
  return uit.length >= GROEP_MAX ? [] : uit;
}

function dagNr(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null; }

// Welke portierijen nu gekoppelde plekken moeten sluiten. rijen = voorwerk_portie, nu = ms, klaar = Set van verwerkte merken.
function teSluiten(rijen, nu, klaar, vandaag) {
  const uit = [];
  for (const p of rijen || []) {
    if (!p || p.status !== 'afgehandeld' || p.keuze !== 'gedaan' || BRONNEN.indexOf(p.bron) < 0) continue;
    if (p.koppel_klaar) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.datum)) || dagNr(p.datum) < dagNr(vandaag) - 4) continue;   // na een storing: 4 dagen inhalen
    const t = Date.parse(p.getikt_op || '');
    if (!(nu - t >= TIK_RUST_MS)) continue;   // ↩️ kan nog (of geen tijd van de tik)
    const doel = leesKoppelJson(p);
    if (!doel.length) continue;
    const merk = crypto.createHash('sha256').update([p.nonce, p.getikt_op].join('|')).digest('hex').slice(0, 24);
    if (klaar && klaar.has(merk)) continue;
    uit.push({ merk: merk, nonce: String(p.nonce || ''), bron: p.bron, sleutel: String(p.sleutel), doel: doel,
      vandaag: new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' }) });
  }
  return uit;
}

// Runner. o = { mag(): bool, rijen(): Promise<portierijen>, sluit: { actie_state(id, vandaag), todoist(id), deadline(sleutel, vandaag) }
//   (elk → Promise<{ uitkomst: 'gesloten'|'al_dicht'|'bestaat_niet'|'overgeslagen', reden? }>; gooit bij een tijdelijke fout),
//   markeer(nonce, tekst): Promise, log(s), vandaag() }
function maak(o) {
  const klaar = new Set(), pogingen = new Map();
  let bezig = null;
  async function verwerk() {
    if (bezig) return bezig;
    bezig = (async function () {
      const lijst = teSluiten(await o.rijen(), Date.now(), klaar, o.vandaag());
      const uit = { gesloten: 0, niets: 0, later: 0 };
      for (const t of lijst) {
        if (o.mag && !o.mag()) break;   // alleen de primaire pod schrijft
        const stand = [];
        let tijdelijk = false;
        for (const d of t.doel) {
          if (o.mag && !o.mag()) { tijdelijk = true; break; }
          try {
            const u = await o.sluit[d.bron](d.sleutel, t.vandaag);
            stand.push(d.bron + ':' + d.sleutel + '=' + (u && u.uitkomst || '?') + (u && u.reden ? ' (' + String(u.reden).slice(0, 60) + ')' : ''));
            if (u && u.uitkomst === 'gesloten') uit.gesloten++; else uit.niets++;
            if (u && u.uitkomst === 'tijdelijk') tijdelijk = true;
          } catch (e) { tijdelijk = true; stand.push(d.bron + ':' + d.sleutel + '=fout (' + String(e && e.message || e).slice(0, 60) + ')'); }
        }
        o.log('koppel-klus ' + t.bron + ':' + t.sleutel.slice(0, 16) + ' → ' + stand.join(', '));
        if (tijdelijk) {
          const n = (pogingen.get(t.merk) || 0) + 1; pogingen.set(t.merk, n);
          uit.later++;
          if (n < 3) continue;   // volgende ronde opnieuw; wat al dicht is, is dan al_dicht
        }
        klaar.add(t.merk);
        try { await o.markeer(t.nonce, new Date().toISOString().slice(0, 16) + ' ' + stand.join(', ').slice(0, 900)); }
        catch (e) { o.log('koppel-klus markeer ' + t.nonce.slice(0, 8) + ' mislukt: ' + String(e && e.message || e).slice(0, 120)); }
      }
      return uit;
    })();
    try { return await bezig; } finally { bezig = null; }
  }
  return { verwerk: verwerk };
}

module.exports = { leesKoppel, registerKoppels, leesKoppelJson, teSluiten, maak, TIK_RUST_MS, GROEP_MAX };
