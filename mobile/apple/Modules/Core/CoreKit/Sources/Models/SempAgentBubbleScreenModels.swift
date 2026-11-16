import Foundation

// MARK: - Project agent
/// Where the saving of the instructions stands. `conflict` is a save that met newer instructions and took them.
public enum SempSaveState: Equatable, Sendable {

    case idle
    case saving
    case saved
    case failed
    case conflict
}

/// The four parts of the project's instructions (AGENT.md).
public enum SempSection: Equatable, CaseIterable, Sendable {

    case purpose
    case allowed
    case notAllowed
    case general
}

public struct SempSections: Equatable, Sendable {

    public var purpose: String
    public var allowed: String
    public var notAllowed: String
    public var general: String

    public init(purpose: String, allowed: String, notAllowed: String, general: String) {
        self.purpose = purpose
        self.allowed = allowed
        self.notAllowed = notAllowed
        self.general = general
    }

    public func text(of section: SempSection) -> String {
        switch section {
        case .purpose: purpose
        case .allowed: allowed
        case .notAllowed: notAllowed
        case .general: general
        }
    }
}

public enum SempFindingKind: Equatable, Sendable {

    case permission
    case behavior
}

/// Something Semp does, or is told, that the instructions do not agree with.
public struct SempFinding: Equatable, Identifiable, Sendable {

    public let id: String
    public let kind: SempFindingKind
    public let claim: String
    public let blocking: Bool
    public let canAllow: Bool
    public let canForbid: Bool

    public init(id: String, kind: SempFindingKind, claim: String, blocking: Bool, canAllow: Bool, canForbid: Bool) {
        self.id = id
        self.kind = kind
        self.claim = claim
        self.blocking = blocking
        self.canAllow = canAllow
        self.canForbid = canForbid
    }
}

public struct SempToolRow: Equatable, Identifiable, Sendable {

    public var id: String { registrationId }
    public let registrationId: String
    public let label: String
    public let requiresApproval: Bool
    public let granted: Bool

    public init(registrationId: String, label: String, requiresApproval: Bool, granted: Bool) {
        self.registrationId = registrationId
        self.label = label
        self.requiresApproval = requiresApproval
        self.granted = granted
    }
}

public struct SempToolServer: Equatable, Identifiable, Sendable {

    public let id: String
    public let name: String
    public let online: Bool
    public let tools: [SempToolRow]

    public init(id: String, name: String, online: Bool, tools: [SempToolRow]) {
        self.id = id
        self.name = name
        self.online = online
        self.tools = tools
    }
}

/// An automatic task of the project; `lastErrorSummary` is the server's text when the last run failed.
public struct SempTaskRow: Equatable, Identifiable, Sendable {

    public let id: String
    public let name: String
    public let ruleLabel: String
    public let enabled: Bool
    public let threadId: String?
    public let lastAt: String?
    public let lastFailed: Bool
    public let lastWaiting: Bool
    public let lastErrorSummary: String?

    public init(
        id: String,
        name: String,
        ruleLabel: String,
        enabled: Bool,
        threadId: String?,
        lastAt: String?,
        lastFailed: Bool,
        lastWaiting: Bool,
        lastErrorSummary: String?
    ) {
        self.id = id
        self.name = name
        self.ruleLabel = ruleLabel
        self.enabled = enabled
        self.threadId = threadId
        self.lastAt = lastAt
        self.lastFailed = lastFailed
        self.lastWaiting = lastWaiting
        self.lastErrorSummary = lastErrorSummary
    }
}

/// One run of the project's agent; `messageId` is set for one answer of a chat run.
public struct SempAgentRunRow: Equatable, Identifiable, Sendable {

    public let id: String
    public let runId: String
    public let messageId: String?
    public let title: String
    public let trigger: SempRunTriggerKind
    public let startedAt: String
    public let durationMs: Int64?
    public let costUsd: Double
    public let display: SempRunDisplay
    public let errorSummary: String?

