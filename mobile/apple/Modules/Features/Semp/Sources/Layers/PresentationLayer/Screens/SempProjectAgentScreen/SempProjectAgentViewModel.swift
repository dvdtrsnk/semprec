import Combine
import CoreKit
import Foundation

/// Thin adapter between the project agent screen and its shared screen model: republishes the state, forwards intents
/// and maps each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class SempProjectAgentViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any SempProjectAgentScreenModel
    private let router: any SempRouting

    // MARK: - Published Properties
    @Published private(set) var state: SempProjectAgentState

    // MARK: - Init
    init(model: any SempProjectAgentScreenModel, router: any SempRouting) {
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

    func send(_ action: SempProjectAgentAction) {
        model.send(action)
    }

    func retry() {
        model.send(.retry)
    }
}

// MARK: - Private
private extension SempProjectAgentViewModel {

    func route(_ effect: SempProjectAgentEffect) {
        switch effect {
        case .openThread(let threadId): router.showThread(threadId: threadId, type: .tick, title: nil)
        case .openRun(let runId, let messageId): router.showRun(runId: runId, messageId: messageId)
        }
    }
}
