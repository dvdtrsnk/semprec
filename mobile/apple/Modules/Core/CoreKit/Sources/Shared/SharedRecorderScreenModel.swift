@preconcurrency internal import SharedSDK

/// The Kotlin `RecorderViewModel` as a `RecorderScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedRecorderScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.RecorderViewModel
    private let effectQueue: EffectQueue<RecorderEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.RecorderViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedRecorderScreenModel: ScreenModel {

    var state: RecorderState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<RecorderState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<RecorderEffect> {
        effectQueue.stream()
    }

    func send(_ action: RecorderAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedRecorderScreenModel {

    static func state(_ state: SharedSDK.RecorderState) -> RecorderState {
        RecorderState(
            phase: phase(state.phase),
            elapsedSeconds: Int(state.elapsedSeconds),
            levels: state.levels.map(\.floatValue),
            problem: state.problem.map(problem),
            failure: state.failure.map(FailureKind.init),
            busy: state.busy
        )
    }

    static func phase(_ phase: SharedSDK.RecorderPhase) -> RecorderPhase {
        switch phase {
        case .idle: .idle
        case .recording: .recording
        case .paused: .paused
        case .saving: .saving
        case .uploading: .uploading
        case .failed: .failed
        }
    }

    static func problem(_ problem: SharedSDK.RecorderProblem) -> RecorderProblem {
        switch problem {
        case .permissionDenied: .permissionDenied
        case .startFailed: .startFailed
        case .captureFailed: .captureFailed
        case .importFailed: .importFailed
        case .uploadFailed: .uploadFailed
        }
    }

    static func action(_ action: RecorderAction) -> any SharedSDK.RecorderAction {
        switch action {
        case .start: SharedSDK.RecorderActionStart.shared
        case .pause: SharedSDK.RecorderActionPause.shared
        case .resume: SharedSDK.RecorderActionResume.shared
        case .stop: SharedSDK.RecorderActionStop.shared
        case .discard: SharedSDK.RecorderActionDiscard.shared
        case .retry: SharedSDK.RecorderActionRetry.shared
        case .importFile(let path): SharedSDK.RecorderActionImport(path: path)
        }
    }

    static func effect(_ effect: any SharedSDK.RecorderEffect) -> RecorderEffect {
        switch onEnum(of: effect) {
        case .uploaded: .uploaded
        }
    }
}
