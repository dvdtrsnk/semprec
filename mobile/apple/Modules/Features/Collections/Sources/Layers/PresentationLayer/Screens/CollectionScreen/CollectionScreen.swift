import CoreKit
import DesignSystem
import SwiftUI
import UniformTypeIdentifiers

/// One collection of any database: a list, gallery or board of its items with search, quick filters, order and a
/// filter sheet. Projects, People, Companies, Events and Files are this screen over different targets.
struct CollectionScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: CollectionViewModel

    // MARK: - State
    @State private var query = ""
    @State private var isNaming = false
    @State private var newTitle = ""
    @State private var isImporting = false
    @State private var hasAppeared = false

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> CollectionViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(viewModel.state.header?.name ?? "")
            .inlineNavigationTitle()
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(CollectionsIdentifiers.collectionScreen)
            .task { await viewModel.observe() }
            .onAppear(perform: refreshWhenReturning)
    }
}

// MARK: - Subviews
private extension CollectionScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(.failure(
                message: Text(FailureKind.message(for: viewModel.state.failure)),
                retry: { viewModel.send(.retry) }
            ))
        case .content, .empty:
            loaded
        }
    }

    var loaded: some View {
        let state = viewModel.state
        return items(state)
            .safeAreaInset(edge: .top, spacing: 0) {
                QuickFilterBar(
                    chips: state.quickFilters,
                    selected: state.selectedQuickFilter,
                    activeFilterCount: state.activeFilterCount,
                    canFilter: state.header != nil,
                    tint: appearance(state).baseTint,
                    send: viewModel.send
                )
                .background(.bar)
            }
            .searchable(text: $query, prompt: Text(state.header?.searchPlaceholder ?? ""))
            .onSubmit(of: .search) { viewModel.send(.search(query)) }
            .onChange(of: query) { _, text in
                if text.isEmpty { viewModel.send(.search("")) }
            }
            .refreshable { viewModel.send(.refresh) }
            .toolbar { toolbar(state) }
            .sheet(isPresented: filterSheetBinding) {
                if let sheet = state.filterSheet {
                    FilterSheetView(sheet: sheet, hasActiveFilters: state.activeFilterCount > 0, send: viewModel.send)
                        .presentationDetents([.medium, .large])
                }
            }
            .alert(Text("collection.new.title", bundle: .module), isPresented: $isNaming) {
                TextField(text: $newTitle) { Text("collection.new.placeholder", bundle: .module) }
                    .accessibilityIdentifier(CollectionsIdentifiers.newItemField)
                Button { viewModel.send(.write(.create(title: newTitle))) } label: {
                    Text("collection.new.create", bundle: .module)
                }
                Button(role: .cancel) {} label: { Text("collection.new.cancel", bundle: .module) }
            }
            .fileImporter(isPresented: $isImporting, allowedContentTypes: [.item], onCompletion: upload)
            .alert(
                Text("collection.writeFailed", bundle: .module),
                isPresented: writeFailureBinding,
                presenting: state.writeFailure
            ) { _ in
                Button { viewModel.send(.dismissWriteFailure) } label: {
                    Text("collection.writeFailed.ok", bundle: .module)
                }
            } message: { failure in
                Text(FailureKind.message(for: failure.kind))
            }
    }

    @ViewBuilder
    func items(_ state: CollectionState) -> some View {
        let appearance = appearance(state)
        if state.phase == .empty && state.sections.allSatisfy({ $0.rows.isEmpty }) && state.layout != .board {
            StatusView(.empty(message: Text("collection.empty", bundle: .module), systemImage: "tray"))
        } else {
            switch state.layout {
            case .list: list(state, appearance)
            case .gallery:
                CollectionGalleryView(sections: state.sections, appearance: appearance, open: open)
            case .board:
                CollectionBoardView(sections: state.sections, appearance: appearance, open: open)
            }
        }
    }

    func list(_ state: CollectionState, _ appearance: CollectionAppearance) -> some View {
        List {
            ForEach(state.sections) { section in
                Section {
                    ForEach(section.rows) { row in
                        CollectionRowView(row: row, appearance: appearance, showsStatus: state.selectedSort != .group) {
                            open(row)
                        }
                    }
                } header: {
                    if section.kind != .none {
                        CollectionSectionHeader(section: section, format: appearance.format)
                    }
                }
            }
            if state.hasMore {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .onAppear { viewModel.send(.loadMore) }
                    .accessibilityIdentifier(CollectionsIdentifiers.loadMore)
            }
        }
        .overlay(alignment: .top) {
            if state.refreshing { ProgressView().padding(.top, Theme.Spacing.small) }
        }
    }

    @ToolbarContentBuilder
    func toolbar(_ state: CollectionState) -> some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Menu {
                if state.layouts.count > 1 {
                    Picker(selection: layoutBinding(state)) {
                        ForEach(state.layouts, id: \.self) { layout in
                            Label { layoutName(layout) } icon: { Image(systemName: layoutSymbol(layout)) }.tag(layout)
                        }
                    } label: { Text("collection.layout", bundle: .module) }
                }
                if !state.sorts.isEmpty {
                    Section {
                        ForEach(state.sorts) { sort in
                            Button { viewModel.send(.selectSort(sort.axis)) } label: {
                                Label(sort.name, systemImage: sortSymbol(sort.axis, state))
                            }
                        }
                    } header: {
                        Text("collection.sort", bundle: .module)
                    }
                }
            } label: {
                Image(systemName: layoutSymbol(state.layout))
            }
            .accessibilityLabel(Text("collection.options", bundle: .module))
            .accessibilityIdentifier(CollectionsIdentifiers.layoutMenu)
        }
        if state.canCreate || state.canUpload {
            ToolbarItem(placement: .primaryAction) {
                addButton(state)
            }
        }
    }

    @ViewBuilder
    func addButton(_ state: CollectionState) -> some View {
        Button {
            if state.canUpload { isImporting = true } else { beginNaming() }
        } label: {
            if state.creating { ProgressView() } else { Image(systemName: "plus") }
        }
        .disabled(state.creating)
        .accessibilityLabel(Text(state.canUpload ? "collection.upload" : "collection.new", bundle: .module))
        .accessibilityIdentifier(CollectionsIdentifiers.addButton)
    }
}

