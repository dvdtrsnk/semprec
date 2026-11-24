import XCTest

@testable import Semprec

/// The debug tool of system alarms over a scripted scheduler: the permission, scheduling once, every day and a few
/// seconds ahead, each refusal the screen names, an unexpected refusal, and cancelling one or all alarms.
final class DebugAlarmViewModelTests: XCTestCase {

    // MARK: - Permission
    @MainActor
    func testThePermissionIsReadAtOnceAndUpdatedByTheRequest() async {
        let scheduler = SchedulerSpy(authorization: .notDetermined)
        scheduler.grantedAuthorization = .authorized
        let viewModel = DebugAlarmViewModel(scheduler: scheduler)
        XCTAssertEqual(viewModel.authorization, .notDetermined)

        await viewModel.requestAuthorization()

        XCTAssertEqual(viewModel.authorization, .authorized)
        XCTAssertEqual(scheduler.authorizationRequests, 1)
    }

    @MainActor
    func testAFailedPermissionRequestIsShownAndKeepsTheState() async {
        let scheduler = SchedulerSpy(authorization: .notDetermined)
        scheduler.requestFailure = ScriptedAlarmFailure()
        let viewModel = DebugAlarmViewModel(scheduler: scheduler)

        await viewModel.requestAuthorization()

        XCTAssertEqual(viewModel.authorization, .notDetermined)
        XCTAssertEqual(viewModel.failure, .unexpected(String(describing: ScriptedAlarmFailure())))
    }

    func testTheAppExplainsWhyItAsksForAlarms() {
        let description = Bundle.main.object(forInfoDictionaryKey: "NSAlarmKitUsageDescription") as? String
        XCTAssertFalse((description ?? "").isEmpty)
    }

    func testTheSystemSchedulerRingsAlarmsOnIosOnly() {
        #if os(iOS)
        XCTAssertTrue(SystemAlarmScheduler().isSupported)
        #else
        XCTAssertFalse(SystemAlarmScheduler().isSupported)
        XCTAssertEqual(SystemAlarmScheduler().authorization(), .unsupported)
        #endif
    }

    @MainActor
    func testAPlatformWithoutAlarmsIsUnsupported() {
        let viewModel = DebugAlarmViewModel(scheduler: SchedulerSpy(authorization: .unsupported))

        XCTAssertEqual(viewModel.authorization, .unsupported)
    }

    // MARK: - Scheduling
    @MainActor
    func testAnAlarmIsScheduledWithItsTitleAndListed() async {
        let scheduler = SchedulerSpy(authorization: .authorized)
        let viewModel = DebugAlarmViewModel(scheduler: scheduler)
        let date = Date(timeIntervalSinceReferenceDate: 1_000)

        await viewModel.schedule(title: "  Wake up  ", time: .once(date))

        XCTAssertEqual(scheduler.requests.map(\.title), ["Wake up"])
        XCTAssertEqual(scheduler.requests.map(\.schedule), [.once(date)])
        XCTAssertEqual(scheduler.requests.map(\.opensWakeGuard), [false])
        XCTAssertEqual(viewModel.alarms.map(\.time), [.once(date)])
        XCTAssertNil(viewModel.failure)
        XCTAssertFalse(viewModel.isScheduling)
    }

    @MainActor
    func testABlankTitleBecomesTheDefaultTitle() async {
        let scheduler = SchedulerSpy(authorization: .authorized)
        let viewModel = DebugAlarmViewModel(scheduler: scheduler)

        await viewModel.schedule(title: " ", time: .daily(hour: 6, minute: 30))

        XCTAssertEqual(scheduler.requests.map(\.title), [String(localized: "debug.alarm.defaultTitle")])
        XCTAssertEqual(scheduler.requests.map(\.schedule), [.daily(hour: 6, minute: 30)])
    }

    @MainActor
    func testAQuickTestRingsTheGivenSecondsFromNow() async {
        let scheduler = SchedulerSpy(authorization: .authorized)
        let start = Date(timeIntervalSinceReferenceDate: 5_000)
        let viewModel = DebugAlarmViewModel(scheduler: scheduler, now: { start })

        await viewModel.schedule(title: "Test", in: 10)

        XCTAssertEqual(scheduler.requests.map(\.schedule), [.once(start.addingTimeInterval(10))])
    }

    @MainActor
    func testTheAlarmsAreListedOnceByDateThenDailyByTime() async {
        let scheduler = SchedulerSpy(authorization: .authorized)
        let later = Date(timeIntervalSinceReferenceDate: 9_000)
        let sooner = Date(timeIntervalSinceReferenceDate: 3_000)
        scheduler.held = [
            ScheduledAlarm(id: UUID(), time: .daily(hour: 7, minute: 0), phase: .scheduled),
            ScheduledAlarm(id: UUID(), time: nil, phase: .countdown),
            ScheduledAlarm(id: UUID(), time: .once(later), phase: .scheduled),
            ScheduledAlarm(id: UUID(), time: .daily(hour: 6, minute: 0), phase: .scheduled),
            ScheduledAlarm(id: UUID(), time: .once(sooner), phase: .alerting)
        ]
        let viewModel = DebugAlarmViewModel(scheduler: scheduler)

        await viewModel.schedule(title: "x", time: .once(later.addingTimeInterval(1)))

        XCTAssertEqual(viewModel.alarms.map(\.time), [
            .once(sooner), .once(later), .once(later.addingTimeInterval(1)),
            .daily(hour: 6, minute: 0), .daily(hour: 7, minute: 0), nil
        ])
    }

