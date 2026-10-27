// =============================================================
// tidKost.js: riktig måling av agentforbruk. Se docs/orchestration.md.
//
// Ren logikk, ingen I/O. Brukes av:
//   hook-tid.mjs   analyserTranskript(): tallene i «ferdig»-raden per agent
//   logg-tid.mjs   --vis (deduplisert) og --kost [--dag]: forbruk per agenttype og totalt
//   ko.mjs         dagsforbruk() til budsjettvakten i `neste`
// Testet i lib/__tests__/tidKost.test.ts.
//
// HVORFOR DEDUPLISERING: hook-tid skriver en «ferdig»-rad hver gang en agent stopper, og radene er KUMULATIVE (hele
// transkriptet analyseres på nytt). En agent som gjenopptas med SendMessage, får derfor flere rader, og en naiv sum
// teller samme forbruk flere ganger (godt over det dobbelte i praksis).
// Her gir hver rad bare TILVEKSTEN siden forrige rad for samme agent, så summen over alle rader = siste rad per agent,
// og forbruket fordeles riktig på døgn når en agent går over midnatt.
//
// ENHET: «API-ekvivalente USD» med listeprisene i PRISER: claude-opus-5-5 input $4, output $20, cache-lesing $0,20,
// cache-skriving 5 min $5 og 1 t $8 per MTok. Abonnementskvoten er ikke i dollar, men vektes etter samme mønster, så
// andelene og trendene er det som teller.
// =============================================================
'use strict';

/** USD per million tokens. Ukjente modeller prises som STANDARD_MODELL og merkes «antatt». */
const PRISER = {
  'claude-opus-5-5': { input: 4, output: 20, cache_lest: 0.2, cache_5m: 5, cache_1t: 8 },
};
const STANDARD_MODELL = 'claude-opus-5-5';

/** Tidssonen «dag» regnes i (lokal dag). */
const TZ = 'Europe/Oslo';

/** Cachens levetid per type (s). Pause lengre enn dette før en tur = cachen gikk ut og ble skrevet på nytt. */
const CACHE_TTL_S = { '5m': 300, '1t': 3600 };

/**
 * Pris for et sett tokens. Eldre rader har bare `cache_skrevet` (summen): subagenter har 5 minutters cache
 * (utredningen § 2.1), så summen prises da som 5 min. Nyere rader har `cache_skrevet_5m` og `cache_skrevet_1t`.
 * @returns {number} USD
 */
function kostUsd(tokens, modell) {
  if (!tokens) return 0;
  const p = PRISER[modell] ?? PRISER[STANDARD_MODELL];
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  let s5 = tokens.cache_skrevet_5m;
  let s1 = tokens.cache_skrevet_1t;
  if (s5 == null && s1 == null) {
    s5 = n(tokens.cache_skrevet);
    s1 = 0;
  } else {
    s5 = n(s5);
    s1 = n(s1);
    // Skriving som ikke er fordelt på type (eldre API-svar), regnes som 5 min.
    const udelt = n(tokens.cache_skrevet) - s5 - s1;
    if (udelt > 0) s5 += udelt;
  }
  return (
    (n(tokens.input) * p.input +
      n(tokens.output) * p.output +
      n(tokens.cache_lest) * p.cache_lest +
      s5 * p.cache_5m +
      s1 * p.cache_1t) /
    1e6
  );
}

/**
 * Spor-id fra agentens oppdrag (første brukermeldinger i transkriptet): `prompt-<ID>.md` eller «spor <ID>»/«SPOR <ID>».
 * Id-ene i køen kan ha bindestrek og punktum og starte med bokstav (A-1, alfa-2b); en regex som bare tar
 * [A-Za-z0-9]+ eller «SPOR <siffer…>» ville logget slike spor med agent-id-en i stedet.
 * @returns {string|null}
 */
