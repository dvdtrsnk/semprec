import Combine
import CoreKit
import Foundation

/// Thin adapter between the notification settings and their shared screen model: republishes the state, forwards
/// intents and hands the request for the permission to notify to the router. It owns the model; releasing it closes
/// the shared ViewModel behind the model.
@MainActor
final class NotificationSettingsViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any NotificationSettingsScreenModel
    private let router: any AccountRouting

    // MARK: - Published Properties
    @Published private(set) var state: NotificationSettingsState

    // MARK: - Init
    init(model: any NotificationSettingsScreenModel, router: any AccountRouting) {
        self.model = model
        self.router = router
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and routes shared effects until the screen's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.route($0) }
        )
    }

    func retry() {
        model.send(.retry)
    }

    func set(_ choice: AccountNotificationSwitch, enabled: Bool) {
        model.send(.set(choice, enabled: enabled))
    }

    func setProblemsLevel(_ level: AccountProblemsLevel) {
        model.send(.setProblemsLevel(level))
    }

    func dismissFailure() {
        model.send(.dismissFailure)
    }
}

// MARK: - Private
private extension NotificationSettingsViewModel {

    func route(_ effect: NotificationSettingsEffect) {
        switch effect {
        case .requestPermission: router.requestNotificationPermission()
        }
    }
}
