import Foundation

/// Which threads the history lists: everything, the person's own chats (with the Inbox item threads), or the tasks.
public enum SempChatsFilter: Equatable, CaseIterable, Sendable {

    case all
    case chats
    case ticks
}

/// One thread of the history. A chat the server has not titled yet has no `title`; the preview stands in for it.
public struct SempChatRow: Equatable, Identifiable, Sendable {

    public let id: String
    public let type: SempThreadType
    public let title: String?
    public let previewText: String?
    public let previewSystemKey: String?
    public let lastActivityAt: String
    public let waiting: Bool
    public let projectName: String?
    public let subjectInboxItemId: String?

    public init(
        id: String,
        type: SempThreadType,
        title: String?,
        previewText: String? = nil,
        previewSystemKey: String? = nil,
        lastActivityAt: String,
        waiting: Bool = false,
        projectName: String? = nil,
        subjectInboxItemId: String? = nil
    ) {
        self.id = id
        self.type = type
        self.title = title
        self.previewText = previewText
        self.previewSystemKey = previewSystemKey
        self.lastActivityAt = lastActivityAt
        self.waiting = waiting
        self.projectName = projectName
        self.subjectInboxItemId = subjectInboxItemId
    }
}

public struct SempChatsState: Equatable, Sendable {

    public var phase: SempPhase
    public var query: String
    public var filter: SempChatsFilter
    public var rows: [SempChatRow]
    public var hasMore: Bool
    public var loadingMore: Bool
    public var approvals: [SempApprovalItem]
    public var approvalCount: Int

    public init(
        phase: SempPhase,
        query: String = "",
        filter: SempChatsFilter = .all,
        rows: [SempChatRow] = [],
        hasMore: Bool = false,
        loadingMore: Bool = false,
        approvals: [SempApprovalItem] = [],
        approvalCount: Int = 0
    ) {
        self.phase = phase
        self.query = query
        self.filter = filter
        self.rows = rows
        self.hasMore = hasMore
        self.loadingMore = loadingMore
        self.approvals = approvals
        self.approvalCount = approvalCount
    }
}

public enum SempChatsAction: Equatable, Sendable {

    case retry
    case setQuery(String)
    case setFilter(SempChatsFilter)
    case loadMore
    case decide(approvalId: String, approve: Bool)
    case openThread(threadId: String)
    case openApprovals
    case openNewChat
}

public enum SempChatsEffect: Equatable, Sendable {

    case openThread(SempChatRow)
    case openApprovals
    case openNewChat
}

public typealias SempChatsScreenModel = ScreenModel<SempChatsState, SempChatsAction, SempChatsEffect>

/// History screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedSempChatsScreenModel = ScriptedScreenModel<SempChatsState, SempChatsAction, SempChatsEffect>

// MARK: - Approvals
public enum SempApprovalsTab: Equatable, Sendable {

    case pending
    case decided
}

public struct SempApprovalsState: Equatable, Sendable {

    public var phase: SempPhase
    public var tab: SempApprovalsTab
    public var items: [SempApprovalItem]
    public var pendingCount: Int
    public var hasMore: Bool
    public var loadingMore: Bool
    public var expanded: Set<String>

    public init(
        phase: SempPhase,
        tab: SempApprovalsTab = .pending,
        items: [SempApprovalItem] = [],
        pendingCount: Int = 0,
        hasMore: Bool = false,
        loadingMore: Bool = false,
        expanded: Set<String> = []
    ) {
        self.phase = phase
        self.tab = tab
        self.items = items
        self.pendingCount = pendingCount
        self.hasMore = hasMore
        self.loadingMore = loadingMore
        self.expanded = expanded
    }
}

public enum SempApprovalsAction: Equatable, Sendable {

    case retry
    case setTab(SempApprovalsTab)
    case loadMore
    case decide(approvalId: String, approve: Bool)
    case toggleDetails(approvalId: String)
    case openThread(approvalId: String)
    case openRun(approvalId: String)
}

public enum SempApprovalsEffect: Equatable, Sendable {

    case openThread(threadId: String)
    case openRun(runId: String)
}

public typealias SempApprovalsScreenModel = ScreenModel<SempApprovalsState, SempApprovalsAction, SempApprovalsEffect>

/// Approvals screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedSempApprovalsScreenModel =
    ScriptedScreenModel<SempApprovalsState, SempApprovalsAction, SempApprovalsEffect>
