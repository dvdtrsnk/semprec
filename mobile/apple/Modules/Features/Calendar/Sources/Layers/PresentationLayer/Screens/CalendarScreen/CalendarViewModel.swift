import Combine
import CoreKit
import Foundation

/// Thin adapter between the calendar screen and its shared screen model: republishes the state, forwards intents and
/// turns effects into routing. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class CalendarViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any CalendarScreenModel
    private let router: any CalendarRouting

    // MARK: - Published Properties
    @Published private(set) var state: CalendarState

    // MARK: - Init
    init(model: any CalendarScreenModel, router: any CalendarRouting) {
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

    func send(_ action: CalendarAction) {
        model.send(action)
    }

    func navigate(_ action: CalendarNavigation) {
        model.send(.navigation(action))
    }

    func gesture(_ action: CalendarGesture) {
        model.send(.gesture(action))
    }

    func edit(_ action: CalendarEdit) {
        model.send(.edit(action))
    }

    func open(_ action: CalendarOpen) {
        model.send(.open(action))
    }
}

// MARK: - Private
private extension CalendarViewModel {

    func route(_ effect: CalendarEffect) {
        switch effect {
        case .openDetails(let itemId, let kind, let day): router.showDetails(itemId: itemId, kind: kind, day: day)
        case .openCalendars: router.showCalendars()
        case .openInvitations: router.showInvitations()
        case .openNewItem(let day): router.showNewItem(day: day)
        case .openSleep(let night): router.showSleepNight(night: night)
        }
    }
}
