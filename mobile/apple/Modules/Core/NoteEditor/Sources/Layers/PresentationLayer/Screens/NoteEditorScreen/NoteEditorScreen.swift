import CoreKit
import DesignSystem
import SwiftUI

/// The note editor: a full page with its title and meta line, or a light note inside another screen. Blocks follow
/// each other; a tap below the last adds a line or goes into an empty last one. Blocks are swiped, selected and moved
/// by touch (`NoteInteraction`).
struct NoteEditorScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: NoteEditorViewModel
    @StateObject private var interaction = NoteInteraction()
    /// The focus the screen around the note watches; a full page keeps its own.
    @StateObject private var ownFocus = NoteEditorFocus()
    private let givenFocus: NoteEditorFocus?

    // MARK: - State
    @State private var selection: NoteSelection?
    @State private var styledIds: [String]?
    @State private var link: NoteLinkDraft?
    @State private var confirmations = 0
    @State private var hasAppeared = false
    /// The toggles closed on this device.
    @State private var folded: Set<String> = []

    // MARK: - Init
    /// `viewModel` runs once per editor, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> NoteEditorViewModel, focus: NoteEditorFocus? = nil) {
        _viewModel = StateObject(wrappedValue: viewModel())
        givenFocus = focus
    }

    // MARK: - Body
    var body: some View {
        content
            .modifier(NoteOwnFormatBar(focus: givenFocus == nil ? ownFocus : nil))
            .sheet(isPresented: styledBinding) { styleList }
            .modifier(NoteLinkDialog(draft: $link) { address in saveLink(address) })
            .modifier(NotePageTitle(title: viewModel.variant == .full ? state.title : nil))
            .sensoryFeedback(.success, trigger: confirmations)
            .sensoryFeedback(.selection, trigger: interaction.swipe?.step)
            .sensoryFeedback(.selection, trigger: interaction.menu?.highlighted)
            .sensoryFeedback(.selection, trigger: interaction.drag.map { [$0.target, $0.indent] })
            .sensoryFeedback(trigger: NoteSelectionHaptic(interaction)) { old, new in old.feedback(to: new) }
            .sensoryFeedback(.impact(flexibility: .soft), trigger: interaction.holds)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(NoteEditorIdentifiers.editor)
            .task { await viewModel.observe() }
            .onAppear {
                // A page shown again reads what its subpages changed in it.
                if hasAppeared { viewModel.send(.refresh) }
                hasAppeared = true
            }
            .onDisappear {
                // A note that goes while it is edited or its blocks are selected no longer holds the focus it set: the
                // screen around it would otherwise stay focused with nothing left to end.
                if viewModel.editingBlockId != nil { focus.isEditing = false }
                if interaction.selecting { focus.isSelecting = false }
                viewModel.finish()
            }
            .onChange(of: viewModel.editingBlockId) { _, id in
                focus.isEditing = id != nil
                reveal(id)
            }
            .onChange(of: interaction.selecting) { _, selecting in
                focus.isSelecting = selecting
                // Selecting blocks ends typing: the note is either written in or worked on as blocks.
                if selecting { viewModel.endEditing() }
            }
            .onChange(of: selectionKey, initial: true) { focus.selection = selectionActions }
            .onDisappear { focus.selection = nil }
            .onChange(of: formattable) { _, selection in
                focus.formatting = selection.map { selection in
                    NoteFormatting(
                        selection: selection,
                        apply: { viewModel.typing($0) },
                        link: { openLink() },
                        done: { viewModel.endEditing() }
                    )
                }
            }
            .onReceive(focus.$endRequests.dropFirst()) { _ in
                viewModel.endEditing()
                interaction.stopSelecting()
            }
            .toolbar {
                // A full page is a screen of its own, so it shows the check that ends its focus itself.
                if viewModel.variant == .full, givenFocus == nil, ownFocus.isActive {
                    ToolbarItem(placement: .confirmationAction) { NoteFocusDoneButton(focus: ownFocus) }
                }
            }
    }
}

