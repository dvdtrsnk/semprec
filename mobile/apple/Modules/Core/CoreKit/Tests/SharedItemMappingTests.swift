import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the item bridge's mappings with Kotlin values built here.
final class SharedItemMappingTests: XCTestCase {

    // MARK: - State
    @MainActor
    func testItemMapsEveryPhase() {
        XCTAssertEqual(SharedItemScreenModel.phase(.loading), .loading)
        XCTAssertEqual(SharedItemScreenModel.phase(.content), .content)
        XCTAssertEqual(SharedItemScreenModel.phase(.error), .error)
    }

    @MainActor
    func testItemMapsAFullState() {
        let state = SharedSDK.ItemState(
            phase: .content,
            failure: nil,
            header: SharedSDK.ItemHeader(
                itemId: "p1", databaseId: "db", databaseKey: "projects", databaseName: "Projects", icon: "folder",
                color: "#AF52DE", title: "Semprec"
            ),
            fields: [
                SharedSDK.FieldView(
                    propertyKey: "status", name: "Status", kind: .select,
                    content: SharedSDK.FieldContentChoices(options: [SharedSDK.OptionView(key: "done", label: "Done", color: nil)]),
                    options: [SharedSDK.OptionView(key: "done", label: "Done", color: nil)], editable: false, origin: nil
                )
            ],
            related: [SharedSDK.RelatedView(databaseId: "f", databaseKey: "files", name: "Files", icon: "doc", color: nil, count: 3)],
            page: SharedSDK.PageView(status: .ready, markdown: "# Notes", failure: nil),
            preview: SharedSDK.PreviewView(
                blobId: "b", filename: "a.pdf", mimeType: "application/pdf", status: .ready, base64: "AQ==", failure: nil
            ),
            picker: SharedSDK.PickerView(
                propertyKey: "area", name: "Area", loading: false, failure: SharedSDK.Failed(kind: nil),
                candidates: [SharedSDK.TargetView(id: "a1", databaseKey: "areas", title: "Work", color: nil)]
            ),
            deletion: SharedSDK.DeletionView(
                loading: false, failure: nil,
                impact: SharedSDK.ImpactView(
                    related: [SharedSDK.ImpactEntry(databaseKey: "files", count: 3)], nestedItems: 2, nestedPages: 1,
                    takenOverValues: 4, seriesInstances: 5, attachments: 6, hostEvents: 7
                ),
                deleting: true
            ),
            saving: true,
            writeFailure: SharedSDK.ItemWriteFailure(propertyKey: "status", kind: .rejected),
            deleted: true
        )
        let mapped = SharedItemScreenModel.state(state)
        XCTAssertEqual(mapped.phase, .content)
        XCTAssertEqual(mapped.header?.title, "Semprec")
        XCTAssertEqual(mapped.header?.databaseKey, "projects")
        XCTAssertEqual(mapped.fields.map(\.propertyKey), ["status"])
        XCTAssertEqual(mapped.fields.first?.editable, false)
        XCTAssertEqual(mapped.related, [RelatedView(databaseId: "f", databaseKey: "files", name: "Files", icon: "doc", color: nil, count: 3)])
        XCTAssertEqual(mapped.page, PageView(status: .ready, markdown: "# Notes", failure: nil))
        XCTAssertEqual(
            mapped.preview,
            PreviewView(blobId: "b", filename: "a.pdf", mimeType: "application/pdf", status: .ready, base64: "AQ==", failure: nil)
        )
        XCTAssertEqual(mapped.picker?.failure, Failed(kind: nil))
        XCTAssertEqual(mapped.picker?.candidates, [FieldTarget(id: "a1", databaseKey: "areas", title: "Work", color: nil)])
        XCTAssertEqual(
            mapped.deletion,
            DeletionView(
                loading: false, failure: nil,
                impact: ImpactView(
                    related: [ImpactEntry(databaseKey: "files", count: 3)], nestedItems: 2, nestedPages: 1,
                    takenOverValues: 4, seriesInstances: 5, attachments: 6, hostEvents: 7
                ),
                deleting: true
            )
        )
        XCTAssertTrue(mapped.saving)
        XCTAssertEqual(mapped.writeFailure, ItemWriteFailure(propertyKey: "status", kind: .rejected))
        XCTAssertTrue(mapped.deleted)
    }