function sporFraTekst(tekst) {
  const t = String(tekst ?? '');
  const rens = (s) => s.replace(/[._-]+$/, '');
  const fil = t.match(/prompt-([A-Za-z0-9][A-Za-z0-9._-]*?)\.md\b/);
  if (fil) return rens(fil[1]);
  // Reviewerens oppdrag er «Les <scratchpad>\rev-<ID>\reviewer-<type>.md …» (ko.mjs motta). Uten denne regelen
  // blir reviewerne logget med agent-id-en, og review-kosten og FUNN-linjene mangler.
  const rev = t.match(/(?:^|[\\/\s])rev-([A-Za-z0-9][A-Za-z0-9._-]*?)[\\/]+reviewer-/);
  if (rev) return rens(rev[1]);
  const ord = t.match(/\b(?:SPOR|[Ss]por)\s+([A-Z0-9][A-Za-z0-9._-]{1,40})/);
  if (ord) return rens(ord[1]);
  return null;
}

/**
 * Byggeagentene (agentene som gjør selve sporet): `spor` for K og U, `spor-d` for D og D+ (koLogikk.agentTypeFor).
 * Et rollekart som bare kjenner `spor`, mister fasefordelingen for D og D+.
 */
const BYGGEAGENT_TYPER = ['spor', 'spor-d'];
const erByggeagent = (type) => BYGGEAGENT_TYPER.includes(type);

/**
 * Regner ut forbruk fra et agenttranskript (JSONL). Strømmede meldinger kan stå over flere linjer med samme
 * message.id; de telles én gang (siste usage vinner, første tidsstempel gir turens tid).
 */
function analyserTranskript(tekst) {
  const turer = new Map(); // message.id -> { usage, ts, modell }
  const verktoy = new Set();
  let forste = null;
  let siste = null;
  let forsteEndring = null;
  let kallForEndring = 0;
  let sporFraOppdrag = null;
  for (const linje of String(tekst).split('\n')) {
    if (!linje.trim()) continue;
    let r;
    try {
      r = JSON.parse(linje);
    } catch {
      continue;
    }
    const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (forste === null) forste = ts;
      siste = ts;
    }
    const m = r.message;
    if (!m) continue;
    const innhold = Array.isArray(m.content) ? m.content : [];
    if (r.type === 'user' && !sporFraOppdrag) {
      const tekstbiter =
        typeof m.content === 'string' ? m.content : innhold.map((c) => c?.text ?? '').join(' ');
      sporFraOppdrag = sporFraTekst(tekstbiter);
    }
    if (r.type !== 'assistant') continue;
    if (m.id && m.usage) {
      const tidligere = turer.get(m.id);
      turer.set(m.id, {
        usage: m.usage,
        ts: tidligere?.ts ?? (Number.isNaN(ts) ? null : ts),
        modell: m.model ?? tidligere?.modell ?? null,
      });
    }
    for (const c of innhold) {
      if (c?.type !== 'tool_use' || !c.id || verktoy.has(c.id)) continue;
      verktoy.add(c.id);
      if (forsteEndring === null) {
        if (['Edit', 'Write', 'NotebookEdit'].includes(c.name)) forsteEndring = ts;
        else kallForEndring++;
      }
    }
  }
  const tokens = {
    input: 0,
    output: 0,
    cache_lest: 0,
    cache_skrevet: 0,
    cache_skrevet_5m: 0,
    cache_skrevet_1t: 0,
  };
  const kontekst = [];
  const modeller = new Map();
  let cacheUtlop = 0;
  let forrigeTs = null;
  for (const { usage: u, ts, modell } of turer.values()) {
    const skrevet = u.cache_creation_input_tokens ?? 0;
    const lest = u.cache_read_input_tokens ?? 0;
    const fem = u.cache_creation?.ephemeral_5m_input_tokens;
    const time = u.cache_creation?.ephemeral_1h_input_tokens;
    tokens.input += u.input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
    tokens.cache_lest += lest;
    tokens.cache_skrevet += skrevet;
    // Uten fordeling (eldre API-svar) regnes skrivingen som 5 min, som for subagenter.
    tokens.cache_skrevet_5m += fem ?? (time == null ? skrevet : 0);
    tokens.cache_skrevet_1t += time ?? 0;
    kontekst.push((u.input_tokens ?? 0) + lest + skrevet);
    if (modell) modeller.set(modell, (modeller.get(modell) ?? 0) + 1);
    // Cache-utløp: turen kom etter en pause lengre enn cachens levetid og skrev mer enn den leste (hele konteksten
    // ble skrevet på nytt). Utredningen § 2.1: ca. $2,25 per utløp for en agent på 450k, mot $0,09 for en vanlig tur.
    const ttl = (time ?? 0) > 0 ? CACHE_TTL_S['1t'] : CACHE_TTL_S['5m'];
    if (ts !== null && forrigeTs !== null && ts - forrigeTs > ttl * 1000 && skrevet > lest)
      cacheUtlop++;
    if (ts !== null) forrigeTs = ts;
  }
  const sortert = [...kontekst].sort((x, y) => x - y);
  const modell = [...modeller.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    varighet_s: forste !== null && siste !== null ? Math.round((siste - forste) / 1000) : null,
    verktoykall: verktoy.size,
    modellturer: turer.size,
    tokens,
    modell,
    cache_utlop: cacheUtlop,
    kost_usd: Math.round(kostUsd(tokens, modell) * 100) / 100,
    kontekst: kontekst.length
      ? {
          start: kontekst[0],
          median: sortert[Math.floor(sortert.length / 2)],
          slutt: kontekst[kontekst.length - 1],
        }
      : null,
    forste_endring_s:
      forsteEndring !== null && forste !== null
        ? Math.round((forsteEndring - forste) / 1000)
        : null,
    kall_for_forste_endring: forsteEndring !== null ? kallForEndring : null,
    spor: sporFraOppdrag,
  };
}

