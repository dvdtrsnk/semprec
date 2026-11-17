import CoreKit
import Foundation

extension LoginState {

    /// The notice shown under the form, or `nil` when there is nothing to say.
    var message: String? {
        switch self {
        case .editing(let resetRequested):
            resetRequested ? String(localized: "login.resetSent", bundle: .module) : nil
        case .signingIn:
            nil
        case .failed(let failure):
            switch failure {
            case .rejected: String(localized: "login.error.incomplete", bundle: .module)
            case .unauthorized: String(localized: "login.error.unauthorized", bundle: .module)
            case .unavailable: String(localized: "login.error.unavailable", bundle: .module)
            case .invalidData, .notFound, .none: String(localized: "login.error.unexpected", bundle: .module)
            }
        }
    }

    var isFailure: Bool {
        if case .failed = self { return true }
        return false
    }

    var isSigningIn: Bool { self == .signingIn }
}
