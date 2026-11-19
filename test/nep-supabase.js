// Nep-Supabase voor een toets met een proefkopie van server.js (wv3398, actieplan B82). Sinds wv3398 erft een proefkopie de
// SUPABASE_URL en service role van de pod niet meer (die wezen naar de ECHTE databank, ook via adres.env); de rolwachter van
// de kopie leest dan niets en de kopie blijft passief (/run en /agent 409). Deze nep antwoordt op rpc/uitwijk_stand_lees met
// actieve kant olares (of opties.kant) en op al het andere met []. Synchroon te gebruiken:
//   const NEP_SB = require(require('path').resolve('test/nep-supabase.js'))();
//   env: { SUPABASE_URL: NEP_SB.url, SUPABASE_SERVICE_ROLE: NEP_SB.sleutel, ... }
const http = require('http');
const vrijePoort = require('./vrije-poort.js');
module.exports = function nepSupabase(opties) {
  const o = opties || {};
  const poort = vrijePoort();
  const verzoeken = [];
  const server = http.createServer(function (q, r) {
    verzoeken.push(q.method + ' ' + q.url);
    r.setHeader('content-type', 'application/json');
    if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return r.end(JSON.stringify([{ actieve_kant: o.kant || 'olares', sinds: null }]));
    r.end('[]');
  });
  server.listen(poort, '127.0.0.1');
  server.unref();
  return { url: 'http://127.0.0.1:' + poort, sleutel: 'proef-nep-sb', verzoeken: verzoeken, server: server };
};