/** Datoen (YYYY-MM-DD) et ISO-tidsstempel har i tidssonen `tz`. */
function dagFor(iso, tz = TZ) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA formaterer datoer som YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Leser JSONL-tekst til rader; ødelagte linjer hoppes over (fila skrives av flere prosesser). */
function lesRader(tekst) {
  const ut = [];
  for (const l of String(tekst ?? '').split('\n')) {
    if (!l.trim()) continue;
    try {
      ut.push(JSON.parse(l));
    } catch {
      /* halv linje fra en samtidig skriver */
    }
  }
  return ut;
}

/** Nøkkelen en forbruksrad dedupliseres på: agent_id, ellers spor + tid (eldre manuelle rader). */
const agentNokkel = (r) => r.agent_id ?? `${r.spor ?? '?'}|${r.tid}`;

/**
 * Forbruket fordelt på hendelser: én per «ferdig»-rad med tokens, med TILVEKSTEN siden forrige rad for samme agent
 * (radene er kumulative). Summen over alle hendelser = siste rad per agent.
 * `tokens` er tilveksten i rå tokens (input, output, cache_lest, cache_skrevet) på samme måte, til
 * ukekvotemodellen i lib/koKapasitet.js.
 * @returns {{ agent: string, type: string, spor: string, tid: string, dag: string, usd: number, turer: number,
 *   cache_utlop: number, antatt: boolean, tokens: { input: number, output: number, cache_lest: number,
 *   cache_skrevet: number } }[]}
 */
