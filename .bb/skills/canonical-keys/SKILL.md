---
name: canonical-keys
description: "Naming and localization rules for every stored identifier and every string a user will read, in backend, web and the mobile apps. Load this BEFORE inventing a key or typing a literal label - a wrong key is expensive to change once rows carry it. Triggers on: databases.key, property key, select-option value, settings key, view type, kebab-case view names such as mailbox-client, i18n, cs.json, en.json, users.locale, strings.xml, values-cs, stringResource, R.string, Localizable.xcstrings, String(localized:, a Text key with bundle: .module, a mobile copy key such as home.item.title, any user-visible string, and any name transcribed from the Czech spec or mock, where keeping the Czech word is the tempting mistake. Skip only when the change introduces no new identifier and no user-facing text."
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

## Mobile copy

Recorded as ADR: `docs/adr/2026-10-24-mobile-copy-localized-natively-from-typed-state.md`.

The mobile apps localize natively, from typed state. Shared Kotlin state never
carries display text, only phases, `FailureKind` values, ids and ordinals, and
each platform renders the text from its own resources under one mirrored key.
Why: the same screen on two platforms must say the same thing, and a key both
platforms share is what the architecture check compares.

- **Keys** are dotted English segments in camelCase, from the screen or area
  down to the element: `home.item.title`, `detail.notFound`,
  `failure.invalidData`, `settings.row.about`. The Apple String Catalog uses
  the key as written; the Android resource name replaces every `.` with `_`
  (`home_item_title`, `failure_invalidData`).
- **Where**: in the module that renders it, the same module on both
  platforms. Android: `src/main/res/values/strings.xml` (English, the
  fallback) and `src/main/res/values-cs/strings.xml` of that module, never the
  `res` of a build variant such as `src/debug` (a Kotlin Multiplatform module
  would use `src/androidMain/res`). Apple: the module's
  `Resources/Localizable.xcstrings`, source language `en`, with an `en` and a
  `cs` localization, both in state `translated`.
- **Both languages, always, and listed.** The `copy` section of
  `mobile/scripts/architecture-policy.json` lists the keys of each pair of
  modules (Android module, Apple target); a new key goes there too. The
  `COPY-PARITY` rule of `mobile/scripts/architecture.mjs` fails a key that is
  missing on one platform, has an empty English text or a missing or empty
  Czech text, or is not listed; a String Catalog whose source language is not
  `en`; and an Android string outside `src/main/res` (`src/androidMain/res` in
  a Kotlin Multiplatform module). Android lint fails on a missing Czech string
  (`MissingTranslation`, as an error). Neither compares the texts of the two
  platforms; that is the review's job.
- **Arguments** are positional: Android `%1$d`, `%1$s`; Apple `%lld`, `%1$@`,
  formatted with `String(format:locale:)` so the key stays plain.
- **One platform-only key**: `detail.back`, the content description of
  Android's back arrow (Apple uses the system back button), listed under
  `androidOnly` in the policy. A new platform-only key needs a reason. The app
  name is not a copy key: Android `app_name` (`translatable="false"`, listed
  under `androidUntranslatable`), Apple `CFBundleDisplayName`.
- **No literal copy in shipping UI**: no hardcoded string in a composable, a
  SwiftUI view, an accessibility label or a content description. Read text
  through `stringResource(R.string.…)`, `Text("…", bundle: .module)` or
  `String(localized: "…", bundle: .module)`. Previews render literal state,
  never literal text.
- **Failure text** is chosen natively from the typed value: `UNAVAILABLE` gives
  `failure.unavailable`, `INVALID_DATA` gives `failure.invalidData`, and a
  failure without a kind gives `failure.unexpected`
  (`failureMessage` on Android, `FailureKind.message(for:)` on Apple).

The current keys, their modules and their English texts are in the
`## Copy and localization` table of `mobile/docs/architecture.md`; the Czech
texts are in each `values-cs/strings.xml` and in the catalogs' `cs`
localizations.

## Litmus test

Grep your diff for Czech words outside comments, the Czech localization files
(`cs.json`, `values-cs/strings.xml`, the `cs` entries of a
`Localizable.xcstrings`) and quoted mock references. Any hit that is a key, an
enum value, or a string sent to a client or shown in an app needs to become an
English key plus its English and Czech entries.
