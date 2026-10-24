Check navigation ownership. Rule ID: `NAV-OWNERSHIP`.

Trace each changed path: user action → shared effect → the feature
ViewModel's `route(_:)` → the feature's routing protocol → the app's router
(`Projects/App/Sources/Routing/`) → the scene's `NavigationContext` → the
tab's NavigatorUI stack or sheet → the view `AppScene` provides for the
`AppDestination`.

1. A feature ViewModel or view that owns navigation — a `NavigationPath`, a
   navigator, `NavigationLink(value:)` or `navigationDestination`, a global or
   static router — or that depends on the app's router types — high.
2. A feature presenting another feature's screen instead of calling its
   routing protocol — high.
3. Navigation state not scoped to its scene — a process-wide navigator, a
   static `NavigationContext`, a router or `AppComposition` shared between
   windows — medium; high when one window's navigation can reach another
   window.
4. A new route without its routing-protocol method, its app router
   implementation, its `AppDestination` case or the view `AppScene` provides
   for it, so the action is silently dropped — medium.
5. A new path that can route before the target tab's stack registered itself
   with `NavigationContext` (`push` and `presentSheet` do nothing before
   `register`) — medium: the navigation is silently dropped.
6. A closure handed to NavigatorUI (`onNavigationProvidedView`, a stack's
   content) that captures the scene view (`self`, or an instance method of it),
   a destination provider that captures the composition strongly, or the root
   `Navigator` moved into `AppComposition` — medium: NavigatorUI keeps the
   provider in the root navigation state for as long as that state lives, so
   every closed window keeps its composition, its navigation and its Kotlin
   `HomeSDK` alive. `SceneLifetimeTests` pins this.
7. App code that appends to a tab's NavigatorUI path past its
   `NavigatorStackAdapter` (`navigator.push`, `navigate(to:)` on the tab's
   `Navigator`), a `StackNavigating.top` that no longer follows the pops of the
   stack, a stack's root registering a new `NavigatorStackAdapter` instead of
   calling `register(_ navigator:for:)`, or `NavigationContext.push` without
   its check of `top` — medium: the detail already on top is then pushed a
   second time, where Android opens it once (`tasks/parity.md`), or `top`
   names a screen that is gone and a push is wrongly skipped. `NavigationTests`
   pins the check, the adapter's `top` and the repeated registration.

Not findings: a feature ViewModel calling its injected router; a
`NavigationStack` that a presented screen uses only for its own title and
toolbar, as `AboutScreen` does; platform-native sheets and back gestures, and
the Android app's different back affordances.
