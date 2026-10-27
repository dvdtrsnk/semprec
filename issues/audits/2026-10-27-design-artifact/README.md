# Design artifact issue audit — 2026-10-27

Result: mechanism provenance is mapped, concrete specification defects are repaired,
and Finance stays deferred. This is **not a blanket implementation approval**.
One confirmed duplicate metadata contract still needs an owner decision. The broader
touch-policy discrepancy below also prevents claiming a clean Phase 5 audit.

## Evidence and scope

The inputs are the two exports attached to BB thread `thr_qswg4sdx4m`:
`semprec-source-raw.zip` and `semprec-opendesign-export.zip`. Both contain exactly the
same canvas bytes (SHA-256
`0bd3cddd9431b21f969b2c5ea3c2d6898bacce95143b54c00d188a9127688e81`).
No exported HTML was executed. The source reports a comparison with `develop
8fdccb45`; those historical code claims are not evidence of the current implementation.

The canvas has 95 boards and 366 notes: 282 backend notes, 59 question/process
notes containing 355 numbered questions, and 25 section headings. The 57 domain
question groups point to epics gh-1296 through gh-1352. The other two are process
and cross-cutting decisions. The finance deferral is one of the 282 backend notes.

The canonical local catalog contains 1,375 records. The non-finance design epics
have 674 implementation records: 671 open and three cancelled (device dictation,
server HEIC conversion and implicit grants on MCP-card confirmation). Finance has
its own cancelled epic and nine cancelled implementation records.

[traceability.json](traceability.json) assigns every note a disposition and preserves
its text checksum. Backend entries identify direct decomposition matches or the
existing owners to which the note delegates; headings create no work. Domain Q&A
entries identify their decision epic. The backend mapping reaches every one of the
674 non-finance implementation records, plus the cancelled Finance epic.

**Interpretation:** title matches and decision-epic links establish provenance;
they do not prove that every requirement sentence is satisfied by every Task and
acceptance criterion. Structural checks cover the entire design backlog; semantic
checks here concentrate on the concrete conflicts listed below. This report does
not certify all 671 open specifications or the 95 mobile screen implementations.

## Repairs

1. **Chat heartbeat tools contradicted the approved behavior.** gh-1731 required
   chat sessions to have no heartbeat tools, while gh-1523 composes those tools
   and gh-2018 deliberately widens chat reads. gh-1731 now changes only the
   tick-specific context and preserves composed tools. gh-2018 follows gh-1731,
   preserving one owner of tenant-wide chat heartbeat access.
2. **Thread activity could move backwards.** gh-1728 required monotonic activity
   but prescribed `SET last_activity_at = now()`. Transaction start time can be
   older than a newer committed activity. The specification now uses `GREATEST`
   and explicitly asks for the older-transaction regression case.
3. **The 120-second boundary differed between issues.** The approved recording
   card in gh-1978 accepts 120 seconds or longer; gh-1965 classified exactly 120
   as a voice note. gh-1965 now owns `INBOX_RECORDING_MIN_SECONDS`, with recordings
   at or above it. gh-1980, gh-1985 and epic gh-1314 agree and request the
   119/120/121-second cases. No audio processing was implemented.
4. **Registry changes were concurrently eligible.** Twenty-eight edges were
   added for the shared generic-operation catalog, owner-process catalog and
   queue task catalogs. Only the task-catalog edits of `queue/src/index.ts` were
   grouped; gh-1755's unrelated enqueue/concurrency changes were excluded. Each
   chain follows a topological order of the existing capability graph; there
   is no added edge solely for a barrel or translation catalog. gh-1399 also
   follows gh-1396 because both modify the gateway endpoint table and dispatcher.
   Exact new edges are recorded in [checks.json](checks.json).
5. **False duplicate warnings could remove the sole implementation owner.** Epic
   gh-1304 compared gh-1854 with itself; epic gh-1332 compared gh-1931 with itself
   and claimed gh-1930 lacked a blocker already present. These stale warnings
   now name the single owners. gh-1413 also no longer presents the selected
   archived-status label as an unresolved product question.
