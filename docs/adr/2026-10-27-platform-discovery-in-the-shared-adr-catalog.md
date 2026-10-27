---
status: accepted
date: 2026-10-27
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Platform discovery uses the shared ADR catalog and includes historical mobile tags

## Context

ADRs live at permanent paths under `docs/adr/`. Their `area` metadata can name
several platforms. Moving them into platform directories would break references
and require arbitrary placement or duplication for shared decisions. The native
mobile architecture spans shared Kotlin, Android, iOS and macOS
([[2026-10-24-kotlin-multiplatform-below-native-mobile-ui]]).

The pre-KMP `apple` tag remains on accepted decisions that mobile review rules
still cite, including [[2026-09-10-no-speculative-generality-beyond-issue-scope]].
Filtering exclusively for `mobile` would hide these decisions. Historical tags
describe their original scope; discovery must not silently rewrite that history.

## Decision

Keep the flat catalog and permanent paths. Classify new mobile decisions with
`mobile`; the body explains which shared or native components the decision
governs. Backend and web decisions retain their respective tags. Use
`cross-cutting` for repository-wide decisions, and multiple tags for decisions
spanning named areas.

`node .github/scripts/adr.mjs --platform <platform>` selects accepted decisions
tagged with that platform's area plus `cross-cutting`. Mobile, shared, Android,
Apple, iOS and macOS selections include both `mobile` and historical `apple`.
These are discovery candidates: read the decision's scope before applying it.
An Apple-specific historical decision does not become an Android requirement
merely because it appears in the Android discovery results.

`--all` also includes proposed, superseded and deprecated records. The command
validates the catalog metadata on every invocation. It generates its output at
read time and stores no index. No existing ADR body or path changes.

## Consequences

Platform work can discover shared and historical constraints without consulting
GitHub or maintaining duplicate platform catalogs. The filter is conservative;
implementers still read the applicable decisions and the platform review rules.
New platform-specific taxonomy can be introduced by a later decision if actual
catalog size and usage justify it.
