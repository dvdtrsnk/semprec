/// Accessibility identifiers of the app scene's elements; each equals the Android test tag of the same element.
enum AppIdentifiers {

    static let overviewTab = "tab.overview"
    static let calendarTab = "tab.calendar"
    static let journalTab = "tab.journal"
    /// The gate that shows the wait, the sign-in form, the retry or the app; Apple-only until Android has one.
    static let sessionGate = "app.sessionGate"
    /// The notice that stands in for a screen a later wave builds.
    static let pendingScreen = "app.pending"
    /// The handle that closes the Semp chat; Apple-only until Android has the chat.
    static let sempGrabber = "semp.grabber"
    /// The banner above the tabs that tells of changes not on the server yet; Apple-only, like its lines below, until
    /// Android shows the status.
    static let syncStatus = "sync.status"
    /// The line of the banner while the scene is offline.
    static let syncOffline = "sync.status.offline"
    /// The line of the banner while changes the server refused are shown.
    static let syncFailed = "sync.status.failed"
    /// The button that dismisses the refused changes.
    static let syncDismiss = "sync.status.dismiss"
    /// The screen that covers a window while a wake mission rings; Apple-only until Android has sleep alarms.
    static let wakeGuard = "wake.guard"
    /// The button that opens the tap challenge.
    static let wakeGuardTapOpen = "wake.guard.tapOpen"
    /// The tap challenge, which takes a tap anywhere.
    static let wakeGuardTap = "wake.guard.tap"
    /// The button that goes back from the tap challenge to scanning.
    static let wakeGuardTapBack = "wake.guard.tapBack"
}
