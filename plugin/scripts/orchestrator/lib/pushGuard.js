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
// Network guard for the queue's agents (hardening against prompt injection). Applies ONLY when the hook payload has an
// agent_type that is a track (track, track-d) or a reviewer or helper agent, builtin or custom (the same list as the read
// guard, trackGuard.js queueAgentTypes; also with the plugin prefix, "cq:track", "cq:reviewer"). None of them needs the
// network. The orchestrator (the main session, the field is missing), other agent types and the owner are not affected:
//   deny  curl, wget, Invoke-WebRequest/iwr, Invoke-RestMethod/irm, Start-BitsTransfer as a command (also inside
//         `powershell -c "…"`, `bash -c "…"`, `$(…)` and `(…)`), and a pipe into a shell (`| sh`, `| bash`, `| iex` …).
//   ask   npm install/i/add and npx/npm exec with a package name that is not in package.json (and not in
//         node_modules/.bin): it fetches and runs code from the network.
//   The reason points the way: "Network calls are blocked for queue agents; ask the orchestrator to fetch it."
//   Known gaps (on purpose, lightweight): `node -e "fetch(…)"`, `git clone`, .NET classes in PowerShell. The guard is
//   an extra layer; the merge guard (mergeGuard.js) and "data, not instructions" in the agent definitions are the others.
//
// assess() is pure: takes the command and the context (current branch, the contents of the environment file, the
// agent type, the known packages) and does no I/O. Base branch and migration setup come from config() only when the
// context does not give them.
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

// ---- Network guard for the queue's agents ---------------------------------------------------------------------------

/** The track agent types (the hook payload's agent_type, without a plugin prefix). Always network guarded. */
const TRACK_AGENT_TYPES = new Set(['track', 'track-d']);
/** The agent type without a plugin prefix ("cq:reviewer" -> "reviewer"). */
const bare = (agentType) => String(agentType || '').replace(/^.*:/, '');
const isTrackAgent = (agentType) => TRACK_AGENT_TYPES.has(bare(agentType));

/**
 * Is this agent type network guarded? Tracks, plus every reviewer and helper agent (builtin and custom): the same list
 * the read guard uses (trackGuard.js queueAgentTypes). None of them ever needs the network, and a custom helper with
 * Bash could otherwise reach it. The main session (the orchestrator) has no agent_type and is never guarded.
 * @param {string|null|undefined} agentType  the hook payload's agent_type
 * @param {Set<string>} [types]  the guarded types; default track/track-d + queueAgentTypes() (reads the config)
 */
function isGuardedAgent(agentType, types) {
  const t = bare(agentType);
  if (!t) return false;
  if (TRACK_AGENT_TYPES.has(t)) return true;
  let set = types;
  if (!set) {
    try {
      set = require('./trackGuard.js').queueAgentTypes();
    } catch {
      set = new Set(); // fails open to the tracks only
    }
  }
  return set.has(t);
}

const NETWORK_REASON = 'Network calls are blocked for queue agents; ask the orchestrator to fetch it.';
/** Command words (lower case, without path and .exe) that fetch from or send to the network. */
const NETWORK_COMMANDS = new Set([
  'curl',
  'wget',
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'start-bitstransfer',
]);
/** Shells and eval: a pipe into one runs what came in (typically a downloaded script). */
const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'iex',
  'invoke-expression',
  'pwsh',
  'powershell',
  'cmd',
]);

/**
 * Split a command into segments, respecting quotes. Splits on ; && || | & newline ( ) { } ` and $( .
 * Each segment gets { text, afterPipe } (afterPipe = the segment comes right after a single "|").
 * @param {string} command
 */
function segments(command) {
  const s = String(command || '');
  const out = [];
  let buf = '';
  let quote = null;
  let afterPipe = false;
  const cut = (nextAfterPipe) => {
    if (buf.trim()) out.push({ text: buf.trim(), afterPipe });
    buf = '';
    afterPipe = nextAfterPipe;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === '|') {
      if (s[i + 1] === '|') {
        i++;
        cut(false);
      } else cut(true);
      continue;
    }
    if (c === '&') {
      if (s[i + 1] === '&') i++;
      cut(false);
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      i++;
      cut(false);
      continue;
    }
    if (';\n\r(){}`'.includes(c)) {
      cut(false);
      continue;
    }
    buf += c;
  }
  cut(false);
  return out;
}

