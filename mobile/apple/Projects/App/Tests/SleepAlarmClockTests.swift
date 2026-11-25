import CoreKit
import XCTest

@testable import Semprec

/// The sleep plan's alarms on the device: plain system alarms without a code, wake-up missions with one, kept in step
/// with the plan as it changes, a failed read changing nothing, and the person signing out.
final class SleepAlarmClockTests: XCTestCase {

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Prague") ?? .current
        return calendar
    }

    /// 25 November 2026, 22:00 in Prague.
    private var evening: Date {
        calendar.date(from: DateComponents(year: 2026, month: 11, day: 25, hour: 22)) ?? Date()
    }

    private func at(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 11, day: day, hour: hour, minute: minute)) ?? Date()
    }

    // MARK: - Plain alarms
    @MainActor
    func testWithoutACodeEachAlarmIsOnePlainSystemAlarmAtItsWakeTime() async {
        let fixture = make(alarms: [alarm(wakeDay: "2026-11-26", 405), alarm(wakeDay: "2026-11-27", 420)])

        await fixture.clock.sync()
        await fixture.clock.sync()

        XCTAssertEqual(fixture.scheduler.requests.count, 2)
        XCTAssertTrue(fixture.scheduler.requests.map(\.schedule).contains(.once(at(26, 6, 45))))
        XCTAssertTrue(fixture.scheduler.requests.map(\.schedule).contains(.once(at(27, 7))))
        XCTAssertEqual(fixture.store.scheduled.count, 2)
        XCTAssertFalse(fixture.scheduler.requests.contains(where: \.opensWakeGuard))
        XCTAssertTrue(fixture.wakeGuard.missions.isEmpty)
    }

    @MainActor
    func testAnAlarmThePlanNoLongerHasIsCancelledAndAPassedOneIsNotScheduled() async {
        let fixture = make(alarms: [alarm(wakeDay: "2026-11-26", 405), alarm(wakeDay: "2026-11-25", 405)])
        await fixture.clock.sync()
        XCTAssertEqual(fixture.scheduler.requests.map(\.schedule), [.once(at(26, 6, 45))])

        fixture.source.alarms = []
        await fixture.clock.sync()

        XCTAssertEqual(fixture.scheduler.cancelled, fixture.scheduler.requests.map(\.id))
        XCTAssertTrue(fixture.store.scheduled.isEmpty)
    }

    @MainActor
    func testAnAlarmWhoseCancelFailedIsCancelledOnTheNextSync() async {
        let fixture = make(alarms: [alarm(wakeDay: "2026-11-26", 405)])
        await fixture.clock.sync()
        fixture.source.alarms = []

        fixture.scheduler.readFailure = ScriptedAlarmFailure()
        await fixture.clock.sync()
        XCTAssertEqual(fixture.store.scheduled.count, 1)
        fixture.scheduler.readFailure = nil
        fixture.scheduler.cancelFailure = ScriptedAlarmFailure()
        await fixture.clock.sync()
        XCTAssertEqual(fixture.store.scheduled.count, 1)
        XCTAssertEqual(fixture.scheduler.held.count, 1)

        fixture.scheduler.cancelFailure = nil
        await fixture.clock.sync()
        XCTAssertEqual(fixture.scheduler.cancelled, fixture.scheduler.requests.map(\.id))
        XCTAssertTrue(fixture.scheduler.held.isEmpty)
        XCTAssertTrue(fixture.store.scheduled.isEmpty)
    }

    @MainActor
    func testAlarmsTheLedgerCouldNotKeepAreCancelledSoTheNextSyncDoesNotDoubleThem() async {
        let fixture = make(alarms: [alarm(wakeDay: "2026-11-26", 405)])
        fixture.store.saveScheduledFailure = ScriptedAlarmFailure()

        await fixture.clock.sync()
        XCTAssertEqual(fixture.scheduler.cancelled, fixture.scheduler.requests.map(\.id))
        XCTAssertTrue(fixture.scheduler.held.isEmpty)

        fixture.store.saveScheduledFailure = nil
        await fixture.clock.sync()
        XCTAssertEqual(fixture.scheduler.held.count, 1)
        XCTAssertEqual(fixture.store.scheduled.count, 1)
    }

    @MainActor
    func testAFailedReadChangesNothing() async {
        let fixture = make(alarms: [alarm(wakeDay: "2026-11-26", 405)])
        await fixture.clock.sync()

        fixture.source.alarms = nil
        await fixture.clock.sync()

        XCTAssertTrue(fixture.scheduler.cancelled.isEmpty)
        XCTAssertEqual(fixture.store.scheduled.count, 1)
    }

    @MainActor
    func testAPlatformWithoutAlarmsReadsNothing() async {
        let fixture = make(alarms: [alarm(wakeDay: "2026-11-26", 405)], authorization: .unsupported)

        await fixture.clock.sync()

        XCTAssertEqual(fixture.source.reads, 0)
        XCTAssertTrue(fixture.scheduler.requests.isEmpty)
    }

    // MARK: - Wake-up missions
    @MainActor
    func testWithACodeEachAlarmIsAMissionAndTheNearOneIsGuarded() async throws {
        let fixture = make(alarms: [alarm(wakeDay: "2026-11-26", 405), alarm(wakeDay: "2026-11-28", 420)])
        fixture.clock.update(SleepWakeSettings(requiresCode: true, codes: [" 590 ", "590"]))
        await fixture.clock.sync()

        let missions = fixture.wakeGuard.missions.sorted { ($0.source ?? "") < ($1.source ?? "") }
        XCTAssertEqual(missions.map(\.source), ["sleep:2026-11-26 06:45", "sleep:2026-11-28 07:00"])
        XCTAssertEqual(missions.map(\.codes), [["590"], ["590"]])
        XCTAssertEqual(missions.first?.guardedRing, at(26, 6, 45))
        XCTAssertNil(missions.last?.guardedRing)
        XCTAssertTrue(fixture.store.scheduled.isEmpty)
    }

    @MainActor
    func testNewCodesReplaceTheMissionsAndSwitchingOffTurnsThemBackIntoPlainAlarms() async {
        let fixture = make(alarms: [alarm(wakeDay: "2026-11-26", 405)])
        fixture.clock.update(SleepWakeSettings(requiresCode: true, codes: ["1"]))
        await fixture.clock.sync()
        let first = fixture.wakeGuard.missions.map(\.id)

        fixture.clock.update(SleepWakeSettings(requiresCode: true, codes: ["2"]))
        await fixture.clock.sync()
        XCTAssertEqual(fixture.wakeGuard.missions.map(\.codes), [["2"]])
        XCTAssertNotEqual(fixture.wakeGuard.missions.map(\.id), first)

        fixture.clock.update(SleepWakeSettings(requiresCode: false, codes: ["2"]))
        await fixture.clock.sync()
        XCTAssertTrue(fixture.wakeGuard.missions.isEmpty)
        XCTAssertEqual(fixture.store.scheduled.count, 1)
    }

    @MainActor
    func testTheCodeSwitchWithoutACodeRingsPlainAlarms() async {
        let fixture = make(alarms: [alarm(wakeDay: "2026-11-26", 405)])
        fixture.clock.update(SleepWakeSettings(requiresCode: true, codes: ["  "]))
        await fixture.clock.sync()

        XCTAssertTrue(fixture.wakeGuard.missions.isEmpty)
        XCTAssertEqual(fixture.store.scheduled.count, 1)
    }

    @MainActor
    func testSettingsAreKeptAndReadAgainOnTheNextLaunch() {
        let fixture = make(alarms: [])
        fixture.clock.update(SleepWakeSettings(requiresCode: true, codes: ["9"]))

        let relaunched = SleepAlarmClock(
            source: fixture.source,
            scheduler: fixture.scheduler,
            wakeGuard: fixture.wakeGuard,
            store: fixture.store
        )

        XCTAssertEqual(relaunched.settings, SleepWakeSettings(requiresCode: true, codes: ["9"]))
    }

    // MARK: - Signing out
    @MainActor
    func testSigningOutRemovesThePlainAlarmsAndTheMissions() async {
        let plain = make(alarms: [alarm(wakeDay: "2026-11-26", 405)])
        await plain.clock.sync()
        await plain.clock.signedOut()
        XCTAssertEqual(plain.scheduler.cancelled.count, 1)
        XCTAssertTrue(plain.store.scheduled.isEmpty)

        let guarded = make(alarms: [alarm(wakeDay: "2026-11-26", 405)])
        guarded.clock.update(SleepWakeSettings(requiresCode: true, codes: ["1"]))
        await guarded.clock.sync()
        await guarded.clock.signedOut()
        XCTAssertTrue(guarded.wakeGuard.missions.isEmpty)
    }

    @MainActor
    func testOnlyTheSleepResyncPushAsksForTheAlarms() {
        let fixture = make(alarms: [])

        XCTAssertTrue(fixture.clock.asksForSleepAlarms(["kind": "sleepResync"]))
        XCTAssertFalse(fixture.clock.asksForSleepAlarms(["kind": "remindersResync"]))
    }
}

