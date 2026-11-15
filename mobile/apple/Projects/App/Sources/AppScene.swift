import AuthFeature
import CollectionsFeature
import HomeFeature
import NavigatorUI
import SettingsFeature
import SwiftUI

/// The content of one window: a tab per feature, each with its own navigation stack. Each window creates its own
/// composition, so windows share neither screen models nor navigation.
struct AppScene: View {

    // MARK: - Properties
    @StateObject private var composition: AppComposition
    @State private var rootNavigator = Navigator(configuration: .init())
    @State private var selectedTab: AppTab

    // MARK: - Init
    /// `composition` runs once per scene, when SwiftUI creates the state object. The window opens on `selectedTab`.
    init(composition: @autoclosure @escaping () -> AppComposition = AppComposition(), selectedTab: AppTab = .home) {
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
            Tab("tab.home", systemImage: "house", value: .home) { Self.homeTab(composition) }
                .accessibilityIdentifier(AppIdentifiers.homeTab)
            Tab("tab.settings", systemImage: "gearshape", value: .settings) { Self.settingsTab(composition) }
                .accessibilityIdentifier(AppIdentifiers.settingsTab)
        }
        // A closure, not a method reference: Swift 6.2.1 crashed reabstracting the actor-isolated opaque view method.
        .onNavigationProvidedView(AppDestination.self) { [weak composition] destination in
            if let composition {
                Self.destinationView(destination, composition: composition)
            }
        }
        .navigationRoot(rootNavigator)
    }

    static func homeTab(_ composition: AppComposition) -> some View {
        ManagedNavigationStack { navigator in
            HomeScreenFactory.home(makeModel: { composition.models.makeHome() }, router: composition.homeRouter)
                .onAppear { composition.navigation.register(navigator, for: .home) }
        }
    }

    static func settingsTab(_ composition: AppComposition) -> some View {
        ManagedNavigationStack { navigator in
            SettingsScreenFactory.settings(
                makeModel: { composition.models.makeSettings() },
                router: composition.settingsRouter
            )
            .onAppear { composition.navigation.register(navigator, for: .settings) }
        }
    }

    @ViewBuilder
    static func destinationView(_ destination: AppDestination, composition: AppComposition) -> some View {
        switch destination {
        case .detail(let itemId):
            HomeScreenFactory.detail { composition.models.makeDetail(itemId: itemId) }
        case .about:
            SettingsScreenFactory.about(version: composition.version, build: composition.build)
        case .collection(let target):
            CollectionsScreenFactory.collection(
                target,
                makeModel: { composition.models.makeCollection(target: $0) },
                router: composition.collectionsRouter
            )
        case .collectionItem(let itemId, let databaseKey):
            CollectionsScreenFactory.item(
                itemId: itemId,
                makeModel: { composition.models.makeItem(itemId: itemId, databaseKey: databaseKey) },
                router: composition.collectionsRouter
            )
        }
    }
}
