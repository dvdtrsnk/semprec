import Foundation

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
/// when `hasEnd`); an empty `calendarId` is the default calendar and an empty `endDay` an event that ends on `day`.
/// `url`, `alertMinutes` (before the start) and `travelMinutes` belong to an event, `flagged` to a task; `nil` is no
/// alert or no travel time.
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
    public let endDay: String
    public let notes: String
    public let url: String
    public let alertMinutes: Int?
    public let travelMinutes: Int?
    public let repeatRule: NewItemRepeat
    public let flagged: Bool

    public init(
        kind: NewItemKind,
        title: String,
        day: String,
        timed: Bool,
        startMinutes: Int,
        hasEnd: Bool,
        endMinutes: Int,
        place: String,
        calendarId: String,
        endDay: String = "",
        notes: String = "",
        url: String = "",
        alertMinutes: Int? = nil,
        travelMinutes: Int? = nil,
        repeatRule: NewItemRepeat = .never,
        flagged: Bool = false
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
        self.endDay = endDay
        self.notes = notes
        self.url = url
        self.alertMinutes = alertMinutes
        self.travelMinutes = travelMinutes
        self.repeatRule = repeatRule
        self.flagged = flagged
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
