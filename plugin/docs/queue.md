# The work queue (`cq`)

The queue is a JSON file (`scripts/.queue/queue.json`, gitignored) with tasks, owner questions, projects, limits and cost
data. It survives when the orchestrator's chat is compacted or restarted, because nothing important lives only in
the chat. Every command is `cq <command>`; `cq help` prints the full usage list (the comment at the
top of `queue.mjs`). The table below lists the important ones.

Writes happen under a file lock (atomic `mkdir`) and via temp file plus rename, so two writers (the orchestrator and
a track adding a proposal) cannot corrupt the file. `cq undo` undoes the last change.

## A task

```json
{
  "id": "AUTH-3",
  "title": "Rate limit on the login endpoint",
  "domain": "auth",
  "class": "K",
  "mission": "Self-contained description of what to do and how to verify it.",
  "value": 7,
  "content_min": 60,
  "depends_on": ["AUTH-2"],
  "waiting_on": [],
  "owned_files": ["src/auth/rateLimit.ts", "src/auth/__tests__/rateLimit.test.ts"],
  "owner_db": [],
  "shared_patch": [],
  "project": "auth",
  "feature": "Login",
  "source": "docs/auth-plan.md § 2"
}
```

| Field | Meaning |
|---|---|
| `id`, `title` | Unique id and title |
| `domain` | Domain; limits how many tracks run in the same domain (`maxPerDomain`) |
| `class` | `K` code, `D` database, `D+` high-risk database or security, `U` investigation (no production code) |
| `mission` | The mission text. Must be self-contained: the track agent knows nothing else |
| `value` | Value 1 to 10, used for ranking |
| `content_min` | Estimated minutes |
| `depends_on` | Task ids that must be done first |
| `waiting_on` | Registered owner question ids that block the task until answered |
| `owned_files`, `owner_db` | Files and DB objects the task owns exclusively while it runs |
| `shared_patch` | Shared functions the task changes in patch form |
| `project`, `feature`, `source` | Project id (must exist), feature name, and the plan section the task comes from |
| `batched` | `true` for small low-value tasks: they go to the batch queue (`cq batch`) instead of their own track |

Status flow: `proposed` → `waiting` (approved, ready to run) → `running` → `review` → `done`, or `cancelled`. Tasks
added by an agent start as `proposed` and need `approve`; tasks the owner or the orchestrator adds start as `waiting`.

## Everyday commands

| Command | What it does |
|---|---|
| `init` | Creates an empty queue (run once per project) |
| `add --file task.json` / `add --json '{…}'` | Adds one task or a list |
| `approve <id>` | Approves a proposal |
| `show` / `show --full` | Short view (under about 3,000 characters) / full table |
| `next` | What can start now, without changing anything |
| `fill --scratchpad <dir>` | Starts as many tasks as the limits allow and writes the mission prompts |
| `receive <id>` | Receives a finished track: reads the RESULT line, builds the review package |
| `deliveries` | Tracks with a `report.md` (RESULT line on top) that is not received yet; the pulse prints new ones as `NEW DELIVERY` |
| `resume <id> --reason fix\|context` | Writes `prompt-<id>-r<N>.md` for a new agent on the same branch (fix round or continuation of an adopted track) |
| `merge <id>` | Merges the track branch into the base branch (after review). Exit 4: the merge guard stopped it (protected paths the task does not own); `--allow-guard` overrides |
| `set <id> <status>` | Sets status by hand |
| `edit <id> --json '{…}'` | Changes fields |
| `info <id>` | Short view of one task |
| `question` / `resolve <q> --answer "…"` | Owner questions / answer one (waiting tasks get the answer in their mission) |
| `limit [<name> <value>]` | Limits: `maxConcurrent`, `maxDPlus`, `maxPerDomain`, `dailyBudget`, night window, `minFreeMemoryPct` |
| `next-migr [<n>]` / `migr move <id> <block>` | Migration flow only: show or set the next number / move a task's block in the queue and its prompt files |
| `cost` | Cost statistics per class (median, average) from the measured track sessions |
| `projects`, `project <pid> …` | Projects: progress, pause, prefixes |
| `focus set <steps>` | Focus period: only these steps are started |
| `focus evaluate [--json]` / `focus clean [--dry]` | Each stage as active, done-with-rests (batch queue, proposals, owner questions, QA, with a suggestion per rest) or done / takes out the done stages (history and changelog, so `undo` works; the last stage stays). `receive`, `set <id> done\|cancelled` and `fill` clean automatically, and the board hides done stages |
| `park <id>` / `continue <id>` | Park / unpark |
| `pick <id> --by "<who>"` / `deliver <id>` | A person or a separate chat takes a task by hand / delivers it |
| `diagnose` | Why the queue runs fewer tracks than it could (with suggested fixes) |
| `state` | Machine-readable state (exit 3 when there is nothing to do) |
| `undo` | Undo the last write |
| `qa` / `qa ok <id…>` / `qa deviation <id> "…"` | The QA list (split into what to look at, a manual round and auto entries) / the owner approves / the owner finds a deviation (fix task `<id>-QA<n>`) |
| `qa evidence <id> <type>[=<ref>]` / `qa auto [--run]` | Sets the QA evidence by hand (`receive` reads the `EVIDENCE` line in `report.md`) / runs `qa.autoCommand` for auto evidence and closes the green entries |
| `follow [add\|log\|show\|report\|close\|extend]` | Follow-up entries: observations with a start, an end, goals, a log and a fixed report template (see below) |

### Follow-up entries

