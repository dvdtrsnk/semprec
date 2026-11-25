import XCTest

@testable import Semprec

/// The wake-up guard over a scripted scheduler, an in-memory store and a clock the test moves: the watch alarms after
/// a ring, ringing whatever happened to the system's alert, the code and the tap fallback that end it, a daily mission
/// that guards its next ring, the system's limit, removal and a relaunch.
final class WakeGuardTests: XCTestCase {

    private let start = Date(timeIntervalSinceReferenceDate: 800_000_000)

    // MARK: - Creating
    @MainActor
    func testAMissionSchedulesItsAlarmAndTheWatchAlarmsAfterItsRing() async throws {
        let fixture = make()
        let ring = start.addingTimeInterval(600)

        try await fixture.wakeGuard.create(title: "Up", time: .once(ring), codes: [" 123 ", "123", "", "QR"])

        let mission = try XCTUnwrap(fixture.wakeGuard.missions.first)
        XCTAssertEqual(mission.codes, ["123", "QR"])
        XCTAssertEqual(mission.guardedRing, ring)
        XCTAssertEqual(mission.watchIDs.count, WakeMission.watchOffsets.count)
        XCTAssertEqual(fixture.scheduler.requests.first?.id, mission.alarmID)
        XCTAssertTrue(fixture.scheduler.requests.allSatisfy(\.opensWakeGuard))
        let watchTimes = fixture.scheduler.requests.dropFirst().map(\.schedule)
        let expected = WakeMission.watchOffsets.map { AlarmTime.once(ring.addingTimeInterval(TimeInterval($0 * 60))) }
        XCTAssertEqual(watchTimes, expected)
        XCTAssertEqual(fixture.store.missions, fixture.wakeGuard.missions)
        XCTAssertNil(fixture.wakeGuard.ringing)
    }

    @MainActor
    func testAMissionWithoutACodeIsRefusedAndSchedulesNothing() async {
        let fixture = make()

        do {
            try await fixture.wakeGuard.create(title: "Up", time: .once(start), codes: ["  "])
            XCTFail("A mission without a code was created")
        } catch {
            XCTAssertEqual(error as? WakeGuardError, .noCodes)
        }

        XCTAssertTrue(fixture.scheduler.requests.isEmpty)
        XCTAssertTrue(fixture.wakeGuard.missions.isEmpty)
    }

    @MainActor
    func testWhenTheSystemRefusesMoreAlarmsTheAcceptedWatchAlarmsStillGuardTheRing() async throws {
        let fixture = make()
        fixture.scheduler.limit = 5

        try await fixture.wakeGuard.create(title: "Up", time: .once(start.addingTimeInterval(60)), codes: ["1"])

        XCTAssertEqual(fixture.wakeGuard.missions.first?.watchIDs.count, 4)
        XCTAssertNotNil(fixture.wakeGuard.missions.first?.guardedRing)
        XCTAssertNotNil(fixture.wakeGuard.failure)
    }

    @MainActor
    func testTwoRefreshesAtOnceArmAMissionOnce() async throws {
        let fixture = make()
        fixture.wakeGuard.missions = [mission(time: .once(start.addingTimeInterval(60)))]

        async let first: Void = fixture.wakeGuard.refresh()
        async let second: Void = fixture.wakeGuard.refresh()
        _ = await (first, second)

        XCTAssertEqual(fixture.scheduler.requests.count, WakeMission.watchOffsets.count)
    }

    @MainActor
    func testARingFurtherAheadThanTheHorizonIsArmedOnlyOnceItComesClose() async throws {
        let fixture = make()
        let ring = start.addingTimeInterval(WakeMission.armHorizon + 3_600)

        try await fixture.wakeGuard.create(title: "Up", time: .once(ring), codes: ["1"])
        XCTAssertNil(fixture.wakeGuard.missions.first?.guardedRing)
        XCTAssertEqual(fixture.scheduler.requests.count, 1)

        fixture.clock.now = ring.addingTimeInterval(-WakeMission.armHorizon)
        await fixture.wakeGuard.refresh()
        XCTAssertEqual(fixture.wakeGuard.missions.first?.guardedRing, ring)
        XCTAssertEqual(fixture.wakeGuard.missions.first?.watchIDs.count, WakeMission.watchOffsets.count)
    }

    // MARK: - Ringing
    @MainActor
    func testTheMissionRingsFromItsRingEvenAfterTheSystemAlertWasStopped() async throws {
        let fixture = make()
        try await fixture.wakeGuard.create(title: "Up", time: .once(start.addingTimeInterval(60)), codes: ["1"])
        let mission = try XCTUnwrap(fixture.wakeGuard.missions.first)
        try fixture.scheduler.stop(id: mission.alarmID)

        fixture.clock.now = start.addingTimeInterval(59)
        await fixture.wakeGuard.refresh()
        XCTAssertNil(fixture.wakeGuard.ringing)

        fixture.clock.now = start.addingTimeInterval(60)
        await fixture.wakeGuard.refresh()
        XCTAssertEqual(fixture.wakeGuard.ringing?.id, mission.id)

        fixture.clock.now = start.addingTimeInterval(5 * 3_600)
        await fixture.wakeGuard.refresh()
        XCTAssertEqual(fixture.wakeGuard.ringing?.id, mission.id)
    }

