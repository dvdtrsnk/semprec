import Foundation

/// One row of the thread list. The screen formats `lastMessageAt` and derives the avatar from the sender.
public struct MailThreadItem: Equatable, Sendable, Identifiable {

    public let threadId: String
    public let subject: String
    public let lastMessageAt: String
    public let senderName: String
    public let senderAddress: String
    public let senderRelationship: String?
    public let messageCount: Int
    public let preview: String?
    public let hasAttachment: Bool
    public let unread: Bool
    public let flagged: Bool
    public let mailboxNames: [String]
    public let projectName: String?
    public let companyName: String?
    public let hasSempDraft: Bool

    public var id: String { threadId }

    public init(
        threadId: String,
        subject: String,
        lastMessageAt: String,
        senderName: String,
        senderAddress: String,
        senderRelationship: String? = nil,
        messageCount: Int = 1,
        preview: String? = nil,
        hasAttachment: Bool = false,
        unread: Bool = false,
        flagged: Bool = false,
        mailboxNames: [String] = [],
        projectName: String? = nil,
        companyName: String? = nil,
        hasSempDraft: Bool = false
    ) {
        self.threadId = threadId
        self.subject = subject
        self.lastMessageAt = lastMessageAt
        self.senderName = senderName
        self.senderAddress = senderAddress
        self.senderRelationship = senderRelationship
        self.messageCount = messageCount
        self.preview = preview
        self.hasAttachment = hasAttachment
        self.unread = unread
        self.flagged = flagged
        self.mailboxNames = mailboxNames
        self.projectName = projectName
        self.companyName = companyName
        self.hasSempDraft = hasSempDraft
    }
}

public struct MailMailboxChip: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// A mailbox that cannot sync until the person signs in again; `since` is when its sync first failed.
public struct MailAccountNotice: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let since: String?

    public init(id: String, name: String, since: String?) {
        self.id = id
        self.name = name
        self.since = since
    }
}

/// An area or a project of the filter sheet with the number of threads it holds.
public struct MailFilterOption: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let color: String?
    public let count: Int
    public let areaId: String?

    public init(id: String, name: String, color: String?, count: Int, areaId: String? = nil) {
        self.id = id
        self.name = name
        self.color = color
        self.count = count
        self.areaId = areaId
    }
}

public enum MailFacetsPhase: Equatable, Sendable {

    case idle
    case loading
    case ready
    case error
}

public struct MailFacetsState: Equatable, Sendable {

    public var phase: MailFacetsPhase
    public var areaTotal: Int
    public var projectTotal: Int
    public var areas: [MailFilterOption]
    public var projects: [MailFilterOption]

    public init(
        phase: MailFacetsPhase = .idle,
        areaTotal: Int = 0,
        projectTotal: Int = 0,
        areas: [MailFilterOption] = [],
        projects: [MailFilterOption] = []
    ) {
        self.phase = phase
        self.areaTotal = areaTotal
        self.projectTotal = projectTotal
        self.areas = areas
        self.projects = projects
    }
}

/// The quick filter chips; a mailbox chip is chosen with `selectMailbox` instead.
public enum MailListFilter: Equatable, Sendable, CaseIterable {

    case all
    case unread
    case flagged
}

public enum MailThreadsPhase: Equatable, Sendable {

    case loading
    case content
    case failure(FailureKind?)
}

/// The thread list. `actionFailed` says a refresh, a page or a read mark did not go through; the list stays.
public struct MailThreadsState: Equatable, Sendable {

    public var phase: MailThreadsPhase
    public var refreshing: Bool
    public var loadingMore: Bool
    public var hasMore: Bool
    public var threads: [MailThreadItem]
    public var search: String
    public var box: MailListBox
    public var filter: MailListFilter
    public var mailboxId: String?
    public var folderId: String?
    public var areaId: String?
    public var projectId: String?
    public var areaName: String?
    public var projectName: String?
    public var mailboxes: [MailMailboxChip]
    public var reauthorization: [MailAccountNotice]
    public var facets: MailFacetsState
    public var actionFailed: Bool

    public init(
        phase: MailThreadsPhase = .loading,
        refreshing: Bool = false,
        loadingMore: Bool = false,
        hasMore: Bool = false,
        threads: [MailThreadItem] = [],
        search: String = "",
        box: MailListBox = .inbox,
        filter: MailListFilter = .all,
        mailboxId: String? = nil,
        folderId: String? = nil,
        areaId: String? = nil,
        projectId: String? = nil,
        areaName: String? = nil,
        projectName: String? = nil,
        mailboxes: [MailMailboxChip] = [],
        reauthorization: [MailAccountNotice] = [],
        facets: MailFacetsState = MailFacetsState(),
        actionFailed: Bool = false
    ) {
        self.phase = phase
        self.refreshing = refreshing
        self.loadingMore = loadingMore
        self.hasMore = hasMore
        self.threads = threads
        self.search = search
        self.box = box
        self.filter = filter
        self.mailboxId = mailboxId
        self.folderId = folderId
        self.areaId = areaId
        self.projectId = projectId
        self.areaName = areaName
        self.projectName = projectName
        self.mailboxes = mailboxes
        self.reauthorization = reauthorization
        self.facets = facets
        self.actionFailed = actionFailed
    }
}

/// Where a row or a button of the list leads; the app decides which screen shows it.
public enum MailThreadsEffect: Equatable, Sendable {

    case openThread(threadId: String)
    case openFolders
    case compose
    case openAccount(mailboxId: String)
}

public enum MailThreadsAction: Equatable, Sendable {

    case retry
    case refresh
    case loadMore
    case search(String)
    case selectFilter(MailListFilter)
    /// Chooses a mailbox, or clears it when it is the chosen one.
    case selectMailbox(String)
    /// `nil` is every area.
    case setArea(String?)
    /// `nil` is every project.
    case setProject(String?)
    case clearContext
    case toggleRead(threadId: String)
    case dismissFailure
    case open(MailThreadsEffect)
}

public typealias MailThreadsScreenModel = ScreenModel<MailThreadsState, MailThreadsAction, MailThreadsEffect>

/// Thread list screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedMailThreadsScreenModel =
    ScriptedScreenModel<MailThreadsState, MailThreadsAction, MailThreadsEffect>
