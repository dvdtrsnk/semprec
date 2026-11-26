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

    /// The provider's colour on the detail page of an account calendar.
    static let calendarsRemoteColor = "calendars.color.remote"

    /// The lock of a read-only calendar's row, by the calendar's id.
    static func calendarReadOnly(_ id: String) -> String { "calendars.readOnly.\(id)" }

    /// The header of an internet account's calendars, by the account's id.
    static func calendarAccount(_ id: String) -> String { "calendars.account.\(id)" }

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
    static let newItemDiscard = "newItem.discard"
    static let newItemKeepEditing = "newItem.keepEditing"
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
    static let newItemCalendarChooser = "newItem.calendar.chooser"
    static let newItemCalendarDone = "newItem.calendar.done"
    static let newItemFailure = "newItem.failure"
    static let newItemSchedule = "newItem.schedule"
    static let newItemRepeat = "newItem.repeat"
    static let newItemAlert = "newItem.alert"
    static let newItemTravel = "newItem.travel"
    static let newItemNotes = "newItem.notes"
    static let newItemUrl = "newItem.url"
    static let newItemFlag = "newItem.flag"

    /// A calendar of the new item's calendar chooser, by the calendar's id.
    static func newItemCalendarOption(_ id: String) -> String { "newItem.calendar.option.\(id)" }

    /// A section header of the calendar chooser: `own`, or `account.<id>` for an internet account's calendars.
    static func newItemCalendarSection(_ id: String) -> String { "newItem.calendar.section.\(id)" }
}
