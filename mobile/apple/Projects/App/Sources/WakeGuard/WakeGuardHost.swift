import SwiftUI

/// Covers a window with the wake-up guard while a mission rings. It asks the guard again when the app becomes active
/// and every two seconds while the window is on screen, so a mission that starts ringing while the app is open covers
/// it within two seconds. The guard sits above the window's content and takes every touch.
struct WakeGuardHost: ViewModifier {

    // MARK: - Dependencies
    @ObservedObject var wakeGuard: WakeGuard
    @Environment(\.scenePhase)
    private var scenePhase

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .overlay {
                if let mission = wakeGuard.ringing {
                    WakeGuardScreen(wakeGuard: wakeGuard, mission: mission)
                        .ignoresSafeArea()
                        .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.3), value: wakeGuard.ringing?.id)
            .task {
                while !Task.isCancelled {
                    await wakeGuard.refresh()
                    try? await Task.sleep(for: .seconds(2))
                }
            }
            // Becoming active refreshes at once; SwiftUI cancels the pass when the phase changes again.
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                await wakeGuard.refresh()
            }
    }
}

// MARK: - View
extension View {

    /// Covers the view with the wake-up guard while one of `wakeGuard`'s missions rings.
    func wakeGuard(_ wakeGuard: WakeGuard = .shared) -> some View {
        modifier(WakeGuardHost(wakeGuard: wakeGuard))
    }
}
