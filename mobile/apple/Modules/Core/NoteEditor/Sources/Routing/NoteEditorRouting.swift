import CoreKit

/// How the note editor asks its host to show a subpage. The host owns every stack.
@MainActor
public protocol NoteEditorRouting: AnyObject {

    /// The subpage `pageId`, titled `title`, under the pages of `trail` (outermost first, this page last);
    /// `focusTitle` when it was just made from an empty block.
    func showPage(pageId: String, title: String, trail: [String], focusTitle: Bool)
}

/// A router for previews and for a note without subpages: it opens nothing.
@MainActor
public final class NoSubpagesRouter: NoteEditorRouting {

    public init() {}

    // MARK: - Protocol conformance
    public func showPage(pageId: String, title: String, trail: [String], focusTitle: Bool) {}
}
