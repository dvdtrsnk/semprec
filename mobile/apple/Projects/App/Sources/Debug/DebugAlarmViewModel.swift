import Combine
import CoreKit
import Foundation

/// Thin adapter between the debug alarm screen and its shared screen model: republishes the state and forwards
/// intents. It owns the model; releasing it closes the shared ViewModel.
@MainActor
final class DebugAlarmViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any DebugAlarmScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: DebugAlarmState

    // MARK: - Init
    init(model: any DebugAlarmScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state until the screen's task is cancelled.
    func observe() async {
        await model.observe { [weak self] in self?.state = $0 }
    }

    func send(_ action: DebugAlarmAction) {
        model.send(action)
    }
}
