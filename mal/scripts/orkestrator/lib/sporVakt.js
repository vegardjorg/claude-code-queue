// =============================================================
// sporVakt.js: ren logikk for spor-hookene og felles transkript-lesing. Se docs/orchestration.md.
//
// HVORFOR: en stor del av sporkostnaden påløper når sporets kontekst er stor, og taket var bare en regel agenten
// måtte huske. Lesehygienen (utdrag av store filer, ikke les filer som lastes automatisk på nytt) står i oppdraget,
// men blir bare delvis fulgt: agenter leser CLAUDE.md med Read selv om Claude Code laster den automatisk, og leser
// store filer hele i stedet for utdrag. Hooks er deterministiske; instrukser er råd.
//
// Brukes av:
//   hook-kontekst.mjs       (hovedøktene; bruker sisteKontekst + lesHale herfra)
//   hook-spor-kontekst.mjs  (PostToolUse: kontekstvakt for spor-agentene)
//   hook-lesevakt.mjs       (PreToolUse Read: lesevakt for spor- og review-agentene)
//
// Agenttypen: Claude Code legger `agent_id` og `agent_type` i hook-input når hooken fyrer inne i en subagent
// (hook-tid.mjs leser samme felt ved SubagentStart). I hovedøkta mangler feltene, og da gjør vaktene ingenting.
//
// Lesevakten kan utvides per prosjekt i ko.config.json, feltet `lesevakt` (alt er valgfritt):
//   agentTyper   ekstra agenttyper vakta gjelder for (i tillegg til spor, spor-d, reviewer, reviewer-sikkerhet)
//   autoLastet   ekstra filer som lastes automatisk og ikke skal leses hele (filnavn, eller sti relativt til rota)
//   storeFiler   glob-mønstre (relativt til rota, f.eks. "db/migrations/*.sql") for filer som skal leses i utdrag
//                når de er over maksLinjer; migrasjoner.mappe/*.sql tas med automatisk når den er satt
//   maksLinjer   grensen for storeFiler (standard 300)
//   blokkLinjer  alle tekstfiler over så mange linjer leses i utdrag (standard 2000)
//
// Funksjonene her gjør ingen I/O utover lesHale/lesHode/subagentTranskript (som får fs-funksjoner inn), så de kan
// testes (lib/__tests__/sporVakt.test.ts).
// =============================================================

const fs = require('node:fs');
const path = require('node:path');

/** Agenttyper kontekstvakten gjelder for (køens spor-agenter). */
const KONTEKST_TYPER = new Set(['spor', 'spor-d']);
/** Agenttyper lesevakten gjelder for som standard (spor + review-agentene i malen). */
const LESE_TYPER = new Set(['spor', 'spor-d', 'reviewer', 'reviewer-sikkerhet']);
/** Filer Claude Code laster automatisk (eller som eies av minnet), og som ikke skal leses hele på nytt. */
const AUTO_LASTET = Object.freeze(['CLAUDE.md', 'CLAUDE.local.md', 'MEMORY.md']);

/** Standard kontekstterskel for spor (tokens). Overstyres med SPOR_KONTEKST_VARSEL. */
const SPOR_TERSKEL = 280_000;
/** En fil i storeFiler over så mange linjer skal leses i utdrag. Overstyres med LESEVAKT_MAKS_LINJER. */
const MAKS_LINJER = 300;
/** Enhver tekstfil over så mange linjer skal leses i utdrag (Read tar uansett bare de første 2000 linjene). */
const BLOKK_LINJER = 2000;

const HALE_BYTES = 4 * 1024 * 1024; // den siste brukstellingen står i slutten av transkriptet

/**
 * Kontekststørrelse fra den siste assistent-meldingen med `usage` i transkriptet (JSONL-tekst), eller null.
 *
 * Etter en komprimering (`/compact` eller automatisk) står en `compact_boundary`-rad ETTER den siste usage-raden,
 * fordi selve komprimeringskallet ikke logges som assistent-melding. Den siste usage-raden er da størrelsen FØR
 * komprimeringen (f.eks. 346k), og vakten ga falskt varsel, eller stoppet første melding etter /compact når den
 * gamle verdien var over stoppgrensen. Støter vi på grensen før en usage-rad, er størrelsen ukjent til neste svar:
 * returner null (ingen handling). Neste assistent-svar har riktig, liten verdi.
 */
