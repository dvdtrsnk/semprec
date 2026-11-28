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

    /// Selects the period of `kind` that starts on `start`, as a tap on it on the axis does.
    func select(kind: JournalPeriodKind, start: String) {
        model.send(.select(kind: kind, start: start))
    }

    /// Asks the shared ViewModel for the period `steps` away from the selected one, of the same kind, and names the
    /// period it selected; `nil` when the selection did not change. The shared ViewModel works out which period that
    /// is and selects it at once.
    func turn(by steps: Int) -> JournalSelection? {
        let before = model.state.selection
        model.send(.turn(steps: steps))
        let after = model.state.selection
        return after == before ? nil : after
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

    func openAttachment(_ item: JournalInboxItem, _ attachment: InboxAttachment) {
        model.send(.openAttachment(entryId: item.id, attachmentId: attachment.id))
    }

    func closeAttachment() {
        model.send(.closeAttachment)
    }
}

// MARK: - Private
private extension JournalViewModel {

    func route(_ effect: JournalEffect) {
        switch effect {
        case .openEvent(let id): router.showEvent(id: id)
        case .openInbox: router.showInbox()
        }
    }
}
