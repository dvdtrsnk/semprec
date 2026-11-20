import CoreKit

/// How the Notes feature asks the app to show something. The app owns every stack and sheet.
@MainActor
public protocol NotesRouting: AnyObject {

    /// The subpage `itemId` under the pages of `trail`, outermost first; `focusTitle` when it was just made from an
    /// empty block.
    func showPage(itemId: String, trail: [String], focusTitle: Bool)
}
