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

/// A row of the accounts list; `provider` is the stored key (`gmail`, `outlook`, `icloud`, `generic`).
/// `canSignInAgain` is true when a service no longer accepts the account's sign-in and the app can sign it in again:
/// in a browser for Google and Microsoft, with a password for iCloud and other accounts.
public struct InternetAccountItem: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let address: String?
    public let provider: String?
    public let mail: InternetServiceStatus
    public let calendars: InternetServiceStatus
    public let canSignInAgain: Bool

    public init(
        id: String,
        name: String,
        address: String?,
        provider: String?,
        mail: InternetServiceStatus,
        calendars: InternetServiceStatus,
        canSignInAgain: Bool = false
    ) {
        self.id = id
        self.name = name
        self.address = address
        self.provider = provider
        self.mail = mail
        self.calendars = calendars
        self.canSignInAgain = canSignInAgain
    }
}

/// The accounts that are connected with an address and a password; Google and Microsoft sign in in a browser.
public enum InternetPasswordProvider: Equatable, Sendable {

    case icloud
    case other
}

/// The accounts that sign in in a browser.
public enum InternetOAuthProvider: Equatable, Sendable {

    case google
    case microsoft
}

/// Why an account was not connected or signed in: the input is incomplete, the server refused it for a reason it did
/// not name, it could not be reached, or, for a browser sign-in, the provider declined it (for example because the
/// person did not allow access). A password login the server checked names its reason.
public enum InternetConnectFailure: Equatable, Sendable {

    case invalidInput
    case refused
    case unavailable
    case unexpected
    case declined
    /// The user name or the password is wrong.
    case wrongCredentials
    /// An iCloud account needs an app-specific password.
    case appPasswordRequired
    /// The mail server could not be reached.
    case serverUnreachable
    /// The secure connection to the mail server failed.
    case tlsFailed
    /// The CalDAV server refused the login.
    case caldavRefused
    /// The CalDAV server could not be reached or is not one.
    case caldavUnreachable
    /// Another account already holds the address.
    case alreadyConnected
    /// Too many attempts; try again later.
    case rateLimited
    /// Signing in again came back with another account than the mailbox's.
    case wrongAccount
}

/// Signing a password account in again: `accountId` with its `address`, `icloud` for an iCloud account (which needs
/// an app-specific password). `submitting` is true while the server checks the login, and `failure` says why the last
/// attempt did not succeed.
public struct InternetPasswordSignIn: Equatable, Sendable {

    public let accountId: String
    public let address: String?
    public let icloud: Bool
    public let submitting: Bool
    public let failure: InternetConnectFailure?

    public init(
        accountId: String,
        address: String?,
        icloud: Bool,
        submitting: Bool = false,
        failure: InternetConnectFailure? = nil
    ) {
        self.accountId = accountId
        self.address = address
        self.icloud = icloud
        self.submitting = submitting
        self.failure = failure
    }
}

/// A step of a password sign-in.
public enum InternetPasswordSignInStep: Equatable, Sendable {

    /// Sends `password` and `username`; a blank `username` keeps the user name the server has.
    case submit(password: String, username: String)
    /// Closes the sign-in; ignored while the server checks the login.
    case cancel
}

/// The older mail history the device indexes for the account `accountId` it connected, while the password typed is in
/// memory: `foldersTotal` folders the server leased to the device so far, `foldersDone` of them finished, and
/// `messagesUploaded` messages the server took. `foldersTotal` is 0 while the server has not leased a folder yet.
public struct InternetHistoryIndexing: Equatable, Sendable {

    public let accountId: String
    public let foldersDone: Int
    public let foldersTotal: Int
    public let messagesUploaded: Int

    public init(accountId: String, foldersDone: Int, foldersTotal: Int, messagesUploaded: Int) {
        self.accountId = accountId
        self.foldersDone = foldersDone
        self.foldersTotal = foldersTotal
        self.messagesUploaded = messagesUploaded
    }
}

public enum InternetAccountsPhase: Equatable, Sendable {

    case loading
    case content
    case failure(FailureKind?)
}

/// `connecting` is true while an account is being connected, a browser sign-in included, from its start until the
/// browser came back and the server answered. `existingAccountId` is the listed account that already holds the
/// address of a connect refused as `alreadyConnected`. `signingIn` is true while a listed account signs in again in a
/// browser, and `signInFailure` says why the last one did not succeed; `passwordSignIn` is the password sign-in of a
/// listed account, while it is open. `historyIndexing` is the history indexing of an account connected with a
/// password, while it runs.
public struct InternetAccountsState: Equatable, Sendable {

    public var phase: InternetAccountsPhase
    public var refreshing: Bool
    public var accounts: [InternetAccountItem]
    public var connecting: Bool
    public var connectFailure: InternetConnectFailure?
    public var existingAccountId: String?
    public var signingIn: Bool
    public var signInFailure: InternetConnectFailure?
    public var passwordSignIn: InternetPasswordSignIn?
    public var historyIndexing: InternetHistoryIndexing?

    public init(
        phase: InternetAccountsPhase = .loading,
        refreshing: Bool = false,
        accounts: [InternetAccountItem] = [],
        connecting: Bool = false,
        connectFailure: InternetConnectFailure? = nil,
        existingAccountId: String? = nil,
        signingIn: Bool = false,
        signInFailure: InternetConnectFailure? = nil,
        passwordSignIn: InternetPasswordSignIn? = nil,
        historyIndexing: InternetHistoryIndexing? = nil
    ) {
        self.phase = phase
        self.refreshing = refreshing
        self.accounts = accounts
        self.connecting = connecting
        self.connectFailure = connectFailure
        self.existingAccountId = existingAccountId
        self.signingIn = signingIn
        self.signInFailure = signInFailure
        self.passwordSignIn = passwordSignIn
        self.historyIndexing = historyIndexing
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
    /// Dismisses `connectFailure` and `existingAccountId`.
    case dismissConnectFailure
    /// Opens `existingAccountId`.
    case openExisting
    /// Signs a listed account in again while `canSignInAgain`: a Google or Microsoft account in a browser (reported
    /// back like a new sign-in), another account with a password (`passwordSignIn`, continued with `passwordSignIn`).
    case signInAgain(accountId: String)
    case passwordSignIn(InternetPasswordSignInStep)
    /// Dismisses `signInFailure`.
    case dismissSignInFailure
    /// Starts the browser sign-in of a new account that syncs mail and, when `calendars`, its calendars.
    case startSignIn(provider: InternetOAuthProvider, calendars: Bool)
    /// The browser came back to `semprec://oauth` at `callbackUrl`.
    case signInReturned(callbackUrl: String)
    /// The person closed the browser before it came back.
    case signInCancelled
    /// The browser could not be shown or ended in an error of its own.
    case signInFailed
}

public enum InternetAccountsEffect: Equatable, Sendable {

    case openAccount(accountId: String)
    /// A new account was connected and the list shows it; the form closes.
    case connected
    /// Opens `url`, the provider's sign-in page, in a browser session that ends at `semprec://oauth`; the app reports
    /// how it ended with `signInReturned`, `signInCancelled` or `signInFailed`.
    case openSignIn(url: String)
}

public typealias InternetAccountsScreenModel =
    ScreenModel<InternetAccountsState, InternetAccountsAction, InternetAccountsEffect>

/// Accounts list screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedInternetAccountsScreenModel =
    ScriptedScreenModel<InternetAccountsState, InternetAccountsAction, InternetAccountsEffect>
