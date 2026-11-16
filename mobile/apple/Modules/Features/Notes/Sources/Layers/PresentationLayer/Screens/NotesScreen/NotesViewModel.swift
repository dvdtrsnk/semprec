import Combine
import CoreKit
import Foundation

/// Thin adapter between the notes screen and its shared screen model: republishes the state, forwards intents and maps
/// each effect to the router. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class NotesViewModel: ObservableObject {

    // MARK: - Dependencies
    private let itemId: String
    private let model: any NotesScreenModel
    private let router: any NotesRouting

    // MARK: - Published Properties
    @Published private(set) var state: NotesState

    // MARK: - Init
    init(itemId: String, model: any NotesScreenModel, router: any NotesRouting) {
        self.itemId = itemId
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

    /// Reloads in place and returns once the page is no longer loading, which is what ends a pull to refresh.
    func refresh() async {
        model.send(.refresh)
        for await state in model.states() {
            if state.phase == .loading { continue }
            break
        }
    }

    func add(_ type: NoteBlockType, text: String, after blockId: String? = nil) {
        model.send(.add(type, text: text, afterBlockId: blockId))
    }

    func createSubpage(title: String, after blockId: String? = nil) {
        model.send(.createSubpage(title: title, afterBlockId: blockId))
    }

    func toggleSelecting() {
        model.send(.toggleSelecting)
    }

    func toggle(_ block: NoteBlockItem) {
        model.send(.toggle(blockId: block.id))
    }

    func moveSelectedToSubpages() {
        model.send(.moveSelectedToSubpages)
    }

    func open(_ block: NoteBlockItem) {
        model.send(.open(blockId: block.id))
    }

    func convert(_ block: NoteBlockItem, to type: NoteBlockType) {
        model.send(.convertToBlock(blockId: block.id, type: type))
    }

    func rename(_ block: NoteBlockItem, to title: String) {
        model.send(.renameSubpage(blockId: block.id, title: title))
    }

    func openAsText() {
        model.send(.openAsText)
    }

    func dismissFailure() {
        model.send(.dismissFailure)
    }
}

// MARK: - Private
private extension NotesViewModel {

    func route(_ effect: NotesEffect) {
        switch effect {
        case .openPage(let pageId): router.showPage(itemId: pageId)
        case .openAsText: router.showAsText(itemId: itemId)
        }
    }
}
