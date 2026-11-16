@preconcurrency internal import SharedSDK

/// The Kotlin `SempApprovalsViewModel` as a `SempApprovalsScreenModel`. Releasing the bridge closes the ViewModel.
@MainActor
final class SharedSempApprovalsScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.SempApprovalsViewModel
    private let effectQueue: EffectQueue<SempApprovalsEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.SempApprovalsViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedSempApprovalsScreenModel: ScreenModel {

    var state: SempApprovalsState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<SempApprovalsState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<SempApprovalsEffect> {
        effectQueue.stream()
    }

    func send(_ action: SempApprovalsAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedSempApprovalsScreenModel {

    static func state(_ state: SharedSDK.SempApprovalsState) -> SempApprovalsState {
        SempApprovalsState(
            phase: SempPhase(state.phase, failure: state.failure),
            tab: SempApprovalsTab(state.tab),
            items: state.items.map(SempApprovalItem.init),
            pendingCount: Int(state.pendingCount),
            hasMore: state.hasMore,
            loadingMore: state.loadingMore,
            expanded: Set(state.expanded)
        )
    }

    static func action(_ action: SempApprovalsAction) -> any SharedSDK.SempApprovalsAction {
        switch action {
        case .retry: SharedSDK.SempApprovalsActionRetry.shared
        case .setTab(let tab): SharedSDK.SempApprovalsActionSetTab(tab: tab.shared)
        case .loadMore: SharedSDK.SempApprovalsActionLoadMore.shared
        case .decide(let approvalId, let approve):
            SharedSDK.SempApprovalsActionDecide(approvalId: approvalId, approve: approve)
        case .toggleDetails(let approvalId): SharedSDK.SempApprovalsActionToggleDetails(approvalId: approvalId)
        case .openThread(let approvalId): SharedSDK.SempApprovalsActionOpenThread(approvalId: approvalId)
        case .openRun(let approvalId): SharedSDK.SempApprovalsActionOpenRun(approvalId: approvalId)
        }
    }

    static func effect(_ effect: any SharedSDK.SempApprovalsEffect) -> SempApprovalsEffect {
        switch onEnum(of: effect) {
        case .openThread(let open): .openThread(threadId: open.threadId)
        case .openRun(let open): .openRun(runId: open.runId)
        }
    }
}

extension SempApprovalsTab {

    init(_ tab: SharedSDK.SempApprovalsTab) {
        switch tab {
        case .pending: self = .pending
        case .decided: self = .decided
        }
    }

    var shared: SharedSDK.SempApprovalsTab {
        switch self {
        case .pending: .pending
        case .decided: .decided
        }
    }
}
