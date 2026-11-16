import CoreKit
import DesignSystem
import SwiftUI

/// The fields of the new item sheet. An event has a place and a calendar and may end; a task has a day and maybe a
/// time.
struct NewItemFormView: View {

    // MARK: - Dependencies
    @Binding var form: NewItemForm
    let calendars: [NewItemCalendar]
    /// The message of a failed save, shown above the fields.
    let failure: String?

    // MARK: - Body
    var body: some View {
        Form {
            if let failure {
                Section {
                    Label {
                        Text(failure)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                    }
                    .foregroundStyle(Theme.Colors.destructive)
                    .accessibilityIdentifier(CalendarSheetIdentifiers.newItemFailure)
                }
            }
            titleSection
            scheduleSection
            if form.kind == .event {
                placeSection
                if !calendars.isEmpty {
                    optionsSection
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Subviews
private extension NewItemFormView {

    var isEvent: Bool {
        form.kind == .event
    }

    var titleSection: some View {
        Section {
            TextField(text: $form.title, prompt: Text("newItem.name.prompt", tableName: "Sheets", bundle: .module)) {
                if isEvent {
                    Text("newItem.name.event", tableName: "Sheets", bundle: .module)
                } else {
                    Text("newItem.name.task", tableName: "Sheets", bundle: .module)
                }
            }
            .font(.title3.weight(.semibold))
            .accessibilityIdentifier(CalendarSheetIdentifiers.newItemTitle)
        }
    }

    var scheduleSection: some View {
        Section {
            DatePicker(selection: day, displayedComponents: .date) {
                Label {
                    Text("newItem.date", tableName: "Sheets", bundle: .module)
                } icon: {
                    Image(systemName: "calendar")
                }
            }
            .accessibilityIdentifier(CalendarSheetIdentifiers.newItemDate)
            Toggle(isOn: $form.timed) {
                Label {
                    Text("newItem.time", tableName: "Sheets", bundle: .module)
                } icon: {
                    Image(systemName: "clock")
                }
            }
            .accessibilityIdentifier(CalendarSheetIdentifiers.newItemTimed)
            if form.timed {
                DatePicker(selection: start, displayedComponents: .hourAndMinute) {
                    Text("newItem.start", tableName: "Sheets", bundle: .module)
                }
                .accessibilityIdentifier(CalendarSheetIdentifiers.newItemStart)
                if isEvent {
                    endRows
                }
            }
        } header: {
            Text("newItem.schedule", tableName: "Sheets", bundle: .module)
        }
    }

    @ViewBuilder var endRows: some View {
        Toggle(isOn: $form.hasEnd) {
            Text("newItem.end", tableName: "Sheets", bundle: .module)
        }
        .accessibilityIdentifier(CalendarSheetIdentifiers.newItemHasEnd)
        if form.hasEnd {
            DatePicker(selection: end, displayedComponents: .hourAndMinute) {
                Text("newItem.end", tableName: "Sheets", bundle: .module)
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityIdentifier(CalendarSheetIdentifiers.newItemEnd)
        }
    }

    var placeSection: some View {
        Section {
            TextField(text: $form.place, prompt: Text("newItem.place.prompt", tableName: "Sheets", bundle: .module)) {
                Text("newItem.place", tableName: "Sheets", bundle: .module)
            }
            .accessibilityIdentifier(CalendarSheetIdentifiers.newItemPlace)
        } header: {
            Text("newItem.place", tableName: "Sheets", bundle: .module)
        }
    }

    var optionsSection: some View {
        Section {
            Picker(selection: calendar) {
                ForEach(calendars) { choice in
                    Text(choice.name).tag(choice.id)
                }
            } label: {
                // A menu draws its items' symbols in one colour, so the chosen calendar's colour sits by the label.
                Label {
                    Text("newItem.calendar", tableName: "Sheets", bundle: .module)
                } icon: {
                    Image(systemName: "circle.fill")
                        .foregroundStyle(chosenColor)
                }
            }
            .accessibilityIdentifier(CalendarSheetIdentifiers.newItemCalendar)
        } header: {
            Text("newItem.options", tableName: "Sheets", bundle: .module)
        }
    }

    var chosenColor: Color {
        let chosen = calendars.first { $0.id == calendar.wrappedValue }
        return chosen.flatMap { Color(hex: $0.color) } ?? Theme.Colors.accent
    }

    var day: Binding<Date> {
        Binding(
            get: { NewItemForm.date(ofDay: form.day) },
            set: { form.day = NewItemForm.day(of: $0) }
        )
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

    /// The chosen calendar; until the person picks one, the default calendar (or the first) shows as chosen.
    var calendar: Binding<String> {
        Binding(
            get: {
                guard form.calendarId.isEmpty else { return form.calendarId }
                return (calendars.first(where: \.isDefault) ?? calendars.first)?.id ?? ""
            },
            set: { form.calendarId = $0 }
        )
    }
}

// MARK: - Preview
#Preview("Event") {
    @Previewable @State var form = NewItemForm(day: "2026-10-16")
    NavigationStack {
        NewItemFormView(form: $form, calendars: NewItemState.preview.calendars, failure: nil)
    }
}
