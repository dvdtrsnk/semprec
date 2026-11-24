import SharedSDK
import XCTest

@testable import CoreKit

/// The Swift side of the shared `DeviceNotifications`: every mapping over Kotlin values, and the real Kotlin object
/// behind `SharedDeviceNotifications`.
final class DeviceNotificationsTests: XCTestCase {

    // MARK: - Mapping
    @MainActor
    func testTheTokenIsLowerCaseHexOfItsBytes() {
        XCTAssertEqual(SharedDeviceNotifications.hex(Data([0x00, 0x0A, 0xFF, 0x7C])), "000aff7c")
        XCTAssertEqual(SharedDeviceNotifications.hex(Data()), "")
    }

    @MainActor
    func testASleepAlarmKeepsItsDayTimeAndPlan() {
        let alarm = SharedSDK.DeviceSleepAlarm(
            night: "2026-11-24",
            wakeDay: "2026-11-25",
            wakeMinutes: 405,
            planName: nil
        )

        XCTAssertEqual(
            SharedDeviceNotifications.sleepAlarm(alarm),
            SleepAlarmTime(night: "2026-11-24", wakeDay: "2026-11-25", wakeMinutes: 405, planName: nil)
        )
    }

    @MainActor
    func testOnlyTheSleepResyncPushAsksForTheSleepAlarms() {
        let notifications = SharedDeviceNotifications(sessionStore: .memory)

        XCTAssertTrue(notifications.asksForSleepAlarms(["kind": "sleepResync"]))
        XCTAssertFalse(notifications.asksForSleepAlarms(["kind": "remindersResync"]))
    }

    @MainActor
    func testEveryEnvironmentAndKindMapsBothWays() {
        XCTAssertEqual(SharedDeviceNotifications.environment(.sandbox), .sandbox)
        XCTAssertEqual(SharedDeviceNotifications.environment(.production), .production)
        XCTAssertEqual(SharedDeviceNotifications.kind(.event), .event)
        XCTAssertEqual(SharedDeviceNotifications.kind(.task), .task)
        XCTAssertEqual(SharedDeviceNotifications.sharedKind(.event), .event)
        XCTAssertEqual(SharedDeviceNotifications.sharedKind(.task), .task)
    }

    @MainActor
    func testEveryTargetMaps() {
        let event = SharedSDK.NotificationTargetEvent(eventId: "e1")
        let task = SharedSDK.NotificationTargetTask(taskId: "t1")
        XCTAssertEqual(SharedDeviceNotifications.target(event), .event(id: "e1"))
        XCTAssertEqual(SharedDeviceNotifications.target(task), .task(id: "t1"))
        XCTAssertEqual(SharedDeviceNotifications.target(SharedSDK.NotificationTargetInvitations.shared), .invitations)
    }

    @MainActor
    func testInstantsWithAndWithoutMillisecondsAreReadAndOthersAreNot() throws {
        let expected = Date(timeIntervalSince1970: 1_763_714_700)
        XCTAssertEqual(SharedDeviceNotifications.date("2025-11-21T08:45:00.000Z"), expected)
        XCTAssertEqual(SharedDeviceNotifications.date("2025-11-21T08:45:00Z"), expected)
        XCTAssertNil(SharedDeviceNotifications.date("tomorrow"))
        let written = SharedDeviceNotifications.instant(expected)
        XCTAssertEqual(SharedDeviceNotifications.date(written), expected)
    }

    @MainActor
    func testAReminderKeepsItsValuesAndOneWithAnUnreadableInstantIsLeftOut() {
        let shared = SharedSDK.DeviceReminder(
            identifier: "e1:2025-11-21T08:45:00.000Z",
            kind: .event,
            itemId: "e1",
            title: "Dinner",
            fireAt: "2025-11-21T08:45:00.000Z",
            startsAt: "2025-11-21T09:00:00.000Z"
        )
        XCTAssertEqual(
            SharedDeviceNotifications.reminder(shared),
            DeviceReminder(
                identifier: "e1:2025-11-21T08:45:00.000Z",
                kind: .event,
                itemId: "e1",
                title: "Dinner",
                fireAt: Date(timeIntervalSince1970: 1_763_714_700),
                startsAt: Date(timeIntervalSince1970: 1_763_715_600)
            )
        )
        let unreadable = SharedSDK.DeviceReminder(
            identifier: "t1:x",
            kind: .task,
            itemId: "t1",
            title: "Call",
            fireAt: "soon",
            startsAt: "2025-11-21T09:00:00.000Z"
        )
        XCTAssertNil(SharedDeviceNotifications.reminder(unreadable))
    }

    func testThePayloadKeepsOnlyStringKeysWithStringValues() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Family"]],
            "event_id": "e1",
            "calendar_id": "c1",
            "count": 3,
            7: "seven"
        ]
        XCTAssertEqual(NotificationPayload.strings(of: userInfo), ["event_id": "e1", "calendar_id": "c1"])
    }

    // MARK: - Through the Kotlin object
    @MainActor
    func testATappedPushOrReminderLeadsWhereTheSharedLayerSays() {
        let notifications = SharedDeviceNotifications(sessionStore: .memory)
        XCTAssertEqual(notifications.target(of: ["event_id": "e1", "calendar_id": "c1"]), .event(id: "e1"))
        XCTAssertEqual(notifications.target(of: ["invitation_id": "i1"]), .invitations)
        XCTAssertNil(notifications.target(of: ["link_href": "/approvals"]))
        let reminder = DeviceReminder(
            identifier: "t1:x",
            kind: .task,
            itemId: "t1",
            title: "Call",
            fireAt: Date(timeIntervalSince1970: 1_763_714_700),
            startsAt: Date(timeIntervalSince1970: 1_763_714_700)
        )
        XCTAssertEqual(notifications.target(of: notifications.userInfo(of: reminder)), .task(id: "t1"))
        XCTAssertTrue(notifications.asksForReminders(["kind": "remindersResync"]))
        XCTAssertFalse(notifications.asksForReminders(["event_id": "e1"]))
    }

    @MainActor
    func testWithoutASessionNothingIsRegisteredOrRead() async {
        let notifications = SharedDeviceNotifications(sessionStore: .memory)
        let registered = await notifications.register(deviceToken: Data([0xAB]), environment: .sandbox)
        let reminders = await notifications.reminders(from: Date())
        let badge = await notifications.badge()
        XCTAssertFalse(registered)
        XCTAssertNil(reminders)
        XCTAssertNil(badge)
    }

    // MARK: - Notification settings
    @MainActor
    func testTheNotificationSettingsEffectMaps() {
        XCTAssertEqual(
            SharedNotificationSettingsScreenModel.effect(SharedSDK.NotificationSettingsEffectRequestPermission.shared),
            .requestPermission
        )
    }
}
