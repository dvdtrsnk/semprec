import Foundation

public enum LoginState: Equatable, Sendable {

    case editing(resetRequested: Bool)
    case signingIn
    /// `.rejected` is an incomplete form, `.unauthorized` refused credentials, `.unavailable` an unreachable server.
    case failed(FailureKind?)
}

public enum LoginAction: Equatable, Sendable {

    case signIn(server: String, email: String, password: String)
    case forgotPassword(server: String, email: String)
    /// A field changed: an earlier failure or reset notice no longer applies.
    case edited
}

/// The login screen model raises no effects: a successful sign-in changes the session state.
public typealias LoginScreenModel = ScreenModel<LoginState, LoginAction, Never>

/// Login screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedLoginScreenModel = ScriptedScreenModel<LoginState, LoginAction, Never>
