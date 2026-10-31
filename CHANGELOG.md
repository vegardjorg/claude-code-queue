# Changelog

All notable changes to claude-code-queue (the `cq` plugin). The version is in `plugin/.claude-plugin/plugin.json`
and `package.json`.

## Unreleased

### Added
- **`cq help` in groups, and "Did you mean"**: `cq help` prints 14 key commands in four groups (Get started, Daily,
  Owner, Orchestrator) instead of about 200 lines; `cq help all` prints every command with its full description (the
  old filter cut many off mid-sentence) and puts the internal scripts (make-queue-common, make-mission,
  cost-guard-statistics, context-measure, statusline) under "Internal"; `cq help <command>` prints one command in full,
  or a script's header. An unknown command prints `Unknown command "shwo". Did you mean "show"? See cq help.` (edit
  distance up to 2, or a prefix; nothing when nothing is close; exit code unchanged). The logic is in `lib/cliHelp.js`.
- **Forecast**: `cq forecast [--project <pid>] [--days 28] [--json]` says when the remaining tasks (the focus stages,
  otherwise all open work) are done at 50, 85 and 95 %, from a Monte Carlo over the daily throughput in the window
  (zero days included), with the sample size and the expected cost (remaining x median measured cost). "Not enough
  data" under 5 done. The board shows it as a box in the Focus view and a line in Statistics (`lib/queueForecast.js`).
- **Auto-accept of proposals** (default off): `cq proposals auto on|off [--classes K,U] [--max-estimate <min|none>]
  [--max-value <1-10|none>]`, `cq proposals log` and `cq proposals undo <id>`. A proposal that fits the rules is
  approved by `cq add` and `cq orchestrator pulse` through the approve path, with a remark and a log entry
  (`auto_accepted`). Never D or D+, `waiting_on`, legal/owner labels, a plan entry with open legal points or a
  protected path. Config default `proposals.autoAccept`; the board's gear has the switch, the rules and the log with
  Undo (`lib/queueProposals.js`).
- **Started without agent**: `cq show`, `cq state` (`withoutAgent`) and `cq orchestrator pulse` warn about tracks
  marked running for more than 15 minutes whose branch no worktree has checked out and that have no report, with the
  fix (`cq set <id> waiting`, then `cq fill --ids <id>`). `fill` only marks tracks; when it ran where nobody read the
  output (a background `merge`, a chained merge script), tracks could stand for hours without an agent. The
  after-compact resume text names the check, and `merge` ends its fill excerpt with a note to use `--without-fill`
  when the output is not read.
- **Module switches**: `features` in `queue.config.json` (`plans`, `plans.legal`, `plans.launch`,
  `plans.documents`, `focus`, `statistics`, `cloud`, `follow`; one table in `lib/queueConfig.js`, helpers
  `features()` and `featureOn()`). The board hides the tabs, buttons, filter, detail row and routes of modules that
  are off, and the gear shows a read-only **Modules** section. `cloud*` and `follow*` commands answer "Cloud is off
  (features.cloud in queue.config.json)." (or Follow) with exit 0, and `show` and the pulse skip follow-up lines
  when follow is off. The plan register is never gated in the CLI.
- **First-run card**: a queue with nothing open shows three steps (add work, `/cq:queue`, "Waiting on you") and a
  link to the help instead of empty columns. README: "First run in 5 minutes".

### Changed
- **Off by default**: cloud sessions, follow-up entries and the Legal, Launch and Documents surfaces in Plans. Set
  `features.<name>` to `true` in `queue.config.json` to turn them on.
- `cq diagnose` and the parallelism paragraph (fill, receive, pulse) no longer say LOW PARALLELISM when nothing can
  start (the waiting tasks only wait on running work, a limit or a pause, and no finding would release one).

## 0.4.0 (2026-10-31)

