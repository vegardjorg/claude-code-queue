---
name: pick
description: Pick a task from the work queue (queue.mjs) and do it yourself in this session, following the same protocol as a queue track. Use when the user types "/pick" (suggestions for what can be picked now) or "/pick <id>" (take exactly that task), or says "pick a task", "pick en task", "what can I take myself" or "give me something visual from the queue".
---

# /pick: do a queue task yourself

Argument: **$ARGUMENTS** (empty = suggestions; an id = pick it; "visual" = suggestions with visible UI).
The protocol is the same as for queue tracks (`.claude/skills/parallel-wave/SKILL.md`). The queue lives in the main
tree's `scripts/.queue/queue.json`: touch it only through `queue.mjs`.

## Without id: suggest

1. `node scripts/orchestrator/queue.mjs pickable` (add `--label visual`, `--project <pid>` or `--max-min N` when the
   owner mentions it). A row marked as uncommitted in the main tree means another session works in one of the files.
2. Present 5 to 8 suggestions: id, project and feature, class, estimate in minutes, and one sentence on what the owner
   gets. Ask which one to pick.

## With id: pick and do the task

0. **Check work outside the queue first:** `queue.mjs external --id <id>`. If a commit outside the queue mentions the id,
   the task may already be done: ask the owner (done → `queue.mjs external accept <id> <sha>`).
1. **Pick:** `queue.mjs pick <id> --by "<session name>"`. It warns when the owned files changed outside the queue
   (read the diff before building), refuses on open dependencies, owner questions or ownership collisions (`--force`
   only with the owner's yes), and assigns the branch `queue/<id>`.
2. **Own worktree:** stand on the base branch in the main tree first (the worktree starts from HEAD). Small tasks:
   `EnterWorktree` and do the work in this session. Large tasks (D+, or over about 60 min): start a `track` agent
   (`isolation: worktree`) with the usual short prompt; this session becomes the orchestrator for that one task.
3. **Prepare:** `node <project root>/scripts/orchestrator/prepare-track.mjs <id> --branch queue/<id> --scratchpad
   "<scratchpad root>"` from the worktree. `READY …` = go on; `DENIES …` = stop and tell.
4. **The mission:** `queue.mjs trackFile <id> --out <dir>/queue-track.md`, `node scripts/orchestrator/make-queue-common.mjs --out
   <dir>/queue-common.md` and `node scripts/orchestrator/make-mission.mjs --common <dir>/queue-common.md --track
   <dir>/queue-track.md --head <HEAD>`. `prompt-<id>.md` is binding.
5. **The work:** shared protocol (ownership, tests red first), gates by class (`node scripts/orchestrator/gates.mjs
   --quick` for K and U, `--full` for D and D+), review by class (K/U none; D one reviewer; D+ two). Commit only on
   `queue/<id>` with `git commit -- <files>`.
6. **Finish.** `queue.mjs orchestrator` says whether an orchestrator is active.
   - **Orchestrator active:** `queue.mjs deliver <id>` (`picked` → `review`). The orchestrator reviews and merges.
   - **No orchestrator:** do the orchestrator's steps for this one task: from the main tree on the base branch,
     `node scripts/orchestrator/merge-track.mjs queue/<id> --wave-base $(git merge-base <base> queue/<id>)`, the optional
     migration push, `gates.mjs --quick`, and `queue.mjs set <id> done --remark "picked by <who>"`.
7. **Never `git push`** unless the owner says "push"; then `push-check.mjs` first.

Changed your mind: `queue.mjs release <id>` (the branch is kept; it warns if the branch has commits). A picked task is never
released automatically; after 72 h without commits it shows as "stale".

## Visual tasks (label `visual`)

End with a short list for the owner of what to look at: screen and how to get there, what changed, what to check
(light and dark mode, phone and desktop). `set <id> done` gives `qa_status: waiting`; only the owner runs
`qa ok <id>` / `qa deviation <id> "<text>"`.
