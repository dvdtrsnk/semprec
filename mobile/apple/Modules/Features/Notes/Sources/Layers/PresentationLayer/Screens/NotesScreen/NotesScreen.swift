import CoreKit
import DesignSystem
import SwiftUI

/// A page of notes: its blocks as the server holds them, a composer that adds a block at the end, subpages that open
/// as pages of their own, and blocks that can be moved into subpages. Editing the text of a block as a whole page is
/// the editor of the item (`Edit as text`).
struct NotesScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: NotesViewModel

    // MARK: - State
    @State private var draft = ""
    @State private var draftType = NoteBlockType.text
    @State private var asksSubpageTitle = false
    @State private var subpageTitle = ""
    @State private var renaming: NoteBlockItem?
    @State private var renameTitle = ""

    // MARK: - Init
    /// `viewModel` runs once per screen, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> NotesViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .background(Theme.Colors.groupedBackground)
            .navigationTitle(Text(viewModel.state.title))
            .inlineNavigationTitle()
            .toolbar { toolbar }
            .alert(Text("notes.newSubpage", bundle: .module), isPresented: $asksSubpageTitle) {
                TextField(text: $subpageTitle) { Text("notes.subpageTitle", bundle: .module) }
                    .accessibilityIdentifier(NotesIdentifiers.subpageTitle)
                Button { viewModel.createSubpage(title: subpageTitle) } label: { Text("notes.create", bundle: .module) }
                Button(role: .cancel) {} label: { Text("notes.cancel", bundle: .module) }
            }
            .alert(
                Text("notes.rename", bundle: .module),
                isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
            ) {
                TextField(text: $renameTitle) { Text("notes.subpageTitle", bundle: .module) }
                Button { if let block = renaming { viewModel.rename(block, to: renameTitle) } } label: {
                    Text("notes.save", bundle: .module)
                }
                Button(role: .cancel) {} label: { Text("notes.cancel", bundle: .module) }
            }
            .alert(
                Text("notes.failed", bundle: .module),
                isPresented: Binding(
                    get: { viewModel.state.writeFailure != nil },
                    set: { _ in viewModel.dismissFailure() }
                )
            ) {
                Button(role: .cancel) {} label: { Text("common.ok", bundle: .module) }
            } message: {
                Text(FailureKind.message(for: viewModel.state.writeFailure?.kind))
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(NotesIdentifiers.screen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension NotesScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(
                .failure(message: Text(FailureKind.message(for: viewModel.state.failure)), retry: { viewModel.retry() })
            )
        case .content:
            VStack(spacing: 0) {
                page
                if viewModel.state.selecting { moveBar } else { composer }
            }
        }
    }

    @ViewBuilder var page: some View {
        if viewModel.state.blocks.isEmpty {
            StatusView(.empty(message: Text("notes.empty", bundle: .module), systemImage: "note.text"))
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Theme.Spacing.small) {
                    ForEach(viewModel.state.blocks) { block in
                        row(block)
                    }
                }
                .padding(Theme.Spacing.medium)
            }
            .refreshable { await viewModel.refresh() }
        }
    }

    func row(_ block: NoteBlockItem) -> some View {
        let selected = viewModel.state.selected.contains(block.id)
        return HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.small) {
            if viewModel.state.selecting && block.type != .page {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? Theme.Colors.accent : Theme.Colors.secondaryText)
                    .accessibilityAddTraits(selected ? .isSelected : [])
            }
            NoteBlockView(block: block)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if viewModel.state.selecting { viewModel.toggle(block) } else { viewModel.open(block) }
        }
        .contextMenu { menu(for: block) }
        .accessibilityAddTraits(block.type == .page ? .isButton : [])
        .accessibilityIdentifier(NotesIdentifiers.blockPrefix + block.id)
    }

    @ViewBuilder
    func menu(for block: NoteBlockItem) -> some View {
        if block.type == .page {
            Button { viewModel.open(block) } label: {
                Label { Text("notes.open", bundle: .module) } icon: { Image(systemName: "doc.text") }
            }
            Button {
                renameTitle = NoteInline.plain(block.text)
                renaming = block
            } label: {
                Label { Text("notes.rename", bundle: .module) } icon: { Image(systemName: "pencil") }
            }
            Button { viewModel.convert(block, to: .text) } label: {
                Label { Text("notes.convert", bundle: .module) } icon: { Image(systemName: "text.alignleft") }
            }
        }
    }

    var composer: some View {
        HStack(spacing: Theme.Spacing.small) {
            Menu {
                Picker(selection: $draftType) {
                    ForEach(Self.composerTypes, id: \.self) { type in
                        Label { Text(Self.name(of: type)) } icon: { Image(systemName: Self.symbol(of: type)) }.tag(type)
                    }
                } label: {
                    Text("notes.composer.type", bundle: .module)
                }
            } label: {
                Image(systemName: Self.symbol(of: draftType)).frame(width: 28, height: 28)
            }
            .accessibilityLabel(Text("notes.composer.type", bundle: .module))
            .accessibilityIdentifier(NotesIdentifiers.composerType)
            TextField(text: $draft, axis: .vertical) { Text("notes.composer.placeholder", bundle: .module) }
                .textFieldStyle(.roundedBorder)
                .onSubmit(send)
                .accessibilityIdentifier(NotesIdentifiers.composerField)
            Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || viewModel.state.working)
                .accessibilityLabel(Text("notes.composer.send", bundle: .module))
                .accessibilityIdentifier(NotesIdentifiers.composerSend)
        }
        .padding(Theme.Spacing.small)
        .background(.bar)
        .accessibilityIdentifier(NotesIdentifiers.composer)
    }

    var moveBar: some View {
        HStack {
            Text(selectedText).foregroundStyle(Theme.Colors.secondaryText)
            Spacer()
            Button { viewModel.moveSelectedToSubpages() } label: { Text("notes.move", bundle: .module) }
                .disabled(viewModel.state.selected.isEmpty || viewModel.state.working)
                .accessibilityIdentifier(NotesIdentifiers.moveToSubpage)
        }
        .padding(Theme.Spacing.medium)
        .background(.bar)
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button { subpageTitle = ""; asksSubpageTitle = true } label: {
                    Label { Text("notes.newSubpage", bundle: .module) } icon: { Image(systemName: "doc.badge.plus") }
                }
                .accessibilityIdentifier(NotesIdentifiers.newSubpage)
                Button { viewModel.toggleSelecting() } label: {
                    Label {
                        Text(viewModel.state.selecting ? "notes.done" : "notes.select", bundle: .module)
                    } icon: {
                        Image(systemName: "checkmark.circle")
                    }
                }
                .accessibilityIdentifier(NotesIdentifiers.select)
                Button { viewModel.openAsText() } label: {
                    Label { Text("notes.asText", bundle: .module) } icon: { Image(systemName: "text.document") }
                }
                .accessibilityIdentifier(NotesIdentifiers.asText)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .disabled(viewModel.state.phase != .content)
            .accessibilityLabel(Text("notes.menu", bundle: .module))
            .accessibilityIdentifier(NotesIdentifiers.menu)
        }
    }

    func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        viewModel.add(draftType, text: text)
        draft = ""
    }

    var selectedText: String {
        let count = viewModel.state.selected.count
        return count == 0
            ? String(localized: "notes.selected.none", bundle: .module)
            : String(format: String(localized: "notes.selected.count", bundle: .module), count)
    }

    static let composerTypes: [
        NoteBlockType
    ] = [.text, .heading1, .heading2, .heading3, .bullet, .number, .todo, .quote]

    static func name(of type: NoteBlockType) -> String {
        switch type {
        case .text: String(localized: "notes.type.text", bundle: .module)
        case .heading1: String(localized: "notes.type.h1", bundle: .module)
        case .heading2: String(localized: "notes.type.h2", bundle: .module)
        case .heading3: String(localized: "notes.type.h3", bundle: .module)
        case .bullet: String(localized: "notes.type.bullet", bundle: .module)
        case .number: String(localized: "notes.type.number", bundle: .module)
        case .todo: String(localized: "notes.type.todo", bundle: .module)
        case .quote: String(localized: "notes.type.quote", bundle: .module)
        case .page: String(localized: "notes.type.page", bundle: .module)
        }
    }

    static func symbol(of type: NoteBlockType) -> String {
        switch type {
        case .text: "text.alignleft"
        case .heading1: "textformat.size.larger"
        case .heading2: "textformat.size"
        case .heading3: "textformat.size.smaller"
        case .bullet: "list.bullet"
        case .number: "list.number"
        case .todo: "checklist"
        case .quote: "text.quote"
        case .page: "doc.text"
        }
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        NotesScreen(
            viewModel: NotesViewModel(
                itemId: "i1",
                model: ScriptedNotesScreenModel(
                    state: NotesState(
                        phase: .content,
                        title: "Notes",
                        blocks: [
                            NoteBlockItem(
                                id: "1",
                                type: .heading1,
                                indent: 0,
                                done: false,
                                text: "Plan",
                                pageId: nil,
                                marker: nil
                            ),
                            NoteBlockItem(
                                id: "2", type: .page, indent: 0, done: false, text: "Ideas", pageId: "p1", marker: nil
                            )
                        ]
                    )
                ),
                router: PreviewNotesRouter()
            )
        )
    }
}
