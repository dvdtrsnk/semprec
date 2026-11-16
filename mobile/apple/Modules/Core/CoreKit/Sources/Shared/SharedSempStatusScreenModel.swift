@preconcurrency internal import SharedSDK

/// The Kotlin `SempStatusViewModel` as a `SempStatusScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedSempStatusScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.SempStatusViewModel
    private let effectQueue: EffectQueue<SempStatusEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.SempStatusViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedSempStatusScreenModel: ScreenModel {

    var state: SempStatusState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<SempStatusState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<SempStatusEffect> {
        effectQueue.stream()
    }

    func send(_ action: SempStatusAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedSempStatusScreenModel {

    static func state(_ state: SharedSDK.SempStatusState) -> SempStatusState {
        SempStatusState(
            phase: SempPhase(state.phase, failure: state.failure),
            issues: state.issues.map(SempIssue.init),
            services: state.services.map { service in
                SempServiceRow(
                    key: service.key,
                    name: service.name,
                    failingSince: service.failingSince,
                    lastActivityAt: service.lastActivityAt
                )
            },
            resolved: state.resolved.map { SempResolvedRow(id: $0.id, title: $0.title, resolvedAt: $0.resolvedAt) },
            historyOpen: state.historyOpen
        )
    }

    static func action(_ action: SempStatusAction) -> any SharedSDK.SempStatusAction {
        switch action {
        case .retry: SharedSDK.SempStatusActionRetry.shared
        case .fix(let issueId): SharedSDK.SempStatusActionFix(issueId: issueId)
        case .open(let issueId): SharedSDK.SempStatusActionOpen(issueId: issueId)
        case .toggleHistory: SharedSDK.SempStatusActionToggleHistory.shared
        }
    }

    static func effect(_ effect: any SharedSDK.SempStatusEffect) -> SempStatusEffect {
        switch onEnum(of: effect) {
        case .openChat(let open): .openChat(threadId: open.threadId, messageId: open.messageId)
        case .openThread(let open): .openThread(threadId: open.threadId)
        case .openProject(let open): .openProject(projectId: open.projectId)
        }
    }
}

// MARK: - SempIssue
extension SempIssue {

    init(_ issue: SharedSDK.SempIssue) {
        self.init(
            id: issue.id,
            category: issue.category,
            critical: issue.critical,
            title: issue.title,
            text: issue.text,
            since: issue.since,
            mergedCount: Int(issue.mergedCount),
            projectName: issue.projectName,
            fix: issue.fix.map(SempIssueFix.init),
            link: issue.link.map(SempIssueLink.init),
            busy: issue.busy,
            fixFailed: issue.fixFailed
        )
    }
}

// MARK: - SempIssueFix
extension SempIssueFix {

    init(_ fix: SharedSDK.SempIssueFix) {
        switch fix {
        case .retry: self = .retry
        case .disableAutomation: self = .disableAutomation
        }
    }
}

// MARK: - SempIssueLink
extension SempIssueLink {

    init(_ link: SharedSDK.SempIssueLink) {
        switch link {
        case .chat: self = .chat
        case .thread: self = .thread
        case .project: self = .project
        }
    }
}
