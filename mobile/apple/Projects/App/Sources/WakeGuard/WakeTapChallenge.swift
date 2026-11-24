import DesignSystem
import SwiftUI

/// The tap fallback of the wake-up guard: the whole screen is one target, a ring fills with each tap, and the count
/// shows how many are left. The person can go back to scanning; the taps made so far stay.
struct WakeTapChallenge: View {

    // MARK: - Dependencies
    let taps: Int
    let required: Int
    let tap: () -> Void
    let back: () -> Void

    // MARK: - Body
    var body: some View {
        VStack(spacing: Theme.Spacing.large) {
            VStack(spacing: Theme.Spacing.small) {
                Text("wake.tap.title")
                    .font(.title2.weight(.semibold))
                Text("wake.tap.subtitle")
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
        .sensoryFeedback(.impact(weight: .light), trigger: taps)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AppIdentifiers.wakeGuardTap)
    }
}

// MARK: - Subviews
private extension WakeTapChallenge {

    var progress: Double {
        min(1, Double(taps) / Double(max(required, 1)))
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
                .animation(.spring(duration: 0.25), value: taps)
            VStack(spacing: 4) {
                Text(verbatim: "\(max(required - taps, 0))")
                    .font(.system(size: 72, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .animation(.snappy, value: taps)
                Text("wake.tap.left")
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
        .frame(width: 260, height: 260)
    }
}
