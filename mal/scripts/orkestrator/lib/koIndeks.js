// =============================================================
// koIndeks.js: en valgfri dokumentindeks (en markdown-fil, standard docs/INDEKS.md) ordnet etter planregisteret.
//
// Funksjonen er valgfri: et prosjekt uten indeksfil merker ingenting. Stien står i ko.config.json (`indeksFil`;
// null slår den av), og hvilke mapper som regnes som sporede dokumenter i `dokumentMapper` (standard docs).
// Se docs/plan-register.md.
//
// Hvorfor: planregisteret (planer.json i datamappa) er sannheten om planene. INDEKS er dokumentlista agentene leser
// (den er sporet, registeret er det ikke). For at det skal finnes én kilde, bygges strukturen i INDEKS fra registeret:
//   - hvilken modul et dokument hører til (via planpostene som peker til det og prosjektets `omrade`),
//   - hvilke planposter som peker til det (linja «Planposter: …»),
//   - nye sporede dokumenter som en planpost peker til, men som mangler en linje.
// Beskrivelsen av hvert dokument (teksten etter stien) er skrevet for hånd og beholdes ordrett. Den finnes ikke i
// registeret (en kilde er bare { sti, anker, rolle }), så generatoren leser den fra INDEKS selv og skriver den tilbake.
// Generatoren er dermed idempotent: to kjøringer på rad gir samme fil, og «drift» betyr at registeret har endret seg
// siden sist (eller at noen har redigert strukturen for hånd).
//
// Rene funksjoner (ingen fil, ingen klokke): det som trenger filsystemet, sendes inn. Modulene og mappene kommer fra
// konfigurasjonen når de ikke sendes inn. CLI: scripts/orkestrator/lag-indeks.mjs. Tester: lib/__tests__/koIndeks.test.ts.
// =============================================================
'use strict';

const P = require('./koPlan.js');
const { konfig } = require('./koKonfig.js');

/** Standardstien til indeksfila (relativt til prosjektrota) når ko.config.json ikke sier noe. */
const INDEKS_STANDARD = 'docs/INDEKS.md';

/** Indeksfila fra ko.config.json (`indeksFil`): en relativ sti, eller null når funksjonen er slått av. */
function indeksFil() {
  const f = konfig().indeksFil;
  if (f === null) return null;
  return typeof f === 'string' && f.trim() ? f.trim().replace(/\\/g, '/') : INDEKS_STANDARD;
}

/** Starten på den genererte linja med planpostene under en oppføring. Linja fjernes ved lesing og lages på nytt. */
const PLANPOSTER_PREFIKS = '  Planposter: ';
/** Flere poster enn dette vises som et antall med en søkekommando, så linja ikke blir en vegg (roadmapen har ~100). */
const MAKS_POSTER_PAA_LINJA = 6;
/** Peker et dokument til poster i minst så mange moduler, havner det under «Tverrgående». */
const TVERRGAAENDE_MODULER = 3;
/**
 * Kilderollene som gir en ny oppføring automatisk. INDEKS er lista over planer og oppslagsverk; historikk, utredninger
 * og funnrapporter som bare er underlag for en post, står i registeret og trenger ingen egen linje (de kan likevel
 * føres inn for hånd, og beholdes da). En kilde uten rolle regnes som plan.
 */
const AUTO_ROLLER = ['plan', 'referanse'];

const SEKSJON_TVERRGAAENDE = {
  oid: 'tverrgaaende',
  tittel: 'Tverrgående (planposter i flere moduler)',
};
const SEKSJON_UKOBLET = { oid: 'ukoblet', tittel: 'Ikke koblet til en planpost' };

/**
 * Rekkefølgen på seksjonene: modulene slik konfigurasjonen har dem, så tverrgående, så de ukoblede.
 * @param {{ oid: string, tittel: string }[]} [moduler] standard: koPlan.moduler()
 */
function seksjoner(moduler = P.moduler()) {
  return [
    ...moduler.map((m) => ({ oid: m.oid, tittel: m.tittel })),
    SEKSJON_TVERRGAAENDE,
    SEKSJON_UKOBLET,
  ];
}

