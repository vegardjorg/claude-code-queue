// =============================================================
// koKonfig.js: prosjektets innstillinger for køsystemet (ko.config.json i prosjektrota).
//
// Alt som er prosjektspesifikt (navnet på integrasjonsgrenen, kommandoene som er «gater», en valgfri
// migrasjonsflyt, modulene i planregisteret, arkitekturreglene som skal med i skyoppdrag osv.) står i
// ko.config.json, ikke i koden. Fila er valgfri: mangler den, gjelder STANDARD under. Feltene flettes
// rekursivt (objekter felt for felt, lister og tall erstattes helt).
//
// Prosjektrota finnes slik: to mapper over scripts/orkestrator/, og kjøres et skript fra et agent-worktree
// (<rot>/.claude/worktrees/<navn>/...), brukes hovedtreet. KO_ROT overstyrer (tester).
// KO_KONFIG overstyrer stien til fila (tester).
// =============================================================

const fs = require('node:fs');
const path = require('node:path');

/** Standardverdiene. Endre dem i ko.config.json, ikke her. */
const STANDARD = Object.freeze({
  // Prosjektets navn i tekster (oppdrag, agentmeldinger, tavla).
  prosjektNavn: 'prosjektet',
  // Integrasjonsgrenen: alt flettes hit, og det er denne som pushes i batch. Ofte main eller develop.
  baseGren: 'main',
  // Remote for push og for skyøkter (origin/<baseGren>).
  remote: 'origin',
  // Hvor køen, planregisteret og loggene ligger (relativt til prosjektrota, gitignorert).
  dataMappe: 'scripts/.ko',
  // Tidsloggen hook-tid.mjs skriver (forbruk per agent).
  tidslogg: 'scripts/.ko/tider.jsonl',
  // Grenprefiks for køoppgaver: <grenPrefiks><id>.
  grenPrefiks: 'ko/',
  // Mapper (relativt til rota) som lenkes inn i hvert agent-worktree i stedet for å installeres på nytt.
  delteLenker: ['node_modules'],
  // Gatene sporene kjører før levering (gater.mjs). Hver er en skallkommando; tom liste = ingen gate.
  gater: {
    rask: [],
    full: [],
  },
  // Valgfri migrasjonsflyt (f.eks. databasemigrasjoner som må nummereres og pushes etter fletting).
  // Med mappe = null er alt som har med migrasjoner å gjøre slått av (ingen nummerblokker, ingen push i flett).
  migrasjoner: {
    mappe: null, // f.eks. "db/migrations"
    filmonster: '^(\\d+)_.*\\.sql$', // første gruppe = nummeret
    blokkStorrelse: 10, // nummer per oppgave som rører migrasjoner
    pushKommando: null, // f.eks. "npm run db:migrate"; null = flett pusher aldri
    // Valgfri vakt: fila som sier hvilket miljø som er koblet til, og verdiene som er lov å pushe mot.
    miljoFil: null,
    tillatteMiljo: [],
  },
  // Arkitekturregler som skrives inn i skyoppdrag og oppdragsteksten (korte linjer, prosjektets egne).
  arkitekturRegler: [],
  // Planregisterets moduler (områder). Opprettes med `ko.mjs plan moduler`.
  moduler: [
    { oid: 'eksempel', tittel: 'Eksempel', beskrivelse: 'Eksempelmodul, gi den nytt navn eller slett den' },
    { oid: 'uten-modul', tittel: 'Uten fast modul', beskrivelse: 'Prosjekter som ikke hører til en modul ennå' },
  ],
  // Forslag til modul per prosjekt-id (brukes av `plan moduler --koble`).
  prosjektModulForslag: {},
  // Valgfri sti til et skript som tar backup av planregisteret (`ko.mjs plan backup`).
  planBackup: null,
  // Dokumentregisteret: valgfri liste over leverandører/underleverandører som sjekkes mot dokumentene.
  // Ett element i leverandorer: { id, navn, ord?, dokumenter?: (sti | { dok, seksjon?, hvor? })[] }. Tom = av.
  dokumenter: {
    leverandorer: [],
    secretsManifest: null, // fil som lister leverandørene som faktisk er i bruk; null = ingen filtrering
    leverandorBytter: [], // planlagte bytter: { ut, inn, planpost?, tekst? }
  },
  // Mappene planregisteret ser etter dokumenter i (uregistrerte dokumenter, lesevisningen, indeksen).
  dokumentMapper: ['docs'],
  // Dokumentindeksen lag-indeks.mjs vedlikeholder; null slår indeksen av.
  indeksFil: 'docs/INDEKS.md',
  // Prioritetsreglene i planregisteret. null = de generiske standardreglene (`ko.mjs plan regler`).
  prioritetsregler: null,
  // Reviewer-agentene som kjøres per klasse etter `ko.mjs motta`.
  reviewere: { K: [], U: [], D: ['reviewer'], 'D+': ['reviewer', 'reviewer-sikkerhet'] },
  // Lesevakten (hook-lesevakt.mjs): tillegg til de innebygde listene.
  lesevakt: {
    agentTyper: [], // flere agenttyper vakten gjelder for (spor, spor-d og reviewerne er med fra før)
    autoLastet: [], // filer Claude Code laster selv og som aldri skal leses med Read
    storeFiler: [], // glob-mønstre for filer som alltid skal leses i utdrag
    maksLinjer: 300,
    blokkLinjer: 2000,
  },
  // Grener som aldri regnes som køgrener (i tillegg til basegrenen).
  utelatGrener: ['main', 'master'],
  // Stier en skyøkt ikke ser (f.eks. gitignorerte mapper); oppdrag som viser dit, stoppes.
  skyUsynlig: [],
  // Ukekvoten (ko.mjs kapasitet): når den nullstilles, og abonnementets navn i teksten (null = «ukekvoten»).
  kapasitet: {
    nullstillDag: null, // 0-6 (0 = søndag)
    nullstillKlokke: null, // «TT:MM»
    tidssone: null, // IANA, f.eks. «Europe/Berlin»
    plannavn: null,
  },
  // Køtavla (ko-tavle.mjs).
  tavle: {
    port: 2000,
    tittel: 'Køtavla',
  },
});

