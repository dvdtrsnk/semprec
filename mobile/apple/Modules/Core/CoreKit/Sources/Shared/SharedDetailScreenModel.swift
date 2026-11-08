@preconcurrency internal import SharedSDK

/// The Kotlin `DetailViewModel` as a `DetailScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedDetailScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.DetailViewModel
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.DetailViewModel) {
        self.viewModel = viewModel
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedDetailScreenModel: ScreenModel {

    var state: DetailState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<DetailState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    /// The Kotlin ViewModel's effect type is `Nothing`, so the stream has no elements.
    func effects() -> AsyncStream<Never> {
        AsyncStream { $0.finish() }
    }

    func send(_ action: DetailAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedDetailScreenModel {

    static func state(_ state: SharedSDK.DetailState) -> DetailState {
        switch state.phase {
        case .loading: .loading
        // The shared ViewModel sets the item in every CONTENT state; without one there is nothing to render.
        case .content: state.item.map { .content(PlaceholderItem($0)) } ?? .failure(nil)
        case .notFound: .notFound
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    static func action(_ action: DetailAction) -> any SharedSDK.DetailAction {
        switch action {
        case .retry: SharedSDK.DetailActionRetry.shared
        }
    }
}
