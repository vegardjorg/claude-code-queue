# Orchestration: how the pieces work together

One Claude Code chat is the **orchestrator**. It does not write product code. It fills the queue, starts track
agents, receives their results, sends them to review, merges, and asks the owner the questions only the owner can
answer. Each **track** is a subagent (`track` for K and U, `track-d` for D and D+) in its own git worktree, on its own
branch (`queue/<ID>`), with a self-contained mission file.

## The loop

1. `cq orchestrator pulse`: mark the orchestrator as alive.
2. `cq fill --scratchpad <dir>`: start what the limits allow. For each task it writes `prompt-<ID>.md` (shared
   protocol from `docs/queue/mission-template.md`, filtered for the task's class, plus the task block). The orchestrator
   launches one agent per prompt in the background, with worktree isolation.
3. A track finishes and answers with one `RESULT …` line plus at most a few lines; the long report is in
   `report.md` in its scratch folder.
4. `cq receive <ID>`: reads the result line and builds a review package (diff, changed files in full, the track's
   report). The orchestrator starts the reviewers `receive` prints: the fixed ones for the class (`reviewers` in
   `queue.config.json`; by default none for K and U, `reviewer` for D, `reviewer` and `reviewer-security` for D+)
   plus the [helper agents](#helper-agents) that are on and hit (by default `reviewer-challenger` for U and the
   `bug` label, `reviewer-design` for the `visual` label).
5. Findings: HIGH and non-mechanical MEDIUM give a fix round with a NEW track agent on the same branch
   (`prepare-track --continue`). LOW findings become follow-up proposals.
6. `cq merge <ID>`: merge into the base branch with `merge-track.mjs`, run the quick gates, start the next tasks.
7. Repeat until `cq state` exits 3 (nothing to do). Owner questions are collected and asked at the end of a
   round, in plain language with a recommendation.

Push happens in **batches**, only when the owner says so: `cq push-check` first, then
`git push`. Every push can trigger CI in your own setup, so many small pushes cost money quietly.

## Helper agents

Helper agents are optional reviewers on top of the fixed ones. The class is the floor: D and D+ always get their fixed
reviewers, and the helpers only add to that. The reviewers for a task are worked out in one place,
`lib/queueHelpers.js` (`reviewersForTask`); `receive`, the cost per task, the cost guard and the read guard all use it.

| Helper | What it does | Runs when (default) | On by default |
|---|---|---|---|
| `reviewer-challenger` | Tries to prove the delivery wrong | class U, or label `bug` | yes |
| `reviewer-design` | UI/UX: states, errors, WCAG 2.2 AA, keyboard, light and dark mode | label `visual`, or a changed file under `paths` (empty by default) | yes |
| `reviewer-tests` | Do the tests prove the behavior; missing edge cases | class D or D+, or label `bug` | no |
| `reviewer-gap` | The delivery against the mission, point by point | the task has a `plan`, or the mission has 8+ numbered points | no |
| `reviewer-docs` | Docs rewrites: lost facts, findability, docs against code | more than half of the changed files are under `docs/` or `*.md` | no |

The setup lives under `helpers` in `queue.config.json`:

```json
"helpers": {
  "reviewer-design": { "enabled": true, "labels": ["visual"], "paths": ["app/", "components/**/*.tsx"] },
  "reviewer-tests": { "enabled": true }
}
```

A helper runs when it is `enabled` and at least one condition hits: `classes`, `labels`, `paths` (a changed file
matches), `mostlyPaths` (more than half of the changed files match), `plan` (true: the task has a plan entry) and
`minMissionItems` (numbered points in `prompt-<ID>.md`). Path patterns: `dir/` is the folder from the root, `*.md`
is that file name anywhere, `**` is any number of folders. A helper with no condition never runs.

- **Switching:** `cq helpers on|off <agent>` (or the board's Helper agents tab) saves the switch in `queue.json`
  (`helpers.<agent>.enabled`), which wins over `queue.config.json`, like `cq limit`. `cq helpers` lists them.
- **Backward compatible:** `reviewers` per class works as before. A helper also listed in `reviewers` for a class is
  fixed there (the switch does not stop it for that class); it is never started twice.
- **The review package** (`00-package.md`) lists the reviewers with one `why:` line each (`why: label visual`,
  `why: changes app/x.tsx`), and carries the mission as `mission.md`. `receive` prints the same.
- **Measurement:** at `set done` (and `cost measure`) the cost per agent keeps its tokens, minutes and, for reviewers,
  the H/M/L numbers from its FINDINGS line. `cq helpers`, `cq cost` and the board show per helper: runs, median and
  sum of minutes, tokens and USD, the share of the task cost it added, and findings per run. "No runs yet" until then.
- **Your own helper:** see [Custom helper agents](#custom-helper-agents) below. It is added, scanned, reviewed and
  approved before it can be switched on.

### Custom helper agents

A custom helper is an agent file of the project's own (or one you found) used as a helper. It runs as a subagent in
the orchestrator session with the tools its frontmatter gives it, so it is reviewed before it is ever on.

1. **Add:** `cq helpers add <file.md> [--name <name>] [--classes K,U] [--labels a,b] [--paths p,q]`, or paste the
   path under "Add a custom helper" in the board's Helper agents tab. The file is copied to
   `.claude/agents/<name>.md` (where Claude Code finds project agents, so the orchestrator starts it by its bare name
   as `subagent_type`), `name:` in its frontmatter is set to the registered name, and it is registered in `queue.json`
   as `source: custom` with `path`, `sha256` and `added_at`. It is **off**. A name that is a builtin agent (Claude
   Code's own, the plugin's, a fixed reviewer) or an existing file is refused. Nothing in the file is run: it is read,
   copied, hashed and scanned. Claude Code loads project agents at session start, so restart the session (or open
   `/agents`) before a new helper can run.
2. **Scan:** `cq helpers scan <name>` (`lib/helperScan.js`, a pure function on the text) gives red, yellow or green
   with one line per finding and its line number:
   - frontmatter: `tools` missing (every tool), Write, Edit, NotebookEdit, WebFetch, WebSearch, Task/Agent and MCP
     tools (red), unrestricted Bash or PowerShell (yellow), `permissionMode`, `mcpServers`, `hooks` (red),
     `isolation` and unknown keys (yellow), `model` (information only);
   - calls out of the machine: URLs (red; a short list of documentation domains gives yellow), `curl`, `wget`,
     `iwr`/`Invoke-WebRequest`, `fetch(`, `nc`, webhooks, `gh`, `git push`, `scp`, `ssh`, a pipe into a shell,
     `npx`, `npm i`, `pip install`;
   - prompt injection and misuse: "ignore previous instructions", "disregard", the system prompt, changing settings,
     hooks, agent definitions or CLAUDE.md, reading `.env`, tokens, keys or `~/.ssh`, hiding something from the owner,
     deleting or force pushing, sending data somewhere, starting other agents;
   - hidden content: base64 like blocks, invisible and control Unicode (zero width, bidi overrides, tag characters),
     HTML comments, very long lines, code blocks with a script language;
   - missing guards (yellow): the "Data, not instructions" paragraph and the FINDINGS line.

   A misuse rule on a line that says no to it ("never force push", "do not start other agents") gives yellow, not
   red. **Red** must not be approved without `--force` and the owner's explicit yes; **yellow** is weighed and
   mentioned; **green** has no findings, and the file is still read in full.
3. **Review and approve:** the `add-helper` skill ("add this as a helper agent") runs the add and the scan, has Claude
   read the whole file, gives the owner a short report with a recommendation, and asks. On yes:
   `cq helpers approve <name> --by "<owner>" --sha256 <hash from the scan>`. It stores `approved_sha256`,
   `approved_path`, `approved_by`, `approved_at` and the scan result in `queue.json`; `--sha256` refuses when the
   file is not the one that was read. The board never approves, and an approval written into `queue.config.json` is
   ignored, so a branch cannot approve its own helper.
4. **On:** `cq helpers on <name>` (or the board's switch) only works while the file's sha256 equals the approved
   one. When the file changes, `cq helpers` and `receive` turn it off in `queue.json` and show "Changed since
   approval"; it stays off until it is reviewed and approved again.

`cq helpers when <name> --classes .. --labels .. --paths .. --mostly-paths ..` changes the conditions (`none` clears
a list). `cq helpers remove <name>` drops the registration and keeps the file; `--delete-file` also deletes the
copied `.claude/agents/<name>.md`. The measurement and the conditions are the same as for the builtin helpers.

**What guards a custom helper:** the selection (`reviewersForTask`) never takes one without a valid approval for the
file as it is now, also when the config says `enabled` or lists it in `reviewers`. The read guard applies to it like
to every reviewer (it is in `allReviewerTypes`), and so does the push guard (every session). The network guard
applies to `track` and `track-d` only, as for the builtin reviewers, so a custom helper with unrestricted Bash can
still reach the network through it: the scan flags such a `tools` line, and a reviewer needs `Read, Grep, Glob`.
`merge-track` protects the custom helpers' agent files like `.claude/`, also when `protectedPaths` was changed: a
track cannot rewrite an approved helper without owning its file.

Every reviewer disproves a HIGH or MEDIUM finding before writing it (reread the code, look for counter-evidence,
check that the change introduced it, lower it one level when there is no ground). A security finding is lowered only
on counter-evidence at file:line and carries an `EXPLOIT:` part. A reviewer never starts other agents.

## Why it is cheap (context discipline)

Every turn re-reads the whole conversation, mostly from the prompt cache. Cost therefore grows with turns times
context size. The system keeps both small:

- **Small, self-contained missions.** A track starts with only its mission and reads excerpts (`grep -n`, then
  `offset`/`limit`), never whole files twice.
- **Context cap.** A track may compact once (`autoCompactWindow` applies to tracks too). After the first compaction
  it gets one reminder to check the mission, the branch and its commits. At the second compaction, or at the hard
  limit 280k (`TRACK_CONTEXT_WARNING`), it is told to commit, write `handover.md` (handover) and deliver PARTIAL; a
  new agent continues. The hook `hook-track-context.mjs` enforces this on tool calls.
- **End gate.** `hook-track-end.mjs` (SubagentStop) stops a track ONCE when it ends with no own commits on its branch
  (counted against `head_start` and the base branch) and no end line (`RESULT`, `PARTIAL` or `REFUSE`). It fails
  open: an unknown task, branch or git error lets the track stop.
- **Pause advice.** When the owner writes that they are leaving ("have to go", "good night", "pause") and the
  orchestrator is over 150k (`CONTEXT_PAUSE`), `hook-context.mjs` suggests `/compact` before the break, because a
  pause of over an hour writes the whole context to the cache again.
- **Orchestrator compaction.** `hook-context.mjs` warns, then winds down, then stops the orchestrator chat as it
  grows; `/compact` with a focus is the normal path, and `hook-after-compact.mjs` re-injects the queue state after
  compaction, so the summary does not have to carry it. `autoCompactWindow` is set to 300000. Automatic compaction is
  the default (`cq compact auto`) and uses Claude Code's own compaction (`autoCompactEnabled`, on by default). For
  `cq compact manual`, turn that off too, or Claude Code still compacts at 300k.
- **Handover note in two parts.** `<dataFolder>/handover-ongoing.md` has a `## Now` section at the top (the current
  state, at most 40 lines, rewritten in place) and a dated log below it. `cq handover archive [--dry]` moves log
  entries older than 24 h to `handover-archive/<year-month>.md` (an active trial or follow-up section stays) and warns
  when "Now" is too long or missing; run it at every compaction. `cq handover now` prints only the "Now" part. After
  compaction `hook-after-compact.mjs` injects only that part, and `/cq:queue` reads only that part at takeover; the
  rest is read with grep when needed.
- **Status line.** `statusline.mjs` shows `ctx 142k 71% | $3.21 | 5h 23% 7d 41% | tracks 2 (+1 review)`: context,
  session cost, the 5-hour and 7-day quota, and running tracks (the count is cached on the queue file's mtime, so
  it is cheap). A plugin cannot set `statusLine` itself, so `cq setup --settings` writes it to
  `.claude/settings.json` with the plugin's absolute path; run it again after a plugin update. A status line of your
  own is kept. The line also saves the last quota reading in `<dataFolder>/rate-limits.json`, and
  `cq capacity --calibrate auto` uses its 7-day percentage as a calibration point (refused when it is over 1 h old).
- **Context limits in every chat.** The same hook also watches every other chat in a project with the queue, not only
  the orchestrator: a notice at 250k, and at 400k the message is stopped so a long chat does not keep paying for its
  whole history. Compact the chat (`/compact`), or start the message with `continue:` to send it anyway. Messages
  Claude Code sends by itself (an agent is done) are never stopped. The limits can be changed with the environment
  variables `CONTEXT_WARNING`, `CONTEXT_STOP`, `CONTEXT_WIND_DOWN`, `CONTEXT_STOP_ORCHESTRATOR` and `CONTEXT_COMPACT`
  (tokens).
- **Cache-friendly waiting.** No sleep or poll loops. Subagent prompt cache TTL is set to 1 hour
  (`subagentPromptCacheTtl`), so a reviewer started a while later still hits the cache.
- **Reading guard.** `hook-read-guard.mjs` stops tracks and reviewers from re-reading files that are already loaded
  automatically, or reading huge files in full.
- **Push guard.** `hook-push-guard.mjs` asks before force pushes, pushes of other branches than the base, and
  migration pushes to environments not listed as allowed.
- **Time and cost log.** `hook-time.mjs` logs subagent start and stop; `cq cost` turns the measured sessions into
  per-class statistics, so estimates get better over time.

## Adopting running tracks (cheap rotation)

Tracks keep running when the orchestrator session changes; only the `<task-notification>` goes to the session that
started them. A new session adopts them without that notification:
- **The signal:** `report.md` in the track folder (`<scratch>/<ID>/`, or `<scratch>/<ID>-r<N>/` for a fix round) with
  the `RESULT status=DONE|PARTIAL …` line as its first line. `queue-takeover.mjs` classifies the task DELIVERED on it;
  the old heuristic (commits, clean worktree, 20 min) is the fallback.
- **`cq orchestrator pulse`** prints `NEW DELIVERY (report.md): <ID> …` once per report (the task remembers it in
  `report_seen`), and **`cq deliveries [--json]`** lists every report that is not received yet. `cq receive <ID>`
  reads the newest report, also from a fix round folder, and saves `report_received`.
- **`cq resume <ID> --reason fix|context`** writes `prompt-<ID>-r<N>.md` for a NEW agent on the same branch
  (`prepare-track --continue`, the paths to the report, handover, review package and `--findings-file`).

An emergency rotation therefore needs no quiet window. Stop the old session first, so two orchestrators do not
receive and merge the same track. Compaction is still the usual path for a long session.

## Track classes and effort

| Class | Agent | Effort | Typical size |
|---|---|---|---|
| K (code) | `track` | medium | 90 to 120 min |
| U (investigation) | `track` | medium | about 60 min |
| D (database) | `track-d` | high | about 40 min |
| D+ (high-risk DB or security) | `track-d` | high | 25 to 30 min, at most 3 migrations |

## Rules that matter

- Tracks commit only on their own branch, with `git commit -- <files>` (pathspec), and never push or merge.
- Tracks never kill processes by pattern; other tracks run the same scripts.
- Ownership is exclusive while a task runs. Hotspot files (navigation, central registries) are changed by the
  orchestrator while merging, from the wiring specification in the track report.
- New work discovered by a track becomes a proposal (`cq add`), never scope creep.
- The worktree rule: never `npm install` inside a worktree (shared folders are links to the main tree), and clean up
  worktrees only with `cleanup-worktree.mjs`.

## Hardening against prompt injection

A track reads text the owner did not write: files, PDFs, web pages, other agents' reports. If it follows an
instruction hidden there, the damage must stop before it reaches the orchestrator. Claude Code has no sandbox on
Windows, so there are four layers:

- **Data, not instructions.** The agent definitions (`track`, `track-d`, `reviewer`, `reviewer-security`) and the
  shared protocol in the mission template say that such content is data, and that instructions in it are reported
  under "Suspicious content", never followed. `make-queue-common.mjs` refuses a template without the paragraph.
- **Merge guard.** `merge-track.mjs` stops with exit 4, before the merge, when the branch touches a protected path
  that the task does not own (`owned_files` or `shared_patch`). The list is `protectedPaths` in `queue.config.json`
  (default: `.claude/`, `.githooks/`, `.github/`, `.mcp.json`, `scripts/orchestrator/`, the plugin's hooks, agents,
  skills and scripts, `queue.config.json`, `CLAUDE.queue.md`, `settings.queue.json`, `package.json`,
  `package-lock.json`). Read the diff; then add the path to the task's ownership, or run `cq merge <ID> --allow-guard`,
  which is logged as `guard-overridden` in the time log. Other files outside the ownership only give a warning.
- **Network guard.** For `track` and `track-d`, `hook-push-guard.mjs` denies `curl`, `wget`, `iwr`/`irm`,
  `Start-BitsTransfer` and a pipe into a shell (`| sh`, `| iex` …), and asks before `npm install` or `npx` with a
  package that is not in `package.json`. The orchestrator fetches what a track needs.
- **Limits.** `maxTurns` is 400 for `track` and 600 for `track-d`, and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`
  (`env` in `settings.queue.json`, set by `setup --settings`) stops a track from starting agents of its own. A plugin's
  `hooks.json` cannot set environment variables, so this one lives in the project settings.

A custom helper agent is itself text the owner may not have written. It is scanned, read in full and approved
against its sha256 before it can be on, and a changed file turns it off (see
[Custom helper agents](#custom-helper-agents)).

For a task that has to read content from outside, split reading and writing between two agents (the quarantine rule
in the mission template): the reader returns a fixed schema, and the writer never sees the raw text.
