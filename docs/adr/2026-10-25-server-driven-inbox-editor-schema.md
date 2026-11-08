---
status: accepted
date: 2026-10-25
area: [backend]
supersedes: []
superseded-by: null
---

# Inbox card editor schemas are declared in module manifests, keyed by base kind

## Context

A Processing proposals card in the Inbox shows one editor for its proposal. The editor has a
control for each field: text, Markdown, date, date with time, select, multi-value chips, toggle,
segmented choice, colour, secret, read-only information, choice and tile. Fields sit in groups,
carry localized labels and placeholders, can be required, and can appear only under a condition.
The time part of a date is hidden for an all-day item, a project's due date is hidden when the
project is long term, and a follow-up task step's fields are hidden while that step is switched off.

Today the server knows none of this. The schema engine has no generic required-field concept (the
comment on the `date` and `time` properties in `backend/packages/data/src/inbox/inboxStore.ts` says
so). `confirm` checks the proposal's status, envelope shape and target. `moduleManifestSchema` in
`backend/packages/module-registry/src/manifest.ts` has no field for an editor, and the MCP server
card has no module manifest of its own.

Two alternatives were possible. The client could hard-code its forms, but then the rules that
confirm must enforce would live in a second place and drift from the rules the client renders.
Or the schemas could live in a separate registry beside the manifests, which would add a second
mechanism for claiming a card's kind next to the owner-per-database rule that manifests already
enforce.

The mechanism follows [[2026-09-11-module-manifest-custom-routes]]: a manifest declares the entry,
the registry resolves it when the module loads, and a collision between two modules fails the load.

## Decision

**Owner and key.** A card's editor schema is declared in the manifest of the module that owns the
card's target database, in the optional manifest field `editorSchemas`. It is keyed by the card's
base kind, the kind of thing the card creates (for example `task`, `event`, `project` or `mcp`).
The MCP server card's schema is declared in the Inbox manifest until an MCP module manifest exists.

**Shape.** `editorSchemas` maps a base kind to `{ groups }`. Groups are ordered. A group is
`{ key, fields }`. A field has these attributes:

- `key`: a property key, a relation key, or a pseudo field key. The pseudo keys are `allDay`,
  `due`, `followupTask`, `followDate`, `credential`, `transport`, `access`, `mcpProjects`, `lang`,
  `speakers`, `recordedAt`, `day`, `page`, `placement` and `heading`. Some of them name a step of a
  multi-step proposal ([[2026-10-25-multi-step-proposal-envelope]]), such as `followupTask`. A
  module added later extends this set with its own step keys. The manifest schema checks only that
  a key is non-empty; checking it against the owning database is the resolver's job (#1825).
- `control`: one of `text`, `area`, `date`, `datetime`, `select`, `multi`, `toggle`, `seg`, `color`,
  `secret`, `info`, `choice` or `tile`.
- `inputType`: `text`, `email`, `url` or `tel`. Only on a `text` control.
- `labelKey`, and optionally `placeholderKey`: catalog keys in the declaring module's own
  `i18n/cs.json` and `i18n/en.json`.
- `required`: a boolean.
- `when`: `{ field, equals }` or `{ field, notEquals }`. The field is hidden while the condition
  does not hold.
- `timeHiddenWhen`: the same shape. Only on a `datetime` control, and it hides only the time part.
- `optionsSource`: the field name that the options route (#1959) accepts for this field.
- `options`: the static values of a `seg` control. Only on `seg`.
- `infoKey`, and optionally `params`, for a read-only `info` row. `infoKey` is required on an
  `info` control.

The schema rejects a `timeHiddenWhen` on a non-`datetime` control, an `inputType` on a non-`text`
control, `options` on a non-`seg` control, an `info` control without `infoKey`, a condition with
neither or both of `equals` and `notEquals`, an empty group, and any unknown attribute, so a
misspelt `required` cannot be dropped silently.

**Hidden fields.** A field hidden by a condition is neither validated nor written. The confirm path
must follow this rule when it evaluates conditions (#1928, #1934). The manifest records the rule;
it does not evaluate it.

**Required-ness.** A missing required field is an error on confirm and a warning on edit. The
warning lets a work-in-progress card be saved. Evaluation is delivered by #1928 and #1934.

**Localized text.** The server resolves a label or placeholder from the declaring module's catalogs
for the caller's `users.locale`. The response carries the text, not the key. A missing entry falls
back as [[2026-09-10-english-canonical-keys-with-i18n-labels]] records. Stored keys stay English
camelCase, as that record also requires.

**Collisions.** Two loaded modules may not declare the same base kind. `ModuleRegistry.loadModule`
rejects the second module and names both. The check covers every loaded module, active or not,
because the owner is fixed at load time, as it is for custom routes.

**Scope.** This record defines the declaration only. Resolving declarations into card responses,
and declaring schemas for the other base kinds, is #1825. The registry's `getEditorSchemas()`
returns the declarations of active modules. Validating a select's value against its option catalog
is not part of this decision.

## Consequences

- A base kind has exactly one owner. A collision is a startup failure, not a silent override.
- Adding a card field is a manifest change plus catalog entries in the owning module, not a
  client-only change. The client renders what the server returns once #1825 lands.
- Until #1928 and #1934, the server enforces no required-ness and no condition. The declared rules
  describe the target behaviour; `confirm` and the card response are unchanged by this record.
- Renaming a base kind, a pseudo key or a control is a contract change with the client and needs
  its own decision.
- `mcpProjects` is a suggestion only, as [[2026-10-28-mcp-card-confirm-only-prefills-project-grants]]
  records. Declaring the field grants nothing.
- Modules without `editorSchemas` load and behave as before.

## Alternatives considered

- **Client-side forms.** Rejected: `confirm` could not enforce required-ness or conditions with the
  same rules the client renders, and the two would drift apart.
- **A separate editor registry outside the manifests.** Rejected: it would add a second claim
  mechanism beside the owner-per-database rule that manifests already enforce.