    @MainActor
    func testItemMapsAFailureAndAnUnexpectedWriteFailure() {
        let state = SharedSDK.ItemState(
            phase: .error, failure: .notFound, header: nil, fields: [], related: [],
            page: SharedSDK.PageView(status: .loading, markdown: "", failure: nil), preview: nil, picker: nil,
            deletion: nil, saving: false, writeFailure: SharedSDK.ItemWriteFailure(propertyKey: nil, kind: nil), deleted: false
        )
        let mapped = SharedItemScreenModel.state(state)
        XCTAssertEqual(mapped.phase, .error)
        XCTAssertEqual(mapped.failure, .notFound)
        XCTAssertEqual(mapped.writeFailure, ItemWriteFailure(propertyKey: nil, kind: nil))
        XCTAssertEqual(mapped.page.status, .loading)
    }

    @MainActor
    func testItemMapsEveryPageAndPreviewStatus() {
        let pages: [(SharedSDK.PageStatus, CoreKit.PageStatus)] =
            [(.loading, .loading), (.ready, .ready), (.saving, .saving), (.conflict, .conflict), (.error, .error)]
        for (kotlin, native) in pages {
            let page = SharedSDK.PageView(status: kotlin, markdown: "m", failure: .invalidData)
            XCTAssertEqual(SharedItemScreenModel.page(page), PageView(status: native, markdown: "m", failure: .invalidData))
        }
        let previews: [(SharedSDK.PreviewStatus, CoreKit.PreviewStatus)] = [(.loading, .loading), (.ready, .ready), (.error, .error)]
        for (kotlin, native) in previews {
            let preview = SharedSDK.PreviewView(blobId: "b", filename: nil, mimeType: "a/b", status: kotlin, base64: nil, failure: .notFound)
            let mapped = SharedItemScreenModel.preview(preview)
            XCTAssertEqual(mapped.status, native)
            XCTAssertEqual(mapped.failure, .notFound)
            XCTAssertNil(mapped.filename)
        }
    }

    // MARK: - Actions
    @MainActor
    func testItemMapsTheTopLevelActions() {
        let action = SharedItemScreenModel.action
        XCTAssertEqual(action(.retry) as? NSObject, SharedSDK.ItemActionRetry.shared)
        XCTAssertEqual(action(.refresh) as? NSObject, SharedSDK.ItemActionRefresh.shared)
        XCTAssertEqual(action(.dismissWriteFailure) as? NSObject, SharedSDK.ItemActionDismissWriteFailure.shared)
    }

    @MainActor
    func testItemMapsEachEditAction() {
        let action = { SharedItemScreenModel.action(.edit($0)) as? NSObject }
        XCTAssertEqual(action(.rename("New")), SharedSDK.ItemActionEditRename(title: "New"))
        XCTAssertEqual(action(.setText(propertyKey: "note", text: "x")), SharedSDK.ItemActionEditSetText(propertyKey: "note", text: "x"))
        XCTAssertEqual(
            action(.setNumber(propertyKey: "budget", number: 5.5)),
            SharedSDK.ItemActionEditSetNumber(propertyKey: "budget", number: KotlinDouble(double: 5.5))
        )
        XCTAssertEqual(
            action(.setNumber(propertyKey: "budget", number: nil)),
            SharedSDK.ItemActionEditSetNumber(propertyKey: "budget", number: nil)
        )
        XCTAssertEqual(action(.setFlag(propertyKey: "pinned", on: true)), SharedSDK.ItemActionEditSetFlag(propertyKey: "pinned", on: true))
        XCTAssertEqual(
            action(.setChoices(propertyKey: "status", keys: ["done"])),
            SharedSDK.ItemActionEditSetChoices(propertyKey: "status", keys: ["done"])
        )
        XCTAssertEqual(action(.unlink(propertyKey: "status")), SharedSDK.ItemActionEditUnlink(propertyKey: "status"))
        XCTAssertEqual(action(.relink(propertyKey: "status")), SharedSDK.ItemActionEditRelink(propertyKey: "status"))
        XCTAssertEqual(
            action(.removeTarget(propertyKey: "people", targetId: "x")),
            SharedSDK.ItemActionEditRemoveTarget(propertyKey: "people", targetId: "x")
        )
    }

