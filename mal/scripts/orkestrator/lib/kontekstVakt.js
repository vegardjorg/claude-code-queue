// =============================================================
// kontekstVakt.js: ren logikk for kontekstvakta (hook-kontekst.mjs og hook-etter-kompakt.mjs).
// Se docs/orchestration.md.
//
// Tersklene (tokens, overstyrbare med miljøvariabler):
//   - VARSEL 250k (KONTEKST_VARSEL): påminnelse til modellen og melding til eieren, alle økter.
//   - STOPP 400k (KONTEKST_STOPP): meldingen stoppes (decision: block) i økter som IKKE er den aktive orkestratoren.
//   - AVVIKLING 350k (KONTEKST_AVVIKLING): den aktive orkestratoren går i avvikling. Hooken setter `avvikling` i
//     orkestrator-markøren (<datamappe>/orkestrator.json); `ko.mjs neste/start/fyll` nekter da (exit 6), mens mottak,
//     review, retterunder, fletting og `sett ferdig` går som før. Beskjeden er «komprimer nå».
//   - STOPP_ORK 550k (KONTEKST_STOPP_ORK): hard stopp også for orkestratoren.
//   - KOMPAKT 280k (KONTEKST_KOMPAKT): den aktive orkestratoren får et forslag om å komprimere (/compact med fokus,
//     ferdig linje i KOMPAKT_KOMMANDO som eieren limer inn). Komprimering er standard: det finnes ingen fast grense
//     for antall komprimeringer, og syklusen starter på nytt etter hver komprimering. AVVIKLING og STOPP_ORK er
//     nødbremsen når eieren ikke har komprimert. Etter en komprimering legger hook-etter-kompakt.mjs køtilstanden og
//     en gjenopptaksinstruks inn igjen (etterKompaktTekst) og opphever avviklingen for økta (utenAvvikling). Ny økt
//     (/ko i nytt vindu) er bare en nødløsning (økta har hengt eller er ødelagt).
//   - Modus: `ko.mjs kompakt auto|manuell` setter grenser.autokompakt i ko.json (kompaktModus). Manuell: varsel
//     med ferdig /compact-linje. Auto: Claude Code komprimerer selv (eieren har satt /autocompact), og køen
//     gjenopptas automatisk; linja står bare som reserve. Modusen vises i hook-meldingene og på tavla.
//   - Overleveringslappen er løpende (OVERLEVERING_LAPP): orkestratoren holder den oppdatert etter hver fletting og
//     hver avgjørelse fra eieren, så både komprimering og en eventuell nødrotasjon er billig.
// «fortsett:» først i meldingen slipper alltid gjennom.
//
// Systemmeldinger stoppes ALDRI: Claude Code kjører UserPromptSubmit-hooken også for meldinger som køes inn uten at
// eieren skriver dem, nemlig <task-notification> (bakgrunnsagent ferdig) og <agent-message> (SubagentHandback).
// Stoppes de («UserPromptSubmit operation blocked by hook» i transkriptet), når de leverte sporene aldri modellen, og
// køen fryser. Se hook-kontekst.mjs-headeren.
//
// Hvem er orkestratoren? Markøren har bare et fritt økt-navn, og ko.mjs vet ikke hvilken Claude Code-økt som kaller
// den. Hooken får derimot session_id og transkriptet. Regelen (orkestratorBinding): den økta som SIST kjørte et
// orkestratorkall (`ko.mjs orkestrator puls`, `ko.mjs start`, `ko.mjs fyll`, sett i sitt eget transkript), mens
// markøren er aktiv, er orkestratoren. Hooken binder da markøren til økta (okt_id = session_id, okt_id_tid = tid for
// kallet). Tar en annen økt over (nyere kall), flyttes bindingen og en avvikling som tilhørte forrige økt nullstilles.
// `ko.mjs orkestrator puls --okt "<nytt navn>"` nullstiller også (koLogikk.nyMarkor), og `orkestrator stopp` fjerner
// markøren. Ingen I/O her; testet i lib/__tests__/kontekstVakt.test.ts.
// =============================================================
'use strict';

const { orkestratorStatus, ORKESTRATOR_UTLOP_MS } = require('./koLogikk.js');

const STANDARD = Object.freeze({
  varsel: 250_000,
  stopp: 400_000,
  avvikling: 350_000,
  stoppOrk: 550_000,
  kompakt: 280_000,
});

