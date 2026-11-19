'use strict';
/*
 * vaultzoek.js (wv3295, 19-11-2026) — zoeken op betekenis in de vault via de EIGEN databank (schema vaultzoek, pgvector + Postgres-
 * tekstzoeken), ter vervanging van Cloudflare AI Search /search (instantie vault).
 *
 * WAAROM. AI Search gaat 1-12-2026 factureren (schatting $225,83/mnd, vrijwel alles herinlezen, 0 zoekvragen in 2 weken); David JA
 * 18-11 09:55 (548baeb0). De index wordt 's nachts gevuld door vaultzoek-index.py; hier alleen het zoeken (alleen lezen).
 * Ontwerp: vault 01_Ontwikkeling/Zoeken op betekenis in eigen databank (ontwerp 19-11-2026).md.
 *
 * Twee aanroepers, zelfde antwoordvorm als vroeger zodat ze alleen van bron wisselen:
 *   - smalActie 'vault-zoek' (skill vault-rag): { result: { chunks: [{ id, type, score, text, item: { key, metadata } }], hybrid_meta } }
 *   - secondbrain betekenis (Brain › zoeken op betekenis): [{ key, text, score }]
 * key = 'vault/' + vault-relatief pad (zoals de R2-sleutels van AI Search; secondbrain.js knipt 'vault/' er weer af).
 *
 * Vraag inbedden: o.vector(tekst) → 1024 getallen of null (dan alleen tekstzoeken; methoden ['keyword']). De SQL is altijd met
 * parameters, in een alleen-lezen transactie met een eigen statement_timeout. Geen vault-inhoud in de log.
 */

const MAX_N = 50;

function maak(o) {
  o = o || {};
  const pool = o.pool || new (o.pg || require('pg')).Pool({
    host: o.socket || process.env.VAULTZOEK_SOCKET || '/run/pg', database: o.db || 'postgres', user: o.rol || 'postgres',
    max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, application_name: 'vaultzoek'
  });
  if (pool.on) pool.on('error', function (e) { if (o.fout) o.fout('vaultzoek-pool', e); });
  const tekstgewicht = typeof o.tekstgewicht === 'number' ? o.tekstgewicht : 0.25;

  function vecTekst(v) {
    if (!Array.isArray(v) || v.length !== 1024) return null;
    for (const x of v) if (typeof x !== 'number' || !isFinite(x)) return null;
    return '[' + v.join(',') + ']';
  }

  // → { rijen: [{ pad, nr, kop, tekst, score, rrf, via }], methoden: [...] }
  async function rauw(vraag, n) {
    const q = String(vraag || '').trim().slice(0, 2000);
    if (!q) throw new Error('vraag ontbreekt');
    n = Math.min(Math.max(parseInt(n, 10) || 8, 1), MAX_N);
    let vec = null;
    try { vec = vecTekst(await o.vector(q)); } catch (e) { vec = null; }
    const c = await pool.connect();
    try {
      await c.query('begin read only');
      await c.query("set local statement_timeout = '8s'");
      const r = await c.query('select pad, nr, kop, tekst, score, rrf, via from vaultzoek.zoek($1, $2, $3, $4)', [vec, q, n, tekstgewicht]);
      await c.query('commit');
      return { rijen: r.rows, methoden: vec ? ['vector', 'keyword'] : ['keyword'] };
    } catch (e) {
      try { await c.query('rollback'); } catch (e2) {}
      throw e;
    } finally { c.release(); }
  }

  // drempel geldt voor het vectordeel (zoals score_threshold bij AI Search); een brok dat alleen via tekst binnenkwam blijft staan
  function filter(rijen, drempel) {
    return rijen.filter(function (r) { return r.via === 'tekst' || Number(r.score) >= drempel; });
  }

  async function zoekAiVorm(vraag, n, drempel) {
    drempel = Math.min(Math.max(Number(drempel) || 0.1, 0), 1);
    const r = await rauw(vraag, n);
    const chunks = filter(r.rijen, drempel).map(function (x) {
      return { id: x.pad + '#' + x.nr, type: 'text', score: Number(x.score) || 0, text: x.tekst,
        item: { key: 'vault/' + x.pad, metadata: { kop: x.kop, via: x.via } } };
    });
    return { success: true, result: { search_query: String(vraag).slice(0, 2000), chunks: chunks,
      hybrid_meta: { search_methods: r.methoden }, bron: 'eigen databank (vaultzoek)' } };
  }

  async function zoekBrain(vraag) {
    const r = await rauw(vraag, 30);
    return filter(r.rijen, 0.1).map(function (x) {
      return { key: 'vault/' + x.pad, text: String(x.tekst || '').slice(0, 1000), score: Number(x.score) || 0 };
    });
  }

  // /health: alleen tellingen (geen inhoud); stand.json komt van de nachtronde
  async function info() {
    const c = await pool.connect();
    try {
      await c.query('begin read only');
      await c.query("set local statement_timeout = '3s'");
      const r = await c.query('select (select count(*) from vaultzoek.bestand)::int as bestanden, (select count(*) from vaultzoek.brok)::int as brokken,' +
        ' (select count(*) from vaultzoek.vector)::int as vectoren');
      await c.query('commit');
      return r.rows[0];
    } catch (e) {
      try { await c.query('rollback'); } catch (e2) {}
      throw e;
    } finally { c.release(); }
  }

  return { rauw: rauw, zoekAiVorm: zoekAiVorm, zoekBrain: zoekBrain, info: info, vecTekst: vecTekst, sluit: function () { return pool.end(); } };
}

module.exports = { maak: maak };
