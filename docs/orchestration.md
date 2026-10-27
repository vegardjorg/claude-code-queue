# Orchestration: how the pieces work together

One Claude Code chat is the **orchestrator**. It does not write product code. It fills the queue, starts track
agents, receives their results, sends them to review, merges, and asks the owner the questions only the owner can
answer. Each **track** is a subagent (`spor` for K and U, `spor-d` for D and D+) in its own git worktree, on its own
branch (`ko/<ID>`), with a self-contained mission file.

## The loop

1. `ko.mjs orkestrator puls`: mark the orchestrator as alive.
2. `ko.mjs fyll --scratchpad <dir>`: start what the limits allow. For each task it writes `prompt-<ID>.md` (shared
   protocol from `docs/ko/mission-template.md`, filtered for the task's class, plus the task block). The orchestrator
   launches one agent per prompt in the background, with worktree isolation.
3. A track finishes and answers with one `RESULTAT …` line plus at most a few lines; the long report is in
   `rapport.md` in its scratch folder.
4. `ko.mjs motta <ID>`: reads the result line and builds a review package (diff, changed files in full, the track's
   report). The orchestrator starts the reviewer agents configured for the class (`reviewere` in `ko.config.json`;
   by default none for K and U, `reviewer` for D, `reviewer` and `reviewer-sikkerhet` for D+).
5. Findings: HIGH and non-mechanical MEDIUM give a fix round with a NEW track agent on the same branch
   (`klargjor-spor --fortsett`). LOW findings become follow-up proposals.
6. `ko.mjs flett <ID>`: merge into the base branch with `flett-spor.mjs`, run the quick gates, start the next tasks.
7. Repeat until `ko.mjs tilstand` exits 3 (nothing to do). Owner questions are collected and asked at the end of a
   round, in plain language with a recommendation.

Push happens in **batches**, only when the owner says so: `node scripts/orkestrator/push-sjekk.mjs` first, then
`git push`. Every push can trigger CI in your own setup, so many small pushes cost money quietly.

## Why it is cheap (context discipline)

Every turn re-reads the whole conversation, mostly from the prompt cache. Cost therefore grows with turns times
context size. The system keeps both small:

- **Small, self-contained missions.** A track starts with only its mission and reads excerpts (`grep -n`, then
  `offset`/`limit`), never whole files twice.
- **Context cap.** A track that reaches about 300k context commits, writes `overlevering.md` (handover) and delivers
  DELVIS; a new agent continues. The hook `hook-spor-kontekst.mjs` enforces this on tool calls.
- **Orchestrator compaction.** `hook-kontekst.mjs` warns, then winds down, then stops the orchestrator chat as it
  grows; `/compact` with a focus is the normal path, and `hook-etter-kompakt.mjs` re-injects the queue state after
  compaction, so the summary does not have to carry it. `autoCompactWindow` is set to 300000.
- **Cache-friendly waiting.** No sleep or poll loops. Subagent prompt cache TTL is set to 1 hour
  (`subagentPromptCacheTtl`), so a reviewer started a while later still hits the cache.
- **Reading guard.** `hook-lesevakt.mjs` stops tracks and reviewers from re-reading files that are already loaded
  automatically, or reading huge files in full.
- **Push guard.** `hook-push-vakt.mjs` asks before force pushes, pushes of other branches than the base, and
  migration pushes to environments not listed as allowed.
- **Time and cost log.** `hook-tid.mjs` logs subagent start and stop; `ko.mjs kost` turns the measured sessions into
  per-class statistics, so estimates get better over time.

## Track classes and effort

| Class | Agent | Effort | Typical size |
|---|---|---|---|
| K (code) | `spor` | medium | 90 to 120 min |
| U (investigation) | `spor` | medium | about 60 min |
| D (database) | `spor-d` | high | about 40 min |
| D+ (high-risk DB or security) | `spor-d` | high | 25 to 30 min, at most 3 migrations |

## Rules that matter

- Tracks commit only on their own branch, with `git commit -- <files>` (pathspec), and never push or merge.
- Tracks never kill processes by pattern; other tracks run the same scripts.
- Ownership is exclusive while a task runs. Hotspot files (navigation, central registries) are changed by the
  orchestrator while merging, from the wiring specification in the track report.
- New work discovered by a track becomes a proposal (`ko.mjs add`), never scope creep.
- The worktree rule: never `npm install` inside a worktree (shared folders are links to the main tree), and clean up
  worktrees only with `rydd-worktree.mjs`.
