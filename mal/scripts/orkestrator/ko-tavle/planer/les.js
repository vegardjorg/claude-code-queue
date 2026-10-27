// =============================================================
// les.js: lesevisningen av dokumenter og Uregistrert-boksen i Planer-rommet (se docs/board.md).
// Vanilla JS, ingen byggesteg, ingen CDN.
//
//   - Fanen Dokumenter i detaljpanelet: kildene til posten, og den valgte kilden lest inn under lista. Lenker til
//     andre dokumenter som kan leses, åpnes i samme visning (med «Tilbake»); nettadresser vises som tekst og åpnes
//     aldri herfra.
//   - Uregistrert-boksen over listen: dokumentene `plan sjekk` finner som ingen post peker til, gruppert etter mappe
//     med antall, og for hvert dokument «Les», «Ny post» og «Legg til som kilde». Begge skrivingene har
//     forhåndsvisning først og lagres med --forvent-endret (POST /api/plan-ny og /api/plan-kilde, som kjører ko.mjs).
//
// Dokumentet hentes med GET /api/dok?sti=… (bare markdown under dokumentmappene i ko.config.json, standard docs/;
// serveren har stivernet). Markdown deles i blokker av de rene funksjonene i scripts/lib/koPlanVisning.js
// (markdownBlokker, inlineDeler, lenkeMaal, ankerIndeks; testet i jest) og tegnes bare med textContent og
// createElement, aldri innerHTML, så HTML i et dokument blir stående som tekst.
// =============================================================
'use strict';

