#!/usr/bin/env node
// =============================================================
// queue.mjs: work queue for continuous parallel work with Claude Code agents.
//
// The queue lives in <dataFolder>/queue.json (default scripts/.queue/, gitignored), so it survives the orchestrator's conversation
// being compacted or restarted. Anyone with Bash (orchestrator, planners, reviewers, tracks) can add
// work. Writes happen under a file lock (mkdir is atomic) and via a temporary file + rename, so two concurrent writers
// do not corrupt the file. The logic (what can start, priority, limits) is in lib/queueLogic.js; the project's settings
// (baseBranch, branchPrefix, gates, migrations, architecture rules) live in queue.config.json (lib/queueConfig.js).
// The queue and the commands are described in docs/queue.md, the orchestrator loop in docs/orchestration.md, the tracks' protocol in
// docs/mission-template.md and the plan register in docs/plan-register.md.
//
// "Base branch" below is config().baseBranch (the integration branch everything is merged into), and the queue branches are named
// <branchPrefix><id> (default queue/<id>).
//
// Basics:
//   node scripts/orchestrator/queue.mjs init [--next-migr <n>] [--max-concurrent 5] [--max-dplus 2] [--max-per-domain 7]
//        (creates the data folder and an empty queue with defaultLimits and the example project "example"; never touches an
//         existing queue. --next-migr only when the migration flow is enabled)
//   node scripts/orchestrator/queue.mjs add --file task.json        (one object, a list, or { "tasks": [...],
//                                                                  "question": { "<id>": { type, text, ... } } })
//   node scripts/orchestrator/queue.mjs add --json '{"id":"A-1",...}' [--approved]
//        Status: "proposed" when added_by is an agent (a track/task id, reviewer or investigation agent), otherwise
//        "waiting". --approved (only orchestrator/the owner, e.g. a serious finding from review) gives waiting.
//   node scripts/orchestrator/queue.mjs approve <id> [...]           (proposed -> waiting)
//   node scripts/orchestrator/queue.mjs show                           (short: active ones, startable now and counts)
//   node scripts/orchestrator/queue.mjs show --full [--all]           (table: status, class, estimate, priority, blocker;
//                                                                  the proposals separately at the bottom; --all/--grouped/
//                                                                  --project also give the full one)
//   node scripts/orchestrator/queue.mjs next                         (what can start now, without changing anything; exit 4 when
//                                                                  the daily budget is used up, exit 5 during the night pause,
//                                                                  exit 7 when the machine is full)
//   node scripts/orchestrator/queue.mjs start <id> [--agent <name>] [--force]   (marks running, assigns branch and, if any,
//                                                                  migration block; --force = the owner wants it first,
//                                                                  also overrides the daily budget, the night pause and
//                                                                  the load guard)
//   node scripts/orchestrator/queue.mjs set <id> <proposed|waiting|running|review|done|cancelled> [--remark "..."]
//   node scripts/orchestrator/queue.mjs edit <id> --json '{"value":8,"priority_bonus":50}' [--by "..."] [--answer-json]
//        (logged in the changelog, so `undo` rolls it back; --answer-json: the answer as JSON with the changelog no.)
//   node scripts/orchestrator/queue.mjs cancel <id> [--remark "..."] [--by "..."] [--expect-changed <iso>] [--json]
//        (a waiting (also on hold or batched) or proposed task -> cancelled, the same result as set <id> cancelled
//         --remark, but logged in the changelog so `undo` puts it back. Declining a proposal is cancel with the
//         remark "declined: <reason>". Running, picked and review tasks are refused: use set <id> cancelled.)
//   node scripts/orchestrator/queue.mjs state                      (exit 3 when the queue is empty of work, also when
//                                                                  the daily budget or the night pause stops new tasks;
//                                                                  the field stop says which)
//   node scripts/orchestrator/queue.mjs trackFile <id> [...] --out <file> (track blocks in make-mission.mjs format; running or picked)
//
// Owner questions:
//   node scripts/orchestrator/queue.mjs resolve <question> [...] [--answer "..."] [--by "..."]   (the owner's answer has come: with
//                                                                  a timestamp in `resolutions`, the answer optional; with
//                                                                  --answer every task waiting on the question gets
//                                                                  the addition "OWNER_ANSWER <id> (<date>): <answer>" in
//                                                                  the mission, once)
//   `waiting_on` takes ONLY registered question ids (letters, digits, ".", "_", "-", at most 40 chars, no
//   whitespace) with text and type in `question`. add and edit REJECT (all or nothing) a new id that is not
//   registered, unless the add file registers it in { tasks, question }; free text is stopped. edit-many and the board
//   cannot edit waiting_on. fill, show and state (the field resolveWaits) report loose waits: free text,
//   unregistered, or an answered question that still blocks.
//   node scripts/orchestrator/queue.mjs resolutions [--unlogged]       (the answers with time; --unlogged: not yet entered in
//                                                                  the decision log)
//   node scripts/orchestrator/queue.mjs resolutions --mark-logged <question> [...]   (the orchestrator has entered them)
//   node scripts/orchestrator/queue.mjs question                      (the owner questions: text, type, open or resolved)
//   node scripts/orchestrator/queue.mjs question <id> --text "..." [--type question|condition|lawyer|owner-task]
//        [--recommendation "..."] [--source "..."]                          (sets one; fields not given are kept)
//   node scripts/orchestrator/queue.mjs question --file <json>         ({ "<id>": { type, text, recommendation?, source? } };
//                                                                  all or nothing)
//
// Limits, capacity and guards:
//   node scripts/orchestrator/queue.mjs limit [<name> <val>]       (show or set limits: maxConcurrent, maxDPlus,
//                                                                  maxPerDomain, maxDb (integer >= 0; maxDPlus at most
//                                                                  maxConcurrent), dailyBudget <usd|off>,
//                                                                  nightRun <on|off>, nightWindow <HH-HH>,
//                                                                  autocompact <on|off>, parallelThreshold <0-1>)
//   node scripts/orchestrator/queue.mjs compact [auto|manual]        (show or set the compaction mode for
//                                                                  the orchestrator session, limits.autocompact; prints which
//                                                                  /autocompact line the owner pastes in)
//   node scripts/orchestrator/queue.mjs capacity [--json]            (weeklyQuota: used since the last reset in
//                                                                  USD equivalent and tokens, estimated %, pace per day,
//                                                                  when the quota runs out, and how many concurrent tracks
//                                                                  last until the next reset; reset day,
//                                                                  clockTime and planName live in config().capacity)
//   node scripts/orchestrator/queue.mjs capacity --calibrate <percent> [--time <ISO>]   (the percentage Claude shows now, or
//                                                                  at --time: corrects the constant usd_per_100 in queue.json)
//   node scripts/orchestrator/queue.mjs capacity --mode notice|cap|off   (fill: only a notice (default), a cap on new tracks
//                                                                  that is overridden with fill --over-quota, or off)
//   node scripts/orchestrator/queue.mjs capacity --set <usd_per_100>   (set the constant directly)
//   node scripts/orchestrator/queue.mjs capacity --calibrate auto   (the 7-day percentage the status line saw last,
//                                                                  <dataFolder>/rate-limits.json; refused when it is
//                                                                  older than 1 h or from another quota week)
//   node scripts/orchestrator/queue.mjs capacity --cloud-credit <left_usd> [--total <usd>] [--expires <ISO>]
//                                                                  (a separate pot for cloud sessions, set by hand)
//
// Low parallelism (the logic is in lib/queueDiagnose.js): when the queue runs on fewer agents than limits.parallelThreshold (default
// 0.7) of maxConcurrent, `fill` (after the lines about what is started; the newly started count), `receive` and
// `orchestrator pulse` print a short paragraph "LOW PARALLELISM: ...", and `state` has the field `parallel`. Above the threshold
// nothing is printed. The finding types: depends-on-cancelled, depends-on-unknown, dragged-with-paused, lose-waiting,
// waiting-on-resolved (cleanup, only in diagnose) and bottleneck. The diagnosis never fixes anything itself; each finding is "simple"
// (mechanical and unambiguous: a finished command the orchestrator runs) or "complex" (an option with a recommendation to the owner).
//   node scripts/orchestrator/queue.mjs diagnose [--json]             (the whole diagnosis regardless of parallelism; read-only)
//
// The orchestrator's routine as a script and the cost per task (the pure logic is in lib/queueLogic.js):
//   node scripts/orchestrator/queue.mjs fill --scratchpad <folder> [--max N] [--ids <id …>] [--over-quota] [--over-load]
//        (next -> start -> trackFile -> make-queue-common -> make-mission in one call. Writes <folder>/prompt-<id>.md and
//         <folder>/queue-fill.json [{ id, class, subagent_type, prompt, message, branch, migr_block }], and one line +
//         the agent message per track. Saves head_start (HEAD on baseBranch, --wave-base for merge-track) and scratchpad
//         on the task. --ids: only these; one that is already running only gets new prompt files (after an error).
//         QUEUE_SCRATCHPAD can replace --scratchpad. Without --ids, fill prints a quota line when the forecast
//         empties weeklyQuota before the reset; with capacity --mode cap at most that many new ones start, and --over-quota
//         overrides. The load guard (exit 7, the machine is full) stops new starts; --over-load overrides.)
//   node scripts/orchestrator/queue.mjs receive <id> [--scratchpad <folder>] [--result "RESULT …"] [--force]
//        (the track has delivered: status review, and the review package as PLAIN FILES in <folder>/rev-<id>/: 00-package.md
//         (resultLine, changed DB objects if any, diff statistics), diff.patch, files/ (changed files in full version
//         from the branch), trackReply.md (the track's last answer from the transcript), trackReport.md and handover.md (from
//         <folder>/<id>/), mission.md (the prompt file), and reviewer-<type>.md (the short prompt) per reviewer: the fixed
//         ones by class (config().reviewers) and the helper agents that are on and hit (lib/queueHelpers.js).
//         Saves the RESULT line. Does NOT merge; prints the merge command. Adoption: the report is the newest in
//         <folder>/<id>/ or a fix round <folder>/<id>-r<N>/, in the orchestrator's and the task's scratchpad; saves
//         report_received.)
//   node scripts/orchestrator/queue.mjs deliveries [--json]
//        (adoption: active tasks with a report.md that has not been received: first line RESULT status=DONE|PARTIAL and
//         newer than the start, the delivery and the last receive. `orchestrator pulse` prints the new ones every round (and
//         remembers them in report_seen), so a new session that has adopted the tracks sees the delivery without
//         <task-notification>.)
//   node scripts/orchestrator/queue.mjs resume <id> [--reason fix|context] [--round N] [--findings-file <file>]
//                                                [--scratchpad <folder>]
//        (adoption: prompt-<id>-r<N>.md for a NEW agent on the same branch, fix round (default) or continuation after the
//         context guard: the same template as fill, with prepare-track --continue, the paths to report.md, handover.md,
//         the review package and the findings, and the original mission. N is the next free round. Not `continue`,
//         which takes tasks off hold.)
//   node scripts/orchestrator/queue.mjs set <id> done [--findings "FINDINGS H=0 M=1 L=3 …"] [--result "…"] [--without-cost]
//        (measures the cost: the agents in the time log that belong to the task (the track label, fix rounds, and reviewers without
//         a label when their mission mentions the id), usage from the transcripts; saves cost {usd, tokens, turns,
//         agents} and findings {H, M, L, deferrable, reports} from the reviewers' FINDINGS lines or --findings (repeatable).
//         If the measurement fails, the task is set done anyway.)
//   node scripts/orchestrator/queue.mjs cost [--since 7d|24h|2026-10-01] [--max 10]   (statistics per class: n, median
//                                                                  and sum USD, findings H/M/L; the last tasks)
//   node scripts/orchestrator/queue.mjs cost measure <id> [...] [--findings "..."]   (measures and saves again, e.g. older finished ones)
//   node scripts/orchestrator/queue.mjs helpers [--json]            (the helper agents: on/off, when they run, and the
//                                                                  measurement: runs, minutes, tokens, USD, share, findings)
//   node scripts/orchestrator/queue.mjs helpers on|off <agent>      (switches a helper in queue.json; wins over
//                                                                  helpers.<agent>.enabled in queue.config.json; a custom
//                                                                  helper only goes on when approved for its file as it is)
//   node scripts/orchestrator/queue.mjs helpers add <file.md> [--name <name>] [--classes K,U] [--labels a,b] [--paths p,q]
//        (a custom helper: copies the file to .claude/agents/<name>.md, registers it in queue.json as source custom with
//         path, sha256 and added_at, scans it, and leaves it OFF until it is reviewed and approved)
//   node scripts/orchestrator/queue.mjs helpers scan <agent> [--json]   (the machine scan, lib/helperScan.js: red/yellow/green)
//   node scripts/orchestrator/queue.mjs helpers approve <agent> [--by "<who>"] [--sha256 <hash>] [--force]
//        (binds the approval to the file's sha256; a red scan needs --force and the owner's explicit yes; --sha256 refuses
//         when the file is not the one that was read)
//   node scripts/orchestrator/queue.mjs helpers when <agent> [--classes ..] [--labels ..] [--paths ..] [--mostly-paths ..]
//        (the conditions of a custom helper; "none" clears a list)
//   node scripts/orchestrator/queue.mjs helpers remove <agent> [--delete-file]   (drops the registration; the copied
//                                                                  file is only deleted with --delete-file)
//   The transcripts: ~/.claude/projects/<repo-slug>/<session>/subagents/agent-<id>.jsonl (QUEUE_TRANSCRIPTS overrides).
//
// Fewer orchestrator turns: `fill` and `receive` end with "Start these in the SAME turn:" and one line per agent
// (subagent_type + message); start them in one turn. `receive` warns when the track's answer exceeds the report cap (about 1,500 chars).
//   node scripts/orchestrator/queue.mjs merge <id> [--without-migr-push] [--without-fill] [--scratchpad <folder>] [--force]
//        [--allow-guard]
//        (after an approved review; run from Bash (merge-track calls sh), with a long timeout: the gates can take minutes. In one
//         call: merge-track.mjs <branch> --wave-base <head_start> -> the migration step (only when config().migrations is
//         enabled and the branch has migration files: the environment guard (environmentFile/allowedEnvironment) and the push guard are asked, then
//         migrations.pushCommand) -> gates.mjs --quick -> set <id> done (cost measurement) -> fill (unless
//         --without-fill). Stops at the first error with the step and an error excerpt; full log in <scratchpad>/merge-<id>.log.
//         Exit 0 ok, 1 stop, 4 the merge guard stopped it before the merge: the branch touches protected paths
//         (config().protectedPaths) the task does not own. Read the diff; then add the path to owned_files/shared_patch,
//         or run again with --allow-guard, which is passed on to merge-track.mjs and logged as "guard-overridden".)
//   node scripts/orchestrator/queue.mjs info <id> [--field <name>] [--json]   (short view; one field raw, also cost.usd)
//   node scripts/orchestrator/queue.mjs edit <id> --bonus "<text>"  (to the mission, in the track block from the next
//                                                                  trackFile/fill, and to the remarks, with a timestamp)
//   node scripts/orchestrator/queue.mjs activeOnes                        (running/picked/review: id, class, branch, migr_block,
//                                                                  head_start, age)
//   node scripts/orchestrator/queue.mjs next-migr [<n>]              (only with the migration flow: show or set; refuses
//                                                                  going backward and down into a used number: the highest
//                                                                  migration file or assigned block, and into a taken block)
//   node scripts/orchestrator/queue.mjs migr move <id> <block> [--scratchpad <folder>] [--force]
//         (only with the migration flow: moves the block (3470 or 3470-3479) in the queue and in the prompt files
//         ("Migration block:" line and mentions); refuses a taken block. start, fill and pick skip taken blocks by
//         themselves: a migration file, the block of a task that is not finished, or one named in an active prompt file.)
//   Test: QUEUE_MERGE_RUNNING=<module> injects the runner into merge (no real merge, push or gates).
//
// Project, feature, picking and visual QA:
//   node scripts/orchestrator/queue.mjs projects                    (per project: done/total, min left, active/picked,
//                                                                  QA, pause, the owner questions that block the most)
//   node scripts/orchestrator/queue.mjs project <pid> [--title ..] [--plan ..] [--prefix A- B- …] [--pause | --continue]
//        [--priority N] [--area <oid|none>] [--file-root <path …>] [--phase plan|none]
//        (creates or changes; --prefix replaces the list. --phase plan = exists in the planning work, no queue tasks
//         yet; removed automatically when add gives the project tasks)
//   node scripts/orchestrator/queue.mjs show [--all] [--project <pid>] [--grouped]   (--grouped: project → feature → tasks)
//   node scripts/orchestrator/queue.mjs pickable [--label visual] [--project <pid>] [--max-min N]
//   node scripts/orchestrator/queue.mjs pick <id> --by "<who>" [--force]   (a person/session does the task: own branch and, if any,
//                                                                  migration block; does not count against maxConcurrent/maxDPlus)
//   node scripts/orchestrator/queue.mjs deliver <id>                    (picked -> review; the orchestrator merges)
//   node scripts/orchestrator/queue.mjs release <id>                    (picked -> waiting; warns when the branch has commits)
//   node scripts/orchestrator/queue.mjs qa                            (QA list: finished with the label visual that are waiting)
//   node scripts/orchestrator/queue.mjs qa ok <id> [...]              (owner only)
//   node scripts/orchestrator/queue.mjs qa deviation <id> "<text>"       (owner only; creates fixTask <id>-QA<n>)
//   node scripts/orchestrator/queue.mjs qa evidence <id> <type>[=<ref>]  (the types are config().qa.evidenceTypes, default
//                                                                  screenshot|test|manual; receive otherwise reads the
//                                                                  EVIDENCE line in report.md)
//   node scripts/orchestrator/queue.mjs qa auto [--run] [<id...>]        (entries with auto evidence, default test: run
//                                                                  config().qa.autoCommand and close the green ones)
//   node scripts/orchestrator/queue.mjs edit-many --file <json> [--dry] [--expect-changed <iso>] [--json] [--by "..."]
//        ([{ id, project?, feature?, labels?, requires?, priority_bonus?, parked?, batched?, plan? }] or
//         { projects: {...}, tasks: [...] }; all or nothing. See bulk edit below.)
// Project for a task: an explicit `project`, otherwise the project with the LONGEST prefix that matches the id (equal
// length: the first in the register), otherwise "without-project". `next`/`start` skip paused projects (start
// --force overrides) and add the project's priority_bonus to the task's priority.
//
// Work outside the queue (the git reading is in lib/queueGit.js, the decisions in lib/queueLogic.js):
//   node scripts/orchestrator/queue.mjs external [--since <24h|3d|2026-09-30|sha>] [--all] [--max N] [--untracked] [--json]
//        (read-only: (a) commits on baseBranch that are not merges of queue branches and lack the trailer
//         "Queue: orchestrator", with files and the task ids they mention; (b) branches/worktrees outside the queue branches with commits
//         that are not in baseBranch; (c) uncommitted changes in the main tree; collisions with the owned files. The default window is what
//         has not been pushed.)
//   node scripts/orchestrator/queue.mjs external --id <id>             (only one task, since it was added)
//   node scripts/orchestrator/queue.mjs external accept <id> <sha>     (a pending task completed outside the queue -> done; never automatic)
//   node scripts/orchestrator/queue.mjs external add --name "<session or person>" --files <path ...> [--db <fn ...>] [--branch <g>]
//        (a row with status external that owns the files like a picked task; the same name again adds files)
//   node scripts/orchestrator/queue.mjs external done "<name>"      (the files are free again)
//   `next` and `start` skip tasks that own an uncommitted file in the main tree (start --force overrides);
//   `start`, `pick` and `trackFile` warn when the owned files have changed outside the queue since the task was added (the track file
//   gets the warning, so the track reads the diff). Push: scripts/orchestrator/push-check.mjs.
// Orchestrator marker (<dataFolder>/orchestrator.json, expires after 2 h without an update):
//   node scripts/orchestrator/queue.mjs orchestrator                    (is an orchestrator active?)
//   node scripts/orchestrator/queue.mjs orchestrator pulse [--session "<name>"]   (orchestrator, every loop round; start and set
//                                                                  do it themselves for the queue's own tasks; a NEW
//                                                                  --session name = new session (emergency rotation), resets
//                                                                  the wind-down; the usual path is compaction; also
//                                                                  prints NEW DELIVERY for report.md files that came since
//                                                                  the last pulse, see `deliveries`)
//   node scripts/orchestrator/queue.mjs orchestrator stop            (the loop is stopped or handed over; also removes
//                                                                  the wind-down flag)
//
// Cloud: K/U tasks without migrations and DB can run in a cloud session on claude.ai (the owner pastes the package from the board, or
// a routine does it). The cloud only sees what is pushed; suitability is decided in queueLogic.cloudSuitable.
//   node scripts/orchestrator/queue.mjs cloud                            (the cloud sessions running, and the pending ones that are suitable)
//   node scripts/orchestrator/queue.mjs cloud-package <id> [<id> ...] [--out <file>] [--force]   (self-contained message; stdout without
//                                                                  --out; refuses with the reasons when a task is not suitable.
//                                                                  More ids = a bundle in one cloud session: at most 4, total estimate
//                                                                  <= 120 min, own branch/commit/push/report line per id)
//   node scripts/orchestrator/queue.mjs cloud-bundles [--max 4] [--max-min 120]   (proposed: cloud-suitable ones grouped by
//                                                                  project/feature, by priority)
//   node scripts/orchestrator/queue.mjs cloud start <id> [<id> ...] [--run <session-id|url>] [--force]   (picked by "cloud";
//                                                                  at most 3 cloud sessions, a bundle counts as one; again with
//                                                                  --run only sets the run)
//   node scripts/orchestrator/queue.mjs cloud done <id> [--branch <branch>] [--sha <sha>]   (git fetch of the branch (default
//                                                                  the queue branch), at least one commit above <remote>/<baseBranch>,
//                                                                  the local queue branch is set to it, then review; the orchestrator
//                                                                  merges)
//   node scripts/orchestrator/queue.mjs cloud cancel <id>                (= release)
//   The time log gets cloud-start, cloud-done and cloud-aborted.
//
// Batch queue: small tasks that do not fit naturally into a track of the right size (K 90-120 min content, D about 40,
// U about 60), and that do not block anything, are added with "batched": true. They are shown, but never started or picked alone
// (not even with --force) and are counted separately in show/state. `add`/`edit` reject batched for D+, for tasks other
// open tasks depend on (depends_on), and for tasks with an open owner question; and a task depending on one in the batch queue.
// `edit <id> --json '{"batched":false}'` takes it out again. The logic: queueLogic.batch*.
// The small-task guard: `add` rejects a task with an explicit content_min below the class's lower target when it is not D+,
// does not block and is not waiting on the owner: <= 10 min must be fixed now or batched (owner option), over 10 min with
// value <= 7 must be batched, and without value the owner is asked. `"own_track": "<reason>"` overrides. The logic:
// queueLogic.smallTaskError.
//   node scripts/orchestrator/queue.mjs batch                          (the groups project -> class, the features in them and
//                                                                  shared files, sum of contentMinutes against the target; "READY
//                                                                  FOR PACKING" from the lower target: K 90, D 30, U 45)
//   node scripts/orchestrator/queue.mjs batch pack <id> <id> ... --id <new-id> [--title "..."] [--expect-changed <iso>]
//        (one new track: same class, never D+, same open owner question; content_min summed, value/migr_tens max,
//         depends_on union minus the parts, ownership/requires/labels union, project/feature shared or the first,
//         merged_from; mission file <dataFolder>/mission/<new-id>.md with the parts' missions in full; the parts
//         cancelled with the remark "merged into <new-id>"; depends_on in other tasks repointed. All or nothing.)
//   node scripts/orchestrator/queue.mjs batch pack --auto [--execute]   (proposals for the ready groups, with id <prefix>S<n>;
//                                                                  --execute packs all of them in one write)
//
// Areas, focus period and parking (the logic is in lib/queueLogic.js). All fields are optional; without focus and without parked
// the queue is ranked by priority alone.
//   node scripts/orchestrator/queue.mjs area <oid> --title "..." [--description "..."] [--projects <pid> ...] [--remove <pid> ...]
//        [--expect-changed <iso>] [--json]
//        (creates/changes an area and sets the projects' `area`; a project belongs to one area. --delete refuses
//         when a project or the focus uses the area.) Also: queue.mjs project <pid> --area <oid|none>.
//   node scripts/orchestrator/queue.mjs areas                        (area -> projects, waiting, ready ones, min left, parked)
//   node scripts/orchestrator/queue.mjs focus                          (current focus, the stages, dragged along, Next up, notice)
//   node scripts/orchestrator/queue.mjs focus set <stage> [<stage> ...] [--rest wait|fill] [--to <date>] [--name "..."]
//        [--without-dependencies] [--by "..."]
//        (stage = area:<oid>, project:<pid>, feature:<pid>/<name> or a bare area/project name. Everything in stage 1
//         before everything in stage 2, regardless of score; within a stage, score applies. The most specific stage wins.
//         --rest wait (default): tasks outside the focus do not start; fill: they fill slots the focus does not use.
//         Dependencies of focus tasks are dragged along (transitively) unless --without-dependencies. --to YYYY-MM-DD = up to
//         and including that day (UTC); afterwards the queue is ranked as without focus, with a notice. Pause on a project takes precedence.)
//   node scripts/orchestrator/queue.mjs focus evaluate [--json] [--all]
//        (each stage with open, ready, minutes left, rests (batch queue, proposals, waiting only on owner questions,
//         QA with the owner) with a suggestion per rest, and status active | done-with-rests | done.)
//   node scripts/orchestrator/queue.mjs focus clean [--dry] [--by "..."]
//        (takes out the stages with status done; done-with-rests stays until the rests are settled. The removal is
//         recorded in focus.history and the changelog (queue.mjs undo). The last stage is never taken out by itself.
//         receive, set <id> done|cancelled and fill do the same automatically, with one line per stage in the output.)
//   node scripts/orchestrator/queue.mjs focus off
//   node scripts/orchestrator/queue.mjs focus save --file <plan.json> [--dry] [--expect-changed <iso>] [--json] [--by "..."]
//        (the plan view on the board: { order, now_count?, rest?, to?, name?, drag_with_dependencies?,
//         pause?: [pid], continue?: [pid] } in ONE change, all or nothing. Empty order = focus off. now_count =
//         how many stages the board shows in "Now".)
//   node scripts/orchestrator/queue.mjs park <id> ... [--reason "..."] [--to <date>] [--by "..."]   (put on hold: status stays
//                                                                  waiting; next, start and pickable skip it; pick
//                                                                  and start require --force. Only waiting and proposed.)
//   node scripts/orchestrator/queue.mjs continue <id> ...                (takes it off hold)
//   Warning when the focus has nothing ready or the period is over: in `next`, `show`, `focus` and `state` (the field focus).
//
// Bulk edit, undo, block moves and project proposals. Everything happens under the lock and is all or nothing.
//   edit-many: the fields `parked` (true | { reason?, to? } | null = take off hold; only waiting and proposed, like park) and
//        `batched` (true | false/null; same rules as add/edit), and the register fields area, fileRoot and features.
//        --dry: preview (what changed, warnings, the queue's version `changed`), writes nothing.
//        --expect-changed <iso>: refuses with exit 6 when the queue has changed after that time (the board previewed an
//        older queue). --json: the answer as JSON (for the board).
//   node scripts/orchestrator/queue.mjs rank <id> ... --top|--bottom|--over <id>|--under <id> [--dry] [--expect-changed <iso>]
//        [--json]   (moves tasks as a block within the focus stage and keeps their mutual order; new
//                    priority_bonus. --json: the answer as JSON for the board)
//   node scripts/orchestrator/queue.mjs undo [--show] [--nr <n>] [--expect-changed <iso>] [--json]
//        (rolls back the last changelog entry that is not undone; refuses when a field has changed since. --nr: only
//         when the last undoable entry is no. n, so the board's "Undo" never rolls back someone else's change.
//         The changelog (`changelog`, the last 50) is kept by edit, edit-many, rank, park, continue, project
//         and classify.)
//   node scripts/orchestrator/queue.mjs classify [--file <in.json>] [--without-project] [--disagree] [--execute] [--json]
//        (project proposals: longest prefix, the plan in source/mission, fileRoot (`project <pid> --file-root <path ...>`).
//         Without --file: tasks in the queue, "move" (confident proposals for tasks without a project; --execute sets them) and
//         "Sort" (uncertain ones, or disagreeing with the project they have; never changed automatically). --file: proposals for an add file.)
//   `add` warns when the project is missing (with the proposal and the signal) or conflicts with strong signals, and about a feature
//   that is not in the project's `features`. `project` warns about one-char prefixes and overlapping prefixes.
//
// The plan register (the logic is in lib/queuePlan.js; see docs/plan-register.md). The register is <dataFolder>/plans.json, its own file
// alongside queue.json (plan work never bumps the queue's version), with the same lock, atomic writes, --expect-changed (against
// plans.json), changelog and undo. The file is created by the first writing plan command. Module = area (`queue.mjs area`),
// project = `queue.mjs project`; a plan entry points to documents, it does not copy them.
//   node scripts/orchestrator/queue.mjs plan show [--module m] [--project p] [--priority now owner …] [--maturity …]
//        [--search "..."] [--all] [--json]          (dropped ones are hidden without --all or --priority drop)
//   node scripts/orchestrator/queue.mjs plan get <id|project|module> [--json]   (entries, sources, queue status, owner questions
//                                                                             and copy line)
//   node scripts/orchestrator/queue.mjs plan new --file <json> (one entry or a list)
//   node scripts/orchestrator/queue.mjs plan edit <id> [--field name=val ...] [--set '{"field":...}']   (null or name=
//        removes the field)
//   node scripts/orchestrator/queue.mjs plan prioritize <id…> <now|owner|later|drop> [--category security for-prod important]
//        [--reason "Rule 3: ..."]   (all or nothing; drop requires --reason)
//   node scripts/orchestrator/queue.mjs plan prioritize-many --file <json>   ([{ id, priority, category?, reason? }], all
//        the moves in one write: one lock and one changelog entry, all or nothing)
//   node scripts/orchestrator/queue.mjs plan combine <to-id> <from-id...>     (the others are moved to the archive)
//   node scripts/orchestrator/queue.mjs plan verify <id> --findings "..." [--commit <sha>]
//   node scripts/orchestrator/queue.mjs plan undo [--show] [--nr <n>]
//   node scripts/orchestrator/queue.mjs plan rules [--json]                     (the priority rules)
//   node scripts/orchestrator/queue.mjs plan active [<id> [--end]] [--by "..."] [--json]   ("Working now" cursor
//        active_session { entry, at, by } in plans.json; without an id the active ones are listed. No changelog, changed is not bumped,
//        and the cursor dies after 2 hours without a new pulse)
//   Writing plan commands take --dry (preview), --expect-changed <iso>, --json (answer as JSON), --by "..." and
//   --set-by agent|owner (default agent). An agent never changes a priority the owner has set, except rule 1
//   (security lifts to now; the field agent_boost shows it), and must always give priority_reason.
//   node scripts/orchestrator/queue.mjs add --file <task.json> --plan <PL-id>   (links tasks without their own `plan` to
//        the plan entry; an unknown or merged entry is refused, the project is taken from the entry when missing, and the entry
//        becomes in-queue automatically. The field `plan` can also be in the file, and is set on existing tasks with edit-many.)
//   node scripts/orchestrator/queue.mjs plan check [--json] [--max N]   (unregistered documents, dead paths, stale,
//        statusDeviation, ruleDeviation, gaps, possible duplicates and capacity, and INDEX drift against the register
//        (make-index.mjs --check, the field `index` in --json); read-only)
//   node scripts/orchestrator/queue.mjs plan modules [--link] [--dry] [--json]   (creates modules from
//        config().modules that are missing in areas; --link gives projects without a module the proposal in
//        config().projectModuleSuggestion)
//   node scripts/orchestrator/queue.mjs plan backup [--push] [--dry]   (runs the script in config().planBackup, with
//        QUEUE_ROOT = the project root; QUEUE_PLAN_BACKUP overrides the path. Not set up = explanation and exit 1)
// Documents and agreements: the register `documents` in plans.json (metadata only; the text stays where it is), with
// the same lock, --expect-changed, changelog and `plan undo` as the plan entries.
//   node scripts/orchestrator/queue.mjs plan doc show [--group g ...] [--status s ...] [--audience m ...] [--priority p ...]
//        [--problems] [--search "..."] [--all] [--json]   ("What must be done" at the top, then a table per group)
//   node scripts/orchestrator/queue.mjs plan doc get <DOC-id> [--json]   (versionSkew, next revision, links,
//        copy line)
//   node scripts/orchestrator/queue.mjs plan doc new --file <json>            (one document or a list)
//   node scripts/orchestrator/queue.mjs plan doc edit <DOC-id> [--field name=val ...] [--set '{...}']
//   node scripts/orchestrator/queue.mjs plan doc revise <DOC-id> [--version v] [--date YYYY-MM-DD] [--remark "..."]
//        (last_revised, new version and a line in revisions; gives a new next revision)
//   node scripts/orchestrator/queue.mjs plan doc check [--write] [--dry] [--json]   (the consistency checks in queuePlan.js, e.g.
//        the vendor list against config().documents and overdue revisions; --write enters the findings as problems with
//        source check:<type>; also shown in `plan check`)
//   node scripts/orchestrator/queue.mjs plan doc web [--write] [--dry] [--json]    (manual only: GET on the published
//        web addresses, whether they answer and the version stated there)
//
// Budget guard: with limits.dailyBudget set (USD API equivalent per local day, the owner sets the number) `next`
// proposes nothing and `start` refuses when today's usage has reached the limit. The usage is read from the time log
// (config().timeLog), deduplicated per agent (lib/timeCost.js, the same numbers as `log-time.mjs --cost`). Default: off.
//
// Night pause: with limits.nightRun = false (`queue.mjs limit nightRun off`) `next` proposes nothing (exit 5,
// "Night pause until 06:00 ...") and `start` refuses (exit 5) within the night window (limits.nightWindow, default 23-06, Norwegian
// time). Running tasks finish, and `set`/`deliver`/merge continue; only new starts stop. As with
// the budget guard (exit 4) this is not an empty queue. `start --force` overrides. Default: on (no night pause).
//
// Wind-down guard: when the active orchestrator session passes about 350k context, hook-context.mjs sets `windDown` in
// the orchestrator cursor. Then `next`, `start` and `fill` refuse (exit 6): the session finishes receiving, review, fix rounds and
// merges (`set`, `resolve`, `receive` work as before), updates the running handoverNote and is compacted.
// hook-after-compact.mjs lifts the wind-down after the compaction. Emergency rotation (the session has hung):
// `orchestrator pulse --session "<new name>"` (the new session takes the cursor) or `orchestrator stop` also resets.
// `start --force` (the owner's word) overrides.
//
// Load guard: with a free memory limit set (`queue.mjs limit minFreeMemoryPct 15`, or loadGuard.minFreeMemoryPct in
// queue.config.json; the queue's value wins), `next`, `start` and `fill` refuse new starts (exit 7, "THE MACHINE IS
// FULL: ...") while free memory (os.freemem / os.totalmem) is below the limit. `show` and `state` show the reason.
// Running tracks finish. `start --force` and `fill --over-load` override. Default: off.
// QUEUE_LOAD="free=<pct>" replaces the measurement (tests).
//
//   node scripts/orchestrator/queue.mjs handover archive [--dry]   (moves dated log entries older than 24 h from
//                                                                  <dataFolder>/handover-ongoing.md to
//                                                                  handover-archive/<year-month>.md and warns when "Now"
//                                                                  has over 40 lines; --dry writes nothing. Run at every
//                                                                  compaction and at takeover; lib/queueHandover.js)
//   node scripts/orchestrator/queue.mjs handover now               (prints only the "Now" part of the note; the archive is
//                                                                  read with grep when needed)
//
// "Follow up" entries (observations with a start, an end, goals, a log and a fixed report template; <dataFolder>/follow.json,
// the same lock as the queue; the rules in lib/queueFollow.js). `show` and `orchestrator pulse` show the active ones and
// TO REPORT (the day is the local calendar day):
//   node scripts/orchestrator/queue.mjs follow                          (the list: status, period, number of log entries)
//   node scripts/orchestrator/queue.mjs follow add --file <json>        ({ id: "F-...", title, why, start, end, owner,
//                                                                  goals: [{ name, how, expected }], related?,
//                                                                  close_action? }; end after start, unique id)
//   node scripts/orchestrator/queue.mjs follow log <id> [--text "..."] [--value name=x ...] [--source "..."]
//   node scripts/orchestrator/queue.mjs follow show <id>
//   node scripts/orchestrator/queue.mjs follow report <id>              (writes <dataFolder>/follow/<id>-report.md from the
//                                                                  template, status reported; the assessment is the
//                                                                  orchestrator's)
//   node scripts/orchestrator/queue.mjs follow close <id> --decision "..." [--cancelled]   (the owner decision; writes the
//                                                                  report again with the decision and shows the close action)
//   node scripts/orchestrator/queue.mjs follow extend <id> --to <YYYY-MM-DD>
//
// Exit codes: 0 ok, 1 error, 3 empty queue (state), 4 the daily budget is used up (next, start), 5 night pause (next,
// start), 6 the orchestrator is in windDown (next, start, fill) or the queue has changed since the preview
// (--expect-changed), 7 the machine is full (the load guard; next, start, fill).
//
// Task fields (see queueLogic.validate): id, title, domain, class (K|D|D+|U), mission (path to a track description
// or the text itself), value (1-10, default 5), content_min (min for a K track, default 30), migr_tens (number of
// blocks of migration numbers, 0 for client/investigation; only used with the migration flow), depends_on [id], waiting_on
// [owner question id], owned_files [path or folder/], owner_db [feature], shared_patch [shared feature], source (plan and
// sub-plan), added_by, project (pid), plan (plan entry id in plans.json), feature (short name), labels (e.g.
// ["visual"]), requires (resources, see queueLogic.REQUIRES), batched (true = batch queue). Set by the tool: picked_by,
// picked_at, qa_status (waiting|ok|deviation), qa_note, qa_original (on a fix task), evidence ({ type, ref }, from the
// EVIDENCE line or qa evidence; see config().qa), qa_ok_by ("auto" when qa auto --run closed it).
// =============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const L = require('./lib/queueLogic.js');
const KV = require('./lib/contextGuard.js');
const TK = require('./lib/timeCost.js');
const G = require('./lib/queueGit.js');
const D = require('./lib/queueDiagnose.js');
const P = require('./lib/queuePlan.js');
const S = require('./lib/queueStatistics.js');
const CH = require('./lib/queueCapacity.js');
const KK = require('./lib/queueConfig.js');
const HELP = require('./lib/queueHelpers.js');
const HO = require('./lib/queueHandover.js');
const F = require('./lib/queueFollow.js');

