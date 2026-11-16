import Combine
import CoreKit
import Foundation

/// Thin adapter between the mailboxes screen and its shared screen model: republishes the state, forwards intents and
/// maps each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class MailFoldersViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any MailFoldersScreenModel
    private let router: any MailRouting

    // MARK: - Published Properties
    @Published private(set) var state: MailFoldersState

    // MARK: - Init
    init(model: any MailFoldersScreenModel, router: any MailRouting) {
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

    func send(_ action: MailFoldersAction) {
        model.send(action)
    }

    /// Reloads in place and returns once the screen is no longer refreshing, which is what ends a pull to refresh.
    func refresh() async {
        model.send(.refresh)
        for await state in model.states() where !state.refreshing && state.phase != .loading {
            break
        }
    }
}

// MARK: - Private
private extension MailFoldersViewModel {

    func route(_ effect: MailFoldersEffect) {
        switch effect {
        case .openList(let start, let title): router.showList(start, title: title)
        case .compose: router.showCompose(.new)
        case .openAccounts: router.showAccounts()
        }
    }
}