/** Stiene en oppføring gjelder: backtick-stiene først på linja, skilt med «·», «og» eller komma. */
function stierIOppforing(forsteLinje) {
  const m = /^- ((?:`[^`]+`)(?:\s*(?:·|og|,)\s*`[^`]+`)*)/.exec(forsteLinje);
  if (!m) return [];
  return [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
}

/**
 * Leser INDEKS: innledningen (alt før første oppføring eller seksjon) og oppføringene. Seksjonsoverskriftene og
 * planpost-linjene er generert og kastes. En annen linje i brødteksten (ikke innrykket, ikke «- », ikke «## ») er en
 * feil: den ville ellers forsvunne stille ved neste generering.
 * @param {string} tekst
 * @returns {{ innledning: string[], oppforinger: { stier: string[], linjer: string[] }[], feil: string[] }}
 */
function lesIndeks(tekst) {
  const linjer = tekst.replace(/\r\n/g, '\n').split('\n');
  const innledning = [];
  const oppforinger = [];
  const feil = [];
  let iBrodtekst = false;
  let naa = null;
  linjer.forEach((linje, i) => {
    const erOppforing = linje.startsWith('- ');
    const erSeksjon = linje.startsWith('## ');
    if (!iBrodtekst && !erOppforing && !erSeksjon) {
      innledning.push(linje);
      return;
    }
    iBrodtekst = true;
    if (erSeksjon || linje.trim() === '') {
      naa = null;
      return;
    }
    if (erOppforing) {
      const stier = stierIOppforing(linje);
      if (!stier.length)
        feil.push(`linje ${i + 1}: oppføringen starter ikke med en sti i backticks`);
      naa = { stier, linjer: [linje] };
      oppforinger.push(naa);
      return;
    }
    if (/^\s/.test(linje) && naa) {
      if (!linje.startsWith(PLANPOSTER_PREFIKS)) naa.linjer.push(linje);
      return;
    }
    feil.push(
      `linje ${i + 1}: ukjent linje i brødteksten (verken oppføring, innrykk eller seksjon)`,
    );
  });
  while (innledning.length && innledning[innledning.length - 1].trim() === '') innledning.pop();
  return { innledning, oppforinger, feil };
}

/** Gjelder en kildesti for en oppføringssti? Lik sti, eller under en mappe (oppføringsstien slutter på «/»). */
function stiTreffer(oppforingSti, kildeSti) {
  if (oppforingSti === kildeSti) return true;
  return oppforingSti.endsWith('/') && kildeSti.startsWith(oppforingSti);
}

/** Postene (aktive, ikke arkivet) som peker til en av stiene, sortert på id. */
function posterFor(stier, poster) {
  return poster
    .filter((p) => (p.kilder ?? []).some((k) => stier.some((s) => stiTreffer(s, k.sti))))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Seksjonen en oppføring havner i: ingen poster gir «ukoblet»; poster i minst TVERRGAAENDE_MODULER moduler gir
 * «tverrgående»; ellers modulen flest av postene hører til (likt antall: den første i modulrekkefølgen). En post
 * uten modul (prosjektet mangler `omrade`) telles som `uten-modul`.
 */
function seksjonFor(posterHer, prosjekter, moduler = P.moduler()) {
  if (!posterHer.length) return SEKSJON_UKOBLET.oid;
  const telling = new Map();
  for (const p of posterHer) {
    const oid = prosjekter?.[p.prosjekt]?.omrade ?? 'uten-modul';
    telling.set(oid, (telling.get(oid) ?? 0) + 1);
  }
  if (telling.size >= TVERRGAAENDE_MODULER) return SEKSJON_TVERRGAAENDE.oid;
  const rekkefolge = seksjoner(moduler).map((s) => s.oid);
  const plass = (oid) => (rekkefolge.includes(oid) ? rekkefolge.indexOf(oid) : rekkefolge.length);
  return [...telling.entries()].sort((a, b) => b[1] - a[1] || plass(a[0]) - plass(b[0]))[0][0];
}

/** Den genererte linja med planpostene, eller null når ingen post peker til dokumentet. */
function planposterLinje(stier, posterHer) {
  if (!posterHer.length) return null;
  if (posterHer.length > MAKS_POSTER_PAA_LINJA)
    return `${PLANPOSTER_PREFIKS}${posterHer.length} poster, se \`node scripts/orkestrator/ko.mjs plan vis --sok ${stier[0]}\`.`;
  return `${PLANPOSTER_PREFIKS}${posterHer.map((p) => `\`${p.id}\``).join(', ')}.`;
}

/**
 * Sporede dokumenter som en planpost peker til med en rolle i AUTO_ROLLER, men som mangler en oppføring: under en av
 * dokumentmappene og ikke indeksfila selv. Beskrivelsen hentes fra den første posten (lavest id) som peker til
 * dokumentet med en slik rolle. `finnes` sjekker at fila er der og er sporet (lag-indeks.mjs sorterer bort det git
 * ignorerer); døde stier meldes av `plan sjekk`, ikke her.
 * @param {{ mapper?: string[], indeks?: string|null }} [o] mapper: dokumentmappene (standard koPlan.dokumentMapper()),
 *   indeks: indeksfila (standard indeksFil())
 */
function nyeDokumenter(oppforinger, poster, finnes = () => true, o = {}) {
  const mapper = (o.mapper ?? P.dokumentMapper()).map((m) => `${String(m).replace(/\/+$/, '')}/`);
  const indeks = o.indeks !== undefined ? o.indeks : indeksFil();
  const kjent = (sti) => oppforinger.some((o) => o.stier.some((s) => stiTreffer(s, sti)));
  const nye = new Map();
  for (const p of [...poster].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const k of p.kilder ?? []) {
      const sti = k.sti;
      if (!AUTO_ROLLER.includes(k.rolle ?? 'plan')) continue;
      if (typeof sti !== 'string' || !mapper.some((m) => sti.startsWith(m))) continue;
      if (sti === indeks || nye.has(sti) || kjent(sti) || !finnes(sti)) continue;
      nye.set(sti, p);
    }
  }
  return [...nye.keys()].sort().map((sti) => {
    const forste = nye.get(sti);
    return {
      stier: [sti],
      linjer: [
        `- \`${sti}\`: ${forste.tittel} (beskrivelsen er hentet fra planposten; skriv en bedre ved behov).`,
      ],
      ny: true,
    };
  });
}

