import SwiftUI

/// The calendar of the app's date picker: one month at a time with the selected day filled and today in the accent
/// color, a button for today and, where a date may be removed, one to remove it. Values are `yyyy-MM-dd` texts.
/// Present it in `glassPopover`.
public struct DatePickerPanel: View {

    // MARK: - Dependencies
    private let value: String?
    private let today: String
    private let isClearable: Bool
    private let onPick: (String) -> Void
    private let onClear: () -> Void

    // MARK: - Properties
    @State private var month: MonthGrid
    private let calendar = Calendar.current

    // MARK: - Init
    /// Opens on the month of `value`, or of `today` without a value. `onPick` receives the picked day's text.
    public init(
        value: String?,
        today: String,
        isClearable: Bool = false,
        onPick: @escaping (String) -> Void,
        onClear: @escaping () -> Void = {}
    ) {
        self.value = value
        self.today = today
        self.isClearable = isClearable
        self.onPick = onPick
        self.onClear = onClear
        let shown = value.flatMap(IsoDay.init) ?? IsoDay(today) ?? IsoDay(year: 1970, month: 1, day: 1)
        _month = State(initialValue: MonthGrid(year: shown.year, month: shown.month))
    }

    // MARK: - Body
    public var body: some View {
        VStack(spacing: Theme.Spacing.small) {
            header
            weekdays
            days
            footer
        }
        .padding(Theme.Spacing.medium)
        .frame(width: Self.width)
    }

    private static let width: CGFloat = 320
}

// MARK: - Subviews
private extension DatePickerPanel {

    var header: some View {
        HStack {
            Text(title(of: month))
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Button { month = month.shifted(by: -1) } label: {
                Image(systemName: "chevron.left")
            }
            .accessibilityLabel(Text("datePicker.previousMonth", bundle: .module))
            Button { month = month.shifted(by: 1) } label: {
                Image(systemName: "chevron.right")
            }
            .accessibilityLabel(Text("datePicker.nextMonth", bundle: .module))
        }
        .buttonStyle(.borderless)
    }

    var weekdays: some View {
        HStack(spacing: 0) {
            ForEach(Array(weekdaySymbols.enumerated()), id: \.offset) { _, symbol in
                Text(symbol)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .frame(maxWidth: .infinity)
            }
        }
        .accessibilityHidden(true)
    }

    var days: some View {
        let cells = month.cells(firstWeekday: calendar.firstWeekday)
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 7), spacing: 4) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, day in
                if let day {
                    dayButton(day)
                } else {
                    Color.clear.frame(height: Self.cellHeight)
                }
            }
        }
    }

    var footer: some View {
        HStack {
            Button { onPick(today) } label: { Text("datePicker.today", bundle: .module) }
            Spacer()
            if isClearable {
                Button(role: .destructive, action: onClear) { Text("datePicker.clear", bundle: .module) }
            }
        }
        .buttonStyle(.borderless)
    }

    func dayButton(_ day: Int) -> some View {
        let iso = IsoDay(year: month.year, month: month.month, day: day)
        let selected = iso.text == value
        let isToday = iso.text == today
        let isEmphasized = selected || isToday
        return Button { onPick(iso.text) } label: {
            Text(day, format: .number.grouping(.never))
                .font(.body.weight(isEmphasized ? .semibold : .regular))
                .foregroundStyle(dayStyle(selected: selected, isToday: isToday))
                .frame(maxWidth: .infinity)
                .frame(height: Self.cellHeight)
                .background {
                    if selected { Circle().fill(Theme.Colors.accent) }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(iso.date, format: .dateTime.day().month(.wide).year()))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    func dayStyle(selected: Bool, isToday: Bool) -> AnyShapeStyle {
        if selected { return AnyShapeStyle(.background) }
        return isToday ? AnyShapeStyle(Theme.Colors.accent) : AnyShapeStyle(.primary)
    }

    static let cellHeight: CGFloat = 36

    func title(of month: MonthGrid) -> String {
        month.title(calendar: calendar)
    }

    /// The very short weekday names starting on the calendar's first weekday.
    var weekdaySymbols: [String] {
        let symbols = calendar.veryShortStandaloneWeekdaySymbols
        let first = calendar.firstWeekday - 1
        return Array(symbols[first...] + symbols[..<first])
    }
}

// MARK: - Preview
#Preview {
    DatePickerPanel(value: "2026-10-16", today: "2026-10-16", isClearable: true, onPick: { _ in }, onClear: {})
}
