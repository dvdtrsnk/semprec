import Foundation

/// Why the server could not fetch a message's body or an attachment's bytes from the mail provider, for the screen to
/// say instead of a generic failure.
public enum MailContentUnavailable: CaseIterable, Equatable, Sendable {

    /// The account must sign in again.
    case reauthorizationRequired
    /// The mail provider could not be reached or did not answer in time.
    case providerUnreachable
    /// The mail provider no longer holds the message.
    case messageNotFound
    /// The account is removed or has Mail switched off.
    case mailboxUnavailable
    case attachmentTooLarge
    /// The person asked the mail provider too often in a short time.
    case rateLimited
}
