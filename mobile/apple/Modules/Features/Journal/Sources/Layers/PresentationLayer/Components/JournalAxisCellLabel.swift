import CoreKit
import DesignSystem
import SwiftUI

// MARK: - Cell
/// One period on the axis: the selection on a flat capsule in the deep accent, drawn as the calendar's week strip
/// draws its selected day, the day, month, quarter and year of today's date in gold, weekends greyed.
struct JournalAxisCellLabel: View {

    // MARK: - Dependencies
    let cell: JournalAxisCell

    // MARK: - Body
    var body: some View {
        Text(cell.title)
            .font(font)
            .fontWeight(emphasized ? .bold : .semibold)
            .foregroundStyle(color)
            .lineLimit(1)
            .fixedSize()
            // The capsule leaves room on both sides of the text, and is never narrower than the cell's own room.
            .padding(.horizontal, Self.pillPadding)
            .frame(minWidth: cell.kind.width - Self.gap)
            .frame(height: cell.kind.height - Self.gap)
            .background { pill }
            // The cell keeps its width on the axis; a capsule wider than it reaches into the gaps beside it.
            .frame(width: cell.kind.width - Self.gap)
            .padding(Self.gap / 2)
            .contentShape(.capsule)
    }

    /// The capsule behind the selected period, as the calendar's circle behind its selected day: whole on the
    /// selection, shrunk and hidden on the other periods. It grows from that size when its period is selected and
    /// shrinks to it when another one is; it fades out over the first half of the shrinking and in over the second
    /// half of the growing, so it is gone while still half its size.
    private var pill: some View {
        let isSelected = cell.current
        return Capsule()
            .fill(Theme.Colors.selection)
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
        if cell.today { return Theme.Colors.today }
        return weekend ? Theme.Colors.secondaryText : .primary
    }
    private var font: Font { cell.kind == .year ? .title3 : .subheadline }

    /// The space between two neighbouring pills.
    private static let gap: CGFloat = 6
    /// The room between the text and the ends of its capsule.
    private static let pillPadding: CGFloat = 12
    /// How long the capsule takes to grow or shrink, and how small it is on a period that is not selected: as the
    /// calendar's week strip.
    private static let duration = 0.25
    private static let shrunk = 0.2
}

// MARK: - Labels
@MainActor
extension JournalAxisCell {

    var title: String {
        switch kind {
        case .year: String(year)
        case .quarter: "Q\(quarter) \(String(format: "%02d", year % 100))"
        case .month: "\(JournalDates.monthShort(month)) \(String(format: "%02d", year % 100))"
        case .day, .week: "\(JournalDates.weekdayShort(weekday)) \(day)"
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

    var width: CGFloat {
        switch self {
        case .year: 92
        case .quarter: 74
        case .month: 70
        case .week, .day: 68
        }
    }

    var height: CGFloat {
        switch self {
        case .year: 38
        case .quarter, .month, .week: 32
        case .day: 36
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
