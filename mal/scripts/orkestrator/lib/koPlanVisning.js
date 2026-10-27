// =============================================================
// koPlanVisning.js: de rene reglene for Planer-rommet på køtavla (se docs/board.md og docs/plan-register.md).
//
// Fila er både et CommonJS-modul (ko-tavle.mjs og testene, lib/__tests__/koPlanVisning.test.ts) og et skript i
// nettleseren (ko-tavle.mjs serverer den som /koPlanVisning.js, og den setter window.KoPlanVisning), så tavla bruker
// nøyaktig den koden testene sjekker. Ingen DOM, ingen fil- eller nettverkstilgang.
//
//   - planerData: det /api/planer sender (serveren kaller den med planer.json og ko.json). Bygger på de rene
//     funksjonene i koPlan.js (avledet modenhet, sortering, blokkerer, aktive økter); bare den delen krever koPlan.js,
//     og den kjøres aldri i nettleseren.
//   - Tilstanden i nettadressen (rom, filtre, søk, valgt post og fane), så tilbake-knappen og bokmerker virker.
//   - Fasettene (modul, prioritet, Nå-kategori, modenhet, venter på, frist) med antall treff per verdi.
//   - Treet modul › prosjekt › post med opprullet fremdrift, og «Uten prosjekt» så ingenting forsvinner.
//   - Brødsmulestien og kopier-linjene (bare id og titler, aldri innhold fra dokumentene).
//   - Koblingen til køen: statusteksten for en køoppgave med fokustrinnet, og «Klargjør for kø».
//   - De ferdige visningene (Før prod, Sikkerhet, Venter på meg, Foreldet, Droppet av agent).
//   - Flaten «Dokumenter og avtaler» i samme rom, med samme tre-rute-mønster: fasettene
//     gruppe, status, målgruppe, prioritet og problemer (med antall), en tabell per gruppe, «Hva må gjøres»,
//     tidslinjen for revisjoner per måned og stien Planer › Dokumenter og avtaler › Gruppe › DOK-id.
//   - Prioritetskartet (modul × Nå sikkerhet, før prod, viktig, Eier, Senere, Dropp) med utkastet
//     og kallene til `ko.mjs plan prioriter`, og fristbåndet for de neste 90 dagene.
//   - Trekartet modul › prosjekt › post (areal = estimat, farge = prioritet, fyll = bygget; zoomen
//     er filteret) med squarified-oppsettet, og avhengighetsgrafen for utvalget eller valgt post med naboene, med
//     blokkerte poster og den kritiske veien (koGraf.kritiskVei; oppsettet er koGraf.lagdel).
//   - Allowlisten for lesevisningen (lesStiFeil, mappene fra ko.config.json `dokumentMapper`; serveren legger symlenke- og realpath-vernet oppå i
//     koTavle.lesDokument), markdown delt i blokker og biter som tegnes med textContent (markdownBlokker,
//     inlineDeler, lenkeMaal, ankerIndeks), og Uregistrert-boksen (grupper, forslag, «Ny post» og «Legg til som
//     kilde» med argumentene til `ko.mjs plan ny` og `plan endre --sett {kilder}`).
// =============================================================
(function (rot, fabrikk) {
  if (typeof module === 'object' && module.exports) module.exports = fabrikk();
  else rot.KoPlanVisning = fabrikk();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- Verdiene og hvordan de vises ------------------------------------------------------------------------------

  /** Prioritetene i visningsrekkefølge (som koPlan.PRIORITETER). Symbolet står alltid sammen med teksten. */
  const PRIORITET = {
    naa: { tekst: 'Nå', symbol: '●' },
    eier: { tekst: 'Eier', symbol: '◆' },
    senere: { tekst: 'Senere', symbol: '○' },
    dropp: { tekst: 'Dropp', symbol: '✕' },
  };
  const PRIORITETER = Object.keys(PRIORITET);
  const KATEGORI = { sikkerhet: 'sikkerhet', 'for-prod': 'før prod', viktig: 'viktig' };
  const MODENHET = {
    ide: 'Idé',
    utredet: 'Utredet',
    planlagt: 'Planlagt',
    klar: 'Klar',
    'i-ko': 'I kø',
    delvis: 'Delvis bygget',
    bygget: 'Bygget',
    verifisert: 'Verifisert',
  };
  const ESTIMAT = {
    S: 'under en halv dag',
    M: '1 til 3 spor',
    L: '4 til 10 spor',
    XL: 'en hel modul',
  };
  const VENTER = { eier: 'Eieren', jurist: 'Juridisk avklaring', ingen: 'Ingenting' };
  /** Fristbåndene (dager fra i dag). */
  const FRIST = {
    forfalt: 'Forfalt',
    30: 'Innen 30 dager',
    90: 'Innen 90 dager',
    senere: 'Senere',
    ingen: 'Uten frist',
  };
  /** Satt av (for «Droppet av agent»). */
  const SATT_AV = { agent: 'Agent', eier: 'Eieren' };
  /** Juridiske punkter med disse statusene er åpne. */
  const JUR_APEN = new Set(['apen', 'ki-vurdert', 'til-jurist']);
  /** Fanene i detaljpanelet. */
  const FANER = [
    { id: 'sammendrag', tekst: 'Sammendrag' },
    { id: 'dok', tekst: 'Dokumenter' },
    { id: 'ko', tekst: 'Kø' },
    { id: 'juridisk', tekst: 'Juridisk' },
    { id: 'beslutninger', tekst: 'Beslutninger' },
    { id: 'historikk', tekst: 'Historikk' },
  ];
  const UTEN_PROSJEKT = '(uten-prosjekt)';
  const UTEN_MODUL = '(uten-modul)';
  const POST_ID = /^PL-[A-Za-z0-9ÆØÅæøå-]{1,60}$/;
  const NOKKEL = /^[a-z0-9][a-z0-9-]{0,60}$/;

  // ---- flatene i rommet og verdiene for dokumentene ----------------------------------------------
  // Verdiene er de samme som i koPlan.js (DOK_GRUPPER, DOK_STATUSER, …); koPlanVisning.test.ts sjekker at de stemmer.

  /** Flatene i Planer-rommet: planpostene og dokumentregisteret (samme mønster, egne filtre). */
  const FLATER = [
    // oversikten er startsiden når du går inn i Planer (`flate=oversikt`). En nettadresse uten
    // flate er fortsatt Planposter, så gamle lenker og lagrede visninger virker som før.
    { id: 'oversikt', tekst: 'Oversikt' },
    { id: 'poster', tekst: 'Planposter' },
    { id: 'dok', tekst: 'Dokumenter og avtaler' },
    // juridisk panel, eierbeslutninger og lanseringsoversikten.
    { id: 'jur', tekst: 'Juridisk' },
    { id: 'beslutn', tekst: 'Beslutninger' },
    { id: 'lansering', tekst: 'Lansering' },
  ];
  const DOK_GRUPPE = {
    kundeavtaler: 'Kundeavtaler',
    personvern: 'Personvern',
    offentlig: 'Offentlig på nettsiden',
    styring: 'Styringsdokumenter',
    leverandorer: 'Innkjøp og leverandører',
    kontrakt: 'Kontraktsarbeid',
  };
  /** Status med symbol: fargen er aldri eneste bærer. */
  const DOK_STATUS = {
    mangler: { tekst: 'Mangler', symbol: '✕' },
    utkast: { tekst: 'Utkast', symbol: '✎' },
    'ki-vurdert': { tekst: 'KI-vurdert', symbol: '◐' },
    'til-jurist': { tekst: 'Til jurist', symbol: '§' },
    godkjent: { tekst: 'Godkjent', symbol: '✓' },
    publisert: { tekst: 'Publisert', symbol: '●' },
    utdatert: { tekst: 'Utdatert', symbol: '⚠' },
  };
  const DOK_MALGRUPPE = {
    kunde: 'Kunde',
    offentlig: 'Offentlig',
    intern: 'Intern',
    leverandor: 'Leverandør',
  };
  const DOK_PRI = { ...PRIORITET, ingen: { tekst: 'Uten prioritet', symbol: '·' } };
  /** Varslene en rad kan ha (fasetten «Problemer og revisjon»). */
  const DOK_VARSEL = {
    'problem-hoy': 'Problem med høy alvor',
    problem: 'Har problemer',
    glipp: 'Versjonsglipp',
    forfalt: 'Revisjon forfalt',
    snart: 'Revisjon innen 30 dager',
    ingen: 'Ingen varsler',
  };
  const DOK_ALVOR = { hoy: 'Høy', middels: 'Middels', lav: 'Lav' };
  const DOK_PUBLISERT = {
    nettside: 'Nettsiden',
    admin: 'Admin',
    app: 'Appen',
    signert: 'Signert',
    annet: 'Annet',
  };
  const DOK_ID = /^DOK-[A-Za-z0-9ÆØÅæøå-]{1,60}$/;

  // ---- Tilstanden i nettadressen -----------------------------------------------------------------------------------

  /**
   * Fasettene i venstre rute, i rekkefølge. `param` er navnet i nettadressen, `verdier` de lovlige verdiene (null =
   * fra dataene: modul og prosjekt), `av(post, naa)` verdiene en post har (en post kan ha flere, f.eks. kategorier).
   * Innen en fasett er valgene «eller»; mellom fasettene «og».
   */
  const FASETTER = [
    {
      id: 'modul',
      tittel: 'Modul',
      param: 'modul',
      verdier: null,
      av: (p) => [p.modul ?? UTEN_MODUL],
    },
    {
      id: 'prosjekt',
      tittel: 'Prosjekt',
      param: 'prosjekt',
      verdier: null,
      av: (p) => [p.prosjekt ?? UTEN_PROSJEKT],
    },
    { id: 'pri', tittel: 'Prioritet', param: 'pri', verdier: PRIORITET, av: (p) => [p.prioritet] },
    {
      id: 'kat',
      tittel: 'Nå-kategori',
      param: 'kat',
      verdier: KATEGORI,
      av: (p) => (p.prioritet === 'naa' ? (p.naa_kategori ?? []) : []),
    },
    { id: 'mod', tittel: 'Modenhet', param: 'mod', verdier: MODENHET, av: (p) => [p.modenhet] },
    {
      id: 'venter',
      tittel: 'Venter på',
      param: 'venter',
      verdier: VENTER,
      av: (p) => venterPaa(p),
    },
    {
      id: 'frist',
      tittel: 'Frist',
      param: 'frist',
      verdier: FRIST,
      av: (p, naa) => [fristBand(p.frist, naa)],
    },
    {
      id: 'satt',
      tittel: 'Prioritet satt av',
      param: 'satt',
      verdier: SATT_AV,
      av: (p) => [p.prioritet_satt_av ?? 'agent'],
    },
    {
      id: 'foreldet',
      tittel: 'Verifisering',
      param: 'foreldet',
      verdier: { ja: 'Foreldet', nei: 'Ikke foreldet' },
      av: (p) => [p.foreldet ? 'ja' : 'nei'],
    },
  ];

  /** Fasettene for dokumentene (gruppe, status, målgruppe og «har problemer», pluss prioritet). */
  const DOK_FASETTER = [
    { id: 'gruppe', tittel: 'Gruppe', param: 'dgr', verdier: DOK_GRUPPE, av: (d) => [d.gruppe] },
    { id: 'status', tittel: 'Status', param: 'dst', verdier: DOK_STATUS, av: (d) => [d.status] },
    {
      id: 'malgruppe',
      tittel: 'Målgruppe',
      param: 'dmg',
      verdier: DOK_MALGRUPPE,
      av: (d) => [d.malgruppe],
    },
    {
      id: 'pri',
      tittel: 'Prioritet',
      param: 'dpri',
      verdier: DOK_PRI,
      av: (d) => [d.prioritet ?? 'ingen'],
    },
    {
      id: 'varsel',
      tittel: 'Problemer og revisjon',
      param: 'dvars',
      verdier: DOK_VARSEL,
      av: (d) => (Array.isArray(d.varsel) && d.varsel.length ? d.varsel : ['ingen']),
    },
  ];

  /** Tomme dokumentfiltre: én liste per fasett. */
  function tomtDokFilter() {
    const f = {};
    for (const x of DOK_FASETTER) f[x.id] = [];
    return f;
  }

  /** Tomme filtre: én liste per fasett. */
  function tomtFilter() {
    const f = {};
    for (const x of FASETTER) f[x.id] = [];
    return f;
  }

  /** Er verdien lov i fasetten? Modul og prosjekt: et trygt navn (finnes de ikke i dataene, gir de bare null treff). */
  function lovligVerdi(fasett, v) {
    if (typeof v !== 'string' || !v || v.length > 60) return false;
    if (fasett.verdier) return Object.hasOwn(fasett.verdier, v);
    return NOKKEL.test(v) || v === UTEN_MODUL || v === UTEN_PROSJEKT;
  }

  /**
   * Leser tilstanden fra søkedelen av nettadressen (`?rom=planer&pri=naa&kat=for-prod&post=PL-X&fane=ko`). Ugyldige
   * verdier kastes stille, så en gammel eller håndskrevet lenke aldri knekker tavla.
   * @param {string} sok location.search (med eller uten «?»)
   * @returns {{ rom: 'planer'|'ko', filter: Record<string,string[]>, sok: string, post: string|null, fane: string }}
   */
  function lesUrl(sok) {
    const q = new URLSearchParams(String(sok ?? '').replace(/^\?/, ''));
    const filter = tomtFilter();
    for (const f of FASETTER) {
      const ut = [];
      for (const del of (q.get(f.param) ?? '').split(',')) {
        const v = del.trim();
        if (lovligVerdi(f, v) && !ut.includes(v)) ut.push(v);
      }
      filter[f.id] = ut.slice(0, 40);
    }
    const post = q.get('post');
    const fane = q.get('fane');
    // flaten (planposter eller dokumenter) og dokumentenes egne filtre, søk og valg.
    const dfilter = tomtDokFilter();
    for (const f of DOK_FASETTER) {
      const ut = [];
      for (const del of (q.get(f.param) ?? '').split(',')) {
        const v = del.trim();
        if (Object.hasOwn(f.verdier, v) && !ut.includes(v)) ut.push(v);
      }
      dfilter[f.id] = ut;
    }
    const dok = q.get('dok');
    const flate = q.get('flate');
    return {
      rom: q.get('rom') === 'planer' ? 'planer' : 'ko',
      flate: FLATER.some((x) => x.id === flate) ? flate : 'poster',
      // filtrene, søket og valget på flatene Juridisk og Beslutninger.
      ...jbLesUrl(q),
      filter,
      sok: String(q.get('q') ?? '').slice(0, 120),
      post: post && POST_ID.test(post) ? post : null,
      fane: FANER.some((x) => x.id === fane) ? fane : 'sammendrag',
      dfilter,
      dsok: String(q.get('dq') ?? '').slice(0, 120),
      dok: dok && DOK_ID.test(dok) ? dok : null,
      // visningen av planpostene (listen, prioritetskartet, trekartet eller
      // avhengighetene), og utvalget avhengighetene viser (hele utvalget eller valgt post med naboene).
      vis: VISNINGER.includes(q.get('vis')) ? q.get('vis') : 'liste',
      avh: q.get('avh') === 'post' ? 'post' : 'utvalg',
    };
  }

  /**
   * Søkedelen for en tilstand (stabil rekkefølge, tomme verdier utelatt). Kø-rommet er standard og skrives ikke, så
   * nettadressen til køen er som før. Andre parametre i `ekstra` (fra køen) beholdes ikke: rommet eier søkedelen.
   */
  function skrivUrl(tilstand) {
    const q = new URLSearchParams();
    if (tilstand.rom === 'planer') q.set('rom', 'planer');
    for (const f of FASETTER) {
      const v = tilstand.filter?.[f.id] ?? [];
      if (v.length) q.set(f.param, v.join(','));
    }
    if (tilstand.sok) q.set('q', tilstand.sok);
    if (tilstand.post) q.set('post', tilstand.post);
    if (tilstand.post && tilstand.fane && tilstand.fane !== 'sammendrag')
      q.set('fane', tilstand.fane);
    // dokumentflaten. Filtrene beholdes når du bytter flate, så du kommer tilbake dit du var.
    if (
      tilstand.flate &&
      tilstand.flate !== 'poster' &&
      FLATER.some((x) => x.id === tilstand.flate)
    )
      q.set('flate', tilstand.flate);
    jbSkrivUrl(q, tilstand);
    for (const f of DOK_FASETTER) {
      const v = tilstand.dfilter?.[f.id] ?? [];
      if (v.length) q.set(f.param, v.join(','));
    }
    if (tilstand.dsok) q.set('dq', tilstand.dsok);
    if (tilstand.dok) q.set('dok', tilstand.dok);
    if (VISNINGER.includes(tilstand.vis) && tilstand.vis !== 'liste') q.set('vis', tilstand.vis);
    if (tilstand.vis === 'avh' && tilstand.avh === 'post') q.set('avh', 'post');
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  /** Antall aktive filtervalg (søket ikke medregnet). */
  function antallFiltre(filter) {
    return FASETTER.reduce((n, f) => n + (filter?.[f.id]?.length ?? 0), 0);
  }

  // ---- Avledede egenskaper på en post ------------------------------------------------------------------------------

  /** Dato (YYYY-MM-DD) i Oslo-tid for et tidspunkt. */
  function osloDato(naa) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(new Date(naa));
  }

  /** Hele dager fra `fra` til `til` (begge YYYY-MM-DD). */
  function dager(fra, til) {
    return Math.round((Date.parse(`${til}T00:00:00Z`) - Date.parse(`${fra}T00:00:00Z`)) / 86400000);
  }

  /** Fristbåndet for en frist: forfalt, 30, 90, senere eller ingen. */
  function fristBand(frist, naa = new Date()) {
    if (typeof frist !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(frist)) return 'ingen';
    const d = dager(osloDato(naa), frist);
    if (d < 0) return 'forfalt';
    if (d <= 30) return '30';
    if (d <= 90) return '90';
    return 'senere';
  }

  /** Åpne juridiske punkter (status apen, ki-vurdert eller til-jurist). */
  function juridiskeApne(post) {
    const pk = post?.juridisk?.punkter;
    return Array.isArray(pk) ? pk.filter((x) => x && JUR_APEN.has(x.status)) : [];
  }

  /** Hva posten venter på: eier (prioritet eier eller et uavklart eierspørsmål), jurist, ellers ingen. */
  function venterPaa(post) {
    const ut = [];
    const eierspm = Array.isArray(post?.eierspm) ? post.eierspm : [];
    if (post?.prioritet === 'eier' || eierspm.some((s) => s && !s.avklart)) ut.push('eier');
    if ((post?.jur_apne ?? juridiskeApne(post).length) > 0) ut.push('jurist');
    return ut.length ? ut : ['ingen'];
  }

  // ---- Filtrering og fasett-tall -----------------------------------------------------------------------------------

  /** Treffer søket posten? Uten hensyn til store og små bokstaver, i id, tittel, kort, prosjekt, roadmap og kilder. */
  function sokTreff(post, sok) {
    const s = String(sok ?? '')
      .trim()
      .toLowerCase();
    if (!s) return true;
    return [
      post.id,
      post.tittel,
      post.kort,
      post.prosjekt,
      post.merknad,
      ...(post.roadmap ?? []),
      ...(post.kilder ?? []).map((k) => k?.sti),
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
      .includes(s);
  }

  /** Passer posten fasetten (ingen valg = alle passer)? */
  function passerFasett(post, fasett, valgt, naa) {
    if (!valgt?.length) return true;
    const har = fasett.av(post, naa);
    return har.some((v) => valgt.includes(v));
  }

  /**
   * Postene som passer filtrene og søket. Droppede poster skjules som standard og vises når prioritet-
   * filteret tar med Dropp. `utenom` er en fasett som ikke skal telles med (brukes til fasett-tallene).
   */
  function filtrer(poster, filter = {}, sok = '', { naa = new Date(), utenom = null } = {}) {
    const pri = filter.pri ?? [];
    return (poster ?? []).filter((p) => {
      if (p.prioritet === 'dropp' && !pri.includes('dropp') && utenom !== 'pri') return false;
      for (const f of FASETTER) {
        if (f.id === utenom) continue;
        if (!passerFasett(p, f, filter[f.id], naa)) return false;
      }
      return sokTreff(p, sok);
    });
  }

  /**
   * Fasettene med antall treff per verdi. Antallet for en verdi regnes med alle de andre filtrene på (og uten valgene
   * i sin egen fasett), så tallet sier hvor mange treff du får ved å krysse av. Verdier uten treff skjules, men et
   * valgt filter står alltid, så det kan fjernes.
   * @returns {{ id, tittel, valg: { verdi, tekst, antall, valgt }[] }[]}
   */
  function fasettTall(
    poster,
    filter,
    sok,
    { naa = new Date(), moduler = [], prosjekter = {} } = {},
  ) {
    return FASETTER.map((f) => {
      const grunnlag = filtrer(poster, filter, sok, { naa, utenom: f.id });
      const tall = new Map();
      for (const p of grunnlag)
        for (const v of new Set(f.av(p, naa))) tall.set(v, (tall.get(v) ?? 0) + 1);
      let navn;
      if (f.id === 'modul') {
        navn = new Map(moduler.map((m) => [m.oid, m.tittel]));
        navn.set(UTEN_MODUL, 'Uten modul');
      } else if (f.id === 'prosjekt') {
        navn = new Map(Object.entries(prosjekter).map(([pid, x]) => [pid, x?.kort ?? pid]));
        navn.set(UTEN_PROSJEKT, 'Uten prosjekt');
      } else navn = new Map(Object.entries(f.verdier).map(([v, x]) => [v, verdiTekst(x)]));
      const valgt = filter?.[f.id] ?? [];
      const rekkefolge = [...new Set([...navn.keys(), ...tall.keys(), ...valgt])];
      const valg = rekkefolge
        .filter((v) => (tall.get(v) ?? 0) > 0 || valgt.includes(v))
        .map((v) => ({
          verdi: v,
          tekst: navn.get(v) ?? v,
          antall: tall.get(v) ?? 0,
          valgt: valgt.includes(v),
        }));
      return { id: f.id, tittel: f.tittel, valg };
    });
  }

  /** Teksten for en verdi i en fasett (prioritetene er objekter med tekst og symbol). */
  function verdiTekst(x) {
    return x && typeof x === 'object' ? x.tekst : String(x);
  }

  /** Brikkene over listen: ett per aktivt filtervalg, med teksten som vises. */
  function brikker(filter, { moduler = [], prosjekter = {} } = {}) {
    const ut = [];
    const modNavn = new Map(moduler.map((m) => [m.oid, m.tittel]));
    for (const f of FASETTER)
      for (const v of filter?.[f.id] ?? []) {
        let tekst = f.verdier?.[v] != null ? verdiTekst(f.verdier[v]) : null;
        if (f.id === 'modul') tekst = v === UTEN_MODUL ? 'Uten modul' : (modNavn.get(v) ?? v);
        if (f.id === 'prosjekt')
          tekst = v === UTEN_PROSJEKT ? 'Uten prosjekt' : (prosjekter[v]?.kort ?? v);
        ut.push({ fasett: f.id, verdi: v, tekst: `${f.tittel}: ${tekst ?? v}` });
      }
    return ut;
  }

  // ---- Treet: modul › prosjekt › post ------------------------------------------------------------------------------

  /** Andelen bygget for postene: bygget og verifisert teller 1, delvis teller ferdige/totalt, resten 0. */
  function fremdrift(poster) {
    let sum = 0;
    let bygget = 0;
    for (const p of poster) {
      if (p.modenhet === 'bygget' || p.modenhet === 'verifisert') {
        sum += 1;
        bygget += 1;
      } else if (p.modenhet === 'delvis' && p.totalt > 0) sum += p.ferdige / p.totalt;
    }
    const n = poster.length;
    return { bygget, n, andel: n ? sum / n : 0 };
  }

  /**
   * Treet for listen: modulene i registerets rekkefølge (bare de med treff), prosjektene i hver modul (alfabetisk på
   * tittel, «Uten prosjekt» sist) og postene i den rekkefølgen de kom (serveren har sortert dem etter prioritetsreglene).
   * Hvert nivå har fremdriften for postene sine samlet.
   */
  function tre(poster, { moduler = [], prosjekter = {} } = {}) {
    const perModul = new Map();
    for (const p of poster) {
      const m = p.modul ?? UTEN_MODUL;
      const pid = p.prosjekt && prosjekter[p.prosjekt] ? p.prosjekt : UTEN_PROSJEKT;
      if (!perModul.has(m)) perModul.set(m, new Map());
      const pm = perModul.get(m);
      if (!pm.has(pid)) pm.set(pid, []);
      pm.get(pid).push(p);
    }
    const orden = [
      ...moduler.map((m) => m.oid),
      ...[...perModul.keys()].filter((m) => !moduler.some((x) => x.oid === m)),
    ];
    const tittelFor = new Map(moduler.map((m) => [m.oid, m.tittel]));
    const ut = [];
    for (const oid of orden) {
      const pm = perModul.get(oid);
      if (!pm) continue;
      const prosj = [...pm.entries()]
        .map(([pid, liste]) => ({
          pid,
          tittel: pid === UTEN_PROSJEKT ? 'Uten prosjekt' : (prosjekter[pid]?.kort ?? pid),
          fullTittel: pid === UTEN_PROSJEKT ? null : (prosjekter[pid]?.tittel ?? null),
          poster: liste,
          fremdrift: fremdrift(liste),
        }))
        .sort(
          (a, b) =>
            (a.pid === UTEN_PROSJEKT) - (b.pid === UTEN_PROSJEKT) ||
            a.tittel.localeCompare(b.tittel, 'nb'),
        );
      const alle = prosj.flatMap((x) => x.poster);
      ut.push({
        oid,
        tittel: oid === UTEN_MODUL ? 'Uten modul' : (tittelFor.get(oid) ?? oid),
        prosjekter: prosj,
        antall: alle.length,
        fremdrift: fremdrift(alle),
      });
    }
    return ut;
  }

  // ---- Brødsmulestien og kopier-linjene --------------------------------------------------------------

  /** Kort navn for et prosjekt: tittelen fram til første parentes eller kolon (prosjekttitlene er ofte lange). */
  function kortNavn(tittel, pid) {
    const t = String(tittel ?? '')
      .split(/\s[(:]|[(:]/)[0]
      .trim();
    return t || pid;
  }

  /** «Modul › Prosjekt › Tittel» for en post, prosjekt eller modul (bare titler). */
  function stiTekst(deler) {
    return deler.filter(Boolean).join(' › ');
  }

  /**
   * Kopier-linja for et nivå, så eieren skriver instruksen rett etter. Bare id og titler.
   *   modul    /planer kjerne (Kjerne). Instruks:
   *   prosjekt /planer eksport (Kjerne › Eksport). Instruks:
   *   post     /planer PL-EKSPORT-1 (Kjerne › Eksport › CSV-eksport …). Instruks:
   *   eier     /planer eier SP-EKSPORT-1 (Kjerne › Eksport › PL-EKSPORT-1). Instruks:
   *   jur      /planer jur J-EKSPORT-2 (Kjerne › Eksport › PL-EKSPORT-1). Instruks:
   */
  function kopierLinje(niva, noekkel, deler) {
    const prefiks = niva === 'eier' ? 'eier ' : niva === 'jur' ? 'jur ' : '';
    const sti = stiTekst(deler);
    return `/planer ${prefiks}${noekkel}${sti ? ` (${sti})` : ''}. Instruks:`;
  }

  /** Titlene over en post: [modul, prosjekt] (kortnavn), slik brødsmulestien viser dem. */
  function overPost(post, data) {
    const modul = (data.moduler ?? []).find((m) => m.oid === post.modul);
    const pr = post.prosjekt ? data.prosjekter?.[post.prosjekt] : null;
    return [
      modul?.tittel ?? (post.modul ? post.modul : 'Uten modul'),
      pr ? (pr.kort ?? post.prosjekt) : post.prosjekt ? post.prosjekt : 'Uten prosjekt',
    ];
  }

  /**
   * Brødsmulestien under toppen: Planer › Modul › Prosjekt › Post. Med en valgt post bygges stien fra posten; ellers
   * fra filteret når det står på nøyaktig én modul (og ev. ett prosjekt). Hvert ledd har tilstanden et klikk gir og
   * kopier-linja for nivået (ikke for «Planer»).
   * @returns {{ niva: 'rom'|'modul'|'prosjekt'|'post', noekkel: string|null, tekst: string, kopier: string|null,
   *   filter: Record<string,string[]>|null, post: string|null }[]}
   */
  function brodsmuler(tilstand, data) {
    if (tilstand.flate === 'dok') return dokBrodsmuler(tilstand, data);
    if (JB_FLATER.includes(tilstand.flate)) return jbBrodsmuler(tilstand, data);
    // oversikten. «Planer» tar deg til listen over planpostene.
    if (tilstand.flate === 'oversikt')
      return [
        {
          niva: 'rom',
          noekkel: null,
          tekst: 'Planer',
          kopier: null,
          filter: null,
          post: null,
          tilstand: { flate: 'poster' },
        },
        {
          niva: 'flate',
          noekkel: 'oversikt',
          tekst: 'Oversikt',
          kopier: null,
          filter: null,
          post: null,
        },
      ];
    const ut = [
      {
        niva: 'rom',
        noekkel: null,
        tekst: 'Planer',
        kopier: null,
        filter: tomtFilter(),
        post: null,
      },
    ];
    const post = tilstand.post ? (data.poster ?? []).find((p) => p.id === tilstand.post) : null;
    let modul = null;
    let prosjekt = null;
    if (post) {
      modul = post.modul ?? null;
      prosjekt = post.prosjekt ?? null;
    } else {
      if (tilstand.filter?.modul?.length === 1) modul = tilstand.filter.modul[0];
      if (tilstand.filter?.prosjekt?.length === 1) {
        prosjekt = tilstand.filter.prosjekt[0];
        if (!modul) modul = data.prosjekter?.[prosjekt]?.omrade ?? null;
      }
    }
    if (modul === UTEN_MODUL) modul = null;
    if (prosjekt === UTEN_PROSJEKT) prosjekt = null;
    const modulTittel = modul
      ? ((data.moduler ?? []).find((m) => m.oid === modul)?.tittel ?? modul)
      : null;
    if (modul) {
      const f = tomtFilter();
      f.modul = [modul];
      ut.push({
        niva: 'modul',
        noekkel: modul,
        tekst: modulTittel,
        kopier: kopierLinje('modul', modul, [modulTittel]),
        filter: f,
        post: null,
      });
    }
    if (prosjekt) {
      const pr = data.prosjekter?.[prosjekt];
      const navn = pr?.kort ?? prosjekt;
      const f = tomtFilter();
      if (modul) f.modul = [modul];
      f.prosjekt = [prosjekt];
      ut.push({
        niva: 'prosjekt',
        noekkel: prosjekt,
        tekst: navn,
        kopier: kopierLinje('prosjekt', prosjekt, [modulTittel, navn]),
        filter: f,
        post: null,
      });
    }
    if (post) {
      ut.push({
        niva: 'post',
        noekkel: post.id,
        tekst: post.id,
        kopier: postLinje(post, data),
        filter: null,
        post: post.id,
      });
    }
    return ut;
  }

  /** Startlinja for en post: /planer PL-X (Modul › Prosjekt › Tittel). Instruks: */
  function postLinje(post, data) {
    return kopierLinje('post', post.id, [...overPost(post, data), post.tittel]);
  }

  /**
   * «Klargjør for kø»: linja til /legg-til-ko og kontrollene før pakking (posten er klar, ingen åpne
   * eierspørsmål, ingen åpne juridiske punkter som blokkerer pakking eller prod). Advarslene stopper ikke kopieringen.
   */
  function klargjor(post, data) {
    const advarsler = [];
    if (post.modenhet !== 'klar')
      advarsler.push(
        `Posten er ${MODENHET[post.modenhet]?.toLowerCase() ?? post.modenhet}, ikke klar.`,
      );
    const apneSp = (post.eierspm ?? []).filter((s) => !s.avklart);
    if (apneSp.length)
      advarsler.push(
        `${apneSp.length} ${apneSp.length === 1 ? 'åpent eierspørsmål' : 'åpne eierspørsmål'}: ` +
          `${apneSp.map((s) => s.id).join(', ')}.`,
      );
    const jur = juridiskeApne(post).filter(
      (x) => x.blokkerer === 'pakking' || x.blokkerer === 'prod',
    );
    if (jur.length)
      advarsler.push(
        `${jur.length} ${jur.length === 1 ? 'åpent juridisk punkt' : 'åpne juridiske punkter'} som blokkerer: ` +
          `${jur.map((x) => x.id).join(', ')}.`,
      );
    const linje = `/legg-til-ko ${post.id} (${stiTekst([...overPost(post, data), post.tittel])})`;
    return { linje, advarsler };
  }

  // ---- Koblingen til køen ---------------------------------------------------------------------------------

  const KOLONNE_TEKST = {
    forslag: 'Forslag, ikke godkjent',
    samle: 'I samlekøen, pakkes til et spor',
    pagar: 'Pågår',
    review: 'Til review',
    bygget: 'Ferdig',
  };

  /**
   * Statusteksten for en køoppgave i fanen Kø: f.eks. «I kø, trinn 2 i fokus (Kjerne)» eller «I kø, utenfor fokus:
   * startes ikke». Fokustrinnet er køens akse; prioriteten (Nå, Senere) er planregisterets, og de vises hver for seg.
   * @param {{ status?: string, kolonne?: string|null, steg?: number|null, utenfor?: boolean, gjelder?: boolean,
   *   trinn_tittel?: string|null }} o
   */
  function koStatusTekst(o) {
    if (o.kolonne === 'ko') {
      if (!o.gjelder) return 'I kø';
      if (o.utenfor || o.steg == null) return 'I kø, utenfor fokus: startes ikke';
      return `I kø, trinn ${o.steg + 1} i fokus${o.trinn_tittel ? ` (${o.trinn_tittel})` : ''}`;
    }
    if (o.kolonne && KOLONNE_TEKST[o.kolonne]) return KOLONNE_TEKST[o.kolonne];
    return o.status === 'kansellert' ? 'Kansellert' : String(o.status ?? 'ukjent');
  }

  // ---- Ferdige visninger ----------------------------------------------------------------------------------

  /** De ferdige visningene som søkedeler. Egne visninger lagres på samme form i nettleseren. */
  const FERDIGE_VISNINGER = [
    { id: 'for-prod', navn: 'Før prod', sok: '?rom=planer&pri=naa&kat=for-prod' },
    { id: 'sikkerhet', navn: 'Sikkerhet', sok: '?rom=planer&pri=naa&kat=sikkerhet' },
    { id: 'venter', navn: 'Venter på meg', sok: '?rom=planer&venter=eier' },
    { id: 'foreldet', navn: 'Foreldet', sok: '?rom=planer&foreldet=ja' },
    { id: 'dropp-agent', navn: 'Droppet av agent', sok: '?rom=planer&pri=dropp&satt=agent' },
  ];

  /** Samme filtre og søk (rekkefølgen i listene teller ikke)? Brukes til å markere visningen som er i bruk. */
  function sammeVisning(a, b) {
    const ta = lesUrl(a);
    const tb = lesUrl(b);
    if (ta.sok !== tb.sok) return false;
    return FASETTER.every((f) => {
      const x = [...ta.filter[f.id]].sort().join(',');
      const y = [...tb.filter[f.id]].sort().join(',');
      return x === y;
    });
  }

  /** En egen visning fra nettleseren (localStorage): navn og søkedel, renset. Ugyldig gir null. */
  function rensEgenVisning(x) {
    if (!x || typeof x !== 'object') return null;
    const navn = String(x.navn ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, 60);
    if (!navn) return null;
    const t = lesUrl(String(x.sok ?? ''));
    return {
      navn,
      sok: skrivUrl({
        ...t,
        rom: 'planer',
        post: null,
        flate: 'poster',
        dfilter: tomtDokFilter(),
        dsok: '',
        dok: null,
      }),
    };
  }

  // ---- Data fra serveren (/api/planer) -----------------------------------------------------------------------------

  /** Prosjektets kortnavn og tittel, modul (omrade) og fase. */
  function prosjektInfo(prosjekter) {
    const ut = {};
    for (const [pid, p] of Object.entries(prosjekter ?? {})) {
      ut[pid] = {
        tittel: p?.tittel ?? pid,
        kort: kortNavn(p?.tittel, pid),
        omrade: p?.omrade ?? null,
        fase: p?.fase ?? null,
      };
    }
    return ut;
  }

  /**
   * Det /api/planer sender: modulene, prosjektene og postene med alt listen og panelet trenger. Postene er sortert
   * etter prioritetsreglene (koPlan.sorterPoster), med avledet modenhet, kø-oppgavene med status og fokustrinn, eierspørsmålene
   * med tekst, åpne juridiske punkter, «Arbeider nå» og historikken fra endringsloggen (bare feltnavn).
   * @param {object} reg planer.json (normalisert)
   * @param {object} ko ko.json
   * @param {{ naa?: Date, koInfo?: (o: object) => object, koPlan?: object }} ctx koInfo gir kolonne og fokustrinn
   *   for en køoppgave (serveren regner det med koTavle og koLogikk)
   */
  function planerData(reg, ko, ctx = {}) {
    const P = ctx.koPlan ?? require('./koPlan.js');
    const naa = ctx.naa ?? new Date();
    const koInfo = ctx.koInfo ?? (() => ({}));
    const prosjekter = prosjektInfo(ko?.prosjekter);
    const omrader = ko?.omrader ?? {};
    const kjente = P.MODULER.map((m) => m.oid);
    const moduler = [
      ...kjente.filter((oid) => Object.hasOwn(omrader, oid)),
      ...Object.keys(omrader).filter((oid) => !kjente.includes(oid)),
    ].map((oid) => ({ oid, tittel: omrader[oid]?.tittel ?? oid }));
    const perId = new Map((ko?.oppgaver ?? []).map((o) => [o.id, o]));
    const avklart = new Set(ko?.avklart ?? []);
    const aktive = P.aktivePoster(reg, { naa });
    const historikk = new Map();
    for (const h of reg.endringslogg ?? []) {
      const perPost = new Map();
      for (const e of h?.endringer ?? []) {
        if (!e?.id) continue;
        if (!perPost.has(e.id)) perPost.set(e.id, []);
        perPost.get(e.id).push(String(e.felt ?? '*'));
      }
      for (const [id, felt] of perPost) {
        if (!historikk.has(id)) historikk.set(id, []);
        historikk.get(id).push({
          nr: h.nr,
          at: h.at ?? null,
          av: h.av ?? null,
          handling: h.handling ?? null,
          felt,
        });
      }
    }
    const alle = reg.poster ?? [];
    const poster = P.sorterPoster(alle).map((p) => {
      const av = P.avledetModenhet(p, ko?.oppgaver, { naa });
      const jur = p.juridisk && typeof p.juridisk === 'object' ? p.juridisk : null;
      const ut = {
        id: p.id,
        tittel: p.tittel ?? p.id,
        kort: p.kort ?? null,
        prosjekt: p.prosjekt ?? null,
        modul: P.modulFor(p, ko?.prosjekter) ?? null,
        prioritet: p.prioritet ?? null,
        naa_kategori: Array.isArray(p.naa_kategori) ? p.naa_kategori : [],
        prioritet_grunn: p.prioritet_grunn ?? null,
        prioritet_satt_av: p.prioritet_satt_av ?? 'agent',
        modenhet: av.modenhet,
        modenhet_plan: p.modenhet ?? null,
        estimat: p.estimat ?? null,
        frist: p.frist ?? null,
        kilder: (p.kilder ?? []).map((k) => ({
          sti: k?.sti ?? '',
          anker: k?.anker ?? null,
          rolle: k?.rolle ?? null,
        })),
        roadmap: p.roadmap ?? [],
        avhenger: p.avhenger ?? [],
        blokkerer: P.blokkerer(p, alle).map((q) => q.id),
        eierspm: (p.eierspm ?? []).map((s) => ({
          id: s,
          tekst: ko?.sporsmal?.[s]?.tekst ?? null,
          avklart: avklart.has(s),
          svar: ko?.avklaringer?.[s]?.svar ?? null,
          // en eierhandling med frist står i fristbåndet (feltet tas bare med når det finnes).
          ...(typeof ko?.sporsmal?.[s]?.frist === 'string' ? { frist: ko.sporsmal[s].frist } : {}),
        })),
        juridisk: jur,
        jur_apne: juridiskeApne(p).length,
        foreldet: av.foreldet,
        ferdige: av.ferdige,
        totalt: av.totalt,
        brok: av.brok,
        ko: av.ko_oppgaver.map((id) => {
          const o = perId.get(id) ?? {};
          return { id, tittel: o.tittel ?? null, status: o.status ?? null, ...koInfo(o) };
        }),
        verifisert: p.verifisert ?? null,
        dropp_grunn: p.dropp_grunn ?? null,
        merknad: p.merknad ?? null,
        sammenslatt_fra: p.sammenslatt_fra ?? [],
        aktiv: aktive[p.id] ?? null,
        opprettet: p.opprettet ?? null, // «Nylig registrert»
        historikk: (historikk.get(p.id) ?? []).slice(-20).reverse(),
      };
      return ut;
    });
    return {
      moduler,
      prosjekter,
      poster,
      ...dokumenterData(reg, ko, { naa, P, historikk }),
      // juridisk panel, eierbeslutninger og lanseringsoversikten.
      ...jbData(reg, ko, { naa, P }),
      // Dokumentmappene lesevisningen kan lese fra (nettleseren kaller settLesMapper med dem).
      les_mapper: lesMapper.slice(),
      // prioritetsreglene (koPlan.PRIORITETSREGLER, fra konfigurasjonen) til kolonnene i prioritetskartet.
      regler: (P.PRIORITETSREGLER ?? []).map((r) => ({
        nr: r.nr,
        navn: r.navn,
        prioritet: r.prioritet,
        kategorier: r.kategorier ?? [],
      })),
      // kapasiteten i Nå med varsel når Nå vokser raskere enn køen tømmes, og hva som er nylig
      // endret og registrert. ctx.ferdigePerUke regner serveren fra køen (som `plan sjekk`).
      ...(P.kapasitet
        ? (() => {
            const kap = P.kapasitet(reg, ko, { ferdigePerUke: ctx.ferdigePerUke ?? null, naa });
            const dager = P.KAPASITET_VINDU_DAGER ?? 28;
            const tilgang = naaTilgang(reg, { naa, dager, estimatSpor: P.ESTIMAT_SPOR ?? {} });
            return {
              kapasitet: { ...kap, tilgang, ...kapasitetVarsel(kap, tilgang, { dager }) },
            };
          })()
        : {}),
      nylig: { endret: nyligEndret(reg), registrert: nyligRegistrert(reg) },
      endret: reg.endret ?? null,
    };
  }

  /** Planposten hver køoppgave hører til (oppgave-id → post-id), for merket på køkortene. */
  function planForOppgave(poster) {
    const ut = {};
    for (const p of poster ?? []) for (const o of p.ko ?? []) ut[o.id] = p.id;
    return ut;
  }

  // ---- Dokumenter og avtaler -------------------------------------------------------

  /** Treffer søket dokumentet? I id, tittel, kilde, merknad og problemene. */
  function dokSokTreff(d, sok) {
    const s = String(sok ?? '')
      .trim()
      .toLowerCase();
    if (!s) return true;
    return [d.id, d.tittel, d.kilde, d.merknad, ...(d.problemer ?? []).map((p) => p?.tekst)]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
      .includes(s);
  }

  /**
   * Dokumentene som passer filtrene og søket. Droppede skjules til prioritetsfilteret tar med Dropp (som postene).
   * `utenom` er en fasett som ikke telles med (fasett-tallene).
   */
  function dokFiltrer(dokumenter, dfilter = {}, sok = '', { utenom = null } = {}) {
    const pri = dfilter.pri ?? [];
    return (dokumenter ?? []).filter((d) => {
      if (d.prioritet === 'dropp' && !pri.includes('dropp') && utenom !== 'pri') return false;
      for (const f of DOK_FASETTER) {
        if (f.id === utenom) continue;
        const valgt = dfilter[f.id];
        if (valgt?.length && !f.av(d).some((v) => valgt.includes(v))) return false;
      }
      return dokSokTreff(d, sok);
    });
  }

  /** Fasettene for dokumentene med antall treff per verdi (samme regel som fasettTall). */
  function dokFasettTall(dokumenter, dfilter, sok) {
    return DOK_FASETTER.map((f) => {
      const grunnlag = dokFiltrer(dokumenter, dfilter, sok, { utenom: f.id });
      const tall = new Map();
      for (const d of grunnlag)
        for (const v of new Set(f.av(d))) tall.set(v, (tall.get(v) ?? 0) + 1);
      const valgt = dfilter?.[f.id] ?? [];
      const valg = Object.keys(f.verdier)
        .filter((v) => (tall.get(v) ?? 0) > 0 || valgt.includes(v))
        .map((v) => ({
          verdi: v,
          tekst: verdiTekst(f.verdier[v]),
          symbol: f.verdier[v]?.symbol ?? null,
          antall: tall.get(v) ?? 0,
          valgt: valgt.includes(v),
        }));
      return { id: f.id, tittel: f.tittel, valg };
    });
  }

  /** Brikkene over tabellen: ett per aktivt dokumentfilter. */
  function dokBrikker(dfilter) {
    const ut = [];
    for (const f of DOK_FASETTER)
      for (const v of dfilter?.[f.id] ?? [])
        ut.push({ fasett: f.id, verdi: v, tekst: `${f.tittel}: ${verdiTekst(f.verdier[v] ?? v)}` });
    return ut;
  }

  /** Antall aktive dokumentfiltre (søket ikke medregnet). */
  function antallDokFiltre(dfilter) {
    return DOK_FASETTER.reduce((n, f) => n + (dfilter?.[f.id]?.length ?? 0), 0);
  }

  /**
   * Én tabell per gruppe, i rekkefølgen i DOK_GRUPPE; bare grupper med treff. Hver gruppe har
   * antall per status (for oppsummeringen) og antall som må gjøres noe med.
   */
  function dokGrupper(treff) {
    const ut = [];
    for (const [id, tittel] of Object.entries(DOK_GRUPPE)) {
      const dokumenter = (treff ?? []).filter((d) => d.gruppe === id);
      if (!dokumenter.length) continue;
      const status = {};
      for (const d of dokumenter) status[d.status] = (status[d.status] ?? 0) + 1;
      ut.push({
        id,
        tittel,
        dokumenter,
        antall: dokumenter.length,
        maa: dokumenter.filter((d) => (d.grunner ?? []).length).length,
        status,
      });
    }
    return ut;
  }

  /** «Oktober 2026» for en måned (YYYY-MM). */
  function maanedNavn(ym) {
    const t = new Intl.DateTimeFormat('nb-NO', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${ym}-15T12:00:00Z`));
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  /**
   * Tidslinjen for revisjoner og frister, delt i «Forfalt» og én kolonne per måned (bare måneder med noe i), så
   * nært forestående står først.
   * @param {{ id, tittel, type, dato, dager, forfalt }[]} elementer fra koPlan.revisjonsTidslinje
   * @returns {{ noekkel: string, tittel: string, forfalt: boolean, elementer: object[] }[]}
   */
  function tidslinjeMaaneder(elementer) {
    const ut = [];
    const forfalt = (elementer ?? []).filter((e) => e.forfalt);
    if (forfalt.length)
      ut.push({ noekkel: 'forfalt', tittel: 'Forfalt', forfalt: true, elementer: forfalt });
    const perMnd = new Map();
    for (const e of elementer ?? []) {
      if (e.forfalt) continue;
      const ym = String(e.dato).slice(0, 7);
      if (!perMnd.has(ym)) perMnd.set(ym, []);
      perMnd.get(ym).push(e);
    }
    for (const ym of [...perMnd.keys()].sort())
      ut.push({ noekkel: ym, tittel: maanedNavn(ym), forfalt: false, elementer: perMnd.get(ym) });
    return ut;
  }

  /** Kopier-linja for et dokument, som koPlan.dokKopierLinje. */
  function dokLinje(d) {
    return `/planer dok ${d.id}. Instruks:`;
  }

  /**
   * Stien for dokumentflaten: Planer › Dokumenter og avtaler › Gruppe › DOK-id. Hvert ledd har `tilstand` (det et
   * klikk setter) og kopier-linja der den finnes.
   */
  function dokBrodsmuler(tilstand, data) {
    const ut = [
      {
        niva: 'rom',
        noekkel: null,
        tekst: 'Planer',
        kopier: null,
        filter: null,
        post: null,
        tilstand: { flate: 'poster', dok: null },
      },
      {
        niva: 'flate',
        noekkel: 'dok',
        tekst: 'Dokumenter og avtaler',
        kopier: null,
        filter: null,
        post: null,
        tilstand: { flate: 'dok', dfilter: tomtDokFilter(), dsok: '', dok: null },
      },
    ];
    const d = tilstand.dok ? (data?.dokumenter ?? []).find((x) => x.id === tilstand.dok) : null;
    const gruppe = d
      ? d.gruppe
      : tilstand.dfilter?.gruppe?.length === 1
        ? tilstand.dfilter.gruppe[0]
        : null;
    if (gruppe && DOK_GRUPPE[gruppe]) {
      const f = tomtDokFilter();
      f.gruppe = [gruppe];
      ut.push({
        niva: 'gruppe',
        noekkel: gruppe,
        tekst: DOK_GRUPPE[gruppe],
        kopier: null,
        filter: null,
        post: null,
        tilstand: { flate: 'dok', dfilter: f, dok: null },
      });
    }
    if (d)
      ut.push({
        niva: 'dok',
        noekkel: d.id,
        tekst: d.id,
        kopier: dokLinje(d),
        filter: null,
        post: null,
        tilstand: { flate: 'dok', dok: d.id },
      });
    return ut;
  }

  /**
   * Dokumentene slik fanen viser dem (serveren kaller dette fra planerData): feltene fra registeret, versjonsglipp,
   * neste revisjon, varslene for fasetten, «Hva må gjøres»-grunnene, koblingene med titler og historikken (bare
   * feltnavn). I tillegg lista «Hva må gjøres» og tidslinjen for de neste 12 månedene.
   */
  function dokumenterData(reg, ko, { naa = new Date(), P, historikk = new Map() } = {}) {
    const alle = Array.isArray(reg?.dokumenter) ? reg.dokumenter : [];
    const avklart = new Set(ko?.avklart ?? []);
    const postTittel = new Map((reg?.poster ?? []).map((p) => [p.id, p.tittel ?? p.id]));
    const dokTittel = new Map(alle.map((d) => [d.id, d]));
    const dokumenter = alle.map((d) => {
      const glipp = P.versjonsglipp(d);
      const neste = P.nesteRevisjon(d, { naa });
      const problemer = Array.isArray(d.problemer) ? d.problemer : [];
      const varsel = [];
      if (problemer.some((p) => p?.alvor === 'hoy')) varsel.push('problem-hoy');
      if (problemer.length) varsel.push('problem');
      if (glipp.length) varsel.push('glipp');
      if (neste?.forfalt) varsel.push('forfalt');
      else if (neste?.snart) varsel.push('snart');
      return {
        id: d.id,
        tittel: d.tittel ?? d.id,
        gruppe: d.gruppe ?? null,
        malgruppe: d.malgruppe ?? null,
        status: d.status ?? null,
        kilde: d.kilde ?? null,
        publisert: Array.isArray(d.publisert) ? d.publisert : [],
        versjon: d.versjon ?? null,
        gjeldende_versjon: d.gjeldende_versjon ?? null,
        sist_revidert: d.sist_revidert ?? null,
        revisjon_hver: d.revisjon_hver ?? null,
        revisjoner: Array.isArray(d.revisjoner) ? d.revisjoner : [],
        problemer,
        prioritet: d.prioritet ?? null,
        naa_kategori: Array.isArray(d.naa_kategori) ? d.naa_kategori : [],
        prioritet_grunn: d.prioritet_grunn ?? null,
        prioritet_satt_av: d.prioritet_satt_av ?? null,
        dropp_grunn: d.dropp_grunn ?? null,
        frist: d.frist ?? null,
        merknad: d.merknad ?? null,
        juridisk_punkter: d.juridisk_punkter ?? [],
        avhenger_av: (d.avhenger_av ?? []).map((id) => ({
          id,
          tittel: dokTittel.get(id)?.tittel ?? null,
          status: dokTittel.get(id)?.status ?? null,
        })),
        brukt_av: alle.filter((x) => (x.avhenger_av ?? []).includes(d.id)).map((x) => x.id),
        planposter: (d.planposter ?? []).map((id) => ({ id, tittel: postTittel.get(id) ?? null })),
        eierspm: (d.eierspm ?? []).map((id) => ({
          id,
          tekst: ko?.sporsmal?.[id]?.tekst ?? null,
          avklart: avklart.has(id),
        })),
        glipp,
        neste_revisjon: neste,
        varsel,
        grunner: P.dokGrunner(d, { naa }),
        historikk: (historikk.get(d.id) ?? []).slice(-20).reverse(),
      };
    });
    return {
      dokumenter,
      dok_maa_gjores: P.dokMaaGjores(alle, { naa }),
      dok_tidslinje: P.revisjonsTidslinje(alle, { naa, dager: 365 }),
    };
  }

  // ---- prioritetskartet og fristbåndet -------------------------------------------------------
  //
  // Prioritetskartet: modulene som rader, Nå (sikkerhet, før prod, viktig), Eier, Senere og Dropp (foldet) som
  // kolonner. Postene dras mellom kolonnene i samme rad (modulen følger prosjektet og endres ikke her). Flyttingene
  // samles i et utkast ({ [post-id]: { til, grunn? } }) som forhåndsvises og lagres samlet via ko.mjs plan prioriter.
  // Fristbåndet: frister fra poster, dokumenter og eierhandlinger de neste 90 dagene, pluss det som er forfalt.

  /** Kolonnene i kartet, i rekkefølge. Symbolet står alltid sammen med teksten (farge er aldri eneste bærer). */
  const KART_KOLONNER = [
    {
      id: 'naa-sikkerhet',
      prioritet: 'naa',
      kategori: 'sikkerhet',
      tekst: 'Nå: sikkerhet',
      symbol: '●',
    },
    {
      id: 'naa-for-prod',
      prioritet: 'naa',
      kategori: 'for-prod',
      tekst: 'Nå: før prod',
      symbol: '●',
    },
    { id: 'naa-viktig', prioritet: 'naa', kategori: 'viktig', tekst: 'Nå: viktig', symbol: '●' },
    { id: 'eier', prioritet: 'eier', kategori: null, tekst: 'Eier', symbol: '◆' },
    { id: 'senere', prioritet: 'senere', kategori: null, tekst: 'Senere', symbol: '○' },
    { id: 'dropp', prioritet: 'dropp', kategori: null, tekst: 'Dropp', symbol: '✕', foldet: true },
  ];
  const KART_KOLONNE_IDER = KART_KOLONNER.map((k) => k.id);
  /** Nå-kategoriene i den rekkefølgen en post med flere kategorier plasseres (den første den har). */
  const NAA_REKKEFOLGE = ['sikkerhet', 'for-prod', 'viktig'];
  /** Fristbåndet viser de neste 90 dagene. */
  const FRIST_DAGER = 90;
  /** Grensene for lagringen (serveren sjekker de samme). */
  const UTKAST_MAKS = 300;
  const GRUNN_MAKS = 500;

  /** Kolonnen fra id-en (null når den er ukjent). */
  function kartKolonne(id) {
    return KART_KOLONNER.find((k) => k.id === id) ?? null;
  }

  /**
   * Kolonnen en post står i etter registeret: Nå etter den første kategorien den har (sikkerhet før før prod før
   * viktig), ellers prioriteten. Nå uten kategori (ugyldig i registeret) står under viktig. Ukjent prioritet: null.
   */
  function kartKolonneFor(post) {
    if (post?.prioritet === 'naa') {
      const kat = NAA_REKKEFOLGE.find((k) => (post.naa_kategori ?? []).includes(k)) ?? 'viktig';
      return `naa-${kat}`;
    }
    return KART_KOLONNE_IDER.includes(post?.prioritet) ? post.prioritet : null;
  }

  /** Kolonnen posten står i med utkastet. */
  function kolonneMedUtkast(post, utkast) {
    return utkast?.[post.id]?.til ?? kartKolonneFor(post);
  }

  /**
   * Prioritetsreglene som gir en kolonne (koPlan.PRIORITETSREGLER, sendt som `regler` i /api/planer), så kolonne-
   * hodet kan vise hvorfor en post hører hjemme der.
   */
  function kolonneRegler(regler, kolonneId) {
    const k = kartKolonne(kolonneId);
    if (!k) return [];
    return (regler ?? []).filter(
      (r) =>
        r.prioritet === k.prioritet && (!k.kategori || (r.kategorier ?? []).includes(k.kategori)),
    );
  }

  /**
   * Postene kartet viser: de samme som listen (filtre og søk), og i tillegg de droppede som passer de andre
   * filtrene når prioritetsfilteret er tomt, så Dropp-kolonnen (foldet) har noe å telle. Velger prioritetsfilteret
   * selv, gjelder det som i listen.
   */
  function kartPoster(poster, filter = {}, sok = '', { naa = new Date() } = {}) {
    const vis = filtrer(poster, filter, sok, { naa });
    if ((filter.pri ?? []).length) return vis;
    const dropp = filtrer(poster, filter, sok, { naa, utenom: 'pri' }).filter(
      (p) => p.prioritet === 'dropp',
    );
    return [...vis, ...dropp];
  }

  /**
   * Rutenettet: én rad per modul med treff (i modulrekkefølgen, «Uten modul» sist), én celle per kolonne. Hver
   * brikke har posten, om den er flyttet i utkastet, og kolonnen den kom fra. Rekkefølgen i cellene er listens.
   * @returns {{ kolonner: object[], rader: { oid, tittel, antall, celler: Record<string, object[]> }[], utenPrioritet: object[] }}
   */
  function kartRutenett(poster, moduler = [], utkast = {}) {
    const radRekke = [...(moduler ?? []).map((m) => m.oid), UTEN_MODUL];
    const titler = new Map((moduler ?? []).map((m) => [m.oid, m.tittel]));
    titler.set(UTEN_MODUL, 'Uten modul');
    const rader = new Map();
    const antall = Object.fromEntries(KART_KOLONNE_IDER.map((k) => [k, 0]));
    const utenPrioritet = [];
    for (const p of poster ?? []) {
      const fra = kartKolonneFor(p);
      const til = kolonneMedUtkast(p, utkast);
      if (!kartKolonne(til)) {
        utenPrioritet.push(p);
        continue;
      }
      const oid = p.modul ?? UTEN_MODUL;
      if (!rader.has(oid)) {
        if (!radRekke.includes(oid)) radRekke.splice(radRekke.length - 1, 0, oid);
        rader.set(oid, Object.fromEntries(KART_KOLONNE_IDER.map((k) => [k, []])));
      }
      rader.get(oid)[til].push({ post: p, flyttet: til !== fra, fra });
      antall[til] += 1;
    }
    return {
      kolonner: KART_KOLONNER.map((k) => ({ ...k, antall: antall[k.id] })),
      rader: radRekke
        .filter((oid) => rader.has(oid))
        .map((oid) => {
          const celler = rader.get(oid);
          return {
            oid,
            tittel: titler.get(oid) ?? oid,
            antall: KART_KOLONNE_IDER.reduce((n, k) => n + celler[k].length, 0),
            celler,
          };
        }),
      utenPrioritet,
    };
  }

  /**
   * Flytter en post i utkastet (et nytt objekt; det gamle endres ikke). Tilbake til kolonnen den har i registeret
   * fjerner flyttingen. Grunnen beholdes så lenge posten står i Dropp.
   */
  function flyttIUtkast(utkast, post, til) {
    if (!post?.id || !kartKolonne(til)) return { ...(utkast ?? {}) };
    const ut = { ...(utkast ?? {}) };
    const gammel = ut[post.id];
    if (til === kartKolonneFor(post)) delete ut[post.id];
    else ut[post.id] = til === 'dropp' && gammel?.grunn ? { til, grunn: gammel.grunn } : { til };
    return ut;
  }

  /** Setter grunnen for en post som er flyttet til Dropp i utkastet. */
  function settUtkastGrunn(utkast, id, grunn) {
    const ut = { ...(utkast ?? {}) };
    if (ut[id]?.til !== 'dropp') return ut;
    ut[id] = { til: 'dropp', grunn: String(grunn ?? '').slice(0, GRUNN_MAKS) };
    return ut;
  }

  /**
   * Fjerner det i utkastet som ikke lenger gjelder: poster som er borte (slått sammen) og poster som alt står i
   * målkolonnen (endret av en annen økt imens). Kalles når registeret leses på nytt.
   */
  function rensUtkast(utkast, poster) {
    const perId = new Map((poster ?? []).map((p) => [p.id, p]));
    const ut = {};
    for (const [id, x] of Object.entries(utkast ?? {})) {
      const p = perId.get(id);
      if (!p || !kartKolonne(x?.til) || kartKolonneFor(p) === x.til) continue;
      ut[id] = x.til === 'dropp' && x.grunn ? { til: 'dropp', grunn: x.grunn } : { til: x.til };
    }
    return ut;
  }

  /** Nabokolonnen til venstre (-1) eller høyre (+1), eller null ved kanten (tastaturet). */
  function kolonneNabo(id, retning) {
    const i = KART_KOLONNE_IDER.indexOf(id);
    if (i < 0) return null;
    return KART_KOLONNE_IDER[i + (retning < 0 ? -1 : 1)] ?? null;
  }

  /**
   * Endringene i utkastet slik forhåndsvisningen viser dem, i listens rekkefølge, og feilene som stopper lagringen
   * (Dropp krever én setning som grunn; for mange på en gang).
   * @returns {{ endringer: { id, tittel, fra, til, fraTekst, tilTekst, grunn }[], feil: string[] }}
   */
  function utkastEndringer(utkast, poster) {
    const endringer = [];
    const feil = [];
    for (const p of poster ?? []) {
      const x = utkast?.[p.id];
      if (!x) continue;
      const fra = kartKolonneFor(p);
      if (x.til === fra || !kartKolonne(x.til)) continue;
      const grunn = String(x.grunn ?? '').trim();
      endringer.push({
        id: p.id,
        tittel: p.tittel ?? p.id,
        fra,
        til: x.til,
        fraTekst: kartKolonne(fra)?.tekst ?? 'Uten prioritet',
        tilTekst: kartKolonne(x.til).tekst,
        grunn: grunn || null,
      });
      if (x.til === 'dropp' && !grunn) feil.push(`${p.id}: Dropp krever én setning som grunn.`);
    }
    if (endringer.length > UTKAST_MAKS)
      feil.push(`For mange endringer på en gang (${endringer.length}, høyst ${UTKAST_MAKS}).`);
    return { endringer, feil };
  }

  /**
   * Endringene samlet til kall: ett per prioritet, kategori og grunn (ko.mjs plan prioriter setter én prioritet for
   * mange poster). Dropp har grunnen per post, så hver droppet post er ofte sitt eget kall.
   * @returns {{ prioritet: string, kategori: string[], grunn: string|null, ider: string[] }[]}
   */
  function utkastGrupper(endringer) {
    const ut = new Map();
    for (const e of endringer ?? []) {
      const k = kartKolonne(e.til);
      if (!k) continue;
      const grunn = k.prioritet === 'dropp' ? (e.grunn ?? null) : null;
      const nokkel = `${k.prioritet}|${k.kategori ?? ''}|${grunn ?? ''}`;
      if (!ut.has(nokkel))
        ut.set(nokkel, {
          prioritet: k.prioritet,
          kategori: k.kategori ? [k.kategori] : [],
          grunn,
          ider: [],
        });
      ut.get(nokkel).ider.push(e.id);
    }
    return [...ut.values()];
  }

  /** Teksten fra tavla blir et trygt argument: uten kontrolltegn og uten «-» først (ko.mjs ville lest et flagg). */
  function rensArg(x, maks) {
    return String(x ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .replace(/^-+\s*/, '')
      .slice(0, maks);
  }

  /**
   * Serverens sjekk av gruppene fra tavla og argumentene til `ko.mjs plan prioriter` (ett kall per gruppe). Eieren
   * sitter ved tavla, så kallene har --satt-av eier. Alt som ikke er gyldig gir feil, og da kjøres ingenting.
   * @returns {{ feil: string[], kall: string[][] }}
   */
  function prioriterKall(grupper) {
    const feil = [];
    const kall = [];
    if (!Array.isArray(grupper) || !grupper.length) return { feil: ['ingen endringer'], kall };
    const sett = new Set();
    for (const g of grupper) {
      if (!g || typeof g !== 'object') {
        feil.push('ugyldig gruppe');
        continue;
      }
      if (!PRIORITETER.includes(g.prioritet)) {
        feil.push(`ukjent prioritet ${String(g.prioritet).slice(0, 20)}`);
        continue;
      }
      const kategori = Array.isArray(g.kategori) ? g.kategori.map(String) : [];
      if (kategori.some((k) => !NAA_REKKEFOLGE.includes(k))) {
        feil.push('ukjent Nå-kategori');
        continue;
      }
      if (g.prioritet === 'naa' ? kategori.length !== 1 : kategori.length) {
        feil.push('Nå trenger nøyaktig én kategori, og bare Nå har kategori');
        continue;
      }
      const ider = Array.isArray(g.ider) ? g.ider.map(String) : [];
      if (!ider.length || ider.some((id) => !POST_ID.test(id) || sett.has(id))) {
        feil.push('ugyldige eller doble post-id-er');
        continue;
      }
      for (const id of ider) sett.add(id);
      const grunn = g.grunn == null ? '' : rensArg(g.grunn, GRUNN_MAKS);
      if (g.prioritet === 'dropp' && !grunn) {
        feil.push(`${ider.join(', ')}: Dropp krever én setning som grunn`);
        continue;
      }
      kall.push([
        'plan',
        'prioriter',
        ...ider,
        g.prioritet,
        ...(kategori.length ? ['--kategori', ...kategori] : []),
        ...(grunn ? ['--grunn', grunn] : []),
        '--satt-av',
        'eier',
        '--av',
        'tavla',
        '--json',
      ]);
    }
    if (sett.size > UTKAST_MAKS) feil.push(`for mange poster (høyst ${UTKAST_MAKS})`);
    return { feil, kall: feil.length ? [] : kall };
  }

  /**
   * Elementene i fristbåndet: frister på postene, eierspørsmål med frist (eierhandlinger) og dokumentenes frister og
   * neste revisjon, forfalt eller innen `dager` dager. `ider` er postene i utvalget (samme filtre som listen): da
   * tas bare dokumenter koblet til en av dem med, og bare eierspørsmålene deres. Uten `ider` tas alt med.
   * `andel` er plassen på stripa (0 = i dag, 1 = om `dager` dager; forfalte står på 0).
   * @returns {{ id, type: 'post'|'eier'|'dok'|'revisjon', tittel, dato, dager, forfalt, andel, post: string|null, dok: string|null }[]}
   */
  function fristElementer(
    poster,
    dokumenter,
    { naa = new Date(), dager: vindu = FRIST_DAGER, ider = null } = {},
  ) {
    const idag = osloDato(naa);
    const utvalg = ider ? new Set(ider) : null;
    const ut = [];
    const legg = (x, dato) => {
      if (typeof dato !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dato)) return;
      const n = dager(idag, dato);
      if (n > vindu) return;
      ut.push({ ...x, dato, dager: n, forfalt: n < 0, andel: n < 0 ? 0 : n / vindu });
    };
    const sett = new Set();
    for (const p of poster ?? []) {
      if (utvalg && !utvalg.has(p.id)) continue;
      if (p.prioritet === 'dropp') continue;
      legg({ id: p.id, type: 'post', tittel: p.tittel ?? p.id, post: p.id, dok: null }, p.frist);
      for (const s of p.eierspm ?? []) {
        if (!s?.frist || s.avklart || sett.has(s.id)) continue;
        sett.add(s.id);
        legg({ id: s.id, type: 'eier', tittel: s.tekst ?? s.id, post: p.id, dok: null }, s.frist);
      }
    }
    for (const d of dokumenter ?? []) {
      if (d.prioritet === 'dropp') continue;
      const koblet = (d.planposter ?? []).map((x) => (typeof x === 'string' ? x : x?.id));
      if (utvalg && !koblet.some((id) => utvalg.has(id))) continue;
      const tittel = d.tittel ?? d.id;
      if (d.status !== 'utdatert')
        legg({ id: d.id, type: 'dok', tittel, post: null, dok: d.id }, d.frist);
      const nr = d.neste_revisjon;
      if (nr?.dato) legg({ id: d.id, type: 'revisjon', tittel, post: null, dok: d.id }, nr.dato);
    }
    const typeRekke = { post: 0, eier: 1, dok: 2, revisjon: 3 };
    return ut.sort(
      (a, b) =>
        a.dager - b.dager || typeRekke[a.type] - typeRekke[b.type] || a.id.localeCompare(b.id),
    );
  }

  /**
   * Fordeler merkene på stripa i rader, så de ikke ligger oppå hverandre: et merke går i den første raden der
   * forrige merke står minst `avstand` (andel av bredden) unna. Over `maksRader` samles resten i `skjult` (vises
   * som «+N» og står i lista under stripa).
   * @returns {{ rader: object[][], skjult: object[] }}
   */
  function fristRader(elementer, { avstand = 0.06, maksRader = 3 } = {}) {
    const rader = [];
    const skjult = [];
    for (const e of elementer ?? []) {
      const r = rader.find((rad) => e.andel - rad[rad.length - 1].andel >= avstand);
      if (r) r.push(e);
      else if (rader.length < maksRader) rader.push([e]);
      else skjult.push(e);
    }
    return { rader, skjult };
  }

  /** Merkene under stripa: i dag og hver 30. dag, med dato (nb-NO, «15. okt.»). */
  function fristSkala(naa = new Date(), vindu = FRIST_DAGER) {
    const idag = osloDato(naa);
    const ut = [];
    for (let n = 0; n <= vindu; n += 30) {
      const d = new Date(`${idag}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      const dato = d.toISOString().slice(0, 10);
      const tekst =
        n === 0
          ? 'I dag'
          : new Intl.DateTimeFormat('nb-NO', {
              day: 'numeric',
              month: 'short',
              timeZone: 'UTC',
            }).format(d);
      ut.push({ dager: n, andel: n / vindu, dato, tekst });
    }
    return ut;
  }

  /** Teksten for et element i fristbåndet (til skjermleser og tittel): hva, når og hvor lenge til. */
  function fristTekst(e) {
    const hva = { post: 'Frist', eier: 'Eierhandling', dok: 'Dokumentfrist', revisjon: 'Revisjon' }[
      e.type
    ];
    const naar = e.forfalt
      ? `forfalt for ${-e.dager} ${-e.dager === 1 ? 'dag' : 'dager'} siden`
      : e.dager === 0
        ? 'i dag'
        : `om ${e.dager} ${e.dager === 1 ? 'dag' : 'dager'}`;
    return `${hva} ${e.dato} (${naar}): ${e.id} ${e.tittel}`;
  }

  // ---- lesevisningen av dokumenter og Uregistrert-boksen ------------------------------

  /**
   * Mappene /api/dok kan lese fra (relativt til hovedtreet): bare markdown under dokumentmappene (ko.config.json
   * `dokumentMapper`, standard docs/). Alt annet (kode, .env, konfigurasjon, andre filtyper) avvises før serveren
   * rører disken. I Node leses mappene fra konfigurasjonen når modulen lastes; i nettleseren setter planer.js dem fra
   * `les_mapper` i /api/planer (settLesMapper).
   */
  const LES_MAPPER_STANDARD = ['docs/'];
  let lesMapper = LES_MAPPER_STANDARD.slice();

  /** Setter mappene lesevisningen og Uregistrert-boksen bruker. En tom eller ugyldig liste gir standarden. */
  function settLesMapper(liste) {
    const ok = (Array.isArray(liste) ? liste : [])
      .filter((m) => typeof m === 'string' && m.trim() && !lesStiMappeFeil(m.trim()))
      .map((m) => m.trim().replace(/\/+$/, '') + '/');
    lesMapper = ok.length ? ok : LES_MAPPER_STANDARD.slice();
    return lesMapper.slice();
  }

  /** En mappe i lista må være relativ, uten `.`/`..` og skjulte ledd. */
  function lesStiMappeFeil(m) {
    if (/^[A-Za-z]:|^[\\/]/.test(m) || m.includes('\\')) return 'ikke relativ';
    const deler = m.replace(/\/+$/, '').split('/');
    return deler.some((d) => !d || d === '.' || d === '..' || d.startsWith('.')) ? 'ugyldig ledd' : null;
  }
  /** Største dokument lesevisningen viser (byte). */
  const LES_MAKS_BYTE = 2 * 1024 * 1024;
  const LES_STI_MAKS = 300;
  const ANKER_MAKS = 120;
  /** Samme mønster som koPlan.ID_MONSTER (PL-NAVN-1). */
  const NY_POST_ID = /^PL-[A-Z0-9ÆØÅ](?:[A-Za-z0-9ÆØÅæøå-]*[A-Za-z0-9ÆØÅæøå])?$/;
  const TITTEL_MAKS = 160;

  /** Har teksten kontrolltegn (linjeskift, tab, NUL og slikt)? */
  function harKontrolltegn(s) {
    for (let i = 0; i < s.length; i += 1) {
      const k = s.charCodeAt(i);
      if (k < 32 || k === 127) return true;
    }
    return false;
  }

  /**
   * Er stien lov å lese i lesevisningen? Første vern (serveren sjekker i tillegg symlenker, ekte sti og størrelse):
   * relativ sti med skråstrek, ingen `.`, `..`, tomme ledd eller skjulte ledd (`.env`, `.git`), ingen tegn Windows
   * tolker spesielt (`:` for datastrømmer, jokertegn), bare `.md`, og bare under dokumentmappene (settLesMapper).
   * @returns {string|null} feilteksten, eller null når stien er lov
   */
  function lesStiFeil(sti) {
    if (typeof sti !== 'string' || !sti) return 'mangler sti';
    if (sti.length > LES_STI_MAKS) return 'stien er for lang';
    if (harKontrolltegn(sti)) return 'stien har kontrolltegn';
    if (/^[A-Za-z]:|^[\\/]/.test(sti)) return 'stien må være relativ til prosjektrota';
    if (sti.includes('\\')) return 'bruk skråstrek /, ikke \\';
    if (/[:*?"<>|]/.test(sti)) return 'stien har tegn som ikke er lov';
    const deler = sti.split('/');
    if (deler.some((d) => d === '' || d === '.' || d === '..'))
      return '. og .. og tomme ledd er ikke lov i stien';
    if (deler.some((d) => d.startsWith('.'))) return 'skjulte filer og mapper leses ikke';
    if (deler.some((d) => /^\s|[\s.]$/.test(d)))
      return 'et ledd kan ikke starte med mellomrom eller slutte med punktum eller mellomrom';
    if (deler.some((d) => /~\d/.test(d))) return 'korte filnavn (8.3) er ikke lov';
    if (!/\.md$/i.test(sti)) return 'bare markdown (.md) kan leses';
    if (!lesMapper.some((m) => sti.startsWith(m)))
      return `bare dokumenter under ${lesMapper.join(', ')}`;
    return null;
  }

  /**
   * Hvor en lenke i et dokument peker: et annet dokument som kan leses (relativt til dokumentet, eller til rota med
   * `/` foran), et anker i samme dokument, en nettadresse (vises som tekst, åpnes aldri herfra), eller noe annet
   * (mailto:, javascript:, filer utenfor allowlisten), som bare vises som tekst.
   * @returns {{ type: 'dok', sti: string, anker: string|null } | { type: 'anker', anker: string } |
   *   { type: 'ekstern', url: string } | { type: 'annen' }}
   */
  function lenkeMaal(fra, href) {
    const h = String(href ?? '').trim();
    if (!h) return { type: 'annen' };
    if (/^https?:\/\//i.test(h)) return { type: 'ekstern', url: h };
    if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return { type: 'annen' };
    const avkod = (x) => {
      try {
        return decodeURIComponent(x);
      } catch {
        return null;
      }
    };
    const hash = h.indexOf('#');
    const del = hash >= 0 ? h.slice(0, hash) : h;
    const anker = hash >= 0 ? avkod(h.slice(hash + 1)) : null;
    if (!del) return anker ? { type: 'anker', anker } : { type: 'annen' };
    const stiDel = avkod(del);
    if (stiDel == null || stiDel.includes('\\')) return { type: 'annen' };
    const ut = stiDel.startsWith('/')
      ? []
      : String(fra ?? '')
          .split('/')
          .slice(0, -1);
    for (const d of stiDel.split('/')) {
      if (d === '' || d === '.') continue;
      if (d === '..') {
        if (!ut.length) return { type: 'annen' };
        ut.pop();
      } else ut.push(d);
    }
    const sti = ut.join('/');
    return lesStiFeil(sti) ? { type: 'annen' } : { type: 'dok', sti, anker: anker || null };
  }

  /**
   * Deler en linje markdown i biter som kan tegnes med textContent: tekst, kode, fet, kursiv og lenke. Ingen HTML
   * tolkes: `<b>` blir stående som tekst. Bilder vises som «[bilde: alt]».
   * @returns {Array<{ type: string, tekst?: string, mal?: string, deler?: object[] }>}
   */
  function inlineDeler(tekst, dybde = 0) {
    const s = String(tekst ?? '');
    const ut = [];
    let buf = '';
    const tom = () => {
      if (buf) ut.push({ type: 'tekst', tekst: buf });
      buf = '';
    };
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && /[\\`*_[\]()#+\-.!|<>~{}]/.test(s[i + 1])) {
        buf += s[i + 1];
        i += 2;
        continue;
      }
      if (c === '`') {
        let n = 1;
        while (s[i + n] === '`') n += 1;
        const merke = '`'.repeat(n);
        const j = s.indexOf(merke, i + n);
        if (j > i) {
          tom();
          ut.push({ type: 'kode', tekst: s.slice(i + n, j).replace(/^ (.*) $/, '$1') });
          i = j + n;
        } else {
          buf += merke;
          i += n;
        }
        continue;
      }
      if (c === '!' && s[i + 1] === '[') {
        const m = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(s.slice(i));
        if (m) {
          buf += `[bilde: ${m[1] || m[2]}]`;
          i += m[0].length;
          continue;
        }
      }
      if (c === '[') {
        const m = /^\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i));
        if (m) {
          tom();
          ut.push({ type: 'lenke', tekst: renTekst(m[1]) || m[2], mal: m[2] });
          i += m[0].length;
          continue;
        }
      }
      if (c === '<') {
        const m = /^<(https?:\/\/[^>\s]+)>/i.exec(s.slice(i));
        if (m) {
          tom();
          ut.push({ type: 'lenke', tekst: m[1], mal: m[1] });
          i += m[0].length;
          continue;
        }
      }
      if ((c === '*' || c === '_') && dybde < 4) {
        const dobbel = s[i + 1] === c;
        const merke = dobbel ? c + c : c;
        const for_ = s[i - 1] ?? '';
        // _ midt i et ord (snake_case) er ikke utheving.
        const iOrd = c === '_' && /[\p{L}\p{N}]/u.test(for_);
        const start = i + merke.length;
        const j = iOrd ? -1 : s.indexOf(merke, start);
        if (j > start && !/\s/.test(s[start]) && !/\s/.test(s[j - 1])) {
          tom();
          ut.push({
            type: dobbel ? 'fet' : 'kursiv',
            deler: inlineDeler(s.slice(start, j), dybde + 1),
          });
          i = j + merke.length;
          continue;
        }
        buf += merke;
        i += merke.length;
        continue;
      }
      buf += c;
      i += 1;
    }
    tom();
    return ut;
  }

  /** Bare teksten i en linje markdown (uten merkene), til overskrifter, ankre og skjermleser. */
  function renTekst(tekst) {
    const flat = (deler) => deler.map((d) => (d.deler ? flat(d.deler) : (d.tekst ?? ''))).join('');
    return flat(inlineDeler(tekst));
  }

  const PUNKT = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABELL_SKILLE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  /** Cellene i en tabellrad (`|` med skråstrek foran er en del av teksten). */
  function tabellCeller(linje) {
    let s = linje.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const ut = [];
    let buf = '';
    let kode = false;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') {
        buf += '|';
        i += 1;
      } else if (c === '`') {
        kode = !kode;
        buf += c;
      } else if (c === '|' && !kode) {
        ut.push(buf.trim());
        buf = '';
      } else buf += c;
    }
    ut.push(buf.trim());
    return ut;
  }

  /**
   * Deler et markdown-dokument i blokker som lesevisningen tegner med textContent (aldri innerHTML): overskrift,
   * avsnitt, liste (med nivå per punkt), kode, sitat, tabell og skillelinje. Toppteksten mellom `---`-linjer først
   * i fila vises som kode. HTML i dokumentet blir stående som tekst.
   * @returns {object[]}
   */
  function markdownBlokker(tekst) {
    const linjer = String(tekst ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n');
    const ut = [];
    let avsnitt = [];
    const slutt = () => {
      if (avsnitt.length) ut.push({ type: 'avsnitt', tekst: avsnitt.join(' ') });
      avsnitt = [];
    };
    let i = 0;
    if (linjer[0] === '---') {
      const j = linjer.indexOf('---', 1);
      if (j > 0 && j < 60) {
        ut.push({ type: 'kode', sprak: 'yaml', tekst: linjer.slice(1, j).join('\n') });
        i = j + 1;
      }
    }
    while (i < linjer.length) {
      const l = linjer[i];
      const gjerde = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)/.exec(l);
      if (gjerde) {
        slutt();
        const merke = gjerde[1];
        const kode = [];
        i += 1;
        while (i < linjer.length && !linjer[i].trim().startsWith(merke)) {
          kode.push(linjer[i]);
          i += 1;
        }
        i += 1;
        ut.push({ type: 'kode', sprak: gjerde[2] || null, tekst: kode.join('\n') });
        continue;
      }
      if (!l.trim()) {
        slutt();
        i += 1;
        continue;
      }
      const h = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(l);
      if (h) {
        slutt();
        ut.push({ type: 'overskrift', niva: h[1].length, tekst: h[2] });
        i += 1;
        continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) {
        slutt();
        ut.push({ type: 'linje' });
        i += 1;
        continue;
      }
      if (
        l.includes('|') &&
        i + 1 < linjer.length &&
        TABELL_SKILLE.test(linjer[i + 1]) &&
        linjer[i + 1].includes('-')
      ) {
        slutt();
        const hode = tabellCeller(l);
        const rader = [];
        i += 2;
        while (i < linjer.length && linjer[i].trim() && linjer[i].includes('|')) {
          rader.push(tabellCeller(linjer[i]));
          i += 1;
        }
        ut.push({ type: 'tabell', hode, rader });
        continue;
      }
      if (/^\s{0,3}>/.test(l)) {
        slutt();
        const s = [];
        while (i < linjer.length && /^\s{0,3}>/.test(linjer[i])) {
          s.push(linjer[i].replace(/^\s{0,3}>\s?/, ''));
          i += 1;
        }
        ut.push({ type: 'sitat', tekst: s.filter((x) => x.trim()).join(' ') });
        continue;
      }
      const pkt = PUNKT.exec(l);
      if (pkt) {
        slutt();
        const punkter = [];
        while (i < linjer.length) {
          const m = PUNKT.exec(linjer[i]);
          if (m) {
            const innrykk = m[1].replace(/\t/g, '    ').length;
            punkter.push({
              niva: Math.min(4, Math.floor(innrykk / 2)),
              ordnet: /\d/.test(m[2]),
              nr: /\d/.test(m[2]) ? parseInt(m[2], 10) : null,
              tekst: m[3],
            });
            i += 1;
          } else if (linjer[i].trim() && /^\s/.test(linjer[i]) && punkter.length) {
            punkter[punkter.length - 1].tekst += ` ${linjer[i].trim()}`;
            i += 1;
          } else break;
        }
        ut.push({ type: 'liste', punkter });
        continue;
      }
      avsnitt.push(l.trim());
      i += 1;
    }
    slutt();
    return ut;
  }

  /** Ankeret slik GitHub lager det fra en overskrift (små bokstaver, bindestrek for mellomrom). */
  function slug(tekst) {
    return String(tekst ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s/g, '-');
  }

  /**
   * Overskriften et anker peker til (som koPlan.ankerTekst: «§ 3.4» treffer «### 3.4 Modenhet …»; ellers en
   * overskrift som inneholder ankeret, eller med samme slug som en `#lenke`). -1 når ingen treffer.
   */
  function ankerIndeks(blokker, anker) {
    const a = String(anker ?? '').trim();
    if (!a) return -1;
    const nr = a.replace(/^§\s*/, '');
    const lav = a.toLowerCase();
    const sa = slug(a);
    return (blokker ?? []).findIndex((b) => {
      if (b?.type !== 'overskrift') return false;
      const t = renTekst(b.tekst).trim();
      return (
        t.includes(a) ||
        t.toLowerCase().includes(lav) ||
        t === nr ||
        t.startsWith(`${nr} `) ||
        t.startsWith(`${nr}. `) ||
        slug(t) === sa
      );
    });
  }

  /**
   * Gruppene i Uregistrert-boksen: én per dokumentmappe (den lengste først, så en undermappe vinner over mappa
   * den ligger i), pluss «Annet». Første prefiks som passer vinner.
   * @returns {{ id: string, prefiks: string, tekst: string }[]}
   */
  function uregistrertGrupperDef(mapper = lesMapper) {
    return [
      ...[...mapper]
        .sort((a, b) => b.length - a.length || a.localeCompare(b))
        .map((m) => ({ id: m.replace(/\/$/, ''), prefiks: m, tekst: m })),
      { id: 'annet', prefiks: '', tekst: 'Annet' },
    ];
  }

  /**
   * De uregistrerte dokumentene (fra `plan sjekk`) gruppert etter mappe, med antall. Tomme grupper tas ikke med.
   * @returns {Array<{ id: string, tekst: string, stier: string[] }>}
   */
  function uregistrertGrupper(stier, mapper = lesMapper) {
    const def = uregistrertGrupperDef(mapper);
    const ut = def.map((g) => ({ id: g.id, tekst: g.tekst, stier: [] }));
    for (const s of [...new Set((stier ?? []).filter((x) => typeof x === 'string'))].sort()) {
      const i = def.findIndex((g) => s.startsWith(g.prefiks));
      ut[i].stier.push(s);
    }
    return ut.filter((g) => g.stier.length);
  }

  /**
   * Forslag til id og tittel for en ny planpost fra filnavnet («docs/eksport-utkast-2026-10-10.md» gir
   * «Eksport utkast» og PL-EKSPORT-UTKAST-1). Dato og andre haler beholdes i tittelen, ikke i id-en utover de fire
   * første ordene. Id-en er ledig (ikke i `brukte`).
   */
  function postForslag(sti, brukte) {
    const opptatt = brukte instanceof Set ? brukte : new Set(brukte ?? []);
    const fil = String(sti ?? '')
      .split('/')
      .pop()
      .replace(/\.md$/i, '')
      .replace(/[-_]?\d{4}-\d\d-\d\d$/, '');
    const ord = fil.split(/[-_\s.]+/).filter(Boolean);
    const tittel = ord.length
      ? `${ord[0][0].toUpperCase()}${ord[0].slice(1)} ${ord.slice(1).join(' ')}`.trim()
      : 'Ny plan';
    const idDel =
      ord
        .slice(0, 4)
        .join('-')
        .toUpperCase()
        .replace(/[^A-Z0-9ÆØÅ-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'PLAN';
    let n = 1;
    while (opptatt.has(`PL-${idDel}-${n}`)) n += 1;
    return { id: `PL-${idDel}-${n}`, tittel: tittel.slice(0, TITTEL_MAKS) };
  }

  /**
   * Den nye planposten fra skjemaet i Uregistrert-boksen («Ny post»). Eieren lager den (`--satt-av eier`), så
   * prioriteten er eierens valg; modenheten er alltid idé, og dokumentet er eneste kilde.
   * @param {{ id?: string, tittel?: string, prosjekt?: string, prioritet?: string, kategori?: string,
   *   grunn?: string }} skjema
   * @returns {{ post: object|null, feil: string[] }}
   */
  function nyPostFraSkjema(skjema, sti) {
    const feil = [];
    const s = skjema && typeof skjema === 'object' ? skjema : {};
    const id = String(s.id ?? '').trim();
    const tittel = String(s.tittel ?? '').trim();
    const prosjekt = String(s.prosjekt ?? '').trim();
    const prioritet = String(s.prioritet ?? 'eier');
    const grunn = String(s.grunn ?? '').trim();
    if (!NY_POST_ID.test(id))
      feil.push('id må se ut som PL-NAVN-1 (store bokstaver, tall og bindestrek)');
    if (!tittel) feil.push('tittel mangler');
    else if (tittel.length > TITTEL_MAKS) feil.push(`tittelen er over ${TITTEL_MAKS} tegn`);
    if (harKontrolltegn(tittel)) feil.push('tittelen har kontrolltegn');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(prosjekt)) feil.push('velg et prosjekt');
    if (!['naa', 'eier', 'senere'].includes(prioritet))
      feil.push('prioritet må være Nå, Eier eller Senere');
    const kategori = prioritet === 'naa' ? String(s.kategori ?? '') : '';
    if (prioritet === 'naa' && !Object.hasOwn(KATEGORI, kategori))
      feil.push('Nå trenger en kategori (sikkerhet, før prod eller viktig)');
    if (grunn.length > GRUNN_MAKS) feil.push(`grunnen er over ${GRUNN_MAKS} tegn`);
    if (harKontrolltegn(grunn)) feil.push('grunnen har kontrolltegn');
    const sf = lesStiFeil(sti);
    if (sf) feil.push(`kilden: ${sf}`);
    if (feil.length) return { post: null, feil };
    return {
      post: {
        id,
        tittel,
        prosjekt,
        prioritet,
        ...(prioritet === 'naa' ? { naa_kategori: [kategori] } : {}),
        ...(grunn ? { prioritet_grunn: grunn } : {}),
        modenhet: 'ide',
        kilder: [{ sti }],
      },
      feil: [],
    };
  }

  /** Felles hale for skrivekallene fra boksen: eierens valg, tavla som avsender, forhåndsvisning eller versjon. */
  function skriveHale({ torr, forvent } = {}) {
    return [
      '--json',
      '--satt-av',
      'eier',
      '--av',
      'tavla',
      ...(torr ? ['--torr'] : []),
      ...(!torr && forvent ? ['--forvent-endret', String(forvent)] : []),
    ];
  }

  /** Argumentene til `ko.mjs plan ny` (posten ligger i en midlertidig fil). */
  function nyPostArgs(fil, valg = {}) {
    return ['plan', 'ny', '--fil', String(fil), ...skriveHale(valg)];
  }

  /**
   * Kildelista etter «Legg til som kilde»: de gamle kildene uendret, og dokumentet sist (med anker når det er gitt).
   * `post` er posten slik den står i planer.json.
   * @returns {{ kilder: object[]|null, feil: string[] }}
   */
  function kildeTillegg(post, sti, anker) {
    const feil = [];
    if (!post || typeof post !== 'object') return { kilder: null, feil: ['ukjent planpost'] };
    const sf = lesStiFeil(sti);
    if (sf) feil.push(`kilden: ${sf}`);
    const a = String(anker ?? '').trim();
    if (a.length > ANKER_MAKS) feil.push(`ankeret er over ${ANKER_MAKS} tegn`);
    if (harKontrolltegn(a)) feil.push('ankeret har kontrolltegn');
    const gamle = Array.isArray(post.kilder) ? post.kilder : [];
    if (gamle.some((k) => k?.sti === sti && String(k?.anker ?? '') === a))
      feil.push(`${post.id ?? 'posten'} har alt denne kilden`);
    if (feil.length) return { kilder: null, feil };
    return {
      kilder: [...gamle.map((k) => ({ ...k })), { sti, ...(a ? { anker: a } : {}) }],
      feil: [],
    };
  }

  /** Argumentene til `ko.mjs plan endre <id> --sett '{"kilder":[…]}'` (hele lista, de gamle kildene med). */
  function kildeArgs(id, kilder, valg = {}) {
    return ['plan', 'endre', String(id), '--sett', JSON.stringify({ kilder }), ...skriveHale(valg)];
  }

  // ---- flatene Juridisk, Beslutninger og Lansering ---------------------------------
  //
  // Samme tre-rute-mønster som planpostene og dokumentene: fasetter med antall til venstre, en foldbar liste delt i
  // grupper i midten og detaljpanelet til høyre. Juridisk har fasettene status, blokkerer og modul; Beslutninger har
  // status, type, frist, hvor mye som blokkeres, og modul. Lukkede punkter og besvarte spørsmål skjules til
  // statusfilteret tar dem med (som Dropp for postene). Lansering er én oversikt uten egne filtre.

  const JB_FLATER = ['jur', 'beslutn', 'lansering'];
  /** Status på et juridisk punkt med symbol (fargen er aldri eneste bærer). Rekkefølgen er arbeidsrekkefølgen. */
  const JUR_STATUS = {
    apen: { tekst: 'Åpen', symbol: '○' },
    'ki-vurdert': { tekst: 'KI-vurdert', symbol: '◐' },
    'til-jurist': { tekst: 'Til jurist', symbol: '§' },
    avklart: { tekst: 'Avklart', symbol: '✓' },
    'ikke-relevant': { tekst: 'Ikke relevant', symbol: '·' },
  };
  /** Hva et punkt blokkerer, det alvorligste først. */
  const JUR_BLOKK = {
    prod: { tekst: 'Prod', symbol: '■' },
    pakking: { tekst: 'Pakking', symbol: '▲' },
    ingenting: { tekst: 'Ingenting', symbol: '·' },
  };
  const DPIA_TEKST = {
    trengs: 'DPIA trengs',
    finnes: 'DPIA finnes',
    'ikke-relevant': 'DPIA ikke relevant',
    uvurdert: 'DPIA ikke vurdert',
  };
  const BESL_STATUS = { apen: 'Åpen', besvart: 'Besvart' };
  /** Typene i køen (koLogikk.SPORSMAL_TYPER); eier-oppgave er en eierhandling. */
  const BESL_TYPE = {
    sporsmal: 'Spørsmål',
    betingelse: 'Betingelse',
    jurist: 'Jurist',
    'eier-oppgave': 'Eierhandling',
  };
  const BESL_MENGDE = {
    mange: 'To eller flere planposter',
    en: 'Én planpost',
    oppgaver: 'Bare køoppgaver',
    ingen: 'Ingenting',
  };
  /** Så mange åpne beslutninger står i gruppen «Svar på dette først». */
  const BESL_FORST = 5;
  const JUR_PUNKT = /^[A-Za-zÆØÅæøå][A-Za-z0-9ÆØÅæøå._-]{0,39}$/;

  function beslMengde(x) {
    const n = (x.blokkerte_poster ?? []).length;
    if (n >= 2) return 'mange';
    if (n === 1) return 'en';
    return (x.oppgaver ?? []).length ? 'oppgaver' : 'ingen';
  }

  const JUR_FASETTER = [
    { id: 'status', tittel: 'Status', param: 'jst', verdier: JUR_STATUS, av: (x) => [x.status] },
    {
      id: 'blokk',
      tittel: 'Blokkerer',
      param: 'jbl',
      verdier: JUR_BLOKK,
      av: (x) => [x.blokkerer],
    },
    {
      id: 'modul',
      tittel: 'Modul',
      param: 'jmod',
      verdier: null,
      av: (x) => [x.modul ?? UTEN_MODUL],
    },
  ];
  const BESL_FASETTER = [
    {
      id: 'status',
      tittel: 'Status',
      param: 'bst',
      verdier: BESL_STATUS,
      av: (x) => [x.avklart ? 'besvart' : 'apen'],
    },
    { id: 'type', tittel: 'Type', param: 'bty', verdier: BESL_TYPE, av: (x) => [x.type] },
    {
      id: 'frist',
      tittel: 'Frist',
      param: 'bfr',
      verdier: FRIST,
      av: (x, naa) => [fristBand(x.frist, naa)],
    },
    {
      id: 'blokk',
      tittel: 'Blokkerer',
      param: 'bbl',
      verdier: BESL_MENGDE,
      av: (x) => [beslMengde(x)],
    },
    {
      id: 'modul',
      tittel: 'Modul',
      param: 'bmod',
      verdier: null,
      av: (x) => (x.moduler?.length ? x.moduler : [UTEN_MODUL]),
    },
  ];

  const jbFasetter = (flate) => (flate === 'jur' ? JUR_FASETTER : BESL_FASETTER);

  /** Tomme filtre for flaten (én liste per fasett). */
  function tomtJbFilter(flate) {
    const f = {};
    for (const x of jbFasetter(flate)) f[x.id] = [];
    return f;
  }

  /** Filtrene, søket og valget for Juridisk og Beslutninger fra nettadressen (ugyldige verdier kastes stille). */
  function jbLesUrl(q) {
    const les = (flate) => {
      const f = tomtJbFilter(flate);
      for (const x of jbFasetter(flate)) {
        const ut = [];
        for (const del of (q.get(x.param) ?? '').split(',')) {
          const v = del.trim();
          if (lovligVerdi(x, v) && !ut.includes(v)) ut.push(v);
        }
        f[x.id] = ut.slice(0, 40);
      }
      return f;
    };
    const jur = q.get('jur');
    const sp = q.get('sp');
    return {
      jfilter: les('jur'),
      jsok: String(q.get('jq') ?? '').slice(0, 120),
      jur: jur && JUR_PUNKT.test(jur) ? jur : null,
      bfilter: les('beslutn'),
      bsok: String(q.get('bq') ?? '').slice(0, 120),
      sp:
        typeof sp === 'string' && sp && sp.length <= 120 && !/[\u0000-\u001f\u007f]/.test(sp)
          ? sp
          : null,
    };
  }

  /** Skriver filtrene, søket og valget for Juridisk og Beslutninger inn i søkedelen. */
  function jbSkrivUrl(q, t) {
    for (const [flate, nokkel] of [
      ['jur', 'jfilter'],
      ['beslutn', 'bfilter'],
    ])
      for (const x of jbFasetter(flate)) {
        const v = t?.[nokkel]?.[x.id] ?? [];
        if (v.length) q.set(x.param, v.join(','));
      }
    if (t?.jsok) q.set('jq', t.jsok);
    if (t?.jur) q.set('jur', t.jur);
    if (t?.bsok) q.set('bq', t.bsok);
    if (t?.sp) q.set('sp', t.sp);
  }

  function jbSokTreff(flate, x, sok) {
    const s = String(sok ?? '')
      .trim()
      .toLowerCase();
    if (!s) return true;
    const felt =
      flate === 'jur'
        ? [
            x.id,
            x.sporsmal,
            x.post,
            x.post_tittel,
            x.prosjekt,
            x.ki_vurdering,
            ...(x.berorer ?? []),
          ]
        : [
            x.id,
            x.tekst,
            x.anbefaling,
            x.kilde,
            x.svar,
            ...(x.poster ?? []),
            ...(x.prosjekter ?? []),
          ];
    return felt.filter(Boolean).join('\n').toLowerCase().includes(s);
  }

  /** Skjules elementet som standard (lukket punkt, besvart spørsmål) med disse filtrene? */
  function jbSkjult(flate, x, filter, utenom) {
    if (utenom === 'status') return false;
    const st = filter?.status ?? [];
    if (flate === 'jur') return !JUR_APEN.has(x.status) && !st.includes(x.status);
    return x.avklart === true && !st.includes('besvart');
  }

  /** Elementene på flaten som passer filtrene og søket. `utenom` er en fasett som ikke telles med. */
  function jbFiltrer(
    flate,
    liste,
    filter = {},
    sok = '',
    { naa = new Date(), utenom = null } = {},
  ) {
    return (liste ?? []).filter((x) => {
      if (jbSkjult(flate, x, filter, utenom)) return false;
      for (const f of jbFasetter(flate)) {
        if (f.id === utenom) continue;
        const valgt = filter?.[f.id];
        if (valgt?.length && !f.av(x, naa).some((v) => valgt.includes(v))) return false;
      }
      return jbSokTreff(flate, x, sok);
    });
  }

  /** Fasettene for flaten med antall treff per verdi (samme regel som fasettTall). */
  function jbFasettTall(flate, liste, filter, sok, { naa = new Date(), moduler = [] } = {}) {
    return jbFasetter(flate).map((f) => {
      const grunnlag = jbFiltrer(flate, liste, filter, sok, { naa, utenom: f.id });
      const tall = new Map();
      for (const x of grunnlag)
        for (const v of new Set(f.av(x, naa))) tall.set(v, (tall.get(v) ?? 0) + 1);
      const navn =
        f.id === 'modul'
          ? new Map([...moduler.map((m) => [m.oid, m.tittel]), [UTEN_MODUL, 'Uten modul']])
          : new Map(Object.entries(f.verdier).map(([v, t]) => [v, verdiTekst(t)]));
      const valgt = filter?.[f.id] ?? [];
      const valg = [...new Set([...navn.keys(), ...tall.keys(), ...valgt])]
        .filter((v) => (tall.get(v) ?? 0) > 0 || valgt.includes(v))
        .map((v) => ({
          verdi: v,
          tekst: navn.get(v) ?? v,
          symbol: f.verdier?.[v]?.symbol ?? null,
          antall: tall.get(v) ?? 0,
          valgt: valgt.includes(v),
        }));
      return { id: f.id, tittel: f.tittel, valg };
    });
  }

  /** Brikkene over listen: ett per aktivt filter. */
  function jbBrikker(flate, filter, { moduler = [] } = {}) {
    const modNavn = new Map(moduler.map((m) => [m.oid, m.tittel]));
    const ut = [];
    for (const f of jbFasetter(flate))
      for (const v of filter?.[f.id] ?? []) {
        const tekst =
          f.id === 'modul'
            ? v === UTEN_MODUL
              ? 'Uten modul'
              : (modNavn.get(v) ?? v)
            : verdiTekst(f.verdier[v] ?? v);
        ut.push({ fasett: f.id, verdi: v, tekst: `${f.tittel}: ${tekst}` });
      }
    return ut;
  }

  function antallJbFiltre(flate, filter) {
    return jbFasetter(flate).reduce((n, f) => n + (filter?.[f.id]?.length ?? 0), 0);
  }

  /** Alle elementene på flaten (Beslutninger: åpne i sorteringen fra koPlan, så de besvarte). */
  function jbListe(flate, data) {
    if (flate === 'jur') return data?.jur_punkter ?? [];
    if (flate === 'beslutn')
      return [...(data?.beslutninger?.apne ?? []), ...(data?.beslutninger?.besvarte ?? [])];
    return [];
  }

  /**
   * Gruppene i midten. Juridisk: én gruppe per status i arbeidsrekkefølgen. Beslutninger: «Svar på dette først» (de
   * BESL_FORST øverste åpne), «Andre åpne» og «Besvart» (historikken, nyeste først).
   * @returns {{ id: string, tittel: string, elementer: object[] }[]}
   */
  function jbGrupper(flate, treff) {
    if (flate === 'jur')
      return Object.keys(JUR_STATUS)
        .map((s) => ({
          id: s,
          tittel: JUR_STATUS[s].tekst,
          symbol: JUR_STATUS[s].symbol,
          elementer: (treff ?? []).filter((x) => x.status === s),
        }))
        .filter((g) => g.elementer.length);
    const apne = (treff ?? []).filter((x) => !x.avklart);
    const ut = [
      { id: 'forst', tittel: 'Svar på dette først', elementer: apne.slice(0, BESL_FORST) },
      { id: 'apne', tittel: 'Andre åpne', elementer: apne.slice(BESL_FORST) },
      { id: 'besvart', tittel: 'Besvart', elementer: (treff ?? []).filter((x) => x.avklart) },
    ];
    return ut.filter((g) => g.elementer.length);
  }

  /** Modul- og prosjekttitlene over et punkt eller spørsmål (bare titler, til kopier-linja). */
  function jbOver(modul, prosjekt, data) {
    const m = (data?.moduler ?? []).find((x) => x.oid === modul);
    const p = prosjekt ? data?.prosjekter?.[prosjekt] : null;
    return [m?.tittel ?? null, p ? (p.kort ?? prosjekt) : null];
  }

  /** Kopier-linja for et juridisk punkt: /planer jur J-X (Modul › Prosjekt › PL-X). Instruks: */
  function jurLinje(x, data) {
    return kopierLinje('jur', x.id, [...jbOver(x.modul, x.prosjekt, data), x.post]);
  }

  /** Kopier-linja for et eierspørsmål: /planer eier SP-X (Modul › Prosjekt › PL-X). Instruks: */
  function eierLinje(x, data) {
    const post = (x.poster ?? [])[0] ?? null;
    const pd = post ? (data?.poster ?? []).find((p) => p.id === post) : null;
    return kopierLinje('eier', x.id, [
      ...jbOver(
        pd?.modul ?? x.moduler?.[0] ?? null,
        pd?.prosjekt ?? x.prosjekter?.[0] ?? null,
        data,
      ),
      post,
    ]);
  }

  /** Stien for flatene: Planer › Juridisk › Status › punkt, Planer › Beslutninger › id, Planer › Lansering. */
  function jbBrodsmuler(t, data) {
    const flate = t.flate;
    const navn = FLATER.find((x) => x.id === flate)?.tekst ?? flate;
    const ut = [
      {
        niva: 'rom',
        noekkel: null,
        tekst: 'Planer',
        kopier: null,
        filter: null,
        post: null,
        tilstand: { flate: 'poster' },
      },
      {
        niva: 'flate',
        noekkel: flate,
        tekst: navn,
        kopier: null,
        filter: null,
        post: null,
        tilstand:
          flate === 'jur'
            ? { flate, jfilter: tomtJbFilter('jur'), jsok: '', jur: null }
            : flate === 'beslutn'
              ? { flate, bfilter: tomtJbFilter('beslutn'), bsok: '', sp: null }
              : { flate },
      },
    ];
    if (flate === 'jur') {
      const x = t.jur ? (data?.jur_punkter ?? []).find((p) => p.id === t.jur) : null;
      const st = x ? x.status : t.jfilter?.status?.length === 1 ? t.jfilter.status[0] : null;
      if (st && JUR_STATUS[st]) {
        const f = tomtJbFilter('jur');
        f.status = [st];
        ut.push({
          niva: 'status',
          noekkel: st,
          tekst: JUR_STATUS[st].tekst,
          kopier: null,
          filter: null,
          post: null,
          tilstand: { flate, jfilter: f, jur: null },
        });
      }
      if (x)
        ut.push({
          niva: 'punkt',
          noekkel: x.id,
          tekst: x.id,
          kopier: jurLinje(x, data),
          filter: null,
          post: null,
          tilstand: { flate, jur: x.id },
        });
    }
    if (flate === 'beslutn' && t.sp) {
      const x = jbListe('beslutn', data).find((s) => s.id === t.sp);
      if (x)
        ut.push({
          niva: 'sporsmal',
          noekkel: x.id,
          tekst: x.id,
          kopier: eierLinje(x, data),
          filter: null,
          post: null,
          tilstand: { flate, sp: x.id },
        });
    }
    return ut;
  }

  /**
   * Dataene til de tre flatene (serveren kaller dette fra planerData): de juridiske punktene, personvern per modul,
   * eierbeslutningene og lanseringsoversikten, regnet av de rene funksjonene i koPlan.js.
   */
  function jbData(reg, ko, { naa = new Date(), P } = {}) {
    if (!P?.juridiskePunkter) return {};
    return {
      jur_punkter: P.juridiskePunkter(reg, ko, { naa }),
      personvern: P.personvernPerModul(reg, ko),
      beslutninger: P.eierBeslutninger(reg, ko, { naa }),
      lansering: P.lanseringsoversikt(reg, ko, { naa }),
    };
  }

  /** Antallet flatevalget viser for hver flate (Juridisk: åpne punkter; Beslutninger: åpne; Lansering: igjen). */
  function flateAntall(d) {
    return {
      // oversikten viser hvor mange som venter på deg (eierspørsmål og juridiske punkter).
      oversikt: venterPaaDeg(d).totalt,
      poster: (d?.poster ?? []).length,
      dok: (d?.dokumenter ?? []).length,
      jur: (d?.jur_punkter ?? []).filter((x) => JUR_APEN.has(x.status)).length,
      beslutn: (d?.beslutninger?.apne ?? []).length,
      lansering: d?.lansering?.gjenstaar ?? 0,
    };
  }

  /** Kroppen til POST /api/handling når eieren svarer på et spørsmål (samme rute som «Venter på deg»). */
  function avklarKropp(sp, svar, { bekreft = false } = {}) {
    const s = String(svar ?? '').trim();
    if (!s) return { feil: 'Skriv et svar først.' };
    if (s.length > 4000) return { feil: 'Svaret er over 4000 tegn.' };
    return {
      kropp: { type: 'avklar', sp: String(sp), svar: s, ...(bekreft ? { bekreft: true } : {}) },
    };
  }

  // ---- Oversiktssiden, tastatur, Ctrl+K, flervalg, endring i raden og «Arbeider nå» ---------------------
  // Reglene her er rene; planer/oversikt.js og planer/arbeid.js tegner, og ko-tavle.mjs
  // kjører kallene (alltid via ko.mjs, med samme lås, --forvent-endret og endringslogg som køen).

  /** Modenhetene eieren setter selv (som koPlan.MODENHET_MANUELL); i-ko, delvis, bygget og verifisert regnes ut. */
  const MODENHET_MANUELL = ['ide', 'utredet', 'planlagt', 'klar'];
  /** Stolpen for modenhet på modulkortet: fire grupper, hver med tekst og tall (farge er aldri eneste bærer). */
  const MODENHET_GRUPPER = [
    { id: 'tidlig', tekst: 'Idé og utredet', av: ['ide', 'utredet'] },
    { id: 'planlagt', tekst: 'Planlagt og klar', av: ['planlagt', 'klar'] },
    { id: 'arbeid', tekst: 'I kø og delvis bygget', av: ['i-ko', 'delvis'] },
    { id: 'bygget', tekst: 'Bygget og verifisert', av: ['bygget', 'verifisert'] },
  ];
  /** Tastene for prioritet: 1 Nå, 2 Senere, 3 Eier, 4 Dropp. */
  const PRIORITET_TAST = { 1: 'naa', 2: 'senere', 3: 'eier', 4: 'dropp' };
  /** «Venter på deg» viser de fem som blokkerer mest. */
  const VENTER_MAKS = 5;
  /** Et juridisk punkt med frist innen så mange dager regnes som hastende (som BESLUTNING_HASTER_DAGER). */
  const JUR_HASTER_DAGER = 14;
  /** Hvor mange endringer og nye poster «Nylig» viser. */
  const NYLIG_MAKS = 8;
  /** Høyst så mange poster i ett flervalg. */
  const MASSE_MAKS = 100;
  /** Kommandolinja (Ctrl+K): høyst så mange treff, og så mange nylig brukte huskes. */
  const PALETT_MAKS = 30;
  const PALETT_NYLIGE = 8;
  /** Handlingene i flervalget: prioritet, prosjekt, modenhet og sammenslåing. Kopiering skjer i nettleseren. */
  const MASSE_HANDLINGER = ['prioritet', 'prosjekt', 'modenhet', 'slaa-sammen'];
  /** Handlingene kommandolinja kan kjøre (i tillegg til å hoppe til modul, prosjekt og post). */
  const PALETT_HANDLINGER = [
    { id: 'kopier-valgte', tekst: 'Kopier startlinje for alle valgte' },
    { id: 'klargjor', tekst: 'Klargjør for kø (valgt post)' },
    { id: 'oversikt', tekst: 'Gå til oversikten' },
    { id: 'liste', tekst: 'Vis listen over planposter' },
    { id: 'kart', tekst: 'Vis prioritetskartet' },
    { id: 'nullstill', tekst: 'Nullstill filtrene' },
    { id: 'tom-valg', tekst: 'Tøm flervalget' },
  ];

  /**
   * Modulkortene på oversikten: ett per modul (i registerets rekkefølge, også moduler uten poster), pluss
   * «Uten modul» når noen poster mangler modul. Droppede poster telles bare i `droppet`; resten i antallet, stolpene,
   * byggegraden og de tre varseltallene (åpne eierspørsmål og åpne juridiske punkter telles unikt per modul).
   */
  function modulKort(d) {
    const per = new Map();
    for (const m of d?.moduler ?? []) per.set(m.oid, []);
    for (const p of d?.poster ?? []) {
      const m = p.modul ?? UTEN_MODUL;
      if (!per.has(m)) per.set(m, []);
      per.get(m).push(p);
    }
    const titler = new Map((d?.moduler ?? []).map((m) => [m.oid, m.tittel]));
    const ut = [];
    for (const [oid, alle] of per) {
      const aktive = alle.filter((p) => p.prioritet !== 'dropp');
      const pri = (k) => aktive.filter((p) => p.prioritet === k).length;
      const eierspm = new Set();
      for (const p of aktive)
        for (const s of p.eierspm ?? []) if (s && !s.avklart) eierspm.add(s.id);
      const f = fremdrift(aktive);
      ut.push({
        oid,
        tittel: oid === UTEN_MODUL ? 'Uten modul' : (titler.get(oid) ?? oid),
        antall: aktive.length,
        droppet: alle.length - aktive.length,
        prioritet: ['naa', 'eier', 'senere'].map((k) => ({
          id: k,
          tekst: PRIORITET[k].tekst,
          symbol: PRIORITET[k].symbol,
          antall: pri(k),
        })),
        modenhet: MODENHET_GRUPPER.map((g) => ({
          id: g.id,
          tekst: g.tekst,
          antall: aktive.filter((p) => g.av.includes(p.modenhet)).length,
        })),
        bygget: f.bygget,
        andel: f.andel,
        eierspm: eierspm.size,
        juridisk: aktive.reduce((n, p) => n + (Number(p.jur_apne) || 0), 0),
        foreldet: aktive.filter((p) => p.foreldet).length,
        aktiv: aktive.filter((p) => p.aktiv).length,
      });
    }
    return ut;
  }

  /**
   * «Venter på deg»: de åpne eierspørsmålene (fra eierbeslutningene) og de åpne juridiske punktene, de som
   * blokkerer mest øverst. Hastende (frist innen 14 dager eller forfalt) går foran, tidligste frist først; så vekten:
   * blokkerte planposter (×10), køoppgaver som venter, og +5 for et juridisk punkt som blokkerer prod.
   * @returns {{ punkter: { type: 'eier'|'jur', id, tekst, blokkerer, oppgaver, haster, frist, post: string|null }[],
   *   totalt: number }}
   */
  function venterPaaDeg(d, { maks = VENTER_MAKS } = {}) {
    const poster = new Map((d?.poster ?? []).map((p) => [p.id, p]));
    const ut = [];
    for (const b of d?.beslutninger?.apne ?? [])
      ut.push({
        type: 'eier',
        id: String(b.id),
        tekst: b.tekst ?? String(b.id),
        blokkerer: (b.blokkerte_poster ?? []).length,
        oppgaver: (b.oppgaver ?? []).length,
        haster: b.haster === true,
        frist: b.frist ?? null,
        post: (b.poster ?? [])[0] ?? null,
        hindrer: null,
      });
    for (const j of d?.jur_punkter ?? []) {
      if (!(j.apen ?? JUR_APEN.has(j.status))) continue;
      const p = poster.get(j.post);
      if (!p || p.prioritet === 'dropp') continue;
      ut.push({
        type: 'jur',
        id: String(j.id),
        tekst: j.sporsmal || String(j.id),
        blokkerer: 1 + (p.blokkerer ?? []).length,
        oppgaver: 0,
        haster: j.frist_dager != null && j.frist_dager <= JUR_HASTER_DAGER,
        frist: j.frist ?? null,
        post: j.post,
        hindrer: j.blokkerer ?? null,
      });
    }
    const vekt = (x) => x.blokkerer * 10 + x.oppgaver + (x.hindrer === 'prod' ? 5 : 0);
    ut.sort(
      (a, b) =>
        Number(b.haster) - Number(a.haster) ||
        (a.haster ? String(a.frist ?? '9999').localeCompare(String(b.frist ?? '9999')) : 0) ||
        vekt(b) - vekt(a) ||
        a.id.localeCompare(b.id, 'nb'),
    );
    return { punkter: ut.slice(0, maks), totalt: ut.length };
  }

  /**
   * Hvor fort Nå vokser: Nå-postene som kom inn i Nå de siste `dager` dagene (ny post med prioritet naa, eller
   * en endring av prioritet til naa i endringsloggen), med sporene de trenger (estimatSpor). Endringsloggen holder
   * bare de siste 50 skrivingene, så tallet er et minimum.
   * @returns {{ poster: number, spor: number, per_uke: number, ider: string[] }}
   */
  function naaTilgang(reg, { naa = new Date(), dager = 28, estimatSpor = {} } = {}) {
    const fra = new Date(naa).getTime() - dager * 86400000;
    const inn = new Set();
    for (const h of reg?.endringslogg ?? []) {
      const t = Date.parse(h?.at);
      if (!Number.isFinite(t) || t < fra || h?.angret) continue;
      for (const e of h?.endringer ?? []) {
        if (!e?.id || (e.samling && e.samling !== 'poster')) continue;
        const tilNaa = e.felt === 'prioritet' && e.etter === 'naa' && e.for !== 'naa';
        const nyNaa = e.felt === '*' && e.for == null && e.etter?.prioritet === 'naa';
        if (tilNaa || nyNaa) inn.add(e.id);
      }
    }
    for (const p of reg?.poster ?? []) {
      const t = Date.parse(p?.opprettet);
      if (p?.prioritet === 'naa' && Number.isFinite(t) && t >= fra) inn.add(p.id);
    }
    const ider = [];
    let spor = 0;
    for (const p of reg?.poster ?? [])
      if (p.prioritet === 'naa' && inn.has(p.id)) {
        ider.push(p.id);
        spor += Number(estimatSpor[p.estimat]) || 0;
      }
    return { poster: ider.length, spor, per_uke: Math.round((spor / (dager / 7)) * 10) / 10, ider };
  }

  /** Et desimaltall med komma (norsk). */
  const komma = (x) => String(Math.round(x * 10) / 10).replace('.', ',');

  /**
   * Kapasiteten i Nå: teksten fra koPlan.kapasitet, og et varsel når Nå har fått flere spor per uke
   * enn køen gjør ferdig per uke (eller køen ikke har gjort noe ferdig, mens Nå vokser).
   * @param {{ tekst: string, per_uke: number|null }} kap koPlan.kapasitet
   * @param {{ spor: number, per_uke: number, poster: number }} tilgang naaTilgang
   */
  function kapasitetVarsel(kap, tilgang, { dager = 28 } = {}) {
    if (!kap || !tilgang || !tilgang.spor) return { varsel: false, varsel_tekst: null };
    const ut = kap.per_uke ?? 0;
    if (tilgang.per_uke <= ut) return { varsel: false, varsel_tekst: null };
    return {
      varsel: true,
      varsel_tekst:
        `Nå vokser raskere enn køen tømmes: ca. ${komma(tilgang.per_uke)} spor per uke inn i Nå de siste ` +
        `${dager} dagene (${tilgang.poster} poster), mot ${komma(ut)} ferdige køoppgaver per uke.`,
    };
  }

  /** Hva siste planøkt gjorde: de siste skrivingene i endringsloggen, nyeste først, med postene de rørte. */
  function nyligEndret(reg, { maks = NYLIG_MAKS } = {}) {
    return (reg?.endringslogg ?? [])
      .slice(-maks)
      .reverse()
      .map((h) => ({
        nr: h.nr,
        at: h.at ?? null,
        av: h.av ?? null,
        handling: h.handling ?? null,
        angret: !!h.angret,
        ider: [...new Set((h.endringer ?? []).map((e) => e?.id).filter(Boolean))].slice(0, 12),
      }));
  }

  /** Nylig registrerte poster: etter `opprettet`, nyeste først. */
  function nyligRegistrert(reg, { maks = NYLIG_MAKS } = {}) {
    return (reg?.poster ?? [])
      .filter((p) => Number.isFinite(Date.parse(p?.opprettet)))
      .sort((a, b) => Date.parse(b.opprettet) - Date.parse(a.opprettet))
      .slice(0, maks)
      .map((p) => ({ id: p.id, tittel: p.tittel ?? p.id, at: p.opprettet }));
  }

  /** «Arbeider nå»: postene med en levende markør, nyeste puls først. */
  function arbeiderNaa(d) {
    return (d?.poster ?? [])
      .filter((p) => p.aktiv)
      .map((p) => ({ id: p.id, tittel: p.tittel, at: p.aktiv.at ?? null, av: p.aktiv.av ?? null }))
      .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  }

  /**
   * Live oppdatering: postene som er nye eller har fått en nyere post i endringsloggen siden forrige data,
   * og som ikke er endret av tavla selv (de markeres «endret av økt»). Første henting gir ingen markering.
   * @returns {{ id: string, av: string|null, ny: boolean }[]}
   */
  function endredePoster(gammel, ny) {
    if (!Array.isArray(gammel?.poster) || !Array.isArray(ny?.poster)) return [];
    const forrige = new Map(gammel.poster.map((p) => [p.id, p]));
    const ut = [];
    for (const p of ny.poster) {
      const g = forrige.get(p.id);
      const h = p.historikk?.[0] ?? null;
      if (!g) ut.push({ id: p.id, av: h?.av ?? null, ny: true });
      else {
        const gh = g.historikk?.[0] ?? null;
        if (h && (!gh || Number(h.nr) > Number(gh.nr)))
          ut.push({ id: p.id, av: h.av ?? null, ny: false });
      }
    }
    return ut.filter((x) => x.av !== 'tavla');
  }

  // ---- Tastatur ----

  /**
   * Hva en tast gjør i Planer-rommet. Ctrl+K (Cmd+K) virker overalt; de andre bare utenfor skrivefelt og menyer og
   * uten Ctrl, Cmd eller Alt (så nettleserens egne snarveier virker som før).
   * @param {{ key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean }} e
   * @returns {{ type: 'palett'|'flytt'|'aapne'|'sok'|'prioritet'|'kopier'|'merk'|'avbryt', retning?: number,
   *   verdi?: string }|null}
   */
  function tastHandling(e, { skrivefelt = false, opptatt = false } = {}) {
    const k = e?.key;
    if ((e?.ctrlKey || e?.metaKey) && !e?.altKey && !e?.shiftKey && (k === 'k' || k === 'K'))
      return { type: 'palett' };
    if (opptatt || skrivefelt || e?.ctrlKey || e?.metaKey || e?.altKey) return null;
    if (k === 'j') return { type: 'flytt', retning: 1 };
    if (k === 'k') return { type: 'flytt', retning: -1 };
    if (k === 'Enter') return { type: 'aapne' };
    if (k === '/') return { type: 'sok' };
    if (Object.hasOwn(PRIORITET_TAST, k)) return { type: 'prioritet', verdi: PRIORITET_TAST[k] };
    if (k === 'c') return { type: 'kopier' };
    if (k === 'x') return { type: 'merk' };
    if (k === 'Escape') return { type: 'avbryt' };
    return null;
  }

  /** Neste eller forrige post i listen (j og k). Uten gjeldende post: første (j) eller siste (k). Stopper i endene. */
  function naboPost(ider, gjeldende, retning) {
    const l = Array.isArray(ider) ? ider : [];
    if (!l.length) return null;
    const i = l.indexOf(gjeldende);
    if (i < 0) return retning < 0 ? l[l.length - 1] : l[0];
    return l[Math.min(l.length - 1, Math.max(0, i + (retning < 0 ? -1 : 1)))];
  }

  /**
   * Hva tast 1 til 4 gjør med en post: `kall` (gruppen til /api/plan-prioriter) når prioriteten kan settes rett, ellers
   * `meny` (Nå uten kategori trenger et valg av kategori; Dropp trenger én setning som grunn). Samme prioritet og
   * kategori gir `uendret`.
   * @returns {{ uendret?: true, meny?: 'naa'|'dropp', gruppe?: { ider: string[], prioritet: string, kategori: string[] } }}
   */
  function prioritetFraTast(post, prioritet) {
    if (!post || !PRIORITETER.includes(prioritet)) return { uendret: true };
    if (prioritet === 'dropp')
      return post.prioritet === 'dropp' ? { uendret: true } : { meny: 'dropp' };
    if (prioritet === 'naa') {
      if (post.prioritet === 'naa') return { uendret: true };
      return { meny: 'naa' };
    }
    if (post.prioritet === prioritet) return { uendret: true };
    return { gruppe: { ider: [post.id], prioritet, kategori: [] } };
  }

  // ---- Kommandolinja (Ctrl+K) ----

  /**
   * Alt kommandolinja kan hoppe til: modulene, prosjektene som har poster, og postene (droppede også, merket), hver
   * med brødsmulestien, pluss handlingene. `noekkel` er stabil (til «nylig brukt»).
   * @returns {{ type: 'modul'|'prosjekt'|'post'|'handling', noekkel: string, id: string, tekst: string,
   *   sti: string, dropp?: boolean }[]}
   */
  function palettKandidater(d) {
    const ut = PALETT_HANDLINGER.map((h) => ({
      type: 'handling',
      noekkel: `handling:${h.id}`,
      id: h.id,
      tekst: h.tekst,
      sti: 'Handling',
    }));
    const modTittel = new Map((d?.moduler ?? []).map((m) => [m.oid, m.tittel]));
    for (const m of d?.moduler ?? [])
      ut.push({
        type: 'modul',
        noekkel: `modul:${m.oid}`,
        id: m.oid,
        tekst: m.tittel,
        sti: 'Planer',
      });
    const medPoster = new Set((d?.poster ?? []).map((p) => p.prosjekt).filter(Boolean));
    for (const [pid, pr] of Object.entries(d?.prosjekter ?? {})) {
      if (!medPoster.has(pid)) continue;
      ut.push({
        type: 'prosjekt',
        noekkel: `prosjekt:${pid}`,
        id: pid,
        tekst: pr?.kort ?? pid,
        sti: stiTekst([
          'Planer',
          pr?.omrade ? (modTittel.get(pr.omrade) ?? pr.omrade) : 'Uten modul',
        ]),
      });
    }
    for (const p of d?.poster ?? [])
      ut.push({
        type: 'post',
        noekkel: `post:${p.id}`,
        id: p.id,
        tekst: `${p.id} ${p.tittel ?? ''}`.trim(),
        sti: stiTekst(['Planer', ...overPost(p, d ?? {})]),
        dropp: p.prioritet === 'dropp',
      });
    return ut;
  }

  /** Hvor godt treffer kandidaten søket (lavere er bedre), eller null når et av ordene ikke finnes. */
  function palettPoeng(k, ord) {
    const id = k.id.toLowerCase();
    const tekst = k.tekst.toLowerCase();
    const alt = `${id}\n${tekst}\n${k.sti.toLowerCase()}`;
    if (!ord.every((o) => alt.includes(o))) return null;
    const hele = ord.join(' ');
    let p = 4;
    if (id === hele) p = 0;
    else if (id.startsWith(hele)) p = 1;
    else if (tekst.startsWith(hele)) p = 2;
    else if (
      ord.every((o) =>
        new RegExp(`(^|[\\s›(:-])${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(alt),
      )
    )
      p = 3;
    return p + (k.dropp ? 0.5 : 0);
  }

  /**
   * Treffene i kommandolinja. Tomt søk: de nylig brukte (som finnes ennå), så handlingene og modulene. Med søk: alle
   * ord må finnes (id, tittel eller sti); nylig brukte står øverst, så de beste treffene, så rekkefølgen i registeret.
   */
  function palettTreff(kandidater, sok, nylige = [], { maks = PALETT_MAKS } = {}) {
    const alle = Array.isArray(kandidater) ? kandidater : [];
    const perNokkel = new Map(alle.map((k) => [k.noekkel, k]));
    const nyligSett = new Set(nylige);
    const ord = String(sok ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8);
    if (!ord.length) {
      const ut = [];
      for (const n of nylige) if (perNokkel.has(n)) ut.push({ ...perNokkel.get(n), nylig: true });
      for (const k of alle)
        if ((k.type === 'handling' || k.type === 'modul') && !nyligSett.has(k.noekkel))
          ut.push({ ...k, nylig: false });
      return ut.slice(0, maks);
    }
    return alle
      .map((k, i) => ({ k, i, p: palettPoeng(k, ord) }))
      .filter((x) => x.p != null)
      .sort(
        (a, b) =>
          Number(nyligSett.has(b.k.noekkel)) - Number(nyligSett.has(a.k.noekkel)) ||
          a.p - b.p ||
          a.i - b.i,
      )
      .slice(0, maks)
      .map((x) => ({ ...x.k, nylig: nyligSett.has(x.k.noekkel) }));
  }

  /** Legger en nøkkel først i «nylig brukt» (uten dubletter, høyst PALETT_NYLIGE). Ugyldige verdier kastes. */
  function leggTilNylig(liste, noekkel, maks = PALETT_NYLIGE) {
    const ok = (x) =>
      typeof x === 'string' && x.length <= 80 && /^(modul|prosjekt|post|handling):/.test(x);
    const l = (Array.isArray(liste) ? liste : []).filter(ok);
    if (!ok(noekkel)) return l.slice(0, maks);
    return [noekkel, ...l.filter((x) => x !== noekkel)].slice(0, maks);
  }

  /** Startlinjene for flere poster («Kopier startlinje for alle valgte»), én per linje i listens rekkefølge. */
  function startlinjer(ider, d) {
    const per = new Map((d?.poster ?? []).map((p) => [p.id, p]));
    return (ider ?? [])
      .map((id) => per.get(id))
      .filter(Boolean)
      .map((p) => postLinje(p, d))
      .join('\n');
  }

  // ---- Flervalg og endring i raden ----

  /** Hale for et skrivekall fra tavla: eierens valg, tavla som avsender og JSON-svar. */
  const EIER_HALE = ['--satt-av', 'eier', '--av', 'tavla', '--json'];

  /**
   * Serverens sjekk av et flervalg (eller en endring i raden) og kallene til ko.mjs. Alt som ikke er gyldig gir feil,
   * og da kjøres ingenting.
   *   prioritet:   { prioritet, kategori?, grunn? }  → `plan prioriter <id…> <prioritet>` (som prioritetskartet)
   *   prosjekt:    { prosjekt: pid|null }            → `plan endre <id> --sett {"prosjekt":…}` per post
   *   modenhet:    { modenhet: ide|utredet|planlagt|klar } → `plan endre <id> --sett {"modenhet":…}` per post
   *   slaa-sammen: { til }  (en av de valgte)         → `plan slaa-sammen <til> <de andre…>`
   * @returns {{ feil: string[], kall: string[][] }}
   */
  function planMasseKall(b) {
    const nei = (f) => ({ feil: [f], kall: [] });
    if (!b || typeof b !== 'object') return nei('ugyldig kropp');
    if (!MASSE_HANDLINGER.includes(b.handling))
      return nei(`ukjent handling ${String(b.handling).slice(0, 30)}`);
    const ider = Array.isArray(b.ider) ? b.ider.map(String) : [];
    if (!ider.length) return nei('ingen poster valgt');
    if (ider.length > MASSE_MAKS) return nei(`for mange poster (høyst ${MASSE_MAKS})`);
    if (ider.some((id) => !POST_ID.test(id)) || new Set(ider).size !== ider.length)
      return nei('ugyldige eller doble post-id-er');
    if (b.handling === 'prioritet') {
      const kat = b.kategori == null || b.kategori === '' ? [] : [].concat(b.kategori).map(String);
      return prioriterKall([{ ider, prioritet: b.prioritet, kategori: kat, grunn: b.grunn }]);
    }
    if (b.handling === 'prosjekt') {
      const pid = b.prosjekt == null || b.prosjekt === '' ? null : String(b.prosjekt);
      if (pid != null && !NOKKEL.test(pid)) return nei('ugyldig prosjekt');
      return {
        feil: [],
        kall: ider.map((id) => [
          'plan',
          'endre',
          id,
          '--sett',
          JSON.stringify({ prosjekt: pid }),
          ...EIER_HALE,
        ]),
      };
    }
    if (b.handling === 'modenhet') {
      if (!MODENHET_MANUELL.includes(b.modenhet))
        return nei(
          'modenheten kan bare settes til idé, utredet, planlagt eller klar (resten regnes ut)',
        );
      return {
        feil: [],
        kall: ider.map((id) => [
          'plan',
          'endre',
          id,
          '--sett',
          JSON.stringify({ modenhet: b.modenhet }),
          ...EIER_HALE,
        ]),
      };
    }
    // slaa-sammen
    const til = String(b.til ?? '');
    if (!ider.includes(til))
      return nei('velg hvilken av de valgte postene de andre slås sammen inn i');
    const fra = ider.filter((id) => id !== til);
    if (!fra.length) return nei('sammenslåing trenger minst to poster');
    return { feil: [], kall: [['plan', 'slaa-sammen', til, ...fra, '--av', 'tavla', '--json']] };
  }

  /**
   * Angre et lagret flervalg: endringsloggnumrene (fra svaret på lagringen) angres nyeste først med `plan angre --nr`,
   * som bare angrer når nummeret fortsatt er den siste endringen (en økt som har skrevet imens, stopper angringen).
   * @returns {{ feil: string[], kall: string[][] }}
   */
  function angreKall(nr) {
    const l = Array.isArray(nr) ? nr : [];
    if (!l.length || l.length > MASSE_MAKS) return { feil: ['ingen endringer å angre'], kall: [] };
    if (l.some((n) => !Number.isInteger(n) || n < 1))
      return { feil: ['ugyldig endringsnummer'], kall: [] };
    return {
      feil: [],
      kall: [...new Set(l)]
        .sort((a, b) => b - a)
        .map((n) => ['plan', 'angre', '--nr', String(n), '--json', '--av', 'tavla']),
    };
  }

  /** Teksten for et flervalg (til forhåndsvisningen og bekreftelsen), f.eks. «3 poster: prioritet Nå (før prod)». */
  function masseTekst(b, { prosjekter = {} } = {}) {
    const n = Array.isArray(b?.ider) ? b.ider.length : 0;
    const hvem = n === 1 ? b.ider[0] : `${n} poster`;
    if (b?.handling === 'prioritet') {
      const v = PRIORITET[b.prioritet]?.tekst ?? b.prioritet;
      const kat = b.kategori ? ` (${KATEGORI[b.kategori] ?? b.kategori})` : '';
      return `${hvem}: prioritet ${v}${kat}`;
    }
    if (b?.handling === 'prosjekt')
      return `${hvem}: prosjekt ${b.prosjekt ? (prosjekter[b.prosjekt]?.kort ?? b.prosjekt) : 'ingen'}`;
    if (b?.handling === 'modenhet')
      return `${hvem}: modenhet ${MODENHET[b.modenhet] ?? b.modenhet}`;
    if (b?.handling === 'slaa-sammen') return `${hvem}: slås sammen inn i ${b.til}`;
    return hvem;
  }

  // ---- trekartet og avhengighetene for utvalget ------------------------------------------------

  /** Visningene av planpostene (`vis` i nettadressen): listen, prioritetskartet, trekartet og avhengighetene. */
  const VISNINGER = ['liste', 'kart', 'trekart', 'avh'];
  /** Utvalget i avhengighetsvisningen (`avh` i nettadressen): hele utvalget, eller valgt post med naboene. */
  const AVH_MODUS = ['utvalg', 'post'];

  /**
   * Vekten (arealet i trekartet, tyngden langs den kritiske veien) per estimat, i køspor. Samme tall som
   * koPlan.ESTIMAT_SPOR (kapasiteten), så trekartet og «Nå er ca. N uker» regner likt (testen holder dem like).
   * En post uten estimat teller som UTEN_ESTIMAT_VEKT og merkes «uten estimat», så den ikke forsvinner.
   */
  const ESTIMAT_VEKT = { S: 1, M: 2, L: 7, XL: 15 };
  const UTEN_ESTIMAT_VEKT = 1;
  /** Ferdige modenheter: bygget og verifisert er ikke lenger åpne (står aldri på kritisk vei og blokkerer ingen). */
  const FERDIG_MODENHET = ['bygget', 'verifisert'];
  /** Største utvalg avhengighetsvisningen tegner (aldri hele registeret, for da blir det et nøste). */
  const AVH_MAKS = 120;
  /** Flaten trekartet regnes i (bredde × høyde). Klienten skalerer til prosent, så bare forholdet betyr noe. */
  const TREKART_FLATE = { bredde: 1000, hoyde: 600 };
  /** Under denne bredden eller høyden (i TREKART_FLATE) vises bare navnet i feltet; resten står i etiketten. */
  const TREKART_LITEN = { bredde: 110, hoyde: 70 };

  /** Vekten til en post (estimatet i køspor). */
  function postVekt(p) {
    return ESTIMAT_VEKT[p?.estimat] ?? UTEN_ESTIMAT_VEKT;
  }

  /** Hvor mye av posten som er bygget (0 til 1): bygget og verifisert er 1, delvis er ferdige/totalt, resten 0. */
  function byggetAndel(p) {
    if (FERDIG_MODENHET.includes(p?.modenhet)) return 1;
    if (p?.modenhet === 'delvis' && p.totalt > 0) return Math.min(1, (p.ferdige ?? 0) / p.totalt);
    return 0;
  }

  /** Er posten åpen (ikke bygget, ikke verifisert, ikke droppet)? */
  function postAapen(p) {
    return !!p && !FERDIG_MODENHET.includes(p.modenhet) && p.prioritet !== 'dropp';
  }

  /**
   * Nivået trekartet viser, gitt filteret (zoomen er filteret, så brødsmulestien zoomer ut og tilbake-knappen virker):
   * ett prosjekt valgt gir postene, én modul gir prosjektene, ellers modulene.
   * @returns {'modul'|'prosjekt'|'post'}
   */
  function trekartNiva(filter) {
    if ((filter?.prosjekt ?? []).length === 1) return 'post';
    if ((filter?.modul ?? []).length === 1) return 'prosjekt';
    return 'modul';
  }

  /**
   * Feltene i trekartet for nivået: modulene, prosjektene eller postene i utvalget (`treff` er de filtrerte postene).
   * Arealet er summen av estimatene, fyllet hvor mye som er bygget (vektet med estimatet) og fargen prioriteten (for
   * et samlet felt: den prioriteten som har mest estimat, med Nå først ved likhet). `andeler` er fordelingen per
   * prioritet, som feltet også viser som tekst. `zoom` er filteret et klikk gir (null for en post: klikk åpner den).
   * Sortert etter vekt (størst først), så tittel.
   * @returns {{ niva: string, felter: object[], sum: number, utenEstimat: number }}
   */
  function trekartFelter(treff, data = {}, filter = {}) {
    const niva = trekartNiva(filter);
    const prosjekter = data.prosjekter ?? {};
    const moduler = data.moduler ?? [];
    const grupper = new Map();
    const leggTil = (nokkel, p) => {
      if (!grupper.has(nokkel)) grupper.set(nokkel, []);
      grupper.get(nokkel).push(p);
    };
    for (const p of treff ?? []) {
      if (niva === 'modul') leggTil(p.modul ?? UTEN_MODUL, p);
      else if (niva === 'prosjekt')
        leggTil(p.prosjekt && prosjekter[p.prosjekt] ? p.prosjekt : UTEN_PROSJEKT, p);
      else leggTil(p.id, p);
    }
    const felter = [];
    for (const [nokkel, liste] of grupper) {
      let vekt = 0;
      let bygget = 0;
      let uten = 0;
      const perPri = new Map();
      for (const p of liste) {
        const v = postVekt(p);
        vekt += v;
        bygget += v * byggetAndel(p);
        if (!ESTIMAT_VEKT[p.estimat]) uten += 1;
        const pri = Object.hasOwn(PRIORITET, p.prioritet) ? p.prioritet : 'eier';
        perPri.set(pri, (perPri.get(pri) ?? 0) + v);
      }
      const andeler = PRIORITETER.filter((x) => perPri.has(x)).map((x) => ({
        prioritet: x,
        vekt: perPri.get(x),
      }));
      const prioritet = andeler.reduce((a, x) => (!a || x.vekt > a.vekt ? x : a), null).prioritet;
      let tittel;
      let zoom = null;
      if (niva === 'modul') {
        tittel =
          nokkel === UTEN_MODUL
            ? 'Uten modul'
            : (moduler.find((m) => m.oid === nokkel)?.tittel ?? nokkel);
        zoom = { modul: [nokkel], prosjekt: [] };
      } else if (niva === 'prosjekt') {
        tittel =
          nokkel === UTEN_PROSJEKT
            ? 'Uten prosjekt'
            : (prosjekter[nokkel]?.kort ?? kortNavn(prosjekter[nokkel]?.tittel, nokkel));
        zoom = { modul: [...(filter?.modul ?? [])], prosjekt: [nokkel] };
      } else tittel = liste[0].tittel ?? nokkel;
      felter.push({
        id: nokkel,
        niva,
        tittel,
        vekt,
        antall: liste.length,
        utenEstimat: uten,
        bygget: vekt ? Math.round((bygget / vekt) * 1000) / 1000 : 0,
        prioritet,
        andeler,
        zoom,
        ...(niva === 'post'
          ? {
              post: liste[0].id,
              estimat: liste[0].estimat ?? null,
              modenhet: liste[0].modenhet ?? null,
            }
          : {}),
      });
    }
    felter.sort(
      (a, b) =>
        b.vekt - a.vekt ||
        a.tittel.localeCompare(b.tittel, 'nb') ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return {
      niva,
      felter,
      sum: felter.reduce((s, f) => s + f.vekt, 0),
      utenEstimat: felter.reduce((s, f) => s + f.utenEstimat, 0),
    };
  }

  /**
   * Rutene i trekartet: «squarified»-oppsettet (Bruls, Huizing og van Wijk), der hvert felt får areal etter vekten og
   * rutene holdes så nær kvadratiske som mulig. Feltene legges største først (rekkefølgen inn bevares ved lik vekt).
   * Deterministisk. Koordinatene er i flatens enheter, avrundet til to desimaler.
   * @param {{ id: string, vekt: number }[]} felter
   * @param {{ bredde: number, hoyde: number }} flate
   * @returns {{ id: string, x: number, y: number, bredde: number, hoyde: number }[]} i samme rekkefølge som lagt ut
   */
  function trekartRuter(felter, flate = TREKART_FLATE) {
    const W = flate?.bredde > 0 ? flate.bredde : TREKART_FLATE.bredde;
    const H = flate?.hoyde > 0 ? flate.hoyde : TREKART_FLATE.hoyde;
    const liste = (felter ?? [])
      .map((f, i) => ({ id: f.id, vekt: Number(f.vekt) > 0 ? Number(f.vekt) : 0, i }))
      .filter((f) => f.vekt > 0)
      .sort((a, b) => b.vekt - a.vekt || a.i - b.i);
    const total = liste.reduce((s, f) => s + f.vekt, 0);
    if (!total) return [];
    const ting = liste.map((f) => ({ id: f.id, areal: (f.vekt / total) * W * H }));
    const rest = { x: 0, y: 0, b: W, h: H };
    const ut = [];
    const r2 = (x) => Math.round(x * 100) / 100;
    // Det verste sideforholdet i en rad med gitt side (kortsiden av resten).
    const verst = (rad, side) => {
      const s = rad.reduce((a, t) => a + t.areal, 0);
      let maks = 0;
      for (const t of rad)
        maks = Math.max(maks, (side * side * t.areal) / (s * s), (s * s) / (side * side * t.areal));
      return maks;
    };
    const leggUt = (rad) => {
      const s = rad.reduce((a, t) => a + t.areal, 0);
      if (rest.b >= rest.h) {
        // En søyle til venstre i resten.
        const bredde = s / rest.h;
        let y = rest.y;
        for (const t of rad) {
          const h = t.areal / bredde;
          ut.push({ id: t.id, x: r2(rest.x), y: r2(y), bredde: r2(bredde), hoyde: r2(h) });
          y += h;
        }
        rest.x += bredde;
        rest.b -= bredde;
      } else {
        // En rad øverst i resten.
        const hoyde = s / rest.b;
        let x = rest.x;
        for (const t of rad) {
          const b = t.areal / hoyde;
          ut.push({ id: t.id, x: r2(x), y: r2(rest.y), bredde: r2(b), hoyde: r2(hoyde) });
          x += b;
        }
        rest.y += hoyde;
        rest.h -= hoyde;
      }
    };
    let rad = [];
    for (const t of ting) {
      const side = Math.min(rest.b, rest.h);
      if (!rad.length || verst([...rad, t], side) <= verst(rad, side)) rad.push(t);
      else {
        leggUt(rad);
        rad = [t];
      }
    }
    if (rad.length) leggUt(rad);
    return ut;
  }

  /** Er ruta for liten til mer enn navnet (resten står da i etiketten og i verktøytipset)? */
  function trekartLiten(rute) {
    return rute.bredde < TREKART_LITEN.bredde || rute.hoyde < TREKART_LITEN.hoyde;
  }

  /** «12 spor» / «1 spor»: estimatet i køspor, med desimal bare når det trengs. */
  function sporTekst(vekt) {
    const v = Math.round(vekt * 10) / 10;
    return `${String(v).replace('.', ',')} spor`;
  }

  /**
   * Teksten for et felt i trekartet, så fargen aldri er eneste bærer: navn, antall, estimat, prioriteten
   * (symbol og tekst; for et samlet felt fordelingen) og hvor mye som er bygget.
   * @returns {{ navn: string, linjer: string[], etikett: string }}
   */
  function trekartTekst(felt) {
    const pri = PRIORITET[felt.prioritet] ?? PRIORITET.eier;
    const prosent = `${Math.round(felt.bygget * 100)} % bygget`;
    const linjer = [];
    if (felt.niva === 'post') {
      linjer.push(`${pri.symbol} ${pri.tekst}`);
      linjer.push(
        felt.estimat && ESTIMAT_VEKT[felt.estimat]
          ? `${felt.estimat} (${sporTekst(felt.vekt)})`
          : 'Uten estimat',
      );
      linjer.push(prosent);
    } else {
      linjer.push(
        `${felt.antall} ${felt.antall === 1 ? 'post' : 'poster'}, ${sporTekst(felt.vekt)}`,
      );
      linjer.push(
        felt.andeler
          .map(
            (a) =>
              `${PRIORITET[a.prioritet].symbol} ${PRIORITET[a.prioritet].tekst} ${sporTekst(a.vekt)}`,
          )
          .join(', '),
      );
      linjer.push(prosent);
      if (felt.utenEstimat) linjer.push(`${felt.utenEstimat} uten estimat`);
    }
    const navn = felt.niva === 'post' ? `${felt.id}: ${felt.tittel}` : felt.tittel;
    const handling = felt.niva === 'post' ? 'Åpne posten' : 'Zoom inn';
    return { navn, linjer, etikett: `${navn}. ${linjer.join('. ')}. ${handling}.` };
  }

  /**
   * Grafen i avhengighetsvisningen, som noder og kanter koGraf.lagdel kan legge ut fra venstre mot høyre.
   * Viser bare utvalget eller valgt post med naboene, aldri hele registeret:
   *   - `utvalg`: postene i utvalget som har en avhengighet (begge veier). Postene de avhenger av eller som avhenger av
   *     dem utenfor utvalget, står med som små naboer (rolle `nabo`), så du ser hva som holder igjen. Er utvalget hele
   *     registeret (`heleRegisteret`), eller større enn AVH_MAKS, tegnes ingenting.
   *   - `post`: valgt post, det den avhenger av og det som avhenger av den.
   * En åpen post er blokkert når minst én post den avhenger av fortsatt er åpen. Den kritiske veien er den tyngste
   * kjeden av åpne poster (estimatet som vekt, koGraf.kritiskVei), og vises bare når den har minst to ledd.
   * `grunn` forklarer et tomt bilde: 'velg-post', 'hele-registeret', 'for-stort' eller 'ingen-kanter'.
   * @returns {{ noder: object[], kanter: object[], prosjekter: [], kritisk: { sti: string[], sum: number },
   *   tall: { poster: number, naboer: number, blokkert: number, uten: number, utvalg: number }, grunn: string|null }}
   */
  function planGraf(poster, valg = {}) {
    const {
      modus = 'utvalg',
      utvalg = [],
      valgt = null,
      heleRegisteret = false,
      maks = AVH_MAKS,
      graf = null,
    } = valg;
    const G =
      graf ??
      (typeof module === 'object' && module.exports ? require('./koGraf.js') : globalThis.KoGraf);
    const perId = new Map((poster ?? []).map((p) => [p.id, p]));
    const forgj = new Map();
    const etter = new Map();
    for (const p of perId.values()) {
      const f = [...new Set(p.avhenger ?? [])].filter((x) => x !== p.id && perId.has(x)).sort();
      forgj.set(p.id, f);
      for (const x of f) {
        if (!etter.has(x)) etter.set(x, []);
        etter.get(x).push(p.id);
      }
    }
    const naboer = (id) => [...(forgj.get(id) ?? []), ...(etter.get(id) ?? [])];
    const blokkert = (p) =>
      postAapen(p) && (forgj.get(p.id) ?? []).some((f) => postAapen(perId.get(f)));
    const tom = (grunn, ekstra = {}) => ({
      noder: [],
      kanter: [],
      prosjekter: [],
      kritisk: { sti: [], sum: 0 },
      tall: { poster: 0, naboer: 0, blokkert: 0, uten: 0, utvalg: 0, ...ekstra },
      grunn,
    });

    const rolle = new Map();
    let uten = 0;
    let antallUtvalg = 0;
    if (modus === 'post') {
      if (!valgt || !perId.has(valgt)) return tom('velg-post');
      rolle.set(valgt, 'kjerne');
      for (const n of naboer(valgt)) rolle.set(n, 'kjerne');
      antallUtvalg = 1;
    } else {
      const ider = [...new Set(utvalg ?? [])].filter((id) => perId.has(id));
      antallUtvalg = ider.length;
      if (heleRegisteret) return tom('hele-registeret', { utvalg: ider.length });
      if (ider.length > maks) return tom('for-stort', { utvalg: ider.length });
      for (const id of ider) {
        if (naboer(id).length) rolle.set(id, 'kjerne');
        else uten += 1;
      }
      for (const id of [...rolle.keys()])
        for (const n of naboer(id)) if (!rolle.has(n)) rolle.set(n, 'nabo');
    }
    if (!rolle.size) return tom('ingen-kanter', { utvalg: antallUtvalg, uten });

    const MAAL = G?.MAAL ?? { rMin: 7, rMaks: 22, rLiten: 5 };
    const radius = (p) =>
      ESTIMAT_VEKT[p.estimat]
        ? Math.min(
            MAAL.rMaks,
            Math.round((MAAL.rMin + 4 * Math.sqrt(ESTIMAT_VEKT[p.estimat])) * 10) / 10,
          )
        : MAAL.rMin + 2;
    const noder = [...rolle.keys()].sort().map((id) => {
      const p = perId.get(id);
      const r = rolle.get(id);
      return {
        id,
        art: 'post',
        rolle: r,
        valgt: id === valgt,
        tittel: p.tittel ?? id,
        prosjekt: p.prosjekt ?? null,
        prioritet: Object.hasOwn(PRIORITET, p.prioritet) ? p.prioritet : 'eier',
        modenhet: p.modenhet ?? null,
        estimat: p.estimat ?? null,
        vekt: postVekt(p),
        bygget: byggetAndel(p),
        aapen: postAapen(p),
        blokkert: blokkert(p),
        r: r === 'nabo' ? MAAL.rLiten : radius(p),
      };
    });
    const kanter = [];
    for (const n of noder)
      for (const f of forgj.get(n.id) ?? [])
        if (rolle.has(f))
          kanter.push({ fra: f, til: n.id, art: 'avh', dempet: !postAapen(perId.get(f)) });
    kanter.sort((a, b) =>
      a.fra < b.fra ? -1 : a.fra > b.fra ? 1 : a.til < b.til ? -1 : a.til > b.til ? 1 : 0,
    );

    const vei = G?.kritiskVei
      ? G.kritiskVei(noder, kanter, { med: (n) => n.aapen, vekt: (n) => n.vekt })
      : { sti: [], sum: 0, kanter: [] };
    const kritisk = vei.sti.length >= 2 ? vei : { sti: [], sum: 0, kanter: [] };
    const paaVei = new Set(kritisk.sti);
    const kantPaaVei = new Set(kritisk.kanter);
    for (const n of noder) n.kritisk = paaVei.has(n.id);
    for (const k of kanter) k.kritisk = kantPaaVei.has(`${k.fra}>${k.til}`);
    return {
      noder,
      kanter,
      prosjekter: [],
      kritisk: { sti: kritisk.sti, sum: kritisk.sum },
      tall: {
        poster: noder.filter((n) => n.rolle === 'kjerne').length,
        naboer: noder.filter((n) => n.rolle === 'nabo').length,
        blokkert: noder.filter((n) => n.blokkert).length,
        uten,
        utvalg: antallUtvalg,
      },
      grunn: null,
    };
  }

  /** Teksten for en node i avhengighetsvisningen (etiketten og verktøytipset): farge er aldri eneste bærer. */
  function planNodeTekst(n) {
    const pri = PRIORITET[n.prioritet] ?? PRIORITET.eier;
    return [
      `${n.id}: ${n.tittel}`,
      `${pri.symbol} ${pri.tekst}, ${MODENHET[n.modenhet] ?? 'ukjent modenhet'}${n.estimat ? `, ${n.estimat}` : ', uten estimat'}`,
      n.blokkert ? 'Blokkert: venter på en åpen post' : null,
      n.aapen ? null : 'Ferdig eller droppet',
      n.kritisk ? 'På den kritiske veien' : null,
      n.rolle === 'nabo' ? 'Utenfor utvalget' : null,
    ].filter(Boolean);
  }

  /** Oppsummeringen over avhengighetsgrafen, eller forklaringen når den er tom. */
  function planGrafTekst(g) {
    if (g.grunn === 'velg-post')
      return 'Velg en post i listen eller trekartet for å se den med naboene.';
    if (g.grunn === 'hele-registeret')
      return 'Avhengighetene vises bare for et utvalg. Velg et filter eller søk, eller velg en post og «Valgt post med naboer».';
    if (g.grunn === 'for-stort')
      return `Utvalget har ${g.tall.utvalg} poster. Avhengighetene tegnes for høyst ${AVH_MAKS}; snevre inn med filtrene.`;
    if (g.grunn === 'ingen-kanter')
      return g.tall.utvalg
        ? `Ingen av de ${g.tall.utvalg} postene i utvalget har avhengigheter.`
        : 'Ingen poster i utvalget.';
    const deler = [`${g.tall.poster} ${g.tall.poster === 1 ? 'post' : 'poster'}`];
    if (g.tall.naboer) deler.push(`${g.tall.naboer} utenfor utvalget`);
    deler.push(`${g.tall.blokkert} blokkert`);
    if (g.tall.uten) deler.push(`${g.tall.uten} i utvalget uten avhengigheter (ikke tegnet)`);
    return deler.join(', ');
  }

  /** «Kritisk vei: A → B → C (ca. 9 spor)», eller null når det ikke finnes en kjede av åpne poster. */
  function kritiskVeiTekst(g) {
    if (!g?.kritisk?.sti?.length) return null;
    return `Kritisk vei: ${g.kritisk.sti.join(' → ')} (ca. ${sporTekst(g.kritisk.sum)})`;
  }

  // I Node (serveren og testene): dokumentmappene fra ko.config.json. I nettleseren finnes ikke require, og
  // planer.js setter mappene fra /api/planer.
  if (typeof module === 'object' && module.exports && typeof require === 'function') {
    try {
      settLesMapper(require('./koKonfig.js').konfig().dokumentMapper);
    } catch {
      // Uten konfigurasjon gjelder standarden (docs/).
    }
  }

  return {
    PRIORITET,
    PRIORITETER,
    KATEGORI,
    MODENHET,
    ESTIMAT,
    VENTER,
    FRIST,
    FANER,
    FASETTER,
    UTEN_PROSJEKT,
    UTEN_MODUL,
    FERDIGE_VISNINGER,
    tomtFilter,
    lesUrl,
    skrivUrl,
    antallFiltre,
    fristBand,
    juridiskeApne,
    venterPaa,
    sokTreff,
    filtrer,
    fasettTall,
    brikker,
    fremdrift,
    tre,
    kortNavn,
    kopierLinje,
    brodsmuler,
    postLinje,
    klargjor,
    koStatusTekst,
    sammeVisning,
    rensEgenVisning,
    prosjektInfo,
    planerData,
    planForOppgave,
    FLATER,
    DOK_GRUPPE,
    DOK_STATUS,
    DOK_MALGRUPPE,
    DOK_PRI,
    DOK_VARSEL,
    DOK_ALVOR,
    DOK_PUBLISERT,
    DOK_FASETTER,
    tomtDokFilter,
    dokSokTreff,
    dokFiltrer,
    dokFasettTall,
    dokBrikker,
    antallDokFiltre,
    dokGrupper,
    tidslinjeMaaneder,
    dokLinje,
    dokBrodsmuler,
    dokumenterData,
    KART_KOLONNER,
    FRIST_DAGER,
    UTKAST_MAKS,
    GRUNN_MAKS,
    kartKolonne,
    kartKolonneFor,
    kolonneMedUtkast,
    kolonneRegler,
    kartPoster,
    kartRutenett,
    flyttIUtkast,
    settUtkastGrunn,
    rensUtkast,
    kolonneNabo,
    utkastEndringer,
    utkastGrupper,
    prioriterKall,
    fristElementer,
    fristRader,
    fristSkala,
    fristTekst,
    // Mappene lesevisningen bruker nå (fra konfigurasjonen i Node, fra /api/planer i nettleseren).
    get LES_MAPPER() {
      return lesMapper.slice();
    },
    LES_MAPPER_STANDARD,
    settLesMapper,
    LES_MAKS_BYTE,
    get UREGISTRERT_GRUPPER() {
      return uregistrertGrupperDef();
    },
    uregistrertGrupperDef,
    lesStiFeil,
    lenkeMaal,
    inlineDeler,
    renTekst,
    markdownBlokker,
    slug,
    ankerIndeks,
    uregistrertGrupper,
    postForslag,
    nyPostFraSkjema,
    nyPostArgs,
    kildeTillegg,
    kildeArgs,
    JB_FLATER,
    JUR_STATUS,
    JUR_BLOKK,
    DPIA_TEKST,
    BESL_STATUS,
    BESL_TYPE,
    BESL_MENGDE,
    BESL_FORST,
    JUR_FASETTER,
    BESL_FASETTER,
    tomtJbFilter,
    jbFiltrer,
    jbFasettTall,
    jbBrikker,
    antallJbFiltre,
    jbListe,
    jbGrupper,
    jurLinje,
    eierLinje,
    jbBrodsmuler,
    jbData,
    flateAntall,
    avklarKropp,
    MODENHET_MANUELL,
    MODENHET_GRUPPER,
    PRIORITET_TAST,
    MASSE_HANDLINGER,
    MASSE_MAKS,
    PALETT_HANDLINGER,
    modulKort,
    venterPaaDeg,
    naaTilgang,
    kapasitetVarsel,
    nyligEndret,
    nyligRegistrert,
    arbeiderNaa,
    endredePoster,
    tastHandling,
    naboPost,
    prioritetFraTast,
    palettKandidater,
    palettTreff,
    leggTilNylig,
    startlinjer,
    planMasseKall,
    angreKall,
    masseTekst,
    VISNINGER,
    AVH_MODUS,
    ESTIMAT_VEKT,
    UTEN_ESTIMAT_VEKT,
    AVH_MAKS,
    TREKART_FLATE,
    postVekt,
    byggetAndel,
    postAapen,
    trekartNiva,
    trekartFelter,
    trekartRuter,
    trekartLiten,
    sporTekst,
    trekartTekst,
    planGraf,
    planNodeTekst,
    planGrafTekst,
    kritiskVeiTekst,
  };
});
