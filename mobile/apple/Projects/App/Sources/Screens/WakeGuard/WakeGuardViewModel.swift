import Combine
import CoreKit
import Foundation

/// Thin adapter between one window's wake guard and its shared screen model: republishes the state, forwards intents
/// and counts the effects the screen reacts to. It owns the model; releasing it closes the shared ViewModel.
@MainActor
final class WakeGuardViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any WakeGuardScreenModel

    // MARK: - Published Properties
    @Published private(set) var state: WakeGuardState
    /// How many codes the guard rejected so far; the screen marks the viewfinder for each.
    @Published private(set) var rejections = 0
    /// How many missions the guard ended so far; the screen answers each with a haptic.
    @Published private(set) var finishes = 0

    // MARK: - Init
    init(model: any WakeGuardScreenModel) {
        self.model = model
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

    func send(_ action: WakeGuardAction) {
        model.send(action)
    }
}

// MARK: - Private
private extension WakeGuardViewModel {

    func route(_ effect: WakeGuardEffect) {
        switch effect {
        case .codeRejected: rejections += 1
        case .finished: finishes += 1
        }
    }
}
