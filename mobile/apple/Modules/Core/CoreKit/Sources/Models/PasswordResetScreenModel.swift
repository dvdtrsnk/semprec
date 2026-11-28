import Foundation

/// A refusal the server named for a password-reset link: three for the link itself, one for the new password.
public enum PasswordResetRefusal: Equatable, Sendable {

    case linkInvalid
    case linkExpired
    case linkUsed
    case weakPassword
}

/// The "Set a new password" form of a reset link. `canSubmit` is whether the form can be sent: both entries are equal
/// and not empty, and the link was not refused.
public enum PasswordResetState: Equatable, Sendable {

    case editing(canSubmit: Bool)
    case sending
    /// The password is set; the person signs in with it.
    case done
    case refused(PasswordResetRefusal, canSubmit: Bool)
    /// Any other failure; `nil` is an unexpected one.
    case failed(FailureKind?, canSubmit: Bool)
}

public enum PasswordResetAction: Equatable, Sendable {

    /// A field changed: the shared ViewModel decides again whether the form can be sent.
    case edited(newPassword: String, repeated: String)
    case submit(newPassword: String, repeated: String)
}

/// The password-reset screen model raises no effects: the sheet closes itself.
public typealias PasswordResetScreenModel = ScreenModel<PasswordResetState, PasswordResetAction, Never>

/// Password-reset screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedPasswordResetScreenModel = ScriptedScreenModel<PasswordResetState, PasswordResetAction, Never>
