'use strict';
// wv3693 (besluitenpagina nr 452 = 3C152, David Ja 21-11-2026 12:42): wat doet Socev terwijl David wacht?
//
// WAAROM. De helft van de antwoorden in het hoofdkanaal komt na 34 s, een kwart na meer dan 68 s, en de app toonde alleen
// "Socev is bezig — 34 s". Met de stappen ziet David na een paar seconden of Socev de goede kant op gaat.
//
// HOE. De CLI schrijft elk afgerond modelbericht meteen in het beurtsessielogboek (gemeten 21-11: tool_use-regel
// 1-3 s na het begin van de modelaanroep, tool_result direct na de tool). runClaude volgt dat logboek al voor de watchdog;
// deze module leest alleen de NIEUWE regels (vanaf de grootte bij de start, en alleen regels met een tijdstempel ná de start)
// en vertaalt elke tool-aanroep via een VASTE tabel naar een korte stap in gewone taal.
//
// PRIVACY (opdracht: patiënt- en privacyveilig). Een stap bevat nooit inhoud: geen zoekterm, onderwerp, naam, bestandsnaam,
// pad of url. De invoer van een tool wordt alleen gebruikt om het SOORT handeling te kiezen (welk script, welke actie); de
// uitvoer is altijd een tekst uit de tabellen hieronder. Onbekend = "zoekt iets op". Niets uit het logboek wordt bewaard of gelogd.

const STAP_ONBEKEND = 'zoekt iets op';
const STAP_ANTWOORD = 'werkt aan het antwoord';
const STAP_MAX = 6;            // in het geheugen; de uitslag geeft er hooguit 3
const ANTWOORD_NA_MS = 3000;   // zo lang na de laatste tool-uitslag zonder nieuwe tool: "werkt aan het antwoord"

// Skills (naam van de skill → stap). Alleen namen die in .claude/skills bestaan; een andere skill = onbekend.
const SKILL = {
  'mailconcept-aanmaken': 'zet een mailconcept klaar', 'mijn-mailstem': 'kijkt hoe jij zulke mails schrijft',
  'mailbijlage-ophalen': 'haalt een bijlage uit je mail', 'onderwerp-oogsten': 'zoekt in je mail',
  'agenda-schrijven': 'maakt een agendavoorstel', 'agenda-wachter': 'kijkt in de agenda', 'praktijk-werkrooster': 'kijkt in het werkrooster',
  'bank-lezen': 'kijkt bij de bank', 'facturen-lezen': 'zoekt in de facturen', 'factuurgenerator': 'maakt een factuur',
  'contacten-opzoeken': 'zoekt een contact op', 'whatsapp-chat-uitlezen': 'leest WhatsApp', 'whatsapp-volglijst': 'kijkt in de WhatsApp-volglijst',
  'telegram-lezen': 'leest Telegram', 'sms-berichten': "kijkt bij je sms'jes", 'health-pod': 'kijkt in je gezondheidsdossier',
  'vault-rag': 'zoekt in je Brain', 'breed-zoeken': 'zoekt breed in alle kanalen', 'waar-is-david': 'kijkt waar je bent',
  'achtergrondagent': 'zet een klus klaar', 'beleggen': 'kijkt naar je beleggingen', 'factcheck': 'controleert de feiten',
  'voorlezen': 'maakt een audiobericht', 'osint': 'zoekt in openbare bronnen', 'ovis-shopper': 'zoekt in webwinkels',
  'fin-datahub': 'zoekt in de financiële cijfers', 'cijfer-meester': 'zoekt sectorcijfers op', 'ovis-nza': 'zoekt in het NZa-dossier',
  'naar-markdown': 'zet een document om', 'reis-plannen': 'werkt aan een reispagina', 'telegram-notitie-intake': 'legt je notitie vast',
  'overleg-agenda-voorbereiding': 'bereidt het overleg voor', 'personeelsgesprek-voorbereiding': 'bereidt het gesprek voor',
  'personeelsgesprek-verwerken': 'werkt het gesprek uit', 'huisartsenzorg-contractgenerator': 'maakt een contract',
  'huisartsenzorg-waarneemovereenkomst': 'maakt een overeenkomst', 'bandjes': 'kijkt naar de telefoonbandjes',
  'werkkamer-forum': 'kijkt op het forum', 'second-brain-verwerk-raw-input': 'verwerkt nieuwe stukken in je Brain',
};

