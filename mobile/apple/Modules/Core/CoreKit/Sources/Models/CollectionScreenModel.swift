import Foundation

/// Which collection a screen shows: a database, named by its canonical key (or, for a database a person created, by
/// its id), and the items of it that belong. Projects, People, Companies, Events and Files are one screen over
/// different targets.
public enum CollectionTarget: Equatable, Sendable, Hashable {

    /// Every item of the database.
    case whole(databaseKey: String?, databaseId: String?)
    /// The items of one area.
    case ofArea(databaseKey: String, areaId: String)
    /// The items whose relation `relationKey` holds the item `itemId` (the files of a project).
    case ofItem(databaseKey: String, relationKey: String, itemId: String)
    /// The items a filter selects, such as the filter of an item's related collection.
    case matching(databaseKey: String?, databaseId: String?, filterJson: String)
}

public enum CollectionPhase: Equatable, Sendable {

    case loading, content, empty, error
}

/// How a collection is laid out: rows, tiles, or one column per status.
public enum CollectionLayout: Equatable, Sendable, Hashable {

    case list, gallery, board
}

/// What a collection can be ordered by.
public enum SortAxis: Equatable, Sendable, Hashable {

    case title, date, group, created
}

public enum SectionKind: Equatable, Sendable {

    case none, option, day, month, letter, past, noValue
}

public struct CollectionHeader: Equatable, Sendable {

    public let databaseId: String
    public let key: String?
    public let name: String
    public let icon: String?
    public let color: String?
    public let searchPlaceholder: String?

    public init(
        databaseId: String,
        key: String?,
        name: String,
        icon: String?,
        color: String?,
        searchPlaceholder: String?
    ) {
        self.databaseId = databaseId
        self.key = key
        self.name = name
        self.icon = icon
        self.color = color
        self.searchPlaceholder = searchPlaceholder
    }
}

public struct QuickFilterChip: Equatable, Sendable, Identifiable {

    public let key: String
    public let label: String

    public var id: String { key }

    public init(key: String, label: String) {
        self.key = key
        self.label = label
    }
}

/// An order the person can pick; `name` is the name of the property it orders by.
public struct SortChoice: Equatable, Sendable, Identifiable {

    public let axis: SortAxis
    public let name: String

    public var id: SortAxis { axis }

    public init(axis: SortAxis, name: String) {
        self.axis = axis
        self.name = name
    }
}

/// One item of a list: its title, status, date and the few values that say what it is.
public struct CollectionRow: Equatable, Sendable, Identifiable {

    public let id: String
    public let title: String
    public let group: FieldOption?
    public let date: String?
    public let subtitle: [FieldContent]
    public let fileType: String?
    /// The person's own stars (1 to 5) of a book, a film or the like; nil without any.
    public let rating: Int?

    public init(
        id: String,
        title: String,
        group: FieldOption?,
        date: String?,
        subtitle: [FieldContent],
        fileType: String?,
        rating: Int? = nil
    ) {
        self.id = id
        self.title = title
        self.group = group
        self.date = date
        self.subtitle = subtitle
        self.fileType = fileType
        self.rating = rating
    }
}

/// A group of rows under one heading; `label` is empty for a heading the app words itself (a day, a month).
public struct CollectionSection: Equatable, Sendable, Identifiable {

    public let kind: SectionKind
    public let key: String
    public let label: String
    public let color: String?
    public let rows: [CollectionRow]

    public var id: String { "\(kind)-\(key)" }

    public init(kind: SectionKind, key: String, label: String, color: String?, rows: [CollectionRow]) {
        self.kind = kind
        self.key = key
        self.label = label
        self.color = color
        self.rows = rows
    }
}

public struct FilterOption: Equatable, Sendable, Identifiable {

    public let value: String
    public let label: String
    public let color: String?
    public let count: Int?
    public let selected: Bool

    public var id: String { value }

    public init(value: String, label: String, color: String?, count: Int?, selected: Bool) {
        self.value = value
        self.label = label
        self.color = color
        self.count = count
        self.selected = selected
    }
}

public struct FilterGroup: Equatable, Sendable, Identifiable {

    public let propertyKey: String
    public let name: String
    public let kind: FieldKind
    public let options: [FilterOption]

    public var id: String { propertyKey }

    public init(propertyKey: String, name: String, kind: FieldKind, options: [FilterOption]) {
        self.propertyKey = propertyKey
        self.name = name
        self.kind = kind
        self.options = options
    }
}

