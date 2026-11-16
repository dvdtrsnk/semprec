import Combine
import CoreKit
import Dependencies
import DesignSystem
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
    /// The Semp chat and its bubble: whether the chat is open, what it shows, and where the bubble can pick up objects.
    let sempChat = SempChatPresenter()
    let dropTargets = DropTargetRegistry()
    /// The tab the person is on, which the pages the chat opens appear in.
    var currentTab = AppTab.overview

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

    // MARK: - Semp
    /// The router of the bubble and of the Semp pages that sit on a tab's stack: it opens the chat on the page it is asked for.
    private(set) lazy var sempRouter = AppSempRouter(
        presenter: sempChat,
        context: navigation,
        tab: { [weak self] in self?.currentTab ?? .overview },
        insideChat: false
    )

    /// The router of the pages inside the chat: it pushes onto the chat's own stack.
    private(set) lazy var chatRouter = AppSempRouter(
        presenter: sempChat,
        context: navigation,
        tab: { [weak self] in self?.currentTab ?? .overview },
        insideChat: true
    )

    // MARK: - Routers
    /// The router of a Tasks screen that sits on the stack of `tab`; it opens Podrobnosti over that stack.
    func tasksRouter(in tab: AppTab) -> AppTasksRouter {
        AppTasksRouter(context: navigation, tab: tab)
    }
}
