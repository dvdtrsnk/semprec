import Combine
import CoreKit
import Foundation

/// Thin adapter between the collection screen and its shared screen model: republishes the state, forwards intents
/// and turns effects into routing. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class CollectionViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any CollectionScreenModel
    private let router: any CollectionsRouting

    // MARK: - Published Properties
    @Published private(set) var state: CollectionState

    // MARK: - Init
    init(model: any CollectionScreenModel, router: any CollectionsRouting) {
        self.model = model
        self.router = router
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and effects until the screen's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.route($0) }
        )
    }

    func send(_ action: CollectionAction) {
        model.send(action)
    }
}

// MARK: - Private
private extension CollectionViewModel {

    func route(_ effect: CollectionEffect) {
        switch effect {
        case .openItem(let itemId, let databaseKey):
            if databaseKey == DatabaseKey.events {
                router.showEvent(itemId: itemId)
            } else {
                router.showItem(itemId: itemId, databaseKey: databaseKey)
            }
        }
    }
}