/// The chips above the list, one per value of the database's facet bar property that items hold. A chip toggles its
/// value in the same selection the filter sheet edits (`.filter(.toggle(propertyKey:value:))` with `propertyKey`).
public struct FacetBar: Equatable, Sendable {

    public let propertyKey: String
    public let chips: [FilterOption]

    public init(propertyKey: String, chips: [FilterOption]) {
        self.propertyKey = propertyKey
        self.chips = chips
    }
}

/// The filter sheet once it was opened: its groups, or why they are missing.
public struct FilterSheet: Equatable, Sendable {

    public let loading: Bool
    public let failure: Failed?
    public let groups: [FilterGroup]

    public init(loading: Bool, failure: Failed?, groups: [FilterGroup]) {
        self.loading = loading
        self.failure = failure
        self.groups = groups
    }
}

/// Everything one collection screen shows.
public struct CollectionState: Equatable, Sendable {

    public var phase: CollectionPhase
    /// The expected failure behind `.error`; nil for an unexpected one.
    public var failure: FailureKind?
    public var header: CollectionHeader?
    public var search: String
    public var quickFilters: [QuickFilterChip]
    public var selectedQuickFilter: String?
    public var sorts: [SortChoice]
    public var selectedSort: SortAxis?
    public var descending: Bool
    public var layouts: [CollectionLayout]
    public var layout: CollectionLayout
    public var sections: [CollectionSection]
    public var filterSheet: FilterSheet?
    /// Nil when the database declares no bar or no item holds a value of it.
    public var facetBar: FacetBar?
    public var activeFilterCount: Int
    public var hasMore: Bool
    public var loadingMore: Bool
    public var refreshing: Bool
    public var canCreate: Bool
    public var canUpload: Bool
    public var creating: Bool
    public var writeFailure: Failed?

    public init(
        phase: CollectionPhase = .loading,
        failure: FailureKind? = nil,
        header: CollectionHeader? = nil,
        search: String = "",
        quickFilters: [QuickFilterChip] = [],
        selectedQuickFilter: String? = nil,
        sorts: [SortChoice] = [],
        selectedSort: SortAxis? = nil,
        descending: Bool = false,
        layouts: [CollectionLayout] = [.list],
        layout: CollectionLayout = .list,
        sections: [CollectionSection] = [],
        filterSheet: FilterSheet? = nil,
        facetBar: FacetBar? = nil,
        activeFilterCount: Int = 0,
        hasMore: Bool = false,
        loadingMore: Bool = false,
        refreshing: Bool = false,
        canCreate: Bool = false,
        canUpload: Bool = false,
        creating: Bool = false,
        writeFailure: Failed? = nil
    ) {
        self.phase = phase
        self.failure = failure
        self.header = header
        self.search = search
        self.quickFilters = quickFilters
        self.selectedQuickFilter = selectedQuickFilter
        self.sorts = sorts
        self.selectedSort = selectedSort
        self.descending = descending
        self.layouts = layouts
        self.layout = layout
        self.sections = sections
        self.filterSheet = filterSheet
        self.facetBar = facetBar
        self.activeFilterCount = activeFilterCount
        self.hasMore = hasMore
        self.loadingMore = loadingMore
        self.refreshing = refreshing
        self.canCreate = canCreate
        self.canUpload = canUpload
        self.creating = creating
        self.writeFailure = writeFailure
    }
}

public enum CollectionAction: Equatable, Sendable {

    case retry
    /// Runs the current query again over the rows on screen, for when the screen appears again.
    case refresh
    /// The text of the search field, sent when the person submits it.
    case search(String)
    case selectQuickFilter(String)
    case selectSort(SortAxis)
    case selectLayout(CollectionLayout)
    case loadMore
    case openItem(id: String)
    case dismissWriteFailure
    case filter(Filter)
    case write(Write)

    /// The filter sheet.
    public enum Filter: Equatable, Sendable {

        case open
        case close
        case toggle(propertyKey: String, value: String)
        case toggleDate(propertyKey: String, preset: String)
        case clear(propertyKey: String)
        case clearAll
    }

    /// Adding to the collection.
    public enum Write: Equatable, Sendable {

        case create(title: String)
        /// Uploads a file, given as Base64 text of its bytes.
        case upload(filename: String, mimeType: String, base64: String)
    }
}

public enum CollectionEffect: Equatable, Sendable {

    case openItem(itemId: String, databaseKey: String?)
}

public typealias CollectionScreenModel = ScreenModel<CollectionState, CollectionAction, CollectionEffect>

/// Collection screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedCollectionScreenModel =
    ScriptedScreenModel<CollectionState, CollectionAction, CollectionEffect>
