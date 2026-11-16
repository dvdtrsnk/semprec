import Foundation

/// A folder or label with its unread thread count; `specialPurpose` is the stored key (`inbox`, `sent`, `none`).
public struct MailFolderItem: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let specialPurpose: String
    public let unreadCount: Int

    public init(id: String, name: String, specialPurpose: String, unreadCount: Int) {
        self.id = id
        self.name = name
        self.specialPurpose = specialPurpose
        self.unreadCount = unreadCount
    }
}

/// A mailbox with its folders. `foldersFailed` says its folders could not be read.
public struct MailFolderAccount: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let address: String?
    public let status: MailAccountStatus
    public let folders: [MailFolderItem]
    public let foldersFailed: Bool
    public let collapsed: Bool

    public init(
        id: String,
        name: String,
        address: String?,
        status: MailAccountStatus,
        folders: [MailFolderItem],
        foldersFailed: Bool = false,
        collapsed: Bool = false
    ) {
        self.id = id
        self.name = name
        self.address = address
        self.status = status
        self.folders = folders
        self.foldersFailed = foldersFailed
        self.collapsed = collapsed
    }
}

public enum MailFoldersPhase: Equatable, Sendable {

    case loading
    case content
    case failure(FailureKind?)
}

public struct MailFoldersState: Equatable, Sendable {

    public var phase: MailFoldersPhase
    public var refreshing: Bool
    public var unreadInbox: Int
    public var flagged: Int
    public var sempDrafts: Int
    public var accounts: [MailFolderAccount]

    public init(
        phase: MailFoldersPhase = .loading,
        refreshing: Bool = false,
        unreadInbox: Int = 0,
        flagged: Int = 0,
        sempDrafts: Int = 0,
        accounts: [MailFolderAccount] = []
    ) {
        self.phase = phase
        self.refreshing = refreshing
        self.unreadInbox = unreadInbox
        self.flagged = flagged
        self.sempDrafts = sempDrafts
        self.accounts = accounts
    }
}

public enum MailFoldersAction: Equatable, Sendable {

    case retry
    case refresh
    case toggleAccount(mailboxId: String)
    case openBox(MailListBox)
    case openFolder(mailboxId: String, folderId: String)
    case compose
    case openAccounts
}

public enum MailFoldersEffect: Equatable, Sendable {

    /// The thread list of `start`; `title` is the name of the folder when the list is one.
    case openList(MailListStart, title: String?)
    case compose
    case openAccounts
}

public typealias MailFoldersScreenModel = ScreenModel<MailFoldersState, MailFoldersAction, MailFoldersEffect>

/// Mailboxes screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedMailFoldersScreenModel =
    ScriptedScreenModel<MailFoldersState, MailFoldersAction, MailFoldersEffect>
