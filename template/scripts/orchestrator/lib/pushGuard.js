// =============================================================
// pushGuard.js: pure logic for the PreToolUse hook hook-push-guard.mjs.
//
// WHY: a few commands are expensive or irreversible (push that rewrites shared history, push to the wrong branch,
// migrations against the wrong environment). A hook sees the command BEFORE it runs and can stop it with a reason,
// instead of the rule only living as text the agents can forget. Normal work is not blocked.
//
// Decisions (Claude Code PreToolUse: allow | ask | deny):
//   deny  forced push (--force, -f, --force-with-lease, +ref), on any branch: history is never rewritten.
//   deny  `git push` to a branch other than baseBranch (config().baseBranch), and --all/--mirror. Tracks are merged
//         locally; only baseBranch is pushed (in batches).
//   ask   `git push` where the branch cannot be determined (detached HEAD).
//   deny  the migration command (config().migrations.pushCommand) when the environment file (migrations.environmentFile)
//         exists and its contents are not in migrations.allowedEnvironment. If the file is missing, the guard has no say.
// Push to baseBranch is let through. The rule about pushing in batches (not per commit) is documentation
// (docs/orchestration.md), not a block.
//
// assess() is pure: takes the command and the context (current branch, the contents of the environment file) and does
// no I/O. Base branch and migration setup come from config() only when the context does not give them.
// =============================================================

const fs = require('node:fs');
const path = require('node:path');

/** Split a shell command into parts on ; && || | and newlines (good enough for a guard; not a full parser). */
function parts(command) {
  return String(command || '')
    .split(/\r?\n|&&|\|\||;|\|/)
    .map((d) => d.trim())
    .filter(Boolean);
}

/** Simple tokens: whitespace split, remove surrounding quotes. */
function tokens(chunk) {
  return (chunk.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^(["'])(.*)\1$/, '$2'));
}

/**
 * Find the git subcommand in a token list, skipping global options (-C <path>, -c k=v, --no-pager ...).
 * Returns { sub, args } or null.
 */
function gitCall(t) {
  // Allow prefixes such as env vars (FOO=bar git push) and "command"/"exec".
  let i = 0;
  while (
    i < t.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i]) || ['command', 'exec', 'env'].includes(t[i]))
  )
    i++;
  if (!/(^|[\\/])git(\.exe)?$/.test(t[i] || '')) return null;
  i++;
  while (i < t.length && t[i].startsWith('-')) {
    if (t[i] === '-C' || t[i] === '-c' || t[i] === '--git-dir' || t[i] === '--work-tree') i += 2;
    else i++;
  }
  if (i >= t.length) return null;
  return { sub: t[i], args: t.slice(i + 1) };
}

/**
 * Which branches does a `git push` with these arguments match?
 * Returns { template: [branch], force, all } (all = --all/--mirror, i.e. all branches).
 */
function pushTemplate(args, currentBranch) {
  let force = false;
  let all = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (
      a === '--force' ||
      a === '-f' ||
      a.startsWith('--force-with-lease') ||
      a === '--force-if-includes'
    )
      force = true;
    else if (a === '--all' || a === '--mirror') all = true;
    else if (a === '-o' || a === '--push-option' || a === '--repo' || a === '--receive-pack') i++;
    else if (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(a))
      force = true; // e.g. -uf
    else if (!a.startsWith('-')) pos.push(a);
  }
  const refspecs = pos.slice(1); // first positional is the remote
  if (all) return { template: [], force, all };
  if (refspecs.length === 0)
    return { template: currentBranch ? [currentBranch] : ['<unknown>'], force, all };
  const template = refspecs.map((r) => {
    let x = r;
    if (x.startsWith('+')) {
      force = true;
      x = x.slice(1);
    }
    const dst = x.includes(':') ? x.split(':').pop() : x;
    const name = dst.replace(/^refs\/heads\//, '');
    return name === 'HEAD' || name === '' ? currentBranch || '<unknown>' : name;
  });
  return { template, force, all };
}

/** Programs that only start another program (npx foo, npm exec foo): skipped when commands are compared. */
const STARTERS = new Set(['npx', 'pnpx', 'bunx', 'exec', 'env', 'command', 'npm', 'pnpm', 'yarn']);

/**
 * The core of a command: the words that are not options, without starters and env prefixes in front.
 * "npx dbTool migrate push --yes" gives ['dbTool', 'migrate', 'push'].
 */
