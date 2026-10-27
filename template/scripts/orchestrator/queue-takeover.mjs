#!/usr/bin/env node
// =============================================================
// queue-takeover.mjs: status picture for a new orchestrator session that takes over the work queue (the /queue skill).
// See docs/orchestration.md.
//
// Writes nothing. Gathers what a new orchestrator must know before it starts the loop:
//   0. At the top: the wind-down flag in the orchestrator cursor (the previous session passed about 350k context and must be rotated)
//      and the newest handover note (<dataFolder>/handover-*.md) with its first lines.
//   1. Is the previous orchestrator still alive? (when queue.json was last changed)
//   2. Git state in mainTree (branch, HEAD, ahead/behind <remote>/<baseBranch>, leftover index.lock) and, when
//      config().migrations.environmentFile is set, which environment the migrations are linked to.
//   3. Each active task (running/review): commits on the branch ahead of baseBranch, age of the last commit, uncommitted in
//      the worktree, and a classification: DELIVERED (ready for intake), EMPTY (nothing completed) or UNCERTAIN.
//   4. How many slots can be filled now, and the owner questions that unlock the most tasks.
//   5. Picked tasks (a person or session is doing them): who, age, commits on the branch, and "OLD" when it has been
//      picked for over 72 h without commits (never released automatically; ask the owner). Plus the count in the QA list.
//   6. Orchestrator cursor (<dataFolder>/orchestrator.json): who was last orchestrator and when; expired after 2 h
//      without an update.
//   7. Work outside the queue (the short version of `queue.mjs external`): external commits that are not pushed, branches
//      outside the queue's branchPrefix, uncommitted in mainTree, registrations (external add), consistency and collisions.
//
// Use: node scripts/orchestrator/queue-takeover.mjs [--json]
// QUEUE_FOLDER (the folder with queue.json) and QUEUE_GIT (the repo the branches are counted in) override, as in queue.mjs (smoke tests).
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const L = require('./lib/queueLogic.js');
const G = require('./lib/queueGit.js');
const { config, dataFolder } = require('./lib/queueConfig.js');

const K = config();
const BASE = K.baseBranch;
const REMOVE = `${K.remote}/${BASE}`;
// Main tree (config().root is always mainTree, also when the script is run from a worktree).
const MAIN_TREE = K.root;
const QUEUE_FOLDER = dataFolder();
const QUEUE_FILE = path.join(QUEUE_FOLDER, 'queue.json');
const GIT_ROOT = process.env.QUEUE_GIT ?? MAIN_TREE;
const AS_JSON = process.argv.includes('--json');
const NOW = Date.now();

// Runs git in mainTree (or a given worktree) and returns trimmed stdout, or null on error.
// --no-optional-locks: `git status` in a track's worktree must not take index.lock while the track commits.
function git(args, cwd = GIT_ROOT) {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// "3 h 12 min" / "14 min" from milliseconds (shared with queue.mjs).
const age = L.ageText;

// worktree path per branch, from `git worktree list --porcelain`.
function worktreePerBranch() {
  const out = git(['worktree', 'list', '--porcelain']) ?? '';
  const map = new Map();
  let filePath = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) filePath = line.slice(9);
    else if (line.startsWith('branch refs/heads/') && filePath) map.set(line.slice(18), filePath);
  }
  return map;
}

const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
const tasks = queue.tasks ?? [];

// ---- 1. Previous orchestrator ----
const queueChangedMs = queue.changed ? NOW - Date.parse(queue.changed) : null;
// Under 15 min since the last change: another orchestrator is probably alive. Two orchestrators at once give
// double starts and double merges, so the skill stops then and asks the owner.
const possibleLive = queueChangedMs != null && queueChangedMs < 15 * 60_000;

// ---- 2. Git and (optional) the migration environment ----
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const head = git(['rev-parse', '--short', 'HEAD']);
const aheadBack = git(['rev-list', '--left-right', '--count', `${REMOVE}...${BASE}`]);
const [back, ahead] = (aheadBack ?? '? ?').split(/\s+/);
const lockPath = path.join(MAIN_TREE, '.git', 'index.lock');
const indexLock = fs.existsSync(lockPath) ? age(NOW - fs.statSync(lockPath).mtimeMs) : null;
// The environment file (config().migrations.environmentFile) says which environment the migrations are pushed to; the push guard
// checks it against migrations.allowedEnvironment. null = not set up or the file does not exist.
const environmentFile = K.migrations?.environmentFile ?? null;
let environment = null;
if (environmentFile) {
  try {
    environment = fs.readFileSync(path.resolve(MAIN_TREE, environmentFile), 'utf8').trim();
  } catch {
    /* not linked */
  }
}
const allowedEnvironment = Array.isArray(K.migrations?.allowedEnvironment) ? K.migrations.allowedEnvironment : [];

