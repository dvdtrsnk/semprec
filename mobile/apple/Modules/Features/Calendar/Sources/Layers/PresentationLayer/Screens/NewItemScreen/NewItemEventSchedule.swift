import CoreKit
import DesignSystem
import SwiftUI

/// When an event is, as the system Calendar asks it: first one line with the day and the times, which opens into
/// the start and the end, each a day and a time in a pill, the all-day switch and the repeat. A pill opens its
/// calendar or its time wheels under its row; only one is open at a time.
struct NewItemEventSchedule: View {

    // MARK: - Dependencies
    @Binding var form: NewItemForm

    // MARK: - State
    @State private var isOpen = false
    @State private var picking: Picking?

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            if isOpen {
                rows
            } else {
                summary
            }
        }
        .newItemCard()
        .animation(.smooth(duration: 0.3), value: isOpen)
        .animation(.smooth(duration: 0.3), value: picking)
    }
}

// MARK: - Subviews
private extension NewItemEventSchedule {

    enum Picking: Equatable {
        case startDay, startTime, endDay, endTime
    }

    /// The day and the times in one line; a tap opens the rows.
    var summary: some View {
        Button { isOpen = true } label: {
            HStack {
                Text(NewItemDates.long(form.day))
                Spacer()
                Text(timeSummary).monospacedDigit()
            }
            .padding(.horizontal, NewItemCard.rowPadding + 4)
            .frame(minHeight: Theme.Layout.rowHeight + 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(CalendarSheetIdentifiers.newItemSchedule)
    }

    var timeSummary: String {
        guard form.timed else { return String(localized: "newItem.allDay", table: "Sheets", bundle: .module) }
        return NewItemDates.time(form.startMinutes) + "–" + NewItemDates.time(form.endMinutes)
    }

    @ViewBuilder var rows: some View {
        edge("newItem.start", day: .startDay, time: .startTime, dayValue: form.day, minutes: form.startMinutes)
        picker(for: .startDay)
        picker(for: .startTime)
        NewItemDivider()
        edge("newItem.end", day: .endDay, time: .endTime, dayValue: form.endDay, minutes: form.endMinutes)
        picker(for: .endDay)
        picker(for: .endTime)
        NewItemDivider()
        NewItemRow(systemImage: "calendar", key: "newItem.allDay") {
            Toggle(isOn: allDay) { Text("newItem.allDay", tableName: "Sheets", bundle: .module) }
                .labelsHidden()
                .accessibilityIdentifier(CalendarSheetIdentifiers.newItemTimed)
        }
        NewItemDivider(inset: NewItemCard.rowPadding + NewItemCard.iconWidth + 12)
        NewItemRow(systemImage: "repeat", key: "newItem.repeat") {
            NewItemRepeatMenu(repeatRule: $form.repeatRule, choices: NewItemOptions.eventRepeats)
        }
    }

    /// A row with a day pill and, for a timed event, a time pill.
    func edge(
        _ key: LocalizedStringKey, day: Picking, time: Picking, dayValue: String, minutes: Int
    ) -> some View {
        let struck = day == .endDay && form.endsBeforeStart
        return NewItemRow(systemImage: nil, key: key) {
            pill(NewItemDates.numeric(dayValue), for: day, struck: struck && form.endDay < form.day)
            if form.timed {
                pill(NewItemDates.time(minutes), for: time, struck: struck)
            }
        }
        .accessibilityIdentifier(
            day == .startDay ? CalendarSheetIdentifiers.newItemStart : CalendarSheetIdentifiers.newItemEnd
        )
    }

    func pill(_ text: String, for target: Picking, struck: Bool) -> some View {
        Button { picking = picking == target ? nil : target } label: {
            Text(text)
                .monospacedDigit()
                .strikethrough(struck)
                .foregroundStyle(picking == target ? NewItemCard.pickerTint : .primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(Color.secondary.opacity(0.14), in: Capsule())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    func picker(for target: Picking) -> some View {
        if picking == target {
            switch target {
            case .startDay:
                DatePicker(selection: startDay, displayedComponents: .date) { EmptyView() }
                    .datePickerStyle(.graphical)
                    .tint(NewItemCard.pickerTint)
                    .padding(.horizontal, NewItemCard.rowPadding)
            case .endDay:
                DatePicker(selection: endDay, in: NewItemForm.date(ofDay: form.day)..., displayedComponents: .date) {
                    EmptyView()
                }
                .datePickerStyle(.graphical)
                .tint(NewItemCard.pickerTint)
                .padding(.horizontal, NewItemCard.rowPadding)
            case .startTime, .endTime:
                DatePicker(selection: target == .startTime ? start : end, displayedComponents: .hourAndMinute) {
                    EmptyView()
                }
                .wheelDatePicker()
                .labelsHidden()
                .frame(maxWidth: .infinity)
            }
        }
    }

    var allDay: Binding<Bool> {
        Binding(get: { !form.timed }, set: { form.timed = !$0 })
    }

    var startDay: Binding<Date> {
        Binding(get: { NewItemForm.date(ofDay: form.day) }, set: { form.moveDay(to: NewItemForm.day(of: $0)) })
    }

    var endDay: Binding<Date> {
        Binding(get: { NewItemForm.date(ofDay: form.endDay) }, set: { form.endDay = NewItemForm.day(of: $0) })
    }

    var start: Binding<Date> {
        Binding(
            get: { NewItemForm.time(minutes: form.startMinutes) },
            set: { form.moveStart(to: NewItemForm.minutes(of: $0)) }
        )
    }

    var end: Binding<Date> {
        Binding(
            get: { NewItemForm.time(minutes: form.endMinutes) },
            set: { form.endMinutes = NewItemForm.minutes(of: $0) }
        )
    }
}

/// The repeat of a new item as a menu of its choices, the chosen one at the trailing edge.
struct NewItemRepeatMenu: View {

    @Binding var repeatRule: NewItemRepeat
    let choices: [NewItemRepeat]

    var body: some View {
        Picker(selection: $repeatRule) {
            ForEach(choices, id: \.self) { Text(NewItemOptions.name(of: $0)).tag($0) }
        } label: {
            Text("newItem.repeat", tableName: "Sheets", bundle: .module)
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .tint(.secondary)
        .accessibilityIdentifier(CalendarSheetIdentifiers.newItemRepeat)
    }
}

/// How the form writes a day and a time: `Thu 19. 11. 2026`, `19. 11. 2026`, `11:00`, and `Today` or `Tomorrow`.
enum NewItemDates {

    static func long(_ day: String) -> String {
        NewItemForm.date(ofDay: day).formatted(.dateTime.weekday(.abbreviated).day().month(.defaultDigits).year())
    }

    static func numeric(_ day: String) -> String {
        NewItemForm.date(ofDay: day).formatted(.dateTime.day().month(.defaultDigits).year())
    }

    static func time(_ minutes: Int) -> String {
        NewItemForm.time(minutes: minutes).formatted(.dateTime.hour(.twoDigits(amPM: .abbreviated)).minute(.twoDigits))
    }

    /// `Today`, `Tomorrow` or the long form of any other day.
    static func relative(_ day: String, calendar: Calendar = .current) -> String {
        let date = NewItemForm.date(ofDay: day, calendar: calendar)
        if calendar.isDateInToday(date) { return String(localized: "newItem.today", table: "Sheets", bundle: .module) }
        if calendar.isDateInTomorrow(date) {
            return String(localized: "newItem.tomorrow", table: "Sheets", bundle: .module)
        }
        return long(day)
    }
}
