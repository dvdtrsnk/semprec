import CoreKit
import SwiftUI

/// The screens of the Notes feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`, and
/// owns that model for as long as SwiftUI keeps the screen.
@MainActor
public enum NotesScreenFactory {

    // MARK: - Screens
    /// The page of notes of the item `itemId` (a project, an area or a subpage).
    public static func notes(
        itemId: String,
        makeModel: @escaping @MainActor () -> any NotesScreenModel,
        router: any NotesRouting
    ) -> some View {
        NotesScreen(viewModel: NotesViewModel(itemId: itemId, model: makeModel(), router: router))
    }
}
