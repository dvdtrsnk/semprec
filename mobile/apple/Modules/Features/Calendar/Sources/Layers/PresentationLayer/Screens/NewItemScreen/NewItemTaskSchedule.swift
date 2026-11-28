import DesignSystem
import SwiftUI

/// When a task is, as the system Reminders asks it: a date row with the day in red (`Today`, `Tomorrow`) that opens
/// a calendar under it, and a time row with a switch whose time opens wheels under it.
struct NewItemTaskSchedule: View {

    // MARK: - Dependencies
    @Binding var form: NewItemForm

    // MARK: - State
    @State private var picking: Picking?

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            Button { toggle(.day) } label: {
                row(systemImage: "calendar", key: "newItem.date", value: NewItemDates.relative(form.day))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(CalendarSheetIdentifiers.newItemDate)
            if picking == .day {
                DatePicker(selection: day, displayedComponents: .date) { EmptyView() }
                    .datePickerStyle(.graphical)
                    .tint(NewItemCard.pickerTint)
                    .padding(.horizontal, NewItemCard.rowPadding)
            }
            NewItemDivider(inset: NewItemCard.rowPadding + NewItemCard.iconWidth + 12)
            HStack {
                Button { if form.timed { toggle(.time) } } label: {
                    row(
                        systemImage: "clock",
                        key: "newItem.time",
                        value: form.timed ? NewItemDates.time(form.startMinutes) : nil
                    )
                }
                .buttonStyle(.plain)
                Toggle(isOn: timed) { Text("newItem.time", tableName: "Sheets", bundle: .module) }
                    .labelsHidden()
                    .padding(.trailing, NewItemCard.rowPadding)
                    .accessibilityIdentifier(CalendarSheetIdentifiers.newItemTimed)
            }
            if picking == .time, form.timed {
                DatePicker(selection: start, displayedComponents: .hourAndMinute) { EmptyView() }
                    .wheelDatePicker()
                    .labelsHidden()
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier(CalendarSheetIdentifiers.newItemStart)
            }
        }
        .newItemCard()
        .animation(.smooth(duration: 0.3), value: picking)
        .animation(.smooth(duration: 0.3), value: form.timed)
    }
}

// MARK: - Subviews
private extension NewItemTaskSchedule {

    enum Picking: Equatable {
        case day, time
    }

    func toggle(_ target: Picking) {
        picking = picking == target ? nil : target
    }

    /// A symbol, the label and under it the value in red.
    func row(systemImage: String, key: LocalizedStringKey, value: String?) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(.secondary)
                .frame(width: NewItemCard.iconWidth)
            VStack(alignment: .leading, spacing: 2) {
                Text(key, tableName: "Sheets", bundle: .module)
                if let value {
                    Text(value).font(.subheadline).foregroundStyle(NewItemCard.pickerTint)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, NewItemCard.rowPadding)
        .frame(minHeight: Theme.Layout.rowHeight + 10)
        .contentShape(Rectangle())
    }

    var timed: Binding<Bool> {
        Binding(
            get: { form.timed },
            set: { isOn in
                form.timed = isOn
                picking = isOn ? .time : nil
            }
        )
    }

    var day: Binding<Date> {
        Binding(get: { NewItemForm.date(ofDay: form.day) }, set: { form.moveDay(to: NewItemForm.day(of: $0)) })
    }

    var start: Binding<Date> {
        Binding(
            get: { NewItemForm.time(minutes: form.startMinutes) },
            set: { form.moveStart(to: NewItemForm.minutes(of: $0)) }
        )
    }
}
