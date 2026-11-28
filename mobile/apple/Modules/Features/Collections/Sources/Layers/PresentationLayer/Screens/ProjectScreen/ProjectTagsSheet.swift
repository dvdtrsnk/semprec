import CoreKit
import DesignSystem
import SwiftUI

/// The tags of a project, chosen the way a reminder's tags are: every tag of the projects as a chip that a tap selects
/// or clears, and a field below that creates a new tag, selected at once. The choice is kept on the sheet until the
/// checkmark sets it on the project; the cross leaves the project's tags as they were when the sheet opened. Holding
/// a chip renames, recolors or deletes that tag in every project.
struct ProjectTagsSheet: View {

    // MARK: - Dependencies
    let tags: FieldView
    let swatches: [CalendarSwatch]
    let saving: Bool
    let failure: ItemWriteFailure?
    let send: (ItemAction) -> Void
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - State
    /// The project's tags when the sheet opened, which the cross restores.
    @State private var original: [String]
    @State private var selection: Set<String>
    @State private var newTag = ""
    /// The tag keys there were when the typed name was sent; nil while no new tag is on its way.
    @State private var keysBeforeAdd: Set<String>?
    @State private var renamed: FieldOption?
    @State private var renameDraft = ""
    @State private var deleted: FieldOption?
    @FocusState private var isTypingNewTag: Bool

    // MARK: - Init
    init(
        tags: FieldView,
        swatches: [CalendarSwatch],
        saving: Bool,
        failure: ItemWriteFailure?,
        send: @escaping (ItemAction) -> Void
    ) {
        self.tags = tags
        self.swatches = swatches
        self.saving = saving
        self.failure = failure
        self.send = send
        let held = Self.heldKeys(of: tags)
        _original = State(initialValue: held)
        _selection = State(initialValue: Set(held))
    }

