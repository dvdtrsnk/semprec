@preconcurrency internal import SharedSDK

/// The Kotlin `NotesViewModel` as a `NotesScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedNotesScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.NotesViewModel
    private let effectQueue: EffectQueue<NotesEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.NotesViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedNotesScreenModel: ScreenModel {

    var state: NotesState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<NotesState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<NotesEffect> {
        effectQueue.stream()
    }

    func send(_ action: NotesAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedNotesScreenModel {

    static func state(_ state: SharedSDK.NotesState) -> NotesState {
        NotesState(
            phase: phase(state.phase),
            failure: state.failure.map(FailureKind.init),
            title: state.title,
            blocks: state.blocks.map {
                NoteBlockItem(
                    id: $0.id,
                    type: blockType($0.type),
                    indent: Int($0.indent),
                    done: $0.done,
                    text: $0.text,
                    pageId: $0.pageId,
                    marker: $0.marker
                )
            },
            selecting: state.selecting,
            selected: state.selected,
            working: state.working,
            writeFailure: state.writeFailure.map(Failed.init)
        )
    }

    private static func phase(_ phase: SharedSDK.NotesPhase) -> NotesPhase {
        switch phase {
        case .loading: .loading
        case .content: .content
        case .error: .error
        }
    }

    static func blockType(_ type: SharedSDK.NoteBlockType) -> NoteBlockType {
        switch type {
        case .text: .text
        case .h1: .heading1
        case .h2: .heading2
        case .h3: .heading3
        case .bullet: .bullet
        case .number: .number
        case .todo: .todo
        case .quote: .quote
        case .page: .page
        }
    }

    static func sharedBlockType(_ type: NoteBlockType) -> SharedSDK.NoteBlockType {
        switch type {
        case .text: .text
        case .heading1: .h1
        case .heading2: .h2
        case .heading3: .h3
        case .bullet: .bullet
        case .number: .number
        case .todo: .todo
        case .quote: .quote
        case .page: .page
        }
    }

    static func action(_ action: NotesAction) -> any SharedSDK.NotesAction {
        switch action {
        case .retry: SharedSDK.NotesActionRetry.shared
        case .refresh: SharedSDK.NotesActionRefresh.shared
        case .add(let type, let text, let afterBlockId):
            SharedSDK.NotesActionAdd(type: sharedBlockType(type), text: text, afterBlockId: afterBlockId)
        case .createSubpage(let title, let afterBlockId):
            SharedSDK.NotesActionCreateSubpage(title: title, afterBlockId: afterBlockId)
        case .toggleSelecting: SharedSDK.NotesActionToggleSelecting.shared
        case .toggle(let blockId): SharedSDK.NotesActionToggle(blockId: blockId)
        case .moveSelectedToSubpages: SharedSDK.NotesActionMoveSelectedToSubpages.shared
        case .open(let blockId): SharedSDK.NotesActionOpen(blockId: blockId)
        case .convertToBlock(let blockId, let type):
            SharedSDK.NotesActionConvertToBlock(blockId: blockId, type: sharedBlockType(type))
        case .renameSubpage(let blockId, let title): SharedSDK.NotesActionRenameSubpage(blockId: blockId, title: title)
        case .openAsText: SharedSDK.NotesActionOpenAsText.shared
        case .dismissFailure: SharedSDK.NotesActionDismissFailure.shared
        }
    }

    static func effect(_ effect: any SharedSDK.NotesEffect) -> NotesEffect {
        switch onEnum(of: effect) {
        case .openPage(let page): .openPage(itemId: page.itemId)
        case .openAsText: .openAsText
        }
    }
}
