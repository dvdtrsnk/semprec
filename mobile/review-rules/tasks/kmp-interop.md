Check the native (Swift-facing) export contract of changed public shared API:
everything public in `:shared:presentation`, `:shared:core` and
`:shared:umbrella` that is not `internal` or `@HiddenFromObjC`, and the
framework configuration in `shared/umbrella/build.gradle.kts`. Rule ID:
`KMP-INTEROP`.

1. A changed or new exported signature whose nullability, collection, enum or
   sealed cases, `suspend` or `Flow` behavior changed without the consumers at
   the pull request's head following it — high. The consumers are the CoreKit
   bridges and `SharedValues.swift` in
   `mobile/apple/Modules/Core/CoreKit/Sources/Shared/` and the Android modules
   that use the type; read them before reporting.
2. An expected failure exposed only as an exception — high: Swift cannot catch
   a Kotlin exception that is not declared with `@Throws`, so the app crashes.
   Expected failures are typed values in state (`FailureKind`).
3. A blanket `@Throws(Throwable::class)` that hides which failures a call has —
   medium, only with the concrete failure it masks.
4. An exported `suspend` function or `Flow` whose work keeps running after the
   native caller is gone (the Swift task cancelled, the ViewModel closed) —
   medium.
5. A domain, data, DI, network, factory or session type newly reachable from
   the exported API — an `export(...)` or `api(project(...))` added in
   `shared/umbrella/build.gradle.kts`, or a public exported signature that
   takes or returns such a type — medium: the Apple app would depend on a type
   the module graph keeps out of its reach.
6. A change to the framework's identity or linkage — `baseName` (from
   `frameworkName` in `gradle/project.properties`), `isStatic`, the targets,
   the bundle id, or SKIE's configuration — without the Apple project that
   links and embeds the framework updated with it — high.

Not findings: SKIE-generated bridging used as intended, a multiplatform
`androidx.*` dependency, declarations that are `internal` or `@HiddenFromObjC`.
