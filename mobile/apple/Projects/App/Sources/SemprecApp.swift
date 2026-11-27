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
    /// The phase of the app as a whole: active while any window is, in the background once every window is.
    @Environment(\.scenePhase)
    private var scenePhase

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
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: Task { await CaptureSending.shared.appBecameActive() }
            case .background: Task { await CaptureSending.shared.appMovedToBackground() }
            case .inactive: break
            @unknown default: break
            }
        }
    }
}
