#!/usr/bin/env bash
# Toetst wv4009 (besluitenpagina nr 496 = 3C196) in brain-entiteiten.js: mail per partij. Mailkaarten (organisatie, persoon, registers) als
# eerste bron; het lees-luik alleen na de momentopname van de kaart (strikt na die dag), begrensd (venster halveren bij 25, budget, uurgrens)
# en met cache; Davids eigen adressen (ook +achtervoegsel en zelfde naam op een eigen domein) tellen nooit als partij; geen kenmerk = eerlijke
# regel; dubbeltelling persoonskaart onder een organisatiedomein voorkomen; hoofdpagina en 'mailkaart:' als koppeling. Alles verzonnen.
# Gebruik: bash test/brain-entiteiten-mail.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 900) + ']' : '')); }
const B = require('./brain-entiteiten.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wv4009-'));
const vault = path.join(tmp, 'vault');
const zet = (rel, t) => { fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); fs.writeFileSync(path.join(vault, rel), t); };
const MK = '30_Conversaties/Mail/Mailkaarten/';
const regel = (d, o, r, id, n) => `- ${d} · **${o}** ${n ? '· ' + n + '× ' : ''}${r} · [[30_Conversaties/Mail/Gesprekken/x#^g${id}|tekst]] · \`gmail:${id}\` — snippet`;
zet(MK + 'Organisaties/Verzonnen BV.md', ['---', 'type: mailkaart', 'soort: organisatie', 'naam: "Verzonnen BV"', 'domein: "verzonnen.example"',
  'dossier: "[[10_Zakelijk/_Gedeeld/Relaties/Verzonnen BV]]"', 'mails: 40', 'gesprekken: 12', 'eerste: "2010-01-01"', 'laatste: "2026-10-20"', 'updated: 2026-10-24', '---', '',
  '# Mailkaart', '', '## Gesprekken', '', '### 2026 (7)', '',
  regel('2026-10-20', 'Factuur oktober', '⇄', 'a00000000000000a', 2), regel('2026-10-10', 'Offerte', '←', 'a00000000000000b'),
  regel('2026-09-01', 'Vraag', '→', 'a00000000000000c'), regel('2026-08-01', 'Oud 1', '←', 'a00000000000000d'), regel('2026-07-01', 'Oud 2', '←', 'a00000000000000e'),
  regel('2026-06-01', 'Oud 3', '←', 'a00000000000000f'), regel('2026-05-01', 'Oud 4', '←', 'a000000000000010'), ''].join('\n'));
// persoon bij dezelfde organisatie: telt niet dubbel
zet(MK + 'Personen/Jan Verzonnen.md', ['---', 'type: mailkaart', 'soort: persoon', 'naam: "Jan Verzonnen"', 'adressen: ["jan@verzonnen.example"]', 'dossier: ',
  'mails: 9', 'gesprekken: 3', 'laatste: "2026-10-05"', 'updated: 2026-10-24', '---', '', regel('2026-10-05', 'Persoonlijk', '←', 'b00000000000000a'), ''].join('\n'));
zet(MK + 'Personen/Kees Proef.md', ['---', 'type: mailkaart', 'soort: persoon', 'naam: "Kees Proef"', 'adressen: ["kees.proef@gmail.com", "kees@werk.example"]',
  'dossier: ', 'mails: 5', 'gesprekken: 2', 'laatste: "2025-03-01"', 'updated: 2026-10-24', '---', '', regel('2025-03-01', 'Etentje', '⇄', 'c00000000000000a', 3), ''].join('\n'));
zet(MK + 'Register organisaties/K.md', ['---', 'type: mailkaart', 'soort: register organisaties', 'letter: "K"', 'updated: 2026-10-24', '---', '', '# reg', '',
  '## kleinbedrijf.example', '', '3 mails, 2 gesprekken · kleinbedrijf.example, info@kleinbedrijf.example', '', regel('2024-02-02', 'Kleine vraag', '←', 'd00000000000000a'), regel('2023-01-01', 'Eerder', '⇄', 'd00000000000000b', 2), '',
  '## gmail.com', '', '9 mails, 9 gesprekken · gmail.com', '', regel('2024-01-01', 'Vrij', '←', 'd00000000000000c'), ''].join('\n'));
