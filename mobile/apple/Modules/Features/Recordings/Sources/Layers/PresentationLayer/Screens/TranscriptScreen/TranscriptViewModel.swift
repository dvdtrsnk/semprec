import Combine
import CoreKit
import Foundation

/// Thin adapter between the transcript screen and its shared screen model: republishes the state, forwards intents and
/// maps each effect to the router. It owns the model; releasing it closes the shared ViewModel, which releases the
/// player.
@MainActor
final class TranscriptViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any TranscriptScreenModel
    private let router: any RecordingsRouting

    // MARK: - Published Properties
    @Published private(set) var state: TranscriptState

    // MARK: - Init
    init(model: any TranscriptScreenModel, router: any RecordingsRouting) {
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

    func send(_ action: TranscriptAction) {
        model.send(action)
    }

    /// Reloads in place and returns once the transcript is no longer loading.
    func refresh() async {
        model.send(.refresh)
        for await state in model.states() {
            if state.phase == .loading { continue }
            break
        }
    }
}

// MARK: - Private
private extension TranscriptViewModel {

    func route(_ effect: TranscriptEffect) {
        switch effect {
        case .openEvent(let eventId): router.showEvent(eventId: eventId)
        }
    }
}