// The project's settings (queue.config.json merged with the defaults in lib/queueConfig.js).
const CONFIG = KK.config();
// The integration branch everything is merged into (often main), the remote and the branch prefix for queue tasks.
const BASE = CONFIG.baseBranch;
const REMOTE = CONFIG.remote;
const PREFIX = CONFIG.branchPrefix ?? 'queue/';
/** Branch for a queue task: <branchPrefix><id>. */
const branchFor = (id) => `${PREFIX}${id}`;
// The optional migration flow (folder null = off: no number blocks and no push in merge).
const MIGR = CONFIG.migrations ?? { folder: null };

// The folder of the orchestrator scripts. Sibling scripts are started from here, not from the project, because in a
// plugin install the scripts live outside the project.
const HERE = path.dirname(fileURLToPath(import.meta.url));
// ROOT = the tree we run in (a worktree for a track); MAIN_TREE = the main tree, where the queue ALWAYS lives, otherwise
// each track would get its own empty queue. Both come from lib/projectRoot.js. QUEUE_FOLDER overrides (tests).
const { tree: ROOT, main: MAIN_TREE } = require('./lib/projectRoot.js').roots();
// The command to write in hints: `cq` (plugin) or `node scripts/orchestrator/cq.mjs` (vendored install).
const CQ = require('./lib/projectRoot.js').cqCommand();
const FOLDER = KK.dataFolder();
const FILE = path.join(FOLDER, 'queue.json');
const LOCK = path.join(FOLDER, '.lockState');
// The "Follow up" entries (queue.mjs follow; the rules in lib/queueFollow.js) and their reports.
const FOLLOW_FILE = path.join(FOLDER, 'follow.json');
const FOLLOW_REPORTS = path.join(FOLDER, 'follow');
// The time log with the usage per agent (hook-time.mjs writes it). QUEUE_TIME_LOG overrides (tests).
const TIME_LOG = KK.timeLog();
// The repo the queue branches are counted in (pick, release, show). QUEUE_GIT overrides (smoke test against a temporary repo).
const GIT_ROOT = process.env.QUEUE_GIT ?? MAIN_TREE;
const a = process.argv.slice(2);
const command = a[0];

const val = (name) => {
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : undefined;
};
// All the values after a flag, up to the next flag (`--prefix A- B-`); the flag can also be repeated.
const values = (name) => {
  const out = [];
  a.forEach((x, i) => {
    if (x !== name) return;
    for (let j = i + 1; j < a.length && !a[j].startsWith('--'); j++) out.push(a[j]);
  });
  return out;
};
// The positional arguments after the command, without flags and flag values (the flags with a value are listed in `withValue`).
const positional = (from, withValue = []) =>
  a.slice(from).filter((x, i, arr) => !x.startsWith('--') && !withValue.includes(arr[i - 1]));

// Width of the terminal (narrow window: shorter titles). Outside a terminal (pipe, log) 110 is used.
const WIDTH = Math.max(60, Math.min(process.stdout.columns || 110, 160));
const cut = (s, n) => {
  const t = String(s ?? '');
  return n <= 1 ? '' : t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---- Git (the queue branches) --------------------------------------------------------------------------------
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: GIT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Does the branch exist, how many commits is it ahead of baseBranch, and when was the last one? */
function branchInfo(branch) {
  if (git(['rev-parse', '-q', '--verify', `refs/heads/${branch}`]) == null)
    return { exists: false, commits: 0, lastCommit: null };
  const commits = Number(git(['rev-list', '--count', `${BASE}..${branch}`]) ?? 0) || 0;
  const lastCommit = commits > 0 ? git(['log', '-1', '--format=%cI', branch]) : null;
  return { exists: true, commits, lastCommit };
}

/** The mission file (absolute path) when `mission` is a path that exists in the worktree or the main tree, otherwise null. */
function missionFile(o) {
  const s = String(o.mission ?? '');
  if (!s || s.includes('\n')) return null;
  for (const root of [ROOT, MAIN_TREE]) {
    const filePath = path.resolve(root, s);
    try {
      if (fs.statSync(filePath).isFile()) return filePath;
    } catch {
      /* does not exist here */
    }
  }
  return null;
}

/** "picked by X 3 h ago · 2 commits · OLD" for a picked task. */
function pickLine(o) {
  const g = branchInfo(o.branch ?? branchFor(o.id));
  const age = o.picked_at ? L.ageText(Date.now() - Date.parse(o.picked_at)) : '?';
  const old = L.isOldPick(o, g)
    ? ' · OLD (over 72 h without commits; never released automatically)'
    : '';
  return `picked by ${o.picked_by ?? '?'} ${age} ago · ${g.commits} commit(s) on ${o.branch ?? branchFor(o.id)}${old}`;
}
// ---- Batch queue ----------------------------------------------------------------------------------------
/** "K  65 / 90-120 min  [######------]  missing 25 min  (3 tasks)" for a group from queueLogic.batchGroups. */
function batchGroupLine(g) {
  const width = 12;
  const filled = g.measure ? Math.round(Math.min(g.sum / g.measure.max, 1) * width) : 0;
  const bar = `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
  const status = g.invalid
    ? `INVALID (${g.class} cannot be packed; take it out with edit --json '{"batched":false}')`
    : g.ready
      ? g.over
        ? 'READY FOR PACKING (over the upper target: becomes several packages)'
        : 'READY FOR PACKING'
      : `missing ${g.measure.min - g.sum} min`;
  const measure = g.measure ? `${g.measure.min}–${g.measure.max}` : '?';
  return `${String(g.class).padEnd(2)} ${`${g.sum} / ${measure} min`.padEnd(17)} ${bar}  ${status}  (${g.count} task(s))`;
}

/** The mission text of a task to be packed: the file (worktree or main tree), otherwise the text in the queue file. */
function readMission(o) {
  const s = String(o.mission ?? '');
  const file = missionFile(o);
  if (file) return { text: fs.readFileSync(file, 'utf8'), path: s };
  if (!s.includes('\n') && /\.md$/i.test(s.trim()))
    return { error: `${o.id}: could not find the mission file ${s}` };
  return { text: s, path: null };
}

/** The `mission` field for a new mission file: relative to the main tree (<dataFolder>/mission/<id>.md), otherwise absolute. */
function missionRef(file) {
  const rel = path.relative(MAIN_TREE, file);
  return (rel.startsWith('..') || path.isAbsolute(rel) ? file : rel).replace(/\\/g, '/');
}

/**
 * Executes the packing plan under the lock, ALL OR NOTHING: `planFn(queue)` gives [{ id, parts, title, out }] (computed inside the
 * lock). `out` takes a single task out of the batch queue; otherwise queueLogic.batchPack. If one package fails, nothing is written.
 * The mission files are written first (never over an existing one), then the queue file; if the write fails, the files are removed again.
 */
function batchPackExecute(planFn) {
  return withLock(() => {
    const queue = read();
    // The board sends --expect-changed (the queue's version from the preview); exit 6 when the queue has changed since.
    checkExpect(queue);
    const plan = planFn(queue);
    if (!plan.length) die('No groups in the batch queue are ready for packing. Nothing was changed.');
    const now = new Date().toISOString();
    const result = [];
    const files = [];
    for (const p of plan) {
      if (p.out) {
        const o = queue.tasks.find((x) => x.id === p.parts[0]);
        if (!o) die(`Unknown task ${p.parts[0]}. Nothing was changed.`);
        delete o.batched;
        result.push({ out: true, id: o.id, sum: p.sum });
        continue;
      }
      const file = path.join(FOLDER, 'mission', `${p.id}.md`);
      if (fs.existsSync(file)) die(`The mission file already exists: ${file}. Nothing was changed.`);
      if (files.some((f) => f.file === file)) die(`${p.id} appears twice. Nothing was changed.`);
      const texts = new Map();
      const error = [];
      for (const id of p.parts) {
        const o = queue.tasks.find((x) => x.id === id);
        if (!o) continue; // batchPack reports unknown ids
        const t = readMission(o);
        if (t.error) error.push(t.error);
        else texts.set(id, t);
      }
      if (error.length) die(`Nothing packed:\n  ${error.join('\n  ')}`);
      const r = L.batchPack(queue, p.parts, {
        newId: p.id,
        title: p.title,
        mission: missionRef(file),
        by: 'cq batch pack',
        now,
      });
      if (r.error.length) die(`Nothing packed (${p.id ?? 'without id'}):\n  ${r.error.join('\n  ')}`);
      const parts = p.parts.map((id) => queue.tasks.find((x) => x.id === id));
      files.push({ file, text: L.batchMissionText(r.new, parts, texts, now) });
      result.push({ ...r, sum: r.new.content_min });
    }
    const written = [];
    try {
      fs.mkdirSync(path.join(FOLDER, 'mission'), { recursive: true });
      for (const f of files) {
        fs.writeFileSync(f.file, f.text, { flag: 'wx' });
        written.push(f.file);
      }
      write(queue);
    } catch (e) {
      for (const f of written) fs.rmSync(f, { force: true });
      die(`Nothing packed: ${e?.message ?? e}`);
    }
    return result;
  });
}

/** One line per executed package (or task taken out of the batch queue). */
function batchExecutedLine(p) {
  if (p.out) return `${p.id}: taken out of the batch queue (${p.sum} min alone).`;
  return (
    `Packed ${p.new.id} (${p.new.class}, ${p.sum} min, status ${p.new.status}) from ${p.cancelled.join(', ')} ` +
    `(cancelled); mission ${p.new.mission}` +
    (p.redirected.length ? `; depends_on repointed in ${p.redirected.join(', ')}` : '') +
    '.'
  );
}

// ---- Work outside the queue and the orchestrator cursor ------------------------------------------------
// Read-only, with --no-optional-locks (queueGit.js): a scan never takes index.lock from a session that is committing.
const gitRead = G.makeGit(GIT_ROOT);

/** The paths `git status` shows in the main tree. If they cannot be read, that is reported, and nothing is skipped. */
function uncommittedPaths() {
  const u = G.readUncommitted(gitRead);
  if (u == null) {
    console.error(
      'WARNING: could not read git status in the main tree; uncommitted files are not checked.',
    );
    return [];
  }
  return u.map((x) => x.path);
}

// The cursor for "orchestrator active" lives next to the queue file (gitignored), as a file of its own.
const CURSOR = path.join(FOLDER, 'orchestrator.json');
function readCursor() {
  try {
    return JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
  } catch {
    return null;
  }
}
/** Updates the cursor (session name: --session, otherwise QUEUE_SESSION, otherwise the previous). An error never stops the queue. */
function pulseCursor(event) {
  try {
    fs.mkdirSync(FOLDER, { recursive: true });
    const m = L.newCursor(readCursor(), { session: val('--session') ?? process.env.QUEUE_SESSION, event });
    const tmp = `${CURSOR}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
    fs.renameSync(tmp, CURSOR);
    return m;
  } catch {
    return null;
  }
}

/** Prints the warning for `start`/`pick` when the owned files have changed outside the queue since the task was added. */
function writeExternalWarning(o) {
  const v = G.externalForTasks(gitRead, [o]).get(o.id);
  if (!v) return;
  if (v.collisions.length) {
    console.log(
      `WARNING: ${v.collisions.length} change(s) in the owned files outside the queue since ${o.id} was added. ` +
        'The track file gets the warning (cq trackFile), so the track reads the diff before it builds:',
    );
    for (const k of v.collisions.slice(0, 5))
      console.log(`  ${L.collisionText(k, { withId: false })}`);
    if (v.collisions.length > 5)
      console.log(`  ... and ${v.collisions.length - 5} more (cq external --all)`);
  }
  if (v.mentioned.length)
    console.log(
      `NOTE: commits outside the queue mention ${o.id}; is it already completed? (cq external accept ${o.id} <sha>): ` +
        v.mentioned
          .slice(0, 3)
          .map((c) => `${c.summary} "${c.subject.slice(0, 50)}"`)
          .join(', '),
    );
}

// process.exit skips finally blocks: release the lock here, otherwise it lingers for 60 s and stops all
// other calls (e.g. "cannot be started" inside the lock would otherwise block the queue).
let hasLock = false;
const die = (message, code = 1) => {
  console.error(message);
  if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
  process.exit(code);
};

// ---- Lock and storage --------------------------------------------------------------------------------------
function withLock(fn) {
  fs.mkdirSync(FOLDER, { recursive: true });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      hasLock = true;
      break;
    } catch {
      // A lock older than 60 s was left behind by a process that died: remove it.
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > 60_000)
          fs.rmSync(LOCK, { recursive: true, force: true });
      } catch {
        /* the lock disappeared between the checks */
      }
      if (Date.now() > deadline) die(`Could not get the lock on ${FOLDER} (tried for 15 s). Try again.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true });
    hasLock = false;
  }
}

function read() {
  if (!fs.existsSync(FILE)) die(`The queue does not exist. Run: ${CQ} init`);
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

// The short diagnosis paragraph when parallelism is low (fill, receive, orchestrator pulse). Reads the queue
// again, so tracks that were just started or received are counted. Prints nothing when parallelism is not low, and an
// error in the diagnosis never stops the command it is attached to.
function parallelWarning() {
  try {
    for (const l of D.diagnoseLines(D.parallelDiagnose(read()))) console.log(l);
  } catch (e) {
    console.log(`(The queue diagnosis failed: ${e?.message ?? e}. Run cq diagnose.)`);
  }
}

function write(queue) {
  queue.changed = new Date().toISOString();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
}

const edit = (fn) =>
  withLock(() => {
    const queue = read();
    const answer = fn(queue);
    write(queue);
    return answer;
  });

// Who made the change (the changelog) and optimistic concurrency (--expect-changed).
const byName = () => val('--by') ?? 'cq';
/** Refuses with exit 6 when the queue has changed after the time the caller previewed (called under the lock). */
function checkExpect(queue) {
  const f = L.expectCheck(queue, val('--expect-changed') ?? null);
  if (!f) return;
  const code = f.startsWith('invalid') ? 1 : 6;
  if (a.includes('--json')) {
    console.log(JSON.stringify({ ok: false, error: [f], outdated: code === 6 }));
    if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
    process.exit(code);
  }
  die(`Nothing changed: ${f}`, code);
}
/** The entry editLogged added to the changelog (null when nothing changed). */
let lastEntry = null;
/**
 * Like edit, but checks --expect-changed and puts what actually changed (tasks and the project register) in
 * the changelog, so `queue.mjs undo` can roll it back.
 */
const editLogged = (action, fn) =>
  withLock(() => {
    const queue = read();
    checkExpect(queue);
    const forQueue = L.cloneJson({ tasks: queue.tasks ?? [], projects: queue.projects ?? {} });
    const answer = fn(queue);
    lastEntry = L.logChange(queue, {
      by: byName(),
      action,
      changes: L.bulkDiff(forQueue, queue),
      now: new Date().toISOString(),
    });
    write(queue);
    return answer;
  });
// receive, set <id> done|cancelled and fill evaluate the focus stages in the SAME write (under the lock) and take out
// the stages that are done (queueLogic.cleanFocus: history + changelog, so queue.mjs undo works). An error here never
// stops the command; the lines are printed afterwards with focusCleanOut.
let focusClean = null;
function autoCleanFocus(queue, action) {
  try {
    focusClean = L.cleanFocus(queue, { by: `cq ${action} (auto)` });
  } catch (e) {
    focusClean = { error: e?.message ?? String(e) };
  }
}
function focusCleanOut() {
  if (!focusClean) return;
  if (focusClean.error)
    console.log(`WARNING: the focus cleaning failed (${focusClean.error}); see cq focus evaluate.`);
  else for (const l of L.focusCleanLines(focusClean)) console.log(l);
}

/** "(undo: queue.mjs undo)" after a logged write. */
const undoHint = () =>
  lastEntry
    ? `Changelog no. ${lastEntry.nr} (${lastEntry.changes.length} field(s)); undo: cq undo`
    : null;

// ---- The plan register: storage under the same lock as the queue ---------------------------------------
const PLAN_FILE = path.join(FOLDER, 'plans.json');
// The source paths in the plan entries are relative to the main tree. The tests set their own root (QUEUE_PLAN_SOURCE_ROOT).
const SOURCE_ROOT = process.env.QUEUE_PLAN_SOURCE_ROOT ?? MAIN_TREE;

function readPlans() {
  if (!fs.existsSync(PLAN_FILE)) return P.emptyRegister();
  return P.normalize(JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')));
}
// `bump: false` (plan active) leaves `changed` alone: a pulse is no plan change and must not make --expect-changed outdated.
function writePlans(reg, { bump = true } = {}) {
  if (bump) reg.changed = new Date().toISOString();
  const tmp = `${PLAN_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  fs.renameSync(tmp, PLAN_FILE);
}
/** The queue read-only (projects, areas, tasks, owner questions); empty when it does not exist. */
const readQueueForPlan = () => (fs.existsSync(FILE) ? read() : {});
/** Does the source path exist under the source root? Never outside the root (queuePlan.sourcePathError already rejected .. and absolute paths). */
function existsSource(filePath) {
  const full = path.resolve(SOURCE_ROOT, filePath);
  const rel = path.relative(SOURCE_ROOT, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return fs.existsSync(full);
}
/** The caller's role: agent (default) or owner. */
function planRole() {
  const r = val('--set-by') ?? 'agent';
  if (!P.SET_BY.includes(r)) die(`--set-by must be ${P.SET_BY.join(' or ')}`);
  return r;
}
/** An error from a plan command: as JSON with --json (the board), otherwise as text. Releases the lock. */
function planError(error, code = 1, extra = {}) {
  if (a.includes('--json')) {
    console.log(JSON.stringify({ ok: false, error, ...extra }));
    if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
    process.exit(code);
  }
  die(`Nothing changed:\n  ${error.join('\n  ')}`, code);
}
/**
 * Writing to the plan register: under the lock, --expect-changed against plans.json, all or nothing. `fn(reg, queue)` changes
 * `reg` and gives the answer ({ error, warnings, ... }); errors give an exit without writing. With --dry nothing is written, and the answer has
 * the changes. Otherwise the changes are entered in the register's changelog (undone with `plan undo`).
 */
function editPlans(action, fn) {
  const dry = a.includes('--dry');
  return withLock(() => {
    const reg = readPlans();
    const fe = P.expectCheck(reg, val('--expect-changed') ?? null);
    if (fe)
      planError([fe], fe.startsWith('invalid') ? 1 : 6, { outdated: !fe.startsWith('invalid') });
    const version = reg.changed ?? null;
    const forReg = JSON.parse(
      JSON.stringify({ entries: reg.entries, archive: reg.archive, documents: reg.documents }),
    );
    const answer = fn(reg, readQueueForPlan());
    if (answer.error?.length) planError(answer.error, 1, { warnings: answer.warnings ?? [] });
    const changes = P.planDiff(forReg, reg);
    if (dry) return { ...answer, changes, version, dry: true, log: null };
    const entry = P.logChange(reg, { by: byName(), action, changes });
    if (entry) writePlans(reg);
    return { ...answer, changes, version: reg.changed ?? version, log: entry?.nr ?? null };
  });
}
/** The lines in the preview and after a write. */
const planDiffLines = (changes) =>
  L.diffLines(
    changes.map((e) => ({
      ...e,
      id: e.collection === 'archive' ? `${e.id} (archive)` : e.id,
      field: e.field === '*' ? (e.before == null ? 'new' : 'removed') : e.field,
      before: e.field === '*' && e.before ? e.before.title : e.before,
      after: e.field === '*' && e.after ? e.after.title : e.after,
    })),
  );
/** The answer after a writing plan command (text or JSON). */
function planAnswer(r, heading) {
  if (a.includes('--json')) {
    console.log(
      JSON.stringify({
        ok: true,
        dry: Boolean(r.dry),
        changes: r.changes,
        warnings: r.warnings ?? [],
        log: r.log,
        changed: r.version,
        ...(r.entry ? { entry: r.entry } : {}),
        ...(r.doc ? { doc: r.doc } : {}),
        ...(r.boost?.length ? { boost: r.boost } : {}),
      }),
    );
    return;
  }
  console.log(`${r.dry ? 'Preview (nothing written): ' : ''}${heading}`);
  for (const l of planDiffLines(r.changes)) console.log(`  ${l}`);
  if (!r.changes.length) console.log('  (no change)');
  for (const x of r.warnings ?? []) console.log(`WARNING: ${x}`);
  if (r.log) console.log(`Changelog no. ${r.log} in plans.json; undo: cq plan undo`);
}
/** The positional arguments before the first flag (`plan prioritize A B now --category ...`). */
const forFlag = (from) => {
  const out = [];
  for (const x of a.slice(from)) {
    if (x.startsWith('--')) break;
    out.push(x);
  }
  return out;
};
/** One line in `plan show`. */
function planRow(p) {
  const pri =
    p.priority === 'now' && p.now_category?.length
      ? `now/${p.now_category.join('+')}`
      : p.priority;
  const mod = `${p.derived.maturity}${p.derived.fraction ? ` ${p.derived.fraction}` : ''}${p.derived.stale ? ' (stale)' : ''}`;
  const fixedLine = `${p.id.padEnd(16)} ${pri.padEnd(18)} ${mod.padEnd(14)} ${(p.size ?? '-').padEnd(3)} ${(p.project ?? '').padEnd(16)} `;
  return cut(`${fixedLine}${p.title}${p.deadline ? ` (deadline ${p.deadline})` : ''}`, WIDTH);
}

// ---- plan check, plan modules and plan backup ----------------------------------------

/** The .md files under queuePlan.DOCUMENT_FOLDERS (relative paths with slashes), without hidden folders and node_modules. */
function planDocuments() {
  const out = [];
  const go = (rel) => {
    let list;
    try {
      list = fs.readdirSync(path.join(SOURCE_ROOT, rel), { withFileTypes: true });
    } catch {
      return; // the folder does not exist
    }
    for (const d of list) {
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      const r = `${rel}/${d.name}`;
      if (d.isDirectory()) go(r);
      else if (d.isFile() && d.name.toLowerCase().endsWith('.md')) out.push(r);
    }
  };
  for (const m of P.DOCUMENT_FOLDERS) go(m);
  return out;
}
/** Larger documents are not read for the status deviation (they are not plans). */
const DOC_MAX_BYTE = 2 * 1024 * 1024;
/** The text of a source (only under the source root), or null. */
function readDoc(filePath) {
  if (P.sourcePathError(filePath) || !existsSource(filePath)) return null;
  try {
    const full = path.resolve(SOURCE_ROOT, filePath);
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > DOC_MAX_BYTE) return null;
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}
const sourceGit = G.makeGit(SOURCE_ROOT);
/**
 * The files (of `files`) that changed in HEAD after the verification: after the commit when it is known, otherwise after the day.
 * An unknown commit or a folder that is not a git repo gives an empty list (nothing to say).
 */
function changedFiles(files, { date, commit }) {
  const safe = typeof commit === 'string' && /^[0-9a-f]{4,40}$/i.test(commit);
  const args = safe
    ? ['log', '--format=', '--name-only', `${commit}..HEAD`, '--', ...files]
    : ['log', '--format=', '--name-only', `--since=${date}T23:59:59`, 'HEAD', '--', ...files];
  const out = sourceGit(args);
  if (out == null) return [];
  return [
    ...new Set(
      out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * The drift check for the index file (make-index.mjs --check). The index is ordered by the register, so an entry that
 * gets new sources makes it stale; `plan check` shows that as its own point. Read-only. The same data folder as
 * queue.mjs (QUEUE_FOLDER passed on). make-index.mjs skips with exit 0 when the index is turned off (indexFile: null),
 * or the register or the index file is missing.
 * Answer: { status: 'ok' | 'drift' | 'skipped' | 'error', text } (text = the output, short).
 */
function indexDrift() {
  const s = spawnSync(process.execPath, [path.join(HERE, 'make-index.mjs'), '--check'], {
    cwd: KK.config().root,
    encoding: 'utf8',
    env: { ...process.env, QUEUE_FOLDER: FOLDER },
  });
  if (s.error) return { status: 'error', text: `make-index.mjs did not start: ${s.error.message}` };
  const text = `${s.stdout ?? ''}${s.stderr ?? ''}`.trim();
  if (s.status === 1) return { status: 'drift', text };
  if (s.status !== 0) return { status: 'error', text: text || `exit ${s.status}` };
  return { status: /skipping/.test(text) ? 'skipped' : 'ok', text };
}

/** `plan check [--json] [--max N]`: the hygiene of the plan register. Read-only; changes nothing. */
function planCheck(json) {
  const queue = readQueueForPlan();
  const reg = readPlans();
  const days = S.daysBackward(Date.now(), P.CAPACITY_WINDOW_DAYS);
  const donePerWeek = S.doneInWindow(queue, days).length / (P.CAPACITY_WINDOW_DAYS / 7);
  const r = P.check(reg, queue, {
    documents: planDocuments(),
    existsPath: existsSource,
    readDoc,
    changedFiles,
    donePerWeek,
    projectFor: (o) => L.projectFor(o, queue.projects ?? {}),
  });
  const index = indexDrift();
  if (json) {
    console.log(JSON.stringify({ ok: true, changed: reg.changed ?? null, ...r, index }));
    return;
  }
  const max = Number(val('--max') ?? 15) || 15;
  const chunk = (title, list, line) => {
    if (!list.length) return;
    console.log(`\n${title} (${list.length})`);
    for (const x of list.slice(0, max)) console.log(`  ${cut(line(x), WIDTH - 2)}`);
    if (list.length > max) console.log(`  ... ${list.length - max} more (--max N or --json)`);
  };
  const who = (x) => x.id ?? x.task ?? x.project ?? '';
  console.log(`Plan check: ${reg.entries.length} entries, ${r.count} findings. ${r.capacity.text}`);
  chunk('Unregistered (no entry points to the document)', r.unregistered, (s) => s);
  chunk('Dead paths', r.dead_paths, (x) => `${x.id}: ${x.path}`);
  chunk('Stale', r.stale, (x) => `${x.id}: ${x.reason}`);
  chunk('Built, but not verified (plan verify)', r.not_verified, (s) => s);
  chunk('Status deviation', r.statusDeviation, (x) => `${who(x)}: ${x.reason}`);
  chunk('Rule deviation (the priority rules, not changed automatically)', r.ruleDeviation, (x) => `${x.id}: ${x.reason}`);
  chunk('Gaps', r.gaps, (x) => `${x.id}: ${x.reason}`);
  chunk(
    'Possible duplicates (plan combine)',
    r.duplicates,
    (x) => `${x.ids.join(' + ')}: ${x.reason}`,
  );
  if (r.capacity.without_size.length)
    console.log(`\nNow without size: ${r.capacity.without_size.join(', ')}`);
  // Reference documents and history are registered, but not read for status (not findings).
  if (r.references?.length)
    console.log(
      `\nReference and history (registered, no status check): ${r.references.length} source(s) in ` +
        `${new Set(r.references.map((x) => x.id)).size} entr(ies)`,
    );
  // The consistency checks for documents and agreements.
  if (r.doc_consistency)
    chunk(
      'Documents and agreements (plan doc check --write enters them as problems)',
      r.doc_consistency,
      docFindingsLine,
    );
  // The index against the register (make-index.mjs --check). Drift or an error is shown with the output; fix it with
  // `node scripts/orchestrator/make-index.mjs` (writes the index in this tree).
  if (index.status === 'drift' || index.status === 'error') {
    console.log(`\nIndex against the register (${index.status === 'drift' ? 'DRIFT' : 'ERROR'})`);
    for (const l of index.text.split('\n')) console.log(`  ${cut(l.trim(), WIDTH - 2)}`);
  } else {
    console.log(`\nIndex against the register: ${index.status === 'ok' ? 'OK' : 'skipped (turned off, or no register or index file)'}`);
  }
}

// ---- The consistency checks for documents and agreements ---------------------------------------

/** One line per consistency finding. */
const docFindingsLine = (f) =>
  `${f.severity.padEnd(7)} ${(f.doc ?? '-').padEnd(16)} ${f.check}: ${f.text}`;

/** Reads a page (GET only, without login, at most 2 MB, 10 s). Gives { status, text } or { error }. */
async function getPage(url) {
  try {
    const answer = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'queue-plan-doc-web' },
    });
    const text = (await answer.text()).slice(0, 2 * 1024 * 1024);
    return { status: answer.status, text };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'timeout' : (e?.code ?? e?.message ?? 'error') };
  }
}

/** The answer from `plan doc check` and `plan doc web` (text or JSON), with what was written. */
function docCheckAnswer(json, findings, ran, written) {
  if (json) {
    console.log(
      JSON.stringify({
        ok: true,
        ran,
        findings,
        ...(written
          ? {
              dry: Boolean(written.dry),
              changed_doc: written.changed,
              changes: written.changes,
              log: written.log,
              changed: written.version,
            }
          : {}),
      }),
    );
    return;
  }
  console.log(`Consistency check (${ran.join(', ')}): ${findings.length} findings.`);
  for (const f of findings) console.log(`  ${cut(docFindingsLine(f), WIDTH - 2)}`);
  if (written) {
    console.log(
      `${written.dry ? 'Preview (nothing written): ' : ''}Problems updated in ${written.changed.length} document(s)${written.changed.length ? `: ${written.changed.join(', ')}` : ''}`,
    );
    for (const l of planDiffLines(written.changes)) console.log(`  ${l}`);
    for (const x of written.warnings ?? []) console.log(`WARNING: ${x}`);
    if (written.log)
      console.log(`Changelog no. ${written.log} in plans.json; undo: cq plan undo`);
  } else if (findings.some((f) => f.doc && f.check !== 'revision'))
    console.log('Enter them as problems: add --write (--dry shows them first).');
}

/** Enters the findings as problems (under the lock, logged and undoable) when --write is given. */
function docWriteFindings(findings, ran) {
  if (!a.includes('--write')) return null;
  const role = planRole();
  return editPlans('plan doc check', (reg, queue) =>
    P.syncConsistency(reg, findings, ran, {
      role,
      by: byName(),
      question: queue.question ?? {},
      existsPath: existsSource,
    }),
  );
}

/** `plan doc check [--write] [--dry] [--json]`: vendor lists and overdue revisions. */
function planDocCheck(json) {
  const r = P.docConsistency(readPlans(), readQueueForPlan(), { readDoc });
  if (!r.ran.length) {
    if (json) console.log(JSON.stringify({ ok: true, ran: [], findings: [] }));
    else console.log('The document register is empty; nothing to check.');
    return;
  }
  docCheckAnswer(json, r.findings, r.ran, docWriteFindings(r.findings, r.ran));
}

/**
 * `plan doc web [--write] [--dry] [--json]`: fetches the published web addresses (read-only, manual only) and checks that
 * they answer and show the version the register states. The lock is not held while the pages are fetched; the write takes it afterwards.
 */
async function planDocWeb(json) {
  const adr = P.webAddresses(readPlans());
  const findings = [];
  for (const { doc, pub } of adr) findings.push(...P.assessWebAnswer(doc, pub, await getPage(pub.url)));
  if (!json) console.log(`Fetched ${adr.length} web address(es).`);
  docCheckAnswer(json, findings, ['web'], docWriteFindings(findings, ['web']));
}

/**
 * `plan modules [--link] [--dry] [--json]`: creates modules (config().modules) that are missing in `areas`;
 * existing ones are not changed. With --link, projects without a module get the proposal in config().projectModuleSuggestion (logged, undone
 * with queue.mjs undo). --dry shows what would have happened.
 */
function planModules(json) {
  const link = a.includes('--link');
  const perform = (queue) => {
    const plan = P.modulePlan(queue, { link });
    const error = [];
    for (const m of plan.newOnes) {
      const s = L.setArea(queue, m.oid, { title: m.title, description: m.description });
      error.push(...s.error);
    }
    for (const k of plan.link) {
      const reg = L.newRegister(queue.projects, { [k.pid]: { area: k.oid } }, queue.areas);
      if (reg.error.length) error.push(...reg.error);
      else queue.projects = reg.register;
    }
    return { ...plan, error };
  };
  const preview = perform(L.cloneJson(read()));
  if (preview.error.length) die(`Nothing changed:\n  ${preview.error.join('\n  ')}`);
  const empty = !preview.newOnes.length && !preview.link.length;
  const dry = a.includes('--dry');
  const r =
    dry || empty
      ? preview
      : editLogged('plan modules', (queue) => {
          const s = perform(queue);
          if (s.error.length) die(`Nothing changed:\n  ${s.error.join('\n  ')}`);
          return s;
        });
  if (json) {
    console.log(JSON.stringify({ ok: true, dry, newOnes: r.newOnes, exists: r.exists, link: r.link }));
    return;
  }
  const pre = dry ? 'Preview (nothing written): ' : '';
  console.log(
    `${pre}${r.newOnes.length ? `new areas: ${r.newOnes.map((m) => `${m.oid} (${m.title})`).join(', ')}` : 'all areas exist'}`,
  );
  if (r.exists.length)
    console.log(`Already exist (unchanged): ${r.exists.map((m) => m.oid).join(', ')}`);
  if (r.link.length)
    console.log(
      `${pre}projects linked to area: ${r.link.map((k) => `${k.pid} → ${k.oid}`).join(', ')}`,
    );
  if (!dry && !empty && undoHint()) console.log(undoHint());
  if (!link)
    console.log(
      'Projects are linked with cq plan modules --link (proposed) or cq project <pid> --area <oid>.',
    );
}

/**
 * The backup script for the plan register: config().planBackup (path relative to the project root or absolute), null = not
 * set up. QUEUE_PLAN_BACKUP overrides (tests).
 */
const SYNC = process.env.QUEUE_PLAN_BACKUP
  ? path.resolve(process.env.QUEUE_PLAN_BACKUP)
  : CONFIG.planBackup
    ? path.resolve(MAIN_TREE, CONFIG.planBackup)
    : null;
/**
 * `plan backup [--push] [--dry]`: runs the project's backup script (e.g. a script that copies the queue,
 * the plan register and the time log to a separate repo and commits there). The script gets QUEUE_ROOT = the project root and the flag
 * --push passed on. No automatic execution: propose it at the end of a session.
 */
function planBackup() {
  const push = a.includes('--push');
  if (!SYNC)
    die(
      'plan backup is not set up: set "planBackup" in queue.config.json to the path of a backup script (a node script ' +
        'that gets QUEUE_ROOT = the project root and, if any, --push), or QUEUE_PLAN_BACKUP.',
    );
  const name = path.basename(SYNC);
  if (!fs.existsSync(SYNC))
    die(`Could not find ${SYNC} (planBackup in queue.config.json, or QUEUE_PLAN_BACKUP).`);
  const args = [SYNC, ...(push ? ['--push'] : [])];
  if (a.includes('--dry')) {
    console.log(
      `Preview (nothing run): node ${args.join(' ')} in ${path.dirname(SYNC)}, source ${MAIN_TREE}`,
    );
    return;
  }
  const s = spawnSync(process.execPath, args, {
    cwd: path.dirname(SYNC),
    stdio: 'inherit',
    env: { ...process.env, QUEUE_ROOT: MAIN_TREE },
  });
  if (s.error) die(`${name} did not start: ${s.error.message}`);
  if (s.status !== 0)
    die(`${name} stopped (exit ${s.status}); see the output above.`, s.status ?? 1);
  console.log(
    push
      ? 'Backup done and pushed.'
      : 'Backup done (push with cq plan backup --push).',
  );
}

/**
 * `plan active [<PL-id> [--end] [--by "..."]] [--json]`: "Working now". With an id the cursor
 * { entry, at, by } is set in plans.json (pulse; the last one wins), with --end it is removed. The same lock and atomic writes as the
 * other plan commands, but no changelog (frequent pulses, nothing to undo) and `changed` is not bumped. Without an id
 * the entries under work now are listed (the cursor dies after queuePlan.ACTIVE_SESSION_HOURS hours without a pulse).
 */
function planActive(json) {
  const id = a[2] && !a[2].startsWith('--') ? a[2] : null;
  if (!id) {
    const activeOnes = P.activeEntries(readPlans());
    if (json) console.log(JSON.stringify({ ok: true, activeOnes }));
    else if (!Object.keys(activeOnes).length) console.log('No plan entries are under work now.');
    else
      for (const [pid, m] of Object.entries(activeOnes))
        console.log(`${pid.padEnd(16)} by ${m.by}, last pulse ${m.at}`);
    return;
  }
  const end = a.includes('--end');
  const r = withLock(() => {
    const reg = readPlans();
    const s = P.setActiveSession(reg, id, { by: byName(), end });
    if (s.error.length) planError(s.error);
    if (s.changed) writePlans(reg, { bump: false });
    return s;
  });
  if (json) console.log(JSON.stringify({ ok: true, entry: id, cursor: r.cursor, changed: r.changed }));
  else if (end)
    console.log(r.changed ? `${id}: the cursor is removed.` : `${id}: had no marker.`);
  else
    console.log(
      `${id}: under work (by ${r.cursor.by}, ${r.cursor.at}); end with cq plan active ${id} --end`,
    );
}

// ---- Documents and agreements -------------------------------------------------------------------
// `plan doc ...` writes to `documents` in plans.json with the same lock, --expect-changed, changelog and undo as
// the plan entries (editPlans). The logic (validation, versionSkew, revision, "What must be done") is in queuePlan.js.

/** One line in `plan doc show`. */
function docRow(d) {
  const miss = P.versionSkew(d).length ? ' MISS' : '';
  const nr = P.nextRevision(d);
  const rev = nr?.date
    ? `rev ${nr.date}${nr.overdue ? ' OVERDUE' : ''}`
    : nr?.event
      ? 'rev on event'
      : '';
  const ver = d.version
    ? `v${d.version}${d.current_version && d.current_version !== d.version ? ` (applies ${d.current_version})` : ''}`
    : '';
  const prob = (d.problems ?? []).length ? ` ${(d.problems ?? []).length} problem` : '';
  const fixedLine = `${d.id.padEnd(18)} ${String(d.status ?? '').padEnd(11)} ${String(d.audience ?? '').padEnd(10)} ${ver.padEnd(16)} `;
  return cut(`${fixedLine}${d.title}${rev ? `  [${rev}]` : ''}${prob}${miss}`, WIDTH);
}

/** Reads one document or a list from --file. */
function readDocFile() {
  const file = val('--file');
  if (!file) die('plan doc new --file <json> [--dry] [--json] [--set-by agent|owner]');
  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(content) ? content : [content];
}

function planDoc(json) {
  const under = a[2];
  const ctxFor = (queue, role) => ({
    role,
    by: byName(),
    question: queue.question ?? {},
    existsPath: existsSource,
  });
  if (under === 'show') {
    const reg = readPlans();
    const filter = {
      group: values('--group'),
      status: values('--status'),
      audience: values('--audience'),
      priority: values('--priority'),
      problems: a.includes('--problems'),
      search: val('--search') ?? null,
      all: a.includes('--all'),
    };
    for (const g of filter.group)
      if (!P.DOC_GROUPS.some((x) => x.id === g))
        die(`unknown group ${g} (${P.DOC_GROUPS.map((x) => x.id).join(', ')})`);
    for (const st of filter.status)
      if (!P.DOC_STATUSES.includes(st)) die(`unknown status ${st} (${P.DOC_STATUSES.join(', ')})`);
    const match = P.filterDoc(reg, filter);
    const must = P.docMustBeDone(reg.documents);
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          changed: reg.changed ?? null,
          documents: match.map((d) => ({
            ...d,
            miss: P.versionSkew(d),
            next_revision: P.nextRevision(d),
            reasons: P.docReasons(d),
          })),
          must_be_done: must,
          timeline: P.revisionTimeline(reg.documents, { days: 90 }),
        }),
      );
      return;
    }
    if (!reg.documents.length) {
      console.log(
        'The document register is empty. Add documents with: cq plan doc new --file <json>',
      );
      return;
    }
    if (must.length) {
      console.log('What must be done:');
      for (const m of must)
        console.log(
          cut(`  ${m.id.padEnd(18)} ${m.reasons.map((g) => g.text).join('; ')}`, WIDTH),
        );
    }
    for (const g of P.DOC_GROUPS) {
      const list = match.filter((d) => d.group === g.id);
      if (!list.length) continue;
      console.log(`\n${g.title} (${list.length})`);
      for (const d of list) console.log(`  ${docRow(d)}`);
    }
    console.log(`\n${match.length} of ${reg.documents.length} documents.`);
  } else if (under === 'get') {
    const id = a[3];
    if (!id || id.startsWith('--')) die('plan doc get <DOC-id> [--json]');
    const r = P.getDoc(readPlans(), readQueueForPlan(), id, { existsPath: existsSource });
    if (r.error.length) planError(r.error);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...r }));
      return;
    }
    const d = r.doc;
    console.log(`${d.id}: ${d.title}`);
    console.log(`Copy: ${r.copy}`);
    console.log(`  group ${d.group}, audience ${d.audience}, status ${d.status}`);
    console.log(
      `  version ${d.version ?? '-'}, current (accepted) ${d.current_version ?? '-'}`,
    );
    if (d.source)
      console.log(`  source ${d.source}${r.source_exists === false ? '  DOES NOT EXIST' : ''}`);
    for (const p of d.published ?? [])
      console.log(`  published ${p.where} ${p.version ?? ''} ${p.url ?? p.path ?? ''}`.trimEnd());
    if (d.priority)
      console.log(
        `  priority ${d.priority}${d.now_category?.length ? `/${d.now_category.join('+')}` : ''} (${d.priority_set_by}): ${d.priority_reason ?? ''}`,
      );
    if (r.next_revision?.date)
      console.log(
        `  next revision ${r.next_revision.date}${r.next_revision.overdue ? ' (OVERDUE)' : ` (in ${r.next_revision.days} days)`}`,
      );
    else if (r.next_revision?.event) console.log(`  revision ${r.next_revision.event}`);
    for (const rv of d.revisions ?? [])
      console.log(
        `  revised ${rv.date}${rv.version ? ` v${rv.version}` : ''}${rv.remark ? `: ${rv.remark}` : ''}`,
      );
    for (const g of r.miss) console.log(`  VERSION_SKEW: ${g.text}`);
    for (const p of d.problems ?? [])
      console.log(`  problem (${p.severity}): ${p.text}${p.source ? ` [${p.source}]` : ''}`);
    if (r.depends_on_docs.length)
      console.log(
        `  depended on by: ${r.depends_on_docs.map((x) => `${x.id} ${x.status ?? '?'}`).join(', ')}`,
      );
    if (r.used_by.length) console.log(`  used by: ${r.used_by.join(', ')}`);
    if (d.legal_points?.length)
      console.log(`  legal points: ${d.legal_points.join(', ')}`);
    if (r.planEntries.length)
      console.log(`  planEntries: ${r.planEntries.map((p) => p.id).join(', ')}`);
    for (const s of r.ownerQuestions)
      console.log(
        `  owner question ${s.id}${s.resolved ? ' (resolved)' : ''}${s.text ? `: ${cut(s.text, WIDTH - 20)}` : ''}`,
      );
    for (const g of r.reasons) console.log(`  MUST BE DONE: ${g.text}`);
  } else if (under === 'new') {
    const list = readDocFile();
    const role = planRole();
    const r = editPlans('plan doc new', (reg, queue) => {
      const error = [];
      const warnings = [];
      const newOnes = [];
      for (const input of list) {
        const s = P.newDoc(reg, input, ctxFor(queue, role));
        error.push(...s.error);
        warnings.push(...s.warnings);
        if (s.doc) newOnes.push(s.doc.id);
      }
      return { error, warnings, newOnes };
    });
    planAnswer(r, `${r.newOnes.length} new document(s): ${r.newOnes.join(', ')}`);
  } else if (under === 'edit') {
    const id = a[3];
    if (!id || id.startsWith('--'))
      die('plan doc edit <DOC-id> [--field name=val ...] [--set \'{"field":...}\'] [--dry] [--json]');
    const t = P.parseFieldArg(values('--field'));
    if (t.error.length) die(t.error.join('\n'));
    let field = t.field;
    if (val('--set') != null) {
      try {
        field = { ...field, ...JSON.parse(val('--set')) };
      } catch (e) {
        die(`--set is not valid JSON: ${e.message}`);
      }
    }
    if (!Object.keys(field).length) die("no field to edit (--field name=val or --set '{...}')");
    const role = planRole();
    const r = editPlans('plan doc edit', (reg, queue) =>
      P.editDoc(reg, id, field, ctxFor(queue, role)),
    );
    planAnswer(r, `Changed ${id}${r.boost ? ' (lifted to now/security by rule 1)' : ''}`);
  } else if (under === 'revise') {
    const id = a[3];
    if (!id || id.startsWith('--'))
      die(
        'plan doc revise <DOC-id> [--version v] [--date YYYY-MM-DD] [--remark "..."] [--dry] [--json]',
      );
    const role = planRole();
    const r = editPlans('plan doc revise', (reg, queue) =>
      P.reviseDoc(
        reg,
        id,
        {
          version: val('--version') ?? null,
          date: val('--date') ?? null,
          remark: val('--remark') ?? null,
          by: byName(),
        },
        ctxFor(queue, role),
      ),
    );
    planAnswer(r, `Revision registered for ${id}`);
  } else if (under === 'check') {
    planDocCheck(json);
  } else if (under === 'web') {
    planDocWeb(json).catch((e) => die(`plan doc web failed: ${e?.message ?? e}`));
  } else {
    die('Use: cq plan doc <show|get|new|edit|revise> ...  (see the top of the file)', under ? 1 : 0);
  }
}

