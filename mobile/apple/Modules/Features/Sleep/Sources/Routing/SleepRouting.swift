import Foundation

/// Navigation the Sleep feature requests. The app implements it on its own navigation stacks and sheets.
@MainActor
public protocol SleepRouting: AnyObject {

    /// Opens the wake settings of this device: whether only a scanned code stops a sleep alarm, and the codes.
    func showWakeSettings()
}

// MARK: - Preview router
@MainActor
final class PreviewSleepRouter: SleepRouting {

    // MARK: - Methods
    func showWakeSettings() {}
}
