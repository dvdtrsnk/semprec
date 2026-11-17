import Foundation

// MARK: - Calendars list

public enum CalendarListPhase: Equatable, Sendable {

    case loading
    case content
    /// `nil` for an unexpected failure, which has no typed reason.
    case failure(FailureKind?)
}

/// Where a calendar comes from, which decides what can be done with it.
public enum CalendarGroup: Equatable, Sendable {

    case own
    case system
    case subscription
}

/// A colour a calendar can take; `key` names it for the copy, `hex` is `#RRGGBB`.
public struct CalendarSwatch: Equatable, Sendable, Identifiable {

    public let key: String
    public let hex: String

    public var id: String { key }

    public init(key: String, hex: String) {
        self.key = key
        self.hex = hex
    }
}

/// A calendar of the list. `systemKey` is `tasks`, `birthdays`, `sleep` or `holidaysCz` for one Semprec fills.
public struct CalendarRow: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let color: String
    public let hidden: Bool
    public let notify: Bool
    public let group: CalendarGroup
    public let systemKey: String?
    public let isDefault: Bool
    public let canRename: Bool
    public let canDelete: Bool

    public init(
        id: String,
        name: String,
        color: String,
        hidden: Bool = false,
        notify: Bool = true,
        group: CalendarGroup = .own,
        systemKey: String? = nil,
        isDefault: Bool = false,
        canRename: Bool = true,
        canDelete: Bool = true
    ) {
        self.id = id
        self.name = name
        self.color = color
        self.hidden = hidden
        self.notify = notify
        self.group = group
        self.systemKey = systemKey
        self.isDefault = isDefault
        self.canRename = canRename
        self.canDelete = canDelete
    }
}

/// What deleting a calendar would cancel, shown before the delete is confirmed.
public struct CalendarImpact: Equatable, Sendable {

    public let calendarId: String
    public let eventCount: Int
    public let recipientCount: Int
    public let cancellationCount: Int

    public init(calendarId: String, eventCount: Int, recipientCount: Int, cancellationCount: Int) {
        self.calendarId = calendarId
        self.eventCount = eventCount
        self.recipientCount = recipientCount
        self.cancellationCount = cancellationCount
    }
}

/// The calendars sheet. `detailId` is the calendar whose settings are open; `impact` is a delete waiting for its
/// confirmation.
public struct CalendarListState: Equatable, Sendable {

    public var phase: CalendarListPhase
    public var calendars: [CalendarRow]
    public var swatches: [CalendarSwatch]
    public var detailId: String?
    public var impact: CalendarImpact?
    public var busy: Bool
    public var problem: Bool
    public var problemFailure: FailureKind?

    public init(
        phase: CalendarListPhase,
        calendars: [CalendarRow] = [],
        swatches: [CalendarSwatch] = [],
        detailId: String? = nil,
        impact: CalendarImpact? = nil,
        busy: Bool = false,
        problem: Bool = false,
        problemFailure: FailureKind? = nil
    ) {
        self.phase = phase
        self.calendars = calendars
        self.swatches = swatches
        self.detailId = detailId
        self.impact = impact
        self.busy = busy
        self.problem = problem
        self.problemFailure = problemFailure
    }
}

public enum CalendarListAction: Equatable, Sendable {

    case retry
    case toggleHidden(calendarId: String)
    case setAllHidden(Bool)
    case openDetail(calendarId: String)
    case closeDetail
    case rename(calendarId: String, name: String)
    case setColor(calendarId: String, color: String)
    case setNotify(calendarId: String, notify: Bool)
    case add(name: String)
    case requestDelete(calendarId: String)
    case confirmDelete
    case cancelDelete
    case openSleep
    case dismissProblem
}

public enum CalendarListEffect: Equatable, Sendable {

    case openSleep
}

public typealias CalendarListScreenModel = ScreenModel<CalendarListState, CalendarListAction, CalendarListEffect>

/// Calendars sheet model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedCalendarListScreenModel =
    ScriptedScreenModel<CalendarListState, CalendarListAction, CalendarListEffect>

// MARK: - Invitations

public enum InvitationsPhase: Equatable, Sendable {

    case loading
    case content
    /// `nil` for an unexpected failure, which has no typed reason.
    case failure(FailureKind?)
}

/// Which list the sheet shows: the invitations that wait for an answer, or the answered ones.
public enum InvitationsTab: Equatable, Sendable {

    case pending
    case answered
}

public enum InvitationItemKind: Equatable, Sendable {

    case invite
    case sharedCalendarNotice
}

/// Where an invitation stands; every status but `pending` is an answer.
public enum InvitationItemStatus: Equatable, Sendable {

    case pending
    case accepted
    case tentative
    case declined
    case acknowledged
    case cancelled
}

