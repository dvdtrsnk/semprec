import DesignSystem
import SwiftUI

@main
struct AlldotsApp: App {

    // MARK: - Dependencies
    // The one platform difference of the app's entry: only iOS registers for remote notifications, which reach an app
    // only through its application delegate.
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self)
    private var appDelegate
    #endif

    // MARK: - Init
    init() {
        AppNotifications.shared.start()
    }

    // MARK: - Body
    var body: some Scene {
        WindowGroup {
            AppScene(composition: AppComposition(
                deviceServices: AppNotifications.shared.deviceServices,
                notifications: .shared
            ))
            .appAppearance()
        }
    }
}