function forbruksHendelser(rader, tz = TZ) {
  const perAgent = new Map();
  for (const r of rader) {
    if (r?.hendelse !== 'ferdig' || !r.tokens) continue;
    const k = agentNokkel(r);
    if (!perAgent.has(k)) perAgent.set(k, []);
    perAgent.get(k).push(r);
  }
  const ut = [];
  for (const [agent, liste] of perAgent) {
    liste.sort((a, b) => Date.parse(a.tid) - Date.parse(b.tid));
    let forrige = { usd: 0, turer: 0, utlop: 0 };
    const forrigeTok = { input: 0, output: 0, cache_lest: 0, cache_skrevet: 0 };
    for (const r of liste) {
      const tilvekst = {};
      for (const k of Object.keys(forrigeTok)) {
        const v = Number(r.tokens?.[k] ?? 0) || 0;
        tilvekst[k] = Math.max(0, v - forrigeTok[k]);
        forrigeTok[k] = Math.max(forrigeTok[k], v);
      }
      const naa = {
        usd: kostUsd(r.tokens, r.modell),
        turer: Number(r.modellturer ?? 0),
        utlop: Number(r.cache_utlop ?? 0),
      };
      ut.push({
        agent,
        type: r.agent_type ?? 'ukjent',
        spor: r.spor ?? agent,
        tid: r.tid,
        dag: dagFor(r.tid, tz),
        usd: Math.max(0, naa.usd - forrige.usd),
        turer: Math.max(0, naa.turer - forrige.turer),
        cache_utlop: Math.max(0, naa.utlop - forrige.utlop),
        antatt: !!r.modell && !PRISER[r.modell],
        tokens: tilvekst,
      });
      // En rad uten full analyse (for stort transkript) kan være lavere enn forrige: behold det høyeste.
      forrige = {
        usd: Math.max(forrige.usd, naa.usd),
        turer: Math.max(forrige.turer, naa.turer),
        utlop: Math.max(forrige.utlop, naa.utlop),
      };
    }
  }
  return ut;
}

/** Dagens (eller en gitt dags) forbruk i USD, alle agenttyper. Til budsjettvakten i ko.mjs. */
function dagsforbruk(rader, dag, tz = TZ) {
  return forbruksHendelser(rader, tz)
    .filter((h) => h.dag === dag)
    .reduce((s, h) => s + h.usd, 0);
}

/**
 * Oppsummering for `logg-tid.mjs --kost`: totalt, per agenttype, per spor og (med køen) per risikoklasse.
 * @param {object[]} rader
 * @param {{ dag?: string|null, tz?: string, klasseFor?: (spor: string) => string|null }} [valg]
 */
