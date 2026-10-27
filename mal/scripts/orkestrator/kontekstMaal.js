// =============================================================
// kontekstMaal.js: ren beregning for kontekst-maal.mjs.
//
// Hvorfor: ca. 70 % av sporkostnaden er cache-lesing, og den er omtrent turer × kontekst. For å se om tiltak som
// slankere felles protokoll virker, trengs et fast mål: median og p90 kontekst, kall før første endring og turer,
// per agenttype og risikoklasse, over et tidsvindu.
//
// Inndata er radene fra tidsloggen (konfig().tidslogg; hook-tid skriver én KUMULATIV «ferdig»-rad per stopp, så bare
// den SISTE per agent teller) og en valgfri klasse-oppslagsfunksjon (fra køen). Ingen I/O her; testen ligger i
// __tests__/kontekstMaal.test.ts.
// =============================================================

/**
 * Kvantil med lineær interpolasjon (q = 0.5 gir median, 0.9 gir p90). Tom liste gir null.
 * @param {number[]} tall
 * @param {number} q
 */
function kvantil(tall, q) {
  const s = tall.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lav = Math.floor(pos);
  const hoy = Math.ceil(pos);
  return s[lav] + (s[hoy] - s[lav]) * (pos - lav);
}

/**
 * Siste «ferdig»-rad per agent_id med tid i [fra, til). Rader uten agent_id eller uten kontekst-måling hoppes over
 * (eldre manuelle rader og agenter der hooken ikke fikk lest transkriptet).
 * @param {object[]} rader
 * @param {{ fra?: number|null, til?: number|null }} [vindu] millisekunder (Date.parse)
 */
function sisteFerdigPerAgent(rader, { fra = null, til = null } = {}) {
  const siste = new Map();
  for (const r of rader) {
    if (!r || r.hendelse !== 'ferdig' || !r.agent_id) continue;
    const t = Date.parse(r.tid);
    if (!Number.isFinite(t)) continue;
    if (fra != null && t < fra) continue;
    if (til != null && t >= til) continue;
    const f = siste.get(r.agent_id);
    if (!f || Date.parse(f.tid) <= t) siste.set(r.agent_id, r);
  }
  return [...siste.values()].filter((r) => r.kontekst && typeof r.kontekst.median === 'number');
}

const avrund = (x, n = 0) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);

/**
 * Nøkkeltallene for én gruppe agenter.
 * @param {object[]} liste ferdig-rader
 */
function nokkeltall(liste) {
  const kontekst = liste.map((r) => r.kontekst.median);
  const start = liste.map((r) => r.kontekst.start);
  const slutt = liste.map((r) => r.kontekst.slutt);
  const kall = liste.map((r) => r.kall_for_forste_endring).filter((x) => typeof x === 'number');
  const turer = liste.map((r) => Number(r.modellturer)).filter((x) => Number.isFinite(x));
  const kost = liste.map((r) => Number(r.kost_usd)).filter((x) => Number.isFinite(x));
  const sum = kost.reduce((a, b) => a + b, 0);
  return {
    antall: liste.length,
    kontekst_median: avrund(kvantil(kontekst, 0.5)),
    kontekst_p90: avrund(kvantil(kontekst, 0.9)),
    kontekst_start_median: avrund(kvantil(start, 0.5)),
    kontekst_slutt_median: avrund(kvantil(slutt, 0.5)),
    kall_for_forste_endring_median: avrund(kvantil(kall, 0.5), 1),
    kall_for_forste_endring_antall: kall.length,
    turer_median: avrund(kvantil(turer, 0.5), 1),
    kost_sum: avrund(sum, 2),
    kost_snitt: kost.length ? avrund(sum / kost.length, 2) : null,
  };
}

/**
 * Hele målingen: per agenttype og klasse, sortert etter kostsum (dyrest først), pluss totalen.
 * @param {object[]} rader
 * @param {{ fra?: number|null, til?: number|null, klasseFor?: (rad: any) => string|null }} [valg]
 */
