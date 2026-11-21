import Foundation

/// Accessibility identifiers of the Calendar feature's screens. Each value is what a UI test finds the element by.
enum CalendarIdentifiers {

    static let screen = "calendar.screen"
    static let today = "calendar.today"
    static let calendars = "calendar.calendars"
    static let invitations = "calendar.invitations"
    static let invitationsBadge = "calendar.invitationsBadge"
    static let newItem = "calendar.newItem"
    static let back = "calendar.back"
    static let timeline = "calendar.timeline"
    static let allDayRow = "calendar.allDayRow"
    static let monthGrid = "calendar.monthGrid"
    static let yearGrid = "calendar.yearGrid"
    static let menu = "calendar.menu"
    /// The buttons of the question before an item is deleted.
    static let deleteConfirm = "calendar.delete.confirm"
    static let deleteCancel = "calendar.delete.cancel"
    static let clipboard = "calendar.clipboard"
    static let agenda = "calendar.agenda"
    static let agendaList = "calendar.agenda.list"
    /// Followed by the id of the entry, e.g. `calendar.agenda.entry.e1`.
    static let agendaEntryPrefix = "calendar.agenda.entry."
    static let agendaMore = "calendar.agenda.more"

    /// A day of the week strip, the month grid or the year grid.
    static func day(_ date: String) -> String { "calendar.day.\(date)" }

    /// An item of the day or the month, by its id.
    static func item(_ id: String) -> String { "calendar.item.\(id)" }
}
