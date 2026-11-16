import CoreKit
import SwiftUI

/// The screens of the Overview feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`, and
/// owns that model for as long as SwiftUI keeps the screen. The search overlay makes its own model each time it opens.
@MainActor
public enum OverviewScreenFactory {

    // MARK: - Screens
    public static func overview(
        makeModel: @escaping @MainActor () -> any OverviewScreenModel,
        makeSearch: @escaping @MainActor () -> any SearchScreenModel,
        router: any OverviewRouting
    ) -> some View {
        OverviewScreen(
            viewModel: OverviewViewModel(model: makeModel(), router: router),
            makeSearch: makeSearch,
            router: router
        )
    }
}