/** Tersklene, med overstyring fra miljøvariablene (ugyldige eller tomme verdier gir standard). */
function grenser(env = {}) {
  const tall = (v, std) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : std;
  };
  // Ingen grense for antall komprimeringer; komprimering er standard uansett antall.
  return {
    varsel: tall(env.KONTEKST_VARSEL, STANDARD.varsel),
    stopp: tall(env.KONTEKST_STOPP, STANDARD.stopp),
    avvikling: tall(env.KONTEKST_AVVIKLING, STANDARD.avvikling),
    stoppOrk: tall(env.KONTEKST_STOPP_ORK, STANDARD.stoppOrk),
    kompakt: tall(env.KONTEKST_KOMPAKT, STANDARD.kompakt),
  };
}

/** Meldinger Claude Code køer inn selv (agent ferdig, hand-back): de stoppes aldri. */
const SYSTEMMELDING = /^\s*<(task-notification|agent-message|teammate-message)\b/;
function erSystemmelding(prompt) {
  return SYSTEMMELDING.test(String(prompt ?? ''));
}

/** «fortsett:» først i meldingen: eieren sender den likevel. */
function erOverstyrt(prompt) {
  return /^\s*fortsett:/i.test(String(prompt ?? ''));
}

/** Kommandoer bare orkestratoren kjører (de pulser markøren). `ko.mjs sky start` og `sett` teller ikke. */
const ORKESTRATORKALL = /ko\.mjs["']?\s+(?:orkestrator\s+puls|start|fyll)\b/;

/**
 * Tidspunktet (ms) for det siste orkestratorkallet i transkriptteksten (JSONL, gjerne bare halen), eller null.
 * Et kall er en tool_use fra assistenten med `input.command` som matcher ORKESTRATORKALL.
 */
function sisteOrkestratorKall(tekst) {
  const linjer = String(tekst ?? '').split('\n');
  for (let i = linjer.length - 1; i >= 0; i--) {
    const l = linjer[i];
    if (!l.includes('ko.mjs') || !l.includes('tool_use')) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue; // første linje i halen kan være kuttet
    }
    if (o?.type !== 'assistant' || !Array.isArray(o?.message?.content)) continue;
    const treff = o.message.content.some(
      (c) => c?.type === 'tool_use' && ORKESTRATORKALL.test(String(c?.input?.command ?? '')),
    );
    if (!treff) continue;
    const t = Date.parse(o.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Er denne økta den aktive orkestratoren, og må markøren bindes på nytt?
 * @param {{ markor: object|null, sessionId: string|null, sisteKall: number|null, naa?: number }} inn
 * @returns {{ orkestrator: boolean, markor: object|null, endret: boolean }}
 *   `markor` er den (ev. oppdaterte) markøren; `endret` = hooken skal skrive den.
 */
function orkestratorBinding({ markor, sessionId, sisteKall, naa = Date.now() }) {
  const nei = { orkestrator: false, markor, endret: false };
  if (!markor || !sessionId || !orkestratorStatus(markor, naa).aktiv) return nei;
  const tid = markor.okt_id_tid ?? Number.NEGATIVE_INFINITY;
  const ferskKall = sisteKall != null && naa - sisteKall <= ORKESTRATOR_UTLOP_MS;
  if (markor.okt_id === sessionId) {
    if (ferskKall && sisteKall > tid)
      return { orkestrator: true, markor: { ...markor, okt_id_tid: sisteKall }, endret: true };
    return { orkestrator: true, markor, endret: false };
  }
  if (!ferskKall || sisteKall < tid) return nei;
  // Denne økta har gjort et nyere orkestratorkall enn den bundne: den har tatt over.
  const ny = { ...markor, okt_id: sessionId, okt_id_tid: sisteKall };
  if (ny.avvikling && ny.avvikling.okt_id !== sessionId) delete ny.avvikling;
  return { orkestrator: true, markor: ny, endret: true };
}

/** Er markøren i avvikling for akkurat denne økta? */
function iAvvikling(markor, sessionId) {
  return Boolean(markor?.avvikling && markor.avvikling.okt_id === sessionId);
}

/**
 * Antall komprimeringer (/compact, manuelle og automatiske) i transkriptteksten til økta: rader med
 * `type: "system"` og `subtype: "compact_boundary"`. Claude Code skriver én slik rad i samme JSONL-fil (samme
 * session_id) hver gang økta komprimeres. Hver kandidatlinje parses, så tekst som bare SITERER feltet (f.eks. et
 * oppdrag i en brukermelding, der anførselstegnene er escapet) ikke telles.
 */
function tellKomprimeringer(tekst) {
  let antall = 0;
  for (const l of String(tekst ?? '').split('\n')) {
    if (!l.includes('compact_boundary')) continue;
    try {
      const o = JSON.parse(l);
      if (o?.type === 'system' && o?.subtype === 'compact_boundary') antall++;
    } catch {
      // kuttet eller ødelagt linje: telles ikke
    }
  }
  return antall;
}

/**
 * Den løpende overleveringslappen: én fast fil i datamappa (konfig().dataMappe, relativt til rota) som orkestratoren
 * holder oppdatert etter hver fletting og hver avgjørelse fra eieren. Navnet passer mønsteret `overlevering-*.md`
 * som ko-overtak.mjs viser øverst (nyeste etter mtime).
 */
function lappSti() {
  let mappe = 'scripts/.ko';
  try {
    mappe = String(require('./koKonfig.js').konfig().dataMappe || mappe);
  } catch {
    // ingen konfig: standardmappa
  }
  return `${mappe.replace(/\\/g, '/').replace(/\/+$/, '')}/overlevering-lopende.md`;
}
const OVERLEVERING_LAPP = lappSti();

/** Linja eieren limer inn (modellen kan ikke kjøre /compact selv). Fokuset er det som ellers går tapt. */
const KOMPAKT_KOMMANDO =
  `/compact behold: alt i ${OVERLEVERING_LAPP}, aktive spor (id, status, gren, HEAD ved start), åpne eierspørsmål, ` +
  'upushede commits, scratchpad-stien, neste kommando';

/** Kommandoene eieren bruker for å slå automatisk komprimering i Claude Code på og av. */
const AUTOCOMPACT_PAA = '/autocompact 300k';
const AUTOCOMPACT_AV = '/autocompact auto';

/** Komprimeringsmodus fra køfila: grenser.autokompakt = true gir 'auto', alt annet 'manuell' (standard). */
function kompaktModus(ko) {
  return ko?.grenser?.autokompakt === true ? 'auto' : 'manuell';
}

/** Modusen i klart språk, slik den står i meldingene. */
function modusTekst(modus) {
  return modus === 'auto'
    ? 'automatisk komprimering (ko.mjs kompakt manuell slår den av)'
    : 'manuell komprimering (ko.mjs kompakt auto slår på automatisk)';
}

/**
 * Fokus for oppsummeringen når økta komprimeres. PreCompact-hooken (hook-etter-kompakt.mjs) skriver det på stdout, og
 * Claude Code legger det til komprimeringsinstruksen, også ved automatisk komprimering der ingen linje limes inn.
 */
function forKompaktInstruks() {
  return (
    'Køens orkestratorøkt komprimeres. Behold: alt i ' +
    `${OVERLEVERING_LAPP} (stien, og at den skal leses først), aktive spor (id, status, gren, HEAD ved start, ` +
    'agent-id), review-pakker og reviewere, åpne eierspørsmål med anbefaling, eierens avgjørelser fra denne økta, upushede ' +
    'commits, scratchpad-stien og neste kommando. Detaljer som står i ko.json eller i lappen, kan kortes ned.'
  );
}

/**
 * Hva hooken skal gjøre.
 * @param {{ n: number|null, prompt: string, orkestrator: boolean, iAvvikling?: boolean, g?: object }} inn
 *   (et `komprimeringer`-felt godtas, men påvirker ikke beslutningen lenger; antallet vises bare i meldingene)
 * @returns {{ handling: 'ingen'|'varsel'|'kompakt'|'avvikling'|'stopp', settAvvikling: boolean, grense?: number }}
 *
 * Orkestratoren: fra KOMPAKT (280k) foreslås /compact med fokus, etter hver komprimering på nytt (ingen
 * fast grense som utløser rotasjon). AVVIKLING (350k) og STOPP_ORK (550k) er nødbremsen når eieren ikke komprimerer.
 */
function vurder({ n, prompt, orkestrator, iAvvikling: allerede = false, g = grenser() }) {
  const ingen = { handling: 'ingen', settAvvikling: false };
  if (n == null || !Number.isFinite(n)) return ingen;
  const kanStoppes = !erSystemmelding(prompt) && !erOverstyrt(prompt);
  if (orkestrator) {
    const settAvvikling = n >= g.avvikling && !allerede;
    if (n >= g.stoppOrk && kanStoppes)
      return { handling: 'stopp', settAvvikling, grense: g.stoppOrk };
    if (n >= g.avvikling) return { handling: 'avvikling', settAvvikling };
    if (n >= g.kompakt) return { handling: 'kompakt', settAvvikling: false };
    if (n >= g.varsel) return { handling: 'varsel', settAvvikling: false };
    return ingen;
  }
  if (n >= g.stopp && kanStoppes)
    return { handling: 'stopp', settAvvikling: false, grense: g.stopp };
  if (n >= g.varsel) return { handling: 'varsel', settAvvikling: false };
  return ingen;
}

/** Markøren med avviklingsflagget satt for økta. */
function medAvvikling(markor, { sessionId, n, naa = Date.now() }) {
  return {
    ...markor,
    avvikling: { fra: new Date(naa).toISOString(), kontekst: n ?? null, okt_id: sessionId },
  };
}

const k = (n) => `${Math.round(n / 1000)}k`;

/**
 * Hook-utdata (objektet som skrives som JSON på stdout), eller null for ingen utskrift.
 * @param {{ handling: string, settAvvikling: boolean, grense?: number }} b fra vurder()
 * @param {{ n: number, orkestrator: boolean, g?: object, naa?: number, komprimeringer?: number,
 *   modus?: 'auto'|'manuell' }} kontekst  `modus` = kompaktModus(ko.json), standard manuell.
 *
 * Komprimering er standard. Orkestratoren bes aldri rotere; ny økt nevnes bare som nødløsning (økta har
 * hengt eller er ødelagt). Andre økter (spor, eierens egne) får ny økt som før.
 */
function hookUtdata(b, { n, orkestrator, g = grenser(), komprimeringer = 0, modus = 'manuell' }) {
  if (b.handling === 'ingen') return null;
  const auto = modus === 'auto';
  const lapp = OVERLEVERING_LAPP;
  const nod =
    'Ny økt (/ko i nytt vindu) er bare en nødløsning hvis økta har hengt eller er ødelagt.';
  if (b.handling === 'kompakt') {
    const nr = komprimeringer + 1;
    return {
      systemMessage: auto
        ? `Kontekst ca. ${k(n)} tokens. Modus: ${modusTekst(modus)}. Claude Code komprimerer orkestratorøkta av ` +
          `seg selv (komprimering nr. ${nr} i økta), og køen gjenopptas automatisk etterpå. Har det ikke skjedd før ` +
          `ca. ${k(g.avvikling)}, lim inn:\n${KOMPAKT_KOMMANDO}`
        : `Kontekst ca. ${k(n)} tokens: tid for å komprimere orkestratorøkta (komprimering nr. ${nr} i økta; ` +
          `modus: ${modusTekst(modus)}). Når modellen har fullført steget den står i, lim inn:\n` +
          `${KOMPAKT_KOMMANDO}\nAgentene som kjører, beholdes. Nødbrems (avvikling) ved ${k(g.avvikling)}.`,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: auto
          ? `[hook-kontekst] KOMPAKT (ca. ${k(n)} tokens, modus automatisk): Claude Code komprimerer økta av seg ` +
            `selv. Oppdater overleveringslappen ${lapp} nå (aktive spor, review-pakker, åpne eierspørsmål, ` +
            'eierens avgjørelser, scratchpad-stien, neste kommando), så gjenopptaket etterpå er billig. Fortsett vanlig ' +
            'arbeid; etter komprimeringen gir hook-etter-kompakt.mjs en gjenopptaksinstruks.'
          : `[hook-kontekst] KOMPAKT (ca. ${k(n)} tokens, modus manuell): eieren er bedt om å komprimere økta med ` +
            '/compact (du kan ikke kjøre /compact selv). Oppdater overleveringslappen ' +
            `${lapp} nå, fullfør steget du står i (mottak, fletting, sett ferdig) og start ingen lange nye ` +
            'operasjoner midt i. Etter komprimeringen legger hook-etter-kompakt.mjs inn køtilstanden og en ' +
            'gjenopptaksinstruks. Ingen avvikling; agenter som kjører, rapporterer fortsatt til denne økta.',
      },
    };
  }
  if (b.handling === 'stopp') {
    return {
      decision: 'block',
      reason: orkestrator
        ? `Samtalen er på ca. ${k(n)} tokens (stopp ved ${k(b.grense ?? g.stoppOrk)}). Hver melding koster nå ` +
          'nesten tre ganger så mye som etter en komprimering. Komprimer orkestratorøkta nå med linja under ' +
          `(den beholder agentene som kjører). ${nod} Vil du sende meldingen likevel, for eksempel for å be om ` +
          `en oppdatert overleveringslapp, start den med «fortsett:».\n${KOMPAKT_KOMMANDO}`
        : `Samtalen er på ca. ${k(n)} tokens (stopp ved ${k(b.grense ?? g.stopp)}). Hver melding koster nå ` +
          'nesten tre ganger så mye som i en ny økt. Start en ny økt. Vil du sende meldingen likevel, for ' +
          'eksempel for å be om en overleveringslapp, start den med «fortsett:».',
    };
  }
  if (b.handling === 'avvikling') {
    const ny = b.settAvvikling;
    return {
      systemMessage:
        `Kontekst ca. ${k(n)} tokens: orkestratoren er i AVVIKLING (nødbrems fra ${k(g.avvikling)}, hard stopp ` +
        `ved ${k(g.stoppOrk)}; modus: ${modusTekst(modus)}). Ingen nye oppgaver startes; startede gjøres ferdig. ` +
        `Komprimer nå: når modellen har fullført steget den står i, lim inn:\n${KOMPAKT_KOMMANDO}\n` +
        `Avviklingen oppheves av seg selv etter komprimeringen. ${nod}`,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: ny
          ? `[hook-kontekst] AVVIKLING (ca. ${k(n)} tokens). Fra nå: start INGEN nye oppgaver (ko.mjs neste/start/fyll ` +
            'nekter med exit 6). Tillatt: ta imot leverte spor (motta), review, retterunder for allerede startede ' +
            'oppgaver, fletting, db push/deploy for det som flettes, sett ferdig, avklar. Oppdater ' +
            `overleveringslappen ${lapp} (aktive oppgaver med gren/worktree/prompt, review-pakker og reviewere, ` +
            'åpne eierspørsmål, scratchpad-stien, neste kommando), og be eieren komprimere nå med /compact-linja. ' +
            `Avviklingen oppheves etter komprimeringen. Hard stopp ved ${k(g.stoppOrk)}.`
          : `[hook-kontekst] Avvikling pågår (ca. ${k(n)} tokens, hard stopp ved ${k(g.stoppOrk)}): ingen nye ` +
            `starter; gjør ferdig mottak, review og fletting, hold ${lapp} oppdatert, hold svarene korte. ` +
            'Avviklingen oppheves når eieren har komprimert.',
      },
    };
  }
  return {
    systemMessage:
      `Kontekst ca. ${k(n)} tokens (varsel fra ${k(g.varsel)}, ` +
      (orkestrator
        ? `komprimering ved ${k(g.kompakt)}, avvikling ved ${k(g.avvikling)}, stopp ved ${k(g.stoppOrk)}; ` +
          `modus: ${modusTekst(modus)}). Unngå lange pauser i denne økta.`
        : `stopp ved ${k(g.stopp)}). Vurder ny økt med overleveringslapp snart; unngå lange pauser i denne økta.`),
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        `[hook-kontekst] Samtalen er på ca. ${k(n)} tokens. Hold svarene korte` +
        (orkestrator
          ? `, og hold overleveringslappen ${lapp} oppdatert etter hver fletting og hver avgjørelse fra eieren.`
          : ', og foreslå en overleveringslapp og ny økt når det passer (ikke midt i et mottak).'),
    },
  };
}

