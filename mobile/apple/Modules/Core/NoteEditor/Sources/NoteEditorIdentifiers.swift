/// The accessibility identifiers of the note editor.
enum NoteEditorIdentifiers {

    static let editor = "noteEditor"
    static let title = "noteEditor.title"
    static let tapBelow = "noteEditor.tapBelow"
    static let accessoryBar = "noteEditor.accessoryBar"
    static let done = "noteEditor.done"
    static let linkAddress = "noteEditor.link.address"

    static func block(_ id: String) -> String { "noteEditor.block.\(id)" }
    static func checkbox(_ id: String) -> String { "noteEditor.checkbox.\(id)" }
    static func pageLink(_ id: String) -> String { "noteEditor.page.\(id)" }
}
