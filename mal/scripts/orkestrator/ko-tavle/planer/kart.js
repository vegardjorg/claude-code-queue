// =============================================================
// kart.js: prioritetskartet og fristbåndet i Planer-rommet (se docs/board.md).
// Vanilla JS, ingen byggesteg, ingen CDN. All tekst settes med textContent (via el), aldri innerHTML.
//
// Prioritetskartet er hovedvisningen for prioritering: modulene som rader, og kolonnene Nå (sikkerhet, før prod,
// viktig), Eier, Senere og Dropp (foldet). Det står i midten av de tre rutene (`vis=kart` i nettadressen), med de
// samme filtrene og det samme utvalget som listen, og detaljpanelet viser posten du velger.
//
// Postene er små brikker som flyttes mellom kolonnene i samme rad (modulen følger prosjektet og endres ikke her):
//   - mus: dra brikken og slipp den i en annen celle i raden,
//   - tastatur: mellomrom løfter brikken, venstre og høyre pil flytter den, mellomrom slipper, Esc avbryter
//     (som fokusvisningen); Enter åpner posten i panelet, og opp og ned pil går mellom brikkene i cellen.
// Flyttingene samles i et utkast (lagret i økta, så en omlasting ikke mister det). «Forhåndsvis» viser hva som
// endres (POST /api/plan-prioriter med torr; ingenting skrives), og «Lagre alt» lagrer samlet med planregisterets
// versjon fra forhåndsvisningen (ko.mjs plan prioriter --satt-av eier; alt eller ingenting). Dropp krever én
// setning som grunn.
//
// Fristbåndet står øverst over rutene når du ser på planpostene: en vannrett stripe over de neste 90 dagene med
// frister fra postene, dokumentene og eierhandlingene i utvalget, og det som er forfalt for seg.
//
// Reglene (kolonnene, utkastet, gruppene til ko.mjs, fristene og radene på stripa) er de rene funksjonene i
// scripts/lib/koPlanVisning.js (window.KoPlanVisning, testet i jest). Her er bare visningen og samspillet.
// =============================================================
'use strict';

