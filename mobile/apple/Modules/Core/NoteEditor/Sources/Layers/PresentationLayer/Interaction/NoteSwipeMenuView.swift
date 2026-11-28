import CoreKit
import DesignSystem
import SwiftUI

/// A swipe menu in Liquid Glass next to its block, below or above it, its first option nearest the block. Each option
/// looks the way the block will. While the finger is down the highlighted option follows it; once the menu is left
/// open, an option is tapped.
struct NoteSwipeMenuView: View {

    // MARK: - Dependencies
    let menu: NoteMenuState
    let block: NoteEditorBlock
    /// The width of the space the menu is shown in.
    let width: CGFloat
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
                .offset(x: left, y: top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Subviews
private extension NoteSwipeMenuView {

    static let menuWidth: CGFloat = 270

    var height: CGFloat { CGFloat(menu.kind.options.count) * NoteInteraction.optionHeight }

    var top: CGFloat { menu.centeredTop ?? (menu.below ? menu.row.maxY : menu.row.minY - height) }

    var left: CGFloat {
        min(max(menu.left - 60, Theme.Spacing.small), max(width - Self.menuWidth - Theme.Spacing.small, 0))
    }

    /// The options from the block outward: top down below the block, bottom up above it.
    var ordered: [NoteMenuOption] {
        menu.below ? menu.kind.options : menu.kind.options.reversed()
    }

    var options: some View {
        VStack(spacing: 0) {
            ForEach(ordered) { option in
                Button { onPick(option) } label: {
                    HStack {
                        NoteMenuOptionLabel(option: option)
                        Spacer(minLength: Theme.Spacing.small)
                        if isCurrent(option) { Image(systemName: "checkmark").font(.footnote.weight(.semibold)) }
                    }
                    .padding(.horizontal, Theme.Spacing.medium)
                    .frame(width: Self.menuWidth, height: NoteInteraction.optionHeight)
                    .background(
                        option.id == menu.highlighted ? Theme.Colors.accent.opacity(0.22) : .clear,
                        in: .rect(cornerRadius: 12)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .allowsHitTesting(menu.pinned)
            }
        }
        .padding(4)
        .glassEffect(.regular, in: .rect(cornerRadius: 20))
        .animation(.snappy(duration: 0.15), value: menu.highlighted)
    }

    func isCurrent(_ option: NoteMenuOption) -> Bool {
        option.type == block.type && option.toggle == block.toggle
    }
}

/// A menu option shown as the block it makes: a heading in its size, a quote with its bar, a list item with its
/// bullet, number or checkbox, a toggle with its arrow.
struct NoteMenuOptionLabel: View {

    let option: NoteMenuOption

    var body: some View {
        HStack(spacing: 6) {
            if option.folds {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            switch option.type {
            case .bullet:
                Text(verbatim: "●").font(.system(size: 9))
            case .number:
                Text(verbatim: "1.").monospacedDigit()
            case .todo:
                Image(systemName: "square").foregroundStyle(Theme.Colors.secondaryText)
            case .quote:
                NoteQuoteBar().frame(height: 20)
            default:
                EmptyView()
            }
            Text(option.title, bundle: .module)
                .font(NoteBlockStyle.font(option.type))
                .foregroundStyle(option.type == .quote ? Theme.Colors.secondaryText : .primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
    }
}