// MARK: - Subviews
private extension NoteEditorScreen {

    var state: NoteEditorState { viewModel.state }

    var focus: NoteEditorFocus { givenFocus ?? ownFocus }

    /// The selected stretch of the edited block's text, when there is one to format.
    var formattable: NoteSelection? {
        guard let selection, !selection.isEmpty, selection.blockId == viewModel.editingBlockId else { return nil }
        return selection
    }

    @ViewBuilder var content: some View {
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let kind):
            StatusView(.failure(message: Text(FailureKind.message(for: kind)), retry: { viewModel.send(.retry) }))
        case .content:
            Group {
                if viewModel.variant == .full {
                    ScrollView { page }
                        .scrollDismissesKeyboard(.interactively)
                        .scrollDisabled(interaction.isActive)
                } else {
                    page
                }
            }
            .coordinateSpace(.named(NoteEditorMetrics.space))
            .onPreferenceChange(NoteRowFramesKey.self) { frames in
                MainActor.assumeIsolated { interaction.rowFrames = frames }
            }
            .onGeometryChange(for: CGSize.self, of: \.size) { size in
                interaction.visible = CGRect(origin: .zero, size: size)
            }
            .overlay(alignment: .topLeading) { overlays }
        }
    }

    var page: some View {
        VStack(alignment: .leading, spacing: 0) {
            if viewModel.variant == .full {
                NoteEditorHeader(
                    state: state,
                    trail: viewModel.trail,
                    hint: hint,
                    focusTitle: viewModel.focusTitle,
                    onRename: { viewModel.send(.setTitle($0)) },
                    onFirstBlock: { if let first = state.blocks.first { viewModel.beginEditing(first.id, at: 0) } }
                )
            }
            if let problem = state.problem { NoteProblemBanner(problem: problem) { viewModel.send(.dismissProblem) } }
            ForEach(NoteFolding.visible(state.blocks, folded: folded)) { block in
                slot(block)
                if showsEmptyToggle(block) {
                    NoteEmptyToggleRow(block: block) { viewModel.typing(.addChild(blockId: block.id)) }
                }
            }
                .animation(.snappy(duration: 0.3), value: state.blocks.map(\.id))
                .animation(.snappy(duration: 0.25), value: folded)
            if !interaction.selecting { tapBelow }
        }
        .padding(.horizontal, viewModel.variant == .full ? Theme.Spacing.medium : 0)
    }

    var hint: LocalizedStringKey? {
        if interaction.selecting { return "noteEditor.hint.selecting" }
        return viewModel.editingBlockId == nil ? nil : "noteEditor.hint.editing"
    }

    func showsEmptyToggle(_ block: NoteEditorBlock) -> Bool {
        guard NoteFolding.folds(block), !folded.contains(block.id), !interaction.selecting,
              let index = state.blocks.firstIndex(where: { $0.id == block.id }) else { return false }
        return NoteFolding.isEmpty(at: index, in: state.blocks)
    }

    func slot(_ block: NoteEditorBlock) -> some View {
        NoteBlockSlot(
            block: block,
            presentation: presentation(of: block),
            isEditing: viewModel.editingBlockId == block.id,
            onDragged: {
                interaction.dragged(
                    block,
                    by: $0,
                    at: $1,
                    editing: viewModel.editingBlockId == block.id,
                    indentFloor: NoteFolding.indentFloor(of: block.id, in: state.blocks)
                )
            },
            onReleased: { perform(interaction.released(block)) },
            onHold: { interaction.hold(block) },
            onHoldMoved: { interaction.holdMoved(block, to: $0, in: state.blocks) },
            onHoldEnded: { perform(interaction.holdEnded(in: state.blocks)) },
            onCancelled: { interaction.cancelled() },
            onToggle: { interaction.toggle(block.id) },
            row: { row(block) }
        )
    }

    func presentation(of block: NoteEditorBlock) -> NoteSlotPresentation {
        NoteSlotPresentation(
            selecting: interaction.selecting,
            isSelected: interaction.selected.contains(block.id),
            swipe: interaction.swipe?.blockId == block.id ? interaction.swipe : nil,
            isDragged: interaction.drag?.blockIds.contains(block.id) ?? false,
            isHeld: interaction.held == block.id
        )
    }

    func row(_ block: NoteEditorBlock) -> some View {
        NoteBlockRow(
            block: block,
            isEditing: viewModel.editingBlockId == block.id,
            isOnlyBlock: state.blocks.count == 1,
            isFolded: folded.contains(block.id),
            caretTarget: viewModel.caretTarget,
            pendingMark: viewModel.pendingMark?.mark,
            onBeginEditing: { viewModel.beginEditing(block.id, at: $0) },
            onTyping: { typing($0) },
            onKey: { key(key: $0, block: block) },
            onSelection: { selection = $0 },
            onBlur: { blurred(block.id) },
            onEdit: { edit($0) },
            onFold: { fold(block.id) }
        )
    }

    @ViewBuilder var overlays: some View {
        if let menu = interaction.menu, let block = state.blocks.first(where: { $0.id == menu.blockId }) {
            GeometryReader { proxy in
                NoteSwipeMenuView(
                    menu: menu,
                    block: block,
                    width: proxy.size.width,
                    onPick: { perform(interaction.pick($0, for: block)) },
                    onClose: { interaction.closeMenu() }
                )
            }
        }
        if let drag = interaction.drag, let first = state.blocks.first(where: { $0.id == drag.blockIds.first }) {
            NoteDropLine(
                top: dropLineY(drag),
                inset: viewModel.variant == .full ? Theme.Spacing.medium : 0,
                indent: drag.indent,
                insideToggle: drag.insideToggle
            )
            NoteDragPreview(block: first, count: drag.blockIds.count, width: interaction.visible.width)
                .offset(y: drag.location.y - (interaction.rowFrames[first.id]?.height ?? 44) / 2)
        }
    }

    /// Where the line showing the place the dragged blocks go to is: at the top of the block they go before, or
    /// under the last block.
    func dropLineY(_ drag: NoteDragState) -> CGFloat {
        let blocks = state.blocks
        if drag.target < blocks.count { return interaction.rowFrames[blocks[drag.target].id]?.minY ?? 0 }
        return blocks.last.flatMap { interaction.rowFrames[$0.id]?.maxY } ?? 0
    }

    var tapBelow: some View {
        Color.clear
            .frame(maxWidth: .infinity, minHeight: viewModel.variant == .full ? 160 : 44)
            .contentShape(Rectangle())
            .onTapGesture { viewModel.send(.tapBelow) }
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(Text("noteEditor.tapBelow", bundle: .module))
            .accessibilityIdentifier(NoteEditorIdentifiers.tapBelow)
    }

    /// What the selection panel shows changes with these.
    var selectionKey: [Int] {
        [interaction.selecting ? 1 : 0, interaction.selected.count, state.blocks.count]
    }

    var selectionActions: NoteSelectionActions? {
        guard interaction.selecting else { return nil }
        return NoteSelectionActions(
            count: interaction.selected.count,
            allSelected: interaction.selected.count == state.blocks.count,
            selectAll: { interaction.selectAll(viewModel.state.blocks) },
            style: { styledIds = interaction.selectedIds(in: viewModel.state.blocks) },
            edit: { bulk in bulkEdit(bulk) }
        )
    }

    var styledBinding: Binding<Bool> {
        Binding(get: { styledIds != nil }, set: { if !$0 { styledIds = nil } })
    }

    var styleList: some View {
        let blocks = state.blocks.filter { styledIds?.contains($0.id) == true }
        let styles = Set(blocks.map { NoteStyleList.Style(type: $0.type, toggle: $0.toggle) })
        return NoteStyleList(
            current: styles.count == 1 ? styles.first : nil,
            offersSubpages: viewModel.variant.offersSubpages && blocks.count == 1,
            onPick: { pick($0, toggle: $1, for: blocks.map(\.id)) }
        )
    }
}

