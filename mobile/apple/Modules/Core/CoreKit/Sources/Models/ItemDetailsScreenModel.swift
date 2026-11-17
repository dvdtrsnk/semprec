import Foundation

public enum ItemDetailsPhase: Equatable, Sendable {

    case loading
    case content
    /// `nil` for an unexpected failure, which has no typed reason.
    case failure(FailureKind?)
}

/// Whether the projects and people a person can pick are loaded; they load when the first picker opens.
public enum ChoicesPhase: Equatable, Sendable {

    case idle
    case loading
    case ready
    case failed
}

/// The Podrobnosti sheet of a task or an event. Times are `HH:mm` and days `yyyy-MM-dd`. A missing `timeFrom` is an
/// item that lasts all day (`allDay` is only for events). Fields the other kind does not have stay at their empty
/// value.
public struct ItemDetailsState: Equatable, Sendable {

    public var phase: ItemDetailsPhase
    public var kind: ItemKind
    public var title: String
    public var done: Bool
    public var description: String
    public var place: String
    public var flagged: Bool
    public var date: String?
    public var endDate: String?
    public var timeFrom: String?
    public var timeTo: String?
    public var allDay: Bool
    public var lengthMinutes: Int?
    public var repeats: TaskRepeat
    public var project: ProjectRef?
    public var people: [EntityRef]
    public var files: [EntityRef]
    public var hostEvents: [EntityRef]
    public var company: EntityRef?
    public var projectLink: ValueLink?
    public var peopleLink: ValueLink?
    public var choices: ChoicesPhase
    public var projectChoices: [ProjectRef]
    public var personChoices: [EntityRef]
    /// A write that failed; the sheet shows what the server holds again.
    public var notice: FailureKind?

    public init(
        phase: ItemDetailsPhase = .loading,
        kind: ItemKind = .task,
        title: String = "",
        done: Bool = false,
        description: String = "",
        place: String = "",
        flagged: Bool = false,
        date: String? = nil,
        endDate: String? = nil,
        timeFrom: String? = nil,
        timeTo: String? = nil,
        allDay: Bool = false,
        lengthMinutes: Int? = nil,
        repeats: TaskRepeat = .never,
        project: ProjectRef? = nil,
        people: [EntityRef] = [],
        files: [EntityRef] = [],
        hostEvents: [EntityRef] = [],
        company: EntityRef? = nil,
        projectLink: ValueLink? = nil,
        peopleLink: ValueLink? = nil,
        choices: ChoicesPhase = .idle,
        projectChoices: [ProjectRef] = [],
        personChoices: [EntityRef] = [],
        notice: FailureKind? = nil
    ) {
        self.phase = phase
        self.kind = kind
        self.title = title
        self.done = done
        self.description = description
        self.place = place
        self.flagged = flagged
        self.date = date
        self.endDate = endDate
        self.timeFrom = timeFrom
        self.timeTo = timeTo
        self.allDay = allDay
        self.lengthMinutes = lengthMinutes
        self.repeats = repeats
        self.project = project
        self.people = people
        self.files = files
        self.hostEvents = hostEvents
        self.company = company
        self.projectLink = projectLink
        self.peopleLink = peopleLink
        self.choices = choices
        self.projectChoices = projectChoices
        self.personChoices = personChoices
        self.notice = notice
    }
}

public enum ItemDetailsAction: Equatable, Sendable {

    case retry
    case dismissNotice
    /// Loads the projects and people a person can pick, once.
    case loadChoices
    case setTitle(String)
    case toggleDone
    case setDescription(String)
    case setPlace(String)
    case setFlagged(Bool)
    /// A new day; `nil` removes the day (and so the times) of a task. An event always has a day.
    case setDate(String?)
    /// The start switch of a task: on starts at 9:00, off removes start and end.
    case setTimed(Bool)
    /// The end switch of a task: on ends half an hour after the start, off removes the end.
    case setEnded(Bool)
    case setTimeFrom(String)
    case setTimeTo(String)
    /// The all-day switch of an event.
    case setAllDay(Bool)
    case setRepeat(TaskRepeat)
    /// `nil` is no project.
    case selectProject(String?)
    case togglePerson(String)
    case removeFile(String)
    /// Stops the project or the people following their source.
    case unlink(LinkedValue)
    /// Makes the project or the people follow their source again.
    case relink(LinkedValue)
    /// Moves the item to the trash.
    case delete
}

public enum ItemDetailsEffect: Equatable, Sendable {

    /// The item is in the trash: the sheet closes.
    case deleted
}

public typealias ItemDetailsScreenModel = ScreenModel<ItemDetailsState, ItemDetailsAction, ItemDetailsEffect>

/// Podrobnosti screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedItemDetailsScreenModel =
    ScriptedScreenModel<ItemDetailsState, ItemDetailsAction, ItemDetailsEffect>