### Changed
- **The network guard covers reviewers and helper agents**: `curl`, `wget`, `iwr`, a pipe into a shell and an
  unknown `npx` package are now blocked (or asked about) for every reviewer and helper agent, builtin or custom, not
  only for `track` and `track-d`. The list is the read guard's (`queueAgentTypes`), also with the `cq:` prefix. The
  orchestrator is still not affected.
- `reviewers.U` is empty by default; the challenger for U now comes from `helpers` (same result, but it can be
  switched off). A config that lists `reviewer-challenger` under `reviewers.U` keeps it as a fixed reviewer.
- The read guard also covers `reviewer-challenger` and every helper agent in the setup.

### Added
- **Fail-fast precheck**: `cq gates --precheck` runs the cheapest checks first, in a fixed order, only on the files
  changed against `baseBranch`, and stops at the first red one. The checks are `gates.precheck` (commands or
  `{ name, command, files, budgetSec }`, with `{changed}` or `{file}`); the default `null` gives `node --check` on the
  changed JS files, `tsc --noEmit`, eslint on the changed files and the related tests (vitest or jest) when the project
  has them locally. A check with no relevant changed file is skipped, each check has a time budget
  (`gates.precheckBudgetSec`, 120 s; exit 3 over it), and `--json` gives a machine-readable summary. The mission
  template and the `track`/`track-d` agents run it before the class's full gate, which is unchanged.
- **Custom helper agents**: `cq helpers add <file.md> [--name] [--classes/--labels/--paths]` (or **Add a custom
  helper** in the board's Helper agents tab) copies an agent file to `.claude/agents/<name>.md` and registers it in
  `queue.json` as `source: custom` with its sha256, off. Nothing in the file is run, and a builtin name is refused.
  `cq helpers scan` (`lib/helperScan.js`) gives red, yellow or green with line numbers for the frontmatter tools and
  keys, calls out of the machine, prompt injection and misuse, hidden content and missing guards. The new `add-helper`
  skill has Claude read the whole file and ask the owner; `cq helpers approve <name> --by .. --sha256 ..` binds the
  approval to the hash (a red scan needs `--force`). A custom helper can only be switched on, and is only picked by
  `reviewersForTask`, while its file matches the approved hash; a changed file is turned off and shown as "Changed
  since approval". The board shows the custom badge, the scan, the review state and who approved it, and can never
  approve. `cq helpers when` changes the conditions and `cq helpers remove [--delete-file]` drops one. The read guard
  and the push guard cover custom helpers, and `merge-track` protects their agent files.
- **Helper agents**: optional reviewers on top of the fixed ones per class, switched with `cq helpers on|off <agent>`
  or the new **Helper agents** tab in the board's settings (saved in `queue.json`, which wins over the new `helpers`
  block in `queue.config.json`). Each runs when it is on and one condition hits: class, label, changed paths, most
  of the diff, a plan entry or the number of mission points. New agents `reviewer-design` (on for `visual`),
  `reviewer-tests`, `reviewer-gap` and `reviewer-docs` (off), adapted from testdouble/han (MIT, see NOTICE);
  `reviewer-challenger` moves into the same system (on for U and `bug`). The reviewers for a task are worked out in
  one place (`lib/queueHelpers.js`) and used by `receive`, the cost per task, the cost guard and the read guard.
  The review package lists each reviewer with a `why:` line and carries the mission as `mission.md`.
- **Helper measurement**: the cost per agent now keeps its tokens, minutes and FINDINGS numbers, so `cq helpers`,
  `cq cost` and the board show per helper the runs, median and total minutes, tokens and USD, its share of the task
  cost and findings per run.
- **Counter-evidence step in every reviewer**: a HIGH or MEDIUM finding is disproved first (reread, look for an
  existing guard or test, check that the change introduced it, lower it one level without ground). Security findings
  are lowered only on counter-evidence at file:line and carry an `EXPLOIT:` part; `Unverified:` lines and a
  self-consistency rule for all.
