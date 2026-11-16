@preconcurrency internal import SharedSDK

// MARK: - Phases
extension SempPhase {

    init(_ phase: SharedSDK.SempThreadPhase, failure: SharedSDK.FailureKind?) {
        switch phase {
        case .loading: self = .loading
        case .ready: self = .ready
        case .error: self = .failure(failure.map(FailureKind.init))
        }
    }

    init(_ phase: SharedSDK.SempChatsPhase, failure: SharedSDK.FailureKind?) {
        switch phase {
        case .loading: self = .loading
        case .ready: self = .ready
        case .error: self = .failure(failure.map(FailureKind.init))
        }
    }

    init(_ phase: SharedSDK.SempStatusPhase, failure: SharedSDK.FailureKind?) {
        switch phase {
        case .loading: self = .loading
        case .ready: self = .ready
        case .error: self = .failure(failure.map(FailureKind.init))
        }
    }

    init(_ phase: SharedSDK.SempRunPhase, failure: SharedSDK.FailureKind?) {
        switch phase {
        case .loading: self = .loading
        case .ready: self = .ready
        case .error: self = .failure(failure.map(FailureKind.init))
        }
    }

    init(_ phase: SharedSDK.SempApprovalsPhase, failure: SharedSDK.FailureKind?) {
        switch phase {
        case .loading: self = .loading
        case .ready: self = .ready
        case .error: self = .failure(failure.map(FailureKind.init))
        }
    }

    init(_ phase: SharedSDK.SempAgentPhase, failure: SharedSDK.FailureKind?) {
        switch phase {
        case .loading: self = .loading
        case .ready: self = .ready
        case .error: self = .failure(failure.map(FailureKind.init))
        }
    }
}

// MARK: - Targets
extension SempTargetKind {

    init(_ kind: SharedSDK.SempTargetKind) {
        switch kind {
        case .task: self = .task
        case .event: self = .event
        case .mail: self = .mail
        case .inbox: self = .inbox
        case .journal: self = .journal
        case .project: self = .project
        case .area: self = .area
        case .person: self = .person
        case .company: self = .company
        case .file: self = .file
        case .note: self = .note
        case .recording: self = .recording
        case .finance: self = .finance
        case .health: self = .health
        case .recipe: self = .recipe
        case .book: self = .book
        case .movie: self = .movie
        case .run: self = .run
        case .other: self = .other
        }
    }

    var shared: SharedSDK.SempTargetKind {
        switch self {
        case .task: .task
        case .event: .event
        case .mail: .mail
        case .inbox: .inbox
        case .journal: .journal
        case .project: .project
        case .area: .area
        case .person: .person
        case .company: .company
        case .file: .file
        case .note: .note
        case .recording: .recording
        case .finance: .finance
        case .health: .health
        case .recipe: .recipe
        case .book: .book
        case .movie: .movie
        case .run: .run
        case .other: .other
        }
    }
}

extension SempTarget {

    var shared: SharedSDK.SempTarget {
        SharedSDK.SempTarget(
            kind: kind.shared,
            title: title,
            meta: meta,
            itemId: itemId,
            databaseId: databaseId,
            mailThreadId: mailThreadId,
            runId: runId
        )
    }
}

extension SempAttachment {

    init(_ attachment: SharedSDK.SempAttachment) {
        self.init(
            id: attachment.key,
            kind: SempTargetKind(attachment.kind),
            title: attachment.title,
            meta: attachment.meta
        )
    }
}

// MARK: - Approvals
extension SempApprovalItem {

    init(_ item: SharedSDK.SempApprovalItem) {
        self.init(
            id: item.id,
            descriptionKey: item.descriptionKey,
            descriptionParams: item.descriptionParams,
            callLabel: item.callLabel,
            argumentKeys: item.argumentKeys,
            risk: SempRisk(item.risk),
            origin: SempOrigin(item.origin),
            threadId: item.threadId,
            threadTitle: item.threadTitle,
            heartbeatName: item.heartbeatName,
            projectName: item.projectName,
            requestedAt: item.requestedAt,
            runId: item.runId,
            breaksLink: item.breaksLink,
            decision: SempDecisionState(item.decision),
            conflictKey: item.conflictKey,
            decisionFailed: item.decisionFailed,
            decisionFailure: item.decisionFailure.map(FailureKind.init)
        )
    }
}

extension SempRisk {

    init(_ risk: SharedSDK.SempRisk) {
        switch risk {
        case .irreversible: self = .irreversible
        case .outbound: self = .outbound
        case .breaksLink: self = .breaksLink
        case .write: self = .write
        }
    }
}

extension SempOrigin {

    init(_ origin: SharedSDK.SempOrigin) {
        switch origin {
        case .chat: self = .chat
        case .tick: self = .tick
        case .mcp: self = .mcp
        }
    }
}

extension SempDecisionState {

    init(_ state: SharedSDK.SempDecisionState) {
        switch state {
        case .pending: self = .pending
        case .approving: self = .approving
        case .rejecting: self = .rejecting
        case .queued: self = .queued
        case .executed: self = .executed
        case .rejected: self = .rejected
        case .conflict: self = .conflict
        }
    }
}

// MARK: - Steps and runs
extension SempLineState {

    init(_ state: SharedSDK.SempLineState) {
        switch state {
        case .running: self = .running
        case .ok: self = .ok
        case .error: self = .error
        case .waitingApproval: self = .waitingApproval
        }
    }
}

extension SempStepsPhase {

    init(_ phase: SharedSDK.SempStepsPhase) {
        switch phase {
        case .none: self = .none
        case .loading: self = .loading
        case .ready: self = .ready
        case .error: self = .error
        }
    }
}

extension SempRunDisplay {

    init(_ display: SharedSDK.SempRunDisplay) {
        switch display {
        case .running: self = .running
        case .done: self = .done
        case .waitingApproval: self = .waitingApproval
        case .error: self = .error
        }
    }
}

extension SempRunTriggerKind {

    init(_ trigger: SharedSDK.SempRunTriggerKind) {
        switch trigger {
        case .user: self = .user
        case .tick: self = .tick
        case .mcp: self = .mcp
        case .supervisor: self = .supervisor
        }
    }
}
