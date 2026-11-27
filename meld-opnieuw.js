'use strict';
// wv4202 (besluitenpagina nr 474 = 3C174, David Ja 25-11-2026 22:01): knop "Opnieuw proberen" op een storingskaart in Meldingen.
// David tikt; de pod roept de n8n-retry aan (POST /executions/{id}/retry: hervat vanaf de mislukte knoop, eerdere knopen draaien niet
// opnieuw) en zet de afloop op dezelfde kaart. Ontwerp + Codex-review: mk-scripts/wv4202/ontwerp.md.
//
// Regels:
//   - alleen de 17 nachtklussen van de inhaallijst (Foutmelder "Inhaalbaar?"), en per workflow alleen knopen die lezen, een pod-beurt
//     starten/ophalen of idempotent wegschrijven. Nooit een Code-knoop (die keurt hetzelfde antwoord opnieuw af), nooit een knoop die
//     verstuurt (AI - Bericht aan David, Intake-aflevering, Voor jou-kaart). Wat ná de hervatte knoop komt, is wat de run hoe dan ook
//     had gedaan; op de lijst staat niets dat naar derden verstuurt (gemeten 27-11, alle vervolgknopen nagelopen; Codex MOET 1);
//   - binnen het aantal uren van de inhaallijst (vóór de volgende gewone run), mode trigger, status error, geen retryOf/retrySuccessId,
//     geen andere run van die workflow na de foute, geen rij in de inhaalwachtrij (die regelt de inhaalslag; rijen ontstaan alleen
//     op het moment van de fout), en niet al door de storingsdienst opnieuw geprobeerd. Eén claim per executie, gedeeld met de
//     storingsdienst (zelfde proces, synchroon vlak vóór de aanroep; Codex MOET 2), vastgelegd vóór de n8n-aanroep;
//   - per executie één keer, ook na een herstart en vanaf een tweede apparaat; hooguit PER_DAG per dag; noodrem MELD_OPNIEUW=0;
//   - afloop deterministisch uit n8n: retrySuccessId van de foute run, of de run met retryOf = de foute run. Na 6 u zonder uitslag:
//     niet vast te stellen.

const PER_DAG = 6, MIN_LEEFTIJD_MS = 2 * 60000, UITSLAG_MAX_MS = 6 * 3600000, BEWAAR_MS = 14 * 86400000, NIET_GESTART_MS = 10 * 60000;

// Pod-beurtstroom: starten, ophalen, sessie wissen, hartslag, ochtend_buffer-regel.
const BEURT = ['Start run', 'Resultaat checken', 'Resultaat ophalen', 'Sessie wissen', 'Hartslag stempel', 'Buffer ochtendbericht', 'Naar ochtendbuffer'];
const LIJST = {
  s671dCP1OdjwzBGU: { naam: 'AI - Correspondentie-Wachter', uur: 8, knopen: BEURT.concat(['Verwacht tellen', 'Gemeten tellen', 'Tellingen loggen']) },
  '2sGqWO46keLSzNQw': { naam: 'AI - Agenda-Wachter', uur: 8, knopen: BEURT },
  ExKOlDQ012gyJRuB: { naam: 'AI - Personeels-Wachter', uur: 8, knopen: BEURT },
  mYPR5ObQheQOcnyd: { naam: 'AI - Actie-Bewaker', uur: 8, knopen: BEURT },
  DVUqVkEIt8rKPR7L: { naam: 'AI - WhatsApp Nachtextractie', uur: 8,
    knopen: ['Lees waterlijn', 'Haal berichten op (WAHA)', 'Download bijlage', 'Transcribeer spraak', 'Volglijst lezen (Intake)'] },
  '5yl8k8SWT4sK4spi': { naam: 'AI - Signal Nachtextractie', uur: 8,
    knopen: ['Onverwerkte berichten (RPC)', 'Niet-gevolgde gesprekken (RPC)', 'Start pod-run', 'Resultaat checken', 'Naar ochtendbuffer', 'Sessie wissen'] },
  '8o2bg3RXj6EJ02yF': { naam: 'AI - Contacten Sync', uur: 8,
    knopen: ['RPC: sync-token ophalen', 'Groepen ophalen', 'Contacten ophalen', 'Contacten ophalen (volledig)', 'RPC: contacten wegschrijven', 'RPC: afronden'] },
  '9att2bGQ1e6TlxoB': { naam: 'AI - MCP-gezondheidscheck', uur: 8, knopen: ['Start check', 'Resultaat ophalen', 'Melding naar ochtend-buffer', 'Hartslag stempel'] },
  vGPtvfzNhqVDVjgX: { naam: 'AI - n8n Git-backup', uur: 8, knopen: ['Sessie wissen', 'Start run', 'Resultaat ophalen'] },
  vNsdkyTQIaGhU0Fj: { naam: 'Nachtelijke raw_input-verwerking', uur: 8, knopen: ['Start job', 'Resultaat checken', 'Buffer ochtendbericht'] },
  DDk9idnKqy6fnRYv: { naam: 'AI - Machinekamer droomronde', uur: 8, knopen: ['Start run', 'Resultaat ophalen', 'Hartslag stempel', 'Lees wachterstand'] },
  agntIie8d9mqOlm6: { naam: 'AI - WhatsApp Conversatie-consolidatie', uur: 8, knopen: ['Start consolidatie', 'Resultaat checken', 'Buffer ochtendbericht'] },
  gNfADWC3tXqGpgBo: { naam: 'AI - Tokenboekhouding', uur: 8, knopen: ['Sessie wissen', 'Start tokenmeting', 'Resultaat ophalen', 'Meld in ochtendbuffer'] },
  '1w4T7mdQ1NqYSxJP': { naam: 'AI - Keten-attest', uur: 8,
    knopen: ['Start run', 'Resultaat checken', 'Executies ophalen', 'WhatsApp-waterlijn', 'Offsite-backups tellen', 'Sessie wissen', 'Olares-login hartslag',
      'Syncthing-stand', 'Syncthing-stand (herhaling)', 'Workflowgegevens', 'Attest naar ochtend_buffer'] },
  vzW6OWQfr8kbZdFR: { naam: 'AI - Voorwerk (herinneringsconcepten)', uur: 8,
    knopen: ['Lees state', 'Sessie wissen', 'Start run', 'Resultaat ophalen', 'Bestaande regel', 'Naar ochtendbuffer', 'Hartslag stempel', 'Lees kaarten'] },
  BvUvLnM1wm1ckUN6: { naam: 'AI - Voorwerk (ochtendblok)', uur: 3, knopen: ['Sessie wissen', 'Start run', 'Resultaat ophalen', 'Naar ochtendbuffer', 'Hartslag stempel'] },
  GYzoDYNbU70K6Xxl: { naam: 'Dagplanner - proactieve dagstart', uur: 3, knopen: ['Dagplanner job', 'Check', 'Buffer ochtendbericht'] },
};