A follow-up entry (`F-…`) is something to watch over a period: an internal test, a trial after an owner decision, a
variable to measure. It lives in `<dataFolder>/follow.json` (under the queue's lock), not in the memory or the
handover note.

```json
{ "id": "F-AUTOCOMPACT", "title": "Trial of automatic compaction", "why": "Is anything lost?",
  "start": "2026-10-08", "end": "2026-10-15", "owner": "orchestrator",
  "goals": [{ "name": "losses", "how": "read the handover note after each compaction", "expected": "0" }],
  "close_action": "cq compact manual" }
```

- `follow add --file <json>` adds it (status `active`), `follow log <id> --text "…" --value name=x` logs along the
  way, `follow extend <id> --to <date>` moves the end, `follow` lists and `follow show <id>` shows one.
- From the end date (the machine's local calendar day) the entry is `to-report`: `show` and `orchestrator pulse`
  print TO REPORT until `follow report <id>` writes `<dataFolder>/follow/<id>-report.md` from the fixed template
  (Question, Setup, Measurements, Findings, Deviations and losses, Recommendation, Owner decision).
- `follow close <id> --decision "…"` (or `--cancelled`) records the owner decision, writes the report again with it
  and prints the close action. The command never runs the close action itself.
- The board shows the entries read only at `/follow`.

## Limits and safety

- `maxConcurrent` (parallel tracks), `maxDPlus`, `maxPerDomain` and `maxDb` stop the queue from starting more than
  the codebase and your plan can take.
- Two tasks that own the same file or DB object never run at the same time.
- `dailyBudget <usd>` stops new starts when the day's measured spend (API-equivalent) is used up. The night window
  (`nightRun`, `nightWindow`) can pause starts at night.
- The load guard (`limit minFreeMemoryPct 15`, or `loadGuard.minFreeMemoryPct` in the config) stops new starts with
  exit 7 ("THE MACHINE IS FULL") while free memory is below the limit. Off by default. Running tracks finish;
  `start --force` and `fill --over-load` override.
- With a migration flow, `start`, `fill` and `pick` skip taken blocks: a migration file, the block of a task that is
  not finished, or a block named on a "migration block" line in an active prompt file (a move by hand).
  `next-migr` refuses a number inside a taken block.
- Times are the machine's local time: the night window, the day the daily budget counts, the weekly quota reset
  and the statistics per day. To use another time zone, set the `TZ` environment variable (for example
  `TZ=America/New_York`) for Claude Code.
- Agents may only ADD proposals. Approval, merging and pushing belong to the orchestrator and the owner.

## Configuration

Project-specific values live in `queue.config.json` at the project root (see `queue.config.example.json`): base branch,
branch prefix, gate commands, migration folder (optional), areas (`modules`) for the plan register, board port and title,
reviewer agents per class. Missing values fall back to safe defaults.

| Key | Default | Used for |
|---|---|---|
| `baseBranch`, `remote`, `branchPrefix` | `main`, `origin`, `queue/` | Integration branch, push remote, track branch names |
| `gates.quick`, `gates.full` | `[]` | Commands `gates.mjs` runs (empty = green) |
| `migrations.folder` | `null` | Optional numbered migrations; `null` turns block numbering and migration push off |
| `migrations.pushCommand`, `environmentFile`, `allowedEnvironment` | `null`, `null`, `[]` | `merge` runs the push command after merging (skip with `--without-migr-push`), but only when the environment file names an allowed environment |
| `reviewers` | D: `reviewer`, D+: `reviewer` + `reviewer-security` | Reviewer agents per class after `receive` |
| `architectureRules` | `[]` | Short rules copied into every mission |
| `sharedLinks` | `["node_modules"]` | Folders linked into each worktree instead of reinstalled |
| `readGuard` | built-in lists | Extra agent types, auto-loaded files and large-file globs for the reading guard |
| `cloudHidden` | `[]` | Paths a cloud session cannot see (missions pointing there are stopped) |
| `capacity` | Tuesday 19:00 local time | Weekly quota reset for `cq capacity` |
| `loadGuard.minFreeMemoryPct` | `null` (off) | Load guard: no new starts while free memory (percent) is below it; `cq limit minFreeMemoryPct` overrides per queue |
| `qa.evidenceTypes`, `qa.autoTypes`, `qa.manualTypes` | `screenshot`, `test`, `manual`; auto `test`; manual `manual` | QA evidence types a track writes as `EVIDENCE <type>[=<ref>]`; auto types are closed by `qa auto --run`, manual ones gathered in one round |
| `qa.autoCommand` | `null` | Shell command for auto evidence, e.g. `npx vitest run {refs}` (`{refs}`, `{id}`; or `{ "<type>": "<command>" }`); `null` = `qa auto` only lists |
| `qa.evidenceLabels` | `["visual"]` | Labels for which `receive` warns when the `EVIDENCE` line is missing |
| `excludeBranches` | `["main","master"]` | Branches never treated as external work |
| `protectedPaths` | `.claude/`, `scripts/orchestrator/`, plugin hooks/agents/skills, `queue.config.json`, `CLAUDE.queue.md`, `package.json` … | Merge guard: a track may only change these when its task owns them; `[]` turns it off |
| `modules`, `projectModuleSuggestion`, `priorityRules`, `documentFolders`, `indexFile`, `documents`, `planBackup` | see `queue.config.example.json` | Plan register (see `plan-register.md`) |
| `board.port`, `board.title` | `2000`, `Queue board` | Board |
| `board.updateCheck` | `true` | Board: look for a newer cq on GitHub at most once per 24 hours (see board.md, Update banner) |
