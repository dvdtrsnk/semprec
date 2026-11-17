import Foundation

public enum SessionState: Equatable, Sendable {

    /// The stored session is being checked.
    case restoring
    case signedOut
    case signedIn(SessionUser)
    /// A stored session exists but the server could not be reached to check it.
    case unreachable
}

/// Who is signed in and where.
public struct SessionUser: Equatable, Sendable {

    public let email: String
    public let role: String
    public let serverUrl: String

    public init(email: String, role: String, serverUrl: String) {
        self.email = email
        self.role = role
        self.serverUrl = serverUrl
    }
}

public enum SessionAction: Equatable, Sendable {

    /// Checks the stored session again after the server could not be reached.
    case retry
    case signOut
}

/// The session screen model raises no effects.
public typealias SessionScreenModel = ScreenModel<SessionState, SessionAction, Never>

/// Session screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedSessionScreenModel = ScriptedScreenModel<SessionState, SessionAction, Never>
