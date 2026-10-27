// =============================================================
// koTavle.js: ren logikk for kanban-tavla over arbeidskøen (scripts/orkestrator/ko-tavle.mjs, se docs/board.md).
//
// Tavla skal vise det samme som `ko.mjs vis/neste/prosjekter`. Derfor står ingen køregler her: prioritet
// (score), prosjekt (prosjektFor), hindringer (hindringerMedPause, ucommittetKollisjon), agentplasser
// (tellerSomAgent) og grenser kommer fra koLogikk.js. Her er bare det tavla legger oppå:
//   - hvilken kolonne et kort står i (I kø, Pågår, Review, Bygget, og forslag for seg),
//   - hvilket prioritet_tillegg som lander et kort MELLOM to naboer når eieren drar det,
//   - rekkefølgen og flyttingen av prosjektbaner (prosjektets prioritet_tillegg),
//   - WIP-telleren i kolonnehodet,
//   - fargene: en egen, nøytral palett (lys og mørk) som gjøres om til CSS-variabler (`PALETT`, `temaCss`),
//   - vaktreglene som varsler før en flytting eller handling lager problemer (`vurder`), «Løft avhengighetene også»
//     (`loftTillegg`), innstillingspanelet (`innstillinger`, `INNSTILLINGER`) og oppsettet som bare vises
//     (`hooksDekning`, `skillsDekning`, `hoyesteMigrasjon`, `SKILL_REGLER`, `tavleTittel`),
//   - «låser opp N» og kjeden rundt et kort (`laaserOpp`, `kjede`; etterfølgerne fra koLogikk.etterfolgere, samme
//     telling som bonusen i prioriteten), aldrende arbeid mot p85 for klassen (grensene fra
//     koStatistikk.aldersGrenser), «Neste opp» (`nesteOpp`: koLogikk.velgNeste og startVakt direkte) og «Venter på
//     deg» (`innboks`: eierspørsmål, QA, forslag og det som henger),
//   - samlekøen: kortene i egen kolonne (`samle`) og gruppene med sum mot målet (koLogikk.samleGrupper),
//   - massehandlingene fra valglinja: handling → ko.mjs-kommando (`massePlan`), forklaringen i forhåndsvisningen
//     (`masseOppsummering`), «Pakk til spor» forhåndsvist på en kopi (`pakkForhandsvisning`) og vaktreglene for
//     massehandlinger (`vurder` med type 'masse'). Testet i lib/__tests__/koTavleMasse.test.ts,
//   - stivernet for /api/dok (`lesDokument`), med filsystemet sendt inn av serveren.
//
// Ingen I/O her: serveren leser ko.json, git og innstillingene og kaller disse funksjonene. Skriving går ALLTID via
// ko.mjs (endre, prosjekt, endre-mange, plukk, slipp, qa, grense, avklar, godkjenn), aldri herfra.
// Testet i lib/__tests__/koTavle.test.ts.
// =============================================================

const L = require('./koLogikk.js');

/** Hvor langt forbi naboen et kort eller en bane havner øverst eller nederst (i prioritetspoeng). */
const STEG = 10;
/** Bygget-kolonnen viser de siste 7 dagene (pluss det som venter på QA); resten ligger bak «vis flere». */
const NYLIG_MS = 7 * 86_400_000;
/** «Neste opp» når plassene er fulle: så mange vises som de neste. */
const NESTE_NAAR_FULL = 3;

/**
 * Prosjektfargene: kategorifargene fra paletten (PALETT under), valgt fordi de er laget for å skilles fra hverandre (også
 * ved fargeblindhet) og holder kontrast i begge skjema. Rekkefølgen sprer nabofarger. Prosjekt nr. i i registeret
 * får farge nr. i (modulo), så fargen er stabil når prioriteten endres. `uten-prosjekt` får den nøytrale.
 */
const PROSJEKT_FARGER = [
  'kategori-teal',
  'kategori-plomme',
  'kategori-havbla',
  'kategori-mose',
  'kategori-fiolett',
  'kategori-petrol',
  'kategori-gronn',
  'kategori-bla',
  'kategori-skifer',
];
const UTEN_PROSJEKT_FARGE = 'kategori-grafitt';

const rund2 = (x) => Math.round(x * 100) / 100;

/** Standard grenprefiks (som konfig().grenPrefiks). */
const GREN_PREFIKS = 'ko/';
/** Grenen en oppgave bygges på: `gren` i køen, ellers <grenPrefiks><id>. */
const grenFor = (o, prefiks = GREN_PREFIKS) => o.gren ?? `${prefiks}${o.id}`;

/**
 * Kolonnen et kort står i: ko, forslag, samle, pagar, review, bygget, eller null (kansellert, avsluttet registrering).
 * En oppgave i samlekøen (venter eller forslag med samles) står i `samle`, aldri som startbar eller ventende.
 */
function kolonneFor(o) {
  if (L.erEksternRad(o)) return o.status === 'ekstern' ? 'pagar' : null;
  if (L.iSamlekoen(o)) return 'samle';
  switch (o.status) {
    case 'venter':
      return 'ko';
    case 'forslag':
      return 'forslag';
    case 'kjorer':
    case 'plukket':
      return 'pagar';
    case 'review':
      return 'review';
    case 'ferdig':
      return 'bygget';
    default:
      return null;
  }
}

/** Agentplasser i bruk, med samme regel som køen (tellerSomAgent: kjorer og review uten plukket_av). */
function wip(ko) {
  const oppgaver = ko.oppgaver ?? [];
  const g = { ...L.STANDARD_GRENSER, ...(ko.grenser ?? {}) };
  const agenter = oppgaver.filter(L.tellerSomAgent);
  return {
    agenter: agenter.length,
    maks: g.maksSamtidig,
    dPluss: agenter.filter((o) => o.klasse === 'D+').length,
    maksDPluss: g.maksDPluss,
    plukket: oppgaver.filter((o) => o.status === 'plukket').length,
    ekstern: oppgaver.filter((o) => L.erEksternRad(o) && o.status === 'ekstern').length,
  };
}

/**
 * Prosjektene i baneordning: høyest prioritet_tillegg først, ellers køens egen rekkefølge (registeret, så ukjente
 * alfabetisk, `uten-prosjekt` sist, via prosjektOversikt). `flyttbar` = står i registeret (bare da kan tillegget
 * settes). Fargen følger registerets rekkefølge, ikke baneordningen.
 */
function prosjektBaner(ko) {
  const rader = L.prosjektOversikt(ko);
  const farge = new Map();
  let i = 0;
  for (const r of rader) {
    farge.set(
      r.pid,
      r.pid === L.UTEN_PROSJEKT
        ? UTEN_PROSJEKT_FARGE
        : PROSJEKT_FARGER[i++ % PROSJEKT_FARGER.length],
    );
  }
  const baner = rader.map((r, indeks) => ({
    pid: r.pid,
    tittel: r.tittel,
    pause: r.pause,
    prioritet_tillegg: r.prioritet_tillegg,
    flyttbar: r.i_register,
    farge: farge.get(r.pid),
    indeks,
  }));
  baner.sort((a, b) => {
    const ua = a.pid === L.UTEN_PROSJEKT ? 1 : 0;
    const ub = b.pid === L.UTEN_PROSJEKT ? 1 : 0;
    return ua - ub || b.prioritet_tillegg - a.prioritet_tillegg || a.indeks - b.indeks;
  });
  return baner.map(({ indeks: _i, ...b }) => b);
}

/** Merknadene på en oppgave samlet: lista `merknader` og de enkle feltene `merknad*`. */
function merknaderFor(o) {
  const ut = Array.isArray(o.merknader) ? [...o.merknader] : [];
  for (const [k, v] of Object.entries(o)) {
    if (/^merknad(_|$)/.test(k) && typeof v === 'string' && v.trim()) ut.push(v);
  }
  return ut;
}

// ---- Kjeden rundt et kort --------------------------------------------------------------------------

const aapen = (o) => !!o && o.status !== 'ferdig' && o.status !== 'kansellert';

/** Oppslagene kjeden trenger, laget én gang for hele tavla: etterfølgerne (koLogikk.barnKart) og oppgavene per id. */
function kjedeKart(oppgaver) {
  return { barn: L.barnKart(oppgaver), perId: new Map(oppgaver.map((o) => [o.id, o])) };
}

/**
 * «Låser opp N»: oppgavene som venter på `id`, direkte eller transitivt gjennom `avhenger`, og som ikke er ferdige
 * (koLogikk.etterfolgere, samme telling som bonusen i prioriteten; sykluser tåles), og summen av anslagene deres.
 * @returns {{ antall: number, minutter: number, direkte: string[], ider: string[] }}
 */
function laaserOpp(ko, id, kart = kjedeKart(ko.oppgaver ?? [])) {
  const ider = L.etterfolgere(id, ko.oppgaver ?? [], kart.barn).sort();
  const direkte = [...new Set(kart.barn.get(id) ?? [])]
    .filter((x) => x !== id && aapen(kart.perId.get(x)))
    .sort();
  const minutter = ider.reduce((sum, x) => sum + L.anslag(kart.perId.get(x) ?? {}), 0);
  return { antall: ider.length, minutter, direkte, ider };
}

/**
 * Kjeden rundt et kort: forgjengerne (transitivt gjennom `avhenger`) og etterfølgerne (som laaserOpp) som fortsatt skal
 * gjøres. Ukjente id-er og ferdige oppgaver er ikke med (en ferdig forgjenger hindrer ingenting), men letingen går
 * gjennom dem. Sykluser tåles, og kortet selv er aldri med.
 * @returns {{ for: string[], etter: string[] }}
 */
function kjede(ko, id, kart = kjedeKart(ko.oppgaver ?? [])) {
  return { for: forgjengere(id, kart), etter: laaserOpp(ko, id, kart).ider };
}

/** Forgjengerne (transitivt gjennom `avhenger`) som fortsatt skal gjøres, sortert. Se kjede. */
function forgjengere(id, kart) {
  const sett = new Set();
  const stakk = [...(kart.perId.get(id)?.avhenger ?? [])];
  while (stakk.length) {
    const x = stakk.pop();
    if (sett.has(x) || x === id) continue;
    sett.add(x);
    stakk.push(...(kart.perId.get(x)?.avhenger ?? []));
  }
  return [...sett].filter((x) => aapen(kart.perId.get(x))).sort();
}

/**
 * Aldrende arbeid: et kort i Pågår (kjører) eller Review er eldre enn p85 for klassen. Kjører: tiden
 * siden start mot p85 av arbeidstiden (start til levert). Review: tiden siden start mot p85 av hele syklusen (start
 * til ferdig). Grensene er koStatistikk.aldersGrenser; en klasse uten grense (for få ferdige) markeres ikke.
 * @returns {{ maal: 'arbeid'|'syklus', grense: number, alder: number } | null} minutter
 */
function aldrende(o, aldersgrenser, naa = Date.now()) {
  const maal = o.status === 'kjorer' ? 'arbeid' : o.status === 'review' ? 'syklus' : null;
  const start = Date.parse(o.startet ?? o.plukket_at ?? '');
  const grense = aldersgrenser?.[o.klasse]?.[maal];
  if (!maal || !Number.isFinite(start) || !(grense > 0)) return null;
  const alder = Math.round((naa - start) / 60_000);
  return alder > grense ? { maal, grense, alder } : null;
}

/**
 * Tavla: kort per kolonne, WIP og prosjektbaner, og «Neste opp» og «Venter på deg».
 * @param {object} ko køen (ko.json)
 * @param {{ naa?: number, ucommittet?: string[], grener?: Record<string, { commits: number, sisteCommit: string|null }>,
 *   aldersgrenser?: object, dagsforbruk?: number, grenPrefiks?: string }} valg
 *   `ucommittet`: stiene `git status` viser i hovedtreet (som `ko.mjs vis`). `grener`: commits på <grenPrefiks><id> for plukkede
 *   oppgaver (til «gammel»). `aldersgrenser`: koStatistikk.aldersGrenser (aldrende arbeid). `dagsforbruk`: USD i dag
 *   (bare når en dagskvote er satt; til «Neste opp»). `sky`: { pushetHead, endret, oppdrag(o) → { tekst, sti } }
 *   (<remote>/<basegren>, stiene endret lokalt siden den, oppdragsteksten) til koLogikk.skyEgnet på kortene i kø og i
 *   skyøkter. Uten `sky` får kortene ingen egnethet.
 */
