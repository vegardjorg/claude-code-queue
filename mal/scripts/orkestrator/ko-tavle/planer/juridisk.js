// =============================================================
// juridisk.js: flatene Juridisk, Beslutninger og Lansering i Planer-rommet (se docs/plan-register.md).
// Vanilla JS, ingen byggesteg, ingen CDN.
//
// Juridisk og Beslutninger har samme tre-rute-mønster som planpostene og dokumentene: fasetter med antall
// til venstre, en foldbar liste i grupper i midten og detaljpanelet til høyre. Lansering er én oversikt («hva står
// mellom oss og første betalende kunde?»), med fristbåndet over (tegnet av kart.js).
//
// Alt er visninger over data som finnes fra før: juridisk-feltet på planpostene og eierspørsmålene i ko.json.
// Flatene skriver bare to ting:
//   - svar på et eierspørsmål: POST /api/handling { type: 'avklar' } (= `ko.mjs avklar <id> --svar … --av eier`,
//     samme rute og vaktregler som «Venter på deg»; planposten løsnes av seg selv),
//   - juristpakken: POST /api/juristpakke lagrer et utkast i <datamappe>/juristpakker/juristpakke-<dato>.md lokalt. Den sendes
//     aldri noe sted.
// Juridiske punkter endres med `ko.mjs plan endre <post> --sett '{"juridisk":…}'` (kopier-linja tar det videre i
// Claude Code). Reglene (filtrene, fasett-tallene, gruppene, stien og kopier-linjene) er de rene funksjonene i
// scripts/lib/koPlanVisning.js; dataene regnes av koPlan.js på serveren. All tekst settes med textContent. Farge er
// aldri eneste bærer: status og blokkering har symbol og tekst.
// =============================================================
'use strict';

