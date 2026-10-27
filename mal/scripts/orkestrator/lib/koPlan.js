// =============================================================
// koPlan.js: ren logikk for planregisteret (scripts/.ko/planer.json), brukt av `ko.mjs plan …`.
//
// Se docs/plan-register.md for datamodellen, den avledede modenheten, kommandoene og prioritetsreglene.
// Registeret er en egen fil ved siden av ko.json, så planarbeid aldri bumper køens versjon.
// Skrivingen (lås, atomisk skriving, --forvent-endret, endringslogg) skjer i ko.mjs; her ligger bare rene funksjoner
// som tar data inn og gir data ut, testet i lib/__tests__/koPlan*.test.ts. Ingen fil- eller nettverkstilgang:
// det som trenger filsystemet (finnes en kildesti?), sendes inn som en funksjon. Det prosjektspesifikke (modulene,
// prioritetsreglene, leverandørene i dokumentsjekken) kommer fra ko.config.json via koKonfig.js.
//
// Ellers: kobling køoppgave → planpost (`add --plan`, koblePlan), fasen `plan` på prosjekter, modulene (MODULER)
// og hygienen i `plan sjekk` (sjekk). `plan backup` er bare I/O og bor i ko.mjs.
//
// Juridisk: validering av juridisk-feltet (validerJuridisk), de juridiske punktene på tvers av postene,
// personvern per modul, eierbeslutningene med sorteringen, lanseringsoversikten og juristpakken (bare tekst).
//
// Fila (planer.json):
//   { versjon: 1, opprettet, endret, poster: [planpost], arkiv: { <id>: planpost }, endringslogg: [post] }
//   poster       planpostene. Id-ene er stabile og brukes aldri om igjen.
//   arkiv        poster som er slått sammen inn i en annen (`sammenslatt_til`). Ingenting slettes; id-en er opptatt.
//   endringslogg de siste ENDRINGSLOGG_MAKS skrivingene (felt for felt), så `plan angre` kan rulle tilbake.
//   aktiv_okt    (valgfri) «Arbeider nå»-markørene [{ post, at, av }] fra `plan aktiv`.
//
// Hierarkiet: modul (ko.json `omrader`) → prosjekt (ko.json `prosjekter`, med `omrade`) → planpost → køoppgave
// (ko.json `oppgaver`, med feltet `plan`). Modul og prosjekt opprettes med `ko.mjs omrade` og `ko.mjs prosjekt`.
// =============================================================

'use strict';

const { konfig } = require('./koKonfig.js');

// ---- Verdilister ---------------------------------------------------------------------------------------

/** Prioritetene, i visningsrekkefølge (Nå først, Dropp sist). `eier` = venter på eierens valg. */
const PRIORITETER = ['naa', 'eier', 'senere', 'dropp'];
/** Underkategoriene til Nå (flere er lov). */
const NAA_KATEGORIER = ['sikkerhet', 'for-prod', 'viktig'];
/** Hvem som satte prioriteten. En agent endrer aldri en eier-satt prioritet (unntak: regel 1, sikkerhet). */
const SATT_AV = ['agent', 'eier'];
/** Modenhet som settes i planarbeidet. */
const MODENHET_MANUELL = ['ide', 'utredet', 'planlagt', 'klar'];
/** Modenhet som regnes ut fra køen og verifiseringen; settes aldri for hånd. */
const MODENHET_AVLEDET = ['i-ko', 'delvis', 'bygget', 'verifisert'];
const MODENHETER = [...MODENHET_MANUELL, ...MODENHET_AVLEDET];
/** Grovt estimat: S (under en halv dag), M (1 til 3 spor), L (4 til 10), XL (modul). */
const ESTIMATER = ['S', 'M', 'L', 'XL'];
/** Etter så mange dager uten verifisering er en post foreldet. */
const FORELDET_DAGER = 30;
/** Høyst så mange poster i endringsloggen (som køen). */
const ENDRINGSLOGG_MAKS = 50;
/** Planpost-id: PL-, så store bokstaver, tall og bindestreker (f.eks. PL-EKSPORT-1, PL-API-2b). */
const ID_MONSTER = /^PL-[A-Z0-9ÆØÅ](?:[A-Za-z0-9ÆØÅæøå-]*[A-Za-z0-9ÆØÅæøå])?$/;
const DATO_MONSTER = /^\d{4}-\d{2}-\d{2}$/;

/** Feltene en planpost kan ha. Alt annet avvises, så en skrivefeil ikke blir et nytt felt. */
const FELT = [
  'id',
  'tittel',
  'kort',
  'prosjekt',
  'prioritet',
  'naa_kategori',
  'prioritet_grunn',
  'prioritet_satt_av',
  'modenhet',
  'estimat',
  'kilder',
  'roadmap',
  'avhenger',
  'frist',
  'juridisk',
  'eierspm',
  'verifisert',
  'dropp_grunn',
  'sammenslatt_fra',
  'merknad',
  // Satt av verktøyet:
  'opprettet',
  'agent_loft',
];
/** Felt som verktøyet eier: kan ikke settes med `plan ny` eller `plan endre`. */
const VERKTOY_FELT = new Set(['id', 'opprettet', 'agent_loft', 'sammenslatt_fra']);
/** Avledet fra ko.json (oppgave.plan); lagres aldri i registeret. */
const AVLEDET_FELT = new Set(['ko_oppgaver']);

// ---- Prioritetsreglene som data ----------------------------------------------------------
//
// Reglene brukes ovenfra og ned; første regel som treffer, avgjør. `prioritet` og `kategorier` er det regelen gir
// (kategorier: en av dem, etter hva saken gjelder). `maaling` er satt for reglene som kan regnes ut fra dataene
// alene (frist og blokkering); de andre krever skjønn fra agenten eller eieren.
//
// STANDARD_PRIORITETSREGLER er generiske. Et prosjekt kan bytte dem ut med sin egen liste i ko.config.json
// (`prioritetsregler`, samme form: { nr, navn, treffer, prioritet, kategorier, maaling?, alltid? }). Regel nr. 1 er
// alltid sikkerhetsregelen: den eneste en agent kan bruke til å løfte en prioritet eieren har satt.
const STANDARD_PRIORITETSREGLER = Object.freeze([
  {
    nr: 1,
    navn: 'Sikkerhet',
    treffer:
      'Sikkerhetshull, data som lekker mellom kunder eller brukere, eksponerte hemmeligheter, funn av alvorlighet HØY eller KRITISK',
    prioritet: 'naa',
    kategorier: ['sikkerhet'],
    alltid: true,
  },
  {
    nr: 2,
    navn: 'Kalenderfrist',
    treffer: 'Kalenderfrist innen 60 dager (lov, avtale, myndighet, leverandør)',
    prioritet: 'naa',
    kategorier: ['for-prod', 'viktig'],
    maaling: { frist_dager: 60 },
  },
  {
    nr: 3,
    navn: 'Før lansering',
    treffer:
      'Det som må være på plass før lansering eller første kunde: lovkrav, avtaler og vilkår, personvern, det som blokkerer en pilot, feil som gir et dårlig førsteinntrykk',
    prioritet: 'naa',
    kategorier: ['for-prod'],
  },
  {
    nr: 4,
    navn: 'Blokkerer andre',
    treffer: 'Blokkerer to eller flere andre planposter, eller et prosjekt i dagens fokus',
    prioritet: 'naa',
    kategorier: ['viktig'],
    maaling: { blokkerer_min: 2 },
  },
  {
    nr: 5,
    navn: 'Virker ikke som dokumentert',
    treffer: 'Noe som er bygget virker ikke som dokumentert (statusavvik, kjent feil hos brukere)',
    prioritet: 'naa',
    kategorier: ['viktig'],
  },
  {
    nr: 6,
    navn: 'Eierens valg',
    treffer:
      'Trenger et valg bare eieren kan ta (pris, leverandør, risikoaksept, omfang), eller to planer sier ulikt',
    prioritet: 'eier',
    kategorier: [],
  },
  {
    nr: 7,
    navn: 'Dropp',
    treffer:
      'Erstattet av en nyere plan, dekket av noe som er bygget, strider mot et vedtak, eller lav verdi og høy kostnad',
    prioritet: 'dropp',
    kategorier: [],
  },
  {
    nr: 8,
    navn: 'Senere',
    treffer:
      'Nye moduler og utvidelser uten frist, ytelse og kost før det er målt et problem, store poster (L/XL) uten konkret behov',
    prioritet: 'senere',
    kategorier: [],
  },
]);

/**
 * Prioritetsreglene som gjelder: `prioritetsregler` i ko.config.json når den er en ikke-tom liste, ellers
 * STANDARD_PRIORITETSREGLER. Lest på nytt ved hvert kall (konfig() bufrer fila).
 */
function prioritetsregler() {
  const egne = konfig().prioritetsregler;
  return Array.isArray(egne) && egne.length ? egne : STANDARD_PRIORITETSREGLER;
}

// ---- Små hjelpere ----------------------------------------------------------------------------------------------

/** Dyp kopi av en JSON-verdi; undefined blir null. */
function klonJson(x) {
  return x === undefined ? null : JSON.parse(JSON.stringify(x));
}

/** JSON med sorterte nøkler, så like objekter alltid sammenlignes likt. */
function stabilJson(x) {
  if (Array.isArray(x)) return `[${x.map(stabilJson).join(',')}]`;
  if (x && typeof x === 'object')
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stabilJson(x[k])}`)
      .join(',')}}`;
  return JSON.stringify(x === undefined ? null : x);
}

/** Like verdier? null og manglende felt er det samme. */
function likVerdi(a, b) {
  return stabilJson(a ?? null) === stabilJson(b ?? null);
}

const tekst = (v) => (typeof v === 'string' ? v.trim() : '');
const erObjekt = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** Dagens dato i norsk tid (YYYY-MM-DD). */
function osloDato(naa = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(naa instanceof Date ? naa : new Date(naa));
}

