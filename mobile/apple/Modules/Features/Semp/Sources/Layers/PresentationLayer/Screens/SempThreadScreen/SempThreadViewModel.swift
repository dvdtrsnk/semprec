import Combine
import CoreKit
import Foundation

/// Thin adapter between the chat screen and its shared screen model: republishes the state, forwards intents and maps
/// each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class SempThreadViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any SempThreadScreenModel
    private let router: any SempRouting

    // MARK: - Published Properties
    @Published private(set) var state: SempThreadState

    // MARK: - Init
    init(model: any SempThreadScreenModel, router: any SempRouting) {
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

    func send(_ action: SempThreadAction) {
        model.send(action)
    }

    func retry() {
        model.send(.retry)
    }

    /// Asks the chat to read the thread again, for a chat that comes back to the front.
    func refresh() {
        model.send(.refresh)
    }
}

// MARK: - Private
private extension SempThreadViewModel {

    func route(_ effect: SempThreadEffect) {
        switch effect {
        case .openRun(let runId, let messageId): router.showRun(runId: runId, messageId: messageId)
        case .openItem(let itemId, let databaseKey): router.showItem(itemId: itemId, databaseKey: databaseKey)
        case .openApprovals: router.showApprovals()
        case .openStatus: router.showStatus()
        case .openHistory: router.showHistory()
        case .openNewChat: router.showNewChat()
        }
    }
}
