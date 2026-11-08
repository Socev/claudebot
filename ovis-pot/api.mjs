// GEGENEREERD uit Socev/ovis-pot 4fd0303cb2b6440872d6405e9ab9b7858e0cc2b7 (scripts/pod-bundel.mjs); niet met de hand wijzigen.
// OVIS POT — de API (lezen en de instellingen schrijven). Los van Cloudflare, zodat de toets hem met een lokale SQLite kan draaien.
// Rekenen doet de rekenkern (kern/pot-kern.mjs) in de browser; de API levert alleen gegevens en bewaart wijzigingen.
// Elke schrijfactie is één batch (atomair) met een regel in `logboek` (wie, wat, oud → nieuw).
// Tabellen die uit `fin` komen (praktijk, praktijk_patienten, deelname) zijn pas schrijfbaar na het overstapmoment
// (instelling.overstap_fin gevuld): daarvóór is `pot` een kopie die scripts/kopieer-uit-fin.py ververst en zou een wijziging stil verdwijnen.

import * as K from "./kern/pot-kern.mjs";
import { POT_PAKKET, bewakingJaar, naspeelEntiteit } from "./kern/naspelen.mjs";

                           
                                                                                                                              
                                           
 
                                                                                                                                      

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
  const [praktijken, versies, namen, deelnames, uitzonderingen, standen, componenten, mutaties, subsidie, subsidie_totaal, tarieven, jaarlast, instelling, entiteit, rekeningen] =
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
      rijen(db, "select jaar, soort, bedrag, bron from subsidie_totaal order by jaar, soort"),
      rijen(db, "select * from inschrijftarief order by jaar"),
      rijen(db, "select entiteit, jaar, bedrag, bron, opmerking from jaarlast order by jaar, entiteit"),
      rijen(db, "select sleutel, waarde, opmerking from instelling"),
      rijen(db, "select code, naam, iban, naam_document, adres, postcode_plaats, kvk from entiteit where code in ('POT','KM','SLOEL')"),
      rijen(db, "select r.iban, r.entiteit, r.bank, (select max(boekdatum) from bankmutatie m where m.rekening=r.iban) as laatste_post from bankrekening r"),
    ]);
  const nu = (await rijen               (db, "select date('now') as d"))[0].d;
  return { vandaag: nu, praktijken, versies, namen, deelnames, uitzonderingen, standen, componenten, mutaties, subsidie, subsidie_totaal, tarieven, jaarlast, instelling, entiteit, rekeningen };
}

/** Wat er per praktijk per entiteit in jaar J is betaald (bank) en gevraagd (vastgestelde nota's). */
export async function geld(db          , j         ) {
  const J = jaar(j);
  const betaald = await rijen(db,
    "select m.entiteit, t.praktijk_id, t.soort, round(sum(t.bedrag),2) as bedrag, count(*) as n from bank_toewijzing t join bankmutatie m on m.id=t.bankmutatie_id " +
    "where t.boekjaar=? and t.praktijk_id is not null and t.soort in ('voorschot','huur','afrekening') group by 1,2,3", J);
  // extra bijdragen (wv2773, David 8-11-2026: er zijn geen leningen): wat een praktijk buiten de nota's om stortte (bank: 'liquiditeit'),
  // per boekjaar en praktijk, stortingen en terugbetalingen samen; telt in de afrekening mee vanaf K.EXTRA_BIJDRAGE_VANAF
  const extra = K.extraBijdrageTelt(J) ? await rijen(db,
    "select m.entiteit, t.praktijk_id, round(sum(t.bedrag),2) as bedrag, count(*) as n from bank_toewijzing t join bankmutatie m on m.id=t.bankmutatie_id " +
    "where t.boekjaar=? and t.praktijk_id is not null and t.soort='liquiditeit' group by 1,2", J) : [];
  // gevraagd = vastgestelde nota's van J zonder bufferopbouw (R3); van een nota uit deze app telt alleen de regel 'bijdrage'
  // (correcties en verrekeningen gaan over een ander jaar), een afrekeningsnota telt niet mee
  const gevraagd = await rijen(db,
    "select entiteit, praktijk_id, round(sum(case when bron='ovis-pot' then (select coalesce(sum(json_extract(r.value,'$.bedrag')),0) from json_each(nota.regels) r " +
    "where json_extract(r.value,'$.soort')='bijdrage') else bedrag - coalesce(buffer,0) end),2) as bedrag, count(*) as n " +
    "from nota where jaar=? and status='definitief' and soort not in ('buffer','afrekening') group by 1,2", J);
  return { jaar: J, betaald, gevraagd, extra };
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
  "subsidie", "subsidie_totaal", "inschrijftarief", "jaarlast", "medewerker", "contract", "contractmutatie", "afwezigheid", "inhuur", "cao_tabel", "loonparameter", "loonsom", "buffer",
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
    case "corrigeer": return corrigeer(db, b, wie);   // wv2788: een versie verbeteren (vergissing), logboek oud → nieuw
    case "verwijder": return verwijder(db, b, wie);   // wv2788: een per vergissing aangemaakte versie weghalen, niet als er stukken op leunen
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
    case "subsidie_totaal": {
      const J = jaar(b.jaar);
      const soort = keuze(b.soort, "soort", ["aangevraagd", "verleend", "vastgesteld", "prognose"]         );
      const bedrag = getal(b.bedrag, "bedrag", { min: 0, max: 5e7 }) ;
      const bron = tekst(b.bron, "bron", { verplicht: true, max: 300 });
      const oud = await rijen(db, "select bedrag, bron from subsidie_totaal where jaar=? and soort=?", J, soort);
      await db.batch([db.prepare("insert into subsidie_totaal (jaar, soort, bedrag, bron) values (?,?,?,?) on conflict(jaar, soort) do update set bedrag=excluded.bedrag, bron=excluded.bron")
        .bind(J, soort, bedrag, bron), log(db, wie, "subsidie_totaal", `${J}/${soort}`, oud.length ? "gewijzigd" : "nieuw", oud[0] ?? null, { bedrag, bron })]);
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
      if (pad === "naspeel") return { status: 200, body: await naspeel(db) };
      if (pad === "bewaking") return { status: 200, body: await bewaking(db, zoek.get("jaar")) };
      if (pad === "verwachting") return { status: 200, body: await verwachting(db, zoek.get("jaar")) };
      if (pad === "leunt") return { status: 200, body: await leunt(db, zoek) };
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
/**
 * Naspelen (wv2782): de systematiek zoals gebouwd op de geschiedenis — tabel `historie` (Davids begrotingen, aanvullingen,
 * eindafrekeningen, beginsaldo), de bank (alle posten met hun toewijzing), standen, deelname, kosten en de besloten buffer.
 * Alleen lezen; de kern (kern/naspelen.mjs) rekent.
 */
/** Bankposten per toewijzing: elk toegewezen deel met zijn eigen bedrag; wat van een post niet is toegewezen blijft als rest (Codex r1 M1). */
export function bankPosten(r                                                                                                                                                                   ) {
  const uit                                                                                                                                   = [];
  const toegewezen = new Map                ();
  for (const x of r) {
    if (x.deel == null) continue;
    uit.push({ entiteit: x.entiteit, datum: x.datum, bedrag: Number(x.deel), soort: x.soort, praktijk_id: x.praktijk_id, boekjaar: x.boekjaar });
    toegewezen.set(x.id, (toegewezen.get(x.id) || 0) + Number(x.deel));
  }
  const gezien = new Set        ();
  for (const x of r) {
    if (gezien.has(x.id)) continue;
    gezien.add(x.id);
    const rest = Math.round((Number(x.bedrag) - (toegewezen.get(x.id) || 0)) * 100) / 100;
    if (Math.abs(rest) > 0.004) uit.push({ entiteit: x.entiteit, datum: x.datum, bedrag: rest, soort: null, praktijk_id: null, boekjaar: null });
  }
  return uit.sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0));
}

export async function naspeel(db          ) {
  const [historie, standen, deelnames, jaarlasten, buffers, bankRuw, vandaag, inst] = await Promise.all([
    rijen                                                                                                                                                      (db,
      "select entiteit, jaar, maand, praktijk_id, categorie, bedrag, titel, bron from historie order by entiteit, jaar, categorie, maand, praktijk_id"),
    rijen(db, "select praktijk_id, peildatum, aantal from praktijk_patienten"),
    rijen(db, "select entiteit, praktijk_id, geldig_van, geldig_tot, geldt_voor from deelname"),
    rijen(db, "select entiteit, jaar, bedrag, bron, opmerking from jaarlast"),
    rijen                                                                                                  (db, "select entiteit, geldig_van, doel, opbouw_in, status from buffer order by geldig_van"),
    rijen                                                                                                                                                                 (db,
      `select b.id, b.entiteit, b.boekdatum as datum, b.bedrag, t.bedrag as deel, t.soort, t.praktijk_id, t.boekjaar from bankmutatie b
       left join bank_toewijzing t on t.bankmutatie_id = b.id order by b.boekdatum, b.id`),
    rijen               (db, "select date('now') as d"),
    rijen                                     (db, "select sleutel, waarde from instelling where sleutel='pot_jan_feb'"),
  ]);
  // POT januari zwaarder, februari evenveel lichter (wv2787): dezelfde f als in de jaarbegroting, hier op alle jaren (de systematiek zoals besloten)
  const janFeb = K.janFebWaarde(inst);
  // Tolgaarde is het vangnet (David 8-11-2026): springt bij als het saldo onder nul zou gaan (extra bijdrage, verrekend in de afrekening)
  // (instelling vangnet_praktijk gaat voor; anders de praktijk die Tolgaarde heet)
  const vangnet = (await rijen                (db, `select coalesce((select waarde from instelling where sleutel = 'vangnet_praktijk' and waarde <> ''),
    (select id from praktijk where naam = 'Tolgaarde' or naam_vorig = 'Tolgaarde' order by id limit 1)) as id`))[0]?.id || null;
  const bank = bankPosten(bankRuw);
  const begr = historie.filter((h) => h.categorie === "begroting_vooraf");
  if (!begr.length) return { ok: false, reden: "er staat nog geen historie in de databank" };
  const van = Math.min(...begr.map((h) => Number(h.jaar)));
  const tot = Math.max(van, Math.min(Number(vandaag[0].d.slice(0, 4)), Math.max(...begr.map((h) => Number(h.jaar)))));
  const entiteiten                          = {};
  const naspeelInvoer                                          = {};
  for (const E of ENT) {
    const start = historie.find((h) => h.entiteit === E && h.categorie === "beginsaldo" && Number(h.jaar) === van - 1);
    const bf = buffers.filter((b) => b.entiteit === E).at(-1) || null;
    const david = new Map                                                                                               ();
    for (const h of historie) {
      if (h.entiteit !== E || !h.categorie.startsWith("eind_") || !h.praktijk_id) continue;
      const k = `${h.jaar}/${h.praktijk_id}`;
      if (!david.has(k)) david.set(k, { jaar: Number(h.jaar), praktijk_id: h.praktijk_id, kosten: 0, betaald: 0, saldo: 0 });
      const x = david.get(k) ;
      if (h.categorie === "eind_kosten") x.kosten = Number(h.bedrag); else if (h.categorie === "eind_betaald") x.betaald = Number(h.bedrag); else x.saldo = Number(h.bedrag);
    }
    naspeelInvoer[E] = {
      entiteit: E, van, tot, standen, deelnames, jaarlasten, historie, bank: bank.filter((b) => b.entiteit === E && b.datum >= `${van}-01-01`), bankVorig: bank.filter((b) => b.entiteit === E && b.datum >= `${van - 1}-01-01` && b.datum < `${van}-01-01`),
      afrekeningDavid: [...david.values()], buffer: bf ? { doel: Number(bf.doel), opbouw_in: bf.opbouw_in, status: bf.status, geldig_van: bf.geldig_van } : null,
      vangnet, janFeb, startsaldo: start ? Number(start.bedrag) : 0, startbron: start ? start.bron : "geen beginsaldo in de historie: 0 aangenomen",
    };
    entiteiten[E] = naspeelEntiteit(naspeelInvoer[E]);
  }
  // blinde terugtoets (wv2789): dezelfde systematiek met de begroting die de app op 31-12 van het jaar ervoor zelf had gemaakt
  const blind                          = {};
  if (historie.some((h) => h.categorie === "blind_vooraf")) {
    for (const E of ENT) {
      const a = naspeelInvoer[E];
      blind[E] = naspeelEntiteit({ ...a, bron: "blind" });
    }
  }
  // de stukken zelf (één regel per stuk), zodat het scherm laat zien waar elk bedrag vandaan komt
  const stuk = new Map                                                                                                                           ();
  for (const h of historie) {
    const k = `${h.entiteit}|${h.jaar}|${h.categorie}|${h.titel}`;
    if (!stuk.has(k)) stuk.set(k, { entiteit: h.entiteit, jaar: Number(h.jaar), categorie: h.categorie, titel: h.titel, bron: h.bron, bedrag: 0, rijen: 0 });
    const x = stuk.get(k) ; x.bedrag = Math.round((x.bedrag + Number(h.bedrag)) * 100) / 100; x.rijen++;
  }
  return { ok: true, van, tot, berekend_op: vandaag[0].d, entiteiten, blind: Object.keys(blind).length ? blind : null, stukken: [...stuk.values()] };
}

