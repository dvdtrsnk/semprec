import CoreKit
import XCTest

@testable import Semprec

/// What the app carries between the shared layer and the system: the permission, the registration, the reminders it
/// schedules, the icon's number and where a tapped notification leads, over a scripted service and notification center.
final class AppNotificationsTests: XCTestCase {

    // MARK: - Permission and registration
    @MainActor
    func testAllowedNotificationsRegisterTheDeviceScheduleItsRemindersAndSetTheBadge() async {
        let (notifications, service, center) = Self.make(authorized: true)
        var registrations = 0
        notifications.registerForRemoteNotifications = { registrations += 1 }
        service.reminders = [Self.reminder("e1", .event, in: 600), Self.reminder("t1", .task, in: 1_200)]
        service.badge = 4

        await notifications.refresh()

        XCTAssertEqual(registrations, 1)
        XCTAssertEqual(center.scheduled.map(\.identifier), ["reminder.e1", "reminder.t1"])
        XCTAssertEqual(center.scheduled.map(\.userInfo), [["event_id": "e1"], ["task_id": "t1"]])
        XCTAssertEqual(center.scheduled.map(\.title), ["e1 title", "t1 title"])
        XCTAssertEqual(center.badges, [4])
    }

    @MainActor
    func testWithoutThePermissionNothingIsRegisteredScheduledOrCounted() async {
        let (notifications, service, center) = Self.make(authorized: false)
        var registrations = 0
        notifications.registerForRemoteNotifications = { registrations += 1 }
        service.reminders = [Self.reminder("e1", .event, in: 600)]

        await notifications.refresh()
        await notifications.requestPermission()

        XCTAssertEqual(registrations, 0)
        XCTAssertEqual(center.authorizationRequests, 1)
        XCTAssertTrue(center.scheduled.isEmpty)
        XCTAssertTrue(center.badges.isEmpty)
    }

    @MainActor
    func testGrantingThePermissionRegistersTheDevice() async {
        let (notifications, _, center) = Self.make(authorized: false, grants: true)
        var registrations = 0
        notifications.registerForRemoteNotifications = { registrations += 1 }

        await notifications.requestPermission()

        XCTAssertEqual(center.authorizationRequests, 1)
        XCTAssertEqual(registrations, 1)
    }

    @MainActor
    func testTheTokenIsRegisteredForTheBuildsEnvironment() async {
        let (notifications, service, _) = Self.make(authorized: true, environment: .production)

        await notifications.didRegister(deviceToken: Data([0xAB, 0xCD]))

        XCTAssertEqual(service.registrations, [Registration(token: Data([0xAB, 0xCD]), environment: .production)])
    }

    func testADebugBuildRegistersWithTheApnsSandbox() {
        XCTAssertEqual(AppNotifications.buildEnvironment(), .sandbox)
    }

    func testTheIphoneAppMayReceivePushesInTheEnvironmentOfItsBuild() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Entitlements/Semprec-iOS.entitlements")
        let plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: file), format: nil)
        let entitlements = try XCTUnwrap(plist as? [String: Any])
        XCTAssertEqual(entitlements["aps-environment"] as? String, "$(SEMPREC_APS_ENVIRONMENT)")
    }

    // MARK: - Reminders
    @MainActor
    func testANewReadReplacesOnlyTheRemindersAndSkipsOnesAlreadyDue() async {
        let (notifications, service, center) = Self.make(authorized: true)
        center.pending = ["reminder.old", "other.kept"]
        service.reminders = [Self.reminder("past", .event, in: -60), Self.reminder("e1", .event, in: 60)]

        let refreshed = await notifications.didReceiveRemoteNotification(["kind": "remindersResync"])

        XCTAssertTrue(refreshed)
        XCTAssertEqual(center.removed, [["reminder.old"]])
        XCTAssertEqual(center.scheduled.map(\.identifier), ["reminder.e1"])
    }

    @MainActor
    func testAFailedReadKeepsTheScheduledRemindersAndOtherPushesReadNothing() async {
        let (notifications, service, center) = Self.make(authorized: true)
        center.pending = ["reminder.old"]
        service.reminders = nil

        let failed = await notifications.didReceiveRemoteNotification(["kind": "remindersResync"])
        let other = await notifications.didReceiveRemoteNotification(["dismiss": "n1"])

        XCTAssertFalse(failed)
        XCTAssertFalse(other)
        XCTAssertEqual(service.reminderReads, 1)
        XCTAssertTrue(center.removed.isEmpty)
    }

    @MainActor
    func testAReminderSaysWhenItsItemStarts() async throws {
        let (notifications, service, center) = Self.make(authorized: true)
        let reminder = Self.reminder("e1", .event, in: 600)
        service.reminders = [reminder]

        await notifications.refresh()

        let time = reminder.startsAt.formatted(date: .omitted, time: .shortened)
        let scheduled = try XCTUnwrap(center.scheduled.first)
        XCTAssertEqual(scheduled.date, reminder.fireAt)
        XCTAssertTrue(scheduled.body.contains(time), "\(scheduled.body) names \(time)")
    }

    @MainActor
    func testSigningOutRemovesTheRemindersAndTheBadge() async {
        let (notifications, _, center) = Self.make(authorized: true)
        center.pending = ["reminder.e1", "other.kept"]

        await notifications.signedOut()

        XCTAssertEqual(center.removed, [["reminder.e1"]])
        XCTAssertEqual(center.badges, [0])
    }

    // MARK: - Taps
    @MainActor
    func testATappedNotificationWaitsForOneSceneToTakeIt() {
        let (notifications, _, _) = Self.make(authorized: true)
        var arrivals = 0
        let subscription = notifications.targetArrivals.sink { arrivals += 1 }
        defer { subscription.cancel() }

        notifications.didOpen(["event_id": "e1"])
        notifications.didOpen(["link_href": "/approvals"])

        XCTAssertEqual(arrivals, 2, "one on subscribing, one for the tap that leads somewhere")
        XCTAssertEqual(notifications.takeTarget(), .event(id: "e1"))
        XCTAssertNil(notifications.takeTarget())
    }
}

