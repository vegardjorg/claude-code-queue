// =============================================================
// oppdragTekst.js: ren tekstlogikk for lag-ko-felles.mjs og lag-oppdrag.mjs. Se docs/orchestration.md.
//
// Hvorfor: felles protokoll limes inn i HVER sporprompt og blir liggende i konteksten alle turer. Delene som bare
// gjelder D og D+ (DB, selv-review, full gate) står derfor i klasse-seksjoner som bare tas med for de klassene som
// trenger dem, og pekere som «fil.md § 3» får linjeområdet påført, så sporet leser bare den seksjonen.
//
//   lagKoFelles(mal, scratch, k) felles-delen av oppdragsmalen (docs/ko/mission-template.md), fylt for køen og
//                                prosjektet (k = konfig(): prosjektNavn, baseGren, gater, arkitekturRegler)
//   filtrerKlasse(tekst, k)      tar bare med <!-- klasse: … --> … <!-- /klasse -->-seksjoner som gjelder klassen k
//   klasseFraBlokk(kropp)        klassen i en sporblokk («klasse D+» i ## SPOR-linja, eller en KLASSE:-linje)
//   seksjonsPekere(tekst, les)   påfører «(linje A–B)» bak «fil.md § N» og «fil.md#overskrift»
// Ingen I/O her (les-funksjonen og konfigen injiseres); test: __tests__/oppdragTekst.test.ts.
// =============================================================

const KLASSER = ['K', 'D', 'D+', 'U'];

// Split/join, aldri String.replace (en erstatning med «$'» dupliserer tekst).
const bytt = (s, fra, til) => s.split(fra).join(til);

const KODE = '`';

/** Gatelista som tekst: kommandoene i rekkefølge, eller «ingen satt opp». */
function gateTekst(liste) {
  const l = Array.isArray(liste) ? liste.filter((x) => typeof x === 'string' && x.trim()) : [];
  return l.length ? l.map((x) => KODE + x + KODE).join(', ') : 'none set up in ko.config.json';
}

/**
 * Felles protokoll for køsporene, med plassholderne __GREN__ __HEAD__ __SPOR__ __BLOKK__ igjen (de fylles per spor
 * av lag-oppdrag.mjs). Klassemarkørene beholdes; lag-oppdrag filtrerer per spor.
 * @param {string} mal hele oppdragsmalen (docs/ko/mission-template.md)
 * @param {string} scratch scratchpad-rota
 * @param {{ prosjektNavn?: string, baseGren?: string, gater?: { rask?: string[], full?: string[] },
 *   arkitekturRegler?: string[] }} [k] prosjektets konfig (konfig()); manglende felt gir nøytrale standarder
 */
