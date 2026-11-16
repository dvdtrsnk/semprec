import Combine
import CoreKit
import Foundation

/// Thin adapter between the notification settings and their shared screen model: republishes the state and forwards
/// intents. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class NotificationSettingsViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any NotificationSettingsScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: NotificationSettingsState

    // MARK: - Init
    init(model: any NotificationSettingsScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state until the screen's task is cancelled.
    func observe() async {
        await model.observe(onState: { [weak self] in self?.state = $0 })
    }

    func retry() {
        model.send(.retry)
    }

    func set(_ choice: AccountNotificationSwitch, on: Bool) {
        model.send(.set(choice, on: on))
    }

    func setProblemsLevel(_ level: AccountProblemsLevel) {
        model.send(.setProblemsLevel(level))
    }

    func dismissFailure() {
        model.send(.dismissFailure)
    }
}
