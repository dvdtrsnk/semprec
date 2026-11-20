import Combine
import CoreKit
import Foundation

/// Thin adapter between the internet account screen and its shared screen model: republishes the state, forwards
/// intents, asks the router for the permission to notify when Calendars was switched on, and counts the requests to
/// leave. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class InternetAccountViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any InternetAccountScreenModel
    private let router: any AccountRouting

    // MARK: - Published Properties
    @Published private(set) var state: InternetAccountState
    /// Counts the requests to leave the screen; the screen goes back whenever it grows.
    @Published private(set) var closeRequests = 0

    // MARK: - Init
    init(model: any InternetAccountScreenModel, router: any AccountRouting) {
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

    func send(_ action: InternetAccountAction) {
        model.send(action)
    }
}

// MARK: - Private
private extension InternetAccountViewModel {

    func route(_ effect: InternetAccountEffect) {
        switch effect {
        case .removed: closeRequests += 1
        case .calendarsTurnedOn: router.requestNotificationPermission()
        }
    }
}
