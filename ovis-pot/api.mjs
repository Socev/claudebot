// GEGENEREERD uit Socev/ovis-pot ccd151dde9025353c5db04518a8cb8407e3e76d7 (scripts/pod-bundel.mjs); niet met de hand wijzigen.
// OVIS POT — de API (lezen en de instellingen schrijven). Los van Cloudflare, zodat de toets hem met een lokale SQLite kan draaien.
// Rekenen doet de rekenkern (kern/pot-kern.mjs) in de browser; de API levert alleen gegevens en bewaart wijzigingen.
// Elke schrijfactie is één batch (atomair) met een regel in `logboek` (wie, wat, oud → nieuw).
// Tabellen die uit `fin` komen (praktijk, praktijk_patienten, deelname) zijn pas schrijfbaar na het overstapmoment
// (instelling.overstap_fin gevuld): daarvóór is `pot` een kopie die scripts/kopieer-uit-fin.py ververst en zou een wijziging stil verdwijnen.

import * as K from "./kern/pot-kern.mjs";

                           
                                                                                                                              
                                           
 
                                                                                                                                      

export class Fout extends Error {
  status        ;
  constructor(status        , msg        ) { super(msg); this.status = status; }
}

const DATUM = /^\d{4}-\d{2}-\d{2}$/;
const ENT = ["POT", "KM", "SLOEL"];
const PRAKTIJK = /^P\d{2}$/;

function tekst(v         , naam        , { verplicht = false, max = 200 } = {})                {
  if (v == null || v === "") { if (verplicht) throw new Fout(400, `${naam} ontbreekt`); return null; }
  if (typeof v !== "string") throw new Fout(400, `${naam} moet tekst zijn`);
  const t = v.trim();
  if (t.length > max) throw new Fout(400, `${naam} is te lang (max ${max})`);
  if (verplicht && !t) throw new Fout(400, `${naam} ontbreekt`);
  return t || null;
}
function datum(v         , naam        , verplicht = true)                {
  if (v == null || v === "") { if (verplicht) throw new Fout(400, `${naam} ontbreekt`); return null; }
  if (typeof v !== "string" || !DATUM.test(v) || Number.isNaN(Date.parse(v + "T00:00:00Z"))) throw new Fout(400, `${naam} moet JJJJ-MM-DD zijn`);
  return v;
}
function getal(v         , naam        , { min = -1e9, max = 1e9, leeg = false } = {})                {
  if ((v == null || v === "") && leeg) return null;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw new Fout(400, `${naam} is geen geldig bedrag/aantal`);
  return Math.round(n * 100) / 100;
}
function keuze                  (v         , naam        , lijst              )    {
  if (typeof v !== "string" || !lijst.includes(v     )) throw new Fout(400, `${naam} moet een van ${lijst.join(", ")} zijn`);
  return v     ;
}
function jaar(v         )         {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 2014 || n > 2100) throw new Fout(400, "jaar ongeldig");
  return n;
}

async function rijen                             (db          , sql        , ...w           )               {
  return (await db.prepare(sql).bind(...w).all   ()).results;
}
async function legacyOpen(db          )                   {
  const r = await rijen                    (db, "select waarde from instelling where sleutel='overstap_fin'");
  return !!(r[0] && r[0].waarde);
}
async function bestaatPraktijk(db          , id        ) {
  if (!PRAKTIJK.test(id) || !(await rijen(db, "select 1 x from praktijk where id=?", id)).length) throw new Fout(400, "onbekende praktijk");
}
function log(db          , wie        , tabel        , sleutel        , actie        , oud         , nieuw         ) {
  return db.prepare("insert into logboek (wie, tabel, sleutel, actie, oud, nieuw) values (?,?,?,?,?,?)")
    .bind(wie, tabel, sleutel, actie, oud == null ? null : JSON.stringify(oud), nieuw == null ? null : JSON.stringify(nieuw));
}

// ---------- lezen ----------
export async function basis(db          ) {
  const [praktijken, versies, namen, deelnames, uitzonderingen, standen, componenten, mutaties, subsidie, tarieven, jaarlast, instelling, entiteit, rekeningen] =
    await Promise.all([
      rijen(db, "select id, naam, naam_vorig, eigenaar, naam_brief, tav, adres, postcode_plaats, email, opmerking from praktijk order by id"),
      rijen(db, "select * from praktijk_versie order by praktijk_id, geldig_van"),
      rijen(db, "select praktijk_id, naam, iban, geldig_van, geldig_tot from praktijk_naam order by praktijk_id, geldig_van"),
      rijen(db, "select id, entiteit, praktijk_id, geldig_van, geldig_tot, regel, geldt_voor from deelname order by entiteit, praktijk_id, geldig_van"),
      rijen(db, "select * from deelname_uitzondering order by kostencomponent_id, praktijk_id"),
      rijen(db, "select id, praktijk_id, peildatum, aantal, status, opgegeven_door, bron_tekst from praktijk_patienten order by peildatum, praktijk_id"),
      rijen(db, "select * from kostencomponent order by entiteit, volgorde, id"),
      rijen(db, "select * from kostenmutatie order by kostencomponent_id, geldig_van"),
      rijen(db, "select * from subsidie order by jaar, praktijk_id"),
      rijen(db, "select * from inschrijftarief order by jaar"),
      rijen(db, "select entiteit, jaar, bedrag, bron, opmerking from jaarlast order by jaar, entiteit"),
      rijen(db, "select sleutel, waarde, opmerking from instelling"),
      rijen(db, "select code, naam, iban, naam_document, adres, postcode_plaats, kvk from entiteit where code in ('POT','KM','SLOEL')"),
      rijen(db, "select r.iban, r.entiteit, r.bank, (select max(boekdatum) from bankmutatie m where m.rekening=r.iban) as laatste_post from bankrekening r"),
    ]);
  const nu = (await rijen               (db, "select date('now') as d"))[0].d;
  return { vandaag: nu, praktijken, versies, namen, deelnames, uitzonderingen, standen, componenten, mutaties, subsidie, tarieven, jaarlast, instelling, entiteit, rekeningen };
}

/** Wat er per praktijk per entiteit in jaar J is betaald (bank) en gevraagd (vastgestelde nota's). */
export async function geld(db          , j         ) {
  const J = jaar(j);
  const betaald = await rijen(db,
    "select m.entiteit, t.praktijk_id, t.soort, round(sum(t.bedrag),2) as bedrag, count(*) as n from bank_toewijzing t join bankmutatie m on m.id=t.bankmutatie_id " +
    "where t.boekjaar=? and t.praktijk_id is not null and t.soort in ('voorschot','huur','afrekening') group by 1,2,3", J);
  // gevraagd = vastgestelde nota's van J zonder bufferopbouw (R3); van een nota uit deze app telt alleen de regel 'bijdrage'
  // (correcties en verrekeningen gaan over een ander jaar), een afrekeningsnota telt niet mee
  const gevraagd = await rijen(db,
    "select entiteit, praktijk_id, round(sum(case when bron='ovis-pot' then (select coalesce(sum(json_extract(r.value,'$.bedrag')),0) from json_each(nota.regels) r " +
    "where json_extract(r.value,'$.soort')='bijdrage') else bedrag - coalesce(buffer,0) end),2) as bedrag, count(*) as n " +
    "from nota where jaar=? and status='definitief' and soort not in ('buffer','afrekening') group by 1,2", J);
  return { jaar: J, betaald, gevraagd };
}

/** Betaalmonitor: verwachte termijnen (Davids stukken, nota's of reconstructie) en de betalingen uit de bank. */
export async function monitor(db          , j         ) {
  const J = jaar(j);
  const verwachting = await rijen(db, "select entiteit, praktijk_id, termijn, vervaldag, bedrag, bron, nummer from verwachting where jaar=? order by entiteit, praktijk_id, vervaldag", J);
  const betalingen = await rijen(db,
    "select t.id, m.entiteit, t.praktijk_id, m.boekdatum as datum, t.bedrag, t.soort from bank_toewijzing t join bankmutatie m on m.id=t.bankmutatie_id " +
    "where t.boekjaar=? and t.praktijk_id is not null and ((m.entiteit in ('POT','KM') and t.soort='voorschot') or (m.entiteit='SLOEL' and t.soort='huur')) order by m.boekdatum", J);
  const bank = await rijen(db, "select entiteit, max(boekdatum) as laatste from bankmutatie group by entiteit");
  // fase 3 (wv2762): vanaf het jaar van de overname zijn de nota's van de app de verwachting (termijn = nummer = betalingskenmerk); een
  // betaling krijgt de nummers die in haar omschrijving staan (alleen nummers van nota's van die entiteit; de omschrijving zelf gaat niet
  // naar de browser) en de koppelingen die David met de hand legde.
  const vanaf = Number((await overnameVanaf(db)).slice(0, 4));
  if (J < vanaf) return { jaar: J, verwachting, betalingen, bank, notas: [], koppelingen: [], verzoeken: [], mail: [] };
  const notas = await rijen                         (db, "select id, entiteit, praktijk_id, nummer, datum, vervaldag, soort, periode, bedrag, status from nota where bron='ovis-pot' and (jaar=? or substr(datum,1,4)=?) order by entiteit, nummer", J, String(J));
  const ruw = await rijen                         (db,
    "select t.id, m.id as bankmutatie_id, m.entiteit, t.praktijk_id, m.boekdatum as datum, t.bedrag, t.soort, m.omschrijving from bank_toewijzing t join bankmutatie m on m.id=t.bankmutatie_id " +
    "where m.boekdatum<? and t.praktijk_id is not null and ((m.entiteit in ('POT','KM') and t.soort in ('voorschot','afrekening')) or (m.entiteit='SLOEL' and t.soort in ('huur','afrekening'))) and m.boekdatum>=? order by m.boekdatum",
    `${J + 1}-03-01`, `${J - 1}-12-01`);
  const koppelingen = await rijen                         (db, "select k.id, k.bankmutatie_id, k.nota_id, k.bedrag, k.herkomst, n.nummer, n.entiteit from koppeling k join nota n on n.id=k.nota_id where n.jaar=? or substr(n.datum,1,4)=?", J, String(J));
  const nummersVan = new Map                     ();
  for (const n of notas) { const e = String(n.entiteit); if (!nummersVan.has(e)) nummersVan.set(e, new Set()); nummersVan.get(e) .add(String(n.nummer)); }
  const betalingenNota = ruw.map((b) => ({ id: b.id, bankmutatie_id: b.bankmutatie_id, entiteit: b.entiteit, praktijk_id: b.praktijk_id, datum: b.datum, bedrag: b.bedrag, soort: b.soort,
    kenmerken: K.kenmerkenUit(String(b.omschrijving || ""), nummersVan.get(String(b.entiteit)) || new Set()),
    koppel: koppelingen.filter((k) => k.bankmutatie_id === b.bankmutatie_id).map((k) => ({ nummer: String(k.nummer), bedrag: Number(k.bedrag) })) }));
  const verzoeken = await rijen(db, "select id, nota_id, status, uitkomst, gevraagd_op from pod_verzoek order by id desc limit 300");
  const mail = await rijen(db, "select id, sleutel, soort, entiteit, praktijk_id, datum, nota_ids, status, reden, concept_op, verzonden_op from mail_concept where substr(datum,1,4)=? order by id", String(J));
  return { jaar: J, verwachting, betalingen: betalingenNota, bank, notas, koppelingen, verzoeken, mail };
}

