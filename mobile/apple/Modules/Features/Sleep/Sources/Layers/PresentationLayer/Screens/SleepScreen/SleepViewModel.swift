import Combine
import CoreKit
import Foundation

/// Thin adapter between the sleep sheet and its shared screen model: republishes the state and forwards intents. It
/// owns the model; releasing it closes the shared ViewModel behind the model. The sheet has no effects.
@MainActor
final class SleepViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any SleepScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: SleepState

    // MARK: - Init
    init(model: any SleepScreenModel) {
        self.model = model
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
}
