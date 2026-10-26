import SettingsFeature

/// Routes of the Settings feature, on the Settings tab's stack.
@MainActor
final class AppSettingsRouter {

    // MARK: - Dependencies
    private let context: NavigationContext

    // MARK: - Init
    init(context: NavigationContext) {
        self.context = context
    }
}

// MARK: - Protocol conformance
extension AppSettingsRouter: SettingsRouting {

    func showAbout() {
        context.presentSheet(.about, from: .settings)
    }
}