function lagKoFelles(mal, scratch, k = {}) {
  const start = mal.indexOf('## Felles protokoll');
  if (start < 0) throw new Error('fant ikke «## Felles protokoll» i oppdragsmalen');
  const base = k.baseGren || 'main';
  const regler = Array.isArray(k.arkitekturRegler)
    ? k.arkitekturRegler.filter((r) => typeof r === 'string' && r.trim())
    : [];
  let s = mal.slice(start);
  // Sparemodus: sporet leser bare sin egen del av kilden, i utdrag.
  s = bytt(
    s,
    '<LES_OGSAA>',
    [
      'The source the track block names: read only the part that applies to this track (`grep -n` on the id or',
      '  heading, then excerpts with `offset`/`limit`).',
      ...(regler.length
        ? ['- The project architecture rules (binding, from `ko.config.json`):', ...regler.map((r) => `  - ${r}`)]
        : []),
    ].join('\n'),
  );
  s = bytt(
    s,
    '<EIERSKAP>',
    [
      'Your ownership is listed in the track block. Other tasks run at the same time and own their files',
      '(`node scripts/orkestrator/ko.mjs vis`, works from the worktree). Never touch what they own.',
      '',
      '**New work you discover** (outside the mission, or a follow-up bug): do not do it yourself. Write a JSON file with',
      'Write (id, tittel, domene, klasse K|D|D+|U, oppdrag = short self-contained description, nytte 1-10, innhold_min,',
      'avhenger, venter_paa, eier_filer, delt_patch, kilde, lagt_til_av = your track id) and run',
      '`node scripts/orkestrator/ko.mjs add --fil <file>`. It becomes a proposal the owner approves. Mention the id in',
      'the report, and a HIGH security finding in its own section.',
    ].join('\n'),
  );
  s = bytt(s, '<GREN>', '__GREN__');
  s = bytt(s, '<HEAD>', '__HEAD__');
  s = bytt(s, '<BLOKK>', '__BLOKK__');
  s = bytt(s, '<SPOR>', '__SPOR__');
  s = bytt(s, '<base>', base);
  s = bytt(s, '<scratchpad-rot>', scratch);
  s = bytt(s, '<scratchpad>', scratch);
  const hode = [
    '## SHARED PROTOCOL FOR TRACKS FROM THE WORK QUEUE (binding)',
    '',
    'Made from `docs/ko/mission-template.md`' +
      (k.prosjektNavn ? ` for ${k.prosjektNavn}` : '') +
      '. Other tracks start and finish while you work. The class (K, D, D+, U) is in the track block; the parts ' +
      'below are selected for it.',
    `Base branch: ${KODE}${base}${KODE}. Quick gate: ${gateTekst(k.gater?.rask)}. ` +
      `Full gate: ${gateTekst(k.gater?.full)}.`,
    '',
    '',
  ].join('\n');
  return hode + s.replace(/^## Felles protokoll[^\n]*\n/, '');
}

const START = /^\s*<!--\s*klasse:\s*([^>]*?)\s*-->\s*$/;
const SLUTT = /^\s*<!--\s*\/klasse\s*-->\s*$/;

/**
 * Tar bare med klasse-seksjonene som gjelder klassen. Ukjent eller manglende klasse gir ALT (trygt: ingenting
 * bindende faller bort). Markørlinjene fjernes alltid, og tre eller flere linjeskift slås sammen til to.
 * @param {string} tekst
 * @param {string|null} klasse K, D, D+ eller U
 */
function filtrerKlasse(tekst, klasse) {
  const kjent = KLASSER.includes(klasse);
  const stabel = [];
  const ut = [];
  for (const l of String(tekst).split('\n')) {
    const m = l.match(START);
    if (m) {
      stabel.push(m[1].split(/[\s,]+/).filter(Boolean));
      continue;
    }
    if (SLUTT.test(l)) {
      if (!stabel.length) throw new Error('<!-- /klasse --> uten start');
      stabel.pop();
      continue;
    }
    if (!kjent || stabel.every((liste) => liste.includes(klasse))) ut.push(l);
  }
  if (stabel.length) throw new Error('<!-- klasse: … --> uten <!-- /klasse -->');
  return ut.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Klassen i en sporblokk: en egen «KLASSE: X»-linje vinner, ellers «klasse X» i ## SPOR-overskriften (ko.mjs skriver
 * «## SPOR id (tittel; kilde: …; klasse D+, anslag 40 min)»). Null når den ikke finnes.
 * @param {string} kropp
 */
function klasseFraBlokk(kropp) {
  const linjer = String(kropp).split(/\r?\n/);
  const egen = linjer.find((l) => /^KLASSE:/.test(l));
  const kandidat = egen
    ? egen.slice(7).trim()
    : (linjer.find((l) => /^## SPOR\b/.test(l))?.match(/\bklasse\s+(D\+|[KDU])(?![\w+])/)?.[1] ??
      null);
  return KLASSER.includes(kandidat) ? kandidat : null;
}

/** GitHub-lik slug av en overskrift: små bokstaver, tegnsetting bort, mellomrom til bindestrek. */
function slug(t) {
  return String(t)
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Linjeområdet (1-basert, inklusivt) for seksjonen pekeren gjelder, eller null.
 * § N: overskrift som begynner med N (også «§ N», «N.», «N)» eller «N:»), men ikke N.M når bare N er pekt.
 * #anker: overskrift med samme slug, ellers en som inneholder ankeret (bindestrek som mellomrom).
 * @param {string} tekst hele dokumentet
 * @param {{ paragraf?: string, anker?: string }} p
 */
function seksjonsOmraade(tekst, { paragraf, anker }) {
  const linjer = String(tekst).split(/\r?\n/);
  const overskrifter = [];
  let iKode = false;
  linjer.forEach((l, i) => {
    if (/^```/.test(l)) iKode = !iKode;
    const m = !iKode && l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) overskrifter.push({ i, niva: m[1].length, tekst: m[2] });
  });
  let treff = null;
  if (paragraf) {
    const esc = paragraf.replace(/\./g, '\\.');
    const re = new RegExp(`^(?:§\\s*)?${esc}(?:$|[\\s):]|\\.(?!\\d))`);
    treff = overskrifter.find((o) => re.test(o.tekst.trim()));
  } else if (anker) {
    const a = anker.toLowerCase();
    treff =
      overskrifter.find((o) => slug(o.tekst) === a) ??
      overskrifter.find((o) => o.tekst.toLowerCase().includes(a.replace(/-/g, ' ')));
  }
  if (!treff) return null;
  const neste = overskrifter.find((o) => o.i > treff.i && o.niva <= treff.niva);
  let slutt = neste ? neste.i : linjer.length;
  while (slutt > treff.i + 1 && !linjer[slutt - 1].trim()) slutt--; // tomme linjer på slutten teller ikke
  return { fra: treff.i + 1, til: slutt };
}

// «docs/x.md § 6», «`docs/x.md` § 6.2», «`docs/x.md#overskrift`», også med absolutt Windows-sti. En avsluttende
// backtick tas med i treffet, så «(linje A–B)» havner utenfor kodespennet.
const PEKER =
  /`?((?:[A-Za-z]:[\\/])?[\w.\\/-]*[\w-]\.md)`?(?:\s*§\s*(\d+(?:\.\d+)*)(?![\d.]\d)|#([\p{L}\p{N}_-]+)(?![\p{L}\p{N}_-]))`?(?!`?\s*\(linje)/gu;

/**
 * Påfører «(linje A–B)» bak hver seksjonspeker som kan slås opp. Pekere uten seksjon, og pekere til filer eller
 * seksjoner som ikke finnes, står urørt (bakoverkompatibelt).
 * @param {string} tekst oppdraget
 * @param {(fil: string) => string|null} les leser et dokument (relativ sti fra repo-rota, eller absolutt)
 */
function seksjonsPekere(tekst, les) {
  const cache = new Map();
  const hent = (fil) => {
    if (!cache.has(fil)) {
      let t = null;
      try {
        t = les(fil);
      } catch {
        t = null;
      }
      cache.set(fil, t);
    }
    return cache.get(fil);
  };
  return String(tekst).replace(PEKER, (hel, fil, paragraf, anker) => {
    const dok = hent(fil);
    if (dok == null) return hel;
    const o = seksjonsOmraade(dok, { paragraf, anker });
    return o ? `${hel} (linje ${o.fra}–${o.til})` : hel;
  });
}

module.exports = {
  KLASSER,
  gateTekst,
  lagKoFelles,
  filtrerKlasse,
  klasseFraBlokk,
  seksjonsOmraade,
  seksjonsPekere,
};
