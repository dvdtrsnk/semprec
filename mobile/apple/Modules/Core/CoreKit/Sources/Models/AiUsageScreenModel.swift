import Foundation

public enum AiUsagePhase: Equatable, Sendable {

    case loading
    case content
    case error
}

/// The time the spend is shown for: the last seven days, the whole account, or one calendar month (`2026-10`).
public enum UsagePeriod: Equatable, Hashable, Sendable {

    case week
    case all
    case month(String)
}

/// The cost of one bar: a day (`2026-10-21`) or, for the whole account, a month (`2026-10`).
public struct UsagePointItem: Equatable, Sendable {

    public let key: String
    public let costUsd: Double

    public init(key: String, costUsd: Double) {
        self.key = key
        self.costUsd = costUsd
    }
}

public struct UsageModelItem: Equatable, Sendable {

    public let name: String
    public let costUsd: Double
    public let callCount: Int
    public let inputTokens: Int64?
    public let outputTokens: Int64?
    public let audioSeconds: Double?

    public init(
        name: String,
        costUsd: Double,
        callCount: Int,
        inputTokens: Int64?,
        outputTokens: Int64?,
        audioSeconds: Double?
    ) {
        self.name = name
        self.costUsd = costUsd
        self.callCount = callCount
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.audioSeconds = audioSeconds
    }
}

public struct UsageOperationItem: Equatable, Sendable {

    public let label: String
    public let costUsd: Double
    public let share: Double
    public let callCount: Int

    public init(label: String, costUsd: Double, share: Double, callCount: Int) {
        self.label = label
        self.costUsd = costUsd
        self.share = share
        self.callCount = callCount
    }
}

/// The caps of the server; a cap that is not set is nil.
public struct UsageCaps: Equatable, Sendable {

    public let dailyUsd: Double?
    public let monthlyUsd: Double?
    public let exhausted: Bool

    public init(dailyUsd: Double?, monthlyUsd: Double?, exhausted: Bool) {
        self.dailyUsd = dailyUsd
        self.monthlyUsd = monthlyUsd
        self.exhausted = exhausted
    }
}

/// The AI spend of a period; `picked` is the index of the bar the person tapped.
public struct AiUsageState: Equatable, Sendable {

    public var phase: AiUsagePhase
    public var failure: FailureKind?
    public var periods: [UsagePeriod]
    public var period: UsagePeriod
    public var accountStartedAt: String?
    public var totalUsd: Double
    public var estimated: Bool
    public var points: [UsagePointItem]
    public var models: [UsageModelItem]
    public var operations: [UsageOperationItem]
    public var caps: UsageCaps?
    public var picked: Int?

    public init(
        phase: AiUsagePhase = .loading,
        failure: FailureKind? = nil,
        periods: [UsagePeriod] = [],
        period: UsagePeriod = .week,
        accountStartedAt: String? = nil,
        totalUsd: Double = 0,
        estimated: Bool = false,
        points: [UsagePointItem] = [],
        models: [UsageModelItem] = [],
        operations: [UsageOperationItem] = [],
        caps: UsageCaps? = nil,
        picked: Int? = nil
    ) {
        self.phase = phase
        self.failure = failure
        self.periods = periods
        self.period = period
        self.accountStartedAt = accountStartedAt
        self.totalUsd = totalUsd
        self.estimated = estimated
        self.points = points
        self.models = models
        self.operations = operations
        self.caps = caps
        self.picked = picked
    }
}

public enum AiUsageAction: Equatable, Sendable {

    case retry
    case selectPeriod(UsagePeriod)
    case pickPoint(Int)
}

/// The usage screen has no effects: a choice is a state change.
public typealias AiUsageScreenModel = ScreenModel<AiUsageState, AiUsageAction, Never>

/// Usage screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedAiUsageScreenModel = ScriptedScreenModel<AiUsageState, AiUsageAction, Never>
