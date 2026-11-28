import CoreKit
import Foundation

// MARK: - Message
extension MailRefusal {

    /// The localized text that says why the server refused the draft, the send or the thread action.
    var message: String {
        switch self {
        case .draftsFolderMissing: String(localized: "mail.refusal.draftsFolderMissing", bundle: .module)
        case .sentFolderMissing: String(localized: "mail.refusal.sentFolderMissing", bundle: .module)
        case .archiveFolderMissing: String(localized: "mail.refusal.archiveFolderMissing", bundle: .module)
        case .trashFolderMissing: String(localized: "mail.refusal.trashFolderMissing", bundle: .module)
        case .inboxFolderMissing: String(localized: "mail.refusal.inboxFolderMissing", bundle: .module)
        case .reauthorizationRequired: String(localized: "mail.refusal.reauthorizationRequired", bundle: .module)
        case .mailDisabled: String(localized: "mail.refusal.mailDisabled", bundle: .module)
        case .recipientRejected: String(localized: "mail.refusal.recipientRejected", bundle: .module)
        case .loginRejected: String(localized: "mail.refusal.loginRejected", bundle: .module)
        case .serverUnreachable: String(localized: "mail.refusal.serverUnreachable", bundle: .module)
        case .attachmentTooLarge: String(localized: "mail.refusal.attachmentTooLarge", bundle: .module)
        case .draftAlreadySent: String(localized: "mail.refusal.draftAlreadySent", bundle: .module)
        case .draftNotEditable: String(localized: "mail.refusal.draftNotEditable", bundle: .module)
        case .noReceivedMessage: String(localized: "mail.refusal.noReceivedMessage", bundle: .module)
        case .moveSourceUnverified: String(localized: "mail.refusal.moveSourceUnverified", bundle: .module)
        case .alreadyTrashed: String(localized: "mail.refusal.alreadyTrashed", bundle: .module)
        case .notArchivedOrTrashed: String(localized: "mail.refusal.notArchivedOrTrashed", bundle: .module)
        }
    }

    /// The text of a thread action's alert: the refusal's when the server named one, else the generic one.
    static func actionMessage(for refusal: MailRefusal?) -> String {
        refusal?.message ?? String(localized: "mail.failure.message", bundle: .module)
    }
}
