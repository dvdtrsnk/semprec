import NoteEditor

/// A subpage linked from a period's note opens on its own screen, as the diary opens it.
@MainActor
final class JournalNoteRouter {

    // MARK: - Dependencies
    private let router: any JournalRouting

    // MARK: - Init
    init(router: any JournalRouting) {
        self.router = router
    }
}

// MARK: - Protocol conformance
extension JournalNoteRouter: NoteEditorRouting {

    func showPage(pageId: String, title: String, trail: [String], focusTitle: Bool) {
        router.showPage(itemId: pageId, title: title)
    }
}
