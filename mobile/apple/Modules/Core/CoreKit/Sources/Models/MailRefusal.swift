import Foundation

/// Why the server refused a draft, a send or a thread action, for the screen to say instead of a generic failure.
public enum MailRefusal: CaseIterable, Equatable, Sendable {

    case draftsFolderMissing
    case sentFolderMissing
    case archiveFolderMissing
    case trashFolderMissing
    case inboxFolderMissing
    /// The account must sign in again before it can send.
    case reauthorizationRequired
    /// Mail is switched off for the account.
    case mailDisabled
    /// The mail server refused a recipient; recipients it accepted may have the message already.
    case recipientRejected
    /// The mail server refused the account's login when sending.
    case loginRejected
    /// The mail server could not be reached when sending.
    case serverUnreachable
    case attachmentTooLarge
    case draftAlreadySent
    /// The draft has no Alldots draft row and cannot be changed.
    case draftNotEditable
    /// The thread has no received message to mark unread or flag.
    case noReceivedMessage
    /// A message of the thread cannot be addressed at its mail server.
    case moveSourceUnverified
    case alreadyTrashed
    case notArchivedOrTrashed
}
