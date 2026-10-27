// =============================================================
// koStatistikk.js: statistikken på kanban-tavla for arbeidskøen (scripts/orkestrator/ko-tavle.mjs).
//
// Rene funksjoner uten I/O. Serveren leser ko.json og tidsloggen (via scripts/orkestrator/lib/tidKost.js) én gang,
// cacher på mtime og kaller `statistikk`. Ingen regler er kopiert hit:
//   - anslaget er koLogikk.anslag (innhold_min × klassevekt),
//   - forbruket er tidKost.forbruksHendelser (samme tall som budsjettvakta og `logg-tid.mjs --kost`),
//   - nattvinduet er koLogikk.tolkNattvindu / iNattvindu (samme som nattvakta),
//   - datoene er lokal dato (tidKost.dagFor).
// Median er hovedtallet (tåler uteliggere); snittet står ved siden av. Oppgaver uten `startet` (gjort utenfor køen)
// eller med manglende eller umulige tider telles ikke i tidene, og antallet som ble utelatt, står i svaret.
// Inn mot ut (lagt til og ferdige per dag), median tid fra spørsmål til svar (bare med nok avklaringer), og
// aldersgrensene for aldrende arbeid på tavla (`aldersGrenser`: p85 per klasse).
// Samlekøen telles for seg i nøkkeltallene (`samlekoen`).
// Testet i scripts/orkestrator/lib/__tests__/koStatistikk.test.ts.
// =============================================================

const L = require('./koLogikk.js');
const TK = require('./tidKost.js');

/** Grafene viser de siste 14 dagene; «ferdige» i nøkkeltallene de siste 7. */
const VINDU_DAGER = 14;
const FERDIGE_DAGER = 7;
/** Kontekst-taket for et spor (oppdragsmalen: overlevering og DELVIS ved ca. 300k). */
const KONTEKST_TAK = 300_000;
/** Klassene i fast rekkefølge (grafene stables i denne). */
const KLASSER = ['K', 'D', 'D+', 'U'];
/** Modellfeltet leses fra så mange av de siste spor-agentene. */
const MODELL_ANTALL = 10;
/** Aldrende arbeid: persentilen og minste antall ferdige i klassen før grensen gjelder. */
const ALDER_PERSENTIL = 85;
const ALDER_MIN_ANTALL = 5;
/** «Median tid fra spørsmål til svar» vises først når så mange avklaringer har tid. */
const SVARTID_MIN_ANTALL = 5;

const rund = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;

