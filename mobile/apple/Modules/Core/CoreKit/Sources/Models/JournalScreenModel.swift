import Foundation

public enum JournalPhase: Equatable, Sendable {

    case loading
    case content
    /// `nil` for an unexpected failure, which has no typed reason.
    case failure(FailureKind?)
}

/// The selected period: its kind (never `.week`) and its first day, `YYYY-MM-DD`.
public struct JournalSelection: Equatable, Sendable {

    public let kind: JournalPeriodKind
    public let start: String

    public init(kind: JournalPeriodKind, start: String) {
        self.kind = kind
        self.start = start
    }
}

/// One cell of a row of the time axis; `start` is the first day of its period, `YYYY-MM-DD`. `weekday` is 1 for
/// Monday up to 7 for Sunday and `quarter` 1 to 4.
public struct JournalAxisCell: Equatable, Sendable, Identifiable {

    public let kind: JournalPeriodKind
    public let start: String
    public let year: Int
    public let quarter: Int
    public let month: Int
    public let day: Int
    public let weekday: Int
    public let onPath: Bool
    public let current: Bool
    public let today: Bool

    public var id: String { start }

    public init(
        kind: JournalPeriodKind,
        start: String,
        year: Int,
        quarter: Int,
        month: Int,
        day: Int,
        weekday: Int,
        onPath: Bool,
        current: Bool,
        today: Bool
    ) {
        self.kind = kind
        self.start = start
        self.year = year
        self.quarter = quarter
        self.month = month
        self.day = day
        self.weekday = weekday
        self.onPath = onPath
        self.current = current
        self.today = today
    }
}

public struct JournalAxisRow: Equatable, Sendable, Identifiable {

    public let kind: JournalPeriodKind
    public let cells: [JournalAxisCell]

    public var id: JournalPeriodKind { kind }

    public init(kind: JournalPeriodKind, cells: [JournalAxisCell]) {
        self.kind = kind
        self.cells = cells
    }
}

/// A week of the diary; `firstDay` and `lastDay` are `YYYY-MM-DD` and `page` is its note.
public struct JournalWeek: Equatable, Sendable, Identifiable {

    public let number: Int
    public let firstDay: String
    public let lastDay: String
    public let page: JournalPage

    public var id: Int { number }

    public init(number: Int, firstDay: String, lastDay: String, page: JournalPage) {
        self.number = number
        self.firstDay = firstDay
        self.lastDay = lastDay
        self.page = page
    }
}

/// A quarter of the diary, 1 to 4; `firstDay` and `lastDay` are `YYYY-MM-DD` and `page` is its note.
public struct JournalQuarter: Equatable, Sendable, Identifiable {

    public let number: Int
    public let firstDay: String
    public let lastDay: String
    public let page: JournalPage

    public var id: Int { number }

    public init(number: Int, firstDay: String, lastDay: String, page: JournalPage) {
        self.number = number
        self.firstDay = firstDay
        self.lastDay = lastDay
        self.page = page
    }
}

/// An event of the selected day; the times are minutes since midnight and `nil` for an all-day event.
public struct JournalEvent: Equatable, Sendable, Identifiable {

    public let id: String
    public let title: String
    public let startMinutes: Int?
    public let endMinutes: Int?
    public let allDay: Bool
    public let place: String?
    public let projectName: String?
    /// The `#RRGGBB` of the event's project.
    public let projectColor: String?
    public let hasTranscript: Bool

    public init(
        id: String,
        title: String,
        startMinutes: Int? = nil,
        endMinutes: Int? = nil,
        allDay: Bool = false,
        place: String? = nil,
        projectName: String? = nil,
        projectColor: String? = nil,
        hasTranscript: Bool = false
    ) {
        self.id = id
        self.title = title
        self.startMinutes = startMinutes
        self.endMinutes = endMinutes
        self.allDay = allDay
        self.place = place
        self.projectName = projectName
        self.projectColor = projectColor
        self.hasTranscript = hasTranscript
    }
}

public struct JournalBirthday: Equatable, Sendable, Identifiable {

    public let id: String
    public let personName: String

    public init(id: String, personName: String) {
        self.id = id
        self.personName = personName
    }
}

/// Where an Inbox item stands.
public enum JournalInboxStatus: Equatable, Sendable {

    case none
    case pending
    case failed
    case needsClarification
    case proposed
    case confirmed
    case rejected
    case invalid
}

public struct JournalInboxItem: Equatable, Sendable, Identifiable {

    public let id: String
    public let time: String?
    public let text: String?
    public let emoji: String?
    public let status: JournalInboxStatus
    public let attachmentName: String?
    public let attachmentCount: Int

    public init(
        id: String,
        time: String? = nil,
        text: String? = nil,
        emoji: String? = nil,
        status: JournalInboxStatus = .none,
        attachmentName: String? = nil,
        attachmentCount: Int = 0
    ) {
        self.id = id
        self.time = time
        self.text = text
        self.emoji = emoji
        self.status = status
        self.attachmentName = attachmentName
        self.attachmentCount = attachmentCount
    }
}

/// The diary: the selected period of the time axis with its note and, for a day, its events, birthdays and Inbox.
/// A month has no `page` of its own; it lists its `weeks`. A year lists its `quarters`. A day has its own week in
/// `weeks`.
public struct JournalState: Equatable, Sendable {

    public var phase: JournalPhase
    public var selection: JournalSelection
    /// The server's current day, `YYYY-MM-DD`.
    public var today: String
    public var axis: [JournalAxisRow]
    public var page: JournalPage?
    public var weeks: [JournalWeek]
    public var quarters: [JournalQuarter]
    public var events: [JournalEvent]
    public var birthdays: [JournalBirthday]
    public var inbox: [JournalInboxItem]
    /// The period the page, weeks, quarters, events and Inbox belong to: right after a new selection still the previous
    /// one, until the new period arrives. `nil` while nothing is shown.
    public var shown: JournalSelection?

    public init(
        phase: JournalPhase,
        selection: JournalSelection,
        today: String,
        axis: [JournalAxisRow] = [],
        page: JournalPage? = nil,
        weeks: [JournalWeek] = [],
        quarters: [JournalQuarter] = [],
        events: [JournalEvent] = [],
        birthdays: [JournalBirthday] = [],
        inbox: [JournalInboxItem] = [],
        shown: JournalSelection? = nil
    ) {
        self.phase = phase
        self.selection = selection
        self.today = today
        self.axis = axis
        self.page = page
        self.weeks = weeks
        self.quarters = quarters
        self.events = events
        self.birthdays = birthdays
        self.inbox = inbox
        self.shown = shown
    }
}

public enum JournalAction: Equatable, Sendable {

    case retry
    /// Shows the period of `kind` that starts on `start` (`YYYY-MM-DD`).
    case select(kind: JournalPeriodKind, start: String)
    case goToday
    /// Moves the windows of the time axis around `day` (`YYYY-MM-DD`); the selection stays.
    case showAxisAround(day: String)
    case openEvent(id: String)
    case openInbox
}

public enum JournalEffect: Equatable, Sendable {

    case openEvent(id: String)
    case openInbox
}

public typealias JournalScreenModel = ScreenModel<JournalState, JournalAction, JournalEffect>

/// Journal screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedJournalScreenModel = ScriptedScreenModel<JournalState, JournalAction, JournalEffect>
