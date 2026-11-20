import CoreKit
import DesignSystem
import SwiftUI

/// A block's text while it is not edited. A tap on a link opens it; a tap elsewhere reports the UTF-16 offset under
/// the finger, so editing starts with the cursor there.
struct NoteBlockText: View {

    // MARK: - Dependencies
    let block: NoteEditorBlock
    let placeholder: LocalizedStringKey?
    let onTap: (Int) -> Void

    @Environment(\.openURL)
    private var openURL

    // MARK: - Body
    var body: some View {
        Text(content)
            .font(NoteBlockStyle.font(block.type))
            .foregroundStyle(NoteBlockStyle.color(block))
            .strikethrough(block.type == .todo && block.done)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) { placeholderText }
            .padding(.horizontal, NoteEditorMetrics.editorInset.width)
            .padding(.vertical, NoteEditorMetrics.editorInset.height)
            .overlayPreferenceValue(Text.LayoutKey.self) { layouts in
                GeometryReader { proxy in
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture { location in
                            let offset = Self.offset(at: location, in: layouts, proxy: proxy) ?? block.text.utf16.count
                            if let url = link(at: offset) { openURL(url) } else { onTap(offset) }
                        }
                }
            }
    }
}

// MARK: - Subviews
private extension NoteBlockText {

    /// An empty block keeps the height of one line.
    var content: AttributedString {
        block.runs.isEmpty ? AttributedString(" ") : NoteText.attributed(block.runs)
    }

    @ViewBuilder var placeholderText: some View {
        if block.runs.isEmpty, let placeholder {
            Text(placeholder, bundle: .module)
                .font(NoteBlockStyle.font(block.type))
                .foregroundStyle(.tertiary)
                .allowsHitTesting(false)
        }
    }
}

// MARK: - Hit testing
extension NoteBlockText {

    /// The address of the link the character at `offset` belongs to.
    func link(at offset: Int) -> URL? {
        var position = 0
        for run in block.runs {
            let end = position + run.text.utf16.count
            if offset >= position, offset < end { return run.link.flatMap(URL.init(string:)) }
            position = end
        }
        return nil
    }

    /// The offset of the character boundary nearest to `point`, from the laid out lines of the text.
    static func offset(
        at point: CGPoint,
        in layouts: [Text.LayoutKey.AnchoredLayout],
        proxy: GeometryProxy
    ) -> Int? {
        guard let anchored = layouts.first else { return nil }
        let origin = proxy[anchored.origin]
        let local = CGPoint(x: point.x - origin.x, y: point.y - origin.y)
        let lines = Array(anchored.layout)
        guard let first = lines.first?.first?.characterIndices.first,
              let line = lines.first(where: { $0.typographicBounds.rect.maxY >= local.y }) ?? lines.last
        else { return nil }
        var nearest: Text.Layout.CharacterIndex?
        for run in line {
            for (slice, index) in zip(run, run.characterIndices) {
                let rect = slice.typographicBounds.rect
                if local.x < rect.midX { return first.distance(to: index) }
                nearest = index.advanced(by: 1)
            }
        }
        return nearest.map { first.distance(to: $0) }
    }
}
