// =============================================================
// koKapasitet.js: ukekvoten til Claude-abonnementet som modell i arbeidskøen.
//
// Abonnementet har en ukekvote som nullstilles på et fast tidspunkt hver uke. Køen bruker kvoten kontinuerlig, og
// uten styring kan den gå tom flere dager før nullstillingen. Denne modulen anslår hvor mye av kvoten som er brukt,
// når den blir tom med dagens tempo, og hvor mange spor som kan kjøre samtidig uten at den går tom før nullstillingen.
//
// Nullstillingen (ukedag, klokkeslett, tidssone) og navnet på abonnementet står i ko.config.json under `kapasitet`
// (nullstillDag, nullstillKlokke, tidssone, plannavn); se `nullstillingFra`. Sommer- og vintertid håndteres.
//
// Modellen: forbruket måles i API-ekvivalente USD fra tidsloggen (tidKost.forbruksHendelser, samme tall som
// budsjettvakta og `logg-tid.mjs --kost`). Én konstant, `usd_per_100`, sier hvor mange slike USD i TIDSLOGGEN som
// svarer til 100 % av ukekvoten. Tidsloggen dekker bare subagentene; orkestratorøkta og andre økter ligger utenfor,
// men er med i konstanten så lenge andelen er stabil. Derfor kalibreres konstanten mot prosenten Claude viser på
// forbrukssiden (`ko.mjs kapasitet --kalibrer <prosent>`), ikke mot listepriser.
//
// Ingen I/O her (utover å lese konfigen): ko.mjs leser køen og tidsloggen og kaller disse funksjonene. Testet i
// scripts/orkestrator/lib/__tests__/koKapasitet.test.ts.
// =============================================================
'use strict';

const L = require('./koLogikk.js');
const { konfig } = require('./koKonfig.js');

const UKEDAGER = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
const TIME_MS = 3_600_000;

/**
 * Standard nullstilling når konfigen ikke sier noe: tirsdag (getUTCDay-nummer 2) kl. 19.00 i Europe/Oslo, uten
 * plannavn. Overstyres i ko.config.json under `kapasitet`.
 */
const NULLSTILLING = Object.freeze({
  ukedag: 2,
  time: 19,
  minutt: 0,
  tz: 'Europe/Oslo',
  plannavn: null,
});

/** Er `tz` en tidssone Intl kjenner? */
function gyldigTidssone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Nullstillingen fra konfigfeltene under `kapasitet` (manglende eller ugyldige verdier gir standarden):
 *   nullstillDag    0-6 (0 = søndag, 2 = tirsdag)
 *   nullstillKlokke «TT:MM» (24-timers, lokal tid i tidssonen)
 *   tidssone        IANA-tidssone, f.eks. «Europe/Oslo»
 *   plannavn        navnet på abonnementet i teksten, eller null for bare «ukekvoten»
 * @param {{ nullstillDag?: number, nullstillKlokke?: string, tidssone?: string, plannavn?: string|null }} [kap]
 * @returns {{ ukedag: number, time: number, minutt: number, tz: string, plannavn: string|null }}
 */
function nullstillingFra(kap = {}) {
  const dag = Number(kap?.nullstillDag);
  const ukedag =
    kap?.nullstillDag != null && Number.isInteger(dag) && dag >= 0 && dag <= 6
      ? dag
      : NULLSTILLING.ukedag;
  const kl = /^(\d{1,2})[:.](\d{2})$/.exec(String(kap?.nullstillKlokke ?? '').trim());
  const okKl = kl != null && Number(kl[1]) <= 23 && Number(kl[2]) <= 59;
  const tz = kap?.tidssone && gyldigTidssone(kap.tidssone) ? kap.tidssone : NULLSTILLING.tz;
  const plannavn =
    typeof kap?.plannavn === 'string' && kap.plannavn.trim() ? kap.plannavn.trim() : null;
  return {
    ukedag,
    time: okKl ? Number(kl[1]) : NULLSTILLING.time,
    minutt: okKl ? Number(kl[2]) : NULLSTILLING.minutt,
    tz,
    plannavn,
  };
}

/** Nullstillingen slik prosjektets konfig sier (ko.config.json, `kapasitet`). Leses ved kall. */
function nullstilling() {
  return nullstillingFra(konfig().kapasitet ?? {});
}

/** Navnet på nullstillingsdagen, f.eks. «tirsdag». */
const dagNavn = (n = nullstilling()) => UKEDAGER[n.ukedag];

