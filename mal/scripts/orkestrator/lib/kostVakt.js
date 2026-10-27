// =============================================================
// kostVakt.js: terskellogikken for kostvakten. Se docs/orchestration.md.
//
// Når forbruket til et spor som kjører passerer FAKTOR (3) × snittkosten for klassen (ferdige oppgaver med målt kost
// de siste 7 dagene, samme tall som `ko.mjs kost --siden 7d`), skal orkestratoren varsles, og sporet få en kort
// beskjed om å runde av eller levere DELVIS. Ingen automatisk stopp.
//
// Målingen er den samme som `ko.mjs sett <id> ferdig` og `kost maal`: usage fra agenttranskriptene, prist med
// tidKost.kostUsd og summert med koLogikk.summerKost. Forskjellen er at agenter som fortsatt kjører, ikke har
// noen «ferdig»-rad i tidsloggen ennå (start-raden har agent-id-en som spor-etikett), så `liveAgenter` tar med
// start-radene som kandidater; kalleren (hook-kontekst.mjs) beholder en usikker kandidat bare når oppdraget i
// transkriptet nevner oppgave-id-en (koLogikk.nevnerOppgave), som i ko.mjs.
//
// Ren logikk (ingen fil-I/O), testet i lib/__tests__/kostVakt.test.ts.
// =============================================================
const TK = require('./tidKost.js');

// Faktoren er 3, ikke 2: med 2x blir mange spor avrundet med lite arbeid igjen; formålet er å fange en løpsk økt.
// Hvert varsel logges i <datamappe>/kostvakt-logg.jsonl (kostvakt-statistikk.mjs), så terskelen kan kalibreres på
// data.
const FAKTOR = 3;
/** Minste antall ferdige oppgaver i klassen før snittet brukes som terskel (ett utfall er ikke et snitt). */
const MIN_N = 3;
/** Hvor ofte hooken måler (transkriptlesing er dyrt); KOSTVAKT_INTERVALL_MIN overstyrer. */
const INTERVALL_MS = 10 * 60_000;
const SIDEN_MS = 7 * 86_400_000;
const KLASSER = ['K', 'D', 'D+', 'U'];
/** Agenttypene som jobber på en oppgave: spor, spor-d og reviewerne i konfig().reviewere (koLogikk). */
const oppgaveAgenttyper = () => require('./koLogikk.js').OPPGAVE_AGENTTYPER;

const rund2 = (x) => Math.round(x * 100) / 100;

/**
 * Klassen fra oppdragsfila: tabellraden «| Klasse | K (vekt 1,0) …» (lag-oppdrag-formatet), ellers «klasse D+» i
 * tittel-linja («SPOR X (…; klasse K, anslag 60 min)»). null når ingen gjenkjennes.
 */
function klasseFraOppdrag(tekst) {
  const s = String(tekst ?? '');
  const tabell = s.match(/^\|\s*Klasse\s*\|\s*(D\+|[KDU])(?![A-Za-z0-9+])/m);
  if (tabell) return tabell[1];
  const fri = s.match(/\bklasse\s+(D\+|[KDU])(?![A-Za-z0-9+])/i);
  return fri ? fri[1].toUpperCase() : null;
}

/**
 * Snittkost per klasse fra koLogikk.kostStatistikk (perKlasse har n og sum usd).
 * @returns {Record<string, { snitt: number, n: number }>}
 */
function snittPerKlasse(stat) {
  const ut = {};
  for (const k of stat?.perKlasse ?? []) {
    if (!k.n) continue;
    ut[k.klasse] = { snitt: rund2(Number(k.usd) / k.n), n: k.n };
  }
  return ut;
}

/**
 * Agentene som kan høre til en oppgave som kjører, fra tidsloggen. `sikker`: en rad har spor-etiketten til oppgaven
 * (eller en retterunde, tidKost.oppgaveIdFor). Ellers kandidat når typen er en oppgaveagent, etiketten er ukjent
 * (agent-id-en) og agenten startet etter `fra`. `rad` er den siste «ferdig»-raden med tokens (reserve når
 * transkriptet mangler), eller null.
 * @returns {{ agent: string, type: string, sikker: boolean, rad: object|null }[]}
 */
