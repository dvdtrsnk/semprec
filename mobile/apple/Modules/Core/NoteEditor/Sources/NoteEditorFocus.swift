import Combine
import DesignSystem
import SwiftUI

/// Lets the screen around a note see whether a block of it is edited or its blocks are selected, and end either, as a
/// focus mode does.
@MainActor
public final class NoteEditorFocus: ObservableObject {

    // MARK: - Published Properties
    @Published public internal(set) var isEditing = false
    @Published public internal(set) var isSelecting = false
    /// Counted up by `end()`; the editor ends editing and selecting on each change.
    @Published private(set) var endRequests = 0

    // MARK: - Init
    public init() {}

    // MARK: - Methods
    /// Whether the note is edited or its blocks are selected.
    public var isActive: Bool { isEditing || isSelecting }

    /// Ends editing (which writes what waits) and selecting in the note.
    public func end() {
        endRequests += 1
    }
}

/// The check at the top right of a screen that ends editing or selecting in its note; it stands where the screen's
/// own button was while the note is focused.
public struct NoteFocusDoneButton: View {

    @ObservedObject private var focus: NoteEditorFocus

    public init(focus: NoteEditorFocus) {
        self.focus = focus
    }

    public var body: some View {
        Button { focus.end() } label: { Image(systemName: "checkmark") }
            .buttonStyle(.glassProminent)
            .accessibilityLabel(Text("noteEditor.done", bundle: .module))
            .accessibilityIdentifier(NoteEditorIdentifiers.focusDone)
    }
}
