import CoreKit
import DesignSystem
import SwiftUI

/// One plan: its ring, the days you get up, whether its alarm is on, and deleting it.
struct SleepPlanPage: View {

    // MARK: - Dependencies
    let state: SleepState
    let send: (SleepAction) -> Void

    // MARK: - Body
    var body: some View {
        Form {
            if let ring = state.ring {
                SleepRingSection(ring: ring, isEnabled: state.enabled, send: send)
            }
            daysSection
            alarmSection
            if state.canDeletePlan {
                Section {
                    Button(role: .destructive) { send(.deletePlan) } label: {
                        Text("sleep.plan.delete", bundle: .module).frame(maxWidth: .infinity)
                    }
                    .accessibilityIdentifier(SleepIdentifiers.deletePlan)
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Subviews
private extension SleepPlanPage {

    var plan: SleepPlanItem? {
        state.plans.first { $0.id == state.selectedPlanID }
    }

    var daysSection: some View {
        Section {
            HStack(spacing: Theme.Spacing.small) {
                ForEach(1...7, id: \.self) { day in
                    dayButton(day)
                }
            }
            .accessibilityElement(children: .contain)
        } header: {
            Text("sleep.plan.days.header", bundle: .module)
        } footer: {
            Text("sleep.plan.days.hint", bundle: .module)
        }
    }

    @ViewBuilder
    func dayButton(_ day: Int) -> some View {
        let selected = plan?.wakeDays.contains(day) ?? false
        let taken = !selected && state.takenDaysByOtherPlans.contains(day)
        let button = Button { send(.toggleDay(day)) } label: {
            Text(SleepFormat.weekdayShort(day))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .frame(maxWidth: .infinity)
        }
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .accessibilityLabel(Text(dayLabel(day, selected: selected, taken: taken)))
        .accessibilityIdentifier(SleepIdentifiers.dayPrefix + String(day))
        .opacity(taken ? 0.4 : 1)
        if selected {
            button.buttonStyle(.borderedProminent)
        } else {
            button.buttonStyle(.bordered)
        }
    }

    func dayLabel(_ day: Int, selected: Bool, taken: Bool) -> String {
        let name = SleepFormat.weekdayLong(day)
        if selected { return name + String(localized: "sleep.plan.day.inPlan", bundle: .module) }
        if taken { return name + String(localized: "sleep.plan.day.otherPlan", bundle: .module) }
        return name
    }

    var alarmSection: some View {
        Section {
            Toggle(isOn: SleepBindings.isOn(plan?.alarm ?? false) { send(.setSwitch(.alarm, isOn: $0)) }) {
                SleepRow(
                    symbol: "bell.fill",
                    tint: .orange,
                    title: Text("sleep.plan.alarm", bundle: .module),
                    subtitle: alarmSubtitle
                )
            }
            .accessibilityLabel(Text("sleep.plan.alarm.a11y", bundle: .module))
            .accessibilityIdentifier(SleepIdentifiers.alarm)
        }
    }

    var alarmSubtitle: Text {
        guard let plan, plan.alarm else { return Text("sleep.plan.alarm.off", bundle: .module) }
        return Text(String(
            format: String(localized: "sleep.plan.alarm.on", bundle: .module),
            locale: .current,
            SleepFormat.time(plan.wakeMinutes),
            state.alarmSound.name
        ))
    }
}

// MARK: - Preview
#Preview("Plan") {
    SleepPlanPage(state: .previewReady.opening(.plan), send: { _ in })
}
