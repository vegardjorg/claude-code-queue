// =============================================================
// sporVakt.test.ts: kontekstvakten og lesevakten for spor-agentene.
//
// Låser: ingen effekt i hovedøkta (uten agent_type) eller for andre agenttyper, ingen effekt under terskelen,
// én melding ved terskelen, ingen gjentakelse; og at lesevakten avviser filer som lastes automatisk og hele store
// filer, men slipper utdrag gjennom, og kan utvides med konfig().lesevakt. Til slutt en røyktest av selve hookene
// (barneprosess, temp-filer). Logikken: lib/sporVakt.js.
// =============================================================
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SPOR_TERSKEL,
  lesRegler,
  sisteKontekst,
  subagentTranskript,
  vurderKontekst,
  vurderLesing,
} from '../sporVakt';

const brukLinje = (n: number) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      usage: { input_tokens: 10, cache_read_input_tokens: n - 10, cache_creation_input_tokens: 0 },
    },
  });

describe('sisteKontekst', () => {
  it('leser den siste assistent-meldingens usage og tåler en kuttet første linje', () => {
    const t = [
      '{"type":"assis',
      brukLinje(100_000),
      '{"type":"user","message":{}}',
      brukLinje(290_000),
    ].join('\n');
    expect(sisteKontekst(t)).toBe(290_000);
    expect(sisteKontekst('')).toBeNull();
  });

  it('gir null rett etter en komprimering (usage før grensen er størrelsen FØR /compact)', () => {
    const grense =
      '{"type":"system","subtype":"compact_boundary","compactMetadata":{"preTokens":346000}}';
    expect(sisteKontekst([brukLinje(346_000), grense].join('\n'))).toBeNull();
    // Etter første svar etter komprimeringen gjelder den nye, lille verdien.
    expect(sisteKontekst([brukLinje(346_000), grense, brukLinje(95_000)].join('\n'))).toBe(95_000);
  });
});

describe('kontekstvakten', () => {
  it('ingen effekt i hovedøkta eller for andre agenttyper', () => {
    expect(vurderKontekst({ agentType: undefined, kontekst: 500_000 })).toBeNull();
    expect(vurderKontekst({ agentType: null, kontekst: 500_000 })).toBeNull();
    expect(vurderKontekst({ agentType: 'general-purpose', kontekst: 500_000 })).toBeNull();
    expect(vurderKontekst({ agentType: 'reviewer', kontekst: 500_000 })).toBeNull();
  });
  it('ingen effekt under terskelen eller uten måling', () => {
    expect(vurderKontekst({ agentType: 'spor', kontekst: SPOR_TERSKEL - 1 })).toBeNull();
    expect(vurderKontekst({ agentType: 'spor', kontekst: null })).toBeNull();
  });
  it('én melding ved terskelen, for spor og spor-d', () => {
    const s = vurderKontekst({ agentType: 'spor', kontekst: SPOR_TERSKEL });
    expect(s?.terskel).toBe(SPOR_TERSKEL);
    expect(s?.melding).toMatch(/overlevering\.md/);
    expect(s?.melding).toMatch(/DELVIS/);
    expect(vurderKontekst({ agentType: 'spor-d', kontekst: 300_000 })).not.toBeNull();
  });
  it('ingen gjentakelse når terskelen allerede er utløst', () => {
    expect(
      vurderKontekst({ agentType: 'spor', kontekst: 350_000, utlost: [SPOR_TERSKEL] }),
    ).toBeNull();
  });
  it('terskelen kan overstyres', () => {
    expect(
      vurderKontekst({ agentType: 'spor', kontekst: 150_000, terskel: 100_000 }),
    ).not.toBeNull();
  });
});

