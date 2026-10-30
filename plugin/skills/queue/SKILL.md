---
name: queue
description: Take over the work queue (`cq`) as a new orchestrator session. Reads the status (queue, branches, git, delivered tracks), gives the owner a short report and asks before starting the loop. Use when the user types "/queue", "take over the queue", "start the queue", or when the previous orchestrator has hung (emergency rotation). A long orchestrator session is compacted, not rotated.
---

# /queue: take over the work queue

You are a NEW orchestrator session for the continuous queue. The normal path for a long orchestrator session is
compaction (see "Compaction" below). A new session is the fallback when the previous orchestrator has hung or is
broken, or when the queue is started for the first time. The queue state lives in `<dataFolder>/queue.json` (default
`scripts/.queue/queue.json`) in the main tree and survives session changes.

**Phase 1 (this skill) is READ-ONLY.** Do not run `cq start`/`set`, do not merge, do not start agents and do not
touch files before the owner has answered in phase 3.

Extra instructions from the owner: **$ARGUMENTS** (empty = none).

## Phase 1: Get the picture

Run these in parallel where possible:

1. `cq takeover`: one status picture with
   - at the TOP: the wind-down flag (the previous orchestrator passed about 350k context) and the newest handover note
     `scripts/.queue/handover-*.md` (normally the running `handover-ongoing.md`). If a note is newer than the last
     pulse of the previous session, run `cq handover archive` and then `cq handover now` before the report: the
     "Now" part has active tasks, review packages, open owner questions and the next command. Never read the whole note
     or `handover-archive/`; grep them only when you need an old detail.
   - when the queue was last changed, and a warning if another orchestrator may still be alive
   - branch, HEAD, commits ahead of the remote, and any leftover `index.lock`
   - every active task with commits on `queue/<id>` and an assessment: DELIVERED, EMPTY or UNCERTAIN
   - what can start now, and which owner questions unlock the most tasks
   - the orchestrator marker (`scripts/.queue/orchestrator.json`): who was orchestrator last, ACTIVE or expired (2 h)
2. `cq show` (SHORT: active, startable now, counts, about 1-3k characters). The full table
   (`show --full`) only when you need the blockers per waiting task. Also `cq projects`, `cq qa` and
   `cq external` (commits on the base branch from other sessions that are not pushed, branches outside `queue/*`,
   uncommitted files in the main tree, and collisions with owned files).
3. Read the section "Continuous queue" in `${CLAUDE_PLUGIN_ROOT}/skills/parallel-wave/SKILL.md`. It is the protocol you follow.
4. **Is the previous orchestrator alive?** ACTIVE marker and queue changed less than 15 min ago: probably alive.
   ACTIVE but no change for a long time: it may have hung. Two orchestrators at the same time give double starts and
   double merges. If unclear, say so and recommend that the owner stops the old one first.
