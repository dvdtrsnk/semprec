import DesignSystem
import SwiftUI

/// The root screen of the Overview tab.
enum OverviewTab {

    @MainActor
    static func root(_ composition: AppComposition) -> some View {
        StatusView(.empty(message: Text("tab.overview.placeholder"), systemImage: "list.bullet.rectangle"))
            .navigationTitle(Text("tab.overview"))
    }
}