zet(MK + 'Register personen/P.md', ['---', 'type: mailkaart', 'soort: register personen', 'letter: "P"', 'updated: 2026-10-24', '---', '',
  '## Piet Pagina', '', '2 mails, 1 gesprekken · piet@pagina.example', '', regel('2022-05-05', 'Hallo', '⇄', 'e00000000000000a', 2), ''].join('\n'));
zet('10_Zakelijk/_Gedeeld/Relaties/Verzonnen BV.md', '---\ntype: relatie\n---\n# Verzonnen BV\n');
zet('10_Zakelijk/Proef/Entiteit - PR.md', '---\ntype: entiteit\nhoofdpagina: "[[10_Zakelijk/Proef/index]]"\n---\n# PR\n');
zet('10_Zakelijk/Proef/index.md', '---\ntype: hub\nmailkaart: "[[30_Conversaties/Mail/Mailkaarten/Personen/Kees Proef]]"\n---\n# hub\n');
zet('10_Zakelijk/_Gedeeld/Relaties/Zonder.md', '# zonder\n');
zet('20_Prive/Familie/Ria Relatie.md', '---\ntype: persoon\nnaam: Ria Relatie\nmailkaart: "[[30_Conversaties/Mail/Mailkaarten/Organisaties/Verzonnen BV]]"\n---\n# Ria\n');
zet('20_Prive/Familie/Piet Pagina.md', '---\ntype: persoon\nnaam: Piet Pagina\novis:\n  mailadressen: ["piet@pagina.example"]\n---\n# Piet\n');

const knopen = [
  { id: 'org:verzonnen', soort: 'organisatie', rol: 'leverancier', naam: 'Verzonnen BV', vault_pagina: '10_Zakelijk/_Gedeeld/Relaties/Verzonnen BV.md', actief: true, voor: [] },
  { id: 'org:klein', soort: 'organisatie', rol: 'leverancier', naam: 'Klein', vault_pagina: null, actief: true, voor: [] },
  { id: 'org:zonder', soort: 'organisatie', rol: 'leverancier', naam: 'Zonder', vault_pagina: '10_Zakelijk/_Gedeeld/Relaties/Zonder.md', actief: true, voor: [] },
  { id: 'org:alleenluik', soort: 'organisatie', rol: 'leverancier', naam: 'Nieuw', vault_pagina: null, actief: true, voor: [] },
  { id: 'org:vrij', soort: 'organisatie', rol: 'leverancier', naam: 'Vrij', vault_pagina: null, actief: true, voor: [] },
  { id: 'per:jan', soort: 'persoon', naam: 'Jan Verzonnen', vault_pagina: null, actief: true, voor: [] },
  { id: 'PR', soort: 'entiteit', rol: 'eigen', naam: 'Proef', vault_pagina: '10_Zakelijk/Proef/Entiteit - PR.md', actief: true, voor: [] },
];
const handvatten = [
  { knoop: 'per:jan', soort: 'mail', status: 'actief', waarde: 'info@kleinbedrijf.example', waarde_norm: 'info@kleinbedrijf.example' },   // gedeeld adres van de organisatie
  { knoop: 'per:jan', soort: 'domein', status: 'voorgesteld', waarde: 'verzonnen.example', waarde_norm: 'verzonnen.example' },
  { knoop: 'per:jan', soort: 'mail', status: 'actief', waarde: 'jan@verzonnen.example', waarde_norm: 'jan@verzonnen.example' },
  { knoop: 'org:klein', soort: 'domein', status: 'actief', waarde: 'kleinbedrijf.example', waarde_norm: 'kleinbedrijf.example' },
  { knoop: 'org:alleenluik', soort: 'mail', status: 'voorgesteld', waarde: 'Info@Nieuw.example', waarde_norm: 'info@nieuw.example' },
  { knoop: 'org:vrij', soort: 'domein', status: 'actief', waarde: 'gmail.com', waarde_norm: 'gmail.com' },
  { knoop: 'org:verzonnen', soort: 'domein', status: 'vervallen', waarde: 'oud.example', waarde_norm: 'oud.example' },
  { knoop: 'org:verzonnen', soort: 'mail', status: 'actief', waarde: 'jan@verzonnen.example', waarde_norm: 'jan@verzonnen.example' },   // persoonskaart onder het domein
];
const rpc = async (fn) => { if (fn !== 'ovis_register_lees') throw new Error('onverwacht ' + fn); return { knopen, handvatten }; };
const kaartLijst = [];
(function wandel(d) { for (const n of fs.readdirSync(path.join(vault, d))) { const r = d ? d + '/' + n : n, st = fs.statSync(path.join(vault, r)); if (st.isDirectory()) wandel(r); else kaartLijst.push({ p: r, s: '', m: st.mtimeMs }); } })('');
let NU = Date.parse('2026-11-25T10:00:00Z');
const vragen = [];
let luikAntw = () => ({ mails: [] });
const luik = async (b) => { vragen.push(b); NU += 500; return luikAntw(b); };
const EIGEN = ['d.proef@gmail.com', 'dokterproef@praktijk.example'];
const maakM = (x) => B.maak(Object.assign({ rpc, lees: (p) => fs.readFileSync(p, 'utf8'), vault, kaart: () => kaartLijst, nu: () => NU, luik, eigenAdressen: () => EIGEN }, x || {}));
const sl = B.sleutelVan;
const mail = (id, aan, van, dag, onderwerp, thread, labels) => ({ id, thread_id: thread || id, dag_lokaal: dag, datum: dag + 'T10:00:00.000Z', van, aan, onderwerp, labels: labels || '[]' });

