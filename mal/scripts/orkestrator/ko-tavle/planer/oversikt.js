// =============================================================
// oversikt.js: oversiktssiden i Planer-rommet (se docs/board.md).
// Vanilla JS, ingen byggesteg, ingen CDN. All tekst settes med textContent (via h.el), aldri innerHTML.
//
// Én skjerm som svarer på «hvor står vi»:
//   - «Arbeider nå» øverst: postene en /planer-økt jobber med (aktiv_okt, pulsmarkør, forsvinner etter 2 timer),
//   - åtte modulkort (antall, stolpe etter prioritet og etter modenhet, hvor mye som er bygget, og tre varseltall:
//     eierspørsmål, juridisk og foreldet); et klikk åpner listen filtrert på modulen,
//   - «Venter på deg»: de fem eierspørsmålene og juridiske punktene som blokkerer mest, med svarknapp,
//   - kapasiteten i Nå, med varsel når Nå vokser raskere enn køen tømmes,
//   - nylig endret og nylig registrert.
// Reglene (modulKort, venterPaaDeg, arbeiderNaa, kapasitet og nylig) er de rene funksjonene i koPlanVisning.js; her
// er bare tegningen. Fristbåndet over siden tegnes av kart.js (planer.js setter det inn). Siden skriver ingenting.
// =============================================================
'use strict';

