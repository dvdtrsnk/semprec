import CoreKit
import SwiftUI

/// The screens of the Auth feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`,
/// and owns that model for as long as SwiftUI keeps the screen.
@MainActor
public enum AuthScreenFactory {

    // MARK: - Screens
    public static func login(makeModel: @escaping @MainActor () -> any LoginScreenModel) -> some View {
        LoginScreen(viewModel: LoginViewModel(model: makeModel()))
    }
}
