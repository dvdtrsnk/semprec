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
    /// The debug menu and its alarm tool; Apple-only, because they try the platform features of Apple devices.
    static let debugOpen = "debug.open"
    static let debugMenu = "debug.menu"
    static let debugAlarmsRow = "debug.row.alarms"
    static let debugAlarmScreen = "debug.alarm"
    static let debugAlarmRefresh = "debug.alarm.refresh"
    static let debugAlarmPermission = "debug.alarm.permission"
    static let debugAlarmRequestPermission = "debug.alarm.permission.request"
    static let debugAlarmMission = "debug.alarm.mission"
    static let debugAlarmEditCodes = "debug.alarm.codes.edit"
    static let debugAlarmRepeat = "debug.alarm.repeat"
    static let debugAlarmTime = "debug.alarm.time"
    static let debugAlarmSchedule = "debug.alarm.schedule"
    static let debugAlarmIn10s = "debug.alarm.in10s"
    static let debugAlarmIn1m = "debug.alarm.in1m"
    static let debugAlarmIn5m = "debug.alarm.in5m"
    /// The cancel button of one alarm; the alarm's id follows.
    static let debugAlarmCancelPrefix = "debug.alarm.cancel."
    static let debugAlarmCancelAll = "debug.alarm.cancelAll"
}
