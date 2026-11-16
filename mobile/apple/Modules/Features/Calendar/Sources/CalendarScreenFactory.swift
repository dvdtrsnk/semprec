import CoreKit
import SwiftUI

/// The screens of the Calendar feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`,
/// and owns that model for as long as SwiftUI keeps the screen.
@MainActor
public enum CalendarScreenFactory {

    // MARK: - Screens
    /// The calendar, the root of the Calendar tab. `makeModel` receives the device's current day (`YYYY-MM-DD`),
    /// which the calendar opens on until the server's answer names its own today.
    public static func calendar(
        makeModel: @escaping @MainActor (_ initialDay: String) -> any CalendarScreenModel,
        router: any CalendarRouting
    ) -> some View {
        CalendarScreen(viewModel: CalendarViewModel(model: makeModel(CalendarDates.deviceToday()), router: router))
    }
}
