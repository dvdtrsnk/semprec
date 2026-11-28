@preconcurrency internal import SharedSDK

/// The Kotlin `WakeSettingsViewModel` as a `WakeSettingsScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedWakeSettingsScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.WakeSettingsViewModel
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.WakeSettingsViewModel) {
        self.viewModel = viewModel
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedWakeSettingsScreenModel: ScreenModel {

    var state: WakeSettingsState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<WakeSettingsState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    /// The Kotlin ViewModel's effect type is `Nothing`, so the stream has no elements.
    func effects() -> AsyncStream<Never> {
        AsyncStream { $0.finish() }
    }

    func send(_ action: WakeSettingsAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedWakeSettingsScreenModel {

    static func state(_ state: SharedSDK.WakeSettingsState) -> WakeSettingsState {
        WakeSettingsState(
            requiresCode: state.requiresCode,
            codes: state.codes,
            mode: mode(state.mode),
            failure: state.failure.map(failure)
        )
    }

    static func mode(_ mode: SharedSDK.WakeMode) -> WakeMode {
        switch mode {
        case .off: .off
        case .needsCode: .needsCode
        case .active: .active
        }
    }

    static func failure(_ failure: SharedSDK.WakeSettingsFailure) -> WakeSettingsFailure {
        switch failure {
        case .emptyCode: .emptyCode
        case .notAuthorized: .notAuthorized
        case .limitReached: .limitReached
        case .readFailed: .readFailed
        case .deviceFailed: .deviceFailed
        }
    }

    static func action(_ action: WakeSettingsAction) -> any SharedSDK.WakeSettingsAction {
        switch action {
        case .setRequiresCode(let required): SharedSDK.WakeSettingsActionSetRequiresCode(required: required)
        case .addCode(let code): SharedSDK.WakeSettingsActionAddCode(code: code)
        case .removeCode(let code): SharedSDK.WakeSettingsActionRemoveCode(code: code)
        case .dismissFailure: SharedSDK.WakeSettingsActionDismissFailure.shared
        }
    }
}
