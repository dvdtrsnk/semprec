import CoreKit
import DesignSystem
import SwiftUI

/// The settings of a project: its status, its area, its deadline (which a long-term project does not have) and
/// whether it is pinned to the overview.
struct ProjectSettingsSheet: View {

    // MARK: - Dependencies
    let state: ItemState
    let send: (ItemAction) -> Void
    let close: () -> Void

    // MARK: - Body
    var body: some View {
        NavigationStack {
            Form {
                statusSection
                areaSection
                deadlineSection
                pinnedSection
            }
            .navigationTitle(Text("project.settings", bundle: .module))
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: close) { Text("project.settings.done", bundle: .module) }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CollectionsIdentifiers.projectSettings + ".sheet")
    }
}

// MARK: - Sections
private extension ProjectSettingsSheet {

    @ViewBuilder var statusSection: some View {
        if let status = field("status") {
            Section(status.name) {
                ForEach(status.options, id: \.key) { option in
                    Button { send(.edit(.setChoices(propertyKey: status.propertyKey, keys: [option.key]))) } label: {
                        HStack {
                            Circle()
                                .fill(Color(hex: option.color) ?? Theme.Colors.secondaryText)
                                .frame(width: 10, height: 10)
                            Text(option.label)
                            Spacer()
                            if selectedStatus == option.key {
                                Image(systemName: "checkmark").foregroundStyle(Theme.Colors.accent)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .foregroundStyle(.primary)
                    .disabled(!status.editable)
                }
            }
        }
    }

    @ViewBuilder var areaSection: some View {
        if let area = field("area") {
            Section(area.name) {
                Button {
                    close()
                    send(.picker(.open(propertyKey: area.propertyKey)))
                } label: {
                    HStack {
                        if case .targets(let targets) = area.content, let current = targets.first {
                            Text(current.title)
                        } else {
                            Text("field.empty", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .foregroundStyle(.primary)
                .disabled(!area.editable)
            }
        }
    }

    @ViewBuilder var deadlineSection: some View {
        if let date = field("date") {
            Section(date.name) {
                if selectedStatus == "longTerm" {
                    Text("project.deadline.none", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
                } else {
                    FieldRowView(field: date, fields: state.fields, format: FieldFormat(), send: send)
                }
            }
        }
    }

    @ViewBuilder var pinnedSection: some View {
        if let pinned = field("pinned") {
            Section {
                FieldRowView(field: pinned, fields: state.fields, format: FieldFormat(), send: send)
            } footer: {
                Text("project.pinned.footer", bundle: .module)
            }
        }
    }

    var selectedStatus: String? {
        if case .choices(let options) = field("status")?.content { options.first?.key } else { nil }
    }

    func field(_ key: String) -> FieldView? {
        state.fields.first { $0.propertyKey == key }
    }
}
