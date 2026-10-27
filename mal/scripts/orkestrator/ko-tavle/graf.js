// =============================================================
// graf.js: visningen «Avhengigheter» på kanban-tavla. Vanilla JS, ingen byggesteg, ingen avhengigheter.
//
// Oppgavene er sirkler (areal etter anslaget, fyll i prosjektfargen, ringen viser status) og eierspørsmålene
// avrundede firkanter med «?». Strekene går fra forgjenger til etterfølger. Hvilke noder som vises og hvor de står,
// regnes av de rene funksjonene i scripts/lib/koGraf.js (servert som /koGraf.js, window.KoGraf) én gang per
// køendring, filter og valg (cache her), aldri per tegning: hjul og dra endrer bare én transform.
//
// tavle.js eier tilstanden, søket, filtermenyen, detaljpanelet og kjeden (t.kjede). Den kaller
//   window.KoGrafVisning.tegn(ctx)  når visningen tegnes, og
//   window.KoGrafVisning.merk(id, kjede)  når kjeden velges eller nullstilles (Esc).
// All tekst settes med textContent; fargene er CSS-variablene fra tema.css (lys og mørk).
// =============================================================
'use strict';

(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const LAGRING = 'ko-tavle-graf';
  const SP_TYPE = {
    sporsmal: 'Spørsmål',
    betingelse: 'Venter på betingelse',
    jurist: 'Venter på jurist',
    'eier-oppgave': 'Eier-oppgave',
  };
  const TILSTAND = {
    klar: 'klar nå',
    blokkert: 'blokkert',
    aktiv: 'pågår',
    qa: 'ferdig, venter på QA',
    ferdig: 'ferdig',
    samle: 'i samlekøen: startes ikke alene, pakkes til et spor',
  };

  // Valgene i visningen (lagres i nettleseren). Naboer er på som standard, resten av.
  const valg = lesValg();
  // Oppsettet for siste nøkkel (versjon + filter + valg), og hvor mange ganger det er regnet (for sjekken).
  let cache = { nokkel: null, oppsett: null, tall: null };
  let beregninger = 0;
  // Utsnittet: forskyvning og skala. null = tilpass ved neste tegning. Nullstilles når filter eller valg endres.
  let utsnitt = null;
  let utsnittFor = null;
  let svg = null;
  let lag = null;
  let flate = null;
  let ctx = null;

  function lesValg() {
    let v = null;
    try {
      v = JSON.parse(localStorage.getItem(LAGRING) ?? 'null');
    } catch {
      v = null;
    }
    return {
      modus: v?.modus === 'prosjekt' ? 'prosjekt' : 'samlet',
      frie: v?.frie === true,
      ferdige: v?.ferdige === true,
      naboer: v?.naboer !== false,
    };
  }
  function lagreValg() {
    try {
      localStorage.setItem(LAGRING, JSON.stringify(valg));
    } catch {
      /* privat modus: valgene gjelder bare denne økta */
    }
  }

  /** SVG-element med attributter og barn (null og false hoppes over, aldri til append). */
  function s(tag, attr, ...barn) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attr ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'tekst') e.textContent = v;
      else if (k.startsWith('--')) e.style.setProperty(k, v);
      else e.setAttribute(k, String(v));
    }
    for (const b of barn.flat()) if (b != null && b !== false) e.append(b);
    return e;
  }

  const flertall = (n, en, flere) => `${n} ${n === 1 ? en : flere}`;

  /**
   * Omtrentlig størrelse på visningsflaten før den er tegnet: pakkingen i koGraf velger radbredden etter
   * den. Hovedflatens bredde, og høyden under toppen av visningen (ca. 110 px til oppsummering og valg). Avrundet til
   * 100 px, så små endringer ikke gir nytt oppsett. 0 (jsdom) gir standarden i koGraf (1600 × 800).
   */
  function flateMaal() {
    const r = ctx.main.getBoundingClientRect?.() ?? { top: 0 };
    const b = ctx.main.clientWidth || 0;
    const h = b ? Math.max(300, (window.innerHeight || 0) - r.top - 110) : 0;
    return { bredde: Math.round(b / 100) * 100, hoyde: Math.round(h / 100) * 100 };
  }

  /** Oppsettet for tilstanden og filteret nå: fra cachen når ingenting er endret. */
  function oppsett() {
    const maal = flateMaal();
    const nokkel = [
      ctx.versjon,
      ctx.filterNokkel,
      valg.modus,
      valg.frie,
      valg.ferdige,
      valg.naboer,
      `${maal.bredde}x${maal.hoyde}`,
    ].join('|');
    if (cache.nokkel !== nokkel) {
      const KG = window.KoGraf;
      const graf = KG.byggGraf(ctx.data, {
        synlig: ctx.synlig,
        visFerdige: valg.ferdige,
        visFrittstaende: valg.frie,
        naboer: valg.naboer,
      });
      cache = {
        nokkel,
        oppsett: KG.lagdel(graf, { modus: valg.modus, flate: maal }),
        tall: KG.grafTall(graf),
      };
      beregninger++;
    }
    // Nytt filter eller nye valg: vis alt på nytt. En ny versjon av køen (samme filter) beholder utsnittet.
    const hva = nokkel.slice(nokkel.indexOf('|') + 1);
    if (utsnittFor !== hva) {
      utsnittFor = hva;
      utsnitt = null;
    }
    return cache;
  }

  // ---- Toppen av visningen: oppsummering, tegnforklaring og valg ----
  function oppsummering(tall, o) {
    const el = ctx.el;
    const deler = [
      flertall(tall.oppgaver, 'oppgave i kjeder', 'oppgaver i kjeder'),
      `${flertall(tall.sporsmal, 'eierspørsmål', 'eierspørsmål')} blokkerer ${flertall(tall.blokkertAvSporsmal, 'oppgave', 'oppgaver')}`,
      `lengste kjede ${flertall(tall.lengsteKjede, 'ledd', 'ledd')}`,
    ];
    return el(
      'p',
      { class: 'graf-tall' },
      deler.join(' · '),
      o.sykler.length
        ? el('span', {
            class: 'merke gammel',
            tekst: flertall(o.sykler.length, 'sykel', 'sykler'),
            title:
              'Avhengigheter i ring (tegnet, men brutt i oppsettet):\n' +
              o.sykler.map((k) => `${k.fra} → ${k.til}`).join('\n'),
          })
        : null,
    );
  }

  function tegnforklaring() {
    const el = ctx.el;
    const del = (klasse, tekst) =>
      el('li', null, el('span', { class: `tegn ${klasse}`, 'aria-hidden': 'true' }), tekst);
    return el(
      'ul',
      { class: 'graf-tegn', 'aria-label': 'Tegnforklaring' },
      del('t-klar', 'klar nå'),
      del('t-blokkert', 'blokkert'),
      del('t-aktiv', 'pågår'),
      // Samlekøen har eget merke (prikket ring og «S»).
      del('t-samle', 'i samlekøen (pakkes til et spor)'),
      del('t-sp', 'eierspørsmål'),
    );
  }

  function valgRad() {
    const el = ctx.el;
    const bryter = (nokkel, tekst) =>
      el(
        'label',
        { class: 'graf-bryter' },
        el('input', {
          type: 'checkbox',
          checked: valg[nokkel],
          onchange: (e) => {
            valg[nokkel] = e.target.checked;
            lagreValg();
            ctx.tegnPaaNytt();
          },
        }),
        tekst,
      );
    const modusKnapp = (m, tekst) =>
      el('button', {
        type: 'button',
        class: 'veksler-knapp',
        'aria-pressed': valg.modus === m ? 'true' : 'false',
        tekst,
        onclick: () => {
          if (valg.modus === m) return;
          valg.modus = m;
          lagreValg();
          ctx.tegnPaaNytt();
        },
      });
    return el(
      'div',
      { class: 'graf-valg' },
      el(
        'div',
        { class: 'veksler', role: 'group', 'aria-label': 'Oppsett' },
        modusKnapp('samlet', 'Samlet'),
        modusKnapp('prosjekt', 'Per prosjekt'),
      ),
      bryter('frie', 'Vis frittstående'),
      bryter('ferdige', 'Vis ferdige'),
      bryter('naboer', 'Vis naboer'),
      el('button', {
        type: 'button',
        class: 'knapp knapp-kontur',
        tekst: 'Tilpass',
        title: 'Vis hele grafen',
        onclick: () => tilpass(),
      }),
    );
  }

  // ---- Selve grafen ----
  /** Kurvet sti med pilhode fra kanten av forgjengeren til kanten av etterfølgeren. */
  function sti(a, b) {
    const x1 = a.x + a.r;
    const x2 = b.x - b.r - 4;
    const midt = x1 + Math.max(30, (x2 - x1) / 2);
    const tilbake = x2 - x1 < 30 ? x2 - Math.max(30, (x2 - x1) / 2) : midt;
    return `M${x1} ${a.y}C${midt} ${a.y} ${tilbake} ${b.y} ${x2} ${b.y}`;
  }

  function nodeTittel(n) {
    if (n.art === 'sporsmal')
      return [
        `${n.sp} (${SP_TYPE[n.type] ?? SP_TYPE.sporsmal})`,
        n.tekst,
        `Låser opp ${flertall(n.laaser, 'oppgave', 'oppgaver')}`,
      ]
        .filter(Boolean)
        .join('\n');
    return [
      `${n.id}: ${n.tittel}`,
      `${TILSTAND[n.tilstand] ?? n.status}${n.rolle === 'nabo' ? ' (skjult av filteret)' : ''}`,
      n.laaser ? `Låser opp ${flertall(n.laaser, 'oppgave', 'oppgaver')}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  function nodeEl(n) {
    const felles = {
      'data-id': n.id,
      tabindex: 0,
      role: 'button',
      'aria-label': nodeTittel(n).replace(/\n/g, '. '),
      transform: `translate(${n.x} ${n.y})`,
    };
    if (n.art === 'sporsmal') {
      const h = n.r;
      return s(
        'g',
        { ...felles, class: `node sp sp-${n.type}`, 'data-sp': n.sp },
        s('title', { tekst: nodeTittel(n) }),
        s('rect', { class: 'sp-boks', x: -h, y: -h, width: 2 * h, height: 2 * h, rx: 6 }),
        s('text', { class: 'sp-merke', y: 5, tekst: '?' }),
        n.laaser
          ? s('text', { class: 'graf-laaser', y: h + 13, tekst: `låser opp ${n.laaser}` })
          : null,
        s('text', { class: 'etikett', y: -h - 6, tekst: n.sp }),
      );
    }
    const klasser = ['node', 'oppgave', `t-${n.tilstand}`, `rolle-${n.rolle}`];
    if (n.r >= 16) klasser.push('stor');
    return s(
      'g',
      { ...felles, class: klasser.join(' ') },
      s('title', { tekst: nodeTittel(n) }),
      s('circle', {
        class: 'fyll',
        r: n.r,
        '--p': n.farge && n.rolle !== 'nabo' ? `var(--color-${n.farge})` : null,
      }),
      n.rolle === 'kjerne' || n.rolle === 'fri' ? s('circle', { class: 'ring', r: n.r + 3 }) : null,
      n.tilstand === 'qa'
        ? s('circle', { class: 'qa-prikk', cx: n.r + 3, cy: -n.r - 1, r: 3 })
        : null,
      // Samlekøen får et lite «S»-merke øverst til høyre.
      n.tilstand === 'samle'
        ? s(
            'g',
            { class: 'samle-merke', transform: `translate(${n.r + 2} ${-n.r - 2})` },
            s('circle', { r: 6.5 }),
            s('text', { y: 3.5, tekst: 'S' }),
          )
        : null,
      s('text', { class: 'etikett', y: n.r + 13, tekst: n.id }),
    );
  }

  function tegnSvg(o) {
    const el = ctx.el;
    const perId = new Map(o.noder.map((n) => [n.id, n]));
    lag = s('g', { class: 'graf-lag' });
    for (const b of o.baner)
      lag.append(
        s(
          'g',
          { class: 'graf-bane', '--p': b.farge ? `var(--color-${b.farge})` : null },
          s('rect', { x: 0, y: b.y, width: o.bredde, height: b.hoyde, rx: 8 }),
          s('text', { x: 12, y: b.y + 20, tekst: b.tittel }),
        ),
      );
    // Hver kjede (komponent) får en diskret bakgrunn, så pakkingen i rader leses som separate grupper.
    for (const k of o.komponenter ?? [])
      lag.append(
        s('rect', {
          class: 'graf-komp',
          x: k.x,
          y: k.y,
          width: k.bredde,
          height: k.hoyde,
          rx: 10,
        }),
      );
    if (o.fri)
      lag.append(
        s('text', {
          class: 'graf-fri-tittel',
          x: 12,
          y: o.fri.y + 20,
          tekst: `Frittstående (${o.fri.antall})`,
        }),
      );
    const kanter = s('g', { class: 'kanter' });
    for (const k of o.kanter) {
      const a = perId.get(k.fra);
      const b = perId.get(k.til);
      kanter.append(
        s('path', {
          class: `kant ${k.art}${k.dempet ? ' dempet' : ''}${k.sykel ? ' sykel' : ''}`,
          d: sti(a, b),
          'data-fra': k.fra,
          'data-til': k.til,
          'marker-end': 'url(#graf-pil)',
        }),
      );
    }
    const noder = s('g', { class: 'noder' }, o.noder.map(nodeEl));
    lag.append(kanter, noder);
    svg = s(
      'svg',
      { class: 'graf-svg', role: 'group', 'aria-label': 'Avhengighetene som graf' },
      s(
        'defs',
        null,
        s(
          'marker',
          {
            id: 'graf-pil',
            viewBox: '0 0 10 10',
            refX: 1,
            refY: 5,
            markerWidth: 7,
            markerHeight: 7,
            orient: 'auto-start-reverse',
          },
          s('path', { class: 'pil', d: 'M0 0L10 5L0 10z' }),
        ),
      ),
      lag,
    );
    flate = el('div', { class: 'graf-flate' }, svg);
    kobleSamspill();
    return flate;
  }

  // ---- Zoom og panorering: bare transformen endres ----
  function bruk() {
    if (!lag || !utsnitt) return;
    lag.setAttribute('transform', `translate(${utsnitt.x} ${utsnitt.y}) scale(${utsnitt.s})`);
    svg.classList.toggle('zoom-middels', utsnitt.s >= 0.8);
    svg.classList.toggle('zoom-naer', utsnitt.s >= 1.4);
  }
  function tilpass() {
    const o = cache.oppsett;
    if (!flate || !o) return;
    const b = flate.clientWidth || 0;
    const h = flate.clientHeight || 0;
    let sk =
      b && h && o.bredde && o.hoyde ? Math.min(b / (o.bredde + 20), h / (o.hoyde + 20), 1.5) : 1;
    // Blir sirklene uleselige med hele bildet synlig: fyll bredden, start øverst og rull loddrett.
    if (b && o.bredde && sk < (o.lesbarSkala ?? 0)) sk = Math.min(b / (o.bredde + 20), 1.5);
    utsnitt = {
      s: sk,
      x: b ? (b - o.bredde * sk) / 2 : 0,
      y: h ? Math.max(0, (h - o.hoyde * sk) / 2) : 0,
    };
    bruk();
  }

  let flyttet = false;
  function kobleSamspill() {
    flate.addEventListener(
      'wheel',
      (e) => {
        if (!utsnitt) return;
        e.preventDefault();
        const r = flate.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        const ny = Math.min(4, Math.max(0.05, utsnitt.s * Math.exp(-e.deltaY * 0.0015)));
        utsnitt = {
          s: ny,
          x: mx - ((mx - utsnitt.x) * ny) / utsnitt.s,
          y: my - ((my - utsnitt.y) * ny) / utsnitt.s,
        };
        bruk();
      },
      { passive: false },
    );
    let start = null;
    flate.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !utsnitt) return;
      start = { x: e.clientX, y: e.clientY, ux: utsnitt.x, uy: utsnitt.y, id: e.pointerId };
      flyttet = false;
    });
    flate.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!flyttet && Math.hypot(dx, dy) < 4) return;
      if (!flyttet) {
        flyttet = true;
        flate.setPointerCapture?.(e.pointerId);
        flate.classList.add('drar');
      }
      utsnitt = { ...utsnitt, x: start.ux + dx, y: start.uy + dy };
      bruk();
    });
    const slutt = () => {
      start = null;
      flate.classList.remove('drar');
    };
    flate.addEventListener('pointerup', slutt);
    flate.addEventListener('pointercancel', slutt);

    // Klikk (ikke etter en dragning) og Enter: en oppgave åpner panelet og velger kjeden; et spørsmål åpner
    // «Venter på deg», der det besvares.
    const aapne = (g) => {
      if (g.dataset.sp) ctx.aapneInnboks();
      else ctx.aapnePanel(g.dataset.id);
    };
    flate.addEventListener('click', (e) => {
      if (flyttet) {
        flyttet = false;
        return;
      }
      const g = e.target.closest?.('.node');
      if (g) aapne(g);
    });
    flate.addEventListener('keydown', (e) => {
      const g = e.target.closest?.('.node');
      if (g && e.key === 'Enter') {
        e.preventDefault();
        aapne(g);
      }
    });
  }

  /** Kjeden fra tavla (koTavle sin kjede): valgt, før og etter utheves; spørsmål som holder dem igjen også. */
  function merk(id, kjede) {
    if (!svg?.isConnected) return;
    const forSett = new Set(kjede?.for ?? []);
    const etterSett = new Set(kjede?.etter ?? []);
    const iKjede = (x) => x === id || forSett.has(x) || etterSett.has(x);
    const aktiv = !!id && !!kjede;
    svg.classList.toggle('kjede-aktiv', aktiv);
    const spMed = new Set();
    for (const p of lag.querySelectorAll('.kant')) {
      const fra = p.dataset.fra;
      const til = p.dataset.til;
      const med = aktiv && iKjede(til) && (iKjede(fra) || p.classList.contains('sp'));
      if (med && p.classList.contains('sp')) spMed.add(fra);
      p.classList.toggle('i-kjede', med);
    }
    for (const g of lag.querySelectorAll('.node')) {
      const x = g.dataset.id;
      g.classList.toggle('valgt', aktiv && x === id);
      g.classList.toggle('for', aktiv && forSett.has(x));
      g.classList.toggle('etter', aktiv && etterSett.has(x));
      g.classList.toggle('i-kjede', aktiv && spMed.has(x));
    }
  }

  /** Tegner visningen i `ctx.main` (tavle.js har tømt den). */
  function tegn(c) {
    ctx = c;
    const el = c.el;
    const { oppsett: o, tall } = oppsett();
    const fokus = document.activeElement?.closest?.('.graf-svg .node')?.dataset.id ?? null;
    const topp = el(
      'div',
      { class: 'graf-topp' },
      oppsummering(tall, o),
      tegnforklaring(),
      valgRad(),
    );
    if (!o.noder.length) {
      svg = null;
      lag = null;
      flate = null;
      c.main.append(
        topp,
        // Den felles tomtilstanden fra tavle.js (grunnen og handlingen).
        window.KoTom
          ? window.KoTom('Ingen avhengigheter her.')
          : el('p', { class: 'tom', tekst: 'Ingen avhengigheter med disse filtrene.' }),
      );
      return;
    }
    c.main.append(topp, tegnSvg(o));
    if (utsnitt) bruk();
    else tilpass();
    if (fokus)
      lag.querySelector(`.node[data-id="${CSS.escape(fokus)}"]`)?.focus({ preventScroll: true });
  }

  window.KoGrafVisning = {
    tegn,
    merk,
    get beregninger() {
      return beregninger;
    },
  };
})();
