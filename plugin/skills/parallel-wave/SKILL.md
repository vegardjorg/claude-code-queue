---
name: parallel-wave
description: Default way of working for ALL parallel work in this project (several agents at once, tracks in worktrees, orchestration through the work queue). Use it every time work is to be split across several agents or tracks, also when the user just says "next wave", "run in parallel" or "split across agents".
---

# Parallel work through the queue (default for all parallel work)

You are the **orchestrator**: you plan the tracks, start the agents, review, merge, run the gates and report. The
agents only do their own track. The binding protocol for tracks is `docs/queue/mission-template.md` (copied into the
project by the installer). Project settings (base branch, gates, optional migration flow, modules) are in
`queue.config.json` in the project root.

## Fixed rules

- **Agent model:** `subagent_type: track` (class K and U, `effort: medium`) or `track-d` (class D and D+,
  `effort: high`), both `isolation: worktree`, `run_in_background: true`. The worktree starts from the orchestrator's
  HEAD (`worktree.baseRef: head` in `.claude/settings.json`, which `/cq:setup` offers to add), so stand on the base
  branch when you start tracks. `cq fill`/`start` print the exact `subagent_type` a task needs: installed as a plugin
  the agents are `cq:track`, `cq:track-d`, `cq:reviewer` and `cq:reviewer-security`; in a vendored install the bare names.
- **The orchestrator itself runs at medium effort.** `queue-takeover.mjs` shows the level (written by `hook-effort.mjs`).
  If it is not medium, ask the owner before the loop starts.
- **Push in batches only:** commit locally for every step; `git push` happens only when the owner says "push", and
  always after `cq push-check`. Never push per commit (every push triggers CI and costs).
- **Shared working tree:** always commit with `git commit -- <files>` (pathspec), never `git add -A`. Never touch files
  another session has uncommitted. The orchestrator's own commits on the base branch (not the merges) get the trailer
  `--trailer "Queue: orchestrator"` so `push-check` can tell them from other sessions' commits.
- **No dev servers or previews from tracks.** Visual QA is the owner's; deliver a QA list.
- **Owner questions** are collected and presented with context, pros and cons, and a clear recommendation.

## The queue

Tool: `cq …` (pure logic in `scripts/orchestrator/lib/`). The queue lives in
`scripts/.queue/queue.json` in the MAIN tree (gitignored) and survives compaction and new sessions. Read it with
`cq show` (short by default). Main commands: `init`, `add --file|--json`, `show`, `next`, `start <id>`,
`set <id> <status>`, `edit <id>`, `resolve <question> [--answer "…"]`, `resolutions`, `question`, `state`
(exit 3 = empty), `fill`, `receive`, `merge`, `cost`, `batch`, `projects`, `pick`, `deliver`, `release`, `qa`, `external`,
`orchestrator`, `plan …`. Full reference: `docs/queue/queue.md`.

**A task** has id, title, domain, class (K 1.0, D 1.3, D+ 1.8, U 0.6), `mission` (path to a self-contained track
description or the text itself), `value` 1-10, `content_min`, `depends_on` (other tasks), `waiting_on` (registered
owner questions), `owned_files` (paths, or folders ending in "/"), `owner_db`, `project`, `feature`, `labels`,
`plan` (plan entry). Priority = value per estimated minute, with a bonus for tasks that unlock others and a small age
bonus; `priority_bonus` overrides.

**Classes and sizes:** K (client/UI/ordinary code) 90-120 min of content; D (database/RPC/contract changes) about 40;
D+ (new tables, retention, unauthenticated endpoints, shared-function patches) 25-30, never merged with other work;
U (investigation) about 60. Fixed overhead per track is large (see `docs/queue/orchestration.md`), so small tasks go in
the batch queue (`"batched": true`) and are packed into right-sized tracks with `cq batch pack`.

**Limits:** `cq limit` shows and sets `maxConcurrent`, `maxDPlus`, `maxPerDomain`, `dailyBudget`,
`nightRun`, `nightWindow`, `parallelThreshold`. One owner per file and DB function. Change limits only on the owner's
word.

