import Combine

/// Lets the screen around a note see whether a block of it is edited and end the editing, as a focus mode does.
@MainActor
public final class NoteEditorFocus: ObservableObject {

    // MARK: - Published Properties
    @Published public internal(set) var isEditing = false
    /// Counted up by `end()`; the editor ends editing on each change.
    @Published private(set) var endRequests = 0

    // MARK: - Init
    public init() {}

    // MARK: - Methods
    /// Ends editing in the note, which writes what waits.
    public func end() {
        endRequests += 1
    }
}