/** Skal hook-etter-kompakt.mjs legge køtilstanden inn igjen? Bare når markøren er bundet til akkurat denne økta. */
function etterKompaktBundet({ markor, sessionId }) {
  return Boolean(sessionId && markor?.okt_id && markor.okt_id === sessionId);
}

/**
 * Markøren uten avviklingen til økta. Eieren har komprimert (normalveien): da skal ko.mjs
 * neste/start/fyll virke igjen, uansett hvor mange ganger økta er komprimert. Kommer økta over AVVIKLING på nytt,
 * setter hook-kontekst.mjs avviklingen igjen.
 */
function utenAvvikling(markor, sessionId) {
  if (!iAvvikling(markor, sessionId)) return { markor, endret: false };
  const ny = { ...markor };
  delete ny.avvikling;
  return { markor: ny, endret: true };
}

/** Tak for additionalContext etter komprimering (ca. 3k tokens). */
const ETTER_KOMPAKT_MAKS_TEGN = 12_000;

/**
 * Gjenopptaksinstruksen etter komprimering: det orkestratoren skal gjøre med en gang, uten å vente på
 * eieren. Ved automatisk komprimering fortsetter Claude Code turen selv; etter en manuell /compact starter ingen tur
 * av seg selv (SessionStart-hooken kan ikke starte en), så instruksen gjelder da første melding etterpå.
 */
