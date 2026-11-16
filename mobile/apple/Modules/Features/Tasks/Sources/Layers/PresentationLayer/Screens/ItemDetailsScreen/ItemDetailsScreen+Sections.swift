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
        }
    }

    @ViewBuilder private var taskRows: some View {
        ScheduleRow(
            symbol: "calendar",
            tint: .red,
            title: "details.date",
            subtitle: state.date.map { WorkFormatting.longDayLabel($0, today: today) },
            isOn: Binding(
                get: { state.date != nil },
                set: { viewModel.send(.setDate($0 ? today : nil)) }
            ),
            identifier: TasksIdentifiers.detailsDate,
            action: { if state.date != nil { picker = .date } }
        )
        .glassPopover(isPresented: shown(.date)) { datePanel }
        if state.date != nil {
            ScheduleRow(
                symbol: "clock",
                tint: .blue,
                title: "details.time",
                subtitle: state.timeFrom.map(WorkFormatting.clock),
                isOn: Binding(get: { state.timeFrom != nil }, set: { viewModel.send(.setTimed($0)) }),
                action: { if state.timeFrom != nil { picker = .start } }
            )
            .glassPopover(isPresented: shown(.start)) { timePanel(.start) }
        }
        if state.timeFrom != nil {
            ScheduleRow(
                symbol: "clock.badge.checkmark",
                tint: .indigo,
                title: "details.timeEnd",
                subtitle: endText,
                subtitleStyle: state.timeTo == nil ? Theme.Colors.secondaryText : Theme.Colors.accent,
                isOn: Binding(get: { state.timeTo != nil }, set: { viewModel.send(.setEnded($0)) }),
                action: { if state.timeTo != nil { picker = .end } }
            )
            .glassPopover(isPresented: shown(.end)) { timePanel(.end) }
        }
        if state.date != nil {
            ScheduleRow(
                symbol: "repeat",
                tint: .gray,
                title: "details.repeat",
                subtitle: WorkFormatting.repeatTitle(state.repeats),
                subtitleStyle: state.repeats == .never ? Theme.Colors.secondaryText : Theme.Colors.accent,
                showsChevron: true,
                action: { path.append(.repeats) }
            )
        }
    }

    @ViewBuilder private var eventRows: some View {
        ScheduleRow(
            symbol: "calendar",
            tint: .red,
            title: "details.date",
            subtitle: state.date.map { WorkFormatting.longDayLabel($0, today: today) },
            identifier: TasksIdentifiers.detailsDate,
            action: { picker = .date }
        )
        .glassPopover(isPresented: shown(.date)) { datePanel }
        ScheduleRow(
            symbol: "sun.max",
            tint: .orange,
            title: "details.allDay",
            isOn: Binding(get: { state.allDay }, set: { viewModel.send(.setAllDay($0)) }),
            action: { viewModel.send(.setAllDay(!state.allDay)) }
        )
        if !state.allDay {
            ScheduleRow(
                symbol: "clock",
                tint: .blue,
                title: "details.start",
                subtitle: state.timeFrom.map(WorkFormatting.clock),
                action: { picker = .start }
            )
            .glassPopover(isPresented: shown(.start)) { timePanel(.start) }
            ScheduleRow(
                symbol: "clock.badge.checkmark",
                tint: .indigo,
                title: "details.end",
                subtitle: endText,
                action: { picker = .end }
            )
            .glassPopover(isPresented: shown(.end)) { timePanel(.end) }
        }
    }
}

// MARK: - Relations
extension ItemDetailsScreen {

    var relationsSection: some View {
        Section {
            linked(
                ScheduleRow(
                    symbol: "folder",
                    tint: .purple,
                    title: "details.project",
                    subtitle: state.project?.title ?? String(localized: "details.none", bundle: .module),
                    subtitleStyle: state.project == nil ? Theme.Colors.secondaryText : Theme.Colors.accent,
                    showsChevron: true,
                    identifier: TasksIdentifiers.detailsProject,
                    action: { path.append(.project) }
                ),
                subject: .project,
                link: state.projectLink
            )
            linked(
                ScheduleRow(
                    symbol: "person.2",
                    tint: .teal,
                    title: isEvent ? "details.attendees" : "details.people",
                    subtitle: peopleText,
                    subtitleStyle: state.people.isEmpty ? Theme.Colors.secondaryText : Theme.Colors.accent,
                    showsChevron: true,
                    identifier: TasksIdentifiers.detailsPeople,
                    action: { path.append(.people) }
                ),
                subject: .people,
                link: state.peopleLink
            )
            if isEvent { companyRow }
            if !isEvent { flagRow }
        }
    }

    private func linked(_ row: ScheduleRow, subject: LinkSubject, link: ValueLink?) -> some View {
        HStack(spacing: Theme.Spacing.small) {
            row
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
            ScheduleRow(
                symbol: "building.2",
                tint: .indigo,
                title: "details.company",
                subtitle: state.company?.title ?? String(localized: "details.noCompany", bundle: .module),
                subtitleStyle: Theme.Colors.secondaryText,
                action: {}
            )
            LinkPill(subject: .company, link: ValueLink(state: .derived), unlink: {}, relink: {})
        }
    }

    private var flagRow: some View {
        ScheduleRow(
            symbol: "flag.fill",
            tint: .orange,
            title: "details.flag",
            isOn: Binding(get: { state.flagged }, set: { viewModel.send(.setFlagged($0)) }),
            action: { viewModel.send(.setFlagged(!state.flagged)) }
        )
    }
}

// MARK: - Pickers
extension ItemDetailsScreen {

    var today: String { IsoDay.today() }

    func shown(_ target: TimePicker) -> Binding<Bool> {
        Binding(get: { picker == target }, set: { if !$0, picker == target { picker = nil } })
    }

    var datePanel: some View {
        DatePickerPanel(
            value: state.date,
            today: today,
            onPick: { day in
                viewModel.send(.setDate(day))
                picker = nil
            }
        )
    }

    func timePanel(_ target: TimePicker) -> some View {
        let value = (target == .start ? state.timeFrom : state.timeTo) ?? state.timeFrom ?? "09:00"
        return TimePickerPanel(
            value: value,
            onPick: { time in viewModel.send(target == .start ? .setTimeFrom(time) : .setTimeTo(time)) },
            onDone: { picker = nil }
        )
    }

    /// `14:30 · trvá 1 h 30 min`, or the explanation of a task without an end.
    var endText: String {
        guard let end = state.timeTo else {
            return String(localized: "details.noEnd", bundle: .module)
        }
        guard let length = state.lengthMinutes else { return WorkFormatting.clock(end) }
        let lasts = String(
            format: String(localized: "details.lasts", bundle: .module),
            locale: .current,
            WorkFormatting.length(minutes: length)
        )
        return "\(WorkFormatting.clock(end)) · \(lasts)"
    }

    var peopleText: String {
        state.people.isEmpty
            ? String(localized: "details.nobody", bundle: .module)
            : state.people.map(\.title).joined(separator: ", ")
    }
}