    // MARK: - Body
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                    if !tags.options.isEmpty { chipsCard }
                    newTagCard
                    failureText
                }
                .padding(.horizontal, Theme.Spacing.medium)
                .padding(.top, Theme.Spacing.small)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.Colors.groupedBackground)
            .navigationTitle(Text(verbatim: tags.name))
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { close(committing: false) }
                        .disabled(saving)
                        .accessibilityIdentifier(CollectionsIdentifiers.projectTagsCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(role: .confirm) { close(committing: true) }
                        .disabled(saving)
                        .accessibilityIdentifier(CollectionsIdentifiers.projectTagsDone)
                }
            }
            .onAppear { if tags.options.isEmpty { isTypingNewTag = true } }
            .onChange(of: tags.options) { _, options in follow(options) }
            .onChange(of: failure) { _, failure in if failure != nil { keysBeforeAdd = nil } }
            .sensoryFeedback(.selection, trigger: selection)
            .alert(
                Text("project.tag.rename.title", bundle: .module),
                isPresented: isPresenting($renamed),
                presenting: renamed
            ) { option in
                TextField(text: $renameDraft) { Text("project.tag.name", bundle: .module) }
                    .accessibilityIdentifier(CollectionsIdentifiers.projectTagName)
                Button(role: .cancel) {} label: { Text("project.tag.cancel", bundle: .module) }
                Button { rename(option) } label: { Text("project.tag.rename.save", bundle: .module) }
                    .disabled(Self.renaming(renameDraft, of: option, in: tags, saving: saving) == nil)
            }
            .alert(
                Text(verbatim: deletionTitle),
                isPresented: isPresenting($deleted),
                presenting: deleted
            ) { option in
                Button(role: .cancel) {} label: { Text("project.tag.cancel", bundle: .module) }
                Button(role: .destructive) { send(Self.removal(of: option.key, in: tags)) } label: {
                    Text("project.tag.delete.confirm", bundle: .module)
                }
                .accessibilityIdentifier(CollectionsIdentifiers.projectTagDeleteConfirm)
            } message: { _ in
                Text("project.tag.delete.message", bundle: .module)
            }
        }
        .interactiveDismissDisabled(selection != Set(original))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CollectionsIdentifiers.projectTagsSheet)
    }

    // MARK: - Methods
    /// The keys of the tags the project holds now, in the order it holds them.
    static func heldKeys(of tags: FieldView) -> [String] {
        if case .choices(let options) = tags.content { options.map(\.key) } else { [] }
    }

    /// The write that sets `keys` on the project, in the order of the tags, leaving out a tag deleted meanwhile; nil
    /// when the project already holds exactly those tags.
    static func choosing(_ keys: Set<String>, in tags: FieldView) -> ItemAction? {
        let ordered = tags.options.map(\.key).filter(keys.contains)
        guard Set(ordered) != Set(heldKeys(of: tags)) else { return nil }
        return .edit(.setChoices(propertyKey: tags.propertyKey, keys: ordered))
    }

    /// The existing tag a typed name means, whatever its case and surrounding spaces.
    static func existingTag(named name: String, in tags: FieldView) -> FieldOption? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return tags.options.first { $0.label.compare(trimmed, options: .caseInsensitive) == .orderedSame }
    }

    /// The write that creates a tag named `name` and sets it on the project, or nil when the name is blank or a write
    /// is running, which would drop it.
    static func creating(_ name: String, in tags: FieldView, saving: Bool) -> ItemAction? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !saving else { return nil }
        return .edit(.addChoice(propertyKey: tags.propertyKey, label: trimmed))
    }

    /// The tags among `now` whose keys were not among `before`: the ones a sent name created.
    static func added(since before: Set<String>?, now: [FieldOption]) -> [String] {
        guard let before else { return [] }
        return now.map(\.key).filter { !before.contains($0) }
    }

    /// The write that renames `option` to `name`, or nil when the name is blank, unchanged or a write is running.
    static func renaming(_ name: String, of option: FieldOption, in tags: FieldView, saving: Bool) -> ItemAction? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != option.label, !saving else { return nil }
        return .edit(.renameChoice(propertyKey: tags.propertyKey, key: option.key, label: trimmed))
    }

    /// The write that gives the tag `key` the colour of `swatch`.
    static func recoloring(_ key: String, to swatch: CalendarSwatch, in tags: FieldView) -> ItemAction {
        .edit(.recolorChoice(propertyKey: tags.propertyKey, key: key, color: swatch.hex))
    }

    /// The text of a chip: white on a selected chip, which its colour fills, and the tag's colour on one that is not,
    /// so a tag is recognized by its colour either way; a tag without a colour reads in the primary colour.
    static func chipText(selected: Bool, color: Color?) -> AnyShapeStyle {
        if selected { return AnyShapeStyle(.white) }
        return color.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.primary)
    }

    /// The write that deletes the tag `key` from every project.
    static func removal(of key: String, in tags: FieldView) -> ItemAction {
        .edit(.removeChoice(propertyKey: tags.propertyKey, key: key))
    }
}

// MARK: - Subviews
private extension ProjectTagsSheet {

    /// Every tag as a chip of its own, so a hold on one opens the menu of that tag alone; in a list row the row
    /// would take the hold for all of them.
    var chipsCard: some View {
        TagFlowLayout(spacing: Theme.Spacing.small) {
            ForEach(tags.options, id: \.key) { option in
                chip(option)
            }
        }
        .padding(Theme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.card, in: cardShape)
    }

    @ViewBuilder var failureText: some View {
        if let failure, failure.propertyKey == tags.propertyKey {
            Text(FailureKind.message(for: failure.kind))
                .font(.footnote)
                .foregroundStyle(Theme.Colors.destructive)
                .padding(.horizontal, Theme.Spacing.medium)
        }
    }

