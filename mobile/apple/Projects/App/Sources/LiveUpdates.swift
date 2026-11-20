import CoreKit
import SwiftUI

/// Keeps the sync socket of a signed-in scene connected while the scene is not in the background: it starts when the
/// scene shows its tabs or comes back from the background, and stops when the scene goes to the background or stops
/// showing its tabs (signed out, or the window closed).
struct LiveUpdates: ViewModifier {

    // MARK: - Dependencies
    let models: any ScreenModelFactory
    @Environment(\.scenePhase)
    private var scenePhase

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .onChange(of: scenePhase, initial: true) { _, phase in
                if phase == .background {
                    models.stopLiveUpdates()
                } else {
                    models.startLiveUpdates()
                }
            }
            .onDisappear { models.stopLiveUpdates() }
    }
}
