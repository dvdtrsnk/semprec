import SharedSDK
import XCTest

@testable import CoreKit

/// Checks the collection bridge's actions, effects and targets, and the field values both bridges share.
final class SharedCollectionActionMappingTests: XCTestCase {

    // MARK: - Actions
    @MainActor
    func testCollectionMapsTheTopLevelActions() {
        let action = SharedCollectionScreenModel.action
        XCTAssertEqual(action(.retry) as? NSObject, SharedSDK.CollectionActionRetry.shared)
        XCTAssertEqual(action(.refresh) as? NSObject, SharedSDK.CollectionActionRefresh.shared)
        XCTAssertEqual(action(.search("web")) as? NSObject, SharedSDK.CollectionActionSearch(text: "web"))
        XCTAssertEqual(
            action(.selectQuickFilter("all")) as? NSObject,
            SharedSDK.CollectionActionSelectQuickFilter(key: "all")
        )
        XCTAssertEqual(action(.selectSort(.title)) as? NSObject, SharedSDK.CollectionActionSelectSort(axis: .title))
        XCTAssertEqual(
            action(.selectLayout(.gallery)) as? NSObject,
            SharedSDK.CollectionActionSelectLayout(layout: .gallery)
        )
        XCTAssertEqual(action(.loadMore) as? NSObject, SharedSDK.CollectionActionLoadMore.shared)
        XCTAssertEqual(action(.openItem(id: "p1")) as? NSObject, SharedSDK.CollectionActionOpenItem(id: "p1"))
        XCTAssertEqual(
            action(.dismissWriteFailure) as? NSObject,
            SharedSDK.CollectionActionDismissWriteFailure.shared
        )
    }

    @MainActor
    func testCollectionMapsEachFilterAction() {
        let action = { SharedCollectionScreenModel.action(.filter($0)) as? NSObject }
        XCTAssertEqual(action(.open), SharedSDK.CollectionActionFilterOpen.shared)
        XCTAssertEqual(action(.close), SharedSDK.CollectionActionFilterClose.shared)
        XCTAssertEqual(
            action(.toggle(propertyKey: "status", value: "done")),
            SharedSDK.CollectionActionFilterToggle(propertyKey: "status", value: "done")
        )
        XCTAssertEqual(
            action(.toggleDate(propertyKey: "date", preset: "today")),
            SharedSDK.CollectionActionFilterToggleDate(propertyKey: "date", preset: "today")
        )
        XCTAssertEqual(
            action(.clear(propertyKey: "status")),
            SharedSDK.CollectionActionFilterClear(propertyKey: "status")
        )
        XCTAssertEqual(action(.clearAll), SharedSDK.CollectionActionFilterClearAll.shared)
    }

    @MainActor
    func testCollectionMapsEachWriteAction() {
        let action = { SharedCollectionScreenModel.action(.write($0)) as? NSObject }
        XCTAssertEqual(action(.create(title: "New")), SharedSDK.CollectionActionWriteCreate(title: "New"))
        XCTAssertEqual(
            action(.upload(filename: "a.pdf", mimeType: "application/pdf", base64: "AQ==")),
            SharedSDK.CollectionActionWriteUpload(filename: "a.pdf", mimeType: "application/pdf", base64: "AQ==")
        )
    }

    // MARK: - Effects and targets
    @MainActor
    func testCollectionMapsTheEffect() {
        XCTAssertEqual(
            SharedCollectionScreenModel.effect(
                SharedSDK.CollectionEffectOpenItem(itemId: "p1", databaseKey: "projects")
            ),
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
            (.text, .text), (.longText, .longText), (.number, .number), (.select, .select),
            (.multiSelect, .multiSelect), (.date, .date), (.time, .time), (.checkbox, .checkbox),
            (.relation, .relation), (.file, .file), (.url, .url)
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
        let blob = SharedSDK.FieldContentBlob(
            blobId: "b", filename: "a.pdf", mimeType: "application/pdf", byteSize: 2_048
        )
        XCTAssertEqual(
            CoreKit.FieldContent(blob),
            .blob(blobId: "b", filename: "a.pdf", mimeType: "application/pdf", byteSize: 2_048)
        )
    }

    func testFieldViewMapsItsOriginForEachKindOfValue() {
        func view(_ origin: SharedSDK.OriginView?) -> CoreKit.FieldView {
            CoreKit.FieldView(
                SharedSDK.FieldView(
                    propertyKey: "status",
                    name: "Status",
                    kind: .select,
                    content: SharedSDK.FieldContentEmpty.shared,
                    options: [],
                    editable: true,
                    origin: origin
                )
            )
        }
        let source = SharedSDK.OriginSourceView(itemId: "t1", databaseKey: "tasks", title: "Send invoice")
        XCTAssertNil(view(nil).origin)
        XCTAssertEqual(
            view(SharedSDK.OriginView(kind: .inherited, sources: [source], brokenBy: nil)).origin,
            ValueOrigin(
                kind: .inherited,
                sources: [OriginSource(itemId: "t1", databaseKey: "tasks", title: "Send invoice")],
                brokenBy: nil
            )
        )
        let byUser = view(SharedSDK.OriginView(kind: .inheritedBroken, sources: [], brokenBy: .user)).origin
        XCTAssertEqual(byUser?.kind, .inheritedBroken)
        XCTAssertEqual(byUser?.brokenBy, .user)
        let byAgent = view(SharedSDK.OriginView(kind: .derived, sources: [], brokenBy: .agent)).origin
        XCTAssertEqual(byAgent?.kind, .derived)
        XCTAssertEqual(byAgent?.brokenBy, .agent)
        XCTAssertTrue(view(nil).editable)
        XCTAssertEqual(view(nil).propertyKey, "status")
    }

    func testFailedKeepsAnUnexpectedFailureApartFromAnExpectedOne() {
        XCTAssertEqual(Failed(SharedSDK.Failed(kind: .notFound)), Failed(kind: .notFound))
        XCTAssertEqual(Failed(SharedSDK.Failed(kind: nil)), Failed(kind: nil))
    }
}
