import CalendarFeature
import CoreKit

/// Routes of the Calendar feature: its sheets and the sleep sheets over the Calendar tab's stack.
@MainActor
final class AppCalendarRouter {

    // MARK: - Dependencies
    private let context: NavigationContext

    // MARK: - Init
    init(context: NavigationContext) {
        self.context = context
    }
}

// MARK: - Protocol conformance
extension AppCalendarRouter: CalendarRouting {

    /// The details sheet ("Podrobnosti") belongs to the Overview slice, which builds the shared TaskDetail screen.
    /// Until that screen is merged there is nothing to open, so the request is dropped; the integrator replaces this
    /// body with the presentation of the real destination.
    func showDetails(itemId: String, kind: CalendarItemKind, day: String) {}

    func showCalendars() {
        context.presentSheet(.calendars, from: .calendar)
    }

    func showInvitations() {
        context.presentSheet(.invitations, from: .calendar)
    }

    func showNewItem(day: String) {
        context.presentSheet(.newItem(day: day), from: .calendar)
    }

    func showSleepNight(night: String) {
        context.presentSheet(.sleepNight(night: night), from: .calendar)
    }

    func showSleepPlan() {
        context.presentSheet(.sleepPlan(night: nil), from: .calendar)
    }
}
