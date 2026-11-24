import DesignSystem
import SwiftUI

/// The screen that covers the app while a wake-up mission rings: the camera waits for one of the mission's codes, the
/// app's own beep plays at full volume, and nothing on it closes it. After `WakeMission.tapFallbackDelay` the person
/// may tap `WakeMission.requiredTaps` times instead.
struct WakeGuardScreen: View {

    // MARK: - Dependencies
    @ObservedObject var wakeGuard: WakeGuard
    let mission: WakeMission

    // MARK: - State
    @StateObject private var scanner = CodeScanner()
    @State private var sound = WakeAlarmSound()
    @State private var tapping = false
    @State private var rejectedCode: String?
    @Environment(\.openURL)
    private var openURL

    // MARK: - Body
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if tapping {
                WakeTapChallenge(taps: wakeGuard.taps, required: WakeMission.requiredTaps) {
                    Task { await wakeGuard.tap() }
                } back: {
                    tapping = false
                }
            } else {
                scanning
            }
            VolumeEnforcer()
        }
        .preferredColorScheme(.dark)
        .contentShape(Rectangle())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AppIdentifiers.wakeGuard)
        .task {
            startSound()
            await scanner.start()
        }
        .onDisappear {
            scanner.stop()
            sound.stop()
        }
        .onChange(of: scanner.code) { _, code in
            guard let code else { return }
            Task { await check(code) }
        }
    }
}

// MARK: - Subviews
private extension WakeGuardScreen {

    var scanning: some View {
        VStack(spacing: Theme.Spacing.large) {
            header
            WakeCameraPreview(frame: scanner.frame, state: scanner.cameraState, rejected: rejectedCode != nil) {
                if let url = URL(string: "app-settings:") { openURL(url) }
            }
            .padding(.horizontal, Theme.Spacing.large)
            Text(String(format: String(localized: "wake.scan.hint"), locale: .current, mission.codes.count))
                .font(.callout)
                .foregroundStyle(.white.opacity(0.7))
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.large)
            Spacer(minLength: 0)
            fallback
        }
        .padding(.vertical, Theme.Spacing.large)
    }

    var header: some View {
        VStack(spacing: Theme.Spacing.small) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(context.date.formatted(date: .omitted, time: .shortened))
                    .font(.system(size: 64, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.white)
            }
            Text("wake.title")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
            Text(verbatim: mission.title)
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.6))
        }
        .padding(.top, Theme.Spacing.large)
    }

    var fallback: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let opensAt = wakeGuard.tapFallbackOpensAt ?? context.date
            if context.date >= opensAt {
                Button { tapping = true } label: {
                    Label { Text("wake.tap.open") } icon: { Image(systemName: "hand.tap.fill") }
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Theme.Spacing.medium)
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
                .padding(.horizontal, Theme.Spacing.large)
                .accessibilityIdentifier(AppIdentifiers.wakeGuardTapOpen)
            } else {
                Text(String(
                    format: String(localized: "wake.tap.later"),
                    locale: .current,
                    Self.remaining(until: opensAt, from: context.date)
                ))
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.5))
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.large)
            }
        }
    }

    func startSound() {
        do {
            try sound.start()
        } catch {
            wakeGuard.failure = String(describing: error)
        }
    }

    func check(_ code: String) async {
        guard !(await wakeGuard.submit(code: code)) else { return }
        rejectedCode = code
        try? await Task.sleep(for: .seconds(1.5))
        if rejectedCode == code { rejectedCode = nil }
    }

    /// `m:ss` until `date`.
    static func remaining(until date: Date, from now: Date) -> String {
        let seconds = max(0, Int(date.timeIntervalSince(now).rounded(.up)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
