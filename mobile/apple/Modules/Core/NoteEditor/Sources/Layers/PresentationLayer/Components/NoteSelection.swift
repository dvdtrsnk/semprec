import CoreKit

/// Where the cursor or selection of the edited block is, in UTF-16 units of its text, and the formats there; the
/// accessory bar shows them and acts on them.
struct NoteSelection: Equatable {

    var blockId: String
    var start: Int
    var end: Int
    var marks: Set<NoteEditorMark>
    var link: String?

    var isEmpty: Bool { start == end }
}

/// A key of a hardware keyboard the edited block hands to the editor around it.
enum NoteEditorKey: Equatable {

    case indent(Int)
    case previous
    case next
    case done
    case link
}
