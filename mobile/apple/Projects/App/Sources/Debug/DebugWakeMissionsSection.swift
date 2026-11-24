import DesignSystem
import SwiftUI

/// The wake-up missions of this device: when each guards a ring, how many codes end it and how many watch alarms back
/// it up. A mission that is not ringing can be removed; a ringing one is behind the guard.
struct DebugWakeMissionsSection: View {

    // MARK: - Dependencies
    @ObservedObject var wakeGuard: WakeGuard
    let remove: (UUID) -> Void

    // MARK: - Body
    var body: some View {
        Section {
            if wakeGuard.missions.isEmpty {
                Text("debug.wake.missions.empty").foregroundStyle(Theme.Colors.secondaryText)
            }
            ForEach(wakeGuard.missions) { mission in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: mission.title)
                        Text(Self.detail(mission))
                            .font(.footnote)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    Spacer(minLength: Theme.Spacing.small)
                    Button(role: .destructive) { remove(mission.id) } label: { Text("debug.alarm.cancel") }
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier(AppIdentifiers.debugWakeRemovePrefix + mission.id.uuidString)
                }
            }
        } header: {
            Text("debug.wake.missions")
        } footer: {
            Text("debug.wake.missions.footer")
        }
    }
}

// MARK: - Private
private extension DebugWakeMissionsSection {

    static func detail(_ mission: WakeMission) -> String {
        let ring = mission.guardedRing.map { $0.formatted(date: .abbreviated, time: .shortened) }
            ?? String(localized: "debug.wake.missions.unarmed")
        return String(
            format: String(localized: "debug.wake.missions.detail"),
            locale: .current,
            ring,
            mission.codes.count,
            mission.watchIDs.count
        )
    }
}
