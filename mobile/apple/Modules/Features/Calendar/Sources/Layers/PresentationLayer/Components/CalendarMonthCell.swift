import CoreKit
import DesignSystem
import SwiftUI

/// One day of the month view, as the system Calendar's compact month: the day's number and below it a line of what is
/// on the day, a capsule as long as the day's events last, in their calendars' colours. The line only shows; a tap
/// anywhere on the cell opens the day, where its items are edited.
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
            CalendarDayLine(items: visible)
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
    static let lineGap: CGFloat = 7

    var visible: [CalendarItem] {
        items.filter { $0.kind != .trace && $0.kind != .sleep }
    }

    var numberStyle: AnyShapeStyle {
        if date == today { return AnyShapeStyle(Theme.Colors.today) }
        return isWeekday ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary)
    }
}

/// What is on a day, as the system Calendar's compact month draws it: a capsule 6 points tall that grows 6 points for
/// every hour the day's items last (an item shorter than an hour, all-day or without a time counts as an hour, so one
/// alone is a dot), each item a stretch of it in its calendar's colour at half strength. A day fuller than the cell is
/// wide shows the same shares in the width there is. Nothing when the day is empty.
struct CalendarDayLine: View {

    let items: [CalendarItem]

    var body: some View {
        let hours = items.map(Self.hours)
        let total = hours.reduce(0, +)
        if total > 0 {
            GeometryReader { proxy in
                let width = min(CGFloat(total) * Self.pointsPerHour, proxy.size.width - Self.margin * 2)
                HStack(spacing: 0) {
                    ForEach(items.indices, id: \.self) { index in
                        Rectangle()
                            .fill(items[index].tint.opacity(Self.strength))
                            .frame(width: width * CGFloat(hours[index] / total))
                    }
                }
                .frame(width: width, height: Self.height)
                .clipShape(.capsule)
                .frame(maxWidth: .infinity)
            }
            .frame(height: Self.height)
            .accessibilityHidden(true)
        }
    }

    /// How long an item lasts on its day, in hours, at least one.
    static func hours(_ item: CalendarItem) -> Double {
        guard !item.allDay, let start = item.startMinutes, let end = item.endMinutes, end > start else { return 1 }
        return max(Double(end - start) / 60, 1)
    }

    static let height: CGFloat = 6
    static let pointsPerHour: CGFloat = 6
    static let strength = 0.5
    /// The room the line leaves at each side of the cell, however full the day is.
    static let margin: CGFloat = 4
}
