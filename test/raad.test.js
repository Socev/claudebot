'use strict';
// wv3716 raadzaal: toets raad.js met een nep-forum en nep-modellen (verzonnen vragen, geen persoonsgegevens).
// node test/raad.test.js
const fs = require('fs'), os = require('os'), path = require('path');
const R = require('../raad.js');
let fouten = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (ok ? '' : ' ' + (extra || ''))); if (!ok) fouten++; }

function nepForum() {
  const f = { draden: {}, berichten: [], volgend: 1, geweigerd: [] };
  f.maakDraad = function (forum, titel, auteur, soort, tekst, op) {
    const id = f.volgend++;
    f.draden[id] = { id: id, forum: forum, titel: titel, gemaakt_op: op || new Date().toISOString(), gesloten: 0, gewist_op: null };
    f.bericht(id, auteur, soort, tekst);
    return id;
  };
  f.bericht = function (id, auteur, soort, tekst) {
    const b = { id: f.volgend++, draad_id: id, auteur: auteur, van: auteur, soort: soort, tekst: tekst };
    f.berichten.push(b); return b.id;
  };
  f.api = {
    draden: async function (forum) {
      return { ok: true, draden: Object.values(f.draden).filter(function (d) { return d.forum === forum && !d.gewist_op; }).map(function (d) {
        const bs = f.berichten.filter(function (b) { return b.draad_id === d.id; });
        return Object.assign({}, d, { laatste_bericht_id: bs.length ? bs[bs.length - 1].id : null });
      }) };
    },
    draad: async function (id) { const d = f.draden[id]; if (!d) return { ok: false }; return { ok: true, draad: Object.assign({}, d), berichten: f.berichten.filter(function (b) { return b.draad_id === Number(id); }) }; },
    post: async function (id, b) {
      const d = f.draden[id];
      if (!d || (b.alleen_forum && (d.forum !== b.alleen_forum || d.gesloten))) { f.geweigerd.push(b.als); return { ok: false, status: 409 }; }
      return { ok: true, id: f.bericht(Number(id), b.als, 'bot', b.tekst) };
    },
    nieuw: async function (b) { return { ok: true, id: f.maakDraad(b.forum, b.titel, b.als, 'bot', b.tekst) }; },
  };
  return f;
}
function maakRaad(f, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raad-'));
  const aanroepen = { claude: [], openai: [] };
  const lang = 'Een. Twee. Drie. Vier. Vijf. Zes. Zeven.';
  const r = R.maak(Object.assign({
    staatPad: path.join(dir, 'staat.json'),
    claude: async function (sys, inv, schema, o) {
      aanroepen.claude.push({ sys: sys, inv: inv, model: o.model });
      if (schema.required.indexOf('zou_doen') >= 0) return { ok: true, data: { eens: 'Ze zijn het eens.', oneens: 'Ze botsen op de kosten.', zou_doen: 'Ik zou het proberen.' } };
      return { ok: true, data: { tekst: lang } };
    },
    openai: async function (v) { aanroepen.openai.push(v); return { ok: true, tekst: 'Mijn oordeel. Doe het.' }; },
    vault: async function () { return [{ key: 'vault/00_Systeem/Proef.md', text: 'verzonnen fragment' }]; },
    forum: f.api,
  }, extra || {}));
  return { r: r, dir: dir, aanroepen: aanroepen };
}
function vanIn(f, id) { return f.berichten.filter(function (b) { return b.draad_id === id; }).map(function (b) { return b.van; }); }

