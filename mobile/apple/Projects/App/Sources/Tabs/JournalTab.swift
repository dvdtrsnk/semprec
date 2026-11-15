import DesignSystem
import SwiftUI

/// The root screen of the Journal tab. The Journal feature replaces the body of `root` with its own screen; the app
/// scene already wraps the result in the tab's navigation stack.
enum JournalTab {

    @MainActor
    static func root(_ composition: AppComposition) -> some View {
        StatusView(.empty(message: Text("tab.journal.placeholder"), systemImage: "book"))
            .navigationTitle(Text("tab.journal"))
    }
}