// MARK: - Actions
private extension CollectionScreen {

    func appearance(_ state: CollectionState) -> CollectionAppearance {
        CollectionAppearance(databaseKey: state.header?.key, color: state.header?.color)
    }

    func open(_ row: CollectionRow) {
        viewModel.send(.openItem(id: row.id))
    }

    func beginNaming() {
        newTitle = ""
        isNaming = true
    }

    /// The screen shows the collection as it is now when it comes back from an item, which may have changed it.
    func refreshWhenReturning() {
        if hasAppeared { viewModel.send(.refresh) } else { hasAppeared = true }
    }

    func upload(_ result: Result<URL, Error>) {
        guard case .success(let url) = result else { return }
        Task {
            let picked = try? await Task.detached { try UploadFile.read(url) }.value
            if let picked {
                viewModel.send(
                    .write(.upload(filename: picked.filename, mimeType: picked.mimeType, base64: picked.base64))
                )
            }
        }
    }

    var filterSheetBinding: Binding<Bool> {
        Binding(
            get: { viewModel.state.filterSheet != nil },
            set: { if !$0 { viewModel.send(.filter(.close)) } }
        )
    }

    var writeFailureBinding: Binding<Bool> {
        Binding(
            get: { viewModel.state.writeFailure != nil },
            set: { if !$0 { viewModel.send(.dismissWriteFailure) } }
        )
    }

    func layoutBinding(_ state: CollectionState) -> Binding<CollectionLayout> {
        Binding(get: { state.layout }, set: { viewModel.send(.selectLayout($0)) })
    }

    func layoutName(_ layout: CollectionLayout) -> Text {
        switch layout {
        case .list: Text("collection.layout.list", bundle: .module)
        case .gallery: Text("collection.layout.gallery", bundle: .module)
        case .board: Text("collection.layout.board", bundle: .module)
        }
    }

    func layoutSymbol(_ layout: CollectionLayout) -> String {
        switch layout {
        case .list: "list.bullet"
        case .gallery: "square.grid.2x2"
        case .board: "rectangle.split.3x1"
        }
    }

    func sortSymbol(_ axis: SortAxis, _ state: CollectionState) -> String {
        guard state.selectedSort == axis else { return "" }
        return state.descending ? "arrow.down" : "arrow.up"
    }
}
