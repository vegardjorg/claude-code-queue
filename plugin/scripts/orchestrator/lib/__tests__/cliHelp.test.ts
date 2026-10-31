// =============================================================
// cliHelp.test.ts: `cq help` in groups and "Did you mean" for a mistyped command.
//
// Why: `cq help` was a 200-line wall filtered out of the comment in queue.mjs (descriptions stopped mid-sentence and
// internal scripts were listed as if users run them), and a typo printed every command on one line. The texts and the
// suggestion are pure (lib/cliHelp.js) and tested here; cq.mjs and queue.mjs are run once each to see they use them.
// =============================================================
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Group = { title: string; commands: { cmd: string; usage: string; text: string }[] };
const H = require('../cliHelp') as {
  GROUPS: Group[];
  QUEUE_COMMANDS: string[];
  ALIASES: Record<string, string>;
  INTERNAL_SCRIPTS: string[];
  shortHelp: (cq?: string) => string[];
  usageBlocks: (source: string, cq?: string) => { command: string; lines: string[] }[];
  fullHelp: (source: string, scripts: string[], cq?: string) => string[];
  commandHelp: (source: string, command: string, cq?: string) => string[] | null;
  scriptHeader: (source: string) => string[];
  editDistance: (a: string, b: string) => number;
  suggest: (word: string, candidates: string[], max?: number) => string[];
  unknownCommandMessage: (word: string, candidates: string[], cq?: string) => string;
  knownCommands: (scripts?: string[]) => string[];
};

const DIR = path.resolve(__dirname, '..', '..');
const CQ = path.join(DIR, 'cq.mjs');
const SOURCE = fs.readFileSync(path.join(DIR, 'queue.mjs'), 'utf8');
const SCRIPTS = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('hook-') && f !== 'cq.mjs')
  .map((f) => f.slice(0, -'.mjs'.length));
/** The command words queue.mjs really dispatches on. */
const DISPATCHED = new Set([...SOURCE.matchAll(/command === '([A-Za-z-]+)'/g)].map((m) => m[1]));

describe('the command lists', () => {
  it('QUEUE_COMMANDS is exactly what queue.mjs dispatches on', () => {
    expect([...H.QUEUE_COMMANDS].sort()).toEqual([...DISPATCHED].sort());
  });

  it('every command in the short help exists (a queue command, an alias or a script), 10 to 14 in all', () => {
    const all = H.GROUPS.flatMap((g) => g.commands);
    expect(all.length).toBeGreaterThanOrEqual(10);
    expect(all.length).toBeLessThanOrEqual(14);
    for (const c of all) {
      const exists = DISPATCHED.has(c.cmd) || c.cmd in H.ALIASES || SCRIPTS.includes(c.cmd);
      expect(exists, c.cmd).toBe(true);
      expect(c.usage.split(' ')[0]).toBe(c.cmd);
    }
    expect(H.GROUPS.map((g) => g.title)).toEqual(['Get started', 'Daily', 'Owner', 'Orchestrator']);
  });

  it('the internal scripts exist', () => {
    for (const s of H.INTERNAL_SCRIPTS) expect(SCRIPTS, s).toContain(s);
  });
});

