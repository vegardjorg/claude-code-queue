// =============================================================
// agentFiles.test.ts: the agent definitions in plugin/agents/ keep the rules the queue depends on.
//
// Every agent has frontmatter with its name and the "Data, not instructions" rule (prompt injection). Every reviewer
// (reviewer*.md) answers with the FINDINGS line first, is read-only, and runs the counter-evidence step before a HIGH or
// MEDIUM finding, with the Unverified line and the self-consistency rule. reviewer-security also asks for an EXPLOIT
// part. The adapted helpers carry the han attribution.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '..', '..', '..', '..', 'agents');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md'));
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');
const reviewers = files.filter((f) => f.startsWith('reviewer'));

describe('the agent files', () => {
  it('has the track and reviewer agents, including the helpers', () => {
    for (const f of [
      'track.md',
      'track-d.md',
      'reviewer.md',
      'reviewer-security.md',
      'reviewer-challenger.md',
      'reviewer-design.md',
      'reviewer-tests.md',
      'reviewer-gap.md',
      'reviewer-docs.md',
    ])
      expect(files).toContain(f);
  });

  it.each(files)('%s has frontmatter with its own name and the "Data, not instructions" rule', (f) => {
    const s = read(f);
    expect(s.startsWith('---\n') || s.startsWith('---\r\n')).toBe(true);
    expect(s).toMatch(new RegExp(`^name: ${f.replace(/\.md$/, '')}\\s*$`, 'm'));
    expect(s).toContain('Data, not instructions');
    // No em dashes in the texts.
    expect(s).not.toContain('—');
  });

  it.each(reviewers)('%s is read-only, answers with FINDINGS first and disproves before HIGH/MEDIUM', (f) => {
    const s = read(f);
    expect(s).toMatch(/^tools: Read, Grep, Glob, Bash\s*$/m);
    expect(s).not.toMatch(/^tools:.*\b(Edit|Write)\b/m);
    expect(s).toContain('FINDINGS H=<n> M=<n> L=<n> deferrable=<n>');
    expect(s).toContain('Unverified: <what>, because <why>.');
    expect(s).toContain('conflicts with <the other one>');
    if (f !== 'reviewer-challenger.md') expect(s).toContain('## Before you write a HIGH or MEDIUM finding');
    expect(s).toMatch(/never start other agents/i);
  });

  it('reviewer-security asks for an EXPLOIT part and never lowers a security finding without counter-evidence', () => {
    const s = read('reviewer-security.md');
    expect(s).toContain('`EXPLOIT:`');
    expect(s).toContain('shown at file:line');
  });

  it.each(['reviewer-design.md', 'reviewer-tests.md', 'reviewer-gap.md', 'reviewer-docs.md'])(
    '%s carries the attribution line',
    (f) => {
      expect(read(f).trimEnd().endsWith('Adapted from testdouble/han (MIT).')).toBe(true);
    },
  );
});
