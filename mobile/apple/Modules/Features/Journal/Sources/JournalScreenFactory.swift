import CoreKit
import SwiftUI

/// The screens of the Journal feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`,
/// and owns that model for as long as SwiftUI keeps the screen.
@MainActor
public enum JournalScreenFactory {

    // MARK: - Screens
    /// The diary, the root of the Journal tab. `makeModel` receives the device's current day (`YYYY-MM-DD`), which
    /// the diary opens on until the server's answer names its own today.
    public static func journal(
        makeModel: @escaping @MainActor (_ initialDay: String) -> any JournalScreenModel,
        router: any JournalRouting
    ) -> some View {
        JournalScreen(viewModel: JournalViewModel(model: makeModel(JournalDates.deviceToday()), router: router))
    }

    /// A subpage of the diary on its own screen; `title` is the caption of the link that opened it.
    public static func subpage(
        title: String,
        makeModel: @escaping @MainActor () -> any JournalSubpageScreenModel,
        router: any JournalRouting
    ) -> some View {
        JournalSubpageScreen(title: title, viewModel: JournalSubpageViewModel(model: makeModel(), router: router))
    }
}
