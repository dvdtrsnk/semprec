import Foundation

/// Which thread a chat screen opens on: the latest chat, a new one, a given thread, or the thread of an Inbox item.
public enum SempThreadStart: Equatable, Hashable, Sendable {

    case latest
    case new
    case existing
    case item
}

/// What kind of thread the screen shows.
public enum SempThreadType: Equatable, Sendable {

    case chat
    case item
    case tick
}

public enum SempEntryRole: Equatable, Sendable {

    case user
    case assistant
    case system
}

/// A message of the person that has not reached the server (`sending`) or did not (`failed`).
public enum SempDelivery: Equatable, Sendable {

    case sending
    case failed
}

/// Where a reply is. The server does not stream, so the chat asks again until a reply is `done` or `failed`.
public enum SempReplyPhase: Equatable, Sendable {

    case thinking
    case working
    case done
    case failed
}

/// An object a message was about; `label` is nil when the server no longer knows it.
public struct SempChip: Equatable, Sendable {

    public let kind: SempTargetKind
    public let label: String?
    public let exists: Bool

    public init(kind: SempTargetKind, label: String?, exists: Bool = true) {
        self.kind = kind
        self.label = label
        self.exists = exists
    }
}

public enum SempChangeType: Equatable, Sendable {

    case created
    case updated
    case deleted
    case restored
    case revised
}

/// An item a reply changed.
public struct SempChangeCard: Equatable, Identifiable, Sendable {

    public var id: String { itemId }
    public let itemId: String
    public let databaseId: String
    public let databaseKey: String?
    public let kind: SempTargetKind
    public let change: SempChangeType
    public let label: String?
    public let active: Bool

    public init(
        itemId: String,
        databaseId: String,
        databaseKey: String?,
        kind: SempTargetKind,
        change: SempChangeType,
        label: String?,
        active: Bool
    ) {
        self.itemId = itemId
        self.databaseId = databaseId
        self.databaseKey = databaseKey
        self.kind = kind
        self.change = change
        self.label = label
        self.active = active
    }
}

/// One line of an opened run; `title` and `summary` are the server's text in the person's language.
public struct SempStepLine: Equatable, Identifiable, Sendable {

    public let id: String
    public let state: SempLineState
    public let title: String
    public let summary: String?
    public let durationMs: Int64?

    public init(id: String, state: SempLineState, title: String, summary: String?, durationMs: Int64?) {
        self.id = id
        self.state = state
        self.title = title
        self.summary = summary
        self.durationMs = durationMs
    }
}

public enum SempRunChipState: Equatable, Sendable {

    case ok
    case waitingApproval
    case failed
}

/// What Semp did for one reply, which opens into its steps.
public struct SempRunChip: Equatable, Sendable {

    public let runId: String
    public let messageId: String
    public let stepCount: Int
    public let durationMs: Int64
    public let state: SempRunChipState
    public let expanded: Bool
    public let stepsPhase: SempStepsPhase
    public let steps: [SempStepLine]

    public init(
        runId: String,
        messageId: String,
        stepCount: Int,
        durationMs: Int64,
        state: SempRunChipState,
        expanded: Bool,
        stepsPhase: SempStepsPhase,
        steps: [SempStepLine]
    ) {
        self.runId = runId
        self.messageId = messageId
        self.stepCount = stepCount
        self.durationMs = durationMs
        self.state = state
        self.expanded = expanded
        self.stepsPhase = stepsPhase
        self.steps = steps
    }
}

/// Why a reply failed: the server's closed code and its text in the person's language.
public struct SempReplyFailure: Equatable, Sendable {

    public let code: String
    public let message: String?

    public init(code: String, message: String?) {
        self.code = code
        self.message = message
    }
}

/// One line of the conversation. `text` of an assistant message is Markdown.
public struct SempEntry: Equatable, Identifiable, Sendable {

    public let id: String
    public let role: SempEntryRole
    public let text: String?
    public let systemKey: String?
    public let chips: [SempChip]
    public let delivery: SempDelivery?
    public let deliveryFailure: FailureKind?
    public let replyPhase: SempReplyPhase
    public let run: SempRunChip?
    public let changes: [SempChangeCard]
    public let approvals: [SempApprovalItem]
    public let failure: SempReplyFailure?
    public let incomplete: Bool
    public let canRegenerate: Bool

