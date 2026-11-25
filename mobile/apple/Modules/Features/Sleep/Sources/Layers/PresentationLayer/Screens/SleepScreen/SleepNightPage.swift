import CoreKit
import DesignSystem
import SwiftUI

/// One night, edited like a schedule: bedtime and wake-up on the dial, its length against the goal, whether the alarm
/// rings that night, going back to the schedule, and the way to the full schedule. A change is written once, when a
/// drag on the dial ends or the alarm switches, and only that night changes.
struct SleepNightPage: View {

    // MARK: - Dependencies
    let state: SleepState
    let send: (SleepAction) -> Void

    // MARK: - State
    @State private var draft: SleepScheduleDraft

    // MARK: - Init
    init(state: SleepState, send: @escaping (SleepAction) -> Void) {
        self.state = state
        self.send = send
        _draft = State(initialValue: Self.draft(state))
    }

    // MARK: - Body
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                header("sleep.editor.times")
                SleepTimesCard(draft: $draft, goalMinutes: state.goalMinutes, isNight: true, onCommit: commit)
                    .accessibilityIdentifier(SleepIdentifiers.nightTimes)
                header("sleep.editor.alarmOptions")
                Toggle(isOn: alarm) { Text("sleep.editor.alarmToggle", bundle: .module) }
                    .padding(Theme.Spacing.medium)
                    .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                    .accessibilityIdentifier(SleepIdentifiers.alarm)
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
        // What the night shows changed (the night itself, or the plan's ring while no night is read): the dial follows.
        .onChange(of: Self.draft(state)) { _, shown in draft = shown }
    }
}

// MARK: - Subviews
private extension SleepNightPage {

    /// The night's times and alarm, or the plan's ring while the night is not read yet.
    static func draft(_ state: SleepState) -> SleepScheduleDraft {
        SleepScheduleDraft(
            days: [],
            bedMinutes: state.night?.bedMinutes ?? state.ring?.bedMinutes ?? 23 * 60,
            wakeMinutes: state.night?.wakeMinutes ?? state.ring?.wakeMinutes ?? 7 * 60,
            alarm: state.night?.alarm ?? state.ring?.alarm ?? false,
            lengths: state.shortestNightMinutes...state.longestNightMinutes
        )
    }

    var alarm: Binding<Bool> {
        Binding(
            get: { draft.alarm },
            set: {
                draft.alarm = $0
                commit()
            }
        )
    }

    /// Writes the night as the dial shows it, unless nothing changed.
    func commit() {
        guard draft != Self.draft(state) else { return }
        send(.saveNight(bedMinutes: draft.bedMinutes, wakeMinutes: draft.wakeMinutes, alarm: draft.alarm))
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
        Button { send(.open(.main, planID: nil)) } label: {
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
