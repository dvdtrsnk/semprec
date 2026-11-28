import XCTest

@testable import Semprec

/// What the app does with the waiting Inbox captures when it becomes active, on iOS and macOS alike, over a double of
/// the bridge. The background tasks of iOS are checked in `CaptureBackgroundTasksTests`.
@MainActor
final class CaptureSendingTests: XCTestCase {

    func testBecomingActiveSendsTheWaitingCapturesThroughTheBridge() async {
        let captures = CapturesDouble()
        captures.waits = .waiting
        let sending = CaptureSending(captures: captures)

        await sending.appBecameActive()

        XCTAssertEqual(captures.sends, 1)
    }
}
