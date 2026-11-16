import CoreKit
import Foundation

// MARK: - Sheet message
extension FailureKind {

    /// The localized message of the calendar sheets for a failure: `failure` is the expected failure, or `nil` for an
    /// unexpected one.
    static func sheetMessage(for failure: FailureKind?) -> String {
        switch failure {
        case .unavailable: String(localized: "sheets.failure.unavailable", table: "Sheets", bundle: .module)
        case .invalidData: String(localized: "sheets.failure.invalidData", table: "Sheets", bundle: .module)
        case .unauthorized: String(localized: "sheets.failure.unauthorized", table: "Sheets", bundle: .module)
        case .notFound: String(localized: "sheets.failure.notFound", table: "Sheets", bundle: .module)
        case .rejected: String(localized: "sheets.failure.rejected", table: "Sheets", bundle: .module)
        case nil: String(localized: "sheets.failure.unexpected", table: "Sheets", bundle: .module)
        }
    }
}
