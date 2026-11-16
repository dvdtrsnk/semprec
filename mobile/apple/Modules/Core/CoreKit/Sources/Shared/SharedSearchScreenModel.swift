@preconcurrency internal import SharedSDK

/// The Kotlin `SearchViewModel` as a `SearchScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedSearchScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.SearchViewModel
    private let effectQueue: EffectQueue<SearchEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.SearchViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedSearchScreenModel: ScreenModel {

    var state: SearchState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<SearchState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<SearchEffect> {
        effectQueue.stream()
    }

    func send(_ action: SearchAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedSearchScreenModel {

    static func state(_ state: SharedSDK.SearchState) -> SearchState {
        SearchState(
            phase: phase(state),
            scope: state.scope.map(SearchGroupType.init),
            recents: state.recents,
            groups: state.groups.map(group)
        )
    }

    private static func phase(_ state: SharedSDK.SearchState) -> SearchPhase {
        switch state.phase {
        case .recents: .recents
        case .searching: .searching
        case .results: .results
        case .empty: .empty
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    private static func group(_ group: SharedSDK.SearchGroupItem) -> SearchGroup {
        SearchGroup(type: SearchGroupType(group.type), total: Int(group.total), results: group.results.map(result))
    }

    private static func result(_ result: SharedSDK.SearchResultItem) -> SearchResult {
        SearchResult(
            key: result.key,
            itemId: result.itemId,
            threadId: result.threadId,
            databaseKey: result.databaseKey,
            title: result.title,
            subtitle: result.subtitle.map {
                SearchSubtitlePart(kind: SearchSubtitleKind($0.kind), value: $0.value, itemId: $0.itemId)
            },
            snippet: result.snippet,
            journalType: result.journalType,
            journalPeriod: result.journalPeriod
        )
    }

    static func action(_ action: SearchAction) -> any SharedSDK.SearchAction {
        switch action {
        case .queryChanged(let text): SharedSDK.SearchActionQueryChanged(text: text)
        case .selectScope(let scope): SharedSDK.SearchActionSelectScope(scope: scope?.shared)
        case .submit(let text): SharedSDK.SearchActionSubmit(text: text)
        case .retry: SharedSDK.SearchActionRetry.shared
        case .open(let type, let key): SharedSDK.SearchActionOpen(type: type.shared, key: key)
        }
    }

    static func effect(_ effect: any SharedSDK.SearchEffect) -> SearchEffect {
        switch onEnum(of: effect) {
        case .openResult(let result):
            .openResult(
                type: SearchGroupType(result.type),
                itemId: result.itemId,
                threadId: result.threadId,
                databaseKey: result.databaseKey,
                journalType: result.journalType,
                journalPeriod: result.journalPeriod
            )
        }
    }
}