/**
 * Bewaking lopend jaar (wv2793): per entiteit de kosten tot nu (bank, alleen volle maanden) tegenover de begroting, met kostenSignaal.
 * De begroting komt uit het vastgestelde jaarplan van dat jaar (grondslag.begroting: na een herziening R9 de nieuwe); zonder vastgesteld
 * jaarplan (2026 en eerder: David vroeg zelf) uit de historie (zijn begroting vooraf + aanvullingen). Bankdekking: bij een bankkoppeling
 * t/m de dag vóór de ophaaldag (instelling bank_bron_<E>), anders de laatste post (ook een post na jaar J telt). Drempel = de buffer die
 * op de peildatum geldt (de bankdekking, binnen jaar J; alleen besloten buffers, anders de laatst besloten), minstens 3 % van de begroting (Codex r1 M1). `gemeld` = wanneer de pod het signaal in de maandronde noemde (eenmalig per entiteit per jaar).
 * Alleen lezen.
 */
export async function bewaking(db          , j         ) {
  const vandaag = (await rijen               (db, "select date('now') as d"))[0].d;
  const J = j == null || j === "" ? Number(vandaag.slice(0, 4)) : jaar(j);
  const [plannen, hist, buffers, bankRuw, inst, eind] = await Promise.all([
    rijen                                                                                                        (db,
      "select entiteit, totaal, grondslag, versie, vastgesteld_op from jaarplan where jaar=? and status='vastgesteld'", J),
    rijen                                                         (db,
      "select entiteit, categorie, round(sum(bedrag),2) as bedrag from historie where jaar=? and categorie in ('begroting_vooraf','aanvulling') group by 1,2", J),
    rijen                                                                        (db, "select entiteit, geldig_van, doel, status from buffer order by geldig_van"),
    rijen                                                                                                                                                                 (db,
      `select b.id, b.entiteit, b.boekdatum as datum, b.bedrag, t.bedrag as deel, t.soort, t.praktijk_id, t.boekjaar from bankmutatie b
       left join bank_toewijzing t on t.bankmutatie_id = b.id where b.boekdatum >= ? and b.boekdatum < ? order by b.boekdatum, b.id`, `${J - 1}-01-01`, `${J + 1}-01-01`),
    rijen                                     (db, "select sleutel, waarde from instelling where sleutel like 'bank_bron_%' or sleutel like ?", `bewaking_gemeld_%_${J}`),
    rijen                                       (db, "select entiteit, max(boekdatum) as laatste from bankmutatie group by entiteit"),
  ]);
  const bank = bankPosten(bankRuw);
  const entiteiten                          = {};
  for (const E of ENT) {
    const plan = plannen.find((p) => p.entiteit === E);
    let g                                                                                               = {};
    try { g = plan ? JSON.parse(String(plan.grondslag)) : {}; } catch { g = {}; }
    const hB = hist.filter((h) => h.entiteit === E);
    const vooraf = hB.find((h) => h.categorie === "begroting_vooraf")?.bedrag || 0, aanv = hB.find((h) => h.categorie === "aanvulling")?.bedrag || 0;
    const B = plan ? Number(g.begroting?.totaal ?? plan.totaal) : vooraf + aanv;
    const bron = plan ? `jaarplan ${J} versie ${plan.versie}` : vooraf > 0 ? `jouw stukken ${J}${aanv ? " met aanvulling" : ""}` : "geen begroting";
    const pakket = E !== "POT" ? { vg: 0, ej: 0 } : plan ? { vg: Number(g.begroting?.vakantiegeld_pakket) || 0, ej: Number(g.begroting?.eindejaar_pakket) || 0 }
      : { vg: B * POT_PAKKET.vakantiegeld, ej: B * POT_PAKKET.eindejaar };
    const bf = buffers.filter((b) => b.entiteit === E);
    const laatstePost = eind.find((x) => x.entiteit === E)?.laatste || null;
    let bb                                                      = null;
    try { bb = JSON.parse(inst.find((i) => i.sleutel === `bank_bron_${E}`)?.waarde || "null"); } catch { bb = null; }
    const op = bb && bb.bron === "bankkoppeling" && typeof bb.opgehaald === "string" && DATUM.test(bb.opgehaald.slice(0, 10)) ? bb.opgehaald.slice(0, 10) : null;
    const bankTot = op ? K.plusDagen(op, -1) : null;
    const peil = [bankTot || laatstePost || vandaag, `${J}-01-01`, `${J}-12-31`].sort()[1];   // de bankdekking, binnen jaar J
    // alleen een besloten buffer: een voorstel (nog niet besloten verhoging) mag geen alarm onderdrukken (Codex r2 M1)
    const besloten = bf.filter((b) => b.status === "besloten");
    const buffer = (besloten.filter((b) => b.geldig_van <= peil).at(-1) || besloten.at(-1))?.doel || 0;
    let gemeld          = null;
    try { gemeld = JSON.parse(inst.find((i) => i.sleutel === `bewaking_gemeld_${E}_${J}`)?.waarde || "null"); } catch { gemeld = null; }
    entiteiten[E] = { ...bewakingJaar({ entiteit: E, jaar: J, begroting: B, vakantiegeld: pakket.vg, eindejaar: pakket.ej, bank: bank.filter((b) => b.entiteit === E), bankTot,
      bankEind: laatstePost, buffer, bron }),
      buffer, gemeld };
  }
  return { jaar: J, berekend_op: vandaag, entiteiten };
}

/**
 * Verwacht jaarresultaat POT (wv2800): wat de kosten van jaar J worden (loonstroken tot nu + rekenkern op het personeel uit Nmbrs, overige
 * kosten, uitkering verzuimverzekering) en wat dat per praktijk betekent bij de afrekening. Alleen informatie: maakt geen nota's.
 */
export async function verwachting(db          , j         ) {
  const vandaag = (await rijen               (db, "select date('now') as d"))[0].d;
  const J = j == null || j === "" ? Number(vandaag.slice(0, 4)) : jaar(j);
  const [b, g, gl, hist, uitk, bank] = await Promise.all([
    basis(db), jaarGegevens(db, J), geld(db, J),
    rijen                                         (db, "select praktijk_id, round(sum(bedrag),2) as bedrag from historie where entiteit='POT' and jaar=? and categorie in ('begroting_vooraf','aanvulling') and praktijk_id is not null group by 1", J),
    rijen                                            (db, "select round(coalesce(sum(t.bedrag),0),2) as bedrag, max(m.boekdatum) as laatste from bank_toewijzing t join bankmutatie m on m.id=t.bankmutatie_id where m.entiteit='POT' and t.soort='verzekering_uitkering' and m.boekdatum between ? and ?", `${J}-01-01`, `${J}-12-31`),
    rijen                            (db, "select max(boekdatum) as laatste from bankmutatie where entiteit='POT'"),
  ]);
  const lp = g.loonparameters.filter((x) => Number(x.jaar) <= J).sort((x, y) => Number(x.jaar) - Number(y.jaar)).at(-1);
  if (!lp) return { jaar: J, ok: false, reden: `geen loonparameters voor ${J} of eerder (scherm Personeel)` };
  const param = { ...lp, verdeling: typeof lp.verdeling === "string" ? JSON.parse(String(lp.verdeling)) : lp.verdeling };
  const cao = g.cao.map((t) => ({ cao: String(t.cao), ingang: String(t.ingang), schaal: String(t.schaal), trede: Number(t.trede), bruto: Number(t.bruto), uren_voltijd: Number(t.uren_voltijd) }));
  const contracten = g.contracten.map((c) => ({ ...c, naam: c.naam || `contract ${c.id}` }));
  const personeel = K.personeelJaar({ jaar: J, contracten, mutaties: g.contractmutaties, afwezigheid: g.afwezigheid, inhuur: g.inhuur, tabellen: cao, param });
  // overige kosten: de kostenposten van J (niet-personeel); zonder posten de aanname 'zoals het jaar ervoor' (jaarlast − loonkosten)
  const comps = b.componenten.filter((c) => c.entiteit === "POT" && c.soort !== "personeel");
  const begr = K.jaarbegroting({ entiteit: "POT", jaar: J, componenten: comps, mutaties: b.mutaties, personeel: null });
  let overige = { bedrag: K.rond2(begr.totaal), bron: `kostenposten ${J}` };
  if (!(begr.totaal > 0)) {
    const jl = K.kostenJaar(b.jaarlast           , "POT", J - 1);
    const lk = g.loonsom.filter((l) => Number(l.jaar) === J - 1);
    // inhuur van J−1 zit in de kosten van J−1 maar telt in J al bij het personeel: die gaat er ook af
    const inhuurVorig = K.personeelJaar({ jaar: J - 1, contracten: [], inhuur: g.inhuur, tabellen: cao, param }).inhuur;
    overige = jl && lk.length === 12
      ? { bedrag: K.rond2(jl.bedrag - lk.reduce((s, l) => s + Number(l.loonkosten), 0) - inhuurVorig), bron: `aanname: zoals ${J - 1} (kosten ${J - 1} min de loonkosten van de loonstroken${inhuurVorig ? " en de inhuur" : ""})` }
      : { bedrag: 0, bron: `onbekend: geen kostenposten ${J} en geen volledig jaar ${J - 1}` };
  }
  // aandeel zoals de afrekening (gemiddelde van 1-1-J en 1-1-(J+1)); is de stand van 1-1-(J+1) er nog niet, dan telt 1-1-J ook als eind (aanname, in beeld)
  let aandelen = K.aandelenAfrekening({ entiteit: "POT", jaar: J, standen: b.standen           , deelnames: b.deelnames            });
  let aandeelAanname = false;
  if (!aandelen.ok && aandelen.ontbreekt.every((o                       ) => o.peildatum === `${J + 1}-01-01`)) {
    const extra = (b.standen                                                                ).filter((x) => x.peildatum === `${J}-01-01`).map((x) => ({ ...x, peildatum: `${J + 1}-01-01` }));
    aandelen = K.aandelenAfrekening({ entiteit: "POT", jaar: J, standen: [...(b.standen           ), ...extra]           , deelnames: b.deelnames            });
    aandeelAanname = aandelen.ok;
  }
  // gevraagd: de nota's van J als die er zijn (vanaf de overname), anders Davids stukken (historie) — plus extra bijdragen (liquiditeit)
  const notaG = gl.gevraagd.filter((x) => x.entiteit === "POT");
  const gevraagd                         = {};
  // Davids stukken (historie, vóór de overname) en de nota's van de app (erna) dekken verschillende maanden: samen tellen
  for (const x of [...hist, ...notaG]) gevraagd[String(x.praktijk_id)] = (gevraagd[String(x.praktijk_id)] || 0) + Number(x.bedrag);
  for (const x of gl.extra.filter((x) => x.entiteit === "POT")) gevraagd[String(x.praktijk_id)] = (gevraagd[String(x.praktijk_id)] || 0) + Number(x.bedrag);
  const betaald                         = {};
  for (const x of gl.betaald.filter((x) => x.entiteit === "POT" && x.soort === "voorschot")) betaald[String(x.praktijk_id)] = (betaald[String(x.praktijk_id)] || 0) + Number(x.bedrag);
  const v = K.verwachtJaar({ jaar: J, personeel, param, loonsom: g.loonsom, overige, uitkering: Number(uitk[0]?.bedrag) || 0, aandelen, gevraagd, betaald,
    gevraagd_bron: notaG.length && hist.length ? "jouw stukken en de vastgestelde nota's" : notaG.length ? "vastgestelde nota's" : "jouw stukken (begroting en aanvullingen)" });
  // waarschuwingen over maanden van het jaar ervoor (alleen de vakantiegeldbasis van de rekenkern) doen hier niet mee
  return { ...v, berekend_op: vandaag, bank_tot: bank[0]?.laatste || null, nmbrs: g.nmbrs, aandeel_aanname: aandeelAanname ? `patiënten 1-1-${J + 1} nog niet bekend: gerekend met 1-1-${J}` : null,
    waarschuwingen: personeel.waarschuwingen.filter((w) => !w.includes(`${J - 1}-`)) };
}

