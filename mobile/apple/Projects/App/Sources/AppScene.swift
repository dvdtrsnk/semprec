import AuthFeature
import CalendarFeature
import CollectionsFeature
import DesignSystem
import JournalFeature
import MailFeature
import NavigatorUI
import SempFeature
import SleepFeature
import SwiftUI
import TasksFeature

/// The content of one window: a tab per section of the app, each with its own navigation stack. Each window creates its
/// own composition, so windows share neither screen models nor navigation.
struct AppScene: View {

    // MARK: - Properties
    @StateObject private var composition: AppComposition
    @State private var rootNavigator = Navigator(configuration: .init())
    @State private var selectedTab: AppTab
    @Environment(\.horizontalSizeClass)
    private var horizontalSizeClass

    // MARK: - Init
    /// `composition` runs once per scene, when SwiftUI creates the state object. The window opens on `selectedTab`.
    init(composition: @autoclosure @escaping () -> AppComposition, selectedTab: AppTab = .overview) {
        _composition = StateObject(wrappedValue: composition())
        _selectedTab = State(initialValue: selectedTab)
    }

    // MARK: - Body
    var body: some View {
        // NavigatorUI keeps the destination provider below in the root navigation state for as long as that state
        // lives, and the root navigator is this view's state. So every closure here calls static functions and
        // captures only the composition, which holds no root navigation state: capturing `self` would make the root
        // navigation state keep itself, the composition and its Kotlin SDK alive after the window closes. The
        // provider captures the composition weakly as well, because the environment holding the root navigator can
        // outlive the window: AppKit kept a closed macOS window's tab bar environment, root navigator included, alive
        // in SceneLifetimeTests.
        let composition = composition
        let rootNavigator = rootNavigator
        let selectedTab = $selectedTab
        SessionGate(viewModel: SessionViewModel(model: composition.models.makeSession())) {
            Self.tabs(
                composition,
                rootNavigator: rootNavigator,
                selectedTab: selectedTab,
                showsSempTab: showsSempTab
            )
                .modifier(LiveUpdates(models: composition.models))
                .modifier(SleepAlarmUpkeep(notifications: composition.notifications))
        } signedOut: {
            AuthScreenFactory.login(makeModel: { composition.models.makeLogin() })
                .task { await composition.notifications?.signedOut() }
        }
        .wakeGuard(makeModel: { composition.models.makeWakeGuard() }, navigation: composition.navigation)
    }
}

// MARK: - Subviews
private extension AppScene {

    /// Whether the tab bar shows Semp's button: on an iPhone-sized window only, where the tab bar is at the bottom.
    var showsSempTab: Bool {
        #if os(iOS)
        horizontalSizeClass == .compact
        #else
        false
        #endif
    }

    static func tabs(
        _ composition: AppComposition,
        rootNavigator: Navigator,
        selectedTab: Binding<AppTab>,
        showsSempTab: Bool
    ) -> some View {
        // The banner sits above the tab view rather than in a top safe-area inset of it: iOS lays the tabs' navigation
        // bars out under such an inset, so the banner covered their buttons.
        VStack(spacing: 0) {
            SyncStatusBanner(viewModel: SyncStatusViewModel(model: composition.models.makeSyncStatus()))
            TabView(selection: SceneTab.selection(selectedTab, chat: composition.sempChat)) {
                Tab("tab.overview", systemImage: "list.bullet.rectangle", value: SceneTab.area(.overview)) {
                    Self.stack(.overview, composition) { OverviewTab.root(composition) }
                }
                .accessibilityIdentifier(AppIdentifiers.overviewTab)
                Tab("tab.calendar", systemImage: "calendar", value: SceneTab.area(.calendar)) {
                    Self.stack(.calendar, composition) { CalendarTab.root(composition) }
                }
                .accessibilityIdentifier(AppIdentifiers.calendarTab)
                Tab("tab.journal", systemImage: "book", value: SceneTab.area(.journal)) {
                    Self.stack(.journal, composition) { JournalTab.root(composition) }
                }
                .accessibilityIdentifier(AppIdentifiers.journalTab)
                // Semp's button, which the system draws apart from the tabs at the trailing end of an iPhone's tab
                // bar. It opens no page: the Semp bubble docks over it (`SempDock`) and takes its touches. Where the
                // tab bar is a sidebar or a top bar (iPad, macOS) the bubble floats and the button is not shown.
                Tab("tab.semp", systemImage: "sparkles", value: SceneTab.semp, role: SceneTab.sempRole) {
                    Color.clear
                }
                .hidden(!showsSempTab)
                .accessibilityIdentifier(AppIdentifiers.sempTab)
            }
            .adaptiveTabNavigation()
            // A closure, not a method reference: Swift 6.2.1 crashed reabstracting the actor-isolated opaque view
            // method.
            .onNavigationProvidedView(AppDestination.self) { [weak composition] destination in
                if let composition {
                    // Erased: the nested opaque type of the destinations crashed the Swift 6.2.1 compiler here.
                    AnyView(Self.destinationView(destination, composition: composition))
                }
            }
            .navigationRoot(rootNavigator)
        }
        .sempOverlay(composition)
        .onAppear { composition.currentTab = selectedTab.wrappedValue }
        .onChange(of: selectedTab.wrappedValue) { _, tab in composition.currentTab = tab }
        .onReceive(composition.navigation.tabRequests) { tab in selectedTab.wrappedValue = tab }
        // Signed in: this device registers for pushes and schedules its reminders, and a tapped notification opens.
        .task { await composition.notifications?.refresh() }
        // Once the first tab is on screen, the other tabs read their content ahead of being opened.
        .task {
            try? await Task.sleep(for: .milliseconds(300))
            composition.preparedTabs.prepare(today: AppScene.deviceToday())
        }
        .onReceive(composition.notificationArrivals) { composition.openTappedNotification() }
    }

