import Foundation

/// What the app does with notifications apart from showing them, decided in the shared layer: registering this
/// device's APNs token, reading the reminders the device schedules itself and the number on its icon, and telling
/// where a tapped notification leads. A read that failed answers nil, so the device keeps what it has.
@MainActor
public protocol DeviceNotificationService: AnyObject {

    /// Uploads `deviceToken` for the signed-in person; answers whether the server registered it.
    func register(deviceToken: Data, environment: PushEnvironment) async -> Bool

    /// The reminders to schedule from `date` on, soonest first, replacing every one scheduled before.
    func reminders(from date: Date) async -> [DeviceReminder]?

    /// The number for the app icon, `0` for none.
    func badge() async -> Int?

    /// Where a notification with `payload` (`NotificationPayload.strings(of:)` of its user info) leads, or nil.
    func target(of payload: [String: String]) -> NotificationTarget?

    /// The `userInfo` of the local notification of `reminder`, which `target(of:)` reads back when it is tapped.
    func userInfo(of reminder: DeviceReminder) -> [String: String]

    /// Whether a silent push with `payload` asks the device to read its reminders again.
    func asksForReminders(_ payload: [String: String]) -> Bool
}
