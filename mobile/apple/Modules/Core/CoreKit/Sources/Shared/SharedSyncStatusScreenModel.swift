@preconcurrency internal import SharedSDK

/// The Kotlin `SyncStatusViewModel` as a `SyncStatusScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedSyncStatusScreenModel {

    // MARK: - Dependencies
    let viewModel: SharedSDK.SyncStatusViewModel
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.SyncStatusViewModel) {
        self.viewModel = viewModel
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedSyncStatusScreenModel: ScreenModel {

    var state: SyncStatusState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<SyncStatusState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    /// The Kotlin ViewModel's effect type is `Nothing`, so the stream has no elements.
    func effects() -> AsyncStream<Never> {
        AsyncStream { $0.finish() }
    }

    func send(_ action: SyncStatusAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedSyncStatusScreenModel {

    static func state(_ state: SharedSDK.SyncStatusState) -> SyncStatusState {
        SyncStatusState(offline: state.offline, waiting: Int(state.waiting), failed: Int(state.failed))
    }

    static func action(_ action: SyncStatusAction) -> any SharedSDK.SyncStatusAction {
        switch action {
        case .dismissFailures: SharedSDK.SyncStatusActionDismissFailures.shared
        }
    }
}
