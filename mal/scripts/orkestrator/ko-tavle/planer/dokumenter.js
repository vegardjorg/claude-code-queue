// =============================================================
// dokumenter.js: flaten «Dokumenter og avtaler» i Planer-rommet (se docs/plan-register.md).
// Vanilla JS, ingen byggesteg, ingen CDN.
//
// Samme tre-rute-mønster som planpostene: fasetter med antall (gruppe, status, målgruppe, prioritet og
// problemer) til venstre, «Hva må gjøres», tidslinjen for revisjoner og én tabell per gruppe i midten, og
// detaljpanelet til høyre. Reglene (filtrene, fasett-tallene, gruppene, tidslinjen, stien og kopier-linja) er de rene
// funksjonene i scripts/lib/koPlanVisning.js (window.KoPlanVisning, testet i jest); dataene kommer fra /api/planer.
//
// Flaten skriver ingenting: dokumentregisteret endres med `ko.mjs plan dok …` (samme lås, endringslogg og angre som
// planpostene). Kopier-linja på hver rad (`/planer dok DOK-X. Instruks:`) tar arbeidet videre i Claude Code.
// All tekst settes med textContent (aldri innerHTML). Farge er aldri eneste bærer: status, prioritet og varsler har
// symbol og tekst.
//
// planer.js eier rommet, nettadressen og tegningen og kaller window.KoPlanDok.ruter(h, data), der `h` er
// hjelperne derfra (el, kopier, brukTilstand, …).
// =============================================================
'use strict';

