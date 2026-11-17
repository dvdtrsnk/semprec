import CoreKit
import DesignSystem
import SwiftUI

/// The overview of the sleep sheet: the ring, the plan switch and the plans, the preparation reminder, the alarm
/// settings and what the calendar shows.
struct SleepMainPage: View {

    // MARK: - Dependencies
    let state: SleepState
    let send: (SleepAction) -> Void

    // MARK: - Body
    var body: some View {
        Form {
            if let ring = state.ring {
                SleepRingSection(ring: ring, isEnabled: state.enabled, send: send)
            }
            enabledSection
            plansSection
            preparationSection
            alarmSection
            calendarSection
        }
        .formStyle(.grouped)
    }
}

// MARK: - Subviews
private extension SleepMainPage {

    var enabledSection: some View {
        Section {
            Toggle(isOn: SleepBindings.isOn(state.enabled) { send(.setSwitch(.enabled, isOn: $0)) }) {
                SleepRow(
                    symbol: "moon.stars.fill",
                    tint: Theme.Colors.sleep,
                    title: Text("sleep.plan.title", bundle: .module),
                    subtitle: enabledSubtitle
                )
            }
            .accessibilityIdentifier(SleepIdentifiers.enabled)
        }
    }

    var enabledSubtitle: Text {
        state.enabled ? Text("sleep.plan.on", bundle: .module) : Text("sleep.plan.off", bundle: .module)
    }

    var plansSection: some View {
        Section {
            ForEach(state.plans) { plan in
                Button { send(.open(.plan, planID: plan.id)) } label: { SleepNavigationRow(row: row(for: plan)) }
                    .listRowButton()
                    .accessibilityLabel(Text(String(
                        format: String(localized: "sleep.plans.a11y", bundle: .module),
                        locale: .current,
                        plan.name
                    )))
                    .accessibilityIdentifier(SleepIdentifiers.planPrefix + plan.id)
            }
            if state.canAddPlan {
                Button { send(.addPlan(name: String(localized: "sleep.plans.newName", bundle: .module))) } label: {
                    Label { Text("sleep.plans.add", bundle: .module) } icon: { Image(systemName: "plus.circle.fill") }
                }
                .listRowButton()
                .accessibilityIdentifier(SleepIdentifiers.addPlan)
            }
        } header: {
            Text("sleep.plans.header", bundle: .module)
        } footer: {
            Text("sleep.plans.footer", bundle: .module)
        }
    }

    func row(for plan: SleepPlanItem) -> SleepRow {
        let alarmKey: String.LocalizationValue = plan.alarm ? "sleep.plans.alarmOn" : "sleep.plans.alarmOff"
        let alarm = String(localized: alarmKey, bundle: .module)
        let times = "\(SleepFormat.time(plan.bedMinutes)) – \(SleepFormat.time(plan.wakeMinutes))"
        return SleepRow(
            symbol: "bed.double.fill",
            tint: Theme.Colors.sleep,
            title: Text(verbatim: "\(plan.name) · \(SleepFormat.days(plan.wakeDays))"),
            subtitle: Text(verbatim: "\(times) · \(SleepFormat.duration(plan.durationMinutes)) · \(alarm)")
        )
    }

    var preparationSection: some View {
        Section {
            Toggle(isOn: SleepBindings.isOn(state.prepReminder) { send(.setSwitch(.prepReminder, isOn: $0)) }) {
                SleepRow(
                    symbol: "bell.fill",
                    tint: Theme.Colors.sleep,
                    title: Text("sleep.prep.remind", bundle: .module),
                    subtitle: reminderSubtitle
                )
            }
            .accessibilityIdentifier(SleepIdentifiers.prepReminder)
            Button { send(.open(.remind, planID: nil)) } label: {
                SleepNavigationRow(row: SleepRow(
                    symbol: "clock.fill",
                    tint: .gray,
                    title: Text("sleep.prep.when", bundle: .module),
                    subtitle: Text(SleepFormat.lead(state.prepReminderMinutes))
                ))
            }
            .listRowButton()
            .accessibilityIdentifier(SleepIdentifiers.reminderLead)
            Toggle(isOn: SleepBindings.isOn(state.muteSemp) { send(.setSwitch(.muteSemp, isOn: $0)) }) {
                SleepRow(
                    symbol: "bell.slash.fill",
                    tint: .pink,
                    title: Text("sleep.prep.mute", bundle: .module),
                    subtitle: Text("sleep.prep.mute.sub", bundle: .module)
                )
            }
            .accessibilityIdentifier(SleepIdentifiers.muteSemp)
        } header: {
            Text("sleep.prep.header", bundle: .module)
        } footer: {
            Text("sleep.prep.footer", bundle: .module)
        }
    }

    /// The time the reminder fires for the shown night, or that it is off.
    var reminderSubtitle: Text {
        guard state.prepReminder, let minutes = state.night?.reminderMinutes else {
            return state.prepReminder ? Text("sleep.prep.on", bundle: .module) : Text("sleep.prep.off", bundle: .module)
        }
        return Text(String(
            format: String(localized: "sleep.prep.at", bundle: .module),
            locale: .current,
            SleepFormat.time(minutes)
        ))
    }

    var alarmSection: some View {
        Section {
            Button { send(.open(.sound, planID: nil)) } label: {
                SleepNavigationRow(row: SleepRow(
                    symbol: "speaker.wave.2.fill",
                    tint: .orange,
                    title: Text("sleep.alarm.sound", bundle: .module),
                    subtitle: Text(state.alarmSound.name)
                ))
            }
            .listRowButton()
            .accessibilityIdentifier(SleepIdentifiers.sound)
            Toggle(isOn: SleepBindings.isOn(state.alarmSnooze) { send(.setSwitch(.alarmSnooze, isOn: $0)) }) {
                SleepRow(
                    symbol: "zzz",
                    tint: .gray,
                    title: Text("sleep.alarm.snooze", bundle: .module),
                    subtitle: Text("sleep.alarm.snooze.sub", bundle: .module)
                )
            }
            .accessibilityIdentifier(SleepIdentifiers.snooze)
        } header: {
            Text("sleep.alarm.header", bundle: .module)
        } footer: {
            Text("sleep.alarm.footer", bundle: .module)
        }
    }

    var calendarSection: some View {
        Section {
            Toggle(isOn: SleepBindings.isOn(state.showInCalendar) { send(.setSwitch(.showInCalendar, isOn: $0)) }) {
                SleepRow(
                    symbol: "calendar",
                    tint: .red,
                    title: Text("sleep.calendar.show", bundle: .module),
                    subtitle: Text("sleep.calendar.show.sub", bundle: .module)
                )
            }
            .accessibilityIdentifier(SleepIdentifiers.showInCalendar)
            Button { send(.open(.goal, planID: nil)) } label: {
                SleepNavigationRow(row: SleepRow(
                    symbol: "target",
                    tint: .green,
                    title: Text("sleep.goal.title", bundle: .module),
                    subtitle: Text(SleepFormat.duration(state.goalMinutes))
                ))
            }
            .listRowButton()
            .accessibilityIdentifier(SleepIdentifiers.goal)
        }
    }
}

// MARK: - Preview
#Preview("Overview") {
    SleepMainPage(state: .previewReady, send: { _ in })
}