/** Stand van de maandronde: de mailconcepten die de pod klaarzette en de open verzoeken (scherm Overzicht en Nota's). */
export async function maandStand(db          ) {
  const [mail, verzoeken, bron] = await Promise.all([
    rijen(db, "select id, sleutel, soort, entiteit, praktijk_id, datum, nota_ids, nummers, status, reden, concept_op, verzonden_op from mail_concept order by datum desc, id desc limit 400"),
    rijen(db, "select v.id, v.nota_id, v.status, v.uitkomst, v.gevraagd_op, n.nummer, n.entiteit, n.praktijk_id from pod_verzoek v join nota n on n.id=v.nota_id order by v.id desc limit 200"),
    rijen(db, "select sleutel, waarde from instelling where sleutel like 'bank_bron_%' or sleutel like 'maandronde_%'"),
  ]);
  return { mail, verzoeken, bron };
}

/** Alles in één keer (Excel-export, ook om over te stappen naar iets anders): elke tabel van de app als rijen. */
const EXPORT_TABELLEN = ["entiteit", "praktijk", "praktijk_versie", "praktijk_naam", "praktijk_patienten", "deelname", "deelname_uitzondering", "kostencomponent", "kostenmutatie",
  "subsidie", "inschrijftarief", "jaarlast", "medewerker", "contract", "contractmutatie", "afwezigheid", "inhuur", "cao_tabel", "loonparameter", "loonsom", "buffer", "lening",
  "jaarplan", "jaarplan_regel", "nota", "correctie", "afrekening", "verwachting", "bankrekening", "bankmutatie", "bank_toewijzing", "koppeling", "mail_concept", "pod_verzoek",
  "overname", "ronde_stap", "instelling", "logboek"]         ;
export async function exportAlles(db          ) {
  const uit                            = {};
  for (const t of EXPORT_TABELLEN) {
    // nota's zonder de pdf-gegevens van de oude verzendrij; mail_concept zonder conceptsleutels; de rest zoals hij is
    const sql = t === "mail_concept" ? "select id, sleutel, soort, entiteit, praktijk_id, datum, nummers, aan, onderwerp, status, reden, concept_op, verzonden_op from mail_concept"
      : t === "logboek" ? "select * from logboek order by id" : `select * from ${t}`;
    try { uit[t] = await rijen(db, sql); } catch { uit[t] = []; }
  }
  return { gemaakt: (await rijen               (db, "select strftime('%Y-%m-%dT%H:%M:%SZ','now') as d"))[0].d, tabellen: uit };
}

export async function logboek(db          ) {
  return { regels: await rijen(db, "select * from logboek order by id desc limit 200") };
}

// ---------- schrijven ----------
                                      

export async function schrijf(db          , route        , b        , wie        ) {
  switch (route) {
    case "praktijk-versie": {
      const p = tekst(b.praktijk_id, "praktijk", { verplicht: true, max: 3 }) ;
      await bestaatPraktijk(db, p);
      const v = {
        geldig_van: datum(b.geldig_van, "geldig vanaf") , naam: tekst(b.naam, "naam", { verplicht: true, max: 120 }) ,
        houder: tekst(b.houder, "houder", { max: 160 }), tav: tekst(b.tav, "t.a.v.", { max: 120 }), adres: tekst(b.adres, "adres", { max: 160 }),
        postcode_plaats: tekst(b.postcode_plaats, "postcode en plaats", { max: 80 }), email: tekst(b.email, "e-mail", { max: 200 }),
        kvk: tekst(b.kvk, "kvk", { max: 12 }), opmerking: tekst(b.opmerking, "opmerking", { max: 400 }),
      };
      if (v.email && !/^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i.test(v.email)) throw new Fout(400, "e-mailadres ziet er niet goed uit");
      if (v.kvk && !/^\d{8}$/.test(v.kvk)) throw new Fout(400, "kvk-nummer = 8 cijfers");
      const oud = await rijen(db, "select * from praktijk_versie where praktijk_id=? and geldig_van=?", p, v.geldig_van);
      if (oud.length) throw new Fout(409, "er is al een versie op die datum; kies een andere datum");
      const st = [
        db.prepare("insert into praktijk_versie (praktijk_id, geldig_van, naam, houder, tav, adres, postcode_plaats, email, kvk, opmerking) values (?,?,?,?,?,?,?,?,?,?)")
          .bind(p, v.geldig_van, v.naam, v.houder, v.tav, v.adres, v.postcode_plaats, v.email, v.kvk, v.opmerking),
        log(db, wie, "praktijk_versie", `${p}@${v.geldig_van}`, "nieuw", null, v),
      ];
      if (await legacyOpen(db)) {
        // huidige stand bijwerken als deze versie nu geldt en de nieuwste is (de pod leest naam_brief/email uit praktijk)
        st.push(db.prepare(
          "update praktijk set naam_brief=?, tav=?, adres=?, postcode_plaats=?, email=coalesce(?, email), eigenaar=coalesce(?, eigenaar) " +
          "where id=? and ? <= date('now') and not exists (select 1 from praktijk_versie where praktijk_id=? and geldig_van > ? and geldig_van <= date('now'))")
          .bind(v.naam, v.tav, v.adres, v.postcode_plaats, v.email, v.houder, p, v.geldig_van, p, v.geldig_van));
      }
      await db.batch(st);
      return { ok: true };
    }
    case "stand": {
      if (!(await legacyOpen(db))) throw new Fout(409, "patiëntenstanden zijn pas te wijzigen na het overstapmoment (nu nog een kopie van fin)");
      const p = tekst(b.praktijk_id, "praktijk", { verplicht: true, max: 3 }) ;
      await bestaatPraktijk(db, p);
      const pd = datum(b.peildatum, "peildatum") ;
      const aantal = getal(b.aantal, "aantal", { min: 0, max: 100000 }) ;
      if (!Number.isInteger(aantal)) throw new Fout(400, "aantal = heel getal");
      const status = keuze(b.status ?? "definitief", "status", ["voorlopig", "definitief"]         );
      const oud = await rijen(db, "select aantal, status, opgegeven_door, bron_tekst from praktijk_patienten where praktijk_id=? and peildatum=?", p, pd);
      const nieuw = { aantal, status, opgegeven_door: tekst(b.opgegeven_door, "opgegeven door", { max: 120 }), bron_tekst: tekst(b.bron_tekst, "bron", { max: 300 }) };
      await db.batch([
        db.prepare("insert into praktijk_patienten (praktijk_id, peildatum, aantal, status, opgegeven_door, bron_tekst) values (?,?,?,?,?,?) " +
          "on conflict(praktijk_id, peildatum) do update set aantal=excluded.aantal, status=excluded.status, opgegeven_door=excluded.opgegeven_door, bron_tekst=excluded.bron_tekst")
          .bind(p, pd, aantal, status, nieuw.opgegeven_door, nieuw.bron_tekst),
        log(db, wie, "praktijk_patienten", `${p}@${pd}`, oud.length ? "gewijzigd" : "nieuw", oud[0] ?? null, nieuw),
      ]);
      return { ok: true };
    }
    case "deelname": {
      if (!(await legacyOpen(db))) throw new Fout(409, "deelname is pas te wijzigen na het overstapmoment (nu nog een kopie van fin)");
      const e = keuze(b.entiteit, "entiteit", ENT);
      const p = tekst(b.praktijk_id, "praktijk", { verplicht: true, max: 3 }) ;
      await bestaatPraktijk(db, p);
      const van = datum(b.geldig_van, "vanaf") , tot = datum(b.geldig_tot, "tot en met", false);
      if (tot && tot < van) throw new Fout(400, "tot en met ligt vóór vanaf");
      if (b.id != null) {   // bestaande periode afsluiten
        const id = Number(b.id);
        const oud = await rijen(db, "select * from deelname where id=? and entiteit=? and praktijk_id=?", id, e, p);
        if (!oud.length) throw new Fout(404, "deelname niet gevonden");
        await db.batch([db.prepare("update deelname set geldig_tot=? where id=?").bind(tot, id), log(db, wie, "deelname", String(id), "einde", oud[0], { geldig_tot: tot })]);
        return { ok: true };
      }
      const overlap = await rijen(db, "select id from deelname where entiteit=? and praktijk_id=? and (geldig_tot is null or geldig_tot >= ?) and (? is null or geldig_van <= ?)", e, p, van, tot, tot);
      if (overlap.length) throw new Fout(409, "die periode overlapt een bestaande deelname; sluit die eerst af");
      await db.batch([db.prepare("insert into deelname (entiteit, praktijk_id, geldig_van, geldig_tot, regel) values (?,?,?,?,?)").bind(e, p, van, tot, tekst(b.regel, "regel", { max: 200 })),
        log(db, wie, "deelname", `${e}/${p}@${van}`, "nieuw", null, { van, tot })]);
      return { ok: true };
    }
    case "kostencomponent": {
      const e = keuze(b.entiteit, "entiteit", ENT);
      const naam = tekst(b.naam, "naam", { verplicht: true, max: 120 }) ;
      const soort = keuze(b.soort, "soort", ["vast", "personeel", "variabel"]         );
      const per = keuze(b.per, "per", ["maand", "kwartaal", "jaar"]         );
      const van = datum(b.geldig_van, "vanaf") ;
      const bedrag = getal(b.bedrag, "bedrag", { min: 0, max: 5e6 }) ;
      await db.batch([
        db.prepare("insert into kostencomponent (entiteit, naam, soort, per, betaalmoment, volgorde, opmerking) values (?,?,?,?,?, (select coalesce(max(volgorde),0)+1 from kostencomponent where entiteit=?), ?)")
          .bind(e, naam, soort, per, tekst(b.betaalmoment, "betaalmoment", { max: 80 }), e, tekst(b.opmerking, "opmerking", { max: 400 })),
        db.prepare("insert into kostenmutatie (kostencomponent_id, geldig_van, bedrag, reden) values ((select max(id) from kostencomponent), ?, ?, ?)")
          .bind(van, bedrag, tekst(b.reden, "reden", { max: 300 }) || "nieuwe component"),
        log(db, wie, "kostencomponent", `${e}/${naam}`, "nieuw", null, { soort, per, van, bedrag }),
      ]);
      return { ok: true };
    }
    case "kostenmutatie": {
      const id = Number(b.kostencomponent_id);
      if (!Number.isInteger(id) || !(await rijen(db, "select 1 x from kostencomponent where id=?", id)).length) throw new Fout(400, "onbekende kostencomponent");
      const van = datum(b.geldig_van, "vanaf") ;
      const bedrag = getal(b.bedrag, "bedrag", { min: 0, max: 5e6, leeg: true });   // leeg = component stopt per die datum
      const reden = tekst(b.reden, "reden", { verplicht: true, max: 300 }) ;
      if ((await rijen(db, "select 1 x from kostenmutatie where kostencomponent_id=? and geldig_van=?", id, van)).length) throw new Fout(409, "er is al een wijziging op die datum");
      await db.batch([db.prepare("insert into kostenmutatie (kostencomponent_id, geldig_van, bedrag, reden) values (?,?,?,?)").bind(id, van, bedrag, reden),
        log(db, wie, "kostenmutatie", `${id}@${van}`, "nieuw", null, { bedrag, reden })]);
      return { ok: true };
    }
    case "subsidie": {
      const p = tekst(b.praktijk_id, "praktijk", { verplicht: true, max: 3 }) ;
      await bestaatPraktijk(db, p);
      const J = jaar(b.jaar);
      const soort = keuze(b.soort, "soort", ["aangevraagd", "verleend", "vastgesteld", "prognose"]         );
      const bedrag = getal(b.bedrag, "bedrag", { min: 0, max: 5e6 }) ;
      const oud = await rijen(db, "select bedrag, bron from subsidie where praktijk_id=? and jaar=? and soort=?", p, J, soort);
      const bron = tekst(b.bron, "bron", { max: 300 });
      await db.batch([db.prepare("insert into subsidie (praktijk_id, jaar, soort, bedrag, bron) values (?,?,?,?,?) on conflict(praktijk_id, jaar, soort) do update set bedrag=excluded.bedrag, bron=excluded.bron")
        .bind(p, J, soort, bedrag, bron), log(db, wie, "subsidie", `${p}/${J}/${soort}`, oud.length ? "gewijzigd" : "nieuw", oud[0] ?? null, { bedrag, bron })]);
      return { ok: true };
    }
    case "inschrijftarief": {
      const J = jaar(b.jaar);
      const tarief = getal(b.tarief, "tarief", { min: 0, max: 100 }) ;
      const oud = await rijen(db, "select tarief, bron from inschrijftarief where jaar=?", J);
      const bron = tekst(b.bron, "bron", { verplicht: true, max: 300 });
      await db.batch([db.prepare("insert into inschrijftarief (jaar, tarief, bron, opmerking) values (?,?,?,?) on conflict(jaar) do update set tarief=excluded.tarief, bron=excluded.bron, opmerking=excluded.opmerking")
        .bind(J, tarief, bron, tekst(b.opmerking, "opmerking", { max: 300 })), log(db, wie, "inschrijftarief", String(J), oud.length ? "gewijzigd" : "nieuw", oud[0] ?? null, { tarief, bron })]);
      return { ok: true };
    }
    default:
      return schrijfJaarronde(db, route, b, wie);
  }
}

