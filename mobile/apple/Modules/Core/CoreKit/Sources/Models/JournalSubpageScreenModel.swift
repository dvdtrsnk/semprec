import Foundation

/// A subpage of the diary opened on its own.
public struct JournalSubpageState: Equatable, Sendable {

    public var phase: JournalPhase
    public var blocks: [JournalBlock]
    public var saving: Bool
    public var editProblem: JournalEditProblem?

    public init(
        phase: JournalPhase,
        blocks: [JournalBlock] = [],
        saving: Bool = false,
        editProblem: JournalEditProblem? = nil
    ) {
        self.phase = phase
        self.blocks = blocks
        self.saving = saving
        self.editProblem = editProblem
    }
}

public enum JournalSubpageAction: Equatable, Sendable {

    case retry
    case setText(index: Int, text: String)
    case toggleDone(index: Int)
    case addBlock(kind: JournalBlockKind, text: String)
    case openPage(pageId: String, title: String)
    case dismissProblem
}

public enum JournalSubpageEffect: Equatable, Sendable {

    case openPage(pageId: String, title: String)
}

public typealias JournalSubpageScreenModel =
    ScreenModel<JournalSubpageState, JournalSubpageAction, JournalSubpageEffect>

/// Subpage screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedJournalSubpageScreenModel =
    ScriptedScreenModel<JournalSubpageState, JournalSubpageAction, JournalSubpageEffect>
