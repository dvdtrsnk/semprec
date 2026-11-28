import Combine
import CoreKit
import Foundation

/// Thin adapter between the "Set a new password" sheet and its shared screen model: republishes the state and
/// forwards intents. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class PasswordResetViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any PasswordResetScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: PasswordResetState

    // MARK: - Init
    init(model: any PasswordResetScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state until the screen's task is cancelled.
    func observe() async {
        await model.observe(onState: { [weak self] in self?.state = $0 })
    }

    func edited(newPassword: String, repeated: String) {
        model.send(.edited(newPassword: newPassword, repeated: repeated))
    }

    func submit(newPassword: String, repeated: String) {
        model.send(.submit(newPassword: newPassword, repeated: repeated))
    }
}
