#!/usr/bin/env node
// =============================================================
// queue-board.mjs: local kanban board for the work queue (see docs/board.md).
//
// A small Node server (built-in modules only) that shows the queue as a board in the browser: In queue, In progress, Review and
// Built. The owner can drag cards to reprioritize, drag project lanes, pick, release, approve QA and pause projects.
//
//   node scripts/orchestrator/queue-board.mjs [--port <nr>]
//
// The port is config().board.port (default 2000) from queue.config.json; --port overrides it. The title is
// config().board.title and config().projectName. Prints a link with a random key (new for every run).
// Open it in the browser; Ctrl+C stops the board.
//
// How the board stays equal to the queue:
//   - READING: queue.json + the pure rules in lib/queueLogic.js (priority, project, blockers, limits) via
//     lib/queueBoard.js. No copy of its own of the rules.
//   - WRITING: only via the queue.mjs commands (edit, project, edit-many, pick, release, qa ok|deviation, batch pack), so
//     the lock, the atomic write and the validation are the same as elsewhere. The board never writes queue.json itself.
//     Writes run one at a time.
//   - COLORS: the neutral palette (light and dark) in lib/queueBoard.js is served as CSS variables (/theme.css).
//   - STATISTICS: queue.json and the time log (read only) are aggregated by the pure functions in lib/queueStatistics.js.
//     The time log is read again only when mtime or size has changed, and the result is cached until queue.json, the time log
//     or the date changes.
//   - SETTINGS: the limits are written with `queue.mjs limit <name> <val>` (same lock and validation); the setup
//     (migrations when they are turned on, orchestrator, model, hooks and skills) is read only.
//   - GUARD RULES: every write call runs queueBoard.assess first. stop → 422, warning → 409 until the call sends
//     `confirm: true`, info → the action is done and the texts are sent with the response. queue.mjs still refuses on its own.
//   - MASCOT: GET /mascot sends the phrases from the optional <dataFolder>/mascot-phrases.json (or the neutral default
//     set), and the state has `mascot` ({ mode, file }) and `mascotNumbers` (lib/queueMascot.js). The mode is
//     board.mascot in queue.config.json ("chatty", "events" or "off"); --mascot <mode> overrides it. "off" turns the
//     speech bubble off for every viewer.
//   - DEPENDENCIES: the graph with circles and strokes is computed in the browser by lib/queueGraph.js (served as /queueGraph.js) from
//     the same state, once per version and filter, so the search and the filter menu work the same.
//   - WAITING ON YOU: the state has `inbox` (owner question, QA, proposed, what is stuck) and `next` ("Next up").
//     Answers go via `queue.mjs resolve <id> --answer … --by owner`, QA ok and approve for several via `queue.mjs qa ok <id…>` and
//     `queue.mjs approve <id…>`.
//   - CLOUD: the cards in the queue and in cloud sessions get queueLogic.cloudSuitable (<remote>/<baseBranch> and local changes are read with git,
//     at most every minute). "Copy cloud package" fetches /api/cloudPackage (= `queue.mjs cloud-package <id>`), and "Started in cloud",
//     "Completed in cloud" and "Cancel cloud" go via `queue.mjs cloud start|done|cancel`.
//   - MULTI_SELECT: POST /api/bulk { action, ids, val, dry, expect, confirm } is translated by queueBoard.bulkPlan to
//     `queue.mjs edit-many`, `rank` or `batch pack`. dry = preview (--dry, or
//     queueBoard.packPreview on a copy), otherwise it is written with --expect-changed (exit 6 → 409 outdated).
//     POST /api/undo { show? , nr? } = `queue.mjs undo [--show] [--nr <n>] --json`.
//   - PLANS (see docs/plan-register.md): the Plans workspace (queue-board/plans/). GET /api/plans reads plans.json and
//     queue.json (read only) and sends what queuePlanView.plansData makes, with a version so unchanged data is not sent
//     again. The same response has the document register for the Documents and agreements view. The priority map saves a draft with
//     POST /api/plan-prioritize (dry = preview), which runs one `queue.mjs plan prioritize-many --file …
//     --set-by owner` with --expect-changed (one save is one changelog entry and one undo).
//     GET /api/doc?path=… reads one markdown document for the reading view (the allowlist is in queuePlanView.readPathError,
//     the path guard against .., hidden files, symlinks and other file types in queueBoard.readDocument). GET /api/plan-check gives the
//     unregistered documents (queue.mjs plan check), and POST /api/plan-new and /api/plan-source run `queue.mjs plan new`
//     and `plan edit <id> --set {sources}` with --set-by owner, --dry and --expect-changed.
//     The Legal, Decisions and Launch views read the same data. An answer to an owner question goes via
//     POST /api/action { type: 'resolve' } (= `queue.mjs resolve`), and POST /api/lawyerPackage writes a draft locally
//     (dry = preview; never sent).
//     POST /api/plan-bulk runs `queue.mjs plan prioritize|edit|combine` (dry = preview, otherwise
//     --expect-changed, all or nothing), POST /api/plan-undo undoes what the board just saved (`plan undo --nr`),
//     and GET /api/plans?wait=1 waits until plans.json or queue.json changes (live update, fs.watch).
//
// Security (another web page in the same browser must not be able to read or edit the queue):
//   - listens only on 127.0.0.1,
//   - every /api/ call requires the key in the X-Queue-Key header (the link carries it in the # part, which is never sent to
//     the server or leaked in Referer),
//   - Host must be 127.0.0.1:<port> or localhost:<port> (stops DNS rebinding), and a write call with Origin must
//     come from the board itself and have Content-Type application/json,
//   - strict Content-Security-Policy: only our own files, no CDN, no inline script.
//
// Environment (as queue.mjs): QUEUE_FOLDER (the queue's folder, smoke test against a copy), QUEUE_GIT (the repo branches are counted in, and where
// the migrations folder and .claude/settings.json are read), QUEUE_TIME_LOG (the time log), QUEUE_PLAN_SOURCE_ROOT (the root documents
// are read from).
// =============================================================

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const require = createRequire(import.meta.url);
const T = require('./lib/queueBoard.js');
const G = require('./lib/queueGit.js');
const L = require('./lib/queueLogic.js');
const S = require('./lib/queueStatistics.js');
const TK = require('./lib/timeCost.js');
// The Plans space. The register is read with queuePlan.js, and what the board needs is made by queuePlanView.js (read only).
const P = require('./lib/queuePlan.js');
const PRIVACY = require('./lib/queuePlanView.js');
const KK = require('./lib/queueConfig.js');
// The mascot's rules (the same file the browser gets at /queueMascot.js) and the weekly quota (the forecast).
const M = require('./lib/queueMascot.js');
const KAP = require('./lib/queueCapacity.js');

const CONFIG = KK.config();
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The project root (two folders above scripts/orchestrator/). The queue lives in the main tree, as for queue.mjs: if the board runs from a
// worktree, config().root already points to the main tree.
const ROOT = require('./lib/projectRoot.js').roots().tree;
const MAIN_TREE = CONFIG.root;
const FOLDER = KK.dataFolder();
const FILE = path.join(FOLDER, 'queue.json');
const CURSOR = path.join(FOLDER, 'orchestrator.json');
const PLAN_FILE = path.join(FOLDER, 'plans.json');
// Documents in the reading view live in the main tree, like the source paths in the plan register (same env var as queue.mjs).
const SOURCE_ROOT = process.env.QUEUE_PLAN_SOURCE_ROOT ?? MAIN_TREE;
const GIT_ROOT = process.env.QUEUE_GIT ?? MAIN_TREE;
const TIME_LOG = KK.timeLog();
const QUEUE_MJS = path.join(HERE, 'queue.mjs');
const CLIENT = path.join(HERE, 'queue-board');
// Base branch (the integration branch) and the remote, for "commits ahead" and "changed since push".
const BASE = String(CONFIG.baseBranch ?? 'main');
const REMOTE = String(CONFIG.remote ?? 'origin');
// The title in the browser and at the top of the board.
const TITLE = T.boardTitle(CONFIG);

const a = process.argv.slice(2);
const val = (name) => {
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : undefined;
};
if (a.includes('--help') || a.includes('-h')) {
  console.log(
    `Kanban board for the work queue.\n\n  ${require('./lib/projectRoot.js').cqCommand()} board [--port <nr>] [--mascot chatty|events|off]\n\n` +
      `The default port is board.port in queue.config.json (now ${CONFIG.board?.port ?? 2000}).\n` +
      `The mascot's speech bubble is board.mascot in queue.config.json (now ${CONFIG.board?.mascot ?? 'chatty'}); ` +
      '--mascot off turns it off for every viewer.\n' +
      'Open the link it prints (the key is new for every run). Ctrl+C stops the board.',
  );
  process.exit(0);
}
const PORT = Number(val('--port') ?? CONFIG.board?.port ?? 2000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('--port must be an integer between 1 and 65535');
  process.exit(1);
}
// The mascot mode: --mascot overrides board.mascot. "off" = no speech bubble at all, for every viewer.
const MASCOT_INPUT = val('--mascot') ?? CONFIG.board?.mascot ?? M.DEFAULT_MODE;
const MASCOT_MODE = M.normalizeMode(MASCOT_INPUT);
if (!MASCOT_MODE) {
  console.error(`--mascot / board.mascot must be one of ${M.MODES.join(', ')} (got "${MASCOT_INPUT}")`);
  process.exit(1);
}
const HOST = '127.0.0.1';
const KEY = crypto.randomBytes(24).toString('base64url');
const VALID_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const VALID_ORIGIN = new Set([...VALID_HOSTS].map((v) => `http://${v}`));

// ---- The colors (the neutral palette in lib/queueBoard.js) ----------------------------------------------------------
const THEME_CSS = T.themeCss(T.PALETTE);

