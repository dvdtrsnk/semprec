import CoreKit
import DesignSystem
import SwiftUI

/// The filter sheet: the choices of every filterable property under the current filter, each with how many items
/// hold it, and a relative date as one choice.
struct FilterSheetView: View {

    // MARK: - Dependencies
    let sheet: FilterSheet
    let hasActiveFilters: Bool
    let send: (CollectionAction) -> Void

    // MARK: - Body
    var body: some View {
        NavigationStack {
            content
                .navigationTitle(Text("filter.title", bundle: .module))
                .inlineNavigationTitle()
                .toolbar {
                    PlainToolbarItem(placement: .cancellationAction) {
                        Button(role: .destructive) { send(.filter(.clearAll)) } label: {
                            Text("filter.clear", bundle: .module)
                        }
                        .disabled(!hasActiveFilters)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button { send(.filter(.close)) } label: { Text("filter.done", bundle: .module) }
                    }
                }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CollectionsIdentifiers.filterSheet)
    }
}

// MARK: - Subviews
private extension FilterSheetView {

    @ViewBuilder var content: some View {
        if sheet.loading && sheet.groups.isEmpty {
            StatusView(.loading)
        } else if let failure = sheet.failure {
            StatusView(.failure(message: Text(FailureKind.message(for: failure.kind)), retry: { send(.filter(.open)) }))
        } else if sheet.groups.isEmpty {
            StatusView(.empty(
                message: Text("filter.empty", bundle: .module),
                systemImage: "line.3.horizontal.decrease"
            ))
        } else {
            List {
                ForEach(sheet.groups) { group in
                    Section(group.name) {
                        ForEach(group.options) { option in
                            optionRow(option, in: group)
                        }
                    }
                }
            }
        }
    }

    func optionRow(_ option: FilterOption, in group: FilterGroup) -> some View {
        Button {
            if group.kind == .date {
                send(.filter(.toggleDate(propertyKey: group.propertyKey, preset: option.value)))
            } else {
                send(.filter(.toggle(propertyKey: group.propertyKey, value: option.value)))
            }
        } label: {
            HStack {
                if let tint = Color(hex: option.color) {
                    Circle().fill(tint).frame(width: 9, height: 9)
                }
                Text(label(of: option, in: group))
                Spacer()
                if let count = option.count {
                    Text("\(count)").foregroundStyle(Theme.Colors.secondaryText).monospacedDigit()
                }
                if option.selected {
                    Image(systemName: "checkmark").foregroundStyle(Theme.Colors.accent).fontWeight(.semibold)
                }
            }
            .contentShape(Rectangle())
        }
        .listRowButton()
        .foregroundStyle(.primary)
    }

    /// A relative date is worded by the app, every other choice by the server in the person's language.
    func label(of option: FilterOption, in group: FilterGroup) -> String {
        group.kind == .date
            ? Bundle.module.localizedString(forKey: "datePreset.\(option.value)", value: option.label, table: nil)
            : option.label
    }
}

// MARK: - Preview
#Preview {
    FilterSheetView(
        sheet: FilterSheet(
            loading: false,
            failure: nil,
            groups: [
                FilterGroup(
                    propertyKey: "status",
                    name: "Status",
                    kind: .select,
                    options: [
                        FilterOption(
                            value: "inProgress", label: "In progress", color: "#007AFF", count: 4, selected: true
                        ),
                        FilterOption(value: "done", label: "Done", color: "#8E8E93", count: 2, selected: false)
                    ]
                ),
                FilterGroup(
                    propertyKey: "date",
                    name: "Date",
                    kind: .date,
                    options: [FilterOption(value: "today", label: "today", color: nil, count: nil, selected: false)]
                )
            ]
        ),
        hasActiveFilters: true,
        send: { _ in }
    )
}
