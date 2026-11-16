import Foundation

/// Navigation the Journal feature requests. The app implements it on its own navigation stacks.
@MainActor
public protocol JournalRouting: AnyObject {

    // MARK: - Event
    /// Opens the details of an event of the day; `id` is the event's item id or an occurrence id of a series.
    func showEvent(id: String)

    // MARK: - Inbox
    /// Opens the Inbox, where the day's captured items are processed.
    func showInbox()

    // MARK: - Subpage
    /// Opens a subpage of the diary on its own screen; `title` is the caption of the link that was tapped.
    func showPage(itemId: String, title: String)
}

// MARK: - Preview router
@MainActor
final class PreviewJournalRouter: JournalRouting {

    // MARK: - Methods
    func showEvent(id: String) {}

    func showInbox() {}

    func showPage(itemId: String, title: String) {}
}
