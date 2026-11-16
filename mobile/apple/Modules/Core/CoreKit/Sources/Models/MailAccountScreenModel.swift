import Foundation

/// Where the removal of the account is: not asked, reading what it would hide, waiting for the answer, running.
public enum MailRemovalPhase: Equatable, Sendable {

    case idle
    case loadingImpact
    case confirming
    case removing
}

/// What removing the account hides, so that the confirmation can name it.
public struct MailRemovalImpactItem: Equatable, Sendable {

    public let messages: Int
    public let drafts: Int
    public let threads: Int
    public let attachmentsKept: Int

    public init(messages: Int, drafts: Int, threads: Int, attachmentsKept: Int) {
        self.messages = messages
        self.drafts = drafts
        self.threads = threads
        self.attachmentsKept = attachmentsKept
    }
}

/// One mailbox. `connectionLimitApplies` is true for a mailbox that syncs over IMAP, where the limit matters.
public struct MailAccountDetail: Equatable, Sendable {

    public let id: String
    public let name: String
    public let address: String?
    public let provider: String?
    public let syncMode: String
    public let status: MailAccountStatus
    public let lastSuccessfulSyncAt: String?
    public let failingSince: String?
    public let connectionLimit: Int
    public let connectionLimitApplies: Bool
    public let autonomousSendProjectCount: Int

    public init(
        id: String,
        name: String,
        address: String?,
        provider: String?,
        syncMode: String,
        status: MailAccountStatus,
        lastSuccessfulSyncAt: String?,
        failingSince: String?,
        connectionLimit: Int,
        connectionLimitApplies: Bool,
        autonomousSendProjectCount: Int
    ) {
        self.id = id
        self.name = name
        self.address = address
        self.provider = provider
        self.syncMode = syncMode
        self.status = status
        self.lastSuccessfulSyncAt = lastSuccessfulSyncAt
        self.failingSince = failingSince
        self.connectionLimit = connectionLimit
        self.connectionLimitApplies = connectionLimitApplies
        self.autonomousSendProjectCount = autonomousSendProjectCount
    }
}

public enum MailAccountPhase: Equatable, Sendable {

    case loading
    case content
    case failure(FailureKind?)
}

public struct MailAccountState: Equatable, Sendable {

    public var phase: MailAccountPhase
    public var account: MailAccountDetail?
    public var removal: MailRemovalPhase
    public var impact: MailRemovalImpactItem?
    public var actionFailed: Bool

    public init(
        phase: MailAccountPhase = .loading,
        account: MailAccountDetail? = nil,
        removal: MailRemovalPhase = .idle,
        impact: MailRemovalImpactItem? = nil,
        actionFailed: Bool = false
    ) {
        self.phase = phase
        self.account = account
        self.removal = removal
        self.impact = impact
        self.actionFailed = actionFailed
    }
}

public enum MailAccountAction: Equatable, Sendable {

    case retry
    case rename(String)
    /// Raises or lowers the number of connections the server may open; the result stays between 1 and 15.
    case stepConnectionLimit(delta: Int)
    case requestRemoval
    case cancelRemoval
    case confirmRemoval
    case dismissFailure
}

public enum MailAccountEffect: Equatable, Sendable {

    /// The mailbox was removed; the screen goes back.
    case removed
}

public typealias MailAccountScreenModel = ScreenModel<MailAccountState, MailAccountAction, MailAccountEffect>

/// Account screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedMailAccountScreenModel =
    ScriptedScreenModel<MailAccountState, MailAccountAction, MailAccountEffect>