(function () {
  const V = window.KoPlanVisning;

  /** Datoen YYYY-MM-DD som «15. okt. 2026». */
  function kortDato(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return s ?? '';
    return new Date(`${s}T12:00:00Z`).toLocaleDateString('nb-NO', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  /** «om 12 dager», «i dag», «forfalt for 3 dager siden». */
  function dagerTekst(n) {
    if (n === 0) return 'i dag';
    if (n > 0) return `om ${n} ${n === 1 ? 'dag' : 'dager'}`;
    return `forfalt for ${-n} ${n === -1 ? 'dag' : 'dager'} siden`;
  }

  function nesteTekst(nr) {
    if (!nr) return '';
    if (nr.hendelse) return nr.hendelse;
    return `${kortDato(nr.dato)} (${dagerTekst(nr.dager)})`;
  }

  // ---- Hovedinngangen ----
  /**
   * De tre rutene for dokumentflaten.
   * @param {object} h hjelperne fra planer.js
   * @param {object} d dataene fra /api/planer
   */
  function ruter(h, d) {
    const t = h.tilstand();
    const alle = d.dokumenter ?? [];
    const treff = V.dokFiltrer(alle, t.dfilter, t.dsok);
    const valgt = t.dok ? (alle.find((x) => x.id === t.dok) ?? null) : null;
    return h.el(
      'div',
      { class: 'planer-ruter dok-ruter' },
      filtreEl(h, alle, treff),
      midtEl(h, d, treff, valgt),
      detaljEl(h, d, valgt),
    );
  }

  // ---- Små byggeklosser ----
  function statusEl(h, status) {
    const v = V.DOK_STATUS[status] ?? { tekst: status ?? 'ukjent', symbol: '·' };
    return h.el(
      'span',
      { class: `dok-status st-${status ?? 'ukjent'}` },
      h.el('span', { class: 'dok-status-symbol', 'aria-hidden': 'true', tekst: v.symbol }),
      h.el('span', { tekst: v.tekst }),
    );
  }

  function velgDok(h, id, opts = {}) {
    h.bruk({ flate: 'dok', dok: id }, { push: true, ...opts });
  }

  function dokKnapp(h, id, tekst, fokus) {
    return h.el('button', {
      type: 'button',
      class: 'lenke-knapp',
      tekst,
      'data-fokus': fokus ?? null,
      onclick: () => velgDok(h, id, { rull: true }),
    });
  }

  // ---- Venstre: søk, snarveier og fasetter ----
  let sokTid = null;
  const SNARVEIER = [
    { navn: 'Har problemer', sok: '?dvars=problem-hoy,problem,glipp,forfalt' },
    { navn: 'Til jurist', sok: '?dst=til-jurist' },
    { navn: 'Mangler', sok: '?dst=mangler' },
    { navn: 'Før prod', sok: '?dpri=naa' },
  ];

  function filtreEl(h, alle, treff) {
    const t = h.tilstand();
    const fasetter = V.dokFasettTall(alle, t.dfilter, t.dsok);
    const naaSok = JSON.stringify(t.dfilter);
    return h.el(
      'aside',
      {
        id: 'planer-filtre',
        class: 'planer-filtre',
        'aria-label': 'Filtre for dokumentene',
        'data-rull': 'dfiltre',
      },
      h.el(
        'label',
        { class: 'planer-sok-etikett' },
        h.el('span', { class: 'skjult-for-oyet', tekst: 'Søk i dokumentene' }),
        h.el('input', {
          type: 'search',
          class: 'sok planer-sok',
          placeholder: 'Søk i id, tittel, kilde, problemer',
          autocomplete: 'off',
          value: t.dsok,
          'data-fokus': 'dsok',
          oninput: (e) => {
            clearTimeout(sokTid);
            const v = e.target.value.slice(0, 120);
            sokTid = setTimeout(() => h.bruk({ dsok: v.trim() }, { push: false }), 200);
          },
        }),
      ),
      h.el(
        'section',
        { class: 'planer-visninger', 'aria-label': 'Snarveier' },
        h.el('h2', { class: 'planer-rute-tittel', tekst: 'Snarveier' }),
        h.el(
          'ul',
          { class: 'planer-visning-liste' },
          ...SNARVEIER.map((v) => {
            const f = V.lesUrl(v.sok).dfilter;
            return h.el(
              'li',
              { class: 'planer-visning' },
              h.el('button', {
                type: 'button',
                class: 'lenke-knapp',
                tekst: v.navn,
                'aria-pressed': JSON.stringify(f) === naaSok ? 'true' : 'false',
                'data-fokus': `dvis:${v.navn}`,
                onclick: () => h.nyttDokFilter(f, { dsok: '', dok: null }),
              }),
            );
          }),
        ),
      ),
      ...fasetter
        .filter((f) => f.valg.length)
        .map((f) => {
          const nokkel = `d-${f.id}`;
          const apen =
            h.fasettApen(nokkel, ['d-gruppe', 'd-status']) || f.valg.some((v) => v.valgt);
          return h.el(
            'details',
            {
              class: 'planer-fasett',
              open: apen,
              ontoggle: (e) => h.settFasettApen(nokkel, e.target.open),
            },
            h.el(
              'summary',
              { class: 'planer-fasett-tittel', 'data-fokus': `dfasett:${f.id}` },
              `${f.tittel} (${f.valg.length})`,
            ),
            h.el(
              'ul',
              { class: 'planer-fasett-liste' },
              ...f.valg.map((v) =>
                h.el(
                  'li',
                  {},
                  h.el(
                    'label',
                    { class: 'planer-fasett-valg' },
                    h.el('input', {
                      type: 'checkbox',
                      checked: v.valgt,
                      'data-fokus': `df:${f.id}:${v.verdi}`,
                      onchange: (e) => {
                        const ny = { ...h.tilstand().dfilter };
                        const liste = new Set(ny[f.id]);
                        if (e.target.checked) liste.add(v.verdi);
                        else liste.delete(v.verdi);
                        ny[f.id] = [...liste];
                        h.nyttDokFilter(ny);
                      },
                    }),
                    v.symbol
                      ? h.el('span', {
                          class: `dok-fasett-symbol ${f.id === 'status' ? `st-${v.verdi}` : `pri-${v.verdi}`}`,
                          'aria-hidden': 'true',
                          tekst: v.symbol,
                        })
                      : null,
                    h.el('span', { class: 'planer-fasett-tekst', tekst: v.tekst }),
                    h.el('span', {
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
      h.el('p', {
        class: 'planer-treff',
        role: 'status',
        tekst: `${treff.length} av ${alle.length} dokumenter`,
      }),
    );
  }

  // ---- Midten: brikker, «Hva må gjøres», tidslinjen og tabellene ----
  function midtEl(h, d, treff, valgt) {
    const t = h.tilstand();
    const brikker = V.dokBrikker(t.dfilter);
    const aktivt = brikker.length > 0 || !!t.dsok;
    const hode = h.el(
      'div',
      { class: 'planer-brikker', 'aria-label': 'Aktive filtre' },
      ...brikker.map((b) =>
        h.el(
          'span',
          { class: 'merke planer-brikke' },
          b.tekst,
          h.el('button', {
            type: 'button',
            class: 'planer-brikke-fjern',
            tekst: '✕',
            'aria-label': `Fjern filteret ${b.tekst}`,
            'data-fokus': `dbrikke:${b.fasett}:${b.verdi}`,
            onclick: () =>
              h.nyttDokFilter({
                ...t.dfilter,
                [b.fasett]: t.dfilter[b.fasett].filter((x) => x !== b.verdi),
              }),
          }),
        ),
      ),
      t.dsok ? h.el('span', { class: 'merke planer-brikke', tekst: `Søk: ${t.dsok}` }) : null,
      aktivt
        ? h.el('button', {
            type: 'button',
            class: 'knapp-liten knapp-kontur',
            tekst: 'Nullstill',
            'data-fokus': 'dnullstill',
            onclick: () => h.nyttDokFilter(V.tomtDokFilter(), { dsok: '' }),
          })
        : null,
    );

    const alle = d.dokumenter ?? [];
    let innhold;
    if (!alle.length)
      innhold = h.el(
        'div',
        { class: 'tom tom-tilstand' },
        h.el('p', { tekst: 'Dokumentregisteret er tomt.' }),
        h.el('p', {
          class: 'planer-hjelp',
          tekst:
            'Legg inn dokumenter med ko.mjs plan dok ny --fil <json> (feltene står i docs/plan-register.md).',
        }),
      );
    else if (!treff.length)
      innhold = h.el(
        'div',
        { class: 'tom tom-tilstand' },
        h.el('p', { tekst: 'Ingen dokumenter passer filtrene og søket.' }),
        h.el('button', {
          type: 'button',
          class: 'lenke-knapp',
          tekst: 'Nullstill filtrene',
          onclick: () => h.nyttDokFilter(V.tomtDokFilter(), { dsok: '' }),
        }),
      );
    else
      innhold = h.el('div', {}, ...V.dokGrupper(treff).map((g) => gruppeEl(h, g, valgt, aktivt)));

    return h.el(
      'section',
      { class: 'planer-midt dok-midt', 'aria-label': 'Dokumentene', 'data-rull': 'dliste' },
      hode,
      alle.length ? maaGjoresEl(h, d.dok_maa_gjores ?? []) : null,
      alle.length ? tidslinjeEl(h, d.dok_tidslinje ?? []) : null,
      innhold,
    );
  }

  /** «Hva må gjøres» øverst: mangler, forfalte revisjoner, høy alvor, versjonsglipp og for-prod. */
  function maaGjoresEl(h, liste) {
    if (!liste.length)
      return h.el('p', { class: 'dok-alt-ok', tekst: '✓ Ingen dokumenter må gjøres noe med nå.' });
    const apen = h.fasettApen('d-maa', ['d-maa']);
    return h.el(
      'details',
      {
        class: 'dok-maa',
        open: apen,
        ontoggle: (e) => h.settFasettApen('d-maa', e.target.open),
      },
      h.el(
        'summary',
        { class: 'dok-seksjon-tittel', 'data-fokus': 'dmaa' },
        h.el('span', { 'aria-hidden': 'true', tekst: '! ' }),
        `Hva må gjøres (${liste.length})`,
      ),
      h.el(
        'ul',
        { class: 'dok-maa-liste' },
        ...liste.map((m) =>
          h.el(
            'li',
            {},
            dokKnapp(h, m.id, `${m.id} ${m.tittel}`, `dmaa:${m.id}`),
            h.el('span', {
              class: 'dok-maa-grunner',
              tekst: m.grunner.map((g) => g.tekst).join(' · '),
            }),
          ),
        ),
      ),
    );
  }

  /** Tidslinjen for revisjoner og frister, én kolonne per måned med Forfalt først. */
  function tidslinjeEl(h, elementer) {
    const kolonner = V.tidslinjeMaaneder(elementer);
    if (!kolonner.length) return null;
    const apen = h.fasettApen('d-tid', ['d-tid']);
    return h.el(
      'details',
      { class: 'dok-tid', open: apen, ontoggle: (e) => h.settFasettApen('d-tid', e.target.open) },
      h.el(
        'summary',
        { class: 'dok-seksjon-tittel', 'data-fokus': 'dtid' },
        `Revisjoner og frister de neste 12 månedene (${elementer.length})`,
      ),
      h.el(
        'ol',
        { class: 'dok-tid-band', 'aria-label': 'Tidslinje per måned' },
        ...kolonner.map((k) =>
          h.el(
            'li',
            { class: `dok-tid-mnd${k.forfalt ? ' forfalt' : ''}` },
            h.el('h3', { class: 'dok-tid-mnd-tittel', tekst: k.tittel }),
            h.el(
              'ul',
              {},
              ...k.elementer.map((e) =>
                h.el(
                  'li',
                  { class: `dok-tid-punkt t-${e.type}` },
                  h.el('span', {
                    class: 'dok-tid-type',
                    tekst: `${e.type === 'frist' ? '◷ Frist' : '⟳ Revisjon'} ${kortDato(e.dato)}`,
                  }),
                  dokKnapp(h, e.id, e.id, `dtid:${e.type}:${e.id}`),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /** Én gruppe: en foldbar overskrift og tabellen. */
  function gruppeEl(h, g, valgt, aktivt) {
    const nokkel = `dg:${g.id}`;
    // Gruppene er åpne som standard; det du lukker, huskes. Med filter eller søk er alt med treff åpent.
    const apen = aktivt || !h.erLukket(nokkel) || (valgt && valgt.gruppe === g.id);
    const id = `dok-g-${g.id}`;
    const sammendrag = Object.entries(g.status)
      .map(([st, n]) => `${n} ${(V.DOK_STATUS[st]?.tekst ?? st).toLowerCase()}`)
      .join(', ');
    return h.el(
      'section',
      { class: 'dok-gruppe', 'aria-labelledby': `${id}-t` },
      h.el(
        'div',
        { class: 'planer-rad planer-rad-modul' },
        h.el(
          'button',
          {
            type: 'button',
            class: 'planer-fold',
            id: `${id}-t`,
            'aria-expanded': apen ? 'true' : 'false',
            'aria-controls': id,
            'data-fokus': `dg:${g.id}`,
            onclick: () => h.veksleLukket(nokkel),
          },
          h.el('span', {
            class: 'planer-fold-pil',
            'aria-hidden': 'true',
            tekst: apen ? '▾' : '▸',
          }),
          h.el('span', { class: 'planer-gruppe-tittel', tekst: g.tittel }),
          h.el('span', {
            class: 'planer-antall',
            tekst: String(g.antall),
            'aria-label': `${g.antall} dokumenter`,
          }),
        ),
        h.el('span', { class: 'dok-gruppe-sammendrag', tekst: sammendrag }),
        g.maa ? h.el('span', { class: 'dok-varsel v-maa', tekst: `! ${g.maa} må gjøres` }) : null,
      ),
      apen ? tabellEl(h, g, valgt, id) : null,
    );
  }

  function tabellEl(h, g, valgt, id) {
    const kol = [
      'Status',
      'Dokument',
      'Målgruppe',
      'Versjon',
      'Publisert',
      'Neste revisjon',
      'Problemer',
      'Prioritet',
    ];
    return h.el(
      'div',
      { class: 'dok-tabell-ramme', id },
      h.el(
        'table',
        { class: 'dok-tabell' },
        h.el('caption', { class: 'skjult-for-oyet', tekst: `${g.tittel}: ${g.antall} dokumenter` }),
        h.el(
          'thead',
          {},
          h.el(
            'tr',
            {},
            ...kol.map((k) => h.el('th', { scope: 'col', tekst: k })),
            h.el(
              'th',
              { scope: 'col' },
              h.el('span', { class: 'skjult-for-oyet', tekst: 'Kopier' }),
            ),
          ),
        ),
        h.el('tbody', {}, ...g.dokumenter.map((x) => radEl(h, x, valgt))),
      ),
    );
  }

  function radEl(h, x, valgt) {
    const erValgt = valgt?.id === x.id;
    const hoy = x.problemer.filter((p) => p?.alvor === 'hoy').length;
    const pub = x.publisert.map(
      (p) => `${V.DOK_PUBLISERT[p.hvor] ?? p.hvor}${p.versjon ? ` ${p.versjon}` : ''}`,
    );
    const nr = x.neste_revisjon;
    return h.el(
      'tr',
      { class: `dok-rad${erValgt ? ' valgt' : ''}`, 'data-dok': x.id },
      h.el('td', {}, statusEl(h, x.status)),
      h.el(
        'th',
        { scope: 'row', class: 'dok-navn' },
        h.el(
          'button',
          {
            type: 'button',
            class: 'dok-velg',
            'aria-current': erValgt ? 'true' : null,
            'data-fokus': `dok:${x.id}`,
            onclick: () => velgDok(h, x.id),
          },
          h.el('span', { class: 'planer-post-id', tekst: x.id }),
          h.el('span', { class: 'dok-tittel', tekst: x.tittel }),
        ),
      ),
      h.el('td', { tekst: V.DOK_MALGRUPPE[x.malgruppe] ?? x.malgruppe ?? '' }),
      h.el(
        'td',
        {},
        h.el('span', { tekst: x.versjon ?? '–' }),
        x.gjeldende_versjon && x.gjeldende_versjon !== x.versjon
          ? h.el('span', { class: 'dok-liten', tekst: ` (gjelder ${x.gjeldende_versjon})` })
          : null,
        x.glipp.length
          ? h.el(
              'span',
              { class: 'dok-varsel v-glipp', title: x.glipp.map((g) => g.tekst).join('\n') },
              h.el('span', { 'aria-hidden': 'true', tekst: '⚠' }),
              h.el('span', { class: 'dok-varsel-tekst', tekst: ' Versjonsglipp' }),
            )
          : null,
      ),
      h.el('td', { tekst: pub.length ? pub.join(', ') : '–' }),
      h.el(
        'td',
        { class: nr?.forfalt ? 'dok-forfalt' : nr?.snart ? 'dok-snart' : null },
        nr?.forfalt ? h.el('span', { 'aria-hidden': 'true', tekst: '⟳ ' }) : null,
        nr ? nesteTekst(nr) : '–',
      ),
      h.el(
        'td',
        {},
        x.problemer.length
          ? h.el('span', {
              class: `dok-varsel${hoy ? ' v-hoy' : ''}`,
              tekst: `! ${x.problemer.length}${hoy ? ` (${hoy} høy)` : ''}`,
              title: x.problemer
                .map((p) => `${V.DOK_ALVOR[p.alvor] ?? p.alvor}: ${p.tekst}`)
                .join('\n'),
            })
          : '–',
      ),
      h.el('td', {}, x.prioritet ? h.priEl(x) : '–'),
      h.el('td', {}, h.kopierKnapp(V.dokLinje(x), `Kopier startlinjen for ${x.id}`)),
    );
  }

  // ---- Høyre: detaljpanelet ----
  function detaljEl(h, d, x) {
    const t = h.tilstand();
    if (!x)
      return h.el(
        'aside',
        { class: 'planer-detalj tom-detalj', 'aria-label': 'Detaljpanelet' },
        h.el('p', {
          class: 'tom',
          tekst: t.dok
            ? `Fant ikke ${t.dok} i dokumentregisteret.`
            : 'Velg et dokument i tabellen for å se detaljene.',
        }),
      );
    const seksjon = (tittel, ...innhold) =>
      h.el(
        'section',
        { class: 'dok-seksjon' },
        h.el('h3', { class: 'planer-rute-tittel', tekst: tittel }),
        ...innhold,
      );
    const v = V.DOK_STATUS[x.status];
    return h.el(
      'aside',
      { class: 'planer-detalj', 'aria-label': `Detaljer for ${x.id}`, 'data-rull': 'ddetalj' },
      h.el('button', {
        type: 'button',
        class: 'knapp-liten knapp-kontur planer-tilbake',
        tekst: 'Tilbake til tabellen',
        onclick: () => h.bruk({ dok: null }),
      }),
      h.el(
        'header',
        { class: 'planer-detalj-hode' },
        h.el('p', { class: 'planer-detalj-id', tekst: x.id }),
        h.el('h2', { class: 'planer-detalj-tittel', tekst: x.tittel }),
        h.el(
          'p',
          { class: 'planer-detalj-merker' },
          statusEl(h, x.status),
          h.el('span', { class: 'merke', tekst: V.DOK_GRUPPE[x.gruppe] ?? x.gruppe ?? '' }),
          h.el('span', {
            class: 'merke',
            tekst: `For ${(V.DOK_MALGRUPPE[x.malgruppe] ?? x.malgruppe ?? '').toLowerCase()}`,
          }),
          x.prioritet ? h.priEl(x) : null,
        ),
        h.el(
          'div',
          { class: 'planer-handlinger' },
          h.el('button', {
            type: 'button',
            class: 'knapp knapp-fylt',
            tekst: 'Kopier startlinje',
            title: V.dokLinje(x),
            'data-fokus': 'dkopier',
            onclick: () => h.kopier(V.dokLinje(x)),
          }),
        ),
        x.grunner.length
          ? h.el(
              'div',
              { class: 'planer-kontroll' },
              h.el('p', { class: 'planer-kontroll-tittel', tekst: 'Må gjøres' }),
              h.el('ul', {}, ...x.grunner.map((g) => h.el('li', { tekst: g.tekst }))),
            )
          : null,
      ),
      h.el(
        'dl',
        { class: 'planer-felt' },
        h.felt('Status', v ? `${v.symbol} ${v.tekst}` : x.status),
        h.felt('Arbeidsversjon', x.versjon),
        h.felt('Gjeldende (akseptert)', x.gjeldende_versjon),
        h.felt(
          'Kilde',
          x.kilde ? h.el('code', { tekst: x.kilde }) : null,
          x.kilde
            ? h.kopierKnapp(x.kilde, `Kopier stien ${x.kilde}`, 'knapp-liten knapp-kontur')
            : null,
        ),
        h.felt('Revideres', x.revisjon_hver),
        h.felt('Sist revidert', x.sist_revidert ? kortDato(x.sist_revidert) : null),
        h.felt('Neste revisjon', nesteTekst(x.neste_revisjon)),
        h.felt('Frist', x.frist ? kortDato(x.frist) : null),
        h.felt(
          'Prioritet',
          x.prioritet
            ? `${V.PRIORITET[x.prioritet]?.tekst ?? x.prioritet}${
                x.naa_kategori.length
                  ? ` (${x.naa_kategori.map((k) => V.KATEGORI[k] ?? k).join(', ')})`
                  : ''
              }, satt av ${x.prioritet_satt_av === 'eier' ? 'eieren' : 'agent'}`
            : null,
        ),
        h.felt('Grunn', x.prioritet_grunn),
        h.felt('Droppet', x.dropp_grunn),
        h.felt('Merknad', x.merknad),
      ),
      x.glipp.length
        ? seksjon(
            'Versjonsglipp',
            h.liste(
              x.glipp.map((g) =>
                h.el(
                  'li',
                  { class: 'dok-glipp' },
                  h.el('span', { 'aria-hidden': 'true', tekst: '⚠ ' }),
                  g.tekst,
                ),
              ),
              '',
            ),
          )
        : null,
      seksjon(
        'Publisert',
        h.liste(
          x.publisert.map((p) =>
            h.el(
              'li',
              {},
              h.el('span', { class: 'merke', tekst: V.DOK_PUBLISERT[p.hvor] ?? p.hvor }),
              ` ${p.versjon ? `versjon ${p.versjon}` : 'uten versjon'} `,
              p.url
                ? h.el('a', {
                    href: p.url,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    tekst: p.url,
                  })
                : p.sti
                  ? h.el('code', { tekst: p.sti })
                  : null,
            ),
          ),
          'Ikke publisert noe sted.',
        ),
      ),
      seksjon(
        'Problemer',
        h.liste(
          x.problemer.map((p) =>
            h.el(
              'li',
              { class: `dok-problem a-${p.alvor}` },
              h.el('span', { class: 'merke', tekst: V.DOK_ALVOR[p.alvor] ?? p.alvor }),
              ` ${p.tekst}`,
              p.kilde ? h.el('span', { class: 'dok-liten', tekst: ` (${p.kilde})` }) : null,
            ),
          ),
          'Ingen kjente problemer.',
        ),
      ),
      seksjon('Revisjoner', revisjonerEl(h, x)),
      seksjon(
        'Avhenger av',
        h.liste(
          x.avhenger_av.map((a) =>
            h.el(
              'li',
              {},
              dokKnapp(h, a.id, `${a.id}${a.tittel ? ` ${a.tittel}` : ' (ukjent)'}`),
              a.status
                ? h.el('span', {
                    class: 'dok-liten',
                    tekst: ` ${V.DOK_STATUS[a.status]?.tekst ?? a.status}`,
                  })
                : null,
            ),
          ),
          'Ingen.',
        ),
      ),
      x.brukt_av.length
        ? seksjon(
            'Brukes av',
            h.liste(
              x.brukt_av.map((id) => h.el('li', {}, dokKnapp(h, id, id))),
              '',
            ),
          )
        : null,
      seksjon(
        'Planposter',
        h.liste(
          x.planposter.map((p) =>
            h.el(
              'li',
              {},
              h.el('button', {
                type: 'button',
                class: 'lenke-knapp',
                tekst: p.tittel ? `${p.id} ${p.tittel}` : `${p.id} (finnes ikke)`,
                onclick: () => h.gaaTilPost(p.id),
              }),
            ),
          ),
          'Ingen koblede planposter.',
        ),
      ),
      x.juridisk_punkter.length
        ? seksjon(
            'Juridiske punkter',
            h.liste(
              x.juridisk_punkter.map((j) => h.el('li', { tekst: j })),
              '',
            ),
          )
        : null,
      x.eierspm.length
        ? seksjon(
            'Eierspørsmål',
            h.liste(
              x.eierspm.map((s) =>
                h.el(
                  'li',
                  {},
                  h.el('span', { class: 'merke', tekst: s.avklart ? '✓ Avklart' : '? Åpent' }),
                  ` ${s.id}${s.tekst ? `: ${s.tekst}` : ''}`,
                ),
              ),
              '',
            ),
          )
        : null,
      seksjon(
        'Historikk',
        h.liste(
          x.historikk.map((e) =>
            h.el('li', {
              tekst: `nr. ${e.nr} ${h.dato(e.at)} ${e.av ?? ''}: ${e.handling ?? ''} (${e.felt.join(', ')})`,
            }),
          ),
          'Ingen endringer i loggen.',
        ),
      ),
    );
  }

  /** Revisjonene for ett dokument som en loddrett tidslinje: de registrerte, så den neste. */
  function revisjonerEl(h, x) {
    const punkter = x.revisjoner.map((r) =>
      h.el(
        'li',
        { class: 'dok-rev' },
        h.el('span', { class: 'dok-rev-dato', tekst: kortDato(r.dato) }),
        h.el('span', {
          tekst: `${r.versjon ? `versjon ${r.versjon}` : 'revidert'}${r.merknad ? `: ${r.merknad}` : ''}`,
        }),
      ),
    );
    const nr = x.neste_revisjon;
    if (nr)
      punkter.push(
        h.el(
          'li',
          { class: `dok-rev neste${nr.forfalt ? ' forfalt' : ''}` },
          h.el('span', {
            class: 'dok-rev-dato',
            tekst: nr.dato ? kortDato(nr.dato) : 'Ved hendelse',
          }),
          h.el('span', {
            tekst: nr.hendelse
              ? `Neste: ${nr.hendelse}`
              : `Neste revisjon, ${dagerTekst(nr.dager)}`,
          }),
        ),
      );
    return punkter.length
      ? h.el('ol', { class: 'dok-rev-linje' }, ...punkter)
      : h.el('p', {
          class: 'tom',
          tekst: 'Ingen revisjoner registrert og ingen plan (revisjon_hver).',
        });
  }

  window.KoPlanDok = { ruter };
})();
