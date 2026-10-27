// =============================================================
// arbeid.js: effektivt arbeid i Planer-rommet (se docs/board.md).
// Vanilla JS, ingen byggesteg, ingen CDN. All tekst settes med textContent (via h.el), aldri innerHTML.
//
//   - Tastatur i listen: j og k flytter, Enter åpner panelet, / hopper til søket, 1 til 4 setter prioritet (Nå,
//     Senere, Eier, Dropp; Nå spør om kategori og Dropp om grunn i menyen i raden), c kopierer startlinjen (for alle
//     valgte når noe er valgt), x merker raden for flervalg, Esc tømmer valget.
//   - Ctrl+K (Cmd+K): kommandolinja. Hopper til modul, prosjekt eller post (treffene viser brødsmulestien, nylig brukte
//     står øverst) og kjører handlinger som «Kopier startlinje for alle valgte» og «Klargjør for kø».
//   - Flervalg: handlingslinja nederst (prioritet, prosjekt, modenhet, sammenslåing og kopiering) med forhåndsvisning
//     før lagring, og «Angre» etterpå (POST /api/plan-masse og /api/plan-angre; ko.mjs gjør skrivingen med samme lås,
//     --forvent-endret og endringslogg som køen).
//   - Menyen i raden: prioritet og modenhet for én post, lagret med --forvent-endret og med «Angre».
//   - «Endret av økt»: poster en Claude Code-økt har endret, får en kort markering når live oppdateringen henter dem.
// Reglene (tastene, naboposten, kommandolinjas treff, kallene og angringen) er de rene funksjonene i
// koPlanVisning.js; her er bare tegningen og samspillet. `h` er hjelperne fra planer.js (arbeidHjelp).
// =============================================================
'use strict';

