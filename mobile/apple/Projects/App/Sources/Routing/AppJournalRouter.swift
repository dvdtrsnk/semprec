import JournalFeature

/// Routes of the Journal feature, on the Journal tab's stack: an event of the day opens in Podrobnosti, a subpage of
/// the diary is pushed, and the Inbox (which a later wave builds) opens as a notice that names it.
@MainActor
final class AppJournalRouter {

    // MARK: - Dependencies
    private let context: NavigationContext

    // MARK: - Init
    init(context: NavigationContext) {
        self.context = context
    }
}

// MARK: - Protocol conformance
extension AppJournalRouter: JournalRouting {

    func showEvent(id: String) {
        context.showDetails(kind: .event, id: id, from: .journal)
    }

    func showInbox() {
        context.push(.pending(title: String(localized: "pending.inbox")), in: .journal)
    }

    func showPage(itemId: String, title: String) {
        context.push(.journalPage(itemId: itemId, title: title), in: .journal)
    }
}
