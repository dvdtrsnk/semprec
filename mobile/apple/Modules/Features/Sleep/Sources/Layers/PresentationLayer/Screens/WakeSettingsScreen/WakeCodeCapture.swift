import CoreKit
import DesignSystem
import SwiftUI

/// Reads one barcode or QR code with the camera; the first code read is handed to `captured`. The camera runs for
/// as long as this view is on screen.
struct WakeCodeCapture: View {

    // MARK: - Dependencies
    let captured: @MainActor @Sendable (String) -> Void

    // MARK: - State
    @StateObject private var scanner = DeviceCodeScanner()

    // MARK: - Body
    var body: some View {
        VStack(spacing: Theme.Spacing.large) {
            viewfinder
            Text("sleep.wake.capture.hint", bundle: .module)
                .font(.callout)
                .foregroundStyle(.white.opacity(0.7))
                .multilineTextAlignment(.center)
            Spacer(minLength: 0)
        }
        .padding(Theme.Spacing.large)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.ignoresSafeArea())
        .task { await scanner.run(onCode: captured) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(SleepIdentifiers.wakeCapture)
    }
}

// MARK: - Subviews
private extension WakeCodeCapture {

    @ViewBuilder var viewfinder: some View {
        switch scanner.state {
        case .starting, .running:
            Viewfinder(frame: scanner.frame)
        case .denied:
            Viewfinder {
                ViewfinderMessage(
                    Text("sleep.wake.camera.denied", bundle: .module),
                    settingsTitle: Text("sleep.wake.camera.settings", bundle: .module)
                )
            }
        case .unavailable:
            Viewfinder { ViewfinderMessage(Text("sleep.wake.camera.unavailable", bundle: .module)) }
        }
    }
}
