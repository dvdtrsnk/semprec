import Combine
import CoreKit
import Foundation

/// Thin adapter between the login screen and its shared screen model: republishes the state and forwards intents.
/// It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class LoginViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any LoginScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: LoginState

    // MARK: - Init
    init(model: any LoginScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state until the screen's task is cancelled.
    func observe() async {
        await model.observe(onState: { [weak self] in self?.state = $0 })
    }

    func signIn(server: String, email: String, password: String) {
        model.send(.signIn(server: server, email: email, password: password))
    }

    func forgotPassword(server: String, email: String) {
        model.send(.forgotPassword(server: server, email: email))
    }

    func edited() {
        model.send(.edited)
    }
}
