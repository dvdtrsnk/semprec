import Combine
import CoreKit
import Foundation

/// Thin adapter between the internet accounts screen and its shared screen model: republishes the state, forwards
/// intents and maps each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the
/// model.
@MainActor
final class InternetAccountsViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any InternetAccountsScreenModel
    private let router: any AccountRouting

    // MARK: - Published Properties
    @Published private(set) var state: InternetAccountsState
    /// Counts the accounts that were connected; the add sheet closes whenever it grows.
    @Published private(set) var connections = 0

    // MARK: - Init
    init(model: any InternetAccountsScreenModel, router: any AccountRouting) {
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

    func send(_ action: InternetAccountsAction) {
        model.send(action)
    }

    /// Reloads in place and returns once the list is no longer refreshing, which is what ends a pull to refresh.
    func refresh() async {
        model.send(.refresh)
        for await state in model.states() where !state.refreshing && state.phase != .loading {
            break
        }
    }
}

// MARK: - Private
private extension InternetAccountsViewModel {

    func route(_ effect: InternetAccountsEffect) {
        switch effect {
        case .openAccount(let accountId): router.showInternetAccount(accountId: accountId)
        case .connected: connections += 1
        }
    }
}
