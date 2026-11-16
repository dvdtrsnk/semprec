import CoreKit
import DesignSystem
import SwiftUI

// MARK: - Schedule
extension ItemDetailsScreen {

    var scheduleSection: some View {
        Section {
            if isEvent {
                eventRows
            } else {
                taskRows
            }
        } footer: {
            if !isEvent, state.timeFrom != nil, state.timeTo == nil {
                Text("details.noEnd", bundle: .module)
            }
        }
    }

    @ViewBuilder private var taskRows: some View {
        LabeledContent {
            HStack(spacing: Theme.Spacing.small) {
                if state.date != nil { datePicker }
                Toggle(isOn: Binding(get: { state.date != nil }, set: { viewModel.send(.setDate($0 ? today : nil)) })) {
                    Text("details.date", bundle: .module)
                }
                .labelsHidden()
            }
        } label: {
            rowLabel("details.date", symbol: "calendar", tint: .red)
        }
        .accessibilityIdentifier(TasksIdentifiers.detailsDate)
        if state.date != nil {
            LabeledContent {
                HStack(spacing: Theme.Spacing.small) {
                    if state.timeFrom != nil { timePicker(.start) }
                    Toggle(isOn: Binding(get: { state.timeFrom != nil }, set: { viewModel.send(.setTimed($0)) })) {
                        Text("details.time", bundle: .module)
                    }
                    .labelsHidden()
                }
            } label: {
                rowLabel("details.time", symbol: "clock", tint: .blue)
            }
        }
        if state.timeFrom != nil {
            LabeledContent {
                HStack(spacing: Theme.Spacing.small) {
                    if state.timeTo != nil { timePicker(.end) }
                    Toggle(isOn: Binding(get: { state.timeTo != nil }, set: { viewModel.send(.setEnded($0)) })) {
                        Text("details.timeEnd", bundle: .module)
                    }
                    .labelsHidden()
                }
            } label: {
                rowLabel("details.timeEnd", symbol: "clock.badge.checkmark", tint: .indigo, detail: lastsText)
            }
        }
        if state.date != nil {
            NavigationLink(value: ItemDetailsPage.repeats) {
                LabeledContent {
                    Text(WorkFormatting.repeatTitle(state.repeats))
                } label: {
                    rowLabel("details.repeat", symbol: "repeat", tint: .gray)
                }
            }
        }
    }

    @ViewBuilder private var eventRows: some View {
        LabeledContent {
            datePicker
        } label: {
            rowLabel("details.date", symbol: "calendar", tint: .red)
        }
        .accessibilityIdentifier(TasksIdentifiers.detailsDate)
        Toggle(isOn: Binding(get: { state.allDay }, set: { viewModel.send(.setAllDay($0)) })) {
            rowLabel("details.allDay", symbol: "sun.max", tint: .orange)
        }
        if !state.allDay {
            LabeledContent {
                timePicker(.start)
            } label: {
                rowLabel("details.start", symbol: "clock", tint: .blue)
            }
            LabeledContent {
                timePicker(.end)
            } label: {
                rowLabel("details.end", symbol: "clock.badge.checkmark", tint: .indigo, detail: lastsText)
            }
        }
    }
}

// MARK: - Relations
extension ItemDetailsScreen {

    var relationsSection: some View {
        Section {
            linked(subject: .project, link: state.projectLink) {
                NavigationLink(value: ItemDetailsPage.project) {
                    LabeledContent {
                        Text(state.project?.title ?? String(localized: "details.none", bundle: .module))
                    } label: {
                        rowLabel("details.project", symbol: "folder", tint: .purple)
                    }
                }
                .accessibilityIdentifier(TasksIdentifiers.detailsProject)
            }
            linked(subject: .people, link: state.peopleLink) {
                NavigationLink(value: ItemDetailsPage.people) {
                    LabeledContent {
                        Text(peopleText).lineLimit(1)
                    } label: {
                        rowLabel(isEvent ? "details.attendees" : "details.people", symbol: "person.2", tint: .teal)
                    }
                }
                .accessibilityIdentifier(TasksIdentifiers.detailsPeople)
            }
            if isEvent { companyRow }
            if !isEvent { flagRow }
        }
    }

    private func linked(
        subject: LinkSubject,
        link: ValueLink?,
        @ViewBuilder row: () -> some View
    ) -> some View {
        HStack(spacing: Theme.Spacing.small) {
            row()
            if let link, let value = subject.linkedValue, link.state != .derived {
                LinkPill(
                    subject: subject,
                    link: link,
                    unlink: { viewModel.send(.unlink(value)) },
                    relink: { viewModel.send(.relink(value)) }
                )
            }
        }
    }

    private var companyRow: some View {
        HStack(spacing: Theme.Spacing.small) {
            LabeledContent {
                Text(state.company?.title ?? String(localized: "details.noCompany", bundle: .module))
            } label: {
                rowLabel("details.company", symbol: "building.2", tint: .indigo)
            }
            LinkPill(subject: .company, link: ValueLink(state: .derived), unlink: {}, relink: {})
        }
    }

    private var flagRow: some View {
        Toggle(isOn: Binding(get: { state.flagged }, set: { viewModel.send(.setFlagged($0)) })) {
            rowLabel("details.flag", symbol: "flag.fill", tint: .orange)
        }
    }

    /// The label of a row: the icon tile, the title and, under it, a line of detail.
    func rowLabel(_ title: LocalizedStringKey, symbol: String, tint: Color, detail: String? = nil) -> some View {
        Label {
            Text(title, bundle: .module)
            if let detail { Text(detail) }
        } icon: {
            IconTile(symbol: symbol, tint: tint)
        }
    }
}

// MARK: - Pickers
extension ItemDetailsScreen {

    var today: String { IsoDay.today() }

    /// Where a new start time begins when the item has none.
    static var defaultTime: String { "09:00" }

    /// The native compact date picker of the item's day.
    var datePicker: some View {
        DatePicker(
            selection: Binding(
                get: { IsoDay.date(from: state.date ?? today) ?? .now },
                set: { viewModel.send(.setDate(IsoDay.string(from: $0))) }
            ),
            displayedComponents: .date
        ) {
            Text("details.date", bundle: .module)
        }
        .labelsHidden()
    }

    /// The native compact time picker of the start or the end; an end without a value starts at the start.
    func timePicker(_ target: TimeField) -> some View {
        let value = (target == .start ? state.timeFrom : state.timeTo) ?? state.timeFrom ?? Self.defaultTime
        return DatePicker(
            selection: Binding(
                get: { ClockTime.date(from: value) ?? .now },
                set: { time in
                    let text = ClockTime.string(from: time)
                    viewModel.send(target == .start ? .setTimeFrom(text) : .setTimeTo(text))
                }
            ),
            displayedComponents: .hourAndMinute
        ) {
            Text(target == .start ? "details.start" : "details.end", bundle: .module)
        }
        .labelsHidden()
    }

    /// `trvá 1 h 30 min` once the item has an end; the picker beside it shows the end itself.
    var lastsText: String? {
        guard state.timeTo != nil, let length = state.lengthMinutes else { return nil }
        return String(
            format: String(localized: "details.lasts", bundle: .module),
            locale: .current,
            WorkFormatting.length(minutes: length)
        )
    }

    var peopleText: String {
        state.people.isEmpty
            ? String(localized: "details.nobody", bundle: .module)
            : state.people.map(\.title).joined(separator: ", ")
    }
}
