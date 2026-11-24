import CoreKit
import DesignSystem
import SwiftUI

/// The full schedule on the overview: a card per schedule with its days, bedtime and wake-up and an Edit button, a
/// card that adds one, and the further details, the wind-down before bedtime and the sleep goal.
struct SleepScheduleSections: View {

    // MARK: - Dependencies
    let state: SleepState
    let send: (SleepAction) -> Void
    /// Opens the schedule editor on a plan, or on a new schedule for nil.
    let edit: (SleepPlanItem?) -> Void

    // MARK: - Body
    var body: some View {
        ForEach(Array(state.plans.enumerated()), id: \.element.id) { index, plan in
            Section {
                card(plan)
                Button { edit(plan) } label: { Text("sleep.schedule.edit", bundle: .module) }
                    .listRowButton()
                    .accessibilityIdentifier(SleepIdentifiers.planPrefix + plan.id)
            } header: {
                if index == 0 { largeHeader("sleep.schedule.title") }
            }
            .sectionSpacing(Self.cardSpacing)
        }
        Section {
            Button { edit(nil) } label: { Text("sleep.schedule.add", bundle: .module) }
                .listRowButton()
                .accessibilityIdentifier(SleepIdentifiers.addPlan)
        } header: {
            if state.plans.isEmpty { largeHeader("sleep.schedule.title") }
        }
        .sectionSpacing(Self.cardSpacing)
        Section {
            detailRow("sleep.schedule.windDown", value: SleepFormat.duration(state.prepReminderMinutes)) {
                send(.open(.remind, planID: nil))
            }
            .accessibilityIdentifier(SleepIdentifiers.reminderLead)
        } header: {
            largeHeader("sleep.schedule.details")
        }
        .sectionSpacing(Self.cardSpacing)
        Section {
            detailRow("sleep.schedule.goal", value: SleepFormat.longDuration(state.goalMinutes)) {
                send(.open(.goal, planID: nil))
            }
            .accessibilityIdentifier(SleepIdentifiers.goal)
        }
    }
}

// MARK: - Subviews
private extension SleepScheduleSections {

    /// The gap between the cards of the schedule, tighter than between the other sections of the form.
    static let cardSpacing: CGFloat = 14

    func largeHeader(_ key: LocalizedStringKey) -> some View {
        Text(key, bundle: .module)
            .font(.title2.bold())
            .foregroundStyle(Color.primary)
            .textCase(nil)
            .padding(.bottom, 2)
    }

    func card(_ plan: SleepPlanItem) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: daysText(plan))
                .font(.headline)
                .foregroundStyle(Theme.Colors.sleep)
            HStack(alignment: .top, spacing: 0) {
                timeColumn(
                    symbol: "bed.double.fill",
                    symbolColor: Theme.Colors.sleep,
                    title: Text("sleep.editor.bed", bundle: .module),
                    minutes: plan.bedMinutes,
                    emphasized: true
                )
                .frame(width: 140, alignment: .leading)
                timeColumn(
                    symbol: "alarm",
                    symbolColor: Theme.Colors.secondaryText,
                    title: plan.alarm
                        ? Text("sleep.editor.alarm", bundle: .module)
                        : Text("sleep.editor.wakeNoAlarm", bundle: .module),
                    minutes: plan.wakeMinutes,
                    emphasized: plan.alarm
                )
                Spacer(minLength: 0)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    func daysText(_ plan: SleepPlanItem) -> String {
        guard !plan.wakeDays.isEmpty else { return String(localized: "sleep.schedule.noDays", bundle: .module) }
        return SleepFormat.days(plan.wakeDays)
    }

    func timeColumn(symbol: String, symbolColor: Color, title: Text, minutes: Int, emphasized: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 3) {
                Image(systemName: symbol).foregroundStyle(symbolColor)
                title.textCase(.uppercase).foregroundStyle(Theme.Colors.secondaryText)
            }
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            Text(SleepFormat.time(minutes))
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(emphasized ? Color.primary : Theme.Colors.secondaryText)
        }
    }

    func detailRow(_ key: LocalizedStringKey, value: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(key, bundle: .module).foregroundStyle(Color.primary)
                Spacer(minLength: Theme.Spacing.small)
                Text(verbatim: value).foregroundStyle(Theme.Colors.appAccent)
            }
            .contentShape(Rectangle())
        }
        .listRowButton()
    }
}