// MARK: - Helpers
private extension AppNotificationsTests {

    @MainActor
    static func make(
        authorized: Bool,
        grants: Bool = false,
        environment: PushEnvironment = .sandbox
    ) -> (AppNotifications, ServiceSpy, CenterSpy) {
        let service = ServiceSpy()
        let center = CenterSpy(authorized: authorized, grants: grants)
        let notifications = AppNotifications(
            service: service,
            center: center,
            environment: environment,
            now: { Self.now }
        )
        return (notifications, service, center)
    }

    static let now = Date(timeIntervalSince1970: 1_763_714_700)

    static func reminder(_ id: String, _ kind: DeviceReminderKind, in seconds: TimeInterval) -> DeviceReminder {
        DeviceReminder(
            identifier: id,
            kind: kind,
            itemId: id,
            title: "\(id) title",
            fireAt: now.addingTimeInterval(seconds),
            startsAt: now.addingTimeInterval(seconds + 900)
        )
    }
}

private struct Registration: Equatable {

    let token: Data
    let environment: PushEnvironment
}

@MainActor
private final class ServiceSpy: DeviceNotificationService {

    // MARK: - Properties
    var reminders: [DeviceReminder]? = []
    var badge: Int?
    private(set) var registrations: [Registration] = []
    private(set) var reminderReads = 0

    // MARK: - Protocol conformance
    func register(deviceToken: Data, environment: PushEnvironment) async -> Bool {
        registrations.append(Registration(token: deviceToken, environment: environment))
        return true
    }

    func reminders(from date: Date) async -> [DeviceReminder]? {
        reminderReads += 1
        return reminders
    }

    func badge() async -> Int? { badge }

    func target(of payload: [String: String]) -> NotificationTarget? {
        if let event = payload["event_id"] { return .event(id: event) }
        if let task = payload["task_id"] { return .task(id: task) }
        return nil
    }

    func userInfo(of reminder: DeviceReminder) -> [String: String] {
        switch reminder.kind {
        case .event: ["event_id": reminder.itemId]
        case .task: ["task_id": reminder.itemId]
        }
    }

    func asksForReminders(_ payload: [String: String]) -> Bool {
        payload["kind"] == "remindersResync"
    }
}

private final class CenterSpy: LocalNotificationCenter, @unchecked Sendable {

    // MARK: - Properties
    // Unchecked: each test awaits every call before the next one and before it reads, so no two calls overlap.
    private var authorized: Bool
    private let grants: Bool
    var pending: [String] = []
    private(set) var authorizationRequests = 0
    private(set) var removed: [[String]] = []
    private(set) var scheduled: [LocalNotification] = []
    private(set) var badges: [Int] = []

    // MARK: - Init
    init(authorized: Bool, grants: Bool) {
        self.authorized = authorized
        self.grants = grants
    }

    // MARK: - Protocol conformance
    func isAuthorized() async -> Bool { authorized }

    func requestAuthorization() async -> Bool {
        authorizationRequests += 1
        authorized = authorized || grants
        return authorized
    }

    func pendingIdentifiers() async -> [String] { pending }

    func removePending(_ identifiers: [String]) {
        removed.append(identifiers)
    }

    func schedule(_ notification: LocalNotification) async {
        scheduled.append(notification)
    }

    func setBadge(_ count: Int) async {
        badges.append(count)
    }
}
