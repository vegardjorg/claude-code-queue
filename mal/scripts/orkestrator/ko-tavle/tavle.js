// =============================================================
// tavle.js: klienten til kanban-tavla for arbeidskøen. Vanilla JS, ingen byggesteg.
//
// Tavla henter tilstanden fra ko-tavle.mjs (som bruker køens egne regler) og skriver bare via serveren, som kjører
// ko.mjs. «Venter på deg» (sidepanel med eierspørsmål, QA, forslag og det som henger), «Neste opp»-stripa,
// «låser opp N» og kjeden rundt et valgt kort (uthevet, resten dempet; Esc nullstiller). Kjeden, «Neste opp» og
// innboksen regnes på serveren (koTavle.js); her er bare visningen. Visningen «Avhengigheter» (sirkler og
// streker) tegnes av graf.js med oppsettet fra koGraf.js; her er bare koblingen (tegn og kjeden).
// Her er bare visning og samspill: søk og Filter-menyen, flat visning, prosjektbaner eller statistikk,
// detaljpanel, innstillinger (tannhjulet), dra for å omprioritere (mus) og løft/flytt/slipp med tastaturet
// (mellomrom, piltaster, mellomrom; Esc avbryter). Svarer serveren med en advarsel fra vaktreglene (409), spør tavla
// eieren først («Gjør det likevel» / «Avbryt», og et forslag når det finnes).
// All tekst settes med textContent (aldri innerHTML), så innhold fra køen kan ikke bli til HTML. Grafene er inline
// SVG laget her, med fargene fra CSS-variablene.
// =============================================================
'use strict';

