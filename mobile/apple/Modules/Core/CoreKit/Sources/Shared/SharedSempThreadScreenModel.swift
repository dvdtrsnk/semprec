@preconcurrency internal import SharedSDK

/// The Kotlin `SempThreadViewModel` as a `SempThreadScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedSempThreadScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.SempThreadViewModel
    private let effectQueue: EffectQueue<SempThreadEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.SempThreadViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedSempThreadScreenModel: ScreenModel {

    var state: SempThreadState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<SempThreadState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<SempThreadEffect> {
        effectQueue.stream()
    }

    func send(_ action: SempThreadAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedSempThreadScreenModel {

    static func state(_ state: SharedSDK.SempThreadState) -> SempThreadState {
        SempThreadState(
            phase: SempPhase(state.phase, failure: state.failure),
            type: SempThreadType(state.type),
            threadId: state.threadId,
            title: state.title,
            subject: state.subject.map { SempSubject(title: $0.title, meta: $0.meta) },
            tick: state.tick.map(SempTickInfo.init),
            entries: state.entries.map(SempEntry.init),
            hasOlder: state.hasOlder,
            loadingOlder: state.loadingOlder,
            attachments: state.attachments.map(SempAttachment.init),
            canAttach: state.canAttach,
            sending: state.sending,
            notice: state.notice.map { SempNotice(id: $0.id, title: $0.title, text: $0.text) },
            actionFailure: state.actionFailed ? Failed(kind: state.actionFailure.map(FailureKind.init)) : nil
        )
    }

    static func action(_ action: SempThreadAction) -> any SharedSDK.SempThreadAction {
        switch action {
        case .retry: SharedSDK.SempThreadActionRetry.shared
        case .refresh: SharedSDK.SempThreadActionRefresh.shared
        case .send(let text): SharedSDK.SempThreadActionSend(text: text)
        case .resolveUnsent(let id, let retry): SharedSDK.SempThreadActionResolveUnsent(id: id, retry: retry)
        case .askAgain(let messageId, let regenerate):
            SharedSDK.SempThreadActionAskAgain(messageId: messageId, regenerate: regenerate)
        case .toggleRun(let messageId): SharedSDK.SempThreadActionToggleRun(messageId: messageId)
        case .decide(let approvalId, let approve):
            SharedSDK.SempThreadActionDecide(approvalId: approvalId, approve: approve)
        case .loadOlder: SharedSDK.SempThreadActionLoadOlder.shared
        case .runAgain: SharedSDK.SempThreadActionRunAgain.shared
        case .dismiss(let dismissal): Self.dismissal(dismissal)
        case .open(let opening): Self.opening(opening)
        }
    }

    private static func dismissal(_ dismissal: SempThreadDismissal) -> any SharedSDK.SempThreadAction {
        switch dismissal {
        case .notice: SharedSDK.SempThreadActionDismissNotice.shared
        case .failure: SharedSDK.SempThreadActionDismissFailure.shared
        case .attachment(let key): SharedSDK.SempThreadActionDismissAttachment(key: key)
        }
    }

    private static func opening(_ opening: SempThreadOpening) -> any SharedSDK.SempThreadAction {
        switch opening {
        case .run(let runId, let messageId): SharedSDK.SempThreadActionOpenRun(runId: runId, messageId: messageId)
        case .change(let itemId, let databaseKey):
            SharedSDK.SempThreadActionOpenChange(itemId: itemId, databaseKey: databaseKey)
        case .approvals: SharedSDK.SempThreadActionOpenApprovals.shared
        case .status: SharedSDK.SempThreadActionOpenStatus.shared
        case .history: SharedSDK.SempThreadActionOpenHistory.shared
        case .newChat: SharedSDK.SempThreadActionOpenNewChat.shared
        }
    }

    static func effect(_ effect: any SharedSDK.SempThreadEffect) -> SempThreadEffect {
        switch onEnum(of: effect) {
        case .openRun(let run): .openRun(runId: run.runId, messageId: run.messageId)
        case .openItem(let item): .openItem(itemId: item.itemId, databaseKey: item.databaseKey)
        case .openApprovals: .openApprovals
        case .openStatus: .openStatus
        case .openHistory: .openHistory
        case .openNewChat: .openNewChat
        }
    }
}
