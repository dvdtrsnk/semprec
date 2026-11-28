/// Where the editor is shown. `full` is a page of its own, with its title and subpages; `light` is a note inside
/// another screen (a day's note, a task's description, an Inbox card), which offers no subpages.
public enum NoteEditorVariant: Equatable, Sendable {

    case full
    case light

    var offersSubpages: Bool { self == .full }
}
