import CoreKit
import NoteEditor
import SwiftUI

// MARK: - Preview
#Preview("Day") {
    NavigationStack {
        JournalScreen(viewModel: JournalViewModel(
            model: ScriptedJournalScreenModel(state: .previewDay),
            router: PreviewJournalRouter()
        ), capture: .preview, notes: .preview)
    }
}

#Preview("Loading") {
    NavigationStack {
        JournalScreen(viewModel: JournalViewModel(
            model: ScriptedJournalScreenModel(state: JournalState(
                phase: .loading, selection: .previewDay, today: "2026-10-16", axis: .previewAxis
            )),
            router: PreviewJournalRouter()
        ), capture: .preview, notes: .preview)
    }
}

#Preview("Unavailable") {
    NavigationStack {
        JournalScreen(viewModel: JournalViewModel(
            model: ScriptedJournalScreenModel(state: JournalState(
                phase: .failure(.unavailable), selection: .previewDay, today: "2026-10-16", axis: .previewAxis
            )),
            router: PreviewJournalRouter()
        ), capture: .preview, notes: .preview)
    }
}

private extension JournalNotes {

    static var preview: JournalNotes {
        JournalNotes(
            makeModel: { _ in
                ScriptedNoteEditorScreenModel(state: NoteEditorState(
                    phase: .content,
                    blocks: [NoteEditorBlock(id: "b1", type: .text, runs: [NoteEditorRun("A quiet day")])]
                ))
            },
            router: NoSubpagesRouter()
        )
    }
}

private extension JournalCaptureViewModel {

    static var preview: JournalCaptureViewModel {
        JournalCaptureViewModel(model: ScriptedInboxCaptureScreenModel(state: InboxCaptureState()), onCaptured: {})
    }
}
