import SleepFeature

/// Routes of the Sleep feature: the wake settings, a sheet over the stack of the tab the sleep sheet was opened from.
/// That stack has one sheet at a time, so the wake settings take the place of the sleep sheet.
@MainActor
final class AppSleepRouter {

    // MARK: - Dependencies
    private let context: NavigationContext
    private let tab: @MainActor () -> AppTab

    // MARK: - Init
    /// `tab` names the tab the sleep sheet is presented over, when a route asks.
    init(context: NavigationContext, tab: @escaping @MainActor () -> AppTab) {
        self.context = context
        self.tab = tab
    }
}

// MARK: - Protocol conformance
extension AppSleepRouter: SleepRouting {

    func showWakeSettings() {
        context.presentSheet(.sleepWakeSettings, from: tab())
    }
}
