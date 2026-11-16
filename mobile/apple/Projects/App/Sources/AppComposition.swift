import Combine
import CoreKit
import Dependencies
import Foundation

/// Everything one app scene shares: the screen model factory over one Kotlin SDK, the navigation of its tabs and
/// the routers that features use. A scene owns exactly one composition. The scene's root navigator stays out of it:
/// `AppScene` holds it, so that the closures NavigatorUI keeps in the root navigation state never lead back to what
/// holds that state (see `AppScene.body`).
@MainActor
final class AppComposition: ObservableObject {

    // MARK: - Dependencies
    let models: any ScreenModelFactory
    let navigation: NavigationContext
    let overviewRouter: AppOverviewRouter
    let collectionsRouter: AppCollectionsRouter
    let calendarRouter: AppCalendarRouter
    let journalRouter: AppJournalRouter

    // MARK: - Init
    convenience init() {
        self.init(models: SceneContainer().screenModelFactory()())
    }

    /// A composition over the given screen models; tests pass a factory whose session is already signed in.
    init(models: any ScreenModelFactory) {
        let navigation = NavigationContext()
        self.models = models
        self.navigation = navigation
        overviewRouter = AppOverviewRouter(context: navigation)
        collectionsRouter = AppCollectionsRouter(context: navigation, tab: .overview)
        calendarRouter = AppCalendarRouter(context: navigation)
        journalRouter = AppJournalRouter(context: navigation)
    }

    // MARK: - Routers
    /// The router of a Tasks screen that sits on the stack of `tab`; it opens Podrobnosti over that stack.
    func tasksRouter(in tab: AppTab) -> AppTasksRouter {
        AppTasksRouter(context: navigation, tab: tab)
    }
}