- **Update banner on the board**: the board server checks GitHub for a newer `cq` at most once per 24 hours (a plain
  GET with a short timeout that sends nothing about you; errors are silent) and shows "cq X is out (you have Y)" with
  a CHANGELOG link and copyable update steps. Close it per version. Off with `board.updateCheck: false` or
  `DISABLE_UPDATES` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
- **Setup notice after an update**: `cq setup --settings` records the plugin version in `<dataFolder>/setup.json`,
  and the board says when the installed plugin differs from it (local, works with the check off). The vendored
  installer writes `scripts/orchestrator/cq-version.json` so the board knows that version too.

### Upgrading
Update the plugin, then run `cq setup --settings` once, and restart the session (or run `/agents`) so the new
reviewer agents are picked up.

## 0.3.0 (2026-10-30)

Fixes and features ported back from the queue in the project cq was split out of.

### Added
- **Status line** (`statusline.mjs`): context size, session cost, the 5-hour and 7-day quota and running tracks.
  A plugin cannot set a status line itself, so `cq setup --settings` writes it with an absolute path. Run it again
  after each plugin update.
- **Handover note in two parts** (`cq handover archive|now`): after compaction the orchestrator reads only the "Now"
  part; dated log entries older than 24 hours move to `handover-archive/<year-month>.md`.
- **Quota calibration from the status line**: `cq capacity --calibrate auto` uses the 7-day percentage the status
  line saw last.
- **Adopting running tracks**: a track's `report.md` carries the RESULT signal, so a new orchestrator chat can take
  over tracks that are still running. New commands `cq deliveries` and `cq resume <id> --reason fix|context`; the
  pulse prints NEW DELIVERY, and `cq receive` finds fix-round reports.
- **Migration blocks**: start, fill and pick skip blocks that are already taken; `cq migr move <id> <block>` moves a
  task to another block.
- **Load guard**: no new starts (exit 7) while free memory is below `loadGuard.minFreeMemoryPct` or
  `cq limit minFreeMemoryPct`. Off by default.
- **Focus clean-up**: `cq focus evaluate` and `cq focus clean` take done focus stages out (also automatic, and it can
  be undone).
- **Follow-up entries**: `cq follow add|log|show|report|close|extend` for something to watch over a period, with its
  own board page at `/follow`.
- **QA evidence**: tracks write an `EVIDENCE` line in the report; `cq qa evidence <id> <type>` sets it by hand, and
  `cq qa auto --run` closes entries whose automatic evidence is green. The types are in `config().qa`.
- **`plan check`** also shows index drift against the plan register (field `index` in `--json`).

### Security
- **Merge guard**: `merge-track` stops (exit 4) when a branch changes hooks, settings, agents, the orchestrator
  scripts or the queue config without owning them (`protectedPaths` in `queue.config.json`; `--allow-guard`
  overrides).
- **Network guard for tracks**: tracks cannot run `curl`, `wget`, `iwr` or a pipe into a shell.
- **Data, not instructions** in every agent file and the mission template, checked by `make-queue-common`.
- **Agent limits**: `maxTurns` 400/600 and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` in `settings.queue.json`.
- **Context guards after compaction**: a track that compacts twice or passes 280k stops as PARTIAL; a SubagentStop
  end gate (`hook-track-end.mjs`) stops a track once if it ends without a commit and without a RESULT line; pause
  advice above 150k.

### Fixed
- The plan room no longer shows a raw "null" text when optional parts are missing.
- The board builds the queue lookups once per board instead of once per card: with 3,000 tasks it went from about
  59 s to about 0.15 s.
- The fallback migration pattern in `queue.mjs` had lost its backslashes (the same bug as in `setup.mjs` in 0.2.1).

### Upgrading
Update the plugin, then run `cq setup --settings` once to get the new hooks and the status line.

## 0.2.1 (2026-10-29)
- Fixed the broken hook-path regex in `setup.mjs`, and every shipped script is syntax-checked in the tests.
