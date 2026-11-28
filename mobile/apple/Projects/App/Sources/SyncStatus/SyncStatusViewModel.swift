import Combine
import CoreKit
import Foundation

/// Thin adapter between the sync status banner and the shared sync status screen model: republishes the state and
/// forwards the dismissal. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class SyncStatusViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any SyncStatusScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: SyncStatusState

    // MARK: - Init
    init(model: any SyncStatusScreenModel) {
        self.model = model
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state until the banner's task is cancelled.
    func observe() async {
        await model.observe(onState: { [weak self] in self?.state = $0 })
    }

    func dismissFailures() {
        model.send(.dismissFailures)
    }
}
