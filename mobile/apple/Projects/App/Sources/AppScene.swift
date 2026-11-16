import AreasFeature
import AuthFeature
import CalendarFeature
import CollectionsFeature
import DesignSystem
import JournalFeature
import NavigatorUI
import NotesFeature
import SleepFeature
import SwiftUI
import TasksFeature

/// The content of one window: a tab per area of the app, each with its own navigation stack. Each window creates its
/// own composition, so windows share neither screen models nor navigation.
struct AppScene: View {

    // MARK: - Properties
    @StateObject private var composition: AppComposition
    @State private var rootNavigator = Navigator(configuration: .init())
    @State private var selectedTab: AppTab

    // MARK: - Init
    /// `composition` runs once per scene, when SwiftUI creates the state object. The window opens on `selectedTab`.
    init(composition: @autoclosure @escaping () -> AppComposition = AppComposition(), selectedTab: AppTab = .overview) {
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
            Self.tabs(composition, rootNavigator: rootNavigator, selectedTab: selectedTab)
        } signedOut: {
            AuthScreenFactory.login(makeModel: { composition.models.makeLogin() })
        }
    }
}

// MARK: - Subviews
private extension AppScene {

    static func tabs(
        _ composition: AppComposition,
        rootNavigator: Navigator,
        selectedTab: Binding<AppTab>
    ) -> some View {
        TabView(selection: selectedTab) {
            Tab("tab.overview", systemImage: "list.bullet.rectangle", value: AppTab.overview) {
                Self.stack(.overview, composition) { OverviewTab.root(composition) }
            }
            .accessibilityIdentifier(AppIdentifiers.overviewTab)
            Tab("tab.calendar", systemImage: "calendar", value: AppTab.calendar) {
                Self.stack(.calendar, composition) { CalendarTab.root(composition) }
            }
            .accessibilityIdentifier(AppIdentifiers.calendarTab)
            Tab("tab.journal", systemImage: "book", value: AppTab.journal) {
                Self.stack(.journal, composition) { JournalTab.root(composition) }
            }
            .accessibilityIdentifier(AppIdentifiers.journalTab)
        }
        .adaptiveTabNavigation()
        // A closure, not a method reference: Swift 6.2.1 crashed reabstracting the actor-isolated opaque view method.
        .onNavigationProvidedView(AppDestination.self) { [weak composition] destination in
            if let composition {
                Self.destinationView(destination, composition: composition)
            }
        }
        .navigationRoot(rootNavigator)
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

    @ViewBuilder
    static func destinationView(_ destination: AppDestination, composition: AppComposition) -> some View {
        switch destination {
        case .pending(let title):
            PendingScreen(title: title)
        case .profile:
            ProfileSheet(models: composition.models)
        case .tasks(let start, let tab):
            TasksScreenFactory.tasks(
                makeModel: { composition.models.makeTasks(start: start) },
                router: composition.tasksRouter(in: tab)
            )
        case .details(let target):
            TasksScreenFactory.details { composition.models.makeItemDetails(kind: target.kind, itemId: target.id) }
        case .collection(let target):
            CollectionsScreenFactory.collection(
                target,
                makeModel: { composition.models.makeCollection(target: $0) },
                router: composition.collectionsRouter
            )
        case .area(let areaId, let tab):
            AreasScreenFactory.area(
                areaId: areaId,
                makeModel: { composition.models.makeArea(areaId: areaId) },
                router: composition.areasRouter(in: tab)
            )
        case .notes(let itemId, let tab):
            NotesScreenFactory.notes(
                itemId: itemId,
                makeModel: { composition.models.makeNotes(itemId: itemId) },
                router: composition.notesRouter(in: tab)
            )
        case .collectionItem(let itemId, let databaseKey):
            CollectionsScreenFactory.item(
                itemId: itemId,
                makeModel: { composition.models.makeItem(itemId: itemId, databaseKey: databaseKey) },
                router: composition.collectionsRouter
            )
        case .sleepPlan(let night):
            SleepScreenFactory.plan { composition.models.makeSleep(night: night, startOnNight: false) }
        case .sleepNight(let night):
            SleepScreenFactory.night { composition.models.makeSleep(night: night, startOnNight: true) }
        case .calendars:
            CalendarsSheet(composition: composition)
        case .invitations:
            InvitationsSheet(composition: composition)
        case .newItem(let day):
            NewItemSheet(day: day, composition: composition)
        case .journalPage(let itemId, let title):
            JournalSubpageScreen(itemId: itemId, title: title, composition: composition)
        }
    }
}
