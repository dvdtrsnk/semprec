import CoreKit
import SwiftUI

/// The screens of the Settings feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`,
/// and owns that model for as long as SwiftUI keeps the screen.
@MainActor
public enum SettingsScreenFactory {

    // MARK: - Screens
    public static func settings(
        makeModel: @escaping @MainActor () -> any SettingsScreenModel,
        router: any SettingsRouting
    ) -> some View {
        SettingsScreen(viewModel: SettingsViewModel(model: makeModel(), router: router))
    }

    /// The About sheet for the app's marketing `version` and `build` number.
    public static func about(version: String, build: String) -> some View {
        AboutScreen(version: version, build: build)
    }
}
