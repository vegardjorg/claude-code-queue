// =============================================================
// plan.js: planvisningen på kø-tavla. Vanilla JS, ingen byggesteg.
//
// Fire kolonner: «Nå» og «Neste» er fokusperioden (trinnene i rekkefølge; Nå = de første trinnene), «Senere» er resten
// (startes ikke når resten venter), og «Venter» er prosjekter på pause. Områder, prosjekter og funksjoner dras mellom
// kolonnene med mus eller tastatur (mellomrom løfter, piltastene flytter, mellomrom slipper, Esc avbryter). Endringene
// samles i et utkast; «Lagre fokus» viser først hva som endres og hva køen starter etterpå (POST /api/fokus med torr),
// og lagrer først når eieren bekrefter (ko.mjs fokus lagre, alt eller ingenting, med køens versjon fra
// forhåndsvisningen). «Områder» oppretter og endrer områder og flytter prosjekter mellom dem (POST /api/omrade), også
// med forklaring før lagring.
// Tallene (ventende, klare, minutter, eierspørsmål, dratt med) regnes på serveren (koTavle.planGrunnlag); her er bare
// visning og samspill. All tekst settes med textContent (via el), aldri innerHTML.
// =============================================================
'use strict';

(function () {
  const KOLONNER = [
    {
      nokkel: 'naa',
      navn: 'Nå',
      hjelp:
        'Trinnene køen tar først, i rekkefølge ovenfra. Alt i et trinn startes før noe i neste trinn, uansett poeng.',
    },
    {
      nokkel: 'neste',
      navn: 'Neste',
      hjelp: 'Trinnene som kommer etter Nå, i rekkefølge. De startes når Nå ikke har noe klart.',
    },
    {
      nokkel: 'senere',
      navn: 'Senere',
      hjelp:
        'Resten av køen. Med «resten venter» startes ingenting herfra før fokuset endres; med «fyll ledige plasser» ' +
        'bare når fokuset ikke har noe klart.',
    },
    {
      nokkel: 'venter',
      navn: 'Venter',
      hjelp:
        'Prosjekter på pause. De startes ikke, heller ikke om noe i fokus venter på dem. Dra et prosjekt hit for å ' +
        'pause det, eller ut herfra for å fortsette.',
    },
  ];
  const TYPE_NAVN = { omrade: 'Område', prosjekt: 'Prosjekt', funksjon: 'Funksjon' };

  const s = {
    ctx: null,
    utkast: null, // { naa, neste, pause: Set, resten, til, navn, dra_med } (null = ingen ulagrede endringer)
    grunnlag: null, // serverens plan (JSON) da utkastet ble startet: endret imens → merknad
    apne: new Set(), // prosjekter som viser funksjonene sine
    dra: null, // { nokkel } mens noe dras med mus
    loftet: null, // { nokkel, for } mens noe er løftet med tastaturet (for = utkastet før løftet, til Esc)
    dialog: null, // åpen dialog (forhåndsvisning eller områder)
  };

  // ---- Hjelpere ----
  const el = (...a) => s.ctx.el(...a);
  const data = () => s.ctx.data;
  const typeFor = (nokkel) => nokkel.slice(0, nokkel.indexOf(':'));
  const restFor = (nokkel) => nokkel.slice(nokkel.indexOf(':') + 1);

  /** «49 t», «3 t 20 min», «45 min». */
  function tid(min) {
    const m = Math.round(Number(min) || 0);
    if (m < 60) return `${m} min`;
    const t = Math.floor(m / 60);
    return t >= 10 || !(m % 60) ? `${t} t` : `${t} t ${m % 60} min`;
  }

  /** Planen slik den er lagret i køen (fokus og pausede prosjekter). */
  function serverPlan() {
    const f = data()?.fokus;
    return {
      naa: [...(f?.naa ?? [])],
      neste: [...(f?.neste ?? [])],
      pause: new Set((data()?.plan?.prosjekter ?? []).filter((p) => p.pause).map((p) => p.pid)),
      resten: f?.resten === 'fyll' ? 'fyll' : 'vent',
      til: f?.til ? String(f.til).slice(0, 10) : '',
      navn: f?.navn ?? '',
      dra_med: f ? f.dra_med !== false : true,
    };
  }
  const normal = (p) =>
    JSON.stringify({ ...p, pause: [...p.pause].sort(), naa: p.naa, neste: p.neste });
  const gjeldende = () => s.utkast ?? serverPlan();
  const harEndringer = () => !!s.utkast && normal(s.utkast) !== normal(serverPlan());

  /** Starter et utkast (første endring) og husker serverens plan, så tavla kan si fra om køen endres imens. */
  function utkast() {
    if (!s.utkast) {
      s.utkast = serverPlan();
      s.grunnlag = normal(s.utkast);
    }
    return s.utkast;
  }
  function kopi(p) {
    return { ...p, naa: [...p.naa], neste: [...p.neste], pause: new Set(p.pause) };
  }

  const prosjektRad = (pid) => data()?.plan?.prosjekter.find((p) => p.pid === pid) ?? null;
  const omradeRad = (oid) => data()?.plan?.omrader.find((o) => o.oid === oid) ?? null;

  /** Tittel og tall for et element (område, prosjekt eller funksjon). */
  function info(nokkel) {
    const type = typeFor(nokkel);
    const rest = restFor(nokkel);
    if (type === 'omrade') {
      const o = omradeRad(rest);
      return { type, tittel: o?.tittel ?? rest, tall: o, finnes: !!o?.i_register };
    }
    if (type === 'prosjekt') {
      const p = prosjektRad(rest);
      return { type, tittel: p?.tittel ?? rest, tall: p, finnes: !!p };
    }
    const pid = rest.slice(0, rest.indexOf('/'));
    const navn = rest.slice(rest.indexOf('/') + 1);
    const f = prosjektRad(pid)?.funksjoner.find((x) => x.navn === navn) ?? null;
    return { type, tittel: navn, pid, tall: f, finnes: !!f };
  }

  /** Hvor et element står i planen nå: naa, neste, venter (pauset prosjekt) eller senere. */
  function kolonneFor(p, nokkel) {
    if (p.naa.includes(nokkel)) return 'naa';
    if (p.neste.includes(nokkel)) return 'neste';
    if (typeFor(nokkel) === 'prosjekt' && p.pause.has(restFor(nokkel))) return 'venter';
    return 'senere';
  }

  // ---- Flytting (felles for mus og tastatur) ----
  /**
   * Flytter et element til en kolonne (på plass `indeks` i Nå/Neste; ellers sist). Returnerer en feilmelding når
   * flyttingen ikke gir mening (et område eller en funksjon kan ikke settes på pause).
   */
  function flytt(nokkel, kol, indeks = null) {
    const type = typeFor(nokkel);
    if (kol === 'venter' && type !== 'prosjekt')
      return type === 'omrade'
        ? 'Et område kan ikke settes på pause. Dra prosjektene i området til Venter, eller la området stå i Senere.'
        : 'En funksjon kan ikke settes på pause. Bruk «Sett på vent» på oppgavene, eller la funksjonen stå i Senere.';
    const p = utkast();
    p.naa = p.naa.filter((x) => x !== nokkel);
    p.neste = p.neste.filter((x) => x !== nokkel);
    if (type === 'prosjekt') p.pause.delete(restFor(nokkel));
    if (kol === 'naa' || kol === 'neste') {
      const liste = p[kol];
      const i = indeks == null ? liste.length : Math.max(0, Math.min(indeks, liste.length));
      liste.splice(i, 0, nokkel);
    } else if (kol === 'venter') p.pause.add(restFor(nokkel));
    return null;
  }

  // ---- Tegning ----
  function tegn(ctx) {
    s.ctx = ctx;
    const d = data();
    const main = ctx.main;
    if (!d?.plan) {
      main.append(el('p', { class: 'tom', tekst: 'Henter køen …' }));
      return;
    }
    const p = gjeldende();
    const fokus = document.activeElement?.closest?.('.plan-element')?.dataset.nokkel ?? null;
    main.append(
      el(
        'div',
        { class: 'plan-visning' },
        verktoylinje(p),
        el(
          'div',
          { class: 'plan-kolonner' },
          KOLONNER.map((k) => kolonne(k, p)),
        ),
      ),
    );
    const mal = s.loftet?.nokkel ?? fokus;
    if (mal)
      main
        .querySelector(`.plan-element[data-nokkel="${CSS.escape(mal)}"]`)
        ?.focus({ preventScroll: !s.loftet });
  }

  function verktoylinje(p) {
    const endret = harEndringer();
    const serverEndret = s.utkast && s.grunnlag !== normal(serverPlan());
    const settFelt = (felt, verdi) => {
      utkast()[felt] = verdi;
      s.ctx.tegnPaaNytt();
    };
    const tomNaa = !p.naa.length && p.neste.length > 0;
    return el(
      'div',
      { class: 'plan-verktoy', role: 'toolbar', 'aria-label': 'Fokus' },
      el(
        'label',
        {
          class: 'plan-felt',
          title: 'Et kort navn på fokusperioden, for eksempel «Eksport først, så API». Valgfritt.',
        },
        el('span', { tekst: 'Navn' }),
        el('input', {
          type: 'text',
          maxlength: 200,
          value: p.navn,
          placeholder: 'valgfritt',
          'aria-label': 'Navn på fokusperioden',
          onchange: (e) => settFelt('navn', e.target.value.trim()),
        }),
      ),
      el(
        'label',
        {
          class: 'plan-felt',
          title:
            'Hva skjer med oppgavene utenfor Nå og Neste? «Vent helt» sparer penger: plasser kan stå tomme. ' +
            '«Fyll ledige plasser» starter dem bare når fokuset ikke har noe klart.',
        },
        el('span', { tekst: 'Resten' }),
        el(
          'select',
          {
            'aria-label': 'Resten av køen',
            onchange: (e) => settFelt('resten', e.target.value),
          },
          el('option', { value: 'vent', tekst: 'venter helt', selected: p.resten === 'vent' }),
          el('option', {
            value: 'fyll',
            tekst: 'fyller ledige plasser',
            selected: p.resten === 'fyll',
          }),
        ),
      ),
      el(
        'label',
        {
          class: 'plan-felt',
          title:
            'Valgfri sluttdato (til og med dagen). Uten dato gjelder fokuset til du endrer det. Når perioden er ute, ' +
            'får du varsel, og køen går etter poeng igjen.',
        },
        el('span', { tekst: 'Til' }),
        el('input', {
          type: 'date',
          value: p.til,
          min: new Date().toISOString().slice(0, 10),
          'aria-label': 'Fokuset gjelder til og med',
          onchange: (e) => settFelt('til', e.target.value || ''),
        }),
      ),
      el(
        'label',
        {
          class: 'plan-felt plan-avkrysning',
          title:
            'Når noe i fokus venter på en oppgave utenfor trinnene (for eksempel en datamodell som en annen del bygger på), ' +
            'får den samme trinn, så fokuset ikke blir stående. Anbefalt.',
        },
        el('input', {
          type: 'checkbox',
          checked: p.dra_med,
          onchange: (e) => settFelt('dra_med', e.target.checked),
        }),
        el('span', { tekst: 'Dra med avhengigheter' }),
      ),
      el('span', {
        class: `plan-utkast${endret ? ' aktiv' : ''}`,
        role: 'status',
        tekst: endret
          ? `Utkast, ikke lagret${serverEndret ? '. Køen er endret imens; forhåndsvisningen sjekker mot den nye.' : ''}`
          : 'Ingen ulagrede endringer',
        title: endret
          ? 'Endringene gjelder ikke før du trykker «Lagre fokus» og bekrefter.'
          : 'Dra områder, prosjekter og funksjoner mellom kolonnene for å endre fokus.',
      }),
      tomNaa
        ? el('span', {
            class: 'plan-merknad',
            tekst: 'Nå er tom: det første trinnet i Neste blir Nå ved lagring.',
          })
        : null,
      el('button', {
        type: 'button',
        class: 'knapp knapp-kontur knapp-liten',
        tekst: 'Områder …',
        title:
          'Opprett og gi navn til områder (programdeler), og flytt prosjekter mellom dem. Du ser hva som endres før det ' +
          'lagres.',
        onclick: aapneOmrader,
      }),
      el('button', {
        type: 'button',
        class: 'knapp knapp-kontur knapp-liten',
        tekst: 'Tøm fokus',
        disabled: !p.naa.length && !p.neste.length,
        title:
          'Flytter alle trinn til Senere i utkastet. Lagret uten trinn betyr ingen fokus: køen går etter poeng og ' +
          'prosjekttillegg.',
        onclick: () => {
          const u = utkast();
          u.naa = [];
          u.neste = [];
          s.ctx.tegnPaaNytt();
        },
      }),
      el('button', {
        type: 'button',
        class: 'knapp knapp-kontur knapp-liten',
        tekst: 'Forkast',
        disabled: !s.utkast,
        title: 'Glem utkastet og vis fokuset slik det er lagret i køen. Ingenting i køen endres.',
        onclick: () => {
          s.utkast = null;
          s.grunnlag = null;
          s.ctx.tegnPaaNytt();
        },
      }),
      el('button', {
        type: 'button',
        class: 'knapp knapp-fylt knapp-liten',
        tekst: 'Lagre fokus',
        disabled: !endret,
        title:
          'Viser først hva som endres og hva køen starter etterpå. Ingenting lagres før du bekrefter, og alt ' +
          'lagres samlet eller ikke i det hele tatt.',
        onclick: forhandsvis,
      }),
    );
  }

  /** Elementene i en kolonne, i rekkefølge. Senere: områder og prosjekter uten område som ikke står andre steder. */
  function elementerI(kol, p) {
    if (kol === 'naa' || kol === 'neste') return p[kol];
    const d = data();
    if (kol === 'venter') return [...p.pause].sort().map((pid) => `prosjekt:${pid}`);
    const ut = [];
    for (const o of d.plan.omrader) {
      if (o.oid === 'uten-omrade' || !o.i_register) continue;
      const nokkel = `omrade:${o.oid}`;
      if (kolonneFor(p, nokkel) === 'senere') ut.push(nokkel);
    }
    // Prosjekter uten (kjent) område, og funksjoner som har vært i et trinn, står for seg selv i Senere.
    for (const pr of d.plan.prosjekter) {
      const harOmrade = d.plan.omrader.some(
        (o) => o.i_register && o.oid !== 'uten-omrade' && o.oid === pr.omrade,
      );
      const nokkel = `prosjekt:${pr.pid}`;
      if (!harOmrade && synligProsjekt(pr, p) && kolonneFor(p, nokkel) === 'senere')
        ut.push(nokkel);
    }
    return ut;
  }

  /** Prosjekter med noe å gjøre (ventende eller aktive), eller som er i et trinn eller på pause. */
  function synligProsjekt(pr, p) {
    const nokkel = `prosjekt:${pr.pid}`;
    return (
      pr.venter > 0 ||
      pr.aktive > 0 ||
      p.naa.includes(nokkel) ||
      p.neste.includes(nokkel) ||
      p.pause.has(pr.pid)
    );
  }

  function kolonne(k, p) {
    const elementer = elementerI(k.nokkel, p);
    const ordnet = k.nokkel === 'naa' || k.nokkel === 'neste';
    const forskyv = k.nokkel === 'neste' ? p.naa.length : 0;
    const sum = elementer.reduce(
      (acc, n) => {
        const t = info(n).tall;
        return { venter: acc.venter + (t?.venter ?? 0), min: acc.min + (t?.min_igjen ?? 0) };
      },
      { venter: 0, min: 0 },
    );
    const liste = el(
      'ol',
      {
        class: 'plan-liste',
        'data-kol': k.nokkel,
        'aria-label': `${k.navn}: ${elementer.length} ${elementer.length === 1 ? 'element' : 'elementer'}`,
        ondragover: (e) => dragOver(e),
        ondragleave: (e) => {
          if (!e.currentTarget.contains(e.relatedTarget))
            e.currentTarget.classList.remove('slipp-her');
        },
        ondrop: (e) => slipp(e, k.nokkel),
      },
      elementer.length
        ? elementer.map((n, i) => element(n, p, ordnet ? forskyv + i + 1 : null))
        : el('li', {
            class: 'plan-tom',
            tekst:
              k.nokkel === 'venter'
                ? 'Ingen prosjekter på pause.'
                : k.nokkel === 'senere'
                  ? 'Alt står i fokus.'
                  : 'Dra et område, prosjekt eller funksjon hit.',
          }),
    );
    return el(
      'section',
      { class: `plan-kolonne plan-${k.nokkel}`, 'aria-label': k.navn },
      el(
        'header',
        { class: 'kol-hode', title: k.hjelp },
        el('h2', { tekst: k.navn }),
        el('span', {
          class: 'teller',
          tekst: `${sum.venter} · ${tid(sum.min)}`,
          title: `${sum.venter} ventende oppgaver, ${tid(sum.min)} anslått igjen i kolonnen`,
        }),
      ),
      el('p', { class: 'plan-kol-hjelp', tekst: k.hjelp }),
      liste,
    );
  }

  /** Tallraden for et område, prosjekt eller en funksjon (hvert tall har forklaring i title). */
  function tall(t, { pause = false } = {}) {
    if (!t) return el('span', { class: 'plan-tall', tekst: 'ingen åpne oppgaver' });
    const deler = [
      el('span', {
        tekst: `${t.venter} venter`,
        title: 'Ventende oppgaver (uten samlekøen og forslag)',
      }),
      el('span', {
        tekst: `${t.klare} klare`,
        title:
          'Uten hindringer bortsett fra fokus og pause: de kan startes så snart de er i fokus og en plass er ledig.',
      }),
      el('span', { tekst: tid(t.min_igjen), title: 'Anslått tid igjen for de ventende' }),
    ];
    if (t.aktive)
      deler.push(
        el('span', { tekst: `${t.aktive} pågår`, title: 'Kjører, plukket eller i review' }),
      );
    if (t.parkert)
      deler.push(
        el('span', { tekst: `${t.parkert} på vent`, title: 'Parkerte oppgaver (Sett på vent)' }),
      );
    if (t.sporsmal)
      deler.push(
        el('span', {
          class: 'plan-sp',
          tekst: `${t.sporsmal} spørsmål`,
          title: 'Åpne eierspørsmål som oppgaver her venter på (se Venter på deg)',
        }),
      );
    if (t.dratt)
      deler.push(
        el('span', {
          class: 'plan-dratt',
          tekst: `↳ ${t.dratt} dratt med`,
          title:
            'Oppgaver her som noe i fokus venter på. De får fokusoppgavens trinn, selv om de står utenfor trinnene.',
        }),
      );
    if (pause) deler.push(el('span', { class: 'merke gammel', tekst: 'pauset' }));
    return el('span', { class: 'plan-tall' }, deler);
  }

  /** Ett element (kort) i en kolonne: område med prosjektene, prosjekt med funksjonene, eller funksjon. */
  function element(nokkel, p, trinnNr) {
    const i = info(nokkel);
    const kol = kolonneFor(p, nokkel);
    const navn = TYPE_NAVN[i.type];
    const hode = el(
      'div',
      { class: 'plan-hode' },
      s.ctx.ikon('handtak'),
      trinnNr
        ? el('span', {
            class: 'plan-trinn',
            tekst: `T${trinnNr}`,
            title: `Trinn ${trinnNr}: alt her startes før noe i trinn ${trinnNr + 1}`,
          })
        : null,
      el('span', { class: `merke plan-type plan-type-${i.type}`, tekst: navn }),
      el('span', {
        class: 'plan-navn',
        tekst: i.type === 'funksjon' ? `${i.pid} › ${i.tittel}` : i.tittel,
      }),
      !i.finnes
        ? el('span', {
            class: 'merke gammel',
            tekst: 'finnes ikke',
            title: 'Trinnet peker på noe som ikke finnes i køen lenger. Dra det til Senere.',
          })
        : null,
    );
    const barn = [];
    if (i.type === 'omrade') {
      // Prosjektene i området som ikke står i et eget trinn eller på pause (de vises der).
      const mine = (i.tall?.prosjekter ?? [])
        .map((pid) => prosjektRad(pid))
        .filter((pr) => pr && synligProsjekt(pr, p))
        .filter((pr) => kolonneFor(p, `prosjekt:${pr.pid}`) === 'senere');
      const andre = (i.tall?.prosjekter ?? []).filter(
        (pid) => kolonneFor(p, `prosjekt:${pid}`) !== 'senere',
      );
      if (mine.length)
        barn.push(
          el(
            'ul',
            { class: 'plan-under' },
            mine.map((pr) => underElement(`prosjekt:${pr.pid}`, p)),
          ),
        );
      if (andre.length)
        barn.push(
          el('p', {
            class: 'plan-merknad',
            tekst: `Står for seg: ${andre.join(', ')}`,
            title:
              'Prosjekter i området som har eget trinn eller er på pause. Eget trinn går foran områdets trinn.',
          }),
        );
    }
    if (i.type === 'prosjekt') barn.push(...funksjonsListe(restFor(nokkel), p));
    return el(
      'li',
      {
        class: `plan-element plan-${i.type}${s.loftet?.nokkel === nokkel ? ' loftet' : ''}`,
        'data-nokkel': nokkel,
        tabindex: 0,
        draggable: 'true',
        'aria-label':
          `${navn} ${i.tittel}, i ${KOLONNER.find((k) => k.nokkel === kol).navn}` +
          `${trinnNr ? `, trinn ${trinnNr}` : ''}. Mellomrom løfter, piltastene flytter.`,
        title: `${navn} ${i.tittel}. Dra til en annen kolonne, eller løft med mellomrom og flytt med piltastene.`,
        ondragstart: (e) => dragStart(e, nokkel),
        ondragend: dragEnd,
        onkeydown: (e) => tast(e, nokkel),
      },
      hode,
      tall(i.tall, { pause: i.type === 'prosjekt' && p.pause.has(restFor(nokkel)) }),
      barn,
    );
  }

  /** Et prosjekt inne i et område (kan dras ut til eget trinn eller til Venter). */
  function underElement(nokkel, p) {
    const i = info(nokkel);
    return el(
      'li',
      {
        class: `plan-element plan-underelement${s.loftet?.nokkel === nokkel ? ' loftet' : ''}`,
        'data-nokkel': nokkel,
        tabindex: 0,
        draggable: 'true',
        'aria-label': `Prosjekt ${i.tittel} i området. Dra ut for å gi det eget trinn. Mellomrom løfter.`,
        title: `Prosjekt ${i.tittel}. Dra det ut av området for å gi det eget trinn (for eksempel «Widgets nå, resten av Plattform senere»), eller til Venter for å pause det.`,
        ondragstart: (e) => dragStart(e, nokkel),
        ondragend: dragEnd,
        onkeydown: (e) => tast(e, nokkel),
      },
      el(
        'div',
        { class: 'plan-hode' },
        s.ctx.ikon('handtak'),
        el('span', { class: 'plan-navn', tekst: i.tittel }),
        el('span', { class: 'pid', tekst: restFor(nokkel) }),
      ),
      tall(i.tall),
      ...funksjonsListe(restFor(nokkel), p),
    );
  }

  /** «▸ Funksjoner (6)» og, når den er åpen, funksjonene (kan dras til Nå/Neste som eget trinn). */
  function funksjonsListe(pid, p) {
    const pr = prosjektRad(pid);
    const funksjoner = (pr?.funksjoner ?? []).filter(
      (f) => f.venter > 0 && kolonneFor(p, f.trinn) === 'senere',
    );
    if (!funksjoner.length) return [];
    const apen = s.apne.has(pid);
    // Pila er pynt (aria-hidden); tilstanden leses fra aria-expanded, navnet fra teksten.
    const knapp = el(
      'button',
      {
        type: 'button',
        class: 'lenke-knapp plan-utvid',
        'aria-expanded': apen ? 'true' : 'false',
        title:
          'Vis funksjonene i prosjektet. En funksjon kan dras til Nå eller Neste som eget trinn.',
        onclick: (e) => {
          e.stopPropagation();
          if (apen) s.apne.delete(pid);
          else s.apne.add(pid);
          s.ctx.tegnPaaNytt();
        },
      },
      el('span', { 'aria-hidden': 'true', tekst: apen ? '▾ ' : '▸ ' }),
      `Funksjoner (${funksjoner.length})`,
    );
    if (!apen) return [knapp];
    return [
      knapp,
      el(
        'ul',
        { class: 'plan-under plan-funksjoner' },
        funksjoner.map((f) =>
          el(
            'li',
            {
              class: `plan-element plan-funksjon-rad${s.loftet?.nokkel === f.trinn ? ' loftet' : ''}`,
              'data-nokkel': f.trinn,
              tabindex: 0,
              draggable: 'true',
              'aria-label': `Funksjon ${f.navn}. Dra til Nå eller Neste for å gi den eget trinn. Mellomrom løfter.`,
              title: `Funksjon ${f.navn}: dra til Nå eller Neste for å gi den eget trinn.`,
              ondragstart: (e) => dragStart(e, f.trinn),
              ondragend: dragEnd,
              onkeydown: (e) => tast(e, f.trinn),
            },
            el(
              'div',
              { class: 'plan-hode' },
              s.ctx.ikon('handtak'),
              el('span', { class: 'plan-navn', tekst: f.navn }),
            ),
            tall(f),
          ),
        ),
      ),
    ];
  }

  // ---- Dra med mus ----
  function dragStart(e, nokkel) {
    e.stopPropagation();
    s.dra = { nokkel };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', nokkel);
    e.currentTarget.classList.add('dras');
  }
  function dragEnd(e) {
    e.currentTarget.classList.remove('dras');
    for (const x of document.querySelectorAll('.plan-liste.slipp-her'))
      x.classList.remove('slipp-her');
    s.dra = null;
    if (s.ctx.ventende()) s.ctx.tegnPaaNytt();
  }
  function dragOver(e) {
    if (!s.dra) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('slipp-her');
  }
  /** Plassen i lista der elementet slippes: før det første elementet som har midten under musa. */
  function slippIndeks(liste, y) {
    const elementer = [...liste.querySelectorAll(':scope > .plan-element')].filter(
      (x) => x.dataset.nokkel !== s.dra?.nokkel,
    );
    const i = elementer.findIndex((x) => {
      const r = x.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    return i < 0 ? elementer.length : i;
  }
  function slipp(e, kol) {
    if (!s.dra) return;
    e.preventDefault();
    const nokkel = s.dra.nokkel;
    const indeks = slippIndeks(e.currentTarget, e.clientY);
    s.dra = null;
    const feil = flytt(nokkel, kol, indeks);
    if (feil) s.ctx.melding(feil, true);
    s.ctx.tegnPaaNytt();
  }

  // ---- Tastatur: mellomrom løfter, piler flytter, mellomrom slipper, Esc avbryter ----
  function tast(e, nokkel) {
    if (e.target !== e.currentTarget) return;
    const p = gjeldende();
    if (!s.loftet) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        s.loftet = { nokkel, for: kopi(p), harUtkast: !!s.utkast };
        s.ctx.status(
          `${info(nokkel).tittel} er løftet. Piltastene flytter (venstre og høyre mellom kolonnene), mellomrom slipper, Esc avbryter.`,
        );
        s.ctx.tegnPaaNytt();
      }
      return;
    }
    if (s.loftet.nokkel !== nokkel) return;
    const kol = kolonneFor(p, nokkel);
    const rekke = KOLONNER.map((k) => k.nokkel);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      let j = rekke.indexOf(kol) + (e.key === 'ArrowLeft' ? -1 : 1);
      // Et område eller en funksjon kan ikke stå i Venter: hopp over den kolonnen.
      if (rekke[j] === 'venter' && typeFor(nokkel) !== 'prosjekt') j = -1;
      if (j < 0 || j >= rekke.length) return;
      flytt(nokkel, rekke[j]);
      s.ctx.status(`I ${KOLONNER[j].navn}. Mellomrom slipper, Esc avbryter.`);
      s.ctx.tegnPaaNytt();
    } else if (
      (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
      (kol === 'naa' || kol === 'neste')
    ) {
      e.preventDefault();
      e.stopPropagation();
      const u = utkast();
      const liste = u[kol];
      const i = liste.indexOf(nokkel);
      const j = i + (e.key === 'ArrowUp' ? -1 : 1);
      // Over toppen av Neste går til bunnen av Nå, og under bunnen av Nå til toppen av Neste.
      if (j < 0 && kol === 'neste') flytt(nokkel, 'naa');
      else if (j >= liste.length && kol === 'naa') flytt(nokkel, 'neste', 0);
      else if (j >= 0 && j < liste.length) {
        liste.splice(i, 1);
        liste.splice(j, 0, nokkel);
      } else return;
      const ny = gjeldende();
      const nyKol = kolonneFor(ny, nokkel);
      const plass = ny[nyKol].indexOf(nokkel) + 1;
      s.ctx.status(`Plass ${plass} av ${ny[nyKol].length} i ${nyKol === 'naa' ? 'Nå' : 'Neste'}.`);
      s.ctx.tegnPaaNytt();
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      s.loftet = null;
      s.ctx.status('Sluppet. Endringen er i utkastet til du trykker «Lagre fokus».');
      s.ctx.tegnPaaNytt();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const l = s.loftet;
      s.loftet = null;
      s.utkast = l.harUtkast ? l.for : null;
      if (!l.harUtkast) s.grunnlag = null;
      s.ctx.status('Avbrutt.');
      s.ctx.tegnPaaNytt();
    }
  }

  // ---- Dialogen (forhåndsvisning av fokus, områder) ----
  function lagDialog() {
    let bakgrunn = document.getElementById('plan-dialog-bakgrunn');
    if (!bakgrunn) {
      bakgrunn = el(
        'div',
        { id: 'plan-dialog-bakgrunn', class: 'vakt-bakgrunn', hidden: true },
        el('div', {
          id: 'plan-dialog',
          class: 'vakt masse plan-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'plan-dialog-tittel',
        }),
      );
      bakgrunn.addEventListener('click', (e) => {
        if (e.target === bakgrunn) lukkDialog();
      });
      bakgrunn.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          lukkDialog();
        } else {
          // Fokus blir i dialogen (den felles fella i uu.js).
          window.KoUu.fellaTast(e, document.getElementById('plan-dialog'));
        }
      });
      document.body.append(bakgrunn);
    }
    return bakgrunn;
  }
  function visDialog(innhold, fokusVelger) {
    const bakgrunn = lagDialog();
    const boks = document.getElementById('plan-dialog');
    if (!s.dialog) s.dialog = { fra: document.activeElement };
    boks.replaceChildren(...innhold);
    bakgrunn.hidden = false;
    const mal =
      (fokusVelger ? boks.querySelector(fokusVelger) : null) ?? boks.querySelector('button');
    mal?.focus();
  }
  function lukkDialog() {
    const bakgrunn = document.getElementById('plan-dialog-bakgrunn');
    if (bakgrunn) bakgrunn.hidden = true;
    const fra = s.dialog?.fra;
    s.dialog = null;
    if (fra?.isConnected) fra.focus();
    s.ctx?.tegnPaaNytt();
  }
  const apen = () => !!s.dialog;

  /** Planen som sendes til serveren (Nå tom og Neste ikke: første i Neste blir Nå). */
  function planForServer(p) {
    const rekkefolge = [...p.naa, ...p.neste];
    const serverPause = serverPlan().pause;
    return {
      rekkefolge,
      ...(rekkefolge.length ? { naa_antall: Math.max(p.naa.length, 1) } : {}),
      resten: p.resten,
      til: p.til || null,
      navn: p.navn || null,
      dra_med_avhengigheter: p.dra_med,
      pause: [...p.pause].filter((pid) => !serverPause.has(pid)),
      fortsett: [...serverPause].filter((pid) => !p.pause.has(pid)),
    };
  }

  async function forhandsvis() {
    const plan = planForServer(gjeldende());
    visDialog([
      el('h2', { id: 'plan-dialog-tittel', tekst: 'Lagre fokus' }),
      el('p', { class: 'masse-laster', tekst: 'Regner ut hva som endres …' }),
    ]);
    let svar;
    try {
      svar = await s.ctx.api('/api/fokus', { plan, torr: true });
    } catch (e) {
      return visDialog([
        el('h2', { id: 'plan-dialog-tittel', tekst: 'Lagre fokus' }),
        el('p', { class: 'masse-feil', tekst: e.message }),
        knapper([['Lukk', lukkDialog, 'knapp-kontur']]),
      ]);
    }
    const innhold = [
      el('h2', { id: 'plan-dialog-tittel', tekst: 'Lagre fokus' }),
      el('p', {
        class: 'masse-forklaring',
        tekst:
          'Fokuset bestemmer rekkefølgen køen starter arbeid i: alt i trinn 1 før trinn 2, uansett poeng. Se over ' +
          'hva som endres før du lagrer. Ingenting er lagret ennå.',
      }),
      el(
        'dl',
        { class: 'fakta' },
        el('dt', { tekst: 'Før' }),
        el('dd', { tekst: svar.for_tekst }),
        el('dt', { tekst: 'Etter' }),
        el('dd', { tekst: svar.etter_tekst }),
      ),
    ];
    if (svar.feil?.length)
      innhold.push(
        el(
          'ul',
          { class: 'vakt-liste masse-feil' },
          svar.feil.map((x) => el('li', { tekst: x })),
        ),
      );
    if (svar.linjer?.length)
      innhold.push(
        el(
          'ul',
          { class: 'plan-linjer' },
          svar.linjer.map((x) => el('li', { tekst: x })),
        ),
      );
    if (svar.advarsler?.length)
      innhold.push(
        el('h3', { class: 'innst-tittel', tekst: 'Advarsler' }),
        el(
          'ul',
          { class: 'vakt-liste' },
          svar.advarsler.map((x) => el('li', { tekst: x })),
        ),
      );
    if (svar.neste_tekst)
      innhold.push(
        el('h3', { class: 'innst-tittel', tekst: 'Neste opp etter lagring' }),
        el('p', { class: 'sp-meta', tekst: svar.neste_tekst }),
        svar.neste?.length
          ? el(
              'ul',
              { class: 'plan-linjer' },
              svar.neste.map((v) => el('li', null, el('code', { tekst: v.id }), ` ${v.tittel}`)),
            )
          : null,
      );
    innhold.push(
      knapper([
        ['Avbryt', lukkDialog, 'knapp-kontur'],
        svar.kan ? ['Lagre fokus', () => lagre(plan, svar.endret), 'knapp-fylt'] : null,
      ]),
    );
    visDialog(innhold, '.knapp-fylt');
  }

  async function lagre(plan, forvent) {
    try {
      const svar = await s.ctx.api('/api/fokus', { plan, forvent });
      s.utkast = null;
      s.grunnlag = null;
      lukkDialog();
      s.ctx.meldingMedInfo(svar.melding ?? 'Fokus lagret', svar);
      await s.ctx.oppdater(true);
    } catch (e) {
      if (e.svar?.utdatert) {
        s.ctx.melding('Køen er endret siden forhåndsvisningen. Her er den nye.', true);
        await s.ctx.oppdater(true);
        return forhandsvis();
      }
      s.ctx.melding(e.message, true);
    }
  }

  function knapper(liste) {
    return el(
      'div',
      { class: 'vakt-knapper' },
      liste
        .filter(Boolean)
        .map(([tekst, fn, klasse]) =>
          el('button', { type: 'button', class: `knapp ${klasse}`, tekst, onclick: fn }),
        ),
    );
  }

  // ---- Områder (POST /api/omrade): forklaring før lagring ----
  function aapneOmrader() {
    const d = data();
    const omrader = d.plan.omrader.filter((o) => o.i_register && o.oid !== 'uten-omrade');
    const nyId = el('input', {
      id: 'omrade-ny-id',
      type: 'text',
      maxlength: 40,
      placeholder: 'f.eks. eksport',
      autocomplete: 'off',
    });
    const nyTittel = el('input', {
      id: 'omrade-ny-tittel',
      type: 'text',
      maxlength: 200,
      placeholder: 'f.eks. Eksport',
      autocomplete: 'off',
    });
    const innhold = [
      el('h2', { id: 'plan-dialog-tittel', tekst: 'Områder' }),
      el('p', {
        class: 'masse-forklaring',
        tekst:
          'Et område (programdel) samler prosjektene som hører sammen, så du prioriterer noen få områder i stedet ' +
          'for mange prosjekter. Et prosjekt hører til ett område. Hver endring vises før den lagres.',
      }),
      el('h3', { class: 'innst-tittel', tekst: 'Områdene' }),
      omrader.length
        ? el(
            'ul',
            { class: 'plan-omrade-liste' },
            omrader.map((o) => {
              const tittel = el('input', {
                type: 'text',
                maxlength: 200,
                value: o.tittel ?? '',
                'aria-label': `Tittel på området ${o.oid}`,
              });
              return el(
                'li',
                { class: 'plan-omrade-rad' },
                el('code', { tekst: o.oid }),
                tittel,
                el('button', {
                  type: 'button',
                  class: 'knapp knapp-kontur knapp-liten',
                  tekst: 'Lagre tittel',
                  title: 'Gi området ny tittel. Du ser endringen før den lagres.',
                  onclick: () =>
                    omradeHandling({ handling: 'lagre', oid: o.oid, tittel: tittel.value.trim() }),
                }),
                el('button', {
                  type: 'button',
                  class: 'knapp knapp-kontur knapp-liten',
                  tekst: 'Slett',
                  disabled: o.prosjekter.length > 0,
                  title: o.prosjekter.length
                    ? `Flytt prosjektene ut først (${o.prosjekter.join(', ')}).`
                    : 'Slett området. Nektes når fokuset bruker det.',
                  onclick: () => omradeHandling({ handling: 'slett', oid: o.oid }),
                }),
              );
            }),
          )
        : el('p', { class: 'tom', tekst: 'Ingen områder ennå. Lag det første under.' }),
      el('h3', { class: 'innst-tittel', tekst: 'Nytt område' }),
      el(
        'div',
        { class: 'plan-omrade-ny' },
        el(
          'div',
          { class: 'felt' },
          el('label', { for: 'omrade-ny-id', tekst: 'Id (kort, små bokstaver og bindestrek)' }),
          nyId,
        ),
        el(
          'div',
          { class: 'felt' },
          el('label', { for: 'omrade-ny-tittel', tekst: 'Tittel' }),
          nyTittel,
        ),
        el('button', {
          type: 'button',
          class: 'knapp knapp-tonet knapp-liten',
          tekst: 'Lag område',
          title: 'Oppretter området. Du ser endringen før den lagres.',
          onclick: () =>
            omradeHandling({
              handling: 'lagre',
              oid: nyId.value.trim(),
              tittel: nyTittel.value.trim(),
            }),
        }),
      ),
      el('h3', { class: 'innst-tittel', tekst: 'Prosjektene' }),
      el(
        'ul',
        { class: 'plan-omrade-liste' },
        d.plan.prosjekter
          .filter((pr) => pr.flyttbar)
          .map((pr) =>
            el(
              'li',
              { class: 'plan-omrade-rad' },
              el('span', { class: 'plan-navn', tekst: pr.tittel ?? pr.pid }),
              el('code', { tekst: pr.pid }),
              el(
                'select',
                {
                  'aria-label': `Området til ${pr.pid}`,
                  title: 'Flytt prosjektet til et annet område. Du ser endringen før den lagres.',
                  onchange: (e) =>
                    omradeHandling({ handling: 'flytt', pid: pr.pid, oid: e.target.value || null }),
                },
                el('option', {
                  value: '',
                  tekst: 'Uten område',
                  selected: !omrader.some((o) => o.oid === pr.omrade),
                }),
                omrader.map((o) =>
                  el('option', {
                    value: o.oid,
                    tekst: o.tittel ?? o.oid,
                    selected: o.oid === pr.omrade,
                  }),
                ),
              ),
            ),
          ),
      ),
      knapper([['Lukk', lukkDialog, 'knapp-kontur']]),
    ];
    visDialog(innhold);
  }

  async function omradeHandling(b) {
    let svar;
    try {
      svar = await s.ctx.api('/api/omrade', { ...b, torr: true });
    } catch (e) {
      return s.ctx.melding(e.message, true);
    }
    if (!svar.kan) {
      s.ctx.melding(svar.feil.join('\n'), true);
      return aapneOmrader();
    }
    visDialog(
      [
        el('h2', { id: 'plan-dialog-tittel', tekst: 'Endre område' }),
        el(
          'ul',
          { class: 'plan-linjer' },
          svar.linjer.map((x) => el('li', { tekst: x })),
        ),
        knapper([
          ['Avbryt', aapneOmrader, 'knapp-kontur'],
          [
            'Lagre',
            async () => {
              try {
                const r = await s.ctx.api('/api/omrade', { ...b, forvent: svar.endret });
                s.ctx.melding(r.melding || 'Lagret');
                await s.ctx.oppdater(true);
              } catch (e) {
                s.ctx.melding(e.message, true);
                if (e.svar?.utdatert) await s.ctx.oppdater(true);
              }
              aapneOmrader();
            },
            'knapp-fylt',
          ],
        ]),
      ],
      '.knapp-fylt',
    );
  }

  window.KoPlan = {
    tegn,
    /** Skal tavla vente med å tegne om (noe dras eller er løftet, eller en dialog er åpen)? */
    opptatt: () => !!s.dra || !!s.loftet || apen(),
    /** Har planen et ulagret utkast (fokuslinja sier fra)? */
    harUtkast: harEndringer,
    aapneOmrader: (ctx) => {
      s.ctx = ctx;
      aapneOmrader();
    },
  };
})();
