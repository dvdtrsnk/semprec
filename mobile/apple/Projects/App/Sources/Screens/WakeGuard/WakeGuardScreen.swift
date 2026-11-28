import CoreKit
import DesignSystem
import SwiftUI

/// The screen that covers a window while a wake mission rings: the camera waits for one of the mission's codes, the
/// app's own beep plays, and nothing on it closes it. Once the shared guard opens the fallback, the person may tap
/// instead of scanning, on a screen of its own. The camera, the sound and the hold that keeps the device's volume at
/// its maximum run only while this window's scene is the active one.
struct WakeGuardScreen: View {

    // MARK: - Dependencies
    @ObservedObject var viewModel: WakeGuardViewModel

    // MARK: - State
    @StateObject private var scanner = DeviceCodeScanner()
    @StateObject private var beep = DeviceAlarmBeep()
    @State private var isRejecting = false
    @Environment(\.scenePhase)
    private var scenePhase

    // MARK: - Body
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            switch state.phase {
            case .tapping:
                WakeTapScreen(
                    state: state,
                    tap: { viewModel.send(.tap) },
                    back: { viewModel.send(.backToScanning) }
                )
            case .scanning, .idle:
                scanning
            }
        }
        .preferredColorScheme(.dark)
        .contentShape(Rectangle())
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("wake.guard.a11y"))
        .accessibilityIdentifier(AppIdentifiers.wakeGuard)
        .task(id: scansNow) {
            guard scansNow else { return }
            await scanner.run { viewModel.send(.codeScanned($0)) }
        }
        .background { DeviceVolumeHold(isHeld: holdsVolumeNow) }
        .task(id: soundsNow) {
            guard soundsNow else { return }
            await beep.play()
        }
        .task(id: viewModel.rejections) { await markRejection() }
        .sensoryFeedback(.success, trigger: viewModel.finishes)
    }
}

// MARK: - Subviews
private extension WakeGuardScreen {

    var state: WakeGuardState {
        viewModel.state
    }

    /// The camera reads only while this scene is the active one and the person is asked to scan.
    var scansNow: Bool {
        scenePhase == .active && state.phase == .scanning
    }

    var soundsNow: Bool {
        scenePhase == .active && state.phase != .idle
    }

    /// The device's volume is held up while the shared guard says so and this scene is the active one.
    var holdsVolumeNow: Bool {
        scenePhase == .active && state.holdsVolume
    }

    var scanning: some View {
        VStack(spacing: Theme.Spacing.large) {
            header
            viewfinder
                .overlay(alignment: .bottom) { rejection }
                .padding(.horizontal, Theme.Spacing.large)
            Text(String(format: String(localized: "wake.scan.hint"), locale: .current, state.codeCount))
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
            title
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
        }
        .padding(.top, Theme.Spacing.large)
    }

    @ViewBuilder var title: some View {
        switch state.titleKind {
        case .sleepAlarm: Text("wake.title.sleepAlarm")
        }
    }

    @ViewBuilder var viewfinder: some View {
        switch scanner.state {
        case .starting, .running:
            Viewfinder(frame: scanner.frame, isRejected: isRejecting)
        case .denied:
            Viewfinder {
                ViewfinderMessage(Text("wake.camera.denied"), settingsTitle: Text("wake.camera.settings"))
            }
        case .unavailable:
            Viewfinder { ViewfinderMessage(Text("wake.camera.unavailable")) }
        }
    }

    @ViewBuilder var rejection: some View {
        if isRejecting {
            Text("wake.scan.wrong")
                .font(.callout.weight(.semibold))
                .padding(.horizontal, Theme.Spacing.medium)
                .padding(.vertical, Theme.Spacing.small)
                .background(.red, in: Capsule())
                .foregroundStyle(.white)
                .padding(Theme.Spacing.medium)
                .transition(.opacity)
        }
    }

    /// The button that opens the tap challenge, or what tells when it opens.
    @ViewBuilder var fallback: some View {
        if state.fallbackOpen {
            Button { viewModel.send(.openTapFallback) } label: {
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
            VStack(spacing: Theme.Spacing.small) {
                Text(String(format: String(localized: "wake.tap.hint"), locale: .current, state.fallbackDelayMinutes))
                if let opensAt = state.fallbackOpensAt {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(String(
                            format: String(localized: "wake.tap.countdown"),
                            locale: .current,
                            Self.remaining(until: opensAt, from: context.date)
                        ))
                    }
                }
            }
            .font(.footnote)
            .foregroundStyle(.white.opacity(0.5))
            .multilineTextAlignment(.center)
            .padding(.horizontal, Theme.Spacing.large)
        }
    }

    /// Marks the viewfinder for a moment after the shared guard rejected a code. A newer rejection or the screen going
    /// away cancels the wait.
    func markRejection() async {
        guard viewModel.rejections > 0 else { return }
        isRejecting = true
        do {
            try await Task.sleep(for: .seconds(1.5))
        } catch {
            return
        }
        isRejecting = false
    }

    /// The minutes and seconds until `date`, written as the person's locale writes a time span.
    static func remaining(until date: Date, from now: Date) -> String {
        let seconds = max(0, Int(date.timeIntervalSince(now).rounded(.up)))
        return Duration.seconds(seconds).formatted(.time(pattern: .minuteSecond))
    }
}

// MARK: - Preview
@MainActor
private func previewScreen(_ state: WakeGuardState) -> some View {
    WakeGuardScreen(viewModel: WakeGuardViewModel(model: ScriptedWakeGuardScreenModel(state: state)))
}

#Preview("Scanning") {
    previewScreen(WakeGuardState(
        phase: .scanning,
        fallbackOpensAt: Date().addingTimeInterval(540),
        codeCount: 2
    ))
}

#Preview("The tap challenge is open") {
    previewScreen(WakeGuardState(phase: .scanning, fallbackOpen: true, codeCount: 1))
}
