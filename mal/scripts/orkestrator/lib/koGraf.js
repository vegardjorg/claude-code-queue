// =============================================================
// koGraf.js: ren logikk for visningen «Avhengigheter» på kanban-tavla.
//
// Tegner køen som sirkler (oppgaver) og avrundede firkanter (eierspørsmål) med streker fra forgjenger til
// etterfølger. Her står bare grafen og oppsettet; ingen køregler:
//   - byggGraf: hvilke noder og kanter som vises. Inndata er tilstanden fra koTavle.tavle (kortene har allerede
//     `klar`, `hindringer`, `laaser_opp` og `kjede` fra koLogikk/koTavle, og innboksen har eierspørsmålene med
//     «låser opp N»), så ingen regel kopieres hit.
//   - lagdel: lagdelt oppsett fra venstre mot høyre. Lagene gis av lengste sti, rekkefølgen i hvert lag av noen
//     sveip med barysenter (færre kryssinger). Deterministisk: samme graf gir samme bilde. Sykler brytes og meldes.
//   - grafTall: oppsummeringen øverst (oppgaver i kjeder, eierspørsmål som blokkerer, lengste kjede).
//
// Fila er både et CommonJS-modul (jest, scripts/lib/__tests__/koGraf.test.ts) og et skript i nettleseren
// (ko-tavle.mjs serverer den som /koGraf.js og den setter window.KoGraf), så klienten bruker nøyaktig samme kode.
// Klienten regner oppsettet én gang per køendring og filter (cache på versjonen), aldri per tegning.
// =============================================================
(function (rot, fabrikk) {
  if (typeof module === 'object' && module.exports) module.exports = fabrikk();
  else rot.KoGraf = fabrikk();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Kolonnene i tavla som har oppgaver med i grafen (forslag er ikke godkjent ennå og står utenfor).
   * Samlekøen er med, med egen tilstand («samle») og eget merke, så eieren ser hva i en kjede som venter på pakking.
   */
  const KOLONNER = ['ko', 'samle', 'pagar', 'review', 'bygget'];
  /** Id-en til en spørsmålsnode: «?» + spørsmålets id (en oppgave-id kan aldri starte med «?»). */
  const SP = '?';

  /** Mål i oppsettet (piksler i grafens egne koordinater, før zoom). */
  const MAAL = {
    lagAvstand: 170, // mellom lagene (x)
    luft: 20, // mellom to noder i samme lag (y), med plass til etiketten under
    marg: 40,
    baneTopp: 30, // plass til båndets tittel
    baneLuft: 16, // mellom to bånd
    rMin: 7,
    rMaks: 22,
    rLiten: 5, // ferdige forgjengere og naboer utenfor filteret
    rFri: 12, // største sirkel i rutenettet for frittstående
    friCelle: 34,
    spSide: 26, // spørsmålsnodens side
    kompSide: 30, // fra komponentens ramme til første og siste lag (x), med plass til id-en under
    kompTopp: 22, // over øverste node i komponenten (spørsmålets id står over firkanten)
    kompBunn: 24, // under nederste node (id-en eller «låser opp N»)
    kompLuft: 24, // mellom to komponenter i pakkingen
    lesbarPx: 6, // minste sirkeldiameter på skjermen (piksler) som regnes som lesbar ved «Tilpass»
  };

  /** Radius etter anslåtte minutter: arealet følger minuttene, med min- og maksgrense. */
  function radius(minutter) {
    const m = Number(minutter);
    const r = Math.sqrt(Number.isFinite(m) && m > 0 ? m : 0) * 2.2;
    return Math.round(Math.min(MAAL.rMaks, Math.max(MAAL.rMin, r)) * 10) / 10;
  }

  /**
   * Tilstanden ringen viser: klar (hel), blokkert (stiplet), aktiv (tykk aksent), qa (liten prikk), ferdig, eller
   * samle (i samlekøen: prikket ring og merket «S»).
   */
  function tilstandFor(k, kol) {
    if (k.status === 'ferdig') return k.qa_status === 'venter' ? 'qa' : 'ferdig';
    if (kol === 'samle') return 'samle';
    if (kol === 'ko') return k.klar ? 'klar' : 'blokkert';
    return 'aktiv'; // kjører, plukket, review, utenfor køen
  }

  const sammenlign = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const kantNokkel = (fra, til) => `${fra}\u0000${til}`;

  /**
   * Nodene og kantene som skal vises.
   * @param {object} data tilstanden fra koTavle.tavle ({ kolonner, innboks, prosjekter })
   * @param {{ synlig?: (kort: object, kol: string) => boolean, visFerdige?: boolean, visFrittstaende?: boolean,
   *   naboer?: boolean }} valg
   *   `synlig`: søket og filtermenyen på tavla (prosjektfilteret er «per kategori»). `visFerdige`: ferdige forgjengere
   *   som små, dempede sirkler. `visFrittstaende`: oppgaver uten avhengigheter som et rutenett til slutt. `naboer`:
   *   en forgjenger eller etterfølger som filteret skjuler, vises som en liten grå nabo så kjeden ikke brytes.
   * @returns {{ noder: object[], kanter: object[], prosjekter: object[] }}
   *   Node: { id, art: 'oppgave'|'sporsmal', rolle: 'kjerne'|'nabo'|'ferdig'|'fri', ... }.
   *   Kant: { fra, til, art: 'avh'|'sp', dempet }.
   */
  function byggGraf(
    data,
    { synlig = () => true, visFerdige = false, visFrittstaende = false, naboer = true } = {},
  ) {
    const perId = new Map();
    for (const kol of KOLONNER)
      for (const k of data?.kolonner?.[kol] ?? []) perId.set(k.id, { k, kol });
    const aapen = (x) => !!x && x.k.status !== 'ferdig';

    // Kantene inn til åpne oppgaver: forgjenger → etterfølger (ukjente og kansellerte forgjengere er ikke med).
    const avh = [];
    const iKjede = new Set();
    for (const [id, x] of perId) {
      if (!aapen(x)) continue;
      for (const f of new Set(x.k.avhenger ?? [])) {
        if (f === id || !perId.has(f)) continue;
        avh.push({ fra: f, til: id });
        iKjede.add(f);
        iKjede.add(id);
      }
    }
    // Eierspørsmålene fra innboksen (åpne, med «låser opp N»), med kanter til oppgavene som venter direkte.
    const sporsmal = [];
    for (const s of data?.innboks?.sporsmal ?? []) {
      const til = [...new Set(s.direkte ?? [])].filter((id) => aapen(perId.get(id))).sort();
      if (!til.length) continue;
      sporsmal.push({ s, til });
      for (const id of til) iKjede.add(id);
    }

    // Kjernen: åpne oppgaver i en kjede som filteret viser.
    const rolle = new Map();
    for (const [id, x] of perId)
      if (aapen(x) && iKjede.has(id) && synlig(x.k, x.kol)) rolle.set(id, 'kjerne');
    // Naboer (åpne, skjult av filteret) og ferdige forgjengere, én kant unna kjernen.
    for (const { fra, til } of avh) {
      const f = perId.get(fra);
      if (rolle.get(til) === 'kjerne' && !rolle.has(fra)) {
        if (!aapen(f)) {
          if (visFerdige) rolle.set(fra, 'ferdig');
        } else if (naboer) rolle.set(fra, 'nabo');
      } else if (rolle.get(fra) === 'kjerne' && !rolle.has(til) && naboer) rolle.set(til, 'nabo');
    }
    if (visFrittstaende)
      for (const [id, x] of perId)
        if (aapen(x) && !iKjede.has(id) && synlig(x.k, x.kol)) rolle.set(id, 'fri');

    const noder = [];
    for (const [id, r] of rolle) {
      const { k, kol } = perId.get(id);
      const liten = r === 'nabo' || r === 'ferdig';
      noder.push({
        id,
        art: 'oppgave',
        rolle: r,
        tilstand: tilstandFor(k, kol),
        status: k.status,
        tittel: k.tittel ?? '',
        prosjekt: k.prosjekt ?? null,
        farge: k.farge ?? null,
        anslag: Number(k.anslag) || 0,
        laaser: k.laaser_opp?.antall ?? 0,
        r: liten
          ? MAAL.rLiten
          : r === 'fri'
            ? Math.min(MAAL.rFri, radius(k.anslag))
            : radius(k.anslag),
      });
    }
    const kanter = [];
    for (const { fra, til } of avh)
      if (rolle.has(fra) && rolle.has(til))
        kanter.push({ fra, til, art: 'avh', dempet: rolle.get(fra) === 'ferdig' });
    // Et spørsmål vises når minst én oppgave i kjernen venter på det.
    for (const { s, til } of sporsmal) {
      if (!til.some((id) => rolle.get(id) === 'kjerne')) continue;
      const id = SP + s.sp;
      noder.push({
        id,
        art: 'sporsmal',
        rolle: 'kjerne',
        sp: s.sp,
        type: s.type ?? 'sporsmal',
        tekst: s.tekst ?? null,
        tittel: s.tekst ?? s.sp,
        prosjekt: (s.prosjekter ?? [])[0] ?? null,
        laaser: Number(s.antall) || 0,
        r: MAAL.spSide / 2,
      });
      for (const t of til)
        if (rolle.has(t)) kanter.push({ fra: id, til: t, art: 'sp', dempet: false });
    }
    noder.sort((a, b) => sammenlign(a.id, b.id));
    kanter.sort((a, b) => sammenlign(a.fra, b.fra) || sammenlign(a.til, b.til));
    const prosjekter = (data?.prosjekter ?? []).map((p) => ({
      pid: p.pid,
      tittel: p.tittel ?? p.pid,
      farge: p.farge ?? null,
    }));
    return { noder, kanter, prosjekter };
  }

  /**
   * Lagene: topologisk rekkefølge (Kahn) der en sykel brytes ved noden med færrest gjenværende innkanter (så lavest
   * id), og lengste sti fra kildene. En kilde uten forgjengere trekkes så langt til høyre som etterfølgerne tillater
   * (et spørsmål står rett før oppgaven som venter på det, ikke helt til venstre).
   * @returns {{ lag: Map<string, number>, brutt: Set<string> }}
   */
  function lagFor(ider, kanter) {
    const inn = new Map(ider.map((id) => [id, []]));
    const ut = new Map(ider.map((id) => [id, []]));
    for (const { fra, til } of kanter) {
      if (!inn.has(fra) || !inn.has(til)) continue;
      ut.get(fra).push(til);
      inn.get(til).push(fra);
    }
    const grad = new Map(ider.map((id) => [id, inn.get(id).length]));
    const brutt = new Set();
    const ferdig = new Set();
    const rekke = [];
    let klare = ider.filter((id) => grad.get(id) === 0);
    while (rekke.length < ider.length) {
      if (!klare.length) {
        // Sykel: bryt innkantene fra de ubehandlede nodene til én node, og fortsett derfra.
        const rest = ider.filter((id) => !ferdig.has(id));
        rest.sort((a, b) => grad.get(a) - grad.get(b) || sammenlign(a, b));
        const v = rest[0];
        for (const f of inn.get(v)) if (!ferdig.has(f)) brutt.add(kantNokkel(f, v));
        grad.set(v, 0);
        klare = [v];
      }
      const v = klare.shift();
      if (ferdig.has(v)) continue;
      ferdig.add(v);
      rekke.push(v);
      for (const w of ut.get(v)) {
        if (brutt.has(kantNokkel(v, w)) || ferdig.has(w)) continue;
        grad.set(w, grad.get(w) - 1);
        if (grad.get(w) === 0) klare.push(w);
      }
      klare.sort(sammenlign);
    }
    const lag = new Map();
    for (const v of rekke) {
      let l = 0;
      for (const f of inn.get(v)) if (!brutt.has(kantNokkel(f, v))) l = Math.max(l, lag.get(f) + 1);
      lag.set(v, l);
    }
    for (let i = rekke.length - 1; i >= 0; i--) {
      const v = rekke[i];
      const forgj = inn.get(v).filter((f) => !brutt.has(kantNokkel(f, v)));
      const etter = ut.get(v).filter((w) => !brutt.has(kantNokkel(v, w)));
      if (!forgj.length && etter.length) lag.set(v, Math.min(...etter.map((w) => lag.get(w))) - 1);
    }
    return { lag, brutt };
  }

  /**
   * Koordinatene. Grafen deles i sammenhengende komponenter (en kjede: noder koblet med kanter, uansett
   * retning), og hver komponent får sitt eget lagdelte oppsett fra venstre mot høyre. Komponentene pakkes så i rader
   * («hylle»-pakking), største først, med en radbredde valgt slik at hele bildet passer best i visningsflaten
   * (`flate`: { bredde, hoyde } i piksler, standard 1600 × 800). Uten pakkingen stod alle kildene i én høy søyle.
   * `modus`: 'samlet' (alt i ett) eller 'prosjekt' (ett bånd per prosjekt i tavlas baneordning, stablet med full
   * bredde, med samme pakking inne i hvert bånd). En komponent med flere prosjekter legges i båndet til prosjektet med
   * flest noder (grå naboer teller ikke); kantene til de andre prosjektenes noder står da inne i båndet.
   * @returns {{ noder: object[], kanter: object[], baner: object[], komponenter: object[],
   *   fri: { y: number, antall: number } | null, sykler: { fra: string, til: string }[], antallLag: number,
   *   bredde: number, hoyde: number }}
   *   `lesbarSkala`: minste skala der de fleste sirklene (90 % av kjernen) er minst MAAL.lesbarPx; «Tilpass» fyller
   *   bredden og lar resten rulles når hele bildet ikke kan vises så stort.
   *   `noder` står komponent for komponent (pakkerekkefølgen), i hver komponent i lag-rekkefølge (lag, så ovenfra), og
   *   frittstående sist: tastaturets fokusrekkefølge. `lag` er laget inne i komponenten. `komponenter` er rammene
   *   ({ x, y, bredde, hoyde, antall }) som tegnes som en diskret bakgrunn.
   */
  function lagdel(graf, { modus = 'samlet', flate = null } = {}) {
    const perBane = modus === 'prosjekt';
    const alle = graf?.noder ?? [];
    const iGraf = alle.filter((n) => n.rolle !== 'fri');
    const frie = alle.filter((n) => n.rolle === 'fri');
    const perId = new Map(alle.map((n) => [n.id, n]));
    const ider = iGraf.map((n) => n.id).sort(sammenlign);
    const { lag, brutt } = lagFor(ider, graf?.kanter ?? []);

    const baneRekke = new Map((graf?.prosjekter ?? []).map((p, i) => [p.pid, i]));
    const baneFor = (id) => {
      const i = baneRekke.get(perId.get(id)?.prosjekt);
      return i == null ? baneRekke.size : i;
    };

    // Naboene i begge retninger (brutte sykelkanter teller ikke i rekkefølgen, men holder komponenten sammen), og
    // komponentene (union-find; roten er alltid laveste id, så inndelingen er deterministisk).
    const forgj = new Map(ider.map((id) => [id, []]));
    const etter = new Map(ider.map((id) => [id, []]));
    const rot = new Map(ider.map((id) => [id, id]));
    const finn = (id) => {
      let r = id;
      while (rot.get(r) !== r) r = rot.get(r);
      rot.set(id, r);
      return r;
    };
    for (const { fra, til } of graf?.kanter ?? []) {
      if (!forgj.has(fra) || !forgj.has(til)) continue;
      const a = finn(fra);
      const b = finn(til);
      if (a !== b) rot.set(a < b ? b : a, a < b ? a : b);
      if (brutt.has(kantNokkel(fra, til))) continue;
      etter.get(fra).push(til);
      forgj.get(til).push(fra);
    }
    const grupper = new Map();
    for (const id of ider) {
      const r = finn(id);
      if (!grupper.has(r)) grupper.set(r, []);
      grupper.get(r).push(id);
    }

    // y: nodene stables i laget (radius + luft + radius).
    const stable = (ids) => {
      const ys = [];
      let y = 0;
      ids.forEach((id, i) => {
        const r = perId.get(id).r;
        if (i > 0) y += perId.get(ids[i - 1]).r + MAAL.luft + r;
        ys.push(y);
      });
      const topp = ids.length ? perId.get(ids[0]).r : 0;
      const bunn = ids.length ? ys[ys.length - 1] + perId.get(ids[ids.length - 1]).r : 0;
      return { ys, topp, hoyde: topp + bunn };
    };

    // Én komponent: lagene (lengste sti, forskjøvet så komponenten starter i lag 0), startrekkefølge etter prosjekt
    // (baneordning) og id, fire barysenter-sveip ned (etter forgjengerne) og opp (etter etterfølgerne), og lagene
    // sentrert loddrett. Koordinatene er lokale; pakkingen forskyver dem.
    const lokal = new Map();
    const leggUt = (ids) => {
      const forste = Math.min(...ids.map((id) => lag.get(id)));
      const antallLag = Math.max(...ids.map((id) => lag.get(id))) - forste + 1;
      const lagene = Array.from({ length: antallLag }, () => []);
      for (const id of ids) lagene[lag.get(id) - forste].push(id);
      for (const l of lagene) l.sort((a, b) => baneFor(a) - baneFor(b) || sammenlign(a, b));
      const plass = new Map();
      const oppdaterPlass = (l) => l.forEach((id, i) => plass.set(id, i - (l.length - 1) / 2));
      lagene.forEach(oppdaterPlass);
      // Lik verdi beholder forrige rekkefølge (stabil sortering).
      const sveip = (l, naboer) => {
        const verdi = new Map();
        for (const id of l) {
          const n = naboer.get(id);
          verdi.set(
            id,
            n.length ? n.reduce((s, x) => s + plass.get(x), 0) / n.length : plass.get(id),
          );
        }
        const forrige = new Map(l.map((id, i) => [id, i]));
        l.sort((a, b) => verdi.get(a) - verdi.get(b) || forrige.get(a) - forrige.get(b));
        oppdaterPlass(l);
      };
      for (let runde = 0; runde < 4; runde++) {
        for (let i = 1; i < antallLag; i++) sveip(lagene[i], forgj);
        for (let i = antallLag - 2; i >= 0; i--) sveip(lagene[i], etter);
      }
      const stabler = lagene.map(stable);
      const hoyest = Math.max(0, ...stabler.map((s) => s.hoyde));
      lagene.forEach((l, i) => {
        const s = stabler[i];
        const start = MAAL.kompTopp + (hoyest - s.hoyde) / 2 + s.topp;
        l.forEach((id, j) =>
          lokal.set(id, { x: MAAL.kompSide + i * MAAL.lagAvstand, y: start + s.ys[j], lag: i }),
        );
      });
      // Båndet per prosjekt: prosjektet med flest noder (grå naboer teller bare når det ikke finnes andre).
      const telling = new Map();
      const tell = (liste) => {
        for (const id of liste) telling.set(baneFor(id), (telling.get(baneFor(id)) ?? 0) + 1);
      };
      tell(ids.filter((id) => perId.get(id).rolle !== 'nabo'));
      if (!telling.size) tell(ids);
      let bane = Infinity;
      for (const [b, n] of telling)
        if (bane === Infinity || n > telling.get(bane) || (n === telling.get(bane) && b < bane))
          bane = b;
      return {
        ids,
        antallLag,
        bane: perBane ? bane : 0,
        bredde: 2 * MAAL.kompSide + (antallLag - 1) * MAAL.lagAvstand,
        hoyde: MAAL.kompTopp + hoyest + MAAL.kompBunn,
      };
    };
    // Største først (noder, så høyde), så laveste id: små kjeder havner sist, i kompakte rader.
    const komps = [...grupper.values()]
      .map(leggUt)
      .sort(
        (a, b) =>
          b.ids.length - a.ids.length || b.hoyde - a.hoyde || sammenlign(a.ids[0], b.ids[0]),
      );
    const brukte = [...new Set(komps.map((k) => k.bane))].sort((a, b) => a - b);
    const perGruppe = brukte.map((b) => komps.filter((k) => k.bane === b));

    // Hylle-pakking med radbredde W: fra venstre til høyre, ny rad når neste ikke får plass.
    const pakk = (liste, W) => {
      const plass = [];
      let x = 0;
      let y = 0;
      let rad = 0;
      let bredest = 0;
      for (const k of liste) {
        if (x > 0 && x + k.bredde > W) {
          y += rad + MAAL.kompLuft;
          x = 0;
          rad = 0;
        }
        plass.push({ x, y });
        bredest = Math.max(bredest, x + k.bredde);
        x += k.bredde + MAAL.kompLuft;
        rad = Math.max(rad, k.hoyde);
      }
      return { plass, bredde: bredest, hoyde: liste.length ? y + rad : 0 };
    };
    const maal = (W) => {
      const pakker = perGruppe.map((g) => pakk(g, W));
      const bredde = MAAL.marg * 2 + Math.max(0, ...pakker.map((p) => p.bredde));
      const hoyde = perBane
        ? MAAL.marg +
          pakker.reduce((s, p) => s + MAAL.baneTopp + p.hoyde + 2 * MAAL.baneLuft, 0) -
          MAAL.baneLuft
        : MAAL.marg * 2 + (pakker[0]?.hoyde ?? 0);
      return { W, pakker, bredde, hoyde };
    };
    // Radbredden. Kandidatene vokser geometrisk fra bredeste komponent. Førstevalget er den som gir størst skala når
    // hele bildet tilpasses flaten (lik skala: smalest). Blir sirklene da uleselige (skalaen under `lesbarSkala`),
    // velges i stedet den laveste pakkingen som ved lesbar skala fortsatt fyller bredden: «Tilpass» fyller da bredden,
    // og man ruller loddrett.
    const fb = flate?.bredde > 0 ? flate.bredde : 1600;
    const fh = flate?.hoyde > 0 ? flate.hoyde : 800;
    const diametre = iGraf
      .filter((n) => n.rolle === 'kjerne')
      .map((n) => 2 * n.r)
      .sort((a, b) => a - b);
    const lesbarSkala =
      MAAL.lesbarPx / (diametre[Math.floor(diametre.length * 0.1)] ?? 2 * MAAL.rMin);
    let valgt = null;
    if (komps.length) {
      const fra = Math.max(...komps.map((k) => k.bredde));
      const til = Math.max(
        fra,
        ...perGruppe.map((g) => g.reduce((s, k) => s + k.bredde + MAAL.kompLuft, 0)),
      );
      const kandidater = [];
      for (let W = fra; ; W = Math.min(til, W * 1.08)) {
        kandidater.push(maal(W));
        if (W >= til) break;
      }
      const iBredden = (m) => fb / (m.bredde + 20);
      const skala = (m) => Math.min(iBredden(m), fh / (m.hoyde + 20));
      for (const m of kandidater) if (!valgt || skala(m) > skala(valgt) * (1 + 1e-9)) valgt = m;
      if (skala(valgt) < lesbarSkala) {
        const lesbare = kandidater.filter((m) => iBredden(m) >= lesbarSkala);
        valgt = lesbare.length
          ? lesbare.reduce((a, m) => (m.hoyde < a.hoyde - 1e-9 ? m : a))
          : kandidater[0];
      }
    }

    // Forskyv hver komponent til plassen sin (per prosjekt: inne i båndet, bånd under bånd).
    const pos = new Map();
    const komponenter = [];
    const baner = [];
    const rekke = [];
    const bredde = valgt ? valgt.bredde : 0;
    const plasser = (k, ox, oy) => {
      komponenter.push({ x: ox, y: oy, bredde: k.bredde, hoyde: k.hoyde, antall: k.ids.length });
      const ids = [...k.ids].sort(
        (a, b) =>
          lokal.get(a).lag - lokal.get(b).lag ||
          lokal.get(a).y - lokal.get(b).y ||
          sammenlign(a, b),
      );
      for (const id of ids) {
        const p = lokal.get(id);
        pos.set(id, { x: ox + p.x, y: oy + p.y, lag: p.lag });
        rekke.push(id);
      }
    };
    let hoyde = 0;
    if (valgt && !perBane) {
      perGruppe[0].forEach((k, i) =>
        plasser(k, MAAL.marg + valgt.pakker[0].plass[i].x, MAAL.marg + valgt.pakker[0].plass[i].y),
      );
      hoyde = valgt.hoyde;
    } else if (valgt) {
      let y = MAAL.marg / 2;
      brukte.forEach((b, gi) => {
        const pk = valgt.pakker[gi];
        perGruppe[gi].forEach((k, i) =>
          plasser(k, MAAL.marg + pk.plass[i].x, y + MAAL.baneTopp + pk.plass[i].y),
        );
        const p = (graf?.prosjekter ?? [])[b];
        const h = MAAL.baneTopp + pk.hoyde + MAAL.baneLuft;
        baner.push({
          pid: p?.pid ?? null,
          tittel: p ? p.tittel : 'Uten kjent prosjekt',
          farge: p?.farge ?? null,
          y,
          hoyde: h,
        });
        y += h + MAAL.baneLuft;
      });
      hoyde = y + MAAL.marg / 2;
    }

    // Frittstående: et kompakt rutenett under grafen, ordnet etter prosjekt (baneordning) og id.
    let fri = null;
    const friRekke = [...frie].sort(
      (a, b) => baneFor(a.id) - baneFor(b.id) || sammenlign(a.id, b.id),
    );
    let friBredde = 0;
    if (friRekke.length) {
      const kolonner = Math.max(12, Math.floor(Math.max(bredde, 600) / MAAL.friCelle));
      const topp = hoyde + MAAL.baneTopp;
      friRekke.forEach((n, i) => {
        pos.set(n.id, {
          x: MAAL.marg + (i % kolonner) * MAAL.friCelle,
          y: topp + MAAL.friCelle / 2 + Math.floor(i / kolonner) * MAAL.friCelle,
          lag: null,
        });
      });
      const rader = Math.ceil(friRekke.length / kolonner);
      fri = { y: hoyde, antall: friRekke.length };
      friBredde = MAAL.marg * 2 + Math.min(kolonner, friRekke.length) * MAAL.friCelle;
      hoyde = topp + rader * MAAL.friCelle + MAAL.marg;
    }

    const noder = rekke
      .map((id) => ({ ...perId.get(id), ...pos.get(id) }))
      .concat(friRekke.map((n) => ({ ...n, ...pos.get(n.id) })));
    const kanter = (graf?.kanter ?? [])
      .filter((k) => pos.has(k.fra) && pos.has(k.til))
      .map((k) => ({ ...k, sykel: brutt.has(kantNokkel(k.fra, k.til)) }));
    const sykler = kanter.filter((k) => k.sykel).map((k) => ({ fra: k.fra, til: k.til }));
    return {
      noder,
      kanter,
      baner,
      komponenter,
      fri,
      sykler,
      antallLag: Math.max(0, ...komps.map((k) => k.antallLag)),
      lesbarSkala,
      bredde: Math.max(bredde, friBredde),
      hoyde,
    };
  }

  /**
   * Oppsummeringen øverst: «N oppgaver i kjeder · M eierspørsmål blokkerer K oppgaver · lengste kjede L ledd».
   *   - oppgaver: oppgavene i kjernen (i en kjede, vist av filteret),
   *   - sporsmal / blokkertAvSporsmal: spørsmålsnodene og oppgavene i kjernen de holder igjen, direkte eller via
   *     kjeden,
   *   - lengsteKjede: flest åpne oppgaver etter hverandre langs avhengighetene (sykler tåles),
   *   - blokkert: oppgavene i kjernen som ikke er klare nå.
   */
  function grafTall(graf) {
    const noder = graf?.noder ?? [];
    const kanter = graf?.kanter ?? [];
    const perId = new Map(noder.map((n) => [n.id, n]));
    const aapenOppgave = (n) =>
      n?.art === 'oppgave' && (n.rolle === 'kjerne' || n.rolle === 'nabo');
    const ut = new Map();
    for (const k of kanter) {
      if (!ut.has(k.fra)) ut.set(k.fra, []);
      ut.get(k.fra).push(k.til);
    }
    // Det spørsmålene holder igjen: alt som nås fra dem langs kantene (åpne oppgaver).
    const holdt = new Set();
    const stakk = noder.filter((n) => n.art === 'sporsmal').map((n) => n.id);
    while (stakk.length) {
      const v = stakk.pop();
      for (const w of ut.get(v) ?? []) {
        if (holdt.has(w) || !aapenOppgave(perId.get(w))) continue;
        holdt.add(w);
        stakk.push(w);
      }
    }
    // Lengste kjede: dybde-først med minne; en kant tilbake til en node på stien (sykel) hoppes over.
    const lengde = new Map();
    const paaStien = new Set();
    const lengst = (v) => {
      if (lengde.has(v)) return lengde.get(v);
      paaStien.add(v);
      let best = 0;
      for (const w of ut.get(v) ?? [])
        if (!paaStien.has(w) && aapenOppgave(perId.get(w))) best = Math.max(best, lengst(w));
      paaStien.delete(v);
      lengde.set(v, best + 1);
      return best + 1;
    };
    let lengsteKjede = 0;
    for (const n of [...noder].sort((a, b) => sammenlign(a.id, b.id)))
      if (aapenOppgave(n)) lengsteKjede = Math.max(lengsteKjede, lengst(n.id));
    const kjerne = noder.filter((n) => n.art === 'oppgave' && n.rolle === 'kjerne');
    return {
      oppgaver: kjerne.length,
      sporsmal: noder.filter((n) => n.art === 'sporsmal').length,
      blokkertAvSporsmal: [...holdt].filter((id) => perId.get(id)?.rolle === 'kjerne').length,
      lengsteKjede,
      blokkert: kjerne.filter((n) => n.tilstand === 'blokkert').length,
    };
  }

  /**
   * den kritiske veien, altså den tyngste stien langs kantene (forgjenger → etterfølger) målt i summen av
   * nodenes vekt. Brukes av avhengighetsvisningen i Planer-rommet (planposter med estimat som vekt), men er generell.
   *   - `med(n)`: om noden kan stå på veien (f.eks. bare åpne poster). Andre noder brytes av: veien går aldri gjennom
   *     dem.
   *   - `vekt(n)`: nodens vekt (tall ≥ 0).
   * Sykler tåles: en kant tilbake til en node på stien hoppes over (som `lengsteKjede` i grafTall). Deterministisk:
   * ved lik sum vinner stien med flest noder, så laveste id (nodene og etterfølgerne gås gjennom i id-rekkefølge).
   * @returns {{ sti: string[], sum: number, kanter: string[] }} `kanter` er «fra>til» for kantene på stien.
   */
  function kritiskVei(noder, kanter, { med = () => true, vekt = () => 1 } = {}) {
    const perId = new Map((noder ?? []).map((n) => [n.id, n]));
    const ok = (id) => perId.has(id) && med(perId.get(id));
    const ut = new Map();
    for (const k of kanter ?? []) {
      if (!ok(k.fra) || !ok(k.til) || k.fra === k.til) continue;
      if (!ut.has(k.fra)) ut.set(k.fra, new Set());
      ut.get(k.fra).add(k.til);
    }
    const v = (id) => {
      const x = Number(vekt(perId.get(id)));
      return Number.isFinite(x) && x > 0 ? x : 0;
    };
    // Beste sti fra hver node: { sum, ider }. Dybde-først med minne; noder på stien hoppes over (sykler).
    const minne = new Map();
    const paaStien = new Set();
    const bedre = (a, b) =>
      !b ||
      a.sum > b.sum + 1e-9 ||
      (Math.abs(a.sum - b.sum) <= 1e-9 &&
        (a.ider.length > b.ider.length ||
          (a.ider.length === b.ider.length && a.ider.join('\u0000') < b.ider.join('\u0000'))));
    const beste = (id) => {
      if (minne.has(id)) return minne.get(id);
      paaStien.add(id);
      let best = null;
      for (const w of [...(ut.get(id) ?? [])].sort(sammenlign)) {
        if (paaStien.has(w)) continue;
        const b = beste(w);
        if (bedre(b, best)) best = b;
      }
      paaStien.delete(id);
      const svar = { sum: v(id) + (best?.sum ?? 0), ider: [id, ...(best?.ider ?? [])] };
      minne.set(id, svar);
      return svar;
    };
    let vinner = null;
    for (const id of [...perId.keys()].filter(ok).sort(sammenlign)) {
      const b = beste(id);
      if (bedre(b, vinner)) vinner = b;
    }
    if (!vinner) return { sti: [], sum: 0, kanter: [] };
    const sti = vinner.ider;
    return {
      sti,
      sum: Math.round(vinner.sum * 100) / 100,
      kanter: sti.slice(1).map((til, i) => `${sti[i]}>${til}`),
    };
  }

  return { KOLONNER, SP, MAAL, radius, byggGraf, lagdel, grafTall, kritiskVei };
});