    var cardShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
    }

    func chip(_ option: FieldOption) -> some View {
        let isSelected = selection.contains(option.key)
        let color = Color(hex: option.color)
        return Button { toggle(option.key) } label: {
            Text(verbatim: "#" + option.label)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .foregroundStyle(Self.chipText(selected: isSelected, color: color))
                .background(
                    isSelected ? AnyShapeStyle(color ?? Theme.Colors.accent) : AnyShapeStyle(.fill.tertiary),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .contextMenu { menu(for: option) }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier(CollectionsIdentifiers.projectTagChipPrefix + option.key)
    }

    @ViewBuilder
    func menu(for option: FieldOption) -> some View {
        Button {
            renameDraft = option.label
            renamed = option
        } label: {
            Label { Text("project.tag.rename", bundle: .module) } icon: { Image(systemName: "pencil") }
        }
        .accessibilityIdentifier(CollectionsIdentifiers.projectTagRename)
        if !swatches.isEmpty {
            Menu {
                ForEach(swatches) { swatch in
                    Button { send(Self.recoloring(option.key, to: swatch, in: tags)) } label: {
                        Label {
                            Text(swatch.tagColorName)
                        } icon: {
                            Image(systemName: swatch.isTagColor(option.color) ? "checkmark.circle.fill" : "circle.fill")
                        }
                        .tint(Color(hex: swatch.hex))
                    }
                    .disabled(swatch.isTagColor(option.color))
                }
            } label: {
                Label { Text("project.tag.color", bundle: .module) } icon: { Image(systemName: "paintpalette") }
            }
        }
        Divider()
        Button(role: .destructive) { deleted = option } label: {
            Label { Text("project.tag.delete.confirm", bundle: .module) } icon: { Image(systemName: "trash") }
        }
        .accessibilityIdentifier(CollectionsIdentifiers.projectTagDelete)
    }

    var newTagCard: some View {
        TextField(text: $newTag) { Text("project.tags.new", bundle: .module) }
            .focused($isTypingNewTag)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .onSubmit(submitNewTag)
            .padding(.horizontal, Theme.Spacing.medium)
            .frame(minHeight: Theme.Layout.rowHeight)
            .background(Theme.Colors.card, in: cardShape)
            .accessibilityIdentifier(CollectionsIdentifiers.projectSettingsNewTag)
    }

    var deletionTitle: String {
        let format = String(localized: "project.tag.delete.title", bundle: .module)
        return String(format: format, locale: .current, deleted?.label ?? "")
    }

    func isPresenting(_ option: Binding<FieldOption?>) -> Binding<Bool> {
        Binding(get: { option.wrappedValue != nil }, set: { if !$0 { option.wrappedValue = nil } })
    }

    func toggle(_ key: String) {
        if selection.contains(key) { selection.remove(key) } else { selection.insert(key) }
    }

    /// A typed name that is already a tag selects it; any other is created and selected once it exists. The field
    /// keeps the keyboard, so tag after tag can be typed, and a name sent while the last one is on its way waits.
    func submitNewTag() {
        defer { isTypingNewTag = true }
        guard keysBeforeAdd == nil else { return }
        if let existing = Self.existingTag(named: newTag, in: tags) {
            selection.insert(existing.key)
            newTag = ""
        } else if let action = Self.creating(newTag, in: tags, saving: saving) {
            keysBeforeAdd = Set(tags.options.map(\.key))
            send(action)
        }
    }

    /// Selects a tag the typed name created, and drops from the choice a tag deleted meanwhile.
    func follow(_ options: [FieldOption]) {
        let created = Self.added(since: keysBeforeAdd, now: options)
        if !created.isEmpty {
            selection.formUnion(created)
            newTag = ""
            keysBeforeAdd = nil
        }
        let keys = Set(options.map(\.key))
        selection.formIntersection(keys)
        original.removeAll { !keys.contains($0) }
    }

    func rename(_ option: FieldOption) {
        if let action = Self.renaming(renameDraft, of: option, in: tags, saving: saving) { send(action) }
    }

    /// The checkmark sets the chosen tags on the project; the cross puts back the ones it held when the sheet opened,
    /// which a created tag changed already.
    func close(committing: Bool) {
        let keys = committing ? selection : Set(original)
        if let action = Self.choosing(keys, in: tags) { send(action) }
        dismiss()
    }
}

// MARK: - Preview
extension ProjectTagsSheet {

    static let previewTags = FieldView(
        propertyKey: "tags",
        name: "Tags",
        kind: .multiSelect,
        content: .choices([FieldOption(key: "client", label: "Client", color: "#FF9500")]),
        options: [
            FieldOption(key: "client", label: "Client", color: "#FF9500"),
            FieldOption(key: "home", label: "Home", color: nil),
            FieldOption(key: "semprec", label: "Semprec", color: "#34C759")
        ],
        editable: true,
        origin: nil
    )
}

#Preview {
    ProjectTagsSheet(
        tags: ProjectTagsSheet.previewTags,
        swatches: [CalendarSwatch(key: "orange", hex: "#FF9500"), CalendarSwatch(key: "green", hex: "#34C759")],
        saving: false,
        failure: nil,
        send: { _ in }
    )
}