/**
 * Standardverdier for kvotemodellen (lagres i køfila ko.json under `kapasitet`, ikke i konfigen). usd_per_100 er bare
 * et grovt utgangspunkt; kalibrer den mot prosenten Claude viser (ko.mjs kapasitet --kalibrer / --sett).
 * modus: 'varsel' (fyll melder bare), 'tak' (fyll starter ikke flere enn forslaget, overstyres med --over-kvote) eller
 * 'av'. stopp_pct: der kvoten i praksis er tom (den stopper ofte litt før 100 %).
 */
const STANDARD_KAPASITET = {
  usd_per_100: 2282,
  stopp_pct: 98,
  modus: 'varsel',
  kalibreringer: [],
  skykreditt: null,
};

/** Tidssone-forskyvningen (ms) i `tz` ved tidspunktet `ms` (positiv øst for UTC). */
function forskyvning(ms, tz) {
  const del = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const lokal = Date.UTC(+del.year, +del.month - 1, +del.day, +del.hour, +del.minute, +del.second);
  return lokal - Math.floor(ms / 1000) * 1000;
}

/** UTC-ms for en lokal veggklokketid i `tz` (to runder, så overgangen mellom sommer- og vintertid treffer). */
function lokalTilUtc(aar, mnd0, dag, time, minutt, tz) {
  const gjett = Date.UTC(aar, mnd0, dag, time, minutt);
  const forste = gjett - forskyvning(gjett, tz);
  return gjett - forskyvning(forste, tz);
}

/** Siste nullstilling (UTC-ms) ved eller før `naa`. `n` er standard fra konfigen (nullstilling()). */
function sisteNullstilling(naa = Date.now(), n = nullstilling()) {
  // Lokal dato i tidssonen nå, så gå bakover til nullstillingsdagen og sjekk klokkeslettet.
  const lokal = new Date(naa + forskyvning(naa, n.tz));
  for (let tilbake = 0; tilbake <= 7; tilbake++) {
    const d = new Date(
      Date.UTC(lokal.getUTCFullYear(), lokal.getUTCMonth(), lokal.getUTCDate() - tilbake),
    );
    if (d.getUTCDay() !== n.ukedag) continue;
    const t = lokalTilUtc(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      n.time,
      n.minutt,
      n.tz,
    );
    if (t <= naa) return t;
  }
  throw new Error('fant ingen nullstilling (kan ikke skje)');
}

/** Neste nullstilling (UTC-ms) etter `naa`: samme lokale klokkeslett sju dager etter den siste. */
function nesteNullstilling(naa = Date.now(), n = nullstilling()) {
  const siste = sisteNullstilling(naa, n);
  const lokal = new Date(siste + forskyvning(siste, n.tz));
  return lokalTilUtc(
    lokal.getUTCFullYear(),
    lokal.getUTCMonth(),
    lokal.getUTCDate() + 7,
    n.time,
    n.minutt,
    n.tz,
  );
}

/** Innstillingene slik de gjelder: standard + det som står i ko.json under `kapasitet`. */
function innstillinger(ko) {
  return { ...STANDARD_KAPASITET, ...(ko?.kapasitet ?? {}) };
}

/**
 * Forbruket i [fra, til) fra forbrukshendelsene (tidKost.forbruksHendelser).
 * @returns {{ usd: number, tokens: Record<string, number>, agenter: number }}
 */
function forbrukMellom(hendelser, fra, til) {
  const tokens = { input: 0, output: 0, cache_lest: 0, cache_skrevet: 0 };
  const agenter = new Set();
  let usd = 0;
  for (const h of hendelser ?? []) {
    const t = Date.parse(h.tid);
    if (!(t >= fra && t < til)) continue;
    usd += h.usd;
    agenter.add(h.agent);
    for (const k of Object.keys(tokens)) tokens[k] += Number(h.tokens?.[k] ?? 0) || 0;
  }
  return { usd, tokens, agenter: agenter.size };
}

/**
 * Sportimer i [fra, til): summen av tida køspor har kjørt (startet → levert, eller nå når det kjører), uten
 * skyspor (egen skykreditt), plukkede oppgaver og registreringer utenfor køen. Delt på timene gir det snittet av
 * parallelle spor.
 */
