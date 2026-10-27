// =============================================================
// missionText.test.ts: the shared protocol per class, and sectionPointers.
//
// Locks: (1) every binding key requirement ends up in the prompt for the classes it applies to, built from the REAL
// mission template (docs/mission-template.md in the repo root, installed as docs/queue/mission-template.md) the way
// make-queue-common.mjs and make-mission.mjs do it; (2) K and U do not get the D parts, and U not the client rules
// either; (3) an unknown class gives the whole protocol; (4) the project config (projectName, baseBranch, gates,
// architecture rules) is filled in; (5) sectionPointers gets the line range.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  filterClass,
  gateText,
  classFromBlock,
  makeQueueCommon,
  sectionArea,
  sectionPointers,
} from '../missionText';

// Repo root: three levels above template/scripts/orchestrator (the test lives in __tests__ below it).
const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const TEMPLATE = fs.readFileSync(path.join(REPO, 'docs', 'mission-template.md'), 'utf8');
const CONFIG = {
  projectName: 'Example',
  baseBranch: 'main',
  gates: { quick: ['npm run lint'], full: ['npm run lint', 'npm test'] },
  architectureRules: ['UI never imports the database client directly.'],
};
const COMMON = makeQueueCommon(TEMPLATE, 'C:\\scratch', CONFIG);
const prompt = (k: string | null) => filterClass(COMMON, k);

const ALL = ['K', 'D', 'D+', 'U'];
const DB = ['D', 'D+'];
const CODE = ['K', 'D', 'D+'];

// [keyword, the classes that MUST get it]. The list is the binding requirements of the protocol.
const REQUIREMENT: [string, string[]][] = [
  // all classes
  ['prepare-track.mjs', ALL],
  ['DENIES', ALL],
  ['npm install', ALL],
  ['NEVER push', ALL],
  ['git commit -- <files>', ALL],
  ['conflict markers', ALL],
  ['NEVER kill by pattern', ALL],
  ['hotspots', ALL],
  ['queue.mjs add --file', ALL],
  ['HIGH security finding', ALL],
  ['Context cap about 300k', ALL],
  ['handover.md', ALL],
  ['git switch --detach', ALL],
  ['No sleep, poll or wait loops', ALL],
  ['never read them', ALL],
  ['offset`/`limit', ALL],
  ['NEVER write your own check script', ALL],
  ['gates.mjs --quick', ALL],
  ['RESULT status=DONE|PARTIAL', ALL],
  ['at most about 1,500 characters', ALL],
  ['report.md', ALL],
  ['owner questions', ALL],
  ['wiring specification', ALL],
  // from the config
  ['for Example', ALL],
  ['Base branch: `main`', ALL],
  ['Quick gate: `npm run lint`', ALL],
  ['Full gate: `npm run lint`, `npm test`', ALL],
  ['UI never imports the database client directly.', ALL],
  ['git checkout -B __BRANCH__ main', ALL],
  // K, D and D+ (code)
  ['Append-only shared files', CODE],
  ['Client code', CODE],
  // K and U
  ['Before delivery, K and U', ['K', 'U']],
  // D and D+
  ['Before delivery, D and D+', DB],
  ['Only your own migration block (__BLOCK__)', DB],
  ['capabilities or permissions, never role names', DB],
  ['FULL from the live definition', DB],
  ['Red first', DB],
  ['Self-review (D and D+)', DB],
  ['For D and D+ also', DB],
];

// What only the D parts should have: K and U do not get it.
const ONLY_DB = [
  'Only your own migration block',
  'Self-review (D and D+)',
  'Before delivery, D and D+',
  'For D and D+ also',
];

describe('shared protocol per class', () => {
  it.each(REQUIREMENT)('"%s" is included for the right classes', (word, classes) => {
    for (const k of classes) expect([k, prompt(k).includes(word)]).toEqual([k, true]);
    expect(prompt(null).includes(word)).toBe(true); // unknown class: everything
  });

  it('K and U do not get the D parts, and U gets neither the client rules nor the extra files', () => {
    for (const word of ONLY_DB) {
      expect([word, prompt('K').includes(word)]).toEqual([word, false]);
      expect([word, prompt('U').includes(word)]).toEqual([word, false]);
    }
    expect(prompt('U').includes('Client code')).toBe(false);
    expect(prompt('U').includes('Append-only shared files')).toBe(false);
    expect(prompt('D').includes('Before delivery, K and U')).toBe(false);
  });

  it('no markers or unfilled placeholders in the prompt', () => {
    for (const k of [...ALL, null]) {
      expect(prompt(k)).not.toMatch(/<!--/);
      expect(prompt(k)).not.toMatch(/<[A-Z_]+>/);
      expect(prompt(k)).not.toContain('<base>');
    }
  });

  it('K and U are substantially shorter than the whole protocol', () => {
    expect(prompt('K').length).toBeLessThan(prompt(null).length * 0.9);
    expect(prompt('U').length).toBeLessThan(prompt('K').length);
  });

  it('without config: neutral defaults (main, no gates, no rules)', () => {
    const t = makeQueueCommon(TEMPLATE, 'C:\\scratch');
    expect(t).toContain('Base branch: `main`');
    expect(t).toContain('Quick gate: none set up in queue.config.json');
    expect(t).not.toContain('The project architecture rules');
    expect(gateText(undefined)).toBe('none set up in queue.config.json');
    expect(gateText(['a', '', 'b'])).toBe('`a`, `b`');
  });

  it('requires the heading "## Common protocol" in the template', () => {
    expect(() => makeQueueCommon('# empty template', 'C:\\scratch')).toThrow(/Common protocol/);
  });
});

