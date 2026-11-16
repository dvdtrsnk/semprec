@preconcurrency internal import SharedSDK

extension SempThreadStart {

    var shared: SharedSDK.SempThreadStart {
        switch self {
        case .latest: .latest
        case .new: .theNew
        case .existing: .existing
        case .item: .item
        }
    }
}

extension SempThreadType {

    init(_ type: SharedSDK.SempThreadType) {
        switch type {
        case .chat: self = .chat
        case .item: self = .item
        case .tick: self = .tick
        }
    }
}

extension SempEntryRole {

    init(_ role: SharedSDK.SempEntryRole) {
        switch role {
        case .user: self = .user
        case .assistant: self = .assistant
        case .system: self = .system
        }
    }
}

extension SempDelivery {

    init(_ delivery: SharedSDK.SempDelivery) {
        switch delivery {
        case .sending: self = .sending
        case .failed: self = .failed
        }
    }
}

extension SempReplyPhase {

    init(_ phase: SharedSDK.SempReplyPhase) {
        switch phase {
        case .thinking: self = .thinking
        case .working: self = .working
        case .done: self = .done
        case .failed: self = .failed
        }
    }
}

extension SempChip {

    init(_ chip: SharedSDK.SempChip) {
        self.init(kind: SempTargetKind(chip.kind), label: chip.label, exists: chip.exists)
    }
}

extension SempChangeType {

    init(_ type: SharedSDK.SempChangeType) {
        switch type {
        case .created: self = .created
        case .updated: self = .updated
        case .deleted: self = .deleted
        case .restored: self = .restored
        case .revised: self = .revised
        }
    }
}

extension SempChangeCard {

    init(_ card: SharedSDK.SempChangeCard) {
        self.init(
            itemId: card.itemId,
            databaseId: card.databaseId,
            databaseKey: card.databaseKey,
            kind: SempTargetKind(card.kind),
            change: SempChangeType(card.change),
            label: card.label,
            active: card.active
        )
    }
}

extension SempStepLine {

    init(_ line: SharedSDK.SempStepLine) {
        self.init(
            id: line.id,
            state: SempLineState(line.state),
            title: line.title,
            summary: line.summary,
            durationMs: line.durationMs?.int64Value
        )
    }
}

extension SempRunChipState {

    init(_ state: SharedSDK.SempRunChipState) {
        switch state {
        case .ok: self = .ok
        case .waitingApproval: self = .waitingApproval
        case .failed: self = .failed
        }
    }
}

extension SempRunChip {

    init(_ chip: SharedSDK.SempRunChip) {
        self.init(
            runId: chip.runId,
            messageId: chip.messageId,
            stepCount: Int(chip.stepCount),
            durationMs: chip.durationMs,
            state: SempRunChipState(chip.state),
            expanded: chip.expanded,
            stepsPhase: SempStepsPhase(chip.stepsPhase),
            steps: chip.steps.map(SempStepLine.init)
        )
    }
}

extension SempEntry {

    init(_ entry: SharedSDK.SempEntry) {
        self.init(
            id: entry.id,
            role: SempEntryRole(entry.role),
            text: entry.text,
            systemKey: entry.systemKey,
            chips: entry.chips.map(SempChip.init),
            delivery: entry.delivery.map(SempDelivery.init),
            deliveryFailure: entry.deliveryFailure.map(FailureKind.init),
            replyPhase: SempReplyPhase(entry.replyPhase),
            run: entry.run.map(SempRunChip.init),
            changes: entry.changes.map(SempChangeCard.init),
            approvals: entry.approvals.map(SempApprovalItem.init),
            failure: entry.failure.map { SempReplyFailure(code: $0.code, message: $0.message) },
            incomplete: entry.incomplete,
            canRegenerate: entry.canRegenerate
        )
    }
}

extension SempTickInfo {

    init(_ info: SharedSDK.SempTickInfo) {
        self.init(
            name: info.name,
            projectName: info.projectName,
            enabled: info.enabled,
            canTrigger: info.canTrigger,
            running: info.running,
            triggerFailed: info.triggerFailed
        )
    }
}
