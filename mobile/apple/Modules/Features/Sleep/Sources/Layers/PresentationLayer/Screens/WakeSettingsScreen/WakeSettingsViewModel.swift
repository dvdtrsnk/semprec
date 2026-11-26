import Combine
import CoreKit
import Foundation

/// Thin adapter between the wake settings screen and its shared screen model: republishes the state and forwards
/// intents. It owns the model; releasing it closes the shared ViewModel behind the model. The screen has no effects.
@MainActor
final class WakeSettingsViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any WakeSettingsScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: WakeSettingsState

    // MARK: - Init
    init(model: any WakeSettingsScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state until the screen's task is cancelled.
    func observe() async {
        await model.observe { [weak self] in self?.state = $0 }
    }

    func send(_ action: WakeSettingsAction) {
        model.send(action)
    }
}