(async () => {
  // ── pure delen ──
  const k = B.mailKaartLees(fs.readFileSync(path.join(vault, MK + 'Organisaties/Verzonnen BV.md'), 'utf8'), 'x.md');
  toets('kaart: velden', k && k.mails === 40 && k.gesprekken === 12 && k.laatste === '2026-10-20' && k.momentopname === '2026-10-24' && k.domein === 'verzonnen.example'
    && k.dossier === '10_Zakelijk/_Gedeeld/Relaties/Verzonnen BV.md', k);
  toets('kaart: vijf regels, alle ids', k.regels.length === 5 && k.ids.size === 7 && k.regels[0].richting === '⇄' && k.regels[0].n === 2 && k.regels[1].richting === '←', k.regels);
  const rg = B.mailRegisterLees(fs.readFileSync(path.join(vault, MK + 'Register organisaties/K.md'), 'utf8'), 'r.md');
  toets('register: gratis domein valt weg, klein blijft', rg.length === 1 && rg[0].domein === 'kleinbedrijf.example' && rg[0].mails === 3 && rg[0].laatste === '2024-02-02' && rg[0].register, rg);
  const eig = B.eigenToets(EIGEN);
  toets('eigen: +achtervoegsel en zelfde naam op eigen domein', eig('D.Proef+ai@gmail.com') && eig('d.proef@praktijk.example') && !eig('d.proef@ander.example') && !eig('jan@gmail.com'));
  const q = B.mailZoekvraag(['a@b.example'], ['c.example'], '1700000000', '1700100000');
  toets('zoekvraag: van partij of van mij aan partij, venster, zonder promoties', q === '(from:a@b.example OR from:c.example OR (from:me (to:a@b.example OR to:c.example))) after:1700000000 before:1700100000 -category:promotions -category:social -category:forums', q);
  const t = B.mailLuikTel([
    mail('m1', 'Ik <d.proef@gmail.com>', 'Jan <jan@verzonnen.example>', '2026-11-20', 'Nieuw', 'aaaaaa01'),
    mail('m2', 'Jan <jan@verzonnen.example>', 'Ik <d.proef@gmail.com>', '2026-11-21', 'Re: Nieuw', 'aaaaaa01', "['SENT']"),
    mail('m3', 'Ik <d.proef@gmail.com>', 'iemand@verzonnen.example', '2026-10-24', 'Op de kaartdag', 'aaaaaa03'),
    mail('m4', 'x <d.proef+ai@gmail.com>', 'Ik <dokterproef@praktijk.example>', '2026-11-22', 'Doorgestuurd aan mezelf', 'aaaaaa04'),
    mail('m5', 'ander@elders.example, jan@verzonnen.example', 'Collega <c@elders.example>', '2026-11-22', 'Groepsmail van een ander', 'aaaaaa05'),
    mail('m1', 'Ik <d.proef@gmail.com>', 'Jan <jan@verzonnen.example>', '2026-11-20', 'Dubbel', 'aaaaaa01'),
    mail('m6', 'jan@sub.verzonnen.example', 'Ik <dokterproef@praktijk.example>', '2026-11-23', 'Vanaf werkadres', 'aaaaaa06'),
  ], { adressen: [], domeinen: ['verzonnen.example'] }, eig, '2026-10-24');
  const d1 = t.draden.get('aaaaaa01');
  toets('luiktelling: alleen echte wisselingen na de kaartdag, ontdubbeld', t.mails === 3 && t.draden.size === 2 && d1.n === 2 && d1.richting === '⇄' && d1.datum === '2026-11-21' && t.draden.get('aaaaaa06').richting === '→',
    { mails: t.mails, draden: Array.from(t.draden.values()) });

  const t2 = B.mailLuikTel([
    mail('aaaaab01', 'Ik <dokterproef@praktijk.example>', 'Collega <col@praktijk.example>', '2026-11-20', 'Van collega', 'aaaaab01'),
    mail('aaaaab02', 'x <d.proef+ai@gmail.com>', 'Ik <dokterproef@praktijk.example>', '2026-11-21', 'Aan mezelf doorgestuurd', 'aaaaab02'),
    mail('aaaaab03', 'Collega <col@praktijk.example>', 'Ik <d.proef@praktijk.example>', '2026-11-22', 'Aan collega', 'aaaaab03'),
  ], { adressen: [], domeinen: ['praktijk.example'] }, eig, '2026-10-24');
  toets('luiktelling eigen domein: eigen adres is nooit de partij', t2.mails === 2 && t2.draden.get('aaaaab01').richting === '←' && t2.draden.get('aaaaab03').richting === '→' && !t2.draden.has('aaaaab02'),
    Array.from(t2.draden.values()));
  // ── organisatie met kaart via dossier; persoonskaart onder het domein telt niet dubbel; luik na de kaart ──
  luikAntw = (b) => ({ query: b.query, mails: [mail('n1', 'Ik <d.proef@gmail.com>', 'Jan <jan@verzonnen.example>', '2026-11-24', 'Deze week', 'n1'),
    mail('n2', 'Jan <jan@verzonnen.example>', 'Ik <d.proef@gmail.com>', '2026-11-24', 'Re: Factuur oktober', 'a00000000000000a', "['SENT']")] });
  let m = maakM();
  let r = await m.mail(sl('org:verzonnen'));
  let x = r.j.mail;
  toets('org: status en kenmerken', r.status === 200 && x.kenmerken === true, r);
  toets('org: telling = kaart + luik (persoonskaart niet dubbel)', x.aantal === 42 && x.gesprekken === 13 && x.kaart.mails === 40 && x.kaart.aantal === 1 && x.luik.mails === 2 && x.luik.gesprekken === 1, x);
  toets('org: laatste = deze week uit het luik', x.laatste === '2026-11-24' && x.luik.vanaf === '2026-10-25', x);
  toets('org: vijf wisselingen, luik vervangt doorlopend kaartgesprek', x.wisselingen.length === 5 && x.wisselingen[0].bron === 'luik' && x.wisselingen.filter((w) => w.onderwerp === 'Factuur oktober').length === 0
    && x.wisselingen.some((w) => w.onderwerp === 'Re: Factuur oktober' && w.richting === 'verstuurd') && x.wisselingen[2].bron === 'kaart' && x.wisselingen[2].onderwerp === 'Offerte', x.wisselingen);
  toets('org: zoekvraag op het kaartdomein, na de kaartdag', vragen.length === 1 && /from:verzonnen\.example/.test(vragen[0].query) && /after:\d{10} before:\d{10}/.test(vragen[0].query) && vragen[0].actie === 'mail_zoeken' && vragen[0].max === 25, vragen);
  const na = Date.parse('2026-10-25T00:00:00+02:00') / 1000;
  toets('org: venster begint om middernacht na de kaartdag', vragen[0].query.indexOf('after:' + na + ' ') > 0, vragen[0].query);
  toets('org: mailkaart om te openen', x.kaarten.length === 1 && x.kaarten[0].pad === MK + 'Organisaties/Verzonnen BV.md', x.kaarten);
  // cache: tweede keer geen nieuwe luikvraag
  r = await m.mail(sl('org:verzonnen'));
  toets('cache: tweede opening vraagt Gmail niet opnieuw', vragen.length === 1 && r.j.mail.aantal === 42, vragen.length);
  NU += 31 * 60000;
  await m.mail(sl('org:verzonnen'));
  toets('cache: na 30 min opnieuw', vragen.length === 2, vragen.length);

  // ── register via domein-kenmerk ──
  vragen.length = 0; luikAntw = () => ({ mails: [] });
  r = await m.mail(sl('org:klein')); x = r.j.mail;
  toets('register: via domein', x.aantal === 3 && x.gesprekken === 2 && x.laatste === '2024-02-02' && x.kaarten.length === 0 && x.kaart.aantal === 1 && x.wisselingen.length === 2, x);

  // ── persoon: via adres/domein alleen persoonskaarten (review MOET 1) ──
  vragen.length = 0; NU += 31 * 60000;
  r = await m.mail(sl('per:jan')); x = r.j.mail;
  toets('persoon: Gmail op zijn adressen, niet op het domein', vragen.length === 1 && /from:jan@verzonnen\.example/.test(vragen[0].query) && !/from:verzonnen\.example/.test(vragen[0].query), vragen);
  toets('persoon: eigen kaart, niet de organisatie of het register', x.kaart && x.kaart.aantal === 1 && x.kaart.mails === 9 && x.kaarten[0].pad === MK + 'Personen/Jan Verzonnen.md', x);
  // ── geen kenmerk: eerlijke regel, geen luikvraag ──
  vragen.length = 0;
  r = await m.mail(sl('org:zonder')); x = r.j.mail;
  toets('geen kenmerk: kenmerken false, geen Gmail', x.kenmerken === false && x.aantal === 0 && vragen.length === 0, x);
  r = await m.mail(sl('org:vrij')); x = r.j.mail;
  toets('gratis domein als kenmerk telt niet', x.kenmerken === false && vragen.length === 0, x);

  // ── alleen het luik (voorgesteld mailadres, geen kaart): venster na de algemene momentopname ──
  luikAntw = () => ({ mails: [mail('p1', 'Ik <d.proef@gmail.com>', 'Info <info@nieuw.example>', '2026-11-23', 'Welkom', 'p1')] });
  r = await m.mail(sl('org:alleenluik')); x = r.j.mail;
  toets('alleen luik: telling en bron', x.kenmerken === true && x.kaart === null && x.aantal === 1 && x.luik.mails === 1 && x.luik.vanaf === '2026-10-25' && x.wisselingen[0].bron === 'luik' && /from:info@nieuw\.example/.test(vragen[0].query), x);

  // ── eigen entiteit: hoofdpagina met 'mailkaart:' ──
  vragen.length = 0; luikAntw = () => ({ mails: [] });
  r = await m.mail(sl('PR')); x = r.j.mail;
  toets('eigen: via hoofdpagina en mailkaart:', x.aantal === 5 && x.kaarten[0].pad === MK + 'Personen/Kees Proef.md' && x.wisselingen[0].richting === 'beide', x);
  toets('eigen: gratis adres wel als adres (exact), niet als domein', /from:kees\.proef@gmail\.com/.test(vragen[0].query) && !/from:gmail\.com/.test(vragen[0].query), vragen[0] && vragen[0].query);

  // ── privépersoon uit de vault (geen knoop) via mailadres in het ovis-blok ──
  r = await m.mail(sl('20_Prive/Familie/Piet Pagina.md'));
  toets('privépersoon: registerregel via ovis-mailadres', r.status === 200 && r.j.mail.aantal === 2 && r.j.mail.laatste === '2022-05-05', r);

  vragen.length = 0; luikAntw = () => ({ mails: [] });
  r = await m.mail(sl('20_Prive/Familie/Ria Relatie.md'));
  toets('persoon met organisatiekaart: kaart wel, domein niet in Gmail (ronde 2)', r.j.mail.kaart && r.j.mail.kaart.mails === 40 && (vragen.length === 0 || !/verzonnen\.example/.test(vragen[0].query)), { mail: r.j.mail.luik, vragen });
  // ── 25 = venster halveren; budget; fout; uurgrens ──
  vragen.length = 0;
  const vijfentwintig = () => ({ mails: Array.from({ length: 25 }, (_, i) => mail('v' + vragen.length + '-' + i, 'Ik <d.proef@gmail.com>', 'info@nieuw.example', '2026-11-' + String(1 + (i % 20)).padStart(2, '0'), 'x', (0xb00000 + vragen.length * 100 + i).toString(16))) });
  luikAntw = vijfentwintig;
  m = maakM();
  r = await m.mail(sl('org:alleenluik')); x = r.j.mail;
  toets('vol: halveren tot hooguit 4 vragen, dan "minstens"', vragen.length >= 2 && vragen.length <= 4 && x.luik.vol === true && x.luik.mails > 25, { n: vragen.length, luik: x.luik });
  vragen.length = 0;
  const trageLuik = async (b) => { vragen.push(b); NU += 8000; return vijfentwintig(); };
  m = maakM({ luik: trageLuik });
  r = await m.mail(sl('org:alleenluik'));
  toets('budget: na 7 s geen nieuwe vraag', vragen.length === 1 && r.j.mail.luik.vol === true, vragen.length);
  m = maakM({ luik: async () => { throw new Error('time-out'); } });
  r = await m.mail(sl('org:verzonnen')); x = r.j.mail;
  toets('luikfout: kaart blijft, eerlijke fout', r.status === 200 && x.aantal === 40 && x.luik.fout && x.laatste === '2026-10-20', x);
  let n = 0;
  m = maakM({ luik: async () => { n++; return { melding: 'Gmail weigert' }; } });
  r = await m.mail(sl('org:verzonnen'));
  toets('luikmelding = fout, niet bewaard', r.j.mail.luik.fout && (await m.mail(sl('org:verzonnen')), n === 2), n);
  n = 0;
  m = maakM({ luik: async () => { n++; return { mails: [] }; } });
  for (let i = 0; i < 70; i++) { m.vergeet(); await m.mail(sl('org:verzonnen')); }
  r = await m.mail(sl('org:alleenluik'));
  toets('uurgrens: hooguit 60 luikvragen per uur', n === 60 && /vaak/.test(r.j.mail.luik.fout || ''), { n, luik: r.j.mail.luik });
  m = maakM({ luik: undefined });
  r = await m.mail(sl('org:verzonnen'));
  toets('geen luik in deze pod: kaart + uitleg', r.j.mail.aantal === 40 && /niet in deze pod/.test(r.j.mail.luik.fout), r.j.mail.luik);
  r = await m.mail('ffffffffffff');
  toets('onbekende sleutel = 404', r.status === 404, r);
  r = await m.mail('xyz');
  toets('ongeldige sleutel = 400', r.status === 400, r);

  // ── server.js: route en opties ──
  const s = fs.readFileSync('server.js', 'utf8');
  toets('server: route /mail onder de entiteit-sleutel', /\/\^\(\[0-9a-f\]\{12\}\)\\\/mail\$\/\.exec\(id\)/.test(s) && /B\.mail\(mm\[1\]\)/.test(s));
  toets('server: luik alleen via appAgendaApi en eigen adressen uit router.json', /luik: function \(body\) \{ return appAgendaApi\(body, \{ timeoutMs: 14000 \}\); \},   \/\/ wv4009/.test(s) && /eigenAdressen: function \(\) \{ const j = intakeRouterStand\(\);[^\n]*wv4009/.test(s));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
