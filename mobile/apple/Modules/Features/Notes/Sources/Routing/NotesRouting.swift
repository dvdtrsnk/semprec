import CoreKit

/// How the Notes feature asks the app to show something. The app owns every stack and sheet.
@MainActor
public protocol NotesRouting: AnyObject {

    /// The page of a subpage block.
    func showPage(itemId: String)

    /// The page of `itemId` as one Markdown text, in the editor of the item.
    func showAsText(itemId: String)
}

/// A router for previews: it opens nothing.
@MainActor
final class PreviewNotesRouter: NotesRouting {

    // MARK: - Protocol conformance
    func showPage(itemId: String) {}

    func showAsText(itemId: String) {}
}