describe('subagentTranskript', () => {
  const finnes = (lov: string[]) => (p: string) => lov.includes(p);
  it('finner subagentens fil under økt-mappa, aldri hovedøktas transkript', () => {
    const tp = path.join('/p', 'okt1.jsonl');
    const sub = path.join('/p', 'okt1', 'subagents', 'agent-abc.jsonl');
    expect(
      subagentTranskript(
        { agent_id: 'abc', session_id: 'okt1', transcript_path: tp },
        finnes([sub]),
      ),
    ).toBe(sub);
    expect(
      subagentTranskript(
        { agent_id: 'abc', session_id: 'okt1', transcript_path: tp },
        finnes([tp]),
      ),
    ).toBeNull();
    expect(subagentTranskript({ transcript_path: tp }, finnes([tp]))).toBeNull();
  });
  it('bruker agent_transcript_path når den finnes', () => {
    expect(
      subagentTranskript(
        { agent_id: 'abc', agent_transcript_path: '/x/a.jsonl' },
        finnes(['/x/a.jsonl']),
      ),
    ).toBe('/x/a.jsonl');
  });
});

describe('lesevakten', () => {
  const R = lesRegler({}, { mappe: 'db/migrations' });
  const mig = 'C:\\repo\\eksempel\\db\\migrations\\0042_x.sql';
  const les = (a: Record<string, unknown>) => vurderLesing({ regler: R, ...a });
  it('ingen effekt i hovedøkta eller for andre agenttyper', () => {
    expect(les({ filsti: 'C:/r/CLAUDE.md' })).toBeNull();
    expect(les({ agentType: 'general-purpose', filsti: 'C:/r/CLAUDE.md' })).toBeNull();
  });
  it('avviser hel lesing av CLAUDE.md (i hvilken som helst mappe) og MEMORY.md for spor og review-agentene', () => {
    for (const agentType of ['spor', 'spor-d', 'reviewer', 'reviewer-sikkerhet']) {
      expect(les({ agentType, filsti: 'C:\\r\\CLAUDE.md' })?.grunn).toMatch(/lastes automatisk/);
      expect(les({ agentType, filsti: '/r/db/CLAUDE.md' })).not.toBeNull();
      expect(les({ agentType, filsti: '/h/.claude/projects/x/memory/MEMORY.md' })).not.toBeNull();
    }
  });
  it('slipper et utdrag av CLAUDE.md gjennom (Edit krever at fila er lest)', () => {
    expect(les({ agentType: 'spor', filsti: '/r/CLAUDE.md', offset: 100, limit: 30 })).toBeNull();
  });
  it('avviser en stor migrasjon (migrasjoner.mappe) uten limit, med råd om Grep og offset/limit', () => {
    const s = les({ agentType: 'spor', filsti: mig, antallLinjer: 900 });
    expect(s?.grunn).toMatch(/Grep/);
    expect(s?.grunn).toMatch(/offset og limit/);
  });
  it('slipper små migrasjoner, utdrag og andre filer under blokkgrensen gjennom', () => {
    expect(les({ agentType: 'spor', filsti: mig, antallLinjer: 300 })).toBeNull();
    expect(les({ agentType: 'spor', filsti: mig, antallLinjer: 900, limit: 80 })).toBeNull();
    expect(les({ agentType: 'spor', filsti: mig, antallLinjer: null })).toBeNull();
    expect(les({ agentType: 'spor', filsti: '/r/db/tests/x.sql', antallLinjer: 900 })).toBeNull();
    expect(les({ agentType: 'spor', filsti: '/r/CLAUDE.md.bak' })).toBeNull();
  });
  it('uten migrasjonsmappe er ingen filer «store», men blokkgrensen gjelder alle tekstfiler', () => {
    const tom = lesRegler({}, {});
    expect(vurderLesing({ agentType: 'spor', filsti: mig, antallLinjer: 900, regler: tom })).toBeNull();
    expect(
      vurderLesing({ agentType: 'spor', filsti: '/r/a.ts', antallLinjer: 2500, regler: tom })?.grunn,
    ).toMatch(/2500 linjer/);
    expect(
      vurderLesing({ agentType: 'spor', filsti: '/r/a.png', antallLinjer: 2500, regler: tom }),
    ).toBeNull();
  });
  it('prosjektet utvider vakta med konfig().lesevakt', () => {
    const egen = lesRegler(
      {
        agentTyper: ['granskning'],
        autoLastet: ['docs/REGLER.md', 'NOTAT.md'],
        storeFiler: ['data/**/*.csv'],
        maksLinjer: 100,
        blokkLinjer: 500,
      },
      {},
    );
    const v = (a: Record<string, unknown>) => vurderLesing({ regler: egen, ...a });
    expect(v({ agentType: 'granskning', filsti: '/r/NOTAT.md' })).not.toBeNull();
    expect(v({ agentType: 'spor', filsti: 'C:\\r\\docs\\REGLER.md' })).not.toBeNull();
    expect(v({ agentType: 'spor', filsti: '/r/andre/REGLER.md' })).toBeNull();
    expect(v({ agentType: 'spor', filsti: '/r/data/a/b/x.csv', antallLinjer: 150 })).not.toBeNull();
    expect(v({ agentType: 'spor', filsti: '/r/data/x.csv', antallLinjer: 150 })).not.toBeNull();
    expect(v({ agentType: 'spor', filsti: '/r/a.ts', antallLinjer: 600 })).not.toBeNull();
    expect(v({ agentType: 'spor', filsti: '/r/a.ts', antallLinjer: 400 })).toBeNull();
  });
});

