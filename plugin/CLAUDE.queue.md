# Work queue and orchestration (claude-cowie-queue)

Import this file from your project's `CLAUDE.md` with a line `@CLAUDE.queue.md`.

## Queue and plans
- Work that is ready to run lives in the queue: `cq show` (start of every session).
  Plans, ideas and decisions live in the plan register: `cq plan show`.
- New plan or investigation document: register it in the plan register in the SAME session (`plan new` or add it as a
  source with `plan edit`).
- Agents only ADD proposals (`cq add`); approving, merging and pushing belong to the orchestrator and the owner.
- Docs: `docs/queue/queue.md`, `docs/queue/plan-register.md`, `docs/queue/orchestration.md`, `docs/queue/board.md`,
  `docs/queue/mission-template.md`.

## Skills
- `/queue`: run as orchestrator (fill, receive, review, merge, ask owner questions).
- `/parallel-wave`: parallel work with track agents in worktrees. ALWAYS use it for parallel agents.
- `/add-to-queue`: turn a request or plan section into queue tasks.
- `/plans <id|project|module>`: plan work only, never building.
- `/pick`: take one queue task by hand in this chat.
- `/start`: short session start (queue state, owner questions).

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
