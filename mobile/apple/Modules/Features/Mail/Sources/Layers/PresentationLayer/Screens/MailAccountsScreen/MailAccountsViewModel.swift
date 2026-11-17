import Combine
import CoreKit
import Foundation

/// Thin adapter between the accounts screen and its shared screen model: republishes the state, forwards intents and
/// maps each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class MailAccountsViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any MailAccountsScreenModel
    private let router: any MailRouting

    // MARK: - Published Properties
    @Published private(set) var state: MailAccountsState
    /// Counts the mailboxes that were connected; the form closes whenever it grows.
    @Published private(set) var connections = 0

    // MARK: - Init
    init(model: any MailAccountsScreenModel, router: any MailRouting) {
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

    func send(_ action: MailAccountsAction) {
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
private extension MailAccountsViewModel {

    func route(_ effect: MailAccountsEffect) {
        switch effect {
        case .openAccount(let mailboxId): router.showAccount(mailboxId: mailboxId)
        case .connected: connections += 1
        }
    }
}
