import CoreKit
import Foundation

// MARK: - Message
extension FailureKind {

    /// The localized message for a failed load: `failure` is the expected failure, or `nil` for an unexpected one.
    static func message(for failure: FailureKind?) -> String {
        switch failure {
        case .unavailable: String(localized: "failure.unavailable", bundle: .module)
        case .invalidData: String(localized: "failure.invalidData", bundle: .module)
        case nil: String(localized: "failure.unexpected", bundle: .module)
        }
    }
}
