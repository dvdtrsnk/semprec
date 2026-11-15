import DesignSystem
import SwiftUI

/// The root screen of the Calendar tab. The Calendar feature replaces the body of `root` with its own screen; the app
/// scene already wraps the result in the tab's navigation stack.
enum CalendarTab {

    @MainActor
    static func root(_ composition: AppComposition) -> some View {
        StatusView(.empty(message: Text("tab.calendar.placeholder"), systemImage: "calendar"))
            .navigationTitle(Text("tab.calendar"))
    }
}
