import CoreKit
import NoteEditor
import SwiftUI

/// The screens of the Journal feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`,
/// and owns that model for as long as SwiftUI keeps the screen.
@MainActor
public enum JournalScreenFactory {

    // MARK: - Screens
    /// The diary, the root of the Journal tab. `makeModel` receives the device's current day (`YYYY-MM-DD`), which
    /// the diary opens on until the server's answer names its own today.
    /// `makeCapture` makes the model of the capture row under today's Inbox, `makeNote` the model of the note of a
    /// period, each time a period's note is shown.
    public static func journal(
        makeModel: @escaping @MainActor (_ initialDay: String) -> any JournalScreenModel,
        makeCapture: @escaping @MainActor () -> any InboxCaptureScreenModel,
        makeNote: @escaping @MainActor (NoteEditorSource) -> any NoteEditorScreenModel,
        router: any JournalRouting
    ) -> some View {
        JournalScreen(
            viewModel: JournalViewModel(model: makeModel(JournalDates.deviceToday()), router: router),
            capture: JournalCaptureViewModel(model: makeCapture()),
            notes: JournalNotes(makeModel: makeNote, router: JournalNoteRouter(router: router))
        )
    }
}
