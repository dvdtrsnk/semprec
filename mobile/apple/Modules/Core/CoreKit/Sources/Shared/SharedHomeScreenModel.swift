@preconcurrency internal import SharedSDK

/// The Kotlin `HomeViewModel` as a `HomeScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedHomeScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.HomeViewModel
    private let effectQueue: EffectQueue<HomeEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.HomeViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedHomeScreenModel: ScreenModel {

    var state: HomeState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<HomeState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<HomeEffect> {
        effectQueue.stream()
    }

    func send(_ action: HomeAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedHomeScreenModel {

    static func state(_ state: SharedSDK.HomeState) -> HomeState {
        switch state.phase {
        case .loading: .loading
        case .content: .content(state.items.map(PlaceholderItem.init))
        case .empty: .empty
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    static func action(_ action: HomeAction) -> any SharedSDK.HomeAction {
        switch action {
        case .retry: SharedSDK.HomeActionRetry.shared
        case .selectItem(let id): SharedSDK.HomeActionSelectItem(id: id)
        }
    }

    static func effect(_ effect: any SharedSDK.HomeEffect) -> HomeEffect {
        switch onEnum(of: effect) {
        case .openDetail(let openDetail): .openDetail(id: openDetail.id)
        }
    }
}
