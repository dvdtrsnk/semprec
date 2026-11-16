import CoreKit
import OverviewFeature
import SwiftUI

/// The root screen of the Overview tab.
enum OverviewTab {

    @MainActor
    static func root(_ composition: AppComposition) -> some View {
        OverviewScreenFactory.overview(
            makeModel: { composition.models.makeOverview() },
            makeSearch: { composition.models.makeSearch() },
            router: composition.overviewRouter
        )
    }
}
