import CoreKit
import Foundation

/// Navigation the Calendar feature requests. The app implements it on its own navigation stacks and sheets.
@MainActor
public protocol CalendarRouting: AnyObject {

    // MARK: - Details
    /// Opens the details ("Podrobnosti") of an event or a task on `day` (`YYYY-MM-DD`). `itemId` is the id of a
    /// stored item or an occurrence id of a series (`<seriesId>@<day>`).
    func showDetails(itemId: String, kind: CalendarItemKind, day: String)

    // MARK: - Sheets
    /// Opens the calendars sheet: which calendars show, their colours and notifications.
    func showCalendars()

    /// Opens the invitations sheet.
    func showInvitations()

    /// Opens the new item sheet for `day` (`YYYY-MM-DD`).
    func showNewItem(day: String)

    // MARK: - Sleep
    /// Opens the sleep of the evening `night` (`YYYY-MM-DD`) on its own sheet.
    func showSleepNight(night: String)

    /// Opens the sleep plans sheet.
    func showSleepPlan()

    // MARK: - Agenda
    /// Shows the calendar as a list from `day` (`YYYY-MM-DD`) on.
    func showAgenda(from day: String)
}

// MARK: - Preview router
@MainActor
final class PreviewCalendarRouter: CalendarRouting {

    // MARK: - Methods
    func showDetails(itemId: String, kind: CalendarItemKind, day: String) {}

    func showCalendars() {}

    func showInvitations() {}

    func showNewItem(day: String) {}

    func showSleepNight(night: String) {}

    func showSleepPlan() {}

    func showAgenda(from day: String) {}
}
