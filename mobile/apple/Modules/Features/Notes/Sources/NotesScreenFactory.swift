import CoreKit
import NoteEditor
import SwiftUI

/// The screens of the Notes feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`, and
/// owns that model for as long as SwiftUI keeps the screen.
@MainActor
public enum NotesScreenFactory {

    // MARK: - Screens
    /// A page of notes in the note editor, under the pages of `trail` (outermost first); a subpage opens as another
    /// page. `focusTitle` puts the cursor into the title of a page just made from an empty block.
    public static func page(
        trail: [String],
        focusTitle: Bool,
        makeModel: @escaping @MainActor () -> any NoteEditorScreenModel,
        router: any NotesRouting
    ) -> some View {
        NoteEditorFactory.editor(
            variant: .full,
            trail: trail,
            focusTitle: focusTitle,
            makeModel: makeModel,
            router: NotesPageRouter(router: router)
        )
    }
}