(function () {
  const V = window.KoPlanVisning;

  /** En stolpe delt i deler (bredde etter antall). Teksten ved siden av bærer tallene, så fargen er aldri alene. */
  function stolpe(h, deler, navn, klasse) {
    const sum = deler.reduce((n, x) => n + x.antall, 0);
    const tekst = deler.map((x) => `${x.tekst} ${x.antall}`).join(', ');
    return h.el(
      'span',
      { class: 'oversikt-stolpe', role: 'img', 'aria-label': `${navn}: ${tekst}` },
      ...deler
        .filter((x) => x.antall > 0)
        .map((x) =>
          h.el('span', {
            class: `oversikt-del ${klasse}-${x.id}`,
            '--andel': `${sum ? (x.antall / sum) * 100 : 0}%`,
          }),
        ),
    );
  }

  /** Forklaringen under en stolpe: symbol (når det finnes), tekst og tall. */
  function forklaring(h, deler) {
    return h.el(
      'span',
      { class: 'oversikt-forklaring', 'aria-hidden': 'true' },
      deler.map((x) => `${x.symbol ? `${x.symbol} ` : ''}${x.tekst} ${x.antall}`).join(' · '),
    );
  }

  function modulkort(h, k) {
    const pst = Math.round(k.andel * 100);
    const varsel = (tegn, n, en, flere, klasse) =>
      h.el(
        'span',
        { class: `oversikt-varsel${n ? ` har ${klasse}` : ''}` },
        h.el('span', { 'aria-hidden': 'true', tekst: tegn }),
        ` ${n} ${n === 1 ? en : flere}`,
      );
    return h.el(
      'li',
      { class: 'oversikt-kort-plass' },
      h.el(
        'button',
        {
          type: 'button',
          class: 'oversikt-kort',
          'data-fokus': `modulkort:${k.oid}`,
          'aria-label': `${k.tittel}: ${k.antall} poster. Åpne listen filtrert på modulen.`,
          onclick: () => {
            const f = V.tomtFilter();
            f.modul = [k.oid];
            h.gaaTilListe({ filter: f, sok: '', post: null });
          },
        },
        h.el(
          'span',
          { class: 'oversikt-kort-hode' },
          h.el('span', { class: 'oversikt-kort-tittel', tekst: k.tittel }),
          h.el('span', {
            class: 'oversikt-kort-antall',
            tekst: `${k.antall} ${k.antall === 1 ? 'post' : 'poster'}${k.droppet ? `, ${k.droppet} droppet` : ''}`,
          }),
        ),
        h.el('span', { class: 'oversikt-etikett', tekst: 'Prioritet' }),
        stolpe(h, k.prioritet, 'Prioritet', 'pri'),
        forklaring(h, k.prioritet),
        h.el('span', { class: 'oversikt-etikett', tekst: 'Modenhet' }),
        stolpe(h, k.modenhet, 'Modenhet', 'mod'),
        forklaring(h, k.modenhet),
        h.el('span', {
          class: 'oversikt-bygget',
          tekst: `Bygget: ${k.bygget} av ${k.antall} (${pst} %)`,
        }),
        h.el(
          'span',
          { class: 'oversikt-varsler' },
          varsel('?', k.eierspm, 'eierspørsmål', 'eierspørsmål', 'v-eier'),
          varsel('§', k.juridisk, 'juridisk punkt', 'juridiske punkter', 'v-jur'),
          varsel('⟳', k.foreldet, 'foreldet', 'foreldet', 'v-foreldet'),
          k.aktiv
            ? h.el(
                'span',
                { class: 'oversikt-varsel har v-aktiv' },
                h.el('span', { class: 'puls', 'aria-hidden': 'true', tekst: '◉' }),
                ` ${k.aktiv} under arbeid`,
              )
            : null,
        ),
      ),
    );
  }

  function arbeiderNaaEl(h, d) {
    const liste = V.arbeiderNaa(d);
    if (!liste.length) return null;
    return h.el(
      'section',
      { class: 'oversikt-boks oversikt-arbeider', 'aria-label': 'Arbeider nå' },
      h.el('h2', { class: 'oversikt-tittel', tekst: 'Arbeider nå' }),
      h.el(
        'ul',
        { class: 'oversikt-liste' },
        ...liste.map((x) =>
          h.el(
            'li',
            { class: 'oversikt-rad' },
            h.el('span', { class: 'puls', 'aria-hidden': 'true', tekst: '◉' }),
            h.el('span', { class: 'oversikt-merk', tekst: 'Under arbeid i Claude Code' }),
            h.el('button', {
              type: 'button',
              class: 'lenke-knapp',
              tekst: `${x.id} ${x.tittel}`,
              'data-fokus': `arbeider:${x.id}`,
              onclick: () => h.gaaTilPost(x.id),
            }),
            h.el('span', {
              class: 'oversikt-tid',
              tekst: `${x.av ? `${x.av}, ` : ''}siste puls ${h.dato(x.at)}`,
            }),
          ),
        ),
      ),
    );
  }

  function venterEl(h, d) {
    const v = V.venterPaaDeg(d);
    return h.el(
      'section',
      { class: 'oversikt-boks', 'aria-label': 'Venter på deg' },
      h.el(
        'h2',
        { class: 'oversikt-tittel' },
        'Venter på deg',
        v.totalt > v.punkter.length
          ? h.el('span', {
              class: 'oversikt-under',
              tekst: ` (de ${v.punkter.length} som blokkerer mest av ${v.totalt})`,
            })
          : null,
      ),
      v.punkter.length
        ? h.el(
            'ol',
            { class: 'oversikt-liste' },
            ...v.punkter.map((x) =>
              h.el(
                'li',
                { class: 'oversikt-rad oversikt-venter' },
                h.el('span', {
                  class: `merke oversikt-type t-${x.type}`,
                  tekst: x.type === 'eier' ? '? Eierspørsmål' : '§ Juridisk',
                }),
                h.el('span', { class: 'oversikt-id', tekst: x.id }),
                h.el('span', {
                  class: 'oversikt-tekst',
                  tekst: x.tekst.length > 160 ? `${x.tekst.slice(0, 157)} …` : x.tekst,
                  title: x.tekst,
                }),
                h.el('span', {
                  class: 'oversikt-tid',
                  tekst:
                    `blokkerer ${x.blokkerer} ${x.blokkerer === 1 ? 'post' : 'poster'}` +
                    `${x.oppgaver ? `, ${x.oppgaver} køoppgaver venter` : ''}` +
                    `${x.frist ? `, frist ${x.frist}` : ''}${x.haster ? ' (haster)' : ''}`,
                }),
                h.el('button', {
                  type: 'button',
                  class: 'knapp-liten knapp-tonet',
                  tekst: 'Svar',
                  'aria-label': `Svar på ${x.id}`,
                  'data-fokus': `svar:${x.type}:${x.id}`,
                  onclick: () =>
                    x.type === 'eier'
                      ? h.bruk({ flate: 'beslutn', sp: x.id }, { rull: true })
                      : h.bruk({ flate: 'jur', jur: x.id }, { rull: true }),
                }),
              ),
            ),
          )
        : h.el('p', { class: 'tom', tekst: 'Ingenting venter på deg.' }),
    );
  }

  function kapasitetEl(h, d) {
    const k = d.kapasitet;
    if (!k) return null;
    return h.el(
      'section',
      { class: 'oversikt-boks', 'aria-label': 'Kapasiteten i Nå' },
      h.el('h2', { class: 'oversikt-tittel', tekst: 'Kapasiteten i Nå' }),
      h.el('p', { class: 'oversikt-kapasitet', tekst: k.tekst }),
      k.varsel
        ? h.el(
            'p',
            { class: 'oversikt-advarsel' },
            h.el('span', { 'aria-hidden': 'true', tekst: '⚠ ' }),
            h.el('span', { class: 'skjult-for-oyet', tekst: 'Varsel: ' }),
            k.varsel_tekst,
          )
        : null,
      (k.uten_estimat ?? []).length
        ? h.el('p', {
            class: 'oversikt-under',
            tekst: `Uten estimat: ${k.uten_estimat.slice(0, 12).join(', ')}${k.uten_estimat.length > 12 ? ' …' : ''}`,
          })
        : null,
    );
  }

  function postKnapp(h, id) {
    return h.el('button', {
      type: 'button',
      class: 'lenke-knapp',
      tekst: id,
      onclick: () => h.gaaTilPost(id),
    });
  }

  function nyligEl(h, d) {
    const n = d.nylig ?? { endret: [], registrert: [] };
    return h.el(
      'section',
      { class: 'oversikt-boks', 'aria-label': 'Nylig' },
      h.el('h2', { class: 'oversikt-tittel', tekst: 'Nylig endret' }),
      n.endret.length
        ? h.el(
            'ul',
            { class: 'oversikt-liste' },
            ...n.endret.map((x) =>
              h.el(
                'li',
                { class: `oversikt-rad${x.angret ? ' angret' : ''}` },
                h.el('span', { class: 'merke', tekst: `nr. ${x.nr}` }),
                h.el('span', {
                  class: 'oversikt-tid',
                  tekst: `${h.dato(x.at)} · ${x.handling ?? ''} · ${x.av ?? ''}${x.angret ? ' · angret' : ''}`,
                }),
                ...x.ider.filter((id) => /^PL-/.test(id)).map((id) => postKnapp(h, id)),
              ),
            ),
          )
        : h.el('p', { class: 'tom', tekst: 'Ingen endringer i endringsloggen.' }),
      h.el('h2', { class: 'oversikt-tittel', tekst: 'Nylig registrert' }),
      n.registrert.length
        ? h.el(
            'ul',
            { class: 'oversikt-liste' },
            ...n.registrert.map((x) =>
              h.el(
                'li',
                { class: 'oversikt-rad' },
                postKnapp(h, x.id),
                h.el('span', { class: 'oversikt-tekst', tekst: x.tittel }),
                h.el('span', { class: 'oversikt-tid', tekst: h.dato(x.at) }),
              ),
            ),
          )
        : h.el('p', { class: 'tom', tekst: 'Ingen poster med registreringstid.' }),
    );
  }

  window.KoPlanOversikt = {
    /** Hele oversiktssiden. `h` er hjelperne fra planer.js (arbeidHjelp). */
    side(h, d) {
      if (!d.finnes)
        return h.el('p', {
          class: 'tom planer-henter',
          tekst: 'Planregisteret finnes ikke ennå (scripts/.ko/planer.json).',
        });
      return h.el(
        'div',
        { class: 'planer-oversikt', 'data-rull': 'oversikt' },
        arbeiderNaaEl(h, d),
        h.el(
          'section',
          { class: 'oversikt-moduler', 'aria-label': 'Modulene' },
          h.el('h2', { class: 'skjult-for-oyet', tekst: 'Modulene' }),
          h.el(
            'ul',
            { class: 'oversikt-kortliste' },
            ...V.modulKort(d).map((k) => modulkort(h, k)),
          ),
        ),
        h.el(
          'div',
          { class: 'oversikt-bunn' },
          venterEl(h, d),
          h.el('div', { class: 'oversikt-kolonne' }, kapasitetEl(h, d), nyligEl(h, d)),
        ),
      );
    },
  };
})();
