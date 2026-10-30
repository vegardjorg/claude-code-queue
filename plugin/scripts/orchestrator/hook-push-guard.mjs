#!/usr/bin/env node
// =============================================================
// hook-push-guard.mjs: PreToolUse hook (Bash/PowerShell) that stops the expensive and irreversible commands before
// they run: forced push, push of branches other than baseBranch, and migration push to an environment that is not
// allowed (see lib/pushGuard.js for the rules and the reasoning, and docs/orchestration.md).
//
// What it does: reads the hook payload from stdin, finds the current branch and (when migrations.environmentFile is set)
// the contents of the environment file, and asks lib/pushGuard.js. The answer is "ask" (Claude Code shows a confirmation
// dialog), "deny" (blocked, with reason) or nothing (normal flow).
//
// Fails OPEN: an internal error (invalid payload, git missing) gives exit 0 without a decision and a line on stderr.
// The guard must never stop normal work because of a bug in itself. If node is missing on PATH, the hook gets exit 127,
// which Claude Code treats as non-blocking.
//
// For the queue's agents (agent_type track/track-d and every reviewer and helper agent, builtin or custom, the same list
// as the read guard) it also assesses network calls (curl, iwr, | sh, an unknown npx package); see lib/pushGuard.js.
// The orchestrator (the main session, no agent_type) is not affected.
//
// Test: lib/__tests__/pushGuard.test.ts (the logic). Smoke test of the hook itself:
//   echo '{"tool_input":{"command":"git push --force origin main"},"cwd":"."}' | node scripts/orchestrator/hook-push-guard.mjs
//   echo '{"agent_type":"track","tool_input":{"command":"curl https://x"},"cwd":"."}' | node scripts/orchestrator/hook-push-guard.mjs
// =============================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Not a queue project (no queue.config.json): do nothing. A plugin's hooks run in every project the user opens.
if (!require('./lib/projectRoot.js').queueActive()) process.exit(0);
const { assess, readEnvironment, isGuardedAgent } = require('./lib/pushGuard.js');
const { config } = require('./lib/queueConfig.js');

function read(stdin) {
  try {
    return JSON.parse(stdin || '{}');
  } catch {
    return null;
  }
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Main tree for an agent worktree (<root>/.claude/worktrees/<name>), otherwise the path itself. */
function mainTree(top) {
  return String(top).split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0];
}

/** Only commands that can match: git or the first word of the migration command. Saves git calls otherwise. */
function canHit(command, k) {
  if (/\bgit\b/.test(command)) return true;
  const word = String(k.migrations?.pushCommand || '')
    .split(/\s+/)
    .filter((x) => x && !x.startsWith('-') && !['npx', 'npm', 'pnpm', 'yarn', 'exec'].includes(x));
  return word.length > 0 && command.includes(word[0]);
}

/**
 * Does the project know the package? It is in package.json (all dependency fields) or has a bin in node_modules/.bin
 * (npx then does not fetch from the network). Read lazily, the first time npm/npx is actually assessed.
 */
function knownPackage(cwd) {
  let names = null;
  return (pkg) => {
    if (!names) {
      names = new Set();
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
          for (const n of Object.keys(pj[field] || {})) names.add(n);
      } catch {
        // no package.json here: every package is unknown (gives "ask", never deny)
      }
    }
    if (names.has(pkg)) return true;
    const bin = path.join(cwd, 'node_modules', '.bin', pkg);
    return [bin, `${bin}.cmd`].some((f) => fs.existsSync(f));
  };
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  try {
    const p = read(input);
    const command = p?.tool_input?.command;
    if (!p || typeof command !== 'string') process.exit(0);
    const k = config();
    // agent_type exists only when the hook fires in a subagent (tracks, reviewers and helpers get the network guard).
    const agentType = typeof p.agent_type === 'string' ? p.agent_type : null;
    // The guarded types are read once (config + queue.json), and only in a subagent.
    const guardedTypes = agentType ? require('./lib/trackGuard.js').queueAgentTypes() : new Set();
    const guarded = isGuardedAgent(agentType, guardedTypes);
    const gitContext = canHit(command, k);
    if (!gitContext && !guarded) process.exit(0);

    const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
    // The git calls only when the command can be a push or a migration push.
    const branch = gitContext ? git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
    const top = gitContext ? git(cwd, ['rev-parse', '--show-toplevel']) : null;
    const environment = gitContext
      ? readEnvironment([top, top && mainTree(top), k.root], k.migrations?.environmentFile)
      : null;
    const answer = assess(command, {
      branch: branch === 'HEAD' ? null : branch,
      environment,
      baseBranch: k.baseBranch,
      migrations: k.migrations,
      agentType,
      guardedTypes,
      knownPackage: guarded ? knownPackage(cwd) : undefined,
    });
    if (!answer) process.exit(0);

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: answer.decision,
          permissionDecisionReason: `push-guard: ${answer.reason}`,
        },
      }),
    );
    process.exit(0);
  } catch (e) {
    process.stderr.write(
      `push-guard: internal error, letting the command through (${e?.message ?? e})\n`,
    );
    process.exit(0);
  }
});
