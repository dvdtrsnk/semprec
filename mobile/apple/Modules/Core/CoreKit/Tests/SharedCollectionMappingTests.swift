import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the collection bridge's state mapping with Kotlin values built here: the real ViewModel
/// needs a server, which a test does not have. Both modules declare most of these type names, so each is qualified
/// with its module.
final class SharedCollectionMappingTests: XCTestCase {

    // MARK: - Enums
    @MainActor
    func testCollectionMapsEveryPhaseLayoutAndAxis() {
        let phases: [(SharedSDK.CollectionPhase, CoreKit.CollectionPhase)] =
            [(.loading, .loading), (.content, .content), (.empty, .empty), (.error, .error)]
        for (kotlin, native) in phases {
            XCTAssertEqual(SharedCollectionScreenModel.phase(kotlin), native)
        }
        let layouts: [(SharedSDK.CollectionLayout, CoreKit.CollectionLayout)] =
            [(.list, .list), (.gallery, .gallery), (.board, .board)]
        for (kotlin, native) in layouts {
            XCTAssertEqual(SharedCollectionScreenModel.layout(kotlin), native)
            XCTAssertEqual(SharedCollectionScreenModel.sharedLayout(native), kotlin)
        }
        let axes: [(SharedSDK.SortAxis, CoreKit.SortAxis)] =
            [(.title, .title), (.date, .date), (.group, .group), (.created, .created)]
        for (kotlin, native) in axes {
            XCTAssertEqual(SharedCollectionScreenModel.axis(kotlin), native)
            XCTAssertEqual(SharedCollectionScreenModel.sharedAxis(native), kotlin)
        }
    }

    @MainActor
    func testCollectionMapsEverySectionKind() {
        let kinds: [(SharedSDK.SectionKind, CoreKit.SectionKind)] = [
            (.none, CoreKit.SectionKind.none), (.option, .option), (.day, .day), (.month, .month),
            (.letter, .letter), (.past, .past), (.noValue, .noValue)
        ]
        for (kotlin, native) in kinds {
            let section = SharedSDK.CollectionSection(kind: kotlin, key: "k", label: "l", color: nil, rows: [])
            XCTAssertEqual(SharedCollectionScreenModel.section(section).kind, native)
        }
    }

    // MARK: - State
    @MainActor
    func testCollectionMapsTheHeaderTheChipsTheSortsAndTheLayouts() {
        let mapped = SharedCollectionScreenModel.state(fullState())
        XCTAssertEqual(mapped.phase, .content)
        XCTAssertEqual(mapped.header?.name, "Projects")
        XCTAssertEqual(mapped.header?.searchPlaceholder, "Search")
        XCTAssertEqual(mapped.search, "web")
        XCTAssertEqual(mapped.quickFilters, [QuickFilterChip(key: "active", label: "Active")])
        XCTAssertEqual(mapped.selectedQuickFilter, "active")
        XCTAssertEqual(mapped.sorts, [SortChoice(axis: .date, name: "Date")])
        XCTAssertEqual(mapped.selectedSort, .date)
        XCTAssertTrue(mapped.descending)
        XCTAssertEqual(mapped.layouts, [.list, .board])
        XCTAssertEqual(mapped.layout, .board)
    }

    @MainActor
    func testCollectionMapsTheRowsAndTheFlags() {
        let mapped = SharedCollectionScreenModel.state(fullState())
        let row = CollectionRow(
            id: "p1",
            title: "Semprec",
            group: FieldOption(key: "inProgress", label: "In progress", color: "#007AFF"),
            date: "2027-01-31",
            subtitle: [.text("t")],
            fileType: "PDF",
            rating: 4
        )
        XCTAssertEqual(
            mapped.sections,
            [CollectionSection(kind: .option, key: "inProgress", label: "In progress", color: "#007AFF", rows: [row])]
        )
        XCTAssertEqual(mapped.activeFilterCount, 2)
        XCTAssertTrue(mapped.hasMore && mapped.loadingMore && mapped.refreshing)
        XCTAssertTrue(mapped.canCreate && mapped.canUpload && mapped.creating)
        XCTAssertEqual(mapped.writeFailure, Failed(kind: nil))
    }

    @MainActor
    func testCollectionMapsTheFilterSheet() {
        let sheet = SharedCollectionScreenModel.state(fullState()).filterSheet
        XCTAssertEqual(sheet?.failure, Failed(kind: .unavailable))
        XCTAssertEqual(sheet?.loading, false)
        XCTAssertEqual(sheet?.groups.first?.kind, .select)
        XCTAssertEqual(sheet?.groups.first?.options.map(\.count), [3, nil])
        XCTAssertEqual(sheet?.groups.first?.options.map(\.selected), [true, false])
    }

    @MainActor
    func testCollectionMapsAFailureAndTheInitialState() {
        let failed = SharedSDK.CollectionState(
            phase: .error,
            failure: .unauthorized,
            header: nil,
            search: "",
            quickFilters: [],
            selectedQuickFilter: nil,
            sorts: [],
            selectedSort: nil,
            descending: false,
            layouts: [.list],
            layout: .list,
            sections: [],
            filterSheet: nil,
            activeFilterCount: 0,
            hasMore: false,
            loadingMore: false,
            refreshing: false,
            canCreate: false,
            canUpload: false,
            creating: false,
            writeFailure: nil
        )
        let mapped = SharedCollectionScreenModel.state(failed)
        XCTAssertEqual(mapped, CollectionState(phase: .error, failure: .unauthorized))
    }
}

// MARK: - Helpers
private extension SharedCollectionMappingTests {

    func fullState() -> SharedSDK.CollectionState {
        let option = SharedSDK.OptionView(key: "inProgress", label: "In progress", color: "#007AFF")
        let row = SharedSDK.CollectionRow(
            id: "p1",
            title: "Semprec",
            group: option,
            date: "2027-01-31",
            subtitle: [SharedSDK.FieldContentText(text: "t")],
            fileType: "PDF",
            rating: KotlinInt(int: 4)
        )
        return SharedSDK.CollectionState(
            phase: .content,
            failure: nil,
            header: SharedSDK.CollectionHeader(
                databaseId: "db",
                key: "projects",
                name: "Projects",
                icon: "folder",
                color: "#AF52DE",
                searchPlaceholder: "Search"
            ),
            search: "web",
            quickFilters: [SharedSDK.QuickFilterChip(key: "active", label: "Active")],
            selectedQuickFilter: "active",
            sorts: [SharedSDK.SortChoice(axis: .date, name: "Date")],
            selectedSort: .date,
            descending: true,
            layouts: [.list, .board],
            layout: .board,
            sections: [
                SharedSDK.CollectionSection(
                    kind: .option, key: "inProgress", label: "In progress", color: "#007AFF", rows: [row]
                )
            ],
            filterSheet: sheet(),
            activeFilterCount: 2,
            hasMore: true,
            loadingMore: true,
            refreshing: true,
            canCreate: true,
            canUpload: true,
            creating: true,
            writeFailure: SharedSDK.Failed(kind: nil)
        )
    }

    func sheet() -> SharedSDK.FilterSheet {
        let done = SharedSDK.FilterOption(
            value: "done", label: "Done", color: nil, count: KotlinInt(int: 3), selected: true
        )
        let today = SharedSDK.FilterOption(value: "today", label: "today", color: nil, count: nil, selected: false)
        let group = SharedSDK.FilterGroup(
            propertyKey: "status",
            name: "Status",
            kind: .select,
            options: [done, today]
        )
        return SharedSDK.FilterSheet(loading: false, failure: SharedSDK.Failed(kind: .unavailable), groups: [group])
    }
}