function tavle(
  ko,
  {
    naa = Date.now(),
    ucommittet = [],
    grener = {},
    aldersgrenser = {},
    dagsforbruk,
    sky,
    grenPrefiks = GREN_PREFIKS,
  } = {},
) {
  const oppgaver = ko.oppgaver ?? [];
  const register = ko.prosjekter ?? {};
  const baner = prosjektBaner(ko);
  const fargeFor = new Map(baner.map((b) => [b.pid, b.farge]));
  const kart = kjedeKart(oppgaver);
  // Gruppene i samlekøen med sum mot målet (koLogikk.samleGrupper, samme som ko.mjs samle).
  const samlekoen = L.samleGrupper(ko);
  // Fokuskonteksten (trinn, dratt med) regnes én gang for hele tavla, som i ko.mjs vis.
  const fk = L.rangeringKontekst(ko, naa);
  const plassFor = (o) => {
    const p = L.fokusPlass(o, fk);
    return {
      sort: p.trinn,
      steg: p.steg,
      dratt_av: p.dratt_av,
      utenfor: fk.gjelder ? p.utenfor : false,
      ut: p.ut,
      grunn: p.grunn,
      nr: null,
      av: null,
    };
  };

  const kort = (o) => {
    const pid = L.prosjektFor(o, register);
    const venter = o.status === 'venter';
    // Hindringene som `ko.mjs vis` viser dem: pause først, ellers ucommittet eierfil når ingenting annet stopper.
    let hindringer = [];
    if (venter) {
      hindringer = L.hindringerMedPause(o, ko, fk);
      const u = hindringer.length ? null : L.ucommittetKollisjon(o, ucommittet);
      if (u) hindringer = [`fil ${u.sti} er ucommittet i hovedtreet`];
    }
    const start = o.startet ?? o.plukket_at ?? (L.erEksternRad(o) ? o.lagt_til : null) ?? null;
    // «gammel»: køens 72 t-regel for plukkede (erGammelPlukk) og for registreringer utenfor køen. Kjørende og review
    // markeres i stedet mot p85 for klassen (aldrende).
    let gammel = false;
    if (o.status === 'plukket') {
      gammel = L.erGammelPlukk(o, grener[grenFor(o, grenPrefiks)] ?? {}, naa);
    } else if (start && L.erEksternRad(o)) {
      gammel = naa - Date.parse(start) > L.GAMMEL_PLUKK_MS;
    }
    const aldring = L.erEksternRad(o) ? null : aldrende(o, aldersgrenser, naa);
    const las = laaserOpp(ko, o.id, kart);
    const k = { for: forgjengere(o.id, kart), etter: las.ider }; // = kjede(ko, o.id), uten å regne to ganger
    const ferdigMs = o.ferdig ? Date.parse(o.ferdig) : NaN;
    // Egnet for sky? Bare for kort i kø og i skyøkter (resten kan ikke sendes dit uansett).
    let skyEgnet = null;
    if (sky && (venter || L.erSky(o))) {
      const opp = sky.oppdrag(o);
      skyEgnet = L.skyEgnet(ko, o.id, {
        pushetHead: sky.pushetHead,
        endret: sky.endret,
        oppdragTekst: opp.tekst,
        egenSti: opp.sti,
      });
    }
    return {
      id: o.id,
      tittel: o.tittel ?? '',
      status: o.status,
      klasse: o.klasse ?? null,
      domene: o.domene ?? null,
      anslag: L.anslag(o),
      nytte: Number(o.nytte ?? 5),
      prosjekt: pid,
      farge: fargeFor.get(pid) ?? UTEN_PROSJEKT_FARGE,
      funksjon: typeof o.funksjon === 'string' && o.funksjon.trim() ? o.funksjon.trim() : null,
      // Planposten oppgaven hører til, for merket på kortet og filteret «Planpost».
      plan: typeof o.plan === 'string' && o.plan ? o.plan : null,
      etiketter: Array.isArray(o.etiketter) ? o.etiketter : [],
      visuell: L.harEtikett(o, 'visuell'),
      avhenger: o.avhenger ?? [],
      venter_paa: (o.venter_paa ?? []).map((sp) => ({
        sp,
        avklart: (ko.avklart ?? []).includes(sp),
      })),
      eier_filer: o.eier_filer ?? [],
      eier_db: o.eier_db ?? [],
      merknader: merknaderFor(o),
      kilde: o.kilde ?? null,
      lagt_til_av: o.lagt_til_av ?? null,
      prioritet_tillegg: Number(o.prioritet_tillegg ?? 0) || 0,
      gren: grenFor(o, grenPrefiks),
      migr_blokk: o.migr_blokk ?? null,
      score: venter ? L.score(o, oppgaver, naa, register) : null,
      // «Plassering» i detaljpanelet: hva poengene består av, og fokustrinnet (koLogikk.fokusPlass, samme
      // kilde som velgNeste). `nr`/`av` (plass blant de klare i trinnet) fylles inn etter sorteringen under.
      score_deler: venter ? L.scoreDeler(o, oppgaver, naa, register) : null,
      plass: venter ? plassFor(o) : null,
      omrade: L.omradeFor(o, ko),
      lagt_til: o.lagt_til ?? null,
      klar: venter && hindringer.length === 0,
      samles: L.erSamles(o),
      // «på vent» (koLogikk.parkertNaa: en parkering med passert dato teller ikke).
      parkert:
        o.parkert && L.parkertNaa(o, naa)
          ? { grunn: o.parkert.grunn ?? null, til: o.parkert.til ?? null, av: o.parkert.av ?? null }
          : null,
      hindringer,
      start,
      gammel,
      aldrende: aldring,
      // «Låser opp N» og kjeden (bare når de finnes, så svaret ikke vokser for kort uten kjede).
      laaser_opp: las.antall
        ? { antall: las.antall, minutter: las.minutter, direkte: las.direkte }
        : null,
      kjede: k.for.length || k.etter.length ? k : null,
      plukket_av: o.plukket_av ?? null,
      ekstern_navn: o.ekstern_navn ?? null,
      levert: o.levert ?? null,
      ferdig: o.ferdig ?? null,
      nylig:
        o.status === 'ferdig' &&
        ((Number.isFinite(ferdigMs) && naa - ferdigMs <= NYLIG_MS) || o.qa_status === 'venter'),
      qa_status: o.qa_status ?? null,
      qa_notat: o.qa_notat ?? null,
      sky: skyEgnet,
      i_sky: L.erSky(o),
      sky_okt: o.sky
        ? {
            startet: o.sky.startet ?? null,
            kjoring: o.sky.kjoring ?? null,
            ferdig: o.sky.ferdig ?? null,
            gren: o.sky.gren ?? null,
          }
        : null,
    };
  };

  const kolonner = { ko: [], forslag: [], samle: [], pagar: [], review: [], bygget: [] };
  for (const o of oppgaver) {
    const k = kolonneFor(o);
    if (k) kolonner[k].push(kort(o));
  }
  const tid = (s) => (s ? Date.parse(s) || 0 : 0);
  // I kø: klare nå øverst, begge deler etter køens rangering (koLogikk.rangering: fokustrinn, så prioritet, så id, som
  // velgNeste). Uten fokus er trinnet 0 for alle som ikke er parkert, så rekkefølgen er bare prioritet og id.
  kolonner.ko.sort(
    (a, b) =>
      Number(b.klar) - Number(a.klar) ||
      a.plass.sort - b.plass.sort ||
      b.score - a.score ||
      a.id.localeCompare(b.id),
  );
  // «nr. 4 av 38 klare i trinnet» (Plassering): plassen blant de klare med samme trinn.
  const klarePerTrinn = new Map();
  for (const k of kolonner.ko) {
    if (!k.klar) continue;
    const nokkel = k.plass.steg ?? 'resten';
    if (!klarePerTrinn.has(nokkel)) klarePerTrinn.set(nokkel, []);
    klarePerTrinn.get(nokkel).push(k);
  }
  for (const liste of klarePerTrinn.values())
    liste.forEach((k, i) => {
      k.plass.nr = i + 1;
      k.plass.av = liste.length;
    });
  kolonner.forslag.sort((a, b) => b.nytte - a.nytte || a.id.localeCompare(b.id));
  // Samlekøens rekkefølge er gruppenes (samleGrupper: prosjekt → klasse, funksjon, id).
  const samleRekke = new Map(
    samlekoen.flatMap((g) => g.oppgaver.map((x) => x.id)).map((id, i) => [id, i]),
  );
  kolonner.samle.sort((a, b) => (samleRekke.get(a.id) ?? 0) - (samleRekke.get(b.id) ?? 0));
  kolonner.pagar.sort((a, b) => tid(a.start) - tid(b.start) || a.id.localeCompare(b.id));
  kolonner.review.sort((a, b) => tid(a.levert) - tid(b.levert) || a.id.localeCompare(b.id));
  kolonner.bygget.sort((a, b) => tid(b.ferdig) - tid(a.ferdig) || a.id.localeCompare(b.id));
  const neste = nesteOpp(ko, { naa, ucommittet, dagsforbruk });

  return {
    wip: wip(ko),
    grenser: { ...L.STANDARD_GRENSER, ...(ko.grenser ?? {}) },
    // Nattpausen vises i Pågår-hodet når den stopper nye starter nå.
    natt: L.nattVakt(ko, naa),
    prosjekter: baner,
    kolonner,
    // Gruppene (pid, klasse, maal, sum, klar, over, oppgaver …); kortene står i kolonner.samle.
    samlekoen,
    // Det køen ville startet nå, og det som venter på eieren.
    neste,
    innboks: innboks(ko, kolonner, { kart, kontekst: fk }),
    // Fokuslinja, områdene og grunnlaget for planvisningen.
    fokus: fokusLinje(ko, { naa, kontekst: fk, kanStarte: neste.starter.map((v) => v.id) }),
    omrader: L.omradeOversikt(ko, naa).map((r) => ({
      oid: r.oid,
      tittel: r.tittel,
      beskrivelse: r.beskrivelse,
      i_register: r.i_register,
      prosjekter: r.prosjekter,
    })),
    plan: planGrunnlag(ko, { naa, kontekst: fk }),
    // Køens versjon (tavla sender den tilbake som --forvent-endret) og den siste posten i endringsloggen
    // som kan angres («Angre siste»).
    endret: ko.endret ?? null,
    angre: angreSammendrag(ko),
  };
}

/** Den siste posten i endringsloggen som ikke er angret, kort (til «Angre siste»), eller null. */
function angreSammendrag(ko) {
  const p = L.sisteAngrbare(ko);
  if (!p) return null;
  const ider = new Set((p.endringer ?? []).filter((e) => e.id).map((e) => e.id));
  return {
    nr: p.nr,
    handling: p.handling,
    av: p.av,
    at: p.at,
    felt: (p.endringer ?? []).length,
    oppgaver: ider.size,
  };
}

/**
 * «Neste opp»: det køen ville startet nå, med koLogikk.startVakt (dagskvote, nattpause) og
 * koLogikk.velgNeste (grenser, pause, hindringer, ucommittede filer) direkte, aldri en egen kopi. Er det ledige
 * plasser, er `starter` de velgNeste starter nå (høyst så mange som er ledige). Er plassene fulle, er `naarLedig` de
 * NESTE_NAAR_FULL neste (velgNeste med så mange plasser til). Stopper køen, står grunnen i `stopp` og `tekst`.
 * @returns {{ stopp: null|'dagsbudsjett'|'nattpause'|'maksSamtidig', tekst: string|null, melding: string|null,
 *   ledige: number, starter: object[], naarLedig: object[] }}
 */
function nesteOpp(ko, { naa = Date.now(), ucommittet = [], dagsforbruk } = {}) {
  const bruk = L.plassBruk(ko);
  const g = bruk.grenser;
  const ledige = Math.max(0, bruk.ledige);
  const perId = new Map((ko.oppgaver ?? []).map((o) => [o.id, o]));
  const medTittel = (liste) => liste.map((v) => ({ ...v, tittel: perId.get(v.id)?.tittel ?? '' }));
  const tom = { ledige, starter: [], naarLedig: [] };
  const vakt = L.startVakt(ko, dagsforbruk, { naa });
  if (vakt?.stopp === 'dagsbudsjett')
    return {
      ...tom,
      stopp: vakt.stopp,
      tekst: 'Dagskvoten er brukt opp: ingen nye starter i dag.',
      melding: vakt.melding,
    };
  if (vakt?.stopp === 'nattpause')
    return {
      ...tom,
      stopp: vakt.stopp,
      tekst: `Nattpause til ${L.nattVakt(ko, naa).til}: ingen nye starter.`,
      melding: vakt.melding,
    };
  if (!(Number(g.maksSamtidig) > 0))
    return {
      ...tom,
      stopp: 'maksSamtidig',
      tekst: 'Samtidige spor er satt til 0: køen starter ingenting.',
      melding: 'Sett samtidige spor over 0 i innstillingene (tannhjulet) for å starte køen igjen.',
    };
  if (ledige > 0)
    return {
      ...tom,
      stopp: null,
      tekst: null,
      melding: null,
      starter: medTittel(L.velgNeste(ko, naa, { ucommittet })),
    };
  const merPlass = { ...ko, grenser: { ...g, maksSamtidig: bruk.agenter + NESTE_NAAR_FULL } };
  return {
    ...tom,
    stopp: null,
    tekst: null,
    melding: null,
    naarLedig: medTittel(L.velgNeste(merPlass, naa, { ucommittet })),
  };
}

