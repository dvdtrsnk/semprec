import SharedSDK
import XCTest

@testable import CoreKit

/// Checks the item bridge's actions, which are grouped as the Kotlin ones are.
final class SharedItemActionMappingTests: XCTestCase {

    // MARK: - Tests
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
        XCTAssertEqual(
            action(.setText(propertyKey: "note", text: "x")),
            SharedSDK.ItemActionEditSetText(propertyKey: "note", text: "x")
        )
        XCTAssertEqual(
            action(.setNumber(propertyKey: "budget", number: 5.5)),
            SharedSDK.ItemActionEditSetNumber(propertyKey: "budget", number: KotlinDouble(double: 5.5))
        )
        XCTAssertEqual(
            action(.setNumber(propertyKey: "budget", number: nil)),
            SharedSDK.ItemActionEditSetNumber(propertyKey: "budget", number: nil)
        )
        XCTAssertEqual(
            action(.setFlag(propertyKey: "pinned", isOn: true)),
            SharedSDK.ItemActionEditSetFlag(propertyKey: "pinned", on: true)
        )
        XCTAssertEqual(
            action(.setChoices(propertyKey: "status", keys: ["done"])),
            SharedSDK.ItemActionEditSetChoices(propertyKey: "status", keys: ["done"])
        )
        XCTAssertEqual(
            action(.addChoice(propertyKey: "tags", label: "Client")),
            SharedSDK.ItemActionEditAddChoice(propertyKey: "tags", label: "Client")
        )
        XCTAssertEqual(
            action(.renameChoice(propertyKey: "tags", key: "client", label: "Customer")),
            SharedSDK.ItemActionEditRenameChoice(propertyKey: "tags", key: "client", label: "Customer")
        )
        XCTAssertEqual(
            action(.recolorChoice(propertyKey: "tags", key: "client", color: "#34C759")),
            SharedSDK.ItemActionEditRecolorChoice(propertyKey: "tags", key: "client", color: "#34C759")
        )
        XCTAssertEqual(
            action(.removeChoice(propertyKey: "tags", key: "client")),
            SharedSDK.ItemActionEditRemoveChoice(propertyKey: "tags", key: "client")
        )
        XCTAssertEqual(action(.unlink(propertyKey: "status")), SharedSDK.ItemActionEditUnlink(propertyKey: "status"))
        XCTAssertEqual(action(.relink(propertyKey: "status")), SharedSDK.ItemActionEditRelink(propertyKey: "status"))
        XCTAssertEqual(
            action(.removeTarget(propertyKey: "people", targetId: "x")),
            SharedSDK.ItemActionEditRemoveTarget(propertyKey: "people", targetId: "x")
        )
    }

    @MainActor
    func testItemMapsEachPickerAndPageAction() {
        let action = SharedItemScreenModel.action
        XCTAssertEqual(
            action(.picker(.open(propertyKey: "company"))) as? NSObject,
            SharedSDK.ItemActionPickerOpen(propertyKey: "company")
        )
        XCTAssertEqual(action(.picker(.search("wo"))) as? NSObject, SharedSDK.ItemActionPickerSearch(text: "wo"))
        XCTAssertEqual(
            action(.picker(.choose(targetId: "a"))) as? NSObject,
            SharedSDK.ItemActionPickerChoose(targetId: "a")
        )
        XCTAssertEqual(action(.picker(.close)) as? NSObject, SharedSDK.ItemActionPickerClose.shared)
        XCTAssertEqual(action(.page(.save("# New"))) as? NSObject, SharedSDK.ItemActionPageSave(markdown: "# New"))
        XCTAssertEqual(action(.page(.reload)) as? NSObject, SharedSDK.ItemActionPageReload.shared)
    }

    @MainActor
    func testItemMapsEachPreviewDeletionAndNavigationAction() {
        let action = SharedItemScreenModel.action
        XCTAssertEqual(
            action(.preview(.load(propertyKey: "file"))) as? NSObject,
            SharedSDK.ItemActionPreviewLoad(propertyKey: "file")
        )
        XCTAssertEqual(action(.preview(.close)) as? NSObject, SharedSDK.ItemActionPreviewClose.shared)
        XCTAssertEqual(action(.deletion(.request)) as? NSObject, SharedSDK.ItemActionDeletionRequest.shared)
        XCTAssertEqual(action(.deletion(.cancel)) as? NSObject, SharedSDK.ItemActionDeletionCancel.shared)
        XCTAssertEqual(action(.deletion(.confirm)) as? NSObject, SharedSDK.ItemActionDeletionConfirm.shared)
        XCTAssertEqual(
            action(.navigate(.openRelated(databaseId: "f"))) as? NSObject,
            SharedSDK.ItemActionNavigateOpenRelated(databaseId: "f")
        )
        XCTAssertEqual(
            action(.navigate(.openTarget(id: "a", databaseKey: "companies"))) as? NSObject,
            SharedSDK.ItemActionNavigateOpenTarget(id: "a", databaseKey: "companies")
        )
    }
}
