import Foundation

/// The three lists of the Tasks screen.
public enum TasksTab: Equatable, Hashable, Sendable, CaseIterable {

    case today
    case planned
    case all
}

/// The groups of a task list, by the day the task is on.
public enum TaskSectionKind: Equatable, Hashable, Sendable {

    case late
    case today
    case tomorrow
    case week
    case later
    case noDate
}

/// Where the Tasks screen starts: a tab and, for the lists an area or a project links to, a filter.
public struct TasksStart: Equatable, Hashable, Sendable {

    public let tab: TasksTab
    public let hideDone: Bool
    public let areaId: String?
    public let projectId: String?

    public init(tab: TasksTab = .today, hideDone: Bool = false, areaId: String? = nil, projectId: String? = nil) {
        self.tab = tab
        self.hideDone = hideDone
        self.areaId = areaId
        self.projectId = projectId
    }
}

/// One task of a list. `date` is the day it is on and `movedFrom` the day it was planned for when that is earlier;
/// both are `yyyy-MM-dd`, times are `HH:mm`.
public struct TaskRow: Equatable, Sendable, Identifiable {

    public let id: String
    public let title: String
    public let done: Bool
    public let flagged: Bool
    public let date: String?
    public let timeFrom: String?
    public let timeTo: String?
    public let movedFrom: String?
    public let projectTitle: String?
    public let repeats: TaskRepeat
    public let overdue: Bool
    public let missed: Bool

    public init(
        id: String,
        title: String,
        done: Bool = false,
        flagged: Bool = false,
        date: String? = nil,
        timeFrom: String? = nil,
        timeTo: String? = nil,
        movedFrom: String? = nil,
        projectTitle: String? = nil,
        repeats: TaskRepeat = .never,
        overdue: Bool = false,
        missed: Bool = false
    ) {
        self.id = id
        self.title = title
        self.done = done
        self.flagged = flagged
        self.date = date
        self.timeFrom = timeFrom
        self.timeTo = timeTo
        self.movedFrom = movedFrom
        self.projectTitle = projectTitle
        self.repeats = repeats
        self.overdue = overdue
        self.missed = missed
    }
}

public struct TaskGroup: Equatable, Sendable, Identifiable {

    public let kind: TaskSectionKind
    public let rows: [TaskRow]
    public var id: TaskSectionKind { kind }

    public init(kind: TaskSectionKind, rows: [TaskRow]) {
        self.kind = kind
        self.rows = rows
    }
}

/// One choice of the filter sheet and the number of tasks it leaves.
public struct FilterOption: Equatable, Sendable, Identifiable {

    public let id: String
    public let title: String
    public let color: String?
    public let count: Int
    public let areaId: String?

    public init(id: String, title: String, color: String? = nil, count: Int, areaId: String? = nil) {
        self.id = id
        self.title = title
        self.color = color
        self.count = count
        self.areaId = areaId
    }
}

public enum TasksPhase: Equatable, Sendable {

    case loading
    case content
    /// `nil` for an unexpected failure, which has no typed reason.
    case failure(FailureKind?)
}

/// The Tasks screen: the filter and the tab the person chose, and what they leave of the tasks.
public struct TasksState: Equatable, Sendable {

    public var phase: TasksPhase
    public var tab: TasksTab
    public var hideDone: Bool
    public var areaId: String?
    public var projectId: String?
    public var flaggedOnly: Bool
    public var groups: [TaskGroup]
    public var openCount: Int
    public var areaOptions: [FilterOption]
    public var projectOptions: [FilterOption]
    public var areaAllCount: Int
    public var projectAllCount: Int
    public var matchesNothing: Bool
    /// A write that failed; the list shows what the server holds again.
    public var notice: FailureKind?

    public var filterActive: Bool { areaId != nil || projectId != nil || flaggedOnly }

    public init(
        phase: TasksPhase = .loading,
        tab: TasksTab = .today,
        hideDone: Bool = false,
        areaId: String? = nil,
        projectId: String? = nil,
        flaggedOnly: Bool = false,
        groups: [TaskGroup] = [],
        openCount: Int = 0,
        areaOptions: [FilterOption] = [],
        projectOptions: [FilterOption] = [],
        areaAllCount: Int = 0,
        projectAllCount: Int = 0,
        matchesNothing: Bool = false,
        notice: FailureKind? = nil
    ) {
        self.phase = phase
        self.tab = tab
        self.hideDone = hideDone
        self.areaId = areaId
        self.projectId = projectId
        self.flaggedOnly = flaggedOnly
        self.groups = groups
        self.openCount = openCount
        self.areaOptions = areaOptions
        self.projectOptions = projectOptions
        self.areaAllCount = areaAllCount
        self.projectAllCount = projectAllCount
        self.matchesNothing = matchesNothing
        self.notice = notice
    }
}

public enum TasksAction: Equatable, Sendable {

    case selectTab(TasksTab)
    case toggleHideDone
    case setArea(String?)
    case setProject(String?)
    case setFlaggedOnly(Bool)
    case clearFilters
    case retry
    case refresh
    case toggleDone(taskId: String)
    case rename(taskId: String, title: String)
    /// A new task for today in the chosen project; a blank title adds nothing.
    case add(title: String)
    case openDetails(taskId: String)
    case dismissNotice
}

public enum TasksEffect: Equatable, Sendable {

    case openDetails(taskId: String)
}

public typealias TasksScreenModel = ScreenModel<TasksState, TasksAction, TasksEffect>

/// Tasks screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedTasksScreenModel = ScriptedScreenModel<TasksState, TasksAction, TasksEffect>
