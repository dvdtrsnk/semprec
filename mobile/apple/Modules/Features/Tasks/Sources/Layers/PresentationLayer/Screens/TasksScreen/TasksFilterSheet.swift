import CoreKit
import DesignSystem
import SwiftUI

/// The filters of the Tasks list: an area, a project and flagged tasks only, each option with the number of tasks it
/// leaves. Filters combine; a task belongs to an area through its project.
struct TasksFilterSheet: View {

    // MARK: - Dependencies
    let state: TasksState
    let send: (TasksAction) -> Void

    // MARK: - State
    @Environment(\.dismiss) private var dismiss
    @State private var expanded: Field?

    fileprivate enum Field { case area, project }

    /// One of the two choices of the sheet: its title, what is chosen, the options and what picking one does.
    fileprivate struct Choice {
        let title: LocalizedStringKey
        let selected: String?
        let options: [TaskFilterOption]
        let allCount: Int
        let pick: (String?) -> Void
    }

    // MARK: - Body
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    choice(
                        .area,
                        Choice(
                            title: "tasks.filter.area",
                            selected: state.areaId,
                            options: state.areaOptions,
                            allCount: state.areaAllCount,
                            pick: { send(.setArea($0)) }
                        )
                    )
                    choice(
                        .project,
                        Choice(
                            title: "tasks.filter.project",
                            selected: state.projectId,
                            options: state.projectOptions,
                            allCount: state.projectAllCount,
                            pick: { send(.setProject($0)) }
                        )
                    )
                    Toggle(isOn: flagged) { Text("tasks.filter.flagged", bundle: .module) }
                } footer: {
                    Text("tasks.filter.hint", bundle: .module)
                }
            }
            .navigationTitle(Text("tasks.filter.title", bundle: .module))
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { send(.clearFilters) } label: { Text("tasks.filter.clear", bundle: .module) }
                        .disabled(!state.filterActive)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { dismiss() } label: { Text("tasks.filter.done", bundle: .module) }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(TasksIdentifiers.filterSheet)
    }
}

// MARK: - Subviews
private extension TasksFilterSheet {

    var flagged: Binding<Bool> {
        Binding(get: { state.flaggedOnly }, set: { send(.setFlaggedOnly($0)) })
    }

    func choice(_ field: Field, _ choice: Choice) -> some View {
        DisclosureGroup(
            isExpanded: Binding(get: { expanded == field }, set: { expanded = $0 ? field : nil }),
            content: {
                optionRow(title: allTitle, color: nil, count: choice.allCount, isOn: choice.selected == nil) {
                    choice.pick(nil)
                    expanded = nil
                }
                ForEach(choice.options) { option in
                    let isOn = choice.selected == option.id
                    optionRow(title: option.title, color: option.color, count: option.count, isOn: isOn) {
                        choice.pick(option.id)
                        expanded = nil
                    }
                }
            },
            label: {
                HStack {
                    Text(choice.title, bundle: .module)
                    Spacer()
                    Text(choice.options.first { $0.id == choice.selected }?.title ?? allTitle)
                        .foregroundStyle(choice.selected == nil ? Theme.Colors.secondaryText : Theme.Colors.accent)
                }
            }
        )
    }

    var allTitle: String { String(localized: "tasks.filter.all", bundle: .module) }

    func optionRow(title: String, color: String?, count: Int, isOn: Bool, pick: @escaping () -> Void) -> some View {
        Button(action: pick) {
            HStack {
                Circle().fill(Color(hex: color) ?? Color.clear).frame(width: 10, height: 10)
                Text(title).foregroundStyle(Color.primary)
                Spacer()
                Text("\(count)").foregroundStyle(Theme.Colors.secondaryText)
                if isOn { Image(systemName: "checkmark").foregroundStyle(Theme.Colors.accent) }
            }
        }
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

// MARK: - Preview
#Preview {
    TasksFilterSheet(
        state: TasksState(
            phase: .content,
            areaId: "work",
            areaOptions: [
                TaskFilterOption(id: "work", title: "Práce", color: "#5856D6", count: 5),
                TaskFilterOption(id: "home", title: "Domácnost", color: "#FF9500", count: 3)
            ],
            projectOptions: [TaskFilterOption(id: "ios", title: "Semprec iOS", color: "#007AFF", count: 2, areaId: "work")],
            areaAllCount: 8,
            projectAllCount: 5
        ),
        send: { _ in }
    )
}
