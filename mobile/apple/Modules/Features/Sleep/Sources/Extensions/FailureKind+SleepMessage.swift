import CoreKit
import Foundation

// MARK: - Message
extension FailureKind {

    /// The localized message for a failed load or write: `failure` is the expected failure, nil an unexpected one.
    static func sleepMessage(for failure: FailureKind?) -> String {
        switch failure {
        case .unavailable: String(localized: "sleep.failure.unavailable", bundle: .module)
        case .invalidData: String(localized: "sleep.failure.invalidData", bundle: .module)
        case .unauthorized: String(localized: "sleep.failure.unauthorized", bundle: .module)
        case .notFound: String(localized: "sleep.failure.notFound", bundle: .module)
        case .rejected: String(localized: "sleep.failure.rejected", bundle: .module)
        case nil: String(localized: "sleep.failure.unexpected", bundle: .module)
        }
    }
}
