import Combine
import CoreKit
import Foundation

/// Thin adapter between the thread list and its shared screen model: republishes the state, forwards intents and maps
/// each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class MailThreadsViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any MailThreadsScreenModel
    private let router: any MailRouting

    // MARK: - Published Properties
    @Published private(set) var state: MailThreadsState

    // MARK: - Properties
    private var hasAppeared = false

    // MARK: - Init
    init(model: any MailThreadsScreenModel, router: any MailRouting) {
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

    /// The screen showed again. The first time the list has just been asked for; after that, a thread that was read or
    /// moved may have changed what the list holds, so it reloads in place.
    func appeared() {
        if hasAppeared { model.send(.refresh) }
        hasAppeared = true
    }

    func send(_ action: MailThreadsAction) {
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
private extension MailThreadsViewModel {

    func route(_ effect: MailThreadsEffect) {
        switch effect {
        case .openThread(let threadId): router.showThread(threadId: threadId)
        case .openFolders: router.showFolders()
        case .compose: router.showCompose(.new)
        case .openAccount(let mailboxId): router.showAccount(mailboxId: mailboxId)
        }
    }
}
