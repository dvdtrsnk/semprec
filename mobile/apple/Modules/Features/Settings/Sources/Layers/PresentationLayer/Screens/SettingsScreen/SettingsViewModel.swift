import Combine
import CoreKit
import Foundation

/// Thin adapter between the Settings screen and its shared screen model: republishes the state, forwards intents
/// and turns effects into routing. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class SettingsViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any SettingsScreenModel
    private let router: any SettingsRouting

    // MARK: - Published Properties
    @Published private(set) var state: SettingsState

    // MARK: - Init
    init(model: any SettingsScreenModel, router: any SettingsRouting) {
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

    func select(_ row: SettingsRow) {
        model.send(.selectRow(row))
    }
}

// MARK: - Private
private extension SettingsViewModel {

    func route(_ effect: SettingsEffect) {
        switch effect {
        case .showAbout: router.showAbout()
        }
    }
}
