import CoreKit
import DesignSystem
import SwiftUI

/// The calendar as a list: the stored events and tasks from a day on, a section a day, with a search over what is
/// loaded. Scrolling to the end reads the next page; an entry opens in Podrobnosti.
struct CalendarAgendaScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: CalendarAgendaViewModel

    // MARK: - State
    @State private var query = ""

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> CalendarAgendaViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("calendar.agenda", bundle: .module))
            .inlineNavigationTitle()
            .searchable(text: $query, prompt: Text("calendar.agenda.search", bundle: .module))
            .accessibilityIdentifier(CalendarIdentifiers.agendaList)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension CalendarAgendaScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure)), retry: viewModel.retry))
        case .content:
            if shownDays.isEmpty && !viewModel.state.hasMore {
                ContentUnavailableView {
                    Label {
                        Text(query.isEmpty ? "calendar.agenda.empty" : "calendar.agenda.noMatch", bundle: .module)
                    } icon: {
                        Image(systemName: "calendar")
                    }
                }
            } else {
                list
            }
        }
    }

    var list: some View {
        List {
            ForEach(shownDays) { day in
                Section {
                    ForEach(day.entries) { entry in
                        Button { viewModel.open(entry) } label: { CalendarAgendaRow(entry: entry) }
                            .listRowButton()
                            .tint(.primary)
                            .accessibilityIdentifier(CalendarIdentifiers.agendaEntryPrefix + entry.id)
                    }
                } header: {
                    Text(CalendarDates.dayTitle(day.day))
                }
            }
            if viewModel.state.hasMore {
                more
            }
        }
        .groupedListStyle()
    }

    @ViewBuilder var more: some View {
        Section {
            if let failure = viewModel.state.moreFailure {
                Button(action: viewModel.loadMore) {
                    Label { Text(FailureKind.message(for: failure.kind)) } icon: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .accessibilityIdentifier(CalendarIdentifiers.agendaMore)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .onAppear(perform: viewModel.loadMore)
                    .accessibilityIdentifier(CalendarIdentifiers.agendaMore)
            }
        }
    }

    /// The days with the entries whose title or place holds the search text; all of them without one.
    var shownDays: [CalendarAgendaDay] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return viewModel.state.days }
        return viewModel.state.days.compactMap { day in
            let entries = day.entries.filter { entry in
                entry.title.localizedStandardContains(text) || (entry.place?.localizedStandardContains(text) ?? false)
            }
            return entries.isEmpty ? nil : CalendarAgendaDay(day: day.day, entries: entries)
        }
    }
}

/// One event or task of the agenda: when, what and where.
private struct CalendarAgendaRow: View {

    // MARK: - Dependencies
    let entry: CalendarAgendaEntry

    // MARK: - Body
    var body: some View {
        LabeledContent {
            Text(when)
        } label: {
            Label {
                Text(entry.title).strikethrough(entry.done)
                if let place = entry.place { Text(place) }
            } icon: {
                Image(systemName: icon).foregroundStyle(entry.kind == .event ? Color.accentColor : Color.secondary)
            }
        }
    }

    private var icon: String {
        switch entry.kind {
        case .event: "calendar"
        case .task: entry.done ? "checkmark.circle.fill" : "circle"
        }
    }

    private var when: String {
        guard let start = entry.timeFrom else { return String(localized: "calendar.agenda.allDay", bundle: .module) }
        guard let end = entry.timeTo else { return start }
        return "\(start) – \(end)"
    }
}

// MARK: - Preview
#Preview("Agenda") {
    NavigationStack {
        CalendarAgendaScreen(viewModel: CalendarAgendaViewModel(
            model: ScriptedCalendarAgendaScreenModel(state: CalendarAgendaState(
                phase: .content,
                days: [
                    CalendarAgendaDay(day: "2026-11-16", entries: [
                        CalendarAgendaEntry(id: "t1", kind: .task, title: "Poslat nabídku", allDay: true, done: true),
                        CalendarAgendaEntry(
                            id: "e1", kind: .event, title: "Schůzka", timeFrom: "14:00", timeTo: "15:00", place: "Praha"
                        )
                    ])
                ]
            )),
            router: PreviewCalendarRouter()
        ))
    }
}