function gjenopptakTekst(modus) {
  return [
    'GJENOPPTA NÅ, uten å vente på eieren:',
    `  1. Les overleveringslappen ${OVERLEVERING_LAPP} (Read; scratchpad-stien og åpne saker står der).`,
    '  2. node scripts/orkestrator/ko.mjs orkestrator puls',
    '  3. Ta imot spor som har levert (rapport.md finnes): node scripts/orkestrator/ko.mjs motta <id>',
    '  4. node scripts/orkestrator/ko.mjs fyll --scratchpad <scratchpad fra lappen>, og start ALLE agentene den ' +
      'lister i samme tur.',
    modus === 'auto'
      ? '  Automatisk komprimering: turen fortsetter av seg selv, så gjør dette nå.'
      : '  Manuell /compact: ingen tur starter av seg selv, så gjør dette i svaret på første melding etterpå, også ' +
        'om den bare er «fortsett».',
    '  Hold lappen oppdatert etter hver fletting og hver avgjørelse fra eieren.',
  ].join('\n');
}

/**
 * additionalContext etter /compact (SessionStart, matcher compact): kort køtilstand som oppsummeringen ellers kan
 * miste, og gjenopptaksinstruksen. Rekkefølgen er valgt slik at det viktigste står først; køvisningen kuttes hvis
 * taket nås.
 * @param {{ vis: string, sporsmal: Array<{ sp: string, tekst?: string|null, anbefaling?: string|null }>,
 *   upushet: number|null, base?: string, komprimeringer: number, avviklingOpphevet?: boolean,
 *   modus?: 'auto'|'manuell', g?: object, maksTegn?: number }} inn
 *   `base` = basegrenen (konfig().baseGren) for linja om upushede commits.
 */
