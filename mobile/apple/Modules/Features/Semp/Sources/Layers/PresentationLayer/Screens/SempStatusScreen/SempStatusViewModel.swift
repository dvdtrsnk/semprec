import Combine
import CoreKit
import Foundation

/// Thin adapter between the status screen and its shared screen model: republishes the state, forwards intents and
/// maps each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class SempStatusViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any SempStatusScreenModel
    private let router: any SempRouting

    // MARK: - Published Properties
    @Published private(set) var state: SempStatusState

    // MARK: - Init
    init(model: any SempStatusScreenModel, router: any SempRouting) {
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

    func send(_ action: SempStatusAction) {
        model.send(action)
    }

    func retry() {
        model.send(.retry)
    }
}

// MARK: - Private
private extension SempStatusViewModel {

    func route(_ effect: SempStatusEffect) {
        switch effect {
        case .openChat(let threadId, let messageId): router.showChat(threadId: threadId, messageId: messageId)
        case .openThread(let threadId): router.showThread(threadId: threadId, type: .tick, title: nil)
        case .openProject(let projectId): router.showProject(projectId: projectId)
        }
    }
}
