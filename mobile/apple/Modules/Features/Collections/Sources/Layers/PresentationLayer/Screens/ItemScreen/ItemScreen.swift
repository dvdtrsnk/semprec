import CoreKit
import DesignSystem
import SwiftUI

/// The detail of one item of any database: its title, its properties with the origin of every value that comes from
/// another item, its page and the collections connected to it. A project has a layout of its own over the same data.
struct ItemScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: ItemViewModel
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - State
    @State private var hasAppeared = false

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> ItemViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(viewModel.state.header?.title ?? "")
            .inlineNavigationTitle()
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(CollectionsIdentifiers.itemScreen)
            .task { await viewModel.observe() }
            .onAppear { if hasAppeared { viewModel.send(.refresh) } else { hasAppeared = true } }
            .onChange(of: viewModel.state.deleted) { _, deleted in
                if deleted { dismiss() }
            }
    }
}

// MARK: - Subviews
private extension ItemScreen {

    @ViewBuilder var content: some View {
        let state = viewModel.state
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(.failure(
                message: Text(FailureKind.message(for: state.failure)),
                retry: { viewModel.send(.retry) }
            ))
        case .content:
            if let header = state.header {
                loaded(state, header)
            }
        }
    }

    func loaded(_ state: ItemState, _ header: ItemHeader) -> some View {
        Group {
            if header.databaseKey == DatabaseKey.projects {
                ProjectContent(state: state, header: header, send: viewModel.send, show: viewModel.showProject)
            } else if DatabaseKey.isMedia(header.databaseKey) {
                MediaItemContent(state: state, header: header, send: viewModel.send)
            } else {
                ItemContent(state: state, header: header, send: viewModel.send)
            }
        }
        .refreshable { viewModel.send(.refresh) }
        .overlay(alignment: .top) { if state.saving { ProgressView().padding(.top, Theme.Spacing.small) } }
        .sheet(isPresented: pickerBinding) {
            if let picker = state.picker { RelationPickerSheet(picker: picker, send: viewModel.send) }
        }
        .sheet(isPresented: previewBinding) {
            if let preview = state.preview {
                FilePreviewSheet(preview: preview, format: FieldFormat(), send: viewModel.send)
            }
        }
        .deletionAlert(state.deletion, title: header.title, names: relatedNames(state), send: viewModel.send)
        .alert(
            Text("item.writeFailed", bundle: .module),
            isPresented: Binding(
                get: { state.writeFailure != nil },
                set: { if !$0 { viewModel.send(.dismissWriteFailure) } }
            ),
            presenting: state.writeFailure
        ) { _ in
            Button { viewModel.send(.dismissWriteFailure) } label: { Text("item.writeFailed.ok", bundle: .module) }
        } message: { failure in
            Text(FailureKind.message(for: failure.kind))
        }
    }

    var pickerBinding: Binding<Bool> {
        Binding(get: { viewModel.state.picker != nil }, set: { if !$0 { viewModel.send(.picker(.close)) } })
    }

    var previewBinding: Binding<Bool> {
        Binding(get: { viewModel.state.preview != nil }, set: { if !$0 { viewModel.send(.preview(.close)) } })
    }

    /// The names of the collections connected to the item by their canonical key, to word a deletion's impact.
    func relatedNames(_ state: ItemState) -> [String: String] {
        let named = state.related.compactMap { related in related.databaseKey.map { ($0, related.name) } }
        return Dictionary(named) { first, _ in first }
    }
}

// MARK: - Content
/// The layout of every item that is not a project.
struct ItemContent: View {

    // MARK: - Dependencies
    let state: ItemState
    let header: ItemHeader
    let send: (ItemAction) -> Void

    // MARK: - State
    @State private var titleDraft = ""

    // MARK: - Body
    var body: some View {
        List {
            Section { titleRow }
            Section(header: Text("item.properties", bundle: .module)) {
                ForEach(state.fields) { field in
                    FieldRowView(field: field, fields: state.fields, format: FieldFormat(), send: send)
                }
            }
            Section(header: Text("item.page", bundle: .module)) {
                PagePanel(page: state.page, placeholder: "item.page.placeholder", send: send)
            }
            RelatedSection(related: state.related, send: send)
            Section {
                Button(role: .destructive) { send(.deletion(.request)) } label: { Text("item.delete", bundle: .module) }
                    .accessibilityIdentifier(CollectionsIdentifiers.deleteButton)
            }
        }
        .onAppear { titleDraft = header.title }
        .onChange(of: header.title) { _, title in titleDraft = title }
    }
}

// MARK: - Subviews
private extension ItemContent {

    var titleRow: some View {
        HStack(spacing: Theme.Spacing.medium) {
            CollectionBadge(
                title: header.title,
                tint: Color(hex: header.color) ?? Theme.Colors.accent,
                isRound: header.databaseKey == DatabaseKey.people,
                size: 52
            )
            VStack(alignment: .leading, spacing: 2) {
                TextField(text: $titleDraft) { Text("item.title.placeholder", bundle: .module) }
                    .font(.title2.weight(.semibold))
                    .onSubmit { send(.edit(.rename(titleDraft))) }
                    .accessibilityIdentifier(CollectionsIdentifiers.itemTitle)
                Text(header.databaseName).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }
}

/// The collections connected to an item, each as a row with its number of items.
struct RelatedSection: View {

    // MARK: - Dependencies
    let related: [RelatedView]
    let send: (ItemAction) -> Void

    // MARK: - Body
    var body: some View {
        if !related.isEmpty {
            Section(header: Text("item.related", bundle: .module)) {
                ForEach(related) { collection in
                    Button { send(.navigate(.openRelated(databaseId: collection.databaseId))) } label: {
                        HStack {
                            Image(systemName: CollectionIcon.symbol(for: collection.icon))
                                .foregroundStyle(Color(hex: collection.color) ?? Theme.Colors.accent)
                                .frame(width: 26)
                            Text(collection.name)
                            Spacer()
                            Text("\(collection.count)").foregroundStyle(Theme.Colors.secondaryText).monospacedDigit()
                            Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .listRowButton()
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier(CollectionsIdentifiers.relatedPrefix + collection.databaseId)
                }
            }
        }
    }
}
