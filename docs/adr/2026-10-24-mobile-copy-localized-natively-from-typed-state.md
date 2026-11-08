---
status: accepted
date: 2026-10-24
area: [mobile]
supersedes: []
superseded-by: null
---

# Mobile copy is localized natively from typed shared state

## Context

The shared ViewModels decide what a mobile screen shows
([[2026-10-24-kotlin-multiplatform-below-native-mobile-ui]]); something has to turn that into
words in the user's language, English or Czech. The backend already keeps labels out of stored
keys ([[2026-09-10-english-canonical-keys-with-i18n-labels]]), and the web client keys its
messages by dotted camelCase keys (`web/src/i18n/messages.ts`, for example `state.loading` and
`mailbox.unreadCount`), with English as the fallback.

The alternatives considered:

- **Display text in shared state**, localized in Kotlin or through a multiplatform resource
  library. Shared tests would assert locale-dependent strings, a language change would show only
  after a ViewModel publishes again, and the Apple app's text would bypass its String Catalogs.
- **One catalog and a generator** that writes typed accessors for both platforms. The jsme-tu
  template this platform is ported from does that: versioned JSON catalogs (`strings.json`,
  `test-identifiers.json` and others) generate committed Kotlin and Swift code, optionally
  synchronized with its Morbo translation service. It needs the generator and a check that its
  output is current, and the Morbo side has no counterpart in this repository.
- **Native resources on each platform with one key scheme.** Each platform keeps its own format,
  plural and locale rules and its own tooling (Android lint, Xcode's String Catalog editor).

## Decision

Shared state carries typed values and never display text: phases (`HomePhase`, `DetailPhase`), an
expected failure as `FailureKind?` (`null` for an unexpected one), the item ordinal
(`HomeItem.ordinal`) and enum rows (`SettingsRow`). Shared code contains no user-visible string;
`InMemoryPlaceholderRepository` holds ids and ordinals, and native code renders "Placeholder item
N" from the ordinal.

Each platform localizes with its native resources, in the module that renders the text:

- Android: `src/main/res/values/strings.xml` (English) and `src/main/res/values-cs/strings.xml`
  (Czech) of the module, read with `stringResource`.
- Apple: the module's `Resources/Localizable.xcstrings`, with source language `en` and a `cs`
  translation for every key. Modules read it with `Text("key", bundle: .module)` or
  `String(localized: "key", bundle: .module)`; the app target's catalog is in the main bundle, so
  the app passes the key directly (`Tab("tab.home", …)`).

Both platforms use one key scheme. Apple keys are dotted camelCase (`home.item.title`,
`detail.notFound`, `failure.invalidData`); the Android resource name is the same key with every
`.` replaced by `_` (`home_item_title`, `detail_notFound`). Both platforms carry the same keys
with the same English and Czech text, apart from format specifiers, in the module of the same role
(app, `:android:core:ui`/DesignSystem, each feature). The only platform-only entries are Android's
`app_name` (`translatable="false"`; Apple takes its display name from `CFBundleDisplayName`) and
`detail.back`, the content description of Android's top-bar back arrow, which Apple does not need
because it uses the system back button.

Android format arguments are positional (`%1$d`, `%1$s`, `%2$s`); Apple uses `%lld` for the one
number in `home.item.title` and positional `%1$@` and `%2$@` in `about.version`. Apple formats a
parameterized string with `String(format: String(localized: …), locale: .current, …)`, so that its
key stays the plain dotted name.

A failed load maps its failure the same way on both platforms, for Home and Detail:
`FailureKind.UNAVAILABLE` → `failure.unavailable`, `INVALID_DATA` → `failure.invalidData`, no kind
→ `failure.unexpected` (`failureMessage` in `:android:feature:home`, `FailureKind.message(for:)` in
HomeFeature).

English is the development language and the fallback: Android's default `values/` resources, and
on Apple `sourceLanguage: en` and `CFBundleDevelopmentRegion = en`. Every key except Android's
untranslatable `app_name` has a Czech translation on both platforms. Neither platform generates
code from a shared catalog: the Apple projects with resources disable Tuist's resource
synthesizers (`resourceSynthesizers: []`) and use the keys directly, and Android uses the `R` ids
AGP generates from each module's own resources.

Test identifiers are not copy and are never localized. Each module declares its own as constants
with the same values on both platforms (Android test tags, Apple accessibility identifiers):
Android `StatusTestTags`, `HomeTestTags`, `SettingsTestTags` and `AppTestTags`; Apple
`StatusIdentifiers`, `HomeIdentifiers`, `SettingsIdentifiers` and `AppIdentifiers`. Android's
`detail.back` has no Apple counterpart, for the reason above.

## Consequences

- New copy is a key added to both platforms, in English and Czech, in the same pull request.
- Shared tests assert typed state; the text a failure maps to is tested natively
  (`FailureMessageTest` on Android, `FailureMessageTests` on Apple, which also checks the Czech
  text).
- `:android:app:lintDebug` checks every Android module and fails on a string missing its Czech
  translation (`MissingTranslation`).
- `COPY-PARITY` in `mobile/scripts/architecture.mjs` checks the keys of every Android module and
  Apple target against `copy` in `mobile/scripts/architecture-policy.json` (which lists
  `detail.back` as Android-only and `app_name` as untranslatable), and that each key has a
  non-empty English and a non-empty Czech value: on Apple both translated, in a String Catalog
  whose `sourceLanguage` is `en`. It reads every non-test `src/<sourceSet>/res` of every Gradle
  module and accepts copy only in `src/main/res`, and in `src/androidMain/res` of a Kotlin
  Multiplatform module, because those are the resources every build of the module compiles. It
  does not compare the texts, so a text can drift between the platforms.
