// =============================================================
// planer.js: Planer-rommet på køtavla (se docs/board.md).
// Vanilla JS, ingen byggesteg, ingen CDN.
//
// Tavla har to arbeidsrom øverst: Planer og Kø. Rommet står i nettadressen (`?rom=planer`), sammen med filtrene,
// søket, valgt post og fanen, så tilbake-knappen og bokmerker virker. Kø-rommet er dagens tavle (tavle.js) uendret.
//
// Planer har tre ruter: filtre med antall treff (venstre), en foldbar liste modul › prosjekt › post med opprullet
// fremdrift (midten) og detaljpanelet med faner (høyre). Over dem står brødsmulestien med kopier-knapper.
// Alle reglene (nettadressen, fasettene, treet, stien, kopier-linjene, køstatusen) er de rene funksjonene i
// scripts/lib/koPlanVisning.js (window.KoPlanVisning, testet i jest); her er bare visningen og samspillet.
//
// Lesing: GET /api/planer (planer.json og ko.json, bare lesing, med versjon så uendret data ikke sendes på nytt).
// Rommet skriver ingenting: endringer i planregisteret gjøres med `ko.mjs plan …` (og senere bolker).
// All tekst settes med textContent (aldri innerHTML), så innhold fra registeret kan ikke bli til HTML.
//
// Koblingen til køen: window.KoPlaner.aapnePost(id) (merket på køkortene) og window.KoTavle.visOppgave(id)
// (lenkene i fanen Kø, satt av tavle.js).
//
// rommet har to flater, Planposter og Dokumenter og avtaler (`flate=dok` i nettadressen).
// Dokumentflaten tegnes av planer/dokumenter.js (window.KoPlanDok.ruter) med hjelperne herfra.
//
// planpostene kan vises som Liste eller Prioritetskart (`vis=kart`), og fristbåndet står over
// rutene. Begge tegnes av planer/kart.js (window.KoPlanKart) med hjelperne herfra; kartet er det eneste i rommet
// som skriver (POST /api/plan-prioriter, etter forhåndsvisning).
//
// i tillegg Trekart (`vis=trekart`) og Avhengigheter (`vis=avh`, utvalget eller valgt post med
// naboene), tegnet av planer/struktur.js (window.KoPlanStruktur) med hjelperne herfra. De skriver ingenting.
//
// fanen Dokumenter leser kildene (GET /api/dok), og Uregistrert-boksen står over rutene på flaten
// Planposter med «Ny post» og «Legg til som kilde» (forhåndsvisning først). Begge tegnes av planer/les.js
// (window.KoPlanLes) med hjelperne herfra.
//
// flatene Juridisk, Beslutninger og Lansering tegnes av planer/juridisk.js
// (window.KoPlanJur), som også gjør de to skrivekallene sine selv (svar via avklar og juristpakken).
//
// flaten Oversikt (startsiden når du går inn i Planer) tegnes av planer/oversikt.js
// (window.KoPlanOversikt). Tastaturet (j, k, Enter, /, 1 til 4, c, x), Ctrl+K, flervalget med handlingslinja, menyen i
// raden og «endret av økt» bor i planer/arbeid.js (window.KoPlanArbeid). Her er bare koblingene, og live
// oppdateringen: et kall til /api/planer med vent=1 som serveren holder til registeret endres.
// =============================================================
'use strict';

