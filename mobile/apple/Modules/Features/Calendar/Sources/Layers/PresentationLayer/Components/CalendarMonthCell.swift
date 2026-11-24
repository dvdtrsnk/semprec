import CoreKit
import DesignSystem
import SwiftUI

/// One day of the month view, as the system Calendar's month: the day's number and below it the first items of the day
/// as chips with their titles. The chips only show; a tap anywhere on the cell opens the day, where its items are edited.
struct CalendarMonthCell: View {

    // MARK: - Dependencies
    let date: String
    let items: [CalendarItem]
    let today: String
    let selected: Bool
    /// A day from Monday to Friday; a weekend day is drawn dimmer.
    let isWeekday: Bool
    let onOpen: () -> Void

    /// Where a change of zoom finds the places it moves between.
    @Environment(\.calendarZoomMeasures)
    private var zoomMeasures

    /// Where the day's number sits in its cell: its top and the size of the square it is centred in, as the system
    /// Calendar's compact month.
    static let digitTop: CGFloat = 8
    static let digitSize: CGFloat = 39

    // MARK: - Body
    var body: some View {
        VStack(spacing: Self.lineGap) {
            Text("\(CalendarDates.dayNumber(date))")
                .font(.system(size: Self.digitFontSize, weight: .semibold))
                .foregroundStyle(numberStyle)
                .frame(width: Self.digitSize, height: Self.digitSize)
                .measuresZoomFrame(if: selected) { zoomMeasures?.monthDay = $0 }
            CalendarMonthChips(items: visible)
            Spacer(minLength: 0)
        }
        .padding(.top, Self.digitTop)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .overlay(alignment: .top) { Rectangle().fill(Color.secondary.opacity(0.25)).frame(height: 0.5) }
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(CalendarDates.dayTitle(date))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier(CalendarIdentifiers.day(date))
    }
}

// MARK: - Private
private extension CalendarMonthCell {

    /// The day's number, as the system Calendar's compact month sets it, and the room between it and the line.
    static let digitFontSize: CGFloat = 19
    static let lineGap: CGFloat = 4

    var visible: [CalendarItem] {
        items.filter { $0.kind != .trace && $0.kind != .sleep }
    }

    var numberStyle: AnyShapeStyle {
        if date == today { return AnyShapeStyle(Theme.Colors.today) }
        return isWeekday ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary)
    }
}

/// What is on a day, as the system Calendar's month draws it: the first two items as chips with their titles in the
/// colour of their calendars (an all-day one is a capsule with a dot, a timed one a rounded rectangle), and below them
/// "+N" for as many as did not fit. All-day items and the ones that last several days come first, then the timed ones
/// by their start.
struct CalendarMonthChips: View {

    let items: [CalendarItem]

    var body: some View {
        let shown = Array(ordered.prefix(Self.capacity))
        VStack(spacing: Self.gap) {
            ForEach(shown, id: \.identity) { item in
                chip(item)
            }
            if ordered.count > shown.count {
                Text("+\(ordered.count - shown.count)")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, Self.margin)
        .accessibilityHidden(true)
    }

    /// The items in the order the cell shows them.
    var ordered: [CalendarItem] {
        items.sorted { lhs, rhs in
            let left = lhs.allDay ? -1 : (lhs.startMinutes ?? 0)
            let right = rhs.allDay ? -1 : (rhs.startMinutes ?? 0)
            return left < right
        }
    }

    func chip(_ item: CalendarItem) -> some View {
        HStack(spacing: 3) {
            if item.allDay {
                Circle().fill(item.tint).frame(width: 9, height: 9)
            }
            // A title longer than the chip fades out at its end, as in the system Calendar, rather than ending in dots.
            // It is drawn over an empty line, so however long it is it asks the cell for no width.
            Color.clear
                .frame(maxWidth: .infinity, minHeight: Self.chipHeight, maxHeight: Self.chipHeight)
                .overlay(alignment: .leading) {
                    Text(item.displayTitle)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                        .fixedSize()
                        .foregroundStyle(item.tint.mix(with: .black, by: 0.35))
                }
                .clipped()
                .mask(alignment: .leading) { fade }
        }
        .padding(.horizontal, 3)
        .frame(maxWidth: .infinity, minHeight: Self.chipHeight, maxHeight: Self.chipHeight, alignment: .leading)
        .background(item.tint.opacity(0.22), in: RoundedRectangle(cornerRadius: item.allDay ? Self.chipHeight / 2 : 4))
        .clipped()
    }

    /// Opaque but for the last few points, which fade out.
    var fade: some View {
        LinearGradient(
            stops: [.init(color: .black, location: 0.8), .init(color: .clear, location: 1)],
            startPoint: .leading,
            endPoint: .trailing
        )
    }

    /// How many chips a cell holds before it says how many more there are.
    static let capacity = 2
    static let chipHeight: CGFloat = 16
    static let gap: CGFloat = 3
    static let margin: CGFloat = 1.5
}
