import CoreKit
import NoteEditor
import SwiftUI

/// The notes of the periods: each period's note in the light note editor, made for it when it is shown.
@MainActor
struct JournalNotes {

    let makeModel: @MainActor (NoteEditorSource) -> any NoteEditorScreenModel
    let router: any NoteEditorRouting

    /// The note of `page`'s period; a note of another period is another editor.
    func editor(_ page: JournalPage) -> some View {
        NoteEditorFactory.editor(
            variant: .light,
            makeModel: { makeModel(.journal(kind: page.ref.kind, period: page.ref.period)) },
            router: router
        )
        .id(page.ref)
    }
}
