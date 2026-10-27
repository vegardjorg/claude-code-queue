// =============================================================
// koLogikk.js: ren logikk for arbeidskøen (scripts/orkestrator/ko.mjs).
//
// Køen gir kontinuerlig flyt i stedet for faste bølger (docs/queue.md): når en plass blir ledig, startes den høyest
// prioriterte oppgaven som (a) har alle avhengigheter ferdig, (b) ikke venter på et eierspørsmål, og (c) ikke eier
// en fil, et DB-objekt eller en delt patch som en kjørende oppgave eier. Grensene (samtidige, D+, per domene) står i
// køfila under `grenser`.
//
// Prosjekt, funksjon, plukking og QA: oppgaver hører til et prosjekt (eksplisitt felt eller prefiks-regel fra
// registeret `prosjekter`) og en funksjon; en person eller økt kan plukke en oppgave (status `plukket`, eier filene
// sine men tar ingen agentplass); oppgaver med etiketten `visuell` havner i eierens QA-liste når de er ferdige. Alle
// nye felt er valgfrie, så en eldre ko.json virker uendret.
//
// Arbeid utenfor køen: commits på basegrenen (konfig().baseGren) klassifiseres som kø (flett av en køgren,
// konfig().grenPrefiks), orkestrator (traileren «Ko: orkestrator») eller ekstern; eksterne endringer sammenlignes med
// eierfilene; en rad med status `ekstern` (`ko.mjs ekstern add`) eier filer som en plukket oppgave; `neste` hopper over
// oppgaver som kolliderer med ucommittede filer i hovedtreet; push-sjekken finner et trygt kuttpunkt. Git-lesingen
// står i koGit.js.
//
// Eierspørsmål og avklaringer: `sporsmal` har teksten bak id-ene i `venter_paa`, og `avklaringer` har svaret med
// tidsstempel (id-en står fortsatt i `avklart`). Begge er valgfrie.
//
// Samlekøen: `samles: true` (valgfritt) legger en liten, ikke-blokkerende oppgave i samlekøen; den startes og
// plukkes aldri alene, og `samlePakk` slår en gruppe sammen til ett spor av riktig størrelse.
//
// Områder, fokusperiode og parkering: `omrader` over prosjektene, `fokus` med trinn, «resten» og «dratt med», og
// `parkert` per oppgave. Én rangering (koLogikk.rangering) for velgNeste, plukkbare, vis og tilstand. Uten fokus og
// parkerte er resultatet det samme som uten disse feltene.
//
// Orkestratorens rutine som skript og kost per oppgave: kort `vis`, agenttype og agentmelding for `fyll`,
// review-pakken for `motta`, RESULTAT-/FUNN-parserne og kostsummen for `sett ferdig` og `kost`.
//
// Ingen I/O her (bortsett fra at konfig() leses ved behov): CLI-en leser og skriver fila og kaller disse funksjonene.
// Testene ligger i lib/__tests__/.
// =============================================================

/**
 * Konfigen (ko.config.json via koKonfig.js), lest første gang den trengs. Feiler lesingen (f.eks. i en ren test uten
 * konfig), brukes standardverdiene.
 */
let konfigCache = null;
function kfg() {
  if (konfigCache) return konfigCache;
  try {
    konfigCache = require('./koKonfig.js').konfig();
  } catch {
    konfigCache = {};
  }
  return konfigCache;
}
/** Glemmer konfigen som er lest (tester som bytter KO_KONFIG). */
function nullstillKonfig() {
  konfigCache = null;
}
/** Integrasjonsgrenen alt flettes til. */
const baseGren = () => kfg().baseGren ?? 'main';
/** Remoten basegrenen pushes til. */
const remoteNavn = () => kfg().remote ?? 'origin';
/** Prefikset for køgrenene (`<prefiks><id>`). */
const grenPrefiks = () => kfg().grenPrefiks ?? 'ko/';
/** Køgrenen for en oppgave. */
const koGren = (id) => `${grenPrefiks()}${id}`;

/**
 * Vekt per risikoklasse. Anslag = innhold (min for et K-spor) × vekt.
 *
 * `anslag` er IKKE en god veggtid; veggtida avhenger lite av innhold_min. VEKT og anslag styrer prioriteten (nytte
 * per minutt i scoreDeler), størrelsesmålene og skybunt-taket; å endre dem ville stokke om køen. Kalibrert veggtid og
 * kost står i `anslagVegg` og `anslagKost` under.
 */
const VEKT = { K: 1.0, D: 1.3, 'D+': 1.8, U: 0.6 };

/**
 * Kalibrert modell for VEGGTID (startet → ferdig, altså med review og fletting) og KOST (API-ekvivalente USD for spor
 * og reviewere, tidKost.kostUsd) per oppgave: fast + innhold_min × faktor, per klasse. Startverdiene er tilpasset
 * medianene for ferdige køspor i et reelt prosjekt (noen hundre spor):
 *   K: veggtid ca. 15 min (innhold 30), 29 (90), 33 (120); kost ca. $0,9 / $2,4 / $3,5
 *   D: veggtid ca. 60 min (30–60);                         kost ca. $3,6–5,4
 *   D+: veggtid ca. 88 min (30);                            kost ca. $7,4
 *   U: veggtid ca. 24 min (60);                             kost ca. $1,8
 * Retterunder (2+ byggeagenter) dobler omtrent kosten og veggtida; de er sjeldne og ligger i medianen.
 * Kalibrer på nytt (`ko.mjs kost`) når klassemiksen eller arbeidsmåten endrer seg.
 */
const KALIBRERT = {
  dato: '2026-10-23',
  vegg: { K: [10, 0.19], D: [56, 0.4], 'D+': [65, 1.1], U: [6, 0.3] },
  kost: { K: [0.6, 0.022], D: [2, 0.08], 'D+': [3, 0.15], U: [0.6, 0.02] },
};

/** Standardgrenser: overstyres i køfila under `grenser`. */
// maksDb: spor med migrasjoner (migr_tiere > 0) samtidig. Mange samtidige DB-spor konkurrerer om den samme
// databasen (låser, kø i testkjøringer); klientspor belaster den ikke og begrenses ikke av grensen.
// dagsbudsjett: USD API-ekvivalent per døgn (målt med tidKost.js). null = av (ingen grense) til eieren har satt et
// tall med `ko.mjs grense dagsbudsjett <usd>`.
// nattkjoring / nattvindu: med nattkjøring av startes ingen nye oppgaver inne i nattvinduet (lokal tid, «23-06» =
// fra kl. 23 til kl. 06). Standard er på.
// autokompakt: automatisk komprimering av orkestratorøkta. Av (standard): varsel med ferdig /compact-linje, så eieren
// følger med. På: Claude Code komprimerer selv (eieren setter /autocompact) og køen gjenopptas automatisk. Hookene
// leser verdien (kontekstVakt.kompaktModus); `ko.mjs kompakt auto|manuell`.
const STANDARD_GRENSER = {
  maksSamtidig: 5,
  maksDPluss: 2,
  maksPerDomene: 7,
  maksDb: 6,
  dagsbudsjett: null,
  nattkjoring: true,
  nattvindu: '23-06',
  autokompakt: false,
};
/** Tidssonen nattvinduet og dagsbudsjettets døgn gjelder i. */
const NATT_TZ = 'Europe/Oslo';

/**
 * Statuser der oppgaven holder eierskapet sitt (kjører, plukket av en person eller økt, levert og venter på
 * review/fletting, eller arbeid registrert utenfor køen). Køen starter ingenting som kolliderer med disse.
 */
const AKTIVE = new Set(['kjorer', 'review', 'plukket', 'ekstern']);

// forslag: lagt inn av en agent (spor, reviewer, fold-/utredningsagent) og ikke godkjent ennå. Startes
// aldri; `ko.mjs godkjenn <id…>` gjør den til venter.
// plukket: en person eller økt gjør oppgaven manuelt (`ko.mjs plukk`). Eier filene sine og har
// migrasjonsblokk, men teller ikke mot maksSamtidig/maksDPluss.
// ekstern: ikke en oppgave, men en registrering av arbeid som pågår utenfor køen (`ko.mjs ekstern add`). Eier
// filene sine som en plukket oppgave til `ekstern ferdig <navn>`. Raden har `ekstern: true` og telles aldri som
// arbeid (prosjekter, vis, tilstand).
const STATUSER = new Set([
  'forslag',
  'venter',
  'kjorer',
  'plukket',
  'review',
  'ferdig',
  'kansellert',
  'ekstern',
]);
const KLASSER = new Set(Object.keys(VEKT));

/** Prosjektet til en oppgave uten eget `prosjekt` og uten treff på noen prefiks i registeret. */
const UTEN_PROSJEKT = 'uten-prosjekt';
/** Gruppenavnet for oppgaver uten `funksjon` i gruppert visning og QA-lista. */
const UTEN_FUNKSJON = '(uten funksjon)';
/** Visuell QA: eieren ser på ferdige oppgaver med etiketten `visuell`. */
const QA_STATUSER = new Set(['venter', 'ok', 'avvik']);
const ETIKETT_VISUELL = 'visuell';
/** Prosjekt-id: kort kebab-case (nettbutikk, api-v2, rapporter). */
const PID_MONSTER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Etikett: kort ord i små bokstaver (visuell). */
const ETIKETT_MONSTER = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** En plukket oppgave er «gammel» når den har vært plukket så lenge uten commits (den slippes aldri automatisk). */
const GAMMEL_PLUKK_MS = 72 * 3_600_000;

/** Anslått tid i minutter for en oppgave (innhold × vekt). */
function anslag(o) {
  const innhold = Number(o.innhold_min ?? 30);
  return Math.round(innhold * (VEKT[o.klasse] ?? 1));
}

/** Kalibrert veggtid i minutter (startet → ferdig, med review og fletting), se KALIBRERT. */
function anslagVegg(o) {
  const [fast, faktor] = KALIBRERT.vegg[o?.klasse] ?? KALIBRERT.vegg.K;
  return Math.round(fast + Number(o?.innhold_min ?? 30) * faktor);
}

/** Kalibrert kost i API-ekvivalente USD (spor og reviewere), se KALIBRERT. Grunnlaget for kvoteprognosen. */
function anslagKost(o) {
  const [fast, faktor] = KALIBRERT.kost[o?.klasse] ?? KALIBRERT.kost.K;
  return Math.round((fast + Number(o?.innhold_min ?? 30) * faktor) * 10) / 10;
}

/**
 * Validerer en ny oppgave. Returnerer en liste med feil (tom = gyldig).
 * Påkrevd: id, tittel, domene, klasse, oppdrag (sti til sporbeskrivelse eller tekst).
 * `register` (køens `prosjekter`): når det har minst ett prosjekt, må et eksplisitt `prosjekt` finnes i det.
 */
function valider(o, eksisterende = [], register) {
  const feil = [];
  if (!o || typeof o !== 'object') return ['oppgaven må være et objekt'];
  if (!o.id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(o.id))
    feil.push('id mangler eller har ugyldige tegn');
  if (eksisterende.some((e) => e.id === o.id)) feil.push(`id ${o.id} finnes fra før`);
  if (!o.tittel) feil.push('tittel mangler');
  if (!o.domene) feil.push('domene mangler');
  if (!KLASSER.has(o.klasse)) feil.push(`klasse må være en av ${[...KLASSER].join(', ')}`);
  if (!o.oppdrag) feil.push('oppdrag mangler (sti til sporbeskrivelse eller tekst)');
  if (o.status && !STATUSER.has(o.status)) feil.push(`ukjent status ${o.status}`);
  for (const felt of ['avhenger', 'venter_paa', 'eier_filer', 'eier_db', 'delt_patch']) {
    if (o[felt] != null && !Array.isArray(o[felt])) feil.push(`${felt} må være en liste`);
  }
  if (o.nytte != null && !(o.nytte >= 1 && o.nytte <= 10)) feil.push('nytte må være 1–10');
  const tomtRegister = !register || Object.keys(register).length === 0;
  feil.push(...validerNyeFelt(o, register, { strengProsjekt: !tomtRegister }));
  return feil;
}

/**
 * Prosjektfeltene (prosjekt, funksjon, etiketter, qa_status). Alle er valgfrie. Med `strengProsjekt` må et
 * eksplisitt prosjekt finnes i registeret (skrivefeil gir ellers et nytt, tomt prosjekt i `prosjekter`-tabellen).
 */
function validerNyeFelt(o, register, { strengProsjekt = true } = {}) {
  const feil = [];
  if (o.prosjekt != null) {
    if (typeof o.prosjekt !== 'string' || !PID_MONSTER.test(o.prosjekt))
      feil.push('prosjekt må være en kort kebab-case-id (f.eks. api-v2)');
    else if (
      strengProsjekt &&
      o.prosjekt !== UTEN_PROSJEKT &&
      !Object.hasOwn(register ?? {}, o.prosjekt)
    )
      feil.push(
        `ukjent prosjekt ${o.prosjekt} (opprett det først: ko.mjs prosjekt ${o.prosjekt} --tittel "…")`,
      );
  }
  // Planposten oppgaven hører til (id i scripts/.ko/planer.json; at den finnes, sjekker ko.mjs).
  if (o.plan != null && (typeof o.plan !== 'string' || !/^PL-\S+$/.test(o.plan)))
    feil.push('plan må være en planpost-id (PL-NAVN-1)');
  if (o.funksjon != null && (typeof o.funksjon !== 'string' || !o.funksjon.trim()))
    feil.push('funksjon må være en tekst (kort navn, f.eks. «Dagens bemanning»)');
  if (
    o.etiketter != null &&
    (!Array.isArray(o.etiketter) ||
      o.etiketter.some((e) => typeof e !== 'string' || !ETIKETT_MONSTER.test(e)))
  )
    feil.push('etiketter må være en liste med korte ord i små bokstaver (f.eks. ["visuell"])');
  if (
    o.krever != null &&
    (!Array.isArray(o.krever) || o.krever.some((k) => typeof k !== 'string' || !KREVER.has(k)))
  )
    feil.push(`krever må være en liste med ${[...KREVER].join(', ')}`);
  if (o.qa_status != null && !QA_STATUSER.has(o.qa_status))
    feil.push(`qa_status må være en av ${[...QA_STATUSER].join(', ')}`);
  // «sett på vent» for én oppgave (ko.mjs parker).
  if (o.parkert != null) {
    const p = o.parkert;
    const gyldig =
      typeof p === 'object' &&
      !Array.isArray(p) &&
      typeof p.av === 'string' &&
      !!p.av.trim() &&
      typeof p.at === 'string' &&
      Number.isFinite(Date.parse(p.at)) &&
      (p.til == null || (typeof p.til === 'string' && Number.isFinite(Date.parse(p.til)))) &&
      (p.grunn == null || typeof p.grunn === 'string');
    if (!gyldig) feil.push('parkert må være { av, at, grunn?, til? } (sett med ko.mjs parker)');
  }
  return feil;
}

// ---- Prosjekt og funksjon -----------------------------------------------------------------------------

/**
 * Prosjektet en oppgave hører til: eksplisitt `prosjekt`, ellers prosjektet med den LENGSTE prefiksen i registeret som
 * matcher starten av id-en (ved lik lengde vinner det første i registeret), ellers `uten-prosjekt`.
 * Prefiksene er data i registeret, aldri hardkodet her.
 */
function prosjektFor(o, register) {
  if (typeof o?.prosjekt === 'string' && o.prosjekt) return o.prosjekt;
  return lengstePrefiks(o?.id, register)?.pid ?? UTEN_PROSJEKT;
}

/**
 * Den lengste prefiksen i registeret som matcher starten av id-en: { pid, prefiks } eller null. Ved lik lengde i to
 * prosjekter vinner det første i registeret (som før), og `ogsaa` lister de andre.
 */
function lengstePrefiks(id, register) {
  const s = String(id ?? '');
  let best = null;
  for (const [pid, p] of Object.entries(register ?? {})) {
    const prefikser = Array.isArray(p?.prefikser) ? p.prefikser : [];
    for (const pre of prefikser) {
      if (typeof pre !== 'string' || !pre || !s.startsWith(pre)) continue;
      if (!best || pre.length > best.prefiks.length) best = { pid, prefiks: pre, ogsaa: [] };
      else if (pre.length === best.prefiks.length && pid !== best.pid && !best.ogsaa.includes(pid))
        best.ogsaa.push(pid);
    }
  }
  return best;
}

/** Er prosjektet oppgaven hører til, pauset? Da starter ikke køen den (neste/start uten --tving). */
function prosjektPauset(o, register) {
  return register?.[prosjektFor(o, register)]?.pause === true;
}

/**
 * Hindringene, med pause først når prosjektet er pauset (til `vis` og `tilstand`; `start` sjekker pause selv).
 * En parkert oppgave og en oppgave utenfor fokus (når resten venter) får det som første hindring.
 * @param {object} [k] rangeringKontekst(ko, naa), når mange oppgaver slås opp
 */
function hindringerMedPause(o, ko, k = null) {
  const register = ko.prosjekter ?? {};
  const h = hindringer(o, ko.oppgaver ?? [], ko.avklart);
  if (o.status !== 'venter') return h;
  const foran = [];
  if (o.parkert && parkertNaa(o, k?.naa ?? Date.now())) foran.push(parkertTekst(o));
  if (prosjektPauset(o, register)) foran.push(`prosjektet ${prosjektFor(o, register)} er pauset`);
  if (ko.fokus) {
    const p = fokusPlass(o, k ?? rangeringKontekst(ko));
    if (p.utenfor && !p.parkert && !p.pauset && p.ut) foran.push(utenforTekst(ko));
  }
  return [...foran, ...h];
}

/** Har oppgaven etiketten? */
function harEtikett(o, etikett) {
  return Array.isArray(o?.etiketter) && o.etiketter.includes(etikett);
}

/**
 * Teller oppgaven mot køens agentplasser (maksSamtidig, maksDPluss)? Kjører og review gjør det, men ikke en oppgave
 * som en person eller økt har plukket, heller ikke etter at den er levert til review (den har fortsatt `plukket_av`).
 */
function tellerSomAgent(o) {
  return (o.status === 'kjorer' || o.status === 'review') && !o.plukket_av;
}

/** Rekkefølgen prosjektene vises i: registerets rekkefølge, så ukjente alfabetisk, `uten-prosjekt` sist. */
function prosjektRekkefolge(pider, register) {
  const iRegister = Object.keys(register ?? {});
  const andre = [...pider]
    .filter((p) => !iRegister.includes(p) && p !== UTEN_PROSJEKT)
    .sort((x, y) => x.localeCompare(y, 'nb'));
  return [
    ...iRegister.filter((p) => pider.has(p)),
    ...andre,
    ...(pider.has(UTEN_PROSJEKT) ? [UTEN_PROSJEKT] : []),
  ];
}

/**
 * Grupperer oppgaver prosjekt → funksjon (rekkefølgen innen en funksjon er den kalleren ga). Til `vis --gruppert`
 * og QA-lista. Returnerer [{ pid, tittel, pause, funksjoner: [{ funksjon, oppgaver }] }].
 */
function grupper(oppgaver, register) {
  const perProsjekt = new Map();
  for (const o of oppgaver) {
    const pid = prosjektFor(o, register);
    if (!perProsjekt.has(pid)) perProsjekt.set(pid, new Map());
    const f =
      typeof o.funksjon === 'string' && o.funksjon.trim() ? o.funksjon.trim() : UTEN_FUNKSJON;
    const perFunksjon = perProsjekt.get(pid);
    if (!perFunksjon.has(f)) perFunksjon.set(f, []);
    perFunksjon.get(f).push(o);
  }
  return prosjektRekkefolge(new Set(perProsjekt.keys()), register).map((pid) => {
    const perFunksjon = perProsjekt.get(pid);
    const funksjoner = [...perFunksjon.keys()].sort((x, y) =>
      x === UTEN_FUNKSJON ? 1 : y === UTEN_FUNKSJON ? -1 : x.localeCompare(y, 'nb'),
    );
    return {
      pid,
      tittel: register?.[pid]?.tittel ?? null,
      pause: register?.[pid]?.pause === true,
      funksjoner: funksjoner.map((f) => ({ funksjon: f, oppgaver: perFunksjon.get(f) })),
    };
  });
}

/**
 * Oversikt per prosjekt til `ko.mjs prosjekter`: ferdig/totalt (uten kansellerte og forslag), minutter igjen
 * (anslag for det som ikke er ferdig), aktive (kjorer/review), plukkede, venter, i QA-lista, og eierspørsmålene som
 * blokkerer flest oppgaver i prosjektet.
 */
function prosjektOversikt(ko) {
  const register = ko.prosjekter ?? {};
  const avklart = new Set(ko.avklart ?? []);
  const rader = new Map();
  const rad = (pid) => {
    if (!rader.has(pid)) {
      const p = register[pid] ?? {};
      rader.set(pid, {
        pid,
        tittel: p.tittel ?? null,
        plan: p.plan ?? null,
        pause: p.pause === true,
        prioritet_tillegg: Number(p.prioritet_tillegg) || 0,
        i_register: Object.hasOwn(register, pid),
        totalt: 0,
        ferdig: 0,
        min_igjen: 0,
        aktive: 0,
        plukket: 0,
        venter: 0,
        forslag: 0,
        qa: 0,
        sp: new Map(),
      });
    }
    return rader.get(pid);
  };
  for (const pid of Object.keys(register)) rad(pid);
  // Registreringer utenfor køen (ekstern add) er ikke arbeid i noe prosjekt.
  for (const o of (ko.oppgaver ?? []).filter((x) => !erEksternRad(x))) {
    const r = rad(prosjektFor(o, register));
    if (o.status === 'kansellert') continue;
    if (o.status === 'forslag') {
      r.forslag += 1;
      continue;
    }
    r.totalt += 1;
    if (o.status === 'ferdig') {
      r.ferdig += 1;
      if (o.qa_status === 'venter') r.qa += 1;
      continue;
    }
    r.min_igjen += anslag(o);
    if (o.status === 'kjorer' || o.status === 'review') r.aktive += 1;
    else if (o.status === 'plukket') r.plukket += 1;
    else if (o.status === 'venter') {
      r.venter += 1;
      for (const sp of o.venter_paa ?? []) {
        if (!avklart.has(sp)) r.sp.set(sp, (r.sp.get(sp) ?? 0) + 1);
      }
    }
  }
  return prosjektRekkefolge(new Set(rader.keys()), register).map((pid) => {
    const { sp, ...r } = rader.get(pid);
    return {
      ...r,
      eiersporsmal: [...sp.entries()]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .map(([s, n]) => ({ sp: s, oppgaver: n })),
    };
  });
}

/** Feltene et prosjekt i registeret kan ha. */
const PROSJEKT_FELT = new Set([
  'tittel',
  'plan',
  'prefikser',
  'pause',
  'prioritet_tillegg',
  'omrade',
  // Filrøtter (signal for klassifiser) og kjente funksjonsnavn.
  'filrot',
  'funksjoner',
  // 'plan' = prosjektet finnes i planregisteret, men har ingen køoppgaver ennå (docs/plan-register.md).
  'fase',
]);

/**
 * Validerer og anvender endringer i prosjektregisteret: { <pid>: { tittel?, plan?, prefikser?, pause?,
 * prioritet_tillegg? } }. Et nytt prosjekt krever tittel. `null` fjerner et valgfritt felt. Returnerer et NYTT
 * register (det gamle endres ikke) og feillista; kalleren bruker registeret bare når feillista er tom.
 */
function nyttRegister(register, endringer, omrader = {}) {
  const feil = [];
  const ny = { ...(register ?? {}) };
  if (endringer == null) return { register: ny, feil };
  if (typeof endringer !== 'object' || Array.isArray(endringer))
    return { register: ny, feil: ['prosjekter må være et objekt { <pid>: { tittel, … } }'] };
  for (const [pid, felt] of Object.entries(endringer)) {
    if (!PID_MONSTER.test(pid) || pid === UTEN_PROSJEKT) {
      feil.push(`prosjekt-id ${pid} må være kort kebab-case (og ikke ${UTEN_PROSJEKT})`);
      continue;
    }
    if (!felt || typeof felt !== 'object' || Array.isArray(felt)) {
      feil.push(`${pid}: må være et objekt`);
      continue;
    }
    const ukjente = Object.keys(felt).filter((k) => !PROSJEKT_FELT.has(k));
    if (ukjente.length)
      feil.push(
        `${pid}: ukjente felt ${ukjente.join(', ')} (tillatt: ${[...PROSJEKT_FELT].join(', ')})`,
      );
    const p = { ...(ny[pid] ?? {}) };
    for (const [k, v] of Object.entries(felt)) {
      if (!PROSJEKT_FELT.has(k)) continue;
      if (v === null) delete p[k];
      else p[k] = v;
    }
    if (typeof p.tittel !== 'string' || !p.tittel.trim()) feil.push(`${pid}: tittel mangler`);
    if (p.plan != null && typeof p.plan !== 'string')
      feil.push(`${pid}: plan må være en tekst (sti)`);
    if (
      p.prefikser != null &&
      (!Array.isArray(p.prefikser) ||
        p.prefikser.some((x) => typeof x !== 'string' || !x || /\s/.test(x)))
    )
      feil.push(`${pid}: prefikser må være en liste med ikke-tomme prefikser uten mellomrom`);
    if (p.pause != null && typeof p.pause !== 'boolean')
      feil.push(`${pid}: pause må være true/false`);
    if (p.prioritet_tillegg != null && !Number.isFinite(p.prioritet_tillegg))
      feil.push(`${pid}: prioritet_tillegg må være et tall`);
    // Filrot = mapper/filer (stier, ikke mønstre), funksjoner = kjente funksjonsnavn.
    if (
      p.filrot != null &&
      (!Array.isArray(p.filrot) ||
        p.filrot.some((x) => typeof x !== 'string' || !x.trim() || /\s/.test(x) || /[*?]/.test(x)))
    )
      feil.push(`${pid}: filrot må være en liste med stier uten mellomrom og jokertegn`);
    if (
      p.funksjoner != null &&
      (!Array.isArray(p.funksjoner) ||
        p.funksjoner.some((x) => typeof x !== 'string' || !x.trim() || x.length > 80))
    )
      feil.push(`${pid}: funksjoner må være en liste med korte navn`);
    if (p.fase != null && p.fase !== 'plan')
      feil.push(`${pid}: fase må være plan (eller fjernes med null)`);
    // Området må finnes i områderegisteret når endringen setter det.
    if ('omrade' in felt && felt.omrade != null) {
      if (typeof felt.omrade !== 'string' || !PID_MONSTER.test(felt.omrade))
        feil.push(`${pid}: omrade må være en kort kebab-case-id`);
      else if (!Object.hasOwn(omrader ?? {}, felt.omrade))
        feil.push(
          `${pid}: ukjent område ${felt.omrade} (opprett det først: ko.mjs omrade ${felt.omrade} --tittel "…")`,
        );
    }
    ny[pid] = p;
  }
  return { register: ny, feil };
}

/** Feltene `endre-mange` kan sette per oppgave. */
const ENDRE_MANGE_FELT = new Set([
  'id',
  'prosjekt',
  'funksjon',
  'etiketter',
  'krever',
  'prioritet_tillegg',
  // Sett på vent / ta av vent, og inn i / ut av samlekøen, med samme regler som parker og endre.
  'parkert',
  'samles',
  // Koblingen til planregisteret (ko.mjs sjekker at planposten finnes).
  'plan',
]);
/** Feltene som faktisk endres (alt unntatt id). */
const ENDRE_MANGE_VERDIER = [
  'prosjekt',
  'funksjon',
  'etiketter',
  'krever',
  'prioritet_tillegg',
  'parkert',
  'samles',
  'plan',
];

/**
 * Tolker `parkert` i endre-mange: null = ta av vent; true = parker (uten grunn og dato); { grunn?, til? } = parker med
 * grunn og/eller dato (YYYY-MM-DD = til og med den dagen, UTC). `av` og `at` settes av verktøyet (samme form som
 * ko.mjs parker). Returnerer { verdi } (null = fjern feltet) eller { feil }.
 */
function parkertVerdi(raa, { av, naa }) {
  if (raa === null) return { verdi: null };
  const hvem = String(av ?? '').trim() || 'ukjent';
  if (raa === true) return { verdi: { av: hvem, at: naa } };
  if (!raa || typeof raa !== 'object' || Array.isArray(raa))
    return { feil: 'parkert må være true, null eller { grunn?, til? }' };
  const ukjente = Object.keys(raa).filter((k) => !['grunn', 'til'].includes(k));
  if (ukjente.length)
    return { feil: `parkert: ukjente felt ${ukjente.join(', ')} (tillatt: grunn, til)` };
  const g = raa.grunn == null ? null : String(raa.grunn).trim();
  if (g && g.length > FOKUS_MAKS_TEKST)
    return { feil: `parkert: grunnen kan være høyst ${FOKUS_MAKS_TEKST} tegn` };
  let til = null;
  if (raa.til != null && raa.til !== '') {
    til = tolkTilDato(raa.til);
    if (!til) return { feil: `parkert: ugyldig dato ${raa.til} (bruk YYYY-MM-DD eller ISO-tid)` };
    if (Date.parse(til) <= Date.parse(naa))
      return { feil: `parkert: datoen ${raa.til} er passert` };
  }
  return {
    verdi: { av: hvem, at: naa, ...(g ? { grunn: g } : {}), ...(til ? { til } : {}) },
  };
}

/**
 * Masseendring (`ko.mjs endre-mange --fil`): en liste [{ id, prosjekt?, funksjon?, etiketter?, krever?,
 * prioritet_tillegg?, parkert?, samles? }] eller et objekt { prosjekter?: {…}, oppgaver?: [...] }. ALT ELLER INGENTING:
 * alt valideres før noe endres, og ved én feil endres ingenting (verken oppgaver eller register). `null` fjerner et felt
 * (prosjekt faller da tilbake til prefiks-regelen). Et prosjekt må finnes i registeret etter at fila er lagt til.
 * `prioritet_tillegg` («Løft avhengighetene også») må være et tall.
 * `parkert` (se parkertVerdi; bare venter og forslag kan parkeres, som ko.mjs parker), `samles` (samme
 * regler som add/endre: koLogikk.samlesFeil mot køen slik den blir), registerfeltene `omrade`, `filrot` og `funksjoner`,
 * og `torr` (regner ut alt på en kopi og endrer ingenting). Svaret har alltid `endringer` (masseDiff: bare felt som
 * faktisk endres, til forhåndsvisning og endringsloggen) og `advarsler` (flytt til et pauset prosjekt, parkering av en
 * oppgave fokuset har dratt med, samlekø for en oppgave som er parkert).
 * @param {{ av?: string, naa?: string, torr?: boolean }} [valg]
 * @returns {{ feil: string[], endret?: string[], prosjekter?: string[], endringer?: object[], advarsler?: string[] }}
 */
