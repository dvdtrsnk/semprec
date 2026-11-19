import NoteEditor

/// The note editor's subpages as pages of notes of their own.
@MainActor
final class NotesPageRouter {

    // MARK: - Dependencies
    private let router: any NotesRouting

    // MARK: - Init
    init(router: any NotesRouting) {
        self.router = router
    }
}

// MARK: - Protocol conformance
extension NotesPageRouter: NoteEditorRouting {

    func showPage(pageId: String, title: String, focusTitle: Bool) {
        router.showPage(itemId: pageId)
    }
}
