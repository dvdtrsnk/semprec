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
        }
    }
}
