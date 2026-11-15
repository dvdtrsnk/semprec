import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the item bridge's state mapping with Kotlin values built here.
final class SharedItemMappingTests: XCTestCase {

    // MARK: - Enums
    @MainActor
    func testItemMapsEveryPhase() {
        XCTAssertEqual(SharedItemScreenModel.phase(.loading), .loading)
        XCTAssertEqual(SharedItemScreenModel.phase(.content), .content)
        XCTAssertEqual(SharedItemScreenModel.phase(.error), .error)
    }

    @MainActor
    func testItemMapsEveryPageAndPreviewStatus() {
        let pages: [(SharedSDK.PageStatus, CoreKit.PageStatus)] =
            [(.loading, .loading), (.ready, .ready), (.saving, .saving), (.conflict, .conflict), (.error, .error)]
        for (kotlin, native) in pages {
            let page = SharedSDK.PageView(status: kotlin, markdown: "m", failure: .invalidData)
            let mapped = SharedItemScreenModel.page(page)
            XCTAssertEqual(mapped, PageView(status: native, markdown: "m", failure: .invalidData))
        }
        let previews: [(SharedSDK.PreviewStatus, CoreKit.PreviewStatus)] =
            [(.loading, .loading), (.ready, .ready), (.error, .error)]
        for (kotlin, native) in previews {
            let preview = SharedSDK.PreviewView(
                blobId: "b", filename: nil, mimeType: "a/b", status: kotlin, base64: nil, failure: .notFound
            )
            let mapped = SharedItemScreenModel.preview(preview)
            XCTAssertEqual(mapped.status, native)
            XCTAssertEqual(mapped.failure, .notFound)
            XCTAssertNil(mapped.filename)
        }
    }

    // MARK: - State
    @MainActor
    func testItemMapsTheHeaderTheFieldsAndTheRelatedCollections() {
        let mapped = SharedItemScreenModel.state(fullState())
        XCTAssertEqual(mapped.phase, .content)
        XCTAssertEqual(mapped.header?.title, "Semprec")
        XCTAssertEqual(mapped.header?.databaseKey, "projects")
        XCTAssertEqual(mapped.fields.map(\.propertyKey), ["status"])
        XCTAssertEqual(mapped.fields.first?.editable, false)
        XCTAssertEqual(
            mapped.related,
            [RelatedView(databaseId: "f", databaseKey: "files", name: "Files", icon: "doc", color: nil, count: 3)]
        )
        XCTAssertEqual(mapped.page, PageView(status: .ready, markdown: "# Notes", failure: nil))
        XCTAssertTrue(mapped.saving)
        XCTAssertTrue(mapped.deleted)
        XCTAssertEqual(mapped.writeFailure, ItemWriteFailure(propertyKey: "status", kind: .rejected))
    }

    @MainActor
    func testItemMapsThePreviewThePickerAndTheDeletion() {
        let mapped = SharedItemScreenModel.state(fullState())
        XCTAssertEqual(
            mapped.preview,
            PreviewView(
                blobId: "b",
                filename: "a.pdf",
                mimeType: "application/pdf",
                status: .ready,
                base64: "AQ==",
                failure: nil
            )
        )
        XCTAssertEqual(mapped.picker?.failure, Failed(kind: nil))
        let work = FieldTarget(id: "a1", databaseKey: "areas", title: "Work", color: nil)
        XCTAssertEqual(mapped.picker?.candidates, [work])
        let impact = ImpactView(
            related: [ImpactEntry(databaseKey: "files", count: 3)],
            nestedItems: 2,
            nestedPages: 1,
            takenOverValues: 4,
            seriesInstances: 5,
            attachments: 6,
            hostEvents: 7
        )
        XCTAssertEqual(mapped.deletion, DeletionView(loading: false, failure: nil, impact: impact, deleting: true))
    }

