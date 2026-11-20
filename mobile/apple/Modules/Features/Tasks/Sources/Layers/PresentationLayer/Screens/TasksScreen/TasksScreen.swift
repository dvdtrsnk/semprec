import CoreKit
import DesignSystem
import SwiftUI

/// The Tasks screen: three lists (today, planned, all), a filter by area, project and flag, grouped rows that tick
/// off, rename in place and open Podrobnosti, and a row to add a task. It is the one screen for every start: the
/// model it is made over carries the tab and the filter.
struct TasksScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: TasksViewModel

    // MARK: - State
    @State private var adding = false
    @State private var draft = ""
    @State private var editingId: String?
    @State private var editDraft = ""
    @State private var filterOpen = false
    @FocusState private var focus: Focus?

    enum Focus: Hashable {
        case newTask
        case row(String)
    }

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> TasksViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("tasks.title", bundle: .module))
            .inlineNavigationTitle()
            .toolbar {
                PlainToolbarItem(placement: .primaryAction) { hideDoneButton }
            }
            .sheet(isPresented: $filterOpen) {
                TasksFilterSheet(state: viewModel.state, send: viewModel.send)
            }
            .alert(
                Text("tasks.notice.title", bundle: .module),
                isPresented: noticeShown,
                actions: { Button(role: .cancel) { viewModel.send(.dismissNotice) } label: { okLabel } },
                message: { Text(FailureKind.message(for: viewModel.state.notice)) }
            )
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(TasksIdentifiers.screen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension TasksScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure)), retry: { viewModel.send(.retry) }))
        case .content:
            list
        }
    }

    var list: some View {
        List {
            Section {
                tabPicker
                filterBar
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
            if adding { newTaskSection }
            ForEach(viewModel.state.groups) { group in
                Section {
                    rows(of: group)
                } header: {
                    groupHeader(group.kind)
                }
            }
            if viewModel.state.matchesNothing { nothingMatches }
        }
        .groupedListStyle()
        .refreshable { viewModel.send(.refresh) }
        .safeAreaInset(edge: .bottom) { addButton }
    }

    var tabPicker: some View {
        Picker(selection: tab) {
            ForEach(TasksTab.allCases, id: \.self) { tab in
                Text(tab.title).tag(tab).accessibilityIdentifier(TasksIdentifiers.tabPrefix + tab.identifier)
            }
        } label: {
            Text("tasks.tabs", bundle: .module)
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, Theme.Spacing.medium)
        .padding(.vertical, Theme.Spacing.small)
    }

    var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.small) {
                ForEach(chips) { chip in
                    FilterChip(title: chip.title, color: chip.color, clearLabel: chip.title, clear: chip.clear)
                }
                Button { filterOpen = true } label: {
                    Label {
                        Text(viewModel.state.filterActive ? "tasks.filter.edit" : "tasks.filter.add", bundle: .module)
                    } icon: {
                        Image(systemName: "line.3.horizontal.decrease")
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityIdentifier(TasksIdentifiers.filter)
                if viewModel.state.filterActive {
                    Text(openCountText).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.bottom, Theme.Spacing.small)
        }
    }

    @ViewBuilder
    func rows(of group: TaskGroup) -> some View {
        ForEach(group.rows) { row in
            TaskRowView(
                row: row,
                meta: WorkFormatting.meta(for: row, in: group.kind, today: IsoDay.today()),
                editing: editingId == row.id,
                draft: $editDraft,
                focus: $focus,
                toggle: { viewModel.send(.toggleDone(taskId: row.id)) },
                beginEdit: { beginEditing(row) },
                commit: { commitEditing(row) },
                openDetails: { viewModel.send(.openDetails(taskId: row.id)) }
            )
        }
        if group.rows.isEmpty { allDone }
    }

    var allDone: some View {
        Label {
            Text("tasks.allDone", bundle: .module)
        } icon: {
            Image(systemName: "checkmark.seal").foregroundStyle(Theme.Colors.accent)
        }
        .foregroundStyle(Theme.Colors.secondaryText)
    }

    func groupHeader(_ kind: TaskSectionKind) -> some View {
        Text(kind.title)
            .font(.headline)
            .textCase(nil)
            .foregroundStyle(kind == .late ? Theme.Colors.destructive : Color.primary)
    }

    var newTaskSection: some View {
        Section {
            TextField(text: $draft) {
                Text("tasks.new.placeholder", bundle: .module)
            }
            .focused($focus, equals: .newTask)
            .submitLabel(.done)
            .onSubmit { commitNewTask() }
            .accessibilityIdentifier(TasksIdentifiers.newTitle)
        }
    }

    var nothingMatches: some View {
        Section {
            Text("tasks.nothingMatches", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
            Button { viewModel.send(.clearFilters) } label: { Text("tasks.clearFilters", bundle: .module) }
                .accessibilityIdentifier(TasksIdentifiers.clearFilters)
        }
    }

    var addButton: some View {
        Button {
            adding = true
            focus = .newTask
        } label: {
            Label {
                Text("tasks.add", bundle: .module)
            } icon: {
                Image(systemName: "plus")
            }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .padding(.bottom, Theme.Spacing.small)
        .accessibilityIdentifier(TasksIdentifiers.add)
    }

    var hideDoneButton: some View {
        Button { viewModel.send(.toggleHideDone) } label: {
            Text(viewModel.state.hideDone ? "tasks.showDone" : "tasks.hideDone", bundle: .module)
        }
        .accessibilityIdentifier(TasksIdentifiers.hideDone)
    }

    var okLabel: some View {
        Text("tasks.notice.ok", bundle: .module)
    }
}

// MARK: - State
private extension TasksScreen {

    var tab: Binding<TasksTab> {
        Binding(get: { viewModel.state.tab }, set: { viewModel.send(.selectTab($0)) })
    }

    var noticeShown: Binding<Bool> {
        Binding(get: { viewModel.state.notice != nil }, set: { if !$0 { viewModel.send(.dismissNotice) } })
    }

    var openCountText: String {
        String(
            format: String(localized: "tasks.openCount", bundle: .module),
            locale: .current,
            viewModel.state.openCount
        )
    }

    var chips: [Chip] {
        let state = viewModel.state
        var chips: [Chip] = []
        if let areaId = state.areaId {
            let option = state.areaOptions.first { $0.id == areaId }
            chips.append(
                Chip(id: "area", title: chipTitle("tasks.chip.area", option?.title ?? areaId), color: option?.color) {
                    viewModel.send(.setArea(nil))
                }
            )
        }
        if let projectId = state.projectId {
            let option = state.projectOptions.first { $0.id == projectId }
            chips.append(
                Chip(
                    id: "project",
                    title: chipTitle("tasks.chip.project", option?.title ?? projectId),
                    color: option?.color
                ) {
                    viewModel.send(.setProject(nil))
                }
            )
        }
        if state.flaggedOnly {
            chips.append(
                Chip(id: "flag", title: String(localized: "tasks.chip.flagged", bundle: .module), color: "#FF9500") {
                    viewModel.send(.setFlaggedOnly(false))
                }
            )
        }
        return chips
    }

    func chipTitle(_ key: String.LocalizationValue, _ name: String) -> String {
        String(format: String(localized: key, bundle: .module), locale: .current, name)
    }

    func beginEditing(_ row: TaskRow) {
        editingId = row.id
        editDraft = row.title
        focus = .row(row.id)
    }

    func commitEditing(_ row: TaskRow) {
        guard editingId == row.id else { return }
        editingId = nil
        let title = editDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !title.isEmpty, title != row.title { viewModel.send(.rename(taskId: row.id, title: title)) }
    }

    func commitNewTask() {
        let title = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        adding = false
        draft = ""
        if !title.isEmpty { viewModel.send(.add(title: title)) }
    }
}

// MARK: - Chips
private struct Chip: Identifiable {

    let id: String
    let title: String
    let color: String?
    let clear: () -> Void

    init(id: String, title: String, color: String?, clear: @escaping () -> Void) {
        self.id = id
        self.title = title
        self.color = color
        self.clear = clear
    }
}

// MARK: - Tab titles
extension TasksTab {

    var title: String {
        switch self {
        case .today: String(localized: "tasks.tab.today", bundle: .module)
        case .planned: String(localized: "tasks.tab.planned", bundle: .module)
        case .all: String(localized: "tasks.tab.all", bundle: .module)
        }
    }

    var identifier: String {
        switch self {
        case .today: "today"
        case .planned: "planned"
        case .all: "all"
        }
    }
}

// MARK: - Section titles
extension TaskSectionKind {

    var title: String {
        switch self {
        case .late: String(localized: "tasks.section.late", bundle: .module)
        case .today: String(localized: "tasks.section.today", bundle: .module)
        case .tomorrow: String(localized: "tasks.section.tomorrow", bundle: .module)
        case .week: String(localized: "tasks.section.week", bundle: .module)
        case .later: String(localized: "tasks.section.later", bundle: .module)
        case .noDate: String(localized: "tasks.section.noDate", bundle: .module)
        }
    }
}

// MARK: - Preview
#Preview("Content") {
    NavigationStack {
        TasksScreen(
            viewModel: TasksViewModel(
                model: ScriptedTasksScreenModel(state: .preview),
                router: PreviewTasksRouter()
            )
        )
    }
}

#Preview("Failure") {
    NavigationStack {
        TasksScreen(
            viewModel: TasksViewModel(
                model: ScriptedTasksScreenModel(state: TasksState(phase: .failure(.unavailable))),
                router: PreviewTasksRouter()
            )
        )
    }
}

// MARK: - Preview content
extension TasksState {

    /// A list for previews: one late task, two for today, one without a day.
    static var preview: TasksState {
        TasksState(
            phase: .content,
            groups: [
                TaskGroup(kind: .late, rows: [
                    TaskRow(
                        id: "1",
                        title: "Daňové přiznání – podklady",
                        date: "2026-10-13",
                        projectTitle: "Účetnictví",
                        overdue: true
                    )
                ]),
                TaskGroup(kind: .today, rows: [
                    TaskRow(id: "2", title: "Odeslat fakturu", flagged: true, timeFrom: "14:00", timeTo: "15:30"),
                    TaskRow(id: "3", title: "Zaplatit nájem", done: true, projectTitle: "Domácnost")
                ])
            ],
            openCount: 2
        )
    }
}
