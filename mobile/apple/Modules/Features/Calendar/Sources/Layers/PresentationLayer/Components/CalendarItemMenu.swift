import CoreKit
import SwiftUI

/// What the menu offers, in the order the system Calendar lists it.
enum CalendarEditAction: CaseIterable {

    case cut
    case copy
    case delete
    case duplicate

    var title: LocalizedStringKey {
        switch self {
        case .cut: "calendar.menu.cut"
        case .copy: "calendar.menu.copy"
        case .delete: "calendar.menu.delete"
        case .duplicate: "calendar.menu.duplicate"
        }
    }
}

/// The menu of the selected item as the system Calendar draws it: one capsule of glass with the words side by side,
/// small enough to sit just below the item (or above it, `CalendarMenuPlacement` decides) and to come out of it with a
/// short spring.
struct CalendarEditMenu: View {

    // MARK: - Dependencies
    let onAction: (CalendarEditAction) -> Void

    // MARK: - Body
    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(CalendarEditAction.allCases.enumerated()), id: \.offset) { index, action in
                if index > 0 {
                    Divider().frame(height: 20)
                }
                Button { onAction(action) } label: {
                    Text(action.title, bundle: .module)
                        .font(.body)
                        .foregroundStyle(action == .delete ? AnyShapeStyle(Color.red) : AnyShapeStyle(.primary))
                        .padding(.horizontal, 14)
                        .frame(height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .fixedSize()
        .glassEffect(.regular, in: .capsule)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CalendarIdentifiers.menu)
    }
}

/// Where the menu of an item goes: centred under the item, above it when there is no room below, and always inside the
/// part of the screen that is free of the header and the bars at the bottom.
enum CalendarMenuPlacement {

    /// The space between the item and the menu.
    static let gap: CGFloat = 8
    /// The space kept between the menu and the sides of the screen.
    static let margin: CGFloat = 8

    /// The top left corner of a menu of size `menu` for an item at `anchor`, in the space of `container`, whose free
    /// part lies between `top` and `bottom`.
    static func origin(menu: CGSize, anchor: CGRect, container: CGSize, top: CGFloat, bottom: CGFloat) -> CGPoint {
        let farthestLeft = margin
        let farthestRight = max(container.width - margin - menu.width, farthestLeft)
        let x = min(max(anchor.midX - menu.width / 2, farthestLeft), farthestRight)
        let below = anchor.maxY + gap
        if below + menu.height <= bottom { return CGPoint(x: x, y: below) }
        let above = anchor.minY - gap - menu.height
        if above >= top { return CGPoint(x: x, y: above) }
        // The item fills the free part: the menu sits over the middle of what shows of it.
        let visible = CGRect(x: anchor.minX, y: max(anchor.minY, top), width: anchor.width, height: 0)
            .union(CGRect(x: anchor.minX, y: min(anchor.maxY, bottom), width: anchor.width, height: 0))
        let y = min(max(visible.midY - menu.height / 2, top), max(bottom - menu.height, top))
        return CGPoint(x: x, y: y)
    }
}
