@preconcurrency internal import SharedSDK

/// The Kotlin `SempChatsViewModel` as a `SempChatsScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedSempChatsScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.SempChatsViewModel
    private let effectQueue: EffectQueue<SempChatsEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.SempChatsViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedSempChatsScreenModel: ScreenModel {

    var state: SempChatsState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<SempChatsState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<SempChatsEffect> {
        effectQueue.stream()
    }

    func send(_ action: SempChatsAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedSempChatsScreenModel {

    static func state(_ state: SharedSDK.SempChatsState) -> SempChatsState {
        SempChatsState(
            phase: SempPhase(state.phase, failure: state.failure),
            query: state.query,
            filter: SempChatsFilter(state.filter),
            rows: state.rows.map(SempChatRow.init),
            hasMore: state.hasMore,
            loadingMore: state.loadingMore,
            approvals: state.approvals.map(SempApprovalItem.init),
            approvalCount: Int(state.approvalCount)
        )
    }

    static func action(_ action: SempChatsAction) -> any SharedSDK.SempChatsAction {
        switch action {
        case .retry: SharedSDK.SempChatsActionRetry.shared
        case .setQuery(let text): SharedSDK.SempChatsActionSetQuery(text: text)
        case .setFilter(let filter): SharedSDK.SempChatsActionSetFilter(filter: filter.shared)
        case .loadMore: SharedSDK.SempChatsActionLoadMore.shared
        case .decide(let approvalId, let approve):
            SharedSDK.SempChatsActionDecide(approvalId: approvalId, approve: approve)
        case .openThread(let threadId): SharedSDK.SempChatsActionOpenThread(threadId: threadId)
        case .openApprovals: SharedSDK.SempChatsActionOpenApprovals.shared
        case .openNewChat: SharedSDK.SempChatsActionOpenNewChat.shared
        }
    }

    static func effect(_ effect: any SharedSDK.SempChatsEffect) -> SempChatsEffect {
        switch onEnum(of: effect) {
        case .openThread(let open): .openThread(SempChatRow(open.row))
        case .openApprovals: .openApprovals
        case .openNewChat: .openNewChat
        }
    }
}

extension SempChatsFilter {

    init(_ filter: SharedSDK.SempChatsFilter) {
        switch filter {
        case .all: self = .all
        case .chats: self = .chats
        case .ticks: self = .ticks
        }
    }

    var shared: SharedSDK.SempChatsFilter {
        switch self {
        case .all: .all
        case .chats: .chats
        case .ticks: .ticks
        }
    }
}

extension SempChatRow {

    init(_ row: SharedSDK.SempChatRow) {
        self.init(
            id: row.id,
            type: SempThreadType(row.type),
            title: row.title,
            previewText: row.previewText,
            previewSystemKey: row.previewSystemKey,
            lastActivityAt: row.lastActivityAt,
            waiting: row.waiting,
            projectName: row.projectName,
            subjectInboxItemId: row.subjectInboxItemId
        )
    }
}
