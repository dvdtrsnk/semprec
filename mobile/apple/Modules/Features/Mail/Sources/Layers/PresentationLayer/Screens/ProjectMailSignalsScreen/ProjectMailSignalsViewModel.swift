import Combine
import CoreKit
import Foundation

/// Thin adapter between the mail signals screen and its shared screen model: republishes the state and forwards
/// intents. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class ProjectMailSignalsViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any ProjectMailSignalsScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: ProjectMailSignalsState

    // MARK: - Init
    init(model: any ProjectMailSignalsScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state until the screen's task is cancelled; the screen has no effects.
    func observe() async {
        await model.observe(onState: { [weak self] in self?.state = $0 })
    }

    func send(_ action: ProjectMailSignalsAction) {
        model.send(action)
    }
}
