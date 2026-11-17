import CoreKit
import SwiftUI

/// The screens of the Areas feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`, and
/// owns that model for as long as SwiftUI keeps the screen.
@MainActor
public enum AreasScreenFactory {

    // MARK: - Screens
    public static func area(
        areaId: String,
        makeModel: @escaping @MainActor () -> any AreaScreenModel,
        router: any AreasRouting
    ) -> some View {
        AreaScreen(viewModel: AreaViewModel(areaId: areaId, model: makeModel(), router: router))
    }
}
