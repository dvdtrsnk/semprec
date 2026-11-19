@preconcurrency internal import SharedSDK

/// The Kotlin `NoteEditorViewModel` as a `NoteEditorScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedNoteEditorScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.NoteEditorViewModel
    private let effectQueue: EffectQueue<NoteEditorEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.NoteEditorViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedNoteEditorScreenModel: ScreenModel {

    var state: NoteEditorState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<NoteEditorState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<NoteEditorEffect> {
        effectQueue.stream()
    }

    func send(_ action: NoteEditorAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedNoteEditorScreenModel {

    static func state(_ state: SharedSDK.NoteEditorState) -> NoteEditorState {
        NoteEditorState(
            phase: NoteEditorPhase(state.phase, failure: state.failure),
            title: state.title,
            titleEditable: state.titleEditable,
            blocks: state.blocks.map(NoteEditorBlock.init),
            wordCount: Int(state.wordCount),
            lastEditedAt: state.lastEditedAt,
            saving: state.saving,
            working: state.working,
            problem: NoteEditorProblem(state.problem, failure: state.problemFailure),
            caret: state.caret.map { NoteEditorCaret(blockId: $0.blockId, offset: Int($0.offset)) },
            caretRequest: Int(state.caretRequest)
        )
    }

    static func action(_ action: NoteEditorAction) -> any SharedSDK.NoteEditorAction {
        switch action {
        case .retry: SharedSDK.NoteEditorActionRetry.shared
        case .refresh: SharedSDK.NoteEditorActionRefresh.shared
        case .dismissProblem: SharedSDK.NoteEditorActionDismissProblem.shared
        case .typing(let typing): Self.typing(typing)
        case .blocks(let edit): Self.blocks(edit)
        case .tapBelow: SharedSDK.NoteEditorActionTapBelow.shared
        case .setTitle(let title): SharedSDK.NoteEditorActionSetTitle(title: title)
        case .flush: SharedSDK.NoteEditorActionFlush.shared
        }
    }

    static func effect(_ effect: any SharedSDK.NoteEditorEffect) -> NoteEditorEffect {
        switch onEnum(of: effect) {
        case .openPage(let open): .openPage(pageId: open.pageId, title: open.title, focusTitle: open.focusTitle)
        case .pendingMark(let pending): .pendingMark(NoteEditorMark(pending.mark))
        case .textChanged(let changed): .textChanged(changed.markdown)
        }
    }

    static func source(_ source: NoteEditorSource) -> any SharedSDK.NoteEditorSource {
        switch source {
        case .page(let itemId, let titleEditable):
            SharedSDK.NoteEditorSourcePage(itemId: itemId, titleEditable: titleEditable)
        case .journal(let kind, let period): SharedSDK.NoteEditorSourceJournal(kind: kind.shared, period: period)
        case .text(let markdown): SharedSDK.NoteEditorSourceText(markdown: markdown)
        }
    }
}

// MARK: - Action groups
private extension SharedNoteEditorScreenModel {

    static func typing(_ action: NoteEditorTyping) -> any SharedSDK.NoteEditorAction {
        switch action {
        case .setRuns(let blockId, let runs):
            SharedSDK.NoteEditorActionSetRuns(blockId: blockId, runs: runs.map(\.shared))
        case .enter(let blockId, let offset): SharedSDK.NoteEditorActionEnter(blockId: blockId, offset: Int32(offset))
        case .backspaceAtStart(let blockId): SharedSDK.NoteEditorActionBackspaceAtStart(blockId: blockId)
        case .deleteAtEnd(let blockId): SharedSDK.NoteEditorActionDeleteAtEnd(blockId: blockId)
        case .commandEnter(let blockId): SharedSDK.NoteEditorActionCommandEnter(blockId: blockId)
        case .paste(let blockId, let offset, let text):
            SharedSDK.NoteEditorActionPaste(blockId: blockId, offset: Int32(offset), text: text)
        case .toggleMark(let blockId, let start, let end, let mark):
            SharedSDK.NoteEditorActionToggleMark(
                blockId: blockId, start: Int32(start), end: Int32(end), mark: mark.shared
            )
        case .setLink(let blockId, let start, let end, let address):
            SharedSDK.NoteEditorActionSetLink(blockId: blockId, start: Int32(start), end: Int32(end), address: address)
        }
    }

    static func blocks(_ action: NoteEditorBlockEdit) -> any SharedSDK.NoteEditorAction {
        switch action {
        case .setType(let ids, let type): SharedSDK.NoteEditorActionSetType(blockIds: ids, type: type.shared)
        case .toggleType(let ids, let type): SharedSDK.NoteEditorActionToggleType(blockIds: ids, type: type.shared)
        case .shiftIndent(let ids, let delta): SharedSDK.NoteEditorActionShiftIndent(blockIds: ids, delta: Int32(delta))
        case .toggleDone(let blockId): SharedSDK.NoteEditorActionToggleDone(blockId: blockId)
        case .move(let ids, let index): SharedSDK.NoteEditorActionMove(blockIds: ids, targetIndex: Int32(index))
        case .duplicate(let ids): SharedSDK.NoteEditorActionDuplicate(blockIds: ids)
        case .delete(let ids): SharedSDK.NoteEditorActionDelete(blockIds: ids)
        case .makeSubpage(let blockId): SharedSDK.NoteEditorActionMakeSubpage(blockId: blockId)
        case .openPage(let blockId): SharedSDK.NoteEditorActionOpenPage(blockId: blockId)
        }
    }
}