// ---- 3. Active tasks ----
const wt = worktreePerBranch();
const activeOnes = tasks
  .filter((o) => ['running', 'review'].includes(o.status))
  .map((o) => {
    const g = o.branch ?? `${K.branchPrefix}${o.id}`;
    const exists = git(['rev-parse', '-q', '--verify', g]) != null;
    const commits = exists ? Number(git(['rev-list', '--count', `${BASE}..${g}`]) ?? 0) : 0;
    const lastIso = exists ? git(['log', '-1', '--format=%cI', g]) : null;
    const lastMs = lastIso ? NOW - Date.parse(lastIso) : null;
    const wtPath = wt.get(g);
    const uncommitted = wtPath
      ? (git(['status', '--porcelain'], wtPath) ?? '').split('\n').filter(Boolean).length
      : null;
    const startedMs = o.started ? NOW - Date.parse(o.started) : null;
    // DELIVERED: commits ahead of baseBranch, a clean worktree, and no new commit in 20 min (the agent has finished).
    // EMPTY: no commits and started over an hour ago (the agent died before it did anything).
    let assessment = 'UNCERTAIN';
    if (o.status === 'review')
      assessment = commits > 0 ? 'DELIVERED (review)' : 'UNCERTAIN (review without commits)';
    else if (commits > 0 && (uncommitted ?? 0) === 0 && (lastMs ?? 0) > 20 * 60_000)
      assessment = 'DELIVERED';
    else if (commits === 0 && (startedMs ?? 0) > 60 * 60_000) {
      // The work may be on another branch (e.g. hotfix/<id>): look for commits that mention the id.
      const another = git([
        'log',
        '--all',
        '-1',
        '--format=%h %D',
        `--grep=${o.id}\\b`,
        '--extended-regexp',
      ]);
      assessment = another
        ? `UNCERTAIN (commit ${another.split(' ')[0]} mentions ${o.id} on another branch)`
        : 'EMPTY';
    } else if ((uncommitted ?? 0) > 0) assessment = 'UNCERTAIN (uncommitted in worktree)';
    return {
      id: o.id,
      status: o.status,
      class: o.class,
      migr: Number(o.migr_tens ?? 0) > 0,
      branch: g,
      commits,
      last_commit: age(lastMs),
      started: age(startedMs),
      uncommitted,
      worktree: wtPath ?? null,
      assessment,
    };
  });

// ---- 4. What can be started, and what blocks (as in `next`: tasks whose owned files are uncommitted in mainTree are skipped) ----
const gitRead = G.makeGit(GIT_ROOT);
const uncommitted = (G.readUncommitted(gitRead) ?? []).map((u) => u.path);
const t = L.state(queue, undefined, { uncommitted });
const canStart = L.selectNext(queue, NOW, { uncommitted }).map((o) => o.id);

// ---- 5. Picked tasks ----
const picked = tasks
  .filter((o) => o.status === 'picked')
  .map((o) => {
    const g = o.branch ?? `${K.branchPrefix}${o.id}`;
    const exists = git(['rev-parse', '-q', '--verify', `refs/heads/${g}`]) != null;
    const commits = exists ? Number(git(['rev-list', '--count', `${BASE}..${g}`]) ?? 0) || 0 : 0;
    const lastCommit = commits > 0 ? git(['log', '-1', '--format=%cI', g]) : null;
    return {
      id: o.id,
      class: o.class,
      by: o.picked_by ?? null,
      picked: age(o.picked_at ? NOW - Date.parse(o.picked_at) : null),
      branch: g,
      commits,
      last_commit: lastCommit ? age(NOW - Date.parse(lastCommit)) : null,
      migr_block: o.migr_block ?? null,
      old: L.isOldPick(o, { commits, lastCommit }, NOW),
    };
  });