function endreMange(ko, inn, { av = null, naa = new Date().toISOString(), torr = false } = {}) {
  if (torr) return endreMange(klonJson(ko), inn, { av, naa });
  let endringer;
  let prosjekter;
  const feil = [];
  if (Array.isArray(inn)) endringer = inn;
  else if (inn && typeof inn === 'object') {
    const ukjente = Object.keys(inn).filter((k) => !['oppgaver', 'prosjekter'].includes(k));
    if (ukjente.length)
      feil.push(`ukjente nøkler øverst: ${ukjente.join(', ')} (tillatt: prosjekter, oppgaver)`);
    endringer = inn.oppgaver ?? [];
    prosjekter = inn.prosjekter;
  } else {
    return { feil: ['fila må være en liste med endringer eller { prosjekter, oppgaver }'] };
  }
  if (!Array.isArray(endringer)) return { feil: [...feil, 'oppgaver må være en liste'] };
  const reg = nyttRegister(ko.prosjekter, prosjekter, ko.omrader);
  feil.push(...reg.feil);
  const perId = new Map((ko.oppgaver ?? []).map((o) => [o.id, o]));
  const sett = new Set();
  const plan = [];
  endringer.forEach((e, i) => {
    const navn = e?.id ?? `nr. ${i + 1}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      feil.push(
        `nr. ${i + 1}: må være et objekt { id, prosjekt?, funksjon?, etiketter?, prioritet_tillegg?, parkert?, samles? }`,
      );
      return;
    }
    const ukjente = Object.keys(e).filter((k) => !ENDRE_MANGE_FELT.has(k));
    if (ukjente.length)
      feil.push(
        `${navn}: ukjente felt ${ukjente.join(', ')} (endre-mange tar bare ${[...ENDRE_MANGE_FELT].join(', ')})`,
      );
    if (
      'prioritet_tillegg' in e &&
      e.prioritet_tillegg !== null &&
      (typeof e.prioritet_tillegg !== 'number' || !Number.isFinite(e.prioritet_tillegg))
    )
      feil.push(`${navn}: prioritet_tillegg må være et tall`);
    const o = perId.get(e.id);
    if (!o || erEksternRad(o)) {
      feil.push(`${navn}: ukjent oppgave`);
      return;
    }
    if (sett.has(e.id)) feil.push(`${e.id}: står flere ganger i fila`);
    sett.add(e.id);
    // Verdiene som skrives (parkert normaliseres; samles false/null fjerner feltet, som ko.mjs endre).
    const verdier = {};
    for (const k of ENDRE_MANGE_VERDIER) if (k in e) verdier[k] = e[k];
    if ('parkert' in e) {
      if (e.parkert === true && o.parkert) delete verdier.parkert;
      else {
        const p = parkertVerdi(e.parkert, { av, naa });
        if (p.feil) feil.push(`${e.id}: ${p.feil}`);
        else {
          verdier.parkert = p.verdi;
          if (p.verdi && o.status !== 'venter' && o.status !== 'forslag')
            feil.push(`${e.id}: status ${o.status} (bare venter og forslag kan parkeres)`);
        }
      }
    }
    if ('samles' in e) {
      if (e.samles != null && typeof e.samles !== 'boolean')
        feil.push(`${e.id}: samles må være true, false eller null`);
      else if (e.samles !== true) verdier.samles = null;
    }
    const ny = { ...o };
    for (const [k, v] of Object.entries(verdier)) {
      if (v === null) delete ny[k];
      else ny[k] = v;
    }
    for (const f of validerNyeFelt(ny, reg.register, { strengProsjekt: true }))
      feil.push(`${e.id}: ${f}`);
    plan.push({ o, e, ny, verdier });
  });
  // Samlekøen: reglene mot køen slik den blir etter HELE fila (to oppgaver i fila kan påvirke hverandre).
  const nyPerId = new Map(plan.map((p) => [p.o.id, p.ny]));
  const etter = (ko.oppgaver ?? []).map((x) => nyPerId.get(x.id) ?? x);
  for (const p of plan) {
    if (!('samles' in p.e)) continue;
    for (const f of samlesFeil(p.ny, etter, ko.avklart)) feil.push(`${p.o.id}: ${f}`);
  }
  if (feil.length) return { feil };

  // Advarsler (stopper ikke): regnes mot køen FØR endringen.
  const advarsler = [];
  const k = rangeringKontekst(ko, Date.parse(naa));
  for (const p of plan) {
    const pidEtter = prosjektFor(p.ny, reg.register);
    if (
      pidEtter !== prosjektFor(p.o, ko.prosjekter ?? {}) &&
      reg.register?.[pidEtter]?.pause === true
    )
      advarsler.push(
        `${p.o.id} flyttes til ${pidEtter}, som er pauset (startes ikke før det fortsetter)`,
      );
    if (p.verdier.parkert && !p.o.parkert) {
      const d = k.dratt.get(p.o.id);
      if (d && !nyPerId.get(d.av)?.parkert)
        advarsler.push(
          `${p.o.id} er dratt med av ${d.av} i fokus (trinn ${d.trinn + 1}); den står til ${p.o.id} fortsetter`,
        );
    }
    if (p.ny.samles === true && p.ny.parkert)
      advarsler.push(
        `${p.o.id} er både parkert og i samlekøen; den pakkes, men startes ikke før den fortsetter`,
      );
  }

  const forKo = {
    oppgaver: plan.map((p) => klonJson(p.o)),
    prosjekter: klonJson(ko.prosjekter ?? {}),
  };
  if (prosjekter != null) ko.prosjekter = reg.register;
  for (const { o, verdier } of plan) {
    for (const [kk, v] of Object.entries(verdier)) {
      if (v === null) delete o[kk];
      else o[kk] = v;
    }
  }
  return {
    feil: [],
    endret: plan.map((p) => p.o.id),
    prosjekter: Object.keys(prosjekter ?? {}),
    endringer: masseDiff(forKo, {
      oppgaver: plan.map((p) => p.o),
      prosjekter: ko.prosjekter ?? {},
    }),
    advarsler,
  };
}

// ---- Områder, fokusperiode og parkering -------------------------------------------------------------
//
// Tre valgfrie felt i ko.json (docs/queue.md):
//   omrader: { <oid>: { tittel, beskrivelse? } }   områderegisteret (programdeler); prosjektet får `omrade`. Lista er
//                                                  data, aldri hardkodet her.
//   fokus: { navn?, fra?, til?, rekkefolge: [trinn], resten: 'vent'|'fyll', dra_med_avhengigheter?, satt_av? }
//          Et trinn er `omrade:<oid>`, `prosjekt:<pid>` eller `funksjon:<pid>/<navn>`. Alt i trinn 1 kommer før alt i
//          trinn 2 (uansett poeng); innen et trinn gjelder dagens score. Et mer spesifikt trinn vinner over et mindre
//          spesifikt (funksjon > prosjekt > område), så «Widgets nå, resten av Plattform senere» virker begge veier.
//          `resten: vent` (standard) = oppgaver utenfor alle trinn startes ikke; `fyll` = de kommer sist og
//          fyller plasser fokuset ikke bruker. Fokus gjelder til det endres, med valgfri sluttdato `til`; når
//          den er passert, rangeres køen som uten fokus og tilstand/vis varsler.
//          Dratt med: en åpen avhengighet (transitivt) til en ventende oppgave i fokus får trinnet til den høyest
//          prioriterte oppgaven som venter på den, selv om den hører til et område utenfor.
//   oppgave.parkert: { av, at, grunn?, til? }      «sett på vent» for én oppgave. Status forblir venter (som samles);
//                                                  neste, start og plukkbare hopper over. Med `til` slutter parkeringen
//                                                  av seg selv.
// Rangeringen (rangering/sammenlignRangering) er ÉN funksjon brukt av velgNeste, plukkbare, nesteOpp (via velgNeste),
// vis og tilstand: [parkert/pauset/utenfor fokus → ut] → fokustrinn → score → id. Uten fokus og uten parkerte er
// resultatet det samme som før (testet i lib/__tests__/koFokus.test.ts).

/** Området til prosjekter uten `omrade`. */
const UTEN_OMRADE = 'uten-omrade';
/** Lovlige verdier for fokus.resten. Standard: vent. */
const FOKUS_RESTEN = ['vent', 'fyll'];
/** Hvor spesifikt et trinn er: det mest spesifikke trinnet som treffer en oppgave, bestemmer trinnet. */
const TRINN_SPESIFISITET = { omrade: 1, prosjekt: 2, funksjon: 3 };
/** Sorteringsverdier for oppgaver utenfor fokus (resten venter) og parkerte (sist av alt). */
const RESTEN_TRINN = 1_000_000;
const PARKERT_TRINN = 2_000_000;
/** Lengste fritekst i fokusnavn og parkeringsgrunn. */
const FOKUS_MAKS_TEKST = 200;

/** Området en oppgave hører til: prosjektets `omrade`, ellers `uten-omrade`. Oppgaver har aldri eget omrade-felt. */
function omradeFor(o, ko) {
  const register = ko?.prosjekter ?? {};
  const oid = register[prosjektFor(o, register)]?.omrade;
  return typeof oid === 'string' && oid ? oid : UTEN_OMRADE;
}

/**
 * Tolker ett trinn fra CLI-en eller tavla: `omrade:<oid>`, `prosjekt:<pid>`, `funksjon:<pid>/<navn>`, eller et nakent
 * navn (område hvis det finnes, ellers prosjekt; finnes begge, må typen skrives). Returnerer den lagrede formen.
 * @returns {{ trinn: string } | { feil: string }}
 */
function tolkTrinn(raa, ko) {
  const omrader = ko?.omrader ?? {};
  const register = ko?.prosjekter ?? {};
  const s = String(raa ?? '').trim();
  if (!s) return { feil: 'tomt trinn' };
  const kolon = s.indexOf(':');
  if (kolon < 0) {
    const erOmrade = Object.hasOwn(omrader, s);
    const erProsjekt = Object.hasOwn(register, s);
    if (erOmrade && erProsjekt)
      return {
        feil: `${s} er både et område og et prosjekt: skriv omrade:${s} eller prosjekt:${s}`,
      };
    if (erOmrade) return { trinn: `omrade:${s}` };
    if (erProsjekt) return { trinn: `prosjekt:${s}` };
    return {
      feil: `ukjent trinn ${s} (verken område eller prosjekt; se ko.mjs omrader og prosjekter)`,
    };
  }
  const type = s.slice(0, kolon);
  const rest = s.slice(kolon + 1).trim();
  if (type === 'omrade') {
    if (!Object.hasOwn(omrader, rest))
      return { feil: `ukjent område ${rest} (opprett med ko.mjs omrade ${rest} --tittel "…")` };
    return { trinn: `omrade:${rest}` };
  }
  if (type === 'prosjekt') {
    if (!Object.hasOwn(register, rest)) return { feil: `ukjent prosjekt ${rest}` };
    return { trinn: `prosjekt:${rest}` };
  }
  if (type === 'funksjon') {
    const skille = rest.indexOf('/');
    const pid = skille < 0 ? '' : rest.slice(0, skille).trim();
    const navn = skille < 0 ? '' : rest.slice(skille + 1).trim();
    if (!pid || !navn)
      return { feil: `funksjonstrinn skrives funksjon:<prosjekt>/<navn> (fikk ${s})` };
    if (!Object.hasOwn(register, pid)) return { feil: `ukjent prosjekt ${pid} i ${s}` };
    return { trinn: `funksjon:${pid}/${navn}` };
  }
  return { feil: `ukjent trinntype ${type} (bruk omrade:, prosjekt: eller funksjon:)` };
}

/** Treffer et (lagret) trinn oppgaven? Returnerer spesifisiteten (1–3) eller 0. */
function trinnTreff(o, trinn, ko) {
  const s = String(trinn);
  const kolon = s.indexOf(':');
  const type = s.slice(0, kolon);
  const rest = s.slice(kolon + 1);
  const register = ko?.prosjekter ?? {};
  if (type === 'omrade') return omradeFor(o, ko) === rest ? TRINN_SPESIFISITET.omrade : 0;
  if (type === 'prosjekt')
    return prosjektFor(o, register) === rest ? TRINN_SPESIFISITET.prosjekt : 0;
  if (type === 'funksjon') {
    const skille = rest.indexOf('/');
    const pid = rest.slice(0, skille);
    const navn = rest.slice(skille + 1);
    const f = typeof o?.funksjon === 'string' ? o.funksjon.trim() : '';
    return prosjektFor(o, register) === pid && f === navn ? TRINN_SPESIFISITET.funksjon : 0;
  }
  return 0;
}

/**
 * Gjelder fokuset nå? Nei når det ikke er satt, har tom rekkefølge, `til` er passert (perioden er ute) eller `fra` er
 * i framtiden. Returnerer også hvorfor, til varselet.
 * @returns {{ gjelder: boolean, utlopt: boolean, ikkeStartet: boolean }}
 */
function fokusGjelder(ko, naa = Date.now()) {
  const f = ko?.fokus;
  if (!f || !Array.isArray(f.rekkefolge) || !f.rekkefolge.length)
    return { gjelder: false, utlopt: false, ikkeStartet: false };
  const til = f.til ? Date.parse(f.til) : NaN;
  if (Number.isFinite(til) && til <= naa)
    return { gjelder: false, utlopt: true, ikkeStartet: false };
  const fra = f.fra ? Date.parse(f.fra) : NaN;
  if (Number.isFinite(fra) && fra > naa)
    return { gjelder: false, utlopt: false, ikkeStartet: true };
  return { gjelder: true, utlopt: false, ikkeStartet: false };
}

/**
 * Oppgavens eget trinn (0-basert indeks i fokus.rekkefolge), eller null når ingen trinn treffer. Det mest spesifikke
 * trinnet vinner; ved likt nivå det første. Ser ikke på «dratt med» (det gjør drattMed/fokusPlass).
 */
function egetTrinn(o, ko) {
  const rekkefolge = ko?.fokus?.rekkefolge ?? [];
  let best = null;
  let bestSpes = 0;
  rekkefolge.forEach((t, i) => {
    const spes = trinnTreff(o, t, ko);
    if (spes > bestSpes) {
      best = i;
      bestSpes = spes;
    }
  });
  return best;
}

/** Er oppgaven parkert nå? Parkeringen slutter av seg selv når `til` er passert. */
function parkertNaa(o, naa = Date.now()) {
  const p = o?.parkert;
  if (!p || typeof p !== 'object') return false;
  const til = p.til ? Date.parse(p.til) : NaN;
  return !(Number.isFinite(til) && til <= naa);
}

/**
 * «Dratt med»: åpne avhengigheter (transitivt) til ventende oppgaver i fokus som ikke selv har et like godt trinn.
 * Hver får trinnet til den høyest prioriterte fokusoppgaven som venter på den, og `av` = den oppgaven. Røttene er
 * ventende oppgaver med eget trinn som ikke er parkert eller i et pauset prosjekt (de skal ikke trekke noe med seg).
 * Tom når fokuset ikke gjelder eller `dra_med_avhengigheter` er false.
 * @returns {Map<string, { trinn: number, av: string }>}
 */
function drattMed(ko, naa = Date.now()) {
  const dratt = new Map();
  if (!fokusGjelder(ko, naa).gjelder || ko.fokus.dra_med_avhengigheter === false) return dratt;
  const oppgaver = ko.oppgaver ?? [];
  const register = ko.prosjekter ?? {};
  const perId = new Map(oppgaver.map((o) => [o.id, o]));
  const eget = new Map();
  const trinnFor = (o) => {
    if (!eget.has(o.id)) eget.set(o.id, egetTrinn(o, ko));
    return eget.get(o.id);
  };
  const rotter = oppgaver
    .filter(
      (o) =>
        o.status === 'venter' &&
        !erEksternRad(o) &&
        !parkertNaa(o, naa) &&
        !prosjektPauset(o, register),
    )
    .map((o) => ({ o, t: trinnFor(o) }))
    .filter((x) => x.t != null)
    .sort((x, y) => x.t - y.t || x.o.id.localeCompare(y.o.id));
  for (const { o, t } of rotter) {
    const sett = new Set([o.id]);
    const stakk = [...(o.avhenger ?? [])];
    while (stakk.length) {
      const id = stakk.pop();
      if (sett.has(id)) continue;
      sett.add(id);
      const d = perId.get(id);
      if (!aapenOppgave(d) || erEksternRad(d)) continue;
      const egen = trinnFor(d);
      const forrige = dratt.get(id);
      if ((egen == null || egen > t) && (!forrige || forrige.trinn > t))
        dratt.set(id, { trinn: t, av: o.id });
      stakk.push(...(d.avhenger ?? []));
    }
  }
  return dratt;
}

/**
 * Konteksten rangeringen trenger, beregnet én gang per kall (drattMed går gjennom hele avhengighetsgrafen).
 * @returns {{ ko: object, naa: number, gjelder: boolean, utlopt: boolean, ikkeStartet: boolean,
 *             resten: string, dratt: Map<string, { trinn: number, av: string }> }}
 */
function rangeringKontekst(ko, naa = Date.now()) {
  const g = fokusGjelder(ko, naa);
  return {
    ko,
    naa,
    ...g,
    resten: g.gjelder && ko.fokus.resten === 'fyll' ? 'fyll' : 'vent',
    dratt: g.gjelder ? drattMed(ko, naa) : new Map(),
  };
}

/** Teksten for en parkert oppgave (hindring i vis/tilstand). */
function parkertTekst(o) {
  const p = o.parkert ?? {};
  return (
    `parkert${p.til ? ` til ${utcTekst(p.til)}` : ''} av ${p.av ?? '?'}` +
    `${p.grunn ? `: ${p.grunn}` : ''} (ko.mjs fortsett ${o.id})`
  );
}

/** Teksten for en oppgave utenfor fokus når resten venter. */
function utenforTekst(ko) {
  const navn = ko?.fokus?.navn ? ` «${ko.fokus.navn}»` : '';
  return `utenfor fokus${navn} (resten venter; ko.mjs fokus)`;
}

/**
 * Plasseringen til én oppgave, uten score: fokustrinn (0-basert, null = utenfor alle trinn), dratt med av, og om den er
 * ute av rangeringen (parkert, pauset prosjekt, eller utenfor fokus når resten venter) med grunnen.
 * `trinn` er sorteringsverdien: 0 uten fokus; trinnindeksen med fokus; antall trinn for resten med `fyll`;
 * RESTEN_TRINN for resten med `vent`; PARKERT_TRINN for parkerte.
 */
function fokusPlass(o, k) {
  const ko = k.ko;
  const parkert = parkertNaa(o, k.naa);
  const pauset = prosjektPauset(o, ko.prosjekter ?? {});
  let steg = null;
  let drattAv = null;
  let utenfor = false;
  let trinn = 0;
  if (k.gjelder) {
    const d = k.dratt.get(o.id);
    steg = d ? d.trinn : egetTrinn(o, ko);
    drattAv = d ? d.av : null;
    utenfor = steg == null;
    trinn = utenfor ? (k.resten === 'fyll' ? ko.fokus.rekkefolge.length : RESTEN_TRINN) : steg;
  }
  if (parkert) trinn = PARKERT_TRINN;
  const utenforVent = utenfor && k.resten !== 'fyll';
  let grunn = null;
  if (parkert) grunn = parkertTekst(o);
  else if (pauset) grunn = `prosjektet ${prosjektFor(o, ko.prosjekter ?? {})} er pauset`;
  else if (utenforVent) grunn = utenforTekst(ko);
  return {
    trinn,
    steg,
    dratt_av: drattAv,
    parkert,
    pauset,
    utenfor,
    ut: parkert || pauset || utenforVent,
    grunn,
  };
}

/**
 * Rangeringen til én oppgave: fokusPlass + score. ÉN kilde for velgNeste, plukkbare, nesteOpp, vis og tilstand.
 * @param {object} [k] rangeringKontekst(ko, naa), når mange oppgaver rangeres
 */
function rangering(o, ko, k = rangeringKontekst(ko)) {
  return {
    ...fokusPlass(o, k),
    score: score(o, ko.oppgaver ?? [], k.naa, ko.prosjekter ?? {}),
  };
}

/** Sorteringen: lavest trinn først, så høyest score, så id. Tar { o, r } der r = rangering(o, …). */
function sammenlignRangering(a, b) {
  return a.r.trinn - b.r.trinn || b.r.score - a.r.score || a.o.id.localeCompare(b.o.id);
}

/** Tolker en dato (YYYY-MM-DD = til og med den dagen, UTC; ellers ISO). null ved ugyldig. */
function tolkTilDato(raa) {
  if (raa == null || raa === '') return null;
  const s = String(raa).trim();
  const ms = /^\d{4}-\d\d-\d\d$/.test(s) ? Date.parse(`${s}T23:59:59.000Z`) : Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Kort tekst for et trinn: områdets eller prosjektets tittel, eller funksjonsnavnet. */
function trinnTittel(trinn, ko) {
  const s = String(trinn);
  const kolon = s.indexOf(':');
  const type = s.slice(0, kolon);
  const rest = s.slice(kolon + 1);
  if (type === 'omrade') return ko?.omrader?.[rest]?.tittel ?? rest;
  if (type === 'prosjekt') return ko?.prosjekter?.[rest]?.tittel ?? rest;
  return rest.slice(rest.indexOf('/') + 1);
}

/** «T1», «T2 dratt av A-1» eller «resten» for en rad med { steg, dratt_av } (vis, neste, plukkbare). */
function stegTekst(r) {
  if (r?.steg == null) return 'resten';
  return `T${r.steg + 1}${r.dratt_av ? ` dratt av ${r.dratt_av}` : ''}`;
}

/** «1 Auth → 2 Betaling og fakturering · resten venter» */
function fokusTekst(ko) {
  const f = ko?.fokus;
  if (!f?.rekkefolge?.length) return 'ingen fokus';
  const trinn = f.rekkefolge.map((t, i) => `${i + 1} ${trinnTittel(t, ko)}`).join(' → ');
  const resten = f.resten === 'fyll' ? 'resten fyller ledige plasser' : 'resten venter';
  return `${trinn} · ${resten}${f.til ? ` · til ${utcTekst(f.til)}` : ''}`;
}

/**
 * Setter fokus (ko.mjs fokus sett). inn: { rekkefolge: [trinn], resten?, til?, navn?, dra_med_avhengigheter?, satt_av? }.
 * Alt valideres før noe endres. Advarsler (ikke feil): trinn uten åpne oppgaver, pausede prosjekter i et trinn, og
 * fokus som gir null klare oppgaver nå. Endrer `ko` bare når feillista er tom.
 * @returns {{ feil: string[], advarsler: string[], fokus?: object }}
 */
function settFokus(ko, inn, naa = new Date().toISOString()) {
  const feil = [];
  const advarsler = [];
  const naaMs = Date.parse(naa);
  const raa = Array.isArray(inn?.rekkefolge) ? inn.rekkefolge : [];
  if (!raa.length)
    feil.push(
      'fokus trenger minst ett trinn (omrade:<oid>, prosjekt:<pid> eller funksjon:<pid>/<navn>)',
    );
  const rekkefolge = [];
  for (const t of raa) {
    const r = tolkTrinn(t, ko);
    if ('feil' in r) feil.push(r.feil);
    else if (rekkefolge.includes(r.trinn)) feil.push(`${r.trinn} står flere ganger`);
    else rekkefolge.push(r.trinn);
  }
  const resten = inn?.resten ?? 'vent';
  if (!FOKUS_RESTEN.includes(resten)) feil.push(`resten må være ${FOKUS_RESTEN.join(' eller ')}`);
  let til = null;
  if (inn?.til != null && inn.til !== '') {
    til = tolkTilDato(inn.til);
    if (!til) feil.push(`ugyldig dato ${inn.til} (bruk YYYY-MM-DD eller ISO-tid)`);
    else if (Date.parse(til) <= naaMs) feil.push(`sluttdatoen ${inn.til} er passert`);
  }
  const navn = inn?.navn == null ? null : String(inn.navn).trim();
  if (navn != null && navn.length > FOKUS_MAKS_TEKST)
    feil.push(`navn kan være høyst ${FOKUS_MAKS_TEKST} tegn`);
  if (inn?.dra_med_avhengigheter != null && typeof inn.dra_med_avhengigheter !== 'boolean')
    feil.push('dra_med_avhengigheter må være true/false');
  // Hvor mange av trinnene planvisningen viser i «Nå» (resten av trinnene står i «Neste»). Bare visning;
  // rekkefølgen er den samme. Mangler feltet, er «Nå» det første trinnet.
  const naaAntall = inn?.naa_antall == null ? null : Number(inn.naa_antall);
  if (
    naaAntall != null &&
    (!Number.isInteger(naaAntall) || naaAntall < 1 || naaAntall > Math.max(rekkefolge.length, 1))
  )
    feil.push(`naa_antall må være et heltall fra 1 til ${Math.max(rekkefolge.length, 1)}`);
  if (feil.length) return { feil, advarsler };

  const fokus = {
    ...(navn ? { navn } : {}),
    fra: naa,
    til,
    rekkefolge,
    ...(naaAntall != null ? { naa_antall: naaAntall } : {}),
    resten,
    dra_med_avhengigheter: inn?.dra_med_avhengigheter !== false,
    ...(inn?.satt_av ? { satt_av: String(inn.satt_av).slice(0, FOKUS_MAKS_TEKST) } : {}),
  };
  // Advarslene regnes på en kopi med det nye fokuset, så køen ikke endres før alt er klart.
  const proeve = { ...ko, fokus };
  const register = ko.prosjekter ?? {};
  const aapne = (ko.oppgaver ?? []).filter(
    (o) => aapenOppgave(o) && o.status !== 'forslag' && !erEksternRad(o),
  );
  rekkefolge.forEach((t, i) => {
    const treff = aapne.filter((o) => trinnTreff(o, t, proeve) > 0);
    if (!treff.length) advarsler.push(`trinn ${i + 1} (${t}) har ingen åpne oppgaver`);
    const pausede = [
      ...new Set(
        treff.filter((o) => prosjektPauset(o, register)).map((o) => prosjektFor(o, register)),
      ),
    ];
    for (const pid of pausede)
      advarsler.push(`prosjektet ${pid} i trinn ${i + 1} er pauset (pause går foran fokus)`);
  });
  const status = fokusStatus(proeve, { naa: naaMs });
  if (status.aktiv && status.klare === 0)
    advarsler.push('fokuset gir ingen klare oppgaver nå (se ko.mjs fokus)');
  ko.fokus = fokus;
  return { feil: [], advarsler, fokus };
}

/** Fjerner fokuset (ko.mjs fokus av). Returnerer det gamle, eller null. */
function fjernFokus(ko) {
  const gammelt = ko.fokus ?? null;
  delete ko.fokus;
  return gammelt;
}

/** Høyst så mange trinn og pause-endringer i én plan fra tavla. */
const FOKUS_PLAN_MAKS = 50;

/**
 * Lagrer planvisningen fra tavla (ko.mjs fokus lagre) i ÉN endring, alt eller ingenting:
 *   - fokuset: { rekkefolge, naa_antall?, resten?, til?, navn?, dra_med_avhengigheter?, satt_av? } som settFokus;
 *     tom rekkefølge = fokuset fjernes (som fokus av);
 *   - kolonnen «Venter» i planen: `pause` (prosjekter som settes på pause) og `fortsett` (tas av pause).
 * Pause-endringene gjøres før fokuset sjekkes, så advarslene (pausede prosjekter i et trinn, ingen klare) gjelder køen
 * slik den blir. Endrer `ko` bare når feillista er tom.
 * @returns {{ feil: string[], advarsler: string[], fokus?: object|null, fjernet?: boolean, pauset?: string[],
 *   fortsatt?: string[] }}
 */
function lagreFokusPlan(ko, inn, naa = new Date().toISOString()) {
  const feil = [];
  const rekkefolge = Array.isArray(inn?.rekkefolge) ? inn.rekkefolge : null;
  if (!rekkefolge) feil.push('rekkefolge må være en liste (tom = ingen fokus)');
  const pause = Array.isArray(inn?.pause) ? [...new Set(inn.pause.map(String))] : [];
  const fortsett = Array.isArray(inn?.fortsett) ? [...new Set(inn.fortsett.map(String))] : [];
  if (
    (rekkefolge?.length ?? 0) > FOKUS_PLAN_MAKS ||
    pause.length + fortsett.length > FOKUS_PLAN_MAKS
  )
    feil.push(`høyst ${FOKUS_PLAN_MAKS} trinn og ${FOKUS_PLAN_MAKS} pause-endringer`);
  const register = { ...(ko.prosjekter ?? {}) };
  for (const pid of [...pause, ...fortsett])
    if (!Object.hasOwn(register, pid))
      feil.push(`ukjent prosjekt ${pid} (bare prosjekter i registeret kan pauses)`);
  const begge = pause.filter((pid) => fortsett.includes(pid));
  if (begge.length) feil.push(`${begge.join(', ')} står både i pause og fortsett`);
  if (feil.length) return { feil, advarsler: [] };

  const pauset = [];
  const fortsatt = [];
  for (const pid of pause) {
    if (register[pid].pause === true) continue;
    register[pid] = { ...register[pid], pause: true };
    pauset.push(pid);
  }
  for (const pid of fortsett) {
    if (register[pid].pause !== true) continue;
    const p = { ...register[pid] };
    delete p.pause;
    register[pid] = p;
    fortsatt.push(pid);
  }
  // Prøven: samme kø med det nye registeret, så advarslene regnes på køen slik den blir.
  const proeve = { ...ko, prosjekter: register };
  let fokus = null;
  let advarsler = [];
  if (rekkefolge.length) {
    const s = settFokus(proeve, inn, naa);
    if (s.feil.length) return { feil: s.feil, advarsler: s.advarsler };
    fokus = s.fokus;
    advarsler = s.advarsler;
  }
  const fjernet = !rekkefolge.length && !!ko.fokus;
  if (pauset.length || fortsatt.length) ko.prosjekter = register;
  if (fokus) ko.fokus = fokus;
  else delete ko.fokus;
  return { feil: [], advarsler, fokus, fjernet, pauset, fortsatt };
}

/**
 * Status for fokuset til `fokus`, `tilstand` og `vis`: hva som er i fokus, hva som er klart, hvor mange som er dratt med,
 * og varselet når perioden er ute eller fokuset ikke har noe klart (med varsel).
 * null når ingen fokus er satt.
 * @param {{ naa?: number, kanStarte?: string[], kontekst?: object }} [valg]
 */
function fokusStatus(ko, { naa = Date.now(), kanStarte = null, kontekst = null } = {}) {
  if (!ko?.fokus) return null;
  const k = kontekst ?? rangeringKontekst(ko, naa);
  const f = ko.fokus;
  const navn = f.navn ? ` «${f.navn}»` : '';
  const oppgaver = (ko.oppgaver ?? []).filter((o) => !erEksternRad(o));
  const ut = {
    navn: f.navn ?? null,
    tekst: fokusTekst(ko),
    rekkefolge: f.rekkefolge ?? [],
    resten: f.resten === 'fyll' ? 'fyll' : 'vent',
    til: f.til ?? null,
    aktiv: k.gjelder,
    utlopt: k.utlopt,
    ikke_startet: k.ikkeStartet,
    i_fokus: 0,
    klare: 0,
    pagar: 0,
    kan_starte: 0,
    dratt_med: k.dratt.size,
    per_trinn: (f.rekkefolge ?? []).map((t) => ({ trinn: t, venter: 0, klare: 0, min_igjen: 0 })),
    eiersporsmal: [],
    varsel: null,
  };
  if (k.utlopt) {
    ut.varsel =
      `Fokusperioden${navn} er ute (til ${utcTekst(f.til)}). Køen rangeres som uten fokus til den endres: ` +
      'ko.mjs fokus sett … eller ko.mjs fokus av.';
    return ut;
  }
  if (!k.gjelder) return ut;
  const kan = new Set(kanStarte ?? []);
  const sp = new Map();
  for (const o of oppgaver) {
    const p = fokusPlass(o, k);
    if (p.steg == null) continue;
    if (['kjorer', 'review', 'plukket'].includes(o.status)) {
      ut.pagar += 1;
      continue;
    }
    if (o.status !== 'venter' || erSamles(o) || p.parkert || p.pauset) continue;
    const rad = ut.per_trinn[p.steg];
    ut.i_fokus += 1;
    rad.venter += 1;
    rad.min_igjen += anslag(o);
    if (hindringer(o, ko.oppgaver ?? [], ko.avklart).length === 0) {
      ut.klare += 1;
      rad.klare += 1;
    }
    if (kan.has(o.id)) ut.kan_starte += 1;
    for (const s of aapneSporsmal(o, ko.avklart)) sp.set(s, (sp.get(s) ?? 0) + 1);
  }
  ut.eiersporsmal = [...sp.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([s, n]) => ({ sp: s, oppgaver: n }));
  if (ut.klare === 0) {
    const forste = ut.eiersporsmal[0];
    const svar = forste
      ? ` Svar på ${forste.sp} låser opp ${forste.oppgaver} oppgave(r) i fokus.`
      : '';
    const resten =
      ut.resten === 'vent'
        ? ' Resten venter, så ledige plasser står tomme til fokuset har klart arbeid eller endres (ko.mjs fokus).'
        : ' Resten fyller ledige plasser (resten: fyll).';
    ut.varsel =
      ut.i_fokus === 0 && ut.pagar === 0
        ? `Fokuset${navn} er tomt: ingenting igjen i trinnene.${resten}`
        : `Ingenting klart i fokus${navn}${ut.pagar ? ` (${ut.pagar} pågår)` : ''}.${svar}${resten}`;
  }
  return ut;
}

/**
 * Oppretter, endrer eller sletter et område (ko.mjs omrade). felt: { tittel?, beskrivelse?, prosjekter?: [pid],
 * fjern?: [pid], slett?: true }. `prosjekter` setter prosjektenes `omrade` (et prosjekt hører til ett område, så det
 * flyttes fra et annet). Sletting nektes når et prosjekt eller fokuset bruker området. Alt eller ingenting.
 * @returns {{ feil: string[], ny?: boolean, slettet?: boolean, omrade?: object, flyttet?: string[], fjernet?: string[] }}
 */
function settOmrade(ko, oid, felt = {}) {
  const feil = [];
  if (!PID_MONSTER.test(String(oid ?? '')) || oid === UTEN_OMRADE)
    return { feil: [`område-id ${oid} må være kort kebab-case (og ikke ${UTEN_OMRADE})`] };
  const omrader = { ...(ko.omrader ?? {}) };
  const register = { ...(ko.prosjekter ?? {}) };
  const finnes = Object.hasOwn(omrader, oid);
  if (felt.slett) {
    if (!finnes) return { feil: [`ukjent område ${oid}`] };
    const brukere = Object.entries(register)
      .filter(([, p]) => p?.omrade === oid)
      .map(([pid]) => pid);
    if (brukere.length)
      feil.push(
        `${oid} brukes av ${brukere.join(', ')} (flytt dem først: ko.mjs omrade ${oid} --fjern …)`,
      );
    if ((ko.fokus?.rekkefolge ?? []).includes(`omrade:${oid}`))
      feil.push(`${oid} står i fokus (endre fokus først: ko.mjs fokus sett … eller fokus av)`);
    if (feil.length) return { feil };
    delete omrader[oid];
    ko.omrader = omrader;
    return { feil: [], slettet: true };
  }
  const o = { ...(omrader[oid] ?? {}) };
  if (felt.tittel != null) o.tittel = String(felt.tittel).trim();
  if (felt.beskrivelse === null) delete o.beskrivelse;
  else if (felt.beskrivelse != null) o.beskrivelse = String(felt.beskrivelse).trim();
  if (typeof o.tittel !== 'string' || !o.tittel) feil.push(`${oid}: tittel mangler (--tittel "…")`);
  else if (o.tittel.length > FOKUS_MAKS_TEKST) feil.push(`${oid}: tittelen er for lang`);
  const flyttet = [];
  for (const pid of felt.prosjekter ?? []) {
    if (!Object.hasOwn(register, pid)) {
      feil.push(`ukjent prosjekt ${pid}`);
      continue;
    }
    register[pid] = { ...register[pid], omrade: oid };
    flyttet.push(pid);
  }
  const fjernet = [];
  for (const pid of felt.fjern ?? []) {
    if (register[pid]?.omrade !== oid) {
      feil.push(`${pid} hører ikke til ${oid}`);
      continue;
    }
    const p = { ...register[pid] };
    delete p.omrade;
    register[pid] = p;
    fjernet.push(pid);
  }
  if (feil.length) return { feil };
  omrader[oid] = o;
  ko.omrader = omrader;
  if (flyttet.length || fjernet.length) ko.prosjekter = register;
  return { feil: [], ny: !finnes, omrade: o, flyttet, fjernet };
}

/**
 * Oversikt per område til `ko.mjs omrader`: prosjektene, ventende, klare (ingen hindringer nå, ikke parkert), minutter
 * igjen, aktive og parkerte. Registerets rekkefølge, ukjente områder (prosjekt peker på et område som ikke finnes)
 * alfabetisk, `uten-omrade` sist.
 */
function omradeOversikt(ko, naa = Date.now()) {
  const omrader = ko.omrader ?? {};
  const oppgaver = (ko.oppgaver ?? []).filter((o) => !erEksternRad(o));
  const rader = new Map();
  const rad = (oid) => {
    if (!rader.has(oid))
      rader.set(oid, {
        oid,
        tittel: omrader[oid]?.tittel ?? null,
        beskrivelse: omrader[oid]?.beskrivelse ?? null,
        i_register: Object.hasOwn(omrader, oid),
        prosjekter: [],
        venter: 0,
        klare: 0,
        parkert: 0,
        aktive: 0,
        min_igjen: 0,
      });
    return rader.get(oid);
  };
  for (const oid of Object.keys(omrader)) rad(oid);
  for (const p of prosjektOversikt(ko)) {
    const oid = omradeFor({ prosjekt: p.pid }, ko);
    rad(oid).prosjekter.push(p.pid);
  }
  for (const o of oppgaver) {
    if (!aapenOppgave(o) || o.status === 'forslag') continue;
    const r = rad(omradeFor(o, ko));
    r.min_igjen += anslag(o);
    if (o.status === 'kjorer' || o.status === 'review' || o.status === 'plukket') r.aktive += 1;
    if (o.status !== 'venter' || erSamles(o)) continue;
    r.venter += 1;
    if (parkertNaa(o, naa)) r.parkert += 1;
    else if (hindringer(o, ko.oppgaver ?? [], ko.avklart).length === 0) r.klare += 1;
  }
  const iRegister = Object.keys(omrader);
  const ukjente = [...rader.keys()]
    .filter((x) => !iRegister.includes(x) && x !== UTEN_OMRADE)
    .sort((x, y) => x.localeCompare(y, 'nb'));
  return [...iRegister, ...ukjente, ...(rader.has(UTEN_OMRADE) ? [UTEN_OMRADE] : [])].map((oid) =>
    rader.get(oid),
  );
}

/**
 * Parkerer oppgaver («sett på vent», ko.mjs parker). Bare `venter` og `forslag` kan parkeres. `til` (YYYY-MM-DD eller
 * ISO) må være i framtiden. Advarer når en oppgave er dratt med av noe i fokus (da står fokusoppgaven også). Alt eller
 * ingenting; en parkert oppgave kan parkeres på nytt (grunn og dato oppdateres).
 * @returns {{ feil: string[], parkert?: string[], advarsler?: string[] }}
 */
function parker(ko, ider, { av, grunn = null, til = null, naa = new Date().toISOString() } = {}) {
  const feil = [];
  const naaMs = Date.parse(naa);
  const liste = [...new Set(ider ?? [])];
  if (!liste.length) feil.push('parker <id> …');
  const hvem = String(av ?? '').trim() || 'ukjent';
  const g = grunn == null ? null : String(grunn).trim();
  if (g && g.length > FOKUS_MAKS_TEKST)
    feil.push(`grunnen kan være høyst ${FOKUS_MAKS_TEKST} tegn`);
  let tilIso = null;
  if (til != null && til !== '') {
    tilIso = tolkTilDato(til);
    if (!tilIso) feil.push(`ugyldig dato ${til} (bruk YYYY-MM-DD eller ISO-tid)`);
    else if (Date.parse(tilIso) <= naaMs) feil.push(`datoen ${til} er passert`);
  }
  const perId = new Map((ko.oppgaver ?? []).map((o) => [o.id, o]));
  const valgt = [];
  for (const id of liste) {
    const o = perId.get(id);
    if (!o || erEksternRad(o)) feil.push(`ukjent oppgave ${id}`);
    else if (o.status !== 'venter' && o.status !== 'forslag')
      feil.push(`${id}: status ${o.status} (bare venter og forslag kan parkeres)`);
    else valgt.push(o);
  }
  if (feil.length) return { feil };
  const advarsler = [];
  const k = rangeringKontekst(ko, naaMs);
  for (const o of valgt) {
    const d = k.dratt.get(o.id);
    if (d && !liste.includes(d.av))
      advarsler.push(
        `${o.id} er dratt med av ${d.av} i fokus (trinn ${d.trinn + 1}); den står til ${o.id} fortsetter`,
      );
  }
  for (const o of valgt)
    o.parkert = {
      av: hvem,
      at: naa,
      ...(g ? { grunn: g } : {}),
      ...(tilIso ? { til: tilIso } : {}),
    };
  return { feil: [], parkert: valgt.map((o) => o.id), advarsler };
}

/**
 * Tar oppgaver av vent (ko.mjs fortsett). Ukjente id-er er feil (ingenting endres); en som ikke var parkert, meldes.
 * @returns {{ feil: string[], fortsatt?: string[], ikkeParkert?: string[] }}
 */
function fortsett(ko, ider) {
  const liste = [...new Set(ider ?? [])];
  if (!liste.length) return { feil: ['fortsett <id> …'] };
  const perId = new Map((ko.oppgaver ?? []).map((o) => [o.id, o]));
  const feil = liste.filter((id) => !perId.has(id)).map((id) => `ukjent oppgave ${id}`);
  if (feil.length) return { feil };
  const fortsatt = [];
  const ikkeParkert = [];
  for (const id of liste) {
    const o = perId.get(id);
    if (o.parkert) {
      delete o.parkert;
      fortsatt.push(id);
    } else ikkeParkert.push(id);
  }
  return { feil: [], fortsatt, ikkeParkert };
}

/** Normaliserer en sti: skråstreker, ingen ./ foran. */
function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Overlapper to fil-eierskap? En oppføring som slutter på «/» eier hele mappa.
 * Eksakt sti ellers. (Bevisst enkelt: glob-mønstre ville gitt falsk trygghet.)
 */
function filOverlapp(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (x.endsWith('/') && y.startsWith(x)) return true;
  if (y.endsWith('/') && x.startsWith(y)) return true;
  return false;
}

/**
 * Første konflikt mellom en kandidat og en aktiv oppgave, med detaljene (vaktreglene på tavla trenger
 * hvem og hva, ikke bare teksten), eller null.
 * @returns {{ type: 'fil'|'db'|'patch', navn: string, med: string, tekst: string } | null}
 */
function konfliktDel(kandidat, aktiv) {
  // En registrering utenfor køen (ekstern add) navngis med økta eller personen, så hindringen sier hvem som jobber.
  const eier = erEksternRad(aktiv)
    ? `${aktiv.id} (arbeid utenfor køen: ${aktiv.ekstern_navn ?? '?'})`
    : aktiv.id;
  for (const f of kandidat.eier_filer ?? []) {
    for (const g of aktiv.eier_filer ?? []) {
      if (filOverlapp(f, g))
        return {
          type: 'fil',
          navn: norm(f),
          med: aktiv.id,
          tekst: `fil ${norm(f)} eies av ${eier}`,
        };
    }
  }
  const dbAktiv = new Set((aktiv.eier_db ?? []).map((s) => s.toLowerCase()));
  for (const d of kandidat.eier_db ?? []) {
    if (dbAktiv.has(d.toLowerCase()))
      return { type: 'db', navn: d, med: aktiv.id, tekst: `DB-funksjon ${d} eies av ${eier}` };
  }
  // Én dynamisk patch av hver delt funksjon om gangen (f.eks. en felles eksport- eller anonymiseringsfunksjon).
  const patchAktiv = new Set((aktiv.delt_patch ?? []).map((s) => s.toLowerCase()));
  for (const d of kandidat.delt_patch ?? []) {
    if (patchAktiv.has(d.toLowerCase()))
      return {
        type: 'patch',
        navn: d,
        med: aktiv.id,
        tekst: `delt patch ${d} pågår i ${aktiv.id}`,
      };
  }
  return null;
}

/** Første konflikt mellom en kandidat og en aktiv oppgave (som tekst), eller null. */
function konflikt(kandidat, aktiv) {
  return konfliktDel(kandidat, aktiv)?.tekst ?? null;
}

/**
 * Hindringene med detaljene: [{ type, tekst, … }], der `tekst` er nøyaktig det `hindringer` gir. Typene:
 * status (forslag, plukket eller annen status), avhenger { id, status } (status null = ukjent oppgave),
 * sporsmal { sp }, og konflikt { konflikt: konfliktDel }. (Grensene sjekkes i velgNeste.)
 */
function hindringDeler(o, oppgaver, avklart = []) {
  if (o.status === 'forslag')
    return [{ type: 'status', tekst: `forslag (godkjenn først: ko.mjs godkjenn ${o.id})` }];
  if (o.status === 'plukket')
    return [{ type: 'status', tekst: `plukket av ${o.plukket_av ?? '?'}` }];
  if (o.status !== 'venter') return [{ type: 'status', tekst: `status ${o.status}` }];
  // En oppgave i samlekøen startes og plukkes aldri alene; den pakkes til et spor (ko.mjs samle pakk).
  if (erSamles(o)) return [{ type: 'samles', tekst: SAMLES_HINDRING }];
  const h = [];
  const perId = new Map(oppgaver.map((x) => [x.id, x]));
  for (const dep of o.avhenger ?? []) {
    const d = perId.get(dep);
    if (!d) h.push({ type: 'avhenger', id: dep, status: null, tekst: `avhenger av ukjent ${dep}` });
    else if (d.status !== 'ferdig')
      h.push({
        type: 'avhenger',
        id: dep,
        status: d.status,
        tekst: `venter på ${dep} (${d.status})`,
      });
  }
  const avklartSett = new Set(avklart);
  for (const sp of o.venter_paa ?? []) {
    if (!avklartSett.has(sp)) h.push({ type: 'sporsmal', sp, tekst: `venter på svar: ${sp}` });
  }
  for (const a of oppgaver.filter((x) => AKTIVE.has(x.status))) {
    const k = konfliktDel(o, a);
    if (k) h.push({ type: 'konflikt', konflikt: k, tekst: k.tekst });
  }
  return h;
}

/** Hvorfor kan ikke oppgaven startes nå? Tom liste = den kan. (Grensene sjekkes i velgNeste.) */
function hindringer(o, oppgaver, avklart = []) {
  return hindringDeler(o, oppgaver, avklart).map((h) => h.tekst);
}

/** Etterfølgerne per oppgave: id → id-ene som har den i `avhenger` (til etterfolgere; lag det én gang for mange kall). */
function barnKart(oppgaver) {
  const barn = new Map();
  for (const o of oppgaver) {
    for (const d of o.avhenger ?? []) {
      if (!barn.has(d)) barn.set(d, []);
      barn.get(d).push(o.id);
    }
  }
  return barn;
}

/**
 * Oppgavene som venter på denne, direkte eller indirekte (transitivt gjennom `avhenger`), og som fortsatt skal gjøres
 * (ikke ferdig eller kansellert). Sykluser tåles (hver oppgave besøkes én gang), og oppgaven selv er aldri med.
 * Samme telling som bonusen i prioriteten (lasOppAntall) og «låser opp N» på tavla.
 * @param {Map<string, string[]>} [barn] barnKart(oppgaver), når mange oppgaver slås opp
 * @returns {string[]} id-ene i den rekkefølgen de ble funnet
 */
function etterfolgere(id, oppgaver, barn = barnKart(oppgaver)) {
  const sett = new Set();
  const stakk = [...(barn.get(id) ?? [])];
  while (stakk.length) {
    const x = stakk.pop();
    if (sett.has(x) || x === id) continue;
    sett.add(x);
    stakk.push(...(barn.get(x) ?? []));
  }
  // Bare oppgaver som fortsatt skal gjøres, teller.
  const perId = new Map(oppgaver.map((o) => [o.id, o]));
  return [...sett].filter((x) => !['ferdig', 'kansellert'].includes(perId.get(x)?.status));
}

/** Hvor mange oppgaver (direkte eller indirekte) venter på denne? Gir bonus for å låse opp andre. */
function lasOppAntall(id, oppgaver) {
  return etterfolgere(id, oppgaver).length;
}

/**
 * Prioritet: nytte per anslått minutt, med bonus for oppgaver som låser opp andre og en liten
 * aldersbonus så ingenting blir liggende for alltid. Manuell `prioritet_tillegg` (±) fra omprioritering, pluss
 * prosjektets `prioritet_tillegg` fra registeret (når `register` er gitt).
 */
function score(o, oppgaver, naa = Date.now(), register) {
  return scoreDeler(o, oppgaver, naa, register).score;
}

/**
 * Delene prioriteten (score) er regnet av, til «Plassering» i detaljpanelet på tavla: nytte, minuttene
 * som brukes (minst 5), låser opp N (+25 % hver), alder i dager (+2 % per dag, høyst 14), oppgavens og prosjektets
 * tillegg, og resultatet. score() er bare `.score` herfra, så forklaringen aldri kan skille seg fra tallet.
 * @returns {{ nytte: number, minutter: number, laaser_opp: number, laas_faktor: number, dager: number,
 *   alder_faktor: number, grunn: number, tillegg: number, prosjekt_tillegg: number, score: number }}
 */
function scoreDeler(o, oppgaver, naa = Date.now(), register) {
  const nytte = Number(o.nytte ?? 5);
  const tid = Math.max(anslag(o), 5);
  const las = lasOppAntall(o.id, oppgaver);
  const dager = o.lagt_til ? Math.max(0, (naa - Date.parse(o.lagt_til)) / 86_400_000) : 0;
  const laasFaktor = 1 + 0.25 * las;
  const alderFaktor = 1 + Math.min(dager, 14) * 0.02;
  const s = (nytte / tid) * 100 * laasFaktor * alderFaktor;
  const prosjektTillegg = register
    ? Number(register[prosjektFor(o, register)]?.prioritet_tillegg) || 0
    : 0;
  const tillegg = Number(o.prioritet_tillegg ?? 0);
  return {
    nytte,
    minutter: tid,
    laaser_opp: las,
    laas_faktor: laasFaktor,
    dager: Math.round(dager * 10) / 10,
    alder_faktor: Math.round(alderFaktor * 1000) / 1000,
    grunn: Math.round(s * 100) / 100,
    tillegg,
    prosjekt_tillegg: prosjektTillegg,
    score: Math.round((s + tillegg + prosjektTillegg) * 100) / 100,
  };
}

/**
 * Velger oppgavene som kan startes nå, i prioritert rekkefølge, innenfor grensene.
 * Kandidatene sjekkes også mot hverandre: to valgte oppgaver kan ikke eie det samme.
 * Prosjekter med `pause` hoppes over, og prosjektets `prioritet_tillegg` legges til oppgavens prioritet.
 * En plukket oppgave (person/økt) eier filene sine og teller mot maksDb og maksPerDomene (den tester og fletter
 * som et spor), men ikke mot maksSamtidig/maksDPluss, som gjelder køens agenter.
 * `ucommittet`: stiene `git status` viser i hovedtreet. En oppgave som eier en av dem, hoppes over (en annen
 * økt jobber i fila); `ucommittetHoppet` sier hvilke og hvorfor.
 */
/** Har oppgaven migrasjoner (teller mot maksDb)? */
const harMigr = (o) => Number(o.migr_tiere ?? 0) > 0;

/**
 * Plassene i bruk nå, med samme regler som velgNeste: agenter (kjorer og review uten plukket_av) mot maksSamtidig og
 * maksDPluss; alle som eier noe (aktive, ikke registreringer utenfor køen) mot maksDb og maksPerDomene.
 * @returns {{ grenser: object, agenter: number, ledige: number, dPluss: number, db: number, perDomene: Map<string, number> }}
 */
function plassBruk(ko) {
  const oppgaver = ko.oppgaver ?? [];
  const g = { ...STANDARD_GRENSER, ...(ko.grenser ?? {}) };
  // Registreringer utenfor køen eier filer (hindringer), men tar ingen plass i grensene.
  const eiere = oppgaver.filter((o) => AKTIVE.has(o.status) && !erEksternRad(o));
  const agenter = oppgaver.filter(tellerSomAgent);
  const perDomene = new Map();
  for (const a of eiere) perDomene.set(a.domene, (perDomene.get(a.domene) ?? 0) + 1);
  return {
    grenser: g,
    agenter: agenter.length,
    ledige: g.maksSamtidig - agenter.length,
    dPluss: agenter.filter((o) => o.klasse === 'D+').length,
    db: eiere.filter(harMigr).length,
    perDomene,
  };
}

function velgNeste(ko, naa = Date.now(), { ucommittet = [] } = {}) {
  const oppgaver = ko.oppgaver ?? [];
  const register = ko.prosjekter ?? {};
  const bruk = plassBruk(ko);
  const g = bruk.grenser;
  let { ledige, dPluss, db } = bruk;
  const perDomene = bruk.perDomene;

  // Felles rangering (parkert, pauset og utenfor fokus er ute; så fokustrinn, score, id). Uten fokus og
  // uten parkerte er dette nøyaktig det gamle filteret (pause) og den gamle sorteringen (score, id).
  const k = rangeringKontekst(ko, naa);
  const kandidater = oppgaver
    .filter(
      (o) =>
        o.status === 'venter' &&
        hindringer(o, oppgaver, ko.avklart).length === 0 &&
        !ucommittetKollisjon(o, ucommittet),
    )
    .map((o) => ({ o, r: rangering(o, ko, k) }))
    .filter((x) => !x.r.ut)
    .sort(sammenlignRangering)
    .map(({ o, r }) => ({ o, s: r.score, r }));

  const valgt = [];
  for (const { o, s, r } of kandidater) {
    if (ledige <= 0) break;
    if (o.klasse === 'D+' && dPluss >= g.maksDPluss) continue;
    if (harMigr(o) && db >= g.maksDb) continue;
    if ((perDomene.get(o.domene) ?? 0) >= g.maksPerDomene) continue;
    if (valgt.some((v) => konflikt(o, v.o) || konflikt(v.o, o))) continue;
    valgt.push({ o, s, r });
    ledige -= 1;
    if (o.klasse === 'D+') dPluss += 1;
    if (harMigr(o)) db += 1;
    perDomene.set(o.domene, (perDomene.get(o.domene) ?? 0) + 1);
  }
  return valgt.map(({ o, s, r }) => ({
    id: o.id,
    score: s,
    anslag: anslag(o),
    klasse: o.klasse,
    domene: o.domene,
    prosjekt: prosjektFor(o, register),
    // Bare når fokus gjelder (ellers samme rad som før): trinnet (0-basert, null = resten med `fyll`) og dratt med.
    ...(k.gjelder ? { steg: r.steg, dratt_av: r.dratt_av } : {}),
  }));
}

/**
 * Tildeler neste ledige migrasjonsblokk. En oppgave med `migr_tiere` > 0 får så mange blokker à `storrelse` numre
 * (konfig().migrasjoner.blokkStorrelse, standard 10), og blokka starter på et helt multiplum av størrelsen.
 * Returnerer { fra, til, nesteLedig }.
 */
function tildelMigrBlokk(nesteLedig, tiere, storrelse = 10) {
  if (!tiere || tiere <= 0) return { fra: null, til: null, nesteLedig };
  const s = Number(storrelse) > 0 ? Math.floor(Number(storrelse)) : 10;
  const fra = Math.ceil(nesteLedig / s) * s;
  const til = fra + tiere * s - 1;
  return { fra, til, nesteLedig: til + 1 };
}

/**
 * Hvor mange migrasjonsblokker oppgaven skal ha: `migr_tiere`, men 0 når prosjektet ikke har migrasjonsflyt
 * (konfig().migrasjoner.mappe er null). Da får ingen oppgave blokk, og ingenting blokkeres av migrasjoner.
 */
function migrTiere(o, migrasjoner = kfg().migrasjoner) {
  if (!migrasjoner?.mappe) return 0;
  const t = Number(o?.migr_tiere ?? 0);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * Er køen tom for arbeid? Tom = ingenting kjører og ingenting kan startes. Returnerer også hva som er blokkert.
 * Med `dagsforbruk` (USD i dag, fra tidKost.js) og et dagsbudsjett som er brukt opp, kan ingenting
 * startes (stopp: 'dagsbudsjett'), så løkka stopper når de kjørende er ferdige.
 * `ucommittet`: som i velgNeste; en oppgave som bare stoppes av en ucommittet fil, får den som hindring.
 * Nattpause: med nattkjøring av og `naa` inne i nattvinduet kan heller ingenting startes
 * (stopp: 'nattpause', natt: meldingen), på samme måte som budsjettvakta.
 */
function tilstand(ko, dagsforbruk, { ucommittet = [], naa = Date.now(), markor = null } = {}) {
  const oppgaver = ko.oppgaver ?? [];
  // Aktive = det orkestratoren venter på (kjører eller skal flettes). En plukket oppgave holder ikke løkka i gang:
  // personen eller økta som plukket den, leverer (review) eller fletter selv.
  const aktive = oppgaver.filter((o) => o.status === 'kjorer' || o.status === 'review');
  const plukket = oppgaver.filter((o) => o.status === 'plukket');
  // Samlekøen telles for seg (den venter på å bli pakket, ikke på å bli startet).
  const venter = oppgaver.filter((o) => o.status === 'venter' && !erSamles(o));
  const samles = oppgaver.filter(iSamlekoen);
  const vakt = startVakt(ko, dagsforbruk, { naa, markor });
  const kanStarte = vakt ? [] : velgNeste(ko, naa, { ucommittet });
  const vaktHindring = vakt?.stopp === 'dagsbudsjett' ? 'dagsbudsjettet er brukt opp' : vakt?.kort;
  const rk = rangeringKontekst(ko, naa);
  const blokkert = venter
    .filter((o) => !kanStarte.some((k) => k.id === o.id))
    .map((o) => {
      const h = hindringerMedPause(o, ko, rk);
      const u = h.length ? null : ucommittetKollisjon(o, ucommittet);
      if (u) h.push(`fil ${u.sti} er ucommittet i hovedtreet`);
      return {
        id: o.id,
        hindringer: vakt && !h.length ? [vaktHindring] : h,
      };
    });
  const parkert = venter.filter((o) => parkertNaa(o, naa)).length;
  // Eierspørsmål som låser opp flest oppgaver, først.
  const sporsmal = new Map();
  for (const o of venter) {
    for (const sp of o.venter_paa ?? []) {
      if (!(ko.avklart ?? []).includes(sp)) sporsmal.set(sp, (sporsmal.get(sp) ?? 0) + 1);
    }
  }
  return {
    aktive: aktive.length,
    plukket: plukket.length,
    venter: venter.length,
    forslag: oppgaver.filter((o) => o.status === 'forslag' && !erSamles(o)).length,
    samles: samles.length,
    qa: oppgaver.filter((o) => o.status === 'ferdig' && o.qa_status === 'venter').length,
    ekstern: oppgaver.filter((o) => o.status === 'ekstern').length,
    kanStarte: kanStarte.length,
    tom: aktive.length === 0 && kanStarte.length === 0,
    ...(vakt?.stopp === 'dagsbudsjett' ? { stopp: 'dagsbudsjett', budsjett: vakt.melding } : {}),
    ...(vakt?.stopp === 'nattpause' ? { stopp: 'nattpause', natt: vakt.melding } : {}),
    ...(vakt?.stopp === 'avvikling' ? { stopp: 'avvikling', avvikling: vakt.melding } : {}),
    blokkert,
    eiersporsmal: [...sporsmal.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([sp, n]) => ({ sp, oppgaver: n })),
    // Bare når noe er parkert eller fokus er satt (ellers samme svar som før).
    ...(parkert ? { parkert } : {}),
    ...(ko.fokus
      ? {
          fokus: fokusStatus(ko, {
            naa,
            kanStarte: kanStarte.map((x) => x.id),
            kontekst: rk,
          }),
        }
      : {}),
  };
}

// ---- Budsjettvakt -----------------------------------------------------------------------------------------

/**
 * Er dagens forbruk over dagsbudsjettet? `grenser.dagsbudsjett` i køfila er USD API-ekvivalent per norsk døgn; ikke
 * satt, null, 0 eller negativt = av. Forbruket måles av kalleren (ko.mjs leser tidsloggen via tidKost.js).
 * Forbruket til agenter som fortsatt kjører, telles først når de stopper (hook-tid skriver raden da), så vakten
 * slår til litt etter at grensen faktisk er passert: sett grensen med margin.
 * @param {object} ko køen
 * @param {number|undefined} dagsforbruk USD brukt i dag
 * @returns {{ aktiv: boolean, stopp: boolean, grense?: number, forbruk?: number, melding?: string }}
 */
function budsjettVakt(ko, dagsforbruk) {
  const grense = Number(ko?.grenser?.dagsbudsjett);
  if (ko?.grenser?.dagsbudsjett == null || !Number.isFinite(grense) || grense <= 0) {
    return { aktiv: false, stopp: false };
  }
  const forbruk = Math.round(Number(dagsforbruk ?? 0) * 100) / 100;
  const stopp = forbruk >= grense;
  const tall = `${forbruk.toFixed(2)} av ${grense.toFixed(2)} USD (API-ekvivalent, norsk døgn)`;
  return {
    aktiv: true,
    stopp,
    grense,
    forbruk,
    melding: stopp
      ? `DAGSBUDSJETTET ER BRUKT OPP: ${tall}. Ingen nye oppgaver startes i dag. Kjørende oppgaver fullføres ` +
        'som vanlig. Eieren kan heve grensen (ko.mjs grense dagsbudsjett <usd>) eller starte én oppgave med start <id> --tving.'
      : `Dagsbudsjett: ${tall} brukt.`,
  };
}

// ---- Nattvakt ---------------------------------------------------------------------------------------

/** «23-06» → { fra: 23, til: 6 }. To sifre på hver side (00–23), og fra og til kan ikke være like. Ellers null. */
function tolkNattvindu(s) {
  const m = /^([01]\d|2[0-3])-([01]\d|2[0-3])$/.exec(String(s ?? '').trim());
  if (!m || m[1] === m[2]) return null;
  return { fra: Number(m[1]), til: Number(m[2]) };
}

/** Timen (0–23) et tidspunkt har i tidssonen `tz` (norsk tid som standard, sommertid tatt hensyn til). */
function timeI(naa, tz = NATT_TZ) {
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })
    .format(new Date(naa))
    .replace(/\D/g, '');
  return Number(t) % 24;
}

/** Er tidspunktet inne i nattvinduet? Et vindu over midnatt («23-06») gjelder fra kl. 23 til kl. 06. */
function iNattvindu(vindu, naa = Date.now(), tz = NATT_TZ) {
  if (!vindu) return false;
  const t = timeI(naa, tz);
  return vindu.fra < vindu.til ? t >= vindu.fra && t < vindu.til : t >= vindu.fra || t < vindu.til;
}

const klokkeslett = (t) => `${String(t).padStart(2, '0')}:00`;

/**
 * Nattpause: med `grenser.nattkjoring` = false startes ingen nye oppgaver inne i nattvinduet (norsk tid). Kjørende
 * oppgaver går ferdig, og leverte spor tas imot og flettes som vanlig; bare nye starter stopper. Standard (på) gir
 * uendret oppførsel. `ko.mjs neste` gir da exit 5 og `start` nekter uten --tving (startVakt).
 * @returns {{ aktiv: boolean, stopp: boolean, til?: string, kort?: string, melding?: string }}
 */
function nattVakt(ko, naa = Date.now(), tz = NATT_TZ) {
  const g = { ...STANDARD_GRENSER, ...(ko?.grenser ?? {}) };
  if (g.nattkjoring !== false) return { aktiv: false, stopp: false };
  const v = tolkNattvindu(g.nattvindu) ?? tolkNattvindu(STANDARD_GRENSER.nattvindu);
  const stopp = iNattvindu(v, naa, tz);
  const fra = klokkeslett(v.fra);
  const til = klokkeslett(v.til);
  const kort = `nattpause til ${til}`;
  return {
    aktiv: true,
    stopp,
    til,
    kort,
    melding: stopp
      ? `Nattpause til ${til}: nattkjøring er av, så ingen nye oppgaver startes mellom ${fra} og ${til} (norsk tid). ` +
        'Kjørende oppgaver går ferdig, og leverte spor tas imot og flettes som vanlig. Eieren kan slå nattkjøring på ' +
        '(ko.mjs grense nattkjoring på) eller starte én oppgave med start <id> --tving.'
      : `Nattkjøring er av: ingen nye oppgaver startes mellom ${fra} og ${til} (norsk tid).`,
  };
}

/**
 * Stopper budsjettvakta, nattvakta eller avviklingsvakta nye starter nå? Budsjettet først (exit 4), så natta
 * (exit 5), så avviklingen (exit 6; krever `markor`, orkestrator-markøren). `tving` (eierens ord,
 * `start --tving`) overstyrer alle tre. Brukes av `neste`, `start`, `fyll`, `vis` og `tilstand`.
 * @returns {{ kode: 4|5|6, stopp: 'dagsbudsjett'|'nattpause'|'avvikling', kort?: string, melding: string } | null}
 */
function startVakt(ko, dagsforbruk, { naa = Date.now(), tving = false, markor = null } = {}) {
  if (tving) return null;
  const b = budsjettVakt(ko, dagsforbruk);
  if (b.stopp) return { kode: 4, stopp: 'dagsbudsjett', melding: b.melding };
  const n = nattVakt(ko, naa);
  if (n.stopp) return { kode: 5, stopp: 'nattpause', kort: n.kort, melding: n.melding };
  const av = avviklingVakt(markor, naa);
  if (av.stopp) return { kode: 6, stopp: 'avvikling', kort: av.kort, melding: av.melding };
  return null;
}

// ---- Avviklingsvakt -----------------------------------------------------------------------------

/** Den løpende overleveringslappen i datamappa (samme sti som kontekstVakt.OVERLEVERING_LAPP). */
function overleveringLapp() {
  let mappe = 'scripts/.ko';
  try {
    mappe = String(kfg().dataMappe || mappe);
  } catch {
    // ingen konfig: standardmappa
  }
  return `${mappe.replace(/\\/g, '/').replace(/\/+$/, '')}/overlevering-lopende.md`;
}

/**
 * Er orkestratoren i avvikling? hook-kontekst.mjs setter `avvikling` i orkestrator-markøren når den aktive
 * orkestratorøkta passerer ca. 350k kontekst (kontekstVakt.js). Da startes ingen nye oppgaver
 * (`neste`, `start` og `fyll` gir exit 6), mens mottak, review, retterunder, fletting og `sett` går som før.
 * Gjelder bare så lenge markøren er aktiv (ikke utløpt). Normalveien ut er komprimering:
 * hook-etter-kompakt.mjs opphever avviklingen. Nullstilles også når en ny økt tar markøren (nødrotasjon:
 * `orkestrator puls --okt "<nytt navn>"`, eller hooken binder markøren til en annen økt) og med `orkestrator stopp`.
 * @returns {{ aktiv: boolean, stopp: boolean, kort?: string, melding?: string }}
 */
function avviklingVakt(markor, naa = Date.now()) {
  if (!markor?.avvikling || !orkestratorStatus(markor, naa).aktiv)
    return { aktiv: false, stopp: false };
  const fra = markor.avvikling.fra ?? '?';
  const kontekst = markor.avvikling.kontekst
    ? ` ved ca. ${Math.round(markor.avvikling.kontekst / 1000)}k tokens`
    : '';
  return {
    aktiv: true,
    stopp: true,
    kort: 'avvikling (komprimer økta)',
    melding:
      `AVVIKLING: orkestratorøkta «${markor.okt ?? '?'}» gikk i avvikling ${fra}${kontekst}. Ingen nye oppgaver ` +
      'startes fra denne økta. Gjør ferdig mottak, review, retterunder og fletting av startede oppgaver, oppdater ' +
      `overleveringslappen (${overleveringLapp()}) og be eieren komprimere nå (hook-meldingen har ` +
      'en ferdig /compact-linje); avviklingen oppheves av seg selv etter komprimeringen. Ny økt bare som ' +
      'nødløsning (økta har hengt): `ko.mjs orkestrator puls --okt "<nytt navn>"` nullstiller avviklingen. ' +
      'Eierens ord: start <id> --tving.',
  };
}

/** Grensene som kan settes med `ko.mjs grense <navn> <verdi>`. */
const GRENSE_NAVN = [
  'maksSamtidig',
  'maksDPluss',
  'maksPerDomene',
  'maksDb',
  'dagsbudsjett',
  'nattkjoring',
  'nattvindu',
  'autokompakt',
];

/**
 * Grenser som `ko.mjs grense` også setter, men som ikke er plassgrenser (står ikke i GRENSE_NAVN, så
 * innstillingspanelet på tavla, koTavle.INNSTILLINGER, er uendret). parallellTerskel: andelen av maksSamtidig under
 * hvilken fyll, motta og puls skriver en rask kødiagnose (koDiagnose.js); standard 0.7, 0 = av.
 */
const GRENSE_EKSTRA = ['parallellTerskel'];

/** En grenseverdi som tekst: null = «av», true/false = «på»/«av». */
function grenseTekst(navn, v) {
  if (v == null) return 'av';
  if (typeof v === 'boolean') return v ? 'på' : 'av';
  return String(v);
}

/**
 * Tolker en ny grenseverdi. maks*: heltall ≥ 0 (maksSamtidig 0 stopper køen). dagsbudsjett: tall > 0 (USD), eller
 * «av» for ingen grense. nattkjoring: «på» eller «av». nattvindu: «HH-HH» i norsk tid, f.eks. 23-06. autokompakt:
 * «på»/«auto» eller «av»/«manuell».
 * Med `gjeldende` (grensene slik de er nå) kan maksDPluss ikke bli større enn maksSamtidig. maksDb kan det:
 * plukkede oppgaver teller i maksDb, men ikke i maksSamtidig, så 6 spor med migrasjoner og 5 agenter gir mening.
 * @returns {{ verdi: number|boolean|string|null } | { feil: string }}
 */
function tolkGrense(navn, raa, gjeldende) {
  if (!GRENSE_NAVN.includes(navn) && !GRENSE_EKSTRA.includes(navn))
    return { feil: `ukjent grense ${navn} (${[...GRENSE_NAVN, ...GRENSE_EKSTRA].join(', ')})` };
  // Tolkes i koDiagnose (lastes her, ikke øverst, fordi koDiagnose selv bruker denne fila).
  if (navn === 'parallellTerskel') return require('./koDiagnose.js').tolkTerskel(raa);
  const s = String(raa ?? '').trim();
  if (navn === 'dagsbudsjett') {
    if (['av', 'ingen', 'null'].includes(s.toLowerCase())) return { verdi: null };
    const v = Number(s.replace(',', '.'));
    if (!s || !Number.isFinite(v) || v <= 0)
      return { feil: 'dagsbudsjett må være et tall > 0 (USD) eller «av»' };
    return { verdi: Math.round(v * 100) / 100 };
  }
  if (navn === 'nattkjoring') {
    const x = s.toLowerCase();
    if (['på', 'pa', 'on', 'ja'].includes(x)) return { verdi: true };
    if (['av', 'off', 'nei'].includes(x)) return { verdi: false };
    return { feil: 'nattkjoring må være «på» eller «av»' };
  }
  if (navn === 'autokompakt') {
    const x = s.toLowerCase();
    if (['på', 'pa', 'on', 'ja', 'auto'].includes(x)) return { verdi: true };
    if (['av', 'off', 'nei', 'manuell'].includes(x)) return { verdi: false };
    return { feil: 'autokompakt må være «på» (auto) eller «av» (manuell)' };
  }
  if (navn === 'nattvindu') {
    const v = tolkNattvindu(s);
    if (!v)
      return {
        feil: 'nattvindu må ha formen HH-HH i norsk tid (to sifre, 00–23), f.eks. 23-06, og fra og til kan ikke være like',
      };
    return { verdi: `${String(v.fra).padStart(2, '0')}-${String(v.til).padStart(2, '0')}` };
  }
  if (!/^\d+$/.test(s)) return { feil: `${navn} må være et heltall ≥ 0` };
  const v = Number(s);
  if (navn === 'maksDPluss' && gjeldende) {
    const maks = Number(gjeldende.maksSamtidig);
    if (Number.isFinite(maks) && v > maks)
      return { feil: `${navn} kan ikke være større enn maksSamtidig (${maks})` };
  }
  return { verdi: v };
}

// ---- Forslag ----------------------------------------------------------------------------------------------

/**
 * Er `lagt_til_av` en agent? Protokollen sier at agenter setter sin egen id: et spor (en oppgave-id i køen, også en
 * retterunde som «A-4-r2»), en reviewer («rev-…», «review …») eller en fold-/utredningsagent («… agent …»). Eieren
 * (legg-til-ko) og orkestratoren bruker andre merkelapper, og deres oppgaver går rett til venter.
 */
function erAgentKilde(lagtTilAv, oppgaver = []) {
  const s = String(lagtTilAv ?? '').trim();
  if (!s) return false;
  const ider = new Set(oppgaver.map((o) => o.id));
  if (ider.has(s)) return true;
  const utenRunde = s.replace(/-(?:r|runde)\d+$/i, '');
  if (utenRunde !== s && ider.has(utenRunde)) return true;
  return /^(?:rev|review|fold)\b/i.test(s) || /\bagent\b/i.test(s);
}

/**
 * Statusen en ny oppgave får i `ko.mjs add`: forslag når en agent la den inn, ellers venter. `godkjent` (flagget
 * --godkjent, bare for orkestratoren eller eieren) gir venter uansett, for eksempel for et HØY-funn fra review.
 */
function statusVedAdd(ny, oppgaver = [], { godkjent = false } = {}) {
  if (godkjent) return 'venter';
  return erAgentKilde(ny?.lagt_til_av, oppgaver) ? 'forslag' : 'venter';
}

/**
 * Godkjenner forslag: forslag → venter. Endrer oppgavene i `ko` (kalleren skriver fila under lås).
 * @returns {{ godkjent: string[], feil: string[] }}
 */
function godkjenn(ko, ider, naa = new Date().toISOString()) {
  const godkjent = [];
  const feil = [];
  for (const id of ider) {
    const o = (ko.oppgaver ?? []).find((x) => x.id === id);
    if (!o) feil.push(`ukjent oppgave ${id}`);
    else if (o.status !== 'forslag') feil.push(`${id} er ikke et forslag (status ${o.status})`);
    else {
      o.status = 'venter';
      o.godkjent = naa;
      godkjent.push(id);
    }
  }
  return { godkjent, feil };
}

// ---- Eierspørsmål og avklaringer -------------------------------------------------------------------
//
// `sporsmal`: { "<id>": { type, tekst, anbefaling?, kilde?, lagt_til } } er teksten bak id-ene i `venter_paa`, så
// tavla kan vise hva eieren skal svare på. `avklaringer`: { "<id>": { tid, svar, av, logget? } } er svaret med
// tidsstempel; id-en står fortsatt i `avklart` (den lista er det hindringene leser). Begge feltene er valgfrie: en
// gammel ko.json uten dem virker uendret.

/** Typene et eierspørsmål kan ha. `betingelse` besvares med hvordan betingelsen er oppfylt. */
const SPORSMAL_TYPER = ['sporsmal', 'betingelse', 'jurist', 'eier-oppgave'];
const SPORSMAL_FELT = new Set(['type', 'tekst', 'anbefaling', 'kilde', 'lagt_til']);
const SPORSMAL_MAKS_TEKST = 4000;

/** Gyldig id for et eierspørsmål: ikke tom, høyst 300 tegn, uten kontrolltegn, mellomrom i endene eller «-» først. */
function gyldigSporsmalId(id) {
  const s = typeof id === 'string' ? id : '';
  return (
    s.length > 0 &&
    s.length <= 300 &&
    s.trim() === s &&
    !s.startsWith('-') &&
    !/[\u0000-\u001f\u007f]/.test(s)
  );
}

/**
 * Setter eller oppdaterer eierspørsmål (`ko.mjs sporsmal`, `sporsmal --fil`, `add` med `{ oppgaver, sporsmal }`).
 * Alt eller ingenting: er ett spørsmål ugyldig, endres ingenting. Et felt som ikke er med, beholdes fra før; `null`
 * fjerner anbefaling eller kilde. `lagt_til` settes av verktøyet (første gang spørsmålet registreres).
 * @param {object} ko køen (endres når feillista er tom)
 * @param {Record<string, { type?: string, tekst?: string, anbefaling?: string|null, kilde?: string|null }>} inn
 * @returns {{ satt: string[], feil: string[] }}
 */
function settSporsmal(ko, inn, naa = new Date().toISOString()) {
  if (!inn || typeof inn !== 'object' || Array.isArray(inn))
    return { satt: [], feil: ['sporsmal må være et objekt: { "<id>": { type, tekst, … } }'] };
  const feil = [];
  const nye = {};
  for (const [id, s] of Object.entries(inn)) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      feil.push(`${id}: må være et objekt { type, tekst, anbefaling?, kilde? }`);
      continue;
    }
    const f = [];
    // Et NYTT spørsmål må ha en stram id (SPORSMAL_ID_MONSTER), så fritekst aldri blir et «spørsmål». Et
    // spørsmål som er registrert fra før, kan fortsatt oppdateres (gyldigSporsmalId).
    if (!gyldigSporsmalId(id) || (!ko.sporsmal?.[id] && !SPORSMAL_ID_MONSTER.test(id)))
      f.push('ugyldig id');
    const ukjente = Object.keys(s).filter((k) => !SPORSMAL_FELT.has(k));
    if (ukjente.length) f.push(`ukjente felt ${ukjente.join(', ')}`);
    const forrige = ko.sporsmal?.[id] ?? {};
    const type = s.type ?? forrige.type ?? 'sporsmal';
    if (!SPORSMAL_TYPER.includes(type)) f.push(`type må være ${SPORSMAL_TYPER.join(', ')}`);
    const tekst = s.tekst ?? forrige.tekst;
    if (typeof tekst !== 'string' || !tekst.trim()) f.push('tekst mangler');
    for (const k of ['tekst', 'anbefaling', 'kilde']) {
      const v = s[k];
      if (v != null && (typeof v !== 'string' || v.length > SPORSMAL_MAKS_TEKST))
        f.push(`${k} må være tekst (høyst ${SPORSMAL_MAKS_TEKST} tegn)`);
    }
    if (f.length) {
      feil.push(`${id}: ${f.join('; ')}`);
      continue;
    }
    const ny = { type, tekst: tekst.trim() };
    for (const k of ['anbefaling', 'kilde']) {
      const v = s[k] !== undefined ? s[k] : forrige[k];
      if (typeof v === 'string' && v.trim()) ny[k] = v.trim();
    }
    ny.lagt_til = forrige.lagt_til ?? naa;
    nye[id] = ny;
  }
  if (feil.length) return { satt: [], feil };
  ko.sporsmal = { ...(ko.sporsmal ?? {}), ...nye };
  return { satt: Object.keys(nye), feil: [] };
}

/**
 * `ko.mjs avklar <id…> [--svar "…"] [--av "…"]`: id-ene legges i `avklart` (som før) og i `avklaringer` med tid, svar
 * og hvem. Uten svar beholdes en tidligere avklaring uendret (tid og svar går aldri tapt); et nytt svar erstatter den
 * og må føres i beslutningsloggen på nytt (`logget: false`). Et tomt svar (`--svar ""`) avvises: da stopper alt.
 * @returns {{ avklart: string[], feil: string[] }}
 */
function avklar(ko, ider, { svar = null, av = null, naa = new Date().toISOString() } = {}) {
  const liste = [...new Set(ider ?? [])];
  const feil = liste
    .filter((id) => !gyldigSporsmalId(id))
    .map((id) => `ugyldig spørsmål-id ${JSON.stringify(id)}`);
  if (!liste.length) feil.push('avklar krever minst én spørsmål-id');
  const s = svar == null ? null : String(svar).trim();
  if (svar != null && !s)
    feil.push('svaret er tomt: skriv svaret, eller hvordan betingelsen er oppfylt');
  if (feil.length) return { avklart: [], feil };
  ko.avklart = [...new Set([...(ko.avklart ?? []), ...liste])];
  const avklaringer = { ...(ko.avklaringer ?? {}) };
  for (const id of liste) {
    if (avklaringer[id] && s == null) continue;
    avklaringer[id] = { tid: naa, svar: s, av: av ? String(av).trim() || null : null };
    if (s != null) avklaringer[id].logget = false;
  }
  ko.avklaringer = avklaringer;
  return { avklart: liste, feil: [] };
}

/** Avklaringer med svar som ikke er ført i beslutningsloggen ennå (orkestratoren fører dem og kjører --merk-logget). */
function ulogget(ko) {
  return Object.entries(ko.avklaringer ?? {})
    .filter(([, a]) => a && a.svar != null && a.logget !== true)
    .map(([sp, a]) => ({ sp, ...a }))
    .sort((x, y) => String(x.tid).localeCompare(String(y.tid)) || x.sp.localeCompare(y.sp));
}

/**
 * `ko.mjs avklaringer --merk-logget <id…>`: svarene er ført i beslutningsloggen. Alt eller ingenting (ukjent id eller
 * en avklaring uten svar gir feil).
 * @returns {{ merket: string[], feil: string[] }}
 */
function merkLogget(ko, ider) {
  const liste = [...new Set(ider ?? [])];
  const feil = [];
  if (!liste.length) feil.push('--merk-logget krever minst én spørsmål-id');
  for (const id of liste) {
    const a = ko.avklaringer?.[id];
    if (!a) feil.push(`${id} er ikke avklart med tidsstempel (ko.mjs avklar ${id} --svar "…")`);
    else if (a.svar == null) feil.push(`${id} har ikke noe svar å føre`);
  }
  if (feil.length) return { merket: [], feil };
  ko.avklaringer = { ...ko.avklaringer };
  for (const id of liste) ko.avklaringer[id] = { ...ko.avklaringer[id], logget: true };
  return { merket: liste, feil: [] };
}

/**
 * Oversikten til `ko.mjs sporsmal`: hvert spørsmål som er registrert eller som en oppgave venter på, med teksten (eller
 * null når den mangler), om det er avklart, og hvor mange ventende oppgaver som venter direkte på det. Åpne først
 * (flest ventende først), så avklarte.
 */
function sporsmalOversikt(ko) {
  const avklart = new Set(ko.avklart ?? []);
  const venter = new Map();
  for (const o of ko.oppgaver ?? []) {
    if (o.status !== 'venter' && o.status !== 'forslag') continue;
    for (const sp of o.venter_paa ?? []) {
      if (!venter.has(sp)) venter.set(sp, []);
      if (o.status === 'venter') venter.get(sp).push(o.id);
    }
  }
  const ider = new Set([...Object.keys(ko.sporsmal ?? {}), ...venter.keys()]);
  return [...ider]
    .map((sp) => {
      const q = ko.sporsmal?.[sp];
      return {
        sp,
        type: q?.type ?? 'sporsmal',
        tekst: q?.tekst ?? null,
        anbefaling: q?.anbefaling ?? null,
        kilde: q?.kilde ?? null,
        avklart: avklart.has(sp),
        svar: ko.avklaringer?.[sp]?.svar ?? null,
        oppgaver: venter.get(sp) ?? [],
      };
    })
    .sort(
      (x, y) =>
        Number(x.avklart) - Number(y.avklart) ||
        y.oppgaver.length - x.oppgaver.length ||
        x.sp.localeCompare(y.sp),
    );
}

/** Id-ene en oppgave venter på som ikke har tekst i `sporsmal` (add advarer om dem). */
function sporsmalUtenTekst(oppgaver, ko) {
  const ut = new Set();
  for (const o of oppgaver)
    for (const sp of o.venter_paa ?? []) if (!ko.sporsmal?.[sp]?.tekst) ut.add(sp);
  return [...ut];
}

// ---- Eiersvar kan ikke gå tapt -----------------------------------------------
//
// En oppgave stod blokkert selv om eieren hadde svart to ganger: `venter_paa` hadde fritekst i stedet for en registrert
// spørsmåls-id, så spørsmålet fantes ikke i `sporsmal`, ble aldri vist i «Venter på deg», og `avklar` kunne ikke treffe
// det. Tre tiltak: (1) add og endre avviser en ny venter_paa-id som ikke er registrert (venterPaaFeil), (2) fyll, vis og
// tilstand lister løse ventinger (loseVentinger), (3) avklar med svar skriver svaret inn i oppdraget (eiersvarTillegg).

/** Stram id for et eierspørsmål: bokstaver (også æøå), tall, «.», «_» og «-», høyst 40 tegn, uten mellomrom. */
const SPORSMAL_ID_MONSTER = /^[A-Za-z0-9ÆØÅæøå][A-Za-z0-9ÆØÅæøå._-]{0,39}$/;

/** Er spørsmålet registrert slik at eieren kan svare på det (tekst og type i `sporsmal`)? */
function sporsmalRegistrert(ko, sp) {
  const q = Object.hasOwn(ko?.sporsmal ?? {}, sp) ? ko.sporsmal[sp] : null;
  return !!(q && typeof q.tekst === 'string' && q.tekst.trim() && q.type);
}

/**
 * Feilene for `venter_paa` på en oppgave (add og endre; alt eller ingenting i kalleren). Hver id som ikke står i
 * `tidligere` (oppgavens venter_paa før endringen), må matche SPORSMAL_ID_MONSTER og være registrert i `ko.sporsmal`
 * med tekst og type. `ko.sporsmal` skal allerede inneholde spørsmålene som registreres i samme kall (add-formen
 * { oppgaver, sporsmal }). Ventinger som stod der fra før, avvises ikke (de vises som løse ventinger i stedet).
 * @returns {string[]}
 */
function venterPaaFeil(o, ko, { tidligere = [] } = {}) {
  const liste = o?.venter_paa;
  if (liste == null || !Array.isArray(liste)) return [];
  const fra = new Set(tidligere ?? []);
  const feil = [];
  for (const sp of liste) {
    if (fra.has(sp)) continue;
    if (typeof sp !== 'string' || !SPORSMAL_ID_MONSTER.test(sp))
      feil.push(
        `venter_paa ${JSON.stringify(sp)} er ikke en spørsmål-id (bokstaver, tall, «.», «_», «-», høyst 40 tegn, ` +
          'ingen mellomrom). Registrer spørsmålet med en id og tekst, og vent på id-en',
      );
    else if (!sporsmalRegistrert(ko, sp))
      feil.push(
        `venter_paa ${sp} er ikke registrert med tekst og type: legg det i "sporsmal" i add-fila, eller først ` +
          `ko.mjs sporsmal ${sp} --tekst "…" --type <${SPORSMAL_TYPER.join('|')}>`,
      );
  }
  return feil;
}

/**
 * Løse ventinger: oppgaver (venter eller forslag) som venter på noe eieren ikke kan svare på, eller som blokkeres av
 * et spørsmål som er besvart. `grunn`: `fritekst` (id-en matcher ikke SPORSMAL_ID_MONSTER), `uregistrert` (ingen
 * tekst og type i `sporsmal`), eller `avklart-blokkerer` (svaret står i `avklaringer`, men id-en mangler i `avklart`,
 * som er det hindringene leser; skal ikke kunne skje). Et avklart spørsmål uten tekst blokkerer ikke og er ikke med.
 * @returns {{ id: string, status: string, sp: string, grunn: string }[]}
 */
function loseVentinger(ko) {
  const avklart = new Set(ko?.avklart ?? []);
  const ut = [];
  for (const o of ko?.oppgaver ?? []) {
    if (o.status !== 'venter' && o.status !== 'forslag') continue;
    for (const sp of Array.isArray(o.venter_paa) ? o.venter_paa : []) {
      if (avklart.has(sp)) continue;
      let grunn = null;
      if (Object.hasOwn(ko.avklaringer ?? {}, sp)) grunn = 'avklart-blokkerer';
      else if (typeof sp !== 'string' || !SPORSMAL_ID_MONSTER.test(sp)) grunn = 'fritekst';
      else if (!sporsmalRegistrert(ko, sp)) grunn = 'uregistrert';
      if (grunn) ut.push({ id: o.id, status: o.status, sp: String(sp), grunn });
    }
  }
  return ut;
}

/**
 * VARSEL-linjene for løse ventinger (fyll, vis). Tom liste når det ikke er noen. `maks` begrenser detaljlinjene.
 * @param {{ id: string, status: string, sp: string, grunn: string }[]} liste loseVentinger(ko)
 */
function loseVentingerLinjer(liste, { maks = 10 } = {}) {
  if (!liste?.length) return [];
  const hva = {
    fritekst: 'fritekst, ikke en spørsmål-id: registrer et spørsmål og bytt til id-en',
    uregistrert: 'uregistrert: ko.mjs sporsmal <id> --tekst "…" --type <type>',
    'avklart-blokkerer': 'besvart, men står ikke i avklart: ko.mjs avklar <id> på nytt',
  };
  const oppg = new Set(liste.map((x) => x.id));
  return [
    `VARSEL: ${liste.length} løs(e) venting(er) i ${oppg.size} oppgave(r) (eieren ser dem ikke i «Venter på deg», ` +
      'eller et svar blokkerer likevel):',
    ...liste
      .slice(0, maks)
      .map(
        (x) =>
          `  ${x.id} (${x.status}) venter på «${kuttTekst(x.sp, 70)}»: ${hva[x.grunn] ?? x.grunn}`,
      ),
    ...(liste.length > maks
      ? [`  +${liste.length - maks} til (ko.mjs tilstand, feltet loseVentinger)`]
      : []),
  ];
}

/**
 * Avklar med svar skriver svaret inn i oppdraget: et tillegg «EIERSVAR <sp> (<dato>): <svar>» på hver oppgave som
 * venter på spørsmålet og ikke er ferdig, kansellert eller ekstern (samme mekanisme som `ko.mjs endre --tillegg`, så
 * sporblokka og prompten får beslutningen). Idempotent: står samme svar for samme spørsmål der fra før, legges det
 * ikke til igjen. Uten svar skjer ingenting. Muterer køen.
 * @returns {{ id: string, sp: string }[]} tilleggene som ble lagt til
 */
function eiersvarTillegg(ko, ider, svar, naa = new Date().toISOString()) {
  const s = svar == null ? '' : String(svar).trim();
  if (!s) return [];
  const dato = String(naa).slice(0, 10);
  const lagt = [];
  for (const sp of [...new Set(ider ?? [])]) {
    for (const o of ko?.oppgaver ?? []) {
      if (['ferdig', 'kansellert', 'ekstern'].includes(o.status)) continue;
      if (!(o.venter_paa ?? []).includes(sp)) continue;
      const fraFor = (Array.isArray(o.tillegg) ? o.tillegg : []).some(
        (t) =>
          typeof t?.tekst === 'string' &&
          t.tekst.startsWith(`EIERSVAR ${sp} (`) &&
          t.tekst.endsWith(`): ${s}`),
      );
      if (fraFor) continue;
      if (!leggTilTillegg(o, `EIERSVAR ${sp} (${dato}): ${s}`, naa)) lagt.push({ id: o.id, sp });
    }
  }
  return lagt;
}

/** «2026-10-01 14:02 UTC» fra en ISO-tid (til sporfila; tiden lagres alltid i UTC). */
const utcTekst = (iso) =>
  typeof iso === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(iso)
    ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
    : '?';

/**
 * Blokka i sporfila med eierens svar på det oppgaven ventet på (`venter_paa` som er avklart), så sporet ser
 * beslutningen og ikke bygger uten den. null når oppgaven ikke ventet på noe avklart.
 */
function svarBlokk(o, ko) {
  const avklart = new Set(ko.avklart ?? []);
  const sp = (o.venter_paa ?? []).filter((x) => avklart.has(x));
  if (!sp.length) return null;
  const linjer = sp.map((id) => {
    const q = ko.sporsmal?.[id];
    const a = ko.avklaringer?.[id];
    const hva = q?.tekst ? ` (${q.type ?? 'sporsmal'}): «${q.tekst}»` : '';
    if (a?.svar == null)
      return `- ${id}${hva} Avklart${a?.tid ? ` ${utcTekst(a.tid)}` : ''}, men svaret står ikke i køen: se beslutningsloggen.`;
    const ord = q?.type === 'betingelse' || q?.type === 'jurist' ? 'Oppfylt' : 'Svar';
    return `- ${id}${hva} ${ord}: «${a.svar}» (${a.av ?? '?'}, ${utcTekst(a.tid)}).`;
  });
  return [
    '**Eierens svar på det oppgaven ventet på** (bindende; fra `ko.mjs avklar`, føres i beslutningsloggen av orkestratoren):',
    ...linjer,
  ].join('\n');
}

// ---- Migrasjonsblokk som tekst (felles for start og plukk) ------------------------------------------------------

/** «3450–3459» fra { fra, til }, eller null når oppgaven ikke har migrasjoner. */
function migrBlokkTekst(b) {
  if (b?.fra == null) return null;
  return `${b.fra}–${b.til}`;
}

// ---- Plukking ---------------------------------------------------------------------------------------

/**
 * Oppgaver som kan plukkes nå: status venter, ingen åpne avhengigheter eller eierspørsmål, og ingen eierkollisjon
 * med kjorer/review/plukket. Sortert etter prioritet (med prosjektets tillegg). Pause stopper bare køen; en
 * oppgave i et pauset prosjekt kan fortsatt plukkes, og raden sier `pauset: true`.
 * @param {{ etikett?: string, prosjekt?: string, maksMin?: number, ucommittet?: string[] }} filter
 *   `ucommittet`: stiene fra `git status` i hovedtreet. En oppgave som eier en av dem, står fortsatt på lista
 *   (plukking er et manuelt valg), men raden sier `ucommittet: <sti>` så den som plukker ser det.
 */
function plukkbare(ko, { etikett, prosjekt, maksMin, ucommittet = [] } = {}, naa = Date.now()) {
  const oppgaver = ko.oppgaver ?? [];
  const register = ko.prosjekter ?? {};
  // Felles rangering. Parkerte hoppes over; utenfor fokus står fortsatt på lista (plukking er et manuelt
  // valg, som for et pauset prosjekt), men sist og med `utenfor_fokus: true`.
  const k = rangeringKontekst(ko, naa);
  return oppgaver
    .filter((o) => o.status === 'venter' && hindringer(o, oppgaver, ko.avklart).length === 0)
    .filter((o) => !etikett || harEtikett(o, etikett))
    .filter((o) => !prosjekt || prosjektFor(o, register) === prosjekt)
    .filter((o) => maksMin == null || anslag(o) <= maksMin)
    .map((o) => ({ o, r: rangering(o, ko, k) }))
    .filter(({ r }) => !r.parkert)
    .sort(sammenlignRangering)
    .map(({ o, r }) => ({
      id: o.id,
      tittel: o.tittel,
      klasse: o.klasse,
      domene: o.domene,
      anslag: anslag(o),
      score: r.score,
      prosjekt: prosjektFor(o, register),
      funksjon: o.funksjon ?? null,
      etiketter: o.etiketter ?? [],
      migr: Number(o.migr_tiere ?? 0) > 0,
      pauset: r.pauset,
      ucommittet: ucommittetKollisjon(o, ucommittet)?.sti ?? null,
      ...(k.gjelder ? { steg: r.steg, dratt_av: r.dratt_av, utenfor_fokus: r.utenfor } : {}),
    }));
}

/**
 * Plukker en oppgave: venter → plukket, med køgren (`<grenPrefiks><id>`) og migrasjonsblokk som ved `start`. Nekter ved åpne
 * avhengigheter, eierspørsmål eller eierkollisjon med kjorer/review/plukket; `tving` (eierens ord) overstyrer de
 * tre, aldri statusen (et forslag må godkjennes først, og noe som kjører kan ikke plukkes). En migrasjonsblokk
 * oppgaven allerede har (f.eks. etter `slipp`), gjenbrukes, så numrene på en beholdt gren fortsatt er dens egne.
 * Endrer `ko` (kalleren skriver fila under lås).
 * @returns {{ feil: string, hindringer?: string[] } | { oppgave: object, overstyrt: string[] }}
 */
function plukk(
  ko,
  id,
  { av, tving = false, naa = new Date().toISOString(), migrasjoner = kfg().migrasjoner } = {},
) {
  const o = (ko.oppgaver ?? []).find((x) => x.id === id);
  if (!o) return { feil: `ukjent oppgave ${id}` };
  const hvem = String(av ?? '').trim();
  if (!hvem) return { feil: 'plukk krever --av "<hvem>" (personen eller økta som gjør oppgaven)' };
  if (o.status !== 'venter') {
    const hvorfor =
      o.status === 'plukket'
        ? `allerede plukket av ${o.plukket_av ?? '?'}`
        : o.status === 'forslag'
          ? `et forslag (godkjenn først: ko.mjs godkjenn ${id})`
          : `status ${o.status}`;
    return { feil: `${id} kan ikke plukkes: ${hvorfor}` };
  }
  // Samlekøen overstyres ikke med --tving; den tas ut med endre (samles:false) eller pakkes.
  if (erSamles(o))
    return { feil: `${id} kan ikke plukkes: ${SAMLES_HINDRING}`, hindringer: [SAMLES_HINDRING] };
  const h = hindringer(o, ko.oppgaver, ko.avklart);
  // En parkert oppgave plukkes ikke uten --tving (fokus og pause stopper ikke plukking, som før).
  if (parkertNaa(o, Date.parse(naa))) h.unshift(parkertTekst(o));
  if (h.length && !tving)
    return {
      feil: `${id} kan ikke plukkes: ${h.join(' · ')} (--tving overstyrer, bare på eierens ord)`,
      hindringer: h,
    };
  const tiere = migrTiere(o, migrasjoner);
  let blokk = null;
  if (tiere > 0) {
    if (o.migr_blokk) blokk = o.migr_blokk;
    else {
      if (!Number.isFinite(Number(ko.neste_migr)))
        return { feil: 'køen mangler neste_migr; kan ikke tildele migrasjonsblokk' };
      const b = tildelMigrBlokk(Number(ko.neste_migr), tiere, migrasjoner?.blokkStorrelse);
      ko.neste_migr = b.nesteLedig;
      blokk = migrBlokkTekst(b);
    }
  }
  o.status = 'plukket';
  o.plukket_av = hvem;
  o.plukket_at = naa;
  o.gren = koGren(id);
  o.migr_blokk = blokk;
  if (tving && h.length)
    o.merknader = [...(o.merknader ?? []), `${naa} plukket med --tving forbi: ${h.join(' · ')}`];
  return { oppgave: o, overstyrt: tving ? h : [] };
}

/** Leverer en plukket oppgave til review (plukket → review). `plukket_av` blir stående (historikk, og tar ingen agentplass). */
function lever(ko, id, naa = new Date().toISOString()) {
  const o = (ko.oppgaver ?? []).find((x) => x.id === id);
  if (!o) return { feil: `ukjent oppgave ${id}` };
  if (o.status !== 'plukket') return { feil: `${id} er ikke plukket (status ${o.status})` };
  o.status = 'review';
  if (!o.levert) o.levert = naa;
  return { oppgave: o };
}

/**
 * Slipper en plukket oppgave (plukket → venter) og fjerner plukk-feltene. Køgrenen og migrasjonsblokken beholdes.
 * `commits` (foran basegrenen på køgrenen, talt av kalleren) gir en advarsel og en merknad på oppgaven.
 */
function slipp(ko, id, { commits = 0, naa = new Date().toISOString() } = {}) {
  const o = (ko.oppgaver ?? []).find((x) => x.id === id);
  if (!o) return { feil: `ukjent oppgave ${id}` };
  if (o.status !== 'plukket') return { feil: `${id} er ikke plukket (status ${o.status})` };
  const av = o.plukket_av;
  o.status = 'venter';
  delete o.plukket_av;
  delete o.plukket_at;
  delete o.sky; // en sluppet skyøkt er avsluttet
  let advarsel = null;
  if (commits > 0) {
    const gren = o.gren ?? koGren(id);
    advarsel =
      `${gren} har ${commits} commit(s) som ikke er på ${baseGren()}. Grenen beholdes. NB: når køen starter ` +
      `oppgaven på nytt, lager klargjor-spor grenen fra ${baseGren()} (checkout -B) og commitene faller ut av den; ta vare på dem ` +
      `først (git branch ${gren}-sluppet ${gren}) eller plukk oppgaven igjen og bygg videre.`;
    o.merknader = [
      ...(o.merknader ?? []),
      `${naa} sluppet av ${av ?? '?'}; ${gren} hadde ${commits} commit(s) foran ${baseGren()}`,
    ];
  }
  return { oppgave: o, av, advarsel };
}

/**
 * Er en plukket oppgave «gammel»? Plukket for over 72 t siden og uten commits de siste 72 t (ingen commits på
 * køgrenen, eller siste commit eldre enn 72 t). Bare en markering: den slippes aldri automatisk.
 * @param {{ commits?: number, sisteCommit?: string|null }} git commits foran basegrenen og tidspunktet for siste
 */
function erGammelPlukk(o, { commits = 0, sisteCommit = null } = {}, naa = Date.now()) {
  if (o?.status !== 'plukket' || !o.plukket_at) return false;
  if (!(naa - Date.parse(o.plukket_at) > GAMMEL_PLUKK_MS)) return false;
  if (!commits) return true;
  const siste = sisteCommit ? Date.parse(sisteCommit) : NaN;
  return Number.isFinite(siste) && naa - siste > GAMMEL_PLUKK_MS;
}

/** «14 min», «3 t 12 min», «4 d» fra millisekunder («?» når ukjent). */
function alderTekst(ms) {
  if (ms == null || Number.isNaN(ms)) return '?';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const t = Math.floor(min / 60);
  return t < 48 ? `${t} t ${min % 60} min` : `${Math.floor(t / 24)} d`;
}

// ---- Status og visuell QA ---------------------------------------------------------------------------

/**
 * Setter status med sideeffektene (`ko.mjs sett`): levert ved review, ferdig-tid, og `qa_status: "venter"` når en
 * oppgave med etiketten `visuell` blir ferdig (fra en annen status). `plukket` settes bare med `plukk` (gren og
 * migrasjonsblokk). Går en plukket oppgave tilbake til venter/forslag, fjernes plukk-feltene (som `slipp`).
 * @returns {{ feil: string } | { oppgave: object, qa: boolean }}
 */
function settStatus(o, status, naa = new Date().toISOString()) {
  if (!STATUSER.has(status)) return { feil: `ukjent status ${status}` };
  if (status === 'plukket')
    return {
      feil: 'status plukket settes med ko.mjs plukk <id> --av "<hvem>" (tildeler gren og migrasjonsblokk)',
    };
  // Status ekstern hører bare til registreringer utenfor køen, og en slik registrering blir aldri en oppgave
  // som køen kan starte (sett venter ville gjort den til det).
  if (status === 'ekstern')
    return {
      feil: 'status ekstern settes med ko.mjs ekstern add --navn "<økt>" --filer <…> (registrering utenfor køen)',
    };
  if (erEksternRad(o) && status !== 'ferdig' && status !== 'kansellert')
    return {
      feil: `${o.id} er en registrering utenfor køen; den kan bare avsluttes (ko.mjs ekstern ferdig "${o.ekstern_navn ?? o.id}")`,
    };
  const fra = o.status;
  if (status === 'review' && !o.levert) o.levert = naa;
  let qa = false;
  if (status === 'ferdig') {
    o.ferdig = naa;
    if (fra !== 'ferdig' && harEtikett(o, ETIKETT_VISUELL)) {
      o.qa_status = 'venter';
      qa = true;
    }
  }
  if (fra === 'plukket' && (status === 'venter' || status === 'forslag')) {
    delete o.plukket_av;
    delete o.plukket_at;
    delete o.sky;
  }
  o.status = status;
  return { oppgave: o, qa };
}

/** QA-lista: ferdige oppgaver med `qa_status: "venter"`, gruppert prosjekt → funksjon (grupper). */
function qaListe(ko) {
  const i = (ko.oppgaver ?? []).filter((o) => o.status === 'ferdig' && o.qa_status === 'venter');
  return grupper(i, ko.prosjekter ?? {});
}

/**
 * Eieren har sett på oppgavene og godkjenner dem: qa_status → ok. Gjelder ferdige oppgaver som venter på QA eller
 * har et avvik (sjekket på nytt etter rettingen). Alt eller ingenting, som `godkjenn`.
 * @returns {{ ok: string[], feil: string[] }}
 */
function qaOk(ko, ider, naa = new Date().toISOString()) {
  const feil = [];
  const funnet = [];
  for (const id of ider) {
    const o = (ko.oppgaver ?? []).find((x) => x.id === id);
    if (!o) feil.push(`ukjent oppgave ${id}`);
    else if (o.status !== 'ferdig') feil.push(`${id} er ikke ferdig (status ${o.status})`);
    else if (o.qa_status !== 'venter' && o.qa_status !== 'avvik')
      feil.push(`${id} står ikke i QA-lista (qa_status ${o.qa_status ?? 'ingen'})`);
    else funnet.push(o);
  }
  if (feil.length) return { ok: [], feil };
  for (const o of funnet) {
    o.qa_status = 'ok';
    o.qa_ok = naa;
  }
  return { ok: funnet.map((o) => o.id), feil: [] };
}

/**
 * Eieren fant et avvik: qa_status → avvik, `qa_notat` = teksten, og en rettingsoppgave `<id>-QA<n>` legges til
 * (K, samme prosjekt og funksjon, etiketten visuell, originalens filer, oppdrag = teksten + lenke til originalen,
 * lagt_til_av «eier», status venter). Avvik på en rettingsoppgave nummererer videre fra originalen (X-QA1 → X-QA2).
 * @returns {{ feil: string } | { oppgave: object, retting: object }}
 */
function qaAvvik(ko, id, tekst, naa = new Date().toISOString()) {
  const oppgaver = ko.oppgaver ?? [];
  const o = oppgaver.find((x) => x.id === id);
  if (!o) return { feil: `ukjent oppgave ${id}` };
  if (o.status !== 'ferdig')
    return { feil: `${id} er ikke ferdig (status ${o.status}); QA gjelder ferdige oppgaver` };
  const t = String(tekst ?? '').trim();
  if (!t) return { feil: 'qa avvik krever en tekst: hva er galt, og hvor' };
  const rot = typeof o.qa_original === 'string' && o.qa_original ? o.qa_original : id;
  const monster = new RegExp(`^${rot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-QA(\\d+)$`);
  const n =
    1 +
    oppgaver.reduce((m, x) => {
      const treff = monster.exec(x.id);
      return treff ? Math.max(m, Number(treff[1])) : m;
    }, 0);
  const register = ko.prosjekter ?? {};
  const pid = prosjektFor(o, register);
  const kort = t.length > 90 ? `${t.slice(0, 87)}...` : t;
  const erSti = typeof o.oppdrag === 'string' && !/\n/.test(o.oppdrag) && /\.md$/i.test(o.oppdrag);
  const lenke = erSti
    ? `oppdraget: ${o.oppdrag}`
    : `oppdraget står på ${o.id} i køen (ko.mjs vis --alle)`;
  const retting = {
    id: `${rot}-QA${n}`,
    tittel: `QA-retting av ${o.id}: ${kort}`,
    domene: o.domene,
    klasse: 'K',
    ...(pid !== UTEN_PROSJEKT ? { prosjekt: pid } : {}),
    ...(typeof o.funksjon === 'string' && o.funksjon ? { funksjon: o.funksjon } : {}),
    etiketter: [ETIKETT_VISUELL],
    oppdrag:
      `Eieren fant et avvik i visuell QA av ${o.id} («${o.tittel}»):\n\n${t}\n\n` +
      `Originalen: ${o.id}, ${lenke}. Rett avviket og behold resten av originalens oppførsel.`,
    nytte: Number(o.nytte ?? 5),
    innhold_min: 20,
    migr_tiere: 0,
    avhenger: [],
    venter_paa: [],
    eier_filer: [...(o.eier_filer ?? [])],
    eier_db: [],
    delt_patch: [],
    kilde: `qa avvik ${o.id}`,
    lagt_til_av: 'eier',
    qa_original: rot,
  };
  // Uten register: prosjektet er arvet fra originalen, ikke skrevet inn på nytt (det kan være et eldre, eksplisitt
  // prosjekt som ikke står i registeret).
  const f = valider(retting, oppgaver);
  if (f.length) return { feil: `rettingsoppgaven ${retting.id} er ugyldig: ${f.join('; ')}` };
  retting.status = statusVedAdd(retting, oppgaver);
  retting.lagt_til = naa;
  o.qa_status = 'avvik';
  o.qa_notat = t;
  o.merknader = [...(o.merknader ?? []), `${naa} QA-avvik, retting ${retting.id}`];
  oppgaver.push(retting);
  return { oppgave: o, retting };
}

// ---- Arbeid utenfor køen ----------------------------------------------------------------------------
//
// Andre økter committer rett på basegrenen, lager grener (hotfix/*) og har ucommittede filer i hovedtreet. Køen skal
// vite om det: den starter ikke et spor som kolliderer, og den bygger ikke noe som alt er gjort. Git-lesingen står i
// koGit.js; her er bare beslutningene.

/** Traileren orkestratoren setter på sine egne commits på basegrenen: `git commit --trailer "Ko: orkestrator" …`. */
const ORKESTRATOR_TRAILER = 'Ko: orkestrator';
const ORKESTRATOR_TRAILER_MONSTER = /^Ko:[ \t]*orkestrator[ \t]*$/im;
/** Orkestrator-markøren (scripts/.ko/orkestrator.json) regnes som utløpt etter så lang tid uten oppdatering. */
const ORKESTRATOR_UTLOP_MS = 2 * 3_600_000;
/** Oppgavene som sammenlignes med endringer utenfor køen (kollisjoner), i visningsrekkefølge. */
const KOLLISJON_STATUSER = ['kjorer', 'plukket', 'review', 'venter'];

/** Er raden en registrering av arbeid utenfor køen (`ko.mjs ekstern add`), ikke en oppgave? */
function erEksternRad(o) {
  return o?.ekstern === true;
}

/** Har commit-meldingen traileren «Ko: orkestrator» (på en egen linje)? */
function harOrkestratorTrailer(melding) {
  return ORKESTRATOR_TRAILER_MONSTER.test(String(melding ?? ''));
}

/**
 * Oppgave-id-en fra flett-spor-meldingen «Merge branch '<grenPrefiks><id>' into <basegren>», ellers null.
 * @param {string} emne
 * @param {string} [prefiks] standard konfig().grenPrefiks
 */
function koIdFraFlett(emne, prefiks = grenPrefiks()) {
  const m = new RegExp(`^Merge branch '${regexTrygg(prefiks)}([^']+)'`).exec(String(emne ?? ''));
  return m ? m[1] : null;
}

/**
 * Hvor kommer en commit på basegrenens første-forelder-linje fra? `ko` = flett av en køgren (flett-spor.mjs, også en
 * plukket oppgave som den som plukket flettet selv), `orkestrator` = traileren «Ko: orkestrator», ellers `ekstern`.
 * En flett av en annen gren (hotfix/*, <remote>/<basegren>) er ekstern; koGit.js ser i tillegg på commitene den tar med.
 * @param {{ foreldre?: string[], emne?: string, melding?: string }} c
 * @returns {{ kilde: 'ko'|'orkestrator'|'ekstern', ko_id?: string }}
 */
function klassifiserCommit(c) {
  if ((c?.foreldre?.length ?? 0) >= 2) {
    const id = koIdFraFlett(c.emne);
    if (id) return { kilde: 'ko', ko_id: id };
  }
  if (harOrkestratorTrailer(c?.melding)) return { kilde: 'orkestrator' };
  return { kilde: 'ekstern' };
}

const regexTrygg = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Oppgave-id-ene som står i teksten som egne ord: «(A-T8c)», «A-T8c:», «A-T8c.» og «A-T8c» mot slutten treffer;
 * «A-T8c2», «A-T8c-QA1» og «XA-T8c» gjør det ikke (da er det en annen id).
 */
function nevnteIder(tekst, ider) {
  const t = String(tekst ?? '');
  const ut = [];
  for (const id of ider ?? []) {
    if (!id || !t.includes(id)) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9_.-])${regexTrygg(id)}(?![A-Za-z0-9_-])`);
    if (re.test(t)) ut.push(id);
  }
  return ut;
}

/**
 * Samsvar: eksterne commits som nevner en oppgave i køen. For en ventende oppgave er forslaget
 * `ko.mjs ekstern godta <id> <sha>` (den kan være gjort utenfor køen); det gjøres aldri automatisk.
 * @param {{ sha: string, kort?: string, emne?: string, melding?: string, side?: { melding?: string }[] }[]} eksterne
 * @returns {{ sha: string, kort: string, emne: string, id: string, status: string, forslag: string|null }[]}
 */
function samsvar(eksterne, oppgaver) {
  const perId = new Map((oppgaver ?? []).filter((o) => !erEksternRad(o)).map((o) => [o.id, o]));
  const ider = [...perId.keys()];
  const ut = [];
  for (const c of eksterne ?? []) {
    const kort = c.kort ?? String(c.sha).slice(0, 8);
    // Emnet, meldingen og meldingene til commitene en ekstern flett tar med.
    const tekst = [c.emne, c.melding, ...(c.side ?? []).map((s) => s.melding)].join('\n');
    for (const id of nevnteIder(tekst, ider)) {
      const o = perId.get(id);
      ut.push({
        sha: c.sha,
        kort,
        emne: c.emne ?? '',
        id,
        status: o.status,
        forslag: o.status === 'venter' ? `ko.mjs ekstern godta ${id} ${kort}` : null,
      });
    }
  }
  return ut;
}

/**
 * Push-sjekken: første-forelder-commitene i <remote>/<basegren>..<basegren>, ELDST FØRST, hver med `kilde`.
 * - `eksterne`: commitene med kilde ekstern (tom = trygt å pushe alt).
 * - `kuttpunkt`: sha-en til siste commit før den første eksterne, når ALLE commitene fra den første eksterne og ut er
 *   eksterne. Køens og orkestratorens del ligger da samlet foran og kan pushes alene med `git push <remote> <sha>:<basegren>`.
 *   null når første commit alt er ekstern (køen har ingenting å pushe alene) eller når de er flettet inn mellom.
 * - `sammenflettet`: en kø- eller orkestrator-commit kommer etter en ekstern. Da kan de eksterne ikke holdes tilbake
 *   uten omskriving av historikken, og det gjøres aldri.
 */
function pushPlan(forsteForeldre) {
  const liste = forsteForeldre ?? [];
  const i = liste.findIndex((c) => c.kilde === 'ekstern');
  const tell = (k) => liste.filter((c) => c.kilde === k).length;
  const felles = { totalt: liste.length, ko: tell('ko'), orkestrator: tell('orkestrator') };
  if (i < 0)
    return {
      ...felles,
      eksterne: [],
      kuttpunkt: null,
      sammenflettet: false,
      egneForKutt: liste.length,
    };
  const sammenflettet = liste.slice(i).some((c) => c.kilde !== 'ekstern');
  return {
    ...felles,
    eksterne: liste.filter((c) => c.kilde === 'ekstern'),
    kuttpunkt: !sammenflettet && i > 0 ? liste[i - 1].sha : null,
    sammenflettet,
    egneForKutt: i,
  };
}

/** Første eierfil i oppgaven som en ucommittet sti i hovedtreet overlapper: { fil (eierfila), sti }, ellers null. */
function ucommittetKollisjon(o, ucommittet) {
  for (const f of o?.eier_filer ?? []) {
    for (const u of ucommittet ?? []) {
      const sti = typeof u === 'string' ? u : u?.sti;
      if (sti && filOverlapp(f, sti)) return { fil: norm(f), sti: norm(sti) };
    }
  }
  return null;
}

/**
 * Oppgavene `neste` hopper over fordi de kolliderer med en ucommittet fil i hovedtreet: de ventende som ellers kunne
 * startes (ingen hindringer, prosjektet ikke pauset). [{ id, fil, sti }].
 */
function ucommittetHoppet(ko, ucommittet) {
  const oppgaver = ko.oppgaver ?? [];
  const rk = rangeringKontekst(ko);
  const ut = [];
  for (const o of oppgaver) {
    // Det velgNeste uansett ikke ville startet (pauset, parkert, utenfor fokus), er ikke «hoppet over».
    if (o.status !== 'venter' || fokusPlass(o, rk).ut) continue;
    const k = ucommittetKollisjon(o, ucommittet);
    if (k && hindringer(o, oppgaver, ko.avklart).length === 0) ut.push({ id: o.id, ...k });
  }
  return ut;
}

/**
 * Kollisjoner mellom arbeid utenfor køen og eierfilene til oppgaver som kjører, er plukket, er i review eller venter.
 * @param {object[]} oppgaver køens oppgaver
 * @param {{ commits?: { sha: string, kort?: string, emne?: string, filer: string[], dato?: string }[],
 *           grener?: { navn: string, filer: string[] }[], ucommittet?: (string|{ sti: string })[] }} kilder
 *   commits = de eksterne, med datoen de landet på basegrenen; en commit teller bare for oppgaver som ble lagt til
 *   FØR den landet. Grener (utenfor køgrenene, ikke flettet) og ucommittede filer teller alltid.
 * @returns {{ id: string, status: string, fil: string, eier: string, kilde: 'commit'|'gren'|'ucommittet',
 *             sha?: string, kort?: string, emne?: string, dato?: string, gren?: string }[]}
 */
function eksternKollisjoner(oppgaver, kilder = {}, { statuser = KOLLISJON_STATUSER } = {}) {
  // Indeks sti → kilder, så hver eierfil slås opp i stedet for å sammenlignes med alle endrede filer.
  const indeks = new Map();
  const leggTil = (sti, kilde) => {
    const s = norm(sti ?? '');
    if (!s) return;
    if (!indeks.has(s)) indeks.set(s, []);
    indeks.get(s).push(kilde);
  };
  for (const c of kilder.commits ?? []) {
    const kort = c.kort ?? String(c.sha).slice(0, 8);
    for (const f of c.filer ?? [])
      leggTil(f, { kilde: 'commit', sha: c.sha, kort, emne: c.emne ?? '', dato: c.dato });
  }
  for (const g of kilder.grener ?? []) {
    for (const f of g.filer ?? []) leggTil(f, { kilde: 'gren', gren: g.navn });
  }
  for (const u of kilder.ucommittet ?? [])
    leggTil(typeof u === 'string' ? u : u?.sti, { kilde: 'ucommittet' });
  // Usporede mapper («?? ny-mappe/») eier alt under seg.
  const mapper = [...indeks.keys()].filter((s) => s.endsWith('/'));

  const rekke = new Map(statuser.map((s, i) => [s, i]));
  const ut = [];
  const sett = new Set();
  for (const o of oppgaver ?? []) {
    if (erEksternRad(o) || !rekke.has(o.status)) continue;
    const lagtTil = o.lagt_til ? Date.parse(o.lagt_til) : NaN;
    const treff = (sti, liste, eier) => {
      for (const k of liste) {
        // En commit som landet før oppgaven ble lagt inn, er allerede med i grunnlaget for oppdraget.
        if (
          k.kilde === 'commit' &&
          Number.isFinite(lagtTil) &&
          k.dato &&
          !(Date.parse(k.dato) > lagtTil)
        )
          continue;
        const nokkel = `${o.id}|${sti}|${k.kilde}|${k.sha ?? k.gren ?? ''}`;
        if (sett.has(nokkel)) continue;
        sett.add(nokkel);
        ut.push({ id: o.id, status: o.status, fil: sti, eier, ...k });
      }
    };
    for (const e of o.eier_filer ?? []) {
      const f = norm(e);
      if (f.endsWith('/')) {
        for (const [sti, liste] of indeks) if (filOverlapp(f, sti)) treff(sti, liste, f);
      } else {
        if (indeks.has(f)) treff(f, indeks.get(f), f);
        for (const m of mapper) if (f.startsWith(m)) treff(m, indeks.get(m), f);
      }
    }
  }
  return ut.sort((x, y) => rekke.get(x.status) - rekke.get(y.status) || x.id.localeCompare(y.id));
}

/** «<id>: fila X ble endret utenfor køen i <sha> «emne»» / «… på grenen <gren>» / «… er ucommittet i hovedtreet». */
function kollisjonTekst(k, { medId = true } = {}) {
  const fil = k.fil === k.eier ? k.fil : `${k.fil} (under ${k.eier})`;
  const hvor =
    k.kilde === 'commit'
      ? `ble endret utenfor køen i ${k.kort} «${String(k.emne ?? '').slice(0, 70)}»`
      : k.kilde === 'gren'
        ? `ble endret utenfor køen på grenen ${k.gren} (ikke i ${baseGren()})`
        : 'er ucommittet i hovedtreet (en annen økt jobber i den)';
  return `${medId ? `${k.id}: ` : ''}fila ${fil} ${hvor}`;
}

/**
 * Advarselen `sporfil` skriver inn i sporblokka når eierfilene er endret utenfor køen siden oppgaven ble lagt inn,
 * så sporet leser diffen før det bygger på et utdatert oppdrag. null når det ikke er noe å advare om.
 * @param {object} o oppgaven
 * @param {object[]} kollisjoner eksternKollisjoner for denne oppgaven
 * @param {{ kort: string, emne?: string }[]} nevnt eksterne commits som nevner id-en
 */
function sporfilAdvarsel(o, kollisjoner = [], nevnt = []) {
  if (!kollisjoner.length && !nevnt.length) return null;
  const MAKS = 12;
  const linjer = [
    `**ADVARSEL fra køen (arbeid utenfor køen): eierfilene dine er endret utenfor køen siden oppgaven ble lagt inn ` +
      `(${o.lagt_til ?? 'ukjent tid'}).** Oppdraget kan være utdatert. Les diffen før du bygger videre, og skriv i ` +
      'rapporten hva som ikke lenger stemmer:',
  ];
  for (const k of kollisjoner.slice(0, MAKS)) {
    if (k.kilde === 'commit')
      linjer.push(
        `- \`${k.fil}\` i ${k.kort} «${String(k.emne ?? '').slice(0, 70)}»: \`git show ${k.kort} -- ${k.fil}\``,
      );
    else if (k.kilde === 'gren')
      linjer.push(
        `- \`${k.fil}\` på grenen ${k.gren} (ikke flettet til ${baseGren()}): ` +
          `\`git diff ${baseGren()}...${k.gren} -- ${k.fil}\``,
      );
    else
      linjer.push(
        `- \`${k.fil}\` er ucommittet i hovedtreet: en annen økt jobber i fila. Rør den ikke; meld fra til orkestratoren.`,
      );
  }
  if (kollisjoner.length > MAKS)
    linjer.push(`- … og ${kollisjoner.length - MAKS} til (ko.mjs ekstern)`);
  if (nevnt.length)
    linjer.push(
      `Commits utenfor køen som nevner ${o.id} (er noe alt gjort?): ` +
        nevnt
          .slice(0, 5)
          .map((c) => `${c.kort} «${String(c.emne ?? '').slice(0, 60)}»`)
          .join(', '),
    );
  return linjer.join('\n');
}

/** Id for en ny registrering utenfor køen: ekstern-<navn som kebab-case>, med -2, -3 … når den finnes fra før. */
function eksternId(navn, oppgaver = []) {
  const slug =
    String(navn ?? '')
      .toLowerCase()
      .replace(/æ/g, 'ae')
      .replace(/ø/g, 'o')
      .replace(/å/g, 'a')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28)
      .replace(/-+$/, '') || 'okt';
  const ider = new Set(oppgaver.map((o) => o.id));
  let id = `ekstern-${slug}`;
  for (let n = 2; ider.has(id); n++) id = `ekstern-${slug}-${n}`;
  return id;
}

