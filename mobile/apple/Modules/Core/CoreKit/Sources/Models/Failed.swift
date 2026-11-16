import Foundation

/// Something that did not go through: `kind` is the expected reason, or nil for an unexpected failure, which has no
/// typed reason. A state that holds one is failed even when `kind` is nil.
public struct Failed: Equatable, Sendable {

    public let kind: FailureKind?

    public init(kind: FailureKind?) {
        self.kind = kind
    }
}
