import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the collection and item bridges' mappings with Kotlin values built here: the real
/// ViewModels need a server, which a test does not have. Both modules declare most of these type names, so each is
/// qualified with its module.
final class SharedCollectionMappingTests: XCTestCase {

    // MARK: - Collection state
    @MainActor
    func testCollectionMapsEveryPhaseLayoutAndAxis() {
        let phases: [(SharedSDK.CollectionPhase, CoreKit.CollectionPhase)] =
            [(.loading, .loading), (.content, .content), (.empty, .empty), (.error, .error)]
        for (kotlin, native) in phases {
            XCTAssertEqual(SharedCollectionScreenModel.phase(kotlin), native)
        }
        XCTAssertEqual(SharedCollectionScreenModel.layout(.list), .list)
        XCTAssertEqual(SharedCollectionScreenModel.layout(.gallery), .gallery)
        XCTAssertEqual(SharedCollectionScreenModel.layout(.board), .board)
        XCTAssertEqual(SharedCollectionScreenModel.sharedLayout(.list), .list)
        XCTAssertEqual(SharedCollectionScreenModel.sharedLayout(.gallery), .gallery)
        XCTAssertEqual(SharedCollectionScreenModel.sharedLayout(.board), .board)
        for (kotlin, native) in [(SharedSDK.SortAxis.title, CoreKit.SortAxis.title), (.date, .date), (.group, .group), (.created, .created)] {
            XCTAssertEqual(SharedCollectionScreenModel.axis(kotlin), native)
            XCTAssertEqual(SharedCollectionScreenModel.sharedAxis(native), kotlin)
        }
    }

    @MainActor
    func testCollectionMapsAFullState() {
        let option = SharedSDK.OptionView(key: "inProgress", label: "In progress", color: "#007AFF")
        let row = SharedSDK.CollectionRow(
            id: "p1",
            title: "Semprec",
            group: option,
            date: "2027-01-31",
            subtitle: [SharedSDK.FieldContentText(text: "t")],
            fileType: "PDF"
        )
        let sheet = SharedSDK.FilterSheet(
            loading: false,
            failure: SharedSDK.Failed(kind: .unavailable),
            groups: [
                SharedSDK.FilterGroup(
                    propertyKey: "status",
                    name: "Status",
                    kind: .select,
                    options: [
                        SharedSDK.FilterOption(value: "done", label: "Done", color: nil, count: KotlinInt(int: 3), selected: true),
                        SharedSDK.FilterOption(value: "today", label: "today", color: nil, count: nil, selected: false)
                    ]
                )
            ]
        )
        let state = SharedSDK.CollectionState(
            phase: .content,
            failure: nil,
            header: SharedSDK.CollectionHeader(databaseId: "db", key: "projects", name: "Projects", icon: "folder", color: "#AF52DE", searchPlaceholder: "Search"),
            search: "web",
            quickFilters: [SharedSDK.QuickFilterChip(key: "active", label: "Active")],
            selectedQuickFilter: "active",
            sorts: [SharedSDK.SortChoice(axis: .date, name: "Date")],
            selectedSort: .date,
            descending: true,
            layouts: [.list, .board],
            layout: .board,
            sections: [SharedSDK.CollectionSection(kind: .option, key: "inProgress", label: "In progress", color: "#007AFF", rows: [row])],
            filterSheet: sheet,
            activeFilterCount: 2,
            hasMore: true,
            loadingMore: true,
            refreshing: true,
            canCreate: true,
            canUpload: true,
            creating: true,
            writeFailure: SharedSDK.Failed(kind: nil)
        )
        let mapped = SharedCollectionScreenModel.state(state)
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
        XCTAssertEqual(
            mapped.sections,
            [
                CollectionSection(
                    kind: .option,
                    key: "inProgress",
                    label: "In progress",
                    color: "#007AFF",
                    rows: [
                        CollectionRow(
                            id: "p1",
                            title: "Semprec",
                            group: FieldOption(key: "inProgress", label: "In progress", color: "#007AFF"),
                            date: "2027-01-31",
                            subtitle: [.text("t")],
                            fileType: "PDF"
                        )
                    ]
                )
            ]
        )
        XCTAssertEqual(mapped.filterSheet?.failure, Failed(kind: .unavailable))
        XCTAssertEqual(mapped.filterSheet?.groups.first?.kind, .select)
        XCTAssertEqual(mapped.filterSheet?.groups.first?.options.map(\.count), [3, nil])
        XCTAssertEqual(mapped.filterSheet?.groups.first?.options.map(\.selected), [true, false])
        XCTAssertEqual(mapped.activeFilterCount, 2)
        XCTAssertTrue(mapped.hasMore && mapped.loadingMore && mapped.refreshing)
        XCTAssertTrue(mapped.canCreate && mapped.canUpload && mapped.creating)
        XCTAssertEqual(mapped.writeFailure, Failed(kind: nil))
    }

