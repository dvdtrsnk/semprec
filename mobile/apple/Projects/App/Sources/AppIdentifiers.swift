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
}