function maalKontekst(rader, { fra = null, til = null, klasseFor = () => null } = {}) {
  const ferdig = sisteFerdigPerAgent(rader, { fra, til });
  const grupper = new Map();
  for (const r of ferdig) {
    const type = r.agent_type || '(ingen type)';
    const klasse = klasseFor(r) ?? 'ukjent';
    const k = `${type}|${klasse}`;
    if (!grupper.has(k)) grupper.set(k, { agenttype: type, klasse, rader: [] });
    grupper.get(k).rader.push(r);
  }
  const ut = [...grupper.values()]
    .map((g) => ({ agenttype: g.agenttype, klasse: g.klasse, ...nokkeltall(g.rader) }))
    .sort((a, b) => b.kost_sum - a.kost_sum || a.agenttype.localeCompare(b.agenttype));
  return {
    fra: fra != null ? new Date(fra).toISOString() : null,
    til: til != null ? new Date(til).toISOString() : null,
    total: nokkeltall(ferdig),
    grupper: ut,
  };
}

/**
 * Klasse-oppslag fra køen: oppgave-id (også retterunder som «X-r2») og agent-id-ene i oppgavens kostmåling
 * (reviewerne logges med agent-id som spor-etikett).
 * @param {{ oppgaver?: object[] }} ko
 * @returns {(rad: object) => string|null}
 */
function klasseOppslag(ko) {
  const perId = new Map();
  const perAgent = new Map();
  for (const o of ko?.oppgaver ?? []) {
    if (!o?.id || !o.klasse) continue;
    perId.set(o.id, o.klasse);
    if (typeof o.agent === 'string' && o.agent) perAgent.set(o.agent, o.klasse);
    for (const a of o.kost?.agenter ?? []) if (a?.agent) perAgent.set(a.agent, o.klasse);
  }
  return (rad) => {
    if (rad?.agent_id && perAgent.has(rad.agent_id)) return perAgent.get(rad.agent_id);
    const spor = String(rad?.spor ?? '');
    if (perId.has(spor)) return perId.get(spor);
    const uten = spor.replace(/-(?:r|runde)\d+$/i, '');
    return perId.get(uten) ?? null;
  };
}

/** Tekst-tabell for terminalen. */
function formaterTabell(m) {
  const k = (x) => (x == null ? '-' : `${Math.round(x / 1000)}k`);
  const v = (x) => (x == null ? '-' : String(x));
  const linjer = [
    `Kontekstmåling ${m.fra ?? '(start)'} → ${m.til ?? '(nå)'} (siste ferdig-rad per agent)`,
    'agenttype       klasse  antall  start  kontekst-median  p90    slutt-median  kall-før-endring  turer  kost-sum  kost-snitt',
  ];
  const rad = (navn, klasse, g) =>
    [
      navn.padEnd(15),
      klasse.padEnd(7),
      String(g.antall).padStart(6),
      k(g.kontekst_start_median).padStart(6),
      k(g.kontekst_median).padStart(16),
      k(g.kontekst_p90).padStart(6),
      k(g.kontekst_slutt_median).padStart(13),
      `${v(g.kall_for_forste_endring_median)} (n=${g.kall_for_forste_endring_antall})`.padStart(17),
      v(g.turer_median).padStart(6),
      `$${v(g.kost_sum)}`.padStart(9),
      `$${v(g.kost_snitt)}`.padStart(11),
    ].join(' ');
  for (const g of m.grupper) linjer.push(rad(g.agenttype, g.klasse, g));
  linjer.push(rad('ALLE', '', m.total));
  return linjer.join('\n');
}

module.exports = {
  kvantil,
  sisteFerdigPerAgent,
  nokkeltall,
  maalKontekst,
  klasseOppslag,
  formaterTabell,
};