5. **Tracks that run or have delivered to another session (adoption):** tracks live on when the session changes; only
   the `<task-notification>` goes to the session that started them. The new session adopts them like this:
   - `queue-takeover.mjs` classifies DELIVERED safely when `<scratchpad>/<id>/report.md` (or `<id>-r<N>/`) has the
     RESULT line on top; the heuristic (commits, clean worktree, 20 min) is only the fallback.
   - `cq orchestrator pulse` (every loop round) prints `NEW DELIVERY (report.md): <id> …` for reports that came since
     the last pulse, also without a notification; `cq deliveries` shows all that are not received. The next step is
     `cq receive <id>` as usual (it finds the report in the task's saved scratchpad).
   - Fix round or continuation (PARTIAL, context guard) for an adopted track: `cq resume <id> --reason fix|context
     [--findings-file <file>]` writes `prompt-<id>-r<N>.md` (prepare-track `--continue`, the paths to the report,
     handover, review package and findings); start a new track agent with the message it prints. SendMessage to the
     old agent does not work from a new session.
   - No report.md (the track died before it wrote one): `cq receive <id> --scratchpad <scratch>` fetches the track's
     last answer from the agent transcript; otherwise rebuild the picture from `git log <baseBranch>..queue/<id>`.

## Phase 2: Short report to the owner (at most about 20 lines)

Plain text for a non-technical reader. **Never just codes:** every owner question and proposal gets context in plain
language (what it is, why it came up, what yes and no mean) and a recommendation. Include:

- **State:** idle since X, or another orchestrator is active; HEAD and commits ahead of the remote. Only what is unusual.
- **Ready to receive:** which tracks delivered (id, class), and the order you want to take them in. D and D+ need review
  before merge.
- **Needs a decision:** EMPTY tracks (agent died, nothing done: propose `set <id> waiting` and a restart), UNCERTAIN
  tracks (work on another branch, or uncommitted in a worktree).
- **Capacity:** how many slots can be filled after receiving, and the three biggest owner questions blocking the queue.
- **Unlogged answers:** answers from the board not yet in the decision log (`cq resolutions --unlogged`).
- **Picked tasks:** who picked what and how long ago ("stale" after 72 h without commits; released only on the owner's
  word). Paused projects in one line.
- **QA list:** visual tasks waiting for the owner's QA.
- **Work outside the queue** (from `cq external`): unpushed external commits, other branches, collisions. Matches are
  proposals (`external accept <id> <sha>`), never something you do yourself.
- **Risk:** leftover `index.lock`, wrong environment linked, large gaps.

## Phase 3: Ask before starting

If `queue-takeover` shows that the effort level is not medium, ask first whether to continue at that level (recommend
medium). Tracks of class D/D+ run on `track-d` (high) regardless.

Use `AskUserQuestion` with one question and these options:
1. **Start the queue (recommended):** receive the delivered tracks in the proposed order, then fill free slots.
2. **Only receive what is delivered:** review and merge, but start no new tracks.
3. **Do not start:** report only.

EMPTY/UNCERTAIN tracks and owner-only questions go into the same call as extra questions (at most 4), recommendation
first.

## Phase 4: When the owner has said yes

Follow `parallel-wave` ("Continuous queue") unchanged. Specific to taking over:

- **Receive first:** `cq receive <id> --scratchpad <scratch>` for DELIVERED tracks (sets review, builds the review
  package and reviewer prompts, prints the merge command). Start the reviewers `receive` prints (fixed for D and D+, plus the helper agents that hit) in the SAME turn.
  Then `cq merge <id>` from Bash with a long timeout: merge with the right `--wave-base`, optional migration push,
  `gates --quick`, `set <id> done` and `fill`.
- **Fill slots:** `cq fill --scratchpad <scratch>` (one call; start all agents in the SAME turn with the messages
  under "Start these in the SAME turn:").
- **EMPTY tracks:** `cq set <id> waiting`; remove the dead worktree and branch only if the branch has 0 commits;
  the loop restarts the task.
- **Picked tasks** (status `picked`) are never EMPTY or UNCERTAIN: a person or session owns them. Do not touch them.
  When they arrive as `review` (after `cq deliver`), receive them like a delivered track.
- **Register as orchestrator:** `cq orchestrator pulse --session "<session name>"` with a NEW name (date and time). That
  resets the previous session's wind-down; otherwise `fill`/`start` refuse with exit 6.
- **Push:** never `git push` before the owner says "push", and always `cq push-check` right
  before. Exit 2 (external commits) = ask the owner first. Your own commits on the base branch get
  `--trailer "Queue: orchestrator"`.
- **Shared working tree:** always commit with `git commit -- <files>`, and never touch files another session has
  uncommitted.
- **Running handover note:** keep `scripts/.queue/handover-ongoing.md` up to date after every merge and every owner
  decision (active tasks with branch, worktree and prompt; review packages; open owner questions in plain language;
  decisions; scratchpad path; next command). Then both compaction and an emergency rotation are cheap. The note has
  two parts: a `## Now` section at the top (the current state, at most 40 lines, rewritten in place) and a dated log
  below it. `cq handover archive` moves log entries older than 24 h to `handover-archive/<year-month>.md`; run it
  at every compaction. After compaction only the "Now" part is injected.
- **Compaction is the default:** at about 300k context `hook-context.mjs` gives the owner a ready `/compact keep: …`
  line to paste (you cannot run `/compact` yourself). Update the note, finish the step you are in, and do not start
  long new operations in the middle. After compaction `hook-after-compact.mjs` injects a resume instruction and the
  queue state; trust it over the summary and resume without waiting for the owner. Mode: `cq compact auto|manual`
  (auto = Claude Code compacts itself at 300k: `autoCompactEnabled` on, the default, and `autoCompactWindow` 300000;
  manual also needs `autoCompactEnabled: false`, or Claude Code still compacts at 300k on its own).
- **Wind-down (about 350k, emergency brake):** when the hook says WIND_DOWN, start nothing new (`next`/`start`/`fill`
  give exit 6). Finish what is started (receive, review, fix rounds, merge, `set … done`), update the note and ask
  the owner to compact now. Delivered tracks always get through.
- **Emergency rotation:** only when the session has hung or is broken: ask the owner for a new `/cq:queue` in a new
  window. The rotation no longer needs a quiet window: the new session adopts the running tracks (step 5 of the
  takeover: pulse reports the deliveries, `cq resume` makes the fix rounds). Stop the old session first, so two
  orchestrators do not receive and merge the same track. The usual path for a long session is still compaction.

## Follow-up entries

What we follow over time lives in the queue with a start, an end and a fixed report template, not only in the
memory or the handover note (`scripts/.queue/follow.json`, the same lock as the queue; the rules in
`lib/queueFollow.js`).
- **Add an entry** (`cq follow add --file <json>`, id `F-…`) for internal tests, variables to watch over time and
  trial periods after an owner decision (for example automatic compaction). The entry has `why`, `start` and `end`,
  `owner`, `goals` (name, how it is measured, expected value), and optional `related` and `close_action`.
- **Along the way:** `cq follow log <id> --text "…" [--value name=x]` when something happens or is measured;
  `cq follow show <id>` and `cq follow` (the list). Need more time: `cq follow extend <id> --to <date>`.
- **When the end date is reached** (the local calendar day), `cq show` and `cq orchestrator pulse` print "TO REPORT",
  and the pulse repeats it every round until the report is written. **Never ignore that notice:** run
  `cq follow report <id>` (writes `scripts/.queue/follow/<id>-report.md` from the template: Question, Setup,
  Measurements, Findings, Deviations and losses, Recommendation, Owner decision), fill in the assessment, and present
  it to the owner at the end of the round with a recommendation.
- **The owner decision:** `cq follow close <id> --decision "…"` (or `--cancelled`). The command prints the close
  action but never does it; do it only when the decision calls for it.
- The board has the read view at `/follow` (the link is printed when `cq board` starts).

## Fewer turns per task

- `fill` and `receive` end with "Start these in the SAME turn:": start ALL listed agents in one turn (parallel Agent calls).
- One call to merge: `cq merge <id>`. If it stops, the step and an excerpt are in the answer and the full log in
  `<scratch>/merge-<id>.log`: read the log, do not rerun the step to look.
- Fixed lookups, never your own scripts: `cq info <id> [--field <name>]`, `cq activeOnes`,
  `cq edit <id> --bonus "<text>"`. No `node -e` against `queue.json`.
- The orchestrator does not build: if something needs more than about 3 calls beyond merging, start a focused agent.
- One line to the owner per routine event (delivered, merged, started). Detailed only for owner questions, push or
  errors.
- Short agent answers: tracks and reviewers answer with at most about 1,500 characters. Read
  `rev-<id>/trackReport.md` only when RESULT says PARTIAL, RED or ownerQuestions>0.
- Measure: `cq cost --since 24h` (cost per task and class).