/** Median av tallene (null for tom liste). */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Snitt av tallene (null for tom liste). */
function snitt(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Persentil p (0–100) med nærmeste rang: minst p % av tallene er mindre enn eller lik svaret (null for tom liste). */
function persentil(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** Ferdige oppgaver i køen (ikke registreringer utenfor køen) med ferdigdato blant `dager` (lokal dato). */
function ferdigeIVindu(ko, dager, tz = TK.TZ) {
  const iVindu = new Set(dager);
  return (ko?.oppgaver ?? []).filter(
    (o) =>
      o.status === 'ferdig' &&
      !L.erEksternRad(o) &&
      o.ferdig &&
      iVindu.has(TK.dagFor(o.ferdig, tz)),
  );
}

/**
 * Aldersgrensene for aldrende arbeid på tavla: per klasse p85 av arbeidstiden (start til levert; for kort
 * i Pågår) og av hele syklusen (start til ferdig; for kort i Review), blant de ferdige de siste 14 dagene. En klasse
 * med færre enn ALDER_MIN_ANTALL ferdige har ingen grense (null): da markeres ingenting.
 * @returns {Record<string, { arbeid: number|null, syklus: number|null, antall: number }>} minutter
 */
function aldersGrenser(ko, { naa = Date.now(), tz = TK.TZ } = {}) {
  const ferdige = ferdigeIVindu(ko, dagerBakover(naa, VINDU_DAGER, tz), tz);
  const ut = {};
  for (const klasse of KLASSER) {
    const i = ferdige.filter((o) => o.klasse === klasse);
    const arbeid = i.map((o) => minutterMellom(o.startet, o.levert)).filter((x) => x != null);
    const syklus = i.map((o) => minutterMellom(o.startet, o.ferdig)).filter((x) => x != null);
    ut[klasse] = {
      arbeid: arbeid.length >= ALDER_MIN_ANTALL ? rund(persentil(arbeid, ALDER_PERSENTIL)) : null,
      syklus: syklus.length >= ALDER_MIN_ANTALL ? rund(persentil(syklus, ALDER_PERSENTIL)) : null,
      antall: syklus.length,
    };
  }
  return ut;
}

/**
 * De siste `n` datoene (YYYY-MM-DD, lokal dato i tidssonen), eldste først, med i dag sist. Regnes i kalenderdager fra dagens
 * dato, så sommertid aldri hopper over eller gjentar en dag.
 */
function dagerBakover(naa, n, tz = TK.TZ) {
  const [y, m, d] = TK.dagFor(new Date(naa).toISOString(), tz).split('-').map(Number);
  const ut = [];
  for (let i = n - 1; i >= 0; i--)
    ut.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return ut;
}

/** Minutter mellom to ISO-tider, eller null når en mangler, er ugyldig eller går bakover. */
function minutterMellom(fra, til) {
  const a = Date.parse(fra ?? '');
  const b = Date.parse(til ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / 60_000;
}

/** Tallene for ett utvalg: median og snitt i hele minutter. */
const midt = (xs) => ({
  median: xs.length ? rund(median(xs)) : null,
  snitt: xs.length ? rund(snitt(xs)) : null,
});

/** Samlekøen i tall: oppgaver, innholdsminutter, grupper og grupper klare til pakking. */
function samlekoTall(ko) {
  const g = L.samleGrupper(ko ?? {});
  return {
    antall: g.reduce((s, x) => s + x.antall, 0),
    minutter: g.reduce((s, x) => s + x.sum, 0),
    grupper: g.length,
    klare: g.filter((x) => x.klar).length,
  };
}

/**
 * Hele statistikken for tavla.
 * @param {object} ko køen (ko.json)
 * @param {object[]} rader tidsloggen (tidKost.lesRader); det holder med «ferdig»-radene
 * @param {{ naa?: number, tz?: string }} [valg]
 */
function statistikk(ko, rader, { naa = Date.now(), tz = TK.TZ } = {}) {
  const g = { ...L.STANDARD_GRENSER, ...(ko?.grenser ?? {}) };
  const dager = dagerBakover(naa, VINDU_DAGER, tz);
  const iVindu = new Set(dager);
  const siste7 = new Set(dager.slice(-FERDIGE_DAGER));
  const idag = dager[dager.length - 1];

  // ---- Oppgavene (ko.json): ferdige i vinduet, uten registreringer utenfor køen ----
  const ferdige = ferdigeIVindu(ko, dager, tz);
  const perDag = new Map(dager.map((d) => [d, { dag: d, K: 0, D: 0, 'D+': 0, U: 0, sum: 0 }]));
  for (const o of ferdige) {
    const rad = perDag.get(TK.dagFor(o.ferdig, tz));
    rad.sum += 1;
    if (KLASSER.includes(o.klasse)) rad[o.klasse] += 1;
  }

  // ---- Inn mot ut: lagt til og ferdige per dag, uten registreringer utenfor køen ----
  const lagtTil = new Map(dager.map((d) => [d, 0]));
  for (const o of ko?.oppgaver ?? []) {
    if (L.erEksternRad(o) || !o.lagt_til) continue;
    const d = TK.dagFor(o.lagt_til, tz);
    if (lagtTil.has(d)) lagtTil.set(d, lagtTil.get(d) + 1);
  }
  const innUtPerDag = dager.map((d) => ({ dag: d, inn: lagtTil.get(d), ut: perDag.get(d).sum }));
  const siste = innUtPerDag.slice(-FERDIGE_DAGER);
  const innSum = siste.reduce((s, r) => s + r.inn, 0);
  const utSum = siste.reduce((s, r) => s + r.ut, 0);

  // ---- Tid fra spørsmål til svar: fra spørsmålet fantes (registrert eller første oppgave som venter på
  // det) til avklaringen. Vises bare med nok avklaringer med tid. ----
  const svartider = [];
  for (const [sp, x] of Object.entries(ko?.avklaringer ?? {})) {
    const svart = Date.parse(x?.tid ?? '');
    if (!Number.isFinite(svart)) continue;
    const fra = [
      ko?.sporsmal?.[sp]?.lagt_til,
      ...(ko?.oppgaver ?? [])
        .filter((o) => (o.venter_paa ?? []).includes(sp))
        .map((o) => o.lagt_til),
    ]
      .map((t) => Date.parse(t ?? ''))
      .filter(Number.isFinite);
    if (!fra.length || svart < Math.min(...fra)) continue;
    svartider.push((svart - Math.min(...fra)) / 60_000);
  }

  const sykluser = [];
  const treff = [];
  const perKlasse = new Map(KLASSER.map((k) => [k, { arbeid: [], review: [], anslag: [] }]));
  let utelattSyklus = 0;
  let utelattKlasse = 0;
  for (const o of ferdige) {
    const syklus = minutterMellom(o.startet, o.ferdig);
    if (syklus == null) {
      utelattSyklus += 1;
      utelattKlasse += 1;
      continue;
    }
    sykluser.push(syklus);
    const anslag = L.anslag(o);
    if (anslag > 0) treff.push(syklus / anslag);
    // Arbeid (startet → levert) og review/fletting (levert → ferdig) krever alle tre tidene og en kjent klasse.
    const arbeid = minutterMellom(o.startet, o.levert);
    const review = minutterMellom(o.levert, o.ferdig);
    const k = perKlasse.get(o.klasse);
    if (arbeid == null || review == null || !k) {
      utelattKlasse += 1;
      continue;
    }
    k.arbeid.push(arbeid);
    k.review.push(review);
    k.anslag.push(anslag);
  }

  // ---- Forbruket (tidsloggen): per dag, med andelen natt ----
  const vindu = L.tolkNattvindu(g.nattvindu) ?? L.tolkNattvindu(L.STANDARD_GRENSER.nattvindu);
  const kost = new Map(dager.map((d) => [d, { dag: d, usd: 0, natt: 0 }]));
  for (const h of TK.forbruksHendelser(rader ?? [], tz)) {
    const rad = kost.get(h.dag);
    if (!rad) continue;
    rad.usd += h.usd;
    if (L.iNattvindu(vindu, Date.parse(h.tid), tz)) rad.natt += h.usd;
  }

  // ---- Konteksten til byggeagentene (siste rad per agent; radene er kumulative) ----
  // Byggeagentene er `spor` (K, U) OG `spor-d` (D, D+); rollekartet bor i tidKost.erByggeagent, så
  // D-sporene ikke faller ut av kontekst- og modellstatistikken.
  const sporRader = new Map();
  for (const r of rader ?? []) {
    if (r?.hendelse !== 'ferdig' || !TK.erByggeagent(r.agent_type)) continue;
    sporRader.set(r.agent_id ?? `${r.spor ?? '?'}|${r.tid}`, r);
  }
  const sporSiste = [...sporRader.values()].sort((a, b) => Date.parse(a.tid) - Date.parse(b.tid));
  const iVinduSpor = sporSiste.filter((r) => iVindu.has(TK.dagFor(r.tid, tz)));
  const kontekster = iVinduSpor
    .map((r) => Number(r.kontekst?.slutt))
    .filter((x) => Number.isFinite(x) && x > 0);

  // ---- Modellen i de siste sporene ----
  const modeller = new Map();
  for (const r of sporSiste.filter((x) => x.modell).slice(-MODELL_ANTALL))
    modeller.set(r.modell, (modeller.get(r.modell) ?? 0) + 1);

  const dagsbudsjett = Number(g.dagsbudsjett);
  return {
    vinduDager: VINDU_DAGER,
    ferdigeDager: FERDIGE_DAGER,
    nattvindu: g.nattvindu,
    nokkeltall: {
      ferdige: ferdige.filter((o) => siste7.has(TK.dagFor(o.ferdig, tz))).length,
      syklusMedian: sykluser.length ? rund(median(sykluser)) : null,
      syklusAntall: sykluser.length,
      treffsikkerhet: treff.length ? rund(median(treff), 2) : null,
      treffAntall: treff.length,
      forbrukIdag: rund(kost.get(idag).usd, 2),
      dagsbudsjett:
        g.dagsbudsjett != null && Number.isFinite(dagsbudsjett) && dagsbudsjett > 0
          ? dagsbudsjett
          : null,
      // Per dag i snitt de siste 7 dagene; netto > 0 betyr at køen vokser.
      innUt: {
        inn: rund(innSum / FERDIGE_DAGER, 1),
        ut: rund(utSum / FERDIGE_DAGER, 1),
        netto: rund((innSum - utSum) / FERDIGE_DAGER, 1),
      },
      // Samlekøen telles for seg (venter på å bli pakket, ikke på å bli startet).
      samlekoen: samlekoTall(ko),
      svartid:
        svartider.length >= SVARTID_MIN_ANTALL
          ? { median: rund(median(svartider)), antall: svartider.length }
          : null,
    },
    ferdigePerDag: [...perDag.values()],
    innUtPerDag,
    perKlasse: KLASSER.map((klasse) => {
      const k = perKlasse.get(klasse);
      return {
        klasse,
        antall: k.arbeid.length,
        arbeid: midt(k.arbeid),
        review: midt(k.review),
        anslagSnitt: k.anslag.length ? rund(snitt(k.anslag)) : null,
      };
    }),
    kostPerDag: [...kost.values()].map((r) => ({
      dag: r.dag,
      usd: rund(r.usd, 2),
      natt: rund(r.natt, 2),
    })),
    kontekst: {
      antall: kontekster.length,
      median: kontekster.length ? rund(median(kontekster)) : null,
      maks: kontekster.length ? Math.max(...kontekster) : null,
      tak: KONTEKST_TAK,
    },
    utelatt: {
      syklus: utelattSyklus,
      klasse: utelattKlasse,
      kontekst: iVinduSpor.length - kontekster.length,
    },
    modeller: [...modeller.entries()]
      .map(([modell, antall]) => ({ modell, antall }))
      .sort((a, b) => b.antall - a.antall),
  };
}

module.exports = {
  VINDU_DAGER,
  FERDIGE_DAGER,
  KONTEKST_TAK,
  KLASSER,
  ALDER_PERSENTIL,
  ALDER_MIN_ANTALL,
  SVARTID_MIN_ANTALL,
  median,
  snitt,
  persentil,
  dagerBakover,
  minutterMellom,
  ferdigeIVindu,
  aldersGrenser,
  statistikk,
};
