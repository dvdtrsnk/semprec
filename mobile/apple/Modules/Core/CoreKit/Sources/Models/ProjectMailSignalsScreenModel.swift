import Foundation

/// One list of a project's own mail signals.
public enum MailSignalField: Equatable, Sendable, CaseIterable {

    case domains
    case addresses
    case keywords
}

public enum ProjectMailSignalsPhase: Equatable, Sendable {

    case loading
    case ready
    case error
}

/// Where the preview of the matching threads is: being asked for, answered, or failed.
public enum MailSignalsPreviewPhase: Equatable, Sendable {

    case loading
    case ready
    case error
}

/// An address of one of the project's people, which counts as a signal and is edited on the person.
public struct MailSignalPersonItem: Equatable, Sendable, Identifiable {

    public let personId: String
    public let name: String
    public let address: String

    public var id: String { address }

    public init(personId: String, name: String, address: String) {
        self.personId = personId
        self.name = name
        self.address = address
    }
}

/// One matching thread of the preview; `lastMessageAt` is the server's instant (ISO 8601).
public struct MailSignalThreadItem: Equatable, Sendable, Identifiable {

    public let threadId: String
    public let subject: String
    public let senderName: String
    public let senderAddress: String
    public let lastMessageAt: String

    public var id: String { threadId }

    public init(threadId: String, subject: String, senderName: String, senderAddress: String, lastMessageAt: String) {
        self.threadId = threadId
        self.subject = subject
        self.senderName = senderName
        self.senderAddress = senderAddress
        self.lastMessageAt = lastMessageAt
    }
}

/// The open threads (without a project) the signals on screen match: `total` of them, the newest as `threads`, and
/// `alreadyAssigned` matching threads that already have a project. While loading, the previous answer stays.
public struct MailSignalsPreviewState: Equatable, Sendable {

    public var phase: MailSignalsPreviewPhase
    public var failure: FailureKind?
    public var total: Int
    public var alreadyAssigned: Int
    public var threads: [MailSignalThreadItem]

    public init(
        phase: MailSignalsPreviewPhase = .loading,
        failure: FailureKind? = nil,
        total: Int = 0,
        alreadyAssigned: Int = 0,
        threads: [MailSignalThreadItem] = []
    ) {
        self.phase = phase
        self.failure = failure
        self.total = total
        self.alreadyAssigned = alreadyAssigned
        self.threads = threads
    }
}

/// What the last assignment did.
public struct MailSignalsAssignment: Equatable, Sendable {

    public let assigned: Int
    public let skipped: Int

    public init(assigned: Int, skipped: Int) {
        self.assigned = assigned
        self.skipped = skipped
    }
}

/// The mail signals of one project, as the shared ViewModel decides them: the lists on screen and the text typed into
/// each, the list the server or the check refused, and whether Save and Assign act now.
public struct ProjectMailSignalsState: Equatable, Sendable {

    public var phase: ProjectMailSignalsPhase
    public var failure: FailureKind?
    public var people: [MailSignalPersonItem]
    public var domains: [String]
    public var addresses: [String]
    public var keywords: [String]
    public var domainInput: String
    public var addressInput: String
    public var keywordInput: String
    public var invalidField: MailSignalField?
    public var unsaved: Bool
    public var saving: Bool
    public var saveFailure: Failed?
    public var preview: MailSignalsPreviewState
    public var assigning: Bool
    public var assignFailure: Failed?
    public var assignment: MailSignalsAssignment?
    public var canSave: Bool
    public var canAssign: Bool

    public init(
        phase: ProjectMailSignalsPhase = .loading,
        failure: FailureKind? = nil,
        people: [MailSignalPersonItem] = [],
        domains: [String] = [],
        addresses: [String] = [],
        keywords: [String] = [],
        domainInput: String = "",
        addressInput: String = "",
        keywordInput: String = "",
        invalidField: MailSignalField? = nil,
        unsaved: Bool = false,
        saving: Bool = false,
        saveFailure: Failed? = nil,
        preview: MailSignalsPreviewState = MailSignalsPreviewState(),
        assigning: Bool = false,
        assignFailure: Failed? = nil,
        assignment: MailSignalsAssignment? = nil,
        canSave: Bool = false,
        canAssign: Bool = false
    ) {
        self.phase = phase
        self.failure = failure
        self.people = people
        self.domains = domains
        self.addresses = addresses
        self.keywords = keywords
        self.domainInput = domainInput
        self.addressInput = addressInput
        self.keywordInput = keywordInput
        self.invalidField = invalidField
        self.unsaved = unsaved
        self.saving = saving
        self.saveFailure = saveFailure
        self.preview = preview
        self.assigning = assigning
        self.assignFailure = assignFailure
        self.assignment = assignment
        self.canSave = canSave
        self.canAssign = canAssign
    }

    /// The values of one list.
    public func values(_ field: MailSignalField) -> [String] {
        switch field {
        case .domains: domains
        case .addresses: addresses
        case .keywords: keywords
        }
    }

    /// The text typed into the field of one list.
    public func input(_ field: MailSignalField) -> String {
        switch field {
        case .domains: domainInput
        case .addresses: addressInput
        case .keywords: keywordInput
        }
    }
}

public enum ProjectMailSignalsAction: Equatable, Sendable {

    case retry
    case editInput(MailSignalField, text: String)
    case add(MailSignalField)
    case remove(MailSignalField, value: String)
    case save
    case assign
    case retryPreview
    case dismissAssignment
    case dismissFailure
}

/// The mail signals screen has no effects: saving and assigning are state changes, and leaving is the stack's own.
public typealias ProjectMailSignalsScreenModel = ScreenModel<ProjectMailSignalsState, ProjectMailSignalsAction, Never>

/// Mail signals screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedProjectMailSignalsScreenModel =
    ScriptedScreenModel<ProjectMailSignalsState, ProjectMailSignalsAction, Never>
