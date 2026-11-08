import Foundation

/// An expected failure the shared layer reports as a value.
public enum FailureKind: Equatable, Sendable {

    case unavailable
    case invalidData
}
