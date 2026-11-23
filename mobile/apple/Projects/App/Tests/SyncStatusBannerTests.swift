import CoreKit
import SwiftUI
import XCTest

@testable import Semprec

/// The banner above the tabs of a signed-in scene: what it shows for each state of the changes not on the server
/// yet, that it follows its model while shown, and that its dismissal reaches the model.
final class SyncStatusBannerTests: XCTestCase {

    // MARK: - Tests
    func testOnlineWithNoRefusedChangeTheBannerShowsNothing() {
        XCTAssertEqual(SyncStatusLine.lines(for: SyncStatusState(offline: false, waiting: 0, failed: 0)), [])
        XCTAssertEqual(
            SyncStatusLine.lines(for: SyncStatusState(offline: false, waiting: 2, failed: 0)),
            [],
            "Changes that wait while the scene is online are being sent, so nothing is shown"
        )
    }

    func testOfflineTheBannerShowsHowManyChangesWait() {
        XCTAssertEqual(
            SyncStatusLine.lines(for: SyncStatusState(offline: true, waiting: 0, failed: 0)),
            [.offline(waiting: 0)]
        )
        XCTAssertEqual(
            SyncStatusLine.lines(for: SyncStatusState(offline: true, waiting: 3, failed: 0)),
            [.offline(waiting: 3)]
        )
    }

    func testRefusedChangesShowBelowTheOfflineLineUntilDismissed() {
        XCTAssertEqual(
            SyncStatusLine.lines(for: SyncStatusState(offline: false, waiting: 0, failed: 2)),
            [.failed(count: 2)]
        )
        XCTAssertEqual(
            SyncStatusLine.lines(for: SyncStatusState(offline: true, waiting: 1, failed: 2)),
            [.offline(waiting: 1), .failed(count: 2)]
        )
    }

    @MainActor
    func testTheShownBannerFollowsItsModelAndForwardsTheDismissal() async throws {
        let model = ScriptedSyncStatusScreenModel(state: SyncStatusState(offline: true, waiting: 3, failed: 0))
        let viewModel = SyncStatusViewModel(model: model)
        let window = try SceneWindow()
        try await window.show(SyncStatusBanner(viewModel: viewModel))
        XCTAssertEqual(viewModel.state, SyncStatusState(offline: true, waiting: 3, failed: 0))

        model.publish(SyncStatusState(offline: false, waiting: 0, failed: 2))
        try await eventually { viewModel.state.failed == 2 }
        XCTAssertEqual(SyncStatusLine.lines(for: viewModel.state), [.failed(count: 2)])

        viewModel.dismissFailures()
        XCTAssertEqual(model.actions, [.dismissFailures])
        window.close()
    }
}