    @MainActor
    func testARingingMissionSurvivesARelaunch() async throws {
        let fixture = make()
        try await fixture.wakeGuard.create(title: "Up", time: .once(start.addingTimeInterval(60)), codes: ["1"])
        fixture.clock.now = start.addingTimeInterval(120)

        let relaunched = WakeGuard(scheduler: fixture.scheduler, store: fixture.store, now: { fixture.clock.now })

        XCTAssertEqual(relaunched.ringing?.id, fixture.wakeGuard.missions.first?.id)
    }

    @MainActor
    func testAnUnreadableStoreStartsEmptyAndSaysSo() {
        let store = MemoryMissionStore()
        store.loadFailure = ScriptedAlarmFailure()

        let wakeGuard = WakeGuard(scheduler: SchedulerSpy(authorization: .authorized), store: store, now: { Date() })

        XCTAssertTrue(wakeGuard.missions.isEmpty)
        XCTAssertNotNil(wakeGuard.failure)
    }

    // MARK: - Ending with a code
    @MainActor
    func testAWrongCodeKeepsItRinging() async throws {
        let fixture = try await ringing(.once(start.addingTimeInterval(60)))

        let ended = await fixture.wakeGuard.submit(code: "nope")

        XCTAssertFalse(ended)
        await fixture.wakeGuard.refresh()
        XCTAssertNotNil(fixture.wakeGuard.ringing)
    }

    @MainActor
    func testTheCodeEndsASingleRingWithAllItsAlarms() async throws {
        let fixture = try await ringing(.once(start.addingTimeInterval(60)))
        let mission = try XCTUnwrap(fixture.wakeGuard.ringing)
        fixture.scheduler.ring(mission.watchIDs[0])

        let ended = await fixture.wakeGuard.submit(code: " 123 ")

        XCTAssertTrue(ended)
        XCTAssertNil(fixture.wakeGuard.ringing)
        XCTAssertTrue(fixture.wakeGuard.missions.isEmpty)
        XCTAssertTrue(fixture.store.missions.isEmpty)
        XCTAssertEqual(fixture.scheduler.stopped, [mission.watchIDs[0]])
        XCTAssertEqual(Set(fixture.scheduler.cancelled), Set([mission.alarmID] + mission.watchIDs.dropFirst()))
        XCTAssertTrue(fixture.scheduler.held.isEmpty)
    }

    @MainActor
    func testTheCodeCancelsAWatchAlarmThatCountsDownOrIsPausedInsteadOfStoppingIt() async throws {
        let fixture = try await ringing(.once(start.addingTimeInterval(60)))
        let mission = try XCTUnwrap(fixture.wakeGuard.ringing)
        fixture.scheduler.ring(mission.watchIDs[0])
        fixture.scheduler.set(mission.watchIDs[1], phase: .countdown)
        fixture.scheduler.set(mission.watchIDs[2], phase: .paused)

        _ = await fixture.wakeGuard.submit(code: "123")

        XCTAssertEqual(fixture.scheduler.stopped, [mission.watchIDs[0]])
        XCTAssertTrue(fixture.scheduler.cancelled.contains(mission.watchIDs[1]))
        XCTAssertTrue(fixture.scheduler.cancelled.contains(mission.watchIDs[2]))
        XCTAssertTrue(fixture.scheduler.held.isEmpty)
    }

    @MainActor
    func testTheCodeEndsTodaysDailyRingAndGuardsTomorrows() async throws {
        let calendar = Calendar.current
        let ring = try XCTUnwrap(calendar.date(bySettingHour: 7, minute: 0, second: 0, of: start))
        let fixture = make(now: ring.addingTimeInterval(-3_600))
        try await fixture.wakeGuard.create(title: "Up", time: .daily(hour: 7, minute: 0), codes: ["123"])
        let today = try XCTUnwrap(fixture.wakeGuard.missions.first)
        XCTAssertEqual(today.guardedRing, ring)
        fixture.clock.now = ring.addingTimeInterval(120)
        await fixture.wakeGuard.refresh()
        fixture.scheduler.ring(today.alarmID)

        await fixture.wakeGuard.submit(code: "123")

        let tomorrow = try XCTUnwrap(fixture.wakeGuard.missions.first)
        XCTAssertNil(fixture.wakeGuard.ringing)
        XCTAssertEqual(fixture.scheduler.stopped, [today.alarmID])
        XCTAssertFalse(fixture.scheduler.cancelled.contains(today.alarmID))
        XCTAssertEqual(tomorrow.guardedRing, calendar.date(byAdding: .day, value: 1, to: ring))
        XCTAssertEqual(tomorrow.watchIDs.count, WakeMission.watchOffsets.count)
        XCTAssertTrue(Set(tomorrow.watchIDs).isDisjoint(with: today.watchIDs))
    }