function heeft(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, String(k)); }
function dag(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function klok(ms) { try { return new Date(ms).toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' }); } catch (e) { return '?'; } }
function kort(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// io: { nu, uit, leesStaat, schrijfStaat, run(ex), runs(wf), inhaalRij(ex), sdGeclaimd(ex), retry(ex), log }
function maak(io, opts) {
  const lijst = (opts && opts.lijst) || LIJST;
  let staat = null;
  const bezig = new Set();   // executies waarvan de toets loopt (twee tikken tegelijk: de tweede krijgt meteen 409)
  function laad() {
    if (staat) return staat;
    staat = io.leesStaat() || {};
    staat.per = staat.per && typeof staat.per === 'object' ? staat.per : {};
    staat.dag = staat.dag && typeof staat.dag === 'object' ? staat.dag : {};
    return staat;
  }
  function bewaar() { io.schrijfStaat(staat); }
  function nu() { return io.nu(); }

  // Gedeelde claim (met de storingsdienst): heeft de knop deze executie al? Onleesbare staat = ja (liever geen knop dan dubbel).
  function geclaimd(ex) { try { return heeft(laad().per, ex); } catch (e) { return true; } }

  function opLijst(wf, knoop) { const l = heeft(lijst, wf) ? lijst[wf] : null; return !!(l && l.knopen.indexOf(String(knoop || '')) >= 0); }

  // Knop tonen? k = { soort, wf, knoop, executie, t (ms van de jongste melding), ingehaald, herstel } — goedkoop, zonder n8n.
  function kan(k) {
    if (!k || k.soort !== 'storing' || !k.wf || !k.executie || (io.uit && io.uit())) return false;
    if (!opLijst(k.wf, k.knoop)) return false;
    const n = nu(), l = lijst[k.wf];
    if (!(n - k.t >= MIN_LEEFTIJD_MS && n - k.t < l.uur * 3600000)) return false;
    if (geclaimd(k.executie) || (io.sdGeclaimd && io.sdGeclaimd(String(k.executie)))) return false;
    if (k.ingehaald === 'ja' || k.ingehaald === 'hoeft-niet' || k.herstel === 'weer-goed') return false;
    const s = laad();
    if (s.dag.datum === dag(n) && (s.dag.n || 0) >= PER_DAG) return false;
    return true;
  }

  // Stand op de kaart: de knop-poging voor de jongste executie van de kaart, of voor een oudere waarvan de jongste de herhaling is
  // (een mislukte herhaling meldt de Foutmelder als nieuwe executie op dezelfde kaart). Een latere, eigen mislukking = nieuwe kans.
  function stand(executies, laatste) {
    let s;
    try { s = laad(); } catch (e) { return null; }
    const l = laatste != null ? String(laatste) : null;
    let ex = l && heeft(s.per, l) ? l : null;
    if (!ex) ex = (executies || []).map(String).find(function (e) { return heeft(s.per, e) && (!l || String(s.per[e].retry_id || '') === l); }) || null;
    if (ex) {
      const p = s.per[ex];
      const k = klok(p.op), t = 'Opnieuw gedraaid ' + k + ' (op jouw tik)';
      const tekst = p.stand === 'gelukt' ? t + ': gelukt.' : p.stand === 'mislukt' ? t + ': mislukt' + (p.reden ? ' — ' + p.reden : '') + '.'
        : p.stand === 'onbekend' ? t + ': uitslag niet vast te stellen.' : 'Opnieuw gestart ' + k + ' (op jouw tik); loopt nog.';
      return { executie: ex, stand: p.stand, op: new Date(p.op).toISOString(), klaar_op: p.klaar_op ? new Date(p.klaar_op).toISOString() : null, tekst: tekst };
    }
    return null;
  }

  function weiger(code, reden) { return { ok: false, code: code, reden: reden }; }

  // Tik van David. k = { wf, knoop, executie, soort }. → { ok, code, reden | executie, op }
  async function start(k) {
    if (io.uit && io.uit()) return weiger(503, 'opnieuw proberen staat even uit');
    if (!k || k.soort !== 'storing' || !k.wf || !k.executie) return weiger(409, 'deze melding kan niet opnieuw');
    const ex = String(k.executie);
    if (!opLijst(k.wf, k.knoop)) return weiger(409, 'deze automatisering of stap staat niet op de lijst die veilig opnieuw mag');
    laad();
    if (heeft(staat.per, ex)) return weiger(409, 'al opnieuw gestart om ' + klok(staat.per[ex].op));
    if (bezig.has(ex)) return weiger(409, 'wordt al opnieuw gestart');
    const n0 = nu();
    if (staat.dag.datum === dag(n0) && (staat.dag.n || 0) >= PER_DAG) return weiger(429, 'vandaag al ' + PER_DAG + ' keer opnieuw geprobeerd');
    bezig.add(ex);
    try {
      let run, runs, inh;
      try { [run, runs, inh] = await Promise.all([io.run(ex), io.runs(k.wf), io.inhaalRij(ex)]); }
      catch (e) { return weiger(503, 'n8n is nu niet te lezen; probeer het straks nog eens'); }
      if (!run || String(run.id) !== ex) return weiger(409, 'die run is in n8n niet (meer) te vinden');
      if (run.workflowId && String(run.workflowId) !== String(k.wf)) return weiger(409, 'die run hoort bij een andere automatisering');
      if (run.mode !== 'trigger') return weiger(409, 'alleen een geplande run kan zo opnieuw');
      if (run.retryOf) return weiger(409, 'dit was zelf al een herhaling');
      if (run.retrySuccessId) return weiger(409, 'is al opnieuw gedraaid en dat lukte');
      if (run.status !== 'error') return weiger(409, 'die run staat niet (meer) op mislukt');
      const t0 = Date.parse(run.startedAt), tEind = Date.parse(run.stoppedAt || run.startedAt);
      if (!isFinite(t0)) return weiger(409, 'starttijd van die run onbekend');
      const n = nu();
      if (!(n - tEind < lijst[k.wf].uur * 3600000)) return weiger(409, 'te lang geleden; de volgende gewone run neemt het mee');
      if (!Array.isArray(runs)) return weiger(503, 'de runs van deze automatisering zijn nu niet te lezen');
      if (runs.some(function (r) { return r && String(r.id) !== ex && (!isFinite(Date.parse(r.startedAt)) || Date.parse(r.startedAt) > t0); }))
        return weiger(409, 'er liep daarna al een andere run van deze automatisering');
      if (inh) return weiger(409, 'de inhaalslag heeft hem al');
      // Synchroon tot en met de claim: geen await meer tussen de laatste toets en het vastleggen (gedeeld met de storingsdienst).
      if (io.sdGeclaimd && io.sdGeclaimd(ex)) return weiger(409, 'de storingsdienst probeert hem al opnieuw');
      if (heeft(staat.per, ex)) return weiger(409, 'al opnieuw gestart om ' + klok(staat.per[ex].op));
      if (staat.dag.datum !== dag(n)) staat.dag = { datum: dag(n), n: 0 };
      staat.dag.n = (staat.dag.n || 0) + 1;
      staat.per[ex] = { op: n, wf: String(k.wf), knoop: String(k.knoop || ''), stand: 'bezig', retry_id: null, reden: null, klaar_op: null };
      bewaar();   // vóór de aanroep: een herstart halverwege geeft nooit een tweede poging
      io.log('meld-opnieuw start ' + ex + ' (' + k.wf + ')');
      aanroep(ex);
      return { ok: true, executie: ex, op: new Date(n).toISOString() };
    } finally { bezig.delete(ex); }
  }

  // n8n antwoordt pas als de hervatte run klaar is (pod-beurten: soms lang). Niet wachten in de tik; uitslag bij aankomst of via tik().
  function aanroep(ex) {
    Promise.resolve().then(function () { return io.retry(ex); }).then(function (r) {
      const p = staat.per[ex];
      if (!p) return;
      if (r && r.id != null) p.retry_id = String(r.id);
      if (r && r.status === 'success') { p.stand = 'gelukt'; p.klaar_op = nu(); }
      else if (r && (r.status === 'error' || r.status === 'crashed')) { p.stand = 'mislukt'; p.klaar_op = nu(); p.reden = 'ook de herhaling liep vast'; }
      bewaar();
      io.log('meld-opnieuw ' + ex + ' -> ' + (p.retry_id || '?') + ' ' + p.stand);
    }, function (e) {
      // Ook bij een fout of time-out kan n8n de herhaling al gestart hebben (proxy-time-out): tik() kijkt in n8n en beslist.
      const p = staat.per[ex];
      if (!p) return;
      p.aanroep_fout = kort(e && e.message || e, 80);
      bewaar();
      io.log('meld-opnieuw ' + ex + ' aanroep: ' + p.aanroep_fout);
    });
  }

  // Afloop van lopende pogingen bepalen (elke minuut zolang er iets loopt). → aantal nog bezig
  async function tik() {
    try { laad(); } catch (e) { return 0; }
    const n = nu();
    let open = 0, gewijzigd = false;
    Object.keys(staat.per).forEach(function (ex) { if (!(n - (staat.per[ex].op || 0) < BEWAAR_MS)) { delete staat.per[ex]; gewijzigd = true; } });
    for (const ex of Object.keys(staat.per)) {
      const p = staat.per[ex];
      if (p.stand !== 'bezig') continue;
      let uit = null;
      try {
        if (p.retry_id) {
          const r = await io.run(p.retry_id);
          if (r && r.status === 'success') uit = 'gelukt';
          else if (r && (r.status === 'error' || r.status === 'crashed')) uit = 'mislukt';
        } else {
          const o = await io.run(ex);
          if (o && o.retrySuccessId) { p.retry_id = String(o.retrySuccessId); uit = 'gelukt'; }
          else {
            const h = (await io.runs(p.wf) || []).filter(function (r) { return r && String(r.retryOf || '') === ex; })
              .sort(function (a, b) { return Date.parse(b.startedAt) - Date.parse(a.startedAt); })[0];
            if (h) {
              p.retry_id = String(h.id); gewijzigd = true;
              if (h.status === 'success') uit = 'gelukt';
              else if (h.status === 'error' || h.status === 'crashed') uit = 'mislukt';
            } else if (p.aanroep_fout && n - p.op >= NIET_GESTART_MS) { uit = 'mislukt'; p.reden = 'n8n startte de herhaling niet'; }
          }
        }
      } catch (e) { /* n8n even weg: volgende tik */ }
      if (!uit && n - p.op >= UITSLAG_MAX_MS) uit = 'onbekend';
      if (uit) {
        p.stand = uit; p.klaar_op = n; gewijzigd = true;
        if (uit === 'mislukt' && !p.reden) p.reden = 'ook de herhaling liep vast';
        io.log('meld-opnieuw ' + ex + ' -> ' + (p.retry_id || '?') + ' ' + uit);
      } else open++;
    }
    if (gewijzigd) bewaar();
    return open;
  }
  function open() { try { laad(); } catch (e) { return 0; } return Object.keys(staat.per).filter(function (ex) { return staat.per[ex].stand === 'bezig'; }).length; }

  function health() {
    let s = null;
    try { s = laad(); } catch (e) { return { fout: true }; }
    const v = Object.keys(s.per).map(function (k) { return s.per[k]; });
    return { aan: !(io.uit && io.uit()), lijst: Object.keys(lijst).length, vandaag: s.dag.datum === dag(nu()) ? s.dag.n || 0 : 0, per_dag: PER_DAG,
      bezig: v.filter(function (p) { return p.stand === 'bezig'; }).length, gelukt: v.filter(function (p) { return p.stand === 'gelukt'; }).length,
      mislukt: v.filter(function (p) { return p.stand === 'mislukt'; }).length };
  }
  return { kan: kan, stand: stand, start: start, tik: tik, open: open, geclaimd: geclaimd, health: health };
}

module.exports = { maak, LIJST, PER_DAG, MIN_LEEFTIJD_MS, UITSLAG_MAX_MS };
