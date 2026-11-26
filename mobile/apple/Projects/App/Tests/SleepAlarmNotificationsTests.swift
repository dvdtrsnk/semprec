import CoreKit
import SwiftUI
import XCTest

@testable import Semprec

/// The sleep alarms of the device, which the app keeps in step with the sleep plan when a scene shows or becomes
/// active and when a silent push asks, and removes when nobody is signed in. Which alarms ring is decided in the shared
/// layer, so these tests run over a scripted service.
final class SleepAlarmNotificationsTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testTheSleepAlarmsAreKeptInStepWhetherOrNotNotificationsAreAllowed() async {
        for authorized in [true, false] {
            let (notifications, service, _) = AppNotificationsTests.make(authorized: authorized)

            let result = await notifications.syncSleepAlarms()

            XCTAssertEqual(result, .synced)
            XCTAssertEqual(service.alarmRuns, [.sync], "notifications allowed: \(authorized)")
        }
    }

    @MainActor
    func testARunThatDidNotFinishAnswersNothing() async {
        let (notifications, service, _) = AppNotificationsTests.make(authorized: true)
        service.alarmResult = nil

        let result = await notifications.syncSleepAlarms()

        XCTAssertNil(result)
    }

    @MainActor
    func testRefreshingTheRemindersLeavesTheSleepAlarmsToTheScene() async {
        let (notifications, service, _) = AppNotificationsTests.make(authorized: true)

        await notifications.refresh()

        XCTAssertTrue(service.alarmRuns.isEmpty)
    }

    @MainActor
    func testASleepPushKeepsTheAlarmsInStepAndReadsNoReminders() async {
        let (notifications, service, center) = AppNotificationsTests.make(authorized: true)
        center.pending = ["reminder.old"]

        let refreshed = await notifications.didReceiveRemoteNotification(["kind": "sleepResync"])

        XCTAssertTrue(refreshed)
        XCTAssertEqual(service.alarmRuns, [.sync])
        XCTAssertEqual(service.reminderReads, 0)
        XCTAssertTrue(center.removed.isEmpty)
    }

    @MainActor
    func testASleepPushThatLeavesTheAlarmsUnsyncedBroughtNothingNew() async {
        let (notifications, service, _) = AppNotificationsTests.make(authorized: true)
        let unsynced: [SleepAlarmSyncResult?] = [
            .readFailed, .unsupported, .notAuthorized, .limitReached, .deviceFailed, nil
        ]
        for result in unsynced {
            service.alarmResult = result

            let refreshed = await notifications.didReceiveRemoteNotification(["kind": "sleepResync"])

            XCTAssertFalse(refreshed, "\(String(describing: result))")
        }
    }

    @MainActor
    func testAPushThatAsksForNothingTouchesNeitherTheRemindersNorTheAlarms() async {
        let (notifications, service, _) = AppNotificationsTests.make(authorized: true)

        let refreshed = await notifications.didReceiveRemoteNotification(["kind": "somethingElse"])

        XCTAssertFalse(refreshed)
        XCTAssertEqual(service.reminderReads, 0)
        XCTAssertTrue(service.alarmRuns.isEmpty)
    }

    @MainActor
    func testASceneKeepsTheAlarmsInStepWhenItShowsAndEachTimeItBecomesActive() async throws {
        let (notifications, service, _) = AppNotificationsTests.make(authorized: true)
        let phase = UpkeepPhase()
        let window = try SceneWindow()

        try await window.show(UpkeepScene(phase: phase, notifications: notifications))
        XCTAssertEqual(service.alarmRuns, [.sync], "the scene that appears keeps the alarms in step once")

        phase.value = .background
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(service.alarmRuns, [.sync], "a scene in the background does nothing")
        phase.value = .active
        try await eventually { service.alarmRuns.count == 2 }
        XCTAssertEqual(service.alarmRuns, [.sync, .sync], "a scene back from the background does it again")
        window.close()
    }
}

// MARK: - Helpers
@MainActor
private final class UpkeepPhase: ObservableObject {

    @Published var value = ScenePhase.active
}

/// A view under the scene phase the test sets; a window of the test host is no SwiftUI scene.
private struct UpkeepScene: View {

    @ObservedObject var phase: UpkeepPhase
    let notifications: AppNotifications

    var body: some View {
        Color.clear
            .modifier(SleepAlarmUpkeep(notifications: notifications))
            .environment(\.scenePhase, phase.value)
    }
}
