// =============================================================
// struktur.js: trekartet og avhengighetene i Planer-rommet (se docs/board.md).
// Vanilla JS, ingen byggesteg, ingen CDN. All tekst settes med textContent (via el og s), aldri som HTML.
//
// Begge visningene står i midten av de tre rutene (`vis=trekart` og `vis=avh` i nettadressen), med de samme
// filtrene og det samme utvalget som listen, og detaljpanelet viser posten du velger. De skriver ingenting.
//
// Trekartet svarer på hvor mengden ligger og hvor mye som er bygget. Nivåene er modul › prosjekt › post: arealet er
// estimatet, fargen prioriteten (med symbol og tekst i feltet) og fyllet nedenfra hvor mye som er bygget.
// Zoomen er filteret: et klikk på en modul eller et prosjekt setter filteret ett nivå ned, og brødsmulestien (som
// bygges fra filteret) zoomer ut igjen. Et klikk på en post åpner den i panelet.
//
// Avhengighetene svarer på hva som må komme først. De viser bare utvalget (filtrene og søket) eller valgt post med
// naboene (`avh=post`), aldri hele registeret. Oppsettet er lagdelt fra venstre mot høyre (koGraf.lagdel, samme
// som køens avhengighetsvisning), blokkerte poster har stiplet ring og den kritiske veien (koGraf.kritiskVei) er
// uthevet og står også som tekst over grafen.
//
// Reglene (nivåene, feltene, squarified-rutene, grafen, blokkert og kritisk vei) er de rene funksjonene i
// scripts/lib/koPlanVisning.js og scripts/lib/koGraf.js (testet i jest). Her er bare visningen og samspillet.
// =============================================================
'use strict';

