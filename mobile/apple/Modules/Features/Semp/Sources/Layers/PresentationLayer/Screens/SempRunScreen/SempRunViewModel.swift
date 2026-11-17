import Combine
import CoreKit
import Foundation

/// Thin adapter between the run screen and its shared screen model: republishes the state, forwards intents and maps
/// each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class SempRunViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any SempRunScreenModel
    private let router: any SempRouting

    // MARK: - Published Properties
    @Published private(set) var state: SempRunState

    // MARK: - Init
    init(model: any SempRunScreenModel, router: any SempRouting) {
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

    func send(_ action: SempRunAction) {
        model.send(action)
    }

    func retry() {
        model.send(.retry)
    }
}

// MARK: - Private
private extension SempRunViewModel {

    func route(_ effect: SempRunEffect) {
        switch effect {
        case .openThread(let threadId): router.showThread(threadId: threadId, type: .chat, title: nil)
        case .openApprovals: router.showApprovals()
        }
    }
}
