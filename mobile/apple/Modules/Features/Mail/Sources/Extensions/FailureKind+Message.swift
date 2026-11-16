import CoreKit
import Foundation

// MARK: - Message
extension FailureKind {

    /// The localized message for a failed load: `failure` is the expected failure, or `nil` for an unexpected one.
    static func message(for failure: FailureKind?) -> String {
        switch failure {
        case .unavailable: String(localized: "failure.unavailable", bundle: .module)
        case .invalidData: String(localized: "failure.invalidData", bundle: .module)
        case .unauthorized: String(localized: "failure.unauthorized", bundle: .module)
        case .notFound: String(localized: "failure.notFound", bundle: .module)
        case .rejected: String(localized: "failure.rejected", bundle: .module)
        case nil: String(localized: "failure.unexpected", bundle: .module)
        }
    }

    /// The localized message for a message that was not sent: the server refused it, or could not be reached.
    static func sendMessage(for failure: FailureKind?) -> String {
        switch failure {
        case .rejected: String(localized: "mail.send.rejected", bundle: .module)
        case .unavailable: String(localized: "mail.send.unavailable", bundle: .module)
        default: String(localized: "mail.send.failed", bundle: .module)
        }
    }
}
