import NotesFeature

/// Routes of the Notes feature, on the stack of the tab the notes screen was created for: a subpage is another page of
/// notes, and the page as one text is the editor of the item.
@MainActor
final class AppNotesRouter {

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
extension AppNotesRouter: NotesRouting {

    func showPage(itemId: String) {
        context.push(.notes(itemId: itemId, tab: tab), in: tab)
    }

    func showAsText(itemId: String) {
        context.push(.collectionItem(itemId: itemId, databaseKey: nil), in: tab)
    }
}
