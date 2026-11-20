import Foundation

/// Where the removal of the account is: not asked, reading what it would hide, waiting for the answer, running.
public enum InternetAccountRemovalPhase: Equatable, Sendable {

    case idle
    case loadingImpact
    case confirming
    case removing
}

/// What removing the account hides, so that the confirmation can name it.
public struct InternetAccountRemovalImpact: Equatable, Sendable {

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

/// One internet account. `mailEnabled` and `calendarsEnabled` are its switches, `mail` and `calendars` what each
/// service is doing. `connectionLimitApplies` is true for an account whose mail syncs over IMAP.
public struct InternetAccountDetail: Equatable, Sendable {

    public let id: String
    public let name: String
    public let address: String?
    public let provider: String?
    public let syncMode: String
    public let mailEnabled: Bool
    public let calendarsEnabled: Bool
    public let mail: InternetServiceStatus
    public let calendars: InternetServiceStatus
    public let lastSuccessfulSyncAt: String?
    public let failingSince: String?
    public let connectionLimit: Int
    public let connectionLimitApplies: Bool
    public let autonomousSendProjectCount: Int
    /// The messages downloaded so far while the first mail sync runs.
    public let syncedMessageCount: Int?

    public init(
        id: String,
        name: String,
        address: String?,
        provider: String?,
        syncMode: String,
        mailEnabled: Bool,
        calendarsEnabled: Bool,
        mail: InternetServiceStatus,
        calendars: InternetServiceStatus,
        lastSuccessfulSyncAt: String?,
        failingSince: String?,
        connectionLimit: Int,
        connectionLimitApplies: Bool,
        autonomousSendProjectCount: Int,
        syncedMessageCount: Int? = nil
    ) {
        self.id = id
        self.name = name
        self.address = address
        self.provider = provider
        self.syncMode = syncMode
        self.mailEnabled = mailEnabled
        self.calendarsEnabled = calendarsEnabled
        self.mail = mail
        self.calendars = calendars
        self.lastSuccessfulSyncAt = lastSuccessfulSyncAt
        self.failingSince = failingSince
        self.connectionLimit = connectionLimit
        self.connectionLimitApplies = connectionLimitApplies
        self.autonomousSendProjectCount = autonomousSendProjectCount
        self.syncedMessageCount = syncedMessageCount
    }
}

public enum InternetAccountPhase: Equatable, Sendable {

    case loading
    case content
    case failure(FailureKind?)
}

/// `confirmingOff` is the service whose switching off waits for the person's answer; `syncRequested` is true while
/// the request to sync the calendars now is under way.
public struct InternetAccountState: Equatable, Sendable {

    public var phase: InternetAccountPhase
    public var account: InternetAccountDetail?
    public var confirmingOff: InternetAccountService?
    public var syncRequested: Bool
    public var removal: InternetAccountRemovalPhase
    public var impact: InternetAccountRemovalImpact?
    public var actionFailed: Bool

    public init(
        phase: InternetAccountPhase = .loading,
        account: InternetAccountDetail? = nil,
        confirmingOff: InternetAccountService? = nil,
        syncRequested: Bool = false,
        removal: InternetAccountRemovalPhase = .idle,
        impact: InternetAccountRemovalImpact? = nil,
        actionFailed: Bool = false
    ) {
        self.phase = phase
        self.account = account
        self.confirmingOff = confirmingOff
        self.syncRequested = syncRequested
        self.removal = removal
        self.impact = impact
        self.actionFailed = actionFailed
    }
}

public enum InternetAccountAction: Equatable, Sendable {

    case retry
    /// Switches a service on at once; switching one off first asks, and `confirmServiceOff` writes it.
    case setService(InternetAccountService, enabled: Bool)
    case confirmServiceOff
    case cancelServiceOff
    case rename(String)
    /// Raises or lowers the number of connections the server may open; the result stays between 1 and 15.
    case stepConnectionLimit(delta: Int)
    /// Asks the server to sync the calendars now; only while Calendars is on.
    case syncNow
    case requestRemoval
    case cancelRemoval
    case confirmRemoval
    case dismissFailure
}

public enum InternetAccountEffect: Equatable, Sendable {

    /// The account was removed; the screen goes back.
    case removed
    /// Calendars was switched on; the app asks for the permission to notify about calendar changes.
    case calendarsTurnedOn
}

public typealias InternetAccountScreenModel =
    ScreenModel<InternetAccountState, InternetAccountAction, InternetAccountEffect>

/// Account screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedInternetAccountScreenModel =
    ScriptedScreenModel<InternetAccountState, InternetAccountAction, InternetAccountEffect>
