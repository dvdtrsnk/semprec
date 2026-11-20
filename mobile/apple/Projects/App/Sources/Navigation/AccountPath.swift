import Combine
import CoreKit

/// The pages the person opened inside the profile sheet, in the order they were opened. The sheet has a navigation
/// stack of its own, because it covers the stack it was presented over: the app owns it, and the Account feature only
/// asks for a page through its router.
@MainActor
final class AccountPath: ObservableObject {

    // MARK: - Published Properties
    @Published var pages: [ProfileSheetPage]

    // MARK: - Init
    /// `pages` are the pages the sheet opens on, the profile being under them.
    init(pages: [ProfileSheetPage] = []) {
        self.pages = pages
    }
}
