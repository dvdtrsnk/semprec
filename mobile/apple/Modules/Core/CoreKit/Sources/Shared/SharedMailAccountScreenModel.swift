@preconcurrency internal import SharedSDK

/// The Kotlin `MailAccountViewModel` as a `MailAccountScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedMailAccountScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.MailAccountViewModel
    private let effectQueue: EffectQueue<MailAccountEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.MailAccountViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedMailAccountScreenModel: ScreenModel {

    var state: MailAccountState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<MailAccountState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<MailAccountEffect> {
        effectQueue.stream()
    }

    func send(_ action: MailAccountAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedMailAccountScreenModel {

    static func state(_ state: SharedSDK.MailAccountState) -> MailAccountState {
        MailAccountState(
            phase: phase(state),
            account: state.account.map(account),
            removal: removal(state.removal),
            impact: state.impact.map {
                MailRemovalImpactItem(
                    messages: Int($0.messages),
                    drafts: Int($0.drafts),
                    threads: Int($0.threads),
                    attachmentsKept: Int($0.attachmentsKept)
                )
            },
            actionFailed: state.actionFailed
        )
    }

    static func action(_ action: MailAccountAction) -> any SharedSDK.MailAccountAction {
        switch action {
        case .retry: SharedSDK.MailAccountActionRetry.shared
        case .rename(let name): SharedSDK.MailAccountActionRename(name: name)
        case .stepConnectionLimit(let delta): SharedSDK.MailAccountActionStepConnectionLimit(delta: Int32(delta))
        case .requestRemoval: SharedSDK.MailAccountActionRequestRemoval.shared
        case .cancelRemoval: SharedSDK.MailAccountActionCancelRemoval.shared
        case .confirmRemoval: SharedSDK.MailAccountActionConfirmRemoval.shared
        case .dismissFailure: SharedSDK.MailAccountActionDismissFailure.shared
        }
    }

    static func effect(_ effect: any SharedSDK.MailAccountEffect) -> MailAccountEffect {
        switch onEnum(of: effect) {
        case .removed: .removed
        }
    }

    private static func phase(_ state: SharedSDK.MailAccountState) -> MailAccountPhase {
        switch state.phase {
        case .loading: .loading
        case .content: .content
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    private static func removal(_ phase: SharedSDK.MailRemovalPhase) -> MailRemovalPhase {
        switch phase {
        case .idle: .idle
        case .loadingImpact: .loadingImpact
        case .confirming: .confirming
        case .removing: .removing
        }
    }

    private static func account(_ account: SharedSDK.MailAccountDetail) -> MailAccountDetail {
        MailAccountDetail(
            id: account.id,
            name: account.name,
            address: account.address,
            provider: account.provider,
            syncMode: account.syncMode,
            status: MailAccountStatus(account.status),
            lastSuccessfulSyncAt: account.lastSuccessfulSyncAt,
            failingSince: account.failingSince,
            connectionLimit: Int(account.connectionLimit),
            connectionLimitApplies: account.connectionLimitApplies,
            autonomousSendProjectCount: Int(account.autonomousSendProjectCount)
        )
    }
}
