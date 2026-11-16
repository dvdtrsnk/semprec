import Foundation

/// The item a decision created or changed, which the toast offers to show.
public struct InboxResult: Equatable, Sendable {

    public let label: String
    public let databaseKey: String?
    public let itemId: String?

    public init(label: String, databaseKey: String?, itemId: String?) {
        self.label = label
        self.databaseKey = databaseKey
        self.itemId = itemId
    }
}

/// The picker of the field `key` of the card `cardId`, open over the card.
public struct InboxPicker: Equatable, Sendable {

    public let cardId: String
    public let key: String
    public let multi: Bool
    public let phase: InboxPickerPhase
    public let options: [InboxChoice]

    public init(cardId: String, key: String, multi: Bool, phase: InboxPickerPhase, options: [InboxChoice]) {
        self.cardId = cardId
        self.key = key
        self.multi = multi
        self.phase = phase
        self.options = options
    }
}

/// What the Inbox shows once it is loaded: the cards, the top one first.
public struct InboxContent: Equatable, Sendable {

    public var cards: [InboxCard]
    public var handled: Int
    public var dropped: Int
    public var canUndo: Bool
    public var refreshing: Bool
    public var busy: Bool
    public var result: InboxResult?
    public var problem: InboxProblem?
    public var problemFailure: FailureKind?
    public var picker: InboxPicker?

    public init(
        cards: [InboxCard] = [],
        handled: Int = 0,
        dropped: Int = 0,
        canUndo: Bool = false,
        refreshing: Bool = false,
        busy: Bool = false,
        result: InboxResult? = nil,
        problem: InboxProblem? = nil,
        problemFailure: FailureKind? = nil,
        picker: InboxPicker? = nil
    ) {
        self.cards = cards
        self.handled = handled
        self.dropped = dropped
        self.canUndo = canUndo
        self.refreshing = refreshing
        self.busy = busy
        self.result = result
        self.problem = problem
        self.problemFailure = problemFailure
        self.picker = picker
    }
}

public enum InboxState: Equatable, Sendable {

    case loading
    case content(InboxContent)
    case failure(FailureKind?)
}

public enum InboxAction: Equatable, Sendable {

    case retry
    case refresh
    case setText(cardId: String, key: String, text: String)
    case setFlag(cardId: String, key: String, value: Bool)
    case setDate(cardId: String, key: String, date: String)
    case setTime(cardId: String, key: String, time: String)
    /// Picks one choice; a nil `choiceId` is the "none" choice.
    case pick(cardId: String, key: String, choiceId: String?)
    case toggle(cardId: String, key: String, choiceId: String)
    case openPicker(cardId: String, key: String)
    case closePicker
    case setSecret(cardId: String, text: String)
    case approve
    case reject
    case undo
    case reset(cardId: String)
    case recompute(cardId: String)
    case openResult
    case dismissResult
    case dismissProblem
}

/// One-time requests of the Inbox to the app.
public enum InboxEffect: Equatable, Sendable {

    /// Show the item a decision created.
    case openItem(databaseKey: String?, itemId: String)
}

public typealias InboxScreenModel = ScreenModel<InboxState, InboxAction, InboxEffect>

/// Inbox screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedInboxScreenModel = ScriptedScreenModel<InboxState, InboxAction, InboxEffect>
