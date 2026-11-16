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

    /// Opens Podrobnosti for an event or a task; the other kinds of the calendar (birthdays, holidays, sleep) have
    /// no details sheet.
    func showDetails(itemId: String, kind: CalendarItemKind, day: String) {
        switch kind {
        case .event: context.showDetails(kind: .event, id: itemId, from: .calendar)
        case .task: context.showDetails(kind: .task, id: itemId, from: .calendar)
        default: break
        }
    }

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
