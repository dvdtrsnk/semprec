import Foundation

/// An expected failure, as a value: the reason a screen shows instead of content.
public enum FailureKind: Equatable, Sendable {

    /// The request could not complete: no network or a server error.
    case unavailable
    /// The answer could not be read.
    case invalidData
    /// The session or the credentials were refused.
    case unauthorized
    /// The server does not have the thing asked for.
    case notFound
    /// The server refused the request as invalid or in conflict.
    case rejected
}
