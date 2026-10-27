# The plan register (`ko.mjs plan …`)

The queue holds work that is ready to run. The plan register holds everything before that: ideas, plans,
investigations and decisions, with priority and maturity, and links to the documents where the details live. It is
stored in `scripts/.ko/planer.json` (gitignored) and only written through `ko.mjs plan …`, with a change log and
undo.

## A plan entry

```json
{
  "id": "PL-OFFLINE",
  "tittel": "Offline sync for the mobile app",
  "prosjekt": "offline",
  "prioritet": "eier",
  "prioritet_grunn": "No owner decision yet",
  "prioritet_satt_av": "agent",
  "modenhet": "ide",
  "kilder": [{ "sti": "docs/offline-plan.md", "anker": "## Sync" }]
}
```

- `prosjekt` (required): must exist (`ko.mjs prosjekter`; create with `ko.mjs prosjekt <pid> --tittel "…"`). It links
  the entry to queue tasks in the same project. The module (area) comes from the project: `ko.mjs prosjekt <pid>
  --omrade <oid>`, with modules from `moduler` in `ko.config.json` (`ko.mjs plan moduler` creates them).
- `prioritet`: `naa` (now), `eier` (owner must decide), `senere` (later), `dropp` (dropped). Categories such as
  `sikkerhet` (security), `for-prod` (before production) and `viktig` (important) explain why.
- `modenhet` (maturity): from `ide` (idea) to a plan that is ready to become queue tasks.
- `kilder`: list of `{ sti, anker?, rolle? }` pointing to the documents. The entry points to them, it never copies
  them.
- `prioritet_grunn`: one sentence (which priority rule, and why). Required when an agent sets the priority.

## Commands

| Command | What it does |
|---|---|
| `plan vis [--modul m] [--prosjekt p] [--prioritet …] [--sok "…"]` | List entries |
| `plan hent <id\|project\|module>` | Entries with sources, queue status and owner questions |
| `plan ny --fil entry.json` | New entry or list of entries |
| `plan endre <id> --felt name=value` / `--sett '{…}'` | Change fields (`kilder` is replaced as a whole list) |
| `plan prioriter <id…> <naa\|eier\|senere\|dropp>` | Set priority |
| `plan slaa-sammen <to-id> <from-id…>` | Merge entries (the others go to the archive) |
| `plan verifiser <id> --funn "…"` | Record that a plan was checked against the code |
| `plan regler` | The priority rules |
| `plan aktiv <id>` | "Working now" marker shown on the board |
| `plan sjekk` | Unregistered documents, dead paths, stale entries |
| `plan angre` | Undo |
| `plan backup` | Runs the script in `planBackup` (optional; for example a private backup repo) |
| `plan dok …` | Optional register of controlled documents (versions, revisions, links) |

## Rules that keep it useful

1. A new plan or investigation document is registered in the SAME session it is written, either as a new entry or as
   a source on an existing one (`plan vis --sok "…"` first).
2. An entry created by an agent without the owner's decision gets `"prioritet": "eier"`, `"modenhet": "ide"`,
   `"prioritet_satt_av": "agent"` and a reason, and an owner question (`ko.mjs sporsmal`).
3. Plan work and building are separate: the skill `/planer` works on plans only and turns a mature plan into queue
   proposals; the queue builds.