/**
 * Registrerer arbeid som pågår utenfor køen (`ko.mjs ekstern add`): en rad med status `ekstern` som eier filene (og
 * ev. DB-funksjonene) som en plukket oppgave, til `ekstern ferdig <navn>`. Samme navn på nytt mens raden er aktiv,
 * legger til filene (og setter grenen når den er gitt). Endrer `ko` (kalleren skriver fila under lås).
 * @returns {{ feil: string } | { rad: object, ny: boolean, advarsler: string[] }}
 */
function eksternAdd(
  ko,
  { navn, filer = [], db = [], gren = null, naa = new Date().toISOString() } = {},
) {
  const hvem = String(navn ?? '').trim();
  if (!hvem) return { feil: 'ekstern add krever --navn "<økt eller person>"' };
  const nyeFiler = [...new Set((filer ?? []).map((f) => norm(f).trim()).filter(Boolean))];
  const nyeDb = [...new Set((db ?? []).map((d) => String(d).trim()).filter(Boolean))];
  if (!nyeFiler.length && !nyeDb.length)
    return {
      feil: 'ekstern add krever --filer <sti …> (mappe med «/» til slutt), eller --db <funksjon …>',
    };
  ko.oppgaver = ko.oppgaver ?? [];
  let rad = ko.oppgaver.find(
    (o) => erEksternRad(o) && o.status === 'ekstern' && o.ekstern_navn === hvem,
  );
  const ny = !rad;
  if (rad) {
    rad.eier_filer = [...new Set([...(rad.eier_filer ?? []), ...nyeFiler])];
    rad.eier_db = [...new Set([...(rad.eier_db ?? []), ...nyeDb])];
    if (gren) rad.gren = gren;
    rad.oppdatert = naa;
  } else {
    rad = {
      id: eksternId(hvem, ko.oppgaver),
      tittel: `Arbeid utenfor køen: ${hvem}`,
      domene: 'ekstern',
      klasse: 'K',
      oppdrag:
        'Registrert med ko.mjs ekstern add. Ikke en oppgave: raden eier filene til ekstern ferdig.',
      nytte: 5,
      innhold_min: 0,
      migr_tiere: 0,
      avhenger: [],
      venter_paa: [],
      eier_filer: nyeFiler,
      eier_db: nyeDb,
      delt_patch: [],
      status: 'ekstern',
      ekstern: true,
      ekstern_navn: hvem,
      ...(gren ? { gren } : {}),
      lagt_til: naa,
      lagt_til_av: hvem,
    };
    const f = valider(rad, ko.oppgaver);
    if (f.length) return { feil: `registreringen er ugyldig: ${f.join('; ')}` };
    ko.oppgaver.push(rad);
  }
  // Advarsler: oppgaver i køen som alt eier det samme (de må snakke sammen), og ventende som nå blir holdt igjen.
  const advarsler = [];
  const holdt = [];
  for (const o of ko.oppgaver) {
    if (o === rad || erEksternRad(o)) continue;
    const k = konflikt(o, rad);
    if (!k) continue;
    if (AKTIVE.has(o.status))
      advarsler.push(
        `${o.id} (${o.status}) eier det samme: ${k.replace(/ eies av .*$/, '')}; si fra til orkestratoren`,
      );
    else if (o.status === 'venter') holdt.push(o.id);
  }
  if (holdt.length)
    advarsler.push(
      `${holdt.length} ventende oppgave(r) startes ikke før ekstern ferdig: ${holdt.slice(0, 8).join(', ')}${holdt.length > 8 ? ' …' : ''}`,
    );
  return { rad, ny, advarsler };
}

