import Foundation

/// Where a row of the profile leads; the app decides which screen shows it.
public enum AccountPage: Equatable, Hashable, Sendable, CaseIterable {

    case devices
    case notifications
    case aiUsage
    case trash
    case sempStatus
    case mailAccounts
}

public enum ProfilePhase: Equatable, Sendable {

    case loading
    case content
    case error
}

/// What sending the password-reset link came to.
public enum ProfileResetPhase: Equatable, Sendable {

    case idle
    case sending
    case sent
    case failed
}

/// The figures of the rows of the profile.
public struct ProfileFigures: Equatable, Sendable {

    public let activeSessions: Int
    public let mailAccountCount: Int
    public let mailAccountsNeedingReauth: Int
    public let trashCount: Int
    public let problemCount: Int
    public let aiCostMonthUsd: Double

    public init(
        activeSessions: Int,
        mailAccountCount: Int,
        mailAccountsNeedingReauth: Int,
        trashCount: Int,
        problemCount: Int,
        aiCostMonthUsd: Double
    ) {
        self.activeSessions = activeSessions
        self.mailAccountCount = mailAccountCount
        self.mailAccountsNeedingReauth = mailAccountsNeedingReauth
        self.trashCount = trashCount
        self.problemCount = problemCount
        self.aiCostMonthUsd = aiCostMonthUsd
    }
}

/// The profile of the signed-in person. The identity is known without the server; `figures` arrive with the summary,
/// whose failure is `failure` (nil with `phase == .error` is an unexpected one).
public struct ProfileState: Equatable, Sendable {

    public var phase: ProfilePhase
    public var failure: FailureKind?
    public var email: String?
    /// The display name of the account, nil when it has none.
    public var name: String?
    public var serverUrl: String?
    public var locale: String?
    public var locales: [String]
    public var figures: ProfileFigures?
    public var localeSaving: Bool
    public var resetPhase: ProfileResetPhase
    public var writeFailure: Failed?

    public init(
        phase: ProfilePhase = .loading,
        failure: FailureKind? = nil,
        email: String? = nil,
        name: String? = nil,
        serverUrl: String? = nil,
        locale: String? = nil,
        locales: [String] = [],
        figures: ProfileFigures? = nil,
        localeSaving: Bool = false,
        resetPhase: ProfileResetPhase = .idle,
        writeFailure: Failed? = nil
    ) {
        self.phase = phase
        self.failure = failure
        self.email = email
        self.name = name
        self.serverUrl = serverUrl
        self.locale = locale
        self.locales = locales
        self.figures = figures
        self.localeSaving = localeSaving
        self.resetPhase = resetPhase
        self.writeFailure = writeFailure
    }
}

public enum ProfileAction: Equatable, Sendable {

    case retry
    case open(AccountPage)
    case changeLocale(String)
    case requestPasswordReset
    case signOut
    case dismissFailure
}

/// The profile screen model raises the page of the row the person opened.
public typealias ProfileScreenModel = ScreenModel<ProfileState, ProfileAction, AccountPage>

/// Profile screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedProfileScreenModel = ScriptedScreenModel<ProfileState, ProfileAction, AccountPage>
