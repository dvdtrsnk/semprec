#if os(iOS)
import BackgroundTasks
import XCTest

@testable import Alldots

/// The iOS background tasks of the waiting Inbox captures: when both are scheduled, and how a run of either ends, over
/// doubles of the bridge, the scheduler and the system's task. macOS has no `BGTaskScheduler`, so this file is iOS
/// only.
@MainActor
final class CaptureBackgroundTasksTests: XCTestCase {

    private let captures = CapturesDouble()
    private let scheduler = SchedulerDouble()

    // MARK: - Scheduling
    func testMovingToTheBackgroundWithCapturesWaitingSchedulesBothTasks() async throws {
        captures.waits = .waiting

        await sending().appMovedToBackground().value

        try assertBothScheduled()
    }

    func testMovingToTheBackgroundWithNothingWaitingSchedulesNothing() async {
        captures.waits = .nothing

        await sending().appMovedToBackground().value

        XCTAssertEqual(captures.waitChecks, 1)
        XCTAssertTrue(scheduler.requests.isEmpty)
    }

    func testMovingToTheBackgroundWhenTheWaitingCapturesCannotBeCountedSchedulesBothTasks() async throws {
        captures.waits = .unknown

        await sending().appMovedToBackground().value

        try assertBothScheduled()
    }

    func testACaptureAddedWhileCapturesWaitSchedulesBothTasks() async throws {
        captures.waits = .waiting

        await sending().captureAdded()

        try assertBothScheduled()
    }

    func testACaptureAddedThatAlreadyReachedTheServerSchedulesNothing() async {
        captures.waits = .nothing

        await sending().captureAdded()

        XCTAssertTrue(scheduler.requests.isEmpty)
    }

    func testCapturesTheDiaryReportsTogetherShareOneCheck() async throws {
        captures.waits = .waiting
        let sending = sending()

        let first = sending.reportCaptureAdded()
        let second = sending.reportCaptureAdded()
        await first.value

        XCTAssertEqual(first, second)
        XCTAssertEqual(captures.waitChecks, 1)
        try assertBothScheduled()
    }

    func testACaptureTheDiaryReportsWhileACheckRunsChecksOnceMoreInTheSameTask() async {
        captures.waits = .waiting
        let sending = sending()
        var joined: Task<Void, Never>?
        captures.onWaitCheck = { if joined == nil { joined = sending.reportCaptureAdded() } }

        let check = sending.reportCaptureAdded()
        await check.value

        XCTAssertEqual(joined, check)
        XCTAssertEqual(captures.waitChecks, 2)
        XCTAssertEqual(scheduler.requests.count, 4)
        await sending.reportCaptureAdded().value
        XCTAssertEqual(captures.waitChecks, 3, "After the check ended, a report starts a new one")
    }

    func testAnIntentsCaptureIsScheduledBeforeItsBriefSend() async throws {
        captures.waits = .waiting
        var scheduledBeforeSend: Int?
        captures.onSend = { scheduledBeforeSend = self.scheduler.requests.count }

        await AddToInboxIntent.captureKept(captures, sending: sending())

        XCTAssertEqual(scheduledBeforeSend, 2)
        XCTAssertEqual(captures.sends, 1)
        try assertBothScheduled()
    }

    func testARefusedRequestStillSubmitsTheOtherOne() async {
        captures.waits = .waiting
        scheduler.refuses = [CaptureBackgroundTasks.sendIdentifier]

        await sending().appMovedToBackground().value

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
        captures.waits = .waiting
        let task = TaskDouble()

        await sending().backgroundTasks.run(task).value

        XCTAssertEqual(captures.sends, 1)
        XCTAssertEqual(task.completions, [false])
        try assertBothScheduled()
    }

    func testARunWhoseWaitingCapturesCannotBeCountedSchedulesBothAgainAndCompletesWithoutSuccess() async throws {
        captures.sendAnswer = false
        captures.waits = .unknown
        let task = TaskDouble()

        await sending().backgroundTasks.run(task).value

        XCTAssertEqual(task.completions, [false])
        try assertBothScheduled()
    }

    func testARunWithNobodySignedInCompletesWithSuccessAndSchedulesNothing() async {
        // The send confirms nothing and no capture of a person signed in waits: nothing could be sent later either.
        captures.sendAnswer = false
        captures.waits = .nothing
        let task = TaskDouble()

        await sending().backgroundTasks.run(task).value

        XCTAssertEqual(task.completions, [true])
        XCTAssertTrue(scheduler.requests.isEmpty)
    }

    func testAnExpiredRunCancelsItsSendSchedulesAgainAndCompletesOnce() async throws {
        captures.holdsSend = true
        captures.waits = .waiting
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
        CaptureSending(captures: captures, scheduler: scheduler)
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
