import Foundation

/// The block types of a page document; `page` is a subpage.
public enum NoteBlockType: Equatable, Hashable, Sendable, CaseIterable {

    case text
    case heading1
    case heading2
    case heading3
    case bullet
    case number
    case todo
    case quote
    case page
}

public enum NotesPhase: Equatable, Sendable {

    case loading
    case content
    case error
}

/// One block of a page. `text` is inline Markdown; `marker` is the number a numbered block shows (`1.`, `2.1.`);
/// `pageId` is the item of a subpage block.
public struct NoteBlockItem: Equatable, Sendable, Identifiable {

    public let id: String
    public let type: NoteBlockType
    public let indent: Int
    public let done: Bool
    public let text: String
    public let pageId: String?
    public let marker: String?

    public init(
        id: String,
        type: NoteBlockType,
        indent: Int,
        done: Bool,
        text: String,
        pageId: String?,
        marker: String?
    ) {
        self.id = id
        self.type = type
        self.indent = indent
        self.done = done
        self.text = text
        self.pageId = pageId
        self.marker = marker
    }
}

/// A page of notes. While `selecting`, `selected` holds the ids of the blocks to move into subpages.
public struct NotesState: Equatable, Sendable {

    public var phase: NotesPhase
    public var failure: FailureKind?
    public var title: String
    public var blocks: [NoteBlockItem]
    public var selecting: Bool
    public var selected: [String]
    public var working: Bool
    public var writeFailure: Failed?

    public init(
        phase: NotesPhase = .loading,
        failure: FailureKind? = nil,
        title: String = "",
        blocks: [NoteBlockItem] = [],
        selecting: Bool = false,
        selected: [String] = [],
        working: Bool = false,
        writeFailure: Failed? = nil
    ) {
        self.phase = phase
        self.failure = failure
        self.title = title
        self.blocks = blocks
        self.selecting = selecting
        self.selected = selected
        self.working = working
        self.writeFailure = writeFailure
    }
}

public enum NotesAction: Equatable, Sendable {

    case retry
    case refresh
    case add(NoteBlockType, text: String, afterBlockId: String?)
    case createSubpage(title: String, afterBlockId: String?)
    case toggleSelecting
    case toggle(blockId: String)
    case moveSelectedToSubpages
    case open(blockId: String)
    case convertToBlock(blockId: String, type: NoteBlockType)
    case renameSubpage(blockId: String, title: String)
    case openAsText
    case dismissFailure
}

/// Where the notes ask the app to go.
public enum NotesEffect: Equatable, Sendable {

    case openPage(itemId: String)
    case openAsText
}

public typealias NotesScreenModel = ScreenModel<NotesState, NotesAction, NotesEffect>

/// Notes screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedNotesScreenModel = ScriptedScreenModel<NotesState, NotesAction, NotesEffect>
