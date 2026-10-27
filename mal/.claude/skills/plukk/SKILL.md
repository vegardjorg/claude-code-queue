---
name: plukk
description: Pick a task from the work queue (ko.mjs) and do it yourself in this session, following the same protocol as a queue track. Use when the user types "/plukk" (suggestions for what can be picked now) or "/plukk <id>" (take exactly that task), or says "pick a task", "plukk en oppgave", "what can I take myself" or "give me something visual from the queue".
---

# /plukk: do a queue task yourself

Argument: **$ARGUMENTS** (empty = suggestions; an id = pick it; "visuell" = suggestions with visible UI).
The protocol is the same as for queue tracks (`.claude/skills/parallell-bolge/SKILL.md`). The queue lives in the main
tree's `scripts/.ko/ko.json`: touch it only through `ko.mjs`.

## Without id: suggest

1. `node scripts/orkestrator/ko.mjs plukkbare` (add `--etikett visuell`, `--prosjekt <pid>` or `--maks-min N` when the
   owner mentions it). A row marked as uncommitted in the main tree means another session works in one of the files.
2. Present 5 to 8 suggestions: id, project and feature, class, estimate in minutes, and one sentence on what the owner
   gets. Ask which one to pick.

## With id: pick and do the task

0. **Check work outside the queue first:** `ko.mjs ekstern --id <id>`. If a commit outside the queue mentions the id,
   the task may already be done: ask the owner (done → `ko.mjs ekstern godta <id> <sha>`).
1. **Pick:** `ko.mjs plukk <id> --av "<session name>"`. It warns when the owned files changed outside the queue
   (read the diff before building), refuses on open dependencies, owner questions or ownership collisions (`--tving`
   only with the owner's yes), and assigns the branch `ko/<id>`.
2. **Own worktree:** stand on the base branch in the main tree first (the worktree starts from HEAD). Small tasks:
   `EnterWorktree` and do the work in this session. Large tasks (D+, or over about 60 min): start a `spor` agent
   (`isolation: worktree`) with the usual short prompt; this session becomes the orchestrator for that one task.
3. **Prepare:** `node <project root>/scripts/orkestrator/klargjor-spor.mjs <id> --gren ko/<id> --scratchpad
   "<scratchpad root>"` from the worktree. `KLAR …` = go on; `NEKTER …` = stop and tell.
4. **The mission:** `ko.mjs sporfil <id> --ut <dir>/ko-spor.md`, `node scripts/orkestrator/lag-ko-felles.mjs --ut
   <dir>/ko-felles.md` and `node scripts/orkestrator/lag-oppdrag.mjs --felles <dir>/ko-felles.md --spor
   <dir>/ko-spor.md --head <HEAD>`. `prompt-<id>.md` is binding.
5. **The work:** shared protocol (ownership, tests red first), gates by class (`node scripts/orkestrator/gater.mjs
   --rask` for K and U, `--full` for D and D+), review by class (K/U none; D one reviewer; D+ two). Commit only on
   `ko/<id>` with `git commit -- <files>`.
6. **Finish.** `ko.mjs orkestrator` says whether an orchestrator is active.
   - **Orchestrator active:** `ko.mjs lever <id>` (`plukket` → `review`). The orchestrator reviews and merges.
   - **No orchestrator:** do the orchestrator's steps for this one task: from the main tree on the base branch,
     `node scripts/orkestrator/flett-spor.mjs ko/<id> --bolge-base $(git merge-base <base> ko/<id>)`, the optional
     migration push, `gater.mjs --rask`, and `ko.mjs sett <id> ferdig --merknad "picked by <who>"`.
7. **Never `git push`** unless the owner says "push"; then `push-sjekk.mjs` first.

Changed your mind: `ko.mjs slipp <id>` (the branch is kept; it warns if the branch has commits). A picked task is never
released automatically; after 72 h without commits it shows as "stale".

## Visual tasks (label `visuell`)

End with a short list for the owner of what to look at: screen and how to get there, what changed, what to check
(light and dark mode, phone and desktop). `sett <id> ferdig` gives `qa_status: venter`; only the owner runs
`qa ok <id>` / `qa avvik <id> "<text>"`.