    @MainActor
    func testItemMapsAFailureAndAnUnexpectedWriteFailure() {
        let state = SharedSDK.ItemState(
            phase: .error,
            failure: .notFound,
            header: nil,
            fields: [],
            related: [],
            page: SharedSDK.PageView(status: .loading, markdown: "", failure: nil),
            preview: nil,
            picker: nil,
            deletion: nil,
            saving: false,
            writeFailure: SharedSDK.ItemWriteFailure(propertyKey: nil, kind: nil),
            deleted: false
        )
        let mapped = SharedItemScreenModel.state(state)
        XCTAssertEqual(mapped.phase, .error)
        XCTAssertEqual(mapped.failure, .notFound)
        XCTAssertEqual(mapped.writeFailure, ItemWriteFailure(propertyKey: nil, kind: nil))
        XCTAssertEqual(mapped.page.status, .loading)
    }

    // MARK: - Effects
    @MainActor
    func testItemMapsEachEffect() {
        let effect = SharedItemScreenModel.effect
        XCTAssertEqual(
            effect(SharedSDK.ItemEffectOpenItem(itemId: "a", databaseKey: nil)),
            .openItem(itemId: "a", databaseKey: nil)
        )
        let filtered = SharedSDK.ItemEffectOpenCollection(databaseId: "f", databaseKey: "files", filterJson: "{}")
        XCTAssertEqual(effect(filtered), .openCollection(databaseId: "f", databaseKey: "files", filterJson: "{}"))
        let bare = SharedSDK.ItemEffectOpenCollection(databaseId: "f", databaseKey: nil, filterJson: nil)
        XCTAssertEqual(effect(bare), .openCollection(databaseId: "f", databaseKey: nil, filterJson: nil))
        XCTAssertEqual(effect(SharedSDK.ItemEffectClose.shared), .close)
    }
}

// MARK: - Helpers
private extension SharedItemMappingTests {

    func fullState() -> SharedSDK.ItemState {
        let option = SharedSDK.OptionView(key: "done", label: "Done", color: nil)
        let field = SharedSDK.FieldView(
            propertyKey: "status",
            name: "Status",
            kind: .select,
            content: SharedSDK.FieldContentChoices(options: [option]),
            options: [option],
            editable: false,
            origin: nil
        )
        return SharedSDK.ItemState(
            phase: .content,
            failure: nil,
            header: SharedSDK.ItemHeader(
                itemId: "p1",
                databaseId: "db",
                databaseKey: "projects",
                databaseName: "Projects",
                icon: "folder",
                color: "#AF52DE",
                title: "Semprec"
            ),
            fields: [field],
            related: [
                SharedSDK.RelatedView(
                    databaseId: "f", databaseKey: "files", name: "Files", icon: "doc", color: nil, count: 3
                )
            ],
            page: SharedSDK.PageView(status: .ready, markdown: "# Notes", failure: nil),
            preview: SharedSDK.PreviewView(
                blobId: "b",
                filename: "a.pdf",
                mimeType: "application/pdf",
                status: .ready,
                base64: "AQ==",
                failure: nil
            ),
            picker: SharedSDK.PickerView(
                propertyKey: "area",
                name: "Area",
                loading: false,
                failure: SharedSDK.Failed(kind: nil),
                candidates: [SharedSDK.TargetView(id: "a1", databaseKey: "areas", title: "Work", color: nil)]
            ),
            deletion: SharedSDK.DeletionView(loading: false, failure: nil, impact: impact(), deleting: true),
            saving: true,
            writeFailure: SharedSDK.ItemWriteFailure(propertyKey: "status", kind: .rejected),
            deleted: true
        )
    }

    func impact() -> SharedSDK.ImpactView {
        SharedSDK.ImpactView(
            related: [SharedSDK.ImpactEntry(databaseKey: "files", count: 3)],
            nestedItems: 2,
            nestedPages: 1,
            takenOverValues: 4,
            seriesInstances: 5,
            attachments: 6,
            hostEvents: 7
        )
    }
}
