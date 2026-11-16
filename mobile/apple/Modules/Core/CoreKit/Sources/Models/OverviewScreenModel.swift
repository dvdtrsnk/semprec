import Foundation

/// An area row of the overview. `icon` and `color` are the stored values (free text and a hex color).
public struct OverviewArea: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let color: String?
    public let icon: String?
    public let activeProjectCount: Int

    public init(id: String, name: String, color: String?, icon: String?, activeProjectCount: Int) {
        self.id = id
        self.name = name
        self.color = color
        self.icon = icon
        self.activeProjectCount = activeProjectCount
    }
}

/// A pinned project row. `status` is the stored key (`inProgress`, `longTerm`, `done`, `archived`).
public struct OverviewProject: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let color: String?
    public let areaName: String?
    public let status: String?

    public init(id: String, name: String, color: String?, areaName: String?, status: String?) {
        self.id = id
        self.name = name
        self.color = color
        self.areaName = areaName
        self.status = status
    }
}

/// A collection row; `ownerModuleId` says which collection it is, `icon` and `color` come from its database.
public struct OverviewCollection: Equatable, Sendable, Identifiable {

    public let databaseId: String
    public let ownerModuleId: String
    public let name: String
    public let icon: String?
    public let color: String?
    public let itemCount: Int

    public var id: String { databaseId }

    public init(
        databaseId: String, ownerModuleId: String, name: String, icon: String?, color: String?, itemCount: Int
    ) {
        self.databaseId = databaseId
        self.ownerModuleId = ownerModuleId
        self.name = name
        self.icon = icon
        self.color = color
        self.itemCount = itemCount
    }
}

/// What the overview shows once it is loaded. `refreshing` is true while a pull to refresh reloads it.
public struct OverviewContent: Equatable, Sendable {

    public var refreshing: Bool
    public var accountEmail: String?
    public var inboxPending: Int
    public var mailUnread: Int
    public var tasksToday: Int
    public var problemCount: Int
    public var journalTodayItemId: String?
    public var areas: [OverviewArea]
    public var projects: [OverviewProject]
    public var collections: [OverviewCollection]

    public init(
        refreshing: Bool = false,
        accountEmail: String? = nil,
        inboxPending: Int = 0,
        mailUnread: Int = 0,
        tasksToday: Int = 0,
        problemCount: Int = 0,
        journalTodayItemId: String? = nil,
        areas: [OverviewArea] = [],
        projects: [OverviewProject] = [],
        collections: [OverviewCollection] = []
    ) {
        self.refreshing = refreshing
        self.accountEmail = accountEmail
        self.inboxPending = inboxPending
        self.mailUnread = mailUnread
        self.tasksToday = tasksToday
        self.problemCount = problemCount
        self.journalTodayItemId = journalTodayItemId
        self.areas = areas
        self.projects = projects
        self.collections = collections
    }
}

public enum OverviewState: Equatable, Sendable {

    case loading
    case content(OverviewContent)
    case failure(FailureKind?)
}

/// Where a row of the overview leads; the app decides which screen shows it.
public enum OverviewTarget: Equatable, Sendable {

    case inbox
    case mail
    case recordings
    case tasks
    case finance
    case profile
    /// The journal of today; `itemId` is today's entry, nil while there is none yet.
    case journal(itemId: String?)
    case area(id: String)
    case project(id: String)
    case collection(ownerModuleId: String, databaseId: String)
}

public enum OverviewAction: Equatable, Sendable {

    /// Loads again after a failure.
    case retry
    /// Reloads in place (pull to refresh).
    case refresh
    case open(OverviewTarget)
}

/// The overview screen model raises the target of the row the person opened.
public typealias OverviewScreenModel = ScreenModel<OverviewState, OverviewAction, OverviewTarget>

/// Overview screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedOverviewScreenModel = ScriptedScreenModel<OverviewState, OverviewAction, OverviewTarget>
