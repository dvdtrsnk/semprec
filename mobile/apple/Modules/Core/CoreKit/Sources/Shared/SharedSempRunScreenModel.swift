@preconcurrency internal import SharedSDK

/// The Kotlin `SempRunViewModel` as a `SempRunScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedSempRunScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.SempRunViewModel
    private let effectQueue: EffectQueue<SempRunEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.SempRunViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedSempRunScreenModel: ScreenModel {

    var state: SempRunState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<SempRunState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<SempRunEffect> {
        effectQueue.stream()
    }

    func send(_ action: SempRunAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedSempRunScreenModel {

    static func state(_ state: SharedSDK.SempRunState) -> SempRunState {
        SempRunState(
            phase: SempPhase(state.phase, failure: state.failure),
            run: state.run.map(SempRunView.init),
            stepsPhase: SempStepsPhase(state.stepsPhase),
            steps: state.steps.map(SempRunStepRow.init),
            historyTruncated: state.historyTruncated,
            retrying: state.retrying,
            retryFailed: state.retryFailed
        )
    }

    static func action(_ action: SempRunAction) -> any SharedSDK.SempRunAction {
        switch action {
        case .retry: SharedSDK.SempRunActionRetry.shared
        case .retryRun: SharedSDK.SempRunActionRetryRun.shared
        case .openThread: SharedSDK.SempRunActionOpenThread.shared
        case .openApprovals: SharedSDK.SempRunActionOpenApprovals.shared
        }
    }

    static func effect(_ effect: any SharedSDK.SempRunEffect) -> SempRunEffect {
        switch onEnum(of: effect) {
        case .openThread(let open): .openThread(threadId: open.threadId)
        case .openApprovals: .openApprovals
        }
    }
}

// MARK: - SempRunView
extension SempRunView {

    init(_ run: SharedSDK.SempRunView) {
        self.init(
            id: run.id,
            title: run.title,
            display: SempRunDisplay(run.display),
            trigger: SempRunTriggerKind(run.trigger),
            threadId: run.threadId,
            projectName: run.projectName,
            startedAt: run.startedAt,
            durationMs: run.durationMs?.int64Value,
            approvalCount: Int(run.approvalCount),
            pendingApprovalCount: Int(run.pendingApprovalCount),
            errorSummary: run.errorSummary,
            canRetry: run.canRetry,
            totalCostUsd: run.totalCostUsd,
            costIsEstimate: run.costIsEstimate,
            usage: run.usage.map {
                SempUsageRow(
                    modelName: $0.modelName,
                    calls: Int($0.calls),
                    inputTokens: $0.inputTokens,
                    outputTokens: $0.outputTokens,
                    costUsd: $0.costUsd
                )
            }
        )
    }
}

// MARK: - SempRunStepRow
extension SempRunStepRow {

    init(_ step: SharedSDK.SempRunStepRow) {
        self.init(
            id: step.id,
            kind: SempRunStepKind(step.kind),
            state: SempLineState(step.state),
            title: step.title,
            summary: step.summary,
            time: step.at,
            durationMs: step.durationMs?.int64Value
        )
    }
}

// MARK: - SempRunStepKind
extension SempRunStepKind {

    init(_ kind: SharedSDK.SempRunStepKindView) {
        switch kind {
        case .start: self = .start
        case .plan: self = .plan
        case .tool: self = .tool
        case .approval: self = .approval
        case .answer: self = .answer
        case .end: self = .end
        case .error: self = .error
        }
    }
}
