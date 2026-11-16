import Foundation

/// What the Inbox asks of the app's navigation.
@MainActor
public protocol InboxRouting: AnyObject {

    /// Shows the item a decision created: `databaseKey` is its database's canonical key when the server named it.
    func showItem(databaseKey: String?, itemId: String)
}

/// A router for previews: it goes nowhere.
@MainActor
final class PreviewInboxRouter: InboxRouting {

    func showItem(databaseKey: String?, itemId: String) {}
}