// ---- 6. Orchestrator cursor ----
let cursor = null;
try {
  cursor = JSON.parse(fs.readFileSync(path.join(QUEUE_FOLDER, 'orchestrator.json'), 'utf8'));
} catch {
  /* no cursor */
}
const orchestrator = L.orchestratorStatus(cursor, NOW);
// The wind-down flag (hook-context at about 350k) and the newest handover note are shown at the top.
const windDown = L.windDownGuard(cursor, NOW);

// ---- 6c. Handover note (<dataFolder>/handover-<time>.md, written by the previous orchestrator) ----
let note = null;
try {
  const files = fs
    .readdirSync(QUEUE_FOLDER)
    .filter((f) => /^handover-.*\.md$/.test(f))
    .map((f) => ({ f, ms: fs.statSync(path.join(QUEUE_FOLDER, f)).mtimeMs }))
    .sort((a, b) => b.ms - a.ms);
  if (files.length) {
    const filePath = path.join(QUEUE_FOLDER, files[0].f);
    note = {
      path: filePath,
      age: age(NOW - files[0].ms),
      // First lines: heading and status. The whole note is read with Read.
      excerpt: fs.readFileSync(filePath, 'utf8').split('\n').slice(0, 12).join('\n'),
    };
  }
} catch {
  /* no note */
}

// ---- 6b. The session's thinking level (hook-effort.mjs): medium is the default for the orchestrator ----
let effort = null;
try {
  effort = JSON.parse(fs.readFileSync(path.join(QUEUE_FOLDER, 'effort.json'), 'utf8'));
} catch {
  /* no marker yet (written on the next message) */
}

// ---- 7. Work outside the queue (details: queue.mjs external) ----
const hasOrigin = git(['rev-parse', '-q', '--verify', `refs/remotes/${REMOVE}`]) != null;
const eb = G.externalImage(gitRead, queue, {
  window: hasOrigin
    ? { from: REMOVE }
    : { since: new Date(NOW - 86_400_000).toISOString() },
});
const outside = {
  window: hasOrigin ? 'not pushed' : 'last 24 h',
  external_commits: eb.externalOnes.map((c) => `${c.summary} ${c.subject}`),
  branches: eb.branches.map((g) => `${g.name} (${g.count})`),
  uncommitted_changed: eb.uncommitted.filter((u) => !u.untracked).length,
  uncommitted_untracked: eb.uncommitted.filter((u) => u.untracked).length,
  registered: eb.registered.map((o) => `${o.id} "${o.external_name}"`),
  consistency: eb.consistency.filter((s) => s.proposed).map((s) => s.proposed),
  collisions_active: eb.collisions
    .filter((k) => k.status !== 'waiting')
    .map((k) => L.collisionText(k)),
  collisions_pending: eb.collisions.filter((k) => k.status === 'waiting').length,
  error: eb.error,
};

