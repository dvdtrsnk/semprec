import CoreKit
import DesignSystem
import SwiftUI

/// One tag of the projects: its name, its colour from the palette and its deletion, each changing the tag in every
/// project. Deleting asks first; a refused change shows its failure.
struct ProjectTagPage: View {

    // MARK: - Dependencies
    let tags: FieldView
    let tagKey: String
    let swatches: [CalendarSwatch]
    let saving: Bool
    let failure: ItemWriteFailure?
    let send: (ItemAction) -> Void

    // MARK: - State
    @State private var name: String
    @State private var isConfirmingDeletion = false

    // MARK: - Init
    init(
        tags: FieldView,
        tagKey: String,
        swatches: [CalendarSwatch],
        saving: Bool,
        failure: ItemWriteFailure?,
        send: @escaping (ItemAction) -> Void
    ) {
        self.tags = tags
        self.tagKey = tagKey
        self.swatches = swatches
        self.saving = saving
        self.failure = failure
        self.send = send
        _name = State(initialValue: tags.options.first { $0.key == tagKey }?.label ?? "")
    }

    // MARK: - Body
    var body: some View {
        Form {
            if let option {
                failureSection
                nameSection(option)
                colorSection(option)
                deleteSection
            }
        }
        .confirmationDialog(
            Text(verbatim: deletionTitle),
            isPresented: $isConfirmingDeletion,
            titleVisibility: .visible
        ) {
            Button(role: .destructive) { send(Self.removal(of: tagKey, in: tags)) } label: {
                Text("project.tag.delete.confirm", bundle: .module)
            }
            .accessibilityIdentifier(CollectionsIdentifiers.projectTagDeleteConfirm)
        } message: {
            Text("project.tag.delete.message", bundle: .module)
        }
    }

    // MARK: - Methods
    /// Whether the tag `key` was among the choices `before` and is no longer among those `now`: it was deleted, and its
    /// screen closes. Choices that were not read yet hold no tag, so a screen still loading never closes.
    static func wasRemoved(_ key: String, before: [FieldOption], now: [FieldOption]) -> Bool {
        before.contains { $0.key == key } && !now.contains { $0.key == key }
    }

    /// The intent that renames `option` to `name`, or nil when the name is blank, unchanged or a write is running.
    static func renaming(_ name: String, of option: FieldOption, in tags: FieldView, saving: Bool) -> ItemAction? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != option.label, !saving else { return nil }
        return .edit(.renameChoice(propertyKey: tags.propertyKey, key: option.key, label: trimmed))
    }

    /// The intent that gives the tag `key` the colour of `swatch`.
    static func recoloring(_ key: String, to swatch: CalendarSwatch, in tags: FieldView) -> ItemAction {
        .edit(.recolorChoice(propertyKey: tags.propertyKey, key: key, color: swatch.hex))
    }

    /// The intent that deletes the tag `key` from the projects.
    static func removal(of key: String, in tags: FieldView) -> ItemAction {
        .edit(.removeChoice(propertyKey: tags.propertyKey, key: key))
    }
}

// MARK: - Subviews
private extension ProjectTagPage {

    var option: FieldOption? {
        tags.options.first { $0.key == tagKey }
    }

    var deletionTitle: String {
        let format = String(localized: "project.tag.delete.title", bundle: .module)
        return String(format: format, locale: .current, option?.label ?? "")
    }

    @ViewBuilder var failureSection: some View {
        if let failure, failure.propertyKey == tags.propertyKey {
            Section {
                Text(FailureKind.message(for: failure.kind)).foregroundStyle(Theme.Colors.destructive)
            }
        }
    }

    func nameSection(_ option: FieldOption) -> some View {
        Section {
            HStack {
                TextField(text: $name) { Text("project.tag.name", bundle: .module) }
                    .onSubmit { rename(option) }
                    .accessibilityIdentifier(CollectionsIdentifiers.projectTagName)
                Button { rename(option) } label: { Text("project.tag.rename", bundle: .module) }
                    .disabled(Self.renaming(name, of: option, in: tags, saving: saving) == nil)
                    .accessibilityIdentifier(CollectionsIdentifiers.projectTagRename)
            }
        } header: {
            Text("project.tag.name", bundle: .module)
        }
    }

    func colorSection(_ option: FieldOption) -> some View {
        Section {
            ForEach(swatches) { swatch in
                let selected = swatch.isTagColor(option.color)
                Button { send(Self.recoloring(option.key, to: swatch, in: tags)) } label: {
                    HStack {
                        Circle()
                            .fill(Color(hex: swatch.hex) ?? Theme.Colors.secondaryText)
                            .frame(width: 14, height: 14)
                            .accessibilityHidden(true)
                        Text(swatch.tagColorName).foregroundStyle(Color.primary)
                        Spacer(minLength: 0)
                        if selected {
                            Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Theme.Colors.accent)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .disabled(saving || selected)
                .listRowButton()
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier(CollectionsIdentifiers.projectTagColorPrefix + swatch.key)
            }
        } header: {
            Text("project.tag.color", bundle: .module)
        }
    }

    var deleteSection: some View {
        Section {
            Button(role: .destructive) { isConfirmingDeletion = true } label: {
                Text("project.tag.delete", bundle: .module)
            }
            .disabled(saving)
            .listRowButton()
            .accessibilityIdentifier(CollectionsIdentifiers.projectTagDelete)
        } footer: {
            Text("project.tag.delete.message", bundle: .module)
        }
    }

    func rename(_ option: FieldOption) {
        if let action = Self.renaming(name, of: option, in: tags, saving: saving) { send(action) }
    }
}

// MARK: - Preview
extension ProjectTagPage {

    static let previewTags = FieldView(
        propertyKey: "tags",
        name: "Tags",
        kind: .multiSelect,
        content: .choices([FieldOption(key: "client", label: "Client", color: "#FF9500")]),
        options: [
            FieldOption(key: "client", label: "Client", color: "#FF9500"),
            FieldOption(key: "home", label: "Home", color: nil)
        ],
        editable: true,
        origin: nil
    )
}

#Preview {
    NavigationStack {
        ProjectTagPage(
            tags: ProjectTagPage.previewTags,
            tagKey: "client",
            swatches: [CalendarSwatch(key: "orange", hex: "#FF9500"), CalendarSwatch(key: "green", hex: "#34C759")],
            saving: false,
            failure: nil,
            send: { _ in }
        )
    }
}
