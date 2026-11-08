Check navigation ownership and delivery. Rule ID: `NAV-OWNERSHIP`.

Trace each changed path: user action → shared effect (or a direct router call
for navigation the shared ViewModel has no action for, like
`HomeRouter.closeDetail`) → feature router interface → `SceneNavigation`
command → `AppSceneState.execute` → the tab's `NavHostController` or the About
sheet.

1. A feature navigating to another feature's screen, or importing app or
   navigation-library types — high.
2. A `NavController`, `NavHostController` or navigation state held by a
   ViewModel or by shared state — high.
3. Navigation that bypasses the `SceneNavigation` queue (a router
   implementation or a composable callback driving a `NavHostController`
   directly), commands run outside the STARTED collection in `AppScene` or
   acknowledged before they ran, or a second collector of
   `SceneNavigation.commands` — high: the navigation then replays after
   recreation, runs while stopped, runs twice, or is lost.
4. A suspension inside `AppSceneState.execute` after the command took effect —
   high: a scene stopped in that gap restarts the collection and runs the
   command a second time.
5. A command for a tab's stack that runs before that stack's `NavHost` set its
   graph — `execute` must select the tab and wait for
   `currentBackStackEntryFlow.first()`, as `showHomeStack` does — high: the
   navigation fails with "Navigation graph has not been set" after recreation
   on another tab.
6. A new `NavigationCommand` that `decodeCommand` cannot read back (a parameter
   without its prefix, an object missing from `PLAIN_COMMANDS`) — high: the
   command is dropped when the queue is restored after process death.
   `QueuedNavigationTest` must round-trip it.
7. A new destination without its router method or app implementation, so the
   action is silently dropped — medium.
8. A destination declared with a string route, or a route argument that is
   nullable, not a typed property of a `@Serializable` route class, or read
   from `entry.arguments` instead of `toRoute` — medium: a string route's
   `NavType.StringType` turns the id `"null"` into a null argument, and an id
   must reach its screen unchanged. A `requireNotNull` or `!!` on an argument
   is item 1 of `tasks/correctness.md`.
9. `launchSingleTop` (or another reuse of the top entry) on a navigation to a
   destination whose ViewModel is built from navigation arguments — medium:
   the top entry keeps its id and `ViewModelStore`, so `koinViewModel` hands
   the new destination the previous arguments' ViewModel. `AppSceneState`
   pushes each detail as a new entry and skips only the detail of the same id
   already on top.
10. `SceneNavigation` created with the activity's default `CreationExtras`
    (`DEFAULT_ARGS_KEY`) — high: those carry the extras of the activity's
    intent, so the queue would depend on the launch intent of the exported
    launcher activity as soon as the sanitizing of item 11 were removed or
    bypassed. Leaving `DEFAULT_ARGS_KEY` out is the second layer behind
    `withoutLaunchContent()`, and no test isolates it: `LaunchIntentTest` still
    passes with the key handed in, because `withoutLaunchContent()` has emptied
    the intent before `SceneNavigation` is created, so the review keeps it. A saved value read with an unchecked type is item 1 of
    `tasks/correctness.md`; `SceneNavigationTest` covers the values
    `SceneNavigation` drops.
11. `MainActivity` exposing an unsanitized launch intent or new intent to its
    `NavHostController`s — `intent = intent.withoutLaunchContent()` removed or
    moved after `super.onCreate` or after `setContent`, `onNewIntent` handing
    `super` the intent it received, or a NavController handed another intent
    (`handleDeepLink`) — high: Navigation follows the deep-link extras of that
    intent to any destination of the graph, around the `SceneNavigation` queue,
    and a missing or mistyped argument crashes the app in `toRoute`
    (`LaunchIntentTest`; the security side is item 5 of `tasks/security.md`).

Not findings: a `Screen` calling a router method directly for navigation the
shared ViewModel has no action for; back behavior that looks different from the
Apple app (the detail's top-bar back arrow, Back on the Settings root returning
to Home).