(function () {
  const V = window.KoPlanVisning;
  const NS = 'http://www.w3.org/2000/svg';
  // Flaten avhengighetsoppsettet pakkes for (koGraf.lagdel velger radbredden etter den).
  const AVH_FLATE = { bredde: 1100, hoyde: 700 };

  /** SVG-element med attributter og barn (null og false hoppes over). Tekst bare via textContent. */
  function s(tag, attr, ...barn) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attr ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'tekst') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, String(v));
    }
    for (const b of barn.flat()) if (b != null && b !== false) e.append(b);
    return e;
  }

  const prosent = (x, av) => `${Math.round((x / av) * 10000) / 100}%`;

  /** Forklaringen: prioriteten med symbol og tekst (fargen er bare et tillegg), og hva arealet og fyllet betyr. */
  function forklaring(h, ekstra) {
    const el = h.el;
    return el(
      'ul',
      { class: 'struktur-forklaring', 'aria-label': 'Forklaring' },
      ...V.PRIORITETER.map((p) =>
        el(
          'li',
          { class: `struktur-forklaring-pri pri-${p}` },
          el('span', { class: 'struktur-prove', 'aria-hidden': 'true' }),
          `${V.PRIORITET[p].symbol} ${V.PRIORITET[p].tekst}`,
        ),
      ),
      ...ekstra.map((t) => el('li', { tekst: t })),
    );
  }

  // ---- Trekartet ----
  /**
   * Midten for `vis=trekart`. `treff` er de filtrerte postene (samme utvalg som listen), `valgt` posten i panelet.
   */
  function trekart(h, d, treff, valgt) {
    const el = h.el;
    const t = h.tilstand();
    const tk = V.trekartFelter(treff, d, t.filter);
    const flate = V.TREKART_FLATE;
    const ruter = V.trekartRuter(tk.felter, flate);
    const perId = new Map(tk.felter.map((f) => [f.id, f]));
    const nivaTekst = { modul: 'modulene', prosjekt: 'prosjektene', post: 'postene' }[tk.niva];

    let innhold;
    if (!d.finnes)
      innhold = el('p', {
        class: 'tom',
        tekst: 'Planregisteret finnes ikke ennå (scripts/.ko/planer.json).',
      });
    else if (!ruter.length)
      innhold = el(
        'div',
        { class: 'tom tom-tilstand' },
        el('p', { tekst: 'Ingen poster passer filtrene og søket.' }),
      );
    else
      innhold = el(
        'div',
        {
          class: `trekart niva-${tk.niva}`,
          role: 'group',
          'aria-label': `Trekartet: ${nivaTekst}, areal etter estimat`,
        },
        ...ruter.map((r) => feltEl(h, perId.get(r.id), r, flate, valgt)),
      );

    return el(
      'section',
      { class: 'planer-midt struktur-midt', 'aria-label': 'Trekartet', 'data-rull': 'trekart' },
      h.aktiveFiltre(d),
      el('p', {
        class: 'kart-hjelp',
        tekst:
          `Viser ${nivaTekst} (${tk.felter.length}), til sammen ca. ${V.sporTekst(tk.sum)}` +
          (tk.utenEstimat ? `, ${tk.utenEstimat} uten estimat (teller som 1 spor)` : '') +
          '. Klikk zoomer inn ett nivå, brødsmulestien zoomer ut.',
      }),
      forklaring(h, ['Areal: estimatet', 'Fyll nedenfra: hvor mye som er bygget']),
      innhold,
    );
  }

  function feltEl(h, felt, r, flate, valgt) {
    const el = h.el;
    const tekst = V.trekartTekst(felt);
    const liten = V.trekartLiten(r);
    const erValgt = felt.niva === 'post' && valgt?.id === felt.post;
    return el(
      'button',
      {
        type: 'button',
        class: `trekart-felt pri-${felt.prioritet}${liten ? ' liten' : ''}${erValgt ? ' valgt' : ''}${felt.bygget > 0 ? '' : ' ubygget'}`,
        '--x': prosent(r.x, flate.bredde),
        '--y': prosent(r.y, flate.hoyde),
        '--b': prosent(r.bredde, flate.bredde),
        '--h': prosent(r.hoyde, flate.hoyde),
        '--fyll': `${Math.round(felt.bygget * 100)}%`,
        'aria-label': tekst.etikett,
        'aria-current': erValgt ? 'true' : null,
        title: [tekst.navn, ...tekst.linjer].join('\n'),
        'data-fokus': `trekart:${felt.niva}:${felt.id}`,
        onclick: () => {
          if (felt.niva === 'post') h.velgPost(felt.post);
          else h.zoom(felt.zoom);
        },
      },
      el('span', { class: 'trekart-fyll', 'aria-hidden': 'true' }),
      el(
        'span',
        { class: 'trekart-innhold', 'aria-hidden': 'true' },
        el('span', { class: 'trekart-navn', tekst: felt.niva === 'post' ? felt.id : felt.tittel }),
        liten
          ? null
          : [
              felt.niva === 'post'
                ? el('span', { class: 'trekart-linje trekart-tittel', tekst: felt.tittel })
                : null,
              ...tekst.linjer.map((l) => el('span', { class: 'trekart-linje', tekst: l })),
            ],
      ),
    );
  }

  // ---- Avhengighetene ----
  /** Kurven fra forgjengeren til etterfølgeren (som køens avhengighetsvisning). */
  function sti(a, b) {
    const x1 = a.x + a.r;
    const x2 = b.x - b.r - 4;
    const midt = x1 + Math.max(30, (x2 - x1) / 2);
    const tilbake = x2 - x1 < 30 ? x2 - Math.max(30, (x2 - x1) / 2) : midt;
    return `M${x1} ${a.y}C${midt} ${a.y} ${tilbake} ${b.y} ${x2} ${b.y}`;
  }

  function nodeEl(h, n) {
    const linjer = V.planNodeTekst(n);
    const klasser = [
      'avh-node',
      `pri-${n.prioritet}`,
      `rolle-${n.rolle}`,
      n.blokkert ? 'blokkert' : null,
      n.kritisk ? 'kritisk' : null,
      n.valgt ? 'valgt' : null,
      n.aapen ? null : 'ferdig',
    ].filter(Boolean);
    const velg = () => h.velgPost(n.id);
    return s(
      'g',
      {
        class: klasser.join(' '),
        transform: `translate(${n.x} ${n.y})`,
        tabindex: 0,
        role: 'button',
        'aria-label': linjer.join('. '),
        'aria-current': n.valgt ? 'true' : null,
        'data-fokus': `avh:${n.id}`,
        onclick: velg,
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            velg();
          }
        },
      },
      s('title', { tekst: linjer.join('\n') }),
      s('circle', { class: 'avh-fyll', r: n.r }),
      // Blokkert: stiplet ring utenpå (i tillegg til teksten i etiketten).
      n.blokkert ? s('circle', { class: 'avh-ring', r: n.r + 4 }) : null,
      n.rolle === 'nabo'
        ? null
        : s('text', {
            class: 'avh-symbol',
            y: 4,
            tekst: V.PRIORITET[n.prioritet]?.symbol ?? '',
          }),
      s('text', { class: 'avh-etikett', y: n.r + 14, tekst: n.id }),
    );
  }

  function grafSvg(h, o) {
    const perId = new Map(o.noder.map((n) => [n.id, n]));
    const kanter = s(
      'g',
      { class: 'avh-kanter' },
      // Den kritiske veien tegnes sist, så den ligger øverst.
      [...o.kanter]
        .sort((a, b) => Number(!!a.kritisk) - Number(!!b.kritisk))
        .map((k) =>
          s('path', {
            class: `avh-kant${k.kritisk ? ' kritisk' : ''}${k.dempet ? ' dempet' : ''}${k.sykel ? ' sykel' : ''}`,
            d: sti(perId.get(k.fra), perId.get(k.til)),
            'marker-end': k.kritisk ? 'url(#avh-pil-kritisk)' : 'url(#avh-pil)',
          }),
        ),
    );
    const pil = (id, klasse) =>
      s(
        'marker',
        {
          id,
          viewBox: '0 0 10 10',
          refX: 1,
          refY: 5,
          markerWidth: 7,
          markerHeight: 7,
          orient: 'auto-start-reverse',
        },
        s('path', { class: klasse, d: 'M0 0L10 5L0 10z' }),
      );
    const bredde = Math.max(200, Math.ceil(o.bredde));
    const hoyde = Math.max(120, Math.ceil(o.hoyde));
    return s(
      'svg',
      {
        class: 'avh-svg',
        role: 'group',
        'aria-label': 'Avhengighetene mellom postene, fra venstre mot høyre',
        width: bredde,
        height: hoyde,
        viewBox: `0 0 ${bredde} ${hoyde}`,
      },
      s('defs', null, pil('avh-pil', 'avh-pil'), pil('avh-pil-kritisk', 'avh-pil kritisk')),
      kanter,
      s(
        'g',
        { class: 'avh-noder' },
        o.noder.map((n) => nodeEl(h, n)),
      ),
    );
  }

  /**
   * Midten for `vis=avh`. Utvalget er `treff` (filtrene og søket); uten filter og søk er utvalget hele registeret,
   * og da tegnes ingenting. `valgt` er posten i panelet (modus «Valgt post med naboer»).
   */
  function avh(h, d, treff, valgt) {
    const el = h.el;
    const t = h.tilstand();
    const modus = t.avh === 'post' ? 'post' : 'utvalg';
    const g = V.planGraf(d.poster, {
      modus,
      utvalg: treff.map((p) => p.id),
      valgt: valgt?.id ?? null,
      heleRegisteret: !h.utvalgt(),
      graf: window.KoGraf,
    });
    const veksler = el(
      'div',
      { class: 'veksler avh-modus', role: 'group', 'aria-label': 'Hva grafen viser' },
      ...[
        ['utvalg', 'Utvalget'],
        ['post', 'Valgt post med naboer'],
      ].map(([id, tekst]) =>
        el('button', {
          type: 'button',
          class: 'veksler-knapp',
          tekst,
          'aria-pressed': modus === id ? 'true' : 'false',
          'data-fokus': `avh-modus:${id}`,
          onclick: () => {
            if (modus !== id) h.settAvh(id);
          },
        }),
      ),
    );
    let innhold;
    if (!d.finnes)
      innhold = el('p', {
        class: 'tom',
        tekst: 'Planregisteret finnes ikke ennå (scripts/.ko/planer.json).',
      });
    else if (g.grunn)
      innhold = el('div', { class: 'tom tom-tilstand' }, el('p', { tekst: V.planGrafTekst(g) }));
    else {
      const o = window.KoGraf.lagdel(g, { modus: 'samlet', flate: AVH_FLATE });
      const vei = V.kritiskVeiTekst(g);
      innhold = el(
        'div',
        {},
        el('p', { class: 'avh-oppsummering', tekst: V.planGrafTekst(g) }),
        vei ? el('p', { class: 'avh-kritisk-tekst', tekst: vei }) : null,
        o.sykler.length
          ? el('p', {
              class: 'kart-merknad',
              tekst: `Sirkulær avhengighet: ${o.sykler.map((x) => `${x.fra} → ${x.til}`).join(', ')} (stiplet kant).`,
            })
          : null,
        el('div', { class: 'avh-flate', 'data-rull': 'avh' }, grafSvg(h, o)),
      );
    }
    return el(
      'section',
      { class: 'planer-midt struktur-midt', 'aria-label': 'Avhengighetene' },
      h.aktiveFiltre(d),
      el(
        'div',
        { class: 'avh-hode' },
        veksler,
        el('p', {
          class: 'kart-hjelp',
          tekst: 'Det som må komme først, står til venstre. Klikk en post for å åpne den.',
        }),
      ),
      forklaring(h, [
        'Stiplet ring: blokkert',
        'Tykk strek: kritisk vei',
        'Liten prikk: utenfor utvalget',
        'Størrelse: estimatet',
      ]),
      innhold,
    );
  }

  window.KoPlanStruktur = { trekart, avh };
})();