/** Avslutter en registrering utenfor køen (på navnet eller id-en): status ferdig, og filene er fri igjen. */
function eksternFerdig(ko, navnEllerId, naa = new Date().toISOString()) {
  const x = String(navnEllerId ?? '').trim();
  if (!x) return { feil: 'ekstern ferdig <navn>' };
  const rad = (ko.oppgaver ?? []).find(
    (o) => erEksternRad(o) && o.status === 'ekstern' && (o.ekstern_navn === x || o.id === x),
  );
  if (!rad)
    return { feil: `ingen aktiv registrering utenfor køen med navnet ${x} (se ko.mjs ekstern)` };
  rad.status = 'ferdig';
  rad.ferdig = naa;
  return { rad };
}

/**
 * Eieren eller orkestratoren godtar at en ventende oppgave er gjort utenfor køen (`ko.mjs ekstern godta <id> <sha>`):
 * status ferdig med merknaden «gjort utenfor køen i <sha>». Aldri automatisk. `nevnt` = commit-meldingen nevner id-en
 * (ellers står det i merknaden). En visuell oppgave havner i QA-lista som ved `sett ferdig`.
 * @returns {{ feil: string } | { oppgave: object, qa: boolean }}
 */
function eksternGodta(ko, id, sha, { nevnt = true, naa = new Date().toISOString() } = {}) {
  const o = (ko.oppgaver ?? []).find((x) => x.id === id);
  if (!o) return { feil: `ukjent oppgave ${id}` };
  if (erEksternRad(o))
    return { feil: `${id} er en registrering utenfor køen (ko.mjs ekstern ferdig)` };
  if (!sha) return { feil: 'ekstern godta <id> <sha>' };
  if (o.status !== 'venter' && o.status !== 'forslag') {
    const hvorfor =
      o.status === 'plukket' ? `plukket av ${o.plukket_av ?? '?'}` : `status ${o.status}`;
    return { feil: `${id} kan ikke godtas som gjort utenfor køen: ${hvorfor}` };
  }
  const s = settStatus(o, 'ferdig', naa);
  if (s.feil) return s;
  o.gjort_utenfor_koen = sha;
  o.merknader = [
    ...(o.merknader ?? []),
    `${naa} gjort utenfor køen i ${String(sha).slice(0, 8)}${nevnt ? '' : ' (commit-meldingen nevner ikke id-en)'}`,
  ];
  return { oppgave: o, qa: s.qa };
}

