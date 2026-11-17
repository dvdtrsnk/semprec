import Foundation

/// A row of the accounts list; `provider` is the stored key (`gmail`, `outlook`, `icloud`, `imap`).
public struct MailAccountItem: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let address: String?
    public let provider: String?
    public let status: MailAccountStatus

    public init(id: String, name: String, address: String?, provider: String?, status: MailAccountStatus) {
        self.id = id
        self.name = name
        self.address = address
        self.provider = provider
        self.status = status
    }
}

/// The mailboxes that are connected with an address and a password; Gmail and Outlook sign in in a browser.
public enum MailConnectKind: Equatable, Sendable {

    case icloud
    case generic
}

/// Why a mailbox was not connected: the input is incomplete, the server refused it, or it could not be reached.
public enum MailConnectFailure: Equatable, Sendable {

    case invalidInput
    case refused
    case unavailable
    case unexpected
}

public enum MailAccountsPhase: Equatable, Sendable {

    case loading
    case content
    case failure(FailureKind?)
}

public struct MailAccountsState: Equatable, Sendable {

    public var phase: MailAccountsPhase
    public var refreshing: Bool
    public var accounts: [MailAccountItem]
    public var connecting: Bool
    public var connectFailure: MailConnectFailure?

    public init(
        phase: MailAccountsPhase = .loading,
        refreshing: Bool = false,
        accounts: [MailAccountItem] = [],
        connecting: Bool = false,
        connectFailure: MailConnectFailure? = nil
    ) {
        self.phase = phase
        self.refreshing = refreshing
        self.accounts = accounts
        self.connecting = connecting
        self.connectFailure = connectFailure
    }
}

public enum MailAccountsAction: Equatable, Sendable {

    case retry
    case refresh
    case open(mailboxId: String)
    /// Connects a mailbox with its address and password; the servers are for `generic` only.
    case connect(kind: MailConnectKind, address: String, password: String, imapHost: String, smtpHost: String)
    case dismissConnectFailure
}

public enum MailAccountsEffect: Equatable, Sendable {

    case openAccount(mailboxId: String)
    /// A mailbox was connected and the list shows it; the form closes.
    case connected
}

public typealias MailAccountsScreenModel = ScreenModel<MailAccountsState, MailAccountsAction, MailAccountsEffect>

/// Accounts list screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedMailAccountsScreenModel =
    ScriptedScreenModel<MailAccountsState, MailAccountsAction, MailAccountsEffect>
