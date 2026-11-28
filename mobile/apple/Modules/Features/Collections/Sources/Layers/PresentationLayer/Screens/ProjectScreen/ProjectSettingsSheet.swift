import CoreKit
import DesignSystem
import SwiftUI

/// The settings of a project: its status, its deadline (which a long-term project does not have), its tags, chosen
/// on a sheet of their own, whether it is pinned to the overview, and the entry to its mail signals, which opens on
/// the project's stack once the sheet is closed.
struct ProjectSettingsSheet: View {

    // MARK: - Dependencies
    let state: ItemState
    let send: (ItemAction) -> Void
    let close: () -> Void
    let openMailSignals: () -> Void

    // MARK: - State
    @State private var isChoosingTags = false

    // MARK: - Body
    var body: some View {
        NavigationStack {
            Form {
                statusSection
                deadlineSection
                tagsSection
                pinnedSection
                mailSignalsSection
            }
            .sheet(isPresented: $isChoosingTags) {
                if let tags = field("tags") {
                    ProjectTagsSheet(
                        tags: tags,
                        swatches: state.swatches,
                        saving: state.saving,
                        failure: state.choiceFailure,
                        send: send
                    )
                }
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

    // MARK: - Methods
    /// The project's tags as the row shows them, "#Client #Home"; nothing while it has none.
    static func summary(of tags: FieldView) -> String {
        guard case .choices(let options) = tags.content else { return "" }
        return options.map { "#" + $0.label }.joined(separator: " ")
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

    @ViewBuilder var tagsSection: some View {
        if let tags = field("tags") {
            Section {
                Button { isChoosingTags = true } label: {
                    HStack(spacing: Theme.Spacing.small) {
                        Label {
                            Text(verbatim: tags.name)
                        } icon: {
                            Image(systemName: "number").foregroundStyle(Theme.Colors.secondaryText)
                        }
                        Spacer(minLength: Theme.Spacing.small)
                        Text(verbatim: Self.summary(of: tags))
                            .foregroundStyle(Theme.Colors.secondaryText)
                            .lineLimit(1)
                        Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .listRowButton()
                .foregroundStyle(.primary)
                .disabled(!tags.editable)
                .accessibilityIdentifier(CollectionsIdentifiers.projectSettingsTags)
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

    var mailSignalsSection: some View {
        Section {
            Button(action: openMailSignals) {
                HStack {
                    Label { Text("project.settings.mailSignals", bundle: .module) } icon: {
                        Image(systemName: "envelope.badge")
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .listRowButton()
            .foregroundStyle(.primary)
            .accessibilityIdentifier(CollectionsIdentifiers.projectMailSignals)
        } footer: {
            Text("project.settings.mailSignals.footer", bundle: .module)
        }
    }

    var selectedStatus: String? {
        if case .choices(let options) = field("status")?.content { options.first?.key } else { nil }
    }

    func field(_ key: String) -> FieldView? {
        state.fields.first { $0.propertyKey == key }
    }
}
