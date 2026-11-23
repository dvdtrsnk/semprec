import Combine
import CoreKit
import DesignSystem
import SwiftUI

/// Lets the screen around a note see whether a block of it is edited or its blocks are selected, and end either, as a
/// focus mode does.
@MainActor
public final class NoteEditorFocus: ObservableObject {

    // MARK: - Published Properties
    @Published public internal(set) var isEditing = false
    @Published public internal(set) var isSelecting = false
    /// Set while part of the edited block's text is selected: what the format bar shows and does.
    @Published var formatting: NoteFormatting?
    /// Set while the note's blocks are selected: what the selection panel shows and does.
    @Published var selection: NoteSelectionActions?
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

/// What the format bar of a selected stretch of text works with.
struct NoteFormatting {

    let selection: NoteSelection
    let apply: @MainActor (NoteEditorTyping) -> Void
    let link: @MainActor () -> Void
    let done: @MainActor () -> Void
}

// MARK: - Format bar
extension View {

    /// The format bar of `focus`'s note, right above the keyboard, while part of a block's text is selected, and its
    /// selection panel, in place of the tab bar, while its blocks are selected. A screen around a note puts it on its
    /// whole content, so the bar and the panel span the screen's width.
    public func noteFormatBar(_ focus: NoteEditorFocus) -> some View {
        modifier(NoteFocusBars(focus: focus))
    }
}

/// Shows the format bar while `focus` has a selection to format, and the selection panel, with the tab bar hidden,
/// while its blocks are selected; floating controls step aside while the note is written in.
private struct NoteFocusBars: ViewModifier {

    @ObservedObject var focus: NoteEditorFocus

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) { bar }
            // While the note is written in, the keyboard takes the bottom of the screen: floating controls there
            // would cover the line being written.
            .background { if focus.isEditing { Color.clear.hidesFloatingControls() } }
            .tabBarHidden(focus.selection != nil)
            .animation(.snappy(duration: 0.25), value: focus.selection == nil)
    }

    @ViewBuilder var bar: some View {
        if let selection = focus.selection {
            NoteSelectionPanel(actions: selection)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if let formatting = focus.formatting {
            NoteFormatBar(
                selection: formatting.selection,
                onTyping: formatting.apply,
                onLink: formatting.link,
                onDone: formatting.done
            )
        }
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
            .accentTint()
            .accessibilityLabel(Text("noteEditor.done", bundle: .module))
            .accessibilityIdentifier(NoteEditorIdentifiers.focusDone)
    }
}