function core(t) {
  const out = [];
  for (const x of t) {
    if (x.startsWith('-')) continue;
    if (out.length === 0 && (STARTERS.has(x) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(x))) continue;
    out.push(x.replace(/\.(exe|cmd)$/i, '').replace(/^.*[\\/]/, ''));
  }
  return out;
}

/** Is `candidate` (token list) a run of `command` (text)? The core words must be contiguous. */
function isCommand(candidate, command) {
  const k = core(tokens(String(command || '')));
  if (k.length === 0) return false;
  const c = core(candidate);
  for (let i = 0; i + k.length <= c.length; i++) {
    if (k.every((word, j) => c[i + j] === word)) return true;
  }
  return false;
}

/** The config values the guard needs, from the context or (by default) from config(). */
function values(context) {
  let k = null;
  const get = () => {
    if (!k) k = require('./queueConfig.js').config();
    return k;
  };
  const baseBranch = context.baseBranch ?? get().baseBranch;
  const migrations = context.migrations ?? get().migrations ?? {};
  return { baseBranch, migrations };
}

/**
 * Assess one command.
 * context: {
 *   branch: string|null            current branch,
 *   environment: string|null           the contents of migrations.environmentFile (trimmed), null when the file does not exist,
 *   baseBranch?: string            default config().baseBranch,
 *   migrations?: { pushCommand, environmentFile, allowedEnvironment }   default config().migrations,
 * }
 * Returns null (no decision) or { decision: 'ask'|'deny', reason }.
 * With several matches the strictest wins (deny over ask).
 */
function assess(command, context = {}) {
  const { baseBranch, migrations } = values(context);
  const findings = [];
  for (const chunk of parts(command)) {
    const t = tokens(chunk);

    const g = gitCall(t);
    if (g && g.sub === 'push') {
      const { template, force, all } = pushTemplate(g.args, context.branch || null);
      if (force) {
        findings.push({
          decision: 'deny',
          reason:
            'Forced push is forbidden: shared history is never rewritten. Merge instead, and push normally.',
        });
      } else if (all) {
        findings.push({
          decision: 'deny',
          reason: `\`git push --all/--mirror\` pushes all branches. Only baseBranch (${baseBranch}) is pushed.`,
        });
      } else {
        const others = template.filter((m) => m !== baseBranch && m !== '<unknown>');
        if (others.length > 0) {
          findings.push({
            decision: 'deny',
            reason: `Push of ${others.join(', ')} is blocked: only baseBranch (${baseBranch}) is pushed, and in batches. Track branches are merged locally.`,
          });
        } else if (template.includes('<unknown>')) {
          findings.push({
            decision: 'ask',
            reason: `Could not determine which branch is pushed. Confirm that it is baseBranch (${baseBranch}).`,
          });
        }
      }
    }

    if (
      migrations.pushCommand &&
      migrations.environmentFile &&
      isCommand(t, migrations.pushCommand)
    ) {
      const environment = context.environment;
      const allowedOnes = Array.isArray(migrations.allowedEnvironment) ? migrations.allowedEnvironment : [];
      if (environment !== null && environment !== undefined && !allowedOnes.includes(environment)) {
        findings.push({
          decision: 'deny',
          reason:
            `Migration push to "${environment}" is blocked: ${migrations.environmentFile} points to an environment that is not in ` +
            `migrations.allowedEnvironment (${allowedOnes.length ? allowedOnes.join(', ') : 'empty list'}). Link to the correct environment first.`,
        });
      }
    }
  }
  if (findings.length === 0) return null;
  return findings.find((f) => f.decision === 'deny') || findings[0];
}

/**
 * Reads the environment file (migrations.environmentFile, relative to the root). Tries `rotate` in order (the worktree
 * first, then mainTree, since the file is often gitignored and only lives in mainTree). Gives trimmed content or null.
 * @param {string[]} rotate
 * @param {string|null} environmentFile
 */
function readEnvironment(rotate, environmentFile) {
  if (!environmentFile) return null;
  for (const root of rotate.filter(Boolean)) {
    try {
      return fs.readFileSync(path.resolve(root, environmentFile), 'utf8').trim();
    } catch {
      // not here; try the next
    }
  }
  return null;
}

module.exports = { assess, readEnvironment, isCommand };
