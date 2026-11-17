import Combine
import CoreKit
import Foundation

/// Thin adapter between the agenda screen and its shared screen model: republishes the state, forwards intents and
/// turns effects into routing. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class CalendarAgendaViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any CalendarAgendaScreenModel
    private let router: any CalendarRouting

    // MARK: - Published Properties
    @Published private(set) var state: CalendarAgendaState

    // MARK: - Init
    init(model: any CalendarAgendaScreenModel, router: any CalendarRouting) {
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

    func retry() {
        model.send(.retry)
    }

    func loadMore() {
        model.send(.loadMore)
    }

    func open(_ entry: CalendarAgendaEntry) {
        model.send(.open(id: entry.id))
    }

    // MARK: - Private
    private func route(_ effect: CalendarAgendaEffect) {
        switch effect {
        case .openDetails(let kind, let id):
            let day = state.days.first { $0.entries.contains { $0.id == id } }?.day ?? ""
            router.showDetails(itemId: id, kind: kind == .event ? .event : .task, day: day)
        }
    }
}
