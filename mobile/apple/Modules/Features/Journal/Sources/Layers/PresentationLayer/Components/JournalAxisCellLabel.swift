import CoreKit
import DesignSystem
import SwiftUI

// MARK: - Cell
/// One period on the axis: the selection on a glass capsule tinted in the deep accent, the day, month, quarter and
/// year of today's date in gold, weekends greyed.
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
            .minimumScaleFactor(0.7)
            .frame(width: cell.kind.width - Self.gap, height: cell.kind.height - Self.gap)
            .background { pill }
            .padding(Self.gap / 2)
            .contentShape(.capsule)
    }

    /// Only the selected period sits on a capsule of liquid glass tinted in the accent; the others are bare text.
    @ViewBuilder private var pill: some View {
        if cell.current {
            Color.clear
                .glassEffect(.regular.tint(Theme.Colors.appAccent.opacity(0.85)), in: .capsule)
                .shadow(color: Theme.Colors.appAccent.opacity(0.3), radius: 6, y: 3)
        }
    }

    private var emphasized: Bool { cell.current || cell.today }
    private var weekend: Bool { cell.kind == .day && cell.weekday > 5 }
    /// The periods that hold today's date, the day, its month, quarter and year, are in gold whatever is selected.
    private var color: Color {
        if cell.current { return .white }
        if cell.today { return JournalColors.gold }
        return weekend ? Theme.Colors.secondaryText : .primary
    }
    private var font: Font { cell.kind == .year ? .title3 : .subheadline }

    /// The space between two neighbouring pills.
    private static let gap: CGFloat = 6
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
        case .month: 64
        case .week, .day: 62
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