/**
 * Er en orkestrator aktiv? Markøren (scripts/.ko/orkestrator.json: { okt, oppdatert, hendelse }) oppdateres av
 * orkestratoren ved hver løkkerunde (`ko.mjs orkestrator puls`, og av `start`/`sett`), og regnes som utløpt etter 2 t.
 */
function orkestratorStatus(markor, naa = Date.now()) {
  if (!markor || !markor.oppdatert)
    return { aktiv: false, okt: null, alder_ms: null, grunn: 'ingen markør' };
  const alder = naa - Date.parse(markor.oppdatert);
  if (!Number.isFinite(alder))
    return { aktiv: false, okt: markor.okt ?? null, alder_ms: null, grunn: 'ugyldig tidsstempel' };
  const aktiv = alder <= ORKESTRATOR_UTLOP_MS;
  return {
    aktiv,
    okt: markor.okt ?? null,
    alder_ms: alder,
    hendelse: markor.hendelse ?? null,
    grunn: aktiv ? null : 'utløpt (over 2 t uten oppdatering)',
  };
}

/** Ny markør: økt-navnet er det som er gitt, ellers forrige markørs, ellers «orkestrator». */
function nyMarkor(forrige, { okt, hendelse, naa = new Date().toISOString() } = {}) {
  const navn = String(okt ?? '').trim() || forrige?.okt || 'orkestrator';
  const m = { okt: navn, oppdatert: naa, hendelse: hendelse ?? null };
  // Økt-bindingen (okt_id/okt_id_tid, satt av hook-kontekst.mjs) og avviklingsflagget følger med så
  // lenge det er samme økt (samme navn) og markøren ikke er utløpt. Et nytt navn (eller en utløpt markør) betyr at en
  // ny økt tar markøren: da nullstilles begge, og okt_id_tid settes til nå, så bare orkestratorkall gjort ETTER
  // overtakelsen kan binde en økt (kontekstVakt.orkestratorBinding).
  const levende = forrige != null && orkestratorStatus(forrige, Date.parse(naa)).aktiv;
  if (levende && navn === forrige.okt) {
    if (forrige.okt_id) m.okt_id = forrige.okt_id;
    if (forrige.okt_id_tid != null) m.okt_id_tid = forrige.okt_id_tid;
    if (forrige.avvikling) m.avvikling = forrige.avvikling;
  } else if (forrige) {
    m.okt_id_tid = Date.parse(naa);
  }
  return m;
}

/**
 * Oppgaver i arbeid (forslag, venter, kjorer, plukket, review) som mangler prosjekt (havner i uten-prosjekt, bare
 * når registeret har prosjekter) eller funksjon. Nye oppgaver skal ha begge (legg-til-ko); en annen økt som legger
 * inn uten, blir synlig her og i `add`.
 */
function manglerProsjekt(oppgaver, register) {
  const iArbeid = new Set(['forslag', 'venter', 'kjorer', 'plukket', 'review']);
  const medRegister = Object.keys(register ?? {}).length > 0;
  const utenProsjekt = [];
  const utenFunksjon = [];
  for (const o of oppgaver ?? []) {
    if (erEksternRad(o) || !iArbeid.has(o.status)) continue;
    if (medRegister && prosjektFor(o, register) === UTEN_PROSJEKT) utenProsjekt.push(o.id);
    if (typeof o.funksjon !== 'string' || !o.funksjon.trim()) utenFunksjon.push(o.id);
  }
  return { utenProsjekt, utenFunksjon };
}

// ---- Sporblokka (sporfil og sky-pakke) ------------------------------------------------------------------------

/**
 * Sporblokka fra overskriften «## SPOR …» og ned: eierskapet, ev. advarsel om endringer utenfor køen, eierens svar
 * og oppdragsteksten. `ko.mjs sporfil` legger TITTEL/BLOKK/GREN foran; `sky-pakke` legger den under «## Oppdraget».
 * @param {object} o oppgaven
 * @param {object} ko køen (for svarBlokk)
 * @param {{ tekst: string, advarsel?: string|null, sky?: boolean }} v `sky`: skyøkta har ingen SendMessage, så
 *   eierskapslinja sier «stopp» i stedet for «meld fra».
 */
function sporBlokk(o, ko, { tekst, advarsel = null, sky = false } = {}) {
  const liste = (x) => (Array.isArray(x) && x.length ? x.join(', ') : 'ingen');
  const meldFra = sky
    ? 'trengs det, stopp med SKY-STOPP og si hva som trengs.'
    : 'trengs det, meld fra (SendMessage) i stedet for å endre det.';
  const svar = svarBlokk(o, ko);
  return [
    `## SPOR ${o.id} (${o.tittel}; kilde: ${o.kilde ?? 'se oppdraget'}; klasse ${o.klasse}, anslag ${anslag(o)} min)`,
    '',
    `**Eierskap i køen:** filer ${liste(o.eier_filer)}; DB ${liste(o.eier_db)}; delt patch ${liste(o.delt_patch)}. Rør ikke noe andre oppgaver i køen eier; ${meldFra}`,
    '',
    ...(advarsel ? [advarsel, ''] : []),
    ...(svar ? [svar, ''] : []),
    String(tekst ?? '').trim(),
    // `ko.mjs endre <id> --tillegg "…"` (i stedet for node -e mot ko.json).
    ...(tilleggBlokk(o) ? ['', tilleggBlokk(o)] : []),
    '',
  ].join('\n');
}

// ---- Sky: køoppgaver i skyøkter på claude.ai --------------------------------------------------------
// Skyøkta ser bare det som er pushet til remoten og har ingen database. Derfor egner bare klient-/verktøyoppgaver
// (K, U) uten migrasjoner og DB seg, og bare når eierfilene er pushet. Orkestratoren (eller eieren fra tavla) sender
// pakken; skyen pusher køgrenen (<grenPrefiks><id>, eller den grenen økta får lov til), og orkestratoren fletter som
// ellers.

/** Hvem en skyøkt står som i `plukket_av`. */
const SKY_AV = 'sky';
/** Høyst så mange skyøkter samtidig (teller ikke mot maksSamtidig). */
const SKY_MAKS = 3;
const SKY_KLASSER = new Set(['K', 'U']);
// Feltet `krever` (settes når oppgaven legges inn): hva oppgaven trenger utover repoet på remoten.
// Ressursene i SKY_STENGT finnes ikke i en skyøkt (ingen database, nettet er sperret bak en proxy, gitignorerte
// filer, lokale kildesamlinger og eierens enhet er lokale), så oppgaven går lokalt. `deploy` stenger ikke:
// orkestratoren deployer etter flettingen.
const KREVER = new Set(['db', 'nett', 'kilder', 'lokale-filer', 'enhet', 'deploy']);
const SKY_STENGT = new Map([
  ['db', 'trenger databasen (testkjøringer mot en database)'],
  ['nett', 'trenger nettet (nedlasting eller eksterne kilder; skyen er bak en sperre)'],
  ['kilder', 'trenger lokale kildesamlinger eller primærkilder'],
  ['lokale-filer', 'trenger filer som bare finnes lokalt (gitignorert eller utracket)'],
  ['enhet', 'trenger eierens enhet eller en kjørende app'],
]);

/** Står oppgaven i en skyøkt nå? (plukket av «sky», med sky-feltet satt av `sky start`) */
function erSky(o) {
  return o?.status === 'plukket' && o.plukket_av === SKY_AV && !!o.sky;
}

/**
 * Områdene skyen ikke ser (gitignorert eller utracket). Køens datamappe (scripts/.ko/) er alltid med; mappene i
 * konfig().skyUsynlig (liste med stier, f.eks. 'docs/privat/') legges til.
 */