// MARK: - Private
private extension NoteEditorScreen {

    func edit(_ edit: NoteEditorBlockEdit) {
        if case .makeSubpage = edit, !viewModel.variant.offersSubpages { return }
        if case .toggleDone(let blockId) = edit, state.blocks.first(where: { $0.id == blockId })?.done == false {
            confirmations += 1
        }
        guard let edit = NoteFolding.applying(edit, in: state.blocks) else { return }
        viewModel.edit(edit)
        switch edit {
        case .duplicate, .delete, .makeSubpage, .move: confirmations += 1
        default: break
        }
    }

    func perform(_ edits: [NoteEditorBlockEdit]) {
        edits.forEach(edit)
    }

    func bulkEdit(_ bulk: NoteBulkEdit) {
        let ids = interaction.selectedIds(in: state.blocks)
        guard !ids.isEmpty else { return }
        edit(bulk.edit(ids))
        if bulk == .delete { interaction.stopSelecting() }
    }

    func key(key: NoteEditorKey, block: NoteEditorBlock) {
        switch key {
        case .indent(let delta): edit(.shiftIndent(blockIds: [block.id], delta: delta))
        case .previous: viewModel.leave(block.id, upward: true)
        case .next: viewModel.leave(block.id, upward: false)
        case .done: viewModel.endEditing()
        case .link: openLink()
        }
    }

