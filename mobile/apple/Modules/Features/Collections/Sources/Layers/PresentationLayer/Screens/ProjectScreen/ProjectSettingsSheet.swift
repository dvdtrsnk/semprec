import CoreKit
import DesignSystem
import SwiftUI

/// The settings of a project: its status, its deadline (which a long-term project does not have), its tags
/// with a field that creates a new one, whether it is pinned to the overview, and the entry to its mail signals, which
/// the project opens on its stack once the sheet is closed.
struct ProjectSettingsSheet: View {

    // MARK: - Dependencies
    let state: ItemState
    let send: (ItemAction) -> Void
    let close: () -> Void
    let openMailSignals: () -> Void

    // MARK: - State
    @State private var newTag = ""
    /// The tags the project held when the typed name was sent; nil while no new tag is on its way.
    @State private var tagsBeforeAdd: Set<String>?

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
            .onChange(of: tagKeys) { _, keys in clearNewTagOnceAdded(keys) }
            .onChange(of: state.choiceFailure) { _, failure in if failure != nil { tagsBeforeAdd = nil } }
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
    /// The intent that creates a tag named `label` and sets it on the project.
    static func newChoice(_ label: String, of field: FieldView) -> ItemAction {
        .edit(.addChoice(propertyKey: field.propertyKey, label: label))
    }

    /// Whether the project's tags gained one since `before`, which is how the sheet learns that the typed name was
    /// added: a refused add changes no tag and keeps the name in the field.
    static func gainedTag(before: Set<String>?, now: Set<String>) -> Bool {
        guard let before else { return false }
        return !now.isSubset(of: before)
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
                FieldRowView(field: tags, fields: state.fields, format: FieldFormat(), send: send)
                if tags.editable {
                    HStack {
                        TextField(text: $newTag) { Text("project.tags.new", bundle: .module) }
                            .onSubmit { addTag(to: tags) }
                            .accessibilityIdentifier(CollectionsIdentifiers.projectSettingsNewTag)
                        Button { addTag(to: tags) } label: { Text("project.tags.add", bundle: .module) }
                            .disabled(newTag.isEmpty || state.saving)
                            .accessibilityIdentifier(CollectionsIdentifiers.projectSettingsAddTag)
                    }
                }
            } header: {
                Text(tags.name).accessibilityIdentifier(CollectionsIdentifiers.projectSettingsTags)
            } footer: {
                if let failure = state.choiceFailure, failure.propertyKey == tags.propertyKey {
                    Text(FailureKind.message(for: failure.kind)).foregroundStyle(Theme.Colors.destructive)
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

    /// Sends the typed name as a new tag of the project; the field keeps it until the tag is on the project.
    func addTag(to tags: FieldView) {
        tagsBeforeAdd = tagKeys
        send(Self.newChoice(newTag, of: tags))
    }

    func clearNewTagOnceAdded(_ keys: Set<String>) {
        guard Self.gainedTag(before: tagsBeforeAdd, now: keys) else { return }
        newTag = ""
        tagsBeforeAdd = nil
    }

    var tagKeys: Set<String> {
        if case .choices(let options) = field("tags")?.content { Set(options.map(\.key)) } else { [] }
    }

    var selectedStatus: String? {
        if case .choices(let options) = field("status")?.content { options.first?.key } else { nil }
    }

    func field(_ key: String) -> FieldView? {
        state.fields.first { $0.propertyKey == key }
    }
}