(function () {
  const V = window.KoPlanVisning;
  const NOKKEL = 'ko-tavle-nokkel'; // samme som tavle.js (sessionStorage)
  const UTKAST_LAGRING = 'ko-tavle-planer-kart-utkast'; // sessionStorage: utkastet overlever en omlasting
  const DROPP_LAGRING = 'ko-tavle-planer-kart-dropp'; // localStorage: Dropp-kolonnen er åpen
  const BAND_LAGRING = 'ko-tavle-planer-fristband'; // localStorage: fristbåndet er lukket

  const k = {
    utkast: lesUtkast(),
    // Forhåndsvisningen: null, { laster: true } eller svaret fra serveren ({ endringer, advarsler, feil, kan, endret }).
    forhand: null,
    lagrer: false,
    // Brikken som er løftet med tastaturet: { id, oid, fra } (fra = kolonnen da den ble løftet, for Esc).
    loftet: null,
    // Brikken som dras med musa: { id, oid }.
    dra: null,
    droppApen: lesFlagg(DROPP_LAGRING),
    bandLukket: lesFlagg(BAND_LAGRING),
    venterTegning: false,
  };

  // ---- Lagring i nettleseren ----
  function lesUtkast() {
    try {
      const x = JSON.parse(sessionStorage.getItem(UTKAST_LAGRING) ?? 'null');
      return x && typeof x === 'object' && !Array.isArray(x) ? x : {};
    } catch {
      return {};
    }
  }
  function lagreUtkast() {
    try {
      if (Object.keys(k.utkast).length)
        sessionStorage.setItem(UTKAST_LAGRING, JSON.stringify(k.utkast));
      else sessionStorage.removeItem(UTKAST_LAGRING);
    } catch {
      /* privat modus: utkastet gjelder bare denne siden */
    }
  }
  function lesFlagg(nokkel) {
    try {
      return localStorage.getItem(nokkel) === '1';
    } catch {
      return false;
    }
  }
  function settFlagg(nokkel, verdi) {
    try {
      if (verdi) localStorage.setItem(nokkel, '1');
      else localStorage.removeItem(nokkel);
    } catch {
      /* gjelder bare denne økta */
    }
  }

  // Ulagret utkast: nettleseren spør før siden lukkes eller lastes på nytt (utkastet ligger i økta uansett).
  window.addEventListener('beforeunload', (e) => {
    if (!Object.keys(k.utkast).length) return;
    e.preventDefault();
    e.returnValue = '';
  });

  /** Utkastet er endret: forhåndsvisningen gjelder ikke lenger. */
  function nyttUtkast(h, utkast, { tegn = true } = {}) {
    k.utkast = utkast;
    k.forhand = null;
    lagreUtkast();
    if (tegn) h.tegn();
  }

  // ---- Skrivekallet ----
  async function post(kropp) {
    const nokkel = sessionStorage.getItem(NOKKEL) ?? '';
    const res = await fetch('/api/plan-prioriter', {
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
    if (!res.ok) {
      const e = new Error(svar?.melding ?? `HTTP ${res.status}`);
      e.svar = svar;
      throw e;
    }
    return svar;
  }

  async function forhandsvis(h, d) {
    const { endringer, feil } = V.utkastEndringer(k.utkast, d.poster);
    if (feil.length) {
      k.forhand = { endringer: [], advarsler: [], feil, kan: false, lokal: true };
      h.tegn();
      return;
    }
    if (!endringer.length) return;
    k.forhand = { laster: true };
    h.tegn();
    try {
      const svar = await post({ grupper: V.utkastGrupper(endringer), torr: true });
      k.forhand = svar;
    } catch (e) {
      k.forhand = { endringer: [], advarsler: [], feil: [e.message], kan: false };
    }
    h.tegn({ fokus: 'kart-forhand' });
  }

  async function lagre(h, d) {
    if (!k.forhand?.kan || k.lagrer) return;
    const { endringer, feil } = V.utkastEndringer(k.utkast, d.poster);
    if (feil.length || !endringer.length) return;
    k.lagrer = true;
    h.tegn();
    try {
      const svar = await post({
        grupper: V.utkastGrupper(endringer),
        forvent: k.forhand.endret ?? null,
      });
      k.utkast = {};
      k.forhand = null;
      lagreUtkast();
      h.melding(svar?.melding ?? 'Prioritetene er lagret.');
    } catch (e) {
      // Utkastet beholdes. Er registeret endret imens, må forhåndsvisningen tas på nytt.
      k.forhand = { endringer: [], advarsler: [], feil: [e.message], kan: false };
      h.melding(e.message, true);
    } finally {
      k.lagrer = false;
    }
    await h.hent(true);
    h.tegn();
  }

  // ---- Tastatur og mus ----
  function flytt(h, p, til, { tegn = true } = {}) {
    nyttUtkast(h, V.flyttIUtkast(k.utkast, p, til), { tegn });
  }

  function brikkeTast(h, e, p, oid) {
    const id = p.id;
    const naa = V.kolonneMedUtkast(p, k.utkast);
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (k.loftet?.id === id) {
        k.loftet = null;
        si(`${id} sluppet i ${V.kartKolonne(naa)?.tekst ?? naa}.`);
      } else {
        k.loftet = { id, oid, fra: naa };
        si(
          `${id} er løftet fra ${V.kartKolonne(naa)?.tekst ?? naa}. Flytt med venstre og høyre pil, slipp med mellomrom, avbryt med Esc.`,
        );
      }
      h.tegn({ fokus: `brikke:${id}` });
      return;
    }
    if (e.key === 'Escape' && k.loftet?.id === id) {
      e.preventDefault();
      const fra = k.loftet.fra;
      k.loftet = null;
      flytt(h, p, fra, { tegn: false });
      si(`Avbrutt. ${id} står i ${V.kartKolonne(fra)?.tekst ?? fra}.`);
      h.tegn({ fokus: `brikke:${id}` });
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const retning = e.key === 'ArrowLeft' ? -1 : 1;
      if (k.loftet?.id === id) {
        const til = V.kolonneNabo(naa, retning);
        if (!til) return;
        flytt(h, p, til, { tegn: false });
        si(`${id} i ${V.kartKolonne(til).tekst}.`);
        h.tegn({ fokus: `brikke:${id}` });
        return;
      }
      // Ikke løftet: fokus til første brikke i nabocellen i samme rad (hopper over tomme celler).
      let kol = V.kolonneNabo(naa, retning);
      while (kol) {
        const mal = document.querySelector(
          `.kart-celle[data-rad="${CSS.escape(oid)}"][data-kolonne="${kol}"] .kart-brikke`,
        );
        if (mal) {
          mal.focus();
          return;
        }
        kol = V.kolonneNabo(kol, retning);
      }
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !k.loftet) {
      const brikker = [...e.currentTarget.closest('.kart-celle').querySelectorAll('.kart-brikke')];
      const i = brikker.indexOf(e.currentTarget);
      const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
      if (brikker[j]) {
        e.preventDefault();
        brikker[j].focus();
      }
    }
  }

  // Kunngjøringene til skjermleseren (egen region, så toasten ikke fylles med hver pil).
  let siEl = null;
  function si(tekst) {
    if (siEl?.isConnected) {
      siEl.textContent = '';
      siEl.textContent = tekst;
    }
  }

  // ---- Prioritetskartet (midten) ----
  /**
   * Midtruten med kartet. `treff` er postene fra V.kartPoster (samme filtre som listen, pluss de droppede for den
   * foldede kolonnen), `valgt` posten i panelet.
   */
  function midt(h, d, treff, valgt) {
    const el = h.el;
    const rens = V.rensUtkast(k.utkast, d.poster);
    if (Object.keys(rens).length !== Object.keys(k.utkast).length) {
      k.utkast = rens;
      lagreUtkast();
    }
    const nett = V.kartRutenett(treff, d.moduler, k.utkast);
    const kolonner = nett.kolonner.filter((x) => !x.foldet || k.droppApen);
    const dropp = nett.kolonner.find((x) => x.id === 'dropp');
    siEl = el('p', { class: 'skjult-for-oyet', 'aria-live': 'assertive' });

    let innhold;
    if (!d.finnes)
      innhold = el('p', {
        class: 'tom',
        tekst: 'Planregisteret finnes ikke ennå (scripts/.ko/planer.json).',
      });
    else if (!nett.rader.length)
      innhold = el(
        'div',
        { class: 'tom tom-tilstand' },
        el('p', { tekst: 'Ingen poster passer filtrene og søket.' }),
      );
    else
      innhold = el(
        'div',
        { class: 'kart-rull', 'data-rull': 'kart' },
        el(
          'table',
          {
            class: `kart${k.droppApen ? '' : ' kart-dropp-foldet'}`,
            'aria-label': 'Prioritetskartet: moduler mot prioritet',
            'aria-describedby': 'kart-hjelp',
          },
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', { scope: 'col', class: 'kart-hjorne', tekst: 'Modul' }),
              ...kolonner.map((kol) => kolonneHode(h, d, kol)),
              k.droppApen ? null : kolonneHode(h, d, dropp),
            ),
          ),
          el('tbody', {}, ...nett.rader.map((r) => radEl(h, d, r, kolonner, valgt))),
        ),
      );

    return el(
      'section',
      { class: 'planer-midt kart-midt', 'aria-label': 'Prioritetskartet', 'data-rull': 'liste' },
      h.aktiveFiltre(d),
      el('p', {
        id: 'kart-hjelp',
        class: 'kart-hjelp',
        tekst:
          'Dra en post til en annen kolonne i samme rad, eller løft den med mellomrom og flytt med piltastene. ' +
          'Endringene samles i et utkast som du ser over før alt lagres samlet. Enter åpner posten.',
      }),
      siEl,
      utkastEl(h, d),
      innhold,
      nett.utenPrioritet.length
        ? el('p', {
            class: 'kart-merknad',
            tekst: `${nett.utenPrioritet.length} poster har ukjent prioritet og står ikke i kartet (se listen).`,
          })
        : null,
    );
  }

  function kolonneHode(h, d, kol) {
    const el = h.el;
    const regler = V.kolonneRegler(d.regler, kol.id);
    const hjelp = regler.length
      ? `Regel ${regler.map((r) => `${r.nr} (${r.navn})`).join(', ')} i prioritetsreglene`
      : '';
    if (kol.foldet) {
      return el(
        'th',
        { scope: 'col', class: 'kart-kolonne kol-dropp' },
        el(
          'button',
          {
            type: 'button',
            class: 'kart-fold',
            'aria-expanded': k.droppApen ? 'true' : 'false',
            'data-fokus': 'kart-dropp',
            title: hjelp || null,
            onclick: () => {
              k.droppApen = !k.droppApen;
              settFlagg(DROPP_LAGRING, k.droppApen);
              h.tegn({ fokus: 'kart-dropp' });
            },
          },
          el('span', { 'aria-hidden': 'true', tekst: k.droppApen ? '▾' : '▸' }),
          el('span', { class: 'kart-symbol', 'aria-hidden': 'true', tekst: kol.symbol }),
          el('span', { tekst: kol.tekst }),
          el('span', { class: 'planer-antall', tekst: String(kol.antall) }),
        ),
      );
    }
    return el(
      'th',
      {
        scope: 'col',
        class: `kart-kolonne kol-${kol.prioritet}`,
        title: hjelp || null,
      },
      el(
        'span',
        { class: `planer-pri pri-${kol.prioritet}` },
        el('span', { class: 'planer-pri-symbol', 'aria-hidden': 'true', tekst: kol.symbol }),
        el('span', { tekst: kol.tekst }),
      ),
      el('span', {
        class: 'planer-antall',
        tekst: String(kol.antall),
        'aria-label': `${kol.antall} poster`,
      }),
      hjelp ? el('span', { class: 'skjult-for-oyet', tekst: hjelp }) : null,
    );
  }

  function radEl(h, d, r, kolonner, valgt) {
    const el = h.el;
    const celler = kolonner.map((kol) => celleEl(h, d, r, kol, valgt));
    if (!k.droppApen) celler.push(celleEl(h, d, r, V.kartKolonne('dropp'), valgt, true));
    return el(
      'tr',
      { class: 'kart-rad' },
      el(
        'th',
        { scope: 'row', class: 'kart-modul' },
        el('span', { class: 'kart-modul-tittel', tekst: r.tittel }),
        el('span', { class: 'planer-antall', tekst: String(r.antall) }),
      ),
      ...celler,
    );
  }

  function celleEl(h, d, r, kol, valgt, foldet = false) {
    const el = h.el;
    const brikker = r.celler[kol.id] ?? [];
    // Bare cellene i samme rad tar imot (modulen følger prosjektet og endres ikke her).
    const dropMal = () => k.dra && k.dra.oid === r.oid;
    const td = el('td', {
      class: `kart-celle kol-${kol.prioritet}${foldet ? ' kart-celle-foldet' : ''}`,
      'data-rad': r.oid,
      'data-kolonne': kol.id,
      'aria-label': `${r.tittel}, ${kol.tekst}: ${brikker.length} poster`,
      ondragover: (e) => {
        if (!dropMal()) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        e.currentTarget.classList.add('drop-mal');
      },
      ondragleave: (e) => e.currentTarget.classList.remove('drop-mal'),
      ondrop: (e) => {
        e.currentTarget.classList.remove('drop-mal');
        if (!dropMal()) return;
        e.preventDefault();
        const p = d.poster.find((x) => x.id === k.dra.id);
        k.dra = null;
        if (p) {
          flytt(h, p, kol.id, { tegn: false });
          si(`${p.id} i ${kol.tekst}.`);
        }
        h.tegn({ fokus: p ? `brikke:${p.id}` : null });
      },
    });
    if (foldet) {
      const flyttet = brikker.filter((b) => b.flyttet).length;
      if (brikker.length)
        td.append(
          el('span', {
            class: 'kart-foldet-tall',
            tekst: `${brikker.length}${flyttet ? ` (${flyttet} i utkastet)` : ''}`,
          }),
        );
      return td;
    }
    if (brikker.length)
      td.append(
        el(
          'ul',
          { class: 'kart-brikker' },
          ...brikker.map((b) => el('li', {}, brikkeEl(h, b, r, kol, valgt))),
        ),
      );
    return td;
  }

  function brikkeEl(h, b, r, kol, valgt) {
    const el = h.el;
    const p = b.post;
    const erValgt = valgt?.id === p.id;
    const loftet = k.loftet?.id === p.id;
    const fra = b.flyttet ? V.kartKolonne(b.fra) : null;
    const kat =
      p.prioritet === 'naa' && (p.naa_kategori ?? []).length > 1 && !b.flyttet
        ? ` (også ${p.naa_kategori
            .filter((x) => `naa-${x}` !== kol.id)
            .map((x) => V.KATEGORI[x] ?? x)
            .join(', ')})`
        : '';
    const etikett =
      `${p.id} ${p.tittel}. ${kol.tekst}${kat}` +
      `${fra ? `, flyttet i utkastet fra ${fra.tekst}` : ''}` +
      `${p.estimat ? `, estimat ${p.estimat}` : ''}${p.frist ? `, frist ${p.frist}` : ''}` +
      `${loftet ? ', løftet' : ''}`;
    return el(
      'button',
      {
        type: 'button',
        class: `kart-brikke${b.flyttet ? ' flyttet' : ''}${erValgt ? ' valgt' : ''}${loftet ? ' loftet' : ''}`,
        draggable: 'true',
        'data-fokus': `brikke:${p.id}`,
        'aria-label': etikett,
        'aria-pressed': loftet ? 'true' : 'false',
        'aria-current': erValgt ? 'true' : null,
        title: `${p.id} ${p.tittel}`,
        onclick: () => h.velgPost(p.id),
        onkeydown: (e) => {
          if (e.key === 'Enter') return; // klikk = velg
          brikkeTast(h, e, p, r.oid);
        },
        ondragstart: (e) => {
          k.dra = { id: p.id, oid: r.oid };
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', p.id);
          e.currentTarget.classList.add('dras');
        },
        ondragend: () => {
          k.dra = null;
          if (k.venterTegning) h.tegn();
        },
      },
      b.flyttet
        ? el('span', { class: 'kart-utkast-merke', 'aria-hidden': 'true', tekst: '✎' })
        : null,
      el('span', { class: 'kart-brikke-id', tekst: p.id }),
      el('span', { class: 'kart-brikke-tittel', tekst: p.tittel }),
      p.estimat
        ? el('span', { class: 'kart-brikke-est', 'aria-hidden': 'true', tekst: p.estimat })
        : null,
      p.frist
        ? el('span', { class: 'kart-brikke-frist', 'aria-hidden': 'true', tekst: '◷' })
        : null,
    );
  }

  // ---- Utkastet og forhåndsvisningen ----
  function utkastEl(h, d) {
    const el = h.el;
    const { endringer, feil } = V.utkastEndringer(k.utkast, d.poster);
    if (!endringer.length && !k.forhand) return null;
    const f = k.forhand;
    const linjer = endringer.map((e) =>
      el(
        'li',
        { class: 'kart-endring' },
        el('span', {
          class: 'kart-endring-tekst',
          tekst: `${e.id} ${e.tittel}: ${e.fraTekst} → ${e.tilTekst}`,
        }),
        e.til === 'dropp'
          ? el(
              'label',
              { class: 'kart-grunn' },
              el('span', { tekst: 'Grunn (én setning)' }),
              el('input', {
                type: 'text',
                maxlength: String(V.GRUNN_MAKS),
                value: e.grunn ?? '',
                'data-fokus': `grunn:${e.id}`,
                'aria-invalid': e.grunn ? null : 'true',
                oninput: (ev) => {
                  k.utkast = V.settUtkastGrunn(k.utkast, e.id, ev.target.value);
                  k.forhand = null;
                  lagreUtkast();
                },
                onchange: () => h.tegn({ fokus: `grunn:${e.id}` }),
              }),
            )
          : null,
        el('button', {
          type: 'button',
          class: 'knapp-liten knapp-kontur',
          tekst: 'Angre',
          'aria-label': `Angre flyttingen av ${e.id}`,
          onclick: () => {
            const p = d.poster.find((x) => x.id === e.id);
            if (p) flytt(h, p, e.fra);
          },
        }),
      ),
    );

    let forhandEl = null;
    if (f?.laster)
      forhandEl = el('p', { class: 'kart-forhand-tekst', tekst: 'Henter forhåndsvisningen …' });
    else if (f) {
      const skrives = (f.endringer ?? []).map((x) =>
        el('li', {
          tekst: `${x.id}: ${x.felt === '*' ? 'posten' : x.felt} ${verdi(x.for)} → ${verdi(x.etter)}`,
        }),
      );
      forhandEl = el(
        'div',
        {
          class: 'kart-forhand',
          tabindex: '-1',
          'data-fokus': 'kart-forhand',
          role: 'region',
          'aria-label': 'Forhåndsvisningen',
        },
        el('h3', {
          class: 'kart-forhand-tittel',
          tekst: 'Forhåndsvisning (ingenting er lagret ennå)',
        }),
        (f.feil ?? []).length
          ? el(
              'ul',
              { class: 'kart-feil', role: 'alert' },
              ...f.feil.map((x) => el('li', { tekst: x })),
            )
          : null,
        skrives.length ? el('ul', { class: 'kart-skrives' }, ...skrives) : null,
        (f.advarsler ?? []).length
          ? el(
              'ul',
              { class: 'kart-advarsler' },
              ...f.advarsler.map((x) => el('li', { tekst: `Advarsel: ${x}` })),
            )
          : null,
      );
    }

    return el(
      'section',
      { class: 'kart-utkast', 'aria-label': 'Utkastet' },
      el(
        'div',
        { class: 'kart-utkast-hode' },
        el('h3', {
          class: 'kart-utkast-tittel',
          tekst: `Utkast: ${endringer.length} ${endringer.length === 1 ? 'endring' : 'endringer'}`,
        }),
        el('button', {
          type: 'button',
          class: 'knapp knapp-tonet',
          tekst: 'Forhåndsvis',
          'data-fokus': 'kart-forhandsvis',
          disabled: !endringer.length || f?.laster || k.lagrer,
          onclick: () => forhandsvis(h, d),
        }),
        el('button', {
          type: 'button',
          class: 'knapp knapp-fylt',
          tekst: k.lagrer ? 'Lagrer …' : 'Lagre alt',
          'data-fokus': 'kart-lagre',
          disabled: !f?.kan || !!feil.length || k.lagrer,
          title: f?.kan ? null : 'Forhåndsvis først',
          onclick: () => lagre(h, d),
        }),
        el('button', {
          type: 'button',
          class: 'knapp knapp-kontur',
          tekst: 'Forkast',
          disabled: k.lagrer,
          onclick: () => {
            k.loftet = null;
            nyttUtkast(h, {});
            h.melding('Utkastet er forkastet.');
          },
        }),
      ),
      linjer.length ? el('ul', { class: 'kart-endringer' }, ...linjer) : null,
      forhandEl,
    );
  }

  /** En verdi fra endringene (planDiff) som kort tekst. */
  function verdi(x) {
    if (x == null) return '(tom)';
    if (Array.isArray(x)) return x.length ? x.join(', ') : '(tom)';
    if (typeof x === 'object') return x.tittel ?? JSON.stringify(x).slice(0, 80);
    return String(x).slice(0, 120);
  }

  // ---- Fristbåndet ----
  const TYPE = {
    post: { symbol: '◷', tekst: 'Frist på planpost' },
    eier: { symbol: '?', tekst: 'Eierhandling' },
    dok: { symbol: '§', tekst: 'Dokumentfrist' },
    revisjon: { symbol: '⟳', tekst: 'Revisjon' },
  };

  /**
   * Fristbåndet over rutene. `ider` er postene i utvalget (null uten filter og søk: alt tas med).
   */
  function fristBand(h, d, ider) {
    const el = h.el;
    const alle = V.fristElementer(d.poster, d.dokumenter, { ider });
    const forfalte = alle.filter((e) => e.forfalt);
    const kommende = alle.filter((e) => !e.forfalt);
    const { rader, skjult } = V.fristRader(kommende);
    const skala = V.fristSkala(new Date(), V.FRIST_DAGER);

    const merke = (e, klasse) =>
      el(
        'button',
        {
          type: 'button',
          class: `${klasse} frist-${e.type}`,
          '--x': `${(e.andel * 100).toFixed(2)}%`,
          'aria-label': V.fristTekst(e),
          title: V.fristTekst(e),
          'data-fokus': `frist:${e.type}:${e.id}`,
          onclick: () => aapne(h, e),
        },
        el('span', { class: 'frist-symbol', 'aria-hidden': 'true', tekst: TYPE[e.type].symbol }),
        el('span', { class: 'frist-id', 'aria-hidden': 'true', tekst: e.id }),
      );
    const listeEl = (liste) =>
      el(
        'ul',
        { class: 'frist-liste' },
        ...liste.map((e) =>
          el(
            'li',
            {},
            el(
              'button',
              { type: 'button', class: 'lenke-knapp', onclick: () => aapne(h, e) },
              el('span', { 'aria-hidden': 'true', tekst: `${TYPE[e.type].symbol} ` }),
              V.fristTekst(e),
            ),
          ),
        ),
      );

    const oppsummering = `Frister de neste ${V.FRIST_DAGER} dagene: ${kommende.length}${forfalte.length ? `, forfalt: ${forfalte.length}` : ''}`;
    return el(
      'details',
      {
        class: 'fristband',
        open: !k.bandLukket,
        ontoggle: (e) => {
          k.bandLukket = !e.currentTarget.open;
          settFlagg(BAND_LAGRING, k.bandLukket);
        },
      },
      el(
        'summary',
        { class: 'fristband-tittel', 'data-fokus': 'fristband' },
        el('span', { tekst: oppsummering }),
        ider ? el('span', { class: 'fristband-utvalg', tekst: '(utvalget)' }) : null,
      ),
      !alle.length
        ? el('p', {
            class: 'tom fristband-tom',
            tekst: 'Ingen frister i utvalget de neste 90 dagene.',
          })
        : el(
            'div',
            { class: 'fristband-innhold' },
            forfalte.length
              ? el(
                  'div',
                  {
                    class: 'fristband-forfalt',
                    role: 'group',
                    'aria-label': `Forfalt: ${forfalte.length}`,
                  },
                  el('span', {
                    class: 'fristband-forfalt-tittel',
                    tekst: `⚠ Forfalt (${forfalte.length})`,
                  }),
                  el(
                    'div',
                    { class: 'fristband-forfalt-merker' },
                    ...forfalte.map((e) => merke(e, 'frist-merke frist-forfalt')),
                  ),
                )
              : null,
            el(
              'div',
              {
                class: 'fristband-stripe',
                role: 'group',
                'aria-label': `De neste ${V.FRIST_DAGER} dagene, i datorekkefølge`,
                '--rader': String(Math.max(1, rader.length)),
              },
              ...rader.flatMap((rad, i) =>
                rad.map((e) => {
                  const b = merke(e, 'frist-merke');
                  b.style.setProperty('--rad', String(i));
                  return b;
                }),
              ),
              el(
                'div',
                { class: 'fristband-skala', 'aria-hidden': 'true' },
                ...skala.map((s) =>
                  el('span', {
                    class: 'fristband-strek',
                    '--x': `${(s.andel * 100).toFixed(2)}%`,
                    tekst: s.tekst,
                  }),
                ),
              ),
            ),
            skjult.length
              ? el(
                  'details',
                  { class: 'fristband-flere' },
                  el('summary', { tekst: `+${skjult.length} til (ligger tett)` }),
                  listeEl(skjult),
                )
              : null,
            el(
              'p',
              { class: 'fristband-tegn' },
              ...Object.values(TYPE).map((t) =>
                el(
                  'span',
                  { class: 'fristband-tegn-ledd' },
                  el('span', { 'aria-hidden': 'true', tekst: t.symbol }),
                  ` ${t.tekst}`,
                ),
              ),
            ),
          ),
    );
  }

  /** Klikk på et merke: posten (eierhandlingen i fanen Beslutninger) eller dokumentet. */
  function aapne(h, e) {
    if (e.dok) h.velgDok(e.dok);
    else if (e.post) h.velgPost(e.post, e.type === 'eier' ? 'beslutninger' : 'sammendrag');
  }

  window.KoPlanKart = {
    midt,
    fristBand,
    /** Et drag eller en løftet brikke pågår: en oppdatering fra serveren venter til det er ferdig. */
    opptatt() {
      // En løftet brikke teller bare så lenge den har fokus (Tab bort slipper den der den står).
      if (k.loftet && document.activeElement?.dataset?.fokus !== `brikke:${k.loftet.id}`)
        k.loftet = null;
      const x = !!(k.dra || k.loftet);
      if (x) k.venterTegning = true;
      return x;
    },
    ferdigTegnet() {
      k.venterTegning = false;
    },
    harUtkast: () => Object.keys(k.utkast).length > 0,
  };
})();