(function () {
  const V = window.KoPlanVisning;
  const NOKKEL = 'ko-tavle-nokkel'; // samme som tavle.js (sessionStorage)
  const BOKS_LAGRING = 'ko-tavle-planer-uregistrert-apen'; // localStorage: boksen er åpen
  const CACHE_MAKS = 20;

  const s = {
    // Dokumentene som er hentet: sti → { status: 'laster'|'ok'|'feil', data?, blokker?, melding?, el? }.
    dok: new Map(),
    // Hva som leses i hver sammenheng (`post:<id>` eller `ureg`): { sti, anker, tilbake: [{ sti, anker }] }.
    vis: {},
    // Overskriften lesevisningen skal rulle til etter neste tegning: { kontekst, indeks }.
    rull: null,
    ureg: {
      apen: lesFlagg(BOKS_LAGRING),
      data: null,
      feil: null,
      henter: false,
      versjon: undefined, // registerets `endret` da lista sist ble hentet
      skjema: null, // { sti, type: 'ny'|'kilde', felt, forhand, lagrer }
    },
  };

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
  const hode = () => ({ 'X-Ko-Nokkel': sessionStorage.getItem(NOKKEL) ?? '' });

  async function lesSvar(res) {
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

  // ---- Henting ----
  async function hentDok(h, sti) {
    if (s.dok.has(sti)) return;
    s.dok.set(sti, { status: 'laster' });
    while (s.dok.size > CACHE_MAKS) s.dok.delete(s.dok.keys().next().value);
    try {
      const res = await fetch(`/api/dok?sti=${encodeURIComponent(sti)}`, { headers: hode() });
      const svar = await lesSvar(res);
      s.dok.set(sti, { status: 'ok', data: svar, blokker: V.markdownBlokker(svar.tekst) });
    } catch (e) {
      s.dok.set(sti, { status: 'feil', melding: e.message });
    }
    h.tegn();
  }

  async function hentUregistrert(h, versjon) {
    const u = s.ureg;
    if (u.henter) return;
    u.henter = true;
    u.versjon = versjon;
    try {
      const res = await fetch('/api/plan-sjekk', { headers: hode() });
      u.data = await lesSvar(res);
      u.feil = null;
    } catch (e) {
      u.feil = e.message;
    } finally {
      u.henter = false;
    }
    h.tegn();
  }

  async function post(sti, kropp) {
    const res = await fetch(sti, {
      method: 'POST',
      headers: { ...hode(), 'Content-Type': 'application/json' },
      body: JSON.stringify(kropp),
    });
    return lesSvar(res);
  }

  // ---- Lesevisningen ----
  function apne(h, kontekst, sti, anker, { tilbake = true } = {}) {
    const naa = s.vis[kontekst];
    const historikk =
      naa?.sti && tilbake ? [...naa.tilbake, { sti: naa.sti, anker: naa.anker }] : [];
    s.vis[kontekst] = { sti, anker: anker ?? null, tilbake: historikk.slice(-20) };
    s.rull = anker ? { kontekst, anker } : null;
    h.tegn({ fokus: `les:${kontekst}` });
  }

  /** Bitene i en linje markdown som DOM-noder (tekst, kode, fet, kursiv og lenker). */
  function inline(h, tekst, ctx, deler = V.inlineDeler(tekst)) {
    const ut = [];
    for (const d of deler) {
      if (d.type === 'tekst') ut.push(document.createTextNode(d.tekst));
      else if (d.type === 'kode') ut.push(h.el('code', { tekst: d.tekst }));
      else if (d.type === 'fet') ut.push(h.el('strong', {}, ...inline(h, '', ctx, d.deler)));
      else if (d.type === 'kursiv') ut.push(h.el('em', {}, ...inline(h, '', ctx, d.deler)));
      else if (d.type === 'lenke') {
        const m = V.lenkeMaal(ctx.sti, d.mal);
        if (m.type === 'dok')
          ut.push(
            h.el('button', {
              type: 'button',
              class: 'lenke-knapp les-lenke',
              tekst: d.tekst,
              title: `Les ${m.sti}${m.anker ? ` #${m.anker}` : ''}`,
              onclick: () => apne(h, ctx.kontekst, m.sti, m.anker),
            }),
          );
        else if (m.type === 'anker')
          ut.push(
            h.el('button', {
              type: 'button',
              class: 'lenke-knapp les-lenke',
              tekst: d.tekst,
              title: `Gå til ${m.anker}`,
              onclick: () => {
                s.rull = { kontekst: ctx.kontekst, anker: m.anker };
                rullTil(ctx.kontekst);
              },
            }),
          );
        else if (m.type === 'ekstern')
          // Nettadressen vises som tekst (åpnes aldri fra tavla); kopier den om du vil åpne den.
          ut.push(
            h.el(
              'span',
              { class: 'les-ekstern', title: m.url },
              d.tekst,
              d.tekst === m.url ? null : h.el('span', { class: 'les-url', tekst: ` (${m.url})` }),
            ),
          );
        else ut.push(h.el('span', { class: 'les-ekstern', title: d.mal, tekst: d.tekst }));
      }
    }
    return ut;
  }

  /** En liste med nivåer: et punkt med større innrykk legges i en ny liste inni punktet over. */
  function listeEl(h, punkter, ctx) {
    const ny = (p) => h.el(p.ordnet ? 'ol' : 'ul', { class: 'les-liste' });
    const rot = ny(punkter[0]);
    const stabel = [{ niva: punkter[0].niva, liste: rot }];
    for (const p of punkter) {
      while (stabel.length > 1 && p.niva < stabel[stabel.length - 1].niva) stabel.pop();
      let topp = stabel[stabel.length - 1];
      if (p.niva > topp.niva && topp.liste.lastElementChild) {
        const under = ny(p);
        topp.liste.lastElementChild.append(under);
        stabel.push({ niva: p.niva, liste: under });
        topp = stabel[stabel.length - 1];
      }
      topp.liste.append(
        h.el(
          'li',
          { value: p.ordnet && p.nr != null ? String(p.nr) : null },
          ...inline(h, p.tekst, ctx),
        ),
      );
    }
    return rot;
  }

  function blokkEl(h, b, i, ctx) {
    if (b.type === 'overskrift')
      return h.el(
        `h${Math.min(6, b.niva + 2)}`,
        { class: `les-h les-h${b.niva}`, 'data-blokk': String(i) },
        ...inline(h, b.tekst, ctx),
      );
    if (b.type === 'avsnitt') return h.el('p', {}, ...inline(h, b.tekst, ctx));
    if (b.type === 'liste') return listeEl(h, b.punkter, ctx);
    if (b.type === 'kode')
      return h.el(
        'pre',
        { class: 'les-kode', tabindex: '0', 'aria-label': b.sprak ? `Kode (${b.sprak})` : 'Kode' },
        h.el('code', { tekst: b.tekst }),
      );
    if (b.type === 'sitat')
      return h.el('blockquote', { class: 'les-sitat' }, ...inline(h, b.tekst, ctx));
    if (b.type === 'linje') return h.el('hr', { class: 'les-linje' });
    if (b.type === 'tabell')
      return h.el(
        'div',
        { class: 'les-tabell', tabindex: '0', role: 'region', 'aria-label': 'Tabell' },
        h.el(
          'table',
          {},
          h.el(
            'thead',
            {},
            h.el(
              'tr',
              {},
              ...b.hode.map((c) => h.el('th', { scope: 'col' }, ...inline(h, c, ctx))),
            ),
          ),
          h.el(
            'tbody',
            {},
            ...b.rader.map((r) =>
              h.el('tr', {}, ...r.map((c) => h.el('td', {}, ...inline(h, c, ctx)))),
            ),
          ),
        ),
      );
    return null;
  }

  function rullTil(kontekst) {
    const r = s.rull;
    if (!r || r.kontekst !== kontekst) return;
    const post = s.dok.get(s.vis[kontekst]?.sti);
    if (post?.status !== 'ok') return;
    s.rull = null;
    const i = V.ankerIndeks(post.blokker, r.anker);
    const art = document.querySelector(`[data-les="${CSS.escape(kontekst)}"]`);
    if (!art) return;
    if (i < 0) {
      art.querySelector('.les-varsel')?.remove();
      art.prepend(
        Object.assign(document.createElement('p'), {
          className: 'planer-hjelp les-varsel',
          textContent: `Fant ikke ankeret «${r.anker}» i dokumentet; viser starten.`,
        }),
      );
      return;
    }
    const mal = art.querySelector(`[data-blokk="${i}"]`);
    if (mal) art.scrollTop = mal.offsetTop - art.offsetTop;
  }

  /** Selve dokumentet: toppen med sti, tidspunkt og knapper, så teksten i en rute som ruller for seg. */
  function visningEl(h, kontekst) {
    const v = s.vis[kontekst];
    if (!v?.sti) return null;
    const ctx = { kontekst, sti: v.sti };
    const d = s.dok.get(v.sti);
    if (!d) hentDok(h, v.sti);
    const topp = h.el(
      'div',
      { class: 'les-topp' },
      v.tilbake.length
        ? h.el('button', {
            type: 'button',
            class: 'knapp-liten knapp-kontur',
            tekst: 'Tilbake',
            title: `Tilbake til ${v.tilbake[v.tilbake.length - 1].sti}`,
            onclick: () => {
              const forrige = v.tilbake[v.tilbake.length - 1];
              s.vis[kontekst] = { ...forrige, tilbake: v.tilbake.slice(0, -1) };
              s.rull = forrige.anker ? { kontekst, anker: forrige.anker } : null;
              h.tegn({ fokus: `les:${kontekst}` });
            },
          })
        : null,
      h.el('code', { class: 'les-sti', tekst: v.sti }),
      v.anker ? h.el('span', { class: 'merke', tekst: v.anker }) : null,
      d?.status === 'ok'
        ? h.el('span', { class: 'planer-hjelp', tekst: `endret ${h.dato(d.data.endret)}` })
        : null,
      h.kopierKnapp(v.sti, `Kopier stien ${v.sti}`),
      h.el('button', {
        type: 'button',
        class: 'knapp-liten knapp-kontur',
        tekst: 'Last på nytt',
        'aria-label': `Last ${v.sti} på nytt`,
        onclick: () => {
          s.dok.delete(v.sti);
          s.rull = v.anker ? { kontekst, anker: v.anker } : null;
          hentDok(h, v.sti);
          h.tegn();
        },
      }),
      h.el('button', {
        type: 'button',
        class: 'knapp-liten knapp-kontur',
        tekst: 'Lukk',
        'aria-label': `Lukk lesevisningen av ${v.sti}`,
        onclick: () => {
          delete s.vis[kontekst];
          h.tegn();
        },
      }),
    );
    let innhold;
    if (!d || d.status === 'laster')
      innhold = h.el('p', { class: 'tom', role: 'status', tekst: `Henter ${v.sti} …` });
    else if (d.status === 'feil')
      innhold = h.el('p', { class: 'tom les-feil', role: 'alert', tekst: d.melding });
    else {
      // Blokkene bygges én gang per henting (store dokumenter blir mange noder); tegningen flytter bare elementet.
      if (!d.el || d.kontekst !== kontekst) {
        d.el = h.el(
          'div',
          { class: 'les-tekst' },
          ...d.blokker.map((b, i) => blokkEl(h, b, i, ctx)),
        );
        d.kontekst = kontekst;
      }
      innhold = d.el;
      if (s.rull?.kontekst === kontekst) requestAnimationFrame(() => rullTil(kontekst));
    }
    return h.el(
      'section',
      { class: 'les', 'aria-label': `Dokument ${v.sti}` },
      topp,
      h.el(
        'article',
        {
          class: 'les-dok',
          tabindex: '0',
          'data-les': kontekst,
          'data-rull': `les:${kontekst}`,
          'data-fokus': `les:${kontekst}`,
          'aria-label': `Teksten i ${v.sti}`,
        },
        innhold,
      ),
    );
  }

  /** Fanen Dokumenter i detaljpanelet: kildene med «Les», og den valgte kilden under. */
  function kildeFane(h, p) {
    const kontekst = `post:${p.id}`;
    const lesbare = p.kilder.filter((k) => !V.lesStiFeil(k.sti));
    if (!s.vis[kontekst] && lesbare.length)
      s.vis[kontekst] = { sti: lesbare[0].sti, anker: lesbare[0].anker ?? null, tilbake: [] };
    const valgt = s.vis[kontekst];
    if (valgt && !s.rull && !s.dok.has(valgt.sti) && valgt.anker)
      s.rull = { kontekst, anker: valgt.anker };
    return h.el(
      'div',
      {},
      h.liste(
        p.kilder.map((k) => {
          const feil = V.lesStiFeil(k.sti);
          const er = valgt?.sti === k.sti && (valgt.anker ?? null) === (k.anker ?? null);
          return h.el(
            'li',
            { class: `planer-kilde${er ? ' les-valgt' : ''}` },
            h.el('code', { tekst: k.sti }),
            k.anker ? h.el('span', { class: 'merke', tekst: k.anker }) : null,
            k.rolle ? h.el('span', { class: 'merke', tekst: k.rolle }) : null,
            feil
              ? h.el('span', { class: 'planer-hjelp', tekst: `Vises ikke her: ${feil}.` })
              : h.el('button', {
                  type: 'button',
                  class: 'knapp-liten knapp-kontur',
                  tekst: er ? 'Leses' : 'Les',
                  'aria-pressed': er ? 'true' : 'false',
                  'aria-label': `Les ${k.sti}${k.anker ? ` ved ${k.anker}` : ''}`,
                  onclick: () => {
                    s.vis[kontekst] = null;
                    apne(h, kontekst, k.sti, k.anker, { tilbake: false });
                  },
                }),
            h.kopierKnapp(k.sti, `Kopier stien ${k.sti}`),
          );
        }),
        'Posten har ingen kilder.',
      ),
      visningEl(h, kontekst),
    );
  }

  // ---- Uregistrert-boksen ----
  function nyttSkjema(h, d, sti, type) {
    const u = s.ureg;
    if (u.skjema?.sti === sti && u.skjema.type === type) {
      u.skjema = null;
      h.tegn({ fokus: `ureg:${type}:${sti}` });
      return;
    }
    const brukte = new Set(d.poster.map((p) => p.id));
    const forslag = V.postForslag(sti, brukte);
    u.skjema = {
      sti,
      type,
      felt:
        type === 'ny'
          ? {
              id: forslag.id,
              tittel: forslag.tittel,
              prosjekt: '',
              prioritet: 'eier',
              kategori: '',
              grunn: '',
            }
          : { post: '', anker: '' },
      forhand: null,
      lagrer: false,
    };
    h.tegn({ fokus: `ureg-felt:${type === 'ny' ? 'tittel' : 'post'}` });
  }

  /** Den lokale sjekken før forhåndsvisningen (samme regler som serveren bruker). */
  function lokalFeil(d, sk) {
    if (sk.type === 'ny') return V.nyPostFraSkjema(sk.felt, sk.sti).feil;
    const p = d.poster.find((x) => x.id === sk.felt.post.trim());
    if (!p) return ['velg en planpost som finnes'];
    return V.kildeTillegg(p, sk.sti, sk.felt.anker).feil;
  }

  function kropp(sk, ekstra) {
    return sk.type === 'ny'
      ? { sti: sk.sti, skjema: sk.felt, ...ekstra }
      : { sti: sk.sti, id: sk.felt.post.trim(), anker: sk.felt.anker, ...ekstra };
  }
  const adresse = (sk) => (sk.type === 'ny' ? '/api/plan-ny' : '/api/plan-kilde');

  async function forhandsvis(h, d) {
    const sk = s.ureg.skjema;
    if (!sk) return;
    const feil = lokalFeil(d, sk);
    if (feil.length) {
      sk.forhand = { feil, advarsler: [], endringer: [], kan: false };
      h.tegn({ fokus: 'ureg-forhand' });
      return;
    }
    sk.forhand = { laster: true };
    h.tegn();
    try {
      const svar = await post(adresse(sk), kropp(sk, { torr: true }));
      sk.forhand = { ...svar, feil: [], kan: true };
    } catch (e) {
      sk.forhand = {
        feil: [e.message],
        advarsler: e.svar?.advarsler ?? [],
        endringer: [],
        kan: false,
      };
    }
    h.tegn({ fokus: 'ureg-forhand' });
  }

  async function lagre(h) {
    const sk = s.ureg.skjema;
    if (!sk?.forhand?.kan || sk.lagrer) return;
    sk.lagrer = true;
    h.tegn();
    let ny = null;
    try {
      const svar = await post(adresse(sk), kropp(sk, { forvent: sk.forhand.endret ?? null }));
      h.melding(svar?.melding ?? 'Lagret.');
      if (sk.type === 'ny') ny = sk.felt.id;
      s.ureg.skjema = null;
      s.ureg.versjon = undefined; // lista hentes på nytt
    } catch (e) {
      // Skjemaet beholdes. Er registeret endret imens, må forhåndsvisningen tas på nytt.
      sk.forhand = { feil: [e.message], advarsler: [], endringer: [], kan: false };
      h.melding(e.message, true);
    } finally {
      sk.lagrer = false;
    }
    await h.hent(true);
    if (ny) h.gaaTilPost(ny);
    else h.tegn();
  }

  function feltEl(h, sk, navn, etikett, inn) {
    const id = `ureg-${navn}`;
    const endre = (e) => {
      sk.felt[navn] = e.target.value;
      if (sk.forhand) {
        sk.forhand = null;
        h.tegn({ fokus: `ureg-felt:${navn}` });
      }
    };
    const kontroll =
      inn.tag === 'select'
        ? h.el(
            'select',
            {
              id,
              'data-fokus': `ureg-felt:${navn}`,
              onchange: (e) => {
                sk.felt[navn] = e.target.value;
                sk.forhand = null;
                h.tegn({ fokus: `ureg-felt:${navn}` });
              },
            },
            ...inn.valg.map(([v, t]) =>
              h.el('option', { value: v, selected: sk.felt[navn] === v ? true : null, tekst: t }),
            ),
          )
        : h.el('input', {
            id,
            type: 'text',
            value: sk.felt[navn],
            list: inn.list ?? null,
            maxlength: inn.maks ? String(inn.maks) : null,
            placeholder: inn.hint ?? null,
            autocomplete: 'off',
            'data-fokus': `ureg-felt:${navn}`,
            oninput: endre,
          });
    return h.el(
      'div',
      { class: 'ureg-felt' },
      h.el('label', { for: id, tekst: etikett }),
      kontroll,
    );
  }

  function skjemaEl(h, d, sk) {
    const tast = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        s.ureg.skjema = null;
        h.tegn({ fokus: `ureg:${sk.type}:${sk.sti}` });
      }
    };
    const felt =
      sk.type === 'ny'
        ? [
            feltEl(h, sk, 'tittel', 'Tittel', { maks: 160 }),
            feltEl(h, sk, 'id', 'Id', { maks: 64, hint: 'PL-NAVN-1' }),
            feltEl(h, sk, 'prosjekt', 'Prosjekt', {
              tag: 'select',
              valg: [
                ['', 'Velg prosjekt'],
                ...Object.entries(d.prosjekter ?? {})
                  .sort((a, b) => a[1].kort.localeCompare(b[1].kort, 'nb'))
                  .map(([pid, p]) => [pid, `${p.kort} (${pid})`]),
              ],
            }),
            feltEl(h, sk, 'prioritet', 'Prioritet', {
              tag: 'select',
              valg: ['eier', 'senere', 'naa'].map((x) => [
                x,
                `${V.PRIORITET[x].symbol} ${V.PRIORITET[x].tekst}`,
              ]),
            }),
            sk.felt.prioritet === 'naa'
              ? feltEl(h, sk, 'kategori', 'Kategori i Nå', {
                  tag: 'select',
                  valg: [['', 'Velg kategori'], ...Object.entries(V.KATEGORI)],
                })
              : null,
            feltEl(h, sk, 'grunn', 'Grunn (valgfri)', {
              maks: 500,
              hint: 'Hvorfor denne prioriteten',
            }),
          ]
        : [
            feltEl(h, sk, 'post', 'Planpost', { list: 'ureg-poster', maks: 64, hint: 'PL-…' }),
            h.el(
              'datalist',
              { id: 'ureg-poster' },
              ...d.poster.map((p) => h.el('option', { value: p.id, label: p.tittel })),
            ),
            feltEl(h, sk, 'anker', 'Anker (valgfritt)', { maks: 120, hint: 'Kapittel 3' }),
          ];
    const f = sk.forhand;
    return h.el(
      'div',
      {
        class: 'ureg-skjema',
        role: 'group',
        'aria-label':
          sk.type === 'ny' ? `Ny planpost fra ${sk.sti}` : `Legg ${sk.sti} til som kilde`,
        onkeydown: tast,
      },
      h.el('div', { class: 'ureg-felter' }, ...felt),
      h.el(
        'div',
        { class: 'ureg-knapper' },
        h.el('button', {
          type: 'button',
          class: 'knapp knapp-tonet',
          tekst: f?.laster ? 'Forhåndsviser …' : 'Forhåndsvis',
          disabled: f?.laster || sk.lagrer ? true : null,
          onclick: () => forhandsvis(h, d),
        }),
        h.el('button', {
          type: 'button',
          class: 'knapp knapp-fylt',
          tekst: sk.lagrer ? 'Lagrer …' : 'Lagre',
          disabled: !f?.kan || sk.lagrer ? true : null,
          title: f?.kan ? null : 'Forhåndsvis først',
          onclick: () => lagre(h),
        }),
        h.el('button', {
          type: 'button',
          class: 'knapp knapp-kontur',
          tekst: 'Avbryt',
          onclick: () => {
            s.ureg.skjema = null;
            h.tegn({ fokus: `ureg:${sk.type}:${sk.sti}` });
          },
        }),
      ),
      f && !f.laster
        ? h.el(
            'div',
            { class: 'ureg-forhand', tabindex: '-1', 'data-fokus': 'ureg-forhand', role: 'status' },
            f.feil.length
              ? h.el('ul', { class: 'ureg-feil' }, ...f.feil.map((t) => h.el('li', { tekst: t })))
              : h.el('p', {
                  tekst: `Forhåndsvisning, ingenting er lagret ennå: ${f.endringer.length === 1 ? 'én endring' : `${f.endringer.length} endringer`}.`,
                }),
            f.endringer.length
              ? h.el(
                  'ul',
                  { class: 'planer-detalj-liste' },
                  ...f.endringer.map((e) =>
                    h.el('li', {
                      tekst:
                        e.felt === '*'
                          ? `${e.id}: ny post «${e.etter?.tittel ?? ''}»`
                          : `${e.id}: ${e.felt} endres`,
                    }),
                  ),
                )
              : null,
            (f.advarsler ?? []).length
              ? h.el(
                  'ul',
                  { class: 'ureg-advarsler' },
                  ...f.advarsler.map((t) => h.el('li', { tekst: `Advarsel: ${t}` })),
                )
              : null,
          )
        : null,
    );
  }

  function radEl(h, d, sti) {
    const sk = s.ureg.skjema?.sti === sti ? s.ureg.skjema : null;
    const leses = s.vis.ureg?.sti === sti;
    const knapp = (type, tekst, etikett) =>
      h.el('button', {
        type: 'button',
        class: 'knapp-liten knapp-kontur',
        tekst,
        'aria-label': etikett,
        'aria-expanded': sk?.type === type ? 'true' : 'false',
        'data-fokus': `ureg:${type}:${sti}`,
        onclick: () => nyttSkjema(h, d, sti, type),
      });
    return h.el(
      'li',
      { class: `ureg-rad${sk || leses ? ' les-valgt' : ''}` },
      h.el(
        'div',
        { class: 'planer-kilde' },
        h.el('code', { tekst: sti }),
        h.el('button', {
          type: 'button',
          class: 'knapp-liten knapp-kontur',
          tekst: leses ? 'Leses' : 'Les',
          'aria-pressed': leses ? 'true' : 'false',
          'aria-label': `Les ${sti}`,
          'data-fokus': `ureg:les:${sti}`,
          onclick: () => {
            if (leses) {
              delete s.vis.ureg;
              h.tegn({ fokus: `ureg:les:${sti}` });
            } else {
              s.vis.ureg = null;
              apne(h, 'ureg', sti, null, { tilbake: false });
            }
          },
        }),
        knapp('ny', 'Ny post', `Ny planpost med ${sti} som kilde`),
        knapp('kilde', 'Legg til som kilde', `Legg ${sti} til som kilde på en planpost`),
        h.kopierKnapp(sti, `Kopier stien ${sti}`),
      ),
      sk ? skjemaEl(h, d, sk) : null,
      leses ? visningEl(h, 'ureg') : null,
    );
  }

  /** Uregistrert-boksen over listen (bare på flaten Planposter). Lukket som standard, med antallet synlig. */
  function uregistrertBoks(h, d) {
    const u = s.ureg;
    if (u.versjon !== (d.endret ?? null) && !u.henter) hentUregistrert(h, d.endret ?? null);
    const liste = u.data?.uregistrert ?? [];
    const antall = u.data ? liste.length : null;
    const tittel =
      antall == null
        ? u.feil
          ? 'Uregistrert: kunne ikke sjekke'
          : 'Uregistrert: sjekker …'
        : antall === 0
          ? 'Uregistrert: ingen, alle dokumentene har en planpost'
          : `Uregistrert: ${antall} ${antall === 1 ? 'dokument' : 'dokumenter'} uten planpost`;
    const apen = u.apen && antall !== 0;
    return h.el(
      'section',
      { class: `ureg${antall ? ' har-ureg' : ''}`, 'aria-label': 'Uregistrerte dokumenter' },
      h.el(
        'h2',
        { class: 'ureg-tittel' },
        h.el(
          'button',
          {
            type: 'button',
            class: 'ureg-veksle',
            'aria-expanded': apen ? 'true' : 'false',
            'aria-controls': 'ureg-innhold',
            disabled: antall === 0 ? true : null,
            'data-fokus': 'ureg-veksle',
            onclick: () => {
              u.apen = !u.apen;
              settFlagg(BOKS_LAGRING, u.apen);
              h.tegn({ fokus: 'ureg-veksle' });
            },
          },
          h.el('span', { class: 'ureg-pil', 'aria-hidden': 'true', tekst: apen ? '▾' : '▸' }),
          // Antallet står i teksten (aldri bare som farge).
          h.el('span', { tekst: tittel }),
        ),
      ),
      apen
        ? h.el(
            'div',
            { id: 'ureg-innhold', class: 'ureg-innhold' },
            h.el('p', {
              class: 'planer-hjelp',
              tekst:
                'Dokumenter i dokumentmappene som ingen planpost peker til (ko.mjs plan sjekk). Lag en ny post, eller legg dokumentet til som kilde på en post som finnes.',
            }),
            u.feil ? h.el('p', { class: 'les-feil', role: 'alert', tekst: u.feil }) : null,
            ...(u.data?.grupper ?? []).map((g) =>
              h.el(
                'div',
                { class: 'ureg-gruppe' },
                h.el('h3', {
                  class: 'planer-rute-tittel',
                  tekst: `${g.tekst} (${g.stier.length})`,
                }),
                h.el('ul', { class: 'ureg-liste' }, ...g.stier.map((sti) => radEl(h, d, sti))),
              ),
            ),
          )
        : null,
    );
  }

  window.KoPlanLes = { kildeFane, uregistrertBoks };
})();
