import NavigatorUI

/// Every screen the app pushes or presents. `AppScene` provides their views, because the features that render
/// them know neither each other nor the navigation library.
enum AppDestination: Hashable {

    case detail(itemId: String)
    case about
}

// MARK: - NavigationProvidedDestination
extension AppDestination: NavigationProvidedDestination {}
