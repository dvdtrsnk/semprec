import Foundation

/// How much of the calendar is shown: a year of months, a month of days or one day hour by hour.
public enum CalendarZoom: Equatable, Sendable {

    case year
    case month
    case day
}

public enum CalendarPhase: Equatable, Sendable {

    case loading
    case content
    /// `nil` for an unexpected failure, which has no typed reason.
    case failure(FailureKind?)
}

/// What an item of the calendar is. Birthdays, holidays, sleep nights and traces are not stored by the person.
public enum CalendarItemKind: Equatable, Sendable {

    case event
    case task
    case birthday
    case holiday
    case sleep
    case trace
}

/// What happened to a task in relation to the event it sits in.
public enum CalendarTaskInEvent: Equatable, Sendable {

    case open
    case missed
    case done
    case doneElsewhere
    case moved
}

/// How the chain of a carried-over task ended on the day of a trace.
public enum CalendarTraceOutcome: Equatable, Sendable {

    case carried
    case done
    case movedToEvent
    case missed
}

/// The edge of a timed item a handle drags.
public enum CalendarEdge: Equatable, Sendable {

    case start
    case end
}

public enum CalendarClipboardMode: Equatable, Sendable {

    case cut
    case copied
}

/// A task that sits in an event; `note` is the day (`YYYY-MM-DD`) or the event name a state refers to.
public struct CalendarEventTask: Equatable, Sendable, Identifiable {

    public let id: String
    public let title: String
    public let state: CalendarTaskInEvent
    public let note: String?

    public init(id: String, title: String, state: CalendarTaskInEvent, note: String?) {
        self.id = id
        self.title = title
        self.state = state
        self.note = note
    }
}

/// One item of one day. A timed item has `startMinutes` and `endMinutes` (minutes of the day, `endMinutes` a short
/// block after the start when `hasEnd` is false); `column` of `columns` places it next to the ones it overlaps, and
/// `depth` steps it in from the left of its column when it starts well after one it overlaps and is drawn over it.
/// `timeFrom` and `timeTo` are its own start and end as minutes of the day, whichever day it is drawn on (`timeTo` the
/// end the server decides for an event without a stored one); both are `nil` for an item without a time.
public struct CalendarItem: Equatable, Sendable {

    public let id: String
    public let kind: CalendarItemKind
    public let title: String
    /// The colour of its calendar, `#RRGGBB`.
    public let color: String
    public let date: String
    public let endDate: String?
    public let allDay: Bool
    public let startMinutes: Int?
    public let endMinutes: Int?
    public let hasEnd: Bool
    public let done: Bool
    public let missed: Bool
    public let place: String?
    public let tentative: Bool
    public let editable: Bool
    public let column: Int
    public let columns: Int
    public let depth: Int
    public let tasks: [CalendarEventTask]
    public let hostEventTitle: String?
    public let carriedFrom: String?
    public let trace: CalendarTraceOutcome?
    public let traceNote: String?
    public let timeFrom: Int?
    public let timeTo: Int?

    public init(
        id: String,
        kind: CalendarItemKind,
        title: String,
        color: String,
        date: String,
        endDate: String? = nil,
        allDay: Bool,
        startMinutes: Int? = nil,
        endMinutes: Int? = nil,
        hasEnd: Bool = false,
        done: Bool = false,
        missed: Bool = false,
        place: String? = nil,
        tentative: Bool = false,
        editable: Bool = true,
        column: Int = 0,
        columns: Int = 1,
        depth: Int = 0,
        tasks: [CalendarEventTask] = [],
        hostEventTitle: String? = nil,
        carriedFrom: String? = nil,
        trace: CalendarTraceOutcome? = nil,
        traceNote: String? = nil,
        timeFrom: Int? = nil,
        timeTo: Int? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.color = color
        self.date = date
        self.endDate = endDate
        self.allDay = allDay
        self.startMinutes = startMinutes
        self.endMinutes = endMinutes
        self.hasEnd = hasEnd
        self.done = done
        self.missed = missed
        self.place = place
        self.tentative = tentative
        self.editable = editable
        self.column = column
        self.columns = columns
        self.depth = depth
        self.tasks = tasks
        self.hostEventTitle = hostEventTitle
        self.carriedFrom = carriedFrom
        self.trace = trace
        self.traceNote = traceNote
        self.timeFrom = timeFrom
        self.timeTo = timeTo
    }
}

/// A day of the window: its items, and the sleep that starts on it (evening) and ends on it (morning).
public struct CalendarDayState: Equatable, Sendable, Identifiable {

    public let date: String
    public let items: [CalendarItem]
    public let sleepEvening: CalendarSleep?
    public let sleepMorning: CalendarSleep?

    public var id: String { date }

    public init(
        date: String,
        items: [CalendarItem] = [],
        sleepEvening: CalendarSleep? = nil,
        sleepMorning: CalendarSleep? = nil
    ) {
        self.date = date
        self.items = items
        self.sleepEvening = sleepEvening
        self.sleepMorning = sleepMorning
    }
}

/// A month of the year view: `leading` empty cells (the week starts on Monday), then `length` days.
public struct CalendarMonthState: Equatable, Sendable, Identifiable {

    public let year: Int
    public let month: Int
    public let leading: Int
    public let length: Int

    public var id: Int { year * 100 + month }

    public init(year: Int, month: Int, leading: Int, length: Int) {
        self.year = year
        self.month = month
        self.leading = leading
        self.length = length
    }
}

