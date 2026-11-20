import Foundation
import UserNotifications

/// What the app asks of the system's notification center: the permission, its scheduled local notifications and the
/// number on the icon. Plain values cross it, so the main actor never holds the system's notification objects.
protocol LocalNotificationCenter: Sendable {

    /// Whether the person allowed notifications, without asking.
    func isAuthorized() async -> Bool

    /// Asks the person for alerts, sounds and the badge the first time; afterwards answers what they chose.
    func requestAuthorization() async -> Bool

    /// The identifiers of the local notifications waiting to be shown.
    func pendingIdentifiers() async -> [String]

    func removePending(_ identifiers: [String])

    func schedule(_ notification: LocalNotification) async

    func setBadge(_ count: Int) async
}

/// One local notification, shown at `date`.
struct LocalNotification: Equatable, Sendable {

    let identifier: String
    let title: String
    let body: String
    let userInfo: [String: String]
    let date: Date
}

/// The `LocalNotificationCenter` of the system. A refused request (no permission, an invalid date) changes nothing; the
/// next read of the reminders schedules them again.
struct SystemNotificationCenter: LocalNotificationCenter {

    // MARK: - Protocol conformance
    func isAuthorized() async -> Bool {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        return status == .authorized || status == .provisional
    }

    func requestAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let granted = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        return granted ?? false
    }

    func pendingIdentifiers() async -> [String] {
        await UNUserNotificationCenter.current().pendingNotificationRequests().map(\.identifier)
    }

    func removePending(_ identifiers: [String]) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: identifiers)
    }

    func schedule(_ notification: LocalNotification) async {
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = .default
        content.userInfo = notification.userInfo
        let components = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: notification.date
        )
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        let request = UNNotificationRequest(identifier: notification.identifier, content: content, trigger: trigger)
        try? await UNUserNotificationCenter.current().add(request)
    }

    func setBadge(_ count: Int) async {
        try? await UNUserNotificationCenter.current().setBadgeCount(count)
    }
}
