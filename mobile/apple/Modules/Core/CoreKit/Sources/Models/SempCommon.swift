import Foundation

/// How far a Semp screen has read what it shows: reading, shown, or failed with the reason (nil when it has none).
public enum SempPhase: Equatable, Sendable {

    case loading
    case ready
    case failure(FailureKind?)
}

/// What kind of object a person drops on the Semp bubble or an object a message is about; each has its own icon and
/// colour on screen.
public enum SempTargetKind: String, CaseIterable, Equatable, Hashable, Sendable {

    case task
    case event
    case mail
    case inbox
    case journal
    case project
    case area
    case person
    case company
    case file
    case note
    case recording
    case finance
    case health
    case recipe
    case book
    case movie
    case run
    case other
}

/// An object dropped on the bubble: what it is, how it is named, and how the server names it.
public struct SempTarget: Equatable, Sendable {

    public let kind: SempTargetKind
    public let title: String
    public let meta: String?
    public let itemId: String?
    public let databaseId: String?
    public let mailThreadId: String?
    public let runId: String?

    public init(
        kind: SempTargetKind,
        title: String,
        meta: String? = nil,
        itemId: String? = nil,
        databaseId: String? = nil,
        mailThreadId: String? = nil,
        runId: String? = nil
    ) {
        self.kind = kind
        self.title = title
        self.meta = meta
        self.itemId = itemId
        self.databaseId = databaseId
        self.mailThreadId = mailThreadId
        self.runId = runId
    }
}

/// An object attached to the next message to Semp.
public struct SempAttachment: Equatable, Identifiable, Sendable {

    public let id: String
    public let kind: SempTargetKind
    public let title: String
    public let meta: String?

    public init(id: String, kind: SempTargetKind, title: String, meta: String?) {
        self.id = id
        self.kind = kind
        self.title = title
        self.meta = meta
    }
}

/// How much an approval request can hurt, as the server classifies it.
public enum SempRisk: Equatable, Sendable {

    case irreversible
    case outbound
    case breaksLink
    case write
}

/// Where an approval request came from.
public enum SempOrigin: Equatable, Sendable {

    case chat
    case tick
    case mcp
}

/// Where an approval request stands. `approving` and `rejecting` are a decision on its way to the server.
public enum SempDecisionState: Equatable, Sendable {

    case pending
    case approving
    case rejecting
    case queued
    case executed
    case rejected
    case conflict
}

/// One approval request. The description is a template key with its parameters (names and counts); the app writes it
/// in its own words.
public struct SempApprovalItem: Equatable, Identifiable, Sendable {

    public let id: String
    public let descriptionKey: String?
    public let descriptionParams: [String: String]
    public let callLabel: String?
    public let argumentKeys: [String]
    public let risk: SempRisk
    public let origin: SempOrigin
    public let threadId: String?
    public let threadTitle: String?
    public let heartbeatName: String?
    public let projectName: String?
    public let requestedAt: String
    public let runId: String
    public let breaksLink: Bool
    public let decision: SempDecisionState
    public let conflictKey: String?
    public let decisionFailed: Bool
    public let decisionFailure: FailureKind?

    public init(
        id: String,
        descriptionKey: String? = nil,
        descriptionParams: [String: String] = [:],
        callLabel: String? = nil,
        argumentKeys: [String] = [],
        risk: SempRisk = .write,
        origin: SempOrigin = .chat,
        threadId: String? = nil,
        threadTitle: String? = nil,
        heartbeatName: String? = nil,
        projectName: String? = nil,
        requestedAt: String = "",
        runId: String = "",
        breaksLink: Bool = false,
        decision: SempDecisionState = .pending,
        conflictKey: String? = nil,
        decisionFailed: Bool = false,
        decisionFailure: FailureKind? = nil
    ) {
        self.id = id
        self.descriptionKey = descriptionKey
        self.descriptionParams = descriptionParams
        self.callLabel = callLabel
        self.argumentKeys = argumentKeys
        self.risk = risk
        self.origin = origin
        self.threadId = threadId
        self.threadTitle = threadTitle
        self.heartbeatName = heartbeatName
        self.projectName = projectName
        self.requestedAt = requestedAt
        self.runId = runId
        self.breaksLink = breaksLink
        self.decision = decision
        self.conflictKey = conflictKey
        self.decisionFailed = decisionFailed
        self.decisionFailure = decisionFailure
    }
}

/// How a step of a run stands.
public enum SempLineState: Equatable, Sendable {

    case running
    case ok
    case error
    case waitingApproval
}

public enum SempStepsPhase: Equatable, Sendable {

    case none
    case loading
    case ready
    case error
}