function erObjekt(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Rekursiv fletting: objekter felt for felt, alt annet (lister, tall, tekst, null) erstattes. */
function flett(standard, egen) {
  if (!erObjekt(egen)) return egen === undefined ? standard : egen;
  const ut = { ...standard };
  for (const [k, v] of Object.entries(egen)) {
    if (k.startsWith('$') || k.startsWith('_')) continue; // $schema, _kommentar
    ut[k] = erObjekt(standard?.[k]) && erObjekt(v) ? flett(standard[k], v) : v;
  }
  return ut;
}

/** Prosjektrota: to mapper over scripts/orkestrator/, eller hovedtreet når vi står i et agent-worktree. */
function finnRot() {
  if (process.env.KO_ROT) return path.resolve(process.env.KO_ROT);
  const rot = path.resolve(__dirname, '..', '..', '..');
  return rot.split(`${path.sep}.claude${path.sep}worktrees${path.sep}`)[0];
}

let buffer = null;

/**
 * Leser ko.config.json (én gang per prosess) og fletter med STANDARD.
 * @param {{ rot?: string, frisk?: boolean }} [o]
 */
function konfig(o = {}) {
  if (buffer && !o.frisk && !o.rot) return buffer;
  const rot = o.rot ?? finnRot();
  const fil = process.env.KO_KONFIG ?? path.join(rot, 'ko.config.json');
  let egen = {};
  try {
    egen = JSON.parse(fs.readFileSync(fil, 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      process.stderr.write(`ADVARSEL: kunne ikke lese ${fil} (${e?.message}); bruker standardverdiene.\n`);
    }
  }
  const k = flett(STANDARD, egen);
  k.rot = rot;
  if (!o.rot) buffer = k;
  return k;
}

/** Absolutt sti til datamappa (KO_MAPPE overstyrer). */
function dataMappe() {
  return process.env.KO_MAPPE ?? path.join(konfig().rot, konfig().dataMappe);
}

/** Absolutt sti til tidsloggen (KO_TIDSLOGG overstyrer). */
function tidslogg() {
  return process.env.KO_TIDSLOGG ?? path.join(konfig().rot, konfig().tidslogg);
}

module.exports = { STANDARD, flett, finnRot, konfig, dataMappe, tidslogg };
