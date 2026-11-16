import CoreKit
import DesignSystem
import SwiftUI

/// A day, or a day and a time, in the system's compact date and time pickers. A part the card has no value for yet is
/// a button that fills it in (today, or the morning); a time is not shown when the card says the item takes the whole
/// day.
struct InboxWhenRow: View {

    // MARK: - Dependencies
    let cardId: String
    let field: InboxField
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        InboxRowFrame(field: field) {
            HStack(spacing: Theme.Spacing.small) {
                dayPicker.accessibilityIdentifier(field.identifier + ".date")
                if field.type == .datetime, field.showTime {
                    timePicker.accessibilityIdentifier(field.identifier + ".time")
                }
            }
        }
    }
}

// MARK: - Subviews
private extension InboxWhenRow {

    @ViewBuilder var dayPicker: some View {
        if let day = field.date, let date = IsoDay.date(from: String(day.prefix(10))) {
            DatePicker(
                selection: Binding(get: { date }, set: { setDate(IsoDay.string(from: $0)) }),
                displayedComponents: .date
            ) {
                Text(field.label)
            }
            .labelsHidden()
        } else {
            Button { setDate(InboxFormatting.today()) } label: { Text("inbox.pick", bundle: .module) }
                .buttonStyle(.bordered)
        }
    }

    @ViewBuilder var timePicker: some View {
        if let time = field.time, let date = ClockTime.date(from: time) {
            DatePicker(
                selection: Binding(get: { date }, set: { setTime(ClockTime.string(from: $0)) }),
                displayedComponents: .hourAndMinute
            ) {
                Text(field.label)
            }
            .labelsHidden()
        } else {
            Button { setTime(Self.morning) } label: { Text("inbox.pickTime", bundle: .module) }
                .buttonStyle(.bordered)
        }
    }

    func setDate(_ day: String) {
        send(.setDate(cardId: cardId, key: field.key, date: day))
    }

    func setTime(_ time: String) {
        send(.setTime(cardId: cardId, key: field.key, time: time))
    }

    /// Where a time the card has none of begins.
    static var morning: String { "09:00" }
}
