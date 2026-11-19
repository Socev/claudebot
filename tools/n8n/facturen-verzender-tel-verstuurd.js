// Facturen-verzender — Tel verstuurd (wv921; wv2480; wv3369; wv3370): de mail is verstuurd; tijdstempel voor het plafond per 24 uur (alleen pot,
// boekstuk en sepa: direct uit Facturen en nogbetalen hebben een eigen dagteller in Toetsen) en het antwoord voor de pod (geen inhoud).
const t = $('Toetsen').first().json;
const sd = $getWorkflowStaticData('global');
sd.pot = (Array.isArray(sd.pot) ? sd.pot : []).filter((x) => Date.now() - x < 86400000);
if (!['facturen', 'facturen_proef', 'nogbetalen', 'nogbetalen_proef'].includes(t.bron)) sd.pot.push(Date.now());
const g = $input.first().json || {};
// wv3370: een betaalverzoek zonder bijlage (nogbetalen, patiëntkenmerk) loopt via 'Gmail concept (pot, zonder bijlage)'; precies één van de twee draaide
const c = $('Gmail concept (pot)').isExecuted ? $('Gmail concept (pot)') : $('Gmail concept (pot, zonder bijlage)');
return [{ json: { ok: true, modus: 'versturen', message_id: g.id || null, thread_id: g.threadId || null, labels: Array.isArray(g.labelIds) ? g.labelIds : [],
  concept_id: c.first().json.id || null, bijlagen: t.toets.aantal, ref: t.ref, token: t.token || null } }];
