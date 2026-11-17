@preconcurrency internal import SharedSDK

/// The Kotlin `AreaViewModel` as an `AreaScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedAreaScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.AreaViewModel
    private let effectQueue: EffectQueue<AreaEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.AreaViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedAreaScreenModel: ScreenModel {

    var state: AreaState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<AreaState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<AreaEffect> {
        effectQueue.stream()
    }

    func send(_ action: AreaAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedAreaScreenModel {

    static func state(_ state: SharedSDK.AreaState) -> AreaState {
        AreaState(
            phase: phase(state.phase),
            failure: state.failure.map(FailureKind.init),
            name: state.name,
            color: state.color,
            icon: state.icon,
            active: state.active,
            activeSaving: state.activeSaving,
            tasksToday: Int(state.tasksToday),
            tasksOpen: Int(state.tasksOpen),
            eventsSoon: Int(state.eventsSoon),
            upcoming: state.upcoming.map {
                AreaUpcomingItem(
                    kind: ItemKind($0.kind),
                    id: $0.id,
                    title: $0.title,
                    date: $0.date,
                    timeFrom: $0.timeFrom,
                    timeTo: $0.timeTo,
                    projectTitle: $0.projectTitle,
                    projectColor: $0.projectColor
                )
            },
            related: state.related.map {
                AreaRelatedItem(
                    databaseId: $0.databaseId,
                    databaseKey: $0.databaseKey,
                    name: $0.name,
                    icon: $0.icon,
                    color: $0.color,
                    count: Int($0.count)
                )
            },
            writeFailure: state.writeFailure.map(Failed.init)
        )
    }

    private static func phase(_ phase: SharedSDK.AreaPhase) -> AreaPhase {
        switch phase {
        case .loading: .loading
        case .content: .content
        case .error: .error
        }
    }

    static func action(_ action: AreaAction) -> any SharedSDK.AreaAction {
        switch action {
        case .retry: SharedSDK.AreaActionRetry.shared
        case .refresh: SharedSDK.AreaActionRefresh.shared
        case .openTasks(let todayOnly): SharedSDK.AreaActionOpenTasks(todayOnly: todayOnly)
        case .openUpcoming(let id): SharedSDK.AreaActionOpenUpcoming(id: id)
        case .openRelated(let databaseId): SharedSDK.AreaActionOpenRelated(databaseId: databaseId)
        case .openNotes: SharedSDK.AreaActionOpenNotes.shared
        case .setActive(let isOn): SharedSDK.AreaActionSetActive(on: isOn)
        case .dismissFailure: SharedSDK.AreaActionDismissFailure.shared
        }
    }

    static func effect(_ effect: any SharedSDK.AreaEffect) -> AreaEffect {
        switch onEnum(of: effect) {
        case .openTasks(let tasks): .openTasks(todayOnly: tasks.todayOnly)
        case .openDetails(let details): .openDetails(kind: ItemKind(details.kind), id: details.id)
        case .openCollection(let collection): .openCollection(target(collection.target))
        case .openMail: .openMail
        case .openNotes: .openNotes
        }
    }

    static func target(_ target: any SharedSDK.CollectionTarget) -> CollectionTarget {
        switch onEnum(of: target) {
        case .whole(let whole): .whole(databaseKey: whole.databaseKey, databaseId: whole.databaseId)
        case .ofArea(let area): .ofArea(databaseKey: area.databaseKey, areaId: area.areaId)
        case .ofItem(
            let item
        ): .ofItem(databaseKey: item.databaseKey, relationKey: item.relationKey, itemId: item.itemId)
        case .matching(let matching):
            .matching(
                databaseKey: matching.databaseKey,
                databaseId: matching.databaseId,
                filterJson: matching.filterJson
            )
        }
    }
}
