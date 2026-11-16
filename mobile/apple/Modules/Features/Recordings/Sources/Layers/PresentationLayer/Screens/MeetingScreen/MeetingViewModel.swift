import Combine
import CoreKit
import Foundation

/// Thin adapter between the page of an event and its shared screen model: republishes the state, forwards intents and
/// maps each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class MeetingViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any MeetingScreenModel
    private let router: any RecordingsRouting

    // MARK: - Published Properties
    @Published private(set) var state: MeetingState

    // MARK: - Init
    init(model: any MeetingScreenModel, router: any RecordingsRouting) {
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

    func send(_ action: MeetingAction) {
        model.send(action)
    }

    /// Reloads in place and returns once the page is no longer loading.
    func refresh() async {
        model.send(.refresh)
        for await state in model.states() {
            if state.phase == .loading { continue }
            break
        }
    }
}

// MARK: - Private
private extension MeetingViewModel {

    func route(_ effect: MeetingEffect) {
        switch effect {
        case .showTask(let taskId): router.showTask(taskId: taskId)
        case .showRecording(let recordingId): router.showTranscript(recordingId: recordingId)
        case .showNotes(let eventId): router.showNotes(eventId: eventId)
        case .showDetails(let eventId): router.showEventDetails(eventId: eventId)
        }
    }
}