/** Gyldig kalenderdato på formen YYYY-MM-DD? */
function gyldigDato(s) {
  if (typeof s !== 'string' || !DATO_MONSTER.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Hele dager fra dato a til dato b (begge YYYY-MM-DD). */
function dagerMellom(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Tomt register (en ny planer.json). */
function tomtRegister(naa = new Date().toISOString()) {
  return { versjon: 1, opprettet: naa, endret: naa, poster: [], arkiv: {}, endringslogg: [] };
}

/** Registeret med standardfeltene på plass (en gammel eller tom fil virker). */
function normaliser(reg) {
  const r = erObjekt(reg) ? reg : {};
  return {
    ...r,
    versjon: r.versjon ?? 1,
    poster: Array.isArray(r.poster) ? r.poster : [],
    arkiv: erObjekt(r.arkiv) ? r.arkiv : {},
    endringslogg: Array.isArray(r.endringslogg) ? r.endringslogg : [],
    // dokumentregisteret; en eldre fil uten feltet får en tom liste.
    dokumenter: Array.isArray(r.dokumenter) ? r.dokumenter : [],
  };
}

/** Er id-en brukt (i posten eller i arkivet)? Id-er brukes aldri om igjen. */
function idBrukt(reg, id) {
  return (reg.poster ?? []).some((p) => p.id === id) || Object.hasOwn(reg.arkiv ?? {}, id);
}

/** Planposten med id-en, eller null. */
function finnPost(reg, id) {
  return (reg.poster ?? []).find((p) => p.id === id) ?? null;
}

/** Modulen (området) en post hører til, via prosjektets `omrade`. */
function modulFor(post, prosjekter) {
  return prosjekter?.[post?.prosjekt]?.omrade ?? null;
}

// ---- Validering --------------------------------------------------------------------------------------------------

/**
 * Er en kildesti trygg å slå opp? Relativ til prosjektrota, skråstreker, ingen `..` og ingen absolutt sti.
 * @returns {string|null} feilteksten, eller null
 */
function kildestiFeil(sti) {
  if (typeof sti !== 'string' || !sti.trim()) return 'mangler sti';
  if (/^[A-Za-z]:|^[\\/]/.test(sti))
    return `${sti}: må være relativ til prosjektrota (f.eks. docs/…)`;
  if (sti.includes('\\')) return `${sti}: bruk skråstrek /, ikke \\`;
  if (sti.split('/').some((d) => d === '..' || d === '.'))
    return `${sti}: . og .. er ikke lov i stien`;
  return null;
}

/**
 * Validerer en hel planpost slik den blir lagret.
 * @param {object} post
 * @param {{ prosjekter?: object, poster?: object[], sporsmal?: object, finnesSti?: (sti: string) => boolean }} ctx
 *   prosjekter: ko.json `prosjekter`; poster: de andre postene i registeret (for avhenger); sporsmal: ko.json
 *   `sporsmal` (eierspørsmålene); finnesSti: sjekker at en kildesti finnes (utelatt = sjekkes ikke).
 * @returns {{ feil: string[], advarsler: string[] }}
 */
function validerPost(post, ctx = {}) {
  const feil = [];
  const advarsler = [];
  if (!erObjekt(post)) return { feil: ['planposten må være et objekt'], advarsler };
  const hvem = typeof post.id === 'string' ? post.id : '(uten id)';
  const f = (t) => feil.push(`${hvem}: ${t}`);
  const adv = (t) => advarsler.push(`${hvem}: ${t}`);

  for (const k of Object.keys(post))
    if (!FELT.includes(k)) f(`ukjent felt ${k} (lov: ${FELT.join(', ')})`);

  if (typeof post.id !== 'string' || !ID_MONSTER.test(post.id))
    f('id må se ut som PL-NAVN-1 (PL-, store bokstaver, tall og bindestrek)');
  if (!tekst(post.tittel)) f('tittel mangler');
  else if (post.tittel.length > 160) f('tittel er over 160 tegn (kort er stedet for mer)');
  if (post.kort != null && typeof post.kort !== 'string') f('kort må være tekst');
  if (post.merknad != null && typeof post.merknad !== 'string') f('merknad må være tekst');

  // Prosjektet må finnes (modulen følger av prosjektets omrade).
  if (!tekst(post.prosjekt))
    f('prosjekt mangler (opprett det med ko.mjs prosjekt <pid> --tittel "…")');
  else if (!Object.hasOwn(ctx.prosjekter ?? {}, post.prosjekt))
    f(
      `ukjent prosjekt ${post.prosjekt} (opprett det først: ko.mjs prosjekt ${post.prosjekt} --tittel "…")`,
    );
  else if (!ctx.prosjekter[post.prosjekt]?.omrade)
    adv(
      `prosjektet ${post.prosjekt} har ingen modul (ko.mjs prosjekt ${post.prosjekt} --omrade <oid>)`,
    );

  // Prioritet, kategori, grunn og hvem som satte den.
  if (!PRIORITETER.includes(post.prioritet)) f(`prioritet må være en av ${PRIORITETER.join(', ')}`);
  if (post.naa_kategori != null) {
    if (!Array.isArray(post.naa_kategori)) f('naa_kategori må være en liste');
    else {
      for (const k of post.naa_kategori)
        if (!NAA_KATEGORIER.includes(k))
          f(`ukjent naa_kategori ${k} (lov: ${NAA_KATEGORIER.join(', ')})`);
      if (post.naa_kategori.length && post.prioritet !== 'naa')
        f('naa_kategori brukes bare når prioritet er naa');
    }
  }
  if (post.prioritet === 'naa' && !(post.naa_kategori ?? []).length)
    adv('naa uten kategori (sikkerhet, for-prod eller viktig)');
  if (post.prioritet === 'dropp' && !tekst(post.dropp_grunn))
    f('dropp krever én setning som grunn (dropp_grunn)');
  if (post.prioritet !== 'dropp' && post.dropp_grunn != null)
    f('dropp_grunn brukes bare når prioritet er dropp');
  if (post.prioritet === 'eier' && !(post.eierspm ?? []).length)
    adv('eier uten et koblet eierspørsmål (eierspm)');
  if (!SATT_AV.includes(post.prioritet_satt_av))
    f(`prioritet_satt_av må være ${SATT_AV.join(' eller ')}`);
  if (post.prioritet_grunn != null && typeof post.prioritet_grunn !== 'string')
    f('prioritet_grunn må være tekst');
  if (post.prioritet_satt_av === 'agent' && !tekst(post.prioritet_grunn))
    f('en agent må gi prioritet_grunn (én setning: hvilken prioritetsregel og hvorfor)');
  const regelSjekk = regelMotPrioritet(post);
  feil.push(...regelSjekk.feil.map((t) => `${hvem}: ${t}`));
  advarsler.push(...regelSjekk.advarsler.map((t) => `${hvem}: ${t}`));

  // Modenhet: bare de manuelle trinnene settes; i-ko, delvis, bygget og verifisert regnes ut.
  if (post.modenhet == null) f(`modenhet mangler (${MODENHET_MANUELL.join(', ')})`);
  else if (MODENHET_AVLEDET.includes(post.modenhet))
    f(
      `modenhet ${post.modenhet} regnes ut fra køen og verifiseringen; sett ${MODENHET_MANUELL.join(', ')}`,
    );
  else if (!MODENHET_MANUELL.includes(post.modenhet))
    f(`ukjent modenhet ${post.modenhet} (lov: ${MODENHET_MANUELL.join(', ')})`);

  if (post.estimat != null && !ESTIMATER.includes(post.estimat))
    f(`estimat må være en av ${ESTIMATER.join(', ')}`);

  // Kildene må finnes. Planposten peker til dokumentene, den kopierer dem ikke.
  if (post.kilder != null && !Array.isArray(post.kilder)) f('kilder må være en liste');
  for (const k of Array.isArray(post.kilder) ? post.kilder : []) {
    if (!erObjekt(k)) {
      f('hver kilde må være { sti, anker?, rolle? }');
      continue;
    }
    for (const n of Object.keys(k))
      if (!['sti', 'anker', 'rolle'].includes(n)) f(`kilde ${k.sti ?? '?'}: ukjent felt ${n}`);
    const sf = kildestiFeil(k.sti);
    if (sf) f(`kilde ${sf}`);
    else if (ctx.finnesSti && !ctx.finnesSti(k.sti)) f(`kilde ${k.sti} finnes ikke`);
    if (k.anker != null && typeof k.anker !== 'string') f(`kilde ${k.sti}: anker må være tekst`);
    if (k.rolle != null && typeof k.rolle !== 'string') f(`kilde ${k.sti}: rolle må være tekst`);
  }

  for (const felt of ['roadmap', 'avhenger', 'eierspm', 'sammenslatt_fra']) {
    const v = post[felt];
    if (v == null) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim()))
      f(`${felt} må være en liste med tekst`);
  }
  const andre = new Set((ctx.poster ?? []).map((p) => p.id));
  for (const d of Array.isArray(post.avhenger) ? post.avhenger : []) {
    if (d === post.id) f('avhenger av seg selv');
    else if (ctx.poster && !andre.has(d)) f(`avhenger av ukjent planpost ${d}`);
  }
  for (const s of Array.isArray(post.eierspm) ? post.eierspm : [])
    if (ctx.sporsmal && !Object.hasOwn(ctx.sporsmal, s))
      adv(`eierspørsmålet ${s} står ikke i køen (ko.mjs sporsmal ${s} --tekst "…")`);

  if (post.frist != null && !gyldigDato(post.frist))
    f('frist må være en dato (YYYY-MM-DD) eller null');
  // juridisk-feltet valideres felt for felt, og et punkt-id kan bare brukes i én post.
  if (post.juridisk != null) {
    const andre = new Map();
    for (const q of ctx.poster ?? [])
      if (q?.id !== post.id)
        for (const pk of q?.juridisk?.punkter ?? []) if (pk?.id) andre.set(pk.id, q.id);
    const j = validerJuridisk(post.juridisk, { andrePunkter: andre });
    for (const t of j.feil) f(t);
    for (const t of j.advarsler) adv(t);
  }
  if (post.verifisert != null) {
    const v = post.verifisert;
    if (!erObjekt(v) || !gyldigDato(v.dato) || !tekst(v.funn) || !SATT_AV.includes(v.av))
      f('verifisert må være { dato: YYYY-MM-DD, commit?, av: agent|eier, funn }');
  }
  return { feil, advarsler };
}

/**
 * Stemmer prioriteten med regelen `prioritet_grunn` viser til («Regel 3: …»)? En grunn uten regelnummer godtas.
 * Feil prioritet er en feil (koden og planen skal ikke sprike); feil kategori er en advarsel.
 */
function regelMotPrioritet(post) {
  const feil = [];
  const advarsler = [];
  const nr = regelNrFraGrunn(post?.prioritet_grunn);
  if (nr == null) return { feil, advarsler };
  const regel = prioritetsregler().find((r) => r.nr === nr);
  if (!regel) {
    feil.push(
      `prioritet_grunn viser til regel ${nr}, men reglene er 1 til ${prioritetsregler().length}`,
    );
    return { feil, advarsler };
  }
  if (regel.prioritet !== post.prioritet)
    feil.push(
      `prioritet_grunn viser til regel ${nr} (${regel.navn}), som gir ${regel.prioritet}, ikke ${post.prioritet}`,
    );
  else if (
    regel.kategorier.length &&
    !(post.naa_kategori ?? []).some((k) => regel.kategorier.includes(k))
  )
    advarsler.push(
      `regel ${nr} (${regel.navn}) gir Nå med kategori ${regel.kategorier.join(' eller ')}`,
    );
  return { feil, advarsler };
}

/** Regelnummeret i en prioritet_grunn («Regel 3: …» eller «regel 3»), eller null. */
function regelNrFraGrunn(grunn) {
  const m = /\bregel\s+(\d+)/i.exec(String(grunn ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Regelen dataene alene peker på (bare reglene med `maaling`: frist og blokkering),
 * eller null. Skjønnsreglene må agenten eller eieren vurdere. Regel 1 vinner alltid: står
 * sikkerhet som kategori, gir dette regel 1.
 * @returns {{ nr: number, navn: string, prioritet: string, kategori: string|null, grunn: string }|null}
 */
function maaltRegel(post, poster, { naa = new Date() } = {}) {
  if ((post?.naa_kategori ?? []).includes('sikkerhet') && post.prioritet === 'naa') {
    const r = prioritetsregler()[0];
    return {
      nr: r.nr,
      navn: r.navn,
      prioritet: r.prioritet,
      kategori: 'sikkerhet',
      grunn: 'kategori sikkerhet',
    };
  }
  for (const r of prioritetsregler()) {
    if (!r.maaling) continue;
    if (r.maaling.frist_dager != null && post?.frist && gyldigDato(post.frist)) {
      const dager = dagerMellom(osloDato(naa), post.frist);
      if (dager <= r.maaling.frist_dager)
        return {
          nr: r.nr,
          navn: r.navn,
          prioritet: r.prioritet,
          kategori: null,
          grunn:
            dager < 0
              ? `fristen ${post.frist} er passert`
              : `frist om ${dager} dager (${post.frist})`,
        };
    }
    if (r.maaling.blokkerer_min != null) {
      const n = blokkerer(post, poster).length;
      if (n >= r.maaling.blokkerer_min)
        return {
          nr: r.nr,
          navn: r.navn,
          prioritet: r.prioritet,
          kategori: 'viktig',
          grunn: `blokkerer ${n} poster`,
        };
    }
  }
  return null;
}

/** Postene (som ikke er droppet) som avhenger av denne. */
function blokkerer(post, poster) {
  return (poster ?? []).filter(
    (p) => p.id !== post?.id && p.prioritet !== 'dropp' && (p.avhenger ?? []).includes(post?.id),
  );
}

// ---- Prioritetsendring: grensene for agenten -----------------------------------------------------------

/**
 * Får `rolle` endre prioriteten fra `gammel` til `ny`? En agent endrer aldri en eier-satt prioritet, med ett unntak
 * (regel 1): et sikkerhetsfunn kan løfte posten til Nå med kategori sikkerhet. Det gir `loft: true` (vises i
 * innboksen, feltet agent_loft).
 * @returns {{ feil: string|null, loft: boolean }}
 */
function prioritetsTilgang(gammel, ny, rolle) {
  if (rolle === 'eier' || !gammel || gammel.prioritet_satt_av !== 'eier')
    return { feil: null, loft: false };
  const endret =
    gammel.prioritet !== ny.prioritet ||
    !likVerdi(gammel.naa_kategori ?? [], ny.naa_kategori ?? []);
  if (!endret) return { feil: null, loft: false };
  if (ny.prioritet === 'naa' && (ny.naa_kategori ?? []).includes('sikkerhet'))
    return { feil: null, loft: true };
  return {
    feil:
      `${gammel.id}: prioriteten (${gammel.prioritet}) er satt av eieren, og en agent endrer den ikke. ` +
      'Unntaket er regel 1: et sikkerhetsfunn kan løfte posten til naa med kategori sikkerhet.',
    loft: false,
  };
}

// ---- Opprette og endre --------------------------------------------------------------------------------------------

/**
 * Lager en ny planpost i registeret (muterer `reg` bare når alt er gyldig). `rolle` er den som kaller (agent eller
 * eier); prioritet_satt_av blir rollen. En agent kan ikke opprette en eier-satt prioritet.
 * @param {object} reg registeret (normalisert)
 * @param {object} inn feltene fra `plan ny --fil`
 * @param {{ rolle?: 'agent'|'eier', prosjekter?: object, sporsmal?: object, finnesSti?: Function, naa?: string }} ctx
 * @returns {{ feil: string[], advarsler: string[], post?: object }}
 */
function nyPost(reg, inn, ctx = {}) {
  const rolle = ctx.rolle === 'eier' ? 'eier' : 'agent';
  if (!erObjekt(inn)) return { feil: ['planposten må være et objekt'], advarsler: [] };
  const feil = [];
  const advarsler = [];
  const hvem = typeof inn.id === 'string' ? inn.id : '(uten id)';
  if (typeof inn.id === 'string' && idBrukt(reg, inn.id))
    feil.push(`${hvem}: id-en er brukt fra før (id-er brukes aldri om igjen)`);
  for (const k of Object.keys(inn)) {
    if (AVLEDET_FELT.has(k))
      advarsler.push(`${hvem}: ${k} regnes ut fra køen (oppgave.plan) og lagres ikke`);
    else if (VERKTOY_FELT.has(k) && k !== 'id') feil.push(`${hvem}: ${k} settes av verktøyet`);
  }
  if (inn.prioritet_satt_av === 'eier' && rolle !== 'eier')
    feil.push(
      `${hvem}: en agent kan ikke sette prioritet_satt_av eier (bruk --satt-av eier når eieren bestemmer)`,
    );
  const post = {};
  for (const [k, v] of Object.entries(inn)) {
    if (AVLEDET_FELT.has(k) || v === undefined) continue;
    post[k] = klonJson(v);
  }
  post.prioritet_satt_av = rolle;
  if (post.modenhet == null) post.modenhet = 'ide';
  post.opprettet = ctx.naa ?? new Date().toISOString();
  const v = validerPost(post, {
    prosjekter: ctx.prosjekter,
    poster: reg.poster,
    sporsmal: ctx.sporsmal,
    finnesSti: ctx.finnesSti,
  });
  feil.push(...v.feil);
  advarsler.push(...v.advarsler);
  if (feil.length) return { feil, advarsler };
  reg.poster.push(post);
  return { feil: [], advarsler, post };
}

/**
 * Endrer feltene i én planpost (`plan endre`, `plan prioriter`, `plan verifiser`). `felt` er { navn: verdi }, der
 * null fjerner feltet. Muterer bare når resultatet er gyldig. Prioritetsfeltene følger grensene for agenten.
 * @returns {{ feil: string[], advarsler: string[], post?: object, endret?: string[], loft?: boolean }}
 */
function endrePost(reg, id, felt, ctx = {}) {
  const rolle = ctx.rolle === 'eier' ? 'eier' : 'agent';
  const i = (reg.poster ?? []).findIndex((p) => p.id === id);
  if (i < 0)
    return {
      feil: [
        reg.arkiv?.[id]
          ? `${id} er slått sammen inn i ${reg.arkiv[id].sammenslatt_til}`
          : `ukjent planpost ${id}`,
      ],
      advarsler: [],
    };
  if (!erObjekt(felt)) return { feil: [`${id}: feltene må være et objekt`], advarsler: [] };
  const gammel = reg.poster[i];
  const feil = [];
  const advarsler = [];
  for (const k of Object.keys(felt)) {
    if (AVLEDET_FELT.has(k)) feil.push(`${id}: ${k} regnes ut fra køen og endres ikke her`);
    else if (VERKTOY_FELT.has(k) || k === 'prioritet_satt_av')
      feil.push(`${id}: ${k} settes av verktøyet`);
  }
  if (feil.length) return { feil, advarsler };
  const ny = klonJson(gammel);
  for (const [k, v] of Object.entries(felt)) {
    if (v === null || v === undefined) delete ny[k];
    else ny[k] = klonJson(v);
  }
  // Byttes prioriteten bort fra naa eller dropp, følger kategorien eller droppgrunnen med ut (med mindre kalleren
  // har satt dem selv).
  if (ny.prioritet !== 'naa' && !('naa_kategori' in felt)) delete ny.naa_kategori;
  if (ny.prioritet !== 'dropp' && !('dropp_grunn' in felt)) delete ny.dropp_grunn;
  const prioritetEndret =
    gammel.prioritet !== ny.prioritet ||
    !likVerdi(gammel.naa_kategori ?? [], ny.naa_kategori ?? []);
  let loft = false;
  if (prioritetEndret) {
    const t = prioritetsTilgang(gammel, ny, rolle);
    if (t.feil) return { feil: [t.feil], advarsler };
    loft = t.loft;
    ny.prioritet_satt_av = rolle;
    // En ny prioritet trenger en ny grunn fra en agent (grunnen til den gamle gjelder ikke lenger). Eieren trenger
    // ingen grunn, men den gamle følger ikke med.
    if (!('prioritet_grunn' in felt)) delete ny.prioritet_grunn;
    if (rolle === 'agent' && !('prioritet_grunn' in felt))
      feil.push(
        `${id}: ny prioritet krever prioritet_grunn (én setning: hvilken prioritetsregel og hvorfor)`,
      );
    if (loft)
      ny.agent_loft = {
        at: ctx.naa ?? new Date().toISOString(),
        av: ctx.av ?? 'agent',
        fra: { prioritet: gammel.prioritet, naa_kategori: gammel.naa_kategori ?? null },
      };
    else if (rolle === 'eier') delete ny.agent_loft;
  } else if (
    rolle === 'agent' &&
    gammel.prioritet_satt_av === 'eier' &&
    !likVerdi(gammel.prioritet_grunn, ny.prioritet_grunn)
  )
    return {
      feil: [`${id}: prioritet_grunn hører til eierens prioritet, og en agent endrer den ikke`],
      advarsler,
    };
  const v = validerPost(ny, {
    prosjekter: ctx.prosjekter,
    poster: reg.poster.filter((p) => p.id !== id),
    sporsmal: ctx.sporsmal,
    finnesSti: ctx.finnesSti,
  });
  feil.push(...v.feil);
  advarsler.push(...v.advarsler);
  if (feil.length) return { feil, advarsler };
  const endret = [...new Set([...Object.keys(gammel), ...Object.keys(ny)])].filter(
    (k) => !likVerdi(gammel[k], ny[k]),
  );
  reg.poster[i] = ny;
  return { feil: [], advarsler, post: ny, endret, loft };
}

/**
 * Feltene en prioritetsendring setter (felles for `prioriter` og `prioriterMange`), eller null når en kategori er gitt
 * til en annen prioritet enn naa.
 * @param {{ prioritet: string, kategori?: string[]|null, grunn?: string|null }} valg
 */
function prioritetFelt(valg) {
  const felt = { prioritet: valg.prioritet };
  if (valg.prioritet === 'naa') felt.naa_kategori = valg.kategori?.length ? valg.kategori : null;
  else if (valg.kategori?.length) return null;
  if (valg.prioritet === 'dropp') felt.dropp_grunn = valg.grunn ?? null;
  if (valg.grunn != null) felt.prioritet_grunn = valg.grunn;
  return felt;
}

/**
 * Masseendring av prioritet (`plan prioriter <id…> <prioritet>`). Alt eller ingenting: feiler én post, endres ingen.
 * @param {{ prioritet: string, kategori?: string[]|null, grunn?: string|null }} valg
 * @returns {{ feil: string[], advarsler: string[], endret: string[], uendret: string[], loft: string[] }}
 */
function prioriter(reg, ider, valg, ctx = {}) {
  const feil = [];
  const advarsler = [];
  const endret = [];
  const uendret = [];
  const loft = [];
  if (!PRIORITETER.includes(valg?.prioritet))
    return {
      feil: [`prioritet må være en av ${PRIORITETER.join(', ')}`],
      advarsler,
      endret,
      uendret,
      loft,
    };
  if (!ider?.length) return { feil: ['ingen planposter valgt'], advarsler, endret, uendret, loft };
  const kopi = klonJson(reg);
  for (const id of [...new Set(ider)]) {
    const felt = prioritetFelt(valg);
    if (!felt) {
      feil.push(`--kategori brukes bare med naa`);
      break;
    }
    const r = endrePost(kopi, id, felt, ctx);
    feil.push(...r.feil);
    advarsler.push(...r.advarsler);
    if (r.feil.length) continue;
    if (r.endret.length) endret.push(id);
    else uendret.push(id);
    if (r.loft) loft.push(id);
  }
  if (feil.length) return { feil, advarsler, endret: [], uendret: [], loft: [] };
  reg.poster = kopi.poster;
  return { feil, advarsler, endret, uendret, loft };
}

/**
 * mange prioritetsendringer i én skriving (`plan prioriter-mange --fil <json>`), slik prioritetskartet lagrer
 * hele utkastet: én lås, én endringslogg-post og én angre. Hvert element er { id, prioritet, kategori?, grunn? } og
 * behandles som `prioriter` for den ene posten (samme tilgangsregler og validering). Alt eller ingenting: er ett
 * element ugyldig, eller feiler én post, endres ingen.
 * @param {{ id: string, prioritet: string, kategori?: string[]|null, grunn?: string|null }[]} liste
 * @returns {{ feil: string[], advarsler: string[], endret: string[], uendret: string[], loft: string[] }}
 */
function prioriterMange(reg, liste, ctx = {}) {
  const feil = [];
  const advarsler = [];
  const tomt = () => ({ feil, advarsler, endret: [], uendret: [], loft: [] });
  if (!Array.isArray(liste) || !liste.length) {
    feil.push('fila må være en ikke-tom liste med { id, prioritet, kategori?, grunn? }');
    return tomt();
  }
  // Formen først, for hele lista, så eieren ser alle feilene på én gang.
  const sett = new Set();
  liste.forEach((x, i) => {
    const hvor = `element ${i + 1}`;
    if (!erObjekt(x))
      return void feil.push(`${hvor}: må være { id, prioritet, kategori?, grunn? }`);
    for (const n of Object.keys(x))
      if (!['id', 'prioritet', 'kategori', 'grunn'].includes(n))
        feil.push(`${hvor}: ukjent felt ${n}`);
    if (typeof x.id !== 'string' || !x.id) feil.push(`${hvor}: id mangler`);
    else if (sett.has(x.id)) feil.push(`${x.id}: står flere ganger i lista`);
    else sett.add(x.id);
    if (!PRIORITETER.includes(x.prioritet))
      feil.push(`${x.id ?? hvor}: prioritet må være en av ${PRIORITETER.join(', ')}`);
    if (
      x.kategori != null &&
      !(Array.isArray(x.kategori) && x.kategori.every((k) => typeof k === 'string'))
    )
      feil.push(`${x.id ?? hvor}: kategori må være en liste med tekst`);
    if (x.grunn != null && typeof x.grunn !== 'string')
      feil.push(`${x.id ?? hvor}: grunn må være tekst`);
  });
  if (feil.length) return tomt();

  const endret = [];
  const uendret = [];
  const loft = [];
  const kopi = klonJson(reg);
  for (const x of liste) {
    const felt = prioritetFelt({
      prioritet: x.prioritet,
      kategori: x.kategori,
      grunn: x.grunn ?? null,
    });
    if (!felt) {
      feil.push(`${x.id}: kategori brukes bare med naa`);
      continue;
    }
    const r = endrePost(kopi, x.id, felt, ctx);
    feil.push(...r.feil);
    advarsler.push(...r.advarsler);
    if (r.feil.length) continue;
    if (r.endret.length) endret.push(x.id);
    else uendret.push(x.id);
    if (r.loft) loft.push(x.id);
  }
  if (feil.length) return tomt();
  reg.poster = kopi.poster;
  return { feil, advarsler, endret, uendret, loft };
}

/**
 * Setter `verifisert` (`plan verifiser <id> --funn "…"`): dato i dag (norsk tid), commit og hvem. `ctx` som endrePost
 * (prosjekter, sporsmal, finnesSti), så valideringen av posten er den samme.
 */
function verifiser(
  reg,
  id,
  { funn, commit = null, rolle = 'agent', naa = new Date() } = {},
  ctx = {},
) {
  if (!tekst(funn))
    return {
      feil: [`${id}: --funn mangler (kort: hva ble sjekket mot koden og hva ble funnet)`],
      advarsler: [],
    };
  const v = { dato: osloDato(naa), av: rolle === 'eier' ? 'eier' : 'agent', funn: funn.trim() };
  if (commit) v.commit = String(commit).trim();
  // Verifisering er ikke en prioritetsendring: rollen spiller ingen rolle for tilgangen her.
  return endrePost(reg, id, { verifisert: v }, { ...ctx, rolle: 'eier' });
}

/**
 * Slår sammen postene `fra` inn i `til` (`plan slaa-sammen <til> <fra…>`). `til` får kildene, roadmap-ankrene,
 * avhengighetene og eierspørsmålene til de andre (uten duplikater) og `sammenslatt_fra`. De andre flyttes til
 * `arkiv` med `sammenslatt_til`, så id-ene fortsatt er opptatt og kan slås opp. Avhengigheter i andre poster som
 * pekte på en sammenslått post, peker etterpå på `til`. Køoppgaver med `plan: <gammel id>` telles med i `til`
 * (avledetModenhet). Prioriteten til `til` endres ikke.
 */
function slaaSammen(reg, til, fra, { naa = new Date().toISOString() } = {}) {
  const feil = [];
  const maal = finnPost(reg, til);
  if (!maal) feil.push(`ukjent planpost ${til}`);
  const andre = [...new Set(fra ?? [])];
  if (!andre.length) feil.push('oppgi minst én post å slå sammen inn i den første');
  for (const id of andre) {
    if (id === til) feil.push(`${id} kan ikke slås sammen med seg selv`);
    else if (!finnPost(reg, id)) feil.push(`ukjent planpost ${id}`);
  }
  if (feil.length) return { feil, advarsler: [] };
  const ny = klonJson(maal);
  const union = (a, b) => [...new Set([...(a ?? []), ...(b ?? [])])];
  const kilder = [...(ny.kilder ?? [])];
  for (const id of andre) {
    const p = finnPost(reg, id);
    for (const k of p.kilder ?? [])
      if (!kilder.some((x) => x.sti === k.sti && (x.anker ?? null) === (k.anker ?? null)))
        kilder.push(klonJson(k));
    ny.roadmap = union(ny.roadmap, p.roadmap);
    ny.avhenger = union(ny.avhenger, p.avhenger);
    ny.eierspm = union(ny.eierspm, p.eierspm);
    ny.sammenslatt_fra = union(ny.sammenslatt_fra, [id, ...(p.sammenslatt_fra ?? [])]);
  }
  if (kilder.length) ny.kilder = kilder;
  const ute = new Set([til, ...andre]);
  ny.avhenger = (ny.avhenger ?? []).filter((d) => !ute.has(d));
  for (const felt of ['roadmap', 'avhenger', 'eierspm']) if (!ny[felt]?.length) delete ny[felt];
  const poster = [];
  for (const p of reg.poster) {
    if (andre.includes(p.id)) {
      reg.arkiv[p.id] = { ...klonJson(p), sammenslatt_til: til, sammenslatt_at: naa };
      continue;
    }
    if (p.id === til) {
      poster.push(ny);
      continue;
    }
    if ((p.avhenger ?? []).some((d) => andre.includes(d))) {
      const q = klonJson(p);
      q.avhenger = [...new Set(q.avhenger.map((d) => (andre.includes(d) ? til : d)))].filter(
        (d) => d !== q.id,
      );
      if (!q.avhenger.length) delete q.avhenger;
      poster.push(q);
    } else poster.push(p);
  }
  reg.poster = poster;
  return { feil: [], advarsler: [], post: ny, arkivert: andre };
}

// ---- Avledet modenhet -----------------------------------------------------------------------------------

/** Id-ene som teller for en post: den selv og postene som er slått sammen inn i den (rekursivt). */
function planIder(post) {
  return new Set([post.id, ...(post.sammenslatt_fra ?? [])]);
}

/**
 * Køoppgavene som hører til posten (oppgave.plan = postens id, eller en id som er slått sammen inn i den).
 * Kansellerte teller ikke.
 */
function koOppgaverFor(post, oppgaver) {
  const ider = planIder(post);
  return (oppgaver ?? []).filter((o) => o?.plan && ider.has(o.plan) && o.status !== 'kansellert');
}

/** Er verifiseringen foreldet: over FORELDET_DAGER dager gammel? (Endrede filer sjekkes i `plan sjekk`.) */
function erForeldet(post, { naa = new Date() } = {}) {
  const d = post?.verifisert?.dato;
  if (!d || !gyldigDato(d)) return false;
  return dagerMellom(d, osloDato(naa)) > FORELDET_DAGER;
}

/**
 * Modenheten slik den vises:
 * - ingen oppgaver: modenheten fra planarbeidet,
 * - minst én åpen og ingen ferdige: i-ko,
 * - noen ferdige og noen åpne: delvis (brøk, f.eks. 3/7),
 * - alle ferdige: bygget; verifisert når posten er verifisert samme dag som eller etter den siste ferdige oppgaven
 *   og verifiseringen ikke er foreldet.
 * @returns {{ modenhet: string, ferdige: number, totalt: number, brok: string|null, ko_oppgaver: string[],
 *   foreldet: boolean }}
 */
function avledetModenhet(post, oppgaver, { naa = new Date() } = {}) {
  const liste = koOppgaverFor(post, oppgaver);
  const totalt = liste.length;
  const ferdige = liste.filter((o) => o.status === 'ferdig').length;
  const foreldet = erForeldet(post, { naa });
  const ut = { ferdige, totalt, brok: null, ko_oppgaver: liste.map((o) => o.id), foreldet };
  if (!totalt) return { ...ut, modenhet: post.modenhet ?? 'ide' };
  if (ferdige === 0) return { ...ut, modenhet: 'i-ko' };
  if (ferdige < totalt) return { ...ut, modenhet: 'delvis', brok: `${ferdige}/${totalt}` };
  const sisteFerdig = liste
    .map((o) => (o.ferdig ? osloDato(new Date(o.ferdig)) : null))
    .filter(Boolean)
    .sort()
    .pop();
  const vdato = post.verifisert?.dato;
  const verifisert = vdato && !foreldet && (!sisteFerdig || vdato >= sisteFerdig);
  return { ...ut, modenhet: verifisert ? 'verifisert' : 'bygget' };
}

// ---- Sortering, filter og henting --------------------------------------------------------------------------------

/**
 * Sortering: prioritet (Nå, Eier, Senere, Dropp), så frist (tidligst først, uten frist sist), så antall
 * poster som blokkeres (flest først), så liten størrelse først, så id.
 */
function sorterPoster(poster) {
  const alle = poster ?? [];
  const blokk = new Map(alle.map((p) => [p.id, blokkerer(p, alle).length]));
  const pri = (p) => {
    const i = PRIORITETER.indexOf(p.prioritet);
    return i < 0 ? PRIORITETER.length : i;
  };
  const est = (p) => {
    const i = ESTIMATER.indexOf(p.estimat);
    return i < 0 ? ESTIMATER.length : i;
  };
  return [...alle].sort(
    (a, b) =>
      pri(a) - pri(b) ||
      (a.frist ?? '9999-12-31').localeCompare(b.frist ?? '9999-12-31') ||
      blokk.get(b.id) - blokk.get(a.id) ||
      est(a) - est(b) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Filter til `plan vis`. Droppede poster skjules som standard og tas med når filteret spør etter dropp
 * eller `alle` er satt. Søket er uten hensyn til store og små bokstaver, i id, tittel, kort, merknad, roadmap-ankre,
 * kildestier og prosjekt.
 * @param {{ modul?: string|null, prosjekt?: string|null, prioritet?: string[], modenhet?: string[], sok?: string|null,
 *   alle?: boolean }} filter
 * @returns {object[]} postene med `avledet` og `modul`, sortert (sorterPoster)
 */
function filtrerPoster(reg, ko, filter = {}, { naa = new Date() } = {}) {
  const prosjekter = ko?.prosjekter ?? {};
  const sok = tekst(filter.sok).toLowerCase();
  const pri = filter.prioritet?.length ? new Set(filter.prioritet) : null;
  const mod = filter.modenhet?.length ? new Set(filter.modenhet) : null;
  const ut = [];
  for (const p of sorterPoster(reg.poster)) {
    if (p.prioritet === 'dropp' && !filter.alle && !pri?.has('dropp')) continue;
    if (pri && !pri.has(p.prioritet)) continue;
    if (filter.prosjekt && p.prosjekt !== filter.prosjekt) continue;
    const modul = modulFor(p, prosjekter);
    if (filter.modul && modul !== filter.modul) continue;
    const avledet = avledetModenhet(p, ko?.oppgaver, { naa });
    if (mod && !mod.has(avledet.modenhet)) continue;
    if (sok) {
      const hay = [
        p.id,
        p.tittel,
        p.kort,
        p.merknad,
        p.prosjekt,
        ...(p.roadmap ?? []),
        ...(p.kilder ?? []).map((k) => k.sti),
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      if (!hay.includes(sok)) continue;
    }
    ut.push({ ...p, modul, avledet });
  }
  return ut;
}

/**
 * Alt `/planer` trenger om en post, et prosjekt eller en modul (`plan hent <id|prosjekt|modul>`): postene med
 * avledet modenhet, kildene (finnes de?), køstatus, eierspørsmålene med tekst og om de er avklart, og juridiske
 * punkter. Kopier-linjene inneholder bare id og titler.
 * @param {{ finnesSti?: Function, naa?: Date }} ctx
 * @returns {{ feil: string[], type?: 'post'|'prosjekt'|'modul', noekkel?: string, tittel?: string|null,
 *   poster?: object[], kopier?: string }}
 */
function hent(reg, ko, noekkel, ctx = {}) {
  const prosjekter = ko?.prosjekter ?? {};
  const omrader = ko?.omrader ?? {};
  const naa = ctx.naa ?? new Date();
  let type;
  let utvalg;
  let tittel = null;
  if (finnPost(reg, noekkel)) {
    type = 'post';
    utvalg = [finnPost(reg, noekkel)];
    tittel = utvalg[0].tittel;
  } else if (reg.arkiv?.[noekkel]) {
    return { feil: [`${noekkel} er slått sammen inn i ${reg.arkiv[noekkel].sammenslatt_til}`] };
  } else if (Object.hasOwn(prosjekter, noekkel)) {
    type = 'prosjekt';
    utvalg = reg.poster.filter((p) => p.prosjekt === noekkel);
    tittel = prosjekter[noekkel]?.tittel ?? null;
  } else if (Object.hasOwn(omrader, noekkel)) {
    type = 'modul';
    utvalg = reg.poster.filter((p) => modulFor(p, prosjekter) === noekkel);
    tittel = omrader[noekkel]?.tittel ?? null;
  } else return { feil: [`fant ingen planpost, prosjekt eller modul som heter ${noekkel}`] };

  const perId = new Map((ko?.oppgaver ?? []).map((o) => [o.id, o]));
  const avklart = new Set(ko?.avklart ?? []);
  const poster = sorterPoster(utvalg).map((p) => {
    const avledet = avledetModenhet(p, ko?.oppgaver, { naa });
    return {
      ...klonJson(p),
      modul: modulFor(p, prosjekter),
      avledet,
      kilder: (p.kilder ?? []).map((k) => ({
        ...k,
        finnes: ctx.finnesSti ? Boolean(ctx.finnesSti(k.sti)) : null,
      })),
      ko: avledet.ko_oppgaver.map((id) => {
        const o = perId.get(id);
        return { id, tittel: o?.tittel ?? null, status: o?.status ?? null };
      }),
      eiersporsmal: (p.eierspm ?? []).map((s) => ({
        id: s,
        tekst: ko?.sporsmal?.[s]?.tekst ?? null,
        avklart: avklart.has(s),
        svar: ko?.avklaringer?.[s]?.svar ?? null,
      })),
      juridisk: p.juridisk ?? null,
      blokkerer: blokkerer(p, reg.poster).map((q) => q.id),
      maalt_regel: maaltRegel(p, reg.poster, { naa }),
    };
  });
  return {
    feil: [],
    type,
    noekkel,
    tittel,
    poster,
    kopier: kopierLinje(type, noekkel, tittel, poster),
  };
}

/** Startlinja for Claude Code: bare id og titler, aldri innhold fra dokumentene. */
function kopierLinje(type, noekkel, tittel, poster) {
  const hva = type === 'post' ? 'planposten' : type === 'prosjekt' ? 'prosjektet' : 'modulen';
  const ider =
    type === 'post'
      ? ''
      : ` (${poster.length} poster: ${poster
          .map((p) => p.id)
          .slice(0, 12)
          .join(', ')}${poster.length > 12 ? ', …' : ''})`;
  return `/planer ${noekkel}: jobb med ${hva} «${tittel ?? noekkel}»${ider}`;
}

// ---- Endringslogg og angre (som køen) -----------------------------------------------------------------------------

/**
 * Forskjellen mellom to utgaver av registeret, felt for felt per post (`samling: 'poster'`) og per arkivpost
 * (`samling: 'arkiv'`). En post som kommer til eller forsvinner, gir én endring med `felt: '*'` (hele posten).
 * dokumentene (`samling: 'dokumenter'`) på samme måte.
 * @returns {{ samling: 'poster'|'arkiv'|'dokumenter', id: string, felt: string, for: unknown, etter: unknown }[]}
 */
function planDiff(forReg, etterReg) {
  const ut = [];
  const forP = new Map((forReg?.poster ?? []).map((p) => [p.id, p]));
  const etterP = new Map((etterReg?.poster ?? []).map((p) => [p.id, p]));
  const sammenlign = (samling, f, e) => {
    for (const id of [...new Set([...f.keys(), ...e.keys()])]) {
      const a = f.get(id);
      const b = e.get(id);
      if (!a || !b) {
        if (!likVerdi(a, b))
          ut.push({ samling, id, felt: '*', for: klonJson(a ?? null), etter: klonJson(b ?? null) });
        continue;
      }
      for (const felt of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
        if (!likVerdi(a[felt], b[felt]))
          ut.push({
            samling,
            id,
            felt,
            for: klonJson(a[felt] ?? null),
            etter: klonJson(b[felt] ?? null),
          });
    }
  };
  sammenlign('poster', forP, etterP);
  // dokumentregisteret, med samme form (felt for felt per dokument).
  sammenlign(
    'dokumenter',
    new Map((forReg?.dokumenter ?? []).map((d) => [d.id, d])),
    new Map((etterReg?.dokumenter ?? []).map((d) => [d.id, d])),
  );
  sammenlign(
    'arkiv',
    new Map(Object.entries(forReg?.arkiv ?? {})),
    new Map(Object.entries(etterReg?.arkiv ?? {})),
  );
  return ut;
}

/** Legger en post i registerets endringslogg; null når ingenting endret seg. */
function loggEndring(reg, { av = null, handling, endringer, naa = new Date().toISOString() } = {}) {
  if (!Array.isArray(endringer) || !endringer.length) return null;
  const logg = Array.isArray(reg.endringslogg) ? reg.endringslogg : [];
  const nr = logg.reduce((m, p) => Math.max(m, Number(p?.nr) || 0), 0) + 1;
  const post = {
    nr,
    at: naa,
    av: String(av ?? '').trim() || 'ukjent',
    handling: String(handling ?? 'ukjent'),
    endringer: klonJson(endringer),
  };
  logg.push(post);
  reg.endringslogg = logg.slice(-ENDRINGSLOGG_MAKS);
  return post;
}

/** Siste post i endringsloggen som ikke er angret, eller null. */
function sisteAngrbare(reg) {
  const logg = Array.isArray(reg?.endringslogg) ? reg.endringslogg : [];
  for (let i = logg.length - 1; i >= 0; i -= 1) if (!logg[i]?.angret) return logg[i];
  return null;
}

/**
 * Ruller tilbake siste post i endringsloggen som ikke er angret (`plan angre`). Nekter når et felt ikke lenger har
 * verdien posten satte (noen har endret det siden). Posten blir stående, merket `angret`. Postene som angres, beholder
 * rekkefølgen; en post som kommer tilbake (fra en sammenslåing), legges sist. `vis` sjekker uten å endre.
 * @returns {{ feil: string[], post?: object, vis?: boolean }}
 */
function angre(reg, { av = null, naa = new Date().toISOString(), vis = false } = {}) {
  const post = sisteAngrbare(reg);
  if (!post)
    return { feil: ['ingenting å angre (endringsloggen er tom, eller alt i den er angret)'] };
  const poster = new Map(klonJson(reg.poster ?? []).map((p) => [p.id, p]));
  const rekke = (reg.poster ?? []).map((p) => p.id);
  const arkiv = new Map(Object.entries(klonJson(reg.arkiv ?? {})));
  const dokumenter = new Map(klonJson(reg.dokumenter ?? []).map((d) => [d.id, d]));
  const dokRekke = (reg.dokumenter ?? []).map((d) => d.id);
  const feil = [];
  for (const e of post.endringer ?? []) {
    const m = e.samling === 'arkiv' ? arkiv : e.samling === 'dokumenter' ? dokumenter : poster;
    const naaVerdi = e.felt === '*' ? (m.get(e.id) ?? null) : (m.get(e.id)?.[e.felt] ?? null);
    if (e.felt !== '*' && !m.has(e.id)) {
      feil.push(`${e.id}: finnes ikke lenger`);
      continue;
    }
    if (!likVerdi(naaVerdi, e.etter)) {
      feil.push(`${e.id} ${e.felt === '*' ? '(hele posten)' : e.felt} er endret siden`);
      continue;
    }
    if (e.felt === '*') {
      if (e.for == null) m.delete(e.id);
      else {
        m.set(e.id, klonJson(e.for));
        if (m === poster && !rekke.includes(e.id)) rekke.push(e.id);
        if (m === dokumenter && !dokRekke.includes(e.id)) dokRekke.push(e.id);
      }
    } else if (e.for == null) delete m.get(e.id)[e.felt];
    else m.get(e.id)[e.felt] = klonJson(e.for);
  }
  if (feil.length) return { feil, post };
  if (vis) return { feil: [], post, vis: true };
  reg.poster = rekke.filter((id) => poster.has(id)).map((id) => poster.get(id));
  reg.arkiv = Object.fromEntries(arkiv);
  if (Array.isArray(reg.dokumenter) || dokumenter.size)
    reg.dokumenter = dokRekke.filter((id) => dokumenter.has(id)).map((id) => dokumenter.get(id));
  post.angret = { at: naa, av: String(av ?? '').trim() || 'ukjent' };
  return { feil: [], post };
}

/** Optimistisk samtidighet for registeret: null når det ikke er endret etter `forvent`, ellers feilteksten. */
function forventSjekk(reg, forvent) {
  if (forvent == null) return null;
  const f = Date.parse(String(forvent));
  if (!Number.isFinite(f))
    return `ugyldig --forvent-endret ${forvent} (ISO-tid, feltet endret i planer.json)`;
  const e = Date.parse(String(reg?.endret ?? ''));
  if (Number.isFinite(e) && e > f)
    return `planregisteret er endret ${reg.endret}, etter ${forvent} som forhåndsvisningen bygget på. Hent det på nytt og se over endringen igjen.`;
  return null;
}

/**
 * Tolker `--felt navn=verdi` (gjentas). Verdien leses som JSON når den er gyldig JSON (tall, liste, objekt, null,
 * true/false, "tekst"), ellers som tekst. Tom verdi (`navn=`) fjerner feltet.
 * @returns {{ felt: object, feil: string[] }}
 */
function tolkFeltArg(liste) {
  const felt = {};
  const feil = [];
  for (const s of liste ?? []) {
    const i = String(s).indexOf('=');
    if (i <= 0) {
      feil.push(`--felt ${s}: bruk navn=verdi`);
      continue;
    }
    const navn = s.slice(0, i).trim();
    const raa = s.slice(i + 1);
    if (raa === '') {
      felt[navn] = null;
      continue;
    }
    try {
      felt[navn] = JSON.parse(raa);
    } catch {
      felt[navn] = raa;
    }
  }
  return { felt, feil };
}

// ---- Modulene ---------------------------------------------------------------------------------------------------
//
// Modulene er områder i ko.json (`omrader`). Hvilke moduler prosjektet har, står i ko.config.json (`moduler`:
// [{ oid, tittel, beskrivelse }]); standarden i koKonfig.js er en eksempelmodul og «Uten fast modul».
// `ko.mjs plan moduler` oppretter dem som mangler; et område som finnes, endres aldri (eieren kan ha gitt det en
// annen tittel). Rekkefølgen i lista er rekkefølgen modulene vises i.

/** Modulene fra konfigurasjonen (en tom eller ugyldig liste gir ingen moduler). */
function moduler() {
  const m = konfig().moduler;
  return Array.isArray(m) ? m.filter((x) => x && typeof x.oid === 'string') : [];
}

/**
 * Forslag til modul per prosjekt-id (ko.config.json `prosjektModulForslag`: { <pid>: <oid> }). Brukes bare med
 * `ko.mjs plan moduler --koble`, og bare for prosjekter som ennå ikke har en modul.
 */
function prosjektModulForslag() {
  const f = konfig().prosjektModulForslag;
  return erObjekt(f) ? f : {};
}

/**
 * Hva `plan moduler` vil gjøre: modulene som mangler i `omrader`, de som finnes (uendret, med tittelen de har), og
 * med `koble` prosjektene uten modul som får forslaget i prosjektModulForslag().
 * Modulene og forslagene kan sendes inn (tester); ellers kommer de fra konfigurasjonen.
 * @returns {{ nye: object[], finnes: { oid: string, tittel: string|null }[], koble: { pid: string, oid: string }[] }}
 */
function modulPlan(ko, { koble = false, liste = moduler(), forslag = prosjektModulForslag() } = {}) {
  const omrader = ko?.omrader ?? {};
  const nye = liste.filter((m) => !Object.hasOwn(omrader, m.oid)).map((m) => ({ ...m }));
  const finnes = liste.filter((m) => Object.hasOwn(omrader, m.oid)).map((m) => ({
    oid: m.oid,
    tittel: omrader[m.oid]?.tittel ?? null,
  }));
  const ut = [];
  if (koble)
    for (const [pid, p] of Object.entries(ko?.prosjekter ?? {})) {
      const oid = Object.hasOwn(forslag, pid) ? forslag[pid] : null;
      if (oid && !p?.omrade) ut.push({ pid, oid });
    }
  return { nye, finnes, koble: ut };
}

// ---- Prosjektfasen ----------------------------------------------------------------------------------------

/** Lovlige verdier for prosjektets `fase`. `plan`: prosjektet finnes i planarbeidet, men har ingen køoppgaver ennå. */
const PROSJEKT_FASER = ['plan'];

/**
 * Prosjektene med `fase: plan` som får køoppgaver nå (add), så fasen tas bort i samme skriving. Fasen gjelder bare
 * «ennå ingen køoppgaver».
 */
function fasePlanAvsluttes(prosjekter, nye) {
  const ut = new Set();
  for (const n of nye ?? []) {
    const pid = n?.prosjekt;
    if (pid && prosjekter?.[pid]?.fase === 'plan') ut.add(pid);
  }
  return [...ut];
}

// ---- Kobling køoppgave → planpost (`add --plan`) -------------------------------------------------------------

/** Feilteksten når `planId` ikke er en planpost i registeret (arkiverte poster peker til målet), ellers null. */
function planKoblingFeil(reg, planId) {
  if (typeof planId !== 'string' || !ID_MONSTER.test(planId))
    return `plan ${String(planId)}: må være en planpost-id (PL-NAVN-1)`;
  if (finnPost(reg, planId)) return null;
  if (reg?.arkiv?.[planId])
    return `planposten ${planId} er slått sammen inn i ${reg.arkiv[planId].sammenslatt_til}; bruk den`;
  return `ukjent planpost ${planId} (opprett den først: ko.mjs plan ny --fil <json>)`;
}

/**
 * Kobler nye køoppgaver til planposter (`add --plan <id>` og feltet `plan` i add-fila). `planId` settes på oppgaver
 * uten eget `plan`. Nekter en ukjent eller sammenslått planpost (alt eller ingenting). Mangler oppgaven prosjekt, får
 * den postens prosjekt (hver oppgave får plan, prosjekt og kilde). Advarer når posten ikke er klar, er droppet,
 * eller hører til et annet prosjekt enn oppgaven. Posten blir i-ko av seg selv (avledetModenhet).
 * @returns {{ feil: string[], advarsler: string[], oppgaver: object[] }} oppgavene som kopier med feltene satt
 */
function koblePlan(reg, nye, planId = null) {
  const feil = [];
  const advarsler = [];
  const oppgaver = [];
  const varslet = new Set();
  for (const n of nye ?? []) {
    const o = erObjekt(n) ? { ...n } : n;
    if (!erObjekt(o)) {
      oppgaver.push(o);
      continue;
    }
    if (o.plan == null && planId) o.plan = planId;
    if (o.plan != null) {
      const hvem = o.id ?? '(uten id)';
      const fe = planKoblingFeil(reg, o.plan);
      if (fe) feil.push(`${hvem}: ${fe}`);
      else {
        const post = finnPost(reg, o.plan);
        if (!o.prosjekt && post.prosjekt) o.prosjekt = post.prosjekt;
        else if (o.prosjekt && post.prosjekt && o.prosjekt !== post.prosjekt)
          advarsler.push(
            `${hvem}: prosjekt ${o.prosjekt}, men planposten ${post.id} hører til ${post.prosjekt}`,
          );
        if (!varslet.has(post.id)) {
          varslet.add(post.id);
          if (post.prioritet === 'dropp')
            advarsler.push(
              `planposten ${post.id} er droppet (${post.dropp_grunn ?? 'uten grunn'}); hent den tilbake med plan prioriter`,
            );
          else if (MODENHET_MANUELL.includes(post.modenhet) && post.modenhet !== 'klar')
            advarsler.push(
              `planposten ${post.id} er ${post.modenhet}, ikke klar (kontroller før pakking)`,
            );
        }
      }
    }
    oppgaver.push(o);
  }
  return { feil, advarsler, oppgaver };
}

// ---- Hygiene: `plan sjekk` ----------------------------------------------------------------------------------

/**
 * Grovt antall køspor per estimat, til kapasitetsregnestykket (S under en halv dag, M 1 til 3 spor, L 4 til
 * 10, XL en modul). Grovt med vilje; endres her.
 */
const ESTIMAT_SPOR = { S: 1, M: 2, L: 7, XL: 15 };
/** Vinduet (dager) for gjennomstrømningen i kapasitetsregnestykket. */
const KAPASITET_VINDU_DAGER = 28;
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Dokumenter som aldri regnes som uregistrerte (oversikter og agentinstrukser, ikke planer): README, CLAUDE.md og
 * den valgfrie dokumentindeksen (ko.config.json `indeksFil`, se koIndeks.js).
 */
function uregistrertUnntak() {
  const ut = [/(^|\/)README\.md$/i, /(^|\/)CLAUDE\.md$/];
  // Samme regel som koIndeks.indeksFil(): mangler feltet, gjelder docs/INDEKS.md; null slår indeksen av.
  const raa = konfig().indeksFil;
  const indeks =
    raa === null ? null : typeof raa === 'string' && raa.trim() ? raa.trim() : 'docs/INDEKS.md';
  if (indeks) ut.unshift(new RegExp(`^${escRe(indeks)}$`));
  return ut;
}

/**
 * Mappene `plan sjekk` leter etter dokumenter i (relativt til hovedtreet): ko.config.json `dokumentMapper`
 * (liste med mapper), standard ['docs'].
 */
function dokumentMapper() {
  const m = konfig().dokumentMapper;
  return Array.isArray(m) && m.length ? m.filter((x) => typeof x === 'string' && x.trim()) : ['docs'];
}
/** Grensen for at to titler regnes som mulige duplikater (Jaccard på ordene, minst tre ord). */
const DUPLIKAT_LIKHET = 0.8;

const FERDIG_STATUS = /\bstatus\s*[:=]\s*\**\s*(ferdig|bygget|levert|implementert)\b/i;
const IKKE_STARTET_STATUS =
  /\bstatus\s*[:=]\s*\**\s*(ikke\s+startet|ikke\s+påbegynt|ikke\s+bygget|planlagt|utkast)\b/i;
const IKKE_STARTET_FRASE = /\bikke\s+(startet|påbegynt)\b/i;

/**
 * Kilderoller som ikke er planer for posten (historikk, referansedokumenter): de teller som registrert (uregistrert-
 * listen), men leses aldri for statusavviket, siden et ferdig eller gammelt dokument ikke sier noe om postens status.
 */
const KILDE_ROLLER_UTEN_STATUS = ['historikk', 'referanse'];
/** En seksjon med flere linjer enn dette regnes som et stort avsnitt: bare toppen leses for status. */
const STOR_SEKSJON_LINJER = 25;
/** Hvor mange linjer av toppen av et stort avsnitt som leses for status. */
const STOR_SEKSJON_TOPP = 12;

/**
 * Treffer overskriften ankeret? «§ 3.4» treffer både «§ 3.4» og «### 3.4 Modenhet …». Et nummer må stå alene:
 * «9.10» treffer ikke «9.108» (ellers leste sjekken et helt annet roadmap-avsnitt).
 */
function overskriftTreffer(linje, anker) {
  const t = linje.replace(/^#{1,6}\s+/, '').trim();
  const nr = anker.replace(/^§\s*/, '');
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Ankeret som eget «ord»: ikke fulgt av et siffer eller «.siffer», ikke innledet av et siffer eller en bokstav.
  const alene = (x) => new RegExp(`(^|[^0-9A-Za-zÆØÅæøå.])${esc(x)}(?![0-9]|\\.[0-9])`).test(t);
  return alene(anker) || t === nr || t.startsWith(`${nr} `) || t.startsWith(`${nr}. `);
}

/**
 * Linjene som hører til ankeret: seksjonen under en overskrift med ankeret (med underseksjonene), ellers linjene som
 * nevner det. Brukes også av visningen; statusavviket bruker `ankerSeksjon` (bare seksjonens egen tekst).
 */
function ankerTekst(tekst, anker) {
  const s = ankerSeksjon(tekst, anker, { underseksjoner: true });
  return s ? s.tekst : null;
}

/**
 * Seksjonen ankeret peker til: `{ tekst, overskrift }`, der `overskrift` er sann når ankeret traff en overskrift.
 * Uten `underseksjoner` stopper teksten ved første overskrift (også en dypere), så statusord i underavsnitt for andre
 * ting ikke leses som postens status. Treffer ingen overskrift, er det radene som nevner ankeret.
 */
function ankerSeksjon(tekst, anker, { underseksjoner = false } = {}) {
  const linjer = String(tekst ?? '').split(/\r?\n/);
  const a = tekst && anker ? String(anker).trim() : '';
  if (!a) return null;
  const erOverskrift = (l) => /^#{1,6}\s/.test(l);
  const i = linjer.findIndex((l) => erOverskrift(l) && overskriftTreffer(l, a));
  if (i >= 0) {
    const niva = /^(#+)/.exec(linjer[i])[1].length;
    const ut = [];
    for (let j = i + 1; j < linjer.length; j += 1) {
      const m = /^(#{1,6})\s/.exec(linjer[j]);
      if (m && (m[1].length <= niva || !underseksjoner)) break;
      ut.push(linjer[j]);
    }
    return { tekst: ut.join('\n'), overskrift: true };
  }
  const rader = linjer.filter((l) => l.includes(a));
  return rader.length ? { tekst: rader.join('\n'), overskrift: false } : null;
}

/**
 * Hva dokumentet sier om status, for statusavviket i `plan sjekk`: 'ferdig', 'ikke-startet' eller null (sier ingenting, eller
 * begge deler). Med anker leses bare seksjonens egen tekst (ikke underavsnittene), og i et stort avsnitt
 * (over STOR_SEKSJON_LINJER linjer, typisk roadmapen) bare toppen; uten anker de første 30 linjene (toppteksten),
 * siden en hel plan nesten alltid har både ferdige og åpne deler. ✅ og ⬜ teller bare som statusmerke først på en
 * linje, i et listepunkt eller i en tabellcelle, ikke inne i løpende tekst («✅»-metrikkene). Bevisst forsiktig: et
 * treff er et hint til eieren, aldri en endring.
 */
function dokStatus(tekst, anker = null) {
  if (typeof tekst !== 'string' || !tekst) return null;
  let del;
  if (anker) {
    const s = ankerSeksjon(tekst, anker);
    if (!s) return null;
    const linjer = s.tekst.split('\n');
    // Et stort avsnitt: bare toppen, der statuslinja står. Et «ferdig» langt nede gjelder som regel noe annet.
    del =
      s.overskrift && linjer.length > STOR_SEKSJON_LINJER
        ? linjer.slice(0, STOR_SEKSJON_TOPP).join('\n')
        : s.tekst;
  } else del = tekst.split(/\r?\n/).slice(0, 30).join('\n');
  if (!del) return null;
  const kryss = (del.match(/^\s*[-*]\s+\[[xX]\]/gm) ?? []).length;
  const tomme = (del.match(/^\s*[-*]\s+\[ \]/gm) ?? []).length;
  // Statusmerket først på linja, etter et listetegn eller først i en tabellcelle.
  const merke = (tegn) => new RegExp(`(^|\\|)\\s*(?:[-*]\\s+)?(?:\\*\\*)?${tegn}`, 'm').test(del);
  const hake = merke('✅');
  const boks = merke('⬜');
  const ferdig = FERDIG_STATUS.test(del) || (kryss > 0 && tomme === 0) || (hake && !boks);
  const ikke =
    IKKE_STARTET_STATUS.test(del) ||
    IKKE_STARTET_FRASE.test(del) ||
    (tomme > 0 && kryss === 0) ||
    (boks && !hake);
  if (ferdig === ikke) return null;
  return ferdig ? 'ferdig' : 'ikke-startet';
}

/** Ordene i en tittel (små bokstaver, uten tegnsetting, minst tre tegn). */
function titelOrd(t) {
  return new Set(
    String(t ?? '')
      .toLowerCase()
      .split(/[^a-z0-9æøå]+/)
      .filter((w) => w.length >= 3),
  );
}

/** Mulige duplikater: like titler (Jaccard ≥ DUPLIKAT_LIKHET på minst tre ord) eller samme kilde og anker. */
function duplikater(poster) {
  const ut = [];
  const liste = (poster ?? []).filter((p) => p.prioritet !== 'dropp');
  const ord = new Map(liste.map((p) => [p.id, titelOrd(p.tittel)]));
  for (let i = 0; i < liste.length; i += 1)
    for (let j = i + 1; j < liste.length; j += 1) {
      const a = liste[i];
      const b = liste[j];
      const oa = ord.get(a.id);
      const ob = ord.get(b.id);
      const felles = [...oa].filter((w) => ob.has(w)).length;
      const union = new Set([...oa, ...ob]).size;
      if (Math.min(oa.size, ob.size) >= 3 && union && felles / union >= DUPLIKAT_LIKHET) {
        ut.push({ ider: [a.id, b.id], grunn: 'nesten like titler' });
        continue;
      }
      const kildeA = new Set((a.kilder ?? []).map((k) => `${k.sti}#${k.anker ?? ''}`));
      const sammen = (b.kilder ?? []).find((k) => kildeA.has(`${k.sti}#${k.anker ?? ''}`));
      if (sammen)
        ut.push({
          ider: [a.id, b.id],
          grunn: `samme kilde ${sammen.sti}${sammen.anker ? ` ${sammen.anker}` : ''}`,
        });
    }
  return ut;
}

/**
 * Kapasiteten: hvor mange køspor Nå-postene trenger (ESTIMAT_SPOR, minus ferdige køoppgaver, minst de åpne),
 * mot hvor mange køoppgaver som blir ferdige per uke. Bygde og verifiserte poster teller ikke.
 * @returns {{ poster: number, spor: number, uten_estimat: string[], per_uke: number|null, uker: number|null,
 *   tekst: string }}
 */
function kapasitet(reg, ko, { ferdigePerUke = null, naa = new Date() } = {}) {
  let spor = 0;
  let poster = 0;
  const utenEstimat = [];
  for (const p of reg.poster ?? []) {
    if (p.prioritet !== 'naa') continue;
    const av = avledetModenhet(p, ko?.oppgaver, { naa });
    if (av.modenhet === 'bygget' || av.modenhet === 'verifisert') continue;
    poster += 1;
    const est = ESTIMAT_SPOR[p.estimat];
    if (est == null) {
      utenEstimat.push(p.id);
      continue;
    }
    spor += Math.max(est - av.ferdige, av.totalt - av.ferdige);
  }
  const perUke = Number.isFinite(ferdigePerUke) && ferdigePerUke > 0 ? ferdigePerUke : null;
  const uker = perUke ? Math.round((spor / perUke) * 10) / 10 : null;
  const tekst = !poster
    ? 'Ingen åpne poster i Nå.'
    : perUke
      ? `Nå er ca. ${String(uker).replace('.', ',')} uker med dagens tempo (${spor} spor i ${poster} poster, ` +
        `${String(Math.round(perUke * 10) / 10).replace('.', ',')} ferdige køoppgaver per uke)` +
        `${utenEstimat.length ? `; ${utenEstimat.length} uten estimat er ikke regnet med` : ''}.`
      : `Nå er ${spor} spor i ${poster} poster; tempoet er ukjent (ingen ferdige køoppgaver de siste ${KAPASITET_VINDU_DAGER} dagene).`;
  return { poster, spor, uten_estimat: utenEstimat, per_uke: perUke, uker, tekst };
}

/** Er stien et dokument som ingen post trenger å peke til? */
const erUnntatt = (sti) => uregistrertUnntak().some((re) => re.test(sti));

/**
 * Hygienen i `plan sjekk`, uten å endre noe. Det som trenger filsystemet eller git, sendes inn:
 * @param {{ dokumenter?: string[], finnesSti?: (sti: string) => boolean, lesDok?: (sti: string) => string|null,
 *   endredeFiler?: (filer: string[], fra: { dato: string, commit?: string|null }) => string[],
 *   ferdigePerUke?: number|null, prosjektFor?: (oppgave: object) => string|null, naa?: Date }} ctx
 *   dokumenter: .md-filene i dokumentMapper() (relative stier); lesDok: teksten i en kilde; endredeFiler: filene (av
 *   de oppgitte) som er endret etter verifiseringen; prosjektFor: prosjektet en oppgave hører til (koLogikk, med
 *   prefiksene), ellers feltet `prosjekt`.
 * @returns {{ uregistrert: string[], dode_stier: object[], foreldet: object[], ikke_verifisert: string[],
 *   statusavvik: object[], regelavvik: object[], hull: object[], duplikater: object[], kapasitet: object,
 *   referanser: { id: string, sti: string, rolle: string }[], antall: number }}
 */
function sjekk(reg, ko, ctx = {}) {
  const naa = ctx.naa ?? new Date();
  const poster = reg.poster ?? [];
  const prosjekter = ko?.prosjekter ?? {};
  const oppgaver = ko?.oppgaver ?? [];
  const avklart = new Set(ko?.avklart ?? []);

  // Uregistrert: dokumenter som ingen post (heller ikke en arkivert) peker til.
  const pekt = new Set();
  for (const p of [...poster, ...Object.values(reg.arkiv ?? {})])
    for (const k of p.kilder ?? []) if (k?.sti) pekt.add(k.sti);
  const uregistrert = (ctx.dokumenter ?? []).filter((s) => !pekt.has(s) && !erUnntatt(s)).sort();

  const dodeStier = [];
  const foreldet = [];
  const ikkeVerifisert = [];
  const statusavvik = [];
  const regelavvik = [];
  const hull = [];
  const referanser = [];
  for (const p of poster) {
    // Døde stier: kilder som er flyttet eller slettet.
    if (ctx.finnesSti)
      for (const k of p.kilder ?? [])
        if (!kildestiFeil(k.sti) && !ctx.finnesSti(k.sti)) dodeStier.push({ id: p.id, sti: k.sti });

    const av = avledetModenhet(p, oppgaver, { naa });
    const ferdigeOppg = koOppgaverFor(p, oppgaver).filter((o) => o.status === 'ferdig');

    // Foreldet: verifiseringen er over FORELDET_DAGER dager gammel, eller filene til ferdige køoppgaver er endret siden.
    if (p.verifisert?.dato) {
      if (erForeldet(p, { naa }))
        foreldet.push({
          id: p.id,
          grunn: `verifisert ${p.verifisert.dato}, over ${FORELDET_DAGER} dager siden`,
        });
      else if (ctx.endredeFiler) {
        const filer = [...new Set(ferdigeOppg.flatMap((o) => o.eier_filer ?? []))].sort();
        const endret = filer.length
          ? ctx.endredeFiler(filer, {
              dato: p.verifisert.dato,
              commit: p.verifisert.commit ?? null,
            })
          : [];
        if (endret.length)
          foreldet.push({
            id: p.id,
            grunn: `${endret.length} fil(er) endret etter verifiseringen ${p.verifisert.dato}: ${endret.slice(0, 3).join(', ')}${endret.length > 3 ? ', …' : ''}`,
            filer: endret,
          });
      }
    } else if (av.modenhet === 'bygget') ikkeVerifisert.push(p.id);

    // Referansedokumenter og historikk: registrert, men aldri lest for status (egen markering i utdataene).
    for (const k of p.kilder ?? [])
      if (KILDE_ROLLER_UTEN_STATUS.includes(k?.rolle))
        referanser.push({ id: p.id, sti: k.sti, rolle: k.rolle });

    // Statusavvik: køen og dokumentet sier ulikt. Droppede poster hoppes over (de skal ikke bygges, så et «ikke
    // startet» eller «ferdig» i dokumentet er ingen motsigelse), og det samme gjør referanse- og historikkildene.
    if (ctx.lesDok && p.prioritet !== 'dropp') {
      const mod = av.modenhet;
      const koFerdig = mod === 'bygget' || mod === 'verifisert';
      const ingenKo = av.totalt === 0;
      for (const k of p.kilder ?? []) {
        if (KILDE_ROLLER_UTEN_STATUS.includes(k.rolle)) continue;
        if (kildestiFeil(k.sti) || (ctx.finnesSti && !ctx.finnesSti(k.sti))) continue;
        const st = dokStatus(ctx.lesDok(k.sti), k.anker ?? null);
        const hvor = `${k.sti}${k.anker ? ` ${k.anker}` : ''}`;
        if (koFerdig && st === 'ikke-startet')
          statusavvik.push({
            id: p.id,
            grunn: `køen sier ${mod} (${av.ferdige}/${av.totalt}), men ${hvor} sier ikke startet`,
          });
        else if (ingenKo && st === 'ferdig')
          statusavvik.push({
            id: p.id,
            grunn: `ingen køoppgaver (${p.modenhet}), men ${hvor} sier ferdig`,
          });
      }
    }

    // Regelavvik: de målbare reglene peker på en annen prioritet enn den som står.
    if (p.prioritet !== 'dropp') {
      const m = maaltRegel(p, poster, { naa });
      if (m && m.prioritet !== p.prioritet)
        regelavvik.push({
          id: p.id,
          regel: m.nr,
          grunn: `regel ${m.nr} (${m.navn}) gir ${m.prioritet}${m.kategori ? `/${m.kategori}` : ''}: ${m.grunn}; står ${p.prioritet}${p.prioritet_satt_av === 'eier' ? ' (satt av eieren, endres ikke av en agent)' : ''}`,
        });
    }
    for (const t of regelMotPrioritet(p).feil) regelavvik.push({ id: p.id, grunn: t });

    // Hull: dropp uten grunn, naa uten kategori, eier uten eierspørsmål, og poster uten modul.
    if (p.prioritet === 'dropp' && !tekst(p.dropp_grunn))
      hull.push({ id: p.id, grunn: 'dropp uten grunn' });
    if (p.prioritet === 'naa' && !(p.naa_kategori ?? []).length)
      hull.push({ id: p.id, grunn: 'naa uten kategori' });
    if (p.prioritet === 'eier') {
      const spm = p.eierspm ?? [];
      if (!spm.length) hull.push({ id: p.id, grunn: 'eier uten et koblet eierspørsmål' });
      else if (spm.every((s) => avklart.has(s)))
        hull.push({
          id: p.id,
          grunn: `alle eierspørsmålene er avklart (${spm.join(', ')}); sett ny prioritet`,
        });
    }
    if (p.prosjekt && Object.hasOwn(prosjekter, p.prosjekt) && !prosjekter[p.prosjekt]?.omrade)
      hull.push({ id: p.id, grunn: `prosjektet ${p.prosjekt} har ingen modul` });
    else if (p.prosjekt && !Object.hasOwn(prosjekter, p.prosjekt))
      hull.push({ id: p.id, grunn: `ukjent prosjekt ${p.prosjekt}` });
  }

  // Statusavvik i køen: oppgaver som peker til en planpost som ikke finnes, og prosjekter i fase plan med køoppgaver.
  const kjente = new Set([...poster.map((p) => p.id), ...Object.keys(reg.arkiv ?? {})]);
  for (const o of oppgaver)
    if (o?.plan && o.status !== 'kansellert' && !kjente.has(o.plan))
      statusavvik.push({ oppgave: o.id, grunn: `${o.id} peker til ukjent planpost ${o.plan}` });
  for (const [pid, pr] of Object.entries(prosjekter)) {
    if (pr?.fase !== 'plan') continue;
    const n = oppgaver.filter(
      (o) => o && o.status !== 'kansellert' && (ctx.prosjektFor?.(o) ?? o.prosjekt) === pid,
    ).length;
    if (n)
      statusavvik.push({
        prosjekt: pid,
        grunn: `prosjektet ${pid} har fase plan, men ${n} køoppgave(r) (ko.mjs prosjekt ${pid} --fase ingen)`,
      });
  }

  const dup = duplikater(poster);
  const kap = kapasitet(reg, ko, { ferdigePerUke: ctx.ferdigePerUke ?? null, naa });
  const ut = {
    uregistrert,
    dode_stier: dodeStier,
    foreldet,
    ikke_verifisert: ikkeVerifisert,
    statusavvik,
    regelavvik,
    hull,
    duplikater: dup,
    kapasitet: kap,
    // Ikke funn: kildene med rolle historikk eller referanse, som ikke leses for status (telles ikke i antall).
    referanser,
  };
  // konsistenssjekkene for dokumentregisteret, bare når registeret har dokumenter.
  const dk = dokKonsistens(reg, ko, { ...ctx, naa });
  if (dk.kjorte.length) ut.dok_konsistens = dk.funn;
  ut.antall =
    uregistrert.length +
    dodeStier.length +
    foreldet.length +
    ikkeVerifisert.length +
    statusavvik.length +
    regelavvik.length +
    hull.length +
    dup.length +
    dk.funn.length;
  return ut;
}

// ---- «Arbeider nå» -------------------------------------------------------------------------
//
// Når en `/planer`-økt jobber med en post, skriver skillen en markør med `ko.mjs plan aktiv <id>`; `--slutt` tar den
// bort. Markørene ligger på registernivå, ikke i planposten, så de aldri blander seg med postfeltene (FELT), planDiff
// eller endringsloggen (hyppig puls, ingenting å angre):
//   aktiv_okt: [{ post: 'PL-EKSPORT-1', at: '<iso>', av: 'økt-navn' }]   (høyst én markør per post; siste puls vinner)
// Leseren (tavla) trenger bare aktivePoster(reg): { <post-id>: { at, av } } for markørene som lever. En
// markør dør av seg selv AKTIV_OKT_TIMER timer etter siste puls; døde markører ryddes bort ved neste skriving.

/** Så mange timer lever en markør uten ny puls (markøren forsvinner av seg selv). */
const AKTIV_OKT_TIMER = 2;
/** Klokkeslingring: en markør inntil så mange minutter fram i tid regnes som gyldig (ulike maskiner, ulike klokker). */
const AKTIV_OKT_SLINGRING_MIN = 5;

/**
 * Lever markøren? Sann når `at` er et gyldig tidspunkt under AKTIV_OKT_TIMER timer før `naa` (og høyst
 * AKTIV_OKT_SLINGRING_MIN minutter etter).
 * @param {{ at?: string }|null|undefined} markor
 * @param {{ naa?: Date|string }} [o]
 */
function erAktivOkt(markor, { naa = new Date() } = {}) {
  if (!erObjekt(markor) || typeof markor.at !== 'string') return false;
  const t = Date.parse(markor.at);
  const n = new Date(naa).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(n)) return false;
  const diff = n - t;
  return diff < AKTIV_OKT_TIMER * 3600000 && diff >= -AKTIV_OKT_SLINGRING_MIN * 60000;
}

/** Markørene som er velformede (objekt med post-id som tekst); resten ignoreres. */
function aktivOktListe(reg) {
  const l = Array.isArray(reg?.aktiv_okt) ? reg.aktiv_okt : [];
  return l.filter((m) => erObjekt(m) && typeof m.post === 'string' && m.post);
}

/**
 * Postene som er under arbeid nå: `{ <post-id>: { at, av } }`, bare levende markører på poster som finnes (en post
 * som er slått sammen inn i arkivet, får ingen puls). Har en post flere markører, vinner den nyeste.
 * @param {object} reg planregisteret
 * @param {{ naa?: Date|string }} [o]
 * @returns {Record<string, { at: string, av: string }>}
 */
function aktivePoster(reg, { naa = new Date() } = {}) {
  const finnes = new Set((reg?.poster ?? []).map((p) => p.id));
  const ut = {};
  for (const m of aktivOktListe(reg)) {
    if (!finnes.has(m.post) || !erAktivOkt(m, { naa })) continue;
    const forrige = ut[m.post];
    if (!forrige || Date.parse(m.at) > Date.parse(forrige.at))
      ut[m.post] = { at: m.at, av: tekst(m.av) || 'ukjent' };
  }
  return ut;
}

/**
 * Setter (puls) eller fjerner (`slutt`) markøren for en post. Endrer `reg.aktiv_okt` på stedet og rydder bort døde og
 * ugyldige markører. Røres ikke: postene, arkivet og endringsloggen.
 * @param {object} reg
 * @param {string} postId
 * @param {{ av?: string|null, naa?: Date|string, slutt?: boolean }} [o]
 * @returns {{ feil: string[], endret: boolean, markor: { post: string, at: string, av: string }|null }}
 */
function settAktivOkt(reg, postId, { av = null, naa = new Date(), slutt = false } = {}) {
  const id = tekst(postId);
  if (!id)
    return {
      feil: ['mangler post-id (plan aktiv <PL-id> [--slutt])'],
      endret: false,
      markor: null,
    };
  if (!slutt && !finnPost(reg, id)) {
    const arkiv = reg?.arkiv?.[id];
    return {
      feil: [
        arkiv
          ? `${id} er slått sammen inn i ${arkiv.sammenslatt_til ?? 'en annen post'}; marker den i stedet`
          : `${id} finnes ikke i planregisteret`,
      ],
      endret: false,
      markor: null,
    };
  }
  const iso = new Date(naa).toISOString();
  const for_ = JSON.stringify(reg.aktiv_okt ?? null);
  // Behold bare levende markører for andre poster; markøren for denne posten byttes ut eller fjernes.
  const beholdt = aktivOktListe(reg).filter((m) => m.post !== id && erAktivOkt(m, { naa: iso }));
  const markor = slutt ? null : { post: id, at: iso, av: tekst(av) || 'ukjent' };
  reg.aktiv_okt = markor ? [...beholdt, markor] : beholdt;
  return { feil: [], endret: JSON.stringify(reg.aktiv_okt) !== for_, markor };
}

// ---- Dokumenter og avtaler ----------------------------------------------------------------------
//
// Et eget lite register i planer.json (`dokumenter`): ett objekt per juridisk eller styrende dokument, med status,
// versjon, hvor det er publisert, problemer, prioritet og revisjon. Registeret lagrer bare metadata; selve teksten
// blir liggende der den er (i repoet, på nettsiden eller i en adminflate). Skrivingen går som for planpostene
// (`ko.mjs plan dok …` under samme lås, --forvent-endret, endringslogg og angre; samlingen heter `dokumenter` i
// endringsloggen). Konsistenssjekkene mot leverandører, revisjoner og nettadresser står i blokka
// lenger ned.

/** Gruppene i fanen, i visningsrekkefølge. */
const DOK_GRUPPER = [
  { id: 'kundeavtaler', tittel: 'Kundeavtaler' },
  { id: 'personvern', tittel: 'Personvern' },
  { id: 'offentlig', tittel: 'Offentlig på nettsiden' },
  { id: 'styring', tittel: 'Styringsdokumenter' },
  { id: 'leverandorer', tittel: 'Innkjøp og leverandører' },
  { id: 'kontrakt', tittel: 'Kontraktsarbeid' },
];
/** Hvem dokumentet er skrevet for. */
const DOK_MALGRUPPER = ['kunde', 'offentlig', 'intern', 'leverandor'];
/** Livsløpet til et dokument, i rekkefølge. */
const DOK_STATUSER = [
  'mangler',
  'utkast',
  'ki-vurdert',
  'til-jurist',
  'godkjent',
  'publisert',
  'utdatert',
];
/** Hvor et dokument kan være publisert. `signert` = signert per kunde eller leverandør (f.eks. en avtale som signeres per kunde). */
const DOK_PUBLISERT_HVOR = ['nettside', 'admin', 'app', 'signert', 'annet'];
/** Alvoret til et problem (høy øverst). */
const DOK_ALVOR = ['hoy', 'middels', 'lav'];
/** Dokument-id: DOK-, så store bokstaver, tall og bindestreker (f.eks. DOK-VILKAR, DOK-RUTINE-2). */
const DOK_ID_MONSTER = /^DOK-[A-Z0-9ÆØÅ](?:[A-Za-z0-9ÆØÅæøå-]*[A-Za-z0-9ÆØÅæøå])?$/;
/** Revisjoner som forfaller innen så mange dager, står på tidslinjen og i «Hva må gjøres» som snart forfalt. */
const DOK_REVISJON_SNART_DAGER = 30;

/** Feltene et dokument kan ha. Alt annet avvises. */
const DOK_FELT = [
  'id',
  'tittel',
  'gruppe',
  'malgruppe',
  'kilde',
  'publisert',
  'versjon',
  'gjeldende_versjon',
  'status',
  'sist_revidert',
  'revisjon_hver',
  'revisjoner',
  'avhenger_av',
  'problemer',
  'prioritet',
  'naa_kategori',
  'prioritet_grunn',
  'prioritet_satt_av',
  'dropp_grunn',
  'juridisk_punkter',
  'planposter',
  'eierspm',
  'frist',
  'merknad',
  // modulene dokumentet dekker (oid-ene i konfigurasjonens `moduler`).
  'moduler',
  // Satt av verktøyet:
  'opprettet',
  'agent_loft',
];
const DOK_VERKTOY_FELT = new Set(['id', 'opprettet', 'agent_loft']);

/** Dokumentet med id-en, eller null. */
function finnDok(reg, id) {
  return (reg?.dokumenter ?? []).find((d) => d.id === id) ?? null;
}

/**
 * Tolker `revisjon_hver`: «12 mnd», «6 måneder», «1 år», «4 uker», «90 dager» gir et intervall; «ved …» (f.eks. «ved
 * endring av underleverandør») er en hendelse uten dato. Annet gir null.
 * @returns {{ mnd?: number, dager?: number, hendelse?: string }|null}
 */
function revisjonsIntervall(s) {
  const t = tekst(s).toLowerCase();
  if (!t) return null;
  if (/^ved\s+\S/.test(t)) return { hendelse: tekst(s) };
  const m = /^(\d{1,3})\s*(mnd|md|måned|måneder|år|uke|uker|dag|dager)$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (!n) return null;
  if (['mnd', 'md', 'måned', 'måneder'].includes(m[2])) return { mnd: n };
  if (m[2] === 'år') return { mnd: n * 12 };
  if (m[2] === 'uke' || m[2] === 'uker') return { dager: n * 7 };
  return { dager: n };
}

/** Datoen `n` måneder etter `dato` (YYYY-MM-DD); dagen kuttes til månedens siste (31. jan + 1 mnd = 28./29. feb). */
function leggTilMnd(dato, n) {
  const [aa, mm, dd] = dato.split('-').map(Number);
  const tot = aa * 12 + (mm - 1) + n;
  const na = Math.floor(tot / 12);
  const nm = (tot % 12) + 1;
  const sisteDag = new Date(Date.UTC(na, nm, 0)).getUTCDate();
  return `${na}-${String(nm).padStart(2, '0')}-${String(Math.min(dd, sisteDag)).padStart(2, '0')}`;
}

/** Datoen `n` dager etter `dato` (YYYY-MM-DD). */
function leggTilDager(dato, n) {
  return new Date(Date.parse(`${dato}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Neste revisjon for et dokument: sist_revidert + revisjon_hver. En hendelse («ved endring av …») har ingen dato.
 * Et dokument som mangler eller er utdatert, har ingen planlagt revisjon (det må skrives eller erstattes først).
 * @returns {{ dato: string, dager: number, forfalt: boolean, snart: boolean }|{ hendelse: string }|null}
 */
function nesteRevisjon(dok, { naa = new Date() } = {}) {
  if (!dok || dok.status === 'mangler' || dok.status === 'utdatert') return null;
  const iv = revisjonsIntervall(dok.revisjon_hver);
  if (!iv) return null;
  if (iv.hendelse) return { hendelse: iv.hendelse };
  if (!gyldigDato(dok.sist_revidert)) return null;
  const dato = iv.mnd
    ? leggTilMnd(dok.sist_revidert, iv.mnd)
    : leggTilDager(dok.sist_revidert, iv.dager);
  const dager = dagerMellom(osloDato(naa), dato);
  return {
    dato,
    dager,
    forfalt: dager < 0,
    snart: dager >= 0 && dager <= DOK_REVISJON_SNART_DAGER,
  };
}

/** Versjonsnummeret uten mellomrom (null når det mangler). */
const ver = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Versjonsglipp: det som er publisert, er ulikt det som gjelder, to publiseringssteder er ulike, eller kunder
 * har akseptert en eldre versjon enn den som er godkjent (varslingsplikt ved endring av avtaler eller vilkår).
 * `gjeldende_versjon` er versjonen kundene faktisk har akseptert; `versjon` er arbeidsversjonen, som er godkjent når
 * status er godkjent eller publisert.
 * @returns {{ type: 'publisert-ulik'|'steder-ulike'|'akseptert-eldre'|'ikke-utrullet', tekst: string }[]}
 */
function versjonsglipp(dok) {
  const ut = [];
  if (!dok || dok.status === 'mangler') return ut;
  const gjeldende = ver(dok.gjeldende_versjon);
  const pub = (Array.isArray(dok.publisert) ? dok.publisert : []).filter(
    (p) => erObjekt(p) && ver(p.versjon),
  );
  if (gjeldende)
    for (const p of pub)
      if (ver(p.versjon) !== gjeldende)
        ut.push({
          type: 'publisert-ulik',
          tekst: `${p.hvor ?? 'publisert'} viser ${ver(p.versjon)}, men gjeldende versjon er ${gjeldende}`,
        });
  const ulike = [...new Set(pub.map((p) => ver(p.versjon)))];
  if (ulike.length > 1)
    ut.push({
      type: 'steder-ulike',
      tekst: `publiseringsstedene er ulike: ${pub.map((p) => `${p.hvor ?? '?'} ${ver(p.versjon)}`).join(', ')}`,
    });
  const arbeid = ver(dok.versjon);
  if (
    (dok.status === 'godkjent' || dok.status === 'publisert') &&
    arbeid &&
    gjeldende &&
    arbeid !== gjeldende
  )
    ut.push(
      dok.malgruppe === 'kunde'
        ? {
            type: 'akseptert-eldre',
            tekst: `kundene har akseptert ${gjeldende}, men ${arbeid} er godkjent: varsle kundene før endringen gjelder`,
          }
        : {
            type: 'ikke-utrullet',
            tekst: `${arbeid} er godkjent, men ${gjeldende} gjelder fortsatt`,
          },
    );
  return ut;
}

/**
 * Det som må gjøres med ett dokument («Hva må gjøres»): mangler, forfalt revisjon, problemer med høy alvor,
 * versjonsglipp og alt merket for-prod. Tom liste = ingenting haster.
 * @returns {{ type: string, tekst: string }[]}
 */
function dokGrunner(dok, { naa = new Date() } = {}) {
  const ut = [];
  if (!dok || dok.status === 'utdatert') return ut;
  if (dok.status === 'mangler') ut.push({ type: 'mangler', tekst: 'Dokumentet mangler' });
  const nr = nesteRevisjon(dok, { naa });
  if (nr?.forfalt)
    ut.push({ type: 'forfalt', tekst: `Revisjonen forfalt ${nr.dato} (${-nr.dager} dager siden)` });
  const hoy = (dok.problemer ?? []).filter((p) => p?.alvor === 'hoy');
  if (hoy.length)
    ut.push({
      type: 'problem-hoy',
      tekst: `${hoy.length} ${hoy.length === 1 ? 'problem' : 'problemer'} med høy alvor`,
    });
  const glipp = versjonsglipp(dok);
  if (glipp.length) ut.push({ type: 'glipp', tekst: `Versjonsglipp: ${glipp[0].tekst}` });
  if (dok.prioritet === 'naa' && (dok.naa_kategori ?? []).includes('for-prod'))
    ut.push({ type: 'for-prod', tekst: 'Merket Nå, før prod' });
  if (gyldigDato(dok.frist) && dagerMellom(osloDato(naa), dok.frist) < 0)
    ut.push({ type: 'frist', tekst: `Fristen ${dok.frist} er passert` });
  return ut;
}

/** Rekkefølgen i «Hva må gjøres»: det alvorligste først. */
const DOK_GRUNN_VEKT = {
  mangler: 0,
  'problem-hoy': 1,
  frist: 2,
  forfalt: 3,
  glipp: 4,
  'for-prod': 5,
};

/**
 * «Hva må gjøres», øverst i fanen og i lanseringsoversikten: dokumentene med minst én grunn, det alvorligste
 * først (så for-prod, så id). Utdaterte og droppede dokumenter tas ikke med.
 * @returns {{ id: string, tittel: string, gruppe: string, grunner: { type: string, tekst: string }[] }[]}
 */
function dokMaaGjores(dokumenter, { naa = new Date() } = {}) {
  return (dokumenter ?? [])
    .filter((d) => d?.prioritet !== 'dropp')
    .map((d) => ({
      id: d.id,
      tittel: d.tittel ?? d.id,
      gruppe: d.gruppe ?? null,
      grunner: dokGrunner(d, { naa }),
    }))
    .filter((x) => x.grunner.length)
    .sort((a, b) => {
      const va = Math.min(...a.grunner.map((g) => DOK_GRUNN_VEKT[g.type] ?? 9));
      const vb = Math.min(...b.grunner.map((g) => DOK_GRUNN_VEKT[g.type] ?? 9));
      return va - vb || a.id.localeCompare(b.id, 'nb');
    });
}

/**
 * Tidslinjen for revisjoner og frister: forfalte og de som forfaller innen `dager` dager, sortert på dato.
 * Revisjoner «ved hendelse» har ingen dato og står ikke her (de vises i panelet).
 * @returns {{ id: string, tittel: string, type: 'revisjon'|'frist', dato: string, dager: number, forfalt: boolean }[]}
 */
function revisjonsTidslinje(dokumenter, { naa = new Date(), dager = 365 } = {}) {
  const ut = [];
  const idag = osloDato(naa);
  for (const d of dokumenter ?? []) {
    if (!d || d.prioritet === 'dropp') continue;
    const nr = nesteRevisjon(d, { naa });
    if (nr?.dato && nr.dager <= dager)
      ut.push({
        id: d.id,
        tittel: d.tittel ?? d.id,
        type: 'revisjon',
        dato: nr.dato,
        dager: nr.dager,
        forfalt: nr.forfalt,
      });
    if (gyldigDato(d.frist) && d.status !== 'utdatert') {
      const n = dagerMellom(idag, d.frist);
      if (n <= dager)
        ut.push({
          id: d.id,
          tittel: d.tittel ?? d.id,
          type: 'frist',
          dato: d.frist,
          dager: n,
          forfalt: n < 0,
        });
    }
  }
  return ut.sort((a, b) => a.dato.localeCompare(b.dato) || a.id.localeCompare(b.id, 'nb'));
}

/** Kopier-linja for en rad: `/planer dok DOK-VILKAR. Instruks:` (bare id-en, aldri innhold). */
function dokKopierLinje(dok) {
  return `/planer dok ${dok.id}. Instruks:`;
}

/**
 * Validerer et helt dokument slik det blir lagret.
 * @param {object} dok
 * @param {{ dokumenter?: object[], poster?: object[], arkiv?: object, sporsmal?: object,
 *   finnesSti?: (sti: string) => boolean }} ctx dokumenter: de andre dokumentene (for avhenger_av); poster og arkiv:
 *   planpostene (for planposter); sporsmal: køens eierspørsmål; finnesSti: sjekker at kilden finnes.
 * @returns {{ feil: string[], advarsler: string[] }}
 */
function validerDok(dok, ctx = {}) {
  const feil = [];
  const advarsler = [];
  if (!erObjekt(dok)) return { feil: ['dokumentet må være et objekt'], advarsler };
  const hvem = typeof dok.id === 'string' ? dok.id : '(uten id)';
  const f = (t) => feil.push(`${hvem}: ${t}`);
  const adv = (t) => advarsler.push(`${hvem}: ${t}`);

  for (const k of Object.keys(dok))
    if (!DOK_FELT.includes(k)) f(`ukjent felt ${k} (lov: ${DOK_FELT.join(', ')})`);
  if (typeof dok.id !== 'string' || !DOK_ID_MONSTER.test(dok.id))
    f('id må se ut som DOK-NAVN (DOK-, store bokstaver, tall og bindestrek)');
  if (!tekst(dok.tittel)) f('tittel mangler');
  else if (dok.tittel.length > 160) f('tittel er over 160 tegn');
  if (!DOK_GRUPPER.some((g) => g.id === dok.gruppe))
    f(`gruppe må være en av ${DOK_GRUPPER.map((g) => g.id).join(', ')}`);
  if (!DOK_MALGRUPPER.includes(dok.malgruppe))
    f(`malgruppe må være en av ${DOK_MALGRUPPER.join(', ')}`);
  if (!DOK_STATUSER.includes(dok.status)) f(`status må være en av ${DOK_STATUSER.join(', ')}`);
  for (const k of ['merknad', 'versjon', 'gjeldende_versjon', 'revisjon_hver'])
    if (dok[k] != null && typeof dok[k] !== 'string') f(`${k} må være tekst`);

  // Kilden: arbeidsfila (relativ sti fra prosjektrota). Et dokument som mangler, trenger ingen.
  if (dok.kilde != null) {
    const sf = kildestiFeil(dok.kilde);
    if (sf) f(`kilde ${sf}`);
    else if (ctx.finnesSti && !ctx.finnesSti(dok.kilde)) f(`kilde ${dok.kilde} finnes ikke`);
  } else if (dok.status && !['mangler', 'utdatert'].includes(dok.status))
    adv('ingen kilde (arbeidsfila); fanen kan ikke vise hvor dokumentet ligger');

  // Publisert: [{ hvor, url?, sti?, versjon? }]. Nettadresser må være https (nettsjekken henter dem).
  if (dok.publisert != null && !Array.isArray(dok.publisert)) f('publisert må være en liste');
  for (const p of Array.isArray(dok.publisert) ? dok.publisert : []) {
    if (!erObjekt(p)) {
      f('hver publisering må være { hvor, url?, sti?, versjon? }');
      continue;
    }
    for (const n of Object.keys(p))
      if (!['hvor', 'url', 'sti', 'versjon'].includes(n)) f(`publisert: ukjent felt ${n}`);
    if (!DOK_PUBLISERT_HVOR.includes(p.hvor))
      f(`publisert.hvor må være en av ${DOK_PUBLISERT_HVOR.join(', ')}`);
    if (p.url != null && (typeof p.url !== 'string' || !/^https:\/\/[^\s]+$/.test(p.url)))
      f(`publisert.url må være en https-adresse (${p.hvor ?? '?'})`);
    for (const n of ['sti', 'versjon'])
      if (p[n] != null && typeof p[n] !== 'string') f(`publisert.${n} må være tekst`);
  }
  if (dok.status === 'publisert' && !(dok.publisert ?? []).length)
    adv('status publisert, men publisert er tom (hvor ligger det?)');

  // Revisjon: sist_revidert + revisjon_hver gir neste revisjon. revisjoner er historikken (eldste først).
  if (dok.sist_revidert != null && !gyldigDato(dok.sist_revidert))
    f('sist_revidert må være en dato (YYYY-MM-DD)');
  if (dok.revisjon_hver != null && !revisjonsIntervall(dok.revisjon_hver))
    f('revisjon_hver må være f.eks. «12 mnd», «1 år», «90 dager» eller «ved endring av …»');
  if (dok.revisjoner != null && !Array.isArray(dok.revisjoner)) f('revisjoner må være en liste');
  for (const r of Array.isArray(dok.revisjoner) ? dok.revisjoner : []) {
    if (!erObjekt(r) || !gyldigDato(r.dato)) {
      f('hver revisjon må være { dato: YYYY-MM-DD, versjon?, merknad?, av? }');
      continue;
    }
    for (const n of Object.keys(r))
      if (!['dato', 'versjon', 'merknad', 'av'].includes(n)) f(`revisjoner: ukjent felt ${n}`);
  }

  // Problemer: [{ tekst, alvor, kilde? }].
  if (dok.problemer != null && !Array.isArray(dok.problemer)) f('problemer må være en liste');
  for (const p of Array.isArray(dok.problemer) ? dok.problemer : []) {
    if (!erObjekt(p) || !tekst(p.tekst)) {
      f('hvert problem må være { tekst, alvor, kilde? }');
      continue;
    }
    for (const n of Object.keys(p))
      if (!['tekst', 'alvor', 'kilde'].includes(n)) f(`problemer: ukjent felt ${n}`);
    if (!DOK_ALVOR.includes(p.alvor)) f(`problemer.alvor må være en av ${DOK_ALVOR.join(', ')}`);
  }

  // Prioritet er valgfri for et dokument; er den satt, gjelder de samme reglene som for planpostene.
  if (dok.prioritet != null) {
    if (!PRIORITETER.includes(dok.prioritet))
      f(`prioritet må være en av ${PRIORITETER.join(', ')}`);
    if (!SATT_AV.includes(dok.prioritet_satt_av))
      f(`prioritet_satt_av må være ${SATT_AV.join(' eller ')}`);
    if (dok.prioritet_satt_av === 'agent' && !tekst(dok.prioritet_grunn))
      f('en agent må gi prioritet_grunn (én setning: hvilken prioritetsregel og hvorfor)');
    if (dok.prioritet === 'naa' && !(dok.naa_kategori ?? []).length)
      adv('naa uten kategori (sikkerhet, for-prod eller viktig)');
    if (dok.prioritet === 'dropp' && !tekst(dok.dropp_grunn))
      f('dropp krever én setning som grunn (dropp_grunn)');
    const rs = regelMotPrioritet(dok);
    feil.push(...rs.feil.map((t) => `${hvem}: ${t}`));
    advarsler.push(...rs.advarsler.map((t) => `${hvem}: ${t}`));
  } else
    for (const k of ['naa_kategori', 'prioritet_grunn', 'prioritet_satt_av', 'dropp_grunn'])
      if (dok[k] != null) f(`${k} brukes bare når prioritet er satt`);
  if (dok.naa_kategori != null) {
    if (!Array.isArray(dok.naa_kategori)) f('naa_kategori må være en liste');
    else {
      for (const k of dok.naa_kategori)
        if (!NAA_KATEGORIER.includes(k))
          f(`ukjent naa_kategori ${k} (lov: ${NAA_KATEGORIER.join(', ')})`);
      if (dok.naa_kategori.length && dok.prioritet !== 'naa')
        f('naa_kategori brukes bare når prioritet er naa');
    }
  }
  if (dok.prioritet !== 'dropp' && dok.prioritet != null && dok.dropp_grunn != null)
    f('dropp_grunn brukes bare når prioritet er dropp');

  // Koblingene: lister med tekst. avhenger_av må være andre dokumenter, planposter må finnes i registeret.
  for (const felt of ['avhenger_av', 'juridisk_punkter', 'planposter', 'eierspm']) {
    const v = dok[felt];
    if (v == null) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim()))
      f(`${felt} må være en liste med tekst`);
  }
  const andreDok = new Set((ctx.dokumenter ?? []).map((d) => d.id));
  for (const d of Array.isArray(dok.avhenger_av) ? dok.avhenger_av : []) {
    if (d === dok.id) f('avhenger av seg selv');
    else if (ctx.dokumenter && !andreDok.has(d)) f(`avhenger av ukjent dokument ${d}`);
  }
  if (ctx.poster)
    for (const pid of Array.isArray(dok.planposter) ? dok.planposter : []) {
      if ((ctx.poster ?? []).some((p) => p.id === pid)) continue;
      if (ctx.arkiv?.[pid])
        adv(`planposten ${pid} er slått sammen inn i ${ctx.arkiv[pid].sammenslatt_til}`);
      else f(`ukjent planpost ${pid}`);
    }
  for (const s of Array.isArray(dok.eierspm) ? dok.eierspm : [])
    if (ctx.sporsmal && !Object.hasOwn(ctx.sporsmal, s))
      adv(`eierspørsmålet ${s} står ikke i køen (ko.mjs sporsmal ${s} --tekst "…")`);
  if (dok.frist != null && !gyldigDato(dok.frist))
    f('frist må være en dato (YYYY-MM-DD) eller null');
  // moduler er en liste med modul-id-er fra konfigurasjonens `moduler`.
  if (dok.moduler != null) {
    if (!Array.isArray(dok.moduler) || dok.moduler.some((x) => typeof x !== 'string'))
      f('moduler må være en liste med modul-id-er');
    else
      for (const m of dok.moduler)
        if (!moduler().some((x) => x.oid === m))
          f(`ukjent modul ${m} (lov: ${moduler().map((x) => x.oid).join(', ')})`);
  }
  return { feil, advarsler };
}

/** Konteksten validerDok trenger, fra registeret og køen. */
function dokKontekst(reg, ctx, utenId = null) {
  return {
    dokumenter: (reg.dokumenter ?? []).filter((d) => d.id !== utenId),
    poster: reg.poster ?? [],
    arkiv: reg.arkiv ?? {},
    sporsmal: ctx.sporsmal,
    finnesSti: ctx.finnesSti,
  };
}

/**
 * Nytt dokument (`plan dok ny --fil`). Muterer `reg` bare når alt er gyldig. Er prioritet satt, blir
 * prioritet_satt_av rollen til den som kaller (som for planpostene).
 * @returns {{ feil: string[], advarsler: string[], dok?: object }}
 */
function nyDok(reg, inn, ctx = {}) {
  const rolle = ctx.rolle === 'eier' ? 'eier' : 'agent';
  if (!erObjekt(inn)) return { feil: ['dokumentet må være et objekt'], advarsler: [] };
  if (!Array.isArray(reg.dokumenter)) reg.dokumenter = [];
  const hvem = typeof inn.id === 'string' ? inn.id : '(uten id)';
  const feil = [];
  if (typeof inn.id === 'string' && finnDok(reg, inn.id))
    feil.push(`${hvem}: id-en er brukt fra før (id-er brukes aldri om igjen)`);
  for (const k of Object.keys(inn))
    if (DOK_VERKTOY_FELT.has(k) && k !== 'id') feil.push(`${hvem}: ${k} settes av verktøyet`);
  if (inn.prioritet_satt_av === 'eier' && rolle !== 'eier')
    feil.push(`${hvem}: en agent kan ikke sette prioritet_satt_av eier (bruk --satt-av eier)`);
  const dok = {};
  for (const [k, v] of Object.entries(inn)) if (v !== undefined) dok[k] = klonJson(v);
  if (dok.prioritet != null) dok.prioritet_satt_av = rolle;
  else delete dok.prioritet_satt_av;
  dok.opprettet = ctx.naa ?? new Date().toISOString();
  const v = validerDok(dok, dokKontekst(reg, ctx));
  feil.push(...v.feil);
  if (feil.length) return { feil, advarsler: v.advarsler };
  reg.dokumenter.push(dok);
  return { feil: [], advarsler: v.advarsler, dok };
}

/**
 * Endrer feltene i ett dokument (`plan dok endre`). null fjerner feltet. Prioriteten følger grensene for agenten
 *: en agent endrer aldri en prioritet eieren har satt, unntatt regel 1 (sikkerhet).
 * @returns {{ feil: string[], advarsler: string[], dok?: object, endret?: string[], loft?: boolean }}
 */
function endreDok(reg, id, felt, ctx = {}) {
  const rolle = ctx.rolle === 'eier' ? 'eier' : 'agent';
  const liste = Array.isArray(reg.dokumenter) ? reg.dokumenter : [];
  const i = liste.findIndex((d) => d.id === id);
  if (i < 0) return { feil: [`ukjent dokument ${id}`], advarsler: [] };
  if (!erObjekt(felt)) return { feil: [`${id}: feltene må være et objekt`], advarsler: [] };
  const feil = [];
  for (const k of Object.keys(felt))
    if (DOK_VERKTOY_FELT.has(k) || k === 'prioritet_satt_av')
      feil.push(`${id}: ${k} settes av verktøyet`);
  if (feil.length) return { feil, advarsler: [] };
  const gammel = liste[i];
  const ny = klonJson(gammel);
  for (const [k, v] of Object.entries(felt)) {
    if (v === null || v === undefined) delete ny[k];
    else ny[k] = klonJson(v);
  }
  if (ny.prioritet !== 'naa' && !('naa_kategori' in felt)) delete ny.naa_kategori;
  if (ny.prioritet !== 'dropp' && !('dropp_grunn' in felt)) delete ny.dropp_grunn;
  const prioritetEndret =
    (gammel.prioritet ?? null) !== (ny.prioritet ?? null) ||
    !likVerdi(gammel.naa_kategori ?? [], ny.naa_kategori ?? []);
  let loft = false;
  if (prioritetEndret) {
    const t = prioritetsTilgang(gammel, ny, rolle);
    if (t.feil) return { feil: [t.feil], advarsler: [] };
    loft = t.loft;
    if (!('prioritet_grunn' in felt)) delete ny.prioritet_grunn;
    if (ny.prioritet == null) {
      delete ny.prioritet_satt_av;
      delete ny.prioritet_grunn;
      delete ny.agent_loft;
    } else {
      ny.prioritet_satt_av = rolle;
      if (rolle === 'agent' && !('prioritet_grunn' in felt))
        feil.push(
          `${id}: ny prioritet krever prioritet_grunn (én setning: hvilken prioritetsregel og hvorfor)`,
        );
      if (loft)
        ny.agent_loft = {
          at: ctx.naa ?? new Date().toISOString(),
          av: ctx.av ?? 'agent',
          fra: { prioritet: gammel.prioritet ?? null, naa_kategori: gammel.naa_kategori ?? null },
        };
      else if (rolle === 'eier') delete ny.agent_loft;
    }
  } else if (
    rolle === 'agent' &&
    gammel.prioritet_satt_av === 'eier' &&
    !likVerdi(gammel.prioritet_grunn, ny.prioritet_grunn)
  )
    return {
      feil: [`${id}: prioritet_grunn hører til eierens prioritet, og en agent endrer den ikke`],
      advarsler: [],
    };
  const v = validerDok(ny, dokKontekst(reg, ctx, id));
  feil.push(...v.feil);
  if (feil.length) return { feil, advarsler: v.advarsler };
  const endret = [...new Set([...Object.keys(gammel), ...Object.keys(ny)])].filter(
    (k) => !likVerdi(gammel[k], ny[k]),
  );
  liste[i] = ny;
  return { feil: [], advarsler: v.advarsler, dok: ny, endret, loft };
}

/**
 * Registrerer en revisjon (`plan dok revider`): sist_revidert blir datoen, versjon blir den nye (når den er gitt), og
 * revisjonen legges sist i historikken. Gir tidslinjen en ny neste revisjon.
 * @param {{ dato?: string|null, versjon?: string|null, merknad?: string|null, av?: string|null }} valg
 */
function reviderDok(reg, id, valg = {}, ctx = {}) {
  const d = finnDok(reg, id);
  if (!d) return { feil: [`ukjent dokument ${id}`], advarsler: [] };
  const dato = valg.dato ?? osloDato(ctx.naa ? new Date(ctx.naa) : new Date());
  if (!gyldigDato(dato)) return { feil: [`${id}: --dato må være YYYY-MM-DD`], advarsler: [] };
  const rev = { dato };
  if (tekst(valg.versjon)) rev.versjon = tekst(valg.versjon);
  if (tekst(valg.merknad)) rev.merknad = tekst(valg.merknad);
  if (tekst(valg.av)) rev.av = tekst(valg.av);
  const felt = { sist_revidert: dato, revisjoner: [...(d.revisjoner ?? []), rev] };
  if (rev.versjon) felt.versjon = rev.versjon;
  return endreDok(reg, id, felt, ctx);
}

/**
 * Filtrerer dokumentene (`plan dok vis`). Innen et felt er valgene «eller», mellom feltene «og». Droppede skjules
 * uten `alle` eller prioritet dropp.
 * @param {{ gruppe?: string[], status?: string[], malgruppe?: string[], prioritet?: string[], problemer?: boolean,
 *   sok?: string|null, alle?: boolean }} filter
 */
function filtrerDok(reg, filter = {}, { naa = new Date() } = {}) {
  const har = (liste, v) => !liste?.length || liste.includes(v);
  const sok = tekst(filter.sok).toLowerCase();
  return (reg.dokumenter ?? []).filter((d) => {
    if (d.prioritet === 'dropp' && !filter.alle && !(filter.prioritet ?? []).includes('dropp'))
      return false;
    if (!har(filter.gruppe, d.gruppe) || !har(filter.status, d.status)) return false;
    if (!har(filter.malgruppe, d.malgruppe) || !har(filter.prioritet, d.prioritet ?? 'ingen'))
      return false;
    if (
      filter.problemer &&
      !(d.problemer ?? []).length &&
      !versjonsglipp(d).length &&
      !nesteRevisjon(d, { naa })?.forfalt
    )
      return false;
    if (!sok) return true;
    return [d.id, d.tittel, d.kilde, d.merknad, ...(d.problemer ?? []).map((p) => p?.tekst)]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
      .includes(sok);
  });
}

/**
 * Alt om ett dokument (`plan dok hent`): feltene, avhengighetene begge veier, planpostene, eierspørsmålene,
 * versjonsglipp, neste revisjon, hva som må gjøres og kopier-linja. Bare metadata; teksten leses der den ligger.
 */
function hentDok(reg, ko, id, { naa = new Date(), finnesSti = null } = {}) {
  const d = finnDok(reg, id);
  if (!d) return { feil: [`ukjent dokument ${id}`] };
  const alle = reg.dokumenter ?? [];
  const avklart = new Set(ko?.avklart ?? []);
  return {
    feil: [],
    dok: klonJson(d),
    kilde_finnes: d.kilde && finnesSti ? finnesSti(d.kilde) : null,
    avhenger_av: (d.avhenger_av ?? []).map((x) => {
      const a = finnDok(reg, x);
      return { id: x, tittel: a?.tittel ?? null, status: a?.status ?? null };
    }),
    brukt_av: alle.filter((x) => (x.avhenger_av ?? []).includes(d.id)).map((x) => x.id),
    planposter: (d.planposter ?? []).map((pid) => ({
      id: pid,
      tittel: finnPost(reg, pid)?.tittel ?? null,
    })),
    eierspm: (d.eierspm ?? []).map((s) => ({
      id: s,
      tekst: ko?.sporsmal?.[s]?.tekst ?? null,
      avklart: avklart.has(s),
    })),
    glipp: versjonsglipp(d),
    neste_revisjon: nesteRevisjon(d, { naa }),
    grunner: dokGrunner(d, { naa }),
    kopier: dokKopierLinje(d),
  };
}

// ---- Konsistenssjekkene for Dokumenter og avtaler ---------------------------------------------------------------
//
// Avledede funn som `plan sjekk` og `plan dok sjekk` viser: leverandørene prosjektet bruker mot dokumentene som skal
// nevne dem, planlagte leverandørbytter mot dokumentene som går utad, forfalte revisjoner og (bare manuelt) at
// publiserte nettadresser svarer med riktig versjon. Funksjonene her er rene: teksten i dokumentene sendes inn fra
// ko.mjs. `plan dok sjekk --skriv` fører funnene inn som problemer med kilde «sjekk:<type>» (logget og angrbar), så
// fanen og «Hva må gjøres» viser dem uten egen kode.
//
// Leverandørsjekken er valgfri og styres av ko.config.json (`dokumenter`):
//   leverandorer     [{ id, navn, ord?: string[], dokumenter?: (string | { dok, seksjon?, hvor? })[] }]
//                    `ord` er ordene som regnes som at leverandøren er nevnt (standard: navnet). `dokumenter` er
//                    dokument-id-ene i registeret som skal nevne leverandøren; `seksjon` (valgfri) er et regulært
//                    uttrykk for overskriften som avgrenser delen som teller.
//   secretsManifest  null, eller stien til en fil som lister leverandørene som faktisk er i bruk (f.eks. hemmelighetene
//                    per miljø). Med null regnes alle leverandørene i lista som i bruk, og motsatt vei sjekkes ikke.
//   leverandorBytter [{ ut, inn, planpost?, tekst? }]: et dokument som går utad og fortsatt nevner `ut`, er et funn
//                    (høyt når planposten er bygget eller verifisert, ellers middels).
// Tomme lister (standard) slår sjekken av.

/** Typene konsistenssjekker. `nett` kjøres bare manuelt (`plan dok nett`); `revisjon` føres aldri som problem. */
const DOK_SJEKKER = ['leverandor', 'revisjon', 'nett'];

/** Ordet som eget ord (ikke del av et annet ord), uten hensyn til store og små bokstaver. */
function ordMonster(...alternativer) {
  const alt = alternativer.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?<![A-Za-zÆØÅæøå])(?:${alt})(?![A-Za-zÆØÅæøå])`, 'i');
}

/**
 * Dokumentinnstillingene fra konfigurasjonen, med det som sendes inn i ctx foran (tester).
 * @returns {{ leverandorer: object[], secretsManifest: string|null, bytter: object[] }}
 */
function dokInnstillinger(ctx = {}) {
  const k = konfig().dokumenter ?? {};
  const liste = (v) => (Array.isArray(v) ? v : []);
  return {
    leverandorer: liste(ctx.leverandorer ?? k.leverandorer),
    secretsManifest:
      ctx.secretsManifest !== undefined ? ctx.secretsManifest : (k.secretsManifest ?? null),
    bytter: liste(ctx.leverandorBytter ?? k.leverandorBytter),
  };
}

/**
 * Leverandørlista slik sjekken bruker den: id, navn, mønsteret som finner dem i en tekst, og dokumentkravene
 * ({ dok, seksjon: RegExp|null, hvor }). Ugyldige oppføringer hoppes over.
 */
function tolkLeverandorer(liste) {
  const ut = [];
  for (const l of liste ?? []) {
    if (!erObjekt(l) || !tekst(l.id)) continue;
    const navn = tekst(l.navn) || l.id;
    const ord = (Array.isArray(l.ord) && l.ord.length ? l.ord : [navn]).filter((o) => tekst(o));
    const krav = [];
    for (const d of Array.isArray(l.dokumenter) ? l.dokumenter : []) {
      const dok = typeof d === 'string' ? d : d?.dok;
      if (!tekst(dok)) continue;
      let seksjon = null;
      if (erObjekt(d) && tekst(d.seksjon)) {
        try {
          seksjon = new RegExp(d.seksjon, 'i');
        } catch {
          seksjon = null;
        }
      }
      krav.push({ dok, seksjon, hvor: (erObjekt(d) && tekst(d.hvor)) || dok });
    }
    ut.push({ id: l.id, navn, monster: ordMonster(...ord), krav });
  }
  return ut;
}

/**
 * Teksten under den første markdown-overskriften der overskriftsteksten (uten #) treffer `overskrift`, fram til neste
 * overskrift på samme eller høyere nivå. Null når overskriften ikke finnes.
 */
function seksjonITekst(t, overskrift) {
  if (typeof t !== 'string') return null;
  const linjer = t.split('\n');
  const start = linjer.findIndex((l) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(l);
    return m && overskrift.test(m[2].trim());
  });
  if (start < 0) return null;
  const niva = /^(#{1,6})/.exec(linjer[start])[1].length;
  let slutt = linjer.length;
  for (let i = start + 1; i < linjer.length; i++) {
    const m = /^(#{1,6})\s/.exec(linjer[i]);
    if (m && m[1].length <= niva) {
      slutt = i;
      break;
    }
  }
  return linjer.slice(start + 1, slutt).join('\n');
}

/**
 * Leverandørene (id-er) som nevnes i teksten. Med `bareTabell` teller bare første celle i tabellrader.
 * @param {string} t
 * @param {{ bareTabell?: boolean, leverandorer?: object[] }} [o] leverandorer: rålista (standard: konfigurasjonen)
 */
function leverandorerITekst(t, { bareTabell = false, leverandorer } = {}) {
  if (typeof t !== 'string') return [];
  const kilde = bareTabell
    ? t
        .split('\n')
        .filter((l) => /^\s*\|/.test(l) && !/^\s*\|\s*-/.test(l))
        .map((l) => l.split('|')[1] ?? '')
        .join('\n')
    : t;
  const lev = tolkLeverandorer(leverandorer ?? dokInnstillinger().leverandorer);
  return lev.filter((l) => l.monster.test(kilde)).map((l) => l.id);
}

/** Er dokumentet levende (har tekst som skal stemme)? */
const dokLever = (d) =>
  d && !['mangler', 'utdatert'].includes(d.status) && d.prioritet !== 'dropp' && d.kilde;
/** Går dokumentet ut til kunder, nettsiden eller leverandører, eller hører det til personvern? */
const dokUtad = (d) =>
  ['kunde', 'offentlig', 'leverandor'].includes(d.malgruppe) ||
  ['personvern', 'kundeavtaler', 'offentlig'].includes(d.gruppe);

/**
 * Leverandørene mot dokumentene som skal nevne dem, og planlagte leverandørbytter mot dokumentene som går utad.
 * @param {{ lesDok: (sti: string) => string|null, naa?: Date, leverandorer?: object[], secretsManifest?: string|null,
 *   leverandorBytter?: object[] }} ctx leverandorer, secretsManifest og leverandorBytter overstyrer konfigurasjonen
 */
function sjekkLeverandorer(reg, ko, ctx) {
  const funn = [];
  const naa = ctx.naa ?? new Date();
  const inn = dokInnstillinger(ctx);
  const lev = tolkLeverandorer(inn.leverandorer);
  const navn = (id) => lev.find((l) => l.id === id)?.navn ?? id;
  const oppgaver = ko?.oppgaver ?? [];

  // Byttene: er planposten ferdig (bygget eller verifisert)?
  const bytter = inn.bytter
    .filter((b) => erObjekt(b) && tekst(b.ut))
    .map((b) => {
      const p = b.planpost ? finnPost(reg, b.planpost) : null;
      const mod = p ? avledetModenhet(p, oppgaver, { naa }).modenhet : null;
      return { ...b, ferdig: mod === 'bygget' || mod === 'verifisert' };
    });
  const paaVeiUt = new Set(bytter.map((b) => b.ut));

  // Hvilke leverandører er i bruk? Med et manifest: de som nevnes der. Uten: alle i lista.
  let iBruk = new Set(lev.map((l) => l.id));
  let manifest = null;
  if (inn.secretsManifest) {
    manifest = ctx.lesDok(inn.secretsManifest);
    if (manifest == null)
      funn.push({
        dok: null,
        sjekk: 'leverandor',
        alvor: 'lav',
        tekst: `Fant ikke ${inn.secretsManifest}, så alle leverandørene i lista regnes som i bruk`,
      });
    else iBruk = new Set(lev.filter((l) => l.monster.test(manifest)).map((l) => l.id));
  }

  // Dokumentkravene: hvert dokument som skal nevne en leverandør i bruk, må gjøre det.
  const perDok = new Map();
  for (const l of lev)
    for (const k of l.krav) {
      if (!perDok.has(k.dok)) perDok.set(k.dok, []);
      perDok.get(k.dok).push({ lev: l, krav: k });
    }
  for (const [dokId, liste] of perDok) {
    const d = finnDok(reg, dokId);
    if (!d) {
      funn.push({
        dok: null,
        sjekk: 'leverandor',
        alvor: 'middels',
        tekst: `${dokId} står ikke i dokumentregisteret, så leverandørene kunne ikke sjekkes mot det`,
      });
      continue;
    }
    if (!dokLever(d)) continue;
    const t = ctx.lesDok(d.kilde);
    if (t == null) {
      funn.push({
        dok: d.id,
        sjekk: 'leverandor',
        alvor: 'middels',
        tekst: `Fant ikke kilden ${d.kilde}, så leverandørene kunne ikke sjekkes`,
      });
      continue;
    }
    for (const { lev: l, krav } of liste) {
      const del = (krav.seksjon ? seksjonITekst(t, krav.seksjon) : null) ?? t;
      const nevnt = l.monster.test(del);
      if (iBruk.has(l.id) && !paaVeiUt.has(l.id) && !nevnt)
        funn.push({
          dok: d.id,
          sjekk: 'leverandor',
          alvor: 'hoy',
          tekst: `${l.navn} er i bruk${manifest != null ? ` (${inn.secretsManifest})` : ''}, men står ikke i ${krav.hvor}`,
        });
      else if (manifest != null && !iBruk.has(l.id) && nevnt)
        funn.push({
          dok: d.id,
          sjekk: 'leverandor',
          alvor: 'lav',
          tekst: `${l.navn} står i ${krav.hvor}, men ikke i ${inn.secretsManifest}: fortsatt i bruk?`,
        });
    }
  }

  // Alle dokumenter som går utad: nevner de en leverandør som er på vei ut?
  if (bytter.length)
    for (const d of reg.dokumenter ?? []) {
      if (!dokLever(d) || !dokUtad(d)) continue;
      const t = ctx.lesDok(d.kilde);
      if (t == null) continue;
      for (const b of bytter) {
        const ut = lev.find((l) => l.id === b.ut);
        const monster = ut ? ut.monster : ordMonster(b.ut);
        if (!monster.test(t)) continue;
        const status = b.planpost ? ` (${b.planpost}${b.ferdig ? ', bygget' : ', planlagt'})` : '';
        funn.push({
          dok: d.id,
          sjekk: 'leverandor',
          alvor: b.ferdig ? 'hoy' : 'middels',
          tekst: `Nevner ${navn(b.ut)}; ${b.tekst ?? `skal byttes til ${navn(b.inn)}`}${status}`,
        });
      }
    }
  return funn;
}

/** Forfalte revisjoner (vises i sjekken; «Hva må gjøres» har dem alt, så de føres aldri som problem). */
function sjekkRevisjoner(reg, { naa = new Date() } = {}) {
  const funn = [];
  for (const d of reg.dokumenter ?? []) {
    if (d.prioritet === 'dropp') continue;
    const nr = nesteRevisjon(d, { naa });
    if (nr?.forfalt)
      funn.push({
        dok: d.id,
        sjekk: 'revisjon',
        alvor: 'middels',
        tekst: `Revisjonen forfalt ${nr.dato} (${-nr.dager} dager siden)`,
      });
  }
  return funn;
}

/**
 * Den lesende nettsjekken for én publisering: svarer adressen, og står versjonsnummeret på siden? `svar` kommer fra
 * en GET uten innlogging ({ status, tekst } eller { feil }). Bare for publiseringer med https-url.
 */
function vurderNettsvar(dok, pub, svar) {
  const funn = [];
  const alvor = dok.malgruppe === 'offentlig' || dok.gruppe === 'offentlig' ? 'hoy' : 'middels';
  const hvor = pub.url;
  if (!svar || svar.feil) {
    funn.push({
      dok: dok.id,
      sjekk: 'nett',
      alvor,
      tekst: `${hvor} svarer ikke (${svar?.feil ?? 'ukjent feil'})`,
    });
    return funn;
  }
  if (!(svar.status >= 200 && svar.status < 300)) {
    funn.push({ dok: dok.id, sjekk: 'nett', alvor, tekst: `${hvor} svarer ${svar.status}` });
    return funn;
  }
  const v = ver(pub.versjon);
  if (v) {
    const re = new RegExp(`(?<![0-9.])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`);
    if (!re.test(String(svar.tekst ?? '')))
      funn.push({
        dok: dok.id,
        sjekk: 'nett',
        alvor: 'middels',
        tekst: `${hvor} viser ikke versjon ${v} (registeret sier ${v})`,
      });
  }
  return funn;
}

/** Publiseringene nettsjekken skal hente: [{ dok, pub }] med https-url. */
function nettAdresser(reg) {
  const ut = [];
  for (const d of reg.dokumenter ?? []) {
    if (d.prioritet === 'dropp' || d.status === 'mangler') continue;
    for (const p of d.publisert ?? [])
      if (typeof p?.url === 'string' && /^https:\/\/\S+$/.test(p.url)) ut.push({ dok: d, pub: p });
  }
  return ut;
}

/** Rekkefølgen funnene vises i: høy alvor først, så dokument-id. */
const ALVOR_REKKE = { hoy: 0, middels: 1, lav: 2 };
const sorterFunn = (funn) =>
  funn.sort(
    (a, b) =>
      (ALVOR_REKKE[a.alvor] ?? 9) - (ALVOR_REKKE[b.alvor] ?? 9) ||
      String(a.dok ?? '').localeCompare(String(b.dok ?? ''), 'nb') ||
      a.tekst.localeCompare(b.tekst, 'nb'),
  );

/**
 * Konsistenssjekkene for dokumentregisteret, uten nettsjekken (den kjøres bare manuelt).
 * @param {{ lesDok?: (sti: string) => string|null, naa?: Date, leverandorer?: object[],
 *   secretsManifest?: string|null, leverandorBytter?: object[] }} ctx
 *   lesDok: teksten i en fil under prosjektrota. Leverandørsjekken kjører bare med lesDok og en ikke-tom
 *   leverandørliste (eller leverandørbytter); resten overstyrer konfigurasjonen (tester).
 * @returns {{ funn: { dok: string|null, sjekk: string, alvor: string, tekst: string }[], kjorte: string[] }}
 */
function dokKonsistens(reg, ko, ctx = {}) {
  const naa = ctx.naa ?? new Date();
  if (!(reg.dokumenter ?? []).length) return { funn: [], kjorte: [] };
  const funn = [];
  const kjorte = ['revisjon'];
  const inn = dokInnstillinger(ctx);
  if (ctx.lesDok && (inn.leverandorer.length || inn.bytter.length)) {
    funn.push(...sjekkLeverandorer(reg, ko, { ...ctx, naa }));
    kjorte.push('leverandor');
  }
  funn.push(...sjekkRevisjoner(reg, { naa }));
  return { funn: sorterFunn(funn), kjorte: DOK_SJEKKER.filter((s) => kjorte.includes(s)) };
}

/**
 * Fører funnene inn som problemer (`plan dok sjekk --skriv`): for hver sjekk som kjørte, erstattes de gamle problemene
 * med kilde «sjekk:<type>» med de nye. Problemer andre har skrevet, røres ikke. Revisjoner føres ikke (de står alt i
 * «Hva må gjøres»), og funn uten dokument blir bare vist. Muterer `reg` bare når alt er gyldig.
 * @returns {{ feil: string[], advarsler: string[], endret: string[] }}
 */
function synkKonsistens(reg, funn, kjorte, ctx = {}) {
  const sett = new Set((kjorte ?? []).filter((s) => s !== 'revisjon'));
  const feil = [];
  const advarsler = [];
  const endret = [];
  const kopi = klonJson(reg);
  for (const d of kopi.dokumenter ?? []) {
    const gamle = Array.isArray(d.problemer) ? d.problemer : [];
    const beholdt = gamle.filter((p) => {
      const m = /^sjekk:(\w+)$/.exec(p?.kilde ?? '');
      return !m || !sett.has(m[1]);
    });
    const nye = [];
    for (const f of funn ?? [])
      if (f.dok === d.id && sett.has(f.sjekk) && !nye.some((x) => x.tekst === f.tekst))
        nye.push({ tekst: f.tekst, alvor: f.alvor, kilde: `sjekk:${f.sjekk}` });
    const alle = [...beholdt, ...nye];
    if (likVerdi(gamle, alle)) continue;
    const s = endreDok(kopi, d.id, { problemer: alle.length ? alle : null }, ctx);
    feil.push(...s.feil);
    advarsler.push(...s.advarsler);
    if (!s.feil.length) endret.push(d.id);
  }
  if (feil.length) return { feil, advarsler, endret: [] };
  reg.dokumenter = kopi.dokumenter;
  return { feil: [], advarsler, endret };
}

// ---- juridisk panel, eierbeslutninger og lanseringsoversikt -----------------------------
//
// Alt her er VISNINGER over data som finnes fra før: juridisk-feltet på planpostene, `sporsmal`, `avklart` og
// `avklaringer` i ko.json, og dokumentregisteret. Ingenting lagres på nytt. Svar på et eierspørsmål går som før via
// `ko.mjs avklar <id> --svar … --av eier` (tavla bruker samme rute som «Venter på deg»), og juridiske punkter endres
// med `ko.mjs plan endre <id> --sett '{"juridisk":…}'` (validert av validerJuridisk under). Juristpakken er et
// utkast i <dataMappe>/juristpakker/juristpakke-<dato>.md som tavla skriver lokalt; den sendes aldri noe sted.

/** Statusene til et juridisk punkt, i arbeidsrekkefølgen (KI-vurdering først, så jurist). */
const JUR_STATUSER = ['apen', 'ki-vurdert', 'til-jurist', 'avklart', 'ikke-relevant'];
/** Statusene som regnes som åpne. */
const JUR_APNE = ['apen', 'ki-vurdert', 'til-jurist'];
/** Hva et åpent punkt stopper, det alvorligste først. */
const JUR_BLOKKERER = ['prod', 'pakking', 'ingenting'];
/** DPIA-vurderingen på en post (null = ikke vurdert ennå). */
const DPIA_VERDIER = ['trengs', 'finnes', 'ikke-relevant'];
/** Id på et juridisk punkt (f.eks. J-EKSPORT-2; korte id-er som J7b og E1 er også lov). */
const JUR_PUNKT_ID = /^[A-Za-zÆØÅæøå][A-Za-z0-9ÆØÅæøå._-]{0,39}$/;
const JUR_FELT = ['berorer', 'personvern', 'punkter'];
const JUR_PERSONVERN_FELT = ['art9', 'dpia', 'dpa_endring'];
const JUR_PUNKT_FELT = ['id', 'sporsmal', 'status', 'ki_vurdering', 'jurist', 'blokkerer', 'frist'];
const JURIST_FELT = ['svar', 'dato', 'kilde'];
/** Et eierspørsmål med frist innen så mange dager (eller forfalt) står øverst i Beslutninger. */
const BESLUTNING_HASTER_DAGER = 14;
/** Minutter en køoppgave teller når innhold_min mangler (som koLogikk). */
const OPPGAVE_MIN_STANDARD = 30;
/** Spørsmålstypen som er en eierhandling (signere, bestille, sende brev, sette en hemmelighet). */
const EIERHANDLING_TYPE = 'eier-oppgave';

/**
 * Validerer juridisk-feltet på en planpost.
 * @param {object} j
 * @param {{ andrePunkter?: Map<string, string> }} ctx punkt-id → post-id for punktene i de andre postene
 * @returns {{ feil: string[], advarsler: string[] }}
 */
function validerJuridisk(j, ctx = {}) {
  const feil = [];
  const advarsler = [];
  const f = (t) => feil.push(`juridisk: ${t}`);
  const adv = (t) => advarsler.push(`juridisk: ${t}`);
  if (!erObjekt(j)) return { feil: ['juridisk må være et objekt eller null'], advarsler };
  for (const k of Object.keys(j))
    if (!JUR_FELT.includes(k)) f(`ukjent felt ${k} (lov: ${JUR_FELT.join(', ')})`);

  if (j.berorer != null && (!Array.isArray(j.berorer) || j.berorer.some((x) => !tekst(x))))
    f('berorer må være en liste med lovhenvisninger (tekst)');

  const pv = j.personvern;
  if (pv != null) {
    if (!erObjekt(pv)) f('personvern må være { art9, dpia, dpa_endring } eller null');
    else {
      for (const k of Object.keys(pv))
        if (!JUR_PERSONVERN_FELT.includes(k))
          f(`personvern: ukjent felt ${k} (lov: ${JUR_PERSONVERN_FELT.join(', ')})`);
      for (const k of ['art9', 'dpa_endring'])
        if (pv[k] != null && typeof pv[k] !== 'boolean')
          f(`personvern.${k} må være true eller false`);
      if (pv.dpia != null && !DPIA_VERDIER.includes(pv.dpia))
        f(`personvern.dpia må være ${DPIA_VERDIER.join(', ')} eller null`);
      if (pv.art9 === true && pv.dpia == null)
        adv(
          'art. 9-opplysninger uten DPIA-vurdering (personvern.dpia: trengs, finnes eller ikke-relevant)',
        );
    }
  }

  if (j.punkter != null && !Array.isArray(j.punkter)) f('punkter må være en liste');
  const sett = new Set();
  for (const p of Array.isArray(j.punkter) ? j.punkter : []) {
    if (!erObjekt(p)) {
      f('hvert punkt må være et objekt');
      continue;
    }
    const hvem = typeof p.id === 'string' ? p.id : '(uten id)';
    const pf = (t) => f(`punkt ${hvem}: ${t}`);
    const padv = (t) => adv(`punkt ${hvem}: ${t}`);
    for (const k of Object.keys(p))
      if (!JUR_PUNKT_FELT.includes(k)) pf(`ukjent felt ${k} (lov: ${JUR_PUNKT_FELT.join(', ')})`);
    if (typeof p.id !== 'string' || !JUR_PUNKT_ID.test(p.id))
      pf(
        'id må være bokstaver, tall, punktum, understrek og bindestrek (f.eks. J-EKSPORT-2), høyst 40 tegn',
      );
    else if (sett.has(p.id)) pf('id-en står to ganger i posten');
    else if (ctx.andrePunkter?.has(p.id))
      pf(`id-en er brukt i ${ctx.andrePunkter.get(p.id)} (punkt-id-er er unike i registeret)`);
    if (typeof p.id === 'string') sett.add(p.id);
    if (!tekst(p.sporsmal)) pf('sporsmal mangler');
    if (!JUR_STATUSER.includes(p.status)) pf(`status må være en av ${JUR_STATUSER.join(', ')}`);
    if (!JUR_BLOKKERER.includes(p.blokkerer))
      pf(`blokkerer må være en av ${JUR_BLOKKERER.join(', ')}`);
    if (p.ki_vurdering != null && typeof p.ki_vurdering !== 'string')
      pf('ki_vurdering må være tekst eller null');
    if (p.frist != null && !gyldigDato(p.frist))
      pf('frist må være en dato (YYYY-MM-DD) eller null');
    if (p.jurist != null) {
      const ju = p.jurist;
      if (!erObjekt(ju)) pf('jurist må være { svar, dato, kilde? } eller null');
      else {
        for (const k of Object.keys(ju))
          if (!JURIST_FELT.includes(k))
            pf(`jurist: ukjent felt ${k} (lov: ${JURIST_FELT.join(', ')})`);
        if (!tekst(ju.svar)) pf('jurist.svar mangler');
        if (!gyldigDato(ju.dato)) pf('jurist.dato må være en dato (YYYY-MM-DD)');
        if (ju.kilde != null && typeof ju.kilde !== 'string') pf('jurist.kilde må være tekst');
      }
    }
    if (p.status === 'ki-vurdert' && !tekst(p.ki_vurdering))
      padv('ki-vurdert uten ki_vurdering (kort konklusjon og sti til notatet)');
    if (p.status === 'avklart' && p.jurist == null && !tekst(p.ki_vurdering))
      padv('avklart uten jurist-svar eller KI-vurdering');
    if (p.jurist != null && JUR_APNE.includes(p.status))
      padv('juristen har svart, men punktet står fortsatt åpent (sett status avklart)');
  }
  return { feil, advarsler };
}

/** Rekkefølgen for et punkt: åpne etter arbeidsrekkefølgen, så det alvorligste, så frist. */
function punktRekke(a, b) {
  const s = (x) => {
    const i = JUR_STATUSER.indexOf(x.status);
    return i < 0 ? 99 : i;
  };
  const bl = (x) => {
    const i = JUR_BLOKKERER.indexOf(x.blokkerer);
    return i < 0 ? 9 : i;
  };
  const fr = (x) => (gyldigDato(x.frist) ? x.frist : '9999-99-99');
  return (
    s(a) - s(b) ||
    bl(a) - bl(b) ||
    fr(a).localeCompare(fr(b)) ||
    String(a.id).localeCompare(String(b.id), 'nb')
  );
}

/**
 * Alle juridiske punkter på tvers av planpostene, flatt, med posten, modulen og lovhenvisningene. Åpne først
 * (apen, ki-vurdert, til-jurist), så blokkerer prod før pakking, så frist.
 * @returns {object[]}
 */
function juridiskePunkter(reg, ko, { naa = new Date() } = {}) {
  const idag = osloDato(naa);
  const ut = [];
  for (const p of reg?.poster ?? []) {
    const j = erObjekt(p?.juridisk) ? p.juridisk : null;
    if (!j) continue;
    for (const x of Array.isArray(j.punkter) ? j.punkter : []) {
      if (!erObjekt(x) || typeof x.id !== 'string') continue;
      ut.push({
        id: x.id,
        sporsmal: typeof x.sporsmal === 'string' ? x.sporsmal : '',
        status: x.status ?? 'apen',
        apen: JUR_APNE.includes(x.status ?? 'apen'),
        blokkerer: x.blokkerer ?? 'ingenting',
        frist: gyldigDato(x.frist) ? x.frist : null,
        frist_dager: gyldigDato(x.frist) ? dagerMellom(idag, x.frist) : null,
        ki_vurdering: typeof x.ki_vurdering === 'string' ? x.ki_vurdering : null,
        jurist: erObjekt(x.jurist) ? x.jurist : null,
        post: p.id,
        post_tittel: p.tittel ?? p.id,
        post_prioritet: p.prioritet ?? null,
        prosjekt: p.prosjekt ?? null,
        modul: modulFor(p, ko?.prosjekter) ?? null,
        berorer: Array.isArray(j.berorer) ? j.berorer.filter((s) => typeof s === 'string') : [],
        personvern: erObjekt(j.personvern) ? j.personvern : null,
        kilder: (p.kilder ?? [])
          .filter((k) => erObjekt(k) && typeof k.sti === 'string')
          .map((k) => ({ sti: k.sti, anker: k.anker ?? null })),
      });
    }
  }
  return ut.sort(punktRekke);
}

/**
 * Personvernstatus per modul: art. 9-flater, DPIA (trengs, finnes, ikke-relevant, ikke vurdert) og
 * DPA-endringer. Bare moduler med minst én post som har personvern satt; droppede poster telles ikke.
 * @returns {{ modul: string|null, art9: string[], dpia: Record<string, string[]>, dpa_endring: string[] }[]}
 */
function personvernPerModul(reg, ko) {
  const per = new Map();
  for (const p of reg?.poster ?? []) {
    if (p?.prioritet === 'dropp') continue;
    const pv = erObjekt(p?.juridisk?.personvern) ? p.juridisk.personvern : null;
    if (!pv) continue;
    const m = modulFor(p, ko?.prosjekter) ?? null;
    if (!per.has(m))
      per.set(m, {
        modul: m,
        art9: [],
        dpia: { trengs: [], finnes: [], 'ikke-relevant': [], uvurdert: [] },
        dpa_endring: [],
      });
    const r = per.get(m);
    if (pv.art9 === true) {
      r.art9.push(p.id);
      r.dpia[DPIA_VERDIER.includes(pv.dpia) ? pv.dpia : 'uvurdert'].push(p.id);
    } else if (DPIA_VERDIER.includes(pv.dpia)) r.dpia[pv.dpia].push(p.id);
    if (pv.dpa_endring === true) r.dpa_endring.push(p.id);
  }
  const rekke = moduler().map((m) => m.oid);
  const plass = (m) => {
    const i = rekke.indexOf(m);
    return i < 0 ? 99 : i;
  };
  return [...per.values()].sort(
    (a, b) => plass(a.modul) - plass(b.modul) || String(a.modul).localeCompare(String(b.modul)),
  );
}

/** Dato (YYYY-MM-DD) fra et ISO-tidspunkt, ellers null. */
function isoDag(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * Eierbeslutningene: hvert eierspørsmål i ko.json med hva det blokkerer (planposter direkte og via avhenger,
 * køoppgaver som venter og minuttene deres), frist, modul og prosjekt, og hvor lenge det har stått åpent.
 *
 * Sorteringen av de åpne (toppen er «svar på dette først»):
 *   1. frist forfalt eller innen BESLUTNING_HASTER_DAGER, tidligste først,
 *   2. flest blokkerte planposter,
 *   3. flest minutter i kø som venter,
 *   4. frist (uten frist sist), så eldst først, så id.
 * De besvarte (historikken) står for seg, nyeste svar først.
 * @returns {{ apne: object[], besvarte: object[] }}
 */
function eierBeslutninger(reg, ko, { naa = new Date() } = {}) {
  const idag = osloDato(naa);
  const avklart = new Set(ko?.avklart ?? []);
  const poster = (reg?.poster ?? []).filter((p) => p?.prioritet !== 'dropp');
  const perSp = new Map();
  const fa = (sp) => {
    if (!perSp.has(sp)) perSp.set(sp, { poster: new Set(), oppgaver: [] });
    return perSp.get(sp);
  };
  for (const p of poster)
    for (const sp of p.eierspm ?? []) if (typeof sp === 'string') fa(sp).poster.add(p.id);
  for (const o of ko?.oppgaver ?? []) {
    if (o?.status !== 'venter' && o?.status !== 'forslag') continue;
    for (const sp of o.venter_paa ?? []) if (typeof sp === 'string') fa(sp).oppgaver.push(o);
  }
  const ider = new Set([...Object.keys(ko?.sporsmal ?? {}), ...perSp.keys()]);
  const apne = [];
  const besvarte = [];
  for (const sp of ider) {
    const q = Object.hasOwn(ko?.sporsmal ?? {}, sp) ? ko.sporsmal[sp] : null;
    const kob = perSp.get(sp) ?? { poster: new Set(), oppgaver: [] };
    const direkte = [...kob.poster];
    const blokkert = new Set(direkte);
    for (const id of direkte) {
      const p = poster.find((x) => x.id === id);
      if (p) for (const b of blokkerer(p, poster)) blokkert.add(b.id);
    }
    const venter = kob.oppgaver.filter((o) => o.status === 'venter');
    const minutter = venter.reduce(
      (n, o) => n + (Number(o.innhold_min ?? OPPGAVE_MIN_STANDARD) || 0),
      0,
    );
    const frister = [
      gyldigDato(q?.frist) ? q.frist : null,
      ...direkte.map((id) => poster.find((x) => x.id === id)?.frist),
    ].filter((d) => gyldigDato(d));
    const frist = frister.length ? frister.sort()[0] : null;
    const moduler = new Set();
    const prosjekter = new Set();
    for (const id of direkte) {
      const p = poster.find((x) => x.id === id);
      if (!p) continue;
      if (p.prosjekt) prosjekter.add(p.prosjekt);
      const m = modulFor(p, ko?.prosjekter);
      if (m) moduler.add(m);
    }
    for (const o of kob.oppgaver) {
      if (!o.prosjekt) continue;
      prosjekter.add(o.prosjekt);
      const m = ko?.prosjekter?.[o.prosjekt]?.omrade;
      if (m) moduler.add(m);
    }
    const lagt = isoDag(q?.lagt_til);
    const svar = ko?.avklaringer?.[sp] ?? null;
    const rad = {
      id: sp,
      type: q?.type ?? 'sporsmal',
      handling: q?.type === EIERHANDLING_TYPE,
      tekst: q?.tekst ?? null,
      anbefaling: q?.anbefaling ?? null,
      kilde: q?.kilde ?? null,
      lagt_til: lagt,
      dager_apen: lagt ? Math.max(0, dagerMellom(lagt, idag)) : null,
      avklart: avklart.has(sp),
      svar: typeof svar?.svar === 'string' ? svar.svar : null,
      svar_tid: typeof svar?.tid === 'string' ? svar.tid : null,
      svar_av: typeof svar?.av === 'string' ? svar.av : null,
      poster: direkte.sort(),
      blokkerte_poster: [...blokkert].sort(),
      oppgaver: venter.map((o) => o.id),
      forslag: kob.oppgaver.filter((o) => o.status === 'forslag').map((o) => o.id),
      minutter,
      frist,
      frist_dager: frist ? dagerMellom(idag, frist) : null,
      moduler: [...moduler].sort(),
      prosjekter: [...prosjekter].sort(),
    };
    rad.haster = rad.frist_dager != null && rad.frist_dager <= BESLUTNING_HASTER_DAGER;
    (rad.avklart ? besvarte : apne).push(rad);
  }
  apne.sort(
    (a, b) =>
      Number(b.haster) - Number(a.haster) ||
      (a.haster ? a.frist.localeCompare(b.frist) : 0) ||
      b.blokkerte_poster.length - a.blokkerte_poster.length ||
      b.minutter - a.minutter ||
      (a.frist ?? '9999').localeCompare(b.frist ?? '9999') ||
      (b.dager_apen ?? -1) - (a.dager_apen ?? -1) ||
      a.id.localeCompare(b.id, 'nb'),
  );
  besvarte.sort(
    (a, b) =>
      String(b.svar_tid ?? '').localeCompare(String(a.svar_tid ?? '')) ||
      a.id.localeCompare(b.id, 'nb'),
  );
  return { apne, besvarte };
}

/**
 * Lanseringsoversikten: «hva står mellom oss og første betalende kunde?». En visning, ikke et lager:
 *   - poster: planposter i Nå med kategorien for-prod (ferdig = bygget eller verifisert),
 *   - juridisk: åpne juridiske punkter som blokkerer prod,
 *   - handlinger: åpne eierhandlinger (type eier-oppgave), med frist først,
 *   - beslutninger: andre åpne eierspørsmål koblet til en for-prod-post,
 *   - dokumenter: dokumenter merket Nå før prod som har noe som må gjøres (grunnene fra dokGrunner).
 * @returns {{ poster: object[], juridisk: object[], handlinger: object[], beslutninger: object[],
 *   dokumenter: object[], gjenstaar: number, totalt: number }}
 */
function lanseringsoversikt(reg, ko, { naa = new Date() } = {}) {
  const forProd = (reg?.poster ?? []).filter(
    (p) => p?.prioritet === 'naa' && (p.naa_kategori ?? []).includes('for-prod'),
  );
  const poster = forProd
    .map((p) => {
      const av = avledetModenhet(p, ko?.oppgaver, { naa });
      return {
        id: p.id,
        tittel: p.tittel ?? p.id,
        prosjekt: p.prosjekt ?? null,
        modul: modulFor(p, ko?.prosjekter) ?? null,
        modenhet: av.modenhet,
        brok: av.brok ?? null,
        frist: gyldigDato(p.frist) ? p.frist : null,
        ferdig: av.modenhet === 'bygget' || av.modenhet === 'verifisert',
      };
    })
    .sort(
      (a, b) =>
        Number(a.ferdig) - Number(b.ferdig) ||
        (a.frist ?? '9999').localeCompare(b.frist ?? '9999') ||
        a.id.localeCompare(b.id, 'nb'),
    );
  const juridisk = juridiskePunkter(reg, ko, { naa }).filter(
    (x) => x.apen && x.blokkerer === 'prod' && x.post_prioritet !== 'dropp',
  );
  const b = eierBeslutninger(reg, ko, { naa });
  const forProdIder = new Set(forProd.map((p) => p.id));
  const handlinger = b.apne
    .filter((x) => x.handling)
    .sort(
      (x, y) =>
        (x.frist ?? '9999').localeCompare(y.frist ?? '9999') || x.id.localeCompare(y.id, 'nb'),
    );
  const beslutninger = b.apne.filter(
    (x) => !x.handling && x.poster.some((id) => forProdIder.has(id)),
  );
  const dokumenter = dokMaaGjores(
    (reg?.dokumenter ?? []).filter(
      (d) => d?.prioritet === 'naa' && (d.naa_kategori ?? []).includes('for-prod'),
    ),
    { naa },
  );
  const igjen = poster.filter((p) => !p.ferdig).length;
  const gjenstaar =
    igjen + juridisk.length + handlinger.length + beslutninger.length + dokumenter.length;
  return {
    poster,
    juridisk,
    handlinger,
    beslutninger,
    dokumenter,
    gjenstaar,
    totalt:
      poster.length + juridisk.length + handlinger.length + beslutninger.length + dokumenter.length,
  };
}

/**
 * Stien til juristpakken for en dato (relativt til hovedtreet). Den ligger i datamappa (ko.config.json `dataMappe`,
 * som skal være gitignorert), så utkastet aldri havner i git.
 */
function juristpakkeSti(dato, { mappe = konfig().dataMappe } = {}) {
  if (!gyldigDato(dato)) throw new Error(`ugyldig dato ${dato}`);
  return `${String(mappe).replace(/\\/g, '/').replace(/\/+$/, '')}/juristpakker/juristpakke-${dato}.md`;
}

/** Én linje markdown uten linjeskift (fritekst fra registeret skal ikke kunne lage nye overskrifter). */
function enLinje(s) {
  return String(s ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/**
 * Juristpakken: punktene med status til-jurist samlet i ett utkast med kontekst, KI-vurdering,
 * lovhenvisninger og plan-lenker. Bare tekst; fila skrives lokalt av tavla (i datamappa, gitignorert) og sendes aldri.
 * Droppede poster er ikke med.
 * @returns {{ sti: string, tekst: string, punkter: string[] }}
 */
function juristpakke(reg, ko, { dato = null, naa = new Date() } = {}) {
  const dag = dato ?? osloDato(naa);
  const sti = juristpakkeSti(dag);
  const punkter = juridiskePunkter(reg, ko, { naa }).filter(
    (x) => x.status === 'til-jurist' && x.post_prioritet !== 'dropp',
  );
  const modulNavn = (m) =>
    ko?.omrader?.[m]?.tittel ?? moduler().find((x) => x.oid === m)?.tittel ?? m ?? 'Uten modul';
  const l = [];
  l.push(`# Juristpakke ${dag}`, '');
  l.push(
    'Utkast laget fra planregisteret (scripts/.ko/planer.json) av køtavla. Det er ikke sendt til noen. Les gjennom,',
    'fjern det som ikke skal med, og send det selv.',
    '',
  );
  if (!punkter.length) {
    l.push('Ingen juridiske punkter har status til-jurist.', '');
    return { sti, tekst: `${l.join('\n')}`, punkter: [] };
  }
  l.push(
    `Punkter: ${punkter.length}. Sortert etter hva de blokkerer (prod før pakking) og frist.`,
    '',
  );
  l.push('| Punkt | Blokkerer | Frist | Plan |', '|---|---|---|---|');
  for (const x of punkter)
    l.push(
      `| ${x.id} | ${x.blokkerer} | ${x.frist ?? ''} | ${x.post} ${enLinje(x.post_tittel).replace(/\|/g, '/')} |`,
    );
  l.push('');
  for (const x of punkter) {
    l.push(`## ${x.id}: ${enLinje(x.sporsmal)}`, '');
    l.push(`- Plan: ${x.post} ${enLinje(x.post_tittel)}`);
    l.push(`- Modul og prosjekt: ${modulNavn(x.modul)}, ${x.prosjekt ?? 'uten prosjekt'}`);
    l.push(`- Blokkerer: ${x.blokkerer}${x.frist ? `, frist ${x.frist}` : ''}`);
    if (x.berorer.length) l.push(`- Lovhenvisninger: ${x.berorer.map(enLinje).join('; ')}`);
    const pv = x.personvern;
    if (pv) {
      const deler = [
        pv.art9 ? 'art. 9-opplysninger' : 'ikke art. 9',
        pv.dpia ? `DPIA ${pv.dpia}` : 'DPIA ikke vurdert',
        pv.dpa_endring ? 'DPA må endres' : null,
      ].filter(Boolean);
      l.push(`- Personvern: ${deler.join(', ')}`);
    }
    l.push(`- KI-vurdering: ${x.ki_vurdering ? enLinje(x.ki_vurdering) : 'ingen ennå'}`);
    if (x.kilder.length)
      l.push(
        `- Plan-lenker: ${x.kilder.map((k) => `${k.sti}${k.anker ? ` (${enLinje(k.anker)})` : ''}`).join('; ')}`,
      );
    l.push('');
  }
  return { sti, tekst: l.join('\n'), punkter: punkter.map((x) => x.id) };
}

module.exports = {
  PRIORITETER,
  NAA_KATEGORIER,
  SATT_AV,
  MODENHET_MANUELL,
  MODENHET_AVLEDET,
  MODENHETER,
  ESTIMATER,
  FORELDET_DAGER,
  ENDRINGSLOGG_MAKS,
  // Prioritetsreglene fra konfigurasjonen (eller standarden), lest ved hvert oppslag.
  get PRIORITETSREGLER() {
    return prioritetsregler();
  },
  STANDARD_PRIORITETSREGLER,
  prioritetsregler,
  FELT,
  tomtRegister,
  normaliser,
  osloDato,
  gyldigDato,
  idBrukt,
  finnPost,
  modulFor,
  kildestiFeil,
  validerPost,
  regelMotPrioritet,
  regelNrFraGrunn,
  maaltRegel,
  blokkerer,
  prioritetsTilgang,
  nyPost,
  endrePost,
  prioriter,
  prioriterMange,
  verifiser,
  slaaSammen,
  koOppgaverFor,
  erForeldet,
  avledetModenhet,
  sorterPoster,
  filtrerPoster,
  hent,
  kopierLinje,
  planDiff,
  loggEndring,
  sisteAngrbare,
  angre,
  forventSjekk,
  tolkFeltArg,
  // Modulene og forslagene fra konfigurasjonen, lest ved hvert oppslag (P.MODULER virker som før).
  get MODULER() {
    return moduler();
  },
  get PROSJEKT_MODUL_FORSLAG() {
    return prosjektModulForslag();
  },
  moduler,
  prosjektModulForslag,
  PROSJEKT_FASER,
  ESTIMAT_SPOR,
  KAPASITET_VINDU_DAGER,
  get UREGISTRERT_UNNTAK() {
    return uregistrertUnntak();
  },
  get DOKUMENT_MAPPER() {
    return dokumentMapper();
  },
  uregistrertUnntak,
  dokumentMapper,
  modulPlan,
  fasePlanAvsluttes,
  planKoblingFeil,
  koblePlan,
  ankerTekst,
  ankerSeksjon,
  dokStatus,
  KILDE_ROLLER_UTEN_STATUS,
  duplikater,
  kapasitet,
  sjekk,
  AKTIV_OKT_TIMER,
  erAktivOkt,
  aktivePoster,
  settAktivOkt,
  DOK_GRUPPER,
  DOK_MALGRUPPER,
  DOK_STATUSER,
  DOK_PUBLISERT_HVOR,
  DOK_ALVOR,
  DOK_FELT,
  DOK_REVISJON_SNART_DAGER,
  finnDok,
  revisjonsIntervall,
  nesteRevisjon,
  versjonsglipp,
  dokGrunner,
  dokMaaGjores,
  revisjonsTidslinje,
  dokKopierLinje,
  validerDok,
  nyDok,
  endreDok,
  reviderDok,
  filtrerDok,
  hentDok,
  DOK_SJEKKER,
  dokInnstillinger,
  tolkLeverandorer,
  seksjonITekst,
  leverandorerITekst,
  sjekkLeverandorer,
  sjekkRevisjoner,
  vurderNettsvar,
  nettAdresser,
  dokKonsistens,
  synkKonsistens,
  JUR_STATUSER,
  JUR_APNE,
  JUR_BLOKKERER,
  DPIA_VERDIER,
  BESLUTNING_HASTER_DAGER,
  EIERHANDLING_TYPE,
  validerJuridisk,
  juridiskePunkter,
  personvernPerModul,
  eierBeslutninger,
  lanseringsoversikt,
  juristpakkeSti,
  juristpakke,
};