/**
 * «Venter på deg»: det som venter på eieren, i fire deler.
 *   - sporsmal: åpne eierspørsmål (ikke avklart) som en ventende oppgave venter på, eller som er registrert i
 *     `sporsmal`. Sortert etter hvor mye svaret låser opp: oppgavene som venter direkte pluss etterfølgerne deres
 *     (koLogikk.etterfolgere), og summen av anslagene.
 *   - qa: ferdige med `qa_status: venter` gruppert prosjekt → funksjon (koLogikk.qaListe).
 *   - forslag: oppgaver som må godkjennes.
 *   - henger: kjørende og review over p85 for klassen, og plukkede som er gamle (72 t-regelen).
 * `ulogget` (svar som ikke er ført i beslutningsloggen) er info til orkestratoren og telles ikke i `antall`.
 * @param {object} kolonner tavlas kolonner (kortene har aldrende og gammel)
 */
function innboks(ko, kolonner, { kart = kjedeKart(ko.oppgaver ?? []), kontekst = null } = {}) {
  const oppgaver = ko.oppgaver ?? [];
  const register = ko.prosjekter ?? {};
  const avklart = new Set(ko.avklart ?? []);
  // Med fokus sorteres spørsmålene etter hva svaret låser opp I FOKUS (trinn 1 først), ikke i hele køen.
  const fk = kontekst ?? L.rangeringKontekst(ko);
  const antTrinn = fk.gjelder ? (ko.fokus?.rekkefolge?.length ?? 0) : 0;
  const direkte = new Map();
  for (const o of oppgaver) {
    if (o.status !== 'venter') continue;
    for (const sp of o.venter_paa ?? []) {
      if (avklart.has(sp)) continue;
      if (!direkte.has(sp)) direkte.set(sp, new Set());
      direkte.get(sp).add(o.id);
    }
  }
  for (const sp of Object.keys(ko.sporsmal ?? {}))
    if (!avklart.has(sp) && !direkte.has(sp)) direkte.set(sp, new Set());
  const sporsmal = [...direkte.entries()]
    .map(([sp, ider]) => {
      const alle = new Set(ider);
      for (const id of ider) for (const x of L.etterfolgere(id, oppgaver, kart.barn)) alle.add(x);
      const q = ko.sporsmal?.[sp];
      return {
        sp,
        type: q?.type ?? 'sporsmal',
        tekst: q?.tekst ?? null,
        anbefaling: q?.anbefaling ?? null,
        kilde: q?.kilde ?? null,
        direkte: [...ider].sort(),
        antall: alle.size,
        minutter: [...alle].reduce((sum, x) => sum + L.anslag(kart.perId.get(x) ?? {}), 0),
        prosjekter: [...new Set([...ider].map((x) => L.prosjektFor(kart.perId.get(x), register)))],
        fokus: antTrinn ? iFokus(alle) : null,
      };
    })
    .sort(
      (a, b) =>
        fokusSammenlign(a.fokus, b.fokus) ||
        b.antall - a.antall ||
        b.minutter - a.minutter ||
        a.sp.localeCompare(b.sp),
    );
  /** Det svaret låser opp i fokus: minutter og antall per trinn (ventende, ikke parkert), og summen. */
  function iFokus(ider) {
    const min = Array(antTrinn).fill(0);
    let antall = 0;
    for (const x of ider) {
      const o = kart.perId.get(x);
      if (!o || o.status !== 'venter') continue;
      const p = L.fokusPlass(o, fk);
      if (p.steg == null || p.parkert) continue;
      min[p.steg] += L.anslag(o);
      antall += 1;
    }
    return { per_trinn: min, antall, minutter: min.reduce((s, m) => s + m, 0) };
  }

  const qa = L.qaListe(ko).map((p) => ({
    pid: p.pid,
    tittel: p.tittel,
    funksjoner: p.funksjoner.map((f) => ({
      funksjon: f.funksjon,
      oppgaver: f.oppgaver.map((o) => ({
        id: o.id,
        tittel: o.tittel ?? '',
        ferdig: o.ferdig ?? null,
      })),
    })),
  }));
  const qaAntall = qa.reduce(
    (n, p) => n + p.funksjoner.reduce((m, f) => m + f.oppgaver.length, 0),
    0,
  );

  const forslag = (kolonner.forslag ?? []).map((k) => ({
    id: k.id,
    tittel: k.tittel,
    klasse: k.klasse,
    anslag: k.anslag,
    nytte: k.nytte,
    lagt_til_av: k.lagt_til_av,
  }));

  const henger = [...(kolonner.pagar ?? []), ...(kolonner.review ?? [])]
    .filter((k) => k.aldrende || (k.status === 'plukket' && k.gammel))
    .map((k) => ({
      id: k.id,
      tittel: k.tittel,
      status: k.status,
      klasse: k.klasse,
      start: k.start,
      plukket_av: k.plukket_av,
      aldrende: k.aldrende,
    }));

  const uloggede = L.ulogget(ko).map((x) => ({ sp: x.sp, tid: x.tid ?? null, av: x.av ?? null }));
  const sorter = sorterListe(ko);
  return {
    // «Sorter» telles ikke i antall: den er rydding, ikke noe som stopper køen (og uten prosjektregister ville alt
    // havnet der).
    antall: sporsmal.length + qaAntall + forslag.length + henger.length,
    // True når spørsmålene er sortert etter det de låser opp i fokus.
    fokus_sortert: antTrinn > 0,
    sporsmal,
    sorter,
    qa,
    qaAntall,
    forslag,
    henger,
    ulogget: uloggede,
  };
}

// ---- Fokus, planvisning, «Sorter» og områder ----------------------------------------------------------
// Reglene (trinn, dratt
// med, parkering, klassifisering) står i koLogikk; her er bare det tavla viser og forhåndsvisningene før skriving.

/**
 * Sammenligner to spørsmål etter det svaret låser opp i fokus: flest minutter i trinn 1, så trinn 2 osv. (trinn 1
 * vekter mest), så flest oppgaver i fokus. Uten fokus (null) er alle like.
 */
function fokusSammenlign(a, b) {
  if (!a || !b) return 0;
  for (let i = 0; i < Math.max(a.per_trinn.length, b.per_trinn.length); i += 1) {
    const d = (b.per_trinn[i] ?? 0) - (a.per_trinn[i] ?? 0);
    if (d) return d;
  }
  return b.antall - a.antall;
}

/** Statusene «Sorter»-lista viser (de samme som kan masseendres: venter og forslag). */
const SORTER_STATUSER = new Set(['venter', 'forslag']);

/**
 * Forslagene «Godta forslag» bruker: id → prosjekt (koLogikk.klassifiserKo: flytt, sorter med forslag, og uenig med
 * motforslag), bare for oppgaver som venter eller er forslag.
 * @returns {Map<string, string>}
 */
function sorterForslag(ko) {
  const ut = new Map();
  for (const r of sorterListe(ko)) if (r.forslag) ut.set(r.id, r.forslag);
  return ut;
}

/**
 * «Sorter»-lista: oppgaver uten prosjekt, med et usikkert forslag, eller der prosjektet strider mot sterke
 * signaler (koLogikk.klassifiserKo). Bare venter og forslag, sortert etter type (uenig, flytt, sorter) og id.
 * @returns {{ id: string, tittel: string|null, status: string, naa: string, forslag: string|null, type: string,
 *   grunn: string }[]}
 */
function sorterListe(ko) {
  // Uten prosjektregister finnes det ingenting å sortere etter.
  if (!Object.keys(ko.prosjekter ?? {}).length) return [];
  const k = L.klassifiserKo(ko);
  const orden = { uenig: 0, flytt: 1, sorter: 2 };
  return [...k.flytt, ...k.sorter]
    .filter((r) => SORTER_STATUSER.has(r.status))
    .map((r) => ({
      id: r.id,
      tittel: r.tittel,
      status: r.status,
      naa: r.naa,
      forslag: r.forslag,
      type: r.type,
      grunn: r.grunn,
    }))
    .sort((a, b) => orden[a.type] - orden[b.type] || a.id.localeCompare(b.id));
}

/**
 * Fokuslinja øverst på tavla og kolonnene «Nå» og «Neste» i planvisningen: koLogikk.fokusStatus pluss
 * trinnene med tittel og type, og delingen mellom Nå (de første `naa_antall` trinnene, standard 1) og Neste.
 * null når ingen fokus er satt.
 */
function fokusLinje(ko, { naa = Date.now(), kontekst = null, kanStarte = [] } = {}) {
  const st = L.fokusStatus(ko, { naa, kanStarte, kontekst });
  if (!st) return null;
  const f = ko.fokus;
  const rekke = st.rekkefolge;
  const n = Math.min(Math.max(Number(f.naa_antall) || 1, 1), Math.max(rekke.length, 1));
  return {
    ...st,
    fra: f.fra ?? null,
    satt_av: f.satt_av ?? null,
    dra_med: f.dra_med_avhengigheter !== false,
    naa_antall: n,
    trinn: rekke.map((t, i) => ({
      trinn: t,
      type: String(t).slice(0, String(t).indexOf(':')),
      tittel: L.trinnTittel(t, ko),
      venter: st.per_trinn[i]?.venter ?? 0,
      klare: st.per_trinn[i]?.klare ?? 0,
      min_igjen: st.per_trinn[i]?.min_igjen ?? 0,
    })),
    naa: rekke.slice(0, n),
    neste: rekke.slice(n),
  };
}

/**
 * Grunnlaget for planvisningen: per område og prosjekt (og funksjon i prosjektet) ventende oppgaver, klare
 * (ingen hindringer bortsett fra fokus og pause, altså klare om de kom i fokus), parkerte, minutter igjen, åpne
 * eierspørsmål og hvor mange som er dratt med i fokus. Samlekøen og forslag telles ikke (de startes ikke alene).
 * Områdene i registerets rekkefølge (koLogikk.omradeOversikt), `uten-omrade` sist.
 */
function planGrunnlag(ko, { naa = Date.now(), kontekst = null } = {}) {
  const fk = kontekst ?? L.rangeringKontekst(ko, naa);
  const oppgaver = ko.oppgaver ?? [];
  const register = ko.prosjekter ?? {};
  const tom = () => ({
    venter: 0,
    klare: 0,
    parkert: 0,
    aktive: 0,
    min_igjen: 0,
    sp: new Set(),
    dratt: 0,
  });
  const perProsjekt = new Map();
  const perFunksjon = new Map();
  const tellRad = (r, o) => {
    if (['kjorer', 'review', 'plukket'].includes(o.status)) {
      r.aktive += 1;
      return;
    }
    r.venter += 1;
    r.min_igjen += L.anslag(o);
    if (L.parkertNaa(o, naa)) r.parkert += 1;
    else if (L.hindringer(o, oppgaver, ko.avklart).length === 0) r.klare += 1;
    for (const s of L.aapneSporsmal(o, ko.avklart)) r.sp.add(s);
    if (fk.dratt.has(o.id)) r.dratt += 1;
  };
  for (const o of oppgaver) {
    if (L.erEksternRad(o)) continue;
    const aktiv = ['kjorer', 'review', 'plukket'].includes(o.status);
    if (!aktiv && (o.status !== 'venter' || L.erSamles(o))) continue;
    const pid = L.prosjektFor(o, register);
    if (!perProsjekt.has(pid)) perProsjekt.set(pid, tom());
    tellRad(perProsjekt.get(pid), o);
    if (aktiv) continue;
    const navn = typeof o.funksjon === 'string' && o.funksjon.trim() ? o.funksjon.trim() : null;
    if (!navn) continue;
    const nokkel = `${pid}/${navn}`;
    if (!perFunksjon.has(nokkel)) perFunksjon.set(nokkel, { pid, navn, ...tom() });
    tellRad(perFunksjon.get(nokkel), o);
  }
  const ut = (r) => ({
    venter: r.venter,
    klare: r.klare,
    parkert: r.parkert,
    aktive: r.aktive,
    min_igjen: r.min_igjen,
    sporsmal: r.sp.size,
    dratt: r.dratt,
  });
  const prosjekter = L.prosjektOversikt(ko).map((p) => {
    const r = perProsjekt.get(p.pid) ?? tom();
    return {
      pid: p.pid,
      tittel: p.tittel ?? null,
      omrade: L.omradeFor({ prosjekt: p.pid }, ko),
      pause: p.pause === true,
      flyttbar: p.i_register === true,
      ...ut(r),
      funksjoner: [...perFunksjon.values()]
        .filter((f) => f.pid === p.pid)
        .sort((a, b) => b.venter - a.venter || a.navn.localeCompare(b.navn, 'nb'))
        .map((f) => ({ navn: f.navn, trinn: `funksjon:${p.pid}/${f.navn}`, ...ut(f) })),
    };
  });
  const omrader = L.omradeOversikt(ko, naa).map((o) => {
    const mine = prosjekter.filter((p) => p.omrade === o.oid);
    const sp = new Set();
    for (const p of mine)
      for (const x of oppgaver)
        if (
          x.status === 'venter' &&
          !L.erSamles(x) &&
          !L.erEksternRad(x) &&
          L.prosjektFor(x, register) === p.pid
        )
          for (const s of L.aapneSporsmal(x, ko.avklart)) sp.add(s);
    const sum = (felt) => mine.reduce((s, p) => s + p[felt], 0);
    return {
      oid: o.oid,
      tittel: o.tittel,
      i_register: o.i_register,
      prosjekter: mine.map((p) => p.pid),
      venter: sum('venter'),
      klare: sum('klare'),
      parkert: sum('parkert'),
      aktive: sum('aktive'),
      min_igjen: sum('min_igjen'),
      sporsmal: sp.size,
      dratt: sum('dratt'),
    };
  });
  return { omrader, prosjekter };
}

