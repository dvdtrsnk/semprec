import CoreKit
import SwiftUI

/// The note editor for other modules. The editor calls `makeModel` once, when SwiftUI creates its `@StateObject`, and
/// owns that model for as long as SwiftUI keeps the editor.
@MainActor
public enum NoteEditorFactory {

    /// `onTextChanged` receives the Markdown of a note kept as text (`NoteEditorSource.text`) after each change.
    public static func editor(
        variant: NoteEditorVariant,
        makeModel: @escaping @MainActor () -> any NoteEditorScreenModel,
        router: any NoteEditorRouting,
        onTextChanged: @escaping @MainActor (String) -> Void = { _ in }
    ) -> some View {
        NoteEditorScreen(
            viewModel: NoteEditorViewModel(
                variant: variant,
                model: makeModel(),
                router: router,
                onTextChanged: onTextChanged
            )
        )
    }
}
