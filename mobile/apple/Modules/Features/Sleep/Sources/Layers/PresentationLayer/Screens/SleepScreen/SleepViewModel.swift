import Combine
import CoreKit
import Foundation

/// Thin adapter between the sleep sheet and its shared screen model: republishes the state and forwards intents. It
/// owns the model; releasing it closes the shared ViewModel behind the model. The sheet has no effects; the wake
/// settings row asks the injected router to open them.
@MainActor
final class SleepViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any SleepScreenModel
    private let router: any SleepRouting

    // MARK: - Published Properties
    @Published private(set) var state: SleepState

    // MARK: - Init
    init(model: any SleepScreenModel, router: any SleepRouting) {
        self.model = model
        self.router = router
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state until the screen's task is cancelled.
    func observe() async {
        await model.observe { [weak self] in self?.state = $0 }
    }

    func send(_ action: SleepAction) {
        model.send(action)
    }

    func retry() {
        model.send(.retry)
    }

    func showWakeSettings() {
        router.showWakeSettings()
    }
}
