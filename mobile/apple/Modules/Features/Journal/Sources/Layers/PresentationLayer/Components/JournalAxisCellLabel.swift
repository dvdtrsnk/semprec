import CoreKit
import DesignSystem
import SwiftUI

// MARK: - Cell
struct JournalAxisCellLabel: View {

    // MARK: - Dependencies
    let cell: JournalAxisCell

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            if cell.kind == .day {
                Text(JournalDates.weekdayShort(cell.weekday)).font(.caption2).foregroundStyle(subColor)
            }
            Text(cell.title).font(font).fontWeight(emphasized ? .bold : .medium).foregroundStyle(color)
        }
        .frame(width: cell.kind.width - 4, height: cell.kind.height - 4)
        .background(cell.current ? fill : .clear, in: .rect(cornerRadius: 10))
        .overlay {
            if cell.onPath && !cell.current {
                RoundedRectangle(cornerRadius: 10).strokeBorder(cell.today ? Theme.Colors.accent : ring, lineWidth: 1.5)
            }
        }
        .padding(2)
        .contentShape(.rect)
    }

    private var emphasized: Bool { cell.current || cell.today }
    private var weekend: Bool { cell.kind == .day && cell.weekday > 5 }
    private var color: Color {
        if cell.today { return Theme.Colors.accent }
        return weekend ? Theme.Colors.secondaryText : .primary
    }
    private var subColor: Color { cell.today ? Theme.Colors.accent : Theme.Colors.secondaryText }
    private var fill: Color { cell.today ? Theme.Colors.accent.opacity(0.15) : Color.secondary.opacity(0.15) }
    private var ring: Color { Color.secondary.opacity(0.5) }
    private var font: Font { cell.kind == .year ? .body : .subheadline }
}

// MARK: - Labels
@MainActor
extension JournalAxisCell {

    var title: String {
        switch kind {
        case .year: String(year)
        case .quarter: "Q\(quarter) \(String(format: "%02d", year % 100))"
        case .month: "\(JournalDates.monthShort(month)) \(String(format: "%02d", year % 100))"
        case .day, .week: String(format: "%02d", day)
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
        case .month: 62
        case .week, .day: 38
        }
    }

    var height: CGFloat {
        switch self {
        case .year: 34
        case .quarter, .month, .week: 28
        case .day: 42
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

    /// How many days one point of the row stands for: dragging a row by a point moves the axis this far.
    var daysPerPoint: Double {
        typicalSpan / Double(width)
    }
}
