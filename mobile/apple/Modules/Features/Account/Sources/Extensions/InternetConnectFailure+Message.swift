import CoreKit
import Foundation

// MARK: - Message
extension InternetConnectFailure {

    /// What the add sheet and the account say when an account could not be connected or signed in.
    var message: String {
        switch self {
        case .invalidInput: String(localized: "internetAccounts.add.error.invalid", bundle: .module)
        case .refused: String(localized: "internetAccounts.add.error.refused", bundle: .module)
        case .unavailable: String(localized: "internetAccounts.add.error.unavailable", bundle: .module)
        case .unexpected: String(localized: "internetAccounts.add.error.unexpected", bundle: .module)
        case .declined: String(localized: "internetAccounts.add.error.declined", bundle: .module)
        case .wrongCredentials: String(localized: "internetAccounts.add.error.wrongCredentials", bundle: .module)
        case .appPasswordRequired: String(localized: "internetAccounts.add.error.appPasswordRequired", bundle: .module)
        case .serverUnreachable: String(localized: "internetAccounts.add.error.serverUnreachable", bundle: .module)
        case .tlsFailed: String(localized: "internetAccounts.add.error.tlsFailed", bundle: .module)
        case .caldavRefused: String(localized: "internetAccounts.add.error.caldavRefused", bundle: .module)
        case .caldavUnreachable: String(localized: "internetAccounts.add.error.caldavUnreachable", bundle: .module)
        case .alreadyConnected: String(localized: "internetAccounts.add.error.alreadyConnected", bundle: .module)
        case .rateLimited: String(localized: "internetAccounts.add.error.rateLimited", bundle: .module)
        case .wrongAccount: String(localized: "internetAccounts.add.error.wrongAccount", bundle: .module)
        case .mailConsentMissing: String(localized: "internetAccounts.add.error.mailConsentMissing", bundle: .module)
        }
    }
}