function sporTimer(ko, fra, til) {
  let ms = 0;
  for (const o of ko?.oppgaver ?? []) {
    if (!o.startet || o.sky || o.plukket_av || L.erEksternRad(o)) continue;
    const start = Date.parse(o.startet);
    const slutt = o.levert
      ? Date.parse(o.levert)
      : o.status === 'kjorer'
        ? til
        : o.ferdig
          ? Date.parse(o.ferdig)
          : null;
    if (!Number.isFinite(start) || !Number.isFinite(slutt)) continue;
    const a = Math.max(start, fra);
    const b = Math.min(slutt, til);
    if (b > a) ms += b - a;
  }
  return ms / TIME_MS;
}

/** Kalibrert kost (USD) og antall for oppgavene som venter eller er forslag (det som ligger foran i køen). */
function koKost(ko) {
  let usd = 0;
  let antall = 0;
  for (const o of ko?.oppgaver ?? []) {
    if (!['venter', 'kjorer'].includes(o.status) || L.erEksternRad(o)) continue;
    usd += L.anslagKost(o);
    antall++;
  }
  return { usd, antall };
}

/**
 * Prognosen for uka.
 * @param {{ ko: object, hendelser: object[], naa?: number, nullstilling?: object }} inn
 *   nullstilling: standard fra konfigen (nullstilling()); følger med i svaret, så tekstene bruker samme dag og sone
 */
function prognose({ ko, hendelser, naa = Date.now(), nullstilling: n = nullstilling() }) {
  const k = innstillinger(ko);
  const fra = sisteNullstilling(naa, n);
  const til = nesteNullstilling(naa, n);
  const f = forbrukMellom(hendelser, fra, naa);
  const pct = (f.usd / k.usd_per_100) * 100;
  const timerGaatt = Math.max((naa - fra) / TIME_MS, 1 / 60);
  const timerIgjen = (til - naa) / TIME_MS;
  // Tempo som snitt siden nullstillingen (slik Claude regner prognosen sin) og siste 24 timer (dagens fart).
  const tempoSnitt = pct / timerGaatt; // % per time
  const f24 = forbrukMellom(hendelser, Math.max(fra, naa - 24 * TIME_MS), naa);
  const timer24 = Math.min(24, timerGaatt);
  const tempo24 = ((f24.usd / k.usd_per_100) * 100) / timer24;
  const tomVed = (tempo) =>
    tempo > 0 && pct < 100 ? naa + ((100 - pct) / tempo) * TIME_MS : pct >= 100 ? naa : null;
  const tomSnitt = tomVed(tempoSnitt);
  const tom24 = tomVed(tempo24);
  // Parallellitet: sportimer per time = snittet av samtidige spor; % per sportime inkluderer orkestratorens andel.
  const st = sporTimer(ko, fra, naa);
  const parallellSnitt = st / timerGaatt;
  const pctPerSportime = st > 0 ? pct / st : null;
  const rest = Math.max(0, 100 - pct);
  const baerekraftigTempo = timerIgjen > 0 ? rest / timerIgjen : 0; // % per time som varer til nullstillingen
  // Gulvet (ikke avrunding): et forslag skal heller la kvoten vare litt lenger enn tømme den før nullstillingen.
  const sporBaerekraftig =
    pctPerSportime && pctPerSportime > 0 ? baerekraftigTempo / pctPerSportime : null;
  const forslagSpor = sporBaerekraftig == null ? null : Math.max(0, Math.floor(sporBaerekraftig));
  const kø = koKost(ko);
  return {
    fra,
    til,
    naa,
    nullstilling: n,
    usd: f.usd,
    tokens: f.tokens,
    agenter: f.agenter,
    pct,
    usd_per_100: k.usd_per_100,
    stopp_pct: k.stopp_pct,
    modus: k.modus,
    timerGaatt,
    timerIgjen,
    tempoSnitt,
    tempo24,
    tomSnitt,
    tom24,
    holder: tomSnitt == null || tomSnitt >= til,
    sporTimer: st,
    parallellSnitt,
    pctPerSportime,
    baerekraftigTempo,
    sporBaerekraftig,
    forslagSpor,
    // Én ukekvote omregnet: tokens og sportimer per 100 % med tempoet så langt i uka.
    per100:
      pct > 0
        ? {
            tokens: Object.fromEntries(
              Object.entries(f.tokens).map(([n2, v]) => [n2, (v / pct) * 100]),
            ),
            sporTimer: st > 0 ? (st / pct) * 100 : null,
          }
        : null,
    ko: { ...kø, pct: (kø.usd / k.usd_per_100) * 100 },
    skykreditt: k.skykreditt ?? null,
    kalibreringer: k.kalibreringer ?? [],
  };
}

