import CoreKit
import SwiftUI

/// The block being edited, in the system rich text editor, so its formatting stays visible while typing. Its text
/// carries `NoteText.sentinel` in front, whose deletion is Backspace at the start. Each change is read as the editing
/// action it is (`NoteTextChange`) and sent; the text is laid out again from the block whenever the shared layer
/// changed it differently.
struct NoteBlockEditor: View {

    // MARK: - Dependencies
    let block: NoteEditorBlock
    let placeholder: LocalizedStringKey?
    let caretTarget: NoteCaretTarget?
    let pendingMark: NoteEditorMark?
    let onTyping: (NoteEditorTyping) -> Void
    let onKey: (NoteEditorKey) -> Void
    let onSelection: (NoteSelection) -> Void
    let onBlur: () -> Void

    // MARK: - State
    @State private var text = AttributedString(NoteText.sentinel)
    @State private var selection = AttributedTextSelection()
    /// The runs the text was last laid out from or last sent as.
    @State private var shown: [NoteEditorRun] = []
    /// The runs sent as typing that the shared layer has not shown back yet. Its state follows the typing with a delay;
    /// showing one of these again would undo what was typed since.
    @State private var sent: [[NoteEditorRun]] = []
    /// Set while the line break Shift-Return put in waits to be read as typing.
    @State private var softBreak = false
    @FocusState private var isFocused: Bool

    // MARK: - Body
    var body: some View {
        TextEditor(text: $text, selection: $selection)
            .font(NoteBlockStyle.font(block.type))
            .foregroundStyle(NoteBlockStyle.color(block))
            .scrollDisabled(true)
            .scrollContentBackground(.hidden)
            .textInputFormattingControlVisibility(.hidden, for: .all)
            .fixedSize(horizontal: false, vertical: true)
            .focused($isFocused)
            .overlay(alignment: .topLeading) { placeholderText }
            .onChange(of: text) { old, new in read(old: old, new: new) }
            .onChange(of: selection) { keepAfterSentinel() }
            .onChange(of: isFocused) { _, focused in if !focused { onBlur() } }
            .onChange(of: block.runs) { _, runs in follow(runs) }
            .onChange(of: caretTarget) { _, target in place(target) }
            .onChange(of: pendingMark) { _, mark in if let mark { applyPending(mark) } }
            .modifier(
                NoteEditorKeys(
                    blockId: block.id,
                    length: shown.map(\.text).joined().utf16.count,
                    cursor: cursor,
                    onTyping: onTyping,
                    onKey: onKey,
                    onSoftBreak: breakLine
                )
            )
            .onAppear {
                layOut(block.runs, keepingCursor: false)
                place(caretTarget)
                isFocused = true
            }
    }
}

// MARK: - Subviews
private extension NoteBlockEditor {

    @ViewBuilder var placeholderText: some View {
        if block.runs.isEmpty, shown.isEmpty, let placeholder {
            Text(placeholder, bundle: .module)
                .font(NoteBlockStyle.font(block.type))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, NoteEditorMetrics.editorInset.width)
                .padding(.vertical, NoteEditorMetrics.editorInset.height)
                .allowsHitTesting(false)
        }
    }
}

// MARK: - Private
private extension NoteBlockEditor {

    /// The cursor or selection as offsets into the block's text, the sentinel left out.
    var cursor: (start: Int, end: Int) {
        switch selection.indices(in: text) {
        case .insertionPoint(let index):
            let offset = max(NoteText.offset(of: index, in: text) - 1, 0)
            return (offset, offset)
        case .ranges(let ranges):
            guard let first = ranges.ranges.first, let last = ranges.ranges.last else { return (0, 0) }
            return (
                max(NoteText.offset(of: first.lowerBound, in: text) - 1, 0),
                max(NoteText.offset(of: last.upperBound, in: text) - 1, 0)
            )
        }
    }

    func read(old: AttributedString, new: AttributedString) {
        guard let runs = NoteText.editedRuns(new) else {
            // Only the sentinel gone is Backspace at the start; a selection deleted with it is typing.
            if old.characters.count - new.characters.count == 1 {
                onTyping(.backspaceAtStart(blockId: block.id))
                layOut(shown, keepingCursor: false)
            } else {
                shown = NoteText.runs(new)
                send(shown)
                layOut(shown, keepingCursor: false)
            }
            return
        }
        guard runs != shown else { return report() }
        let before = shown.map(\.text).joined()
        let change = NoteTextChange.between(before, runs.map(\.text).joined(), softBreak: softBreak)
        softBreak = false
        switch change {
        case .typed:
            shown = runs
            send(runs)
        case .enter(let offset):
            layOut(shown, keepingCursor: false)
            onTyping(.enter(blockId: block.id, offset: offset))
        case .linked(let start, let end, let address):
            layOut(shown, keepingCursor: false)
            onTyping(.setLink(blockId: block.id, start: start, end: end, address: address))
        case .inserted(let offset, let removed, let inserted):
            insert(inserted, at: offset, removing: removed)
        }
        report()
    }