## The loop (event driven, never polling)

1. **Fill the slots**, ONE call: `cq fill --scratchpad <scratch>` (next → start → track file → shared part →
   mission prompt; exit 4/5/6 = budget/night pause/wind-down). It ends with "Start these in the SAME turn:" and one line per
   agent with `subagent_type` and the finished agent message (also in `<scratch>/queue-fill.json`). Start ALL of them in
   the same turn with exactly that message. At loop start and each round without start/set:
   `cq orchestrator pulse --session "<session>"`. Check `cq batch` when filling: a group marked
   "READY FOR PACKING" is packed with `cq batch pack --auto` (proposal) and `--auto --execute`.
2. **When a track delivers:** `cq receive <id>` BEFORE merging (status review, the review package as plain files in
   `<scratch>/rev-<id>/`, the track's RESULT line from the transcript, one reviewer prompt per reviewer for the
   class, and the merge command). Read the long report only when RESULT says PARTIAL, RED or ownerQuestions>0. Start the
   reviewers `receive` prints (fixed per class plus the helper agents that hit) in the SAME turn. Fix round in a new agent on findings. When review is green:
   **`cq merge <id>`** from Bash with a long timeout (merge with `--wave-base`, optional migration push if
   configured, `gates --quick`, `set <id> done` with cost and findings, `fill`). It stops at the first error with
   the step and an excerpt; full log in `<scratch>/merge-<id>.log`. PARTIAL = continuation in a new agent, not a merge.
3. **New work** from reviewers, planners or tracks goes in with `cq add` (agents' tasks get status `proposed` and
   start only after `cq approve <id…>`). Investigations and ideas that are not concrete tasks become plan entries
   (`cq plan new`, priority `owner`, maturity `idea`).
4. **Answers from the board:** `cq resolutions --unlogged`; log them where the project keeps decisions, then
   `cq resolutions --mark-logged <id…>`.
5. **Low parallelism:** when fewer agents run than `parallelThreshold` of `maxConcurrent`, `fill`/`receive`/`pulse` print a
   short diagnosis. "simple" findings come with a ready command; "complex" ones go to the owner with a recommendation.
6. **Reprioritise** after every 5 finished tasks and when the owner answers: split tasks that are too large, adjust
   value.
7. **Stop** when `cq state` gives exit 3 or the day budget is used: present the owner questions that unlock the
   rest (sorted by how many tasks each unlocks). `cq orchestrator stop` when the loop stops.

## Review

- Fixed reviewers per class: K none, U none, D one, D+ two (`reviewers` in `queue.config.json`, default `reviewer`
  and `reviewer-security`). The class is the floor. Helper agents add to it when they are on and hit (`helpers`;
  `cq helpers` lists them; by default the challenger for U and `bug`, design for `visual`). Start exactly the
  reviewers `receive` prints; the package says why each helper was chosen.
- The review package is made by `cq receive` BEFORE merging (afterwards the diff is empty): `00-package.md`,
  `diff.patch`, `files/` (changed files in full), `trackReply.md`, `trackReport.md`, `handover.md`, `mission.md`.
- Fixed lines: a track's last answer starts with `RESULT status=… branch=… commits=… gates=… ownerQuestions=…`, a reviewer's
  with `FINDINGS H=… M=… L=… deferrable=…`. `receive` and `set done` read them.
- Fix rounds by severity: HIGH always gives a fix round. MEDIUM you fix yourself at merge when small and mechanical,
  otherwise a fix round. LOW never triggers a round alone; "safe to defer" becomes one follow-up task.

## Fix round and continuation (new agent, not SendMessage)

- `SendMessage` only to a track under about 150k context that has been idle under 5 min. Otherwise, and always on
  PARTIAL: a NEW `track` agent with a narrow mission: track block `=====<ID>-r<N>=====` with `BRANCH: queue/<ID>`, the
  findings with file:line, the paths to `report.md`/`handover.md` and the review files.
- The branch must be free (`git worktree list`; `git -C <old worktree> switch --detach`).
- The new agent starts with `cq prepare-track <ID>-r<N> --branch queue/<ID> --continue …`: takes the branch over with
  `git switch`, no reset. Never `prepare-track` without `--continue` for a fix round.
