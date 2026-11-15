import CoreKit
import NavigatorUI

/// Every screen the app pushes or presents. `AppScene` provides their views, because the features that render
/// them know neither each other nor the navigation library.
enum AppDestination: Hashable {

    case detail(itemId: String)
    case about
    /// A collection of any database (Projects, People, Companies, Events, Files), narrowed by its target.
    case collection(CollectionTarget)
    /// The detail of an item of any database; `databaseKey` is its database's canonical key, if the caller knows it.
    case collectionItem(itemId: String, databaseKey: String?)
}

// MARK: - NavigationProvidedDestination
extension AppDestination: NavigationProvidedDestination {}