/** Invoer van de pod (nmbrs-data.js 'pot'): alleen data, uren, schaal, trede, functie en namen; streng gecontroleerd. */
function nmbrsStandGeldig(x         )                                                           {
  const s = x                                             ;
  if (!s || typeof s !== "object" || typeof s.peil !== "string" || !DATUM.test(s.peil) || !Array.isArray(s.medewerkers) || s.medewerkers.length > 500) throw new Fout(400, "nmbrs: ongeldige stand");
  const d = (v         , leeg = true) => { if (v == null || v === "") { if (leeg) return null; throw new Fout(400, "nmbrs: datum ontbreekt"); } const t = String(v).slice(0, 10); if (!DATUM.test(t)) throw new Fout(400, "nmbrs: ongeldige datum"); return t; };
  const t = (v         , max = 120) => (v == null || v === "" ? null : String(v).slice(0, max));
  const lijst = (v         ) => { if (v == null) return []; if (!Array.isArray(v) || v.length > 200) throw new Fout(400, "nmbrs: ongeldige lijst"); return v                             ; };
  const id = (v         ) => { const r = String(v ?? ""); if (!/^[A-Za-z0-9-]{1,64}$/.test(r)) throw new Fout(400, "nmbrs: ongeldige id"); return r; };
  const n = (v         , min        , max        ) => (v == null || v === "" ? null : Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : null);
  return {
    peil: s.peil,
    medewerkers: (s.medewerkers                             ).map((m) => ({
      id: id(m.id), naam: t(m.naam), nummer: t(m.nummer, 20),
      dienst: lijst(m.dienst).map((x) => ({ id: id(x.id), begin: d(x.begin, false), eind: d(x.eind) })),
      contract: lijst(m.contract).map((x) => ({ begin: d(x.begin), eind: d(x.eind), onbepaald: x.onbepaald === true, aangemaakt: t(x.aangemaakt, 40) })),
      rooster: lijst(m.rooster).map((x) => ({ begin: d(x.begin), uren: n(x.uren, 0, 80), aangemaakt: t(x.aangemaakt, 40) })),
      functie: lijst(m.functie).map((x) => ({ omschrijving: t(x.omschrijving, 80), aangemaakt: t(x.aangemaakt, 40) })),
      salaris: lijst(m.salaris).map((x) => ({ begin: d(x.begin), schaal: t(x.schaal, 6), trede: n(x.trede, 0, 99), tabel: t(x.tabel, 60), aangemaakt: t(x.aangemaakt, 40) })),
    })),
  };
}

/**
 * Dagelijkse koppeling Nmbrs → personeel POT (wv2800). Alleen de pod roept dit aan (geen route): de stand komt uit nmbrs.sqlite,
 * zonder bedragen. Schrijft contracten, wijzigingen per datum en het logboek in één batch; elke update alleen als de rij nog is wat
 * de koppeling las (anders slaat hij over: een handmatige wijziging tussendoor wint). Verschillen met handmatige invoer = melding.
 * Uitkomst in instelling `nmbrs_sync` (scherm Personeel); `nieuwe_verschillen` = wat er sinds de vorige keer bij kwam (voor het bericht).
 */
export async function nmbrsSync(db          , ruweStand         , wie = K.NMBRS_WIE) {
  const stand = nmbrsStandGeldig(ruweStand);
  const [contracten, mutaties, vorigRij, nuRij] = await Promise.all([
    rijen                         (db, "select c.*, m.naam from contract c left join medewerker m on m.id=c.medewerker_id"),
    rijen                         (db, "select * from contractmutatie"),
    rijen                    (db, "select waarde from instelling where sleutel='nmbrs_sync'"),
    rijen                (db, "select strftime('%Y-%m-%dT%H:%M:%SZ','now') as nu"),
  ]);
  const plan = K.nmbrsSyncPlan({ stand, contracten, mutaties });
  const mutStand = (w                                                                        ) => JSON.stringify({ geldig_van: w.geldig_van, uren: w.uren ?? null, schaal: w.schaal ?? null, trede: w.trede ?? null });
  const st         = [];
  for (const g of plan.nieuw) {
    st.push(db.prepare("insert into medewerker (naam, opmerking) values (?, ?)").bind(g.naam || "medewerker (Nmbrs)", "uit Nmbrs"));
    st.push(db.prepare("insert into contract (medewerker_id, soort, functie, van, tot, uren, cao, schaal, trede, trede_peildatum, periodiekmaand, trede_bron, bevestigd_op, bevestigd_door, herkomst, " +
      "nmbrs_dienst, nmbrs_medewerker, nmbrs_stand, einde_bron) values ((select max(id) from medewerker), 'dienst', ?,?,?,?,?,?,?,?,?,?, case when ? is null then null else strftime('%Y-%m-%dT%H:%M:%SZ','now') end, ?, 'Nmbrs', ?,?,?,?)")
      .bind(g.functie, g.van, g.tot, g.uren, g.cao, g.schaal, g.trede, g.trede_peildatum, g.periodiekmaand, g.trede_bron, g.schaal, g.schaal == null ? null : wie,
        g.nmbrs_dienst, g.nmbrs_medewerker, JSON.stringify(Object.fromEntries(K.NMBRS_VELDEN.map((f) => [f, (g                                      )[f] ?? null]))), g.einde_bron));
    for (const w of g.mutaties) st.push(db.prepare("insert into contractmutatie (contract_id, geldig_van, uren, schaal, trede, reden, nmbrs_stand) values ((select id from contract where nmbrs_dienst=?), ?,?,?,?,?,?)")
      .bind(g.nmbrs_dienst, w.geldig_van, w.uren, w.schaal, w.trede, w.reden, mutStand(w)));
    st.push(log(db, wie, "contract", g.naam || g.nmbrs_dienst, "nieuw uit Nmbrs", null, { van: g.van, tot: g.tot, uren: g.uren, schaal: g.schaal, trede: g.trede, wijzigingen: g.mutaties.length }));
  }
  for (const u of plan.bijwerk) {
    const zet = Object.keys(u.zet);
    // alleen bijwerken als de rij nog is wat de koppeling las (een handmatige wijziging tussendoor wint)
    const waar = zet.map((f) => `${f} is ?`).join(" and ");
    const velden = [...zet.map((f) => `${f}=?`), "nmbrs_stand=?",
      ...(u.koppel ? ["nmbrs_dienst=?", "nmbrs_medewerker=?"] : []),
      ...(u.bevestig ? ["bevestigd_op=coalesce(bevestigd_op, strftime('%Y-%m-%dT%H:%M:%SZ','now'))", "bevestigd_door=coalesce(bevestigd_door, ?)"] : [])];
    const w = [...zet.map((f) => u.zet[f]), JSON.stringify(u.stand), ...(u.koppel ? [u.koppel.nmbrs_dienst, u.koppel.nmbrs_medewerker] : []), ...(u.bevestig ? [wie] : []), u.id, ...zet.map((f) => u.oud[f])];
    st.push(db.prepare(`update contract set ${velden.join(", ")} where id=?${waar ? ` and ${waar}` : ""}${u.koppel ? " and nmbrs_dienst is null" : ""}`).bind(...w));
    if (zet.length || u.koppel) st.push(log(db, wie, "contract", String(u.id), u.koppel ? "gekoppeld aan Nmbrs" : "bijgewerkt uit Nmbrs", zet.length ? u.oud : null, zet.length ? u.zet : null));
  }
  for (const m of plan.mutNieuw) {
    st.push(db.prepare("insert into contractmutatie (contract_id, geldig_van, uren, schaal, trede, reden, nmbrs_stand) values (?,?,?,?,?,?,?)").bind(m.contract_id, m.geldig_van, m.uren, m.schaal, m.trede, m.reden, mutStand(m)));
    st.push(log(db, wie, "contractmutatie", `${m.contract_id}@${m.geldig_van}`, "nieuw uit Nmbrs", null, { uren: m.uren, schaal: m.schaal, trede: m.trede }));
  }
  for (const m of plan.mutBij) {
    st.push(db.prepare("update contractmutatie set uren=?, schaal=?, trede=?, reden=?, nmbrs_stand=? where id=? and nmbrs_stand is ? and geldig_van is ? and uren is ? and schaal is ? and trede is ?")
      .bind(m.nieuw.uren, m.nieuw.schaal, m.nieuw.trede, m.nieuw.reden, mutStand(m.nieuw), m.id, m.oud.nmbrs_stand ?? null, m.oud.geldig_van ?? null, m.oud.uren ?? null, m.oud.schaal ?? null, m.oud.trede ?? null));
    st.push(log(db, wie, "contractmutatie", `${m.contract_id}@${m.oud.geldig_van}`, "bijgewerkt uit Nmbrs", { uren: m.oud.uren, schaal: m.oud.schaal, trede: m.oud.trede }, { uren: m.nieuw.uren, schaal: m.nieuw.schaal, trede: m.nieuw.trede }));
  }
  for (const m of plan.mutWeg) {
    st.push(db.prepare("delete from contractmutatie where id=? and nmbrs_stand is ? and geldig_van is ? and uren is ? and schaal is ? and trede is ?")
      .bind(m.id, m.oud.nmbrs_stand ?? null, m.oud.geldig_van ?? null, m.oud.uren ?? null, m.oud.schaal ?? null, m.oud.trede ?? null));
    st.push(log(db, wie, "contractmutatie", `${m.contract_id}@${m.oud.geldig_van}`, "weg (niet meer in Nmbrs)", { uren: m.oud.uren, schaal: m.oud.schaal, trede: m.oud.trede }, null));
  }
  let vorig                                                                                   = null;
  try { vorig = JSON.parse(vorigRij[0]?.waarde || "null"); } catch { vorig = null; }
  const sleutel = (v                                                       ) => `${v.contract_id}|${v.veld}|${JSON.stringify(v.nmbrs)}`;
  const oudS = new Set((vorig?.verschillen || []).map(sleutel));
  const nieuweVerschillen = plan.verschillen.filter((v) => !oudS.has(sleutel(v)));
  const uitkomst = { op: nuRij[0].nu, peil: stand.peil, medewerkers: stand.medewerkers.length, dienstverbanden: plan.gewenst, nieuw: plan.nieuw.length,
    bijgewerkt: plan.bijwerk.filter((u) => Object.keys(u.zet).length || u.koppel).length, gekoppeld: plan.bijwerk.filter((u) => u.koppel).length,
    wijzigingen: { nieuw: plan.mutNieuw.length, bijgewerkt: plan.mutBij.length, weg: plan.mutWeg.length }, verschillen: plan.verschillen, meldingen: plan.meldingen };
  st.push(db.prepare("insert into instelling (sleutel, waarde, opmerking) values ('nmbrs_sync', ?, 'laatste koppeling Nmbrs → personeel POT (wv2800): aantallen, verschillen met handmatige invoer, meldingen; geen bedragen') " +
    "on conflict(sleutel) do update set waarde=excluded.waarde").bind(JSON.stringify(uitkomst)));
  await db.batch(st);
  return { ok: true, ...uitkomst, nieuwe_verschillen: nieuweVerschillen };
}

