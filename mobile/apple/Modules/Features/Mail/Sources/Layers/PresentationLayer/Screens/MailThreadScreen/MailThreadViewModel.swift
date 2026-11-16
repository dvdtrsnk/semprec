import Combine
import CoreKit
import Foundation

/// Thin adapter between the thread screen and its shared screen model: republishes the state, forwards intents and
/// maps each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class MailThreadViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any MailThreadScreenModel
    private let router: any MailRouting

    // MARK: - Published Properties
    @Published private(set) var state: MailThreadState
    /// Counts the requests to leave the screen; the screen goes back whenever it grows.
    @Published private(set) var closeRequests = 0

    // MARK: - Init
    init(model: any MailThreadScreenModel, router: any MailRouting) {
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

    func send(_ action: MailThreadAction) {
        model.send(action)
    }

    /// Reloads in place and returns once the thread is no longer refreshing, which is what ends a pull to refresh.
    func refresh() async {
        model.send(.refresh)
        for await state in model.states() where !state.refreshing && state.phase != .loading {
            break
        }
    }
}

// MARK: - Private
private extension MailThreadViewModel {

    func route(_ effect: MailThreadEffect) {
        switch effect {
        case .close: closeRequests += 1
        case .compose(let start): router.showCompose(start)
        case .openTask(let taskId): router.showTask(taskId: taskId)
        }
    }
}
