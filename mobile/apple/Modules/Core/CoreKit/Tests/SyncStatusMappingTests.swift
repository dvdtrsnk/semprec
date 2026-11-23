import SharedSDK
import XCTest

@testable import CoreKit

/// Every branch of the sync status bridge, with the Kotlin values it maps, and the real ViewModel behind it.
@MainActor
final class SyncStatusMappingTests: XCTestCase {

    private typealias Model = SharedSyncStatusScreenModel

    func testTheStateMapsTheOfflineStateAndTheCounts() {
        XCTAssertEqual(
            Model.state(SharedSDK.SyncStatusState(offline: true, waiting: 3, failed: 2)),
            SyncStatusState(offline: true, waiting: 3, failed: 2)
        )
        XCTAssertEqual(
            Model.state(SharedSDK.SyncStatusState(offline: false, waiting: 0, failed: 0)),
            SyncStatusState(offline: false, waiting: 0, failed: 0)
        )
    }

    func testTheDismissalMapsToTheKotlinAction() {
        XCTAssertTrue(Model.action(.dismissFailures) is SharedSDK.SyncStatusActionDismissFailures)
    }

    func testTheRealViewModelWithoutADeviceStoreIsOnlineAndClosesWithItsBridge() throws {
        var model: Model? = try XCTUnwrap(isolatedFactory().makeSyncStatus() as? Model)
        XCTAssertEqual(model?.state, SyncStatusState(offline: false, waiting: 0, failed: 0))
        model?.send(.dismissFailures)
        let lease = try XCTUnwrap(model?.lease)
        XCTAssertFalse(lease.isClosed)
        model = nil
        XCTAssertTrue(lease.isClosed)
    }
}
