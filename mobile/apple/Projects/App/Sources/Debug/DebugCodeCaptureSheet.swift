import DesignSystem
import SwiftUI

/// Reads one barcode or QR code with the camera for a new wake-up alarm; the first code read is handed back.
struct DebugCodeCaptureSheet: View {

    // MARK: - Dependencies
    let captured: (String) -> Void

    // MARK: - State
    @StateObject private var scanner = CodeScanner()
    @Environment(\.dismiss)
    private var dismiss
    @Environment(\.openURL)
    private var openURL

    // MARK: - Body
    var body: some View {
        NavigationStack {
            VStack(spacing: Theme.Spacing.large) {
                WakeCameraPreview(frame: scanner.frame, state: scanner.cameraState, rejected: false) {
                    if let url = URL(string: "app-settings:") { openURL(url) }
                }
                Text("debug.wake.capture.hint")
                    .font(.callout)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .multilineTextAlignment(.center)
                Spacer(minLength: 0)
            }
            .padding(Theme.Spacing.large)
            .navigationTitle(Text("debug.wake.capture.title"))
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Text("debug.wake.capture.cancel") }
                }
            }
        }
        .task { await scanner.start() }
        .onDisappear { scanner.stop() }
        .onChange(of: scanner.code) { _, code in
            if let code { captured(code) }
        }
        .accessibilityIdentifier(AppIdentifiers.debugWakeCapture)
    }
}
