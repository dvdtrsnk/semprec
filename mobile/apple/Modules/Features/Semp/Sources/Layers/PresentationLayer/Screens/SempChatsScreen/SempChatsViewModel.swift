import Combine
import CoreKit
import Foundation

/// Thin adapter between the history screen and its shared screen model: republishes the state, forwards intents and
/// maps each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class SempChatsViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any SempChatsScreenModel
    private let router: any SempRouting

    // MARK: - Published Properties
    @Published private(set) var state: SempChatsState

    // MARK: - Init
    init(model: any SempChatsScreenModel, router: any SempRouting) {
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

    func send(_ action: SempChatsAction) {
        model.send(action)
    }

    func retry() {
        model.send(.retry)
    }
}

// MARK: - Private
private extension SempChatsViewModel {

    func route(_ effect: SempChatsEffect) {
        switch effect {
        case .openThread(let row): router.showThread(threadId: row.id, type: row.type, title: row.title)
        case .openApprovals: router.showApprovals()
        case .openNewChat: router.showNewChat()
        }
    }
}
