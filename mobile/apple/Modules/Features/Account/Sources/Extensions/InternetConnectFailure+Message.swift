import CoreKit
import SwiftUI

// MARK: - Message
extension InternetConnectFailure {

    /// What the add sheet and the account say when an account could not be connected or signed in.
    var message: LocalizedStringKey {
        switch self {
        case .invalidInput: "internetAccounts.add.error.invalid"
        case .refused: "internetAccounts.add.error.refused"
        case .unavailable: "internetAccounts.add.error.unavailable"
        case .unexpected: "internetAccounts.add.error.unexpected"
        case .declined: "internetAccounts.add.error.declined"
        case .wrongCredentials: "internetAccounts.add.error.wrongCredentials"
        case .appPasswordRequired: "internetAccounts.add.error.appPasswordRequired"
        case .serverUnreachable: "internetAccounts.add.error.serverUnreachable"
        case .tlsFailed: "internetAccounts.add.error.tlsFailed"
        case .caldavRefused: "internetAccounts.add.error.caldavRefused"
        case .caldavUnreachable: "internetAccounts.add.error.caldavUnreachable"
        case .alreadyConnected: "internetAccounts.add.error.alreadyConnected"
        case .rateLimited: "internetAccounts.add.error.rateLimited"
        case .wrongAccount: "internetAccounts.add.error.wrongAccount"
        case .mailConsentMissing: "internetAccounts.add.error.mailConsentMissing"
        }
    }
}