export async function behandel(db          , methode        , pad        , zoek                 , body         , wie        )                                             {
  try {
    if (methode === "GET") {
      if (pad === "basis") return { status: 200, body: await basis(db) };
      if (pad === "geld") return { status: 200, body: await geld(db, zoek.get("jaar")) };
      if (pad === "monitor") return { status: 200, body: await monitor(db, zoek.get("jaar")) };
      if (pad === "logboek") return { status: 200, body: await logboek(db) };
      if (pad === "jaar") return { status: 200, body: await jaarGegevens(db, zoek.get("jaar")) };
      if (pad === "maand") return { status: 200, body: await maandStand(db) };
      if (pad === "export") return { status: 200, body: await exportAlles(db) };
      throw new Fout(404, "onbekende route");
    }
    if (methode === "POST") {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Fout(400, "verwacht een JSON-object");
      return { status: 200, body: await schrijf(db, pad, body          , wie) };
    }
    throw new Fout(405, "methode");
  } catch (e) {
    if (e instanceof Fout) return { status: e.status, body: { fout: e.message } };
    const m = String((e         )?.message || e);
    if (/UNIQUE constraint/i.test(m)) return { status: 409, body: { fout: "bestaat al" } };
    if (/koppeling: meer dan de bankpost/i.test(m)) return { status: 409, body: { fout: "die bankpost is al (deels) aan een andere nota gekoppeld" } };
    if (/CHECK constraint|FOREIGN KEY/i.test(m)) return { status: 400, body: { fout: "ongeldige invoer" } };
    return { status: 500, body: { fout: "interne fout" } };
  }
}

// =====================================================================================================================
// FASE 2 (wv2761): begroting en jaarronde. Rekenen doet de rekenkern; de API rekent een jaarplan of afrekening bij het bewaren
// zelf opnieuw uit de database (het voorbeeld in de browser is alleen een voorbeeld). Niets verstuurt mail of beweegt geld.
// =====================================================================================================================
const json = (x         ) => JSON.stringify(x);
const plusDag = (d        , n        ) => K.plusDagen(d, n);

/** Alles wat fase 2 voor jaar J nodig heeft (personeel, buffer, jaarplannen, nota's, correcties, ronde). */
export async function jaarGegevens(db          , j         ) {
  const J = jaar(j);
  const [contracten, contractmutaties, afwezigheid, inhuur, cao, loonparameters, loonsom, buffers, leningen, bufferGevraagd, spreiding,
    jaarplannen, regels, notas, correcties, ronde] = await Promise.all([
    rijen(db, "select c.*, m.naam from contract c left join medewerker m on m.id=c.medewerker_id order by c.soort, m.naam, c.van"),
    rijen(db, "select * from contractmutatie order by contract_id, geldig_van"),
    rijen(db, "select * from afwezigheid order by van"),
    rijen(db, "select * from inhuur order by van"),
    rijen(db, "select cao, ingang, schaal, trede, bruto, uren_voltijd from cao_tabel order by cao, ingang, schaal, trede"),
    rijen(db, "select * from loonparameter order by jaar"),
    rijen(db, "select * from loonsom order by jaar, maand"),
    rijen(db, "select * from buffer order by entiteit, geldig_van"),
    rijen(db, "select * from lening order by entiteit, id"),
    // buffer die in eerdere jaren al gevraagd is (de opbouw van jaar J zelf staat in het jaarplan; anders herverdeelt een herberekening midden in het opbouwjaar)
    rijen(db, "select entiteit, praktijk_id, round(sum(buffer),2) as bedrag from nota where status='definitief' and buffer<>0 and jaar<? group by 1,2", J),
    // spreiding van de betaaldag (gemeten): bedrag per dag van de maand, bijdragen/huur sinds 2025
    rijen(db, "select m.entiteit, cast(substr(m.boekdatum,9,2) as integer) as dag, round(sum(t.bedrag),2) as bedrag from bank_toewijzing t join bankmutatie m on m.id=t.bankmutatie_id " +
      "where t.soort in ('voorschot','huur') and t.bedrag>0 and m.boekdatum>='2025-01-01' group by 1,2"),
    rijen(db, "select * from jaarplan where jaar=? order by entiteit, versie", J),
    rijen(db, "select r.* from jaarplan_regel r join jaarplan p on p.id=r.jaarplan_id where p.jaar=? order by r.jaarplan_id, r.praktijk_id", J),
    // nota's van J−1 en J, plus alle tegoeden (afrekening 'u krijgt terug') en nota's met een verrekening, voor het tegoed per 31-12 (Codex r3)
    rijen(db, "select * from nota where jaar in (?, ?) or substr(datum,1,4)=? or (soort='afrekening' and bedrag<0) or regels like '%\"verrekening\"%' order by entiteit, nummer", J - 1, J, String(J)),
    rijen(db, "select * from correctie where nota_id is null or jaar>=? order by entiteit, praktijk_id, id", J - 1),
    rijen(db, "select * from ronde_stap where jaar=?", J),
  ]);
  return { jaar: J, contracten, contractmutaties, afwezigheid, inhuur, cao, loonparameters, loonsom, buffers, leningen, bufferGevraagd, spreiding, jaarplannen, regels, notas, correcties, ronde };
}