(function () {
  const V = window.KoPlanVisning;
  const $ = (id) => document.getElementById(id);
  const rom = $('planer-rom');
  const NOKKEL = 'ko-tavle-nokkel'; // samme som tavle.js (sessionStorage)
  const APNE_LAGRING = 'ko-tavle-planer-apne';
  const FASETT_LAGRING = 'ko-tavle-planer-fasetter';
  const VISNING_LAGRING = 'ko-tavle-planer-visninger';
  const LUKKET_LAGRING = 'ko-tavle-planer-dok-lukket'; // dokumentgruppene du har lukket

  const s = {
    data: null,
    versjon: null,
    feil: null,
    henter: false,
    tilstand: V.lesUrl(location.search),
    // Planer-tilstanden sist rommet var åpent, så «Planer» i toppen tar deg tilbake dit du var.
    sistePlaner: null,
    apne: new Set(lesListe(APNE_LAGRING)),
    fasettApne: new Set(lesListe(FASETT_LAGRING, ['modul', 'pri'])),
    egne: lesListe(VISNING_LAGRING).map(V.rensEgenVisning).filter(Boolean),
    angre: [], // forrige filtervalg (søkedeler), for «Angre filter»
    skuff: false, // smal skjerm: filtrene er åpne som skuff
    lagrer: false, // skjemaet «Lagre visningen» er åpent
    lukket: new Set(lesListe(LUKKET_LAGRING)), // lukkede dokumentgrupper (åpne som standard)
  };

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
  function lesListe(nokkel, standard = []) {
    try {
      const x = JSON.parse(localStorage.getItem(nokkel) ?? 'null');
      return Array.isArray(x) ? x : standard;
    } catch {
      return standard;
    }
  }
  function lagre(nokkel, verdi) {
    try {
      localStorage.setItem(nokkel, JSON.stringify(verdi));
    } catch {
      /* privat modus eller full lagring: gjelder bare denne økta */
    }
  }
  function melding(tekst, feil) {
    if (window.KoTavle?.melding) window.KoTavle.melding(tekst, feil);
  }
  async function kopier(tekst) {
    try {
      await navigator.clipboard.writeText(tekst);
      // Bekreftelsen viser nøyaktig hva som ble kopiert.
      melding(`Kopiert: ${tekst}`);
    } catch {
      melding(`Fikk ikke kopiert automatisk. Merk og kopier selv: ${tekst}`, true);
    }
  }
  function kopierKnapp(tekst, etikett, klasse = 'knapp-liten knapp-kontur planer-kopier') {
    return el('button', {
      type: 'button',
      class: klasse,
      tekst: 'Kopier',
      title: tekst,
      'aria-label': etikett,
      onclick: (e) => {
        e.stopPropagation();
        kopier(tekst);
      },
    });
  }
  const dato = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? String(iso)
      : d.toLocaleString('nb-NO', { dateStyle: 'medium', timeStyle: 'short' });
  };
  const postFor = (id) => s.data?.poster.find((p) => p.id === id) ?? null;

  // ---- Rommet og nettadressen ----
  const erPlaner = () => s.tilstand.rom === 'planer';

  /**
   * Ny tilstand: nettadressen oppdateres (push = nytt steg i historikken; ellers byttes steget ut, f.eks. mens du
   * skriver i søket), rommet vises og Planer tegnes. Kø-rommet har ingen søkedel, så køens adresse er som før.
   */
  function brukTilstand(ny, { push = true, rull = false } = {}) {
    if (erPlaner() && ny.rom !== 'planer') s.sistePlaner = s.tilstand;
    s.tilstand = ny;
    const url = location.pathname + (ny.rom === 'planer' ? V.skrivUrl(ny) : '');
    if (url !== location.pathname + location.search) {
      if (push) history.pushState(null, '', url);
      else history.replaceState(null, '', url);
    }
    visRom();
    if (erPlaner()) tegn({ rull });
  }

  /** Filterendring: forrige valg legges på angre-stabelen. */
  function nyttFilter(filter, ekstra = {}) {
    const forrige = V.skrivUrl({ ...s.tilstand, post: null });
    s.angre.push(forrige);
    if (s.angre.length > 20) s.angre.shift();
    brukTilstand({ ...s.tilstand, filter, ...ekstra });
  }

  function visRom() {
    const p = erPlaner();
    document.body.classList.toggle('rom-planer', p);
    rom.hidden = !p;
    for (const [id, valgt] of [
      ['rom-planer', p],
      ['rom-ko', !p],
    ]) {
      const b = $(id);
      b.setAttribute('aria-selected', valgt ? 'true' : 'false');
      b.tabIndex = valgt ? 0 : -1;
    }
    document.title = p ? 'Planer' : 'Arbeidskøen';
    const h1 = document.querySelector('.topp .tittel');
    if (h1) h1.textContent = p ? 'Planer' : 'Arbeidskøen';
    if (p && !s.data) hent();
  }

  window.addEventListener('popstate', () => {
    const ny = V.lesUrl(location.search);
    if (erPlaner() && ny.rom !== 'planer') s.sistePlaner = s.tilstand;
    s.tilstand = ny;
    visRom();
    if (erPlaner()) tegn({ rull: true });
  });

  function velgRom(r) {
    if (r === 'planer') {
      if (erPlaner()) return;
      // oversikten er startsiden i Planer.
      brukTilstand(s.sistePlaner ?? V.lesUrl('?rom=planer&flate=oversikt'));
    } else if (erPlaner()) brukTilstand({ ...s.tilstand, rom: 'ko' });
  }
  $('rom-planer').addEventListener('click', () => velgRom('planer'));
  $('rom-ko').addEventListener('click', () => velgRom('ko'));
  // Fanene for rommene: piltastene flytter fokus, Enter eller mellomrom velger (som visningsfanene).
  $('rom-valg').addEventListener('keydown', (e) => {
    const knapper = [$('rom-planer'), $('rom-ko')];
    const i = knapper.indexOf(document.activeElement);
    if (i < 0) return;
    const j = window.KoUu.faneMaal(knapper.length, i, e.key);
    if (j == null) return;
    e.preventDefault();
    knapper[i].tabIndex = -1;
    knapper[j].tabIndex = 0;
    knapper[j].focus();
  });

  // ---- Henting ----
  async function hent(tving = false, { vent = false } = {}) {
    const nokkel = sessionStorage.getItem(NOKKEL);
    // kallet som venter (vent) har sitt eget flagg, så en vanlig henting (f.eks. etter en lagring) ikke
    // blir stående bak det.
    const flagg = vent ? 'lytter' : 'henter';
    if (s[flagg] || !nokkel) return;
    s[flagg] = true;
    try {
      // vent=1 holder svaret til planer.json eller ko.json endres (live oppdatering).
      const q =
        s.versjon && !tving
          ? `?versjon=${encodeURIComponent(s.versjon)}${vent ? '&vent=1' : ''}`
          : '';
      const res = await fetch(`/api/planer${q}`, { headers: { 'X-Ko-Nokkel': nokkel } });
      let svar = null;
      try {
        svar = await res.json();
      } catch {
        svar = null;
      }
      if (!res.ok) throw new Error(svar?.melding ?? `HTTP ${res.status}`);
      s.feil = null;
      if (!svar.uendret) {
        // poster en økt har endret siden sist, får en kort markering «endret av økt».
        window.KoPlanArbeid?.endret(V.endredePoster(s.data, svar.data));
        s.data = svar.data;
        // dokumentmappene lesevisningen tillater, kommer fra konfigurasjonen på serveren.
        if (Array.isArray(svar.data?.les_mapper)) V.settLesMapper(svar.data.les_mapper);
        s.versjon = svar.versjon;
        // mens en brikke dras eller er løftet i prioritetskartet, venter tegningen til den slippes.
        // det samme mens menyen i en rad er åpen (den tegner på nytt når den lukkes).
        if (erPlaner() && !window.KoPlanKart?.opptatt() && !window.KoPlanArbeid?.opptatt()) tegn();
      }
    } catch (e) {
      s.feil = e.message;
      if (erPlaner() && !s.data) tegn();
    } finally {
      s[flagg] = false;
    }
  }

  // ---- Tegning ----
  /**
   * Tegner hele rommet på nytt. Fokus og rulling tas vare på (elementet med samme data-fokus får fokuset tilbake,
   * og søkefeltet får markøren der den var), så en oppdatering fra serveren ikke flytter deg.
   */
  function tegn({ rull = false, fokus = null } = {}) {
    window.KoPlanKart?.ferdigTegnet();
    const aktiv = document.activeElement;
    // `fokus` er elementet som skal ha fokuset etterpå (f.eks. brikken som nettopp ble flyttet).
    const fokusNokkel = fokus ?? (rom.contains(aktiv) ? aktiv?.dataset?.fokus : null);
    const markor = aktiv?.selectionStart ?? null;
    const rulling = [...rom.querySelectorAll('[data-rull]')].map((e) => [
      e.dataset.rull,
      e.scrollTop,
    ]);

    rom.replaceChildren();
    if (!s.data) {
      rom.append(
        el('p', {
          class: 'tom planer-henter',
          tekst: s.feil ? `Kunne ikke lese planregisteret: ${s.feil}` : 'Henter planregisteret …',
        }),
      );
      return;
    }
    const d = s.data;
    const t = s.tilstand;
    // oversikten tegnes av oversikt.js.
    if (t.flate === 'oversikt' && window.KoPlanOversikt) {
      rom.classList.remove('har-valgt');
      rom.append(
        stiEl(d),
        flateValgEl(d),
        window.KoPlanKart ? window.KoPlanKart.fristBand(kartHjelp, d, null) : null,
        window.KoPlanOversikt.side(arbeidHjelp, d),
      );
      etterTegning(fokusNokkel, markor, rulling, false);
      return;
    }
    // dokumentflaten tegnes av dokumenter.js; planpostene som før.
    const dokFlate = t.flate === 'dok' && !!window.KoPlanDok;
    // Juridisk, Beslutninger og Lansering tegnes av juridisk.js.
    const jbFlate = V.JB_FLATER.includes(t.flate) && !!window.KoPlanJur;
    if (jbFlate) {
      rom.classList.toggle('har-valgt', window.KoPlanJur.harValgt(jurHjelp, d));
      rom.classList.toggle('skuff-apen', s.skuff);
      rom.append(
        stiEl(d),
        flateValgEl(d),
        t.flate === 'lansering' && window.KoPlanKart
          ? window.KoPlanKart.fristBand(kartHjelp, d, window.KoPlanJur.lanseringIder(d))
          : null,
        window.KoPlanJur.ruter(jurHjelp, d),
      );
      etterTegning(fokusNokkel, markor, rulling, rull);
      return;
    }
    // prioritetskartet (vis=kart) har samme filtre og utvalg som listen, pluss de droppede til den foldede
    // Dropp-kolonnen.
    const kart = !dokFlate && t.vis === 'kart' && !!window.KoPlanKart;
    // trekartet (vis=trekart) og avhengighetene (vis=avh), med samme filtre og utvalg som listen.
    const struktur =
      !dokFlate && (t.vis === 'trekart' || t.vis === 'avh') && !!window.KoPlanStruktur;
    const treff = dokFlate ? [] : V.filtrer(d.poster, t.filter, t.sok);
    const valgt = !dokFlate && t.post ? postFor(t.post) : null;
    const valgtDok = dokFlate && t.dok ? (d.dokumenter ?? []).some((x) => x.id === t.dok) : false;
    rom.classList.toggle('har-valgt', dokFlate ? valgtDok : !!valgt);
    rom.classList.toggle('skuff-apen', s.skuff);
    const utvalgt = V.antallFiltre(t.filter) > 0 || !!t.sok;
    rom.append(
      stiEl(d),
      flateValgEl(d),
      dokFlate || !window.KoPlanKart
        ? null
        : window.KoPlanKart.fristBand(kartHjelp, d, utvalgt ? treff.map((p) => p.id) : null),
      // Uregistrert-boksen, bare på flaten Planposter.
      dokFlate || !window.KoPlanLes ? null : window.KoPlanLes.uregistrertBoks(lesHjelp, d),
      dokFlate
        ? window.KoPlanDok.ruter(dokHjelp, d)
        : el(
            'div',
            { class: 'planer-ruter' },
            filtreEl(d, treff),
            kart
              ? window.KoPlanKart.midt(kartHjelp, d, V.kartPoster(d.poster, t.filter, t.sok), valgt)
              : struktur
                ? window.KoPlanStruktur[t.vis](strukturHjelp, d, treff, valgt)
                : listeEl(d, treff, valgt),
            detaljEl(d, valgt),
          ),
      // handlingslinja for flervalget, nederst.
      dokFlate || !window.KoPlanArbeid ? null : window.KoPlanArbeid.valglinje(arbeidHjelp, d),
    );
    etterTegning(fokusNokkel, markor, rulling, rull && (valgt || valgtDok));
  }

  /** Etter tegningen: rullingen, fokuset og markøren tilbake, og den valgte raden i syne (ved `rull`). */
  function etterTegning(fokusNokkel, markor, rulling, rull) {
    for (const [n, topp] of rulling) {
      const e = rom.querySelector(`[data-rull="${n}"]`);
      if (e) e.scrollTop = topp;
    }
    if (fokusNokkel) {
      const ny = rom.querySelector(`[data-fokus="${CSS.escape(fokusNokkel)}"]`);
      if (ny) {
        ny.focus();
        if (markor != null && typeof ny.setSelectionRange === 'function')
          ny.setSelectionRange(markor, markor);
      }
    }
    if (rull)
      rom
        .querySelector('.planer-post.valgt, .dok-rad.valgt, .jb-rad.valgt')
        ?.scrollIntoView({ block: 'nearest' });
  }

  // ---- flatene i rommet (Planposter, Dokumenter og avtaler, og Juridisk, Beslutninger og
  // Lansering) ----
  function flateValgEl(d) {
    const naa = V.FLATER.some((f) => f.id === s.tilstand.flate) ? s.tilstand.flate : 'poster';
    // Juridisk og Beslutninger viser de åpne, Lansering det som gjenstår.
    const antall = V.flateAntall(d);
    const faner = el(
      'div',
      {
        class: 'planer-flater',
        role: 'tablist',
        'aria-label': 'Hva rommet viser',
        onkeydown: (e) => {
          const knapper = [...e.currentTarget.querySelectorAll('[role="tab"]')];
          const i = knapper.indexOf(document.activeElement);
          if (i < 0) return;
          const j = window.KoUu.faneMaal(knapper.length, i, e.key);
          if (j == null) return;
          e.preventDefault();
          knapper[i].tabIndex = -1;
          knapper[j].tabIndex = 0;
          knapper[j].focus();
        },
      },
      ...V.FLATER.map((f) =>
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: 'planer-flate',
            'aria-selected': f.id === naa ? 'true' : 'false',
            tabindex: f.id === naa ? '0' : '-1',
            'data-fokus': `flate:${f.id}`,
            onclick: () => {
              if (f.id !== naa) brukTilstand({ ...s.tilstand, flate: f.id });
            },
          },
          f.tekst,
          el('span', { class: 'planer-antall', tekst: String(antall[f.id]) }),
        ),
      ),
    );
    if (naa !== 'poster' || !window.KoPlanKart) return faner;
    // visningen av planpostene, Liste eller Prioritetskart (vis=kart i nettadressen).
    const vis = V.VISNINGER.includes(s.tilstand.vis) ? s.tilstand.vis : 'liste';
    return el(
      'div',
      { class: 'planer-flater-rad' },
      faner,
      el(
        'div',
        { class: 'veksler planer-vis', role: 'group', 'aria-label': 'Visning' },
        ...[
          ['liste', 'Liste'],
          ['kart', 'Prioritetskart'],
          // trekartet og avhengighetene for utvalget.
          ...(window.KoPlanStruktur
            ? [
                ['trekart', 'Trekart'],
                ['avh', 'Avhengigheter'],
              ]
            : []),
        ].map(([id, tekst]) =>
          el('button', {
            type: 'button',
            class: 'veksler-knapp',
            tekst,
            'aria-pressed': vis === id ? 'true' : 'false',
            'data-fokus': `vis:${id}`,
            onclick: () => {
              if (vis !== id) brukTilstand({ ...s.tilstand, vis: id });
            },
          }),
        ),
      ),
    );
  }

  /** Hjelperne kart.js får (samme byggeklosser som listen, så det er ett designspråk). */
  const kartHjelp = {
    el,
    melding,
    tegn: (opts) => tegn(opts),
    hent: (tving) => hent(tving),
    aktiveFiltre: (d) => aktiveFiltreEl(d),
    velgPost: (id, fane) =>
      brukTilstand({ ...s.tilstand, post: id, fane: fane ?? s.tilstand.fane }, { push: true }),
    velgDok: (id) => brukTilstand({ ...s.tilstand, flate: 'dok', dok: id }, { rull: true }),
  };

  /**
   * hjelperne struktur.js får. Zoomen i trekartet er filteret (modul og prosjekt; de andre filtrene står),
   * så brødsmulestien zoomer ut og angre filter og tilbake-knappen virker.
   */
  const strukturHjelp = {
    el,
    tilstand: () => s.tilstand,
    aktiveFiltre: (d) => aktiveFiltreEl(d),
    utvalgt: () => V.antallFiltre(s.tilstand.filter) > 0 || !!s.tilstand.sok,
    velgPost: (id) => brukTilstand({ ...s.tilstand, post: id }, { push: true }),
    zoom: (del) => nyttFilter({ ...s.tilstand.filter, ...del }, { post: null }),
    settAvh: (avh) => brukTilstand({ ...s.tilstand, avh }),
  };

  /** Hjelperne les.js får (lesevisningen og Uregistrert-boksen). */
  const lesHjelp = {
    el,
    melding,
    kopierKnapp,
    dato,
    liste: (...a) => liste(...a),
    tegn: (opts) => tegn(opts),
    hent: (tving) => hent(tving),
    gaaTilPost: (id) =>
      brukTilstand(
        {
          ...s.tilstand,
          flate: 'poster',
          filter: V.tomtFilter(),
          sok: '',
          post: id,
          fane: 'sammendrag',
        },
        { rull: true },
      ),
  };

  /** Hjelperne dokumenter.js får (samme byggeklosser som planpostene, så det er ett designspråk). */
  const dokHjelp = {
    el,
    kopier,
    kopierKnapp,
    dato,
    felt: (...a) => felt(...a),
    liste: (...a) => liste(...a),
    priEl: (p) => priEl(p),
    tilstand: () => s.tilstand,
    bruk: (endring, opts) => brukTilstand({ ...s.tilstand, ...endring }, opts),
    nyttDokFilter: (dfilter, ekstra = {}) =>
      brukTilstand({ ...s.tilstand, dfilter, dok: null, ...ekstra }),
    fasettApen: (nokkel, standard = []) =>
      s.fasettApne.has(nokkel) || (standard.includes(nokkel) && !s.fasettApne.has(`!${nokkel}`)),
    settFasettApen: (nokkel, apen) => {
      if (apen) {
        s.fasettApne.add(nokkel);
        s.fasettApne.delete(`!${nokkel}`);
      } else {
        s.fasettApne.delete(nokkel);
        s.fasettApne.add(`!${nokkel}`);
      }
      lagre(FASETT_LAGRING, [...s.fasettApne]);
    },
    erLukket: (nokkel) => s.lukket.has(nokkel),
    veksleLukket: (nokkel) => {
      if (s.lukket.has(nokkel)) s.lukket.delete(nokkel);
      else s.lukket.add(nokkel);
      lagre(LUKKET_LAGRING, [...s.lukket]);
      tegn();
    },
    gaaTilPost: (id) =>
      brukTilstand(
        {
          ...s.tilstand,
          flate: 'poster',
          filter: V.tomtFilter(),
          sok: '',
          post: id,
          fane: 'sammendrag',
        },
        { rull: true },
      ),
  };

  /** Hjelperne juridisk.js får (dokumenthjelperne pluss melding og henting; skrivingen bor i juridisk.js). */
  const jurHjelp = {
    ...dokHjelp,
    melding,
    tegn: (opts) => tegn(opts),
    hent: (tving) => hent(tving),
  };

  /**
   * hjelperne oversikt.js og arbeid.js får (samme byggeklosser, så det er ett designspråk). Rekkefølgen på
   * postene i listen er den som vises (DOM), så j og k følger foldingen.
   */
  const arbeidHjelp = {
    ...jurHjelp,
    rom,
    erPlaner,
    data: () => s.data,
    postFor,
    fremdriftEl: (f, navn) => fremdriftEl(f, navn),
    nyttFilter: (filter, ekstra) => nyttFilter(filter, ekstra),
    synligePoster: () =>
      [...rom.querySelectorAll('.planer-midt .planer-post[data-post]')].map((e) => e.dataset.post),
    velgPost: (id, { push = false } = {}) =>
      brukTilstand({ ...s.tilstand, flate: 'poster', post: id }, { push, rull: true }),
    gaaTilListe: (endring = {}) =>
      brukTilstand({ ...s.tilstand, flate: 'poster', ...endring }, { rull: true }),
    velgRom,
  };

  // ---- Brødsmulestien ----
  function stiEl(d) {
    const ledd = V.brodsmuler(s.tilstand, d);
    return el(
      'nav',
      { class: 'planer-sti', 'aria-label': 'Brødsmulesti' },
      el(
        'ol',
        { class: 'planer-sti-liste' },
        ...ledd.map((l, i) => {
          const sist = i === ledd.length - 1;
          return el(
            'li',
            { class: 'planer-sti-ledd' },
            sist
              ? el('span', { class: 'planer-sti-her', 'aria-current': 'location', tekst: l.tekst })
              : el('button', {
                  type: 'button',
                  class: 'lenke-knapp',
                  tekst: l.tekst,
                  'data-fokus': `sti:${l.niva}`,
                  // leddene i dokumentflaten bærer tilstanden et klikk gir.
                  onclick: () =>
                    l.tilstand
                      ? brukTilstand({ ...s.tilstand, ...l.tilstand })
                      : nyttFilter(l.filter, { post: null, sok: '' }),
                }),
            l.kopier
              ? kopierKnapp(
                  l.kopier,
                  `Kopier startlinjen for ${l.tekst}`,
                  'knapp-liten knapp-kontur',
                )
              : null,
          );
        }),
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'knapp knapp-kontur planer-skuff-knapp',
          'aria-expanded': s.skuff ? 'true' : 'false',
          'aria-controls': 'planer-filtre',
          'data-fokus': 'skuff',
          onclick: () => {
            s.skuff = !s.skuff;
            tegn();
          },
        },
        (() => {
          const fl = s.tilstand.flate;
          const n =
            fl === 'dok'
              ? V.antallDokFiltre(s.tilstand.dfilter)
              : fl === 'jur' || fl === 'beslutn'
                ? V.antallJbFiltre(fl, fl === 'jur' ? s.tilstand.jfilter : s.tilstand.bfilter)
                : V.antallFiltre(s.tilstand.filter);
          return `Filtre${n ? ` (${n})` : ''}`;
        })(),
      ),
    );
  }

  // ---- Venstre rute: søk, visninger og fasetter ----
  let sokTid = null;
  function filtreEl(d, treff) {
    const t = s.tilstand;
    const fasetter = V.fasettTall(d.poster, t.filter, t.sok, d);
    const naa = V.skrivUrl({ ...t, post: null });
    const visningKnapp = (v, egen) =>
      el(
        'li',
        { class: 'planer-visning' },
        el('button', {
          type: 'button',
          class: 'lenke-knapp',
          tekst: v.navn,
          'aria-pressed': V.sammeVisning(v.sok, naa) ? 'true' : 'false',
          'data-fokus': `vis:${egen ? 'egen' : 'ferdig'}:${v.navn}`,
          onclick: () => {
            const ny = V.lesUrl(v.sok);
            nyttFilter(ny.filter, { sok: ny.sok, post: null });
          },
        }),
        egen
          ? el('button', {
              type: 'button',
              class: 'knapp-ikon planer-fjern',
              tekst: '✕',
              'aria-label': `Slett visningen ${v.navn}`,
              onclick: () => {
                s.egne = s.egne.filter((x) => x !== v);
                lagre(VISNING_LAGRING, s.egne);
                tegn();
              },
            })
          : null,
      );
    return el(
      'aside',
      {
        id: 'planer-filtre',
        class: 'planer-filtre',
        'aria-label': 'Filtre',
        'data-rull': 'filtre',
      },
      el(
        'label',
        { class: 'planer-sok-etikett' },
        el('span', { class: 'skjult-for-oyet', tekst: 'Søk i planene' }),
        el('input', {
          type: 'search',
          class: 'sok planer-sok',
          placeholder: 'Søk i id, tittel, kilder',
          autocomplete: 'off',
          value: t.sok,
          'data-fokus': 'sok',
          oninput: (e) => {
            clearTimeout(sokTid);
            const v = e.target.value.slice(0, 120);
            sokTid = setTimeout(
              () => brukTilstand({ ...s.tilstand, sok: v.trim() }, { push: false }),
              200,
            );
          },
        }),
      ),
      el(
        'section',
        { class: 'planer-visninger', 'aria-label': 'Lagrede visninger' },
        el('h2', { class: 'planer-rute-tittel', tekst: 'Visninger' }),
        el(
          'ul',
          { class: 'planer-visning-liste' },
          ...V.FERDIGE_VISNINGER.map((v) => visningKnapp(v, false)),
          ...s.egne.map((v) => visningKnapp(v, true)),
        ),
        lagreVisningEl(naa),
      ),
      ...fasetter
        .filter((f) => f.valg.length)
        .map((f) => {
          const apen = s.fasettApne.has(f.id) || f.valg.some((v) => v.valgt);
          return el(
            'details',
            {
              class: 'planer-fasett',
              open: apen,
              ontoggle: (e) => {
                if (e.target.open) s.fasettApne.add(f.id);
                else s.fasettApne.delete(f.id);
                lagre(FASETT_LAGRING, [...s.fasettApne]);
              },
            },
            el(
              'summary',
              { class: 'planer-fasett-tittel', 'data-fokus': `fasett:${f.id}` },
              `${f.tittel} (${f.valg.length})`,
            ),
            el(
              'ul',
              { class: 'planer-fasett-liste' },
              ...f.valg.map((v) =>
                el(
                  'li',
                  {},
                  el(
                    'label',
                    { class: 'planer-fasett-valg' },
                    el('input', {
                      type: 'checkbox',
                      checked: v.valgt,
                      'data-fokus': `f:${f.id}:${v.verdi}`,
                      onchange: (e) => {
                        const ny = { ...s.tilstand.filter };
                        const liste = new Set(ny[f.id]);
                        if (e.target.checked) liste.add(v.verdi);
                        else liste.delete(v.verdi);
                        ny[f.id] = [...liste];
                        nyttFilter(ny);
                      },
                    }),
                    f.id === 'pri'
                      ? el('span', {
                          class: `planer-pri pri-${v.verdi}`,
                          'aria-hidden': 'true',
                          tekst: V.PRIORITET[v.verdi]?.symbol ?? '',
                        })
                      : null,
                    el('span', { class: 'planer-fasett-tekst', tekst: v.tekst }),
                    el('span', {
                      class: 'planer-antall',
                      tekst: String(v.antall),
                      'aria-label': `${v.antall} treff`,
                    }),
                  ),
                ),
              ),
            ),
          );
        }),
      el('p', {
        class: 'planer-treff',
        role: 'status',
        tekst: `${treff.length} av ${d.poster.length} poster`,
      }),
    );
  }

  function lagreVisningEl(naa) {
    if (!s.lagrer)
      return el('button', {
        type: 'button',
        class: 'knapp-liten knapp-kontur',
        tekst: 'Lagre denne visningen',
        'data-fokus': 'lagre-visning',
        disabled: !V.antallFiltre(s.tilstand.filter) && !s.tilstand.sok,
        onclick: () => {
          s.lagrer = true;
          tegn();
          rom.querySelector('.planer-lagre-navn')?.focus();
        },
      });
    return el(
      'form',
      {
        class: 'planer-lagre',
        onsubmit: (e) => {
          e.preventDefault();
          const ny = V.rensEgenVisning({ navn: e.target.elements.navn.value, sok: naa });
          if (!ny) return;
          s.egne = [...s.egne.filter((x) => x.navn !== ny.navn), ny];
          lagre(VISNING_LAGRING, s.egne);
          s.lagrer = false;
          melding(`Visningen «${ny.navn}» er lagret i denne nettleseren.`);
          tegn();
        },
      },
      el(
        'label',
        {},
        el('span', { class: 'skjult-for-oyet', tekst: 'Navn på visningen' }),
        el('input', {
          name: 'navn',
          class: 'sok planer-lagre-navn',
          type: 'text',
          maxlength: '60',
          placeholder: 'Navn på visningen',
          'data-fokus': 'lagre-navn',
        }),
      ),
      el('button', { type: 'submit', class: 'knapp-liten knapp-fylt', tekst: 'Lagre' }),
      el('button', {
        type: 'button',
        class: 'knapp-liten knapp-kontur',
        tekst: 'Avbryt',
        onclick: () => {
          s.lagrer = false;
          tegn();
        },
      }),
    );
  }

  // ---- Midten: brikkene og den foldbare listen ----
  function listeEl(d, treff, valgt) {
    const t = s.tilstand;
    const aktivt = V.brikker(t.filter, d).length > 0 || !!t.sok;
    const tre = V.tre(treff, d);
    const hode = aktiveFiltreEl(d);
    let innhold;
    if (!d.finnes)
      innhold = el('p', {
        class: 'tom',
        tekst: 'Planregisteret finnes ikke ennå (scripts/.ko/planer.json).',
      });
    else if (!treff.length)
      innhold = el(
        'div',
        { class: 'tom tom-tilstand' },
        el('p', {
          tekst: aktivt ? 'Ingen poster passer filtrene og søket.' : 'Ingen poster i registeret.',
        }),
        aktivt
          ? el('button', {
              type: 'button',
              class: 'lenke-knapp',
              tekst: 'Nullstill filtrene',
              onclick: () => nyttFilter(V.tomtFilter(), { sok: '' }),
            })
          : null,
      );
    else
      innhold = el(
        'ul',
        { class: 'planer-tre', 'aria-label': 'Planene etter modul og prosjekt' },
        ...tre.map((m) => modulEl(m, aktivt, valgt, d)),
      );
    return el(
      'section',
      { class: 'planer-midt', 'aria-label': 'Planlisten', 'data-rull': 'liste' },
      hode,
      innhold,
    );
  }

  /** De aktive filtrene som brikker over listen (og over prioritetskartet), med Nullstill og Angre filter. */
  function aktiveFiltreEl(d) {
    const t = s.tilstand;
    const brikker = V.brikker(t.filter, d);
    const aktivt = brikker.length > 0 || !!t.sok;
    return el(
      'div',
      { class: 'planer-brikker', 'aria-label': 'Aktive filtre' },
      ...brikker.map((b) =>
        el(
          'span',
          { class: 'merke planer-brikke' },
          b.tekst,
          el('button', {
            type: 'button',
            class: 'planer-brikke-fjern',
            tekst: '✕',
            'aria-label': `Fjern filteret ${b.tekst}`,
            'data-fokus': `brikke:${b.fasett}:${b.verdi}`,
            onclick: () => {
              const ny = {
                ...t.filter,
                [b.fasett]: t.filter[b.fasett].filter((x) => x !== b.verdi),
              };
              nyttFilter(ny);
            },
          }),
        ),
      ),
      t.sok ? el('span', { class: 'merke planer-brikke', tekst: `Søk: ${t.sok}` }) : null,
      aktivt
        ? el('button', {
            type: 'button',
            class: 'knapp-liten knapp-kontur',
            tekst: 'Nullstill',
            'data-fokus': 'nullstill',
            onclick: () => nyttFilter(V.tomtFilter(), { sok: '' }),
          })
        : null,
      s.angre.length
        ? el('button', {
            type: 'button',
            class: 'knapp-liten knapp-kontur',
            tekst: 'Angre filter',
            'data-fokus': 'angre-filter',
            onclick: () => {
              const forrige = V.lesUrl(s.angre.pop());
              brukTilstand({ ...s.tilstand, filter: forrige.filter, sok: forrige.sok });
            },
          })
        : null,
    );
  }

  /** Er gruppen åpen? Med filter eller søk er alt med treff åpent; ellers det du har åpnet, og veien til valgt post. */
  function erApen(nokkel, aktivt, valgt, sjekk) {
    return aktivt || s.apne.has(nokkel) || (valgt && sjekk(valgt));
  }
  function veksleApen(nokkel) {
    if (s.apne.has(nokkel)) s.apne.delete(nokkel);
    else s.apne.add(nokkel);
    lagre(APNE_LAGRING, [...s.apne]);
    tegn();
  }

  function fremdriftEl(f, navn) {
    const pst = Math.round(f.andel * 100);
    return el(
      'span',
      { class: 'planer-fremdrift' },
      el(
        'span',
        {
          class: 'planer-stolpe',
          role: 'img',
          'aria-label': `${navn}: ${f.bygget} av ${f.n} bygget, ${pst} prosent ferdig`,
        },
        el('span', { class: 'planer-stolpe-fyll', '--andel': `${pst}%` }),
      ),
      el('span', {
        class: 'planer-fremdrift-tekst',
        'aria-hidden': 'true',
        tekst: `${f.bygget}/${f.n}`,
      }),
    );
  }

  function gruppeRad(nivaKlasse, nokkel, apen, tittel, antall, f, kopierTekst, fullTittel) {
    const id = `planer-g-${nokkel.replace(/[^a-z0-9-]/gi, '_')}`;
    return el(
      'div',
      { class: `planer-rad ${nivaKlasse}` },
      el(
        'button',
        {
          type: 'button',
          class: 'planer-fold',
          'aria-expanded': apen ? 'true' : 'false',
          'aria-controls': id,
          'data-fokus': `g:${nokkel}`,
          title: fullTittel ?? null,
          onclick: () => veksleApen(nokkel),
        },
        el('span', { class: 'planer-fold-pil', 'aria-hidden': 'true', tekst: apen ? '▾' : '▸' }),
        el('span', { class: 'planer-gruppe-tittel', tekst: tittel }),
        el('span', {
          class: 'planer-antall',
          tekst: String(antall),
          'aria-label': `${antall} poster`,
        }),
      ),
      fremdriftEl(f, tittel),
      kopierTekst ? kopierKnapp(kopierTekst, `Kopier startlinjen for ${tittel}`) : null,
    );
  }

  function modulEl(m, aktivt, valgt, d) {
    const nokkel = `m:${m.oid}`;
    const apen = erApen(nokkel, aktivt, valgt, (p) => (p.modul ?? V.UTEN_MODUL) === m.oid);
    const id = `planer-g-${nokkel.replace(/[^a-z0-9-]/gi, '_')}`;
    const kop = m.oid === V.UTEN_MODUL ? null : V.kopierLinje('modul', m.oid, [m.tittel]);
    return el(
      'li',
      { class: 'planer-modul' },
      gruppeRad('planer-rad-modul', nokkel, apen, m.tittel, m.antall, m.fremdrift, kop),
      apen
        ? el(
            'ul',
            { id, class: 'planer-prosjekter' },
            ...m.prosjekter.map((pr) => prosjektEl(m, pr, aktivt, valgt, d)),
          )
        : null,
    );
  }

  function prosjektEl(m, pr, aktivt, valgt, d) {
    const nokkel = `p:${m.oid}/${pr.pid}`;
    const apen = erApen(
      nokkel,
      aktivt,
      valgt,
      (p) => (p.modul ?? V.UTEN_MODUL) === m.oid && (p.prosjekt ?? V.UTEN_PROSJEKT) === pr.pid,
    );
    const id = `planer-g-${nokkel.replace(/[^a-z0-9-]/gi, '_')}`;
    const kop =
      pr.pid === V.UTEN_PROSJEKT ? null : V.kopierLinje('prosjekt', pr.pid, [m.tittel, pr.tittel]);
    return el(
      'li',
      { class: 'planer-prosjekt' },
      gruppeRad(
        'planer-rad-prosjekt',
        nokkel,
        apen,
        pr.tittel,
        pr.poster.length,
        pr.fremdrift,
        kop,
        pr.fullTittel,
      ),
      apen
        ? el('ul', { id, class: 'planer-poster' }, ...pr.poster.map((p) => postEl(p, valgt, d)))
        : null,
    );
  }

  /** Varselikonene på raden: eierspørsmål, juridisk, foreldet og frist. Tegnet bærer alltid en tekst i tillegg. */
  function varsler(p) {
    const ut = [];
    const apneSp = (p.eierspm ?? []).filter((x) => !x.avklart).length;
    if (apneSp) ut.push({ k: 'eier', tegn: '?', tekst: `${apneSp} åpne eierspørsmål` });
    if (p.jur_apne) ut.push({ k: 'jur', tegn: '§', tekst: `${p.jur_apne} åpne juridiske punkter` });
    if (p.foreldet) ut.push({ k: 'foreldet', tegn: '⟳', tekst: 'Verifiseringen er foreldet' });
    if (p.frist) {
      const band = V.fristBand(p.frist);
      ut.push({
        k: `frist frist-${band}`,
        tegn: '◷',
        tekst: `Frist ${p.frist}${band === 'forfalt' ? ' (forfalt)' : ''}`,
      });
    }
    if (p.aktiv) ut.push({ k: 'aktiv', tegn: '◉', tekst: 'Under arbeid i Claude Code' });
    return ut;
  }

  function priEl(p) {
    const v = V.PRIORITET[p.prioritet] ?? { tekst: p.prioritet ?? 'ukjent', symbol: '·' };
    const kat =
      p.prioritet === 'naa' && p.naa_kategori?.length
        ? ` · ${p.naa_kategori.map((k) => V.KATEGORI[k] ?? k).join(', ')}`
        : '';
    return el(
      'span',
      { class: `planer-pri pri-${p.prioritet}` },
      el('span', { class: 'planer-pri-symbol', 'aria-hidden': 'true', tekst: v.symbol }),
      el('span', { tekst: `${v.tekst}${kat}` }),
    );
  }

  function modenhetTekst(p) {
    const t = V.MODENHET[p.modenhet] ?? p.modenhet ?? '';
    return p.modenhet === 'delvis' && p.brok ? `${t} ${p.brok}` : t;
  }

  function postEl(p, valgt, d) {
    const erValgt = valgt?.id === p.id;
    const vars = varsler(p);
    // flervalget (x), «endret av økt» og pulsen for «Arbeider nå» (arbeid.js).
    const A = window.KoPlanArbeid;
    const ekstra = A ? A.radKlasser(p) : '';
    return el(
      'li',
      { class: `planer-post${erValgt ? ' valgt' : ''}${ekstra}`, 'data-post': p.id },
      A ? A.merkEl(arbeidHjelp, p) : null,
      el(
        'button',
        {
          type: 'button',
          class: 'planer-post-knapp',
          'aria-current': erValgt ? 'true' : null,
          'data-fokus': `post:${p.id}`,
          onclick: () =>
            brukTilstand({ ...s.tilstand, post: p.id, fane: s.tilstand.fane }, { push: true }),
        },
        priEl(p),
        el('span', { class: 'planer-post-id', tekst: p.id }),
        el('span', { class: 'planer-post-tittel', tekst: p.tittel }),
        el('span', { class: 'merke planer-modenhet', tekst: modenhetTekst(p) }),
        p.estimat
          ? el('span', {
              class: 'merke',
              tekst: p.estimat,
              title: `Estimat: ${V.ESTIMAT[p.estimat] ?? p.estimat}`,
              'aria-label': `Estimat ${p.estimat}`,
            })
          : null,
        vars.length
          ? el(
              'span',
              { class: 'planer-varsler' },
              ...vars.map((x) =>
                el(
                  'span',
                  { class: `planer-varsel v-${x.k}`, title: x.tekst },
                  el('span', { 'aria-hidden': 'true', tekst: x.tegn }),
                  el('span', { class: 'skjult-for-oyet', tekst: x.tekst }),
                ),
              ),
            )
          : null,
      ),
      // «endret av økt» som tekst (ikke bare farge), og menyen for prioritet og modenhet i raden.
      A ? A.endretMerke(p) : null,
      A ? A.radMeny(arbeidHjelp, p, d) : null,
      kopierKnapp(V.postLinje(p, d), `Kopier startlinjen for ${p.id}`),
    );
  }

  // ---- Høyre rute: detaljpanelet med faner ----
  function detaljEl(d, p) {
    if (!p)
      return el(
        'aside',
        { class: 'planer-detalj tom-detalj', 'aria-label': 'Detaljpanelet' },
        el('p', {
          class: 'tom',
          tekst: s.tilstand.post
            ? `Fant ikke ${s.tilstand.post} i registeret (slått sammen eller fjernet).`
            : 'Velg en post i listen for å se detaljene.',
        }),
      );
    const t = s.tilstand;
    const k = V.klargjor(p, d);
    const faneIdx = Math.max(
      0,
      V.FANER.findIndex((f) => f.id === t.fane),
    );
    const tellere = {
      dok: p.kilder.length,
      ko: p.ko.length,
      juridisk: p.jur_apne,
      beslutninger: p.eierspm.filter((x) => !x.avklart).length,
      historikk: p.historikk.length,
    };
    const faneliste = el(
      'div',
      {
        class: 'planer-faner',
        role: 'tablist',
        'aria-label': 'Detaljer om posten',
        onkeydown: (e) => {
          const knapper = [...e.currentTarget.querySelectorAll('[role="tab"]')];
          const i = knapper.indexOf(document.activeElement);
          if (i < 0) return;
          const j = window.KoUu.faneMaal(knapper.length, i, e.key);
          if (j == null) return;
          e.preventDefault();
          knapper[i].tabIndex = -1;
          knapper[j].tabIndex = 0;
          knapper[j].focus();
        },
      },
      ...V.FANER.map((f, i) =>
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            id: `planer-fane-${f.id}`,
            class: 'planer-fane',
            'aria-selected': i === faneIdx ? 'true' : 'false',
            'aria-controls': 'planer-fane-innhold',
            tabindex: i === faneIdx ? '0' : '-1',
            'data-fokus': `fane:${f.id}`,
            onclick: () => brukTilstand({ ...s.tilstand, fane: f.id }, { push: false }),
          },
          f.tekst,
          tellere[f.id]
            ? el('span', { class: 'planer-antall', tekst: String(tellere[f.id]) })
            : null,
        ),
      ),
    );
    return el(
      'aside',
      { class: 'planer-detalj', 'aria-label': `Detaljer for ${p.id}`, 'data-rull': 'detalj' },
      el('button', {
        type: 'button',
        class: 'knapp-liten knapp-kontur planer-tilbake',
        tekst: 'Tilbake til listen',
        onclick: () => brukTilstand({ ...s.tilstand, post: null }),
      }),
      el(
        'header',
        { class: 'planer-detalj-hode' },
        el('p', { class: 'planer-detalj-id', tekst: p.id }),
        el('h2', { class: 'planer-detalj-tittel', tekst: p.tittel }),
        el(
          'p',
          { class: 'planer-detalj-merker' },
          priEl(p),
          el('span', { class: 'merke planer-modenhet', tekst: modenhetTekst(p) }),
          p.estimat ? el('span', { class: 'merke', tekst: `Estimat ${p.estimat}` }) : null,
          p.aktiv
            ? el('span', {
                class: 'merke planer-aktiv',
                tekst: 'Under arbeid i Claude Code',
                title: `Puls ${dato(p.aktiv.at)} (${p.aktiv.av})`,
              })
            : null,
        ),
        el(
          'div',
          { class: 'planer-handlinger' },
          el('button', {
            type: 'button',
            class: 'knapp knapp-fylt',
            tekst: 'Kopier startlinje',
            title: V.postLinje(p, d),
            'data-fokus': 'kopier-start',
            onclick: () => kopier(V.postLinje(p, d)),
          }),
          el('button', {
            type: 'button',
            class: 'knapp knapp-kontur',
            tekst: 'Klargjør for kø',
            title: k.linje,
            'data-fokus': 'klargjor',
            onclick: () => kopier(k.linje),
          }),
        ),
        k.advarsler.length
          ? el(
              'div',
              { class: 'planer-kontroll' },
              el('p', { class: 'planer-kontroll-tittel', tekst: 'Kontroll før pakking' }),
              el('ul', {}, ...k.advarsler.map((a) => el('li', { tekst: a }))),
            )
          : null,
      ),
      faneliste,
      el(
        'section',
        {
          id: 'planer-fane-innhold',
          class: 'planer-fane-innhold',
          role: 'tabpanel',
          'aria-labelledby': `planer-fane-${V.FANER[faneIdx].id}`,
        },
        faneInnhold(V.FANER[faneIdx].id, p, d),
      ),
    );
  }

  function felt(navn, ...verdi) {
    const v = verdi.flat().filter((x) => x != null && x !== '' && x !== false);
    if (!v.length) return null;
    return [el('dt', { tekst: navn }), el('dd', {}, ...v)];
  }

  function postLenke(id) {
    const q = postFor(id);
    return el('button', {
      type: 'button',
      class: 'lenke-knapp',
      tekst: q ? `${id} ${q.tittel}` : id,
      onclick: () => brukTilstand({ ...s.tilstand, post: id }, { rull: true }),
    });
  }

  function liste(elementer, tomTekst) {
    return elementer.length
      ? el('ul', { class: 'planer-detalj-liste' }, ...elementer)
      : el('p', { class: 'tom', tekst: tomTekst });
  }

  function faneInnhold(fane, p, d) {
    const over = [
      ...V.brodsmuler({ post: p.id, filter: V.tomtFilter() }, d)
        .slice(1, 3)
        .map((l) => l.tekst),
      p.id,
    ];
    if (fane === 'sammendrag') {
      const v = V.PRIORITET[p.prioritet];
      return el(
        'div',
        {},
        p.kort ? el('p', { class: 'planer-kort', tekst: p.kort }) : null,
        el(
          'dl',
          { class: 'planer-felt' },
          felt(
            'Prioritet i planregisteret',
            `${v ? `${v.symbol} ${v.tekst}` : p.prioritet}${
              p.naa_kategori.length
                ? ` (${p.naa_kategori.map((x) => V.KATEGORI[x] ?? x).join(', ')})`
                : ''
            }, satt av ${p.prioritet_satt_av === 'eier' ? 'eieren' : 'agent'}`,
          ),
          felt('Grunn', p.prioritet_grunn),
          felt(
            'Modenhet',
            `${modenhetTekst(p)}${
              p.modenhet_plan && p.modenhet_plan !== p.modenhet
                ? ` (fra planarbeidet: ${V.MODENHET[p.modenhet_plan] ?? p.modenhet_plan})`
                : ''
            }`,
          ),
          felt('Estimat', p.estimat ? `${p.estimat}: ${V.ESTIMAT[p.estimat] ?? ''}` : null),
          felt('Frist', p.frist),
          felt(
            'Avhenger av',
            p.avhenger.length
              ? liste(
                  p.avhenger.map((id) => el('li', {}, postLenke(id))),
                  '',
                )
              : null,
          ),
          felt(
            'Blokkerer',
            p.blokkerer.length
              ? liste(
                  p.blokkerer.map((id) => el('li', {}, postLenke(id))),
                  '',
                )
              : null,
          ),
          felt(
            'Verifisert',
            p.verifisert
              ? `${p.verifisert.dato ?? ''} av ${p.verifisert.av ?? 'ukjent'}${p.verifisert.funn ? `: ${p.verifisert.funn}` : ''}${
                  p.foreldet ? ' (foreldet)' : ''
                }`
              : 'Ikke verifisert mot koden ennå',
          ),
          felt('Grunn til dropp', p.dropp_grunn),
          felt('Slått sammen fra', p.sammenslatt_fra.join(', ')),
          felt('Roadmap', p.roadmap.join(', ')),
          felt('Merknad', p.merknad),
        ),
      );
    }
    // kildene med lesevisningen (planer/les.js).
    if (fane === 'dok' && window.KoPlanLes) return window.KoPlanLes.kildeFane(lesHjelp, p);
    if (fane === 'dok')
      return el(
        'div',
        {},
        el('p', {
          class: 'planer-hjelp',
          tekst: 'Kildene posten peker til (lesevisningen er ikke lastet).',
        }),
        liste(
          p.kilder.map((k) =>
            el(
              'li',
              { class: 'planer-kilde' },
              el('code', { tekst: k.sti }),
              k.anker ? el('span', { class: 'merke', tekst: k.anker }) : null,
              k.rolle ? el('span', { class: 'merke', tekst: k.rolle }) : null,
              kopierKnapp(k.sti, `Kopier stien ${k.sti}`),
            ),
          ),
          'Posten har ingen kilder.',
        ),
      );
    if (fane === 'ko') {
      const v = V.PRIORITET[p.prioritet];
      return el(
        'div',
        {},
        el('p', {
          class: 'planer-hjelp',
          tekst:
            `Prioritet i planregisteret: ${v?.tekst ?? p.prioritet}. Fokustrinnet er køens egen rekkefølge og står ` +
            'per oppgave. Klikk en oppgave for å se kortet i Kø.',
        }),
        liste(
          p.ko.map((o) =>
            el(
              'li',
              { class: 'planer-ko-oppgave' },
              el('button', {
                type: 'button',
                class: 'lenke-knapp',
                tekst: `${o.id} ${o.tittel ?? ''}`.trim(),
                'aria-label': `Vis ${o.id} i Kø`,
                onclick: () => visIKo(o.id),
              }),
              el('span', {
                class: `merke planer-ko-status ko-${o.kolonne ?? 'ingen'}`,
                tekst: V.koStatusTekst(o),
              }),
            ),
          ),
          'Ingen køoppgaver ennå. «Klargjør for kø» kopierer linjen til /legg-til-ko.',
        ),
      );
    }
    if (fane === 'juridisk') {
      const j = p.juridisk;
      if (!j) return el('p', { class: 'tom', tekst: 'Ingen juridiske punkter på posten.' });
      const pv = j.personvern ?? null;
      return el(
        'div',
        {},
        el(
          'dl',
          { class: 'planer-felt' },
          felt('Berører', (j.berorer ?? []).join('; ')),
          felt(
            'Personvern',
            pv
              ? [
                  pv.art9 ? 'art. 9-opplysninger' : null,
                  pv.dpia ? `DPIA: ${pv.dpia}` : null,
                  pv.dpa_endring ? 'DPA må endres' : null,
                ]
                  .filter(Boolean)
                  .join(', ')
              : null,
          ),
        ),
        liste(
          (j.punkter ?? []).map((x) =>
            el(
              'li',
              { class: 'planer-punkt' },
              el('p', {}, el('strong', { tekst: x.id ?? '' }), ` ${x.sporsmal ?? ''}`),
              el(
                'p',
                { class: 'planer-punkt-meta' },
                el('span', { class: 'merke', tekst: `Status: ${x.status ?? 'ukjent'}` }),
                x.blokkerer
                  ? el('span', { class: 'merke', tekst: `Blokkerer: ${x.blokkerer}` })
                  : null,
                x.frist ? el('span', { class: 'merke', tekst: `Frist ${x.frist}` }) : null,
                x.id
                  ? kopierKnapp(V.kopierLinje('jur', x.id, over), `Kopier startlinjen for ${x.id}`)
                  : null,
              ),
              x.ki_vurdering
                ? el('p', { class: 'planer-hjelp', tekst: `KI-vurdering: ${x.ki_vurdering}` })
                : null,
            ),
          ),
          'Ingen punkter.',
        ),
      );
    }
    if (fane === 'beslutninger') {
      const sortert = [...p.eierspm].sort((a, b) => Number(a.avklart) - Number(b.avklart));
      return liste(
        sortert.map((x) =>
          el(
            'li',
            { class: `planer-punkt${x.avklart ? ' avklart' : ''}` },
            el(
              'p',
              {},
              el('strong', { tekst: x.id }),
              ` ${x.tekst ?? '(spørsmålet finnes ikke i køen)'}`,
            ),
            el(
              'p',
              { class: 'planer-punkt-meta' },
              el('span', { class: 'merke', tekst: x.avklart ? 'Besvart' : 'Åpent' }),
              kopierKnapp(V.kopierLinje('eier', x.id, over), `Kopier startlinjen for ${x.id}`),
            ),
            x.svar ? el('p', { class: 'planer-hjelp', tekst: `Svar: ${x.svar}` }) : null,
          ),
        ),
        'Ingen eierspørsmål på posten.',
      );
    }
    return liste(
      p.historikk.map((h) =>
        el(
          'li',
          { class: 'planer-historikk' },
          el('span', { class: 'merke', tekst: `nr. ${h.nr}` }),
          ` ${dato(h.at)} · ${h.handling ?? ''} · ${h.av ?? ''} · `,
          el('span', { tekst: h.felt.includes('*') ? 'hele posten' : h.felt.join(', ') }),
        ),
      ),
      'Ingen endringer i endringsloggen (den holder de siste 50).',
    );
  }

  // ---- Koblingen til køen ----
  function visIKo(id) {
    brukTilstand({ ...s.tilstand, rom: 'ko' });
    window.KoTavle?.visOppgave?.(id);
  }

  window.KoPlaner = {
    /** Merket på et køkort: bytt til Planer med posten åpen (filtrene nullstilles, så posten alltid står i listen). */
    aapnePost(id) {
      brukTilstand({ ...V.lesUrl('?rom=planer'), post: id, fane: 'sammendrag' }, { rull: true });
      rom.querySelector('.planer-post.valgt .planer-post-knapp')?.focus();
    },
    /** Tittelen på en planpost (for merket på køkortet), eller null før registeret er hentet. */
    tittel(id) {
      return postFor(id)?.tittel ?? null;
    },
  };

  // ---- Start ----
  visRom();
  hent();
  // tastaturet og Ctrl+K (arbeid.js), og live oppdatering: et kall som venter til registeret endres, så
  // endringer fra en Claude Code-økt vises uten omlasting. Feiler det, prøves det igjen om litt; intervallet
  // under er reserven.
  window.KoPlanArbeid?.installer(arbeidHjelp);
  async function lytt() {
    if (erPlaner() && !document.hidden && s.versjon && !s.lytter) {
      await hent(false, { vent: true });
      setTimeout(lytt, s.feil ? 10_000 : 50);
      return;
    }
    setTimeout(lytt, 1_000);
  }
  lytt();
  setInterval(() => {
    if (!document.hidden && erPlaner()) hent();
  }, 15_000);
  window.addEventListener('focus', () => {
    if (erPlaner()) hent();
  });
})();
