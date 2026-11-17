import CoreKit
import DesignSystem
import SwiftUI

/// One night: its ring, whether the alarm rings that night, going back to the plan, and the way to the plan overview.
struct SleepNightPage: View {

    // MARK: - Dependencies
    let state: SleepState
    let send: (SleepAction) -> Void

    // MARK: - Body
    var body: some View {
        Form {
            if let ring = state.ring {
                SleepRingSection(ring: ring, isEnabled: state.enabled, send: send)
            }
            alarmSection
            if state.night?.changed == true {
                Section {
                    Button { send(.resetNight) } label: {
                        Text("sleep.night.reset", bundle: .module).frame(maxWidth: .infinity)
                    }
                    .accessibilityIdentifier(SleepIdentifiers.resetNight)
                }
            }
            Section {
                Button { send(.open(.main, planID: nil)) } label: {
                    SleepNavigationRow(row: SleepRow(
                        symbol: "moon.stars.fill",
                        tint: Theme.Colors.sleep,
                        title: Text("sleep.night.openPlans", bundle: .module)
                    ))
                }
                .listRowButton()
                .accessibilityIdentifier(SleepIdentifiers.openPlans)
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Subviews
private extension SleepNightPage {

    var alarmOn: Bool {
        state.night?.alarm ?? state.ring?.alarm ?? false
    }

    var wakeMinutes: Int {
        state.night?.wakeMinutes ?? state.ring?.wakeMinutes ?? 0
    }

    var alarmSection: some View {
        Section {
            Toggle(isOn: SleepBindings.isOn(alarmOn) { send(.setSwitch(.alarm, isOn: $0)) }) {
                SleepRow(
                    symbol: "bell.fill",
                    tint: .orange,
                    title: Text("sleep.night.alarm", bundle: .module),
                    subtitle: alarmSubtitle
                )
            }
            .accessibilityIdentifier(SleepIdentifiers.alarm)
        } footer: {
            Text(hint)
        }
    }

    var alarmSubtitle: Text {
        guard alarmOn else { return Text("sleep.night.alarm.off", bundle: .module) }
        return Text(String(
            format: String(localized: "sleep.plan.alarm.on", bundle: .module),
            locale: .current,
            SleepFormat.time(wakeMinutes),
            state.alarmSound.name
        ))
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
