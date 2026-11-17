import Combine
import CoreKit
import Foundation

/// Thin adapter between the calendars sheet and its shared screen model: republishes the state, forwards intents and
/// turns effects into routing. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class CalendarListViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any CalendarListScreenModel
    private let router: any CalendarRouting

    // MARK: - Published Properties
    @Published private(set) var state: CalendarListState

    // MARK: - Init
    init(model: any CalendarListScreenModel, router: any CalendarRouting) {
        self.model = model
        self.router = router
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

    func send(_ action: CalendarListAction) {
        model.send(action)
    }

    func retry() {
        model.send(.retry)
    }
}

// MARK: - Private
private extension CalendarListViewModel {

    func route(_ effect: CalendarListEffect) {
        switch effect {
        case .openSleep: router.showSleepPlan()
        }
    }
}
