import Foundation

/// Navigation the Settings feature requests. The app implements it on its own navigation stacks.
@MainActor
public protocol SettingsRouting: AnyObject {

    // MARK: - Presentation
    func showAbout()
}

// MARK: - Preview router
@MainActor
final class PreviewSettingsRouter: SettingsRouting {

    // MARK: - Methods
    func showAbout() {}
}