// Scripts in een Bash-aanroep (bestandsnaam zonder pad → stap). De eerste die in de opdracht voorkomt, telt.
const SCRIPT = {
  'bank.py': 'kijkt bij de bank', 'bank-lezer.js': 'kijkt bij de bank', 'facturen.py': 'zoekt in de facturen',
  'hp.py': 'kijkt in je gezondheidsdossier', 'lens.py': 'kijkt in je gezondheidsdossier', 'opgaven.py': 'kijkt in je gezondheidsdossier',
  'clinpgx.py': 'kijkt in je gezondheidsdossier', 'nza.py': 'zoekt in het NZa-dossier', 'zd.py': 'zoekt sectorcijfers op',
  'stemvoorbeeld.py': 'kijkt hoe jij zulke mails schrijft', 'volg.py': 'zet een mailconcept klaar', 'beleggen.py': 'kijkt naar je beleggingen',
  'woordenlijst.py': 'zoekt breed in alle kanalen', 'voorlees.py': 'maakt een audiobericht', 'generate_factuur.js': 'maakt een factuur',
  'generate_contract.js': 'maakt een contract', 'generate_waarneemovereenkomst.js': 'maakt een overeenkomst',
  'osint.py': 'zoekt in openbare bronnen', 'winkel_lezen.py': 'zoekt in webwinkels', 'termijnen.py': 'kijkt naar personeelszaken',
  'wachter-state.py': 'kijkt naar personeelszaken', 'volglijst-personeel.py': 'kijkt naar personeelszaken',
  'telegram-reader.js': 'leest Telegram', 'vault_veilig.py': 'legt iets vast in je Brain', 'werkvoorraad.py': 'zet iets op de lijst',
  'voor-jou.py': 'zet iets op de lijst', 'zoek.py': 'zoekt in je Brain', 'dossier.py': 'leest het dossier', 'md_to_docx.py': 'maakt een document',
  'verplaats-naar-bronnen.py': 'legt iets vast in je Brain', 'oai.py': 'vraagt een ander model om hulp', 'openai-hulp.js': 'vraagt een ander model om hulp',
};

// Acties van de lees-API van n8n ("actie":"…" in een curl-aanroep).
function stapVoorActie(a) {
  if (a === 'mail_lezen') return 'leest een mail';
  if (a === 'mail_bijlage') return 'haalt een bijlage uit je mail';
  if (/^mail_/.test(a)) return 'zoekt in je mail';
  if (/^outlook_/.test(a)) return 'zoekt in je Outlook-mail';
  if (/^(waha|whatsapp|wa)_/.test(a)) return 'kijkt in WhatsApp';
  if (/^david_(plaatsen|wijzigen|verwijderen)$/.test(a)) return 'zet de agenda-afspraak klaar';
  if (/agenda|afspra|kalender/.test(a)) return 'kijkt in de agenda';
  if (/^sms/.test(a)) return "kijkt bij je sms'jes";
  return null;
}

