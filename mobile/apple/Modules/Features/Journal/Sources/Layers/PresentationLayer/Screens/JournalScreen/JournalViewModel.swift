import Combine
import CoreKit
import Foundation

/// Thin adapter between the diary screen and its shared screen model: republishes the state, forwards intents and
/// turns effects into routing. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class JournalViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any JournalScreenModel
    private let router: any JournalRouting

    // MARK: - Published Properties
    @Published private(set) var state: JournalState

    // MARK: - Init
    init(model: any JournalScreenModel, router: any JournalRouting) {
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

    func select(_ cell: JournalAxisCell) {
        model.send(.select(kind: cell.kind, start: cell.start))
    }

    func goToday() {
        model.send(.goToday)
    }

    func showAxis(around day: String) {
        model.send(.showAxisAround(day: day))
    }

    func openEvent(_ event: JournalEvent) {
        model.send(.openEvent(id: event.id))
    }

    func openInbox() {
        model.send(.openInbox)
    }

    func openPage(pageId: String, title: String) {
        model.send(.openPage(pageId: pageId, title: title))
    }

    func setText(page: JournalPageRef, index: Int, text: String) {
        model.send(.setText(page: page, index: index, text: text))
    }

    func toggleDone(page: JournalPageRef, index: Int) {
        model.send(.toggleDone(page: page, index: index))
    }

    func addBlock(page: JournalPageRef, kind: JournalBlockKind, text: String) {
        model.send(.addBlock(page: page, kind: kind, text: text))
    }

    func dismissProblem() {
        model.send(.dismissProblem)
    }
}

// MARK: - Private
private extension JournalViewModel {

    func route(_ effect: JournalEffect) {
        switch effect {
        case .openEvent(let id): router.showEvent(id: id)
        case .openInbox: router.showInbox()
        case .openPage(let pageId, let title): router.showPage(itemId: pageId, title: title)
        }
    }
}
