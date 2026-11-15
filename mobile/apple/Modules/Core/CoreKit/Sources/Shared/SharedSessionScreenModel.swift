@preconcurrency internal import SharedSDK

/// The Kotlin `SessionViewModel` as a `SessionScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedSessionScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.SessionViewModel
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.SessionViewModel) {
        self.viewModel = viewModel
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedSessionScreenModel: ScreenModel {

    var state: SessionState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<SessionState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    /// The Kotlin ViewModel's effect type is `Nothing`, so the stream has no elements.
    func effects() -> AsyncStream<Never> {
        AsyncStream { $0.finish() }
    }

    func send(_ action: SessionAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedSessionScreenModel {

    static func state(_ state: SharedSDK.SessionState) -> SessionState {
        switch state.phase {
        case .restoring: .restoring
        case .signedOut: .signedOut
        case .unreachable: .unreachable
        // The shared ViewModel sets the e-mail and the server in every SIGNED_IN state; without them the person is
        // treated as signed out, which sends them to the sign-in form instead of showing a blank account.
        case .signedIn:
            if let email = state.email, let serverUrl = state.serverUrl {
                .signedIn(SessionUser(email: email, role: state.role ?? "member", serverUrl: serverUrl))
            } else {
                .signedOut
            }
        }
    }

    static func action(_ action: SessionAction) -> any SharedSDK.SessionAction {
        switch action {
        case .retry: SharedSDK.SessionActionRetry.shared
        case .signOut: SharedSDK.SessionActionSignOut.shared
        }
    }
}
