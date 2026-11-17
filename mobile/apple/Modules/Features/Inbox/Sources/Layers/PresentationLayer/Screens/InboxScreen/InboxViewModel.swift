import Combine
import CoreKit
import Foundation

/// Thin adapter between the Inbox screen and its shared screen model: republishes the state, forwards intents and
/// maps effects to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class InboxViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any InboxScreenModel
    private let router: any InboxRouting

    // MARK: - Published Properties
    @Published private(set) var state: InboxState

    // MARK: - Init
    init(model: any InboxScreenModel, router: any InboxRouting) {
        self.model = model
        self.router = router
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and routes effects until the screen's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.route($0) }
        )
    }

    func send(_ action: InboxAction) {
        model.send(action)
    }
}

// MARK: - Private
private extension InboxViewModel {

    func route(_ effect: InboxEffect) {
        switch effect {
        case .openItem(let databaseKey, let itemId): router.showItem(databaseKey: databaseKey, itemId: itemId)
        }
    }
}
