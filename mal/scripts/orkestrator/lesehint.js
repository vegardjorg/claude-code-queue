// =============================================================
// lesehint.js: myke lese- og rapporthint for spor-agentene. Se docs/orchestration.md.
//
// Hvorfor: hver tur leser hele konteksten på nytt, så en stor fil lest hel blir betalt i alle senere turer. Lesevakten
// (hook-lesevakt.mjs, lib/sporVakt.js) AVVISER bare filer som lastes automatisk og hele store filer. Her ligger de myke
// hintene, som aldri blokkerer:
//   vurderLeseHint     Read uten offset/limit av en fil over ca. 300 linjer, eller samme fil hel for andre gang.
//   vurderRapportHint  én påminnelse når konteksten passerer ca. 200k: det lange i rapport.md, svaret under taket.
//   vurderBashHint     et Bash-/PowerShell-resultat over ca. 15 000 tegn. Skallutskrift (grep, sed/cat/head, psql) er
//                      ofte den største lesekilden, og lesevakten ser bare Read. Hintet tilpasses kommandoen og gis
//                      høyst BASH_HINT_MAKS ganger per agent, så det aldri selv fyller konteksten.
// Ren logikk; tilstanden (hvilke filer som er lest hele, hva som er sagt) eies av hookene. Test:
// scripts/orkestrator/__tests__/lesehint.test.ts.
// =============================================================

const HINT_LINJER = 300;
const RAPPORT_TERSKEL = 200_000;
const SPOR_TYPER = new Set(['spor', 'spor-d']);
const IKKE_TEKST = /\.(png|jpe?g|gif|webp|bmp|pdf|ipynb)$/;
const BASH_TERSKEL = 15_000; // tegn i ett verktøyresultat
const BASH_HINT_MAKS = 3; // hint per agent; utskriften er dyr, men hintet skal ikke bli støy
const SKALL_VERKTOY = new Set(['Bash', 'PowerShell']);

/** Normalisert nøkkel for en filsti (skråstreker, små bokstaver: Windows skiller ikke på store og små). */
const filNokkel = (p) =>
  String(p || '')
    .replace(/\\/g, '/')
    .toLowerCase();

/**
 * Lesehint for en Read som SLIPPES gjennom (vurder avvisning først med sporVakt.vurderLesing).
 * @param {{ agentType?: string|null, filsti?: string, offset?: number|null, limit?: number|null,
 *   antallLinjer?: number|null, lestHele?: string[], maksLinjer?: number }} a
 *   lestHele = filnøklene agenten allerede har lest hele.
 * @returns {null | { hint: string, nokkel: string|null }} nokkel = filnøkkelen som skal huskes som lest hel.
 */
function vurderLeseHint({
  agentType,
  filsti,
  offset = null,
  limit = null,
  antallLinjer = null,
  lestHele = [],
  maksLinjer = HINT_LINJER,
} = {}) {
  if (!agentType || !SPOR_TYPER.has(agentType) || !filsti) return null;
  if (offset != null || limit != null) return null; // utdrag: alltid greit
  const nokkel = filNokkel(filsti);
  if (IKKE_TEKST.test(nokkel)) return null; // bilder, PDF og notatbøker leses på egne vilkår
  if (lestHele.includes(nokkel)) {
    return {
      nokkel: null,
      hint:
        'lesehint: du har allerede lest denne fila hel i dette sporet, og den ligger i konteksten din. Les bare ' +
        'det som er endret, med Grep og Read med offset og limit.',
    };
  }
  if (typeof antallLinjer === 'number' && antallLinjer > maksLinjer) {
    return {
      nokkel,
      hint:
        `lesehint: fila har ${antallLinjer} linjer (over ${maksLinjer}) og leses hel. Den blir liggende i ` +
        'konteksten og betales i hver senere tur. Neste gang: Grep -n etter det du trenger, så Read med offset ' +
        'og limit rundt treffet.',
    };
  }
  return { nokkel, hint: '' }; // ingen melding, men husk fila som lest hel
}

/**
 * Én påminnelse om rapporttaket når konteksten passerer terskelen.
 * @param {{ agentType?: string|null, kontekst?: number|null, sagt?: boolean, terskel?: number }} a
 * @returns {null | string}
 */
