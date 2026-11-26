import DesignSystem
import SwiftUI

/// How the sleep plan's alarms wake the person on this device: whether only a scanned code stops them, and the codes.
/// Each change is kept at once and the alarms follow it. With a code, an alarm rings until the code is scanned, even
/// after the system's Stop and inside the app; after ten minutes, tapping 200 times stops it instead.
struct SleepWakeScreen: View {

    // MARK: - Dependencies
    @ObservedObject var clock: SleepAlarmClock

    // MARK: - State
    @State private var scanning = false
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Body
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle(isOn: requiresCode) { Text("sleepWake.requiresCode") }
                        .accessibilityIdentifier(AppIdentifiers.sleepWakeToggle)
                } footer: {
                    Text(Self.footer(clock.settings))
                }
                if clock.settings.requiresCode {
                    WakeCodesSection(codes: codes) { scanning = true }
                }
                if let failure = clock.failure {
                    Section {
                        Text(verbatim: failure)
                            .font(.footnote)
                            .foregroundStyle(Theme.Colors.destructive)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(Text("sleepWake.title"))
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { dismiss() } label: { Text("sleepWake.done") }
                        .accessibilityIdentifier(AppIdentifiers.sleepWakeDone)
                }
            }
            .sheet(isPresented: $scanning) {
                CodeCaptureSheet { code in
                    change { $0.codes = WakeCodes.normalized($0.codes + [code]) }
                    scanning = false
                }
            }
        }
        .accessibilityIdentifier(AppIdentifiers.sleepWakeScreen)
    }
}

// MARK: - Texts
extension SleepWakeScreen {

    /// What the switch does with `settings`: off, on with codes, or on without one yet, which rings like a plain
    /// alarm.
    static func footer(_ settings: SleepWakeSettings) -> String {
        guard settings.requiresCode else { return String(localized: "sleepWake.off") }
        return settings.activeCodes.isEmpty
            ? String(localized: "sleepWake.noCode")
            : String(localized: "sleepWake.on")
    }
}

// MARK: - Subviews
private extension SleepWakeScreen {

    var requiresCode: Binding<Bool> {
        Binding(get: { clock.settings.requiresCode }, set: { value in change { $0.requiresCode = value } })
    }

    var codes: Binding<[String]> {
        Binding(get: { clock.settings.codes }, set: { value in change { $0.codes = value } })
    }

    func change(_ edit: (inout SleepWakeSettings) -> Void) {
        var settings = clock.settings
        edit(&settings)
        clock.update(settings)
    }
}