    /// Pasted lines: the removed stretch goes as typing, the lines as plain text pasted.
    func insert(_ inserted: String, at offset: Int, removing removed: Int) {
        var kept = NoteText.attributed(shown)
        let start = NoteText.index(at: offset, in: kept)
        kept.removeSubrange(start..<NoteText.index(at: offset + removed, in: kept))
        if removed > 0 {
            shown = NoteText.runs(kept)
            send(shown)
        }
        layOut(shown, keepingCursor: false)
        onTyping(.paste(blockId: block.id, offset: offset, text: inserted))
    }

    func send(_ runs: [NoteEditorRun]) {
        sent.append(runs)
        onTyping(.setRuns(blockId: block.id, runs: runs))
    }

    /// Shows the block's runs from the shared layer, unless they are only what was typed earlier coming back.
    func follow(_ runs: [NoteEditorRun]) {
        if let echoed = sent.firstIndex(of: runs) {
            sent.removeFirst(echoed + 1)
            return
        }
        sent = []
        layOut(runs, keepingCursor: true)
    }

    /// Lays the text out from `runs` unless it already shows them; the cursor stays at its offset when
    /// `keepingCursor`.
    func layOut(_ runs: [NoteEditorRun], keepingCursor: Bool) {
        shown = runs
        if keepingCursor, NoteText.editedRuns(text) == runs { return }
        let offset = cursor.start
        text = NoteText.editable(runs)
        if keepingCursor { moveCursor(to: min(offset, runs.map(\.text).joined().utf16.count)) }
    }

    func place(_ target: NoteCaretTarget?) {
        guard let target, target.blockId == block.id else { return }
        if NoteText.editedRuns(text) != block.runs { layOut(block.runs, keepingCursor: false) }
        moveCursor(to: target.offset)
        isFocused = true
    }

    func moveCursor(to offset: Int) {
        selection = AttributedTextSelection(insertionPoint: NoteText.index(at: offset + 1, in: text))
    }

    /// The cursor never stands in front of the sentinel.
    func keepAfterSentinel() {
        if case .insertionPoint(let index) = selection.indices(in: text), index == text.startIndex,
           !text.characters.isEmpty {
            moveCursor(to: 0)
        }
        report()
    }

    /// The format waits at the cursor for the next typed text; moving the cursor drops it, as the system does.
    func applyPending(_ mark: NoteEditorMark) {
        guard case .insertionPoint(let index) = selection.indices(in: text) else { return }
        var attributes = selection.typingAttributes(in: text)
        let flag: InlinePresentationIntent? = switch mark {
        case .bold: .stronglyEmphasized
        case .italic: .emphasized
        case .code: .code
        case .strike, .underline: nil
        }
        if let flag {
            var intent = attributes.inlinePresentationIntent ?? []
            if intent.contains(flag) { intent.remove(flag) } else { intent.insert(flag) }
            attributes.inlinePresentationIntent = intent.isEmpty ? nil : intent
        } else if mark == .strike {
            attributes.strikethroughStyle = attributes.strikethroughStyle == nil ? .single : nil
        } else {
            attributes.underlineStyle = attributes.underlineStyle == nil ? .single : nil
        }
        selection = AttributedTextSelection(insertionPoint: index, typingAttributes: attributes)
    }

    func breakLine() {
        softBreak = true
        text.replaceSelection(&selection, withCharacters: "\n")
    }

    func report() {
        let (start, end) = cursor
        let current = shown.run(containing: start)
        var marks = Set<NoteEditorMark>()
        if current?.bold == true { marks.insert(.bold) }
        if current?.italic == true { marks.insert(.italic) }
        if current?.code == true { marks.insert(.code) }
        if current?.strike == true { marks.insert(.strike) }
        if current?.underline == true { marks.insert(.underline) }
        onSelection(NoteSelection(
            blockId: block.id,
            start: start,
            end: end,
            marks: marks,
            link: current?.link,
            color: current?.color,
            highlight: current?.highlight
        ))
    }
}

private extension [NoteEditorRun] {

    /// The run the text at `offset` belongs to, or the one just before it at a boundary.
    func run(containing offset: Int) -> NoteEditorRun? {
        var position = 0
        for run in self {
            let end = position + run.text.utf16.count
            if offset > position && offset <= end || offset == 0 && position == 0 { return run }
            position = end
        }
        return last
    }
}
