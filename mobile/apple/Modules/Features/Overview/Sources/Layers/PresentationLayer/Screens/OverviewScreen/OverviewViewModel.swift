import Combine
import CoreKit
import Foundation

/// Thin adapter between the overview screen and its shared screen model: republishes the state, forwards intents and
/// maps each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class OverviewViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any OverviewScreenModel
    private let router: any OverviewRouting

    // MARK: - Published Properties
    @Published private(set) var state: OverviewState

    // MARK: - Init
    init(model: any OverviewScreenModel, router: any OverviewRouting) {
        self.model = model
        self.router = router
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and routes shared effects until the screen's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.route($0) }
        )
    }

    func open(_ target: OverviewTarget) {
        model.send(.open(target))
    }

    func retry() {
        model.send(.retry)
    }

    /// Reads the overview again in place, without the wait a pull to refresh shows.
    func reload() {
        model.send(.refresh)
    }

    /// Reloads in place and returns once the content is no longer refreshing, which is what ends a pull to refresh.
    func refresh() async {
        model.send(.refresh)
        for await state in model.states() {
            if case .content(let content) = state, content.refreshing { continue }
            break
        }
    }
}

// MARK: - Private
private extension OverviewViewModel {

    func route(_ target: OverviewTarget) {
        router.show(target)
    }
}
