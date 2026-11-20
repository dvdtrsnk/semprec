/// The accessibility identifiers of the note editor.
enum NoteEditorIdentifiers {

    static let editor = "noteEditor"
    static let title = "noteEditor.title"
    static let tapBelow = "noteEditor.tapBelow"
    static let done = "noteEditor.done"
    static let linkAddress = "noteEditor.link.address"
    static let selectionBar = "noteEditor.selectionBar"
    static let breadcrumb = "noteEditor.breadcrumb"
    static let focusDone = "noteEditor.focusDone"
    static let formatBar = "noteEditor.formatBar"

    static func block(_ id: String) -> String { "noteEditor.block.\(id)" }
    static func checkbox(_ id: String) -> String { "noteEditor.checkbox.\(id)" }
    static func fold(_ id: String) -> String { "noteEditor.fold.\(id)" }
    static func emptyToggle(_ id: String) -> String { "noteEditor.emptyToggle.\(id)" }
    static func pageLink(_ id: String) -> String { "noteEditor.page.\(id)" }
}