    public init(
        id: String,
        runId: String,
        messageId: String?,
        title: String,
        trigger: SempRunTriggerKind,
        startedAt: String,
        durationMs: Int64?,
        costUsd: Double,
        display: SempRunDisplay,
        errorSummary: String?
    ) {
        self.id = id
        self.runId = runId
        self.messageId = messageId
        self.title = title
        self.trigger = trigger
        self.startedAt = startedAt
        self.durationMs = durationMs
        self.costUsd = costUsd
        self.display = display
        self.errorSummary = errorSummary
    }
}

public struct SempProjectAgentState: Equatable, Sendable {

    public var phase: SempPhase
    public var projectName: String?
    public var sections: SempSections
    public var saveState: SempSaveState
    public var finding: SempFinding?
    public var servers: [SempToolServer]
    public var tasks: [SempTaskRow]
    public var runs: [SempAgentRunRow]
    public var partialFailure: Bool
    public var changeFailed: Bool

    public init(
        phase: SempPhase,
        projectName: String? = nil,
        sections: SempSections = SempSections(purpose: "", allowed: "", notAllowed: "", general: ""),
        saveState: SempSaveState = .idle,
        finding: SempFinding? = nil,
        servers: [SempToolServer] = [],
        tasks: [SempTaskRow] = [],
        runs: [SempAgentRunRow] = [],
        partialFailure: Bool = false,
        changeFailed: Bool = false
    ) {
        self.phase = phase
        self.projectName = projectName
        self.sections = sections
        self.saveState = saveState
        self.finding = finding
        self.servers = servers
        self.tasks = tasks
        self.runs = runs
        self.partialFailure = partialFailure
        self.changeFailed = changeFailed
    }
}

public enum SempDriftAnswer: Equatable, Sendable {

    case allow
    case forbid
    case dismiss
}

public enum SempProjectAgentAction: Equatable, Sendable {

    case retry
    case saveSection(SempSection, text: String)
    case retrySave
    case resolveDrift(SempDriftAnswer)
    case setTool(registrationId: String, granted: Bool)
    case setTask(taskId: String, enabled: Bool)
    case openTask(taskId: String)
    case openRun(rowId: String)
    case dismissFailure
}

public enum SempProjectAgentEffect: Equatable, Sendable {

    case openThread(threadId: String)
    case openRun(runId: String, messageId: String?)
}

public typealias SempProjectAgentScreenModel =
    ScreenModel<SempProjectAgentState, SempProjectAgentAction, SempProjectAgentEffect>

/// Project agent screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedSempProjectAgentScreenModel =
    ScriptedScreenModel<SempProjectAgentState, SempProjectAgentAction, SempProjectAgentEffect>

// MARK: - Bubble
/// What the bubble tells the person after an object was dropped on it.
public enum SempBubbleToast: Equatable, Sendable {

    case added
    case alreadyAdded
    case cannotAdd
    case newThread
    case continueThread
}

public struct SempBubbleState: Equatable, Sendable {

    public var badge: Int
    public var attachments: Int
    public var toast: SempBubbleToast?

    public init(badge: Int = 0, attachments: Int = 0, toast: SempBubbleToast? = nil) {
        self.badge = badge
        self.attachments = attachments
        self.toast = toast
    }
}

public enum SempBubbleAction: Equatable, Sendable {

    case refresh
    case drop(SempTarget)
}

public enum SempBubbleEffect: Equatable, Sendable {

    /// The dropped Inbox item gets a thread of its own, which the chat opens on.
    case openItemThread(inboxItemId: String, title: String, meta: String?)
}

public typealias SempBubbleScreenModel = ScreenModel<SempBubbleState, SempBubbleAction, SempBubbleEffect>

/// Bubble screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedSempBubbleScreenModel = ScriptedScreenModel<SempBubbleState, SempBubbleAction, SempBubbleEffect>
