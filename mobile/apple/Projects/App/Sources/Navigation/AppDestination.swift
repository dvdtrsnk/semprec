import CoreKit
import NavigatorUI

/// Every screen the app pushes or presents. `AppScene` provides their views, because the features that render
/// them know neither each other nor the navigation library.
enum AppDestination: Hashable {

    /// A screen a later wave of the app builds, shown as a notice that names it by `title`.
    case pending(title: String)
    /// The profile and settings of the account, presented as a sheet.
    case profile
    /// The Tasks screen, started as `start` says, on the stack of `tab`.
    case tasks(TasksStart, tab: AppTab)
    /// The Podrobnosti sheet of a task or an event; it is presented over the stack that asked for it.
    case details(ItemDetailsTarget)
}

// MARK: - NavigationProvidedDestination
extension AppDestination: NavigationProvidedDestination {}
