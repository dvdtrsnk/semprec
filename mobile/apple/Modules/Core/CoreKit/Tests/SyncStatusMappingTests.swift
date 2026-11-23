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

    func testTheRealViewModelRelaysItsStateThroughTheStream() async throws {
        let model = try XCTUnwrap(isolatedFactory().makeSyncStatus() as? Model)
        let state = await firstState(of: model) { _ in true }
        XCTAssertEqual(state, SyncStatusState(offline: false, waiting: 0, failed: 0))
    }
}

// MARK: - Helpers
// The helper waits with a timeout and then cancels its task, so a stream that ignores cancellation fails the test
// instead of hanging it.
private extension SyncStatusMappingTests {

    func firstState<Model: ScreenModel>(
        of model: Model,
        timeout: TimeInterval = 5,
        until predicate: @escaping @Sendable (Model.State) -> Bool
    ) async -> Model.State? {
        let found = Received<Model.State>()
        let matched = XCTestExpectation(description: "A matching state arrived")
        let observer = Task { @MainActor in
            for await state in model.states() where predicate(state) {
                found.values.append(state)
                matched.fulfill()
                return
            }
        }
        _ = await XCTWaiter.fulfillment(of: [matched], timeout: timeout)
        observer.cancel()
        return found.values.first
    }
}

/// Values a test task received on the main actor.
@MainActor
private final class Received<Value> {

    // MARK: - Properties
    var values: [Value] = []
}
