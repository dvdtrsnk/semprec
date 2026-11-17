import Foundation

public enum AreaPhase: Equatable, Sendable {

    case loading
    case content
    case error
}

/// A task or an event coming up in the area; `date` is `yyyy-MM-dd` and the times are `HH:mm`.
public struct AreaUpcomingItem: Equatable, Sendable, Identifiable {

    public let kind: ItemKind
    public let id: String
    public let title: String
    public let date: String?
    public let timeFrom: String?
    public let timeTo: String?
    public let projectTitle: String?
    public let projectColor: String?

    public init(
        kind: ItemKind,
        id: String,
        title: String,
        date: String?,
        timeFrom: String?,
        timeTo: String?,
        projectTitle: String?,
        projectColor: String?
    ) {
        self.kind = kind
        self.id = id
        self.title = title
        self.date = date
        self.timeFrom = timeFrom
        self.timeTo = timeTo
        self.projectTitle = projectTitle
        self.projectColor = projectColor
    }
}

/// A collection connected to the area; `icon` and `color` are the database's own.
public struct AreaRelatedItem: Equatable, Sendable, Identifiable {

    public let databaseId: String
    public let databaseKey: String?
    public let name: String
    public let icon: String?
    public let color: String?
    public let count: Int

    public var id: String { databaseId }

    public init(databaseId: String, databaseKey: String?, name: String, icon: String?, color: String?, count: Int) {
        self.databaseId = databaseId
        self.databaseKey = databaseKey
        self.name = name
        self.icon = icon
        self.color = color
        self.count = count
    }
}

/// One area. `icon` and `color` are the stored values, which the app maps to a symbol and a tile color.
public struct AreaState: Equatable, Sendable {

    public var phase: AreaPhase
    public var failure: FailureKind?
    public var name: String
    public var color: String?
    public var icon: String?
    public var active: Bool
    public var activeSaving: Bool
    public var tasksToday: Int
    public var tasksOpen: Int
    public var eventsSoon: Int
    public var upcoming: [AreaUpcomingItem]
    public var related: [AreaRelatedItem]
    public var writeFailure: Failed?

    public init(
        phase: AreaPhase = .loading,
        failure: FailureKind? = nil,
        name: String = "",
        color: String? = nil,
        icon: String? = nil,
        active: Bool = true,
        activeSaving: Bool = false,
        tasksToday: Int = 0,
        tasksOpen: Int = 0,
        eventsSoon: Int = 0,
        upcoming: [AreaUpcomingItem] = [],
        related: [AreaRelatedItem] = [],
        writeFailure: Failed? = nil
    ) {
        self.phase = phase
        self.failure = failure
        self.name = name
        self.color = color
        self.icon = icon
        self.active = active
        self.activeSaving = activeSaving
        self.tasksToday = tasksToday
        self.tasksOpen = tasksOpen
        self.eventsSoon = eventsSoon
        self.upcoming = upcoming
        self.related = related
        self.writeFailure = writeFailure
    }
}

public enum AreaAction: Equatable, Sendable {

    case retry
    case refresh
    case openTasks(todayOnly: Bool)
    case openUpcoming(id: String)
    case openRelated(databaseId: String)
    case openNotes
    case setActive(Bool)
    case dismissFailure
}

/// Where the area asks the app to go.
public enum AreaEffect: Equatable, Sendable {

    case openTasks(todayOnly: Bool)
    case openDetails(kind: ItemKind, id: String)
    case openCollection(CollectionTarget)
    case openMail
    case openNotes
}

public typealias AreaScreenModel = ScreenModel<AreaState, AreaAction, AreaEffect>

/// Area screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedAreaScreenModel = ScriptedScreenModel<AreaState, AreaAction, AreaEffect>
