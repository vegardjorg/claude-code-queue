# The plan register (`cq plan …`)

The queue holds work that is ready to run. The plan register holds everything before that: ideas, plans,
investigations and decisions, with priority and maturity, and links to the documents where the details live. It is
stored in `scripts/.queue/plans.json` (gitignored) and only written through `cq plan …`, with a change log and
undo.

## A plan entry

```json
{
  "id": "PL-OFFLINE",
  "title": "Offline sync for the mobile app",
  "project": "offline",
  "priority": "owner",
  "priority_reason": "No owner decision yet",
  "priority_set_by": "agent",
  "maturity": "idea",
  "sources": [{ "path": "docs/offline-plan.md", "anchor": "## Sync" }]
}
```

- `project` (required): must exist (`cq projects`; create with `cq project <pid> --title "…"`). It links
  the entry to queue tasks in the same project. The area comes from the project: `cq project <pid>
  --area <oid>`, with the areas from `modules` in `queue.config.json` (`cq plan modules` creates them).
- `priority`: `now` (now), `owner` (owner must decide), `later` (later), `drop` (dropped). Categories such as
  `security` (security), `for-prod` (before production) and `important` (important) explain why.
- `maturity` (maturity): from `idea` (idea) to a plan that is ready to become queue tasks.
- `sources`: list of `{ path, anchor?, role? }` pointing to the documents. The entry points to them, it never copies
  them.
- `priority_reason`: one sentence (which priority rule, and why). Required when an agent sets the priority.

## Commands

| Command | What it does |
|---|---|
| `plan show [--module m] [--project p] [--priority …] [--search "…"]` | List entries |
| `plan get <id\|project\|module>` | Entries with sources, queue status and owner questions |
| `plan new --file entry.json` | New entry or list of entries |
| `plan edit <id> --field name=value` / `--set '{…}'` | Change fields (`sources` is replaced as a whole list) |
| `plan prioritize <id…> <now\|owner\|later\|drop>` | Set priority |
| `plan combine <to-id> <from-id…>` | Merge entries (the others go to the archive) |
| `plan verify <id> --findings "…"` | Record that a plan was checked against the code |
| `plan rules` | The priority rules |
| `plan active <id>` | "Working now" marker shown on the board |
| `plan check` | Unregistered documents, dead paths, stale entries |
| `plan undo` | Undo |
| `plan backup` | Runs the script in `planBackup` (optional; for example a private backup repo) |
| `plan doc …` | Optional register of controlled documents (versions, revisions, links) |

## Rules that keep it useful

1. A new plan or investigation document is registered in the SAME session it is written, either as a new entry or as
   a source on an existing one (`plan show --search "…"` first).
2. An entry created by an agent without the owner's decision gets `"priority": "owner"`, `"maturity": "idea"`,
   `"priority_set_by": "agent"` and a reason, and an owner question (`cq question`).
3. Plan work and building are separate: the skill `/plans` works on plans only and turns a mature plan into queue
   proposals; the queue builds.