    @MainActor
    func testCollectionMapsAFailureAndTheInitialState() {
        let failed = SharedSDK.CollectionState(
            phase: .error, failure: .unauthorized, header: nil, search: "", quickFilters: [], selectedQuickFilter: nil,
            sorts: [], selectedSort: nil, descending: false, layouts: [.list], layout: .list, sections: [],
            filterSheet: nil, activeFilterCount: 0, hasMore: false, loadingMore: false, refreshing: false,
            canCreate: false, canUpload: false, creating: false, writeFailure: nil
        )
        let mapped = SharedCollectionScreenModel.state(failed)
        XCTAssertEqual(mapped, CollectionState(phase: .error, failure: .unauthorized))
    }

    @MainActor
    func testCollectionMapsEverySectionKind() {
        let kinds: [(SharedSDK.SectionKind, CoreKit.SectionKind)] = [
            (.none, CoreKit.SectionKind.none), (.option, .option), (.day, .day), (.month, .month), (.letter, .letter),
            (.past, .past), (.noValue, .noValue)
        ]
        for (kotlin, native) in kinds {
            let section = SharedSDK.CollectionSection(kind: kotlin, key: "k", label: "l", color: nil, rows: [])
            XCTAssertEqual(SharedCollectionScreenModel.section(section).kind, native)
        }
    }

    // MARK: - Collection actions and effects
    @MainActor
    func testCollectionMapsEachAction() {
        let action = SharedCollectionScreenModel.action
        XCTAssertEqual(action(.retry) as? NSObject, SharedSDK.CollectionActionRetry.shared)
        XCTAssertEqual(action(.refresh) as? NSObject, SharedSDK.CollectionActionRefresh.shared)
        XCTAssertEqual(action(.search("web")) as? NSObject, SharedSDK.CollectionActionSearch(text: "web"))
        XCTAssertEqual(action(.selectQuickFilter("all")) as? NSObject, SharedSDK.CollectionActionSelectQuickFilter(key: "all"))
        XCTAssertEqual(action(.selectSort(.title)) as? NSObject, SharedSDK.CollectionActionSelectSort(axis: .title))
        XCTAssertEqual(action(.selectLayout(.gallery)) as? NSObject, SharedSDK.CollectionActionSelectLayout(layout: .gallery))
        XCTAssertEqual(action(.loadMore) as? NSObject, SharedSDK.CollectionActionLoadMore.shared)
        XCTAssertEqual(action(.openItem(id: "p1")) as? NSObject, SharedSDK.CollectionActionOpenItem(id: "p1"))
        XCTAssertEqual(action(.dismissWriteFailure) as? NSObject, SharedSDK.CollectionActionDismissWriteFailure.shared)
        XCTAssertEqual(action(.filter(.open)) as? NSObject, SharedSDK.CollectionActionFilterOpen.shared)
        XCTAssertEqual(action(.filter(.close)) as? NSObject, SharedSDK.CollectionActionFilterClose.shared)
        XCTAssertEqual(
            action(.filter(.toggle(propertyKey: "status", value: "done"))) as? NSObject,
            SharedSDK.CollectionActionFilterToggle(propertyKey: "status", value: "done")
        )
        XCTAssertEqual(
            action(.filter(.toggleDate(propertyKey: "date", preset: "today"))) as? NSObject,
            SharedSDK.CollectionActionFilterToggleDate(propertyKey: "date", preset: "today")
        )
        XCTAssertEqual(action(.filter(.clear(propertyKey: "status"))) as? NSObject, SharedSDK.CollectionActionFilterClear(propertyKey: "status"))
        XCTAssertEqual(action(.filter(.clearAll)) as? NSObject, SharedSDK.CollectionActionFilterClearAll.shared)
        XCTAssertEqual(action(.write(.create(title: "New"))) as? NSObject, SharedSDK.CollectionActionWriteCreate(title: "New"))
        XCTAssertEqual(
            action(.write(.upload(filename: "a.pdf", mimeType: "application/pdf", base64: "AQ=="))) as? NSObject,
            SharedSDK.CollectionActionWriteUpload(filename: "a.pdf", mimeType: "application/pdf", base64: "AQ==")
        )
    }

    @MainActor
    func testCollectionMapsTheEffect() {
        XCTAssertEqual(
            SharedCollectionScreenModel.effect(SharedSDK.CollectionEffectOpenItem(itemId: "p1", databaseKey: "projects")),
            .openItem(itemId: "p1", databaseKey: "projects")
        )
        XCTAssertEqual(
            SharedCollectionScreenModel.effect(SharedSDK.CollectionEffectOpenItem(itemId: "p1", databaseKey: nil)),
            .openItem(itemId: "p1", databaseKey: nil)
        )
    }

    @MainActor
    func testCollectionMapsEachTarget() {
        let target = SharedCollectionScreenModel.target
        XCTAssertEqual(
            target(.whole(databaseKey: "projects", databaseId: nil)) as? NSObject,
            SharedSDK.CollectionTargetWhole(databaseKey: "projects", databaseId: nil)
        )
        XCTAssertEqual(
            target(.ofArea(databaseKey: "projects", areaId: "a1")) as? NSObject,
            SharedSDK.CollectionTargetOfArea(databaseKey: "projects", areaId: "a1")
        )
        XCTAssertEqual(
            target(.ofItem(databaseKey: "files", relationKey: "projects", itemId: "p1")) as? NSObject,
            SharedSDK.CollectionTargetOfItem(databaseKey: "files", relationKey: "projects", itemId: "p1")
        )
        XCTAssertEqual(
            target(.matching(databaseKey: nil, databaseId: "db", filterJson: "{}")) as? NSObject,
            SharedSDK.CollectionTargetMatching(databaseKey: nil, databaseId: "db", filterJson: "{}")
        )
    }

