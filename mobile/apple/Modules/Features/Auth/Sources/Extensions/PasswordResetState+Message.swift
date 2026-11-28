import CoreKit
import Foundation

extension PasswordResetState {

    /// Whether the submit button is enabled, as the shared ViewModel decided.
    var canSubmit: Bool {
        switch self {
        case .editing(let canSubmit), .refused(_, let canSubmit), .failed(_, let canSubmit): canSubmit
        case .sending, .done: false
        }
    }

    var isSending: Bool { self == .sending }

    var isDone: Bool { self == .done }

    /// The failure shown under the fields, or `nil` when there is none.
    var failureMessage: String? {
        switch self {
        case .editing, .sending, .done:
            nil
        case .refused(let refusal, _):
            switch refusal {
            case .linkInvalid: String(localized: "passwordReset.error.linkInvalid", bundle: .module)
            case .linkExpired: String(localized: "passwordReset.error.linkExpired", bundle: .module)
            case .linkUsed: String(localized: "passwordReset.error.linkUsed", bundle: .module)
            case .weakPassword: String(localized: "passwordReset.error.weakPassword", bundle: .module)
            }
        case .failed(let failure, _):
            switch failure {
            case .unavailable: String(localized: "passwordReset.error.unavailable", bundle: .module)
            case .rejected, .unauthorized, .invalidData, .notFound, .none:
                String(localized: "passwordReset.error.unexpected", bundle: .module)
            }
        }
    }
}
