---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Item patch change redaction uses the write metadata

## Context

The gh-1527 structured changes use the transaction-derived previous values of gh-1429, but currently reread property types after item.patch commits. A type change or deletion in that gap can cause content validated as longText by the write to appear in details.changes. The original write already loads typed property definitions for validation. A later read cannot reconstruct those definitions.

This extends [[2026-09-10-choke-point-api-for-state-writes]] and [[2026-09-10-side-effects-follow-the-commit]] for an internal result projection. It does not change the generic item output contract or the inherited property-schema concurrency protocol.

## Decision

Capture a per-caller-key content classification from the same typed property definitions used by updateItemWithClient to validate this write, before returning its result. These definitions are read inside the original transaction alongside the pre-image; they are an immutable in-memory snapshot for this operation, not a claim of repeatable-read database isolation. A longText key, an unknown key/type or missing classification permits only a key-only change. A recognized non-longText type permits bounded before/after as prescribed by gh-1527. The adapter does not issue a second property lookup to decide redaction.

The data owner carries this classification on the successful result under one module-private, enumerable Symbol. Enumerable symbol properties survive the existing item read-projection object spread; JSON.stringify and string-key schemas do not serialize them. Do not use a non-enumerable symbol before that projection or recover a lost classification through a fresh database read. Export only a validated reader through the data barrel; attachment stays data-internal. Capture the caller keys before transformations, preserve missing-before semantics and the original JSON-visible item/previous result, and include no values in this carrier. The application/gateway pass the result through without a public field or schema addition. If the carrier is absent, invalid or lost, the tool omits values for those change keys. Model-facing result text and the separate previous-value contract remain unchanged.

No property-row lock or schema-writer change is introduced here. Redaction is defined by the property classification observed by this guarded write; a concurrent later type change never reclassifies that operation's result. This does not freeze schema metadata through commit or assert a global schema/item lock order. Serializing every schema writer would affect pre-held item/proposal locks and is a larger protocol than this correction requires.

## Consequences

A controlled type change or property deletion after the write but before tool projection cannot reveal a write-classified longText value in changes. Test both gap actions, a registered read projection, missing classification, and ordinary safe values through the real patch adapter. Preserve exact JSON-visible public output and update only the intentional reader export in the frozen data surface. This protects details.changes; it does not redefine the existing item response, model result content, history retention or arbitrary injected gateway implementations as secret-free.