// MARK: - Support
private extension SleepAlarmClockTests {

    struct Fixture {

        let clock: SleepAlarmClock
        let source: ScriptedSleepAlarms
        let scheduler: SchedulerSpy
        let wakeGuard: WakeGuard
        let store: MemorySleepAlarmStore
    }

    @MainActor
    func make(alarms: [SleepAlarmTime]?, authorization: AlarmAuthorization = .authorized) -> Fixture {
        let source = ScriptedSleepAlarms(alarms: alarms)
        let scheduler = SchedulerSpy(authorization: authorization)
        let now = evening
        let wakeGuard = WakeGuard(scheduler: scheduler, store: MemoryMissionStore(), now: { now })
        let store = MemorySleepAlarmStore()
        let clock = SleepAlarmClock(
            source: source,
            scheduler: scheduler,
            wakeGuard: wakeGuard,
            store: store,
            now: { now },
            calendar: calendar
        )
        return Fixture(clock: clock, source: source, scheduler: scheduler, wakeGuard: wakeGuard, store: store)
    }

    func alarm(wakeDay: String, _ minutes: Int) -> SleepAlarmTime {
        SleepAlarmTime(night: "", wakeDay: wakeDay, wakeMinutes: minutes, planName: nil)
    }
}

/// The alarms the plan has, as the test sets them; nil is a failed read.
@MainActor
private final class ScriptedSleepAlarms: SleepAlarmSource {

    var alarms: [SleepAlarmTime]?
    private(set) var reads = 0

    init(alarms: [SleepAlarmTime]?) {
        self.alarms = alarms
    }

    func sleepAlarms(today: String) async -> [SleepAlarmTime]? {
        reads += 1
        return alarms
    }

    func asksForSleepAlarms(_ payload: [String: String]) -> Bool {
        payload["kind"] == "sleepResync"
    }
}

/// The settings and the scheduled plain alarms in memory.
private final class MemorySleepAlarmStore: SleepAlarmStore, @unchecked Sendable {

    var settings = SleepWakeSettings()
    var scheduled: [String: UUID] = [:]
    var saveScheduledFailure: Error?

    func load() throws -> SleepWakeSettings { settings }

    func save(_ settings: SleepWakeSettings) throws { self.settings = settings }

    func loadScheduled() throws -> [String: UUID] { scheduled }

    func saveScheduled(_ scheduled: [String: UUID]) throws {
        if let saveScheduledFailure { throw saveScheduledFailure }
        self.scheduled = scheduled
    }
}
