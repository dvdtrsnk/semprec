import Combine
import CoreKit
import Foundation

/// Thin adapter between the Tasks screen and its shared screen model: republishes the state, forwards intents and
/// maps effects to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class TasksViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any TasksScreenModel
    private let router: any TasksRouting

    // MARK: - Published Properties
    @Published private(set) var state: TasksState

    // MARK: - Init
    init(model: any TasksScreenModel, router: any TasksRouting) {
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

    func send(_ action: TasksAction) {
        model.send(action)
    }
}

// MARK: - Private
private extension TasksViewModel {

    func route(_ effect: TasksEffect) {
        switch effect {
        case .openDetails(let taskId): router.showDetails(taskId: taskId)
        }
    }
}