describe('filterClass', () => {
  const t =
    'a\n<!-- class: D D+ -->\nd\n<!-- /class -->\n<!-- class: K,U -->\nk\n<!-- /class -->\nz';
  it('selects sections per class', () => {
    expect(filterClass(t, 'D+')).toBe('a\nd\nz');
    expect(filterClass(t, 'U')).toBe('a\nk\nz');
    expect(filterClass(t, null)).toBe('a\nd\nk\nz');
    expect(filterClass(t, 'X')).toBe('a\nd\nk\nz');
  });
  it('nested sections require both', () => {
    const n = '<!-- class: K D -->\nkd\n<!-- class: D -->\nd\n<!-- /class -->\n<!-- /class -->';
    expect(filterClass(n, 'K')).toBe('kd');
    expect(filterClass(n, 'D')).toBe('kd\nd');
  });
  it('unbalanced markers are an error', () => {
    expect(() => filterClass('<!-- class: D -->\nx', 'D')).toThrow();
    expect(() => filterClass('x\n<!-- /class -->', 'D')).toThrow();
  });
});

describe('classFromBlock', () => {
  it('reads the class from the ## TRACK line and the CLASS: line', () => {
    expect(classFromBlock('## TRACK X (t; source: y; class D+, estimate 30 min)')).toBe('D+');
    expect(classFromBlock('## TRACK X (t; source: y; class D, estimate 30 min)')).toBe('D');
    expect(classFromBlock('## TRACK X (t; class K, estimate 90 min)')).toBe('K');
    expect(classFromBlock('CLASS: U\n## TRACK X (t; class D)')).toBe('U');
    expect(classFromBlock('## TRACK X (wave)')).toBeNull();
    expect(classFromBlock('## TRACK X (t; class Kalfa)')).toBeNull();
  });
});

describe('sectionPointers', () => {
  const doc = [
    '# Title', // 1
    '', // 2
    '## 5. Five', // 3
    'text', // 4
    '## 6. Six', // 5
    'a', // 6
    '### 6.1 Under', // 7
    'b', // 8
    '', // 9
    '## § 7 Seven', // 10
    'c', // 11
  ].join('\n');
  const read = (f: string) => (f === 'docs/a.md' ? doc : null);

  it('computes the line range for § N, § N.M and #anchor', () => {
    expect(sectionArea(doc, { section: '6' })).toEqual({ from: 5, to: 8 });
    expect(sectionArea(doc, { section: '6.1' })).toEqual({ from: 7, to: 8 });
    expect(sectionArea(doc, { section: '7' })).toEqual({ from: 10, to: 11 });
    expect(sectionArea(doc, { anchor: '5-five' })).toEqual({ from: 3, to: 4 });
    expect(sectionArea(doc, { anchor: 'under' })).toEqual({ from: 7, to: 8 });
    expect(sectionArea(doc, { section: '9' })).toBeNull();
  });

  it('appends the range, also in backticks, and is backward compatible', () => {
    expect(sectionPointers('Read docs/a.md § 6 item 1.', read)).toBe(
      'Read docs/a.md § 6 (line 5–8) item 1.',
    );
    expect(sectionPointers('Read `docs/a.md#under` now', read)).toBe(
      'Read `docs/a.md#under` (line 7–8) now',
    );
    expect(sectionPointers('Read `docs/a.md` § 6.1.', read)).toBe(
      'Read `docs/a.md` § 6.1 (line 7–8).',
    );
    // without a section, unknown file, unknown section: untouched
    for (const t of ['Read docs/a.md.', 'Read docs/b.md § 6.', 'Read docs/a.md § 9.'])
      expect(sectionPointers(t, read)).toBe(t);
  });

  it('is idempotent', () => {
    const one = sectionPointers('docs/a.md § 6.1 and `docs/a.md#under`', read);
    expect(sectionPointers(one, read)).toBe(one);
  });
});
