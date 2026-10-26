import HomeFeature

/// Routes of the Home feature, on the Home tab's stack.
@MainActor
final class AppHomeRouter {

    // MARK: - Dependencies
    private let context: NavigationContext

    // MARK: - Init
    init(context: NavigationContext) {
        self.context = context
    }
}

// MARK: - Protocol conformance
extension AppHomeRouter: HomeRouting {

    func showDetail(itemId: String) {
        context.push(.detail(itemId: itemId), in: .home)
    }
}
