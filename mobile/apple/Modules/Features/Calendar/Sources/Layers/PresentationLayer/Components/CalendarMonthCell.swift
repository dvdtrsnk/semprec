import CoreKit
import DesignSystem
import SwiftUI

/// One day of the month view: its number and a few chips of what is on it. A chip of an item that can be edited is
/// held and dropped on another day to move the item there; a tap anywhere on the cell, a chip too, opens the day.
struct CalendarMonthCell: View {

    // MARK: - Dependencies
    let date: String
    let items: [CalendarItem]
    let today: String
    let selected: Bool
    /// A day from Monday to Friday; a weekend day is drawn dimmer.
    let isWeekday: Bool
    let maxChips: Int
    let onOpen: () -> Void
    let onDrop: (String) -> Void

    /// Where a change of zoom finds the places it moves between.
    @Environment(\.calendarZoomMeasures)
    private var zoomMeasures

    /// Where the day's number sits in its cell: its top and its size.
    static let digitTop: CGFloat = 4
    static let digitSize: CGFloat = 24

    // MARK: - State
    @State private var targeted = false

    // MARK: - Body
    var body: some View {
        VStack(spacing: 2) {
            Text("\(CalendarDates.dayNumber(date))")
                .font(.footnote.weight(emphasized ? .semibold : .regular))
                .foregroundStyle(numberStyle)
                .frame(width: Self.digitSize, height: Self.digitSize)
                .measuresZoomFrame(if: selected) { zoomMeasures?.monthDay = $0 }
            ForEach(shown, id: \.identity) { item in
                chip(item)
            }
            if hidden > 0 {
                Text(String(format: String(localized: "calendar.month.more", bundle: .module), hidden))
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, Self.digitTop)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(targeted ? Color.accentColor.opacity(0.15) : Color.clear)
        .overlay(alignment: .top) { Rectangle().fill(Color.secondary.opacity(0.25)).frame(height: 0.5) }
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first else { return false }
            onDrop(id)
            return true
        } isTargeted: { targeted = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(CalendarDates.dayTitle(date))
        .accessibilityIdentifier(CalendarIdentifiers.day(date))
    }
}

// MARK: - Chips
private extension CalendarMonthCell {

    var emphasized: Bool { date == today || selected }

    var visible: [CalendarItem] {
        items.filter { $0.kind != .trace && $0.kind != .sleep }
    }

    var shown: [CalendarItem] { Array(visible.prefix(maxChips)) }

    var hidden: Int { max(visible.count - maxChips, 0) }

    var numberStyle: AnyShapeStyle {
        if date == today { return AnyShapeStyle(Theme.Colors.today) }
        return isWeekday ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary)
    }

    @ViewBuilder
    func chip(_ item: CalendarItem) -> some View {
        let label = HStack(spacing: 2) {
            if item.isTask {
                Image(systemName: item.done ? "checkmark.circle.fill" : "circle").font(.system(size: 8))
            }
            Text(item.title).lineLimit(1)
        }
        .font(.system(size: 9.5, weight: .semibold))
        .padding(.horizontal, 3)
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(item.isTask ? AnyShapeStyle(.primary) : AnyShapeStyle(item.tint))
        .background(item.tint.opacity(item.isTask ? 0.0 : 0.18), in: RoundedRectangle(cornerRadius: 4))
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .accessibilityLabel(item.title)
        .accessibilityIdentifier(CalendarIdentifiers.item(item.id))
        .sempTarget(of: item, meta: nil)
        if item.editable {
            label.draggable(item.id)
        } else {
            label
        }
    }
}