(function () {
  const V = window.KoPlanVisning;

  // Tilstand som ikke hører hjemme i nettadressen: forhåndsvisningen av juristpakken, svarutkastene (så en
  // oppdatering fra serveren ikke visker ut det du skriver) og et svar som venter på «Svar likevel».
  const u = { pakke: null, pakkeHenter: false, utkast: new Map(), bekreft: null, sender: false };
  const NOKKEL = 'ko-tavle-nokkel'; // samme som tavle.js (sessionStorage)

  /** Skrivekall med nøkkelen. Gir { status, svar } (svaret er JSON fra serveren, eller en feiltekst). */
  async function post(sti, kropp) {
    const res = await fetch(sti, {
      method: 'POST',
      headers: {
        'X-Ko-Nokkel': sessionStorage.getItem(NOKKEL) ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(kropp),
    });
    let svar = null;
    try {
      svar = await res.json();
    } catch {
      svar = null;
    }
    return { status: res.status, svar: svar ?? { ok: false, melding: `HTTP ${res.status}` } };
  }

  function kortDato(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(s)) return s ?? '';
    return new Date(`${s.slice(0, 10)}T12:00:00Z`).toLocaleDateString('nb-NO', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  function fristTekst(frist, dager) {
    if (!frist) return null;
    if (dager == null) return `Frist ${kortDato(frist)}`;
    if (dager < 0) return `Frist ${kortDato(frist)} (forfalt for ${-dager} dager siden)`;
    if (dager === 0) return `Frist ${kortDato(frist)} (i dag)`;
    return `Frist ${kortDato(frist)} (om ${dager} ${dager === 1 ? 'dag' : 'dager'})`;
  }

  function modulNavn(d, oid) {
    if (!oid) return 'Uten modul';
    return (d.moduler ?? []).find((m) => m.oid === oid)?.tittel ?? oid;
  }

  const filterNokkel = (flate) => (flate === 'jur' ? 'jfilter' : 'bfilter');
  const sokNokkel = (flate) => (flate === 'jur' ? 'jsok' : 'bsok');
  const valgNokkel = (flate) => (flate === 'jur' ? 'jur' : 'sp');

  function valgtFor(h, d) {
    const t = h.tilstand();
    if (t.flate === 'jur') return t.jur ? (d.jur_punkter ?? []).find((x) => x.id === t.jur) : null;
    if (t.flate === 'beslutn')
      return t.sp ? V.jbListe('beslutn', d).find((x) => x.id === t.sp) : null;
    return null;
  }

  /** Er et punkt eller spørsmål valgt (smal skjerm: panelet legger seg over listen)? */
  function harValgt(h, d) {
    return !!valgtFor(h, d);
  }

  /** Postene i lanseringsoversikten (utvalget til fristbåndet over den). */
  function lanseringIder(d) {
    return (d.lansering?.poster ?? []).map((p) => p.id);
  }

  function ruter(h, d) {
    const t = h.tilstand();
    if (t.flate === 'lansering') return lanseringEl(h, d);
    const flate = t.flate;
    const alle = V.jbListe(flate, d);
    const filter = t[filterNokkel(flate)];
    const treff = V.jbFiltrer(flate, alle, filter, t[sokNokkel(flate)]);
    const valgt = valgtFor(h, d);
    return h.el(
      'div',
      { class: `planer-ruter jb-ruter jb-${flate}` },
      filtreEl(h, d, flate, alle, treff),
      midtEl(h, d, flate, alle, treff, valgt),
      flate === 'jur' ? jurDetaljEl(h, d, valgt) : beslDetaljEl(h, d, valgt),
    );
  }

  // ---- Små byggeklosser ----
  function symbolMerke(h, klasse, v, fallback) {
    const x = v ?? { tekst: fallback ?? 'ukjent', symbol: '·' };
    return h.el(
      'span',
      { class: `merke jb-merke ${klasse}` },
      h.el('span', { 'aria-hidden': 'true', tekst: `${x.symbol} ` }),
      h.el('span', { tekst: x.tekst }),
    );
  }
  const statusEl = (h, st) => symbolMerke(h, `jst-${st}`, V.JUR_STATUS[st], st);
  const blokkEl = (h, b) =>
    symbolMerke(
      h,
      `jbl-${b}`,
      V.JUR_BLOKK[b] && {
        ...V.JUR_BLOKK[b],
        tekst: `Blokkerer ${V.JUR_BLOKK[b].tekst.toLowerCase()}`,
      },
      b,
    );

  function seksjon(h, tittel, ...innhold) {
    return h.el(
      'section',
      { class: 'dok-seksjon' },
      h.el('h3', { class: 'planer-rute-tittel', tekst: tittel }),
      ...innhold,
    );
  }

  function postKnapp(h, id, tittel, fokus) {
    return h.el('button', {
      type: 'button',
      class: 'lenke-knapp',
      tekst: tittel ? `${id} ${tittel}` : id,
      'data-fokus': fokus ?? null,
      onclick: () => h.gaaTilPost(id),
    });
  }

  function velg(h, flate, id) {
    h.bruk({ flate, [valgNokkel(flate)]: id }, { push: true, rull: true });
  }

  // ---- Venstre: søk, snarveier og fasetter ----
  const SNARVEIER = {
    jur: [
      { navn: 'Prod-porten', sok: '?jbl=prod' },
      { navn: 'Åpne (KI først)', sok: '?jst=apen' },
      { navn: 'Til jurist', sok: '?jst=til-jurist' },
      { navn: 'Avklart', sok: '?jst=avklart,ikke-relevant' },
    ],
    beslutn: [
      { navn: 'Haster', sok: '?bfr=forfalt,30' },
      { navn: 'Blokkerer mest', sok: '?bbl=mange' },
      { navn: 'Eierhandlinger', sok: '?bty=eier-oppgave' },
      { navn: 'Historikk (besvarte)', sok: '?bst=besvart' },
    ],
  };
  let sokTid = null;

  function filtreEl(h, d, flate, alle, treff) {
    const t = h.tilstand();
    const fn = filterNokkel(flate);
    const sn = sokNokkel(flate);
    const fasetter = V.jbFasettTall(flate, alle, t[fn], t[sn], { moduler: d.moduler ?? [] });
    const naaSok = JSON.stringify(t[fn]);
    const nytt = (filter, ekstra = {}) =>
      h.bruk({ [fn]: filter, [valgNokkel(flate)]: null, ...ekstra });
    return h.el(
      'aside',
      {
        id: 'planer-filtre',
        class: 'planer-filtre',
        'aria-label':
          flate === 'jur' ? 'Filtre for de juridiske punktene' : 'Filtre for beslutningene',
        'data-rull': `${flate}-filtre`,
      },
      h.el(
        'label',
        { class: 'planer-sok-etikett' },
        h.el('span', {
          class: 'skjult-for-oyet',
          tekst: flate === 'jur' ? 'Søk i de juridiske punktene' : 'Søk i beslutningene',
        }),
        h.el('input', {
          type: 'search',
          class: 'sok planer-sok',
          placeholder:
            flate === 'jur' ? 'Søk i id, spørsmål, plan, lov' : 'Søk i id, tekst, svar, plan',
          autocomplete: 'off',
          value: t[sn],
          'data-fokus': `${flate}-sok`,
          oninput: (e) => {
            clearTimeout(sokTid);
            const v = e.target.value.slice(0, 120);
            sokTid = setTimeout(() => h.bruk({ [sn]: v.trim() }, { push: false }), 200);
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
          ...SNARVEIER[flate].map((v) => {
            const f = V.lesUrl(v.sok)[fn];
            return h.el(
              'li',
              { class: 'planer-visning' },
              h.el('button', {
                type: 'button',
                class: 'lenke-knapp',
                tekst: v.navn,
                'aria-pressed': JSON.stringify(f) === naaSok ? 'true' : 'false',
                'data-fokus': `${flate}-vis:${v.navn}`,
                onclick: () => nytt(f, { [sn]: '' }),
              }),
            );
          }),
        ),
      ),
      ...fasetter
        .filter((f) => f.valg.length)
        .map((f) => {
          const nokkel = `${flate}-${f.id}`;
          const apen =
            h.fasettApen(nokkel, [`${flate}-status`, `${flate}-blokk`]) ||
            f.valg.some((v) => v.valgt);
          return h.el(
            'details',
            {
              class: 'planer-fasett',
              open: apen,
              ontoggle: (e) => h.settFasettApen(nokkel, e.target.open),
            },
            h.el(
              'summary',
              { class: 'planer-fasett-tittel', 'data-fokus': `${flate}-fasett:${f.id}` },
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
                      'data-fokus': `${flate}-f:${f.id}:${v.verdi}`,
                      onchange: (e) => {
                        const ny = { ...h.tilstand()[fn] };
                        const liste = new Set(ny[f.id]);
                        if (e.target.checked) liste.add(v.verdi);
                        else liste.delete(v.verdi);
                        ny[f.id] = [...liste];
                        nytt(ny);
                      },
                    }),
                    v.symbol
                      ? h.el('span', {
                          class: `jb-fasett-symbol ${f.id === 'status' ? `jst-${v.verdi}` : `jbl-${v.verdi}`}`,
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
        tekst:
          flate === 'jur'
            ? `${treff.length} av ${alle.length} juridiske punkter`
            : `${treff.length} av ${alle.length} eierspørsmål`,
      }),
    );
  }

  // ---- Midten: brikker, tilleggsboksene og gruppene ----
  function midtEl(h, d, flate, alle, treff, valgt) {
    const t = h.tilstand();
    const fn = filterNokkel(flate);
    const sn = sokNokkel(flate);
    const brikker = V.jbBrikker(flate, t[fn], { moduler: d.moduler ?? [] });
    const aktivt = brikker.length > 0 || !!t[sn];
    const nullstill = () =>
      h.bruk({ [fn]: V.tomtJbFilter(flate), [sn]: '', [valgNokkel(flate)]: null });
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
            'data-fokus': `${flate}-brikke:${b.fasett}:${b.verdi}`,
            onclick: () =>
              h.bruk({
                [fn]: { ...t[fn], [b.fasett]: t[fn][b.fasett].filter((x) => x !== b.verdi) },
              }),
          }),
        ),
      ),
      t[sn] ? h.el('span', { class: 'merke planer-brikke', tekst: `Søk: ${t[sn]}` }) : null,
      aktivt
        ? h.el('button', {
            type: 'button',
            class: 'knapp-liten knapp-kontur',
            tekst: 'Nullstill',
            'data-fokus': `${flate}-nullstill`,
            onclick: nullstill,
          })
        : null,
    );

    let innhold;
    if (!alle.length)
      innhold = h.el(
        'div',
        { class: 'tom tom-tilstand' },
        h.el('p', {
          tekst:
            flate === 'jur'
              ? 'Ingen planposter har juridiske punkter ennå.'
              : 'Køen har ingen eierspørsmål.',
        }),
        flate === 'jur'
          ? h.el('p', {
              class: 'planer-hjelp',
              tekst:
                'Punktene legges på posten med ko.mjs plan endre <PL-id> --sett \'{"juridisk":{…}}\' (feltene står i docs/plan-register.md).',
            })
          : null,
      );
    else if (!treff.length)
      innhold = h.el(
        'div',
        { class: 'tom tom-tilstand' },
        h.el('p', {
          tekst:
            flate === 'jur'
              ? 'Ingen punkter passer filtrene og søket. Lukkede punkter vises når statusfilteret tar dem med.'
              : 'Ingen spørsmål passer filtrene og søket. Besvarte vises når statusfilteret tar med Besvart.',
        }),
        h.el('button', {
          type: 'button',
          class: 'lenke-knapp',
          tekst: 'Nullstill filtrene',
          onclick: nullstill,
        }),
      );
    else
      innhold = h.el(
        'div',
        {},
        ...V.jbGrupper(flate, treff).map((g) => gruppeEl(h, d, flate, g, valgt, aktivt)),
      );

    return h.el(
      'section',
      {
        class: 'planer-midt jb-midt',
        'aria-label': flate === 'jur' ? 'De juridiske punktene' : 'Eierbeslutningene',
        'data-rull': `${flate}-liste`,
      },
      hode,
      flate === 'jur' ? personvernEl(h, d) : null,
      flate === 'jur' ? juristpakkeEl(h, d) : null,
      innhold,
    );
  }

  /** Én gruppe: en foldbar overskrift og radene. Åpne som standard; det du lukker, huskes. */
  function gruppeEl(h, d, flate, g, valgt, aktivt) {
    const nokkel = `${flate}g:${g.id}`;
    const harValgte = valgt && g.elementer.some((x) => x.id === valgt.id);
    const lukketStandard = flate === 'beslutn' && g.id === 'besvart';
    const lukket = lukketStandard ? !h.erLukket(nokkel) : h.erLukket(nokkel);
    const apen = aktivt || harValgte || !lukket;
    const id = `jb-g-${flate}-${g.id}`;
    return h.el(
      'section',
      { class: 'dok-gruppe jb-gruppe', 'aria-labelledby': `${id}-t` },
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
            'data-fokus': `${flate}g:${g.id}`,
            onclick: () => h.veksleLukket(nokkel),
          },
          h.el('span', {
            class: 'planer-fold-pil',
            'aria-hidden': 'true',
            tekst: apen ? '▾' : '▸',
          }),
          g.symbol
            ? h.el('span', {
                class: `jb-fasett-symbol jst-${g.id}`,
                'aria-hidden': 'true',
                tekst: g.symbol,
              })
            : null,
          h.el('span', { class: 'planer-gruppe-tittel', tekst: g.tittel }),
          h.el('span', {
            class: 'planer-antall',
            tekst: String(g.elementer.length),
            'aria-label': `${g.elementer.length} i gruppen`,
          }),
        ),
      ),
      apen
        ? h.el(
            'ul',
            { class: 'jb-liste', id },
            ...g.elementer.map((x) =>
              flate === 'jur' ? jurRadEl(h, d, x, valgt) : beslRadEl(h, d, x, valgt),
            ),
          )
        : null,
    );
  }

  function radKnapp(h, flate, x, erValgt, ...innhold) {
    return h.el(
      'button',
      {
        type: 'button',
        class: 'jb-velg',
        'aria-current': erValgt ? 'true' : null,
        'data-fokus': `${flate}:${x.id}`,
        onclick: () => velg(h, flate, x.id),
      },
      ...innhold,
    );
  }

  function jurRadEl(h, d, x, valgt) {
    const erValgt = valgt?.id === x.id;
    return h.el(
      'li',
      { class: `jb-rad${erValgt ? ' valgt' : ''}` },
      radKnapp(
        h,
        'jur',
        x,
        erValgt,
        h.el('span', { class: 'planer-post-id', tekst: x.id }),
        h.el('span', { class: 'jb-tekst', tekst: x.sporsmal }),
      ),
      h.el(
        'span',
        { class: 'jb-meta' },
        blokkEl(h, x.blokkerer),
        x.frist
          ? h.el('span', {
              class: `merke${x.frist_dager != null && x.frist_dager < 0 ? ' jb-forfalt' : ''}`,
              tekst: `◷ ${kortDato(x.frist)}`,
            })
          : null,
        h.el('span', { class: 'jb-post', tekst: x.post }),
      ),
      h.kopierKnapp(V.jurLinje(x, d), `Kopier startlinjen for ${x.id}`),
    );
  }

  function beslRadEl(h, d, x, valgt) {
    const erValgt = valgt?.id === x.id;
    const blokk = x.blokkerte_poster.length;
    return h.el(
      'li',
      { class: `jb-rad${erValgt ? ' valgt' : ''}${x.avklart ? ' avklart' : ''}` },
      radKnapp(
        h,
        'beslutn',
        x,
        erValgt,
        h.el('span', { class: 'planer-post-id', tekst: x.id }),
        h.el('span', { class: 'jb-tekst', tekst: x.tekst ?? '(spørsmålet mangler tekst i køen)' }),
      ),
      h.el(
        'span',
        { class: 'jb-meta' },
        h.el('span', { class: 'merke', tekst: V.BESL_TYPE[x.type] ?? x.type }),
        x.avklart
          ? h.el('span', { class: 'merke jb-besvart', tekst: `✓ Besvart ${kortDato(x.svar_tid)}` })
          : null,
        !x.avklart && x.haster
          ? h.el('span', {
              class: 'merke jb-forfalt',
              tekst: `! ${fristTekst(x.frist, x.frist_dager)}`,
            })
          : null,
        !x.avklart && blokk
          ? h.el('span', { class: 'merke', tekst: `▣ ${blokk} ${blokk === 1 ? 'post' : 'poster'}` })
          : null,
        !x.avklart && x.minutter
          ? h.el('span', { class: 'merke', tekst: `◷ ${x.minutter} min i kø` })
          : null,
        !x.avklart && x.dager_apen != null
          ? h.el('span', { class: 'jb-alder', tekst: `åpen i ${x.dager_apen} d` })
          : null,
      ),
      h.kopierKnapp(V.eierLinje(x, d), `Kopier startlinjen for ${x.id}`),
    );
  }

  // ---- Juridisk: personvern per modul og juristpakken ----
  function personvernEl(h, d) {
    const rader = d.personvern ?? [];
    if (!rader.length) return null;
    const apen = h.fasettApen('jur-pv', ['jur-pv']);
    const navn = (ider) => (ider.length ? ider.join(', ') : '·');
    return h.el(
      'details',
      {
        class: 'dok-maa jb-pv',
        open: apen,
        ontoggle: (e) => h.settFasettApen('jur-pv', e.target.open),
      },
      h.el(
        'summary',
        { class: 'dok-seksjon-tittel', 'data-fokus': 'jur-pv' },
        'Personvern per modul',
      ),
      h.el(
        'div',
        { class: 'dok-tabell-ramme' },
        h.el(
          'table',
          { class: 'dok-tabell' },
          h.el('caption', { class: 'skjult-for-oyet', tekst: 'Personvernstatus per modul' }),
          h.el(
            'thead',
            {},
            h.el(
              'tr',
              {},
              ...[
                'Modul',
                'Art. 9-flater',
                'DPIA trengs',
                'DPIA ikke vurdert',
                'DPIA finnes',
                'DPA må endres',
              ].map((k) => h.el('th', { scope: 'col', tekst: k })),
            ),
          ),
          h.el(
            'tbody',
            {},
            ...rader.map((r) =>
              h.el(
                'tr',
                {},
                h.el('th', { scope: 'row', tekst: modulNavn(d, r.modul) }),
                h.el('td', { tekst: `${r.art9.length}` }),
                h.el('td', {
                  class: r.dpia.trengs.length ? 'dok-forfalt' : null,
                  tekst: r.dpia.trengs.length ? `! ${navn(r.dpia.trengs)}` : '·',
                }),
                h.el('td', {
                  class: r.dpia.uvurdert.length ? 'dok-snart' : null,
                  tekst: r.dpia.uvurdert.length ? `? ${navn(r.dpia.uvurdert)}` : '·',
                }),
                h.el('td', { tekst: navn(r.dpia.finnes) }),
                h.el('td', { tekst: navn(r.dpa_endring) }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  async function forhandsvisPakke(h) {
    u.pakkeHenter = true;
    h.tegn();
    try {
      const r = await post('/api/juristpakke', { torr: true });
      if (r.status !== 200 || !r.svar?.ok) throw new Error(r.svar?.melding ?? `HTTP ${r.status}`);
      u.pakke = r.svar;
    } catch (e) {
      h.melding(`Fikk ikke laget juristpakken: ${e.message}`, true);
    } finally {
      u.pakkeHenter = false;
    }
    h.tegn({ fokus: 'jur-pakke-lagre' });
  }

  async function lagrePakke(h, erstatt = false) {
    u.pakkeHenter = true;
    h.tegn();
    try {
      const r = await post('/api/juristpakke', erstatt ? { erstatt: true } : {});
      if (r.status === 409 && r.svar?.bekreft) {
        u.pakke = { ...u.pakke, maaBekrefte: r.svar.melding };
      } else if (r.status !== 200 || !r.svar?.ok) {
        throw new Error(r.svar?.melding ?? `HTTP ${r.status}`);
      } else {
        h.melding(r.svar.melding);
        u.pakke = null;
      }
    } catch (e) {
      h.melding(`Fikk ikke lagret juristpakken: ${e.message}`, true);
    } finally {
      u.pakkeHenter = false;
    }
    h.tegn({ fokus: 'jur-pakke' });
  }

  function juristpakkeEl(h, d) {
    const tilJurist = (d.jur_punkter ?? []).filter((x) => x.status === 'til-jurist').length;
    const p = u.pakke;
    return h.el(
      'section',
      { class: 'jb-pakke', 'aria-label': 'Juristpakke' },
      h.el(
        'div',
        { class: 'jb-pakke-hode' },
        h.el(
          'p',
          {},
          h.el('strong', { tekst: 'Juristpakke. ' }),
          `${tilJurist} ${tilJurist === 1 ? 'punkt' : 'punkter'} står til jurist. Utkastet lagres lokalt i datamappa og sendes aldri.`,
        ),
        h.el('button', {
          type: 'button',
          class: 'knapp knapp-kontur',
          tekst: u.pakkeHenter ? 'Lager …' : p ? 'Lag på nytt' : 'Forhåndsvis juristpakke',
          disabled: u.pakkeHenter || !tilJurist,
          'data-fokus': 'jur-pakke',
          onclick: () => forhandsvisPakke(h),
        }),
      ),
      p
        ? h.el(
            'div',
            { class: 'jb-pakke-vis' },
            h.el('p', {
              class: 'planer-hjelp',
              tekst: p.finnes
                ? p.lik
                  ? `${p.sti} finnes alt med akkurat dette innholdet.`
                  : `${p.sti} finnes alt med annet innhold. Lagring erstatter den (du blir spurt).`
                : `Lagres som ${p.sti}.`,
            }),
            h.el('pre', { class: 'jb-pakke-tekst', tabindex: '0', tekst: p.tekst }),
            p.maaBekrefte
              ? h.el(
                  'div',
                  { class: 'planer-kontroll', role: 'alert' },
                  h.el('p', { tekst: p.maaBekrefte }),
                  h.el('button', {
                    type: 'button',
                    class: 'knapp knapp-fylt',
                    tekst: 'Erstatt fila',
                    'data-fokus': 'jur-pakke-erstatt',
                    onclick: () => lagrePakke(h, true),
                  }),
                )
              : null,
            h.el(
              'div',
              { class: 'planer-handlinger' },
              h.el('button', {
                type: 'button',
                class: 'knapp knapp-fylt',
                tekst: 'Lagre utkastet',
                disabled: u.pakkeHenter || p.lik,
                'data-fokus': 'jur-pakke-lagre',
                onclick: () => lagrePakke(h),
              }),
              h.el('button', {
                type: 'button',
                class: 'knapp knapp-kontur',
                tekst: 'Lukk',
                onclick: () => {
                  u.pakke = null;
                  h.tegn({ fokus: 'jur-pakke' });
                },
              }),
            ),
          )
        : null,
    );
  }

  // ---- Høyre: detaljpanelene ----
  function tomDetalj(h, tekst) {
    return h.el(
      'aside',
      { class: 'planer-detalj tom-detalj', 'aria-label': 'Detaljpanelet' },
      h.el('p', { class: 'tom', tekst }),
    );
  }

  function tilbake(h, flate) {
    return h.el('button', {
      type: 'button',
      class: 'knapp-liten knapp-kontur planer-tilbake',
      tekst: 'Tilbake til listen',
      onclick: () => h.bruk({ [valgNokkel(flate)]: null }),
    });
  }

  function jurDetaljEl(h, d, x) {
    const t = h.tilstand();
    if (!x)
      return tomDetalj(
        h,
        t.jur ? `Fant ikke punktet ${t.jur}.` : 'Velg et juridisk punkt for å se detaljene.',
      );
    const linje = V.jurLinje(x, d);
    const pv = x.personvern;
    return h.el(
      'aside',
      { class: 'planer-detalj', 'aria-label': `Detaljer for ${x.id}`, 'data-rull': 'jur-detalj' },
      tilbake(h, 'jur'),
      h.el(
        'header',
        { class: 'planer-detalj-hode' },
        h.el('p', { class: 'planer-detalj-id', tekst: x.id }),
        h.el('h2', { class: 'planer-detalj-tittel', tekst: x.sporsmal }),
        h.el(
          'p',
          { class: 'planer-detalj-merker' },
          statusEl(h, x.status),
          blokkEl(h, x.blokkerer),
          x.frist
            ? h.el('span', { class: 'merke', tekst: fristTekst(x.frist, x.frist_dager) })
            : null,
        ),
        h.el(
          'div',
          { class: 'planer-handlinger' },
          h.el('button', {
            type: 'button',
            class: 'knapp knapp-fylt',
            tekst: 'Kopier startlinje',
            title: linje,
            'data-fokus': 'jur-kopier',
            onclick: () => h.kopier(linje),
          }),
        ),
      ),
      h.el(
        'dl',
        { class: 'planer-felt' },
        h.felt('Plan', postKnapp(h, x.post, x.post_tittel, 'jur-post')),
        h.felt('Modul', modulNavn(d, x.modul)),
        h.felt('Prosjekt', x.prosjekt),
        h.felt('Berører', x.berorer.join('; ')),
        h.felt(
          'Personvern',
          pv
            ? [
                pv.art9 ? 'art. 9-opplysninger' : 'ikke art. 9',
                V.DPIA_TEKST[pv.dpia ?? 'uvurdert'],
                pv.dpa_endring ? 'DPA må endres' : null,
              ]
                .filter(Boolean)
                .join(', ')
            : null,
        ),
      ),
      seksjon(
        h,
        'KI-vurdering',
        h.el('p', {
          class: x.ki_vurdering ? null : 'tom',
          tekst:
            x.ki_vurdering ?? 'Ingen KI-vurdering ennå. Juridisk QA med KI kommer før juristen.',
        }),
      ),
      x.jurist
        ? seksjon(
            h,
            'Juristens svar',
            h.el('p', { tekst: x.jurist.svar ?? '' }),
            h.el('p', {
              class: 'planer-hjelp',
              tekst: [x.jurist.dato ? kortDato(x.jurist.dato) : null, x.jurist.kilde ?? null]
                .filter(Boolean)
                .join(' · '),
            }),
          )
        : null,
      x.kilder.length
        ? seksjon(
            h,
            'Plan-lenker',
            h.liste(
              x.kilder.map((k) =>
                h.el('li', { tekst: `${k.sti}${k.anker ? ` (${k.anker})` : ''}` }),
              ),
              'Ingen kilder.',
            ),
          )
        : null,
      h.el('p', {
        class: 'planer-hjelp',
        tekst: `Endres med ko.mjs plan endre ${x.post} --sett '{"juridisk":…}' (hele feltet), eller med startlinjen over.`,
      }),
    );
  }

  async function sendSvar(h, x, bekreft = false) {
    const tekst = u.utkast.get(x.id) ?? '';
    const r0 = V.avklarKropp(x.id, tekst, { bekreft });
    if (r0.feil) {
      h.melding(r0.feil, true);
      return;
    }
    u.sender = true;
    h.tegn();
    try {
      const r = await post('/api/handling', r0.kropp);
      if (r.status === 409 && r.svar?.bekreft) {
        u.bekreft = { sp: x.id, melding: r.svar.melding };
      } else if (r.status !== 200 || !r.svar?.ok) {
        throw new Error(r.svar?.melding ?? `HTTP ${r.status}`);
      } else {
        u.utkast.delete(x.id);
        u.bekreft = null;
        h.melding(`Svaret på ${x.id} er lagret.`);
        await h.hent(true);
      }
    } catch (e) {
      h.melding(`Fikk ikke lagret svaret: ${e.message}`, true);
    } finally {
      u.sender = false;
    }
    h.tegn({ fokus: `besl-svar:${x.id}` });
  }

  function beslDetaljEl(h, d, x) {
    const t = h.tilstand();
    if (!x)
      return tomDetalj(
        h,
        t.sp
          ? `Fant ikke spørsmålet ${t.sp}.`
          : 'Velg et eierspørsmål for å se detaljene og svare.',
      );
    const linje = V.eierLinje(x, d);
    const postTittel = (id) => (d.poster ?? []).find((p) => p.id === id)?.tittel ?? null;
    const indirekte = x.blokkerte_poster.filter((id) => !x.poster.includes(id));
    return h.el(
      'aside',
      { class: 'planer-detalj', 'aria-label': `Detaljer for ${x.id}`, 'data-rull': 'besl-detalj' },
      tilbake(h, 'beslutn'),
      h.el(
        'header',
        { class: 'planer-detalj-hode' },
        h.el('p', { class: 'planer-detalj-id', tekst: x.id }),
        h.el('h2', { class: 'planer-detalj-tittel', tekst: x.tekst ?? '(mangler tekst i køen)' }),
        h.el(
          'p',
          { class: 'planer-detalj-merker' },
          h.el('span', { class: 'merke', tekst: V.BESL_TYPE[x.type] ?? x.type }),
          h.el('span', {
            class: `merke${x.avklart ? ' jb-besvart' : ''}`,
            tekst: x.avklart ? '✓ Besvart' : '○ Åpent',
          }),
          x.frist
            ? h.el('span', {
                class: `merke${x.haster ? ' jb-forfalt' : ''}`,
                tekst: fristTekst(x.frist, x.frist_dager),
              })
            : null,
        ),
        h.el(
          'div',
          { class: 'planer-handlinger' },
          h.el('button', {
            type: 'button',
            class: 'knapp knapp-kontur',
            tekst: 'Kopier startlinje',
            title: linje,
            'data-fokus': 'besl-kopier',
            onclick: () => h.kopier(linje),
          }),
        ),
      ),
      h.el(
        'dl',
        { class: 'planer-felt' },
        h.felt('Anbefaling', x.anbefaling),
        h.felt('Kilde', x.kilde),
        h.felt(
          'Lagt til',
          x.lagt_til ? `${kortDato(x.lagt_til)} (${x.dager_apen} dager siden)` : null,
        ),
        h.felt('Moduler', x.moduler.map((m) => modulNavn(d, m)).join(', ')),
        h.felt('Prosjekter', x.prosjekter.join(', ')),
      ),
      seksjon(
        h,
        'Blokkerer',
        h.liste(
          [
            ...x.poster.map((id) =>
              h.el('li', {}, postKnapp(h, id, postTittel(id), `besl-post:${id}`)),
            ),
            ...indirekte.map((id) =>
              h.el(
                'li',
                {},
                postKnapp(h, id, postTittel(id), `besl-post:${id}`),
                h.el('span', { class: 'planer-hjelp', tekst: ' (avhenger av en post over)' }),
              ),
            ),
            ...x.oppgaver.map((id) =>
              h.el(
                'li',
                {},
                h.el('button', {
                  type: 'button',
                  class: 'lenke-knapp',
                  tekst: `Køoppgave ${id}`,
                  onclick: () => {
                    h.bruk({ rom: 'ko' });
                    window.KoTavle?.visOppgave?.(id);
                  },
                }),
              ),
            ),
          ],
          'Ingen planposter eller køoppgaver venter på dette.',
        ),
        x.minutter
          ? h.el('p', { class: 'planer-hjelp', tekst: `${x.minutter} minutter køarbeid venter.` })
          : null,
      ),
      x.avklart ? svarHistorikk(h, x) : svarSkjema(h, x),
    );
  }

  function svarHistorikk(h, x) {
    return seksjon(
      h,
      'Svar',
      h.el('p', { tekst: x.svar ?? '(svaret står ikke i køen)' }),
      h.el('p', {
        class: 'planer-hjelp',
        tekst: [x.svar_tid ? kortDato(x.svar_tid) : null, x.svar_av ? `av ${x.svar_av}` : null]
          .filter(Boolean)
          .join(' '),
      }),
    );
  }

  function svarSkjema(h, x) {
    const id = `besl-svar-${x.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const venter = u.bekreft?.sp === x.id ? u.bekreft : null;
    return seksjon(
      h,
      'Svar',
      h.el('label', {
        for: id,
        class: 'planer-hjelp',
        tekst: 'Svaret lagres med ko.mjs avklar og logges i beslutningsloggen.',
      }),
      (() => {
        const ta = h.el('textarea', {
          id,
          class: 'jb-svar',
          rows: '4',
          maxlength: '4000',
          'data-fokus': `besl-svar:${x.id}`,
          oninput: (e) => {
            u.utkast.set(x.id, e.target.value);
            if (u.bekreft?.sp === x.id) u.bekreft = null;
          },
        });
        // Utkastet overlever at rommet tegnes på nytt (oppdatering fra serveren hvert 15. sekund).
        ta.value = u.utkast.get(x.id) ?? '';
        return ta;
      })(),
      venter
        ? h.el(
            'div',
            { class: 'planer-kontroll', role: 'alert' },
            h.el('p', { tekst: venter.melding }),
            h.el('button', {
              type: 'button',
              class: 'knapp knapp-fylt',
              tekst: 'Svar likevel',
              disabled: u.sender,
              'data-fokus': `besl-likevel:${x.id}`,
              onclick: () => sendSvar(h, x, true),
            }),
          )
        : null,
      h.el(
        'div',
        { class: 'planer-handlinger' },
        h.el('button', {
          type: 'button',
          class: 'knapp knapp-fylt',
          tekst: u.sender ? 'Lagrer …' : 'Svar',
          disabled: u.sender,
          'data-fokus': `besl-send:${x.id}`,
          onclick: () => sendSvar(h, x),
        }),
        x.anbefaling
          ? h.el('button', {
              type: 'button',
              class: 'knapp knapp-kontur',
              tekst: 'Bruk anbefalingen',
              onclick: () => {
                u.utkast.set(x.id, x.anbefaling);
                h.tegn({ fokus: `besl-svar:${x.id}` });
              },
            })
          : null,
      ),
    );
  }

  // ---- Lansering ----
  function lanseringEl(h, d) {
    const l = d.lansering ?? null;
    const gaa = (endring) => h.bruk(endring, { push: true, rull: true });
    const blokk = (tittel, n, innhold, tom) =>
      h.el(
        'section',
        { class: 'jb-lansering-del' },
        h.el('h3', { class: 'planer-rute-tittel', tekst: `${tittel} (${n})` }),
        n ? innhold : h.el('p', { class: 'dok-alt-ok', tekst: `✓ ${tom}` }),
      );
    if (!l)
      return h.el(
        'section',
        { class: 'planer-midt' },
        h.el('p', { class: 'tom', tekst: 'Ingen data.' }),
      );
    const igjen = l.poster.filter((p) => !p.ferdig).length;
    return h.el(
      'section',
      {
        class: 'planer-midt jb-lansering',
        'aria-label': 'Lanseringsoversikten',
        'data-rull': 'lansering',
      },
      h.el(
        'header',
        { class: 'jb-lansering-hode' },
        h.el('h2', {
          class: 'planer-detalj-tittel',
          tekst: 'Hva står mellom oss og første betalende kunde?',
        }),
        h.el('p', {
          role: 'status',
          tekst: l.gjenstaar
            ? `${l.gjenstaar} ting gjenstår: ${igjen} av ${l.poster.length} poster før prod, ${l.juridisk.length} juridiske punkter, ${l.handlinger.length} eierhandlinger, ${l.beslutninger.length} eierspørsmål og ${l.dokumenter.length} dokumenter.`
            : '✓ Ingenting står i veien slik registeret ser det nå.',
        }),
      ),
      blokk(
        'Poster før prod',
        l.poster.length,
        h.el(
          'ul',
          { class: 'jb-liste' },
          ...l.poster.map((p) =>
            h.el(
              'li',
              { class: `jb-rad${p.ferdig ? ' avklart' : ''}` },
              h.el('span', {
                class: 'jb-sjekk',
                'aria-hidden': 'true',
                tekst: p.ferdig ? '✓' : '○',
              }),
              postKnapp(h, p.id, p.tittel, `lans-post:${p.id}`),
              h.el(
                'span',
                { class: 'jb-meta' },
                h.el('span', {
                  class: 'merke',
                  tekst: `${p.ferdig ? 'Ferdig' : 'Gjenstår'}: ${V.MODENHET?.[p.modenhet]?.tekst ?? p.modenhet}${p.brok ? ` ${p.brok}` : ''}`,
                }),
                p.frist ? h.el('span', { class: 'merke', tekst: `◷ ${kortDato(p.frist)}` }) : null,
                h.el('span', { class: 'jb-post', tekst: modulNavn(d, p.modul) }),
              ),
            ),
          ),
        ),
        'Ingen poster er merket Nå, før prod.',
      ),
      blokk(
        'Juridiske punkter som blokkerer prod',
        l.juridisk.length,
        h.el(
          'ul',
          { class: 'jb-liste' },
          ...l.juridisk.map((x) =>
            h.el(
              'li',
              { class: 'jb-rad' },
              h.el('button', {
                type: 'button',
                class: 'lenke-knapp',
                tekst: `${x.id} ${x.sporsmal}`,
                'data-fokus': `lans-jur:${x.id}`,
                onclick: () => gaa({ flate: 'jur', jur: x.id }),
              }),
              h.el(
                'span',
                { class: 'jb-meta' },
                statusEl(h, x.status),
                h.el('span', { class: 'jb-post', tekst: x.post }),
              ),
            ),
          ),
        ),
        'Ingen åpne juridiske punkter blokkerer prod.',
      ),
      blokk(
        'Eierhandlinger',
        l.handlinger.length,
        beslListe(h, l.handlinger, gaa),
        'Ingen åpne eierhandlinger.',
      ),
      blokk(
        'Eierspørsmål på poster før prod',
        l.beslutninger.length,
        beslListe(h, l.beslutninger, gaa),
        'Ingen åpne eierspørsmål på postene før prod.',
      ),
      blokk(
        'Dokumenter før prod som må gjøres noe med',
        l.dokumenter.length,
        h.el(
          'ul',
          { class: 'dok-maa-liste' },
          ...l.dokumenter.map((m) =>
            h.el(
              'li',
              {},
              h.el('button', {
                type: 'button',
                class: 'lenke-knapp',
                tekst: `${m.id} ${m.tittel}`,
                'data-fokus': `lans-dok:${m.id}`,
                onclick: () => gaa({ flate: 'dok', dok: m.id }),
              }),
              h.el('span', {
                class: 'dok-maa-grunner',
                tekst: m.grunner.map((g) => g.tekst).join(' · '),
              }),
            ),
          ),
        ),
        'Ingen dokumenter før prod har noe som må gjøres.',
      ),
    );
  }

  function beslListe(h, liste, gaa) {
    return h.el(
      'ul',
      { class: 'jb-liste' },
      ...liste.map((x) =>
        h.el(
          'li',
          { class: 'jb-rad' },
          h.el('button', {
            type: 'button',
            class: 'lenke-knapp',
            tekst: `${x.id} ${x.tekst ?? ''}`,
            'data-fokus': `lans-sp:${x.id}`,
            onclick: () => gaa({ flate: 'beslutn', sp: x.id }),
          }),
          h.el(
            'span',
            { class: 'jb-meta' },
            x.frist
              ? h.el('span', {
                  class: `merke${x.haster ? ' jb-forfalt' : ''}`,
                  tekst: fristTekst(x.frist, x.frist_dager),
                })
              : null,
            x.blokkerte_poster.length
              ? h.el('span', { class: 'merke', tekst: `▣ ${x.blokkerte_poster.length} poster` })
              : null,
          ),
        ),
      ),
    );
  }

  window.KoPlanJur = { ruter, harValgt, lanseringIder };
})();
