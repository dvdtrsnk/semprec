import Foundation

public enum CalendarAgendaKind: Equatable, Sendable {

    case event
    case task
}

/// One stored event or task of the agenda; `timeFrom` and `timeTo` are `HH:mm`, both nil for an all-day entry.
public struct CalendarAgendaEntry: Equatable, Sendable, Identifiable {

    public let id: String
    public let kind: CalendarAgendaKind
    public let title: String
    public let timeFrom: String?
    public let timeTo: String?
    public let allDay: Bool
    public let done: Bool
    public let place: String?

    public init(
        id: String,
        kind: CalendarAgendaKind,
        title: String,
        timeFrom: String? = nil,
        timeTo: String? = nil,
        allDay: Bool = false,
        done: Bool = false,
        place: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.timeFrom = timeFrom
        self.timeTo = timeTo
        self.allDay = allDay
        self.done = done
        self.place = place
    }
}

/// The entries of one day, `YYYY-MM-DD`.
public struct CalendarAgendaDay: Equatable, Sendable, Identifiable {

    public let day: String
    public let entries: [CalendarAgendaEntry]

    public var id: String { day }

    public init(day: String, entries: [CalendarAgendaEntry]) {
        self.day = day
        self.entries = entries
    }
}

public enum CalendarAgendaPhase: Equatable, Sendable {

    case loading
    case content
    /// `failure` is nil for an unexpected failure.
    case failure(FailureKind?)
}

/// The calendar as a list, by day; `hasMore` while a further page exists, `moreFailure` why the last one was not read.
public struct CalendarAgendaState: Equatable, Sendable {

    public var phase: CalendarAgendaPhase
    public var days: [CalendarAgendaDay]
    public var hasMore: Bool
    public var loadingMore: Bool
    public var moreFailure: Failed?

    public init(
        phase: CalendarAgendaPhase = .loading,
        days: [CalendarAgendaDay] = [],
        hasMore: Bool = false,
        loadingMore: Bool = false,
        moreFailure: Failed? = nil
    ) {
        self.phase = phase
        self.days = days
        self.hasMore = hasMore
        self.loadingMore = loadingMore
        self.moreFailure = moreFailure
    }
}

public enum CalendarAgendaAction: Equatable, Sendable {

    case retry
    case loadMore
    case open(id: String)
}

public enum CalendarAgendaEffect: Equatable, Sendable {

    case openDetails(kind: CalendarAgendaKind, id: String)
}

public typealias CalendarAgendaScreenModel =
    ScreenModel<CalendarAgendaState, CalendarAgendaAction, CalendarAgendaEffect>

/// An agenda that never starts the Kotlin runtime, for previews and feature tests.
public typealias ScriptedCalendarAgendaScreenModel =
    ScriptedScreenModel<CalendarAgendaState, CalendarAgendaAction, CalendarAgendaEffect>
