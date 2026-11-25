import DesignSystem
import SwiftUI

@main
struct SemprecApp: App {

    // MARK: - Dependencies
    // The one platform difference of the app's entry: only iOS registers for remote notifications, which reach an app
    // only through its application delegate.
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self)
    private var appDelegate
    #endif

    @Environment(\.scenePhase)
    private var scenePhase

    // MARK: - Init
    init() {
        AppNotifications.shared.start()
    }

    // MARK: - Body
    var body: some Scene {
        WindowGroup {
            AppScene()
                .appAppearance()
                .wakeGuard()
                // The sleep plan may have changed elsewhere while the app was away: its alarms are read again. SwiftUI
                // cancels the pass when the phase changes again, and the clock runs one sync at a time.
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    await AppNotifications.shared.sleepAlarms?.sync()
                }
        }
    }
}