/** «3 t 20 min» / «45 min» (forhåndsvisningene). */
function minutterTekst(min) {
  const m = Math.round(Number(min) || 0);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} t${m % 60 ? ` ${m % 60} min` : ''}`;
}

/**
 * Forhåndsvisningen av «Lagre fokus» fra planvisningen (POST /api/fokus med torr): koLogikk.lagreFokusPlan på en kopi
 * av køen (samme regler som `ko.mjs fokus lagre`), og hva det gir: fokus før og etter, trinnene med tall, hva som
 * skjer med resten, hvor mange som dras med, pause-endringene og «Neste opp» etter lagring. Skriver ingenting.
 * @param {object} inn { rekkefolge, naa_antall?, resten?, til?, navn?, dra_med_avhengigheter?, pause?, fortsett? }
 * @returns {{ feil: string[], advarsler: string[], linjer: string[], for_tekst: string, etter_tekst: string,
 *   neste: { id: string, tittel: string }[], neste_tekst: string|null }}
 */
function fokusForhandsvisning(ko, inn, { naa = Date.now(), ucommittet = [] } = {}) {
  const kopi = L.klonJson(ko);
  const r = L.lagreFokusPlan(kopi, inn, new Date(naa).toISOString());
  const forTekst = ko.fokus ? L.fokusTekst(ko) : 'ingen fokus';
  if (r.feil.length)
    return {
      feil: r.feil,
      advarsler: r.advarsler ?? [],
      linjer: [],
      for_tekst: forTekst,
      etter_tekst: forTekst,
      neste: [],
      neste_tekst: null,
    };
  const linjer = [];
  const k = L.rangeringKontekst(kopi, naa);
  const st = L.fokusStatus(kopi, { naa, kontekst: k });
  if (!kopi.fokus) {
    linjer.push(
      r.fjernet
        ? 'Fokuset fjernes: køen går etter poeng og prosjekttillegg, som før fokus fantes.'
        : 'Ingen fokus: køen går etter poeng og prosjekttillegg.',
    );
  } else {
    const deler = fokusLinje(kopi, { naa, kontekst: k });
    deler.trinn.forEach((t, i) =>
      linjer.push(
        `${i < deler.naa_antall ? 'Nå' : 'Neste'}, trinn ${i + 1}: ${t.tittel} (${t.type}): ` +
          `${t.venter} venter, ${t.klare} klare, ${minutterTekst(t.min_igjen)} igjen.`,
      ),
    );
    let utenfor = 0;
    for (const o of kopi.oppgaver ?? []) {
      if (o.status !== 'venter' || L.erSamles(o) || L.erEksternRad(o)) continue;
      const p = L.fokusPlass(o, k);
      if (p.utenfor && !p.parkert) utenfor += 1;
    }
    linjer.push(
      kopi.fokus.resten === 'fyll'
        ? `Resten (${utenfor} ventende utenfor trinnene) fyller ledige plasser bare når fokuset ikke har noe klart.`
        : `Resten (${utenfor} ventende utenfor trinnene) venter helt: de startes ikke før fokuset endres.`,
    );
    if (kopi.fokus.dra_med_avhengigheter !== false)
      linjer.push(
        st.dratt_med
          ? `${st.dratt_med} oppgave(r) utenfor trinnene dras med, fordi noe i fokus venter på dem.`
          : 'Ingen oppgaver utenfor trinnene trengs av fokuset nå.',
      );
    else linjer.push('Avhengigheter dras ikke med: fokus kan bli stående på noe utenfor trinnene.');
    linjer.push(
      kopi.fokus.til
        ? `Fokuset gjelder til og med ${String(kopi.fokus.til).slice(0, 10)}; etterpå får du varsel.`
        : 'Fokuset gjelder til du endrer det.',
    );
  }
  if (r.pauset.length)
    linjer.push(
      `Settes på pause: ${r.pauset.join(', ')} (startes ikke, heller ikke om de står i et trinn).`,
    );
  if (r.fortsatt.length) linjer.push(`Tas av pause: ${r.fortsatt.join(', ')}.`);
  const n = nesteOpp(kopi, { naa, ucommittet });
  const liste = n.starter.length ? n.starter : n.naarLedig;
  return {
    feil: [],
    advarsler: r.advarsler,
    linjer,
    for_tekst: forTekst,
    etter_tekst: kopi.fokus ? L.fokusTekst(kopi) : 'ingen fokus',
    neste: liste.map((v) => ({ id: v.id, tittel: v.tittel })),
    neste_tekst: n.stopp
      ? n.tekst
      : n.starter.length
        ? `Starter nå (${n.ledige} ledige plasser):`
        : n.naarLedig.length
          ? 'Neste når en plass blir ledig:'
          : 'Ingenting kan startes med dette fokuset nå.',
  };
}

/** Handlingene POST /api/omrade kan gjøre. */
const OMRADE_HANDLINGER = ['lagre', 'slett', 'flytt'];

/**
 * Områdene fra tavla (POST /api/omrade): oversetter handlingen til `ko.mjs omrade`-argumentene, prøver den på en kopi
 * (koLogikk.settOmrade, samme regler) og forklarer hva som endres. Skriver ingenting.
 *   lagre { oid, tittel, beskrivelse? }   opprett eller endre tittel/beskrivelse
 *   slett { oid }                          slett (nektes når et prosjekt eller fokuset bruker området)
 *   flytt { pid, oid|null }                flytt prosjektet til området (null = ut av området det står i)
 * @returns {{ feil: string[], args?: string[], linjer?: string[] }}
 */
function omradePlan(ko, b = {}) {
  const handling = String(b.handling ?? '');
  if (!OMRADE_HANDLINGER.includes(handling)) return { feil: [`ukjent handling ${handling}`] };
  const kopi = L.klonJson(ko);
  const register = ko.prosjekter ?? {};
  const fokusTrinn = (oid) => {
    const i = (ko.fokus?.rekkefolge ?? []).indexOf(`omrade:${oid}`);
    return i < 0 ? null : i + 1;
  };
  if (handling === 'flytt') {
    const pid = String(b.pid ?? '');
    if (!Object.hasOwn(register, pid)) return { feil: [`ukjent prosjekt ${pid}`] };
    const fra = register[pid]?.omrade ?? null;
    const til = b.oid == null || b.oid === '' ? null : String(b.oid);
    if (fra === til) return { feil: [`${pid} står allerede ${til ? `i ${til}` : 'uten område'}`] };
    const args = til ? ['omrade', til, '--prosjekter', pid] : ['omrade', fra, '--fjern', pid];
    const s = til
      ? L.settOmrade(kopi, til, { prosjekter: [pid] })
      : L.settOmrade(kopi, fra, { fjern: [pid] });
    if (s.feil.length) return { feil: s.feil };
    const linjer = [
      `Prosjektet ${pid} flyttes fra ${fra ?? 'uten område'} til ${til ?? 'uten område'}.`,
    ];
    const tf = fra ? fokusTrinn(fra) : null;
    const tt = til ? fokusTrinn(til) : null;
    if (tf || tt)
      linjer.push(
        `Oppgavene i ${pid} følger området: fra ${tf ? `trinn ${tf}` : 'utenfor fokus'} til ` +
          `${tt ? `trinn ${tt}` : 'utenfor fokus'} (med mindre prosjektet har eget trinn).`,
      );
    return { feil: [], args, linjer };
  }
  const oid = String(b.oid ?? '');
  if (handling === 'slett') {
    const s = L.settOmrade(kopi, oid, { slett: true });
    if (s.feil.length) return { feil: s.feil };
    return {
      feil: [],
      args: ['omrade', oid, '--slett'],
      linjer: [`Området ${oid} slettes. Ingen prosjekter eller trinn bruker det.`],
    };
  }
  const felt = { tittel: b.tittel == null ? null : String(b.tittel) };
  if (b.beskrivelse != null) felt.beskrivelse = String(b.beskrivelse) || null;
  const finnes = Object.hasOwn(ko.omrader ?? {}, oid);
  const s = L.settOmrade(kopi, oid, felt);
  if (s.feil.length) return { feil: s.feil };
  const args = ['omrade', oid, '--tittel', s.omrade.tittel];
  if ('beskrivelse' in felt) args.push('--beskrivelse', felt.beskrivelse ?? '');
  return {
    feil: [],
    args,
    linjer: [
      finnes
        ? `Området ${oid} får tittelen «${s.omrade.tittel}».`
        : `Nytt område ${oid} «${s.omrade.tittel}». Flytt prosjekter inn i det etterpå.`,
    ],
  };
}

/**
 * Nytt `prioritet_tillegg` for et kort i kø som eieren har flyttet. Landingsplassen er midt mellom naboenes
 * effektive prioritet (koLogikk.score, med deres egne tillegg og prosjektets tillegg). Kortets tillegg ERSTATTES:
 * tillegget = målet − kortets prioritet uten eget tillegg. Øverst/nederst: ett STEG forbi naboen. `topp`: over den
 * høyeste i hele køen. Prioriteten har to desimaler; ligger naboene tettere enn 0,02, kan kortet havne likt med en
 * av dem (lik prioritet ordnes etter id, som i køen).
 * @param {{ over?: string|null, under?: string|null, topp?: boolean }} plass naboen over og under etter flyttet
 * @returns {{ tillegg: number } | { feil: string }}
 */
function nyttTillegg(ko, id, { over = null, under = null, topp = false } = {}, naa = Date.now()) {
  const oppgaver = ko.oppgaver ?? [];
  const register = ko.prosjekter ?? {};
  const o = oppgaver.find((x) => x.id === id);
  if (!o) return { feil: `ukjent oppgave ${id}` };
  if (o.status !== 'venter')
    return { feil: `bare oppgaver i kø kan flyttes (${id} har status ${o.status})` };
  const eff = (x) => L.score(x, oppgaver, naa, register);
  const uten = L.score({ ...o, prioritet_tillegg: 0 }, oppgaver, naa, register);
  const nabo = (nid) => {
    if (nid == null) return { o: null };
    const n = oppgaver.find((x) => x.id === nid);
    if (!n) return { feil: `ukjent nabo ${nid}` };
    if (n.id === id) return { feil: `${id} kan ikke være sin egen nabo` };
    if (n.status !== 'venter') return { feil: `naboen ${nid} er ikke i kø (status ${n.status})` };
    return { o: n };
  };
  let maal;
  if (topp) {
    const andre = oppgaver.filter((x) => x.status === 'venter' && x.id !== id);
    if (!andre.length) return { tillegg: Number(o.prioritet_tillegg ?? 0) || 0 };
    maal = Math.max(...andre.map(eff)) + STEG;
  } else {
    const a = nabo(over);
    if (a.feil) return { feil: a.feil };
    const b = nabo(under);
    if (b.feil) return { feil: b.feil };
    if (!a.o && !b.o) return { feil: 'flyttet mangler naboer (over eller under)' };
    if (a.o && b.o) maal = (eff(a.o) + eff(b.o)) / 2;
    else if (a.o) maal = eff(a.o) - STEG;
    else maal = eff(b.o) + STEG;
  }
  return { tillegg: rund2(maal - uten) };
}

/**
 * Nye `prioritet_tillegg` for prosjekter når eieren drar en prosjektbane. `baner` er de flyttbare banene i
 * rekkefølgen tavla viser dem (prosjektBaner, uten `uten-prosjekt`). Bare den flyttede banen endres når det er rom
 * (heltall midt mellom naboene). Står naboene likt (eller 1 fra hverandre), forskyves den minste siden med STEG, så
 * de andre prosjektene beholder rekkefølgen seg imellom. Øverst/nederst: ett STEG forbi naboen.
 * @param {{ pid: string, prioritet_tillegg: number }[]} baner
 * @param {{ over?: string|null, under?: string|null }} plass nabobanen over og under etter flyttet
 * @returns {{ endringer: Record<string, number> } | { feil: string }}
 */
function baneTillegg(baner, pid, { over = null, under = null } = {}) {
  const t = (b) => Number(b.prioritet_tillegg) || 0;
  if (!baner.some((b) => b.pid === pid)) return { feil: `ukjent eller låst prosjektbane ${pid}` };
  const andre = baner.filter((b) => b.pid !== pid);
  for (const n of [over, under]) {
    if (n != null && !andre.some((b) => b.pid === n)) return { feil: `ukjent nabobane ${n}` };
  }
  if (over == null && under == null) return { feil: 'flyttet mangler naboer (over eller under)' };
  // Plassen i lista uten den flyttede banen: rett før `under`, ellers rett etter `over`.
  const idx =
    under != null
      ? andre.findIndex((b) => b.pid === under)
      : andre.findIndex((b) => b.pid === over) + 1;
  const A = andre[idx - 1];
  const B = andre[idx];
  const endringer = {};
  if (!A) endringer[pid] = t(B) + STEG;
  else if (!B) endringer[pid] = t(A) - STEG;
  else if (t(A) - t(B) >= 2) endringer[pid] = Math.round((t(A) + t(B)) / 2);
  else if (idx <= andre.length - idx) {
    // Færre baner over: løft dem (og A) ett STEG; den flyttede lander midt mellom.
    for (const b of andre.slice(0, idx)) endringer[b.pid] = t(b) + STEG;
    endringer[pid] = t(B) + STEG / 2;
  } else {
    // Færre baner under: senk dem (og B) ett STEG.
    for (const b of andre.slice(idx)) endringer[b.pid] = t(b) - STEG;
    endringer[pid] = t(A) - STEG / 2;
  }
  return { endringer };
}

/**
 * «Løft avhengighetene også»: kortet `id` flyttes som i nyttTillegg, og de åpne avhengighetene som står
 * i kø UNDER den nye plassen, legges rett over kortet (mellom kortet og naboen over, i den rekkefølgen de står nå).
 * En avhengighet som alt står over, røres ikke (løft, aldri senk). Serveren skriver alt i ett endre-mange-kall.
 * @param {{ over?: string|null, under?: string|null, topp?: boolean }} plass
 * @returns {{ endringer: Record<string, number> } | { feil: string }}
 */
function loftTillegg(ko, id, plass = {}, naa = Date.now()) {
  const r = nyttTillegg(ko, id, plass, naa);
  if (r.feil) return r;
  const oppgaver = ko.oppgaver ?? [];
  const register = ko.prosjekter ?? {};
  const perId = new Map(oppgaver.map((x) => [x.id, x]));
  const eff = (x) => L.score(x, oppgaver, naa, register);
  const uten = (x) => L.score({ ...x, prioritet_tillegg: 0 }, oppgaver, naa, register);
  const o = perId.get(id);
  const sX = uten(o) + r.tillegg;
  const over = !plass.topp && plass.over ? perId.get(plass.over) : null;
  const sOver = over ? eff(over) : null;
  const deps = L.hindringDeler(o, oppgaver, ko.avklart)
    .filter((h) => h.type === 'avhenger' && perId.get(h.id)?.status === 'venter')
    .map((h) => perId.get(h.id))
    .filter((d) => eff(d) <= sX)
    .sort((a, b) => eff(b) - eff(a) || a.id.localeCompare(b.id));
  const endringer = { [id]: r.tillegg };
  const n = deps.length;
  deps.forEach((d, i) => {
    // Jevnt fordelt mellom kortet og naboen over; uten nabo over: innenfor ett STEG over kortet.
    const rom = sOver != null ? sOver - sX : STEG;
    endringer[d.id] = rund2(sX + (rom * (n - i)) / (n + 1) - uten(d));
  });
  return { endringer };
}

// ---- Vaktregler --------------------------------------------------------------------------------------

/** Sparemodus: anbefalingen i innstillingspanelet og grensen for regel 10. */
const SPAREMODUS = { maksSamtidig: 5, maksDPluss: 2 };

/** «A», «A og B», «A, B og C». */
function ogListe(xs) {
  const l = [...xs];
  return l.length <= 1 ? (l[0] ?? '') : `${l.slice(0, -1).join(', ')} og ${l[l.length - 1]}`;
}
const usdTekst = (x) => `${Number(x ?? 0).toFixed(2)} USD`;

/**
 * Enkle varsler før en flytting eller handling på tavla lager problemer. Hindringene hentes fra koLogikk
 * (hindringDeler, prosjektPauset, plassBruk, tolkGrense), aldri fra en egen kopi. ko.mjs er fortsatt sannheten og
 * nekter selv det den nekter; dette er bare varsler i forkant.
 *   stopp    → serveren svarer 422 og gjør ingenting,
 *   advarsel → serveren svarer 409 til kallet sender `bekreft: true`,
 *   info     → handlingen gjøres, og tekstene vises etterpå.
 * @param {object} ko køen
 * @param {{ type: string, id?: string, pid?: string, over?: string|null, under?: string|null, topp?: boolean,
 *   tekst?: string, navn?: string, verdi?: string }} handling
 * @param {{ naa?: number, forbrukIdag?: number, grener?: Record<string, { commits: number }>,
 *   orkestrator?: { aktiv: boolean } }} [kontekst]
 * @returns {{ nivaa: 'info'|'advarsel'|'stopp', tekst: string, forslag?: { tekst: string, felt: object } }[]}
 */
function vurder(ko, handling = {}, kontekst = {}) {
  const naa = kontekst.naa ?? Date.now();
  const oppgaver = ko.oppgaver ?? [];
  const register = ko.prosjekter ?? {};
  const ut = [];
  const legg = (nivaa, tekst, forslag) =>
    ut.push(forslag ? { nivaa, tekst, forslag } : { nivaa, tekst });
  const finn = (id) => oppgaver.find((x) => x.id === id);

  if (handling.type === 'flytt') {
    const o = finn(handling.id);
    if (!o || o.status !== 'venter') return ut;
    // Reglene gjelder når kortet flyttes FRAM i køen (høyere prioritet); ned eller på samme plass varsler ingenting.
    const r = nyttTillegg(ko, o.id, handling, naa);
    if (r.feil || r.tillegg <= (Number(o.prioritet_tillegg ?? 0) || 0)) return ut;
    const deler = L.hindringDeler(o, oppgaver, ko.avklart);
    // 1. Avhengighet ikke ferdig.
    const deps = deler.filter((h) => h.type === 'avhenger').map((h) => h.id);
    if (deps.length) {
      const l = loftTillegg(ko, o.id, handling, naa);
      const kanLoftes = !!l.endringer && Object.keys(l.endringer).length > 1;
      legg(
        'advarsel',
        `${o.id} kan ikke starte før ${ogListe(deps)} er ${deps.length > 1 ? 'ferdige' : 'ferdig'}.`,
        kanLoftes ? { tekst: 'Løft avhengighetene også', felt: { loft: true } } : undefined,
      );
    }
    // 2. Venter på eierspørsmål.
    const sp = deler.filter((h) => h.type === 'sporsmal').map((h) => h.sp);
    if (sp.length) legg('advarsel', `${o.id} venter på svaret ditt på ${ogListe(sp)}.`);
    // 3. Eierfil (eller DB-funksjon, delt patch) deles med noe som er i gang.
    const sett = new Set();
    for (const h of deler.filter((x) => x.type === 'konflikt')) {
      const k = h.konflikt;
      if (sett.has(k.med)) continue;
      sett.add(k.med);
      const hva =
        k.type === 'fil'
          ? `fila ${k.navn}`
          : k.type === 'db'
            ? `DB-funksjonen ${k.navn}`
            : `den delte patchen ${k.navn}`;
      legg('info', `${o.id} deler ${hva} med ${k.med} og starter først når ${k.med} er ferdig.`);
    }
    // 4. Prosjektet står på pause.
    if (L.prosjektPauset(o, register))
      legg(
        'info',
        `Prosjektet ${L.prosjektFor(o, register)} står på pause: flyttingen virker først når prosjektet fortsetter.`,
      );
    // 5. Grense nådd (D+-plassene eller spor med migrasjoner).
    const bruk = L.plassBruk(ko);
    if (o.klasse === 'D+' && bruk.dPluss >= bruk.grenser.maksDPluss)
      legg(
        'info',
        `D+-plassene er fulle (${bruk.dPluss} av ${bruk.grenser.maksDPluss}): ${o.id} starter når en plass blir ledig.`,
      );
    if (L.harMigr(o) && bruk.db >= bruk.grenser.maksDb)
      legg(
        'info',
        `Grensen for spor med migrasjoner er nådd (${bruk.db} av ${bruk.grenser.maksDb}): ${o.id} starter når en plass blir ledig.`,
      );
    return ut;
  }

  if (handling.type === 'pause') {
    // 6. Pause et prosjekt med noe som pågår.
    const n = oppgaver.filter(
      (o) =>
        !L.erEksternRad(o) &&
        (o.status === 'kjorer' || o.status === 'plukket') &&
        L.prosjektFor(o, register) === handling.pid,
    ).length;
    if (n)
      legg('advarsel', `${n} pågår i ${handling.pid} og kjører ferdig; pausen stopper bare nye.`);
    return ut;
  }

  if (handling.type === 'slipp') {
    // 7. Slipp med commits på grenen.
    const o = finn(handling.id);
    if (!o) return ut;
    const gren = grenFor(o, kontekst.grenPrefiks ?? GREN_PREFIKS);
    const n = Number(kontekst.grener?.[gren]?.commits ?? 0);
    if (n > 0)
      legg(
        'advarsel',
        `Grenen ${gren} har ${n} ${n === 1 ? 'commit' : 'commits'} som blir liggende.`,
      );
    return ut;
  }

  if (handling.type === 'plukk') {
    // 8. Plukk: orkestratoren fletter, og en oppgave med migrasjoner får en migrasjonsblokk.
    const o = finn(handling.id);
    if (!o) return ut;
    if (kontekst.orkestrator?.aktiv)
      legg(
        'info',
        `En orkestrator er aktiv: lever når du er ferdig (ko.mjs lever ${o.id}), så fletter orkestratoren.`,
      );
    if (L.harMigr(o))
      legg(
        'info',
        `${o.id} har migrasjoner og får en migrasjonsblokk (${Number(o.migr_tiere)} tiere) når den plukkes.`,
      );
    return ut;
  }

  if (handling.type === 'qa-avvik') {
    // 9. QA-avvik uten tekst.
    if (!String(handling.tekst ?? '').trim())
      legg('stopp', 'Skriv hva som er galt, og hvor, før du melder QA-avvik.');
    return ut;
  }

  if (handling.type === 'avklar') {
    // 15. Svar på et eierspørsmål uten tekst: sporene bygger på svaret, så et tomt svar stopper.
    if (!String(handling.tekst ?? '').trim()) {
      const type = ko.sporsmal?.[handling.sp]?.type;
      legg(
        'stopp',
        type === 'betingelse' || type === 'jurist'
          ? 'Skriv hvordan betingelsen er oppfylt før du markerer den oppfylt.'
          : 'Skriv svaret før du avklarer: sporene som venter, bygger på det.',
      );
    }
    return ut;
  }

  if (handling.type === 'masse') {
    // 16. Massehandlinger fra valglinja, se vurderMasse.
    vurderMasse(ko, { ...handling, naa }, legg);
    return ut;
  }

  if (handling.type === 'grense') {
    const g = { ...L.STANDARD_GRENSER, ...(ko.grenser ?? {}) };
    const t = L.tolkGrense(handling.navn, handling.verdi, g);
    // En ugyldig verdi varsles ikke her: ko.mjs nekter med sin egen melding, som panelet viser.
    if ('feil' in t) return ut;
    const { navn } = handling;
    const v = t.verdi;
    // 10. Over sparemodus.
    if (
      (navn === 'maksSamtidig' && v > SPAREMODUS.maksSamtidig) ||
      (navn === 'maksDPluss' && v > SPAREMODUS.maksDPluss)
    )
      legg(
        'advarsel',
        `Over sparemodus (høyst ${SPAREMODUS.maksSamtidig} samtidige og ${SPAREMODUS.maksDPluss} D+): kvoten brukes raskere.`,
      );
    // 11. maksDb økes.
    if (navn === 'maksDb' && v > Number(g.maksDb))
      legg(
        'advarsel',
        'Flere spor med migrasjoner samtidig: databasen og tilkoblingspoolen må tåle parallelle tørrkjøringer.',
      );
    // 12. maksSamtidig = 0.
    if (navn === 'maksSamtidig' && v === 0)
      legg('advarsel', 'Med 0 samtidige stopper køen: ingen nye oppgaver startes.');
    // 13. Dagskvoten under dagens forbruk.
    const forbruk = Number(kontekst.forbrukIdag ?? 0);
    if (navn === 'dagsbudsjett' && v != null && forbruk >= v)
      legg(
        'advarsel',
        `Dagskvoten (${usdTekst(v)}) er alt brukt opp i dag (${usdTekst(forbruk)}): køen stopper nye oppgaver med en gang.`,
      );
    // 14. Nattkjøring av mens noe kjører.
    if (navn === 'nattkjoring' && v === false) {
      const n = oppgaver.filter((o) => o.status === 'kjorer').length;
      if (n) legg('info', `${n} kjører og går ferdig; nattpausen stopper bare nye.`);
    }
    return ut;
  }
  return ut;
}

// ---- Massehandlinger ---------------------------------------------------------------------------------
// Flervalg på tavla: eieren merker kort og gjør én ting med alle. Tavla sender id-lista eieren så (aldri et søk som
// serveren evaluerer på nytt), serveren forhåndsviser med `ko.mjs endre-mange --torr` (eller `ranger --torr`), og
// skriver med --forvent-endret når eieren bekrefter. Reglene (gyldige felt, samlekøen, parkering, rangering) står i
// koLogikk og håndheves av ko.mjs; her er bare oversettelsen fra handling til kommando, oppsummeringen og vaktreglene.

/** Høyst så mange id-er per kall (som QA og godkjenn). */
const MASSE_MAKS = 500;
/** Over så mange id-er krever massehandlingen en ekstra bekreftelse (advarsel). */
const MASSE_BEKREFT = 50;
/** Handlingene valglinja kan gjøre (verdien i `handling`). */
const MASSE_HANDLINGER = [
  'prosjekt',
  'funksjon',
  'parker',
  'fortsett',
  'ranger',
  'samle-inn',
  'samle-ut',
  'samle-pakk',
  'etikett-legg',
  'etikett-fjern',
  // «Godta forslag» i «Sorter»-lista: hver oppgave får prosjektet koLogikk.klassifiserKo foreslår.
  'godta-forslag',
];
/** Bare oppgaver med disse statusene kan masseendres (kjørende, review og ferdige eies av ko.mjs sine kommandoer). */
const MASSE_STATUSER = new Set(['venter', 'forslag']);
const MASSE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const MASSE_PID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATO = /^\d{4}-\d\d-\d\d$/;

/** Tekst fra tavla: kontrolltegn bort, trimmet og kuttet (ko.mjs validerer innholdet). */
const masseTekst = (x, maks) =>
  String(x ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maks);

/**
 * Oversetter en massehandling fra tavla til kommandoen som gjør den. Endrer ingenting.
 *   prosjekt     verdi { pid: string|null }       → endre-mange [{ id, prosjekt }] (null = tilbake til prefiks-regelen)
 *   funksjon     verdi { navn: string|null }      → endre-mange [{ id, funksjon }]
 *   parker       verdi { grunn?, til? }           → endre-mange [{ id, parkert: { grunn?, til? } | true }]
 *   fortsett                                      → endre-mange [{ id, parkert: null }] (bare de som er parkert)
 *   samle-inn / samle-ut                          → endre-mange [{ id, samles: true | false }]
 *   etikett-legg / etikett-fjern verdi { etikett } → endre-mange [{ id, etiketter }] (bare de som faktisk endres)
 *   ranger       verdi { plass: topp|bunn|over|under, ref? } → ko.mjs ranger
 *   samle-pakk   verdi { ny_id?, tittel? }        → ko.mjs samle pakk (ny id foreslås når den mangler)
 * @returns {{ feil: string[] } | { feil: [], kommando: 'endre-mange', innhold: object }
 *   | { feil: [], kommando: 'ranger', plass: object } | { feil: [], kommando: 'samle-pakk', nyId: string, tittel: string|null }}
 */
function massePlan(ko, handling, ider, verdi = {}) {
  const feil = [];
  const v = verdi && typeof verdi === 'object' ? verdi : {};
  if (!MASSE_HANDLINGER.includes(handling)) return { feil: [`ukjent massehandling ${handling}`] };
  const liste = Array.isArray(ider) ? ider.map(String) : [];
  if (!liste.length) feil.push('ingen oppgaver er merket');
  if (liste.length > MASSE_MAKS) feil.push(`høyst ${MASSE_MAKS} oppgaver per handling`);
  if (liste.some((id) => !MASSE_ID.test(id))) feil.push('ugyldig id i lista');
  if (new Set(liste).size !== liste.length) feil.push('samme id står flere ganger');
  if (feil.length) return { feil };
  const perId = new Map((ko.oppgaver ?? []).map((o) => [o.id, o]));
  const oppgaver = (felt) => ({ oppgaver: liste.map((id) => ({ id, ...felt(perId.get(id)) })) });

  if (handling === 'godta-forslag') {
    const forslag = sorterForslag(ko);
    const rader = liste
      .filter((id) => forslag.has(id))
      .map((id) => ({ id, prosjekt: forslag.get(id) }));
    if (!rader.length) return { feil: ['ingen av de merkede har et forslag til prosjekt'] };
    return { feil: [], kommando: 'endre-mange', innhold: { oppgaver: rader } };
  }
  if (handling === 'prosjekt') {
    const pid = v.pid == null || v.pid === '' ? null : String(v.pid);
    if (pid != null && !MASSE_PID.test(pid)) return { feil: ['ugyldig prosjekt-id'] };
    return { feil: [], kommando: 'endre-mange', innhold: oppgaver(() => ({ prosjekt: pid })) };
  }
  if (handling === 'funksjon') {
    const navn = v.navn == null ? null : masseTekst(v.navn, 80) || null;
    return { feil: [], kommando: 'endre-mange', innhold: oppgaver(() => ({ funksjon: navn })) };
  }
  if (handling === 'parker') {
    const grunn = masseTekst(v.grunn, 200);
    const til = v.til == null || v.til === '' ? null : String(v.til).trim();
    if (til != null && !DATO.test(til)) return { feil: ['datoen må være på formen ÅÅÅÅ-MM-DD'] };
    const p = grunn || til ? { ...(grunn ? { grunn } : {}), ...(til ? { til } : {}) } : true;
    return { feil: [], kommando: 'endre-mange', innhold: oppgaver(() => ({ parkert: p })) };
  }
  if (handling === 'fortsett') {
    const parkerte = liste.filter((id) => perId.get(id)?.parkert);
    if (!parkerte.length) return { feil: ['ingen av de merkede står på vent'] };
    return {
      feil: [],
      kommando: 'endre-mange',
      innhold: { oppgaver: parkerte.map((id) => ({ id, parkert: null })) },
    };
  }
  if (handling === 'samle-inn' || handling === 'samle-ut') {
    const inn = handling === 'samle-inn';
    return { feil: [], kommando: 'endre-mange', innhold: oppgaver(() => ({ samles: inn })) };
  }
  if (handling === 'etikett-legg' || handling === 'etikett-fjern') {
    const etikett = String(v.etikett ?? '')
      .trim()
      .toLowerCase();
    if (!L.ETIKETT_MONSTER.test(etikett))
      return { feil: ['etiketten må være ett kort ord i små bokstaver (f.eks. visuell)'] };
    const legg = handling === 'etikett-legg';
    const rader = [];
    for (const id of liste) {
      const naa = Array.isArray(perId.get(id)?.etiketter) ? perId.get(id).etiketter : [];
      if (legg === naa.includes(etikett)) continue; // allerede slik
      const ny = legg ? [...naa, etikett] : naa.filter((e) => e !== etikett);
      rader.push({ id, etiketter: ny.length ? ny : null });
    }
    if (!rader.length)
      return {
        feil: [
          legg
            ? `alle de merkede har allerede etiketten ${etikett}`
            : `ingen av de merkede har etiketten ${etikett}`,
        ],
      };
    return { feil: [], kommando: 'endre-mange', innhold: { oppgaver: rader } };
  }
  if (handling === 'ranger') {
    const plass = String(v.plass ?? '');
    if (!['topp', 'bunn', 'over', 'under'].includes(plass))
      return { feil: ['velg øverst, nederst, rett over eller rett under'] };
    if (plass === 'over' || plass === 'under') {
      const ref = String(v.ref ?? '').trim();
      if (!MASSE_ID.test(ref)) return { feil: ['skriv id-en til oppgaven blokken skal stå ved'] };
      return { feil: [], kommando: 'ranger', plass: { [plass]: ref } };
    }
    return { feil: [], kommando: 'ranger', plass: { [plass]: true } };
  }
  // samle-pakk
  const brukt = new Set(perId.keys());
  let nyId = v.ny_id == null || v.ny_id === '' ? null : String(v.ny_id).trim();
  if (nyId == null) {
    const pid = L.prosjektFor(perId.get(liste[0]) ?? {}, ko.prosjekter ?? {});
    nyId = L.samleId(pid, ko.prosjekter ?? {}, brukt);
  }
  if (!MASSE_ID.test(nyId)) return { feil: ['ugyldig id for det nye sporet'] };
  const tittel = masseTekst(v.tittel, 200) || null;
  return { feil: [], kommando: 'samle-pakk', nyId, tittel };
}

/**
 * Forhåndsvisningen av «Pakk til spor»: koLogikk.samlePakk på en kopi av køen (samme regler og sammenslåing som
 * `ko.mjs samle pakk`), uten å skrive noe. Returnerer det nye sporet slik det blir, og delene som kanselleres.
 * @returns {{ feil: string[], ny?: object, kansellert?: string[], omdirigert?: string[] }}
 */
function pakkForhandsvisning(ko, ider, { nyId, tittel = null } = {}) {
  const kopi = L.klonJson(ko);
  const r = L.samlePakk(kopi, ider, {
    nyId,
    tittel,
    oppdrag: `scripts/.ko/oppdrag/${nyId}.md`,
    av: 'tavla',
  });
  if (r.feil.length) return { feil: r.feil };
  const n = r.ny;
  return {
    feil: [],
    ny: {
      id: n.id,
      tittel: n.tittel ?? '',
      klasse: n.klasse ?? null,
      status: n.status,
      innhold_min: Number(n.innhold_min ?? 0) || 0,
      nytte: Number(n.nytte ?? 5),
      migr_tiere: Number(n.migr_tiere ?? 0) || 0,
      prosjekt: L.prosjektFor(n, kopi.prosjekter ?? {}),
      funksjon: n.funksjon ?? null,
      avhenger: n.avhenger ?? [],
      venter_paa: n.venter_paa ?? [],
      eier_filer: n.eier_filer ?? [],
      etiketter: n.etiketter ?? [],
      oppdrag: n.oppdrag ?? null,
    },
    kansellert: r.kansellert,
    omdirigert: r.omdirigert,
  };
}

/** «1 oppgave» / «3 oppgaver». */
const antallOppgaver = (n) => `${n} ${n === 1 ? 'oppgave' : 'oppgaver'}`;

/**
 * Den korte forklaringen øverst i forhåndsvisningen: hva som skjer, og hvor mange som allerede er slik.
 * `endringer` er diffen fra `endre-mange --torr` (koLogikk.masseDiff: { id, felt, for, etter }).
 * @returns {string}
 */
function masseOppsummering(ko, handling, ider, verdi = {}, endringer = []) {
  const n = ider.length;
  const endret = new Set((endringer ?? []).filter((e) => e.id).map((e) => e.id));
  const like = n - endret.size;
  const rest = like > 0 ? ` ${like} er allerede slik.` : '';
  const v = verdi ?? {};
  const fraTil = () => {
    // «11 flyttes fra alfa til beta»: gruppert på prosjektet de har nå.
    const register = ko.prosjekter ?? {};
    const perId = new Map((ko.oppgaver ?? []).map((o) => [o.id, o]));
    const fra = new Map();
    for (const id of endret) {
      const pid = L.prosjektFor(perId.get(id) ?? {}, register);
      fra.set(pid, (fra.get(pid) ?? 0) + 1);
    }
    return [...fra].map(([pid, x]) => `${x} fra ${pid}`).join(', ');
  };
  switch (handling) {
    case 'prosjekt':
      return v.pid
        ? `${antallOppgaver(n)}: ${endret.size} flyttes til prosjektet ${v.pid}${endret.size ? ` (${fraTil()})` : ''}.${rest}`
        : `${antallOppgaver(n)}: ${endret.size} mister det faste prosjektet og følger prefiksen igjen.${rest}`;
    case 'funksjon':
      return v.navn
        ? `${antallOppgaver(n)}: ${endret.size} får funksjonen «${v.navn}».${rest}`
        : `${antallOppgaver(n)}: ${endret.size} mister funksjonen.${rest}`;
    case 'parker':
      return (
        `${antallOppgaver(n)}: ${endret.size} settes på vent` +
        (v.til ? ` til og med ${v.til}` : ' til du tar dem av') +
        '. De står i køen, men startes og plukkes ikke.' +
        rest
      );
    case 'fortsett':
      return `${antallOppgaver(n)}: ${endret.size} tas av vent og kan startes igjen.${rest}`;
    case 'samle-inn':
      return (
        `${antallOppgaver(n)}: ${endret.size} legges i samlekøen. Der startes de ikke alene, men pakkes ` +
        `sammen med andre små oppgaver til et spor.${rest}`
      );
    case 'samle-ut':
      return `${antallOppgaver(n)}: ${endret.size} tas ut av samlekøen og startes som egne spor.${rest}`;
    case 'godta-forslag': {
      const forslag = sorterForslag(ko);
      const uten = ider.filter((id) => !forslag.has(id)).length;
      return (
        `${antallOppgaver(n)}: ${endret.size} får prosjektet køen foreslår` +
        `${endret.size ? ` (${fraTil()})` : ''}.` +
        (uten ? ` ${uten} har ikke noe forslag og står som før.` : '') +
        (like - uten > 0 ? ` ${like - uten} har allerede det prosjektet.` : '')
      );
    }
    case 'etikett-legg':
      return `${antallOppgaver(n)}: ${endret.size} får etiketten ${v.etikett}.${rest}`;
    case 'etikett-fjern':
      return `${antallOppgaver(n)}: ${endret.size} mister etiketten ${v.etikett}.${rest}`;
    case 'ranger': {
      const hvor =
        v.plass === 'topp'
          ? 'øverst i trinnet'
          : v.plass === 'bunn'
            ? 'nederst i trinnet'
            : `rett ${v.plass === 'over' ? 'over' : 'under'} ${v.ref}`;
      return (
        `${antallOppgaver(n)} flyttes samlet ${hvor} og beholder rekkefølgen seg imellom ` +
        `(${(endringer ?? []).length} prioriteter endres).`
      );
    }
    case 'samle-pakk':
      return (
        `${antallOppgaver(n)} slås sammen til ett nytt spor. Delene kanselleres med merknad, og det som ` +
        'avhenger av dem, peker til det nye sporet. Dette kan ikke angres med «Angre».'
      );
    default:
      return antallOppgaver(n);
  }
}

/**
 * Vaktreglene for en massehandling (kalles fra vurder med type 'masse'). Bruker koLogikk direkte, aldri en kopi.
 *   stopp: ukjent oppgave; status som ikke kan masseendres (bare venter og forslag); samlekø-reglene
 *          (koLogikk.samlesFeil mot køen slik den blir) for «Legg i samlekøen»; pakkereglene for «Pakk til spor»;
 *          ukjent prosjekt.
 *   advarsel: mange på én gang (over MASSE_BEKREFT); flytting til et pauset prosjekt; parkering av en oppgave noe i
 *          fokus venter på.
 *   info: parkering av en oppgave andre venter på (uten fokus); merkede som allerede er slik.
 */
function vurderMasse(ko, handling, legg) {
  const oppgaver = ko.oppgaver ?? [];
  const register = ko.prosjekter ?? {};
  const perId = new Map(oppgaver.map((o) => [o.id, o]));
  const ider = [...new Set(handling.ider ?? [])];
  const verdi = handling.verdi ?? {};
  const h = handling.handling;
  const ukjente = ider.filter((id) => !perId.has(id) || L.erEksternRad(perId.get(id)));
  if (ukjente.length) legg('stopp', `Finnes ikke i køen: ${ogListe(ukjente)}.`);
  const laaste = ider
    .map((id) => perId.get(id))
    .filter((o) => o && !L.erEksternRad(o) && !MASSE_STATUSER.has(o.status));
  if (laaste.length)
    legg(
      'stopp',
      `Bare oppgaver som venter eller er forslag kan endres samlet: ${ogListe(
        laaste.map((o) => `${o.id} (${o.status})`),
      )}. Fjern dem fra valget.`,
    );
  if (ider.length > MASSE_BEKREFT)
    legg(
      'advarsel',
      `Du endrer ${ider.length} oppgaver på én gang. Se over lista før du bekrefter.`,
    );
  if (ukjente.length || laaste.length) return;
  const merket = ider.map((id) => perId.get(id));

  if (h === 'prosjekt' && verdi.pid) {
    if (!Object.hasOwn(register, verdi.pid))
      legg('stopp', `Prosjektet ${verdi.pid} finnes ikke. Opprett det først (ko.mjs prosjekt).`);
    else if (register[verdi.pid]?.pause === true)
      legg(
        'advarsel',
        `Prosjektet ${verdi.pid} står på pause: oppgavene startes ikke før det fortsetter.`,
      );
  }
  if (h === 'parker') {
    const k = L.rangeringKontekst(ko, handling.naa ?? Date.now());
    const iBlokk = new Set(ider);
    const fokus = [];
    const andre = [];
    for (const o of merket) {
      const avhengige = oppgaver.filter(
        (x) =>
          !iBlokk.has(x.id) &&
          x.status === 'venter' &&
          !L.erEksternRad(x) &&
          (x.avhenger ?? []).includes(o.id),
      );
      if (!avhengige.length) continue;
      const iFokus = k.gjelder
        ? avhengige.filter((x) => L.fokusPlass(x, k).steg != null).map((x) => x.id)
        : [];
      if (iFokus.length) fokus.push(`${o.id} (${ogListe(iFokus)} venter på den)`);
      else andre.push(`${o.id} (${ogListe(avhengige.map((x) => x.id))})`);
    }
    if (fokus.length)
      legg(
        'advarsel',
        `Noe i fokus venter på ${ogListe(fokus)}. På vent stopper også dem til du tar oppgaven av vent.`,
      );
    if (andre.length) legg('info', `Andre oppgaver venter på ${ogListe(andre)}.`);
    const alt = merket.filter((o) => o.parkert).map((o) => o.id);
    if (alt.length) legg('info', `Står allerede på vent: ${ogListe(alt)}.`);
  }
  if (h === 'samle-inn') {
    // Reglene mot køen slik den blir når ALLE de merkede ligger i samlekøen.
    const etter = oppgaver.map((o) => (ider.includes(o.id) ? { ...o, samles: true } : o));
    const feil = [];
    for (const o of etter.filter((x) => ider.includes(x.id)))
      for (const f of L.samlesFeil(o, etter, ko.avklart)) feil.push(`${o.id}: ${f}`);
    if (feil.length) legg('stopp', `Kan ikke legges i samlekøen:\n${feil.join('\n')}`);
  }
  if (h === 'samle-ut') {
    const ikke = merket.filter((o) => !L.iSamlekoen(o)).map((o) => o.id);
    if (ikke.length === merket.length) legg('stopp', 'Ingen av de merkede ligger i samlekøen.');
    else if (ikke.length) legg('info', `Ligger ikke i samlekøen: ${ogListe(ikke)}.`);
  }
  if (h === 'samle-pakk') {
    const plan = massePlan(ko, h, ider, verdi);
    if (plan.feil.length) legg('stopp', plan.feil.join('\n'));
    else {
      const p = pakkForhandsvisning(ko, ider, { nyId: plan.nyId, tittel: plan.tittel });
      if (p.feil.length) legg('stopp', `Kan ikke pakkes:\n${p.feil.join('\n')}`);
    }
  }
  if (h === 'fortsett') {
    const ikke = merket.filter((o) => !o.parkert).map((o) => o.id);
    if (ikke.length && ikke.length < merket.length)
      legg('info', `Står ikke på vent: ${ogListe(ikke)}.`);
  }
}

// ---- Innstillinger og oppsett -------------------------------------------------------------------------

/**
 * Feltene i innstillingspanelet: alle grensene `ko.mjs grense` kan sette (testen sjekker at lista er lik
 * koLogikk.GRENSE_NAVN), med norsk navn, én linje forklaring og sparemodus-anbefalingen der den finnes.
 */
const INNSTILLINGER = [
  {
    navn: 'maksSamtidig',
    tittel: 'Samtidige spor',
    forklaring: 'Hvor mange agenter køen kjører samtidig. Plukkede oppgaver teller ikke.',
    type: 'heltall',
  },
  {
    navn: 'maksDPluss',
    tittel: 'Samtidige D+-spor',
    forklaring: 'De tyngste sporene (D+, to reviewere hver). Høyst like mange som samtidige spor.',
    type: 'heltall',
  },
  {
    navn: 'maksPerDomene',
    tittel: 'Spor per domene',
    forklaring: 'Høyst så mange samtidig i samme domene.',
    type: 'heltall',
  },
  {
    navn: 'maksDb',
    tittel: 'Spor med migrasjoner',
    forklaring:
      'Spor med migrasjoner samtidig, altså belastningen på databasen. Plukkede oppgaver teller også her.',
    type: 'heltall',
  },
  {
    navn: 'dagsbudsjett',
    tittel: 'Dagskvote (USD)',
    forklaring:
      'Når dagens forbruk (API-ekvivalent) når kvoten, startes ingen nye oppgaver. «av» = ingen kvote.',
    type: 'tekst',
  },
  {
    navn: 'nattkjoring',
    tittel: 'Nattkjøring',
    forklaring: 'Av: ingen nye oppgaver startes i nattvinduet. Det som kjører, går ferdig.',
    type: 'paav',
  },
  {
    navn: 'nattvindu',
    tittel: 'Nattvindu (norsk tid)',
    forklaring: 'Timene nattpausen gjelder, som «23-06» (fra kl. 23 til kl. 06).',
    type: 'tekst',
  },
  {
    navn: 'autokompakt',
    tittel: 'Automatisk komprimering',
    forklaring:
      'På: orkestratorøkta komprimeres av Claude Code selv (sett /autocompact 300k i økta) og fortsetter av seg selv. ' +
      'Av: varsel med ferdig /compact-linje, så du følger med.',
    type: 'paav',
  },
];

/** Innstillingspanelet: hvert felt med nåverdi, standard og sparemodus (alle som tekst, slik ko.mjs viser dem). */
function innstillinger(ko) {
  const g = { ...L.STANDARD_GRENSER, ...(ko.grenser ?? {}) };
  return INNSTILLINGER.map((f) => ({
    ...f,
    verdi: L.grenseTekst(f.navn, g[f.navn]),
    standard: L.grenseTekst(f.navn, L.STANDARD_GRENSER[f.navn]),
    sparemodus: f.navn in SPAREMODUS ? String(SPAREMODUS[f.navn]) : null,
  }));
}

/**
 * Arbeidsreglene panelet viser (statisk tekst, se docs/orchestration.md og skillen parallell-bolge). Sparemodus-tallene
 * kommer fra SPAREMODUS, så panelet og innstillingene alltid sier det samme.
 */
const SKILL_REGLER = [
  {
    tekst: `Sparemodus: høyst ${SPAREMODUS.maksSamtidig} samtidige spor og ${SPAREMODUS.maksDPluss} D+.`,
  },
  { tekst: 'Review etter klasse: K og U ingen, D én reviewer, D+ to.' },
  {
    tekst:
      'Kontekst: et spor leverer delvis før konteksten er full, og orkestratoren komprimerer i stedet for å rotere.',
  },
  { tekst: 'Retterunder og fortsettelser går i en ny agent.' },
];
const SKILL_KILDE = '.claude/skills/parallell-bolge/SKILL.md og docs/orchestration.md';

/**
 * Køsystemets egne hooks i .claude/settings.json (se docs/orchestration.md): skriptet under scripts/orkestrator/, de
 * hendelsene det skal stå under, og (for tidsloggen) at matcheren må dekke alle agenttyper.
 */
const KO_HOOKS = [
  {
    fil: 'hook-tid.mjs',
    hendelser: ['SubagentStart', 'SubagentStop'],
    alleMatchere: true,
    hva: 'tidslogg for alle agenter',
  },
  { fil: 'hook-push-vakt.mjs', hendelser: ['PreToolUse'], hva: 'push-vakt' },
  { fil: 'hook-lesevakt.mjs', hendelser: ['PreToolUse'], hva: 'lesevakt' },
  { fil: 'hook-spor-kontekst.mjs', hendelser: ['PostToolUse'], hva: 'kontekstmåling i spor' },
  {
    fil: 'hook-etter-kompakt.mjs',
    hendelser: ['PreCompact', 'SessionStart'],
    hva: 'gjenoppretting etter komprimering',
  },
  { fil: 'hook-effort.mjs', hendelser: ['UserPromptSubmit'], hva: 'tenkenivå' },
  { fil: 'hook-kontekst.mjs', hendelser: ['UserPromptSubmit'], hva: 'kontekstvarsel' },
];

/**
 * Er køsystemets hooks satt opp? Leser `hooks.<hendelse>` i .claude/settings.json og ser etter oppføringer der en
 * kommando peker på scripts/orkestrator/<fil>. Matcher «*» eller ingen matcher teller som «alle».
 * @returns {{ alle: boolean, hooks: { fil: string, hva: string, ok: boolean,
 *   hendelser: { hendelse: string, matchere: string[], ok: boolean }[] }[], mangler: string[] }}
 *   `alle` = hver hook står under alle hendelsene sine; `mangler` = «fil (hendelse)» for det som mangler.
 */
function hooksDekning(settings, forventet = KO_HOOKS) {
  const matchere = (hendelse, fil) =>
    (settings?.hooks?.[hendelse] ?? [])
      .filter(
        (e) =>
          Array.isArray(e?.hooks) &&
          e.hooks.some((h) =>
            String(h?.command ?? '')
              .replace(/\\/g, '/')
              .includes(`scripts/orkestrator/${fil}`),
          ),
      )
      .map((e) => (e.matcher == null || e.matcher === '' ? '*' : String(e.matcher)));
  const mangler = [];
  const hooks = forventet.map((h) => {
    const hendelser = h.hendelser.map((hendelse) => {
      const m = matchere(hendelse, h.fil);
      const ok = h.alleMatchere ? m.includes('*') : m.length > 0;
      if (!ok) mangler.push(`${h.fil} (${hendelse})`);
      return { hendelse, matchere: m, ok };
    });
    return { fil: h.fil, hva: h.hva, ok: hendelser.every((x) => x.ok), hendelser };
  });
  return { alle: mangler.length === 0, hooks, mangler };
}

/** Køsystemets skills (.claude/skills/<navn>/SKILL.md). */
const KO_SKILLS = ['ko', 'legg-til-ko', 'parallell-bolge', 'planer', 'plukk', 'start'];

/**
 * Er køsystemets skills installert? `finnes(navn)` svarer om .claude/skills/<navn>/SKILL.md finnes (serveren sender
 * inn filsjekken, så funksjonen er ren).
 * @returns {{ alle: boolean, finnes: string[], mangler: string[] }}
 */
function skillsDekning(finnes, navn = KO_SKILLS) {
  const ja = navn.filter((n) => {
    try {
      return !!finnes(n);
    } catch {
      return false;
    }
  });
  const mangler = navn.filter((n) => !ja.includes(n));
  return { alle: mangler.length === 0, finnes: ja, mangler };
}

/** Standardmønsteret for migrasjonsfiler (som konfig().migrasjoner.filmonster): første gruppe er nummeret. */
const MIGRASJON_MONSTER = '^(\\d+)_.*\\.sql$';

/**
 * Høyeste migrasjon blant filnavnene, med prosjektets filmønster (konfig().migrasjoner.filmonster; første gruppe er
 * nummeret). Numrene sammenlignes som heltall. null når ingen fil passer eller mønsteret er ugyldig.
 * @returns {{ nummer: number, versjon: string, fil: string } | null}
 */
function hoyesteMigrasjon(filnavn, filmonster = MIGRASJON_MONSTER) {
  let re;
  try {
    re = new RegExp(filmonster || MIGRASJON_MONSTER);
  } catch {
    return null;
  }
  let beste = null;
  for (const f of filnavn ?? []) {
    const m = re.exec(String(f));
    if (!m || m[1] == null) continue;
    let nummer;
    try {
      nummer = BigInt(m[1]);
    } catch {
      continue;
    }
    if (!beste || nummer > beste.stort) beste = { stort: nummer, versjon: m[1], fil: f };
  }
  return beste ? { nummer: Number(beste.stort), versjon: beste.versjon, fil: beste.fil } : null;
}

/**
 * Tittelen på tavla: konfig().tavle.tittel, med konfig().prosjektNavn etter når prosjektet har gitt seg et navn
 * (standardnavnet «prosjektet» vises ikke).
 */
function tavleTittel(konfig = {}, { standardNavn = 'prosjektet' } = {}) {
  const tittel = String(konfig?.tavle?.tittel ?? '').trim() || 'Køtavla';
  const navn = String(konfig?.prosjektNavn ?? '').trim();
  return navn && navn !== standardNavn ? `${tittel} · ${navn}` : tittel;
}

// ---- Fargene ----------------------------------------------------------------------------------------------------

/**
 * Tavlas egen, nøytrale palett: lys og mørk, med de samme navnene i begge. Navnene følger Material-mønsteret (primary,
 * on-primary, surface-container-low osv.), og tavle.css og planer.css bruker dem som `var(--color-<navn>)`.
 * Kategorifargene er prosjektfargene: valgt for å skilles fra hverandre (også ved fargeblindhet) og holde kontrast
 * mot flatene i begge skjema. Vil et prosjekt ha egne farger, endres de her.
 */
const PALETT = Object.freeze({
  lys: Object.freeze({
    primary: '#2f5d8a',
    'on-primary': '#ffffff',
    'primary-container': '#d3e3f5',
    'on-primary-container': '#0b2a47',
    secondary: '#55606e',
    'secondary-container': '#dde3ea',
    'on-secondary-container': '#1a2430',
    tertiary: '#6a5089',
    'tertiary-container': '#ece0f7',
    'on-tertiary-container': '#2a1446',
    error: '#b3261e',
    'error-container': '#f9dedc',
    'on-error-container': '#410e0b',
    surface: '#f8f9fb',
    'on-surface': '#1b1d21',
    'on-surface-variant': '#4a505a',
    'surface-container-lowest': '#ffffff',
    'surface-container-low': '#f2f4f7',
    'surface-container': '#eceff3',
    'surface-container-high': '#e4e8ed',
    outline: '#737a85',
    'outline-variant': '#c4c9d1',
    'inverse-surface': '#2e3136',
    'inverse-on-surface': '#eff1f4',
    placeholder: '#6e7580',
    'modul-amber-container': '#fbe7c2',
    'modul-lilla-container': '#e9defa',
    'kategori-teal': '#0f7c7a',
    'kategori-plomme': '#8e3b6e',
    'kategori-havbla': '#1f5fa8',
    'kategori-mose': '#5a731c',
    'kategori-fiolett': '#6b46c1',
    'kategori-petrol': '#155e75',
    'kategori-gronn': '#2e7d32',
    'kategori-bla': '#3949ab',
    'kategori-skifer': '#546e7a',
    'kategori-grafitt': '#5f6368',
  }),
  mork: Object.freeze({
    primary: '#9cc4ee',
    'on-primary': '#0b2a47',
    'primary-container': '#1d4469',
    'on-primary-container': '#d3e3f5',
    secondary: '#bcc6d2',
    'secondary-container': '#3a4552',
    'on-secondary-container': '#dde3ea',
    tertiary: '#d0bcf0',
    'tertiary-container': '#4f3770',
    'on-tertiary-container': '#ece0f7',
    error: '#f2b8b5',
    'error-container': '#8c1d18',
    'on-error-container': '#f9dedc',
    surface: '#121418',
    'on-surface': '#e3e5e9',
    'on-surface-variant': '#b9bfc8',
    'surface-container-lowest': '#0d0f12',
    'surface-container-low': '#1a1d22',
    'surface-container': '#1f2228',
    'surface-container-high': '#292d33',
    outline: '#8b929c',
    'outline-variant': '#41474f',
    'inverse-surface': '#e3e5e9',
    'inverse-on-surface': '#2e3136',
    placeholder: '#9aa0a9',
    'modul-amber-container': '#5a4210',
    'modul-lilla-container': '#43306a',
    'kategori-teal': '#5fc4c0',
    'kategori-plomme': '#e08cbd',
    'kategori-havbla': '#8ab8f0',
    'kategori-mose': '#b2cc6b',
    'kategori-fiolett': '#b9a0f0',
    'kategori-petrol': '#6cc3dc',
    'kategori-gronn': '#81c784',
    'kategori-bla': '#9fa8f0',
    'kategori-skifer': '#a7bcc6',
    'kategori-grafitt': '#bdbdbd',
  }),
});

/**
 * CSS-variablene for tavla: `--color-<token>` for lys i :root, mørk når systemet er mørkt (og bryteren ikke har valgt
 * lys), og mørk når bryteren har valgt mørk (`<html data-tema="mork">`).
 */
function temaCss({ lys, mork } = PALETT) {
  const vars = (p) =>
    Object.entries(p)
      .filter(([k, v]) => /^[a-z0-9-]+$/.test(k) && /^#[0-9a-fA-F]{6}$/.test(v))
      .map(([k, v]) => `  --color-${k}: ${v};`)
      .join('\n');
  return [
    '/* Generert av ko-tavle.mjs fra paletten i lib/koTavle.js (lys og mørk). Rediger aldri her. */',
    `:root {\n  color-scheme: light;\n${vars(lys)}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-tema="lys"]) {\n  color-scheme: dark;\n${vars(mork)}\n  }\n}`,
    `:root[data-tema="mork"] {\n  color-scheme: dark;\n${vars(mork)}\n}`,
    '',
  ].join('\n');
}

// ---- /api/dok (lesevisningen av markdown, se docs/plan-register.md) ----------------------------------------------

/**
 * Leser ett markdown-dokument for lesevisningen på tavla, med stivernet i flere lag:
 *   1. koPlanVisning.lesStiFeil: relativ sti, ingen `.`/`..`/skjulte ledd, bare `.md` under allowlisten.
 *   2. Hvert ledd under rota sjekkes med lstat: en symlenke eller junction (som Node også melder som symlenke) avvises.
 *   3. Den ekte stien (realpath) må være nøyaktig rota + stien: fanger korte 8.3-navn, feil store/små bokstaver og
 *      lenker vi ikke så i trinn 2.
 *   4. Bare vanlige filer, høyst `maks` byte.
 * Filsystemet sendes inn (`io = { fs, path }`), så funksjonen kan testes mot en midlertidig mappe; ingen annen I/O.
 * Feiltekstene nevner aldri noe utenfor stien klienten selv sendte.
 * @returns {{ ok: true, sti: string, tekst: string, bytes: number, endret: string } |
 *   { ok: false, status: number, melding: string }}
 */
function lesDokument(rot, sti, io, { maks } = {}) {
  const PV = require('./koPlanVisning.js');
  const { fs, path } = io;
  const grense = maks ?? PV.LES_MAKS_BYTE;
  const nei = (status, melding) => ({ ok: false, status, melding });
  const feil = PV.lesStiFeil(sti);
  if (feil) return nei(400, `Kan ikke leses: ${feil}.`);
  let ekteRot;
  try {
    ekteRot = fs.realpathSync.native(rot);
  } catch {
    return nei(503, 'Fant ikke prosjektrota.');
  }
  const deler = sti.split('/');
  let her = ekteRot;
  try {
    for (const d of deler) {
      her = path.join(her, d);
      if (fs.lstatSync(her).isSymbolicLink())
        return nei(403, 'Kan ikke leses: stien går gjennom en symlenke.');
    }
  } catch (e) {
    return e?.code === 'ENOENT' || e?.code === 'ENOTDIR'
      ? nei(404, `Finnes ikke: ${sti}`)
      : nei(500, 'Kunne ikke lese dokumentet.');
  }
  try {
    const ekte = fs.realpathSync.native(her);
    if (ekte !== path.join(ekteRot, ...deler))
      return nei(403, 'Kan ikke leses: stien er ikke den ekte stien til fila.');
    const st = fs.statSync(ekte);
    if (!st.isFile()) return nei(404, `Ikke et dokument: ${sti}`);
    if (st.size > grense)
      return nei(
        413,
        `Dokumentet er for stort for lesevisningen (over ${Math.round(grense / 1024)} KB).`,
      );
    const tekst = fs.readFileSync(ekte, 'utf8');
    return { ok: true, sti, tekst, bytes: st.size, endret: st.mtime.toISOString() };
  } catch (e) {
    return e?.code === 'ENOENT'
      ? nei(404, `Finnes ikke: ${sti}`)
      : nei(500, 'Kunne ikke lese dokumentet.');
  }
}

module.exports = {
  lesDokument,
  STEG,
  NYLIG_MS,
  NESTE_NAAR_FULL,
  PROSJEKT_FARGER,
  UTEN_PROSJEKT_FARGE,
  GREN_PREFIKS,
  grenFor,
  kolonneFor,
  wip,
  prosjektBaner,
  kjedeKart,
  laaserOpp,
  kjede,
  aldrende,
  nesteOpp,
  innboks,
  sorterListe,
  sorterForslag,
  fokusLinje,
  planGrunnlag,
  fokusForhandsvisning,
  OMRADE_HANDLINGER,
  omradePlan,
  tavle,
  nyttTillegg,
  baneTillegg,
  loftTillegg,
  SPAREMODUS,
  vurder,
  MASSE_MAKS,
  MASSE_BEKREFT,
  MASSE_HANDLINGER,
  massePlan,
  pakkForhandsvisning,
  masseOppsummering,
  INNSTILLINGER,
  innstillinger,
  SKILL_REGLER,
  SKILL_KILDE,
  KO_HOOKS,
  hooksDekning,
  KO_SKILLS,
  skillsDekning,
  MIGRASJON_MONSTER,
  hoyesteMigrasjon,
  tavleTittel,
  PALETT,
  temaCss,
};
