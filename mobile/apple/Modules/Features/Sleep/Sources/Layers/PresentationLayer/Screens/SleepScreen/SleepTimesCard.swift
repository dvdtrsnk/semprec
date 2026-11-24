import DesignSystem
import SwiftUI

/// Bedtime and wake-up of a schedule or a night: the two times, the dial that moves them, and the length against the
/// sleep goal. `onCommit` runs when a drag on the dial ends, for a screen that writes each change.
struct SleepTimesCard: View {

    // MARK: - Dependencies
    @Binding var draft: SleepScheduleDraft
    let goalMinutes: Int
    /// Whether the card shows one night rather than a schedule, which changes how the goal line reads.
    var isNight = false
    var onCommit: () -> Void = {}

    // MARK: - Body
    var body: some View {
        VStack(spacing: Theme.Spacing.medium) {
            HStack(alignment: .top) {
                timeColumn(
                    symbol: "bed.double.fill",
                    symbolColor: Theme.Colors.sleep,
                    title: Text("sleep.editor.bed", bundle: .module),
                    minutes: draft.bedMinutes,
                    emphasized: true
                )
                timeColumn(
                    symbol: "alarm",
                    symbolColor: Theme.Colors.secondaryText,
                    title: draft.alarm
                        ? Text("sleep.editor.alarm", bundle: .module)
                        : Text("sleep.editor.wakeNoAlarm", bundle: .module),
                    minutes: draft.wakeMinutes,
                    emphasized: draft.alarm
                )
            }
            SleepDial(draft: $draft, meetsGoal: meetsGoal, onEnd: onCommit)
                .padding(.horizontal, Theme.Spacing.small)
            VStack(spacing: 4) {
                Text(SleepFormat.longDuration(draft.durationMinutes))
                    .font(.title.weight(.semibold))
                    .monospacedDigit()
                goalLine
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
            }
            .padding(.bottom, Theme.Spacing.small)
        }
        .padding(Theme.Spacing.medium)
        .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }
}

// MARK: - Subviews
private extension SleepTimesCard {

    var meetsGoal: Bool {
        draft.durationMinutes >= goalMinutes
    }

    var metKey: LocalizedStringKey {
        isNight ? "sleep.night.goal.met" : "sleep.editor.goal.met"
    }

    var missedKey: LocalizedStringKey {
        isNight ? "sleep.night.goal.missed" : "sleep.editor.goal.missed"
    }

    func timeColumn(symbol: String, symbolColor: Color, title: Text, minutes: Int, emphasized: Bool) -> some View {
        VStack(spacing: 2) {
            Label { title } icon: { Image(systemName: symbol).foregroundStyle(symbolColor) }
                .font(.footnote.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(Theme.Colors.secondaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(SleepFormat.time(minutes))
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(emphasized ? Color.primary : Theme.Colors.secondaryText)
                .contentTransition(.numericText())
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder var goalLine: some View {
        if meetsGoal {
            Text(metKey, bundle: .module)
                .foregroundStyle(Theme.Colors.secondaryText)
        } else {
            Label {
                Text(missedKey, bundle: .module)
            } icon: {
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
            }
            .foregroundStyle(Theme.Colors.secondaryText)
        }
    }
}
