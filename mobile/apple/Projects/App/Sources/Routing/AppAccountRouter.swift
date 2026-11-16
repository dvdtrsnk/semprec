import AccountFeature
import CoreKit

/// Routes of the Account feature, inside the profile sheet. The Semp status and the email accounts belong to features
/// that are built elsewhere; until they are, their rows open a notice that names them.
@MainActor
final class AppAccountRouter {

    // MARK: - Dependencies
    private let path: AccountPath

    // MARK: - Init
    init(path: AccountPath) {
        self.path = path
    }
}

// MARK: - Protocol conformance
extension AppAccountRouter: AccountRouting {

    /// Pushes `page` onto the sheet's stack, unless it already is the page on top (a second tap that arrived with the
    /// first).
    func show(_ page: AccountPage) {
        guard path.pages.last != page else { return }
        path.pages.append(page)
    }
}
