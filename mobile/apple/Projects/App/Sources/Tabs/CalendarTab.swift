import CalendarFeature
import CoreKit
import SwiftUI

/// The root screen of the Calendar tab: the calendar.
enum CalendarTab {

    @MainActor
    static func root(_ composition: AppComposition) -> some View {
        CalendarScreenFactory.calendar(
            makeModel: { composition.preparedTabs.calendarModel(initialDay: $0) },
            router: composition.calendarRouter
        )
    }
}
