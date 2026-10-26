import Foundation

public enum DetailState: Equatable, Sendable {

    case loading
    case content(PlaceholderItem)
    /// No item has the requested id.
    case notFound
    /// `nil` for an unexpected failure, which has no typed reason.
    case failure(FailureKind?)
}

public enum DetailAction: Equatable, Sendable {

    case retry
}

/// The detail screen raises no effects.
public typealias DetailScreenModel = ScreenModel<DetailState, DetailAction, Never>

/// Detail screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedDetailScreenModel = ScriptedScreenModel<DetailState, DetailAction, Never>
