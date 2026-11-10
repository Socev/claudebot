'use strict';
// OVIS GHAWA fase 3 (wv2883, 10-11-2026; plan vault "01_Ontwikkeling/OVIS GHAWA - plan naar een 8 (Fable 5.2, 10-11-2026)" § 2.3 punt 3, § 8).
// Website zonder Telegram: de pod houdt een eigen werkkopie van Socev/ghawa-site bij (/opt/data/ghawa/site, niet de kapotte /opt/data/repo) en
// werkt per handeling in een wegwerp-werkboom, zodat er nooit half werk in de kopie blijft staan.
//   stand()          berichten (src/content/nieuws) met waar ze staan (live, alleen proefsite, gewijzigd), pagina's, wat er bij Publiceer
//                    meegaat (origin/main...origin/staging), en of het bewerken aan staat.
//   concept(b)       Davids titel, tekst en foto's → één markdown-bericht in Davids eigen woorden (niets herschreven) + foto's opnieuw
//                    gecodeerd (sharp: gedraaid, ≤ 2000 px, ZONDER exif/gps) → bouwen moet slagen → commit op staging → proefsite.
//   weg(b)           een concept dat alleen op de proefsite staat weer weghalen (nooit iets wat al live is).
//   publiceer(b)     staging → main (merge --no-ff), alleen als staging nog precies is wat David zag (sha) en de bouw slaagt. De server
//                    roept dit alleen aan na Davids knop met een verse vingerafdruk, nooit vanaf een vaste plek.
//   vergelijk(...)   de bedragen die de site toont (uit origin/main) naast de app: alleen totalen.
// Grondwet 1: concept en publiceren staan pas aan als het aan-bestand er is (gezet na Davids Ja op de grondwet-aanvulling). Zonder dat
// bestand alleen lezen. Geen donateursnamen of rekeningnummers vanuit de pod naar de site: de pod schrijft alleen wat David typte en zijn
// foto's; staat er toch een naam uit de donateurslijst of een IBAN in, dan zegt de app dat vóór Publiceer (David beslist, niets geschrapt).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const CATEGORIEEN = ['bouw', 'fondsenwerving', 'bestuur', 'ter-plaatse', 'overig'];
const MAX_FOTOS = 6;
const MAX_FOTO = 12 * 1024 * 1024;
const NIEUWS = 'src/content/nieuws';
const ASSETS = 'src/content/assets/nieuws';
const IBAN = /\b[A-Z]{2}\d{2}\s?(?:[A-Z0-9]{4}\s?){2,7}[A-Z0-9]{1,4}\b/;

