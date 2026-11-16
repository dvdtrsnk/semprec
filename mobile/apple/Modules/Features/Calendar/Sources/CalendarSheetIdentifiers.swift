import Foundation

/// Accessibility identifiers of the calendar sheets: calendars, invitations and the new item form. Android has no
/// calendar sheets yet, so none is shared.
enum CalendarSheetIdentifiers {

    // MARK: - Calendars
    static let calendarsScreen = "calendars.screen"
    static let calendarsDone = "calendars.done"
    static let calendarsToggleAll = "calendars.toggleAll"
    static let calendarsAdd = "calendars.add"
    static let calendarsBack = "calendars.back"
    static let calendarsDetail = "calendars.detail"
    static let calendarsName = "calendars.name"
    static let calendarsNotify = "calendars.notify"
    static let calendarsDelete = "calendars.delete"

    /// The show or hide button of a calendar's row, by the calendar's id.
    static func calendarToggle(_ id: String) -> String { "calendars.toggle.\(id)" }

    /// The info button of a calendar's row, by the calendar's id.
    static func calendarInfo(_ id: String) -> String { "calendars.info.\(id)" }

    /// A colour of the detail page, by the swatch's key.
    static func calendarColor(_ key: String) -> String { "calendars.color.\(key)" }

    // MARK: - Invitations
    static let invitationsScreen = "invitations.screen"
    static let invitationsDone = "invitations.done"
    static let invitationsTabs = "invitations.tabs"
    static let invitationsAccept = "invitations.accept"
    static let invitationsTentative = "invitations.tentative"
    static let invitationsDecline = "invitations.decline"
    static let invitationsAcknowledge = "invitations.acknowledge"
    static let invitationsStatus = "invitations.status"

    /// An invitation's row, by the invitation's id.
    static func invitationRow(_ id: String) -> String { "invitations.row.\(id)" }

    // MARK: - New item
    static let newItemScreen = "newItem.screen"
    static let newItemCancel = "newItem.cancel"
    static let newItemAdd = "newItem.add"
    static let newItemKind = "newItem.kind"
    static let newItemTitle = "newItem.title"
    static let newItemDate = "newItem.date"
    static let newItemTimed = "newItem.timed"
    static let newItemStart = "newItem.start"
    static let newItemHasEnd = "newItem.hasEnd"
    static let newItemEnd = "newItem.end"
    static let newItemPlace = "newItem.place"
    static let newItemCalendar = "newItem.calendar"
    static let newItemFailure = "newItem.failure"
}
