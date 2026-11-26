import CoreKit
import DesignSystem
import SwiftUI

/// One night, edited like a schedule: bedtime and wake-up on the dial, its length against the goal, whether the alarm
/// rings that night, going back to the schedule, and the way to the full schedule. The dial and the switch change the
/// shared draft of the night; it is written once, when a drag on the dial ends or the alarm switches, and only that
/// night changes.
struct SleepNightPage: View {

    // MARK: - Dependencies
    let state: SleepState
    let send: (SleepAction) -> Void

    // MARK: - Body
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                if let draft = state.nightDraft {
                    header("sleep.editor.times")
                    SleepTimesCard(draft: draft, send: send, isNight: true, onEnd: actions.dragEnded)
                        .accessibilityIdentifier(SleepIdentifiers.nightTimes)
                    header("sleep.editor.alarmOptions")
                    Toggle(isOn: SleepBindings.isOn(draft.alarm) { actions.setAlarm($0) }) {
                        Text("sleep.editor.alarmToggle", bundle: .module)
                    }
                    .padding(Theme.Spacing.medium)
                    .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                    .accessibilityIdentifier(SleepIdentifiers.alarm)
                }
                Text(hint)
                    .font(.footnote)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .padding(.horizontal, Theme.Spacing.medium)
                if state.night?.changed == true { resetButton }
                plansButton
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.bottom, Theme.Spacing.large)
        }
        .background(Theme.Colors.groupedBackground)
    }
}

// MARK: - Subviews
private extension SleepNightPage {

    var actions: SleepNightActions {
        SleepNightActions(send: send)
    }

    func header(_ key: LocalizedStringKey) -> some View {
        Text(key, bundle: .module)
            .font(.headline)
            .foregroundStyle(Theme.Colors.secondaryText)
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.top, Theme.Spacing.small)
    }

    var resetButton: some View {
        Button { send(.resetNight) } label: {
            Text("sleep.night.reset", bundle: .module)
                .frame(maxWidth: .infinity)
                .padding(Theme.Spacing.medium)
                .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.Colors.appAccent)
        .accessibilityIdentifier(SleepIdentifiers.resetNight)
    }

    var plansButton: some View {
        Button { send(.open(.main)) } label: {
            HStack {
                Text("sleep.night.openPlans", bundle: .module).foregroundStyle(Color.primary)
                Spacer(minLength: Theme.Spacing.small)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(Theme.Spacing.medium)
            .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(SleepIdentifiers.openPlans)
    }

    /// Whether the night follows its plan, differs from it or has none, and when the reminder fires.
    var hint: String {
        let reminder = state.night?.reminderMinutes.map {
            String(
                format: String(localized: "sleep.night.hint.reminder", bundle: .module),
                locale: .current,
                SleepFormat.time($0)
            )
        }
        return planHint + (reminder ?? "")
    }

    var planHint: String {
        guard let night = state.night, let name = night.planName else {
            return String(localized: "sleep.night.hint.noPlan", bundle: .module)
        }
        let key: String.LocalizationValue = night.changed ? "sleep.night.hint.changed" : "sleep.night.hint.plan"
        return String(format: String(localized: key, bundle: .module), locale: .current, name)
    }
}

// MARK: - Preview
#Preview("Night") {
    SleepNightPage(state: .previewReady.opening(.night), send: { _ in })
}

#Preview("Night below the goal") {
    SleepNightPage(state: .previewReady.opening(.night, draft: .previewShort), send: { _ in })
}