/// What a person answers; a notice is only acknowledged.
public enum InvitationReply: Equatable, Sendable {

    case accept
    case tentative
    case decline
    case acknowledge
}

/// One invitation. `startsAt` and `endsAt` are ISO instants, `timeZone` the zone to show them in.
public struct InvitationItem: Equatable, Sendable, Identifiable {

    public let id: String
    public let kind: InvitationItemKind
    public let status: InvitationItemStatus
    public let title: String
    public let startsAt: String?
    public let endsAt: String?
    public let timeZone: String?
    public let allDay: Bool
    public let place: String?
    public let organizerName: String?

    public init(
        id: String,
        kind: InvitationItemKind = .invite,
        status: InvitationItemStatus = .pending,
        title: String,
        startsAt: String? = nil,
        endsAt: String? = nil,
        timeZone: String? = nil,
        allDay: Bool = false,
        place: String? = nil,
        organizerName: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.status = status
        self.title = title
        self.startsAt = startsAt
        self.endsAt = endsAt
        self.timeZone = timeZone
        self.allDay = allDay
        self.place = place
        self.organizerName = organizerName
    }
}

/// The invitations sheet: `items` are the ones of the shown `tab`, `pending` how many wait for an answer.
public struct InvitationsState: Equatable, Sendable {

    public var phase: InvitationsPhase
    public var tab: InvitationsTab
    public var items: [InvitationItem]
    public var pending: Int
    public var answering: String?
    public var problem: Bool
    public var problemFailure: FailureKind?

    public init(
        phase: InvitationsPhase,
        tab: InvitationsTab = .pending,
        items: [InvitationItem] = [],
        pending: Int = 0,
        answering: String? = nil,
        problem: Bool = false,
        problemFailure: FailureKind? = nil
    ) {
        self.phase = phase
        self.tab = tab
        self.items = items
        self.pending = pending
        self.answering = answering
        self.problem = problem
        self.problemFailure = problemFailure
    }
}

public enum InvitationsAction: Equatable, Sendable {

    case retry
    case showTab(InvitationsTab)
    case answer(invitationId: String, reply: InvitationReply)
    case dismissProblem
}

public typealias InvitationsScreenModel = ScreenModel<InvitationsState, InvitationsAction, Never>

/// Invitations sheet model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedInvitationsScreenModel = ScriptedScreenModel<InvitationsState, InvitationsAction, Never>

// MARK: - New item

public enum NewItemPhase: Equatable, Sendable {

    case loading
    case editing
    case saving
    /// `.rejected` is a form the rules or the server refused; `nil` is an unexpected failure.
    case failed(FailureKind?)
}

public enum NewItemKind: Equatable, Sendable {

    case event
    case task
}

/// A calendar a new event can be put on.
public struct NewItemCalendar: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let color: String
    public let isDefault: Bool

    public init(id: String, name: String, color: String, isDefault: Bool = false) {
        self.id = id
        self.name = name
        self.color = color
        self.isDefault = isDefault
    }
}

public struct NewItemState: Equatable, Sendable {

    public var phase: NewItemPhase
    public var calendars: [NewItemCalendar]
    public var defaultDay: String

    public init(phase: NewItemPhase, calendars: [NewItemCalendar] = [], defaultDay: String) {
        self.phase = phase
        self.calendars = calendars
        self.defaultDay = defaultDay
    }
}

/// The values of the new item form. The times are minutes of the day and are read only when `timed` (the end only
/// when `hasEnd`); an empty `calendarId` is the default calendar.
public struct NewItemDraft: Equatable, Sendable {

    public let kind: NewItemKind
    public let title: String
    public let day: String
    public let timed: Bool
    public let startMinutes: Int
    public let hasEnd: Bool
    public let endMinutes: Int
    public let place: String
    public let calendarId: String

    public init(
        kind: NewItemKind,
        title: String,
        day: String,
        timed: Bool,
        startMinutes: Int,
        hasEnd: Bool,
        endMinutes: Int,
        place: String,
        calendarId: String
    ) {
        self.kind = kind
        self.title = title
        self.day = day
        self.timed = timed
        self.startMinutes = startMinutes
        self.hasEnd = hasEnd
        self.endMinutes = endMinutes
        self.place = place
        self.calendarId = calendarId
    }
}

public enum NewItemAction: Equatable, Sendable {

    case create(NewItemDraft)
    /// The person changed a field: an earlier failure no longer applies.
    case edited
}

public enum NewItemEffect: Equatable, Sendable {

    case created(itemId: String)
}

public typealias NewItemScreenModel = ScreenModel<NewItemState, NewItemAction, NewItemEffect>

/// New item form model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedNewItemScreenModel = ScriptedScreenModel<NewItemState, NewItemAction, NewItemEffect>
