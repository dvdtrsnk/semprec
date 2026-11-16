import Foundation

public enum TrashPhase: Equatable, Sendable {

    case loading
    case content
    case error
}

/// What the trash lists: the deleted items, or the deleted databases.
public enum TrashTab: Equatable, Sendable {

    case items
    case databases
}

/// A deleted item; `daysLeft` is the number of days until it is deleted for good.
public struct TrashItemRow: Equatable, Sendable, Identifiable {

    public let id: String
    public let title: String
    public let databaseKey: String?
    public let databaseName: String
    public let deletedAt: String
    public let daysLeft: Int

    public init(id: String, title: String, databaseKey: String?, databaseName: String, deletedAt: String, daysLeft: Int) {
        self.id = id
        self.title = title
        self.databaseKey = databaseKey
        self.databaseName = databaseName
        self.deletedAt = deletedAt
        self.daysLeft = daysLeft
    }
}

/// A deleted database with the items it holds; `daysLeft` is nil while it has no deadline.
public struct TrashDatabaseRow: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let itemCount: Int
    public let archivedAt: String
    public let daysLeft: Int?

    public init(id: String, name: String, itemCount: Int, archivedAt: String, daysLeft: Int?) {
        self.id = id
        self.name = name
        self.itemCount = itemCount
        self.archivedAt = archivedAt
        self.daysLeft = daysLeft
    }
}

public struct TrashState: Equatable, Sendable {

    public var phase: TrashPhase
    public var failure: FailureKind?
    public var tab: TrashTab
    public var items: [TrashItemRow]
    public var databases: [TrashDatabaseRow]
    public var totalItems: Int
    public var hasMore: Bool
    public var loadingMore: Bool
    public var selecting: Bool
    public var selected: [String]
    public var working: Bool
    public var writeFailure: Failed?

    public init(
        phase: TrashPhase = .loading,
        failure: FailureKind? = nil,
        tab: TrashTab = .items,
        items: [TrashItemRow] = [],
        databases: [TrashDatabaseRow] = [],
        totalItems: Int = 0,
        hasMore: Bool = false,
        loadingMore: Bool = false,
        selecting: Bool = false,
        selected: [String] = [],
        working: Bool = false,
        writeFailure: Failed? = nil
    ) {
        self.phase = phase
        self.failure = failure
        self.tab = tab
        self.items = items
        self.databases = databases
        self.totalItems = totalItems
        self.hasMore = hasMore
        self.loadingMore = loadingMore
        self.selecting = selecting
        self.selected = selected
        self.working = working
        self.writeFailure = writeFailure
    }
}

public enum TrashAction: Equatable, Sendable {

    case retry
    case selectTab(TrashTab)
    case loadMore
    case toggleSelecting
    case toggle(id: String)
    case selectAll
    case restore(id: String)
    case restoreSelected
    case dismissFailure
}

/// What a restore reports: how many were restored, how many the server refused, and the name of the collection the
/// one restored item came back to.
public enum TrashEffect: Equatable, Sendable {

    case restored(restored: Int, refused: Int, databaseName: String?)
}

public typealias TrashScreenModel = ScreenModel<TrashState, TrashAction, TrashEffect>

/// Trash screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedTrashScreenModel = ScriptedScreenModel<TrashState, TrashAction, TrashEffect>
