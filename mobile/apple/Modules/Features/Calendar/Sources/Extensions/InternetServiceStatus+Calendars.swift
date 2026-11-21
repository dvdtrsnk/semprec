import CoreKit
import Foundation

// MARK: - Copy
extension InternetServiceStatus {

    /// How the calendar sync of an account is doing, under the account's name in the calendars sheet.
    var calendarsText: String {
        switch self {
        case .off: String(localized: "calendars.account.status.off", table: "Sheets", bundle: .module)
        case .pending: String(localized: "calendars.account.status.pending", table: "Sheets", bundle: .module)
        case .syncing: String(localized: "calendars.account.status.syncing", table: "Sheets", bundle: .module)
        case .ok: String(localized: "calendars.account.status.ok", table: "Sheets", bundle: .module)
        case .error: String(localized: "calendars.account.status.error", table: "Sheets", bundle: .module)
        case .needsReauthorization:
            String(localized: "calendars.account.status.reauth", table: "Sheets", bundle: .module)
        case .needsConsent: String(localized: "calendars.account.status.consent", table: "Sheets", bundle: .module)
        }
    }

    /// Whether the person has to do something in the account's settings before its calendars sync again.
    var needsAttention: Bool {
        switch self {
        case .error, .needsReauthorization, .needsConsent: true
        case .off, .pending, .syncing, .ok: false
        }
    }
}