/**
 * Ny konstant fra prosenten Claude viser nå: usd_per_100 = forbruket siden nullstillingen / prosent × 100.
 * Returnerer de nye innstillingene (lagres av kalleren under låsen) eller { feil }.
 * @param {object} ko
 * @param {{ prosent: unknown, hendelser: object[], naa?: number, nullstilling?: object }} inn
 *   nullstilling: standard fra konfigen (nullstilling())
 */
function kalibrer(
  ko,
  { prosent, hendelser, naa = Date.now(), nullstilling: n = nullstilling() },
) {
  const p = Number(prosent);
  if (!(p > 0 && p <= 100)) return { feil: 'prosenten må være et tall over 0 og høyst 100' };
  const k = innstillinger(ko);
  const fra = sisteNullstilling(naa, n);
  const { usd } = forbrukMellom(hendelser, fra, naa);
  if (!(usd > 0))
    return { feil: 'ingen målt forbruk siden nullstillingen; kan ikke kalibrere ennå' };
  const ny = Math.round((usd / p) * 100);
  const punkt = {
    tid: new Date(naa).toISOString(),
    prosent: p,
    usd: Math.round(usd * 10) / 10,
    usd_per_100: ny,
  };
  return {
    forrige: k.usd_per_100,
    kapasitet: {
      ...(ko?.kapasitet ?? {}),
      usd_per_100: ny,
      kalibreringer: [...(k.kalibreringer ?? []), punkt].slice(-20),
    },
  };
}

/**
 * Taket for `fyll`: hvor mange NYE spor som kan startes når kvoteprognosen skal vare til nullstillingen.
 * modus 'av' eller ukjent forslag: ingen grense. Ellers: maksNye = max(0, forslag − aktive), men aldri under 1 når
 * ingenting kjører (køen skal ikke stå helt stille på en prognose). 'varsel' gir bare meldingen; 'tak' begrenser.
 * @returns {{ grense: number|null, melding: string|null }}
 */
function kvoteTak(p, aktive) {
  if (p.modus === 'av' || p.forslagSpor == null) return { grense: null, melding: null };
  if (p.holder && aktive <= p.forslagSpor) return { grense: null, melding: null };
  const maksNye = Math.max(aktive === 0 ? 1 : 0, p.forslagSpor - aktive);
  const tz = p.nullstilling?.tz;
  const tekst =
    `Kvoten: ${p.pct.toFixed(0)} % brukt, tom ${tidTekst(p.tomSnitt, tz)} med dette tempoet ` +
    `(nullstilles ${tidTekst(p.til, tz)}). ` +
    `Høyst ${p.forslagSpor} spor samtidig varer til nullstillingen; ${aktive} kjører nå.`;
  if (p.modus === 'tak')
    return {
      grense: maksNye,
      melding: `${tekst} Kvotetak: starter høyst ${maksNye} nye (overstyr med --over-kvote).`,
    };
  return {
    grense: null,
    melding: `${tekst} (Bare varsel; ko.mjs kapasitet --modus tak gjør det til et tak.)`,
  };
}

/** «søndag 25.10 kl. 16.30» i tidssonen `tz` (standard: tidssonen fra konfigen). */
function tidTekst(ms, tz) {
  if (ms == null) return 'aldri (ingen forbruk)';
  const sone = tz || nullstilling().tz;
  const d = new Date(ms + forskyvning(ms, sone));
  const to = (x) => String(x).padStart(2, '0');
  return (
    `${UKEDAGER[d.getUTCDay()]} ${to(d.getUTCDate())}.${to(d.getUTCMonth() + 1)} kl. ` +
    `${to(d.getUTCHours())}.${to(d.getUTCMinutes())}`
  );
}

const tall = (x, d = 1) => x.toLocaleString('nb-NO', { maximumFractionDigits: d });
const mill = (x) => `${(x / 1e6).toLocaleString('nb-NO', { maximumFractionDigits: 1 })} mill`;
const pctT = (x, d = 1) => `${x.toLocaleString('nb-NO', { maximumFractionDigits: d })} %`;

