import Combine
import CoreKit
import Foundation

/// Thin adapter between the Home screen and its shared screen model: republishes the state, forwards intents and
/// turns effects into routing. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class HomeViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any HomeScreenModel
    private let router: any HomeRouting

    // MARK: - Published Properties
    @Published private(set) var state: HomeState

    // MARK: - Init
    init(model: any HomeScreenModel, router: any HomeRouting) {
        self.model = model
        self.router = router
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and effects until the screen's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.route($0) }
        )
    }

    func retry() {
        model.send(.retry)
    }

    func select(_ item: PlaceholderItem) {
        model.send(.selectItem(id: item.id))
    }
}

// MARK: - Private
private extension HomeViewModel {

    func route(_ effect: HomeEffect) {
        switch effect {
        case .openDetail(let id): router.showDetail(itemId: id)
        }
    }
}
