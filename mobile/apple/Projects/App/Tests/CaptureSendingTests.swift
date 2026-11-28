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

        await sending.appBecameActive().value

        XCTAssertEqual(captures.sends, 1)
    }

    func testBecomingActiveAgainWhileTheSendRunsJoinsItAndAfterItEndsSendsAgain() async throws {
        let captures = CapturesDouble()
        captures.holdsSend = true
        let sending = CaptureSending(captures: captures)

        let first = sending.appBecameActive()
        let second = sending.appBecameActive()
        try await eventually { captures.sends == 1 }
        XCTAssertEqual(first, second)
        first.cancel()
        await first.value
        XCTAssertEqual(captures.sends, 1)

        captures.holdsSend = false
        await sending.appBecameActive().value
        XCTAssertEqual(captures.sends, 2)
    }
}
