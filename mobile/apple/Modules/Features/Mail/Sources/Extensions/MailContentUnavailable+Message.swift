import CoreKit
import Foundation

// MARK: - Message
extension MailContentUnavailable {

    /// The localized text that says why the body or the attachment could not be fetched from the mail provider.
    var message: String {
        switch self {
        case .reauthorizationRequired: String(localized: "mail.content.reauthorizationRequired", bundle: .module)
        case .providerUnreachable: String(localized: "mail.content.providerUnreachable", bundle: .module)
        case .messageNotFound: String(localized: "mail.content.messageNotFound", bundle: .module)
        case .mailboxUnavailable: String(localized: "mail.content.mailboxUnavailable", bundle: .module)
        case .attachmentTooLarge: String(localized: "mail.content.attachmentTooLarge", bundle: .module)
        case .rateLimited: String(localized: "mail.content.rateLimited", bundle: .module)
        }
    }

    /// The text of a body or a save that failed: the reason the server named, else the failure's.
    static func message(for failure: FailureKind?, unavailable: MailContentUnavailable?) -> String {
        unavailable?.message ?? FailureKind.message(for: failure)
    }
}
