@preconcurrency internal import SharedSDK

/// The Kotlin `AiUsageViewModel` as an `AiUsageScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedAiUsageScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.AiUsageViewModel
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.AiUsageViewModel) {
        self.viewModel = viewModel
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedAiUsageScreenModel: ScreenModel {

    var state: AiUsageState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<AiUsageState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    /// The Kotlin ViewModel's effect type is `Nothing`, so the stream has no elements.
    func effects() -> AsyncStream<Never> {
        AsyncStream { $0.finish() }
    }

    func send(_ action: AiUsageAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedAiUsageScreenModel {

    static func state(_ state: SharedSDK.AiUsageState) -> AiUsageState {
        AiUsageState(
            phase: phase(state.phase),
            failure: state.failure.map(FailureKind.init),
            periods: state.periods.map(period),
            period: period(state.period),
            accountStartedAt: state.accountStartedAt,
            totalUsd: state.totalUsd,
            estimated: state.estimated,
            points: state.points.map { UsagePointItem(key: $0.key, costUsd: $0.costUsd) },
            models: state.models.map {
                UsageModelItem(
                    name: $0.name,
                    costUsd: $0.costUsd,
                    callCount: Int($0.callCount),
                    inputTokens: $0.inputTokens?.int64Value,
                    outputTokens: $0.outputTokens?.int64Value,
                    audioSeconds: $0.audioSeconds?.doubleValue
                )
            },
            operations: state.operations.map {
                UsageOperationItem(label: $0.label, costUsd: $0.costUsd, share: $0.share, callCount: Int($0.callCount))
            },
            caps: state.caps.map {
                UsageCaps(dailyUsd: $0.dailyUsd?.doubleValue, monthlyUsd: $0.monthlyUsd?.doubleValue, exhausted: $0.exhausted)
            },
            picked: state.picked.map { Int(truncating: $0) }
        )
    }

    private static func phase(_ phase: SharedSDK.AiUsagePhase) -> AiUsagePhase {
        switch phase {
        case .loading: .loading
        case .content: .content
        case .error: .error
        }
    }

    static func period(_ period: any SharedSDK.UsagePeriod) -> UsagePeriod {
        switch onEnum(of: period) {
        case .week: .week
        case .all: .all
        case .month(let month): .month(month.month)
        }
    }

    static func sharedPeriod(_ period: UsagePeriod) -> any SharedSDK.UsagePeriod {
        switch period {
        case .week: SharedSDK.UsagePeriodWeek.shared
        case .all: SharedSDK.UsagePeriodAll.shared
        case .month(let month): SharedSDK.UsagePeriodMonth(month: month)
        }
    }

    static func action(_ action: AiUsageAction) -> any SharedSDK.AiUsageAction {
        switch action {
        case .retry: SharedSDK.AiUsageActionRetry.shared
        case .selectPeriod(let period): SharedSDK.AiUsageActionSelectPeriod(period: sharedPeriod(period))
        case .pickPoint(let index): SharedSDK.AiUsageActionPickPoint(index: Int32(index))
        }
    }
}