(async function () {
  // 1. kapZinnen
  toets('1 kapZinnen houdt 5 zinnen', R._intern.kapZinnen('A. B. C. D. E. F. G.', 5, 900) === 'A. B. C. D. E.');
  toets('1b kapZinnen kapt op tekens', R._intern.kapZinnen('x'.repeat(2000), 5, 900).length <= 900);

  // 2. een draad die vóór de start bestond, telt nooit
  let f = nepForum();
  f.maakDraad('intern', 'Raad: oud', 'david', 'mens', 'oude vraag', '2026-01-01T00:00:00Z');
  let m = maakRaad(f);
  await m.r.tik();
  toets('2 oude draad genegeerd', m.aanroepen.claude.length === 0 && f.berichten.length === 1);

  // 3. nieuwe draad van David in intern → vijf berichten in vaste volgorde
  const id = f.maakDraad('intern', 'Raad: kopen of huren?', 'david', 'mens', 'Verzonnen proefvraag: een tweede echo-apparaat kopen of huren?');
  await m.r.tik();
  let v = vanIn(f, id);
  toets('3 vijf berichten onder eigen naam', JSON.stringify(v) === JSON.stringify(['david', 'rekenaar', 'tegenspreker', 'broncontroleur', 'gpt', 'socev']), JSON.stringify(v));
  toets('3b elke stem ≤ 5 zinnen', f.berichten.filter(function (b) { return b.van === 'rekenaar'; })[0].tekst === 'Een. Twee. Drie. Vier. Vijf.');
  toets('3c modellen per rol', m.aanroepen.claude.map(function (c) { return c.model; }).sort().join(',') === 'claude-opus-5-5,claude-opus-5-5,claude-sonnet-5-5,claude-sonnet-5-5');
  toets('3d vaultfragment alleen bij broncontroleur', m.aanroepen.claude.filter(function (c) { return /verzonnen fragment/.test(c.inv); }).length === 1 && !/verzonnen fragment/.test(m.aanroepen.openai[0].invoer));
  toets('3e socev slot met eens/oneens/zou doen', /\*\*Eens:\*\*[\s\S]*\*\*Oneens:\*\*[\s\S]*\*\*Wat ik zou doen:\*\*/.test(f.berichten[f.berichten.length - 1].tekst));
  toets('3f openai-afnemer raadzaal', m.aanroepen.openai[0].afnemer === 'raadzaal');

  // 4. volgende tik zonder reactie → niets
  let n = f.berichten.length; await m.r.tik();
  toets('4 geen reactie → niets', f.berichten.length === n);

  // 5. bericht van een bot in de draad → geen tweede ronde
  f.bericht(id, 'kees', 'bot', 'ik vind ook wat'); n = f.berichten.length; await m.r.tik();
  toets('5 bot-reactie → niets', f.berichten.length === n);

  // 6. reactie van David → precies één tweede ronde, met zijn reactie erin
  f.bericht(id, 'david', 'mens', 'De tegenspreker vergeet de onderhoudskosten.'); n = f.berichten.length; await m.r.tik();
  toets('6 tweede ronde: vijf berichten', f.berichten.length === n + 5, String(f.berichten.length - n));
  toets('6b reactie zit in de invoer', /onderhoudskosten/.test(m.aanroepen.openai[1].invoer) && /EERSTE RONDE/.test(m.aanroepen.openai[1].invoer));
  toets('6c ronde-2-slot zonder "reageer hieronder"', !/Reageer hieronder/.test(f.berichten[f.berichten.length - 1].tekst));

  // 7. tweede reactie → niets meer
  f.bericht(id, 'david', 'mens', 'En nog iets.'); n = f.berichten.length; await m.r.tik();
  toets('7 derde ronde bestaat niet', f.berichten.length === n);

  // 8. draad buiten intern of door een bot/ander begonnen → niets
  const id2 = f.maakDraad('algemeen', 'Raad: open forum', 'david', 'mens', 'vraag');
  const id3 = f.maakDraad('intern', 'Raad: van een bot', 'pod', 'bot', 'vraag');
  const id4 = f.maakDraad('intern', 'Raad: nep-david als bot', 'david', 'bot', 'vraag');
  const id5 = f.maakDraad('intern', 'Gewoon onderwerp', 'david', 'mens', 'vraag');
  n = f.berichten.length; await m.r.tik(); await m.r.tik();
  toets('8 buiten intern / bot / geen Raad: → niets', f.berichten.length === n && [id2, id3, id4, id5].every(function (i) { return vanIn(f, i).length === 1; }));

  // 9. draad verplaatst uit intern tussen lezen en plaatsen → niets geplaatst (alleen_forum)
  f = nepForum(); m = maakRaad(f);
  await m.r.tik();   // staat met start
  const id6 = f.maakDraad('intern', 'Raad: verplaatst', 'david', 'mens', 'vraag');
  const echtDraad = f.api.draad;
  let keer = 0;
  f.api.draad = async function (i) { keer++; const r = await echtDraad(i); if (keer >= 2) f.draden[i].forum = 'algemeen'; return r; };
  await m.r.tik();
  toets('9 verplaatst → geen stemmen buiten intern', vanIn(f, id6).length === 1, JSON.stringify(vanIn(f, id6)) + ' geweigerd ' + f.geweigerd.join(','));
  f.api.draad = echtDraad;

  // 10. herstart midden in een ronde → niet herhalen, één regel
  f = nepForum(); m = maakRaad(f); await m.r.tik();
  const id7 = f.maakDraad('intern', 'Raad: herstart', 'david', 'mens', 'vraag');
  const staat = JSON.parse(fs.readFileSync(path.join(m.dir, 'staat.json'), 'utf8'));
  staat.draden[String(id7)] = { status: 'bezig', vraag: 'vraag', gemaakt: new Date().toISOString() };
  fs.writeFileSync(path.join(m.dir, 'staat.json'), JSON.stringify(staat));
  await m.r.tik(); await m.r.tik();
  v = vanIn(f, id7);
  toets('10 afgebroken: één regel van socev, geen ronde', JSON.stringify(v) === JSON.stringify(['david', 'socev']) && m.aanroepen.claude.length === 0, JSON.stringify(v));

  // 11. daglimiet
  f = nepForum(); m = maakRaad(f); await m.r.tik();
  const ids = [];
  for (let i = 0; i < R._intern.MAX_RONDES_DAG + 1; i++) { ids.push(f.maakDraad('intern', 'Raad: ' + i, 'david', 'mens', 'vraag ' + i)); }
  for (let i = 0; i < R._intern.MAX_RONDES_DAG + 3; i++) await m.r.tik();
  const laatste = vanIn(f, ids[ids.length - 1]);
  toets('11 daglimiet: zevende draad krijgt één regel', m.r.health().rondes_vandaag === R._intern.MAX_RONDES_DAG && JSON.stringify(laatste) === JSON.stringify(['david', 'socev']), JSON.stringify(laatste));

  // 12. een stem die faalt plaatst één regel, de rest gaat door
  f = nepForum(); m = maakRaad(f, { openai: async function () { return { ok: false, status: 'uit' }; } }); await m.r.tik();
  const id8 = f.maakDraad('intern', 'Raad: openai uit', 'david', 'mens', 'vraag');
  await m.r.tik();
  const gpt = f.berichten.filter(function (b) { return b.draad_id === id8 && b.van === 'gpt'; })[0];
  toets('12 falende stem: eerlijke regel', vanIn(f, id8).length === 6 && /kon nu niet antwoorden/.test(gpt.tekst));

  // 13. proef: pod begint als proef-david; reactie van proef-david → tweede ronde; echte niet-proefdraad als bot telt niet
  f = nepForum(); m = maakRaad(f); await m.r.tik();
  const p = await m.r.proef('Verzonnen proefvraag.');
  await m.r.tik();
  toets('13 proefdraad: vijf berichten', p.ok && vanIn(f, p.id).length === 6);
  f.bericht(p.id, 'proef-david', 'bot', 'proefreactie'); await m.r.tik();
  toets('13b proefreactie → één tweede ronde', vanIn(f, p.id).length === 12);
  const id9 = f.maakDraad('intern', 'Raad (proef): niet geregistreerd', 'proef-david', 'bot', 'vraag');
  await m.r.tik();
  toets('13c niet-geregistreerde proeftitel telt niet', vanIn(f, id9).length === 1);

  console.log(fouten ? fouten + ' ROOD' : 'alles groen');
  process.exit(fouten ? 1 : 0);
})();