function etterKompaktTekst({
  vis,
  sporsmal,
  upushet,
  base = 'basegrenen',
  komprimeringer,
  avviklingOpphevet = false,
  modus = 'manuell',
  g = grenser(),
  maksTegn = ETTER_KOMPAKT_MAKS_TEGN,
}) {
  const hode = [
    `[hook-etter-kompakt] Økta er komprimert (komprimering nr. ${komprimeringer} i økta; modus: ` +
      `${modusTekst(modus)}). Køtilstanden under er lest fra ko.json nå; stol på den framfor oppsummeringen.`,
    `Neste gang konteksten når ca. ${k(g.kompakt)}, er det tid for en ny komprimering (samme syklus hver gang).`,
  ];
  if (avviklingOpphevet)
    hode.push(
      'Avviklingen for denne økta er opphevet (eieren komprimerte), så ko.mjs fyll virker igjen.',
    );
  hode.push(gjenopptakTekst(modus));
  hode.push(`Upushede commits på ${base}: ${upushet == null ? 'ukjent' : upushet}`);
  const apne = (sporsmal ?? []).map(
    (s) =>
      `  ${s.sp}: ${s.tekst ?? '(mangler tekst)'}${s.anbefaling ? ` (anbefaling: ${s.anbefaling})` : ''}`,
  );
  hode.push(
    apne.length
      ? `Åpne eierspørsmål (${apne.length}):\n${apne.join('\n')}`
      : 'Ingen åpne eierspørsmål.',
  );
  hode.push('Køen (ko.mjs vis):');
  const start = hode.join('\n') + '\n';
  const rest = Math.max(0, maksTegn - start.length);
  const v = String(vis ?? '').trimEnd();
  const kutt = '\n… (kuttet; kjør ko.mjs vis)';
  const kropp = v.length <= rest ? v : v.slice(0, Math.max(0, rest - kutt.length)) + kutt;
  return (start + kropp).slice(0, maksTegn);
}

module.exports = {
  KOMPAKT_KOMMANDO,
  OVERLEVERING_LAPP,
  AUTOCOMPACT_PAA,
  AUTOCOMPACT_AV,
  kompaktModus,
  modusTekst,
  forKompaktInstruks,
  tellKomprimeringer,
  etterKompaktBundet,
  utenAvvikling,
  ETTER_KOMPAKT_MAKS_TEGN,
  etterKompaktTekst,
  STANDARD,
  grenser,
  erSystemmelding,
  erOverstyrt,
  ORKESTRATORKALL,
  sisteOrkestratorKall,
  orkestratorBinding,
  iAvvikling,
  vurder,
  medAvvikling,
  hookUtdata,
};