    func pick(_ type: NoteEditorBlockType, toggle: Bool, for ids: [String]) {
        if type == .page, let id = ids.first {
            edit(.makeSubpage(blockId: id))
        } else {
            edit(.setType(blockIds: ids, type: type, toggle: toggle))
        }
    }

    /// Typing, with Enter told whether its block is a closed toggle.
    func typing(_ typing: NoteEditorTyping) {
        if case .enter(let blockId, let offset, _) = typing {
            viewModel.typing(.enter(blockId: blockId, offset: offset, folded: folded.contains(blockId)))
        } else {
            viewModel.typing(typing)
        }
    }

    /// Opens or closes a toggle; closing it ends the editing of a block it hides.
    func fold(_ blockId: String) {
        if folded.remove(blockId) != nil { return }
        folded.insert(blockId)
        if let editing = viewModel.editingBlockId,
           !NoteFolding.visible(state.blocks, folded: folded).contains(where: { $0.id == editing }) {
            viewModel.endEditing()
        }
    }

    /// A block that gets edited is never hidden: the toggles over it open.
    func reveal(_ blockId: String?) {
        guard let blockId, !folded.isEmpty else { return }
        folded = NoteFolding.revealing(blockId, in: state.blocks, folded: folded)
    }

    func openLink() {
        guard let selection else { return }
        link = NoteLinkDraft(address: selection.link ?? "", isExisting: selection.link != nil)
    }

    func saveLink(_ address: String?) {
        guard let selection else { return }
        viewModel.typing(
            .setLink(blockId: selection.blockId, start: selection.start, end: selection.end, address: address)
        )
    }

    /// Editing ends when the edited block loses focus, unless the style list or the link dialog took it.
    func blurred(_ blockId: String) {
        guard viewModel.editingBlockId == blockId, styledIds == nil, link == nil else { return }
        viewModel.endEditing()
    }
}

/// A note that is a screen of its own shows its format bar itself; a note inside another screen leaves it to that
/// screen, whose bar spans the screen.
private struct NoteOwnFormatBar: ViewModifier {

    let focus: NoteEditorFocus?

    func body(content: Content) -> some View {
        if let focus { content.noteFormatBar(focus) } else { content }
    }
}