(function () {
  const NOKKEL = 'ko-tavle-nokkel';
  const FILTER_LAGRING = 'ko-tavle-filter';
  const KOLONNER = [
    { nokkel: 'ko', navn: 'I kø' },
    { nokkel: 'pagar', navn: 'Pågår' },
    { nokkel: 'review', navn: 'Review' },
    { nokkel: 'bygget', navn: 'Bygget' },
  ];

  // Kolonnene der kortene kan masseendres (status venter eller forslag, også i samlekøen).
  const MERKBARE_KOLONNER = new Set(['ko', 'forslag', 'samle']);

  const $ = (id) => document.getElementById(id);
  const main = $('tavle');
  const panel = $('panel');
  const bakgrunn = $('panel-bakgrunn');

  // «graf» er visningen «Avhengigheter» (graf.js, oppsettet i koGraf.js). «plan» er
  // planvisningen (Nå, Neste, Senere, Venter) i plan.js. Fanen heter «Fokus» (id-en `plan` er beholdt), så
  // den ikke blandes med Planer-rommet (planregisteret, planer/planer.js).
  const VISNINGER = ['flat', 'baner', 'plan', 'graf', 'sky', 'statistikk'];
  const lagretVisning = localStorage.getItem('ko-tavle-visning');

  const t = {
    nokkel: null,
    data: null,
    versjon: null,
    hentet: null,
    feil: null,
    perId: new Map(),
    // Filtrene: avkryssede valg per seksjon i Filter-menyen (FILTER_SEKSJONER), pluss søket.
    filter: { valgt: lesFilter(), sok: '' },
    visning: VISNINGER.includes(lagretVisning) ? lagretVisning : 'flat',
    visFlere: false,
    // Lukkede seksjoner. Blokkert er lukket fra start (400+ kort), og innholdet i en lukket
    // seksjon bygges først når den åpnes (seksjon()).
    lukket: new Set(['forslag', 'blokkert']),
    // Kortet som er tab-stoppet i hver kolonne eller celle (områdenøkkel → kort-id).
    roving: new Map(),
    // Det som avhenger av søket (tellere, tomtekster, grupper, baner). Fylles av tegn(); søket
    // oppdaterer dem uten å bygge tavla på nytt (brukSok()).
    sokAvh: [],
    valgt: null, // id-en i detaljpanelet
    innst: null, // innstillingspanelet: svaret fra /api/innstillinger (null = lukket)
    stat: { data: null, versjon: null, feil: null }, // statistikken fra /api/statistikk
    skyko: { data: null, feil: null }, // visningen «Sky»: buntforslag fra /api/sky-bunter
    detaljer: new Map(), // id → { oppdrag, gren } fra /api/oppgave
    opptatt: false, // en flytting lagres: ikke tegn om tavla imens
    ventende: false,
    // Kjedevisningen
    kjede: null, // id-en til kortet som har kjeden uthevet (null = ingen)
    innboks: false, // «Venter på deg» er åpent i sidepanelet
    valgtQa: new Set(), // avhukede i QA-delen
    valgtForslag: new Set(), // avhukede i Forslag-delen
    valgtSorter: new Set(), // Avhukede i Sorter-delen
    svarApent: null, // spørsmålet som har svarfeltet åpent
    svarUtkast: new Map(), // spørsmål → tekst som er skrevet (overlever omtegning)
    fraInnboks: false, // detaljpanelet ble åpnet fra innboksen (knappen «Tilbake»)
    // Skyvisningen
    skyValgt: new Set(), // kort i kø som er krysset av for en skybunt (filteret «Egnet for sky»)
    skypakke: null, // { ider, tekst, kopiert } sist hentede skypakke (tekstfeltet er reserven når kopiering feiler)
    // Flervalg. Valget er id-er (overlever omtegning, filter- og visningsbytte); `anker` er sist merkede
    // (Shift-klikk merker alt mellom). `masse` er dialogen for en massehandling (null = lukket).
    merket: new Set(),
    anker: null,
    masse: null,
    // Serveren svarte 401 (startet på nytt); banneret vises og pollingen står.
    nokkelUgyldig: false,
  };

  // ---- Filtrene (Filter-menyen) ----
  // Seksjonene er data, så flere filtre (f.eks. klasse eller migrasjoner) er én oppføring til. `modus`:
  //   'alle' → hvert avkrysset valg må passe (innsnevring, som «Bare klare nå»),
  //   'noen' → kortet må passe minst ett avkrysset valg; ingen avkrysset = ingen filtrering (som prosjektene).
  const FILTER_SEKSJONER = [
    {
      nokkel: 'vis',
      tittel: 'Vis',
      modus: 'alle',
      valg: () => [
        {
          verdi: 'klare',
          tekst: 'Bare klare nå',
          passer: (k, kol) => (kol !== 'ko' && kol !== 'forslag' && kol !== 'samle') || k.klar,
        },
        { verdi: 'visuelle', tekst: 'Bare visuelle', passer: (k) => k.visuell },
        // Egnet for en skyøkt (koLogikk.skyEgnet), eller allerede i sky. Med dette filteret får kortene i kø
        // en avkryssingsboks, så flere kan sendes som én bunt.
        {
          verdi: 'sky',
          tekst: 'Egnet for sky',
          passer: (k, kol) =>
            (kol !== 'ko' && kol !== 'forslag' && kol !== 'samle') || !!k.sky?.egnet,
        },
      ],
    },
    {
      nokkel: 'prosjekter',
      tittel: 'Prosjekter',
      modus: 'noen',
      valg: () =>
        (t.data?.prosjekter ?? []).map((p) => ({
          verdi: p.pid,
          tekst: p.pid,
          prosjekt: p,
          passer: (k) => k.prosjekt === p.pid,
        })),
    },
    // Kortene (og prosjektbanene) filtrert på planpost.
    {
      nokkel: 'plan',
      tittel: 'Planpost',
      modus: 'noen',
      valg: () =>
        [...new Set([...t.perId.values()].map((x) => x.k?.plan).filter(Boolean))]
          .sort()
          .map((id) => ({
            verdi: id,
            tekst: [id, window.KoPlaner?.tittel(id)].filter(Boolean).join(' '),
            passer: (k) => k.plan === id,
          })),
    },
  ];

  /** Lagrede filtre fra denne nettleseren (localStorage). Tomt eller ødelagt gir standard: ingen filtre. */
  function lesFilter() {
    const valgt = {};
    let lagret = null;
    try {
      lagret = JSON.parse(localStorage.getItem(FILTER_LAGRING) ?? 'null');
    } catch {
      lagret = null;
    }
    for (const nokkel of ['vis', 'prosjekter', 'plan']) {
      const liste = lagret && Array.isArray(lagret[nokkel]) ? lagret[nokkel] : [];
      valgt[nokkel] = new Set(liste.filter((x) => typeof x === 'string' && x.length <= 60));
    }
    return valgt;
  }
  function lagreFilter() {
    try {
      const ut = {};
      for (const [k, sett] of Object.entries(t.filter.valgt)) ut[k] = [...sett];
      localStorage.setItem(FILTER_LAGRING, JSON.stringify(ut));
    } catch {
      /* privat modus eller full lagring: filtrene gjelder bare denne økta */
    }
  }
  const antallFiltre = () =>
    Object.values(t.filter.valgt).reduce((sum, sett) => sum + sett.size, 0);
  let dra = null; // { type: 'kort' | 'bane', el, liste, forrige, neste, sluppet }
  let loftet = null; // samme form, løftet med tastaturet

  // ---- Hjelpere ----
  function el(tag, attr, ...barn) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attr ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'tekst') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k.startsWith('--')) e.style.setProperty(k, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const b of barn.flat()) if (b != null && b !== false) e.append(b);
    return e;
  }

  const IKONER = {
    laas: [
      ['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2, fill: 'currentColor' }],
      [
        'path',
        { d: 'M8 11V7a4 4 0 0 1 8 0v4', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 },
      ],
    ],
    lukk: [
      [
        'path',
        {
          d: 'M6 6l12 12M18 6L6 18',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 2,
          'stroke-linecap': 'round',
        },
      ],
    ],
    // Hake: tom innboks («Ingenting venter på deg»).
    hake: [
      [
        'path',
        {
          d: 'M5 12.5l4.5 4.5L19 7',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 2.5,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
      ],
    ],
    handtak: [9, 15].flatMap((x) =>
      [6, 12, 18].map((y) => ['circle', { cx: x, cy: y, r: 1.6, fill: 'currentColor' }]),
    ),
    // Tannhjul: en ring og åtte tenner.
    tannhjul: [
      ...[0, 45, 90, 135, 180, 225, 270, 315].map((v) => [
        'rect',
        {
          x: 10.25,
          y: 1.5,
          width: 3.5,
          height: 5,
          rx: 1,
          fill: 'currentColor',
          transform: `rotate(${v} 12 12)`,
        },
      ]),
      [
        'circle',
        { cx: 12, cy: 12, r: 5.25, fill: 'none', stroke: 'currentColor', 'stroke-width': 3 },
      ],
    ],
  };
  function ikon(navn, etikett) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', `ikon ${navn}`);
    if (etikett) {
      s.setAttribute('role', 'img');
      s.setAttribute('aria-label', etikett);
    } else s.setAttribute('aria-hidden', 'true');
    for (const [tag, attr] of IKONER[navn]) {
      const d = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attr)) d.setAttribute(k, String(v));
      s.append(d);
    }
    return s;
  }

  /** «14 min», «3 t 12 min», «4 d» (bare visning). */
  function alder(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return '?';
    const min = Math.max(0, Math.round(ms / 60_000));
    if (min < 60) return `${min} min`;
    const timer = Math.floor(min / 60);
    return timer < 48 ? `${timer} t ${min % 60} min` : `${Math.floor(timer / 24)} d`;
  }
  const klokke = (d) =>
    d.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ---- Toast-stabelen ----
  // Meldingen og «Angre» står i samme stabel (#toaster, flex-kolonne), så de aldri ligger oppå hverandre. Køen
  // (KoUu.toastLegg) sier hvilke som vises og i hvilken rekkefølge: nyeste nederst. «Angre» faller aldri ut av køen
  // før de 30 sekundene er gått eller eieren lukker den.
  const TOAST_EL = { melding: 'melding', angre: 'angre-melding' };
  let toastKo = [];
  function tegnToaster() {
    for (const [nokkel, id] of Object.entries(TOAST_EL)) {
      const i = toastKo.indexOf(nokkel);
      const boks = $(id);
      boks.hidden = i < 0;
      boks.style.order = String(Math.max(0, i));
    }
  }
  function visToast(nokkel) {
    toastKo = window.KoUu.toastLegg(toastKo, nokkel, { maks: 3, beholdes: ['angre'] });
    tegnToaster();
  }
  function skjulToast(nokkel) {
    toastKo = window.KoUu.toastFjern(toastKo, nokkel);
    tegnToaster();
  }

  let meldingTid = null;
  function melding(tekst, feil, ms) {
    const m = $('melding');
    m.textContent = tekst;
    m.classList.toggle('feil', !!feil);
    visToast('melding');
    clearTimeout(meldingTid);
    meldingTid = setTimeout(() => skjulToast('melding'), ms ?? (feil ? 9000 : 6000));
  }

  // ---- Nøkkel og API ----
  function hentNokkel() {
    const m = /[#&]nokkel=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (m) {
      sessionStorage.setItem(NOKKEL, m[1]);
      history.replaceState(null, '', location.pathname + location.search);
    }
    return sessionStorage.getItem(NOKKEL);
  }

  // ---- Banneret etter en omstart ----
  const nokkelBanner = $('nokkel-banner');
  /** Viser banneret og stopper pollingen (t.nokkelUgyldig). Gamle data blir stående, men banneret sier det. */
  function visNokkelBanner() {
    t.nokkelUgyldig = true;
    if (!nokkelBanner.hidden) return;
    nokkelBanner.hidden = false;
    document.body.classList.add('nokkel-ugyldig');
  }
  $('nokkel-skjema').addEventListener('submit', (e) => {
    e.preventDefault();
    const felt = $('nokkel-lenke');
    const feil = $('nokkel-feil');
    const ny = window.KoUu.nokkelFraLenke(felt.value);
    if (!ny) {
      feil.textContent = 'Fant ingen nøkkel. Lenken slutter på #nokkel=… .';
      feil.hidden = false;
      felt.focus();
      return;
    }
    sessionStorage.setItem(NOKKEL, ny);
    t.nokkel = ny;
    t.nokkelUgyldig = false;
    t.versjon = null;
    felt.value = '';
    feil.hidden = true;
    nokkelBanner.hidden = true;
    document.body.classList.remove('nokkel-ugyldig');
    oppdater(true);
    if (t.visning === 'statistikk') hentStatistikk();
    if (t.visning === 'sky') hentSkyko();
  });

  async function api(sti, kropp) {
    const init = { headers: { 'X-Ko-Nokkel': t.nokkel ?? '' } };
    if (kropp) {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(kropp);
    }
    const res = await fetch(sti, init);
    let svar = null;
    try {
      svar = await res.json();
    } catch {
      svar = null;
    }
    // 401 betyr at serveren er startet på nytt med ny nøkkel. Banneret ber om lenken, og
    // pollingen står til nøkkelen er på plass.
    if (res.status === 401) visNokkelBanner();
    if (!res.ok) {
      // Statusen og svaret følger med, så en advarsel fra vaktreglene (409 + bekreft) kan bekreftes.
      const e = new Error(svar?.melding ?? `HTTP ${res.status}`);
      e.status = res.status;
      e.svar = svar;
      throw e;
    }
    return svar;
  }

  /**
   * Et skrivekall med vaktreglene: svarer serveren med en advarsel (409 med `bekreft`), spør tavla eieren først og
   * sender kallet på nytt med `bekreft: true` (og forslagets felt når eieren valgte forslaget). Returnerer svaret,
   * eller null når eieren avbrøt. En stopp (422) og andre feil kastes som før.
   */
  async function skrivMedVakt(sti, kropp) {
    try {
      return await api(sti, kropp);
    } catch (e) {
      if (e.status !== 409 || !e.svar?.bekreft) throw e;
      const valg = await bekreftVakt(e.svar.vakt ?? []);
      if (!valg) return null;
      return api(sti, { ...kropp, ...valg, bekreft: true });
    }
  }

  // ---- Bekreftelsen ved en advarsel ----
  const vaktBakgrunn = $('vakt-bakgrunn');
  const vaktBoks = $('vakt');
  /** Viser advarslene og venter på eieren: {} = gjør det likevel, forslagets felt = forslaget, null = avbryt. */
  function bekreftVakt(vakt) {
    return new Promise((ferdig) => {
      const fra = document.activeElement;
      const advarsler = vakt.filter((v) => v.nivaa === 'advarsel');
      const andre = vakt.filter((v) => v.nivaa === 'info');
      const forslag = advarsler.find((v) => v.forslag)?.forslag ?? null;
      const svar = (verdi) => {
        vaktBakgrunn.hidden = true;
        vaktBoks.replaceChildren();
        vaktBoks.removeEventListener('keydown', taster);
        if (fra?.isConnected) fra.focus();
        ferdig(verdi);
      };
      const taster = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          svar(null);
        } else {
          // Fokus blir i dialogen (den felles fella i uu.js).
          window.KoUu.fellaTast(e, vaktBoks);
        }
      };
      const avbryt = el('button', {
        type: 'button',
        class: 'knapp knapp-kontur',
        tekst: 'Avbryt',
        onclick: () => svar(null),
      });
      vaktBoks.replaceChildren(
        el('h2', { id: 'vakt-tittel', tekst: 'Er du sikker?' }),
        el(
          'ul',
          { id: 'vakt-tekst', class: 'vakt-liste' },
          advarsler.map((v) => el('li', { tekst: v.tekst })),
          andre.map((v) => el('li', { class: 'vakt-info', tekst: v.tekst })),
        ),
        el(
          'div',
          { class: 'vakt-knapper' },
          avbryt,
          forslag
            ? el('button', {
                type: 'button',
                class: 'knapp knapp-tonet',
                tekst: forslag.tekst,
                onclick: () => svar({ ...forslag.felt }),
              })
            : null,
          el('button', {
            type: 'button',
            class: 'knapp knapp-fylt',
            tekst: 'Gjør det likevel',
            onclick: () => svar({}),
          }),
        ),
      );
      vaktBoks.addEventListener('keydown', taster);
      vaktBakgrunn.hidden = false;
      avbryt.focus();
    });
  }
  vaktBakgrunn.addEventListener('click', (e) => {
    if (e.target === vaktBakgrunn) vaktBoks.querySelector('button')?.click();
  });

  /** Melding etter en vellykket skriving, med info-tekstene fra vaktreglene under. */
  function meldingMedInfo(ok, svar) {
    const info = Array.isArray(svar?.info) ? svar.info : [];
    melding([ok, ...info].join('\n'), false, info.length ? 9000 : null);
  }

  // ---- Henting (hvert 15. sekund og når fanen får fokus; serveren svarer «uendret» når ingenting er nytt) ----
  let henter = false;
  let tvingEtter = false; // en tvungen henting som kom mens en annen pågikk: kjøres når den er ferdig
  async function oppdater(tving) {
    // Uten gyldig nøkkel står pollingen (banneret ber om lenken); en tvungen henting prøver likevel.
    if (henter && tving) tvingEtter = true; // ellers ble raden stående til neste polling
    if (henter || !t.nokkel || (t.nokkelUgyldig && !tving)) return;
    henter = true;
    try {
      const q = t.versjon && !tving ? `?versjon=${encodeURIComponent(t.versjon)}` : '';
      const svar = await api(`/api/tilstand${q}`);
      t.feil = null;
      t.hentet = new Date();
      if (!svar.uendret) {
        t.data = svar.data;
        t.versjon = svar.versjon;
        indekser();
        tegnLogo();
        if (dra || loftet || t.opptatt || window.KoPlan?.opptatt()) t.ventende = true;
        else if (t.visning === 'sky')
          hentSkyko(); // buntene avhenger av køen: hent på nytt
        else if (t.visning !== 'statistikk')
          tegn(); // statistikken har sin egen henting
        else tegnFilter();
        // «Venter på deg»: telleren i toppen, og panelet når det er åpent.
        tegnInnboksKnapp();
        if (t.innboks) tegnInnboks();
      }
    } catch (e) {
      t.feil = e.message;
      if (!t.data) tegn();
    } finally {
      henter = false;
      // Mens et kort er løftet, står hjelpeteksten for tastaturet i statuslinja.
      if (!loftet) tegnStatus();
    }
    if (tvingEtter) {
      tvingEtter = false;
      await oppdater(true);
    }
  }

  function indekser() {
    t.perId = new Map();
    for (const [kol, liste] of Object.entries(t.data.kolonner))
      for (const k of liste) t.perId.set(k.id, { k, kol });
    // Et merket kort som har startet, er ferdig eller borte, faller ut av valget.
    for (const id of t.merket) if (!merkbar(id)) t.merket.delete(id);
    if (t.anker && !merkbar(t.anker)) t.anker = null;
  }

  function tegnStatus() {
    const s = $('status');
    if (!t.nokkel) {
      s.textContent = 'Mangler nøkkel: åpne lenken ko-tavle skrev i terminalen.';
      s.classList.add('feil');
      return;
    }
    s.classList.toggle('feil', !!t.feil);
    // Siste vellykkede henting er over ett minutt gammel (klokka nederst kaller tegnStatus).
    const gammel =
      !t.feil && !t.nokkelUgyldig && window.KoUu.foreldet(t.hentet?.getTime() ?? NaN, Date.now());
    s.classList.toggle('foreldet', gammel);
    if (gammel) s.textContent = window.KoUu.foreldetTekst(t.hentet);
    else if (t.nokkelUgyldig)
      s.textContent = t.hentet
        ? `Nøkkelen er gammel. Viser tilstanden fra kl. ${klokke(t.hentet)}.`
        : 'Nøkkelen er gammel.';
    else if (t.feil)
      s.textContent = t.hentet
        ? `Kunne ikke lese køen (${t.feil}). Viser tilstanden fra kl. ${klokke(t.hentet)}.`
        : `Kunne ikke lese køen (${t.feil}).`;
    else if (t.hentet)
      s.textContent =
        `Oppdatert kl. ${klokke(t.hentet)}` +
        (t.data?.gitFeil
          ? ' (git status kunne ikke leses; ucommittede filer er ikke sjekket)'
          : '');
  }

  // ---- Filtre ----
  function synlig(k, kol) {
    return synligUtenSok(k, kol) && sokTreff(k);
  }

  /** Søket alene (Søket skjuler kort med `hidden`, mens filtrene avgjør hva som bygges). */
  function sokTreff(k) {
    if (!t.filter.sok) return true;
    return `${k.id} ${k.tittel} ${k.funksjon ?? ''} ${k.prosjekt}`
      .toLowerCase()
      .includes(t.filter.sok);
  }

  /** Filtrene og visningene uten søket: kortene som bygges i Flat og Prosjektbaner. */
  function synligUtenSok(k, kol) {
    // En innebygd visning (t.spesial) filtrerer kortene i kø, forslag og samlekøen. «Nytt siden sist»
    // gjelder alle kolonner. t.spesial er null til visningene er satt opp, så SPESIAL brukes aldri før den finnes.
    if (t.spesial && (MERKBARE_KOLONNER.has(kol) || t.spesial === 'nytt') && !SPESIAL[t.spesial](k))
      return false;
    for (const s of FILTER_SEKSJONER) {
      const valgt = t.filter.valgt[s.nokkel];
      if (!valgt?.size) continue;
      const aktive = s.valg().filter((v) => valgt.has(v.verdi));
      if (!aktive.length) continue; // lagret valg som ikke finnes lenger (f.eks. et fjernet prosjekt)
      const ok =
        s.modus === 'alle'
          ? aktive.every((v) => v.passer(k, kol))
          : aktive.some((v) => v.passer(k, kol));
      if (!ok) return false;
    }
    return true;
  }

  // ---- Søket uten ombygging ----
  /**
   * Registrerer noe som avhenger av søket: `oppdater(treff)` får kortene i `kort` som passer søket, nå og hver gang
   * søket endres. Brukes for tellere, tomtekster, grupper og baner; kortene selv skjules i brukSok().
   */
  function sokBundet(kort, oppdater) {
    t.sokAvh.push({ kort, oppdater });
    oppdater(t.filter.sok ? kort.filter(sokTreff) : kort);
  }

  /**
   * Søket er endret: skjul og vis kortene som er bygget (hidden), og oppdater det som er registrert med sokBundet.
   * Ingen kort bygges på nytt. `rot` begrenser kortene til en del av tavla (en seksjon som nettopp er bygget).
   */
  function brukSok(rot = main) {
    for (const li of rot.querySelectorAll('.kort[data-id]')) {
      const x = t.perId.get(li.dataset.id);
      li.hidden = !!x && !sokTreff(x.k);
    }
    if (rot !== main) return;
    oppdaterSokAvh();
    etterSok();
  }

  /** Kjører det som er registrert med sokBundet (søket eller merkingen er endret). */
  function oppdaterSokAvh() {
    for (const a of t.sokAvh) a.oppdater(t.filter.sok ? a.kort.filter(sokTreff) : a.kort);
  }

  /**
   * Etter tegningen og etter søket: en områdeoverskrift uten synlige baner under seg skjules, tomteksten i
   * Prosjektbaner vises bare når ingen bane er synlig, og hver kolonne får sitt tab-stopp (rovingOppsett).
   */
  function etterSok() {
    let overskrift = null;
    let synligUnder = false;
    let synligeBaner = 0;
    let tom = null;
    for (const li of main.querySelectorAll(':scope > .baneliste > li')) {
      if (li.classList.contains('bane-tom')) tom = li;
      else if (li.classList.contains('omrade-overskrift')) {
        if (overskrift) overskrift.hidden = !synligUnder;
        overskrift = li;
        synligUnder = false;
      } else if (!li.hidden) {
        synligUnder = true;
        synligeBaner++;
      }
    }
    if (overskrift) overskrift.hidden = !synligUnder;
    if (tom) {
      tom.hidden = synligeBaner > 0;
      // Den felles tomtilstanden (grunnen og handlingen), bygget når den vises.
      if (!tom.hidden) tom.replaceChildren(tomTilstand('Ingen kort her.'));
    }
    rovingOppsett();
  }

  function prosjekt(pid) {
    return t.data?.prosjekter.find((p) => p.pid === pid) ?? null;
  }

  // ---- Kort ----
  /** Verktøytipset for aldrende arbeid: over p85 for klassen. */
  function aldringTekst(k) {
    const a = k.aldrende;
    if (!a) return null;
    return a.maal === 'arbeid'
      ? `Eldre enn vanlig: 85 % av ${k.klasse}-oppgavene de siste 14 dagene var levert innen ` +
          `${varighet(a.grense)} etter start. Denne har kjørt i ${varighet(a.alder)}.`
      : `Eldre enn vanlig: 85 % av ${k.klasse}-oppgavene de siste 14 dagene var ferdige innen ` +
          `${varighet(a.grense)} etter start. Denne startet for ${varighet(a.alder)} siden.`;
  }

  function fotFor(k, kol) {
    const fot = [];
    if (kol === 'ko') {
      if (k.klar) fot.push(el('span', { class: 'merke klar-merke', tekst: 'Klar nå' }));
      else {
        const h = k.hindringer[0] ?? '';
        const flere = k.hindringer.length > 1 ? ` (+${k.hindringer.length - 1})` : '';
        fot.push(
          el('span', { class: 'hindring', tekst: h + flere, title: k.hindringer.join('\n') }),
        );
      }
    } else if (kol === 'forslag') {
      fot.push(el('span', { tekst: `forslag fra ${k.lagt_til_av ?? '?'}` }));
    } else if (kol === 'samle') {
      // Startes ikke alene; orkestratoren pakker gruppa til et spor (ko.mjs samle pakk).
      fot.push(
        el('span', {
          tekst: k.status === 'forslag' ? 'forslag i samlekøen' : 'pakkes til et spor',
        }),
      );
    } else if (kol === 'pagar') {
      // Et kort i en skyøkt får et lite skymerke i stedet for «plukket av sky».
      if (k.i_sky)
        fot.push(
          el('span', {
            class: 'merke sky-merke',
            tekst: 'Sky',
            title: k.sky_okt?.kjoring ? `Skyøkt: ${k.sky_okt.kjoring}` : 'Kjører i en skyøkt',
          }),
        );
      const hvem = k.i_sky
        ? 'i sky'
        : k.status === 'plukket'
          ? `plukket av ${k.plukket_av ?? '?'}`
          : k.status === 'ekstern'
            ? `utenfor køen: ${k.ekstern_navn ?? '?'}`
            : 'kjører';
      fot.push(el('span', { tekst: hvem }));
      if (k.start)
        fot.push(
          el('span', {
            'data-start': k.start,
            class: k.aldrende ? 'alder-over' : null,
            tekst: alder(k.start),
          }),
        );
      if (k.gammel) fot.push(el('span', { class: 'merke gammel', tekst: 'gammel' }));
    } else if (kol === 'review') {
      if (k.levert)
        fot.push(
          el('span', {
            class: k.aldrende ? 'alder-over' : null,
            tekst: `levert for ${alder(k.levert)} siden`,
          }),
        );
    } else if (kol === 'bygget') {
      if (k.qa_status === 'venter')
        fot.push(el('span', { class: 'merke qa', tekst: 'Venter på QA' }));
      else if (k.qa_status === 'avvik')
        fot.push(el('span', { class: 'merke avvik', tekst: 'QA-avvik' }));
      if (k.ferdig) fot.push(el('span', { tekst: `ferdig for ${alder(k.ferdig)} siden` }));
    }
    return fot;
  }

  /** Prosjektnavnet på kortet er overflødig i Prosjektbaner og når Flat er gruppert etter prosjekt. */
  function visProsjektNavn() {
    if (t.visning === 'baner') return false;
    return !['omrade', 'funksjon'].includes(t.gruppering);
  }

  function kortEl(k, kol) {
    const flyttbar = kol === 'ko';
    const p = prosjekt(k.prosjekt);
    const klasser = ['kort'];
    if (kol === 'ko') klasser.push(k.klar ? 'klar' : 'blokkert');
    if (kol === 'samle') klasser.push('samlekort');
    if (k.aldrende) klasser.push('aldrende');
    // Kort som kan masseendres (venter, forslag, samlekøen) får en avkryssingsboks.
    const kanMerkes = MERKBARE_KOLONNER.has(kol);
    if (kanMerkes && t.merket.has(k.id)) klasser.push('merket');
    const statusTekst =
      kol === 'ko'
        ? k.klar
          ? 'klar nå'
          : `blokkert: ${k.hindringer.join('; ')}`
        : kol === 'samle'
          ? 'i samlekøen, pakkes til et spor'
          : k.status;
    // «Låser opp N»: ikke på Bygget, der er kortet selv ferdig.
    const las = kol !== 'bygget' ? k.laaser_opp : null;
    const lasTekst = las
      ? `Låser opp ${las.antall} ${las.antall === 1 ? 'oppgave' : 'oppgaver'} (${varighet(las.minutter)} anslått) via kjeden`
      : null;
    // Knappen (tittelen) beskrives av metadataene og foten. Det som bare står i verktøytips
    // (alle hindringene, låser opp, eldre enn vanlig), står som skjult tekst blant metadataene.
    const metaId = `kort-meta-${kol}-${k.id}`;
    const fotId = `kort-fot-${kol}-${k.id}`;
    const skjultTekst = [
      kol === 'ko' && !k.klar && k.hindringer.length > 1 ? statusTekst : null,
      kol === 'samle' ? statusTekst : null,
      lasTekst,
      k.aldrende ? 'Eldre enn vanlig for klassen' : null,
    ]
      .filter(Boolean)
      .join('. ');
    return el(
      'li',
      {
        // Kortet selv er ikke fokuserbart og har ingen aria-label som overstyrer innholdet.
        // Tittelen er knappen (roving tabindex), og metadataene beskriver den (aria-describedby).
        class: klasser.join(' '),
        draggable: flyttbar ? 'true' : null,
        'data-id': k.id,
        'data-kol': kol,
        'data-merkbar': kanMerkes ? '1' : null,
        '--p': `var(--color-${k.farge})`,
        title: [
          `${p?.tittel ?? k.prosjekt}${k.funksjon ? ` · ${k.funksjon}` : ''}`,
          aldringTekst(k),
        ]
          .filter(Boolean)
          .join('\n'),
      },
      el(
        'div',
        { class: 'kort-hode' },
        // Avkryssingsboksen står utenfor knappen og utenfor metadataene (den har sin egen etikett).
        kanMerkes ? merkBoks(k) : null,
        el(
          'span',
          { class: 'kort-meta', id: metaId },
          el('span', { class: 'kort-id', tekst: k.id }),
          // Prosjektets kortnavn som tekst (fargestripa alene har for lav kontrast), men ikke når
          // kortene allerede står gruppert per prosjekt.
          visProsjektNavn()
            ? el('span', {
                class: 'kort-prosjekt',
                tekst: k.prosjekt,
                title: p?.tittel ?? k.prosjekt,
              })
            : null,
          // Planposten kortet hører til. Klikk bytter til Planer med posten åpen. Merket er ikke et
          // eget tab-stopp (roving tabindex); med tastaturet går veien via «Planpost» i detaljpanelet.
          k.plan
            ? el('button', {
                type: 'button',
                class: 'merke planpost-merke',
                tabindex: '-1',
                tekst: k.plan,
                title: `Planpost ${k.plan}: åpne i Planer`,
                onclick: (e) => {
                  e.stopPropagation();
                  window.KoPlaner?.aapnePost(k.plan);
                },
              })
            : null,
          k.klasse
            ? el('span', {
                class: `merke${k.klasse === 'D+' ? ' klasse-dpluss' : ''}`,
                tekst: k.klasse,
                title: window.KoUu.klasseEtikett(k.klasse),
                'aria-label': window.KoUu.klasseEtikett(k.klasse),
              })
            : null,
          el('span', { class: 'merke', tekst: `${k.anslag} min`, title: 'Anslag' }),
          k.visuell ? el('span', { class: 'merke visuell', tekst: 'visuell' }) : null,
          k.parkert
            ? el('span', {
                class: 'merke vent-merke',
                tekst: 'på vent',
                title: ventTekst(k.parkert),
              })
            : null,
          las
            ? el('span', {
                class: 'merke laaser',
                tekst: `låser opp ${las.antall}`,
                title: lasTekst,
              })
            : null,
          kol === 'ko' && !k.klar ? ikon('laas', 'blokkert') : null,
          skjultTekst ? el('span', { class: 'skjult-for-oyet', tekst: skjultTekst }) : null,
        ),
        kol === 'ko' && skyFilterPa() && k.sky?.egnet ? skyVelg(k) : null,
      ),
      el(
        'p',
        { class: 'kort-tittel' },
        el('button', {
          type: 'button',
          class: 'kort-knapp',
          tabindex: '-1', // rovingOppsett() gjør ett kort per kolonne til tab-stopp
          'aria-describedby': `${metaId} ${fotId}`,
          tekst: k.tittel,
        }),
      ),
      el('p', { class: 'kort-fot', id: fotId }, fotFor(k, kol)),
    );
  }

  // ---- Kortbufferen ----
  // Tavla bygger ikke kortene på nytt når de er like: noden gjenbrukes etter kolonne og oppgave-id, og bare kort som
  // har endret seg bygges (window.KoYtelse.lagKortBuffer, diffen er testet i vitest). Merkingen og søket står utenfor
  // signaturen; de settes på noden hver gang (synkKort), så en merking eller et søk bygger ingen kort.
  const kortBuffer = window.KoYtelse.lagKortBuffer();

  /** Alt kortets DOM avhenger av, unntatt merkingen, søket og kjeden (de settes på noden etterpå). */
  function kortSignatur(k, kol) {
    return JSON.stringify([
      k,
      kol,
      prosjekt(k.prosjekt)?.tittel ?? null,
      visProsjektNavn(),
      kol === 'ko' && skyFilterPa() && k.sky?.egnet ? t.skyValgt.has(k.id) : null,
      // Alderen i teksten (Pågår oppdateres også av klokka, se setInterval nederst).
      k.levert ? alder(k.levert) : null,
      k.ferdig ? alder(k.ferdig) : null,
    ]);
  }

  /** Noden til kortet: gjenbrukt når den er lik, ellers bygget. Merking og søk settes på den her. */
  function kortNode(k, kol) {
    const node = kortBuffer.node(`${kol}|${k.id}`, kortSignatur(k, kol), () => kortEl(k, kol));
    synkKort(node);
    return node;
  }

  /** Setter merkingen og søket på en kortnode som står (ingen ombygging). */
  function synkKort(node) {
    const id = node.dataset.id;
    const x = t.perId.get(id);
    if (x) node.hidden = !sokTreff(x.k);
    if (!node.dataset.merkbar) return;
    const merket = t.merket.has(id);
    node.classList.toggle('merket', merket);
    const boks = node.querySelector('.merk-boks input');
    if (boks && boks.checked !== merket) boks.checked = merket;
  }

  // ---- Sky ----
  const skyFilterPa = () => !!t.filter.valgt.vis?.has('sky');

  /** Avkryssingsboksen på et skyegnet kort (bare med filteret «Egnet for sky»). */
  function skyVelg(k) {
    return el(
      'label',
      { class: 'sky-velg', title: 'Ta med i skybunten' },
      el('input', {
        type: 'checkbox',
        checked: t.skyValgt.has(k.id),
        'aria-label': `Ta med ${k.id} i skybunten`,
        tabindex: '-1', // roving tabindex: bare kortet som er stopp i kolonnen
        onchange: (e) => {
          if (e.target.checked) t.skyValgt.add(k.id);
          else t.skyValgt.delete(k.id);
          tegn();
        },
      }),
      el('span', { tekst: 'Sky' }),
    );
  }

  /** De avkryssede som fortsatt er skyegnet og i kø (et kort kan ha flyttet seg siden). */
  function skyValgte() {
    const ut = [];
    for (const id of t.skyValgt) {
      const x = t.perId.get(id);
      if (x && x.kol === 'ko' && x.k.sky?.egnet) ut.push(id);
      else t.skyValgt.delete(id);
    }
    return ut;
  }

  /** Henter skypakka (én oppgave eller en bunt) via serveren (ko.mjs sky-pakke) og kopierer den. */
  async function kopierSkypakke(ider) {
    try {
      const q = ider.map((x) => `id=${encodeURIComponent(x)}`).join('&');
      const d = await api(`/api/skypakke?${q}`);
      t.skypakke = { ider: [...ider], tekst: d.tekst, kopiert: false };
      try {
        await navigator.clipboard.writeText(d.tekst);
        t.skypakke.kopiert = true;
        melding(
          `Skypakka for ${ider.join(', ')} er kopiert. Lim den inn i en skyøkt, og trykk «Startet i sky».`,
        );
      } catch {
        melding('Fikk ikke kopiert automatisk: merk teksten i feltet og kopier den selv.', true);
      }
    } catch (e) {
      melding(e.message, true);
    }
    tegn();
    if (t.valgt) tegnPanel(true);
  }

  /** Reserven når utklippstavla ikke virker: pakka i et tekstfelt, bare for de samme id-ene. */
  function skypakkeFelt(ider) {
    const p = t.skypakke;
    if (!p || p.kopiert || p.ider.join(' ') !== ider.join(' ')) return null;
    return el(
      'div',
      { class: 'felt sky-pakke-felt' },
      el('label', { for: 'sky-pakke-tekst', tekst: 'Skypakka (merk alt og kopier)' }),
      el('textarea', { id: 'sky-pakke-tekst', rows: 6, readonly: true, tekst: p.tekst }),
    );
  }

  /** Linja over I kø med de avkryssede: kopier pakka for bunten, registrer start, eller tøm valget. */
  function skyBuntLinje() {
    if (!skyFilterPa()) return null;
    const ider = skyValgte();
    if (!ider.length)
      return el('p', {
        class: 'sky-bunt tom',
        tekst: 'Kryss av opptil 4 kort for å sende dem som én skybunt.',
      });
    const sum = ider.reduce((s, id) => s + (t.perId.get(id)?.k.anslag ?? 0), 0);
    return el(
      'div',
      { class: 'sky-bunt' },
      el('span', { tekst: `${ider.length} valgt for sky · ${sum} min` }),
      el('button', {
        type: 'button',
        class: 'knapp knapp-fylt',
        tekst: 'Kopier skypakke',
        onclick: () => kopierSkypakke(ider),
      }),
      el('button', {
        type: 'button',
        class: 'knapp knapp-tonet',
        tekst: 'Startet i sky',
        onclick: async () => {
          if (await handling({ type: 'sky-start', ider }, `${ider.join(', ')} er startet i sky`))
            t.skyValgt.clear();
        },
      }),
      el('button', {
        type: 'button',
        class: 'knapp knapp-kontur',
        tekst: 'Tøm',
        onclick: () => {
          t.skyValgt.clear();
          tegn();
        },
      }),
      skypakkeFelt(ider),
    );
  }

  /** Sky-delen av detaljpanelet: egnethet og skyøkta. */
  function skyFakta(k) {
    if (k.i_sky) {
      const s = k.sky_okt ?? {};
      return [
        `I sky siden ${s.startet ? alder(s.startet) : '?'}`,
        s.kjoring ? ' · ' : null,
        s.kjoring ? skyLenke(s.kjoring) : null,
      ];
    }
    if (k.sky_okt?.ferdig)
      return `Fullført i sky (gren ${k.sky_okt.gren ?? k.gren}); orkestratoren fletter`;
    if (!k.sky) return null;
    return k.sky.egnet
      ? 'Egnet for sky'
      : el('div', null, el('span', { tekst: 'Ikke egnet:' }), liste2(k.sky.grunner));
  }

  /** Økta som lenke når den er en https-adresse, ellers som tekst (aldri en javascript:-lenke fra køen). */
  function skyLenke(kjoring) {
    return /^https:\/\/[^\s]+$/.test(kjoring)
      ? el('a', { href: kjoring, target: '_blank', rel: 'noopener noreferrer', tekst: kjoring })
      : el('code', { tekst: kjoring });
  }

  function liste(kort, kol, seksjon) {
    const ol = el('ol', { class: 'kortliste', 'data-seksjon': seksjon ?? kol });
    for (const k of kort) ol.append(kortNode(k, kol));
    return ol;
  }

  // ---- Tomtilstanden ----
  // Alle tomme lister sier hvorfor de er tomme og har én handling som viser kortene: «Tøm søket», «Fjern filter»
  // eller «Vis alle» (utvalget). Regelen er KoUu.tomGrunn (uu.js, testet i koTavleUu.test.ts).

  /** Teksten og knappen for en tom liste. `sokSkjuler`: lista har kort, men søket skjuler alle. */
  function tomInnhold(tekst, sokSkjuler) {
    const g = window.KoUu.tomGrunn({
      tekst,
      sokSkjuler,
      sok: t.filter.sok,
      filtre: antallFiltre(),
      utvalg: t.visningNavn ?? null,
    });
    const deler = [el('p', { tekst: g.tekst })];
    if (g.handling)
      deler.push(
        el('button', {
          type: 'button',
          class: 'lenke-knapp',
          tekst: g.etikett,
          onclick: (e) => {
            e.stopPropagation();
            tomHandling(g.handling);
          },
        }),
      );
    return deler;
  }

  /** Den felles tomtilstanden som eget element (samlekøen, Prosjektbaner og grafen). */
  function tomTilstand(tekst, sokSkjuler = !!t.filter.sok) {
    return el('div', { class: 'tom tom-tilstand' }, ...tomInnhold(tekst, sokSkjuler));
  }
  // Grafen (graf.js) bruker samme tomtilstand.
  window.KoTom = (tekst) => tomTilstand(tekst);

  /** Handlingen i tomtilstanden. Fokus går til kontrollen som ble endret, så tastaturet ikke mister plassen. */
  function tomHandling(handling) {
    if (handling === 'sok') {
      const sok = $('sok');
      sok.value = '';
      sok.dispatchEvent(new Event('input'));
      sok.focus();
    } else if (handling === 'filter') {
      for (const sett of Object.values(t.filter.valgt)) sett.clear();
      endretFilter();
      $('filter-knapp').focus();
    } else if (handling === 'utvalg') visAlle();
  }

  /** Tomtilstanden for en liste: vises når ingen av kortene passer søket (også når lista er tom fra før). */
  function tomTekst(kort, tekst) {
    const boks = el('div', { class: 'tom tom-tilstand' });
    sokBundet(kort, (treff) => {
      boks.hidden = treff.length > 0;
      if (!boks.hidden) boks.replaceChildren(...tomInnhold(tekst, kort.length > 0));
    });
    return boks;
  }

  /**
   * Innholdet i en kolonne (flat) eller en celle (bane) for kortene som er gitt. Kortene er filtrert, men ikke søkt
   * i: søket skjuler kort, og tellerne og tomtekstene følger søket via sokBundet.
   */
  function kolonneInnhold(kol, kort, forslag, samle) {
    const deler = [];
    if (kol === 'ko') {
      const klare = kort.filter((k) => k.klar);
      const blokkert = kort.filter((k) => !k.klar);
      const tittel = el('h3', { class: 'seksjon-tittel' });
      sokBundet(klare, (treff) => (tittel.textContent = `Klare nå (${treff.length})`));
      deler.push(tittel, tomTekst(klare, 'Ingenting er klart nå.'));
      if (klare.length) deler.push(gruppertListe(klare, 'ko', 'klar'));
      if (blokkert.length)
        deler.push(
          seksjon(
            'blokkert',
            blokkert,
            (n) => `Blokkert (${n})`,
            () => gruppertListe(blokkert, 'ko', 'blokkert'),
          ),
        );
      if (forslag?.length)
        deler.push(
          seksjon(
            'forslag',
            forslag,
            (n) => `Forslag (${n})`,
            () => gruppertListe(forslag, 'forslag'),
          ),
        );
      // Samlekøen for seg, gruppert med sum mot målet; kortene startes ikke alene.
      if (samle?.length)
        deler.push(
          seksjon(
            'samle',
            samle,
            (n) => `Samlekøen (${n})`,
            () => samleInnhold(samle),
          ),
        );
      return deler;
    }
    let vis = kort;
    let skjult = 0;
    if (kol === 'bygget' && !t.visFlere) {
      vis = kort.filter((k) => k.nylig);
      skjult = kort.length - vis.length;
    }
    deler.push(tomTekst(vis, 'Ingenting her.'));
    if (vis.length) deler.push(gruppertListe(vis, kol));
    if (kol === 'bygget' && (skjult || t.visFlere)) {
      const knapp = el('button', {
        type: 'button',
        class: 'knapp knapp-kontur vis-flere',
        tekst: 'Vis bare de siste 7 dagene',
        onclick: () => {
          t.visFlere = !t.visFlere;
          tegn();
        },
      });
      if (!t.visFlere)
        sokBundet(
          kort,
          (treff) => (knapp.textContent = `Vis flere (${treff.filter((k) => !k.nylig).length})`),
        );
      deler.push(knapp);
    }
    return deler;
  }

  /**
   * Samlekøen gruppert (prosjekt → klasse) med sum innholdsminutter mot målet for klassen, en stolpe med
   * nedre mål markert, «Klar til pakking» fra nedre mål, og kortene i gruppa. Gruppene kommer fra serveren
   * (koLogikk.samleGrupper); her vises bare de som har synlige kort etter søk og filter.
   */
  function samleInnhold(kort) {
    // Summene, knappene og «skjult av filteret» følger søket, så samlekøen (som er liten) tegnes
    // på nytt i sin egen boks når søket eller merkingen endres; resten av tavla står.
    const boks = el('div', { class: 'samle-boks' });
    sokBundet(kort, (treff) => boks.replaceChildren(samleGrupper(treff)));
    return boks;
  }

  function samleGrupper(kort) {
    const synlige = new Map(kort.map((k) => [k.id, k]));
    const grupper = (t.data.samlekoen ?? [])
      .map((g) => ({ g, kort: g.oppgaver.map((o) => synlige.get(o.id)).filter(Boolean) }))
      .filter((x) => x.kort.length);
    if (!grupper.length) return tomTilstand('Ingenting her.');
    return el(
      'div',
      { class: 'samle-grupper' },
      grupper.map(({ g, kort: gk }) => {
        const p = prosjekt(g.pid);
        const maks = g.maal?.maks ?? 0;
        const andel = maks ? Math.min(g.sum / maks, 1) : 0;
        const maalTekst = g.maal ? `${g.maal.min}–${g.maal.maks}` : '?';
        const status = g.ugyldig
          ? `${g.klasse} pakkes ikke`
          : g.klar
            ? g.over
              ? 'Klar til pakking (blir flere spor)'
              : 'Klar til pakking'
            : `mangler ${g.maal.min - g.sum} min`;
        return el(
          'section',
          {
            class: `samle-gruppe${g.klar ? ' klar' : ''}`,
            'aria-label': `${p?.tittel ?? g.pid}, klasse ${g.klasse}: ${g.sum} av ${maalTekst} min. ${status}.`,
            '--p': `var(--color-${p?.farge ?? 'kategori-grafitt'})`,
          },
          el(
            'div',
            { class: 'samle-hode' },
            el('span', { class: 'samle-navn', tekst: g.pid, title: p?.tittel ?? g.pid }),
            el('span', {
              class: `merke${g.klasse === 'D+' ? ' klasse-dpluss' : ''}`,
              tekst: g.klasse,
              title: 'Risikoklasse',
            }),
            g.klar && !g.ugyldig
              ? el('span', { class: 'merke klar-merke', tekst: status })
              : el('span', { class: 'samle-mangler', tekst: status }),
          ),
          el(
            'div',
            {
              class: 'samle-stolpe',
              role: 'img',
              'aria-label': `${g.sum} av ${maalTekst} innholdsminutter`,
              title: `Mål for ${g.klasse}: ${maalTekst} min innhold. Klar til pakking fra ${g.maal?.min ?? '?'} min.`,
            },
            el('span', { class: 'samle-fyll', '--andel': String(andel) }),
            g.maal
              ? el('span', {
                  class: 'samle-nedre',
                  '--nedre': String(Math.min(g.maal.min / maks, 1)),
                })
              : null,
          ),
          el('p', {
            class: 'samle-sum',
            tekst:
              `${g.sum} / ${maalTekst} min · ${g.antall} ${g.antall === 1 ? 'oppgave' : 'oppgaver'}` +
              (g.felles_filer.length ? ` · ${g.felles_filer.length} felles fil(er)` : ''),
            title: g.felles_filer.length ? `Felles filer: ${g.felles_filer.join(', ')}` : null,
          }),
          samleKnapper(g, gk),
          liste(gk, 'samle', 'samle'),
        );
      }),
    );
  }

  /**
   * Knappene i en samlegruppe. «Pakk til spor» viser det nye sporet før det lages,
   * «Ta ut av samlekøen» gjør oppgavene til egne spor igjen, og boksen merker gruppa for valglinja. De gjelder kortene
   * som vises (søk og filter); linja sier fra når noen i gruppa er skjult.
   */
  function samleKnapper(g, kort) {
    const ider = kort.map((k) => k.id);
    const skjult = g.antall - ider.length;
    const alleMerket = ider.length > 0 && ider.every((id) => t.merket.has(id));
    const kanPakkes = !g.ugyldig && ider.length >= 2;
    const hvem = skjult
      ? `de ${ider.length} som vises (${skjult} skjult av filteret)`
      : 'hele gruppa';
    return el(
      'div',
      { class: 'samle-knapper' },
      el(
        'label',
        {
          class: 'merk-gruppe',
          title: `Merk ${hvem} for valglinja (massehandlinger)`,
        },
        el('input', {
          type: 'checkbox',
          checked: alleMerket,
          'aria-label': `Merk samlegruppa ${g.pid} ${g.klasse}`,
          onchange: (e) => merkMange(ider, e.target.checked),
        }),
        el('span', { tekst: 'Merk' }),
      ),
      el('button', {
        type: 'button',
        class: 'knapp knapp-tonet knapp-liten',
        tekst: 'Pakk til spor',
        disabled: !kanPakkes,
        title: g.ugyldig
          ? `${g.klasse} pakkes ikke (D+ slås aldri sammen med annet)`
          : ider.length < 2
            ? 'Pakking krever minst to oppgaver. Én oppgave tas ut av samlekøen i stedet.'
            : `Slå sammen ${hvem} til ett nytt spor. Du ser det nye sporet før det lages.`,
        onclick: () => aapneMasse('samle-pakk', ider),
      }),
      el('button', {
        type: 'button',
        class: 'knapp knapp-kontur knapp-liten',
        tekst: 'Ta ut av samlekøen',
        title: `Ta ${hvem} ut av samlekøen, så de startes som egne spor. Du ser endringen før den lagres.`,
        onclick: () => aapneMasse('samle-ut', ider),
      }),
    );
  }

  /**
   * En seksjon som kan lukkes (Blokkert, Forslag, Samlekøen). Innholdet bygges først når
   * seksjonen er åpen (`bygg()`), så en lukket Blokkert koster ingenting. Tittelen (`tittel(antall)`) følger søket,
   * og seksjonen skjules når ingen av kortene passer.
   */
  function seksjon(navn, kort, tittel, bygg) {
    const d = el('details', { class: 'seksjon', 'data-seksjon': navn, open: !t.lukket.has(navn) });
    const sum = el('summary');
    sokBundet(kort, (treff) => {
      sum.textContent = tittel(treff.length);
      d.hidden = !treff.length;
    });
    d.append(sum);
    let bygget = false;
    const fyll = (etterTegning) => {
      if (bygget) return;
      bygget = true;
      d.append(bygg());
      if (!etterTegning) return;
      // Åpnet etter tegningen: søket, kjeden og tab-stoppet settes på de nye kortene.
      brukSok(d);
      merkKjede();
      rovingOppsett();
    };
    if (d.open) fyll(false);
    d.addEventListener('toggle', () => {
      if (d.open) {
        t.lukket.delete(navn);
        fyll(true);
      } else t.lukket.add(navn);
    });
    return d;
  }

  /** Kolonnehodet. `kort` er kortene telleren teller (filtrert, telleren følger søket); null = ingen teller. */
  function kolonneHode(kol, kort) {
    const w = t.data.wip;
    let teller = null;
    if (kort) {
      teller = el('span', { class: 'teller' });
      sokBundet(kort, (treff) => (teller.textContent = String(treff.length)));
    }
    const hode = el(
      'header',
      { class: 'kol-hode' },
      el('h2', { tekst: KOLONNER.find((k) => k.nokkel === kol).navn }),
      teller,
      kol === 'ko' ? skyBuntLinje() : null,
    );
    if (kol === 'pagar') {
      const full = w.agenter >= w.maks;
      hode.append(
        el('span', {
          class: `wip${full ? ' full' : ''}`,
          // Lesbar tekst («Agenter 3 av 4 · tunge 1 av 2»); forklaringen står i tegnforklaringen.
          tekst: window.KoUu.wipTekst(w),
          title:
            'Agentplasser i bruk (kjører og review), med samme regel som ko.mjs. Plukkede oppgaver og arbeid ' +
            'utenfor køen tar ingen agentplass.',
        }),
      );
      // Nattpause (nattkjøring av og inne i nattvinduet): ingen nye starter før vinduet er over.
      if (t.data.natt?.stopp)
        hode.append(
          el('span', {
            class: 'merke gammel',
            tekst: `Nattpause til ${t.data.natt.til}`,
            title: t.data.natt.melding,
          }),
        );
    }
    return hode;
  }

  // ---- Tegning ----
  function tegn() {
    t.ventende = false;
    // Valglinja og «Merk alle treff» følger tilstanden og filteret i alle visninger.
    tegnValglinje();
    tegnMerkTreff();
    const fokus = document.activeElement?.closest?.('[data-id], [data-pid]');
    const fokusNokkel = fokus ? (fokus.dataset.id ?? `bane:${fokus.dataset.pid}`) : null;
    const rulling = new Map(
      [...main.querySelectorAll('[data-rull]')].map((e) => [e.dataset.rull, e.scrollTop]),
    );
    const hovedRull = [main.scrollTop, main.scrollLeft];

    // Skjelettet (kolonner, grupper, baner) bygges på nytt, men kortene hentes fra kortbufferen,
    // så bare kort som er nye eller endret bygges. Søket og merkingen går utenom tegn() (brukSok, oppdaterMerking).
    t.sokAvh = [];
    main.replaceChildren();
    main.className = `tavle ${t.visning}${t.merket.size ? ' har-valg' : ''}`;
    // Søk og filter gjelder kortene, ikke statistikken (og ikke planen, som viser områder og prosjekter).
    $('sok-filter').hidden = ['statistikk', 'sky', 'plan'].includes(t.visning);
    // Grupperingen gjelder Flat og Prosjektbaner.
    $('gruppering').hidden = !['flat', 'baner'].includes(t.visning);
    tegnFokuslinje();
    if (t.visning === 'plan') {
      if (t.data) window.KoPlan.tegn(planKontekst());
      else
        main.append(
          el('p', {
            class: 'tom',
            tekst: t.feil ? `Kunne ikke lese køen: ${t.feil}` : 'Henter køen …',
          }),
        );
      tegnStripe();
      [main.scrollTop, main.scrollLeft] = hovedRull;
      return;
    }
    if (t.visning === 'sky') {
      tegnSkyko();
      tegnStripe();
      [main.scrollTop, main.scrollLeft] = hovedRull;
      return;
    }
    if (t.visning === 'statistikk') {
      tegnStatistikk();
      tegnStripe();
      [main.scrollTop, main.scrollLeft] = hovedRull;
      return;
    }
    if (!t.data) {
      main.append(
        el('p', {
          class: 'tom',
          tekst: t.feil
            ? `Kunne ikke lese køen: ${t.feil}`
            : t.nokkel
              ? 'Henter køen …'
              : 'Mangler nøkkel: åpne lenken ko-tavle skrev i terminalen.',
        }),
      );
      return;
    }
    tegnFilter();
    const k = t.data.kolonner;
    // Filtrene avgjør hva som bygges; søket skjuler etterpå (brukSok). Grafen bruker synlig() med søket selv.
    const filtrert = {};
    for (const kol of ['ko', 'forslag', 'samle', 'pagar', 'review', 'bygget'])
      filtrert[kol] = (k[kol] ?? []).filter((x) => synligUtenSok(x, kol));
    // Grafen har ingen kortnoder: bufferen står urørt der, så kortene er klare når Flat eller baner vises igjen.
    const medKort = t.visning !== 'graf';
    if (medKort) kortBuffer.start();

    if (t.visning === 'graf') {
      // Avhengighetene: graf.js tegner; søket og filtermenyen gjelder her også (synlig).
      window.KoGrafVisning.tegn({
        main,
        data: t.data,
        versjon: t.versjon,
        filterNokkel: JSON.stringify([
          Object.entries(t.filter.valgt).map(([n, sett]) => [n, [...sett].sort()]),
          t.filter.sok,
        ]),
        synlig,
        el,
        aapnePanel,
        aapneInnboks,
        tegnPaaNytt: tegn,
      });
    } else if (t.visning === 'flat') {
      for (const { nokkel } of KOLONNER) {
        const telles =
          nokkel === 'bygget' && !t.visFlere
            ? filtrert.bygget.filter((x) => x.nylig)
            : filtrert[nokkel];
        main.append(
          el(
            'section',
            {
              class: 'kolonne',
              'data-kol': nokkel,
              'aria-label': KOLONNER.find((x) => x.nokkel === nokkel).navn,
            },
            kolonneHode(nokkel, telles),
            el(
              'div',
              { class: 'kol-kropp', 'data-rull': nokkel },
              kolonneInnhold(
                nokkel,
                filtrert[nokkel],
                nokkel === 'ko' ? filtrert.forslag : null,
                nokkel === 'ko' ? filtrert.samle : null,
              ),
            ),
          ),
        );
      }
    } else {
      main.append(
        el(
          'div',
          { class: 'bane-hoder' },
          KOLONNER.map(({ nokkel }) => kolonneHode(nokkel, null)),
        ),
      );
      const ol = el('ol', { class: 'baneliste', 'aria-label': 'Prosjektbaner' });
      // Gruppering «Område → prosjekt» sorterer banene etter område (områdets rekkefølge, uten område
      // sist; ellers bevares banerekkefølgen) og setter inn en overskrift der området skifter.
      const omradeAv = new Map();
      (t.data.omrader ?? []).forEach((o, i) => {
        for (const pid of o.prosjekter ?? []) omradeAv.set(pid, { i, tittel: o.tittel ?? o.oid });
      });
      const medOmrade = t.gruppering === 'omrade';
      const baner = medOmrade
        ? t.data.prosjekter
            .map((p, j) => ({ p, j, o: omradeAv.get(p.pid) ?? { i: 9999, tittel: 'Uten område' } }))
            .sort((a, b) => a.o.i - b.o.i || a.j - b.j)
        : t.data.prosjekter.map((p, j) => ({ p, j, o: null }));
      let forrigeOmrade = null;
      for (const { p, o } of baner) {
        const per = {};
        // Samlekøen vises også i banene (i kø-cella, som i flat visning).
        for (const kol of ['ko', 'samle', 'pagar', 'review', 'bygget'])
          per[kol] = filtrert[kol].filter((x) => x.prosjekt === p.pid);
        const synligeBygget = t.visFlere ? per.bygget : per.bygget.filter((x) => x.nylig);
        const antall =
          per.ko.length +
          per.samle.length +
          per.pagar.length +
          per.review.length +
          synligeBygget.length;
        if (!antall && !t.filter.valgt.prosjekter.has(p.pid)) continue;
        if (medOmrade && o.tittel !== forrigeOmrade) {
          forrigeOmrade = o.tittel;
          ol.append(
            el(
              'li',
              {
                class: 'omrade-overskrift',
                role: 'presentation',
                title: `Området ${o.tittel}: prosjektbanene under hører til det. Endre områder i Plan → «Områder …».`,
              },
              el('h2', { tekst: o.tittel }),
            ),
          );
        }
        ol.append(baneEl(p, per));
      }
      // Tomteksten står alltid; etterSok() viser den når ingen bane er synlig (heller ikke etter søket).
      ol.append(el('li', { class: 'tom bane-tom', tekst: 'Ingen kort med disse filtrene.' }));
      main.append(ol);
    }
    if (medKort) {
      t.sisteTegning = kortBuffer.slutt(); // { gjenbrukt, bygget, fjernet }: til feilsøking
      etterSok();
    }

    for (const [nokkel, topp] of rulling) {
      const e = main.querySelector(`[data-rull="${nokkel}"]`);
      if (e) e.scrollTop = topp;
    }
    [main.scrollTop, main.scrollLeft] = hovedRull;
    if (fokusNokkel) {
      const e = fokusNokkel.startsWith('bane:')
        ? main.querySelector(`.bane[data-pid="${CSS.escape(fokusNokkel.slice(5))}"] > .bane-hode`)
        : main
            .querySelector(`.kort[data-id="${CSS.escape(fokusNokkel)}"]`)
            ?.querySelector('.kort-knapp');
      e?.focus({ preventScroll: true });
    }
    merkKjede();
    tegnStripe();
    if (t.valgt) tegnPanel();
  }

  // ---- Kjeden rundt det valgte kortet: forgjengerne og etterfølgerne utheves, resten dempes ----
  /** Velger kjeden til kortet (klikk eller Enter). Et kort uten kjede nullstiller en tidligere kjede. */
  function velgKjede(id) {
    t.kjede = t.perId.get(id)?.k.kjede ? id : null;
    merkKjede();
    tegnStripe();
  }
  function nullstillKjede() {
    t.kjede = null;
    merkKjede();
    tegnStripe();
  }
  /** Setter klassene på kortene som er tegnet. Kortet er borte (ferdig, fjernet)? Da nullstilles kjeden. */
  function merkKjede() {
    const k = t.kjede ? t.perId.get(t.kjede)?.k : null;
    if (!k?.kjede) t.kjede = null;
    const kj = t.kjede ? k.kjede : { for: [], etter: [] };
    const forSett = new Set(kj.for);
    const etterSett = new Set(kj.etter);
    main.classList.toggle('kjede-aktiv', !!t.kjede);
    for (const e of main.querySelectorAll('.kort')) {
      const id = e.dataset.id;
      e.classList.toggle('kjede-valgt', id === t.kjede);
      e.classList.toggle('kjede-for', forSett.has(id));
      e.classList.toggle('kjede-etter', etterSett.has(id));
    }
    if (t.visning === 'graf') window.KoGrafVisning.merk(t.kjede, t.kjede ? kj : null);
  }

  // ---- Stripa over kolonnene: «Neste opp» og kjeden ----
  const stripe = $('stripe');
  function nesteKnapp(v) {
    return el(
      'button',
      {
        type: 'button',
        class: 'neste-kort',
        title: `${v.id}: ${v.tittel}`,
        onclick: () => aapnePanel(v.id),
      },
      el('span', { class: 'neste-id', tekst: v.id }),
      el('span', { class: 'neste-tittel', tekst: v.tittel }),
    );
  }
  function tegnStripe() {
    stripe.hidden = t.visning === 'statistikk' || !t.data;
    if (stripe.hidden) return;
    const n = t.data.neste;
    const rad = el('div', { class: 'stripe-rad' });
    const navn = (tekst) => el('span', { class: 'stripe-navn', tekst });
    if (!n) rad.append(navn('Neste opp'));
    else if (n.stopp)
      rad.append(
        navn('Neste opp'),
        el('span', { class: 'merke gammel', tekst: n.tekst, title: n.melding ?? n.tekst }),
      );
    else if (n.starter.length)
      rad.append(
        navn(`Neste opp (${n.ledige} ${n.ledige === 1 ? 'ledig plass' : 'ledige plasser'})`),
        ...n.starter.map(nesteKnapp),
      );
    else if (n.naarLedig.length)
      rad.append(navn('Når en plass blir ledig'), ...n.naarLedig.map(nesteKnapp));
    else
      rad.append(
        navn('Neste opp'),
        el('span', {
          class: 'stripe-tom',
          tekst: n.ledige ? 'Ingenting er klart til å starte.' : 'Ingenting venter på en plass.',
        }),
      );
    const deler = [rad];
    const valgt = t.kjede ? t.perId.get(t.kjede)?.k : null;
    if (valgt?.kjede) {
      const ider = [...valgt.kjede.for, ...valgt.kjede.etter];
      const tegnet = new Set(
        [...main.querySelectorAll('.kort:not([hidden]), .graf-svg .node')].map((e) => e.dataset.id),
      );
      const skjult = ider.filter((id) => !tegnet.has(id)).length;
      deler.push(
        el(
          'div',
          { class: 'stripe-rad kjede-linje', role: 'status' },
          el('span', {
            class: 'stripe-navn',
            tekst:
              `Kjede for ${valgt.id}: ${valgt.kjede.for.length} før, ${valgt.kjede.etter.length} etter` +
              (skjult ? ` · ${skjult} skjult av filteret` : '') +
              ' · Esc nullstiller',
          }),
          el('span', { class: 'tegn-kjede kjede-for-tegn', 'aria-hidden': 'true' }),
          el('span', { class: 'kjede-forklaring', tekst: 'før' }),
          el('span', { class: 'tegn-kjede kjede-etter-tegn', 'aria-hidden': 'true' }),
          el('span', { class: 'kjede-forklaring', tekst: 'etter' }),
          el('button', {
            type: 'button',
            class: 'lenke-knapp',
            tekst: 'Nullstill',
            onclick: nullstillKjede,
          }),
        ),
      );
    }
    stripe.replaceChildren(...deler);
  }

  // ---- Planvisningen (plan.js), fokuslinja, gruppering, lagrede visninger og hjelpen ----
  /** Det plan.js trenger fra tavla (samme hjelpere og samme skrivevei). */
  function planKontekst() {
    return {
      main,
      data: t.data,
      el,
      ikon,
      api,
      melding,
      meldingMedInfo,
      oppdater: (tving) => oppdater(tving),
      tegnPaaNytt: tegn,
      status: (tekst) => ($('status').textContent = tekst),
      ventende: () => t.ventende,
    };
  }

  /** Fokuslinja øverst: trinnene, resten, klare i fokus, dratt med, og varselet når fokus ikke har noe klart. */
  const fokuslinje = $('fokuslinje');
  function tegnFokuslinje() {
    if (!t.data) {
      fokuslinje.hidden = true;
      return;
    }
    fokuslinje.hidden = false;
    const f = t.data.fokus;
    const tilPlan = (tekst, tittel) =>
      el('button', {
        type: 'button',
        class: 'knapp knapp-kontur knapp-liten',
        tekst,
        title: tittel,
        onclick: () => {
          settVisning('plan');
          tegn();
        },
      });
    const utkast = window.KoPlan?.harUtkast()
      ? el('span', {
          class: 'merke gammel',
          tekst: 'ulagret utkast',
          title:
            'Fokusvisningen har endringer som ikke er lagret. Åpne Fokus og trykk «Lagre fokus» eller «Forkast».',
        })
      : null;
    if (!f) {
      fokuslinje.className = 'fokuslinje';
      fokuslinje.replaceChildren(
        el(
          'div',
          { class: 'fokus-rad' },
          el('span', { class: 'stripe-navn', tekst: 'Fokus' }),
          el('span', {
            class: 'fokus-tekst',
            tekst: 'Ingen fokus: køen går etter poeng og prosjekttillegg.',
            title:
              'Med fokus bestemmer du rekkefølgen: «Auth først, så Betaling» gjør at alt i Auth startes før noe i Betaling, ' +
              'uansett poeng.',
          }),
          utkast,
          tilPlan('Sett fokus', 'Åpne Fokus og dra områder eller prosjekter til Nå og Neste.'),
        ),
      );
      return;
    }
    const varsel = f.varsel ?? null;
    fokuslinje.className = `fokuslinje${varsel ? ' varsel' : ''}`;
    const trinn = (f.trinn ?? []).flatMap((x, i) => [
      i ? el('span', { class: 'fokus-pil', 'aria-hidden': 'true', tekst: '→' }) : null,
      el('span', {
        class: `fokus-trinn${i < f.naa_antall ? ' naa' : ''}`,
        tekst: `${i + 1} ${x.tittel}`,
        title:
          `Trinn ${i + 1} (${i < f.naa_antall ? 'Nå' : 'Neste'}): ${x.tittel}, ${x.type}. ` +
          `${x.venter} venter, ${x.klare} klare, ${varighet(x.min_igjen)} igjen.`,
      }),
    ]);
    const tall = [
      el('span', {
        tekst: f.resten === 'fyll' ? 'resten fyller ledige plasser' : 'resten venter',
        title:
          f.resten === 'fyll'
            ? 'Oppgaver utenfor trinnene startes bare når fokuset ikke har noe klart.'
            : 'Oppgaver utenfor trinnene startes ikke før fokuset endres (plasser kan stå tomme).',
      }),
      f.aktiv
        ? el('span', {
            tekst: `${f.klare} klare i fokus`,
            title: 'Ventende oppgaver i trinnene som kan startes nå (uten hindringer).',
          })
        : null,
      f.aktiv && f.dratt_med
        ? el('span', {
            tekst: `${f.dratt_med} dratt med`,
            title:
              'Oppgaver utenfor trinnene som noe i fokus venter på. De får fokusoppgavens trinn.',
          })
        : null,
      f.til
        ? el('span', {
            tekst: `til ${String(f.til).slice(0, 10)}`,
            title: 'Fokusperioden gjelder til og med denne dagen.',
          })
        : null,
      f.utlopt ? el('span', { class: 'merke gammel', tekst: 'utløpt' }) : null,
      f.ikke_startet ? el('span', { class: 'merke', tekst: 'ikke startet' }) : null,
    ].filter(Boolean);
    // DOM-ens replaceChildren gjør null om til teksten «null», så varsel-raden tas bare med når den finnes.
    fokuslinje.replaceChildren(
      ...[
        el(
          'div',
          { class: 'fokus-rad' },
          el('span', { class: 'stripe-navn', tekst: f.navn ? `Fokus «${f.navn}»` : 'Fokus' }),
          el('span', { class: 'fokus-trinnliste' }, trinn),
          el('span', { class: 'fokus-tall' }, tall),
          utkast,
          tilPlan(
            'Endre fokus',
            'Åpne Fokus: dra områder og prosjekter mellom Nå, Neste, Senere og Venter.',
          ),
        ),
        varsel ? el('p', { class: 'fokus-varsel', role: 'status', tekst: varsel }) : null,
      ].filter(Boolean),
    );
  }

  // Gruppering i Flat og Prosjektbaner. Lukkede grupper huskes i nettleseren.
  const GRUPPERINGER = {
    ingen: 'Ingen gruppering',
    omrade: 'Område → prosjekt',
    funksjon: 'Prosjekt → funksjon',
    trinn: 'Fokustrinn',
  };
  const lagretGruppering = localStorage.getItem('ko-tavle-gruppering');
  t.gruppering = Object.hasOwn(GRUPPERINGER, lagretGruppering ?? '') ? lagretGruppering : 'ingen';
  t.lukkedeGrupper = new Set(lesListe('ko-tavle-lukkede-grupper'));

  /** En liste med korte tekster fra localStorage (tom ved feil). */
  function lesListe(nokkel) {
    try {
      const x = JSON.parse(localStorage.getItem(nokkel) ?? '[]');
      return Array.isArray(x) ? x.filter((v) => typeof v === 'string' && v.length <= 200) : [];
    } catch {
      return [];
    }
  }
  function lagreLokalt(nokkel, verdi) {
    try {
      localStorage.setItem(nokkel, JSON.stringify(verdi));
    } catch {
      /* privat modus eller full lagring: gjelder bare denne økta */
    }
  }

  /** Gruppen et kort hører til i valgt gruppering: { nokkel, tittel, orden }. */
  function gruppeFor(k, g) {
    const prosjekter = t.data.prosjekter ?? [];
    const pIndeks = Math.max(
      0,
      prosjekter.findIndex((p) => p.pid === k.prosjekt),
    );
    if (g === 'omrade') {
      const omrader = t.data.omrader ?? [];
      const oi = omrader.findIndex((o) => o.oid === k.omrade);
      const o = omrader[oi];
      const navn = o?.tittel ?? (k.omrade === 'uten-omrade' ? 'Uten område' : k.omrade);
      return {
        nokkel: `o:${k.omrade}/${k.prosjekt}`,
        tittel: `${navn} › ${k.prosjekt}`,
        orden: [oi < 0 ? 9999 : oi, pIndeks, ''],
      };
    }
    if (g === 'funksjon')
      return {
        nokkel: `f:${k.prosjekt}/${k.funksjon ?? ''}`,
        tittel: `${k.prosjekt} › ${k.funksjon ?? '(uten funksjon)'}`,
        orden: [pIndeks, k.funksjon ? 0 : 1, k.funksjon ?? ''],
      };
    // Fokustrinn: trinnene i rekkefølge, så dratt med i trinnet, utenfor fokus, og på vent sist.
    const pl = k.plass;
    const f = t.data.fokus;
    if (!pl) return { nokkel: 't:annet', tittel: 'Ikke i kø', orden: [9998, 0, ''] };
    if (k.parkert) return { nokkel: 't:vent', tittel: 'På vent', orden: [9997, 0, ''] };
    if (!f?.aktiv) return { nokkel: 't:ingen', tittel: 'Ingen fokus', orden: [0, 0, ''] };
    if (pl.steg == null)
      return { nokkel: 't:utenfor', tittel: 'Utenfor fokus', orden: [9990, 0, ''] };
    return {
      nokkel: `t:${pl.steg}`,
      tittel: `T${pl.steg + 1} ${f.trinn?.[pl.steg]?.tittel ?? ''}`,
      orden: [pl.steg, 0, ''],
    };
  }
  const sammenlignOrden = (a, b) =>
    a.orden[0] - b.orden[0] ||
    a.orden[1] - b.orden[1] ||
    a.orden[2].localeCompare(b.orden[2], 'nb');

  /** Som liste(), men gruppert etter valgt gruppering (hver gruppe kan lukkes og merkes samlet). */
  function gruppertListe(kort, kol, seksjon) {
    const g = t.gruppering;
    // Fokustrinn finnes bare for kort i kø (i Pågår, Review og Bygget ville alt havnet i «Ikke i kø»).
    if (
      g === 'ingen' ||
      (t.visning === 'baner' && g === 'omrade') ||
      (g === 'trinn' && !MERKBARE_KOLONNER.has(kol)) ||
      !kort.length
    )
      return liste(kort, kol, seksjon);
    const grupper = new Map();
    for (const k of kort) {
      const x = gruppeFor(k, g);
      if (!grupper.has(x.nokkel)) grupper.set(x.nokkel, { ...x, kort: [] });
      grupper.get(x.nokkel).kort.push(k);
    }
    return el(
      'div',
      { class: 'grupper' },
      [...grupper.values()].sort(sammenlignOrden).map((gr) => {
        const lagret = `${seksjon ?? kol}|${gr.nokkel}`;
        // Id-ene, telleren og boksen følger søket og merkingen (sokBundet nederst).
        let ider = [];
        const d = el('details', { class: 'gruppe', open: !t.lukkedeGrupper.has(lagret) });
        d.addEventListener('toggle', () => {
          if (d.open) t.lukkedeGrupper.delete(lagret);
          else t.lukkedeGrupper.add(lagret);
          lagreLokalt('ko-tavle-lukkede-grupper', [...t.lukkedeGrupper].slice(-300));
          rovingOppsett(); // kortene i en lukket gruppe kan ikke være tab-stopp
        });
        const sum = el('summary', { class: 'gruppe-hode' });
        const boks = MERKBARE_KOLONNER.has(kol)
          ? el('input', {
              type: 'checkbox',
              class: 'merk-gruppe-boks',
              'aria-label': `Merk hele gruppen ${gr.tittel}`,
              onclick: (e) => e.stopPropagation(),
              onchange: (e) => merkMange(ider, e.target.checked),
            })
          : null;
        const teller = el('span', { class: 'teller' });
        sum.append(
          ...[boks, el('span', { class: 'gruppe-navn', tekst: gr.tittel }), teller].filter(Boolean),
        );
        d.append(sum, liste(gr.kort, kol, seksjon));
        sokBundet(gr.kort, (treff) => {
          ider = treff.map((k) => k.id);
          d.hidden = !treff.length;
          sum.title = `${gr.tittel}: ${ider.length} kort. Klikk for å lukke eller åpne.`;
          teller.textContent = `${ider.length} · ${varighet(treff.reduce((s2, k) => s2 + (Number(k.anslag) || 0), 0))}`;
          if (boks) {
            boks.checked = ider.length > 0 && ider.every((id) => t.merket.has(id));
            boks.title = `Merk alle ${ider.length} kort i gruppen for valglinja (massehandlinger)`;
          }
        });
        return d;
      }),
    );
  }

  const grupperingValg = $('gruppering');
  grupperingValg.replaceChildren(
    ...Object.entries(GRUPPERINGER).map(([verdi, tekst]) =>
      el('option', { value: verdi, tekst, selected: verdi === t.gruppering }),
    ),
  );
  grupperingValg.addEventListener('change', () => {
    t.gruppering = grupperingValg.value;
    localStorage.setItem('ko-tavle-gruppering', t.gruppering);
    tegn();
  });

  // Lagrede og innebygde visninger: i nettleseren (localStorage) først.
  const VISNINGER_LAGRING = 'ko-tavle-visninger';
  const SIST_BESOK = 'ko-tavle-sist-besok';
  t.sistBesok = Date.parse(localStorage.getItem(SIST_BESOK) ?? '') || null;
  const huskBesok = () => {
    try {
      localStorage.setItem(SIST_BESOK, new Date().toISOString());
    } catch {
      /* ingen lagring */
    }
  };
  window.addEventListener('pagehide', huskBesok);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) huskBesok();
  });

  /** De innebygde visningene (kan ikke slettes). `spesial` er et filter på kortene i kø, forslag og samlekøen. */
  const INNEBYGDE = [
    {
      navn: 'Fokus nå',
      spesial: 'fokus1',
      tittel: 'Bare oppgavene i det første fokustrinnet, klare først.',
    },
    {
      navn: 'Klart i fokus',
      spesial: 'klartFokus',
      tittel: 'Klare oppgaver i fokustrinnene, også de som er dratt med.',
    },
    {
      navn: 'Utenfor fokus, klart',
      spesial: 'utenforKlart',
      tittel: 'Oppgaver som bare stoppes av fokuset: de kan startes om du gir dem et trinn.',
    },
    { navn: 'På vent', spesial: 'paaVent', tittel: 'Oppgaver som er satt på vent.' },
    {
      navn: 'Sorter',
      spesial: 'sorter',
      tittel:
        'Oppgaver uten prosjekt, med usikkert forslag, eller der prosjektet strider mot filene og planen de kommer fra.',
    },
    {
      navn: 'Nytt siden sist',
      spesial: 'nytt',
      tittel: 'Oppgaver lagt til etter forrige gang tavla var åpen i denne nettleseren.',
    },
    { navn: 'Venter på meg', innboks: true, tittel: 'Åpner «Venter på deg».' },
  ];
  const SPESIAL = {
    fokus1: (k) => k.plass?.steg === 0,
    klartFokus: (k) => k.klar && k.plass?.steg != null,
    utenforKlart: (k) =>
      !!k.plass?.utenfor && !k.parkert && k.hindringer.every((h) => h === k.plass.grunn),
    paaVent: (k) => !!k.parkert,
    sorter: (k) => (t.data?.innboks?.sorter ?? []).some((r) => r.id === k.id),
    nytt: (k) => !!t.sistBesok && !!k.lagt_til && Date.parse(k.lagt_til) > t.sistBesok,
  };
  t.spesial = null;
  t.visningNavn = null;

  function egneVisninger() {
    try {
      const x = JSON.parse(localStorage.getItem(VISNINGER_LAGRING) ?? '[]');
      return Array.isArray(x)
        ? x.filter((v) => v && typeof v.navn === 'string' && v.navn.length <= 60).slice(0, 30)
        : [];
    } catch {
      return [];
    }
  }

  function brukVisning(v) {
    lukkVisninger(false);
    if (v.innboks) return aapneInnboks();
    t.spesial = v.spesial && SPESIAL[v.spesial] ? v.spesial : null;
    t.visningNavn = v.navn;
    // Egne visninger tar med søk, filter, gruppering og visning; de innebygde nullstiller søk og filter.
    t.filter.sok = typeof v.sok === 'string' ? v.sok.slice(0, 100) : '';
    $('sok').value = t.filter.sok;
    for (const [n, sett] of Object.entries(t.filter.valgt)) {
      sett.clear();
      for (const x of v.filter?.[n] ?? []) if (typeof x === 'string') sett.add(x);
    }
    lagreFilter();
    if (v.gruppering && Object.hasOwn(GRUPPERINGER, v.gruppering)) {
      t.gruppering = v.gruppering;
      grupperingValg.value = v.gruppering;
      localStorage.setItem('ko-tavle-gruppering', v.gruppering);
    }
    const vis = VISNINGER.includes(v.visning) ? v.visning : null;
    if (vis && ['flat', 'baner', 'graf'].includes(vis)) settVisning(vis);
    else if (!['flat', 'baner', 'graf'].includes(t.visning)) settVisning('flat');
    tegnVisningKnapp();
    tegn();
  }

  function lagreVisning(navn) {
    const n = navn.trim().slice(0, 60);
    if (!n) return melding('Skriv et navn på utvalget.', true);
    if (INNEBYGDE.some((v) => v.navn === n))
      return melding(`«${n}» er et innebygd utvalg. Velg et annet navn.`, true);
    const ny = {
      navn: n,
      visning: t.visning,
      sok: t.filter.sok,
      filter: Object.fromEntries(Object.entries(t.filter.valgt).map(([k, sett]) => [k, [...sett]])),
      gruppering: t.gruppering,
      spesial: t.spesial,
    };
    const liste = egneVisninger().filter((v) => v.navn !== n);
    lagreLokalt(VISNINGER_LAGRING, [...liste, ny].slice(-30));
    t.visningNavn = n;
    melding(`Utvalget «${n}» er lagret i denne nettleseren.`);
    tegnVisningKnapp();
    tegnVisningMeny();
  }

  const visningKnapp = $('visninger');
  const visningMeny = $('visninger-meny');
  function tegnVisningKnapp() {
    const navn = t.visningNavn;
    // De lagrede filtrene heter «Utvalg», så de ikke forveksles med fanene «Visning». «Vis alle»
    // står øverst i Utvalg-menyen når et utvalg er i bruk.
    visningKnapp.textContent = navn ? `Utvalg: ${navn}` : 'Utvalg';
    visningKnapp.classList.toggle('aktiv', !!t.spesial || !!navn);
    visningKnapp.setAttribute(
      'aria-label',
      navn ? `Utvalg, valgt: ${navn}` : 'Utvalg: lagrede og innebygde',
    );
  }
  /** Fjerner utvalget og viser alle kortene igjen (søk og filter står som de er). */
  function visAlle() {
    lukkVisninger(true);
    t.spesial = null;
    t.visningNavn = null;
    tegnVisningKnapp();
    tegn();
  }
  function tegnVisningMeny() {
    const egne = egneVisninger();
    const rad = (v, slett) =>
      el(
        'li',
        { class: 'filter-rad' },
        el('button', {
          type: 'button',
          class: 'lenke-knapp visning-valg',
          tekst: v.navn,
          title: v.tittel ?? 'Ditt lagrede utvalg: søk, filter, gruppering og visning.',
          'aria-current': t.visningNavn === v.navn ? 'true' : null,
          onclick: () => brukVisning(v),
        }),
        slett
          ? el('button', {
              type: 'button',
              class: 'pause-knapp',
              tekst: 'Slett',
              title: `Slett utvalget «${v.navn}» fra denne nettleseren. Køen endres ikke.`,
              onclick: () => {
                lagreLokalt(
                  VISNINGER_LAGRING,
                  egneVisninger().filter((x) => x.navn !== v.navn),
                );
                if (t.visningNavn === v.navn) t.visningNavn = null;
                tegnVisningKnapp();
                tegnVisningMeny();
              },
            })
          : null,
      );
    const navnFelt = el('input', {
      id: 'visning-navn',
      type: 'text',
      maxlength: 60,
      placeholder: 'Navn på utvalget',
      'aria-label': 'Navn på utvalget',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          lagreVisning(e.target.value);
        }
      },
    });
    const iBruk = !!t.spesial || !!t.visningNavn;
    visningMeny.replaceChildren(
      // replaceChildren() gjør null om til teksten «null», så knappen legges bare til når et utvalg er i bruk.
      ...(iBruk
        ? [
            el(
              'div',
              { class: 'filter-fot vis-alle' },
              el('button', {
                type: 'button',
                class: 'knapp knapp-kontur knapp-liten',
                tekst: 'Vis alle',
                title: 'Fjern utvalget og vis alle kort igjen',
                onclick: visAlle,
              }),
            ),
          ]
        : []),
      el(
        'section',
        { class: 'filter-seksjon' },
        el('div', { class: 'filter-seksjon-hode' }, el('h3', { tekst: 'Innebygde' })),
        el(
          'ul',
          { class: 'filter-liste' },
          INNEBYGDE.map((v) => rad(v, false)),
        ),
      ),
      el(
        'section',
        { class: 'filter-seksjon' },
        el('div', { class: 'filter-seksjon-hode' }, el('h3', { tekst: 'Dine' })),
        egne.length
          ? el(
              'ul',
              { class: 'filter-liste' },
              egne.map((v) => rad(v, true)),
            )
          : el('p', { class: 'tom', tekst: 'Ingen lagrede utvalg ennå.' }),
      ),
      el(
        'div',
        { class: 'filter-fot visning-lagre' },
        navnFelt,
        el('button', {
          type: 'button',
          class: 'knapp knapp-kontur knapp-liten',
          tekst: 'Lagre nåværende',
          title:
            'Lagrer søket, filteret, grupperingen og visningen du ser nå under navnet, i denne nettleseren. Køen endres ikke.',
          onclick: () => lagreVisning(navnFelt.value),
        }),
      ),
    );
  }
  function aapneVisninger() {
    lukkFilter(false);
    visningMeny.hidden = false;
    visningKnapp.setAttribute('aria-expanded', 'true');
    tegnVisningMeny();
    visningMeny.querySelector('button')?.focus();
  }
  function lukkVisninger(fokuser) {
    if (visningMeny.hidden) return;
    visningMeny.hidden = true;
    visningKnapp.setAttribute('aria-expanded', 'false');
    if (fokuser) visningKnapp.focus();
  }
  visningKnapp.addEventListener('click', () =>
    visningMeny.hidden ? aapneVisninger() : lukkVisninger(true),
  );
  visningMeny.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      lukkVisninger(true);
    }
  });
  document.addEventListener('click', (e) => {
    if (visningMeny.hidden) return;
    const sti = e.composedPath();
    if (!sti.includes(visningMeny) && !sti.includes(visningKnapp)) lukkVisninger(false);
  });

  // «Slik bruker du panelet» (?-knappen): kort hjelp i sidepanelet.
  const HJELP = [
    [
      'Områder',
      'Et område (programdel) samler prosjektene som hører sammen, for eksempel Auth eller Betaling og fakturering. ' +
        'Du prioriterer områder i stedet for mange prosjekter. Lag og endre dem i Plan → «Områder …». Et prosjekt ' +
        'hører til ett område.',
    ],
    [
      'Fokus',
      'Fokuset er rekkefølgen køen tar arbeid i: alt i trinn 1 før trinn 2, uansett poeng. Innen et trinn gjelder ' +
        'poengene. Et trinn er et område, et prosjekt eller en funksjon. Det mest spesifikke vinner: et prosjekt med ' +
        'eget trinn går foran området sitt. «Resten venter» betyr at ingenting utenfor trinnene startes; «fyll ' +
        'ledige plasser» starter dem bare når fokuset ikke har noe klart. Oppgaver som noe i fokus venter på, dras ' +
        'med. Fokus gjelder til du endrer det, eller til sluttdatoen. Fokuslinja øverst blir rød når fokuset ikke ' +
        'har noe klart, og sier hvilket svar som låser opp mest.',
    ],
    [
      'Fokus',
      'Fokus viser fokuset som fire kolonner: Nå og Neste (trinnene i rekkefølge), Senere (resten) og Venter ' +
        '(prosjekter på pause). Dra områder, prosjekter og funksjoner mellom kolonnene, eller løft med mellomrom, ' +
        'flytt med piltastene og slipp med mellomrom (Esc avbryter). Endringene er et utkast til du trykker «Lagre ' +
        'fokus»; da ser du først hva som endres og hva køen starter etterpå.',
    ],
    [
      'Planer og Kø',
      'Bryteren øverst til venstre bytter arbeidsrom. Planer viser planregisteret: filtre med antall til venstre, ' +
        'modul › prosjekt › post i midten (klikk for å folde) og detaljene til høyre. Kopier-knappene gir startlinjen ' +
        'til /planer. Et merke som PL-ALENE-1 på et kort åpner posten i Planer; fanen Kø i Planer viser kortet her.',
    ],
    [
      'Venter på deg',
      'Eierspørsmål, QA, forslag og det som henger. Med fokus er spørsmålene sortert etter hva svaret låser opp i ' +
        'fokus (trinn 1 først). «Sorter» viser oppgaver uten prosjekt eller med feil prosjekt, med forslag du kan ' +
        'godta.',
    ],
    [
      'Samlekøen',
      'Små oppgaver som ikke blokkerer noe, kan legges i samlekøen. Der startes de ikke alene, men pakkes sammen til ' +
        'ett spor av riktig størrelse («Pakk til spor» når gruppa er stor nok). D+, oppgaver andre venter på og ' +
        'oppgaver med åpne eierspørsmål kan ikke ligge der.',
    ],
    [
      'Massehandlinger',
      'Merk kort med avkryssingsboksen, x på kortet, Ctrl/Cmd-klikk eller Shift-klikk, Ctrl/Cmd+A eller «Merk alle ' +
        'treff». Gruppehodet merker hele gruppen. Valglinja nederst flytter til prosjekt, setter på vent, flytter som ' +
        'blokk, legger i samlekøen eller setter etikett. Du ser alltid hva som endres før det lagres, alt skjer ' +
        'samlet eller ikke i det hele tatt, og «Angre» ligger klar etterpå. Esc tømmer valget.',
    ],
    [
      'Utvalg, faner og gruppering',
      '«Utvalg» har innebygde utvalg (Fokus nå, Klart i fokus, På vent, Sorter, Nytt siden sist …) og dine egne ' +
        '(søk, filter, gruppering og visning), lagret i denne nettleseren. «Vis alle» øverst i menyen fjerner ' +
        'utvalget. Fanene (Flat, Prosjektbaner, Plan …) er visningene; piltastene går mellom dem, Enter velger. ' +
        'Grupperingen ved siden av fanene ' +
        'deler kortene etter område og prosjekt, prosjekt og funksjon, eller fokustrinn.',
    ],
    [
      'Tastaturet på tavla',
      'Tab går til én kortittel per kolonne (eller per celle i Prosjektbaner). Pil opp og ned går mellom kortene, ' +
        'pil venstre og høyre til nabokolonnen, Home og End til første og siste kort. Enter åpner kortet, x merker ' +
        'det, og mellomrom løfter et kort i kø (piltastene flytter, mellomrom slipper, Esc avbryter). «Blokkert» er ' +
        'lukket fra start; åpne den for å se kortene der.',
    ],
  ];

  // Tegnforklaringen for klassene, WIP og merkene på kortene. Står i hjelpen og i statistikkfanen,
  // fordi verktøytipsene ikke virker på berøring eller med tastatur.
  const MERKER = [
    ['merke klar-merke', 'Klar nå', 'Kan startes nå: ingen hindringer.'],
    ['merke', '45 min', 'Anslått innhold i minutter.'],
    ['merke visuell', 'visuell', 'Eieren gjør visuell kontroll etter levering.'],
    ['merke vent-merke', 'på vent', 'Parkert til en dato eller hendelse.'],
    ['merke laaser', 'låser opp 3', 'Så mange oppgaver venter på denne via kjeden.'],
    ['merke sky-merke', 'Sky', 'Kjører i en skyøkt.'],
    ['merke gammel', 'gammel', 'Plukket eller registrert utenfor køen for over 72 timer siden.'],
    ['merke qa', 'Venter på QA', 'Bygget, men eieren har ikke sett over.'],
    ['merke avvik', 'QA-avvik', 'Eieren fant noe ved kontrollen.'],
  ];
  function tegnforklaring(idPrefiks) {
    const rad = (merke, tekst) =>
      el('div', { class: 'forklaring-rad' }, el('dt', null, merke), el('dd', { tekst }));
    return el(
      'section',
      { class: 'tegnforklaring', 'aria-labelledby': `${idPrefiks}-tegn` },
      el('h3', { id: `${idPrefiks}-tegn`, class: 'innst-tittel', tekst: 'Tegnforklaring' }),
      el('h4', { class: 'forklaring-tittel', tekst: 'Risikoklasser' }),
      el(
        'dl',
        { class: 'forklaring' },
        window.KoUu.KLASSER.map((k) =>
          rad(
            el('span', {
              class: `merke${k.klasse === 'D+' ? ' klasse-dpluss' : ''}`,
              tekst: k.klasse,
            }),
            `${k.navn[0].toUpperCase()}${k.navn.slice(1)}. ${k.forklaring}`,
          ),
        ),
      ),
      el('h4', { class: 'forklaring-tittel', tekst: 'Plasser i Pågår' }),
      el(
        'dl',
        { class: 'forklaring' },
        rad(
          el('span', {
            class: 'wip',
            tekst: window.KoUu.wipTekst({ agenter: 3, maks: 4, dPluss: 1, maksDPluss: 2 }),
          }),
          'Agenter: plassene i bruk (kjører og review) av høyst så mange samtidig. Tunge: D+-oppgaver av høyst ' +
            'så mange samtidig. Plukkede oppgaver og arbeid utenfor køen tar ingen plass. Rød når alt er fullt.',
        ),
      ),
      el('h4', { class: 'forklaring-tittel', tekst: 'Merker på kortene' }),
      el(
        'dl',
        { class: 'forklaring' },
        MERKER.map(([klasse, tekst, forklaring]) =>
          rad(el('span', { class: klasse, tekst }), forklaring),
        ),
        rad(
          el('span', { class: 'kort-prosjekt', tekst: 'prosjekt' }),
          'Prosjektets kortnavn; fargestripa til venstre på kortet er prosjektets farge. Vises ikke når kortene ' +
            'allerede er gruppert per prosjekt.',
        ),
        rad(
          el('span', { class: 'forklaring-kant', tekst: 'stiplet kant' }),
          'Blokkert: venter på noe (hindringen står nederst på kortet). Hel kant i primærfarge: klar nå.',
        ),
      ),
    );
  }

  function aapneHjelp() {
    t.valgt = null;
    t.innst = null;
    t.innboks = false;
    t.hjelp = true;
    visPanel();
    panel.scrollTop = 0;
    panel.replaceChildren(
      el(
        'div',
        { class: 'panel-hode' },
        el('div', null, el('h2', { id: 'panel-tittel', tekst: 'Slik bruker du panelet' })),
        el(
          'button',
          { type: 'button', class: 'knapp-ikon', 'aria-label': 'Lukk', onclick: lukkPanel },
          ikon('lukk'),
        ),
      ),
      ...HJELP.map(([tittel, tekst]) =>
        el(
          'section',
          { class: 'hjelp-del' },
          el('h3', { class: 'innst-tittel', tekst: tittel }),
          el('p', { class: 'hjelp-tekst', tekst }),
        ),
      ),
      tegnforklaring('hjelp'),
      el('p', {
        class: 'innboks-info',
        tekst:
          'Alt panelet skriver, går via ko.mjs med lås, og ingenting endres før du har sett forklaringen og bekreftet.',
      }),
    );
    panel.querySelector('.knapp-ikon')?.focus();
  }
  // Hjelpen åpnes fra tannhjulet (knappen øverst i innstillingene), ikke lenger fra «?» i toppen.

  function baneEl(p, per) {
    // Tallene i banehodet og om banen vises, følger søket (sokBundet nederst).
    const tallEl = el('span', { class: 'tall' });
    const synligeBygget = t.visFlere ? per.bygget : per.bygget.filter((x) => x.nylig);
    const alleKort = [...per.ko, ...per.samle, ...per.pagar, ...per.review, ...synligeBygget];
    const hode = el(
      'header',
      {
        class: 'bane-hode',
        tabindex: p.flyttbar ? 0 : null,
        draggable: p.flyttbar ? 'true' : null,
        'aria-label': p.flyttbar
          ? `Prosjekt ${p.tittel ?? p.pid}. Mellomrom løfter banen, piltastene flytter den.`
          : null,
      },
      p.flyttbar ? ikon('handtak') : null,
      el('span', { class: 'prikk', '--p': `var(--color-${p.farge})` }),
      el('h2', { tekst: p.tittel ?? p.pid }),
      el('span', { class: 'pid', tekst: p.pid }),
      p.pause ? el('span', { class: 'merke gammel', tekst: 'pauset' }) : null,
      p.prioritet_tillegg
        ? el('span', {
            class: 'merke',
            tekst: `${p.prioritet_tillegg > 0 ? '+' : ''}${p.prioritet_tillegg}`,
            title: 'Prosjektets tillegg til prioriteten',
          })
        : null,
      tallEl,
      merkBaneKnapp(p, per),
      p.flyttbar ? pauseKnapp(p) : null,
    );
    const rad = el(
      'div',
      { class: 'bane-rad' },
      ['ko', 'pagar', 'review', 'bygget'].map((kol) =>
        el(
          'div',
          { class: 'bane-celle', 'data-kol': kol },
          kolonneInnhold(kol, per[kol], null, kol === 'ko' ? per.samle : null),
        ),
      ),
    );
    const bane = el(
      'li',
      { class: 'bane', 'data-pid': p.pid, 'data-flyttbar': p.flyttbar ? '1' : null },
      hode,
      rad,
    );
    sokBundet(alleKort, (treff) => {
      const ider = new Set(treff.map((k) => k.id));
      const n = (liste) => liste.filter((k) => ider.has(k.id)).length;
      tallEl.textContent = [
        n(per.ko) ? `${n(per.ko)} i kø` : null,
        n(per.samle) ? `${n(per.samle)} i samlekøen` : null,
        n(per.pagar) ? `${n(per.pagar)} pågår` : null,
        n(per.review) ? `${n(per.review)} i review` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      // En bane som er valgt i Prosjekter-filteret vises også tom (som før).
      bane.hidden = !treff.length && !t.filter.valgt.prosjekter.has(p.pid);
    });
    return bane;
  }

  /** «Merk» i banehodet merker kortene i banen som kan masseendres (i kø og samlekøen, etter filteret). */
  function merkBaneKnapp(p, per) {
    const kort = [...per.ko, ...per.samle];
    if (!kort.length) return null;
    // Knappen gjelder kortene som passer søket, og følger søket og merkingen (sokBundet).
    let ider = [];
    let alle = false;
    const knapp = el('button', {
      type: 'button',
      class: 'pause-knapp',
      onclick: (e) => {
        e.stopPropagation();
        merkMange(ider, !alle);
      },
    });
    sokBundet(kort, (treff) => {
      ider = treff.map((k) => k.id);
      alle = ider.length > 0 && ider.every((id) => t.merket.has(id));
      knapp.hidden = !ider.length;
      knapp.textContent = alle ? 'Fjern merking' : 'Merk';
      knapp.setAttribute('aria-pressed', alle ? 'true' : 'false');
      knapp.title = alle
        ? `Fjern de ${ider.length} kortene i ${p.pid} fra valget`
        : `Merk de ${ider.length} kortene i kø og samlekøen i ${p.pid} som vises, for valglinja`;
    });
    return knapp;
  }

  // ---- Filter-menyen (én linje med søk og «Filter» i stedet for chip-raden) ----
  const filterKnapp = $('filter-knapp');
  const filterMeny = $('filter-meny');

  /** Pause eller fortsett et prosjekt (vaktregel 6 varsler når noe pågår). I Filter-menyen og i banehodet. */
  function pauseKnapp(p) {
    return el('button', {
      type: 'button',
      class: 'pause-knapp',
      'data-fokus': `pause:${p.pid}`,
      tekst: p.pause ? 'Fortsett' : 'Pause',
      'aria-label': `${p.pause ? 'Fortsett' : 'Pause'} prosjektet ${p.pid}`,
      onclick: (e) => {
        e.stopPropagation();
        handling(
          { type: p.pause ? 'fortsett' : 'pause', pid: p.pid },
          `${p.pid}: ${p.pause ? 'fortsetter' : 'pauset'}`,
        );
      },
    });
  }

  /** Knappen viser antall aktive filtre; menyen tegnes på nytt når den er åpen. */
  function tegnFilter() {
    const n = antallFiltre();
    filterKnapp.textContent = n ? `Filter · ${n}` : 'Filter';
    filterKnapp.setAttribute('aria-label', n ? `Filter, ${n} aktive` : 'Filter');
    filterKnapp.classList.toggle('aktiv', n > 0);
    if (!filterMeny.hidden) tegnFilterMeny();
  }

  function tegnFilterMeny() {
    const fokus = filterMeny.contains(document.activeElement)
      ? document.activeElement.dataset.fokus
      : null;
    // Åpne kort per prosjekt (I kø, Pågår, Review).
    const aapne = new Map();
    for (const kol of ['ko', 'pagar', 'review'])
      for (const k of t.data?.kolonner[kol] ?? [])
        aapne.set(k.prosjekt, (aapne.get(k.prosjekt) ?? 0) + 1);
    const deler = FILTER_SEKSJONER.map((s) => {
      const valg = s.valg();
      const valgt = t.filter.valgt[s.nokkel];
      const alle = valg.length > 0 && valg.every((v) => valgt.has(v.verdi));
      return el(
        'section',
        { class: 'filter-seksjon', 'aria-labelledby': `filter-${s.nokkel}` },
        el(
          'div',
          { class: 'filter-seksjon-hode' },
          el('h3', { id: `filter-${s.nokkel}`, tekst: s.tittel }),
          el('button', {
            type: 'button',
            class: 'lenke-knapp',
            'data-fokus': `alle:${s.nokkel}`,
            tekst: alle ? 'Velg ingen' : 'Velg alle',
            onclick: () => {
              if (alle) valgt.clear();
              else for (const v of valg) valgt.add(v.verdi);
              endretFilter();
            },
          }),
        ),
        el(
          'ul',
          { class: 'filter-liste' },
          valg.map((v) => {
            const id = `f-${s.nokkel}-${v.verdi}`;
            const p = v.prosjekt;
            return el(
              'li',
              { class: 'filter-rad' },
              el('input', {
                type: 'checkbox',
                id,
                'data-fokus': id,
                checked: valgt.has(v.verdi),
                onchange: (e) => {
                  if (e.target.checked) valgt.add(v.verdi);
                  else valgt.delete(v.verdi);
                  endretFilter();
                },
              }),
              el(
                'label',
                { for: id, title: p?.tittel ?? null },
                p ? el('span', { class: 'prikk', '--p': `var(--color-${p.farge})` }) : null,
                el('span', { class: 'filter-navn', tekst: v.tekst }),
                p?.pause ? el('span', { class: 'pauset', tekst: 'pauset' }) : null,
                p
                  ? el('span', {
                      class: 'filter-antall',
                      tekst: String(aapne.get(p.pid) ?? 0),
                      title: 'Åpne: i kø, pågår og review',
                    })
                  : null,
              ),
              p?.flyttbar ? pauseKnapp(p) : null,
            );
          }),
        ),
      );
    });
    deler.push(
      el(
        'div',
        { class: 'filter-fot' },
        el('button', {
          type: 'button',
          class: 'knapp knapp-kontur',
          'data-fokus': 'nullstill',
          tekst: 'Nullstill',
          disabled: antallFiltre() === 0,
          onclick: () => {
            for (const sett of Object.values(t.filter.valgt)) sett.clear();
            endretFilter();
          },
        }),
      ),
    );
    filterMeny.replaceChildren(...deler);
    if (fokus) filterMeny.querySelector(`[data-fokus="${CSS.escape(fokus)}"]`)?.focus();
  }

  function endretFilter() {
    lagreFilter();
    tegn();
  }
  function aapneFilter() {
    filterMeny.hidden = false;
    filterKnapp.setAttribute('aria-expanded', 'true');
    tegnFilterMeny();
    filterMeny.querySelector('input')?.focus();
  }
  function lukkFilter(fokuser) {
    if (filterMeny.hidden) return;
    filterMeny.hidden = true;
    filterKnapp.setAttribute('aria-expanded', 'false');
    if (fokuser) filterKnapp.focus();
  }
  filterKnapp.addEventListener('click', () =>
    filterMeny.hidden ? aapneFilter() : lukkFilter(true),
  );
  filterMeny.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      lukkFilter(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Piltastene går mellom radene (avkryssingsboksene); mellomrom huker av.
      const rader = [...filterMeny.querySelectorAll('input[type="checkbox"]')];
      const i = rader.indexOf(document.activeElement);
      const j = Math.max(0, Math.min(rader.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      e.preventDefault();
      rader[j]?.focus();
    }
  });
  // Klikk utenfor lukker. composedPath er stien da klikket skjedde, så et element menyen nettopp tegnet om, teller.
  document.addEventListener('click', (e) => {
    if (filterMeny.hidden) return;
    const sti = e.composedPath();
    if (!sti.includes(filterMeny) && !sti.includes(filterKnapp)) lukkFilter(false);
  });

  // ---- Statistikken (inline SVG, fargene fra CSS-variablene via klassene i tavle.css) ----
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function s(tag, attr, ...barn) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attr ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'tekst') e.textContent = v;
      else e.setAttribute(k, String(v));
    }
    for (const b of barn.flat()) if (b != null && b !== false) e.append(b);
    return e;
  }
  /** Verktøytipset i en graf. */
  const tips = (tekst) => s('title', { tekst });
  const KLASSE_CSS = { K: 's-K', D: 's-D', 'D+': 's-Dp', U: 's-U' };
  const tall = (x, d = 0) =>
    Number(x ?? 0).toLocaleString('nb-NO', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usd = (x) => `${tall(x, Math.abs(Number(x ?? 0)) >= 100 ? 0 : 2)} USD`;
  const dato = (dag) => `${dag.slice(8, 10)}.${dag.slice(5, 7)}`;
  const tusen = (x) => `${tall(Number(x ?? 0) / 1000)}k`;
  /** «25 min», «1 t 38 min». */
  function varighet(min) {
    if (min == null) return 'ingen data';
    const m = Math.round(min);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} t ${m % 60} min`;
  }
  /** Et pent tak for aksen: 1, 2, 2,5 eller 5 × 10^n, minst x. */
  function rundOpp(x) {
    if (!(x > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(x));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p;
    return 10 * p;
  }

  /** Stablede stolper per dag (graf 1 og 3). `serier`: [{ nokkel, css }]; `strek`: vannrett strek (kvoten). */
  function stolpeGraf({ rader, serier, tipsFor, formater, strek, sammendrag }) {
    const B = 560;
    const H = 200;
    const V = 52;
    const HO = 8;
    const TO = 10;
    const BU = 24;
    const ph = H - TO - BU;
    const maks = Math.max(
      0,
      ...rader.map((r) => serier.reduce((sum, se) => sum + (r[se.nokkel] ?? 0), 0)),
    );
    const topp = rundOpp(Math.max(maks, strek?.verdi ?? 0));
    const y = (v) => TO + ph - (v / topp) * ph;
    const svg = s('svg', {
      viewBox: `0 0 ${B} ${H}`,
      class: 'graf-svg',
      role: 'img',
      'aria-label': sammendrag,
    });
    for (const v of [0, topp / 2, topp])
      svg.append(
        s('line', { x1: V, x2: B - HO, y1: y(v), y2: y(v), class: 'akse' }),
        s('text', { x: V - 6, y: y(v) + 4, 'text-anchor': 'end', tekst: formater(v) }),
      );
    const steg = (B - V - HO) / rader.length;
    const bredde = Math.max(4, steg * 0.7);
    rader.forEach((r, i) => {
      const x = V + i * steg + (steg - bredde) / 2;
      const g = s('g', null, tips(tipsFor(r)));
      let bunn = 0;
      for (const se of serier) {
        const v = r[se.nokkel] ?? 0;
        if (v <= 0) continue;
        g.append(
          s('rect', {
            x,
            y: y(bunn + v),
            width: bredde,
            height: y(bunn) - y(bunn + v),
            class: se.css,
          }),
        );
        bunn += v;
      }
      // En usynlig flate over hele høyden, så verktøytipset også finnes på tomme dager.
      g.append(s('rect', { x, y: TO, width: bredde, height: ph, class: 'treff' }));
      svg.append(g);
      if ((rader.length - 1 - i) % 2 === 0)
        svg.append(
          s('text', { x: x + bredde / 2, y: H - 8, 'text-anchor': 'middle', tekst: dato(r.dag) }),
        );
    });
    if (strek)
      svg.append(
        s(
          'line',
          { x1: V, x2: B - HO, y1: y(strek.verdi), y2: y(strek.verdi), class: strek.css },
          tips(strek.tips),
        ),
      );
    return svg;
  }

  /** Vannrette stolper (graf 2 og 4). `rader`: [{ etikett, sterk?, deler: [{ verdi, css }], tips, tekst }]. */
  function liggendeGraf({ grupper, maks, streker = [], sammendrag, formater }) {
    const B = 560;
    const V = 96;
    const HO = 84;
    const TO = 6;
    const BU = 22;
    const RAD = 14;
    const MELLOM = 4;
    const GRUPPE = 14;
    const hoyde = (g) => g.rader.length * (RAD + MELLOM) - MELLOM;
    const H = TO + grupper.reduce((sum, g) => sum + hoyde(g) + GRUPPE, 0) - GRUPPE + BU;
    const topp = rundOpp(maks);
    const pw = B - V - HO;
    const x = (v) => V + (Math.min(v, topp) / topp) * pw;
    const svg = s('svg', {
      viewBox: `0 0 ${B} ${H}`,
      class: 'graf-svg',
      role: 'img',
      'aria-label': sammendrag,
    });
    for (const v of [0, topp / 2, topp])
      svg.append(
        s('line', { x1: x(v), x2: x(v), y1: TO, y2: H - BU, class: 'akse' }),
        s('text', { x: x(v), y: H - 6, 'text-anchor': 'middle', tekst: formater(v) }),
      );
    let y = TO;
    for (const g of grupper) {
      const y0 = y;
      for (const r of g.rader) {
        svg.append(
          s('text', {
            x: V - 8,
            y: y + RAD - 3,
            'text-anchor': 'end',
            class: r.sterk ? 'etikett-sterk' : null,
            tekst: r.etikett,
          }),
        );
        const del = s('g', null, tips(r.tips));
        let fra = 0;
        for (const d of r.deler) {
          if (!(d.verdi > 0)) continue;
          del.append(
            s('rect', {
              x: x(fra),
              y,
              width: x(fra + d.verdi) - x(fra),
              height: RAD,
              class: d.css,
            }),
          );
          fra += d.verdi;
        }
        svg.append(del, s('text', { x: x(fra) + 6, y: y + RAD - 3, tekst: r.tekst }));
        y += RAD + MELLOM;
      }
      for (const st of g.streker ?? [])
        svg.append(
          s(
            'line',
            { x1: x(st.verdi), x2: x(st.verdi), y1: y0 - 3, y2: y - MELLOM + 3, class: st.css },
            tips(st.tips),
          ),
        );
      y += GRUPPE - MELLOM;
    }
    for (const st of streker)
      svg.append(
        s(
          'line',
          { x1: x(st.verdi), x2: x(st.verdi), y1: TO - 2, y2: H - BU, class: st.css },
          tips(st.tips),
        ),
      );
    return svg;
  }

  /**
   * Linjer per dag (Inn mot ut). `serier`: [{ nokkel, css }]; hver serie blir en linje med et punkt per
   * dag, og hver dag har et verktøytips over hele høyden (som stolpegrafen).
   */
  function linjeGraf({ rader, serier, tipsFor, formater, sammendrag }) {
    const B = 560;
    const H = 200;
    const V = 52;
    const HO = 8;
    const TO = 10;
    const BU = 24;
    const ph = H - TO - BU;
    const maks = Math.max(0, ...rader.flatMap((r) => serier.map((se) => r[se.nokkel] ?? 0)));
    const topp = rundOpp(maks);
    const y = (v) => TO + ph - (v / topp) * ph;
    const steg = (B - V - HO) / rader.length;
    const x = (i) => V + i * steg + steg / 2;
    const svg = s('svg', {
      viewBox: `0 0 ${B} ${H}`,
      class: 'graf-svg',
      role: 'img',
      'aria-label': sammendrag,
    });
    for (const v of [0, topp / 2, topp])
      svg.append(
        s('line', { x1: V, x2: B - HO, y1: y(v), y2: y(v), class: 'akse' }),
        s('text', { x: V - 6, y: y(v) + 4, 'text-anchor': 'end', tekst: formater(v) }),
      );
    for (const se of serier) {
      svg.append(
        s('polyline', {
          class: `linje ${se.css}`,
          points: rader.map((r, i) => `${x(i)},${y(r[se.nokkel] ?? 0)}`).join(' '),
        }),
      );
      for (const [i, r] of rader.entries())
        svg.append(
          s('circle', { cx: x(i), cy: y(r[se.nokkel] ?? 0), r: 3, class: `punkt ${se.css}` }),
        );
    }
    rader.forEach((r, i) => {
      svg.append(
        s(
          'g',
          null,
          tips(tipsFor(r)),
          s('rect', { x: x(i) - steg / 2, y: TO, width: steg, height: ph, class: 'treff' }),
        ),
      );
      if ((rader.length - 1 - i) % 2 === 0)
        svg.append(s('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', tekst: dato(r.dag) }));
    });
    return svg;
  }

  /** «3 d» for lange tider (svartid på eierspørsmål), ellers som varighet. */
  const lengde = (min) =>
    min == null ? 'ingen data' : min >= 48 * 60 ? `${tall(min / 1440, 1)} d` : varighet(min);

  /** En graf med tittel, forklaring (fargene) og en kort merknad (f.eks. hvor mange som er utelatt). */
  function graf(tittel, innhold, forklaring, merknad) {
    return el(
      'figure',
      { class: 'graf' },
      el('figcaption', { tekst: tittel }),
      innhold,
      forklaring?.length
        ? el(
            'ul',
            { class: 'forklaring', 'aria-hidden': 'true' },
            forklaring.map(([css, tekst, strek]) =>
              el(
                'li',
                null,
                el('span', {
                  class: `${strek === 'linje' ? 'tegn-linje' : strek ? 'tegn-strek' : 'tegn-prikk'} ${css}`,
                }),
                tekst,
              ),
            ),
          )
        : null,
      merknad ? el('p', { class: 'graf-merknad', tekst: merknad }) : null,
    );
  }

  function flis(navn, verdi, under) {
    return el(
      'div',
      { class: 'flis' },
      el('p', { class: 'flis-navn', tekst: navn }),
      el('p', { class: 'flis-verdi', tekst: verdi }),
      under ? el('p', { class: 'flis-under', tekst: under }) : null,
    );
  }

  function tegnStatistikk() {
    const d = t.stat.data;
    if (!d) {
      main.append(
        el('p', {
          class: 'tom',
          tekst: t.stat.feil
            ? `Kunne ikke lage statistikken: ${t.stat.feil}`
            : 'Henter statistikken …',
        }),
      );
      return;
    }
    const n = d.nokkeltall;
    const natt = String(d.nattvindu ?? '23-06').replace('-', ' til ');

    // Graf 1: ferdige per dag, stablet per klasse.
    const ferdigeTotalt = d.ferdigePerDag.reduce((sum, r) => sum + r.sum, 0);
    const flest = d.ferdigePerDag.reduce((a, r) => (r.sum > a.sum ? r : a), d.ferdigePerDag[0]);
    const graf1 = graf(
      `Ferdige per dag, siste ${d.vinduDager} dager`,
      stolpeGraf({
        rader: d.ferdigePerDag,
        serier: ['K', 'D', 'D+', 'U'].map((k) => ({ nokkel: k, css: KLASSE_CSS[k] })),
        formater: (v) => tall(v, v % 1 ? 1 : 0),
        tipsFor: (r) =>
          `${dato(r.dag)}: ${r.sum} ferdige (K ${r.K}, D ${r.D}, D+ ${r['D+']}, U ${r.U})`,
        sammendrag:
          `Ferdige per dag de siste ${d.vinduDager} dagene, stablet per klasse: ${ferdigeTotalt} i alt` +
          (flest?.sum ? `, flest ${flest.sum} den ${dato(flest.dag)}.` : '.'),
      }),
      ['K', 'D', 'D+', 'U'].map((k) => [KLASSE_CSS[k], k]),
    );

    // Inn mot ut: lagt til og ferdige per dag, to linjer.
    const innUt = d.innUtPerDag ?? [];
    const innTotalt = innUt.reduce((a, r) => a + r.inn, 0);
    const utTotalt = innUt.reduce((a, r) => a + r.ut, 0);
    const grafInnUt = graf(
      `Lagt til og ferdige per dag, siste ${d.vinduDager} dager`,
      linjeGraf({
        rader: innUt,
        serier: [
          { nokkel: 'inn', css: 's-inn' },
          { nokkel: 'ut', css: 's-ut' },
        ],
        formater: (v) => tall(v, v % 1 ? 1 : 0),
        tipsFor: (r) => `${dato(r.dag)}: ${r.inn} lagt til, ${r.ut} ferdige`,
        sammendrag:
          `Lagt til og ferdige per dag de siste ${d.vinduDager} dagene: ${innTotalt} lagt til og ${utTotalt} ` +
          `ferdige i alt.`,
      }),
      [
        ['s-inn', 'Lagt til', 'linje'],
        ['s-ut', 'Ferdige', true],
      ],
    );

    // Graf 2: tid per klasse, median og snitt, delt i arbeid og review/fletting, med anslått snitt som strek.
    const klasser = d.perKlasse.filter((k) => k.antall > 0);
    const sum = (k, mal) => (k.arbeid[mal] ?? 0) + (k.review[mal] ?? 0);
    const graf2 = graf(
      'Tid per klasse (start til ferdig)',
      klasser.length
        ? liggendeGraf({
            grupper: klasser.map((k) => ({
              rader: ['median', 'snitt'].map((mal) => ({
                etikett: mal === 'median' ? `${k.klasse} median` : 'snitt',
                sterk: mal === 'median',
                deler: [
                  { verdi: k.arbeid[mal] ?? 0, css: 's-arbeid' },
                  { verdi: k.review[mal] ?? 0, css: 's-review' },
                ],
                tekst: varighet(sum(k, mal)),
                tips:
                  `${k.klasse}, ${mal} av ${k.antall}: arbeid ${varighet(k.arbeid[mal])} + review og fletting ` +
                  `${varighet(k.review[mal])}`,
              })),
              streker:
                k.anslagSnitt != null
                  ? [
                      {
                        verdi: k.anslagSnitt,
                        css: 'strek-anslag',
                        tips: `${k.klasse}: anslått snitt ${varighet(k.anslagSnitt)}`,
                      },
                    ]
                  : [],
            })),
            maks: Math.max(
              1,
              ...klasser.flatMap((k) => [sum(k, 'median'), sum(k, 'snitt'), k.anslagSnitt ?? 0]),
            ),
            formater: (v) => varighet(v),
            sammendrag:
              'Median tid fra start til ferdig per klasse: ' +
              klasser.map((k) => `${k.klasse} ${varighet(sum(k, 'median'))}`).join(', ') +
              '. Streken er anslått snitt.',
          })
        : el('p', { class: 'tom', tekst: 'Ingen ferdige oppgaver med alle tidene ennå.' }),
      [
        ['s-arbeid', 'Arbeid (start til levert)'],
        ['s-review', 'Review og fletting (levert til ferdig)'],
        ['strek-anslag', 'Anslått snitt', true],
      ],
      d.utelatt.klasse
        ? `${d.utelatt.klasse} ferdige uten start-, leverings- eller ferdigtid er utelatt.`
        : null,
    );

    // Graf 3: kost per dag, natt for seg, med dagskvoten som strek.
    const kostTotalt = d.kostPerDag.reduce((a, r) => a + r.usd, 0);
    const nattTotalt = d.kostPerDag.reduce((a, r) => a + r.natt, 0);
    const graf3 = graf(
      `Kost per dag, siste ${d.vinduDager} dager (USD, API-ekvivalent)`,
      stolpeGraf({
        rader: d.kostPerDag.map((r) => ({
          dag: r.dag,
          dagdel: Math.max(0, r.usd - r.natt),
          natt: r.natt,
          usd: r.usd,
        })),
        serier: [
          { nokkel: 'dagdel', css: 's-dag' },
          { nokkel: 'natt', css: 's-natt' },
        ],
        formater: (v) => tall(v),
        tipsFor: (r) => `${dato(r.dag)}: ${usd(r.usd)}, av det natt ${usd(r.natt)}`,
        strek: n.dagsbudsjett
          ? { verdi: n.dagsbudsjett, css: 'strek-kvote', tips: `Dagskvote ${usd(n.dagsbudsjett)}` }
          : null,
        sammendrag:
          `Kost per dag de siste ${d.vinduDager} dagene: ${usd(kostTotalt)} i alt, ` +
          `${kostTotalt ? Math.round((nattTotalt / kostTotalt) * 100) : 0} % om natten (${natt})` +
          (n.dagsbudsjett ? `, dagskvote ${usd(n.dagsbudsjett)}.` : '.'),
      }),
      [
        ['s-dag', 'Dag'],
        ['s-natt', `Natt (${natt})`],
        ...(n.dagsbudsjett ? [['strek-kvote', 'Dagskvote', true]] : []),
      ],
    );

    // Graf 4: konteksten til spor-agentene mot taket.
    const k = d.kontekst;
    const graf4 = graf(
      `Kontekst ved slutt, spor-agenter siste ${d.vinduDager} dager`,
      k.antall
        ? liggendeGraf({
            grupper: [
              {
                rader: [
                  ['median', k.median],
                  ['maks', k.maks],
                ].map(([etikett, v]) => ({
                  etikett,
                  sterk: etikett === 'median',
                  deler: [{ verdi: v, css: v > k.tak ? 's-over' : 's-kontekst' }],
                  tekst: tusen(v),
                  tips: `${etikett} av ${k.antall} spor: ${tusen(v)} tokens`,
                })),
              },
            ],
            streker: [{ verdi: k.tak, css: 'strek-kvote', tips: `Tak ca. ${tusen(k.tak)}` }],
            maks: Math.max(k.maks ?? 0, k.tak),
            formater: tusen,
            sammendrag: `Kontekst ved slutt for ${k.antall} spor-agenter: median ${tusen(k.median)}, maks ${tusen(k.maks)}, tak ca. ${tusen(k.tak)}.`,
          })
        : el('p', { class: 'tom', tekst: 'Ingen spor-agenter med kontekst logget ennå.' }),
      [
        ['s-kontekst', 'Kontekst'],
        ['strek-kvote', `Tak ca. ${tusen(k.tak)}`, true],
      ],
      d.utelatt.kontekst ? `${d.utelatt.kontekst} spor uten kontekst i loggen er utelatt.` : null,
    );

    main.append(
      el(
        'section',
        { class: 'nokkeltall', 'aria-label': 'Nøkkeltall' },
        flis(
          `Ferdige siste ${d.ferdigeDager} dager`,
          tall(n.ferdige),
          'oppgaver satt ferdig i køen',
        ),
        flis(
          'Median syklustid',
          varighet(n.syklusMedian),
          `start til ferdig, ${n.syklusAntall} oppgaver siste ${d.vinduDager} dager` +
            (d.utelatt.syklus ? `; ${d.utelatt.syklus} uten starttid er utelatt` : ''),
        ),
        flis(
          'Treffsikkerhet på anslag',
          n.treffsikkerhet == null ? 'ingen data' : `${tall(n.treffsikkerhet, 2)} ×`,
          'median av faktisk tid delt på anslaget (1,00 = som anslått)',
        ),
        flis(
          'Forbruk i dag',
          usd(n.forbrukIdag),
          n.dagsbudsjett
            ? `av ${usd(n.dagsbudsjett)} i dagskvote (${Math.round((n.forbrukIdag / n.dagsbudsjett) * 100)} %)`
            : 'API-ekvivalent; ingen dagskvote satt',
        ),
        // Samlekøen telles for seg (venter på å bli pakket, ikke på å bli startet).
        n.samlekoen?.antall
          ? flis(
              'I samlekøen',
              tall(n.samlekoen.antall),
              `${tall(n.samlekoen.minutter)} innholdsminutter i ${n.samlekoen.grupper} ` +
                `${n.samlekoen.grupper === 1 ? 'gruppe' : 'grupper'}, ${n.samlekoen.klare} klar(e) til pakking`,
            )
          : null,
        // Inn mot ut: pil opp når køen vokser.
        n.innUt
          ? flis(
              `Inn mot ut, siste ${d.ferdigeDager} dager`,
              `${tall(n.innUt.inn, 1)} / ${tall(n.innUt.ut, 1)}`,
              `lagt til / ferdige per dag · ` +
                (n.innUt.netto > 0
                  ? `↑ køen vokser med ${tall(n.innUt.netto, 1)} per dag`
                  : n.innUt.netto < 0
                    ? `↓ køen krymper med ${tall(-n.innUt.netto, 1)} per dag`
                    : '→ like mange inn som ut'),
            )
          : null,
        // Bare når nok avklaringer har tid (ellers utelates tallet).
        n.svartid
          ? flis(
              'Median tid fra spørsmål til svar',
              lengde(n.svartid.median),
              `${n.svartid.antall} eierspørsmål avklart med tidsstempel`,
            )
          : null,
      ),
      el('div', { class: 'grafer' }, graf1, grafInnUt, graf2, graf3, graf4),
      // Tegnforklaringen for klassene og merkene (samme som i hjelpen).
      tegnforklaring('stat'),
      // append() gjør null om til teksten «null», så merknaden legges bare til når den finnes.
      ...(d.tidsloggFeil
        ? [
            el('p', {
              class: 'graf-merknad',
              tekst: `Fant ikke tidsloggen (${d.tidsloggFeil}); kost og kontekst mangler.`,
            }),
          ]
        : []),
    );
  }

  // ---- Innstillingene (tannhjulet) ----
  async function aapneInnstillinger() {
    t.valgt = null;
    t.innboks = false;
    t.innst = { laster: true };
    visPanel();
    tegnInnstillinger();
    panel.querySelector('.knapp-ikon')?.focus();
    await hentInnstillinger();
  }
  async function hentInnstillinger() {
    let svar;
    try {
      svar = await api('/api/innstillinger');
    } catch (e) {
      svar = { feil: e.message };
    }
    if (t.innst === null) return; // lukket imens
    t.innst = svar;
    tegnInnstillinger();
  }

  function tegnInnstillinger() {
    const d = t.innst;
    const rull = panel.scrollTop;
    const hode = el(
      'div',
      { class: 'panel-hode' },
      el('div', null, el('h2', { id: 'panel-tittel', tekst: 'Innstillinger' })),
      el(
        'button',
        { type: 'button', class: 'knapp-ikon', 'aria-label': 'Lukk', onclick: lukkPanel },
        ikon('lukk'),
      ),
    );
    if (!d || d.laster || d.feil) {
      panel.replaceChildren(
        hode,
        hjelpSeksjon(),
        temaSeksjon(),
        el('p', {
          class: 'tom',
          tekst: d?.feil ? `Kunne ikke lese innstillingene: ${d.feil}` : 'Henter innstillingene …',
        }),
      );
      return;
    }
    const o = d.oppsett;
    panel.replaceChildren(
      hode,
      hjelpSeksjon(),
      temaSeksjon(),
      el(
        'section',
        { class: 'innst', 'aria-labelledby': 'innst-ko' },
        el('h3', { id: 'innst-ko', class: 'innst-tittel', tekst: 'Køen' }),
        d.felt.map((f) => innstFelt(f, d)),
      ),
      angreSeksjon(),
      el(
        'section',
        { class: 'innst', 'aria-labelledby': 'innst-oppsett' },
        el('h3', { id: 'innst-oppsett', class: 'innst-tittel', tekst: 'Oppsett (bare lesing)' }),
        el('dl', { class: 'fakta' }, oppsettFakta(o)),
      ),
      el(
        'section',
        { class: 'innst', 'aria-labelledby': 'innst-regler' },
        el('h3', { id: 'innst-regler', class: 'innst-tittel', tekst: 'Regler fra skillen' }),
        liste2(o.regler),
        el('p', { class: 'innst-kilde', tekst: `Kilde: ${o.reglerKilde}` }),
      ),
    );
    panel.scrollTop = rull;
  }

  function innstFelt(f, d) {
    const id = `g-${f.navn}`;
    const feil = el('p', { class: 'innst-feil', role: 'alert', hidden: true });
    const kontroll =
      f.type === 'paav'
        ? el(
            'select',
            { id, 'aria-describedby': `${id}-hjelp` },
            ['på', 'av'].map((v) =>
              el('option', { value: v, selected: f.verdi === v, tekst: v === 'på' ? 'På' : 'Av' }),
            ),
          )
        : el('input', {
            id,
            type: 'text',
            value: f.verdi,
            inputmode: f.type === 'heltall' ? 'numeric' : null,
            autocomplete: 'off',
            'aria-describedby': `${id}-hjelp`,
          });
    const lagre = el('button', {
      type: 'button',
      class: 'knapp knapp-tonet',
      tekst: 'Lagre',
      'aria-label': `Lagre ${f.tittel.toLowerCase()}`,
      onclick: () => lagreGrense(f, kontroll.value, feil),
    });
    kontroll.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        lagre.click();
      }
    });
    const meta = [
      `nå: ${f.verdi}`,
      `standard: ${f.standard}`,
      f.sparemodus ? `sparemodus: ${f.sparemodus}` : null,
      f.navn === 'dagsbudsjett' ? `brukt i dag: ${usd(d.forbrukIdag)}` : null,
      f.navn === 'nattkjoring' && d.natt?.stopp ? 'nattpause nå' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return el(
      'div',
      { class: 'innst-felt' },
      el('label', { for: id, tekst: f.tittel }),
      el('p', { id: `${id}-hjelp`, class: 'innst-forklaring', tekst: f.forklaring }),
      el('div', { class: 'innst-kontroll' }, kontroll, lagre),
      el('p', { class: 'innst-meta', tekst: meta }),
      feil,
    );
  }

  async function lagreGrense(f, verdi, feilEl) {
    feilEl.hidden = true;
    try {
      const svar = await skrivMedVakt('/api/grense', { navn: f.navn, verdi: String(verdi).trim() });
      if (!svar) return; // avbrutt
      meldingMedInfo(`${f.tittel}: lagret`, svar);
      await hentInnstillinger();
      oppdater(true);
    } catch (e) {
      // Meldingen fra ko.mjs (eller vaktreglene) vises ved feltet.
      feilEl.textContent = e.message;
      feilEl.hidden = false;
    }
  }

  function oppsettFakta(o) {
    const ork = o.orkestrator ?? {};
    const orkestrator = ork.oppdatert
      ? `${ork.okt ?? '?'}: ${ork.aktiv ? 'aktiv' : (ork.grunn ?? 'ikke aktiv')}, siste puls for ${alder(ork.oppdatert)} siden` +
        (ork.hendelse ? ` (${ork.hendelse})` : '')
      : 'ingen markør (ingen orkestrator har meldt seg)';
    const modell = o.modeller?.length
      ? o.modeller.map((m) => `${m.modell} (${m.antall})`).join(', ')
      : 'ikke logget ennå';
    // Køsystemets egne hooks (scripts/orkestrator/hook-*.mjs) i .claude/settings.json.
    const hooks = !o.hooks
      ? 'fant ikke .claude/settings.json'
      : o.hooks.alle
        ? 'ja, alle køsystemets hooks er på plass'
        : el('strong', { class: 'fare', tekst: `mangler: ${o.hooks.mangler.join(', ')}` });
    // Køsystemets egne skills (.claude/skills/<navn>/SKILL.md).
    const skills = !o.skills
      ? 'ukjent'
      : o.skills.alle
        ? `ja, alle (${o.skills.finnes.join(', ')})`
        : el('strong', { class: 'fare', tekst: `mangler: ${o.skills.mangler.join(', ')}` });
    const rader = [...fakta('Basegren', o.baseGren ?? 'main')];
    // Migrasjonene vises bare når prosjektet har slått dem på (migrasjoner.mappe i ko.config.json).
    const m = o.migrasjoner;
    if (m) {
      const hoyeste = m.hoyeste ? `${m.hoyeste.nummer} (${m.hoyeste.fil})` : 'ingen';
      rader.push(
        ...fakta(
          'Migrasjoner',
          m.feil
            ? `kunne ikke lese ${m.mappe} (${m.feil})`
            : `neste ledige blokk ${m.neste ?? '?'}; høyeste i ${m.mappe}: ${hoyeste}`,
        ),
      );
    }
    rader.push(
      ...fakta('Orkestrator', orkestrator),
      ...fakta('Modell i de siste sporene', modell),
      ...fakta('Køsystemets hooks', hooks),
      ...fakta('Køsystemets skills', skills),
    );
    return rader;
  }

  // ---- «Venter på deg»: det som venter på eieren, i sidepanelet ----
  const innboksKnapp = $('innboks');
  const SPORSMAL_TYPE = {
    sporsmal: { navn: 'Spørsmål', knapp: 'Svar', felt: 'Svaret ditt' },
    betingelse: {
      navn: 'Venter på betingelse',
      knapp: 'Marker oppfylt',
      felt: 'Hvordan er betingelsen oppfylt?',
    },
    jurist: {
      navn: 'Venter på jurist',
      knapp: 'Marker oppfylt',
      felt: 'Hva sa juristen, og hva betyr det?',
    },
    'eier-oppgave': { navn: 'Eier-oppgave', knapp: 'Svar', felt: 'Hva er gjort?' },
  };
  const spType = (type) => SPORSMAL_TYPE[type] ?? SPORSMAL_TYPE.sporsmal;

  /** Telleren på knappen i toppen: alt som venter på eieren (spørsmål, QA, forslag, det som henger). */
  function tegnInnboksKnapp() {
    const n = t.data?.innboks?.antall ?? 0;
    innboksKnapp.replaceChildren(
      'Venter på deg',
      ...(n ? [el('span', { class: 'innboks-antall', tekst: String(n) })] : []),
    );
    innboksKnapp.setAttribute('aria-label', n ? `Venter på deg: ${n}` : 'Venter på deg: ingenting');
    innboksKnapp.classList.toggle('aktiv', n > 0);
    innboksKnapp.setAttribute('aria-expanded', t.innboks ? 'true' : 'false');
  }

  function aapneInnboks() {
    t.valgt = null;
    t.innst = null;
    t.fraInnboks = false;
    t.innboks = true;
    visPanel();
    panel.scrollTop = 0;
    tegnInnboks(true);
    tegnInnboksKnapp();
    panel.querySelector('.knapp-ikon')?.focus();
  }
  innboksKnapp.addEventListener('click', () => (t.innboks ? lukkPanel() : aapneInnboks()));

  /** En del av innboksen: tittel med antall, innhold, og (valgfritt) en handling for de avhukede. */
  function innboksDel(navn, tittel, antall, innhold, fot) {
    return el(
      'section',
      { class: 'innboks-del', 'aria-labelledby': `innboks-${navn}` },
      el('h3', { id: `innboks-${navn}`, class: 'innst-tittel' }, `${tittel} (${antall})`),
      innhold,
      fot ?? null,
    );
  }

  /** Avhuking (QA, forslag): valgt-settet overlever omtegning; fokus følger data-fokus. */
  function avhuking(sett, id, etikett) {
    return el('input', {
      type: 'checkbox',
      'data-fokus': `valg:${id}`,
      'aria-label': etikett,
      checked: sett.has(id),
      onchange: (e) => {
        if (e.target.checked) sett.add(id);
        else sett.delete(id);
        tegnInnboks(true); // en handling fra eieren: tegn om selv om et svarfelt har fokus
      },
    });
  }

  function sporsmalRad(s, i) {
    const type = spType(s.type);
    const apen = t.svarApent === s.sp;
    const rad = el(
      'li',
      { class: 'innboks-rad' },
      el(
        'div',
        { class: 'rad-hode' },
        el('span', { class: `merke sp-type sp-${s.type}`, tekst: type.navn }),
        el('span', { class: 'sp-id', tekst: s.sp }),
        el('span', {
          class: 'sp-laaser',
          tekst: s.antall
            ? `låser opp ${s.antall} ${s.antall === 1 ? 'oppgave' : 'oppgaver'} · ${varighet(s.minutter)}`
            : 'ingen oppgave venter',
        }),
        // Det svaret låser opp i fokus (sorteringsgrunnlaget når fokus er satt).
        s.fokus
          ? el('span', {
              class: `merke sp-fokus${s.fokus.antall ? '' : ' tom-fokus'}`,
              tekst: s.fokus.antall
                ? `i fokus: låser opp ${s.fokus.antall} (${varighet(s.fokus.minutter)})`
                : 'ingenting i fokus',
              title: s.fokus.antall
                ? 'Oppgaver i fokustrinnene som venter på dette svaret, direkte eller via kjeden. ' +
                  s.fokus.per_trinn
                    .map((m, j) => (m ? `T${j + 1}: ${varighet(m)}` : null))
                    .filter(Boolean)
                    .join(', ')
                : 'Svaret låser ikke opp noe i fokustrinnene nå. Det sorteres derfor etter dem som gjør det.',
            })
          : null,
      ),
      el('p', {
        class: s.tekst ? 'sp-tekst' : 'sp-tekst mangler',
        tekst: s.tekst ?? 'Ingen tekst registrert ennå (ko.mjs sporsmal <id> --tekst …).',
      }),
      s.anbefaling ? el('p', { class: 'sp-meta', tekst: `Anbefaling: ${s.anbefaling}` }) : null,
      s.kilde ? el('p', { class: 'sp-meta', tekst: `Kilde: ${s.kilde}` }) : null,
      s.direkte.length
        ? el(
            'p',
            { class: 'sp-meta' },
            'Venter: ',
            s.direkte.map((id) =>
              el('button', {
                type: 'button',
                class: 'lenke-knapp',
                tekst: id,
                onclick: () => aapnePanel(id, { fraInnboks: true }),
              }),
            ),
          )
        : null,
    );
    if (!apen) {
      rad.append(
        el('button', {
          type: 'button',
          class: 'knapp knapp-tonet',
          'data-fokus': `svar:${i}`,
          tekst: type.knapp,
          'aria-label': `${type.knapp}: ${s.sp}`,
          onclick: () => {
            t.svarApent = s.sp;
            tegnInnboks(true);
            panel.querySelector(`#svar-${i}`)?.focus();
          },
        }),
      );
      return rad;
    }
    const felt = el('textarea', {
      id: `svar-${i}`,
      rows: 3,
      'data-fokus': `svartekst:${i}`,
      oninput: (e) => t.svarUtkast.set(s.sp, e.target.value),
    });
    felt.value = t.svarUtkast.get(s.sp) ?? '';
    const lagre = async () => {
      const svar = felt.value.trim();
      // Vaktregel 15: tomt svar stopper (serveren sjekker det samme).
      if (!svar) return melding(`${type.felt.replace(/\?$/, '')}: skriv svaret først.`, true);
      const gjort = await handling({ type: 'avklar', sp: s.sp, svar }, `${s.sp}: avklart`);
      if (gjort) {
        t.svarApent = null;
        t.svarUtkast.delete(s.sp);
        tegnInnboks(true);
      }
    };
    rad.append(
      el(
        'div',
        { class: 'handlinger svar-skjema' },
        el('div', { class: 'felt' }, el('label', { for: `svar-${i}`, tekst: type.felt }), felt),
        s.anbefaling
          ? el('button', {
              type: 'button',
              class: 'knapp knapp-kontur',
              tekst: 'Bruk anbefalingen',
              onclick: () => {
                felt.value = s.anbefaling;
                t.svarUtkast.set(s.sp, felt.value);
                felt.focus();
              },
            })
          : null,
        el('button', {
          type: 'button',
          class: 'knapp knapp-kontur',
          tekst: 'Avbryt',
          onclick: () => {
            t.svarApent = null;
            tegnInnboks(true);
          },
        }),
        el('button', {
          type: 'button',
          class: 'knapp knapp-fylt',
          tekst: s.type === 'betingelse' || s.type === 'jurist' ? 'Marker oppfylt' : 'Lagre svar',
          onclick: lagre,
        }),
      ),
    );
    return rad;
  }

  /**
   * «Sorter» i «Venter på deg»: oppgaver uten prosjekt, med usikkert forslag, eller der prosjektet strider
   * mot filene og planen. Rader med forslag kan godtas én og én eller samlet (massehandlingen godta-forslag, med
   * forhåndsvisning). Telles ikke i antallet på knappen: det er rydding, ikke noe som stopper køen.
   */
  function sorterDel(rader) {
    const ider = new Set(rader.map((r) => r.id));
    for (const id of [...t.valgtSorter]) if (!ider.has(id)) t.valgtSorter.delete(id);
    const medForslag = rader.filter((r) => r.forslag && merkbar(r.id));
    const valgte = [...t.valgtSorter].filter((id) => medForslag.some((r) => r.id === id));
    const TYPE = {
      uenig: [
        'strider',
        'Prosjektet i dag strider mot et sterkt signal (filer, plan eller prefiks).',
      ],
      flytt: ['uten prosjekt', 'Uten prosjekt i dag, med et sikkert forslag.'],
      sorter: ['usikker', 'Uten prosjekt eller med usikkert forslag: velg prosjekt selv.'],
    };
    const rad = (r) =>
      el(
        'li',
        { class: 'innboks-rad sorter-rad' },
        el(
          'div',
          { class: 'rad-hode' },
          r.forslag && merkbar(r.id)
            ? avhuking(t.valgtSorter, r.id, `Velg ${r.id} for «Godta alle forslag for valgte»`)
            : null,
          el('button', {
            type: 'button',
            class: 'lenke-knapp',
            tekst: r.id,
            title: 'Åpne oppgaven',
            onclick: () => aapnePanel(r.id, { fraInnboks: true }),
          }),
          el('span', {
            class: 'merke',
            tekst: TYPE[r.type]?.[0] ?? r.type,
            title: TYPE[r.type]?.[1] ?? null,
          }),
        ),
        el('p', { class: 'sp-tekst', tekst: r.tittel ?? '' }),
        el('p', {
          class: 'sp-meta',
          tekst:
            `Nå: ${r.naa}` +
            (r.forslag ? ` · forslag: ${r.forslag}` : ' · ingen forslag') +
            (r.grunn ? ` · ${r.grunn}` : ''),
        }),
        r.forslag && merkbar(r.id)
          ? el('button', {
              type: 'button',
              class: 'knapp knapp-tonet knapp-liten',
              tekst: 'Godta forslag',
              title: `Flytt ${r.id} til prosjektet ${r.forslag}. Du ser endringen før den lagres.`,
              onclick: () => aapneMasse('godta-forslag', [r.id]),
            })
          : null,
      );
    return innboksDel(
      'sorter',
      'Sorter',
      rader.length,
      [
        el('p', {
          class: 'innboks-info',
          tekst:
            'Rydding, ikke noe som stopper køen: prosjektet bestemmer området og fokustrinnet en oppgave havner i.',
        }),
        el('ol', { class: 'innboks-liste' }, rader.map(rad)),
      ],
      medForslag.length
        ? el(
            'div',
            { class: 'handlinger' },
            el('button', {
              type: 'button',
              class: 'lenke-knapp',
              'data-fokus': 'sorter-alle',
              tekst: valgte.length === medForslag.length ? 'Velg ingen' : 'Velg alle med forslag',
              onclick: () => {
                if (valgte.length === medForslag.length) t.valgtSorter.clear();
                else for (const r of medForslag) t.valgtSorter.add(r.id);
                tegnInnboks(true);
              },
            }),
            el('button', {
              type: 'button',
              class: 'knapp knapp-tonet',
              'data-fokus': 'sorter-godta',
              tekst: `Godta alle forslag for valgte (${valgte.length})`,
              disabled: !valgte.length,
              title:
                'Gir hver valgte oppgave prosjektet køen foreslår. Du ser endringene før de lagres.',
              onclick: () => aapneMasse('godta-forslag', valgte),
            }),
          )
        : null,
    );
  }

  function tegnInnboks(ny) {
    if (!t.innboks) return;
    // Ikke tegn om mens eieren skriver et svar (tekstfeltet ville mistet markøren).
    if (
      !ny &&
      panel.contains(document.activeElement) &&
      document.activeElement.tagName === 'TEXTAREA'
    )
      return;
    const fokus = panel.contains(document.activeElement)
      ? document.activeElement.dataset?.fokus
      : null;
    const rull = panel.scrollTop;
    const d = t.data?.innboks;
    const hode = el(
      'div',
      { class: 'panel-hode' },
      el('div', null, el('h2', { id: 'panel-tittel', tekst: 'Venter på deg' })),
      el(
        'button',
        { type: 'button', class: 'knapp-ikon', 'aria-label': 'Lukk', onclick: lukkPanel },
        ikon('lukk'),
      ),
    );
    if (!d) {
      panel.replaceChildren(hode, el('p', { class: 'tom', tekst: 'Henter køen …' }));
      return;
    }
    // Avhukede som ikke venter lenger (godkjent, QA ok, borte), fjernes fra valget.
    const qaIder = new Set(
      d.qa.flatMap((p) => p.funksjoner.flatMap((f) => f.oppgaver.map((o) => o.id))),
    );
    for (const id of [...t.valgtQa]) if (!qaIder.has(id)) t.valgtQa.delete(id);
    const forslagIder = new Set(d.forslag.map((f) => f.id));
    for (const id of [...t.valgtForslag]) if (!forslagIder.has(id)) t.valgtForslag.delete(id);
    if (t.svarApent && !d.sporsmal.some((s) => s.sp === t.svarApent)) t.svarApent = null;

    const deler = [hode];
    if (!d.antall)
      deler.push(
        el(
          'p',
          { class: 'innboks-tom' },
          ikon('hake'),
          el('span', { tekst: 'Ingenting venter på deg' }),
        ),
      );

    if (d.sporsmal.length)
      deler.push(
        innboksDel('sporsmal', 'Spørsmål', d.sporsmal.length, [
          d.fokus_sortert
            ? el('p', {
                class: 'innboks-info',
                tekst:
                  'Sortert etter hvor mye svaret låser opp i fokus: trinn 1 først, så minuttene. Spørsmål som ' +
                  'ikke rører fokus står sist.',
              })
            : null,
          el('ol', { class: 'innboks-liste' }, d.sporsmal.map(sporsmalRad)),
        ]),
      );

    if (d.sorter?.length) deler.push(sorterDel(d.sorter));

    if (d.qaAntall) {
      const alleValgt = qaIder.size > 0 && [...qaIder].every((id) => t.valgtQa.has(id));
      const n = t.valgtQa.size;
      deler.push(
        innboksDel(
          'qa',
          'QA',
          d.qaAntall,
          [
            el('button', {
              type: 'button',
              class: 'lenke-knapp',
              'data-fokus': 'qa-alle',
              tekst: alleValgt ? 'Velg ingen' : 'Velg alle',
              onclick: () => {
                if (alleValgt) t.valgtQa.clear();
                else for (const id of qaIder) t.valgtQa.add(id);
                tegnInnboks(true);
              },
            }),
            ...d.qa.map((p) =>
              el(
                'div',
                { class: 'qa-prosjekt' },
                el('h4', { class: 'qa-navn', tekst: p.tittel ? `${p.tittel} (${p.pid})` : p.pid }),
                p.funksjoner.map((f) =>
                  el(
                    'div',
                    { class: 'qa-funksjon' },
                    el('p', { class: 'qa-funksjon-navn', tekst: f.funksjon }),
                    el(
                      'ul',
                      { class: 'innboks-liste' },
                      f.oppgaver.map((o) =>
                        el(
                          'li',
                          { class: 'innboks-rad rad-kort' },
                          el(
                            'label',
                            { class: 'rad-valg' },
                            avhuking(t.valgtQa, o.id, `Velg ${o.id} for QA ok`),
                            el('span', { class: 'sp-id', tekst: o.id }),
                            el('span', { class: 'rad-tittel', tekst: o.tittel }),
                            o.ferdig
                              ? el('span', {
                                  class: 'sp-meta',
                                  tekst: `ferdig for ${alder(o.ferdig)} siden`,
                                })
                              : null,
                          ),
                          el('button', {
                            type: 'button',
                            class: 'knapp knapp-kontur',
                            tekst: 'Avvik',
                            'aria-label': `Meld avvik på ${o.id}`,
                            onclick: () => {
                              aapnePanel(o.id, { fraInnboks: true });
                              panel.querySelector('#qa-tekst')?.focus();
                            },
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
          el(
            'div',
            { class: 'innboks-fot' },
            el('button', {
              type: 'button',
              class: 'knapp knapp-fylt',
              'data-fokus': 'qa-ok',
              tekst: n ? `QA ok for valgte (${n})` : 'QA ok for valgte',
              disabled: n === 0,
              onclick: async () => {
                const ider = [...t.valgtQa];
                if (await handling({ type: 'qa-ok', ider }, `QA ok: ${ider.join(', ')}`))
                  t.valgtQa.clear();
                tegnInnboks(true);
              },
            }),
          ),
        ),
      );
    }

    if (d.forslag.length) {
      const n = t.valgtForslag.size;
      deler.push(
        innboksDel(
          'forslag',
          'Forslag',
          d.forslag.length,
          el(
            'ul',
            { class: 'innboks-liste' },
            d.forslag.map((f) =>
              el(
                'li',
                { class: 'innboks-rad rad-kort' },
                el(
                  'label',
                  { class: 'rad-valg' },
                  avhuking(t.valgtForslag, f.id, `Velg ${f.id} for godkjenning`),
                  el('span', { class: 'sp-id', tekst: f.id }),
                  el('span', { class: 'rad-tittel', tekst: f.tittel }),
                  el('span', {
                    class: 'sp-meta',
                    tekst: `${f.klasse ?? '?'} · ${f.anslag} min · nytte ${f.nytte} · fra ${f.lagt_til_av ?? '?'}`,
                  }),
                ),
                el('button', {
                  type: 'button',
                  class: 'knapp knapp-tonet',
                  tekst: 'Godkjenn',
                  'aria-label': `Godkjenn ${f.id}`,
                  onclick: async () => {
                    await handling(
                      { type: 'godkjenn', id: f.id },
                      `${f.id} er godkjent og venter i køen`,
                    );
                    tegnInnboks(true);
                  },
                }),
              ),
            ),
          ),
          el(
            'div',
            { class: 'innboks-fot' },
            el('button', {
              type: 'button',
              class: 'knapp knapp-fylt',
              'data-fokus': 'godkjenn-valgte',
              tekst: n ? `Godkjenn valgte (${n})` : 'Godkjenn valgte',
              disabled: n === 0,
              onclick: async () => {
                const ider = [...t.valgtForslag];
                if (await handling({ type: 'godkjenn', ider }, `Godkjent: ${ider.join(', ')}`))
                  t.valgtForslag.clear();
                tegnInnboks(true);
              },
            }),
          ),
        ),
      );
    }

    if (d.henger.length)
      deler.push(
        innboksDel(
          'henger',
          'Henger',
          d.henger.length,
          el(
            'ul',
            { class: 'innboks-liste' },
            d.henger.map((h) =>
              el(
                'li',
                { class: 'innboks-rad rad-kort' },
                el(
                  'div',
                  { class: 'rad-valg' },
                  el('span', { class: 'sp-id', tekst: h.id }),
                  el('span', { class: 'rad-tittel', tekst: h.tittel }),
                  el('span', {
                    class: 'sp-meta',
                    tekst: h.aldrende
                      ? `${h.status === 'review' ? 'i review' : 'kjører'}, startet for ${varighet(h.aldrende.alder)} siden; ` +
                        `85 % av ${h.klasse ?? '?'}-oppgavene er ${h.aldrende.maal === 'arbeid' ? 'levert' : 'ferdige'} innen ${varighet(h.aldrende.grense)}`
                      : `plukket av ${h.plukket_av ?? '?'} for ${h.start ? alder(h.start) : '?'} siden, uten commits de siste 72 t`,
                  }),
                ),
                el('button', {
                  type: 'button',
                  class: 'knapp knapp-kontur',
                  tekst: 'Åpne',
                  'aria-label': `Åpne ${h.id}`,
                  onclick: () => aapnePanel(h.id, { fraInnboks: true }),
                }),
              ),
            ),
          ),
        ),
      );

    if (d.ulogget.length)
      deler.push(
        el('p', {
          class: 'innboks-info',
          tekst:
            `${d.ulogget.length} ${d.ulogget.length === 1 ? 'svar er' : 'svar er'} ikke ført i beslutningsloggen ennå ` +
            `(${d.ulogget.map((x) => x.sp).join(', ')}). Orkestratoren fører dem (ko.mjs avklaringer --ulogget).`,
        }),
      );

    panel.replaceChildren(...deler);
    panel.scrollTop = rull;
    if (fokus) panel.querySelector(`[data-fokus="${CSS.escape(fokus)}"]`)?.focus();
  }

  // ---- Detaljpanelet ----
  let panelFra = null;
  /**
   * Viser sidepanelet som en modal dialog: husker elementet som åpnet det (fokus går tilbake dit
   * ved lukking), og gjør resten av siden inert så Tab og skjermleseren blir i panelet. Fokusfella under fanger Tab
   * i endene. Alle som åpner panelet (detaljer, innboks, innstillinger, hjelp) går hit.
   */
  const PANEL_INERT = ['header.topp', '#fokuslinje', '#stripe', '#tavle', '#valglinje'];
  function visPanel() {
    if (panel.hidden) panelFra = document.activeElement;
    panel.hidden = false;
    bakgrunn.hidden = false;
    window.KoUu.settInert(
      PANEL_INERT.map((v) => document.querySelector(v)),
      true,
    );
  }
  panel.addEventListener('keydown', (e) => window.KoUu.fellaTast(e, panel));
  /** Åpner detaljpanelet og velger kjeden til kortet. `fraInnboks`: panelet får «Tilbake til Venter på deg». */
  function aapnePanel(id, { fraInnboks = false } = {}) {
    if (!t.perId.has(id)) return;
    t.innst = null;
    t.innboks = false;
    t.hjelp = false;
    t.fraInnboks = fraInnboks;
    t.valgt = id;
    visPanel();
    velgKjede(id);
    tegnPanel(true);
    panel.querySelector('.knapp-ikon')?.focus();
    if (!t.detaljer.has(id)) hentDetaljer(id);
  }
  function lukkPanel() {
    t.valgt = null;
    t.innst = null;
    t.innboks = false;
    t.hjelp = false;
    t.fraInnboks = false;
    panel.hidden = true;
    bakgrunn.hidden = true;
    panel.replaceChildren();
    // Inert av før fokus flyttes tilbake (et inert element kan ikke få fokus).
    window.KoUu.settInert(
      PANEL_INERT.map((v) => document.querySelector(v)),
      false,
    );
    tegnInnboksKnapp();
    // Er kortet som åpnet panelet tegnet på nytt imens, får det nye kortet med samme id fokus.
    // Kortet kan være bygget på nytt mens panelet var åpent: finn det igjen på id-en (på kortet er det knappen,
    // som har fokus; id-en står på kortet rundt den).
    const fraId = panelFra?.isConnected ? null : panelFra?.closest?.('[data-id]')?.dataset.id;
    if (fraId) {
      const ny = main.querySelector(`[data-id="${CSS.escape(fraId)}"]`);
      panelFra = ny?.querySelector('.kort-knapp') ?? ny;
    }
    if (panelFra?.isConnected) panelFra.focus();
    panelFra = null;
  }
  async function hentDetaljer(id) {
    try {
      const d = await api(`/api/oppgave?id=${encodeURIComponent(id)}`);
      t.detaljer.set(id, d);
    } catch (e) {
      t.detaljer.set(id, { feil: e.message });
    }
    if (t.valgt === id) tegnPanel();
  }

  function fakta(dt, dd) {
    if (dd == null || dd === '' || (Array.isArray(dd) && !dd.length)) return [];
    return [el('dt', { tekst: dt }), el('dd', null, dd)];
  }
  const liste2 = (verdier, kode) =>
    el(
      'ul',
      null,
      verdier.map((v) => el('li', null, kode ? el('code', { tekst: v }) : v)),
    );

  /** Tittelen på et område (oid) fra tavla, «Uten område» for uten-omrade, eller null når kortet ikke har område. */
  function omradeTittel(oid) {
    if (!oid) return null;
    if (oid === 'uten-omrade') return 'Uten område';
    return (t.data?.omrader ?? []).find((o) => o.oid === oid)?.tittel ?? oid;
  }

  /**
   * «Plassering» i detaljpanelet for et kort i kø: fokustrinnet (eller hvorfor det står utenfor), plassen
   * blant de klare i trinnet, hvem som dro det med, og poengene med formelen (koLogikk.scoreDeler, samme tall som
   * køen bruker).
   */
  function plasseringFakta(k, idKnapp) {
    const pl = k.plass;
    const f = t.data.fokus;
    let trinn;
    if (k.parkert) trinn = 'På vent (rangeres ikke før ventingen er over)';
    else if (!f?.aktiv) trinn = 'Ingen fokus (hele køen rangeres etter poeng)';
    else if (pl.steg == null)
      trinn = pl.ut
        ? `Utenfor fokus: ${pl.grunn ?? 'venter til fokuset er ferdig'}`
        : 'Utenfor fokus (fyller ledige plasser etter fokustrinnene)';
    else trinn = `T${pl.steg + 1} ${f.trinn?.[pl.steg]?.tittel ?? ''}`.trim();
    if (pl.nr && pl.av)
      trinn += ` · nr. ${pl.nr} av ${pl.av} klare ${f?.aktiv && pl.steg != null ? 'i trinnet' : 'her'}`;
    const sd = k.score_deler;
    const tall = (x) => String(Math.round(x * 100) / 100).replace('.', ',');
    const formel = sd
      ? `${tall(sd.score)} = nytte ${sd.nytte} / ${sd.minutter} min × 100 × låser opp (1 + 0,25 × ${sd.laaser_opp}) × ` +
        `alder (1 + 0,02 × ${tall(Math.min(sd.dager, 14))} d)` +
        (sd.tillegg
          ? ` ${sd.tillegg > 0 ? '+' : '−'} ${Math.abs(sd.tillegg)} (oppgavens tillegg)`
          : '') +
        (sd.prosjekt_tillegg
          ? ` ${sd.prosjekt_tillegg > 0 ? '+' : '−'} ${Math.abs(sd.prosjekt_tillegg)} (prosjektets tillegg)`
          : '')
      : String(k.score ?? '?');
    return [
      fakta('Plassering', trinn),
      fakta('Dratt med av', pl.dratt_av ? idKnapp(pl.dratt_av) : null),
      fakta(
        'Poeng',
        el('span', { tekst: formel, title: 'Høyere poeng startes først innen samme trinn.' }),
      ),
    ];
  }

  function tegnPanel(ny) {
    const funnet = t.perId.get(t.valgt);
    if (!funnet) return lukkPanel();
    // Ikke tegn om panelet mens eieren skriver i et felt der.
    if (
      !ny &&
      panel.contains(document.activeElement) &&
      /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)
    )
      return;
    const { k, kol } = funnet;
    const p = prosjekt(k.prosjekt);
    const d = t.detaljer.get(k.id);
    const rull = panel.scrollTop;

    const idKnapp = (id) => {
      const x = t.perId.get(id);
      return x
        ? el('button', {
            type: 'button',
            class: 'lenke-knapp',
            tekst: `${id} (${x.k.status})`,
            onclick: () => aapnePanel(id, { fraInnboks: t.fraInnboks }),
          })
        : el('code', { tekst: id });
    };
    const avhenger = k.avhenger.map(idKnapp);
    // «Låser opp»: de direkte etterfølgerne som klikkbare id-er, og hele kjeden som tall.
    const las = kol !== 'bygget' ? k.laaser_opp : null;
    const laaserOpp = las
      ? [
          ...las.direkte.map(idKnapp),
          el('span', {
            class: 'fakta-merknad',
            tekst: `totalt ${las.antall} via kjeden (${varighet(las.minutter)} anslått)`,
          }),
        ]
      : null;
    // Spørsmålsteksten (fra innboksen) for det kortet venter på og som ikke er avklart.
    const spTekst = new Map((t.data.innboks?.sporsmal ?? []).map((s) => [s.sp, s.tekst]));
    const gren = d?.gren
      ? d.gren.finnes
        ? `${d.gren.navn}: ${d.gren.commits} commit(s) foran ${t.data?.baseGren ?? 'main'}`
        : `${d.gren.navn} finnes ikke ennå`
      : d?.feil
        ? `kunne ikke lese (${d.feil})`
        : 'henter …';
    const status = k.samles
      ? 'I samlekøen (startes ikke alene; pakkes til et spor med ko.mjs samle pakk)'
      : ({
          venter: k.klar ? 'I kø, klar nå' : 'I kø, blokkert',
          forslag: 'Forslag (må godkjennes)',
          kjorer: 'Kjører',
          plukket: `Plukket av ${k.plukket_av ?? '?'}`,
          ekstern: `Arbeid utenfor køen (${k.ekstern_navn ?? '?'})`,
          review: 'Review',
          ferdig: 'Bygget',
        }[k.status] ?? k.status);

    panel.replaceChildren(
      el(
        'div',
        { class: 'panel-hode' },
        el(
          'div',
          null,
          t.fraInnboks
            ? el('button', {
                type: 'button',
                class: 'lenke-knapp tilbake',
                tekst: '← Venter på deg',
                onclick: () => aapneInnboks(),
              })
            : null,
          el('span', { class: 'kort-id', tekst: k.id }),
          el('h2', { id: 'panel-tittel', tekst: k.tittel }),
        ),
        el(
          'button',
          { type: 'button', class: 'knapp-ikon', 'aria-label': 'Lukk', onclick: lukkPanel },
          ikon('lukk'),
        ),
      ),
      el(
        'dl',
        { class: 'fakta' },
        fakta(
          'Status',
          `${status}${k.start ? ` · ${alder(k.start)}` : ''}${k.gammel ? ' · gammel' : ''}` +
            (k.aldrende ? ' · eldre enn vanlig for klassen' : ''),
        ),
        k.aldrende ? fakta('Alder', aldringTekst(k)) : [],
        fakta('På vent', k.parkert ? ventTekst(k.parkert) : null),
        fakta('Prosjekt', `${p?.tittel ?? k.prosjekt} (${k.prosjekt})`),
        fakta('Funksjon', k.funksjon),
        // Lenken til planposten (bytter til Planer med posten åpen).
        fakta(
          'Planpost',
          k.plan
            ? el('button', {
                type: 'button',
                class: 'lenke-knapp',
                tekst: [k.plan, window.KoPlaner?.tittel(k.plan)].filter(Boolean).join(' '),
                onclick: () => {
                  lukkPanel();
                  window.KoPlaner?.aapnePost(k.plan);
                },
              })
            : null,
        ),
        fakta(
          'Klasse',
          `${k.klasse ?? '?'} · nytte ${k.nytte} · ${k.anslag} min${k.domene ? ` · ${k.domene}` : ''}`,
        ),
        kol === 'ko' && k.plass ? plasseringFakta(k, idKnapp) : [],
        kol === 'ko' && !k.plass
          ? fakta(
              'Prioritet',
              `${k.score}${k.prioritet_tillegg ? ` (tillegg ${k.prioritet_tillegg > 0 ? '+' : ''}${k.prioritet_tillegg})` : ''}`,
            )
          : [],
        fakta('Område', omradeTittel(k.omrade)),
        fakta('Avhenger av', avhenger.length ? avhenger : null),
        fakta('Låser opp', laaserOpp),
        fakta(
          'Venter på',
          k.venter_paa.length
            ? liste2(
                k.venter_paa.map(
                  (v) =>
                    `${v.sp}${v.avklart ? ' (avklart)' : ''}` +
                    (spTekst.get(v.sp) ? `: ${spTekst.get(v.sp)}` : ''),
                ),
              )
            : null,
        ),
        kol === 'ko' && k.hindringer.length ? fakta('Hindringer', liste2(k.hindringer)) : [],
        fakta('Eierfiler', k.eier_filer.length ? liste2(k.eier_filer, true) : null),
        fakta('DB', k.eier_db.length ? liste2(k.eier_db, true) : null),
        fakta('Gren', gren),
        fakta('Sky', skyFakta(k)),
        fakta('Migrasjoner', k.migr_blokk),
        fakta('QA', k.qa_status ? `${k.qa_status}${k.qa_notat ? `: ${k.qa_notat}` : ''}` : null),
        fakta(
          'Kilde',
          [k.kilde, k.lagt_til_av ? `lagt til av ${k.lagt_til_av}` : null]
            .filter(Boolean)
            .join(' · '),
        ),
        fakta('Merknader', k.merknader.length ? liste2(k.merknader) : null),
      ),
      handlingerFor(k, kol),
      el(
        'section',
        { class: 'oppdrag', 'aria-label': 'Oppdraget' },
        el('h3', {
          class: 'oppdrag-tittel',
          tekst: d?.oppdrag?.sti ? `Oppdraget (${d.oppdrag.sti})` : 'Oppdraget',
        }),
        d?.oppdrag
          ? markdown(d.oppdrag.tekst)
          : el('p', { class: 'tom', tekst: d?.feil ?? 'Henter oppdraget …' }),
      ),
    );
    panel.scrollTop = rull;
  }

  function handlingerFor(k, kol) {
    const boks = el('div', { class: 'handlinger', 'aria-label': 'Handlinger' });
    if (kol === 'ko') {
      const navn = el('input', {
        id: 'plukk-navn',
        type: 'text',
        value: localStorage.getItem('ko-tavle-navn') ?? '',
        autocomplete: 'off',
      });
      boks.append(
        el('button', {
          type: 'button',
          class: 'knapp knapp-tonet',
          tekst: 'Til toppen av køen',
          onclick: () => flytt({ id: k.id, topp: true }, `${k.id} er øverst i køen`),
        }),
        el(
          'div',
          { class: 'felt' },
          el('label', { for: 'plukk-navn', tekst: 'Hvem plukker?' }),
          navn,
        ),
        el('button', {
          type: 'button',
          class: 'knapp knapp-fylt',
          tekst: 'Plukk',
          onclick: () => {
            const av = navn.value.trim();
            if (!av) return melding('Skriv hvem som plukker.', true);
            localStorage.setItem('ko-tavle-navn', av);
            handling({ type: 'plukk', id: k.id, av }, `${k.id} er plukket av ${av}`);
          },
        }),
      );
      // Send oppgaven til en skyøkt (lim inn pakka), og registrer at den er startet der.
      if (k.sky?.egnet) {
        const okt = el('input', {
          id: 'sky-okt',
          type: 'text',
          autocomplete: 'off',
          placeholder: 'https://claude.ai/code/…',
        });
        boks.append(
          el('button', {
            type: 'button',
            class: 'knapp knapp-tonet',
            tekst: 'Kopier skypakke',
            onclick: () => kopierSkypakke([k.id]),
          }),
          el(
            'div',
            { class: 'felt' },
            el('label', { for: 'sky-okt', tekst: 'Lenke til skyøkta (valgfri)' }),
            okt,
          ),
          el('button', {
            type: 'button',
            class: 'knapp knapp-tonet',
            tekst: 'Startet i sky',
            onclick: () =>
              handling(
                { type: 'sky-start', id: k.id, kjoring: okt.value.trim() || undefined },
                `${k.id} er startet i sky`,
              ),
          }),
        );
        const felt = skypakkeFelt([k.id]);
        if (felt) boks.append(felt);
      }
    } else if (k.i_sky) {
      // Skyøkta er ferdig (grenen sjekkes med git fetch av ko.mjs sky ferdig), eller avbrytes.
      const gren = el('input', {
        id: 'sky-gren',
        type: 'text',
        autocomplete: 'off',
        placeholder: k.gren,
      });
      boks.append(
        el(
          'div',
          { class: 'felt' },
          el('label', { for: 'sky-gren', tekst: 'Grenen skyen pushet (tom = ' + k.gren + ')' }),
          gren,
        ),
        el('button', {
          type: 'button',
          class: 'knapp knapp-fylt',
          tekst: 'Fullført i sky',
          onclick: () =>
            handling(
              { type: 'sky-ferdig', id: k.id, gren: gren.value.trim() || undefined },
              `${k.id} er fullført i sky og venter på fletting`,
            ),
        }),
        el('button', {
          type: 'button',
          class: 'knapp knapp-tonet',
          tekst: 'Kopier skypakke',
          onclick: () => kopierSkypakke([k.id]),
        }),
        el('button', {
          type: 'button',
          class: 'knapp knapp-kontur',
          tekst: 'Avbryt sky',
          onclick: () =>
            handling({ type: 'sky-avbryt', id: k.id }, `${k.id}: skyøkta er avbrutt, venter igjen`),
        }),
      );
      const felt = skypakkeFelt([k.id]);
      if (felt) boks.append(felt);
    } else if (k.status === 'plukket') {
      boks.append(
        el('button', {
          type: 'button',
          class: 'knapp knapp-tonet',
          tekst: 'Slipp',
          onclick: () =>
            handling({ type: 'slipp', id: k.id }, `${k.id} er sluppet og venter igjen`),
        }),
      );
    } else if (k.status === 'ferdig' && (k.qa_status === 'venter' || k.qa_status === 'avvik')) {
      boks.append(
        el('button', {
          type: 'button',
          class: 'knapp knapp-fylt',
          tekst: 'QA ok',
          onclick: () => handling({ type: 'qa-ok', id: k.id }, `${k.id}: QA ok`),
        }),
      );
      if (k.qa_status === 'venter') {
        const tekst = el('textarea', { id: 'qa-tekst', rows: 3 });
        boks.append(
          el(
            'div',
            { class: 'felt' },
            el('label', { for: 'qa-tekst', tekst: 'Hva er galt, og hvor?' }),
            tekst,
          ),
          el('button', {
            type: 'button',
            class: 'knapp knapp-fare',
            tekst: 'QA avvik',
            onclick: () => {
              const s = tekst.value.trim();
              if (!s) return melding('Skriv hva som er galt, og hvor.', true);
              handling(
                { type: 'qa-avvik', id: k.id, tekst: s },
                `${k.id}: QA-avvik, rettingsoppgave lagt i køen`,
              );
            },
          }),
        );
      }
    }
    // Merk og gjør (samme dialog med forhåndsvisning som valglinja).
    const merk = merkKnapper(k, kol);
    if (merk) boks.append(merk);
    if (!boks.children.length)
      boks.append(el('p', { class: 'ingen', tekst: 'Ingen handlinger for denne statusen.' }));
    return boks;
  }

  /**
   * Knappene i detaljpanelet for flervalg («Merk kjeden», «Merk funksjonen», merk dette kortet) og de
   * vanligste enkelthandlingene (på vent, samlekøen) for et kort som kan masseendres.
   */
  function merkKnapper(k, kol) {
    const deler = [];
    const kjede = k.kjede ? [k.id, ...k.kjede.for, ...k.kjede.etter].filter(merkbar) : [];
    const funksjon = k.funksjon
      ? [...t.perId.values()]
          .filter(
            (x) =>
              MERKBARE_KOLONNER.has(x.kol) &&
              x.k.prosjekt === k.prosjekt &&
              x.k.funksjon === k.funksjon,
          )
          .map((x) => x.k.id)
      : [];
    const kan = MERKBARE_KOLONNER.has(kol);
    if (kan)
      deler.push(
        el('button', {
          type: 'button',
          class: 'knapp knapp-kontur',
          tekst: t.merket.has(k.id) ? 'Fjern fra valget' : 'Merk kortet',
          title: 'Legg kortet til i valget (eller ta det ut). Snarvei: x på kortet, Ctrl-klikk.',
          onclick: () => merkMange([k.id], !t.merket.has(k.id)),
        }),
      );
    if (kjede.length > 1)
      deler.push(
        el('button', {
          type: 'button',
          class: 'knapp knapp-kontur',
          tekst: `Merk kjeden (${kjede.length})`,
          title:
            'Merk kortet, det det venter på, og det som venter på det (bare de som venter eller er forslag), ' +
            'så de kan flyttes eller settes på vent samlet.',
          onclick: () => merkMange(kjede, true),
        }),
      );
    if (funksjon.length > 1)
      deler.push(
        el('button', {
          type: 'button',
          class: 'knapp knapp-kontur',
          tekst: `Merk funksjonen (${funksjon.length})`,
          title: `Merk alle i kø og samlekøen i ${k.prosjekt} med funksjonen «${k.funksjon}».`,
          onclick: () => merkMange(funksjon, true),
        }),
      );
    if (kan) {
      deler.push(
        k.parkert
          ? el('button', {
              type: 'button',
              class: 'knapp knapp-tonet',
              tekst: 'Ta av vent',
              title: 'Oppgaven kan startes og plukkes igjen. Du ser endringen før den lagres.',
              onclick: () => aapneMasse('fortsett', [k.id]),
            })
          : el('button', {
              type: 'button',
              class: 'knapp knapp-tonet',
              tekst: 'Sett på vent',
              title:
                'Oppgaven blir stående i køen, men startes og plukkes ikke før du tar den av vent (eller datoen ' +
                'er passert). Du ser endringen før den lagres.',
              onclick: () => aapneMasse('parker', [k.id]),
            }),
        k.samles
          ? el('button', {
              type: 'button',
              class: 'knapp knapp-tonet',
              tekst: 'Ta ut av samlekøen',
              title: 'Oppgaven startes som eget spor igjen. Du ser endringen før den lagres.',
              onclick: () => aapneMasse('samle-ut', [k.id]),
            })
          : el('button', {
              type: 'button',
              class: 'knapp knapp-tonet',
              tekst: 'Legg i samlekøen',
              title:
                'Små oppgaver som ikke blokkerer noe, pakkes sammen til et spor av riktig størrelse i stedet for å ' +
                'startes alene. Du ser endringen før den lagres.',
              onclick: () => aapneMasse('samle-inn', [k.id]),
            }),
      );
    }
    if (!deler.length) return null;
    return el('div', { class: 'merk-handlinger', 'aria-label': 'Merk og samlet' }, deler);
  }

  // ---- Enkel markdown (overskrifter, lister, kodeblokker, tabeller som kode, **fet** og `kode`) ----
  function inline(tekst) {
    const ut = [];
    for (const del of tekst.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
      if (!del) continue;
      if (del.startsWith('`') && del.endsWith('`') && del.length > 1)
        ut.push(el('code', { tekst: del.slice(1, -1) }));
      else if (del.startsWith('**') && del.endsWith('**') && del.length > 4)
        ut.push(el('strong', { tekst: del.slice(2, -2) }));
      else ut.push(del.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'));
    }
    return ut;
  }
  function markdown(tekst) {
    const rot = document.createDocumentFragment();
    const linjer = String(tekst ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n');
    let avsnitt = [];
    let listeEl = null;
    const tomAvsnitt = () => {
      if (avsnitt.length) rot.append(el('p', null, inline(avsnitt.join(' '))));
      avsnitt = [];
    };
    const lukkListe = () => {
      listeEl = null;
    };
    for (let i = 0; i < linjer.length; i++) {
      const l = linjer[i];
      if (/^\s*```/.test(l)) {
        tomAvsnitt();
        lukkListe();
        const kode = [];
        while (++i < linjer.length && !/^\s*```/.test(linjer[i])) kode.push(linjer[i]);
        rot.append(el('pre', null, el('code', { tekst: kode.join('\n') })));
        continue;
      }
      if (/^\s*\|/.test(l)) {
        tomAvsnitt();
        lukkListe();
        const rader = [l];
        while (i + 1 < linjer.length && /^\s*\|/.test(linjer[i + 1])) rader.push(linjer[++i]);
        rot.append(el('pre', null, el('code', { tekst: rader.join('\n') })));
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (h) {
        tomAvsnitt();
        lukkListe();
        rot.append(el(h[1].length <= 2 ? 'h3' : 'h4', null, inline(h[2])));
        continue;
      }
      const li = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(l);
      if (li) {
        tomAvsnitt();
        const nummer = /^\s*\d/.test(l);
        if (!listeEl || listeEl.tagName !== (nummer ? 'OL' : 'UL')) {
          listeEl = el(nummer ? 'ol' : 'ul');
          rot.append(listeEl);
        }
        listeEl.append(el('li', null, inline(li[1])));
        continue;
      }
      if (!l.trim()) {
        tomAvsnitt();
        lukkListe();
        continue;
      }
      // Fortsettelse av et listepunkt (innrykket linje rett etter).
      if (listeEl && /^\s+\S/.test(l)) {
        listeEl.lastElementChild.append(' ', ...inline(l.trim()));
        continue;
      }
      lukkListe();
      avsnitt.push(l.trim());
    }
    tomAvsnitt();
    return rot;
  }

  // ---- Flervalg og massehandlinger ----
  // Eieren merker kort (avkryssingsboks, x, Ctrl/Cmd-klikk, Shift-klikk, Ctrl/Cmd+A, «Merk alle treff», gruppe, bane,
  // kjede eller funksjon) og gjør én ting med alle fra valglinja nederst. Hver handling forhåndsvises først
  // (/api/masse med torr: ko.mjs regner ut hva som endres, uten å skrive), og lagres først når eieren trykker
  // «Gjør det» (med køens versjon fra forhåndsvisningen, så en kø som er endret imens ikke overkjøres). Etterpå ligger
  // «Angre» klar i 30 sekunder, og «Angre siste» i tannhjulet. Tavla sender alltid id-lista eieren så.

  /** Et tekstfelt der tastene hører til feltet (avkryssingsbokser teller ikke). */
  function skrivefelt(e) {
    if (!e) return false;
    if (e.tagName === 'TEXTAREA' || e.tagName === 'SELECT') return true;
    return e.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(e.type);
  }

  /** Kan kortet masseendres nå (i kø, forslag eller samlekøen)? */
  function merkbar(id) {
    const x = t.perId.get(id);
    return !!x && MERKBARE_KOLONNER.has(x.kol);
  }

  /** «På vent til og med 2026-10-12: venter på leverandør (satt av eier)». */
  function ventTekst(p) {
    return (
      `På vent${p.til ? ` til og med ${String(p.til).slice(0, 10)}` : ' til du tar den av'}` +
      (p.grunn ? `: ${p.grunn}` : '') +
      (p.av ? ` (satt av ${p.av})` : '') +
      '. Den står i køen, men startes og plukkes ikke.'
    );
  }

  /** Avkryssingsboksen på et kort (vises ved hover og fokus, og alltid når noe er merket). */
  function merkBoks(k) {
    return el(
      'label',
      {
        class: 'merk-boks',
        title:
          'Merk kortet for valglinja (massehandlinger). Snarveier: x på kortet, Ctrl/Cmd-klikk, Shift-klikk merker ' +
          'alt fra forrige merkede, Ctrl/Cmd+A merker alle treff, Esc tømmer valget.',
      },
      el('input', {
        type: 'checkbox',
        checked: t.merket.has(k.id),
        'aria-label': `Merk ${k.id}`,
        tabindex: '-1', // roving tabindex: bare kortet som er stopp i kolonnen; x merker også
        onclick: (e) => {
          // Shift-klikk på boksen merker også alt fra forrige merkede.
          if (e.shiftKey && t.anker && t.anker !== k.id) {
            e.preventDefault();
            merkOmraade(t.anker, k.id);
          }
        },
        onchange: (e) => merkMange([k.id], e.target.checked),
      }),
    );
  }

  /** Merker (pa = true) eller fjerner id-ene fra valget, og tegner valget på nytt. */
  function merkMange(ider, pa) {
    for (const id of ider) {
      if (!merkbar(id)) continue;
      if (pa) t.merket.add(id);
      else t.merket.delete(id);
    }
    const siste = ider.filter(merkbar).pop();
    if (pa && siste) t.anker = siste;
    oppdaterMerking();
  }

  /** Shift: merker alle kort som står mellom `fra` og `til` på tavla nå (begge med). */
  function merkOmraade(fra, til) {
    const rekke = [...main.querySelectorAll('.kort[data-merkbar]:not([hidden])')].map(
      (e) => e.dataset.id,
    );
    const i = rekke.indexOf(fra);
    const j = rekke.indexOf(til);
    if (i < 0 || j < 0) return merkMange([til], true);
    merkMange(rekke.slice(Math.min(i, j), Math.max(i, j) + 1), true);
    t.anker = til;
  }

  /** Kortene som vises etter søk og filter og kan masseendres (det «Merk alle treff» og Ctrl+A tar). */
  function synligeMerkbare() {
    if (!t.data) return [];
    const ut = [];
    for (const kol of MERKBARE_KOLONNER)
      for (const k of t.data.kolonner[kol] ?? []) if (synlig(k, kol)) ut.push(k.id);
    return ut;
  }

  function merkAlleTreff() {
    const ider = synligeMerkbare();
    if (!ider.length)
      return melding('Ingen kort i kø, forslag eller samlekøen passer søket og filteret.', true);
    merkMange(ider, true);
    melding(
      `${ider.length} merket. Velg en handling i linja nederst, eller Esc for å tømme valget.`,
    );
  }

  function tomValg() {
    t.merket.clear();
    t.anker = null;
    oppdaterMerking();
  }

  function oppdaterMerking() {
    if (dra || loftet) return;
    // I Flat og Prosjektbaner settes merkingen på kortene som står (ingen ombygging).
    if (t.data && (t.visning === 'flat' || t.visning === 'baner')) {
      for (const node of main.querySelectorAll('.kort[data-merkbar]')) synkKort(node);
      main.classList.toggle('har-valg', t.merket.size > 0);
      oppdaterSokAvh(); // gruppeboksene, «Merk» i banehodet og samlekøen
      tegnValglinje();
      tegnMerkTreff();
      if (t.valgt) tegnPanel();
      return;
    }
    tegn();
  }

  /** «Merk alle treff (N)» ved søket: når søk eller filter er i bruk, og noe kan merkes. */
  function tegnMerkTreff() {
    const knapp = $('merk-treff');
    const sok = !!t.filter.sok || antallFiltre() > 0;
    const ider = sok && t.visning !== 'statistikk' && t.visning !== 'sky' ? synligeMerkbare() : [];
    knapp.hidden = !ider.length;
    if (!ider.length) return;
    const alle = ider.every((id) => t.merket.has(id));
    knapp.textContent = alle
      ? `Alle treff merket (${ider.length})`
      : `Merk alle treff (${ider.length})`;
    knapp.disabled = alle;
    knapp.title =
      'Merk alle kort som vises etter søket og filteret og kan endres samlet (i kø, forslag og samlekøen). ' +
      'Snarvei: Ctrl/Cmd+A.';
  }
  $('merk-treff').addEventListener('click', merkAlleTreff);

  // Hva hver handling gjør (tittel, forklaring i dialogen, verktøytips på knappen i valglinja).
  const MASSE_INFO = {
    prosjekt: {
      tittel: 'Flytt til prosjekt',
      forklaring:
        'Oppgavene får et fast prosjekt. Prosjektet styrer banen, fargen, pausen og prioritetstillegget de får.',
    },
    funksjon: {
      tittel: 'Sett funksjon',
      forklaring:
        'Funksjonen grupperer oppgavene innen prosjektet (prosjekt, funksjon, oppgave). Tomt felt fjerner funksjonen.',
    },
    parker: {
      tittel: 'Sett på vent',
      forklaring:
        'Oppgavene blir stående i køen med status venter, men startes og plukkes ikke før du tar dem av vent. ' +
        'Med en dato slutter ventingen av seg selv etter den dagen.',
    },
    fortsett: {
      tittel: 'Ta av vent',
      forklaring: 'Oppgavene kan startes og plukkes igjen, i den rekkefølgen prioriteten gir.',
    },
    ranger: {
      tittel: 'Flytt som blokk',
      forklaring:
        'Oppgavene flyttes samlet innen fokustrinnet og beholder rekkefølgen seg imellom. Tavla regner ut nye ' +
        'prioritetstillegg; poengene ellers endres ikke.',
    },
    'samle-inn': {
      tittel: 'Legg i samlekøen',
      forklaring:
        'Små oppgaver som ikke blokkerer noe, startes ikke alene, men pakkes sammen til et spor av riktig størrelse. ' +
        'D+, oppgaver andre venter på, og oppgaver med ubesvarte eierspørsmål kan ikke ligge der.',
    },
    'samle-ut': {
      tittel: 'Ta ut av samlekøen',
      forklaring: 'Oppgavene startes som egne spor igjen, i den rekkefølgen prioriteten gir.',
    },
    'samle-pakk': {
      tittel: 'Pakk til spor',
      forklaring:
        'Oppgavene slås sammen til ett nytt spor med samme klasse: innholdsminuttene legges sammen, eierskap og ' +
        'avhengigheter samles, og oppdragsfila får alle delenes oppdrag. Delene kanselleres med merknad. Pakking ' +
        'kan ikke angres med «Angre».',
    },
    etikett: {
      tittel: 'Etikett',
      forklaring:
        'Legg til eller fjern en etikett (ett kort ord i små bokstaver). Etiketten «visuell» gir QA-kø når oppgaven er ' +
        'ferdig.',
    },
    angre: {
      tittel: 'Angre siste endring',
      forklaring:
        'Ruller tilbake den siste posten i endringsloggen. Det nektes når noen har endret de samme feltene siden.',
    },
    // «Sorter»-lista i «Venter på deg».
    'godta-forslag': {
      tittel: 'Godta forslag til prosjekt',
      forklaring:
        'Hver oppgave får prosjektet køen foreslår ut fra prefiks, planen den kommer fra og filene den rører. ' +
        'Prosjektet bestemmer området og dermed fokustrinnet oppgaven havner i. Kan angres.',
    },
  };
  // Handlingene der alle felt er valgfrie: forhåndsvisningen kommer med en gang dialogen åpnes.
  const AUTO_FORHAND = new Set([
    'fortsett',
    'samle-inn',
    'samle-ut',
    'samle-pakk',
    'parker',
    'godta-forslag',
  ]);

  const antallTekst = (n) => `${n} ${n === 1 ? 'oppgave' : 'oppgaver'}`;

  /** Valglinja nederst: antall (og hvor mange som er skjult av filteret), minutter og handlingene. */
  function tegnValglinje() {
    const linje = $('valglinje');
    const kort = [...t.merket].map((id) => t.perId.get(id)).filter(Boolean);
    if (!kort.length || !t.data || t.visning === 'statistikk') {
      linje.hidden = true;
      linje.replaceChildren();
      document.body.classList.remove('med-valglinje');
      return;
    }
    const skjult = kort.filter((x) => !synlig(x.k, x.kol)).length;
    const min = kort.reduce((s, x) => s + (Number(x.k.anslag) || 0), 0);
    const alleSamle = kort.every((x) => x.kol === 'samle');
    const noenSamle = kort.some((x) => x.kol === 'samle');
    const noenParkert = kort.some((x) => x.k.parkert);
    const knapp = (tekst, tittel, fn, klasse = 'knapp-kontur') =>
      el('button', {
        type: 'button',
        class: `knapp ${klasse} knapp-liten`,
        tekst,
        title: tittel,
        onclick: fn,
      });
    linje.replaceChildren(
      el('p', {
        class: 'valg-tall',
        tekst:
          `${kort.length} valgt` +
          (skjult ? ` (${skjult} skjult av filteret)` : '') +
          ` · ${varighet(min)}`,
        title: skjult
          ? `${skjult} av de merkede vises ikke med søket og filteret nå, men er med i handlingen.`
          : 'Antall merkede og summen av anslagene.',
      }),
      el(
        'div',
        { class: 'valg-knapper', role: 'toolbar', 'aria-label': 'Massehandlinger for de merkede' },
        knapp(
          'Flytt til prosjekt',
          `${MASSE_INFO.prosjekt.forklaring} Du ser endringen før den lagres.`,
          () => aapneMasse('prosjekt'),
        ),
        knapp('Funksjon', MASSE_INFO.funksjon.forklaring, () => aapneMasse('funksjon')),
        knapp('Sett på vent', MASSE_INFO.parker.forklaring, () => aapneMasse('parker')),
        noenParkert
          ? knapp('Ta av vent', MASSE_INFO.fortsett.forklaring, () => aapneMasse('fortsett'))
          : null,
        knapp('Flytt som blokk', MASSE_INFO.ranger.forklaring, () => aapneMasse('ranger')),
        !alleSamle
          ? knapp('Legg i samlekøen', MASSE_INFO['samle-inn'].forklaring, () =>
              aapneMasse('samle-inn'),
            )
          : null,
        noenSamle
          ? knapp('Ta ut av samlekøen', MASSE_INFO['samle-ut'].forklaring, () =>
              aapneMasse('samle-ut'),
            )
          : null,
        alleSamle && kort.length >= 2
          ? knapp(
              'Pakk til spor',
              MASSE_INFO['samle-pakk'].forklaring,
              () => aapneMasse('samle-pakk'),
              'knapp-tonet',
            )
          : null,
        knapp('Etikett', MASSE_INFO.etikett.forklaring, () => aapneMasse('etikett')),
        knapp('Tøm valget', 'Fjern alle fra valget (Esc). Ingenting i køen endres.', tomValg),
      ),
    );
    linje.hidden = false;
    document.body.classList.add('med-valglinje');
  }

  // ---- Dialogen for en massehandling: felt, forhåndsvisning, «Gjør det» ----
  const masseBakgrunn = $('masse-bakgrunn');
  const masseBoks = $('masse');

  /** Handlingen serveren får (etikett-dialogen velger legg eller fjern). */
  const masseHandling = (m) =>
    m.type === 'etikett' ? (m.verdi.fjern ? 'etikett-fjern' : 'etikett-legg') : m.type;

  /** Det som mangler før forhåndsvisningen kan regnes ut, eller null. */
  function masseMangler(m) {
    const v = m.verdi;
    if (m.type === 'prosjekt' && !v.valgt) return 'Velg prosjektet oppgavene skal til.';
    if (m.type === 'ranger') {
      if (!v.plass) return 'Velg hvor blokken skal stå.';
      if ((v.plass === 'over' || v.plass === 'under') && !v.ref)
        return 'Skriv id-en til oppgaven blokken skal stå ved.';
    }
    if (m.type === 'etikett' && !v.etikett) return 'Skriv etiketten.';
    return null;
  }

  /** Feltene for handlingen (null når den ikke har noen). Endrer et felt, må forhåndsvisningen regnes på nytt. */
  function masseFelt(type) {
    const sett = (felt, verdi) => {
      if (!t.masse) return;
      t.masse.verdi[felt] = verdi;
      t.masse.forhand = null;
      t.masse.feil = null;
      tegnForhand();
    };
    const enter = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        forhandsvisMasse();
      }
    };
    const felt = (id, etikett, kontroll, hjelp) =>
      el(
        'div',
        { class: 'felt' },
        el('label', { for: id, tekst: etikett }),
        kontroll,
        hjelp ? el('p', { class: 'felt-hjelp', tekst: hjelp }) : null,
      );
    const tekstfelt = (id, navn, attr = {}) =>
      el('input', {
        id,
        type: 'text',
        autocomplete: 'off',
        oninput: (e) => sett(navn, e.target.value.trim() || null),
        onkeydown: enter,
        ...attr,
      });
    const datalist = (id, verdier) =>
      el(
        'datalist',
        { id },
        [...new Set(verdier)].sort().map((v) => el('option', { value: v })),
      );
    const alleKort = [...t.perId.values()].map((x) => x.k);

    if (type === 'prosjekt') {
      const valg = el(
        'select',
        {
          id: 'masse-prosjekt',
          onchange: (e) => {
            const v = e.target.value;
            t.masse.verdi.valgt = v !== '';
            sett('pid', v === '' || v === '__ingen' ? null : v);
            if (v !== '') forhandsvisMasse();
          },
        },
        el('option', { value: '', tekst: 'Velg prosjekt …' }),
        (t.data.prosjekter ?? [])
          .filter((p) => p.pid !== 'uten-prosjekt')
          .map((p) =>
            el('option', {
              value: p.pid,
              tekst: `${p.tittel ?? p.pid} (${p.pid})${p.pause ? ', pauset' : ''}`,
            }),
          ),
        el('option', { value: '__ingen', tekst: 'Ingen fast prosjekt (følg prefiksen)' }),
      );
      return felt(
        'masse-prosjekt',
        'Prosjekt',
        valg,
        'Nytt prosjekt lages med ko.mjs prosjekt <pid> --tittel "…".',
      );
    }
    if (type === 'funksjon')
      return el(
        'div',
        null,
        felt(
          'masse-funksjon',
          'Funksjon',
          tekstfelt('masse-funksjon', 'navn', { list: 'masse-funksjoner' }),
          'Tomt felt fjerner funksjonen. Forslagene er funksjonene som finnes i køen.',
        ),
        datalist('masse-funksjoner', alleKort.map((k) => k.funksjon).filter(Boolean)),
      );
    if (type === 'parker')
      return el(
        'div',
        null,
        felt(
          'masse-grunn',
          'Grunn (valgfri)',
          tekstfelt('masse-grunn', 'grunn', { maxlength: 200 }),
        ),
        felt(
          'masse-til',
          'Til og med dato (valgfri)',
          el('input', {
            id: 'masse-til',
            type: 'date',
            min: new Date().toISOString().slice(0, 10),
            onchange: (e) => sett('til', e.target.value || null),
          }),
          'Uten dato står oppgavene på vent til du tar dem av.',
        ),
      );
    if (type === 'ranger') {
      const ref = el(
        'div',
        { class: 'felt', hidden: true },
        el('label', { for: 'masse-ref', tekst: 'Oppgaven blokken skal stå ved' }),
        tekstfelt('masse-ref', 'ref', { list: 'masse-ider' }),
        datalist(
          'masse-ider',
          (t.data.kolonner.ko ?? []).map((k) => k.id).filter((id) => !t.masse?.ider.includes(id)),
        ),
      );
      const plass = el(
        'select',
        {
          id: 'masse-plass',
          onchange: (e) => {
            const v = e.target.value;
            ref.hidden = !(v === 'over' || v === 'under');
            sett('plass', v || null);
            if (v === 'topp' || v === 'bunn') forhandsvisMasse();
          },
        },
        el('option', { value: '', tekst: 'Velg plass …' }),
        el('option', { value: 'topp', tekst: 'Øverst i trinnet' }),
        el('option', { value: 'bunn', tekst: 'Nederst i trinnet' }),
        el('option', { value: 'over', tekst: 'Rett over en annen oppgave' }),
        el('option', { value: 'under', tekst: 'Rett under en annen oppgave' }),
      );
      return el('div', null, felt('masse-plass', 'Plass', plass), ref);
    }
    if (type === 'etikett')
      return el(
        'div',
        null,
        felt(
          'masse-etikett-valg',
          'Handling',
          el(
            'select',
            {
              id: 'masse-etikett-valg',
              onchange: (e) => sett('fjern', e.target.value === 'fjern'),
            },
            el('option', { value: 'legg', tekst: 'Legg til etiketten' }),
            el('option', { value: 'fjern', tekst: 'Fjern etiketten' }),
          ),
        ),
        felt(
          'masse-etikett',
          'Etikett',
          tekstfelt('masse-etikett', 'etikett', { list: 'masse-etiketter', maxlength: 31 }),
        ),
        datalist(
          'masse-etiketter',
          alleKort.flatMap((k) => k.etiketter ?? []),
        ),
      );
    if (type === 'samle-pakk')
      return el(
        'div',
        null,
        felt(
          'masse-ny-id',
          'Id for det nye sporet (valgfri)',
          tekstfelt('masse-ny-id', 'ny_id', { maxlength: 41, placeholder: 'foreslås automatisk' }),
        ),
        felt(
          'masse-tittel-felt',
          'Tittel (valgfri)',
          tekstfelt('masse-tittel-felt', 'tittel', { maxlength: 200 }),
        ),
      );
    return null;
  }

  /** Åpner dialogen for en massehandling på de merkede (eller id-ene som er gitt, f.eks. en samlegruppe). */
  function aapneMasse(type, ider) {
    const liste = (ider ?? [...t.merket]).filter(merkbar);
    if (!liste.length)
      return melding(
        'Ingen av kortene kan endres samlet (bare de som venter, forslag og samlekøen).',
        true,
      );
    const info = MASSE_INFO[type];
    t.masse = {
      type,
      ider: liste,
      verdi: {},
      forhand: null,
      laster: false,
      feil: null,
      merknad: null,
      fra: document.activeElement,
    };
    const felt = masseFelt(type);
    byggDialog(
      info,
      felt,
      `${antallTekst(liste.length)}: ${liste.slice(0, 12).join(', ')}${liste.length > 12 ? ' …' : ''}`,
    );
    if (AUTO_FORHAND.has(type)) forhandsvisMasse();
    else tegnForhand();
  }

  /** «Angre siste» (tannhjulet): viser posten som rulles tilbake, og om det går nå. */
  function aapneAngre() {
    lukkPanel();
    t.masse = {
      type: 'angre',
      ider: [],
      verdi: {},
      forhand: null,
      laster: false,
      feil: null,
      merknad: null,
      fra: document.activeElement,
    };
    byggDialog(MASSE_INFO.angre, null, null);
    forhandsvisMasse();
  }

  function byggDialog(info, felt, antall) {
    const m = t.masse;
    const avbryt = el('button', {
      type: 'button',
      class: 'knapp knapp-kontur',
      tekst: 'Avbryt',
      title: 'Lukk uten å endre noe (Esc)',
      onclick: lukkMasse,
    });
    const gjor = el('button', {
      type: 'button',
      class: 'knapp knapp-fylt',
      tekst: m.type === 'angre' ? 'Angre' : 'Gjør det',
      disabled: true,
      onclick: utforMasse,
    });
    const vis = felt
      ? el('button', {
          type: 'button',
          class: 'knapp knapp-tonet',
          tekst: 'Vis endringene',
          title:
            'Regner ut hva som endres, uten å lagre noe (Enter i et tekstfelt gjør det samme).',
          onclick: forhandsvisMasse,
        })
      : null;
    const forhand = el('div', { class: 'masse-forhand', 'aria-live': 'polite' });
    m.el = { forhand, gjor };
    // Som fokuslinja: replaceChildren gjør null om til teksten «null», så tomme deler filtreres bort.
    masseBoks.replaceChildren(
      ...[
        el('h2', { id: 'masse-tittel', tekst: info.tittel }),
        el('p', { id: 'masse-forklaring', class: 'masse-forklaring', tekst: info.forklaring }),
        antall ? el('p', { class: 'masse-antall', tekst: antall }) : null,
        felt,
        vis ? el('div', { class: 'masse-vis' }, vis) : null,
        forhand,
        el('div', { class: 'vakt-knapper' }, avbryt, gjor),
      ].filter(Boolean),
    );
    masseBakgrunn.hidden = false;
    (masseBoks.querySelector('select, input') ?? avbryt).focus();
  }

  function lukkMasse() {
    const fra = t.masse?.fra;
    t.masse = null;
    masseBakgrunn.hidden = true;
    masseBoks.replaceChildren();
    if (fra?.isConnected) fra.focus();
  }
  masseBoks.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      lukkMasse();
    } else {
      // Fokus blir i dialogen (den felles fella i uu.js).
      window.KoUu.fellaTast(e, masseBoks);
    }
  });
  masseBakgrunn.addEventListener('click', (e) => {
    if (e.target === masseBakgrunn) lukkMasse();
  });

  /** Forhåndsvisningen: hva som endres, vaktreglene og advarslene. Skriver ingenting. */
  async function forhandsvisMasse() {
    const m = t.masse;
    if (!m || m.laster) return;
    const mangler = m.type === 'angre' ? null : masseMangler(m);
    if (mangler) {
      m.forhand = null;
      m.feil = mangler;
      return tegnForhand();
    }
    m.laster = true;
    m.feil = null;
    m.forhand = null;
    tegnForhand();
    try {
      const svar =
        m.type === 'angre'
          ? await api('/api/angre', { vis: true })
          : await api('/api/masse', {
              handling: masseHandling(m),
              ider: m.ider,
              verdi: m.verdi,
              torr: true,
            });
      if (t.masse !== m) return;
      m.forhand = svar;
    } catch (e) {
      if (t.masse !== m) return;
      m.feil = e.message;
    }
    m.laster = false;
    tegnForhand();
  }

  /** Det nye sporet i forhåndsvisningen av «Pakk til spor». */
  function pakkeVisning(p) {
    const n = p.ny;
    return el(
      'section',
      { class: 'masse-pakke', 'aria-label': 'Det nye sporet' },
      el('h3', { class: 'masse-pakke-tittel', tekst: `Nytt spor ${n.id}` }),
      el(
        'dl',
        { class: 'fakta' },
        fakta('Tittel', n.tittel || '(ingen)'),
        fakta(
          'Klasse',
          `${n.klasse ?? '?'} · ${n.innhold_min} min innhold · nytte ${n.nytte}` +
            (n.migr_tiere ? ` · ${n.migr_tiere} migrasjonstiere` : ''),
        ),
        fakta('Prosjekt', `${n.prosjekt}${n.funksjon ? ` · ${n.funksjon}` : ''}`),
        fakta(
          'Status',
          n.status === 'venter' ? 'venter (kan startes)' : `${n.status} (må godkjennes)`,
        ),
        fakta('Avhenger av', n.avhenger.length ? n.avhenger.join(', ') : null),
        fakta('Venter på', n.venter_paa.length ? n.venter_paa.join(', ') : null),
        fakta('Eierfiler', n.eier_filer.length ? liste2(n.eier_filer.slice(0, 30), true) : null),
        fakta('Etiketter', n.etiketter.length ? n.etiketter.join(', ') : null),
        fakta('Kanselleres', p.kansellert.join(', ')),
        fakta('Pekes om', p.omdirigert.length ? p.omdirigert.join(', ') : null),
        fakta('Oppdrag', n.oppdrag),
      ),
    );
  }

  function tegnForhand() {
    const m = t.masse;
    if (!m?.el) return;
    const f = m.forhand;
    const deler = [];
    if (m.merknad)
      deler.push(el('p', { class: 'masse-merknad', role: 'status', tekst: m.merknad }));
    if (m.laster) deler.push(el('p', { class: 'tom', tekst: 'Regner ut endringen …' }));
    if (m.feil) deler.push(el('p', { class: 'masse-feil', role: 'alert', tekst: m.feil }));
    const liste = (tekster, klasse) =>
      tekster.length
        ? el(
            'ul',
            { class: `vakt-liste ${klasse}` },
            tekster.map((x) => el('li', { tekst: x })),
          )
        : null;
    let kan = false;
    if (f && m.type === 'angre') {
      kan = f.kan === true;
      deler.push(
        f.post
          ? el('p', {
              class: 'masse-oppsummering',
              tekst:
                `Nr. ${f.post.nr}: ${f.post.handling} av ${f.post.av}, for ${alder(f.post.at)} siden. ` +
                'Feltene under settes tilbake til verdien før pilen.',
            })
          : null,
        liste(f.feil ?? [], 'masse-stopp'),
      );
      if (f.linjer?.length) deler.push(linjeListe(f.linjer, f.linjer.length));
    } else if (f) {
      const vakt = f.vakt ?? [];
      const tekst = (niv) => vakt.filter((v) => v.nivaa === niv).map((v) => v.tekst);
      kan = f.kan === true;
      deler.push(
        el('p', { class: 'masse-oppsummering', tekst: f.oppsummering }),
        liste([...tekst('stopp'), ...(f.feil ?? [])], 'masse-stopp'),
        liste([...tekst('advarsel'), ...(f.advarsler ?? [])], 'masse-advarsel'),
        liste(tekst('info'), 'masse-info'),
      );
      if (f.pakke) deler.push(pakkeVisning(f.pakke));
      if (f.linjer?.length) deler.push(linjeListe(f.linjer, f.felt));
      else if (!f.pakke && kan)
        deler.push(el('p', { class: 'tom', tekst: 'Ingenting endres: alle er allerede slik.' }));
    }
    m.el.forhand.replaceChildren(...deler.filter(Boolean));
    // «Gjør det» bare når forhåndsvisningen er gyldig og har noe å gjøre.
    const tom = f && m.type !== 'angre' && !f.pakke && !f.linjer?.length;
    m.el.gjor.disabled = !kan || m.laster || !!tom;
    m.el.gjor.title = !f
      ? 'Se endringene først'
      : !kan
        ? 'Kan ikke gjøres: se grunnen over'
        : m.type === 'angre'
          ? 'Ruller tilbake endringen slik den vises over'
          : 'Lagrer endringen slik forhåndsvisningen viser den. «Angre» ligger klar etterpå.';
  }

  /** Endringslinjene («A-1 prosjekt: alfa → beta»), sammenfoldet når de er mange. */
  function linjeListe(linjer, antall) {
    return el(
      'details',
      { class: 'masse-linjer', open: linjer.length <= 12 },
      el('summary', { tekst: `Endringene felt for felt (${antall})` }),
      el(
        'ul',
        null,
        linjer.map((l) => el('li', null, el('code', { tekst: l }))),
      ),
    );
  }

  /** «Gjør det»: skriver med køens versjon fra forhåndsvisningen. Er køen endret imens, vises den på nytt. */
  async function utforMasse() {
    const m = t.masse;
    const f = m?.forhand;
    if (!f?.kan || m.laster) return;
    m.laster = true;
    tegnForhand();
    if (m.type === 'angre') {
      lukkMasse();
      return angreNr(f.post?.nr ?? null);
    }
    const verdi =
      m.type === 'samle-pakk' && !m.verdi.ny_id && f.pakke
        ? { ...m.verdi, ny_id: f.pakke.ny.id }
        : m.verdi;
    let svar;
    try {
      svar = await api('/api/masse', {
        handling: masseHandling(m),
        ider: m.ider,
        verdi,
        torr: false,
        forvent: f.endret ?? undefined,
        bekreft: true,
      });
    } catch (e) {
      if (t.masse !== m) return;
      m.laster = false;
      if (e.svar?.utdatert) {
        // Køen er endret siden forhåndsvisningen: hent den, og vis endringen på nytt før eieren bekrefter.
        m.merknad =
          'Køen ble endret mens du så på forhåndsvisningen. Her er den på nytt; se over før du bekrefter.';
        await oppdater(true);
        return forhandsvisMasse();
      }
      m.feil = e.message;
      return tegnForhand();
    }
    const info = MASSE_INFO[m.type];
    lukkMasse();
    const tekst =
      m.type === 'samle-pakk'
        ? `Pakket ${antallTekst(m.ider.length)} til ${svar.ny_id}.`
        : `${info.tittel}: ${antallTekst(m.ider.length)}.`;
    if (svar.logg) angreToast(svar.logg, tekst, svar.info);
    else meldingMedInfo(tekst, svar);
    await oppdater(true);
  }

  // ---- «Angre» (30 sekunder etter en massehandling) og «Angre siste» (tannhjulet) ----
  let angreTid = null;
  function angreToast(nr, tekst, info) {
    const boks = $('angre-melding');
    const linjer = [tekst, ...(Array.isArray(info) ? info : [])].join('\n');
    boks.replaceChildren(
      el('span', { class: 'angre-tekst', tekst: linjer }),
      el('button', {
        type: 'button',
        class: 'knapp knapp-tonet knapp-liten',
        tekst: 'Angre',
        title:
          `Ruller tilbake akkurat denne endringen (nr. ${nr} i endringsloggen). Det nektes når noen har endret ` +
          'de samme feltene siden.',
        onclick: () => angreNr(nr),
      }),
      el(
        'button',
        {
          type: 'button',
          class: 'knapp-ikon',
          'aria-label': 'Lukk meldingen',
          title: 'Lukk meldingen («Angre siste» ligger også i tannhjulet)',
          onclick: lukkAngreToast,
        },
        ikon('lukk'),
      ),
    );
    visToast('angre');
    clearTimeout(angreTid);
    angreTid = setTimeout(lukkAngreToast, 30_000);
  }
  function lukkAngreToast() {
    clearTimeout(angreTid);
    const boks = $('angre-melding');
    skjulToast('angre');
    boks.replaceChildren();
  }
  async function angreNr(nr) {
    lukkAngreToast();
    try {
      const svar = await api('/api/angre', nr ? { nr } : {});
      melding(svar.melding ?? 'Angret.');
    } catch (e) {
      melding(`Kunne ikke angre: ${e.message}`, true);
    }
    await oppdater(true);
  }

  /** Delen i tannhjulet: den siste endringen som kan angres. */
  function angreSeksjon() {
    const a = t.data?.angre;
    return el(
      'section',
      { class: 'innst', 'aria-labelledby': 'innst-angre' },
      el('h3', { id: 'innst-angre', class: 'innst-tittel', tekst: 'Angre siste' }),
      a
        ? el('p', {
            tekst:
              `Nr. ${a.nr}: ${a.handling} av ${a.av}, for ${alder(a.at)} siden ` +
              `(${a.felt} felt i ${antallTekst(a.oppgaver)}).`,
          })
        : el('p', {
            class: 'tom',
            tekst: 'Ingenting å angre: endringsloggen er tom, eller alt i den er angret.',
          }),
      a
        ? el('button', {
            type: 'button',
            class: 'knapp knapp-kontur',
            tekst: 'Angre siste …',
            title:
              'Viser hva som rulles tilbake før noe endres. Det nektes når noen har endret de samme feltene siden.',
            onclick: aapneAngre,
          })
        : null,
    );
  }

  // ---- Skriving (alltid via serveren, som kjører ko.mjs; vaktreglene først) ----
  /** En skrivehandling via serveren. Returnerer true når den ble gjort (ikke avbrutt eller avvist). */
  async function handling(kropp, ok) {
    let gjort = false;
    const slipp = opptattKnapp(sisteKnapp);
    sisteKnapp = null;
    try {
      const svar = await skrivMedVakt('/api/handling', kropp);
      if (svar) {
        meldingMedInfo(ok, svar);
        if (kropp.id) t.detaljer.delete(kropp.id);
        gjort = true;
      }
    } catch (e) {
      melding(e.message, true);
      slipp(); // feil: knappen kan brukes igjen med én gang
    }
    await oppdater(true);
    // Vellykket: Sky-visningen tegnes etter en egen henting som ikke ventes på her. Knappen står derfor opptatt
    // litt til, så den ikke blinker tilbake før raden er tegnet på nytt. En knapp som er byttet ut, påvirkes ikke.
    if (gjort) setTimeout(slipp, 1500);
    else slipp();
    if (t.valgt && !t.detaljer.has(t.valgt)) hentDetaljer(t.valgt);
    return gjort;
  }

  /**
   * Knappen som sist ble trykket (fanges før knappens egen onclick), så handling() vet hvilken knapp som venter.
   * Gjelder alle skriveknapper uten at hver enkelt må sende knappen med.
   */
  let sisteKnapp = null;
  document.addEventListener(
    'click',
    (e) => {
      sisteKnapp = e.target instanceof Element ? e.target.closest('button') : null;
    },
    true,
  );

  /**
   * Gjør knappen inaktiv med «Lagrer …» og aria-busy, og raden den står i dempet, til slipp() kalles.
   * Hindrer dobbeltklikk og viser med én gang at trykket er registrert. Returnerer slipp (trygg å kalle flere ganger).
   */
  function opptattKnapp(knapp) {
    if (!knapp || knapp.disabled) return () => {};
    const tekst = knapp.textContent;
    const rad = knapp.closest('li, .rad, .sky-rad');
    knapp.disabled = true;
    knapp.setAttribute('aria-busy', 'true');
    knapp.textContent = 'Lagrer …';
    rad?.classList.add('lagrer');
    let sluppet = false;
    return () => {
      if (sluppet) return;
      sluppet = true;
      knapp.disabled = false;
      knapp.removeAttribute('aria-busy');
      knapp.textContent = tekst;
      rad?.classList.remove('lagrer');
    };
  }

  async function flytt(kropp, ok) {
    t.opptatt = true;
    try {
      const svar = await skrivMedVakt('/api/flytt', kropp);
      if (svar) meldingMedInfo(ok, svar);
      else t.ventende = true; // avbrutt ved advarselen: kortet går tilbake
    } catch (e) {
      melding(`Flyttingen ble ikke lagret: ${e.message}`, true);
      t.ventende = true;
    } finally {
      t.opptatt = false;
    }
    await oppdater(true);
    if (t.ventende) tegn();
  }

  /** Lagrer en flytting (dra eller tastatur): naboene over og under på den nye plassen. */
  async function lagre(f) {
    const forrige = naboFor(f, 'previousElementSibling');
    const neste = naboFor(f, 'nextElementSibling');
    if (forrige === f.forrige && neste === f.neste) return tegn(); // samme plass
    if (f.type === 'kort') {
      const id = f.el.dataset.id;
      return flytt(
        { id, over: forrige?.dataset.id ?? null, under: neste?.dataset.id ?? null },
        `${id} flyttet`,
      );
    }
    const pid = f.el.dataset.pid;
    t.opptatt = true;
    try {
      await api('/api/bane', {
        pid,
        over: forrige?.dataset.pid ?? null,
        under: neste?.dataset.pid ?? null,
      });
      melding(`Prosjektet ${pid} flyttet`);
    } catch (e) {
      melding(`Flyttingen ble ikke lagret: ${e.message}`, true);
      t.ventende = true;
    } finally {
      t.opptatt = false;
    }
    await oppdater(true);
    if (t.ventende) tegn();
  }

  /** Nabokortet eller nabobanen (bare flyttbare baner teller). */
  function naboFor(f, retning) {
    let n = f.el[retning];
    if (f.type === 'bane') while (n && n.dataset.flyttbar !== '1') n = n[retning];
    return n ?? null;
  }

  function startFlytt(e, type) {
    return {
      type,
      el: e,
      liste: e.parentElement,
      forrige: null,
      neste: null,
      sluppet: false,
      init() {
        this.forrige = naboFor(this, 'previousElementSibling');
        this.neste = naboFor(this, 'nextElementSibling');
        return this;
      },
    }.init();
  }

  // ---- Dra med mus ----
  function naermesteEtter(liste, velger, y, unntak) {
    for (const barn of liste.querySelectorAll(`:scope > ${velger}`)) {
      if (barn === unntak) continue;
      const r = barn.getBoundingClientRect();
      if (y < r.top + r.height / 2) return barn;
    }
    return null;
  }

  main.addEventListener('dragstart', (e) => {
    const kort = e.target.closest?.('.kort[draggable="true"]');
    const hode = e.target.closest?.('.bane-hode[draggable="true"]');
    if (kort) dra = startFlytt(kort, 'kort');
    else if (hode) dra = startFlytt(hode.parentElement, 'bane');
    else return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dra.el.dataset.id ?? dra.el.dataset.pid);
    dra.el.classList.add('drar');
  });

  main.addEventListener('dragover', (e) => {
    if (!dra) return;
    const liste = e.target.closest?.(dra.type === 'kort' ? '.kortliste' : '.baneliste');
    if (!liste || liste !== dra.liste) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    let etter = naermesteEtter(liste, dra.type === 'kort' ? '.kort' : '.bane', e.clientY, dra.el);
    // En bane kan ikke legges under «uten-prosjekt» (den står alltid sist).
    if (dra.type === 'bane' && !etter)
      etter = liste.querySelector(':scope > .bane:not([data-flyttbar])');
    if (etter === dra.el) return;
    if (etter) {
      if (etter !== dra.el.nextElementSibling) liste.insertBefore(dra.el, etter);
    } else if (liste.lastElementChild !== dra.el) liste.append(dra.el);
  });

  main.addEventListener('drop', (e) => {
    if (!dra) return;
    e.preventDefault();
    dra.sluppet = true;
    const f = dra;
    lagre(f);
  });

  main.addEventListener('dragend', () => {
    if (!dra) return;
    const f = dra;
    dra = null;
    f.el.classList.remove('drar');
    // Avbrutt (sluppet utenfor lista): kortet går tilbake. Etter et slipp tegner lagringen tavla på nytt.
    if (!f.sluppet) tegn();
  });

  // ---- Klikk og tastatur ----
  main.addEventListener('click', (e) => {
    // Avkryssingsboksene (skybunten og flervalget) og knappene i gruppene åpner ikke detaljpanelet.
    if (e.target.closest?.('.sky-velg, .merk-boks, .samle-knapper')) return;
    const kort = e.target.closest?.('.kort');
    if (!kort || loftet) return;
    // Ctrl/Cmd-klikk merker ett kort, Shift-klikk alt fra forrige merkede til dette.
    if (kort.dataset.merkbar && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (e.shiftKey && t.anker) merkOmraade(t.anker, kort.dataset.id);
      else merkMange([kort.dataset.id], !t.merket.has(kort.dataset.id));
      return;
    }
    aapnePanel(kort.dataset.id);
  });
  // Shift-klikk skal ikke merke teksten på kortene.
  main.addEventListener('mousedown', (e) => {
    if (e.shiftKey && e.target.closest?.('.kort[data-merkbar]')) e.preventDefault();
  });

  // ---- Roving tabindex ----
  // Ett tab-stopp per kolonne (Flat) eller celle (Prosjektbaner): tittelknappen på ett kort, pluss boksene på det
  // samme kortet. Resten av kortene nås med piltastene (window.KoYtelse.rovingMaal, testet i vitest). Tavla husker
  // hvilket kort som var stoppet i hver kolonne (t.roving), så stoppet står der det var etter en omtegning.
  const OMRADE = '.kol-kropp, .bane-celle';
  let undertrykkMellomrom = false;

  function omradeNokkel(o) {
    const bane = o.closest('.bane');
    return bane ? `${bane.dataset.pid}|${o.dataset.kol}` : (o.dataset.rull ?? '');
  }

  /** Kan kortet få fokus: ikke skjult av søket, og ikke i en lukket gruppe eller seksjon. */
  const kanFokuseres = (li) => !li.closest('[hidden], details:not([open])');

  /** Kortene i et område som kan få fokus (til piltastene). */
  function synligeKort(o) {
    return [...o.querySelectorAll('.kort')].filter(kanFokuseres);
  }

  /** Gjør kontrollene på kortet (tittelknappen og boksene) til tab-stopp (pa) eller ikke. */
  function settStopp(li, pa) {
    const v = pa ? 0 : -1;
    for (const c of li.querySelectorAll('.kort-knapp, input')) if (c.tabIndex !== v) c.tabIndex = v;
  }

  /** Første kort i området som kan få fokus (uten å gå gjennom alle). */
  function forsteSynlige(o) {
    for (const li of o.querySelectorAll('.kort')) if (kanFokuseres(li)) return li;
    return null;
  }

  /**
   * Gir hver kolonne (eller celle) ett tab-stopp: kortet som sist hadde det, ellers det første synlige. Kontrollene
   * bygges med tabindex -1, så bare de som er stopp nå (tabindex 0) og det nye stoppet røres.
   */
  function rovingOppsett() {
    for (const o of main.querySelectorAll(OMRADE)) {
      const husket = t.roving.get(omradeNokkel(o));
      const hli = husket ? o.querySelector(`.kort[data-id="${CSS.escape(husket)}"]`) : null;
      const aktiv = hli && kanFokuseres(hli) ? hli : forsteSynlige(o);
      for (const c of o.querySelectorAll('[tabindex="0"]')) {
        const li = c.closest('.kort');
        if (li && li !== aktiv) settStopp(li, false);
      }
      if (aktiv) settStopp(aktiv, true);
    }
  }

  /** Gjør kortet til tab-stoppet i sitt område (når det får fokus med Tab, klikk eller piltast). */
  function velgStopp(li) {
    const o = li.closest(OMRADE);
    if (!o) return;
    t.roving.set(omradeNokkel(o), li.dataset.id);
    for (const c of o.querySelectorAll('[tabindex="0"]')) {
      const annet = c.closest('.kort');
      if (annet && annet !== li) settStopp(annet, false);
    }
    settStopp(li, true);
  }

  /** Piltastene, Home og End fra kortet `li`: områdene er kolonnene (Flat) eller cellene i samme bane. */
  function flyttFokus(li, tast) {
    const her = li.closest(OMRADE);
    if (!her) return;
    const bane = her.closest('.bane');
    const omrader = bane
      ? [...bane.querySelectorAll('.bane-celle')]
      : [...main.querySelectorAll('.kol-kropp')];
    const kort = omrader.map(synligeKort);
    const o = omrader.indexOf(her);
    const maal = window.KoYtelse.rovingMaal(
      kort.map((k) => k.length),
      o,
      Math.max(0, kort[o].indexOf(li)),
      tast,
    );
    if (!maal) return;
    const ny = kort[maal.o][maal.i];
    velgStopp(ny);
    const knapp = ny.querySelector('.kort-knapp');
    knapp?.focus();
    knapp?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  main.addEventListener('focusin', (e) => {
    const li = e.target.closest?.('.kort');
    if (li && !loftet) velgStopp(li);
  });
  // Mellomrom som løftet eller slapp et kort, skal ikke også «klikke» tittelknappen når tasten slippes.
  main.addEventListener('keyup', (e) => {
    if (e.key !== ' ') return;
    if (undertrykkMellomrom && e.target.closest?.('.kort-knapp')) e.preventDefault();
    undertrykkMellomrom = false;
  });

  function flyttLoftet(retning) {
    const f = loftet;
    const velger = f.type === 'kort' ? '.kort' : '.bane[data-flyttbar]';
    // Kort som søket har skjult, hoppes over (de står i lista, men vises ikke).
    const sosken = [...f.liste.querySelectorAll(`:scope > ${velger}:not([hidden])`)];
    const i = sosken.indexOf(f.el);
    const j = i + retning;
    if (j < 0 || j >= sosken.length) return;
    if (retning < 0) f.liste.insertBefore(f.el, sosken[j]);
    else f.liste.insertBefore(f.el, sosken[j].nextElementSibling);
    // På kortet er det tittelknappen som har fokus.
    const fokus =
      f.type === 'kort'
        ? (f.el.querySelector('.kort-knapp') ?? f.el)
        : f.el.querySelector('.bane-hode');
    fokus.focus();
    fokus.scrollIntoView?.({ block: 'nearest' });
    $('status').textContent =
      `Plass ${j + 1} av ${sosken.length}. Mellomrom slipper, Esc avbryter.`;
  }

  main.addEventListener('keydown', (e) => {
    if (loftet) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        flyttLoftet(e.key === 'ArrowUp' ? -1 : 1);
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (e.key === ' ') undertrykkMellomrom = true; // knappens klikk ved keyup skal ikke åpne panelet
        const f = loftet;
        loftet = null;
        f.el.classList.remove('loftet');
        lagre(f);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        loftet.el.classList.remove('loftet');
        loftet = null;
        tegn();
        tegnStatus();
      }
      return;
    }
    // Tastene virker på tittelknappen (kortet selv har ikke fokus lenger).
    const knapp = e.target.closest?.('.kort-knapp');
    const kort = knapp?.closest('.kort');
    const hode = e.target.closest?.('.bane-hode');
    if (kort && e.target === knapp) {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        // Snarveiene med Ctrl/Cmd/Alt (Ctrl+A osv.) går videre til dokumentet.
      } else if (e.key === 'Enter') {
        e.preventDefault();
        aapnePanel(kort.dataset.id);
      } else if (
        (e.key === 'x' || e.key === 'X') &&
        kort.dataset.merkbar &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        // X merker kortet i fokus (Shift+x: alt fra forrige merkede hit).
        e.preventDefault();
        if (e.shiftKey && t.anker) merkOmraade(t.anker, kort.dataset.id);
        else merkMange([kort.dataset.id], !t.merket.has(kort.dataset.id));
      } else if (e.key === ' ' && kort.draggable) {
        e.preventDefault();
        undertrykkMellomrom = true;
        loftet = startFlytt(kort, 'kort');
        kort.classList.add('loftet');
        $('status').textContent =
          `${kort.dataset.id} er løftet. Pil opp og ned flytter, mellomrom slipper, Esc avbryter.`;
      } else if (
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)
      ) {
        // Uten løft: opp og ned innen kolonnen, venstre og høyre til nabokolonnen (eller nabocella i banen).
        e.preventDefault();
        flyttFokus(kort, e.key);
      }
    } else if (hode && e.target === hode && hode.draggable && e.key === ' ') {
      e.preventDefault();
      loftet = startFlytt(hode.parentElement, 'bane');
      hode.parentElement.classList.add('loftet');
      $('status').textContent =
        'Banen er løftet. Pil opp og ned flytter, mellomrom slipper, Esc avbryter.';
    }
  });

  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd+A merker alle kort som vises og kan masseendres (utenfor tekstfelt og dialoger).
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      (e.key === 'a' || e.key === 'A') &&
      !t.masse &&
      !loftet &&
      !skrivefelt(document.activeElement) &&
      !panel.contains(document.activeElement) &&
      t.data &&
      t.visning !== 'statistikk' &&
      t.visning !== 'sky' &&
      t.visning !== 'plan' && // planen har ingen kort å merke
      !document.body.classList.contains('rom-planer') // Kø-rommet er skjult
    ) {
      e.preventDefault();
      merkAlleTreff();
      return;
    }
    if (e.key !== 'Escape' || loftet || t.masse) return;
    if (t.valgt || t.innst || t.innboks || t.hjelp) {
      e.preventDefault();
      lukkPanel();
    } else if (t.kjede) {
      // Første Esc lukker panelet, neste nullstiller kjeden, så tømmes valget.
      e.preventDefault();
      nullstillKjede();
    } else if (
      t.merket.size &&
      !filterMeny.contains(document.activeElement) &&
      !skrivefelt(document.activeElement)
    ) {
      e.preventDefault();
      tomValg();
    }
  });
  bakgrunn.addEventListener('click', lukkPanel);

  // ---- Toppen ----
  // Tre valg, System, Lys og Mørk. «System» fjerner valget fra localStorage og følger
  // operativsystemet. Temaet velges bare i innstillingene (tannhjulet), som tre radioknapper; knappen
  // i toppen er fjernet for å gi plass til de to radene.
  function temaValgt() {
    return window.KoUu.temaFraLagret(localStorage.getItem('ko-tavle-tema'));
  }
  function settTema(valg) {
    const html = document.documentElement;
    if (valg === 'lys' || valg === 'mork') {
      html.dataset.tema = valg;
      localStorage.setItem('ko-tavle-tema', valg);
    } else if (valg === 'system') {
      delete html.dataset.tema;
      localStorage.removeItem('ko-tavle-tema');
    }
    const naa = temaValgt();
    // Radioknappene i innstillingene følger med når panelet er åpent.
    for (const r of panel.querySelectorAll('input[name="tema-valg"]')) r.checked = r.value === naa;
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => settTema());

  /** Hjelpen bor i tannhjulet. Knappen bytter panelets innhold til «Slik bruker du panelet». */
  function hjelpSeksjon() {
    return el(
      'section',
      { class: 'innst', 'aria-labelledby': 'innst-hjelp' },
      el('h3', { id: 'innst-hjelp', class: 'innst-tittel', tekst: 'Hjelp' }),
      el('button', {
        type: 'button',
        class: 'knapp knapp-kontur',
        tekst: 'Slik bruker du panelet',
        onclick: () => {
          aapneHjelp();
        },
      }),
    );
  }

  /** Temaet i innstillingene: System, Lys og Mørk som en radiogruppe. */
  function temaSeksjon() {
    const naa = temaValgt();
    return el(
      'fieldset',
      { class: 'innst tema-valg' },
      el('legend', { class: 'innst-tittel', tekst: 'Tema' }),
      window.KoUu.TEMA_VALG.map(({ verdi, tekst }) =>
        el(
          'label',
          { class: 'tema-rad' },
          el('input', {
            type: 'radio',
            name: 'tema-valg',
            value: verdi,
            checked: verdi === naa,
            onchange: () => settTema(verdi),
          }),
          verdi === 'system' ? `${tekst} (følger operativsystemet)` : tekst,
        ),
      ),
    );
  }

  function settVisning(v) {
    t.visning = v;
    localStorage.setItem('ko-tavle-visning', v);
    // Ekte faner. Den valgte fanen er eneste tab-stopp i fanelista (roving tabindex).
    for (const x of VISNINGER) {
      const fane = $(`vis-${x}`);
      fane.setAttribute('aria-selected', x === v ? 'true' : 'false');
      fane.tabIndex = x === v ? 0 : -1;
    }
    if (v === 'statistikk') {
      lukkFilter(false);
      hentStatistikk();
    }
    if (v === 'sky') {
      lukkFilter(false);
      hentSkyko();
    }
    // Planen viser områder og prosjekter, ikke kort: filter- og visningsmenyen lukkes.
    if (v === 'plan') {
      lukkFilter(false);
      lukkVisninger(false);
    }
  }
  for (const x of VISNINGER)
    $(`vis-${x}`).addEventListener('click', () => {
      settVisning(x);
      tegn();
    });
  // Piltastene, Home og End flytter fokus mellom fanene; Enter eller mellomrom velger (manuell aktivering, fordi en
  // tegning av tavla kan ta tid).
  $('faner').addEventListener('keydown', (e) => {
    const faner = VISNINGER.map((x) => $(`vis-${x}`));
    const i = faner.indexOf(document.activeElement);
    if (i < 0) return;
    const j = window.KoUu.faneMaal(faner.length, i, e.key);
    if (j == null) return;
    e.preventDefault();
    faner[i].tabIndex = -1;
    faner[j].tabIndex = 0;
    faner[j].focus();
  });
  // Forlater fokus fanelista uten at noe ble valgt, er den valgte fanen tab-stoppet igjen.
  $('faner').addEventListener('focusout', (e) => {
    if ($('faner').contains(e.relatedTarget)) return;
    for (const x of VISNINGER) $(`vis-${x}`).tabIndex = x === t.visning ? 0 : -1;
  });

  // Statistikken hentes når visningen er åpen (serveren cacher; «uendret» når ingenting er nytt).
  let henterStat = false;
  async function hentStatistikk() {
    if (henterStat || !t.nokkel) return;
    henterStat = true;
    try {
      const q = t.stat.versjon ? `?versjon=${encodeURIComponent(t.stat.versjon)}` : '';
      const svar = await api(`/api/statistikk${q}`);
      t.stat.feil = null;
      if (!svar.uendret) {
        t.stat.data = svar.data;
        t.stat.versjon = svar.versjon;
        if (t.visning === 'statistikk') tegn();
      }
    } catch (e) {
      t.stat.feil = e.message;
      if (t.visning === 'statistikk' && !t.stat.data) tegn();
    } finally {
      henterStat = false;
    }
  }

  // ---- Visningen «Sky»: bunter med ferdig kommando for sky-start.mjs (claude --cloud, trekker fra skykreditten) ----
  let henterSky = false;
  async function hentSkyko() {
    if (henterSky || !t.nokkel) return;
    henterSky = true;
    try {
      const svar = await api('/api/sky-bunter');
      t.skyko = { data: svar.data, feil: null };
    } catch (e) {
      t.skyko = { data: t.skyko.data, feil: e.message };
    } finally {
      henterSky = false;
      if (t.visning === 'sky') tegn();
    }
  }

  async function kopierTekst(tekst, ok) {
    try {
      await navigator.clipboard.writeText(tekst);
      melding(ok);
    } catch {
      melding('Fikk ikke kopiert automatisk: merk kommandoen og kopier den selv.', true);
    }
  }

  /** Hjelpeteksten i Sky-visningen. Basegrenen kommer fra ko.config.json (baseGren). */
  const skyHjelp = () =>
    'Kopier en kommando og kjør den i en terminal i prosjektmappa. Den starter en skyøkt med claude --cloud, ' +
    `som trekker fra skykreditten. Skyen ser bare det som er pushet til ${t.data?.baseGren ?? 'main'}. ` +
    'Når økta melder SKY-FERDIG, trykk «Fullført i sky», så fletter orkestratoren.';

  function skyRad(id, tittel, ...ekstra) {
    return el(
      'li',
      { class: 'sky-rad' },
      el('span', { class: 'sky-id', tekst: id }),
      el('span', { class: 'sky-navn', tekst: tittel ?? '' }),
      ...ekstra,
    );
  }

  function tegnSkyko() {
    const d = t.skyko.data;
    const iSky = [...(t.perId?.values() ?? [])].map((x) => x.k).filter((k) => k?.i_sky);
    const del = (tittel, innhold) =>
      el(
        'section',
        { class: 'sky-del' },
        el('h2', { class: 'sky-tittel', tekst: tittel }),
        innhold,
      );

    const pagar = iSky.length
      ? el(
          'ul',
          { class: 'sky-liste' },
          ...iSky.map((k) =>
            skyRad(
              k.id,
              k.tittel,
              k.sky_okt?.kjoring ? skyLenke(k.sky_okt.kjoring) : null,
              el('button', {
                type: 'button',
                class: 'knapp knapp-tonet',
                tekst: 'Fullført i sky',
                onclick: () =>
                  handling({ type: 'sky-ferdig', id: k.id }, `${k.id} er hentet fra skyen`),
              }),
            ),
          ),
        )
      : el('p', { class: 'tom', tekst: 'Ingenting kjører i skyen nå.' });

    let bunter;
    if (!d)
      bunter = el('p', {
        class: 'tom',
        tekst: t.skyko.feil ? `Kunne ikke hente buntene: ${t.skyko.feil}` : 'Henter buntene …',
      });
    else if (!d.bunter.length)
      bunter = el('p', {
        class: 'tom',
        tekst: d.pushet
          ? 'Ingen skyegnede oppgaver nå.'
          : `Fant ikke basegrenen (${t.data?.baseGren ?? 'main'}) på remoten. Push den, så kan skyen se koden.`,
      });
    else
      bunter = el(
        'ol',
        { class: 'sky-bunter' },
        ...d.bunter.map((b, i) =>
          el(
            'li',
            { class: 'sky-bunt-kort' },
            el('p', {
              class: 'sky-bunt-hode',
              tekst:
                `Bunt ${i + 1} · ${b.ider.length} ${b.ider.length === 1 ? 'oppgave' : 'oppgaver'} · ` +
                `${b.minutter} min · ${b.omrader.join(' + ')}`,
            }),
            el('ul', { class: 'sky-liste' }, ...b.ider.map((id) => skyRad(id, b.titler?.[id]))),
            el(
              'div',
              { class: 'sky-kommando' },
              el('code', { tekst: b.kommando }),
              el('button', {
                type: 'button',
                class: 'knapp knapp-fylt',
                tekst: 'Kopier kommando',
                onclick: () =>
                  kopierTekst(b.kommando, 'Kommandoen er kopiert. Kjør den i terminalen.'),
              }),
            ),
          ),
        ),
      );

    const okter = d ? ` · ${d.okter} av høyst ${d.maks} økter` : '';
    main.append(
      el(
        'div',
        { class: 'sky-visning' },
        el('p', { class: 'sky-hjelp', tekst: skyHjelp() }),
        del(`I sky nå (${iSky.length}${okter})`, pagar),
        del(`Klare bunter (${d?.bunter.length ?? 0})`, bunter),
      ),
    );
  }

  // Tannhjulet åpner innstillingene i sidepanelet.
  $('innstillinger').append(ikon('tannhjul'));
  $('innstillinger').addEventListener('click', aapneInnstillinger);

  /**
   * Logoen (valgfri fil i kømappa, servert på /logo) står i den faste maskot-sonen i venstre hjørne av toppen
   *. Uten logo står sonen tom, men beholder plassen, så toppen ikke hopper når fila kommer eller går.
   */
  function tegnLogo() {
    const sone = $('maskot');
    const finnes = sone.querySelector('.logo');
    if (t.data?.logo && !finnes) sone.append(el('img', { class: 'logo', src: '/logo', alt: '' }));
    else if (!t.data?.logo && finnes) finnes.remove();
    sone.classList.toggle('tom', !t.data?.logo);
  }

  // Snakkeboblen ved maskoten: bare markup og stil her; logikken og frasene kommer fra maskoten.
  // Flagget viser en statisk testtekst for å se plasseringen, og skal stå av i koden som sjekkes inn.
  const BOBLE_TESTTEKST = false;
  if (BOBLE_TESTTEKST) {
    $('boble').textContent = 'Hei! Her kommer det jeg har å si om køen.';
    $('boble').hidden = false;
  }

  let sokTid = null;
  $('sok').addEventListener('input', () => {
    clearTimeout(sokTid);
    sokTid = setTimeout(() => {
      t.filter.sok = $('sok').value.trim().toLowerCase();
      // Flat og Prosjektbaner skjuler kortene som ikke passer (hidden); ingen ombygging.
      if (t.data && (t.visning === 'flat' || t.visning === 'baner')) {
        brukSok();
        tegnMerkTreff();
        tegnValglinje();
        tegnStripe();
      } else tegn();
    }, 150);
  });

  // Planer-rommet (planer/planer.js) viser en køoppgave i Kø og bruker meldingen herfra.
  window.KoTavle = {
    visOppgave(id) {
      if (!t.perId.has(id)) {
        melding(`${id} står ikke på tavla (kansellert eller ukjent).`, true);
        return;
      }
      if (!['flat', 'baner'].includes(t.visning)) settVisning('flat');
      tegn();
      aapnePanel(id);
      main
        .querySelector(`.kort[data-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    },
    melding: (tekst, feil) => melding(tekst, feil),
  };

  // ---- Start ----
  settTema(temaValgt());
  settVisning(t.visning);
  tegnVisningKnapp();
  t.nokkel = hentNokkel();
  if (!t.nokkel) visNokkelBanner();
  tegnStatus();
  tegn();
  oppdater(true);
  const hentAlt = () => {
    if (t.nokkelUgyldig) return; // pollingen står til lenken er limt inn
    oppdater();
    if (t.visning === 'statistikk') hentStatistikk();
    if (t.visning === 'sky') hentSkyko();
  };
  setInterval(() => {
    if (!document.hidden) hentAlt();
    // Alderen på kortene i Pågår går videre uten at køen endres.
    for (const e of main.querySelectorAll('[data-start]')) e.textContent = alder(e.dataset.start);
    // Statusen blir «Ikke oppdatert siden …» når hentingen står (lukket fane, nede server).
    if (!loftet) tegnStatus();
  }, 15_000);
  window.addEventListener('focus', hentAlt);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) hentAlt();
  });
})();