describe('hookene (røyktest)', () => {
  const ork = path.join(__dirname, '..', '..');
  const kjor = (skript: string, inn: object, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [path.join(ork, skript)], {
      input: JSON.stringify(inn),
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  it('kontekstvakten sier fra én gang per agent, og aldri i hovedøkta', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sporvakt-'));
    const okt = 'okt1';
    const tp = path.join(d, `${okt}.jsonl`);
    fs.writeFileSync(tp, brukLinje(400_000) + '\n'); // hovedøkta er stor: skal ikke telle for subagenten
    fs.mkdirSync(path.join(d, okt, 'subagents'), { recursive: true });
    const sub = path.join(d, okt, 'subagents', 'agent-a1.jsonl');
    fs.writeFileSync(
      sub,
      '{"type":"user","message":{"content":"les prompt-TEST-1.md"}}\n' + brukLinje(100_000) + '\n',
    );
    const env = {
      SPOR_KONTEKST_TILSTAND: path.join(d, 'tilstand'),
      KO_TIDSLOGG: path.join(d, 'logg.jsonl'),
    };
    const inn = {
      hook_event_name: 'PostToolUse',
      session_id: okt,
      transcript_path: tp,
      agent_id: 'a1',
      agent_type: 'spor',
    };

    expect(
      kjor('hook-spor-kontekst.mjs', { ...inn, agent_id: undefined, agent_type: undefined }, env)
        .stdout,
    ).toBe('');
    expect(kjor('hook-spor-kontekst.mjs', inn, env).stdout).toBe(''); // under terskelen

    fs.appendFileSync(sub, brukLinje(285_000) + '\n');
    const r = kjor('hook-spor-kontekst.mjs', inn, env);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(/DELVIS/);
    expect(kjor('hook-spor-kontekst.mjs', inn, env).stdout).toBe(''); // ingen gjentakelse

    const rader = fs
      .readFileSync(env.KO_TIDSLOGG, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rader).toHaveLength(1);
    expect(rader[0]).toMatchObject({
      hendelse: 'kontekstvakt',
      spor: 'TEST-1',
      agent_id: 'a1',
      terskel: SPOR_TERSKEL,
    });
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('lesevakten avviser CLAUDE.md for spor og feiler åpent på søppel-input', () => {
    const r = kjor('hook-lesevakt.mjs', {
      agent_type: 'spor',
      tool_input: { file_path: '/r/db/CLAUDE.md' },
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(kjor('hook-lesevakt.mjs', { tool_input: { file_path: '/r/CLAUDE.md' } }).stdout).toBe(
      '',
    );
    const s = spawnSync(process.execPath, [path.join(ork, 'hook-lesevakt.mjs')], {
      input: '{ikke json',
      encoding: 'utf8',
    });
    expect(s.status).toBe(0);
    expect(s.stdout).toBe('');
  });
});
