import CoreKit
import DesignSystem
import SwiftUI

/// How a block's place in the note looks around the block itself.
struct NoteSlotPresentation: Equatable {

    var selecting = false
    var isSelected = false
    var swipe: NoteSwipeState?
    var isDragged = false
    /// The room left open above the block for blocks being moved there.
    var gapAbove: CGFloat = 0
}

/// A block's place in the note: the coloured tray a swipe uncovers with its step, and in selection mode the
/// selection mark, a tap that selects and the handle that moves. It reports where the block is laid out.
struct NoteBlockSlot<Row: View>: View {

    // MARK: - Dependencies
    let block: NoteEditorBlock
    let presentation: NoteSlotPresentation
    let isEditing: Bool
    let onDragged: (CGSize, CGPoint) -> Void
    let onReleased: () -> Void
    let onIndent: (Int) -> Void
    let onToggle: () -> Void
    let onHandleMoved: (CGPoint) -> Void
    let onHandleDropped: () -> Void
    @ViewBuilder let row: () -> Row

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            if presentation.gapAbove > 0 {
                Color.clear.frame(height: presentation.gapAbove)
            }
            ZStack(alignment: (presentation.swipe?.translation ?? 0) >= 0 ? .leading : .trailing) {
                tray
                slot.offset(x: presentation.swipe?.translation ?? 0)
            }
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: NoteRowFramesKey.self,
                        value: [block.id: proxy.frame(in: .named(NoteEditorMetrics.space))]
                    )
                }
            }
            .opacity(presentation.isDragged ? 0.3 : 1)
            .simultaneousGesture(swipe, isEnabled: !isEditing)
            .simultaneousGesture(indent, isEnabled: isEditing)
        }
    }
}

// MARK: - Subviews
private extension NoteBlockSlot {

    var slot: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.small) {
            if presentation.selecting {
                Image(systemName: presentation.isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(presentation.isSelected ? Theme.Colors.accent : Theme.Colors.secondaryText)
                    .padding(.vertical, NoteEditorMetrics.editorInset.height + 2)
                    .accessibilityHidden(true)
            }
            row()
                .overlay {
                    if presentation.selecting {
                        Color.clear.contentShape(Rectangle()).onTapGesture(perform: onToggle)
                    }
                }
            if presentation.selecting { handle }
        }
        .background(Theme.Colors.groupedBackground.opacity(presentation.swipe == nil ? 0 : 1))
        .accessibilityAddTraits(presentation.isSelected ? .isSelected : [])
    }

    @ViewBuilder var tray: some View {
        if let swipe = presentation.swipe {
            let valid = swipe.step?.isValid(for: block) ?? false
            HStack(spacing: 6) {
                if let step = swipe.step {
                    Image(systemName: step.systemImage)
                    Text(step.title(for: block), bundle: .module).lineLimit(1)
                }
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, Theme.Spacing.medium)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: swipe.translation >= 0 ? .leading : .trailing)
            .background(
                (valid ? swipe.step?.tint ?? .gray : .gray).opacity(swipe.step == nil ? 0.35 : 1),
                in: .rect(cornerRadius: 10)
            )
        }
    }

    var handle: some View {
        Image(systemName: "line.3.horizontal")
            .foregroundStyle(Theme.Colors.secondaryText)
            .frame(width: 36, height: 36)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .named(NoteEditorMetrics.space))
                    .onChanged { onHandleMoved($0.location) }
                    .onEnded { _ in onHandleDropped() }
            )
            .accessibilityLabel(Text("noteEditor.selection.move", bundle: .module))
            .accessibilityIdentifier(NoteEditorIdentifiers.handle(block.id))
    }

    var swipe: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .named(NoteEditorMetrics.space))
            .onChanged { onDragged($0.translation, $0.location) }
            .onEnded { _ in onReleased() }
    }

    /// While a block is edited, a swipe only changes its indent by one level.
    var indent: some Gesture {
        DragGesture(minimumDistance: 30)
            .onEnded { value in
                let width = value.translation.width
                guard abs(width) >= NoteSwipeStep.thresholds[0], abs(width) > 2 * abs(value.translation.height) else {
                    return
                }
                onIndent(width > 0 ? 1 : -1)
            }
    }
}

/// Where each block of the note is laid out, by its id.
struct NoteRowFramesKey: PreferenceKey {

    static let defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}
