import SwiftUI

/// Keeps the system alarms of the sleep plan in step while a signed-in scene is on screen: when the scene shows its
/// tabs and each time it becomes active again. The task ends with the scene's phase, and a cancelled run ends quietly.
struct SleepAlarmUpkeep: ViewModifier {

    // MARK: - Dependencies
    let notifications: AppNotifications?
    @Environment(\.scenePhase)
    private var scenePhase

    // MARK: - Body
    func body(content: Content) -> some View {
        content.task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await notifications?.syncSleepAlarms()
        }
    }
}
