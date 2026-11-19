import CoreKit
import DesignSystem
import SwiftUI

/// The note editor: a full page with its title and meta line, or a light note inside another screen. Blocks follow
/// each other; a tap below the last adds a line or goes into an empty last one; the bar above the keyboard formats
/// the edited block.
struct NoteEditorScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: NoteEditorViewModel

    // MARK: - State
    @State private var selection: NoteSelection?
    @State private var styledBlockId: String?
    @State private var link: NoteLinkDraft?
    @State private var renaming: NoteEditorBlock?
    @State private var renameTitle = ""
    @State private var confirmations = 0

    // MARK: - Init
    /// `viewModel` runs once per editor, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> NoteEditorViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .safeAreaInset(edge: .bottom) { accessoryBar }
            .sheet(item: styledBinding) { block in
                NoteStyleList(current: block.type, offersSubpages: viewModel.variant.offersSubpages) { type in
                    pick(type, for: block)
                }
            }
            .modifier(NoteLinkDialog(draft: $link) { address in saveLink(address) })
            .alert(
                Text("noteEditor.menu.rename", bundle: .module),
                isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
            ) {
                TextField(text: $renameTitle) { Text("noteEditor.type.page", bundle: .module) }
                Button { rename() } label: { Text("noteEditor.link.save", bundle: .module) }
                Button(role: .cancel) {} label: { Text("noteEditor.cancel", bundle: .module) }
            }
            .sensoryFeedback(.success, trigger: confirmations)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(NoteEditorIdentifiers.editor)
            .task { await viewModel.observe() }
            .onDisappear { viewModel.endEditing() }
    }
}

// MARK: - Subviews
private extension NoteEditorScreen {

    var state: NoteEditorState { viewModel.state }

    @ViewBuilder var content: some View {
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let kind):
            StatusView(.failure(message: Text(FailureKind.message(for: kind)), retry: { viewModel.send(.retry) }))
        case .content:
            if viewModel.variant == .full {
                ScrollView { page }.scrollDismissesKeyboard(.interactively)
            } else {
                page
            }
        }
    }

    var page: some View {
        VStack(alignment: .leading, spacing: 0) {
            if viewModel.variant == .full {
                NoteEditorHeader(state: state) { viewModel.send(.setTitle($0)) }
            }
            if let problem = state.problem { NoteProblemBanner(problem: problem) { viewModel.send(.dismissProblem) } }
            ForEach(state.blocks) { block in row(block) }
            tapBelow
        }
        .padding(.horizontal, viewModel.variant == .full ? Theme.Spacing.medium : 0)
    }

    func row(_ block: NoteEditorBlock) -> some View {
        NoteBlockRow(
            block: block,
            isEditing: viewModel.editingBlockId == block.id,
            isOnlyBlock: state.blocks.count == 1,
            caretTarget: viewModel.caretTarget,
            pendingMark: viewModel.pendingMark?.mark,
            onBeginEditing: { viewModel.beginEditing(block.id, at: $0) },
            onTyping: { viewModel.typing($0) },
            onKey: { key(key: $0, block: block) },
            onSelection: { selection = $0 },
            onBlur: { blurred(block.id) },
            onEdit: { edit($0) },
            onRequest: { request($0, block: block) }
        )
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

    @ViewBuilder var accessoryBar: some View {
        if let id = viewModel.editingBlockId, let block = state.blocks.first(where: { $0.id == id }) {
            NoteAccessoryBar(
                block: block,
                selection: selection?.blockId == id ? selection : nil,
                offersSubpages: viewModel.variant.offersSubpages,
                onTyping: { viewModel.typing($0) },
                onEdit: { edit($0) },
                onStyle: { styledBlockId = id },
                onLink: { openLink() },
                onDone: { viewModel.endEditing() }
            )
        }
    }

    var styledBinding: Binding<NoteEditorBlock?> {
        Binding(
            get: { styledBlockId.flatMap { id in state.blocks.first { $0.id == id } } },
            set: { styledBlockId = $0?.id }
        )
    }
}

// MARK: - Private
private extension NoteEditorScreen {

    func edit(_ edit: NoteEditorBlockEdit) {
        if case .makeSubpage = edit, !viewModel.variant.offersSubpages { return }
        viewModel.edit(edit)
        switch edit {
        case .duplicate, .delete, .makeSubpage: confirmations += 1
        default: break
        }
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

    func request(_ request: NoteBlockRequest, block: NoteEditorBlock) {
        switch request {
        case .style: styledBlockId = block.id
        case .rename:
            renameTitle = block.text
            renaming = block
        }
    }

    func pick(_ type: NoteEditorBlockType, for block: NoteEditorBlock) {
        if type == .page {
            edit(.makeSubpage(blockId: block.id))
        } else {
            edit(.setType(blockIds: [block.id], type: type))
        }
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
        guard viewModel.editingBlockId == blockId, styledBlockId == nil, link == nil else { return }
        viewModel.endEditing()
    }

    func rename() {
        guard let block = renaming else { return }
        viewModel.typing(.setRuns(blockId: block.id, runs: [NoteEditorRun(renameTitle)]))
        renaming = nil
    }
}
