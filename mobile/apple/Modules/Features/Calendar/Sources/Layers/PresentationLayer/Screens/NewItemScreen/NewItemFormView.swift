import CoreKit
import DesignSystem
import SwiftUI

/// The fields of the new item sheet, laid out as the system Calendar lays out a new event and a new reminder. An
/// event has a bar in its calendar's colour beside its title and its time, then its place, its calendar, alert and
/// travel time, and its notes and link. A task has its notes under its title, its day and time, its repeat and a
/// flag.
struct NewItemFormView: View {

    // MARK: - Dependencies
    @Binding var form: NewItemForm
    /// The calendars a new event can be put on, by where they come from.
    let groups: [NewItemCalendarGroup]
    /// The message of a failed save, shown above the fields.
    let failure: String?

    // MARK: - State
    @State private var isChoosingCalendar = false
    /// The title takes the keyboard as the sheet opens, as the system Calendar's does.
    @FocusState private var isTitleFocused: Bool

    // MARK: - Body
    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.medium) {
                if let failure {
                    Label { Text(failure) } icon: { Image(systemName: "exclamationmark.triangle.fill") }
                        .foregroundStyle(Theme.Colors.destructive)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(NewItemCard.rowPadding)
                        .newItemCard()
                        .accessibilityIdentifier(CalendarSheetIdentifiers.newItemFailure)
                }
                if isEvent {
                    eventFields
                } else {
                    taskFields
                }
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.vertical, Theme.Spacing.small)
            .frame(maxWidth: Theme.Layout.formWidth + 120)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.Colors.groupedBackground)
        .onChange(of: form.kind) { form.fitRepeatToKind() }
    }
}

// MARK: - Event
private extension NewItemFormView {

    var isEvent: Bool {
        form.kind == .event
    }

