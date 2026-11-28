#if os(iOS)
import CoreKit
import SwiftUI

/// The iOS application delegate, which SwiftUI creates through `UIApplicationDelegateAdaptor` in `AlldotsApp`: the
/// only way an iOS app receives its APNs device token and its silent pushes. It hands both to `AppNotifications` and
/// decides nothing itself. It is also where the background tasks of the Inbox captures are registered, because the
/// system requires that before the app finishes launching. The UIKit types reach it through SwiftUI; the app imports
/// no UIKit. macOS registers for no remote notifications and has no such delegate.
final class AppDelegate: NSObject, UIApplicationDelegate {

    // MARK: - UIApplicationDelegate
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        AppNotifications.shared.registerForRemoteNotifications = {
            UIApplication.shared.registerForRemoteNotifications()
        }
        CaptureSending.shared.backgroundTasks.register()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await AppNotifications.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any]
    ) async -> UIBackgroundFetchResult {
        let payload = NotificationPayload.strings(of: userInfo)
        return await AppNotifications.shared.didReceiveRemoteNotification(payload) ? .newData : .noData
    }
}
#endif