6. **Deferred history search was only protected by prose.** gh-1783 remains open
   as a future specification, but is now explicitly parked with `agent:blocked`.
   It has no approval or queue intent. Whole-history search was not implemented.

All existing issue identities and parent relationships remain intact. No new
implementation issue was created. Imported history and migration manifests were
not rewritten. Edited records remain unapproved; no issue was queued.

## Confirmed open defect: duplicate audio metadata ownership

**Blocking — gh-1965 and gh-1978.** gh-1965 creates `inbox_attachments.metadata`
and makes ffprobe the authoritative duration/recording-time producer; it expressly
excludes client-supplied values. gh-1978 Task 2 independently creates
`recorded_at` and `duration_seconds` and accepts client values ahead of those from
gh-1965. This is duplicate storage and conflicting ownership for the same facts,
not a reason to create another recording issue.

Concrete repair options presented to the owner:

- Use only the server metadata owned by gh-1965; gh-1978 consumes those fields and
  creates no second metadata migration or client override.
- Preserve device-provided facts, but specify them separately from probe-derived
  facts, including the authority/fallback rules, in these existing issues.

No option was silently selected. gh-1978 is parked with `agent:blocked` while the
answer is pending. Its recording proposal mechanism stays in that same issue.

## Duplicate checks and retained owners

There are no duplicate open titles. Similar titles were checked for distinct
mechanisms: task/event occurrence expansion (gh-1886/gh-1877), speech recognition
and synthesis (gh-1396/gh-1399), library/system labels (gh-1361/gh-1413), and reading
versus revising a proposal (gh-1623/gh-1906). None calls for a new issue or a merge.

The apparently missing producers in source note `be_274` already exist separately:
gh-1506 raises/resolves mailbox problems and gh-1931 raises/resolves failed-reply
problems. Recreating either would duplicate existing work. Their separate storage
and read-side dependencies remain with their current owners.

Filename overlap is not proof of duplicate behavior: facets, related items and
relation-edge reads are separate operations; domain callers reuse those owners.
Conversely, the metadata conflict above is a real duplicate contract even though
the two issues have different titles.

## Touch-policy qualification

Source decision `q_prurez` question 1 permits merging independent barrel and
translation additions without serialization. The accepted
`docs/adr/2026-09-24-issue-batches-as-dependency-dags.md` and current
`.github/ISSUE_FORMAT.md` still prescribe ordering for overlapping barrel export
regions. This audit does not amend an accepted ADR or silently claim the two
policies agree. A policy change needs the project's ADR process.

A raw scan initially found 16,868 unordered same-path pairs across 290 declared
paths. This includes directories, different functions in the same file, barrels,
i18n and tests; **it is not a count of confirmed defects**. The full scan is saved
with this thread's evidence as `touch-overlaps.json`. Confirmed registry overlaps
were repaired above. The remaining path candidates have not all been adjudicated
at function/key granularity. Consequently no global collision-free claim or
automatic approval is issued.

## Finance

Finance remains cancelled: gh-1295 and its nine children are `closed/not_planned`.
No open design issue depends on any of them. No Finance issue was reopened,
approved or queued, and no manifest, schema, transaction handling, budget or
expense step was implemented. AI-usage accounting is a separate existing concern;
it is not the deferred personal-finance module.

## Validation

- Canonical `issues.mjs validate`: no new/changed specification diagnostics.
  Historical import diagnostics remain visible and are not a clean-spec verdict.
- The design backlog's dependency closure has no missing issue or cycle, and no
  open design issue directly blocks on cancelled work.
- Every open design implementation has the required body sections; model-tier
  grammar is checked by the canonical validator.
- The three repaired registry groups have no unordered pair after the changes.
- Every edited specification stays below 1.5 times its original body size.
- Finance states, absent approvals and absent queue intent were checked again.
- Runtime/backend/web/mobile test pipelines were not run: this change edits
  specifications and audit evidence only. Requested test cases are future
  implementation obligations, not tests claimed to have passed here.

[checks.json](checks.json) records scope, final record checksums, exact registry
edges and per-record growth for subsequent verification.
