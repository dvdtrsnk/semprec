import Foundation

/// The kind of a card, which decides how it is presented.
public enum InboxCardType: Equatable, Sendable {

    case task, event, page, journal, project, company, person, health, file, recording, mcp
    case invalid, clarify, transcriptEvent, speaker, approval, unsupported
}

/// Where a card stands; `pending` is the only phase of an approval of Semp.
public enum InboxCardPhase: Equatable, Sendable {

    case proposed, computing, computeFailed, needsClarification, invalid, pending
}

/// Whether a card may be approved now, and if not, why.
public enum InboxApprovable: Equatable, Sendable {

    case ready, missingFields, computing, computeFailed, invalid, unsupported
}

public enum InboxFieldType: Equatable, Sendable {

    case text, area, date, datetime, select, multi, toggle, seg, color, secret, info, choice, tile
}

public enum InboxKeyboard: Equatable, Sendable {

    case text, email, url, tel
}

public enum InboxRiskLevel: Equatable, Sendable {

    case irreversible, outbound, breaksLink, write
}

public enum InboxOriginKind: Equatable, Sendable {

    case capture, transcript, run
}

/// What went wrong that the person should hear about.
public enum InboxProblem: Equatable, Sendable {

    case edit, decision, undo, recompute
}

public enum InboxPickerPhase: Equatable, Sendable {

    case loading, ready, error
}

/// One choice of a picker, a segmented control, a colour row or a list of choices. `id` is nil for the "none" choice;
/// `label` is empty for a static option whose text the screen knows by its `id`.
public struct InboxChoice: Equatable, Sendable, Identifiable {

    public let id: String?
    public let label: String
    public let color: String?
    public let initials: String?
    public let hint: String?
    public let date: String?
    public let timeFrom: String?
    public let timeTo: String?
    public let selected: Bool
    public let disabled: Bool
    public let suggested: Bool
    public let none: Bool
    public let isNew: Bool

    /// Unique within one control, which lists a choice once.
    public var identity: String { id ?? "none" }

    public init(
        id: String?,
        label: String = "",
        color: String? = nil,
        initials: String? = nil,
        hint: String? = nil,
        date: String? = nil,
        timeFrom: String? = nil,
        timeTo: String? = nil,
        selected: Bool = false,
        disabled: Bool = false,
        suggested: Bool = false,
        none: Bool = false,
        isNew: Bool = false
    ) {
        self.id = id
        self.label = label
        self.color = color
        self.initials = initials
        self.hint = hint
        self.date = date
        self.timeFrom = timeFrom
        self.timeTo = timeTo
        self.selected = selected
        self.disabled = disabled
        self.suggested = suggested
        self.none = none
        self.isNew = isNew
    }
}

/// One control of a card and what it holds; which members matter follows `type`.
public struct InboxField: Equatable, Sendable, Identifiable {

    public let key: String
    public let type: InboxFieldType
    public let keyboard: InboxKeyboard
    public let label: String
    public let placeholder: String?
    public let required: Bool
    public let missing: Bool
    public let edited: Bool
    public let text: String
    public let flag: Bool
    public let date: String?
    public let time: String?
    public let showTime: Bool
    public let selected: [InboxChoice]
    public let options: [InboxChoice]
    public let needsPicker: Bool
    public let info: String?

    public var id: String { key }

    public init(
        key: String,
        type: InboxFieldType,
        keyboard: InboxKeyboard = .text,
        label: String = "",
        placeholder: String? = nil,
        required: Bool = false,
        missing: Bool = false,
        edited: Bool = false,
        text: String = "",
        flag: Bool = false,
        date: String? = nil,
        time: String? = nil,
        showTime: Bool = false,
        selected: [InboxChoice] = [],
        options: [InboxChoice] = [],
        needsPicker: Bool = false,
        info: String? = nil
    ) {
        self.key = key
        self.type = type
        self.keyboard = keyboard
        self.label = label
        self.placeholder = placeholder
        self.required = required
        self.missing = missing
        self.edited = edited
        self.text = text
        self.flag = flag
        self.date = date
        self.time = time
        self.showTime = showTime
        self.selected = selected
        self.options = options
        self.needsPicker = needsPicker
        self.info = info
    }
}

public struct InboxGroup: Equatable, Sendable, Identifiable {

    public let key: String
    public let fields: [InboxField]

    public var id: String { key }

    public init(key: String, fields: [InboxField]) {
        self.key = key
        self.fields = fields
    }
}

/// What a card was made from; which members matter follows `kind`.
public struct InboxOrigin: Equatable, Sendable {

    public let kind: InboxOriginKind
    public let text: String?
    public let date: String?
    public let time: String?
    public let typeLabel: String?
    public let typeEmoji: String?
    public let name: String?
    public let sourceKind: String?
    public let threadTitle: String?
    public let heartbeatName: String?
    public let mcpClientName: String?

    public init(
        kind: InboxOriginKind,
        text: String? = nil,
        date: String? = nil,
        time: String? = nil,
        typeLabel: String? = nil,
        typeEmoji: String? = nil,
        name: String? = nil,
        sourceKind: String? = nil,
        threadTitle: String? = nil,
        heartbeatName: String? = nil,
        mcpClientName: String? = nil
    ) {
        self.kind = kind
        self.text = text
        self.date = date
        self.time = time
        self.typeLabel = typeLabel
        self.typeEmoji = typeEmoji
        self.name = name
        self.sourceKind = sourceKind
        self.threadTitle = threadTitle
        self.heartbeatName = heartbeatName
        self.mcpClientName = mcpClientName
    }
}

/// What an approval request of Semp asks for.
public struct InboxApproval: Equatable, Sendable {

    public let risk: InboxRiskLevel
    public let operation: String
    public let reason: String?

    public init(risk: InboxRiskLevel, operation: String, reason: String?) {
        self.risk = risk
        self.operation = operation
        self.reason = reason
    }
}

/// One card of the stack.
public struct InboxCard: Equatable, Sendable, Identifiable {

    public let id: String
    public let type: InboxCardType
    public let baseType: InboxCardType
    public let phase: InboxCardPhase
    public let approvable: InboxApprovable
    public let origin: InboxOrigin?
    public let targets: [String]
    public let invalidText: String?
    public let invalidField: String?
    public let approval: InboxApproval?
    public let groups: [InboxGroup]
    public let quotes: [String]
    public let reason: String?
    public let edited: Bool
    public let saving: Bool

    public init(
        id: String,
        type: InboxCardType,
        baseType: InboxCardType? = nil,
        phase: InboxCardPhase = .proposed,
        approvable: InboxApprovable = .ready,
        origin: InboxOrigin? = nil,
        targets: [String] = [],
        invalidText: String? = nil,
        invalidField: String? = nil,
        approval: InboxApproval? = nil,
        groups: [InboxGroup] = [],
        quotes: [String] = [],
        reason: String? = nil,
        edited: Bool = false,
        saving: Bool = false
    ) {
        self.id = id
        self.type = type
        self.baseType = baseType ?? type
        self.phase = phase
        self.approvable = approvable
        self.origin = origin
        self.targets = targets
        self.invalidText = invalidText
        self.invalidField = invalidField
        self.approval = approval
        self.groups = groups
        self.quotes = quotes
        self.reason = reason
        self.edited = edited
        self.saving = saving
    }
}
