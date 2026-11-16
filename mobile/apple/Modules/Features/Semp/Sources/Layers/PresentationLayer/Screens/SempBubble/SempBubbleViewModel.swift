import Combine
import CoreKit
import Foundation

/// Thin adapter between the Semp bubble and its shared screen model: republishes the state, forwards what was dropped
/// on it and maps each effect to the router. It owns the model; releasing it closes the shared ViewModel behind it.
@MainActor
final class SempBubbleViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any SempBubbleScreenModel
    private let router: any SempRouting

    // MARK: - Published Properties
    @Published private(set) var state: SempBubbleState

    // MARK: - Init
    init(model: any SempBubbleScreenModel, router: any SempRouting) {
        self.model = model
        self.router = router
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and routes shared effects until the view's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.route($0) }
        )
    }

    /// Reads the number of requests that wait again, for a screen that comes to the front.
    func refresh() {
        model.send(.refresh)
    }

    func drop(_ target: SempTarget) {
        model.send(.drop(target))
    }
}

// MARK: - Private
private extension SempBubbleViewModel {

    func route(_ effect: SempBubbleEffect) {
        switch effect {
        case .openItemThread(let inboxItemId, let title, let meta):
            router.showItemThread(inboxItemId: inboxItemId, title: title, meta: meta)
        }
    }
}