/**
 * Lager INDEKS på nytt.
 * @param {string} tekst dagens INDEKS
 * @param {{ poster?: object[] }} reg planregisteret
 * @param {{ prosjekter?: Record<string, { omrade?: string }> }} ko køen (prosjektene gir modulen)
 * @param {{ finnes?: (sti: string) => boolean, moduler?: object[], mapper?: string[], indeks?: string|null }} ctx
 *   moduler, mapper og indeks overstyrer konfigurasjonen (tester)
 * @returns {{ tekst: string, feil: string[], nye: string[], antall: Record<string, number> }}
 */
function lagIndeks(tekst, reg, ko, ctx = {}) {
  const lest = lesIndeks(tekst);
  const poster = reg?.poster ?? [];
  const prosjekter = ko?.prosjekter ?? {};
  const moduler = ctx.moduler ?? P.moduler();
  const nye = nyeDokumenter(lest.oppforinger, poster, ctx.finnes, ctx);
  const alle = [...lest.oppforinger, ...nye].map((o, nr) => {
    const posterHer = posterFor(o.stier, poster);
    return {
      ...o,
      nr,
      seksjon: seksjonFor(posterHer, prosjekter, moduler),
      planposter: planposterLinje(o.stier, posterHer),
    };
  });
  const noekkel = (o) => (o.stier[0] ?? '').toLowerCase();
  const ut = [...lest.innledning, ''];
  const antall = {};
  for (const s of seksjoner(moduler)) {
    const her = alle
      .filter((o) => o.seksjon === s.oid)
      .sort((a, b) => (noekkel(a) < noekkel(b) ? -1 : noekkel(a) > noekkel(b) ? 1 : a.nr - b.nr));
    if (!her.length) continue;
    antall[s.oid] = her.length;
    ut.push(`## ${s.tittel}`, '');
    for (const o of her) {
      ut.push(...o.linjer);
      if (o.planposter) ut.push(o.planposter);
    }
    ut.push('');
  }
  while (ut.length && ut[ut.length - 1] === '') ut.pop();
  return { tekst: `${ut.join('\n')}\n`, feil: lest.feil, nye: nye.map((o) => o.stier[0]), antall };
}

/** Første linje (1-basert) der to tekster er ulike, eller null når de er like (linjeskift normalisert). */
function forsteForskjell(a, b) {
  const la = a.replace(/\r\n/g, '\n').split('\n');
  const lb = b.replace(/\r\n/g, '\n').split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++)
    if (la[i] !== lb[i]) return { linje: i + 1, naa: la[i] ?? null, ny: lb[i] ?? null };
  return null;
}

module.exports = {
  PLANPOSTER_PREFIKS,
  MAKS_POSTER_PAA_LINJA,
  TVERRGAAENDE_MODULER,
  AUTO_ROLLER,
  INDEKS_STANDARD,
  indeksFil,
  get SEKSJONER() {
    return seksjoner();
  },
  seksjoner,
  stierIOppforing,
  lesIndeks,
  stiTreffer,
  posterFor,
  seksjonFor,
  planposterLinje,
  nyeDokumenter,
  lagIndeks,
  forsteForskjell,
};
