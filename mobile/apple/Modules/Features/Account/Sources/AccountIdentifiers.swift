/// Accessibility identifiers of the Account feature's elements; Apple-only until Android builds the screens.
enum AccountIdentifiers {

    // Profile; the three that the app's sheet had before keep their values.
    static let profileScreen = "profile.screen"
    static let profileSignOut = "profile.signOut"
    static let profileDone = "profile.done"
    static let profileRowPrefix = "profile.row."
    static let profileLanguage = "profile.language"
    static let profilePassword = "profile.password"

    static let devicesScreen = "devices.screen"
    static let devicesCurrent = "devices.current"
    static let devicePrefix = "devices.device."
    static let devicesSignOutOthers = "devices.signOutOthers"
    static let devicesConfirm = "devices.confirm"

    static let notificationsScreen = "notifications.screen"
    static let notificationSwitchPrefix = "notifications.switch."
    static let notificationProblems = "notifications.problems"

    static let usageScreen = "usage.screen"
    static let usagePeriodPrefix = "usage.period."
    static let usageBarPrefix = "usage.bar."
    static let usageTotal = "usage.total"

    static let trashScreen = "trash.screen"
    static let trashTabPrefix = "trash.tab."
    static let trashRowPrefix = "trash.row."
    static let trashRestorePrefix = "trash.restore."
    static let trashSelect = "trash.select"
    static let trashSelectAll = "trash.selectAll"
    static let trashRestoreSelected = "trash.restoreSelected"
    static let trashToast = "trash.toast"
}
