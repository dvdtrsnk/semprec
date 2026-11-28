@preconcurrency internal import SharedSDK

/// The Kotlin `PasswordResetViewModel` as a `PasswordResetScreenModel`. Releasing the bridge closes the Kotlin
/// ViewModel.
@MainActor
final class SharedPasswordResetScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.PasswordResetViewModel
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.PasswordResetViewModel) {
        self.viewModel = viewModel
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedPasswordResetScreenModel: ScreenModel {

    var state: PasswordResetState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<PasswordResetState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    /// The Kotlin ViewModel's effect type is `Nothing`, so the stream has no elements.
    func effects() -> AsyncStream<Never> {
        AsyncStream { $0.finish() }
    }

    func send(_ action: PasswordResetAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedPasswordResetScreenModel {

    static func state(_ state: SharedSDK.PasswordResetState) -> PasswordResetState {
        switch state.phase {
        case .editing: .editing(canSubmit: state.canSubmit)
        case .sending: .sending
        case .done: .done
        case .failed:
            if let refusal = state.refusal {
                .refused(Self.refusal(refusal), canSubmit: state.canSubmit)
            } else {
                .failed(state.failure.map(FailureKind.init), canSubmit: state.canSubmit)
            }
        }
    }

    static func refusal(_ reason: SharedSDK.PasswordResetRefusalReason) -> PasswordResetRefusal {
        switch reason {
        case .linkInvalid: .linkInvalid
        case .linkExpired: .linkExpired
        case .linkUsed: .linkUsed
        case .weakPassword: .weakPassword
        }
    }

    static func action(_ action: PasswordResetAction) -> any SharedSDK.PasswordResetAction {
        switch action {
        case .edited(let newPassword, let repeated):
            SharedSDK.PasswordResetActionEdited(newPassword: newPassword, repeated: repeated)
        case .submit(let newPassword, let repeated):
            SharedSDK.PasswordResetActionSubmit(newPassword: newPassword, repeated: repeated)
        }
    }
}
