import Foundation
@preconcurrency internal import SharedSDK

/// The shared layer's `WakeStorage` in the user defaults: the wake settings and the wake missions of this device, as
/// JSON under two keys. They belong to this device only, like the alarms it rings, and hold no secret: a code names a
/// thing in the person's home. A value that cannot be read counts as nothing stored, so the next sync starts from the
/// alarms the device holds. Every call comes on the main thread.
@MainActor
final class DefaultsWakeStorage: NSObject {

    // MARK: - Properties
    private let defaults: UserDefaults
    private let settingsKey: String
    private let missionsKey: String

    // MARK: - Init
    init(
        defaults: UserDefaults = .standard,
        settingsKey: String = "cz.alldots.wakeSettings",
        missionsKey: String = "cz.alldots.wakeMissions"
    ) {
        self.defaults = defaults
        self.settingsKey = settingsKey
        self.missionsKey = missionsKey
    }
}

// MARK: - Stored values
extension DefaultsWakeStorage {

    struct StoredSettings: Codable, Equatable {
        var requiresCode: Bool
        var codes: [String]
    }

    struct StoredMission: Codable, Equatable {
        var key: String
        var ringAtEpochSeconds: Int64
        var alarmId: String
        var codes: [String]
        var watchIds: [String]
        var armed: Bool
    }
}

// MARK: - Protocol conformance
extension DefaultsWakeStorage: @preconcurrency SharedSDK.WakeStorage {

    func loadSettings() -> SharedSDK.WakeSettings {
        guard
            let data = defaults.data(forKey: settingsKey),
            let stored = try? JSONDecoder().decode(StoredSettings.self, from: data)
        else { return SharedSDK.WakeSettings(requiresCode: false, codes: []) }
        return SharedSDK.WakeSettings(requiresCode: stored.requiresCode, codes: stored.codes)
    }

    func saveSettings(settings: SharedSDK.WakeSettings) {
        let stored = StoredSettings(requiresCode: settings.requiresCode, codes: settings.codes)
        defaults.set(try? JSONEncoder().encode(stored), forKey: settingsKey)
    }

    func loadMissions() -> [SharedSDK.WakeMission] {
        guard
            let data = defaults.data(forKey: missionsKey),
            let stored = try? JSONDecoder().decode([StoredMission].self, from: data)
        else { return [] }
        return stored.map {
            SharedSDK.WakeMission(
                key: $0.key,
                ringAtEpochSeconds: $0.ringAtEpochSeconds,
                alarmId: $0.alarmId,
                codes: $0.codes,
                watchIds: $0.watchIds,
                armed: $0.armed
            )
        }
    }

    func saveMissions(missions: [SharedSDK.WakeMission]) {
        let stored = missions.map {
            StoredMission(
                key: $0.key,
                ringAtEpochSeconds: $0.ringAtEpochSeconds,
                alarmId: $0.alarmId,
                codes: $0.codes,
                watchIds: $0.watchIds,
                armed: $0.armed
            )
        }
        defaults.set(try? JSONEncoder().encode(stored), forKey: missionsKey)
    }
}
