import NavigatorUI

/// Every screen the app pushes or presents. `AppScene` provides their views, because the features that render
/// them know neither each other nor the navigation library.
enum AppDestination: Hashable {

    case detail(itemId: String)
    case about
    /// The sleep plan sheet; `night` is the evening (`YYYY-MM-DD`) whose ring it shows, or nil.
    case sleepPlan(night: String?)
    /// The sheet of one night (`YYYY-MM-DD`), which opens on that night.
    case sleepNight(night: String)
    /// The calendars sheet: which calendars show, their colours and notifications.
    case calendars
    /// The invitations sheet.
    case invitations
    /// The new item sheet, opened for the day `YYYY-MM-DD`.
    case newItem(day: String)
}

// MARK: - NavigationProvidedDestination
extension AppDestination: NavigationProvidedDestination {}
