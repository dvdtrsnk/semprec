import CoreKit
import DesignSystem
import SwiftUI

/// The bar right above the keyboard while part of a block's text is selected, across the whole width: bold, italic,
/// underline, strike, code, text colour, highlight, a link and taking the formats off, and at the right the key that
/// puts the keyboard away. A colour opens the palette in the bar. What the selection already has is highlighted.
struct NoteFormatBar: View {

    // MARK: - Dependencies
    let selection: NoteSelection
    let onTyping: @MainActor (NoteEditorTyping) -> Void
    let onLink: @MainActor () -> Void
    let onDone: @MainActor () -> Void

    // MARK: - State
    /// The palette the bar shows instead of its tools, if any.
    @State private var palette: Palette?

    enum Palette {
        case text
        case highlight
    }

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 0) {
                if let palette { colors(palette) } else { tools }
                Divider().frame(height: 24)
                tool("noteEditor.done", systemImage: "keyboard.chevron.compact.down", action: onDone)
                    .frame(width: 48)
            }
            .frame(height: 44)
        }
        // The keyboard's top corners are rounded: the bar's colour goes on under them, so no gap shows there.
        .background(alignment: .top) { Theme.Colors.card.padding(.bottom, -40) }
        .onChange(of: selection.blockId) { palette = nil }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(NoteEditorIdentifiers.formatBar)
    }
}

// MARK: - Subviews
private extension NoteFormatBar {

    @ViewBuilder var tools: some View {
        mark(.bold, "noteEditor.format.bold", systemImage: "bold")
        mark(.italic, "noteEditor.format.italic", systemImage: "italic")
        mark(.underline, "noteEditor.format.underline", systemImage: "underline")
        mark(.strike, "noteEditor.format.strike", systemImage: "strikethrough")
        mark(.code, "noteEditor.format.code", systemImage: "chevron.left.forwardslash.chevron.right")
        Button { palette = .text } label: {
            Text(verbatim: "A")
                .font(.body.weight(.semibold))
                .foregroundStyle(selection.color?.text ?? .primary)
                .overlay(alignment: .bottom) {
                    Capsule().fill(selection.color?.text ?? .primary).frame(height: 2.5).offset(y: 4)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("noteEditor.format.color", bundle: .module))
        tool(
            "noteEditor.format.highlight",
            systemImage: "highlighter",
            isActive: selection.highlight != nil
        ) { palette = .highlight }
        tool("noteEditor.format.link", systemImage: "link", isActive: selection.link != nil, action: onLink)
        tool("noteEditor.format.clear", systemImage: "eraser") {
            onTyping(.clearFormat(blockId: selection.blockId, start: selection.start, end: selection.end))
        }
    }

    /// The palette of text colours or of highlights: back to the tools, no colour, then the colours.
    @ViewBuilder
    func colors(_ palette: Palette) -> some View {
        tool("noteEditor.format.back", systemImage: "chevron.left") { self.palette = nil }
        swatch(nil, in: palette)
        ForEach(NoteEditorColor.allCases, id: \.self) { color in swatch(color, in: palette) }
    }

    func swatch(_ color: NoteEditorColor?, in palette: Palette) -> some View {
        let current = palette == .text ? selection.color : selection.highlight
        return Button { apply(color, in: palette) } label: {
            Group {
                if let color {
                    Circle().fill(palette == .text ? color.text : color.highlight)
                        .overlay {
                            if palette == .highlight {
                                Text(verbatim: "A").font(.caption.weight(.bold)).foregroundStyle(.primary)
                            }
                        }
                } else {
                    Image(systemName: "circle.slash").font(.title3).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            .frame(width: 24, height: 24)
            .padding(3)
            .overlay(Circle().strokeBorder(current == color ? Theme.Colors.accent : .clear, lineWidth: 2))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(color?.title ?? "noteEditor.color.none", bundle: .module))
    }

    func apply(_ color: NoteEditorColor?, in palette: Palette) {
        let (blockId, start, end) = (selection.blockId, selection.start, selection.end)
        switch palette {
        case .text: onTyping(.setColor(blockId: blockId, start: start, end: end, color: color))
        case .highlight: onTyping(.setHighlight(blockId: blockId, start: start, end: end, color: color))
        }
        self.palette = nil
    }

    func mark(_ mark: NoteEditorMark, _ title: LocalizedStringKey, systemImage: String) -> some View {
        tool(title, systemImage: systemImage, isActive: selection.marks.contains(mark)) {
            onTyping(.toggleMark(blockId: selection.blockId, start: selection.start, end: selection.end, mark: mark))
        }
    }

    func tool(
        _ title: LocalizedStringKey,
        systemImage: String,
        isActive: Bool = false,
        action: @escaping @MainActor () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.body.weight(.medium))
                .foregroundStyle(isActive ? Theme.Colors.accent : .primary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(title, bundle: .module))
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}