const report = {
  windDown: windDown.stop ? { ...cursor.windDown, message: windDown.message } : null,
  handoverNote: note ? { path: note.path, age: note.age } : null,
  queue_last_changed: age(queueChangedMs),
  possible_live_orchestrator: possibleLive,
  orchestrator_cursor: {
    active: orchestrator.active,
    session: orchestrator.session,
    updated_ago: age(orchestrator.age_ms),
    event: orchestrator.event ?? null,
  },
  outside_queue: outside,
  git: { branch, head, ahead_origin: ahead, back_origin: back, index_lock_age: indexLock },
  migrationEnvironment: environmentFile ? { file: environmentFile, environment, allowed: environment != null && allowedEnvironment.includes(environment) } : null,
  activeOnes,
  picked,
  qa_list: t.qa,
  waiting: t.waiting,
  can_start_now: canStart,
  ownerQuestion: t.ownerQuestion.slice(0, 8),
  limits: queue.limits,
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const out = [];
  if (windDown.stop) {
    out.push(`⚠ ${windDown.message}`);
    out.push(
      '  If you take over as the new orchestrator: `queue.mjs orchestrator pulse --session "<new name>"` resets the wind-down.',
    );
    out.push('');
  }
  if (note) {
    out.push(`Handover note (${note.age} old, read whole): ${note.path}`);
    for (const l of note.excerpt.split('\n')) out.push(`  | ${l}`);
    out.push('');
  }
  out.push(
    `The queue last changed: ${report.queue_last_changed} ago${possibleLive ? '  ⚠ another orchestrator may be alive' : ''}`,
  );
  out.push(
    orchestrator.session
      ? `Orchestrator cursor: "${orchestrator.session}", updated ${age(orchestrator.age_ms)} ago` +
          `${orchestrator.event ? ` (${orchestrator.event})` : ''} → ${orchestrator.active ? 'ACTIVE' : 'expired (over 2 t)'}`
      : 'Orchestrator cursor: none (no orchestrator has checked in with queue.mjs orchestrator pulse)',
  );
  out.push(
    `Git: ${branch} @ ${head}, ${ahead} ahead / ${back} behind ${REMOVE}` +
      (indexLock ? `, ⚠ .git/index.lock ${indexLock} old` : ''),
  );
  if (environmentFile)
    out.push(
      `Migration environment (${environmentFile}): ${environment ?? 'not linked'}` +
        (environment != null && !allowedEnvironment.includes(environment) ? '  ⚠ not in migrations.allowedEnvironment' : ''),
    );
  out.push(
    effort?.level
      ? `Thinking level (orchestrator): ${effort.level}` +
          (effort.level === 'medium'
            ? ''
            : '  ⚠ not medium: ask the owner to confirm the level before the loop starts')
      : 'Thinking level (orchestrator): unknown (marker written on the next message)',
  );
  out.push('');
  out.push('Active tasks:');
  for (const a of activeOnes) {
    out.push(
      `  ${a.id.padEnd(12)} ${a.status.padEnd(7)} ${String(a.class).padEnd(3)} ${a.migr ? 'migr' : '    '} ` +
        `${String(a.commits).padStart(2)} commits, last ${a.last_commit}, started ${a.started}, ` +
        `uncommitted ${a.uncommitted ?? '-'}  → ${a.assessment}`,
    );
  }
  if (!activeOnes.length) out.push('  (none)');
  out.push('');
  // Picked tasks take no agent slot, but own their files; an "old" one is never released automatically (ask the owner).
  out.push('Picked (a person/session is doing them; no agent slot):');
  for (const p of picked) {
    out.push(
      `  ${p.id.padEnd(12)} ${String(p.class).padEnd(3)} by ${p.by ?? '?'}, picked ${p.picked} ago, ` +
        `${p.commits} commit(s)${p.last_commit ? `, last ${p.last_commit}` : ''}` +
        (p.old ? '  → OLD (over 72 h without commits; never released automatically)' : ''),
    );
  }
  if (!picked.length) out.push('  (none)');
  out.push(`QA list: ${t.qa} done task(s) waiting for the owner (queue.mjs qa).`);
  out.push('');
  out.push(
    `Waiting: ${t.waiting}. Can start now (${canStart.length}): ${canStart.join(', ') || '-'}`,
  );
  out.push('Owner questions that unlock the most:');
  for (const e of report.ownerQuestion) out.push(`  ${e.sp}: ${e.tasks} task(s)`);
  if (!report.ownerQuestion.length) out.push('  (none)');
  out.push('');
  out.push(`Work outside the queue (${outside.window}; details: queue.mjs external):`);
  for (const f of outside.error) out.push(`  ⚠ ${f}`);
  out.push(
    `  ${outside.external_commits.length} external commit(s) on ${BASE}, ${outside.branches.length} branch(es) outside ${K.branchPrefix}*, ` +
      `${outside.uncommitted_changed} uncommitted changed (+${outside.uncommitted_untracked} untracked) in mainTree, ` +
      `${outside.registered.length} registered (external add)`,
  );
  for (const c of outside.external_commits.slice(0, 5)) out.push(`    ${c.slice(0, 100)}`);
  if (outside.branches.length) out.push(`    branches: ${outside.branches.join(', ')}`);
  for (const r of outside.registered) out.push(`    registered: ${r}`);
  for (const s of outside.consistency) out.push(`    consistency: ${s}`);
  for (const k of outside.collisions_active.slice(0, 5))
    out.push(`    collision: ${k.slice(0, 110)}`);
  if (outside.collisions_pending)
    out.push(
      `    ${outside.collisions_pending} collision(s) with pending tasks (queue.mjs external)`,
    );
  out.push('  Push: run push-check.mjs first; external commits are never pushed without an owner answer.');
  console.log(out.join('\n'));
}
