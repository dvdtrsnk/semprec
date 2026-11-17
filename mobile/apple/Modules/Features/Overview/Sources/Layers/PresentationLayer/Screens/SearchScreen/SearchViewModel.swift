import Combine
import CoreKit
import Foundation

/// Thin adapter between the search overlay and its shared screen model: republishes the state, forwards intents and
/// maps the opened result to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class SearchViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any SearchScreenModel
    private let router: any OverviewRouting

    // MARK: - Published Properties
    @Published private(set) var state: SearchState

    // MARK: - Init
    init(model: any SearchScreenModel, router: any OverviewRouting) {
        self.model = model
        self.router = router
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and routes shared effects until the overlay's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.route($0) }
        )
    }

    func queryChanged(_ text: String) {
        model.send(.queryChanged(text))
    }

    func selectScope(_ scope: SearchGroupType?) {
        model.send(.selectScope(scope))
    }

    func submit(_ text: String) {
        model.send(.submit(text))
    }

    func retry() {
        model.send(.retry)
    }

    func open(_ result: SearchResult, in type: SearchGroupType) {
        model.send(.open(type: type, key: result.key))
    }
}

// MARK: - Private
private extension SearchViewModel {

    func route(_ effect: SearchEffect) {
        switch effect {
        case .openResult(let type, let itemId, let threadId, let databaseKey, let journalType, let journalPeriod):
            router.showSearchResult(
                SearchResultLink(
                    type: type,
                    itemId: itemId,
                    threadId: threadId,
                    databaseKey: databaseKey,
                    journalType: journalType,
                    journalPeriod: journalPeriod
                )
            )
        }
    }
}
