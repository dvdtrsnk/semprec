import Combine
import CoreKit

/// The pages the person opened inside the profile sheet, in the order they were opened. The sheet has a navigation
/// stack of its own, because it covers the Overview stack: the app owns it, and the Account feature only asks for a
/// page through its router.
@MainActor
final class AccountPath: ObservableObject {

    // MARK: - Published Properties
    @Published var pages: [AccountPage] = []
}
