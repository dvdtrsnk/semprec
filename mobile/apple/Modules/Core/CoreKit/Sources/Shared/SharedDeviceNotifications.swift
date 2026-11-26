import Foundation
@preconcurrency internal import SharedSDK

/// The Kotlin `DeviceNotifications` and `SleepAlarmSync` of the process as a `DeviceNotificationService` and a
/// `SleepAlarmService`. Their calls go out with the session the windows sign in to, and it shares the stored push
/// subscription with their screen model factories, whose sign-out revokes it.
@MainActor
public final class SharedDeviceNotifications {

    // MARK: - Dependencies
    let notifications: SharedSDK.DeviceNotifications
    let sleepAlarms: SharedSDK.SleepAlarmSync
    /// The wake missions and the sleep alarm sync, which the process's owner hands to every scene's model factory.
    public let deviceServices: DeviceServices
    private let platform: SharedSDK.AppPlatform

    // MARK: - Init
    /// `sessionStore` must be the store of the windows' `SharedScreenModelFactory`.
    public init(sessionStore: SharedScreenModelFactory.SessionStore = .keychain) {
        let sdk = switch sessionStore {
        case .keychain:
            SharedSDK.DevicePushSDK(
                sessionStorage: KeychainSessionStorage(),
                subscriptions: DefaultsPushSubscriptionStorage(),
                alarms: DeviceAlarmScheduler(),
                sleepAlarmLedger: DefaultsSleepAlarmLedger(),
                wakeStorage: DefaultsWakeStorage()
            )
        case .memory:
            SharedSDK.DevicePushSDK(
                sessionStorage: SharedSDK.InMemorySessionStorage(),
                subscriptions: SharedSDK.InMemoryPushSubscriptionStorage(),
                alarms: SharedSDK.UnavailableDeviceAlarms(),
                sleepAlarmLedger: SharedSDK.InMemorySleepAlarmLedger(),
                wakeStorage: SharedSDK.InMemoryWakeStorage()
            )
        }
        notifications = sdk.notifications
        sleepAlarms = sdk.sleepAlarms
        deviceServices = DeviceServices(wake: sdk.wake, sleepAlarms: sdk.sleepAlarms)
        platform = DeviceIdentity.current().platform
    }
}

// MARK: - Protocol conformance
extension SharedDeviceNotifications: DeviceNotificationService {

    public func register(deviceToken: Data, environment: PushEnvironment) async -> Bool {
        let registered = try? await notifications.register(
            deviceToken: Self.hex(deviceToken),
            environment: Self.environment(environment),
            platform: platform
        )
        return registered?.boolValue ?? false
    }

    public func reminders(from date: Date) async -> [DeviceReminder]? {
        guard let read = try? await notifications.reminders(from: Self.instant(date)) else { return nil }
        return read.compactMap(Self.reminder)
    }

    public func badge() async -> Int? {
        guard let badge = try? await notifications.badge() else { return nil }
        return badge.intValue
    }

    public func target(of payload: [String: String]) -> NotificationTarget? {
        notifications.target(payload: payload).map(Self.target)
    }

    public func userInfo(of reminder: DeviceReminder) -> [String: String] {
        notifications.payload(reminder: Self.sharedReminder(reminder))
    }

    public func resync(of payload: [String: String]) -> DeviceResync? {
        notifications.resync(payload: payload).map(Self.resync)
    }
}

// MARK: - Protocol conformance
extension SharedDeviceNotifications: SleepAlarmService {

    public func syncSleepAlarms() async -> SleepAlarmSyncResult? {
        do {
            return Self.result(try await sleepAlarms.sync())
        } catch {
            return nil
        }
    }

    public func removeSleepAlarms() async -> SleepAlarmSyncResult? {
        do {
            return Self.result(try await sleepAlarms.signedOut())
        } catch {
            return nil
        }
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedDeviceNotifications {

    /// The token's bytes in lower-case hex, as APNs addresses a device.
    static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    static func environment(_ environment: PushEnvironment) -> SharedSDK.ApnsEnvironment {
        switch environment {
        case .sandbox: .sandbox
        case .production: .production
        }
    }

    static func target(_ target: any SharedSDK.NotificationTarget) -> NotificationTarget {
        switch onEnum(of: target) {
        case .event(let event): .event(id: event.eventId)
        case .task(let task): .task(id: task.taskId)
        case .invitations: .invitations
        }
    }

    static func resync(_ resync: SharedSDK.DeviceResync) -> DeviceResync {
        switch resync {
        case .reminders: .reminders
        case .sleepAlarms: .sleepAlarms
        }
    }

    static func result(_ result: SharedSDK.SleepAlarmSyncResult) -> SleepAlarmSyncResult {
        switch result {
        case .synced: .synced
        case .unsupported: .unsupported
        case .readFailed: .readFailed
        case .notAuthorized: .notAuthorized
        case .limitReached: .limitReached
        case .deviceFailed: .deviceFailed
        }
    }

    static func instant(_ date: Date) -> String {
        date.formatted(.iso8601)
    }

    /// The server writes instants with milliseconds; one without them is read too. A reminder whose instants cannot
    /// be read is left out.
    static func date(_ instant: String) -> Date? {
        if let date = try? Date(instant, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) {
            return date
        }
        return try? Date(instant, strategy: .iso8601)
    }

    static func reminder(_ reminder: SharedSDK.DeviceReminder) -> DeviceReminder? {
        guard let fireAt = date(reminder.fireAt), let startsAt = date(reminder.startsAt) else { return nil }
        return DeviceReminder(
            identifier: reminder.identifier,
            kind: kind(reminder.kind),
            itemId: reminder.itemId,
            title: reminder.title,
            fireAt: fireAt,
            startsAt: startsAt
        )
    }

    static func kind(_ kind: SharedSDK.DeviceReminderKind) -> DeviceReminderKind {
        switch kind {
        case .event: .event
        case .task: .task
        }
    }

    static func sharedKind(_ kind: DeviceReminderKind) -> SharedSDK.DeviceReminderKind {
        switch kind {
        case .event: .event
        case .task: .task
        }
    }

    static func sharedReminder(_ reminder: DeviceReminder) -> SharedSDK.DeviceReminder {
        SharedSDK.DeviceReminder(
            identifier: reminder.identifier,
            kind: sharedKind(reminder.kind),
            itemId: reminder.itemId,
            title: reminder.title,
            fireAt: instant(reminder.fireAt),
            startsAt: instant(reminder.startsAt)
        )
    }
}