    public init(
        id: String,
        role: SempEntryRole,
        text: String?,
        systemKey: String? = nil,
        chips: [SempChip] = [],
        delivery: SempDelivery? = nil,
        deliveryFailure: FailureKind? = nil,
        replyPhase: SempReplyPhase = .done,
        run: SempRunChip? = nil,
        changes: [SempChangeCard] = [],
        approvals: [SempApprovalItem] = [],
        failure: SempReplyFailure? = nil,
        incomplete: Bool = false,
        canRegenerate: Bool = false
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.systemKey = systemKey
        self.chips = chips
        self.delivery = delivery
        self.deliveryFailure = deliveryFailure
        self.replyPhase = replyPhase
        self.run = run
        self.changes = changes
        self.approvals = approvals
        self.failure = failure
        self.incomplete = incomplete
        self.canRegenerate = canRegenerate
    }
}

/// The automatic task behind a tick thread.
public struct SempTickInfo: Equatable, Sendable {

    public let name: String
    public let projectName: String?
    public let enabled: Bool
    public let canTrigger: Bool
    public let running: Bool
    public let triggerFailed: Bool

    public init(
        name: String,
        projectName: String?,
        enabled: Bool,
        canTrigger: Bool,
        running: Bool,
        triggerFailed: Bool
    ) {
        self.name = name
        self.projectName = projectName
        self.enabled = enabled
        self.canTrigger = canTrigger
        self.running = running
        self.triggerFailed = triggerFailed
    }
}

/// The object an Inbox item thread is about, as the thing that opened it named it.
public struct SempSubject: Equatable, Sendable {

    public let title: String?
    public let meta: String?

    public init(title: String?, meta: String?) {
        self.title = title
        self.meta = meta
    }
}

/// The notice of a problem with Semp, above the conversation until it is closed.
public struct SempNotice: Equatable, Identifiable, Sendable {

    public let id: String
    public let title: String
    public let text: String

    public init(id: String, title: String, text: String) {
        self.id = id
        self.title = title
        self.text = text
    }
}

public struct SempThreadState: Equatable, Sendable {

    public var phase: SempPhase
    public var type: SempThreadType
    public var threadId: String?
    public var title: String?
    public var subject: SempSubject?
    public var tick: SempTickInfo?
    public var entries: [SempEntry]
    public var hasOlder: Bool
    public var loadingOlder: Bool
    public var attachments: [SempAttachment]
    public var canAttach: Bool
    public var sending: Bool
    public var notice: SempNotice?
    public var actionFailure: Failed?

    public init(
        phase: SempPhase,
        type: SempThreadType = .chat,
        threadId: String? = nil,
        title: String? = nil,
        subject: SempSubject? = nil,
        tick: SempTickInfo? = nil,
        entries: [SempEntry] = [],
        hasOlder: Bool = false,
        loadingOlder: Bool = false,
        attachments: [SempAttachment] = [],
        canAttach: Bool = true,
        sending: Bool = false,
        notice: SempNotice? = nil,
        actionFailure: Failed? = nil
    ) {
        self.phase = phase
        self.type = type
        self.threadId = threadId
        self.title = title
        self.subject = subject
        self.tick = tick
        self.entries = entries
        self.hasOlder = hasOlder
        self.loadingOlder = loadingOlder
        self.attachments = attachments
        self.canAttach = canAttach
        self.sending = sending
        self.notice = notice
        self.actionFailure = actionFailure
    }
}

public enum SempThreadAction: Equatable, Sendable {

    case retry
    case refresh
    case send(String)
    /// Sends a message that did not reach the server again, or drops it.
    case resolveUnsent(id: String, retry: Bool)
    /// Asks the server for the reply again: a failed reply is retried, an answer is written again.
    case askAgain(messageId: String, regenerate: Bool)
    case toggleRun(messageId: String)
    case decide(approvalId: String, approve: Bool)
    case loadOlder
    case runAgain
    case dismissNotice
    case dismissFailure
    case removeAttachment(key: String)
    case openRun(runId: String, messageId: String?)
    case openChange(itemId: String, databaseKey: String?)
    case openApprovals
    case openStatus
    case openHistory
    case openNewChat
}

public enum SempThreadEffect: Equatable, Sendable {

    case openRun(runId: String, messageId: String?)
    case openItem(itemId: String, databaseKey: String?)
    case openApprovals
    case openStatus
    case openHistory
    case openNewChat
}

public typealias SempThreadScreenModel = ScreenModel<SempThreadState, SempThreadAction, SempThreadEffect>

/// Thread screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedSempThreadScreenModel =
    ScriptedScreenModel<SempThreadState, SempThreadAction, SempThreadEffect>