describe('the help texts', () => {
  it('shortHelp has the groups, one line per command, and points to help all', () => {
    const lines = H.shortHelp();
    expect(lines).toContain('Daily:');
    expect(lines.some((l) => /^ {2}cq show \[--full\]\s+\S/.test(l))).toBe(true);
    expect(lines[lines.length - 1]).toContain('cq help all');
    expect(lines.length).toBeLessThan(30);
  });

  it('usageBlocks keeps the continuation lines the old filter dropped', () => {
    const fill = H.commandHelp(SOURCE, 'fill')!;
    expect(fill[0]).toMatch(/^ {2}cq fill --scratchpad/);
    // The 8-space continuation lines (the old regex only took 20+ spaces) are there, up to the closing parenthesis.
    expect(fill.join('\n')).toContain('(next -> start -> trackFile');
    expect(fill[fill.length - 1].trim().endsWith(')')).toBe(true);
    expect(H.commandHelp(SOURCE, 'nope')).toBeNull();
  });

  it('a block ends at a blank comment line or prose', () => {
    const src = [
      '//   node scripts/orchestrator/queue.mjs a      (one',
      '//          two)',
      '//   Prose that is not part of it.',
      '//        indented but after prose',
      '//   node scripts/orchestrator/queue.mjs b',
      '//',
      '//        after a blank line',
    ].join('\n');
    expect(H.usageBlocks(src)).toEqual([
      { command: 'a', lines: ['  cq a      (one', '         two)'] },
      { command: 'b', lines: ['  cq b'] },
    ]);
  });

  it('fullHelp puts the internal scripts under their own heading only', () => {
    const lines = H.fullHelp(SOURCE, SCRIPTS);
    const scriptsLine = lines.find((l) => l.startsWith('Scripts:'))!;
    for (const s of H.INTERNAL_SCRIPTS) expect(scriptsLine).not.toContain(s);
    expect(scriptsLine).toContain('prepare-track');
    expect(lines[lines.length - 1]).toMatch(/^Internal .*make-queue-common/);
  });

  it('scriptHeader takes the comment between the first two rulers', () => {
    expect(H.scriptHeader('#!/usr/bin/env node\n// ====\n// a.mjs: does a.\n//\n//   more\n// ====\ncode')).toEqual([
      'a.mjs: does a.',
      '',
      '  more',
    ]);
  });
});

describe('suggest and the unknown-command message', () => {
  const known = H.knownCommands(SCRIPTS);

  it('editDistance counts a swap of two neighbors as one', () => {
    expect(H.editDistance('shwo', 'show')).toBe(1);
    expect(H.editDistance('show', 'show')).toBe(0);
    expect(H.editDistance('kitten', 'sitting')).toBe(3);
  });

  it('finds the close ones, best first, also by prefix and case', () => {
    expect(H.suggest('shwo', known)[0]).toBe('show');
    expect(H.suggest('borad', known)).toEqual(['board']);
    expect(H.suggest('deliv', known)).toEqual(['deliver', 'deliveries']);
    expect(H.suggest('trackfile', known)).toEqual(['trackFile']);
    expect(H.suggest('prepare', known)).toContain('prepare-track');
  });

  it('suggests nothing when nothing is close, and is strict on short words', () => {
    expect(H.suggest('xyzzy', known)).toEqual([]);
    expect(H.suggest('', known)).toEqual([]);
    // Distance 2 from many short commands, but a 2-letter word only gets distance 1 or a prefix match.
    expect(H.suggest('zz', known)).toEqual([]);
  });

  it('the message has the suggestion only when there is one', () => {
    expect(H.unknownCommandMessage('shwo', ['show', 'start'])).toBe(
      'Unknown command "shwo". Did you mean "show"? See cq help.',
    );
    expect(H.unknownCommandMessage('st', ['set', 'start', 'state'])).toBe(
      'Unknown command "st". Did you mean "set", "start" or "state"? See cq help.',
    );
    expect(H.unknownCommandMessage('xyzzy', known, 'node scripts/orchestrator/cq.mjs')).toBe(
      'Unknown command "xyzzy". See node scripts/orchestrator/cq.mjs help.',
    );
  });
});

describe('cq.mjs (spawned)', () => {
  // QUEUE_FOLDER points away from any real queue; neither command reads or writes it.
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CQ, ...args], {
      encoding: 'utf8',
      env: { ...process.env, QUEUE_FOLDER: path.join(os.tmpdir(), 'cq-help-test-unused') },
    });

  it('cq help prints the short grouped list and exits 0', () => {
    const r = run('help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Get started:');
    expect(r.stdout).toContain('Orchestrator:');
    expect(r.stdout.split('\n').length).toBeLessThan(30);
    expect(run('help', 'merge').stdout).toContain('--allow-guard');
  });

  it('an unknown command goes through queue.mjs: one line with the suggestion, exit 1', () => {
    const r = run('shwo');
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toMatch(/^Unknown command "shwo"\. Did you mean "show"\? See .*help\.$/);
  });
});