// ---- Git (uncommitted files in the main tree, the branches <branchPrefix><id>) ----------------------------------
const gitRead = G.makeGit(GIT_ROOT);
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;
const BRANCH_PREFIX = String(CONFIG.branchPrefix ?? 'queue/');
/** The branch a task is built on: `branch` in the queue, otherwise <branchPrefix><id>. */
const branchFor = (o) => o.branch ?? `${BRANCH_PREFIX}${o.id}`;

/** Commits ahead of baseBranch on the branch and the time of the last one (the same question queue.mjs asks). */
function branchInfo(branch) {
  if (!BRANCH_PATTERN.test(branch)) return { exists: false, commits: 0, lastCommit: null };
  if (gitRead(['rev-parse', '-q', '--verify', `refs/heads/${branch}`]) == null)
    return { exists: false, commits: 0, lastCommit: null };
  const commits = Number(String(gitRead(['rev-list', '--count', `${BASE}..${branch}`]) ?? '0').trim());
  const last = commits > 0 ? String(gitRead(['log', '-1', '--format=%cI', branch]) ?? '').trim() : '';
  return { exists: true, commits: commits || 0, lastCommit: last || null };
}

// git status in a large repo takes time: read it again at most every minute.
// At the same time <remote>/<baseBranch> is read, and the paths changed locally since it (for "Suitable for cloud").
let gitStatus = { time: 0, uncommitted: [], error: false, pushedHead: null, sincePush: [] };
function uncommitted() {
  if (Date.now() - gitStatus.time > 60_000) {
    const u = G.readUncommitted(gitRead);
    const pushedHead =
      String(gitRead(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${BASE}`]) ?? '').trim() ||
      null;
    const sincePush = pushedHead
      ? String(gitRead(['diff', '--name-only', `refs/remotes/${REMOTE}/${BASE}...${BASE}`]) ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    gitStatus = {
      time: Date.now(),
      uncommitted: u ? u.map((x) => x.path) : [],
      error: u == null,
      pushedHead,
      sincePush,
    };
  }
  return gitStatus;
}

// ---- The logo ---------------------------------------------------------------------------------------------------
// The project can put its own logo in the queue folder (logo.webp, logo.png or logo.svg, same folder as queue.json, so
// QUEUE_FOLDER applies). If none exists there, the bundled image is shown (queue-board/logo.webp). Keeping it is a friendly
// request (see "About the logo" in the README), so the default setup always shows it.
const LOGO_TYPES = [
  ['logo.webp', 'image/webp'],
  ['logo.png', 'image/png'],
  ['logo.svg', 'image/svg+xml'],
];
const STANDARD_LOGO = { path: path.join(CLIENT, 'logo.webp'), type: 'image/webp' };
/** The first logo file in the queue folder, otherwise the bundled one (null only if that is missing too). */
function findLogo() {
  for (const [file, type] of LOGO_TYPES) {
    const filePath = path.join(FOLDER, file);
    try {
      if (fs.statSync(filePath).isFile()) return { path: filePath, type };
    } catch {
      /* does not exist */
    }
  }
  try {
    if (fs.statSync(STANDARD_LOGO.path).isFile()) return STANDARD_LOGO;
  } catch {
    /* missing in the installation */
  }
  return null;
}

// ---- The mascot's phrases (optional, in the gitignored queue folder next to the logo, never in the repo) -------------
const MASCOT_FILE = path.join(FOLDER, 'mascot-phrases.json');
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
let mascotLogged = null; // mtime of the file the last time it was invalid (one line in the log per version of the file)
/** The phrases for /mascot: the file validated with queueMascot.readPhrases; missing or invalid gives the default set. */
function mascotPhrases() {
  let text = null;
  let mtime = null;
  try {
    text = fs.readFileSync(MASCOT_FILE, 'utf8');
    mtime = fs.statSync(MASCOT_FILE).mtimeMs;
  } catch {
    return M.DEFAULT; // no file: the default set
  }
  const r = M.readPhrases(text);
  if (r.error && mascotLogged !== mtime) {
    mascotLogged = mtime;
    console.log(
      `${new Date().toLocaleTimeString('en-GB')} mascot-phrases.json: ${r.error}, using the default set`,
    );
  }
  return r.phrases;
}
// The usage from the time log (night cost and the weekly quota), computed again only when the time log has changed.
let usageCache = { key: null, list: [] };
function usage() {
  const log = timeLogRows();
  if (usageCache.key !== log.key) usageCache = { key: log.key, list: TK.usageEvents(log.rows) };
  return usageCache.list;
}
/** The summary the mascot fills its placeholders from (queueMascot.numbers). null on error (the mascot skips numbers). */
function mascotNumbers(queue) {
  try {
    const events = usage();
    let quotaPct = null;
    // Only with a calibrated weekly quota (queue.mjs capacity); otherwise {p} and "quota-90" are skipped.
    if (queue.capacity?.usd_per_100 != null || queue.capacity?.calibrations?.length) {
      try {
        quotaPct = KAP.forecast({ queue, events }).pct;
      } catch {
        quotaPct = null;
      }
    }
    return M.numbers(queue, { events, quotaPct });
  } catch {
    return null;
  }
}

// ---- The state (cheap: rebuilt only when queue.json, git status or the logo has changed) -----------------------------
// git status is read again every minute, so the state (age, night pause, "Next up") is recomputed at least that often.
let quick = null;
function state() {
  const mtime = fs.statSync(FILE).mtimeMs;
  const g = uncommitted();
  const logo = findLogo() != null;
  const mascotFile = MASCOT_MODE !== 'off' && isFile(MASCOT_FILE);
  // With a daily quota, "Next up" needs today's usage (the time log, via the cached statistics).
  const stat = quick?.budget ? statistics().version : null;
  if (
    quick &&
    quick.mtime === mtime &&
    quick.gitTime === g.time &&
    quick.logo === logo &&
    quick.mascotFile === mascotFile &&
    quick.stat === stat
  )
    return quick;
  const queue = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const branches = {};
  for (const o of queue.tasks ?? []) {
    if (o.status !== 'picked') continue;
    const branch = branchFor(o);
    branches[branch] = branchInfo(branch);
  }
  const budget = queue.limits?.dailyBudget != null;
  const s = budget ? statistics() : null;
  // The board shows the queue as if done focus stages were already taken out (queueLogic.focusWithoutDone; nothing
  // is written, that is done by queue.mjs focus clean and receive/set/fill). The whole board is computed on the same
  // focus, so the stage numbers on the cards match the focus line.
  let focusEval = null;
  let showQueue = queue;
  try {
    const fe = L.focusWithoutDone(queue);
    focusEval = new Map(fe.evaluation.map((t) => [t.stage, t]));
    if (fe.focus) showQueue = { ...queue, focus: fe.focus };
  } catch (e) {
    console.error(`the focus evaluation failed: ${e?.message ?? e}`);
  }
  const data = {
    ...T.board(showQueue, {
      uncommitted: g.uncommitted,
      branches,
      branchPrefix: BRANCH_PREFIX,
      // Aging work against p85 for the class (only from queue.json).
      ageLimits: S.ageBounds(queue),
      dailyUsage: s?.data.keyFigures.usageToday,
      // Suitability with the same rules as queue.mjs cloud-package (queueLogic.cloudSuitable).
      cloud: {
        pushedHead: g.pushedHead,
        changed: [...g.sincePush, ...g.uncommitted],
        mission: missionFor,
      },
    }),
    gitError: g.error,
    logo,
    // The mascot: the mode, whether the phrase file exists (the board fetches /mascot again when it appears), and the
    // numbers for the placeholders. With mode off nothing is computed.
    mascot: { mode: MASCOT_MODE, file: mascotFile },
    mascotNumbers: MASCOT_MODE === 'off' ? null : mascotNumbers(queue),
    title: TITLE,
    baseBranch: BASE,
  };
  // Each stage gets status and rests; a stage with only rests shows them in the title (the focus line and the cards
  // read the title), not as an empty stage.
  if (focusEval && Array.isArray(data.focus?.stage))
    data.focus.stage = data.focus.stage.map((t) => {
      const e = focusEval.get(t.stage);
      if (!e) return t;
      const extra = { status: e.status, rests: e.rests, open: e.open };
      if (e.status === 'done-with-rests') {
        const types = new Map();
        for (const r of e.rests) types.set(r.type, (types.get(r.type) ?? 0) + 1);
        const text = [...types].map(([type, n]) => `${n} ${type}`).join(', ');
        return { ...t, ...extra, title: `${t.title} (done, rests: ${text})` };
      }
      if (e.status === 'done') return { ...t, ...extra, title: `${t.title} (done)` };
      return { ...t, ...extra };
    });
  const version = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16);
  quick = {
    mtime,
    gitTime: g.time,
    logo,
    mascotFile,
    budget,
    stat: s?.version ?? null,
    version,
    data,
  };
  return quick;
}

// ---- The statistics: the time log is read only when it has changed, the result is cached -------------
let logCache = { key: null, rows: [], error: null };
function timeLogRows() {
  let st;
  try {
    st = fs.statSync(TIME_LOG);
  } catch (e) {
    return { key: 'missing', rows: [], error: e?.code ?? 'does not exist' };
  }
  const key = `${st.mtimeMs}:${st.size}`;
  if (logCache.key !== key) {
    // Only the "done" rows are needed (usage and context); the gate rows (most of them) are dropped at once.
    const rows = TK.readRows(fs.readFileSync(TIME_LOG, 'utf8')).filter(
      (r) => r?.event === 'done',
    );
    logCache = { key, rows, error: null };
  }
  return logCache;
}

let statCache = null;
function statistics() {
  const log = timeLogRows();
  const key = `${log.key}|${fs.statSync(FILE).mtimeMs}|${TK.dayFor(new Date().toISOString())}`;
  if (statCache?.key === key) return statCache;
  const queue = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const data = { ...S.statistics(queue, log.rows), timeLogError: log.error };
  const version = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16);
  statCache = { key, version, data };
  return statCache;
}

// ---- The plan register: read only, rebuilt when plans.json or queue.json changes (or every minute,
// so "stale" and "Working now" expire on their own). Writing to the register never goes via the board in this track.
let planCache = null;
function plans() {
  const mt = (f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  const key = `${mt(PLAN_FILE)}|${mt(FILE)}|${Math.floor(Date.now() / 60_000)}`;
  if (planCache?.key === key) return planCache;
  const reg = fs.existsSync(PLAN_FILE)
    ? P.normalize(JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')))
    : P.emptyRegister();
  const queue = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
  const now = new Date();
  const fk = L.rankingContext(queue, now.getTime());
  // The column and focus stage for a queue task (same rules as the cards on the board, queueBoard.board).
  const queueInfo = (o) => {
    const column = o.id ? T.columnFor(o) : null;
    if (column !== 'queue') return { column, applies: fk.applies };
    const p = L.focusSpace(o, fk);
    const stage = p.step != null ? queue.focus?.order?.[p.step] : null;
    return {
      column,
      applies: fk.applies,
      step: p.step,
      outside: fk.applies ? p.outside : false,
      step_title: stage ? L.stepTitle(stage, queue) : null,
    };
  };
  // The pace for the capacity figure on the overview (finished queue tasks per week, as `plan check`).
  const window = P.CAPACITY_WINDOW_DAYS ?? 28;
  const donePerWeek =
    S.doneInWindow(queue, S.daysBackward(now.getTime(), window)).length / (window / 7);
  const data = {
    ...PRIVACY.plansData(reg, queue, { now, queueInfo, queuePlan: P, donePerWeek }),
    exists: fs.existsSync(PLAN_FILE),
  };
  const version = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16);
  planCache = { key, version, data };
  return planCache;
}

// ---- Live update. GET /api/plans?version=…&wait=1 waits (at most WAIT_MS) until plans.json
// or queue.json changes, so changes from a Claude Code session show without reloading the page. The folder is watched with
// fs.watch (the files are written atomically with rename); if that does not work, the call answers "unchanged" after the wait, and the client
// asks again. Read only.
const WAIT_MS = 25_000;
const PLAN_WAITERS = new Set();
let planGuard = null;
function planGuardOn() {
  if (planGuard !== null) return;
  try {
    let time = null;
    planGuard = fs.watch(FOLDER, (_event, name) => {
      if (name && !/^(plans|queue)\.json$/.test(String(name))) return;
      clearTimeout(time);
      // A short pause: a write is a tmp file + rename, and queue.mjs can write both files one after the other.
      time = setTimeout(() => {
        for (const v of [...PLAN_WAITERS]) v();
      }, 150);
    });
    planGuard.on('error', () => {
      planGuard?.close();
      planGuard = false;
    });
  } catch {
    planGuard = false; // fs.watch does not work here: the calls answer after the wait
  }
}
/**
 * Waits until the register changes, the client leaves, or WAIT_MS has passed. `res` (not req): req sends "close" as soon as a
 * GET without a body is fully read, res only when the connection closes.
 */
function waitOnPlans(res) {
  planGuardOn();
  return new Promise((done) => {
    let time = null;
    const v = () => {
      PLAN_WAITERS.delete(v);
      clearTimeout(time);
      res.off('close', v);
      done();
    };
    time = setTimeout(v, WAIT_MS);
    PLAN_WAITERS.add(v);
    res.on('close', v);
  });
}

/** A JSON file, or null when it is missing or broken. */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** The setup in the settings panel (read only, from the real sources). */
function setup(queue, stat) {
  // The migrations are shown only when the project has turned on the migration flow (config().migrations.folder).
  const m = CONFIG.migrations ?? {};
  let migrations = null;
  if (m.folder) {
    let files = [];
    let error = null;
    try {
      files = fs.readdirSync(path.join(GIT_ROOT, ...String(m.folder).split('/')));
    } catch (e) {
      error = e?.code ?? 'could not read the folder';
    }
    migrations = {
      folder: m.folder,
      error,
      next: queue.next_migr ?? null,
      highest: T.highestMigration(files, m.filePattern),
    };
  }
  const cursor = readJson(CURSOR);
  const settings = readJson(path.join(GIT_ROOT, '.claude', 'settings.json'));
  return {
    baseBranch: BASE,
    migrations,
    orchestrator: { ...L.orchestratorStatus(cursor), updated: cursor?.updated ?? null },
    models: stat.models,
    hooks: settings ? T.hooksCoverage(settings) : null,
    skills: T.skillsCoverage((name) =>
      fs.existsSync(path.join(GIT_ROOT, '.claude', 'skills', name, 'SKILL.md')),
    ),
    rules: T.SKILL_RULES.map((r) => r.text),
    rulesSource: T.SKILL_SOURCE,
  };
}

/** The mission text: the file `mission` points to (in the worktree or the main tree, never outside), otherwise the text itself. */
function missionFor(o) {
  const s = String(o.mission ?? '');
  if (s && !s.includes('\n')) {
    for (const root of [ROOT, MAIN_TREE]) {
      const filePath = path.resolve(root, s);
      if (!filePath.startsWith(root + path.sep)) continue;
      try {
        if (fs.statSync(filePath).isFile())
          return { text: fs.readFileSync(filePath, 'utf8').slice(0, 200_000), path: s };
      } catch {
        /* does not exist here */
      }
    }
  }
  return { text: s, path: null };
}

// ---- queue.mjs (all writing) ---------------------------------------------------------------------------------------
function queueMjs(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [QUEUE_MJS, ...args],
      { cwd: ROOT, env: process.env, timeout: 30_000, windowsHide: true, maxBuffer: 4 << 20 },
      (err, out, error) => {
        resolve({
          ok: !err,
          // The exit code: 6 = the queue has changed since the preview (--expect-changed).
          code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          out: String(out ?? '').trim(),
          error: String(error ?? '').trim(),
        });
      },
    );
  });
}

// Writes run one at a time, so a move is always computed from the queue as it is after the previous write.
let chain = Promise.resolve();
function oneAtATime(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => undefined);
  return p;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const PID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const idOrNull = (x) => (x == null ? null : ID.test(String(x)) ? String(x) : undefined);
const pidOrNull = (x) => (x == null ? null : PID.test(String(x)) ? String(x) : undefined);
// A text that starts with "-" would be read by queue.mjs as a flag; control characters (except line breaks) are removed.
const cleanText = (x, max) =>
  String(x ?? '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .trim()
    .replace(/^-+\s*/, '')
    .slice(0, max);

/** Runs edit-many with the content in a temporary file (all or nothing), and cleans up the file afterwards. */
async function editMany(content, run, what, extra = []) {
  const tmp = path.join(os.tmpdir(), `queue-board-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(content));
  try {
    return await run(['edit-many', '--file', tmp, ...extra], what);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Runs a queue.mjs command that answers with one JSON line (--json). `data` is the last line parsed, or
 * null when the response was not JSON (then the error is in `error`/`out`).
 */
async function queueJson(args) {
  const r = await queueMjs(args);
  let data = null;
  try {
    data = JSON.parse(r.out.split('\n').filter(Boolean).pop() ?? '');
  } catch {
    data = null;
  }
  return { ...r, data };
}

/** edit-many with the content in a temporary file and the response as JSON (all or nothing); the file is cleaned up afterwards. */
async function editManyJson(content, extra) {
  const tmp = path.join(os.tmpdir(), `queue-board-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(content));
  try {
    return await queueJson(['edit-many', '--file', tmp, '--json', ...extra]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** The arguments to queue.mjs rank for a position from queueBoard.bulkPlan ({ top } | { bottom } | { over: id } | …). */
function spaceArgs(space) {
  if (space.top) return ['--top'];
  if (space.bottom) return ['--bottom'];
  if (space.over) return ['--over', space.over];
  return ['--under', space.under];
}

/** The error text from a failed queue.mjs call (the JSON errors first, otherwise stderr/stdout). */
const errorText = (r, standard) =>
  (Array.isArray(r.data?.error) && r.data.error.length ? r.data.error.join('\n') : '') ||
  r.error ||
  r.out ||
  standard;

/**
 * The bulk action from the selection bar. The body: { action, ids[], val, dry, expect, confirm }.
 *   dry: true  → preview: what changes (queue.mjs edit-many/rank --dry, or queueBoard.packPreview
 *                 for "Pack into track"), the explanation, the guard rules and the queue's version `changed`. Writes nothing.
 *   otherwise   → the guard rules (stop 422, warning 409 without confirm), then queue.mjs with --expect-changed <expect>, so
 *                 an orchestrator that has changed the queue meanwhile is not overrun (409 with outdated: true).
 * The id list is the one the owner saw; the server never evaluates a search again.
 */
async function bulk(b, queueNow) {
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  const action = String(b.action ?? '');
  if (!T.BULK_ACTIONS.includes(action)) return no(`unknown bulk action ${action}`);
  if (!Array.isArray(b.ids)) return no('invalid id-list');
  const ids = b.ids.map(idOrNull);
  if (!ids.length || ids.length > T.BULK_MAX || ids.some((x) => !x))
    return no('invalid id-list');
  const expectValue = b.expect == null ? null : String(b.expect);
  if (expectValue != null && !Number.isFinite(Date.parse(expectValue))) return no('invalid expect');
  const val = b.val && typeof b.val === 'object' && !Array.isArray(b.val) ? b.val : {};
  if (val.title != null) val.title = cleanText(val.title, 200);
  const queue = queueNow();
  const plan = T.bulkPlan(queue, action, ids, val);
  if (plan.error.length) return no(plan.error.join('\n'));
  const assessment = { type: 'bulk', action, ids, val };

  if (b.dry === true) {
    let changes = [];
    let warnings = [];
    let error = [];
    let pkg = null;
    let changed = queue.changed ?? null;
    if (plan.command === 'batch-pack') {
      const p = T.packPreview(queue, ids, { newId: plan.newId, title: plan.title });
      if (p.error.length) error = p.error;
      else pkg = p;
    } else {
      const r =
        plan.command === 'rank'
          ? await queueJson(['rank', ...ids, ...spaceArgs(plan.space), '--dry', '--json'])
          : await editManyJson(plan.content, ['--dry']);
      if (r.ok && r.data?.ok) {
        changes = r.data.changes ?? [];
        warnings = r.data.warnings ?? [];
        changed = r.data.changed ?? changed;
      } else error = [errorText(r, 'cq failed')];
    }
    const list = T.assess(queue, assessment, { now: Date.now() });
    return {
      status: 200,
      answer: {
        ok: true,
        dry: true,
        changed,
        recap: T.bulkSummary(queue, action, ids, val, changes),
        lines: L.diffLines(changes, { max: 300 }),
        field: changes.length,
        warnings,
        error,
        package: pkg,
        guard: list,
        can: !error.length && !list.some((v) => v.level === 'stop'),
      },
    };
  }

  const v = guard(queue, assessment, {}, b);
  if (v.stop) return v.stop;
  const fv = expectValue ? ['--expect-changed', expectValue] : [];
  let r;
  if (plan.command === 'batch-pack')
    r = await queueJson([
      'batch',
      'pack',
      ...ids,
      '--id',
      plan.newId,
      ...(plan.title ? ['--title', plan.title] : []),
      ...fv,
    ]);
  else if (plan.command === 'rank')
    r = await queueJson([
      'rank',
      ...ids,
      ...spaceArgs(plan.space),
      '--json',
      '--by',
      'theBoard',
      ...fv,
    ]);
  else r = await editManyJson(plan.content, ['--by', 'theBoard', ...fv]);
  quick = null;
  const clock = new Date().toLocaleTimeString('en-GB');
  const what = `bulk ${action} ${ids.length === 1 ? ids[0] : `${ids.length} tasks`}`;
  console.log(`${clock} ${what}: ${r.ok ? 'ok' : `failed (${errorText(r, '?')})`}`);
  if (!r.ok || (r.data && r.data.ok === false)) {
    const outdated = r.code === 6 || r.data?.outdated === true;
    return {
      status: 409,
      answer: {
        ok: false,
        outdated,
        message: outdated
          ? 'The queue has changed since the preview. Review the change again.'
          : errorText(r, 'cq failed'),
      },
    };
  }
  return {
    status: 200,
    answer: {
      ok: true,
      message: plan.command === 'batch-pack' ? r.out : `${r.data?.changed?.length ?? ids.length}`,
      info: v.info,
      // The entry in the changelog ("Undo" sends it back as --nr). Packing is not logged and cannot be undone.
      log: r.data?.log ?? null,
      new_id: plan.command === 'batch-pack' ? plan.newId : null,
    },
  };
}

/**
 * "Undo" (queue.mjs undo). { show: true } shows the last entry that can be undone and whether that works now;
 * otherwise it is undone, with { nr } when the board knows which entry (after a bulk action), so someone else's change is never
 * undone instead.
 */
async function undo(b) {
  if (b.show === true) {
    const r = await queueJson(['undo', '--show', '--json']);
    if (!r.data)
      return { status: 500, answer: { ok: false, message: errorText(r, 'cq failed') } };
    return {
      status: 200,
      answer: {
        ok: true,
        can: r.data.ok === true,
        error: r.data.error ?? [],
        entry: r.data.entry ?? null,
        lines: r.data.entry ? L.diffLines(r.data.entry.changes ?? [], { max: 300 }) : [],
      },
    };
  }
  const nr = b.nr == null ? null : Number(b.nr);
  if (nr != null && !(Number.isInteger(nr) && nr > 0))
    return { status: 400, answer: { ok: false, message: 'invalid nr' } };
  const r = await queueJson(['undo', '--json', '--by', 'theBoard', ...(nr ? ['--nr', String(nr)] : [])]);
  quick = null;
  console.log(
    `${new Date().toLocaleTimeString('en-GB')} undo${nr ? ` no. ${nr}` : ''}: ${r.ok ? 'ok' : `failed (${errorText(r, '?')})`}`,
  );
  if (!r.ok || r.data?.ok !== true)
    return { status: 409, answer: { ok: false, message: errorText(r, 'cq undo failed') } };
  const p = r.data.entry;
  return {
    status: 200,
    answer: { ok: true, message: `Undone ${p?.action ?? 'change'} (no. ${p?.nr ?? '?'})` },
  };
}

/** A stage from the plan view: area:<oid>, project:<pid> or feature:<pid>/<name> (queue.mjs validates the rest). */
const STEP =
  /^(area|project):[a-z0-9]+(?:-[a-z0-9]+)*$|^feature:[a-z0-9]+(?:-[a-z0-9]+)*\/[^\u0000-\u001f\u007f]{1,80}$/;

/**
 * "Save focus" from the plan view. The body: { plan: { order[], now_count?, rest?, to?, name?,
 * drag_with_dependencies?, pause?[], continue?[] }, dry, expect }.
 *   dry: true → preview (queueBoard.focusPreview on a copy: focus before and after, the stages, rest,
 *                dragged along, the pause changes and "Next up" after saving) and the queue's version `changed`. Writes nothing.
 *   otherwise  → queue.mjs focus save --expect-changed <expect> (all or nothing); 409 with outdated: true when the queue
 *                has changed since the preview.
 */
async function focus(b, queueNow) {
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  const p = b.plan && typeof b.plan === 'object' && !Array.isArray(b.plan) ? b.plan : null;
  if (!p) return no('missing plan');
  const list = (x) => (Array.isArray(x) ? x.map(String) : x == null ? [] : null);
  const order = list(p.order);
  const pause = list(p.pause);
  const proceed = list(p.continue);
  if (
    !order ||
    order.length > L.FOCUS_PLAN_MAX ||
    order.some((x) => !STEP.test(x))
  )
    return no('invalid stage');
  if (!pause || !proceed || [...pause, ...proceed].some((x) => !PID.test(x)))
    return no('invalid project id in pause/continue');
  if (p.rest != null && !L.FOCUS_REST.includes(p.rest))
    return no('rest must be wait or fill');
  const to = p.to == null || p.to === '' ? null : String(p.to).trim();
  if (to != null && !/^\d{4}-\d\d-\d\d$/.test(to))
    return no('the date must be in the form YYYY-MM-DD');
  const nowCount = p.now_count == null ? null : Number(p.now_count);
  if (nowCount != null && !Number.isInteger(nowCount)) return no('invalid now_count');
  const expectValue = b.expect == null ? null : String(b.expect);
  if (expectValue != null && !Number.isFinite(Date.parse(expectValue))) return no('invalid expect');
  const name = cleanText(p.name, 200);
  const input = {
    order,
    ...(nowCount != null ? { now_count: nowCount } : {}),
    rest: p.rest ?? 'wait',
    to,
    name: name || null,
    drag_with_dependencies: p.drag_with_dependencies !== false,
    pause,
    continue: proceed,
  };
  const queue = queueNow();
  if (b.dry === true) {
    const f = T.focusPreview(queue, input, {
      now: Date.now(),
      uncommitted: uncommitted().uncommitted,
    });
    return {
      status: 200,
      answer: { ok: true, dry: true, changed: queue.changed ?? null, ...f, can: !f.error.length },
    };
  }
  const tmp = path.join(os.tmpdir(), `queue-board-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(input));
  let r;
  try {
    r = await queueJson([
      'focus',
      'save',
      '--file',
      tmp,
      '--json',
      '--by',
      'theBoard',
      ...(expectValue ? ['--expect-changed', expectValue] : []),
    ]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  quick = null;
  console.log(
    `${new Date().toLocaleTimeString('en-GB')} focus save: ${r.ok ? 'ok' : `failed (${errorText(r, '?')})`}`,
  );
  if (!r.ok || r.data?.ok !== true) {
    const outdated = r.code === 6 || r.data?.outdated === true;
    return {
      status: 409,
      answer: {
        ok: false,
        outdated,
        message: outdated
          ? 'The queue has changed since the preview. Review the focus again.'
          : errorText(r, 'cq focus save failed'),
      },
    };
  }
  return {
    status: 200,
    answer: {
      ok: true,
      message: order.length ? 'Focus saved' : 'Focus removed',
      info: r.data.warnings ?? [],
    },
  };
}

/**
 * The areas from the board. The body: { action: save|delete|move, oid, title?, description?, pid?, dry,
 * expect }. dry → the explanation (queueBoard.areaPlan tries on a copy); otherwise queue.mjs area … --expect-changed.
 */
async function area(b, queueNow) {
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  const action = String(b.action ?? '');
  if (!T.AREA_ACTIONS.includes(action)) return no(`unknown action ${action}`);
  const oid = pidOrNull(b.oid === '' ? null : b.oid);
  if (oid === undefined || (action !== 'move' && !oid)) return no('invalid area id');
  const pid = action === 'move' ? pidOrNull(b.pid) : null;
  if (action === 'move' && !pid) return no('invalid project id');
  const expectValue = b.expect == null ? null : String(b.expect);
  if (expectValue != null && !Number.isFinite(Date.parse(expectValue))) return no('invalid expect');
  const queue = queueNow();
  const plan = T.areaPlan(queue, {
    action,
    oid,
    pid,
    title: b.title == null ? null : cleanText(b.title, 200),
    description: b.description == null ? null : cleanText(b.description, 500),
  });
  if (b.dry === true)
    return {
      status: 200,
      answer: {
        ok: true,
        dry: true,
        changed: queue.changed ?? null,
        error: plan.error,
        lines: plan.lines ?? [],
        can: !plan.error.length,
      },
    };
  if (plan.error.length) return { status: 409, answer: { ok: false, message: plan.error.join('\n') } };
  const r = await queueMjs([...plan.args, ...(expectValue ? ['--expect-changed', expectValue] : [])]);
  quick = null;
  console.log(
    `${new Date().toLocaleTimeString('en-GB')} ${plan.args.join(' ')}: ${r.ok ? 'ok' : `failed (${r.error || r.out})`}`,
  );
  if (!r.ok)
    return {
      status: 409,
      answer: {
        ok: false,
        outdated: r.code === 6,
        message:
          r.code === 6
            ? 'The queue has changed since the preview. Review the change again.'
            : r.error || r.out || 'cq area failed',
      },
    };
  return { status: 200, answer: { ok: true, message: r.out } };
}

/**
 * Turns the `queue.mjs plan prioritize` calls from queuePlanView.prioritizeCall (which has checked and cleaned the groups) into
 * the list `plan prioritize-many --file` takes: [{ id, priority, category?, reason? }]. The arguments are
 * ['plan', 'prioritize', ...ids, priority, --category k, --reason g, …flag].
 */
function prioritizeList(call) {
  const out = [];
  for (const args of call) {
    const first = args.findIndex((x, i) => i >= 2 && String(x).startsWith('--'));
    const end = first < 0 ? args.length : first;
    const priority = args[end - 1];
    const after = (flag) => {
      const k = args.indexOf(flag, end);
      return k < 0 ? null : args[k + 1];
    };
    const category = after('--category');
    const reason = after('--reason');
    for (const id of args.slice(2, end - 1))
      out.push({
        id,
        priority,
        ...(category ? { category: [category] } : {}),
        ...(reason ? { reason } : {}),
      });
  }
  return out;
}

/**
 * "Save the priorities" from the priority map. The body: { groups: [{ priority, category[],
 * reason, ids[] }], dry, expect }. queuePlanView.prioritizeCall checks the groups; the whole draft then goes in ONE
 * `queue.mjs plan prioritize-many --file` call (--set-by owner: the owner sits at the board), under one lock and with one
 * changelog entry, so one save is one undo. All or nothing is done by queue.mjs.
 *   dry: true → the call with --dry (writes nothing): the changes, the warnings, the errors and the plan register's version
 *                `changed` (which the preview sends back as `expect`).
 *   otherwise  → the call with --expect-changed <expect>, so another session that has changed the register meanwhile stops
 *                the save (409 outdated).
 */
async function planPrioritize(b) {
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  const { error, call } = PRIVACY.prioritizeCall(b.groups);
  if (error.length) return no(error.join('\n'));
  const expectValue = b.expect == null ? null : String(b.expect);
  if (expectValue != null && !Number.isFinite(Date.parse(expectValue))) return no('invalid expect');
  const list = prioritizeList(call);
  const tmp = path.join(os.tmpdir(), `queue-board-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(list));
  let r;
  try {
    r = await queueJson([
      'plan',
      'prioritize-many',
      '--file',
      tmp,
      '--set-by',
      'owner',
      '--by',
      'theBoard',
      '--json',
      ...(b.dry === true ? ['--dry'] : expectValue ? ['--expect-changed', expectValue] : []),
    ]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  if (b.dry === true) {
    const ok = r.data?.ok === true;
    return {
      status: 200,
      answer: {
        ok: true,
        dry: true,
        changed: ok ? (r.data.changed ?? null) : null,
        changes: ok ? (r.data.changes ?? []) : [],
        warnings: ok ? (r.data.warnings ?? []) : (r.data?.warnings ?? []),
        error: ok ? [] : [errorText(r, 'cq plan prioritize-many failed')],
        can: ok,
      },
    };
  }

  const log = (ok) =>
    console.log(`${new Date().toLocaleTimeString('en-GB')} plan prioritize-many (the map): ${ok}`);
  if (!(r.ok && r.data?.ok === true)) {
    const outdated = r.code === 6 || r.data?.outdated === true;
    log('failed');
    return {
      status: 409,
      answer: {
        ok: false,
        outdated,
        message: outdated
          ? 'The plan register has changed since the preview. Review the draft again.'
          : errorText(r, 'cq plan prioritize-many failed'),
      },
    };
  }
  log(`ok (${list.length} entries)`);
  return {
    status: 200,
    answer: {
      ok: true,
      message: 'The priorities are saved (one change in the changelog).',
      log: r.data.log != null ? [r.data.log] : [],
    },
  };
}

// ---- The Unregistered box -----------------------------------------------------------------------
// Both writes go via queue.mjs (same lock, atomic write, changelog and `plan undo`) with the owner option
// (--set-by owner, --by theBoard). dry = preview (--dry); otherwise --expect-changed <expect> from
// the preview, so a session that has changed the register meanwhile gives 409 with outdated: true.
const expectValid = (x) => x == null || Number.isFinite(Date.parse(String(x)));
function planWriteAnswer(r, what, okText) {
  const clock = new Date().toLocaleTimeString('en-GB');
  if (r.ok && r.data?.ok === true) {
    if (!r.data.dry) console.log(`${clock} ${what}: ok`);
    return {
      status: 200,
      answer: {
        ok: true,
        dry: r.data.dry === true,
        changes: r.data.changes ?? [],
        warnings: r.data.warnings ?? [],
        changed: r.data.changed ?? null,
        log: r.data.log ?? null,
        message: r.data.dry ? null : okText,
      },
    };
  }
  const outdated = r.code === 6 || r.data?.outdated === true;
  console.log(`${clock} ${what}: failed`);
  return {
    status: outdated ? 409 : 400,
    answer: {
      ok: false,
      outdated,
      warnings: r.data?.warnings ?? [],
      message: outdated
        ? 'The plan register has changed since the preview. Review and preview again.'
        : errorText(r, `queue.mjs ${what} failed`),
    },
  };
}

async function planNew(b) {
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  if (!expectValid(b.expect)) return no('invalid expect');
  const { entry, error } = PRIVACY.newEntryFromForm(b.form, b.path);
  if (error.length) return no(error.join('\n'));
  const tmp = path.join(os.tmpdir(), `queue-board-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(entry));
  try {
    const r = await queueJson(PRIVACY.newEntryArgs(tmp, { dry: b.dry === true, expect: b.expect }));
    return planWriteAnswer(r, `plan new ${entry.id}`, `New plan entry ${entry.id} with the source ${b.path}.`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function planSource(b) {
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  if (!expectValid(b.expect)) return no('invalid expect');
  const id = String(b.id ?? '');
  if (!/^PL-[A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5-]{1,60}$/.test(id)) return no('invalid plan entry');
  // The sources are read from plans.json now; queue.mjs refuses (exit 6) if the register has changed after the preview.
  const reg = fs.existsSync(PLAN_FILE)
    ? P.normalize(JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')))
    : P.emptyRegister();
  const entry = (reg.entries ?? []).find((p) => p.id === id);
  if (!entry) return no(`unknown plan entry ${id}`);
  const { sources, error } = PRIVACY.sourceBonus(entry, b.path, b.anchor);
  if (error.length) return no(error.join('\n'));
  const r = await queueJson(PRIVACY.sourceArgs(id, sources, { dry: b.dry === true, expect: b.expect }));
  return planWriteAnswer(r, `plan edit ${id} (source)`, `${b.path} is added as a source on ${id}.`);
}

// ---- Multi select and change in the row -----------------------------------------------------------
// POST /api/plan-bulk { action, ids, priority?, category?, reason?, project?, maturity?, to?, dry, expect }.
// The calls are made and checked by queuePlanView.planBulkCall (always queue.mjs, with the owner option and --by theBoard). dry =
// preview (--dry on every call). Otherwise the calls are written one after the other with --expect-changed from
// the preview (and then from the previous call); if one fails, the written ones are undone newest first (`plan undo --nr`), so
// the save becomes all or nothing. The response has the changelog numbers (`log`), which POST /api/plan-undo { nr } undoes.
async function planBulk(b) {
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  const { error, call } = PRIVACY.planBulkCall(b);
  if (error.length) return no(error.join('\n'));
  if (!expectValid(b.expect)) return no('invalid expect');
  const what = `plan ${b.action} (theBoard, ${call.length} call)`;
  const log = (ok) => console.log(`${new Date().toLocaleTimeString('en-GB')} ${what}: ${ok}`);
  if (b.dry === true) {
    const changes = [];
    const warnings = [];
    const errorOut = [];
    let changed = null;
    for (const args of call) {
      const r = await queueJson([...args, '--dry']);
      if (r.data?.ok === true) {
        changes.push(...(r.data.changes ?? []));
        warnings.push(...(r.data.warnings ?? []));
        if (changed == null) changed = r.data.changed ?? null;
      } else errorOut.push(errorText(r, `queue.mjs ${args[1]} failed`));
    }
    return {
      status: 200,
      answer: {
        ok: true,
        dry: true,
        changed,
        changes,
        warnings,
        error: errorOut,
        can: !errorOut.length,
      },
    };
  }
  const written = [];
  let version = b.expect == null ? null : String(b.expect);
  for (const args of call) {
    const r = await queueJson([...args, ...(version ? ['--expect-changed', version] : [])]);
    if (r.ok && r.data?.ok === true) {
      if (r.data.log != null) written.push(r.data.log);
      version = r.data.changed ?? version;
      continue;
    }
    const outdated = r.code === 6 || r.data?.outdated === true;
    const notUndone = [];
    for (const nr of [...written].reverse()) {
      const a = await queueJson(['plan', 'undo', '--nr', String(nr), '--json', '--by', 'theBoard']);
      if (!(a.ok && a.data?.ok === true)) {
        notUndone.push(nr);
        break;
      }
    }
    log(`failed${written.length ? `, undone ${written.length - notUndone.length}` : ''}`);
    const reason = outdated
      ? 'The plan register has changed since the preview. Review and preview again.'
      : errorText(r, `queue.mjs ${args[1]} failed`);
    return {
      status: 409,
      answer: {
        ok: false,
        outdated,
        message: notUndone.length
          ? `${reason}\nSomething was saved and could not be undone automatically (changelog no. ${written.join(', ')}). Use cq plan undo.`
          : reason,
      },
    };
  }
  log('ok');
  return {
    status: 200,
    answer: {
      ok: true,
      log: written,
      message: `Saved: ${PRIVACY.bulkText(b, { projects: planCache?.data?.projects ?? {} })}.`,
    },
  };
}

async function planUndo(b) {
  const { error, call } = PRIVACY.undoCall(b.nr);
  if (error.length) return { status: 400, answer: { ok: false, message: error.join('\n') } };
  let undone = 0;
  for (const args of call) {
    const r = await queueJson(args);
    if (!(r.ok && r.data?.ok === true)) {
      console.log(
        `${new Date().toLocaleTimeString('en-GB')} plan undo (board): failed after ${undone}`,
      );
      return {
        status: 409,
        answer: {
          ok: false,
          undone,
          message: `${errorText(r, 'cq plan undo failed')}${undone ? ` (${undone} of ${call.length} are undone)` : ''}`,
        },
      };
    }
    undone += 1;
  }
  console.log(`${new Date().toLocaleTimeString('en-GB')} plan undo (board): ${undone}`);
  return {
    status: 200,
    answer: {
      ok: true,
      undone,
      message: `Undone (${undone === 1 ? 'one change' : `${undone} changes`}).`,
    },
  };
}

// The lawyer package. dry = preview (the text, and whether the file already exists); otherwise the draft is written
// atomically to the path queuePlan.lawyerPackage gives (relative to the main tree). A file that exists with other content
// is replaced only with `replace: true`. The file is a draft from the plan register: nothing is sent anywhere, and
// the plan register does not change (it is written only via queue.mjs).
function lawyerPackageWrite(b) {
  if (typeof P.lawyerPackage !== 'function')
    return { status: 404, answer: { ok: false, message: 'The lawyer package does not exist in this version.' } };
  const reg = fs.existsSync(PLAN_FILE)
    ? P.normalize(JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')))
    : P.emptyRegister();
  const queue = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
  const pk = P.lawyerPackage(reg, queue, { now: new Date() });
  const file = path.join(SOURCE_ROOT, ...pk.path.split('/'));
  const folder = path.dirname(file);
  // Path guard: the path must lie inside the main tree, and neither the folder nor the file can be a symlink (then the write could
  // end up somewhere else).
  if (!path.resolve(file).startsWith(path.resolve(SOURCE_ROOT) + path.sep))
    return { status: 400, answer: { ok: false, message: `${pk.path}: outside the project.` } };
  for (const x of [folder, file])
    if (fs.existsSync(x) && fs.lstatSync(x).isSymbolicLink())
      return {
        status: 400,
        answer: { ok: false, message: `${pk.path}: symlinks are not written to.` },
      };
  const exists = fs.existsSync(file);
  const equal = exists && fs.readFileSync(file, 'utf8') === pk.text;
  if (b.dry === true)
    return {
      status: 200,
      answer: {
        ok: true,
        dry: true,
        path: pk.path,
        text: pk.text,
        points: pk.points,
        exists,
        equal,
      },
    };
  if (exists && !equal && b.replace !== true)
    return {
      status: 409,
      answer: {
        ok: false,
        confirm: true,
        message: `${pk.path} already exists with other content (maybe edited by hand). Replace it?`,
      },
    };
  fs.mkdirSync(folder, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, pk.text);
  fs.renameSync(tmp, file);
  const n = pk.points.length;
  console.log(`${new Date().toLocaleTimeString('en-GB')} lawyerPackage ${pk.path}: ${n} points`);
  return {
    status: 200,
    answer: {
      ok: true,
      path: pk.path,
      points: pk.points,
      message: `The lawyer package is saved in ${pk.path} (${n} ${n === 1 ? 'point' : 'points'}). It has not been sent.`,
    },
  };
}

// Unregistered documents (= `queue.mjs plan check --json`, read only). The check reads documents and git, so the response
// is cached until plans.json changes or two minutes have passed.
let checkCache = null;
async function planCheck() {
  let mt = 0;
  try {
    mt = fs.statSync(PLAN_FILE).mtimeMs;
  } catch {
    mt = 0;
  }
  const key = `${mt}|${Math.floor(Date.now() / 120_000)}`;
  if (checkCache?.key === key) return checkCache.answer;
  const r = await queueJson(['plan', 'check', '--json']);
  if (!(r.ok && r.data?.ok === true))
    return { ok: false, message: errorText(r, 'cq plan check failed') };
  const unregistered = (r.data.unregistered ?? []).filter((s) => typeof s === 'string');
  const answer = { ok: true, unregistered, groups: PRIVACY.unregisteredGroups(unregistered) };
  checkCache = { key, answer };
  return answer;
}

/**
 * The guard rules (queueBoard.assess) before a write action. Returns { stop: { status, answer } } when the action is not to
 * be done yet (422 stop, 409 warning without `confirm: true`), otherwise { info: [text] } which is sent with the response.
 */
function guard(queue, action, context, b) {
  const list = T.assess(queue, action, { now: Date.now(), ...context });
  const texts = (level) => list.filter((v) => v.level === level).map((v) => v.text);
  if (texts('stop').length)
    return {
      stop: {
        status: 422,
        answer: { ok: false, guard: list, message: texts('stop').join('\n') },
      },
    };
  if (texts('warning').length && b.confirm !== true)
    return {
      stop: {
        status: 409,
        answer: { ok: false, confirm: true, guard: list, message: texts('warning').join('\n') },
      },
    };
  return { info: texts('info') };
}

/** Does a write action. Returns { status, answer }. */
async function write(filePath, b) {
  const queueNow = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
  let info = [];
  const run = async (args, what) => {
    const r = await queueMjs(args);
    quick = null;
    const clock = new Date().toLocaleTimeString('en-GB');
    console.log(`${clock} ${what}: ${r.ok ? 'ok' : `failed (${r.error || r.out})`}`);
    return r.ok
      ? { status: 200, answer: { ok: true, message: r.out, info } }
      : { status: 409, answer: { ok: false, message: r.error || r.out || 'cq failed' } };
  };
  const no = (message) => ({ status: 400, answer: { ok: false, message } });

  // Bulk actions from the selection bar and "Undo".
  if (filePath === '/api/bulk') return bulk(b, queueNow);
  if (filePath === '/api/undo') return undo(b);
  // The plan view ("Save focus") and areas.
  if (filePath === '/api/focus') return focus(b, queueNow);
  if (filePath === '/api/area') return area(b, queueNow);
  // The priority map in the Plans space ("Save the priorities").
  if (filePath === '/api/plan-prioritize') return planPrioritize(b);
  // The Unregistered box ("New entry" and "Add as source").
  if (filePath === '/api/plan-new') return planNew(b);
  if (filePath === '/api/plan-source') return planSource(b);
  // Multi select and change in the row, and undo what the board just saved.
  if (filePath === '/api/plan-bulk') return planBulk(b);
  if (filePath === '/api/plan-undo') return planUndo(b);
  // The lawyer package (local draft, never sent).
  if (filePath === '/api/lawyerPackage') return lawyerPackageWrite(b);

  if (filePath === '/api/move') {
    const id = idOrNull(b.id);
    const over = idOrNull(b.over);
    const under = idOrNull(b.under);
    if (!id || over === undefined || under === undefined) return no('invalid id');
    const space = { over, under, top: b.top === true };
    const queue = queueNow();
    const r = T.newBonus(queue, id, space);
    if (r.error) return no(r.error);
    const v = guard(queue, { type: 'move', id, ...space }, {}, b);
    if (v.stop) return v.stop;
    info = v.info;
    // "Boost dependencies too": the card and the open dependencies are moved in one edit-many call.
    if (b.boost === true) {
      const l = T.boostBonus(queue, id, space);
      if (l.error) return no(l.error);
      const changes = Object.entries(l.changes);
      if (changes.length > 1)
        return editMany(
          { tasks: changes.map(([oid, t]) => ({ id: oid, priority_bonus: t })) },
          run,
          `move ${id} with dependencies (${changes.map(([oid, t]) => `${oid} ${t}`).join(', ')})`,
        );
    }
    return run(
      ['edit', id, '--json', JSON.stringify({ priority_bonus: r.bonus })],
      `move ${id} (priority_bonus ${r.bonus})`,
    );
  }
  if (filePath === '/api/limit') {
    const name = String(b.name ?? '');
    if (!L.LIMIT_NAME.includes(name)) return no(`unknown setting ${name}`);
    // The value goes unchanged to queue.mjs (as a positional argument, never through a shell), so queue.mjs's validation and
    // message apply. Here only what can never be a value is stopped.
    const val = String(b.val ?? '').trim();
    if (!val || val.length > 20 || /[\u0000-\u001f\u007f]/.test(val))
      return no('write a value');
    const v = guard(
      queueNow(),
      { type: 'limit', name, val },
      { usageToday: statistics().data.keyFigures.usageToday },
      b,
    );
    if (v.stop) return v.stop;
    info = v.info;
    return run(['limit', name, val], `limit ${name} ${val}`);
  }
  if (filePath === '/api/lane') {
    const pid = pidOrNull(b.pid);
    const over = pidOrNull(b.over);
    const under = pidOrNull(b.under);
    if (!pid || over === undefined || under === undefined) return no('invalid project id');
    const lanes = T.projectLanes(queueNow()).filter((x) => x.movable);
    const r = T.laneBonus(lanes, pid, { over, under });
    if (r.error) return no(r.error);
    const changes = Object.entries(r.changes);
    if (changes.length === 1)
      return run(
        ['project', pid, '--priority', String(changes[0][1])],
        `lane ${pid} (priority ${changes[0][1]})`,
      );
    // Several projects at once: edit-many is all or nothing.
    const projects = Object.fromEntries(changes.map(([p, t]) => [p, { priority_bonus: t }]));
    return editMany(
      { projects },
      run,
      `lane ${pid} (${changes.map(([p, t]) => `${p} ${t}`).join(', ')})`,
    );
  }
  if (filePath === '/api/action') {
    const type = String(b.type ?? '');
    if (type === 'pause' || type === 'continue') {
      const pid = pidOrNull(b.pid);
      if (!pid) return no('invalid project id');
      const v = guard(queueNow(), { type, pid }, {}, b);
      if (v.stop) return v.stop;
      info = v.info;
      return run(['project', pid, `--${type}`], `${type} ${pid}`);
    }
    // An answer to an owner question ("Waiting on you"). The answer is required (guard rule 15); the id must exist in
    // the queue (a task waits on it, or it is registered in `question`), so the board never resolves something unknown.
    if (type === 'resolve') {
      const queue = queueNow();
      const sp = String(b.sp ?? '');
      const known =
        L.validQuestionId(sp) &&
        (Object.hasOwn(queue.question ?? {}, sp) ||
          (queue.tasks ?? []).some((o) => (o.waiting_on ?? []).includes(sp)));
      if (!known) return no('unknown question');
      const answer = cleanText(b.answer, 4000);
      const v = guard(queue, { type, sp, text: answer }, {}, b);
      if (v.stop) return v.stop;
      info = v.info;
      return run(['resolve', sp, '--answer', answer, '--by', 'owner'], `resolve ${sp}`);
    }
    // QA ok and approve for several at once (queue.mjs takes lists; all or nothing).
    if ((type === 'qa-ok' || type === 'approve') && Array.isArray(b.ids)) {
      const ids = b.ids.map(idOrNull);
      if (!ids.length || ids.length > 500 || ids.some((x) => !x)) return no('invalid id list');
      const args = type === 'qa-ok' ? ['qa', 'ok', ...ids] : ['approve', ...ids];
      return run(args, `${type} ${ids.length === 1 ? ids[0] : `${ids.length} tasks`}`);
    }
    // "Started in cloud" for a bundle (the chosen cards) goes in one queue.mjs call (all or nothing).
    if (type === 'cloud-start' && Array.isArray(b.ids)) {
      const ids = b.ids.map(idOrNull);
      if (!ids.length || ids.length > 10 || ids.some((x) => !x)) return no('invalid id list');
      return run(['cloud', 'start', ...ids], `cloud start ${ids.join(' ')}`);
    }
    // The batch queue from the panel. "Add to batch queue" and "Take out of batch queue" go via edit-many (same rules
    // as add/edit, queueLogic.batchedError; all or nothing; the changelog makes them undoable), "Pack" via
    // queue.mjs batch pack (same class, never D+, same owner question). `expect` = the queue's `changed` from the preview:
    // queue.mjs refuses (409) when the queue has changed since.
    if ((type === 'batch-in' || type === 'batch-out') && Array.isArray(b.ids)) {
      const ids = b.ids.map(idOrNull);
      if (!ids.length || ids.length > 500 || ids.some((x) => !x)) return no('invalid id list');
      const expectValue = b.expect == null ? null : String(b.expect);
      if (expectValue != null && !Number.isFinite(Date.parse(expectValue))) return no('invalid expect');
      return editMany(
        { tasks: ids.map((x) => ({ id: x, batched: type === 'batch-in' })) },
        run,
        `${type} ${ids.length === 1 ? ids[0] : `${ids.length} tasks`}`,
        ['--by', 'theBoard', ...(expectValue ? ['--expect-changed', expectValue] : [])],
      );
    }
    if (type === 'batch-pack' && Array.isArray(b.ids)) {
      const ids = b.ids.map(idOrNull);
      const newId = idOrNull(b.new_id);
      if (ids.length < 2 || ids.length > 50 || ids.some((x) => !x))
        return no('invalid id list');
      if (!newId) return no('invalid new id');
      const title = cleanText(b.title, 200);
      return run(
        ['batch', 'pack', ...ids, '--id', newId, ...(title ? ['--title', title] : [])],
        `batch pack ${ids.join(' ')} → ${newId}`,
      );
    }
    const id = idOrNull(b.id);
    if (!id) return no('invalid id');
    // "Started in cloud", "Completed in cloud" and "Cancel cloud" go via queue.mjs cloud … (the suitability, the git check of
    // the branch and the limit of three cloud sessions are there).
    if (type === 'cloud-start') {
      const execution = cleanText(b.execution, 300);
      if (execution && /\s/.test(execution)) return no('the link or session id cannot contain whitespace');
      return run(
        ['cloud', 'start', id, ...(execution ? ['--run', execution] : [])],
        `cloud start ${id}`,
      );
    }
    if (type === 'cloud-done') {
      const branch = cleanText(b.branch, 100);
      if (branch && (!BRANCH_PATTERN.test(branch) || branch.includes('..'))) return no('invalid branch name');
      return run(['cloud', 'done', id, ...(branch ? ['--branch', branch] : [])], `cloud done ${id}`);
    }
    if (type === 'cloud-cancel') return run(['cloud', 'cancel', id], `cloud cancel ${id}`);
    // The context the guard rules need: the orchestrator cursor (pick) and commits on the branch (release).
    const queue = queueNow();
    const o = (queue.tasks ?? []).find((x) => x.id === id);
    const context = {};
    if (type === 'pick') context.orchestrator = L.orchestratorStatus(readJson(CURSOR));
    if (type === 'release' && o) {
      const branch = branchFor(o);
      context.branches = { [branch]: branchInfo(branch) };
      context.branchPrefix = BRANCH_PREFIX;
    }
    const v = guard(queue, { type, id, text: b.text }, context, b);
    if (v.stop) return v.stop;
    info = v.info;
    if (type === 'pick') {
      const by = cleanText(b.by, 60);
      if (!by) return no('write who is picking');
      return run(['pick', id, '--by', by], `pick ${id}`);
    }
    if (type === 'release') return run(['release', id], `release ${id}`);
    if (type === 'qa-ok') return run(['qa', 'ok', id], `qa ok ${id}`);
    if (type === 'approve') return run(['approve', id], `approve ${id}`);
    if (type === 'qa-deviation') {
      const text = cleanText(b.text, 2000);
      if (!text) return no('write what is wrong, and where');
      return run(['qa', 'deviation', id, text], `qa deviation ${id}`);
    }
    return no(`unknown action ${type}`);
  }
  return { status: 404, answer: { ok: false, message: 'unknown address' } };
}

// ---- HTTP -------------------------------------------------------------------------------------------------------
const SECURITY = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// JSON over 50 KB (/api/state is several hundred KB) is compressed with brotli or gzip when
// the client says it supports it (Accept-Encoding). The choice is the pure function in queue-board/performance.js (tested).
const Y = require('./queue-board/performance.js');
function send(res, status, type, body, extra = {}) {
  const header = { ...SECURITY, 'Content-Type': type, ...extra };
  if (type.startsWith('application/json')) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
    const encoding = Y.selectEncoding(res.req?.headers['accept-encoding'], bytes.length);
    header.Vary = 'Accept-Encoding';
    if (encoding) {
      body =
        encoding === 'br'
          ? zlib.brotliCompressSync(bytes, {
              params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }, // quick enough for every fetch
            })
          : zlib.gzipSync(bytes, { level: 6 });
      header['Content-Encoding'] = encoding;
    }
  }
  res.writeHead(status, header);
  res.end(body);
}
const json = (res, status, obj) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), {
    'Cache-Control': 'no-store',
  });

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/board.js': ['board.js', 'text/javascript; charset=utf-8'],
  '/board.css': ['board.css', 'text/css; charset=utf-8'],
  // The "Dependencies" view. The layout is the pure functions in lib/queueGraph.js (the same file the tests use),
  // served unchanged to the browser; graph.js draws.
  '/graph.js': ['graph.js', 'text/javascript; charset=utf-8'],
  '/queueGraph.js': [path.join('..', 'lib', 'queueGraph.js'), 'text/javascript; charset=utf-8'],
  // The speech bubble (mascot.js) and the pure rules in lib/queueMascot.js (the same file the tests use).
  '/mascot.js': ['mascot.js', 'text/javascript; charset=utf-8'],
  '/queueMascot.js': [path.join('..', 'lib', 'queueMascot.js'), 'text/javascript; charset=utf-8'],
  // The plan view (Now, Next, Later, Waiting) with a draft and "Save focus", and the help.
  '/plan.js': ['plan.js', 'text/javascript; charset=utf-8'],
  // Shared focus trap, toast queue, tabs and legend (the same file the tests use).
  '/a11y.js': ['a11y.js', 'text/javascript; charset=utf-8'],
  // The card buffer, the keyboard between the columns and the compression choice (the same file the tests use).
  '/performance.js': ['performance.js', 'text/javascript; charset=utf-8'],
  // The Plans space (its own files in plans/) and the pure rules in lib/queuePlanView.js (the same file the tests use),
  // served unchanged to the browser.
  '/plans/plans.js': [path.join('plans', 'plans.js'), 'text/javascript; charset=utf-8'],
  '/plans/plans.css': [path.join('plans', 'plans.css'), 'text/css; charset=utf-8'],
  // The Documents and agreements view, drawn with the pure rules in queuePlanView.js.
  '/plans/documents.js': [path.join('plans', 'documents.js'), 'text/javascript; charset=utf-8'],
  // The priority map and the deadline band.
  '/plans/map.js': [path.join('plans', 'map.js'), 'text/javascript; charset=utf-8'],
  // Tree map and dependencies for the selection.
  '/plans/structure.js': [path.join('plans', 'structure.js'), 'text/javascript; charset=utf-8'],
  // The reading view of documents and the Unregistered box.
  '/plans/read.js': [path.join('plans', 'read.js'), 'text/javascript; charset=utf-8'],
  // The Legal, Decisions and Launch views.
  '/plans/legal.js': [path.join('plans', 'legal.js'), 'text/javascript; charset=utf-8'],
  // Overview, and the keyboard, Ctrl+K, multi select and change in the row.
  '/plans/overview.js': [path.join('plans', 'overview.js'), 'text/javascript; charset=utf-8'],
  '/plans/work.js': [path.join('plans', 'work.js'), 'text/javascript; charset=utf-8'],
  '/queuePlanView.js': [path.join('..', 'lib', 'queuePlanView.js'), 'text/javascript; charset=utf-8'],
};

/** HTML escaping for the title inserted into index.html. */
const escHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
/** index.html with the title from queue.config.json inserted ({{TITLE}}). */
const readIndex = () =>
  fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8').replaceAll('{{TITLE}}', escHtml(TITLE));

function correctKey(req) {
  const input = Buffer.from(String(req.headers['x-queue-key'] ?? ''));
  const answerKey = Buffer.from(KEY);
  return input.length === answerKey.length && crypto.timingSafeEqual(input, answerKey);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (b) => {
      n += b.length;
      if (n > 16_384) {
        reject(new Error('request too large'));
        req.destroy();
      } else chunks.push(b);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // DNS rebinding: a foreign page that points its name to 127.0.0.1 sends its own Host.
    if (!VALID_HOSTS.has(String(req.headers.host ?? '')))
      return send(res, 421, 'text/plain; charset=utf-8', 'Wrong host.');
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const filePath = url.pathname;

    if (!filePath.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return send(res, 405, 'text/plain; charset=utf-8', 'GET only.');
      if (filePath === '/theme.css')
        return send(res, 200, 'text/css; charset=utf-8', THEME_CSS, { 'Cache-Control': 'no-cache' });
      if (STATIC[filePath]) {
        const [file, type] = STATIC[filePath];
        const body =
          file === 'index.html' ? readIndex() : fs.readFileSync(path.join(CLIENT, file));
        return send(res, 200, type, body, { 'Cache-Control': 'no-cache' });
      }
      // The logo: without a key (an <img> cannot send the header), but only on a valid Host (checked above). An SVG gets
      // its own strict CSP, so it can never run script.
      if (filePath === '/logo') {
        const logo = findLogo();
        if (!logo) return send(res, 404, 'text/plain; charset=utf-8', 'No logo.');
        return send(res, 200, logo.type, fs.readFileSync(logo.path), {
          'Cache-Control': 'no-cache',
          ...(logo.type === 'image/svg+xml'
            ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }
            : {}),
        });
      }
      // The mascot's phrases: like /logo without a key, but only on a valid Host (checked above). Only text, no numbers
      // from the queue (they are in /api/state behind the key). An invalid file gives the default set and a log line.
      // With mode off there is nothing to say.
      if (filePath === '/mascot')
        return send(
          res,
          200,
          'application/json; charset=utf-8',
          JSON.stringify({
            mode: MASCOT_MODE,
            phrases: MASCOT_MODE === 'off' ? null : mascotPhrases(),
          }),
          { 'Cache-Control': 'no-store' },
        );
      return send(res, 404, 'text/plain; charset=utf-8', 'Does not exist.');
    }

    if (!correctKey(req))
      return json(res, 401, {
        ok: false,
        message: 'The key is missing or old. Open the link queue-board wrote in the terminal.',
      });

    if (req.method === 'GET' && filePath === '/api/state') {
      try {
        const t = state();
        if (url.searchParams.get('version') === t.version)
          return json(res, 200, { version: t.version, unchanged: true });
        return json(res, 200, { version: t.version, data: t.data });
      } catch (e) {
        return json(res, 503, {
          ok: false,
          message: `Could not read the queue (${e?.code ?? e?.message ?? 'unknown error'}).`,
        });
      }
    }
    if (req.method === 'GET' && filePath === '/api/statistics') {
      try {
        const s = statistics();
        if (url.searchParams.get('version') === s.version)
          return json(res, 200, { version: s.version, unchanged: true });
        return json(res, 200, { version: s.version, data: s.data });
      } catch (e) {
        return json(res, 503, {
          ok: false,
          message: `Could not build the statistics (${e?.code ?? e?.message ?? 'unknown error'}).`,
        });
      }
    }
    // The Plans space (read only). "unchanged" when nothing is new since the version the client has.
    if (req.method === 'GET' && filePath === '/api/plans') {
      try {
        let pl = plans();
        // Wait=1 holds the response until something has changed (live update).
        if (
          url.searchParams.get('wait') === '1' &&
          url.searchParams.get('version') === pl.version
        ) {
          await waitOnPlans(res);
          if (res.destroyed || res.writableEnded) return;
          pl = plans();
        }
        if (url.searchParams.get('version') === pl.version)
          return json(res, 200, { version: pl.version, unchanged: true });
        return json(res, 200, { version: pl.version, data: pl.data });
      } catch (e) {
        return json(res, 503, {
          ok: false,
          message: `Could not read the plan register (${e?.code ?? e?.message ?? 'unknown error'}).`,
        });
      }
    }
    // One markdown document for the reading view (read only; the path guard is queueBoard.readDocument).
    if (req.method === 'GET' && filePath === '/api/doc') {
      const r = T.readDocument(SOURCE_ROOT, url.searchParams.get('path'), { fs, path });
      if (!r.ok) return json(res, r.status, { ok: false, message: r.message });
      return json(res, 200, r);
    }
    // The Unregistered box (= queue.mjs plan check --json, only the unregistered documents).
    if (req.method === 'GET' && filePath === '/api/plan-check') {
      const r = await planCheck();
      return json(res, r.ok ? 200 : 503, r);
    }
    if (req.method === 'GET' && filePath === '/api/settings') {
      try {
        const queue = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        const stat = statistics().data;
        return json(res, 200, {
          ok: true,
          field: T.settings(queue),
          usageToday: stat.keyFigures.usageToday,
          night: L.nightGuard(queue),
          setup: setup(queue, stat),
        });
      } catch (e) {
        return json(res, 503, {
          ok: false,
          message: `Could not read the settings (${e?.code ?? e?.message ?? 'unknown error'}).`,
        });
      }
    }
    if (req.method === 'GET' && filePath === '/api/task') {
      const id = idOrNull(url.searchParams.get('id'));
      if (!id) return json(res, 400, { ok: false, message: 'invalid id' });
      const queue = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const o = (queue.tasks ?? []).find((x) => x.id === id);
      if (!o) return json(res, 404, { ok: false, message: `unknown task ${id}` });
      const mission = missionFor(o);
      const branch = branchFor(o);
      return json(res, 200, { ok: true, mission, branch: { name: branch, ...branchInfo(branch) } });
    }
    // The cloud package ("Copy cloud package"), made by queue.mjs cloud-package (which refuses when the task is not suitable).
    // Several ids (?id=A&id=B) = a bundle in one cloud session; the cap (4 tasks, about 120 min) is enforced by queue.mjs.
    if (req.method === 'GET' && filePath === '/api/cloudPackage') {
      const ids = url.searchParams.getAll('id').map(idOrNull);
      if (!ids.length || ids.length > 10 || ids.some((x) => !x))
        return json(res, 400, { ok: false, message: 'invalid id' });
      const r = await queueMjs(['cloud-package', ...ids]);
      if (!r.ok) return json(res, 409, { ok: false, message: r.error || 'cq cloud-package failed' });
      return json(res, 200, { ok: true, text: r.out });
    }

    // The "Cloud" view: proposed bundles with a ready cloud start command (= `queue.mjs cloud-bundles --json`).
    if (req.method === 'GET' && filePath === '/api/cloud-bundles') {
      const r = await queueMjs(['cloud-bundles', '--json']);
      if (!r.ok)
        return json(res, 500, { ok: false, message: r.error || 'cq cloud-bundles failed' });
      try {
        return json(res, 200, { ok: true, data: JSON.parse(r.out) });
      } catch {
        return json(res, 500, { ok: false, message: 'invalid response from cq cloud-bundles' });
      }
    }

    if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'unknown method' });
    // A write call must come from the board itself: Origin (when the browser sends it) and a JSON body.
    const origin = req.headers.origin;
    if (origin != null && !VALID_ORIGIN.has(String(origin)))
      return json(res, 403, { ok: false, message: 'foreign origin' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json'))
      return json(res, 415, { ok: false, message: 'application/json only' });
    let b;
    try {
      b = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { ok: false, message: 'invalid JSON' });
    }
    if (!b || typeof b !== 'object' || Array.isArray(b))
      return json(res, 400, { ok: false, message: 'invalid body' });
    const r = await oneAtATime(() => write(filePath, b));
    return json(res, r.status, r.answer);
  } catch (e) {
    return json(res, 500, { ok: false, message: `internal error (${e?.message ?? e})` });
  }
});

server.on('error', (e) => {
  console.error(
    e?.code === 'EADDRINUSE'
      ? `Port ${PORT} is in use. Pick another one with --port <nr>.`
      : `Board stopped: ${e?.message ?? e}`,
  );
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  if (!fs.existsSync(FILE)) console.log(`WARNING: could not find the queue ${FILE}.`);
  console.log(`Kanban board for the work queue is running (only on this machine).`);
  console.log(`Open: http://${HOST}:${PORT}/#key=${KEY}`);
  console.log(`Queue: ${FILE}. Ctrl+C stops the board.`);
});
