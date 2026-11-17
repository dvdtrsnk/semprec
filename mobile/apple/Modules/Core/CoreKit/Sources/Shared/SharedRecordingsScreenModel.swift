@preconcurrency internal import SharedSDK

/// The Kotlin `RecordingsViewModel` as a `RecordingsScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedRecordingsScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.RecordingsViewModel
    private let effectQueue: EffectQueue<RecordingsEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.RecordingsViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedRecordingsScreenModel: ScreenModel {

    var state: RecordingsState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<RecordingsState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<RecordingsEffect> {
        effectQueue.stream()
    }

    func send(_ action: RecordingsAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedRecordingsScreenModel {

    static func state(_ state: SharedSDK.RecordingsState) -> RecordingsState {
        RecordingsState(
            phase: phase(state.phase),
            failure: state.failure.map(FailureKind.init),
            recordings: state.recordings.map(RecordingRow.init)
        )
    }

    private static func phase(_ phase: SharedSDK.RecordingsPhase) -> RecordingsPhase {
        switch phase {
        case .loading: .loading
        case .content: .content
        case .error: .error
        }
    }

    static func action(_ action: RecordingsAction) -> any SharedSDK.RecordingsAction {
        switch action {
        case .retry: SharedSDK.RecordingsActionRetry.shared
        case .refresh: SharedSDK.RecordingsActionRefresh.shared
        case .open(let recordingId): SharedSDK.RecordingsActionOpen(recordingId: recordingId)
        }
    }

    static func effect(_ effect: any SharedSDK.RecordingsEffect) -> RecordingsEffect {
        switch onEnum(of: effect) {
        case .openTranscript(let open): .openTranscript(recordingId: open.recordingId)
        }
    }
}