function slugVan(titel) {
  const s = String(titel || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 50).replace(/-+$/, '') || 'bericht';
}
function yamlTekst(s) { return JSON.stringify(String(s)); }   // JSON-tekst is geldige YAML met dubbele aanhalingstekens
// Frontmatter van een nieuwsbericht: alleen de velden die de lijst toont (geen volledige YAML-lezer nodig).
function kop(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(md || ''));
  const uit = {};
  if (!m) return uit;
  for (const r of m[1].split(/\r?\n/)) {
    const x = /^([a-z_]+):\s*(.*)$/.exec(r);
    if (!x || !x[2]) continue;
    let v = x[2].trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch (e) { v = v.slice(1, -1); } } else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    uit[x[1]] = v;
  }
  uit.fotos = (m[1].match(/^\s+- bron:/gm) || []).length + (uit.hoofdfoto ? 1 : 0);
  return uit;
}
// Samenvatting (20–280 tekens, verplicht in het schema): de eerste zin(nen) van Davids tekst, niets herschreven.
function samenvattingVan(tekst) {
  const plat = String(tekst).replace(/[#*_>`[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (plat.length <= 280) return plat;
  const zinnen = plat.match(/[^.!?]+[.!?]+/g) || [];
  let s = '';
  for (const z of zinnen) { if ((s + z).trim().length > 279) break; s += z; }
  s = s.trim();
  return s.length >= 20 ? s : plat.slice(0, 278).replace(/\s+\S*$/, '') + '…';
}
function markdown(v) {
  const r = ['---', 'titel: ' + yamlTekst(v.titel), 'datum: ' + v.datum, 'samenvatting: ' + yamlTekst(v.samenvatting), 'type: ' + v.type, 'categorie: ' + v.categorie];
  if (v.fotos.length) {
    r.push('hoofdfoto: ' + yamlTekst('../assets/nieuws/' + v.slug + '/' + v.fotos[0].bestand), 'hoofdfoto_alt: ' + yamlTekst(v.fotos[0].alt));
    if (v.fotos.length > 1) {
      r.push('fotos:');
      for (const f of v.fotos.slice(1)) r.push('  - bron: ' + yamlTekst('../assets/nieuws/' + v.slug + '/' + f.bestand), '    alt: ' + yamlTekst(f.alt));
    }
  }
  r.push('---', '', String(v.tekst).replace(/\r\n/g, '\n').trim(), '');
  return r.join('\n');
}
function soortFoto(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.length > 12 && buf.slice(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|mif1|msf1|avif)$/.test(buf.slice(8, 12).toString('latin1'))) return 'heic';
  return null;
}
// Tekst van een .astro/.html-bron zonder opmaak, voor het lezen van bedragen.
function platteTekst(s) { return String(s || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' '); }
const getal = (s) => (s == null ? null : Number(String(s).replace(/\./g, '').replace(',', '.')));
// De bedragen die de site toont tegenover de app. Alleen totalen; een getal dat niet te lezen is, wordt 'niet gevonden' (geen verschil).
function vergelijk(paginas, app) {
  const dd = platteTekst(paginas.donatiedoelen), dn = platteTekst(paginas.doneren);
  let m;
  const site = {};
  if ((m = /Totaal bouw\s+GMD\s*([\d.]+)\s+€\s*([\d.]+)/.exec(dd))) { site.bouw_gmd = getal(m[1]); site.bouw_eur = getal(m[2]); }
  if ((m = /GMD\s*(\d+)\s*=\s*€\s*1\b/.exec(dd))) site.koers = getal(m[1]);
  if ((m = /AFAS[^€]{0,250}€\s*([\d.]+)/.exec(dn))) site.afas_eur = getal(m[1]);
  const rijen = [
    { id: 'bouw_gmd', wat: 'Bouw, totaal begroot', eenheid: 'GMD', site: site.bouw_gmd, app: app.bouw_gmd, waar: 'Donatiedoelen' },
    { id: 'koers', wat: 'Koers (dalasi per euro)', eenheid: 'GMD', site: site.koers, app: app.koers, waar: 'Donatiedoelen' },
    { id: 'afas_eur', wat: 'AFAS Foundation, toegezegd', eenheid: '€', site: site.afas_eur, app: app.afas_eur, waar: 'Doneren' },
  ].map((r) => Object.assign(r, { site: r.site == null ? null : r.site, gelijk: r.site == null || r.app == null ? null : Math.round(r.site) === Math.round(r.app) }));
  return { rijen, verschillen: rijen.filter((r) => r.gelijk === false).length, niet_gevonden: rijen.filter((r) => r.site == null).map((r) => r.id) };
}
function namenIn(tekst, namen) {
  const t = ' ' + String(tekst || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  const hit = [];
  for (const n of namen || []) {
    const s = String(n || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (s.length < 5 || hit.includes(n)) continue;
    const re = new RegExp('(^|[^a-z0-9à-ÿ])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9à-ÿ])');
    if (re.test(t)) hit.push(n);
  }
  return hit;
}

function maak(cfg) {
  const c = Object.assign({ map: '/opt/data/ghawa/site', url: 'https://github.com/Socev/ghawa-site.git', cred: '/opt/data/.git-credentials-socev',
    proefsite: 'https://staging-ghawa.david-e5f.workers.dev', site: 'https://www.ghawa.org', aanPad: '/opt/data/ghawa/site-aan.json',
    logPad: '/opt/data/ghawa/site-log.jsonl', bouwen: true, namen: () => [], nu: () => new Date() }, cfg || {});
  let rij = Promise.resolve();
  let gehaald = 0;
  function opRij(fn) { const p = rij.then(fn, fn); rij = p.then(() => null, () => null); return p; }   // één git-handeling tegelijk
  function draai(cmd, args, opt) {
    return new Promise((ok) => {
      execFile(cmd, args, { cwd: (opt && opt.cwd) || c.map, timeout: (opt && opt.timeout) || 120000, maxBuffer: 32 * 1024 * 1024,
        env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' }, (opt && opt.env) || {}) },
      (fout, stdout, stderr) => ok({ ok: !fout, code: fout ? (fout.code == null ? -1 : fout.code) : 0, out: String(stdout || ''), err: String(stderr || '') }));
    });
  }
  const GIT_C = () => ['-c', 'credential.helper=', '-c', 'credential.helper=store --file=' + c.cred, '-c', 'user.name=OVIS GHAWA (Socev)', '-c', 'user.email=bot@ghawa.org',
    '-c', 'commit.gpgsign=false'];
  const git = (args, opt) => draai('git', GIT_C().concat(args), opt);
  async function gitOk(args, opt) { const r = await git(args, opt); if (!r.ok) throw Object.assign(new Error('git ' + args[0] + ': ' + kortFout(r.err || r.out)), { git: true }); return r.out; }
  function kortFout(s) { return String(s || '').replace(/https?:\/\/[^@\s]*@/g, 'https://').split('\n').filter(Boolean).slice(-3).join(' · ').slice(0, 300); }
  const aan = () => { try { return JSON.parse(fs.readFileSync(c.aanPad, 'utf8')).aan === true; } catch (e) { return false; } };
  function log(x) { try { fs.appendFileSync(c.logPad, JSON.stringify(Object.assign({ op: c.nu().toISOString() }, x)) + '\n', { mode: 0o600 }); } catch (e) { /* log is bijzaak */ } }
  function laatsteLog(n) {
    try { return fs.readFileSync(c.logPad, 'utf8').trim().split('\n').slice(-(n || 5)).map((r) => { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean).reverse(); }
    catch (e) { return []; }
  }
  async function zorgKopie() {
    if (fs.existsSync(path.join(c.map, '.git'))) return;
    fs.mkdirSync(path.dirname(c.map), { recursive: true });
    await gitOk(['clone', '--quiet', c.url, c.map], { cwd: path.dirname(c.map), timeout: 300000 });
  }
  async function haal(dwing) {
    await zorgKopie();
    if (!dwing && Date.now() - gehaald < 60000) return;
    await gitOk(['fetch', '--quiet', '--prune', 'origin']);
    gehaald = Date.now();
  }
  const sha = async (ref) => (await gitOk(['rev-parse', ref])).trim();
  async function boom(ref, map) {   // pad → blob
    const out = await gitOk(['ls-tree', '-r', ref, '--', map]);
    const m = new Map();
    for (const r of out.split('\n')) { const x = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(r); if (x) m.set(x[2], x[1]); }
    return m;
  }
  const toon = (ref, p) => gitOk(['show', ref + ':' + p]);
  const lijstUrl = (basis, slug) => basis.replace(/\/+$/, '') + '/voortgang/' + slug + '/';

  async function stand() {
    await haal(false);
    const [live, proef] = [await sha('origin/main'), await sha('origin/staging')];
    const bm = await boom('origin/main', NIEUWS), bs = await boom('origin/staging', NIEUWS);
    const paden = [...new Set([...bm.keys(), ...bs.keys()])].filter((p) => /\.md$/.test(p)).sort().reverse();
    const namen = c.namen() || [];
    const berichten = [];
    for (const p of paden) {
      const slug = path.basename(p, '.md');
      const waar = !bm.has(p) ? 'proef' : !bs.has(p) ? 'weg-op-proef' : bm.get(p) === bs.get(p) ? 'live' : 'gewijzigd';
      const md = await toon(bs.has(p) ? 'origin/staging' : 'origin/main', p);
      const k = kop(md);
      const b = { slug, titel: k.titel || slug, datum: k.datum || slug.slice(0, 10), samenvatting: k.samenvatting || '', categorie: k.categorie || null, fotos: k.fotos || 0, waar,
        live_url: bm.has(p) ? lijstUrl(c.site, slug) : null, proef_url: bs.has(p) ? lijstUrl(c.proefsite, slug) : null };
      if (waar !== 'live') {
        const let_op = [];
        const n = namenIn(md, namen); if (n.length) let_op.push('noemt ' + (n.length === 1 ? 'een naam' : n.length + ' namen') + ' uit de donateurslijst: ' + n.join(', '));
        if (IBAN.test(md)) let_op.push('bevat iets dat op een rekeningnummer lijkt');
        b.let_op = let_op;
      }
      berichten.push(b);
    }
    const po = await boom('origin/main', 'src/pages');
    const paginas = [...po.keys()].filter((p) => /\.astro$/.test(p) && !/\[/.test(p)).map((p) => {
      const rel = p.slice('src/pages/'.length).replace(/\.astro$/, '').replace(/(^|\/)index$/, '');
      return { pad: '/' + rel, naam: rel ? rel.split('/').pop().replace(/-/g, ' ') : 'home', url: c.site.replace(/\/+$/, '') + '/' + (rel ? rel + '/' : '') };
    }).sort((a, b) => a.pad.localeCompare(b.pad));
    // Wat Publiceer meeneemt: de wijzigingen op staging sinds het gemeenschappelijke punt (drie punten), en of er iets te publiceren is.
    const vooruit = Number((await gitOk(['rev-list', '--count', 'origin/main..origin/staging'])).trim()) || 0;
    const ns = vooruit ? (await gitOk(['diff', '--name-status', '--no-renames', 'origin/main...origin/staging'])).trim().split('\n').filter(Boolean)
      .map((r) => { const [st, p] = r.split('\t'); return { st: st[0], pad: p }; }) : [];
    const berichtPaden = new Set(berichten.filter((b) => b.waar !== 'live').map((b) => b.slug));
    const andere = ns.filter((x) => !(x.pad.indexOf(NIEUWS + '/') === 0 || x.pad.indexOf(ASSETS + '/') === 0));
    return { aan: aan(), proefsite: c.proefsite, site: c.site, live: { sha: live }, proef: { sha: proef, vooruit,
      berichten: berichten.filter((b) => b.waar !== 'live').map((b) => ({ slug: b.slug, titel: b.titel, waar: b.waar })),
      andere: andere.map((x) => x.st + ' ' + x.pad).slice(0, 30), andere_aantal: andere.length, te_publiceren: vooruit > 0 && ns.length > 0, berichten_aantal: berichtPaden.size },
    berichten, paginas, laatste: laatsteLog(5) };
  }

  // Wegwerp-werkboom op een ref; node_modules van de kopie geleend (gelinkt, nooit gecommit: we voegen alleen genoemde paden toe).
  async function inWerkboom(ref, fn) {
    const wb = fs.mkdtempSync(path.join(os.tmpdir(), 'ghawa-site-'));
    fs.rmdirSync(wb);
    await gitOk(['worktree', 'add', '--quiet', '--detach', wb, ref]);
    try {
      if (fs.existsSync(path.join(c.map, 'node_modules'))) fs.symlinkSync(path.join(c.map, 'node_modules'), path.join(wb, 'node_modules'));
      return await fn(wb);
    } finally {
      await git(['worktree', 'remove', '--force', wb]);
      try { fs.rmSync(wb, { recursive: true, force: true }); } catch (e) { /* al weg */ }
      await git(['worktree', 'prune']);
    }
  }
  async function bouw(wb) {
    if (!c.bouwen) return null;
    if (!fs.existsSync(path.join(c.map, 'node_modules'))) {
      const i = await draai('npm', ['ci', '--no-audit', '--no-fund'], { cwd: c.map, timeout: 600000 });
      if (!i.ok) return 'npm ci: ' + kortFout(i.err || i.out);
      fs.symlinkSync(path.join(c.map, 'node_modules'), path.join(wb, 'node_modules'));
    }
    const r = await draai('npm', ['run', 'build'], { cwd: wb, timeout: 300000, env: { ASTRO_TELEMETRY_DISABLED: '1' } });
    return r.ok ? null : 'bouwen mislukt: ' + kortFout((r.out + '\n' + r.err).split('\n').filter((x) => /error|fout|invalid|Error/i.test(x)).join('\n') || r.err || r.out);
  }
  function sharpLaad() {
    const p = c.sharpPad || path.join(c.map, 'node_modules', 'sharp');
    try { return require(p); } catch (e) { return null; }
  }
  const vandaag = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(c.nu());

  async function concept(b) {
    if (!aan()) return { status: 403, ok: false, fout: 'Website bewerken staat nog uit (wacht op je Ja op de kaart over publiceren).' };
    const titel = String((b && b.titel) || '').replace(/\s+/g, ' ').trim();
    const tekst = String((b && b.tekst) || '').replace(/\r\n/g, '\n').trim();
    const categorie = CATEGORIEEN.includes(b && b.categorie) ? b.categorie : 'bouw';
    if (titel.length < 3 || titel.length > 120) return { status: 400, ok: false, fout: 'Titel: 3 tot 120 tekens.' };
    if (tekst.length < 20 || tekst.length > 20000) return { status: 400, ok: false, fout: 'Tekst: minstens 20 tekens (hooguit 20.000).' };
    const fotosIn = Array.isArray(b.fotos) ? b.fotos : [];
    if (fotosIn.length > MAX_FOTOS) return { status: 400, ok: false, fout: 'Hooguit ' + MAX_FOTOS + ' foto\'s per bericht.' };
    const fotos = [];
    if (fotosIn.length) {
      const sharp = sharpLaad();
      if (!sharp) return { status: 503, ok: false, fout: 'Foto\'s kunnen nu niet (de beeldbewerking ontbreekt op de pod); probeer het zonder foto of later.' };
      for (let i = 0; i < fotosIn.length; i++) {
        const f = fotosIn[i] || {};
        const b64 = typeof f.bestand === 'string' ? f.bestand : '';
        if (!b64 || b64.length > Math.ceil(MAX_FOTO * 4 / 3) + 8 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return { status: 400, ok: false, fout: 'Foto ' + (i + 1) + ': leeg of te groot (hooguit 12 MB).' };
        const buf = Buffer.from(b64, 'base64');
        if (!soortFoto(buf)) return { status: 400, ok: false, fout: 'Foto ' + (i + 1) + ': geen jpg, png, webp of heic.' };
        let uit;
        try { uit = await sharp(buf, { failOn: 'error' }).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toBuffer(); }
        catch (e) { return { status: 400, ok: false, fout: 'Foto ' + (i + 1) + ' is niet te lezen.' }; }
        const alt = String(f.alt || '').replace(/\s+/g, ' ').trim();
        fotos.push({ bytes: uit, bestand: 'foto-' + String(i + 1).padStart(2, '0') + '.jpg', alt: alt.length >= 3 ? alt.slice(0, 200) : 'Foto bij: ' + titel });
      }
    }
    return opRij(async () => {
      await haal(true);
      const datum = vandaag();
      const bs = await boom('origin/staging', NIEUWS), bm = await boom('origin/main', NIEUWS);
      let slug = datum + '-' + slugVan(titel), n = 2;
      while (bs.has(NIEUWS + '/' + slug + '.md') || bm.has(NIEUWS + '/' + slug + '.md')) slug = datum + '-' + slugVan(titel) + '-' + n++;
      const v = { titel, tekst, datum, slug, categorie, type: tekst.length > 1200 ? 'lang' : 'kort', samenvatting: samenvattingVan(tekst), fotos };
      if (v.samenvatting.length < 20) return { status: 400, ok: false, fout: 'Tekst: de eerste zin moet minstens 20 tekens hebben.' };
      return inWerkboom('origin/staging', async (wb) => {
        // Staat er op main iets wat staging nog niet heeft (bijv. een vorige publicatie), dan eerst main in staging: de proefsite = live + concepten.
        if (!(await git(['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], { cwd: wb })).ok) {
          const m = await git(['merge', '--no-ff', '--no-edit', '-m', 'Staging bijgewerkt met main (OVIS GHAWA)', 'origin/main'], { cwd: wb });
          if (!m.ok) { await git(['merge', '--abort'], { cwd: wb }); return { status: 409, ok: false, fout: 'De proefsite loopt uit de pas met de site (samenvoegen lukt niet); dat moet de machinekamer oplossen.' }; }
        }
        const md = path.join(wb, NIEUWS, slug + '.md');
        fs.writeFileSync(md, markdown(v));
        const toe = [path.join(NIEUWS, slug + '.md')];
        if (fotos.length) {
          const am = path.join(wb, ASSETS, slug);
          fs.mkdirSync(am, { recursive: true });
          for (const f of fotos) fs.writeFileSync(path.join(am, f.bestand), f.bytes);
          toe.push(path.join(ASSETS, slug));
        }
        const fb = await bouw(wb);
        if (fb) return { status: 422, ok: false, fout: 'Het bericht bouwt niet; er is niets op de proefsite gezet. ' + fb };
        await gitOk(['add', '--'].concat(toe), { cwd: wb });
        await gitOk(['commit', '--quiet', '-m', 'Nieuw bericht (concept, OVIS GHAWA): ' + titel], { cwd: wb });
        const p = await git(['push', '--quiet', 'origin', 'HEAD:refs/heads/staging'], { cwd: wb });
        if (!p.ok) return { status: 409, ok: false, fout: 'Op de proefsite zetten lukte niet (' + kortFout(p.err) + '); probeer het zo opnieuw.' };
        const nieuw = (await gitOk(['rev-parse', 'HEAD'], { cwd: wb })).trim();
        gehaald = 0;
        log({ wat: 'concept', slug, sha: nieuw.slice(0, 12), fotos: fotos.length });
        const let_op = [];
        const nm = namenIn(titel + '\n' + tekst + '\n' + fotos.map((f) => f.alt).join('\n'), c.namen() || []);
        if (nm.length) let_op.push('noemt ' + (nm.length === 1 ? 'een naam' : nm.length + ' namen') + ' uit de donateurslijst: ' + nm.join(', '));
        if (IBAN.test(titel + ' ' + tekst)) let_op.push('bevat iets dat op een rekeningnummer lijkt');
        return { status: 200, ok: true, slug, sha: nieuw, proef_url: lijstUrl(c.proefsite, slug), let_op, samenvatting: v.samenvatting };
      });
    });
  }

  async function weg(b) {
    const slug = String((b && b.slug) || '');
    if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,60}$/.test(slug)) return { status: 400, ok: false, fout: 'onbekend bericht' };
    return opRij(async () => {
      await haal(true);
      const p = NIEUWS + '/' + slug + '.md';
      const bs = await boom('origin/staging', NIEUWS), bm = await boom('origin/main', NIEUWS);
      if (!bs.has(p)) return { status: 404, ok: false, fout: 'Dat concept staat niet (meer) op de proefsite.' };
      if (bm.has(p)) return { status: 409, ok: false, fout: 'Dit bericht staat al op www.ghawa.org; weghalen van de site gaat niet met deze knop.' };
      const titel = kop(await toon('origin/staging', p)).titel || slug;
      return inWerkboom('origin/staging', async (wb) => {
        await gitOk(['rm', '-r', '--quiet', '--', p], { cwd: wb });
        if (fs.existsSync(path.join(wb, ASSETS, slug))) await gitOk(['rm', '-r', '--quiet', '--', ASSETS + '/' + slug], { cwd: wb });
        await gitOk(['commit', '--quiet', '-m', 'Concept weggehaald (OVIS GHAWA): ' + titel], { cwd: wb });
        const r = await git(['push', '--quiet', 'origin', 'HEAD:refs/heads/staging'], { cwd: wb });
        if (!r.ok) return { status: 409, ok: false, fout: 'Weghalen lukte niet (' + kortFout(r.err) + '); probeer het zo opnieuw.' };
        gehaald = 0;
        log({ wat: 'weg', slug });
        return { status: 200, ok: true, slug };
      });
    });
  }

  async function publiceer(b) {
    if (!aan()) return { status: 403, ok: false, fout: 'Publiceren staat nog uit (wacht op je Ja op de kaart over publiceren).' };
    const gezien = String((b && b.sha) || '');
    if (!/^[0-9a-f]{40}$/.test(gezien)) return { status: 400, ok: false, fout: 'Ververs het scherm en probeer opnieuw.' };
    return opRij(async () => {
      await haal(true);
      const proef = await sha('origin/staging');
      if (proef !== gezien) return { status: 409, ok: false, fout: 'De proefsite is veranderd sinds je keek; er is niets gepubliceerd. Kijk opnieuw en druk dan nog eens.' };
      if ((await git(['merge-base', '--is-ancestor', 'origin/staging', 'origin/main'])).ok) return { status: 409, ok: false, fout: 'Er staat niets nieuws op de proefsite.' };
      const ns = (await gitOk(['diff', '--name-only', '--no-renames', '--diff-filter=AM', 'origin/main...' + proef, '--', NIEUWS])).trim().split('\n').filter(Boolean);
      const slugs = ns.filter((p) => /\.md$/.test(p)).map((p) => path.basename(p, '.md'));
      const tijd = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(c.nu());
      return inWerkboom('origin/main', async (wb) => {
        const m = await git(['merge', '--no-ff', '--no-edit', '-m', 'Publiceren op www.ghawa.org (OVIS GHAWA, David met vingerafdruk ' + tijd + ')' + (slugs.length ? ': ' + slugs.join(', ') : ''), proef], { cwd: wb });
        if (!m.ok) { await git(['merge', '--abort'], { cwd: wb }); return { status: 409, ok: false, fout: 'Samenvoegen met de site lukt niet; er is niets gepubliceerd. Dat moet de machinekamer oplossen.' }; }
        const fb = await bouw(wb);
        if (fb) return { status: 422, ok: false, fout: 'De site bouwt niet met deze wijziging; er is niets gepubliceerd. ' + fb };
        const r = await git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], { cwd: wb });
        if (!r.ok) return { status: 409, ok: false, fout: 'Publiceren lukte niet (' + kortFout(r.err) + '); er is niets veranderd. Probeer het zo opnieuw.' };
        const nieuw = (await gitOk(['rev-parse', 'HEAD'], { cwd: wb })).trim();
        gehaald = 0;
        log({ wat: 'publiceer', sha: nieuw.slice(0, 12), proef: proef.slice(0, 12), berichten: slugs });
        return { status: 200, ok: true, sha: nieuw, berichten: slugs, urls: slugs.map((s) => lijstUrl(c.site, s)), site: c.site };
      });
    });
  }

  // De pagina's met bedragen zoals ze op main staan (= wat Cloudflare op www.ghawa.org zet).
  async function sitePaginas() {
    await haal(false);
    const lees = async (p) => { try { return await toon('origin/main', p); } catch (e) { return ''; } };
    return { donatiedoelen: await lees('src/pages/donatiedoelen.astro'), doneren: await lees('src/pages/doneren.astro') };
  }
  return { stand, concept, weg, publiceer, sitePaginas, aan };
}

module.exports = { maak, vergelijk, kop, markdown, samenvattingVan, slugVan, namenIn, soortFoto, CATEGORIEEN };