// Commando's die geen stap waard zijn (geen opzoekwerk dat David iets zegt).
const BASH_STIL = /^(date|echo|printf|mkdir|cp|mv|rm|which|pwd|true|false|sleep|cd|export|set|test|touch|chmod|ln|for|do|done|if|then|else|elif|fi|while|until|case|esac|in|local|env|break|continue|return|exit|\{|\}|\[|\[\[|!|\(|\))$/;
const BASH_ZOEK = /^(grep|rg|egrep|ugrep|find|cat|head|tail|sed|ls|awk|wc|less|tree|stat|jq|sort|uniq|cut|tr|xargs|file|nl|column|diff|basename|dirname|realpath|readlink|du|comm|paste|fold|fmt|strings)$/;

function stapVoorBash(cmd) {
  const c = String(cmd || '');
  const actie = /actie\\?"\s*:\s*\\?"([a-z_]+)/.exec(c);
  if (actie) { const s = stapVoorActie(actie[1]); if (s) return s; }
  const scripts = c.match(/[A-Za-z0-9_.-]+\.(?:py|js|mjs|sh)\b/g) || [];
  for (let i = 0; i < scripts.length; i++) if (Object.hasOwn(SCRIPT, scripts[i])) return SCRIPT[scripts[i]];
  if (/(?:127\.0\.0\.1|localhost):8080\/agent\b/.test(c)) return 'zet een klus klaar';
  if (/\bsb-sql\b|\bpsql\b/.test(c)) return 'zoekt in de databank';
  if (/\bcurl\b/.test(c)) return STAP_ONBEKEND;
  if (/\b(pdftotext|pdftoppm|pdfinfo|pandoc|docx2txt)\b/.test(c)) return 'leest een document';
  // De opdrachtwoorden (eerste woord van elk deel na ; && || | of $( ), zonder `cd <map>` en omgevingstoewijzingen.
  const woorden = [];
  // heredoc-inhoud (python3 - <<'EOF' … EOF) is geen opdracht; alleen de regel waarop hij begint telt
  // en tekst tussen aanhalingstekens (grep -E "a|b") ook niet; een regel met \ aan het eind loopt door
  c.replace(/<<-?\s*(['"]?)([A-Za-z_]+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/g, ' $3').replace(/\\\n/g, ' ')
    .replace(/'[^']*'/g, 'Q').replace(/"(?:\\.|[^"\\])*"/g, 'Q').split(/;|&&|\|\||\||\$\(|`|\n/).forEach(function (deel) {
    const w = deel.trim().split(/\s+/).filter(function (x) { return x && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x); });
    if (w.length) woorden.push(w[0].replace(/^.*\//, ''));
  });
  const werk = woorden.filter(function (w) { return !BASH_STIL.test(w); });
  if (!werk.length) return null;
  if (werk.every(function (w) { return BASH_ZOEK.test(w); })) return 'zoekt in je Brain';
  return STAP_ONBEKEND;
}

function stapVoorPad(p, lezen) {
  const s = String(p || '');
  if (/\/io\/[^/]+\/out\//.test(s)) return lezen ? 'leest een eigen werkbestand' : 'maakt een bestand voor je';
  if (/\/io\/[^/]+\/in\//.test(s)) return lezen ? 'leest wat je meestuurde' : 'werkt aan een bestand';
  if (!lezen) return 'legt iets vast in je Brain';
  if (/\.(pdf|docx?|xlsx?|pptx?|odt)$/i.test(s)) return 'leest een document';
  if (/\.(png|jpe?g|gif|webp|heic)$/i.test(s)) return 'bekijkt een afbeelding';
  return 'leest een pagina in je Brain';
}

// Eén tool-aanroep {name, input} → stap (tekst) of null (geen stap tonen). Nooit inhoud uit input in de uitvoer.
function stapVoor(blok) {
  if (!blok || typeof blok !== 'object') return null;
  const n = String(blok.name || ''), inp = (blok.input && typeof blok.input === 'object') ? blok.input : {};
  if (n === 'Bash') return stapVoorBash(inp.command);
  if (n === 'Skill') { const k = String(inp.skill || inp.command || '').replace(/^\//, ''); return Object.hasOwn(SKILL, k) ? SKILL[k] : STAP_ONBEKEND; }
  if (n === 'Read') return stapVoorPad(inp.file_path, true);
  if (n === 'Grep' || n === 'Glob') return 'zoekt in je Brain';
  if (n === 'Write' || n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') return stapVoorPad(inp.file_path || inp.notebook_path, false);
  if (n === 'WebSearch') return 'zoekt op internet';
  if (n === 'WebFetch') return 'leest een webpagina';
  if (n === 'Agent' || n === 'Task') return 'zet een hulpje aan het werk';
  if (/^(ToolSearch|TodoWrite|TaskOutput|TaskStop|Monitor|ScheduleWakeup|ExitPlanMode|EnterPlanMode|ListMcpResourcesTool|ReadMcpResourceTool)$/.test(n)) return null;
  if (/^mcp__playwright__/.test(n)) return 'kijkt op een website';
  if (/^mcp__todoist__/.test(n)) return /__(find|get|fetch|search|view|list|user-info|analyze)/.test(n) ? 'kijkt in Todoist' : 'werkt Todoist bij';
  if (/^mcp__supabase__/.test(n)) return 'zoekt in de databank';
  if (/^mcp__n8n__/.test(n)) return 'kijkt in de automatiseringen';
  if (/^mcp__pubmed__/.test(n)) return 'zoekt in de medische literatuur';
  return STAP_ONBEKEND;
}

// Eén logboekregel (JSON) verwerken in de staat. Alleen regels met tijdstempel >= vanafMs (de start van deze beurt).
function verwerkRegel(st, regel, vanafMs, nu) {
  let o; try { o = JSON.parse(regel); } catch (e) { return; }
  if (!o || typeof o !== 'object') return;
  const ts = Date.parse(o.timestamp || '');
  if (!(ts >= vanafMs)) return;
  const c = o.message && Array.isArray(o.message.content) ? o.message.content : null;
  if (!c) return;
  if (o.type === 'assistant') {
    for (let i = 0; i < c.length; i++) {
      const b = c[i];
      if (!b || b.type !== 'tool_use') continue;
      st.laatst = { soort: 'tool', t: nu };
      if (b.id) st.open[String(b.id)] = true;   // Codex ZOU 2: parallelle tools; pas na de laatste uitslag "werkt aan het antwoord"
      const s = stapVoor(b);
      if (!s) continue;
      const vorige = st.stappen[st.stappen.length - 1];
      if (vorige && vorige.tekst === s) { vorige.t = nu; continue; }   // zelfde soort na elkaar = één stap
      st.stappen.push({ tekst: s, t: nu });
      if (st.stappen.length > STAP_MAX) st.stappen.shift();
    }
  } else if (o.type === 'user') {
    let uitslag = false;
    // een uitslag zonder tool_use_id is niet te koppelen: dan alles dicht
    c.forEach(function (b) { if (b && b.type === 'tool_result') { uitslag = true; if (b.tool_use_id) delete st.open[String(b.tool_use_id)]; else st.open = {}; } });
    if (uitslag && !Object.keys(st.open).length) st.laatst = { soort: 'uitslag', t: nu };
  }
}

// Wat de app krijgt: hooguit 3 stappen (oudste eerst); na een tool-uitslag zonder nieuwe tool ook "werkt aan het antwoord".
function stappenUitslag(progress, nu) {
  const st = progress && progress.stappenStaat;
  if (!st || !st.stappen.length) return [];
  const l = st.stappen.map(function (x) { return x.tekst; });
  if (st.laatst && st.laatst.soort === 'uitslag' && (nu || Date.now()) - st.laatst.t >= ANTWOORD_NA_MS && l[l.length - 1] !== STAP_ANTWOORD) l.push(STAP_ANTWOORD);
  return l.slice(-3);
}

// Het logboek volgen. lees(pad, vanaf, max) → Promise<{buf: Buffer, grootte: number}> (of gooit). Geeft een stopfunctie.
// Alleen nieuwe regels: de eerste meting zet de leespositie op de huidige grootte (een hervatte sessie heeft al megabytes
// geschiedenis); het tijdstempelfilter vangt een regel die tussen de start en die meting viel.
const LEES_MAX = 2 * 1024 * 1024;
const REST_MAX = 16 * 1024 * 1024;   // een regel zonder einde die groter wordt dan dit, slaan we over (enorme tool-uitslag)
function volg(o) {
  const progress = o.progress, lees = o.lees, pad = o.pad, vanafMs = o.vanafMs || Date.now();
  const st = { stappen: [], laatst: null, open: {} };
  progress.stappenStaat = st;
  let positie = null, rest = Buffer.alloc(0), overslaan = false, bezig = false, gestopt = false, fouten = 0;
  async function tik() {
    if (bezig || gestopt) return;
    bezig = true;
    try {
      if (positie === null) {
        const r0 = await lees(pad, 0, 0);
        positie = r0 ? Number(r0.grootte) || 0 : 0;
        return;
      }
      for (let n = 0; n < 8 && !gestopt; n++) {
        const r = await lees(pad, positie, LEES_MAX);
        if (!r || !r.buf || !r.buf.length) break;
        positie += r.buf.length;
        let buf = rest.length ? Buffer.concat([rest, r.buf]) : r.buf;
        let begin = 0, i;
        while ((i = buf.indexOf(10, begin)) >= 0) {
          if (overslaan) overslaan = false;
          else verwerkRegel(st, buf.toString('utf8', begin, i), vanafMs, Date.now());
          begin = i + 1;
        }
        rest = buf.subarray(begin);
        if (rest.length > REST_MAX) { rest = Buffer.alloc(0); overslaan = true; }
        if (positie >= r.grootte) break;
      }
      fouten = 0;
    } catch (e) {
      // nog geen logboek (nieuwe sessie: de CLI maakt hem pas na een paar seconden) = positie 0 en verder
      if (e && (e.code === 'ENOENT' || e.code === 'stat-mislukt' || e.code === 'lees-mislukt' || e.code === 'pad-geweigerd') && positie === null) positie = 0;   // loper: een pad dat (nog) niet bestaat = pad-geweigerd
      else if (++fouten >= 10) stop();
    } finally { bezig = false; }
  }
  const timer = setInterval(tik, o.intervalMs || 2000);
  if (timer.unref) timer.unref();
  tik();
  function stop() { gestopt = true; clearInterval(timer); }
  return stop;
}

// Lezer voor een bestand van de eigen gebruiker (machinekamer, OVIS Code): gewoon fs.
function fsLezer(fs) {
  return async function (pad, vanaf, max) {
    const fh = await fs.promises.open(pad, 'r');
    try {
      const st = await fh.stat();
      const n = Math.max(0, Math.min(max, st.size - vanaf));
      const buf = Buffer.alloc(n);
      const r = n ? await fh.read(buf, 0, n, vanaf) : { bytesRead: 0 };
      return { buf: buf.subarray(0, r.bytesRead), grootte: st.size };
    } finally { await fh.close(); }
  };
}

module.exports = { stapVoor, stappenUitslag, verwerkRegel, volg, fsLezer, STAP_ONBEKEND, STAP_ANTWOORD, SKILL, SCRIPT };
