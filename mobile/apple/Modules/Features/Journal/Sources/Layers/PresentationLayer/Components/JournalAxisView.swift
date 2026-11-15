import CoreKit
import DesignSystem
import SwiftUI

/// The time axis of the diary: a row of years, quarters, months and days, each scrolling sideways. The selection and
/// the periods that contain it are marked, today is orange. While the page below is scrolled (`compact`), only the row
/// of the selected level stays.
struct JournalAxisView: View {

    // MARK: - Dependencies
    let rows: [JournalAxisRow]
    let selectionStart: String
    let compact: Bool
    let onSelect: (JournalAxisCell) -> Void

    // MARK: - Body
    var body: some View {
        VStack(spacing: 2) {
            ForEach(visibleRows) { row in
                JournalAxisRowView(row: row, selectionStart: selectionStart, onSelect: onSelect)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("journal.axis.label", bundle: .module))
    }

    private var visibleRows: [JournalAxisRow] {
        compact ? rows.filter { row in row.cells.contains(where: \.current) } : rows
    }
}

// MARK: - Row
private struct JournalAxisRowView: View {

    // MARK: - Dependencies
    let row: JournalAxisRow
    let selectionStart: String
    let onSelect: (JournalAxisCell) -> Void

    // MARK: - Body
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 4) {
                    ForEach(row.cells) { cell in
                        Button { onSelect(cell) } label: { JournalAxisCellLabel(cell: cell) }
                            .buttonStyle(.plain)
                            .id(cell.id)
                            .accessibilityLabel(Text(cell.accessibilityTitle))
                            .accessibilityAddTraits(cell.current ? .isSelected : [])
                            .accessibilityIdentifier(cell.identifier)
                    }
                }
                .padding(.horizontal, Theme.Spacing.medium)
            }
            .frame(height: row.kind.height)
            .onAppear { proxy.scrollTo(anchor, anchor: .center) }
            .onChange(of: anchor) { _, id in withAnimation { proxy.scrollTo(id, anchor: .center) } }
        }
    }

    /// The cell the row centers on: the selected period, else the period on the path, else the first one at or after
    /// the selection (a row narrower than the selection has no period on the path).
    private var anchor: String {
        row.cells.first(where: \.current)?.id
            ?? row.cells.first(where: \.onPath)?.id
            ?? row.cells.first(where: { $0.start >= selectionStart })?.id
            ?? row.cells.last?.id
            ?? selectionStart
    }
}

// MARK: - Cell
private struct JournalAxisCellLabel: View {

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
        .frame(width: cell.kind.width, height: cell.kind.height - 4)
        .background(cell.current ? fill : .clear, in: .rect(cornerRadius: 10))
        .overlay {
            if cell.onPath && !cell.current {
                RoundedRectangle(cornerRadius: 10).strokeBorder(cell.today ? Color.orange : ring, lineWidth: 1.5)
            }
        }
        .contentShape(.rect)
    }

    private var emphasized: Bool { cell.current || cell.today }
    private var weekend: Bool { cell.kind == .day && cell.weekday > 5 }
    private var color: Color {
        if cell.today { return .orange }
        return weekend ? Theme.Colors.secondaryText : .primary
    }
    private var subColor: Color { cell.today ? .orange : Theme.Colors.secondaryText }
    private var fill: Color { cell.today ? Color.orange.opacity(0.15) : Color.secondary.opacity(0.15) }
    private var ring: Color { Color.secondary.opacity(0.5) }
    private var font: Font { cell.kind == .year ? .body : .subheadline }
}

// MARK: - Labels
@MainActor
private extension JournalAxisCell {

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

private extension JournalPeriodKind {

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
}