    // MARK: - Shared fields
    func testFieldKindMapsEveryKind() {
        let kinds: [(SharedSDK.FieldKind, CoreKit.FieldKind)] = [
            (.text, .text), (.longText, .longText), (.number, .number), (.select, .select), (.multiSelect, .multiSelect),
            (.date, .date), (.time, .time), (.checkbox, .checkbox), (.relation, .relation), (.file, .file), (.url, .url)
        ]
        for (kotlin, native) in kinds {
            XCTAssertEqual(CoreKit.FieldKind(kotlin), native)
        }
    }

    func testFieldContentMapsEveryContent() {
        let option = SharedSDK.OptionView(key: "a", label: "A", color: nil)
        let target = SharedSDK.TargetView(id: "t", databaseKey: "areas", title: "Work", color: "#5856D6")
        XCTAssertEqual(CoreKit.FieldContent(SharedSDK.FieldContentEmpty.shared), .empty)
        XCTAssertEqual(CoreKit.FieldContent(SharedSDK.FieldContentText(text: "x")), .text("x"))
        XCTAssertEqual(CoreKit.FieldContent(SharedSDK.FieldContentNumber(number: 1.5)), .number(1.5))
        XCTAssertEqual(CoreKit.FieldContent(SharedSDK.FieldContentFlag(on: true)), .flag(true))
        XCTAssertEqual(CoreKit.FieldContent(SharedSDK.FieldContentDay(iso: "2026-10-16")), .day("2026-10-16"))
        XCTAssertEqual(CoreKit.FieldContent(SharedSDK.FieldContentClock(time: "14:00")), .clock("14:00"))
        XCTAssertEqual(CoreKit.FieldContent(SharedSDK.FieldContentLink(url: "https://a.cz")), .link("https://a.cz"))
        XCTAssertEqual(
            CoreKit.FieldContent(SharedSDK.FieldContentChoices(options: [option])),
            .choices([FieldOption(key: "a", label: "A", color: nil)])
        )
        XCTAssertEqual(
            CoreKit.FieldContent(SharedSDK.FieldContentTargets(targets: [target])),
            .targets([FieldTarget(id: "t", databaseKey: "areas", title: "Work", color: "#5856D6")])
        )
        XCTAssertEqual(
            CoreKit.FieldContent(SharedSDK.FieldContentBlob(blobId: "b", filename: "a.pdf", mimeType: "application/pdf", byteSize: 2048)),
            .blob(blobId: "b", filename: "a.pdf", mimeType: "application/pdf", byteSize: 2048)
        )
    }

    func testFieldViewMapsItsOriginForEachKindOfValue() {
        func view(_ origin: SharedSDK.OriginView?) -> CoreKit.FieldView {
            CoreKit.FieldView(
                SharedSDK.FieldView(
                    propertyKey: "status", name: "Status", kind: .select, content: SharedSDK.FieldContentEmpty.shared,
                    options: [], editable: true, origin: origin
                )
            )
        }
        let source = SharedSDK.OriginSourceView(itemId: "t1", databaseKey: "tasks", title: "Send invoice")
        XCTAssertNil(view(nil).origin)
        let inherited = view(SharedSDK.OriginView(kind: .inherited, sources: [source], brokenBy: nil)).origin
        XCTAssertEqual(
            inherited,
            ValueOrigin(kind: .inherited, sources: [OriginSource(itemId: "t1", databaseKey: "tasks", title: "Send invoice")], brokenBy: nil)
        )
        XCTAssertEqual(view(SharedSDK.OriginView(kind: .inheritedBroken, sources: [], brokenBy: .user)).origin?.kind, .inheritedBroken)
        XCTAssertEqual(view(SharedSDK.OriginView(kind: .inheritedBroken, sources: [], brokenBy: .user)).origin?.brokenBy, .user)
        XCTAssertEqual(view(SharedSDK.OriginView(kind: .derived, sources: [], brokenBy: .agent)).origin?.kind, .derived)
        XCTAssertEqual(view(SharedSDK.OriginView(kind: .derived, sources: [], brokenBy: .agent)).origin?.brokenBy, .agent)
        XCTAssertEqual(view(nil).propertyKey, "status")
        XCTAssertTrue(view(nil).editable)
    }

    func testFailedKeepsAnUnexpectedFailureApartFromAnExpectedOne() {
        XCTAssertEqual(Failed(SharedSDK.Failed(kind: .notFound)), Failed(kind: .notFound))
        XCTAssertEqual(Failed(SharedSDK.Failed(kind: nil)), Failed(kind: nil))
    }
}
