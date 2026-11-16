import Foundation

/// Opening the screens the calendar does not show itself.
public enum CalendarOpen: Equatable, Sendable {

    case calendars
    case invitations
    case newItem(day: String)
    case sleep(night: String)
    /// The calendar as a list from `day` (`YYYY-MM-DD`) on.
    case agenda(day: String)
}