- In the queue, `cq resume <id> --reason fix|context [--findings-file <file>]` writes that mission
  (`prompt-<id>-r<N>.md`, N = the next free round) and prints the agent message. The fix round writes its report.md
  in `<scratch>/<id>-r<N>/`, where `cq deliveries`, the pulse and `cq receive` find it.

## Compact, do not rotate

The orchestrator session is compacted instead of rotated: the token cost is about the same, while rotation costs the
owner work, and running agents belong to the session that started them. At about 300k context `hook-context.mjs`
offers a ready `/compact keep: …` line. Finish the current step first. After compaction `hook-after-compact.mjs`
injects a resume instruction and the queue state; resume without waiting. Keep `scripts/.queue/handover-ongoing.md`
updated after every merge and decision: decisions go to a file at once, that is the quality guard for compaction. At
about 350k the hook sets wind-down (no new starts, exit 6) until the owner compacts.

**Emergency rotation** (the session has hung or is broken) needs no quiet window. The new session adopts the tracks
that run: report.md with the RESULT line on top is the delivery signal, `cq orchestrator pulse` prints
`NEW DELIVERY (report.md)` for it without a `<task-notification>`, and `cq resume` starts fix rounds with a new agent
on the same branch. Stop the old session first, so two orchestrators do not receive and merge the same track.

## Projects, picking and visual QA

- **Projects:** the register `projects` in `queue.json` (`title`, `plan`, `prefixes`, `pause`, `priority_bonus`,
  `area`). A task belongs to its explicit `project`, otherwise to the project with the longest matching id prefix.
  `cq projects` reports per project. Pause and priority only on the owner's word.
- **Picked tasks** (skill `pick`): a person or session does the task. It owns its files, is never started, merged or
  released by the orchestrator, and arrives as `review` after `cq deliver <id>`.
- **Visual QA:** tasks with the label `visual` get `qa_status: waiting` when finished. `cq qa` lists them; only the
  owner decides (`qa ok`, `qa deviation <id> "<text>"`, which creates `<id>-QA<n>`). Each entry carries evidence
  (`EVIDENCE <type>[=<ref>]` in the track's `report.md`, stored by `receive`, or `cq qa evidence <id> <type>[=<ref>]`);
  `cq qa auto --run` closes the entries whose evidence type is automatic (default `test`) when `qa.autoCommand` is
  green.
- **The board:** `cq board` (local, 127.0.0.1, link with a key) shows the queue as
  kanban, statistics, dependencies, plans and "Waiting on you". It writes only through `cq`. See
  `docs/queue/board.md`.

## Work outside the queue and push check

- `cq external` (read only): commits on the base branch that are not queue merges and lack the trailer, branches
  and worktrees outside `queue/*`, uncommitted files in the main tree, and collisions with owned files. Run it when
  reprioritising and before push. A match (an external commit mentions a waiting task) is a proposal:
  `cq external accept <id> <sha>`, never automatic. Register outside work with
  `cq external add --name "<session>" --files <…>`.
- `next`/`start` skip tasks that own an uncommitted file in the main tree.
- **Push check** before every push: `cq push-check`. Exit 0: push (when the owner has said
  "push"). Exit 2: external commits: ask the owner (take everything / push only the queue's part when a safe cut point
  is printed / wait). History is never rewritten.

## Cloud sessions (optional)

Tasks of class K/U without migrations, DB ownership, open dependencies or owner questions can run in a cloud session
(`cq cloud`, `cloud-package`, `cloud start|done|cancel`, `cloud-start.mjs`). The cloud only sees what is pushed, so the
base branch must be pushed first. At most 3 cloud sessions at once.

## Known pitfalls

- `String.replace` with `$'` in the replacement duplicates text; build with `split`/`join`.
- Bash heredocs can halve backslashes, and backticks inside `node -e "..."` run as commands: write scripts with Write.
- Tests and scripts that need a git identity use a temporary repo (`git -C <tmp> …`), never the main repo.