    @MainActor
    func testItemMapsEachSideAction() {
        let action = SharedItemScreenModel.action
        XCTAssertEqual(action(.picker(.open(propertyKey: "area"))) as? NSObject, SharedSDK.ItemActionPickerOpen(propertyKey: "area"))
        XCTAssertEqual(action(.picker(.search("wo"))) as? NSObject, SharedSDK.ItemActionPickerSearch(text: "wo"))
        XCTAssertEqual(action(.picker(.choose(targetId: "a"))) as? NSObject, SharedSDK.ItemActionPickerChoose(targetId: "a"))
        XCTAssertEqual(action(.picker(.close)) as? NSObject, SharedSDK.ItemActionPickerClose.shared)
        XCTAssertEqual(action(.page(.save("# New"))) as? NSObject, SharedSDK.ItemActionPageSave(markdown: "# New"))
        XCTAssertEqual(action(.page(.reload)) as? NSObject, SharedSDK.ItemActionPageReload.shared)
        XCTAssertEqual(action(.preview(.load(propertyKey: "file"))) as? NSObject, SharedSDK.ItemActionPreviewLoad(propertyKey: "file"))
        XCTAssertEqual(action(.preview(.close)) as? NSObject, SharedSDK.ItemActionPreviewClose.shared)
        XCTAssertEqual(action(.deletion(.request)) as? NSObject, SharedSDK.ItemActionDeletionRequest.shared)
        XCTAssertEqual(action(.deletion(.cancel)) as? NSObject, SharedSDK.ItemActionDeletionCancel.shared)
        XCTAssertEqual(action(.deletion(.confirm)) as? NSObject, SharedSDK.ItemActionDeletionConfirm.shared)
        XCTAssertEqual(
            action(.navigate(.openRelated(databaseId: "f"))) as? NSObject,
            SharedSDK.ItemActionNavigateOpenRelated(databaseId: "f")
        )
        XCTAssertEqual(
            action(.navigate(.openTarget(id: "a", databaseKey: "areas"))) as? NSObject,
            SharedSDK.ItemActionNavigateOpenTarget(id: "a", databaseKey: "areas")
        )
    }

    // MARK: - Effects
    @MainActor
    func testItemMapsEachEffect() {
        XCTAssertEqual(
            SharedItemScreenModel.effect(SharedSDK.ItemEffectOpenItem(itemId: "a", databaseKey: nil)),
            .openItem(itemId: "a", databaseKey: nil)
        )
        XCTAssertEqual(
            SharedItemScreenModel.effect(SharedSDK.ItemEffectOpenCollection(databaseId: "f", databaseKey: "files", filterJson: "{}")),
            .openCollection(databaseId: "f", databaseKey: "files", filterJson: "{}")
        )
        XCTAssertEqual(
            SharedItemScreenModel.effect(SharedSDK.ItemEffectOpenCollection(databaseId: "f", databaseKey: nil, filterJson: nil)),
            .openCollection(databaseId: "f", databaseKey: nil, filterJson: nil)
        )
        XCTAssertEqual(SharedItemScreenModel.effect(SharedSDK.ItemEffectClose.shared), .close)
    }
}