export async function jaarGegevens(db          , j         ) {
  const J = jaar(j);
  const [contracten, contractmutaties, afwezigheid, inhuur, cao, loonparameters, loonsom, buffers, bufferGevraagd, spreiding,
    jaarplannen, regels, notas, correcties, ronde] = await Promise.all([
    rijen(db, "select c.*, m.naam from contract c left join medewerker m on m.id=c.medewerker_id order by c.soort, m.naam, c.van"),
    rijen(db, "select * from contractmutatie order by contract_id, geldig_van"),
    rijen(db, "select * from afwezigheid order by van"),
    rijen(db, "select * from inhuur order by van"),
    rijen(db, "select cao, ingang, schaal, trede, bruto, uren_voltijd from cao_tabel order by cao, ingang, schaal, trede"),
    rijen(db, "select * from loonparameter order by jaar"),
    rijen(db, "select * from loonsom order by jaar, maand"),
    rijen(db, "select * from buffer order by entiteit, geldig_van"),
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
  let nmbrs          = null;
  try { nmbrs = JSON.parse((await rijen                    (db, "select waarde from instelling where sleutel='nmbrs_sync'"))[0]?.waarde || "null"); } catch { nmbrs = null; }
  return { jaar: J, contracten, contractmutaties, afwezigheid, inhuur, cao, loonparameters, loonsom, buffers, bufferGevraagd, spreiding, jaarplannen, regels, notas, correcties, ronde, nmbrs };
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
      // opbouw in gekozen maanden (wv2770/wv2773), bv. "1,7"; leeg = in opbouw_maanden gelijke delen vanaf januari
      const inRuw = tekst(b.opbouw_in, "opbouw in maanden", { max: 40 }) || "";
      const opIn = inRuw ? K.bufferMaanden(inRuw) : null;
      if (inRuw && !opIn) throw new Fout(400, "opbouw in maanden: maandnummers 1–12, met komma's (bv. 1,7)");
      const opbouwIn = opIn ? opIn.join(",") : null;
      const status = keuze(b.status ?? "voorstel", "status", ["voorstel", "besloten"]         );
      const oud = (await rijen(db, "select * from buffer where entiteit=? and geldig_van=?", e, van))[0] ?? null;
      await db.batch([db.prepare("insert into buffer (entiteit, geldig_van, doel, opbouw_maanden, opbouw_in, status, opmerking) values (?,?,?,?,?,?,?) on conflict(entiteit, geldig_van) do update set doel=excluded.doel, opbouw_maanden=excluded.opbouw_maanden, opbouw_in=excluded.opbouw_in, status=excluded.status, opmerking=excluded.opmerking")
        .bind(e, van, doel, mnd, opbouwIn, status, tekst(b.opmerking, "opmerking", { max: 300 })), log(db, wie, "buffer", `${e}@${van}`, oud ? "gewijzigd" : "nieuw", oud, { doel, opbouw_maanden: mnd, opbouw_in: opbouwIn, status })]);
      return { ok: true };
    }
    case "jan-feb": {   // POT: januari + f × jaarbegroting, februari evenveel minder (wv2787); invoer in procenten, 0 = uit
      const f = Math.round(getal(b.procent, "procent", { min: 0, max: K.JAN_FEB.max * 100 })  * 100) / 10000;
      const oud = await rijen                    (db, "select waarde from instelling where sleutel='pot_jan_feb'");
      await db.batch([db.prepare("insert into instelling (sleutel, waarde, opmerking) values ('pot_jan_feb', ?, ?) on conflict(sleutel) do update set waarde=excluded.waarde")
        .bind(String(f), `POT: januari + deze fractie van de jaarbegroting, februari evenveel minder (vanaf ${K.JAN_FEB.vanaf}; wv2787)`),
        log(db, wie, "instelling", "pot_jan_feb", oud.length ? "gewijzigd" : "nieuw", oud[0]?.waarde ?? null, String(f))]);
      return { ok: true };
    }
    case "notadag": {   // wanneer de maandnota's van een entiteit komen (wv2795): 1 = de 1e van de maand zelf, 2–28 = die dag van de maand ervoor
      const e = keuze(b.entiteit, "entiteit", ENT);
      const dag = getal(b.dag, "dag", { min: K.NOTADAG.min, max: K.NOTADAG.max }) ;
      if (!Number.isInteger(dag)) throw new Fout(400, `dag = ${K.NOTADAG.min}–${K.NOTADAG.max}`);
      const oud = await rijen                    (db, "select waarde from instelling where sleutel=?", `notadag_${e}`);
      await db.batch([db.prepare("insert into instelling (sleutel, waarde, opmerking) values (?,?,?) on conflict(sleutel) do update set waarde=excluded.waarde")
        .bind(`notadag_${e}`, String(dag), `${e}: maandnota's ${dag === 1 ? "op de 1e van de maand zelf" : `op de ${dag}e van de maand ervoor`} (wv2795)`),
        log(db, wie, "instelling", `notadag_${e}`, oud.length ? "gewijzigd" : "nieuw", oud[0]?.waarde ?? null, String(dag))]);
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
        patroon: { gewoon: r.patroon.gewoon, januari: r.patroon.januari, februari: r.patroon.februari, jan_feb: r.patroon.jan_feb, mei: r.patroon.mei, november: r.patroon.november, hoe: r.patroon.hoe, afronding: r.patroon.afronding },
        aandelen: { uitleg: r.aandelen.uitleg, noemer: r.aandelen.noemer },
        buffer: r.buffer ? { doel: r.buffer.doel, status: r.buffer_instelling?.status, opbouw_in: r.buffer.opbouw_in } : null,
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
      // welke entiteiten (leeg = alle drie; de pod vraagt per entiteit op haar eigen notadag, wv2795)
      const alleen = b.entiteiten == null ? [...ENT] : Array.isArray(b.entiteiten) ? b.entiteiten.map((x         ) => keuze(x, "entiteit", ENT)) : (() => { throw new Fout(400, "entiteiten = lijst"); })();
      // notadatum: opgegeven, anders volgens de notadag van de entiteit (standaard de 25e van de maand ervoor; januari de 1e); vervaldag: opgegeven,
      // anders de 15e en minstens 14 dagen na de notadatum (wv2795)
      const instRij = await rijen                                     (db, "select sleutel, waarde from instelling where sleutel = 'notadag' or sleutel in ('notadag_POT', 'notadag_KM', 'notadag_SLOEL')");
      const vanaf = await overnameVanaf(db);
      const datumVan                         = {}, vervalVan                         = {};
      for (const e of alleen) {
        const dat = datum(b.datum ?? K.notaDatumVoor(J, m, K.notaDag(instRij, e)), "notadatum") ;
        if (dat < vanaf) throw new Fout(409, `nota's maakt de app pas vanaf ${vanaf}; ${J < 2027 ? "2026 vroeg David zelf" : "eerder niet"}`);
        const verval = datum(b.vervaldag ?? K.vervaldagVoor(J, m, dat), "vervaldag") ;
        if (verval < dat) throw new Fout(400, "vervaldag ligt vóór de notadatum");
        datumVan[e] = dat; vervalVan[e] = verval;
      }
      const d = await planInvoer(db, J);
      // alle onverrekende tegoeden (afrekeningsnota's 'u krijgt terug'), ongeacht het jaar (Codex M2)
      const tegoeden = await rijen(db, "select id, entiteit, praktijk_id, nummer, bedrag, verrekend, datum from nota where soort='afrekening' and status='definitief' and bedrag<0 and -bedrag-verrekend>0.004");
      const st         = [];
      const gemaakt           = [];
      const token = `aanvraag:${crypto.randomUUID()}`;   // koppelt invoegen, neveneffecten en controle aan deze aanvraag (Codex r3 M1)
      for (const e of alleen) {
        const plan = (d.jaarplannen                             ).find((p) => p.entiteit === e && p.status === "vastgesteld");
        if (!plan) continue;
        const dat = datumVan[e], verval = vervalVan[e];
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
          // de houder van de maand zelf (R10: overname op of vóór de 15e → nieuwe houder), ook als de nota eerder komt (de 25e ervoor, wv2795)
          const peil = K.debiteurPeil(J, m);
          const deb = K.debiteurOp(d.versies         , pid, peil);
          if (!deb) throw new Fout(409, `geen praktijkgegevens (debiteur) voor ${pid} op ${peil}: vul eerst een praktijkversie in`);
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
      const voldaanVoorZonderExtra = async (pid        , grens        ) => {
        if (r.modus === "betaald") {
          const q = await rijen               (db, "select coalesce(sum(t.bedrag),0) as s from bank_toewijzing t join bankmutatie m on m.id=t.bankmutatie_id where m.entiteit=? and t.praktijk_id=? and t.boekjaar=? and t.soort in ('voorschot','huur') and m.boekdatum<?", e, pid, J, grens);
          return Number(q[0].s);
        }
        const q = await rijen               (db, "select coalesce(sum(case when bron='ovis-pot' then (select coalesce(sum(json_extract(x.value,'$.bedrag')),0) from json_each(nota.regels) x where json_extract(x.value,'$.soort')='bijdrage') else bedrag - coalesce(buffer,0) end),0) as s " +
          "from nota where entiteit=? and praktijk_id=? and jaar=? and status='definitief' and soort not in ('buffer','afrekening') and datum<?", e, pid, J, grens);
        return Number(q[0].s);
      };
      // plus extra bijdragen vóór de grens (wv2773: er zijn geen leningen; vanaf K.EXTRA_BIJDRAGE_VANAF)
      const voldaanVoor = async (pid        , grens        ) => Number(await voldaanVoorZonderExtra(pid, grens)) + (K.extraBijdrageTelt(J) ? Number((await rijen               (db,
        "select coalesce(sum(t.bedrag),0) as s from bank_toewijzing t join bankmutatie m on m.id=t.bankmutatie_id where m.entiteit=? and t.praktijk_id=? and t.boekjaar=? and t.soort='liquiditeit' and m.boekdatum<?", e, pid, J, grens))[0].s) : 0);
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

// =====================================================================================================================
// CORRIGEREN EN VERWIJDEREN (wv2788, David 8-11-2026). Naast "nieuwe versie per datum" (er verandert echt iets per een datum) kan elke
// versie van een instelling gecorrigeerd worden (een vergissing verbeteren; logboek oud → nieuw) of verwijderd (per vergissing
// aangemaakt; logboek met wat er stond). Verwijderen weigert zolang er stukken op leunen: nota's (ook de oude uit de factuurgenerator),
// een vastgesteld jaarplan of een vastgestelde afrekening; dan legt de app in gewone taal uit waarom. Om dezelfde reden is de periode
// (datum) van zo'n versie niet te corrigeren; een bedrag of tekst wel, met de waarschuwing dat de stukken die er al zijn niet meeveranderen.
// De controle zit ook in de schrijfopdracht zelf (not exists), zodat een nota die tussen kijken en bewaren ontstaat niets laat verdwijnen.
// =====================================================================================================================
                                   
                                            
const OPEN = "9999-12-31";
const BEGIN = "0000-01-01";
const jr = (d        ) => Number(String(d).slice(0, 4));
const dagVoor = (d        ) => plusDag(d, -1);
const NOTA_TELT = "status not in ('vervallen','geannuleerd','concept')";

/**
 * Nota's in een periode (alle bronnen: ook de oude nota's leunen op de gegevens van toen). Een afrekeningsnota telt op het jaar waar hij
 * over gaat (nota.jaar), ook als hij pas het jaar erna gedateerd is (Codex r3).
 */
function fNota(o                                                                                                  )       {
  return {
    sql: `select 'nota' as soort, entiteit || ' nota ' || nummer || ' van ' || datum as wat from nota where ${NOTA_TELT} ` +
      "and ((datum >= ? and datum <= ?) or (soort = 'afrekening' and jaar between ? and ?))" +
      (o.entiteit ? " and entiteit = ?" : "") + (o.praktijk ? " and praktijk_id = ?" : "") + (o.extra ? ` and ${o.extra}` : ""),
    w: [o.van, o.tot, jr(o.van), jr(o.tot), ...(o.entiteit ? [o.entiteit] : []), ...(o.praktijk ? [o.praktijk] : [])],
  };
}
/** Vastgestelde jaarplannen (met praktijk: alleen als die praktijk erin staat). */
function fPlan(entiteit               , jVan        , jTot        , praktijk         )       {
  return {
    sql: "select 'jaarplan' as soort, 'het vastgestelde jaarplan ' || p.entiteit || ' ' || p.jaar as wat from jaarplan p where p.status = 'vastgesteld' and p.jaar between ? and ?" +
      (entiteit ? " and p.entiteit = ?" : "") + (praktijk ? " and exists (select 1 from jaarplan_regel r where r.jaarplan_id = p.id and r.praktijk_id = ?)" : ""),
    w: [jVan, jTot, ...(entiteit ? [entiteit] : []), ...(praktijk ? [praktijk] : [])],
  };
}
/** Vastgestelde afrekeningen (ook die uit Davids Excel). */
function fAfr(entiteit               , jVan        , jTot        , praktijk         )       {
  return {
    sql: "select distinct 'afrekening' as soort, 'de vastgestelde afrekening ' || entiteit || ' ' || jaar as wat from afrekening where status = 'vastgesteld' and jaar between ? and ?" +
      (entiteit ? " and entiteit = ?" : "") + (praktijk ? " and praktijk_id = ?" : ""),
    w: [jVan, jTot, ...(entiteit ? [entiteit] : []), ...(praktijk ? [praktijk] : [])],
  };
}
const unie = (f        )              => (f.length ? { sql: f.map((x) => `select soort, wat from (${x.sql})`).join(" union all "), w: f.flatMap((x) => x.w) } : null);
async function stukkenVan(db          , f        ) {
  const u = unie(f);
  return u ? rijen                                (db, `select distinct soort, wat from (${u.sql}) order by soort, wat limit 400`, ...u.w) : [];
}
/** where-aanvulling: alleen als er (nog steeds) niets op leunt */
const vrijVan = (f        )       => { const u = unie(f); return u ? { sql: ` and not exists (select 1 from (${u.sql}))`, w: u.w } : { sql: "", w: [] }; };
/** Stukken in gewone taal: "3 nota's (POT nota 2026-01 van 2026-01-01 … 2026-03 van 2026-03-01) en het vastgestelde jaarplan POT 2027" */
export function stukkenTekst(st                                  )         {
  const notas = st.filter((x) => x.soort === "nota").map((x) => x.wat).sort((a, b) => (a.slice(-10) < b.slice(-10) ? -1 : 1));
  const rest = st.filter((x) => x.soort !== "nota").map((x) => x.wat);
  const delen           = [];
  if (notas.length === 1) delen.push(notas[0]);
  else if (notas.length > 1) delen.push(`${notas.length} nota's (de eerste ${notas[0]}, de laatste ${notas.at(-1)})`);
  delen.push(...rest);
  return delen.length <= 1 ? delen.join("") : `${delen.slice(0, -1).join(", ")} en ${delen.at(-1)}`;
}

/** Waarde uit de invoer, of de oude als het veld niet is meegestuurd. */
const of =     (b        , k        , oud     , f                   )              => (b[k] === undefined ? oud[k] : f(b[k]));
const gelijk = (a         , c         ) => JSON.stringify(a ?? null) === JSON.stringify(c ?? null) || (typeof a === "number" && typeof c === "number" && Math.abs(a - c) < 1e-9);
async function volgende(db          , sql        , ...w           )                         {
  return (await rijen                      (db, sql, ...w))[0]?.d ?? null;
}
const periodeTot = (volgendeVan               ) => (volgendeVan ? dagVoor(volgendeVan) : OPEN);

                                                              // onderdelen die met de hoofdregel meegaan (in het logboek bewaard)
                 
                                                                          
                
                                                                                             
                                                                                  
                                                                                                                          
                                                                
                                                           
                                                                                               
                                                                                                                                          
                                                                                                                                                        
                                                          
                    
                                                                                                                           
                                                                                                                         
                                                                                                            
                                                                                                                                                          
                                                                                                                                               
                                                                                                         
                                                                                                                     
                                                                                                            
                                                   
                                                                                                                                                                                                                                               
 
const setSql = (velden          ) => velden.map((k) => `${k} = ?`).join(", ");
/** De rij zoals hij gelezen is (sleutel + alle te corrigeren kolommen): een correctie of verwijdering slaat niets over een tussentijdse wijziging heen. */
const zoalsGelezen = (s       , r     )       => {
  const w = s.waar(r), x = s.matchExtra?.(r) || { sql: "", w: [] };
  return { sql: w.sql + s.kol.map((k) => ` and ${k} is ?`).join("") + x.sql, w: [...w.w, ...s.kol.map((k) => r[k] ?? null), ...x.w] };
};
const stempelKol = (s       ) => [...s.kol, ...(s.extraKol || [])];
const stempel = (s       , r     ) => K.versieVan(stempelKol(s).map((k) => r[k] ?? null));
/**
 * Cao-keten (Codex r11): schaal en trede gelden vanaf het contract en worden per wijziging overschreven (leeg = erft de vorige).
 * Na een correctie of verwijdering moet elke combinatie die daardoor geldt in de cao-tabel staan, ook bij latere wijzigingen.
 */
async function caoKeten(db          , contractId         , opties                                                  ) {
  const c = opties.contract || (await rijen     (db, "select * from contract where id = ?", contractId))[0];
  if (!c) return;
  let mut = await rijen     (db, "select * from contractmutatie where contract_id = ? order by geldig_van", contractId);
  if (opties.weg != null) mut = mut.filter((m) => m.id !== opties.weg);
  if (opties.mutatie) mut = mut.map((m) => (m.id === opties.mutatie .id ? { ...m, ...opties.mutatie } : m)).sort((a, b) => (String(a.geldig_van) < String(b.geldig_van) ? -1 : 1));
  let schaal = c.schaal ?? null, trede = c.trede ?? null;
  const toets = async (wanneer        ) => {
    if (schaal != null && trede != null && !(await rijen(db, "select 1 x from cao_tabel where cao = ? and schaal = ? and trede = ?", c.cao, schaal, trede)).length)
      throw new Fout(400, `schaal ${schaal} met trede ${trede} (${wanneer}) staat niet in de cao-tabellen`);
  };
  await toets("bij de start van het contract");
  for (const m of mut) {
    if (m.schaal != null) schaal = m.schaal;
    if (m.trede != null) trede = m.trede;
    if (m.schaal != null || m.trede != null) await toets(`vanaf ${m.geldig_van}`);
  }
}
/** Contract-schaal/trede en alle wijzigingen ervan, als voorwaarde (Codex r12): de cao-keten die getoetst is, is de keten die blijft. */
async function caoKetenVast(db          , contractId         )                {
  const fp = "(select group_concat(json_array(id, geldig_van, schaal, trede), '|') from (select id, geldig_van, schaal, trede from contractmutatie where contract_id = ? order by id))";
  const ct = "(select json_array(schaal, trede) from contract where id = ?)";
  const nu = (await rijen                            (db, `select ${fp} as f, ${ct} as c`, contractId, contractId))[0];
  return { sql: ` and ${fp} is ? and ${ct} is ?`, w: [contractId, nu?.f ?? null, contractId, nu?.c ?? null] };
}
const CONTRACT_KOL = ["functie", "soort", "van", "tot", "uren", "schaal", "trede", "periodiekmaand"];
/** Voorwaarde: de periodegrens is nog dezelfde als bij het kijken (anders klopt de gecontroleerde periode niet meer). */
async function grensVast(db          , s       , r     , oud      )                {
  if (!s.grens) return { sql: "", w: [] };
  const g = s.grens(r, oud);
  const nu = (await rijen                (db, `select (${g.sql}) as g`, ...g.w))[0]?.g ?? null;
  return { sql: ` and (${g.sql}) is ?`, w: [...g.w, nu] };
}
/** Voorwaarde: de onderdelen die meegaan zijn nog precies zoals bij het kijken (geen tussentijds toegevoegd bedrag dat ongezien verdwijnt). */
// per onderdeel: de vingerafdruk in SQL (voorwaarde in de batch) en het stempel van de rijen zelf (dat het scherm uit wat het toont kan narekenen)
async function kinderenVast(db          , s       , r     )                                          {
  const uit                                 = [];
  for (const k of s.kinderen || []) {
    const fp = `(select group_concat(json_array(${k.kol.join(", ")}), '|') from (select ${k.kol.join(", ")} from ${k.tabel} where ${k.fk} = ? order by id))`;
    const nu = (await rijen                (db, `select ${fp} as f`, r.id))[0]?.f ?? null;
    const rij = await rijen     (db, `select ${k.kol.join(", ")} from ${k.tabel} where ${k.fk} = ? order by id`, r.id);
    uit.push({ sql: ` and ${fp} is ?`, w: [r.id, nu], stempel: K.versieVan(rij.map((x) => k.kol.map((c) => x[c] ?? null))) });
  }
  return uit;
}
/** Grens en onderdelen lezen vóór én na de stukkencontrole: zo horen voorwaarde en gecontroleerde periode bij hetzelfde moment (Codex r5). */
async function zelfdeMoment   (lees                       , controle                  )                                    {
  const voor = await lees();
  const uit = await controle();
  const na = await lees();
  const vorm = (l        ) => JSON.stringify(l.map((x) => [x.w, (x                        ).stempel ?? null]));
  if (vorm(voor) !== vorm(na)) throw new Fout(409, "Er veranderde intussen iets aan deze versie of de versie erna. Herlaad de pagina en kijk opnieuw.");
  return { voor, uit };
}
const samen = (...f        )       => ({ sql: f.map((x) => x.sql).join(""), w: f.flatMap((x) => x.w) });
const POT_PERIODE = (van        , tot        ) => [fNota({ entiteit: "POT", van, tot }), fPlan("POT", jr(van), jr(tot)), fAfr("POT", jr(van), jr(tot))];
const pctVeld = (v         , naam        ) => (v == null || v === "" ? 0 : pct(v, naam));
const ID = (r     )       => ({ sql: "id = ?", w: [r.id] });

const SOORTEN                        = {
  "praktijk-versie": {
    naam: "praktijkversie", tabel: "praktijk_versie", periode: ["geldig_van"],
    lees: async (db, s) => (await rijen(db, "select * from praktijk_versie where id = ?", geldigId(s, "versie")))[0] ?? null,
    sleutel: (r) => String(r.id),
    grens: (r) => ({ sql: "select min(geldig_van) from praktijk_versie where praktijk_id = ? and geldig_van > ? and id <> ?", w: [r.praktijk_id, r.geldig_van, r.id] }),
    async stukken(db, r) {
      const vg = await volgende(db, "select min(geldig_van) as d from praktijk_versie where praktijk_id = ? and geldig_van > ? and id <> ?", r.praktijk_id, r.geldig_van, r.id);
      return [fNota({ praktijk: String(r.praktijk_id), van: String(r.geldig_van), tot: periodeTot(vg) }),
        { sql: `select 'nota' as soort, entiteit || ' nota ' || nummer || ' van ' || datum as wat from nota where ${NOTA_TELT} and json_extract(debiteur, '$.versie_id') = ?`, w: [r.id] }];
    },
    async velden(_db, b, o) {
      const v      = {
        geldig_van: of(b, "geldig_van", o, (x) => datum(x, "geldig vanaf")), naam: of(b, "naam", o, (x) => tekst(x, "naam", { verplicht: true, max: 120 })),
        houder: of(b, "houder", o, (x) => tekst(x, "houder", { max: 160 })), tav: of(b, "tav", o, (x) => tekst(x, "t.a.v.", { max: 120 })),
        adres: of(b, "adres", o, (x) => tekst(x, "adres", { max: 160 })), postcode_plaats: of(b, "postcode_plaats", o, (x) => tekst(x, "postcode en plaats", { max: 80 })),
        email: of(b, "email", o, (x) => tekst(x, "e-mail", { max: 200 })), kvk: of(b, "kvk", o, (x) => tekst(x, "kvk", { max: 12 })),
        opmerking: of(b, "opmerking", o, (x) => tekst(x, "opmerking", { max: 400 })),
      };
      if (!v.naam) throw new Fout(400, "naam ontbreekt");
      if (v.email && !EXACT.test(String(v.email))) throw new Fout(400, "e-mailadres ziet er niet goed uit");
      if (v.kvk && !/^\d{8}$/.test(String(v.kvk))) throw new Fout(400, "kvk-nummer = 8 cijfers");
      return v;
    },
    kol: ["geldig_van", "naam", "houder", "tav", "adres", "postcode_plaats", "email", "kvk", "opmerking"], waar: ID,
    async datumBlok(db, r) {
      return (await rijen(db, "select 1 x from overname where praktijk_id = ? and datum = ?", r.praktijk_id, r.geldig_van)).length
        ? "Deze versie hoort bij een overname (met de IBAN en de verdeling van de afrekening op dezelfde datum); de datum is daarom niet los te corrigeren. Vraag het de machinekamer." : null;
    },
    // de overnameblokkade ook in de schrijfopdracht zelf: een tussentijds vastgelegde overname laat de batch niets doen (Codex r13)
    wegVoorwaarde: (r) => ({ sql: " and (select count(*) from praktijk_versie where praktijk_id = ?) > 1 and not exists (select 1 from overname where praktijk_id = ? and datum = ?)",
      w: [r.praktijk_id, r.praktijk_id, r.geldig_van] }),
    corrigeerVoorwaarde: (o, n) => o.geldig_van === n.geldig_van ? { sql: "", w: [] }
      : { sql: " and not exists (select 1 from overname where praktijk_id = ? and datum = ?)", w: [o.praktijk_id, o.geldig_van] },
    async blok(db, r) {
      const n = (await rijen               (db, "select count(*) as n from praktijk_versie where praktijk_id = ?", r.praktijk_id))[0].n;
      if (n <= 1) return "Dit is de enige versie van deze praktijk; een praktijk heeft altijd gegevens nodig. Corrigeer hem met Bewerken.";
      if ((await rijen(db, "select 1 x from overname where praktijk_id = ? and datum = ?", r.praktijk_id, r.geldig_van)).length)
        return "Deze versie hoort bij een overname (met de IBAN en de verdeling van de afrekening). Die gaat niet met één knop weg; vraag het de machinekamer.";
      return null;
    },
    async na(db, r, oud) {
      if (!(await legacyOpen(db))) return [];
      // de huidige stand in `praktijk` (de pod leest daar naam_brief/email) volgt de versie die vandaag geldt, net als bij een nieuwe versie
      const nu = "(select %s from praktijk_versie v where v.praktijk_id = praktijk.id and v.geldig_van <= date('now') order by v.geldig_van desc limit 1)";
      const k = (c        ) => nu.replace("%s", c);
      return [{ sql: `update praktijk set naam_brief = ${k("naam")}, tav = ${k("tav")}, adres = ${k("adres")}, postcode_plaats = ${k("postcode_plaats")}, ` +
        // e-mail: die van de versie die nu geldt; heeft die er geen, dan blijft het oude adres alleen staan als het níet van de weggehaalde of
        // gecorrigeerde versie kwam (anders gingen nota's naar de ontvanger van een versie die er niet meer is; Codex r11)
        `email = coalesce(${k("email")}, case when email is ? then null else email end), eigenaar = coalesce(${k("houder")}, eigenaar) where id = ? and exists ${k("1")}`,
        w: [oud.email ?? null, r.praktijk_id] }];
    },
  },
  stand: {
    naam: "patiëntenstand", tabel: "praktijk_patienten", fin: true, periode: ["peildatum"],
    lees: async (db, s) => (await rijen(db, "select id, praktijk_id, peildatum, aantal, status, opgegeven_door, bron_tekst from praktijk_patienten where id = ?", geldigId(s, "stand")))[0] ?? null,
    sleutel: (r) => String(r.id),
    async stukken(_db, r) {
      // de stand per 1-1-J telt voor de bijdragen van J (jaarplan, maandnota's) en voor de afrekeningen (ook de nota's) van J−1 en J (gemiddelde van twee jaren);
      // de aandelen van álle praktijken hangen ervan af, dus elke nota telt
      const Y = jr(String(r.peildatum));
      return [{ sql: `select 'nota' as soort, entiteit || ' nota ' || nummer || ' van ' || datum as wat from nota where ${NOTA_TELT} and (jaar = ? or (jaar = ? and soort = 'afrekening'))`, w: [Y, Y - 1] },
        fPlan(null, Y, Y), fAfr(null, Y - 1, Y)];
    },
    async velden(_db, b, o) {
      const aantal = of(b, "aantal", o, (x) => getal(x, "aantal", { min: 0, max: 100000 }));
      if (!Number.isInteger(Number(aantal))) throw new Fout(400, "aantal = heel getal");
      return { peildatum: of(b, "peildatum", o, (x) => datum(x, "peildatum")), aantal, status: of(b, "status", o, (x) => keuze(x || "definitief", "status", ["voorlopig", "definitief"]         )),
        opgegeven_door: of(b, "opgegeven_door", o, (x) => tekst(x, "opgegeven door", { max: 120 })), bron_tekst: of(b, "bron_tekst", o, (x) => tekst(x, "bron", { max: 300 })) };
    },
    kol: ["peildatum", "aantal", "status", "opgegeven_door", "bron_tekst"], waar: ID,
  },
  deelname: {
    naam: "deelname", tabel: "deelname", fin: true, periode: ["geldig_van", "geldig_tot", "geldt_voor"],
    lees: async (db, s) => (await rijen(db, "select id, entiteit, praktijk_id, geldig_van, geldig_tot, geldt_voor, regel from deelname where id = ?", geldigId(s, "deelname")))[0] ?? null,
    sleutel: (r) => String(r.id),
    async stukken(_db, r) {
      // de deelname bepaalt de verdeling over álle praktijken van de entiteit: elk stuk van die entiteit in de periode telt (Codex r4)
      const van = String(r.geldig_van || BEGIN), tot = String(r.geldig_tot || OPEN), e = String(r.entiteit);
      return [fNota({ entiteit: e, van, tot }), fAfr(e, jr(van), jr(tot)), fPlan(e, jr(van), jr(tot))];
    },
    async velden(db, b, o) {
      const v      = { geldig_van: of(b, "geldig_van", o, (x) => datum(x, "vanaf", false)), geldig_tot: of(b, "geldig_tot", o, (x) => datum(x, "tot en met", false)),
        geldt_voor: of(b, "geldt_voor", o, (x) => keuze(x || "beide", "geldt voor", ["beide", "bijdrage", "afrekening"]         )), regel: of(b, "regel", o, (x) => tekst(x, "regel", { max: 200 })) };
      if (v.geldig_tot && v.geldig_van && String(v.geldig_tot) < String(v.geldig_van)) throw new Fout(400, "tot en met ligt vóór vanaf");
      const overlap = await rijen(db, "select id from deelname where entiteit = ? and praktijk_id = ? and id <> ? and (geldig_tot is null or ? is null or geldig_tot >= ?) " +
        "and (geldig_van is null or ? is null or geldig_van <= ?) and (geldt_voor = 'beide' or ? = 'beide' or geldt_voor = ?)",
        o.entiteit, o.praktijk_id, o.id, v.geldig_van, v.geldig_van, v.geldig_tot, v.geldig_tot, v.geldt_voor, v.geldt_voor);
      if (overlap.length) throw new Fout(409, "die periode overlapt een andere deelname van deze praktijk");
      return v;
    },
    corrigeerVoorwaarde: (o, n) => ({ sql: " and not exists (select 1 from deelname d2 where d2.entiteit = ? and d2.praktijk_id = ? and d2.id <> ? and (d2.geldig_tot is null or ? is null or d2.geldig_tot >= ?) " +
      "and (d2.geldig_van is null or ? is null or d2.geldig_van <= ?) and (d2.geldt_voor = 'beide' or ? = 'beide' or d2.geldt_voor = ?))",
      w: [o.entiteit, o.praktijk_id, o.id, n.geldig_van ?? null, n.geldig_van ?? null, n.geldig_tot ?? null, n.geldig_tot ?? null, n.geldt_voor, n.geldt_voor] }),
    kol: ["geldig_van", "geldig_tot", "geldt_voor", "regel"], waar: ID,
  },
  kostencomponent: {
    naam: "kostenpost", tabel: "kostencomponent", periode: [],
    lees: async (db, s) => (await rijen(db, "select * from kostencomponent where id = ?", geldigId(s, "kostenpost")))[0] ?? null,
    sleutel: (r) => String(r.id),
    async stukken(db, r) {
      const m = await rijen                                               (db, "select geldig_van, bedrag from kostenmutatie where kostencomponent_id = ? order by geldig_van", r.id);
      if (!m.length) return [];
      const van = m[0].geldig_van, laatste = m.at(-1) , tot = laatste.bedrag == null ? dagVoor(laatste.geldig_van) : OPEN;
      return [fNota({ entiteit: String(r.entiteit), van, tot }), fPlan(String(r.entiteit), jr(van), jr(tot)), fAfr(String(r.entiteit), jr(van), jr(tot))];
    },
    async velden(_db, b, o) {
      return { naam: of(b, "naam", o, (x) => tekst(x, "naam", { verplicht: true, max: 120 })), soort: of(b, "soort", o, (x) => keuze(x, "soort", ["vast", "personeel", "variabel"]         )),
        per: of(b, "per", o, (x) => keuze(x, "per", ["maand", "kwartaal", "jaar"]         )), betaalmoment: of(b, "betaalmoment", o, (x) => tekst(x, "betaalmoment", { max: 80 })),
        opmerking: of(b, "opmerking", o, (x) => tekst(x, "opmerking", { max: 400 })) };
    },
    kol: ["naam", "soort", "per", "betaalmoment", "opmerking"], waar: ID,
    kinderen: [{ tabel: "deelname_uitzondering", fk: "kostencomponent_id", kol: ["id", "praktijk_id", "geldig_van", "geldig_tot", "reden"] },
      { tabel: "kostenmutatie", fk: "kostencomponent_id", kol: ["id", "geldig_van", "bedrag", "reden"] }],
  },
  kostenmutatie: {
    naam: "bedrag van een kostenpost", tabel: "kostenmutatie", periode: ["geldig_van"],
    lees: async (db, s) => (await rijen(db, "select m.*, c.entiteit, c.naam as component from kostenmutatie m join kostencomponent c on c.id = m.kostencomponent_id where m.id = ?", geldigId(s, "bedrag")))[0] ?? null,
    sleutel: (r) => String(r.id),
    grens: (r) => ({ sql: "select min(geldig_van) from kostenmutatie where kostencomponent_id = ? and geldig_van > ? and id <> ?", w: [r.kostencomponent_id, r.geldig_van, r.id] }),
    async stukken(db, r) {
      const vg = await volgende(db, "select min(geldig_van) as d from kostenmutatie where kostencomponent_id = ? and geldig_van > ? and id <> ?", r.kostencomponent_id, r.geldig_van, r.id);
      const van = String(r.geldig_van), tot = periodeTot(vg);
      return [fNota({ entiteit: String(r.entiteit), van, tot }), fPlan(String(r.entiteit), jr(van), jr(tot)), fAfr(String(r.entiteit), jr(van), jr(tot))];
    },
    async velden(_db, b, o) {
      return { geldig_van: of(b, "geldig_van", o, (x) => datum(x, "vanaf")), bedrag: of(b, "bedrag", o, (x) => getal(x, "bedrag", { min: 0, max: 5e6, leeg: true })),
        reden: of(b, "reden", o, (x) => tekst(x, "reden", { verplicht: true, max: 300 })) };
    },
    kol: ["geldig_van", "bedrag", "reden"], waar: ID,
    wegVoorwaarde: (r) => ({ sql: " and (select count(*) from kostenmutatie where kostencomponent_id = ?) > 1", w: [r.kostencomponent_id] }),
    async blok(db, r) {
      const n = (await rijen               (db, "select count(*) as n from kostenmutatie where kostencomponent_id = ?", r.kostencomponent_id))[0].n;
      return n <= 1 ? "Dit is het enige bedrag van deze kostenpost. Moet de hele post weg, gebruik dan 'Kostenpost verwijderen'." : null;
    },
  },
  contract: {
    naam: "contract", tabel: "contract", periode: ["van", "tot"],
    lees: async (db, s) => (await rijen(db, "select c.*, m.naam from contract c left join medewerker m on m.id = c.medewerker_id where c.id = ?", geldigId(s, "contract")))[0] ?? null,
    sleutel: (r) => String(r.id),
    stukken: async (_db, r) => POT_PERIODE(String(r.van), String(r.tot || OPEN)),
    async velden(db, b, o) {
      const v      = {
        naam: o.medewerker_id == null ? o.naam : of(b, "naam", o, (x) => tekst(x, "naam", { verplicht: true, max: 120 })), functie: of(b, "functie", o, (x) => tekst(x, "functie", { max: 80 })),
        soort: of(b, "soort", o, (x) => keuze(x, "soort", ["dienst", "vacature"]         )), van: of(b, "van", o, (x) => datum(x, "vanaf")), tot: of(b, "tot", o, (x) => datum(x, "tot en met", false)),
        uren: of(b, "uren", o, (x) => getal(x, "uren per week", { min: 1, max: 60 })), schaal: of(b, "schaal", o, (x) => tekst(x, "schaal", { max: 6 })),
        trede: of(b, "trede", o, (x) => getal(x, "trede", { min: 0, max: 60, leeg: true })), periodiekmaand: of(b, "periodiekmaand", o, (x) => getal(x, "periodiekmaand", { min: 1, max: 12, leeg: true })),
      };
      if (v.tot && String(v.tot) < String(v.van)) throw new Fout(400, "tot en met ligt vóór vanaf");
      if (v.trede != null && !Number.isInteger(Number(v.trede))) throw new Fout(400, "trede = heel getal");
      if (v.periodiekmaand != null && !Number.isInteger(Number(v.periodiekmaand))) throw new Fout(400, "periodiekmaand = 1–12");
      if (v.schaal !== o.schaal || v.trede !== o.trede) await caoKeten(db, o.id, { contract: { ...o, ...v } });
      return v;
    },
    kol: CONTRACT_KOL, waar: ID, extraKol: ["naam"], ketenVast: (db, r) => caoKetenVast(db, r.id),
    matchExtra: (r) => (r.medewerker_id == null ? { sql: "", w: [] } : { sql: " and (select m.naam from medewerker m where m.id = contract.medewerker_id) is ?", w: [r.naam ?? null] }),
    kinderen: [{ tabel: "afwezigheid", fk: "contract_id", kol: ["id", "van", "tot", "soort", "loondoorbetaling_pct", "uitkering_pct", "vertraging_maanden", "opmerking"] },
      { tabel: "contractmutatie", fk: "contract_id", kol: ["id", "geldig_van", "uren", "schaal", "trede", "reden"] }],
    // de naam staat bij de medewerker: direct na de eigen contractregel en alleen als die doorging (changes() van die regel; gemeten op D1
    // en node:sqlite: changes() in de where = de vorige opdracht in hetzelfde verzoek)
    naHoofd: (o, n) => (gelijk(n.naam, o.naam) || o.medewerker_id == null ? []
      : [{ sql: "update medewerker set naam = ? where id = ? and naam is ? and changes() > 0", w: [n.naam, o.medewerker_id, o.naam ?? null] }]),
    // schaal, trede of periodiekmaand met de hand verbeterd = door David nagekeken
    extraSet: (o, n, wie) => (["schaal", "trede", "periodiekmaand"].some((k) => !gelijk(n[k], o[k]))
      ? { sql: ", bevestigd_op = strftime('%Y-%m-%dT%H:%M:%SZ','now'), bevestigd_door = ?", w: [wie] } : null),
    na: async (_db, r) => (r.medewerker_id == null ? [] : [{ sql: "delete from medewerker where id = ? and not exists (select 1 from contract where medewerker_id = ?)", w: [r.medewerker_id, r.medewerker_id] }]),
  },
  contractmutatie: {
    naam: "wijziging van een contract", tabel: "contractmutatie", periode: ["geldig_van"],
    lees: async (db, s) => (await rijen(db, "select m.*, c.cao, c.schaal as c_schaal, c.trede as c_trede, c.tot as c_tot from contractmutatie m join contract c on c.id = m.contract_id where m.id = ?", geldigId(s, "wijziging")))[0] ?? null,
    sleutel: (r) => String(r.id),
    grens: (r) => ({ sql: "select tot from contract where id = ?", w: [r.contract_id] }),
    ketenVast: (db, r) => caoKetenVast(db, r.contract_id),
    async blok(db, r) {
      try { await caoKeten(db, r.contract_id, { weg: r.id }); return null; }
      catch (e) { return e instanceof Fout ? `Zonder deze wijziging klopt een latere niet meer: ${e.message}. Corrigeer eerst die latere wijziging.` : null; }
    },
    // het einde van het contract vers uit de databank (bewaakt door grens); niet uit de eerste lezing (Codex r6)
    async stukken(db, r) {
      const tot = (await rijen                        (db, "select tot from contract where id = ?", r.contract_id))[0]?.tot ?? null;
      return POT_PERIODE(String(r.geldig_van), String(tot || OPEN));
    },
    async velden(db, b, o) {
      const v      = { geldig_van: of(b, "geldig_van", o, (x) => datum(x, "vanaf")), uren: of(b, "uren", o, (x) => getal(x, "uren", { min: 1, max: 60, leeg: true })),
        schaal: of(b, "schaal", o, (x) => tekst(x, "schaal", { max: 6 })), trede: of(b, "trede", o, (x) => getal(x, "trede", { min: 0, max: 60, leeg: true })),
        reden: of(b, "reden", o, (x) => tekst(x, "reden", { verplicht: true, max: 300 })) };
      if (v.uren == null && v.schaal == null && v.trede == null) throw new Fout(400, "vul uren, schaal of trede in");
      // de schaal en trede die hierdoor gelden, ook bij latere wijzigingen die ervan erven, moeten in de cao-tabel staan (Codex r10/r11)
      await caoKeten(db, o.contract_id, { mutatie: { ...o, ...v } });
      return v;
    },
    kol: ["geldig_van", "uren", "schaal", "trede", "reden"], waar: ID,
  },
  afwezigheid: {
    naam: "afwezigheid", tabel: "afwezigheid", periode: ["van", "tot"],
    lees: async (db, s) => (await rijen(db, "select * from afwezigheid where id = ?", geldigId(s, "afwezigheid")))[0] ?? null,
    sleutel: (r) => String(r.id),
    stukken: async (_db, r) => POT_PERIODE(String(r.van), String(r.tot || OPEN)),
    async velden(_db, b, o) {
      const v      = { soort: of(b, "soort", o, (x) => keuze(x, "soort", ["ziekte", "verlof", "overig"]         )), van: of(b, "van", o, (x) => datum(x, "vanaf")),
        tot: of(b, "tot", o, (x) => datum(x, "tot en met", false)), loondoorbetaling_pct: of(b, "loondoorbetaling_pct", o, (x) => (x == null || x === "" ? 1 : pct(x, "loondoorbetaling"))),
        uitkering_pct: of(b, "uitkering_pct", o, (x) => pctVeld(x, "uitkering")), vertraging_maanden: of(b, "vertraging_maanden", o, (x) => getal(x === "" ? 2 : x, "vertraging", { min: 0, max: 12 })),
        opmerking: of(b, "opmerking", o, (x) => tekst(x, "opmerking", { max: 300 })) };
      if (v.tot && String(v.tot) < String(v.van)) throw new Fout(400, "tot en met ligt vóór vanaf");
      if (!Number.isInteger(Number(v.vertraging_maanden))) throw new Fout(400, "vertraging = hele maanden");
      return v;
    },
    kol: ["soort", "van", "tot", "loondoorbetaling_pct", "uitkering_pct", "vertraging_maanden", "opmerking"], waar: ID,
  },
  inhuur: {
    naam: "inhuur", tabel: "inhuur", periode: ["van", "tot"],
    lees: async (db, s) => (await rijen(db, "select * from inhuur where id = ?", geldigId(s, "inhuur")))[0] ?? null,
    sleutel: (r) => String(r.id),
    stukken: async (_db, r) => POT_PERIODE(String(r.van), String(r.tot || OPEN)),
    async velden(_db, b, o) {
      const v      = { omschrijving: of(b, "omschrijving", o, (x) => tekst(x, "omschrijving", { verplicht: true, max: 160 })), van: of(b, "van", o, (x) => datum(x, "vanaf")),
        tot: of(b, "tot", o, (x) => datum(x, "tot en met", false)), uren_week: of(b, "uren_week", o, (x) => getal(x, "uren per week", { min: 0.5, max: 80 })),
        tarief: of(b, "tarief", o, (x) => getal(x, "tarief", { min: 0, max: 500 })), opmerking: of(b, "opmerking", o, (x) => tekst(x, "opmerking", { max: 300 })) };
      if (v.tot && String(v.tot) < String(v.van)) throw new Fout(400, "tot en met ligt vóór vanaf");
      return v;
    },
    kol: ["omschrijving", "van", "tot", "uren_week", "tarief", "opmerking"], waar: ID,
  },
  loonparameter: {
    naam: "loonparameters", tabel: "loonparameter", periode: [],
    lees: async (db, s) => (await rijen(db, "select * from loonparameter where jaar = ?", jaar(s)))[0] ?? null,
    sleutel: (r) => String(r.jaar),
    grens: (r) => ({ sql: "select min(jaar) from loonparameter where jaar > ?", w: [r.jaar] }),
    async stukken(db, r) {
      // de kern neemt voor een jaar de loonparameters van het laatste jaar dat er een heeft: deze gelden tot het volgende jaar met eigen parameters
      const vg = (await rijen                      (db, "select min(jaar) as j from loonparameter where jaar > ?", r.jaar))[0]?.j ?? null;
      return POT_PERIODE(`${r.jaar}-01-01`, vg ? `${Number(vg) - 1}-12-31` : OPEN);
    },
    async velden(_db, b, o) {
      const p = (k        , naam        ) => of(b, k, o, (x) => (x === "" ? o[k] : pct(x, naam)));
      const md = of(b, "cao_aanname_maanddag", o, (x) => tekst(x, "ingang cao-aanname", { verplicht: true, max: 5 }));
      if (!/^(0[1-9]|1[0-2])-01$/.test(String(md))) throw new Fout(400, "ingang cao-aanname = MM-01");
      return { werkgeverslasten: p("werkgeverslasten", "werkgeverslasten"), vakantiegeld_res: p("vakantiegeld_res", "reservering vakantiegeld"), eindejaar_res: p("eindejaar_res", "reservering eindejaarsuitkering"),
        verzuim_pct: p("verzuim_pct", "verzuim"), cao_aanname_pct: p("cao_aanname_pct", "cao-aanname"), cao_aanname_maanddag: md, bron: of(b, "bron", o, (x) => tekst(x, "bron", { verplicht: true, max: 300 })) };
    },
    kol: ["werkgeverslasten", "vakantiegeld_res", "eindejaar_res", "verzuim_pct", "cao_aanname_pct", "cao_aanname_maanddag", "bron"], waar: (r) => ({ sql: "jaar = ?", w: [r.jaar] }),
  },
  buffer: {
    naam: "buffer", tabel: "buffer", periode: ["geldig_van"],
    async lees(db, s) {
      const [e, d] = String(s).split("@");
      return (await rijen(db, "select * from buffer where entiteit = ? and geldig_van = ?", keuze(e, "entiteit", ENT), datum(d, "vanaf")))[0] ?? null;
    },
    sleutel: (r) => `${r.entiteit}@${r.geldig_van}`,
    grens: (r, o) => ({ sql: "select min(geldig_van) from buffer where entiteit = ? and geldig_van > ? and geldig_van <> ?", w: [r.entiteit, r.geldig_van, (o ?? r).geldig_van] }),
    async stukken(db, r, o) {
      const vg = await volgende(db, "select min(geldig_van) as d from buffer where entiteit = ? and geldig_van > ? and geldig_van <> ?", r.entiteit, r.geldig_van, (o ?? r).geldig_van);
      const van = String(r.geldig_van), tot = periodeTot(vg), e = String(r.entiteit);
      return [fNota({ entiteit: e, van, tot, extra: "buffer <> 0" }), fPlan(e, jr(van), jr(tot)), fAfr(e, jr(van), jr(tot))];
    },
    async velden(_db, b, o) {
      const inRuw = of(b, "opbouw_in", o, (x) => tekst(x, "opbouw in maanden", { max: 40 }));
      const opIn = inRuw ? K.bufferMaanden(String(inRuw)) : null;
      if (inRuw && !opIn) throw new Fout(400, "opbouw in maanden: maandnummers 1–12, met komma's (bv. 1,7)");
      const mnd = of(b, "opbouw_maanden", o, (x) => getal(x === "" ? 12 : x, "opbouw in maanden", { min: 1, max: 12 }));
      if (!Number.isInteger(Number(mnd))) throw new Fout(400, "opbouw in maanden = heel getal");
      return { geldig_van: of(b, "geldig_van", o, (x) => datum(x, "vanaf")), doel: of(b, "doel", o, (x) => getal(x, "doel", { min: 0, max: 1e6 })), opbouw_maanden: mnd,
        opbouw_in: opIn ? opIn.join(",") : null, status: of(b, "status", o, (x) => keuze(x || "voorstel", "status", ["voorstel", "besloten"]         )),
        opmerking: of(b, "opmerking", o, (x) => tekst(x, "opmerking", { max: 300 })) };
    },
    kol: ["geldig_van", "doel", "opbouw_maanden", "opbouw_in", "status", "opmerking"], waar: (r) => ({ sql: "entiteit = ? and geldig_van = ?", w: [r.entiteit, r.geldig_van] }),
  },
  subsidie: {
    // opbrengst staat los van de nota's: er leunt niets op
    naam: "subsidiebedrag", tabel: "subsidie", periode: [],
    lees: async (db, s) => (await rijen(db, "select * from subsidie where id = ?", geldigId(s, "subsidie")))[0] ?? null,
    sleutel: (r) => String(r.id),
    stukken: async () => [],
    async velden(_db, b, o) {
      return { jaar: of(b, "jaar", o, (x) => jaar(x)), soort: of(b, "soort", o, (x) => keuze(x, "soort", ["aangevraagd", "verleend", "vastgesteld", "prognose"]         )),
        bedrag: of(b, "bedrag", o, (x) => getal(x, "bedrag", { min: 0, max: 5e6 })), bron: of(b, "bron", o, (x) => tekst(x, "bron", { max: 300 })) };
    },
    kol: ["jaar", "soort", "bedrag", "bron"], waar: ID,
  },
  "subsidie-totaal": {
    naam: "subsidietotaal", tabel: "subsidie_totaal", periode: [],
    async lees(db, s) {
      const [j, soort] = String(s).split("/");
      return (await rijen(db, "select * from subsidie_totaal where jaar = ? and soort = ?", jaar(j), keuze(soort, "soort", ["aangevraagd", "verleend", "vastgesteld", "prognose"]         )))[0] ?? null;
    },
    sleutel: (r) => `${r.jaar}/${r.soort}`,
    stukken: async () => [],
    async velden(_db, b, o) {
      return { soort: of(b, "soort", o, (x) => keuze(x, "soort", ["aangevraagd", "verleend", "vastgesteld", "prognose"]         )),
        bedrag: of(b, "bedrag", o, (x) => getal(x, "bedrag", { min: 0, max: 5e6 })), bron: of(b, "bron", o, (x) => tekst(x, "bron", { verplicht: true, max: 300 })) };
    },
    kol: ["soort", "bedrag", "bron"], waar: (r) => ({ sql: "jaar = ? and soort = ?", w: [r.jaar, r.soort] }),
  },
  inschrijftarief: {
    naam: "inschrijftarief", tabel: "inschrijftarief", periode: [],
    lees: async (db, s) => (await rijen(db, "select * from inschrijftarief where jaar = ?", jaar(s)))[0] ?? null,
    sleutel: (r) => String(r.jaar),
    stukken: async () => [],
    async velden(_db, b, o) {
      return { tarief: of(b, "tarief", o, (x) => getal(x, "tarief", { min: 0, max: 100 })), bron: of(b, "bron", o, (x) => tekst(x, "bron", { verplicht: true, max: 300 })),
        opmerking: of(b, "opmerking", o, (x) => tekst(x, "opmerking", { max: 300 })) };
    },
    kol: ["tarief", "bron", "opmerking"], waar: (r) => ({ sql: "jaar = ?", w: [r.jaar] }),
  },
};
export const CORRIGEERBAAR = Object.keys(SOORTEN);

async function soortEnRij(db          , b                          ) {
  const get = (k        ) => (b instanceof URLSearchParams ? b.get(k) : b[k]);
  // "wat" = welke instelling (niet "soort": dat is bij kosten, contracten en subsidie zelf een veld)
  const naam = String(get("wat") ?? "");
  if (!Object.hasOwn(SOORTEN, naam)) throw new Fout(400, "onbekend wat te corrigeren");
  const s = SOORTEN[naam];
  const sleutel = get("sleutel");
  if (sleutel == null || sleutel === "") throw new Fout(400, "sleutel ontbreekt");
  const r = await s.lees(db, String(sleutel));
  if (!r) throw new Fout(404, `${s.naam} niet gevonden (al verwijderd?)`);
  return { s, r };
}
const UITLEG_WEG = "Verwijderen kan daarom niet: die stukken zijn met deze gegevens gemaakt. Was het een tikfout in een bedrag of tekst, gebruik dan Bewerken; " +
  "verandert er per een datum echt iets, leg dat vast als nieuwe versie per datum.";

/** Wat er op een versie leunt (vooraf, voor het scherm): stukken, of verwijderen kan, en de uitleg in gewone taal. */
export async function leunt(db          , zoek                 ) {
  const { s, r } = await soortEnRij(db, zoek);
  const st = await stukkenVan(db, await s.stukken(db, r));
  const blok = s.blok ? await s.blok(db, r) : null;
  const fin = s.fin && !(await legacyOpen(db)) ? "Kan na het overstapmoment; tot dan is dit een kopie van de oude datahub." : null;
  const verwijderbaar = !st.length && !blok && !fin;
  return {
    soort: s.naam, stukken: st, verwijderbaar, kol: stempelKol(s), versie: stempel(s, r), onderdelen: await onderdelenStempel(db, s, r),
    // welke onderdelen meegaan (tabel + kolommen, in deze volgorde): het scherm rekent het stempel na uit wat het toont
    onderdelen_kol: (s.kinderen || []).map((k) => [k.tabel, k.kol]),
    uitleg: fin || (st.length ? `Hierop leunen al ${stukkenTekst(st)}. ${UITLEG_WEG}` : blok || ""),
    // bij Bewerken: wat er gebeurt met de stukken die er al zijn
    bij_bewerken: fin || (st.length ? `Hierop leunen al ${stukkenTekst(st)}. Die veranderen niet mee; de correctie telt voor wat de app hierna rekent of maakt.` +
      (s.periode.length ? " De datum is daarom niet te corrigeren." : "") : ""),
    datum_vast: st.length > 0 && s.periode.length > 0,
  };
}

/** Stempel van de onderdelen die bij verwijderen meegaan (bedragen van een kostenpost, wijzigingen en afwezigheid van een contract). */
const onderdelenVan = (kv                       ) => K.versieVan(kv.map((x) => x.stempel));
async function onderdelenStempel(db          , s       , r     ) {
  return onderdelenVan(await kinderenVast(db, s, r));
}
/** Het scherm stuurt het stempel mee van de rij waarmee het begon; anders is die rij intussen gewijzigd. */
function zelfdeVersie(s       , r     , b        ) {
  if (typeof b.versie !== "string" || !b.versie) throw new Fout(400, "versie ontbreekt (herlaad de pagina)");
  if (b.versie !== stempel(s, r)) throw new Fout(409, "Deze versie is intussen gewijzigd (in een ander venster of door een andere handeling). Herlaad de pagina en kijk opnieuw.");
}

async function corrigeer(db          , b        , wie        ) {
  const { s, r: oud } = await soortEnRij(db, b);
  zelfdeVersie(s, oud, b);
  if (s.fin && !(await legacyOpen(db))) throw new Fout(409, `${s.naam} is pas te wijzigen na het overstapmoment (nu nog een kopie van fin)`);
  const leesKeten = async () => (s.ketenVast ? [await s.ketenVast(db, oud)] : []);
  const { voor: keten, uit: nieuw } = await zelfdeMoment(leesKeten, () => s.velden(db, b, oud));
  const anders = Object.keys(nieuw).filter((k) => !gelijk(nieuw[k], oud[k]));
  if (!anders.length) return { ok: true, ongewijzigd: true };
  let guard       = { sql: "", w: [] };
  if (s.periode.some((k) => anders.includes(k))) {
    const db0 = s.datumBlok ? await s.datumBlok(db, oud) : null;
    if (db0) throw new Fout(409, db0);
    const { voor, uit: f } = await zelfdeMoment(async () => [await grensVast(db, s, oud), await grensVast(db, s, { ...oud, ...nieuw }, oud)],
      async () => [...(await s.stukken(db, oud)), ...(await s.stukken(db, { ...oud, ...nieuw }, oud))]);
    const st = await stukkenVan(db, f);
    if (st.length) throw new Fout(409, `De datum is niet te corrigeren: hierop leunen al ${stukkenTekst(st)}. Verandert er per een datum echt iets, leg dat dan vast als nieuwe versie per datum.`);
    guard = samen(vrijVan(f), ...voor);
  }
  // één voorwaarde voor alles in de batch: de rij is nog zoals gelezen en (bij een andere periode) er leunt nog steeds niets op
  guard = samen(guard, s.corrigeerVoorwaarde?.(oud, { ...oud, ...nieuw }) || { sql: "", w: [] }, ...keten);
  const m = zoalsGelezen(s, oud);
  const cond       = { sql: `exists (select 1 from ${s.tabel} where ${m.sql})${guard.sql}`, w: [...m.w, ...guard.w] };
  const nieuwSleutel = s.sleutel({ ...oud, ...nieuw });
  const st         = [db.prepare("insert into logboek (wie, tabel, sleutel, actie, oud, nieuw) select ?,?,?,?,?,? where " + cond.sql)
    .bind(wie, s.tabel, nieuwSleutel === s.sleutel(oud) ? nieuwSleutel : `${s.sleutel(oud)} → ${nieuwSleutel}`, "gecorrigeerd",
      JSON.stringify(Object.fromEntries(anders.map((k) => [k, oud[k] ?? null]))), JSON.stringify(Object.fromEntries(anders.map((k) => [k, nieuw[k] ?? null]))), ...cond.w)];
  const kol = Object.keys(nieuw).filter((k) => s.kol.includes(k));
  const ex = s.extraSet?.(oud, nieuw, wie) || { sql: "", w: [] };
  st.push(db.prepare(`update ${s.tabel} set ${setSql(kol)}${ex.sql} where ${m.sql}${guard.sql}`).bind(...kol.map((k) => nieuw[k] ?? null), ...ex.w, ...m.w, ...guard.w));
  for (const x of s.naHoofd?.(oud, nieuw) || []) st.push(db.prepare(x.sql).bind(...x.w));
  // vervolgopdrachten alleen als de correctie echt landde (de rij staat op de nieuwe waarden)
  const geland = zoalsGelezen(s, { ...oud, ...nieuw });
  for (const x of (await s.na?.(db, { ...oud, ...nieuw }, oud)) || []) st.push(db.prepare(`${x.sql} and exists (select 1 from ${s.tabel} where ${geland.sql})`).bind(...x.w, ...geland.w));
  await db.batch(st);
  const na = await s.lees(db, nieuwSleutel);
  if (!na || anders.some((k) => !gelijk(na[k], nieuw[k]))) throw new Fout(409, "Niet (helemaal) bewaard: er is intussen iets veranderd (bijvoorbeeld een nota gemaakt of dezelfde versie aangepast). Kijk opnieuw.");
  return { ok: true };
}

async function verwijder(db          , b        , wie        ) {
  if (b.bevestig !== true) throw new Fout(400, "bevestig ontbreekt");
  const { s, r } = await soortEnRij(db, b);
  zelfdeVersie(s, r, b);
  if (s.fin && !(await legacyOpen(db))) throw new Fout(409, `${s.naam} is pas te wijzigen na het overstapmoment (nu nog een kopie van fin)`);
  const { voor: keten, uit: blok } = await zelfdeMoment(async () => (s.ketenVast ? [await s.ketenVast(db, r)] : []), async () => (s.blok ? s.blok(db, r) : null));
  if (blok) throw new Fout(409, blok);
  // voorwaarden: niets leunt erop, de periodegrens en de onderdelen zijn nog zoals bij het kijken, de rij zelf ook (en de extra voorwaarde)
  const { voor, uit: f } = await zelfdeMoment(async () => [await grensVast(db, s, r), ...(await kinderenVast(db, s, r))], () => s.stukken(db, r));
  const st0 = await stukkenVan(db, f);
  if (st0.length) throw new Fout(409, `Hierop leunen al ${stukkenTekst(st0)}. ${UITLEG_WEG}`);
  const v = vrijVan(f), g = voor[0], kv = voor.slice(1), extra = s.wegVoorwaarde?.(r) || { sql: "", w: [] };
  // wat er meegaat moet precies zijn wat het scherm liet zien (stempel uit leunt); de batch gebruikt dezelfde vingerafdrukken als voorwaarde
  if (kv.length && b.onderdelen !== onderdelenVan(kv                                    ))
    throw new Fout(409, "Er kwam intussen iets bij (bijvoorbeeld een bedrag of een afwezigheid) dat mee zou verdwijnen. Herlaad de pagina en kijk opnieuw.");
  const m = zoalsGelezen(s, r);
  const rijEr       = { sql: `exists (select 1 from ${s.tabel} where ${m.sql})`, w: m.w };
  const kind = s.kinderen || [];
  // het logboek eerst (onder alle voorwaarden), met de onderdelen die meegaan zoals ze in de databank staan
  const kindJson = kind.map((k) => `, '${k.tabel}', (select json_group_array(json_object(${k.kol.map((c) => `'${c}', ${c}`).join(", ")})) from ${k.tabel} where ${k.fk} = ?)`).join("");
  const alles = samen(rijEr, v, g, ...kv, extra, ...keten);
  // elke verwijderregel hangt aan déze logboekregel (uniek verzoeknummer): ging het logboek niet door, dan gaat er niets weg (Codex r9)
  const verzoek = crypto.randomUUID();
  const st         = [db.prepare(`insert into logboek (wie, tabel, sleutel, actie, oud, nieuw) select ?, ?, ?, 'verwijderd', json_object('rij', json(?)${kindJson}), json_object('verzoek', ?) where ${alles.sql}`)
    .bind(wie, s.tabel, s.sleutel(r), JSON.stringify(r), ...kind.map(() => r.id), verzoek, ...alles.w)];
  const gelogd = "exists (select 1 from logboek where tabel = ? and actie = 'verwijderd' and nieuw = json_object('verzoek', ?))";
  for (const k of kind) st.push(db.prepare(`delete from ${k.tabel} where ${k.fk} = ? and ${gelogd}`).bind(r.id, s.tabel, verzoek));
  // de hoofdregel: ook alleen na de logboekregel, en als er geen onderdelen meer zijn
  const leeg = kind.map((k) => ` and not exists (select 1 from ${k.tabel} where ${k.fk} = ?)`).join("");
  st.push(db.prepare(`delete from ${s.tabel} where ${m.sql} and ${gelogd}${leeg}`).bind(...m.w, s.tabel, verzoek, ...kind.map(() => r.id)));
  for (const x of (await s.na?.(db, r, r)) || []) st.push(db.prepare(`${x.sql} and ${gelogd}`).bind(...x.w, s.tabel, verzoek));
  await db.batch(st);
  if (await s.lees(db, s.sleutel(r))) throw new Fout(409, "Niet verwijderd: er is intussen iets veranderd (bijvoorbeeld een nota gemaakt of de versie aangepast). Kijk opnieuw.");
  return { ok: true };
}
