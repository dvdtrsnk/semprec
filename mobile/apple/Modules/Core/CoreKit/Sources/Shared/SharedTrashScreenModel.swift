@preconcurrency internal import SharedSDK

/// The Kotlin `TrashViewModel` as a `TrashScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedTrashScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.TrashViewModel
    private let effectQueue: EffectQueue<TrashEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.TrashViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedTrashScreenModel: ScreenModel {

    var state: TrashState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<TrashState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<TrashEffect> {
        effectQueue.stream()
    }

    func send(_ action: TrashAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedTrashScreenModel {

    static func state(_ state: SharedSDK.TrashState) -> TrashState {
        TrashState(
            phase: phase(state.phase),
            failure: state.failure.map(FailureKind.init),
            tab: tab(state.tab),
            items: state.items.map {
                TrashItemRow(
                    id: $0.id,
                    title: $0.title,
                    databaseKey: $0.databaseKey,
                    databaseName: $0.databaseName,
                    deletedAt: $0.deletedAt,
                    daysLeft: Int($0.daysLeft)
                )
            },
            databases: state.databases.map {
                TrashDatabaseRow(
                    id: $0.id,
                    name: $0.name,
                    itemCount: Int($0.itemCount),
                    archivedAt: $0.archivedAt,
                    daysLeft: $0.daysLeft.map { Int(truncating: $0) }
                )
            },
            totalItems: Int(state.totalItems),
            hasMore: state.hasMore,
            loadingMore: state.loadingMore,
            selecting: state.selecting,
            selected: state.selected,
            working: state.working,
            writeFailure: state.writeFailure.map(Failed.init)
        )
    }

    private static func phase(_ phase: SharedSDK.TrashPhase) -> TrashPhase {
        switch phase {
        case .loading: .loading
        case .content: .content
        case .error: .error
        }
    }

    static func tab(_ tab: SharedSDK.TrashTab) -> TrashTab {
        switch tab {
        case .items: .items
        case .databases: .databases
        }
    }

    static func sharedTab(_ tab: TrashTab) -> SharedSDK.TrashTab {
        switch tab {
        case .items: .items
        case .databases: .databases
        }
    }

    static func effect(_ effect: any SharedSDK.TrashEffect) -> TrashEffect {
        switch onEnum(of: effect) {
        case .restored(let restored):
            .restored(
                restored: Int(restored.restored),
                refused: Int(restored.refused),
                databaseName: restored.databaseName
            )
        }
    }

    static func action(_ action: TrashAction) -> any SharedSDK.TrashAction {
        switch action {
        case .retry: SharedSDK.TrashActionRetry.shared
        case .selectTab(let tab): SharedSDK.TrashActionSelectTab(tab: sharedTab(tab))
        case .loadMore: SharedSDK.TrashActionLoadMore.shared
        case .toggleSelecting: SharedSDK.TrashActionToggleSelecting.shared
        case .toggle(let id): SharedSDK.TrashActionToggle(id: id)
        case .selectAll: SharedSDK.TrashActionSelectAll.shared
        case .restore(let id): SharedSDK.TrashActionRestore(id: id)
        case .restoreSelected: SharedSDK.TrashActionRestoreSelected.shared
        case .dismissFailure: SharedSDK.TrashActionDismissFailure.shared
        }
    }
}
