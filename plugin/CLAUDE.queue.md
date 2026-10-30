# Work queue and orchestration (claude-code-queue)

Import this file from your project's `CLAUDE.md` with a line `@CLAUDE.queue.md`.

## Queue and plans
- Work that is ready to run lives in the queue: `cq show` (start of every session).
  Plans, ideas and decisions live in the plan register: `cq plan show`.
- New plan or investigation document: register it in the plan register in the SAME session (`plan new` or add it as a
  source with `plan edit`).
- Agents only ADD proposals (`cq add`); approving, merging and pushing belong to the orchestrator and the owner.
- Docs: `docs/queue/queue.md`, `docs/queue/plan-register.md`, `docs/queue/orchestration.md`, `docs/queue/board.md`,
  `docs/queue/mission-template.md`.

## Plain language first
The owner does not need to type commands. Read ordinary requests, in any language, as queue actions and use the
matching skill:
- "add it to the queue", "put this on the queue", "queue it" → `add-to-queue`.
- "what's in the queue", "what is next" → `cq show`; "start the queue", "take over" → `queue`.
- "I'll do one myself", "give me something from the queue" → `pick`; "show the board" → `board`.
- "what about plan X", "update the plan" → `plans`.
- "add this as a helper agent", "legg til denne som hjelpeagent", "review the helper agent X" → `add-helper`.
- When a task has been planned and agreed in this chat, offer to add it to the queue in the same turn (one short
  question), and add it on yes. If the owner has said to always queue planned work, add it without asking and say so.
Run the `cq` commands yourself; show the owner the result, not the command.

## Skills
In a plugin install the skills are named `/cq:<name>` (for example `/cq:add-to-queue`); in a vendored install they
are `/<name>`.
- `/queue`: run as orchestrator (fill, receive, review, merge, ask owner questions).
- `/parallel-wave`: parallel work with track agents in worktrees. ALWAYS use it for parallel agents.
- `/add-to-queue`: turn a request or plan section into queue tasks.
- `/add-helper`: add an agent file as a custom helper agent: scan, read in full, report, approve on yes.
- `/plans <id|project|module>`: plan work only, never building.
- `/pick`: take one queue task by hand in this chat.
- `/board`: start the local board in the background and give the link.
- `/start`: answers only "ready" (a cheap way to open a session before you paste a task). For the queue state,
  run `cq show`.

## Custom helper agents
- When `cq helpers`, `cq receive` or the board shows a custom helper as "Needs review" or "Changed since approval",
  review it with `add-helper` (scan, read the whole file, short report with a recommendation) BEFORE it is switched
  on. Never run `cq helpers approve` or `cq helpers on` for a custom helper without the owner's yes in this chat.

## Git
- Commit locally for every step. **Push only in batches, when the owner says "push".** Run
  `cq push-check` before pushing.
- Always commit with a pathspec: `git commit -- <files>` (new files: `git add` first). Other chats and tracks may
  have staged files in the same tree.
- Never force push. Never push other branches than the base branch from the orchestrator.

## Worktrees and tracks
- Tracks run in `.claude/worktrees/<name>` on branch `queue/<ID>`, set up by `prepare-track.mjs`.
- Never `npm install` inside a worktree (shared folders are links to the main tree). Clean up worktrees only with
  `cq cleanup-worktree`.
- Never kill processes by pattern; stop only the pid you started.
- Context: read excerpts (`grep -n`, then `offset`/`limit`); at about 300k context a track commits, writes
  `handover.md` and delivers PARTIAL.
