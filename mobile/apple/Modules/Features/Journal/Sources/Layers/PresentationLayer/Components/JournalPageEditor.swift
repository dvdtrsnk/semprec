import CoreKit
import DesignSystem
import SwiftUI

/// A page of the diary as a list of formatted blocks, each editable in place, with a line at the end that adds a
/// block. The text being typed stays in native state and is handed over when it is committed.
struct JournalPageEditor: View {

    // MARK: - Dependencies
    /// Prefix of the identifiers of the blocks, so two editors on one screen do not share them.
    let identifierPrefix: String
    let blocks: [JournalBlock]
    let placeholder: String
    let saving: Bool
    /// `true` while the screen shows a message about a failed change, so a typed block is not thrown away.
    let hasProblem: Bool
    let onSetText: (Int, String) -> Void
    let onToggle: (Int) -> Void
    let onAdd: (JournalBlockKind, String) -> Void
    let onOpenPage: (String, String) -> Void

    // MARK: - State
    @State private var editing: Int?
    @State private var draft = ""
    @State private var newText = ""
    @State private var newKind: JournalBlockKind = .text
    @State private var adding = false
    @FocusState private var focus: Field?

    private enum Field: Hashable {
        case block(Int)
        case new
    }

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            ForEach(blocks) { block in
                row(for: block)
            }
            newBlockRow
        }
        .disabled(saving)
        .onChange(of: focus) { old, _ in
            if case .block(let index)? = old, editing == index { commit(index) }
        }
        .onChange(of: saving) { wasSaving, isSaving in
            guard wasSaving, !isSaving, adding else { return }
            adding = false
            if !hasProblem { newText = "" }
        }
    }
}

// MARK: - Subviews
private extension JournalPageEditor {

    @ViewBuilder
    func row(for block: JournalBlock) -> some View {
        if editing == block.index {
            TextField("", text: $draft, axis: .vertical)
                .focused($focus, equals: .block(block.index))
                .onSubmit { commit(block.index) }
                .padding(.leading, CGFloat(block.indent) * Theme.Spacing.medium)
                .accessibilityIdentifier(identifier(block.index))
        } else {
            JournalBlockRow(
                block: block,
                identifier: identifier(block.index),
                onEdit: { beginEditing(block) },
                onToggle: { onToggle(block.index) },
                onOpenPage: onOpenPage
            )
        }
    }

    var newBlockRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.small) {
            Menu {
                Picker(selection: $newKind) {
                    ForEach(Self.addableKinds, id: \.self) { kind in
                        Text(kind.label, bundle: .module).tag(kind)
                    }
                } label: {
                    Text("journal.newBlock.kind", bundle: .module)
                }
            } label: {
                Image(systemName: newKind.symbol).foregroundStyle(Theme.Colors.secondaryText)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .accessibilityLabel(Text("journal.newBlock.kind", bundle: .module))
            TextField(placeholder, text: $newText, axis: .vertical)
                .focused($focus, equals: .new)
                .onSubmit(add)
                .accessibilityIdentifier(JournalIdentifiers.newBlockField)
            if !newText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(action: add) {
                    Image(systemName: "arrow.up.circle.fill").foregroundStyle(Theme.Colors.accent)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("journal.newBlock.add", bundle: .module))
                .accessibilityIdentifier(JournalIdentifiers.newBlockAdd)
            }
        }
        .padding(.top, blocks.isEmpty ? 0 : Theme.Spacing.small)
    }

    static var addableKinds: [JournalBlockKind] {
        [.text, .heading1, .heading2, .heading3, .bullet, .number, .todo, .quote]
    }

    func identifier(_ index: Int) -> String {
        "\(JournalIdentifiers.blockPrefix)\(identifierPrefix).\(index)"
    }
}

// MARK: - Private
private extension JournalPageEditor {

    func beginEditing(_ block: JournalBlock) {
        editing = block.index
        draft = block.plainText
        focus = .block(block.index)
    }

    func commit(_ index: Int) {
        if let block = blocks.first(where: { $0.index == index }), draft != block.plainText {
            onSetText(index, draft)
        }
        editing = nil
    }

    func add() {
        let text = newText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        adding = true
        onAdd(newKind, text)
    }
}

// MARK: - Block kinds
extension JournalBlockKind {

    /// The name of the kind in the menu that picks what a new block is.
    var label: LocalizedStringKey {
        switch self {
        case .text: "journal.kind.text"
        case .heading1: "journal.kind.heading1"
        case .heading2: "journal.kind.heading2"
        case .heading3: "journal.kind.heading3"
        case .bullet: "journal.kind.bullet"
        case .number: "journal.kind.number"
        case .todo: "journal.kind.todo"
        case .quote: "journal.kind.quote"
        case .page: "journal.kind.page"
        }
    }

    var symbol: String {
        switch self {
        case .text: "text.alignleft"
        case .heading1, .heading2, .heading3: "textformat.size"
        case .bullet: "list.bullet"
        case .number: "list.number"
        case .todo: "checklist"
        case .quote: "text.quote"
        case .page: "doc.text"
        }
    }
}

// MARK: - Preview
#Preview("Page") {
    JournalPageEditor(
        identifierPrefix: "2026-10-16",
        blocks: [
            JournalBlock(
                index: 0, kind: .text,
                runs: [JournalRun(text: "Schůzka dopadla dobře, "), JournalRun(text: "rozpočet schválený", bold: true)]
            ),
            JournalBlock(index: 1, kind: .todo, runs: [JournalRun(text: "Pohorky")]),
            JournalBlock(index: 2, kind: .page, runs: [JournalRun(text: "Krkonoše – co sbalit")], pageId: "p")
        ],
        placeholder: "Jak se dnes máš?",
        saving: false,
        hasProblem: false,
        onSetText: { _, _ in },
        onToggle: { _ in },
        onAdd: { _, _ in },
        onOpenPage: { _, _ in }
    )
    .padding()
}
