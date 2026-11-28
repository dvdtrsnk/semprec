import DesignSystem
import SwiftUI

/// The top of the month view: the month's large name (in today's gold for the current month), the weekday initials
/// and a line under them. Its parts fade in
/// a change to or from a day. The calendar also lays out a hidden copy, so it knows the height before a month was
/// ever shown.
struct CalendarMonthHeader: View {

    // MARK: - Dependencies
    let title: String
    var isCurrent = false

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            Text(title)
                .font(.largeTitle.bold())
                .foregroundStyle(isCurrent ? Theme.Colors.today : .primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.bottom, 4)
                .accessibilityAddTraits(.isHeader)
                .modifier(CalendarZoomFade())
            weekdays
                .modifier(CalendarZoomFade())
            Divider()
                .modifier(CalendarZoomFade())
        }
    }
}

// MARK: - Subviews
private extension CalendarMonthHeader {

    var weekdays: some View {
        HStack(spacing: 0) {
            ForEach(1...7, id: \.self) { weekday in
                Text(CalendarDates.weekdayInitial(weekday))
                    .font(.caption2)
                    .foregroundStyle(weekday >= 6 ? .tertiary : .secondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 6)
    }
}
