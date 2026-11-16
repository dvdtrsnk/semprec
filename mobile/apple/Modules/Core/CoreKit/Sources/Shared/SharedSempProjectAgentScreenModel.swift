@preconcurrency internal import SharedSDK

/// The Kotlin `SempProjectAgentViewModel` as a `SempProjectAgentScreenModel`. Releasing the bridge closes the
/// Kotlin ViewModel.
@MainActor
final class SharedSempProjectAgentScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.SempProjectAgentViewModel
    private let effectQueue: EffectQueue<SempProjectAgentEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.SempProjectAgentViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedSempProjectAgentScreenModel: ScreenModel {

    var state: SempProjectAgentState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<SempProjectAgentState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<SempProjectAgentEffect> {
        effectQueue.stream()
    }

    func send(_ action: SempProjectAgentAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedSempProjectAgentScreenModel {

    static func state(_ state: SharedSDK.SempProjectAgentState) -> SempProjectAgentState {
        SempProjectAgentState(
            phase: SempPhase(state.phase, failure: state.failure),
            projectName: state.projectName,
            sections: SempSections(
                purpose: state.sections.purpose,
                allowed: state.sections.allowed,
                notAllowed: state.sections.notAllowed,
                general: state.sections.general
            ),
            saveState: SempSaveState(state.saveState),
            finding: state.finding.map(SempFinding.init),
            servers: state.servers.map(SempToolServer.init),
            tasks: state.tasks.map(SempTaskRow.init),
            runs: state.runs.map(SempAgentRunRow.init),
            partialFailure: state.partialFailure,
            changeFailed: state.changeFailed
        )
    }

    static func action(_ action: SempProjectAgentAction) -> any SharedSDK.SempProjectAgentAction {
        switch action {
        case .retry: SharedSDK.SempProjectAgentActionRetry.shared
        case .saveSection(let section, let text):
            SharedSDK.SempProjectAgentActionSaveSection(section: section.shared, text: text)
        case .retrySave: SharedSDK.SempProjectAgentActionRetrySave.shared
        case .resolveDrift(let answer): SharedSDK.SempProjectAgentActionResolveDrift(answer: answer.shared)
        case .setTool(let registrationId, let granted):
            SharedSDK.SempProjectAgentActionSetTool(registrationId: registrationId, granted: granted)
        case .setTask(let taskId, let enabled):
            SharedSDK.SempProjectAgentActionSetTask(taskId: taskId, enabled: enabled)
        case .openTask(let taskId): SharedSDK.SempProjectAgentActionOpenTask(taskId: taskId)
        case .openRun(let rowId): SharedSDK.SempProjectAgentActionOpenRun(rowId: rowId)
        case .dismissFailure: SharedSDK.SempProjectAgentActionDismissFailure.shared
        }
    }

    static func effect(_ effect: any SharedSDK.SempProjectAgentEffect) -> SempProjectAgentEffect {
        switch onEnum(of: effect) {
        case .openThread(let open): .openThread(threadId: open.threadId)
        case .openRun(let open): .openRun(runId: open.runId, messageId: open.messageId)
        }
    }
}

// MARK: - SempSaveState
extension SempSaveState {

    init(_ state: SharedSDK.SempSaveState) {
        switch state {
        case .idle: self = .idle
        case .saving: self = .saving
        case .saved: self = .saved
        case .failed: self = .failed
        case .conflict: self = .conflict
        }
    }
}

// MARK: - SempSection
extension SempSection {

    var shared: SharedSDK.SempSection {
        switch self {
        case .purpose: .purpose
        case .allowed: .allowed
        case .notAllowed: .notAllowed
        case .general: .general
        }
    }
}

// MARK: - SempDriftAnswer
extension SempDriftAnswer {

    var shared: SharedSDK.SempDriftAnswer {
        switch self {
        case .allow: .allow
        case .forbid: .forbid
        case .dismiss: .dismiss
        }
    }
}

// MARK: - SempFinding
extension SempFinding {

    init(_ finding: SharedSDK.SempFinding) {
        self.init(
            id: finding.id,
            kind: finding.kind == .permission ? .permission : .behavior,
            claim: finding.claim,
            blocking: finding.blocking,
            canAllow: finding.canAllow,
            canForbid: finding.canForbid
        )
    }
}

// MARK: - SempToolServer
extension SempToolServer {

    init(_ server: SharedSDK.SempToolServer) {
        self.init(
            id: server.id,
            name: server.name,
            online: server.online,
            tools: server.tools.map {
                SempToolRow(
                    registrationId: $0.registrationId,
                    label: $0.label,
                    requiresApproval: $0.requiresApproval,
                    granted: $0.granted
                )
            }
        )
    }
}

// MARK: - SempTaskRow
extension SempTaskRow {

    init(_ task: SharedSDK.SempTaskRow) {
        self.init(
            id: task.id,
            name: task.name,
            ruleLabel: task.ruleLabel,
            enabled: task.enabled,
            threadId: task.threadId,
            lastAt: task.lastAt,
            lastFailed: task.lastFailed,
            lastWaiting: task.lastWaiting,
            lastErrorSummary: task.lastErrorSummary
        )
    }
}

// MARK: - SempAgentRunRow
extension SempAgentRunRow {

    init(_ row: SharedSDK.SempAgentRunRow) {
        self.init(
            id: row.id,
            runId: row.runId,
            messageId: row.messageId,
            title: row.title,
            trigger: SempRunTriggerKind(row.trigger),
            startedAt: row.startedAt,
            durationMs: row.durationMs?.int64Value,
            costUsd: row.costUsd,
            display: SempRunDisplay(row.display),
            errorSummary: row.errorSummary
        )
    }
}
