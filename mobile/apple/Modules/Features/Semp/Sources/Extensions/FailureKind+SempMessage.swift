import CoreKit
import Foundation

// MARK: - Failure messages
extension FailureKind {

    /// What a Semp screen says about why it could not read or do something; nil is an unexpected failure.
    static func sempMessage(for kind: FailureKind?) -> String {
        switch kind {
        case .unavailable: String(localized: "semp.failure.unavailable", bundle: .module)
        case .invalidData: String(localized: "semp.failure.invalidData", bundle: .module)
        case .unauthorized: String(localized: "semp.failure.unauthorized", bundle: .module)
        case .notFound: String(localized: "semp.failure.notFound", bundle: .module)
        case .rejected: String(localized: "semp.failure.rejected", bundle: .module)
        case nil: String(localized: "semp.failure.unexpected", bundle: .module)
        }
    }
}
