import CoreKit
import DesignSystem
import SwiftUI

/// The tap challenge of the wake guard: the whole screen is one target, a ring fills with each tap, and the caption
/// says how many taps are left. The person can go back to scanning; the taps made so far stay.
struct WakeTapScreen: View {

    // MARK: - Dependencies
    let state: WakeGuardState
    let tap: () -> Void
    let back: () -> Void

    // MARK: - Body
    var body: some View {
        VStack(spacing: Theme.Spacing.large) {
            VStack(spacing: Theme.Spacing.small) {
                Text("wake.tap.title")
                    .font(.title2.weight(.semibold))
                Text(String(format: String(localized: "wake.tap.subtitle"), locale: .current, state.requiredTaps))
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.6))
                    .multilineTextAlignment(.center)
            }
            .padding(.top, Theme.Spacing.hero)
            Spacer(minLength: 0)
            ring
            Spacer(minLength: 0)
            Button(action: back) {
                Label { Text("wake.tap.back") } icon: { Image(systemName: "qrcode.viewfinder") }
            }
            .buttonStyle(.bordered)
            .tint(.white)
            .accessibilityIdentifier(AppIdentifiers.wakeGuardTapBack)
        }
        .foregroundStyle(.white)
        .padding(Theme.Spacing.large)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture(perform: tap)
        .sensoryFeedback(.impact(weight: .light), trigger: state.tapsLeft)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AppIdentifiers.wakeGuardTap)
    }
}

// MARK: - Subviews
private extension WakeTapScreen {

    /// How much of the ring is filled, from the taps the shared guard counted.
    var progress: Double {
        min(1, Double(state.requiredTaps - state.tapsLeft) / Double(max(state.requiredTaps, 1)))
    }

    var ring: some View {
        ZStack {
            Circle().stroke(.white.opacity(0.12), lineWidth: 18)
            Circle()
                .trim(from: 0, to: progress)
                .stroke(
                    AngularGradient(colors: [.orange, .pink, .orange], center: .center),
                    style: StrokeStyle(lineWidth: 18, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
                .animation(.spring(duration: 0.25), value: state.tapsLeft)
            Text(String(format: String(localized: "wake.tap.left"), locale: .current, state.tapsLeft))
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .multilineTextAlignment(.center)
                .contentTransition(.numericText())
                .animation(.snappy, value: state.tapsLeft)
                .padding(Theme.Spacing.large)
        }
        .frame(width: 260, height: 260)
    }
}

// MARK: - Preview
#Preview("Tapping") {
    WakeTapScreen(
        state: WakeGuardState(phase: .tapping, tapsLeft: 137, fallbackOpen: true, codeCount: 1),
        tap: {},
        back: {}
    )
    .background(.black)
}

#Preview("The last tap") {
    WakeTapScreen(
        state: WakeGuardState(phase: .tapping, tapsLeft: 1, fallbackOpen: true, codeCount: 1),
        tap: {},
        back: {}
    )
    .background(.black)
}
