@preconcurrency internal import SharedSDK

/// The Kotlin `InvitationsViewModel` as an `InvitationsScreenModel`. Releasing the bridge closes the ViewModel.
@MainActor
final class SharedInvitationsScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.InvitationsViewModel
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.InvitationsViewModel) {
        self.viewModel = viewModel
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedInvitationsScreenModel: ScreenModel {

    var state: InvitationsState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<InvitationsState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    /// The Kotlin ViewModel's effect type is `Nothing`, so the stream has no elements.
    func effects() -> AsyncStream<Never> {
        AsyncStream { $0.finish() }
    }

    func send(_ action: InvitationsAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedInvitationsScreenModel {

    static func state(_ state: SharedSDK.InvitationsState) -> InvitationsState {
        InvitationsState(
            phase: InvitationsPhase(state.phase, failure: state.failure),
            tab: InvitationsTab(state.tab),
            items: state.items.map(InvitationItem.init),
            pending: Int(state.pending),
            answering: state.answering,
            problem: state.problem,
            problemFailure: state.problemFailure.map(FailureKind.init)
        )
    }

    static func action(_ action: InvitationsAction) -> any SharedSDK.InvitationsAction {
        switch action {
        case .retry: SharedSDK.InvitationsActionRetry.shared
        case .showTab(let tab): SharedSDK.InvitationsActionShowTab(tab: tab.shared)
        case .answer(let id, let reply): SharedSDK.InvitationsActionAnswer(invitationId: id, reply: reply.shared)
        case .dismissProblem: SharedSDK.InvitationsActionDismissProblem.shared
        }
    }
}
