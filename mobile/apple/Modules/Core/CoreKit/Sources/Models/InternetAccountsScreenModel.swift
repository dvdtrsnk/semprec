import Foundation

/// What one service of an account is doing. `off` while its switch is off; `pending` when Calendars was switched on
/// and the server has not synced yet; `needsConsent` when an OAuth account lacks the permission for the service.
public enum InternetServiceStatus: Equatable, Sendable {

    case off
    case pending
    case syncing
    case ok
    case error
    case needsReauthorization
    case needsConsent
}

/// A service of an internet account, switched on and off on its own.
public enum InternetAccountService: Equatable, Sendable {

    case mail
    case calendars
}

/// A row of the accounts list; `provider` is the stored key (`gmail`, `outlook`, `icloud`, `imap`).
public struct InternetAccountItem: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let address: String?
    public let provider: String?
    public let mail: InternetServiceStatus
    public let calendars: InternetServiceStatus

    public init(
        id: String,
        name: String,
        address: String?,
        provider: String?,
        mail: InternetServiceStatus,
        calendars: InternetServiceStatus
    ) {
        self.id = id
        self.name = name
        self.address = address
        self.provider = provider
        self.mail = mail
        self.calendars = calendars
    }
}

/// The accounts that are connected with an address and a password; Google and Microsoft sign in in a browser.
public enum InternetPasswordProvider: Equatable, Sendable {

    case icloud
    case other
}

/// Why an account was not connected: the input is incomplete, the server refused it, or it could not be reached.
public enum InternetConnectFailure: Equatable, Sendable {

    case invalidInput
    case refused
    case unavailable
    case unexpected
}

public enum InternetAccountsPhase: Equatable, Sendable {

    case loading
    case content
    case failure(FailureKind?)
}

public struct InternetAccountsState: Equatable, Sendable {

    public var phase: InternetAccountsPhase
    public var refreshing: Bool
    public var accounts: [InternetAccountItem]
    public var connecting: Bool
    public var connectFailure: InternetConnectFailure?

    public init(
        phase: InternetAccountsPhase = .loading,
        refreshing: Bool = false,
        accounts: [InternetAccountItem] = [],
        connecting: Bool = false,
        connectFailure: InternetConnectFailure? = nil
    ) {
        self.phase = phase
        self.refreshing = refreshing
        self.accounts = accounts
        self.connecting = connecting
        self.connectFailure = connectFailure
    }
}

public enum InternetAccountsAction: Equatable, Sendable {

    case retry
    case refresh
    case open(accountId: String)
    /// Connects an account with its address and password. The servers are for `other` only, where the IMAP and SMTP
    /// servers are required and the CalDAV server may be left empty.
    case connect(
        provider: InternetPasswordProvider,
        address: String,
        password: String,
        imapHost: String,
        smtpHost: String,
        caldavUrl: String
    )
    case dismissConnectFailure
}

public enum InternetAccountsEffect: Equatable, Sendable {

    case openAccount(accountId: String)
    /// An account was connected and the list shows it; the form closes.
    case connected
}

public typealias InternetAccountsScreenModel =
    ScreenModel<InternetAccountsState, InternetAccountsAction, InternetAccountsEffect>

/// Accounts list screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedInternetAccountsScreenModel =
    ScriptedScreenModel<InternetAccountsState, InternetAccountsAction, InternetAccountsEffect>