    /// The device's current day, `YYYY-MM-DD`, as the tabs' screens are given it.
    static func deviceToday(now: Date = Date()) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    /// One tab's navigation stack around `root`; the stack registers itself with the scene's navigation each time its
    /// root appears.
    static func stack<Root: View>(
        _ tab: AppTab,
        _ composition: AppComposition,
        @ViewBuilder root: @escaping () -> Root
    ) -> some View {
        ManagedNavigationStack { navigator in
            root().onAppear { composition.navigation.register(navigator, for: tab) }
        }
    }

    /// The view of `destination`; a sheet gets a Semp bubble of its own, because it covers the one of the scene.
    static func destinationView(_ destination: AppDestination, composition: AppComposition) -> some View {
        destinationContent(destination, composition: composition)
            .sempSheetBubble(composition, enabled: destination.presentsAsSheet)
    }

    @ViewBuilder
    static func destinationContent(_ destination: AppDestination, composition: AppComposition) -> some View {
        switch destination {
        case .pending, .profile, .sempProjectAgent, .sempStatus:
            ShellDestination(destination: destination, composition: composition)
        case .tasks(let start, let tab):
            TasksScreenFactory.tasks(
                makeModel: { composition.models.makeTasks(start: start) },
                router: composition.tasksRouter(in: tab)
            )
        case .details(let target): Self.detailsView(target, composition: composition)
        case .collection(let target):
            CollectionsScreenFactory.collection(
                target,
                makeModel: { composition.models.makeCollection(target: $0) },
                router: composition.collectionsRouter
            )
        case .notes(let itemId, let tab, let trail, let focusTitle):
            NotesDestination(itemId: itemId, tab: tab, trail: trail, focusTitle: focusTitle, composition: composition)
        case .inbox(let tab):
            InboxDestination(tab: tab, composition: composition)
        case .recordings, .transcript, .meeting:
            Self.recordingsDestinationView(destination, composition: composition)
        case .collectionItem(let itemId, let databaseKey):
            CollectionsScreenFactory.item(
                itemId: itemId,
                makeModel: { composition.models.makeItem(itemId: itemId, databaseKey: databaseKey) },
                router: composition.collectionsRouter
            )
        case .itemSheet(let itemId, let databaseKey, let tab):
            CollectionsScreenFactory.itemSheet(
                itemId: itemId,
                makeModel: { composition.models.makeItem(itemId: itemId, databaseKey: databaseKey) },
                router: AppCollectionsRouter(context: composition.navigation, tab: tab, closesSheet: true)
            )
        case .projectTags(let projectId):
            ProjectTagsDestination(projectId: projectId, composition: composition)
        case .projectTag(let projectId, let tagKey):
            ProjectTagDestination(projectId: projectId, tagKey: tagKey, composition: composition)
        case .sleepPlan, .sleepNight, .sleepWakeSettings:
            SleepDestination(destination: destination, composition: composition)
        case .calendars, .invitations, .newItem, .calendarAgenda:
            calendarView(destination, composition: composition)
        case .mailList, .mailThread, .mailFolders, .mailCompose, .projectMailSignals:
            mailView(destination, composition: composition)
        }
    }

    /// The screens and sheets the Calendar tab opens.
    @ViewBuilder
    static func calendarView(_ destination: AppDestination, composition: AppComposition) -> some View {
        switch destination {
        case .calendars:
            CalendarsSheet(composition: composition)
        case .invitations:
            InvitationsSheet(composition: composition)
        case .newItem(let day):
            NewItemSheet(day: day, composition: composition)
        case .calendarAgenda(let day):
            CalendarScreenFactory.agenda(
                day: day,
                makeModel: { composition.models.makeCalendarAgenda(from: $0) },
                router: composition.calendarRouter
            )
        default:
            EmptyView()
        }
    }

    /// The Mail screens, type-erased: with their cases inline the destination provider's result type grows so deep
    /// that the Swift compiler crashes lowering the closure that `tabs` hands to NavigatorUI (the crash `tabs` already
    /// notes for method references).
    static func mailView(_ destination: AppDestination, composition: AppComposition) -> AnyView {
        switch destination {
        case .mailList(let start, let title, let tab):
            AnyView(
                MailScreenFactory.threads(
                    title: title,
                    makeModel: { composition.models.makeMailThreads(start: start) },
                    router: composition.mailRouter(in: tab)
                )
            )
        case .mailThread(let threadId, let tab):
            AnyView(
                MailScreenFactory.thread(
                    makeModel: { composition.models.makeMailThread(threadId: threadId) },
                    router: composition.mailRouter(in: tab)
                )
            )
        case .mailFolders(let tab):
            AnyView(
                MailScreenFactory.folders(
                    makeModel: { composition.models.makeMailFolders() },
                    router: composition.mailRouter(in: tab)
                )
            )
        case .mailCompose(let start):
            AnyView(MailScreenFactory.compose { composition.models.makeMailCompose(start: start) })
        case .projectMailSignals(let projectId):
            AnyView(
                MailScreenFactory.projectSignals { composition.models.makeProjectMailSignals(projectId: projectId) }
            )
        default:
            AnyView(EmptyView())
        }
    }
}