function planCommand() {
  const under = a[1];
  const json = a.includes('--json');
  if (under === 'show') {
    const queue = readQueueForPlan();
    const reg = readPlans();
    const filter = {
      module: val('--module') ?? null,
      project: val('--project') ?? null,
      priority: values('--priority'),
      maturity: values('--maturity'),
      search: val('--search') ?? null,
      all: a.includes('--all'),
    };
    for (const p of filter.priority)
      if (!P.PRIORITIES.includes(p)) die(`unknown priority ${p} (${P.PRIORITIES.join(', ')})`);
    for (const m of filter.maturity)
      if (!P.MATURITIES.includes(m)) die(`unknown maturity ${m} (${P.MATURITIES.join(', ')})`);
    const entries = P.filterEntries(reg, queue, filter);
    const hidden =
      filter.all || filter.priority.includes('drop')
        ? 0
        : reg.entries.filter((p) => p.priority === 'drop').length;
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          changed: reg.changed ?? null,
          entries,
          hidden_drop: hidden,
          activeOnes: P.activeEntries(reg),
        }),
      );
      return;
    }
    if (!reg.entries.length) {
      console.log('The plan register is empty. Add entries with: cq plan new --file <json>');
      return;
    }
    let previous = null;
    for (const p of entries) {
      const group = `${p.module ?? '(without area)'} / ${p.project}`;
      if (group !== previous) console.log(`\n${group}`);
      previous = group;
      console.log(`  ${planRow(p)}`);
    }
    console.log(
      `\n${entries.length} of ${reg.entries.length} entries${hidden ? `; ${hidden} dropped are hidden (--all)` : ''}.`,
    );
  } else if (under === 'get') {
    const sortKey = a[2];
    if (!sortKey || sortKey.startsWith('--')) die('plan get <id|project|module> [--json]');
    const r = P.get(readPlans(), readQueueForPlan(), sortKey, { existsPath: existsSource });
    if (r.error.length) planError(r.error);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...r }));
      return;
    }
    console.log(
      `${r.type} ${r.sortKey}${r.title ? `: ${r.title}` : ''} (${r.entries.length} entries)`,
    );
    console.log(`Copy: ${r.copy}`);
    for (const p of r.entries) {
      console.log(`\n${planRow(p)}`);
      if (p.summary) console.log(`  ${p.summary}`);
      if (p.priority_reason)
        console.log(`  Priority (${p.priority_set_by}): ${p.priority_reason}`);
      if (p.drop_reason) console.log(`  Dropped: ${p.drop_reason}`);
      if (p.agent_boost)
        console.log(`  Lifted by agent ${p.agent_boost.at} (was ${p.agent_boost.from.priority})`);
      if (p.measured_rule && p.measured_rule.priority !== p.priority)
        console.log(
          `  Rule ${p.measured_rule.nr} (${p.measured_rule.name}) points to ${p.measured_rule.priority}: ${p.measured_rule.reason}`,
        );
      for (const k of p.sources)
        console.log(
          `  source ${k.path}${k.anchor ? ` ${k.anchor}` : ''}${k.role ? ` (${k.role})` : ''}${k.exists === false ? '  DOES NOT EXIST' : ''}`,
        );
      if (p.queue.length)
        console.log(`  queue: ${p.queue.map((o) => `${o.id} ${o.status ?? '?'}`).join(', ')}`);
      for (const s of p.ownerQuestion)
        console.log(
          `  owner question ${s.id}${s.resolved ? ' (resolved)' : ''}${s.text ? `: ${cut(s.text, WIDTH - 20)}` : ''}`,
        );
      if (p.depends_on?.length) console.log(`  depends on: ${p.depends_on.join(', ')}`);
      if (p.blocks.length) console.log(`  blocks: ${p.blocks.join(', ')}`);
      if (p.verified)
        console.log(
          `  verified ${p.verified.date} by ${p.verified.by}${p.verified.commit ? ` (${p.verified.commit})` : ''}: ${p.verified.findings}`,
        );
      if (p.legal) console.log(`  legal: ${cut(JSON.stringify(p.legal), WIDTH - 12)}`);
    }
  } else if (under === 'new') {
    const file = val('--file');
    if (!file) die('plan new --file <json> [--dry] [--json] [--set-by agent|owner]');
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(content) ? content : [content];
    const role = planRole();
    const r = editPlans('plan new', (reg, queue) => {
      const error = [];
      const warnings = [];
      const newOnes = [];
      for (const input of list) {
        const s = P.newEntry(reg, input, {
          role,
          projects: queue.projects ?? {},
          question: queue.question ?? {},
          existsPath: existsSource,
        });
        error.push(...s.error);
        warnings.push(...s.warnings);
        if (s.entry) newOnes.push(s.entry.id);
      }
      return { error, warnings, newOnes };
    });
    planAnswer(r, `${r.newOnes.length} new plan entr(ies): ${r.newOnes.join(', ')}`);
  } else if (under === 'edit') {
    const id = a[2];
    if (!id || id.startsWith('--'))
      die('plan edit <id> [--field name=val ...] [--set \'{"field":...}\'] [--dry] [--json]');
    const t = P.parseFieldArg(values('--field'));
    if (t.error.length) die(t.error.join('\n'));
    let field = t.field;
    if (val('--set') != null) {
      let s;
      try {
        s = JSON.parse(val('--set'));
      } catch (e) {
        die(`--set is not valid JSON: ${e.message}`);
      }
      field = { ...field, ...s };
    }
    if (!Object.keys(field).length) die("no field to edit (--field name=val or --set '{...}')");
    const role = planRole();
    const r = editPlans('plan edit', (reg, queue) =>
      P.editEntry(reg, id, field, {
        role,
        by: byName(),
        projects: queue.projects ?? {},
        question: queue.question ?? {},
        existsPath: existsSource,
      }),
    );
    planAnswer(
      r,
      `Changed ${id}${r.boost ? ' (lifted to now/security by rule 1; shown in the inbox)' : ''}`,
    );
  } else if (under === 'prioritize') {
    const pos = forFlag(2);
    const priority = pos.pop();
    if (!pos.length || !priority)
      die(
        'plan prioritize <id...> <now|owner|later|drop> [--category security for-prod important] [--reason "..."] [--dry] [--json]',
      );
    const role = planRole();
    const r = editPlans('plan prioritize', (reg, queue) =>
      P.prioritize(
        reg,
        pos,
        { priority, category: values('--category'), reason: val('--reason') ?? null },
        {
          role,
          by: byName(),
          projects: queue.projects ?? {},
          question: queue.question ?? {},
          existsPath: existsSource,
        },
      ),
    );
    planAnswer(
      r,
      `Priority ${priority}: ${r.changed.length} changed${r.unchanged.length ? `, ${r.unchanged.length} unchanged` : ''}` +
        `${r.boost.length ? `; lifted by rule 1: ${r.boost.join(', ')}` : ''}`,
    );
  } else if (under === 'prioritize-many') {
    // The whole draft from the priority map in one write (one lock, one changelog entry, one undo).
    const file = val('--file');
    if (!file)
      die(
        'plan prioritize-many --file <json> [--dry] [--expect-changed <iso>] [--set-by agent|owner] [--json]',
      );
    let list;
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      planError([`could not read ${file}: ${e.message}`], 1);
    }
    const role = planRole();
    const r = editPlans('plan prioritize-many', (reg, queue) =>
      P.prioritizeMany(reg, list, {
        role,
        by: byName(),
        projects: queue.projects ?? {},
        question: queue.question ?? {},
        existsPath: existsSource,
      }),
    );
    planAnswer(
      r,
      `Priorities: ${r.changed.length} changed${r.unchanged.length ? `, ${r.unchanged.length} unchanged` : ''}` +
        `${r.boost.length ? `; lifted by rule 1: ${r.boost.join(', ')}` : ''}`,
    );
  } else if (under === 'combine') {
    const pos = forFlag(2);
    const [to, ...from] = pos;
    if (!to || !from.length) die('plan combine <to-id> <from-id...> [--dry] [--json]');
    const r = editPlans('plan combine', (reg) => P.combineTogether(reg, to, from));
    planAnswer(r, `Combined ${from.join(', ')} into ${to} (the others are in the archive)`);
  } else if (under === 'verify') {
    const id = a[2];
    if (!id || id.startsWith('--') || val('--findings') == null)
      die('plan verify <id> --findings "..." [--commit <sha>] [--dry] [--json]');
    const commit =
      val('--commit') ?? (String(gitRead(['rev-parse', '--short', 'HEAD']) ?? '').trim() || null);
    const role = planRole();
    const r = editPlans('plan verify', (reg, queue) =>
      P.verify(
        reg,
        id,
        { findings: val('--findings'), commit, role },
        { projects: queue.projects ?? {}, question: queue.question ?? {}, existsPath: existsSource },
      ),
    );
    planAnswer(r, `Verified ${id}`);
  } else if (under === 'undo') {
    // Like `queue.mjs undo`, but for the plan register's own changelog.
    const textFor = (p) =>
      `no. ${p.nr} ${p.action} by ${p.by} ${p.at} (${p.changes.length} field(s))`;
    const nrError = (reg) => {
      if (val('--nr') == null) return null;
      const last = P.lastUndoable(reg);
      return last && String(last.nr) === String(val('--nr'))
        ? null
        : `the last change that can be undone is ${last ? `no. ${last.nr}` : 'none'}, not no. ${val('--nr')}; nothing undone`;
    };
    if (a.includes('--show')) {
      const reg = readPlans();
      const nf = nrError(reg);
      const s = nf ? { error: [nf], entry: P.lastUndoable(reg) } : P.undo(reg, { show: true });
      if (json)
        console.log(JSON.stringify({ ok: !s.error.length, error: s.error, entry: s.entry ?? null }));
      else {
        if (s.entry) console.log(`Last undoable: ${textFor(s.entry)}`);
        console.log(
          s.error.length
            ? `Can NOT be undone now:\n  ${s.error.join('\n  ')}`
            : 'Can be undone (cq plan undo).',
        );
      }
      return;
    }
    const r = withLock(() => {
      const reg = readPlans();
      const fe = P.expectCheck(reg, val('--expect-changed') ?? null);
      if (fe) planError([fe], fe.startsWith('invalid') ? 1 : 6);
      const nf = nrError(reg);
      const s = nf ? { error: [nf] } : P.undo(reg, { by: byName() });
      if (s.error.length) planError(s.error);
      writePlans(reg);
      return s;
    });
    if (json) console.log(JSON.stringify({ ok: true, entry: r.entry }));
    else {
      console.log(`Undone ${textFor(r.entry)}:`);
      for (const l of planDiffLines(
        r.entry.changes.map((e) => ({ ...e, before: e.after, after: e.before })),
      ))
        console.log(`  ${l}`);
    }
  } else if (under === 'active') {
    planActive(json);
  } else if (under === 'rules') {
    if (json) console.log(JSON.stringify({ ok: true, rules: P.PRIORITY_RULES }));
    else
      for (const r of P.PRIORITY_RULES)
        console.log(
          `${r.nr}. ${r.name} → ${r.priority}${r.categories.length ? `/${r.categories.join(' or ')}` : ''}: ${r.matches}`,
        );
  } else if (under === 'check') {
    planCheck(json);
  } else if (under === 'modules') {
    planModules(json);
  } else if (under === 'backup') {
    planBackup();
  } else if (under === 'doc') {
    planDoc(json);
  } else {
    die(
      'Use: cq plan <show|get|new|edit|prioritize|prioritize-many|combine|verify|undo|active|rules|check|modules|backup|doc> ...  (see the top of the file)',
      under ? 1 : 0,
    );
  }
}

function logTime(id, event, remark) {
  try {
    execFileSync(
      process.execPath,
      [
        path.join(HERE, 'log-time.mjs'),
        'queue',
        id,
        event,
        '--remark',
        remark,
      ],
      {
        stdio: 'ignore',
      },
    );
  } catch {
    /* the time log is an aid; the queue must not stop if it fails */
  }
}

/**
 * The highest migration number in config().migrations.folder (the first group in filePattern), or 0 when the migration flow is
 * off or the folder is missing. Used by init and next-migr.
 */
function highestMigr(root = MAIN_TREE) {
  if (!MIGR.folder) return 0;
  const dir = path.join(root, MIGR.folder);
  const pattern = new RegExp(MIGR.filePattern ?? String.raw`^(\d+)_.*\.sql$`);
  let max = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const f of fs.readdirSync(dir)) {
    const m = pattern.exec(f);
    if (m && Number.isSafeInteger(Number(m[1]))) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * The blocks that are taken (queueLogic.takenBlocks): the migration files in the main tree, the blocks of tasks that
 * are not finished, and the blocks in the prompt files (`prompt-*.md`) in the scratchpads of active tasks and in
 * `scratch`. A file that cannot be read is skipped (the error never stops a start). Empty without a migration flow.
 */
function takenForMigr(queue, { scratch = null, except = null } = {}) {
  if (!MIGR.folder) return [];
  const fileNrs = [];
  try {
    const pattern = new RegExp(MIGR.filePattern ?? '^(\\d+)_.*\\.sql$');
    for (const f of fs.readdirSync(path.join(GIT_ROOT, MIGR.folder))) {
      const m = pattern.exec(f);
      if (m && Number.isSafeInteger(Number(m[1]))) fileNrs.push(Number(m[1]));
    }
  } catch {
    // no migration folder yet: only the queue and the prompt files
  }
  const folders = new Set(
    [scratch, ...queue.tasks.filter((o) => !L.MIGR_FREE_STATUS.has(o.status)).map((o) => o.scratchpad)]
      .filter(Boolean)
      .map((m) => path.resolve(m)),
  );
  const prompts = [];
  for (const m of folders) {
    let names = [];
    try {
      names = fs.readdirSync(m).filter((f) => /^prompt-.+\.md$/.test(f));
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        prompts.push({ name: n, text: fs.readFileSync(path.join(m, n), 'utf8') });
      } catch {
        // locked or gone: skip
      }
    }
  }
  return L.takenBlocks({ tasks: queue.tasks, fileNrs, prompts, except });
}

/** "3450–3459 task A-1, 3460–3469 prompt-B.md" for the blocks a start skipped or a move hit. */
const blockList = (list) => [...new Set(list.map((h) => `${h.from}–${h.to} ${h.source}`))].join(', ');

/**
 * The load now for the load guard (queueLogic.loadGuard): free memory in percent. An error in the measurement gives
 * null, and null never stops. QUEUE_LOAD="free=<pct>" replaces the measurement (tests).
 * @returns {{ freeMemoryPct: number|null }}
 */
function measureLoad() {
  const env = process.env.QUEUE_LOAD;
  if (env) {
    const out = { freeMemoryPct: null };
    for (const part of env.split(',')) {
      const [k, v] = part.split('=').map((x) => x.trim());
      if (k === 'free' && v !== '' && Number.isFinite(Number(v))) out.freeMemoryPct = Number(v);
    }
    return out;
  }
  try {
    const total = os.totalmem();
    return { freeMemoryPct: total > 0 ? Math.round((os.freemem() / total) * 1000) / 10 : null };
  } catch {
    return { freeMemoryPct: null };
  }
}

const minutes = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000);

/**
 * Today's usage in USD (Norwegian day), only when a dailyBudget is set (otherwise the log is not read). If the log cannot
 * be read, the usage is unknown: that is reported on stderr (the budget guard then cannot kick in), and the number becomes 0.
 */
function dailyUsageFor(queue) {
  if (queue?.limits?.dailyBudget == null) return undefined;
  try {
    const rows = TK.readRows(fs.readFileSync(TIME_LOG, 'utf8'));
    return TK.dailyUsage(rows, TK.dayFor(new Date().toISOString()));
  } catch (e) {
    console.error(
      `WARNING: could not find the usage in ${TIME_LOG} (${e?.code ?? e?.message}); the budget guard assumes 0 USD today.`,
    );
    return 0;
  }
}

// ---- The orchestrator's routine as a script and cost per task ---------------------------------------------
// The agent transcripts: ~/.claude/projects/<repo-slug>/<session>/subagents/agent-<agent_id>.jsonl (the same source as
// hook-time.mjs). QUEUE_TRANSCRIPTS overrides (tests).
const TRANSCRIPTS =
  process.env.QUEUE_TRANSCRIPTS ??
  path.join(os.homedir(), '.claude', 'projects', MAIN_TREE.replace(/[^A-Za-z0-9]/g, '-'));
// As in hook-time.mjs: huge transcripts are not analyzed (the time log's last row is used instead).
const MAX_TRANSCRIPT = 300 * 1024 * 1024;

