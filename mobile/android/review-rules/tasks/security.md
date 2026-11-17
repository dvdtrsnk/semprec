Check for security vulnerabilities:

1. Hardcoded credentials, API keys, or tokens anywhere in the diff —
   critical.
2. A keystore, a signing configuration with passwords, or another secret
   committed — critical.
3. A manifest change that exposes the app: a component exported without a
   permission that protects it, `android:allowBackup` enabled, data extraction
   rules that stop excluding app data, `android:debuggable` set, or
   cleartext traffic allowed — critical.
4. A secret, token, credential or user content reaching a log call (`Log.*`,
   `println`) — high.
5. Input from outside the app — an intent extra, a URI, a navigation argument —
   used to reach a destination or data without being validated where it is
   read — high. The exported `MainActivity`'s intent reaches navigation by two
   paths. Its extras reach a `SavedStateHandle` through the activity's default
   `CreationExtras` (`DEFAULT_ARGS_KEY`), which is why `MainActivity` creates
   `SceneNavigation` without them. And each tab's `NavHostController` runs
   `handleDeepLink(activity.intent)` when its `NavHost` sets its graph,
   following Navigation's deep-link extras (`NavController.KEY_DEEP_LINK_IDS`,
   `KEY_DEEP_LINK_ARGS`, `KEY_DEEP_LINK_EXTRAS`) to any destination, with any
   arguments or none, so another app could open a detail or crash the app.
   `MainActivity` therefore replaces its intent with `withoutLaunchContent()`
   at the top of `onCreate`, before `super.onCreate`, and hands `onNewIntent`'s
   `super` only `withoutLaunchContent()` of the new intent. High under this
   item: that sanitizing removed or bypassed in either place, a `NavHost` or
   another reader handed the unsanitized intent, and `getIntent()` or a new
   intent's extras or data read to navigate without being validated where they
   are read (`LaunchIntentTest`).
6. A permission added to the manifest that the linked issue's Task does not
   call for — high: every permission widens what the app can reach and what a
   compromised dependency inherits.
