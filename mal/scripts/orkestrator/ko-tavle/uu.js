// =============================================================
// uu.js: felles tilgjengelighetslogikk for køtavla.
//
// Fila er både et CommonJS-modul (vitest, lib/__tests__/koTavleUu.test.ts) og et skript i nettleseren
// (ko-tavle.mjs serverer den som /uu.js, og den setter window.KoUu), så tavla bruker nøyaktig den koden testene
// sjekker. De rene delene (ingen DOM) er testet; DOM-hjelperne under er tynne lag over dem.
//
//   - Fokusfella: én felles funksjon for alle dialogene (sidepanelet, vaktdialogen, massehandlingene og planens
//     dialog), i stedet for tre kopier. `nesteIFella` er regelen, `fellaTast` bruker den på et Tab-trykk.
//   - Inert: resten av siden (toppen, tavla, stripene) gjøres inert mens sidepanelet er åpent.
//   - Toast-køen: én stabel for meldingen og «Angre», så de aldri ligger oppå hverandre.
//   - Kontrast: WCAG 2-forholdet mellom to farger (K1 regnes ut fra paletten i testen).
//   - Fanene: hvilken fane piltastene går til.
//   - Tegnforklaringen: klassene K, D, D+ og U, og WIP-teksten i Pågår.
//   - Nøkkelen fra lenken som limes inn etter en omstart av serveren.
//   - Temavalget (System, Lys, Mørk).
//   - Tomtilstanden og foreldede data.
// =============================================================
(function (rot, fabrikk) {
  if (typeof module === 'object' && module.exports) module.exports = fabrikk();
  else rot.KoUu = fabrikk();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- Fokusfella ----

  /** Elementene som kan få fokus med Tab inne i en dialog. */
  const FOKUSERBARE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

  /**
   * Hvor fokus skal når Tab trykkes i en dialog med `antall` fokuserbare elementer, der elementet med fokus har
   * indeks `i` (-1 = fokus er utenfor lista, f.eks. på selve dialogen). Tab går rundt fra siste til første,
   * Shift+Tab fra første til siste. Returnerer -1 når det ikke finnes noe å fokusere.
   */
  function nesteIFella(antall, i, bakover) {
    if (!(antall > 0)) return -1;
    if (bakover) return i <= 0 ? antall - 1 : Math.min(i, antall) - 1;
    return i < 0 || i >= antall - 1 ? 0 : i + 1;
  }

  /** De fokuserbare elementene i `boks`, uten dem som ligger i noe skjult eller inert. */
  function fokuserbare(boks) {
    return [...boks.querySelectorAll(FOKUSERBARE)].filter(
      (x) => !x.closest('[hidden]') && !x.closest('[inert]'),
    );
  }

  /**
   * Fokusfella: kalles fra dialogens keydown. Ved Tab blir fokus i `boks` (går rundt i endene). Returnerer true når
   * tasten ble håndtert. Esc og andre taster håndterer hver dialog selv.
   */
  function fellaTast(e, boks) {
    if (e.key !== 'Tab' || !boks) return false;
    const liste = fokuserbare(boks);
    const j = nesteIFella(liste.length, liste.indexOf(document.activeElement), e.shiftKey);
    e.preventDefault();
    if (j >= 0) liste[j].focus();
    return true;
  }

  /** Setter eller fjerner `inert` på elementene (de som finnes). Brukes mens sidepanelet er åpent. */
  function settInert(elementer, pa) {
    for (const x of elementer) {
      if (!x) continue;
      if (pa) x.setAttribute('inert', '');
      else x.removeAttribute('inert');
    }
  }

  // ---- Toast-køen ----

  /**
   * Én stabel for meldingene nederst. Køen er en liste med nøkler (f.eks. 'melding' og 'angre'),
   * eldste først. En nøkkel som vises på nytt, flyttes nederst (nyest), så stabelen aldri har den samme to ganger.
   * Blir lista lengre enn `maks`, faller de eldste ut, men aldri en nøkkel i `beholdes` (Angre skal stå i 30 s).
   */
  function toastLegg(ko, nokkel, { maks = 3, beholdes = [] } = {}) {
    const ny = [...ko.filter((x) => x !== nokkel), nokkel];
    while (ny.length > maks) {
      const i = ny.findIndex((x) => x !== nokkel && !beholdes.includes(x));
      if (i < 0) break;
      ny.splice(i, 1);
    }
    return ny;
  }
  function toastFjern(ko, nokkel) {
    return ko.filter((x) => x !== nokkel);
  }

  // ---- Kontrast (WCAG 2) ----

  /** Relativ luminans for en farge på formen #rrggbb. */
  function luminans(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
    if (!m) return NaN;
    const kanal = (i) => {
      const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * kanal(0) + 0.7152 * kanal(2) + 0.0722 * kanal(4);
  }

  /** Kontrastforholdet mellom to farger (1 til 21), rundet ned til to desimaler så 4,499 aldri blir «4,5». */
  function kontrast(a, b) {
    const la = luminans(a);
    const lb = luminans(b);
    if (!Number.isFinite(la) || !Number.isFinite(lb)) return NaN;
    const r = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    return Math.floor(r * 100) / 100;
  }

  // ---- Fanene (Visning) ----

  /**
   * Fanen piltastene flytter fokus til: venstre og høyre går rundt, Home og End til endene. Returnerer null for
   * andre taster. Aktiveringen er manuell (Enter eller mellomrom), fordi en tegning av tavla kan ta tid.
   */
  function faneMaal(antall, i, tast) {
    if (!(antall > 0)) return null;
    switch (tast) {
      case 'ArrowRight':
        return (i + 1) % antall;
      case 'ArrowLeft':
        return (i - 1 + antall) % antall;
      case 'Home':
        return 0;
      case 'End':
        return antall - 1;
      default:
        return null;
    }
  }

  // ---- Tegnforklaringen ----

  /** Risikoklassene, med kort navn og forklaring (samme inndeling som skillen legg-til-ko). */
  const KLASSER = [
    {
      klasse: 'K',
      navn: 'klient og grensesnitt',
      forklaring: 'Kode i applikasjonen eller verktøyene, og lesende databasekall.',
    },
    {
      klasse: 'D',
      navn: 'database',
      forklaring: 'Migrasjoner som redefinerer funksjoner eller lager nye RPC-er.',
    },
    {
      klasse: 'D+',
      navn: 'database med ny tabell eller personvern',
      forklaring:
        'Ny tabell, retensjon eller anonymisering, edge uten innlogging, eller endring i en delt funksjon. ' +
        'Høyst et fast antall samtidig.',
    },
    { klasse: 'U', navn: 'utredning', forklaring: 'Undersøkelse og forslag uten kode.' },
  ];

  /** Lesbar etikett for klassemerket, f.eks. «Risikoklasse D+: database med ny tabell eller personvern». */
  function klasseEtikett(klasse) {
    const k = KLASSER.find((x) => x.klasse === klasse);
    return k ? `Risikoklasse ${k.klasse}: ${k.navn}` : `Risikoklasse ${klasse}`;
  }

  /** WIP-chipen i Pågår som vanlig tekst: «Agenter 3 av 4 · tunge 1 av 2 · 2 plukket». */
  function wipTekst(w) {
    if (!w) return '';
    return (
      `Agenter ${w.agenter} av ${w.maks} · tunge ${w.dPluss} av ${w.maksDPluss}` +
      (w.plukket ? ` · ${w.plukket} plukket` : '')
    );
  }

  // ---- Nøkkelen etter en omstart ----

  /**
   * Nøkkelen fra lenken ko-tavle skrev i terminalen (`…/#nokkel=abc`), limt inn i banneret. Leser bare #-delen
   * (eller &nokkel= i den). Ren nøkkel uten lenke godtas også. Returnerer null når teksten ikke har noen nøkkel.
   */
  function nokkelFraLenke(tekst) {
    const s = String(tekst ?? '').trim();
    if (!s) return null;
    const hash = s.includes('#') ? s.slice(s.indexOf('#')) : null;
    if (hash) {
      const m = /[#&]nokkel=([A-Za-z0-9_-]+)/.exec(hash);
      return m ? m[1] : null;
    }
    return /^[A-Za-z0-9_-]{16,}$/.test(s) ? s : null;
  }

  // ---- Temaet ----

  const TEMA_VALG = [
    { verdi: 'system', tekst: 'System' },
    { verdi: 'lys', tekst: 'Lys' },
    { verdi: 'mork', tekst: 'Mørk' },
  ];
  /** Det lagrede valget fra localStorage: 'lys', 'mork' eller 'system' (ingen eller ukjent verdi). */
  function temaFraLagret(v) {
    return v === 'lys' || v === 'mork' ? v : 'system';
  }
  /** Neste valg når temaknappen i toppen trykkes: System → Lys → Mørk → System. */
  function nesteTema(v) {
    const i = TEMA_VALG.findIndex((x) => x.verdi === temaFraLagret(v));
    return TEMA_VALG[(i + 1) % TEMA_VALG.length].verdi;
  }

  // ---- Tomtilstanden ----

  /**
   * Hvorfor en liste er tom, og hvilken handling som viser kortene igjen. Én regel for alle tomtilstandene.
   *   tekst:      grunnteksten for lista («Ingenting her.»)
   *   sokSkjuler: lista har kort, men søket skjuler alle
   *   sok:        søketeksten (tom streng når søket er av)
   *   filtre:     antall valg i Filter-menyen
   *   utvalg:     navnet på utvalget som er i bruk, eller null
   * Svar: { tekst, handling: 'sok' | 'filter' | 'utvalg' | null, etikett }. Søket går foran filteret, og filteret
   * foran utvalget: én handling om gangen, og den som skjuler kortene her nevnes først.
   */
  function tomGrunn({ tekst, sokSkjuler = false, sok = '', filtre = 0, utvalg = null }) {
    if (sokSkjuler && sok)
      return { tekst: `Ingen treff på «${sok}».`, handling: 'sok', etikett: 'Tøm søket' };
    if (filtre > 0)
      return {
        tekst: `${tekst} Filteret er på (${filtre} valgt).`,
        handling: 'filter',
        etikett: 'Fjern filter',
      };
    if (utvalg)
      return {
        tekst: `${tekst} Utvalget «${utvalg}» er i bruk.`,
        handling: 'utvalg',
        etikett: 'Vis alle',
      };
    return { tekst, handling: null, etikett: null };
  }

  // ---- Foreldede data ----

  /** Grensen for når dataene regnes som foreldet: siste vellykkede henting er eldre enn ett minutt. */
  const FORELDET_MS = 60_000;

  /** Er siste henting (ms siden epoch, eller null) eldre enn grensen ved `naa`? Uten henting: ikke foreldet. */
  function foreldet(hentetMs, naaMs, grense = FORELDET_MS) {
    return Number.isFinite(hentetMs) && naaMs - hentetMs > grense;
  }

  /** «Ikke oppdatert siden 14:05» (lokal tid, timer og minutter). */
  function foreldetTekst(hentet) {
    const t = String(hentet.getHours()).padStart(2, '0');
    const m = String(hentet.getMinutes()).padStart(2, '0');
    return `Ikke oppdatert siden ${t}:${m}`;
  }

  return {
    tomGrunn,
    FORELDET_MS,
    foreldet,
    foreldetTekst,
    FOKUSERBARE,
    nesteIFella,
    fokuserbare,
    fellaTast,
    settInert,
    toastLegg,
    toastFjern,
    luminans,
    kontrast,
    faneMaal,
    KLASSER,
    klasseEtikett,
    wipTekst,
    nokkelFraLenke,
    TEMA_VALG,
    temaFraLagret,
    nesteTema,
  };
});
