---
name: canonical-keys
description: "Naming and localization rules for every stored identifier and every string a user will read. Load this BEFORE inventing a key or typing a literal label - a wrong key is expensive to change once rows carry it. Triggers on: databases.key, property key, select-option value, settings key, view type, kebab-case view names such as mailbox-client, i18n, cs.json, en.json, users.locale, any user-visible string, and any name transcribed from the Czech spec or mock, where keeping the Czech word is the tempting mistake. Skip only when the change introduces no new identifier and no user-facing text."
---

# Canonical keys are English. Labels are localized.

Recorded as ADR: `docs/adr/2026-09-10-english-canonical-keys-with-i18n-labels.md`.

The spec and mock grew up in Czech, so Czech names will keep appearing in issues,
mock references, and your instincts. The stored world is English anyway — one
canonical, translatable key space:

- **Canonical stored keys** (`databases.key`, property keys, select-option
  values, settings keys): English **camelCase**. Examples: `tasks`, `journalDay`,
  `processingMethod`, `dailyBudgetUsd`; option values `done`, `notDone`,
  `wontDo`, `inbox`, `sent`, `junk`, `trash`.
- **View-type keys**: English **kebab-case** — `mailbox-client`,
  `temporal-switcher`, `journal-inbox`.
- **Display labels**: never stored as the key and never hardcoded in code or
  API responses. They live in the i18n files (`cs.json`, `en.json`), keyed by the
  English canonical key (`database.tasks.name` → "Úkoly" / "Tasks"), and the
  backend resolves them by `users.locale` before sending anything user-facing.

Why: keys outlive UI languages. A Czech key baked into rows, filters, and API
contracts can never be translated without a data migration, while a label lookup
is free. Mixed-language keys also break the i18n design outright — its files are
keyed by the English canonical key, so a Czech key simply has no label entry.

## The established vocabulary

Reuse these exact keys — don't coin synonyms for concepts that already have one:
ten core DBs `areas`, `projects`, `tasks`, `people`, `files`, `events`,
`healthRecords`, `companies`, `transcripts`, `journal`; Semprec-module DBs
`inbox`, `inboxItemTypes`, `processingProposals`, `mailboxes`, `emails`; common
properties `status`, `date`, `time`, `type`, `kind`, `link`, `note`, `tags`,
`fingerprint`, `sourceInbox`, `sourceTranscript`, `senderPeople`,
`recipientsPeople`. When a concept is genuinely new, pick a concise English
camelCase name and use it everywhere (schema, seed, API, tests, i18n files) in
the same PR. Deliberate exception: `ico` (the Czech IČO company-registration id,
a domain term with no honest English name).

## Fallback chain (when resolving a label)

explicit per-item `name` override → `users.locale` file → `en` (the reference
locale — its entries follow the keys) → the raw English key. Missing `cs` entry
is a gap to fill, not a reason to hardcode.

## Litmus test

Grep your diff for Czech words outside comments, i18n `cs.json` values, and
quoted mock references. Any hit that is a key, an enum value, or a string sent to
a client needs to become an English key plus a `cs.json`/`en.json` entry.
