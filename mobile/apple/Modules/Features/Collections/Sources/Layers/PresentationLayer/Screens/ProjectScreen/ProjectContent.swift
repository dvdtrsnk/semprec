import CoreKit
import DesignSystem
import SwiftUI

/// The layout of a project over the generic item: its status, title, deadline and tags, its notes, the agent that
/// works in it, its tasks and the collections connected to it. The tasks, the mail, the notes and the agent are
/// screens of other features, reached through the router.
struct ProjectContent: View {

    // MARK: - Dependencies
    let state: ItemState
    let header: ItemHeader
    let send: (ItemAction) -> Void
    let show: (ProjectDestination) -> Void

    // MARK: - State
    @State private var titleDraft = ""
    @FocusState private var isEditingTitle: Bool
    @State private var isShowingSettings = false

    // MARK: - Body
    var body: some View {
        List {
            Section { titleBlock.listRowBackground(Color.clear) }
            Section(header: Text("project.notes", bundle: .module)) {
                PagePanel(page: state.page, placeholder: "project.notes.placeholder", send: send)
                destination("project.notes.open", symbol: "doc.text", to: .notes)
            }
            Section {
                destination("project.agent", symbol: "sparkles", to: .agent)
            }
            Section(header: Text("project.tasks", bundle: .module)) {
                destination("project.tasks.all", symbol: "checkmark.circle", to: .tasks)
            }
            RelatedSection(related: state.related, send: send)
        }
        .toolbar {
            PlainToolbarItem(placement: .primaryAction) {
                Button { isShowingSettings = true } label: { Image(systemName: "slider.horizontal.3") }
                    .accessibilityLabel(Text("project.settings", bundle: .module))
                    .accessibilityIdentifier(CollectionsIdentifiers.projectSettings)
            }
        }
        .sheet(isPresented: $isShowingSettings) {
            ProjectSettingsSheet(
                state: state,
                send: send,
                close: { isShowingSettings = false },
                openTags: {
                    isShowingSettings = false
                    show(.tags)
                },
                openMailSignals: {
                    isShowingSettings = false
                    show(.mailSignals)
                }
            )
        }
        .onAppear { titleDraft = header.title }
        .onChange(of: header.title) { _, title in titleDraft = title }
    }
}

// MARK: - Subviews
private extension ProjectContent {

    var titleBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            statusButton
            TextField(text: $titleDraft, axis: .vertical) { Text("item.title.placeholder", bundle: .module) }
                .font(.largeTitle.bold())
                .focused($isEditingTitle)
                .singleLineTitle($titleDraft) { renameTitle() }
                .accessibilityIdentifier(CollectionsIdentifiers.itemTitle)
            if let deadline {
                Text(deadline)
                    .font(.subheadline)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            tagChips
        }
    }

    /// The project's tags as chips; nothing while it has none.
    @ViewBuilder var tagChips: some View {
        if case .choices(let tags) = field("tags")?.content {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.small) {
                    ForEach(tags, id: \.key) { tag in
                        let color = Color(hex: tag.color) ?? Theme.Colors.accent
                        FilterChip(title: tag.label, color: color) { EmptyView() }
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(CollectionsIdentifiers.projectTags)
        }
    }

    /// Return in the title ends its editing and renames the item.
    func renameTitle() {
        isEditingTitle = false
        send(.edit(.rename(titleDraft)))
    }

    @ViewBuilder var statusButton: some View {
        if case .choices(let options) = field("status")?.content, let status = options.first {
            Button { isShowingSettings = true } label: { StatusPill(option: status) }.buttonStyle(.plain)
        }
    }

    /// "until 31. 1." for a project with a deadline.
    var deadline: String? {
        guard case .day(let iso) = field("date")?.content else { return nil }
        return String(format: String(localized: "project.deadline", bundle: .module), FieldFormat().day(iso))
    }

    func field(_ key: String) -> FieldView? {
        state.fields.first { $0.propertyKey == key }
    }

    func destination(_ title: LocalizedStringKey, symbol: String, to destination: ProjectDestination) -> some View {
        Button { show(destination) } label: {
            HStack {
                Label { Text(title, bundle: .module) } icon: { Image(systemName: symbol) }
                Spacer()
                Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .listRowButton()
        .foregroundStyle(.primary)
    }
}
