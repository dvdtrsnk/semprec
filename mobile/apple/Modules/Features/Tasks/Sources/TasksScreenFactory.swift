import CoreKit
import SwiftUI

/// The screens of the Tasks feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`, and
/// owns that model for as long as SwiftUI keeps the screen.
@MainActor
public enum TasksScreenFactory {

    // MARK: - Screens
    /// The Tasks screen. Every start of it (today, an area, a project, the open tasks of an area) is the same screen
    /// over a model that was made for that start.
    public static func tasks(
        makeModel: @escaping @MainActor () -> any TasksScreenModel,
        router: any TasksRouting
    ) -> some View {
        TasksScreen(viewModel: TasksViewModel(model: makeModel(), router: router))
    }

    /// The Podrobnosti sheet of a task or an event: the content of the sheet, which the app presents.
    public static func details(makeModel: @escaping @MainActor () -> any ItemDetailsScreenModel) -> some View {
        ItemDetailsScreen(viewModel: ItemDetailsViewModel(model: makeModel()))
    }
}