function oppsummerKost(rader, { dag = null, tz = TZ, klasseFor = () => null } = {}) {
  const hendelser = forbruksHendelser(rader, tz).filter((h) => !dag || h.dag === dag);
  const perType = new Map();
  const perSpor = new Map();
  const perKlasse = new Map();
  let total = 0;
  let antatt = false;
  for (const h of hendelser) {
    total += h.usd;
    antatt ||= h.antatt;
    const t = perType.get(h.type) ?? { usd: 0, agenter: new Set(), cache_utlop: 0 };
    t.usd += h.usd;
    t.agenter.add(h.agent);
    t.cache_utlop += h.cache_utlop;
    perType.set(h.type, t);
    const s = perSpor.get(h.spor) ?? { usd: 0, typer: new Set(), cache_utlop: 0, turer: 0 };
    s.usd += h.usd;
    s.typer.add(h.type);
    s.cache_utlop += h.cache_utlop;
    s.turer += h.turer;
    perSpor.set(h.spor, s);
    const klasse = klasseFor(h.spor) ?? 'ukjent';
    perKlasse.set(klasse, (perKlasse.get(klasse) ?? 0) + h.usd);
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    dag,
    total: r2(total),
    antatt,
    perType: [...perType.entries()]
      .map(([type, t]) => ({
        type,
        usd: r2(t.usd),
        agenter: t.agenter.size,
        cache_utlop: t.cache_utlop,
        andel: total > 0 ? Math.round((t.usd / total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.usd - a.usd),
    perSpor: [...perSpor.entries()]
      .map(([spor, s]) => ({
        spor,
        usd: r2(s.usd),
        typer: [...s.typer].sort(),
        cache_utlop: s.cache_utlop,
        turer: s.turer,
      }))
      .sort((a, b) => b.usd - a.usd),
    perKlasse: [...perKlasse.entries()]
      .map(([klasse, usd]) => ({ klasse, usd: r2(usd) }))
      .sort((a, b) => b.usd - a.usd),
  };
}

/**
 * Radene for `logg-tid.mjs --vis`: alle rader, men for hver agent bare den SISTE «ferdig»-raden (de er kumulative).
 * Rekkefølgen beholdes.
 */
function dedupliserFerdig(rader) {
  const siste = new Map();
  rader.forEach((r, i) => {
    if (r?.hendelse === 'ferdig' && r.agent_id) siste.set(r.agent_id, i);
  });
  return rader.filter(
    (r, i) => !(r?.hendelse === 'ferdig' && r.agent_id && siste.get(r.agent_id) !== i),
  );
}

/**
 * Køens oppgave-id for en spor-etikett fra tidsloggen. Retterunder startes som egne agenter med etiketter som
 * «A-1-r2» eller «B-2-runde2»; de hører til oppgaven A-1 / B-2.
 */
function oppgaveIdFor(spor, finnes) {
  if (finnes(spor)) return spor;
  const uten = String(spor).replace(/-(?:r|runde)\d+$/i, '');
  return uten !== spor && finnes(uten) ? uten : null;
}

/**
 * tidspunktet den FØRSTE revieweren for oppgaven `id` startet, fra tidsloggens rader (hook-tid skriver en
 * «start»-rad per agent). En agent hører til oppgaven når en av radene har spor-etiketten `id` eller en retterunde av
 * den (oppgaveIdFor); start-raden kan mangle etiketten når transkriptet ikke var skrevet ennå, så agentens tidligste
 * rad gjelder. Bare agenter av `typer` (reviewertypene) og bare starter på eller etter `fra` (t_motta) telles.
 * @param {object[]} rader
 * @param {string} id
 * @param {{ typer: string[], fra?: string|null }} valg
 * @returns {string|null} ISO-tid
 */
function forsteReviewStart(rader, id, { typer, fra = null }) {
  const erId = (s) => s === id;
  const tilhorer = new Set();
  const forste = new Map();
  const type = new Map();
  for (const r of rader ?? []) {
    if (!r?.agent_id) continue;
    if (r.agent_type) type.set(r.agent_id, r.agent_type);
    if (r.spor && oppgaveIdFor(r.spor, erId) === id) tilhorer.add(r.agent_id);
    const t = Date.parse(r.tid);
    if (Number.isNaN(t)) continue;
    const f = forste.get(r.agent_id);
    if (f == null || t < f) forste.set(r.agent_id, t);
  }
  const grense = fra ? Date.parse(fra) : NaN;
  let best = null;
  for (const agent of tilhorer) {
    if (!typer.includes(type.get(agent))) continue;
    const t = forste.get(agent);
    if (t == null || (!Number.isNaN(grense) && t < grense)) continue;
    if (best == null || t < best) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}

/**
 * endrede kodelinjer (innsatte + slettede) fra `git diff --shortstat`, f.eks.
 * « 3 files changed, 120 insertions(+), 4 deletions(-)» → 124. Tom diff gir 0; ugjenkjennelig tekst eller null gir null.
 * @returns {number|null}
 */
function diffLinjerFraShortstat(tekst) {
  if (tekst == null) return null;
  const t = String(tekst).trim();
  if (!t) return 0;
  if (!/\bfiles? changed\b/.test(t)) return null;
  const inn = t.match(/(\d+) insertions?\(\+\)/);
  const ut = t.match(/(\d+) deletions?\(-\)/);
  return (inn ? Number(inn[1]) : 0) + (ut ? Number(ut[1]) : 0);
}

module.exports = {
  PRISER,
  STANDARD_MODELL,
  TZ,
  kostUsd,
  sporFraTekst,
  analyserTranskript,
  dagFor,
  lesRader,
  forbruksHendelser,
  dagsforbruk,
  oppsummerKost,
  dedupliserFerdig,
  oppgaveIdFor,
  BYGGEAGENT_TYPER,
  erByggeagent,
  forsteReviewStart,
  diffLinjerFraShortstat,
};