/** The path to the transcript for an agent, or null. */
function findTranscript(agentId) {
  let sessions;
  try {
    sessions = fs.readdirSync(TRANSCRIPTS, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const d of sessions) {
    const filePath = path.join(TRANSCRIPTS, d.name, 'subagents', `agent-${agentId}.jsonl`);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/** The transcript text, or null when the file is missing or too large. */
function readTranscript(filePath) {
  try {
    if (!filePath || fs.statSync(filePath).size > MAX_TRANSCRIPT) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** The rows in the time log (empty list when it cannot be read). */
function readTimeLog() {
  try {
    return TK.readRows(fs.readFileSync(TIME_LOG, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * The agents that belonged to the task, with the transcript when it exists: the certain ones from the time log, plus the uncertain ones (unknown
 * track label) when their mission mentions the task id (queueLogic.agentsForTask and mentionsTask).
 */
function taskAgents(o, to = new Date().toISOString()) {
  const from = o.started ?? o.picked_at ?? o.added_at ?? null;
  const { secure, uncertainOnes } = L.agentsForTask(readTimeLog(), o.id, { from, to });
  const out = [];
  for (const a of [...secure, ...uncertainOnes.map((x) => ({ ...x, uncertain: true }))]) {
    const filePath = findTranscript(a.agent);
    const text = readTranscript(filePath);
    // The reviewer's mission mentions the task only in the path "rev-<id>\reviewer-...", which mentionsTask does not see
    // (the hyphen before the id); timeCost.trackFromText knows the path.
    const firstMessage = text ? L.firstUserMessage(text) : null;
    const mentions =
      firstMessage != null &&
      (L.mentionsTask(firstMessage, o.id) ||
        TK.taskIdFor(TK.trackFromText(firstMessage) ?? '', (x) => x === o.id) === o.id);
    if (a.uncertain && !mentions) continue;
    out.push({ ...a, path: filePath, text });
  }
  return out;
}

/** The cost of the task (queueLogic.sumCost): the transcript when it exists, otherwise the last row in the time log. */
function measureCost(agents) {
  return L.sumCost(
    agents.map((a) => {
      if (a.text) {
        const t = TK.analyzeTranscript(a.text);
        return {
          agent: a.agent,
          type: a.type,
          tokens: t.tokens,
          model: t.model,
          turns: t.modelTurns,
          minutes: t.duration_s != null ? t.duration_s / 60 : null,
          // The reviewer's FINDINGS numbers per agent (the helper measurement, queueHelpers.helperStatistics).
          findings: L.REVIEWER_TYPES.includes(a.type) ? L.parseFindings(L.lastAnswer(a.text)) : null,
          source: 'transcript',
        };
      }
      return {
        agent: a.agent,
        type: a.type,
        tokens: a.row.tokens,
        model: a.row.model,
        turns: a.row.modelTurns,
        minutes: a.row.duration_s != null ? a.row.duration_s / 60 : null,
        source: 'timeLog',
      };
    }),
  );
}

/** The last answer from the last track agent (track or track-d), or null. */
function lastTrackReply(agents) {
  const track = agents
    .filter((a) => TK.isBuildAgent(a.type))
    .sort((x, y) => Date.parse(y.row.time) - Date.parse(x.row.time));
  for (const a of track) {
    const s = a.text ? L.lastAnswer(a.text) : null;
    if (s) return s;
  }
  return null;
}

/** Git with a large buffer (the diffs in the review package); null on error. `buffer: true` gives the bytes (git show of a file). */
function gitLarge(args, { buffer = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: GIT_ROOT,
      encoding: buffer ? 'buffer' : 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** The orchestrator's scratchpad: --scratchpad, otherwise QUEUE_SCRATCHPAD, otherwise `reserve` (saved on the task). */
function scratchpadFor(reserve = null) {
  const s = val('--scratchpad') ?? process.env.QUEUE_SCRATCHPAD ?? reserve;
  return s ? path.resolve(s) : null;
}

// ---- Adoption: deliveries without <task-notification> (a new session has adopted the tracks) ----
/** The scratchpad roots where the track folder can lie: the orchestrator's (--scratchpad/env) and the one saved on the task. */
const trackRoots = (o) => [scratchpadFor(), o?.scratchpad ?? null].filter(Boolean);

/** Active tasks (running, review; not picked) with a report.md that has not been received (queueLogic.assessDelivery). */
function findDeliveries(queue) {
  return queue.tasks
    .filter((o) => ['running', 'review'].includes(o.status) && !o.picked_by)
    .map((o) => L.assessDelivery(o, L.findTrackReport(o.id, trackRoots(o)).report))
    .filter(Boolean);
}

/**
 * Prints the delivery lines. With `update` (pulse) report_seen is saved for the new ones under the lock, so the same
 * report is only reported as new once. An error never stops the pulse.
 */
function deliveryWarning({ update = false } = {}) {
  try {
    const found = findDeliveries(read());
    for (const l of L.deliveryLines(found)) console.log(l);
    const fresh = found.filter((l) => l.new);
    if (update && fresh.length)
      edit((queue) => {
        for (const l of fresh) {
          const o = queue.tasks.find((x) => x.id === l.id);
          if (o) o.report_seen = Math.max(Number(o.report_seen ?? 0), l.mtimeMs);
        }
      });
    return found;
  } catch (e) {
    console.error(`(The delivery check failed: ${e?.message ?? e}; ${CQ} deliveries)`);
    return [];
  }
}

/**
 * Running tracks without an agent (queueLogic.startedWithoutAgent): no worktree has the branch and there is no report.
 * Read-only; `show`, `state` and `orchestrator pulse` use it, so the check also runs after every compaction (the
 * after-compact hook includes `show`). An error never stops the command it is attached to.
 */
function findWithoutAgent(queue) {
  try {
    const worktreeBranches = new Set(G.readWorktrees(gitRead).map((w) => w.branch).filter(Boolean));
    return L.startedWithoutAgent(queue, {
      worktreeBranches,
      hasReport: (o) => !!L.findTrackReport(o.id, trackRoots(o)).report,
    });
  } catch (e) {
    console.error(`(The agent check failed: ${e?.message ?? e})`);
    return [];
  }
}

/** The fields `start` and `fill` set (under the lock): status, branch and, if any, migration block. */
function markStarted(queue, o, { agent = null, head = null, scratchpad = null } = {}) {
  // Past blocks that are already taken (a file, a task that is not finished, an active prompt file).
  const t = L.assignStartBlock(queue, o, takenForMigr(queue, { scratch: scratchpad, except: o.id }), MIGR);
  if (t.skipped.length) console.error(`${o.id}: skipped taken blocks (${blockList(t.skipped)})`);
  o.status = 'running';
  o.started = new Date().toISOString();
  o.branch = branchFor(o.id);
  o.agent = agent ?? o.agent ?? null;
  o.migr_block = t.block;
  // HEAD on baseBranch at start (--wave-base for merge-track) and the scratchpad (receive finds the report there).
  if (head) o.head_start = head;
  if (scratchpad) o.scratchpad = scratchpad;
  return o;
}

/** The time log row for a start (the same for start and fill). */
function logStart(r) {
  logTime(
    r.id,
    'start',
    `class=${r.class} weight=${L.WEIGHT[r.class]} estimate=${L.estimate(r)} migr=${r.migr_block ?? 'none'} domain=${r.domain}`,
  );
}

/**
 * The track blocks (make-mission.mjs format) for running or picked tasks, with the warning about changes outside
 * the queue. Shared by `trackFile` and `fill`.
 */
function makeTrackBlocks(queue, idList) {
  // Have the owned files changed outside the queue since the task was added? Then the track block gets a warning, so the track
  // reads the diff before it builds on an outdated mission.
  const notices = G.externalForTasks(
    gitRead,
    idList
      .map((id) => queue.tasks.find((x) => x.id === id))
      .filter((o) => o && (o.status === 'running' || o.status === 'picked')),
  );
  const blocks = idList.map((id) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    if (o.status !== 'running' && o.status !== 'picked')
      die(
        `${id} is not started or picked (run \`start ${id}\` or \`pick ${id} --by ...\` first)`,
      );
    // The mission files (<dataFolder>/mission/) are gitignored and only exist in the main tree; someone who has picked the
    // task often runs this from their own worktree.
    const sourcePath = missionFile(o);
    const text = sourcePath ? fs.readFileSync(sourcePath, 'utf8') : o.mission;
    const block =
      o.migr_block ??
      (MIGR.folder
        ? 'none (the track must not have migrations; if it needs them, ask the orchestrator)'
        : 'none (the project has no migration flow)');
    // The block itself (ownership, the warning, owner answer and the mission) is shared with cloud-package.
    return [
      `=====${o.id}=====`,
      `TITLE: TRACK ${o.id} (${o.title})`,
      `BLOCK: ${block}`,
      `BRANCH: ${o.branch}`,
      '',
      L.trackBlock(o, queue, { text, warning: notices.get(o.id)?.warning ?? null }),
    ].join('\n');
  });
  const withWarning = [...notices].filter(([, v]) => v.warning).map(([id]) => id);
  return { blocks, withWarning };
}

/**
 * The measurement at `set done` and `cost measure`: the cost, the findings (the reviewers' FINDINGS lines, or --findings) and
 * the RESULT line (when it was not saved by `receive`; --result overrides).
 */
function measureTask(o) {
  const agents = taskAgents(o);
  const cost = measureCost(agents);
  const findingsFlag = values('--findings');
  const findings = findingsFlag.length
    ? L.batchFindings(findingsFlag.map((f) => L.parseFindings(f)))
    : L.batchFindings(
        agents
          .filter((x) => L.REVIEWER_TYPES.includes(x.type) && x.text)
          .map((x) => L.parseFindings(L.lastAnswer(x.text))),
      );
  const resultText = val('--result') ?? (o.result ? null : lastTrackReply(agents));
  return { cost, findings, result: resultText ? L.parseResult(resultText) : null };
}

/**
 * The reviewers' FINDINGS lines for the task (the last answer in each reviewer transcript), for `--findings` when `merge`
 * calls `set done`. Empty list when no reviewer has a FINDINGS line (the field is then left out, without error).
 */
function reviewerFindingsLines(o) {
  return taskAgents(o)
    .filter((x) => L.REVIEWER_TYPES.includes(x.type) && x.text)
    .map((x) => L.parseFindings(L.lastAnswer(x.text)))
    .filter(Boolean)
    .map((f) => f.line);
}

function saveMeasurement(o, m) {
  o.cost = m.cost;
  if (m.findings) o.findings = m.findings;
  if (m.result) o.result = m.result;
}

/** "Cost X: $12.3 (3 agent(s), 25.1 mill. tokens, 140 turns) · findings H=0 M=1 L=2 (1 report(s))". */
function measurementLine(o) {
  const k = o.cost;
  const mill = (k.tokens.sum / 1e6).toFixed(1);
  return (
    `Cost ${o.id}: $${k.usd} (${k.agents.length} agent(s), ${mill} mill. tokens, ${k.turns} turns)` +
    (o.findings
      ? ` · findings H=${o.findings.H} M=${o.findings.M} L=${o.findings.L} (${o.findings.reports} report(s))`
      : ' · no FINDINGS line found') +
    (o.result ? ` · RESULT ${o.result.status ?? '?'}` : '')
  );
}

/** "7d", "24h", "90m" or a date/ISO time -> ISO time; null when nothing is given. */
function sinceTime(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+)\s*([dhm])$/i);
  if (m) {
    const ms = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2].toLowerCase()];
    return new Date(Date.now() - Number(m[1]) * ms).toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) die(`Unknown time "${s}" (use e.g. 7d, 24h or 2026-10-01).`);
  return new Date(t).toISOString();
}

// ---- Commands ----------------------------------------------------------------------------------------------
if (command === 'init') {
  // Creates the data folder and an empty queue with defaultLimits and the example project "example" (prefix EX-). An existing
  // queue is never touched, so init is safe to run several times.
  fs.mkdirSync(FOLDER, { recursive: true });
  if (fs.existsSync(FILE)) {
    console.log(`The queue already exists: ${FILE} (nothing changed).`);
    process.exit(0);
  }
  const queue = {
    created: new Date().toISOString(),
    limits: {
      maxConcurrent: Number(val('--max-concurrent') ?? L.DEFAULT_LIMITS.maxConcurrent),
      maxDPlus: Number(val('--max-dplus') ?? L.DEFAULT_LIMITS.maxDPlus),
      maxPerDomain: Number(val('--max-per-domain') ?? L.DEFAULT_LIMITS.maxPerDomain),
    },
    resolved: [],
    projects: {
      example: {
        title: 'Example',
        prefixes: ['EX-'],
      },
    },
    tasks: [],
  };
  // Migration blocks only when the migration flow is enabled (config().migrations.folder).
  if (MIGR.folder) queue.next_migr = Number(val('--next-migr') ?? highestMigr() + 1);
  else if (val('--next-migr') != null)
    console.log('Note: --next-migr is ignored; the migration flow is off (migrations.folder in queue.config.json).');
  withLock(() => write(queue));
  console.log(
    `The queue is created: ${FILE}` +
      (queue.next_migr != null ? ` (next migration block from ${queue.next_migr})` : '') +
      '. The example project "example" (prefix EX-) can be renamed with cq project.',
  );
} else if (command === 'add') {
  const source = val('--file') ? fs.readFileSync(val('--file'), 'utf8') : val('--json');
  if (!source) die("add requires --file <task.json> or --json '{...}'");
  let content;
  try {
    content = JSON.parse(source);
  } catch (e) {
    die(`add: the task is not valid JSON (${e.message}). On Windows, write it to a file and use --file.`);
  }
  // { "tasks": [...], "question": {...} } adds tasks and the text of the questions they wait on in
  // the same write. An object without an id with one of these fields is that form; otherwise it is one task (as before).
  const combined =
    content &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    content.id === undefined &&
    ('tasks' in content || 'question' in content);
  const newOnes = combined ? [].concat(content.tasks ?? []) : [].concat(content);
  const newQuestion = combined ? (content.question ?? {}) : {};
  if (combined && !newOnes.length && !Object.keys(newQuestion ?? {}).length)
    die('Nothing to add (both tasks and question are empty).');
  const approved = a.includes('--approved');
  // --plan <id> links tasks (that do not have their own `plan`) to a plan entry. Set in the file or with --plan:
  // the plan entry must exist in the plan register (an unknown or merged entry is refused), and the entry becomes in-queue automatically.
  const planArg = a.includes('--plan') ? val('--plan') : null;
  if (a.includes('--plan') && (!planArg || planArg.startsWith('--')))
    die('--plan requires a plan entry id (cq plan show)');
  const added = edit((queue) => {
    const error = [];
    let planWarnings = [];
    if (planArg || newOnes.some((n) => n?.plan != null)) {
      // Under the same lock as the queue, so the register does not change between the check and the write.
      const k = P.linkPlan(readPlans(), newOnes, planArg);
      error.push(...k.error);
      planWarnings = k.warnings;
      newOnes.splice(0, newOnes.length, ...k.tasks);
    }
    // The questions are validated together with the tasks: all or nothing.
    const sp = L.setQuestion(queue, newQuestion);
    error.push(...sp.error.map((f) => `question ${f}`));
    for (const n of newOnes) {
      // validate also checks that the id does not already exist in the queue, and (when the register has projects) that an
      // explicit project exists.
      const f = L.validate(n, queue.tasks, queue.projects);
      if (f.length) error.push(`${n.id ?? '(without id)'}: ${f.join('; ')}`);
    }
    if (new Set(newOnes.map((n) => n.id)).size !== newOnes.length)
      error.push('the same id twice in what is being added');
    // Every waiting_on id must be a registered question (text and type), from before or in the same file
    // (setQuestion above has added them to queue.question; nothing is written when error is not empty). Free text is rejected.
    if (!sp.error.length)
      for (const n of newOnes) {
        const f = L.waitingOnError(n, queue);
        if (f.length) error.push(`${n.id ?? '(without id)'}: ${f.join('; ')}`);
      }
    // The batch queue rules against the queue as it will be (the new ones can depend on each other).
    const after = [...queue.tasks, ...newOnes.map((n) => ({ status: 'waiting', ...n }))];
    for (const n of newOnes) {
      const f = L.batchedError({ status: 'waiting', ...n }, after, queue.resolved);
      if (f.length) error.push(`${n.id ?? '(without id)'}: ${f.join('; ')}`);
      // The small-task guard (fix now, batch queue, or ask the owner about the priority).
      const s = L.smallTaskError({ status: 'waiting', ...n }, after, queue.resolved);
      if (s.length) error.push(`${n.id ?? '(without id)'}: ${s.join('; ')}`);
    }
    if (error.length) die(`Nothing added:\n  ${error.join('\n  ')}`);
    const result = [];
    for (const n of newOnes) {
      // An agent (track, reviewer, fold/investigation agent) adds proposals, not work that starts by itself.
      // The status is computed against the queue BEFORE the new ones are added (a new task cannot make another one an agent source).
      const status = L.statusAtAdd(n, queue.tasks, { approved });
      result.push({ id: n.id, status });
      queue.tasks.push({
        value: 5,
        content_min: 30,
        migr_tens: 0,
        depends_on: [],
        waiting_on: [],
        owned_files: [],
        owner_db: [],
        shared_patch: [],
        ...n,
        status,
        added_at: new Date().toISOString(),
      });
    }
    // New tasks must have a project and a feature. If they lack them, that is reported now, not when a later fill stops
    // on them.
    const ids = new Set(newOnes.map((n) => n.id));
    const missing = L.missingProject(
      queue.tasks.filter((o) => ids.has(o.id)),
      queue.projects,
    );
    // A question without text cannot be shown in "Waiting on you" with something the owner can answer.
    const withoutText = L.questionWithoutText(newOnes, queue);
    // Project proposals (longest prefix, plan, fileRoot) and disagreement with an explicit project.
    const projectWarnings = L.addProjectWarnings(newOnes, queue.projects);
    // A project in phase plan has no queue tasks; if it gets tasks now, the phase is removed in the same write.
    const phaseEnded = P.phasePlanEnds(queue.projects, newOnes);
    for (const pid of phaseEnded) {
      const rest = { ...queue.projects[pid] };
      delete rest.phase;
      queue.projects[pid] = rest;
    }
    return {
      result,
      missing,
      question: sp.set,
      withoutText,
      projectWarnings,
      planWarnings,
      phaseEnded,
    };
  });
  const waiting = added.result.filter((r) => r.status === 'waiting').map((r) => r.id);
  const proposed = added.result.filter((r) => r.status === 'proposed').map((r) => r.id);
  if (waiting.length) console.log(`Added: ${waiting.join(', ')}`);
  if (proposed.length)
    console.log(
      `Added as proposed (not started until the orchestrator or the owner approves: cq approve <id...>): ${proposed.join(', ')}`,
    );
  const { withoutProject, withoutFeature } = added.missing;
  if (withoutProject.length || withoutFeature.length)
    console.log(
      `WARNING: ${[
        withoutProject.length
          ? `without project (ends up in ${L.WITHOUT_PROJECT}): ${withoutProject.join(', ')}`
          : null,
        withoutFeature.length ? `without feature: ${withoutFeature.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join(
          '; ',
        )}. Fix with cq edit-many --file <json> ([{ "id": "...", "project": "...", "feature": "..." }]).`,
    );
  for (const x of added.projectWarnings) console.log(`WARNING: ${x}`);
  for (const x of added.planWarnings) console.log(`WARNING: ${x}`);
  const linked = [...new Set(newOnes.map((n) => n?.plan).filter(Boolean))];
  if (linked.length) console.log(`Linked to plan entry: ${linked.join(', ')} (in-queue automatically)`);
  if (added.phaseEnded.length)
    console.log(`Phase plan removed (has queue tasks now): ${added.phaseEnded.join(', ')}`);
  if (added.question.length) console.log(`Question text set: ${added.question.join(', ')}`);
  if (added.withoutText.length)
    console.log(
      `WARNING: question without text (shown without text in "Waiting on you"): ${added.withoutText.join(', ')}. ` +
        'Add them in "question" in the add file, or: cq question <id> --text "..." --type <type>.',
    );
} else if (
  command === 'show' &&
  !['--full', '--all', '--grouped', '--project'].some((f) => a.includes(f))
) {
  // The short view by default (active ones, startable and counts, under about 3,000 chars); the full table was
  // about 66,000 chars (about 20,000 tokens per call). `--summary` is also accepted. The full one: `show --full`.
  const queue = read();
  // First, so it survives when the after-compact hook trims the show output.
  const withoutAgent = L.withoutAgentLines(findWithoutAgent(queue));
  if (withoutAgent.length) console.log(`${withoutAgent.join('\n')}\n`);
  for (const l of L.summaryView(queue, {
    uncommitted: uncommittedPaths(),
    dailyUsage: dailyUsageFor(queue),
    width: WIDTH,
    cursor: readCursor(),
    load: measureLoad(),
  }))
    console.log(l);
  // Loose waits (free text or an unregistered question, or an answer that still blocks).
  for (const l of L.resolveWaitsLines(L.resolveWaits(queue), { max: 5 })) console.log(l);
  // Follow up: the active entries and TO REPORT. The resume text after a compaction has this view, so due entries are
  // mentioned there too (hook-after-compact.mjs runs queue.mjs show).
  for (const l of followLines()) console.log(l);
} else if (command === 'show') {
  const queue = read();
  const all = a.includes('--all');
  const register = queue.projects ?? {};
  const pid = val('--project');
  const inProject = (o) => !pid || L.projectFor(o, register) === pid;
  const uncommitted = uncommittedPaths();
  // Shared ranking (focusStep, then score); parked and the blockers "outside focus"/"parked" from the same source.
  const rk = L.rankingContext(queue);
  // A pending task without other blockers that owns an uncommitted file is skipped by `next`; say why.
  const blockersFor = (o) => {
    const h = L.blockersWithPause(o, queue, rk);
    const u = h.length ? null : L.uncommittedCollision(o, uncommitted);
    return u ? [`file ${u.path} is uncommitted in the main tree`] : h;
  };
  const withStep = rk.applies || queue.tasks.some((o) => L.parkedNow(o, rk.now));
  const rows = queue.tasks
    .filter((o) => o.status !== 'proposed' && !L.isExternalRow(o) && !L.inBatchQueue(o))
    .filter((o) => all || !['done', 'cancelled'].includes(o.status))
    .filter(inProject)
    .map((o) => {
      const r = o.status === 'waiting' ? L.ranking(o, queue, rk) : null;
      return { o, r, s: r ? r.score : null, h: o.status === 'waiting' ? blockersFor(o) : [] };
    })
    // As before: pending ones by priority at the top, then the rest (running, picked, review, done) in queue order. With focus
    // or parked, the pending ones are sorted by stage first (parked last among them).
    .sort(
      (x, y) =>
        (withStep ? (x.r?.stage ?? 3e6) - (y.r?.stage ?? 3e6) : 0) || (y.s ?? -1) - (x.s ?? -1),
    );
  const under = (text, indent) => {
    console.log(`${' '.repeat(indent)}↳ ${cut(text, WIDTH - indent - 2)}`);
  };
  // First, so it survives when the after-compact hook trims the show output.
  const withoutAgent = L.withoutAgentLines(findWithoutAgent(queue));
  if (withoutAgent.length) console.log(`${withoutAgent.join('\n')}\n`);
  if (a.includes('--grouped')) {
    // Tree: project -> feature -> tasks, narrow enough for a narrow terminal window.
    for (const p of L.groups(
      rows.map((r) => r.o),
      register,
    )) {
      const header = `${p.pid}${p.title ? `  ${p.title}` : ''}${p.pause ? '  [PAUSE]' : ''}`;
      console.log(cut(header, WIDTH));
      for (const f of p.features) {
        console.log(`  ${cut(f.feature, WIDTH - 2)}`);
        for (const o of f.tasks) {
          const r = rows.find((x) => x.o === o);
          const col = `    ${o.id.padEnd(12)} ${o.status.padEnd(8)} ${o.class.padEnd(2)} ${`${L.estimate(o)}m`.padEnd(5)} `;
          console.log(col + cut(o.title, WIDTH - col.length));
          if (o.status === 'picked') under(pickLine(o), 6);
          else if (r.h.length) under(r.h.join(' · '), 6);
        }
      }
    }
  } else {
    for (const { o, s, h, r } of rows) {
      const col = [
        o.id.padEnd(12),
        o.status.padEnd(9),
        o.class.padEnd(3),
        o.domain.padEnd(14),
        `${L.estimate(o)} min`.padEnd(8),
        s == null ? '        ' : String(s).padEnd(8),
        // The stage (T2 ..., rest) only when focus applies, so the table is otherwise as before.
        ...(rk.applies
          ? [(r ? (r.parked ? 'parked' : L.stepText(r).split(' ')[0]) : '').padEnd(7)]
          : []),
        o.title,
      ];
      console.log(col.join(' '));
      if (o.status === 'picked') console.log(`${' '.repeat(13)}↳ ${pickLine(o)}`);
      else if (h.length) console.log(`${' '.repeat(13)}↳ ${h.join(' · ')}`);
      if (r?.dragged_by) console.log(`${' '.repeat(13)}↳ dragged along by ${r.dragged_by} (in focus)`);
    }
  }
  // Proposals separately: they do not start until they are approved.
  const proposed = queue.tasks
    .filter((o) => o.status === 'proposed' && !L.inBatchQueue(o))
    .filter(inProject);
  if (proposed.length) {
    console.log(
      `\nSUGGESTION (${proposed.length}, not started until they are approved: cq approve <id...>):`,
    );
    for (const o of proposed.sort((x, y) => Number(y.value ?? 5) - Number(x.value ?? 5))) {
      console.log(
        [
          o.id.padEnd(12),
          o.class.padEnd(3),
          o.domain.padEnd(14),
          `${L.estimate(o)} min`.padEnd(8),
          `value ${o.value ?? 5}`.padEnd(9),
          `from ${o.added_by ?? '?'}`.padEnd(16),
          o.title,
        ].join(' '),
      );
    }
  }
  // The batch queue separately (not started alone; packed with queue.mjs batch pack).
  const batchGr = L.batchGroups(queue).filter((g) => !pid || g.pid === pid);
  if (batchGr.length) {
    const n = batchGr.reduce((s, g) => s + g.count, 0);
    const readyOnes = batchGr.filter((g) => g.ready).length;
    console.log(
      `\nBATCH_QUEUE (${n} task(s) in ${batchGr.length} group(s)${readyOnes ? `, ${readyOnes} ready for packing` : ''}; ` +
        'not started alone, see cq batch):',
    );
    for (const g of batchGr) console.log(cut(`  ${batchGroupLine(g)}`, WIDTH));
  }
  // Work registered outside the queue (external add) separately; it owns files, but is not work in the queue.
  const registered = queue.tasks.filter((o) => L.isExternalRow(o) && o.status === 'external');
  if (registered.length) {
    console.log(
      `\nOUTSIDE QUEUE (${registered.length}, registered with external add; owns the files until cq external done "<name>"):`,
    );
    for (const o of registered) {
      const age = o.added_at ? L.ageText(Date.now() - Date.parse(o.added_at)) : '?';
      const owner = [...(o.owned_files ?? []), ...(o.owner_db ?? [])].join(', ');
      console.log(
        cut(
          `${o.id.padEnd(24)} "${o.external_name}" ${age} ago · ${owner}${o.branch ? ` · branch ${o.branch}` : ''}`,
          WIDTH,
        ),
      );
    }
  }
  const usage = dailyUsageFor(queue);
  const t = L.state(queue, usage, { uncommitted, cursor: readCursor(), load: measureLoad() });
  console.log(`\n${L.stateLine(t)}`);
  if (t.focus)
    console.log(cut(`FOCUS${t.focus.name ? ` "${t.focus.name}"` : ''}: ${t.focus.text}`, WIDTH));
  if (t.focus?.notice) console.log(`NOTICE: ${t.focus.notice}`);
  const b = L.budgetGuard(queue, usage);
  if (b.active) console.log(b.message);
  const n = L.nightGuard(queue);
  if (n.active) console.log(n.message);
  // Loose waits (free text or an unregistered question, or an answer that still blocks).
  for (const l of L.resolveWaitsLines(L.resolveWaits(queue), { max: 50 })) console.log(l);
  for (const l of followLines()) console.log(l);
} else if (command === 'next') {
  const queue = read();
  // Budget guard: over the daily budget nothing is proposed (exit 4, so a loop does not take it for "empty queue").
  // Night guard: nightRun off and inside the night window gives exit 5 for the same reason.
  // Wind-down guard: the orchestrator in windDown (hook-context, about 350k) gives exit 6.
  // Load guard: the machine is full gives exit 7.
  const usage = dailyUsageFor(queue);
  const guard = L.startGuard(queue, usage, { cursor: readCursor(), load: measureLoad() });
  if (guard) die(guard.message, guard.code);
  const b = L.budgetGuard(queue, usage);
  // Tasks that own an uncommitted file in the main tree are skipped (another session is working in the file).
  const uncommitted = uncommittedPaths();
  const selected = L.selectNext(queue, Date.now(), { uncommitted });
  if (!selected.length) console.log('Nothing can start now (see `show` and `state`).');
  for (const v of selected)
    console.log(
      `${v.id.padEnd(12)} ${v.class.padEnd(3)} ${v.domain.padEnd(14)} ${v.estimate} min  priority ${v.score}` +
        (v.project !== L.WITHOUT_PROJECT ? `  (${v.project})` : '') +
        ('step' in v ? `  ${L.stepText(v)}` : ''),
    );
  // Warning when the focus period is over or the focus has nothing ready.
  const focusSt = L.focusStatus(queue, { canStart: selected.map((v) => v.id) });
  if (focusSt?.notice) console.log(`NOTICE: ${focusSt.notice}`);
  const skipped = L.uncommittedSkipped(queue, uncommitted);
  if (skipped.length) {
    console.log(
      `Skipped ${skipped.length} (owned file uncommitted in the main tree; another session is working in it):`,
    );
    for (const h of skipped.slice(0, 10)) console.log(`  ${h.id.padEnd(12)} file ${h.path}`);
    if (skipped.length > 10) console.log(`  ... and ${skipped.length - 10} more`);
    console.log(
      '  Wait, ask the session to commit or register itself (cq external add), or start --force on the owner\'s word.',
    );
  }
  if (b.active) console.log(b.message);
} else if (command === 'start') {
  const id = a[1];
  if (!id) die('start <id>');
  // The usage is read before the lock (the log is large enough that this should not happen with the queue file locked). The same applies to
  // git status (uncommitted files in the main tree).
  const usage = dailyUsageFor(read());
  const uncommitted = uncommittedPaths();
  const load = a.includes('--force') ? null : measureLoad();
  const r = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    const h = L.blockers(o, queue.tasks, queue.resolved);
    if (h.length) die(`${id} cannot be started: ${h.join(' · ')}`);
    // Budget guard (exit 4), night guard (exit 5) and load guard (exit 7): --force (the owner's word) overrides, as
    // for the other limits.
    const guard = L.startGuard(queue, usage, {
      force: a.includes('--force'),
      cursor: readCursor(),
      load,
    });
    if (guard) die(guard.message, guard.code);
    // --force: the owner has asked for the task to go first. Overrides only the priority order in selectNext and
    // the pause on the project, never the blockers above (dependencies, ownership, owner questions).
    if (
      !a.includes('--force') &&
      !L.selectNext(queue, Date.now(), { uncommitted }).some((v) => v.id === id)
    ) {
      const register = queue.projects ?? {};
      // Parked and outside focus (rest waiting) stop like a pause; --force (the owner's word) overrides.
      const space = L.focusSpace(o, L.rankingContext(queue));
      if (space.parked)
        die(`${id} cannot be started: ${space.reason}. Or start --force on the owner's word.`);
      if (L.projectPaused(o, register)) {
        const pid = L.projectFor(o, register);
        die(
          `${id} belongs to the project ${pid}, which is paused (cq project ${pid} --continue, or start --force).`,
        );
      }
      if (space.out)
        die(
          `${id} cannot be started: ${space.reason}. Edit the focus (cq focus set ...), or start --force on the owner's word.`,
        );
      const u = L.uncommittedCollision(o, uncommitted);
      if (u)
        die(
          `${id} cannot be started: file ${u.path} is uncommitted in the main tree (another session is working in it). Wait, ask the session ` +
            'to commit or register itself (cq external add), or start --force on the owner\'s word.',
        );
      die(
        `${id} is not among those that can start now (the limits for concurrent, D+ or domain are reached). See \`next\`.`,
      );
    }
    return markStarted(queue, o, {
      agent: val('--agent'),
      head: git(['rev-parse', BASE]),
      scratchpad: scratchpadFor(),
    });
  });
  logStart(r);
  console.log(
    `Started ${id}: branch ${r.branch}${r.migr_block ? `, migration block ${r.migr_block}` : ''}, estimate ${L.estimate(r)} min.`,
  );
  // Thinking level by class: K and U on `track` (medium), D and D+ on `track-d` (high).
  console.log(
    L.agentTypeFor(r.class) === 'track-d'
      ? `Agent: subagent_type ${require('./lib/projectRoot.js').agentRef('track-d')} (thinkingLevel high).`
      : `Agent: subagent_type ${require('./lib/projectRoot.js').agentRef('track')} (thinkingLevel medium).`,
  );
  // Only the orchestrator starts tasks: the cursor says it is active.
  pulseCursor(`start ${id}`);
  writeExternalWarning(r);
} else if (command === 'set') {
  const [, id, status] = a;
  if (!id || !status) die('set <id> <status>');
  let qa = false;
  // The orchestrator cursor is updated when the queue's own tasks are moved; not for a picked task (whoever
  // picked it can set it done themselves) or a registration outside the queue.
  let orchestratorStep = false;
  // On `done` the cost is measured (the agents' usage from the transcripts) and the findings from the reviewers'
  // FINDINGS line (or --findings "FINDINGS H=... M=... L=...", repeatable), and the RESULT line is fetched when `receive` did not take it.
  // The reading happens before the lock; if it fails, the task is set done anyway (the measurement never stops the queue).
  let measurement = null;
  if (status === 'done' && !a.includes('--without-cost')) {
    try {
      const o = read().tasks.find((x) => x.id === id);
      if (o && !L.isExternalRow(o)) measurement = measureTask(o);
    } catch (e) {
      console.error(
        `WARNING: could not measure the cost for ${id} (${e?.message ?? e}); set done without it.`,
      );
    }
  }
  const r = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    orchestratorStep = !o.picked_by && !L.isExternalRow(o);
    const now = new Date().toISOString();
    // setStatus: delivered/done time, qa_status "waiting" for a visual task that becomes done, and the pick fields
    // are removed when a picked task is set back to waiting.
    const s = L.setStatus(o, status, now);
    if (s.error) die(s.error);
    qa = s.qa;
    if (val('--remark')) o.remarks = [...(o.remarks ?? []), `${now} ${val('--remark')}`];
    if (measurement) saveMeasurement(o, measurement);
    if (status === 'done' || status === 'cancelled') autoCleanFocus(queue, `set ${id} ${status}`);
    return o;
  });
  if (measurement) console.log(measurementLine(r));
  if (status === 'review' && r.started)
    logTime(id, 'delivered', `${minutes(r.started, r.delivered)} min to delivery`);
  if (status === 'done' && r.started) {
    logTime(
      id,
      'done',
      `${minutes(r.started, r.done)} min total${r.delivered ? `, ${minutes(r.delivered, r.done)} min review/merge` : ''}; ${val('--remark') ?? ''}`,
    );
  }
  console.log(
    `${id}: ${status}${qa ? ' · label visual: now in the owner QA list (cq qa)' : ''}`,
  );
  focusCleanOut();
  if (orchestratorStep) pulseCursor(`set ${id} ${status}`);
} else if (command === 'cancel') {
  // Cancel (or decline) one waiting or proposed task, logged so `undo` can put it back (lib/queueTaskEdit.js).
  const TE = require('./lib/queueTaskEdit.js');
  const [, id] = a;
  if (!id || id.startsWith('--')) die('cancel <id> [--remark "..."] [--by "..."] [--expect-changed <iso>] [--json]');
  const json = a.includes('--json');
  const remark = val('--remark') ?? null;
  editLogged('cancel', (queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    const r = TE.cancelTask(o, { remark, now: new Date().toISOString() });
    if (r.error) {
      if (!json) die(`Not cancelled: ${o ? r.error : `unknown task ${id}`}`);
      console.log(JSON.stringify({ ok: false, error: [o ? r.error : `unknown task ${id}`] }));
      if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
      process.exit(1);
    }
    autoCleanFocus(queue, `cancel ${id}`);
  });
  if (json) console.log(JSON.stringify({ ok: true, id, log: lastEntry?.nr ?? null }));
  else {
    console.log(`${id}: cancelled`);
    focusCleanOut();
    if (undoHint()) console.log(undoHint());
  }
} else if (command === 'edit') {
  const [, id] = a;
  const field = JSON.parse(val('--json') ?? '{}');
  // --bonus "<text>" adds text to the mission (the track block) and the remarks, with a timestamp.
  const bonus = a.includes('--bonus') ? (val('--bonus') ?? '') : null;
  if (bonus != null && !String(bonus).trim())
    die('edit <id> --bonus "<text>": the addition is empty.');
  // The fields bonus and remarks are only kept by --bonus (and set --remark).
  delete field.bonus;
  // Status fields and the pick fields are only changed with their own commands (set, pick, deliver, release).
  for (const f of [
    'id',
    'status',
    'added_at',
    'started',
    'done',
    'branch',
    'migr_block',
    'picked_by',
    'picked_at',
    // A registration outside the queue never becomes a task, and vice versa.
    'external',
    'external_name',
    'done_outside_queue',
  ])
    delete field[f];
  editLogged('edit', (queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    const fresh = { ...o, ...field };
    const f = L.validate(
      fresh,
      queue.tasks.filter((x) => x.id !== id),
      queue.projects,
    );
    // Batched (into or out of the batch queue) and depends_on against a task in the batch queue.
    f.push(
      ...L.batchedError(
        fresh,
        queue.tasks.map((x) => (x.id === id ? fresh : x)),
        queue.resolved,
      ),
    );
    // A new waiting_on id must be a registered question (queue.mjs question <id> --text ... first).
    f.push(...L.waitingOnError(fresh, queue, { earlier: o.waiting_on ?? [] }));
    if (f.length) die(`Invalid change: ${f.join('; ')}`);
    Object.assign(o, field);
    // `batched: false` takes the task out of the batch queue; the field is removed so the queue file looks as before.
    if (o.batched === false) delete o.batched;
    if (bonus != null) {
      const t = L.addToBonus(o, bonus, new Date().toISOString());
      if (t) die(`Invalid bonus: ${t}`);
    }
  });
  const changedField = [...Object.keys(field), ...(bonus != null ? ['bonus', 'remarks'] : [])];
  // --answer-json (the board): one JSON line with the changelog no., so "Undo" rolls back exactly this edit.
  if (a.includes('--answer-json'))
    console.log(JSON.stringify({ ok: true, id, changed: changedField, log: lastEntry?.nr ?? null }));
  else {
    console.log(`${id} changed: ${changedField.join(', ')}`);
    if (bonus != null)
      console.log(
        'The addition is in the track block from now on (cq trackFile / fill --ids). If the track is already running: send it with SendMessage.',
      );
    if (undoHint()) console.log(undoHint());
  }
} else if (command === 'resolve') {
  const sp = positional(1, ['--answer', '--by']);
  if (!sp.length) die('resolve <question> [...] [--answer "..."] [--by "..."]');
  // With a timestamp (and the answer, when given) in `resolutions`; the ids are in `resolved` as before.
  const answer = a.includes('--answer') ? (val('--answer') ?? '') : null;
  const added = edit((queue) => {
    const now = new Date().toISOString();
    const r = L.resolve(queue, sp, { answer, by: val('--by') ?? null, now });
    if (r.error.length) die(`Nothing resolved:\n  ${r.error.join('\n  ')}`);
    // The answer is written into the mission of every task that waits on the question (idempotent).
    return L.ownerAnswerBonus(queue, sp, answer, now);
  });
  console.log(`Resolved: ${sp.join(', ')}${answer != null ? ' (with answer)' : ''}`);
  if (added.length)
    console.log(
      `The answer is added to the mission (OWNER_ANSWER bonus) for: ${[...new Set(added.map((x) => x.id))].join(', ')}. ` +
        'If a track is already running: send it with SendMessage.',
    );
} else if (command === 'resolutions') {
  if (a.includes('--mark-logged')) {
    const sp = positional(1);
    const r = edit((queue) => {
      const s = L.markLogged(queue, sp);
      if (s.error.length) die(`Nothing marked:\n  ${s.error.join('\n  ')}`);
      return s;
    });
    console.log(`Entered in the decision log: ${r.marked.join(', ')}`);
  } else {
    const queue = read();
    const onlyUnlogged = a.includes('--unlogged');
    const rows = onlyUnlogged
      ? L.unlogged(queue)
      : Object.entries(queue.resolutions ?? {})
          .map(([sp, x]) => ({ sp, ...x }))
          .sort((x, y) => String(x.time).localeCompare(String(y.time)));
    if (!rows.length)
      console.log(
        onlyUnlogged ? 'No unlogged resolutions.' : 'No resolutions with a timestamp yet.',
      );
    for (const r of rows) {
      const q = queue.question?.[r.sp];
      const badge = r.answer == null ? 'without answer' : r.logged ? 'logged' : 'NOT LOGGED';
      console.log(`${r.sp}  ${r.time ?? '?'}  by ${r.by ?? '?'}  [${badge}]`);
      if (q?.text) console.log(`  ${q.type ?? 'question'}: ${q.text}`);
      if (r.answer != null) console.log(`  answer: ${r.answer}`);
      if (q?.source) console.log(`  source: ${q.source}`);
    }
    if (onlyUnlogged && rows.length)
      console.log(
        `\nEnter the answers in the decision log (and the plan the question is in), commit with --trailer "Queue: orchestrator", ` +
          `then: cq resolutions --mark-logged ${rows.map((r) => r.sp).join(' ')}`,
      );
  }
} else if (command === 'question') {
  const file = val('--file');
  const [id] = positional(1, ['--file', '--text', '--type', '--recommendation', '--source']);
  const fields = ['--text', '--type', '--recommendation', '--source'].some((f) => a.includes(f));
  if (file || id || fields) {
    if (!file && !id) die('question <id> --text "..." [--type ...] [--recommendation "..."] [--source "..."]');
    let input;
    if (file) input = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      // Only the fields that are given are passed on; the rest are kept.
      const field = {};
      for (const k of ['text', 'type', 'recommendation', 'source'])
        if (a.includes(`--${k}`)) field[k] = val(`--${k}`) ?? '';
      input = { [id]: field };
    }
    const r = edit((queue) => {
      const s = L.setQuestion(queue, input);
      if (s.error.length) die(`Nothing changed (${s.error.length} error(s)):\n  ${s.error.join('\n  ')}`);
      return s;
    });
    if (!r.set.length) console.log('Nothing to set (empty object).');
    else console.log(`Question set (${r.set.length}): ${r.set.join(', ')}`);
  } else {
    const queue = read();
    const rows = L.questionOverview(queue);
    if (!rows.length) console.log('No owner questions in the queue.');
    for (const r of rows) {
      const status = r.resolved
        ? 'resolved'
        : `open, ${r.tasks.length} ${r.tasks.length === 1 ? 'task waiting' : 'tasks waiting'}`;
      console.log(cut(`${r.sp}  [${r.type}; ${status}]`, WIDTH));
      console.log(
        `  ${cut(r.text ?? '(missing text: cq question <id> --text "...")', WIDTH - 2)}`,
      );
      if (r.recommendation) console.log(`  ${cut(`recommendation: ${r.recommendation}`, WIDTH - 2)}`);
    }
  }
} else if (command === 'approve') {
  const ids = a.slice(1).filter((x) => !x.startsWith('--'));
  if (!ids.length) die('approve <id> [...]');
  const r = edit((queue) => {
    const answer = L.approve(queue, ids);
    // All or nothing: a write error in one id must not approve half the list.
    if (answer.error.length) die(`Nothing approved:\n  ${answer.error.join('\n  ')}`);
    return answer;
  });
  console.log(`Approved (waiting now): ${r.approved.join(', ')}`);
} else if (command === 'limit') {
  const [, name, raw] = a;
  if (name) {
    // Validated under the lock against the limits as they are now (maxDPlus at most maxConcurrent).
    const t = edit((queue) => {
      const r = L.parseLimit(name, raw, { ...L.DEFAULT_LIMITS, ...(queue.limits ?? {}) });
      if ('error' in r) die(r.error);
      queue.limits = { ...(queue.limits ?? {}), [name]: r.val };
      return r;
    });
    console.log(`${name} = ${L.limitText(name, t.val)}`);
  }
  const queue = read();
  const g = { ...L.DEFAULT_LIMITS, ...(queue.limits ?? {}) };
  for (const n of L.LIMIT_NAME) console.log(`  ${n.padEnd(14)} ${L.limitText(n, g[n])}`);
  // The threshold for low parallelism (not a slot limit; default in queueDiagnose).
  console.log(`  ${'parallelThreshold'.padEnd(14)} ${D.thresholdFor(queue)}`);
  // The load limit (machine memory; the queue's value, otherwise queue.config.json) and the measurement now.
  console.log(`  ${'minFreeMemoryPct'.padEnd(14)} ${L.limitText('minFreeMemoryPct', L.minFreeMemoryFor(queue))}`);
  const lm = measureLoad();
  console.log(`  load now: free memory ${lm.freeMemoryPct ?? '?'} %`);
  const lg = L.loadGuard(queue, lm);
  if (lg.stop) console.log(lg.message);
  const b = L.budgetGuard(queue, dailyUsageFor(queue));
  if (b.active) console.log(b.message);
  const night = L.nightGuard(queue);
  if (night.active) console.log(night.message);
} else if (command === 'helpers') {
  // ---- The helper agents (lib/queueHelpers.js): list, switch one on or off, and the custom helpers of the project
  // (add, scan, approve, when, remove). Every write goes to queue.json (helpers.<agent>) under the lock, like `limit`,
  // and wins over queue.config.json. The board's "Helper agents" tab calls this command (it never writes the files
  // itself, and it can never approve). A custom helper's file is checked against its approved sha256 here (lib/
  // helperFiles.js); one that changed is turned off. Nothing in an agent file is ever run: it is read, hashed, scanned
  // and copied. ----
  const HF = require('./lib/helperFiles.js');
  const HS = require('./lib/helperScan.js');
  const [, mode, name] = a;
  const WITH_VALUE = ['--name', '--classes', '--labels', '--paths', '--mostly-paths', '--title', '--text', '--by', '--sha256'];
  const verified = () => HF.verifiedSetup(CONFIG, read(), MAIN_TREE);
  // A custom helper by name (for scan, approve, when, remove), or stop with a clear message.
  const customHelper = (n, { registeredOnly = false } = {}) => {
    const { setup, hashes } = verified();
    const h = setup[String(n ?? '')];
    if (!h) die(`${n ?? '(no name)'} is not a helper (cq helpers lists them)`);
    if (h.source !== 'custom') die(`${n} is a builtin helper: only custom helpers are added, scanned and approved`);
    if (registeredOnly && !h.registered)
      die(`${n} comes from queue.config.json (helpers), not from cq helpers add: change it there`);
    return { h, current: hashes[n] ?? null };
  };
  const readAgent = (h) => {
    const abs = HF.insideRoot(MAIN_TREE, h.path);
    if (!abs || !fs.existsSync(abs)) die(`The agent file ${h.path ?? '(no path)'} is missing.`);
    const buffer = fs.readFileSync(abs);
    return { abs, text: buffer.toString('utf8'), sha256: HF.sha256(buffer) };
  };
  const conditions = (target) => {
    for (const [flag, key] of [
      ['--classes', 'classes'],
      ['--labels', 'labels'],
      ['--paths', 'paths'],
      ['--mostly-paths', 'mostlyPaths'],
    ])
      if (a.includes(flag)) target[key] = HELP.splitList(values(flag));
    return target;
  };

  if (mode === 'add') {
    const [file] = positional(2, WITH_VALUE);
    if (!file) die('use: cq helpers add <file.md> [--name <name>] [--classes K,U] [--labels a,b] [--paths p,q]');
    const src = HF.readSource(file, process.cwd());
    if (src.error) die(src.error);
    const fm = HS.readFrontmatter(src.text.split(/\r?\n/));
    if (!fm.found) die(`${file} has no frontmatter (--- name, description, tools ---): not an agent definition`);
    const fromFile = fm.keys.name?.value?.replace(/^['"]|['"]$/g, '') || path.basename(src.abs, path.extname(src.abs));
    const wanted = val('--name') ?? fromFile;
    const target = HELP.agentFile(wanted);
    const check = HELP.checkNewName(wanted, {
      config: CONFIG,
      setup: verified().setup,
      fileExists: fs.existsSync(path.join(MAIN_TREE, target)),
      pluginAgents: HF.pluginAgentNames(),
    });
    if (check.error) die(check.error);
    const text = HELP.withAgentName(src.text, check.name);
    const description = (fm.keys.description?.value ?? '').replace(/^['"]|['"]$/g, '');
    const r = edit((queue) => {
      const abs = path.join(MAIN_TREE, target);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // wx: never overwrite an agent file that appeared after the check.
      fs.writeFileSync(abs, text, { flag: 'wx' });
      const sha = HF.sha256(fs.readFileSync(abs));
      const scan = HS.scanHelper(text);
      queue.helpers = {
        ...(queue.helpers ?? {}),
        [check.name]: conditions({
          source: 'custom',
          path: target,
          sha256: sha,
          added_at: new Date().toISOString(),
          ...(val('--by') ? { added_by: val('--by') } : {}),
          title: val('--title') ?? check.name,
          text: val('--text') ?? (description ? cut(description, 200) : 'A custom helper agent of the project.'),
          classes: [],
          labels: [],
          paths: [],
          enabled: false,
          scan: HS.scanSummary(scan, sha),
        }),
      };
      return { sha, scan, h: queue.helpers[check.name] };
    });
    console.log(`Added ${check.name} (custom, OFF): ${target}, sha256 ${r.sha}`);
    for (const l of HS.scanText(r.scan, check.name)) console.log(l);
    console.log(`    ${HELP.conditionText({ plan: false, minMissionItems: null, mostlyPaths: [], ...r.h })}`);
    console.log(
      `Needs review: Claude reads the whole file, reports to the owner and asks before ${CQ} helpers approve ${check.name}` +
        ` --sha256 ${r.sha}. Then ${CQ} helpers on ${check.name}. Claude Code loads project agents at session start:` +
        ' restart the session (or open /agents) before it can run.',
    );
  } else if (mode === 'scan') {
    const { h } = customHelper(name);
    const f = readAgent(h);
    const scan = HS.scanHelper(f.text);
    if (h.registered)
      edit((queue) => {
        if (queue.helpers?.[name]) queue.helpers[name].scan = HS.scanSummary(scan, f.sha256);
      });
    if (a.includes('--json')) console.log(JSON.stringify({ name, path: h.path, sha256: f.sha256, ...scan }, null, 2));
    else {
      console.log(`${name}: ${h.path}, sha256 ${f.sha256}`);
      for (const l of HS.scanText(scan, name)) console.log(l);
      console.log(
        scan.level === 'red'
          ? 'RED: do not approve without --force and the owner\'s explicit yes.'
          : scan.level === 'yellow'
            ? 'YELLOW: weigh each finding and mention it to the owner. Read the whole file before approving.'
            : 'GREEN: no findings. Read the whole file before approving anyway.',
      );
    }
  } else if (mode === 'approve') {
    customHelper(name);
    const by = val('--by') ?? 'cq';
    const expect = val('--sha256');
    const r = edit((queue) => {
      // Read, hash and scan under the lock: the approval is for exactly these bytes.
      const { h } = customHelper(name);
      const f = readAgent(h);
      if (expect && expect.toLowerCase() !== f.sha256)
        die(`${name}: the file is not the one that was read (sha256 ${f.sha256}, expected ${expect}). Review it again.`);
      const scan = HS.scanHelper(f.text);
      if (scan.level === 'red' && !a.includes('--force'))
        die(
          `${name}: the scan is RED (${scan.counts.red} red finding(s); cq helpers scan ${name}). ` +
            'Approve only with --force, after the owner has said yes to exactly that.',
        );
      const summary = HS.scanSummary(scan, f.sha256);
      queue.helpers = {
        ...(queue.helpers ?? {}),
        [name]: {
          ...(queue.helpers?.[name] ?? {}),
          approved_sha256: f.sha256,
          approved_path: h.path,
          approved_by: by,
          approved_at: new Date().toISOString(),
          approved_scan: { ...summary, forced: scan.level === 'red' },
          scan: summary,
        },
      };
      return { sha: f.sha256, scan };
    });
    console.log(
      `${name}: approved by ${by} for sha256 ${r.sha} (scan ${r.scan.level}${r.scan.level === 'red' ? ', forced' : ''}). ` +
        `It is still off: ${CQ} helpers on ${name}. A later change to the file turns it off again.`,
    );
  } else if (mode === 'when') {
    customHelper(name, { registeredOnly: true });
    if (!['--classes', '--labels', '--paths', '--mostly-paths'].some((f) => a.includes(f)))
      die(`use: cq helpers when ${name} [--classes K,U] [--labels a,b] [--paths p,q] [--mostly-paths p] ("none" clears)`);
    edit((queue) => conditions(queue.helpers[name]));
    console.log(`${name}: ${HELP.conditionText(HELP.helperSetup(CONFIG, read())[name])}`);
  } else if (mode === 'remove') {
    const { h } = customHelper(name, { registeredOnly: true });
    edit((queue) => {
      delete queue.helpers[name];
    });
    const abs = HF.insideRoot(MAIN_TREE, h.path);
    // Only the file `add` copied (.claude/agents/<name>.md) is ever deleted, and only with the flag.
    if (a.includes('--delete-file') && h.path === HELP.agentFile(name) && abs && fs.existsSync(abs)) {
      fs.rmSync(abs);
      console.log(`${name}: removed, and ${h.path} deleted.`);
    } else console.log(`${name}: removed from the helpers. The file ${h.path} is kept (--delete-file deletes it).`);
  } else if (mode && mode !== '--json') {
    const { setup } = verified();
    const p = HELP.parseSwitch(mode, name, CONFIG, setup);
    if (p.error) die(p.error);
    edit((queue) => {
      // Keep a custom helper's registration (path, hash, approval); only the switch changes.
      queue.helpers = { ...(queue.helpers ?? {}), [p.name]: { ...(queue.helpers?.[p.name] ?? {}), enabled: p.enabled } };
      return p;
    });
    console.log(`${p.name}: ${p.enabled ? 'on' : 'off'}`);
  }
  if (!mode || mode === '--json' || mode === 'on' || mode === 'off') {
    // A custom helper whose file changed (or went missing) since approval is turned off in queue.json, so changing the
    // file back later does not silently bring it back on.
    const stale = HELP.switchesToTurnOff(verified().setup);
    if (stale.length) {
      edit((queue) => {
        for (const s of stale) queue.helpers[s.name] = { ...queue.helpers[s.name], enabled: false };
      });
      for (const s of stale) console.log(`${s.name}: turned off (${HELP.REVIEW_TEXT[s.review]}).`);
    }
    const { hashes } = verified();
    const rows = HELP.helperRows(CONFIG, read(), { hashes });
    if (a.includes('--json')) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log('No helper agents in the setup (helpers in queue.config.json, or cq helpers add).');
    else
      for (const h of rows) {
        console.log(`${h.enabled ? 'on ' : 'off'} ${h.name}${h.source === 'custom' ? ' (custom)' : ''}: ${h.text}`);
        if (h.source === 'custom')
          console.log(
            `    ${h.reviewText}` +
              (h.approvedBy ? ` · approved by ${h.approvedBy} ${h.approvedAt?.slice(0, 16).replace('T', ' ')} UTC` : '') +
              (h.scan ? ` · scan ${h.scan.level}${h.scan.current ? '' : ' (older file)'}` : ' · not scanned') +
              ` · ${h.path ?? '(no path)'}`,
          );
        console.log(`    ${h.when}${h.fixedIn.length ? ` Also fixed for class ${h.fixedIn.join(', ')} (reviewers).` : ''}`);
        console.log(`    ${h.measurement}`);
      }
  }
} else if (command === 'compact') {
  // ---- Compaction mode for the orchestrator session ----
  // The same lock and validation as `limit autocompact`. The Claude Code side (whether the session compacts by itself) is the
  // owner's setting autoCompactEnabled (plus the 300k window); this command only prints the line and never changes settings files.
  const [, fresh] = a;
  if (fresh) {
    edit((queue) => {
      const r = L.parseLimit('autocompact', fresh);
      if ('error' in r) die(`${r.error}. Use: cq compact [auto|manual]`);
      queue.limits = { ...(queue.limits ?? {}), autocompact: r.val };
      return r;
    });
  }
  const mode = KV.compactMode(read());
  console.log(`Compaction mode: ${KV.modeText(mode)}.`);
  console.log(
    mode === 'auto'
      ? `Claude Code must compact by itself at 300k: Auto-compact is on by default; if you turned it off, run ` +
          `${KV.AUTOCOMPACT_ON} in the orchestrator session (once). The hooks report with a fallback line if it does ` +
          'not happen before the wind-down, and resume the queue after the compaction.'
      : `The hooks give a ready /compact line at about 280k. Claude Code's own compaction must then be off, or it ` +
          `compacts at 300k without asking: run ${KV.AUTOCOMPACT_OFF} (terminal), or set ${KV.AUTOCOMPACT_FILE} ` +
          '(desktop app). /compact keeps working.',
  );
} else if (command === 'state') {
  const queue = read();
  const t = L.state(queue, dailyUsageFor(queue), {
    uncommitted: uncommittedPaths(),
    cursor: readCursor(),
    load: measureLoad(),
  });
  // A separate list of loose waits (always included; empty list when everything is in order).
  t.resolveWaits = L.resolveWaits(queue);
  // Running tracks without an agent (always included; empty list when all is well).
  t.withoutAgent = findWithoutAgent(queue);
  // The parallelism (active ones, max, share, threshold, low) always; the findings only when it is low.
  const par = D.parallelDiagnose(queue);
  t.parallel = { ...par, findings: par.low ? par.findings : [] };
  console.log(JSON.stringify(t, null, 2));
  if (t.empty) process.exit(3);
} else if (command === 'diagnose') {
  // ---- The whole queue diagnosis, regardless of parallelism (read-only) ----
  const d = D.parallelDiagnose(read());
  if (a.includes('--json')) console.log(JSON.stringify(d, null, 2));
  else console.log(D.diagnoseFull(d).join('\n'));
} else if (command === 'trackFile') {
  const out = val('--out');
  const idList = a.slice(1).filter((x, i, arr) => x !== '--out' && arr[i - 1] !== '--out');
  if (!out || !idList.length) die('trackFile <id> [...] --out <file>');
  const queue = read();
  const { blocks, withWarning } = makeTrackBlocks(queue, idList);
  fs.writeFileSync(out, blocks.join('\n'));
  console.log(
    `Wrote ${blocks.length} track block(s) to ${out}. Next: make-mission.mjs --common <queue-common.md> --track ${out} --head <sha>`,
  );
  if (withWarning.length)
    console.log(
      `A warning about changes outside the queue is in the track block for: ${withWarning.join(', ')} (cq external).`,
    );
} else if (command === 'fill') {
  // ---- next -> start -> trackFile -> make-queue-common -> make-mission in one call ----
  const scratch = scratchpadFor();
  if (!scratch)
    die('fill --scratchpad <folder> (or QUEUE_SCRATCHPAD): the prompt files are written there.');
  const max = val('--max') != null ? Number(val('--max')) : Infinity;
  if (!(max >= 0)) die('--max must be a number >= 0');
  const ids = values('--ids');
  // Without --ids fill only starts new ones; during windDown that is refused before anything else (exit 6).
  if (!ids.length) {
    const by = L.windDownGuard(readCursor());
    if (by.stop) die(by.message, 6);
  }
  const head = git(['rev-parse', BASE]);
  if (!head) die(`Could not find baseBranch ${BASE} in the main tree (git rev-parse ${BASE}).`);
  const usage = dailyUsageFor(read());
  const uncommitted = uncommittedPaths();
  // Measured before the lock; --over-load (the owner's word) overrides the load guard.
  const load = a.includes('--over-load') ? null : measureLoad();
  let quotaMessage = null;
  // Under the lock: select (selectNext, or --ids) and mark started. With --ids a task that is already running gets
  // only new prompt files (e.g. after make-mission failed); a pending one must be startable now (otherwise start --force
  // on the owner's word first).
  const selected = edit((queue) => {
    // Done focus stages are taken out before the selection (does not change the order: a done stage has no tasks).
    autoCleanFocus(queue, 'fill');
    const out = [];
    if (ids.length) {
      const can = L.selectNext(queue, Date.now(), { uncommitted }).map((v) => v.id);
      for (const id of ids) {
        const o = queue.tasks.find((x) => x.id === id);
        if (!o) die(`Unknown task ${id}. Nothing was started.`);
        if (o.status === 'running') out.push({ o, new: false });
        else if (o.status === 'waiting' && can.includes(id)) {
          // The wind-down also stops new starts via --ids (new prompt files for running ones still work).
          const by = L.windDownGuard(readCursor());
          if (by.stop) die(`${by.message} Nothing was started.`, 6);
          // The load guard also stops new starts via --ids (--over-load overrides).
          const lg = L.loadGuard(queue, load);
          if (lg.stop) die(`${lg.message} Nothing was started.`, 7);
          out.push({ o, new: true });
        } else
          die(
            `${id} (${o.status}) cannot be started now (see next and show --full; start --force only on the owner's word). ` +
              'Nothing was started.',
          );
      }
    } else {
      const guard = L.startGuard(queue, usage, { cursor: readCursor(), load });
      if (guard) die(guard.message, guard.code);
      // The quota forecast (soft). Mode notice: just a line. Mode cap: at most so many new ones that the number of concurrent
      // tracks keeps the quota until the next reset; --over-quota overrides. An error in the forecast never stops fill.
      let quotaMax = Infinity;
      try {
        const activeOnes = queue.tasks.filter((x) => x.status === 'running').length;
        const t = CH.quotaCap(
          CH.forecast({ queue, events: TK.usageEvents(readTimeLog()) }),
          activeOnes,
        );
        if (t.message) quotaMessage = t.message;
        if (t.limit != null && !a.includes('--over-quota')) quotaMax = t.limit;
      } catch (e) {
        quotaMessage = `(The quota forecast failed: ${e?.message ?? e}; cq capacity)`;
      }
      for (const v of L.selectNext(queue, Date.now(), { uncommitted }).slice(
        0,
        Math.min(max, quotaMax),
      ))
        out.push({ o: queue.tasks.find((x) => x.id === v.id), new: true });
    }
    for (const x of out) if (x.new) markStarted(queue, x.o, { head, scratchpad: scratch });
    return out.map((x) => ({ id: x.o.id, new: x.new }));
  });
  // A check at every fill: loose waits (the owner does not see them, or an answer blocks anyway).
  const resolveWarning = () => {
    for (const l of L.resolveWaitsLines(L.resolveWaits(read()), { max: 10 })) console.log(l);
  };
  if (quotaMessage) console.log(quotaMessage);
  focusCleanOut();
  if (!selected.length) {
    console.log('Nothing can start now (see show and state).');
    resolveWarning();
    parallelWarning();
    process.exit(0);
  }
  const queue = read();
  for (const v of selected.filter((x) => x.new)) logStart(queue.tasks.find((x) => x.id === v.id));
  pulseCursor(`fill ${selected.map((v) => v.id).join(' ')}`);
  fs.mkdirSync(scratch, { recursive: true });
  const trackFile = path.join(scratch, 'queue-track-fill.md');
  const commonFile = path.join(scratch, 'queue-common.md');
  const { blocks, withWarning } = makeTrackBlocks(
    queue,
    selected.map((v) => v.id),
  );
  fs.writeFileSync(trackFile, blocks.join('\n'));
  const newIds = selected.filter((v) => v.new).map((v) => v.id);
  const runScript = (name, args) => {
    try {
      execFileSync(process.execPath, [path.join(HERE, name), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch (e) {
      die(
        `${name} failed: ${String(e?.stderr ?? e?.message ?? e).trim()}\n` +
          (newIds.length ? `Started (running): ${newIds.join(', ')}. ` : '') +
          `When the error is fixed: cq fill --ids ${selected.map((v) => v.id).join(' ')} --scratchpad "${scratch}"`,
      );
    }
  };
  // The common protocol is made every time (cheap), so a changed mission template is always included.
  runScript('make-queue-common.mjs', ['--out', commonFile, '--scratchpad', scratch]);
  runScript('make-mission.mjs', [
    '--common',
    commonFile,
    '--track',
    trackFile,
    '--head',
    head,
    '--out',
    scratch,
  ]);
  const track = selected.map((v) => {
    const o = queue.tasks.find((x) => x.id === v.id);
    const prompt = path.join(scratch, `prompt-${o.id}.md`);
    return {
      id: o.id,
      class: o.class,
      // cq:track in a plugin install, track in a vendored one (lib/projectRoot.js agentRef).
      subagent_type: require('./lib/projectRoot.js').agentRef(L.agentTypeFor(o.class)),
      prompt,
      message: L.trackMessage(o.id, prompt),
      branch: o.branch,
      migr_block: o.migr_block ?? null,
      new: v.new,
      warning: withWarning.includes(o.id),
    };
  });
  const jsonFile = path.join(scratch, 'queue-fill.json');
  fs.writeFileSync(
    jsonFile,
    JSON.stringify({ time: new Date().toISOString(), head, track }, null, 2) + '\n',
  );
  console.log(`FILLED ${track.length} track(s) (head ${head.slice(0, 8)}); the details are in ${jsonFile}.`);
  for (const s of track)
    console.log(
      `${s.id}  subagent_type=${s.subagent_type}  migr ${s.migr_block ?? '-'}${s.new ? '' : '  (was already running)'}` +
        `${s.warning ? '  WARNING in the track file (changed outside the queue)' : ''}`,
    );
  resolveWarning();
  // Tracks that were just started count as active (they are running in the queue file now).
  parallelWarning();
  // All the agents are started in the SAME turn (parallel Agent calls), not one per turn.
  for (const l of L.concurrentBlock(track)) console.log(l);
} else if (command === 'receive') {
  // ---- A track has delivered -> review + review package as plain files + reviewer prompts ----
  const id = positional(1, ['--scratchpad', '--result'])[0];
  if (!id) die('receive <id> [--scratchpad <folder>] [--result "RESULT ..."] [--force]');
  const o0 = read().tasks.find((x) => x.id === id);
  if (!o0) die(`Unknown task ${id}`);
  if (!['running', 'picked', 'review'].includes(o0.status))
    die(`${id} has status ${o0.status}; receive applies to running, picked or review.`);
  const scratch = scratchpadFor(o0.scratchpad ?? null);
  if (!scratch) die('receive needs --scratchpad <folder> (or QUEUE_SCRATCHPAD).');
  const branch = o0.branch ?? branchFor(id);
  const gi = branchInfo(branch);
  if (!gi.exists) die(`Branch ${branch} does not exist.`);
  if (gi.commits === 0 && !a.includes('--force'))
    die(
      `${branch} has no commits ahead of ${BASE} (already merged?). The package will be empty; --force to make it anyway.`,
    );
  const scope = `${BASE}...${branch}`;
  const folder = path.join(scratch, `rev-${id}`);
  // The package is made again every time (a new round after a fix replaces the old one). Only files we made ourselves.
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(path.join(folder, 'files'), { recursive: true });
  const stat = gitLarge(['diff', '--stat', scope]) ?? '';
  const diff = gitLarge(['diff', scope]) ?? '';
  fs.writeFileSync(path.join(folder, 'diff.patch'), diff);
  const { copy, skipped } = L.packageFiles(
    gitLarge(['diff', '--name-status', '--no-renames', scope]),
    gitLarge(['diff', '--numstat', '--no-renames', scope]),
  );
  const copied = [];
  for (const filePath of copy) {
    const content = gitLarge(['show', `${branch}:${filePath}`], { buffer: true });
    if (content == null) {
      skipped.push({ path: filePath, reason: 'could not be read from the branch' });
      continue;
    }
    const templateFile = path.join(folder, 'files', ...filePath.split('/'));
    fs.mkdirSync(path.dirname(templateFile), { recursive: true });
    fs.writeFileSync(templateFile, content);
    copied.push(filePath);
  }
  // The track's answer (from the transcript), report.md and handover.md from the track folder in the scratchpad.
  const agents = taskAgents(o0);
  const trackReply = lastTrackReply(agents);
  const files = {};
  if (trackReply) {
    fs.writeFileSync(path.join(folder, 'trackReply.md'), trackReply);
    files.trackReply = true;
  }
  // Adoption: the newest report in the orchestrator's and the task's scratchpad, also from a fix round (<id>-r<N>/).
  const trackFound = L.findTrackReport(id, [scratch, o0.scratchpad ?? null]);
  for (const [k, measure, n] of [
    [trackFound.report?.path, 'trackReport.md', 'report'],
    [trackFound.handover?.path, 'handover.md', 'handover'],
  ]) {
    if (k && fs.existsSync(k)) {
      fs.copyFileSync(k, path.join(folder, measure));
      files[n] = true;
    }
  }
  const reportText = files.report
    ? fs.readFileSync(path.join(folder, 'trackReport.md'), 'utf8')
    : null;
  const result =
    L.parseResult(val('--result')) ??
    L.parseResult(trackReply) ??
    L.parseResult(reportText);
  // QA evidence: the EVIDENCE line (report.md first, otherwise the answer) and the warning when a task that needs it
  // (config().qa.evidenceLabels) has none. A warning, not a stop.
  const evidenceRead = L.parseEvidence(reportText) ?? L.parseEvidence(trackReply);
  const evidenceWarn = L.evidenceWarning({
    o: o0,
    evidence: evidenceRead?.evidence ?? null,
    evidenceError: evidenceRead?.error ?? null,
  });
  // The mission (prompt-<id>.md) goes into the package too: reviewer-gap compares the delivery with it, and the helper
  // condition minMissionItems counts its numbered points.
  const missionFile = path.join(scratch, `prompt-${id}.md`);
  let missionText = null;
  if (fs.existsSync(missionFile)) {
    missionText = fs.readFileSync(missionFile, 'utf8');
    fs.writeFileSync(path.join(folder, 'mission.md'), missionText);
    files.mission = true;
  }
  // THE reviewers for the task (lib/queueHelpers.js): the fixed ones for the class and the helpers that are on and hit
  // (class, label, changed paths, plan, mission points). A custom helper only when its agent file is the one the owner
  // approved (sha256, lib/helperFiles.js); one that changed since is turned off here and left out.
  const HF = require('./lib/helperFiles.js');
  const checked = HF.verifiedSetup(CONFIG, read(), MAIN_TREE);
  const stale = HELP.switchesToTurnOff(checked.setup);
  if (stale.length) {
    edit((queue) => {
      for (const s of stale) queue.helpers[s.name] = { ...queue.helpers[s.name], enabled: false };
    });
    for (const s of stale)
      console.log(`Helper agent ${s.name}: turned off and left out (${HELP.REVIEW_TEXT[s.review]}; cq helpers scan ${s.name}).`);
  }
  const reviewerList = L.reviewersForTask(o0, {
    queue: read(),
    changedPaths: [...copy, ...skipped.map((h) => h.path)],
    missionText,
    hashes: checked.hashes,
  });
  const reviewers = reviewerList.map((x) => x.type);
  const customReviewers = new Set(reviewerList.filter((x) => x.custom).map((x) => x.type));
  const dbObjects = L.dbObjectsFromDiff(diff, { folder: MIGR.folder });
  fs.writeFileSync(
    path.join(folder, '00-package.md'),
    L.reviewPackageIndex({
      o: o0,
      branch,
      stat,
      dbObjects,
      copied,
      skipped,
      result,
      files,
      base: BASE,
      migrFolder: MIGR.folder,
      reviewers: reviewerList,
    }),
  );
  const prompts = reviewers.map((type) => {
    const file = path.join(folder, `reviewer-${type}.md`);
    fs.writeFileSync(file, L.reviewerPrompt({ o: o0, type, folder, base: BASE }) + '\n');
    return { type, file };
  });
  const r = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (o.status !== 'review') {
      const s = L.setStatus(o, 'review', new Date().toISOString());
      if (s.error) die(s.error);
    }
    if (result) o.result = result;
    if (evidenceRead?.evidence) o.evidence = evidenceRead.evidence;
    o.review_package = folder;
    // Adoption: the report that has been read is no longer a new delivery (pulse and deliveries skip it).
    if (trackFound.report) {
      o.report_received = trackFound.report.mtimeMs;
      o.report_seen = Math.max(Number(o.report_seen ?? 0), trackFound.report.mtimeMs);
    }
    // First delivery to review (a new round after a fix keeps the first time).
    o.t_receive ??= new Date().toISOString();
    autoCleanFocus(queue, `receive ${id}`);
    return o;
  });
  if (o0.status !== 'review' && r.started)
    logTime(id, 'delivered', `${minutes(r.started, r.delivered)} min to delivery`);
  if (!r.picked_by) pulseCursor(`receive ${id}`);
  console.log(
    `${id}: review · ${result ? result.line : 'no RESULT line (read trackReply.md)'}\n` +
      `Package: ${folder} (00-package.md; ${copied.length} file(s), ${dbObjects.length} DB object(s))`,
  );
  // The report cap (about 1,500 chars); the long part belongs in report.md.
  const capWarning = L.reportCapWarning(trackReply);
  if (capWarning) console.log(capWarning);
  if (evidenceRead?.evidence) console.log(`QA evidence: ${L.evidenceText(evidenceRead.evidence)}`);
  if (evidenceWarn) console.log(evidenceWarn);
  focusCleanOut();
  // The reviewers (D+: two, plus the helpers that hit) are started in the SAME turn.
  for (const x of reviewerList.filter((y) => !y.fixed))
    console.log(`Helper agent ${x.type}: ${x.reasons.join(', ')} (cq helpers off ${x.type} turns it off).`);
  if (prompts.length)
    for (const l of L.concurrentBlock(
      prompts.map((p) => ({ subagent_type: p.type, prompt: p.file, bare: customReviewers.has(p.type) })),
    ))
      console.log(l);
  else
    console.log(
      `Class ${o0.class}: no review (config().reviewers has none for the class, and no helper agent is on and hits).`,
    );
  console.log(
    `Merge (after an approved review, from Bash): ${CQ} merge ${id}  ` +
      `(by hand: merge-track.mjs ${branch} --wave-base ${o0.head_start ?? '<HEAD at start>'})`,
  );
  // The end of a track is a natural checkpoint for the parallelism.
  parallelWarning();
} else if (command === 'merge') {
  // ---- merge-track -> migrationPush (only with a migration flow, with the environment guard) -> gates --quick -> set done -> fill,
  // in one call. The steps, the stop rules and the environment check are in queueLogic (mergePlan, executeMerge, environmentCheck); here is only
  // the I/O. ----
  const id = positional(1, ['--scratchpad'])[0];
  if (!id)
    die('merge <id> [--without-migr-push] [--without-fill] [--scratchpad <folder>] [--force] [--allow-guard]');
  // The merge guard's override (see lib/mergeGuard.js): passed on to merge-track.mjs, which logs it.
  const allowGuard = a.includes('--allow-guard');
  const o = read().tasks.find((x) => x.id === id);
  if (!o) die(`Unknown task ${id}`);
  const force = a.includes('--force');
  if (o.status !== 'review' && !(force && ['running', 'picked'].includes(o.status)))
    die(
      `${id} has status ${o.status}; merge applies to review (after receive and an approved review). ` +
        '--force only for running/picked on the owner\'s word.',
    );
  const branch = o.branch ?? branchFor(id);
  const gi = branchInfo(branch);
  if (!gi.exists) die(`Branch ${branch} does not exist.`);
  if (gi.commits === 0)
    die(`${branch} has no commits ahead of ${BASE} (already merged?). Nothing completed.`);
  const withoutFill = a.includes('--without-fill');
  const scratch = scratchpadFor(o.scratchpad ?? null);
  if (!scratch && !withoutFill)
    die('merge needs --scratchpad <folder> (or QUEUE_SCRATCHPAD) for fill, or --without-fill.');
  const name = git(['diff', '--name-only', `${BASE}...${branch}`]);
  // The branch's merge base and tip BEFORE the merge. After the merge HEAD = baseBranch and the gates' diff against base is empty;
  // with these gates.mjs can still see the track's own changes.
  const trackArgs = require('./lib/trackDiff.js').trackArgs({
    separator: git(['merge-base', BASE, branch]),
    tip: git(['rev-parse', '--verify', `refs/heads/${branch}`]),
  });
  // The size in code lines (a stable size unit), measured BEFORE the merge against the wave base (HEAD at start;
  // without it: baseBranch). Three dots: only the branch's own changes.
  const diffLines = TK.diffLinesFromShortstat(
    git(['diff', '--shortstat', `${o.head_start ?? BASE}...${branch}`]),
  );
  const plan = L.mergePlan({
    o,
    files: name == null ? null : name.split(/\r?\n/).filter(Boolean),
    withoutMigrPush: a.includes('--without-migr-push'),
    withoutFill,
    base: BASE,
    migrations: MIGR,
  });
  const logFolder = scratch ?? FOLDER;
  fs.mkdirSync(logFolder, { recursive: true });
  const logFile = path.join(logFolder, `merge-${id}.log`);
  const logParts = [];
  const writeLog = (text) => {
    logParts.push(text);
    try {
      fs.writeFileSync(logFile, logParts.join('\n'));
    } catch {
      /* the log is an aid (Windows file lock); the steps go on */
    }
  };
  const queueMjs = path.join(HERE, 'queue.mjs');
  const remark = `merged with cq merge${plan.migrPush ? ' (migrations pushed)' : ''}`;
  /** The command for one step: [program, arguments, shell?]. The migration command is a shell line from the config. */
  const command = ({ step }) => {
    if (step === 'merge')
      return [
        process.execPath,
        [
          path.join(HERE, 'merge-track.mjs'),
          branch,
          ...(o.head_start ? ['--wave-base', o.head_start] : []),
          ...(allowGuard ? ['--allow-guard'] : []),
        ],
      ];
    if (step === 'migr-push') return [String(MIGR.pushCommand), [], true];
    if (step === 'gates')
      return [
        process.execPath,
        [
          path.join(HERE, 'gates.mjs'),
          '--quick',
          ...trackArgs,
          '--log',
          path.join(logFolder, `merge-${id}-gates`),
        ],
      ];
    if (step === 'done')
      return [
        process.execPath,
        [
          queueMjs,
          'set',
          id,
          'done',
          '--remark',
          remark,
          // The reviewers' FINDINGS lines are entered into the task (`findings`); no line: no --findings.
          ...reviewerFindingsLines(o).flatMap((l) => ['--findings', l]),
        ],
      ];
    if (step === 'fill') return [process.execPath, [queueMjs, 'fill', '--scratchpad', scratch]];
    throw new Error(`unknown step ${step}`);
  };
  // The tests inject the runner (QUEUE_MERGE_RUNNING = a module with default export run({ step, cmd, args }) ->
  // { code, out }), so there is never a real migrationPush, merge or gate run in a test.
  const injected = process.env.QUEUE_MERGE_RUNNING
    ? (await import(pathToFileURL(path.resolve(process.env.QUEUE_MERGE_RUNNING)).href)).default
    : null;
  // The exit code of merge-track.mjs: 4 = the merge guard stopped it before the merge (gets its own message below).
  let mergeCode = null;
  const run = (x) => {
    const [cmd, args, shell = false] = command(x);
    let r;
    if (injected) r = injected({ ...x, cmd, args });
    else {
      const s = spawnSync(cmd, args, {
        cwd: GIT_ROOT,
        encoding: 'utf8',
        maxBuffer: 1 << 28,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: shell,
      });
      r = {
        code: s.status ?? 1,
        out: `${s.stdout ?? ''}${s.stderr ?? ''}${s.error ? `\n${s.error.message}` : ''}`,
      };
    }
    writeLog(`===== ${x.step}: ${cmd} ${args.join(' ')} (exit ${r.code}) =====\n${r.out}`);
    if (x.step === 'merge') mergeCode = r.code;
    return r;
  };
  const PRIVACY = require('./lib/pushGuard.js');
  // The environment file is often gitignored and only in the main tree; so the git root is tried first and then the main tree.
  const readEnvironment = () => PRIVACY.readEnvironment([GIT_ROOT, MAIN_TREE], MIGR.environmentFile ?? null);
  console.log(`MERGE ${id} (${branch}): ${plan.step.join(' → ')}`);
  const res = L.executeMerge({
    o,
    plan,
    branch,
    currentBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    run,
    readEnvironment,
    // The push guard (hook-push-guard.mjs) does not see commands inside this script; so it is asked here too.
    guard: (environment) =>
      PRIVACY.assess(String(MIGR.pushCommand ?? ''), {
        branch: BASE,
        environment,
        baseBranch: BASE,
        migrations: MIGR,
      }),
    base: BASE,
    migrations: MIGR,
  });
  for (const l of res.lines) console.log(l);
  if (!res.ok && res.stop.step === 'merge' && mergeCode === 4) {
    // The merge guard: nothing was merged. Say what to do instead of a raw exit code.
    console.log(
      `STOP: the merge guard stopped ${branch} before the merge. The branch changes protected paths ` +
        `(protectedPaths in queue.config.json: hooks, settings, agents, orchestrator scripts, the queue config, ` +
        `package.json) that ${id} does not own. Nothing was merged.`,
    );
    if (res.stop.excerpt.length) console.log(res.stop.excerpt.map((l) => `  | ${l}`).join('\n'));
    console.log(
      `Read the diff first: git diff ${BASE}...${branch} -- <path>. A change you did not ask for may come from text ` +
        'the track read (prompt injection): then do not merge, and start a fix round.\n' +
        `If the change is intended: add the path to the task's owned_files/shared_patch, or run ` +
        `\`${CQ} merge ${id} --allow-guard\` (logged as "guard-overridden").`,
    );
    console.log(`Full log: ${logFile}`);
    process.exit(4);
  }
  if (!res.ok) {
    console.log(`STOP in the step ${res.stop.step}: ${res.stop.message}`);
    if (res.stop.excerpt.length) console.log(res.stop.excerpt.map((l) => `  | ${l}`).join('\n'));
    console.log(`Full log: ${logFile}`);
    process.exit(1);
  }
  // The timestamps and the size. t_review is the first reviewer start after t_receive (hook-time writes
  // the start row with the task id from the path rev-<id>); the tests run with an injected runner, without a real merge.
  edit((queue) => {
    const ox = queue.tasks.find((x) => x.id === id);
    if (!ox) return null;
    ox.t_merge = new Date().toISOString();
    if (diffLines != null) ox.diff_lines = diffLines;
    const tReview = TK.firstReviewStart(readTimeLog(), id, {
      types: L.REVIEWER_TYPES,
      from: ox.t_receive ?? null,
    });
    if (tReview && !ox.t_review) ox.t_review = tReview;
    return ox;
  });
  console.log(`Full log: ${logFile}`);
} else if (command === 'info') {
  // ---- Fixed lookups instead of `node -e` against queue.json ----
  const id = positional(1, ['--field'])[0];
  if (!id) die('info <id> [--field <name>] [--json]');
  const o = read().tasks.find((x) => x.id === id);
  if (!o) die(`Unknown task ${id}`);
  const field = val('--field');
  if (field) {
    const v = L.infoField(o, field);
    if (v === undefined) die(`${id} does not have the field ${field}`);
    console.log(L.infoValueText(v));
  } else if (a.includes('--json')) console.log(JSON.stringify(o, null, 2));
  else for (const l of L.infoView(o)) console.log(l);
} else if (command === 'activeOnes') {
  for (const l of L.activeLines(read())) console.log(l);
} else if (command === 'next-migr') {
  // The highest file in the main tree (baseBranch, where merged migrations live) and the highest assigned block in the queue.
  if (!MIGR.folder)
    die('The project has no migration flow (config().migrations.folder is not set); next-migr does not apply.');
  const highFile = highestMigr(GIT_ROOT);
  const newText = a[1];
  if (newText == null) {
    const queue = read();
    console.log(
      `next_migr ${queue.next_migr}; ` +
        `highest migrationFile ${highFile}, highest block ${L.highestBlockNr(queue)}`,
    );
  } else {
    const fresh = Number(newText);
    const previous = edit((queue) => {
      const v = L.nextMigrGuard({
        now: queue.next_migr,
        new: fresh,
        highestFile: highFile,
        highestBlock: L.highestBlockNr(queue),
        taken: takenForMigr(queue, { scratch: scratchpadFor() }),
      });
      if (!v.ok) die(`Nothing changed: ${v.error}`);
      const f = queue.next_migr;
      queue.next_migr = fresh;
      return f;
    });
    console.log(`next_migr ${previous} → ${fresh}`);
  }
} else if (command === 'migr') {
  // ---- `migr move <id> <block>` moves the block in the queue and in the prompt files ----
  if (!MIGR.folder)
    die('The project has no migration flow (config().migrations.folder is not set); migr does not apply.');
  const [sub, id, blockArg] = positional(1, ['--scratchpad']);
  if (sub !== 'move' || !id || !blockArg)
    die('migr move <id> <block> [--scratchpad <folder>] [--force]   (block: 3470 or 3470-3479)');
  const scratch = scratchpadFor();
  const r = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    if (L.MIGR_FREE_STATUS.has(o.status)) die(`${id} is ${o.status}; a finished task is not moved.`);
    const size = Number(MIGR.blockSize) > 0 ? Math.floor(Number(MIGR.blockSize)) : 10;
    const old = L.blockInterval(o.migr_block);
    const tens = old ? (old.to - old.from + 1) / size : Math.max(1, Number(o.migr_tens ?? 0));
    const fresh = L.parseMoveBlock(blockArg, tens, size);
    if (fresh.error) die(`Nothing changed: ${fresh.error}`);
    const hit = takenForMigr(queue, { scratch, except: id }).filter(
      (t) => t.from <= fresh.to && t.to >= fresh.from,
    );
    if (hit.length && !a.includes('--force'))
      die(
        `Nothing changed: ${fresh.from}–${fresh.to} is taken (${blockList(hit)}); --force only on the owner's word`,
      );
    const previous = o.migr_block ?? null;
    o.migr_block = L.migrBlockText(fresh);
    const nextBefore = queue.next_migr;
    queue.next_migr = Math.max(Number(queue.next_migr) || 0, fresh.to + 1);
    const now = new Date().toISOString();
    o.remarks = [...(o.remarks ?? []), `${now} migr move: ${previous ?? 'none'} → ${o.migr_block}`];
    return {
      o: { ...o },
      old,
      fresh,
      previous,
      nextBefore,
      next: queue.next_migr,
      scratchpad: o.scratchpad,
    };
  });
  console.log(`${id}: migr_block ${r.previous ?? 'none'} → ${r.o.migr_block}`);
  if (r.next !== r.nextBefore) console.log(`next_migr ${r.nextBefore} → ${r.next}`);
  // The prompt files (prompt-<id>.md and fix rounds prompt-<id>-rN.md) in the task's scratchpad and in --scratchpad.
  const folders = [...new Set([scratch, r.scratchpad].filter(Boolean).map((m) => path.resolve(m)))];
  const own = (f) => L.promptTask(f, [r.o]) === id;
  let count = 0;
  for (const m of folders) {
    let files = [];
    try {
      files = fs.readdirSync(m).filter((f) => /^prompt-.+\.md$/.test(f) && own(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(m, f);
      const before = fs.readFileSync(p, 'utf8');
      let after = L.moveBlockInText(before, r.old, r.fresh);
      const note = `The migration block has been moved to ${r.o.migr_block} (cq migr move). Use only the new block.`;
      if (!after.includes(note)) after = `${after.replace(/\s*$/, '')}\n\n${note}\n`;
      if (after !== before) {
        fs.writeFileSync(p, after);
        count += 1;
        console.log(`wrote ${p}`);
      }
    }
  }
  if (!count) console.log('Found no prompt file to update (--scratchpad <folder> points there).');
  if (r.o.status === 'running' || r.o.status === 'picked')
    console.log(
      `${id} is running: send the track the new block with SendMessage ("The migration block has been moved to ${r.o.migr_block}").`,
    );
} else if (command === 'capacity') {
  // ---- Weekly quota on the subscription (lib/queueCapacity.js; reset and planName in config().capacity). Changes
  // are written under the lock in queue.json
  // (the field `capacity`); the view is read-only. ----
  const events = TK.usageEvents(readTimeLog());
  const time = val('--time');
  const now = time ? Date.parse(time) : Date.now();
  if (!Number.isFinite(now)) die('--time must be an ISO time, e.g. 2026-10-23T10:35+02:00');
  if (val('--calibrate') != null) {
    let percent = val('--calibrate');
    if (percent === 'auto') {
      // The status line (statusline.mjs) saves the last rate_limits it saw; use its 7-day percentage.
      const p = CH.observedPercent(CH.readObserved(FOLDER), { now });
      if (p.error) die(`--calibrate auto: ${p.error}. Give the percentage from Claude instead.`);
      percent = p.percent;
      console.log(`Calibration point from the status line: ${p.percent} % (seen ${p.age_min} min ago).`);
    }
    const r = edit((queue) => {
      const k = CH.calibrate(queue, { percent, events, now });
      if (k.error) die(k.error);
      queue.capacity = k.capacity;
      return k;
    });
    console.log(`Calibrated: usd_per_100 ${r.previous} → ${r.capacity.usd_per_100}.`);
  }
  if (val('--set') != null) {
    const v = Number(val('--set'));
    if (!(v > 0))
      die(
        '--set must be a positive number (USD API equivalent in the time log per 100 % of weeklyQuota)',
      );
    edit((queue) => {
      queue.capacity = { ...(queue.capacity ?? {}), usd_per_100: Math.round(v) };
    });
  }
  if (val('--mode') != null) {
    const m = val('--mode');
    if (!['notice', 'cap', 'off'].includes(m)) die('--mode must be notice, cap or off');
    edit((queue) => {
      queue.capacity = { ...(queue.capacity ?? {}), mode: m };
    });
  }
  if (val('--cloud-credit') != null) {
    const left = Number(val('--cloud-credit'));
    const total = val('--total') != null ? Number(val('--total')) : undefined;
    const expires = val('--expires');
    if (!(left >= 0)) die('--cloud-credit must be a number >= 0 (USD left)');
    if (expires && !Number.isFinite(Date.parse(expires))) die('--expires must be an ISO time');
    edit((queue) => {
      const previous = queue.capacity?.cloudCredit ?? {};
      queue.capacity = {
        ...(queue.capacity ?? {}),
        cloudCredit: {
          left_usd: left,
          total_usd: total ?? previous.total_usd ?? null,
          expires: expires ? new Date(expires).toISOString() : (previous.expires ?? null),
          set: new Date().toISOString(),
        },
      };
    });
  }
  const p = CH.forecast({ queue: read(), events, now });
  if (a.includes('--json')) console.log(JSON.stringify(p, null, 2));
  else console.log(CH.lines(p).join('\n'));
} else if (command === 'cost') {
  // ---- Cost per task. `cost measure <id...>` measures and saves again (e.g. older finished ones). ----
  if (a[1] === 'measure') {
    const ids = positional(2, ['--findings', '--result']);
    if (!ids.length) die('cost measure <id> [...]');
    for (const id of ids) {
      const o = read().tasks.find((x) => x.id === id);
      if (!o) die(`Unknown task ${id}`);
      const m = measureTask(o);
      const r = edit((queue) => {
        const x = queue.tasks.find((y) => y.id === id);
        saveMeasurement(x, m);
        return x;
      });
      console.log(measurementLine(r));
    }
  } else {
    const s = L.costStatistics(read(), { since: sinceTime(val('--since')) });
    if (!s.rows.length)
      console.log('No finished tasks with a measured cost yet (measured at set <id> done).');
    else {
      console.log(`Cost per task (${s.total.n} finished, $${s.total.usd} total):`);
      for (const k of s.perClass)
        console.log(
          `  ${k.class.padEnd(2)} n=${String(k.n).padEnd(3)} median $${k.median_usd}  sum $${k.usd}` +
            (k.reviewed ? `  findings H=${k.H} M=${k.M} L=${k.L} (${k.reviewed} reviewed)` : ''),
        );
      // What the helper agents added (lib/queueHelpers.js): the same numbers as `cq helpers`.
      const helpers = HELP.helperRows(CONFIG, read());
      if (helpers.length) {
        const st = HELP.helperStatistics(read(), helpers.map((h) => h.name), { since: sinceTime(val('--since')) });
        console.log('Helper agents:');
        for (const h of helpers)
          console.log(cut(`  ${h.name.padEnd(20)} ${HELP.measurementText(st[h.name])}`, WIDTH));
      }
      const n = Number(val('--max') ?? 10);
      console.log(`Last ${Math.min(n, s.rows.length)}:`);
      for (const x of s.rows.slice(0, n))
        console.log(
          `  ${x.id.padEnd(12)} ${String(x.class).padEnd(2)} $${String(x.usd).padEnd(7)} ${x.agents} agent(s)` +
            (x.findings ? `  H=${x.findings.H} M=${x.findings.M} L=${x.findings.L}` : '') +
            (x.result ? `  ${x.result}` : ''),
        );
    }
  }
} else if (command === 'projects') {
  // ---- Project and feature ----
  const queue = read();
  if (!Object.keys(queue.projects ?? {}).length)
    console.log(
      'The register is empty: create one with cq project <pid> --title "..." --prefix EX- (or edit-many --file).\n',
    );
  for (const r of L.projectOverview(queue)) {
    const parts = [
      `${r.done}/${r.total} done`,
      `${r.min_left} min left`,
      r.activeOnes ? `${r.activeOnes} active` : null,
      r.picked ? `${r.picked} picked` : null,
      r.qa ? `${r.qa} in QA` : null,
      r.proposed ? `${r.proposed} proposed` : null,
      r.pause ? 'PAUSE' : null,
      r.priority_bonus
        ? `priority ${r.priority_bonus > 0 ? '+' : ''}${r.priority_bonus}`
        : null,
      !r.in_register && r.pid !== L.WITHOUT_PROJECT ? 'not in the register' : null,
    ].filter(Boolean);
    console.log(cut(`${r.pid.padEnd(16)} ${parts.join(' · ')}`, WIDTH));
    const prefixes = queue.projects?.[r.pid]?.prefixes ?? [];
    const ar = queue.projects?.[r.pid]?.area;
    const info = [
      r.title,
      r.plan,
      prefixes.length ? `prefix ${prefixes.join(' ')}` : null,
      ar ? `area ${ar}` : null,
      queue.projects?.[r.pid]?.phase ? `phase ${queue.projects[r.pid].phase}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    if (info) console.log(`  ${cut(info, WIDTH - 2)}`);
    if (r.ownerQuestion.length) {
      const sp = r.ownerQuestion
        .slice(0, 3)
        .map((e) => `${e.sp} (${e.tasks})`)
        .join(', ');
      const more = r.ownerQuestion.length > 3 ? ` +${r.ownerQuestion.length - 3} more` : '';
      console.log(`  ${cut(`↳ waiting on the owner: ${sp}${more}`, WIDTH - 2)}`);
    }
  }
} else if (command === 'project') {
  const pid = a[1];
  if (!pid || pid.startsWith('--'))
    die(
      'project <pid> [--title ..] [--plan ..] [--prefix EX- ...] [--pause | --continue] [--priority N] [--area <oid|none>] [--file-root <path ...>] [--phase plan|none]',
    );
  if (a.includes('--pause') && a.includes('--continue')) die('choose one of --pause and --continue');
  const field = {};
  if (val('--title') != null) field.title = val('--title');
  if (val('--plan') != null) field.plan = val('--plan');
  if (a.includes('--prefix')) field.prefixes = values('--prefix');
  if (a.includes('--pause')) field.pause = true;
  if (a.includes('--continue')) field.pause = null;
  // The area the project belongs to ("none" takes it out).
  if (val('--area') != null)
    field.area = val('--area') === 'none' ? null : val('--area');
  if (val('--priority') != null) {
    const n = Number(String(val('--priority')).replace(',', '.'));
    if (!Number.isFinite(n))
      die('--priority must be a number (bonus to the priority, e.g. 20 or -10)');
    field.priority_bonus = n === 0 ? null : n;
  }
  // File roots (a signal for classify); --file-root without values removes the list.
  if (a.includes('--file-root')) {
    const r = values('--file-root');
    field.fileRoot = r.length ? r : null;
  }
  // Phase plan = the project exists in the planning work, but has no queue tasks yet ("none" removes it).
  if (val('--phase') != null) field.phase = val('--phase') === 'none' ? null : val('--phase');
  const r = editLogged('project', (queue) => {
    const fresh = !Object.hasOwn(queue.projects ?? {}, pid);
    const reg = L.newRegister(queue.projects, { [pid]: field }, queue.areas);
    if (reg.error.length) die(`Nothing changed:\n  ${reg.error.join('\n  ')}`);
    if (field.phase === 'plan') {
      const includesOr = queue.tasks.filter(
        (o) => o.status !== 'cancelled' && L.projectFor(o, reg.register) === pid,
      ).length;
      if (includesOr)
        die(
          `Nothing changed: ${pid} has ${includesOr} queue task(s); phase plan only applies to projects without queue tasks.`,
        );
    }
    queue.projects = reg.register;
    // One-char prefixes and overlapping prefixes (the longest prefix wins, projectFor). Report, do not refuse.
    const warnings = L.prefixWarnings(queue.projects, { pid });
    const count = queue.tasks.filter((o) => L.projectFor(o, queue.projects) === pid).length;
    return { new: fresh, p: queue.projects[pid], count, warnings };
  });
  console.log(
    `${r.new ? 'Created' : 'Changed'} project ${pid} (${r.count} tasks): ${JSON.stringify(r.p)}`,
  );
  for (const x of r.warnings) console.log(`WARNING: ${x}`);
  if (undoHint()) console.log(undoHint());
} else if (command === 'edit-many') {
  const file = val('--file');
  if (!file) die('edit-many --file <json>');
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const json = a.includes('--json');
  const now = new Date().toISOString();
  // With --json: the errors as JSON on stdout (the board shows them); the lock is released as in die().
  const errorOut = (s, code = 1) => {
    if (!json) die(`Nothing changed (${s.length} error(s)):\n  ${s.join('\n  ')}`, code);
    console.log(JSON.stringify({ ok: false, error: s }));
    if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
    process.exit(code);
  };
  // `plan` must point to a plan entry that exists (null removes the link).
  const planErrorList = (reg) =>
    (Array.isArray(input) ? input : (input?.tasks ?? []))
      .filter((e) => e && typeof e === 'object' && e.plan != null)
      .map((e) => {
        const fe = P.planLinkError(reg, e.plan);
        return fe ? `${e.id ?? '?'}: ${fe}` : null;
      })
      .filter(Boolean);
  if (a.includes('--dry')) {
    // Preview. Computes everything on a copy and writes nothing; `changed` is the version the board sends
    // back as --expect-changed when the owner confirms.
    const queue = read();
    checkExpect(queue);
    const s = L.editMany(queue, input, { by: byName(), now, dry: true });
    if (s.error.length) errorOut(s.error);
    const pf = planErrorList(readPlans());
    if (pf.length) errorOut(pf);
    if (json)
      console.log(
        JSON.stringify({
          ok: true,
          dry: true,
          changed: queue.changed ?? null,
          changes: s.changes,
          warnings: s.warnings,
        }),
      );
    else {
      const ids = new Set(s.changes.filter((e) => e.id).map((e) => e.id));
      console.log(
        `Dry run (nothing written): ${s.changes.length} field(s) in ${ids.size} task(s)` +
          `${s.projects.length ? ` and ${s.projects.length} project(s)` : ''}; ` +
          `${s.changed.length - ids.size} of ${s.changed.length} task(s) are already like that. The queue's version: ${queue.changed ?? '(none)'}`,
      );
      for (const l of L.diffLines(s.changes)) console.log(`  ${l}`);
      for (const x of s.warnings) console.log(`WARNING: ${x}`);
    }
  } else {
    // All or nothing: editMany validates everything before anything changes, and die()/errorOut release the lock without writing the file.
    const r = editLogged('edit-many', (queue) => {
      const pf = planErrorList(readPlans());
      if (pf.length) errorOut(pf);
      const s = L.editMany(queue, input, { by: byName(), now });
      if (s.error.length) errorOut(s.error);
      // New or changed prefixes: the same warnings as queue.mjs project (one char, overlap).
      const pre = s.projects
        .filter((p) => input?.projects?.[p]?.prefixes)
        .flatMap((pid) => L.prefixWarnings(queue.projects, { pid }));
      return { ...s, warnings: [...s.warnings, ...new Set(pre)] };
    });
    if (json)
      console.log(
        JSON.stringify({
          ok: true,
          changed: r.changed,
          changes: r.changes,
          warnings: r.warnings,
          log: lastEntry?.nr ?? null,
        }),
      );
    else {
      console.log(
        `Changed ${r.changed.length} task(s)${r.projects.length ? ` and ${r.projects.length} project(s) in the register (${r.projects.join(', ')})` : ''}.`,
      );
      for (const x of r.warnings) console.log(`WARNING: ${x}`);
      if (undoHint()) console.log(undoHint());
    }
  }
} else if (command === 'pickable') {
  // ---- Picking ----
  const queue = read();
  const max = val('--max-min');
  if (max != null && !(Number(max) > 0)) die('--max-min must be a number > 0');
  const list = L.pickable(queue, {
    label: val('--label'),
    project: val('--project'),
    maxMin: max == null ? undefined : Number(max),
    uncommitted: uncommittedPaths(),
  });
  if (!list.length) console.log('Nothing can be picked now with this filter (see `show`).');
  for (const p of list) {
    const badges = [
      ...p.labels,
      ...(p.migr ? ['migr'] : []),
      ...(p.paused ? ['project paused'] : []),
      ...(p.uncommitted ? [`uncommitted in the main tree: ${p.uncommitted}`] : []),
      // The stage when focus applies (outside focus is last and can still be picked).
      ...('step' in p ? [p.outside_focus ? 'outside focus' : L.stepText(p)] : []),
    ];
    const header =
      `${p.id.padEnd(12)} ${p.class.padEnd(2)} ${`${p.estimate} min`.padEnd(7)} prio ${String(p.score).padEnd(7)} ` +
      `${p.project}${p.feature ? ` / ${p.feature}` : ''}${badges.length ? ` [${badges.join(', ')}]` : ''}`;
    console.log(cut(header, WIDTH));
    console.log(`  ${cut(p.title, WIDTH - 2)}`);
  }
  if (list.length)
    console.log(`\n${list.length} can be picked. Pick: cq pick <id> --by "<who>"`);
} else if (command === 'pick') {
  const id = a[1];
  if (!id || id.startsWith('--')) die('pick <id> --by "<who>" [--force]');
  const r = edit((queue) => {
    const s = L.pick(queue, id, {
      by: val('--by'),
      force: a.includes('--force'),
      // Past blocks that are already taken (a file, a task that is not finished, an active prompt file).
      taken: takenForMigr(queue, { scratch: scratchpadFor(), except: id }),
    });
    if (s.error) die(s.error);
    return s;
  });
  const o = r.task;
  const g = branchInfo(o.branch);
  const file = missionFile(o);
  const wt = `.claude/worktrees/queue-${id}`;
  console.log(
    `Picked ${id} (by ${o.picked_by}): branch ${o.branch}, migration block ${o.migr_block ?? 'none'}, class ${o.class}, estimate ${L.estimate(o)} min.`,
  );
  if (r.overridden.length) console.log(`--force overrode: ${r.overridden.join(' · ')}`);
  // The owned files changed outside the queue since the task was added, or commits that mention the id.
  writeExternalWarning(o);
  console.log(`Mission: ${file ?? `the text is in the queue (cq trackFile ${id} --out <file>)`}`);
  console.log(
    [
      'Next step (the same protocol as a queue track: own worktree, common protocol, gates and review by class):',
      g.exists
        ? `  1. Worktree on the existing branch (${g.commits} commit(s) ahead of ${BASE}): git worktree add ${wt} ${o.branch}`
        : `  1. Worktree: git worktree add ${wt} -b ${o.branch} ${BASE}`,
      `  2. The mission: cq trackFile ${id} --out <scratch>/queue-track.md; make-queue-common.mjs --out <scratch>/queue-common.md;`,
      `     make-mission.mjs --common <scratch>/queue-common.md --track <scratch>/queue-track.md --head <HEAD>`,
      `  3. In the worktree: ${require('./lib/projectRoot.js').cqCommand({ fromWorktree: true })} prepare-track ${id} --branch ${o.branch} --scratchpad "<scratch>"`,
      `  4. Done: orchestrator active -> cq deliver ${id} (it merges). No orchestrator -> merge yourself`,
      `     (merge-track.mjs ${o.branch})${MIGR.folder ? ', push the migrations' : ''}, then cq set ${id} done.`,
      '     Never git push without the owner\'s "push".',
      `  If you give up: cq release ${id} (the branch and the migration block are kept).`,
    ].join('\n'),
  );
} else if (command === 'deliver') {
  const id = a[1];
  if (!id) die('deliver <id>');
  const r = edit((queue) => {
    const s = L.deliver(queue, id);
    if (s.error) die(s.error);
    return s;
  });
  console.log(
    `${id}: review (delivered by ${r.task.picked_by ?? '?'}). The orchestrator merges ${r.task.branch ?? branchFor(id)}.`,
  );
} else if (command === 'release') {
  const id = a[1];
  if (!id) die('release <id>');
  // The commits are counted before the lock (git must not run with the queue file locked). The branch is in the task (queue/<id>).
  const before = read().tasks.find((x) => x.id === id);
  const g = branchInfo(before?.branch ?? branchFor(id));
  const r = edit((queue) => {
    const s = L.release(queue, id, { commits: g.commits });
    if (s.error) die(s.error);
    return s;
  });
  console.log(`${id}: released (was picked by ${r.by ?? '?'}), waiting again.`);
  if (r.warning) console.log(`WARNING: ${r.warning}`);
} else if (command === 'qa') {
  // ---- Visual QA: only the owner sets qa ok / qa deviation (qa auto --run closes green auto evidence) ----
  const under = a[1];
  if (!under) {
    const queue = read();
    // Split by evidence (config().qa): what the owner looks at (also entries without evidence) grouped as before, the
    // manual types in one manual round, and the auto types that qa auto --run closes.
    const split = L.qaSplit(queue);
    const groups = split.look;
    const count = groups.reduce(
      (n, p) => n + p.features.reduce((m, f) => m + f.tasks.length, 0),
      0,
    );
    const total = count + split.manual.length + split.auto.length;
    if (!total) console.log('The QA list is empty.');
    else console.log(`QA list: ${total} finished task(s) waiting on QA.\n`);
    const ageFor = (o) => (o.done ? `done ${L.ageText(Date.now() - Date.parse(o.done))} ago` : '');
    for (const p of groups) {
      console.log(cut(`${p.pid}${p.title ? `  ${p.title}` : ''}`, WIDTH));
      for (const f of p.features) {
        console.log(`  ${cut(f.feature, WIDTH - 2)}`);
        for (const o of f.tasks) {
          console.log(`    ${o.id.padEnd(12)} ${ageFor(o)} · ${L.evidenceText(o.evidence)}`);
          console.log(`      ${cut(`look for: ${o.title}`, WIDTH - 6)}`);
        }
      }
    }
    if (split.manual.length) {
      console.log(`\nManual round (${split.manual.length}): check them together, by hand.`);
      for (const o of split.manual)
        console.log(`  ${o.id.padEnd(12)} ${cut(L.evidenceText(o.evidence), WIDTH - 15)}`);
    }
    if (split.auto.length) {
      console.log(
        `\nClosed automatically when the command is green (${split.auto.length}): ${CQ} qa auto --run`,
      );
      for (const o of split.auto)
        console.log(`  ${o.id.padEnd(12)} ${cut(L.evidenceText(o.evidence), WIDTH - 15)}`);
    }
    if (total)
      console.log(
        '\nApprove: cq qa ok <id...> · deviation: cq qa deviation <id> "<what is wrong, and where>"',
      );
  } else if (under === 'evidence') {
    // Sets the evidence on a task by hand (receive otherwise reads it from the EVIDENCE line in report.md).
    const [id, spec] = positional(2);
    const qa = L.qaConfig();
    if (!id || !spec)
      die(`qa evidence <id> <type>[=<ref>[,<ref>...]] (type: ${qa.evidenceTypes.join(', ')})`);
    const p = L.parseEvidence(`EVIDENCE ${spec}`);
    if (!p || p.error) die(p?.error ?? 'invalid evidence');
    const r = edit((queue) => {
      const o = queue.tasks.find((x) => x.id === id);
      if (!o) die(`Unknown task ${id}`);
      o.evidence = p.evidence;
      return o;
    });
    console.log(`${id}: evidence ${L.evidenceText(r.evidence)}`);
  } else if (under === 'auto') {
    // QA entries with an auto evidence type (config().qa.autoTypes). Without --run only the list; with --run the
    // configured command (qa.autoCommand) runs from the project root per entry, and the green ones are closed
    // (qa_ok_by "auto"). Red stays in the QA list with a remark.
    const chosen = positional(2);
    const run = a.includes('--run');
    const candidates = L.qaSplit(read()).auto.filter((o) => !chosen.length || chosen.includes(o.id));
    if (!candidates.length) console.log('No QA entries with auto evidence are waiting.');
    for (const o of candidates) {
      if (!run) {
        console.log(`${o.id.padEnd(12)} ${L.evidenceText(o.evidence)}`);
        continue;
      }
      const k = L.evidenceCommand(o);
      if (k.error) die(k.error);
      const s = spawnSync(k.command, {
        cwd: GIT_ROOT,
        shell: true,
        encoding: 'utf8',
        maxBuffer: 1 << 28,
        windowsHide: true,
      });
      const green = s.status === 0;
      edit((queue) => {
        const u = L.qaAutoOutcome(queue, o.id, green);
        if (u.error) die(u.error);
        return u;
      });
      console.log(
        `${o.id.padEnd(12)} ${green ? 'green, QA ok (auto)' : `red (exit ${s.status ?? '?'}), stays in the QA list`} · ${L.evidenceText(o.evidence)}`,
      );
    }
    if (candidates.length && !run) console.log(`\nRun and close the green ones: ${CQ} qa auto --run [<id...>]`);
  } else if (under === 'ok') {
    const ids = positional(2);
    if (!ids.length) die('qa ok <id> [...]');
    const r = edit((queue) => {
      const s = L.qaOk(queue, ids);
      // All or nothing, like approve.
      if (s.error.length) die(`Nothing changed:\n  ${s.error.join('\n  ')}`);
      return s;
    });
    console.log(`QA ok: ${r.ok.join(', ')}`);
  } else if (under === 'deviation') {
    const [id, text] = positional(2);
    if (!id || !text) die('qa deviation <id> "<what is wrong, and where>"');
    const r = edit((queue) => {
      const s = L.qaDeviation(queue, id, text);
      if (s.error) die(s.error);
      return s;
    });
    console.log(
      `${id}: QA deviation. Fix task ${r.fix.id} is added to the queue (${r.fix.status}, class K, ${r.fix.project ?? L.WITHOUT_PROJECT}${r.fix.feature ? ` / ${r.fix.feature}` : ''}).`,
    );
  } else {
    die(
      'qa [ok <id...> | deviation <id> "<text>" | evidence <id> <type>[=<ref>] | auto [--run] [<id...>]]',
    );
  }
} else if (command === 'external') {
  // ---- Work outside the queue ----
  const under = a[1] && !a[1].startsWith('--') ? a[1] : null;
  if (!under) externalScan();
  else if (under === 'add') {
    const name = val('--name');
    const r = edit((queue) => {
      const s = L.externalAdd(queue, {
        name,
        files: values('--files'),
        db: values('--db'),
        branch: val('--branch') ?? null,
      });
      if (s.error) die(s.error);
      return s;
    });
    const owner = [...r.row.owned_files, ...r.row.owner_db].join(', ');
    console.log(
      `${r.new ? 'Registered' : 'Updated'} ${r.row.id} ("${r.row.external_name}"${r.row.branch ? `, branch ${r.row.branch}` : ''}): ` +
        `owns ${owner}. The queue starts nothing that collides until: cq external done "${r.row.external_name}"`,
    );
    for (const x of r.warnings) console.log(`WARNING: ${x}`);
  } else if (under === 'done') {
    const [name] = positional(2);
    const r = edit((queue) => {
      const s = L.externalDone(queue, name);
      if (s.error) die(s.error);
      return s;
    });
    console.log(
      `${r.row.id} ("${r.row.external_name}"): done. The files are free for the queue again. If the work is committed on ${BASE}, ` +
        'cq external shows whether it mentions pending tasks.',
    );
  } else if (under === 'accept') {
    const [id, ref] = positional(2);
    if (!id || !ref) die('external accept <id> <sha>');
    const full = String(gitRead(['rev-parse', '-q', '--verify', `${ref}^{commit}`]) ?? '').trim();
    if (!full) die(`Could not find commit ${ref}.`);
    // Only what is on baseBranch can count as completed (a branch outside the queue is not delivered yet).
    if (gitRead(['merge-base', '--is-ancestor', full, BASE]) == null)
      die(`${ref} is not on ${BASE} (merge it first, or wait).`);
    const message = gitRead(['log', '-1', '--format=%B', full]) ?? '';
    const mentioned = L.mentionedIds(message, [id]).length > 0;
    const r = edit((queue) => {
      const s = L.externalAccept(queue, id, full, { mentioned });
      if (s.error) die(s.error);
      return s;
    });
    console.log(
      `${id}: done (completed outside the queue in ${full.slice(0, 8)})` +
        `${r.qa ? ' · label visual: now in the owner QA list (cq qa)' : ''}` +
        `${mentioned ? '' : ' · NB: the commit message does not mention the id (noted in the remark)'}`,
    );
  } else {
    die(
      'external [--since ...] [--all] | external accept <id> <sha> | external add --name "<session>" --files <...> [--branch <g>] | ' +
        'external done "<name>"',
    );
  }
} else if (command === 'orchestrator') {
  // ---- Orchestrator cursor ----
  const [under] = positional(1, ['--session', '--event']);
  if (under === 'pulse') {
    const m = pulseCursor(val('--event') ?? 'pulse');
    if (!m) die(`Could not write ${CURSOR}.`);
    console.log(
      `Orchestrator marker: "${m.session}", updated ${m.updated} (expires after 2 h without a new pulse).`,
    );
    const by = L.windDownGuard(m);
    if (by.stop)
      console.log(
        `${by.message}\n(The usual path is compaction, which lifts the wind-down. If this is still a NEW session ` +
          `(emergency rotation), run pulse with a --session name other than "${m.session}".)`,
      );
    // Adoption: report.md files that came since the last pulse (an adopted track does not notify this session).
    deliveryWarning({ update: true });
    // Tracks fill marked running whose agent was never started (fill run where nobody read the output).
    for (const l of L.withoutAgentLines(findWithoutAgent(read()))) console.log(l);
    // Follow up: the pulse repeats due entries every time, until the report is written (cq follow report).
    for (const l of followLines({ pulse: true })) console.log(l);
    // The pulse runs every loop round, so low parallelism is checked now and then even without fill and receive.
    parallelWarning();
  } else if (under === 'stop') {
    fs.rmSync(CURSOR, { force: true });
    console.log('The orchestrator cursor is removed: no orchestrator is active.');
  } else if (!under) {
    const s = L.orchestratorStatus(readCursor());
    if (a.includes('--json')) console.log(JSON.stringify(s, null, 2));
    else if (s.active)
      console.log(
        `ACTIVE ORCHESTRATOR: "${s.session}", last updated ${L.ageText(s.age_ms)} ago (${s.event ?? '-'}). ` +
          'Whoever has picked a task delivers: cq deliver <id>.' +
          (L.windDownGuard(readCursor()).stop
            ? ' The session is in WIND_DOWN (no new starts until it is compacted).'
            : ''),
      );
    else
      console.log(
        `NO ACTIVE ORCHESTRATOR (${s.reason}${s.session ? `; last "${s.session}" ${L.ageText(s.age_ms)} ago` : ''}). ` +
          'Whoever has picked a task merges it themselves (the pick skill).',
      );
  } else {
    die('orchestrator [pulse [--session "<name>"] | stop]');
  }
} else if (command === 'deliveries') {
  // ---- Adoption: report.md files that have not been received (read-only; pulse does the same and remembers what it reported) ----
  const found = findDeliveries(read());
  if (a.includes('--json')) console.log(JSON.stringify(found, null, 2));
  else if (!found.length)
    console.log('No deliveries waiting (no report.md newer than the start or the last receive).');
  else
    for (const l of found)
      console.log(
        `${l.id} (${l.taskStatus})  ${l.line}\n  ${l.path}  ${l.new ? 'NEW' : 'reported before'}  → ${CQ} receive ${l.id}`,
      );
} else if (command === 'resume') {
  // ---- Adoption: the mission for a NEW agent that continues a track on the same branch (fix round or continuation) ----
  // The same template as fill (make-queue-common + make-mission), with the track block from queueLogic.resumeBlock and
  // --continue in the setup. The track id is <id>-r<N>, so the agent's report lands in <scratchpad>/<id>-r<N>/ (receive
  // finds it).
  const id = positional(1, ['--reason', '--round', '--scratchpad', '--findings-file'])[0];
  const reason = val('--reason') ?? 'fix';
  const use =
    'resume <id> [--reason fix|context] [--round N] [--findings-file <file>] [--scratchpad <folder>]';
  if (!id || !L.RESUME_REASONS.includes(reason)) die(use);
  const queue = read();
  const o = queue.tasks.find((x) => x.id === id);
  if (!o) die(`Unknown task ${id}`);
  if (!['running', 'review'].includes(o.status))
    die(`${id} has status ${o.status}; resume applies to running and review (a new start is fill or start).`);
  const scratch = scratchpadFor(o.scratchpad ?? null);
  if (!scratch) die(`${use}\nNeeds --scratchpad <folder> (or QUEUE_SCRATCHPAD).`);
  const branch = o.branch ?? branchFor(id);
  if (!branchInfo(branch).exists)
    die(`Branch ${branch} does not exist; resume continues a branch that exists (otherwise fill --ids).`);
  const found = L.findTrackReport(id, trackRoots(o));
  const round = val('--round') != null ? Number(val('--round')) : found.nextRound;
  if (!Number.isInteger(round) || round < 1) die('--round must be an integer >= 1');
  const findingsFile = val('--findings-file') ? path.resolve(val('--findings-file')) : null;
  if (findingsFile && !fs.existsSync(findingsFile)) die(`Could not find --findings-file ${findingsFile}`);
  // The review package: the saved one (receive), otherwise rev-<id> in one of the roots. Files beyond the package's own are
  // the reviewers'.
  const reviewFolder =
    [o.review_package, ...trackRoots(o).map((r) => path.join(r, `rev-${id}`))].find(
      (m) => m && fs.existsSync(m),
    ) ?? null;
  const PACKAGE = new Set([
    '00-package.md',
    'diff.patch',
    'files',
    'trackReply.md',
    'trackReport.md',
    'handover.md',
  ]);
  const reviewFiles = reviewFolder
    ? fs.readdirSync(reviewFolder).filter((n) => !PACKAGE.has(n) && !n.startsWith('reviewer-'))
    : [];
  const sourcePath = missionFile(o);
  const original = L.trackBlock(o, queue, {
    text: sourcePath ? fs.readFileSync(sourcePath, 'utf8') : o.mission,
  });
  const trackId = `${id}-r${round}`;
  const head = git(['rev-parse', BASE]);
  if (!head) die(`Could not find baseBranch ${BASE} in the main tree (git rev-parse ${BASE}).`);
  fs.mkdirSync(scratch, { recursive: true });
  const trackFile = path.join(scratch, `queue-track-${trackId}.md`);
  const commonFile = path.join(scratch, 'queue-common.md');
  fs.writeFileSync(
    trackFile,
    L.resumeBlock({
      o,
      round,
      reason,
      reportPath: found.report?.path ?? null,
      handoverPath: found.handover?.path ?? null,
      reviewFolder,
      reviewFiles,
      findingsFile,
      original,
    }),
  );
  for (const [name, args] of [
    ['make-queue-common.mjs', ['--out', commonFile, '--scratchpad', scratch]],
    ['make-mission.mjs', ['--common', commonFile, '--track', trackFile, '--head', head, '--out', scratch]],
  ]) {
    try {
      execFileSync(process.execPath, [path.join(HERE, name), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch (e) {
      die(`${name} failed: ${String(e?.stderr ?? e?.message ?? e).trim()}`);
    }
  }
  const prompt = path.join(scratch, `prompt-${trackId}.md`);
  const adjusted = L.resumePromptAdjust(fs.readFileSync(prompt, 'utf8'), { trackId, branch, base: BASE });
  fs.writeFileSync(prompt, adjusted.text);
  // The report that exists now has already been reported; only a NEW report from the new agent is reported by pulse.
  edit((q) => {
    const x = q.tasks.find((y) => y.id === id);
    if (found.report) x.report_seen = Math.max(Number(x.report_seen ?? 0), found.report.mtimeMs);
    (x.resumed ??= []).push({ round, reason, time: new Date().toISOString() });
  });
  pulseCursor(`resume ${id} r${round}`);
  console.log(
    `RESUME ${trackId} (${reason}): prompt ${prompt}` +
      `${adjusted.swapped ? '' : '  WARNING: could not find the setup line to add --continue to; check the prompt'}`,
  );
  console.log(
    `Agent: subagent_type ${require('./lib/projectRoot.js').agentRef(L.agentTypeFor(o.class))}, ` +
      `message: ${L.trackMessage(trackId, prompt)}`,
  );
  // If the branch is still checked out in a worktree, prepare-track --continue refuses: the old agent must be done.
  const holder = (git(['worktree', 'list', '--porcelain']) ?? '')
    .split(/\r?\n\r?\n/)
    .find((b) => b.split(/\r?\n/).includes(`branch refs/heads/${branch}`));
  if (holder) {
    const where = holder.split(/\r?\n/)[0].replace(/^worktree /, '');
    console.log(
      `NOTE: ${branch} is checked out in ${where}. If the old agent is done: git -C "${where}" switch --detach ` +
        'before the new agent starts (otherwise prepare-track --continue refuses).',
    );
  }
} else if (command === 'cloud-package') {
  // ---- Cloud: the package for the routine "queue-cloud" or to paste into a cloud session ----
  // One id, or a bundle of at most 4 (total estimate <= about 120 min) done one after the other in the same cloud session.
  const ids = positional(1, ['--out']);
  if (!ids.length) die('cloud-package <id> [<id> ...] [--out <file>] [--force]');
  const queue = read();
  const context = cloudContext();
  const parts = ids.map((id) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    return { o, ...cloudAssess(queue, o, context) };
  });
  const reasons = [
    ...parts.flatMap((d) => d.suitability.reasons.map((g) => `${d.o.id}: ${g}`)),
    ...L.cloudBundleCap(parts.map((d) => d.o)).map((g) => `bundle: ${g}`),
  ];
  if (reasons.length) {
    const text = reasons.join('\n  ');
    if (!a.includes('--force'))
      die(`Not suitable for the cloud:\n  ${text}\n(--force makes the package anyway)`);
    // To stderr, so the package on stdout is clean (the board copies it).
    console.error(`WARNING: not suitable for the cloud (--force):\n  ${text}`);
  }
  const pkg = L.cloudBundlePackage(parts, queue);
  const out = val('--out');
  if (out) {
    fs.writeFileSync(out, `${pkg}\n`);
    console.log(
      `Wrote the cloud package for ${ids.join(', ')} to ${out} (${pkg.length} chars). Start: RemoteTrigger run with ` +
        `{ "text": <the package> }, then cq cloud start ${ids.join(' ')} --run <session-id>.`,
    );
  } else process.stdout.write(`${pkg}\n`);
} else if (command === 'cloud-bundles') {
  // Proposals for bundles of cloud-suitable tasks (the same project/feature one after the other), by priority.
  const max = Number(val('--max') ?? L.CLOUD_BUNDLE_MAX);
  const maxMin = Number(val('--max-min') ?? L.CLOUD_BUNDLE_MIN);
  if (!(max >= 1) || !(maxMin > 0)) die('--max and --max-min must be numbers above 0');
  const queue = read();
  const context = cloudContext();
  const register = queue.projects ?? {};
  const candidates = queue.tasks
    .filter((o) => o.status === 'waiting' && cloudAssess(queue, o, context).suitability.suitable)
    .map((o) => ({
      id: o.id,
      project: L.projectFor(o, register),
      feature: o.feature ?? null,
      estimate: L.estimate(o),
      score: L.score(o, queue.tasks, Date.now(), register),
    }));
  const bundles = L.cloudBundles(candidates, { max, maxMin });
  // --json: machine-readable for queueBoard (the "Cloud" view), with a ready command for cloud-start.mjs per bundle.
  if (a.includes('--json')) {
    const titleJ = new Map(queue.tasks.map((o) => [o.id, o.title ?? '']));
    console.log(
      JSON.stringify({
        bundles: bundles.map((b) => ({
          ids: b.ids,
          minutes: b.minutes,
          areas: b.areas,
          titles: Object.fromEntries(b.ids.map((id) => [id, titleJ.get(id)])),
          command: `${CQ} cloud-start ${b.ids.join(' ')}`,
        })),
        sessions: L.cloudSessions(queue),
        max: L.CLOUD_MAX,
        pushed: Boolean(context.pushedHead),
      }),
    );
    process.exit(0);
  }
  if (!bundles.length)
    console.log(
      `No cloud-suitable tasks now${context.pushedHead ? '' : ` (could not find ${REMOTE}/${BASE})`}.`,
    );
  const title = new Map(queue.tasks.map((o) => [o.id, o.title ?? '']));
  bundles.forEach((b, i) => {
    console.log(
      `Bundle ${i + 1}: ${b.ids.length} task(s), ${b.minutes} min · ${b.areas.join(' + ')}`,
    );
    for (const id of b.ids) console.log(cut(`  ${id.padEnd(12)} ${title.get(id)}`, WIDTH));
    console.log(`  → cq cloud-package ${b.ids.join(' ')} --out <file>`);
  });
  const sessions = L.cloudSessions(queue);
  if (bundles.length) console.log(`\n${sessions} cloud session(s) running now (at most ${L.CLOUD_MAX}).`);
} else if (command === 'cloud') {
  const [under, id, ...more] = positional(1, ['--run', '--sha', '--branch']);
  const force = a.includes('--force');
  if (!under) {
    // Overview: the cloud sessions running, and the pending ones that are suitable.
    const queue = read();
    const inCloud = queue.tasks.filter(L.isCloud);
    console.log(`Cloud sessions (${inCloud.length} of at most ${L.CLOUD_MAX}):`);
    if (!inCloud.length) console.log('  none');
    for (const o of inCloud)
      console.log(
        cut(
          `  ${o.id.padEnd(12)} started ${L.ageText(Date.now() - Date.parse(o.cloud.started))} ago` +
            `${o.cloud.execution ? ` · ${o.cloud.execution}` : ''}  ${o.title ?? ''}`,
          WIDTH,
        ),
      );
    const k = cloudContext();
    const suitable = queue.tasks
      .filter((o) => o.status === 'waiting')
      .filter((o) => cloudAssess(queue, o, k).suitability.suitable)
      .map((o) => ({ o, score: L.score(o, queue.tasks, Date.now(), queue.projects ?? {}) }))
      .sort((x, y) => y.score - x.score || x.o.id.localeCompare(y.o.id));
    console.log(
      `\nSuitable for the cloud now: ${suitable.length}${k.pushedHead ? '' : ` (could not find ${REMOTE}/${BASE})`}`,
    );
    for (const { o } of suitable.slice(0, 15))
      console.log(
        cut(
          `  ${o.id.padEnd(12)} ${o.class.padEnd(2)} ${`${L.estimate(o)} min`.padEnd(7)} ${o.title ?? ''}`,
          WIDTH,
        ),
      );
    if (suitable.length > 15) console.log(`  ... and ${suitable.length - 15} more`);
    if (suitable.length) console.log('\nPackage: cq cloud-package <id> [--out <file>]');
  } else if (under === 'start') {
    // More ids = a bundle in the same cloud session (the same --run).
    const ids = id ? [id, ...more] : [];
    if (!ids.length) die('cloud start <id> [<id> ...] [--run <session-id|url>] [--force]');
    const execution = val('--run') ?? null;
    if (execution != null && (!execution.trim() || execution.length > 300 || /\s/.test(execution)))
      die('--run must be the session id or link (without whitespace, at most 300 chars)');
    // Suitability needs git (the remote's baseBranch and local changes), so it is computed before the lock.
    const queue0 = read();
    const context = cloudContext();
    const suitability = {};
    for (const x of ids) {
      const o0 = queue0.tasks.find((y) => y.id === x);
      if (!o0) die(`Unknown task ${x}`);
      if (!L.isCloud(o0)) suitability[x] = cloudAssess(queue0, o0, context).suitability;
    }
    const r = edit((queue) => {
      const s = L.cloudStart(queue, ids, { suitability, execution, force });
      if (s.error) die(s.error);
      return s;
    });
    for (const x of r.newOnes) logTime(x, 'cloud-start', execution ? `execution ${execution}` : 'without execution');
    if (r.newOnes.length)
      console.log(
        `Started in the cloud: ${r.newOnes.join(', ')}${execution ? ` (${execution})` : ''}. The cloud creates ${branchFor('<id>')} from ${REMOTE}/${BASE}.`,
      );
    if (r.left.length)
      console.log(
        `Already in the cloud: ${r.left.join(', ')}${execution ? `; the run is set to ${execution}` : ''}.`,
      );
    if (r.overridden.length) console.log(`--force overrode: ${r.overridden.join(' · ')}`);
    console.log(
      'When CLOUD-DONE <id> arrives: cq cloud done <id> [--branch <branch the cloud pushed>] [--sha <sha>]. ' +
        'If it gives up (CLOUD-STOP): cq cloud cancel <id>.',
    );
  } else if (under === 'done') {
    if (!id) die('cloud done <id> [--branch <branch>] [--sha <sha>]');
    const o0 = read().tasks.find((x) => x.id === id);
    if (!o0) die(`Unknown task ${id}`);
    if (!L.isCloud(o0)) die(`${id} is not in a cloud session (status ${o0.status}).`);
    const branch = val('--branch') ?? branchFor(id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch) || branch.includes('..'))
      die(`Invalid branch name: ${branch}`);
    const sha = val('--sha') ?? null;
    if (sha != null && !/^[0-9a-f]{7,40}$/i.test(sha)) die(`Invalid sha: ${sha}`);
    // Fetch the branch the cloud pushed (and baseBranch, so the count is against what is pushed now).
    const fetched = git([
      'fetch',
      '-q',
      REMOTE,
      `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`,
      `+refs/heads/${BASE}:refs/remotes/${REMOTE}/${BASE}`,
    ]);
    if (fetched == null)
      die(
        `Could not find ${branch} on ${REMOTE} (git fetch failed). Did the cloud push to another branch? Use --branch <name>.`,
      );
    const remove = `refs/remotes/${REMOTE}/${branch}`;
    const count =
      Number(git(['rev-list', '--count', `refs/remotes/${REMOTE}/${BASE}..${remove}`]) ?? 0) || 0;
    if (count < 1)
      die(`${REMOTE}/${branch} has no commits above ${REMOTE}/${BASE}; nothing to merge.`);
    const tips = git(['rev-parse', remove]);
    if (sha && git(['merge-base', '--is-ancestor', sha, remove]) == null)
      die(`${sha} does not exist on ${REMOTE}/${branch} (tip ${tips?.slice(0, 10)}).`);
    // The local queue branch on the cloud's commits, so merge-track and "Merge branch '<queue branch>'" (the external scan) work as
    // for a local track. If a local queue branch has commits that are not included, we stop instead of overwriting them.
    const local = branchFor(id);
    if (branch !== local) {
      const exists = git(['rev-parse', '-q', '--verify', `refs/heads/${local}`]) != null;
      if (exists && git(['merge-base', '--is-ancestor', `refs/heads/${local}`, remove]) == null)
        die(
          `Local ${local} has commits that are not on ${REMOTE}/${branch}; merge by hand (merge-track.mjs ${REMOTE}/${branch}).`,
        );
      if (git(['branch', '-f', local, remove]) == null)
        die(`Could not set ${local} to ${REMOTE}/${branch} (is it checked out in a worktree?).`);
    } else if (git(['rev-parse', '-q', '--verify', `refs/heads/${local}`]) == null) {
      git(['branch', local, remove]);
    } else if (git(['merge-base', '--is-ancestor', `refs/heads/${local}`, remove]) != null) {
      git(['branch', '-f', local, remove]);
    } else {
      die(`Local ${local} has commits that are not on ${REMOTE}/${branch}; merge by hand.`);
    }
    const r = edit((queue) => {
      const s = L.cloudDone(queue, id, { branch, sha: sha ?? tips });
      if (s.error) die(s.error);
      return s;
    });
    logTime(
      id,
      'cloud-done',
      `${count} commit(s) on ${branch}, ${minutes(r.task.cloud.started, r.task.cloud.done)} min in the cloud`,
    );
    console.log(
      [
        `${id}: completed in the cloud, review. ${count} commit(s) on ${REMOTE}/${branch} (tip ${String(tips).slice(0, 10)}).`,
        'The orchestrator merges:',
        `  1. ${CQ} merge-track ${local}   (local branch = ${REMOTE}/${branch})`,
        `  2. git push ${REMOTE} --delete ${branch}   (after the merge; a fixed claude/... branch would otherwise be reused)`,
        `  3. cq set ${id} done`,
      ].join('\n'),
    );
  } else if (under === 'cancel') {
    if (!id) die('cloud cancel <id>');
    const before = read().tasks.find((x) => x.id === id);
    const g = branchInfo(before?.branch ?? branchFor(id));
    const r = edit((queue) => {
      const s = L.cloudCancel(queue, id, { commits: g.commits });
      if (s.error) die(s.error);
      return s;
    });
    logTime(id, 'cloud-aborted', '');
    console.log(`${id}: the cloud session is aborted, the task is waiting again.`);
    if (r.warning) console.log(`WARNING: ${r.warning}`);
  } else {
    die('cloud [start <id> [--run ...] | done <id> [--branch ...] [--sha ...] | cancel <id>]');
  }
} else if (command === 'batch') {
  // Batch queue. Without arguments: the groups with their sum against the target. `pack`: one new track from the given ids, or
  // proposals for the ready groups (--auto), executed only with --execute.
  if (a[1] !== 'pack') {
    if (a[1]) die('batch [pack <id> <id> ... --id <new-id> [--title "..."] | pack --auto [--execute]]');
    const queue = read();
    const gr = L.batchGroups(queue);
    if (!gr.length) {
      console.log('The batch queue is empty (add small, non-blocking tasks with "batched": true).');
    } else {
      const n = gr.reduce((s, g) => s + g.count, 0);
      const min = gr.reduce((s, g) => s + g.sum, 0);
      console.log(
        `BATCH_QUEUE: ${n} task(s), ${min} content minutes in ${gr.length} group(s). Target per class: ` +
          Object.entries(L.BATCH_MEASURE)
            .map(([k, m]) => `${k} ${m.min}–${m.max} min`)
            .join(', ') +
          '. Ready for packing from the lower target.',
      );
      let previousPid = null;
      for (const g of gr) {
        if (g.pid !== previousPid) {
          console.log(cut(`\n${g.pid}${g.title ? `  ${g.title}` : ''}`, WIDTH));
          previousPid = g.pid;
        }
        console.log(cut(`  ${batchGroupLine(g)}`, WIDTH));
        for (const f of g.features) {
          console.log(cut(`    ${f.feature} (${f.sum} min)`, WIDTH));
          for (const id of f.ids) {
            const o = g.tasks.find((x) => x.id === id);
            const col = `      ${o.id.padEnd(14)} ${`${o.content_min} min`.padEnd(8)} ${o.status === 'proposed' ? 'proposed ' : ''}`;
            console.log(col + cut(o.title, WIDTH - col.length));
          }
        }
        if (g.common_files.length)
          console.log(cut(`    shared files: ${g.common_files.join(', ')}`, WIDTH));
      }
      if (gr.some((g) => g.ready))
        console.log('\nSuggested packages: cq batch pack --auto (executed with --execute).');
    }
  } else if (a.includes('--auto')) {
    const execute = a.includes('--execute');
    const proposed = L.batchSuggestion(read());
    if (!proposed.length) {
      console.log('No groups in the batch queue are ready for packing.');
    } else if (!execute) {
      console.log(`Proposed (${proposed.length}; execute all with cq batch pack --auto --execute):`);
      for (const f of proposed)
        console.log(
          f.out
            ? `  ${f.pid} ${f.class}: ${f.parts[0]} has ${f.sum} min alone; take it out: ` +
                `cq edit ${f.parts[0]} --json '{"batched":false}'`
            : `  ${f.pid} ${f.class}, ${f.sum} min: cq batch pack ${f.parts.join(' ')} --id ${f.id}`,
        );
    } else {
      // All the proposals in one write under the lock: all or nothing (the proposals are recomputed inside the lock).
      const r = batchPackExecute((queue) => L.batchSuggestion(queue).map((f) => ({ ...f, title: null })));
      for (const p of r) console.log(batchExecutedLine(p));
    }
  } else {
    const ids = positional(2, ['--id', '--title', '--expect-changed', '--by']);
    const newId = val('--id');
    if (!ids.length || !newId) die('batch pack <id> <id> ... --id <new-id> [--title "..."]');
    const r = batchPackExecute(() => [
      { id: newId, parts: ids, title: val('--title') ?? null, out: false },
    ]);
    for (const p of r) console.log(batchExecutedLine(p));
  }
} else if (command === 'area') {
  // ---- Areas, focus and parking ----
  const oid = a[1];
  if (!oid || oid.startsWith('--'))
    die(
      'area <oid> [--title "..."] [--description "..."] [--projects <pid> ...] [--remove <pid> ...] | area <oid> --delete',
    );
  const field = {};
  if (val('--title') != null) field.title = val('--title');
  if (a.includes('--description')) field.description = val('--description') || null;
  if (a.includes('--projects')) field.projects = values('--projects');
  if (a.includes('--remove')) field.remove = values('--remove');
  if (a.includes('--delete')) field.delete = true;
  const r = edit((queue) => {
    // The board sends --expect-changed (the queue's version from the preview); exit 6 when the queue has changed since.
    checkExpect(queue);
    const s = L.setArea(queue, oid, field);
    if (s.error.length) die(`Nothing changed:\n  ${s.error.join('\n  ')}`);
    return s;
  });
  if (r.deleted) console.log(`Deleted area ${oid}.`);
  else
    console.log(
      `${r.new ? 'Created' : 'Changed'} area ${oid}: ${JSON.stringify(r.area)}` +
        `${r.moved.length ? `; projects in: ${r.moved.join(', ')}` : ''}` +
        `${r.removed.length ? `; taken out: ${r.removed.join(', ')}` : ''}`,
    );
} else if (command === 'areas') {
  const queue = read();
  if (!Object.keys(queue.areas ?? {}).length)
    console.log(
      'No areas yet: create one with cq area <oid> --title "..." --projects <pid> ...\n',
    );
  for (const r of L.areaOverview(queue)) {
    const parts = [
      `${r.waiting} waiting`,
      `${r.readyOnes} ready`,
      `${r.min_left} min left`,
      r.activeOnes ? `${r.activeOnes} active` : null,
      r.parked ? `${r.parked} parked` : null,
      !r.in_register && r.oid !== L.WITHOUT_AREA ? 'not in the register' : null,
    ].filter(Boolean);
    console.log(cut(`${r.oid.padEnd(18)} ${parts.join(' · ')}`, WIDTH));
    const info = [r.title, r.description].filter(Boolean).join(' · ');
    if (info) console.log(`  ${cut(info, WIDTH - 2)}`);
    if (r.projects.length)
      console.log(`  ${cut(`projects: ${r.projects.join(', ')}`, WIDTH - 2)}`);
  }
} else if (command === 'focus') {
  const under = a[1];
  if (under === 'set') {
    const order = positional(2, ['--rest', '--to', '--name', '--by']);
    const rest = val('--rest');
    const r = edit((queue) => {
      const s = L.setFocus(queue, {
        order,
        rest: rest ?? undefined,
        to: val('--to') ?? null,
        name: val('--name') ?? null,
        drag_with_dependencies: !a.includes('--without-dependencies'),
        set_by: val('--by') ?? null,
      });
      if (s.error.length) die(`Focus not changed:\n  ${s.error.join('\n  ')}`);
      return { s, text: L.focusText(queue) };
    });
    console.log(`Focus set: ${r.text}`);
    for (const x of r.s.warnings) console.log(`WARNING: ${x}`);
  } else if (under === 'save') {
    // The plan view on the board saves the focus and the pause changes (the "Waiting" column) in ONE change, all or
    // nothing (queueLogic.saveFocusPlan). --dry computes on a copy and writes nothing; --expect-changed refuses with
    // exit 6 when the queue has changed after the preview; --json answers with one JSON line (for the board).
    const file = val('--file');
    if (!file)
      die('focus save --file <plan.json> [--dry] [--expect-changed <iso>] [--json] [--by "..."]');
    let input;
    try {
      input = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      die(`could not read ${file}: ${e?.message ?? e}`);
    }
    const json = a.includes('--json');
    const now = new Date().toISOString();
    const plan = { ...input, set_by: val('--by') ?? input?.set_by ?? null };
    const errorOut = (s) => {
      if (!json) die(`Focus not changed:\n  ${s.join('\n  ')}`);
      console.log(JSON.stringify({ ok: false, error: s }));
      if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
      process.exit(1);
    };
    const answer = (queue, r, dry) => {
      if (json)
        console.log(
          JSON.stringify({
            ok: true,
            dry,
            changed: queue.changed ?? null,
            focus: r.focus,
            removed: r.removed,
            paused: r.paused,
            still: r.still,
            warnings: r.warnings,
          }),
        );
      else {
        console.log(
          `${dry ? 'Dry run (nothing written): ' : ''}` +
            (r.focus ? `focus ${L.focusText({ ...queue, focus: r.focus })}` : 'no focus') +
            `${r.paused.length ? ` · pause: ${r.paused.join(', ')}` : ''}` +
            `${r.still.length ? ` · continues: ${r.still.join(', ')}` : ''}`,
        );
        for (const x of r.warnings) console.log(`WARNING: ${x}`);
      }
    };
    if (a.includes('--dry')) {
      const queue = read();
      checkExpect(queue);
      const r = L.saveFocusPlan(L.cloneJson(queue), plan, now);
      if (r.error.length) errorOut(r.error);
      answer(queue, r, true);
    } else {
      let after = null;
      const r = edit((queue) => {
        checkExpect(queue);
        const s = L.saveFocusPlan(queue, plan, now);
        if (s.error.length) errorOut(s.error);
        after = queue;
        return s;
      });
      answer(after, r, false);
    }
  } else if (under === 'evaluate') {
    // The evaluation of each stage (queueLogic.evaluateFocusStep), with the rests and suggestions.
    const queue = read();
    const ev = L.evaluateFocusStep(queue);
    if (a.includes('--json')) {
      console.log(JSON.stringify({ ok: true, focus: !!queue.focus, stages: ev }));
    } else if (!ev.length) console.log('No focus set (cq focus set ...).');
    else {
      const max = a.includes('--all') ? Infinity : 10;
      for (const t of ev) {
        console.log(
          cut(
            `T${t.index + 1} ${t.title} (${t.stage}): ${t.status} · ${t.open} open · ${t.ready} ready · ` +
              `${t.min_left} min left${t.rests.length ? ` · ${t.rests.length} rest(s)` : ''}`,
            WIDTH,
          ),
        );
        for (const r of t.rests.slice(0, max)) console.log(cut(`    ${L.restText(r)}`, WIDTH));
        if (t.rests.length > max) console.log(`    … and ${t.rests.length - max} more (--all shows all)`);
      }
      const done = ev.filter((t) => t.status === 'done').length;
      if (done) console.log(`${done} stage(s) are done: cq focus clean takes them out.`);
    }
  } else if (under === 'clean') {
    // Takes out the stages with status done (queueLogic.cleanFocus); --dry computes without writing.
    const dry = a.includes('--dry');
    const r = dry
      ? L.cleanFocus(L.cloneJson(read()), { by: byName(), dry: true })
      : edit((queue) => L.cleanFocus(queue, { by: byName() }));
    if (dry) console.log(`Dry run (nothing written): ${r.taken_out.length} stage(s) would be taken out.`);
    if (!r.taken_out.length) console.log('No done focus stages to take out.');
    for (const l of L.focusCleanLines(r)) console.log(l);
    if (r.entry) console.log(`Changelog no. ${r.entry.nr}; undo: cq undo`);
  } else if (under === 'off') {
    const oldOne = edit((queue) => L.removeFocus(queue));
    console.log(
      oldOne
        ? 'Focus removed: the queue is ranked as before (score and projectBonus).'
        : 'No focus was set.',
    );
  } else if (under && !under.startsWith('--')) {
    die(
      'focus | focus set <stage> [<stage> ...] [--rest wait|fill] [--to <date>] [--name "..."] [--without-dependencies] | focus evaluate [--json] | focus clean [--dry] | focus off',
    );
  } else {
    const queue = read();
    if (!queue.focus) {
      console.log(
        'No focus set: the queue is ranked by score and projectBonus.\n' +
          'Set: cq focus set area:<oid> project:<pid> feature:<pid>/<name> ... [--rest wait|fill] [--to <date>]',
      );
    } else {
      const uncommitted = uncommittedPaths();
      const canStart = L.selectNext(queue, Date.now(), { uncommitted });
      const st = L.focusStatus(queue, { canStart: canStart.map((v) => v.id) });
      console.log(cut(`FOCUS${st.name ? ` "${st.name}"` : ''}: ${st.text}`, WIDTH));
      const f = queue.focus;
      console.log(
        `  set ${f.from ?? '?'}${f.set_by ? ` by ${f.set_by}` : ''}` +
          ` · drag along dependencies: ${f.drag_with_dependencies === false ? 'no' : 'yes'}` +
          `${st.expired ? ' · EXPIRED' : ''}${st.not_started ? ' · not started yet' : ''}`,
      );
      if (st.active) {
        // Done stages and stages with only rests are marked (the details: cq focus evaluate).
        const ev = L.evaluateFocusStep(queue);
        const mark = (e) =>
          e?.status === 'done'
            ? ' · DONE (cq focus clean)'
            : e?.status === 'done-with-rests'
              ? ` · DONE WITH ${e.rests.length} REST(S) (cq focus evaluate)`
              : '';
        st.per_step.forEach((t, i) =>
          console.log(
            cut(
              `  T${i + 1} ${t.stage.padEnd(30)} ${t.waiting} waiting · ${t.readyOnes} ready · ${t.min_left} min left${mark(ev[i])}`,
              WIDTH,
            ),
          ),
        );
        console.log(
          `  ${st.readyOnes} ready in focus · ${st.inProgress} in progress · ${st.dragged_with} dragged along · ${st.can_start} can start now`,
        );
        const dragged = L.draggedWith(queue);
        if (dragged.size) {
          const list = [...dragged.entries()]
            .slice(0, 12)
            .map(([id, d]) => `${id} (T${d.stage + 1}, by ${d.by})`)
            .join(', ');
          console.log(
            cut(`  Dragged along: ${list}${dragged.size > 12 ? ` +${dragged.size - 12}` : ''}`, WIDTH),
          );
        }
        if (st.ownerQuestion.length)
          console.log(
            cut(
              `  Owner questions in focus: ${st.ownerQuestion
                .slice(0, 5)
                .map((s) => `${s.sp} (${s.tasks})`)
                .join(' · ')}`,
              WIDTH,
            ),
          );
        console.log('NEXT UP:');
        if (!canStart.length) console.log('  nothing can start now (see show and state)');
        for (const v of canStart)
          console.log(
            cut(
              `  ${v.id.padEnd(12)} ${v.class.padEnd(3)} ${`${v.estimate} min`.padEnd(8)} prio ${v.score}  ${L.stepText(v)}`,
              WIDTH,
            ),
          );
      }
      if (st.notice) console.log(`NOTICE: ${st.notice}`);
    }
  }
} else if (command === 'park') {
  const ids = positional(1, ['--reason', '--to', '--by', '--expect-changed']);
  const r = editLogged('park', (queue) => {
    const s = L.park(queue, ids, {
      by: val('--by'),
      reason: val('--reason') ?? null,
      to: val('--to') ?? null,
    });
    if (s.error.length) die(`Nothing parked:\n  ${s.error.join('\n  ')}`);
    return s;
  });
  console.log(
    `Parked (stays until cq continue${val('--to') ? ' or the date' : ''}): ${r.parked.join(', ')}`,
  );
  for (const x of r.warnings) console.log(`WARNING: ${x}`);
  if (undoHint()) console.log(undoHint());
} else if (command === 'continue') {
  const ids = positional(1, ['--by', '--expect-changed']);
  const r = editLogged('continue', (queue) => {
    const s = L.continue(queue, ids);
    if (s.error.length) die(`Nothing changed:\n  ${s.error.join('\n  ')}`);
    return s;
  });
  if (r.still.length) console.log(`Off hold: ${r.still.join(', ')}`);
  if (r.notParked.length) console.log(`Was not parked: ${r.notParked.join(', ')}`);
  if (undoHint()) console.log(undoHint());
} else if (command === 'rank') {
  // ---- Block moves ----
  // Moves tasks together within the focus stage and keeps the order they had among themselves (queueLogic.rankBlock), by
  // writing new priority_bonus values in one edit-many (all or nothing).
  const ids = positional(1, ['--over', '--under', '--by', '--expect-changed']);
  const space = {
    top: a.includes('--top'),
    bottom: a.includes('--bottom'),
    over: val('--over') ?? null,
    under: val('--under') ?? null,
  };
  const now = new Date().toISOString();
  // --json gives the answer (and the errors) as JSON for the board, like edit-many --json.
  const json = a.includes('--json');
  const no = (error) => {
    if (!json) die(`Nothing moved:\n  ${error.join('\n  ')}`);
    console.log(JSON.stringify({ ok: false, error }));
    if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
    process.exit(1);
  };
  const compute = (queue) => {
    const rb = L.rankBlock(queue, ids, space, Date.parse(now));
    if (rb.error.length) no(rb.error);
    const tasks = Object.entries(rb.changes).map(([id, t]) => ({ id, priority_bonus: t }));
    return { rb, tasks };
  };
  if (a.includes('--dry')) {
    const queue = read();
    checkExpect(queue);
    const { rb, tasks } = compute(queue);
    const s = L.editMany(queue, tasks, { by: byName(), now, dry: true });
    if (s.error.length) no(s.error);
    if (json)
      console.log(
        JSON.stringify({
          ok: true,
          dry: true,
          changed: queue.changed ?? null,
          changes: s.changes,
          warnings: rb.warnings,
        }),
      );
    else {
      console.log(
        `Dry run (nothing written): ${s.changes.length} priorit(ies) changed. The queue's version: ${queue.changed ?? '(none)'}`,
      );
      for (const l of L.diffLines(s.changes)) console.log(`  ${l}`);
      for (const x of rb.warnings) console.log(`WARNING: ${x}`);
    }
  } else {
    const r = editLogged('rank', (queue) => {
      const { rb, tasks } = compute(queue);
      const s = L.editMany(queue, tasks, { by: byName(), now });
      if (s.error.length) no(s.error);
      return { ...s, warnings: rb.warnings };
    });
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          changed: r.changed,
          changes: r.changes,
          warnings: r.warnings,
          log: lastEntry?.nr ?? null,
        }),
      );
      process.exit(0);
    }
    const where = space.top
      ? 'at the top of the stage'
      : space.bottom
        ? 'at the bottom of the stage'
        : space.over
          ? `right above ${space.over}`
          : `right below ${space.under}`;
    console.log(`Moved ${r.changed.length} task(s) ${where}: ${r.changed.join(', ')}`);
    for (const x of r.warnings) console.log(`WARNING: ${x}`);
    if (undoHint()) console.log(undoHint());
  }
} else if (command === 'undo') {
  // ---- Undo the last change ----
  // Rolls back the last changelog entry that is not undone, when the fields still have the values the entry set.
  const json = a.includes('--json');
  const entryText = (p) =>
    `no. ${p.nr} ${p.action} by ${p.by} ${p.at} (${p.changes.length} field(s))`;
  // --nr <n> = undo only when the last undoable entry is no. n (the board's "Undo" after a bulk action;
  // if someone else has written a logged change since, theirs is not undone instead).
  const nrError = (queue) => {
    if (val('--nr') == null) return null;
    const last = L.lastUndoable(queue);
    return last && String(last.nr) === String(val('--nr'))
      ? null
      : `the last change that can be undone is ${last ? `no. ${last.nr} (${last.action} by ${last.by})` : 'none'}, not no. ${val('--nr')}; nothing undone`;
  };
  if (a.includes('--show')) {
    const queue0 = read();
    const nf = nrError(queue0);
    const s = nf ? { error: [nf], entry: L.lastUndoable(queue0) } : L.undoEntry(queue0, { show: true });
    if (json)
      console.log(JSON.stringify({ ok: !s.error.length, error: s.error, entry: s.entry ?? null }));
    else if (!s.entry) console.log(s.error.join('\n'));
    else {
      console.log(`Last undoable: ${entryText(s.entry)}`);
      for (const l of L.diffLines(s.entry.changes)) console.log(`  ${l}`);
      console.log(
        s.error.length
          ? `Can NOT be undone now:\n  ${s.error.join('\n  ')}`
          : 'Can be undone (cq undo).',
      );
    }
  } else {
    const now = new Date().toISOString();
    const r = edit((queue) => {
      checkExpect(queue);
      const nf = nrError(queue);
      const s = nf ? { error: [nf], entry: null } : L.undoEntry(queue, { by: byName(), now });
      if (s.error.length) {
        if (json) {
          console.log(JSON.stringify({ ok: false, error: s.error, entry: s.entry ?? null }));
          if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
          process.exit(1);
        }
        die(`Nothing undone${s.entry ? ` (${entryText(s.entry)})` : ''}:\n  ${s.error.join('\n  ')}`);
      }
      return s;
    });
    if (json) console.log(JSON.stringify({ ok: true, entry: r.entry }));
    else {
      console.log(`Undone ${entryText(r.entry)}:`);
      for (const l of L.diffLines(
        r.entry.changes.map((e) => ({ ...e, before: e.after, after: e.before })),
      ))
        console.log(`  ${l}`);
    }
  }
} else if (command === 'plan') {
  // ---- The plan register (see the top of the file and lib/queuePlan.js) ----
  planCommand();
} else if (command === 'classify') {
  // ---- Project proposals ----
  // The same proposals add prints (queueLogic.suggestProject): longest prefix, the plan in source/mission, fileRoot. Without
  // --execute nothing is changed.
  const json = a.includes('--json');
  const rowText = (r) => `  ${r.id.padEnd(14)} ${r.now} → ${r.proposed ?? '?'}  (${r.reason})`;
  if (val('--file')) {
    const content = JSON.parse(fs.readFileSync(val('--file'), 'utf8'));
    const newOnes =
      content && !Array.isArray(content) && content.id === undefined && 'tasks' in content
        ? [].concat(content.tasks ?? [])
        : [].concat(content);
    const register = read().projects ?? {};
    const rows = newOnes.map((n) => ({ id: n?.id ?? '(without id)', ...L.suggestProject(n, register) }));
    if (json) console.log(JSON.stringify({ ok: true, proposed: rows }));
    else
      for (const r of rows)
        console.log(
          `  ${String(r.id).padEnd(14)} ${r.pid ?? 'Sort'}${r.signal ? ` (${r.signal})` : ''}: ${r.reason}${r.safe ? '' : ' [uncertain]'}`,
        );
  } else {
    const filter = { withoutProject: a.includes('--without-project'), disagreeing: a.includes('--disagree') };
    if (a.includes('--execute')) {
      const r = editLogged('classify', (queue) => {
        const k = L.classifyQueue(queue, filter);
        if (!k.move.length) return { ...k, changed: [] };
        const s = L.editMany(
          queue,
          k.move.map((x) => ({ id: x.id, project: x.proposed })),
          { by: byName() },
        );
        if (s.error.length) die(`Nothing changed:\n  ${s.error.join('\n  ')}`);
        return { ...k, changed: s.changed };
      });
      if (json) console.log(JSON.stringify({ ok: true, ...r, log: lastEntry?.nr ?? null }));
      else {
        console.log(`Set project on ${r.changed.length} task(s).`);
        for (const x of r.move) console.log(rowText(x));
        if (r.sort.length)
          console.log(`Sort (${r.sort.length}; decided by the owner, not changed automatically):`);
        for (const x of r.sort) console.log(rowText(x));
        if (undoHint()) console.log(undoHint());
      }
    } else {
      const k = L.classifyQueue(read(), filter);
      if (json) console.log(JSON.stringify({ ok: true, ...k }));
      else {
        console.log(
          `Proposed (${k.move.length}; set with cq classify --execute${filter.withoutProject ? ' --without-project' : ''}${filter.disagreeing ? ' --disagree' : ''}):`,
        );
        for (const x of k.move) console.log(rowText(x));
        console.log(
          `Sort (${k.sort.length}; uncertain or disagreeing, fix with cq edit-many --file <json> [{ "id", "project" }]):`,
        );
        for (const x of k.sort) console.log(`${rowText(x)} [${x.type}]`);
        const pre = L.prefixWarnings(read().projects ?? {});
        for (const x of pre) console.log(`WARNING: ${x}`);
      }
    }
  }
} else if (command === 'handover') {
  // ---- The ongoing handover note in two parts (rules: lib/queueHandover.js) ----
  handoverCommand();
} else if (command === 'follow') {
  // ---- The "Follow up" entries (see the top of the file and lib/queueFollow.js) ----
  followCommand();
} else {
  die(
    'Use: cq <init|add|approve|show|next|start|set|edit|resolve|resolutions|question|limit|state|trackFile|' +
      'projects|project|edit-many|pickable|pick|deliver|release|qa|external|orchestrator|cloud|cloud-package|batch|' +
      'area|areas|focus|park|continue|rank|undo|classify|plan|fill|receive|merge|info|activeOnes|next-migr|migr|' +
      'capacity|compact|diagnose|cost|handover|deliveries|resume|follow> ...  (see the top of the file)',
    command ? 1 : 0,
  );
}

// ---- queue.mjs cloud: suitability with git --------------------------------------------------------------------
/** <remote>/<baseBranch> and the paths changed locally since it (committed and not pushed, plus uncommitted). */
function cloudContext() {
  const pushedHead =
    gitRead(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${BASE}`])?.trim() || null;
  const changed = new Set();
  if (pushedHead) {
    const diff = gitRead(['diff', '--name-only', `refs/remotes/${REMOTE}/${BASE}...${BASE}`]);
    for (const s of String(diff ?? '').split('\n')) if (s.trim()) changed.add(s.trim());
  }
  for (const s of uncommittedPaths()) changed.add(s);
  return { pushedHead, changed: [...changed] };
}

/** The mission text and the suitability for one task. */
function cloudAssess(queue, o, context = cloudContext()) {
  const file = missionFile(o);
  const text = file ? fs.readFileSync(file, 'utf8') : String(o.mission ?? '');
  const ownPath = file ? String(o.mission) : null;
  const suitability = L.cloudSuitable(queue, o.id, { ...context, missionText: text, ownPath });
  return { text, ownPath, suitability };
}

// ---- queue.mjs external: scanning (read-only) ---------------------------------------------------------------------
function externalWindow(queue) {
  if (a.includes('--all')) {
    const times = queue.tasks
      .filter((o) => !L.isExternalRow(o) && L.COLLISION_STATUSES.includes(o.status))
      .map((o) => Date.parse(o.added_at ?? ''))
      .filter(Number.isFinite);
    const ms = times.length ? Math.min(...times) : Date.now() - 86_400_000;
    return {
      window: { since: new Date(ms).toISOString() },
      text: 'since the oldest task in progress was added',
    };
  }
  const s = val('--since');
  if (s) {
    const m = /^(\d+)\s*([hd])$/i.exec(s);
    if (m) {
      const ms = Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3_600_000 : 86_400_000);
      return { window: { since: new Date(Date.now() - ms).toISOString() }, text: `last ${s}` };
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(Date.parse(s)))
      return { window: { since: new Date(Date.parse(s)).toISOString() }, text: `since ${s}` };
    return { window: { from: s }, text: `${s}..${BASE}` };
  }
  if (gitRead(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${BASE}`]) != null)
    return {
      window: { from: `${REMOTE}/${BASE}` },
      text: `not pushed (${REMOTE}/${BASE}..${BASE})`,
    };
  return {
    window: { since: new Date(Date.now() - 86_400_000).toISOString() },
    text: `last 24 h (could not find ${REMOTE}/${BASE})`,
  };
}

function externalScan() {
  const queue = read();
  // --id <id>: only that one task, with the window from when it was added (the same check start/pick/trackFile do).
  const onlyId = val('--id');
  if (onlyId) {
    const o = queue.tasks.find((x) => x.id === onlyId);
    if (!o) die(`Unknown task ${onlyId}`);
    const v = G.externalForTasks(gitRead, [{ ...o, status: 'waiting' }]).get(onlyId);
    for (const f of v.error) console.log(`WARNING: ${f}`);
    console.log(
      `${onlyId} (${o.status}), added ${o.added_at ?? '?'}: ${v.collisions.length} collision(s), ` +
        `${v.mentioned.length} commit(s) outside the queue that mention the id.`,
    );
    for (const k of v.collisions) console.log(`  ${L.collisionText(k, { withId: false })}`);
    for (const c of v.mentioned)
      console.log(
        `  mentioned in ${c.summary} "${c.subject}"${o.status === 'waiting' ? ` -> completed? cq external accept ${onlyId} ${c.summary}` : ''}`,
      );
    if (!v.collisions.length && !v.mentioned.length)
      console.log('  Nothing outside the queue affects it.');
    return;
  }
  const { window, text } = externalWindow(queue);
  const b = G.externalImage(gitRead, queue, { window });
  if (a.includes('--json')) {
    // Without the message texts (long); subject, files and source are enough.
    const without = (c) => ({
      ...c,
      message: undefined,
      side: (c.side ?? []).map((s) => ({ sha: s.sha, subject: s.subject, source: s.source })),
    });
    console.log(
      JSON.stringify(
        { window: text, ...b, commits: b.commits.map(without), externalOnes: b.externalOnes.map(without) },
        null,
        2,
      ),
    );
    return;
  }
  const max = Number(val('--max') ?? 20) || 20;
  const date = (d) =>
    String(d ?? '')
      .slice(0, 16)
      .replace('T', ' ');
  const fileText = (files, n = 6) =>
    files.length
      ? `${files.slice(0, n).join(', ')}${files.length > n ? ` (+${files.length - n})` : ''}`
      : '(no files)';
  const out = [`Work outside the queue (window: ${text}):`];
  for (const f of b.error) out.push(`WARNING: ${f}`);

  // (a) Commits on baseBranch that do not come from the queue.
  const countOf = (k) => b.commits.filter((c) => c.source === k).length;
  out.push('');
  out.push(
    `(a) Commits on ${BASE} that do not come from the queue: ${b.externalOnes.length} ` +
      `(of ${b.commits.length} on the first-parent line; ${countOf('queue')} from the queue, ${countOf('orchestrator')} from the orchestrator)`,
  );
  const perSha = new Map();
  for (const s of b.consistency) perSha.set(s.sha, [...(perSha.get(s.sha) ?? []), s]);
  for (const c of b.externalOnes.slice(0, max)) {
    out.push(`  ${c.summary}  ${date(c.date)}  ${cut(c.subject, WIDTH - 30)}`);
    out.push(`            files: ${cut(fileText(c.files), WIDTH - 19)}`);
    const side = (c.side ?? []).filter((s) => s.source === 'external');
    if (side.length) out.push(`            merge that brings in ${side.length} commit(s) outside the queue`);
    const mentions = perSha.get(c.sha) ?? [];
    if (mentions.length)
      out.push(`            mentions: ${mentions.map((s) => `${s.id} (${s.status})`).join(', ')}`);
  }
  if (b.externalOnes.length > max) out.push(`  ... and ${b.externalOnes.length - max} older (--max N)`);

  // (b) Branches and worktrees outside the queue branches.
  out.push('');
  out.push(
    `(b) Branches and worktrees outside ${PREFIX}* with commits that are not in ${BASE}: ${b.branches.length}`,
  );
  for (const g of b.branches) {
    out.push(
      `  ${g.name}  ${g.count} commit(s)${g.last ? `, last ${date(g.last)}` : ''}${g.worktree ? `  worktree ${g.worktree}` : ''}`,
    );
    out.push(`            files: ${cut(fileText(g.files), WIDTH - 19)}`);
  }

  // (c) Uncommitted in the main tree.
  const theTrack = b.uncommitted.filter((u) => !u.untracked);
  const untracked = b.uncommitted.filter((u) => u.untracked);
  out.push('');
  out.push(
    `(c) Uncommitted in the main tree: ${theTrack.length} changed, ${untracked.length} untracked${untracked.length && !a.includes('--untracked') ? ' (--untracked shows them)' : ''}`,
  );
  for (const u of [...theTrack, ...(a.includes('--untracked') ? untracked : [])].slice(0, 40))
    out.push(`  ${u.xy.trim().padEnd(2)} ${u.path}`);

  // Registered outside the queue, and tasks without a project or feature.
  out.push('');
  out.push(`Registered outside the queue (external add): ${b.registered.length || 'none'}`);
  for (const o of b.registered)
    out.push(
      cut(
        `  ${o.id}  "${o.external_name}"  ${[...(o.owned_files ?? []), ...(o.owner_db ?? [])].join(', ')}${o.branch ? `  branch ${o.branch}` : ''}`,
        WIDTH,
      ),
    );
  const { withoutProject, withoutFeature } = b.missing;
  // Tasks added without a project or feature (e.g. by another session without /add-to-queue).
  const idText = (ids) => `${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ' ...' : ''}`;
  const missing = [
    withoutProject.length ? `without project ${withoutProject.length} (${idText(withoutProject)})` : null,
    withoutFeature.length ? `without feature ${withoutFeature.length} (${idText(withoutFeature)})` : null,
  ].filter(Boolean);
  if (missing.length) {
    out.push(cut(`Tasks in progress ${missing.join('; ')}.`, WIDTH));
    out.push('  Fix with cq edit-many --file <json> ([{ "id", "project", "feature" }]).');
  }

  // Collisions and consistency.
  out.push('');
  out.push(
    `Collisions with the owned files (running, picked, in review, pending): ${b.collisions.length}`,
  );
  for (const k of b.collisions.slice(0, 30))
    out.push(
      cut(`  ${L.collisionText(k).replace(`${k.id}: `, `${k.id} (${k.status}): `)}`, WIDTH),
    );
  if (b.collisions.length > 30) out.push(`  ... and ${b.collisions.length - 30} more (--json)`);
  const proposed = b.consistency.filter((s) => s.proposed);
  if (proposed.length) {
    out.push('');
    out.push(
      'Consistency: external commits mention pending tasks. Are they completed? Accept only after looking at the commit:',
    );
    for (const s of proposed) out.push(cut(`  ${s.proposed}   "${s.subject}"`, WIDTH));
  }
  console.log(out.join('\n'));
}

// ---- queue.mjs handover: the ongoing note in two parts ---------------------------------------------------------
/**
 * `handover archive [--dry]` and `handover now`. The orchestrator edits the note by hand (not under the queue lock), so
 * the write is atomic (tmp + rename), and the archive is written BEFORE the note: if the call crashes midway, the lines
 * are in both files (never in neither). The rules live in lib/queueHandover.js.
 */
function handoverCommand() {
  const sub = a[1];
  const note = path.join(FOLDER, 'handover-ongoing.md');
  const archiveFolder = path.join(FOLDER, 'handover-archive');
  if (sub !== 'archive' && sub !== 'now') die('Use: cq handover <archive [--dry]|now>');
  let text = '';
  try {
    text = fs.readFileSync(note, 'utf8');
  } catch {
    die(`Could not find ${note}`);
  }
  if (sub === 'now') {
    const part = HO.nowPart(text);
    if (part === null) die('The note has no "## Now" section.');
    console.log(part);
    return;
  }
  const dry = a.includes('--dry');
  const now = new Date();
  const r = HO.archive(text, now);
  const months = Object.keys(r.archive).sort();
  if (!dry && r.moved > 0) {
    fs.mkdirSync(archiveFolder, { recursive: true });
    for (const m of months)
      fs.appendFileSync(path.join(archiveFolder, `${m}.md`), HO.archiveAddition(r.archive[m], now));
    const tmp = `${note}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, r.keep);
    fs.renameSync(tmp, note);
  }
  const before = text.replace(/\r\n/g, '\n').split('\n').length;
  const after = r.keep.split('\n').length;
  console.log(
    `${dry ? '(dry run, nothing written) ' : ''}handover archive: ${r.moved} entries ` +
      `(${r.movedLines} lines) ${dry ? 'would be moved' : 'moved'}` +
      (months.length ? ` to handover-archive/${months.map((m) => `${m}.md`).join(', ')}` : '') +
      `; the note ${before} -> ${after} lines; "Now" ${r.nowLines ?? '-'} lines (limit ${HO.NOW_MAX_LINES}).`,
  );
  for (const w of r.warnings) console.log(`WARNING: ${w}`);
}

// ---- queue.mjs follow: the "Follow up" entries in <dataFolder>/follow.json under the queue's lock ------------------
// (FOLLOW_FILE and FOLLOW_REPORTS are defined at the top with the other paths: the dispatch above runs before this line.)
function readFollow() {
  if (!fs.existsSync(FOLLOW_FILE)) return F.emptyRegister();
  return F.normalize(JSON.parse(fs.readFileSync(FOLLOW_FILE, 'utf8')));
}
function writeFollow(reg) {
  reg.changed = new Date().toISOString();
  const tmp = `${FOLLOW_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  fs.renameSync(tmp, FOLLOW_FILE);
}
/**
 * Changes the follow-up register under the queue's lock, ALL OR NOTHING: `fn(reg, today)` gives { error, entry }; an error
 * gives exit 1 and no write. Active entries past their end date are stored as to-report in the same write.
 */
function editFollow(fn) {
  return withLock(() => {
    const reg = readFollow();
    const today = F.dayDate(new Date());
    const answer = fn(reg, today);
    if (answer.error?.length) die(`Nothing changed:\n  ${answer.error.join('\n  ')}`);
    F.updateDue(reg, today);
    writeFollow(reg);
    return answer;
  });
}
/** The follow-up lines for show and orchestrator pulse. An error (e.g. a broken follow.json) never stops the command. */
function followLines({ pulse = false } = {}) {
  try {
    return F.shortLines(readFollow(), F.dayDate(new Date()), { pulse });
  } catch (e) {
    return [`WARNING: could not read ${FOLLOW_FILE} (${e?.message ?? e}); see ${CQ} follow.`];
  }
}
/** The path to the report file, relative to the main tree when it lives there (like the mission field). */
function followReportPath(id) {
  return missionRef(path.join(FOLLOW_REPORTS, `${id}-report.md`));
}
function writeFollowReport(p) {
  fs.mkdirSync(FOLLOW_REPORTS, { recursive: true });
  const file = path.join(FOLLOW_REPORTS, `${p.id}-report.md`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, F.reportText(p, { now: new Date().toISOString() }));
  fs.renameSync(tmp, file);
  return file;
}

/** `follow [add|log|show|report|close|extend]`; the rules live in lib/queueFollow.js. */
function followCommand() {
  const [sub, id] = positional(1, ['--file', '--text', '--value', '--source', '--decision', '--to']);
  const now = new Date().toISOString();
  const today = F.dayDate(new Date());
  if (!sub) {
    for (const l of F.listLines(readFollow(), today)) console.log(cut(l, WIDTH));
    return;
  }
  if (sub === 'add') {
    const file = val('--file');
    if (!file) die(`Use: ${CQ} follow add --file <json>`);
    let input;
    try {
      input = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      die(`Could not read ${file}: ${e?.message ?? e}`);
    }
    const s = editFollow((reg) => F.add(reg, input, { now }));
    console.log(
      `Added ${s.entry.id} (${s.entry.start} -> ${s.entry.end}, ${s.entry.goals.length} goal(s)). ` +
        `Log along the way: ${CQ} follow log ${s.entry.id} --text "..." [--value name=x].`,
    );
    return;
  }
  if (!id) die(`Use: ${CQ} follow ${sub} <id> ...`);
  if (sub === 'show') {
    const p = readFollow().entries.find((x) => x.id === id);
    if (!p) die(`Unknown follow-up entry ${id} (${CQ} follow lists them)`);
    for (const l of F.showLines(p, today)) console.log(l);
  } else if (sub === 'log') {
    const measured = {};
    for (const v of values('--value')) {
      const i = v.indexOf('=');
      if (i <= 0) die(`--value "${v}" must be name=value`);
      measured[v.slice(0, i)] = v.slice(i + 1);
    }
    editFollow((reg) =>
      F.log(reg, id, { text: val('--text'), values: measured, source: val('--source') }, { now }),
    );
    console.log(`Logged in ${id}.`);
  } else if (sub === 'report') {
    // The report file is written under the lock, before the register (status reported); if the write fails, nothing changes.
    const s = editFollow((reg) => {
      const p = reg.entries.find((x) => x.id === id);
      if (!p) return { error: [`Unknown follow-up entry ${id} (${CQ} follow lists them)`] };
      const r = F.markReported(reg, id, followReportPath(id), { now });
      if (!r.error.length) writeFollowReport(p);
      return r;
    });
    console.log(
      `The report is written: ${s.entry.report}. Fill in the sections marked "assessed by the orchestrator", present it ` +
        `to the owner, and close it with ${CQ} follow close ${id} --decision "...".`,
    );
  } else if (sub === 'close') {
    const s = editFollow((reg) => {
      const r = F.close(reg, id, { decision: val('--decision'), cancelled: a.includes('--cancelled') }, { now });
      if (!r.error.length) {
        r.entry.report = followReportPath(id);
        r.entry.reported = r.entry.reported ?? now;
        writeFollowReport(r.entry);
      }
      return r;
    });
    console.log(`${id} is closed (${s.entry.status}); the report with the decision: ${s.entry.report}.`);
    if (s.entry.close_action?.length && s.entry.status !== 'cancelled') {
      console.log('Close action (do it only if the decision calls for it; queue.mjs never does it itself):');
      for (const h of s.entry.close_action) console.log(`  ${h}`);
    }
  } else if (sub === 'extend') {
    const s = editFollow((reg) => F.extend(reg, id, val('--to'), { now }));
    console.log(`${id} is extended to ${s.entry.end}.`);
  } else {
    die(
      `Use: ${CQ} follow [add --file <json> | log <id> | show <id> | report <id> | close <id> | extend <id>]`,
    );
  }
}
