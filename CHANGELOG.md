# Changelog

All notable changes to claude-code-queue (the `cq` plugin). The version is in `plugin/.claude-plugin/plugin.json`
and `package.json`.

## 0.3.0 (2026-10-30)

Fixes and features ported back from the queue in the project cq was split out of.

### Added
- **Status line** (`statusline.mjs`): context size, session cost, the 5-hour and 7-day quota and running tracks.
  A plugin cannot set a status line itself, so `cq setup --settings` writes it with an absolute path. Run it again
  after each plugin update.
- **Handover note in two parts** (`cq handover archive|now`): after compaction the orchestrator reads only the "Now"
  part; dated log entries older than 24 hours move to `handover-archive/<year-month>.md`.
- **Quota calibration from the status line**: `cq capacity --calibrate auto` uses the 7-day percentage the status
  line saw last.
- **Adopting running tracks**: a track's `report.md` carries the RESULT signal, so a new orchestrator chat can take
  over tracks that are still running. New commands `cq deliveries` and `cq resume <id> --reason fix|context`; the
  pulse prints NEW DELIVERY, and `cq receive` finds fix-round reports.
- **Migration blocks**: start, fill and pick skip blocks that are already taken; `cq migr move <id> <block>` moves a
  task to another block.
- **Load guard**: no new starts (exit 7) while free memory is below `loadGuard.minFreeMemoryPct` or
  `cq limit minFreeMemoryPct`. Off by default.
- **Focus clean-up**: `cq focus evaluate` and `cq focus clean` take done focus stages out (also automatic, and it can
  be undone).
- **Follow-up entries**: `cq follow add|log|show|report|close|extend` for something to watch over a period, with its
  own board page at `/follow`.
- **QA evidence**: tracks write an `EVIDENCE` line in the report; `cq qa evidence <id> <type>` sets it by hand, and
  `cq qa auto --run` closes entries whose automatic evidence is green. The types are in `config().qa`.
- **`plan check`** also shows index drift against the plan register (field `index` in `--json`).

### Security
- **Merge guard**: `merge-track` stops (exit 4) when a branch changes hooks, settings, agents, the orchestrator
  scripts or the queue config without owning them (`protectedPaths` in `queue.config.json`; `--allow-guard`
  overrides).
- **Network guard for tracks**: tracks cannot run `curl`, `wget`, `iwr` or a pipe into a shell.
- **Data, not instructions** in every agent file and the mission template, checked by `make-queue-common`.
- **Agent limits**: `maxTurns` 400/600 and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` in `settings.queue.json`.
- **Context guards after compaction**: a track that compacts twice or passes 280k stops as PARTIAL; a SubagentStop
  end gate (`hook-track-end.mjs`) stops a track once if it ends without a commit and without a RESULT line; pause
  advice above 150k.

### Fixed
- The plan room no longer shows a raw "null" text when optional parts are missing.
- The board builds the queue lookups once per board instead of once per card: with 3,000 tasks it went from about
  59 s to about 0.15 s.
- The fallback migration pattern in `queue.mjs` had lost its backslashes (the same bug as in `setup.mjs` in 0.2.1).

### Upgrading
Update the plugin, then run `cq setup --settings` once to get the new hooks and the status line.

## 0.2.1 (2026-10-29)
- Fixed the broken hook-path regex in `setup.mjs`, and every shipped script is syntax-checked in the tests.
