import Foundation

public enum NoteEditorBlockType: Equatable, Hashable, Sendable, CaseIterable {
    case text, h1, h2, h3, bullet, number, todo, quote, page
}

public enum NoteEditorMark: Equatable, Hashable, Sendable, CaseIterable {
    case bold, italic, code
}

public enum NoteEditorPhase: Equatable, Sendable {
    case loading
    case content
    case failure(FailureKind?)
}

/// A stretch of text with one formatting; `\n` in `text` is a soft line break inside the block.
public struct NoteEditorRun: Equatable, Hashable, Sendable {

    public var text: String
    public var bold: Bool
    public var italic: Bool
    public var code: Bool
    public var link: String?

    public init(_ text: String, bold: Bool = false, italic: Bool = false, code: Bool = false, link: String? = nil) {
        self.text = text
        self.bold = bold
        self.italic = italic
        self.code = code
        self.link = link
    }
}

/// What a block shows in front of its text: a bullet whose glyph follows `level`, or a number's label ("1.1.").
public enum NoteEditorMarker: Equatable, Hashable, Sendable {
    case bullet(level: Int)
    case number(String)
}

/// One block of the note. A page block has its subpage's title as its text and the subpage's `pageId`.
public struct NoteEditorBlock: Equatable, Sendable, Identifiable {

    public var id: String
    public var type: NoteEditorBlockType
    public var indent: Int
    public var done: Bool
    public var runs: [NoteEditorRun]
    public var pageId: String?
    public var marker: NoteEditorMarker?

    public init(
        id: String,
        type: NoteEditorBlockType,
        indent: Int = 0,
        done: Bool = false,
        runs: [NoteEditorRun] = [],
        pageId: String? = nil,
        marker: NoteEditorMarker? = nil
    ) {
        self.id = id
        self.type = type
        self.indent = indent
        self.done = done
        self.runs = runs
        self.pageId = pageId
        self.marker = marker
    }

    public var text: String { runs.map(\.text).joined() }
}

/// Where the cursor goes after an edit: `offset` UTF-16 units into the text of `blockId`.
public struct NoteEditorCaret: Equatable, Sendable {

    public var blockId: String
    public var offset: Int

    public init(blockId: String, offset: Int) {
        self.blockId = blockId
        self.offset = offset
    }
}

/// Why the note shows a notice: the page changed elsewhere and was read again, or a write failed.
public enum NoteEditorProblem: Equatable, Sendable {
    case reloaded
    case failed(FailureKind?)
}

/// The note editor. `caret` with its `caretRequest`, counted up on every move, tells the editor where to put the
/// cursor after an edit; a `nil` caret ends editing. `lastEditedAt` is an ISO instant.
public struct NoteEditorState: Equatable, Sendable {

    public var phase: NoteEditorPhase
    public var title: String
    public var titleEditable: Bool
    public var blocks: [NoteEditorBlock]
    public var wordCount: Int
    public var lastEditedAt: String?
    public var saving: Bool
    public var working: Bool
    public var problem: NoteEditorProblem?
    public var caret: NoteEditorCaret?
    public var caretRequest: Int

    public init(
        phase: NoteEditorPhase,
        title: String = "",
        titleEditable: Bool = false,
        blocks: [NoteEditorBlock] = [],
        wordCount: Int = 0,
        lastEditedAt: String? = nil,
        saving: Bool = false,
        working: Bool = false,
        problem: NoteEditorProblem? = nil,
        caret: NoteEditorCaret? = nil,
        caretRequest: Int = 0
    ) {
        self.phase = phase
        self.title = title
        self.titleEditable = titleEditable
        self.blocks = blocks
        self.wordCount = wordCount
        self.lastEditedAt = lastEditedAt
        self.saving = saving
        self.working = working
        self.problem = problem
        self.caret = caret
        self.caretRequest = caretRequest
    }
}

public enum NoteEditorAction: Equatable, Sendable {

    case retry
    case dismissProblem
    case typing(NoteEditorTyping)
    case blocks(NoteEditorBlockEdit)
    case tapBelow
    case setTitle(String)
    /// Writes a waiting change now, as the editor goes away.
    case flush
}

/// What typing in one block does. Offsets count UTF-16 units of the block's text.
public enum NoteEditorTyping: Equatable, Sendable {

    /// The block's text as the person left it; a Markdown prefix at the start of a text block applies.
    case setRuns(blockId: String, runs: [NoteEditorRun])
    case enter(blockId: String, offset: Int)
    case backspaceAtStart(blockId: String)
    case deleteAtEnd(blockId: String)
    case commandEnter(blockId: String)
    case paste(blockId: String, offset: Int, text: String)
    /// An empty range inside a word formats the word.
    case toggleMark(blockId: String, start: Int, end: Int, mark: NoteEditorMark)
    /// A `nil` address takes the link away.
    case setLink(blockId: String, start: Int, end: Int, address: String?)
}

/// What is done to whole blocks, by their ids.
public enum NoteEditorBlockEdit: Equatable, Sendable {

    case setType(blockIds: [String], type: NoteEditorBlockType)
    case toggleType(blockIds: [String], type: NoteEditorBlockType)
    case shiftIndent(blockIds: [String], delta: Int)
    case toggleDone(blockId: String)
    case move(blockIds: [String], targetIndex: Int)
    case duplicate(blockIds: [String])
    case delete(blockIds: [String])
    case makeSubpage(blockId: String)
    case openPage(blockId: String)
}

public enum NoteEditorEffect: Equatable, Sendable {

    /// `focusTitle` when the subpage was just made from an empty block.
    case openPage(pageId: String, title: String, focusTitle: Bool)
    /// No word around the cursor: the format applies to the text typed next at this place.
    case pendingMark(NoteEditorMark)
    /// A note kept as text by its owner changed; the owner saves the Markdown.
    case textChanged(String)
}

/// Where a note lives: a page of an item, the page of a Journal period, or Markdown its owner keeps and saves.
public enum NoteEditorSource: Equatable, Hashable, Sendable {
    case page(itemId: String, titleEditable: Bool)
    case journal(kind: JournalPeriodKind, period: String)
    case text(String)
}

public typealias NoteEditorScreenModel = ScreenModel<NoteEditorState, NoteEditorAction, NoteEditorEffect>

/// Note editor screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedNoteEditorScreenModel =
    ScriptedScreenModel<NoteEditorState, NoteEditorAction, NoteEditorEffect>
