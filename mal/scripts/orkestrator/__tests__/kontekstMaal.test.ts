// =============================================================
// kontekstMaal.test.ts: beregningen bak kontekst-maal.mjs.
//
// Låser: bare SISTE ferdig-rad per agent teller (radene er kumulative), tidsvinduet, grupperingen per agenttype og
// klasse, median/p90 og klasse-oppslaget fra køen (også retterunder og reviewer-agenter).
// =============================================================
import { describe, expect, it } from 'vitest';

import { klasseOppslag, kvantil, maalKontekst, sisteFerdigPerAgent } from '../kontekstMaal';

const rad = (agent: string, tid: string, o: Record<string, unknown> = {}) => ({
  tid,
  hendelse: 'ferdig',
  agent_id: agent,
  agent_type: 'spor',
  spor: agent,
  modellturer: 10,
  kost_usd: 1,
  kall_for_forste_endring: 5,
  kontekst: { start: 20_000, median: 100_000, slutt: 150_000 },
  ...o,
});

describe('kvantil', () => {
  it('median og p90 med interpolasjon', () => {
    expect(kvantil([3, 1, 2], 0.5)).toBe(2);
    expect(kvantil([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(kvantil([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1);
    expect(kvantil([], 0.5)).toBeNull();
  });
});

describe('sisteFerdigPerAgent', () => {
  it('tar siste rad per agent i vinduet og hopper over rader uten kontekst', () => {
    const r = [
      rad('a', '2026-10-10T10:00:00Z', { modellturer: 5 }),
      rad('a', '2026-10-10T11:00:00Z', { modellturer: 9 }),
      rad('b', '2026-10-01T10:00:00Z'),
      rad('c', '2026-10-10T10:00:00Z', { kontekst: undefined }),
      { tid: '2026-10-10T10:00:00Z', hendelse: 'start', agent_id: 'd' },
    ];
    const ut = sisteFerdigPerAgent(r, { fra: Date.parse('2026-10-05T00:00:00Z') });
    expect(
      ut.map((x: { agent_id: string; modellturer: number }) => [x.agent_id, x.modellturer]),
    ).toEqual([['a', 9]]);
  });
});

describe('maalKontekst', () => {
  it('grupperer per agenttype og klasse og summerer kost', () => {
    const r = [
      rad('a', '2026-10-10T10:00:00Z', { kontekst: { start: 1, median: 100_000, slutt: 2 } }),
      rad('b', '2026-10-10T10:00:00Z', {
        kontekst: { start: 1, median: 200_000, slutt: 2 },
        kost_usd: 3,
      }),
      rad('c', '2026-10-10T10:00:00Z', {
        agent_type: 'reviewer',
        kall_for_forste_endring: null,
      }),
    ];
    const m = maalKontekst(r, {
      klasseFor: (x: { agent_type: string }) => (x.agent_type === 'spor' ? 'K' : null),
    });
    const k = m.grupper.find((g: { klasse: string }) => g.klasse === 'K');
    expect(k).toMatchObject({
      agenttype: 'spor',
      antall: 2,
      kontekst_median: 150_000,
      kost_sum: 4,
      kost_snitt: 2,
    });
    const rls = m.grupper.find((g: { agenttype: string }) => g.agenttype === 'reviewer');
    expect(rls).toMatchObject({
      klasse: 'ukjent',
      kall_for_forste_endring_median: null,
      kall_for_forste_endring_antall: 0,
    });
    expect(m.total.antall).toBe(3);
  });
});

describe('klasseOppslag', () => {
  const ko = {
    oppgaver: [
      { id: 'X-1', klasse: 'D', kost: { agenter: [{ agent: 'rev1', type: 'reviewer' }] } },
      { id: 'Y', klasse: 'K' },
    ],
  };
  const f = klasseOppslag(ko);
  it('slår opp oppgave-id, retterunde og agent-id', () => {
    expect(f({ spor: 'X-1' })).toBe('D');
    expect(f({ spor: 'X-1-r2' })).toBe('D');
    expect(f({ spor: 'rev1abc', agent_id: 'rev1' })).toBe('D');
    expect(f({ spor: 'Y' })).toBe('K');
    expect(f({ spor: 'ukjent' })).toBeNull();
  });
});