function vurderRapportHint({ agentType, kontekst, sagt = false, terskel = RAPPORT_TERSKEL } = {}) {
  if (!agentType || !SPOR_TYPER.has(agentType) || sagt) return null;
  if (typeof kontekst !== 'number' || !Number.isFinite(kontekst) || kontekst < terskel) return null;
  return (
    `[rapportpåminnelse] Konteksten er over ca. ${Math.round(terskel / 1000)}k. Skriv det lange (gater, ` +
    'selv-review, eierspørsmål, koblingsspesifikasjon) med Write til <mappe>\\rapport.md underveis. Svaret til ' +
    'orkestratoren er bare RESULTAT-linja, høyst 5 linjer og stien til rapport.md (høyst ca. 1 500 tegn).'
  );
}

/**
 * Antall tegn i et verktøyresultat. Bash gir `{ stdout, stderr }`; andre former (ren streng, `{ output }`,
 * innholdsblokker `[{ type: 'text', text }]`) telles også, så hooken tåler at formatet endrer seg.
 * @param {unknown} svar  tool_response fra PostToolUse
 * @returns {number}
 */
function utskriftLengde(svar) {
  if (svar == null) return 0;
  if (typeof svar === 'string') return svar.length;
  if (Array.isArray(svar)) return svar.reduce((sum, x) => sum + utskriftLengde(x), 0);
  if (typeof svar === 'object') {
    const o = /** @type {Record<string, unknown>} */ (svar);
    let sum = 0;
    for (const felt of ['stdout', 'stderr', 'output', 'text', 'content']) {
      if (felt in o) sum += utskriftLengde(o[felt]);
    }
    return sum;
  }
  return 0;
}

/** Hvilken lesekilde kommandoen er (grep, les, psql, annet), for å velge det mest treffende rådet. */
function kommandoType(kommando) {
  const k = String(kommando || '');
  if (/\bpsql\b|pg_get_functiondef|prosrc/i.test(k)) return 'psql';
  if (/\b(?:grep|rg|Select-String)\b/i.test(k)) return 'grep';
  if (/\b(?:sed|cat|head|tail|Get-Content)\b/i.test(k)) return 'les';
  return 'annet';
}

const BASH_RAD = {
  grep: 'grep: begrens treffene med `grep -m 20`, `grep -l` (bare filnavn) eller `| head -40`, og snevre inn stien.',
  les: "sed/cat/head: les et utdrag med `sed -n 'a,bp'` rundt linja du trenger (finn den med `grep -n`), ikke hele fila.",
  psql:
    'psql: velg smalt (bare kolonnene du trenger, `limit`), og hent bare den delen av en funksjonskropp du trenger, ' +
    'f.eks. med `position(...)`/`substr(...)` på `pg_get_functiondef`, ikke hele kroppen.',
  annet: 'Avgrens utskriften med `| head -40` eller `| tail -40`, eller filtrer med `grep -m`.',
};

/**
 * Mykt hint (aldri blokk) når et Bash-/PowerShell-resultat i et spor er stort.
 * @param {{ agentType?: string|null, verktoy?: string|null, kommando?: string, lengde?: number|null,
 *   gitt?: number, terskel?: number, maks?: number }} a  gitt = antall Bash-hint agenten alt har fått
 * @returns {null | string}
 */
function vurderBashHint({
  agentType,
  verktoy,
  kommando = '',
  lengde = null,
  gitt = 0,
  terskel = BASH_TERSKEL,
  maks = BASH_HINT_MAKS,
} = {}) {
  if (!agentType || !SPOR_TYPER.has(agentType) || !verktoy || !SKALL_VERKTOY.has(verktoy))
    return null;
  if (typeof lengde !== 'number' || !Number.isFinite(lengde) || lengde <= terskel) return null;
  if (gitt >= maks) return null;
  const type = kommandoType(kommando);
  const rad = type === 'annet' ? BASH_RAD.annet : `${BASH_RAD[type]} ${BASH_RAD.annet}`;
  return (
    `[utskriftshint] Kommandoen ga ca. ${Math.round(lengde / 1000)}k tegn (over ${Math.round(terskel / 1000)}k). ` +
    `Utskriften blir liggende i konteksten og betales i hver senere tur. ${rad}`
  );
}

module.exports = {
  HINT_LINJER,
  RAPPORT_TERSKEL,
  BASH_TERSKEL,
  BASH_HINT_MAKS,
  SPOR_TYPER,
  filNokkel,
  vurderLeseHint,
  vurderRapportHint,
  utskriftLengde,
  kommandoType,
  vurderBashHint,
};
