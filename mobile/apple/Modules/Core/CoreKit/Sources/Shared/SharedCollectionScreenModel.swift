@preconcurrency internal import SharedSDK

/// The Kotlin `CollectionViewModel` as a `CollectionScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedCollectionScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.CollectionViewModel
    private let effectQueue: EffectQueue<CollectionEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.CollectionViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedCollectionScreenModel: ScreenModel {

    var state: CollectionState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<CollectionState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<CollectionEffect> {
        effectQueue.stream()
    }

    func send(_ action: CollectionAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedCollectionScreenModel {

    static func state(_ state: SharedSDK.CollectionState) -> CollectionState {
        CollectionState(
            phase: phase(state.phase),
            failure: state.failure.map(FailureKind.init),
            header: state.header.map(header),
            search: state.search,
            quickFilters: state.quickFilters.map { QuickFilterChip(key: $0.key, label: $0.label) },
            selectedQuickFilter: state.selectedQuickFilter,
            sorts: state.sorts.map { SortChoice(axis: axis($0.axis), name: $0.name) },
            selectedSort: state.selectedSort.map(axis),
            descending: state.descending,
            layouts: state.layouts.map(layout),
            layout: layout(state.layout),
            sections: state.sections.map(section),
            filterSheet: state.filterSheet.map(sheet),
            facetBar: state.facetBar.map(bar),
            activeFilterCount: Int(state.activeFilterCount),
            hasMore: state.hasMore,
            loadingMore: state.loadingMore,
            refreshing: state.refreshing,
            canCreate: state.canCreate,
            canUpload: state.canUpload,
            creating: state.creating,
            writeFailure: state.writeFailure.map(Failed.init)
        )
    }

    static func action(_ action: CollectionAction) -> any SharedSDK.CollectionAction {
        switch action {
        case .retry: SharedSDK.CollectionActionRetry.shared
        case .refresh: SharedSDK.CollectionActionRefresh.shared
        case .search(let text): SharedSDK.CollectionActionSearch(text: text)
        case .selectQuickFilter(let key): SharedSDK.CollectionActionSelectQuickFilter(key: key)
        case .selectSort(let axis): SharedSDK.CollectionActionSelectSort(axis: sharedAxis(axis))
        case .selectLayout(let layout): SharedSDK.CollectionActionSelectLayout(layout: sharedLayout(layout))
        case .loadMore: SharedSDK.CollectionActionLoadMore.shared
        case .openItem(let id): SharedSDK.CollectionActionOpenItem(id: id)
        case .dismissWriteFailure: SharedSDK.CollectionActionDismissWriteFailure.shared
        case .filter(let filter): filterAction(filter)
        case .write(let write): writeAction(write)
        }
    }

    static func filterAction(_ action: CollectionAction.Filter) -> any SharedSDK.CollectionAction {
        switch action {
        case .open: SharedSDK.CollectionActionFilterOpen.shared
        case .close: SharedSDK.CollectionActionFilterClose.shared
        case .toggle(let key, let value): SharedSDK.CollectionActionFilterToggle(propertyKey: key, value: value)
        case .toggleDate(let key, let preset):
            SharedSDK.CollectionActionFilterToggleDate(propertyKey: key, preset: preset)
        case .clear(let key): SharedSDK.CollectionActionFilterClear(propertyKey: key)
        case .clearAll: SharedSDK.CollectionActionFilterClearAll.shared
        }
    }

    static func writeAction(_ action: CollectionAction.Write) -> any SharedSDK.CollectionAction {
        switch action {
        case .create(let title): SharedSDK.CollectionActionWriteCreate(title: title)
        case .upload(let filename, let mimeType, let base64):
            SharedSDK.CollectionActionWriteUpload(filename: filename, mimeType: mimeType, base64: base64)
        }
    }

    static func effect(_ effect: any SharedSDK.CollectionEffect) -> CollectionEffect {
        switch onEnum(of: effect) {
        case .openItem(let open): .openItem(itemId: open.itemId, databaseKey: open.databaseKey)
        }
    }

    /// The Kotlin target of a Swift one, as the SDK takes it.
    static func target(_ target: CollectionTarget) -> any SharedSDK.CollectionTarget {
        switch target {
        case .whole(let key, let id): SharedSDK.CollectionTargetWhole(databaseKey: key, databaseId: id)
        case .ofItem(let key, let relationKey, let itemId):
            SharedSDK.CollectionTargetOfItem(databaseKey: key, relationKey: relationKey, itemId: itemId)
        case .matching(let key, let id, let filterJson):
            SharedSDK.CollectionTargetMatching(databaseKey: key, databaseId: id, filterJson: filterJson)
        }
    }
}

// MARK: - Mapping of the parts
extension SharedCollectionScreenModel {

    static func phase(_ phase: SharedSDK.CollectionPhase) -> CollectionPhase {
        switch phase {
        case .loading: .loading
        case .content: .content
        case .empty: .empty
        case .error: .error
        }
    }

    static func layout(_ layout: SharedSDK.CollectionLayout) -> CollectionLayout {
        switch layout {
        case .list: .list
        case .gallery: .gallery
        case .board: .board
        }
    }

    static func sharedLayout(_ layout: CollectionLayout) -> SharedSDK.CollectionLayout {
        switch layout {
        case .list: .list
        case .gallery: .gallery
        case .board: .board
        }
    }

    static func axis(_ axis: SharedSDK.SortAxis) -> SortAxis {
        switch axis {
        case .title: .title
        case .date: .date
        case .group: .group
        case .created: .created
        }
    }

    static func sharedAxis(_ axis: SortAxis) -> SharedSDK.SortAxis {
        switch axis {
        case .title: .title
        case .date: .date
        case .group: .group
        case .created: .created
        }
    }

    static func header(_ header: SharedSDK.CollectionHeader) -> CollectionHeader {
        CollectionHeader(
            databaseId: header.databaseId,
            key: header.key,
            name: header.name,
            icon: header.icon,
            color: header.color,
            searchPlaceholder: header.searchPlaceholder
        )
    }

    static func section(_ section: SharedSDK.CollectionSection) -> CollectionSection {
        let kind: SectionKind
        switch section.kind {
        case .none: kind = SectionKind.none
        case .option: kind = .option
        case .day: kind = .day
        case .month: kind = .month
        case .letter: kind = .letter
        case .past: kind = .past
        case .noValue: kind = .noValue
        }
        return CollectionSection(
            kind: kind,
            key: section.key,
            label: section.label,
            color: section.color,
            rows: section.rows.map(row)
        )
    }

    static func row(_ row: SharedSDK.CollectionRow) -> CollectionRow {
        CollectionRow(
            id: row.id,
            title: row.title,
            group: row.group.map(FieldOption.init),
            date: row.date,
            subtitle: row.subtitle.map(FieldContent.init),
            fileType: row.fileType,
            rating: row.rating.map { Int(truncating: $0) }
        )
    }

    static func sheet(_ sheet: SharedSDK.FilterSheet) -> FilterSheet {
        FilterSheet(
            loading: sheet.loading,
            failure: sheet.failure.map(Failed.init),
            groups: sheet.groups.map { group in
                FilterGroup(
                    propertyKey: group.propertyKey,
                    name: group.name,
                    kind: FieldKind(group.kind),
                    options: group.options.map(option)
                )
            }
        )
    }

    static func bar(_ bar: SharedSDK.FacetBar) -> FacetBar {
        FacetBar(propertyKey: bar.propertyKey, chips: bar.chips.map(option))
    }

    static func option(_ option: SharedSDK.FilterOption) -> FilterOption {
        FilterOption(
            value: option.value,
            label: option.label,
            color: option.color,
            count: option.count.map { Int($0.int32Value) },
            selected: option.selected
        )
    }
}
