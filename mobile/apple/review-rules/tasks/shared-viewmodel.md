Check how the Apple app consumes the shared screen ViewModels: the CoreKit
bridges, the Swift values they map to, and the feature ViewModels and screens
that own them. Rule IDs: `SHARED-VM` (ownership and lifetime), `KMP-INTEROP`
(mapping the Kotlin API).

1. A CoreKit bridge that does not close its Kotlin ViewModel exactly once when
   it is released — no `SharedViewModelLease`, `close()` called outside
   `deinit`, a second close path, or a strong reference that keeps the bridge
   alive after its screen is gone — `SHARED-VM`, high.
2. A screen model or feature ViewModel created outside the screen's
   `@StateObject(wrappedValue:)` autoclosure — in `body`, eagerly in a
   `<Feature>ScreenFactory` before the screen's initializer runs, or in a
   destination builder — or a feature ViewModel moved to `@Observable` with
   `@State` — `SHARED-VM`, high: SwiftUI evaluates those on every view
   initialization, so each one creates and closes another Kotlin ViewModel and
   restarts its work.
3. A feature ViewModel that stores something other than `any <X>ScreenModel`,
   or that re-derives state the screen model already provides instead of
   republishing it — `SHARED-VM`, high.
4. Effects observed outside the screen's `.task`, or a feature ViewModel whose
   initial state is not read from `model.state` before observation —
   `SHARED-VM`, medium.
5. A bridge whose ViewModel has effects that observes the Kotlin effect flow
   other than through `EffectQueue(collecting:)` — a SKIE iteration per
   observer, or a collecting task that something cancels — or a change to
   `EffectQueue` that lets two
   streams take effects, delivers an effect twice, or loses one when an
   observer is cancelled — `SHARED-VM`, high: a SKIE iterator collects from
   the moment it exists and stops only when it is deallocated, so an effect it
   took for a cancelled observer never reaches Swift, and a cancelled Kotlin
   collector drops the effect the channel handed it. `EffectQueueTests` and
   the effect tests of `SharedScreenModelTests` pin this behavior. A bridge
   whose effect type is `Nothing` (`SharedDetailScreenModel`) has no queue and
   returns a finished stream; that is not a finding.
6. A Kotlin value mapped wrongly or not at all in a bridge — a sealed or enum
   case falling into the wrong branch, a nullable force-unwrapped, a
   `FailureKind` of `nil` (an unexpected failure) turned into an expected one,
   an integer conversion that can trap (`Int32(_:)` of a Swift `Int`) —
   `KMP-INTEROP`, high when the shared side can produce the value.
7. A Kotlin type reaching past CoreKit (a public or package CoreKit
   declaration that exposes one), a `SharedSDK` import in CoreKit's sources
   without `internal`, or a `SharedSDK` import in any target other than CoreKit
   and `CoreKitTests` — `KMP-INTEROP`, medium. `CoreKitTests` imports it to
   build Kotlin values for `SharedMappingTests`.
8. An exported shared API changed in the pull request without the bridge
   following it — `KMP-INTEROP`, high; read the Kotlin signature first.
9. A new bridge without its `ScreenModelFactory` method and
   `SharedScreenModelFactory` implementation, a `Scripted<X>ScreenModel`
   alias, or previews over the scripted model, so previews would need the
   Kotlin runtime — `SHARED-VM`, medium.

Not findings: SKIE-generated bridging used as intended; a feature ViewModel
calling its injected router for an effect; `@StateObject` ownership at the
composition boundary; different visual presentation of the same state on the
two apps.
