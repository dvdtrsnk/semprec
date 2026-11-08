import CoreKit
import SwiftUI

/// The screens of the Home feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`,
/// and owns that model for as long as SwiftUI keeps the screen.
@MainActor
public enum HomeScreenFactory {

    // MARK: - Screens
    public static func home(
        makeModel: @escaping @MainActor () -> any HomeScreenModel,
        router: any HomeRouting
    ) -> some View {
        HomeScreen(viewModel: HomeViewModel(model: makeModel(), router: router))
    }

    public static func detail(makeModel: @escaping @MainActor () -> any DetailScreenModel) -> some View {
        DetailScreen(viewModel: DetailViewModel(model: makeModel()))
    }
}
