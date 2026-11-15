import NavigatorUI

/// Every screen the app pushes or presents. `AppScene` provides their views, because the features that render
/// them know neither each other nor the navigation library.
enum AppDestination: Hashable {

    /// A screen a later wave of the app builds, shown as a notice that names it by `title`.
    case pending(title: String)
}

// MARK: - NavigationProvidedDestination
extension AppDestination: NavigationProvidedDestination {}