/** Linjene `ko.mjs kapasitet` skriver. */
function linjer(p) {
  const n = p.nullstilling ?? nullstilling();
  const tt = (ms) => tidTekst(ms, n.tz);
  const ut = [];
  ut.push(
    `Ukekvoten${n.plannavn ? ` (${n.plannavn})` : ''}: nullstilt ${tt(p.fra)}, neste ${tt(p.til)} ` +
      `(${p.timerIgjen.toFixed(0)} t igjen; nullstilles hver ${dagNavn(n)}).`,
  );
  ut.push(
    `Brukt: ${pctT(p.pct)} anslått (${Math.round(p.usd)} av ${p.usd_per_100} USD API-ekvivalent i tidsloggen; ` +
      `${p.agenter} agenter).`,
  );
  ut.push(
    `  Tokens siden nullstillingen (subagenter): cache-lest ${mill(p.tokens.cache_lest)}, cache-skrevet ` +
      `${mill(p.tokens.cache_skrevet)}, output ${mill(p.tokens.output)}, input ${mill(p.tokens.input)}.`,
  );
  ut.push(
    `Tempo: ${pctT(p.tempoSnitt * 24)} per døgn i snitt siden nullstillingen, ${pctT(p.tempo24 * 24)} per døgn siste 24 t.`,
  );
  ut.push(
    `Tom (100 %) med snittempoet: ${tt(p.tomSnitt)}${p.holder ? ' (holder til nullstillingen)' : ''}; ` +
      `med tempoet siste 24 t: ${tt(p.tom24)}.`,
  );
  ut.push(
    `Parallellitet: ${tall(p.parallellSnitt)} spor i snitt (${p.sporTimer.toFixed(0)} sportimer)` +
      (p.pctPerSportime ? `, ${pctT(p.pctPerSportime, 2)} av kvoten per sportime.` : '.'),
  );
  if (p.forslagSpor != null)
    ut.push(
      `Forslag: høyst ${p.forslagSpor} spor samtidig (beregnet ${tall(p.sporBaerekraftig)}; ` +
        `${pctT(p.baerekraftigTempo * 24)} per døgn) gjør at kvoten varer til ${tt(p.til)}; ${p.forslagSpor + 1} spor ` +
        `tømmer den ca. ${tt(p.naa + ((100 - p.pct) / ((p.forslagSpor + 1) * p.pctPerSportime)) * TIME_MS)}. ` +
        `Modus i fyll: ${p.modus}.`,
    );
  if (p.per100)
    ut.push(
      `Én ukekvote ≈ ${mill(p.per100.tokens.cache_lest)} cache-lest, ${mill(p.per100.tokens.cache_skrevet)} ` +
        `cache-skrevet og ${mill(p.per100.tokens.output)} output-tokens` +
        (p.per100.sporTimer ? `, ca. ${Math.round(p.per100.sporTimer)} sportimer.` : '.'),
    );
  ut.push(
    `Køen (venter og kjører, også blokkerte og parkerte): ${p.ko.antall} oppgaver ≈ ${Math.round(p.ko.usd)} USD ≈ ${pctT(p.ko.pct)} av en ` +
      'ukekvote (kalibrert kost per klasse).',
  );
  if (p.skykreditt) {
    const s = p.skykreditt;
    ut.push(
      `Skykreditt (egen pott, bare skyøkter): ${s.igjen_usd} av ${s.total_usd ?? '?'} USD igjen, utløper ` +
        `${s.utloper ? tt(Date.parse(s.utloper)) : '?'}${s.satt ? ` (satt ${s.satt.slice(0, 10)})` : ''}. ` +
        'Tom kreditt: skyøkter går mot ukekvoten.',
    );
  }
  const sist = p.kalibreringer.at(-1);
  ut.push(
    sist
      ? `Kalibrert ${tt(Date.parse(sist.tid))}: ${sist.prosent} % = ${sist.usd} USD → ${sist.usd_per_100} per 100 %. ` +
          'Ny: ko.mjs kapasitet --kalibrer <prosent fra Claude>.'
      : 'Standardkonstant (ikke kalibrert ennå). Kalibrer: ko.mjs kapasitet --kalibrer <prosent fra Claude>.',
  );
  return ut;
}

module.exports = {
  NULLSTILLING,
  UKEDAGER,
  STANDARD_KAPASITET,
  nullstillingFra,
  nullstilling,
  dagNavn,
  forskyvning,
  lokalTilUtc,
  sisteNullstilling,
  nesteNullstilling,
  innstillinger,
  forbrukMellom,
  sporTimer,
  koKost,
  prognose,
  kalibrer,
  kvoteTak,
  tidTekst,
  linjer,
};
