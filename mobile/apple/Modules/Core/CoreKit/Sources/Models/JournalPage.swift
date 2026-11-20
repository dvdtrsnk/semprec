import Foundation

/// The kinds of period the diary keeps a page for. The time axis shows every kind but `.week`.
public enum JournalPeriodKind: Equatable, Hashable, Sendable {

    case year
    case quarter
    case month
    case week
    case day
}

/// Which page of the diary: the period it belongs to, named by its canonical key (`2026-Q4`, `2026-W42`).
public struct JournalPageRef: Equatable, Hashable, Sendable {

    public let kind: JournalPeriodKind
    public let period: String

    public init(kind: JournalPeriodKind, period: String) {
        self.kind = kind
        self.period = period
    }
}

public enum JournalBlockKind: Equatable, Sendable {

    case text
    case heading1
    case heading2
    case heading3
    case bullet
    case number
    case todo
    case quote
    /// A link to a subpage.
    case page
}

/// A stretch of text with one formatting; the screen builds styled text from runs and never sees Markdown.
public struct JournalRun: Equatable, Sendable {

    public let text: String
    public let bold: Bool
    public let italic: Bool
    public let code: Bool
    public let link: String?

    public init(text: String, bold: Bool = false, italic: Bool = false, code: Bool = false, link: String? = nil) {
        self.text = text
        self.bold = bold
        self.italic = italic
        self.code = code
        self.link = link
    }
}

/// One block of a page. `index` is its place in the page; `ordinal` is the number of a
/// numbered item within its list and 0 for other blocks. A `.page` block carries its caption in `runs`.
public struct JournalBlock: Equatable, Sendable, Identifiable {

    public let index: Int
    public let kind: JournalBlockKind
    public let indent: Int
    public let done: Bool
    public let ordinal: Int
    public let runs: [JournalRun]
    public let pageId: String?

    public var id: Int { index }

    /// The text without formatting.
    public var plainText: String { runs.map(\.text).joined() }

    public init(
        index: Int,
        kind: JournalBlockKind,
        indent: Int = 0,
        done: Bool = false,
        ordinal: Int = 0,
        runs: [JournalRun] = [],
        pageId: String? = nil
    ) {
        self.index = index
        self.kind = kind
        self.indent = indent
        self.done = done
        self.ordinal = ordinal
        self.runs = runs
        self.pageId = pageId
    }
}

public struct JournalPage: Equatable, Sendable {

    public let ref: JournalPageRef
    public let blocks: [JournalBlock]

    public init(ref: JournalPageRef, blocks: [JournalBlock]) {
        self.ref = ref
        self.blocks = blocks
    }
}
