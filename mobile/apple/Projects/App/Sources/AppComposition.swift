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
    /// The notifications of the process, which every scene shares; nil in tests that leave the system alone.
    let notifications: AppNotifications?
    /// The Semp chat and its bubble: whether the chat is open, what it shows, and where the bubble can pick up objects.
    let sempChat = SempChatPresenter()
    let dropTargets = DropTargetRegistry()
    /// Whether the bubble is docked in Semp's button of the tab bar or floats.
    let sempDock = SempDock()
    /// The tab the person is on, which the pages the chat opens appear in.
    var currentTab = AppTab.overview
    /// The models of the tabs not opened yet, made ahead so that they open on their content.
    let preparedTabs: PreparedTabModels

    // MARK: - Init
    /// A scene's composition over the device services of the process, which `notifications` owns and every scene is
    /// given; the scene's screen models are made over them and the composition creates none of its own.
    convenience init(deviceServices: DeviceServices, notifications: AppNotifications?) {
        self.init(models: SceneContainer().screenModelFactory(deviceServices)(), notifications: notifications)
    }

    /// A composition over the given screen models; tests pass a factory whose session is already signed in.
    init(models: any ScreenModelFactory, notifications: AppNotifications? = nil) {
        let navigation = NavigationContext()
        self.models = models
        self.notifications = notifications
        self.navigation = navigation
        preparedTabs = PreparedTabModels(models: models)
        overviewRouter = AppOverviewRouter(context: navigation)
        collectionsRouter = AppCollectionsRouter(context: navigation, tab: .overview)
        calendarRouter = AppCalendarRouter(context: navigation)
        journalRouter = AppJournalRouter(context: navigation)
    }

    // MARK: - Semp
    /// The router of the bubble and of the Semp pages on a tab's stack: it opens the chat on the page it is asked for.
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

    // MARK: - Notifications
    /// Sends when a tapped notification waits for a scene, and once when a scene subscribes.
    var notificationArrivals: AnyPublisher<Void, Never> {
        notifications?.targetArrivals.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()
    }

    /// Opens what the tapped notification waiting for a scene leads to, if one waits and this scene takes it.
    func openTappedNotification() {
        guard let target = notifications?.takeTarget() else { return }
        navigation.open(target)
    }

    // MARK: - Routers
    /// The router of the sleep sheet, which opens the wake settings over the stack of the tab the person is on.
    private(set) lazy var sleepRouter = AppSleepRouter(
        context: navigation,
        tab: { [weak self] in self?.currentTab ?? .overview }
    )

    /// The router of an Inbox that sits on the stack of `tab`; what a decision created opens over that stack.
    func inboxRouter(in tab: AppTab) -> AppInboxRouter {
        AppInboxRouter(context: navigation, tab: tab)
    }

    /// The router of a Tasks screen that sits on the stack of `tab`; it opens Podrobnosti over that stack.
    func tasksRouter(in tab: AppTab) -> AppTasksRouter {
        AppTasksRouter(context: navigation, tab: tab)
    }

    /// The router of a recordings, transcript or event page screen that sits on the stack of `tab`.
    func recordingsRouter(in tab: AppTab) -> AppRecordingsRouter {
        AppRecordingsRouter(context: navigation, tab: tab)
    }

    /// The router of a notes screen that sits on the stack of `tab`.
    func notesRouter(in tab: AppTab) -> AppNotesRouter {
        AppNotesRouter(context: navigation, tab: tab)
    }
}