async function planInvoer(db          , J        ) {
  const [b, g] = await Promise.all([basis(db), jaarGegevens(db, J)]);
  return { ...g, standen: b.standen, deelnames: b.deelnames, componenten: b.componenten, mutaties: b.mutaties, versies: b.versies, instelling: b.instelling, vandaag: b.vandaag, entiteit: b.entiteit };
}
async function overnameVanaf(db          ) {
  const r = await rijen                    (db, "select waarde from instelling where sleutel='overname_vragen'");
  return r[0]?.waarde || "2027-01-01";
}
const EXACT = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;
const geldigId = (v         , naam        ) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new Fout(400, `${naam} ongeldig`); return n; };
// invoer in procenten (33,1 = 33,1 %), altijd ÷ 100; een bestaande waarde (fractie) gaat ongewijzigd mee (Codex M1)
const pct = (v         , naam        ) => getal(v, naam, { min: 0, max: 100 })  / 100;
const pctOf = (v         , naam        , oud         , standaard         ) => (v == null || v === "" ? (oud != null ? Number(oud) : standaard != null ? standaard : pct(v, naam)) : pct(v, naam));

export async function schrijfJaarronde(db          , route        , b        , wie        ) {
  switch (route) {
    // ---------- personeel ----------
    case "contract-bevestig": {
      const id = geldigId(b.id, "contract");
      const oud = (await rijen(db, "select * from contract where id=?", id))[0];
      if (!oud) throw new Fout(404, "contract niet gevonden");
      const schaal = tekst(b.schaal, "schaal", { verplicht: true, max: 6 }) ;
      const trede = getal(b.trede, "trede", { min: 0, max: 60 }) ;
      if (!Number.isInteger(trede)) throw new Fout(400, "trede = heel getal");
      const pm = b.periodiekmaand == null || b.periodiekmaand === "" ? (oud.periodiekmaand                 ) : getal(b.periodiekmaand, "periodiekmaand", { min: 1, max: 12 });
      if (!(await rijen(db, "select 1 x from cao_tabel where cao=? and schaal=? and trede=?", oud.cao, schaal, trede)).length) throw new Fout(400, "die schaal/trede staat niet in de cao-tabellen");
      const nieuw = { schaal, trede, periodiekmaand: pm, bevestigd_door: wie };
      await db.batch([db.prepare("update contract set schaal=?, trede=?, periodiekmaand=?, bevestigd_op=strftime('%Y-%m-%dT%H:%M:%SZ','now'), bevestigd_door=? where id=?").bind(schaal, trede, pm, wie, id),
        log(db, wie, "contract", String(id), "bevestigd", { schaal: oud.schaal, trede: oud.trede, periodiekmaand: oud.periodiekmaand, trede_bron: oud.trede_bron }, nieuw)]);
      return { ok: true };
    }
    case "contract": {   // nieuw contract of vacature met een datum
      const soort = keuze(b.soort ?? "vacature", "soort", ["dienst", "vacature"]         );
      const van = datum(b.van, "vanaf") , tot = datum(b.tot, "tot en met", false);
      if (tot && tot < van) throw new Fout(400, "tot en met ligt vóór vanaf");
      const uren = getal(b.uren, "uren per week", { min: 1, max: 60 }) ;
      const cao = tekst(b.cao ?? "huisartsenzorg", "cao", { verplicht: true, max: 40 }) ;
      const schaal = tekst(b.schaal, "schaal", { verplicht: true, max: 6 }) ;
      const trede = getal(b.trede, "trede", { min: 0, max: 60 }) ;
      const pm = getal(b.periodiekmaand ?? 1, "periodiekmaand", { min: 1, max: 12 }) ;
      if (!(await rijen(db, "select 1 x from cao_tabel where cao=? and schaal=? and trede=?", cao, schaal, trede)).length) throw new Fout(400, "die schaal/trede staat niet in de cao-tabellen");
      const naam = tekst(b.naam, "naam", { verplicht: true, max: 120 }) ;
      const functie = tekst(b.functie, "functie", { max: 80 });
      await db.batch([
        db.prepare("insert into medewerker (naam, opmerking) values (?, ?)").bind(naam, soort === "vacature" ? "vacature" : null),
        db.prepare("insert into contract (medewerker_id, soort, functie, van, tot, uren, cao, schaal, trede, trede_peildatum, periodiekmaand, trede_bron, bevestigd_op, bevestigd_door, herkomst) " +
          "values ((select max(id) from medewerker), ?,?,?,?,?,?,?,?,?,?, 'ingevoerd in de app', strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?, 'app')").bind(soort, functie, van, tot, uren, cao, schaal, trede, van, pm, wie),
        log(db, wie, "contract", naam, "nieuw", null, { soort, van, tot, uren, cao, schaal, trede, periodiekmaand: pm }),
      ]);
      return { ok: true };
    }
    case "contract-einde": {
      const id = geldigId(b.id, "contract");
      const oud = (await rijen(db, "select * from contract where id=?", id))[0];
      if (!oud) throw new Fout(404, "contract niet gevonden");
      const tot = datum(b.tot, "tot en met") ;
      if (tot < String(oud.van)) throw new Fout(400, "tot en met ligt vóór het begin");
      await db.batch([db.prepare("update contract set tot=? where id=?").bind(tot, id), log(db, wie, "contract", String(id), "einde", { tot: oud.tot }, { tot })]);
      return { ok: true };
    }
    case "contractmutatie": {
      const id = geldigId(b.contract_id, "contract");
      const c = (await rijen(db, "select * from contract where id=?", id))[0];
      if (!c) throw new Fout(404, "contract niet gevonden");
      const van = datum(b.geldig_van, "vanaf") ;
      const uren = getal(b.uren, "uren", { min: 1, max: 60, leeg: true });
      const schaal = tekst(b.schaal, "schaal", { max: 6 });
      const trede = getal(b.trede, "trede", { min: 0, max: 60, leeg: true });
      if (uren == null && schaal == null && trede == null) throw new Fout(400, "vul uren, schaal of trede in");
      if (trede != null && !(await rijen(db, "select 1 x from cao_tabel where cao=? and schaal=? and trede=?", c.cao, schaal ?? c.schaal, trede)).length) throw new Fout(400, "die schaal/trede staat niet in de cao-tabellen");
      const reden = tekst(b.reden, "reden", { verplicht: true, max: 300 }) ;
      await db.batch([db.prepare("insert into contractmutatie (contract_id, geldig_van, uren, schaal, trede, reden) values (?,?,?,?,?,?)").bind(id, van, uren, schaal, trede, reden),
        log(db, wie, "contractmutatie", `${id}@${van}`, "nieuw", null, { uren, schaal, trede, reden })]);
      return { ok: true };
    }
    case "afwezigheid": {
      const id = geldigId(b.contract_id, "contract");
      if (!(await rijen(db, "select 1 x from contract where id=?", id)).length) throw new Fout(404, "contract niet gevonden");
      const van = datum(b.van, "vanaf") , tot = datum(b.tot, "tot en met", false);
      if (tot && tot < van) throw new Fout(400, "tot en met ligt vóór vanaf");
      const v = { soort: keuze(b.soort ?? "ziekte", "soort", ["ziekte", "verlof", "overig"]         ), loon: b.loondoorbetaling_pct == null || b.loondoorbetaling_pct === "" ? 1 : pct(b.loondoorbetaling_pct, "loondoorbetaling"),
        uitk: b.uitkering_pct == null || b.uitkering_pct === "" ? 0 : pct(b.uitkering_pct, "uitkering"), vertr: getal(b.vertraging_maanden ?? 2, "vertraging", { min: 0, max: 12 })  };
      await db.batch([db.prepare("insert into afwezigheid (contract_id, van, tot, soort, loondoorbetaling_pct, uitkering_pct, vertraging_maanden, opmerking) values (?,?,?,?,?,?,?,?)")
        .bind(id, van, tot, v.soort, v.loon, v.uitk, v.vertr, tekst(b.opmerking, "opmerking", { max: 300 })), log(db, wie, "afwezigheid", `${id}@${van}`, "nieuw", null, { van, tot, ...v })]);
      return { ok: true };
    }
    case "inhuur": {
      const van = datum(b.van, "vanaf") , tot = datum(b.tot, "tot en met", false);
      if (tot && tot < van) throw new Fout(400, "tot en met ligt vóór vanaf");
      const v = { omschrijving: tekst(b.omschrijving, "omschrijving", { verplicht: true, max: 160 }), uren_week: getal(b.uren_week, "uren per week", { min: 0.5, max: 80 }), tarief: getal(b.tarief, "tarief", { min: 0, max: 500 }) };
      await db.batch([db.prepare("insert into inhuur (omschrijving, van, tot, uren_week, tarief, opmerking) values (?,?,?,?,?,?)").bind(v.omschrijving, van, tot, v.uren_week, v.tarief, tekst(b.opmerking, "opmerking", { max: 300 })),
        log(db, wie, "inhuur", `${v.omschrijving}@${van}`, "nieuw", null, { van, tot, ...v })]);
      return { ok: true };
    }
    case "loonparameter": {
      const J = jaar(b.jaar);
      const oud = (await rijen(db, "select * from loonparameter where jaar=?", J))[0] ?? null;
      const v = {
        werkgeverslasten: pctOf(b.werkgeverslasten, "werkgeverslasten", oud?.werkgeverslasten), vakantiegeld_res: pctOf(b.vakantiegeld_res, "reservering vakantiegeld", oud?.vakantiegeld_res),
        eindejaar_res: pctOf(b.eindejaar_res, "reservering eindejaarsuitkering", oud?.eindejaar_res), verzuim_pct: pctOf(b.verzuim_pct, "verzuim", oud?.verzuim_pct, 0),
        cao_aanname_pct: pctOf(b.cao_aanname_pct, "cao-aanname", oud?.cao_aanname_pct, 0),
      };
      const md = tekst(b.cao_aanname_maanddag ?? oud?.cao_aanname_maanddag ?? "07-01", "ingang cao-aanname", { max: 5 }) ;
      if (!/^(0[1-9]|1[0-2])-01$/.test(md)) throw new Fout(400, "ingang cao-aanname = MM-01");
      const bron = tekst(b.bron, "bron", { verplicht: true, max: 300 });
      await db.batch([db.prepare("insert into loonparameter (jaar, werkgeverslasten, vakantiegeld_res, eindejaar_res, verzuim_pct, cao_aanname_pct, cao_aanname_maanddag, verdeling, bron) values (?,?,?,?,?,?,?,?,?) " +
        "on conflict(jaar) do update set werkgeverslasten=excluded.werkgeverslasten, vakantiegeld_res=excluded.vakantiegeld_res, eindejaar_res=excluded.eindejaar_res, verzuim_pct=excluded.verzuim_pct, " +
        "cao_aanname_pct=excluded.cao_aanname_pct, cao_aanname_maanddag=excluded.cao_aanname_maanddag, verdeling=coalesce(excluded.verdeling, loonparameter.verdeling), bron=excluded.bron")
        .bind(J, v.werkgeverslasten, v.vakantiegeld_res, v.eindejaar_res, v.verzuim_pct, v.cao_aanname_pct, md, oud?.verdeling ?? null, bron),
        log(db, wie, "loonparameter", String(J), oud ? "gewijzigd" : "nieuw", oud, { ...v, cao_aanname_maanddag: md, bron })]);
      return { ok: true };
    }
    case "buffer": {
      const e = keuze(b.entiteit, "entiteit", ENT);
      const van = datum(b.geldig_van, "vanaf") ;
      const doel = getal(b.doel, "doel", { min: 0, max: 1e6 }) ;
      const mnd = getal(b.opbouw_maanden ?? 12, "opbouw in maanden", { min: 1, max: 12 }) ;
      const status = keuze(b.status ?? "voorstel", "status", ["voorstel", "besloten"]         );
      const oud = (await rijen(db, "select * from buffer where entiteit=? and geldig_van=?", e, van))[0] ?? null;
      await db.batch([db.prepare("insert into buffer (entiteit, geldig_van, doel, opbouw_maanden, status, opmerking) values (?,?,?,?,?,?) on conflict(entiteit, geldig_van) do update set doel=excluded.doel, opbouw_maanden=excluded.opbouw_maanden, status=excluded.status, opmerking=excluded.opmerking")
        .bind(e, van, doel, mnd, status, tekst(b.opmerking, "opmerking", { max: 300 })), log(db, wie, "buffer", `${e}@${van}`, oud ? "gewijzigd" : "nieuw", oud, { doel, opbouw_maanden: mnd, status })]);
      return { ok: true };
    }
    case "verkoopadres": {   // verkoopadres van de entiteit in Exact (elk stuk gaat óók daarheen); leeg = ontbreekt
      const e = keuze(b.entiteit, "entiteit", ENT);
      const a = tekst(b.email, "verkoopadres", { max: 200 }) || "";
      if (a && !EXACT.test(a)) throw new Fout(400, "verkoopadres ziet er niet goed uit");
      const oud = await rijen                    (db, "select waarde from instelling where sleutel=?", `verkoopadres_exact_${e}`);
      await db.batch([db.prepare("insert into instelling (sleutel, waarde, opmerking) values (?,?,?) on conflict(sleutel) do update set waarde=excluded.waarde").bind(`verkoopadres_exact_${e}`, a, `verkoopadres ${e} in Exact`),
        log(db, wie, "instelling", `verkoopadres_exact_${e}`, "gewijzigd", oud[0]?.waarde ?? null, a)]);
      return { ok: true };
    }
    case "jaarlast": {   // kosten van een jaar: voorlopig (boekhouding) of definitief (jaarrekening); na een vastgestelde afrekening → correctie (R2)
      const e = keuze(b.entiteit, "entiteit", ENT);
      const J = jaar(b.jaar);
      const bedrag = getal(b.bedrag, "bedrag", { min: 0, max: 5e6 }) ;
      const bron = keuze(b.bron, "bron", ["boekhouding", "jaarrekening"]         );
      const opm = tekst(b.opmerking, "opmerking", { max: 300 });
      const oud = (await rijen                                  (db, "select bedrag, bron from jaarlast where entiteit=? and jaar=?", e, J))[0] ?? null;
      const st = [db.prepare("insert into jaarlast (entiteit, jaar, bedrag, bron, opmerking, ingevoerd_op) values (?,?,?,?,?, date('now')) on conflict(entiteit, jaar) do update set bedrag=excluded.bedrag, bron=excluded.bron, opmerking=excluded.opmerking, ingevoerd_op=excluded.ingevoerd_op")
        .bind(e, J, bedrag, bron, opm), log(db, wie, "jaarlast", `${e}/${J}`, oud ? "gewijzigd" : "nieuw", oud, { bedrag, bron })];
      const af = await rijen                                                                   (db, "select praktijk_id, aandeel, jaarlast_totaal from afrekening where entiteit=? and jaar=? and versie='ovis-pot' and status='vastgesteld'", e, J);
      if (af.length) {   // na een vastgestelde afrekening: de kosten alleen wijzigen als de grondslag niet intussen veranderde (Codex r2 M3)
        st[0] = db.prepare("insert into jaarlast (entiteit, jaar, bedrag, bron, opmerking, ingevoerd_op) values (?,?,?,?,?, date('now')) on conflict(entiteit, jaar) do update set bedrag=excluded.bedrag, bron=excluded.bron, opmerking=excluded.opmerking, ingevoerd_op=excluded.ingevoerd_op " +
          "where exists (select 1 from afrekening where entiteit=? and jaar=? and versie='ovis-pot' and abs(jaarlast_totaal-?)<0.005)").bind(e, J, bedrag, bron, opm, e, J, Number(af[0].jaarlast_totaal));
      }
      if (af.length && oud && Math.abs(bedrag - Number(af[0].jaarlast_totaal)) >= 0.01) {
        const verschil = bedrag - Number(af[0].jaarlast_totaal);
        for (const r of af) {
          const c = K.rond2(verschil * Number(r.aandeel));
          if (Math.abs(c) < 0.005) continue;
          // alleen invoegen als de afrekening nog op de oude kosten staat: twee gelijktijdige wijzigingen vragen het verschil nooit dubbel (Codex M6)
          st.push(db.prepare("insert into correctie (entiteit, praktijk_id, jaar, bedrag, omschrijving, toelichting) select ?,?,?,?,?,? " +
            "where exists (select 1 from afrekening where entiteit=? and jaar=? and versie='ovis-pot' and praktijk_id=? and abs(jaarlast_totaal-?)<0.005)").bind(e, r.praktijk_id, J,
            c, `Correctie afrekening ${J}: ${bron === "jaarrekening" ? "definitieve kosten (jaarrekening)" : "gewijzigde kosten"}`,
            `kosten ${K.euro(Number(af[0].jaarlast_totaal))} → ${K.euro(bedrag)}; verschil × uw aandeel ${(Number(r.aandeel) * 100).toFixed(3).replace(".", ",")} %`,
            e, J, r.praktijk_id, Number(af[0].jaarlast_totaal)));
        }
        st.push(db.prepare("update afrekening set jaarlast_totaal=? where entiteit=? and jaar=? and versie='ovis-pot' and abs(jaarlast_totaal-?)<0.005").bind(bedrag, e, J, Number(af[0].jaarlast_totaal)));
      }
      await db.batch(st);
      const nu = (await rijen                    (db, "select bedrag from jaarlast where entiteit=? and jaar=?", e, J))[0];
      if (!nu || Math.abs(Number(nu.bedrag) - bedrag) >= 0.005) throw new Fout(409, "de kosten zijn intussen door een andere wijziging aangepast; kijk opnieuw");
      return { ok: true };
    }
    case "ronde-stap": {
      const J = jaar(b.jaar);
      const stap = keuze(b.stap, "stap", ["A1", "A2", "A3", "B4", "B5", "B6"]         );
      const akkoord = b.akkoord === true || b.akkoord === "ja";
      const notitie = tekst(b.notitie, "notitie", { max: 400 });
      await db.batch([db.prepare("insert into ronde_stap (jaar, stap, akkoord_op, wie, notitie) values (?,?,?,?,?) on conflict(jaar, stap) do update set akkoord_op=excluded.akkoord_op, wie=excluded.wie, notitie=coalesce(excluded.notitie, ronde_stap.notitie)")
        .bind(J, stap, akkoord ? new Date().toISOString().slice(0, 19) + "Z" : null, wie, notitie), log(db, wie, "ronde_stap", `${J}/${stap}`, akkoord ? "akkoord" : "open", null, { notitie })]);
      return { ok: true };
    }
    // ---------- jaarplan ----------
    case "jaarplan": {   // bewaar het jaarplan als nieuwe versie (concept); bij een vastgesteld plan: wijziging tussendoor (R9)
      const e = keuze(b.entiteit, "entiteit", ENT);
      const J = jaar(b.jaar);
      const reden = tekst(b.reden, "reden", { verplicht: true, max: 300 }) ;
      const d = await planInvoer(db, J);
      const r = K.rekenJaarplan(d, e, J, { startsaldo: b.startsaldo == null || b.startsaldo === "" ? undefined : getal(b.startsaldo, "startsaldo", { min: -1e7, max: 1e7 })  });
      if (!r.ok || !r.patroon.ok) throw new Fout(409, `niet te rekenen: ${r.waarschuwingen.join("; ") || ("reden" in r.patroon ? r.patroon.reden : "")}`);
      const vast = (d.jaarplannen                             ).find((p) => p.entiteit === e && p.status === "vastgesteld");
      let praktijken                                                                                                        = r.patroon.praktijken.map((p) => ({ praktijk_id: p.praktijk_id, aandeel: p.aandeel, stand: p.stand                 , maanden: p.maanden,
        buffer: r.buffer?.praktijken.find((x) => x.praktijk_id === p.praktijk_id)?.maanden || Array(12).fill(0) }));
      let herz          = null;
      if (vast) {
        const keuzeR9 = keuze(b.keuze, "keuze (verdelen of laten)", ["verdelen", "laten"]         );
        const oudR = (d.regels                             ).filter((x) => x.jaarplan_id === vast.id).map((x) => ({ praktijk_id: String(x.praktijk_id), maanden: JSON.parse(String(x.maanden))            , buffer: JSON.parse(String(x.buffer))            , aandeel: Number(x.aandeel), stand: Number(x.stand) }));
        const gemaakt = [...new Set((d.notas                             ).filter((n) => n.entiteit === e && n.jaar === J && n.soort === "maand" && n.bron === "ovis-pot").map((n) => Number(String(n.periode).slice(5, 7))))];
        const h = K.herzien({ oud: oudR, nieuw: praktijken, gemaakt, keuze: keuzeR9 });
        herz = { keuze: keuzeR9, gemaakt, open_maanden: h.open_maanden, naar_afrekening: h.praktijken.map((p) => ({ praktijk_id: p.praktijk_id, bedrag: p.naar_afrekening })) };
        praktijken = h.praktijken.map((p) => {
          const o = oudR.find((x) => x.praktijk_id === p.praktijk_id), n = praktijken.find((x) => x.praktijk_id === p.praktijk_id);
          return { praktijk_id: p.praktijk_id, aandeel: o?.aandeel ?? n?.aandeel ?? 0, stand: o?.stand ?? n?.stand ?? null, maanden: p.maanden, buffer: o?.buffer || n?.buffer || Array(12).fill(0) };
        });
      }
      const versie = 1 + Math.max(0, ...(d.jaarplannen                             ).filter((p) => p.entiteit === e).map((p) => Number(p.versie)));
      const totaal = praktijken.reduce((s, p) => s + p.maanden.reduce((a, x) => a + x, 0), 0);
      const grondslag = {
        begroting: { totaal: r.begroting.totaal, maanden: r.begroting.maanden, regels: r.begroting.regels.map((x) => ({ naam: x.naam, per: x.per, jaar: x.jaar })), vervangen: r.begroting.vervangen,
          vakantiegeld_pakket: r.begroting.vakantiegeld_pakket, eindejaar_pakket: r.begroting.eindejaar_pakket },
        personeel: r.personeel ? { totaal: r.personeel.totaal, bruto: r.personeel.bruto, hoe: r.personeel.hoe, waarschuwingen: r.personeel.waarschuwingen } : null,
        patroon: { gewoon: r.patroon.gewoon, mei: r.patroon.mei, november: r.patroon.november, hoe: r.patroon.hoe, afronding: r.patroon.afronding },
        aandelen: { uitleg: r.aandelen.uitleg, noemer: r.aandelen.noemer },
        buffer: r.buffer ? { doel: r.buffer.doel, status: r.buffer_instelling?.status, aflossing: r.buffer.aflossing, lening_rest: r.buffer.lening_rest, waarschuwing: r.buffer.waarschuwing } : null,
        kasstroom: r.kasstroom ? { startsaldo: r.kasstroom.startsaldo, laagste: r.kasstroom.laagste, laagste_op: r.kasstroom.laagste_op, onder: r.kasstroom.onder, voorstel: r.kasstroom.voorstel } : null,
        waarschuwingen: r.waarschuwingen, herziening: herz,
      };
      const st = [db.prepare("insert into jaarplan (entiteit, jaar, versie, status, totaal, reden, grondslag, gemaakt_door) values (?,?,?, 'concept', ?,?,?,?)").bind(e, J, versie, totaal, reden, json(grondslag), wie)];
      for (const p of praktijken) st.push(db.prepare("insert into jaarplan_regel (jaarplan_id, praktijk_id, aandeel, stand, maanden, buffer, jaar_bedrag) values ((select id from jaarplan where entiteit=? and jaar=? and versie=?), ?,?,?,?,?,?)")
        .bind(e, J, versie, p.praktijk_id, p.aandeel, p.stand, json(p.maanden), json(p.buffer), p.maanden.reduce((a, x) => a + x, 0)));
      st.push(log(db, wie, "jaarplan", `${e}/${J}/v${versie}`, "nieuw", null, { totaal, reden, herziening: herz }));
      await db.batch(st);
      return { ok: true, versie };
    }
    case "jaarplan-vaststellen": {
      const id = geldigId(b.id, "jaarplan");
      const p = (await rijen(db, "select * from jaarplan where id=?", id))[0];
      if (!p) throw new Fout(404, "jaarplan niet gevonden");
      if (p.status !== "concept") throw new Fout(409, `dit jaarplan is ${p.status}`);
      const nieuwer = await rijen(db, "select 1 x from jaarplan where entiteit=? and jaar=? and versie>?", p.entiteit, p.jaar, p.versie);
      if (nieuwer.length) throw new Fout(409, "er is een nieuwere versie; stel die vast");
      // een herziening (R9) gaat uit van de nota's die er bij het bewaren waren; zijn er sindsdien nota's bijgekomen, dan opnieuw bewaren (Codex M4)
      const herz = JSON.parse(String(p.grondslag)).herziening                                ;
      const nu = (await rijen                     (db, "select distinct periode from nota where entiteit=? and jaar=? and soort='maand' and bron='ovis-pot'", p.entiteit, p.jaar)).map((x) => Number(String(x.periode).slice(5, 7))).sort((a, c) => a - c);
      const toen = (herz?.gemaakt || []).slice().sort((a, c) => a - c);
      if ((herz || nu.length) && json(nu) !== json(toen)) throw new Fout(409, "er zijn sinds het bewaren nota's gemaakt; bewaar het jaarplan opnieuw");
      // atomair: alleen als dit plan nog concept is, vervalt het oude en wordt dit vastgesteld (Codex M5)
      await db.batch([
        db.prepare("update jaarplan set status='vervallen' where entiteit=? and jaar=? and status='vastgesteld' and exists (select 1 from jaarplan where id=? and status='concept') " +
          "and (select count(distinct periode) from nota where entiteit=? and jaar=? and soort='maand' and bron='ovis-pot') = ?").bind(p.entiteit, p.jaar, id, p.entiteit, p.jaar, toen.length),
        db.prepare("update jaarplan set status='vastgesteld', vastgesteld_op=strftime('%Y-%m-%dT%H:%M:%SZ','now') where id=? and status='concept' " +
          "and (select count(distinct periode) from nota where entiteit=? and jaar=? and soort='maand' and bron='ovis-pot') = ?").bind(id, p.entiteit, p.jaar, toen.length),
        log(db, wie, "jaarplan", `${p.entiteit}/${p.jaar}/v${p.versie}`, "vastgesteld", null, { totaal: p.totaal }),
      ]);
      const na = (await rijen                    (db, "select status from jaarplan where id=?", id))[0];
      if (na?.status !== "vastgesteld") throw new Fout(409, "niet vastgesteld (tegelijk gewijzigd); kijk opnieuw");
      return { ok: true };
    }
    // ---------- nota's ----------
    case "notas-maken": {   // de maandnota's van één maand uit de vastgestelde jaarplannen (alle drie de entiteiten)
      const J = jaar(b.jaar);
      const m = getal(b.maand, "maand", { min: 1, max: 12 }) ;
      if (!Number.isInteger(m)) throw new Fout(400, "maand = 1–12");
      const dat = datum(b.datum ?? `${J}-${String(m).padStart(2, "0")}-01`, "notadatum") ;
      if (dat < (await overnameVanaf(db))) throw new Fout(409, `nota's maakt de app pas vanaf ${await overnameVanaf(db)}; ${J < 2027 ? "2026 vroeg David zelf" : "eerder niet"}`);
      const verval = datum(b.vervaldag ?? (m === 1 ? plusDag(dat, 14) : `${J}-${String(m).padStart(2, "0")}-15`), "vervaldag") ;
      if (verval < dat) throw new Fout(400, "vervaldag ligt vóór de notadatum");
      const d = await planInvoer(db, J);
      // alle onverrekende tegoeden (afrekeningsnota's 'u krijgt terug'), ongeacht het jaar (Codex M2)
      const tegoeden = await rijen(db, "select id, entiteit, praktijk_id, nummer, bedrag, verrekend, datum from nota where soort='afrekening' and status='definitief' and bedrag<0 and -bedrag-verrekend>0.004");
      const st         = [];
      const gemaakt           = [];
      const token = `aanvraag:${crypto.randomUUID()}`;   // koppelt invoegen, neveneffecten en controle aan deze aanvraag (Codex r3 M1)
      for (const e of ENT) {
        const plan = (d.jaarplannen                             ).find((p) => p.entiteit === e && p.status === "vastgesteld");
        if (!plan) continue;
        const grond = JSON.parse(String(plan.grondslag));
        const nummers = (await rijen                    (db, "select nummer from nota where entiteit=?", e)).map((x) => x.nummer);
        for (const r of (d.regels                             ).filter((x) => x.jaarplan_id === plan.id)) {
          const pid = String(r.praktijk_id), periode = `${J}-${String(m).padStart(2, "0")}`;
          if ((d.notas                             ).some((n) => n.entiteit === e && n.praktijk_id === pid && n.soort === "maand" && n.periode === periode && n.status !== "vervallen")) continue;
          const bijdrage = Number(JSON.parse(String(r.maanden))[m - 1]), buf = Number(JSON.parse(String(r.buffer))[m - 1]);
          const corr = (d.correcties                             ).filter((c) => c.entiteit === e && c.praktijk_id === pid && c.nota_id == null);
          const teg = tegoeden.filter((n) => n.entiteit === e && n.praktijk_id === pid)
            .map((n) => ({ id: Number(n.id), nummer: String(n.nummer), bedrag: Number(n.bedrag), verrekend: Number(n.verrekend || 0), datum: String(n.datum) }));
          const voor = bijdrage + buf + corr.reduce((s, c) => s + Number(c.bedrag), 0);
          const verr = K.verrekenTegoeden(teg, voor);
          if (Math.abs(voor) < 0.005 && !verr.length) continue;
          const deb = K.debiteurOp(d.versies         , pid, dat);
          if (!deb) throw new Fout(409, `geen praktijkgegevens (debiteur) voor ${pid} op ${dat}: vul eerst een praktijkversie in`);
          const nummer = K.volgendNummer(nummers, J);
          nummers.push(nummer);
          const n = K.maakMaandNota({ entiteit: e, jaar: J, maand: m, praktijk_id: pid, nummer, datum: dat, vervaldag: verval, debiteur: deb, bijdrage, buffer: buf,
            correcties: corr.map((c) => ({ id: Number(c.id), bedrag: Number(c.bedrag), omschrijving: String(c.omschrijving), toelichting: String(c.toelichting || "") })), verrekeningen: verr,
            hoe: `${grond.patroon?.hoe || ""}; uw aandeel ${(Number(r.aandeel) * 100).toFixed(3).replace(".", ",")} % (${grond.aandelen?.uitleg || ""})` });
          // alleen uit een plan dat bij het opslaan nog vastgesteld is; de neveneffecten alleen als de nota er echt staat (Codex r2 M2)
          st.push(db.prepare("insert into nota (entiteit, jaar, nummer, praktijk_id, datum, vervaldag, soort, periode, titel, regels, bedrag, buffer, status, bron, jaarplan_id, debiteur, opmerking, aangemaakt_op) " +
            "select ?,?,?,?,?,?,?,?,?,?,?,?, 'definitief', 'ovis-pot', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now') where exists (select 1 from jaarplan where id=? and status='vastgesteld')")
            .bind(e, J, nummer, pid, dat, verval, "maand", n.periode, n.titel, json(n.regels), n.bedrag, n.buffer, plan.id, json(deb), token, plan.id));
          for (const c of corr) st.push(db.prepare("update correctie set nota_id=(select id from nota where entiteit=? and nummer=? and opmerking=?) where id=? and nota_id is null and exists (select 1 from nota where entiteit=? and nummer=? and opmerking=?)").bind(e, nummer, token, c.id, e, nummer, token));
          for (const v of verr) st.push(db.prepare("update nota set verrekend=round(verrekend+?,2) where id=? and exists (select 1 from nota where entiteit=? and nummer=? and opmerking=?)").bind(-v.bedrag, v.nota_id, e, nummer, token));
          gemaakt.push(`${e} ${nummer}`);
        }
      }
      if (!gemaakt.length) throw new Fout(409, "niets te maken: geen vastgesteld jaarplan, of de nota's van deze maand bestaan al");
      st.push(log(db, wie, "nota", `${J}-${m}`, "gemaakt", null, { aantal: gemaakt.length, nummers: gemaakt }));
      await db.batch(st);
      const echt = await rijen               (db, "select count(*) as n from nota where opmerking=?", token);
      if (Number(echt[0]?.n) !== gemaakt.length) throw new Fout(409, `het jaarplan is intussen gewijzigd; ${echt[0]?.n ?? 0} van ${gemaakt.length} nota's gemaakt — maak de rest opnieuw`);
      return { ok: true, gemaakt };
    }
    case "afrekening-vaststellen": {   // R3: POT/KM een afrekeningsnota per praktijk; SLOEL een correctie op de eerstvolgende huurnota
      const e = keuze(b.entiteit, "entiteit", ENT);
      const J = jaar(b.jaar);
      const dat = datum(b.datum, "notadatum") ;
      if (dat < (await overnameVanaf(db))) throw new Fout(409, `afrekenen in de app kan vanaf ${await overnameVanaf(db)}`);
      if ((await rijen(db, "select 1 x from afrekening where entiteit=? and jaar=? and versie='ovis-pot'", e, J)).length) throw new Fout(409, `de afrekening ${J} is al vastgesteld; een kostenwijziging wordt een correctie`);
      const [bs, g] = await Promise.all([basis(db), geld(db, J)]);
      const r = K.rekenAfrekeningJaar({ entiteit: e, jaar: J, standen: bs.standen         , deelnames: bs.deelnames         , jaarlasten: bs.jaarlast         , geld: g          });
      if (!r.ok) throw new Fout(409, "reden" in r ? String(r.reden) : "niet te rekenen");
      const verval = plusDag(dat, 14);
      const nummers = (await rijen                    (db, "select nummer from nota where entiteit=?", e)).map((x) => x.nummer);
      const st         = [];
      // R10 (fase 3): een overname in J met verdeling 'maanden' splitst de afrekening over oude en nieuwe houder (kosten naar maanden, wat al
      // voldaan is naar de datum van het stuk of de betaling); elk deel krijgt een eigen nota met zijn eigen debiteur.
      const overnames = await rijen                                                           (db, "select praktijk_id, datum, verdeling from overname where substr(datum,1,4)=? order by datum", String(J));
      const voldaanVoor = async (pid        , grens        ) => {
        if (r.modus === "betaald") {
          const q = await rijen               (db, "select coalesce(sum(t.bedrag),0) as s from bank_toewijzing t join bankmutatie m on m.id=t.bankmutatie_id where m.entiteit=? and t.praktijk_id=? and t.boekjaar=? and t.soort in ('voorschot','huur') and m.boekdatum<?", e, pid, J, grens);
          return Number(q[0].s);
        }
        const q = await rijen               (db, "select coalesce(sum(case when bron='ovis-pot' then (select coalesce(sum(json_extract(x.value,'$.bedrag')),0) from json_each(nota.regels) x where json_extract(x.value,'$.soort')='bijdrage') else bedrag - coalesce(buffer,0) end),0) as s " +
          "from nota where entiteit=? and praktijk_id=? and jaar=? and status='definitief' and soort not in ('buffer','afrekening') and datum<?", e, pid, J, grens);
        return Number(q[0].s);
      };
      for (const x0 of r.rijen) {
        const ov = overnames.filter((o) => o.praktijk_id === x0.praktijk_id && o.verdeling === "maanden").at(-1) ?? null;
        if (ov) {
          const vOud = K.rond2(await voldaanVoor(x0.praktijk_id, ov.datum));
          const delen = K.verdeelAfrekening({ jaar: J, kosten: x0.kosten, alVoldaanOud: vOud, alVoldaanNieuw: K.rond2(x0.al_voldaan - vOud), overname: ov });
          if (delen.length === 2) {
            st.push(db.prepare("insert into afrekening (entiteit, jaar, praktijk_id, versie, aandeel, jaarlast_toegerekend, voorschotten, saldo, status, opmerking, jaarlast_totaal) values (?,?,?, 'ovis-pot', ?,?,?,?, 'vastgesteld', ?, ?)")
              .bind(e, J, x0.praktijk_id, x0.aandeel, x0.kosten, x0.al_voldaan, x0.uitkomst, `${r.modus === "betaald" ? "tegen betaald (bank)" : "tegen gevraagd (nota's)"}; kosten ${r.kosten_status}; overname per ${ov.datum}: oude houder ${delen[0].maanden} mnd, nieuwe ${delen[1].maanden} mnd`, r.kosten));
            for (const d of delen) {
              if (Math.abs(d.uitkomst) < 0.005) continue;
              const debDatum = d.deel === "oud" ? plusDag(ov.datum, -1) : dat;
              const deb = K.debiteurOp(bs.versies         , x0.praktijk_id, debDatum);
              if (!deb) throw new Fout(409, `geen praktijkgegevens (debiteur) voor ${x0.praktijk_id} op ${debDatum}`);
              // SLOEL: het deel van de nieuwe houder gaat als correctie op de volgende huurnota; de oude houder krijgt geen huurnota meer, dus een eigen stuk
              if (e === "SLOEL" && d.deel === "nieuw") {
                st.push(db.prepare("insert into correctie (entiteit, praktijk_id, jaar, bedrag, omschrijving, toelichting) values (?,?,?,?,?,?)")
                  .bind(e, x0.praktijk_id, J, d.uitkomst, `Afrekening doorbelaste huur ${J} (${d.maanden} maanden na de overname)`, x0.hoe));
                continue;
              }
              const nummer = K.volgendNummer(nummers, Number(dat.slice(0, 4)));
              nummers.push(nummer);
              const rij = { ...x0, kosten: d.kosten, al_voldaan: d.al_voldaan, uitkomst: d.uitkomst, hoe: `${x0.hoe}; ${d.deel === "oud" ? `deel van de oude houder: ${d.maanden} maanden vóór de overname per ${ov.datum}` : `deel van de nieuwe houder: ${d.maanden} maanden vanaf de overname per ${ov.datum}`}` };
              const n = K.maakAfrekenNota({ entiteit: e, jaar: J, rij, nummer, datum: dat, vervaldag: verval, debiteur: deb, kosten: r.kosten, modus: r.modus                           });
              st.push(db.prepare("insert into nota (entiteit, jaar, nummer, praktijk_id, datum, vervaldag, soort, periode, titel, regels, bedrag, buffer, status, bron, debiteur, toelichting, aangemaakt_op) " +
                "values (?,?,?,?,?,?, 'afrekening', ?,?,?,?, 0, 'definitief', 'ovis-pot', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))")
                .bind(e, J, nummer, x0.praktijk_id, dat, verval, n.periode, n.titel, json(n.regels), n.bedrag, json(deb), n.toelichting));
            }
            continue;
          }
        }
        const x = x0;
        st.push(db.prepare("insert into afrekening (entiteit, jaar, praktijk_id, versie, aandeel, jaarlast_toegerekend, voorschotten, saldo, status, opmerking, jaarlast_totaal) values (?,?,?, 'ovis-pot', ?,?,?,?, 'vastgesteld', ?, ?)")
          .bind(e, J, x.praktijk_id, x.aandeel, x.kosten, x.al_voldaan, x.uitkomst, `${r.modus === "betaald" ? "tegen betaald (bank)" : "tegen gevraagd (nota's)"}; kosten ${r.kosten_status}`, r.kosten));
        if (Math.abs(x.uitkomst) < 0.005) continue;
        if (e === "SLOEL") {
          st.push(db.prepare("insert into correctie (entiteit, praktijk_id, jaar, bedrag, omschrijving, toelichting) values (?,?,?,?,?,?)")
            .bind(e, x.praktijk_id, J, x.uitkomst, `Afrekening doorbelaste huur ${J}`, x.hoe));
          continue;
        }
        const deb = K.debiteurOp(bs.versies         , x.praktijk_id, dat);
        if (!deb) throw new Fout(409, `geen praktijkgegevens (debiteur) voor ${x.praktijk_id} op ${dat}`);
        const nummer = K.volgendNummer(nummers, Number(dat.slice(0, 4)));
        nummers.push(nummer);
        const n = K.maakAfrekenNota({ entiteit: e, jaar: J, rij: x, nummer, datum: dat, vervaldag: verval, debiteur: deb, kosten: r.kosten, modus: r.modus                           });
        st.push(db.prepare("insert into nota (entiteit, jaar, nummer, praktijk_id, datum, vervaldag, soort, periode, titel, regels, bedrag, buffer, status, bron, debiteur, toelichting, aangemaakt_op) " +
          "values (?,?,?,?,?,?, 'afrekening', ?,?,?,?, 0, 'definitief', 'ovis-pot', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))")
          .bind(e, J, nummer, x.praktijk_id, dat, verval, n.periode, n.titel, json(n.regels), n.bedrag, json(deb), n.toelichting));
      }
      st.push(log(db, wie, "afrekening", `${e}/${J}`, "vastgesteld", null, { kosten: r.kosten, modus: r.modus, uitkomst: r.totaal.uitkomst }));
      await db.batch(st);
      return { ok: true };
    }
    case "herinnering": {   // fase 3: een herinnering als concept voor één open nota; de pod zet hem klaar (pod_verzoek), David verstuurt
      const id = geldigId(b.nota_id, "nota");
      const n = (await rijen                         (db, "select id, entiteit, nummer, praktijk_id, datum, vervaldag, bedrag, status, bron from nota where id=?", id))[0];
      if (!n || n.status !== "definitief" || n.bron !== "ovis-pot") throw new Fout(409, "alleen voor een vastgestelde nota uit deze app");
      if (Number(n.bedrag) <= 0) throw new Fout(409, "deze nota heeft niets te betalen");
      const open = getal(b.open, "open bedrag", { min: 0.01, max: Number(n.bedrag) + 0.01 }) ;
      if ((await rijen(db, "select 1 x from pod_verzoek where nota_id=? and status='wacht'", id)).length) throw new Fout(409, "er staat al een herinnering klaar om gemaakt te worden");
      await db.batch([db.prepare("insert into pod_verzoek (soort, nota_id, open_bedrag, gevraagd_door) values ('herinnering', ?, ?, ?)").bind(id, K.rond2(open), wie),
        log(db, wie, "pod_verzoek", `herinnering ${n.entiteit} ${n.nummer}`, "nieuw", null, { open: K.rond2(open) })]);
      return { ok: true };
    }
    case "herinnering-annuleren": {
      const id = geldigId(b.id, "verzoek");
      await db.batch([db.prepare("update pod_verzoek set status='geannuleerd', bijgewerkt_op=strftime('%Y-%m-%dT%H:%M:%SZ','now') where id=? and status='wacht'").bind(id),
        log(db, wie, "pod_verzoek", String(id), "geannuleerd", null, null)]);
      return { ok: true };
    }
    case "koppel": {   // fase 3: een betaling met de hand aan een nota koppelen (gaat vóór kenmerk en venster)
      const m = geldigId(b.bankmutatie_id, "bankpost"), n = geldigId(b.nota_id, "nota");
      const nota = (await rijen                         (db, "select entiteit, nummer, bedrag from nota where id=? and status='definitief'", n))[0];
      const post = (await rijen                         (db, "select entiteit, bedrag from bankmutatie where id=?", m))[0];
      if (!nota || !post) throw new Fout(400, "onbekende nota of bankpost");
      if (nota.entiteit !== post.entiteit) throw new Fout(400, "de bankpost hoort bij een andere entiteit dan de nota");
      const bedrag = getal(b.bedrag ?? post.bedrag, "bedrag", { min: 0.01, max: Math.abs(Number(post.bedrag)) + 0.001 }) ;
      const al = await rijen               (db, "select coalesce(sum(bedrag),0) as s from koppeling where bankmutatie_id=? and nota_id<>?", m, n);
      if (K.rond2(Number(al[0].s) + bedrag) > Math.abs(Number(post.bedrag)) + 0.004) throw new Fout(409, "die bankpost is al (deels) aan een andere nota gekoppeld");
      await db.batch([db.prepare("insert into koppeling (bankmutatie_id, nota_id, bedrag, herkomst) values (?,?,?,?) on conflict(bankmutatie_id, nota_id) do update set bedrag=excluded.bedrag, herkomst=excluded.herkomst").bind(m, n, K.rond2(bedrag), `hand ${wie}`),
        log(db, wie, "koppeling", `${m}→${nota.nummer}`, "gekoppeld", null, { bedrag: K.rond2(bedrag) })]);
      return { ok: true };
    }
    case "ontkoppel": {
      const id = geldigId(b.id, "koppeling");
      const oud = (await rijen(db, "select * from koppeling where id=?", id))[0] ?? null;
      if (!oud) throw new Fout(404, "onbekende koppeling");
      await db.batch([db.prepare("delete from koppeling where id=?").bind(id), log(db, wie, "koppeling", String(id), "ontkoppeld", oud, null)]);
      return { ok: true };
    }
    case "overname": {   // R10: nieuwe houder per datum (praktijkversie + IBAN-historie + verdeling van de afrekening), in één batch
      if (!(await legacyOpen(db))) throw new Fout(409, "nog niet: de praktijkgegevens zijn tot het overstapmoment een kopie van de datahub");
      const p = tekst(b.praktijk_id, "praktijk", { verplicht: true, max: 3 }) ;
      await bestaatPraktijk(db, p);
      const dat = datum(b.datum, "overnamedatum") ;
      const verdeling = keuze(b.verdeling ?? "maanden", "verdeling", ["maanden", "nieuwe_houder"]         );
      const v = {
        naam: tekst(b.naam, "naam", { verplicht: true, max: 120 }) , houder: tekst(b.houder, "houder", { verplicht: true, max: 160 }) ,
        tav: tekst(b.tav, "t.a.v.", { max: 120 }), adres: tekst(b.adres, "adres", { max: 160 }), postcode_plaats: tekst(b.postcode_plaats, "postcode en plaats", { max: 80 }),
        email: tekst(b.email, "e-mail", { max: 200 }), kvk: tekst(b.kvk, "kvk", { max: 12 }),
      };
      if (v.email && !/^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i.test(v.email)) throw new Fout(400, "e-mailadres ziet er niet goed uit");
      if (v.kvk && !/^\d{8}$/.test(v.kvk)) throw new Fout(400, "kvk-nummer = 8 cijfers");
      const iban = (tekst(b.iban, "IBAN", { max: 40 }) || "").replace(/\s+/g, "").toUpperCase();
      if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) throw new Fout(400, "IBAN ziet er niet goed uit");
      if ((await rijen(db, "select 1 x from praktijk_versie where praktijk_id=? and geldig_van=?", p, dat)).length) throw new Fout(409, "er is al een praktijkversie op die datum; kies een andere datum of pas die versie aan");
      const st = [
        db.prepare("insert into praktijk_versie (praktijk_id, geldig_van, naam, houder, tav, adres, postcode_plaats, email, kvk, opmerking) values (?,?,?,?,?,?,?,?,?,?)")
          .bind(p, dat, v.naam, v.houder, v.tav, v.adres, v.postcode_plaats, v.email, v.kvk, `overname per ${dat}`),
        db.prepare("insert into overname (praktijk_id, datum, verdeling, opmerking) values (?,?,?,?)").bind(p, dat, verdeling, tekst(b.opmerking, "opmerking", { max: 300 })),
      ];
      if (iban) {
        st.push(db.prepare("update praktijk_naam set geldig_tot=? where praktijk_id=? and geldig_tot is null and (geldig_van is null or geldig_van<?)").bind(plusDag(dat, -1), p, dat));
        st.push(db.prepare("insert into praktijk_naam (praktijk_id, naam, iban, geldig_van, geldig_tot, herkomst) values (?,?,?,?,null,'overname')").bind(p, v.naam, iban, dat));
      }
      st.push(log(db, wie, "overname", `${p}@${dat}`, "nieuw", null, { naam: v.naam, houder: v.houder, verdeling, iban: iban ? "nieuw" : "ongewijzigd" }));
      await db.batch(st);
      return { ok: true };
    }
    default:
      throw new Fout(404, "onbekende route");
  }
}
