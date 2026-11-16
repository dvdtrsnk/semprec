import Combine
import CoreKit
import Foundation

/// Thin adapter between the session gate and the shared session screen model: republishes the state and forwards
/// intents. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class SessionViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any SessionScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: SessionState

    // MARK: - Init
    init(model: any SessionScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state until the gate's task is cancelled.
    func observe() async {
        await model.observe(onState: { [weak self] in self?.state = $0 })
    }

    func retry() {
        model.send(.retry)
    }

    func signOut() {
        model.send(.signOut)
    }
}
