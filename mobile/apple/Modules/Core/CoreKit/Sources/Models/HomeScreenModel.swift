import Foundation

public enum HomeState: Equatable, Sendable {

    case loading
    case content([PlaceholderItem])
    case empty
    /// `nil` for an unexpected failure, which has no typed reason.
    case failure(FailureKind?)
}

public enum HomeAction: Equatable, Sendable {

    case retry
    case selectItem(id: String)
}

public enum HomeEffect: Equatable, Sendable {

    case openDetail(id: String)
}

public typealias HomeScreenModel = ScreenModel<HomeState, HomeAction, HomeEffect>

/// Home screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedHomeScreenModel = ScriptedScreenModel<HomeState, HomeAction, HomeEffect>
