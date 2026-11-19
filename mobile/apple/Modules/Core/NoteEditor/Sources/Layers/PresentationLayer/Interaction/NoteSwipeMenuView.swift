import CoreKit
import DesignSystem
import SwiftUI

/// A swipe menu, under the finger or above the block when there is no room below. While the finger is down its
/// highlighted option follows it; once it is left open, an option is tapped.
struct NoteSwipeMenuView: View {

    // MARK: - Dependencies
    let menu: NoteMenuState
    let block: NoteEditorBlock
    /// The height of the space the menu is shown in.
    let height: CGFloat
    let onPick: (NoteMenuOption) -> Void
    let onClose: () -> Void

    // MARK: - Body
    var body: some View {
        ZStack(alignment: .topLeading) {
            if menu.pinned {
                Color.black.opacity(0.001)
                    .onTapGesture(perform: onClose)
                    .accessibilityHidden(true)
            }
            options
                .offset(x: max(menu.anchor.x - 40, Theme.Spacing.small), y: top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Subviews
private extension NoteSwipeMenuView {

    var menuHeight: CGFloat { CGFloat(menu.kind.options.count) * NoteInteraction.optionHeight }

    var top: CGFloat {
        menu.anchor.y + menuHeight > height ? max(menu.anchor.y - menuHeight - 48, 0) : menu.anchor.y
    }

    var options: some View {
        VStack(spacing: 0) {
            ForEach(menu.kind.options) { option in
                Button { onPick(option) } label: {
                    HStack {
                        Text(option.title, bundle: .module)
                        Spacer(minLength: Theme.Spacing.large)
                        if isCurrent(option) { Image(systemName: "checkmark").font(.footnote.weight(.semibold)) }
                    }
                    .padding(.horizontal, Theme.Spacing.medium)
                    .frame(width: 240, height: NoteInteraction.optionHeight)
                    .background(option.id == menu.highlighted ? Theme.Colors.accent.opacity(0.2) : .clear)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .allowsHitTesting(menu.pinned)
            }
        }
        .background(.regularMaterial, in: .rect(cornerRadius: 14))
        .shadow(color: .black.opacity(0.18), radius: 16, y: 6)
    }

    func isCurrent(_ option: NoteMenuOption) -> Bool {
        option.type == block.type && (option.indent == nil || option.indent == block.indent)
    }
}