function liveAgenter(rader, id, { fra = null } = {}) {
  const info = new Map();
  for (const r of rader ?? []) {
    if (!r?.agent_id) continue;
    const t = Date.parse(r.tid);
    const a = info.get(r.agent_id) ?? { forste: t, type: null, spor: new Set(), rad: null };
    if (t < a.forste) a.forste = t;
    if (r.agent_type) a.type = r.agent_type;
    if (r.spor) a.spor.add(r.spor);
    if (r.hendelse === 'ferdig' && r.tokens && (!a.rad || t >= Date.parse(a.rad.tid))) a.rad = r;
    info.set(r.agent_id, a);
  }
  const erId = (s) => s === id;
  const ut = [];
  for (const [agent, a] of info) {
    const type = a.type ?? 'ukjent';
    const etiketter = [...a.spor];
    if (etiketter.some((s) => TK.oppgaveIdFor(s, erId) === id)) {
      ut.push({ agent, type, sikker: true, rad: a.rad });
      continue;
    }
    // En annen gjenkjent etikett (ikke agent-id-en) betyr en annen oppgave.
    if (etiketter.some((s) => !agent.startsWith(s))) continue;
    if (!oppgaveAgenttyper().includes(type)) continue;
    if (fra && a.forste < Date.parse(fra)) continue;
    ut.push({ agent, type, sikker: false, rad: a.rad });
  }
  return ut;
}

/** Skal hooken måle nå? Første gang, eller når intervallet er gått siden forrige måling. */
function skalMaale(tilstand, naa, intervallMs = INTERVALL_MS) {
  const sist = Date.parse(tilstand?.sist_maalt ?? '');
  return Number.isNaN(sist) || naa - sist >= intervallMs;
}

/**
 * Terskellogikken. `maalinger`: [{ id, klasse, usd }] for oppgaver som kjører. `snitt`: snittPerKlasse. Et spor varsles
 * én gang (lagret i `varslet`) når usd > faktor × snitt for klassen og klassen har minst minN ferdige oppgaver.
 * Oppgaver som ikke lenger kjører, fjernes fra `varslet`, så en ny kjøring (retterunde) kan varsles igjen.
 * @returns {{ varsler: { id: string, klasse: string, usd: number, snitt: number, grense: number, n: number }[],
 *   varslet: Record<string, { usd: number, tid: string }> }}
 */
function vurder({
  maalinger,
  snitt,
  varslet = {},
  faktor = FAKTOR,
  minN = MIN_N,
  naa = Date.now(),
}) {
  const aktive = new Set((maalinger ?? []).map((m) => m.id));
  const nyVarslet = Object.fromEntries(
    Object.entries(varslet ?? {}).filter(([id]) => aktive.has(id)),
  );
  const varsler = [];
  for (const m of maalinger ?? []) {
    const s = snitt?.[m.klasse];
    if (!s || s.n < minN || !(s.snitt > 0)) continue;
    const grense = rund2(faktor * s.snitt);
    if (!(Number(m.usd) > grense) || nyVarslet[m.id]) continue;
    varsler.push({
      id: m.id,
      klasse: m.klasse,
      usd: rund2(Number(m.usd)),
      snitt: s.snitt,
      grense,
      n: s.n,
    });
    nyVarslet[m.id] = { usd: rund2(Number(m.usd)), tid: new Date(naa).toISOString() };
  }
  return { varsler, varslet: nyVarslet };
}

/** Den korte beskjeden orkestratoren sender videre til sporet (SendMessage). */
function sporBeskjed(v) {
  return (
    `KOSTVAKT ${v.id}: forbruket er $${v.usd}, over ${FAKTOR}x snittet for klasse ${v.klasse} ($${v.snitt}). ` +
    'Rund av: gjør ferdig det du holder på med, commit, og lever. Er oppgaven ikke ferdig, lever DELVIS med ' +
    'det som gjenstår i rapporten. Ikke start nye deler.'
  );
}

/** Hook-utdata (systemMessage til eieren, additionalContext til orkestratoren), eller null uten varsler. */
function hookTekst(varsler) {
  if (!varsler?.length) return null;
  const linjer = varsler.map(
    (v) =>
      `${v.id} (${v.klasse}) $${v.usd} > ${FAKTOR}x snitt $${v.snitt} (grense $${v.grense}, n=${v.n} siste 7d)`,
  );
  return {
    systemMessage: `Kostvakt: ${linjer.join('; ')}.`,
    additionalContext:
      `[kostvakt] ${varsler.length} spor har passert ${FAKTOR}x snittkosten for klassen: ${linjer.join('; ')}. ` +
      'Ingen automatisk stopp. Send hvert spor denne beskjeden med SendMessage (agent-id fra start/tidsloggen): ' +
      varsler.map((v) => `«${sporBeskjed(v)}»`).join(' ') +
      ' Vurder selv om sporet bør stoppes eller deles.',
  };
}

module.exports = {
  FAKTOR,
  MIN_N,
  INTERVALL_MS,
  SIDEN_MS,
  KLASSER,
  klasseFraOppdrag,
  snittPerKlasse,
  liveAgenter,
  skalMaale,
  vurder,
  sporBeskjed,
  hookTekst,
};
