import CoreKit
import DesignSystem
import SwiftUI

// MARK: - Cell
/// One period on the axis, laid out as the calendar's week strip lays out a day: a small grey caption above (the
/// weekday of a day, the year over each January) and the period below in the strip's type, on a flat capsule in the
/// deep accent when it is selected, as the strip's circle. The day, month, quarter and year of today's date are in
/// gold, weekends greyed.
struct JournalAxisCellLabel: View {

    // MARK: - Dependencies
    let cell: JournalAxisCell

    // MARK: - Body
    var body: some View {
        VStack(spacing: Self.captionSpacing) {
            if cell.kind.hasCaption {
                // The line keeps its place under a month without a caption, so the months stay level.
                Text(cell.caption ?? " ")
                    .font(.caption2)
                    .foregroundStyle(weekend ? Theme.Colors.secondaryText.opacity(0.6) : Theme.Colors.secondaryText)
                    .lineLimit(1)
                    .fixedSize()
            }
            Text(cell.title)
                .font(.callout.weight(emphasized ? .semibold : .regular))
                .foregroundStyle(color)
                .lineLimit(1)
                .fixedSize()
                // A capsule round the text, a circle round a short one, as the strip's circle round a day.
                .padding(.horizontal, Self.pillPadding)
                .frame(minWidth: Self.pillHeight, minHeight: Self.pillHeight)
                .background { pill }
        }
        // The cell keeps its width on the axis; a capsule wider than it reaches into the room beside it.
        .frame(width: cell.kind.width, height: cell.kind.height)
        .contentShape(.rect)
    }

    /// The capsule behind the selected period, as the calendar's circle behind its selected day: whole on the
    /// selection, shrunk and hidden on the other periods. It grows from that size when its period is selected and
    /// shrinks to it when another one is; it fades out over the first half of the shrinking and in over the second
    /// half of the growing, so it is gone while still half its size.
    private var pill: some View {
        let isSelected = cell.current
        return Capsule()
            .fill(Theme.Colors.appAccent)
            .scaleEffect(isSelected ? 1 : Self.shrunk)
            .animation(.easeInOut(duration: Self.duration), value: isSelected)
            .opacity(isSelected ? 1 : 0)
            .animation(
                isSelected
                    ? .easeOut(duration: Self.duration / 2).delay(Self.duration / 2)
                    : .easeIn(duration: Self.duration / 2),
                value: isSelected
            )
    }

    private var emphasized: Bool { cell.current || cell.today }
    private var weekend: Bool { cell.kind == .day && cell.weekday > 5 }
    /// The periods that hold today's date, the day, its month, quarter and year, are in gold whatever is selected.
    private var color: Color {
        if cell.current { return .white }
        if cell.today { return JournalColors.gold }
        return weekend ? Theme.Colors.secondaryText : .primary
    }

    /// As the calendar's week strip: the room between the caption and the period, the height of the selection's
    /// circle, how long it takes to grow or shrink and how small it is on a period that is not selected.
    private static let captionSpacing: CGFloat = 4
    private static let pillHeight: CGFloat = 34
    private static let duration = 0.25
    private static let shrunk = 0.2
    /// The room between the text and the ends of its capsule.
    private static let pillPadding: CGFloat = 10
}

// MARK: - Labels
@MainActor
extension JournalAxisCell {

    /// The period itself: the day's number, the month's short name, the year.
    var title: String {
        switch kind {
        case .year: String(year)
        case .quarter: "Q\(quarter)"
        case .month: JournalDates.monthShort(month)
        case .day, .week: String(day)
        }
    }

    /// What the small line above the period says: a day's weekday, and the year over the first month or quarter of
    /// a year, where the months turn to another one.
    var caption: String? {
        switch kind {
        case .year: nil
        case .quarter, .month: month == 1 ? String(year) : nil
        case .day, .week: JournalDates.weekdayShort(weekday)
        }
    }

    var identifier: String {
        "\(JournalIdentifiers.axisCellPrefix)\(kind.name).\(start)"
    }

    var accessibilityTitle: String {
        switch kind {
        case .year: String(year)
        case .quarter: "Q\(quarter) \(year)"
        case .month: JournalDates.monthTitle(start)
        case .day, .week: "\(JournalDates.dayTitle(start)) \(year)"
        }
    }
}

// MARK: - Sizes
extension JournalPeriodKind {

    var name: String {
        switch self {
        case .year: "year"
        case .quarter: "quarter"
        case .month: "month"
        case .week: "week"
        case .day: "day"
        }
    }

    /// About as wide as a day of the calendar's week strip, a seventh of a phone's width.
    var width: CGFloat {
        switch self {
        case .year: 80
        case .quarter, .month: 60
        case .week, .day: 54
        }
    }

    /// Whether the period has a line above it, as a day of the calendar's week strip has its weekday.
    var hasCaption: Bool { self != .year }

    /// A caption above a period, as in the calendar's week strip; a year has the period alone.
    var height: CGFloat {
        switch self {
        case .year: 40
        case .quarter, .month, .week, .day: 54
        }
    }

    /// The average length of the period, in days.
    var typicalSpan: Double {
        switch self {
        case .year: 365.25
        case .quarter: 91.31
        case .month: 30.44
        case .week: 7
        case .day: 1
        }
    }
}
