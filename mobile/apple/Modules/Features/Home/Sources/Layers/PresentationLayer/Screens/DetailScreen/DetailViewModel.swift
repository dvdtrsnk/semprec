import Combine
import CoreKit
import Foundation

/// Thin adapter between the Detail screen and its shared screen model: republishes the state and forwards intents.
/// It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class DetailViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any DetailScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: DetailState

    // MARK: - Init
    init(model: any DetailScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state until the screen's task is cancelled. The detail screen has no effects.
    func observe() async {
        await model.observe { [weak self] in self?.state = $0 }
    }

    func retry() {
        model.send(.retry)
    }
}
