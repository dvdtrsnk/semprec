import CoreKit
import DesignSystem
import SwiftUI

/// The overview of the sleep sheet: the plan switch, the full schedule with its further details, the
/// preparation reminder, the alarm settings and what the calendar shows.
struct SleepMainPage: View {

    // MARK: - Dependencies
    let state: SleepState
    let send: (SleepAction) -> Void
    let openWakeSettings: () -> Void

    // MARK: - Body
    var body: some View {
        Form {
            enabledSection
            SleepScheduleSections(state: state, send: send)
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
            Button { send(.open(.sound)) } label: {
                SleepNavigationRow(row: SleepRow(
                    symbol: "speaker.wave.2.fill",
                    tint: .orange,
                    title: Text("sleep.alarm.sound", bundle: .module),
                    subtitle: Text(state.alarmSound.name)
                ))
            }
            .listRowButton()
            .accessibilityIdentifier(SleepIdentifiers.sound)
            Button(action: openWakeSettings) {
                SleepNavigationRow(row: SleepRow(
                    symbol: "qrcode.viewfinder",
                    tint: .indigo,
                    title: Text("sleep.wake.row.title", bundle: .module),
                    subtitle: Text("sleep.wake.row.sub", bundle: .module)
                ))
            }
            .listRowButton()
            .accessibilityIdentifier(SleepIdentifiers.wakeSettings)
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
        }
    }
}

// MARK: - Preview
#Preview("Overview") {
    SleepMainPage(state: .previewReady, send: { _ in }, openWakeSettings: {})
}
