# Canonical issue format

Every implementation issue in this repository follows this exact structure. It is
the contract between the planning side (`/define-behavior`) and the execution side
(`/work-issue`, the VPS agent loop, the code-review bot): the issue body is the
implementing agent's **only** source of truth, so anything the implementer needs
must be inside it.

## Why these rules exist

- **Strictly sequential batches.** Issues in a batch are executed one at a time,
  in order. No parallel waves — parallelism multiplies integration risk and the
  dispatcher intentionally runs a single agent at a time.
- **Fully self-contained.** The implementing agent reads the issue body and the
  comments on its blocker issues — nothing else. Referencing an external
  specification ("see section 13 of the spec") is a defect: specs drift, issues
  are the source of truth. An issue may reference **other issues** (`#NN`) only.
- **Machine-parseable blocking.** The dispatcher decides "is this issue ready?"
  by parsing the `Blocked by` line and checking that every referenced issue is
  closed. A missing or malformed line silently breaks ordering.

## Title

```
[<batch-slug> NN/MM] Imperative summary in English
```

- `batch-slug` — short kebab-case identifier of the batch (e.g. `inbox-v2`).
- `NN/MM` — position in the batch / batch size, zero-padded (`03/07`).
- Historical note: the founding batch #21–#41+#50 uses plain `[NN/22]` without a
  slug; do not rename it.

## Body sections (in this order)

### 1. Blocked-by line (mandatory, first line)

```
**Blocked by:** #24, #26
```

or, for the first issue of an independent batch:

```
**Blocked by:** none
```

Rules:
- Every issue has this line. "I forgot" is not a state the dispatcher can parse.
- Each issue after the first lists **at least the previous issue in its batch**;
  add any real cross-batch dependencies on top.
- The dispatcher matches lines containing "blocked by" (case-insensitive) and
  extracts every `#N` on them — keep all blocker references on this one line and
  never write `#N` references on other lines containing the words "blocked by".

### 2. `## Context`

Why this issue exists, what earlier issues it builds on, what later issues build
on it. References to other issues only — no external documents.

### 3. `## Task`

The exact deliverables. This is the law for the implementing agent: everything
listed here must be delivered, nothing beyond it may be built. Concrete names
(endpoints, tables, keys, view types) belong here, written out — canonical stored
keys are English camelCase, view types kebab-case, user-facing labels via i18n.

### 4. `## Scope`

```
### In scope
### Out of scope
```

Out of scope lists what is deliberately deferred and which issue (if known) picks
it up. The code-review bot treats implementing an out-of-scope item as a finding.

### 5. `## Acceptance criteria`

Observable, testable behaviors — "when X happens, Y is observable". The
implementing agent's self-check and tests are written against these.

## Epic issue (one per batch)

```
Title: [<batch-slug>] <Batch name> — epic
```

Body: the user-approved behavior specification, followed by a checklist of the
batch's issues (`- [ ] #NN — title`). The epic:

- is **never** labeled `review:approved` (it is not implementable work and the
  dispatcher must never pick it up),
- does not appear in any `Blocked by:` line,
- is closed manually when the whole batch is done.

## Labels (workflow — set by tooling, not by hand-editing)

| Label | Meaning |
|---|---|
| `review:approved` | Issue passed the batch audit; the VPS dispatcher may pick it up |
| `agent:in-progress` | An agent run holds the lock on this issue |
| `agent:done` | Agent finished: PR merged, issue closed |
| `agent:failed` | Agent run failed; pipeline is halted until a human removes this label |