    // MARK: - Tap fallback
    @MainActor
    func testTapsDoNotCountBeforeTheFallbackOpens() async throws {
        let fixture = try await ringing(.once(start.addingTimeInterval(60)))
        fixture.clock.now = start.addingTimeInterval(60 + WakeMission.tapFallbackDelay - 1)

        for _ in 0..<WakeMission.requiredTaps { await fixture.wakeGuard.tap() }

        XCTAssertFalse(fixture.wakeGuard.tapFallbackIsOpen)
        XCTAssertEqual(fixture.wakeGuard.taps, 0)
        XCTAssertNotNil(fixture.wakeGuard.ringing)
    }

    @MainActor
    func testTheLastRequiredTapEndsTheMissionAndOneFewerDoesNot() async throws {
        let fixture = try await ringing(.once(start.addingTimeInterval(60)))
        let opensAt = start.addingTimeInterval(60 + WakeMission.tapFallbackDelay)
        fixture.clock.now = opensAt
        XCTAssertEqual(fixture.wakeGuard.tapFallbackOpensAt, opensAt)

        for _ in 0..<(WakeMission.requiredTaps - 1) { await fixture.wakeGuard.tap() }
        XCTAssertNotNil(fixture.wakeGuard.ringing)

        await fixture.wakeGuard.tap()
        XCTAssertNil(fixture.wakeGuard.ringing)
        XCTAssertTrue(fixture.wakeGuard.missions.isEmpty)
    }

    // MARK: - Removing
    @MainActor
    func testARingingMissionCannotBeRemoved() async throws {
        let fixture = try await ringing(.once(start.addingTimeInterval(60)))
        let mission = try XCTUnwrap(fixture.wakeGuard.ringing)

        await fixture.wakeGuard.remove(mission.id)

        XCTAssertEqual(fixture.wakeGuard.missions.map(\.id), [mission.id])
        XCTAssertTrue(fixture.scheduler.cancelled.isEmpty)
    }

    @MainActor
    func testAWaitingMissionIsRemovedWithAllItsAlarms() async throws {
        let fixture = make()
        try await fixture.wakeGuard.create(title: "Up", time: .once(start.addingTimeInterval(600)), codes: ["1"])
        let mission = try XCTUnwrap(fixture.wakeGuard.missions.first)

        await fixture.wakeGuard.remove(mission.id)

        XCTAssertTrue(fixture.wakeGuard.missions.isEmpty)
        XCTAssertTrue(fixture.store.missions.isEmpty)
        XCTAssertEqual(Set(fixture.scheduler.cancelled), Set([mission.alarmID] + mission.watchIDs))
    }

    @MainActor
    func testASingleRingThatPassedUnguardedIsDropped() async {
        let fixture = make()
        fixture.wakeGuard.missions = [mission(time: .once(start.addingTimeInterval(-60)))]

        await fixture.wakeGuard.refresh()

        XCTAssertTrue(fixture.wakeGuard.missions.isEmpty)
        XCTAssertNil(fixture.wakeGuard.ringing)
    }
}

// MARK: - Support
private extension WakeGuardTests {

    @MainActor
    func make(now: Date? = nil) -> Fixture {
        let scheduler = SchedulerSpy(authorization: .authorized)
        let store = MemoryMissionStore()
        let clock = TestClock(now: now ?? start)
        let wakeGuard = WakeGuard(scheduler: scheduler, store: store, now: { clock.now })
        return Fixture(wakeGuard: wakeGuard, scheduler: scheduler, store: store, clock: clock)
    }

    /// A guard whose mission with the code `123` rings at `time` and has started ringing.
    @MainActor
    func ringing(_ time: AlarmTime) async throws -> Fixture {
        let fixture = make()
        try await fixture.wakeGuard.create(title: "Up", time: time, codes: ["123"])
        fixture.clock.now = start.addingTimeInterval(61)
        await fixture.wakeGuard.refresh()
        XCTAssertNotNil(fixture.wakeGuard.ringing)
        return fixture
    }

    func mission(time: AlarmTime) -> WakeMission {
        WakeMission(id: UUID(), title: "Up", time: time, codes: ["1"], alarmID: UUID(), guardedRing: nil, watchIDs: [])
    }
}

/// A guard with the doubles behind it.
private struct Fixture {

    let wakeGuard: WakeGuard
    let scheduler: SchedulerSpy
    let store: MemoryMissionStore
    let clock: TestClock
}

/// The clock the guard reads, moved by the test.
private final class TestClock: @unchecked Sendable {

    var now: Date

    init(now: Date) {
        self.now = now
    }
}
