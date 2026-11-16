import Combine
import CoreKit
import Foundation

/// Thin adapter between the area screen and its shared screen model: republishes the state, forwards intents and maps
/// each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class AreaViewModel: ObservableObject {

    // MARK: - Dependencies
    private let areaId: String
    private let model: any AreaScreenModel
    private let router: any AreasRouting

    // MARK: - Published Properties
    @Published private(set) var state: AreaState

    // MARK: - Init
    init(areaId: String, model: any AreaScreenModel, router: any AreasRouting) {
        self.areaId = areaId
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

    func retry() {
        model.send(.retry)
    }

    /// Reloads in place and returns once the content is no longer loading, which is what ends a pull to refresh.
    func refresh() async {
        model.send(.refresh)
        for await state in model.states() {
            if state.phase == .loading { continue }
            break
        }
    }

    func openTasks(todayOnly: Bool) {
        model.send(.openTasks(todayOnly: todayOnly))
    }

    func open(_ upcoming: AreaUpcomingItem) {
        model.send(.openUpcoming(id: upcoming.id))
    }

    func open(_ related: AreaRelatedItem) {
        model.send(.openRelated(databaseId: related.databaseId))
    }

    func openNotes() {
        model.send(.openNotes)
    }

    func setActive(_ isOn: Bool) {
        model.send(.setActive(isOn))
    }

    func dismissFailure() {
        model.send(.dismissFailure)
    }
}

// MARK: - Private
private extension AreaViewModel {

    func route(_ effect: AreaEffect) {
        switch effect {
        case .openTasks(let todayOnly): router.showTasks(areaId: areaId, todayOnly: todayOnly)
        case .openDetails(let kind, let id): router.showDetails(kind: kind, id: id)
        case .openCollection(let target): router.showCollection(target)
        case .openMail: router.showMail(areaId: areaId)
        case .openNotes: router.showNotes(areaId: areaId)
        }
    }
}