/** The command word in a token: without path, without .exe/.cmd/.bat/.ps1, lower case. */
const commandWord = (t) =>
  String(t || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();

/** Skip env prefixes (FOO=bar), "command", "exec", "env", "sudo" and PowerShell assignment ($x = …). */
function firstWordIndex(t) {
  let i = 0;
  for (;;) {
    if (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
    else if (i < t.length && ['command', 'exec', 'env', 'sudo', 'nohup', 'time'].includes(t[i])) i++;
    else if (i + 1 < t.length && /^\$[A-Za-z_][\w:]*$/.test(t[i]) && t[i + 1] === '=') i += 2;
    else if (i < t.length && /^\$[A-Za-z_][\w:]*=$/.test(t[i])) i++;
    else return i;
  }
}

/** The name in an npm package spec: "@scope/name@1.2" gives "@scope/name", "name@^1" gives "name". null = path/URL/git. */
function packageName(spec) {
  const s = String(spec || '');
  if (!s || /^(\.|\/|~|[A-Za-z]:[\\/])/.test(s) || /:/.test(s) || /\.(tgz|tar\.gz)$/.test(s)) return null;
  if (s.startsWith('@')) {
    const m = s.match(/^(@[^/@\s]+\/[^@\s]+)/);
    return m ? m[1] : null;
  }
  if (s.includes('/')) return null; // GitHub short form (user/repo)
  return s.split('@')[0] || null;
}

/** The packages npx fetches: -p/--package <pkg>, otherwise the first positional argument (the command). */
function npxPackages(args) {
  const out = [];
  let first = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      if (!first && args[i + 1]) first = args[i + 1];
      break;
    }
    if (a === '-p' || a === '--package') {
      if (args[i + 1]) out.push(args[i + 1]);
      i++;
    } else if (a.startsWith('--package=')) out.push(a.slice('--package='.length));
    else if (a.startsWith('-')) continue;
    else {
      first = a;
      break;
    }
  }
  // With -p the positional one is a bin name in the package, not a new package.
  if (out.length === 0 && first) out.push(first);
  return out;
}

/** The packages an npm install/npx command will fetch that are not known. */
function unknownPackages(t, i0, knownPackage) {
  const word = commandWord(t[i0]);
  const rest = t.slice(i0 + 1);
  const specs = [];
  if (word === 'npm' || word === 'pnpm' || word === 'yarn') {
    const sub = rest.find((x) => !x.startsWith('-'));
    const after = rest.slice(rest.indexOf(sub) + 1);
    if (['install', 'i', 'add', 'in', 'isntall'].includes(sub)) {
      for (const x of after) if (!x.startsWith('-')) specs.push(x);
    } else if (sub === 'exec' || sub === 'dlx' || (word === 'pnpm' && sub === 'x')) {
      specs.push(...npxPackages(after));
    } else return [];
  } else if (word === 'npx' || word === 'bunx' || word === 'pnpx') {
    specs.push(...npxPackages(rest));
  } else return [];
  const known = typeof knownPackage === 'function' ? knownPackage : () => false;
  return specs.filter((x) => {
    const name = packageName(x);
    return !name || !known(name);
  });
}

/** Assess the network guard for one command (called only for guarded agents, isGuardedAgent). Returns a list of findings. */
function assessNetwork(command, context, depth = 0) {
  const findings = [];
  for (const seg of segments(command)) {
    const t = tokens(seg.text);
    const i0 = firstWordIndex(t);
    if (i0 >= t.length) continue;
    const word = commandWord(t[i0]);
    if (NETWORK_COMMANDS.has(word)) {
      findings.push({ decision: 'deny', reason: `\`${t[i0]}\`: ${NETWORK_REASON}` });
      continue;
    }
    if (seg.afterPipe && SHELLS.has(word)) {
      findings.push({
        decision: 'deny',
        reason: `Pipe into a shell (\`| ${t[i0]}\`) runs text as code. ${NETWORK_REASON}`,
      });
      continue;
    }
    // The inner command in `bash -c "…"`, `powershell -Command "…"`, `cmd /c "…"`: assess it too.
    if (SHELLS.has(word) && depth < 3) {
      const j = t.findIndex(
        (x, k) => k > i0 && /^(-c|-command|\/c|\/k|-encodedcommand|-e|-ec)$/i.test(x),
      );
      if (j > 0) {
        if (/^-(encodedcommand|e|ec)$/i.test(t[j]) && ['pwsh', 'powershell'].includes(word)) {
          findings.push({
            decision: 'deny',
            reason: `An encoded PowerShell command (${t[j]}) cannot be assessed. ${NETWORK_REASON}`,
          });
        } else if (t[j + 1]) findings.push(...assessNetwork(t.slice(j + 1).join(' '), context, depth + 1));
      }
      continue;
    }
    const unknown = unknownPackages(t, i0, context.knownPackage);
    if (unknown.length > 0) {
      findings.push({
        decision: 'ask',
        reason: `\`${t[i0]}\` fetches a package that is not in package.json (${unknown.join(', ')}). ${NETWORK_REASON}`,
      });
    }
  }
  return findings;
}

/**
 * Assess one command.
 * context: {
 *   branch: string|null            current branch,
 *   environment: string|null           the contents of migrations.environmentFile (trimmed), null when the file does not exist,
 *   baseBranch?: string            default config().baseBranch,
 *   migrations?: { pushCommand, environmentFile, allowedEnvironment }   default config().migrations,
 *   agentType?: string|null        the hook payload's agent_type; tracks, reviewers and helpers get the network guard,
 *   knownPackage?: (name) => bool  is the npm package known (package.json or node_modules/.bin)? Only for guarded agents,
 *   guardedTypes?: Set<string>    the guarded agent types beyond track/track-d; default trackGuard.queueAgentTypes().
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
  // The network guard applies to the queue's agents: tracks, reviewers and helper agents (never the orchestrator).
  if (isGuardedAgent(context.agentType, context.guardedTypes)) findings.push(...assessNetwork(command, context));
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

module.exports = {
  assess,
  readEnvironment,
  isCommand,
  isTrackAgent,
  isGuardedAgent,
  segments,
  TRACK_AGENT_TYPES,
};