(function () {
  const V = window.KoPlanVisning;
  const NOKKEL = 'ko-tavle-nokkel'; // samme som tavle.js (sessionStorage)
  const NYLIGE_LAGRING = 'ko-tavle-planer-nylige';
  const ENDRET_MS = 12_000; // så lenge «endret av økt» står

  const a = {
    h: null,
    merket: new Set(),
    endret: new Map(), // post-id → { av, til }
    meny: null, // { id, modus: 'hoved' | 'dropp' }
    grunn: '',
    masse: {
      handling: 'prioritet',
      prioritet: 'naa',
      kategori: 'viktig',
      grunn: '',
      prosjekt: '',
      modenhet: 'klar',
      til: '',
    },
    forhand: null,
    lagrer: false,
    siste: null, // { logg: number[], tekst } for «Angre»
    palett: { apen: false, sok: '', valgt: 0, treff: [], tilbake: null },
    nylige: lesNylige(),
  };

  function lesNylige() {
    try {
      const x = JSON.parse(localStorage.getItem(NYLIGE_LAGRING) ?? '[]');
      return V.leggTilNylig(Array.isArray(x) ? x : [], null);
    } catch {
      return [];
    }
  }
  function lagreNylige() {
    try {
      localStorage.setItem(NYLIGE_LAGRING, JSON.stringify(a.nylige));
    } catch {
      /* privat modus: gjelder bare denne økta */
    }
  }

  /** Er elementet et sted man skriver (der bokstavtastene skal skrive, ikke styre)? */
  function skrivefelt(e) {
    if (!e) return false;
    if (e.isContentEditable) return true;
    const tag = e.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(e.type);
  }

  // ---- Skrivekallene ----
  async function post(sti, kropp) {
    const nokkel = sessionStorage.getItem(NOKKEL) ?? '';
    const res = await fetch(sti, {
      method: 'POST',
      headers: { 'X-Ko-Nokkel': nokkel, 'Content-Type': 'application/json' },
      body: JSON.stringify(kropp),
    });
    let svar = null;
    try {
      svar = await res.json();
    } catch {
      svar = null;
    }
    if (!res.ok) throw new Error(svar?.melding ?? `HTTP ${res.status}`);
    return svar;
  }

  /** Én endring rett fra raden eller tastene: lagres med --forvent-endret mot registeret du ser, og kan angres. */
  async function lagreDirekte(h, kropp) {
    const d = h.data();
    try {
      const svar = await post('/api/plan-masse', { ...kropp, forvent: d?.endret ?? null });
      a.siste = { logg: svar.logg ?? [], tekst: svar.melding ?? 'Lagret.' };
      h.melding(svar.melding ?? 'Lagret.');
    } catch (e) {
      h.melding(e.message, true);
    }
    await h.hent(true);
    h.tegn();
  }

  async function angre(h) {
    if (!a.siste?.logg?.length) return;
    try {
      const svar = await post('/api/plan-angre', { nr: a.siste.logg });
      h.melding(svar.melding ?? 'Angret.');
      a.siste = null;
    } catch (e) {
      h.melding(`Kunne ikke angre: ${e.message}`, true);
    }
    await h.hent(true);
    h.tegn({ fokus: 'valg-handling' });
  }

  // ---- Flervalget ----
  /** De merkede postene i listens rekkefølge (de som ikke finnes lenger, tas ut). */
  function merkede(h) {
    const d = h.data();
    const finnes = new Set((d?.poster ?? []).map((p) => p.id));
    for (const id of [...a.merket]) if (!finnes.has(id)) a.merket.delete(id);
    const orden = (d?.poster ?? []).map((p) => p.id);
    return orden.filter((id) => a.merket.has(id));
  }

  function veksleMerket(h, id, fokus) {
    if (a.merket.has(id)) a.merket.delete(id);
    else a.merket.add(id);
    a.forhand = null;
    h.tegn({ fokus });
  }

  function tomValg(h) {
    a.merket.clear();
    a.forhand = null;
    h.tegn();
  }

  function masseKropp(h) {
    const m = a.masse;
    const ider = merkede(h);
    if (m.handling === 'prioritet')
      return {
        handling: 'prioritet',
        ider,
        prioritet: m.prioritet,
        kategori: m.prioritet === 'naa' ? m.kategori : null,
        grunn: m.prioritet === 'dropp' ? m.grunn : null,
      };
    if (m.handling === 'prosjekt')
      return { handling: 'prosjekt', ider, prosjekt: m.prosjekt || null };
    if (m.handling === 'modenhet') return { handling: 'modenhet', ider, modenhet: m.modenhet };
    return { handling: 'slaa-sammen', ider, til: ider.includes(m.til) ? m.til : (ider[0] ?? '') };
  }

  async function forhandsvis(h) {
    const kropp = masseKropp(h);
    a.forhand = { laster: true };
    h.tegn();
    try {
      a.forhand = {
        ...(await post('/api/plan-masse', { ...kropp, torr: true })),
        kropp: JSON.stringify(kropp),
      };
    } catch (e) {
      a.forhand = { endringer: [], advarsler: [], feil: [e.message], kan: false };
    }
    h.tegn({ fokus: 'valg-forhand' });
  }

  async function lagreMasse(h) {
    const kropp = masseKropp(h);
    if (!a.forhand?.kan || a.lagrer || a.forhand.kropp !== JSON.stringify(kropp)) return;
    a.lagrer = true;
    h.tegn();
    try {
      const svar = await post('/api/plan-masse', { ...kropp, forvent: a.forhand.endret ?? null });
      a.siste = { logg: svar.logg ?? [], tekst: svar.melding ?? 'Lagret.' };
      a.forhand = null;
      h.melding(svar.melding ?? 'Lagret.');
    } catch (e) {
      a.forhand = { endringer: [], advarsler: [], feil: [e.message], kan: false };
      h.melding(e.message, true);
    } finally {
      a.lagrer = false;
    }
    await h.hent(true);
    h.tegn({ fokus: 'valg-angre' });
  }

  function kopierValgte(h) {
    const d = h.data();
    const ider = merkede(h);
    const t = h.tilstand();
    const liste = ider.length ? ider : t.post ? [t.post] : [];
    if (!liste.length) {
      h.melding('Velg en post eller merk flere med x først.', true);
      return;
    }
    h.kopier(V.startlinjer(liste, d));
  }

  /** Et lite valg (select) med etikett. */
  function valg(h, etikett, verdi, alternativer, endre, fokus) {
    return h.el(
      'label',
      { class: 'planer-valg-felt' },
      h.el('span', { class: 'planer-valg-etikett', tekst: etikett }),
      h.el(
        'select',
        {
          'data-fokus': fokus,
          onchange: (e) => {
            endre(e.target.value);
            a.forhand = null;
            h.tegn({ fokus });
          },
        },
        ...alternativer.map(([v, tekst]) =>
          h.el('option', { value: v, selected: v === verdi ? true : null, tekst }),
        ),
      ),
    );
  }

  function verdiTekst(x) {
    if (x == null) return 'ingen';
    if (typeof x === 'string') return x;
    if (Array.isArray(x)) return x.join(', ') || 'ingen';
    return x.tittel ?? x.id ?? 'posten';
  }

  function forhandEl(h) {
    const f = a.forhand;
    if (!f) return null;
    if (f.laster)
      return h.el('p', { class: 'kart-forhand-tekst', tekst: 'Henter forhåndsvisningen …' });
    return h.el(
      'div',
      {
        class: 'kart-forhand planer-valg-forhand',
        tabindex: '-1',
        'data-fokus': 'valg-forhand',
        role: 'region',
        'aria-label': 'Forhåndsvisningen',
      },
      h.el('h3', {
        class: 'kart-forhand-tittel',
        tekst: 'Forhåndsvisning (ingenting er lagret ennå)',
      }),
      (f.feil ?? []).length
        ? h.el(
            'ul',
            { class: 'kart-feil', role: 'alert' },
            ...f.feil.map((x) => h.el('li', { tekst: x })),
          )
        : null,
      (f.endringer ?? []).length
        ? h.el(
            'ul',
            { class: 'kart-skrives' },
            ...f.endringer.slice(0, 60).map((x) =>
              h.el('li', {
                tekst: `${x.id}: ${x.felt === '*' ? 'posten' : x.felt} ${verdiTekst(x.for)} → ${verdiTekst(x.etter)}`,
              }),
            ),
          )
        : f.kan
          ? h.el('p', { tekst: 'Ingenting endres.' })
          : null,
      (f.advarsler ?? []).length
        ? h.el(
            'ul',
            { class: 'kart-advarsler' },
            ...f.advarsler.map((x) => h.el('li', { tekst: `Advarsel: ${x}` })),
          )
        : null,
    );
  }

  function valglinje(h, d) {
    const ider = merkede(h);
    if (!ider.length && !a.siste) return null;
    const m = a.masse;
    const kropp = masseKropp(h);
    const utdatert = a.forhand && !a.forhand.laster && a.forhand.kropp !== JSON.stringify(kropp);
    const deler = [];
    if (ider.length) {
      deler.push(
        h.el('p', { class: 'valg-tall', tekst: `${ider.length} valgt` }),
        valg(
          h,
          'Endre',
          m.handling,
          [
            ['prioritet', 'Prioritet'],
            ['prosjekt', 'Prosjekt'],
            ['modenhet', 'Modenhet'],
            ['slaa-sammen', 'Slå sammen'],
          ],
          (v) => (m.handling = v),
          'valg-handling',
        ),
      );
      if (m.handling === 'prioritet') {
        deler.push(
          valg(
            h,
            'Til',
            m.prioritet,
            V.PRIORITETER.map((k) => [k, `${V.PRIORITET[k].symbol} ${V.PRIORITET[k].tekst}`]),
            (v) => (m.prioritet = v),
            'valg-pri',
          ),
        );
        if (m.prioritet === 'naa')
          deler.push(
            valg(
              h,
              'Kategori',
              m.kategori,
              Object.entries(V.KATEGORI),
              (v) => (m.kategori = v),
              'valg-kat',
            ),
          );
        if (m.prioritet === 'dropp')
          deler.push(
            h.el(
              'label',
              { class: 'planer-valg-felt' },
              h.el('span', { class: 'planer-valg-etikett', tekst: 'Grunn (én setning)' }),
              h.el('input', {
                type: 'text',
                maxlength: '500',
                value: m.grunn,
                'data-fokus': 'valg-grunn',
                'aria-invalid': m.grunn.trim() ? null : 'true',
                oninput: (e) => {
                  m.grunn = e.target.value;
                  a.forhand = null;
                },
                onchange: () => h.tegn({ fokus: 'valg-grunn' }),
              }),
            ),
          );
      } else if (m.handling === 'prosjekt') {
        const pr = Object.entries(d.prosjekter ?? {})
          .map(([pid, x]) => [pid, x.kort ?? pid])
          .sort((x, y) => x[1].localeCompare(y[1], 'nb'));
        deler.push(
          valg(
            h,
            'Til',
            m.prosjekt,
            [['', 'Uten prosjekt'], ...pr],
            (v) => (m.prosjekt = v),
            'valg-prosjekt',
          ),
        );
      } else if (m.handling === 'modenhet') {
        deler.push(
          valg(
            h,
            'Til',
            m.modenhet,
            V.MODENHET_MANUELL.map((k) => [k, V.MODENHET[k]]),
            (v) => (m.modenhet = v),
            'valg-mod',
          ),
        );
      } else {
        const til = ider.includes(m.til) ? m.til : ider[0];
        deler.push(
          valg(
            h,
            'Inn i',
            til,
            ider.map((id) => [id, id]),
            (v) => (m.til = v),
            'valg-til',
          ),
        );
      }
      deler.push(
        h.el('button', {
          type: 'button',
          class: 'knapp knapp-tonet',
          tekst: 'Forhåndsvis',
          'data-fokus': 'valg-forhandsvis',
          disabled: a.forhand?.laster || a.lagrer ? true : null,
          onclick: () => forhandsvis(h),
        }),
        h.el('button', {
          type: 'button',
          class: 'knapp knapp-fylt',
          tekst: a.lagrer ? 'Lagrer …' : 'Lagre',
          'data-fokus': 'valg-lagre',
          disabled: !a.forhand?.kan || utdatert || a.lagrer ? true : null,
          title: a.forhand?.kan && !utdatert ? null : 'Forhåndsvis først',
          onclick: () => lagreMasse(h),
        }),
        h.el('button', {
          type: 'button',
          class: 'knapp knapp-kontur',
          tekst: 'Kopier startlinjer',
          onclick: () => kopierValgte(h),
        }),
        h.el('button', {
          type: 'button',
          class: 'knapp knapp-kontur',
          tekst: 'Tøm valg',
          onclick: () => tomValg(h),
        }),
      );
    }
    if (a.siste)
      deler.push(
        h.el(
          'p',
          { class: 'planer-valg-siste', role: 'status' },
          a.siste.tekst,
          ' ',
          a.siste.logg.length
            ? h.el('button', {
                type: 'button',
                class: 'knapp-liten knapp-kontur',
                tekst: 'Angre',
                'data-fokus': 'valg-angre',
                onclick: () => angre(h),
              })
            : null,
          h.el('button', {
            type: 'button',
            class: 'knapp-ikon',
            tekst: '✕',
            'aria-label': 'Skjul meldingen',
            onclick: () => {
              a.siste = null;
              h.tegn();
            },
          }),
        ),
      );
    return h.el(
      'section',
      { class: 'valglinje planer-valglinje', 'aria-label': 'Flervalg' },
      ...deler,
      utdatert
        ? h.el('p', { class: 'planer-valg-siste', tekst: 'Valget er endret: forhåndsvis på nytt.' })
        : null,
      utdatert ? null : forhandEl(h),
    );
  }

  // ---- Menyen i raden (prioritet og modenhet) ----
  function lukkMeny(h, fokus = true) {
    const id = a.meny?.id;
    a.meny = null;
    a.grunn = '';
    h.tegn({ fokus: fokus && id ? `radmeny:${id}` : null });
  }

  function aapneMeny(h, id, modus = 'hoved') {
    a.meny = { id, modus };
    a.grunn = '';
    h.tegn({ fokus: modus === 'dropp' ? `meny-grunn:${id}` : `meny:${id}:0` });
  }

  function velgPrioritet(h, p, prioritet, kategori) {
    a.meny = null;
    lagreDirekte(h, {
      handling: 'prioritet',
      ider: [p.id],
      prioritet,
      kategori: prioritet === 'naa' ? kategori : null,
      grunn: prioritet === 'dropp' ? a.grunn : null,
    });
  }

  function menyTast(h, e) {
    const knapper = [...e.currentTarget.querySelectorAll('[role="menuitem"]')];
    const i = knapper.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      lukkMeny(h);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && knapper.length) {
      e.preventDefault();
      const j =
        i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + knapper.length) % knapper.length;
      knapper[j].focus();
    } else if (e.key === 'Tab') {
      lukkMeny(h, false);
    }
  }

  function radMeny(h, p) {
    const apen = a.meny?.id === p.id;
    const knapp = h.el('button', {
      type: 'button',
      class: 'knapp-liten knapp-kontur planer-radmeny-knapp',
      tekst: 'Endre',
      'aria-haspopup': 'menu',
      'aria-expanded': apen ? 'true' : 'false',
      'aria-label': `Endre prioritet eller modenhet for ${p.id}`,
      'data-fokus': `radmeny:${p.id}`,
      onclick: (e) => {
        e.stopPropagation();
        if (apen) lukkMeny(h);
        else aapneMeny(h, p.id);
      },
    });
    if (!apen) return h.el('span', { class: 'planer-radmeny-plass' }, knapp);
    let n = 0;
    const punkt = (tekst, valgt, gjor, ekstra = {}) =>
      h.el('button', {
        type: 'button',
        role: 'menuitem',
        class: `planer-meny-punkt${valgt ? ' er-valgt' : ''}`,
        tekst: `${valgt ? '✓ ' : ''}${tekst}`,
        'data-fokus': `meny:${p.id}:${n++}`,
        onclick: (e) => {
          e.stopPropagation();
          gjor();
        },
        ...ekstra,
      });
    let innhold;
    if (a.meny.modus === 'dropp') {
      innhold = [
        h.el(
          'label',
          { class: 'planer-valg-felt' },
          h.el('span', {
            class: 'planer-valg-etikett',
            tekst: `Dropp ${p.id}: grunn (én setning)`,
          }),
          h.el('input', {
            type: 'text',
            maxlength: '500',
            value: a.grunn,
            'data-fokus': `meny-grunn:${p.id}`,
            oninput: (e) => (a.grunn = e.target.value),
            onkeydown: (e) => {
              if (e.key === 'Enter' && a.grunn.trim()) {
                e.preventDefault();
                velgPrioritet(h, p, 'dropp');
              }
            },
          }),
        ),
        punkt('Dropp med grunnen', false, () => {
          if (!a.grunn.trim()) h.melding('Dropp krever én setning som grunn.', true);
          else velgPrioritet(h, p, 'dropp');
        }),
        punkt('Avbryt', false, () => lukkMeny(h)),
      ];
    } else {
      const kat = p.prioritet === 'naa' ? (p.naa_kategori ?? []) : [];
      innhold = [
        h.el('p', { class: 'planer-meny-tittel', tekst: 'Prioritet' }),
        ...Object.entries(V.KATEGORI).map(([k, tekst]) =>
          punkt(`${V.PRIORITET.naa.symbol} Nå · ${tekst}`, kat.length === 1 && kat[0] === k, () =>
            velgPrioritet(h, p, 'naa', k),
          ),
        ),
        punkt(`${V.PRIORITET.eier.symbol} Eier`, p.prioritet === 'eier', () =>
          velgPrioritet(h, p, 'eier'),
        ),
        punkt(`${V.PRIORITET.senere.symbol} Senere`, p.prioritet === 'senere', () =>
          velgPrioritet(h, p, 'senere'),
        ),
        punkt(`${V.PRIORITET.dropp.symbol} Dropp …`, p.prioritet === 'dropp', () =>
          aapneMeny(h, p.id, 'dropp'),
        ),
        h.el('p', { class: 'planer-meny-tittel', tekst: 'Modenhet' }),
        ...V.MODENHET_MANUELL.map((k) =>
          punkt(V.MODENHET[k], p.modenhet_plan === k, () => {
            a.meny = null;
            lagreDirekte(h, { handling: 'modenhet', ider: [p.id], modenhet: k });
          }),
        ),
      ];
    }
    return h.el(
      'span',
      { class: 'planer-radmeny-plass' },
      knapp,
      h.el(
        'div',
        {
          class: 'planer-radmeny',
          role: 'menu',
          'aria-label': `Endre ${p.id}`,
          onkeydown: (e) => menyTast(h, e),
        },
        ...innhold,
      ),
    );
  }

  // ---- Kommandolinja (Ctrl+K) ----
  let palettEl = null;
  function byggPalett(h) {
    const sok = h.el('input', {
      type: 'text',
      class: 'planer-palett-sok',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'planer-palett-liste',
      'aria-autocomplete': 'list',
      'aria-label': 'Hopp til modul, prosjekt eller post, eller kjør en handling',
      placeholder: 'Hopp til modul, prosjekt, post eller handling',
      autocomplete: 'off',
      oninput: (e) => {
        a.palett.sok = e.target.value.slice(0, 120);
        a.palett.valgt = 0;
        tegnPalett(h);
      },
    });
    const liste = h.el('ul', {
      id: 'planer-palett-liste',
      class: 'planer-palett-liste',
      role: 'listbox',
    });
    const status = h.el('p', { class: 'skjult-for-oyet', 'aria-live': 'polite' });
    const boks = h.el(
      'div',
      {
        class: 'planer-palett-boks',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Kommandolinje',
        onkeydown: (e) => palettTast(h, e),
      },
      sok,
      liste,
      h.el('p', {
        class: 'planer-palett-hjelp',
        tekst: 'Pil opp og ned velger, Enter går, Esc lukker.',
      }),
      status,
    );
    palettEl = h.el(
      'div',
      {
        class: 'planer-palett',
        hidden: true,
        onclick: (e) => {
          if (e.target === palettEl) lukkPalett();
        },
      },
      boks,
    );
    palettEl._sok = sok;
    palettEl._liste = liste;
    palettEl._status = status;
    palettEl._boks = boks;
    document.body.append(palettEl);
  }

  function tegnPalett(h) {
    const d = h.data();
    a.palett.treff = d ? V.palettTreff(V.palettKandidater(d), a.palett.sok, a.nylige) : [];
    if (a.palett.valgt >= a.palett.treff.length)
      a.palett.valgt = Math.max(0, a.palett.treff.length - 1);
    const TYPE = { post: 'Post', prosjekt: 'Prosjekt', modul: 'Modul', handling: 'Handling' };
    palettEl._liste.replaceChildren(
      ...(d
        ? a.palett.treff.map((k, i) =>
            h.el(
              'li',
              {
                id: `planer-palett-${i}`,
                role: 'option',
                class: `planer-palett-treff${i === a.palett.valgt ? ' aktiv' : ''}`,
                'aria-selected': i === a.palett.valgt ? 'true' : 'false',
                onclick: () => kjor(h, k),
                onmousemove: () => {
                  if (a.palett.valgt !== i) {
                    a.palett.valgt = i;
                    tegnPalett(h);
                  }
                },
              },
              h.el('span', { class: 'merke', tekst: TYPE[k.type] ?? k.type }),
              h.el('span', { class: 'planer-palett-tekst', tekst: k.tekst }),
              h.el('span', { class: 'planer-palett-sti', tekst: k.sti }),
              k.nylig ? h.el('span', { class: 'planer-palett-nylig', tekst: 'nylig' }) : null,
              k.dropp ? h.el('span', { class: 'planer-palett-nylig', tekst: 'droppet' }) : null,
            ),
          )
        : [h.el('li', { class: 'tom', tekst: 'Henter planregisteret …' })]),
    );
    if (d && !a.palett.treff.length)
      palettEl._liste.append(h.el('li', { class: 'tom', tekst: 'Ingen treff.' }));
    palettEl._sok.setAttribute(
      'aria-activedescendant',
      a.palett.treff.length ? `planer-palett-${a.palett.valgt}` : '',
    );
    palettEl._status.textContent = `${a.palett.treff.length} treff`;
    palettEl._liste.querySelector('.aktiv')?.scrollIntoView({ block: 'nearest' });
  }

  function aapnePalett(h) {
    if (!palettEl) byggPalett(h);
    if (!h.data()) h.hent();
    a.palett = { apen: true, sok: '', valgt: 0, treff: [], tilbake: document.activeElement };
    palettEl.hidden = false;
    palettEl._sok.value = '';
    tegnPalett(h);
    palettEl._sok.focus();
  }

  function lukkPalett({ fokus = true } = {}) {
    if (!palettEl || !a.palett.apen) return;
    a.palett.apen = false;
    palettEl.hidden = true;
    const t = a.palett.tilbake;
    if (fokus && t && document.contains(t)) t.focus();
  }

  function palettTast(h, e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      lukkPalett();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = a.palett.treff.length;
      if (!n) return;
      a.palett.valgt = (a.palett.valgt + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      tegnPalett(h);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const k = a.palett.treff[a.palett.valgt];
      if (k) kjor(h, k);
    } else if (e.key === 'Tab') {
      window.KoUu?.fellaTast?.(e, palettEl._boks);
    }
  }

  /** Kjører et treff fra kommandolinja. */
  function kjor(h, k) {
    a.nylige = V.leggTilNylig(a.nylige, k.noekkel);
    lagreNylige();
    lukkPalett({ fokus: false });
    if (!h.erPlaner()) h.velgRom('planer');
    const d = h.data();
    if (k.type === 'post') {
      h.gaaTilPost(k.id);
      h.rom.querySelector(`[data-fokus="post:${CSS.escape(k.id)}"]`)?.focus();
      return;
    }
    if (k.type === 'modul' || k.type === 'prosjekt') {
      const f = V.tomtFilter();
      if (k.type === 'modul') f.modul = [k.id];
      else f.prosjekt = [k.id];
      h.gaaTilListe({ filter: f, sok: '', post: null });
      return;
    }
    const t = h.tilstand();
    const p = t.post ? h.postFor(t.post) : null;
    if (k.id === 'kopier-valgte') kopierValgte(h);
    else if (k.id === 'klargjor') {
      if (!p) {
        h.melding('Velg en post først (Klargjør for kø gjelder én post).', true);
        return;
      }
      const r = V.klargjor(p, d);
      h.kopier(r.linje);
      if (r.advarsler.length) h.melding(`${r.linje}\nMerk: ${r.advarsler.join(' ')}`, true);
    } else if (k.id === 'oversikt') h.bruk({ flate: 'oversikt' });
    else if (k.id === 'liste') h.bruk({ flate: 'poster', vis: 'liste' });
    else if (k.id === 'kart') h.bruk({ flate: 'poster', vis: 'kart' });
    else if (k.id === 'nullstill') h.nyttFilter(V.tomtFilter(), { sok: '' });
    else if (k.id === 'tom-valg') tomValg(h);
  }

  // ---- Tastaturet ----
  function fokuserPost(h, id) {
    h.rom.querySelector(`[data-fokus="post:${CSS.escape(id)}"]`)?.focus();
  }

  function tast(h, e) {
    const t = V.tastHandling(e, {
      skrivefelt: skrivefelt(document.activeElement),
      opptatt: a.palett.apen || !!a.meny,
    });
    if (!t) return;
    if (t.type === 'palett') {
      e.preventDefault();
      if (a.palett.apen) lukkPalett();
      else aapnePalett(h);
      return;
    }
    if (!h.erPlaner() || !h.data()) return;
    // Tastene virker i rommet (eller når ingenting har fokus), ikke i dialoger og toppen.
    const aktiv = document.activeElement;
    if (aktiv && aktiv !== document.body && !h.rom.contains(aktiv)) return;
    const tl = h.tilstand();
    if (t.type === 'avbryt') {
      if (a.merket.size) {
        e.preventDefault();
        tomValg(h);
      }
      return;
    }
    if (tl.flate !== 'poster' || tl.vis === 'kart') return;
    // Raden med fokus gjelder (ellers den valgte), så x og c virker der du står.
    const radId = aktiv?.closest?.('.planer-post[data-post]')?.dataset.post ?? tl.post;
    if (t.type === 'flytt') {
      e.preventDefault();
      const neste = V.naboPost(h.synligePoster(), radId, t.retning);
      if (!neste) return;
      h.velgPost(neste);
      fokuserPost(h, neste);
    } else if (t.type === 'aapne') {
      if (!radId) return;
      const paRad = aktiv?.classList?.contains('planer-post-knapp');
      if (!paRad && aktiv && aktiv !== document.body) return; // Enter på en annen knapp gjør det knappen gjør
      // På raden velger knappens eget klikk posten; her flyttes bare fokuset til panelet etterpå.
      if (!paRad && radId !== tl.post) h.velgPost(radId, { push: true });
      setTimeout(() => h.rom.querySelector('.planer-faner [aria-selected="true"]')?.focus(), 0);
    } else if (t.type === 'sok') {
      e.preventDefault();
      const f = h.rom.querySelector('[data-fokus="sok"]');
      f?.focus();
      f?.select?.();
    } else if (t.type === 'prioritet') {
      const p = radId ? h.postFor(radId) : null;
      if (!p) return;
      e.preventDefault();
      const r = V.prioritetFraTast(p, t.verdi);
      if (r.uendret)
        h.melding(`${p.id} har alt prioriteten ${V.PRIORITET[t.verdi]?.tekst ?? t.verdi}.`);
      else if (r.meny === 'naa') {
        if (radId !== tl.post) h.velgPost(radId);
        aapneMeny(h, p.id);
      } else if (r.meny === 'dropp') {
        if (radId !== tl.post) h.velgPost(radId);
        aapneMeny(h, p.id, 'dropp');
      } else lagreDirekte(h, { handling: 'prioritet', ...r.gruppe });
    } else if (t.type === 'kopier') {
      e.preventDefault();
      if (a.merket.size) kopierValgte(h);
      else if (radId && h.postFor(radId)) h.kopier(V.postLinje(h.postFor(radId), h.data()));
    } else if (t.type === 'merk') {
      if (!radId) return;
      e.preventDefault();
      if (a.merket.has(radId)) a.merket.delete(radId);
      else a.merket.add(radId);
      a.forhand = null;
      h.tegn({ fokus: `post:${radId}` });
    }
  }

  // ---- «Endret av økt» (live oppdatering) ----
  let endretTid = null;
  let varsle = null;
  function endret(liste) {
    if (!Array.isArray(liste) || !liste.length) return;
    const til = Date.now() + ENDRET_MS;
    for (const x of liste) a.endret.set(x.id, { av: x.av, til });
    if (varsle) {
      const ider = liste.map((x) => x.id);
      varsle.textContent =
        `${ider.length === 1 ? `${ider[0]} er` : `${ider.length} poster er`} endret av økt` +
        `${ider.length > 1 ? `: ${ider.slice(0, 5).join(', ')}${ider.length > 5 ? ' …' : ''}` : ''}.`;
    }
    clearTimeout(endretTid);
    endretTid = setTimeout(() => {
      const naa = Date.now();
      for (const [id, x] of [...a.endret]) if (x.til <= naa) a.endret.delete(id);
      if (a.h?.erPlaner() && !a.meny && !window.KoPlanKart?.opptatt()) a.h.tegn();
    }, ENDRET_MS + 200);
  }
  const erEndret = (id) => (a.endret.get(id)?.til ?? 0) > Date.now();

  window.KoPlanArbeid = {
    /** Kobler tastaturet og kommandolinja til planer.js sine hjelpere (én gang). */
    installer(h) {
      if (a.h) return;
      a.h = h;
      varsle = h.el('p', { class: 'skjult-for-oyet', 'aria-live': 'polite' });
      document.body.append(varsle);
      document.addEventListener('keydown', (e) => tast(h, e));
      // Et klikk utenfor menyen i raden lukker den.
      document.addEventListener('click', (e) => {
        if (a.meny && !e.target.closest?.('.planer-radmeny-plass')) lukkMeny(h, false);
      });
    },
    /** Sann mens menyen i en rad er åpen (da venter live oppdateringen med å tegne). */
    opptatt: () => !!a.meny,
    endret,
    radKlasser: (p) =>
      `${a.merket.has(p.id) ? ' merket' : ''}${erEndret(p.id) ? ' endret-av-okt' : ''}${p.aktiv ? ' under-arbeid' : ''}`,
    endretMerke: (p) =>
      erEndret(p.id)
        ? (a.h?.el ?? (() => null))('span', {
            class: 'merke planer-endret',
            tekst: 'endret av økt',
            title: a.endret.get(p.id)?.av ? `Endret av ${a.endret.get(p.id).av}` : null,
          })
        : null,
    merkEl: (h, p) =>
      h.el('input', {
        type: 'checkbox',
        class: 'planer-merk',
        checked: a.merket.has(p.id) ? true : null,
        'aria-label': `Merk ${p.id} for flervalg`,
        'data-fokus': `merk:${p.id}`,
        onchange: () => veksleMerket(h, p.id, `merk:${p.id}`),
      }),
    radMeny: (h, p) => radMeny(h, p),
    valglinje,
  };
})();