    @ViewBuilder var eventFields: some View {
        HStack(alignment: .top, spacing: 10) {
            Capsule()
                .fill(chosenColor)
                .frame(width: 5)
                .accessibilityHidden(true)
            VStack(spacing: Theme.Spacing.medium) {
                titleField
                    .padding(.horizontal, NewItemCard.rowPadding + 4)
                    .frame(minHeight: Theme.Layout.rowHeight + 10)
                    .newItemCard()
                NewItemEventSchedule(form: $form)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        VStack(spacing: Theme.Spacing.small) {
            NewItemHeading(key: "newItem.place")
            iconField("location", key: "newItem.place.prompt", text: $form.place)
                .newItemCard()
                .accessibilityIdentifier(CalendarSheetIdentifiers.newItemPlace)
        }
        VStack(spacing: Theme.Spacing.small) {
            NewItemHeading(key: "newItem.options")
            if !calendars.isEmpty {
                calendarRow.newItemCard()
            }
            VStack(spacing: 0) {
                NewItemRow(systemImage: "bell", key: "newItem.alert") {
                    NewItemDurationMenu(
                        minutes: $form.alertMinutes,
                        presets: form.timed ? NewItemOptions.timedAlerts : NewItemOptions.allDayAlerts,
                        range: NewItemOptions.alertRange,
                        name: { NewItemOptions.alertName($0, allDay: !form.timed) },
                        customTitle: "newItem.alert",
                        identifier: CalendarSheetIdentifiers.newItemAlert
                    )
                }
                if form.timed {
                    NewItemDivider(inset: NewItemCard.rowPadding + NewItemCard.iconWidth + 12)
                    NewItemRow(systemImage: "car.fill", key: "newItem.travel") {
                        NewItemDurationMenu(
                            minutes: $form.travelMinutes,
                            presets: NewItemOptions.travels,
                            range: NewItemOptions.travelRange,
                            name: NewItemOptions.travelName,
                            customTitle: "newItem.travel",
                            identifier: CalendarSheetIdentifiers.newItemTravel
                        )
                    }
                }
            }
            .newItemCard()
        }
        VStack(spacing: Theme.Spacing.small) {
            NewItemHeading(key: "newItem.details")
            VStack(spacing: 0) {
                iconField("text.alignleft", key: "newItem.notes", text: $form.notes, multiline: true)
                    .accessibilityIdentifier(CalendarSheetIdentifiers.newItemNotes)
                NewItemDivider(inset: NewItemCard.rowPadding + NewItemCard.iconWidth + 12)
                iconField("link", key: "newItem.url", text: $form.url)
                    .accessibilityIdentifier(CalendarSheetIdentifiers.newItemUrl)
            }
            .newItemCard()
        }
    }

    var calendars: [NewItemCalendar] {
        groups.flatMap(\.calendars)
    }

    /// The chosen calendar's colour and name, and its source when another calendar has the same name; a tap opens
    /// the chooser, which lists the calendars by source.
    var calendarRow: some View {
        Button { isChoosingCalendar = true } label: {
            NewItemRow(systemImage: "calendar", key: "newItem.calendar") {
                HStack(spacing: 6) {
                    Circle().fill(chosenColor).frame(width: 12, height: 12)
                    Text(chosen.map(NewItemOptions.label(of:)) ?? "")
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
                }
                .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(CalendarSheetIdentifiers.newItemCalendar)
        .sheet(isPresented: $isChoosingCalendar) {
            NewItemCalendarChooser(
                choices: NewItemCalendarChoices(groups: groups, chosenId: calendar.wrappedValue),
                onChoose: { calendar.wrappedValue = $0 }
            )
            .presentationDetents([.medium, .large])
        }
    }

    var chosen: NewItemCalendar? {
        calendars.first { $0.id == calendar.wrappedValue }
    }

    var chosenColor: Color {
        chosen.flatMap { Color(hex: $0.color) } ?? Theme.Colors.accent
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

// MARK: - Task
private extension NewItemFormView {

    @ViewBuilder var taskFields: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            titleField
            TextField(
                text: $form.notes,
                prompt: Text("newItem.notes", tableName: "Sheets", bundle: .module),
                axis: .vertical
            ) {
                Text("newItem.notes", tableName: "Sheets", bundle: .module)
            }
            .foregroundStyle(.secondary)
            .accessibilityIdentifier(CalendarSheetIdentifiers.newItemNotes)
        }
        .padding(.horizontal, NewItemCard.rowPadding + 4)
        .padding(.vertical, NewItemCard.rowPadding)
        .newItemCard()
        VStack(spacing: Theme.Spacing.small) {
            NewItemHeading(key: "newItem.schedule")
            NewItemTaskSchedule(form: $form)
        }
        NewItemRow(systemImage: "repeat", key: "newItem.repeat") {
            NewItemRepeatMenu(repeatRule: $form.repeatRule, choices: NewItemOptions.taskRepeats)
        }
        .newItemCard()
        NewItemRow(systemImage: "flag.fill", key: "newItem.flag", tint: .orange) {
            Toggle(isOn: $form.flagged) { Text("newItem.flag", tableName: "Sheets", bundle: .module) }
                .labelsHidden()
                .accessibilityIdentifier(CalendarSheetIdentifiers.newItemFlag)
        }
        .newItemCard()
    }
}

// MARK: - Fields
private extension NewItemFormView {

    var titleField: some View {
        TextField(text: $form.title, prompt: Text("newItem.name.prompt", tableName: "Sheets", bundle: .module)) {
            if isEvent {
                Text("newItem.name.event", tableName: "Sheets", bundle: .module)
            } else {
                Text("newItem.name.task", tableName: "Sheets", bundle: .module)
            }
        }
        .font(.title2.weight(.semibold))
        .focused($isTitleFocused)
        .defaultFocus($isTitleFocused, true)
        .onAppear { isTitleFocused = true }
        .accessibilityIdentifier(CalendarSheetIdentifiers.newItemTitle)
    }

    /// A text field in its own card row, a grey symbol before it.
    func iconField(
        _ systemImage: String, key: LocalizedStringKey, text: Binding<String>, multiline: Bool = false
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(.secondary)
                .frame(width: NewItemCard.iconWidth)
            TextField(
                text: text,
                prompt: Text(key, tableName: "Sheets", bundle: .module),
                axis: multiline ? .vertical : .horizontal
            ) {
                Text(key, tableName: "Sheets", bundle: .module)
            }
            .lineLimit(multiline ? 1...8 : 1...1)
        }
        .padding(.horizontal, NewItemCard.rowPadding)
        .padding(.vertical, multiline ? 12 : 0)
        .frame(minHeight: Theme.Layout.rowHeight + 8)
    }
}

// MARK: - Preview
#Preview("Event") {
    @Previewable @State var form = NewItemForm(day: "2026-10-16")
    NavigationStack {
        NewItemFormView(form: $form, groups: NewItemState.preview.groups, failure: nil)
    }
}

#Preview("Task") {
    @Previewable @State var form = {
        var form = NewItemForm(day: "2026-10-16")
        form.kind = .task
        return form
    }()
    NavigationStack {
        NewItemFormView(form: $form, groups: [], failure: nil)
    }
}
