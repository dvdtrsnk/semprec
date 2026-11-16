import Foundation

// MARK: - Status
/// What a problem can be fixed with, from the problem's own button.
public enum SempIssueFix: Equatable, Sendable {

    case retry
    case disableAutomation
}

/// Where the link of a problem leads.
public enum SempIssueLink: Equatable, Sendable {

    case chat
    case thread
    case project
}

/// A problem that needs attention; `title` and `text` are the server's, in the person's language.
public struct SempIssue: Equatable, Identifiable, Sendable {

    public let id: String
    public let category: String
    public let critical: Bool
    public let title: String
    public let text: String
    public let since: String?
    public let mergedCount: Int
    public let projectName: String?
    public let fix: SempIssueFix?
    public let link: SempIssueLink?
    public let busy: Bool
    public let fixFailed: Bool

    public init(
        id: String,
        category: String,
        critical: Bool,
        title: String,
        text: String,
        since: String?,
        mergedCount: Int,
        projectName: String?,
        fix: SempIssueFix?,
        link: SempIssueLink?,
        busy: Bool,
        fixFailed: Bool
    ) {
        self.id = id
        self.category = category
        self.critical = critical
        self.title = title
        self.text = text
        self.since = since
        self.mergedCount = mergedCount
        self.projectName = projectName
        self.fix = fix
        self.link = link
        self.busy = busy
        self.fixFailed = fixFailed
    }
}

/// One service of Semp; `failingSince` is set while it has a problem.
public struct SempServiceRow: Equatable, Identifiable, Sendable {

    public var id: String { key }
    public let key: String
    public let name: String
    public let failingSince: String?
    public let lastActivityAt: String?

    public init(key: String, name: String, failingSince: String?, lastActivityAt: String?) {
        self.key = key
        self.name = name
        self.failingSince = failingSince
        self.lastActivityAt = lastActivityAt
    }
}

public struct SempResolvedRow: Equatable, Identifiable, Sendable {

    public let id: String
    public let title: String
    public let resolvedAt: String

    public init(id: String, title: String, resolvedAt: String) {
        self.id = id
        self.title = title
        self.resolvedAt = resolvedAt
    }
}

public struct SempStatusState: Equatable, Sendable {

    public var phase: SempPhase
    public var issues: [SempIssue]
    public var services: [SempServiceRow]
    public var resolved: [SempResolvedRow]
    public var historyOpen: Bool

    public init(
        phase: SempPhase,
        issues: [SempIssue] = [],
        services: [SempServiceRow] = [],
        resolved: [SempResolvedRow] = [],
        historyOpen: Bool = false
    ) {
        self.phase = phase
        self.issues = issues
        self.services = services
        self.resolved = resolved
        self.historyOpen = historyOpen
    }
}

public enum SempStatusAction: Equatable, Sendable {

    case retry
    case fix(issueId: String)
    case open(issueId: String)
    case toggleHistory
}

public enum SempStatusEffect: Equatable, Sendable {

    case openChat(threadId: String, messageId: String)
    case openThread(threadId: String)
    case openProject(projectId: String)
}

public typealias SempStatusScreenModel = ScreenModel<SempStatusState, SempStatusAction, SempStatusEffect>

/// Status screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedSempStatusScreenModel =
    ScriptedScreenModel<SempStatusState, SempStatusAction, SempStatusEffect>

// MARK: - Run
/// What a client shows as the state of a run.
public enum SempRunDisplay: Equatable, Sendable {

    case running
    case done
    case waitingApproval
    case error
}

public enum SempRunTriggerKind: Equatable, Sendable {

    case user
    case tick
    case mcp
    case supervisor
}

public enum SempRunStepKind: Equatable, Sendable {

    case start
    case plan
    case tool
    case approval
    case answer
    case end
    case error
}

/// What one model cost the run.
public struct SempUsageRow: Equatable, Identifiable, Sendable {

    public var id: String { modelName }
    public let modelName: String
    public let calls: Int
    public let inputTokens: Int64
    public let outputTokens: Int64
    public let costUsd: Double

    public init(modelName: String, calls: Int, inputTokens: Int64, outputTokens: Int64, costUsd: Double) {
        self.modelName = modelName
        self.calls = calls
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.costUsd = costUsd
    }
}

public struct SempRunView: Equatable, Sendable {

    public let id: String
    public let title: String
    public let display: SempRunDisplay
    public let trigger: SempRunTriggerKind
    public let threadId: String?
    public let projectName: String?
    public let startedAt: String
    public let durationMs: Int64?
    public let approvalCount: Int
    public let pendingApprovalCount: Int
    public let errorSummary: String?
    public let canRetry: Bool
    public let totalCostUsd: Double
    public let costIsEstimate: Bool
    public let usage: [SempUsageRow]

    public init(
        id: String,
        title: String,
        display: SempRunDisplay,
        trigger: SempRunTriggerKind,
        threadId: String?,
        projectName: String?,
        startedAt: String,
        durationMs: Int64?,
        approvalCount: Int,
        pendingApprovalCount: Int,
        errorSummary: String?,
        canRetry: Bool,
        totalCostUsd: Double,
        costIsEstimate: Bool,
        usage: [SempUsageRow]
    ) {
        self.id = id
        self.title = title
        self.display = display
        self.trigger = trigger
        self.threadId = threadId
        self.projectName = projectName
        self.startedAt = startedAt
        self.durationMs = durationMs
        self.approvalCount = approvalCount
        self.pendingApprovalCount = pendingApprovalCount
        self.errorSummary = errorSummary
        self.canRetry = canRetry
        self.totalCostUsd = totalCostUsd
        self.costIsEstimate = costIsEstimate
        self.usage = usage
    }
}

/// One step of the run; `title` and `summary` are the server's text in the person's language.
public struct SempRunStepRow: Equatable, Identifiable, Sendable {

    public let id: String
    public let kind: SempRunStepKind
    public let state: SempLineState
    public let title: String
    public let summary: String?
    public let time: String
    public let durationMs: Int64?

    public init(
        id: String,
        kind: SempRunStepKind,
        state: SempLineState,
        title: String,
        summary: String?,
        time: String,
        durationMs: Int64?
    ) {
        self.id = id
        self.kind = kind
        self.state = state
        self.title = title
        self.summary = summary
        self.time = time
        self.durationMs = durationMs
    }
}

public struct SempRunState: Equatable, Sendable {

    public var phase: SempPhase
    public var run: SempRunView?
    public var stepsPhase: SempStepsPhase
    public var steps: [SempRunStepRow]
    public var historyTruncated: Bool
    public var retrying: Bool
    public var retryFailed: Bool

    public init(
        phase: SempPhase,
        run: SempRunView? = nil,
        stepsPhase: SempStepsPhase = .loading,
        steps: [SempRunStepRow] = [],
        historyTruncated: Bool = false,
        retrying: Bool = false,
        retryFailed: Bool = false
    ) {
        self.phase = phase
        self.run = run
        self.stepsPhase = stepsPhase
        self.steps = steps
        self.historyTruncated = historyTruncated
        self.retrying = retrying
        self.retryFailed = retryFailed
    }
}

public enum SempRunAction: Equatable, Sendable {

    case retry
    case retryRun
    case openThread
    case openApprovals
}

public enum SempRunEffect: Equatable, Sendable {

    case openThread(threadId: String)
    case openApprovals
}

public typealias SempRunScreenModel = ScreenModel<SempRunState, SempRunAction, SempRunEffect>

/// Run screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedSempRunScreenModel = ScriptedScreenModel<SempRunState, SempRunAction, SempRunEffect>
