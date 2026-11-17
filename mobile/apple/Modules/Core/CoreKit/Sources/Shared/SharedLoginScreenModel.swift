@preconcurrency internal import SharedSDK

/// The Kotlin `LoginViewModel` as a `LoginScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedLoginScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.LoginViewModel
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.LoginViewModel) {
        self.viewModel = viewModel
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedLoginScreenModel: ScreenModel {

    var state: LoginState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<LoginState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    /// The Kotlin ViewModel's effect type is `Nothing`, so the stream has no elements.
    func effects() -> AsyncStream<Never> {
        AsyncStream { $0.finish() }
    }

    func send(_ action: LoginAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedLoginScreenModel {

    static func state(_ state: SharedSDK.LoginState) -> LoginState {
        switch state.phase {
        case .editing: .editing(resetRequested: state.resetRequested)
        case .signingIn: .signingIn
        case .failed: .failed(state.failure.map(FailureKind.init))
        }
    }

    static func action(_ action: LoginAction) -> any SharedSDK.LoginAction {
        switch action {
        case .signIn(let server, let email, let password):
            SharedSDK.LoginActionSignIn(server: server, email: email, password: password)
        case .forgotPassword(let server, let email):
            SharedSDK.LoginActionForgotPassword(server: server, email: email)
        case .edited: SharedSDK.LoginActionEdited.shared
        }
    }
}
