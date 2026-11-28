import CoreKit
import SwiftUI

/// The note editor for other modules. The editor calls `makeModel` once, when SwiftUI creates its `@StateObject`, and
/// owns that model for as long as SwiftUI keeps the editor.
@MainActor
public enum NoteEditorFactory {

    /// `trail` names the pages above a subpage, outermost first; `focusTitle` puts the cursor into the title of a
    /// page just made from an empty block. `onTextChanged` receives the Markdown of a note kept as text
    /// (`NoteEditorSource.text`) after each change. `focus` tells the screen around the note when a block is edited and
    /// lets it end the editing.
    public static func editor(
        variant: NoteEditorVariant,
        trail: [String] = [],
        focusTitle: Bool = false,
        focus: NoteEditorFocus? = nil,
        makeModel: @escaping @MainActor () -> any NoteEditorScreenModel,
        router: any NoteEditorRouting,
        onTextChanged: @escaping @MainActor (String) -> Void = { _ in }
    ) -> some View {
        NoteEditorScreen(
            viewModel: NoteEditorViewModel(
                variant: variant,
                trail: trail,
                focusTitle: focusTitle,
                model: makeModel(),
                router: router,
                onTextChanged: onTextChanged
            ),
            focus: focus
        )
    }
}
