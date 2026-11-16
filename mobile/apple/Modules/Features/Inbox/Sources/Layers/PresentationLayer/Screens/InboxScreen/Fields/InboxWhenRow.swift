import CoreKit
import DesignSystem
import SwiftUI

/// A day, or a day and a time. The day and the time are two buttons that open the app's date and time pickers next
/// to them; a time is not shown when the card says the item takes the whole day.
struct InboxWhenRow: View {

    // MARK: - Types
    enum Picking {
        case date
        case time
    }

    // MARK: - Dependencies
    let cardId: String
    let field: InboxField
    let send: (InboxAction) -> Void

    // MARK: - Properties
    @State private var picking: Picking?

    // MARK: - Body
    var body: some View {
        InboxRowFrame(field: field) {
            HStack(spacing: 6) {
                pill(dayText, isOn: picking == .date, tint: field.date == nil) { picking = .date }
                    .glassPopover(isPresented: shown(.date)) { datePanel }
                    .accessibilityIdentifier(field.identifier + ".date")
                if field.type == .datetime, field.showTime {
                    pill(timeText, isOn: picking == .time, tint: field.time == nil) { picking = .time }
                        .glassPopover(isPresented: shown(.time)) { timePanel }
                        .accessibilityIdentifier(field.identifier + ".time")
                }
            }
        }
    }
}

// MARK: - Subviews
private extension InboxWhenRow {

    var dayText: String {
        InboxFormatting.day(field.date) ?? String(localized: "inbox.pick", bundle: .module)
    }

    var timeText: String {
        InboxFormatting.time(field.time) ?? String(localized: "inbox.pickTime", bundle: .module)
    }

    func shown(_ part: Picking) -> Binding<Bool> {
        Binding(
            get: { picking == part },
            set: { if !$0, picking == part { picking = nil } }
        )
    }

    func pill(_ text: String, isOn: Bool, tint: Bool, action: @escaping () -> Void) -> some View {
        let highlighted = tint || isOn
        return Button(action: action) {
            Text(text)
                .padding(.horizontal, 10)
                .frame(minHeight: 32)
                .foregroundStyle(highlighted ? Theme.Colors.accent : Color.primary)
                .background(
                    isOn ? Theme.Colors.accent.opacity(0.12) : Color.gray.opacity(0.12),
                    in: .rect(cornerRadius: 8)
                )
        }
        .buttonStyle(.plain)
    }

    var datePanel: some View {
        DatePickerPanel(value: field.date, today: InboxFormatting.today()) { day in
            picking = nil
            send(.setDate(cardId: cardId, key: field.key, date: day))
        }
    }

    var timePanel: some View {
        TimePickerPanel(value: field.time ?? "") { time in
            send(.setTime(cardId: cardId, key: field.key, time: time))
        } onDone: {
            picking = nil
        }
    }
}