function sisteKontekst(tekst) {
  const linjer = String(tekst || '').split('\n');
  for (let i = linjer.length - 1; i >= 0; i--) {
    const l = linjer[i];
    if (l.includes('"compact_boundary"')) return null;
    if (!l.includes('"usage"')) continue;
    try {
      const o = JSON.parse(l);
      const u = o?.message?.usage;
      if (o?.type !== 'assistant' || !u) continue;
      return (
        (u.input_tokens || 0) +
        (u.cache_read_input_tokens || 0) +
        (u.cache_creation_input_tokens || 0)
      );
    } catch {
      // første linje i halen kan være kuttet midt i; hopp over den
    }
  }
  return null;
}

/** Les de siste `bytes` av en fil som tekst (transkript kan være hundrevis av MB). */
function lesHale(sti, bytes = HALE_BYTES) {
  const fd = fs.openSync(sti, 'r');
  try {
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Les de første `bytes` av en fil som tekst (oppdraget står øverst i transkriptet). */
function lesHode(sti, bytes = 64 * 1024) {
  const fd = fs.openSync(sti, 'r');
  try {
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Stien til SUBAGENTENS eget transkript. `transcript_path` i hook-input er hovedøktas transkript også når hooken
 * fyrer inne i en subagent; subagentens ligger i `<økt-mappe>/<session_id>/subagents/agent-<agent_id>.jsonl`
 * (samme fil som SubagentStop gir som `agent_transcript_path`). Returnerer null når den ikke finnes, så vakten
 * aldri måler hovedøktas kontekst ved en feil.
 * @param {object} inn hook-input
 * @param {(p: string) => boolean} [finnes]
 */
function subagentTranskript(inn, finnes = fs.existsSync) {
  if (!inn || !inn.agent_id) return null;
  const id = String(inn.agent_id);
  const kandidater = [];
  if (inn.agent_transcript_path) kandidater.push(String(inn.agent_transcript_path));
  const tp = inn.transcript_path ? String(inn.transcript_path) : '';
  if (tp) {
    // transcript_path kan allerede peke på subagentens fil
    if (path.basename(tp) === `agent-${id}.jsonl`) kandidater.push(tp);
    const mappe = path.dirname(tp);
    const okt = inn.session_id ? String(inn.session_id) : path.basename(tp, '.jsonl');
    kandidater.push(path.join(mappe, okt, 'subagents', `agent-${id}.jsonl`));
  }
  for (const k of kandidater) {
    try {
      if (finnes(k)) return k;
    } catch {
      // prøv neste
    }
  }
  return null;
}

const tusen = (n) => `${Math.round(n / 1000)}k`;

/**
 * Kontekstvakten: skal spor-agenten få beskjed nå?
 * @param {{ agentType?: string|null, kontekst?: number|null, terskel?: number, utlost?: number[] }} a
 *   utlost = tersklene som allerede har gitt melding for denne agenten.
 * @returns {null | { terskel: number, melding: string }}
 */
function vurderKontekst({ agentType, kontekst, terskel = SPOR_TERSKEL, utlost = [] } = {}) {
  if (!agentType || !KONTEKST_TYPER.has(agentType)) return null; // hovedøkta og andre agenttyper: ingen effekt
  if (typeof kontekst !== 'number' || !Number.isFinite(kontekst)) return null;
  if (!(terskel > 0) || kontekst < terskel) return null;
  if (utlost.includes(terskel)) return null; // én gang per terskel per agent
  return {
    terskel,
    melding:
      `[kontekstvakt] Konteksten din er ca. ${tusen(kontekst)} tokens (vakt ved ${tusen(terskel)}). ` +
      'Fullfør steget du er i, commit, skriv overlevering.md (hva er gjort, hva gjenstår, neste kommando) ' +
      'og lever DELVIS. Hver tur koster nå mye mer enn i et nytt spor.',
  };
}

/** Normaliser en sti til skråstreker, så Windows- og POSIX-stier vurderes likt. */
const norm = (p) => String(p || '').replace(/\\/g, '/');

/** Gjør et glob-mønster (relativt til rota) om til et regulært uttrykk som matcher slutten av en sti. */
function globTilRegex(glob) {
  const g = norm(glob).replace(/^\.\//, '');
  let r = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      r += '(?:.*/)?';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') r += '[^/]*';
    else if (c === '?') r += '[^/]';
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(^|/)${r}$`, 'i');
}

/**
 * Lesevaktas regler, flettet fra standardene og konfig().lesevakt. Uten argumenter leses ko.config.json.
 * @param {{ agentTyper?: string[], autoLastet?: string[], storeFiler?: string[], maksLinjer?: number,
 *   blokkLinjer?: number } | null} [lesevakt]
 * @param {{ mappe?: string|null } | null} [migrasjoner]
 */
function lesRegler(lesevakt, migrasjoner) {
  if (lesevakt === undefined || migrasjoner === undefined) {
    const k = require('./koKonfig.js').konfig();
    if (lesevakt === undefined) lesevakt = k.lesevakt ?? {};
    if (migrasjoner === undefined) migrasjoner = k.migrasjoner ?? {};
  }
  const lv = lesevakt || {};
  const liste = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string' && v) : []);
  const store = liste(lv.storeFiler);
  if (migrasjoner?.mappe) store.push(`${norm(migrasjoner.mappe).replace(/\/+$/, '')}/*.sql`);
  return {
    typer: new Set([...LESE_TYPER, ...liste(lv.agentTyper)]),
    autoLastet: [...AUTO_LASTET, ...liste(lv.autoLastet)],
    storeFiler: store.map(globTilRegex),
    maksLinjer: Number(lv.maksLinjer) > 0 ? Number(lv.maksLinjer) : MAKS_LINJER,
    blokkLinjer: Number(lv.blokkLinjer) > 0 ? Number(lv.blokkLinjer) : BLOKK_LINJER,
  };
}

/** Er stien en fil som lastes automatisk (CLAUDE.md i hvilken som helst mappe, MEMORY.md, prosjektets egne)? */
function erAutoLastet(fil, regler = lesRegler()) {
  const n = norm(fil);
  const navn = path.posix.basename(n);
  return regler.autoLastet.some((a) => {
    const x = norm(a).replace(/^\.\//, '');
    if (!x.includes('/')) return navn === x;
    return n === x || n.toLowerCase().endsWith(`/${x.toLowerCase()}`);
  });
}

/** Er stien en av prosjektets store filer (storeFiler, migrasjoner.mappe/*.sql) som skal leses i utdrag? */
function erStorFil(fil, regler = lesRegler()) {
  const n = norm(fil);
  return regler.storeFiler.some((re) => re.test(n));
}

const IKKE_TEKST = /\.(png|jpe?g|gif|webp|bmp|pdf|ipynb)$/i;

/**
 * Lesevakten: skal denne Read-en avvises?
 * @param {{ agentType?: string|null, filsti?: string, offset?: number, limit?: number, antallLinjer?: number|null,
 *   maksLinjer?: number, regler?: ReturnType<typeof lesRegler> }} a  antallLinjer telles av hooken når limit mangler.
 * @returns {null | { grunn: string }}
 */
function vurderLesing({ agentType, filsti, offset, limit, antallLinjer, maksLinjer, regler } = {}) {
  if (!agentType || !filsti) return null;
  const r = regler ?? lesRegler();
  if (!r.typer.has(agentType)) return null;
  const utdrag = limit != null || offset != null;
  if (erAutoLastet(filsti, r)) {
    // Et utdrag er lov: et spor som skal redigere fila må ha lest den (Edit krever det).
    if (utdrag) return null;
    return {
      grunn:
        `lesevakt: ${path.posix.basename(norm(filsti))} lastes automatisk (CLAUDE.md-filer ved start eller første ` +
        'gang du leser en fil i mappa, minnet ved start). Ikke les den på nytt; innholdet står allerede i konteksten ' +
        'din. Skal du endre fila, finn avsnittet med Grep og les det med offset og limit.',
    };
  }
  if (limit != null || typeof antallLinjer !== 'number' || IKKE_TEKST.test(norm(filsti)))
    return null;
  const maks = maksLinjer ?? r.maksLinjer;
  if (erStorFil(filsti, r) && antallLinjer > maks) {
    return {
      grunn:
        `lesevakt: fila har ${antallLinjer} linjer (grense ${maks} uten limit for denne filtypen). Les i utdrag: ` +
        'Grep -n etter funksjons-, tabell- eller navnet du trenger, så Read med offset og limit rundt treffet.',
    };
  }
  if (antallLinjer > r.blokkLinjer) {
    return {
      grunn:
        `lesevakt: fila har ${antallLinjer} linjer (over ${r.blokkLinjer}). Les i utdrag: Grep -n etter det du ` +
        'trenger, så Read med offset og limit rundt treffet.',
    };
  }
  return null;
}

module.exports = {
  KONTEKST_TYPER,
  LESE_TYPER,
  AUTO_LASTET,
  SPOR_TERSKEL,
  MAKS_LINJER,
  BLOKK_LINJER,
  sisteKontekst,
  lesHale,
  lesHode,
  subagentTranskript,
  vurderKontekst,
  lesRegler,
  globTilRegex,
  erAutoLastet,
  erStorFil,
  vurderLesing,
};
