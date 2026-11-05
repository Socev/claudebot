// Facturen-verzender — Tel verstuurd (wv921; wv2480): de mail is verstuurd; tijdstempel voor het plafond per 24 uur (alleen pot, boekstuk en
// sepa: direct uit Facturen heeft een eigen dagteller in Toetsen) en het antwoord voor de pod (geen inhoud).
const t = $('Toetsen').first().json;
const sd = $getWorkflowStaticData('global');
sd.pot = (Array.isArray(sd.pot) ? sd.pot : []).filter((x) => Date.now() - x < 86400000);
if (t.bron !== 'facturen' && t.bron !== 'facturen_proef') sd.pot.push(Date.now());
const g = $input.first().json || {};
return [{ json: { ok: true, modus: 'versturen', message_id: g.id || null, thread_id: g.threadId || null, labels: Array.isArray(g.labelIds) ? g.labelIds : [],
  concept_id: $('Gmail concept (pot)').first().json.id || null, bijlagen: t.toets.aantal, ref: t.ref, token: t.token || null } }];
