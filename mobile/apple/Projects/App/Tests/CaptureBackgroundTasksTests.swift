#if os(iOS)
import BackgroundTasks
import XCTest

@testable import Semprec

/// The iOS background tasks of the waiting Inbox captures: when both are scheduled, and how a run of either ends, over
/// doubles of the bridge, the scheduler and the system's task. macOS has no `BGTaskScheduler`, so this file is iOS
/// only.
@MainActor
final class CaptureBackgroundTasksTests: XCTestCase {

    private let captures = CapturesDouble()
    private let scheduler = SchedulerDouble()

    // MARK: - Scheduling
    func testMovingToTheBackgroundWithCapturesWaitingSchedulesBothTasks() async throws {
        captures.waits = true

        await sending().appMovedToBackground()

        try assertBothScheduled()
    }

    func testMovingToTheBackgroundWithNothingWaitingSchedulesNothing() async {
        captures.waits = false

        await sending().appMovedToBackground()

        XCTAssertEqual(captures.waitChecks, 1)
        XCTAssertTrue(scheduler.requests.isEmpty)
    }

    func testACaptureAddedWhileCapturesWaitSchedulesBothTasks() async throws {
        captures.waits = true

        await sending().captureAdded()

        try assertBothScheduled()
    }

    func testACaptureAddedThatAlreadyReachedTheServerSchedulesNothing() async {
        captures.waits = false

        await sending().captureAdded()

        XCTAssertTrue(scheduler.requests.isEmpty)
    }

    func testARefusedRequestStillSubmitsTheOtherOne() async {
        captures.waits = true
        scheduler.refuses = [CaptureBackgroundTasks.sendIdentifier]

        await sending().appMovedToBackground()

        XCTAssertEqual(scheduler.requests.map(\.identifier), [
            CaptureBackgroundTasks.sendIdentifier,
            CaptureBackgroundTasks.refreshIdentifier
        ])
    }

    // MARK: - Running
    func testARunThatSendsEverythingCompletesWithSuccessAndSchedulesNothing() async {
        captures.sendAnswer = true
        let task = TaskDouble()

        await sending().backgroundTasks.run(task).value

        XCTAssertEqual(captures.sends, 1)
        XCTAssertEqual(task.completions, [true])
        XCTAssertTrue(scheduler.requests.isEmpty)
    }

    func testARunThatLeavesCapturesWaitingSchedulesBothAgainAndCompletesWithoutSuccess() async throws {
        captures.sendAnswer = false
        captures.waits = true
        let task = TaskDouble()

        await sending().backgroundTasks.run(task).value

        XCTAssertEqual(captures.sends, 1)
        XCTAssertEqual(task.completions, [false])
        try assertBothScheduled()
    }

    func testARunWithNobodySignedInCompletesWithSuccessAndSchedulesNothing() async {
        // The send confirms nothing and no capture of a person signed in waits: nothing could be sent later either.
        captures.sendAnswer = false
        captures.waits = false
        let task = TaskDouble()

        await sending().backgroundTasks.run(task).value

        XCTAssertEqual(task.completions, [true])
        XCTAssertTrue(scheduler.requests.isEmpty)
    }

    func testAnExpiredRunCancelsItsSendSchedulesAgainAndCompletesOnce() async throws {
        captures.holdsSend = true
        captures.waits = true
        let task = TaskDouble()
        let run = sending().backgroundTasks.run(task)
        try await eventually { self.captures.sends == 1 }
        let expire = try XCTUnwrap(task.expirationHandler)

        expire()
        await run.value
        try await eventually { !task.completions.isEmpty }

        XCTAssertTrue(captures.sendWasCancelled)
        XCTAssertEqual(task.completions, [false])
        try assertBothScheduled()
        await Task.yield()
        XCTAssertEqual(task.completions, [false], "The cancelled send does not complete the task a second time")
    }

    func testAnExpirationAfterTheRunCompletedDoesNotCompleteItAgain() async throws {
        captures.sendAnswer = true
        let task = TaskDouble()
        let run = sending().backgroundTasks.run(task)
        await run.value
        let expire = try XCTUnwrap(task.expirationHandler)

        expire()
        try await eventually { self.scheduler.requests.count == 2 }

        XCTAssertEqual(task.completions, [true])
    }

    // MARK: - Private
    private func sending() -> CaptureSending {
        let captures = captures
        return CaptureSending(makeCaptures: { captures }, scheduler: scheduler)
    }

    /// The processing task, which needs a network, and the app refresh were submitted, once each.
    private func assertBothScheduled(file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(scheduler.requests.count, 2, file: file, line: line)
        let send = try XCTUnwrap(scheduler.requests.first as? BGProcessingTaskRequest, file: file, line: line)
        XCTAssertEqual(send.identifier, CaptureBackgroundTasks.sendIdentifier, file: file, line: line)
        XCTAssertTrue(send.requiresNetworkConnectivity, file: file, line: line)
        let refresh = try XCTUnwrap(scheduler.requests.last as? BGAppRefreshTaskRequest, file: file, line: line)
        XCTAssertEqual(refresh.identifier, CaptureBackgroundTasks.refreshIdentifier, file: file, line: line)
    }
}

/// The system's scheduler: records every request submitted and refuses those whose identifier is in `refuses`.
private final class SchedulerDouble: CaptureTaskScheduler {

    // MARK: - Properties
    private(set) var requests: [BGTaskRequest] = []
    var refuses: Set<String> = []

    // MARK: - Methods
    func submit(_ taskRequest: BGTaskRequest) throws {
        requests.append(taskRequest)
        if refuses.contains(taskRequest.identifier) { throw BGTaskScheduler.Error(.unavailable) }
    }
}

/// A task the system runs: keeps the expiration handler it is given and records each completion.
private final class TaskDouble: CaptureBackgroundTask {

    // MARK: - Properties
    var expirationHandler: (() -> Void)?
    private(set) var completions: [Bool] = []

    // MARK: - Methods
    func setTaskCompleted(success: Bool) {
        completions.append(success)
    }
}
#endif
