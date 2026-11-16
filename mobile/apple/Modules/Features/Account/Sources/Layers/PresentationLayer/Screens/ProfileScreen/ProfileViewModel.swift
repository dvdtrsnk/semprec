import Combine
import CoreKit
import Foundation

/// Thin adapter between the profile screen and its shared screen model: republishes the state, forwards intents and
/// maps each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class ProfileViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any ProfileScreenModel
    private let router: any AccountRouting

    // MARK: - Published Properties
    @Published private(set) var state: ProfileState

    // MARK: - Init
    init(model: any ProfileScreenModel, router: any AccountRouting) {
        self.model = model
        self.router = router
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and routes shared effects until the screen's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.router.show($0) }
        )
    }

    func open(_ page: AccountPage) {
        model.send(.open(page))
    }

    func retry() {
        model.send(.retry)
    }

    func changeLocale(_ locale: String) {
        model.send(.changeLocale(locale))
    }

    func requestPasswordReset() {
        model.send(.requestPasswordReset)
    }

    func signOut() {
        model.send(.signOut)
    }

    func dismissFailure() {
        model.send(.dismissFailure)
    }
}
