import CoreKit
import SwiftUI

/// The menu of the selected item: cut, copy, duplicate and delete. It floats beside the item as a popover, also on a
/// compact screen, and a tap beside it, which dismisses it, deselects the item.
struct CalendarItemMenu: ViewModifier {

    // MARK: - Dependencies
    let isPresented: Bool
    let onAction: (CalendarEditAction) -> Void
    let onDismiss: () -> Void

    // MARK: - Body
    func body(content: Content) -> some View {
        content.popover(
            isPresented: Binding(get: { isPresented }, set: { if !$0 { onDismiss() } }),
            attachmentAnchor: .rect(.bounds),
            arrowEdge: .bottom
        ) {
            VStack(spacing: 0) {
                row("calendar.menu.cut", systemImage: "scissors", action: .cut)
                Divider()
                row("calendar.menu.copy", systemImage: "doc.on.doc", action: .copy)
                Divider()
                row("calendar.menu.duplicate", systemImage: "plus.square.on.square", action: .duplicate)
                Divider()
                row("calendar.menu.delete", systemImage: "trash", action: .delete, destructive: true)
            }
            .frame(minWidth: 200)
            .padding(.vertical, 4)
            .presentationCompactAdaptation(.popover)
            .accessibilityIdentifier(CalendarIdentifiers.menu)
        }
    }
}

// MARK: - Actions
/// What the menu offers.
enum CalendarEditAction {

    case cut
    case copy
    case duplicate
    case delete
}

// MARK: - Rows
private extension CalendarItemMenu {

    func row(
        _ title: LocalizedStringKey,
        systemImage: String,
        action: CalendarEditAction,
        destructive: Bool = false
    ) -> some View {
        Button { onAction(action) } label: {
            HStack {
                Text(title, bundle: .module)
                Spacer()
                Image(systemName: systemImage)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(destructive ? AnyShapeStyle(Color.red) : AnyShapeStyle(.primary))
    }
}

// MARK: - View
extension View {

    func calendarItemMenu(
        isPresented: Bool,
        onAction: @escaping (CalendarEditAction) -> Void,
        onDismiss: @escaping () -> Void
    ) -> some View {
        modifier(CalendarItemMenu(isPresented: isPresented, onAction: onAction, onDismiss: onDismiss))
    }
}