/// The item being dragged and where it would land; `intoEventId` is set when a task is over an event.
public struct CalendarDrag: Equatable, Sendable {

    public let itemId: String
    public let date: String
    public let allDay: Bool
    public let startMinutes: Int?
    public let endMinutes: Int?
    public let intoEventId: String?
    /// True from the drop until the answer of the server is shown.
    public let committing: Bool

    public init(
        itemId: String,
        date: String,
        allDay: Bool,
        startMinutes: Int?,
        endMinutes: Int?,
        intoEventId: String?,
        committing: Bool
    ) {
        self.itemId = itemId
        self.date = date
        self.allDay = allDay
        self.startMinutes = startMinutes
        self.endMinutes = endMinutes
        self.intoEventId = intoEventId
        self.committing = committing
    }
}

public struct CalendarClipboard: Equatable, Sendable {

    public let mode: CalendarClipboardMode
    public let title: String

    public init(mode: CalendarClipboardMode, title: String) {
        self.mode = mode
        self.title = title
    }
}

/// The calendar. `days` are the days of the loaded window (the six weeks of the selected month and a week on each
/// side), `monthGrid` the 42 days of the month view in order, `months` the twelve months of the selected year.
/// `nowMinutes` is the time of day on `today`, in `timezone`, the IANA zone of the server every time of the state is
/// in (empty until the server first answers). `problem` is true after a write that failed, with `problemFailure`.
public struct CalendarState: Equatable, Sendable {

    public var phase: CalendarPhase
    public var zoom: CalendarZoom
    public var selectedDay: String
    public var today: String
    public var nowMinutes: Int
    public var timezone: String
    public var days: [CalendarDayState]
    public var monthGrid: [String]
    public var months: [CalendarMonthState]
    public var pendingInvitations: Int
    public var selectedItemId: String?
    public var drag: CalendarDrag?
    public var sleepDrag: CalendarSleepDrag?
    public var clipboard: CalendarClipboard?
    public var busy: Bool
    public var problem: Bool
    public var problemFailure: FailureKind?

    public init(
        phase: CalendarPhase,
        zoom: CalendarZoom = .day,
        selectedDay: String,
        today: String,
        nowMinutes: Int = 0,
        timezone: String = "",
        days: [CalendarDayState] = [],
        monthGrid: [String] = [],
        months: [CalendarMonthState] = [],
        pendingInvitations: Int = 0,
        selectedItemId: String? = nil,
        drag: CalendarDrag? = nil,
        sleepDrag: CalendarSleepDrag? = nil,
        clipboard: CalendarClipboard? = nil,
        busy: Bool = false,
        problem: Bool = false,
        problemFailure: FailureKind? = nil
    ) {
        self.phase = phase
        self.zoom = zoom
        self.selectedDay = selectedDay
        self.today = today
        self.nowMinutes = nowMinutes
        self.timezone = timezone
        self.days = days
        self.monthGrid = monthGrid
        self.months = months
        self.pendingInvitations = pendingInvitations
        self.selectedItemId = selectedItemId
        self.drag = drag
        self.sleepDrag = sleepDrag
        self.clipboard = clipboard
        self.busy = busy
        self.problem = problem
        self.problemFailure = problemFailure
    }
}

/// Moving around the calendar and loading it.
public enum CalendarNavigation: Equatable, Sendable {

    case retry
    /// Reloads the window, for example when the app comes back to the front.
    case refresh
    case show(zoom: CalendarZoom, day: String)
    /// One step of the shown zoom: a day, a month or a year, forward for a positive count.
    case page(steps: Int)
    case goToday
}

/// Taps, selection, dragging and finishing a task: what is done with an item in place. Positions are raw minutes
/// of the day.
public enum CalendarGesture: Equatable, Sendable {

    case tap(itemId: String)
    case tapBackground
    case select(itemId: String)
    /// The checkbox of a task: on its own row, or in the event `inEventId` it sits in.
    case toggleDone(itemId: String, inEventId: String?)
    case dragMove(itemId: String, day: String, rawStart: Int, overAllDayRow: Bool, overEventId: String?)
    case dragResize(itemId: String, edge: CalendarEdge, rawMinutes: Int)
    case endDrag(commit: Bool)
    /// The night of the evening `night` moved (no `edge`) or stretched at one end, by `deltaMinutes`.
    case sleepDrag(night: String, edge: CalendarEdge?, deltaMinutes: Int)
    case endSleepDrag(commit: Bool)
    case moveToDay(itemId: String, day: String)
}

/// The clipboard, copies and deletes.
public enum CalendarEdit: Equatable, Sendable {

    case cut(itemId: String)
    case copy(itemId: String)
    case duplicate(itemId: String)
    case paste(day: String, rawStart: Int, allDay: Bool)
    /// Deletes the item at once, as the system Calendar does.
    case delete(itemId: String)
    case dismissProblem
}

public enum CalendarAction: Equatable, Sendable {

    case navigation(CalendarNavigation)
    case gesture(CalendarGesture)
    case edit(CalendarEdit)
    case open(CalendarOpen)
}

public enum CalendarEffect: Equatable, Sendable {

    case openDetails(itemId: String, kind: CalendarItemKind, day: String)
    case openCalendars
    case openInvitations
    case openNewItem(day: String)
    case openSleep(night: String)
    case openAgenda(day: String)
}

public typealias CalendarScreenModel = ScreenModel<CalendarState, CalendarAction, CalendarEffect>

/// Calendar screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedCalendarScreenModel = ScriptedScreenModel<CalendarState, CalendarAction, CalendarEffect>
