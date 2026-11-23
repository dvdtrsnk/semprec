import CoreKit
import JournalFeature
import SwiftUI

/// The root screen of the Journal tab: the diary.
enum JournalTab {

    @MainActor
    static func root(_ composition: AppComposition) -> some View {
        JournalScreenFactory.journal(
            makeModel: { composition.preparedTabs.journalModel(initialDay: $0) },
            makeCapture: { composition.models.makeInboxCapture() },
            makeNote: { composition.models.makeNoteEditor(source: $0) },
            router: composition.journalRouter
        )
    }
}
