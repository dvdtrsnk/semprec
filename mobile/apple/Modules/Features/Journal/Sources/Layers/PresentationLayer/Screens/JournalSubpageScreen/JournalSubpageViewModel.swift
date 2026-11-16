import Combine
import CoreKit
import Foundation

/// Thin adapter between a diary subpage and its shared screen model: republishes the state, forwards intents and
/// turns effects into routing. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class JournalSubpageViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any JournalSubpageScreenModel
    private let router: any JournalRouting

    // MARK: - Published Properties
    @Published private(set) var state: JournalSubpageState

    // MARK: - Init
    init(model: any JournalSubpageScreenModel, router: any JournalRouting) {
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

    func openPage(pageId: String, title: String) {
        model.send(.openPage(pageId: pageId, title: title))
    }

    func setText(index: Int, text: String) {
        model.send(.setText(index: index, text: text))
    }

    func toggleDone(index: Int) {
        model.send(.toggleDone(index: index))
    }

    func addBlock(kind: JournalBlockKind, text: String) {
        model.send(.addBlock(kind: kind, text: text))
    }

    func dismissProblem() {
        model.send(.dismissProblem)
    }
}

// MARK: - Private
private extension JournalSubpageViewModel {

    func route(_ effect: JournalSubpageEffect) {
        switch effect {
        case .openPage(let pageId, let title): router.showPage(itemId: pageId, title: title)
        }
    }
}
