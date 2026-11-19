import CoreKit
import DesignSystem
import SwiftUI

/// How a block's place in the note looks around the block itself.
struct NoteSlotPresentation: Equatable {

    var selecting = false
    var isSelected = false
    var swipe: NoteSwipeState?
    var isDragged = false
    /// Set while a finger holds the block, before it lifts or moves it.
    var isHeld = false
}

/// A block's place in the note: the coloured tray a swipe uncovers with its step, a hold that selects the block or,
/// dragged along the page, moves it (with the rest of the selection when it is selected), and in selection mode the
/// selection mark and a tap that selects. It reports where the block is laid out.
struct NoteBlockSlot<Row: View>: View {

    // MARK: - Dependencies
    let block: NoteEditorBlock
    let presentation: NoteSlotPresentation
    let isEditing: Bool
    let onDragged: @MainActor (CGSize, CGPoint) -> Void
    let onReleased: @MainActor () -> Void
    let onHold: @MainActor () -> Void
    let onHoldMoved: @MainActor (CGPoint) -> Void
    let onHoldEnded: @MainActor () -> Void
    /// A gesture on the block stopped without its end: the system took it over.
    let onCancelled: @MainActor () -> Void
    let onToggle: @MainActor () -> Void
    @ViewBuilder let row: () -> Row

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
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
            .scaleEffect(isLifted ? 1.02 : 1)
            .shadow(color: .black.opacity(presentation.isHeld ? 0.15 : 0), radius: 10, y: 4)
            .opacity(presentation.isDragged ? 0.3 : 1)
            // The whole width of the block takes a swipe or a hold, not only where it has text.
            .contentShape(Rectangle())
            .animation(.snappy(duration: 0.2), value: presentation.isHeld)
            .sidewaysDrag(
                in: NoteEditorMetrics.space,
                RowGestureActions(
                    changed: { onDragged($0.translation, $0.location) },
                    ended: onReleased,
                    cancelled: onCancelled
                )
            )
            .holdAndDrag(
                in: NoteEditorMetrics.space,
                isEnabled: !isEditing,
                began: onHold,
                RowGestureActions(changed: { onHoldMoved($0.location) }, ended: onHoldEnded, cancelled: onCancelled)
            )
        }
    }
}

// MARK: - Subviews
private extension NoteBlockSlot {

    /// Held, and not yet moved away from its place.
    var isLifted: Bool { presentation.isHeld && !presentation.isDragged }

    var slot: some View {
        HStack(alignment: .center, spacing: Theme.Spacing.small) {
            row()
            if presentation.selecting { mark }
        }
        .overlay {
            if presentation.selecting {
                Color.clear.contentShape(Rectangle()).onTapGesture(perform: onToggle)
            }
        }
        .padding(.trailing, presentation.selecting ? Theme.Spacing.small : 0)
        .background(
            presentation.isSelected ? Theme.Colors.accent.opacity(0.14) : .clear,
            in: .rect(cornerRadius: 10)
        )
        .background(Theme.Colors.groupedBackground.opacity(presentation.swipe == nil ? 0 : 1))
        .animation(.snappy(duration: 0.15), value: presentation.isSelected)
        .accessibilityAddTraits(presentation.isSelected ? .isSelected : [])
    }

    /// The mark of selection mode on the right: a soft dot when the block is selected, a ring when not.
    @ViewBuilder var mark: some View {
        if presentation.isSelected {
            Circle()
                .fill(Theme.Colors.accent.opacity(0.75))
                .frame(width: 16, height: 16)
                .frame(width: 22, height: 22)
                .accessibilityHidden(true)
        } else {
            Circle()
                .strokeBorder(Theme.Colors.secondaryText.opacity(0.5), lineWidth: 1.5)
                .frame(width: 22, height: 22)
                .accessibilityHidden(true)
        }
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
}

/// Where each block of the note is laid out, by its id.
struct NoteRowFramesKey: PreferenceKey {

    static let defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}
