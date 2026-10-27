# Work queue and orchestration (claude-cowie-qeue)

Import this file from your project's `CLAUDE.md` with a line `@CLAUDE.ko.md`.

## Queue and plans
- Work that is ready to run lives in the queue: `node scripts/orkestrator/ko.mjs vis` (start of every session).
  Plans, ideas and decisions live in the plan register: `node scripts/orkestrator/ko.mjs plan vis`.
- New plan or investigation document: register it in the plan register in the SAME session (`plan ny` or add it as a
  source with `plan endre`).
- Agents only ADD proposals (`ko.mjs add`); approving, merging and pushing belong to the orchestrator and the owner.
- Docs: `docs/ko/queue.md`, `docs/ko/plan-register.md`, `docs/ko/orchestration.md`, `docs/ko/board.md`,
  `docs/ko/mission-template.md`.

## Skills
- `/ko`: run as orchestrator (fill, receive, review, merge, ask owner questions).
- `/parallell-bolge`: parallel work with track agents in worktrees. ALWAYS use it for parallel agents.
- `/legg-til-ko`: turn a request or plan section into queue tasks.
- `/planer <id|project|module>`: plan work only, never building.
- `/plukk`: take one queue task by hand in this chat.
- `/start`: short session start (queue state, owner questions).

## Git
- Commit locally for every step. **Push only in batches, when the owner says "push".** Run
  `node scripts/orkestrator/push-sjekk.mjs` before pushing.
- Always commit with a pathspec: `git commit -- <files>` (new files: `git add` first). Other chats and tracks may
  have staged files in the same tree.
- Never force push. Never push other branches than the base branch from the orchestrator.

## Worktrees and tracks
- Tracks run in `.claude/worktrees/<name>` on branch `ko/<ID>`, set up by `klargjor-spor.mjs`.
- Never `npm install` inside a worktree (shared folders are links to the main tree). Clean up worktrees only with
  `node scripts/orkestrator/rydd-worktree.mjs`.
- Never kill processes by pattern; stop only the pid you started.
- Context: read excerpts (`grep -n`, then `offset`/`limit`); at about 300k context a track commits, writes
  `overlevering.md` and delivers DELVIS.
