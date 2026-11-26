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
        // A task per code read: SwiftUI cancels it when another code arrives or the screen goes away.
        .task(id: scanner.code) {
            guard let code = scanner.code else { return }
            await check(code)
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
        // Cancelled when the screen goes away or another code arrives; the mark then clears with the next code.
        do {
            try await Task.sleep(for: .seconds(1.5))
        } catch {
            return
        }
        if rejectedCode == code { rejectedCode = nil }
    }

    /// The minutes and seconds until `date`, written as the person's locale writes a time span.
    static func remaining(until date: Date, from now: Date) -> String {
        let seconds = max(0, Int(date.timeIntervalSince(now).rounded(.up)))
        return Duration.seconds(seconds).formatted(.time(pattern: .minuteSecond))
    }
}
