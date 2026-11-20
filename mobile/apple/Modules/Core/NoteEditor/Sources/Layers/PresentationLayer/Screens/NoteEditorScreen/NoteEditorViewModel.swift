import Combine
import CoreKit
import Foundation

/// Where the editor puts the cursor next: `offset` UTF-16 units into the text of `blockId`. `request` changes on every
/// move, so the same place asked for twice moves the cursor twice.
struct NoteCaretTarget: Equatable {

    let blockId: String
    let offset: Int
    let request: Int
}

/// Thin adapter between the note editor and its shared screen model: republishes the state, keeps which block is
/// edited, forwards intents and hands the effects to the host. It owns the model; releasing it closes the shared
/// ViewModel behind the model.
@MainActor
final class NoteEditorViewModel: ObservableObject {

    // MARK: - Dependencies
    let variant: NoteEditorVariant
    /// The titles of the pages above this one, outermost first.
    let trail: [String]
    /// Set when the page was just made from an empty block: its title takes the focus.
    let focusTitle: Bool
    private let model: any NoteEditorScreenModel
    private let router: any NoteEditorRouting
    private let onTextChanged: @MainActor (String) -> Void

    // MARK: - Published Properties
    @Published private(set) var state: NoteEditorState
    /// The block being edited; `nil` when nothing is.
    @Published private(set) var editingBlockId: String?
    @Published private(set) var caretTarget: NoteCaretTarget?
    /// A format waiting for the next typed text at the cursor, and the request that set it.
    @Published private(set) var pendingMark: (mark: NoteEditorMark, request: Int)?

    private var requests = 0

    // MARK: - Init
    init(
        variant: NoteEditorVariant,
        trail: [String] = [],
        focusTitle: Bool = false,
        model: any NoteEditorScreenModel,
        router: any NoteEditorRouting,
        onTextChanged: @escaping @MainActor (String) -> Void
    ) {
        self.variant = variant
        self.trail = trail
        self.focusTitle = focusTitle
        self.model = model
        self.router = router
        self.onTextChanged = onTextChanged
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and routes shared effects until the editor's task is cancelled. A change is read as the
    /// model's current state, not the copy it came with: that copy can arrive after `send` already took a newer one,
    /// and showing it would undo what was typed since.
    func observe() async {
        await model.observe(
            onState: { [weak self] _ in
                guard let self else { return }
                apply(model.state)
            },
            onEffect: { [weak self] in self?.route($0) }
        )
    }

    /// The shared layer applies an edit at once, so its state is taken right away: the next key typed already
    /// edits the text the edit left, not the one before it.
    func send(_ action: NoteEditorAction) {
        model.send(action)
        apply(model.state)
    }

    func typing(_ typing: NoteEditorTyping) {
        send(.typing(typing))
    }

    func edit(_ edit: NoteEditorBlockEdit) {
        send(.blocks(edit))
    }

    /// Starts editing `blockId` with the cursor `offset` units into its text.
    func beginEditing(_ blockId: String, at offset: Int) {
        editingBlockId = blockId
        requests += 1
        caretTarget = NoteCaretTarget(blockId: blockId, offset: offset, request: requests)
    }

    /// Ends editing and writes what waits.
    func endEditing() {
        guard editingBlockId != nil else { return }
        editingBlockId = nil
        pendingMark = nil
        send(.flush)
    }

    /// Moves the cursor into the previous (`upward`) or next block that is not a page block, at its end or start.
    func leave(_ blockId: String, upward: Bool) {
        let blocks = state.blocks
        guard let index = blocks.firstIndex(where: { $0.id == blockId }) else { return }
        let others = upward ? Array(blocks[..<index].reversed()) : Array(blocks[(index + 1)...])
        guard let target = others.first(where: { $0.type != .page }) else { return }
        beginEditing(target.id, at: upward ? target.text.utf16.count : 0)
    }

    func clearPendingMark() {
        pendingMark = nil
    }

    // MARK: - Private
    private func apply(_ next: NoteEditorState) {
        guard next != state else { return }
        let moved = next.caretRequest != state.caretRequest
        state = next
        guard moved else { return }
        if let caret = next.caret {
            beginEditing(caret.blockId, at: caret.offset)
        } else {
            editingBlockId = nil
        }
    }

    private func route(_ effect: NoteEditorEffect) {
        switch effect {
        case .openPage(let pageId, let title, let focusTitle):
            router.showPage(pageId: pageId, title: title, trail: trail + [state.title], focusTitle: focusTitle)
        case .pendingMark(let mark):
            requests += 1
            pendingMark = (mark, requests)
        case .textChanged(let markdown):
            onTextChanged(markdown)
        }
    }
}