    @MainActor
    func testEachRefusalTheAppNamesIsShown() async {
        let cases: [(AlarmSchedulingError, DebugAlarmFailure)] = [
            (.notAuthorized, .notAuthorized), (.limitReached, .limitReached), (.unsupported, .unsupported)
        ]
        for (error, failure) in cases {
            let scheduler = SchedulerSpy(authorization: .authorized)
            scheduler.scheduleFailure = error
            let viewModel = DebugAlarmViewModel(scheduler: scheduler)

            await viewModel.schedule(title: "x", time: .once(Date()))

            XCTAssertEqual(viewModel.failure, failure)
            XCTAssertTrue(viewModel.alarms.isEmpty)
            viewModel.dismissFailure()
            XCTAssertNil(viewModel.failure)
        }
    }

    @MainActor
    func testAnUnexpectedRefusalShowsTheSystemsDescription() async {
        let scheduler = SchedulerSpy(authorization: .authorized)
        scheduler.scheduleFailure = ScriptedAlarmFailure()
        let viewModel = DebugAlarmViewModel(scheduler: scheduler)

        await viewModel.schedule(title: "x", time: .once(Date()))

        XCTAssertEqual(viewModel.failure, .unexpected(String(describing: ScriptedAlarmFailure())))
    }

    @MainActor
    func testSchedulingReadsThePermissionAgain() async {
        let scheduler = SchedulerSpy(authorization: .notDetermined)
        scheduler.authorizationAfterSchedule = .authorized
        let viewModel = DebugAlarmViewModel(scheduler: scheduler)

        await viewModel.schedule(title: "x", time: .once(Date()))

        XCTAssertEqual(viewModel.authorization, .authorized)
    }

    @MainActor
    func testAFailedReadOfTheAlarmsIsShown() async {
        let scheduler = SchedulerSpy(authorization: .authorized)
        scheduler.readFailure = ScriptedAlarmFailure()
        let viewModel = DebugAlarmViewModel(scheduler: scheduler)

        await viewModel.observe()

        XCTAssertEqual(viewModel.failure, .unexpected(String(describing: ScriptedAlarmFailure())))
    }

    @MainActor
    func testObservingFollowsTheSystemsChanges() async {
        let scheduler = SchedulerSpy(authorization: .authorized)
        let alarm = ScheduledAlarm(id: UUID(), time: .daily(hour: 8, minute: 15), phase: .alerting)
        scheduler.updateBatches = [[], [alarm]]
        let viewModel = DebugAlarmViewModel(scheduler: scheduler)

        await viewModel.observe()

        XCTAssertEqual(viewModel.alarms, [alarm])
    }

    // MARK: - Cancelling
    @MainActor
    func testCancellingRemovesTheAlarm() async throws {
        let scheduler = SchedulerSpy(authorization: .authorized)
        let viewModel = DebugAlarmViewModel(scheduler: scheduler)
        await viewModel.schedule(title: "x", time: .once(Date()))
        let id = try XCTUnwrap(viewModel.alarms.first?.id)

        viewModel.cancel(id)

        XCTAssertEqual(scheduler.cancelled, [id])
        XCTAssertTrue(viewModel.alarms.isEmpty)
    }

    @MainActor
    func testARefusedCancelIsShownAndTheAlarmStays() async {
        let scheduler = SchedulerSpy(authorization: .authorized)
        let viewModel = DebugAlarmViewModel(scheduler: scheduler)
        await viewModel.schedule(title: "x", time: .once(Date()))
        scheduler.cancelFailure = ScriptedAlarmFailure()

        viewModel.cancel(viewModel.alarms[0].id)

        XCTAssertEqual(viewModel.failure, .unexpected(String(describing: ScriptedAlarmFailure())))
        XCTAssertEqual(viewModel.alarms.count, 1)
    }

    @MainActor
    func testCancellingAllRemovesEveryAlarm() async {
        let scheduler = SchedulerSpy(authorization: .authorized)
        let viewModel = DebugAlarmViewModel(scheduler: scheduler)
        await viewModel.schedule(title: "a", time: .once(Date()))
        await viewModel.schedule(title: "b", time: .daily(hour: 7, minute: 0))

        viewModel.cancelAll()

        XCTAssertEqual(scheduler.cancelled.count, 2)
        XCTAssertTrue(viewModel.alarms.isEmpty)
        XCTAssertNil(viewModel.failure)
    }

    @MainActor
    func testARefusalWhileCancellingAllIsShownAndKeepsTheRest() async {
        let scheduler = SchedulerSpy(authorization: .authorized)
        let viewModel = DebugAlarmViewModel(scheduler: scheduler)
        await viewModel.schedule(title: "a", time: .once(Date()))
        await viewModel.schedule(title: "b", time: .daily(hour: 7, minute: 0))
        scheduler.cancelFailure = ScriptedAlarmFailure()

        viewModel.cancelAll()

        XCTAssertEqual(viewModel.failure, .unexpected(String(describing: ScriptedAlarmFailure())))
        XCTAssertEqual(viewModel.alarms.count, 2)
    }
}
