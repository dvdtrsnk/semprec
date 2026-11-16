import InboxFeature

/// Routes of the Inbox feature, on the stack of the tab it was created for. What a decision created opens as the
/// Podrobnosti sheet when it is a task or an event, and as an item of its collection otherwise
/// (`NavigationContext.showItem`).
@MainActor
final class AppInboxRouter {

    // MARK: - Dependencies
    private let context: NavigationContext
    private let tab: AppTab

    // MARK: - Init
    init(context: NavigationContext, tab: AppTab) {
        self.context = context
        self.tab = tab
    }
}

// MARK: - Protocol conformance
extension AppInboxRouter: InboxRouting {

    func showItem(databaseKey: String?, itemId: String) {
        switch databaseKey {
        case "tasks": context.showDetails(kind: .task, id: itemId, from: tab)
        case "events": context.showDetails(kind: .event, id: itemId, from: tab)
        default: context.showItem(itemId: itemId, databaseKey: databaseKey, from: tab)
        }
    }
}