function skyUsynlig() {
  const ekstra = Array.isArray(kfg().skyUsynlig) ? kfg().skyUsynlig : [];
  return [
    ...ekstra
      .map((s) => String(s).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .map((s) => ({
        monster: new RegExp(`(^|/)${regexTrygg(s)}(/|$)`),
        omrade: `${s}/`,
        loftbar: true,
      })),
    { monster: /(^|\/)scripts\/\.ko(\/|$)/, omrade: 'scripts/.ko/', loftbar: false },
  ];
}
// En linje som sier at det bindende er løftet inn i oppdraget (malens «GITIGNORERT; alt bindende er løftet inn her»),
// er en kildehenvisning, ikke noe skyen trenger å lese.
const LOFTET_INN = /løftet inn|alt bindende/i;

/**
 * Henvisningene i oppdragsteksten til filer skyen ikke ser. Oppgavens egen oppdragsfil regnes ikke (den legges inn
 * i pakken). `loftet`: linja sier at det bindende er løftet inn (gjelder ikke scripts/.ko/, der ligger andre
 * oppgavers oppdrag).
 * @returns {{ sti: string, omrade: string, loftet: boolean }[]} unike stier i rekkefølge
 */
function skyReferanser(tekst, { id, egenSti } = {}) {
  const egen = egenSti ? norm(egenSti).toLowerCase() : null;
  const usynlige = skyUsynlig();
  const ut = [];
  const sett = new Set();
  for (const linje of String(tekst ?? '').split('\n')) {
    const loftet = LOFTET_INN.test(linje);
    for (const raa of linje.replace(/\\/g, '/').split(/[\s`'"()<>[\]|,;«»*]+/)) {
      const sti = raa.replace(/[.:]+$/, '');
      if (!sti) continue;
      const treff = usynlige.find((u) => u.monster.test(sti));
      if (!treff) continue;
      const lav = sti.toLowerCase();
      if (egen && (lav === egen || lav.endsWith(`/${egen}`))) continue;
      if (id && treff.omrade === 'scripts/.ko/' && lav.endsWith(`/oppdrag/${id.toLowerCase()}.md`))
        continue;
      if (sett.has(sti)) continue;
      sett.add(sti);
      ut.push({ sti, omrade: treff.omrade, loftet: treff.loftbar && loftet });
    }
  }
  return ut;
}

/**
 * Kan oppgaven kjøres i en skyøkt? Egnet når alt dette stemmer:
 *   - klasse K eller U, ingen migrasjoner (migr_tiere 0), tom eier_db og delt_patch
 *   - oppdraget viser ikke til mapper skyen ikke ser (konfig().skyUsynlig, og scripts/.ko/ utover sin egen fil; en
 *     kildehenvisning på en linje som sier at det bindende er løftet inn, er greit)
 *   - status venter uten åpne avhengigheter, eierspørsmål eller eierkollisjon (eller allerede i en skyøkt)
 *   - eierfilene er ikke endret lokalt siden <remote>/<basegren> (committet og ikke pushet, eller ucommittet):
 *     ellers bygger skyen på gammel kode
 * @param {{ pushetHead?: string|null, endret?: string[], oppdragTekst?: string, egenSti?: string|null }} v
 *   `pushetHead`: sha-en til <remote>/<basegren> (null: ukjent, da kan det ikke sjekkes). `endret`: stiene som er
 *   endret lokalt siden den. `oppdragTekst`: selve oppdraget (fila `oppdrag` peker til, eller teksten).
 * @returns {{ egnet: boolean, grunner: string[] }}
 */
function skyEgnet(ko, id, { pushetHead = null, endret = [], oppdragTekst, egenSti = null } = {}) {
  const oppgaver = ko?.oppgaver ?? [];
  const o = oppgaver.find((x) => x.id === id);
  if (!o) return { egnet: false, grunner: [`ukjent oppgave ${id}`] };
  const grunner = [];
  if (!SKY_KLASSER.has(o.klasse)) grunner.push(`klasse ${o.klasse} (bare K og U går i skyen)`);
  if (Number(o.migr_tiere ?? 0) > 0) grunner.push('har migrasjoner (skyen har ingen database)');
  // Etiketten «ikke-sky»: en skyøkt har prøvd og stoppet fordi oppgaven trenger noe bare lokalt (kilder,
  // nedlastinger, lokale filer). Settes av orkestratoren etter SKY-STOPP.
  for (const k of o.krever ?? []) if (SKY_STENGT.has(k)) grunner.push(SKY_STENGT.get(k));
  if (harEtikett(o, 'ikke-sky'))
    grunner.push('merket ikke-sky (trenger noe som bare finnes lokalt)');
  if ((o.eier_db ?? []).length) grunner.push(`eier DB-funksjoner: ${o.eier_db.join(', ')}`);
  if ((o.delt_patch ?? []).length) grunner.push(`delt patch: ${o.delt_patch.join(', ')}`);

  if (erSky(o)) {
    // Allerede i en skyøkt: statusen er riktig, og hindringene gjaldt da den ble startet.
  } else if (o.status !== 'venter') {
    grunner.push(
      o.status === 'plukket' ? `plukket av ${o.plukket_av ?? '?'}` : `status ${o.status}`,
    );
  } else {
    for (const h of hindringDeler(o, oppgaver, ko.avklart)) {
      if (h.type === 'avhenger') grunner.push(`åpen avhengighet: ${h.tekst}`);
      else if (h.type === 'sporsmal') grunner.push(`åpent eierspørsmål: ${h.sp}`);
      else grunner.push(h.tekst);
    }
  }

  const tekst = oppdragTekst ?? (String(o.oppdrag ?? '').includes('\n') ? o.oppdrag : '');
  // Henvisninger til andre oppgavers oppdrag (scripts/.ko/oppdrag/<annen>.md) er kontekst, ikke bindende innhold:
  // pakken forklarer at fila ikke finnes i skyen. De stenger ikke.
  const usynlige = skyReferanser(tekst, { id: o.id, egenSti }).filter(
    (r) => !r.loftet && r.omrade !== 'scripts/.ko/',
  );
  if (usynlige.length)
    grunner.push(
      `oppdraget viser til filer skyen ikke ser: ${usynlige.map((r) => r.sti).join(', ')}`,
    );

  if (!pushetHead)
    grunner.push(
      `fant ikke ${remoteNavn()}/${baseGren()} (kjør git fetch ${remoteNavn()} ${baseGren()})`,
    );
  else {
    const lokale = [];
    for (const f of o.eier_filer ?? []) {
      const e = (endret ?? []).find((sti) => filOverlapp(f, sti));
      if (e) lokale.push(norm(e));
    }
    if (lokale.length)
      grunner.push(
        `eierfiler endret lokalt og ikke pushet: ${[...new Set(lokale)].slice(0, 5).join(', ')}` +
          ` (push ${baseGren()} først)`,
      );
  }
  return { egnet: grunner.length === 0, grunner };
}

/** De generelle reglene for et K- eller U-spor i skyen, kort. Prosjektets egne står i konfig().arkitekturRegler. */
const SKY_REGLER_FELLES = [
  'Ingen migrasjoner og ingen database: skyen har ingen database. Trengs det, SKY-STOPP.',
  'Følg prosjektets CLAUDE.md; reglene under er de viktigste for sporet.',
  'Ingen personopplysninger eller hemmeligheter i logger, feilmeldinger eller commits. Ingen dev-server eller preview.',
  'Commit bare filene du eier (git add -- <filer>); rør ikke filer utenfor eierlista.',
];

/** Reglene skypakka tar med: de generelle og prosjektets arkitekturregler (konfig().arkitekturRegler). */
function skyRegler() {
  const egne = Array.isArray(kfg().arkitekturRegler) ? kfg().arkitekturRegler : [];
  return [...SKY_REGLER_FELLES, ...egne.map(String).filter((r) => r.trim())];
}

/** Bunt: høyst så mange oppgaver, og høyst så mange minutter anslag til sammen, i én skyøkt. */
const SKY_BUNT_MAKS = 4;
const SKY_BUNT_MIN = 120;

const SKY_GATER =
  'npm install; testene for de nye/endrede filene; og til slutt, før push, ' +
  '`node scripts/orkestrator/gater.mjs --rask --bolge sky --spor <id>` (de raske gatene fra konfig().gater.rask). ' +
  'Er en gate rød, rett det og kjør på nytt; er den rød av noe utenfor oppgaven eller av et miljøavvik i skyen, ' +
  'nevn det i rapporten.';
// npm install kan skrive om package-lock.json; da må økta tilbakestille den selv.
const SKY_LOCK =
  'Ikke commit package-lock.json med mindre oppdraget sier det (npm install skriver den om; tilbakestill den før commit).';
const commitLinje = (id) =>
  `Commit-melding: «<type>(<område>): <kort> (${id})» + linja «Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>».`;
const grenLinje = (gren, forklaring = '') => {
  const r = remoteNavn();
  const b = baseGren();
  return (
    `Grenregel${forklaring}: start fra ${r}/${b} (git fetch ${r} ${b} && git checkout -b ${gren} ${r}/${b}). ` +
    `Push bare grenen ${gren} til ${r}. Blir push til ${gren} avvist av tilgangsregler, push i stedet til den ` +
    `grenen økta har lov til (for eksempel claude/...) og skriv navnet på grenen i rapporten. Aldri ${b}, ` +
    'aldri PR.'
  );
};

/** «Filer skyen ikke ser …» for alle delene i pakka, eller null. */
function usynligLinje(deler) {
  const stier = [
    ...new Set(
      deler.flatMap((d) =>
        skyReferanser(d.tekst, { id: d.o.id, egenSti: d.egenSti }).map((r) => r.sti),
      ),
    ),
  ];
  return stier.length
    ? `Filer skyen ikke ser (gitignorert eller utracket): ${stier.join(', ')}. Alt bindende står i oppdraget ` +
        'under; ignorer disse henvisningene.'
    : null;
}

/**
 * Skypakka: én selvstendig melding til rutinen «ko-sky» (eller til å lime inn i en skyøkt). Oppbygning: grenregel, gater, commit-melding, filer skyen ikke ser, regler, rapportformat, og så
 * oppdraget i sin helhet med sporblokka.
 * @param {{ tekst: string, egenSti?: string|null }} v oppdragsteksten (fila eller selve teksten)
 */
function skyPakke(o, ko, { tekst, egenSti = null } = {}) {
  const id = o.id;
  const usynlig = usynligLinje([{ o, tekst, egenSti }]);
  return [
    `# SKYSPOR ${id} (klasse ${o.klasse}, ca. ${anslag(o)} min)`,
    '',
    grenLinje(koGren(id)),
    `Gater i skyen: ${SKY_GATER}`,
    SKY_LOCK,
    commitLinje(id),
    ...(usynlig ? [usynlig] : []),
    '',
    'Regler (de som gjelder dette sporet):',
    ...skyRegler().map((r) => `- ${r}`),
    '',
    'Rapport: høyst 20 linjer (hva, filer, testresultat rød først så grønn, gater, grenen), siste linje ' +
      `«SKY-FERDIG ${id} <sha>» eller «SKY-STOPP ${id} <grunn>».`,
    '',
    '## Oppdraget',
    '',
    sporBlokk(o, ko, { tekst, sky: true }),
  ].join('\n');
}

/**
 * Taket for en bunt: høyst SKY_BUNT_MAKS oppgaver og SKY_BUNT_MIN minutter anslag, og ingen id to ganger.
 * @param {object[]} oppgaver
 * @returns {string[]} grunnene (tom = innenfor taket)
 */
function skyBuntTak(oppgaver, { maks = SKY_BUNT_MAKS, maksMin = SKY_BUNT_MIN } = {}) {
  const grunner = [];
  const ider = oppgaver.map((o) => o.id);
  if (new Set(ider).size !== ider.length) grunner.push('samme oppgave to ganger');
  if (oppgaver.length > maks) grunner.push(`${oppgaver.length} oppgaver (høyst ${maks} i én bunt)`);
  const sum = oppgaver.reduce((s, o) => s + anslag(o), 0);
  if (sum > maksMin) grunner.push(`${sum} min anslag til sammen (høyst ca. ${maksMin} i én bunt)`);
  return grunner;
}

/**
 * Skypakka for en bunt: flere små oppgaver i én skyøkt (oppstarten, klone + npm install + CLAUDE.md, koster det samme
 * uansett størrelse). Oppdragene gjøres etter hverandre i rekkefølgen de er gitt. Hver får egen køgren laget fra
 * <remote>/<basegren> (aldri fra forrige oppgaves gren), egen commit, egen push og egen rapportlinje; en stopp på én
 * hindrer ikke de neste. Siste linje er SKY-BUNT-FERDIG <ferdige>/<antall>. Én oppgave gir vanlig skyPakke.
 * @param {{ o: object, tekst: string, egenSti?: string|null }[]} deler
 */
function skyBuntPakke(deler, ko) {
  if (deler.length === 1) return skyPakke(deler[0].o, ko, deler[0]);
  const n = deler.length;
  const ider = deler.map((d) => d.o.id);
  const sum = deler.reduce((s, d) => s + anslag(d.o), 0);
  const usynlig = usynligLinje(deler);
  return [
    `# SKYBUNT ${ider.join(', ')} (${n} oppgaver, ca. ${sum} min)`,
    '',
    `Gjør de ${n} oppdragene under etter hverandre, i denne rekkefølgen: ${ider.join(' → ')}. For HVER oppgave:`,
    `- ${grenLinje(koGren('<id>'), ' (egen gren per oppgave)')} Lag hver gren fra ${remoteNavn()}/${baseGren()}, ` +
      'aldri fra forrige ' +
      'oppgaves gren, og ta ikke med endringer fra en tidligere oppgave.',
    `- Egen commit og egen push. ${commitLinje('<id>')}`,
    `- Gater for oppgaven: ${SKY_GATER}`,
    '- Rapportlinje rett etter push: «SKY-FERDIG <id> <sha>», eller «SKY-STOPP <id> <grunn>» når oppgaven ikke kan ' +
      'gjøres. En stopp hindrer ikke de neste: gå videre til neste oppgave.',
    SKY_LOCK,
    ...(usynlig ? [usynlig] : []),
    '',
    'Regler (de som gjelder alle oppgavene):',
    ...skyRegler().map((r) => `- ${r}`),
    '',
    'Rapport: høyst 8 linjer per oppgave (hva, filer, testresultat rød først så grønn, gater, grenen), hver avsluttet ' +
      'med sin rapportlinje. Siste linje i hele rapporten: ' +
      `«SKY-BUNT-FERDIG <antall SKY-FERDIG>/${n}».`,
    '',
    ...deler.flatMap((d, i) => [
      '---',
      '',
      `# Oppgave ${i + 1} av ${n}: ${d.o.id} (gren ${koGren(d.o.id)})`,
      '',
      sporBlokk(d.o, ko, { tekst: d.tekst, sky: true }),
    ]),
  ].join('\n');
}

/**
 * Forslag til bunter (`ko.mjs sky-bunter`): de skyegnede kandidatene gruppert etter prosjekt og funksjon (samme område
 * etter hverandre, så konteksten gjenbrukes), gruppene etter beste prioritet, og innen gruppa etter prioritet. Så
 * fylles buntene i den rekkefølgen så lenge taket holder; en oppgave som alene er over taket, står alene.
 * @param {{ id: string, prosjekt: string, funksjon?: string|null, anslag: number, score: number }[]} kandidater
 * @returns {{ ider: string[], minutter: number, omrader: string[] }[]}
 */
function skyBunter(kandidater, { maks = SKY_BUNT_MAKS, maksMin = SKY_BUNT_MIN } = {}) {
  const grupper = new Map();
  for (const k of kandidater) {
    const omrade = `${k.prosjekt}${k.funksjon ? ` / ${k.funksjon}` : ''}`;
    if (!grupper.has(omrade)) grupper.set(omrade, []);
    grupper.get(omrade).push({ ...k, omrade });
  }
  const etterScore = (a, b) => b.score - a.score || a.id.localeCompare(b.id);
  const ordnet = [...grupper.values()]
    .map((g) => g.sort(etterScore))
    .sort((a, b) => etterScore(a[0], b[0]))
    .flat();
  const bunter = [];
  let naa = null;
  for (const k of ordnet) {
    if (!naa || naa.ider.length >= maks || naa.minutter + k.anslag > maksMin) {
      naa = { ider: [], minutter: 0, omrader: [] };
      bunter.push(naa);
    }
    naa.ider.push(k.id);
    naa.minutter += k.anslag;
    if (!naa.omrader.includes(k.omrade)) naa.omrader.push(k.omrade);
  }
  return bunter;
}

/** Antall skyøkter som går: oppgaver i samme økt (samme kjøring, eller samme bunt) teller én gang. */
function skyOkter(ko) {
  return new Set((ko.oppgaver ?? []).filter(erSky).map((o) => o.sky.kjoring ?? o.sky.bunt ?? o.id))
    .size;
}

/**
 * `ko.mjs sky start <id> [<id> …]`: plukker oppgavene for én skyøkt (plukket_av «sky», gren ko/<id>) og setter
 * `sky: { startet, kjoring?, bunt? }` (bunt = id-ene når flere går i samme økt). Alt eller ingenting. Nekter når en
 * oppgave ikke er egnet (`egnethet` per id, regnet av kalleren med git), når bunten er over taket, eller når SKY_MAKS
 * skyøkter allerede går; `tving` overstyrer de tre, og plukkets hindringer. Er en oppgave allerede i sky, settes bare
 * kjøringen (orkestratoren fikk økt-id-en etter at eieren trykket start).
 * @param {string|string[]} ider
 * @param {{ egnethet?: Record<string, { egnet: boolean, grunner: string[] }>, kjoring?: string|null, tving?: boolean,
 *   naa?: string }} v
 * @returns {{ feil: string } | { oppgaver: object[], nye: string[], igjen: string[], overstyrt: string[] }}
 */
function skyStart(
  ko,
  ider,
  { egnethet = {}, kjoring = null, tving = false, naa = new Date().toISOString() } = {},
) {
  const liste = [].concat(ider);
  const oppgaver = [];
  for (const id of liste) {
    const o = (ko.oppgaver ?? []).find((x) => x.id === id);
    if (!o) return { feil: `ukjent oppgave ${id}` };
    oppgaver.push(o);
  }
  const nye = oppgaver.filter((o) => !erSky(o));
  const igjen = oppgaver.filter((o) => erSky(o));
  const overstyrt = [];
  const stopp = (tekst) => {
    if (!tving) return `${tekst} (--tving overstyrer)`;
    overstyrt.push(tekst);
    return null;
  };
  for (const o of nye) {
    const e = egnethet[o.id];
    if (e && !e.egnet) {
      const f = stopp(`${o.id} er ikke egnet for sky: ${e.grunner.join(' · ')}`);
      if (f) return { feil: f };
    }
  }
  const tak = skyBuntTak(oppgaver);
  if (tak.length) {
    const f = stopp(`bunten er over taket: ${tak.join(' · ')}`);
    if (f) return { feil: f };
  }
  if (nye.length) {
    const okter = skyOkter(ko);
    if (okter >= SKY_MAKS) {
      const f = stopp(`${okter} skyøkter går allerede (høyst ${SKY_MAKS})`);
      if (f) return { feil: f };
    }
  }
  // plukk endrer køen; sjekk alle før noen endres (kalleren skriver ikke fila ved feil, men hold det rent).
  for (const o of nye) {
    if (o.status !== 'venter')
      return { feil: `${o.id} kan ikke startes i sky: status ${o.status}` };
  }
  const bunt = liste.length > 1 ? liste.join(',') : null;
  for (const o of nye) {
    const p = plukk(ko, o.id, { av: SKY_AV, tving, naa });
    if (p.feil) return p;
    overstyrt.push(...p.overstyrt);
    o.sky = { startet: naa, ...(kjoring ? { kjoring } : {}), ...(bunt ? { bunt } : {}) };
  }
  for (const o of igjen) if (kjoring) o.sky.kjoring = kjoring;
  return {
    oppgaver,
    nye: nye.map((o) => o.id),
    igjen: igjen.map((o) => o.id),
    overstyrt,
  };
}

/**
 * `ko.mjs sky ferdig`: skyen har pushet grenen (kalleren har sjekket den med git). Oppgaven går til review som ved
 * `lever`, med `sky.ferdig`, grenen og sha-en. Orkestratoren fletter.
 */
function skyFerdig(ko, id, { gren, sha = null, naa = new Date().toISOString() } = {}) {
  const o = (ko.oppgaver ?? []).find((x) => x.id === id);
  if (!o) return { feil: `ukjent oppgave ${id}` };
  if (!erSky(o))
    return {
      feil: `${id} står ikke i en skyøkt (status ${o.status}${o.plukket_av ? `, plukket av ${o.plukket_av}` : ''})`,
    };
  const l = lever(ko, id, naa);
  if (l.feil) return l;
  o.sky = { ...o.sky, ferdig: naa, gren: gren ?? koGren(id), ...(sha ? { sha } : {}) };
  return { oppgave: o };
}

/** `ko.mjs sky avbryt` = slipp for en skyøkt (grenen og migrasjonsblokken beholdes, sky-feltet fjernes). */
function skyAvbryt(ko, id, { commits = 0, naa = new Date().toISOString() } = {}) {
  const o = (ko.oppgaver ?? []).find((x) => x.id === id);
  if (!o) return { feil: `ukjent oppgave ${id}` };
  if (!erSky(o)) return { feil: `${id} står ikke i en skyøkt (status ${o.status})` };
  const kjoring = o.sky?.kjoring ?? null;
  const s = slipp(ko, id, { commits, naa });
  if (s.feil) return s;
  o.merknader = [...(o.merknader ?? []), `${naa} skyøkt avbrutt${kjoring ? ` (${kjoring})` : ''}`];
  return s;
}

// ---- Samlekøen -----------------------------------------------------------------
// Små oppgaver som ikke passer naturlig inn i et spor av riktig størrelse, og som ikke blokkerer noe, legges inn med
// `samles: true` i stedet for å bli egne små spor (fast overhead er en stor del av et lite K-spor). De vises, men startes og plukkes aldri alene
// (hindringen `samles`). Når en gruppe (prosjekt → klasse) er stor nok, pakker orkestratoren den til ett spor med
// `ko.mjs samle pakk`: ny oppgave med oppdragsfil som samler originalene i sin helhet, originalene kansellert med
// merknad, `avhenger` i andre oppgaver pekt om, og `sammenslatt_fra` (samme mekanikk som annen sammenslåing).

/** Hindringen en oppgave i samlekøen får (vis, tavla, start, plukk). */
const SAMLES_HINDRING =
  'i samlekøen (pakkes til et spor med ko.mjs samle pakk; tas ut med endre --json \'{"samles":false}\')';

/**
 * Målstørrelsen per klasse i innholdsminutter (legg-til-ko): `min` = nedre mål (en gruppe er «klar til pakking» fra
 * og med dette), `maal` = midten av målet, `maks` = øvre mål (en pakke fylles ikke over dette). D+ slås aldri sammen.
 */
const SAMLE_MAAL = {
  K: { min: 90, maal: 105, maks: 120 },
  D: { min: 30, maal: 40, maks: 50 },
  U: { min: 45, maal: 60, maks: 75 },
};
/** Rekkefølgen klassene vises i. */
const SAMLE_KLASSER = ['K', 'D', 'U'];

/** Har oppgaven `samles: true` (og er den en køoppgave, ikke en registrering utenfor køen)? */
function erSamles(o) {
  return o?.samles === true && !erEksternRad(o);
}

/** Står oppgaven i samlekøen nå (samles og venter eller forslag)? Kansellerte og ferdige er ute av den. */
function iSamlekoen(o) {
  return erSamles(o) && (o.status === 'venter' || o.status === 'forslag');
}

const aapenOppgave = (o) => !!o && o.status !== 'ferdig' && o.status !== 'kansellert';
const innholdMin = (o) => Number(o?.innhold_min ?? 30) || 0;
/** De eierspørsmålene i `venter_paa` som ikke er avklart. */
const aapneSporsmal = (o, avklart = []) => {
  const a = new Set(avklart ?? []);
  return [...new Set(o?.venter_paa ?? [])].filter((sp) => !a.has(sp)).sort();
};

/**
 * Reglene for samlekøen ved `add` og `endre` (kalles i tillegg til valider). `oppgaver` = køen slik den blir (ved add:
 * de eksisterende pluss de nye; oppgaven selv kan være med). Avviser `samles` for D+, for oppgaver som andre
 * ikke-ferdige oppgaver avhenger av, for oppgaver som venter på et eierspørsmål som ikke er avklart, og for oppgaver
 * som ikke venter. Avviser også at en oppgave avhenger av en oppgave i samlekøen (den ville aldri blitt startet).
 * @returns {string[]} feil (tom = gyldig)
 */
function samlesFeil(o, oppgaver = [], avklart = []) {
  const feil = [];
  if (!o || typeof o !== 'object') return feil;
  if (o.samles != null && typeof o.samles !== 'boolean')
    feil.push('samles må være true eller false');
  if (o.samles === true) {
    if (o.klasse === 'D+')
      feil.push('samles: D+ slås aldri sammen med annet; legg den inn som eget spor');
    if (o.status && o.status !== 'venter' && o.status !== 'forslag')
      feil.push(`samles: bare oppgaver som venter kan ligge i samlekøen (status ${o.status})`);
    const avhengige = oppgaver
      .filter((x) => x.id !== o.id && aapenOppgave(x) && (x.avhenger ?? []).includes(o.id))
      .map((x) => x.id);
    if (avhengige.length)
      feil.push(
        `samles: ${avhengige.join(', ')} avhenger av ${o.id}; en oppgave som blokkerer noe, skal ikke i samlekøen`,
      );
    const sp = aapneSporsmal(o, avklart);
    if (sp.length)
      feil.push(
        `samles: ${o.id} venter på eierspørsmål som ikke er avklart (${sp.join(', ')}); den hører ikke i samlekøen før de er besvart`,
      );
  }
  const perId = new Map(oppgaver.map((x) => [x.id, x]));
  for (const dep of o.avhenger ?? []) {
    const d = perId.get(dep);
    if (d && d.id !== o.id && iSamlekoen(d))
      feil.push(
        `avhenger av ${dep}, som ligger i samlekøen og ikke startes alene (pakk den eller ta den ut først: ko.mjs endre ${dep} --json '{"samles":false}')`,
      );
  }
  return feil;
}

/**
 * Småoppgavevakten: en liten oppgave skal ikke bli et eget spor, fordi den faste
 * kostnaden per spor (oppstart, worktree, gater, fletting) er større enn innholdet. Kalles ved `add`, og slår bare inn
 * når `innhold_min` er satt eksplisitt og er under nedre mål for klassen (SAMLE_MAAL.min). Unntak: D+ (slås aldri
 * sammen), oppgaver som venter på et eierspørsmål, oppgaver som andre åpne oppgaver avhenger av, og
 * `eget_spor: "<grunn>"` (bevisst eget spor, f.eks. etter eierens ord).
 *   - Uten `nytte` er prioriteten usikker: spør eieren (med anbefaling) før oppgaven legges inn.
 *   - innhold_min <= SMAA_FIKS_MIN: ikke i køen. Eieren velger «fiks nå» (anbefalt) eller samlekøen (`samles: true`).
 *   - Ellers, med lav prioritet (nytte <= SMAA_LAV_NYTTE): samlekøen (`samles: true`), som pakker den til et spor av
 *     fornuftig størrelse (`ko.mjs samle`). Høy prioritet kan være eget spor.
 * @returns {string[]} feil (tom = gyldig)
 */
const SMAA_FIKS_MIN = 10;
const SMAA_LAV_NYTTE = 7;
function smaaoppgaveFeil(o, oppgaver = [], avklart = []) {
  if (!o || typeof o !== 'object') return [];
  const feil = [];
  const egetSpor = typeof o.eget_spor === 'string' && !!o.eget_spor.trim();
  if (o.eget_spor != null && !egetSpor)
    feil.push('eget_spor må være en kort grunn (tekst), f.eks. «eieren ba om eget spor»');
  if (typeof o.innhold_min !== 'number' || o.klasse === 'D+' || egetSpor) return feil;
  if (o.innhold_min >= (SAMLE_MAAL[o.klasse]?.min ?? 0)) return feil;
  if (aapneSporsmal(o, avklart).length) return feil;
  const blokkerer = oppgaver.some(
    (x) => x.id !== o.id && aapenOppgave(x) && (x.avhenger ?? []).includes(o.id),
  );
  if (blokkerer) return feil;
  const min = o.innhold_min;
  if (o.nytte == null) {
    feil.push(
      `småoppgave (${min} min) uten nytte: prioriteten er usikker. Spør eieren (med anbefaling) og sett nytte`,
    );
  } else if (min <= SMAA_FIKS_MIN && o.samles !== true) {
    feil.push(
      `småoppgave (${min} min, grensen er ${SMAA_FIKS_MIN}): legg den ikke i køen. Spør eieren: fiks nå (anbefalt) eller samlekøen ("samles": true). Bevisst eget spor: "eget_spor": "<grunn>"`,
    );
  } else if (min > SMAA_FIKS_MIN && o.nytte <= SMAA_LAV_NYTTE && o.samles !== true) {
    feil.push(
      `liten oppgave med lav prioritet (${min} min, under ${SAMLE_MAAL[o.klasse].min} for ${o.klasse}, nytte ${o.nytte}): legg den i samlekøen med "samles": true. Bevisst eget spor: "eget_spor": "<grunn>"`,
    );
  }
  return feil;
}

/** Felles verdi når alle har den samme, ellers den første (prosjekt, funksjon, domene). */
function fellesEllerForste(verdier) {
  const v = verdier.filter((x) => x != null && x !== '');
  return v.length ? v[0] : null;
}
/** Union av listefeltet over oppgavene, i rekkefølgen de først forekommer. */
function unionFelt(deler, felt) {
  const ut = [];
  for (const o of deler) for (const x of o[felt] ?? []) if (!ut.includes(x)) ut.push(x);
  return ut;
}

/**
 * Samlekøen gruppert prosjekt → klasse, med sum innholdsminutter mot målet for klassen. Deterministisk: prosjektene i
 * registerets rekkefølge (som `vis --gruppert`), klassene K, D, U (D+ sist, merket ugyldig), oppgavene etter funksjon
 * og id. `klar` = summen har nådd nedre mål (K 90, D 30, U 45). `felles_filer` = eierfiler som flere i gruppa eier.
 * @returns {{ pid, tittel, klasse, maal, sum, antall, klar, over, ugyldig, oppgaver, funksjoner, felles_filer }[]}
 */
function samleGrupper(ko) {
  const register = ko.prosjekter ?? {};
  const perGruppe = new Map();
  for (const o of (ko.oppgaver ?? []).filter(iSamlekoen)) {
    const pid = prosjektFor(o, register);
    const nokkel = `${pid}\u0000${o.klasse}`;
    if (!perGruppe.has(nokkel)) perGruppe.set(nokkel, { pid, klasse: o.klasse, deler: [] });
    perGruppe.get(nokkel).deler.push(o);
  }
  const pider = new Set([...perGruppe.values()].map((g) => g.pid));
  const klasseRang = (k) => (SAMLE_KLASSER.includes(k) ? SAMLE_KLASSER.indexOf(k) : 99);
  const funksjonFor = (o) =>
    typeof o.funksjon === 'string' && o.funksjon.trim() ? o.funksjon.trim() : UTEN_FUNKSJON;
  const ut = [];
  for (const pid of prosjektRekkefolge(pider, register)) {
    const grupper = [...perGruppe.values()]
      .filter((g) => g.pid === pid)
      .sort(
        (x, y) =>
          klasseRang(x.klasse) - klasseRang(y.klasse) ||
          String(x.klasse).localeCompare(String(y.klasse)),
      );
    for (const g of grupper) {
      const deler = [...g.deler].sort((x, y) => {
        const fx = funksjonFor(x);
        const fy = funksjonFor(y);
        if (fx !== fy)
          return fx === UTEN_FUNKSJON ? 1 : fy === UTEN_FUNKSJON ? -1 : fx.localeCompare(fy, 'nb');
        return x.id.localeCompare(y.id);
      });
      const maal = SAMLE_MAAL[g.klasse] ?? null;
      const sum = deler.reduce((s, o) => s + innholdMin(o), 0);
      const funksjoner = [];
      for (const o of deler) {
        const f = funksjonFor(o);
        let rad = funksjoner.find((x) => x.funksjon === f);
        if (!rad) funksjoner.push((rad = { funksjon: f, sum: 0, ider: [] }));
        rad.sum += innholdMin(o);
        rad.ider.push(o.id);
      }
      const tellFil = new Map();
      for (const o of deler)
        for (const f of new Set((o.eier_filer ?? []).map(norm)))
          tellFil.set(f, (tellFil.get(f) ?? 0) + 1);
      ut.push({
        pid,
        tittel: register?.[pid]?.tittel ?? null,
        klasse: g.klasse,
        maal,
        sum,
        antall: deler.length,
        klar: !!maal && sum >= maal.min,
        over: !!maal && sum > maal.maks,
        ugyldig: !maal,
        funksjoner,
        felles_filer: [...tellFil.entries()]
          .filter(([, n]) => n > 1)
          .map(([f]) => f)
          .sort(),
        oppgaver: deler.map((o) => ({
          id: o.id,
          tittel: o.tittel ?? '',
          status: o.status,
          innhold_min: innholdMin(o),
          funksjon: funksjonFor(o),
          eier_filer: o.eier_filer ?? [],
        })),
      });
    }
  }
  return ut;
}

/** Ny, ledig id for en pakke: prosjektets første prefiks + «S<n>» (A-S1), ellers SAMLE-<n>. */
function samleId(pid, register, brukt) {
  const pre = register?.[pid]?.prefikser?.[0];
  const base = pre ? (/[-._]$/.test(pre) ? pre : `${pre}-`) : 'SAMLE-';
  for (let n = 1; ; n++) {
    const id = `${base}S${n}`;
    if (!brukt.has(id)) return id;
  }
}

/**
 * Forslag til pakker for gruppene som er klare (`ko.mjs samle pakk --auto`). Innen en gruppe fylles pakkene i
 * gruppens rekkefølge (funksjon, id) opp mot øvre mål; en pakke lukkes når neste oppgave ville passert øvre mål og
 * pakken har nådd nedre mål. En rest under nedre mål blir liggende i samlekøen. Oppgaver med ulike åpne eierspørsmål
 * pakkes aldri sammen. En «pakke» med én oppgave som alene har nådd målet, foreslås tatt ut av samlekøen (`ut: true`).
 * Deterministisk; endrer ingenting.
 * @returns {{ id: string|null, pid: string, klasse: string, deler: string[], sum: number, ut: boolean }[]}
 */
function samleForslag(ko) {
  const register = ko.prosjekter ?? {};
  const perId = new Map((ko.oppgaver ?? []).map((o) => [o.id, o]));
  const brukt = new Set(perId.keys());
  const ut = [];
  for (const g of samleGrupper(ko)) {
    if (!g.klar || g.ugyldig) continue;
    // Del på åpne eierspørsmål (normalt ingen: samlekøen tar ikke imot slike), i første forekomsts rekkefølge.
    const perSp = new Map();
    for (const r of g.oppgaver) {
      const k = aapneSporsmal(perId.get(r.id), ko.avklart).join(',');
      if (!perSp.has(k)) perSp.set(k, []);
      perSp.get(k).push(r);
    }
    for (const rader of perSp.values()) {
      const pakker = [];
      let cur = { deler: [], sum: 0 };
      for (const r of rader) {
        if (cur.deler.length && cur.sum + r.innhold_min > g.maal.maks && cur.sum >= g.maal.min) {
          pakker.push(cur);
          cur = { deler: [], sum: 0 };
        }
        cur.deler.push(r.id);
        cur.sum += r.innhold_min;
      }
      if (cur.deler.length && cur.sum >= g.maal.min) pakker.push(cur);
      for (const p of pakker) {
        const alene = p.deler.length === 1;
        const id = alene ? null : samleId(g.pid, register, brukt);
        if (id) brukt.add(id);
        ut.push({ id, pid: g.pid, klasse: g.klasse, deler: p.deler, sum: p.sum, ut: alene });
      }
    }
  }
  return ut;
}

/**
 * Pakker oppgavene `ider` til ett nytt spor `nyId` (`ko.mjs samle pakk`). ALT ELLER INGENTING: alt sjekkes før noe
 * endres, og ved feil er `ko` urørt. Krav: minst to oppgaver, alle venter (eller forslag), samme klasse (K og D blandes
 * dermed aldri), ikke D+, like åpne eierspørsmål, ny id ledig og gyldig, og ingen syklus (en del kan ikke avhenge av
 * noe som selv venter på en annen del). Feltene slås sammen: innhold_min sum, nytte og migr_tiere maks, avhenger
 * union minus delene, eier_filer/eier_db/delt_patch/krever/etiketter/venter_paa union, prosjekt/funksjon/domene felles
 * eller første, kilde «id: kilde | …», `sammenslatt_fra`. Originalene blir `kansellert` med merknad «slått sammen i
 * <nyId>», og `avhenger` i alle andre åpne oppgaver pekes om til den nye. Status: venter når alle delene venter,
 * ellers forslag. Oppdragsfila skriver kalleren (samleOppdragTekst).
 * @param {{ nyId: string, tittel?: string, oppdrag: string, av?: string, naa?: string }} valg
 * @returns {{ feil: string[] } | { feil: [], ny: object, kansellert: string[], omdirigert: string[] }}
 */
function samlePakk(ko, ider, { nyId, tittel, oppdrag, av, naa = new Date().toISOString() } = {}) {
  const oppgaver = ko.oppgaver ?? [];
  const register = ko.prosjekter ?? {};
  const perId = new Map(oppgaver.map((o) => [o.id, o]));
  const feil = [];
  const liste = [...(ider ?? [])];
  if (new Set(liste).size !== liste.length) feil.push('samme id står flere ganger');
  if (liste.length < 2)
    feil.push(
      'pakk krever minst to oppgaver (én oppgave tas ut med ko.mjs endre <id> --json \'{"samles":false}\')',
    );
  if (!nyId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(nyId))
    feil.push('--id <ny-id> mangler eller har ugyldige tegn');
  else if (perId.has(nyId)) feil.push(`id ${nyId} finnes fra før`);
  const deler = [];
  for (const id of liste) {
    const o = perId.get(id);
    if (!o) feil.push(`ukjent oppgave ${id}`);
    else if (erEksternRad(o)) feil.push(`${id} er en registrering utenfor køen`);
    else if (o.status !== 'venter' && o.status !== 'forslag')
      feil.push(`${id} har status ${o.status} (bare ventende oppgaver og forslag kan pakkes)`);
    else deler.push(o);
  }
  if (deler.some((o) => o.klasse === 'D+')) feil.push('D+ slås aldri sammen med annet');
  const klasser = [...new Set(deler.map((o) => o.klasse))];
  if (klasser.length > 1)
    feil.push(`ulike klasser (${klasser.join(', ')}); K og D (og U) pakkes aldri sammen`);
  const spSett = [...new Set(deler.map((o) => aapneSporsmal(o, ko.avklart).join(',')))];
  if (spSett.length > 1)
    feil.push(
      `ulike åpne eierspørsmål (${deler.map((o) => `${o.id}: ${aapneSporsmal(o, ko.avklart).join(', ') || 'ingen'}`).join('; ')}); slike pakkes aldri sammen`,
    );
  if (feil.length) return { feil };

  const delIder = new Set(liste);
  const avhenger = unionFelt(deler, 'avhenger').filter((d) => !delIder.has(d) && d !== nyId);
  // Syklus: en ekstern forgjenger som selv (transitivt) venter på en av delene, ville ventet på det nye sporet.
  const barn = barnKart(oppgaver);
  const etter = new Set(liste.flatMap((id) => etterfolgere(id, oppgaver, barn)));
  const sykel = avhenger.filter((d) => etter.has(d));
  if (sykel.length)
    return {
      feil: [
        `ville gitt en syklus: ${sykel.join(', ')} venter selv på en av delene; pakk dem sammen eller del annerledes`,
      ],
    };

  const forste = deler[0];
  const pider = deler.map((o) => prosjektFor(o, register));
  const kilder = deler.filter((o) => o.kilde).map((o) => `${o.id}: ${o.kilde}`);
  const ny = {
    nytte: Math.max(...deler.map((o) => Number(o.nytte ?? 5))),
    innhold_min: deler.reduce((s, o) => s + innholdMin(o), 0),
    migr_tiere: Math.max(...deler.map((o) => Number(o.migr_tiere ?? 0))),
    avhenger,
    venter_paa: unionFelt(deler, 'venter_paa'),
    eier_filer: unionFelt(deler, 'eier_filer'),
    eier_db: unionFelt(deler, 'eier_db'),
    delt_patch: unionFelt(deler, 'delt_patch'),
    id: nyId,
    tittel:
      String(tittel ?? '').trim() ||
      `Samlet spor (${deler.length}): ${deler.map((o) => o.tittel ?? o.id).join(' + ')}`,
    domene: fellesEllerForste(deler.map((o) => o.domene)),
    prosjekt: pider[0],
    klasse: forste.klasse,
    oppdrag,
    ...(kilder.length ? { kilde: kilder.join(' | ') } : {}),
    lagt_til_av: av ?? 'ko.mjs samle pakk',
    sammenslatt_fra: liste,
  };
  const funksjon = fellesEllerForste(
    deler.map((o) => (typeof o.funksjon === 'string' ? o.funksjon.trim() : null)),
  );
  if (funksjon) ny.funksjon = funksjon;
  for (const felt of ['krever', 'etiketter']) {
    const u = unionFelt(deler, felt);
    if (u.length) ny[felt] = u;
  }
  if (ny.prosjekt === UTEN_PROSJEKT) delete ny.prosjekt;
  ny.status = deler.every((o) => o.status === 'venter') ? 'venter' : 'forslag';
  ny.lagt_til = naa;
  // Samme validering som add (uten oppgavene som kanselleres i samme skriving).
  const vf = valider(ny, oppgaver, register);
  if (vf.length) return { feil: vf.map((f) => `${nyId}: ${f}`) };

  // ---- Utfør (alt er sjekket) ----
  for (const o of deler) {
    o.status = 'kansellert';
    o.merknader = [...(o.merknader ?? []), `${naa} slått sammen i ${nyId}`];
  }
  const omdirigert = [];
  for (const o of oppgaver) {
    if (delIder.has(o.id) || !aapenOppgave(o) || !(o.avhenger ?? []).some((d) => delIder.has(d)))
      continue;
    const nye = [];
    for (const d of o.avhenger) {
      const x = delIder.has(d) ? nyId : d;
      if (!nye.includes(x)) nye.push(x);
    }
    o.avhenger = nye;
    omdirigert.push(o.id);
  }
  ko.oppgaver.push(ny);
  return { feil: [], ny, kansellert: liste, omdirigert };
}

/**
 * Oppdragsfila for et pakket spor: innledning (rekkefølge, commit per del, unionen står i køoppgaven) og hver dels
 * opprinnelige sporbeskrivelse i sin helhet. `tekster`: id → { tekst, sti } (sti = oppdragsfila delen kom fra, eller
 * null når oppdraget var tekst i køfila).
 */
function samleOppdragTekst(ny, deler, tekster, naa = new Date().toISOString()) {
  const dato = String(naa).slice(0, 10);
  const linjer = [
    `# ${ny.id}: sammenslått spor (${deler.length} deler, ${ny.klasse}, ca. ${ny.innhold_min} innholdsminutter)`,
    '',
    `Sammenslått spor av ${deler.map((o) => o.id).join(', ')} (samlekøen, ko.mjs samle pakk ${dato}, for å spare fast ` +
      'overhead per spor). Gjør dem i denne rekkefølgen, og commit per del (commit-meldingen nevner del-id-en, f.eks. ' +
      `«${deler[0].id}: …»). Hver del under er den opprinnelige sporbeskrivelsen uendret; «Avhenger av» inne i delene ` +
      'som peker til en annen del i dette sporet, er oppfylt ved at du gjør delene i rekkefølge. Eierfiler, eier-DB og ' +
      `avhengigheter for hele sporet er unionen av delene (står i køoppgaven ${ny.id}). Rapporter per del til slutt.`,
    '',
    'Rekkefølge:',
    ...deler.map(
      (o, i) => `${i + 1}. ${o.id}: ${o.tittel ?? ''} (${o.klasse}, ${innholdMin(o)} min)`,
    ),
    '',
  ];
  for (const o of deler) {
    const t = tekster.get(o.id) ?? { tekst: '', sti: null };
    linjer.push(
      '',
      '---',
      '',
      `## Del ${o.id}: ${o.tittel ?? ''}`,
      '',
      t.sti
        ? `(Opprinnelig oppdragsfil: \`${t.sti}\`)`
        : '(Opprinnelig oppdrag sto som tekst i køfila.)',
      '',
      String(t.tekst ?? '').trimEnd(),
      '',
    );
  }
  return linjer.join('\n');
}

// ---- Orkestratorens rutine som skript og kost per oppgave -----
//
// `vis` (kort som standard), `fyll`, `motta`, `sett <id> ferdig` og `kost` i ko.mjs. Her står bare den rene delen: den
// korte visningen, agenttype og agentmelding, innholdet i review-pakken, parserne for RESULTAT- og FUNN-linja, hvilke
// agenter i tidsloggen som hører til en oppgave, og summen av kosten. Git, transkriptene og tidsloggen leses i ko.mjs.
// Testet i lib/__tests__/koOrkestrator.test.ts.

const TK = require('./tidKost.js');

/** Agenttypen for et spor etter klasse: D og D+ på `spor-d` (high), K og U på `spor` (medium). */
function agentTypeFor(klasse) {
  return klasse === 'D' || klasse === 'D+' ? 'spor-d' : 'spor';
}

/** Standard reviewere per klasse (subagent_type); installasjonen leverer .claude/agents/reviewer*.md. */
const STANDARD_REVIEWERE = { D: ['reviewer'], 'D+': ['reviewer', 'reviewer-sikkerhet'] };

/**
 * Reviewer-oppsettet: konfig().reviewere (klasse → liste med subagent_type), ellers standarden. En klasse som ikke
 * står i oppsettet, får ingen review (K og U som standard).
 */
function reviewerOppsett() {
  const r = kfg().reviewere;
  return r && typeof r === 'object' && !Array.isArray(r) ? r : STANDARD_REVIEWERE;
}

/** Reviewerne etter klasse: standard K og U ingen, D `reviewer`, D+ også `reviewer-sikkerhet`. */
function reviewereFor(klasse) {
  const liste = reviewerOppsett()[klasse];
  return Array.isArray(liste) ? liste.map(String).filter(Boolean) : [];
}

/** Alle reviewer-typene i oppsettet (unike, i rekkefølge). */
function reviewerTyper() {
  const ut = [];
  for (const liste of Object.values(reviewerOppsett()))
    for (const t of Array.isArray(liste) ? liste : []) if (!ut.includes(String(t))) ut.push(String(t));
  return ut;
}

/**
 * Den korte meldingen orkestratoren starter sporagenten med; oppdraget står i prompt-fila. «spor <id>» og
 * «prompt-<id>.md» i teksten er det tidKost.sporFraTekst kjenner sporet igjen på (kosten per oppgave).
 */
function sporMelding(id, promptSti) {
  return (
    `Du er spor ${id} i arbeidskøen (kontinuerlig kø, bølge «ko»). Oppdraget ditt står i ${promptSti} og er ` +
    'bindende: les det først og følg protokollen der. Svaret ditt til orkestratoren er høyst ca. 1 500 tegn: ' +
    'RESULTAT-linja først, høyst 5 linjer, så stien til rapport.md (det lange står der).'
  );
}

/** Oppsummeringslinja under `vis` (samme i kort og full visning). `t` er koLogikk.tilstand. */
function tilstandLinje(t) {
  return (
    `${t.aktive} aktive · ${t.plukket ? `${t.plukket} plukket · ` : ''}${t.venter} venter · ${t.forslag} forslag · ` +
    `${t.kanStarte} kan startes nå` +
    `${t.samles ? ` · ${t.samles} i samlekøen (ko.mjs samle)` : ''}` +
    `${t.qa ? ` · ${t.qa} i QA-lista (ko.mjs qa)` : ''}${t.ekstern ? ` · ${t.ekstern} utenfor køen (ko.mjs ekstern)` : ''}` +
    `${t.parkert ? ` · ${t.parkert} parkert (ko.mjs fortsett)` : ''}` +
    `${t.fokus?.varsel ? ' · FOKUSVARSEL (ko.mjs fokus)' : ''}` +
    `${t.tom ? ' · KØEN ER TOM FOR ARBEID' : ''}`
  );
}

const KORT_STATUSER = ['kjorer', 'review', 'plukket'];

/**
 * `ko.mjs vis` (kort, standard for orkestratoren): én linje per aktiv oppgave (kjorer, review, plukket) og per
 * oppgave som kan startes nå, så tellingene. Målet er under ca. 3 000 tegn (den fulle tabellen var ca. 66 000 tegn,
 * ca. 20 000 tokens per kall). Den fulle står bak `vis --full`.
 * @param {object} ko køen
 * @param {{ naa?: number, ucommittet?: string[], dagsforbruk?: number, bredde?: number }} [valg]
 * @returns {string[]} linjene
 */
function kortVisning(
  ko,
  { naa = Date.now(), ucommittet = [], dagsforbruk, bredde = 110, markor = null } = {},
) {
  const oppgaver = ko.oppgaver ?? [];
  const kutt = (s) => (s.length > bredde ? `${s.slice(0, bredde - 1)}…` : s);
  const ut = [];

  const aktive = oppgaver.filter((o) => KORT_STATUSER.includes(o.status) && !erEksternRad(o));
  ut.push(`AKTIVE (${aktive.length}):`);
  for (const o of aktive) {
    // Alder: i review siden levering, plukket siden plukking, ellers siden start.
    const fra =
      o.status === 'plukket'
        ? o.plukket_at
        : o.status === 'review'
          ? (o.levert ?? o.startet)
          : o.startet;
    const alder = fra ? alderTekst(naa - Date.parse(fra)) : '?';
    const hvem = o.status === 'plukket' ? ` av ${o.plukket_av ?? '?'}` : '';
    ut.push(
      kutt(
        `  ${o.id.padEnd(12)} ${o.status.padEnd(7)} ${String(o.klasse).padEnd(2)} ${alder.padEnd(10)} ` +
          `migr ${o.migr_blokk ?? '-'}${hvem}  ${o.tittel ?? ''}`,
      ),
    );
  }

  const vakt = startVakt(ko, dagsforbruk, { naa, markor });
  const startbare = vakt ? [] : velgNeste(ko, naa, { ucommittet });
  ut.push(
    `STARTBARE NÅ (${startbare.length}${startbare.length ? '; ko.mjs fyll starter dem' : ''}):`,
  );
  for (const v of startbare) {
    const o = oppgaver.find((x) => x.id === v.id);
    ut.push(
      kutt(
        `  ${v.id.padEnd(12)} ${v.klasse.padEnd(2)} ${String(v.domene).padEnd(12)} ${`${v.anslag} min`.padEnd(8)} ` +
          `prio ${v.score}${'steg' in v ? ` ${stegTekst(v)}` : ''}  ${o?.tittel ?? ''}`,
      ),
    );
  }
  if (vakt) ut.push(kutt(`  ${vakt.melding}`));

  const t = tilstand(ko, dagsforbruk, { ucommittet, naa, markor });
  // Fokuslinja og varselet (bare når fokus er satt).
  if (t.fokus) {
    ut.push(kutt(`FOKUS${t.fokus.navn ? ` «${t.fokus.navn}»` : ''}: ${t.fokus.tekst}`));
    if (t.fokus.aktiv)
      ut.push(
        kutt(
          `  ${t.fokus.klare} klare i fokus · ${t.fokus.i_fokus} venter i fokus · ${t.fokus.pagar} pågår · ` +
            `${t.fokus.dratt_med} dratt med`,
        ),
      );
    if (t.fokus.varsel) ut.push(kutt(`  ${t.fokus.varsel}`));
  }
  const venter = oppgaver.filter((o) => o.status === 'venter' && !erSamles(o));
  const perKlasse = Object.keys(VEKT)
    .map((k) => [k, venter.filter((o) => o.klasse === k).length])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');
  ut.push('', tilstandLinje(t));
  if (venter.length)
    ut.push(
      `Venter per klasse: ${perKlasse}; ${t.blokkert.length} av dem er hindret nå (se vis --full).`,
    );
  const samle = samleGrupper(ko);
  if (samle.length) {
    const n = samle.reduce((s, g) => s + g.antall, 0);
    const klare = samle.filter((g) => g.klar).length;
    ut.push(
      `SAMLEKØEN (${n} oppgave(r) i ${samle.length} gruppe(r)${klare ? `, ${klare} klar(e) til pakking` : ''}; ` +
        'ko.mjs samle)',
    );
  }
  if (t.eiersporsmal.length)
    ut.push(
      kutt(
        `Eierspørsmål som låser opp flest: ${t.eiersporsmal
          .slice(0, 5)
          .map((s) => `${s.sp} (${s.oppgaver})`)
          .join(' · ')}`,
      ),
    );
  if (!vakt) {
    const b = budsjettVakt(ko, dagsforbruk);
    if (b.aktiv && b.melding) ut.push(kutt(b.melding));
    const n = nattVakt(ko, naa);
    if (n.aktiv && n.melding) ut.push(kutt(n.melding));
  }
  ut.push('Full liste: ko.mjs vis --full (eller --alle, --gruppert, --prosjekt <pid>).');
  return ut;
}

// ---- RESULTAT- og FUNN-linja ------------------------------------------------------------------------------

/**
 * Finner den første linja som starter med `ord` (RESULTAT eller FUNN). Tolerant: markdown-tegn (`*`, backtick, `>`,
 * `#`, `-`) rundt linja og et kolon etter ordet godtas.
 * @returns {{ linje: string, rest: string } | null}
 */
function fastLinje(tekst, ord) {
  for (const raa of String(tekst ?? '').split(/\r?\n/)) {
    const l = raa
      .replace(/[`*]/g, '')
      .replace(/^[\s>#-]+/, '')
      .trim();
    if (l === ord || l.startsWith(`${ord} `) || l.startsWith(`${ord}:`))
      return {
        linje: l,
        rest: l.slice(ord.length).replace(/^:/, '').trim(),
      };
  }
  return null;
}

/** `nøkkel=verdi`-parene i resten av en fast linje; nøklene med små bokstaver. */
function nokkelVerdier(rest) {
  const ut = {};
  for (const m of String(rest).matchAll(/([A-Za-zÆØÅæøå_]+)=(\S*)/g)) ut[m[1].toLowerCase()] = m[2];
  return ut;
}

const tallEllerNull = (v) => (v != null && /^\d+$/.test(v) ? Number(v) : null);

/**
 * Sporets RESULTAT-linje, f.eks. `RESULTAT status=FERDIG gren=ko/X commits=3 migr=3490-3492 gater=OK
 * probe=rød→grønn(12/12) eierspm=0 edge=-` (`probe`: testene rød før og grønn etter; `edge`: deploy etter
 * flettingen, `-` = ingen). Mangler linja: null (kalleren faller tilbake til dagens oppførsel).
 * @returns {null | { linje: string, status: string|null, gren: string|null, commits: number|null, migr: string|null,
 *   gater: string|null, probe: string|null, eierspm: number|null, edge: string|null, ekstra: object }}
 */
function parseResultat(tekst) {
  const f = fastLinje(tekst, 'RESULTAT');
  if (!f) return null;
  const kv = nokkelVerdier(f.rest);
  const kjente = ['status', 'gren', 'commits', 'migr', 'gater', 'probe', 'eierspm', 'edge'];
  const ekstra = {};
  for (const [k, v] of Object.entries(kv)) if (!kjente.includes(k)) ekstra[k] = v;
  return {
    linje: f.linje,
    status: kv.status ? kv.status.toUpperCase() : null,
    gren: kv.gren ?? null,
    commits: tallEllerNull(kv.commits),
    migr: kv.migr ?? null,
    gater: kv.gater ?? null,
    probe: kv.probe ?? null,
    eierspm: tallEllerNull(kv.eierspm),
    edge: kv.edge ?? null,
    ekstra,
  };
}

/**
 * Reviewerens FUNN-linje, f.eks. `FUNN H=0 M=1 L=3 utsettbare=L2,L3`. Mangler linja: null. Et tall som mangler,
 * blir 0 når minst ett av H/M/L står der.
 * @returns {null | { linje: string, H: number, M: number, L: number, utsettbare: string[] }}
 */
function parseFunn(tekst) {
  const f = fastLinje(tekst, 'FUNN');
  if (!f) return null;
  const kv = nokkelVerdier(f.rest);
  const h = tallEllerNull(kv.h);
  const m = tallEllerNull(kv.m);
  const l = tallEllerNull(kv.l);
  if (h == null && m == null && l == null) return null;
  const u = String(kv.utsettbare ?? '').trim();
  return {
    linje: f.linje,
    H: h ?? 0,
    M: m ?? 0,
    L: l ?? 0,
    utsettbare:
      !u || u === '-'
        ? []
        : u
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
  };
}

/** Summen av reviewrapportenes FUNN-linjer (én per reviewer og runde). Ingen linjer: null. */
function samleFunn(liste) {
  const gyldige = (liste ?? []).filter(Boolean);
  if (!gyldige.length) return null;
  const ut = { H: 0, M: 0, L: 0, utsettbare: [], rapporter: gyldige.length };
  for (const f of gyldige) {
    ut.H += f.H;
    ut.M += f.M;
    ut.L += f.L;
    for (const x of f.utsettbare) if (!ut.utsettbare.includes(x)) ut.utsettbare.push(x);
  }
  return ut;
}

// ---- Transkriptene (sporets og reviewerens siste svar) ----------------------------------------------------------

/** Linjene i et agenttranskript (JSONL) som objekter; ødelagte linjer hoppes over. */
function transkriptRader(tekst) {
  const ut = [];
  for (const l of String(tekst ?? '').split('\n')) {
    if (!l.trim()) continue;
    try {
      ut.push(JSON.parse(l));
    } catch {
      /* halv linje (transkriptet skrives mens vi leser) */
    }
  }
  return ut;
}

/**
 * Agentens siste svar: den siste teksten fra assistenten, eller meldingen i et SubagentHandback-kall (rapporten
 * leveres slik når agenten har det verktøyet). Null når transkriptet ikke har noe svar.
 */
function sisteSvar(tekst) {
  let siste = null;
  for (const r of transkriptRader(tekst)) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    for (const c of r.message.content) {
      if (c?.type === 'text' && String(c.text ?? '').trim()) siste = c.text;
      else if (c?.type === 'tool_use' && c.name === 'SubagentHandback' && c.input?.message)
        siste = c.input.message;
    }
  }
  return siste;
}

/** Den første brukermeldingen i et transkript (oppdraget agenten fikk). */
function forsteBrukermelding(tekst) {
  for (const r of transkriptRader(tekst)) {
    if (r.type !== 'user' || !r.message) continue;
    const m = r.message.content;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.map((c) => c?.text ?? '').join(' ');
  }
  return null;
}

/**
 * Nevner teksten oppgave-id-en som eget ord? `A-1b` finnes i «ko/A-1b» og «A-1b-r2», men ikke i «A-1b2» eller
 * «XA-1b».
 */
function nevnerOppgave(tekst, id) {
  return new RegExp(`(^|[^A-Za-z0-9-])${regexTrygg(id)}(?![A-Za-z0-9])`).test(String(tekst ?? ''));
}

// ---- Kost per oppgave ---------------------------------------------------------------------------------------

/** Agenttypene som regnes til en oppgave: sporene og reviewerne (fra oppsettet). */
const oppgaveAgenttyper = () => ['spor', 'spor-d', ...reviewerTyper()];

/**
 * Agentene i tidsloggen (konfig().tidslogg, skrevet av hook-tid.mjs fra transkriptene) som hører til
 * oppgaven. `sikre`: spor-etiketten er oppgaven eller en retterunde av den (tidKost.oppgaveIdFor). `usikre`: agenter
 * uten gjenkjent spor-etikett (etiketten er agent-id-en) av typene spor, spor-d og reviewerne, som stoppet etter `fra`
 * og startet før `til`; kalleren beholder dem bare når oppdraget deres nevner oppgaven (nevnerOppgave).
 * Radene er kumulative; den siste raden med tokens per agent er agentens totale forbruk.
 * @returns {{ sikre: {agent: string, type: string, rad: object}[], usikre: {agent: string, type: string, rad: object}[] }}
 */
function agenterForOppgave(rader, id, { fra = null, til = null } = {}) {
  const siste = new Map();
  const forste = new Map();
  const typer = new Map();
  for (const r of rader ?? []) {
    if (!r?.agent_id) continue;
    const t = Date.parse(r.tid);
    if (!forste.has(r.agent_id) || t < forste.get(r.agent_id)) forste.set(r.agent_id, t);
    if (r.agent_type) typer.set(r.agent_id, r.agent_type);
    if (r.hendelse !== 'ferdig' || !r.tokens) continue;
    const f = siste.get(r.agent_id);
    if (!f || t >= Date.parse(f.tid)) siste.set(r.agent_id, r);
  }
  const erId = (s) => s === id;
  const sikre = [];
  const usikre = [];
  for (const [agent, rad] of siste) {
    const type = typer.get(agent) ?? 'ukjent';
    const spor = rad.spor ?? null;
    if (spor && TK.oppgaveIdFor(spor, erId) === id) {
      sikre.push({ agent, type, rad });
      continue;
    }
    const ukjentSpor = !spor || agent.startsWith(spor);
    if (!ukjentSpor || !oppgaveAgenttyper().includes(type)) continue;
    if (fra && Date.parse(rad.tid) < Date.parse(fra)) continue;
    if (til && forste.get(agent) > Date.parse(til)) continue;
    usikre.push({ agent, type, rad });
  }
  return { sikre, usikre };
}

const rund2 = (x) => Math.round(x * 100) / 100;

/**
 * Summen av forbruket til agentene som hørte til oppgaven. Hver agent har `tokens` og `modell` fra transkriptet
 * (tidKost.analyserTranskript) eller fra den siste raden i tidsloggen; prisen er tidKost.kostUsd (API-ekvivalente USD).
 * @param {{ agent: string, type: string, tokens: object, modell?: string|null, turer?: number, kilde?: string }[]} agenter
 * @returns {{ usd: number, tokens: { input: number, output: number, cache_lest: number, cache_skrevet: number,
 *   sum: number }, turer: number, agenter: { agent: string, type: string, usd: number, kilde: string }[],
 *   maalt: string }}
 */
function summerKost(agenter, naa = new Date().toISOString()) {
  const tokens = { input: 0, output: 0, cache_lest: 0, cache_skrevet: 0, sum: 0 };
  let usd = 0;
  let turer = 0;
  const liste = [];
  for (const a of agenter ?? []) {
    const u = TK.kostUsd(a.tokens, a.modell ?? undefined);
    usd += u;
    turer += Number(a.turer ?? 0) || 0;
    for (const k of ['input', 'output', 'cache_lest', 'cache_skrevet']) {
      const n = Number(a.tokens?.[k] ?? 0) || 0;
      tokens[k] += n;
      tokens.sum += n;
    }
    liste.push({ agent: a.agent, type: a.type, usd: rund2(u), kilde: a.kilde ?? 'tidslogg' });
  }
  return { usd: rund2(usd), tokens, turer, agenter: liste, maalt: naa };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Statistikken `ko.mjs kost` viser: ferdige oppgaver med målt kost (siden `siden`), per klasse og totalt, med funn
 * fra reviewen.
 * @returns {{ rader: object[], perKlasse: object[], total: { n: number, usd: number } }}
 */
function kostStatistikk(ko, { siden = null } = {}) {
  const rader = (ko.oppgaver ?? [])
    .filter((o) => o.status === 'ferdig' && o.kost && Number.isFinite(Number(o.kost.usd)))
    .filter((o) => !siden || Date.parse(o.ferdig ?? o.kost.maalt) >= Date.parse(siden))
    .map((o) => ({
      id: o.id,
      klasse: o.klasse,
      ferdig: o.ferdig ?? null,
      usd: Number(o.kost.usd),
      tokens: Number(o.kost.tokens?.sum ?? 0),
      agenter: (o.kost.agenter ?? []).length,
      funn: o.funn ?? null,
      resultat: o.resultat?.status ?? null,
    }))
    .sort((a, b) => String(b.ferdig).localeCompare(String(a.ferdig)));
  const perKlasse = Object.keys(VEKT)
    .map((klasse) => {
      const r = rader.filter((x) => x.klasse === klasse);
      const medFunn = r.filter((x) => x.funn);
      return {
        klasse,
        n: r.length,
        usd: rund2(r.reduce((s, x) => s + x.usd, 0)),
        median_usd: r.length ? rund2(median(r.map((x) => x.usd))) : null,
        reviewet: medFunn.length,
        H: medFunn.reduce((s, x) => s + x.funn.H, 0),
        M: medFunn.reduce((s, x) => s + x.funn.M, 0),
        L: medFunn.reduce((s, x) => s + x.funn.L, 0),
      };
    })
    .filter((k) => k.n > 0);
  return {
    rader,
    perKlasse,
    total: { n: rader.length, usd: rund2(rader.reduce((s, x) => s + x.usd, 0)) },
  };
}

// ---- Review-pakken (`ko.mjs motta`) -------------------------------------------------------------------------------

/**
 * Hvilke filer pakken får i full versjon fra grenen. `nameStatus` er `git diff --name-status --no-renames`, `numstat`
 * er `git diff --numstat --no-renames` (binære filer har «-» i tallene). Slettede og binære filer hoppes over.
 * @returns {{ kopier: string[], hoppet: { sti: string, grunn: string }[] }}
 */
function pakkeFiler(nameStatus, numstat) {
  const binaer = new Set();
  for (const l of String(numstat ?? '').split(/\r?\n/)) {
    const m = l.match(/^-\t-\t(.+)$/);
    if (m) binaer.add(m[1]);
  }
  const kopier = [];
  const hoppet = [];
  for (const l of String(nameStatus ?? '').split(/\r?\n/)) {
    const m = l.match(/^([A-Z])\d*\t(.+)$/);
    if (!m) continue;
    const [, s, sti] = m;
    if (s === 'D') hoppet.push({ sti, grunn: 'slettet' });
    else if (binaer.has(sti)) hoppet.push({ sti, grunn: 'binær' });
    else kopier.push(sti);
  }
  return { kopier, hoppet };
}

/**
 * Endrede DB-objekter i diffen: `create`/`alter`/`drop` av funksjon, tabell, policy, trigger, view, indeks og type på
 * nye linjer i .sql-filer under migrasjonsmappa (konfig().migrasjoner.mappe). Policyer får tabellen med når den står
 * på samme linje. Uten migrasjonsmappe: tom liste.
 * @param {string} diff
 * @param {{ mappe?: string|null }} [migrasjoner]
 * @returns {string[]} f.eks. «create function public.foo», «create policy "les" on public.bar»
 */
function dbObjekterFraDiff(diff, migrasjoner = kfg().migrasjoner) {
  const mappe = migrasjoner?.mappe
    ? String(migrasjoner.mappe).replace(/\\/g, '/').replace(/\/+$/, '')
    : null;
  if (!mappe) return [];
  const filRe = new RegExp(`^${regexTrygg(mappe)}/.+\\.sql$`);
  const ut = [];
  let fil = null;
  const re =
    /^\+\s*(create|alter|drop)\s+(?:or\s+replace\s+)?(?:unique\s+)?(function|procedure|table|policy|trigger|materialized\s+view|view|index|type)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:concurrently\s+)?("[^"]+"|[\w.]+(?:\."[^"]+")?)(.*)$/i;
  for (const l of String(diff ?? '').split(/\r?\n/)) {
    if (l.startsWith('+++ ')) {
      fil = l.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    if (!fil || !filRe.test(fil) || l.startsWith('+++')) continue;
    const m = l.match(re);
    if (!m) continue;
    const type = m[2].toLowerCase().replace(/\s+/g, ' ');
    let navn = `${m[1].toLowerCase()} ${type} ${m[3]}`;
    if (type === 'policy') {
      const on = m[4].match(/\bon\s+([\w."]+)/i);
      if (on) navn += ` on ${on[1]}`;
    }
    if (!ut.includes(navn)) ut.push(navn);
  }
  return ut;
}

/**
 * Indeksfila i review-pakken (`00-pakke.md`): hva oppgaven er, sporets RESULTAT-linje, diff-statistikken, endrede
 * DB-objekter og hvilke filer som ligger i pakken. Pakken er VANLIGE FILER (en reviewer uten Bash kan ikke lese
 * git-objekter).
 */
function reviewPakkeIndeks({
  o,
  gren,
  stat,
  dbObjekter = [],
  kopiert = [],
  hoppet = [],
  resultat = null,
  filer = {},
  base = baseGren(),
  migrMappe = kfg().migrasjoner?.mappe ?? null,
}) {
  const linjer = [
    `# Review-pakke ${o.id} (${o.klasse}): ${o.tittel ?? ''}`,
    '',
    `Gren \`${gren}\`, diff mot \`${base}\` (merge-base).` +
      (migrMappe ? ` Migrasjonsblokk: ${o.migr_blokk ?? 'ingen'}.` : ''),
    `Sporets resultatlinje: ${resultat ? `\`${resultat.linje}\`` : '(mangler; se sporets svar og rapport)'}`,
    '',
    '## Filene i pakken',
    '',
    `- \`diff.patch\`: hele diffen (\`git diff ${base}...<gren>\`).`,
    `- \`filer/\`: ${kopiert.length} endrede fil(er) i full versjon fra grenen (samme stier som i repoet).`,
  ];
  if (filer.sporsvar)
    linjer.push('- `sporsvar.md`: sporets siste svar (rapporten til orkestratoren).');
  if (filer.rapport)
    linjer.push('- `sporrapport.md`: sporets `rapport.md` (selv-review, testkjøring, koblinger).');
  if (filer.overlevering) linjer.push('- `overlevering.md`: overleveringen fra et DELVIS-spor.');
  if (hoppet.length)
    linjer.push(`- Ikke med: ${hoppet.map((h) => `\`${h.sti}\` (${h.grunn})`).join(', ')}.`);
  if (migrMappe) {
    linjer.push('', '## Endrede DB-objekter', '');
    if (dbObjekter.length) for (const d of dbObjekter) linjer.push(`- ${d}`);
    else linjer.push(`- (ingen i ${migrMappe})`);
  }
  linjer.push('', '## Diff-statistikk', '', '```', String(stat ?? '').trimEnd(), '```', '');
  return linjer.join('\n');
}

/** Den korte reviewer-prompten. «spor <id>» i teksten knytter reviewerens kost til oppgaven. */
function reviewerPrompt({ o, type, mappe }) {
  const sep = String(mappe).includes('\\') ? '\\' : '/';
  return [
    `Du er ${type} for spor ${o.id} (klasse ${o.klasse}, gren ${o.gren ?? koGren(o.id)}) i arbeidskøen.`,
    `Les review-pakken: ${mappe}${sep}00-pakke.md først, så diff.patch og filene under filer${sep} (full versjon fra`,
    'grenen), og sporets svar og rapport når de ligger der. Slå opp i resten av repoet bare for et konkret',
    'spørsmål, med grep -n og utdrag. Høyst ca. 40 turer; still heller spørsmålet i rapporten.',
    'Svaret ditt er høyst ca. 1 500 tegn. Første linje i fast format: FUNN H=<antall> M=<antall> L=<antall>',
    'utsettbare=<funnkoder som kan vente, kommaseparert, eller ->. Så ett kort punkt per H- og M-funn (kode,',
    'fil:linje, fiks), L-funn bare med kode og én setning. Ikke gjengi pakken.',
  ].join('\n');
}

// ---- Masseendring, endringslogg og angre, blokkflytting, forslag til prosjekt ----------------------
//
// Brukt av ko.mjs
// (endre-mange --torr/--forvent-endret, ranger, angre, klassifiser, advarslene i add og prosjekt) og av tavla via
// ko.mjs. Nye, valgfrie felt i ko.json:
//   endringslogg: [{ nr, at, av, handling, endringer: [{ id|pid, felt, for, etter }], angret? }]   de siste 50
//                 skrivingene fra endre, endre-mange, ranger, parker, fortsett, prosjekt og klassifiser. Bare felt som
//                 faktisk endres (id, felt og verdier; ingen personopplysninger). `null` = feltet fantes ikke.
//   prosjekter.<pid>.filrot: [sti]       mapper/filer som kjennetegner prosjektet (signal for klassifiser).
//   prosjekter.<pid>.funksjoner: [navn]  kjente funksjonsnavn (add advarer om nye).

/** Høyst så mange poster i endringsloggen (de eldste faller ut). */
const ENDRINGSLOGG_MAKS = 50;
/** Hvor langt forbi naboen en blokk havner øverst eller nederst (i prioritetspoeng; som koTavle.STEG). */
const RANGER_STEG = 10;
/** Felt som eies av egne kommandoer (sett, start, plukk …) og aldri rulles tilbake av angre. */
const ANGRE_SPERRET = new Set([
  'id',
  'status',
  'startet',
  'ferdig',
  'gren',
  'migr_blokk',
  'plukket_av',
  'plukket_at',
  'lagt_til',
  'ekstern',
  'ekstern_navn',
  'gjort_utenfor_koen',
]);

/** Dyp kopi av en JSON-verdi; undefined blir null. */
function klonJson(x) {
  return x === undefined ? null : JSON.parse(JSON.stringify(x));
}

/** JSON med sorterte nøkler, så to like objekter alltid sammenlignes likt. */
function stabilJson(x) {
  if (Array.isArray(x)) return `[${x.map(stabilJson).join(',')}]`;
  if (x && typeof x === 'object')
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stabilJson(x[k])}`)
      .join(',')}}`;
  return JSON.stringify(x === undefined ? null : x);
}

/** Er to feltverdier like? null og manglende felt er det samme. */
function likVerdi(a, b) {
  return stabilJson(a ?? null) === stabilJson(b ?? null);
}

/**
 * Forskjellen mellom to utgaver av køen: oppgaver (per id, bare de som finnes i begge) og prosjektregisteret (per pid).
 * Bare felt som faktisk endres. Til forhåndsvisningen (`endre-mange --torr`) og endringsloggen.
 * @returns {{ id?: string, pid?: string, felt: string, for: unknown, etter: unknown }[]}
 */
function masseDiff(forKo, etterKo) {
  const ut = [];
  const forPerId = new Map((forKo?.oppgaver ?? []).map((o) => [o.id, o]));
  for (const o of etterKo?.oppgaver ?? []) {
    const f = forPerId.get(o.id);
    if (!f) continue;
    for (const felt of [...new Set([...Object.keys(f), ...Object.keys(o)])].sort()) {
      if (!likVerdi(f[felt], o[felt]))
        ut.push({
          id: o.id,
          felt,
          for: klonJson(f[felt] ?? null),
          etter: klonJson(o[felt] ?? null),
        });
    }
  }
  const forReg = forKo?.prosjekter ?? {};
  const etterReg = etterKo?.prosjekter ?? {};
  for (const pid of [...new Set([...Object.keys(forReg), ...Object.keys(etterReg)])]) {
    const f = forReg[pid] ?? {};
    const e = etterReg[pid] ?? {};
    for (const felt of [...new Set([...Object.keys(f), ...Object.keys(e)])].sort()) {
      if (!likVerdi(f[felt], e[felt]))
        ut.push({ pid, felt, for: klonJson(f[felt] ?? null), etter: klonJson(e[felt] ?? null) });
    }
  }
  return ut;
}

/** Kort tekst for en verdi i forhåndsvisningen og feilmeldinger. */
function verdiTekst(v, maks = 60) {
  if (v == null) return '(ingen)';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > maks ? `${s.slice(0, maks - 1)}…` : s;
}

/** Linjene i forhåndsvisningen: «A-1 prosjekt: alfa → beta». */
function diffLinjer(endringer, { maks = 200 } = {}) {
  const linjer = (endringer ?? [])
    .slice(0, maks)
    .map(
      (e) =>
        `${e.id ?? `prosjekt ${e.pid}`} ${e.felt}: ${verdiTekst(e.for)} → ${verdiTekst(e.etter)}`,
    );
  if ((endringer ?? []).length > maks) linjer.push(`… og ${endringer.length - maks} til`);
  return linjer;
}

/**
 * Legger en post i endringsloggen (de siste ENDRINGSLOGG_MAKS beholdes). Ingen post når ingenting endret seg.
 * @returns {object|null} posten
 */
function loggEndring(ko, { av = null, handling, endringer, naa = new Date().toISOString() } = {}) {
  if (!Array.isArray(endringer) || !endringer.length) return null;
  const logg = Array.isArray(ko.endringslogg) ? ko.endringslogg : [];
  const nr = logg.reduce((m, p) => Math.max(m, Number(p?.nr) || 0), 0) + 1;
  const post = {
    nr,
    at: naa,
    av: String(av ?? '').trim() || 'ukjent',
    handling: String(handling ?? 'ukjent'),
    endringer: klonJson(endringer),
  };
  logg.push(post);
  ko.endringslogg = logg.slice(-ENDRINGSLOGG_MAKS);
  return post;
}

/** Den siste posten som ikke er angret (den `angre` ruller tilbake), eller null. */
function sisteAngrbare(ko) {
  const logg = Array.isArray(ko?.endringslogg) ? ko.endringslogg : [];
  for (let i = logg.length - 1; i >= 0; i -= 1) if (!logg[i]?.angret) return logg[i];
  return null;
}

/**
 * Ruller tilbake den siste posten i endringsloggen som ikke er angret (ko.mjs angre). Nekter (ingenting endres) når et
 * felt ikke lenger har «etter»-verdien (noen har endret det siden), når en oppgave er borte, eller når resultatet bryter
 * reglene (prosjektet må finnes, bare venter og forslag kan være parkert, samlekøreglene). Posten blir stående, merket
 * `angret`, så loggen viser hva som skjedde; neste angre tar posten før den. `vis` sjekker uten å endre noe.
 * @returns {{ feil: string[], post?: object, vis?: boolean }}
 */
function angrePost(ko, { av = null, naa = new Date().toISOString(), vis = false } = {}) {
  const post = sisteAngrbare(ko);
  if (!post)
    return { feil: ['ingenting å angre (endringsloggen er tom, eller alt i den er angret)'] };
  const oppgaver = klonJson(ko.oppgaver ?? []);
  const register = klonJson(ko.prosjekter ?? {});
  const perId = new Map(oppgaver.map((o) => [o.id, o]));
  const feil = [];
  const berorte = new Set();
  const samlesBerort = new Set();
  const pider = new Set();
  for (const e of post.endringer ?? []) {
    const hvem = e.id ?? `prosjekt ${e.pid}`;
    if (e.id != null && ANGRE_SPERRET.has(e.felt)) {
      feil.push(`${hvem}: ${e.felt} angres ikke (bruk kommandoen som eier feltet)`);
      continue;
    }
    let maal;
    if (e.id != null) {
      maal = perId.get(e.id);
      if (!maal) {
        feil.push(`${e.id}: finnes ikke lenger i køen`);
        continue;
      }
    } else if (e.pid != null) {
      maal = register[e.pid] ?? {};
      register[e.pid] = maal;
      pider.add(e.pid);
    } else {
      feil.push('posten har en endring uten id eller pid');
      continue;
    }
    if (!likVerdi(maal[e.felt], e.etter)) {
      feil.push(
        `${hvem} ${e.felt} er endret siden (nå ${verdiTekst(maal[e.felt])}, posten satte ${verdiTekst(e.etter)})`,
      );
      continue;
    }
    if (e.for == null) delete maal[e.felt];
    else maal[e.felt] = klonJson(e.for);
    if (e.id != null) {
      berorte.add(e.id);
      if (e.felt === 'samles') samlesBerort.add(e.id);
    }
  }
  // Et prosjekt posten opprettet, forsvinner igjen når alle feltene er rullet tilbake.
  const fjernet = [...pider].filter((pid) => !Object.keys(register[pid]).length);
  for (const pid of fjernet) delete register[pid];
  if (!feil.length) {
    for (const pid of pider) {
      if (fjernet.includes(pid)) continue;
      const r = nyttRegister({}, { [pid]: register[pid] }, ko.omrader);
      feil.push(...r.feil);
    }
    for (const o of oppgaver) {
      if (fjernet.includes(o.prosjekt))
        feil.push(`${o.id} bruker prosjektet ${o.prosjekt}, som angre ville fjernet`);
    }
    for (const id of berorte) {
      const o = perId.get(id);
      for (const f of validerNyeFelt(o, register, { strengProsjekt: true }))
        feil.push(`${id}: ${f}`);
      if (o.parkert && o.status !== 'venter' && o.status !== 'forslag')
        feil.push(`${id}: status ${o.status} (bare venter og forslag kan være parkert)`);
      if (samlesBerort.has(id))
        for (const f of samlesFeil(o, oppgaver, ko.avklart)) feil.push(`${id}: ${f}`);
    }
  }
  if (feil.length) return { feil, post };
  if (vis) return { feil: [], post, vis: true };
  ko.oppgaver = (ko.oppgaver ?? []).map((o) => (berorte.has(o.id) ? perId.get(o.id) : o));
  if (pider.size) ko.prosjekter = register;
  post.angret = { at: naa, av: String(av ?? '').trim() || 'ukjent' };
  return { feil: [], post };
}

/**
 * Optimistisk samtidighet (`--forvent-endret <iso>`): null når køen ikke er endret etter tidspunktet tavla (eller en
 * annen kaller) forhåndsviste, ellers feilteksten. Kalles under låsen.
 */
function forventSjekk(ko, forvent) {
  if (forvent == null) return null;
  const f = Date.parse(String(forvent));
  if (!Number.isFinite(f))
    return `ugyldig --forvent-endret ${forvent} (ISO-tid, f.eks. feltet endret i /api/tilstand)`;
  const e = Date.parse(String(ko?.endret ?? ''));
  if (Number.isFinite(e) && e > f)
    return (
      `køen er endret ${ko.endret}, etter ${forvent} som forhåndsvisningen bygget på. ` +
      'Hent køen på nytt og se over endringen igjen.'
    );
  return null;
}

/**
 * Blokkflytting (ko.mjs ranger): flytter oppgavene samlet øverst (`topp`), nederst (`bunn`), rett over (`over: id`)
 * eller rett under (`under: id`) en annen, INNEN fokustrinnet, og beholder rekkefølgen de hadde innbyrdes. Regner ut
 * nye `prioritet_tillegg` (generalisering av koTavle.loftTillegg): blokken fordeles jevnt mellom naboene, eller
 * RANGER_STEG forbi naboen øverst/nederst. Står blokken i flere trinn, flyttes hver del innen sitt trinn (topp/bunn);
 * over/under krever at alle står i referansens trinn. Bare venter og forslag.
 * @returns {{ feil: string[], endringer?: Record<string, number|null>, advarsler?: string[] }}
 */
function rangerBlokk(ko, ider, plass = {}, naa = Date.now()) {
  const feil = [];
  const liste = [...new Set(ider ?? [])];
  if (!liste.length) feil.push('ranger <id> … --topp|--bunn|--over <id>|--under <id>');
  const valgt = ['topp', 'bunn', 'over', 'under'].filter((k) => plass?.[k]);
  if (valgt.length !== 1) feil.push('velg én av --topp, --bunn, --over <id> og --under <id>');
  const oppgaver = ko.oppgaver ?? [];
  const register = ko.prosjekter ?? {};
  const perId = new Map(oppgaver.map((o) => [o.id, o]));
  const kanRangeres = (o) => o.status === 'venter' || o.status === 'forslag';
  for (const id of liste) {
    const o = perId.get(id);
    if (!o || erEksternRad(o)) feil.push(`ukjent oppgave ${id}`);
    else if (!kanRangeres(o))
      feil.push(`${id}: status ${o.status} (bare venter og forslag kan rangeres)`);
  }
  const ref = plass?.over ?? plass?.under ?? null;
  if (ref && valgt.length === 1) {
    const r = perId.get(ref);
    if (!r || erEksternRad(r)) feil.push(`ukjent oppgave ${ref}`);
    else if (liste.includes(ref)) feil.push(`${ref} står i blokken selv`);
    else if (!kanRangeres(r)) feil.push(`${ref}: status ${r.status} (rangeres ikke)`);
  }
  if (feil.length) return { feil };
  const k = rangeringKontekst(ko, naa);
  const rang = new Map();
  const ra = (o) => {
    if (!rang.has(o.id)) rang.set(o.id, rangering(o, ko, k));
    return rang.get(o.id);
  };
  const uten = (o) => score({ ...o, prioritet_tillegg: 0 }, oppgaver, naa, register);
  const blokk = liste
    .map((id) => perId.get(id))
    .map((o) => ({ o, r: ra(o) }))
    .sort(sammenlignRangering);
  const perTrinn = new Map();
  for (const x of blokk) {
    if (!perTrinn.has(x.r.trinn)) perTrinn.set(x.r.trinn, []);
    perTrinn.get(x.r.trinn).push(x);
  }
  if (ref) {
    const t = ra(perId.get(ref)).trinn;
    const utenfor = blokk.filter((x) => x.r.trinn !== t).map((x) => x.o.id);
    if (utenfor.length)
      return {
        feil: [
          `${utenfor.join(', ')} står i et annet trinn enn ${ref}; ranger flytter bare innen trinnet (endre fokus for å flytte mellom trinn)`,
        ],
      };
  }
  const iBlokk = new Set(liste);
  const endringer = {};
  const advarsler = [];
  for (const [trinn, deler] of perTrinn) {
    const andre = oppgaver
      .filter(
        (o) => !iBlokk.has(o.id) && !erEksternRad(o) && kanRangeres(o) && ra(o).trinn === trinn,
      )
      .map((o) => ({ o, r: ra(o) }))
      .sort(sammenlignRangering);
    let hoy = null;
    let lav = null;
    if (plass.topp) lav = andre.length ? andre[0].r.score : null;
    else if (plass.bunn) hoy = andre.length ? andre[andre.length - 1].r.score : null;
    else {
      const i = andre.findIndex((x) => x.o.id === ref);
      if (plass.over) {
        lav = andre[i].r.score;
        hoy = i > 0 ? andre[i - 1].r.score : null;
      } else {
        hoy = andre[i].r.score;
        lav = i < andre.length - 1 ? andre[i + 1].r.score : null;
      }
    }
    const n = deler.length;
    if (hoy != null && lav != null && hoy - lav < 0.02 * (n + 1))
      advarsler.push(
        `for lite rom mellom naboene (${hoy} og ${lav} poeng); blokken kan bli liggende likt med en nabo (id avgjør da)`,
      );
    deler.forEach((x, j) => {
      let maal;
      if (hoy == null && lav == null) return; // ingen andre i trinnet: rekkefølgen er allerede riktig
      if (hoy == null) maal = lav + RANGER_STEG * (n - j);
      else if (lav == null) maal = hoy - RANGER_STEG * (j + 1);
      else maal = lav + ((hoy - lav) * (n - j)) / (n + 1);
      const t = rund2(maal - uten(x.o));
      endringer[x.o.id] = Math.abs(t) < 0.005 ? null : t;
    });
  }
  return { feil: [], endringer, advarsler };
}

/** Prosjektene der kilden eller oppdraget (teksten i feltet, ikke fila) peker til prosjektets plan. */
function planTreff(o, register) {
  const tekst = norm(
    [o?.kilde, typeof o?.oppdrag === 'string' ? o.oppdrag : '']
      .filter((x) => typeof x === 'string' && x)
      .join('\n'),
  ).toLowerCase();
  if (!tekst) return [];
  const treff = [];
  for (const [pid, p] of Object.entries(register ?? {})) {
    if (typeof p?.plan !== 'string' || !p.plan.trim()) continue;
    const sti = norm(p.plan.trim()).toLowerCase();
    const navn = sti.slice(sti.lastIndexOf('/') + 1);
    if (tekst.includes(sti) || (navn.length >= 8 && tekst.includes(navn))) treff.push(pid);
  }
  return treff;
}

/** Ligger fila (eller mappa) under filroten? En rot som slutter på «/» er en mappe; ellers fil eller mappe. */
function underRot(fil, rot) {
  const f = norm(fil);
  const r = norm(rot);
  if (r.endsWith('/')) return f.startsWith(r);
  return f === r || f.startsWith(`${r}/`);
}

/** Antall eierfiler under hvert prosjekts filrot, flest først: [{ pid, n }] (bare prosjekter med minst ett treff). */
function filrotTreff(o, register) {
  const filer = (o?.eier_filer ?? []).filter((x) => typeof x === 'string' && x);
  const ut = [];
  for (const [pid, p] of Object.entries(register ?? {})) {
    const rotter = Array.isArray(p?.filrot)
      ? p.filrot.filter((x) => typeof x === 'string' && x)
      : [];
    if (!rotter.length) continue;
    const n = filer.filter((f) => rotter.some((r) => underRot(f, r))).length;
    if (n) ut.push({ pid, n });
  }
  return ut.sort((a, b) => b.n - a.n || a.pid.localeCompare(b.pid));
}

/**
 * Forslag til prosjekt for en oppgave (add, klassifiser, «Sorter»-lista). Signaler i fallende styrke: (1) eksplisitt
 * `prosjekt`, (2) lengste prefiks, (3) `kilde`/`oppdrag` peker til prosjektets `plan`, (4) flest eierfiler under
 * prosjektets `filrot`. «Sterke» signaler er en entydig plan og en filrot som dekker ALLE eierfilene; strider de mot
 * valget, er forslaget usikkert (eller, med eksplisitt prosjekt, `uenig`). Ingen eller tvetydige signaler: pid null
 * («Sorter»). Aldri en feil, så add aldri stopper på dette.
 * @returns {{ pid: string|null, signal: 'eksplisitt'|'prefiks'|'plan'|'filrot'|null, sikker: boolean, uenig: boolean,
 *   motforslag: string|null, grunn: string, kandidater: { pid: string, signal: string, grunn: string }[] }}
 */
function foreslaProsjekt(o, register) {
  const reg = register ?? {};
  const kandidater = [];
  const pre = lengstePrefiks(o?.id, reg);
  if (pre) kandidater.push({ pid: pre.pid, signal: 'prefiks', grunn: `prefikset ${pre.prefiks}` });
  const plan = planTreff(o, reg);
  for (const pid of plan)
    kandidater.push({ pid, signal: 'plan', grunn: `kilden peker til planen ${reg[pid].plan}` });
  const antFiler = (o?.eier_filer ?? []).filter((x) => typeof x === 'string' && x).length;
  const rot = filrotTreff(o, reg);
  for (const r of rot)
    kandidater.push({
      pid: r.pid,
      signal: 'filrot',
      grunn: `${r.n} av ${antFiler} eierfiler under filroten`,
    });
  const kand = (signal, pid) => kandidater.find((x) => x.signal === signal && x.pid === pid);
  const sterke = [];
  if (plan.length === 1) sterke.push(kand('plan', plan[0]));
  const alleRot = rot.filter((r) => r.n === antFiler);
  if (antFiler && alleRot.length === 1) sterke.push(kand('filrot', alleRot[0].pid));

  let valgt = null;
  const tvetydig = [];
  if (pre && !pre.ogsaa.length) valgt = kand('prefiks', pre.pid);
  else if (pre)
    tvetydig.push(`prefikset ${pre.prefiks} står i ${[pre.pid, ...pre.ogsaa].join(', ')}`);
  if (!valgt && plan.length === 1) valgt = kand('plan', plan[0]);
  else if (!valgt && plan.length > 1)
    tvetydig.push(`kilden peker til planene til ${plan.join(', ')}`);
  if (!valgt && rot.length) {
    if (rot.length === 1 || rot[0].n > rot[1].n) valgt = kand('filrot', rot[0].pid);
    else
      tvetydig.push(
        `like mange eierfiler under filroten til ${rot
          .filter((r) => r.n === rot[0].n)
          .map((r) => r.pid)
          .join(', ')}`,
      );
  }
  const imot = (pid) => {
    const m = sterke.filter((s) => s.pid !== pid);
    const pider = [...new Set(m.map((s) => s.pid))];
    return { m, motforslag: pider.length === 1 ? pider[0] : null };
  };
  const eksplisitt = typeof o?.prosjekt === 'string' && o.prosjekt ? o.prosjekt : null;
  if (eksplisitt) {
    const { m, motforslag } = imot(eksplisitt);
    return {
      pid: eksplisitt,
      signal: 'eksplisitt',
      sikker: !m.length,
      uenig: m.length > 0,
      motforslag,
      grunn: m.length
        ? `satt til ${eksplisitt}, men ${m.map((s) => `${s.grunn} (${s.pid})`).join('; ')}`
        : `satt til ${eksplisitt}`,
      kandidater,
    };
  }
  if (!valgt)
    return {
      pid: null,
      signal: null,
      sikker: false,
      uenig: false,
      motforslag: null,
      grunn: tvetydig.length
        ? `tvetydig: ${tvetydig.join('; ')}`
        : 'ingen prefiks, plan eller filrot treffer',
      kandidater,
    };
  const { m, motforslag } = imot(valgt.pid);
  const forbehold = [...tvetydig, ...m.map((s) => `${s.grunn} (${s.pid})`)];
  return {
    pid: valgt.pid,
    signal: valgt.signal,
    sikker: !forbehold.length,
    uenig: m.length > 0,
    motforslag,
    grunn: forbehold.length ? `${valgt.grunn}, men ${forbehold.join('; ')}` : valgt.grunn,
    kandidater,
  };
}

/** Statusene klassifiser ser på (åpent arbeid; ferdige og kansellerte står som de er). */
const KLASSIFISER_STATUSER = new Set(['forslag', 'venter', 'kjorer', 'plukket', 'review']);

/**
 * Forslag for oppgavene som allerede ligger i køen (ko.mjs klassifiser, «Sorter»-lista på tavla):
 *   flytt  = uten prosjekt i dag, og et sikkert forslag (`--utfor` setter `prosjekt` på dem);
 *   uenig  = prosjektet i dag (eksplisitt eller prefiks) strider mot et sterkt signal (eieren avgjør; aldri automatisk);
 *   sorter = uten prosjekt, og ingen eller et tvetydig forslag.
 * Filtre: `utenProsjekt` (bare de som står i uten-prosjekt i dag), `uenige` (bare uenig).
 * @returns {{ flytt: object[], sorter: object[] }} rader { id, tittel, naa, forslag, signal, type, grunn }
 */
function klassifiserKo(ko, { utenProsjekt = false, uenige = false } = {}) {
  const register = ko.prosjekter ?? {};
  const flytt = [];
  const sorter = [];
  for (const o of ko.oppgaver ?? []) {
    if (erEksternRad(o) || !KLASSIFISER_STATUSER.has(o.status)) continue;
    const naa = prosjektFor(o, register);
    const f = foreslaProsjekt(o, register);
    let type = null;
    let forslag = f.pid;
    if (naa === UTEN_PROSJEKT) type = f.pid && f.sikker ? 'flytt' : 'sorter';
    else if (f.uenig) {
      type = 'uenig';
      forslag = f.motforslag;
    } else if (!f.sikker) type = 'sorter';
    if (!type) continue;
    if (utenProsjekt && naa !== UTEN_PROSJEKT) continue;
    if (uenige && type !== 'uenig') continue;
    const rad = {
      id: o.id,
      tittel: o.tittel ?? null,
      status: o.status,
      naa,
      forslag: forslag ?? null,
      signal: f.signal,
      type,
      grunn: f.grunn,
    };
    (type === 'flytt' ? flytt : sorter).push(rad);
  }
  return { flytt, sorter };
}

/**
 * Advarsler om prefiksene i registeret: en prefiks på ett tegn uten skilletegn (fanger alt som starter med det, som «4»), en prefiks
 * som er starten på et annet prosjekts prefiks (den lengste vinner), og samme prefiks i to prosjekter (det første i
 * registeret vinner). `pid` begrenser til advarsler som gjelder det prosjektet.
 */
function prefiksAdvarsler(register, { pid: bare = null } = {}) {
  const ut = [];
  const liste = [];
  for (const [pid, p] of Object.entries(register ?? {}))
    for (const pre of Array.isArray(p?.prefikser) ? p.prefikser : [])
      if (typeof pre === 'string' && pre) liste.push({ pid, pre });
  for (const a of liste) {
    if (bare && a.pid !== bare) continue;
    if (a.pre.length === 1)
      ut.push(
        `prefikset ${a.pre} i ${a.pid} er bare ett tegn og fanger alle id-er som starter med ${a.pre}`,
      );
  }
  for (const a of liste) {
    for (const b of liste) {
      if (a.pid === b.pid) continue;
      if (bare && a.pid !== bare && b.pid !== bare) continue;
      if (a.pre === b.pre && a.pid < b.pid)
        ut.push(
          `prefikset ${a.pre} står i både ${a.pid} og ${b.pid} (det første i registeret vinner)`,
        );
      else if (a.pre !== b.pre && b.pre.startsWith(a.pre))
        ut.push(
          `prefikset ${a.pre} i ${a.pid} er starten på ${b.pre} i ${b.pid} (lengste prefiks vinner: ${b.pre}… går til ${b.pid})`,
        );
    }
  }
  return ut;
}

/**
 * Advarslene `add` skriver om prosjekt og funksjon for nye oppgaver (stopper aldri add): uten prosjekt (med forslaget
 * og hvilket signal som avgjorde, eller «Sorter»), eksplisitt prosjekt som strider mot sterke signaler, og en funksjon
 * som ikke står i prosjektets `funksjoner` (når lista finnes).
 * @returns {string[]}
 */
function addProsjektAdvarsler(nye, register) {
  const reg = register ?? {};
  if (!Object.keys(reg).length) return [];
  const ut = [];
  for (const n of nye ?? []) {
    if (!n || typeof n !== 'object') continue;
    const pid = prosjektFor(n, reg);
    const f = foreslaProsjekt(n, reg);
    if (pid === UTEN_PROSJEKT) {
      ut.push(
        f.pid
          ? `${n.id} har ikke prosjekt; forslag ${f.pid} (${f.grunn}). Sett "prosjekt": "${f.pid}", eller kjør ko.mjs klassifiser --utfor${f.sikker ? '' : ' (forslaget er usikkert: se ko.mjs klassifiser)'}`
          : `${n.id} har ikke prosjekt og havner i «Sorter» (${f.grunn}). Sett "prosjekt", eller gi prosjektet en filrot/prefiks`,
      );
    } else if (f.uenig) {
      ut.push(`${n.id}: ${f.grunn}. Sjekk prosjektet (ko.mjs klassifiser --uenige)`);
    }
    const kjente = reg[pid]?.funksjoner;
    if (
      Array.isArray(kjente) &&
      kjente.length &&
      typeof n.funksjon === 'string' &&
      n.funksjon.trim() &&
      !kjente.includes(n.funksjon.trim())
    ) {
      const lik = kjente.filter((x) => x.toLowerCase() === n.funksjon.trim().toLowerCase());
      ut.push(
        lik.length
          ? `${n.id}: funksjonen «${n.funksjon}» heter «${lik[0]}» i ${pid}`
          : `${n.id}: ny funksjon «${n.funksjon}» i ${pid} (kjente: ${kjente.slice(0, 8).join(', ')}${kjente.length > 8 ? ' …' : ''})`,
      );
    }
  }
  return ut;
}

// ---- Færre orkestratorturer ----
//
// Beslutningene bak kommandoene som sparer orkestratorturer (I/O-en står i ko.mjs):
//   flett <id>        flett-spor → (migrasjonspush, med miljøvakt) → gater --rask → sett ferdig → fyll, i ett kall
//   info / aktive     faste oppslag i stedet for `node -e`
//   endre --tillegg   tekst til oppdraget (sporblokka) og merknadene, med tidsstempel
//   neste-migr [<n>]  vis eller sett neste migrasjonsnummer; aldri bakover og aldri ned i et brukt nummer
//   «Start disse i SAMME tur:» etter fyll og motta, og rapporttaket (ca. 1 500 tegn) for agentenes svar.
// Migrasjonssteget finnes bare når konfig().migrasjoner har både `mappe` og `pushKommando`.

/** Taket for agentens svar til orkestratoren (tegn). Det lange står i rapport.md. */
const RAPPORT_TAK = 1500;

/** Migrasjonsoppsettet fra konfig(), eller «av» når konfigen ikke kan leses (rene tester uten konfig). */
function migrOppsett(migrasjoner) {
  if (migrasjoner !== undefined) return migrasjoner ?? { mappe: null };
  try {
    return require('./koKonfig.js').konfig().migrasjoner ?? { mappe: null };
  } catch {
    return { mappe: null };
  }
}

/**
 * Er miljøet migrasjonene pushes mot et tillatt miljø? Uten `miljoFil` i oppsettet finnes ingen vakt (ok). Med
 * `miljoFil` må innholdet stå i `tillatteMiljo`; mangler fila eller er den tom, stopper `flett` før pushen.
 * @param {string|null|undefined} miljo innholdet i miljøfila (null når fila mangler)
 * @param {{ miljoFil?: string|null, tillatteMiljo?: string[] }} [migrasjoner]
 * @returns {{ ok: boolean, miljo: string, melding: string }}
 */
function miljoSjekk(miljo, migrasjoner) {
  const m = migrOppsett(migrasjoner);
  if (!m.miljoFil) return { ok: true, miljo: 'uten-vakt', melding: 'ingen miljøfil satt' };
  const tillatte = Array.isArray(m.tillatteMiljo) ? m.tillatteMiljo : [];
  const r = typeof miljo === 'string' ? miljo.trim() : '';
  if (!r)
    return {
      ok: false,
      miljo: 'mangler',
      melding:
        `Fant ikke miljøfila ${m.miljoFil} (eller den er tom). STOPP: flett pusher migrasjoner bare mot et miljø i ` +
        `migrasjoner.tillatteMiljo (${tillatte.length ? tillatte.join(', ') : 'tom liste'}).`,
    };
  if (!tillatte.includes(r))
    return {
      ok: false,
      miljo: 'ukjent',
      melding:
        `${m.miljoFil} peker på «${r}», som ikke står i migrasjoner.tillatteMiljo ` +
        `(${tillatte.length ? tillatte.join(', ') : 'tom liste'}). STOPP: koble til riktig miljø først.`,
    };
  return { ok: true, miljo: r, melding: `${r} (tillatt)` };
}

/**
 * Migrasjonsfilene i en filliste (stiene fra `git diff --name-only`): filer rett under `migrasjoner.mappe` som
 * matcher `filmonster`. Uten mappe: ingen.
 */
function migrFiler(filer, migrasjoner) {
  const m = migrOppsett(migrasjoner);
  if (!m.mappe) return [];
  const mappe = String(m.mappe).replace(/\\/g, '/').replace(/\/+$/, '');
  const monster = new RegExp(m.filmonster ?? '^(\\d+)_.*\\.sql$');
  return (Array.isArray(filer) ? filer : []).filter((f) => {
    const s = String(f).replace(/\\/g, '/');
    if (!s.startsWith(`${mappe}/`)) return false;
    const navn = s.slice(mappe.length + 1);
    return !navn.includes('/') && monster.test(navn);
  });
}

/**
 * Hvilke steg `flett` kjører. Migrasjonspush når prosjektet har migrasjonsflyt (mappe + pushKommando) og grenen har
 * migrasjonsfiler; kan diffen ikke leses (`filer` null), avgjør migrasjonsblokka (heller en push for mye enn en for
 * lite). En blokk uten filer gir bare et notat. Uten migrasjonsmappe er det aldri noe push-steg.
 * @param {{ o: object, filer: string[]|null, utenMigrPush?: boolean, utenFyll?: boolean, base?: string,
 *   migrasjoner?: object }} x
 * @returns {{ steg: string[], migrPush: boolean, migr: string[], notater: string[] }}
 */
function flettPlan({ o, filer, utenMigrPush = false, utenFyll = false, base = 'basegrenen', migrasjoner }) {
  const m = migrOppsett(migrasjoner);
  const notater = [];
  let migr = [];
  let migrPush = false;
  if (m.mappe) {
    migr = migrFiler(filer, m);
    const harMigr = Array.isArray(filer) ? migr.length > 0 : !!o?.migr_blokk;
    if (Array.isArray(filer) && !migr.length && o?.migr_blokk)
      notater.push(`migrasjonsblokk ${o.migr_blokk}, men ingen migrasjonsfiler i grenen: ingen push`);
    if (!Array.isArray(filer))
      notater.push(`fant ikke diffen mot ${base}; migrasjonsblokka avgjør pushen`);
    if (harMigr && !m.pushKommando)
      notater.push(
        'grenen har migrasjoner, men migrasjoner.pushKommando er ikke satt: push dem selv etter flettingen',
      );
    else if (harMigr && utenMigrPush)
      notater.push('migrasjonspush hoppet over (--uten-migr-push): migrasjonene er IKKE pushet ennå');
    migrPush = harMigr && !!m.pushKommando && !utenMigrPush;
  }
  const steg = ['flett', ...(migrPush ? ['migr-push'] : []), 'gater', 'ferdig'];
  if (!utenFyll) steg.push('fyll');
  return { steg, migrPush, migr, notater };
}

/** De siste `n` ikke-tomme linjene (feilutdraget når et steg stopper). */
function feilUtdrag(ut, n = 20) {
  return String(ut ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n);
}

/** Siste linje som matcher mønsteret (eller siste ikke-tomme), kuttet til `maks` tegn. */
function sisteLinje(ut, monster = null, maks = 140) {
  const linjer = feilUtdrag(ut, 1000);
  const treff = monster ? linjer.filter((l) => monster.test(l)) : linjer;
  const l = (treff.length ? treff[treff.length - 1] : (linjer[linjer.length - 1] ?? '')).trim();
  return l.length > maks ? `${l.slice(0, maks - 1)}…` : l;
}

/** Exit-koder fra `fyll` som ikke er feil: dagsbudsjett (4), nattpause (5), avvikling (6). */
const FYLL_STOPP_KODER = new Set([4, 5, 6]);

/**
 * Kjører stegene i `flett` i rekkefølge og stopper ved første feil. Gjør ingen I/O selv: `kjor({ steg })` kjører ett
 * steg og gir `{ kode, ut }` (stdout og stderr samlet), `lesMiljo()` gir innholdet i migrasjoner.miljoFil (null når
 * fila mangler), og `vakt(miljo)` er push-vakta for migrasjonskommandoen (null = fritt). Rekkefølgen, stopp-reglene
 * og miljøsjekken er her, så de kan testes uten git, database eller gatene.
 * @param {{ o: object, plan: object, gren: string, gjeldendeGren: string|null, kjor: Function,
 *   lesMiljo?: Function, vakt?: Function, base?: string, migrasjoner?: object }} x
 * @returns {{ ok: boolean, linjer: string[], stopp: { steg: string, melding: string, utdrag: string[] }|null }}
 */
function utforFlett({
  o,
  plan,
  gren,
  gjeldendeGren,
  kjor,
  lesMiljo = () => null,
  vakt = () => null,
  base = 'main',
  migrasjoner,
}) {
  const linjer = [...plan.notater.map((n) => `NB: ${n}`)];
  const stopp = (steg, melding, ut = '') => ({
    ok: false,
    linjer,
    stopp: { steg, melding, utdrag: feilUtdrag(ut) },
  });
  if (gjeldendeGren !== base)
    return stopp(
      'flett',
      `Hovedtreet står på ${gjeldendeGren ?? 'ukjent gren'}, ikke ${base}. Ingenting er gjort.`,
    );
  for (const steg of plan.steg) {
    if (steg === 'flett') {
      const r = kjor({ steg });
      if (r.kode !== 0)
        return stopp(
          steg,
          `flett-spor.mjs ${gren} feilet (exit ${r.kode}). Ingenting etter flettingen er gjort; ` +
            'står flettingen igjen, løs den eller angre med git merge --abort.',
          r.ut,
        );
      const wt = sisteLinje(r.ut, /^Worktree:/);
      linjer.push(
        `flett: ${sisteLinje(r.ut, /^Flettet/)}${/^Worktree:/.test(wt) ? ` · ${wt}` : ''}`,
      );
    } else if (steg === 'migr-push') {
      const m = migrOppsett(migrasjoner);
      const miljo = lesMiljo();
      const ms = miljoSjekk(miljo, m);
      if (!ms.ok) return stopp(steg, `Flettet, men ingen migrasjonspush: ${ms.melding}`);
      const v = vakt(miljo);
      if (v)
        return stopp(
          steg,
          `Flettet, men ingen migrasjonspush: push-vakta sier ${v.beslutning}: ${v.grunn}`,
        );
      const r = kjor({ steg });
      if (r.kode !== 0)
        return stopp(
          steg,
          `Flettet, men migrasjonspushen feilet (exit ${r.kode}). Gatene, sett ferdig og fyll er ikke kjørt.`,
          r.ut,
        );
      linjer.push(
        `migrasjonspush: OK${m.miljoFil ? ` (miljø ${ms.miljo})` : ''}: ${sisteLinje(r.ut) || 'ingen utdata'}`,
      );
      if (m.miljoFil) {
        const etter = miljoSjekk(lesMiljo(), m);
        if (!etter.ok || etter.miljo !== ms.miljo)
          return stopp(steg, `Miljøet er endret under migrasjonspushen: ${etter.melding}`);
      }
    } else if (steg === 'gater') {
      const r = kjor({ steg });
      if (r.kode !== 0)
        return stopp(
          steg,
          `Gatene (--rask) er røde etter flettingen${plan.migrPush ? ' og migrasjonspushen' : ''}. Oppgaven står i ` +
            'review; rett (eller send retterunde), og kjør så sett <id> ferdig og fyll.',
          r.ut,
        );
      linjer.push(`gater --rask: ${sisteLinje(r.ut)}`);
    } else if (steg === 'ferdig') {
      const r = kjor({ steg });
      if (r.kode !== 0) return stopp(steg, `sett ${o.id} ferdig feilet (exit ${r.kode}).`, r.ut);
      linjer.push(`ferdig: ${sisteLinje(r.ut, /^Kost |: ferdig/)}`);
    } else if (steg === 'fyll') {
      const r = kjor({ steg });
      if (FYLL_STOPP_KODER.has(r.kode)) {
        linjer.push(`fyll: ingen nye (exit ${r.kode}): ${sisteLinje(r.ut)}`);
        continue;
      }
      if (r.kode !== 0)
        return stopp(steg, `fyll feilet (exit ${r.kode}). ${o.id} er ferdig.`, r.ut);
      linjer.push(...fyllUtdrag(r.ut));
    }
  }
  return { ok: true, linjer, stopp: null };
}

/**
 * Fra `fyll`-utdataene: FYLT-linja, én linje per spor og agentlista «Start disse i SAMME tur:»; ellers siste linje
 * (f.eks. «Ingenting kan startes nå»).
 */
function fyllUtdrag(ut) {
  const linjer = String(ut ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const i = linjer.findIndex((l) => /^FYLT /.test(l));
  if (i >= 0) return [`fyll: ${linjer[i]}`, ...linjer.slice(i + 1)];
  return [`fyll: ${linjer[linjer.length - 1] ?? 'ingen utdata'}`];
}

const SAMME_TUR = 'Start disse i SAMME tur:';

/**
 * Agentlista orkestratoren starter i ÉN tur (parallelt): én linje per agent med subagent_type og meldingen
 * (sporets melding nevner prompt-fila; en reviewer får innholdet i prompt-fila som melding).
 * @param {{ subagent_type: string, prompt: string, melding?: string|null }[]} agenter
 */
function samtidigBlokk(agenter) {
  if (!agenter?.length) return [];
  return [
    SAMME_TUR,
    ...agenter.map((x) =>
      x.melding
        ? `  subagent_type=${x.subagent_type} · melding: ${x.melding}`
        : `  subagent_type=${x.subagent_type} · melding: innholdet i ${x.prompt}`,
    ),
  ];
}

/** Advarselen `motta` gir når sporets svar er over rapporttaket (null ellers). */
function rapportTakVarsel(tekst, tak = RAPPORT_TAK) {
  const n = String(tekst ?? '').trim().length;
  if (n <= tak) return null;
  return (
    `ADVARSEL: sporsvar.md er ${n} tegn (tak ca. ${tak}). Svaret skal være RESULTAT-linja, høyst 5 linjer og stien til ` +
    'rapport.md; det lange står i rapport.md (se docs/mission-template.md, «Rapport»).'
  );
}

/** Feltene `info` viser som standard (kort), i denne rekkefølgen. */
const INFO_FELT = [
  'id',
  'tittel',
  'status',
  'klasse',
  'domene',
  'prosjekt',
  'funksjon',
  'gren',
  'migr_blokk',
  'head_start',
  'startet',
  'levert',
  'ferdig',
  'avhenger',
  'venter_paa',
  'eier_filer',
  'eier_db',
  'scratchpad',
  'review_pakke',
];

/** Verdien til et felt, også med punktum (`kost.usd`, `resultat.linje`). undefined når det ikke finnes. */
function infoFelt(o, felt) {
  let v = o;
  for (const del of String(felt).split('.')) {
    if (v == null || typeof v !== 'object' || !(del in v)) return undefined;
    v = v[del];
  }
  return v;
}

/** Ett felt som tekst: strenger rått (så de kan brukes i et skall), alt annet som kompakt JSON. */
function infoVerdiTekst(v) {
  if (v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Kort standardvisning av én oppgave (`ko.mjs info <id>`): ett felt per linje, oppdraget og merknader forkortet. */
function infoVisning(o) {
  const ut = [];
  for (const f of INFO_FELT) {
    const v = o[f];
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    ut.push(
      `${f}: ${Array.isArray(v) ? v.join(', ') : f === 'head_start' ? String(v).slice(0, 12) : v}`,
    );
  }
  if (o.resultat?.linje) ut.push(`resultat: ${o.resultat.linje}`);
  if (o.kost)
    ut.push(
      `kost: $${o.kost.usd} (${o.kost.agenter?.length ?? 0} agent(er), ${o.kost.turer ?? '?'} turer)`,
    );
  if (o.funn) ut.push(`funn: H=${o.funn.H} M=${o.funn.M} L=${o.funn.L}`);
  const tillegg = Array.isArray(o.tillegg) ? o.tillegg : [];
  if (tillegg.length)
    ut.push(`tillegg: ${tillegg.length} (siste ${tillegg[tillegg.length - 1].tid})`);
  const merk = Array.isArray(o.merknader) ? o.merknader : [];
  if (merk.length)
    ut.push(`merknader: ${merk.length}; siste: ${kuttTekst(merk[merk.length - 1], 160)}`);
  if (o.oppdrag) ut.push(`oppdrag: ${kuttTekst(String(o.oppdrag).replace(/\s+/g, ' '), 200)}`);
  ut.push('Ett felt: ko.mjs info <id> --felt <navn> (også kost.usd, resultat.linje).');
  return ut;
}

function kuttTekst(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Legger et tillegg til oppdraget: i `tillegg` (sporblokka viser det, så prompt-fila får det ved neste fyll/sporfil)
 * og i merknadene, begge med tidsstempel. Muterer oppgaven; gir feilteksten eller null.
 */
function leggTilTillegg(o, tekst, naa) {
  const t = String(tekst ?? '').trim();
  if (!t) return 'tillegget er tomt';
  o.tillegg = [...(Array.isArray(o.tillegg) ? o.tillegg : []), { tid: naa, tekst: t }];
  o.merknader = [
    ...(Array.isArray(o.merknader) ? o.merknader : []),
    `${naa} tillegg til oppdraget: ${t}`,
  ];
  return null;
}

/** Tilleggene som en egen bolk i sporblokka (null når det ikke er noen). */
function tilleggBlokk(o) {
  const t = Array.isArray(o?.tillegg) ? o.tillegg : [];
  if (!t.length) return null;
  return [
    '**Tillegg fra orkestratoren (bindende, nyeste sist):**',
    ...t.map((x) => `- ${x.tid}: ${x.tekst}`),
  ].join('\n');
}

// Alderen skrives med alderTekst (over), samme format som i vis.
const AKTIVE_STATUSER = ['kjorer', 'plukket', 'review'];

/**
 * De aktive oppgavene (kjorer, plukket, review) som korte linjer: id, status, klasse, gren, migrasjonsblokk,
 * head_start og alder (fra start/plukk; for review også tid siden levering).
 */
function aktiveLinjer(ko, naa = Date.now()) {
  const rader = (ko?.oppgaver ?? []).filter((o) => AKTIVE_STATUSER.includes(o.status));
  if (!rader.length) return ['Ingen aktive oppgaver (kjorer, plukket, review).'];
  return rader.map((o) => {
    const fra = Date.parse(o.startet ?? o.plukket_at ?? '');
    const lev =
      o.status === 'review' && o.levert
        ? `, levert for ${alderTekst(naa - Date.parse(o.levert))} siden`
        : '';
    return (
      `${o.id}  ${o.status}  ${o.klasse}  ${o.gren ?? '-'}  migr ${o.migr_blokk ?? '-'}  ` +
      `head ${o.head_start ? String(o.head_start).slice(0, 8) : '-'}  alder ${Number.isNaN(fra) ? '?' : alderTekst(naa - fra)}${lev}` +
      `${o.plukket_av ? `  plukket av ${o.plukket_av}` : ''}`
    );
  });
}

/** Høyeste brukte nummer i køens migrasjonsblokker («3600–3609» → 3609). */
function hoyesteBlokkNr(ko) {
  let maks = 0;
  for (const o of ko?.oppgaver ?? []) {
    const m = /–(\d+)\s*$/.exec(String(o.migr_blokk ?? ''));
    if (m) maks = Math.max(maks, Number(m[1]));
  }
  return maks;
}

/**
 * Vakt for `neste-migr <n>`: nekter å gå bakover (under dagens neste_migr) og ned i et brukt nummer (høyeste
 * migrasjonsfil i serien eller høyeste tildelte blokk). Gir { ok, feil } (feil = null når ok).
 */
function nesteMigrVakt({ naa, ny, hoyesteFil = 0, hoyesteBlokk = 0 }) {
  if (!Number.isInteger(ny) || ny <= 0)
    return { ok: false, feil: `ugyldig nummer «${ny}» (heltall over 0)` };
  if (Number.isInteger(naa) && ny < naa)
    return { ok: false, feil: `${ny} er bakover (neste_migr er ${naa}); køen går aldri bakover` };
  const brukt = Math.max(hoyesteFil || 0, hoyesteBlokk || 0);
  if (ny <= brukt)
    return {
      ok: false,
      feil: `${ny} er ikke over høyeste brukte nummer ${brukt} (migrasjonsfil ${hoyesteFil || 0}, blokk ${hoyesteBlokk || 0})`,
    };
  return { ok: true, feil: null };
}

module.exports = {
  VEKT,
  KALIBRERT,
  anslagVegg,
  anslagKost,
  STANDARD_GRENSER,
  GRENSE_NAVN,
  GRENSE_EKSTRA,
  anslag,
  valider,
  filOverlapp,
  konflikt,
  konfliktDel,
  hindringer,
  hindringDeler,
  barnKart,
  etterfolgere,
  lasOppAntall,
  score,
  harMigr,
  AKTIVE,
  plassBruk,
  velgNeste,
  tildelMigrBlokk,
  migrTiere,
  nullstillKonfig,
  baseGren,
  grenPrefiks,
  koGren,
  tilstand,
  budsjettVakt,
  NATT_TZ,
  tolkNattvindu,
  iNattvindu,
  nattVakt,
  startVakt,
  avviklingVakt,
  grenseTekst,
  tolkGrense,
  erAgentKilde,
  statusVedAdd,
  godkjenn,
  // Prosjekt, funksjon, plukking og visuell QA
  STATUSER,
  UTEN_PROSJEKT,
  UTEN_FUNKSJON,
  GAMMEL_PLUKK_MS,
  validerNyeFelt,
  prosjektFor,
  prosjektPauset,
  hindringerMedPause,
  harEtikett,
  tellerSomAgent,
  grupper,
  prosjektOversikt,
  nyttRegister,
  endreMange,
  // Områder, fokusperiode, dratt med og parkering
  UTEN_OMRADE,
  FOKUS_RESTEN,
  omradeFor,
  tolkTrinn,
  trinnTreff,
  fokusGjelder,
  egetTrinn,
  parkertNaa,
  drattMed,
  rangeringKontekst,
  fokusPlass,
  rangering,
  sammenlignRangering,
  tolkTilDato,
  stegTekst,
  fokusTekst,
  settFokus,
  fjernFokus,
  FOKUS_PLAN_MAKS,
  lagreFokusPlan,
  scoreDeler,
  trinnTittel,
  aapneSporsmal,
  fokusStatus,
  settOmrade,
  omradeOversikt,
  parker,
  fortsett,
  migrBlokkTekst,
  plukkbare,
  plukk,
  lever,
  slipp,
  erGammelPlukk,
  alderTekst,
  settStatus,
  qaListe,
  qaOk,
  qaAvvik,
  // Arbeid utenfor køen, push-sjekk og orkestrator-markør
  ORKESTRATOR_TRAILER,
  ORKESTRATOR_UTLOP_MS,
  KOLLISJON_STATUSER,
  erEksternRad,
  harOrkestratorTrailer,
  koIdFraFlett,
  klassifiserCommit,
  nevnteIder,
  samsvar,
  pushPlan,
  ucommittetKollisjon,
  ucommittetHoppet,
  eksternKollisjoner,
  kollisjonTekst,
  sporfilAdvarsel,
  eksternId,
  eksternAdd,
  eksternFerdig,
  eksternGodta,
  orkestratorStatus,
  nyMarkor,
  manglerProsjekt,
  SPORSMAL_TYPER,
  gyldigSporsmalId,
  settSporsmal,
  avklar,
  ulogget,
  merkLogget,
  sporsmalOversikt,
  sporsmalUtenTekst,
  svarBlokk,
  // Eiersvar kan ikke gå tapt
  SPORSMAL_ID_MONSTER,
  sporsmalRegistrert,
  venterPaaFeil,
  loseVentinger,
  loseVentingerLinjer,
  eiersvarTillegg,
  // Sporblokka (sporfil og sky-pakke) og køoppgaver i skyøkter
  sporBlokk,
  SKY_AV,
  SKY_MAKS,
  erSky,
  skyReferanser,
  skyEgnet,
  skyPakke,
  SKY_BUNT_MAKS,
  SKY_BUNT_MIN,
  skyBuntTak,
  skyBuntPakke,
  skyBunter,
  skyOkter,
  skyStart,
  skyFerdig,
  skyAvbryt,
  // Samlekøen
  SAMLES_HINDRING,
  SAMLE_MAAL,
  erSamles,
  iSamlekoen,
  samlesFeil,
  smaaoppgaveFeil,
  SMAA_FIKS_MIN,
  SMAA_LAV_NYTTE,
  samleGrupper,
  samleForslag,
  samlePakk,
  samleOppdragTekst,
  // Orkestratorens rutine som skript (vis kort, fyll, motta) og kost per oppgave
  agentTypeFor,
  reviewereFor,
  sporMelding,
  tilstandLinje,
  kortVisning,
  parseResultat,
  parseFunn,
  samleFunn,
  sisteSvar,
  forsteBrukermelding,
  nevnerOppgave,
  STANDARD_REVIEWERE,
  reviewerTyper,
  get REVIEWER_TYPER() {
    return reviewerTyper();
  },
  get OPPGAVE_AGENTTYPER() {
    return oppgaveAgenttyper();
  },
  agenterForOppgave,
  summerKost,
  kostStatistikk,
  pakkeFiler,
  dbObjekterFraDiff,
  reviewPakkeIndeks,
  reviewerPrompt,
  // Masseendring, endringslogg og angre, blokkflytting, forslag til prosjekt
  ENDRINGSLOGG_MAKS,
  RANGER_STEG,
  lengstePrefiks,
  parkertVerdi,
  klonJson,
  likVerdi,
  masseDiff,
  diffLinjer,
  loggEndring,
  sisteAngrbare,
  angrePost,
  forventSjekk,
  rangerBlokk,
  planTreff,
  filrotTreff,
  foreslaProsjekt,
  klassifiserKo,
  prefiksAdvarsler,
  addProsjektAdvarsler,
  // Massehandlingene på tavla (koTavle.massePlan, pakkForhandsvisning).
  samleId,
  ETIKETT_MONSTER,
  // Flett i ett kall, faste oppslag, samtidige kall og rapporttaket
  RAPPORT_TAK,
  miljoSjekk,
  migrOppsett,
  migrFiler,
  flettPlan,
  feilUtdrag,
  utforFlett,
  fyllUtdrag,
  SAMME_TUR,
  samtidigBlokk,
  rapportTakVarsel,
  infoFelt,
  infoVerdiTekst,
  infoVisning,
  leggTilTillegg,
  tilleggBlokk,
  aktiveLinjer,
  hoyesteBlokkNr,
  nesteMigrVakt,
};
