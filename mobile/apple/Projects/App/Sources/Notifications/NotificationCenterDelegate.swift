import CoreKit
import Foundation
import UserNotifications

/// Receives from the system's notification center what the person does with a notification. A notification that
/// arrives while the app is open is shown as a banner; a tap hands the notification's custom keys to `opened` on the
/// main actor.
final class NotificationCenterDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {

    // MARK: - Dependencies
    private let opened: @MainActor @Sendable ([String: String]) -> Void

    // MARK: - Init
    init(opened: @escaping @MainActor @Sendable ([String: String]) -> Void) {
        self.opened = opened
    }

    // MARK: - UNUserNotificationCenterDelegate
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let payload = NotificationPayload.strings(of: response.notification.request.content.userInfo)
        let opened = opened
        Task { @MainActor in opened(payload) }
        completionHandler()
    }
}
